// The human-first layers: the plain sentence a non-crypto visitor reads first (built from chain numbers only), the minutes, refusals and
// guarantees that say it plainly with the exact wording folded, the fold-outs that start closed, and the reveal-on-scroll that never hides
// anything without script. Fake DOM, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const site = (f) => import(join(root, "site", "js", f));
const { plainPct, plainSigned, askedRate, printUnit, everyEpoch, plainDecision, renderPlain } = await site("views.js");
const { setupReveal, openFoldsAround } = await site("reveal.js");
const { renderHero, renderHeroPending, renderMinutes, overrideStat, ownLines } = await site("minutes.js");
const { renderRefusals, renderHeroStamp } = await site("refusals.js");
const { renderGuarantees, GUARANTEES, VERIFY_COMMAND } = await site("guarantees.js");
const html = await readFile(join(root, "site", "index.html"), "utf8");

const text = (n) => n.textContent;
const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));
const JARGON = /\bbps\b|basis points?|epoch|staked share/i;
const params = { maxRateBps: 200, epochMs: 90_000, meetingsPerDay: 960 };
const oldParams = { maxRateBps: 200, epochMs: 90_000, meetingsPerDay: null };

test("plain percent and cadence: 5 bps is 0.05%, 500 is 5%, and an epoch is said as how often it comes round", () => {
  assert.equal(plainPct(5), "0.05%");
  assert.equal(plainPct(-5), "0.05%");
  assert.equal(plainPct(500), "5%");
  assert.equal(plainPct(20), "0.20%", "a fraction always has two decimals, so the sentence and the big number agree");
  assert.equal(plainPct(200), "2%");
  assert.equal(plainSigned(5), "+0.05%");
  assert.equal(plainSigned(-5), "−0.05%");
  assert.equal(plainSigned(0), "0%");
  assert.equal(askedRate(500), "5% a day", "a printing rate asked for is per day");
  assert.equal(askedRate(-9999), "−99.99%", "a burning rate is a share of a transfer");
  assert.equal(everyEpoch(90_000), "every 90 seconds");
  assert.equal(everyEpoch(60_000), "every minute");
  assert.equal(everyEpoch(3_600_000), "every hour");
  assert.equal(everyEpoch(86_400_000), "every day");
  assert.equal(everyEpoch(172_800_000), "every 2 days");
});

test("plainDecision is built from the numbers alone and never uses the jargon", () => {
  assert.equal(plainDecision(5, 5, "a day"), "Kept the rate at +0.05%. That prints 0.05% more coins a day for holders who staked.");
  assert.equal(plainDecision(10, 5, "a day"), "Raised the rate from +0.05% to +0.10%. That prints 0.10% more coins a day for holders who staked.");
  assert.match(plainDecision(-5, 0, "a day"), /^Lowered the rate from 0% to −0.05%\. That burns 0.05% of every transfer\.$/);
  assert.match(plainDecision(0, 5), /That prints and burns nothing\.$/);
  assert.match(plainDecision(5, 0), /more coins each round/, "an unknown unit is not invented");
  assert.match(plainDecision(5, 0, printUnit(oldParams)), /more coins every 90 seconds for/, "a token without meetings_per_day is per meeting");
  assert.equal(printUnit({ meetingsPerDay: 960, epochMs: 90_000 }), "a day");
  assert.equal(printUnit({ meetingsPerDay: null, epochMs: null }), "each round");
  for (const [a, b] of [[5, 5], [10, 5], [-5, 0], [0, 5]]) assert.doesNotMatch(plainDecision(a, b, "a day"), JARGON);
});

