import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { BAND_BPS, bandFor, choiceFault, choiceLine, MODEL_REASONS, type ReasonId } from "../src/choice.js";
import { decide } from "../src/decide.js";
import { LlmChair } from "../src/llm-chair.js";
import { ruleChair } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { PATIENT_MS, snapshot } from "./helpers.js";

const COIN = 10n ** 24n;
const WINDOW = { lo: -50, hi: 50 };

/** The page's reader of the minutes (web/site/js/minutes.js), the one a visitor's browser runs: the agent's sentences must parse with it, or the page shows nothing of the choice. */
interface Page {
  parseChoice(line: string): { kind: string; formula: number; chosen: number; why: string } | null;
  splitMinutes(text: string): { meta: string[]; prose: string };
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
  assert.match(choiceFault(input, 24, "smaller_move") ?? "", /outside 25\.\.50/);
  assert.match(choiceFault(input, 51, "stake_low") ?? "", /outside 25\.\.50/);
  for (const bad of [30.5, Number.NaN, Infinity, 2 ** 60]) assert.match(choiceFault(input, bad, "stake_low") ?? "", /outside/, String(bad));
});

test("the line of the minutes, in the three forms, as percent a day", () => {
  assert.equal(choiceLine({ formulaBps: 12, chosenBps: 15, reason: "stake_low" }), "The formula suggested printing 0.12% a day. The Chair chose printing 0.15% a day: fewer than half of all coins are staked, so it prints a little more.");
  assert.equal(choiceLine({ formulaBps: 12, chosenBps: 5, reason: "stake_high" }), "The formula suggested printing 0.12% a day. The Chair chose printing 0.05% a day: more than half of all coins are staked, so it prints a little less.");
  assert.equal(choiceLine({ formulaBps: 12, chosenBps: 12, reason: "stake_low" }), "The formula suggested printing 0.12% a day. The Chair agreed: fewer than half of all coins are staked.");
  assert.equal(choiceLine({ formulaBps: -10, chosenBps: 0, reason: "steady" }), "The formula suggested burning 0.10% of every transfer. The Chair chose neither printing nor burning: the Chair prefers to hold the rate steady.");
  assert.equal(choiceLine({ formulaBps: 40, chosenBps: 30, reason: "smaller_move" }), "The formula suggested printing 0.40% a day. The Chair chose printing 0.30% a day: the Chair prefers to move the rate by less than the formula does.");
  for (const reason of ["formula", "fallback"] as const) assert.equal(choiceLine({ formulaBps: 0, chosenBps: 0, reason }), "The formula suggested neither printing nor burning. The rule chair applied it.");
});

test("the page reads back every form the agent writes: each reason, each pair of rates, agreeing or not (this fails if the two drift)", () => {
  let read = 0;
  for (const reason of REASONS) {
    for (const formulaBps of RATES) {
      for (const chosenBps of reason === "formula" || reason === "fallback" ? [formulaBps] : RATES) {
        const line = choiceLine({ formulaBps, chosenBps, reason });
        const got = page.parseChoice(line);
        assert.ok(got !== null, line);
        assert.equal(got.formula, formulaBps, line);
        assert.equal(got.chosen, chosenBps, line);
        assert.equal(got.kind, reason === "formula" || reason === "fallback" ? "rule" : chosenBps === formulaBps ? "agreed" : "chose", line);
        if (got.kind !== "rule") assert.ok(line.endsWith(`: ${lowerFirst(got.why)}`), `${line} / ${got.why}`);
        else assert.equal(got.why, "");
        read++;
      }
    }
  }
  assert.equal(read, 7 * 10 * 10 + 2 * 10);
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
