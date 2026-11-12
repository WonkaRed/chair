// "Join the Committee": a visitor's click moves the share of coins that is staked, and the Chair's next minutes say so. The press desk has a pool
// account that holds test coins and this project controls; a click stakes one step of them, or (at the cap) takes one step back out. The page then
// waits for the Chair's next decision and quotes the minutes. Nothing here decides what the Chair does: the mandate does (rule-chair.ts `mandateRate`).
//
// Why a visitor can never impeach the Chair with this: the only calls the pool's signer can build are `stake` and `unstake` (signer.ts `PoolSigner`), so
// the pool backs no challenger, ever, and `plan` here also refuses to sign when the chain says the pool backs one. Impeachment needs a challenger with
// more than the threshold share of the staked coins (30% at launch) and more than 5% of the whole supply (SPEC "Voting"); the pool's stake is capped at
// `capSteps` steps of 1% of the supply, so even a pool that backed a challenger could never reach the 5%.
//
// The pool is capped against the chain, not against this process's memory: every click reads the pool's stake at the newest block and signs only if
// the call keeps it within the cap. Direction is read off the chain too: join while there is room for another step, step down once there is not,
// until the pool is empty (the one thing kept in memory is that the pool is on its way down, and a restart only costs that: it starts up again, still capped).
// The contract locks a stake for two epochs (staking.rs STAKE_LOCK_EPOCHS), so a step down right after the last join cannot go through: the desk says
// when it can, and sends nothing, rather than paying gas for a refusal.
import type { PoolReader } from "./chain.js";
import type { Reply } from "./press-overreach.js";
import { SerialQueue, SlidingWindow } from "./press-window.js";
import { stakedShareBps } from "./rule-chair.js";
import type { PoolSender, SubmitResult } from "./signer.js";
import type { PoolView } from "./types.js";

export const DEFAULT_JOIN_LIMITS = {
  /** One click moves this much of the total supply (floored): 100 bps is 1%. */
  stepBps: 100,
  /** The pool holds at most this many steps staked. */
  capSteps: 4,
  /** Everything a visitor asks of this endpoint (each ask reads the chain), per address. */
  perIpRequests: 8,
  perIpRequestsWindowMs: 10 * 60_000,
  /** Moves that go on chain, per address, then the hour's and the day's totals over all addresses. Each costs the pool account gas: see "Join the Committee" in the README. */
  perIpSends: 3,
  perIpSendsWindowMs: 60 * 60_000,
  hourlyCap: 20,
  hourlyWindowMs: 60 * 60_000,
  dailyCap: 200,
  dailyWindowMs: 24 * 60 * 60_000,
  /** Clicks that may wait for the one on chain. */
  queueMax: 2,
  /** After a move, how often and how long the pool is read again for the stake to show in the newest block. */
  confirmTries: 4,
  confirmEveryMs: 1_000,
} as const;
export type JoinLimits = { -readonly [K in keyof typeof DEFAULT_JOIN_LIMITS]: number };

export type JoinDirection = "join" | "step_down";

/** One move that went through, as the page shows it. Shares are read from the chain before and after, in bps of the total supply. */
export interface JoinRecord {
  readonly direction: JoinDirection;
  readonly tx_hash: string;
  readonly share_before_bps: number;
  readonly share_after_bps: number;
  /** The meeting the move landed in, and the next one: the first whose decision is certain to have seen it. */
  readonly epoch: number;
  readonly meeting_epoch: number;
  /** When that meeting opens, by the chain's clock. */
  readonly meeting_at_ms: number;
  readonly at_ms: number;
}

export type Move =
  | { readonly kind: "go"; readonly direction: JoinDirection; readonly amount: bigint; readonly descending: boolean }
  | { readonly kind: "locked"; readonly unlockAtMs: number; readonly descending: boolean }
  | { readonly kind: "dry"; readonly descending: boolean };

/**
 * What the pool does for the next click, from the chain alone (plus whether it is already on its way down). Pure: it reads nothing and signs nothing.
 * A stake is planned only when `staked + step` stays within the cap, so the cap holds by construction; a pool above it (the supply shrank) steps down.
 * Throws when the figures cannot be trusted: no staking views, a zero step, or a pool that backs a candidate.
 */