test("the sentence at the top of the page says what the AI is doing right now, in all three cases, with the contract's limit", () => {
  const draw = (rateBps, p = params) => {
    const doc = fakeDoc();
    const el = host(doc);
    renderPlain(doc, el, { policy: { rateBps }, params: p });
    return text(el);
  };
  assert.equal(draw(35), "Right now the AI is printing 0.35% more coins a day and giving them to holders who staked. The rate can never go above 2% a day. Holders who staked can vote it out.");
  assert.equal(draw(5, oldParams), "Right now the AI is printing 0.05% more coins every 90 seconds and giving them to holders who staked. The rate can never go above 2% every 90 seconds. Holders who staked can vote it out.", "a token without meetings_per_day is per meeting, and the page says so");
  assert.match(draw(0), /The rate can never go above 2% a day\./);
  assert.doesNotMatch(draw(5), /each time|every 90 seconds/);
  assert.match(draw(-5), /^Right now the AI is burning 0\.05% of every transfer\. The most the contract lets it burn is 2% of every transfer\. Holders who staked can vote it out\.$/);
  assert.match(draw(0), /^Right now the AI is holding the supply still: nothing is being printed or burned\./);
  for (const r of [5, -5, 0]) assert.doesNotMatch(draw(r), JARGON);
  const doc = fakeDoc();
  const el = host(doc);
  renderPlain(doc, el, { policy: { rateBps: 5 }, params });
  renderPlain(doc, el, { policy: { rateBps: 5 }, params });
  assert.equal(find(el, (n) => n.tag === "p").length, 1, "re-rendering replaces, never stacks");
});

const sha = (c) => c.repeat(64);
const dec = (over = {}) => ({ chair: "chair.test.near", epoch: 5, rateBps: 10, previousRateBps: 0, hash: sha("a"), chainText: null, tx: "7".repeat(44), tsMs: 1_700_000_000_000, height: 1, ...over });
const ctx = { texts: new Map(), resolved: new Map(), explorer: "https://example.invalid", repoBase: "https://example.invalid/repo/blob/main", unit: "a day" };
const policy = { epoch: 9, rateBps: 10, lastSetEpoch: 5, streak: 1, epochEndsMs: 1, chair: "chair.test.near" };

test("the hero and every minute lead with a plain translation, and the Chair's own words are labelled as such underneath", () => {
  const doc = fakeDoc();
  const hero = host(doc);
  const list = host(doc);
  const ds = [dec({ epoch: 9, tx: "8".repeat(44) }), dec({ epoch: 8, rateBps: 5, previousRateBps: 10, tx: "9".repeat(44) })];
  renderHero(doc, hero, { decisions: ds, policy, status: "complete" }, ctx);
  renderMinutes(doc, list, { decisions: ds, policy, status: "complete" }, ctx);
  const lines = (n) => find(n, (x) => x.attrs?.class === "plain-line ai-line").map(text);
  assert.deepEqual(lines(hero), ["Raised the rate from 0% to +0.10%. That prints 0.10% more coins a day for holders who staked."]);
  assert.deepEqual(lines(list), ["Lowered the rate from +0.10% to +0.05%. That prints 0.05% more coins a day for holders who staked."]);
  assert.equal(find(hero, (x) => x.attrs?.class === "m-absent").length, 1, "with no text to read, the card says so under the page's line");
  assert.ok(lines(hero).every((l) => !JARGON.test(l)));
});

test("the hall of refusals shows three, folds the rest behind a button that says how many, and the visitor label stays on a hidden row", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ tx: String(i + 1).repeat(44), signer: "chair.test.near", rateBps: 500, reason: "rate_bps out of bounds: must be within -200..=200", tsMs: 1_700_000_000_000, byVisitor: i === 4 }));
  const doc = fakeDoc();
  const el = host(doc);
  renderRefusals(doc, el, { status: "complete", refusals: rows }, { explorer: "https://example.invalid" });
  const trs = find(el, (n) => n.tag === "tr" && n.attrs.class === "refusal");
  assert.deepEqual(trs.map((t) => t.hidden), [false, false, false, true, true]);
  assert.match(text(trs[4]), /Forced by a visitor through the press desk/, "the label is in the row even while it is folded");
  const more = find(el, (n) => n.tag === "button" && /^Show all 5 refusals$/.test(text(n)))[0];
  assert.ok(more);
  for (const fn of more.listeners.click) fn();
  assert.equal(trs.every((t) => t.hidden === false), true);
  assert.equal(more.hidden, true);
  const few = host(doc);
  renderRefusals(doc, few, { status: "complete", refusals: rows.slice(0, 3) }, { explorer: "https://example.invalid" });
  assert.equal(find(few, (n) => n.tag === "button").length, 0, "no button when nothing is folded");
});

