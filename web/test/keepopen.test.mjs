// A section drawn again on every read must follow the chain (the hero's silence line moves with the meeting) without shutting a fold the visitor opened.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const site = (f) => import(join(root, "site", "js", f));
const { keepFoldsOpen } = await site("keepopen.js");
const { renderHero } = await site("minutes.js");
const { holdersModel, renderHolders } = await site("holders.js");

const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));
/** The fake DOM has no selectors; the one the helper uses (`details`) is answered from the tree. */
const withSelectors = (el) => Object.assign(el, { querySelectorAll: (sel) => (sel === "details" ? find(el, (n) => n.tag === "details") : []) });

const TX = "8".repeat(44);
const HASH = "a".repeat(64);
const decision = { chair: "chair.test.near", epoch: 5, rateBps: 10, previousRateBps: 0, hash: HASH, chainText: null, tx: TX, tsMs: 1_700_000_000_000, height: 1 };
const policyAt = (epoch) => ({ epoch, rateBps: 10, lastSetEpoch: 5, streak: 1, epochEndsMs: 1, chair: "chair.test.near" });
const ctx = { texts: new Map(), resolved: new Map([[TX, { text: "The Committee of One has met.", verdict: "verified", chair: null, kind: null, source: null, onChain: true }]]), explorer: "https://example.invalid", repoBase: "https://example.invalid/repo/blob/main", unit: "a day" };
const drawHero = (el, doc, meeting) => keepFoldsOpen(el, () => renderHero(doc, el, { decisions: [decision], remembered: [], status: "complete", policy: policyAt(meeting) }, ctx));

test("two reads that end on the same decision but a later meeting: the hero's silence line moves on and an opened proof stays open", () => {
  const doc = fakeDoc();
  const el = withSelectors(host(doc));
  drawHero(el, doc, 9);
  assert.match(el.textContent, /No decision for 3 meetings/);
  const proof = find(el, (n) => n.tag === "details");
  assert.ok(proof.length >= 1, "the hero card has a proof fold to keep");
  proof[0].open = true; // the visitor opens it
  drawHero(el, doc, 10);
  assert.match(el.textContent, /No decision for 4 meetings/, "the line follows the meeting");
  assert.doesNotMatch(el.textContent, /No decision for 3 meetings/);
  assert.equal(find(el, (n) => n.tag === "details")[0].open, true, "and the proof the visitor opened is still open");
});

test("a fold the visitor did not open stays as the redraw makes it, and one they opened is not opened twice over", () => {
  const doc = fakeDoc();
  const el = withSelectors(host(doc));
  drawHero(el, doc, 9);
  drawHero(el, doc, 10);
  assert.ok(find(el, (n) => n.tag === "details").every((n) => n.open !== true), "nothing is opened that the visitor left shut");
});

test("the holders' folds (shut on a phone by js/phonefold.js) keep the state the visitor gave them when the panel is read again", () => {
  const doc = fakeDoc();
  const el = withSelectors(host(doc));
  const params = { impeachThresholdBps: 3000, quorumBps: 500, maxRateBps: 200 };
  const supply = { totalStaked: 400n, totalSupply: 1000n };
  const draw = () => keepFoldsOpen(el, () => renderHolders(doc, el, holdersModel({ params, policy: { chair: "c.testnet", streak: 2, epoch: 5 }, supply, candidates: [] }), { showPast: false }));
  draw();
  const folds = find(el, (n) => n.tag === "details");
  assert.ok(folds.length >= 2);
  folds[0].open = true; // the challenger fold, opened on a phone
  draw(); // the join watch reads again every few seconds
  const after = find(el, (n) => n.tag === "details");
  assert.equal(after[0].open, true, "still open after the read");
  assert.notEqual(after[1].open, true, "the other fold was not opened");
});
