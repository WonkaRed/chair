// The chair minutes: decisions read from chain events, reasoning texts bundled from docs/, and the in-browser hash check.
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
const { decisionsOfTxs } = await site("decisions.js");
const { checkDecisions, checkReasoning, loadTexts, renderMinutes, sha256Hex, silence } = await site("minutes.js");
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
  assert.match(silence(p({}), { rateBps: 10 }).text, /^No decision for 82 epochs; the rate has decayed to 0 bps\./);
  assert.match(silence(p({}), { rateBps: 0 }).text, /^No decision for 82 epochs; the rate stays at 0 bps\./);
  assert.match(silence(p({ lastSetEpoch: 298 }), { rateBps: 10 }).text, /^No decision for 1 epoch;/);
  assert.match(silence(p({ lastSetEpoch: 299 }), undefined).text, /^No decision yet in epoch 300/);
  assert.match(silence(p({ lastSetEpoch: 300 }), undefined).text, /decided in the current epoch/);
  assert.match(silence(p({ lastSetEpoch: null }), undefined).text, /not set a rate yet/);
  assert.match(silence(p({}), undefined).text, /^No decision for 82 epochs; the rate in effect is 0 bps\./, "no decision list (index down): claims no decay");
});

// ---- rendering ----

const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007 <script>alert(1)</script>";
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const FORBIDDEN_TAGS = new Set(["script", "img", "iframe", "style", "object", "embed", "link"]);
const HREF = /^https:\/\/(example\.invalid\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}|example\.invalid\/repo\/blob\/main\/docs\/[\w.-]+)$/;

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

const decision = (over = {}) => ({ chair: "chair.test.near", epoch: 5, rateBps: 10, previousRateBps: 0, hash: sha("t"), tx: "5".repeat(44), tsMs: 1_700_000_000_000, height: 1, ...over });
const policy = { epoch: 9, rateBps: 0, lastSetEpoch: 5, streak: 1, epochEndsMs: 1, chair: "chair.test.near" };
const ctx = (texts, checks) => ({ texts, checks, explorer: "https://example.invalid", repoBase: "https://example.invalid/repo/blob/main" });
const render = (d, c) => {
  const doc = fakeDoc();
  const h = host(doc);
  renderMinutes(doc, h, d, c);
  return h;
};

test("a verified decision shows its text, the verified mark, the rate and the move, the chair label and a transaction link", async () => {
  const r = recorded.find((x) => x.chair_kind === "llm" && x.rate_bps !== 0);
  const hash = r.reasoning_hash;
  const d = { decisions: [decision({ hash, rateBps: r.rate_bps, previousRateBps: r.previous_rate_bps, epoch: r.epoch })], policy, status: "complete" };
  const texts = await textsMap();
  const h = render(d, ctx(texts, await checkDecisions(d.decisions, texts)));
  const text = textOf(h);
  assert.ok(text.includes(r.reasoning), "the text is shown whole");
  assert.match(text, /Verified/);
  assert.match(text, new RegExp(`Epoch ${r.epoch}`));
  assert.ok(text.includes(r.chair) && text.includes("an AI model"));
  assert.match(text, /No decision for 3 epochs; the rate has decayed to 0 bps/);
  assert.ok([...walk(h)].some((n) => n.tag === "a" && n.attrs.href === `https://example.invalid/txns/${"5".repeat(44)}`));
  assert.ok(!text.includes("Mismatch") && !text.includes("not published"));
  assertInert(h, "verified");
});

test("a text that does not hash to the on-chain hash is marked as a mismatch, never as verified", async () => {
  const hash = sha("what the chain committed to");
  const texts = new Map([[hash, { text: "some other text", chair: "x", kind: "llm", source: null }]]);
  const d = { decisions: [decision({ hash })], policy, status: "complete" };
  const checks = await checkDecisions(d.decisions, texts);
  assert.equal(checks.get(hash), "mismatch");
  const text = textOf(render(d, ctx(texts, checks)));
  assert.match(text, /Mismatch/);
  assert.match(text, /Do not trust this text/);
  assert.doesNotMatch(text, /Verified/);
});

test("a decision without a bundled text shows its hash and the plain line, with no verified mark", async () => {
  const d = { decisions: [decision(), decision({ epoch: 4, hash: sha("older") })], policy, status: "complete" };
  const texts = new Map();
  const h = render(d, ctx(texts, await checkDecisions(d.decisions, texts)));
  const text = textOf(h);
  assert.equal(text.split("reasoning text not published for this decision").length - 1, 2, "latest card and the older row");
  assert.ok(text.includes(sha("t")));
  assert.doesNotMatch(text, /Verified|Mismatch/);
  const none = textOf(render(d, ctx(null, new Map())));
  assert.match(none, /could not be loaded/);
  assert.doesNotMatch(none, /not published/, "a failed bundle load is not reported as a decision without text");
});

test("hostile text, label, account and hash reach the page as inert text only", async () => {
  const hash = sha(EVIL);
  const texts = new Map([[hash, { text: EVIL, chair: EVIL, kind: EVIL, source: "../../x<y>" }]]);
  const d = { decisions: [decision({ hash, chair: EVIL, tx: EVIL }), decision({ hash: sha("x"), epoch: 4 })], policy: { ...policy, chair: EVIL }, status: "complete" };
  const checks = await checkDecisions(d.decisions, texts);
  assert.equal(checks.get(hash), "verified", "the check runs on the exact hostile text");
  const h = render(d, ctx(texts, checks));
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

test("older decisions sit behind a show-all control that toggles by click and shows more in place", async () => {
  const many = Array.from({ length: 45 }, (_, i) => decision({ epoch: 100 - i, hash: sha(`h${i}`) }));
  const h = render({ decisions: many, policy, status: "complete" }, ctx(new Map(), new Map()));
  const all = [...walk(h)];
  const toggle = all.find((n) => n.tag === "button" && n.attrs["aria-controls"] === "minutes-older");
  const list = all.find((n) => n.attrs?.id === "minutes-older");
  assert.equal(toggle.attrs["aria-expanded"], "false");
  assert.equal(list.hidden, true);
  assert.match(textOf(toggle), /Show all 44 earlier decisions/);
  assert.equal(all.filter((n) => n.tag === "details").length, 20, "rows are added a page at a time");
  toggle.listeners.click[0]();
  assert.equal(list.hidden, false);
  assert.equal(toggle.attrs["aria-expanded"], "true");
  assert.match(textOf(toggle), /Hide earlier/);
  const more = [...walk(h)].find((n) => n.tag === "button" && /^Show 20 more of 24/.test(textOf(n)));
  more.listeners.click[0]();
  assert.equal([...walk(h)].filter((n) => n.tag === "details").length, 40);
  [...walk(h)].find((n) => n.tag === "button" && /^Show 4 more of 4/.test(textOf(n))).listeners.click[0]();
  assert.equal([...walk(h)].filter((n) => n.tag === "details").length, 44);
  toggle.listeners.click[0]();
  assert.equal(list.hidden, true);
});

test("an unreadable index says so instead of claiming there is no decision; an empty chain says that", () => {
  assert.match(textOf(render({ decisions: [], policy: { ...policy, lastSetEpoch: null }, status: "incomplete" }, ctx(new Map(), new Map()))), /index, which could not be read/);
  assert.match(textOf(render({ decisions: [], policy: { ...policy, lastSetEpoch: null }, status: "complete" }, ctx(new Map(), new Map()))), /No decision has been recorded on chain yet/);
});