test("each guarantee says it plainly first with its Spec link visible, and keeps the exact wording and its tests in a closed fold", () => {
  const doc = fakeDoc();
  const ol = renderGuarantees(doc, { repoUrl: "https://example.invalid/repo", repoRef: "main" });
  const items = find(ol, (n) => n.tag === "li");
  assert.equal(items.length, GUARANTEES.length);
  for (const [i, li] of items.entries()) {
    assert.equal(find(li, (n) => n.attrs?.class === "claim").map(text)[0], GUARANTEES[i].plain);
    assert.ok(GUARANTEES[i].plain.length < GUARANTEES[i].text.length, "the plain claim is the shorter one");
    const fold = find(li, (n) => n.tag === "details")[0];
    assert.equal(fold.attrs.open, undefined, "closed by default");
    assert.ok(text(fold).includes(GUARANTEES[i].text), "the exact wording is kept whole");
    assert.ok(find(fold, (n) => n.tag === "a").length >= 1, "its tests are linked");
    const outside = find(li, (n) => n.attrs?.class === "proof").filter((p) => !find(fold, (x) => x === p).length);
    assert.match(text(outside[0]), /^Spec: /);
  }
});

test("the last guarantee card is the way to check the no-admin one yourself: the command, whole, and a Copy button; no other card has them", () => {
  const ol = renderGuarantees(fakeDoc(), { repoUrl: "https://example.invalid/repo", repoRef: "main" });
  const items = find(ol, (n) => n.tag === "li");
  const last = items.at(-1);
  assert.equal(VERIFY_COMMAND, "make -C deploy verify");
  assert.equal(text(find(last, (n) => n.attrs?.id === "verify-cmd")[0]), VERIFY_COMMAND);
  const copy = find(last, (n) => n.attrs?.id === "copy");
  assert.equal(copy.length, 1);
  assert.equal(copy[0].tag, "button");
  for (const li of items.slice(0, -1)) assert.equal(find(li, (n) => n.attrs?.id === "verify-cmd" || n.attrs?.id === "copy").length, 0);
});

const el = (top) => { const e = { cls: new Set(), getBoundingClientRect: () => ({ top }) }; e.classList = { add: (c) => e.cls.add(c), contains: (c) => e.cls.has(c) }; return e; };
const page = () => { const r = { cls: new Set() }; r.classList = { add: (c) => r.cls.add(c), contains: (c) => r.cls.has(c) }; return r; };
class FakeObserver {
  static last;
  constructor(cb) { this.cb = cb; this.watched = new Set(); FakeObserver.last = this; }
  observe(e) { this.watched.add(e); }
  unobserve(e) { this.watched.delete(e); }
}

test("reveal: with no observer, or reduced motion asked for, nothing is ever hidden (the page is just there)", () => {
  for (const opts of [{ observer: undefined, reduced: false }, { observer: FakeObserver, reduced: true }]) {
    const r = page();
    assert.equal(setupReveal([el(5000)], r, { ...opts, viewHeight: 800 }), false);
    assert.equal(r.classList.contains("reveal-on"), false);
  }
});

