// "Join the Committee": the sentence about what a press did to the Chair's rate says a cause only when the data supports one, the desk's replies are
// checked before they are shown, every desk string stays inert, a blocked or closed desk never leaves a dead end, and the page section is there in plain words.
// The desk is the fetch boundary (`request`), which the page does not own; timers and the clock are driven by the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { createJoin, explainJoin, findMinutes, minutesShare, parseLimits, parseRecord, STORE_KEY, STATE_POLL_MS, WATCH_TRIES, DOWN } = await import(join(root, "site", "js", "join.js"));

const EXPLORER = "https://example.invalid";
const TX = "5".repeat(44);
const DTX = "7".repeat(44);
const POOL = "visitors.chair-coin-3.testnet";
const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007 <script>alert(1)</script>";
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const FORBIDDEN = new Set(["script", "img", "iframe", "style", "object", "embed", "link"]);

const wire = (over = {}) => ({ direction: "join", tx_hash: TX, share_before_bps: 1000, share_after_bps: 1100, epoch: 12, meeting_epoch: 13, meeting_at_ms: 1_060_000, at_ms: 1_000_000, ...over });
const record = (over = {}) => parseRecord(wire(over));
const minutesOf = (share, chair = "rule-v1") => `$CHAIR decision, epoch 13, chair ${chair}.\nRate in effect 110 bps; decision 97 bps.\nThe Committee of One has met. The Chair moves the rate. ${share}% of all coins are staked, and the Chair would like 50.00%. The more holders stake, the less the Chair prints.`;
const decision = (was, now, over = {}) => ({ epoch: 13, tx: DTX, rateBps: now, previousRateBps: was, hash: "a".repeat(64), tsMs: 1_070_000, byVisitor: false, ...over });
const explain = (was, now, { share = "11.00", before = 1000, after = 1100, chair = "rule-v1", text = minutesOf(share, chair) } = {}) => explainJoin({ record: record({ share_before_bps: before, share_after_bps: after }), decision: decision(was, now), minutes: text });

const text = (n) => [...walk(n)].map((x) => x.data ?? "").join("");
const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));
const assertInert = (el) => {
  for (const n of walk(el)) {
    if (n.data !== undefined) assert.equal(HIDDEN.test(n.data), false, JSON.stringify(n.data.slice(0, 50)));
    else {
      assert.equal(FORBIDDEN.has(n.tag), false, n.tag);
      for (const [k, v] of Object.entries(n.attrs)) {
        assert.equal(/^on/i.test(k), false, k);
        if (k === "href") assert.match(v, /^https:\/\/example\.invalid\/(txns\/[1-9A-HJ-NP-Za-km-z]{32,44}|address\/[a-z0-9._-]+)$/);
      }
    }
  }
};

test("the staked share is read from the minutes, with where it sits", () => {
  const at = minutesShare("The Chair holds. 11.25% of all coins are staked, and more.");
  assert.deepEqual(at, { bps: 1125, from: 17, to: 47 });
  assert.equal(minutesShare("Nothing about shares here."), null);
  assert.equal(minutesShare("250% of all coins are staked"), null, "more than all the coins is not a share");
});

test("a record is only taken in the documented shape", () => {
  assert.equal(parseRecord(wire()).shareAfter, 1100);
  for (const bad of [null, [], "x", wire({ direction: "sideways" }), wire({ tx_hash: "nope" }), wire({ share_after_bps: 10_001 }), wire({ share_before_bps: -1 }), wire({ share_before_bps: 1.5 }), wire({ epoch: "12" }), wire({ meeting_at_ms: "soon" }), wire({ at_ms: NaN })]) {
    assert.equal(parseRecord(bad), null, JSON.stringify(bad));
  }
});

test("the rate fell: more coins staked, so the Chair printed less, and the sentence says it was the press", () => {
  const e = explain(110, 97);
  assert.deepEqual(e, { sentence: "More coins are staked, so the Chair printed less: 1.10% a day before, 0.97% a day now.", cause: true });
});

test("the rate fell with the other direction of the press: fewer coins staked, so the Chair printed more", () => {
  const e = explain(90, 100, { share: "10.00", before: 1100, after: 1000 });
  assert.deepEqual(e, { sentence: "Fewer coins are staked, so the Chair printed more: 0.90% a day before, 1.00% a day now.", cause: true });
});

