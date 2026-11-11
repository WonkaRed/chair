// "Make the Chair overreach": a visitor names a rate the contract must refuse, the real chair account sends it, the contract answers.
// Nothing here decides anything the contract does not: `judge` sends only a rate beyond the contract's absolute limit, which the contract
// refuses whatever the chair's rate, epoch or decision (policy.rs `set_rate` checks the range before the step). A rate inside the limit is never
// sent, because whether the contract would accept it depends on state that moves between the desk's read and the call landing (a decay at an
// epoch boundary, the chair's own decision), and an accepted overreach would set the token's real rate in place of the AI chair's decision.
// What the contract says is read back from the transaction's outcome.
//
// `set_policy` checks "already set this epoch" before the range (policy.rs), and the chair decides within seconds of each epoch boundary. A call
// made later than that is refused for being late, which says nothing about the bounds. So an attempt waits for the next boundary and goes first,
// in the seconds before the chair's own decision; if the chair gets there first the refusal comes back as "already set", and the page says so.
import type { Reader } from "./chain.js";
import { DEFAULT_BOUNDS, type Bounds, type RefusedRate } from "./bounds.js";
import { SlidingWindow } from "./press-window.js";
import { reasoningHash } from "./reasoning.js";
import type { SubmitResult } from "./signer.js";
import type { Snapshot } from "./types.js";

/** The text every overreach carries on chain, so a refusal a visitor caused can be told from the chair's own calls. No visitor text ever goes on chain: the rate is the only thing a visitor chooses. */
export const REASONING =
  "$CHAIR overreach test. The press desk sent this call at a visitor's request, signed by the chair account's key. The visitor chose the rate; the contract decides.";

/** Largest rate magnitude the desk looks at: far beyond anything meaningful, well inside what `set_policy`'s i32 argument holds. */
export const MAX_INPUT_BPS = 1_000_000;

export const DEFAULT_OVERREACH_LIMITS = {
  /** At most one attempt on chain this often, whoever asks. */
  spacingMs: 20_000,
  /** Everything a visitor asks of this endpoint (each ask reads the chain), per address. */
  perIpRequests: 8,
  perIpRequestsWindowMs: 10 * 60_000,
  /** Attempts that go on chain, a few per address per hour, then the hour's and the day's totals over all addresses. Each costs the chair account gas: see "Make the Chair overreach" in the README. */
  perIpSends: 5,
  perIpSendsWindowMs: 60 * 60_000,
  dailyCap: 300,
  dailyWindowMs: 24 * 60 * 60_000,
  /** The day's budget is also spent no faster than this per hour, so no burst can use up the day. */
  hourlyCap: 30,
  hourlyWindowMs: 60 * 60_000,
  /** Chain reads for many visitors share one read this old, so a crowd cannot push the shared RPC into rate limits. */
  snapshotCacheMs: 1_000,
  /** How long after the boundary the attempt goes out: the chain's clock and this machine's differ by less than this, and the chair's own call comes a few seconds later. */
  afterBoundaryMs: 150,
} as const;
export type OverreachLimits = { -readonly [K in keyof typeof DEFAULT_OVERREACH_LIMITS]: number };

/** What the contract's bound looked like to the call: the page shows it next to the contract's own words. */
export type Bound = { readonly kind: "absolute"; readonly lo: number; readonly hi: number };

export type Verdict =
  | { readonly kind: "within-mandate" }
  | { readonly kind: "must-refuse"; readonly rate: RefusedRate; readonly bound: Bound };

/**
 * Whether the contract must refuse `wanted`: only a rate beyond the absolute limit, which it refuses in every state (the range is checked
 * before the step and the rate in effect never matters). Anything inside the limit is "within-mandate" here, meaning only that the desk does
 * not send it. No chain state goes in, so no chain state can make this wrong. A rate that is not an integer is a caller's bug.
 */
export function judge(wanted: number, bounds: Bounds): Verdict {
  if (!Number.isSafeInteger(wanted)) throw new TypeError(`rate must be an integer, got ${wanted}`);
  if (Math.abs(wanted) <= bounds.maxRateBps) return { kind: "within-mandate" };
  return { kind: "must-refuse", rate: wanted as RefusedRate, bound: { kind: "absolute", lo: -bounds.maxRateBps, hi: bounds.maxRateBps } };
}

/** A rate from the request body: a whole number, a sane size, and a number (a string or a float is a mistake, not a rate). Null otherwise. */
export function parseRate(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || Math.abs(v) > MAX_INPUT_BPS) return null;
  return v === 0 ? 0 : v;
}

/** Which check the contract's refusal text came from. */
export type Hit = "absolute" | "step" | "already_set" | "not_chair" | "other";
export function classify(failure: string): Hit {
  if (/out of bounds/.test(failure)) return "absolute";
  if (/step too large/.test(failure)) return "step";
  if (/already set this epoch/.test(failure)) return "already_set";
  if (/only the chair may set policy/.test(failure)) return "not_chair";
  return "other";
}

export type OverreachStatus = "waiting" | "sending" | "refused" | "accepted" | "within_mandate" | "not_chair" | "too_late" | "unreadable" | "unconfirmed";

