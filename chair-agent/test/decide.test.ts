import assert from "node:assert/strict";
import { test } from "node:test";
import { RateWindow, DEFAULT_BOUNDS } from "../src/bounds.js";
import { ChairFailure, decide, finalize, propose } from "../src/decide.js";
import { LlmChair, type LlmClient, type LlmResponse } from "../src/llm-chair.js";
import { reasoningHash } from "../src/reasoning.js";
import { MODEL_REASONS } from "../src/choice.js";
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
  const chair: Chair = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: 100, reason: "smaller_move" }) };
  const asked = await propose(snapshot({ rate: 60, timeLeftMs: 60_000 }), [], opts(chair)); // formula 110, band 85..110: a fair choice then
  const d = finalize(snapshot({ rate: 60, timeLeftMs: 5_000 }), [], asked, { marginMs: 15_000 }); // the call may now land after the rollover: the contract takes 10..60
  assert.equal(d.rate, 60);
  assert.equal(d.kind, "llm");
  assert.match(d.reasoning, /\nThe contract is sure to accept 10\.\.60 bps here, so 60 bps is set instead\. The Chair defers\./);
  assert.match(d.reasoning, /The Chair asked for printing 1\.00% a day: the Chair prefers to move the rate by less than the formula does\./, "the choice line says what the Chair asked for, the note what the contract set");
  assert.doesNotMatch(d.reasoning, /The Chair chose|The Chair agreed/, "nothing says a rate was chosen that was not set");
  assert.deepEqual(d.choice, { formulaBps: 110, chosenBps: 100, reason: "smaller_move" });
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
const good = (): Promise<Proposal> => Promise.resolve({ rateBps: 30, reason: "smaller_move" });

test("a malformed answer is asked for once more, and the second answer is the model's decision", async () => {
  const chair = scripted(malformed, good);
  const d = await decide(snapshot({ rate: 0 }), [], opts(chair, 30_000));
  assert.equal(chair.calls, 2);
  assert.equal(d.kind, "llm");
  assert.equal(d.chair, "llm:scripted-retry");
  assert.equal(d.rate, 30);
  assert.match(d.reasoning, /The formula suggested printing 0\.50% a day\. The Chair chose printing 0\.30% a day: the Chair prefers to move the rate by less/);
  assert.doesNotMatch(d.reasoning, /built-in fallback/);
});