test("the rate is unchanged: inside the dead band, and where the rule already was, each said exactly", () => {
  const inside = explain(100, 100);
  assert.equal(inside.cause, false);
  assert.match(inside.sentence, /held the rate at 1\.00% a day: its rule wants 0\.97% a day at 11\.00% staked, which is within the 0\.05% a day it ignores as noise, so this press did not change what it did\./);
  const exact = explain(97, 97);
  assert.match(exact.sentence, /at 11\.00% staked its rule asks for the rate already in place/);
  assert.equal(exact.cause, false);
});

test("the rate rose: said as it is, with a cause only when the rule would have chosen otherwise", () => {
  const caused = explain(50, 97);
  assert.equal(caused.cause, true);
  assert.match(caused.sentence, /The rate went up anyway: 0\.50% a day before, 0\.97% a day now\. .*the press only lowered that target \(it would have chosen 1\.00% a day without it\)\./);
  const bound = explain(20, 70);
  assert.equal(bound.cause, false);
  assert.doesNotMatch(bound.sentence, /would have chosen/);
});

test("the step limit bound either way: the press is not credited", () => {
  const e = explain(200, 150);
  assert.equal(e.cause, false);
  assert.match(e.sentence, /printed less: 2\.00% a day before, 1\.50% a day now\. Its rule would have done the same without this press \(the contract limits a rate to a 0\.50% move a meeting\), so the press is not the cause\./);
});

test("other accounts moving the share are said exactly, whichever way", () => {
  const against = explain(110, 97, { share: "10.50" });
  assert.equal(against.cause, false);
  assert.match(against.sentence, /count 10\.50% staked, below the 11\.00% right after this press: other coins moved the other way/);
  const along = explain(110, 95, { share: "12.00" });
  assert.equal(along.cause, true);
  assert.match(along.sentence, /^More coins are staked, so the Chair printed less: 1\.10% a day before, 0\.95% a day now\. Other accounts moved the share the same way too\.$/);
});

test("a rate the rule does not give is not put down to the press", () => {
  const e = explain(110, 60);
  assert.equal(e.cause, false);
  assert.match(e.sentence, /is not what its rule gives for 11\.00% staked, so something else moved it too .* no cause is claimed/);
});

test("no cause is claimed from minutes that do not state the share, or from another chair", () => {
  for (const e of [explain(110, 97, { text: "The Chair has met and finds the rate fine." }), explainJoin({ record: record(), decision: decision(110, 97), minutes: null })]) {
    assert.equal(e.cause, false);
    assert.match(e.sentence, /does not tie that to this press|The minutes do not tie/);
  }
  assert.equal(explain(100, 100, { text: "no share" }).sentence, "The Chair left the rate at 1.00% a day. The minutes do not tie that to this press.");
  assert.equal(explain(110, 97, { before: 1100, after: 1100 }).cause, false, "a press that moved nothing moved nothing");
});

