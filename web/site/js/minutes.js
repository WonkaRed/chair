// The chair minutes: each decision the chain recorded (decisions.js), with the reasoning text bundled at build time
// (minutes.json, keyed by the SHA-256 the chain stores) and a check, done here in the browser, that the text shown
// hashes to the hash on chain. Chain strings and bundled text are untrusted: they reach the page through `textContent` only.
import { HASH_RE } from "./decisions.js";
import { h } from "./dom.js";
import { isAccountId, isTxHash, safeLines, safeText, showAccount } from "./text.js";
import { fmtRate, fmtTime, shortHash } from "./views.js";

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

/** `Map<hash, "verified" | "mismatch" | "unchecked">` for every decision that has a bundled text. */
export async function checkDecisions(decisions, texts, subtle = globalThis.crypto?.subtle) {
  const out = new Map();
  if (texts === null) return out;
  await Promise.all(decisions.map(async (d) => {
    const rec = texts.get(d.hash);
    if (rec && !out.has(d.hash)) out.set(d.hash, await checkReasoning(rec.text, d.hash, subtle));
  }));
  return out;
}

/** What the chair's silence, if any, has done to the rate: the views already apply the decay (SPEC "Views"). */
export function silence(policy, latest) {
  const rate = fmtRate(policy.rateBps);
  if (policy.lastSetEpoch === null) return { cls: "warn", text: `The chair has not set a rate yet. The rate in effect is ${rate}.` };
  if (policy.lastSetEpoch === policy.epoch) return { cls: "ok", text: `The chair has decided in the current epoch, ${policy.epoch}.` };
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

const move = (d) => {
  const delta = d.rateBps - d.previousRateBps;
  return delta === 0 ? `unchanged from ${fmtRate(d.previousRateBps)}` : `${delta > 0 ? "up" : "down"} ${Math.abs(delta)} bps from ${fmtRate(d.previousRateBps)}`;
};

function who(doc, d, rec) {
  const label = rec?.chair ? safeText(rec.chair, 80) : null;
  const kind = rec?.kind && KIND[rec.kind] ? `, ${KIND[rec.kind]}` : "";
  return h(doc, "p", { class: "m-who" },
    label ? ["Decided by ", h(doc, "strong", {}, label), kind, ". Signed by "] : "Signed by ",
    h(doc, "span", { class: isAccountId(d.chair) ? "acct nowrap" : "acct" }, showAccount(d.chair)),
    ` at ${fmtTime(d.tsMs)}.`,
  );
}

function pill(doc, state, extra = {}) {
  const m = MARKS[state];
  return h(doc, "span", { class: `verdict ${m.cls} m-mark`, ...extra }, h(doc, "span", { class: "mark", "aria-hidden": "true" }, m.mark), ` ${m.short}`);
}

function proof(doc, d, ctx) {
  const tx = ctx.explorer && isTxHash(d.tx) ? h(doc, "a", { href: `${ctx.explorer}/txns/${d.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(d.tx)) : h(doc, "span", { title: safeText(d.tx, 64) }, isTxHash(d.tx) ? shortHash(d.tx) : safeText(d.tx, 20));
  return h(doc, "dl", { class: "m-proof" },
    h(doc, "div", {}, h(doc, "dt", {}, "reasoning_hash on chain"), h(doc, "dd", { class: "m-hash" }, d.hash)),
    h(doc, "div", {}, h(doc, "dt", {}, "Transaction"), h(doc, "dd", { class: "tx" }, tx)),
  );
}

function reasoning(doc, rec, state, ctx) {
  if (!rec) {
    return h(doc, "p", { class: "m-absent" }, ctx.texts === null ? "The bundled reasoning texts could not be loaded, so no text is shown for this decision." : "reasoning text not published for this decision");
  }
  const shown = safeLines(rec.text);
  const src = rec.source && /^[\w.-]+$/.test(rec.source) && ctx.repoBase ? h(doc, "a", { href: `${ctx.repoBase}/docs/${rec.source}`, rel: "noopener noreferrer", target: "_blank" }, `docs/${rec.source}`) : null;
  return [
    h(doc, "div", { class: "reasoning", lang: "en" }, shown),
    h(doc, "p", { class: `m-check ${MARKS[state].cls}`, role: "status" }, h(doc, "strong", {}, `${MARKS[state].mark} ${MARKS[state].short}.`), ` ${MARKS[state].long}`),
    shown !== rec.text ? h(doc, "p", { class: "note" }, "Some characters in this text are not printable and are shown as \\u{...} escapes. The check above ran on the exact text.") : null,
    src ? h(doc, "p", { class: "note" }, "The text was recorded when the chair ran: ", src, ".") : null,
  ];
}

function detail(doc, d, ctx) {
  const rec = ctx.texts?.get(d.hash);
  const state = rec ? (ctx.checks.get(d.hash) ?? "unchecked") : "absent";
  return { state, nodes: [who(doc, d, rec), reasoning(doc, rec, state, ctx), proof(doc, d, ctx)].flat() };
}

function latestCard(doc, d, ctx) {
  const { state, nodes } = detail(doc, d, ctx);
  return h(doc, "article", { class: `minute latest ${state}`, "aria-label": `Latest decision, epoch ${d.epoch}` },
    h(doc, "header", { class: "m-head" },
      h(doc, "div", { class: "m-figure" }, h(doc, "span", { class: "k" }, `Epoch ${d.epoch}`), h(doc, "span", { class: "v rate" }, fmtRate(d.rateBps)), h(doc, "span", { class: "s" }, move(d))),
      state === "absent" ? null : pill(doc, state),
    ),
    nodes,
  );
}

function row(doc, d, ctx) {
  const { state, nodes } = detail(doc, d, ctx);
  return h(doc, "details", { class: `minute row ${state}` },
    h(doc, "summary", {},
      h(doc, "span", { class: "m-epoch" }, `Epoch ${d.epoch}`),
      h(doc, "span", { class: "m-rate" }, h(doc, "strong", {}, fmtRate(d.rateBps)), h(doc, "span", { class: "sub" }, move(d))),
      pill(doc, state),
    ),
    h(doc, "div", { class: "m-body" }, nodes),
  );
}

/** Persistent nodes, no re-render: the focus stays on the control that was pressed. */
function olderList(doc, older, ctx) {
  const list = h(doc, "div", { class: "m-older", id: "minutes-older" });
  list.hidden = true;
  const rows = h(doc, "div", { class: "m-rows" });
  const more = h(doc, "button", { type: "button", class: "chip more" });
  let shown = 0;
  const showNext = () => {
    for (const d of older.slice(shown, shown + PAGE)) rows.append(row(doc, d, ctx));
    shown = Math.min(older.length, shown + PAGE);
    more.hidden = shown >= older.length;
    more.textContent = `Show ${Math.min(PAGE, older.length - shown)} more of ${older.length - shown}`;
  };
  more.addEventListener("click", showNext);
  showNext();
  list.append(rows, more);
  const toggle = h(doc, "button", { type: "button", class: "chip", "aria-expanded": "false", "aria-controls": "minutes-older" }, `Show all ${plural(older.length, "earlier decision")}`);
  toggle.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Hide earlier decisions" : `Show all ${plural(older.length, "earlier decision")}`;
  });
  return [toggle, list];
}

/** `d` is `loadLog`'s result; `ctx` is `{texts, checks, explorer, repoBase}`. */
export function renderMinutes(doc, host, d, ctx) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const [latest, ...older] = d.decisions;
  const s = silence(d.policy, latest);
  host.append(h(doc, "p", { class: `m-status ${s.cls}`, role: "status" }, s.text));
  if (d.status === "incomplete") host.append(h(doc, "p", { class: "empty" }, "The decisions come from the transaction index, which could not be read. See the status under the log."));
  else if (latest === undefined) host.append(h(doc, "p", { class: "empty" }, "No decision has been recorded on chain yet."));
  if (latest === undefined) return;
  host.append(latestCard(doc, latest, ctx));
  if (older.length > 0) host.append(...olderList(doc, older, ctx));
}
