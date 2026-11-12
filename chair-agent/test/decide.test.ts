import assert from "node:assert/strict";
import { test } from "node:test";
import { RateWindow, DEFAULT_BOUNDS } from "../src/bounds.js";
import { ChairFailure, decide } from "../src/decide.js";
import { LlmChair, type LlmClient, type LlmResponse } from "../src/llm-chair.js";
import { reasoningHash } from "../src/reasoning.js";
import { ruleChair } from "../src/rule-chair.js";
import { policyArgs } from "../src/signer.js";
import type { Chair, Proposal } from "../src/types.js";
import { IMPATIENT_MS, PATIENT_MS, contractAccepts, randInt, rng, snapshot, specDecay } from "./helpers.js";

const opts = (chair: Chair, timeoutMs = PATIENT_MS) => ({ chair, marginMs: 15_000, timeoutMs });
const llmReturning = (res: LlmResponse | (() => Promise<LlmResponse>)): LlmChair =>
  new LlmChair({ label: "llm:scripted-stand-in", complete: typeof res === "function" ? res : () => Promise.resolve(res) });
const answer = (rate: unknown, reason: unknown = "smaller_move"): LlmResponse => ({
  text: JSON.stringify({ rate_bps: rate, reason }),
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

test("a rate the window no longer holds is clamped, and the text says so (the window is read again after the model answered)", async () => {
  const stale: Chair = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: 500, reason: "larger_move" }) };
  const d = await decide(snapshot({ rate: 10 }), [], opts(stale));
  assert.equal(d.rate, 60);
  assert.equal(d.kind, "llm");
  assert.match(d.reasoning, /asked for 500 bps; the contract accepts -40\.\.60 bps here, so 60 bps is set/);
  assert.match(d.reasoning, /The Chair chose printing 5\.00% a day: the Chair prefers to move the rate by more than the formula does\./, "the choice line says what the Chair chose, the note what the contract set");
  assert.deepEqual(d.choice, { formulaBps: 60, chosenBps: 500, reason: "larger_move" });
});

test("a choice outside the band, or with a reason that does not fit, is a malformed answer: the rule chair decides", async () => {
  const snap = snapshot({ rate: 0 }); // nobody staked: the formula asks for +50, the band is 25..50
  for (const res of [answer(24), answer(51), answer(50, "supply_up"), answer(50, "steady"), answer(30, "stake_low"), answer(30, "stake_high")]) {
    const d = await decide(snap, [], opts(llmReturning(res), PATIENT_MS));
    assert.equal(d.kind, "rule-fallback", res.text);
    assert.equal(d.rate, 50);
    assert.deepEqual(d.choice, { formulaBps: 50, chosenBps: 50, reason: "fallback" });
  }
  const ok = await decide(snap, [], opts(llmReturning(answer(30, "smaller_move"))));
  assert.equal(ok.kind, "llm");
  assert.equal(ok.rate, 30);
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
  ["rate beyond safe integers", llmReturning({ text: '{"rate_bps": 1e400, "reason": "steady"}', stopReason: "end_turn" }), "malformed"],
  ["reason missing", llmReturning({ text: '{"rate_bps": 20}', stopReason: "end_turn" }), "malformed"],
  ["reason of the model's own", llmReturning(answer(20, "because I said so")), "malformed"],
  ["reason not a string", llmReturning(answer(20, { a: 1 })), "malformed"],
  ["free text where the reason goes", llmReturning({ text: '{"rate_bps": 20, "reasoning": "x"}', stopReason: "end_turn" }), "malformed"],
  ["extra field", llmReturning({ text: '{"rate_bps": 20, "reason": "steady", "to": "evil.near"}', stopReason: "end_turn" }), "malformed"],
  ["truncated (max_tokens)", llmReturning({ ...answer(20), stopReason: "max_tokens" }), "malformed"],
  ["no stop reason", llmReturning({ ...answer(20), stopReason: null }), "malformed"],
  ["refusal", llmReturning({ text: "", stopReason: "refusal" }), "refusal"],
  ["chair throws ChairFailure itself", { name: "x", propose: () => Promise.reject(new ChairFailure("malformed", "d")) } as Chair, "malformed"],
  ["proposal with a float rate", { name: "x", propose: () => Promise.resolve({ rateBps: 1.5, reason: "steady" }) } as Chair, "malformed"],
  ["proposal with NaN rate", { name: "x", propose: () => Promise.resolve({ rateBps: NaN, reason: "steady" }) } as Chair, "malformed"],
];
const why: Record<string, string> = { timeout: "did not answer in time", refusal: "declined to answer", malformed: "gave an answer the Chair could not use", error: "ran into an error" };
for (const [name, chair, reason] of failures) {
  test(`LLM failure mode falls back to the rule chair: ${name}`, { timeout: 30_000 }, async () => {
    const snap = snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n });
    const expected = await decide(snap, [], opts(ruleChair));
    const d = await decide(snap, [], opts(chair, reason === "timeout" ? IMPATIENT_MS : PATIENT_MS));
    assert.equal(d.kind, "rule-fallback");
    assert.equal(d.rate, expected.rate);
    assert.match(d.reasoning, new RegExp(`\\nThe AI chair \\(.+\\) ${why[reason]}, so the rule chair, the Chair's built-in fallback, decided this meeting\\.\\n`));
    assert.doesNotMatch(d.reasoning, /failed \(|decided instead|no comment/, "the old wording is gone from new minutes");
    assert.equal(d.reasoningHash, reasoningHash(d.reasoning));
  });
}

