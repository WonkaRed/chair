import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ANSWER_SCHEMA, AnthropicLlmClient, LLM_MODEL, LlmChair, LocalLlmClient, buildPrompt, llmConfigured, parseAnswer, wordingFault } from "../src/llm-chair.js";
import { ChairFailure } from "../src/decide.js";
import { percent } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

test("the prompt is numbers only: no account ids and no free-form chain text", () => {
  const snap = snapshot({ supply: 123_456_789n, staked: 1_000n, chair: "chair.test", rate: 30 });
  const { system, user } = buildPrompt({ snapshot: snap, history: [{ epoch: 4, totalSupply: 100n }], window: { lo: -20, hi: 80 } });
  const data = JSON.parse(user) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), [
    "mandate_does", "mandate_rate_bps", "mandate_rate_percent", "meeting_length", "meetings_missed_since_the_last_decision",
    "rate_in_effect_bps", "rate_in_effect_does", "rate_in_effect_percent", "rate_window_bps", "staked_share_in_words", "supply_change_in_words",
  ]);
  assert.ok(!user.includes("chair.test") && !user.includes("123456789"), "no account id and no supply in full");
  assert.deepEqual(data["rate_window_bps"], [-20, 80]);
  assert.match(system, /no financial advice/);
});

test("the system prompt gives the chair its voice and the guard rails that keep every sentence true to the numbers", () => {
  const { system } = buildPrompt({ snapshot: snapshot(), history: [], window: { lo: -50, hi: 50 } });
  assert.match(system, /"The Chair", a deadpan parody of a central banker/);
  assert.match(system, /Committee of One/);
  for (const rule of [/Anyone must understand the minutes in one read/, /never "basis points", "bps", "epoch"/, /Claim only what the numbers show/, /never forecast or promise/, /nothing about price, value/, /When a field is null or absent, do not mention it/, /Name no real person, institution, currency, central bank or place/, /No em or en dashes, no emoji/]) {
    assert.match(system, rule);
  }
  assert.doesNotMatch(system, /[\u2013\u2014\p{Extended_Pictographic}]|moon/u, "the prompt itself uses no em or en dash, emoji or hype");
});

const WINDOW = { lo: -50, hi: 50 };

test("every figure arrives as a finished percent with two decimals, so the minutes copy and never convert", () => {
  const field = (name: string, staked: bigint | null, supply = 10_000n, rate = 0) =>
    JSON.parse(buildPrompt({ snapshot: snapshot({ supply, staked, rate }), history: [], window: WINDOW }).user)[name] as unknown;
  assert.equal(field("staked_share_in_words", 4450n), "44.50% of all coins are staked.");
  assert.equal(field("staked_share_in_words", 4400n), "44.00% of all coins are staked.");
  assert.equal(field("staked_share_in_words", 1n, 3n), "33.33% of all coins are staked.");
  assert.equal(field("staked_share_in_words", null), null, "no staking figures: nothing to say");
  assert.equal(field("staked_share_in_words", 0n, 0n), null, "no supply: nothing to say");
  assert.equal(field("meeting_length", 0n), "60 seconds", "the epoch length of the snapshot, not a constant");
  assert.equal(field("rate_in_effect_percent", 0n, 10_000n, 5), "0.05%");
  assert.equal(field("rate_in_effect_does", 5n, 10_000n, 5), "0.05% more coins are printed a day, a little at every 60-second meeting, for holders who staked");
  assert.equal(field("rate_in_effect_does", 0n, 10_000n, 5), "no coins are printed while nobody has staked");
  assert.equal(field("rate_in_effect_does", null, 10_000n, 5), "0.05% more coins are printed a day, a little at every 60-second meeting, for holders who staked", "unknown staking is not nobody");
  assert.equal(field("rate_in_effect_does", 5n, 10_000n, -10), "0.10% of every transfer is burned");
  assert.equal(field("rate_in_effect_does", 5n, 10_000n, 0), "no coins are printed and none are burned");
  const { system } = buildPrompt({ snapshot: snapshot(), history: [], window: WINDOW });
  assert.match(system, /5 is 0\.05%, 12 is 0\.12%, -10 is 0\.10%, 200 is 2\.00%, 0 is 0\.00%/);
});

