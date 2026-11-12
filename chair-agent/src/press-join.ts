// "Join the Committee": a visitor's click moves the share of coins that is staked, and the Chair's next minutes say so. The press desk has a pool
// account that holds test coins and this project controls; a click stakes one step of them, or (at the cap) takes one step back out. The page then
// waits for the Chair's next decision and quotes the minutes. Nothing here decides what the Chair does: the mandate does (rule-chair.ts `mandateRate`).
//
// Why a visitor can never impeach the Chair with this: the only calls the pool's signer can build are `stake` and `unstake` (signer.ts `PoolSigner`), so
// the pool backs no challenger, ever, and `plan` here also refuses to sign when the chain says the pool backs one. Impeachment needs a challenger with
// more than the threshold share of the staked coins (30% at launch) and more than 5% of the whole supply (SPEC "Voting"); the pool's stake is capped at
// `capSteps` steps of `stepBps` (2% each, 4% at most), so even a pool that backed a challenger could never reach the 5%.
//
// The pool is capped against the chain, not against this process's memory: every click reads the pool's stake at the newest block and signs only if
// the call keeps it within the cap. Direction is read off the chain too, from the stake alone: join while there is room for another step, step out
// once the pool is at its cap. A step is a share of a supply that changes every meeting (printing and burning), so a stake of whole steps stops being one
// while it does not change; the pool counts as at its cap within a `SLACK_DIVISOR`th of a step of it, and a join that has less than a whole step of room
// stakes just that room, so the cap itself stays exact.
// The contract locks a stake for two epochs (staking.rs STAKE_LOCK_EPOCHS), so a step down right after the last join cannot go through: the desk says
// when it can, and sends nothing, rather than paying gas for a refusal.
//
// Idle reset: the pool is shared by every visitor and holds two steps at most, so a full pool would greet each new visitor with "step back out".
// When the pool has coins staked and nobody has pressed for `idleResetMs`, the desk takes everything back out in one call (`watch`, every
// `watchEveryMs`, whatever fraction of a step that is), so the next visitor finds an empty pool and a button that says Join. Like a click, it reads the stake from the chain,
// never from memory (a restart loses nothing), and it never moves the pool in the same meeting a visitor's press is counted in: that meeting's minutes
// must see only the visitor's step.
import type { PoolReader } from "./chain.js";
import type { Reply } from "./press-overreach.js";
import { SerialQueue, SlidingWindow } from "./press-window.js";
import { stakedShareBps } from "./rule-chair.js";
import type { PoolSender, SubmitResult } from "./signer.js";
import type { PoolView } from "./types.js";

