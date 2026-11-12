import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { actions, baseDecode, baseEncode, createTransaction, KeyPairSigner, type Action, type SignedTransaction } from "near-api-js";
import { DEFAULT_BOUNDS, type Rate, type RefusedRate } from "./bounds.js";
import { DeadlineError, NearRpc, RpcError, realClock, withinDeadline, type AccessKeyInfo, type Clock, type TxStatus } from "./rpc.js";
import type { Decision } from "./types.js";
import { cleanReasoning, MAX_REASONING_CHARS, reasoningHash } from "./reasoning.js";
import { accountId as checkAccountId } from "./validate.js";

export const METHOD = "set_policy";
/**
 * set_policy is a few reads and writes; rollover can add at most a handful of decay events. The reasoning text adds
 * at most 6000 bytes of arguments (MAX_REASONING_CHARS UTF-16 units, 3 bytes each in UTF-8): sandbox-tests/tests/policy.rs
 * sends that much to the contract's wasm and asserts it burns under half of these 30 Tgas.
 */
export const GAS = 30_000_000_000_000n;
const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}$/;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/**
 * Finds the chair's secret key: `CHAIR_KEY` holds it, or `CHAIR_KEY_FILE` names a file with it (see `loadKeyFile`).
 * Messages never contain the key or any part of it.
 */
export function loadSecretKey(env: NodeJS.ProcessEnv, warn: (message: string) => void = () => undefined): string {
  const inline = env["CHAIR_KEY"];
  const path = env["CHAIR_KEY_FILE"];
  if (inline && path) throw new KeyError("set only one of CHAIR_KEY and CHAIR_KEY_FILE");
  if (inline) return parseKey(inline);
  if (path) return loadKeyFile(path, "CHAIR_KEY_FILE", warn);
  throw new KeyError("no key: set CHAIR_KEY or CHAIR_KEY_FILE (a function-call key scoped to set_policy)");
}

/**
 * Reads a key file: either the bare `ed25519:...` string or a near-cli credentials JSON with `private_key`. `envVar` is the variable
 * that named the file (the chair's, the overreach toy's or the visitor pool's), so an error says which one to fix.
 */
export function loadKeyFile(path: string, envVar: string, warn: (message: string) => void = () => undefined): string {
  let raw: string;
  try {
    const st = statSync(path);
    if (st.size > 4096) throw new KeyError(`${envVar} is too large to be a key file`);
    if ((st.mode & 0o077) !== 0) warn(`${envVar} is readable by group or others; run chmod 600 on it`);
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof KeyError) throw err;
    throw new KeyError(`${envVar} cannot be read`);
  }
  return parseKey(raw);
}

function parseKey(raw: string): string {
  let key = raw.trim();
  if (key.startsWith("{")) {
    try {
      const j = JSON.parse(key) as Record<string, unknown>;
      const v = j["private_key"] ?? j["secret_key"];
      key = typeof v === "string" ? v : "";
    } catch {
      key = "";
    }
  }
  if (!KEY_RE.test(key)) throw new KeyError("the key is not an ed25519 secret key (expected ed25519:<base58>)");
  return key;
}

/** SPEC "The chair's key": a function-call key for the token, method set_policy and nothing else. */
export function assertScoped(info: AccessKeyInfo, token: string): void {
  const p = info.permission;
  if (p === "FullAccess") throw new KeyError("refusing a full-access key: use a function-call key scoped to set_policy");
  if (p.receiverId !== token || p.methodNames.length !== 1 || p.methodNames[0] !== METHOD) {
    throw new KeyError(`key must be scoped to receiver ${token} and methods [${METHOD}] only`);
  }
}

export interface SubmitResult {
  readonly txHash: string;
  /** The contract's refusal or failure text, or null when the call executed. */
  readonly failure: string | null;
}

