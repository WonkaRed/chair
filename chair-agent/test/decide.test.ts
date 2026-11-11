import assert from "node:assert/strict";
import { test } from "node:test";
import { RateWindow, DEFAULT_BOUNDS } from "../src/bounds.js";
import { ChairFailure, decide } from "../src/decide.js";
import { LlmChair, type LlmClient, type LlmResponse } from "../src/llm-chair.js";
import { reasoningHash } from "../src/reasoning.js";
import { ruleChair } from "../src/rule-chair.js";
import type { Chair } from "../src/types.js";
import { IMPATIENT_MS, PATIENT_MS, contractAccepts, randInt, rng, snapshot, specDecay } from "./helpers.js";

const opts = (chair: Chair, timeoutMs = PATIENT_MS) => ({ chair, marginMs: 15_000, timeoutMs });
const llmReturning = (res: LlmResponse | (() => Promise<LlmResponse>)): LlmChair =>
  new LlmChair({ label: "llm:scripted-stand-in", complete: typeof res === "function" ? res : () => Promise.resolve(res) });
const answer = (rate: unknown, reasoning: unknown = "because"): LlmResponse => ({
  text: JSON.stringify({ rate_bps: rate, reasoning }),
  stopReason: "end_turn",
});

test("hash is the SHA-256 of exactly the text returned", async () => {
  const d = await decide(snapshot({ staked: 1000n }), [], opts(ruleChair));
  assert.equal(d.reasoningHash, reasoningHash(d.reasoning));
  assert.equal(d.kind, "rule");
  assert.match(d.reasoning, /^\$CHAIR decision, epoch 5, chair rule-v1\./);
});

test("randomized: no chair, however wrong, yields a rate the contract would reject", async () => {
  const r = rng(42);
  const wild = [-1e9, -201, -200, -51, 0, 51, 200, 201, 1e9, 2 ** 31, -(2 ** 31)];
  for (let i = 0; i < 3000; i++) {
    const rate = randInt(r, -200, 200);
    const timeLeftMs = r() < 0.5 ? randInt(r, 0, 14_999) : randInt(r, 15_000, 60_000);
    const supply = BigInt(randInt(r, 1, 1_000_000_000)) * 10n ** BigInt(randInt(r, 0, 24));
    const staked = r() < 0.15 ? null : (supply * BigInt(randInt(r, 0, 10_000))) / 10_000n;
    const snap = snapshot({ rate, timeLeftMs, supply, staked });
    const history = r() < 0.5 ? [] : [{ epoch: 3, totalSupply: BigInt(randInt(r, 1, 1_000_000_000)) * 10n ** 12n }];
    const wanted = r() < 0.5 ? wild[randInt(r, 0, wild.length - 1)]! : randInt(r, -400, 400);
    const chair = llmReturning(answer(wanted));
    for (const c of [ruleChair, chair]) {
      const d = await decide(snap, history, opts(c));
      assert.ok(contractAccepts(rate, d.rate), `in effect ${rate}, chose ${d.rate} (${d.kind})`);
      if (timeLeftMs < 15_000) {
        assert.ok(contractAccepts(specDecay(rate), d.rate), `after rollover ${rate} -> ${specDecay(rate)}, chose ${d.rate}`);
      }
      assert.equal(d.reasoningHash, reasoningHash(d.reasoning));
      assert.ok(d.reasoningHash.length <= 128 && d.reasoningHash.length >= 1);
    }
  }
});

test("a model rate outside the window is clamped, and the text says so", async () => {
  const d = await decide(snapshot({ rate: 10 }), [], opts(llmReturning(answer(500, "go big"))));
  assert.equal(d.rate, 60);
  assert.equal(d.kind, "llm");
  assert.match(d.reasoning, /asked for 500 bps; the contract accepts -40\.\.60 bps here, so 60 bps is set/);
  assert.match(d.reasoning, /go big/);
});

