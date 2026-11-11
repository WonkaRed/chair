import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BOOK } from "../src/press-book.js";
import type { Reply } from "../src/press-overreach.js";
import { createPressServer, listen } from "../src/press-server.js";
import { PressStore } from "../src/press-store.js";
import { tempDir } from "./helpers.js";

async function withDesk(overreach: { start(raw: unknown, who: string): Promise<Reply>; poll(id: string): Reply } | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const dir = tempDir("overreach-server");
  const server = createPressServer({ store: new PressStore(join(dir, "press.jsonl")), answer: () => Promise.resolve({ answer: BOOK[0]!, source: "model" as const }), available: () => true, ...(overreach === undefined ? {} : { overreach }) });
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (base: string, body: string, type = "application/json"): Promise<Response> => fetch(`${base}/overreach`, { method: "POST", headers: { "content-type": type }, body });

test("POST /overreach hands the rate and the visitor's key to the service and relays its status, body and retry-after", async () => {
  const seen: unknown[] = [];
  const svc = {
    start: (raw: unknown, who: string): Promise<Reply> => {
      seen.push(raw, who);
      return Promise.resolve({ status: 429, body: { error: "The Chair is composing itself", retry_after_s: 7 }, headers: { "retry-after": 7 } });
    },
    poll: (id: string): Reply => ({ status: 200, body: { id, status: "waiting" } }),
  };
  await withDesk(svc, async (base) => {
    const res = await fetch(`${base}/overreach`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify({ rate_bps: 500 }) });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
    assert.deepEqual(await res.json(), { error: "The Chair is composing itself", retry_after_s: 7 });
    assert.deepEqual(seen, [500, "203.0.113.9"]);
    const poll = await fetch(`${base}/overreach/abc`);
    assert.deepEqual(await poll.json(), { id: "abc", status: "waiting" });
  });
});

test("POST /overreach: wrong content type, broken JSON, a non-object, an oversized body are 400 and never reach the service", async () => {
  let called = 0;
  const svc = { start: (): Promise<Reply> => (called++, Promise.resolve({ status: 200, body: {} })), poll: (): Reply => ({ status: 404, body: {} }) };
  await withDesk(svc, async (base) => {
    assert.equal((await post(base, '{"rate_bps":5}', "text/plain")).status, 400);
    assert.equal((await post(base, "{nope")).status, 400);
    assert.equal((await post(base, "[5]")).status, 400);
    assert.equal((await post(base, "5")).status, 400);
    assert.equal((await post(base, JSON.stringify({ rate_bps: 5, pad: "x".repeat(2000) }))).status, 400);
  });
  assert.equal(called, 0);
});

test("without the overreach service the routes answer that the desk is closed; wrong methods are 405", async () => {
  await withDesk(undefined, async (base) => {
    assert.equal((await post(base, '{"rate_bps":500}')).status, 503);
    assert.equal((await fetch(`${base}/overreach/abc`)).status, 503);
  });
  const svc = { start: (): Promise<Reply> => Promise.resolve({ status: 200, body: {} }), poll: (): Reply => ({ status: 404, body: {} }) };
  await withDesk(svc, async (base) => {
    assert.equal((await fetch(`${base}/overreach`)).status, 405);
    assert.equal((await fetch(`${base}/overreach/abc`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${base}/overreach/${"x".repeat(80)}`)).status, 404);
  });
});
