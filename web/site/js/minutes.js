// The chair minutes: each decision the chain recorded (decisions.js), with its reasoning text and a check, done here in the
// browser, that the text shown hashes to the hash on chain. The text comes from the decision's own transaction (the `reasoning`
// argument of `set_policy`) or, for decisions made before the chair sent it, from the texts bundled at build time (minutes.json,
// keyed by the SHA-256 the chain stores). Chain strings and bundled text are untrusted: they reach the page through `textContent` only.
import { HASH_RE } from "./decisions.js";
import { h, svg } from "./dom.js";
import { isAccountId, isTxHash, safeLines, safeText, showAccount } from "./text.js";
import { fmtPct, fmtRate, fmtSignedPct, fmtTime, rawTxCommand, shortHash } from "./views.js";

const FIRST = 5; // the newest earlier decisions shown before anyone asks for more
const PAGE = 20;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `Map<hash, {text, chair, kind, source}>` from the bundled file, or null when it could not be loaded (never a partial guess). */
export async function loadTexts(url = "minutes.json", fetchImpl = globalThis.fetch.bind(globalThis)) {
  let doc;
  try {
    const res = await fetchImpl(url, { credentials: "omit" });
    if (!res.ok) return null;
    doc = await res.json();
  } catch {
    return null;
  }
  if (doc?.schema !== "chair-minutes/1" || !isObj(doc.texts)) return null;
  const str = (v) => (typeof v === "string" ? v : null);
  return new Map(Object.entries(doc.texts).filter(([hash, r]) => HASH_RE.test(hash) && isObj(r) && typeof r.text === "string").map(([hash, r]) => [hash, { text: r.text, chair: str(r.chair), kind: str(r.kind), source: str(r.source) }]));
}

