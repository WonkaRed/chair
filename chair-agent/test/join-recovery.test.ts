// "Join the Committee" and the overreach desk with the real signers over the model of the chain (faucet-chain.ts): one failed RPC answer, after the broadcast or
// in a read, must not turn a transaction that landed into "the desk could not confirm". Real signed bytes are sent; only the chain behind them is a model.
import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, SignedTransaction } from "near-api-js";
import type { PoolReader } from "../src/chain.js";
import { FakeChain } from "../src/fake-chain.js";
import { Join } from "../src/press-join.js";
import { Overreach } from "../src/press-overreach.js";
import { NearRpc, RpcError } from "../src/rpc.js";
import { ChairSigner, PoolSigner, type SettleOptions } from "../src/signer.js";
import type { PoolView } from "../src/types.js";
import { ChainSim, hashOf } from "./faucet-chain.js";

const secret = KeyPair.fromRandom("ed25519").toString();
const instant: SettleOptions = { sleep: () => Promise.resolve(), attempts: 4, backoffMs: 1 };
const SUPPLY = 10n ** 30n;
const STEP = SUPPLY / 50n;
const BASE_STAKED = 10n ** 29n;
const sentHash = (sim: ChainSim, i = 0): string => hashOf(SignedTransaction.decode(Buffer.from(sim.sends[i]!, "base64")));

/** The pool as the chain shows it: staked once a `stake` has executed in the model, and a read that can be made to fail. */
function rig(failReads: (n: number) => Error | null = () => null) {
  const chain = new FakeChain({ chair: "chair.test", totalSupply: SUPPLY, totalStaked: BASE_STAKED });
  chain.advanceEpochs(5, 10_000);
  const sim = new ChainSim();
  let reads = 0;
  const reader: PoolReader = {
    async pool(): Promise<PoolView> {
      const fail = failReads(++reads);
      if (fail !== null) throw fail;
      const staked = sim.effects.some((e) => e.step === ("stake" as never)) ? STEP : 0n;
      chain.totalStaked = BASE_STAKED + staked;
      return { snapshot: await chain.snapshot(), staked, liquid: 10n * STEP, unlockEpoch: 0, backing: null };
    },
  };
  const logs: string[] = [];
  const join = new Join({
    reader,
    sender: new PoolSigner(secret, "pool.test", "token.test", sim.rpc, instant),
    poolAccount: "pool.test",
    now: () => chain.nowMs,
    sleep: (ms) => (chain.advanceTo(chain.nowMs + ms), Promise.resolve()),
    log: (l) => logs.push(l),
  });
  return { chain, sim, join, logs, reads: () => reads };
}

const transient = (): Error => new RpcError("rpc query: TIMEOUT_ERROR", false, true);

test("the stake landed and send_tx answered with a transient error: the click still joins, with its hash, and the page has a last move", async () => {
  const r = rig();
  r.sim.plan = () => "land-lost";
  const res = await r.join.start("a");
  assert.equal(res.body["status"], "joined");
  assert.equal(res.body["tx_hash"], sentHash(r.sim));
  assert.notEqual((r.join.state().body as { last: unknown }).last, null);
  assert.equal(r.sim.sends.length, 1);
  assert.match(r.logs.join("\n"), /join tx /);
});

test("no node knows the transaction after the first answer failed: the same bytes go again and the click joins", async () => {
  const r = rig();
  r.sim.plan = (n) => (n === 1 ? "drop-lost" : "land");
  const res = await r.join.start("a");
  assert.equal(res.body["status"], "joined");
  assert.equal(r.sim.sends.length, 2);
  assert.equal(r.sim.sends[1], r.sim.sends[0]);
  assert.equal(r.sim.effects.length, 1);
});

test("a pool read that fails transiently while waiting for the stake to show is one missed try, not the end", async () => {
  const r = rig((n) => (n === 2 ? transient() : null)); // read 1 plans the move, read 2 is the first look for the stake
  const res = await r.join.start("a");
  assert.equal(res.body["status"], "joined");
  assert.equal(res.body["tx_hash"], sentHash(r.sim));
  assert.notEqual((r.join.state().body as { last: unknown }).last, null);
  assert.equal(r.reads(), 3);
});

test("a read that fails for good while waiting still ends it, and every read failing uses up the tries", async () => {
  const hard = rig((n) => (n === 2 ? new Error("rpc down") : null));
  assert.equal((await hard.join.start("a")).body["status"], "unconfirmed");
  const all = rig((n) => (n >= 2 ? transient() : null));
  const res = await all.join.start("a");
  assert.equal(res.body["status"], "unconfirmed");
  assert.equal(res.body["tx_hash"], sentHash(all.sim), "the transaction was sent and executed: its hash is in the reply");
  assert.equal(all.reads(), 1 + 4, "confirmTries looks, then it stops");
});

test("truly unconfirmed: the reply names the transaction and the log says why, in the message", async () => {
  const r = rig();
  r.sim.plan = () => "drop-lost";
  const res = await r.join.start("a");
  assert.equal(res.body["status"], "unconfirmed");
  assert.equal(res.body["tx_hash"], sentHash(r.sim));
  assert.equal(r.sim.sends.length, 2);
  assert.equal(r.sim.sends[1], r.sim.sends[0]);
  const line = r.logs.find((l) => l.includes("unconfirmed"));
  assert.ok(line !== undefined && /TimeoutError/.test(line) && line.includes(sentHash(r.sim)), `the log line: ${line}`);
});

test("the log carries the cleaned message of a node's error: no escape sequence reaches it", async () => {
  const r = rig((n) => (n === 1 ? new Error("\u001b[2J\u001b]0;pwned\u0007 rpc down") : null));
  assert.equal((await r.join.start("a")).status, 503);
  const line = r.logs.find((l) => l.includes("not sent"));
  assert.ok(line?.includes("rpc down"));
  assert.doesNotMatch(String(line), /[\u001b\u0007]/);
});

test("overreach: a call that never confirms is logged with its message and replies with its hash", async () => {
  const chain = new FakeChain({ chair: "chair.test", totalSupply: SUPPLY, totalStaked: BASE_STAKED });
  chain.advanceEpochs(5, 10_000);
  const sim = new ChainSim();
  sim.plan = () => "drop-lost";
  const rpc = { ...sim.rpc, accessKey: () => Promise.resolve({ nonce: sim.nonce, permission: { receiverId: "token.test", methodNames: ["set_policy"] } }) } as unknown as NearRpc;
  const logs: string[] = [];
  const svc = new Overreach({
    reader: chain,
    chairAccount: "chair.test",
    sender: new ChairSigner(secret, "chair.test", "token.test", rpc, instant),
    now: () => chain.nowMs,
    sleep: (ms) => (chain.advanceTo(chain.nowMs + ms), Promise.resolve()),
    log: (l) => logs.push(l),
  });
  const started = await svc.start(500, "a");
  let done = started.body;
  for (let i = 0; i < 50 && (done["status"] === "waiting" || done["status"] === "sending"); i++) {
    await new Promise((res) => setImmediate(res));
    done = svc.poll(String(started.body["id"])).body;
  }
  assert.equal(done["status"], "unconfirmed");
  assert.equal(done["tx_hash"], sentHash(sim));
  assert.equal(sim.sends.length, 2);
  assert.equal(sim.sends[1], sim.sends[0]);
  const line = logs.find((l) => l.includes("unconfirmed"));
  assert.ok(line !== undefined && /TimeoutError/.test(line), `the log line: ${line}`);
});