test("supply change is a finished sentence over the span the history really covers", () => {
  const said = (supply: bigint, history: DecisionInput["history"]) =>
    JSON.parse(buildPrompt({ snapshot: snapshot({ epoch: 20, supply }), history, window: WINDOW }).user)["supply_change_in_words"] as unknown;
  assert.equal(said(1_003_000n, [{ epoch: 14, totalSupply: 1_000_000n }]), "Supply is up 0.30% over the last 6 meetings.");
  assert.equal(said(1_003_000n, [{ epoch: 18, totalSupply: 1_000_000n }]), "Supply is up 0.30% over the last 2 meetings.", "the history spans 2, not 6");
  assert.equal(said(1_003_000n, [{ epoch: 19, totalSupply: 1_000_000n }]), "Supply is up 0.30% since the last meeting.");
  assert.equal(said(997_000n, [{ epoch: 14, totalSupply: 1_000_000n }]), "Supply is down 0.30% over the last 6 meetings.");
  assert.equal(said(1_000_050n, [{ epoch: 14, totalSupply: 1_000_000n }]), "Supply has moved less than 0.01% over the last 6 meetings.");
  assert.equal(said(1_000_000n, []), null, "no history: nothing to say");
});

test("bps become percent exactly: the sign is the words' job, never part of the figure", () => {
  assert.equal(percent(5), "0.05%");
  assert.equal(percent(-10), "0.10%");
  assert.equal(percent(200), "2.00%");
  assert.equal(percent(-200), "2.00%");
  assert.equal(percent(0), "0.00%");
  assert.equal(percent(-0), "0.00%");
  assert.equal(percent(1), "0.01%");
  assert.equal(percent(4617n), "46.17%");
  assert.equal(percent(10_000), "100.00%");
});

test("the run of meetings describes the rate before the decision, and a run of one is nothing to say", () => {
  const field = "meetings_before_this_one_the_chair_set_the_rate_in_effect";
  const run = (sameRateEpochs: number) => JSON.parse(buildPrompt({ snapshot: snapshot({ rate: 22 }), history: [], window: WINDOW, memory: { sameRateEpochs, refusals: 0, remarks: [] } }).user)[field] as unknown;
  assert.equal(run(0), null);
  assert.equal(run(1), null, "\"one meeting in a row\" is never said");
  assert.equal(run(2), 2);
  assert.equal(run(5), 5);
  const { system } = buildPrompt({ snapshot: snapshot(), history: [], window: WINDOW });
  assert.match(system, /the rate from before this decision/);
  assert.match(system, /Use it only when you hold, that is when rate_bps equals rate_in_effect_bps, and only as "as it has for the last N meetings"/);
  assert.match(system, /when you change the rate it says nothing about the new rate, so do not mention it and never write "in a row"/);
});

test("the prompt gives the mandate rate as figures, the objective in one sentence, and the rate as per day", () => {
  const prompt = (o: Parameters<typeof snapshot>[0]) => buildPrompt({ snapshot: snapshot({ epoch: 1000, ...o }), history: [], window: WINDOW });
  const calm = JSON.parse(prompt({ supply: 10_000n, staked: 4_000n, rate: 0 }).user) as Record<string, unknown>;
  assert.equal(calm["mandate_rate_bps"], 25, "(5000 - 4000) / 40");
  assert.equal(calm["mandate_rate_percent"], "0.25%");
  assert.equal(calm["mandate_does"], "0.25% more coins are printed a day, a little at every 60-second meeting, for holders who staked");
  assert.equal(calm["rate_in_effect_does"], "no coins are printed and none are burned");
  const { system } = prompt({});
  assert.match(system, /Your objective, in one sentence: the more holders stake, the less the Chair prints, aiming for half of all coins staked\./);
  assert.match(system, /you may set another rate inside the window, and the log records which of the two you did/);
  assert.match(system, /that percent of all coins in a day, for the holders who staked, a little at every meeting/);
  assert.match(system, /"printing 0\.05% more coins a day, a little at every 90-second meeting, for holders who staked"/);
  assert.match(system, /The percent is per day, never per meeting/);
  assert.doesNotMatch(system, /budget|every 90 seconds|each epoch|per epoch/i);
});