export async function sha256Hex(text, subtle = globalThis.crypto?.subtle) {
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "verified" when SHA-256 of exactly this text equals the on-chain hash, "mismatch" when not, "unchecked" when this browser cannot hash. */
export async function checkReasoning(text, hash, subtle = globalThis.crypto?.subtle) {
  if (!subtle) return "unchecked";
  try {
    return (await sha256Hex(text, subtle)) === hash ? "verified" : "mismatch";
  } catch {
    return "unchecked";
  }
}

/** The texts a decision can be checked against, best first: the one on its own transaction, then the bundled one for its hash. */
function candidates(d, texts) {
  const bundled = texts?.get(d.hash);
  return [
    d.chainText === null ? null : { text: d.chainText, chair: null, kind: null, source: null, onChain: true },
    bundled ? { ...bundled, onChain: false } : null,
  ].filter((c) => c !== null);
}

/**
 * `Map<tx, {text, chair, kind, source, onChain, verdict}>` for every decision that has a text on its transaction or bundled. The text kept is
 * the first candidate whose SHA-256 equals the chain's hash; when none does, the first candidate, as a "mismatch" (never shown as verified).
 */
export async function resolveTexts(decisions, texts, subtle = globalThis.crypto?.subtle) {
  const out = new Map();
  await Promise.all(decisions.map(async (d) => {
    const found = candidates(d, texts);
    if (found.length === 0) return;
    const verdicts = await Promise.all(found.map((c) => checkReasoning(c.text, d.hash, subtle)));
    const at = Math.max(0, verdicts.indexOf("verified"));
    out.set(d.tx, { ...found[at], verdict: verdicts[at] });
  }));
  return out;
}

/** What the chair's silence, if any, has done to the rate: the views already apply the decay (SPEC "Views"). */
export function silence(policy, latest) {
  const rate = fmtRate(policy.rateBps);
  if (policy.lastSetEpoch === null) return { cls: "warn", text: `The Chair has not set a rate yet. The rate in effect is ${rate}.` };
  if (policy.lastSetEpoch === policy.epoch) return { cls: "ok", text: `The Chair has decided in the current epoch, ${policy.epoch}.` };
  const missed = policy.epoch - policy.lastSetEpoch - 1;
  if (missed === 0) return { cls: "ok", text: `No decision yet in epoch ${policy.epoch}; the last was in epoch ${policy.lastSetEpoch}. The rate in effect is ${rate}.` };
  const moved = latest !== undefined && latest.rateBps === policy.rateBps ? `the rate stays at ${rate}` : latest === undefined ? `the rate in effect is ${rate}` : `the rate has decayed to ${rate}`;
  return { cls: "warn", text: `No decision for ${plural(missed, "epoch")}; ${moved}. The last decision was in epoch ${policy.lastSetEpoch}.` };
}

const MARKS = {
  verified: { cls: "ok", mark: "✓", short: "Verified", long: "The SHA-256 of this text, computed in your browser, equals the reasoning_hash on chain." },
  mismatch: { cls: "bad", mark: "✗", short: "Mismatch", long: "The SHA-256 of this text does not equal the reasoning_hash on chain. Do not trust this text." },
  unchecked: { cls: "warn", mark: "!", short: "Not checked", long: "This browser cannot compute SHA-256 on this page (it needs a secure context such as https), so the text was not checked." },
  absent: { cls: "none", mark: "-", short: "No text", long: null },
};
const KIND = { llm: "an AI model", rule: "a rule-based chair" };

// Every agent text opens with two lines of boilerplate: "$CHAIR decision, epoch N, chair X." and "Rate in effect R; decision D.".
// They are shown as small metadata; the sentences after them are the minutes. The check still runs on the whole, exact text.
const BOILERPLATE = [/^\$CHAIR decision, epoch \d+, chair .+\.$/, /^Rate in effect .+ bps; decision .+ bps\.$/];

/** `{meta, prose}`: the leading boilerplate lines, and the rest. A text that is nothing but boilerplate is all prose. */
export function splitMinutes(text) {
  const lines = text.split("\n");
  let n = 0;
  while (n < BOILERPLATE.length && n < lines.length && BOILERPLATE[n].test(lines[n])) n++;
  const prose = lines.slice(n).join("\n").trim();
  return prose === "" ? { meta: [], prose: text } : { meta: lines.slice(0, n), prose };
}

const move = (d) => {
  const delta = d.rateBps - d.previousRateBps;
  return delta === 0 ? `unchanged from ${fmtRate(d.previousRateBps)}` : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} bps from ${fmtRate(d.previousRateBps)}`;
};

/** What a rate does, in the contract's terms (SPEC "Rollover"). */
const effect = (bps) => (bps > 0 ? `Mints ${fmtPct(bps)} of supply for stakers each epoch.` : bps < 0 ? `Burns ${fmtPct(bps)} of every transfer.` : "Nothing minted, nothing burned.");

function who(doc, d, rec) {
  const label = rec?.chair ? safeText(rec.chair, 80) : null;
  const kind = rec?.kind && KIND[rec.kind] ? `, ${KIND[rec.kind]}` : "";
  return h(doc, "p", { class: "m-who" },
    label ? ["Decided by ", h(doc, "strong", {}, label), kind, ". Signed by "] : "Signed by ",
    h(doc, "span", { class: isAccountId(d.chair) ? "acct nowrap" : "acct" }, showAccount(d.chair)),
    ` at ${fmtTime(d.tsMs)}.`,
  );
}

function pill(doc, state, label = MARKS[state].short, extra = {}) {
  const m = MARKS[state];
  return h(doc, "span", { class: `verdict ${m.cls} m-mark`, ...extra }, h(doc, "span", { class: "mark", "aria-hidden": "true" }, m.mark), ` ${label}`);
}

function proof(doc, d, ctx) {
  const tx = ctx.explorer && isTxHash(d.tx) ? h(doc, "a", { href: `${ctx.explorer}/txns/${d.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(d.tx)) : h(doc, "span", { title: safeText(d.tx, 64) }, isTxHash(d.tx) ? shortHash(d.tx) : safeText(d.tx, 20));
  const raw = rawTxCommand(ctx.indexerUrl, d.tx, { reasoning: true });
  return h(doc, "dl", { class: "m-proof" },
    h(doc, "div", {}, h(doc, "dt", {}, "reasoning_hash on chain"), h(doc, "dd", { class: "m-hash" }, d.hash)),
    h(doc, "div", {}, h(doc, "dt", {}, "Transaction"), h(doc, "dd", { class: "tx" }, tx)),
    raw === null ? null : h(doc, "div", {}, h(doc, "dt", {}, "Read it without a browser"), h(doc, "dd", {}, h(doc, "code", { class: "raw-cmd" }, raw))),
  );
}