export interface Submitter {
  /** `resendBefore` (ms since 1970): past it the identical bytes are never sent again, only looked up (a late landing would count in the wrong meeting). */
  submit(decision: Decision, resendBefore?: number): Promise<SubmitResult>;
  /** Where an earlier send of this key stands, by its hash: null when no node knows it. Optional: a submitter that cannot look up is never asked. */
  lookUp?(txHash: string): Promise<TxStatus | null>;
}

/**
 * The arguments of `set_policy`: the rate, the SHA-256 of the reasoning text and the text itself. The contract declares
 * only the first two and ignores `reasoning` (sandbox-tests/tests/policy.rs proves it), so the text rides on the
 * transaction without touching the hash it stores: anyone can read it from the transaction and hash it. Nothing but the
 * text is added, and the hash is computed here from the text, so the two cannot disagree.
 */
export function policyArgs(rate: Rate | RefusedRate, reasoning: string): { rate_bps: number; reasoning_hash: string; reasoning: string } {
  if (cleanReasoning(reasoning) !== reasoning) throw new Error(`reasoning must be cleaned text of 1 to ${MAX_REASONING_CHARS} characters`);
  return { rate_bps: rate, reasoning_hash: reasoningHash(reasoning), reasoning };
}

/**
 * How a send whose answer got lost is settled: look the transaction up by its hash, and send the same signed bytes again if no node knows it.
 * `attempts` looks are taken, with pauses of `backoffMs`, twice that, and so on between them; `recoverMs` caps the whole recovery, so a caller never waits longer
 * than that after the first answer failed (the agent's meeting margin is 15 s, a visitor's click should not hang).
 */
export interface SettleOptions {
  readonly attempts?: number;
  readonly backoffMs?: number;
  readonly recoverMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly clock?: Clock;
}

/**
 * A send that was signed and broadcast but never seen to execute: the transaction may still land, so the reply must name it (`txHash`, a field of its own:
 * a log line that cuts the message must not cut the hash). The cause's message and flags are kept; any other error than an `RpcError` (a malformed answer)
 * says nothing about the transaction, so it counts as an answer that did not come.
 */
export class UnconfirmedSend extends RpcError {
  constructor(cause: unknown, readonly txHash: string) {
    const rpc = cause instanceof RpcError ? cause : null;
    super(cause instanceof Error ? cause.message : "send failed", rpc?.methodMissing ?? false, rpc?.transient ?? true, rpc?.unaccepted ?? false);
    this.name = "UnconfirmedSend";
  }
}

/** The hash of the transaction a failed send had signed, or null when the error is not about a sent transaction. */
export const unconfirmedHash = (err: unknown): string | null => (err instanceof UnconfirmedSend ? err.txHash : null);

