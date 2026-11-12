// What a reload costs the transaction index, and what the page shows when the index cannot be read: settled transactions kept per hash in
// storage, retries with a pause, and a hero that always has something true to say. No test waits on a real timer: the pause is injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host } from "./fakedom.mjs";

// Imports the site's modules from site/ directly, so this file never touches dist (site.test.mjs rebuilds it).
const root = join(fileURLToPath(import.meta.url), "..", "..");
const js = (f) => import(join(root, "site", "js", f));
const { rpcTransport, fixtureTransport } = await js("sources.js");
const { loadEarlier, loadLog, parseSupply } = await js("loadlog.js");
const { buildEntries, reconcileWindow } = await js("ledger.js");
const { decisionsOfTxs, refusalsOfTxs } = await js("decisions.js");

const { renderHero, resolveTexts } = await js("minutes.js");
const { PROJECT_TEST_CALLS } = await js("refusals.js");
const { MAX_CHARS, complete, slim, txCache } = await js("txcache.js");
const fixture = JSON.parse(await readFile(join(root, "fixtures", "sandbox-run.json"), "utf8"));

const A = "https://rpc.example.org";
const IDX = "https://idx.example.org";
const TOKEN = fixture.token;
const KEY = `chair-txs/1:${TOKEN}`;
/** The recorded transactions as the index returns them: each outcome has its id, and lists the receipts it spawned (all of which are present). */
const whole = (tx, i) => ({
  ...tx,
  execution_outcome: { id: `tx${i}`, outcome: { receipt_ids: tx.receipts.map((_, j) => `r${i}-${j}`) } },
  receipts: tx.receipts.map((r, j) => ({ ...r, execution_outcome: { ...r.execution_outcome, id: `r${i}-${j}`, outcome: { ...r.execution_outcome.outcome, receipt_ids: [] } } })),
});
const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
/** A set_policy call the token refused, in the same shape: the page lists it as a refusal. */
const REFUSED = whole({
  transaction: { hash: "5".repeat(43), signer_id: "chair.test.near", receiver_id: TOKEN, actions: [{ FunctionCall: { method_name: "set_policy", args: b64({ rate_bps: 500, reasoning: "too much" }), gas: 1, deposit: "0" } }] },
  receipts: [{ execution_outcome: { block_height: "99", block_timestamp: "1794367999000000000", outcome: { executor_id: TOKEN, logs: [], status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: rate out of range" } } } } } } } }],
}, 99);
const FULL = fixture.txs.map(whole);
const hashOf = (t) => t.transaction.hash;
const ok = (v) => ({ ok: true, status: 200, json: async () => v });
const throttled = () => ({ ok: false, status: 429, json: async () => ({}) });
const bytes = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

class MemStore {
  constructor(items = {}) { this.items = new Map(Object.entries(items)); }
  getItem(k) { return this.items.get(k) ?? null; }
  setItem(k, v) { this.items.set(k, String(v)); }
  removeItem(k) { this.items.delete(k); }
}

/**
 * A chain and an index that answer from the recorded run. `txs` is what the index holds; `up` false makes every index call a network error (a 429
 * without CORS headers looks like that); `script` is a list of replies (or null for "answer normally") for the next /v0/transactions calls.
 */
function world({ txs = FULL, store = new MemStore(), peek = true, pageLimit, supplyAt = null, supplyNow = null, byHash = [], failFor = () => false } = {}) {
  const w = { up: true, script: [], batches: [], accountCalls: 0, slept: [], store };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url.startsWith(IDX)) {
      if (!w.up) throw new TypeError("Failed to fetch");
      if (url.endsWith("/v0/account")) {
        w.accountCalls++;
        // The index pages like the real one (checked live): `limit` rows a page, newest first when `desc`, and a resume token that carries on from where the page ended.
        const rows = txs.map((t) => ({ transaction_hash: hashOf(t) }));
        if (body.desc) rows.reverse();
        const from = body.resume_token === undefined ? 0 : Number(body.resume_token.replace("page:", ""));
        const page = rows.slice(from, from + body.limit);
        return ok({ account_txs: page, resume_token: page.length === body.limit ? `page:${from + page.length}` : undefined });
      }
      w.batches.push(body.tx_hashes);
      if (failFor(body.tx_hashes)) return throttled();
      const scripted = w.script.shift();
      return scripted ? scripted(body.tx_hashes) : ok({ transactions: body.tx_hashes.map((h) => txs.find((t) => hashOf(t) === h) ?? byHash.find((t) => hashOf(t) === h)) });
    }
    const p = body.params;
    if (p.request_type === "view_access_key_list") return ok({ result: { keys: [] } });
    const view = { get_params: fixture.params, get_policy: w.policy ?? fixture.policyNow, get_supply: p.block_id === undefined ? supplyNow ?? fixture.supplyNow : supplyAt === null ? fixture.supplyAtLastTx : supplyAt(p.block_id), get_candidates: [] }[p.method_name];
    if (view === null) return { ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", error: { code: -32000, message: "block not found", data: "DB Not Found Error" } }) };
    return ok({ jsonrpc: "2.0", result: { result: bytes(view), logs: [] } });
  };
  w.transport = () => {
    const t = rpcTransport({ rpcUrls: [A], indexerUrl: IDX, account: TOKEN, fetchImpl, ...(pageLimit === undefined ? {} : { pageLimit }), sleep: async (ms) => void w.slept.push(ms), store: w.store });
    if (!peek) delete t.peek; // the full read alone, for tests that script the failures of its batches
    return t;
  };
  w.load = () => loadLog(w.transport());
  return w;
}

test("a reload asks the index for the hash list and nothing else; a new transaction costs one request", async () => {
  const store = new MemStore();
  const cold = world({ store, txs: FULL.slice(0, -1) });
  await cold.load();
  assert.deepEqual(cold.batches.map((b) => b.length), [20], "twenty hashes is the index's limit, so 20 fit in one request");

  const warm = world({ store });
  const second = await warm.load();
  assert.equal(second.status, "complete");
  assert.deepEqual(warm.batches, [[hashOf(FULL.at(-1))]], "only the hash the first visit had not seen");
  assert.equal(second.txCount, fixture.txs.length);

  const again = world({ store });
  const third = await again.load();
  assert.deepEqual(again.batches, [], "everything kept: no transaction request at all");
  assert.equal(again.accountCalls, 1);
  assert.deepEqual(third.entries, (await world().load()).entries, "a warm load reads the same log as a cold one");
});

test("a cache that is corrupt, the wrong shape, or over the size cap is ignored, and one wrong entry is dropped alone", async () => {
  for (const [name, raw] of [["not JSON", "{broken"], ["an array", "[]"], ["a string", '"x"'], ["too large", `{"pad":"${"x".repeat(MAX_CHARS)}"}`]]) {
    const w = world({ store: new MemStore({ [KEY]: raw }) });
    assert.equal((await w.load()).status, "complete", name);
    assert.equal(w.batches.flat().length, fixture.txs.length, `${name}: everything asked of the index`);
  }
  const warm = world();
  await warm.load();
  const kept = JSON.parse(warm.store.getItem(KEY));
  const [victim, other] = Object.keys(kept);
  kept[victim] = kept[other]; // an entry that is not the transaction its key says
  const w = world({ store: new MemStore({ [KEY]: JSON.stringify(kept) }) });
  assert.equal((await w.load()).status, "complete");
  assert.deepEqual(w.batches, [[victim]]);
});

test("storage that throws, or is missing, changes nothing the visitor sees", async () => {
  const angry = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } };
  for (const store of [angry, null]) {
    const w = world({ store });
    const d = await w.load();
    assert.equal(d.status, "complete");
    assert.equal(w.batches.flat().length, fixture.txs.length);
  }
});

test("only a transaction whose every receipt has an outcome is kept: one with a receipt still to run, or one the index left out, is read again", async () => {
  const lacking = structuredClone(FULL.at(-1));
  lacking.receipts.pop(); // the outcome of a receipt the transaction spawned is not in the reply
  const w = world({ txs: [...FULL.slice(0, -1), lacking] });
  await w.load();
  const kept = JSON.parse(w.store.getItem(KEY));
  assert.equal(Object.keys(kept).length, FULL.length - 1);
  assert.equal(kept[hashOf(lacking)], undefined);
  const next = world({ store: w.store });
  await next.load();
  assert.deepEqual(next.batches, [[hashOf(lacking)]], "only that one is asked for again, and now it is kept");
  assert.equal(Object.keys(JSON.parse(w.store.getItem(KEY))).length, FULL.length);

  const tx = FULL[3];
  assert.equal(complete(tx), true);
  const pending = structuredClone(tx);
  pending.receipts.at(-1).execution_outcome.outcome.receipt_ids = ["a refund receipt that has not run"];
  assert.equal(complete(pending), false, "an outcome that lists a receipt with no outcome of its own");
  const refunded = structuredClone(tx);
  refunded.receipts.at(-1).execution_outcome.outcome.receipt_ids = ["refund"];
  refunded.receipts.push({ execution_outcome: { id: "refund", outcome: { receipt_ids: [] } } });
  assert.equal(complete(refunded), true, "a refund receipt that did run counts like any other");
  const noTop = structuredClone(tx);
  delete noTop.execution_outcome;
  assert.equal(complete(noTop), false, "no way to tell: not kept");
  assert.equal(complete({ execution_outcome: { id: "a", outcome: {} }, receipts: [] }), false, "receipt_ids missing");
  assert.equal(complete(null), false);
});

test("what was kept is forgotten once it is shown wrong: a log that does not add up, or a newest decision older than the chain's last", async () => {
  const warm = async () => {
    const w = world();
    await w.load();
    return w;
  };
  const edit = (w, pick, change) => {
    const kept = JSON.parse(w.store.getItem(KEY));
    const [hash, tx] = Object.entries(kept).find(([, t]) => pick(t));
    change(tx);
    w.store.setItem(KEY, JSON.stringify({ ...kept, [hash]: tx }));
  };
  const hasLog = (re) => (t) => t.receipts.some((r) => r?.execution_outcome.outcome.logs.some((l) => re.test(l)));
  const strip = (re) => (tx) => tx.receipts.forEach((r) => r && (r.execution_outcome.outcome.logs = r.execution_outcome.outcome.logs.filter((l) => !re.test(l))));

  const bad = await warm();
  edit(bad, hasLog(/ft_mint/), strip(/ft_mint/)); // a mint the log should show is missing
  const d1 = await world({ store: bad.store }).load();
  assert.equal(d1.status, "mismatch");
  assert.equal(bad.store.getItem(KEY), null, "forgotten");
  const fresh = world({ store: bad.store });
  assert.equal((await fresh.load()).status, "complete");
  assert.equal(fresh.batches.flat().length, FULL.length, "the next read asks the index for everything");

  const hidden = await warm();
  const newest = decisionsOfTxs(fixture.txs, TOKEN).decisions[0];
  assert.equal(newest.epoch, fixture.policyNow.last_set_epoch, "the recorded run is consistent");
  edit(hidden, (t) => hasLog(/policy_set/)(t) && t.receipts.some((r) => r && JSON.stringify(r).includes(`"epoch\\":${newest.epoch},`)), strip(/policy_set/));
  const d2 = await world({ store: hidden.store }).load();
  assert.ok(d2.decisions[0].epoch < fixture.policyNow.last_set_epoch, "the newest decision is hidden");
  assert.equal(hidden.store.getItem(KEY), null);

  const healthy = await warm();
  await world({ store: healthy.store }).load();
  assert.ok(healthy.store.getItem(KEY) !== null, "a consistent log keeps what it kept");

  const lagging = world({ txs: FULL.filter((t) => hashOf(t) !== hashOf(FULL.find(hasLog(/ft_mint/)))), store: new MemStore() });
  assert.equal((await lagging.load()).status, "mismatch");
  assert.ok(lagging.store.getItem(KEY) !== null, "an index that is wrong by itself is not helped by forgetting: nothing was drawn from storage");
});

test("a failed batch is retried once after one short pause and the log is complete; a batch that fails twice makes the log incomplete", async () => {
  const w = world({ txs: FULL.slice(0, 20), peek: false });
  w.script = [throttled];
  const d = await w.load();
  assert.equal(d.txCount, 20, "the log was read");
  assert.equal(w.batches.length, 2, "one failure and the answer");
  assert.deepEqual(w.slept, [400], "one short pause");

  const dead = world({ txs: FULL.slice(0, 20), peek: false });
  dead.script = [throttled, throttled, throttled];
  const gone = await dead.load();
  assert.equal(gone.status, "incomplete");
  assert.equal(gone.retryable, true);
  assert.equal(dead.batches.length, 2, "two tries, no more: against a throttle more requests only make it last");
  assert.match(gone.reasons[0], /rate limited/);
});

test("what arrived before a failure is kept, and the failure stops the other readers", async () => {
  const store = new MemStore();
  const w = world({ store, peek: false });
  const second = FULL.slice(20).map(hashOf);
  w.script = [null, throttled, throttled].map((s) => s && (() => s()));
  const d = await w.load();
  assert.equal(d.status, "incomplete");
  assert.equal(Object.keys(JSON.parse(store.getItem(KEY))).length, 20, "the batch that arrived is saved");
  const next = world({ store, peek: false });
  assert.equal((await next.load()).status, "complete");
  assert.deepEqual(next.batches, [second], "the next try asks only for the rest");
});

test("the cache never outgrows its cap and, when it must drop transactions, drops the oldest", () => {
  const store = new MemStore();
  const cache = txCache({ store, key: KEY });
  const hashes = Array.from({ length: 40 }, (_, i) => `h${String(i).padStart(2, "0")}`);
  const big = (h) => ({ transaction: { hash: h, receiver_id: "x" }, receipts: [{ pad: "x".repeat(60_000) }] });
  cache.write(hashes, new Map(hashes.map((h) => [h, big(h)])));
  const raw = store.getItem(KEY);
  assert.ok(raw.length <= MAX_CHARS, `${raw.length} characters`);
  const kept = [...cache.read().keys()];
  assert.ok(kept.length > 5 && kept.length < 40);
  assert.deepEqual(kept.at(-1), "h39", "the newest stays");
  assert.equal(kept.includes("h00"), false, "the oldest goes");
});

test("a transaction reduced for storage reads exactly as the whole one does", async () => {
  const all = [...FULL, REFUSED];
  const slimmed = all.map((t) => slim(t, TOKEN));
  assert.equal(refusalsOfTxs(all, TOKEN).length, 1, "the whole transaction is a refusal");
  assert.equal(refusalsOfTxs(slimmed, TOKEN).length, 1, "and so is the reduced one");
  const noise = { execution_outcome: { outcome: { executor_id: "someone.else.near", logs: [], pad: "x".repeat(500) } }, receipt: { pad: "y".repeat(500) } };
  const busy = { ...fixture.txs[0], receipts: [noise, ...fixture.txs[0].receipts, noise], data_receipts: [{ pad: "z".repeat(500) }] };
  const reduced = slim(busy, TOKEN);
  assert.deepEqual(reduced.receipts.map((r) => r === null), [true, ...fixture.txs[0].receipts.map(() => false), true], "other contracts' receipts are dropped, the rest keep their positions");
  assert.ok(JSON.stringify(reduced).length < JSON.stringify(busy).length - 1500);
  const params = { epochMs: fixture.params.epoch_ms, startMs: fixture.params.start_ms, maxRateBps: fixture.params.max_rate_bps, maxStepBps: fixture.params.max_step_bps, meetingsPerDay: null };
  assert.deepEqual(decisionsOfTxs(slimmed, TOKEN), decisionsOfTxs(all, TOKEN));
  assert.deepEqual(refusalsOfTxs(slimmed, TOKEN), refusalsOfTxs(all, TOKEN));
  assert.deepEqual(buildEntries(slimmed, TOKEN, params), buildEntries(all, TOKEN, params));
  const viaFixture = await loadLog(fixtureTransport(fixture));
  const w = world();
  const viaIndex = await w.load();
  assert.deepEqual(viaIndex.entries, viaFixture.entries);
  assert.deepEqual(viaIndex.decisions, viaFixture.decisions);
  assert.equal(slim({ transaction: {} }, TOKEN), null);
});

// ---- the hero when the index cannot be read ----

const ctx = (resolved) => ({ texts: new Map(), resolved, explorer: "https://example.invalid", repoBase: "https://example.invalid/repo/blob/main", unit: "a day" });
async function hero(d) {
  const doc = fakeDoc();
  const slot = host(doc);
  renderHero(doc, slot, d, ctx(await resolveTexts([...d.decisions, ...d.remembered], new Map())));
  return slot.textContent;
}

test("index down, something saved: the hero shows the newest saved decision, labelled with its meeting and never called the latest", async () => {
  const store = new MemStore();
  await world({ store }).load();
  const down = world({ store });
  down.up = false;
  const d = await down.load();
  assert.equal(d.status, "incomplete", "the log still says so");
  assert.deepEqual(d.decisions, []);
  const newest = decisionsOfTxs(fixture.txs, TOKEN).decisions[0];
  assert.equal(d.remembered[0].epoch, newest.epoch);
  const text = await hero(d);
  assert.match(text, /Saved minutes of the Committee of One/);
  assert.match(text, new RegExp(`Meeting ${newest.epoch}`));
  assert.match(text, /saved copy because the transaction index is not answering/);
  assert.match(text, fixture.policyNow.last_set_epoch === newest.epoch ? /The chain confirms this was the last decision/ : /may not be the newest/);
  assert.doesNotMatch(text, /Latest minutes/);

  down.policy = { ...fixture.policyNow, last_set_epoch: newest.epoch + 3 };
  assert.match(await hero(await down.load()), new RegExp(`may not be the newest decision: the chain says the last one was in meeting ${newest.epoch + 3}\\.`));
});

test("index down, nothing saved: the hero says what the chain's own views say, in one sentence", async () => {
  const down = world();
  down.up = false;
  const d = await down.load();
  assert.equal(d.status, "incomplete");
  assert.deepEqual(d.remembered, []);
  const text = await hero(d);
  const p = fixture.policyNow;
  assert.match(text, /^The Chair's minutes could not be read just now\. The chain itself says the rate in force is \+0\.90% a day \(meeting 14\) and that chair\.test\.near is the Chair\. See the status under the log\.$/);
  assert.equal(p.rate_bps, 90);
  assert.equal(p.epoch, 14);
  assert.doesNotMatch(text, /Latest minutes|Saved minutes/);
});

test("a complete read still shows the latest decision as before", async () => {
  const d = await world().load();
  const text = await hero(d);
  assert.match(text, /Latest minutes of the Committee of One/);
  assert.doesNotMatch(text, /saved copy/);
});

test("the latest decision is offered after one request for the newest transactions, before the rest of the list is read, and no hash is asked twice", async () => {
  const w = world();
  const atOffer = [];
  const d = await loadLog(w.transport(), { onLatest: ({ decision, policy }) => atOffer.push({ batches: w.batches.length, decision, policy }) });
  assert.equal(d.status, "complete");
  assert.equal(atOffer.length, 1, "offered once");
  assert.equal(atOffer[0].batches, 1, "one request had been made for transactions");
  assert.equal(atOffer[0].decision.tx, d.decisions[0].tx, "the decision offered is the one the whole read ends on");
  assert.deepEqual(w.batches[0], FULL.slice(1).reverse().map(hashOf), "the twenty newest hashes, newest first");
  const asked = w.batches.flat();
  assert.equal(new Set(asked).size, asked.length, "nothing asked twice");
  assert.deepEqual(w.batches.map((b) => b.length), [20, 1]);
});

test("what was read ahead is kept for the next visit like everything else", async () => {
  const w = world();
  await w.load();
  assert.equal(Object.keys(JSON.parse(w.store.getItem(KEY))).length, FULL.length, "the twenty read ahead and the one read after them");
  const again = world({ store: w.store });
  const offered = [];
  await loadLog(again.transport(), { onLatest: (l) => offered.push(l) });
  assert.deepEqual(again.batches, [], "a warm visit asks for no transaction at all, the newest included");
  assert.equal(offered.length, 1, "and still has the latest decision for the hero at once");
});

test("no decision at least as new as the chain's last one in the newest transactions: nothing is offered early, and the full read still answers", async () => {
  const w = world();
  w.policy = { ...fixture.policyNow, last_set_epoch: fixture.policyNow.epoch + 50 };
  const offered = [];
  const d = await loadLog(w.transport(), { onLatest: (l) => offered.push(l) });
  assert.equal(offered.length, 0);
  assert.equal(d.status, "complete");
});

test("a read-ahead the index throttles changes nothing for the full read", async () => {
  const w = world();
  w.script = [throttled, throttled]; // both tries of the read-ahead; the full read then asks again and is answered
  const offered = [];
  const d = await loadLog(w.transport(), { onLatest: (l) => offered.push(l) });
  assert.equal(offered.length, 0);
  assert.equal(d.status, "complete");
  assert.equal(d.txCount, fixture.txs.length);
});

test("loadLog never offers the latest decision after it has returned", async () => {
  const w = world();
  const t = w.transport();
  const peek = t.peek;
  let release;
  const held = new Promise((done) => (release = done));
  t.peek = async (page) => (await held, peek(page)); // the read-ahead outlives the read
  const offered = [];
  const d = await loadLog(t, { onLatest: (l) => offered.push(l) });
  assert.equal(d.status, "complete", "the read ended without waiting for the read-ahead");
  release();
  await new Promise((done) => setTimeout(done, 20));
  assert.equal(offered.length, 0);
});

test("nothing the read-ahead or the caller's drawing does can surface as an unhandled rejection", async () => {
  const strays = [];
  const stray = (e) => strays.push(e);
  process.on("unhandledRejection", stray);
  try {
    const sync = await loadLog(world().transport(), { onLatest: () => { throw new Error("drawing failed"); } });
    const async_ = await loadLog(world().transport(), { onLatest: async () => { throw new Error("async drawing failed"); } });
    const t = world().transport();
    t.peek = async () => ({}); // not a list of transactions: decoding it throws
    const odd = await loadLog(t, { onLatest: () => assert.fail("a read-ahead that could not be decoded offers nothing") });
    await new Promise((done) => setTimeout(done, 30));
    for (const d of [sync, async_, odd]) assert.equal(d.status, "complete", "the full read is unaffected");
    assert.deepEqual(strays, []);
  } finally {
    process.off("unhandledRejection", stray);
  }
});

/** A transaction the token ran that changes nothing: the long history behind the recorded run, for the tests of a token that has run for days. */
const filler = (i) => whole({
  transaction: { hash: `${[...String(i)].map((c) => "ABCDEFGHJK"[c]).join("").padStart(43, "A")}K`, signer_id: "someone.test.near", receiver_id: TOKEN, actions: [{ FunctionCall: { method_name: "ft_transfer", args: "e30=", gas: 1, deposit: "1" } }] },
  receipts: [{ execution_outcome: { block_height: String(2 + (i % 9)), block_timestamp: "1794300000000000000", outcome: { executor_id: TOKEN, logs: [], status: { SuccessValue: "" } } } }],
}, 5000 + i);
const withHistory = (n) => [...Array.from({ length: n }, (_, i) => filler(i)), ...FULL];
const indexCalls = (w) => w.accountCalls + w.batches.length;

test("a token that has run for days: a cold load costs a small fixed number of index requests, reads the newest window, and never throws", async () => {
  const txs = withHistory(30_000);
  for (const visit of [1, 2]) {
    const w = world({ txs });
    const d = await w.load();
    assert.equal(w.accountCalls, 1, `visit ${visit}: one page of hashes, however long the history`);
    assert.ok(indexCalls(w) <= 12, `visit ${visit}: ${indexCalls(w)} index requests`);
    assert.equal(d.partial, true);
    assert.equal(d.txCount, 200, "the newest 200 transactions are the window");
    assert.notEqual(d.window.next, null, "older ones are still there to ask for");
    assert.ok(d.decisions.length > 0, "the Chair's newest decisions are in the window");
  }
});

test("a warm cold load asks the index for one page of hashes and nothing it already holds", async () => {
  const txs = withHistory(30_000);
  const store = new MemStore();
  await world({ txs, store }).load();
  const warm = world({ txs, store });
  await warm.load();
  assert.equal(warm.accountCalls, 1);
  assert.ok(warm.batches.length <= 1, "only the pinned test refusals, which are never kept");
});

test("Show earlier: each page of older transactions joins the log with no hash twice and none missing, until the history is whole", async () => {
  const txs = withHistory(120);
  const everyHash = txs.map(hashOf);
  const w = world({ txs, pageLimit: 50 });
  const transport = w.transport();
  let d = await loadLog(transport);
  assert.equal(d.partial, true);
  assert.deepEqual(d.window.hashes, everyHash.slice(-50), "the newest page, oldest first");
  const pages = [d.window.hashes.length];
  while (d.window.next !== null) {
    d = await loadEarlier(transport, d);
    pages.push(d.window.hashes.length);
    assert.deepEqual(d.window.hashes, everyHash.slice(-d.window.hashes.length), "a contiguous run of the newest ones");
    assert.equal(d.txCount, d.window.hashes.length);
  }
  assert.deepEqual(pages, [50, 100, 141]);
  assert.deepEqual(d.window.hashes, everyHash, "the whole history, oldest first");
  assert.equal(d.partial, false, "everything read: the log makes its whole-ledger claim again");
  const asked = w.batches.flat().filter((h) => !PROJECT_TEST_CALLS.has(h)); // the known test refusals are asked for again while they are missing, and this index has none
  assert.equal(new Set(asked).size, asked.length, "no transaction asked of the index twice");
  assert.equal(await loadEarlier(transport, d), d, "nothing earlier: the same data");
});

test("a history that ends exactly on a page: the next press finds nothing and the window is whole", async () => {
  const txs = withHistory(29); // 50 in all
  const transport = world({ txs, pageLimit: 50 }).transport();
  const d = await loadLog(transport);
  assert.notEqual(d.window.next, null, "a full page may have more behind it");
  const all = await loadEarlier(transport, d);
  assert.equal(all.window.next, null);
  assert.equal(all.txCount, 50);
  assert.equal(all.partial, false);
});

// A chain with its own clock, as the oracle for the windowed ledger check. Epochs turn every EPOCH blocks and each turn is a MINT. `get_supply` is a
// projection: it counts every turn that is due at the block asked, whether or not any transaction has written it down. A transaction that rolls
// (a transfer) writes down every turn since the last roll and logs it; a storage deposit rolls nothing and logs nothing. So the chain's figure at a
// block never depends on what was logged, and the logged sums are checked against it, not against themselves.
const EPOCH = 10;
const MINT = 1000n;
const BASE = 5_000_000n;
const epochOf = (b) => Math.floor(b / EPOCH);
const modelSupply = (b, skew = 0n) => ({ ...fixture.supplyAtLastTx, minted: String(BASE + MINT * BigInt(epochOf(b)) + skew), burned: "0" });
const logOf = (event) => `EVENT_JSON:${JSON.stringify(event)}`;
const mintLogs = (epoch, amount) => [
  logOf({ standard: "nep141", version: "1.0.0", event: "ft_mint", data: [{ owner_id: "pool.test.near", amount: String(amount), memo: "chair:easing" }] }),
  logOf({ standard: "chair", version: "1.0.0", event: "epoch_minted", data: { epoch, rate_bps: 18, amount: String(amount), total_staked: "1000", reward_per_share: "1" } }),
];

/**
 * `calls` is `[{ at, kind: "transfer" | "deposit", callback?: block, seen?: false }]`, ascending by `at`. A `callback` is a second receipt that rolls like a
 * transfer; with `seen: false` the index has not got it yet (the transaction lists a receipt still to run).
 */
function history(calls) {
  const receipts = calls.flatMap((c, i) => [{ i, block: c.at, kind: c.kind, first: true }, ...(c.callback === undefined ? [] : [{ i, block: c.callback, kind: "transfer", first: false }])]).sort((x, y) => x.block - y.block);
  let stored = epochOf(receipts[0].block);
  for (const r of receipts) {
    r.logs = [];
    if (r.kind === "deposit") continue;
    if (epochOf(r.block) > stored) (r.logs.push(...mintLogs(epochOf(r.block), MINT * BigInt(epochOf(r.block) - stored))), (stored = epochOf(r.block)));
    r.logs.push(logOf({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: "a.test.near", new_owner_id: "b.test.near", amount: "1" }] }));
  }
  const txs = calls.map((c, i) => {
    const mine = receipts.filter((r) => r.i === i && (r.first || c.seen !== false));
    const tx = whole({
      transaction: { hash: `${[...String(i)].map((d) => "ABCDEFGHJK"[d]).join("").padStart(43, "A")}M`, signer_id: "someone.test.near", receiver_id: TOKEN, actions: [{ FunctionCall: { method_name: c.kind === "deposit" ? "storage_deposit" : "ft_transfer", args: "e30=", gas: 1, deposit: "1" } }] },
      receipts: mine.map((r) => ({ execution_outcome: { block_height: String(r.block), block_timestamp: `${1_794_300_000 + r.block}000000000`, outcome: { executor_id: TOKEN, logs: r.logs, status: { SuccessValue: "" } } } })),
    }, 9000 + i);
    tx.execution_outcome.block_height = c.at - 1;
    if (c.callback !== undefined && c.seen === false) tx.receipts[0].execution_outcome.outcome.receipt_ids = [`later${i}`];
    return tx;
  });
  return { txs, receipts };
}
/** Two hundred calls over irregular blocks (a window with no decision in it is widened three pages, so the history is longer than that): every fourth a storage deposit, the last one too, with epochs due after the last transfer. */
const longRun = () => history(Array.from({ length: 200 }, (_, i) => ({ at: 100 + i * 23 + (i % 3) * 5, kind: i % 4 === 3 ? "deposit" : "transfer" })));
const windowed = (h, extra = {}) => world({ txs: h.txs, pageLimit: 30, supplyNow: modelSupply(h.receipts.at(-1).block + 500), ...extra });