test("malformed twice: two calls at most, then the rule chair with the usual wording", async () => {
  const chair = scripted(malformed, malformed, good);
  const d = await decide(snapshot({ rate: 0 }), [], opts(chair, 30_000));
  assert.equal(chair.calls, 2);
  assert.equal(d.kind, "rule-fallback");
  assert.match(d.reasoning, /\nThe AI chair \(.+\) gave an answer the Chair could not use, so the rule chair, the Chair's built-in fallback, decided this meeting\.\n/);
});

test("the retry is told which of our checks the first answer failed, in our words, and the first call is not", async () => {
  const prompts: string[] = [];
  const replies = ['{"rate_bps": 30, "reason": "SENTINEL-the-model-wrote-this"}', '{"rate_bps": 30, "reason": "smaller_move"}'];
  const chair = new LlmChair({ label: "llm:stand-in", complete: (req) => (req.schema === undefined ? (prompts.push(req.user), Promise.resolve({ text: replies[prompts.length - 1]!, stopReason: "end_turn" })) : Promise.resolve({ text: '{"remark": ""}', stopReason: "end_turn" })) });
  const d = await decide(snapshot({ rate: 0 }), [], opts(chair, 30_000));
  assert.equal(d.kind, "llm");
  assert.equal(prompts.length, 2);
  assert.doesNotMatch(prompts[0]!, /previous_answer_fault/);
  assert.match(prompts[1]!, /"previous_answer_fault":"Your last answer did not have exactly the keys rate_bps/);
  assert.doesNotMatch(prompts[1]!, /SENTINEL/, "nothing the model wrote goes back into a prompt");
  assert.equal(prompts[1]!.replace(/,"previous_answer_fault":"[^"]*"/, ""), prompts[0]!, "the retry differs by that one line and nothing else");
});

test("with no rate near the formula that the call is sure to be taken, the model is not asked; the rule chair decides and the minutes say what is true", async () => {
  let asked = 0;
  const chair = new LlmChair({ label: "llm:stand-in", complete: () => (asked++, Promise.resolve({ text: '{"rate_bps": 60, "reason": "steady"}', stopReason: "end_turn" })) });
  const snap = snapshot({ rate: 60, staked: 0n, timeLeftMs: 20_000 }); // formula 110; the window across a rollover stops at 60
  const d = await decide(snap, [], opts(chair));
  assert.equal(asked, 0);
  assert.equal(d.kind, "rule-fallback");
  assert.equal(d.rate, 110);
  assert.match(d.reasoning, /\nThe AI chair \(llm:stand-in\) was not asked: too little of the meeting was left to choose, so the rule chair, the Chair's built-in fallback, decided this meeting\.\n/);
  assert.doesNotMatch(d.reasoning, /could not use|ran into/, "the AI did not fail");
  assert.deepEqual(d.choice, { formulaBps: 110, chosenBps: 110, reason: "fallback" });
});

test("the rule chair's minutes after the window moved its rate describe the rate set, and the choice line says it asked for the formula's", async () => {
  const snap = snapshot({ rate: 60, staked: 0n, timeLeftMs: 5_000 }); // formula 110, but the contract takes 10..60 here
  const d = await decide(snap, [], opts(ruleChair));
  assert.equal(d.rate, 60);
  assert.match(d.reasoning, /\nThe formula suggested printing 1\.10% a day\. The rule chair asked for it\.\n/);
  assert.match(d.reasoning, /The Chair holds the rate: /, "the statement is of the rate set");
  assert.doesNotMatch(d.reasoning, /would go further|moves the rate from printing 0\.60% a day to printing 1\.10%/);
  assert.match(d.reasoning, /\nThe contract is sure to accept 10\.\.60 bps here, so 60 bps is set instead\. The Chair defers\.$/);
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
  const standIn = (rateBps: number): Chair => ({ name: "llm:stand-in", propose: () => Promise.resolve({ rateBps, reason: "stake_low" }) });
  const early = await decide(snapshot({ rate: 80, timeLeftMs: 40_000 }), [], opts(standIn(125))); // formula 125
  assert.equal(early.rate, 125);
  const late = await decide(snapshot({ rate: 80, timeLeftMs: 5_000 }), [], opts(standIn(125)));
  assert.equal(late.rate, RateWindow.acrossRollover(80, DEFAULT_BOUNDS).pick(125));
  assert.equal(late.rate, 80);
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
  assert.match(own.reasoning, /\nThe formula suggested printing 0\.25% a day\. The Chair chose printing 0\.40% a day: fewer than half of all coins are staked\.\n/);
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

// ---- the epoch rolls over, or the chain moves, while the model thinks: every sentence is of the read taken after the answer

const COIN = 10n ** 24n;
const share = (pct: number) => ({ supply: 1_000_000n * COIN, staked: (BigInt(pct) * 1_000_000n * COIN) / 100n });

test("an answer made for a rate that has since decayed is not used: the rule chair decides on the fresh read, and the minutes are of that read", async () => {
  const seen = snapshot({ epoch: 12, rate: 100, lastSet: 11, timeLeftMs: 20_000, ...share(10) });
  const fresh = snapshot({ epoch: 13, rate: 50, lastSet: 11, timeLeftMs: 80_000, ...share(10) }); // the silent meeting halved the rate in effect
  const chair: Chair = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: 100, reason: "steady" }) }; // holding 100 was steady, then
  const d = finalize(fresh, [], await propose(seen, [], opts(chair)), { marginMs: 15_000 });
  assert.equal(d.kind, "rule-fallback");
  assert.equal(d.rate, 100);
  assert.equal(d.previousRateBps, 50);
  const lines = d.reasoning.split("\n");
  assert.equal(lines[0], "$CHAIR decision, epoch 13, chair rule-v1.");
  assert.equal(lines[1], "The AI chair (llm:stand-in) gave an answer that no longer fit the chain when it arrived, so the rule chair, the Chair's built-in fallback, decided this meeting.");
  assert.equal(lines[2], "Rate in effect 50 bps; decision 100 bps.");
  assert.equal(lines[3], "The formula suggested printing 1.00% a day. The rule chair applied it.");
  assert.match(lines[4]!, /^The Committee of One has met\. The Chair moves the rate from printing 0\.50% a day to printing 1\.00% a day, a little at every 60-second meeting, for holders who staked\. The Chair was silent for 1 meeting, /);
  assert.doesNotMatch(d.reasoning, /holds the rate|steady/);
  assert.match(d.reasoning, /The epoch rolled over while the Chair was deliberating\./);
  assert.deepEqual(d.choice, { formulaBps: 100, chosenBps: 100, reason: "fallback" });
});

test("an answer that still fits the fresh read is the Chair's, and its minutes say the fresh rate, the fresh formula and the silent meeting", async () => {
  const seen = snapshot({ epoch: 12, rate: 100, lastSet: 11, timeLeftMs: 20_000, ...share(10) });
  const fresh = snapshot({ epoch: 13, rate: 50, lastSet: 11, timeLeftMs: 80_000, ...share(10) });
  const chair: Chair = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: 100, reason: "stake_low" }) };
  const d = finalize(fresh, [], await propose(seen, [], opts(chair)), { marginMs: 15_000 });
  assert.equal(d.kind, "llm");
  assert.equal(d.rate, 100);
  assert.match(d.reasoning, /\nRate in effect 50 bps; decision 100 bps\.\nThe formula suggested printing 1\.00% a day\. The Chair agreed: fewer than half of all coins are staked\.\nThe Committee of One has met\. The Chair moves the rate from printing 0\.50% a day to printing 1\.00% a day, a little at every 60-second meeting, for holders who staked\. The Chair was silent for 1 meeting, /);
  assert.doesNotMatch(d.reasoning, /holds the rate/);
});

