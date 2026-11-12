// Every signer's send goes through one recovery (signer.ts `TokenCaller.deliver`): an answer that failed after the broadcast is settled by looking the transaction
// up by its hash, never by signing again. Real signers over the model of the chain in faucet-chain.ts, which decodes the real signed bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, SignedTransaction } from "near-api-js";
import { DEFAULT_BOUNDS, RateWindow, type RefusedRate } from "../src/bounds.js";
import { reasoningHash } from "../src/reasoning.js";
import { NearRpc, RpcError, realClock, type Clock } from "../src/rpc.js";
import { ValidationError } from "../src/validate.js";
import { ChairSigner, PoolSigner, UnconfirmedSend, unconfirmedHash, type SettleOptions } from "../src/signer.js";
import { ChainSim, hashOf } from "./faucet-chain.js";

const secret = KeyPair.fromRandom("ed25519").toString();
const instant: SettleOptions = { sleep: () => Promise.resolve(), attempts: 4, backoffMs: 1 };
const decision = { epoch: 1, previousRateBps: 0, rate: RateWindow.around(0, DEFAULT_BOUNDS).pick(25), reasoning: "x", reasoningHash: reasoningHash("x"), chair: "rule-v1", kind: "rule" as const, remark: null };
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

test("the agent's resend has a deadline: a first send that hangs past it is looked up, not resent; before it, it is", async () => {
  for (const late of [true, false]) {
    const sim = new ChainSim();
    let now = 1_000_000;
    const clock: Clock = { now: () => now, after: realClock.after };
    let calls = 0;
    const rpc = {
      ...sim.rpc,
      accessKey: () => Promise.resolve({ nonce: sim.nonce, permission: { receiverId: "token.test", methodNames: ["set_policy"] } }),
      sendTx: (b64: string) => {
        if (++calls > 1) return sim.rpc.sendTx(b64);
        now += 15_000; // the first send hung until the client gave up
        return Promise.reject(new RpcError("rpc send_tx: TimeoutError", false, true));
      },
    } as unknown as NearRpc;
    const signer = new ChairSigner(secret, "chair.test", "token.test", rpc, { ...instant, clock });
    const resendBefore = late ? 1_000_000 + 10_000 : 1_000_000 + 40_000;
    const out = await signer.submit(decision, resendBefore).then((r) => r, (e: unknown) => e);
    if (late) {
      assert.ok(out instanceof UnconfirmedSend, "no resend past the deadline: the call may not land in the next meeting");
      assert.equal(calls, 1);
      assert.equal(sim.sends.length, 0);
    } else {
      assert.equal((out as { failure: unknown }).failure, null);
      assert.equal(calls, 2);
      assert.equal(sim.effects.length, 1);
    }
  }
});

test("the default recovery fits inside the agent's 15 s margin: 8 s at most, in pauses of 0.5 s, 1 s, 2 s", () => {
  const settle = (new ChairSigner(secret, "chair.test", "token.test", {} as NearRpc) as unknown as { settle: Required<SettleOptions> }).settle;
  assert.deepEqual([settle.attempts, settle.backoffMs, settle.recoverMs], [4, 500, 8_000]);
  assert.ok(settle.recoverMs < 15_000);
});

test("chair: accepted into a node's pool and the answer lost: looked up (unknown), the same bytes sent once more, still unconfirmed with its hash, and it lands once later", async () => {
  const sim = new ChainSim();
  sim.plan = () => "pool-lost";
  const s = chair(sim);
  const err = await s.signer.submit(decision).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof UnconfirmedSend);
  assert.equal(err.txHash, hashes(sim)[0]);
  assert.equal(sim.sends.length, 2);
  assert.equal(sim.sends[1], sim.sends[0]);
  assert.equal(sim.effects.length, 0, "it is waiting in the pool");
  sim.mine();
  assert.equal(sim.effects.length, 1, "and it lands once, as the one transaction signed");
  assert.deepEqual(await s.signer.lookUp(err.txHash), { txHash: err.txHash, failure: null, executed: true });
  assert.equal(s.signed(), 1);
});

test("an error after the broadcast that is not an RpcError (a malformed answer) is settled like a lost answer, and carries the hash when it cannot be", async () => {
  const malformed = (): ValidationError => new ValidationError("send_tx", "no transaction hash");
  // it executed, the answer was garbage: found by its hash
  const sim = new ChainSim();
  const sent = sim.rpc.sendTx;
  sim.rpc.sendTx = async (b64: string) => {
    await sent(b64);
    throw malformed();
  };
  const a = pool(sim);
  assert.deepEqual(await a.signer.stake(10n), { txHash: hashes(sim)[0], failure: null });
  assert.equal(sim.sends.length, 1);
  // it never reached the network: the same bytes go again
  const other = new ChainSim();
  let calls = 0;
  const reach = other.rpc.sendTx;
  other.rpc.sendTx = (b64: string) => (++calls === 1 ? Promise.reject(malformed()) : reach(b64));
  const b = pool(other);
  assert.equal((await b.signer.stake(10n)).failure, null);
  assert.equal(calls, 2);
  assert.equal(b.signed(), 1);
  // every answer is garbage and no node knows it: UnconfirmedSend, with the hash
  const dead = new ChainSim();
  dead.rpc.sendTx = () => Promise.reject(malformed());
  const c = pool(dead);
  const err = await c.signer.stake(10n).then(() => null, (e: unknown) => e);
  assert.ok(err instanceof UnconfirmedSend);
  assert.match(String(err.txHash), /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  assert.match(err.message, /no transaction hash/);
});
