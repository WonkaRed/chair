// The chair minutes: decisions read from chain events, reasoning texts from the transaction's arguments or bundled from docs/, the in-browser
// hash check, and the refusals read from the same transactions.
// Imports the site's modules from site/ directly, so this file never touches dist (site.test.mjs rebuilds it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";
import { bundleMinutes } from "../scripts/minutes.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const docs = join(root, "..", "docs");
const site = (f) => import(join(root, "site", "js", f));
const { decisionsOfTxs, refusalsOfTxs } = await site("decisions.js");
const { checkReasoning, loadTexts, renderHero, renderMinutes, resolveTexts, sha256Hex, silence, splitMinutes } = await site("minutes.js");
const { renderRefusals, humanReason, PROJECT_TEST_CALLS } = await site("refusals.js");
const { rawTxCommand } = await site("views.js");
const { lineChart } = await site("charts.js");
const { loadLog } = await site("loadlog.js");
const { fixtureTransport } = await site("sources.js");
const fixture = JSON.parse(await readFile(join(root, "fixtures", "sandbox-run.json"), "utf8"));
const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
const textOf = (n) => n.textContent;

// ---- the recorded decisions in docs/ (the files other lanes write; every one present is checked) ----

const recorded = [];
for (const f of (await readdir(docs)).filter((n) => /^testnet-run-agent-.*decisions\.jsonl$/.test(n))) {
  for (const line of (await readFile(join(docs, f), "utf8")).split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.kind === "decision") recorded.push({ ...r, file: f });
  }
}
const { bundle, warnings } = await bundleMinutes(docs);
const textsMap = async () => {
  const doc = JSON.parse(JSON.stringify(bundle));
  return loadTexts("minutes.json", async () => ({ ok: true, json: async () => doc }));
};

test("every recorded decision's text is bundled byte for byte and verifies in the browser against its recorded hash", async () => {
  assert.ok(recorded.length >= 11, `${recorded.length} recorded decisions`);
  assert.deepEqual(warnings, [], "the repo's own run records bundle without a skipped line");
  const texts = await textsMap();
  for (const r of recorded) {
    assert.equal(texts.get(r.reasoning_hash)?.text, r.reasoning, `${r.file} epoch ${r.epoch}: text differs from the record`);
    assert.equal(await checkReasoning(r.reasoning, r.reasoning_hash), "verified", `${r.file} epoch ${r.epoch}`);
  }
});

test("a decision that only exists in a .txt record (no jsonl) is bundled from its prefixed lines and still hashes to its hash", async () => {
  const hashes = new Set(recorded.map((r) => r.reasoning_hash));
  const txtOnly = [];
  for (const f of (await readdir(docs)).filter((n) => /^testnet-run-agent-.*\.txt$/.test(n))) {
    for (const m of (await readFile(join(docs, f), "utf8")).matchAll(/^reasoning_hash: ([0-9a-f]{64})$/gm)) if (!hashes.has(m[1])) txtOnly.push(m[1]);
  }
  assert.ok(txtOnly.length > 0, "docs/testnet-run-agent-llm-2.txt has no jsonl");
  const texts = await textsMap();
  for (const h of txtOnly) {
    assert.ok(texts.has(h), `${h} is in a .txt record but not bundled`);
    assert.equal(await checkReasoning(texts.get(h).text, h), "verified");
  }
});

test("hashing is over the exact bytes: one changed character, a trailing newline, or CRLF is a mismatch", async () => {
  const r = recorded[0];
  assert.equal(await sha256Hex(r.reasoning), sha(r.reasoning));
  assert.equal(await checkReasoning(r.reasoning.replace("0", "1"), r.reasoning_hash), "mismatch");
  assert.equal(await checkReasoning(`${r.reasoning}\n`, r.reasoning_hash), "mismatch");
  assert.equal(await checkReasoning(r.reasoning.replaceAll("\n", "\r\n"), r.reasoning_hash), "mismatch");
  assert.equal(await checkReasoning(r.reasoning, r.reasoning_hash, null), "unchecked", "no crypto.subtle: never a verified mark");
  assert.equal(await checkReasoning(r.reasoning, r.reasoning_hash, { digest: async () => { throw new Error("no"); } }), "unchecked");
});

// ---- build: the bundle is tolerant ----

