// The press desk's test-coin faucet: a visitor sends the public key of a throwaway testnet account of their own, and the desk creates that account
// (a NEAR implicit account, whose id is the key's 64 hex characters), gives it a little NEAR for gas and 50 test CHAIR, so the visitor can stake,
// unstake, claim and send with a key the desk never saw. This project's own faucet, testnet only: the page says so.
//
// What bounds it: the signer (signer.ts `FaucetSigner`) can build only the three transactions of one grant, with fixed amounts, to a 64-hex account;
// the account behind it holds only the faucet's budget; and here a grant is refused unless the key's account does not exist yet, the visitor's address
// has not had one today, the desk is under its hourly, daily and lifetime caps, and the faucet account still holds a grant's worth of NEAR and CHAIR.
// Switches: no key file means no faucet (cli.ts); a kill file, checked on every request, closes it at once, no restart needed.
//
// A grant is counted before its first transaction leaves (the state file is written first, atomically and synced; if it cannot be written nothing is
// sent), so a crash or a failed step never gives out more than the caps allow. The grants are kept in the file with their time, their account and the
// hash of each of the three steps that finished, not as counters: the hourly, daily and lifetime figures are all read off one list, and a restart
// loses nothing. So is every transaction: its hash and signed bytes are written before it is sent, and the same key asking again settles that very
// transaction (looked up by its hash, sent again byte for byte if the network never saw it) before any new one is signed, so a step is paid at most
// once however many times an answer was lost. A step is signed afresh only after its stored transaction is seen executed with a failure (signer.ts `settleKnown`), at most
// `MAX_SIGNATURES` times, counted in the record; then the record says the grant gave up and later asks are answered from it. A finished grant is answered from the record; the chain's state (an account exists, a balance is
// there) is never taken as proof a step was ours. 409 is only for an account that exists on chain and is not in the record.

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { baseDecode, SignedTransaction } from "near-api-js";
import type { Reply } from "./press-overreach.js";
import { SerialQueue, SlidingWindow } from "./press-window.js";
import { realClock, withinDeadline, type Clock, type NearRpc } from "./rpc.js";
import { FAUCET_GRANT_CHAIR, FAUCET_GRANT_NEAR, FAUCET_STEPS, FAUCET_STORAGE_DEPOSIT, hashOf, type FaucetOutcome, type FaucetSender, type FaucetStep, type PendingTx } from "./signer.js";
import { sanitize } from "./text.js";
import { int, u128 } from "./validate.js";

export const DEFAULT_FAUCET_LIMITS = {
  /** Grants per address (three, so judges on one wifi, or on a laptop and a phone, can each have one), then the desk's totals. The file keeps every grant, so these survive a restart; the per-address window does not. */
  perIpGrants: 3,
  perIpGrantsWindowMs: 24 * 60 * 60_000,
  hourlyCap: 5,
  hourlyWindowMs: 60 * 60_000,
  dailyCap: 20,
  dailyWindowMs: 24 * 60 * 60_000,
  lifetimeCap: 200,
  /** Everything a visitor asks of this endpoint (each valid ask reads the chain), per address. */
  perIpRequests: 10,
  perIpRequestsWindowMs: 10 * 60_000,
  /** Visitors that may wait for the one grant in flight. */
  queueMax: 3,
  /** The most time one request may take from when it is accepted (waiting for its turn counts) before it answers 502 or 503 JSON: well under the 100 s a Cloudflare tunnel waits, after which the visitor would get an HTML error page. */
  requestDeadlineMs: 75_000,
  /** While the chain checks made at start (`FaucetDeps.check`) have not passed, how often they are tried again; once they have, how often the faucet's balance is read again so the state and /health stay true about running dry. */
  readyRetryMs: 30_000,
} as const;
export type FaucetLimits = { -readonly [K in keyof typeof DEFAULT_FAUCET_LIMITS]: number };

