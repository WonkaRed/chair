// "What holders control", the chair's pull quote, and the quick views loadLog hands to the page before the slow index is read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const site = (f) => import(join(root, "site", "js", f));
const { backingNeeded, holdersModel, renderHolders, renderHoldersUnavailable } = await site("holders.js");
const { newestAnswer, setPullQuote, linkFallback } = await site("pullquote.js");
const { loadLog, parseCandidates, parseParams } = await site("loadlog.js");
const { SourceError } = await site("sources.js");
const { UNIT } = await site("amounts.js");

const coins = (n) => BigInt(n) * UNIT;
const params = { epochMs: 90_000, startMs: 1, maxRateBps: 200, maxStepBps: 50, impeachThresholdBps: 3000, quorumBps: 500 };
const supply = { totalSupply: coins(1_600_000), totalStaked: coins(600_000) };
const policy = { chair: "challenger.chair-coin-2.testnet", streak: 654, rateBps: 25 };
const text = (n) => n.textContent.replaceAll("\u202f", " "); // coins are grouped with a narrow no-break space
const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));

test("the bar is the larger of the stake threshold and the quorum, as the contract compares them", () => {
  assert.equal(backingNeeded(params, supply), coins(180_000), "30% of 600,000 staked beats 5% of 1,600,000");
  assert.equal(backingNeeded(params, { totalSupply: coins(1_600_000), totalStaked: coins(100_000) }), coins(80_000), "a thin stake: the quorum is the bar");
  assert.equal(backingNeeded({ ...params, quorumBps: null }, { totalSupply: coins(1_600_000), totalStaked: coins(100_000) }), coins(30_000), "a node that does not say the quorum: only the threshold is claimed");
});

test("the model: staked share, the seat, the bar, and challengers by backing with progress capped at 100%", () => {
  const m = holdersModel({ params, policy, supply, candidates: [{ candidate: "a.testnet", backing: coins(18_000) }, { candidate: "b.testnet", backing: coins(200_000) }] });
  assert.equal(m.stakedPct, 37.5);
  assert.equal(m.chair, policy.chair);
  assert.equal(m.needed, coins(180_000));
  assert.deepEqual(m.challengers.map((c) => [c.account, c.progressPct]), [["b.testnet", 100], ["a.testnet", 10]]);
  assert.equal(holdersModel({ params, policy, supply, candidates: [] }).challengers.length, 0);
  assert.equal(holdersModel({ params, policy, supply, candidates: null }).challengers, null, "unreadable is not the same as none");
  assert.equal(holdersModel({ params, policy, supply: { totalSupply: 0n, totalStaked: 0n }, candidates: [] }).stakedPct, 0);
});

test("the panel says the live figures in plain words and the past impeachment with its transaction", () => {
  const doc = fakeDoc();
  const el = host(doc);
  const m = holdersModel({ params, policy, supply, candidates: [] });
  renderHolders(doc, el, m, { explorer: "https://explorer.example", specUrl: "https://repo.example/SPEC.md" });
  const t = text(el);
  assert.match(t, /Staked right now37\.5%/);
  assert.match(t, /600 000 of 1 600 000 coins\. Every coin the Chair prints is shared among these\./);
  assert.match(t, /654 meetings in office\./);
  assert.match(t, /180 000 coins/);
  assert.match(t, /more than 30% of the staked coins and 5% of all coins behind them/);
  assert.match(t, /Nobody is challenging the Chair right now\./);
  assert.match(t, /At meeting 10, stakers backing 400,000 of the 400,000 staked coins replaced the first Chair/);
  assert.match(t, /my own scripted test accounts voting, not a crowd/);
  assert.match(t, /Holders do not set the rate\. The Chair does/);
  assert.match(t, /How a holder does it/);
  assert.deepEqual(find(el, (n) => n.tag === "a").map((n) => n.attrs.href), ["https://explorer.example/txns/CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD", "https://repo.example/SPEC.md"]);
  assert.doesNotMatch(t, /—|–|NaN|undefined/);
  const again = renderHolders(doc, el, m, {});
  assert.equal(find(el, (n) => n.attrs?.class === "hold-grid").length, 1, "re-rendering replaces, never stacks");
  assert.equal(again, undefined);
});

test("challengers are listed with their backing against the bar; an unreadable list and a fixture say what they must", () => {
  const doc = fakeDoc();
  const el = host(doc);
  renderHolders(doc, el, holdersModel({ params, policy, supply, candidates: [{ candidate: "rival.testnet", backing: coins(90_000) }] }), {});
  assert.match(text(el), /rival\.testnet/);
  assert.match(text(el), /90 000 staked coins back them\. They need more than 180 000: 50% of the way\./);
  const meter = find(find(el, (n) => n.attrs?.class === "challengers")[0], (n) => n.attrs?.class === "meter")[0];
  assert.equal(meter.children[0].styles["--w"], "50%", "the width goes through a custom property, never an inline style attribute");
  assert.equal(meter.attrs.style, undefined);
  const blind = host(doc);
  renderHolders(doc, blind, holdersModel({ params, policy, supply, candidates: null }), {});
  assert.match(text(blind), /The list of challengers could not be read just now\./);
  assert.doesNotMatch(text(blind), /Nobody is challenging/);
  const fixture = host(doc);
  renderHolders(doc, fixture, holdersModel({ params, policy, supply, candidates: [] }), { showPast: false });
  assert.doesNotMatch(text(fixture), /already happened/, "a recorded run does not claim the testnet's history");
});

