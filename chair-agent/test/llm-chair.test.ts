import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ANSWER_SCHEMA, AnthropicLlmClient, LLM_MODEL, LlmChair, LocalLlmClient, buildPrompt, llmConfigured, parseAnswer } from "../src/llm-chair.js";
import { MODEL_REASONS } from "../src/choice.js";
import { ChairFailure, propose } from "../src/decide.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

const WINDOW = { lo: -50, hi: 50 };
const COIN = 10n ** 24n;
const input = (o: Parameters<typeof snapshot>[0] = {}, history: DecisionInput["history"] = [], memory?: DecisionInput["memory"]): DecisionInput => ({
  snapshot: snapshot(o), history, window: WINDOW, ...(memory === undefined ? {} : { memory }),
});
const facts = (i: DecisionInput) => JSON.parse(buildPrompt(i).user) as Record<string, unknown>;

test("the prompt is numbers and our own sentences only: no account ids, no supply in full, no free-form chain text", () => {
  const i = input({ supply: 123_456_789n * COIN, staked: 1_000n * COIN, chair: "chair.test", rate: 30 }, [{ epoch: 4, totalSupply: 100n }]);
  const { system, user } = buildPrompt(i);
  assert.deepEqual(Object.keys(JSON.parse(user) as object).sort(), [
    "allowed_bps", "coins_staked", "coins_staked_the_mandate_wants", "formula_bps", "meetings_in_a_row_the_chair_set_the_rate_in_effect",
    "meetings_missed_since_the_last_decision", "rate_in_effect_bps", "reasons", "supply_change",
  ]);
  assert.ok(!user.includes("chair.test") && !user.includes("123456789"));
  assert.match(system, /no financial advice/);
  assert.doesNotMatch(system, /[\u2013\u2014\p{Extended_Pictographic}]/u, "the prompt itself uses no em or en dash or emoji");
});

test("the formula is given as advice with the band around it, inside what the contract accepts, and the facts it rests on", () => {
  const f = facts(input({ rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN })); // 10% staked asks for +100; one step is +50
  assert.equal(f["rate_in_effect_bps"], 0);
  assert.equal(f["formula_bps"], 50);
  assert.deepEqual(f["allowed_bps"], [25, 50], "25 either side, cut by the window the contract accepts");
  assert.equal(f["coins_staked"], "10.00%");
  assert.equal(f["coins_staked_the_mandate_wants"], "50.00%");
  const mid = facts(input({ rate: 3, supply: 1_000_000n * COIN, staked: 480_000n * COIN })); // wants +5, 2 away: inside the dead band, so the formula holds the rate
  assert.equal(mid["formula_bps"], 3);
  assert.deepEqual(mid["allowed_bps"], [-22, 28]);
});

test("only reasons that some rate in the band can truthfully have are offered, with where the rate must lie", () => {
  const offered = (o: Parameters<typeof snapshot>[0], history: DecisionInput["history"] = []) => (facts(input(o, history))["reasons"] as { id: string; because: string; rate_lies: string }[]).map((r) => r.id);
  assert.deepEqual(offered({ rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN }), ["stake_low", "smaller_move"], "10% staked, no history: nothing about supply; a step of 50 cannot be made larger");
  assert.ok(offered({ rate: 0, supply: 1_000_000n * COIN, staked: 800_000n * COIN }).includes("stake_high"));
  assert.ok(!offered({ rate: 0, supply: 1_000_000n * COIN, staked: 800_000n * COIN }).includes("stake_low"));
  const grown = offered({ epoch: 20, supply: 1_001_000n * COIN, staked: 100_000n * COIN }, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]);
  assert.ok(grown.includes("supply_up") && !grown.includes("supply_down"));
  const shrunk = offered({ epoch: 20, supply: 999_000n * COIN, staked: 100_000n * COIN }, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]);
  assert.ok(shrunk.includes("supply_down") && !shrunk.includes("supply_up"));
  assert.deepEqual(offered({ staked: null }).sort(), ["larger_move", "steady"], "no staking figures: the formula holds 0; the Chair may stay, or move, which is more than the formula's none");
  const first = (facts(input({ rate: 0, staked: 0n }))["reasons"] as { id: string; rate_lies: string }[])[0]!;
  assert.deepEqual(first, { id: "stake_low", because: "fewer than half of all coins are staked", rate_lies: "at or above the formula's number" });
});

test("supply change is the sentence of the coins that moved, and null without a logged meeting", () => {
  const said = (supply: bigint, history: DecisionInput["history"]) => facts(input({ epoch: 20, supply }, history))["supply_change"];
  assert.equal(said(1_001_563n * COIN, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]), "Supply is up 1,563 coins since the last meeting.");
  assert.equal(said(1_000_000n * COIN, []), null);
});