/**
 * NEAR the faucet account must hold beyond a grant and the registration: creating an implicit account burns about 0.007 NEAR for the faucet, and each
 * function call reserves its attached gas up front (the unused part is refunded). A real grant costs about 0.06 NEAR; with this margin the faucet goes dry
 * at 0.09 NEAR, before a grant can fail for want of gas.
 */
export const FAUCET_GAS_MARGIN = 4n * 10n ** 22n;
/** What the chain charges a byte of account storage, in yoctoNEAR. */
const STORAGE_BYTE_COST = 10n ** 19n;

/** Why the faucet is closed: not switched on, switched off by the kill file, out of coins or NEAR, or out of its lifetime budget; `unreadable` is the desk failing to read or record, not a decision. */
export type ClosedReason = "off" | "killed" | "dry" | "budget" | "unreadable";

const CLOSED_TEXT: Record<ClosedReason, string> = {
  off: "the faucet is not switched on",
  killed: "the faucet has been switched off for now",
  dry: "the faucet has run out of test coins or NEAR for now",
  budget: "the faucet has given out all the test coins it was given",
  unreadable: "the desk cannot read or record the chain just now; nothing was sent",
};

/** The 503 for a closed faucet. */
export function closed(reason: ClosedReason): Reply {
  return { status: 503, body: { error: CLOSED_TEXT[reason], reason } };
}

/** A decimal string for `value` units of 10^-`decimals`: 50 CHAIR is "50", 0.05 NEAR is "0.05". */
export function formatUnits(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return fraction === "" ? digits.slice(0, digits.length - decimals) : `${digits.slice(0, digits.length - decimals)}.${fraction}`;
}

const GRANT_CHAIR = formatUnits(FAUCET_GRANT_CHAIR, 24);
const GRANT_NEAR = formatUnits(FAUCET_GRANT_NEAR, 24);

/** The state of a faucet that is not switched on: the grant it would make, and nothing left to give. */
export const OFF_STATE: Reply = { status: 200, body: { open: false, grant_chair: GRANT_CHAIR, grant_near: GRANT_NEAR, remaining: 0, next_opening_s: 0, reason: "off" } };

const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** The implicit account of an `ed25519:<base58>` public key: its 32 bytes as 64 lowercase hex. Null for anything else. */
export function implicitAccount(key: unknown): string | null {
  if (typeof key !== "string" || !KEY_RE.test(key)) return null;
  let bytes: Uint8Array;
  try {
    bytes = baseDecode(key.slice("ed25519:".length));
  } catch {
    return null;
  }
  return bytes.length === 32 ? Buffer.from(bytes).toString("hex") : null;
}

/** The caps that CHAIR_FAUCET_PER_ADDRESS, CHAIR_FAUCET_HOURLY, CHAIR_FAUCET_DAILY and CHAIR_FAUCET_LIFETIME set, from `env`; each must be a positive whole number, else this throws and the faucet does not start. */
export function limitsFromEnv(env: NodeJS.ProcessEnv): Partial<FaucetLimits> {
  const limits: { perIpGrants?: number; hourlyCap?: number; dailyCap?: number; lifetimeCap?: number } = {};
  for (const [name, key] of [["CHAIR_FAUCET_PER_ADDRESS", "perIpGrants"], ["CHAIR_FAUCET_HOURLY", "hourlyCap"], ["CHAIR_FAUCET_DAILY", "dailyCap"], ["CHAIR_FAUCET_LIFETIME", "lifetimeCap"]] as const) {
    const raw = env[name];
    if (raw !== undefined) limits[key] = int(/^\d{1,7}$/.test(raw) ? Number(raw) : Number.NaN, name, 1, 1_000_000);
  }
  return limits;
}

/** What the faucet needs to know of the chain. Every read is of the newest block, so a step sent a moment ago already shows. */
export interface FaucetReader {
  exists(accountId: string): Promise<boolean>;
  /** The faucet account's NEAR above its own storage cost, and its CHAIR. */
  funds(): Promise<{ readonly near: bigint; readonly chair: bigint }>;
}