export function plan(view: PoolView, descending: boolean, limits: Pick<JoinLimits, "stepBps" | "capSteps">): Move {
  const { snapshot, staked } = view;
  if (snapshot.staking === null) throw new Error("the token has no staking views");
  if (view.backing !== null) throw new Error("the pool backs a candidate; the desk will not touch it");
  const step = (snapshot.totalSupply * BigInt(limits.stepBps)) / 10_000n;
  if (step === 0n) throw new Error("a step of the supply is zero coins");
  const cap = step * BigInt(limits.capSteps);

  const down = staked === 0n ? false : descending || staked + step > cap;
  if (!down) return view.liquid < step ? { kind: "dry", descending: false } : { kind: "go", direction: "join", amount: step, descending: false };
  const { policy, params } = snapshot;
  if (policy.epoch < view.unlockEpoch) return { kind: "locked", unlockAtMs: policy.epochEndsMs + (view.unlockEpoch - policy.epoch - 1) * params.epochMs, descending: true };
  return { kind: "go", direction: "step_down", amount: staked < step ? staked : step, descending: true };
}

export interface JoinDeps {
  readonly reader: PoolReader;
  readonly sender: PoolSender;
  /** The pool account, as the page and the log name it. */
  readonly poolAccount: string;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly limits?: Partial<JoinLimits>;
  /** One line per click that reaches the chain: direction, shares, transaction. Never an address. */
  readonly log?: (line: string) => void;
}

const LOCKED = "The Committee's coins were put in a moment ago and the contract keeps them in for two meetings. The next visitor can step them down after that.";
const DRY = "The pool has no coins left to put in. Nothing was sent.";
const UNCONFIRMED = "The call was sent, but the desk could not confirm the new share. The transaction may still show on chain.";
const FAILED = "The contract refused the call. Nothing about the stake changed.";

/** The pool's staked share in bps of the total supply, from the same block as the rest of the view. */
function shareOf(v: PoolView): number {
  if (v.snapshot.staking === null) throw new Error("the token has no staking views");
  return stakedShareBps(v.snapshot.staking.totalStaked, v.snapshot.totalSupply);
}

const joinedAt = (r: JoinRecord): string => `${r.direction} tx ${r.tx_hash} share ${r.share_before_bps} -> ${r.share_after_bps} bps`;

export class Join {
  private readonly limits: JoinLimits;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly perIpRequests: SlidingWindow;
  private readonly perIpSends: SlidingWindow;
  private readonly hourly: SlidingWindow;
  private readonly daily: SlidingWindow;
  private readonly queue: SerialQueue;
  private descending = false;
  private last: JoinRecord | null = null;

