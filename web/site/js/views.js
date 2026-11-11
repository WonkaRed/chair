// Rendering of the chain-facing sections. Pure functions of (document, data): chain strings go through `safeText` /
// `showAccount` and into `textContent` only, so no chain-supplied value can become markup.
import { formatExact, formatTokens } from "./amounts.js";
import { clear, h, svg } from "./dom.js";
import { isTxHash, safeText, showAccount } from "./text.js";

const MINUS = "−";
/** Rows of the supply log shown at first, and added per press of "Show more". */
export const LOG_PAGE = 10;
export const fmtRate = (bps) => `${bps > 0 ? "+" : bps < 0 ? MINUS : ""}${Math.abs(bps)} bps`;
export const fmtPct = (bps) => `${(Math.abs(bps) / 100).toFixed(2)}%`;
/** A rate as a percent with its sign: 15 bps is +0.15%, -15 bps is −0.15%. */
export const fmtSignedPct = (bps) => `${bps > 0 ? "+" : bps < 0 ? MINUS : ""}${fmtPct(bps)}`;
export const fmtTime = (ms) => `${new Date(Number(ms)).toISOString().replace("T", " ").slice(0, 16)} UTC`;
export const shortHash = (hash) => `${hash.slice(0, 6)}…${hash.slice(-6)}`;

/**
 * A command that reads one transaction without a browser or a block explorer (the explorer answers 403 to scripts): the transactions
 * index returns it as JSON. `reasoning` adds `jq`, which decodes the call's arguments and prints the Chair's text.
 * Only a real transaction hash gets a command; anything else gets none, so no chain string is ever put into a shell line.
 */
export function rawTxCommand(indexerUrl, hash, { reasoning = false } = {}) {
  if (!indexerUrl || !isTxHash(hash)) return null;
  const read = `curl -s ${indexerUrl}/v0/transactions -H 'content-type: application/json' -d '{"tx_hashes":["${hash}"]}'`;
  return reasoning ? `${read} | jq -r '.transactions[0].transaction.actions[0].FunctionCall.args | @base64d | fromjson | .reasoning'` : read;
}

/** A small "raw" button that copies `rawTxCommand` for a row of a table; nothing when there is no command. */
export function rawButton(doc, indexerUrl, hash) {
  const command = rawTxCommand(indexerUrl, hash);
  if (command === null) return null;
  const b = h(doc, "button", { type: "button", class: "chip raw", title: "Copy a curl command that reads this transaction without a browser or an explorer" }, "raw");
  b.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(command);
      b.textContent = "copied";
    } catch {
      b.textContent = "no clipboard";
    }
    setTimeout(() => (b.textContent = "raw"), 2000);
  });
  return b;
}

/** The rate each following epoch runs at if the chair does nothing more (SPEC "Rollover" step 2). */
export function silentPath(policy, maxStep = 50) {
  const decay = (r) => r - Math.sign(r) * Math.min(Math.abs(r), maxStep);
  const out = [];
  let r = policy.lastSetEpoch === policy.epoch ? policy.rateBps : decay(policy.rateBps);
  out.push(r);
  while (r !== 0 && out.length < 8) out.push((r = decay(r)));
  return out;
}

/** `rpcUrl` is the RPC endpoint that last answered; until one has, the page names all the ones it may use. */
export function renderSource(doc, host, { mode, config, fixture, rpcUrl = null }) {
  clear(host);
  host.className = `source ${mode}`;
  if (mode === "fixture") {
    host.append(
      h(doc, "strong", {}, "Recorded sandbox run, not a live chain."),
      " ",
      `No $CHAIR deployment exists yet, so this page is reading a recording of the real contract running in a local NEAR sandbox (${safeText(fixture.token, 60)}, ${fixture.txs.length} transactions, wasm sha256 ${safeText(String(fixture.wasm_sha256).slice(0, 12), 12)}…). The simulation below is separate and is always computed in your browser.`,
    );
  } else {
    host.append(
      h(doc, "strong", {}, `Live: ${safeText(config.account, 64)} on ${safeText(config.network, 12)}.`),
      " ",
      `Views come from ${(rpcUrl === null ? config.rpcUrls : [rpcUrl]).map((u) => safeText(new URL(u).host, 80)).join(" or ")}, the transaction list from ${safeText(new URL(config.indexerUrl).host, 80)}. Nothing passes through a server of ours.`,
    );
  }
}