const input = (rate: number, sameRateEpochs: number, o: Parameters<typeof snapshot>[0] = {}): DecisionInput => ({
  snapshot: snapshot({ rate, supply: 1_003_000n, staked: 463_100n, epoch: 20, ...o }),
  history: [{ epoch: 14, totalSupply: 1_000_000n }],
  window: WINDOW,
  memory: { sameRateEpochs, refusals: 0, remarks: [] },
});

test("the prompt asks for a change in one sentence that names each rate once, and wordingFault refuses a new rate said twice", () => {
  const { system } = buildPrompt(input(5, 0));
  assert.match(system, /"The Chair changes the rate from printing 0\.05% a day to printing 0\.12% a day, a little at every 90-second meeting, for holders who staked\."/);
  assert.match(system, /Never follow the new rate with a second description of it/);
  const fault = (reasoning: string, rateBps: number, i: DecisionInput) => wordingFault({ rateBps, reasoning }, i);
  const twice = "The Chair changes the rate from printing 0.15% a day to printing 0.20% a day, printing 0.20% more coins a day, a little at every 90-second meeting, for holders who staked.";
  assert.equal(fault(twice, 20, input(15, 0)), "the new rate said twice in one sentence");
  assert.equal(fault("The Chair changes the rate from printing 0.15% a day to printing 0.20% a day, a little at every 90-second meeting, for holders who staked.", 20, input(15, 0)), null);
  assert.equal(fault("The Chair changes the rate from printing 0.10% a day to burning 0.05% of every transfer.", -5, input(10, 0)), null);
  assert.equal(fault("The Chair changes the rate from burning 0.10% of every transfer to printing 0.10% a day, a little at every 90-second meeting, for holders who staked.", 10, input(-10, 0)), null, "the same figure for the old rate and the new one is two rates, not one said twice");
  assert.equal(fault("The Chair changes the rate from printing 0.10% a day to burning 0.10% of every transfer.", -10, input(10, 0)), null, "a flip to the opposite rate of the same size is not a wrong verb");
  // An equal-size flip: the verb after the "to" is the new rate's, the verb before it is the old one's.
  assert.equal(fault("The Chair changes the rate from burning 0.10% of every transfer to printing 0.10% a day, a little at every 90-second meeting, for holders who staked.", -10, input(10, 0)), "a rate that burns written as a print", "a burn decided, printing said");
  assert.equal(fault("The Chair changes the rate from printing 0.10% a day to printing 0.10% a day, a little at every 90-second meeting, for holders who staked.", -10, input(10, 0)), "a rate that burns written as a print");
  assert.equal(fault("The Chair changes the rate from burning 0.10% of every transfer to burning 0.10% of every transfer.", 10, input(-10, 0)), "a rate that prints written as a burn");
  assert.equal(fault("The Chair changes the rate from printing 0.10% a day to burning 0.10% of every transfer.", -10, input(10, 0)), null);
  // The last "from ... to" is the change; an earlier "from" is not.
  assert.equal(fault("From the last meeting on, the Chair changes the rate from printing 0.15% a day to printing 0.20% a day, printing 0.20% more coins a day.", 20, input(15, 0)), "the new rate said twice in one sentence");
  // "40.05%" is another figure, not "0.05%" again.
  assert.equal(fault("The Chair changes the rate from printing 0.10% a day to printing 0.05% a day, while 40.05% of all coins are staked.", 5, input(10, 0, { supply: 1_000_000n, staked: 400_500n })), null);
  assert.equal(fault("The Chair changes the rate to printing 0.20% a day, printing 0.20% more coins a day, a little at every 90-second meeting, for holders who staked.", 20, input(15, 0)), "the new rate said twice in one sentence", "no \"from\" to hang the check on");
  assert.equal(fault("The Chair changes the rate from printing 0.15% a day to neither printing nor burning.", 0, input(15, 0)), null);
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked.", 5, input(5, 0)), null, "a hold names its rate once and has no from-to");
});