export const DEFAULT_JOIN_LIMITS = {
  /** One click moves this much of the total supply (floored): 200 bps is 2%. */
  stepBps: 200,
  /** The pool holds at most this many steps staked. */
  capSteps: 2,
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
  /** No press for this long with coins staked: the desk takes the pool's whole stake back out. The unit sets it with CHAIR_JOIN_IDLE_RESET_S (cli.ts). */
  idleResetMs: 600_000,
  /** How often the desk reads the pool to learn what the next click does, and whether it is idle. */
  watchEveryMs: 30_000,
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
  | { readonly kind: "go"; readonly direction: JoinDirection; readonly amount: bigint }
  | { readonly kind: "locked"; readonly unlockAtMs: number }
  | { readonly kind: "dry" };

/** The pool counts as at its cap when less than this fraction (1/4) of a step of room is left: the step moves with the supply, the stake does not. */
const SLACK_DIVISOR = 4n;

/** Whether the next click takes a step out: never from an empty pool; otherwise when the room under the cap is less than a quarter of a step (or the pool is over it). */
const atCap = (staked: bigint, step: bigint, cap: bigint): boolean => staked !== 0n && (cap - staked) * SLACK_DIVISOR < step;

/** The step and the cap in coins, from the chain's figures. Throws when they cannot be trusted: no staking views, a zero step, or a pool that backs a candidate. */
function figures(view: PoolView, limits: Pick<JoinLimits, "stepBps" | "capSteps">): { step: bigint; cap: bigint } {
  if (view.snapshot.staking === null) throw new Error("the token has no staking views");
  if (view.backing !== null) throw new Error("the pool backs a candidate; the desk will not touch it");
  const step = (view.snapshot.totalSupply * BigInt(limits.stepBps)) / 10_000n;
  if (step === 0n) throw new Error("a step of the supply is zero coins");
  return { step, cap: step * BigInt(limits.capSteps) };
}

/** Takes `amount` out, unless the contract still holds the stake in: then when it lets go. */
function out(view: PoolView, amount: bigint): Move {
  const { policy, params } = view.snapshot;
  if (policy.epoch < view.unlockEpoch) return { kind: "locked", unlockAtMs: policy.epochEndsMs + (view.unlockEpoch - policy.epoch - 1) * params.epochMs };
  return { kind: "go", direction: "step_down", amount };
}

/**
 * What the pool does for the next click, from the chain alone. Pure: it reads nothing and signs nothing.
 * A stake is never more than the room left under the cap (a whole step, or less when the stake is not a whole number of steps), so the cap holds by construction;
 * a pool at or above it (the supply shrank) steps down. Throws as `figures` does.
 */
export function plan(view: PoolView, limits: Pick<JoinLimits, "stepBps" | "capSteps">): Move {
  const { step, cap } = figures(view, limits);
  if (atCap(view.staked, step, cap)) return out(view, view.staked < step ? view.staked : step);
  const room = cap - view.staked;
  const amount = room < step ? room : step;
  return view.liquid < amount ? { kind: "dry" } : { kind: "go", direction: "join", amount };
}

/** The idle reset: everything the pool has staked, whatever fraction of a step that is, in one call. Throws as `figures` does. */
export function planReset(view: PoolView, limits: Pick<JoinLimits, "stepBps" | "capSteps">): Move {
  figures(view, limits);
  return out(view, view.staked);
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

/** After a reset the contract refused or that did not finish, the meetings to leave alone before the next try. */
const RESET_BACKOFF_MEETINGS = 5;

export class Join {
  private readonly limits: JoinLimits;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly perIpRequests: SlidingWindow;
  private readonly perIpSends: SlidingWindow;
  private readonly hourly: SlidingWindow;
  private readonly daily: SlidingWindow;
  private readonly queue: SerialQueue;
  private last: JoinRecord | null = null;
  /** The pool's stake and one step as the chain last showed them: what `state` reports, so a restart does not make a full pool say "join". Null until the first read. */
  private seen: { readonly staked: bigint; readonly step: bigint } | null = null;
  private lastPressAt: number;
  /** The newest meeting that must stay clear of an idle move: the one counting a visitor's press, and the one a reset itself landed in. */
  private quietThrough = -1;
  private watching = false;

  constructor(private readonly deps: JoinDeps) {
    this.limits = { ...DEFAULT_JOIN_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.perIpRequests = new SlidingWindow(this.limits.perIpRequests, this.limits.perIpRequestsWindowMs);
    this.perIpSends = new SlidingWindow(this.limits.perIpSends, this.limits.perIpSendsWindowMs);
    this.hourly = new SlidingWindow(this.limits.hourlyCap, this.limits.hourlyWindowMs);
    this.daily = new SlidingWindow(this.limits.dailyCap, this.limits.dailyWindowMs);
    this.queue = new SerialQueue(this.limits.queueMax);
    this.lastPressAt = this.now();
  }

  /** Remembers what the chain just showed of the pool. */
  private note(v: PoolView): void {
    const step = (v.snapshot.totalSupply * BigInt(this.limits.stepBps)) / 10_000n;
    this.seen = step === 0n ? null : { staked: v.staked, step };
  }

  private nextDirection(): JoinDirection {
    const s = this.seen;
    return s !== null && atCap(s.staked, s.step, s.step * BigInt(this.limits.capSteps)) ? "step_down" : "join";
  }

  /**
   * What the next click would do and the latest move that went through: memory only (the pool as the chain last showed it), no chain read, so a page can ask as often as it likes.
   * `pool_steps` is whole steps, so it reads 0 for a pool holding less than one; `pool_empty` says whether anything at all is staked. Both are null before the first read.
   */
  state(): Reply {
    const steps = this.seen === null ? null : Number(this.seen.staked / this.seen.step);
    const empty = this.seen === null ? null : this.seen.staked === 0n;
    return { status: 200, body: { next: this.nextDirection(), pool_steps: steps, pool_empty: empty, last: this.last, pool: this.deps.poolAccount, step_bps: this.limits.stepBps, cap_steps: this.limits.capSteps, now_ms: this.now() } };
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
    this.lastPressAt = t;
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
      this.note(before);
      step = plan(before, this.limits);
    } catch (err) {
      log(`not sent (${err instanceof Error ? err.message : "unreadable"})`);
      return { status: 503, body: { error: "the desk cannot read the chain just now", code: "desk_closed" } };
    }
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
      this.quietThrough = Math.max(this.quietThrough, record.meeting_epoch);
      this.note(after);
      log(joinedAt(record));
      return { status: 200, body: { status: step.direction === "join" ? "joined" : "stepped_down", ...record, pool: this.deps.poolAccount, now_ms: this.now() } };
    } catch (err) {
      log(`${broadcast ? "unconfirmed" : "not sent"} (${err instanceof Error ? err.name : "error"})`);
      if (!broadcast) return { status: 503, body: { error: "the desk cannot read the chain just now", code: "desk_closed" } };
      return this.notNow(200, { status: "unconfirmed", line: UNCONFIRMED, ...(res === null ? {} : { tx_hash: res.txHash }) });
    }
  }

  /** Starts reading the pool every `watchEveryMs`; returns the call that stops it. The timer never keeps the process alive. */
  watch(): () => void {
    const timer = setInterval(() => void this.idleTick(), this.limits.watchEveryMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** One look at the pool: keeps `state` true, and when the desk has been idle long enough takes everything staked back out. Never throws; a failed read is only a missed look. */
  async idleTick(): Promise<void> {
    if (this.watching) return;
    this.watching = true;
    try {
      try {
        this.note(await this.deps.reader.pool());
      } catch {
        return;
      }
      if (this.seen === null || this.seen.staked === 0n || this.now() - this.lastPressAt < this.limits.idleResetMs || !this.queue.hasRoom) return;
      await this.queue.run(() => this.idleReset());
    } catch (err) {
      this.deps.log?.(`join idle-reset did not finish (${err instanceof Error ? err.name : "error"})`);
    } finally {
      this.watching = false;
    }
  }

  /**
   * The reset itself, in turn with the clicks: it reads the chain again and stands down if a visitor pressed meanwhile, if the pool is empty or locked, if the meeting is not clear of a press,
   * or if the desk's hourly or daily totals are used up. Its send counts against those totals like a click's, and a reset that is refused or does not finish is not tried again for
   * `RESET_BACKOFF_MEETINGS` meetings, so a refusal that persists costs a few sends an hour, never one every look.
   */
  private async idleReset(): Promise<void> {
    if (this.now() - this.lastPressAt < this.limits.idleResetMs) return;
    const view = await this.deps.reader.pool();
    this.note(view);
    const epoch = view.snapshot.policy.epoch;
    if (view.staked === 0n || epoch <= this.quietThrough) return;
    const move = planReset(view, this.limits);
    if (move.kind !== "go" || move.direction !== "step_down") return;
    if (Math.max(this.hourly.waitMs("all", this.now()), this.daily.waitMs("all", this.now())) > 0) return;
    this.quietThrough = epoch + RESET_BACKOFF_MEETINGS;
    const res = await this.deps.sender.unstake(move.amount, () => {
      const t = this.now();
      this.hourly.hit("all", t);
      this.daily.hit("all", t);
    });
    if (res.failure !== null) {
      this.deps.log?.(`join idle-reset refused by the contract: tx ${res.txHash}`);
      return;
    }
    this.quietThrough = epoch;
    this.deps.log?.(`join idle-reset tx ${res.txHash}`);
    await this.settled(0n).then((v) => this.note(v), () => undefined); // a miss is made good by the next look
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
