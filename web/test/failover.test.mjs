// The RPC transport's failover: what moves a call to the next endpoint, what does not, and what the page says about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host } from "./fakedom.mjs";

// Imports the site's modules from site/ directly, so this file never touches dist (site.test.mjs rebuilds it).
const root = join(fileURLToPath(import.meta.url), "..", "..");
const js = (f) => import(join(root, "site", "js", f));
const { rpcTransport, failoverPoster, fixtureTransport, SourceError } = await js("sources.js");
const { loadLog } = await js("loadlog.js");
const { renderSource, renderFailure } = await js("views.js");

const A = "https://a.example.org";
const B = "https://b.example.org/rpc";
const C = "https://c.example.org";
const IDX = "https://idx.example.org";

const bytes = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const ok = (v) => ({ ok: true, status: 200, json: async () => v });
const viewReply = (v) => ok({ jsonrpc: "2.0", result: { result: bytes(v), logs: [] } });
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });
const down = () => { throw new TypeError("Failed to fetch"); }; // what a browser throws for a 429 that carries no CORS header too

/** A fetch whose answers are scripted per URL: a function per call, the last one repeating. Records every URL called. */
function scripted(plan) {
  const calls = [];
  const used = {};
  const fetchImpl = async (url) => {
    calls.push(url);
    const list = plan[url] ?? [() => status(404)];
    const n = used[url] ?? 0;
    used[url] = n + 1;
    return list[Math.min(n, list.length - 1)]();
  };
  return { fetchImpl, calls };
}
const sleeper = () => {
  const slept = [];
  return { slept, sleep: async (ms) => void slept.push(ms) };
};
const transport = (plan, urls = [A, B, C]) => {
  const s = scripted(plan);
  const t = sleeper();
  return { ...s, ...t, t: rpcTransport({ rpcUrls: urls, indexerUrl: IDX, account: "token.example.testnet", fetchImpl: s.fetchImpl, sleep: t.sleep }) };
};
const good = [() => viewReply({ n: 1 })];

for (const [name, fail] of [["a rejected fetch (network error, or a 429 without CORS headers)", down], ["a 429", () => status(429)], ["a 503", () => status(503)], ["a 403", () => status(403)], ["a 200 that is not JSON", () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } })]]) {
  test(`a call fails over to the next endpoint at once on ${name}`, async () => {
    const x = transport({ [A]: [fail], [B]: good });
    assert.deepEqual(await x.t.view("get_params"), { n: 1 });
    assert.deepEqual(x.calls, [A, B], "second endpoint tried straight away");
    assert.deepEqual(x.slept, [], "no pause inside a round");
  });
}

test("the endpoint that last worked is where the next call starts, and rpcInUse names it", async () => {
  const x = transport({ [A]: [down], [B]: good });
  assert.equal(x.t.rpcInUse(), A, "before any answer: the first");
  await x.t.view("get_params");
  assert.equal(x.t.rpcInUse(), B);
  x.calls.length = 0;
  await x.t.view("get_policy");
  await x.t.accessKeys().catch(() => null);
  assert.deepEqual(x.calls.slice(0, 2), [B, B], "no retry of the failed endpoint first");
  assert.equal(x.calls.includes(A), false);
});

test("a sticky endpoint that starts failing hands over to the next, wrapping round the list", async () => {
  const x = transport({ [A]: [down], [B]: [() => viewReply({ n: 2 }), down], [C]: good });
  await x.t.view("get_params"); // A is down, B answers and sticks
  assert.deepEqual(await x.t.view("get_params"), { n: 1 }, "B now fails, C answers");
  assert.equal(x.t.rpcInUse(), C);
  assert.deepEqual(x.calls, [A, B, B, C]);
  const wrap = transport({ [A]: [() => viewReply({ n: 5 })], [B]: [down], [C]: [down] }, [A, B, C]);
  await wrap.t.view("get_params");
  assert.equal(wrap.t.rpcInUse(), A);
});

test("after a whole failed round it pauses about 400 ms and tries one more round", async () => {
  const x = transport({ [A]: [down, down], [B]: [() => status(429), () => status(429)], [C]: [() => status(503), () => viewReply({ n: 9 })] });
  assert.deepEqual(await x.t.view("get_params"), { n: 9 });
  assert.deepEqual(x.slept, [400]);
  assert.deepEqual(x.calls, [A, B, C, A, B, C]);
  assert.equal(x.t.rpcInUse(), C);
});

