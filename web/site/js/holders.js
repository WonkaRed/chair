// "What holders control": the two powers a holder has, said in plain words, with the live figures from the chain's own views under them.
// `holdersModel` is a pure function of what `loadLog` read (`get_params`, `get_policy`, `get_supply`, `get_candidates`); the renderers only draw it.
// Chain strings reach the page through `showAccount` and text nodes only.
import { formatTokens } from "./amounts.js";
import { IMPEACHMENT } from "./bound.js";
import { clear, h } from "./dom.js";
import { safeText, showAccount } from "./text.js";
import { plainPct } from "./views.js";

const pct1 = (n, d) => (d === 0n ? 0 : Number((n * 1_000n) / d) / 10);

/**
 * The backing a challenger must beat, in base units: the larger of the threshold share of the staked coins and the quorum share of all coins,
 * exactly as the contract compares them (`backing * 10_000 > max(threshold * staked, quorum * supply)`). `quorumBps` null means the node did not say.
 */
export function backingNeeded({ impeachThresholdBps, quorumBps }, { totalStaked, totalSupply }) {
  const byStake = (BigInt(impeachThresholdBps) * totalStaked) / 10_000n;
  const byQuorum = quorumBps === null ? 0n : (BigInt(quorumBps) * totalSupply) / 10_000n;
  return byStake > byQuorum ? byStake : byQuorum;
}

/** `d` is `{ params, policy, supply, candidates }` (`loadLog`'s quick views). */
export function holdersModel(d) {
  const { params, policy, supply, candidates } = d;
  const needed = backingNeeded(params, supply);
  return {
    stakedPct: pct1(supply.totalStaked, supply.totalSupply),
    staked: supply.totalStaked,
    total: supply.totalSupply,
    chair: policy.chair,
    streak: policy.streak,
    needed,
    thresholdBps: params.impeachThresholdBps,
    quorumBps: params.quorumBps,
    // null: the list could not be read, which is not the same as no challengers.
    challengers: candidates === null ? null : [...candidates].sort((a, b) => (a.backing === b.backing ? 0 : a.backing > b.backing ? -1 : 1)).map((c) => ({
      account: c.candidate,
      backing: c.backing,
      progressPct: needed === 0n ? 100 : Math.min(100, Number((c.backing * 1_000n) / needed) / 10),
    })),
  };
}

/** A filled bar; the width is a custom property so no inline style attribute is needed. */
function meter(doc, pct, label) {
  const fill = h(doc, "span", { class: "meter-fill" });
  fill.style.setProperty("--w", `${Math.max(0, Math.min(100, pct))}%`);
  return h(doc, "span", { class: "meter", role: "img", "aria-label": label }, fill);
}

const coins = (n) => formatTokens(n, 0);

function stat(doc, cls, key, value, ...rest) {
  return h(doc, "div", { class: `hold ${cls}` }, h(doc, "span", { class: "k" }, key), h(doc, "span", { class: "hv" }, value), ...rest.map((r) => h(doc, "span", { class: "s" }, r)));
}

function challengerRows(doc, m) {
  if (m.challengers === null) return h(doc, "p", { class: "note", role: "status" }, "The list of challengers could not be read just now. The other figures are from the chain.");
  if (m.challengers.length === 0) return h(doc, "p", { class: "hold-none" }, "Nobody is challenging the Chair right now. A holder starts a challenge by putting a candidate forward with a small deposit (returned afterwards), and stakers then back them.");
  return h(doc, "ul", { class: "challengers", "aria-label": "Challengers and their backing" }, m.challengers.map((c) => h(doc, "li", {},
    h(doc, "span", { class: "acct" }, showAccount(c.account)),
    meter(doc, c.progressPct, `${c.progressPct.toFixed(0)}% of the backing needed`),
    h(doc, "span", { class: "s" }, `${coins(c.backing)} staked coins back them. They need more than ${coins(m.needed)}: ${c.progressPct < 10 ? c.progressPct.toFixed(1) : c.progressPct.toFixed(0)}% of the way.`))));
}

/** The figures. `host` is the panel's slot; nothing here is written before the chain has answered. */
export function renderHolders(doc, host, m, { explorer = null, specUrl = null, showPast = true } = {}) {
  clear(host);
  const rule = m.quorumBps === null ? `${plainPct(m.thresholdBps)} of the staked coins` : `${plainPct(m.thresholdBps)} of the staked coins and ${plainPct(m.quorumBps)} of all coins`;
  const link = explorer === null ? null : h(doc, "a", { href: `${explorer}/txns/${IMPEACHMENT.tx}`, rel: "noopener noreferrer", target: "_blank" }, "See the transaction");
  // `append(null)` would write the text "null": nodes only.
  host.append(...[
    h(doc, "div", { class: "hold-grid" },
      h(doc, "div", { class: "hold hold-big" }, h(doc, "span", { class: "k" }, "Staked right now"), h(doc, "span", { class: "hv" }, `${m.stakedPct}%`),
        meter(doc, m.stakedPct, `${m.stakedPct}% of all coins are staked`),
        h(doc, "span", { class: "s" }, `${coins(m.staked)} of ${coins(m.total)} coins. Every coin the Chair prints is shared among these. Coins that are not staked get none, so their share shrinks.`)),
      stat(doc, "", "The Chair in the seat", h(doc, "span", { class: "acct" }, showAccount(m.chair)), `${m.streak} meetings in office.`),
      stat(doc, "", "What it takes to fire the Chair", `${coins(m.needed)} coins`, `A challenger needs more than ${rule} behind them. Each staker backs one challenger at a time, and a bigger holder counts for more.`)),
    h(doc, "h3", {}, "Challengers right now"),
    challengerRows(doc, m),
    showPast ? h(doc, "div", { class: "hold-past" },
      h(doc, "h3", {}, "It has already happened once"),
      h(doc, "p", {}, `At meeting ${IMPEACHMENT.epoch}, stakers backing ${IMPEACHMENT.backing} of the ${IMPEACHMENT.staked} staked coins replaced the first Chair with ${IMPEACHMENT.newChair}. It was my own scripted test accounts voting, not a crowd. It shows the mechanism works, not that anyone is using it. `, link)) : null,
    h(doc, "p", { class: "note" }, "Holders do not set the rate. The Chair does, inside the contract's limits. Holders decide who the Chair is."),
    h(doc, "details", { class: "fold" },
      h(doc, "summary", {}, "How a holder does it"),
      h(doc, "ul", { class: "plain" },
        h(doc, "li", {}, h(doc, "code", {}, "stake"), ": lock coins in the token. They can leave two meetings later, and while they are in they share every coin the Chair prints."),
        h(doc, "li", {}, h(doc, "code", {}, "nominate"), ": put a candidate forward with a small deposit that comes back when the challenge ends. Your whole stake backs them at once."),
        h(doc, "li", {}, h(doc, "code", {}, "back"), ": point your whole stake at a candidate. The next meeting counts the backing, and the Chair is replaced if a challenger clears the bar above."),
        specUrl === null ? null : h(doc, "li", {}, "The exact rules are in ", h(doc, "a", { href: specUrl, rel: "noopener noreferrer", target: "_blank" }, "the spec"), ".")),
    ),
  ].filter((node) => node !== null));
}

/** The figures could not be read at all: the plain words above still stand, and no number is made up. */
export function renderHoldersUnavailable(doc, host, err) {
  clear(host);
  host.append(h(doc, "p", { class: "note", role: "status" }, `The live figures could not be read just now (${safeText(err?.message ?? String(err), 120)}). Nothing is shown rather than a guess. Reloading the page tries again.`));
}