test("a hostile account id is shown as an invalid id, never as markup", () => {
  const doc = fakeDoc();
  const el = host(doc);
  renderHolders(doc, el, holdersModel({ params, policy: { ...policy, chair: "<img src=x onerror=1>" }, supply, candidates: [{ candidate: "x‮gnp.exe", backing: 1n }] }), {});
  assert.match(text(el), /invalid id: <img src=x onerror=1>/);
  assert.match(text(el), /invalid id: x\\u\{202e\}gnp\.exe/);
  assert.equal(find(el, (n) => n.tag === "img").length, 0);
});

test("when the chain cannot be read the panel says so and shows no figure", () => {
  const doc = fakeDoc();
  const el = host(doc);
  renderHoldersUnavailable(doc, el, new SourceError("rpc", "unreachable or rate limited"));
  assert.match(text(el), /The live figures could not be read just now \(unreachable or rate limited\)\. Nothing is shown rather than a guess\./);
  assert.doesNotMatch(text(el), /\d/);
});

test("get_candidates is read strictly: a list of accounts with a U128 backing, anything else is an error", () => {
  assert.deepEqual(parseCandidates([]), []);
  assert.deepEqual(parseCandidates([{ candidate: "a.testnet", nominator: "n.testnet", persona_hash: "x", backing: "5", bond: "1" }]), [{ candidate: "a.testnet", backing: 5n }]);
  for (const bad of [null, {}, [null], [{ candidate: 1, backing: "5" }], [{ candidate: "a", backing: 5 }], [{ candidate: "a", backing: "-1" }]]) assert.throws(() => parseCandidates(bad), SourceError, JSON.stringify(bad));
  assert.equal(parseParams({ epoch_ms: 1, start_ms: 1, max_rate_bps: 200, max_step_bps: 50, impeach_threshold_bps: 3000, quorum_bps: 500 }).quorumBps, 500);
  assert.equal(parseParams({ epoch_ms: 1, start_ms: 1, max_rate_bps: 200, max_step_bps: 50, impeach_threshold_bps: 3000 }).quorumBps, null);
});

const views = { get_params: { epoch_ms: 90_000, start_ms: 1, max_rate_bps: 200, max_step_bps: 50, impeach_threshold_bps: 3000, quorum_bps: 500 }, get_policy: { epoch: 5, rate_bps: 25, chair: "c.testnet", streak: 2, last_set_epoch: 4, epoch_ends_ms: 9 }, get_supply: { epoch: 5, launch_supply: "1000000000000000000000000000000", minted: "0", burned: "0", total_supply: "1000000000000000000000000000000", total_staked: "0", reward_pool: "0" } };

test("loadLog hands over the four quick views before it touches the slow index, and a candidates view that fails does not fail the page", async () => {
  const order = [];
  const transport = {
    kind: "live",
    token: "t.testnet",
    view: async (m) => {
      order.push(m);
      if (m === "get_candidates") throw new SourceError("rpc", "unreachable");
      return views[m];
    },
    accessKeys: async () => 0,
    txHashes: async () => {
      order.push("txHashes");
      return [];
    },
    transactions: async () => [],
  };
  let seen = null;
  const d = await loadLog(transport, { onViews: (v) => { order.push("onViews"); seen = v; } });
  assert.ok(order.indexOf("onViews") < order.indexOf("txHashes"), "the page has its numbers before the index is asked");
  assert.deepEqual(Object.keys(seen).sort(), ["candidates", "params", "policy", "supply"]);
  assert.equal(seen.candidates, null);
  assert.equal(d.candidates, null);
  assert.equal(seen.params.quorumBps, 500);
  const ok = await loadLog({ ...transport, view: async (m) => (m === "get_candidates" ? [{ candidate: "a.testnet", nominator: "n.testnet", persona_hash: "h", backing: "7", bond: "1" }] : views[m]) });
  assert.deepEqual(ok.candidates, [{ candidate: "a.testnet", backing: 7n }]);
});

test("the pull quote: the newest answer is the last line of the newest decision; a bad list is no answer", () => {
  assert.equal(newestAnswer([]), null);
  assert.equal(newestAnswer(null), null);
  const list = [{ answer: "second line", tx: "A", epoch: 9 }, { answer: "first line", tx: "A", epoch: 9 }, { answer: "older", tx: "B", epoch: 8 }];
  assert.equal(newestAnswer(list).answer, "first line", "within one decision the lines come in the order written, so the last is the newest");
});

const figure = (doc, data = {}) => {
  const quote = doc.createElement("blockquote");
  quote.textContent = "The Chair is neither up nor down. The Chair is seated.";
  const caption = doc.createElement("figcaption");
  return { quote, caption, dataset: data, querySelector: (s) => (s === "blockquote" ? quote : caption) };
};

test("the caption says which line it is: the fallback, then the chain's newest answer; links only for a real transaction", () => {
  const doc = fakeDoc();
  const tx = "GuLkS2VJmnxq9gL6tJH7PD2tMRUnqv7FV721cbw2Fo2a";
  const fig = figure(doc, { tx, epoch: "525" });
  linkFallback(doc, fig, "https://explorer.example");
  assert.equal(text(fig.caption), "A line the Chair gave the press, meeting 525. On chain");
  assert.equal(find(fig.caption, (n) => n.tag === "a")[0].attrs.href, `https://explorer.example/txns/${tx}`);
  setPullQuote(doc, fig, { answer: "A new line.‮", epoch: 700, tx }, { explorer: "https://explorer.example", live: true });
  assert.equal(text(fig.quote), "A new line.\\u{202e}");
  assert.equal(text(fig.caption), "The Chair's newest answer to the press, meeting 700. On chain");
  setPullQuote(doc, fig, { answer: "x", epoch: null, tx: "not a hash" }, { explorer: "https://explorer.example", live: true });
  assert.equal(text(fig.caption), "The Chair's newest answer to the press. ");
  linkFallback(doc, figure(doc, { tx, epoch: "525" }), null);
});