test("a Chair that is not the rule chair: the target before and after the press, what it set, and the word cause never", () => {
  const model = (was, now, over = {}) => explain(was, now, { chair: "local:qwen3.8-27b", before: 3820, after: 4020, share: "40.20", ...over });
  // The press moved the target from 0.29% to 0.24% a day and the Chair set it: said as that, with "up from" for the step the other way.
  assert.deepEqual(model(29, 24), { sentence: "This press moved the Chair's target from 0.29% to 0.24% a day. The Chair then set 0.24% a day, down from 0.29%.", cause: false });
  assert.equal(explainJoin({ record: record({ share_before_bps: 3820, share_after_bps: 4020 }), decision: decision(29, 24), minutes: minutesOf("40.20", "local:qwen3.8-27b"), yours: true }).sentence.slice(0, 10), "Your press");
  assert.match(model(24, 29, { before: 4020, after: 3820, share: "38.20" }).sentence, /^This press moved the Chair's target from 0\.24% to 0\.29% a day\. The Chair then set 0\.29% a day, up from 0\.24%\.$/);
  // Within a basis point of the target counts as landing on it, and a different rate is stated as it is.
  assert.match(model(29, 25).sentence, /target from 0\.29% to 0\.24% a day\. The Chair then set 0\.25% a day, down from 0\.29%\.$/);
  assert.match(model(29, 27).sentence, /The Chair then set 0\.27% a day, down from 0\.29%\.$/);
  // Kept: said as kept. No apology sentence.
  assert.match(model(29, 29).sentence, /target from 0\.29% to 0\.24% a day\. The Chair kept its rate at 0\.29% a day\.$/);
  // The step limit, only when it is the true reason: the target is further than a meeting's step and the rate moved exactly that far.
  const bound = model(100, 50, { before: 1100, after: 1200, share: "12.00" });
  assert.match(bound.sentence, /target from 0\.97% to 0\.95% a day\./, "mandate(12%) is 95, without the press 97");
  const limited = explainJoin({ record: record({ share_before_bps: 3600, share_after_bps: 3800 }), decision: decision(100, 50), minutes: minutesOf("38.00", "local:qwen3.8-27b"), maxRateBps: 200, maxStepBps: 50 });
  assert.match(limited.sentence, /The Chair then set 0\.50% a day, down from 1\.00%\. The contract lets the Chair move its rate 0\.50% a meeting at most\.$/);
  assert.doesNotMatch(model(29, 25).sentence, /meeting at most/);
  // One step too small to move the target.
  const small = model(100, 100, { share: "11.01", before: 1100, after: 1101 });
  assert.match(small.sentence, /it would have asked for the same without this press: one step is too small to move it\. The Chair kept its rate at 1\.00% a day\./);
  assert.match(model(29, 24, { share: "41.00" }).sentence, /Other accounts moved the share the same way too\.$/);
  assert.match(model(29, 27, { share: "39.00" }).sentence, /other coins moved the other way/);
  for (const e of [model(29, 24), model(29, 29), limited, small, bound]) assert.doesNotMatch(e.sentence, /cause|because of you|judgment|not claimed/i);
});

test("the desk's step and cap are taken only as two whole numbers whose pool stays under the whole supply", () => {
  assert.deepEqual(parseLimits({ step_bps: 200, cap_steps: 2 }), { stepBps: 200, capSteps: 2 });
  for (const bad of [{}, { step_bps: 200 }, { cap_steps: 2 }, { step_bps: 0, cap_steps: 2 }, { step_bps: 200, cap_steps: 0 }, { step_bps: 1.5, cap_steps: 2 }, { step_bps: "200", cap_steps: 2 }, { step_bps: 5000, cap_steps: 2 }, { step_bps: -1, cap_steps: 2 }]) {
    assert.equal(parseLimits(bad), null, JSON.stringify(bad));
  }
});

test("the how-it-works text states the step and cap the desk reports, and says nothing numeric when it reports none", async () => {
  const p = await panel(() => assert.fail("nothing is sent"), { state: { next: "join", last: null, pool: POOL, step_bps: 200, cap_steps: 2 } });
  const t = text(p.el);
  assert.match(t, /stake one step \(2\.00% of all coins\) while the pool holds less than 4\.00%/);
  assert.match(t, /a stake of at most 4\.00% cannot impeach the Chair/);
  assert.match(t, /one step shifts the Chair's target by about 0\.05% a day, the Chair ignores a difference of under 0\.05% a day/);
  const silent = await panel(() => assert.fail("nothing is sent"));
  const u = text(silent.el);
  assert.match(u, /stake one step \(a small share of all coins\) while the pool holds less than its limit/);
  assert.match(u, /a stake of under 5% cannot impeach the Chair/);
  assert.match(u, /one step shifts the Chair's target only slightly/);
  assert.doesNotMatch(u + t, /\b1%|0\.025|—|–|NaN|undefined/);
});

test("burns and nothing are named as what they are", () => {
  const e = explainJoin({ record: record({ share_before_bps: 5200, share_after_bps: 5300 }), decision: decision(-2, -7), minutes: minutesOf("53.00") });
  assert.match(e.sentence, /a burn of 0\.02% before, a burn of 0\.07% now/);
});

test("the minutes sought are the first decision at or after the meeting after the press, never a visitor's, never one far later", () => {
  const r = record();
  const data = { decisions: [decision(97, 90, { epoch: 15, tx: "8".repeat(44) }), decision(110, 97, { epoch: 14, tx: "6".repeat(44) }), decision(110, 97, { epoch: 13, byVisitor: true }), decision(1, 2, { epoch: 12 }), decision(1, 2, { epoch: 40, tx: "4".repeat(44) })] };
  assert.equal(findMinutes(r, data, new Map()).decision.epoch, 14);
  assert.equal(findMinutes(r, { decisions: [data.decisions[4]] }, new Map()), null, "a decision 27 meetings later is not the next one");
  assert.equal(findMinutes(r, null, null), null);
  const resolved = new Map([["6".repeat(44), { text: "x", verdict: "mismatch" }]]);
  const f = findMinutes(r, data, resolved);
  assert.deepEqual([f.text, f.unverified], [null, true]);
});

/** Timers driven by the test: the page's looks at the desk's state (STATE_POLL_MS) wait in `polls`, every other timer in `queue`, so a test of one does not trip over the other. */
const manual = () => {
  const queue = [];
  const polls = [];
  return {
    queue,
    polls,
    set: (f, ms) => { const t = { f, ms }; (ms === STATE_POLL_MS ? polls : queue).push(t); return t; },
    clear: (t) => { for (const l of [queue, polls]) if (l.includes(t)) l.splice(l.indexOf(t), 1); },
    tick: async () => { const t = queue.shift(); await t.f(); },
    poll: async () => { const t = polls.shift(); await t.f(); },
  };
};
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] ?? null }, json: async () => body });
const memory = (initial = null) => {
  const m = new Map(initial === null ? [] : [[STORE_KEY, JSON.stringify(initial)]]);
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), map: m };
};
const flush = () => new Promise((r) => setImmediate(r));