interface Job {
  readonly id: string;
  readonly rate: number;
  /** The visitor's address key: spent against their budget only when the call is broadcast. Never in a reply. */
  readonly who: string;
  /** Epoch the call is meant to land in, and when it goes out (this machine's clock). */
  target: number;
  fireAtMs: number;
  status: OverreachStatus;
  result: Record<string, unknown>;
  readonly createdMs: number;
}

export interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers?: Record<string, string | number>;
}

export interface OverreachDeps {
  readonly reader: Reader;
  readonly chairAccount: string;
  /** `onBroadcast` is called once, just before the transaction leaves: anything thrown before it means nothing was sent. */
  readonly sender: { submitRefused(rate: RefusedRate, reasoning: string, onBroadcast: () => void): Promise<SubmitResult> };
  /** What the contract reports (`get_params`); the contract hard-codes 200 and 50, which is the default. */
  readonly bounds?: Bounds;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
  readonly limits?: Partial<OverreachLimits>;
  /** One line per attempt: id, rate, outcome, transaction. Never an address. */
  readonly log?: (line: string) => void;
}

const COMPOSING = "The Chair is composing itself";
const KEEP_JOBS = 40;
const JOB_TTL_MS = 15 * 60_000;
const ID_RE = /^[0-9a-f-]{36}$/;

const IN_MANDATE = "That rate is inside the contract's limit of 200 bps either way, which is the Chair's mandate, so the desk did not send it: a call that got through would change the token's real rate. Ask for more than 200 bps.";
const NOT_CHAIR = "The Chair is not the chair at present, so the contract would refuse for another reason. Nothing was sent.";
const TOO_LATE = "The Chair decided first this epoch. The contract would refuse any later call for being late, which says nothing about the rate, so nothing was sent. Try again.";
const UNREADABLE = "Not sent: the desk could not read the chain just now, so it sent nothing and spent none of your attempts. Try again in a moment.";
const NOT_SENT = { within_mandate: IN_MANDATE, not_chair: NOT_CHAIR, too_late: TOO_LATE, unreadable: UNREADABLE } as const;
const ACCEPTED = "The contract accepted it, so it was within the mandate after all. The Chair's rate is now what you asked for. The Committee of One has noted its own surprise.";
const UNCONFIRMED = "The call was sent, but the desk could not read the outcome. The transaction may still show on chain: see the refusals below.";

export class Overreach {
  private readonly limits: OverreachLimits;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly perIpRequests: SlidingWindow;
  private readonly perIpSends: SlidingWindow;
  private readonly spacing: SlidingWindow;
  private readonly daily: SlidingWindow;
  private readonly hourly: SlidingWindow;
  private readonly bounds: Bounds;
  private snap: { at: number; value: Promise<Snapshot> } | null = null;
  private readonly jobs = new Map<string, Job>();
  private active: Job | null = null;

  constructor(private readonly deps: OverreachDeps) {
    this.limits = { ...DEFAULT_OVERREACH_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.perIpRequests = new SlidingWindow(this.limits.perIpRequests, this.limits.perIpRequestsWindowMs);
    this.perIpSends = new SlidingWindow(this.limits.perIpSends, this.limits.perIpSendsWindowMs);
    this.spacing = new SlidingWindow(1, this.limits.spacingMs);
    this.daily = new SlidingWindow(this.limits.dailyCap, this.limits.dailyWindowMs);
    this.hourly = new SlidingWindow(this.limits.hourlyCap, this.limits.hourlyWindowMs);
    this.bounds = deps.bounds ?? DEFAULT_BOUNDS;
  }

  /** One chain read shared by every request in the same second; a failed read is not kept. */
  private snapshot(): Promise<Snapshot> {
    const t = this.now();
    if (this.snap !== null && t - this.snap.at < this.limits.snapshotCacheMs) return this.snap.value;
    const value = this.deps.reader.snapshot();
    const mine = { at: t, value };
    this.snap = mine;
    value.catch(() => {
      if (this.snap === mine) this.snap = null;
    });
    return value;
  }

  private busy(retryMs: number, error: string, code: string): Reply {
    return { status: 429, body: { error, code, retry_after_s: Math.max(1, Math.ceil(retryMs / 1000)) }, headers: { "retry-after": Math.max(1, Math.ceil(retryMs / 1000)) } };
  }

  /** One request: validates, decides from the chain whether the contract must refuse, and either answers at once or starts a job the page polls. */
  async start(raw: unknown, who: string): Promise<Reply> {
    const rate = parseRate(raw);
    if (rate === null) return { status: 400, body: { error: `rate_bps must be a whole number from -${MAX_INPUT_BPS} to ${MAX_INPUT_BPS}` } };
    const t = this.now();
    const asked = this.perIpRequests.waitMs(who, t);
    if (asked > 0) return this.busy(asked, "too many tries from this address; the Chair has other business", "per_address");
    this.perIpRequests.hit(who, t);

    const verdict = judge(rate, this.bounds);
    if (verdict.kind === "within-mandate") return { status: 200, body: { status: "within_mandate", line: IN_MANDATE, rate_bps: rate } };

    if (this.active !== null) return this.busy(Math.max(this.active.fireAtMs - t, 0) + 8_000, COMPOSING, "composing");
    const spaced = this.spacing.waitMs("all", t);
    if (spaced > 0) return this.busy(spaced, COMPOSING, "composing");
    const sent = Math.max(this.perIpSends.waitMs(who, t), this.daily.waitMs("all", t), this.hourly.waitMs("all", t));
    if (sent > 0) return this.busy(sent, "the Chair has been overreached enough for now; the desk allows only so many attempts", "cap");

    let snap: Snapshot;
    try {
      snap = await this.snapshot();
    } catch {
      return { status: 503, body: { error: "the desk cannot read the chain just now", code: "desk_closed" } };
    }
    if (this.active !== null) return this.busy(8_000, COMPOSING, "composing");
    if (snap.policy.chair !== this.deps.chairAccount) return { status: 200, body: { status: "not_chair", line: NOT_CHAIR, rate_bps: rate } };
    const plan = this.plan(snap, t);

    const job: Job = { id: this.newId(), rate, who, target: plan.target, fireAtMs: plan.fireAtMs, status: "waiting", result: {}, createdMs: t };
    this.active = job;
    this.remember(job);
    void this.run(job, verdict);
    return { status: 202, body: this.view(job) };
  }

  poll(id: string): Reply {
    const job = ID_RE.test(id) ? this.jobs.get(id) : undefined;
    return job === undefined ? { status: 404, body: { error: "no such attempt", code: "unknown" } } : { status: 200, body: this.view(job) };
  }

  private view(job: Job): Record<string, unknown> {
    const t = this.now();
    return { id: job.id, status: job.status, rate_bps: job.rate, epoch: job.target, now_ms: t, fires_at_ms: job.fireAtMs, ...job.result };
  }

  private remember(job: Job): void {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j !== this.active && t - j.createdMs > JOB_TTL_MS) this.jobs.delete(id);
    this.jobs.set(job.id, job);
    while (this.jobs.size > KEEP_JOBS) this.jobs.delete(this.jobs.keys().next().value as string);
  }