  constructor(private readonly deps: JoinDeps) {
    this.limits = { ...DEFAULT_JOIN_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.perIpRequests = new SlidingWindow(this.limits.perIpRequests, this.limits.perIpRequestsWindowMs);
    this.perIpSends = new SlidingWindow(this.limits.perIpSends, this.limits.perIpSendsWindowMs);
    this.hourly = new SlidingWindow(this.limits.hourlyCap, this.limits.hourlyWindowMs);
    this.daily = new SlidingWindow(this.limits.dailyCap, this.limits.dailyWindowMs);
    this.queue = new SerialQueue(this.limits.queueMax);
  }

  /** What the next click would do and the latest move that went through: memory only, no chain read, so a page can ask as often as it likes. */
  state(): Reply {
    return { status: 200, body: { next: this.descending ? "step_down" : "join", last: this.last, pool: this.deps.poolAccount, now_ms: this.now() } };
  }

  /** A click that did not go through, with the latest real move beside it so the visitor still has something true to look at. */
  private notNow(status: number, body: Record<string, unknown>): Reply {
    return { status, body: { ...body, last: this.last } };
  }

  private busy(retryMs: number, error: string, code: string): Reply {
    const s = Math.max(1, Math.ceil(retryMs / 1000));
    return { status: 429, body: { error, code, retry_after_s: s, last: this.last }, headers: { "retry-after": s } };
  }

  /** How long until this address and the desk's totals allow another move; 0 when they do now. */
  private sendWaitMs(who: string, t: number): number {
    return Math.max(this.perIpSends.waitMs(who, t), this.hourly.waitMs("all", t), this.daily.waitMs("all", t));
  }

  /** One click: checks the limits, waits its turn, then reads the pool and moves it one step. */
  async start(who: string): Promise<Reply> {
    const t = this.now();
    const asked = this.perIpRequests.waitMs(who, t);
    if (asked > 0) return this.busy(asked, "too many tries from this address; the Committee has other business", "per_address");
    this.perIpRequests.hit(who, t);
    const sent = this.sendWaitMs(who, t);
    if (sent > 0) return this.busy(sent, "the Committee has had enough joiners for now; the desk allows only so many", "cap");
    if (!this.queue.hasRoom) return this.busy(10_000, "another visitor is joining; try again in a few seconds", "composing");
    return this.queue.run(() => this.move(who));
  }

  private async move(who: string): Promise<Reply> {
    const sent = this.sendWaitMs(who, this.now());
    if (sent > 0) return this.busy(sent, "the Committee has had enough joiners for now; the desk allows only so many", "cap");
    const log = (line: string): void => this.deps.log?.(`join ${line}`);
    let before: PoolView;
    let step: Move;
    try {
      before = await this.deps.reader.pool();
      step = plan(before, this.descending, this.limits);
    } catch (err) {
      log(`not sent (${err instanceof Error ? err.message : "unreadable"})`);
      return { status: 503, body: { error: "the desk cannot read the chain just now", code: "desk_closed" } };
    }
    this.descending = step.descending;
    if (step.kind === "locked") return this.notNow(200, { status: "locked", line: LOCKED, retry_at_ms: step.unlockAtMs, now_ms: this.now() });
    if (step.kind === "dry") return this.notNow(200, { status: "dry", line: DRY });

    let broadcast = false;
    const onBroadcast = (): void => {
      broadcast = true;
      const t = this.now();
      this.perIpSends.hit(who, t);
      this.hourly.hit("all", t);
      this.daily.hit("all", t);
    };
    let res: SubmitResult | null = null;
    try {
      res = await (step.direction === "join" ? this.deps.sender.stake(step.amount, onBroadcast) : this.deps.sender.unstake(step.amount, onBroadcast));
      if (res.failure !== null) {
        log(`${step.direction} refused by the contract: tx ${res.txHash}`);
        return this.notNow(200, { status: "failed", line: FAILED, failure: res.failure, tx_hash: res.txHash });
      }
      const expected = step.direction === "join" ? before.staked + step.amount : before.staked - step.amount;
      const after = await this.settled(expected);
      const { policy } = after.snapshot;
      const record: JoinRecord = {
        direction: step.direction,
        tx_hash: res.txHash,
        share_before_bps: shareOf(before),
        share_after_bps: shareOf(after),
        epoch: policy.epoch,
        meeting_epoch: policy.epoch + 1,
        meeting_at_ms: policy.epochEndsMs,
        at_ms: this.now(),
      };
      this.last = record;
      this.descending = plan(after, step.descending, this.limits).descending;
      log(joinedAt(record));
      return { status: 200, body: { status: step.direction === "join" ? "joined" : "stepped_down", ...record, pool: this.deps.poolAccount, now_ms: this.now() } };
    } catch (err) {
      log(`${broadcast ? "unconfirmed" : "not sent"} (${err instanceof Error ? err.name : "error"})`);
      if (!broadcast) return { status: 503, body: { error: "the desk cannot read the chain just now", code: "desk_closed" } };
      return this.notNow(200, { status: "unconfirmed", line: UNCONFIRMED, ...(res === null ? {} : { tx_hash: res.txHash }) });
    }
  }

  /** The pool at the newest block once its stake is `expected`: the move shows in it at once, or within a block or two. Throws when it never does. */
  private async settled(expected: bigint): Promise<PoolView> {
    for (let i = 1; ; i++) {
      const view = await this.deps.reader.pool();
      if (view.staked === expected) return view;
      if (i >= this.limits.confirmTries) throw new Error("the new stake did not show on chain");
      await this.sleep(this.limits.confirmEveryMs);
    }
  }
}
