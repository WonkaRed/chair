import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ANSWER_SCHEMA, AnthropicLlmClient, LLM_MODEL, LlmChair, buildPrompt, llmConfigured, parseAnswer } from "../src/llm-chair.js";
import { snapshot } from "./helpers.js";

test("the prompt is numbers only: no account ids and no free-form chain text", () => {
  const snap = snapshot({ supply: 123_456_789n, staked: 1_000n, chair: "chair.test", rate: 30 });
  const { system, user } = buildPrompt({ snapshot: snap, history: [{ epoch: 4, totalSupply: 100n }], window: { lo: -20, hi: 80 } });
  const data = JSON.parse(user) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), [
    "epoch", "rate_in_effect_bps", "rate_window_bps", "recent_supply", "staked_share_bps", "streak_epochs",
    "supply_change_bps_last_6_epochs", "total_supply",
  ]);
  assert.ok(!user.includes("chair.test"));
  assert.deepEqual(data["rate_window_bps"], [-20, 80]);
  assert.match(system, /no financial advice/);
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