function corridor(doc, policy, params) {
  const W = 640;
  const H = 106;
  const max = params.maxRateBps;
  const x = (v) => 20 + ((v + max) / (2 * max)) * (W - 40);
  const reach = [Math.max(-max, policy.rateBps - params.maxStepBps), Math.min(max, policy.rateBps + params.maxStepBps)];
  const root = svg(doc, "svg", { viewBox: `0 0 ${W} ${H}`, class: "corridor-svg", role: "img", "aria-label": `Rate ${fmtRate(policy.rateBps)} within the bounds ${MINUS}${max} to +${max} bps. The chair can move it at most ${params.maxStepBps} bps per epoch, to between ${fmtRate(reach[0])} and ${fmtRate(reach[1])}.` });
  root.append(svg(doc, "rect", { x: x(-max), y: 34, width: x(max) - x(-max), height: 22, rx: 3, class: "bounds" }));
  root.append(svg(doc, "rect", { x: x(reach[0]), y: 34, width: x(reach[1]) - x(reach[0]), height: 22, rx: 3, class: "reach" }));
  for (let v = -max; v <= max; v += params.maxStepBps) {
    root.append(svg(doc, "line", { x1: x(v), x2: x(v), y1: 58, y2: 64, class: "tickline" }));
    if (v % 100 === 0) root.append(svg(doc, "text", { x: x(v), y: 98, class: "tick", "text-anchor": v === -max ? "start" : v === max ? "end" : "middle" }, v === 0 ? "0" : fmtRate(v).replace(" bps", "")));
  }
  root.append(svg(doc, "line", { x1: x(0), x2: x(0), y1: 28, y2: 62, class: "zero" }));
  root.append(svg(doc, "polygon", { points: `${x(policy.rateBps)},58 ${x(policy.rateBps) - 8},74 ${x(policy.rateBps) + 8},74`, class: "marker" }));
  root.append(svg(doc, "text", { x: x(policy.rateBps), y: 22, class: "marker-label", "text-anchor": policy.rateBps > max / 2 ? "end" : policy.rateBps < -max / 2 ? "start" : "middle" }, `${fmtRate(policy.rateBps)} now`));
  return root;
}

export function renderNow(doc, host, d) {
  clear(host);
  const { policy, params } = d;
  const acted = policy.lastSetEpoch === policy.epoch;
  const path = silentPath(policy, params.maxStepBps);
  host.append(
    h(doc, "div", { class: "now-grid" },
      h(doc, "div", { class: "fact big" }, h(doc, "span", { class: "k" }, "Rate in effect"), h(doc, "span", { class: "v rate" }, fmtRate(policy.rateBps)), h(doc, "span", { class: "s" }, policy.rateBps > 0 ? `eases: mints ${fmtPct(policy.rateBps)} of supply to stakers at the end of each epoch` : policy.rateBps < 0 ? `tightens: every transfer burns ${fmtPct(policy.rateBps)}` : "neutral: nothing is minted or burned")),
      h(doc, "div", { class: "fact" }, h(doc, "span", { class: "k" }, "Epoch"), h(doc, "span", { class: "v" }, String(policy.epoch)), h(doc, "span", { class: "s" }, `ends ${fmtTime(policy.epochEndsMs)}; epochs last ${formatDuration(params.epochMs)}`)),
      h(doc, "div", { class: "fact" }, h(doc, "span", { class: "k" }, "Chair"), h(doc, "span", { class: "v acct" }, showAccount(policy.chair)), h(doc, "span", { class: "s" }, `${policy.streak} complete epochs in office; ${acted ? "has set this epoch's rate" : "has not set this epoch's rate yet"}`)),
    ),
    h(doc, "div", { class: "corridor" }, corridor(doc, policy, params), h(doc, "ul", { class: "key" },
      h(doc, "li", {}, h(doc, "span", { class: "sw sw-bounds", "aria-hidden": "true" }), `Allowed by the contract: ${fmtRate(-params.maxRateBps)} to ${fmtRate(params.maxRateBps)}`),
      h(doc, "li", {}, h(doc, "span", { class: "sw sw-reach", "aria-hidden": "true" }), `Where the chair can move it next: ${fmtRate(Math.max(-params.maxRateBps, policy.rateBps - params.maxStepBps))} to ${fmtRate(Math.min(params.maxRateBps, policy.rateBps + params.maxStepBps))} (at most ${params.maxStepBps} bps per epoch)`),
    )),
    h(doc, "p", { class: "note" }, `If the chair does nothing more, the next epochs run at ${path.map(fmtRate).join(", ")}.`),
  );
}

