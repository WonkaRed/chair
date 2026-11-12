import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tick } from "../src/agent.js";
import { decide } from "../src/decide.js";
import { nextWaitMs } from "../src/cli.js";
import { FakeChain } from "../src/fake-chain.js";
import { LlmChair } from "../src/llm-chair.js";
import { DecisionLog, findReasoning, verifyLog } from "../src/log.js";
import { ruleChair } from "../src/rule-chair.js";
import type { Chair } from "../src/types.js";
import { PATIENT_MS, randInt, rng, snapshot, tempDir } from "./helpers.js";

const CHAIR = "chair.test";

function setup(): { chain: FakeChain; log: DecisionLog; path: string; done: () => void } {
  const dir = tempDir("chair-agent");
  const path = join(dir, "decisions.jsonl");
  const chain = new FakeChain({ chair: CHAIR, totalSupply: 1_000_000n * 10n ** 24n, totalStaked: 100_000n * 10n ** 24n });
  return { chain, log: new DecisionLog(path, { token: "token.test", account: CHAIR }), path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const deps = (chain: FakeChain, log: DecisionLog, chair: Chair, marginMs = 15_000) => ({
  reader: chain, log, chairAccount: CHAIR, submitter: chain, decideOptions: { chair, marginMs, timeoutMs: PATIENT_MS },
});

test("60 epochs, rule chair and a wildly wrong LLM: the contract model never refuses a call", async () => {
  const r = rng(7);
  for (const kind of ["rule", "wild-llm"]) {
    const { chain, log, path, done } = setup();
    try {
      const wild = new LlmChair({ complete: () => Promise.resolve({ text: JSON.stringify({ rate_bps: randInt(r, -100_000, 100_000), reason: "steady" }), stopReason: "end_turn" }) });
      for (let e = 0; e < 60; e++) {
        // Decide at a random moment of the epoch, including the last seconds, then let the epoch end.
        chain.advanceTo(chain.params.startMs + e * chain.params.epochMs + randInt(r, 0, chain.params.epochMs - 1));
        const res = await tick(deps(chain, log, kind === "rule" ? ruleChair : wild));
        assert.equal(res.status, "executed", `${kind} epoch ${e}`);
        chain.totalStaked = (chain.totalSupply * BigInt(randInt(r, 0, 10_000))) / 10_000n;
      }
      assert.equal(chain.refusals.length, 0, chain.refusals.join("; "));
      assert.equal(chain.events.length, 60);
      assert.ok(verifyLog(path).ok);
      for (const ev of chain.events) assert.ok(findReasoning(path, ev.reasoningHash) !== null, `epoch ${ev.epoch}`);
    } finally {
      done();
    }
  }
});

test("a decision made in the last seconds is still valid when the call lands after the rollover", async () => {
  for (const rate of [-200, -120, -51, 0, 49, 120, 200]) {
    const { log, done } = setup();
    try {
      const c = new FakeChain({ chair: CHAIR, totalSupply: 10n ** 30n, totalStaked: 0n });
      c.rateBps = rate;
      c.advanceTo(c.params.startMs + c.params.epochMs - 3000);
      const wanted: Chair = { name: "w", propose: () => Promise.resolve({ rateBps: rate + (rate >= 0 ? 50 : -50), reason: "larger_move" }) };
      const decided = await tick({ ...deps(c, log, wanted), submitter: { submit: () => Promise.resolve({ txHash: "x", failure: null }) } });
      assert.equal(decided.status, "executed");
      if (decided.status !== "executed") return;
      c.advanceTo(c.params.startMs + c.params.epochMs + 500); // the boundary passes before the call lands
      const failure = c.setPolicy(CHAIR, decided.decision.rate, decided.decision.reasoningHash);
      assert.equal(failure, null, `rate ${rate} -> ${decided.decision.rate}`);
    } finally {
      done();
    }
  }
});

test("not the chair, or already decided this epoch: no decision, no log, no send", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    const notChair = await tick({ ...deps(chain, log, ruleChair), chairAccount: "other.test" });
    assert.equal(notChair.status, "not-chair");
    assert.equal((await tick(deps(chain, log, ruleChair))).status, "executed");
    assert.equal((await tick(deps(chain, log, ruleChair))).status, "already-set");
    assert.equal(chain.events.length, 1);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  } finally {
    done();
  }
});

