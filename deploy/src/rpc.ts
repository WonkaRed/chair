// The read side: NEAR JSON-RPC over fetch, every response checked before it is used. Public RPCs answer HTTP 429
// under load, so a 429 (and a 5xx) is retried with a doubling wait. Signing and sending go through near-api-js
// (actor.ts); this file is all `verify` needs, so a stranger's read-only check pulls in no key handling.

import { assertTestnetChain, type TestnetAccount } from "./guard.ts";

export const DEFAULT_RPC = "https://test.rpc.fastnear.com";
const WAITS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000];
const TIMEOUT_MS = 20_000;

export class RpcError extends Error {
  /** The node's error `name` (e.g. UNKNOWN_ACCOUNT), when it sent one. */
  readonly kind: string | null;
  constructor(message: string, kind: string | null = null) {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
  }
}

export type Permission = "FullAccess" | { readonly receiverId: string; readonly methodNames: readonly string[]; readonly allowance: string | null };
export interface AccessKey {
  readonly publicKey: string;
  readonly permission: Permission;
}
export interface AccountInfo {
  /** Base58 SHA-256 of the contract code, `11111111111111111111111111111111` when there is none. */
  readonly codeHash: string;
  readonly amount: bigint;
  readonly storageUsage: number;
}

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;
type Sleep = (ms: number) => Promise<void>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!isObject(v)) throw new RpcError(`${what}: not an object`);
  return v;
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string") throw new RpcError(`${what}: not a string`);
  return v;
}

export class Rpc {
  private id = 0;
  readonly url: string;
  private readonly fetchImpl: Fetch;
  private readonly sleep: Sleep;
  private constructor(url: string, fetchImpl: Fetch, sleep: Sleep) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  /** The only way to get an `Rpc`: the node must report chain_id "testnet". */
  static async connect(url: string, fetchImpl: Fetch = fetch, sleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<Rpc> {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.hostname !== "127.0.0.1" && u.hostname !== "localhost") throw new Error("the RPC url must be https");
    const rpc = new Rpc(url, fetchImpl, sleep);
    assertTestnetChain(obj(await rpc.call("status", []), "status")["chain_id"]);
    return rpc;
  }

  async call(method: string, params: unknown): Promise<unknown> {
    const body = JSON.stringify({ jsonrpc: "2.0", id: `chair-deploy-${++this.id}`, method, params });
    for (let attempt = 0; ; attempt++) {
      let status: number;
      let text: string;
      try {
        const res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        status = res.status;
        text = await res.text();
      } catch {
        status = 0; // transport failure: retry like a 5xx
        text = "";
      }
      const wait = WAITS_MS[attempt];
      if ((status === 429 || status >= 500 || status === 0) && wait !== undefined) {
        await this.sleep(wait);
        continue;
      }
      if (status !== 200) throw new RpcError(`rpc ${method}: HTTP ${status}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new RpcError(`rpc ${method}: response is not JSON`);
      }
      const o = obj(parsed, `rpc ${method} response`);
      if (o["error"] !== undefined) {
        const e = obj(o["error"], `rpc ${method} error`);
        const cause = isObject(e["cause"]) && typeof e["cause"]["name"] === "string" ? e["cause"]["name"] : null;
        throw new RpcError(`rpc ${method}: ${String(e["name"])}: ${cause ?? String(e["message"])}`.slice(0, 300), cause);
      }
      return o["result"];
    }
  }

  async latestBlock(): Promise<{ height: number; timestampMs: number }> {
    const header = obj(obj(await this.call("block", { finality: "final" }), "block")["header"], "block header");
    const height = header["height"];
    const ns = str(header["timestamp_nanosec"], "timestamp_nanosec");
    if (typeof height !== "number") throw new RpcError("block header: bad height");
    return { height, timestampMs: Number(BigInt(ns) / 1_000_000n) };
  }

  /** The account, or null when it does not exist. */
  async account(id: TestnetAccount): Promise<AccountInfo | null> {
    try {
      const r = obj(await this.call("query", { request_type: "view_account", finality: "final", account_id: id }), "view_account");
      const storage = r["storage_usage"];
      if (typeof storage !== "number") throw new RpcError("view_account: bad storage_usage");
      return { codeHash: str(r["code_hash"], "code_hash"), amount: BigInt(str(r["amount"], "amount")), storageUsage: storage };
    } catch (e) {
      if (e instanceof RpcError && e.kind === "UNKNOWN_ACCOUNT") return null;
      throw e;
    }
  }

  async code(id: TestnetAccount): Promise<Buffer> {
    const r = obj(await this.call("query", { request_type: "view_code", finality: "final", account_id: id }), "view_code");
    return Buffer.from(str(r["code_base64"], "code_base64"), "base64");
  }

  async accessKeys(id: TestnetAccount): Promise<AccessKey[]> {
    const r = obj(await this.call("query", { request_type: "view_access_key_list", finality: "final", account_id: id }), "view_access_key_list");
    if (!Array.isArray(r["keys"])) throw new RpcError("view_access_key_list: no keys array");
    return r["keys"].map((k: unknown) => {
      const key = obj(k, "access key entry");
      return { publicKey: str(key["public_key"], "public_key"), permission: parsePermission(obj(key["access_key"], "access_key")["permission"]) };
    });
  }

  /** A view method of a contract, at the latest final block. */
  async view<T>(contract: TestnetAccount, method: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = obj(
      await this.call("query", { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") }),
      `view ${method}`,
    );
    const bytes = r["result"];
    if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b < 256)) throw new RpcError(`view ${method}: the node returned no value`);
    return JSON.parse(Buffer.from(bytes as number[]).toString("utf8")) as T;
  }

  /** Whether the node knows a transaction (a transaction rejected before inclusion has none). */
  async knowsTransaction(hash: string, signer: TestnetAccount): Promise<boolean> {
    try {
      await this.call("tx", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
      return true;
    } catch (e) {
      if (e instanceof RpcError && (e.kind === "UNKNOWN_TRANSACTION" || /UNKNOWN_TRANSACTION/.test(e.message))) return false;
      throw e;
    }
  }
}

function parsePermission(p: unknown): Permission {
  if (p === "FullAccess") return "FullAccess";
  const fc = obj(obj(p, "permission")["FunctionCall"], "FunctionCall permission");
  const names = fc["method_names"];
  if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) throw new RpcError("permission: bad method_names");
  const allowance = fc["allowance"];
  return {
    receiverId: str(fc["receiver_id"], "receiver_id"),
    methodNames: names as string[],
    allowance: allowance === null || allowance === undefined ? null : str(allowance, "allowance"),
  };
}