test("the windowed check pins both ends to blocks where the contract rolled, so a due mint nobody has logged yet is not a mismatch", async () => {
  const h = longRun();
  const rolled = h.receipts.filter((r) => r.kind === "transfer").map((r) => r.block);
  const d = await windowed(h, { supplyAt: modelSupply }).load();
  const windowBlocks = h.receipts.slice(-d.txCount).map((r) => r.block);
  assert.equal(d.partial, true);
  assert.equal(d.status, "complete");
  assert.ok(rolled.includes(d.pinnedFrom) && rolled.includes(d.pinnedHeight), "both readings are at blocks where a transfer ran");
  assert.equal(d.pinnedHeight, rolled.at(-1), "the top is the last roll, not the storage deposit after it");
  assert.notEqual(d.pinnedHeight, h.receipts.at(-1).block);
  assert.ok(d.pinnedFrom >= windowBlocks[0] + 20, "after the blocks at the window's edge that a receipt just older than it may still be running in");
  assert.deepEqual(d.reconcile.lines.map((l) => [l.name, l.logged === l.chain]), [["minted", true], ["burned", true]]);
  // The reading this replaces: a computed height, here 20 blocks on from the oldest block read, which no transaction touched. The chain's own figure
  // there already holds mints that the next roll writes down, so the same sums disagree.
  const computed = windowBlocks[0] + 20;
  assert.equal(h.receipts.some((r) => r.block === computed), false, "the model has no receipt at the computed height");
  const naive = reconcileWindow(d.entries.filter((e) => e.height > computed && e.height <= d.pinnedHeight), parseSupply(modelSupply(computed)), parseSupply(modelSupply(d.pinnedHeight)));
  assert.equal(naive.ok, false, "the oracle does catch a computed height");
});