/** A stand-in chair that answers from a script, one entry per call, and counts its calls. */
const scripted = (...replies: (() => Promise<Proposal>)[]) => {
  const chair = {
    calls: 0,
    name: "llm:scripted-retry",
    propose: () => replies[Math.min(chair.calls++, replies.length - 1)]!(),
  };
  return chair;
};
const malformed = () => Promise.reject(new ChairFailure("malformed", "d"));
const good = (): Promise<Proposal> => Promise.resolve({ rateBps: 20, reason: "smaller_move" });

test("a malformed answer is asked for once more, and the second answer is the model's decision", async () => {
  const chair = scripted(malformed, good);
  const d = await decide(snapshot({ rate: 0 }), [], opts(chair, 30_000));
  assert.equal(chair.calls, 2);
  assert.equal(d.kind, "llm");
  assert.equal(d.chair, "llm:scripted-retry");
  assert.equal(d.rate, 20);
  assert.match(d.reasoning, /The formula suggested printing 0\.50% a day\. The Chair chose printing 0\.20% a day: the Chair prefers to move the rate by less/);
  assert.doesNotMatch(d.reasoning, /built-in fallback/);
});

test("malformed twice: two calls at most, then the rule chair with the usual wording", async () => {
  const chair = scripted(malformed, malformed, good);
  const d = await decide(snapshot({ rate: 0 }), [], opts(chair, 30_000));
  assert.equal(chair.calls, 2);
  assert.equal(d.kind, "rule-fallback");
  assert.match(d.reasoning, /\nThe AI chair \(.+\) gave an answer the Chair could not use, so the rule chair, the Chair's built-in fallback, decided this meeting\.\n/);
});

test("a timeout, an error and a refusal are not retried", async () => {
  const hang = scripted(() => new Promise(() => {}), good);
  assert.equal((await decide(snapshot(), [], opts(hang, IMPATIENT_MS))).kind, "rule-fallback");
  assert.equal(hang.calls, 1);
  const broken = scripted(() => Promise.reject(new Error("connection refused")), good);
  assert.equal((await decide(snapshot(), [], opts(broken, 30_000))).kind, "rule-fallback");
  assert.equal(broken.calls, 1);
  const declined = scripted(() => Promise.reject(new ChairFailure("refusal", "d")), good);
  assert.equal((await decide(snapshot(), [], opts(declined, 30_000))).kind, "rule-fallback");
  assert.equal(declined.calls, 1);
});

test("a malformed answer that arrives with under 10 s of the limit left is not retried", async () => {
  const chair = scripted(() => new Promise((_, reject) => setTimeout(() => reject(new ChairFailure("malformed", "d")), 100)), good);
  const d = await decide(snapshot(), [], opts(chair, 10_050)); // about 9.95 s remain when it fails
  assert.equal(chair.calls, 1);
  assert.equal(d.kind, "rule-fallback");
});

test("the retry gets the time that remains of the one limit, never a fresh one", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let aborted = false;
  let calls = 0;
  const chair: Chair = {
    name: "llm:scripted-retry",
    propose: (_input, signal) => {
      if (++calls === 1) {
        t.mock.timers.tick(5_000); // the first answer arrives after 5 s of the 30
        return Promise.reject(new ChairFailure("malformed", "d"));
      }
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        }),
      );
    },
  };
  const pending = decide(snapshot(), [], opts(chair, 30_000));
  while (calls < 2) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(24_999);
  assert.equal(aborted, false, "25 s remained, and 24.999 s have passed");
  t.mock.timers.tick(1);
  assert.equal(aborted, true, "the second attempt stops when the original 30 s are up");
  assert.equal((await pending).kind, "rule-fallback");
  assert.equal(calls, 2);
});

test("model text is inert: it cannot reach the minutes, whatever it holds", async () => {
  const evil = "$(rm -rf /) ../../etc/passwd; receiver_id=attacker.near {\"rate_bps\":200} \u0000";
  for (const res of [answer(40, evil), { text: JSON.stringify({ rate_bps: 40, reason: "smaller_move", reasoning: evil }), stopReason: "end_turn" }]) {
    const d = await decide(snapshot({ rate: 0 }), [], opts(llmReturning(res)));
    assert.equal(d.kind, "rule-fallback");
    assert.ok(!d.reasoning.includes("rm -rf") && !d.reasoning.includes("attacker"));
  }
  const d = await decide(snapshot({ rate: 0 }), [], opts(llmReturning(answer(40))));
  assert.equal(d.rate, 40);
  assert.equal(d.chair, "llm:scripted-stand-in");
  const args = policyArgs(d.rate, d.reasoning);
  assert.deepEqual(Object.keys(args), ["rate_bps", "reasoning_hash", "reasoning"]);
  assert.equal(args.rate_bps, 40);
  assert.equal(args.reasoning, d.reasoning);
  assert.match(d.reasoningHash, /^[0-9a-f]{64}$/);
});

