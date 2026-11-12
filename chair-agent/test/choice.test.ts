import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { BAND_BPS, bandFor, choiceFault, choiceLine, MODEL_REASONS, type ReasonId } from "../src/choice.js";
import { decide, finalize, propose } from "../src/decide.js";
import { MAX_PRESS_ENTRIES } from "../src/press-section.js";
import { reasoningHash } from "../src/reasoning.js";
import type { PressEntry } from "../src/press-store.js";
import { LlmChair } from "../src/llm-chair.js";
import { ruleChair } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { PATIENT_MS, snapshot } from "./helpers.js";

const COIN = 10n ** 24n;
const WINDOW = { lo: -50, hi: 50 };

/** The page's reader of the minutes (web/site/js/minutes.js), the one a visitor's browser runs: the agent's sentences must parse with it, or the page shows nothing of the choice. */
interface Page {
  parseChoice(line: string): { kind: string; formula: number; chosen: number; why: string } | null;
  choiceMatching<T>(choice: T | null, setBps: number): T | null;
  splitMinutes(text: string): { meta: string[]; prose: string; fallback: string | null };
  splitClosing(text: string): { head: string; own: string; tail: string } | null;
}
const page = (await import(pathToFileURL(join(import.meta.dirname, "..", "..", "..", "web", "site", "js", "minutes.js")).href)) as unknown as Page;

const REASONS: ReasonId[] = [...MODEL_REASONS, "formula", "fallback"];
const RATES = [-125, -30, -10, -1, 0, 1, 12, 25, 50, 125];
const lowerFirst = (s: string): string => `${s[0]!.toLowerCase()}${s.slice(1)}`;

test("the band is 25 either side of the formula, cut by the window the contract accepts now", () => {
  assert.equal(BAND_BPS, 25);
  assert.deepEqual(bandFor(12, WINDOW), { lo: -13, hi: 37 });
  assert.deepEqual(bandFor(50, WINDOW), { lo: 25, hi: 50 });
  assert.deepEqual(bandFor(-40, WINDOW), { lo: -50, hi: -15 });
  assert.deepEqual(bandFor(0, { lo: 0, hi: 10 }), { lo: 0, hi: 10 });
});

test("a choice is a whole rate inside the band, at its edges too, with a reason that fits", () => {
  const input: DecisionInput = { snapshot: snapshot({ rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN }), history: [], window: WINDOW }; // formula +50, band 25..50
  assert.equal(choiceFault(input, 25, "smaller_move"), null);
  assert.equal(choiceFault(input, 50, "stake_low"), null);
  assert.equal(choiceFault(input, 24, "smaller_move"), "rate_outside_band");
  assert.equal(choiceFault(input, 51, "stake_low"), "rate_outside_band");
  for (const bad of [30.5, Number.NaN, Infinity, 2 ** 60]) assert.equal(choiceFault(input, bad, "stake_low"), "rate_outside_band", String(bad));
  assert.equal(choiceFault(input, 30, "stake_high"), "reason_not_true"); // fewer than half are staked
  assert.equal(choiceFault(input, 30, "supply_up"), "reason_not_true"); // no meeting to compare with
  const grown: DecisionInput = { ...input, history: [{ epoch: 1, totalSupply: 900_000n * COIN }], snapshot: snapshot({ epoch: 3, rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN }) };
  assert.equal(choiceFault(grown, 30, "supply_up"), null);
  assert.equal(choiceFault(grown, 50, "supply_up"), null); // the formula's own number is on neither side
  assert.equal(choiceFault({ ...grown, history: [{ epoch: 1, totalSupply: 1_100_000n * COIN }] }, 30, "supply_down"), "reason_points_other_way");
});

test("the band is empty when the window leaves no rate near the formula, and says so", () => {
  const across = { lo: 60, hi: 85 }; // a window after a rollover that excludes the formula (0)
  const { lo, hi } = bandFor(0, across);
  assert.ok(lo > hi, `${lo}..${hi}`);
});

