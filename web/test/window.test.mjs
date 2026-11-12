// The page reads the newest transactions only (js/loadlog.js), so every count and sentence built from them says what it covers. These tests pin
// each sentence and figure that changed when the log stopped being the whole history, and that the whole history still gets the whole-ledger words.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const js = (f) => import(join(root, "site", "js", f));
const { reconcileWindow } = await js("ledger.js");
const { renderReconcile, renderLog } = await js("views.js");
const { renderRefusals, PROJECT_TEST_CALLS } = await js("refusals.js");
const { renderEarlier, scopeLine } = await js("earlier.js");
const { renderHero, renderMinutes } = await js("minutes.js");

const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));
const entry = (kind, amount, i) => ({ kind, amount, epoch: i, hash: `H${i}`.padEnd(44, "A"), tsMs: 1_794_000_000_000 + i, reason: "test" });
const base = { partial: true, txCount: 200, sinceMs: Date.UTC(2026, 10, 11, 9, 30), decisions: [{ epoch: 710 }, { epoch: 640 }], pinnedFrom: 1000, pinnedHeight: 1900, pending: null, anomalies: [], retryable: false, reasons: [] };

test("a stretch is checked on minted and burned only, each as a difference of two readings, and one wrong sum fails it", () => {
  const entries = [entry("mint", 30n, 1), entry("mint", 12n, 2), entry("burn", 5n, 3)];
  const from = { minted: 100n, burned: 50n };
  const good = reconcileWindow(entries, from, { minted: 142n, burned: 55n });
  assert.deepEqual(good.lines.map((l) => [l.name, l.logged, l.chain, l.ok]), [["minted", 42n, 42n, true], ["burned", 5n, 5n, true]]);
  assert.equal(good.ok, true);
  const off = reconcileWindow(entries, from, { minted: 142n, burned: 56n });
  assert.equal(off.ok, false);
  assert.equal(off.lines[1].ok, false);
  assert.equal(reconcileWindow([], from, { minted: 100n, burned: 50n }).ok, true, "a quiet stretch is a sum of nothing");
});