test("a send that throws is logged as send_failed; a refusal is logged as rejected", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    const boom = await tick({ ...deps(chain, log, ruleChair), submitter: { submit: () => Promise.reject(new Error("socket hang up")) } });
    assert.equal(boom.status, "send-failed");
    const refused = await tick({ ...deps(chain, log, ruleChair), submitter: { submit: () => Promise.resolve({ txHash: "t", failure: "policy already set this epoch" }) } });
    assert.equal(refused.status, "rejected");
    const outcomes = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string; status?: string }).filter((x) => x.kind === "outcome");
    assert.deepEqual(outcomes.map((x) => x.status), ["send_failed", "rejected"]);
  } finally {
    done();
  }
});

test("dry run touches nothing: no submitter call and no log file", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    const res = await tick({ ...deps(chain, log, ruleChair), submitter: null });
    assert.equal(res.status, "dry-run");
    assert.equal(chain.events.length, 0);
    assert.throws(() => readFileSync(path), /ENOENT/);
  } finally {
    done();
  }
});

/** A chair that lets `during` run (advance the clock, say) before it answers, as a slow model would. */
const slowChair = (during: () => void, rateBps: number | "hang"): Chair => ({
  name: "llm:slow-fake",
  propose: (_input, signal) => {
    during();
    if (rateBps === "hang") return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return Promise.resolve({ rateBps, reason: "smaller_move" });
  },
});

const intoEpoch = (c: FakeChain, epoch: number, msBeforeEnd: number): void =>
  c.advanceTo(c.params.startMs + (epoch + 1) * c.params.epochMs - msBeforeEnd);

test("a slow model answer that crosses the rollover is clamped against the new epoch and logged under it", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.rateBps = 100;
    chain.advanceTo(chain.params.startMs + 3 * chain.params.epochMs + 1000);
    chain.rateBps = 100; // rate in effect in epoch 3, chair silent so far
    intoEpoch(chain, 3, 20_000);
    // 25 s later (inside the 30 s model allowance) the epoch has rolled and the silent rate decayed to 50.
    const chair = slowChair(() => chain.advanceTo(chain.nowMs + 25_000), 150);
    const res = await tick({ ...deps(chain, log, chair), decideOptions: { chair, marginMs: 15_000, timeoutMs: 30_000 } });
    assert.equal(res.status, "executed", res.status === "gave-up" ? res.reason : "");
    assert.equal(chain.refusals.length, 0, chain.refusals.join("; "));
    assert.equal(chain.epoch, 4);
    assert.deepEqual(chain.events.map((e) => [e.epoch, e.rateBps]), [[4, 100]], "150 asked for, clamped to the new window 0..100");
    if (res.status !== "executed") return;
    assert.equal(res.decision.epoch, 4);
    assert.equal(res.decision.previousRateBps, 50);
    assert.match(res.decision.reasoning, /epoch 4,/);
    assert.match(res.decision.reasoning, /rolled over while the Chair was deliberating/);
    const rec = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as { epoch: number; previous_rate_bps: number };
    assert.deepEqual([rec.epoch, rec.previous_rate_bps], [4, 50]);
  } finally {
    done();
  }
});

test("a model that times out after the rollover falls back to the rule chair, decided on the new epoch", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 3 * chain.params.epochMs + 1000);
    chain.rateBps = 100;
    intoEpoch(chain, 3, 2000);
    const chair = slowChair(() => chain.advanceTo(chain.nowMs + 5000), "hang");
    const res = await tick({ ...deps(chain, log, chair), decideOptions: { chair, marginMs: 15_000, timeoutMs: 50 } });
    assert.equal(res.status, "executed", res.status === "gave-up" ? res.reason : "");
    assert.equal(chain.refusals.length, 0, chain.refusals.join("; "));
    if (res.status !== "executed") return;
    assert.equal(res.decision.kind, "rule-fallback");
    assert.equal(res.decision.epoch, 4);
    assert.equal(res.decision.previousRateBps, 50, "decided from the decayed rate, not the stale 100");
    assert.deepEqual(chain.events.map((e) => e.epoch), [4]);
    assert.match(readFileSync(path, "utf8").split("\n")[0]!, /"epoch":4,/);
  } finally {
    done();
  }
});