test("the windowed check is a mismatch when the chain's figure at the start is one unit off, and unverified when that block cannot be read", async () => {
  const h = longRun();
  const good = await windowed(h, { supplyAt: modelSupply }).load();
  const bad = await windowed(h, { supplyAt: (b) => modelSupply(b, b === good.pinnedFrom ? 1n : 0n) }).load();
  assert.equal(bad.status, "mismatch");
  assert.match(bad.reasons[0], /do not add up/);
  const lost = await windowed(h, { supplyAt: (b) => (b === good.pinnedFrom ? null : modelSupply(b)) }).load();
  assert.equal(lost.status, "unverified", "a block the node no longer has is not a pass");
});

test("a transaction with a receipt still to run keeps the top of the check below the block that receipt will add events to", async () => {
  // Call 0 is a transfer at block 700 whose callback (a roll at 790) the index has not got; call 1 is a transfer at block 800. The chain wrote the 790
  // mints down at block 790, so the log of block 800 alone lacks them: a check at 800 would say mismatch about a healthy chain.
  const base = Array.from({ length: 200 }, (_, i) => ({ at: 100 + i * 3, kind: "transfer" }));
  const h = history([...base, { at: 700, kind: "transfer", callback: 790, seen: false }, { at: 800, kind: "transfer" }]);
  const d = await world({ txs: h.txs, pageLimit: 30, supplyNow: modelSupply(1500), supplyAt: modelSupply }).load();
  assert.equal(d.partial, true);
  assert.equal(d.pinnedHeight, 700, "pinned where everything read is whole");
  assert.equal(d.status, "complete");
  const whole2 = history([...base, { at: 700, kind: "transfer", callback: 790 }, { at: 800, kind: "transfer" }]);
  const done = await world({ txs: whole2.txs, pageLimit: 30, supplyNow: modelSupply(1500), supplyAt: modelSupply }).load();
  assert.equal(done.pinnedHeight, 800, "the same chain once the callback is in: pinned at the last roll");
  assert.equal(done.status, "complete");
});