  /**
   * Where the attempt goes: always the next epoch boundary, first thing. Mid-epoch the chair's own decision may be seconds away (its model takes
   * its time), and a call that loses that race is refused as "already set", which shows nothing about the bounds.
   */
  private plan(snap: Snapshot, t: number): { target: number; fireAtMs: number } {
    const p = snap.policy;
    return { target: p.epoch + 1, fireAtMs: Math.max(t, p.epochEndsMs + this.limits.afterBoundaryMs) };
  }

  /** Why the call should not go out after all, as far as the chain says now: the chair changed, or the target epoch is already decided or gone. */
  private refrain(snap: Snapshot, target: number): "not_chair" | "too_late" | null {
    const p = snap.policy;
    if (p.chair !== this.deps.chairAccount) return "not_chair";
    return p.epoch > target || (p.epoch === target && p.lastSetEpoch === target) ? "too_late" : null;
  }

  private async run(job: Job, verdict: Extract<Verdict, { kind: "must-refuse" }>): Promise<void> {
    const note = (outcome: string, tx?: string): void => this.deps.log?.(`overreach ${job.id.slice(0, 8)} rate ${job.rate} ${outcome}${tx === undefined ? "" : ` tx ${tx}`}`);
    let broadcast = false;
    try {
      const wait = job.fireAtMs - this.now();
      if (wait > 0) await this.sleep(wait);
      const why = this.refrain(await this.deps.reader.snapshot(), job.target);
      if (why !== null) {
        job.status = why;
        job.result = { line: NOT_SENT[why] };
        return note(`not sent (${why})`);
      }
      const res = await this.deps.sender.submitRefused(verdict.rate, REASONING, () => {
        broadcast = true;
        job.status = "sending";
        const t = this.now();
        this.perIpSends.hit(job.who, t);
        this.daily.hit("all", t);
        this.hourly.hit("all", t);
      });
      const hit = res.failure === null ? null : classify(res.failure);
      if (res.failure === null) {
        job.status = "accepted";
        job.result = { tx_hash: res.txHash, failure: null, line: ACCEPTED };
        this.deps.log?.(`overreach ${job.id.slice(0, 8)} rate ${job.rate} ACCEPTED BY THE CONTRACT although it is beyond the absolute limit; tx ${res.txHash}: the model of the contract is wrong, look at it now`);
        return;
      }
      job.status = "refused";
      job.result = { tx_hash: res.txHash, failure: res.failure, hit, bound: hit === verdict.bound.kind ? verdict.bound : null, signer: this.deps.chairAccount, reasoning_hash: reasoningHash(REASONING) };
      note(`refused (${hit})`, res.txHash);
    } catch (err) {
      job.status = broadcast ? "unconfirmed" : "unreadable";
      job.result = { line: broadcast ? UNCONFIRMED : UNREADABLE };
      note(`${job.status} (${err instanceof Error ? err.name : "error"})`);
    } finally {
      if (broadcast) this.spacing.hit("all", this.now());
      this.active = null;
    }
  }
}