function formatDuration(ms) {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000} d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000} h`;
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  return `${ms / 1000} s`;
}

const term = (doc, k, v, exact, op) => h(doc, "div", { class: "term" }, op ? h(doc, "span", { class: "op", "aria-hidden": "true" }, op) : null, h(doc, "div", { class: "tv" }, h(doc, "span", { class: "k" }, k), h(doc, "span", { class: "v", title: formatExact(exact) }, formatTokens(exact))));

export function renderLedger(doc, host, d) {
  clear(host);
  const s = d.supply;
  const id = d.identity;
  const staked = s.totalSupply === 0n ? 0 : Number((s.totalStaked * 10_000n) / s.totalSupply) / 100;
  host.append(
    h(doc, "div", { class: "equation", role: "group", "aria-label": "Supply ledger: total equals launch plus minted minus burned" },
      term(doc, "Launch supply", s.launchSupply, s.launchSupply),
      term(doc, "Minted", s.minted, s.minted, "+"),
      term(doc, "Burned", s.burned, s.burned, MINUS),
      term(doc, "Total supply", s.totalSupply, s.totalSupply, "="),
    ),
    h(doc, "p", { class: `verdict ${id.holds ? "ok" : "bad"}`, role: "status" }, h(doc, "span", { class: "mark", "aria-hidden": "true" }, id.holds ? "✓" : "✗"), id.holds ? ` Holds: total supply = launch + minted ${MINUS} burned, computed here in exact integers from get_supply.` : ` Broken: launch + minted ${MINUS} burned is ${formatExact(id.expected)}, get_supply reports ${formatExact(id.actual)}. Do not trust this ledger.`),
    h(doc, "dl", { class: "facts" },
      h(doc, "div", {}, h(doc, "dt", {}, "Staked"), h(doc, "dd", { title: formatExact(s.totalStaked) }, `${formatTokens(s.totalStaked)} (${staked.toFixed(2)}% of supply)`)),
      h(doc, "div", {}, h(doc, "dt", {}, "Reward pool, not yet claimed"), h(doc, "dd", { title: formatExact(s.rewardPool) }, formatTokens(s.rewardPool))),
      h(doc, "div", {}, h(doc, "dt", {}, "Keys on the token account"), h(doc, "dd", { class: d.accessKeys === 0 ? "good" : d.accessKeys === null ? "" : "badtext" }, d.accessKeys === null ? "could not be read" : d.accessKeys === 0 ? "none: the code cannot be changed" : `${d.accessKeys}: the no-admin guarantee does not hold`)),
    ),
  );
}

const STATUS = {
  complete: { cls: "ok", mark: "✓", text: "Complete. Every mint and burn on the chain's ledger is in the log below, and the sums are equal." },
  mismatch: { cls: "bad", mark: "✗", text: "Mismatch. The events found do not add up to the chain's ledger; the log is not complete." },
  incomplete: { cls: "warn", mark: "!", text: "Log incomplete. The transaction index could not be read, so no event total is claimed." },
  unverified: { cls: "warn", mark: "!", text: "Unverified. The log was read but cannot be pinned to the chain's state at its last block." },
};

export function renderReconcile(doc, host, d, { onRetry }) {
  clear(host);
  const st = STATUS[d.status];
  host.append(h(doc, "p", { class: `verdict ${st.cls}`, role: "status" }, h(doc, "span", { class: "mark", "aria-hidden": "true" }, st.mark), ` ${st.text}`));
  for (const r of d.reasons) host.append(h(doc, "p", { class: "note" }, safeText(r, 400)));
  if (d.reconcile !== null) {
    const rows = d.reconcile.lines.map((l) => h(doc, "tr", {}, h(doc, "th", { scope: "row" }, l.name), h(doc, "td", { "data-label": "Logged events", title: formatExact(l.logged) }, formatTokens(l.logged)), h(doc, "td", { "data-label": "get_supply", title: formatExact(l.chain) }, formatTokens(l.chain)), h(doc, "td", { "data-label": "Result", class: l.ok ? "good" : "badtext" }, l.ok ? "equal" : "differs")));
    host.append(h(doc, "table", { class: "recon" }, h(doc, "caption", {}, d.pinnedHeight === null ? "Event sums against get_supply" : `Event sums against get_supply at block ${d.pinnedHeight}, the last block with a logged transaction`), h(doc, "thead", {}, h(doc, "tr", {}, h(doc, "th", { scope: "col" }, ""), h(doc, "th", { scope: "col" }, "Sum of logged events"), h(doc, "th", { scope: "col" }, "get_supply"), h(doc, "th", { scope: "col" }, ""))), h(doc, "tbody", {}, rows)));
  }
  if (d.pending !== null) host.append(h(doc, "p", { class: "note" }, `${formatTokens(d.pending.minted)} more is minted in views right now: an epoch boundary has passed and its mint is due. The contract applies it, and logs it, with the next transaction.`));
  for (const a of d.anomalies.slice(0, 5)) host.append(h(doc, "p", { class: "note warnnote" }, safeText(a, 160)));
  if (d.status === "incomplete" && d.retryable && onRetry) {
    const b = h(doc, "button", { type: "button", class: "chip" }, "Try again");
    b.addEventListener("click", onRetry);
    host.append(b);
  }
}

export function renderLog(doc, host, d, state, { explorer, indexerUrl = null, rerender }) {
  clear(host);
  const all = d.entries;
  const filtered = all.filter((e) => state.filter === "all" || (state.filter === "mint" ? e.kind !== "burn" : e.kind === "burn"));
  const ordered = state.newestFirst ? [...filtered].reverse() : filtered;
  const shown = ordered.slice(0, state.shown);

  const chips = h(doc, "div", { class: "controls", role: "group", "aria-label": "Filter the log" });
  for (const [key, label] of [["all", "All"], ["mint", "Mints"], ["burn", "Burns"]]) {
    const count = key === "all" ? all.length : all.filter((e) => (key === "mint" ? e.kind !== "burn" : e.kind === "burn")).length;
    const b = h(doc, "button", { type: "button", class: "chip", "aria-pressed": String(state.filter === key) }, `${label} ${count}`);
    b.addEventListener("click", () => ((state.filter = key), (state.shown = LOG_PAGE), rerender()));
    chips.append(b);
  }
  const order = h(doc, "button", { type: "button", class: "chip", "aria-pressed": "false" }, state.newestFirst ? "Newest first" : "Oldest first");
  order.addEventListener("click", () => ((state.newestFirst = !state.newestFirst), rerender()));
  chips.append(order);
  host.append(chips);

  if (all.length === 0) {
    host.append(h(doc, "p", { class: "empty" }, d.status === "incomplete" ? "No events could be loaded. See the status above." : "No mint or burn has been logged yet."));
    return;
  }
  const body = h(doc, "tbody", {});
  for (const e of shown) {
    const burn = e.kind === "burn";
    const detail = [];
    if (e.rateBps !== undefined) detail.push(`at ${fmtRate(e.rateBps)}`);
    if (e.totalStaked !== undefined) detail.push(`${formatTokens(e.totalStaked, 0)} staked`);
    if (e.spent !== undefined) detail.push(`${showAccount(e.account)} spent ${formatTokens(e.spent)}`);
    else if (e.kind === "launch" || e.memo === "storage_unregister" || e.memo === "refund") detail.push(showAccount(e.account));
    const link = explorer && isTxHash(e.hash) ? h(doc, "a", { href: `${explorer}/txns/${e.hash}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(e.hash)) : h(doc, "span", { title: safeText(e.hash, 64) }, isTxHash(e.hash) ? shortHash(e.hash) : safeText(e.hash, 20));
    body.append(
      h(doc, "tr", { class: `log-row ${e.kind}` },
        h(doc, "td", { "data-label": "Epoch" }, h(doc, "span", {}, String(e.epoch)), e.epochFrom === "block time" ? h(doc, "span", { class: "sub", title: "No chair event carries the epoch for this change; it is computed from the block time." }, "from block time") : null),
        h(doc, "td", { "data-label": "Change", class: "amt", title: formatExact(e.amount) }, h(doc, "span", { class: `sign ${burn ? "burn" : "mint"}` }, burn ? `${MINUS} Burn` : e.kind === "launch" ? "Launch" : "+ Mint"), h(doc, "span", {}, formatTokens(e.amount))),
        h(doc, "td", { "data-label": "Reason" }, h(doc, "span", {}, e.reason), detail.length ? h(doc, "span", { class: "sub" }, detail.join("; ")) : null),
        h(doc, "td", { "data-label": "Transaction", class: "tx" }, link, " ", rawButton(doc, indexerUrl, e.hash), h(doc, "span", { class: "sub" }, fmtTime(e.tsMs))),
      ),
    );
  }
  host.append(h(doc, "table", { class: "log" }, h(doc, "caption", {}, `Showing ${shown.length} of ${filtered.length} ${state.filter === "all" ? "supply changes" : state.filter === "mint" ? "mints" : "burns"}`), h(doc, "thead", {}, h(doc, "tr", {}, ["Epoch", "Change", "Reason", "Transaction"].map((t) => h(doc, "th", { scope: "col" }, t)))), body));
  if (ordered.length > shown.length) {
    const more = h(doc, "button", { type: "button", class: "chip more" }, `Show ${Math.min(LOG_PAGE, ordered.length - shown.length)} more`);
    more.addEventListener("click", () => ((state.shown += LOG_PAGE), rerender()));
    host.append(more);
  }
}

export function renderFailure(doc, host, err) {
  clear(host);
  host.append(h(doc, "p", { class: "verdict bad", role: "alert" }, h(doc, "span", { class: "mark", "aria-hidden": "true" }, "✗"), ` The chain could not be read (${safeText(err?.message ?? String(err), 160)}). No number is shown rather than a wrong one. Reloading the page tries again.`));
}