test("wordingFault passes the minutes the prompt asks for, in every case the Chair meets", () => {
  const fault = (reasoning: string, rateBps: number, i: DecisionInput) => wordingFault({ rateBps, reasoning }, i);
  const hold = "The Committee of One has met. The Chair keeps printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked, as it has for the last 14 meetings. Supply is up 0.30% over the last 6 meetings. 46.17% of all coins are staked. The Chair asks that this be recorded.";
  assert.equal(fault(hold, 5, input(5, 14)), null);
  assert.equal(fault("The Chair changes the rate from printing 0.05% a day to printing 0.10% a day. 46.17% of all coins are staked.", 10, input(5, 14)), null);
  assert.equal(fault("The Chair changes the rate from burning 0.10% of every transfer to printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked.", 5, input(-10, 0)), null, "the old rate's burn is not the new rate's");
  assert.equal(fault("The Chair changes the rate from neither printing nor burning to printing 0.05% a day.", 5, input(0, 0)), null);
  assert.equal(fault("The Chair now burns 0.10% of every transfer.", -10, input(5, 0)), null);
  assert.equal(fault("The Chair keeps the rate at 0.00%, printing no coins and burning none.", 0, input(0, 3)), null, "zero needs no figure");
  assert.equal(fault("The Chair stops the printing. Supply has moved less than 0.01% over the last 6 meetings.", 0, input(5, 0, { supply: 1_000_050n })), null, "the sentence the prompt gives for a near-zero change");
});

test("wordingFault allows the mandate rate as a figure and still refuses invented ones", () => {
  // 40.00% staked asks for 25 bps.
  const i: DecisionInput = { snapshot: snapshot({ epoch: 1000, rate: 5, supply: 1_000n, staked: 400n }), history: [], window: WINDOW };
  const fault = (reasoning: string) => wordingFault({ rateBps: 5, reasoning }, i);
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day. The mandate asks for printing 0.25% a day."), null, "the mandate rate");
  assert.match(fault("The Chair keeps printing 0.05% more coins a day. The mandate asks for printing 0.26% a day.")!, /percent the numbers do not give \(0\.26%\)/);
  assert.match(fault("The Chair keeps printing 0.05% more coins a day. The ceiling is 2.00% a day.")!, /2\.00%/, "a bound the prompt does not give is not a figure to quote");
});

test("wordingFault refuses a printing rate that is not per day: no day word, or each meeting or each stretch of seconds in its place", () => {
  const i = input(5, 0);
  const fault = (reasoning: string, rateBps = 5, at = i) => wordingFault({ rateBps, reasoning }, at);
  const ok = "The Chair keeps printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked.";
  assert.equal(fault(ok), null);
  assert.equal(fault("The Chair keeps printing 0.05% more coins every day for holders who staked."), null);
  assert.equal(fault("The Chair keeps printing 0.05% more coins daily for holders who staked."), null);
  assert.equal(fault("The Chair keeps printing 0.05% more coins per day, at each meeting, for holders who staked."), null, "a day named first, then the meetings");
  assert.match(fault("The Chair keeps printing 0.05% more coins for holders who staked.")!, /without its day/);
  for (const bad of [
    "The Chair keeps printing 0.05% more coins every 90 seconds for holders who staked, a day at a time.",
    "The Chair keeps printing 0.05% more coins every 90-second meeting for holders who staked, a day at a time.",
    "The Chair keeps printing 0.05% more coins at every meeting for holders who staked, a day at a time.",
    "The Chair keeps printing 0.05% more coins each meeting for holders who staked, a day at a time.",
    "The Chair is minting 0.05% per meeting for holders who staked, a day at a time.",
    "The Chair keeps printing 0.05% more coins every 2 minutes for holders who staked, a day at a time.",
  ]) {
    assert.match(fault(bad)!, /per meeting instead of per day/, bad);
  }
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day. The Committee meets every 90 seconds."), null, "a meeting length outside a printing sentence says nothing of the rate");
  assert.equal(fault("The Chair is neither printing nor burning.", 0, input(0, 0)), null, "nothing printed, nothing to date");
  assert.equal(fault("The Chair burns 0.10% of every transfer.", -10, input(-10, 0)), null, "burning stays per transfer");
  const nobody = input(5, 0, { staked: 0n });
  assert.equal(fault("The Chair keeps the rate, but no coins are printed while nobody has staked.", 5, nobody), null, "no day word is owed when nothing prints");
});