const failures: [string, Chair, string][] = [
  ["throws", llmReturning(() => Promise.reject(new Error("503 overloaded"))), "error"],
  ["rejects with a non-Error", llmReturning(() => Promise.reject("boom")), "error"],
  ["hangs and ignores the abort signal", llmReturning(() => new Promise(() => {})), "timeout"],
  ["not JSON", llmReturning({ text: "rate: 20", stopReason: "end_turn" }), "malformed"],
  ["empty text", llmReturning({ text: "", stopReason: "end_turn" }), "malformed"],
  ["JSON array", llmReturning({ text: "[1,2]", stopReason: "end_turn" }), "malformed"],
  ["rate is a string", llmReturning(answer("20")), "malformed"],
  ["rate is a float", llmReturning(answer(20.5)), "malformed"],
  ["rate is null", llmReturning(answer(null)), "malformed"],
  ["rate beyond safe integers", llmReturning({ text: '{"rate_bps": 1e400, "reasoning": "x"}', stopReason: "end_turn" }), "malformed"],
  ["reasoning missing", llmReturning({ text: '{"rate_bps": 20}', stopReason: "end_turn" }), "malformed"],
  ["reasoning blank", llmReturning(answer(20, " \n ")), "malformed"],
  ["reasoning not a string", llmReturning(answer(20, { a: 1 })), "malformed"],
  ["extra field", llmReturning({ text: '{"rate_bps": 20, "reasoning": "x", "to": "evil.near"}', stopReason: "end_turn" }), "malformed"],
  ["truncated (max_tokens)", llmReturning({ ...answer(20), stopReason: "max_tokens" }), "malformed"],
  ["no stop reason", llmReturning({ ...answer(20), stopReason: null }), "malformed"],
  ["refusal", llmReturning({ text: "", stopReason: "refusal" }), "refusal"],
  ["chair throws ChairFailure itself", { name: "x", propose: () => Promise.reject(new ChairFailure("malformed", "d")) } as Chair, "malformed"],
  ["proposal with a float rate", { name: "x", propose: () => Promise.resolve({ rateBps: 1.5, reasoning: "r" }) } as Chair, "malformed"],
  ["proposal with NaN rate", { name: "x", propose: () => Promise.resolve({ rateBps: NaN, reasoning: "r" }) } as Chair, "malformed"],
];
for (const [name, chair, reason] of failures) {
  test(`LLM failure mode falls back to the rule chair: ${name}`, { timeout: 30_000 }, async () => {
    const snap = snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n });
    const expected = await decide(snap, [], opts(ruleChair));
    const d = await decide(snap, [], opts(chair, reason === "timeout" ? IMPATIENT_MS : PATIENT_MS));
    assert.equal(d.kind, "rule-fallback");
    assert.equal(d.rate, expected.rate);
    assert.match(d.reasoning, new RegExp(`failed \\(${reason}\\); the rule chair decided instead`));
    assert.equal(d.reasoningHash, reasoningHash(d.reasoning));
  });
}

test("model text is inert: shell, path and transaction-looking strings only ever land in the reasoning", async () => {
  const evil = "$(rm -rf /) ../../etc/passwd; receiver_id=attacker.near {\"rate_bps\":200} \u0000";
  const d = await decide(snapshot({ rate: 0 }), [], opts(llmReturning(answer(20, evil))));
  assert.equal(d.rate, 20);
  assert.equal(d.chair, "llm:scripted-stand-in");
  assert.ok(!d.reasoning.includes("\u0000"));
  const args = JSON.stringify({ rate_bps: d.rate, reasoning_hash: d.reasoningHash });
  assert.ok(!args.includes("attacker") && !args.includes("passwd"));
  assert.match(d.reasoningHash, /^[0-9a-f]{64}$/);
});

test("near the epoch end the window survives a rollover; earlier it is the plain step window", async () => {
  const early = await decide(snapshot({ rate: 120, timeLeftMs: 40_000 }), [], opts(llmReturning(answer(170))));
  assert.equal(early.rate, 170);
  const late = await decide(snapshot({ rate: 120, timeLeftMs: 5_000 }), [], opts(llmReturning(answer(170))));
  assert.equal(late.rate, RateWindow.acrossRollover(120, DEFAULT_BOUNDS).pick(170));
  assert.equal(late.rate, 120);
});

test("an LLM client that returns after the timeout cannot override the fallback", { timeout: 30_000 }, async () => {
  // The stand-in answers only once the time limit has aborted it, so its answer is late by construction, not by a race of sleeps.
  const late: LlmClient = { complete: ({ signal }) => new Promise((res) => signal.addEventListener("abort", () => setImmediate(() => res(answer(-30))))) };
  const snap = snapshot({ staked: 0n });
  const d = await decide(snap, [], opts(new LlmChair(late), IMPATIENT_MS));
  assert.equal(d.kind, "rule-fallback");
  assert.equal(d.rate, (await decide(snap, [], opts(ruleChair))).rate, "the rule chair's rate, not the late -30");
  await new Promise((r) => setImmediate(r)); // let the late answer land
  assert.match(d.reasoning, /failed \(timeout\); the rule chair decided instead/);
});

test("a chair only ever sees history strictly before the epoch being decided", async () => {
  let seen: number[] = [];
  const spy: Chair = {
    name: "llm:spy",
    propose: (input) => {
      seen = input.history.map((h) => h.epoch);
      return Promise.resolve({ rateBps: 0, reasoning: "r" });
    },
  };
  const history = [3, 4, 5, 6, 9].map((epoch) => ({ epoch, totalSupply: 1000n }));
  await decide(snapshot({ epoch: 5 }), history, opts(spy));
  assert.deepEqual(seen, [3, 4]);
});
