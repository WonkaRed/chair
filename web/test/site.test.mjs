import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";
import { build, cspFor } from "../scripts/build.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const dist = await build();
const js = (f) => import(join(dist, "js", f));
const { loadLog, parseSupply } = await js("loadlog.js");
const { identity } = await js("ledger.js");
const { fixtureTransport, rpcTransport, SourceError } = await js("sources.js");
const { renderLog, renderReconcile, renderLedger, renderNow, renderFailure, renderSource } = await js("views.js");
const { safeText, showAccount } = await js("text.js");
const { simulate, BEHAVIOURS } = await js("simview.js");
const { run } = await import(join(dist, "vendor", "sim", "sim.js"));
const { SCENARIOS } = await import(join(dist, "vendor", "sim", "scenarios.js"));
const fixture = JSON.parse(await readFile(join(root, "fixtures", "sandbox-run.json"), "utf8"));
const clone = () => structuredClone(fixture);
const textOf = (n) => n.textContent;
const FORBIDDEN_TAGS = new Set(["script", "img", "iframe", "a-fake", "style", "object", "embed", "link"]);

test("the recorded run loads, reconciles to the chain's ledger and says what it is", async () => {
  const d = await loadLog(fixtureTransport(fixture));
  assert.equal(d.status, "complete");
  assert.equal(d.reconcile.ok, true);
  assert.equal(d.identity.holds, true);
  assert.equal(d.accessKeys, 0);
  assert.ok(d.entries.some((e) => e.kind === "mint") && d.entries.some((e) => e.kind === "burn"));
  assert.ok(d.pending !== null && d.pending.minted > 0n, "the due-but-unapplied mint is shown separately, not as a mismatch");
  assert.equal(fixture.label, "recorded sandbox run, not a live chain");
  const doc = fakeDoc();
  const h = host(doc);
  renderLog(doc, h, d, { filter: "all", newestFirst: true, shown: 50 }, { explorer: null, rerender() {} });
  assert.match(textOf(h), /Launch/);
  assert.match(textOf(h), /Burn/);
  const rows = [...walk(h)].filter((n) => n.tag === "tr" && n.attrs.class?.startsWith("entry"));
  assert.equal(rows.length, d.entries.length);
  assert.ok([...walk(h)].every((n) => n.tag !== "a"), "no transaction links without an explorer");
});

test("ledger identity: total = launch + minted - burned, and a one-unit error is caught", () => {
  const s = parseSupply(fixture.supplyNow);
  assert.equal(s.totalSupply, s.launchSupply + s.minted - s.burned);
  assert.equal(identity(s).holds, true);
  assert.equal(identity({ ...s, totalSupply: s.totalSupply + 1n }).holds, false);
  assert.equal(identity({ ...s, burned: s.burned + 1n }).holds, false);
});

test("a dropped transaction is a mismatch, never a silent pass", async () => {
  const f = clone();
  const i = f.txs.findIndex((t) => t.transaction.actions[0].FunctionCall.method_name === "set_policy" && JSON.stringify(t).includes("epoch_minted"));
  assert.ok(i > 0);
  f.txs.splice(i, 1);
  const d = await loadLog(fixtureTransport(f));
  assert.equal(d.status, "mismatch");
  const doc = fakeDoc();
  const h = host(doc);
  renderReconcile(doc, h, d, { onRetry() {} });
  assert.match(textOf(h), /differs/);
});

test("indexer failure: totals still come from the chain, the log says it is incomplete, retry is offered when it may help", async () => {
  const t = fixtureTransport(fixture);
  t.transactions = async () => { throw new SourceError("indexer", "HTTP 503", { retryable: true }); };
  const d = await loadLog(t);
  assert.equal(d.status, "incomplete");
  assert.equal(d.reconcile, null);
  assert.equal(d.entries.length, 0);
  assert.equal(d.supply.totalSupply, parseSupply(fixture.supplyNow).totalSupply);
  const doc = fakeDoc();
  const h = host(doc);
  renderReconcile(doc, h, d, { onRetry() {} });
  assert.match(textOf(h), /could not be read/);
  assert.ok([...walk(h)].some((n) => n.tag === "button"), "a retry button");
  t.view = async () => { throw new SourceError("rpc", "HTTP 500"); };
  await assert.rejects(loadLog(t), SourceError);
  const f = host(doc);
  renderFailure(doc, f, new SourceError("rpc", "HTTP 500"));
  assert.match(textOf(f), /No number is shown rather than a wrong one/);
});