test("reveal: what is on screen shows at once, the rest waits for the observer, shows once, and is then let go", () => {
  const near = el(100);
  const far = el(3000);
  const r = page();
  assert.equal(setupReveal([near, far], r, { observer: FakeObserver, reduced: false, viewHeight: 800 }), true);
  assert.equal(r.classList.contains("reveal-on"), true);
  assert.equal(near.classList.contains("in"), true);
  assert.equal(far.classList.contains("in"), false);
  const io = FakeObserver.last;
  assert.deepEqual([...io.watched], [far]);
  io.cb([{ isIntersecting: false, target: far }]);
  assert.equal(far.classList.contains("in"), false);
  io.cb([{ isIntersecting: true, target: far }]);
  assert.equal(far.classList.contains("in"), true);
  assert.equal(io.watched.size, 0, "unobserved after it showed");
});

test("a link into a folded section opens every closed fold around the target, and does nothing to an open page", () => {
  const outer = { tagName: "DETAILS", open: false, parentElement: null };
  const mid = { tagName: "DIV", parentElement: outer };
  let scrolled = 0;
  const target = { tagName: "TABLE", parentElement: mid, scrollIntoView: () => scrolled++ };
  assert.equal(openFoldsAround(target), true);
  assert.equal(outer.open, true);
  assert.equal(scrolled, 1);
  assert.equal(openFoldsAround(target), false, "already open: no scroll");
  assert.equal(scrolled, 1);
});