/** The pieces of one decision: its state, the prose to lead with, the boilerplate as metadata, and the notes that belong with the proof. */
function parts(doc, d, ctx) {
  const rec = ctx.resolved.get(d.tx);
  const state = rec ? rec.verdict : "absent";
  if (!rec) {
    const lead = h(doc, "p", { class: "m-absent" }, ctx.texts === null ? "The bundled reasoning texts could not be loaded, so no text is shown for this decision." : "no reasoning text for this decision: its transaction carries none and none was saved");
    return { state, rec, lead, meta: null, notes: [] };
  }
  const shown = safeLines(rec.text);
  const { meta, prose } = splitMinutes(shown);
  const src = rec.source && /^[\w.-]+$/.test(rec.source) && ctx.repoBase ? h(doc, "a", { href: `${ctx.repoBase}/docs/${rec.source}`, rel: "noopener noreferrer", target: "_blank" }, `docs/${rec.source}`) : null;
  return {
    state,
    rec,
    lead: h(doc, "blockquote", { class: "reasoning", lang: "en" }, prose),
    meta: meta.length === 0 && !d.byVisitor ? null : h(doc, "p", { class: "m-meta" }, d.byVisitor ? h(doc, "strong", { class: "visitor-tag" }, "Forced by a visitor through the press desk, not decided by the AI chair: the chair account signed it. ") : null, meta.map((line) => h(doc, "span", {}, line))),
    notes: [
      h(doc, "p", { class: `m-check ${MARKS[state].cls}` }, h(doc, "strong", {}, `${MARKS[state].mark} ${MARKS[state].short}.`), ` ${MARKS[state].long}`),
      shown !== rec.text ? h(doc, "p", { class: "note" }, "Some characters in this text are not printable and are shown as \\u{...} escapes. The check above ran on the exact text.") : null,
      rec.onChain ? h(doc, "p", { class: "note" }, "The text was read from the arguments of the transaction below.") : null,
      src ? h(doc, "p", { class: "note" }, "The text was recorded when the chair ran: ", src, ".") : null,
    ],
  };
}

const HOW = "Your browser computed the SHA-256 of the exact text above and compared it with the reasoning_hash the contract logged for this decision. A match shows the text was not edited after the decision. It does not show the Chair was right.";

/** The mark's words: what was checked, and where. A recorded sandbox run is never called testnet. */
const verdictLabel = (state, ctx) => (state === "verified" ? (ctx.network ? `Verified on NEAR ${safeText(ctx.network, 12)}` : "Verified against the recorded sandbox run") : MARKS[state].short);

/** The latest decision as the page's pull-quote: the prose large, the epoch, the rate as a percent with bps second, and the proof folded behind the mark. */
function heroCard(doc, d, ctx, silent) {
  const p = parts(doc, d, ctx);
  return h(doc, "figure", { class: `minutes-paper ${p.state}`, "aria-label": `Latest minutes, epoch ${d.epoch}` },
    svg(doc, "svg", { class: "watermark", "aria-hidden": "true" }, svg(doc, "use", { href: "#seal" })),
    h(doc, "p", { class: "paper-head" }, h(doc, "span", {}, "Minutes of the Committee of One"), h(doc, "span", { class: "paper-epoch" }, `Epoch ${d.epoch}`)),
    p.lead,
    h(doc, "figcaption", { class: "paper-rate" },
      h(doc, "span", { class: "rate-big" }, fmtSignedPct(d.rateBps)),
      h(doc, "span", { class: "rate-bps" }, fmtRate(d.rateBps)),
      h(doc, "span", { class: "rate-effect" }, effect(d.rateBps)),
      h(doc, "span", { class: "rate-prev" }, `Previous rate ${fmtRate(d.previousRateBps)}.`),
    ),
    silent ? h(doc, "p", { class: "m-status warn" }, silent) : null,
    h(doc, "details", { class: `seal ${p.state}` },
      h(doc, "summary", {}, svg(doc, "svg", { class: "stamp", "aria-hidden": "true" }, svg(doc, "use", { href: "#seal" })), pill(doc, p.state, verdictLabel(p.state, ctx))),
      h(doc, "div", { class: "seal-body" },
        p.meta,
        p.rec ? h(doc, "p", { class: "note" }, HOW) : null,
        who(doc, d, p.rec),
        p.notes,
        proof(doc, d, ctx),
      ),
    ),
  );
}