/** One key on one account, signing single function calls to the token. The subclasses decide which call they can construct. */
abstract class TokenCaller {
  private readonly keys: KeyPairSigner;
  protected readonly settle: Required<SettleOptions>;
  constructor(
    secretKey: string,
    readonly accountId: string,
    readonly token: string,
    protected readonly rpc: NearRpc,
    settle: SettleOptions = {},
  ) {
    checkAccountId(accountId, "signer account");
    checkAccountId(token, "token account");
    this.settle = { attempts: settle.attempts ?? 4, backoffMs: settle.backoffMs ?? 500, recoverMs: settle.recoverMs ?? 8_000, sleep: settle.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))), clock: settle.clock ?? realClock };
    try {
      this.keys = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
    } catch {
      throw new KeyError("the key could not be loaded");
    }
  }

  async publicKey(): Promise<string> {
    return (await this.keys.getPublicKey()).toString();
  }

  /** Sign one action, to the token unless the subclass names another receiver. */
  protected async sign(call: Action, nonce: bigint, blockHash: string, receiver: string = this.token): Promise<SignedTransaction> {
    const publicKey = await this.keys.getPublicKey();
    const tx = createTransaction(this.accountId, publicKey, receiver, nonce + 1n, [call], baseDecode(blockHash));
    const { signedTransaction } = await this.keys.signTransaction(tx);
    return signedTransaction;
  }

  /** The nonce of the last transaction this signer signed: a transaction still pending on the chain is not yet in the chain's own count, so the next one starts above whichever is higher. */
  private lastNonce = 0n;

  /** Never sign at or below `nonce`: a transaction of it may still sit in a pool, where the chain's own count does not show it. */
  protected raiseNonce(nonce: bigint): void {
    if (nonce > this.lastNonce) this.lastNonce = nonce;
  }

  /**
   * The nonce is read at `optimistic` finality: a call this key sent moments ago is already counted, where `final` lags it by a block or two and would
   * reuse its nonce; and it is never lower than the last one this signer used, in case the node answering is behind. `allowed` throws when the key is not
   * the kind this caller may use. `onBroadcast` runs once, just before the transaction is sent; a throw before it means nothing was sent.
   */
  protected async send(call: (nonce: bigint, blockHash: string) => Promise<SignedTransaction>, allowed: (info: AccessKeyInfo) => void, onBroadcast: () => void, resendBefore = Infinity): Promise<SubmitResult> {
    const signed = await this.prepare(call, allowed);
    onBroadcast();
    return this.sendSigned(signed, resendBefore);
  }

  /** Signs the call at the next nonce without sending it. */
  protected async prepare(call: (nonce: bigint, blockHash: string) => Promise<SignedTransaction>, allowed: (info: AccessKeyInfo) => void): Promise<SignedTransaction> {
    const info = await this.rpc.accessKey(this.accountId, await this.publicKey(), "optimistic");
    allowed(info);
    const block = await this.rpc.finalBlock();
    const nonce = info.nonce > this.lastNonce ? info.nonce : this.lastNonce;
    const signed = await call(nonce, block.hash);
    this.lastNonce = nonce + 1n;
    return signed;
  }

  protected sendSigned(signed: SignedTransaction, resendBefore = Infinity): Promise<SubmitResult> {
    return this.deliver({ hash: hashOf(signed), tx: Buffer.from(signed.encode()).toString("base64") }, resendBefore);
  }

  /** Waits out the pause between two looks at a transaction, doubling each time; false once the looks are used up. */
  protected async pause(attempt: number): Promise<boolean> {
    if (attempt >= this.settle.attempts) return false;
    await this.settle.sleep(this.settle.backoffMs * 2 ** (attempt - 1));
    return true;
  }

  /**
   * Sends a signed transaction, every call of every signer through here. An answer that never came (timeout, throttle, dropped connection) does not say whether the
   * node took it: so look it up by its hash, wait while it is still on its way, and send the identical signed bytes again, once, when the node does not know it. The same bytes
   * cannot be paid twice (the network keeps one transaction per nonce), they are never signed again, and a transaction this young is not yet forgotten, so no archival
   * look is needed here. The recovery ends within `recoverMs`; what it could not settle is thrown as `UnconfirmedSend`, which carries the hash. Past `resendBefore`
   * the bytes are not sent again, only looked up: the contract counts a call in the meeting open when it executes, so a late resend could land in the next one.
   * Any error after the broadcast gets this treatment, a malformed answer included: it says nothing about whether the transaction landed.
   */
  protected async deliver(p: { readonly hash: string; readonly tx: string }, resendBefore = Infinity): Promise<SubmitResult> {
    try {
      return await this.rpc.sendTx(p.tx);
    } catch (err) {
      if (err instanceof RpcError && !err.transient) throw new UnconfirmedSend(err, p.hash);
      const { clock } = this.settle;
      const until = clock.now() + this.settle.recoverMs;
      for (let attempt = 1; await this.pause(attempt); attempt++) {
        const seen = await withinDeadline(() => this.rpc.txOutcome(p.hash, this.accountId), until, clock).catch(() => undefined);
        if (seen?.executed === true) return { txHash: p.hash, failure: seen.failure };
        if (seen !== null || clock.now() >= resendBefore) continue;
        try {
          return await withinDeadline(() => this.rpc.sendTx(p.tx), Math.min(until, resendBefore), clock);
        } catch (again) {
          throw new UnconfirmedSend(again, p.hash);
        }
      }
      throw new UnconfirmedSend(err, p.hash);
    }
  }
}

