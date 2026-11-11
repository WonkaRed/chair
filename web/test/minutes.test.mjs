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
const { checkReasoning, loadTexts, renderMinutes, resolveTexts, sha256Hex, silence } = await site("minutes.js");
const { renderRefusals } = await site("refusals.js");
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

// Every decision gets its own transaction hash, as on chain: the page keys what it resolved by it.
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const txId = (n) => `${"1".repeat(42)}${BASE58[Math.floor(n / 58)]}${BASE58[n % 58]}`;
let txCount = 0;
const decision = (over = {}) => ({ chair: "chair.test.near", epoch: 5, rateBps: 10, previousRateBps: 0, hash: sha("t"), chainText: null, tx: txId(++txCount), tsMs: 1_700_000_000_000, height: 1, ...over });
const policy = { epoch: 9, rateBps: 0, lastSetEpoch: 5, streak: 1, epochEndsMs: 1, chair: "chair.test.near" };
const ctx = (texts, resolved) => ({ texts, resolved, explorer: "https://example.invalid", repoBase: "https://example.invalid/repo/blob/main" });
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
  const h = render(d, ctx(texts, await resolveTexts(d.decisions, texts)));
  const text = textOf(h);
  assert.ok(text.includes(r.reasoning), "the text is shown whole");
  assert.match(text, /Verified/);
  assert.match(text, new RegExp(`Epoch ${r.epoch}`));
  assert.ok(text.includes(r.chair) && text.includes("an AI model"));
  assert.match(text, /No decision for 3 epochs; the rate has decayed to 0 bps/);
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
  assert.ok(textOf(h).includes(TEXT) && /Verified/.test(textOf(h)) && /read from the arguments of the transaction/.test(textOf(h)));
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