test("page markup: ledger, simulation detail, limits and sources start closed, sections reveal, and every honesty fold is present", () => {
  const opens = [...html.matchAll(/<details\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(opens.length >= 6);
  const phone = opens.filter((d) => /\bphone-fold\b/.test(d));
  assert.equal(phone.length, 5, "the five deep sections fold on a phone");
  assert.ok(phone.every((d) => /\bopen\b/.test(d)), "a phone fold is open in the file: nothing is hidden without script (js/phonefold.js shuts it on a phone)");
  assert.equal(opens.filter((d) => !/\bphone-fold\b/.test(d)).some((d) => /\bopen\b/.test(d)), false, "no other fold starts open");
  for (const id of ["ledger-fold", "sim-more"]) assert.match(html, new RegExp(`<details[^>]*id="${id}"`));
  assert.ok((html.match(/class="[^"]*\breveal\b/g) ?? []).length >= 5);
  assert.doesNotMatch(html, /reveal-on/, "the hidden state is only ever set by script");
  assert.match(html, /id="now-plain"/);
});

const resolvedWith = (tx, t) => new Map([[tx, { text: t, verdict: "verified", chair: null, kind: null, source: null, onChain: true }]]);
const PLAIN_TEXT = "The Chair keeps printing 0.20% more coins every 90 seconds for holders who staked, as it has for the last 3 meetings. 45.71% of all coins are staked.";

test("hero: with no line of the AI's own the page's plain line leads, labelled as a summary of the numbers, and the Chair's words stay whole in a fold", () => {
  const d = dec({ epoch: 582, rateBps: 20, previousRateBps: 15, tx: "8".repeat(44) });
  const draw = (t) => {
    const doc = fakeDoc();
    const el = host(doc);
    renderHero(doc, el, { decisions: [d], policy, status: "complete" }, { ...ctx, resolved: resolvedWith(d.tx, t) });
    return el;
  };
  const plain = draw(PLAIN_TEXT);
  assert.equal(find(plain, (n) => n.attrs?.class === "plain-line ai-line").length, 1);
  assert.deepEqual(find(plain, (n) => n.attrs?.class === "said-k").map(text), ["A plain summary of this meeting's numbers"]);
  const fold = find(plain, (n) => n.tag === "details" && /\bm-full\b/.test(n.attrs?.class ?? ""));
  assert.equal(fold.length, 1, "the whole text has one fold");
  assert.ok(text(fold[0]).includes(PLAIN_TEXT), "the Chair's own words are kept whole, word for word");
  assert.match(text(plain), /Meeting 582/);
  assert.doesNotMatch(text(plain), /Epoch 582/);
  assert.equal(find(plain, (n) => n.attrs?.class === "paper-epoch")[0].attrs.title, undefined, "one word, meeting, everywhere visible");
  assert.match(find(plain, (n) => n.attrs?.class === "said-why").map(text).join(""), /filter.*fixed line.*this summary leads/, "a line says when and why the card switches");
  assert.match(text(plain), /\+0\.20%/);
  assert.match(text(plain), /Before: \+0\.15%\./);
  assert.doesNotMatch(text(plain), /Previous rate/);
  for (const old of ["The rate is 20 bps, up 5 bps this epoch.", "The staked share is 46.17 percent, 4617 basis points.", "Same rate as the last epoch."]) {
    const hero = draw(old);
    assert.equal(find(hero, (n) => n.attrs?.class === "plain-line ai-line").length, 1, old);
    assert.equal(find(hero, (n) => n.attrs?.class === "said-k").length, 1, old);
  }
  const none = host(fakeDoc());
  renderHero(fakeDoc(), none, { decisions: [d], policy, status: "complete" }, ctx);
  assert.equal(find(none, (n) => n.attrs?.class === "plain-line ai-line").length, 1, "no text at all: the page-written line stands in");
});

test("minute cards follow the same rule: the plain line leads and the text is in the fold", () => {
  const a = dec({ epoch: 8, tx: "8".repeat(44) });
  const b = dec({ epoch: 7, tx: "9".repeat(44) });
  const doc = fakeDoc();
  const list = host(doc);
  renderMinutes(doc, list, { decisions: [dec({ epoch: 9 }), a, b], policy, status: "complete" }, { ...ctx, resolved: new Map([...resolvedWith(a.tx, PLAIN_TEXT), ...resolvedWith(b.tx, "Rate is 10 bps.")]) });
  const cards = find(list, (n) => n.attrs?.class?.startsWith("minute card"));
  for (const c of cards) assert.equal(find(c, (n) => n.attrs?.class === "plain-line ai-line").length, 1);
  assert.ok(text(find(cards[0], (n) => n.tag === "details")[0]).includes(PLAIN_TEXT), "the whole text is behind the card's fold");
});

test("first paint: one announcement of the wait, grey bars that hold the size of what is coming, and no empty hole in the hero", () => {
  assert.equal(html.split("Reading the chain").length - 1, 1, "the wait is announced once, to screen readers, not shown as text twice");
  const slot = (id) => html.match(new RegExp(`<div id="${id}"[^>]*>[\\s\\S]*?</div>`))[0];
  assert.match(slot("now-plain"), /class="skel"/);
  assert.match(html, /<div id="hero-minutes" class="slot hero-slot"><div class="minutes-paper skeleton" aria-hidden="true">/);
  assert.match(html, /<div id="holders-body"[^>]*><div class="hold-grid skeleton" aria-hidden="true">/);
});

test("the Chair's own words sit right under the hero: closing sentences the AI wrote, none of them a line of the reviewed book, each with its transaction", async () => {
  const book = await readFile(join(root, "..", "chair-agent", "src", "press-book.ts"), "utf8");
  const fig = html.match(/<figure id="pull" class="pull" data-tx="([^"]+)" data-epoch="(\d+)">\s*<blockquote lang="en">([^<]+)<\/blockquote>\s*<figcaption>([^<]+)<\/figcaption>/);
  assert.ok(fig, "the pull quote is in the page");
  assert.ok(!book.includes(fig[3]), "the pull quote is the model's sentence, not a line the model only picks from the book");
  assert.match(fig[1], /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const quips = [...html.matchAll(/<li data-tx="([^"]+)" data-epoch="(\d+)"><blockquote lang="en">([^<]+)<\/blockquote><\/li>/g)];
  assert.equal(quips.length, 3, "three more lines sit under it");
  for (const q of quips) assert.ok(!book.includes(q[3].replaceAll("&#39;", "'")) && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(q[1]), "each is the model's own sentence with its transaction");
  assert.ok(![fig[3], ...quips.map((q) => q[3])].some((t, i, all) => all.indexOf(t) !== i), "no line is shown twice in the band");
  assert.equal(fig[4], `Closing sentence of the minutes of meeting ${fig[2]}, written by the AI.`, "the caption says which meeting it closed");
  const at = (n) => html.indexOf(n);
  assert.ok(at('id="pull"') > at('id="hero-minutes"') && at('id="pull"') < at('id="overreach"'));
});

test("'What holders control' follows the toys and comes before the technical sections, with the plain sentence in the page itself", () => {
  const at = (n) => html.indexOf(n);
  assert.ok(at('id="holders"') > at('id="best-of"') && at('id="holders"') < at('id="minutes"'));
  assert.ok(html.includes("<strong>Holders who stake get every new coin. Holders who stake can also fire the Chair.</strong>"));
  assert.ok(at('id="bound-body"') > at('id="sim-h"') && at('id="bound-body"') < at('id="sim-legend"'), "the worst case comes before the simulation");
});

test("the page speaks as one person and keeps its typography plain", async () => {
  const files = ["index.html", ...(await readdir(join(root, "site", "js"))).map((f) => `js/${f}`)];
  for (const f of files) {
    const src = await readFile(join(root, "site", f), "utf8");
    const visible = f === "index.html" ? src.replace(/<script[\s\S]*?<\/script>|<svg[\s\S]*?<\/svg>/g, "") : src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
    assert.doesNotMatch(visible, /\bwe\b|\bour\b|\bours\b|submitter|this project/i, `${f}: the page says I, not we`);
    assert.doesNotMatch(src.split("\n").filter((l) => !l.includes(".replace(")).join("\n"), /\u2014|\u2013/, `${f}: no en or em dashes (the one input normaliser that accepts them is exempt)`);
  }
});

test("the hero stamp: the newest refusal with its rate, the contract's plain reason and a transaction link; drawn once per refusal; nothing when there is none", () => {
  const r = (n, over = {}) => ({ tx: String(n).repeat(44), signer: "chair.test.near", rateBps: 500, reason: "rate_bps out of bounds: must be within -200..=200", tsMs: 1_700_000_000_000, byVisitor: true, ...over });
  const doc = fakeDoc();
  const slot = host(doc);
  renderHeroStamp(doc, slot, { status: "complete", refusals: [] }, { explorer: "https://example.invalid" });
  assert.equal(slot.children.length, 0, "no refusal, no stamp");
  renderHeroStamp(doc, slot, { status: "incomplete", refusals: [r(1)] }, { explorer: "https://example.invalid" });
  assert.equal(slot.children.length, 0, "an unreadable index draws nothing");
  const d = { status: "complete", refusals: [r(2, { rateBps: null }), r(3), r(4, { rateBps: 800 })] };
  renderHeroStamp(doc, slot, d, { explorer: "https://example.invalid" });
  const stamp = find(slot, (n) => n.attrs?.class === "or-stamp")[0];
  assert.match(text(stamp), /^5% a day: Refused by the contract$/, "the newest refusal that says what it asked for");
  assert.match(text(slot), /can never go above 2% a day when printing/);
  assert.doesNotMatch(text(slot), /prints at most|\bbps\b|rate_bps|set_policy/);
  assert.equal(find(slot, (n) => n.tag === "a")[0].attrs.href, `https://example.invalid/txns/${"3".repeat(44)}`);
  assert.match(text(slot), /A visitor had the Chair's account ask for this/);
  const first = slot.children[0];
  renderHeroStamp(doc, slot, d, { explorer: "https://example.invalid" });
  assert.equal(slot.children[0], first, "the same refusal again does not draw it again");
  renderHeroStamp(doc, slot, { status: "complete", refusals: [r(5, { byVisitor: false }), ...d.refusals] }, { explorer: "https://example.invalid" });
  assert.notEqual(slot.children[0], first, "a newer refusal replaces it");
  assert.match(text(slot), /Signed by chair\.test\.near\./);
  assert.equal(find(slot, (n) => n.tag === "a").length, 1);
  assert.equal(find(host(doc), () => true).length, 1);
});

test("the pending hero says only what the chain's views say, or the saved copy of the same meeting with its neutral mark; never a card the index has not confirmed", () => {
  const doc = fakeDoc();
  const slot = host(doc);
  const pol = { epoch: 9, rateBps: 10, lastSetEpoch: 8, streak: 1, epochEndsMs: 1, chair: "chair.test.near" };
  renderHeroPending(doc, slot, { policy: pol, remembered: [] }, ctx);
  const paper = find(slot, (n) => /minutes-paper/.test(n.attrs?.class ?? ""))[0];
  assert.match(paper.attrs.class, /\bpending\b/);
  assert.equal(paper.attrs["aria-busy"], "true");
  assert.match(text(paper), /Meeting 8/);
  assert.match(text(paper), /The rate in force is \+0\.10% a day\./);
  assert.doesNotMatch(text(paper), /Verified/, "nothing is called verified before it is checked");
  const saved = dec({ epoch: 8, tx: "6".repeat(44) });
  renderHeroPending(doc, slot, { policy: pol, remembered: [saved] }, { ...ctx, resolved: resolvedWith(saved.tx, PLAIN_TEXT) });
  assert.match(text(slot), /Meeting 8/);
  assert.doesNotMatch(find(slot, (n) => /minutes-paper/.test(n.attrs?.class ?? ""))[0].attrs.class, /pending/);
  renderHeroPending(doc, slot, { policy: { ...pol, lastSetEpoch: 9 }, remembered: [saved] }, { ...ctx, resolved: resolvedWith(saved.tx, PLAIN_TEXT) });
  assert.match(find(slot, (n) => /minutes-paper/.test(n.attrs?.class ?? ""))[0].attrs.class, /pending/, "a saved copy of an older meeting is not shown as the latest");
});

test("the page head and top: share image and card, favicon, the GitHub link, the verified pill's home, and one Try-it panel with three tabs", () => {
  assert.match(html, /<meta property="og:title" content="[^"]+">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /<header class="top">[\s\S]*?href="https:\/\/github\.com\/WonkaRed\/chair"[\s\S]*?<\/header>/);
  assert.match(html, /<footer[\s\S]*?href="https:\/\/github\.com\/WonkaRed\/chair"/);
  assert.match(html, /id="hero-stamp"/);
  assert.match(html, /id="next-meeting"/);
  const at = (n) => html.indexOf(n);
  assert.ok(at('id="hero-stamp"') < at('id="best-of"'), "the stamp is in the first screen's markup");
  const tab = html.match(/<section id="try"[\s\S]*?<\/section>\s*(?=<section id="press")/);
  assert.ok(tab || html.includes('id="try"'), "one Try-it section");
  for (const id of ["overreach", "join", "mine"]) {
    assert.match(html, new RegExp(`role="tab"[^>]*id="tab-${id}"|id="tab-${id}"[^>]*role="tab"`), `tab for ${id}`);
    assert.match(html, new RegExp(`<section id="${id}"[^>]*class="[^"]*tabpanel`), `panel ${id} keeps its id`);
  }
  for (const id of ["limits-refusals", "limits"]) assert.ok(html.includes(`id="${id}"`), id);
  for (const line of ["my own scripted test accounts voting, not a crowd", "about 1% of the coins that exist", "deliberate test calls that I made"]) assert.ok(html.slice(html.indexOf('id="limits"')).includes(line), `"${line}" is under the honest limits`);
  const top = html.slice(0, html.indexOf('id="limits"'));
  assert.doesNotMatch(top.replace(/<details[\s\S]*?<\/details>/g, ""), /scripted test accounts voting|0\.9988%|deliberate test calls that I made/, "the self-undercutting lines are not above the limits");
});

const AI_OVERRIDE = "$CHAIR decision, epoch 669, chair local:qwen3.8-27b.\nRate in effect 30 bps; decision 25 bps.\nThe formula suggested printing 0.20% a day. The Chair chose printing 0.25% a day: the Chair prefers to move the rate by less than the formula does.\nThe Committee of One has met. The Chair moves the rate from printing 0.30% a day to printing 0.25% a day. The Chair regrets its own lowering and has reprimanded itself in writing.";
const AI_AGREED = "$CHAIR decision, epoch 665, chair local:qwen3.8-27b.\nRate in effect 25 bps; decision 25 bps.\nThe formula suggested printing 0.25% a day. The Chair agreed: fewer than half of all coins are staked.\nThe Committee of One has met. The Chair holds the rate. The Chair thanks itself for its service.";
const resolvedAll = (pairs) => new Map(pairs.map(([tx, text]) => [tx, { text, verdict: "verified", chair: null, kind: null, source: null, onChain: true }]));

test("the standing stat counts the AI's own choices from verified minutes only: overrides over decisions read, newest override linked, a visitor's press and a bad hash left out", () => {
  const a = dec({ epoch: 669, rateBps: 25, tx: "A".repeat(44) });
  const b = dec({ epoch: 665, rateBps: 25, tx: "B".repeat(44) });
  const visitor = dec({ epoch: 668, rateBps: 25, tx: "C".repeat(44), byVisitor: true });
  const unread = dec({ epoch: 667, rateBps: 25, tx: "D".repeat(44) });
  const resolved = resolvedAll([[a.tx, AI_OVERRIDE], [b.tx, AI_AGREED], [visitor.tx, AI_OVERRIDE]]);
  resolved.set(unread.tx, { text: AI_OVERRIDE, verdict: "mismatch" });
  const stat = overrideStat([a, visitor, unread, b], resolved);
  assert.deepEqual({ overrides: stat.overrides, total: stat.total, latest: stat.latest.epoch }, { overrides: 1, total: 2, latest: 669 });
  assert.equal(overrideStat([unread], resolved), null, "nothing readable: no figure, never a guess");
  assert.equal(overrideStat([], new Map()), null);
  const hero = host(fakeDoc());
  renderHero(fakeDoc(), hero, { decisions: [a, visitor, unread, b], policy, status: "complete" }, { ...ctx, resolved });
  const [line] = find(hero, (n) => n.attrs?.class === "m-stat");
  assert.equal(text(line), "The AI overrode the formula in 1 of its last 2 decisions. Latest: meeting 669, on chain");
  assert.equal(find(line, (n) => n.tag === "a")[0].attrs.href, `https://example.invalid/txns/${"A".repeat(44)}`);
  const partial = host(fakeDoc());
  renderHero(fakeDoc(), partial, { decisions: [a, b], policy, status: "partial" }, { ...ctx, resolved });
  assert.equal(find(partial, (n) => n.attrs?.class === "m-stat").length, 0, "a log still being read gives no standing figure");
});

test("ownLines: the newest closing sentences the AI wrote, from verified minutes only, none from a visitor's press", () => {
  const own = (tx) => `${AI_AGREED.split("\n").slice(0, 3).join("\n")}\nThe Committee of One has met. The Chair holds the rate. The Chair thanks itself for its service ${tx}.`;
  const ds = ["E", "F", "G"].map((c, i) => dec({ epoch: 20 - i, tx: c.repeat(44), byVisitor: i === 1 }));
  const resolved = resolvedAll(ds.map((d) => [d.tx, own(d.epoch)]));
  const lines = ownLines(ds, resolved, 5);
  assert.deepEqual(lines.map((l) => l.epoch), [20, 18]);
  assert.equal(ownLines(ds, resolved, 1).length, 1);
  assert.deepEqual(ownLines(ds, new Map(), 5), []);
});