test("the run of meetings is given only from 2, and a silence is told from a decision made last meeting", () => {
  const run = (sameRateEpochs: number | undefined) => facts(input({ rate: 22 }, [], sameRateEpochs === undefined ? undefined : { sameRateEpochs, refusals: 0, remarks: [] }))["meetings_in_a_row_the_chair_set_the_rate_in_effect"];
  assert.equal(run(undefined), null);
  assert.equal(run(1), null);
  assert.equal(run(7), 7);
  const at = (lastSet: number | null) => facts(input({ epoch: 218, lastSet }))["meetings_missed_since_the_last_decision"];
  assert.equal(at(217), 0);
  assert.equal(at(43), 174);
  assert.equal(at(null), null);
});

test("the schema offers our reasons and nothing else, and the system prompt names the formula as advice and the Chair's own mind", () => {
  assert.deepEqual(ANSWER_SCHEMA.properties.reason.enum, MODEL_REASONS);
  assert.deepEqual(Object.keys(ANSWER_SCHEMA.properties), ["rate_bps", "reason"]);
  const { system } = buildPrompt(input());
  assert.match(system, /It is advice, not an order/);
  assert.match(system, /any whole number inside allowed_bps/);
  assert.match(system, /Take the formula's number when you agree with it/);
  assert.doesNotMatch(system, /at random|deviate/i, "the Chair is given a temperament and the facts, never an order to differ");
});

test("parseAnswer accepts exactly the schema: a rate and one of our reasons", () => {
  assert.deepEqual(parseAnswer({ text: '{"rate_bps": -30, "reason": "stake_high"}', stopReason: "end_turn" }), { rateBps: -30, reason: "stake_high" });
  for (const text of ['{"rate_bps": 5, "reason": "because I say so"}', '{"rate_bps": 5, "reason": "Steady"}', '{"rate_bps": "5", "reason": "steady"}', '{"rate_bps": 5.5, "reason": "steady"}', '{"rate_bps": 5, "reasoning": "x"}']) {
    assert.throws(() => parseAnswer({ text, stopReason: "end_turn" }), (e: unknown) => e instanceof ChairFailure && e.reason === "malformed", text);
  }
  assert.throws(() => parseAnswer({ text: "", stopReason: "refusal" }), (e: unknown) => e instanceof ChairFailure && e.reason === "refusal");
});

test("a choice outside the band, or with a reason that does not fit, is a malformed answer that names our check, asked for once more; the chair itself only parses", async () => {
  const i = input({ rate: 0, supply: 1_000_000n * COIN, staked: 100_000n * COIN }); // formula +50, band 25..50
  const answering = (rate: number, reason: string) => {
    const prompts: string[] = [];
    const chair = new LlmChair({ label: "llm:stand-in", complete: (req) => { prompts.push(req.user); return Promise.resolve({ text: JSON.stringify(req.schema === undefined ? { rate_bps: rate, reason } : { remark: "" }), stopReason: "end_turn" }); } });
    return { chair, prompts };
  };
  const ok = answering(30, "smaller_move");
  assert.deepEqual((await propose(i.snapshot, [], { chair: ok.chair, marginMs: 15_000, timeoutMs: 30_000 })).proposal, { rateBps: 30, reason: "smaller_move" });
  assert.deepEqual((await propose(i.snapshot, [], { chair: answering(50, "stake_low").chair, marginMs: 15_000, timeoutMs: 30_000 })).proposal, { rateBps: 50, reason: "stake_low" }, "the formula's own number, with a true reason");
  const said = { rate_outside_band: /rate_bps was not inside allowed_bps/, reason_points_other_way: /not on the side of the formula/, reason_not_true: /reason was not true of this meeting/ };
  for (const [rate, reason, fault] of [[24, "smaller_move", "rate_outside_band"], [51, "stake_low", "rate_outside_band"], [30, "stake_low", "reason_points_other_way"], [50, "stake_high", "reason_not_true"], [50, "steady", "reason_not_true"], [50, "smaller_move", "reason_not_true"], [30, "larger_move", "reason_not_true"]] as const) {
    const bad = answering(rate, reason);
    const p = await propose(i.snapshot, [], { chair: bad.chair, marginMs: 15_000, timeoutMs: 30_000 });
    assert.equal(p.kind, "rule-fallback", `${rate} ${reason}`);
    assert.equal(bad.prompts.length, 2, "asked once more");
    assert.match(bad.prompts[1]!, said[fault], `${rate} ${reason}: the retry names what was wrong, in our words`);
  }
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
        content: [{ type: "text", text: '{"rate_bps": 5, "reason": "steady"}' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const client = new AnthropicLlmClient({ baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: "test-key-not-real" });
    const out = await client.complete({ system: "S", user: "U", signal: new AbortController().signal });
    assert.deepEqual(out, { text: '{"rate_bps": 5, "reason": "steady"}', stopReason: "end_turn" });
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
    '{"rate_bps": 10, "rate_bps": 20, "reason": "steady"}',
    '{"rate_bps": 10, "reason": "steady", "reason": "stake_low"}',
    '{"rate_bps": 10, "rate_b\\u0070s": 20, "reason": "steady"}',
    '{"rate_bps": 10, "reason": "steady", "extra": 1}',
  ]) assert.throws(() => ok(text), /schema/, text);
  assert.deepEqual(ok('{"reason": "steady", "rate_bps": 10}'), { rateBps: 10, reason: "steady" });
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