test("the line of the minutes, in its forms, as percent a day", () => {
  assert.equal(choiceLine({ formulaBps: 12, chosenBps: 15, reason: "stake_low" }, 15), "The formula suggested printing 0.12% a day. The Chair chose printing 0.15% a day: fewer than half of all coins are staked.");
  assert.equal(choiceLine({ formulaBps: 12, chosenBps: 5, reason: "stake_high" }, 5), "The formula suggested printing 0.12% a day. The Chair chose printing 0.05% a day: more than half of all coins are staked.");
  assert.equal(choiceLine({ formulaBps: 12, chosenBps: 12, reason: "stake_low" }, 12), "The formula suggested printing 0.12% a day. The Chair agreed: fewer than half of all coins are staked.");
  assert.equal(choiceLine({ formulaBps: -10, chosenBps: 0, reason: "steady" }, 0), "The formula suggested burning 0.10% of every transfer. The Chair chose neither printing nor burning: the Chair prefers to hold the rate steady.");
  assert.equal(choiceLine({ formulaBps: 18, chosenBps: -7, reason: "supply_up" }, -7), "The formula suggested printing 0.18% a day. The Chair chose burning 0.07% of every transfer: supply has grown since the Chair's last decision.");
  assert.equal(choiceLine({ formulaBps: 40, chosenBps: 30, reason: "smaller_move" }, 30), "The formula suggested printing 0.40% a day. The Chair chose printing 0.30% a day: the Chair prefers to move the rate by less than the formula does.");
  for (const reason of ["formula", "fallback"] as const) assert.equal(choiceLine({ formulaBps: 0, chosenBps: 0, reason }, 0), "The formula suggested neither printing nor burning. The rule chair applied it.");
  // The window moved the rate after the choice: asked for, never chosen, agreed or applied.
  assert.equal(choiceLine({ formulaBps: 50, chosenBps: 40, reason: "smaller_move" }, 20), "The formula suggested printing 0.50% a day. The Chair asked for printing 0.40% a day: the Chair prefers to move the rate by less than the formula does.");
  assert.equal(choiceLine({ formulaBps: 50, chosenBps: 50, reason: "stake_low" }, 20), "The formula suggested printing 0.50% a day. The Chair asked for printing 0.50% a day: fewer than half of all coins are staked.");
  assert.equal(choiceLine({ formulaBps: 50, chosenBps: 50, reason: "formula" }, 20), "The formula suggested printing 0.50% a day. The rule chair asked for it.");
});

/** What a choice line asserts about a rate, read off its words alone: printing is above zero, burning below, neither is zero. */
const meaning = (phrase: string): number => {
  const m = /^(?:(printing) (\d+)\.(\d\d)% a day|(burning) (\d+)\.(\d\d)% of every transfer|(neither printing nor burning))$/.exec(phrase);
  assert.ok(m !== null, phrase);
  return m[7] !== undefined ? 0 : (m[1] === undefined ? -1 : 1) * Number(`${m[2] ?? m[5]}${m[3] ?? m[6]}`);
};

/** Every pair of rates the test tries: negative, zero, positive and across zero; whatever the sign, a sentence must say only what the numbers do. */
const FORMS: { choice: { formulaBps: number; chosenBps: number; reason: ReasonId }; setBps: number }[] = REASONS.flatMap((reason) =>
  RATES.flatMap((formulaBps) =>
    (reason === "formula" || reason === "fallback" ? [formulaBps] : RATES).flatMap((chosenBps) =>
      [chosenBps, chosenBps + 1].map((setBps) => ({ choice: { formulaBps, chosenBps, reason }, setBps })),
    ),
  ),
);

test("every sentence is literally true of its numbers, for each reason and for rates that burn, are zero or cross zero", () => {
  for (const { choice, setBps } of FORMS) {
    const { formulaBps, chosenBps, reason } = choice;
    const line = choiceLine(choice, setBps);
    const [, formula, rest] = /^The formula suggested (.+?)\. (.+)$/.exec(line) ?? [];
    assert.ok(formula !== undefined && rest !== undefined, line);
    assert.equal(meaning(formula), formulaBps, line);
    assert.ok(!line.includes("prints a little"), `no word about which way the rate went, which is false for some pairs: ${line}`);
    const clamped = setBps !== chosenBps;
    if (reason === "formula" || reason === "fallback") {
      assert.equal(rest, clamped ? "The rule chair asked for it." : "The rule chair applied it.", line); // it stands for the formula's number, which it asked for or applied
      continue;
    }
    const [, verb, does] = /^The Chair (agreed|chose|asked for)(?: (.+?))?: /.exec(rest) ?? [];
    if (clamped) {
      assert.equal(verb, "asked for", line);
      assert.equal(meaning(does ?? ""), chosenBps, line);
    } else if (chosenBps === formulaBps) {
      assert.equal(verb, "agreed", line);
      assert.equal(does, undefined, line);
    } else {
      assert.equal(verb, "chose", line);
      assert.equal(meaning(does ?? ""), chosenBps, line);
    }
  }
});

