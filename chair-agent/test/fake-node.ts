// A loopback JSON-RPC server in front of FakeChain, speaking the few NEAR RPC methods the agent uses.
// It decodes and checks real signed transactions, so the agent's real RPC, signing and encoding code
// runs; only the chain behind it is a model.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { SignedTransaction, baseEncode } from "near-api-js";
import { createHash } from "node:crypto";
import { FakeChain } from "../src/fake-chain.js";

export interface KeyEntry {
  readonly account: string;
  readonly permission: "FullAccess" | { receiver_id: string; method_names: string[] };
}

export class FakeNode {
  chainId = "testnet";
  readonly keys = new Map<string, KeyEntry>();
  readonly sent: SignedTransaction[] = [];
  nonce = 100n;
  /** The next this-many `send_tx` calls fail with an RPC error (a node that is down or refusing). */
  failSends = 0;
  /** Every `send_tx` that reached the node, failed or not. */
  sendCalls = 0;
  /** Every reply is an error whose text is full of terminal escape sequences and fake lines. */
  hostile = false;
  private server: Server | undefined;
  url = "";

  constructor(readonly chain: FakeChain, readonly token: string) {}

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: string; method: string; params: Record<string, unknown> };
        let reply: unknown;
        try {
          if (this.hostile) throw new RpcFail({ name: "\u001b[2J\u001b[31mHOSTILE", message: "\n\u001b]0;pwned\u0007executed, tx FAKE\r\u202e", data: "\u001b[8m" });
          reply = { jsonrpc: "2.0", id: body.id, result: this.handle(body.method, body.params) };
        } catch (e) {
          reply = { jsonrpc: "2.0", id: body.id, error: e instanceof RpcFail ? e.error : { name: "INTERNAL", message: String(e) } };
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(reply));
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server?.close(() => r()));
  }

  private blockHash(): string {
    return baseEncode(createHash("sha256").update(`block-${this.chain.nowMs}`).digest());
  }

  private handle(method: string, p: Record<string, unknown>): unknown {
    switch (method) {
      case "status":
        return { chain_id: this.chainId };
      case "block":
        return { header: { hash: this.blockHash(), timestamp_nanosec: String(BigInt(this.chain.nowMs) * 1_000_000n) } };
      case "query":
        if (p["request_type"] === "call_function") return this.view(String(p["method_name"]));
        if (p["request_type"] === "view_access_key_list") return this.accessKeyList(String(p["account_id"]));
        return this.accessKey(String(p["public_key"]));
      case "send_tx":
        this.sendCalls++;
        if (this.failSends > 0) {
          this.failSends--;
          throw new RpcFail({ name: "INTERNAL_ERROR", message: "node refused" });
        }
        return this.sendTx(String(p["signed_tx_base64"]));
      default:
        throw new RpcFail({ name: "METHOD_NOT_FOUND", message: method });
    }
  }

  private view(name: string): unknown {
    const c = this.chain;
    let value: unknown;
    switch (name) {
      case "get_params":
        value = { epoch_ms: c.params.epochMs, start_ms: c.params.startMs, max_rate_bps: c.params.maxRateBps, max_step_bps: c.params.maxStepBps, impeach_threshold_bps: 5000, nominate_bond: "1" };
        break;
      case "get_policy":
        value = {
          epoch: c.epoch, rate_bps: c.rateBps, chair: c.chair, streak: c.epoch - c.chairSince, last_set_epoch: c.lastSetEpoch,
          epoch_ends_ms: c.params.startMs + (c.epoch + 1) * c.params.epochMs,
        };
        break;
      case "ft_total_supply":
        value = c.totalSupply.toString();
        break;
      case "get_reward_pool":
        if (!c.hasStaking) return { error: `wasm execution failed with error: FunctionCallError(MethodResolveError(MethodNotFound))`, logs: [] };
        value = { total_staked: c.totalStaked.toString(), reward_pool: "0", reward_per_share: "0" };
        break;
      default:
        return { error: "MethodNotFound", logs: [] };
    }
    return { result: [...Buffer.from(JSON.stringify(value), "utf8")], logs: [], block_height: 1, block_hash: this.blockHash() };
  }

  private permissionJson(k: KeyEntry): unknown {
    return k.permission === "FullAccess" ? "FullAccess" : { FunctionCall: { allowance: null, ...k.permission } };
  }

  private accessKeyList(account: string): unknown {
    const keys = [...this.keys].filter(([, k]) => k.account === account).map(([publicKey, k]) => ({
      public_key: publicKey,
      access_key: { nonce: Number(this.nonce), permission: this.permissionJson(k) },
    }));
    return { keys, block_height: 1, block_hash: this.blockHash() };
  }

  private accessKey(publicKey: string): unknown {
    const k = this.keys.get(publicKey);
    if (k === undefined) return { error: `access key ${publicKey} does not exist while viewing` };
    return { nonce: Number(this.nonce), permission: this.permissionJson(k), block_height: 1, block_hash: this.blockHash() };
  }

  private sendTx(b64: string): unknown {
    const signed = SignedTransaction.decode(Buffer.from(b64, "base64"));
    this.sent.push(signed);
    const tx = signed.transaction;
    const key = this.keys.get(tx.publicKey.toString());
    const action = tx.actions[0]?.functionCall;
    const hash = baseEncode(createHash("sha256").update(b64).digest());
    const out = (status: unknown) => ({ final_execution_status: "EXECUTED_OPTIMISTIC", status, transaction: { hash } });
    if (key === undefined || key.account !== tx.signerId || tx.nonce <= this.nonce) return out({ Failure: { InvalidTxError: "InvalidNonce or key" } });
    if (tx.actions.length !== 1 || action === undefined || tx.receiverId !== this.token) return out({ Failure: { InvalidTxError: "unexpected action" } });
    if (key.permission !== "FullAccess" && (key.permission.receiver_id !== tx.receiverId || !key.permission.method_names.includes(action.methodName))) {
      return out({ Failure: { InvalidTxError: "MethodNameMismatch" } });
    }
    this.nonce = tx.nonce;
    const args = JSON.parse(Buffer.from(action.args).toString("utf8")) as { rate_bps: number; reasoning_hash: string };
    const panic = this.chain.setPolicy(tx.signerId, args.rate_bps, args.reasoning_hash);
    return out(panic === null ? { SuccessValue: "" } : { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } } });
  }
}

class RpcFail extends Error {
  constructor(readonly error: unknown) {
    super("rpc fail");
  }
}