test("the verdict over the newest transactions says which blocks it covers and never claims the whole ledger", () => {
  const out = host();
  const lines = reconcileWindow([entry("mint", 1n, 1)], { minted: 0n, burned: 0n }, { minted: 1n, burned: 0n });
  renderReconcile(fakeDoc(), out, { ...base, partial: true, status: "complete", reconcile: lines }, { onRetry: null });
  const t = out.textContent;
  assert.match(t, /Complete for the blocks the log covers\. Every mint and burn after block 1000, up to and including block 1900, is in the log below, and the sums are equal\. Older ones are read when you ask\./);
  assert.doesNotMatch(t, /Every mint and burn on the chain's ledger/);
  assert.match(t, /Event sums against the change in get_supply after block 1000, up to and including block 1900, the last block in which the contract logged an event/);
  assert.ok(find(out, (n) => n.attrs["data-label"] === "Chain change").length === 2, "the column is a change, not a total");
  assert.equal(find(out, (n) => n.attrs["data-label"] === "get_supply").length, 0);
});

test("a mismatch over the newest transactions says so for those blocks", () => {
  const out = host();
  const lines = reconcileWindow([], { minted: 0n, burned: 0n }, { minted: 9n, burned: 0n });
  renderReconcile(fakeDoc(), out, { ...base, partial: true, status: "mismatch", reconcile: lines }, { onRetry: null });
  assert.match(out.textContent, /Mismatch\. The events found do not add up to the change in the chain's ledger over the blocks the log covers; the log is not complete\./);
});

test("the whole history keeps the whole-ledger words", () => {
  const out = host();
  const supply = { launchSupply: 1n, minted: 1n, burned: 0n, totalSupply: 2n };
  renderReconcile(fakeDoc(), out, { ...base, partial: false, status: "complete", reconcile: { ok: true, lines: [{ name: "minted", logged: 1n, chain: supply.minted, ok: true }] }, supply }, { onRetry: null });
  assert.match(out.textContent, /Complete\. Every mint and burn on the chain's ledger is in the log below/);
  assert.match(out.textContent, /Event sums against get_supply at block 1900, the last block in which the contract logged an event/);
  assert.equal(find(out, (n) => n.attrs["data-label"] === "get_supply").length, 1);
});

test("the log's count names the transactions it was counted in, and the whole history names none", () => {
  const entries = [entry("mint", 5n, 1), entry("burn", 2n, 2), entry("mint", 4n, 3)];
  const caption = (partial) => {
    const out = host();
    renderLog(fakeDoc(), out, { ...base, partial, status: "complete", entries }, { filter: "all", newestFirst: true, shown: 10 }, { explorer: null, rerender() {} });
    return find(out, (n) => n.tag === "caption")[0].textContent;
  };
  assert.equal(caption(true), "Showing 3 of 3 supply changes in the latest 200 transactions");
  assert.equal(caption(false), "Showing 3 of 3 supply changes");
});

const refusal = (tx, signer = "w.testnet") => ({ tx, signer, epoch: 5, tsMs: 1_794_000_000_000, panic: "Smart contract panicked: rate is outside the band", rateBps: 400, byVisitor: false });

test("refusals over the newest transactions say what was read, and never that the contract refused nothing ever", () => {
  const known = [...PROJECT_TEST_CALLS][0];
  const withTests = host();
  renderRefusals(fakeDoc(), withTests, { ...base, partial: true, status: "complete", refusals: [refusal(known)] }, { explorer: null });
  assert.match(withTests.textContent, /In none of the refusals read here did the AI chair choose a rate the contract refused\./);
  assert.match(withTests.textContent, /1 refused set_policy call read \(the latest 200 transactions and the test calls made on purpose\)/);

  const none = host();
  renderRefusals(fakeDoc(), none, { ...base, partial: true, status: "complete", refusals: [] }, { explorer: null });
  assert.equal(none.textContent, "The contract has refused no set_policy call in the transactions read.");

  const whole = host();
  renderRefusals(fakeDoc(), whole, { ...base, partial: false, status: "complete", refusals: [] }, { explorer: null });
  assert.equal(whole.textContent, "The contract has refused no set_policy call yet.");
  const all = host();
  renderRefusals(fakeDoc(), all, { ...base, partial: false, status: "complete", refusals: [refusal(known)] }, { explorer: null });
  assert.match(all.textContent, /In none of them did the AI chair choose a rate the contract refused\./);
  assert.doesNotMatch(all.textContent, /latest 200 transactions/);
});

test("each list says what it covers: the transactions, the time they reach back to, the meetings, and what is always read", () => {
  assert.equal(scopeLine(base, "decisions"), "This shows the decisions in the latest 200 transactions, back to 2026-11-11 09:30 UTC (meetings 640 to 710). Earlier ones are on chain and are read when you ask.");
  assert.equal(scopeLine(base, "mints and burns"), "This shows the mints and burns in the latest 200 transactions, back to 2026-11-11 09:30 UTC. Earlier ones are on chain and are read when you ask.");
  assert.match(scopeLine(base, "refusals"), /^This shows the refusals in the latest 200 transactions, back to 2026-11-11 09:30 UTC and the test calls made on purpose, which are read by their hashes whatever the window\. Earlier/);
  assert.equal(scopeLine({ ...base, sinceMs: null, decisions: [] }, "decisions"), "This shows the decisions in the latest 200 transactions. Earlier ones are on chain and are read when you ask.");
});

test("the control draws only when there is something earlier, and reports a failed read instead of hiding it", async () => {
  const whole = host();
  renderEarlier(fakeDoc(), whole, { ...base, partial: false }, { what: "decisions", label: "Show earlier meetings", more: async () => {} });
  assert.equal(whole.children.length, 0, "the whole history: no control, no scope line");

  const out = host();
  let calls = 0;
  renderEarlier(fakeDoc(), out, { ...base, partial: true }, { what: "decisions", label: "Show earlier meetings", more: async () => { if (++calls === 1) throw new Error("index busy"); } });
  const [note, button, problem] = out.children;
  assert.match(note.textContent, /latest 200 transactions/);
  assert.equal(button.textContent, "Show earlier meetings");
  assert.equal(problem.getAttribute("hidden"), "", "no problem is shown before one happens");
  await button.listeners.click[0]();
  assert.equal(button.disabled, false, "a failed read can be asked again");
  assert.equal(button.textContent, "Show earlier meetings");
  assert.equal(problem.hidden, false);
  assert.match(problem.textContent, /could not be read just now \(index busy\)\. Press again to try again\./);
  await button.listeners.click[0]();
  assert.equal(problem.hidden, true);
  assert.equal(calls, 2);
});

test("when the known test refusals could not be read, no line says they were: each says how many were missing", () => {
  const missing = { ...base, unreadTestCalls: ["a", "b"] };
  const n = PROJECT_TEST_CALLS.size;
  const line = `and the test calls made on purpose that could be read (2 of ${n} could not be read just now)`;
  assert.ok(scopeLine(missing, "refusals").includes(`back to 2026-11-11 09:30 UTC ${line}. Earlier ones are on chain`), scopeLine(missing, "refusals"));
  assert.doesNotMatch(scopeLine(missing, "refusals"), /always|read by their hashes/);
  const out = host();
  renderRefusals(fakeDoc(), out, { ...missing, status: "complete", refusals: [refusal("T".repeat(43))] }, { explorer: null });
  assert.ok(out.textContent.includes(`1 refused set_policy call read (the latest 200 transactions ${line})`), out.textContent);
  const none = host();
  renderRefusals(fakeDoc(), none, { ...missing, status: "complete", refusals: [] }, { explorer: null });
  assert.equal(none.textContent, `The contract has refused no set_policy call in the transactions read (2 of the ${n} test calls made on purpose could not be read just now).`);
});

test("a window with no decision in it says so, in the hero and the list, and never that the index could not be read or that none was ever made", () => {
  const policy = { chair: "chair.test.near", rateBps: 23, epoch: 330, lastSetEpoch: 329 };
  const d = { ...base, policy, decisions: [], remembered: [], status: "complete", partial: true, outOfReach: true, refusals: [] };
  const ctx = { texts: null, resolved: new Map(), unit: "a day", explorer: null, indexerUrl: null };
  const hero = host();
  renderHero(fakeDoc(), hero, d, ctx);
  assert.match(hero.textContent, /^The Chair's latest decision is older than the transactions read here\. The chain itself says the rate in force is /);
  assert.match(hero.textContent, /"Show earlier meetings", under the minutes, reads further back\.$/);
  assert.doesNotMatch(hero.textContent, /could not be read|No decision has been recorded/);
  const list = host();
  renderMinutes(fakeDoc(), list, d, ctx);
  assert.match(list.textContent, /No decision is in the transactions read: the latest is older\. "Show earlier meetings", below, reads further back\./);
  assert.doesNotMatch(list.textContent, /could not be read|No decision has been recorded/);
  const whole = host();
  renderHero(fakeDoc(), whole, { ...d, partial: false, outOfReach: false }, ctx);
  assert.equal(whole.textContent, "No decision has been recorded on chain yet.");
});

test("the minutes count line says what it counted: the transactions read while older ones are unread, 'in all' only for the whole history", () => {
  const ctx = { texts: null, resolved: new Map(), unit: "a day", explorer: null, indexerUrl: null };
  const policy = { chair: "chair.test.near", rateBps: 23, epoch: 330, lastSetEpoch: 329 };
  const decision = (epoch) => ({ chair: "chair.test.near", epoch, rateBps: 23, previousRateBps: 23, hash: "h".repeat(64), chainText: null, byVisitor: false, tx: "T".repeat(43), tsMs: 1_794_000_000_000 + epoch, height: epoch });
  const decisions = Array.from({ length: 6 }, (_, i) => decision(329 - i));
  const count = (d) => {
    const out = host();
    renderMinutes(fakeDoc(), out, { ...base, policy, decisions, status: "complete", ...d }, ctx);
    return find(out, (n) => n.attrs.class === "note m-count")[0].textContent;
  };
  assert.equal(count({ partial: true }), "Showing the 3 newest of the 5 earlier decisions in the latest 200 transactions (the latest one is at the top of the page).");
  assert.equal(count({ partial: false }), "Showing the 3 newest of 5 earlier decisions (6 in all, counting the latest at the top of the page).");
});

test("a list drawn again opens as many cards as were open, and one more page when the visitor had reached the end", () => {
  const ctx = { texts: null, resolved: new Map(), unit: "a day", explorer: null, indexerUrl: null };
  const policy = { chair: "chair.test.near", rateBps: 23, epoch: 400, lastSetEpoch: 399 };
  const decision = (epoch) => ({ chair: "chair.test.near", epoch, rateBps: 23, previousRateBps: 23, hash: "h".repeat(64), chainText: null, byVisitor: false, tx: "T".repeat(43), tsMs: 1_794_000_000_000 + epoch, height: epoch });
  const list = (n) => Array.from({ length: n }, (_, i) => decision(399 - i));
  const view = { shown: 0, total: 0 };
  const cards = (n) => {
    const out = host();
    renderMinutes(fakeDoc(), out, { ...base, policy, decisions: list(n), status: "complete", partial: true }, ctx, view);
    return { out, rows: find(out, (x) => x.attrs.class === "m-rows")[0].children.length, more: find(out, (x) => x.tag === "button")[0] };
  };
  const first = cards(100);
  assert.equal(first.rows, 3, "the first draw opens a few");
  first.more.listeners.click[0](); // 3 to 23
  assert.equal(view.shown, 23);
  assert.equal(cards(100).rows, 23, "drawn again with the same history: as many as were open");
  while (find(first.out, (x) => x.tag === "button")[0].hidden !== true) first.more.listeners.click[0]();
  assert.equal(view.shown, 99);
  assert.equal(cards(99 + 30).rows, 99 + 20, "everything was open: the next page of the longer history opens too");
});