test("wordingFault refuses basis points, epochs and field names: the reader is not a blockchain engineer", () => {
  const fault = (reasoning: string, rateBps = 5, i = input(5, 0)) => wordingFault({ rateBps, reasoning }, i);
  assert.match(fault("The Chair holds the rate at 5 basis points, 0.05%.")!, /basis points/);
  assert.match(fault("The Chair holds the rate at 1 basis point, 0.05%.")!, /basis points/);
  assert.match(fault("The Chair keeps 0.05%, which is 5 bps.")!, /basis points/);
  assert.match(fault("The Chair keeps printing 0.05% more coins every epoch.")!, /epoch/);
  assert.match(fault("The Chair keeps printing 0.05% over the last 6 epochs.")!, /epoch/);
});

test("wordingFault refuses a percent the numbers do not give, and a rate written as the wrong act", () => {
  const fault = (reasoning: string, rateBps: number, i: DecisionInput) => wordingFault({ rateBps, reasoning }, i);
  assert.match(fault("The Chair keeps printing 0.50% more coins a day.", 5, input(5, 0))!, /percent the numbers do not give \(0\.50%\)/);
  assert.match(fault("The Chair keeps printing 0.05% more coins a day. 46% of all coins are staked.", 5, input(5, 0))!, /percent the numbers do not give \(46%\)/, "two decimals, as given");
  assert.match(fault("The Chair keeps printing 0.05% more coins a day. 46.18% of all coins are staked.", 5, input(5, 0))!, /46\.18%/);
  assert.match(fault("Supply is up 0.31% over the last 6 meetings.", 5, input(5, 0))!, /0\.31%/);
  assert.match(fault("The Chair changes the rate from printing 0.05% a day to printing 0.07% a day.", 8, input(5, 0))!, /percent the numbers do not give \(0\.07%\)/, "the rate written is not the rate decided");
  assert.match(fault("The Chair keeps burning 0.05% of every transfer.", 5, input(5, 0))!, /prints written as a burn/);
  assert.match(fault("The Chair keeps printing 0.10% more coins a day.", -10, input(-10, 0))!, /burns written as a print/);
  // The 0.01% of "less than 0.01%" is a given figure.
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day. Supply has moved less than 0.01% over the last 6 meetings.", 5, input(5, 0, { supply: 1_000_050n })), null);
  assert.match(fault("The Chair keeps printing 0.05% more coins a day. Supply has moved less than 0.01% over the last 6 meetings.", 5, input(5, 0))!, /0\.01%/, "only when the supply really barely moved");
});

test("wordingFault refuses a run of meetings the Chair may not claim, and a rate with no unit", () => {
  const fault = (reasoning: string, rateBps: number, i: DecisionInput) => wordingFault({ rateBps, reasoning }, i);
  // The finding: a change that claims the old rate's run.
  assert.match(fault("The Chair changes the rate from printing 0.05% a day to printing 0.10% a day, as it has for the last 14 meetings.", 10, input(5, 14))!, /run of meetings/);
  assert.match(fault("The Chair keeps printing 0.05% more coins a day, as it has for the last 14 meetings.", 5, input(5, 1))!, /run of meetings/, "no run of two or more on record");
  assert.match(fault("The Chair keeps printing 0.05% more coins a day, as it has for the last 14 meetings.", 5, { ...input(5, 0), memory: undefined })!, /run of meetings/, "no log, no run");
  assert.match(fault("The Chair keeps printing 0.05% more coins a day, as it has for the last 9 meetings.", 5, input(5, 14))!, /run of meetings/, "the count is the logged one");
  assert.match(fault("The Chair keeps printing 0.05% more coins a day, 14 meetings in a row.", 10, input(5, 14))!, /run of meetings/);
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day, as it has for the last 14 meetings.", 5, input(5, 14)), null);
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day, 14 meetings in a row.", 5, input(5, 14)), null);
  // Supply over a span is not a run.
  assert.equal(fault("The Chair keeps printing 0.05% more coins a day. Supply is up 0.30% over the last 6 meetings.", 5, input(5, 0)), null);
  // No unit.
  assert.match(fault("The Chair cuts the rate to 12.", 12, input(5, 0))!, /without its unit/);
  assert.match(fault("The Chair moves the rate from 22 to \u22125.", -5, input(22, 0))!, /without its unit/);
});