export class RpcFaucetReader implements FaucetReader {
  constructor(
    private readonly rpc: NearRpc,
    private readonly token: string,
    private readonly faucetAccount: string,
  ) {}

  async exists(accountId: string): Promise<boolean> {
    return (await this.rpc.account(accountId)) !== null;
  }

  private async chairOf(accountId: string): Promise<bigint> {
    return u128(await this.rpc.view(this.token, "ft_balance_of", { account_id: accountId }, "optimistic"), "ft_balance_of");
  }

  async funds(): Promise<{ near: bigint; chair: bigint }> {
    const account = await this.rpc.account(this.faucetAccount);
    if (account === null) throw new Error("the faucet account does not exist");
    const kept = BigInt(account.storageUsage) * STORAGE_BYTE_COST;
    return { near: account.amount > kept ? account.amount - kept : 0n, chair: await this.chairOf(this.faucetAccount) };
  }
}

/** A check made when the faucet comes up that can never pass (the key is the wrong kind, the chain is mainnet): the faucet stays off instead of trying again. */
export class Refused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

/** The steps of a grant that finished, with their transaction hashes. */
type Steps = { readonly [S in FaucetStep]?: string };

/** The most transactions signed for one step of one grant: a step the chain keeps failing is given up, and answers a permanent failure without sending. */
export const MAX_SIGNATURES = 3;

interface Grant {
  readonly at: number;
  readonly account: string;
  readonly steps: Steps;
  /** The transactions signed so far for the first unfinished step; 0 once that step is done, so the count is per step. */
  readonly signed: number;
  /** The transaction sent for the first unfinished step that was not seen to finish. */
  readonly pending?: PendingTx;
  /** Set once the step ran out of signatures: the grant is over, and every later ask is answered from this record without touching the chain. */
  readonly gaveUp?: FaucetStep;
}

/** Thrown by the record hook once `step` is marked given up, so the signer signs and sends nothing. */
class GaveUp extends Error {
  constructor(readonly step: FaucetStep) {
    super(`step ${step} is given up`);
  }
}

const complete = (g: Grant): boolean => FAUCET_STEPS.every((s) => g.steps[s] !== undefined);
const hashes = (g: Grant): string[] => FAUCET_STEPS.flatMap((s) => g.steps[s] ?? []);

const hashLike = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 100;
const BASE64_RE = /^[A-Za-z0-9+/]+=*$/;

/** The signed transaction in a record's bytes, with its hash and nonce; null when the bytes are not a signed transaction. */
function decodedPending(tx: string): { readonly hash: string; readonly nonce: bigint } | null {
  try {
    const signed = SignedTransaction.decode(Buffer.from(tx, "base64"));
    return { hash: hashOf(signed), nonce: signed.transaction.nonce };
  } catch {
    return null;
  }
}

/** Writes `text` to `path` atomically: a synced temporary file renamed over it, and the directory synced. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const dir = openSync(dirname(path), "r");
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** Every grant ever begun, oldest first, in a small JSON file replaced atomically (and synced, with its directory) on each change. */
class Ledger {
  private grants: readonly Grant[];

  /**
   * Throws when the file exists but is not a ledger (the desk then does not know its budget), when it is absent and cannot be created, or when it is
   * absent but `marker` says a ledger was once created for this desk (a moved or lost state file would otherwise hand out the whole budget again): the faucet then does not start.
   */
  constructor(private readonly path: string, marker?: string) {
    if (existsSync(path)) this.grants = Ledger.parse(readFileSync(path, "utf8"));
    else {
      if (marker !== undefined && existsSync(marker)) {
        throw new Error(`this faucet has run on this desk before, but its state file is missing (${path}): put it back, or delete the marker ${marker} to start a fresh budget`);
      }
      this.grants = [];
      this.write([]);
    }
    if (marker !== undefined && !existsSync(marker)) atomicWrite(marker, `a faucet state file was created at ${path}\n`);
  }