test("if the chair role or the epoch's decision changed while the model thought, nothing is sent", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    const chair = slowChair(() => chain.setPolicy(CHAIR, 20, "a".repeat(64)) ?? undefined, 10);
    assert.equal((await tick(deps(chain, log, chair))).status, "already-set");
    assert.equal(chain.events.length, 1);
    assert.equal(chain.refusals.length, 0);
    assert.equal(existsSync(path), false, "no decision line for a decision that was never sent");
    const other = slowChair(() => { chain.chair = "someone.else"; }, 10);
    chain.advanceEpochs(1);
    assert.equal((await tick(deps(chain, log, other))).status, "not-chair");
  } finally {
    done();
  }
});

test("the decision is on disk before the transaction is sent", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    let seen = "";
    const submitter = {
      submit: (d: { reasoningHash: string }) => {
        const lines = readFileSync(path, "utf8").trim().split("\n");
        const last = JSON.parse(lines[lines.length - 1]!) as { kind: string; reasoning_hash: string };
        seen = `${lines.length} ${last.kind} ${last.reasoning_hash === d.reasoningHash}`;
        return Promise.resolve({ txHash: "t", failure: null });
      },
    };
    assert.equal((await tick({ ...deps(chain, log, ruleChair), submitter })).status, "executed");
    assert.equal(seen, "1 decision true", "at send time the log held exactly the decision being sent");
  } finally {
    done();
  }
});

test("a send that keeps failing: one decision for the epoch, re-sent up to three times, then given up", async () => {
  const { chain, log, path, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    let proposals = 0;
    const counting: Chair = { name: "llm:counting", propose: () => Promise.resolve({ rateBps: 10 + proposals++, reason: "smaller_move" }) };
    const hashes: string[] = [];
    const down = { submit: (d: { reasoningHash: string }) => { hashes.push(d.reasoningHash); return Promise.reject(new Error("socket hang up")); } };
    const statuses: string[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await tick({ ...deps(chain, log, counting), submitter: down })).status);
    assert.deepEqual(statuses, ["send-failed", "send-failed", "send-failed", "gave-up", "gave-up", "gave-up"]);
    assert.equal(proposals, 1);
    assert.equal(hashes.length, 3);
    assert.equal(new Set(hashes).size, 1);
    const kinds = readFileSync(path, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { kind: string }).kind);
    assert.deepEqual(kinds, ["decision", "outcome", "outcome", "outcome"]);
    // A restart (a new DecisionLog over the same file) does not reset the count.
    const again = new DecisionLog(path, { token: "token.test", account: CHAIR });
    assert.equal((await tick({ ...deps(chain, again, counting), submitter: down })).status, "gave-up");
    assert.equal(hashes.length, 3);
    // The next epoch gets a fresh decision.
    chain.advanceEpochs(1, 1000);
    assert.equal((await tick({ ...deps(chain, log, counting), submitter: down })).status, "send-failed");
    assert.equal(proposals, 2);
  } finally {
    done();
  }
});

test("after a failed send the same decision is re-sent and a success ends the epoch; a refusal is final for the epoch", async () => {
  const { chain, log, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    let proposals = 0;
    const chair: Chair = { name: "llm:c", propose: () => { proposals++; return Promise.resolve({ rateBps: 30, reason: "smaller_move" }); } };
    const flaky = (fails: number) => { let n = 0; return { submit: (d: Parameters<FakeChain["submit"]>[0]) => (n++ < fails ? Promise.reject(new Error("blip")) : chain.submit(d)) }; };
    const sub = flaky(1);
    assert.equal((await tick({ ...deps(chain, log, chair), submitter: sub })).status, "send-failed");
    assert.equal((await tick({ ...deps(chain, log, chair), submitter: sub })).status, "executed");
    assert.equal(proposals, 1);
    assert.deepEqual(chain.events.map((e) => e.rateBps), [30]);
    assert.equal((await tick({ ...deps(chain, log, chair), submitter: sub })).status, "already-set");

    chain.advanceEpochs(1, 1000);
    const refusing = { submit: () => Promise.resolve({ txHash: "t", failure: "rate step too large" }) };
    assert.equal((await tick({ ...deps(chain, log, chair), submitter: refusing })).status, "rejected");
    const after = await tick({ ...deps(chain, log, chair), submitter: refusing });
    assert.equal(after.status, "gave-up");
    assert.equal(proposals, 2);
  } finally {
    done();
  }
});