/**
 * Builds and sends `set_policy` transactions. The only action it can construct is one function call to
 * `set_policy` with zero deposit; the only fields taken from a `Decision` are its `Rate` and its reasoning text.
 */
export class ChairSigner extends TokenCaller implements Submitter {
  /** Sign one set_policy call. Exposed for tests; `submit` is the normal path. */
  async build(rate: Rate | RefusedRate, reasoning: string, nonce: bigint, blockHash: string): Promise<SignedTransaction> {
    return this.sign(actions.functionCall(METHOD, policyArgs(rate, reasoning), GAS, 0n), nonce, blockHash);
  }

  async submit(decision: Decision, resendBefore?: number): Promise<SubmitResult> {
    return this.sendPolicy(decision.rate, decision.reasoning, () => undefined, resendBefore);
  }

  /** Where an earlier `submit` stands, by its hash (`Submitter.lookUp`). Throws `RpcError` when no node answers. */
  lookUp(txHash: string): Promise<TxStatus | null> {
    return this.rpc.txOutcome(txHash, this.accountId);
  }

  /**
   * The press desk's overreach: a rate beyond the contract's absolute limit, sent with a fixed text, to show the contract refuses it. Checked
   * here again, independently of the desk's own `judge`: a rate the contract might accept would set the token's real rate, so it never leaves.
   * `onBroadcast` runs once, just before the transaction is sent; a throw before it means nothing was sent.
   */
  async submitRefused(rate: RefusedRate, reasoning: string, onBroadcast: () => void = () => undefined): Promise<SubmitResult> {
    if (!Number.isSafeInteger(rate) || Math.abs(rate) <= DEFAULT_BOUNDS.maxRateBps) {
      throw new RangeError(`refusing to send ${rate} as an overreach: only a rate beyond +-${DEFAULT_BOUNDS.maxRateBps} is certain to be refused`);
    }
    return this.sendPolicy(rate, reasoning, onBroadcast);
  }

  /** Both the agent's decision and the desk's overreach go through here, signed by the same key, so the nonce is counted at `optimistic` finality (see `send`). */
  private sendPolicy(rate: Rate | RefusedRate, reasoning: string, onBroadcast: () => void = () => undefined, resendBefore?: number): Promise<SubmitResult> {
    return this.send((nonce, block) => this.build(rate, reasoning, nonce, block), (info) => assertScoped(info, this.token), onBroadcast, resendBefore);
  }
}

export const STAKE_METHOD = "stake";
export const UNSTAKE_METHOD = "unstake";
/** Both calls are a few reads and writes after a `roll()`; sandbox-tests/tests/resolver_gas.rs bounds the worst-case roll well under half of 30 Tgas. */
export const POOL_GAS = 30_000_000_000_000n;
/** What a stake attaches: the contract wants at least 1 yoctoNEAR, and an account's first stake also pays for its record (about 80 bytes, measured by the contract), the rest refunded. 0.01 NEAR, as the sandbox tests attach (`STAKE_RECORD_DEPOSIT`). */
export const STAKE_DEPOSIT = 10n ** 22n;
/** The deposit `unstake` insists on, exactly. */
export const UNSTAKE_DEPOSIT = 1n;

/** The U128 argument the contract's `stake` and `unstake` take: a positive whole number as a decimal string. */
function amountArgs(amount: bigint): { amount: string } {
  if (amount <= 0n || amount >= 1n << 128n) throw new RangeError("amount must be a positive U128");
  return { amount: amount.toString() };
}

export interface PoolSender {
  /** `onBroadcast` is called once, just before the transaction leaves: anything thrown before it means nothing was sent. */
  stake(amount: bigint, onBroadcast: () => void): Promise<SubmitResult>;
  unstake(amount: bigint, onBroadcast: () => void): Promise<SubmitResult>;
}