  private static parse(raw: string): Grant[] {
    const data: unknown = JSON.parse(raw);
    const list = typeof data === "object" && data !== null ? (data as { grants?: unknown }).grants : undefined;
    if (!Array.isArray(list)) throw new Error("the faucet state file is not a list of grants");
    const bad = (): never => {
      throw new Error("the faucet state file has a malformed grant");
    };
    return list
      .map((g: unknown): Grant => {
        const { at, account, steps, signed, pending, gaveUp } = (typeof g === "object" && g !== null ? g : {}) as { at?: unknown; account?: unknown; steps?: unknown; signed?: unknown; pending?: unknown; gaveUp?: unknown };
        const done = typeof steps === "object" && steps !== null && !Array.isArray(steps) ? (steps as Record<string, unknown>) : null;
        if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0 || typeof account !== "string" || !/^[0-9a-f]{64}$/.test(account) || done === null) return bad();
        if (typeof signed !== "number" || !Number.isSafeInteger(signed) || signed < 0 || signed > MAX_SIGNATURES || (pending !== undefined && signed === 0)) return bad();
        const kept: { -readonly [S in FaucetStep]?: string } = {};
        for (const [step, tx] of Object.entries(done)) {
          if (!(FAUCET_STEPS as readonly string[]).includes(step) || !hashLike(tx)) return bad();
          kept[step as FaucetStep] = tx;
        }
        const next = FAUCET_STEPS.find((st) => kept[st] === undefined);
        const gave = gaveUp === undefined ? {} : next !== undefined && gaveUp === next && pending === undefined ? { gaveUp: next } : bad();
        if (pending === undefined) return { at, account, steps: kept, signed, ...gave };
        const p = (typeof pending === "object" && pending !== null ? pending : {}) as { step?: unknown; hash?: unknown; tx?: unknown };
        if (next === undefined || p.step !== next || !hashLike(p.hash) || typeof p.tx !== "string" || p.tx.length > 4000 || !BASE64_RE.test(p.tx) || decodedPending(p.tx)?.hash !== p.hash) return bad();
        return { at, account, steps: kept, signed, pending: { step: next, hash: p.hash, tx: p.tx } };
      })
      .sort((a, b) => a.at - b.at);
  }

  get count(): number {
    return this.grants.length;
  }

  get(account: string): Grant | undefined {
    return this.grants.find((g) => g.account === account);
  }

  private write(grants: readonly Grant[]): void {
    atomicWrite(this.path, `${JSON.stringify({ v: 1, grants })}\n`);
  }

  /** Writes the new list, then keeps it: a failed write throws and changes nothing. */
  private set(next: readonly Grant[]): void {
    this.write(next);
    this.grants = next;
  }

  add(grant: Grant): void {
    this.set([...this.grants, grant]);
  }

  private update(account: string, change: (g: Grant) => Grant): void {
    this.set(this.grants.map((g) => (g.account === account ? change(g) : g)));
  }

  /** The step executed: it is done, nothing is pending for it, and the next step starts with no signatures. */
  record(account: string, step: FaucetStep, tx: string): void {
    this.update(account, ({ pending: _gone, ...g }) => ({ ...g, signed: 0, steps: { ...g.steps, [step]: tx } }));
  }

  /** The step has no signatures left and its last transaction failed: the grant is over. */
  giveUp(account: string, step: FaucetStep): void {
    this.update(account, ({ pending: _gone, ...g }) => ({ ...g, gaveUp: step }));
  }

  /** A new transaction was signed for the step: it is the pending one, and it counts. */
  setPending(account: string, pending: PendingTx): void {
    this.update(account, (g) => ({ ...g, signed: g.signed + 1, pending }));
  }

  /** The highest nonce among the transactions recorded as pending, for any visitor; 0 when none is. A record whose bytes do not decode is refused at start, so every one here does. */
  pendingNonce(): bigint {
    return this.grants.reduce((top, g) => {
      const nonce = g.pending === undefined ? 0n : (decodedPending(g.pending.tx)?.nonce ?? 0n);
      return nonce > top ? nonce : top;
    }, 0n);
  }

  /** Milliseconds until `max` grants in `windowMs` leave room for one more; 0 when there is room now. */
  waitMs(max: number, windowMs: number, now: number): number {
    const live = this.grants.filter((g) => g.at > now - windowMs);
    return live.length < max ? 0 : live[live.length - max]!.at + windowMs - now;
  }
}