/** A panel whose desk answers `route(path, init)`; `health` is what /health says (a function throws it as down). */
async function panel(route, { health = { ok: true, overreach: false, join: true }, state = { next: "join", last: null, pool: POOL }, stored = null, data = null, pressed = false, hidden = false } = {}) {
  const sent = [];
  const timers = manual();
  const clock = { t: 1_000_000 };
  const chain = { data, resolved: new Map() };
  let reads = 0;
  const request = async (path, init) => {
    const i = init();
    sent.push({ path, init: i });
    if (path === "/health") return typeof health === "function" ? health() : res(200, health);
    if (path === "/join/state") return res(200, typeof state === "function" ? state() : state);
    return route(path, i);
  };
  const el = host();
  const section = { hidden: true };
  const store = memory(stored);
  if (pressed) store.map.set("chair-join-pressed", "1");
  const doc = fakeDoc();
  doc.hidden = hidden;
  const api = createJoin(doc, el, { section, request, explorer: EXPLORER, chain: () => chain, reload: async () => { reads++; }, store, timers, now: () => clock.t });
  await flush();
  return { el, api, doc, sent, timers, clock, chain, store, section, reads: () => reads };
}

const joined = (over = {}) => res(200, { status: "joined", ...wire(), pool: POOL, now_ms: 1_000_000, ...over });

test("the desk has no join: nothing to press, and with no press on record the section stays hidden", async () => {
  const p = await panel(() => assert.fail("nothing is sent"), { health: { ok: true, overreach: true, join: false } });
  assert.equal(p.section.hidden, true);
  assert.equal(find(p.el, (n) => n.tag === "button" && n.attrs.class?.includes("jn-btn")).every((b) => b.disabled !== false), true);
  assert.deepEqual(p.sent.map((s) => s.path), ["/health"]);
  const down = await panel(() => assert.fail("nothing is sent"), { health: () => Promise.reject(new Error("no press desk")) });
  assert.equal(down.section.hidden, true);
  assert.equal(down.api.state().mode, "off");
});

test("the desk is closed but a press was recorded: it is shown with its transaction and shares, and there is no button to press", async () => {
  const p = await panel(() => assert.fail("nothing is sent"), { health: { ok: true, join: false }, stored: wire() });
  assert.equal(p.section.hidden, false);
  const t = text(p.el);
  assert.match(t, /Nobody can join the Committee just now/);
  assert.match(t, /The latest press on record/);
  assert.match(t, /10\.00% before.*11\.00% after/);
  assert.ok(find(p.el, (n) => n.tag === "a" && n.attrs.href === `${EXPLORER}/txns/${TX}`).length === 1);
  assert.equal(find(p.el, (n) => n.tag === "div" && n.attrs.class === "jn-act")[0].hidden, true);
  assertInert(p.el);
});

