// The loop. It wakes when the contract's epoch changes (never on a fixed timer: the timer only decides when to look
// again), plans the epoch, sends each action, and logs every one with its transaction hash. A failed call is logged and
// the next one goes ahead; a failed read backs off and tries again. It stops, with a message, when a holder's NEAR
// balance is under the floor, when the requested number of epochs is done, or on a signal.

import { NEAR_FLOOR, projectBudget } from "./budget.ts";
import type { Chain, Receipt } from "./chain.ts";
import type { Clock } from "./clock.ts";
import { near, tokens, type Log } from "./log.ts";
import { planEpoch, type HolderAction } from "./plan.ts";

/** Holders' NEAR is read at start and then this often. */
const GAS_CHECK_MS = 3_600_000;
/** The view runs on the latest final block, a few seconds behind the wall clock: look again this long after the boundary. */
const SETTLE_MS = 2_000;
/** Never sleep longer than this without looking, so a clock that disagrees with the chain's costs at most this much. */
const MAX_WAIT_MS = 30_000;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;

export type Stop = "done" | "floor" | "signal";

export interface Options {
  readonly seed: string;
  /** Acts in the epochs that are a multiple of this (1: every epoch). */
  readonly every: number;
  /** The start record: what the bot was told, as fields and as a line; the bot adds the schedule and the budget. */
  readonly start: { readonly fields: Record<string, unknown>; readonly text: string };
  /** Stop after acting in this many epochs; null runs until stopped. */
  readonly maxEpochs: number | null;
}

function describe(action: HolderAction): string {
  switch (action.kind) {
    case "transfer":
      return `${action.from} sends ${tokens(action.amount)} $CHAIR to ${action.to}`;
    case "stake":
      return `${action.account} stakes ${tokens(action.amount)} $CHAIR`;
    case "unstake":
      return `${action.account} unstakes ${tokens(action.amount)} $CHAIR`;
    case "claim":
      return `${action.account} claims its staking reward`;
  }
}

const listNear = (balances: ReadonlyMap<string, bigint>): string => [...balances].map(([id, v]) => `${id} ${near(v)}`).join(", ");

const message = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 300);

export async function runBot(chain: Chain, clock: Clock, log: Log, options: Options, signal: AbortSignal): Promise<Stop> {
  let lastEpoch: number | null = null;
  let acted = 0;
  let nextGasCheck = clock.now();
  let started = false;

  /** True when every holder has gas for another stretch; otherwise says which one is short and why the bot stops. */
  async function gasIsEnough(): Promise<boolean> {
    const balances = await chain.nearBalances();
    if (!started) await announce(balances);
    else log.write({ event: "near_balances", balances: Object.fromEntries(balances) }, `NEAR balances: ${listNear(balances)}`);
    nextGasCheck = clock.now() + GAS_CHECK_MS;
    const short = [...balances].find(([, v]) => v < NEAR_FLOOR);
    if (short === undefined) return true;
    log.write(
      { event: "floor", account: short[0], balance: short[1], floor: NEAR_FLOOR },
      `stopping: ${short[0]} holds ${near(short[1])} NEAR, below the floor of ${near(NEAR_FLOOR)} NEAR. Fund it (no faucet is called here) and start again`,
    );
    return false;
  }

  /** The start line: the schedule, what it should cost and how long the balances read now last at that cost. */
  async function announce(balances: ReadonlyMap<string, bigint>): Promise<void> {
    const epochMs = await chain.epochMs();
    const budget = projectBudget(balances, options.every, epochMs);
    const perDay = budget.perHolderPerDay * balances.size;
    started = true;
    log.write(
      {
        ...options.start.fields,
        event: "start",
        everyEpochs: options.every,
        epochMs,
        nearPerDay: perDay,
        daysToFloor: Object.fromEntries(budget.daysToFloor),
        firstToFloor: budget.first.account,
        balances: Object.fromEntries(balances),
      },
      `starting on ${options.start.text}: acting every ${options.every === 1 ? "epoch" : `${options.every}th epoch`}, about ${perDay.toFixed(3)} NEAR a day for ${balances.size} holders (an estimate from measured gas); ` +
        `NEAR balances ${listNear(balances)}; at that rate ${budget.first.account} reaches the ${near(NEAR_FLOOR)} NEAR floor first, in about ${budget.first.days.toFixed(1)} days`,
    );
  }

  async function actInEpoch(epoch: number, plan: readonly HolderAction[]): Promise<void> {
    for (const action of plan) {
      if (signal.aborted) return;
      const what = { event: "action", epoch, ...action };
      let receipt: Receipt;
      try {
        receipt = await chain.send(action);
      } catch (e) {
        log.write({ ...what, outcome: "error", error: message(e), hash: null }, `epoch ${epoch}: ${describe(action)}: not sent or outcome unknown (${message(e)}); going on`);
        continue;
      }
      const outcome = receipt.failure === null ? "success" : "refused";
      log.write({ ...what, outcome, failure: receipt.failure, hash: receipt.hash }, `epoch ${epoch}: ${describe(action)}: ${outcome}${receipt.failure === null ? "" : ` (${receipt.failure})`}, tx ${receipt.hash}`);
    }
  }

  /** One pass: the stop reason when the bot is done, null when it should look again. */
  async function tick(): Promise<Stop | null> {
    if (clock.now() >= nextGasCheck && !(await gasIsEnough())) return "floor";
    const info = await chain.epoch();
    if (info.epoch === lastEpoch || info.epoch % options.every !== 0) {
      await clock.sleep(Math.min(Math.max(info.epochEndsMs - clock.now(), 0), MAX_WAIT_MS) + SETTLE_MS, signal);
      return null;
    }
    const world = await chain.world();
    // The epoch may have turned between the two reads, onto one this bot does not act in.
    if (world.epoch % options.every !== 0) return null;
    const plan = planEpoch(options.seed, world);
    const missed = lastEpoch === null ? 0 : Math.floor((world.epoch - 1) / options.every) - lastEpoch / options.every;
    // Marked before the first send: whatever happens below, this epoch is not planned twice.
    lastEpoch = world.epoch;
    const shareBps = world.totalSupply > 0n ? Number((world.totalStaked * 10_000n) / world.totalSupply) : 0;
    log.write(
      { event: "epoch", epoch: world.epoch, rateBps: world.rateBps, stakedShareBps: shareBps, planned: plan.length, missedActingEpochs: missed },
      `epoch ${world.epoch}: rate ${world.rateBps} bps, ${(shareBps / 100).toFixed(1)}% of the supply staked, ${plan.length} actions planned${missed > 0 ? `, ${missed} acting epochs missed since the last` : ""}`,
    );
    await actInEpoch(world.epoch, plan);
    acted++;
    return options.maxEpochs !== null && acted >= options.maxEpochs ? "done" : null;
  }

  async function loop(): Promise<Stop> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const stop = await tick();
        failures = 0;
        if (stop !== null) return stop;
      } catch (e) {
        const wait = Math.min(BACKOFF_FIRST_MS * 2 ** failures, BACKOFF_MAX_MS);
        failures++;
        log.write({ event: "read_error", error: message(e), retryInMs: wait }, `chain read failed (${message(e)}); trying again in ${wait / 1000} s`);
        await clock.sleep(wait, signal);
      }
    }
    return "signal";
  }

  const stop = await loop();
  log.write({ event: "stopped", reason: stop, epochsActed: acted }, `stopped (${stop}) after acting in ${acted} epochs`);
  return stop;
}