export interface FaucetDeps {
  readonly reader: FaucetReader;
  readonly sender: FaucetSender;
  /** The grants file. Created at start if absent; a file that exists and is unreadable, or a path that cannot be written, stops the faucet from starting. */
  readonly stateFile: string;
  /** A file made beside the first state file and never removed: a state file that is gone while it exists stops the faucet from starting, so a moved path cannot reset the budget. */
  readonly markerFile?: string;
  /** While this file exists the faucet answers 503 `killed`. Unset: no kill switch. */
  readonly killFile?: string;
  /**
   * Checks that need the chain (it is not mainnet, the key is the right kind). They run at start and, while the chain does not answer, again every
   * `readyRetryMs`; until one passes the faucet is closed (`unreadable`). Throw `Refused` for a failure no retry can fix: the faucet then stays off.
   */
  readonly check?: () => Promise<void>;
  readonly now?: () => number;
  /** What the request deadline reads (see `FaucetLimits.requestDeadlineMs`); unset: the real one. */
  readonly clock?: Clock;
  readonly limits?: Partial<FaucetLimits>;
  /** One line per notable event: a grant, a step that failed, a threshold of the budget, the faucet going dry. Never an address. */
  readonly log?: (line: string) => void;
}

const STEP_FAILED: Record<FaucetStep, string> = {
  transfer: "The desk could not confirm the NEAR transfer to your account; send the same key again in a minute and it will pick up where it stopped.",
  storage_deposit: "Your account was created with its NEAR, but registering it with the token failed, so no CHAIR was sent yet; send the same key again in a minute and it will pick up where it stopped.",
  ft_transfer: "Your account was created and registered with the token, but the CHAIR transfer failed; send the same key again in a minute and it will pick up where it stopped.",
};

const GAVE_UP: Record<FaucetStep, string> = {
  transfer: `The NEAR transfer to your account did not go through in ${MAX_SIGNATURES} tries, so the desk will not try again for this key.`,
  storage_deposit: `Your account was created with its NEAR, but registering it with the token failed ${MAX_SIGNATURES} times, so the desk will not try again for this key and no CHAIR was sent.`,
  ft_transfer: `Your account was created and registered with the token, but the CHAIR transfer failed ${MAX_SIGNATURES} times, so the desk will not try again for this key.`,
};

/** The budget levels that get a log line when `remaining` first drops below them. */
const LOW_MARKS = [50, 10] as const;

export class Faucet {
  private readonly limits: FaucetLimits;
  private readonly now: () => number;
  private readonly clock: Clock;
  private readonly ledger: Ledger;
  private readonly perIpRequests: SlidingWindow;
  private readonly perIpGrants: SlidingWindow;
  private readonly queue: SerialQueue;
  /** Whether the faucet account was last found to hold less than a grant; read again with every grant and every `readyRetryMs` by `watch`. */
  private dry = false;
  private ready: boolean;
  private refused: string | null = null;
  private probing: Promise<boolean> | null = null;
  private nextProbeAt = 0;
  private waiting = false;

