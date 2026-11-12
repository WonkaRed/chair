// The refusals: every `set_policy` call the contract turned down, with the panic text it answered with (decisions.js reads them
// from the same transactions as the minutes). A refused call changes nothing and emits no event, so this list is the only place
// the page shows that the bounds were tried. Chain strings reach the page through `safeText` and `textContent` only.
import { clear, h } from "./dom.js";
import { isTxHash, safeText, showAccount } from "./text.js";
import { askedRate, fmtTime, rawButton, shortHash } from "./views.js";

/** Refusals shown as cards at first; the rest wait behind a button. */
const HALL = 3;

/**
 * The refusals this project made on purpose, as the scripted run recorded them (`docs/testnet-deployment.json`, steps e3-second-decision,
 * e3-impostor, e4-above-bound, e4-step-too-large, e10-impeached-chair). Only these are called tests: a refusal that is not listed here is
 * shown as a refusal and nothing more, so the page never claims intent it cannot back.
 */
export const PROJECT_TEST_CALLS = new Set([
  "4ezzLDqadCD7FHbKqSxa2MibL37iQRya15bM2eBF9Luz",
  "Ci5327N2ZQTEkBeBDLypHfvckDkFdoEHvqHYLnHkHXvx",
  "8AB8SGqGAfiWfPerFDPxv29DYg9FL2XrEbGzctZEHLMu",
  "LQLdPaCKnWvx356ua1h6Zxc57RU8p4intMmswc2BRLQ",
  "GpN9iZqJNqrUe1mZZFcyKVQnnxiGuYbhUMEvNt8EbTPh",
]);

/** The contract's panic messages (contract/src/lib.rs, policy.rs) in plain words. The raw text stays on screen beside it. */
const HUMAN = [
  [/^only the chair may set policy/, "The account that signed was not the chair."],
  [/^rate_bps out of bounds/, "The rate asked for was beyond the contract's limit: it can never go above 2% a day when printing or 2% of a transfer when burning."],
  [/^rate step too large/, "The rate asked for was more than 0.5% away from the rate in effect."],
  [/^policy already set this epoch/, "The chair had already decided in that epoch."],
  [/^reasoning_hash must be/, "The reasoning hash was not a SHA-256 digest."],
];

/** The contract's reason in plain words, or null when it is not one the page knows. */
export const humanReason = (panic) => HUMAN.find(([re]) => re.test(panic))?.[1] ?? null;

/**
 * What can be said about the refusals as a whole, from the data alone, for the top of the section: only when the project's own tests and the calls a visitor forced
 * through the press desk account for every refusal, that the AI chair never chose a refused rate. Null when they do not, or when there are no refusals.
 */
function summary(refusals, partial) {
  const forced = refusals.filter((r) => r.byVisitor && !PROJECT_TEST_CALLS.has(r.tx)).length;
  const tests = refusals.filter((r) => PROJECT_TEST_CALLS.has(r.tx)).length;
  if (refusals.length === 0 || tests === 0 || tests + forced !== refusals.length) return null;
  return `In none of ${partial ? "the refusals read here" : "them"} did the AI chair choose a rate the contract refused.`;
}

/**
 * Who made the refusals, for the page's honest-limits list: how many were the project's own tests (and who signed them) and how many a visitor forced through
 * the press desk. Null when none is a known test. Kept out of the top of the page, never dropped.
 */
export function refusalDisclosure(d) {
  if (d.status === "incomplete") return null;
  const tests = d.refusals.filter((r) => PROJECT_TEST_CALLS.has(r.tx));
  if (tests.length === 0) return null;
  const forced = d.refusals.filter((r) => r.byVisitor && !PROJECT_TEST_CALLS.has(r.tx)).length;
  const bySigner = new Map();
  for (const r of tests) bySigner.set(r.signer, (bySigner.get(r.signer) ?? 0) + 1);
  const signers = [...bySigner].map(([who, n]) => `${showAccount(who)} (${n})`).join(" and ");
  const lead = tests.length === d.refusals.length ? `All ${tests.length} were` : `${tests.length} of the ${d.refusals.length} were`;
  const visitors = forced === 0 ? "" : `; ${forced} ${forced === 1 ? "was" : "were"} forced by visitors through the press desk`;
  return `Of the refusals listed under "Times the contract told the Chair no", ${lead.replace(/^All/, "all")} deliberate test calls that I made to show the bounds hold, signed by ${signers}${visitors}.`;
}

/**
 * What a windowed list says about the project's known test refusals, which are read by hash whatever the window: that they were read, or how many
 * were not (a failed lookup is not an absence). Empty when the whole history is read.
 */
export function testCallsClause(d) {
  if (!d.partial) return "";
  const missing = d.unreadTestCalls?.length ?? 0;
  return missing === 0 ? " and the test calls made on purpose" : ` and the test calls made on purpose that could be read (${missing} of ${PROJECT_TEST_CALLS.size} could not be read just now)`;
}

