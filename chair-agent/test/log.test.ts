import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { decide } from "../src/decide.js";
import { DecisionLog, findReasoning, verifyLog } from "../src/log.js";
import { reasoningHash } from "../src/reasoning.js";
import { ruleChair } from "../src/rule-chair.js";
import { snapshot, tempDir } from "./helpers.js";

const SCOPE = { token: "token.test", account: "chair.test" };

async function withLog<T>(fn: (path: string, log: DecisionLog) => Promise<T>): Promise<T> {
  const dir = tempDir("chair-log");
  try {
    const path = join(dir, "nested", "decisions.jsonl");
    return await fn(path, new DecisionLog(path, SCOPE));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const decideAt = (epoch: number, supply: bigint) => {
  const s = snapshot({ epoch, supply, staked: supply / 10n });
  return decide(s, [], { chair: ruleChair, marginMs: 0, timeoutMs: 100 }).then((d) => ({ d, s }));
};

test("every logged hash matches its logged text, and the text is findable by hash", async () => {
  await withLog(async (path, log) => {
    for (let e = 1; e <= 5; e++) {
      const { d, s } = await decideAt(e, 1_000_000n + BigInt(e));
      log.recordDecision(d, s);
      log.recordOutcome(d, "executed", "tx", null);
      assert.equal(findReasoning(path, d.reasoningHash), d.reasoning);
    }
    const v = verifyLog(path);
    assert.deepEqual({ ok: v.ok, decisions: v.decisions, mismatches: v.mismatches.length }, { ok: true, decisions: 5, mismatches: 0 });
    assert.deepEqual(log.history(99).map((h) => h.epoch), [1, 2, 3, 4, 5]);
  });
});

test("the decision is on disk before any outcome, and a tampered text is caught", async () => {
  await withLog(async (path, log) => {
    const { d, s } = await decideAt(2, 5_000_000n);
    log.recordDecision(d, s);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
    log.recordOutcome(d, "rejected", null, "policy already set this epoch");
    assert.equal(verifyLog(path).ok, true);

    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, lines[0]!.replace("decision 1", "decision 9").replace("Rate in effect", "Rate was in effect") + "\n" + lines[1] + "\n");
    const v = verifyLog(path);
    assert.equal(v.ok, false);
    assert.equal(v.mismatches.length, 1);
    assert.equal(findReasoning(path, d.reasoningHash), null);
  });
});

test("history is scoped to this token and account and to epochs strictly before the one asked about", async () => {
  await withLog(async (path, log) => {
    for (const e of [1, 2, 3]) {
      const { d, s } = await decideAt(e, 1_000_000n * BigInt(e));
      log.recordDecision(d, s);
    }
    const other = new DecisionLog(path, { token: "token.test", account: "someone.else" });
    const { d, s } = await decideAt(2, 999n);
    other.recordDecision(d, s);
    assert.deepEqual(log.history(3).map((h) => h.epoch), [1, 2]);
    assert.deepEqual(log.history(1), []);
    assert.deepEqual(log.history(3).map((h) => h.totalSupply), [1_000_000n, 2_000_000n], "the other account's supply never enters");
    assert.deepEqual(other.history(99).map((h) => h.totalSupply), [999n]);
    assert.equal(verifyLog(path).ok, false, "a log shared by two accounts fails verification");
    assert.equal(verifyLog(path).scopes.length, 2);
  });
});

test("epochState counts failed sends of the epoch's decision and knows when the contract ruled", async () => {
  await withLog(async (_path, log) => {
    const { d, s } = await decideAt(4, 5_000n);
    assert.deepEqual(log.epochState(4), { decision: null, failedSends: 0, settled: false });
    log.recordDecision(d, s);
    log.recordOutcome(d, "send_failed", null, "boom");
    log.recordOutcome(d, "send_failed", null, "boom");
    const mid = log.epochState(4);
    assert.deepEqual([mid.decision?.reasoning_hash, mid.failedSends, mid.settled], [d.reasoningHash, 2, false]);
    log.recordOutcome(d, "rejected", null, "rate step too large");
    assert.equal(log.epochState(4).settled, true);
    assert.equal(log.epochState(5).decision, null);
  });
});

test("unreadable lines are reported, not fatal; a missing log is empty history", async () => {
  await withLog(async (path, log) => {
    assert.deepEqual(log.history(99), []);
    assert.equal(verifyLog(path).ok, true);
    const { d, s } = await decideAt(1, 1_000n);
    log.recordDecision(d, s);
    appendFileSync(path, "not json\n{\"v\":2}\n");
    const v = verifyLog(path);
    assert.deepEqual(v.badLines, [2, 3]);
    assert.equal(v.ok, false);
    assert.equal(log.history(99).length, 1);
  });
});

test("the mandate and the day's supply change are logged per decision; old lines without them still read", async () => {
  await withLog(async (path, log) => {
    const history = [{ epoch: 3, totalSupply: 1_000_000n }];
    const s = snapshot({ epoch: 9, supply: 1_050_000n, staked: 105_000n });
    const d = await decide(s, history, { chair: ruleChair, marginMs: 0, timeoutMs: 100 });
    log.recordDecision(d, s);
    const rec = JSON.parse(readFileSync(path, "utf8").trim()) as Record<string, unknown>;
    assert.equal(rec["mandate_rate_bps"], 100);
    assert.equal(rec["supply_change_24h_bps"], 500);
    assert.equal(rec["supply_change_24h_meetings"], 6);
    assert.ok(!("budget" in rec));
    assert.equal(rec["followed"], "mandate");
    // A decision from before the mandate, and one with no history to tell the day's change from.
    const { mandate: _dropped, ...old } = d;
    log.recordDecision({ ...old, epoch: 10, reasoning: "old", reasoningHash: reasoningHash("old") }, { ...s, policy: { ...s.policy, epoch: 10 } });
    const young = await decide(s, [], { chair: ruleChair, marginMs: 0, timeoutMs: 100 });
    log.recordDecision({ ...young, epoch: 11 }, { ...s, policy: { ...s.policy, epoch: 11 } });
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.ok(!("mandate_rate_bps" in lines[1]!) && !("followed" in lines[1]!), "an old line has none of the fields");
    assert.equal(lines[2]!["supply_change_24h_bps"], null);
    assert.equal(lines[2]!["supply_change_24h_meetings"], null);
    assert.equal(verifyLog(path).ok, true);
    assert.deepEqual(log.history(99).map((h) => h.epoch), [9, 10, 11]);
    assert.equal(log.epochState(10).decision?.mandate_rate_bps, undefined);
  });
});
