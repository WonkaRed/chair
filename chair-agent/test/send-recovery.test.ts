// Every signer's send goes through one recovery (signer.ts `TokenCaller.deliver`): an answer that failed after the broadcast is settled by looking the transaction
// up by its hash, never by signing again. Real signers over the model of the chain in faucet-chain.ts, which decodes the real signed bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, SignedTransaction } from "near-api-js";
import { DEFAULT_BOUNDS, RateWindow, type RefusedRate } from "../src/bounds.js";
import { reasoningHash } from "../src/reasoning.js";
import { NearRpc, RpcError } from "../src/rpc.js";
import { ChairSigner, PoolSigner, UnconfirmedSend, unconfirmedHash, type SettleOptions } from "../src/signer.js";
import { ChainSim, hashOf } from "./faucet-chain.js";

const secret = KeyPair.fromRandom("ed25519").toString();
const instant: SettleOptions = { sleep: () => Promise.resolve(), attempts: 4, backoffMs: 1 };
const decision = { epoch: 1, previousRateBps: 0, rate: RateWindow.around(0, DEFAULT_BOUNDS).pick(25), reasoning: "x", reasoningHash: reasoningHash("x"), chair: "rule-v1", kind: "rule" as const };
const hashes = (sim: ChainSim): string[] => sim.sends.map((b64) => hashOf(SignedTransaction.decode(Buffer.from(b64, "base64"))));

/** The chair's key is function-call scoped to set_policy, which the simulated node answers as full access: say what the chain would. */
const scopedRpc = (sim: ChainSim, extra: Record<string, unknown> = {}): NearRpc =>
  ({ ...sim.rpc, accessKey: () => Promise.resolve({ nonce: sim.nonce, permission: { receiverId: "token.test", methodNames: ["set_policy"] } }), ...extra }) as unknown as NearRpc;

/** A signer that counts its signatures, so a test can say none was made twice. */
function counted<T extends { build: (...args: never[]) => Promise<unknown> }>(signer: T): { signer: T; signed: () => number } {
  let n = 0;
  const build = signer.build.bind(signer) as T["build"];
  signer.build = ((...args: never[]) => (n++, build(...args))) as T["build"];
  return { signer, signed: () => n };
}

const pool = (sim: ChainSim) => counted(new PoolSigner(secret, "pool.test", "token.test", sim.rpc, instant));
const chair = (sim: ChainSim) => counted(new ChairSigner(secret, "chair.test", "token.test", scopedRpc(sim), instant));

const sends = {
  pool: (s: ReturnType<typeof pool>) => s.signer.stake(10n),
  chair: (s: ReturnType<typeof chair>) => s.signer.submit(decision),
};

for (const kind of ["pool", "chair"] as const) {
  const make = (sim: ChainSim) => (kind === "pool" ? pool(sim) : chair(sim));
  const go = (s: ReturnType<typeof make>) => (kind === "pool" ? sends.pool(s as ReturnType<typeof pool>) : sends.chair(s as ReturnType<typeof chair>));

  test(`${kind}: the transaction executed and the answer was lost: found by its hash, reported executed, sent and signed once`, async () => {
    const sim = new ChainSim();
    sim.plan = () => "land-lost";
    const s = make(sim);
    const res = await go(s);
    assert.deepEqual(res, { txHash: hashes(sim)[0], failure: null });
    assert.equal(sim.sends.length, 1, "no second send: it was seen executed");
    assert.equal(sim.effects.length, 1);
    assert.equal(s.signed(), 1);
  });

  test(`${kind}: the transaction executed and failed on chain and the answer was lost: the contract's failure is reported, not hidden`, async () => {
    const sim = new ChainSim();
    sim.plan = () => "fail";
    const sent = sim.rpc.sendTx;
    sim.rpc.sendTx = async (b64: string) => {
      await sent(b64);
      throw new RpcError("rpc send_tx: TimeoutError", false, true);
    };
    const s = make(sim);
    const res = await go(s);
    assert.equal(res.failure, "Smart contract panicked: simulated");
    assert.equal(sim.sends.length, 1);
    assert.equal(s.signed(), 1);
  });

  test(`${kind}: no node knows the transaction: the identical bytes go again, once, and nothing is signed twice`, async () => {
    const sim = new ChainSim();
    sim.plan = (n) => (n === 1 ? "drop-lost" : "land");
    const s = make(sim);
    const res = await go(s);
    assert.equal(sim.sends.length, 2);
    assert.equal(sim.sends[1], sim.sends[0], "byte for byte the same transaction");
    assert.deepEqual(res, { txHash: hashes(sim)[0], failure: null });
    assert.equal(sim.effects.length, 1, "it landed once");
    assert.equal(s.signed(), 1);
  });

  test(`${kind}: never confirmed: UnconfirmedSend carries the hash of the one transaction signed, and the same bytes were sent twice at most`, async () => {
    const sim = new ChainSim();
    sim.plan = () => "drop-lost";
    const s = make(sim);
    const err = await go(s).then(() => null, (e: unknown) => e);
    assert.ok(err instanceof UnconfirmedSend);
    assert.equal(err.txHash, hashes(sim)[0]);
    assert.equal(unconfirmedHash(err), err.txHash);
    assert.match(err.message, /TimeoutError/);
    assert.ok(err.transient, "the cause's flags are kept");
    assert.equal(sim.sends.length, 2);
    assert.equal(new Set(sim.sends).size, 1);
    assert.equal(s.signed(), 1);
  });
}

test("a refusal the node gave for good (not transient) is not looked up or sent again, and still names the transaction", async () => {
  const sim = new ChainSim();
  let looked = 0;
  const rpc = { ...sim.rpc, sendTx: () => Promise.reject(new RpcError("rpc send_tx: HANDLER_ERROR: INVALID_TRANSACTION")), txOutcome: () => (looked++, Promise.resolve(null)) } as unknown as NearRpc;
  const signer = new PoolSigner(secret, "pool.test", "token.test", rpc, instant);
  const err = await signer.stake(10n).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof UnconfirmedSend);
  assert.equal(looked, 0);
  assert.match(String(unconfirmedHash(err)), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("the recovery is bounded: a node that never answers the look-up ends it in recoverMs, with the hash", async () => {
  const sim = new ChainSim();
  const rpc = { ...sim.rpc, sendTx: () => Promise.reject(new RpcError("rpc send_tx: TimeoutError", false, true)), txOutcome: () => new Promise<never>(() => undefined) } as unknown as NearRpc;
  const signer = new PoolSigner(secret, "pool.test", "token.test", rpc, { ...instant, recoverMs: 40 });
  const started = Date.now();
  const err = await signer.stake(10n).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof UnconfirmedSend);
  assert.ok(Date.now() - started < 2_000, "returned without waiting on the hung look-ups");
});

test("the overreach's refused call goes through the same recovery", async () => {
  const sim = new ChainSim();
  sim.plan = () => "land-lost";
  const s = chair(sim);
  const res = await s.signer.submitRefused(500 as RefusedRate, "r");
  assert.equal(res.txHash, hashes(sim)[0]);
  assert.equal(sim.sends.length, 1);
});