/**
 * The truth of a choice, written again from the sentences the minutes carry and the contract's rules, sharing nothing with src/choice.ts or rule-chair.ts, the way
 * `contractAccepts` shares nothing with bounds.ts: the share of coins staked against half, the supply against the last logged decision, the side of the formula.
 */
const ref = {
  shareBps: (staked: bigint, supply: bigint): number => Number((staked * 10_000n) / supply),
  /** The formula: half of all coins staked is the aim; the rate walks to it 50 at a time, and a gap under 5 is left alone unless the aim is zero. */
  formula(now: number, shareBps: number): number {
    const aim = Math.max(-200, Math.min(200, Math.trunc((5000 - shareBps) / 40))) || 0;
    const gap = aim - now;
    return gap === 0 || (aim !== 0 && Math.abs(gap) < 5) ? now : now + Math.max(-50, Math.min(50, gap));
  },
  /** Whether `reason` is true of the world and of `rate`, and sits on the right side of the formula. */
  true(reason: string, rate: number, w: { now: number; shareBps: number; supplyDelta: bigint | null; formula: number }): boolean {
    const side = Math.sign(rate - w.formula);
    switch (reason) {
      case "stake_low": return w.shareBps < 5000 && side >= 0;
      case "stake_high": return w.shareBps > 5000 && side <= 0;
      case "supply_up": return w.supplyDelta !== null && w.supplyDelta > 0n && side <= 0;
      case "supply_down": return w.supplyDelta !== null && w.supplyDelta < 0n && side >= 0;
      case "steady": return rate === w.now;
      case "smaller_move": return Math.abs(rate - w.now) < Math.abs(w.formula - w.now);
      case "larger_move": return Math.abs(rate - w.now) > Math.abs(w.formula - w.now);
      default: throw new Error(reason);
    }
  },
  /** The rates a call is sure to be accepted at: those the contract takes now and, near the epoch end, also after the decay of a rollover. */
  accepted(now: number, nearEnd: boolean): number[] {
    return Array.from({ length: 401 }, (_, i) => i - 200).filter((r) => contractAccepts(now, r) && (!nearEnd || contractAccepts(specDecay(now), r)));
  },
  does: (bps: number): string => (bps === 0 ? "neither printing nor burning" : bps > 0 ? `printing ${(bps / 100).toFixed(2)}% a day` : `burning ${(-bps / 100).toFixed(2)}% of every transfer`),
};