test("a stored record that is not a record is ignored", async () => {
  const p = await panel(() => assert.fail("nothing is sent"), { health: { ok: true, join: false }, stored: wire({ tx_hash: EVIL }) });
  assert.equal(p.section.hidden, true);
  assert.equal(p.api.state().earlier, null);
});

test("a press: the request is the bare JSON the desk wants, and the reply is the real transaction, the shares and a countdown", async () => {
  const p = await panel(() => joined());
  assert.equal(p.section.hidden, false);
  assert.match(text(p.el), /Join the Committee/);
  await p.api.press();
  const post = p.sent.find((s) => s.path === "/join");
  assert.equal(post.init.method, "POST");
  assert.equal(post.init.body, "{}");
  assert.equal(post.init.headers["content-type"], "application/json");
  assert.equal(post.init.credentials, "omit");
  const t = text(p.el);
  assert.match(t, /Sent\. Here is the transaction/);
  assert.match(t, /10\.00%.* before.*11\.00%.* after/);
  assert.match(t, /next meeting opens in 60 s/);
  assert.equal(find(p.el, (n) => n.tag === "a" && n.attrs.href === `${EXPLORER}/txns/${TX}`).length, 1);
  assert.deepEqual(JSON.parse(p.store.map.get(STORE_KEY)), wire());
  assertInert(p.el);
});