/** `d` is `loadLog`'s result; `ctx` as for `renderMinutes`. Fills the hero's slot with the latest decision. */
export function renderHero(doc, host, d, ctx) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const [latest] = d.decisions;
  if (latest === undefined) return host.append(h(doc, "p", { class: "empty" }, d.status === "incomplete" ? "The decisions come from the transaction index, which could not be read. See the status under the log." : "No decision has been recorded on chain yet."));
  const s = silence(d.policy, latest);
  host.append(heroCard(doc, latest, ctx, s.cls === "warn" ? s.text : null));
}

function card(doc, d, ctx) {
  const p = parts(doc, d, ctx);
  return h(doc, "article", { class: `minute card ${p.state}` },
    p.lead,
    h(doc, "p", { class: "m-line" },
      h(doc, "strong", {}, `Epoch ${d.epoch}`),
      h(doc, "span", {}, `${fmtSignedPct(d.rateBps)} (${fmtRate(d.rateBps)}), ${move(d)}`),
      pill(doc, p.state),
    ),
    p.meta,
    h(doc, "details", { class: "m-more" },
      h(doc, "summary", {}, "Proof and details"),
      h(doc, "div", { class: "m-body" }, who(doc, d, p.rec), p.notes, proof(doc, d, ctx)),
    ),
  );
}

/** Persistent nodes, no re-render: the focus stays on the control that was pressed. The first batch is `FIRST` cards, then `PAGE` per press. */
function cards(doc, list, ctx) {
  const rows = h(doc, "div", { class: "m-rows" });
  const count = h(doc, "p", { class: "note m-count" });
  const more = h(doc, "button", { type: "button", class: "chip more" });
  let shown = 0;
  const showNext = () => {
    for (const d of list.slice(shown, shown + (shown === 0 ? FIRST : PAGE))) rows.append(card(doc, d, ctx));
    shown = Math.min(list.length, shown + (shown === 0 ? FIRST : PAGE));
    more.hidden = shown >= list.length;
    more.textContent = `Show ${Math.min(PAGE, list.length - shown)} more`;
    count.textContent = `Showing the ${shown} newest of ${list.length} earlier decisions (${list.length + 1} in all, counting the latest at the top of the page).`;
  };
  more.addEventListener("click", showNext);
  showNext();
  return [count, rows, more];
}

/** The earlier decisions as cards, newest first (the latest is the hero). `ctx` is `{texts, resolved, explorer, indexerUrl, repoBase, network}`: `indexerUrl` the transactions index, null on a recorded run; `texts` the bundled texts or null, `resolved` from `resolveTexts`. */
export function renderMinutes(doc, host, d, ctx) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const [latest, ...older] = d.decisions;
  const s = silence(d.policy, latest);
  host.append(h(doc, "p", { class: `m-status ${s.cls}`, role: "status" }, s.text));
  if (d.status === "incomplete") host.append(h(doc, "p", { class: "empty" }, "The decisions come from the transaction index, which could not be read. See the status under the log."));
  else if (latest === undefined) host.append(h(doc, "p", { class: "empty" }, "No decision has been recorded on chain yet."));
  if (older.length > 0) host.append(...cards(doc, older, ctx));
}