test("a transaction with no block for its receipts promises nothing, so nothing is claimed complete", async () => {
  const h = longRun();
  const blind = h.txs.map((t, i) => (i === h.txs.length - 2 ? { ...t, execution_outcome: { ...t.execution_outcome, block_height: undefined, outcome: { ...t.execution_outcome.outcome, receipt_ids: ["unseen"] } } } : t));
  const d = await world({ txs: blind, pageLimit: 30, supplyNow: modelSupply(5000), supplyAt: modelSupply }).load();
  assert.equal(d.status, "unverified");
  assert.match(d.reasons[0], /still being processed/);
});

test("a window with no event in it says there is nothing to check, not that the chain could not be read", async () => {
  const quiet = Array.from({ length: 400 }, (_, i) => filler(i));
  const d = await world({ txs: quiet, pageLimit: 30 }).load();
  assert.equal(d.partial, true);
  assert.equal(d.status, "unverified");
  assert.match(d.reasons[0], /No mint, burn or decision was logged in the transactions read/);
});

test("slim marks a transaction with a receipt still to run, and such a transaction is never kept for the next visit", async () => {
  const h = history([{ at: 100, kind: "transfer", callback: 110, seen: false }, { at: 120, kind: "transfer" }]);
  assert.equal(slim(h.txs[0], TOKEN).settledThrough, 100);
  assert.equal("settledThrough" in slim(h.txs[1], TOKEN), false);
  const store = new MemStore();
  const w = world({ txs: h.txs, store, supplyNow: modelSupply(500), supplyAt: modelSupply });
  await w.load();
  assert.deepEqual(Object.keys(JSON.parse(store.getItem(KEY) ?? "{}")), [hashOf(h.txs[1])], "only the complete one");
});

