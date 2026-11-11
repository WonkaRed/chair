import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ANSWER_SCHEMA, AnthropicLlmClient, LLM_MODEL, LlmChair, LocalLlmClient, buildPrompt, llmConfigured, parseAnswer, wordingFault } from "../src/llm-chair.js";
import { ChairFailure } from "../src/decide.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

test("the prompt is numbers only: no account ids and no free-form chain text", () => {
  const snap = snapshot({ supply: 123_456_789n, staked: 1_000n, chair: "chair.test", rate: 30 });
  const { system, user } = buildPrompt({ snapshot: snap, history: [{ epoch: 4, totalSupply: 100n }], window: { lo: -20, hi: 80 } });
  const data = JSON.parse(user) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), [
    "epoch", "epochs_since_last_decision", "epochs_this_chair_has_held_the_seat", "rate_in_effect_bps", "rate_window_bps",
    "recent_supply", "staked_share_percent", "supply_change_bps_last_6_epochs", "total_supply",
  ]);
  assert.ok(!("streak_epochs" in data) && !user.includes("streak"), "the old, misread field name is gone");
  assert.ok(!user.includes("chair.test"));
  assert.deepEqual(data["rate_window_bps"], [-20, 80]);
  assert.match(system, /no financial advice/);
  assert.ok(!system.includes("streak"), "the field names carry the meaning; the system prompt defines none");
});

test("the system prompt gives the chair its voice and the guard rails that keep every sentence true to the numbers", () => {
  const { system } = buildPrompt({ snapshot: snapshot(), history: [], window: { lo: -50, hi: 50 } });
  assert.match(system, /"The Chair", a deadpan parody of a central banker/);
  assert.match(system, /Committee of One/);
  for (const rule of [/Claim only what the numbers show/, /never forecast or promise/, /nothing about price, value/, /When a figure is null, do not mention it/, /Name no real person, institution, currency, central bank or place/, /No em or en dashes, no emoji/]) {
    assert.match(system, rule);
  }
  assert.doesNotMatch(system, /[\u2013\u2014\p{Extended_Pictographic}]|moon/u, "the prompt itself uses no em or en dash, emoji or hype");
});

const WINDOW = { lo: -50, hi: 50 };

test("the staked share is handed over as a percent, so the minutes never say \"4450 basis points\"", () => {
  const share = (staked: bigint | null, supply = 10_000n) => JSON.parse(buildPrompt({ snapshot: snapshot({ supply, staked }), history: [], window: WINDOW }).user)["staked_share_percent"] as unknown;
  assert.equal(share(4450n), "44.5%");
  assert.equal(share(4400n), "44%");
  assert.equal(share(1n, 3n), "33.33%");
  assert.equal(share(null), null, "no staking figures: nothing to say");
  assert.equal(share(0n, 0n), null, "no supply: nothing to say");
  const { system } = buildPrompt({ snapshot: snapshot(), history: [], window: WINDOW });
  assert.match(system, /staked_share_percent gives it \("44\.5%"\), never in basis points/);
  assert.match(system, /the new rate too: "from 17 basis points to 22 basis points", never "to 22" alone/);
});

test("the run of epochs describes the rate before the decision, and a run of one is nothing to say", () => {
  const run = (sameRateEpochs: number) => JSON.parse(buildPrompt({ snapshot: snapshot({ rate: 22 }), history: [], window: WINDOW, memory: { sameRateEpochs, refusals: 0 } }).user)["epochs_in_a_row_the_chair_set_the_rate_in_effect"] as unknown;
  assert.equal(run(0), null);
  assert.equal(run(1), null, "\"one epoch in a row\" is never said");
  assert.equal(run(2), 2);
  assert.equal(run(5), 5);
  const { system } = buildPrompt({ snapshot: snapshot(), history: [], window: WINDOW });
  assert.match(system, /the rate from before this decision/);
  assert.match(system, /Use it only when you hold, that is when your rate equals rate_in_effect_bps/);
  assert.match(system, /when you change the rate it says nothing about the new rate, so do not mention it and never write "in a row"/);
  assert.ok(!system.includes("this same rate N epochs in a row"), "the phrase that read as a contradiction is gone");
});