test("the page reads back every form the agent writes: each reason, each pair of rates, agreeing, chosen or asked for (this fails if the two drift)", () => {
  let read = 0;
  for (const { choice, setBps } of FORMS) {
    const { formulaBps, chosenBps, reason } = choice;
    const line = choiceLine(choice, setBps);
    const got = page.parseChoice(line);
    assert.ok(got !== null, line);
    assert.equal(got.formula, formulaBps, line);
    assert.equal(got.chosen, chosenBps, line);
    const rule = reason === "formula" || reason === "fallback";
    const clamped = setBps !== chosenBps;
    assert.equal(got.kind, rule ? (clamped ? "rule-asked" : "rule") : clamped ? "asked" : chosenBps === formulaBps ? "agreed" : "chose", line);
    if (rule) assert.equal(got.why, "");
    else assert.ok(line.endsWith(`: ${lowerFirst(got.why)}`), `${line} / ${got.why}`);
    read++;
  }
  assert.equal(read, 2 * (7 * 10 * 10 + 2 * 10));
});

test("a whole meeting's minutes, written by the real agent for the AI chair, the rule chair and a fallback, are split by the page with the choice line as metadata", async () => {
  const snap = snapshot({ epoch: 12, rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN, lastSet: 11 }); // formula 50 (the step), band 25..50
  const opts = (chair: ConstructorParameters<typeof LlmChair>[0] | null) => ({ chair: chair === null ? ruleChair : new LlmChair(chair), marginMs: 15_000, timeoutMs: PATIENT_MS });
  const answers = (answer: unknown): ConstructorParameters<typeof LlmChair>[0] => ({ label: "llm:stand-in", complete: (req) => Promise.resolve({ text: JSON.stringify(req.schema === undefined ? answer : { remark: "" }), stopReason: "end_turn" }) });
  const cases: [string, Awaited<ReturnType<typeof decide>>, { kind: string; formula: number; chosen: number }][] = [
    ["chose", await decide(snap, [], opts(answers({ rate_bps: 40, reason: "smaller_move" }))), { kind: "chose", formula: 50, chosen: 40 }],
    ["agreed", await decide(snap, [], opts(answers({ rate_bps: 50, reason: "stake_low" }))), { kind: "agreed", formula: 50, chosen: 50 }],
    ["rule", await decide(snap, [], opts(null)), { kind: "rule", formula: 50, chosen: 50 }],
    ["fallback", await decide(snap, [], opts(answers({ rate_bps: 99, reason: "stake_low" }))), { kind: "rule", formula: 50, chosen: 50 }],
  ];
  for (const [name, d, want] of cases) {
    const { meta, prose } = page.splitMinutes(d.reasoning);
    const choice = page.parseChoice(meta.at(-1) ?? "");
    assert.ok(choice !== null, `${name}: ${d.reasoning}`);
    assert.deepEqual({ kind: choice.kind, formula: choice.formula, chosen: choice.chosen }, want, name);
    assert.ok(prose.startsWith("The Committee of One has met."), `${name}: the minutes begin after the choice line`);
    assert.equal(d.choice?.formulaBps, 50);
  }
});