test("the bundle skips what it cannot vouch for and says so, and never fails on a missing folder or file", async () => {
  const none = await bundleMinutes(join(tmpdir(), "chair-no-such-docs-folder"));
  assert.deepEqual(none.bundle, { schema: "chair-minutes/1", texts: {} });
  assert.equal(none.warnings.length, 1);

  const dir = await mkdtemp(join(tmpdir(), "chair-minutes-"));
  try {
    assert.deepEqual((await bundleMinutes(dir)).bundle.texts, {}, "an empty docs folder");
    const good = "$CHAIR decision, epoch 1.\nsecond line";
    const rec = (over) => JSON.stringify({ kind: "decision", reasoning: good, reasoning_hash: sha(good), chair: "rule-v1", chair_kind: "rule", ...over });
    await writeFile(join(dir, "testnet-run-agent-a-decisions.jsonl"), [rec({}), "{not json", rec({ reasoning: "edited", reasoning_hash: sha(good) }), rec({ reasoning_hash: "ABC" }), JSON.stringify({ kind: "outcome" }), ""].join("\n"));
    await writeFile(join(dir, "unrelated.txt"), "ignored");
    const out = await bundleMinutes(dir);
    assert.deepEqual(Object.keys(out.bundle.texts), [sha(good)]);
    assert.equal(out.bundle.texts[sha(good)].text, good);
    assert.equal(out.warnings.length, 3, out.warnings.join(" | "));
    assert.match(out.warnings.join("\n"), /does not hash/);
    assert.ok(out.warnings.every((w) => !w.includes("unrelated")));
    // a .txt with a block whose text was edited after the hash was written is skipped; an intact one is taken
    const block = (text, hash) => `epoch 2 | chair local:x (llm) | rate 0 -> 5 bps\nreasoning_hash: ${hash}\n--- reasoning (the text behind the hash)\n${text.split("\n").map((l) => (l ? `  | ${l}` : "  |")).join("\n")}\n--- transaction ---\nexecuted, tx x\n`;
    const multi = "line one\n\nline three";
    await writeFile(join(dir, "testnet-run-agent-b.txt"), block(multi, sha(multi)) + block("tampered", sha(multi)));
    const out2 = await bundleMinutes(dir);
    assert.equal(out2.bundle.texts[sha(multi)].text, multi, "an empty line inside the text survives");
    assert.equal(out2.bundle.texts[sha(multi)].chair, "local:x");
    assert.equal(out2.warnings.length, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a decision text in the chair's voice bundles and verifies like any other: header, figures line and sentences, byte for byte", async () => {
  const voiced = "$CHAIR decision, epoch 310, chair local:qwen3.8-27b.\nRate in effect 190 bps; decision 190 bps.\nThe Committee of One has met. The Chair asks that this be recorded.";
  const dir = await mkdtemp(join(tmpdir(), "chair-voice-"));
  try {
    await writeFile(join(dir, "testnet-run-agent-voice-decisions.jsonl"), JSON.stringify({ kind: "decision", reasoning: voiced, reasoning_hash: sha(voiced), chair: "local:qwen3.8-27b", chair_kind: "llm" }) + "\n");
    const out = await bundleMinutes(dir);
    assert.deepEqual(out.warnings, []);
    assert.equal(out.bundle.texts[sha(voiced)].text, voiced);
    assert.equal(await checkReasoning(voiced, sha(voiced)), "verified");
    assert.equal(await checkReasoning(voiced.replace("190 bps; decision", "180 bps; decision"), sha(voiced)), "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---- decisions from chain events ----

test("policy_set events become decisions, newest first, and a malformed or foreign one is never listed", async () => {
  const d = await loadLog(fixtureTransport(fixture));
  assert.ok(d.decisions.length >= 5, `${d.decisions.length} decisions in the recorded sandbox run`);
  const epochs = d.decisions.map((x) => x.epoch);
  assert.deepEqual(epochs, [...epochs].sort((a, b) => b - a), "newest first");
  const first = d.decisions.at(-1);
  assert.deepEqual([first.epoch, first.rateBps, first.previousRateBps, first.hash], [0, 40, 0, "56fdf1631631b6f8ea9b1db386464cafe57081f12fde67f6043581c322f5e102"]);

  const log = (data) => `EVENT_JSON:${JSON.stringify({ standard: "chair", version: "1.0.0", event: "policy_set", data })}`;
  const ok = { chair: "chair.test.near", epoch: 3, rate_bps: 10, previous_rate_bps: 0, reasoning_hash: "a".repeat(64) };
  const tx = (token, logs) => ({ transaction: { hash: "5".repeat(44), signer_id: "chair.test.near", actions: [] }, receipts: [{ execution_outcome: { block_height: 9, block_timestamp: "1700000000000000000", outcome: { executor_id: token, status: { SuccessValue: "" }, logs } } }] });
  const bad = [{ ...ok, reasoning_hash: "A".repeat(64) }, { ...ok, reasoning_hash: "a".repeat(63) }, { ...ok, rate_bps: "10" }, { ...ok, epoch: -1 }, { ...ok, chair: "NOT AN ACCOUNT" }, "x"];
  const out = decisionsOfTxs([tx("tok.testnet", [log(ok), ...bad.map(log)]), tx("evil.testnet", [log(ok)])], "tok.testnet");
  assert.equal(out.decisions.length, 1, "only the token's own log counts");
  assert.equal(out.unreadable, bad.length);
});

// ---- silence ----

test("silence says what the chair's absence did to the rate, and only says decayed when the rate moved", () => {
  const p = (over) => ({ epoch: 300, rateBps: 0, lastSetEpoch: 217, ...over });
  assert.match(silence(p({}), { rateBps: 10 }).text, /^No decision for 82 meetings; the rate has decayed to 0.00%\./);
  assert.match(silence(p({}), { rateBps: 0 }).text, /^No decision for 82 meetings; the rate stays at 0.00%\./);
  assert.match(silence(p({ lastSetEpoch: 298 }), { rateBps: 10 }).text, /^No decision for 1 meeting;/);
  assert.match(silence(p({ lastSetEpoch: 299 }), undefined).text, /^No decision yet in meeting 300/);
  assert.match(silence(p({ lastSetEpoch: 300 }), undefined).text, /decided in the current meeting/);
  assert.match(silence(p({ lastSetEpoch: null }), undefined).text, /not set a rate yet/);
  assert.match(silence(p({}), undefined).text, /^No decision for 82 meetings; the rate in effect is 0.00%\./, "no decision list (index down): claims no decay");
});

// ---- rendering ----

const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007 <script>alert(1)</script>";
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const FORBIDDEN_TAGS = new Set(["script", "img", "iframe", "style", "object", "embed", "link"]);
const HREF = /^(#seal|https:\/\/(example\.invalid\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}|example\.invalid\/repo\/blob\/main\/docs\/[\w.-]+))$/;

function assertInert(root, label) {
  for (const n of walk(root)) {
    if (n.data !== undefined) {
      assert.equal(HIDDEN.test(n.data), false, `${label}: raw control, bidi or invisible character in ${JSON.stringify(n.data.slice(0, 50))}`);
      continue;
    }
    assert.equal(FORBIDDEN_TAGS.has(n.tag), false, `${label}: element <${n.tag}>`);
    for (const [k, v] of Object.entries(n.attrs)) {
      assert.equal(/^on/i.test(k), false, `${label}: attribute ${k}`);
      if (k === "href") assert.match(v, HREF, `${label}: href`);
    }
  }
}

// Every decision gets its own transaction hash, as on chain: the page keys what it resolved by it.
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const txId = (n) => `${"1".repeat(42)}${BASE58[Math.floor(n / 58)]}${BASE58[n % 58]}`;
let txCount = 0;
const decision = (over = {}) => ({ chair: "chair.test.near", epoch: 5, rateBps: 10, previousRateBps: 0, hash: sha("t"), chainText: null, tx: txId(++txCount), tsMs: 1_700_000_000_000, height: 1, ...over });
const policy = { epoch: 9, rateBps: 0, lastSetEpoch: 5, streak: 1, epochEndsMs: 1, chair: "chair.test.near" };
const ctx = (texts, resolved) => ({ texts, resolved, explorer: "https://example.invalid", repoBase: "https://example.invalid/repo/blob/main", unit: "a day" });
/** The page's two slots, hero (the latest decision) and the minutes list (the earlier ones), in one host. */
const render = (d, c) => {
  const doc = fakeDoc();
  const h = host(doc);
  const slots = [host(doc), host(doc)];
  renderHero(doc, slots[0], d, c);
  renderMinutes(doc, slots[1], d, c);
  h.append(...slots);
  return h;
};

test("a verified decision shows its text, the verified mark, the rate and the move, the chair label and a transaction link", async () => {
  const r = recorded.find((x) => x.chair_kind === "llm" && x.rate_bps !== 0);
  const hash = r.reasoning_hash;
  const d = { decisions: [decision({ hash, rateBps: r.rate_bps, previousRateBps: r.previous_rate_bps, epoch: r.epoch })], policy, status: "complete" };
  const texts = await textsMap();
  const h = render(d, ctx(texts, await resolveTexts(d.decisions, texts)));
  const text = textOf(h);
  const { meta, prose } = splitMinutes(r.reasoning);
  assert.ok(text.includes(prose) && meta.length === 2 && meta.every((line) => text.includes(line)), "the prose and both boilerplate lines are shown");
  assert.match(text, /Verified/);
  assert.match(text, new RegExp(`Meeting ${r.epoch}`));
  assert.ok(text.includes(r.chair) && text.includes("an AI model"));
  assert.match(text, /No decision for 3 meetings; the rate has decayed to 0.00%/);
  assert.ok([...walk(h)].some((n) => n.tag === "a" && n.attrs.href === `https://example.invalid/txns/${d.decisions[0].tx}`));
  assert.ok(!text.includes("Mismatch") && !text.includes("none was saved"));
  assertInert(h, "verified");
});

test("a text that does not hash to the on-chain hash is marked as a mismatch, never as verified", async () => {
  const hash = sha("what the chain committed to");
  const texts = new Map([[hash, { text: "some other text", chair: "x", kind: "llm", source: null }]]);
  const d = { decisions: [decision({ hash })], policy, status: "complete" };
  const resolved = await resolveTexts(d.decisions, texts);
  assert.equal(resolved.get(d.decisions[0].tx).verdict, "mismatch");
  const text = textOf(render(d, ctx(texts, resolved)));
  assert.match(text, /Mismatch/);
  assert.match(text, /Do not trust this text/);
  assert.doesNotMatch(text, /Verified/);
});

test("a decision with neither a text on its transaction nor a bundled one shows its hash and the plain line, with no verified mark", async () => {
  const d = { decisions: [decision(), decision({ epoch: 4, hash: sha("older") })], policy, status: "complete" };
  const texts = new Map();
  const h = render(d, ctx(texts, await resolveTexts(d.decisions, texts)));
  const text = textOf(h);
  assert.equal(text.split("its transaction carries none and none was saved").length - 1, 2, "latest card and the older row");
  assert.ok(text.includes(sha("t")));
  assert.doesNotMatch(text, /Verified|Mismatch/);
  const none = textOf(render(d, ctx(null, new Map())));
  assert.match(none, /could not be loaded/);
  assert.doesNotMatch(none, /none was saved/, "a failed bundle load is not reported as a decision without text");
});

test("hostile text, label, account and hash reach the page as inert text only", async () => {
  const hash = sha(EVIL);
  const texts = new Map([[hash, { text: EVIL, chair: EVIL, kind: EVIL, source: "../../x<y>" }]]);
  const d = { decisions: [decision({ hash, chair: EVIL, tx: EVIL }), decision({ hash: sha("x"), epoch: 4 })], policy: { ...policy, chair: EVIL }, status: "complete" };
  const resolved = await resolveTexts(d.decisions, texts);
  assert.equal(resolved.get(d.decisions[0].tx).verdict, "verified", "the check runs on the exact hostile text");
  const h = render(d, ctx(texts, resolved));
  assertInert(h, "hostile");
  const text = textOf(h);
  assert.match(text, /<img src=x onerror=alert\(1\)>\\u\{202e\}/, "markup shown as text, controls shown as escapes");
  assert.match(text, /invalid id: /);
  assert.match(text, /shown as \\u\{\.\.\.\} escapes/);
  assert.ok(![...walk(h)].some((n) => n.tag === "a" && /docs\//.test(n.attrs.href ?? "")), "an odd source name makes no link");
  // the bundle itself is untrusted too: wrong schema, wrong key shapes, non-string text
  const bad = (doc) => loadTexts("m.json", async () => ({ ok: true, json: async () => doc }));
  assert.equal(await bad({ schema: "other", texts: {} }), null);
  assert.equal(await bad({ schema: "chair-minutes/1", texts: [] }), null);
  assert.equal((await bad({ schema: "chair-minutes/1", texts: { nothex: { text: "x" }, [hash]: { text: 5 }, [sha("a")]: { text: "a" } } })).size, 1);
  assert.equal(await loadTexts("m.json", async () => ({ ok: false })), null);
  assert.equal(await loadTexts("m.json", async () => { throw new Error("offline"); }), null);
});

test("the latest decision is the hero, earlier ones are cards that show more in place a page at a time", async () => {
  const many = Array.from({ length: 45 }, (_, i) => decision({ epoch: 100 - i, hash: sha(`h${i}`) }));
  const doc = fakeDoc();
  const hero = host(doc);
  const list = host(doc);
  const c = ctx(new Map(), new Map());
  renderHero(doc, hero, { decisions: many, policy, status: "complete" }, c);
  renderMinutes(doc, list, { decisions: many, policy, status: "complete" }, c);
  assert.match(textOf(hero), /Meeting 100/);
  assert.doesNotMatch(textOf(list), /Epoch 100(?!\d)/, "the hero's decision is not listed again");
  const cards = () => [...walk(list)].filter((n) => n.tag === "article").length;
  assert.equal(cards(), 3, "the page opens on the 3 newest earlier decisions, not a wall of them");
  assert.match(textOf(list), /Showing the 3 newest of 44 earlier decisions \(45 in all, counting the latest at the top of the page\)\./);
  assert.equal([...walk(list)].some((n) => n.attrs?.["aria-controls"]), false);
  const more = () => [...walk(list)].find((n) => n.tag === "button" && /^Show \d+ more$/.test(textOf(n)));
  assert.equal(textOf(more()), "Show 20 more");
  more().listeners.click[0]();
  assert.equal(cards(), 23);
  assert.match(textOf(list), /Showing the 23 newest of 44/);
  assert.equal(textOf(more()), "Show 20 more");
  more().listeners.click[0]();
  assert.equal(cards(), 43);
  const last = more();
  assert.equal(textOf(last), "Show 1 more");
  last.listeners.click[0]();
  assert.equal(cards(), 44);
  assert.equal(last.hidden, true);
});

test("the refusals are labelled by what they were: every known one is a deliberate project test, with the contract's reason in plain words and its own text beside it", async () => {
  const deployment = JSON.parse(await readFile(join(docs, "testnet-deployment.json"), "utf8"));
  const refusedSteps = deployment.transactions.filter((s) => s.outcome === "refused" && s.hash);
  assert.deepEqual([...PROJECT_TEST_CALLS].sort(), refusedSteps.map((s) => s.hash).sort(), "the labelled hashes are exactly the scripted run's refused transactions");
  assert.equal(humanReason("only the chair may set policy: caller x"), "The account that signed was not the chair.");
  assert.match(humanReason("rate_bps out of bounds: must be within -200..=200"), /limit of 200 bps either way: 2% of supply a day when printing/);
  assert.match(humanReason("rate step too large: moving from 190 to 100"), /more than 0.5% \(50 bps\) away/);
  assert.match(humanReason("policy already set this epoch"), /already decided in that epoch/);
  assert.match(humanReason("reasoning_hash must be 64 lowercase hex characters"), /not a SHA-256 digest/);
  assert.equal(humanReason("something new"), null, "an unknown reason is shown raw, never guessed at");
  const [known] = [...PROJECT_TEST_CALLS];
  const row = (tx, signer, reason) => ({ tx, signer, rateBps: 201, reason, tsMs: 1_700_000_000_000, byVisitor: false });
  const draw = (refusals) => {
    const doc = fakeDoc();
    const hostNode = host(doc);
    renderRefusals(doc, hostNode, { status: "complete", refusals }, { explorer: "https://example.invalid", indexerUrl: "https://idx.example.invalid" });
    return hostNode;
  };
  const all = draw([row(known, "launch.chair.testnet", "rate_bps out of bounds: must be within -200..=200")]);
  assert.match(textOf(all), /All 1 were deliberate test calls that I made to show the bounds hold, signed by launch\.chair\.testnet \(1\)\. In none of them did the AI chair choose a rate the contract refused\./);
  assert.match(textOf(all), /limit of 200 bps either way: 2% of supply a day when printing, 2% of a transfer when burning/);
  assert.match(textOf(all), /The contract's own words: rate_bps out of bounds: must be within -200\.\.=200/, "the raw text stays, in small print");
  assert.ok([...walk(all)].some((n) => n.tag === "td" && n.attrs.title === "The contract's own words: rate_bps out of bounds: must be within -200..=200"), "and on hover");
  const forced = draw([row(known, "launch.chair.testnet", "x"), { ...row(txId(8), "ai.chair.testnet", "x"), byVisitor: true }]);
  assert.match(textOf(forced), /1 of the 2 were deliberate test calls.*; 1 was forced by visitors through the press desk\. In none of them/);
  const stranger = draw([row(known, "launch.chair.testnet", "x"), row(txId(9), "ai.chair.testnet", "x")]);
  assert.match(textOf(stranger), /1 of the 2 were deliberate test calls/);
  assert.doesNotMatch(textOf(stranger), /did the AI chair choose/, "a refusal the page cannot account for withdraws the claim about the AI chair");
  assert.doesNotMatch(textOf(draw([row(txId(9), "ai.chair.testnet", "x")])), /deliberate test/, "nothing known, nothing claimed");
  assert.ok([...walk(all)].some((n) => n.tag === "button" && textOf(n) === "raw"), "each row has the raw curl chip");
});

test("rawTxCommand: a real hash gets a curl line against the indexer, anything else gets none, and no chain string reaches a shell", () => {
  const hash = txId(3);
  assert.equal(rawTxCommand("https://idx.example.invalid", hash), `curl -s https://idx.example.invalid/v0/transactions -H 'content-type: application/json' -d '{"tx_hashes":["${hash}"]}'`);
  assert.match(rawTxCommand("https://idx.example.invalid", hash, { reasoning: true }), /\| jq -r '\.transactions\[0\]\.transaction\.actions\[0\]\.FunctionCall\.args \| @base64d \| fromjson \| \.reasoning'$/);
  assert.equal(rawTxCommand(null, hash), null, "no indexer: no command (the recorded sandbox run)");
  for (const bad of ["x'; rm -rf ~ #", "", null, hash + "0"]) assert.equal(rawTxCommand("https://idx.example.invalid", bad), null);
});

test("chart axis labels fit at phone width: the y labels are never clipped and an x tick never touches the axis title", () => {
  const observers = [];
  globalThis.ResizeObserver = class { constructor(fn) { observers.push(fn); } observe(el) { this.el = el; observers[observers.length - 1].el = el; } };
  try {
    const doc = fakeDoc();
    const values = Array.from({ length: 61 }, (_, i) => Math.round(-200 + (400 * i) / 60));
    const chart = lineChart(doc, { title: "Rate in effect", caption: "c", series: [{ id: "a", label: "A", slot: 1, values }], domain: [-200, 200], fmt: (v, axis) => (axis ? `${v > 0 ? "+" : v < 0 ? "\u2212" : ""}${Math.abs(v)}` : `${v} bps`), guides: [] });
    const frame = (w) => {
      const [fn] = observers;
      fn.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: w, height: 220 });
      fn();
      const svg = [...walk(chart.element)].find((n) => n.tag === "svg");
      const texts = [...walk(svg)].filter((n) => n.tag === "text");
      return { svg, texts };
    };
    for (const w of [327, 375, 640, 900]) {
      const { svg, texts } = frame(w);
      assert.equal(svg.attrs.viewBox.split(" ")[2], String(w), "drawn at the width it is shown at, so text never scales");
      const yLabels = texts.filter((n) => n.attrs.class === "tick" && n.attrs["text-anchor"] === "end" && !["Epoch"].includes(textOf(n)));
      assert.ok(yLabels.length >= 5);
      for (const l of yLabels) assert.ok(Number(l.attrs.x) - textOf(l).length * 7 >= 0, `${textOf(l)} fits inside the left edge at ${w}px`);
      const title = texts.find((n) => textOf(n) === "Epoch");
      const xTicks = texts.filter((n) => n.attrs["text-anchor"] === "middle");
      assert.ok(xTicks.length >= 2);
      for (const x of xTicks) assert.ok(Number(x.attrs.x) + (textOf(x).length * 7.4) / 2 < Number(title.attrs.x) - 36, `x tick ${textOf(x)} clear of the axis title at ${w}px`);
    }
  } finally {
    delete globalThis.ResizeObserver;
  }
});

test("the two boilerplate header lines are metadata, not the quote; a text without them is all quote", async () => {
  const voiced = "$CHAIR decision, epoch 310, chair local:qwen3.8-27b.\nRate in effect 190 bps; decision 190 bps.\nThe Committee of One has met. The Chair asks that this be recorded.";
  assert.deepEqual(splitMinutes(voiced), { meta: ["$CHAIR decision, epoch 310, chair local:qwen3.8-27b.", "Rate in effect 190 bps; decision 190 bps."], prose: "The Committee of One has met. The Chair asks that this be recorded." });
  assert.deepEqual(splitMinutes("The Chair holds."), { meta: [], prose: "The Chair holds." });
  assert.deepEqual(splitMinutes("$CHAIR decision, epoch 1, chair x.\nRate in effect 0 bps; decision 0 bps."), { meta: [], prose: "$CHAIR decision, epoch 1, chair x.\nRate in effect 0 bps; decision 0 bps." }, "nothing but boilerplate: shown whole");
  const hash = sha(voiced);
  const d = { decisions: [decision({ hash, rateBps: -15, previousRateBps: 0, epoch: 310 }), decision({ hash, rateBps: -15, previousRateBps: 0, epoch: 309 })], policy, status: "complete" };
  const texts = new Map([[hash, { text: voiced, chair: "local:qwen3.8-27b", kind: "llm", source: null }]]);
  const resolved = new Map(d.decisions.map((x) => [x.tx, { text: voiced, chair: "local:qwen3.8-27b", kind: "llm", source: null, onChain: false, verdict: "verified" }]));
  const page = render(d, ctx(texts, resolved));
  const quotes = [...walk(page)].filter((n) => n.tag === "blockquote");
  assert.equal(quotes.length, 2, "hero and card");
  for (const q of quotes) assert.equal(textOf(q), "The Committee of One has met. The Chair asks that this be recorded.", "only the sentences are the quote");
  const metas = [...walk(page)].filter((n) => n.attrs?.class === "m-meta");
  assert.equal(metas.length, 2);
  assert.match(textOf(metas[0]), /^\$CHAIR decision, epoch 310, chair local:qwen3\.8-27b\.Rate in effect 190 bps; decision 190 bps\.$/);
});

test("the hero leads with the prose, the rate as a percent with bps second, what it does, and a verified mark that folds the proof", async () => {
  const text = "$CHAIR decision, epoch 408, chair local:qwen3.8-27b.\nRate in effect 0 bps; decision -15 bps.\nThe Chair cuts the rate by 15 basis points. The Chair has no further comment.";
  const hash = sha(text);
  const d = { decisions: [decision({ hash, rateBps: -15, previousRateBps: 0, epoch: 408 })], policy: { ...policy, epoch: 409, lastSetEpoch: 408 }, status: "complete" };
  const resolved = await resolveTexts(d.decisions, new Map([[hash, { text, chair: "local:qwen3.8-27b", kind: "llm", source: null }]]));
  const doc = fakeDoc();
  const hero = host(doc);
  renderHero(doc, hero, d, { ...ctx(null, resolved), network: "testnet" });
  const all = [...walk(hero)];
  const nodeText = (cls) => textOf(all.find((n) => n.attrs?.class === cls));
  assert.equal(nodeText("reasoning"), "The Chair cuts the rate by 15 basis points. The Chair has no further comment.");
  assert.equal(nodeText("rate-big"), "\u22120.15%");
  assert.equal(nodeText("rate-bps"), "\u221215 bps");
  assert.equal(nodeText("rate-effect"), "Burns 0.15% of every transfer.");
  assert.match(textOf(all.find((n) => n.tag === "summary")), /Verified on NEAR testnet/);
  const details = all.find((n) => n.tag === "details");
  assert.match(textOf(details), new RegExp(`${hash}[\\s\\S]*`), "the hash sits inside the fold");
  assert.ok(all.some((n) => n.tag === "a" && n.attrs.href === `https://example.invalid/txns/${d.decisions[0].tx}`), "and the transaction link");
  assert.ok(!textOf(all.find((n) => n.tag === "summary")).includes(hash), "the hash is not the lead");
  assert.doesNotMatch(textOf(hero), /No decision for/, "no silence note while the Chair is current");
  // a recorded sandbox run is never called testnet
  const fx = host(doc);
  renderHero(doc, fx, d, { ...ctx(null, resolved), network: null });
  assert.match(textOf(fx), /Verified against the recorded sandbox run/);
  assert.doesNotMatch(textOf(fx), /testnet/);
  const rates = (bps) => { const x = host(doc); renderHero(doc, x, { ...d, decisions: [{ ...d.decisions[0], rateBps: bps }] }, ctx(null, resolved)); return textOf(x); };
  assert.match(rates(40), /\+0\.40%[\s\S]*Mints 0\.40% of supply a day for stakers\./, "a printing rate is per day");
  const older = host(doc);
  renderHero(doc, older, { ...d, decisions: [{ ...d.decisions[0], rateBps: 40 }] }, { ...ctx(null, resolved), unit: "every 90 seconds" });
  assert.match(textOf(older), /Mints 0\.40% of supply every 90 seconds for stakers\./, "a token without meetings_per_day keeps its own unit");
  assert.match(rates(0), /0\.00%[\s\S]*Nothing minted, nothing burned\./);
});

test("an unreadable index says so instead of claiming there is no decision; an empty chain says that", () => {
  assert.match(textOf(render({ decisions: [], policy: { ...policy, lastSetEpoch: null }, status: "incomplete" }, ctx(new Map(), new Map()))), /index, which could not be read/);
  assert.match(textOf(render({ decisions: [], policy: { ...policy, lastSetEpoch: null }, status: "complete" }, ctx(new Map(), new Map()))), /No decision has been recorded on chain yet/);
});

// ---- the text on the transaction ----

const b64 = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64");
const TOKEN = "tok.testnet";
const call = (args, method = "set_policy") => ({ FunctionCall: { method_name: method, args, gas: 30_000_000_000_000, deposit: "0" } });
/** A set_policy transaction as the index returns it: its arguments, and the token's receipt with `status` and `logs`. */
const policyTx = (n, args, status, logs = [], over = {}) => ({
  transaction: { hash: txId(n), signer_id: "chair.test.near", receiver_id: TOKEN, actions: [call(args)] },
  receipts: [{ execution_outcome: { block_height: 100 + n, block_timestamp: "1700000000000000000", outcome: { executor_id: TOKEN, status, logs } } }],
  ...over,
});
const policySet = (hash, over = {}) => `EVENT_JSON:${JSON.stringify({ standard: "chair", version: "1.0.0", event: "policy_set", data: { chair: "chair.test.near", epoch: 7, rate_bps: 10, previous_rate_bps: 0, reasoning_hash: hash, ...over } })}`;
const refused = (text) => ({ Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: text } } } } });
const TEXT = "$CHAIR decision, epoch 7.\nThe Committee of One has met. \u00e9 \u4e2d \u{1F600}";

test("a decision reads the reasoning argument of its transaction, and the page checks it against the hash", async () => {
  const hash = sha(TEXT);
  const txs = [policyTx(1, b64({ rate_bps: 10, reasoning_hash: hash, reasoning: TEXT }), { SuccessValue: "" }, [policySet(hash)])];
  const { decisions } = decisionsOfTxs(txs, TOKEN);
  assert.equal(decisions[0].chainText, TEXT, "UTF-8 survives the base64 round trip");
  const resolved = await resolveTexts(decisions, new Map());
  assert.deepEqual([resolved.get(decisions[0].tx).verdict, resolved.get(decisions[0].tx).onChain], ["verified", true]);
  const d = { decisions, policy, status: "complete" };
  const h = render(d, ctx(new Map(), resolved));
  const { meta, prose } = splitMinutes(TEXT);
  assert.ok(textOf(h).includes(prose) && /Verified/.test(textOf(h)) && /read from the arguments of the transaction/.test(textOf(h)));
  assert.deepEqual(meta, [], "this text has no boilerplate lines, so all of it is the quote");
  assertInert(h, "chain text");
});

test("a reasoning argument that does not hash to the event's hash is a mismatch; a bundled text that does is used instead", async () => {
  const hash = sha(TEXT);
  const forged = policyTx(1, b64({ rate_bps: 10, reasoning_hash: hash, reasoning: "edited text" }), { SuccessValue: "" }, [policySet(hash)]);
  const { decisions } = decisionsOfTxs([forged], TOKEN);
  const alone = await resolveTexts(decisions, new Map());
  assert.deepEqual([alone.get(decisions[0].tx).text, alone.get(decisions[0].tx).verdict], ["edited text", "mismatch"]);
  const bundled = new Map([[hash, { text: TEXT, chair: "local:x", kind: "llm", source: "testnet-run-agent-x-decisions.jsonl" }]]);
  const both = await resolveTexts(decisions, bundled);
  assert.deepEqual([both.get(decisions[0].tx).text, both.get(decisions[0].tx).verdict, both.get(decisions[0].tx).onChain], [TEXT, "verified", false]);
  assert.equal(await resolveTexts(decisions, null, null).then((m) => m.get(decisions[0].tx).verdict), "unchecked", "no crypto.subtle: never a verified mark");
});

test("arguments that are not a text are no text: other methods, bad base64, bad UTF-8, a non-string or empty reasoning, oversize arguments", () => {
  const hash = sha(TEXT);
  const ok = { SuccessValue: "" };
  const cases = [
    policyTx(1, b64({ rate_bps: 10, reasoning_hash: hash }), ok, [policySet(hash)]),
    policyTx(2, b64({ rate_bps: 10, reasoning_hash: hash, reasoning: 5 }), ok, [policySet(hash)]),
    policyTx(3, b64({ rate_bps: 10, reasoning_hash: hash, reasoning: "" }), ok, [policySet(hash)]),
    policyTx(4, "!!not base64!!", ok, [policySet(hash)]),
    policyTx(5, Buffer.from([0x7b, 0xff, 0x7d]).toString("base64"), ok, [policySet(hash)]),
    policyTx(6, b64({ reasoning: "x".repeat(20_001) }), ok, [policySet(hash)]),
    policyTx(7, b64([TEXT]), ok, [policySet(hash)]),
    { ...policyTx(8, b64({ reasoning: TEXT }), ok, [policySet(hash)]), transaction: { hash: txId(8), signer_id: "chair.test.near", receiver_id: TOKEN, actions: [call(b64({ reasoning: TEXT }), "ft_transfer")] } },
  ];
  const { decisions } = decisionsOfTxs(cases, TOKEN);
  assert.equal(decisions.length, cases.length, "every decision is still listed");
  assert.deepEqual(decisions.map((d) => d.chainText), cases.map(() => null).reverse());
});

test("every refused set_policy call is listed with the contract's own panic text, newest first; accepted calls and other methods are not", () => {
  const bad = { rate_bps: 201, reasoning_hash: "a".repeat(64) };
  const txs = [
    policyTx(1, b64(bad), refused("Smart contract panicked: rate_bps out of bounds: must be within -200..=200")),
    policyTx(2, b64({ rate_bps: 10, reasoning_hash: "b".repeat(64) }), { SuccessValue: "" }, [policySet("b".repeat(64))]),
    policyTx(3, b64({ rate_bps: 0, reasoning_hash: "c".repeat(64) }), refused("Smart contract panicked: only the chair may set policy"), [], { transaction: { hash: txId(3), signer_id: "carol.test.near", receiver_id: TOKEN, actions: [call(b64({ rate_bps: 0 }))] } }),
    policyTx(4, "!!", refused("Smart contract panicked: policy already set this epoch")),
    policyTx(5, b64(bad), refused("Smart contract panicked: x"), [], { transaction: { hash: txId(5), signer_id: "chair.test.near", receiver_id: TOKEN, actions: [call(b64(bad), "ft_transfer")] } }),
    policyTx(6, b64(bad), { Failure: { ActionError: { index: 0, kind: { FunctionCallError: "CompilationError" } } } }),
    { ...policyTx(7, b64(bad), refused("Smart contract panicked: elsewhere")), receipts: [{ execution_outcome: { block_height: 107, block_timestamp: "1700000000000000000", outcome: { executor_id: "evil.testnet", status: refused("Smart contract panicked: elsewhere"), logs: [] } } }] },
  ];
  const out = refusalsOfTxs(txs, TOKEN);
  assert.deepEqual(out.map((r) => [r.tx, r.signer, r.rateBps, r.reason]), [
    [txId(6), "chair.test.near", 201, "failed without a contract message"],
    [txId(4), "chair.test.near", null, "policy already set this epoch"],
    [txId(3), "carol.test.near", 0, "only the chair may set policy"],
    [txId(1), "chair.test.near", 201, "rate_bps out of bounds: must be within -200..=200"],
  ]);
  assert.deepEqual(refusalsOfTxs(txs, "other.testnet"), [], "only calls to the token itself");
});

test("the Refusals section lists each refusal with its panic text and a transaction link, and says so when there is none or the index is down", () => {
  const refusals = refusalsOfTxs([policyTx(1, b64({ rate_bps: -201, reasoning_hash: "a".repeat(64) }), refused(`Smart contract panicked: ${EVIL}`))], TOKEN);
  const draw = (d) => {
    const doc = fakeDoc();
    const hostNode = host(doc);
    renderRefusals(doc, hostNode, d, { explorer: "https://example.invalid" });
    return hostNode;
  };
  const h = draw({ status: "complete", refusals });
  assert.match(textOf(h), /1 refused set_policy call, newest first/);
  assert.match(textOf(h), /\u2212201 bps/);
  assert.match(textOf(h), /<img src=x onerror=alert\(1\)>\\u\{202e\}/, "the panic text is shown escaped, as text");
  assert.ok([...walk(h)].some((n) => n.tag === "a" && n.attrs.href === `https://example.invalid/txns/${txId(1)}`));
  assertInert(h, "refusals");
  assert.match(textOf(draw({ status: "complete", refusals: [] })), /refused no set_policy call yet/);
  assert.match(textOf(draw({ status: "incomplete", refusals: [] })), /index, which could not be read/);
});
