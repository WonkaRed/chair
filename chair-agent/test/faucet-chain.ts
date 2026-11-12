// A model of the few chain behaviours the faucet's money safety rests on, behind the `NearRpc` methods `FaucetSigner` calls: a transaction can be
// accepted and executed with the answer lost, accepted and still waiting, or never reach the network; a transaction whose nonce is used is refused; and
// every executed effect is counted, so a test can say a step was paid once. Real signed bytes go in and are decoded, so the signer's real code runs.
// A transaction passes through the states the real chain has: in the pool (nobody can look it up: UNKNOWN_TRANSACTION), included (its nonce is used and
// it is known, its receipts have not run), executed. And the ordinary nodes forget (`gc`): they keep only about 31 hours, while the archival node,
// `sim.archival`, still answers. Each of the two clients can be made to not answer (`lookupsDown`, `archivalDown`).
import { createHash } from "node:crypto";
import { SignedTransaction, baseEncode } from "near-api-js";
import type { NearRpc } from "../src/rpc.js";
import { RpcError, type TxStatus } from "../src/rpc.js";

export const blockHash = baseEncode(createHash("sha256").update("block").digest());
export const hashOf = (signed: SignedTransaction): string => baseEncode(createHash("sha256").update(signed.transaction.encode()).digest());

/** What the network does with one `send_tx`. */
export type Send =
  | "land" //          executes, answers
  | "land-lost" //     executes, the answer never arrives
  | "pool-lost" //     accepted and waiting to execute, the answer never arrives
  | "drop-lost" //     never reaches the network
  | "fail" //          executes and fails, answers
  | "refuse-429" //    refused before it was accepted
  | "refuse-congested"; // answers INVALID_TRANSACTION (nearcore's ShardCongested shares that cause) while the transaction stays in the pool and lands on a later `mine()`

export interface Effect {
  readonly step: "transfer" | "storage_deposit" | "ft_transfer";
  readonly receiver: string;
  readonly hash: string;
}

export class ChainSim {
  /** The faucet key's nonce at the head. */
  nonce = 100n;
  /** What each send does, by its number from 1; a send with no plan lands. */
  plan: (n: number, hash: string) => Send = () => "land";
  /** Runs when a send reaches the network, before it executes. */
  onReach: (hash: string) => void = () => undefined;
  /** Runs at the start of every send, before the network looks at it, with its number from 1: a block can come between a lookup and this send. */
  beforeSend: (n: number) => void = () => undefined;
  /** Hashes whose bytes the network refuses as invalid (expired block hash). */
  readonly rejected = new Set<string>();
  /** The next this many hash lookups on the ordinary nodes fail as if the node did not answer. */
  lookupsDown = 0;
  /** The same for the archival node. */
  archivalDown = 0;
  /** While true the archival node never answers (and never fails either). */
  archivalHangs = false;
  /** How long every `send_tx` takes to answer, after the chain has done what it does with it. */
  latencyMs = 0;
  /** Every read the signer made of the chain (key, block, lookups), so a test can say a request did not touch it. */
  reads = 0;
  /** Every `send_tx` that was made, in order, as the base64 sent. */
  readonly sends: string[] = [];
  readonly effects: Effect[] = [];
  private readonly landed = new Map<string, string | null>();
  private readonly pool = new Map<string, SignedTransaction>();
  /** Included in a block: the nonce is used and the transaction is known, but its receipts have not run. `mine()` runs them on a later block. */
  private readonly included = new Map<string, SignedTransaction>();
  /** Executed transactions the ordinary nodes no longer know. */
  private readonly forgotten = new Set<string>();

  readonly rpc = {
    accessKey: () => (this.reads++, Promise.resolve({ nonce: this.nonce, permission: "FullAccess" as const })),
    finalBlock: () => (this.reads++, Promise.resolve({ hash: blockHash, height: 1, timestampMs: 0 })),
    sendTx: async (b64: string) => {
      try {
        return await this.sendTx(b64);
      } finally {
        if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
      }
    },
    txOutcome: (hash: string) => this.txOutcome(hash, false),
  } as unknown as NearRpc;

  /** The archival node: it answers for every transaction there ever was. */
  readonly archival = { txOutcome: (hash: string) => this.txOutcome(hash, true) } as unknown as NearRpc;

  /** A block takes in every transaction in the pool: its nonce is used and it is known, its receipts not yet run. */
  include(): void {
    for (const signed of [...this.pool.values()]) {
      try {
        this.take(signed);
      } catch {
        this.pool.delete(hashOf(signed)); // its nonce was used: it can never run
      }
    }
  }