test("a press that stepped the pool back out says so", async () => {
  const p = await panel(() => res(200, { status: "stepped_down", ...wire({ direction: "step_down", share_before_bps: 1100, share_after_bps: 1000 }), now_ms: 1_000_000 }), { state: { next: "step_down", last: null, pool: POOL } });
  assert.equal(p.api.button.textContent, "Step back out of the Committee");
  await p.api.press();
  assert.match(text(p.el), /took one step of the pool's coins back out/);
  assert.match(text(p.el), /11\.00%.* before.*10\.00%.* after/);
});

test("the countdown runs, then the page reads the chain until the Chair's minutes for the meeting are there, and quotes them with the share marked", async () => {
  const p = await panel(() => joined());
  await p.api.press();
  p.clock.t = 1_030_000;
  await p.timers.tick();
  assert.match(text(p.el), /opens in 30 s/);
  assert.equal(p.reads(), 0, "the chain is not read while the meeting is still ahead");
  p.clock.t = 1_070_000;
  await p.timers.tick();
  await flush();
  assert.equal(p.reads(), 1);
  assert.match(text(p.el), /The Chair is meeting now/);
  p.chain.data = { decisions: [decision(110, 97)], params: { maxRateBps: 200, maxStepBps: 50 } };
  p.chain.resolved.set(DTX, { text: minutesOf("11.00"), verdict: "verified", chair: null });
  p.api.refresh();
  const t = text(p.el);
  assert.match(t, /The Chair's minutes, meeting 13/);
  assert.match(t, /More coins are staked, so the Chair printed less: 1\.10% a day before, 0\.97% a day now\./);
  const marks = find(p.el, (n) => n.tag === "mark");
  assert.equal(marks.length, 1);
  assert.equal(text(marks[0]), "11.00% of all coins are staked");
  assert.equal(find(p.el, (n) => n.tag === "a" && n.attrs.href === `${EXPLORER}/txns/${DTX}`).length, 1);
  assert.doesNotMatch(t, /\$CHAIR decision, epoch/, "the boilerplate header lines are left out of the quote");
  assertInert(p.el);
});

test("minutes that do not match their fingerprint are not quoted and nothing is claimed from them", async () => {
  const p = await panel(() => joined(), { data: { decisions: [decision(110, 97)] } });
  p.chain.resolved.set(DTX, { text: EVIL, verdict: "mismatch", chair: null });
  await p.api.press();
  const t = text(p.el);
  assert.match(t, /does not match the fingerprint the chain holds/);
  assert.match(t, /The rate went from 1\.10% a day to 0\.97% a day\./);
  assert.equal(find(p.el, (n) => n.tag === "mark").length, 0);
  assert.doesNotMatch(t, /onerror/);
});

test("the page stops reading after a bounded number of tries and says where the minutes will be", async () => {
  const p = await panel(() => joined());
  await p.api.press();
  for (let i = 0; i < WATCH_TRIES; i++) {
    p.clock.t += 9_000 + (i === 0 ? 70_000 : 0);
    await p.timers.tick();
    await flush();
  }
  assert.equal(p.reads(), WATCH_TRIES);
  await p.timers.tick().catch(() => undefined);
  assert.match(text(p.el), /have not reached this page/);
  assert.equal(p.timers.queue.length, 0, "no timer is left running");
});

test("a visitor who is blocked is never left on an error: the latest real press is shown beside the reason", async () => {
  const last = wire({ tx_hash: "3".repeat(44) });
  const capped = await panel(() => res(429, { error: "x", code: "cap", retry_after_s: 600, last }, { "retry-after": "600" }));
  await capped.api.press();
  let t = text(capped.el);
  assert.match(t, /all the joiners it allows for the moment\. Try again in 10 minutes\./);
  assert.match(t, /Meanwhile, here is the latest press on record, not yours/);
  assert.ok(find(capped.el, (n) => n.tag === "a" && n.attrs.href === `${EXPLORER}/txns/${"3".repeat(44)}`).length === 1);
  assert.match(t, /10\.00%.* before.*11\.00%.* after/);
  const own = await panel(() => res(429, { error: "x", code: "per_address", retry_after_s: 30, last: null }), { stored: wire() });
  await own.api.press();
  t = text(own.el);
  assert.match(t, /This address has used its presses for the moment\. Try again in 30 s\./);
  assert.match(t, /latest press on record/, "what was seen on an earlier visit still stands in");
  const busy = await panel(() => res(429, { error: "x", code: "composing", retry_after_s: 10, last }));
  await busy.api.press();
  assert.match(text(busy.el), /Someone else is joining right now/);
  assert.equal(busy.api.button.disabled, false, "the button works again; the desk is the one that limits");
});

test("a pool that cannot step out yet, is empty, or was refused, says so in the page's words and shows the latest press", async () => {
  const last = wire({ tx_hash: "3".repeat(44) });
  const locked = await panel(() => res(200, { status: "locked", line: EVIL, retry_at_ms: 1_120_000, now_ms: 1_000_000, last }));
  await locked.api.press();
  let t = text(locked.el);
  assert.match(t, /keeps them in for two meetings, so the pool cannot step back out yet\. Try again in 2 minutes\./);
  assert.doesNotMatch(t, /onerror/, "the desk's own wording is not shown for a known status");
  assert.match(t, /latest press on record/);
  const dry = await panel(() => res(200, { status: "dry", line: "x", last: null }));
  await dry.api.press();
  assert.match(text(dry.el), /no coins left to put in, so nothing was sent/);
  const failed = await panel(() => res(200, { status: "failed", line: "x", failure: `Smart contract panicked: ${EVIL}`, tx_hash: TX, last }));
  await failed.api.press();
  assert.match(text(failed.el), /The contract refused the call, and nothing about the stake changed\. Its words: Smart contract panicked: /);
  assertInert(failed.el);
  const un = await panel(() => res(200, { status: "unconfirmed", line: "x", tx_hash: TX, last: null }));
  await un.api.press();
  assert.match(text(un.el), /could not confirm the new share\. The transaction may still show on chain\./);
});

test("a desk that goes away mid-press closes the panel, and a reply that is not a record is refused", async () => {
  const gone = await panel(() => res(503, { error: "x", code: "desk_closed" }));
  gone.sent.length = 0;
  await gone.api.press();
  await flush();
  assert.ok(gone.sent.slice(gone.sent.findIndex((s) => s.path === "/join")).some((s) => s.path === "/health"), "the desk is asked again after it said it was gone");
  const odd = await panel(() => joined({ tx_hash: EVIL }));
  await odd.api.press();
  assert.match(text(odd.el), /a reply this page cannot read/);
  assert.equal(odd.api.state().mine, null);
  const lies = await panel(() => joined({ status: "stepped_down" }));
  await lies.api.press();
  assert.equal(lies.api.state().mine, null, "a reply whose status and direction disagree is not shown");
  const thrown = await panel(() => Promise.reject(new Error("tunnel")));
  await thrown.api.press();
  await flush();
  assert.equal(thrown.api.state().busy, false);
});

test("one press at a time from the page", async () => {
  let n = 0;
  const p = await panel(async () => (n++, joined()));
  await Promise.all([p.api.press(), p.api.press()]);
  assert.equal(n, 1);
});

test("the page section is there, after the overreach toy, in plain words with no crypto word before the how-it-works fold", () => {
  const html = readFileSync(join(root, "site", "index.html"), "utf8");
  const at = (s) => html.indexOf(s);
  assert.ok(at('id="join"') > at('id="overreach"') && at('id="press"') > at('id="join"'), "right after the overreach toy");
  const section = /<section id="join"[^>]*>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(section, "the section exists");
  assert.match(html, /<section id="join"[^>]*\bhidden\b/, "hidden until the script has found the desk");
  const firstLines = section[1].replace(/<[^>]+>/g, " ");
  const copy = readFileSync(join(root, "site", "js", "join.js"), "utf8");
  const above = `${firstLines} ${/Join the Committee"\);\n  const who = h\(doc, "p", \{ class: "jn-who" \}, "([^"]+)"/.exec(copy)?.[1] ?? ""} ${/const FOOTER = "([^"]+)"/.exec(copy)?.[1] ?? ""}`;
  assert.match(above, /one button/i);
  assert.doesNotMatch(above, /\b(stake[sd]?|staking|testnet|transactions?|wallet|tokens?|blockchain|contract|gas|bps|hash|on-chain|NEAR)\b/i, "the first lines read without crypto words");
});

test("nothing the feature adds uses an em or en dash", () => {
  for (const f of ["js/join.js", "join.css", "index.html"]) assert.doesNotMatch(readFileSync(join(root, "site", f), "utf8"), /[–—]/, f);
});

test("the panel says in plain words why a press matters, glossing \"staked\" where it first appears, and names no crypto term", async () => {
  const p = await panel(() => assert.fail("nothing is sent"));
  const t = text(p.el);
  assert.match(t, /The Chair prints less new money the more coins are staked \(locked up to vote\), and more when fewer are\./);
  assert.doesNotMatch(t.split("How this works")[0], /bps|basis|mandate|contract|on-chain|NEAR/i, "above the fold: nothing a newcomer would have to look up");
  assert.ok(t.indexOf("locked up to vote") < t.indexOf("staked share") || !t.includes("staked share"), "the gloss comes before any later use");
});

test("a full pool greets a visitor who never pressed here with what is true: earlier presses filled the seats, a press takes one back out, and the minutes will react", async () => {
  const limits = { step_bps: 200, cap_steps: 2 };
  const p = await panel(() => assert.fail("nothing is sent"), { state: { next: "step_down", pool_steps: 2, pool_empty: false, last: null, pool: POOL, ...limits } });
  const t = text(p.el);
  assert.match(t, /Earlier presses have filled the Committee's seats, so a press now takes one seat back out, and the Chair's next minutes will react: the rate the Chair is aiming for moves up a little, because fewer coins staked \(locked up to vote\) means it prints more\./);
  assert.match(t, /Step back out of the Committee/);
  assert.doesNotMatch(t, /Nothing of yours is spent\.[^]*prints less new money the more/, "the join sentence is replaced, not stacked");
  const back = await panel(() => assert.fail("nothing is sent"), { pressed: true, state: { next: "step_down", pool_steps: 2, pool_empty: false, last: null, pool: POOL, ...limits } });
  assert.match(text(back.el), /^[^]*The Committee's seats are full\. A press now takes one seat back out, and the Chair's next minutes will react/);
  assert.doesNotMatch(text(back.el), /Earlier presses/, "someone who pressed before is not told that earlier presses did it");
});

test("a pool holding part of a step or of its cap shows Join, whatever pool_steps says: the page trusts the desk's `next`, not its own count of steps", async () => {
  const limits = { step_bps: 200, cap_steps: 2 };
  for (const pool_steps of [0, 1]) {
    const p = await panel(() => assert.fail("nothing is sent"), { state: { next: "join", pool_steps, last: null, pool: POOL, ...limits } });
    assert.equal(p.api.button.textContent, "Join the Committee", `${pool_steps}`);
    const t = text(p.el);
    assert.match(t, /The Chair prints less new money the more coins are staked/);
    assert.doesNotMatch(t, /seats are full|filled|back out/);
  }
});

test("the button is re-read from the desk every 10 s while it is up: a pool emptied by the idle reset or moved by another visitor changes the label, and a hidden tab or a press in flight does not look", async () => {
  let next = "step_down";
  const p = await panel(() => assert.fail("nothing is sent"), { state: () => ({ next, last: null, pool: POOL }) });
  assert.equal(p.api.button.textContent, "Step back out of the Committee");
  assert.equal(p.timers.polls.length, 1);
  assert.equal(p.timers.polls[0].ms, STATE_POLL_MS);
  next = "join"; // the idle reset emptied the pool
  await p.timers.poll();
  assert.equal(p.api.button.textContent, "Join the Committee", "the label follows the pool");
  assert.doesNotMatch(text(p.el), /seats are full/);
  assert.equal(p.timers.polls.length, 1, "and it looks again");
  const looks = () => p.sent.filter((s) => s.path === "/join/state").length;
  const before = looks();
  await p.timers.poll();
  assert.equal(looks(), before + 1);
  p.api.stop();
  assert.equal(p.timers.polls.length, 0, "stop ends the looking");
});

test("a press that does not go through (locked, dry, refused, 429, not accepted, unreadable) re-reads the desk's state, so the button is not left stale", async () => {
  const cases = [
    res(200, { status: "locked", retry_at_ms: 1_060_000, now_ms: 1_000_000 }),
    res(200, { status: "dry" }),
    res(200, { status: "failed", failure: "boom" }),
    res(200, { status: "unconfirmed" }),
    res(200, { status: "whatever" }),
    res(429, { error: "x", code: "cap", retry_after_s: 60, last: null }, { "retry-after": "60" }),
    res(400, { error: "no" }),
    res(200, { status: "joined" }),
  ];
  for (const reply of cases) {
    let next = "step_down";
    const p = await panel(() => reply, { state: () => ({ next, last: null, pool: POOL }) });
    next = "join"; // the pool moved under the page
    await p.api.press();
    await flush();
    assert.equal(p.sent.filter((s) => s.path === "/join/state").length, 2, `${reply.status} ${reply.json && "re-read"}`);
    assert.equal(p.api.button.textContent, "Join the Committee", "the label now says what a press does");
  }
});

test("a hidden tab does not look at the desk's state, and looks again when it is shown", async () => {
  const p = await panel(() => assert.fail("nothing is sent"), { hidden: true });
  const looks = () => p.sent.filter((s) => s.path === "/join/state").length;
  assert.equal(looks(), 1);
  await p.timers.poll();
  assert.equal(looks(), 1, "hidden: no look");
  assert.equal(p.timers.polls.length, 1, "but the clock keeps going");
  p.doc.hidden = false;
  await p.timers.poll();
  assert.equal(looks(), 2);
});

test("while the desk is out of reach the panel looks again every 20 s without changing the screen, and opens by itself when the desk is back", async () => {
  let up = false;
  const p = await panel(() => assert.fail("nothing is sent"), { health: () => (up ? res(200, { ok: true, join: true }) : Promise.reject(new Error("no press desk"))) });
  assert.equal(p.api.state().mode, "off");
  assert.equal(p.section.hidden, true);
  assert.equal(p.timers.queue.length, 1);
  assert.equal(p.timers.queue[0].ms, 20_000);
  await p.timers.tick();
  await flush();
  assert.equal(p.api.state().mode, "off", "still down: asks again");
  assert.equal(p.timers.queue.length, 1);
  assert.deepEqual(p.sent.map((s) => s.path), ["/health", "/health"]);
  up = true;
  await p.timers.tick();
  await flush();
  assert.equal(p.api.state().mode, "ready");
  assert.equal(p.section.hidden, false, "the panel appears without a reload");
  assert.equal(p.timers.queue.length, 0, "and the looking stops");
  assert.match(DOWN, /keeps checking by itself/);
});