/** `d` is `loadLog`'s result. */
export function renderRefusals(doc, host, d, { explorer, indexerUrl = null }) {
  clear(host);
  if (d.status === "incomplete") return host.append(h(doc, "p", { class: "empty" }, "The refusals come from the transaction index, which could not be read. See the status under the log."));
  if (d.refusals.length === 0) return host.append(h(doc, "p", { class: "empty" }, d.partial ? `The contract has refused no call to set the rate in the transactions read${(d.unreadTestCalls?.length ?? 0) > 0 ? ` (${d.unreadTestCalls.length} of the ${PROJECT_TEST_CALLS.size} test calls made on purpose could not be read just now)` : ""}.` : "The contract has refused no call to set the rate yet."));
  const lead = summary(d.refusals, d.partial);
  if (lead !== null) host.append(h(doc, "p", { class: "m-status" }, lead));
  const rows = d.refusals.map((r) => {
    const link = explorer && isTxHash(r.tx) ? h(doc, "a", { href: `${explorer}/txns/${r.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(r.tx)) : h(doc, "span", { title: safeText(r.tx, 64) }, isTxHash(r.tx) ? shortHash(r.tx) : safeText(r.tx, 20));
    const raw = safeText(r.reason, 200);
    const human = humanReason(r.reason);
    return h(doc, "tr", { class: "refusal" },
      h(doc, "td", { "data-label": "Asked for" }, r.rateBps === null ? "unreadable" : h(doc, "span", { class: "asked-big" }, askedRate(r.rateBps)), PROJECT_TEST_CALLS.has(r.tx) ? h(doc, "span", { class: "sub" }, "deliberate test") : null),
      h(doc, "td", { "data-label": "Why" }, human ?? raw, human === null ? null : h(doc, "details", { class: "raw-words" }, h(doc, "summary", {}, "The contract's own words"), h(doc, "code", {}, raw))),
      h(doc, "td", { "data-label": "Signed by", class: "acct" }, showAccount(r.signer), r.byVisitor ? h(doc, "span", { class: "sub visitor-tag" }, "Forced by a visitor through the press desk: the chair account signed it, the AI chair did not choose it") : null),
      h(doc, "td", { "data-label": "Transaction", class: "tx" }, link, " ", rawButton(doc, indexerUrl, r.tx), h(doc, "span", { class: "sub" }, fmtTime(r.tsMs))),
    );
  });
  rows.forEach((tr, i) => (tr.hidden = i >= HALL));
  host.append(h(doc, "table", { class: "log hall" }, h(doc, "caption", {}, `${rows.length} refused ${rows.length === 1 ? "call" : "calls"}${d.partial ? ` read (the latest ${d.txCount} transactions${testCallsClause(d)})` : ""}, newest first${d.refusals.some((r) => r.byVisitor) ? `; ${d.refusals.filter((r) => r.byVisitor).length} forced by visitors through the press desk` : ""}`), h(doc, "thead", {}, h(doc, "tr", {}, ["Asked for", "Why the contract said no", "Signed by", "Transaction"].map((t) => h(doc, "th", { scope: "col" }, t)))), h(doc, "tbody", {}, rows)));
  if (rows.length > HALL) {
    const more = h(doc, "button", { type: "button", class: "chip more" }, `Show all ${rows.length}${d.partial ? " read" : " refusals"}`);
    more.addEventListener("click", () => {
      for (const tr of rows) tr.hidden = false;
      more.hidden = true;
    });
    host.append(more);
  }
}

/** Who sent a refusal, in words fit for the first screen: what happened, not a confession (the full account is under "What this page does not prove"). */
const sentBy = (r) => (r.byVisitor ? "A visitor had the Chair's account ask for this, through the press desk." : PROJECT_TEST_CALLS.has(r.tx) ? "A test call, made on purpose to try the limit." : `Signed by ${showAccount(r.signer)}.`);

/**
 * The newest refusal on chain that says what was asked for, as the stamp it is, for the top of the page: the contract's own answer to a rate it will not take.
 * Nothing is drawn when there is none (or the index could not be read). It is drawn again only when the newest one changes, so its stamp lands once.
 */
export function renderHeroStamp(doc, host, d, { explorer }) {
  const r = d.status === "incomplete" ? undefined : d.refusals.find((x) => x.rateBps !== null);
  if (r === undefined) return;
  if (host.dataset.tx === r.tx) return;
  host.dataset.tx = r.tx;
  clear(host);
  const link = explorer && isTxHash(r.tx) ? h(doc, "a", { href: `${explorer}/txns/${r.tx}`, rel: "noopener noreferrer", target: "_blank" }, "Check it on NEAR testnet") : null;
  host.append(h(doc, "div", { class: "hero-stamp" },
    h(doc, "p", { class: "or-stamp" }, h(doc, "span", { class: "hs-ask" }, `${askedRate(r.rateBps)}:`), " Refused by the contract"),
    h(doc, "p", { class: "hs-why" }, humanReason(r.reason) ?? safeText(r.reason, 160)),
    h(doc, "p", { class: "hs-who" }, sentBy(r), " ", link),
  ));
}