/**
 * The visitor pool's signer for "Join the Committee". The only actions it can construct are one `stake` or one `unstake` on the token, with the
 * deposit those calls need: no transfer, no `back`, no `nominate`, nothing else exists to call. The contract wants a deposit with both, which a
 * function-call key cannot attach, so the pool account's key is a full-access key; this class is the only thing that holds it, and the account
 * holds nothing but the pool's test coins and the NEAR its calls cost.
 */
export class PoolSigner extends TokenCaller implements PoolSender {
  /** Sign one stake or unstake call. Exposed for tests; `stake` and `unstake` are the normal path. */
  async build(method: typeof STAKE_METHOD | typeof UNSTAKE_METHOD, amount: bigint, nonce: bigint, blockHash: string): Promise<SignedTransaction> {
    const deposit = method === STAKE_METHOD ? STAKE_DEPOSIT : UNSTAKE_DEPOSIT;
    return this.sign(actions.functionCall(method, amountArgs(amount), POOL_GAS, deposit), nonce, blockHash);
  }

  stake(amount: bigint, onBroadcast: () => void = () => undefined): Promise<SubmitResult> {
    return this.sendPool(STAKE_METHOD, amount, onBroadcast);
  }

  unstake(amount: bigint, onBroadcast: () => void = () => undefined): Promise<SubmitResult> {
    return this.sendPool(UNSTAKE_METHOD, amount, onBroadcast);
  }

  private sendPool(method: typeof STAKE_METHOD | typeof UNSTAKE_METHOD, amount: bigint, onBroadcast: () => void): Promise<SubmitResult> {
    return this.send((nonce, block) => this.build(method, amount, nonce, block), assertFullAccess, onBroadcast);
  }
}

/** The pool's calls and the faucet's attach a deposit or move NEAR, which only a full-access key can do: a function-call key would fail every call, so say so up front. */
export function assertFullAccess(info: AccessKeyInfo): void {
  if (info.permission !== "FullAccess") throw new KeyError("the signing key must be a full-access key: its calls attach a deposit or move NEAR, which a function-call key cannot");
}

const CHAIR_UNIT = 10n ** 24n;

/** The transaction's hash as the network names it: the base58 of the sha256 of the unsigned transaction. */
export const hashOf = (signed: SignedTransaction): string => baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());

/** What one visitor gets from the press desk's faucet: 50 CHAIR (24 decimals, `ft_metadata`) and 0.05 NEAR. 0.03 measured too little on testnet: a visitor's first stake with 30 Tgas attached failed, as each call reserves its gas up front. Nothing else depends on these values. */
export const FAUCET_GRANT_CHAIR = 50n * CHAIR_UNIT;
export const FAUCET_GRANT_NEAR = 5n * 10n ** 22n;
/** The token's storage registration for one account, exactly: `storage_balance_bounds` reports min = max = 0.00125 NEAR (read from the live token). */
export const FAUCET_STORAGE_DEPOSIT = 125n * 10n ** 19n;
/** The faucet's two function calls: `ft_transfer` may roll the epoch over, so it gets the same 30 Tgas as the pool's calls (unused gas is refunded). */
export const FAUCET_GAS = 30_000_000_000_000n;
export const FAUCET_MEMO = "chair faucet: test coins for a page visitor";

/** The three transactions of one grant, in the order they are sent. */
export const FAUCET_STEPS = ["transfer", "storage_deposit", "ft_transfer"] as const;
export type FaucetStep = (typeof FAUCET_STEPS)[number];

/** A NEAR implicit account: the 64 lowercase hex characters of an ed25519 public key. */
const IMPLICIT_RE = /^[0-9a-f]{64}$/;

export interface FaucetOutcome {
  /** The hashes of the steps that executed in this call, in order. */
  readonly txs: readonly string[];
  /** Null when every step is done; else the step that did not go through and the contract's refusal text (null when its outcome is unknown, e.g. the node did not answer). */
  readonly failed: { readonly step: FaucetStep; readonly failure: string | null } | null;
  /** Set when `hooks.halt()` stopped the grant before a step was started. */
  readonly halted?: true;
}

