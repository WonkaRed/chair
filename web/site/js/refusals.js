// The refusals: every `set_policy` call the contract turned down, with the panic text it answered with (decisions.js reads them
// from the same transactions as the minutes). A refused call changes nothing and emits no event, so this list is the only place
// the page shows that the bounds were tried. Chain strings reach the page through `safeText` and `textContent` only.
import { clear, h } from "./dom.js";
import { isTxHash, safeText, showAccount } from "./text.js";
import { fmtRate, fmtTime, shortHash } from "./views.js";

/** `d` is `loadLog`'s result. */
export function renderRefusals(doc, host, d, { explorer }) {
  clear(host);
  if (d.status === "incomplete") return host.append(h(doc, "p", { class: "empty" }, "The refusals come from the transaction index, which could not be read. See the status under the log."));
  if (d.refusals.length === 0) return host.append(h(doc, "p", { class: "empty" }, "The contract has refused no set_policy call yet."));
  const rows = d.refusals.map((r) => {
    const link = explorer && isTxHash(r.tx) ? h(doc, "a", { href: `${explorer}/txns/${r.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(r.tx)) : h(doc, "span", { title: safeText(r.tx, 64) }, isTxHash(r.tx) ? shortHash(r.tx) : safeText(r.tx, 20));
    return h(doc, "tr", { class: "refusal" },
      h(doc, "td", { "data-label": "Asked for" }, r.rateBps === null ? "unreadable" : fmtRate(r.rateBps)),
      h(doc, "td", { "data-label": "Answer" }, safeText(r.reason, 200)),
      h(doc, "td", { "data-label": "Signed by", class: "acct" }, showAccount(r.signer)),
      h(doc, "td", { "data-label": "Transaction", class: "tx" }, link, h(doc, "span", { class: "sub" }, fmtTime(r.tsMs))),
    );
  });
  host.append(h(doc, "table", { class: "log" }, h(doc, "caption", {}, `${rows.length} refused set_policy ${rows.length === 1 ? "call" : "calls"}, newest first`), h(doc, "thead", {}, h(doc, "tr", {}, ["Asked for", "Contract's answer", "Signed by", "Transaction"].map((t) => h(doc, "th", { scope: "col" }, t)))), h(doc, "tbody", {}, rows)));
}
