import { sanitize } from "./text.js";
import { int, u128, ValidationError } from "./validate.js";

/** A failure talking to the node: transport, HTTP status, or a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly methodMissing = false,
    /** The node did not give an answer about the request (transport failure, HTTP error status, a throttle, a timeout): what a retry, or another node, may fix. */
    readonly transient = false,
    /** The node refused before it looked at the request (HTTP 429, a connection that was refused or never made): nothing was accepted, so even a send may go to the next endpoint. */
    readonly unaccepted = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** The time allowed to a request ran out. Transient: nothing is known of what the node would have said. */
export class DeadlineError extends RpcError {
  constructor() {
    super("the chain did not answer in time", false, true);
    this.name = "DeadlineError";
  }
}

/** The time a deadline reads: `now` in ms since 1970, and `after` runs `fire` once `ms` have passed and answers how to cancel it. A test hands in one it advances by hand. */
export interface Clock {
  now(): number;
  after(ms: number, fire: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

/**
 * Starts `work` and answers with it, or throws `DeadlineError` once `deadlineAt` (ms since 1970) has passed; when it has already passed `work` is not
 * started. The work itself is not cancelled, so it may only read, or send bytes that are safe to send again.
 */
export function withinDeadline<T>(work: () => Promise<T>, deadlineAt: number, clock: Clock = realClock): Promise<T> {
  const left = deadlineAt - clock.now();
  if (left <= 0) return Promise.reject(new DeadlineError());
  let cancel = (): void => undefined;
  const late = new Promise<never>((_, reject) => {
    cancel = clock.after(left, () => reject(new DeadlineError()));
  });
  return Promise.race([work(), late]).finally(cancel);
}

export interface AccessKeyInfo {
  readonly nonce: bigint;
  /** `"FullAccess"` or the function-call permission fields. */
  readonly permission: "FullAccess" | { readonly receiverId: string; readonly methodNames: readonly string[] };
}

/** Where a transaction stands: `executed` is false while it is included and its receipts have not run. */
export interface TxStatus {
  readonly txHash: string;
  readonly failure: string | null;
  readonly executed: boolean;
}

export interface FinalBlock {
  readonly hash: string;
  readonly timestampMs: number;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/** How a node says an account is not there: an error whose cause is UNKNOWN_ACCOUNT (current nodes), or a result with an error string (older ones). */
const UNKNOWN_ACCOUNT_RE = /UNKNOWN_ACCOUNT|does not exist while viewing/;
const BASE58_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError(what, "not an object");
  return v as Record<string, unknown>;
}

/** Transport errors that happened before a byte of the request reached a node: refused, or the name did not resolve. */
const NEVER_REACHED_RE = /^(ECONNREFUSED|ENOTFOUND|EAI_AGAIN)$/;

function neverReached(err: unknown): boolean {
  const cause = typeof err === "object" && err !== null ? (err as { cause?: unknown }).cause : undefined;
  const code = typeof cause === "object" && cause !== null ? (cause as { code?: unknown }).code : undefined;
  return typeof code === "string" && NEVER_REACHED_RE.test(code);
}

/** JSON-RPC errors that say the node, not the request, was the problem. */
const TRANSIENT_ERROR_RE = /TIMEOUT_ERROR|UNAVAILABLE_SHARD|UNKNOWN_BLOCK|NOT_SYNCED|INTERNAL_ERROR/;

export interface RpcRetry {
  /** Tries per read, each on the next endpoint when there is more than one. Default 1: no retry. */
  readonly attempts?: number;
  /** Pause before the second try; doubled after each. */
  readonly backoffMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * The few JSON-RPC calls the chair needs, with every response checked before it is used. `url` may be several endpoints separated by commas:
 * a try that gets no answer (see `RpcError.transient`) moves on to the next one. Reads are retried as `retry` says (default: once, as before).
 * `sendTx` moves to the next endpoint only when the node refused before accepting (`RpcError.unaccepted`); an answer that never came is thrown,
 * because only the caller knows whether sending the same bytes again is safe (see `txOutcome`).
 */
export class NearRpc {
  private id = 0;
  private readonly urls: readonly string[];
  private cursor = 0;
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(
    readonly url: string,
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    retry: RpcRetry = {},
  ) {
    this.urls = url.split(",").map((u) => u.trim());
    for (const one of this.urls) {
      let protocol: string;
      try {
        protocol = new URL(one).protocol;
      } catch {
        throw new RpcError("rpc url must be http or https");
      }
      if (protocol !== "https:" && protocol !== "http:") throw new RpcError("rpc url must be http or https");
    }
    this.attempts = retry.attempts ?? 1;
    this.backoffMs = retry.backoffMs ?? 500;
    this.sleep = retry.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** `retriable` says which failures may try again, on the next endpoint: by default any that got no answer; a send passes only those the node refused before accepting. */
  private async call(method: string, params: unknown, attempts = this.attempts, retriable: (err: RpcError) => boolean = (err) => err.transient): Promise<Record<string, unknown>> {
    for (let i = 1; ; i++) {
      try {
        return await this.callOnce(this.urls[this.cursor]!, method, params);
      } catch (err) {
        if (!(err instanceof RpcError) || !retriable(err) || i >= attempts) throw err;
        this.cursor = (this.cursor + 1) % this.urls.length;
        await this.sleep(this.backoffMs * 2 ** (i - 1));
      }
    }
  }

  private async callOnce(url: string, method: string, params: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: `chair-${++this.id}`, method, params });
    let text: string;
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new RpcError(`rpc ${method}: HTTP ${res.status}`, false, true, res.status === 429);
      text = await res.text();
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(`rpc ${method}: ${err instanceof Error ? err.name : "request failed"}`, false, true, neverReached(err));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RpcError(`rpc ${method}: response is not JSON`, false, true);
    }
    const o = obj(parsed, `rpc ${method} response`);
    if (o["error"] !== undefined) {
      const why = describeError(o["error"]);
      throw new RpcError(`rpc ${method}: ${why}`, isMethodMissing(o["error"]), TRANSIENT_ERROR_RE.test(why));
    }
    return obj(o["result"], `rpc ${method} result`);
  }

  async chainId(): Promise<string> {
    const r = await this.call("status", []);
    const id = r["chain_id"];
    if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new ValidationError("status", "no chain_id");
    return id;
  }

  /** The newest block that is final, or (`optimistic`) the newest of all: what a call that has just executed already shows in. */
  async finalBlock(finality: "final" | "optimistic" = "final"): Promise<FinalBlock> {
    const r = await this.call("block", { finality });
    const h = obj(r["header"], "block header");
    const hash = h["hash"];
    if (typeof hash !== "string" || !BASE58_HASH_RE.test(hash)) throw new ValidationError("block", "bad hash");
    // timestamp_nanosec is a string because nanoseconds since 1970 exceed 2^53.
    const ns = h["timestamp_nanosec"];
    if (typeof ns !== "string" || !/^[1-9]\d{0,24}$/.test(ns)) throw new ValidationError("block", "bad timestamp_nanosec");
    return { hash, timestampMs: Number(BigInt(ns) / 1_000_000n) };
  }

  /** Calls a view method and returns its JSON result. `at` is a block hash, or `"optimistic"` / `"final"` for the newest block of that kind (a fresh hash can be unknown to the node that answers). */
  async view(contractId: string, methodName: string, args: unknown, at: string): Promise<unknown> {
    const r = await this.call("query", {
      request_type: "call_function",
      ...(at === "optimistic" || at === "final" ? { finality: at } : { block_id: at }),
      account_id: contractId,
      method_name: methodName,
      args_base64: Buffer.from(JSON.stringify(args ?? {}), "utf8").toString("base64"),
    });
    if (typeof r["error"] === "string") throw new RpcError(`view ${methodName}: ${sanitize(r["error"])}`, isMethodMissing(r["error"]));
    const bytes = r["result"];
    if (!Array.isArray(bytes) || bytes.length > 1_000_000 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) {
      throw new ValidationError(`view ${methodName}`, "result is not a byte array");
    }
    try {
      return JSON.parse(Buffer.from(bytes as number[]).toString("utf8"));
    } catch {
      throw new ValidationError(`view ${methodName}`, "result is not JSON");
    }
  }

  async accessKey(accountId: string, publicKey: string, finality: "final" | "optimistic" = "final"): Promise<AccessKeyInfo> {
    const r = await this.call("query", {
      request_type: "view_access_key",
      finality,
      account_id: accountId,
      public_key: publicKey,
    });
    if (typeof r["error"] === "string") throw new RpcError(`access key: ${sanitize(r["error"])}`);
    const n = r["nonce"];
    const nonce = typeof n === "number" ? BigInt(int(n, "nonce", 0)) : BigInt(u128(n, "nonce"));
    return { nonce, permission: parsePermission(r["permission"]) };
  }

  /** An account's balance and storage use at the newest block (a transfer sent a moment ago already shows), or null when the account does not exist. */
  async account(accountId: string): Promise<{ amount: bigint; storageUsage: number } | null> {
    let r: Record<string, unknown>;
    try {
      r = await this.call("query", { request_type: "view_account", finality: "optimistic", account_id: accountId });
    } catch (err) {
      if (err instanceof RpcError && UNKNOWN_ACCOUNT_RE.test(err.message)) return null;
      throw err;
    }
    if (typeof r["error"] === "string") {
      if (UNKNOWN_ACCOUNT_RE.test(r["error"])) return null;
      throw new RpcError(`account: ${sanitize(r["error"])}`);
    }
    return { amount: u128(r["amount"], "amount"), storageUsage: int(r["storage_usage"], "storage_usage", 0) };
  }

  /** Every access key on the account, as the node reports them (SPEC: the chair account must hold no full-access key). */
  async accessKeyList(accountId: string): Promise<{ publicKey: string; permission: AccessKeyInfo["permission"] }[]> {
    const r = await this.call("query", { request_type: "view_access_key_list", finality: "final", account_id: accountId });
    if (typeof r["error"] === "string") throw new RpcError(`access key list: ${sanitize(r["error"])}`);
    const keys = r["keys"];
    if (!Array.isArray(keys) || keys.length > 1000) throw new ValidationError("access key list", "malformed key list");
    return keys.map((k) => {
      const o = obj(k, "access key list entry");
      const publicKey = o["public_key"];
      if (typeof publicKey !== "string" || publicKey.length > 120) throw new ValidationError("access key list", "bad public_key");
      return { publicKey, permission: parsePermission(obj(o["access_key"], "access key list entry")["permission"]) };
    });
  }

  /** Broadcasts a signed transaction and waits until it executed; returns the final status object. A refusal before acceptance is tried on the next endpoint; see the class comment. */
  async sendTx(signedBase64: string): Promise<{ txHash: string; failure: string | null }> {
    return outcome(await this.call("send_tx", { signed_tx_base64: signedBase64, wait_until: "EXECUTED_OPTIMISTIC" }, Math.max(this.urls.length, this.attempts), (err) => err.unaccepted), "send_tx");
  }

  /**
   * Where a transaction stands, by its hash: `executed: false` while it is included and not yet run (or was refused as an `InvalidTxError`, see
   * `ranStatus`), else its outcome, and null when this node does not know it, which proves nothing: an ordinary node keeps about 31 hours of history
   * and answers UNKNOWN_TRANSACTION for an older one that did land (proven on testnet: fastnear, drpc and near.org forget it,
   * archival-rpc.testnet.fastnear.com still answers it), and a transaction in a pool is unknown too. It asks with `wait_until: NONE`, which answers at
   * once. Measured on testnet 2026-11-12 (test.rpc.fastnear.com and rpc.testnet.fastnear.com): for a hash the network never saw, `EXECUTED_OPTIMISTIC`
   * answers only after its own timeout (30 s and 10 s), as TIMEOUT_ERROR with cause NOT_OBSERVED,
   * which cannot be told from a transaction still on its way; `NONE` answers UNKNOWN_TRANSACTION in 0.2 s. For an executed one `NONE` returns the full
   * outcome (`status.SuccessValue`) in 0.2 s.
   */
  async txOutcome(txHash: string, signerId: string): Promise<TxStatus | null> {
    let r: Record<string, unknown>;
    try {
      r = await this.call("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "NONE" });
    } catch (err) {
      if (err instanceof RpcError && /UNKNOWN_TRANSACTION/.test(err.message)) return null;
      throw err;
    }
    const ran = ranStatus(r["status"]);
    return { txHash, failure: ran?.failure ?? null, executed: ran !== null };
  }
}

/**
 * The status of a transaction that ran, or null when it did not (yet): it succeeded, or one of its actions failed (`Failure.ActionError`). Any other
 * `Failure` is an `InvalidTxError`: the transaction was refused as invalid, which does not prove it ran, that its nonce was used, or that the same
 * bytes will not be included later, so it is not "executed" here.
 */
function ranStatus(status: unknown): { failure: string | null } | null {
  if (typeof status !== "object" || status === null) return null;
  if ("SuccessValue" in status) return { failure: null };
  const failure = "Failure" in status ? status["Failure"] : undefined;
  return typeof failure === "object" && failure !== null && "ActionError" in failure ? { failure: describeFailure(failure) } : null;
}

function outcome(r: Record<string, unknown>, what: string): { txHash: string; failure: string | null } {
  const tx = obj(r["transaction"], `${what} transaction`);
  const txHash = tx["hash"];
  if (typeof txHash !== "string" || !BASE58_HASH_RE.test(txHash)) throw new ValidationError(what, "no transaction hash");
  const status = obj(r["status"], `${what} status`);
  const failure = status["Failure"];
  return { txHash, failure: failure === undefined ? null : describeFailure(failure) };
}

function describeError(e: unknown): string {
  if (typeof e !== "object" || e === null) return "unknown error";
  const o = e as Record<string, unknown>;
  const parts = [o["name"], o["message"], typeof o["data"] === "string" ? o["data"] : undefined, causeName(o["cause"])];
  return sanitize(parts.filter((p): p is string => typeof p === "string").join(": "), 300) || "unknown error";
}

function causeName(c: unknown): string | undefined {
  return typeof c === "object" && c !== null && typeof (c as Record<string, unknown>)["name"] === "string"
    ? ((c as Record<string, unknown>)["name"] as string)
    : undefined;
}

function isMethodMissing(e: unknown): boolean {
  const s = typeof e === "string" ? e : JSON.stringify(e);
  return /MethodNotFound|method .{0,80}not found|MethodResolveError/i.test(s);
}

/** Pulls the contract's panic text out of a failed outcome so the log says why a call was refused. */
function describeFailure(f: unknown): string {
  const s = JSON.stringify(f);
  const m = /Smart contract panicked: ([^"\\]{1,200})/.exec(s);
  return sanitize(m?.[1] ?? s, 300);
}

function parsePermission(p: unknown): AccessKeyInfo["permission"] {
  if (p === "FullAccess") return "FullAccess";
  const fc = obj(obj(p, "permission")["FunctionCall"], "FunctionCall permission");
  const names = fc["method_names"];
  const receiver = fc["receiver_id"];
  if (!Array.isArray(names) || !names.every((m) => typeof m === "string") || typeof receiver !== "string") {
    throw new ValidationError("access key", "malformed function-call permission");
  }
  return { receiverId: receiver, methodNames: names as string[] };
}