test("a logged decision whose rate no longer fits the window is not re-sent", async () => {
  const { chain, log, done } = setup();
  try {
    chain.advanceTo(chain.params.startMs + 1000);
    const chair: Chair = { name: "llm:c", propose: () => Promise.resolve({ rateBps: 50, reason: "larger_move" }) };
    const down = { submit: () => Promise.reject(new Error("blip")) };
    assert.equal((await tick({ ...deps(chain, log, chair), submitter: down })).status, "send-failed");
    // Late in the epoch the window must also hold across a rollover: from 0 that is -50..50, still fine; shrink it by moving the rate.
    chain.rateBps = -100;
    const res = await tick({ ...deps(chain, log, chair), submitter: chain });
    assert.equal(res.status, "gave-up");
    assert.match(res.status === "gave-up" ? res.reason : "", /no longer inside/);
  } finally {
    done();
  }
});

test("backoff after a failed send: 10 s, 20 s, then until the next epoch", () => {
  const snap = snapshot({ timeLeftMs: 40_000 });
  const failed = (n: number) => ({ status: "send-failed" as const, snapshot: snap, decision: {} as never, txHash: null, error: "e", failedSends: n });
  assert.deepEqual([1, 2].map((n) => nextWaitMs(failed(n))), [10_000, 20_000]);
  assert.equal(nextWaitMs(failed(3)), 41_000);
  assert.equal(nextWaitMs({ status: "gave-up", snapshot: snap, reason: "r" }), 41_000);
  assert.equal(nextWaitMs({ status: "already-set", snapshot: snapshot({ timeLeftMs: 5_000 }) }), 6_000);
  assert.equal(nextWaitMs(failed(2)), 20_000);
  assert.equal(nextWaitMs({ ...failed(2), snapshot: snapshot({ timeLeftMs: 4_000 }) }), 5_000, "never sleeps past the epoch end plus a second");
});

test("the agent reads the day's supply from its own log and logs the change over the meetings that log covers", async () => {
  const { chain, log, path, done } = setup();
  try {
    // An earlier decision, 60 meetings back, when supply stood 10% lower than the chain's now.
    const then = snapshot({ epoch: 40, supply: 900_000n * 10n ** 24n, staked: 90_000n * 10n ** 24n });
    log.recordDecision(await decide(then, [], { chair: ruleChair, marginMs: 0, timeoutMs: PATIENT_MS }), then);
    chain.advanceTo(chain.params.startMs + 100 * chain.params.epochMs + 1000);
    const res = await tick(deps(chain, log, new LlmChair({ label: "llm:greedy", complete: () => Promise.resolve({ text: JSON.stringify({ rate_bps: 40, reason: "smaller_move" }), stopReason: "end_turn" }) })));
    assert.equal(res.status, "executed");
    if (res.status !== "executed") return;
    assert.equal(res.decision.rate, 40, "the model's own rate, inside the band, stands: the contract, not the agent, holds the day's printing");
    assert.doesNotMatch(res.decision.reasoning, /budget/i);
    assert.equal(chain.refusals.length, 0);
    const logged = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["epoch"] === 100 && r["kind"] === "decision");
    assert.equal(logged.length, 1);
    assert.ok(!("budget" in logged[0]!));
    assert.equal(logged[0]!["supply_change_24h_bps"], 1111);
    assert.equal(logged[0]!["supply_change_24h_meetings"], 60);
    assert.equal(logged[0]!["rate_bps"], 40);
  } finally {
    done();
  }
});