test("the truth of every sentence, against the fresh read: rates that decayed, decayed to zero, sign changes, the clamp near the epoch end, no silence", async () => {
  const base = 1_000_000n * COIN;
  /** The rate the model saw and the one in effect now, the share staked, the logged supply (below the supply now: it grew), the supply now, the time left now, and the last epoch the Chair set. */
  const worlds: { was: number; now: number; pct: number; logged: bigint | null; supply: bigint; left: number; lastSet: number | null }[] = [
    { was: 100, now: 50, pct: 10, logged: null, supply: base, left: 80_000, lastSet: 11 }, // decayed
    { was: 30, now: 0, pct: 10, logged: null, supply: base, left: 80_000, lastSet: 11 }, // decayed to zero
    { was: -40, now: 0, pct: 10, logged: null, supply: base, left: 80_000, lastSet: 11 }, // burning decayed to zero: the formula prints
    { was: 60, now: 10, pct: 60, logged: null, supply: base, left: 80_000, lastSet: 11 },
    { was: -60, now: -10, pct: 60, logged: null, supply: base, left: 80_000, lastSet: 11 }, // still burning, less
    { was: 30, now: 0, pct: 50, logged: null, supply: base, left: 80_000, lastSet: 11 },
    { was: 100, now: 50, pct: 50, logged: null, supply: base, left: 80_000, lastSet: 11 },
    { was: 100, now: 50, pct: 10, logged: base - 1000n, supply: base, left: 80_000, lastSet: 11 }, // supply grew since the last decision
    { was: 100, now: 50, pct: 10, logged: base + 1000n, supply: base, left: 80_000, lastSet: 11 }, // supply shrank
    { was: 80, now: 30, pct: 20, logged: null, supply: base, left: 5_000, lastSet: 11 }, // the fresh read is near the epoch end: the window is the overlap of two epochs
    { was: -80, now: -30, pct: 80, logged: null, supply: base, left: 5_000, lastSet: 11 },
    { was: 0, now: 0, pct: 10, logged: null, supply: base, left: 80_000, lastSet: null }, // never set a rate: no silent meeting to speak of
  ];
  let llm = 0;
  let ruled = 0;
  let clamped = 0;
  for (const w of worlds) {
    const history = w.logged === null ? [] : [{ epoch: 11, totalSupply: w.logged }];
    const staked = (BigInt(w.pct) * base) / 100n;
    const seen = snapshot({ epoch: 12, rate: w.was, lastSet: w.lastSet, timeLeftMs: 80_000, supply: base, staked });
    const fresh = snapshot({ epoch: 13, rate: w.now, lastSet: w.lastSet, timeLeftMs: w.left, supply: w.supply, staked });
    const shareBps = ref.shareBps(staked, w.supply);
    const formula = ref.formula(w.now, shareBps);
    const facts = { now: w.now, shareBps, supplyDelta: w.logged === null ? null : w.supply - w.logged, formula };
    const accepted = ref.accepted(w.now, w.left < 15_000);
    for (const reason of MODEL_REASONS) {
      for (let rate = -120; rate <= 120; rate += 5) {
        const chair: Chair = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: rate, reason }) };
        const asked = await propose(seen, history, opts(chair));
        if (asked.kind !== "llm") continue; // not a fair choice even on the read the model saw: the earlier tests cover it
        const d = finalize(fresh, history, asked, { marginMs: 15_000 });
        const label = `saw ${w.was}, now ${w.now}, ${w.pct}% staked, logged ${w.logged}, ${w.left} ms left, ${reason} ${rate}`;
        const fair = Math.abs(rate - formula) <= 25 && Math.abs(rate) <= 200 && ref.true(reason, rate, facts);
        assert.equal(d.kind, fair ? "llm" : "rule-fallback", label);
        fair ? llm++ : ruled++;
        const chosen = fair ? rate : formula;
        const set = Math.min(Math.max(chosen, accepted[0]!), accepted.at(-1)!);
        assert.equal(d.rate, set, `${label}: the nearest rate the call is sure to be accepted at`);
        if (set !== chosen) clamped++;
        const text = d.reasoning;
        const lines = text.split("\n");
        assert.equal(lines[0]!.startsWith("$CHAIR decision, epoch 13, chair "), true, label);
        assert.ok(text.includes(`\nRate in effect ${w.now} bps; decision ${set} bps.\nThe formula suggested ${ref.does(formula)}.`), `${label}: the formula and the rate in effect are the fresh read's\n${text}`);
        assert.ok(text.includes(set === w.now ? "The Chair holds the rate: " : `The Chair moves the rate from ${ref.does(w.now)} to ${ref.does(set)}`), `${label}: the statement is of the rate set against the rate in effect now\n${text}`);
        if (w.was !== w.now && set !== w.was) assert.ok(!text.includes(`from ${ref.does(w.was)}`), `${label}: nothing is said from the rate the model saw`);
        const silent = w.lastSet === null ? 0 : 13 - w.lastSet - 1;
        assert.equal(/was silent for (\d+) meetings?/.exec(text)?.[1] ?? null, silent === 0 ? null : String(silent), `${label}: the silent meetings`);
        assert.ok(text.includes("The epoch rolled over while the Chair was deliberating."), label);
        if (fair) {
          const said = set !== rate ? `The Chair asked for ${ref.does(rate)}: ` : rate === formula ? "The Chair agreed: " : `The Chair chose ${ref.does(rate)}: `;
          assert.ok(text.includes(said), `${label}\n${text}`);
        } else {
          assert.ok(text.includes(set === formula ? "The rule chair applied it." : "The rule chair asked for it."), `${label}\n${text}`);
        }
        assert.equal(d.choice?.formulaBps, formula, label);
      }
    }
  }
  assert.ok(llm > 20 && ruled > 20 && clamped > 5, `every outcome is exercised: ${llm} kept, ${ruled} not, ${clamped} clamped`);
});