test("with every endpoint down it tries two rounds, pauses once, and reports the failure once", async () => {
  const x = transport({ [A]: [down], [B]: [() => status(429)], [C]: [() => status(503)] });
  const errs = await Promise.allSettled([x.t.view("get_params")]);
  assert.equal(errs[0].status, "rejected");
  const e = errs[0].reason;
  assert.ok(e instanceof SourceError);
  assert.equal(e.source, "rpc");
  assert.equal(e.retryable, true);
  assert.match(e.message, /all 3 endpoints failed/);
  assert.match(e.message, /HTTP 503/, "the last failure is named");
  const unreachable = await transport({ [A]: [down] }, [A]).t.view("get_params").catch((err) => err);
  assert.match(unreachable.message, /unreachable or rate limited/, "a rejected fetch cannot tell a dead host from a throttled one without CORS headers");
  assert.equal(x.calls.length, 6, "two rounds over three endpoints, no more");
  assert.deepEqual(x.slept, [400]);
  const dead = transport({ [A]: [down], [B]: [down], [C]: [down] });
  await assert.rejects(loadLog(dead.t), (err) => err instanceof SourceError && err.source === "rpc");
});

test("a JSON-RPC error is a real answer from the node: it does not fail over and does not pause", async () => {
  const unknownBlock = () => ok({ jsonrpc: "2.0", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } });
  const x = transport({ [A]: [unknownBlock], [B]: good });
  await assert.rejects(x.t.view("get_supply", { blockHeight: 5 }), (e) => e instanceof SourceError && /UNKNOWN_BLOCK/.test(e.message) && e.retryable === false);
  assert.deepEqual(x.calls, [A]);
  assert.deepEqual(x.slept, []);
  assert.equal(x.t.rpcInUse(), A);
});

test("the access-key list and the views share the one failover", async () => {
  const keys = () => ok({ jsonrpc: "2.0", result: { keys: [] } });
  const x = transport({ [A]: [down], [B]: [keys] });
  assert.equal(await x.t.accessKeys(), 0);
  assert.deepEqual(x.calls, [A, B]);
});

test("an indexer that is throttled is retried after the pause; the page's list degrades alone when it stays down", async () => {
  const rows = () => ok({ account_txs: [] });
  const once = transport({ [`${IDX}/v0/account`]: [() => status(429), rows] });
  assert.deepEqual(await once.t.hashPage(), { newest: [], next: null });
  assert.deepEqual(once.slept, [400]);

  const x = transport({ [`${IDX}/v0/account`]: [() => status(429)] });
  await assert.rejects(x.t.hashPage(), (e) => e instanceof SourceError && e.source === "indexer" && e.retryable && e.status === 429);
  assert.equal(x.calls.filter((u) => u.startsWith(IDX)).length, 2, "one endpoint: two attempts with a pause between");
});

test("a failed index leaves the chain's own numbers on screen and says only the transaction log is incomplete", async () => {
  const fixture = JSON.parse(await readFile(join(root, "fixtures", "sandbox-run.json"), "utf8"));
  const t = fixtureTransport(fixture);
  t.hashPage = async () => {
    throw new SourceError("indexer", "all 1 endpoints failed", { retryable: true, status: 429 });
  };
  const d = await loadLog(t);
  assert.equal(d.status, "incomplete");
  assert.equal(d.retryable, true);
  assert.deepEqual(d.entries, []);
  assert.ok(d.supply && d.policy && d.params, "the chain's views are still there");
});

test("failoverPoster needs at least one endpoint", () => {
  assert.throws(() => failoverPoster(async () => ok({}), "rpc", []), /no rpc endpoint/);
  assert.throws(() => failoverPoster(async () => ok({}), "rpc", undefined), /no rpc endpoint/);
});

test("'Views come from' names the endpoint in use, or every candidate before one has answered", () => {
  const config = { account: "token.example.testnet", network: "testnet", rpcUrls: [A, B, C], indexerUrl: IDX };
  const text = (rpcUrl) => {
    const doc = fakeDoc();
    const x = host(doc);
    renderSource(doc, x, { mode: "live", config, fixture: null, rpcUrl });
    return x.textContent;
  };
  assert.match(text(null), /Views come from a\.example\.org or b\.example\.org or c\.example\.org, the transaction list from idx\.example\.org\./);
  assert.match(text(B), /Views come from b\.example\.org, the transaction list from idx\.example\.org\./);
  assert.doesNotMatch(text(B), /a\.example\.org/);
});

test("when everything is down the page says so plainly and points at no config file", () => {
  const doc = fakeDoc();
  const x = host(doc);
  renderFailure(doc, x, new SourceError("rpc", "all 3 endpoints failed, the last: rate limited", { retryable: true }));
  assert.match(x.textContent, /The chain could not be read \(all 3 endpoints failed, the last: rate limited\)\. No number is shown rather than a wrong one\./);
  assert.doesNotMatch(x.textContent, /config\.js/);
});