  /** The next block: includes what waits, and runs the receipts of everything included. */
  mine(): void {
    this.include();
    for (const signed of [...this.included.values()]) this.run(signed, false);
  }

  /** The ordinary nodes drop everything that executed so far (their history is about 31 hours); the archival node keeps it. */
  gc(): void {
    for (const hash of this.landed.keys()) this.forgotten.add(hash);
  }

  count(step: Effect["step"], receiver: string): number {
    return this.effects.filter((e) => e.step === step && e.receiver === receiver).length;
  }

  private take(signed: SignedTransaction): void {
    const hash = hashOf(signed);
    this.pool.delete(hash);
    if (signed.transaction.nonce <= this.nonce) throw new RpcError("rpc send_tx: HANDLER_ERROR: Server error: INVALID_TRANSACTION", false, false);
    this.nonce = signed.transaction.nonce;
    this.included.set(hash, signed);
  }

  private run(signed: SignedTransaction, fails: boolean): string | null {
    const hash = hashOf(signed);
    this.included.delete(hash);
    const tx = signed.transaction;
    const action = tx.actions[0]!;
    const call = action.functionCall;
    const failure = fails ? "Smart contract panicked: simulated" : null;
    this.landed.set(hash, failure);
    if (failure === null) {
      const step = call === undefined ? "transfer" : (call.methodName as Effect["step"]);
      const receiver = call === undefined ? tx.receiverId : (JSON.parse(Buffer.from(call.args).toString("utf8")) as Record<string, string>)[step === "ft_transfer" ? "receiver_id" : "account_id"]!;
      this.effects.push({ step, receiver: receiver, hash });
    }
    return failure;
  }

  private sendTx(b64: string): Promise<{ txHash: string; failure: string | null }> {
    this.sends.push(b64);
    this.beforeSend(this.sends.length);
    const signed = SignedTransaction.decode(Buffer.from(b64, "base64"));
    const hash = hashOf(signed);
    try {
      if (this.landed.has(hash) && !this.forgotten.has(hash)) return Promise.resolve({ txHash: hash, failure: this.landed.get(hash) ?? null });
      if (this.landed.has(hash) || this.included.has(hash) || this.rejected.has(hash)) throw new RpcError("rpc send_tx: HANDLER_ERROR: Server error: INVALID_TRANSACTION", false, false);
      const mode = this.plan(this.sends.length, hash);
      if (mode === "refuse-congested") {
        this.pool.set(hash, signed);
        throw new RpcError("rpc send_tx: HANDLER_ERROR: Server error: INVALID_TRANSACTION", false, false);
      }
      if (this.pool.has(hash)) throw new RpcError("rpc send_tx: TIMEOUT_ERROR", false, true); // already waiting: sending it again changes nothing
      if (mode === "refuse-429") throw new RpcError("rpc send_tx: HTTP 429", false, true, true);
      if (mode === "drop-lost") throw new RpcError("rpc send_tx: TimeoutError", false, true);
      this.onReach(hash);
      if (mode === "pool-lost") {
        this.pool.set(hash, signed);
        throw new RpcError("rpc send_tx: TIMEOUT_ERROR", false, true);
      }
      this.include(); // the pool is first come, first served: what waited longer goes into a block before this
      this.take(signed);
      const failure = this.run(signed, mode === "fail");
      if (mode === "land-lost") throw new RpcError("rpc send_tx: TimeoutError", false, true);
      return Promise.resolve({ txHash: hash, failure });
    } catch (err) {
      return Promise.reject(err);
    }
  }

  /** What `tx` answers: null is UNKNOWN_TRANSACTION, for a hash in the pool or never seen, and for an executed one the ordinary nodes forgot. */
  private txOutcome(hash: string, archival: boolean): Promise<TxStatus | null> {
    this.reads++;
    if (archival && this.archivalHangs) return new Promise(() => undefined);
    if (archival ? this.archivalDown > 0 : this.lookupsDown > 0) {
      if (archival) this.archivalDown--;
      else this.lookupsDown--;
      return Promise.reject(new RpcError("rpc tx: HTTP 502", false, true));
    }
    if (this.landed.has(hash) && (archival || !this.forgotten.has(hash))) return Promise.resolve({ txHash: hash, failure: this.landed.get(hash) ?? null, executed: true });
    if (this.included.has(hash)) return Promise.resolve({ txHash: hash, failure: null, executed: false });
    return Promise.resolve(null);
  }
}
