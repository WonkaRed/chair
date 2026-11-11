import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { createPressServer, listen, MAX_BODY_BYTES, type PressServerOptions } from "../src/press-server.js";
import { PressStore } from "../src/press-store.js";
import { reasoningHash } from "../src/reasoning.js";
import { tempDir } from "./helpers.js";

interface Desk {
  base: string;
  server: Server;
  store: PressStore;
  asked: string[];
  setAvailable(v: boolean): void;
  close(): Promise<void>;
}

async function desk(o: Partial<PressServerOptions> = {}): Promise<Desk> {
  const dir = tempDir("press-server");
  const store = new PressStore(join(dir, "press.jsonl"));
  const asked: string[] = [];
  let available = true;
  const server = createPressServer({
    store,
    answer: (q) => { asked.push(q); return Promise.resolve({ answer: "The Chair has noted it.", source: "model" as const }); },
    available: () => available,
    ...o,
  });
  const port = await listen(server, 0);
  return {
    base: `http://127.0.0.1:${port}`, server, store, asked,
    setAvailable: (v) => { available = v; },
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); rmSync(dir, { recursive: true, force: true }); },
  };
}

const post = (d: Desk, body: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${d.base}/ask`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
const ask = (d: Desk, question: unknown, headers: Record<string, string> = {}): Promise<Response> => post(d, JSON.stringify({ question }), headers);

test("the server listens on 127.0.0.1 only", async () => {
  const d = await desk();
  try {
    assert.deepEqual({ address: (d.server.address() as { address: string }).address }, { address: "127.0.0.1" });
  } finally {
    await d.close();
  }
});

test("POST /ask answers with the fixed shape; the hash is the SHA-256 of the cleaned question; the record shows it without the question", async () => {
  const d = await desk();
  try {
    const res = await ask(d, "  Who   watches\nthe Chair?  ");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["answer", "asked_at_ms", "id", "question_hash", "status"]);
    assert.equal(body["status"], "answered");
    assert.equal(body["answer"], "The Chair has noted it.");
    assert.equal(body["question_hash"], reasoningHash("Who watches the Chair?"));
    assert.deepEqual(d.asked, ["Who watches the Chair?"], "the model is given the cleaned question");
    assert.ok(Number.isSafeInteger(body["asked_at_ms"]));

    const rec = await fetch(`${d.base}/record`);
    const text = await rec.text();
    assert.ok(!text.includes("watches") && !text.includes("Who"), "the public record never carries the question");
    const parsed = JSON.parse(text) as { taking_questions: boolean; entries: Record<string, unknown>[] };
    assert.equal(parsed.taking_questions, true);
    assert.deepEqual(parsed.entries, [{ id: body["id"], question_hash: body["question_hash"], answer: body["answer"], asked_at_ms: body["asked_at_ms"], epoch: null, tx_hash: null }]);

    d.store.markEntered(`A member of the press asked a question (${reasoningHash("Who watches the Chair?").slice(0, 12)}). The Chair replied: The Chair has noted it.`, 7, "tx7");
    const after = ((await (await fetch(`${d.base}/record`)).json()) as { entries: { epoch: number; tx_hash: string }[] }).entries[0]!;
    assert.deepEqual([after.epoch, after.tx_hash], [7, "tx7"]);
  } finally {
    await d.close();
  }
});

test("bad input is a 400 with an error, and never reaches the model", async () => {
  const d = await desk({ limits: { perIpCount: 1000, globalCount: 1000 } });
  try {
    const cases: [string, Promise<Response>][] = [
      ["not json", post(d, "{nope")],
      ["array", post(d, "[]")],
      ["no question", post(d, "{}")],
      ["number", ask(d, 5)],
      ["empty", ask(d, "")],
      ["blank", ask(d, " \n\t ")],
      ["invisible only", ask(d, "​‏")],
      ["141 characters", ask(d, "x".repeat(141))],
      ["wrong content type", fetch(`${d.base}/ask`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ question: "hi" }) })],
      ["body over 1 KiB", post(d, JSON.stringify({ question: "hi", pad: "x".repeat(MAX_BODY_BYTES) }))],
    ];
    for (const [name, p] of cases) {
      const res = await p;
      assert.equal(res.status, 400, name);
      const body = (await res.json()) as { error: unknown };
      assert.equal(typeof body.error, "string", name);
    }
    assert.deepEqual(d.asked, []);
    assert.equal((await ask(d, "x".repeat(140))).status, 200, "140 characters is allowed");
    assert.equal((await ask(d, "é".repeat(140))).status, 200, "140 characters is counted as characters, not bytes");
  } finally {
    await d.close();
  }
});

test("rate limits: 3 per visitor per 10 minutes, 30 per hour in all; Retry-After says when; a full limit costs no model call", async () => {
  let t = 1_000_000;
  const d = await desk({ now: () => t });
  try {
    const ip = (n: number): Record<string, string> => ({ "cf-connecting-ip": `203.0.113.${n}` });
    for (let i = 0; i < 3; i++) assert.equal((await ask(d, `q${i}`, ip(1))).status, 200);
    const limited = await ask(d, "q4", ip(1));
    assert.equal(limited.status, 429);
    assert.equal(typeof ((await limited.json()) as { error: unknown }).error, "string");
    assert.equal(Number(limited.headers.get("retry-after")), 600);
    assert.equal(d.asked.length, 3);
    assert.equal((await ask(d, "other visitor", ip(2))).status, 200, "another visitor is not limited");
    t += 10 * 60_000 + 1;
    assert.equal((await ask(d, "again", ip(1))).status, 200, "the window slides");
    // IPv6: the whole /64 is one visitor.
    for (let i = 0; i < 3; i++) assert.equal((await ask(d, `v6-${i}`, { "cf-connecting-ip": `2001:db8:1:2:${i}::${i + 1}` })).status, 200);
    assert.equal((await ask(d, "v6", { "cf-connecting-ip": "2001:db8:1:2:ffff::1" })).status, 429);
  } finally {
    await d.close();
  }
  let g = 5_000_000;
  const e = await desk({ now: () => g, limits: { perIpCount: 1000, globalCount: 30 } });
  try {
    for (let i = 0; i < 30; i++) assert.equal((await ask(e, `g${i}`)).status, 200);
    assert.equal((await ask(e, "one too many")).status, 429);
    g += 60 * 60_000 + 1;
    assert.equal((await ask(e, "next hour")).status, 200);
  } finally {
    await e.close();
  }
});

test("503 when the Chair is not taking questions, and when the queue is full; one model call at a time", async () => {
  const d = await desk();
  try {
    d.setAvailable(false);
    const res = await ask(d, "hello");
    assert.equal(res.status, 503);
    assert.equal(typeof ((await res.json()) as { error: unknown }).error, "string");
    assert.equal(((await (await fetch(`${d.base}/record`)).json()) as { taking_questions: boolean }).taking_questions, false);
    assert.equal(d.asked.length, 0);
  } finally {
    await d.close();
  }

  let running = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const e = await desk({
    limits: { perIpCount: 1000, globalCount: 1000 },
    answer: () => new Promise((resolve) => {
      running++;
      peak = Math.max(peak, running);
      release.push(() => { running--; resolve({ answer: "Noted.", source: "model" }); });
    }),
  });
  try {
    const pending = Array.from({ length: 6 }, (_, i) => ask(e, `queued ${i}`));
    for (let i = 0; i < 100 && release.length < 1; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(release.length, 1, "one model call runs, five wait");
    await new Promise((r) => setTimeout(r, 50));
    const full = await ask(e, "one too many");
    assert.equal(full.status, 503, "the queue holds five");
    for (let n = 0; n < 6; n++) {
      for (let i = 0; i < 100 && release.length <= n; i++) await new Promise((r) => setTimeout(r, 10));
      release[n]!();
    }
    assert.deepEqual((await Promise.all(pending)).map((r) => r.status), [200, 200, 200, 200, 200, 200]);
    assert.equal(peak, 1, "never two model calls at once");
  } finally {
    await e.close();
  }
});

test("a record that cannot be written is a 503, not a crash", async () => {
  const d = await desk();
  try {
    d.store.add = () => { throw new Error("disk full"); };
    assert.equal((await ask(d, "hello")).status, 503);
    assert.equal((await fetch(`${d.base}/health`)).status, 200, "the server is still up");
  } finally {
    await d.close();
  }
});

test("CORS: the page and a local page are allowed, everyone else gets no allow header; preflight is answered", async () => {
  const d = await desk({ limits: { perIpCount: 1000, globalCount: 1000 } });
  try {
    const allow = async (origin: string): Promise<string | null> => (await fetch(`${d.base}/health`, { headers: { origin } })).headers.get("access-control-allow-origin");
    assert.equal(await allow("https://wonkared.github.io"), "https://wonkared.github.io");
    assert.equal(await allow("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
    assert.equal(await allow("http://localhost:5173"), "http://localhost:5173");
    assert.equal(await allow("http://localhost"), "http://localhost");
    for (const bad of ["https://evil.example", "https://wonkared.github.io.evil.example", "http://wonkared.github.io", "https://evilwonkared.github.io", "http://localhost.evil.example", "http://127.0.0.1.evil.example:80", "null"]) {
      assert.equal(await allow(bad), null, bad);
    }
    const pre = await fetch(`${d.base}/ask`, { method: "OPTIONS", headers: { origin: "https://wonkared.github.io", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), "https://wonkared.github.io");
    assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/i);
    assert.equal(pre.headers.get("vary"), "Origin");
    const answered = await ask(d, "hi", { origin: "https://wonkared.github.io" });
    assert.equal(answered.headers.get("access-control-allow-origin"), "https://wonkared.github.io", "error and success replies alike");
    const refused = await post(d, "{", { origin: "https://wonkared.github.io" });
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get("access-control-allow-origin"), "https://wonkared.github.io");
  } finally {
    await d.close();
  }
});

test("GET /record: newest first, default 20, at most 50, a bad limit is a 400; /health; unknown paths and methods", async () => {
  const d = await desk();
  try {
    for (let i = 0; i < 60; i++) d.store.add({ id: `id-${i}`, question: `q${i}`, questionHash: reasoningHash(`q${i}`), answer: `A${i}`, source: "model", askedAtMs: 1000 + i });
    const get = async (qs: string): Promise<{ status: number; entries: { id: string }[] }> => {
      const r = await fetch(`${d.base}/record${qs}`);
      return { status: r.status, entries: ((await r.json()) as { entries?: { id: string }[] }).entries ?? [] };
    };
    const dflt = await get("");
    assert.equal(dflt.entries.length, 20);
    assert.equal(dflt.entries[0]!.id, "id-59");
    assert.equal((await get("?limit=3")).entries.length, 3);
    assert.equal((await get("?limit=500")).entries.length, 50);
    for (const bad of ["?limit=0", "?limit=-1", "?limit=abc", "?limit=1.5", "?limit="]) assert.equal((await get(bad)).status, 400, bad);
    assert.deepEqual(await (await fetch(`${d.base}/health`)).json(), { ok: true });
    assert.equal((await fetch(`${d.base}/nope`)).status, 404);
    assert.equal((await fetch(`${d.base}/__proto__`)).status, 404);
    assert.equal((await fetch(`${d.base}/ask`)).status, 405);
    assert.equal((await fetch(`${d.base}/record`, { method: "POST", body: "{}" })).status, 405);
  } finally {
    await d.close();
  }
});

test("chair-agent press takes questions through the real command and stops on abort; without a model endpoint it refuses to start", async () => {
  const dir = tempDir("press-cli");
  const ac = new AbortController();
  const out: string[] = [];
  const llmClient = { complete: () => Promise.resolve({ text: JSON.stringify({ answer: "The Chair has noted it." }), stopReason: "end_turn" }) };
  try {
    const file = join(dir, "press.jsonl");
    const done = main(["press", "--port", "0", "--press", file], {}, { out: (l) => out.push(l), err: (l) => out.push(l) }, { llmClient, signal: ac.signal });
    for (let i = 0; i < 100 && !out.some((l) => l.includes("press on 127.0.0.1")); i++) await new Promise((r) => setTimeout(r, 20));
    const port = /127\.0\.0\.1:(\d+)/.exec(out.join("\n"))?.[1];
    assert.ok(port !== undefined, out.join("\n"));
    const res = await fetch(`http://127.0.0.1:${port}/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: "hello Chair" }) });
    assert.equal(res.status, 200);
    assert.equal(new PressStore(file).recent(5).length, 1);
    assert.ok(out.some((l) => /^answered \S+ [0-9a-f]{12} (model|canned)$/.test(l)), "the log line names no question and no asker");
    ac.abort();
    assert.equal(await done, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const refused: string[] = [];
  assert.equal(await main(["press", "--port", "0"], {}, { out: () => undefined, err: (l) => refused.push(l) }), 2);
  assert.match(refused.join("\n"), /--llm-endpoint and --llm-model/);
});