  constructor(private readonly deps: FaucetDeps) {
    this.limits = { ...DEFAULT_FAUCET_LIMITS, ...deps.limits };
    this.now = deps.now ?? Date.now;
    this.clock = deps.clock ?? realClock;
    this.ledger = new Ledger(deps.stateFile, deps.markerFile);
    this.perIpRequests = new SlidingWindow(this.limits.perIpRequests, this.limits.perIpRequestsWindowMs);
    this.perIpGrants = new SlidingWindow(this.limits.perIpGrants, this.limits.perIpGrantsWindowMs);
    this.queue = new SerialQueue(this.limits.queueMax);
    this.ready = deps.check === undefined;
  }

  private log(line: string): void {
    this.deps.log?.(`faucet ${line}`);
  }

  /** Runs the start-up checks now if they have not passed and it is not too soon after the last try; resolves with whether the faucet is ready. Never throws. */
  ensure(): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    if (this.refused !== null || this.now() < this.nextProbeAt) return Promise.resolve(false);
    this.probing ??= this.probe().finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async probe(): Promise<boolean> {
    try {
      await this.deps.check?.();
      this.ready = true;
      this.log("ready: the chain checks passed");
    } catch (err) {
      const why = err instanceof Error ? sanitize(err.message, 200) : "unknown error";
      if (err instanceof Refused) {
        this.refused = why;
        this.log(`off: ${why}`);
      } else {
        this.nextProbeAt = this.now() + this.limits.readyRetryMs / 2;
        if (!this.waiting) this.log(`waiting for the chain (${why}); trying again every ${this.limits.readyRetryMs / 1000} s`);
        this.waiting = true;
      }
    }
    return this.ready;
  }