test("hostile chain strings are shown as text, with control and bidi characters made visible", async () => {
  const evil = "<img src=x onerror=alert(1)><script>1</script>\u202e\u2066\u200b\u0007";
  assert.equal(safeText(evil).includes("\u202e"), false);
  assert.equal(/[\u0000-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(safeText(evil)), false);
  assert.match(safeText(evil), /\\u\{202e\}/);
  assert.match(showAccount("alice.near\u202e"), /^invalid id: /);
  assert.equal(showAccount("alice.test.near"), "alice.test.near");

  const f = clone();
  let swapped = 0;
  for (const tx of f.txs) for (const r of tx.receipts) {
    const logs = r.execution_outcome.outcome.logs;
    logs.forEach((l, i) => { if (l.includes('"memo":"launch"')) { logs[i] = l.replace('"memo":"launch"', `"memo":${JSON.stringify(evil)}`); swapped++; } });
  }
  assert.equal(swapped, 1, "the launch memo was replaced by the hostile string");
  const d = await loadLog(fixtureTransport(f));
  assert.ok(d.anomalies.some((a) => a.includes("<img src=x")), "the hostile memo is carried into the page's data");
  const doc = fakeDoc();
  const h = host(doc);
  // each renderer clears its host, so each gets its own and the page is the union of them
  const page = host(doc);
  const renders = [
    (x) => renderLog(doc, x, d, { filter: "all", newestFirst: true, shown: 50 }, { explorer: "https://example.invalid", rerender() {} }),
    (x) => renderReconcile(doc, x, d, { onRetry() {} }),
    (x) => renderLedger(doc, x, d),
    (x) => renderNow(doc, x, d),
  ];
  for (const r of renders) { const x = host(doc); r(x); page.append(x); }
  const h2 = page;
  for (const n of walk(h2)) {
    if (n.tag === undefined) continue;
    assert.equal(FORBIDDEN_TAGS.has(n.tag), false, `element <${n.tag}> must not exist`);
    for (const k of Object.keys(n.attrs)) assert.equal(/^on/i.test(k), false, `attribute ${k}`);
  }
  assert.match(textOf(h2), /\\u\{202e\}/, "the hostile memo reached the rendered page, escaped");
  assert.match(textOf(h2), /<img src=x onerror=alert\(1\)>/, "and as literal text, not as an element");
  assert.equal(/[\u200b\u202a-\u202e\u2066-\u2069\u0007]/.test(textOf(h2)), false);
  const hrefs = [...walk(h2)].map((n) => n.attrs?.href).filter(Boolean);
  for (const href of hrefs) assert.match(href, /^https:\/\/example\.invalid\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
});

test("simulation numbers equal the simulator's own: same code, same totals", () => {
  const sim = simulate();
  assert.equal(sim.series.length, 5);
  for (const s of sim.series) {
    const r = run(SCENARIOS.find((x) => x.id === s.id));
    assert.equal(s.finalSupply, r.rows[59].supply);
    assert.equal(s.minted, r.totalMinted);
    assert.equal(s.burned, r.totalBurned);
    assert.equal(s.finalSupply, sim.initialSupply + s.minted - s.burned, `${s.id}: supply identity`);
    assert.equal(s.supplyPct.length, 60);
    assert.ok(s.rateBps.every((b) => Math.abs(b) <= 200), `${s.id}: rate inside the contract bound`);
  }
  assert.deepEqual(sim.series.map((s) => s.id), BEHAVIOURS.map((b) => b.id));
});

test("the build copies every compiled sim .js file into dist/vendor/sim byte for byte (it proves the copy, not that sim/dist is fresh: `make build` compiles it first)", async () => {
  const srcDir = join(root, "..", "sim", "dist", "src");
  const files = (await readdir(srcDir)).filter((f) => f.endsWith(".js")).sort();
  assert.ok(files.length >= 6, `found ${files.join(", ")}`);
  assert.deepEqual((await readdir(join(dist, "vendor", "sim"))).sort(), files, "same set of files");
  for (const f of files) assert.ok((await readFile(join(srcDir, f))).equals(await readFile(join(dist, "vendor", "sim", f))), f);
});

test("CSP allows only the configured hosts, and the page has no inline script or external resource", async () => {
  const cfg = { fixture: null, rpcUrl: "https://rpc.example.org/x", indexerUrl: "https://idx.example.org" };
  assert.match(cspFor(cfg), /connect-src 'self' https:\/\/rpc\.example\.org https:\/\/idx\.example\.org;/);
  assert.match(cspFor({ ...cfg, fixture: "f.json" }), /connect-src 'self';/);
  assert.throws(() => cspFor({ ...cfg, rpcUrl: "http://rpc.example.org" }), /https/);
  const html = await readFile(join(dist, "index.html"), "utf8");
  assert.doesNotMatch(html, /__CSP__/);
  assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i);
  assert.doesNotMatch(html, /(src|href)="https?:\/\//);
  for (const f of ["style.css", "js/charts.js", "js/views.js", "js/dom.js", "js/app.js"]) {
    const t = (await readFile(join(dist, f), "utf8")).split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
    assert.doesNotMatch(t, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|@import|url\(\s*['"]?https?:/);
  }
});

// ---- every chain- or indexer-supplied string that reaches the page is hostile-tested, field by field ----

const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007";
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const TX_HREF = /^https:\/\/example\.invalid\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Strings our own code writes (never chain text); every other string leaf of the page's data is treated as hostile-able. */
const OWN_KEYS = new Set(["kind", "epochFrom", "reason", "status", "name"]);

function assertClean(root, label) {
  for (const n of walk(root)) {
    if (n.data !== undefined) {
      assert.equal(HIDDEN.test(n.data), false, `${label}: raw control, bidi or invisible character in text ${JSON.stringify(n.data.slice(0, 60))}`);
      continue;
    }
    assert.equal(FORBIDDEN_TAGS.has(n.tag), false, `${label}: element <${n.tag}>`);
    for (const [k, v] of Object.entries(n.attrs)) {
      assert.equal(/^on/i.test(k), false, `${label}: attribute ${k}`);
      assert.equal(HIDDEN.test(v), false, `${label}: raw hidden character in attribute ${k}=${JSON.stringify(v.slice(0, 60))}`);
      if (k === "href") assert.match(v, TX_HREF, `${label}: href`);
    }
  }
}

/** Every string leaf path of `v` outside the page's own wording. */
function* strLeaves(v, path = []) {
  if (typeof v === "string") yield path;
  else if (Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* strLeaves(v[i], [...path, i]);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) if (!OWN_KEYS.has(k)) yield* strLeaves(x, [...path, k]);
}
function withAt(v, path, value) {
  const c = structuredClone(v);
  let node = c;
  for (const k of path.slice(0, -1)) node = node[k];
  node[path.at(-1)] = value;
  return c;
}

function renderEverything(d, fixtureForBanner, explorer = "https://example.invalid") {
  const doc = fakeDoc();
  const page = host(doc);
  const add = (fn) => { const x = host(doc); fn(x); page.append(x); };
  add((x) => renderNow(doc, x, d));
  add((x) => renderLedger(doc, x, d));
  add((x) => renderReconcile(doc, x, d, { onRetry() {} }));
  add((x) => renderLog(doc, x, d, { filter: "all", newestFirst: true, shown: 100 }, { explorer, rerender() {} }));
  add((x) => renderSource(doc, x, { mode: "fixture", config: {}, fixture: fixtureForBanner }));
  return page;
}

test("generic: a hostile value in ANY string field of the page's data renders as inert text (every leaf, one at a time)", async () => {
  const complete = await loadLog(fixtureTransport(fixture));
  const burn = complete.entries.find((e) => e.kind === "burn");
  // rows the fixture has no transaction for: forced storage_unregister and ft_transfer_call refund burns
  const base = { ...complete, entries: [...complete.entries, { ...burn, memo: "storage_unregister", spent: undefined }, { ...burn, memo: "refund", spent: undefined, hash: complete.entries[0].hash }] };
  const t = fixtureTransport(fixture);
  t.transactions = async () => { throw new SourceError("indexer", "HTTP 503", { retryable: true }); };
  const incomplete = await loadLog(t);
  let leaves = 0;
  for (const d of [base, incomplete]) {
    assertClean(renderEverything(d, fixture), "baseline");
    for (const path of strLeaves(d)) {
      leaves++;
      assertClean(renderEverything(withAt(d, path, EVIL), fixture), `d.${path.join(".")}`);
    }
  }
  assert.ok(leaves > 60, `only ${leaves} leaves were exercised`);
  for (const path of strLeaves({ token: fixture.token, wasm_sha256: fixture.wasm_sha256, label: fixture.label, source: fixture.source })) {
    assertClean(renderEverything(base, withAt(fixture, path, EVIL)), `fixture.${path.join(".")}`);
  }
});

test("hostile ids are named as invalid, and hostile text is shown escaped, in the fields people read", async () => {
  const d = await loadLog(fixtureTransport(fixture));
  const text = (x) => textOf(renderEverything(x, fixture));
  assert.match(text(withAt(d, ["policy", "chair"], EVIL)), /invalid id: <img src=x onerror=alert\(1\)>\\u\{202e\}/);
  const burnAt = d.entries.findIndex((e) => e.kind === "burn" && e.spent !== undefined);
  assert.match(text(withAt(d, ["entries", burnAt, "account"], EVIL)), /invalid id: .* spent /);
  assert.match(text(withAt(d, ["entries", 0, "account"], EVIL)), /invalid id: /, "launch row");
  const unreg = { ...d, entries: [{ ...d.entries[burnAt], memo: "storage_unregister", spent: undefined, account: EVIL }] };
  assert.match(text(unreg), /invalid id: /, "storage_unregister row");
  assert.match(text({ ...unreg, entries: [{ ...unreg.entries[0], memo: "refund" }] }), /invalid id: /, "refund row");
  assert.match(text(withAt(d, ["entries", 0, "hash"], EVIL)), /<img src=x onerror/, "a hash that is not a transaction hash is shown as capped, escaped text");
  assert.match(textOf(renderEverything(d, withAt(fixture, ["token"], EVIL))), /\\u\{202e\}/, "fixture.token in the banner");
});

test("an RPC node's error text is escaped when the page says it could not read the chain", async () => {
  const reply = { status: 200, ok: true, json: async () => ({ error: { name: EVIL } }) };
  const t = rpcTransport({ rpcUrl: "https://rpc.example.org", indexerUrl: "https://idx.example.org", account: "chair-token.testnet", fetchImpl: async () => reply });
  const err = await loadLog(t).then(() => null, (e) => e);
  assert.ok(err instanceof SourceError);
  assert.ok(err.message.includes("<img"), "the hostile text is in the error message");
  const doc = fakeDoc();
  const x = host(doc);
  renderFailure(doc, x, err);
  assertClean(x, "renderFailure");
  assert.match(textOf(x), /\\u\{202e\}/);
});

test("generic: renaming each distinct string in the recorded run to a hostile value, through the real parsers, never yields raw hidden text or an element", async () => {
  const distinct = new Set();
  const rewrite = (v, from, to) => {
    if (typeof v === "string") {
      if (v.startsWith("EVENT_JSON:")) return `EVENT_JSON:${JSON.stringify(rewrite(JSON.parse(v.slice(11)), from, to))}`;
      if (from === null) { distinct.add(v); return v; }
      return v === from ? to : v;
    }
    if (Array.isArray(v)) return v.map((x) => rewrite(x, from, to));
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rewrite(x, from, to)]));
    return v;
  };
  rewrite(fixture, null);
  assert.ok(distinct.size > 80, `${distinct.size} distinct strings`);
  let failures = 0;
  for (const value of distinct) {
    const f = rewrite(fixture, value, EVIL);
    let d;
    try {
      d = await loadLog(fixtureTransport(f));
    } catch (e) {
      failures++;
      const doc = fakeDoc();
      const x = host(doc);
      renderFailure(doc, x, e);
      assertClean(x, `renaming ${JSON.stringify(value.slice(0, 30))}: failure`);
      continue;
    }
    assertClean(renderEverything(d, f), `renaming ${JSON.stringify(value.slice(0, 30))}`);
  }
  assert.ok(failures < distinct.size, "some renamed fixtures still load");
});