test("a window with no decision in it is widened, and when none is in reach the page says the latest is older, with the log, its check and the test refusals all still shown", async () => {
  const quiet = Array.from({ length: 300 }, (_, i) => filler(i));
  const d = await world({ txs: [...FULL.slice(0, 1), ...quiet], pageLimit: 50 }).load();
  assert.equal(d.outOfReach, true, "the index was read; the newest decision is further back");
  assert.notEqual(d.status, "incomplete", "never the sentence that says the index could not be read");
  assert.equal(d.retryable, undefined);
  assert.equal(d.window.hashes.length, 200, "the window and three older pages");
  assert.equal(d.partial, true);
  const reachable = await world({ txs: [...FULL.slice(0, 1), ...quiet.slice(0, 120), ...FULL.slice(1)], pageLimit: 50 }).load();
  assert.equal(reachable.outOfReach, false);
  assert.ok(reachable.decisions.length > 0, "a decision a page or two back is found");
});

test("an out-of-reach window does not make the page forget what it saved: the next load still draws on it", async () => {
  const quiet = Array.from({ length: 300 }, (_, i) => filler(i));
  const store = new MemStore();
  const txs = [...FULL.slice(0, 1), ...quiet];
  await world({ txs, pageLimit: 50, store }).load();
  const kept = store.getItem(KEY);
  assert.ok(kept !== null && kept.length > 2, "the cache of the window is written");
  const again = world({ txs, pageLimit: 50, store });
  await again.load();
  assert.equal(JSON.stringify(JSON.parse(store.getItem(KEY))) === JSON.stringify(JSON.parse(kept)), true, "and is not cleared by the second visit");
  assert.equal(again.batches.flat().filter((h) => !PROJECT_TEST_CALLS.has(h)).length, 0, "nothing but the known test refusals asked again");
});