  /**
   * Tries the start-up checks now and again every `readyRetryMs` until they pass, so a chain that was down at start does not keep the faucet off; once
   * they have, reads the faucet's balance every `readyRetryMs`, so `state()` and `live()` say dry (or open again) without waiting for a visitor to find out.
   * Returns the stop function.
   */
  watch(): () => void {
    const look = async (): Promise<void> => {
      if (!(await this.ensure())) return;
      try {
        await this.checkFunds();
      } catch (err) {
        this.log(`balance not read (${err instanceof Error ? sanitize(err.message, 200) : "unreadable"}); the last answer stands`);
      }
    };
    void look();
    const timer = setInterval(() => void look(), this.limits.readyRetryMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  private killed(): boolean {
    return this.deps.killFile !== undefined && existsSync(this.deps.killFile);
  }

  /** Whether the faucet can give at all: its checks passed, the kill file is absent (looked up on every call, so touching or removing it takes effect on the next request), the lifetime budget is not spent and the faucet account was last found to hold a grant. */
  live(): boolean {
    return this.ready && !this.killed() && this.remaining() > 0 && !this.dry;
  }

  private remaining(): number {
    return Math.max(0, this.limits.lifetimeCap - this.ledger.count);
  }

  /** Milliseconds until the desk's hourly and daily caps allow another grant. */
  private totalsWaitMs(t: number): number {
    return Math.max(this.ledger.waitMs(this.limits.hourlyCap, this.limits.hourlyWindowMs, t), this.ledger.waitMs(this.limits.dailyCap, this.limits.dailyWindowMs, t));
  }

  /** What a page needs to know before offering the button: memory and the kill file only, no chain read, so it may be asked as often as it likes. The balance is as of the last look (`watch`, or the last grant). */
  state(): Reply {
    if (this.refused !== null) return OFF_STATE;
    const t = this.now();
    const remaining = this.remaining();
    const killed = this.killed();
    const waitMs = this.totalsWaitMs(t);
    const reason: ClosedReason | null = killed ? "killed" : remaining === 0 ? "budget" : !this.ready ? "unreadable" : this.dry ? "dry" : null;
    const open = reason === null && waitMs <= 0;
    const next = reason === null ? Math.ceil(waitMs / 1000) : 0;
    return { status: 200, body: { open, grant_chair: GRANT_CHAIR, grant_near: GRANT_NEAR, remaining, next_opening_s: next, ...(reason === null ? {} : { reason }) } };
  }

  /** A 429. `limit: "address"` (only on the per-address grant cap) tells the page the wait is this network's own, not the whole desk's. */
  private busy(retryMs: number, error: string, limit?: "address"): Reply {
    const s = Math.max(1, Math.ceil(retryMs / 1000));
    return { status: 429, body: { error, retry_after_s: s, ...(limit === undefined ? {} : { limit }) }, headers: { "retry-after": s } };
  }

  /** The refusal that applies to a visitor asking for a grant that has not begun, or null when a grant may go ahead. Resuming one that has begun never comes here. */
  private refusal(who: string, t: number): Reply | null {
    if (this.killed()) return closed("killed");
    if (this.remaining() === 0) return closed("budget");
    const own = this.perIpGrants.waitMs(who, t);
    if (own > 0) return this.busy(own, `this address has already had its ${this.limits.perIpGrants} test coin grants for today`, "address");
    const total = this.totalsWaitMs(t);
    if (total > 0) return this.busy(total, "the faucet has handed out all it may for now; try again later");
    return null;
  }

  /** The reply for a grant whose step ran out of signatures, from the record alone. */
  private gaveUp(g: Grant, step: FaucetStep): Reply {
    return { status: 502, body: { error: GAVE_UP[step], failed_step: step, account_id: g.account, txs: hashes(g) } };
  }

  private recorded(g: Grant): Reply {
    return { status: 200, body: { account_id: g.account, txs: hashes(g), chair: GRANT_CHAIR, near: GRANT_NEAR } };
  }

  /**
   * One request: validates the key, answers a finished grant from the record (whatever the kill file, the budget or the chain say: it is only a
   * record), refuses a closed faucet, checks the limits of a new grant, waits its turn, then sends what is left to send.
   */
  async start(publicKey: unknown, who: string): Promise<Reply> {
    const account = implicitAccount(publicKey);
    if (account === null) return { status: 400, body: { error: 'public_key must be an ed25519 public key written "ed25519:<base58>"' } };
    if (this.refused !== null) return closed("off");
    const t = this.now();
    const asked = this.perIpRequests.waitMs(who, t);
    if (asked > 0) return this.busy(asked, "too many tries from this address; try again in a few minutes");
    this.perIpRequests.hit(who, t);
    const known = this.ledger.get(account);
    if (known !== undefined && complete(known)) return this.recorded(known);
    if (known?.gaveUp !== undefined) return this.gaveUp(known, known.gaveUp);
    if (this.killed()) return closed("killed");
    const deadlineAt = this.clock.now() + this.limits.requestDeadlineMs;
    if (!(await withinDeadline(() => this.ensure(), deadlineAt, this.clock).catch(() => false))) return closed("unreadable");
    if (known === undefined) {
      const refused = this.refusal(who, t);
      if (refused !== null) return refused;
    }
    if (!this.queue.hasRoom) return this.busy(10_000, "another visitor is being served; try again in a few seconds");
    return this.queue.run(() => this.grant(who, account, deadlineAt));
  }

  /** Reads the faucet account and keeps whether it holds a grant's worth of NEAR and CHAIR; logs when that changes. Throws when the chain cannot be read. */
  private async checkFunds(): Promise<boolean> {
    const funds = await this.deps.reader.funds();
    const enough = funds.chair >= FAUCET_GRANT_CHAIR && funds.near >= FAUCET_GRANT_NEAR + FAUCET_STORAGE_DEPOSIT + FAUCET_GAS_MARGIN;
    if (!enough && !this.dry) this.log("dry: the faucet account holds less than one grant; refill it to reopen");
    if (enough && this.dry) this.log("funded again: the faucet account holds a grant");
    this.dry = !enough;
    return enough;
  }

  /** The log lines for the budget running down: once when `remaining` first goes below each mark, and when it is spent. */
  private logBudget(before: number): void {
    const after = this.remaining();
    for (const mark of LOW_MARKS) if (before >= mark && after < mark) this.log(`budget: ${after} of ${this.limits.lifetimeCap} grants left, below ${mark}`);
    if (before > 0 && after === 0) this.log(`budget: all ${this.limits.lifetimeCap} grants are given; the faucet is closed`);
  }

  private async grant(who: string, account: string, deadlineAt: number): Promise<Reply> {
    if (this.killed()) return closed("killed");
    const begun = this.ledger.get(account);
    if (begun !== undefined && complete(begun)) return this.recorded(begun);
    if (begun === undefined) {
      const refused = this.refusal(who, this.now());
      if (refused !== null) return refused;
    }
    try {
      if (begun === undefined && (await withinDeadline(() => this.deps.reader.exists(account), deadlineAt, this.clock))) {
        return { status: 409, body: { error: "that account already exists; the faucet only funds new accounts" } };
      }
      if (!(await withinDeadline(() => this.checkFunds(), deadlineAt, this.clock))) return closed("dry");
    } catch (err) {
      this.log(`not sent (${err instanceof Error ? sanitize(err.message, 200) : "unreadable"})`);
      return closed("unreadable");
    }

    const hooks = {
      onPending: (tx: PendingTx): void => {
        const have = this.ledger.get(account);
        if (have === undefined) {
          const before = this.remaining();
          this.ledger.add({ at: this.now(), account, steps: {}, signed: 1, pending: tx });
          this.perIpGrants.hit(who, this.now());
          this.logBudget(before);
        } else if (have.signed >= MAX_SIGNATURES) {
          this.ledger.giveUp(account, tx.step);
          throw new GaveUp(tx.step);
        } else this.ledger.setPending(account, tx);
      },
      onStep: (step: FaucetStep, tx: string): void => this.ledger.record(account, step, tx),
      halt: (): boolean => this.killed(),
      nonceFloor: (): bigint => this.ledger.pendingNonce(),
    };
    const have = this.ledger.get(account);
    const finished = new Set(FAUCET_STEPS.filter((s) => have?.steps[s] !== undefined));
    let outcome: FaucetOutcome = { txs: [], failed: null };
    try {
      if (finished.size < FAUCET_STEPS.length) outcome = await this.deps.sender.grant(account, finished, have?.pending ?? null, hooks, deadlineAt);
    } catch (err) {
      const counted = this.ledger.get(account);
      if (counted !== undefined && err instanceof GaveUp) {
        this.log(`gave up at ${err.step} after ${MAX_SIGNATURES} signatures: nothing more is sent for this grant`);
        return this.gaveUp(counted, err.step);
      }
      this.log(`${counted === undefined ? "not sent" : "unconfirmed"} (${err instanceof Error ? sanitize(err.message, 200) : "error"})`);
      return counted === undefined ? closed("unreadable") : { status: 502, body: { error: "the desk could not confirm the grant; send the same key again in a minute", account_id: account, txs: hashes(counted) } };
    }
    if (outcome.halted === true) return closed("killed");
    const now = this.ledger.get(account);
    if (now === undefined) return closed("unreadable"); // a sender that finished without ever recording a transaction: nothing is on record, so nothing may be claimed
    if (outcome.failed !== null) {
      const { step, failure } = outcome.failed; // a failed step keeps its transaction pending: the next ask looks it up, and only that look may lead to a new signature
      this.log(`failed at ${step}${failure === null ? "" : ` (${failure})`} after ${hashes(now).length} tx: ${hashes(now).join(" ")}`);
      return { status: 502, body: { error: STEP_FAILED[step], failed_step: step, account_id: account, txs: hashes(now) } };
    }
    this.log(`grant tx ${hashes(now).join(" ")}`);
    return this.recorded(now);
  }
}
