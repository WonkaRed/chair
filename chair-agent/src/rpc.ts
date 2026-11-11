import { sanitize } from "./text.js";
import { int, u128, ValidationError } from "./validate.js";

/** A failure talking to the node: transport, HTTP status, or a JSON-RPC error. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly methodMissing = false,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface AccessKeyInfo {
  readonly nonce: bigint;
  /** `"FullAccess"` or the function-call permission fields. */
  readonly permission: "FullAccess" | { readonly receiverId: string; readonly methodNames: readonly string[] };
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

const BASE58_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError(what, "not an object");
  return v as Record<string, unknown>;
}

/** The few JSON-RPC calls the chair needs, with every response checked before it is used. */
export class NearRpc {
  private id = 0;
  constructor(
    readonly url: string,
    private readonly timeoutMs = 15_000,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new RpcError("rpc url must be http or https");
  }

  private async call(method: string, params: unknown): Promise<Record<string, unknown>> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: `chair-${++this.id}`, method, params });
    let text: string;
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new RpcError(`rpc ${method}: HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      if (err instanceof RpcError) throw err;
      throw new RpcError(`rpc ${method}: ${err instanceof Error ? err.name : "request failed"}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new RpcError(`rpc ${method}: response is not JSON`);
    }
    const o = obj(parsed, `rpc ${method} response`);
    if (o["error"] !== undefined) {
      throw new RpcError(`rpc ${method}: ${describeError(o["error"])}`, isMethodMissing(o["error"]));
    }
    return obj(o["result"], `rpc ${method} result`);
  }

  async chainId(): Promise<string> {
    const r = await this.call("status", []);
    const id = r["chain_id"];
    if (typeof id !== "string" || id.length === 0 || id.length > 64) throw new ValidationError("status", "no chain_id");
    return id;
  }

  async finalBlock(): Promise<FinalBlock> {
    const r = await this.call("block", { finality: "final" });
    const h = obj(r["header"], "block header");
    const hash = h["hash"];
    if (typeof hash !== "string" || !BASE58_HASH_RE.test(hash)) throw new ValidationError("block", "bad hash");
    // timestamp_nanosec is a string because nanoseconds since 1970 exceed 2^53.
    const ns = h["timestamp_nanosec"];
    if (typeof ns !== "string" || !/^[1-9]\d{0,24}$/.test(ns)) throw new ValidationError("block", "bad timestamp_nanosec");
    return { hash, timestampMs: Number(BigInt(ns) / 1_000_000n) };
  }

  /** Calls a view method at `blockHash` and returns its JSON result. */
  async view(contractId: string, methodName: string, args: unknown, blockHash: string): Promise<unknown> {
    const r = await this.call("query", {
      request_type: "call_function",
      block_id: blockHash,
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

  async accessKey(accountId: string, publicKey: string): Promise<AccessKeyInfo> {
    const r = await this.call("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });
    if (typeof r["error"] === "string") throw new RpcError(`access key: ${sanitize(r["error"])}`);
    const n = r["nonce"];
    const nonce = typeof n === "number" ? BigInt(int(n, "nonce", 0)) : BigInt(u128(n, "nonce"));
    return { nonce, permission: parsePermission(r["permission"]) };
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

  /** Broadcasts a signed transaction and waits until it executed; returns the final status object. */
  async sendTx(signedBase64: string): Promise<{ txHash: string; failure: string | null }> {
    const r = await this.call("send_tx", { signed_tx_base64: signedBase64, wait_until: "EXECUTED_OPTIMISTIC" });
    const tx = obj(r["transaction"], "send_tx transaction");
    const txHash = tx["hash"];
    if (typeof txHash !== "string" || !BASE58_HASH_RE.test(txHash)) throw new ValidationError("send_tx", "no transaction hash");
    const status = obj(r["status"], "send_tx status");
    const failure = status["Failure"];
    return { txHash, failure: failure === undefined ? null : describeFailure(failure) };
  }
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