test("wordingFault refuses the phrasings that read as the Chair contradicting itself, and passes the clean ones", () => {
  const input = (rate: number, sameRateEpochs: number): DecisionInput => ({ snapshot: snapshot({ rate }), history: [], window: WINDOW, memory: { sameRateEpochs, refusals: 0 } });
  const fault = (reasoning: string, rateBps: number, i = input(17, 5)) => wordingFault({ rateBps, reasoning }, i);
  // The finding: a raise to 22 that claims the old rate's run.
  assert.match(fault("The Chair raises the rate by 5 basis points to 22 basis points. The Chair has set this same rate 5 epochs in a row.", 22)!, /run of epochs/);
  assert.match(fault("The Chair holds. The Chair has set this rate three epochs in a row.", 17, input(17, 1))!, /run of epochs/, "no run of two or more on record");
  assert.match(fault("The Chair holds. The Chair has set this rate two consecutive times.", 17, { snapshot: snapshot({ rate: 17 }), history: [], window: WINDOW })!, /run of epochs/, "no log, no run");
  assert.equal(fault("The Chair holds the rate at 17 basis points and also set it in each of the 5 epochs before this one.", 17), null, "holding, with a run, may say it");
  assert.equal(fault("The Chair holds the rate at 17 basis points, 5 epochs in a row.", 17), null, "a hold with a run of five may say \"in a row\"");
  // No unit.
  assert.match(fault("The Chair cuts the rate by 5 basis points to 12.", 12)!, /without its unit/);
  assert.match(fault("The Chair holds the rate at 17, as the numbers allow.", 17)!, /without its unit/);
  assert.match(fault("The Chair moves the rate from 22 to \u22125.", -5)!, /without its unit/);
  assert.equal(fault("The Chair cuts the rate from 22 basis points to 17 basis points.", 17), null);
  assert.equal(fault("The Chair holds at 17 bps. The staked share is 44.5%. Supply moved over 6 epochs.", 17), null);
  assert.equal(fault("The staked share stands at 44.5%, and the Chair raises the rate to 22 basis points.", 22), null);
  // Staked share in basis points.
  assert.match(fault("The staked share stands at 4450 basis points.", 17)!, /staked share in basis points/);
  assert.match(fault("Staked tokens are 4450 bps of supply.", 17)!, /staked share in basis points/);
});

test("the chair tries once more when the first answer reads as a contradiction, and falls back when the second does too", async () => {
  const input = { snapshot: snapshot({ rate: 17 }), history: [], window: WINDOW };
  const answers = (...texts: string[]) => {
    const asked: number[] = [];
    const chair = new LlmChair({ complete: () => { asked.push(asked.length); return Promise.resolve({ text: JSON.stringify({ rate_bps: 22, reasoning: texts[Math.min(asked.length - 1, texts.length - 1)] }), stopReason: "end_turn" }); } });
    return { chair, asked };
  };
  const bad = "The Chair raises the rate by 5 basis points to 22.";
  const good = "The Chair raises the rate by 5 basis points, from 17 basis points to 22 basis points.";
  const retried = answers(bad, good);
  assert.equal((await retried.chair.propose(input, new AbortController().signal)).reasoning, good);
  assert.equal(retried.asked.length, 2);
  const clean = answers(good);
  await clean.chair.propose(input, new AbortController().signal);
  assert.equal(clean.asked.length, 1, "a clean answer is not asked for twice");
  const stubborn = answers(bad);
  await assert.rejects(stubborn.chair.propose(input, new AbortController().signal), (e: unknown) => e instanceof ChairFailure && e.reason === "malformed" && /without its unit/.test(e.message));
  assert.equal(stubborn.asked.length, 2, "two attempts, then the rule chair decides");
});

test("the prompt separates the time in office from the time since the last decision", () => {
  const at = (lastSet: number | null) => JSON.parse(buildPrompt({
    snapshot: snapshot({ epoch: 218, lastSet }), history: [], window: { lo: -50, hi: 50 },
  }).user) as Record<string, unknown>;
  assert.equal(at(217)["epochs_since_last_decision"], 0, "decided in the previous epoch");
  assert.equal(at(43)["epochs_since_last_decision"], 174);
  assert.equal(at(null)["epochs_since_last_decision"], null, "no decision has ever been made");
  assert.equal(at(43)["epochs_this_chair_has_held_the_seat"], 218, "the seat count is the contract's streak, unchanged by decisions");
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