// The project's recorded test refusals: old, refused, and read by hash whatever the window. Same shape as REFUSED, one per known hash.
const testCalls = () => [...PROJECT_TEST_CALLS].map((hash, i) => whole({ ...REFUSED, transaction: { ...REFUSED.transaction, hash } }, 800 + i));

test("the known test refusals that the index does not return are said to be missing, and are asked for again on the next press", async () => {
  const byHash = [];
  const w = world({ txs: Array.from({ length: 400 }, (_, i) => filler(i)), pageLimit: 50, byHash });
  const transport = w.transport();
  const d = await loadLog(transport);
  assert.equal(d.partial, true);
  assert.equal(d.unreadTestCalls.length, PROJECT_TEST_CALLS.size, "none could be read: all are named missing, none claimed");
  assert.equal(d.refusals.filter((r) => PROJECT_TEST_CALLS.has(r.tx)).length, 0);
  byHash.push(...testCalls());
  const next = await loadEarlier(transport, d);
  assert.deepEqual(next.unreadTestCalls, [], "found on the second ask");
  assert.equal(next.refusals.filter((r) => PROJECT_TEST_CALLS.has(r.tx)).length, PROJECT_TEST_CALLS.size, "and listed, though older than anything in the window");
});

test("the known test refusals are read by hash on a cold load of a long history, in one extra request", async () => {
  const w = world({ txs: Array.from({ length: 400 }, (_, i) => filler(i)), pageLimit: 50, byHash: testCalls() });
  const d = await w.load();
  assert.deepEqual(d.unreadTestCalls, []);
  assert.equal(d.refusals.filter((r) => PROJECT_TEST_CALLS.has(r.tx)).length, PROJECT_TEST_CALLS.size);
  const lookups = w.batches.filter((b) => b.every((h) => PROJECT_TEST_CALLS.has(h)));
  assert.equal(lookups.length, 1);
});

test("a lookup of the known test refusals that fails does not fail the page, and says what is missing", async () => {
  const w = world({ txs: Array.from({ length: 400 }, (_, i) => filler(i)), pageLimit: 50, byHash: testCalls(), failFor: (hs) => hs.every((h) => PROJECT_TEST_CALLS.has(h)) });
  const d = await w.load();
  assert.equal(d.partial, true);
  assert.equal(d.status === "incomplete", false);
  assert.equal(d.unreadTestCalls.length, PROJECT_TEST_CALLS.size);
});
