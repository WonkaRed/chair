// The agent's send whose answer was lost (a transaction signed and broadcast, then an error): the next tick looks that transaction up by its hash before it signs
// anything new, records what it did exactly once, and the identical bytes are never sent again past the meeting's end (`RESEND_CUTOFF_MS`).
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import { RESEND_CUTOFF_MS, tick } from "../src/agent.js";
import { FakeChain } from "../src/fake-chain.js";
import { DecisionLog } from "../src/log.js";
import type { PressStore } from "../src/press-store.js";
import { NearRpc, RpcError } from "../src/rpc.js";
import { ruleChair } from "../src/rule-chair.js";
import { ChairSigner, UnconfirmedSend, type Submitter } from "../src/signer.js";
import { ChainSim } from "./faucet-chain.js";
import { PATIENT_MS, tempDir } from "./helpers.js";

const CHAIR = "chair.test";
const secret = KeyPair.fromRandom("ed25519").toString();

function setup() {
  const dir = tempDir("agent-recovery");
  const path = join(dir, "decisions.jsonl");
  const chain = new FakeChain({ chair: CHAIR, totalSupply: 1_000_000n * 10n ** 24n, totalStaked: 100_000n * 10n ** 24n });
  chain.advanceTo(chain.params.startMs + 1000);
  const log = new DecisionLog(path, { token: "token.test", account: CHAIR });
  const entered: { epoch: number; tx: string }[] = [];
  const press = { pending: () => [], decisionStarted: () => undefined, decisionDone: () => undefined, markEntered: (_text: string, epoch: number, tx: string) => void entered.push({ epoch, tx }) } as unknown as PressStore;
  const deps = (submitter: Submitter) => ({ reader: chain, log, chairAccount: CHAIR, submitter, press, decideOptions: { chair: ruleChair, marginMs: 15_000, timeoutMs: PATIENT_MS } });
  const records = () => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { chain, log, deps, entered, records, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const lost = (hash: string): UnconfirmedSend => new UnconfirmedSend(new RpcError("rpc send_tx: TimeoutError", false, true), hash);

test("a lost answer whose transaction executed: the next tick records it as executed with its hash, once, and signs nothing new", async () => {
  const w = setup();
  try {
    let submits = 0;
    let looked = 0;
    const submitter: Submitter = {
      submit: () => (submits++, Promise.reject(lost("HASH1"))),
      lookUp: (hash) => (looked++, Promise.resolve({ txHash: hash, failure: null, executed: true })),
    };
    const first = await tick(w.deps(submitter));
    assert.equal(first.status, "send-failed");
    assert.equal(first.status === "send-failed" ? first.txHash : null, "HASH1", "the failed send names its transaction");
    const second = await tick(w.deps(submitter));
    assert.equal(second.status, "executed");
    assert.equal(second.status === "executed" ? second.txHash : null, "HASH1");
    assert.equal(submits, 1, "nothing was signed or sent again");
    assert.deepEqual(w.records().slice(1).map((r) => [r["status"], r["tx_hash"]]), [["send_failed", "HASH1"], ["executed", "HASH1"]]);
    assert.deepEqual(w.entered, [{ epoch: w.chain.epoch, tx: "HASH1" }], "the questions are entered once");
    assert.equal((await tick(w.deps(submitter))).status, "gave-up", "a settled epoch is not sent or looked up again");
    assert.equal(looked, 1);
    assert.equal(w.entered.length, 1);
  } finally {
    w.done();
  }
});

test("the chain already shows the epoch set when the next tick comes: the lost send is still recorded as executed", async () => {
  const w = setup();
  try {
    const submitter: Submitter = { submit: () => Promise.reject(lost("HASH2")), lookUp: (hash) => Promise.resolve({ txHash: hash, failure: null, executed: true }) };
    assert.equal((await tick(w.deps(submitter))).status, "send-failed");
    w.chain.setPolicy(CHAIR, 10, "0".repeat(64)); // what the lost call did
    assert.equal((await tick(w.deps(submitter))).status, "executed");
    assert.equal(w.entered.length, 1);
  } finally {
    w.done();
  }
});

test("a lost send still on its way, or a look-up that fails, waits: nothing new is signed, and the attempt counts", async () => {
  const w = setup();
  try {
    let submits = 0;
    let answer: "included" | "down" = "included";
    const submitter: Submitter = {
      submit: () => (submits++, Promise.reject(lost("HASH3"))),
      lookUp: (hash) => (answer === "included" ? Promise.resolve({ txHash: hash, failure: null, executed: false }) : Promise.reject(new RpcError("rpc tx: HTTP 502", false, true))),
    };
    assert.equal((await tick(w.deps(submitter))).status, "send-failed");
    assert.equal((await tick(w.deps(submitter))).status, "send-failed");
    answer = "down";
    assert.equal((await tick(w.deps(submitter))).status, "send-failed");
    assert.equal(submits, 1);
    assert.equal((await tick(w.deps(submitter))).status, "gave-up", "three attempts, bounded");
  } finally {
    w.done();
  }
});

test("the send is given the meeting's end in local time, less the cutoff", async () => {
  const w = setup();
  try {
    let given: number | undefined;
    const submitter: Submitter = { submit: (_d, resendBefore) => ((given = resendBefore), Promise.resolve({ txHash: "T", failure: null })) };
    const before = Date.now();
    await tick(w.deps(submitter));
    const left = (await w.chain.snapshot()).policy.epochEndsMs - w.chain.nowMs;
    assert.ok(given !== undefined && given >= before + left - RESEND_CUTOFF_MS && given <= Date.now() + left - RESEND_CUTOFF_MS, `${given}`);
  } finally {
    w.done();
  }
});

/** The real signer over the model of the chain, whose answer to a send is lost and whose look-up does not answer at first. */
function chairOver(sim: ChainSim): { signer: ChairSigner; signed: () => number } {
  const rpc = { ...sim.rpc, accessKey: () => Promise.resolve({ nonce: sim.nonce, permission: { receiverId: "token.test", methodNames: ["set_policy"] } }) } as unknown as NearRpc;
  const signer = new ChairSigner(secret, CHAIR, "token.test", rpc, { sleep: () => Promise.resolve(), attempts: 4, backoffMs: 1 });
  let n = 0;
  const build = signer.build.bind(signer);
  signer.build = (...args) => (n++, build(...args));
  return { signer, signed: () => n };
}

test("real signer: the transaction landed, every look-up failed in the tick that sent it: the next tick ends with ONE signature and an executed outcome", async () => {
  const w = setup();
  try {
    const sim = new ChainSim();
    sim.plan = () => "land-lost";
    sim.lookupsDown = 99;
    const { signer, signed } = chairOver(sim);
    const first = await tick(w.deps(signer));
    assert.equal(first.status, "send-failed");
    sim.lookupsDown = 0;
    const second = await tick(w.deps(signer));
    assert.equal(second.status, "executed");
    assert.equal(signed(), 1);
    assert.equal(sim.sends.length, 1, "the bytes were not even sent again");
    assert.equal(sim.effects.length, 1);
    const [, failed, executed] = w.records();
    assert.equal(executed?.["tx_hash"], failed?.["tx_hash"]);
    assert.notEqual(executed?.["tx_hash"], null);
  } finally {
    w.done();
  }
});

test("real signer: the lost transaction never existed: the retry signs as it always did, and it lands once", async () => {
  const w = setup();
  try {
    const sim = new ChainSim();
    sim.plan = (n) => (n <= 2 ? "drop-lost" : "land");
    const { signer, signed } = chairOver(sim);
    assert.equal((await tick(w.deps(signer))).status, "send-failed");
    assert.equal(sim.sends.length, 2, "the first send and its one resend of the same bytes");
    assert.equal((await tick(w.deps(signer))).status, "executed");
    assert.equal(signed(), 2, "one signature per attempt, a new one only because no node knew the first");
    assert.equal(sim.effects.length, 1);
  } finally {
    w.done();
  }
});