/** A signed transaction of a grant: its hash and its signed bytes (base64; a signature and a public key, no secret), so the very same transaction can be looked up, or sent again. */
export interface PendingTx {
  readonly step: FaucetStep;
  readonly hash: string;
  readonly tx: string;
}

export interface FaucetHooks {
  /** Called with each new transaction just before it first leaves: record it. A throw means nothing was sent, and `grant` rejects. */
  onPending(tx: PendingTx): void;
  /** Called after each step executed, with its transaction hash. */
  onStep(step: FaucetStep, txHash: string): void;
  /** Asked before a new step is started: true means stop here (the faucet was switched off). */
  halt(): boolean;
  /** Asked before each new signature: the highest nonce of any transaction still recorded as pending, for any visitor, so a restart (which forgets what the signer used) never signs at the nonce of one that may still land. */
  nonceFloor(): bigint;
}

export interface FaucetSender {
  /**
   * Sends the steps of one grant to `receiver` (an implicit account id) that are not in `finished`, in order, stopping at the first that fails.
   * `pending` is the transaction of an earlier call that was sent and never seen to finish: it is settled first, never replaced while it can still land.
   * `deadlineAt` (ms since 1970) is when the whole call must be over: past it the step in hand is left pending and the call answers `failed` with no failure text.
   */
  grant(receiver: string, finished: ReadonlySet<FaucetStep>, pending: PendingTx | null, hooks: FaucetHooks, deadlineAt: number): Promise<FaucetOutcome>;
}

/**
 * The press desk's faucet signer. The only actions it can construct are the three of one grant to a visitor's own new account: a Transfer of
 * `FAUCET_GRANT_NEAR`, the token's `storage_deposit` for that account with `FAUCET_STORAGE_DEPOSIT`, and `ft_transfer` of `FAUCET_GRANT_CHAIR`
 * with 1 yoctoNEAR. The amounts are the constants above and the receiver is checked to be exactly 64 lowercase hex characters (a key's account, never
 * the faucet's own or a named one), so no input can change what is signed beyond which new account gets it. The key is full-access (a Transfer
 * needs it); the account holds only the faucet's budget.
 */
export class FaucetSigner extends TokenCaller implements FaucetSender {
  /** `archival` is asked after the ordinary nodes, because it still knows a transaction they forgot (about 31 hours); it settles nothing by not knowing one (see `settleKnown`). */
  constructor(secretKey: string, accountId: string, token: string, rpc: NearRpc, private readonly archival: NearRpc, settle: SettleOptions = {}) {
    super(secretKey, accountId, token, rpc, settle);
  }

  private checkReceiver(receiver: string): void {
    if (!IMPLICIT_RE.test(receiver) || receiver === this.accountId) throw new RangeError("the receiver must be a 64-character lowercase hex implicit account");
  }

  /** Sign one step of a grant. Exposed for tests; `grant` is the normal path. */
  async build(step: FaucetStep, receiver: string, nonce: bigint, blockHash: string): Promise<SignedTransaction> {
    this.checkReceiver(receiver);
    switch (step) {
      case "transfer":
        return this.sign(actions.transfer(FAUCET_GRANT_NEAR), nonce, blockHash, receiver);
      case "storage_deposit":
        return this.sign(actions.functionCall("storage_deposit", { account_id: receiver }, FAUCET_GAS, FAUCET_STORAGE_DEPOSIT), nonce, blockHash);
      case "ft_transfer":
        return this.sign(actions.functionCall("ft_transfer", { receiver_id: receiver, amount: FAUCET_GRANT_CHAIR.toString(), memo: FAUCET_MEMO }, FAUCET_GAS, 1n), nonce, blockHash);
      default:
        throw new RangeError(`no such faucet step: ${String(step)}`);
    }
  }