test("the chair tries once more when the first answer is refused by the lint, and falls back when the second is too", async () => {
  const i = input(5, 0);
  const answers = (...texts: string[]) => {
    const asked: number[] = [];
    const chair = new LlmChair({ complete: () => { asked.push(asked.length); return Promise.resolve({ text: JSON.stringify({ rate_bps: 10, reasoning: texts[Math.min(asked.length - 1, texts.length - 1)] }), stopReason: "end_turn" }); } });
    return { chair, asked };
  };
  const bad = "The Chair raises the rate by 5 basis points, to 0.10%.";
  const good = "The Committee of One has met. The Chair changes the rate from printing 0.05% a day to printing 0.10% a day.";
  const retried = answers(bad, good);
  assert.equal((await retried.chair.propose(i, new AbortController().signal)).reasoning, good);
  assert.equal(retried.asked.length, 2);
  const clean = answers(good);
  await clean.chair.propose(i, new AbortController().signal);
  assert.equal(clean.asked.length, 1, "a clean answer is not asked for twice");
  const stubborn = answers(bad);
  await assert.rejects(stubborn.chair.propose(i, new AbortController().signal), (e: unknown) => e instanceof ChairFailure && e.reason === "malformed" && /basis points/.test(e.message));
  assert.equal(stubborn.asked.length, 2, "two attempts, then the rule chair decides");
});

test("the prompt separates a silence from a decision made last meeting", () => {
  const at = (lastSet: number | null) => JSON.parse(buildPrompt({
    snapshot: snapshot({ epoch: 218, lastSet }), history: [], window: { lo: -50, hi: 50 },
  }).user) as Record<string, unknown>;
  assert.equal(at(217)["meetings_missed_since_the_last_decision"], 0, "decided in the previous meeting");
  assert.equal(at(43)["meetings_missed_since_the_last_decision"], 174);
  assert.equal(at(null)["meetings_missed_since_the_last_decision"], null, "no decision has ever been made");
});

test("parseAnswer accepts exactly the schema and cleans the text", () => {
  const p = parseAnswer({ text: '{"rate_bps": -30, "reasoning": " tighten\\u0000 a bit "}', stopReason: "end_turn" });
  assert.deepEqual(p, { rateBps: -30, reasoning: "tighten  a bit" });
});

test("llmConfigured only looks for a non-empty key", () => {
  assert.equal(llmConfigured({}), false);
  assert.equal(llmConfigured({ ANTHROPIC_API_KEY: "" }), false);
  assert.equal(llmConfigured({ ANTHROPIC_API_KEY: "x" }), true);
});

// The real SDK wrapper against a loopback server: proves the request we build (model, schema, no
// thinking-disabled, no forced tool choice) and how a reply is read. It does not prove the live API.
test("AnthropicLlmClient builds the documented request and reads the reply", async () => {
  let seen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> } | undefined;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen = { headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: LLM_MODEL, stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: '{"rate_bps": 5, "reasoning": "ok"}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const client = new AnthropicLlmClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "test-key-not-real" });
    const out = await client.complete({ system: "S", user: "U", signal: new AbortController().signal });
    assert.deepEqual(out, { text: '{"rate_bps": 5, "reasoning": "ok"}', stopReason: "end_turn" });
    const b = seen!.body;
    assert.equal(b["model"], "claude-sonnet-5-5");
    assert.equal(client.label, "llm:claude-sonnet-5-5", "only the client that calls the real model carries its id");
    assert.equal(new LlmChair(client).name, "llm:claude-sonnet-5-5");
    assert.equal(new LlmChair({ complete: client.complete.bind(client) }).name, "llm:unlabelled-client", "a client with no label never inherits the real model id");
    assert.equal(b["system"], "S");
    assert.deepEqual(b["messages"], [{ role: "user", content: "U" }]);
    assert.deepEqual((b["output_config"] as Record<string, unknown>)["format"], { type: "json_schema", schema: ANSWER_SCHEMA });
    assert.equal(b["tool_choice"], undefined);
    assert.equal(b["thinking"], undefined);
    assert.equal(b["temperature"], undefined);
  } finally {
    server.close();
  }
});