test("a supply reason says what it holds for: the Chair's last decision, however many meetings ago that was, and the supply sentence gives the span", async () => {
  const snap = snapshot({ epoch: 12, rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN, lastSet: 8 }); // formula 50, band 25..50
  const chair = new LlmChair({ label: "llm:stand-in", complete: (req) => Promise.resolve({ text: JSON.stringify(req.schema === undefined ? { rate_bps: 40, reason: "supply_up" } : { remark: "" }), stopReason: "end_turn" }) });
  const d = await decide(snap, [{ epoch: 8, totalSupply: 900_000n * COIN }], { chair, marginMs: 15_000, timeoutMs: PATIENT_MS });
  assert.equal(d.kind, "llm");
  assert.match(d.reasoning, /The Chair chose printing 0\.40% a day: supply has grown since the Chair's last decision\.\n/);
  assert.match(d.reasoning, /Supply is up 100,000 coins over the last 4 meetings\./);
  assert.doesNotMatch(d.reasoning, /since the last meeting/, "the span is 4 meetings, so no sentence says one");
});

/** What the page makes of a whole decision: the plain fallback sentence, the choice row (shown only when it agrees with the rate set) and the Chair's own closing. */
const onPage = (d: Awaited<ReturnType<typeof decide>>) => {
  const { meta, prose, fallback } = page.splitMinutes(d.reasoning);
  const choice = page.choiceMatching(page.parseChoice(meta.at(-1) ?? ""), d.rate);
  return { meta, prose, fallback, choice, closing: page.splitClosing(d.reasoning) };
};

test("the page reads the fallback line and the choice of a stale answer and of a model that was not asked, as the agent writes them (this fails if the wordings drift)", async () => {
  // The model answered for the rate it saw; the rollover decayed it: the agent drops the answer and says so.
  const seen = snapshot({ epoch: 12, rate: 100, lastSet: 11, timeLeftMs: 20_000, supply: 1_000_000n * COIN, staked: 100_000n * COIN });
  const fresh = snapshot({ epoch: 13, rate: 50, lastSet: 11, timeLeftMs: 80_000, supply: 1_000_000n * COIN, staked: 100_000n * COIN });
  const steady = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: 100, reason: "steady" as const }) };
  const stale = finalize(fresh, [], await propose(seen, [], { chair: steady, marginMs: 15_000, timeoutMs: PATIENT_MS }), { marginMs: 15_000 });
  assert.equal(stale.kind, "rule-fallback");
  const s = onPage(stale);
  assert.equal(s.fallback, "The AI chair gave an answer that no longer fit the chain when it arrived, so the Chair's built-in fallback rule decided this meeting.", stale.reasoning);
  assert.deepEqual(s.choice && { kind: s.choice.kind, formula: s.choice.formula, chosen: s.choice.chosen }, { kind: "rule", formula: 100, chosen: 100 });
  assert.ok(s.prose.startsWith("The Committee of One has met."), s.prose);
  // The call may land after the rollover and no rate near the formula is then sure to be taken: the model is not asked.
  const late = snapshot({ rate: 30, staked: 0n, timeLeftMs: 20_000 });
  const none = await decide(late, [], { chair: new LlmChair({ label: "llm:stand-in", complete: () => Promise.reject(new Error("must not be asked")) }), marginMs: 15_000, timeoutMs: PATIENT_MS });
  assert.equal(none.kind, "rule-fallback");
  const n = onPage(none);
  assert.equal(n.fallback, "The AI chair was not asked: too little of the meeting was left to choose, so the Chair's built-in fallback rule decided this meeting.", none.reasoning);
  assert.ok(n.choice !== null && n.choice.kind === "rule", none.reasoning);
  // A row that does not match the rate the chain set is not shown.
  assert.equal(page.choiceMatching(page.parseChoice(page.splitMinutes(none.reasoning).meta.at(-1) ?? ""), none.rate + 1), null);
});

test("the page reads the clamp note and the press head of the real agent's text: the Chair's own closing is found before them, for every number of questions waiting", async () => {
  const REMARK = "The Chair has appointed a subcommittee of the Chair to look into the Chair.";
  const chair = { name: "llm:stand-in", propose: () => Promise.resolve({ rateBps: 100, reason: "smaller_move" as const }), remark: () => Promise.resolve(REMARK) };
  const entry = (i: number): PressEntry => ({ id: `id-${i}`, question: `q${i}`, questionHash: reasoningHash(`q${i}`), answer: `Answer ${i}.`, source: "model", askedAtMs: i, epoch: null, txHash: null });
  const seen = snapshot({ rate: 60, timeLeftMs: 60_000 });
  const asked = await propose(seen, [], { chair, marginMs: 15_000, timeoutMs: PATIENT_MS });
  for (const n of [0, 1, 2, 3, 5]) {
    const d = finalize(snapshot({ rate: 60, timeLeftMs: 5_000 }), [], asked, { marginMs: 15_000 }, Array.from({ length: n }, (_, i) => entry(i)));
    const closing = onPage(d).closing;
    assert.equal(closing?.own, REMARK, `${n} waiting: ${d.reasoning}`);
    assert.ok(closing.tail.includes("The contract is sure to accept 10..60 bps here"), "the clamp note is after the statement");
    if (n > 0) {
      const entered = Math.min(n, MAX_PRESS_ENTRIES);
      assert.ok(closing.tail.includes(`The press has ${n} question${n === 1 ? "" : "s"} waiting.`), `${n} waiting: ${closing.tail}`);
      assert.equal(closing.tail.split("\n").filter((l) => l.startsWith("A member of the press")).length, entered);
    }
    assert.equal(onPage(d).choice?.kind, "asked", "the clamp moved the rate: the row says what was asked for");
    // No clamp note before it: the press head alone is what ends the statement.
    const plain = finalize(seen, [], asked, { marginMs: 15_000 }, Array.from({ length: n }, (_, i) => entry(i)));
    assert.equal(onPage(plain).closing?.own, REMARK, `${n} waiting, no clamp: ${plain.reasoning}`);
    if (n > 0) assert.ok(onPage(plain).closing?.tail.startsWith(`\nThe press has ${n} question`), `${n} waiting, no clamp: the press head is outside the statement`);
  }
});