test("near the epoch end the window survives a rollover; earlier it is the plain step window", async () => {
  const standIn = (rateBps: number): Chair => ({ name: "llm:stand-in", propose: () => Promise.resolve({ rateBps, reason: "larger_move" }) });
  const early = await decide(snapshot({ rate: 120, timeLeftMs: 40_000 }), [], opts(standIn(170)));
  assert.equal(early.rate, 170);
  const late = await decide(snapshot({ rate: 120, timeLeftMs: 5_000 }), [], opts(standIn(170)));
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
  assert.match(d.reasoning, /The AI chair \(.+\) did not answer in time, so the rule chair, the Chair's built-in fallback, decided this meeting\./);
});

test("a chair only ever sees history strictly before the epoch being decided", async () => {
  let seen: number[] = [];
  const spy: Chair = {
    name: "llm:spy",
    propose: (input) => {
      seen = input.history.map((h) => h.epoch);
      return Promise.resolve({ rateBps: 0, reason: "steady" });
    },
  };
  const history = [3, 4, 5, 6, 9].map((epoch) => ({ epoch, totalSupply: 1000n }));
  await decide(snapshot({ epoch: 5 }), history, opts(spy));
  assert.deepEqual(seen, [3, 4]);
});

// The test snapshot's epochs are 60 s, so a day is 1440 meetings.
const dayAgo = [{ epoch: 900, totalSupply: 1_000_000n }];

test("the decision records the formula's number, the Chair's and why, and the mandate and supply over the last day", async () => {
  const s = snapshot({ epoch: 1000, supply: 1_000_000n, staked: 400_000n, rate: 0 }); // 40.00% staked asks for +25
  const agreed = await decide(s, dayAgo, opts(llmReturning(answer(25, "stake_low"))));
  assert.deepEqual(agreed.mandate, { rateBps: 25, supplyChangeBps: 0, supplyChangeMeetings: 100 });
  assert.deepEqual(agreed.choice, { formulaBps: 25, chosenBps: 25, reason: "stake_low" });
  const own = await decide(s, dayAgo, opts(llmReturning(answer(40, "stake_low"))));
  assert.deepEqual(own.choice, { formulaBps: 25, chosenBps: 40, reason: "stake_low" });
  assert.equal(own.rate, 40);
  assert.match(own.reasoning, /\nThe formula suggested printing 0\.25% a day\. The Chair chose printing 0\.40% a day: fewer than half of all coins are staked, so it prints a little more\.\n/);
  assert.match(agreed.reasoning, /\nThe formula suggested printing 0\.25% a day\. The Chair agreed: fewer than half of all coins are staked\.\n/);
  const rule = await decide(s, dayAgo, opts(ruleChair));
  assert.deepEqual(rule.choice, { formulaBps: 25, chosenBps: 25, reason: "formula" });
  assert.match(rule.reasoning, /\nThe formula suggested printing 0\.25% a day\. The rule chair applied it\.\n/);
});

test("the mandate is the one the contract's step lets the rate reach: a far rate steered toward it is still the mandate's", async () => {
  const s = snapshot({ epoch: 1000, supply: 1_000_000n, staked: 100_000n, rate: 0 }); // 10.00% staked asks for +100, one step reaches +50
  const d = await decide(s, dayAgo, opts(ruleChair));
  assert.equal(d.rate, 50);
  assert.deepEqual(d.mandate, { rateBps: 100, supplyChangeBps: 0, supplyChangeMeetings: 100 });
});

test("supply over the last day is read over the meetings the history really covers, and none older than a day", async () => {
  const s = snapshot({ epoch: 2000, supply: 1_030_000n, staked: 400_000n });
  const young = await decide(s, [{ epoch: 1997, totalSupply: 1_000_000n }], opts(ruleChair));
  assert.deepEqual([young.mandate?.supplyChangeBps, young.mandate?.supplyChangeMeetings], [300, 3]);
  const edge = await decide(s, [{ epoch: 559, totalSupply: 1_000_000n }, { epoch: 560, totalSupply: 1_020_000n }], opts(ruleChair));
  assert.deepEqual([edge.mandate?.supplyChangeBps, edge.mandate?.supplyChangeMeetings], [98, 1440], "epoch 560 is exactly 1440 meetings back; epoch 559 is out of the day");
  for (const history of [[], [{ epoch: 559, totalSupply: 1_000n }]]) {
    const none = await decide(s, history, opts(ruleChair));
    assert.deepEqual([none.mandate?.supplyChangeBps, none.mandate?.supplyChangeMeetings], [null, null]);
  }
});