test("an answer with a duplicate key is malformed, however it is escaped; nested keys of the same name are fine", () => {
  const ok = (text: string) => parseAnswer({ text, stopReason: "end_turn" });
  for (const text of [
    '{"rate_bps": 10, "rate_bps": 20, "reasoning": "x"}',
    '{"rate_bps": 10, "reasoning": "x", "reasoning": "y"}',
    '{"rate_bps": 10, "rate_b\\u0070s": 20, "reasoning": "x"}',
    '{"rate_bps": 10, "reasoning": "x", "extra": 1}',
  ]) assert.throws(() => ok(text), /schema/, text);
  assert.deepEqual(ok('{"reasoning": "has \\"rate_bps\\": 5 inside, {braces}, [brackets]", "rate_bps": 10}'), {
    rateBps: 10,
    reasoning: 'has "rate_bps": 5 inside, {braces}, [brackets]',
  });
});

/** A loopback stand-in for a local vLLM `/v1/messages` that answers as `served`, with a thinking block first as vLLM does. */
async function localServer(served: string, onBody: (b: Record<string, unknown>) => void = () => {}) {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      onBody(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "chatcmpl-test", type: "message", role: "assistant", model: served, stop_reason: "end_turn", stop_sequence: null,
        content: [
          { type: "thinking", thinking: "private scratch work", signature: "sig" },
          { type: "text", text: '{"rate_bps": 7, "reasoning": "local ok"}' },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

test("LocalLlmClient asks for the configured model, is labelled local:<id>, and drops thinking blocks", async () => {
  let body: Record<string, unknown> | undefined;
  const { server, url } = await localServer("qwen-test", (b) => (body = b));
  try {
    const client = new LocalLlmClient(url, "qwen-test");
    assert.equal(client.label, "local:qwen-test");
    assert.equal(new LlmChair(client).name, "local:qwen-test");
    const out = await client.complete({ system: "S", user: "U", signal: new AbortController().signal });
    assert.deepEqual(out, { text: '{"rate_bps": 7, "reasoning": "local ok"}', stopReason: "end_turn" });
    assert.equal(body!["model"], "qwen-test");
  } finally {
    server.close();
  }
});

test("LocalLlmClient refuses an answer from a model other than the one it is named after", async () => {
  const { server, url } = await localServer("some-other-model");
  try {
    const client = new LocalLlmClient(url, "qwen-test");
    await assert.rejects(client.complete({ system: "S", user: "U", signal: new AbortController().signal }), /answered as "some-other-model", not qwen-test/);
  } finally {
    server.close();
  }
});

test("LocalLlmClient only accepts a loopback http endpoint and a plain model id", () => {
  for (const url of ["http://127.0.0.1:18020", "http://localhost:18020", "http://[::1]:18020"]) {
    assert.equal(new LocalLlmClient(url, "lane/auto").label, "local:lane/auto");
  }
  for (const url of ["https://127.0.0.1:18020", "http://example.com", "http://127.0.0.1.example.com", "http://10.0.0.5:18020", "not a url", ""]) {
    assert.throws(() => new LocalLlmClient(url, "m"), /local LLM endpoint/, url);
  }
  for (const model of ["", " m", "m x", "claude\nx", "-m", "x".repeat(101)]) {
    assert.throws(() => new LocalLlmClient("http://127.0.0.1:1", model), /model id/, JSON.stringify(model));
  }
});