  /** The caller serializes grants (one in flight); each new transaction signs above the last nonce this signer used, so one still pending is never overwritten. */
  async grant(receiver: string, finished: ReadonlySet<FaucetStep>, pending: PendingTx | null, hooks: FaucetHooks, deadlineAt: number): Promise<FaucetOutcome> {
    this.checkReceiver(receiver);
    const txs: string[] = [];
    let carried = pending;
    for (const step of FAUCET_STEPS) {
      if (finished.has(step)) continue;
      let sent = false;
      try {
        let res: SubmitResult | null = null;
        const stored = carried;
        if (stored !== null && stored.step === step) {
          sent = true;
          carried = null;
          res = await withinDeadline(() => this.settleKnown(stored), deadlineAt, this.settle.clock);
        }
        if (res === null) {
          sent = false; // from here on a throw means the fresh transaction was not sent
          if (hooks.halt()) return { txs, failed: null, halted: true };
          this.raiseNonce(hooks.nonceFloor());
          const signed = await withinDeadline(() => this.prepare((nonce, block) => this.build(step, receiver, nonce, block), assertFullAccess), deadlineAt, this.settle.clock);
          const fresh = { step, hash: hashOf(signed), tx: Buffer.from(signed.encode()).toString("base64") };
          hooks.onPending(fresh);
          sent = true;
          res = await withinDeadline(() => this.deliver(fresh), deadlineAt, this.settle.clock);
        }
        if (res.failure !== null) return { txs, failed: { step, failure: res.failure } };
        txs.push(res.txHash);
        hooks.onStep(step, res.txHash);
      } catch (err) {
        if (!sent && !(err instanceof DeadlineError)) throw err;
        return { txs, failed: { step, failure: null } };
      }
    }
    return { txs, failed: null };
  }

  /**
   * The rule: a step gets a fresh signature ONLY after its stored transaction is seen executed with an ACTION failure on the chain (`TxStatus.executed`
   * with a `failure`: one of its actions failed, so its nonce is used and it ran). Nothing else ever leads to a new signature: not a rejected resend
   * (a congested shard refuses a transaction that still sits in a pool), not "unknown" from any node (an ordinary node forgets after about 31 hours,
   * and no node can say a transaction in some pool will never land), not an `InvalidTxError` (a refused transaction that may be included later), not
   * expiry, not time. Executed and succeeded, the step is done; executed with an action failure, null (sign a new one); anything else (included and
   * not executed, unknown anywhere, no answer): the same bytes are sent once more, however that is refused and whatever it answers, one more look is
   * taken, and if it is still not executed this throws and the step stays pending. A transaction that truly never lands thus leaves its visitor on
   * "try again" for good, which costs nothing; a second payment is impossible. This is the only place that decides a signature, and it is told only
   * by `lookUp`, never by what a send answered.
   */
  private async settleKnown(p: PendingTx): Promise<SubmitResult | null> {
    const first = await this.lookUp(p);
    const seen = first?.executed === true ? first : (await this.resend(p), await this.lookUp(p));
    if (seen?.executed !== true) throw new RpcError("the transaction is not executed yet", false, true);
    return seen.failure === null ? { txHash: p.hash, failure: null } : null;
  }

  /** What the ordinary nodes say of the transaction, else what the archival node says (it keeps what they forgot); null when neither says anything, whether they do not know it or did not answer. */
  private async lookUp(p: PendingTx): Promise<TxStatus | null> {
    for (const rpc of [this.rpc, this.archival]) {
      const seen = await rpc.txOutcome(p.hash, this.accountId).catch((err: unknown) => {
        if (err instanceof RpcError) return null;
        throw err;
      });
      if (seen !== null) return seen;
    }
    return null;
  }

  /** Sends the stored bytes again and ignores the answer, a refusal of any kind or an outcome: the same bytes can never be paid twice, and `lookUp` is what says where they stand. */
  private async resend(p: PendingTx): Promise<void> {
    try {
      await this.rpc.sendTx(p.tx);
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
    }
  }
}