test("any chair's choice is checked in propose, not only the LLM chair's: a bad reason or rate falls back instead of throwing in finalize", async () => {
  const snap = snapshot({ rate: 0 }); // nobody staked: the formula is +50, the band 25..50
  const seen: (string | undefined)[] = [];
  for (const [rateBps, reason, fault] of [[40, "formula", "wrong_shape"], [40, "no such reason", "wrong_shape"], [40, undefined, "wrong_shape"], [500, "stake_low", "rate_outside_band"], [40, "stake_high", "reason_not_true"]] as const) {
    seen.length = 0;
    const chair = { name: "llm:stand-in", propose: (_i: unknown, _s: unknown, previous?: string) => (seen.push(previous), Promise.resolve({ rateBps, reason } as unknown as Proposal)) } as Chair;
    const d = await decide(snap, [], opts(chair, 30_000));
    assert.equal(d.kind, "rule-fallback", `${rateBps} ${String(reason)}`);
    assert.deepEqual(seen, [undefined, fault], "asked once more, told which of our checks it failed");
    assert.match(d.reasoning, /gave an answer the Chair could not use, so the rule chair/);
  }
});

test("the line that says the model was not asked fits the page's 60 characters and does not contradict the line after it", async () => {
  const chair = new LlmChair({ label: "llm:stand-in", complete: () => Promise.reject(new Error("must not be called")) });
  const d = await decide(snapshot({ rate: 30, staked: 0n, timeLeftMs: 20_000 }), [], opts(chair)); // 20 s left: under the 25 s that margin and time limit ask for, the formula's 80 is not sure to be taken
  const lines = d.reasoning.split("\n");
  assert.equal(lines[1], "The AI chair (llm:stand-in) was not asked: too little of the meeting was left to choose, so the rule chair, the Chair's built-in fallback, decided this meeting.");
  assert.equal(lines[3], "The formula suggested printing 0.80% a day. The rule chair applied it.");
  assert.ok(/\) (.+), so the rule chair/.exec(lines[1]!)![1]!.length <= 60);
});
