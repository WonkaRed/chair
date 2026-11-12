// The chair minutes: each decision the chain recorded (decisions.js), with its reasoning text and a check, done here in the
// browser, that the text shown hashes to the hash on chain. The text comes from the decision's own transaction (the `reasoning`
// argument of `set_policy`) or, for decisions made before the chair sent it, from the texts bundled at build time (minutes.json,
// keyed by the SHA-256 the chain stores). Chain strings and bundled text are untrusted: they reach the page through `textContent` only.
import { HASH_RE } from "./decisions.js";
import { h, svg } from "./dom.js";
import { isAccountId, isTxHash, safeLines, safeText, showAccount } from "./text.js";
import { fmtPct, fmtRate, fmtSignedPct, fmtTime, plainDecision, plainSigned, rawTxCommand, shortHash } from "./views.js";

const FIRST = 3; // the newest earlier decisions shown before anyone asks for more
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
  const rate = fmtSignedPct(policy.rateBps);
  if (policy.lastSetEpoch === null) return { cls: "warn", text: `The Chair has not set a rate yet. The rate in effect is ${rate}.` };
  if (policy.lastSetEpoch === policy.epoch) return { cls: "ok", text: `The Chair has decided in the current meeting, ${policy.epoch}.` };
  const missed = policy.epoch - policy.lastSetEpoch - 1;
  if (missed === 0) return { cls: "ok", text: `No decision yet in meeting ${policy.epoch}; the last was in meeting ${policy.lastSetEpoch}. The rate in effect is ${rate}.` };
  const moved = latest !== undefined && latest.rateBps === policy.rateBps ? `the rate stays at ${rate}` : latest === undefined ? `the rate in effect is ${rate}` : `the rate has decayed to ${rate}`;
  return { cls: "warn", text: `No decision for ${plural(missed, "meeting")}; ${moved}. The last decision was in meeting ${policy.lastSetEpoch}.` };
}

const MARKS = {
  verified: { cls: "ok", mark: "✓", short: "Verified", long: "The SHA-256 of this text, computed in your browser, equals the reasoning_hash on chain." },
  mismatch: { cls: "bad", mark: "✗", short: "Mismatch", long: "The SHA-256 of this text does not equal the reasoning_hash on chain. Do not trust this text." },
  unchecked: { cls: "warn", mark: "!", short: "Not checked", long: "This browser cannot compute SHA-256 on this page (it needs a secure context such as https), so the text was not checked." },
  absent: { cls: "none", mark: "-", short: "No text", long: null },
  // A saved copy's text and hash both come from this browser's storage: nothing was read from the chain on this load, so the check proves consistency, not what the chain says.
  kept: { cls: "none", mark: "•", short: "Matches the saved hash", long: "The SHA-256 of this text, computed in your browser, equals the reasoning_hash saved with it. Both come from this browser's saved copy, not from the chain on this load." },
};
const KIND = { llm: "an AI model", rule: "a rule-based chair" };

// Every agent text opens with lines of boilerplate: "$CHAIR decision, epoch N, chair X.", "Rate in effect R; decision D." and, from the week the Chair's choice became its own, the line that sets the formula's number beside it.
// They are shown as small metadata; the sentences after them are the minutes. The check still runs on the whole, exact text.
// When the AI chair failed, a line between the first two says so: kept as metadata too, and the page says it again in plain words above the minutes.
const HEADER = /^\$CHAIR decision, epoch \d+, chair .+\.$/;
const RATE = /^Rate in effect .+ bps; decision .+ bps\.$/;
/** The line the agent wrote until the second week: "Chair <name> failed (<reason>). The rule chair decided instead. The Chair has no comment." Recorded on chain, so it stays readable. */
const FALLBACK_OLD = /^Chair .+ failed \((timeout|refusal|malformed|error)\)\. The rule chair decided instead\. The Chair has no comment\.$/;
/** The line the agent writes now (chair-agent decide.ts `FALLBACK_WHY`). */
const FALLBACK_NEW = /^The AI chair \(.+\) (.{1,60}), so the rule chair, the Chair's built-in fallback, decided this meeting\.$/;
/**
 * The line that sets the formula's number beside the Chair's (chair-agent choice.ts `choiceLine`; chair-agent/test/choice.test.ts runs `parseChoice` over every
 * form it writes). The reasons are the agent's own fixed clauses, so the page accepts exactly those and nothing a text merely resembles.
 */
const DOES = "(?:printing \\d+\\.\\d\\d% a day|burning \\d+\\.\\d\\d% of every transfer|neither printing nor burning)";
const BECAUSE = [
  "fewer than half of all coins are staked",
  "more than half of all coins are staked",
  "supply has grown since the Chair's last decision",
  "supply has shrunk since the Chair's last decision",
  "the Chair prefers to hold the rate steady",
  "the Chair prefers to move the rate by less than the formula does",
  "the Chair prefers to move the rate by more than the formula does",
].join("|");
const CHOICE = new RegExp(
  `^The formula suggested (?<formula>${DOES})\\. (?:The rule chair (?<rule>applied|asked for) it\\.|The Chair agreed: (?<agreed>${BECAUSE})\\.|The Chair (?<verb>chose|asked for) (?<chosen>${DOES}): (?<because>${BECAUSE})\\.)$`,
);

/** The signed rate in bps that a phrase of the line stands for: "printing 0.12% a day" is 12, "burning 0.10% of every transfer" is -10. */
const doesBps = (phrase) => {
  const m = /(\d+)\.(\d\d)%/.exec(phrase);
  return m === null ? 0 : (phrase.startsWith("burning") ? -1 : 1) * (Number(m[1]) * 100 + Number(m[2]));
};
const sentence = (clause) => `${clause[0].toUpperCase()}${clause.slice(1)}`;

/**
 * A choice line read back: `kind` is "rule" (the rule chair applied the formula), "agreed" or "chose", or, when the contract's window moved the rate after the
 * choice, "rule-asked" or "asked" (what was asked for is not what was set); `formula` and `chosen` are rates in bps (equal unless the Chair chose or asked for another);
 * `why` is the reason as a sentence, "" for the rule chair. Null when the line is not exactly one of the agent's forms.
 */
export function parseChoice(line) {
  const g = CHOICE.exec(line)?.groups;
  if (g === undefined) return null;
  const formula = doesBps(g.formula);
  if (g.chosen !== undefined) return { kind: g.verb === "chose" ? "chose" : "asked", formula, chosen: doesBps(g.chosen), why: `${sentence(g.because)}.` };
  if (g.agreed !== undefined) return { kind: "agreed", formula, chosen: formula, why: `${sentence(g.agreed)}.` };
  return { kind: g.rule === "applied" ? "rule" : "rule-asked", formula, chosen: formula, why: "" };
}

/** The choice line when the rate the chain set agrees with it: a Chair that chose, agreed or applied the formula set that rate; one that was clamped asked for another. Else null: the text and the chain disagree, so the row is not shown. */
export function choiceMatching(choice, setBps) {
  if (choice === null) return null;
  const asked = choice.kind === "asked" || choice.kind === "rule-asked";
  return (choice.chosen === setBps) === !asked ? choice : null;
}

const OLD_WHY = { timeout: "did not answer in time", refusal: "declined to answer", malformed: "gave an answer the Chair could not use", error: "ran into an error" };

/** The plain sentence for a fallback line, or null when the line is not one. */
function fallbackSentence(line) {
  const old = FALLBACK_OLD.exec(line);
  const why = old ? OLD_WHY[old[1]] : FALLBACK_NEW.exec(line)?.[1];
  return why === undefined ? null : `The AI chair ${why}, so the Chair's built-in fallback rule decided this meeting.`;
}

/** `{meta, prose, fallback}`: the leading boilerplate lines, the rest, and the plain sentence for a fallback line if there is one. A text that is nothing but boilerplate is all prose. */
export function splitMinutes(text) {
  const lines = text.split("\n");
  let n = 0;
  let fallback = null;
  if (HEADER.test(lines[0] ?? "")) {
    n = 1;
    fallback = fallbackSentence(lines[n] ?? "");
    if (fallback !== null) n++;
    if (RATE.test(lines[n] ?? "")) {
      n++;
      if (CHOICE.test(lines[n] ?? "")) n++;
    }
  }
  const prose = lines.slice(n).join("\n").trim();
  return prose === "" ? { meta: [], prose: text, fallback: null } : { meta: lines.slice(0, n), prose, fallback };
}

/**
 * The fixed closing lines of the book (chair-agent `CLOSING` in rule-chair.ts, and the press line in remark.ts `BOOK_CLOSINGS`). The page
 * mirrors them to tell a closing sentence the Chair wrote itself from one it was given; web/test/minutes.test.mjs fails when the two lists drift.
 */
export const BOOK_CLOSINGS = [
  "The Chair calls this leadership.",
  "The Chair files no objection.",
  "The Chair thanks itself for its service.",
  "The motion carries unanimously.",
  "The Chair asks that this be recorded.",
  "The Chair has no further comment.",
  "The Chair will not be taking questions.",
];
/** The AI chair's name in the header line: its label from the agent (`llm:<model>` or `local:<model>`); the rule chair's is `rule-v1`. */
const AI_HEADER = /^\$CHAIR decision, epoch \d+, chair (?:llm|local):/;
/** The lines the agent adds after the Chair's statement: the epoch rolled over, the rate was clamped, the press section (decide.ts, press-section.ts). */
const AFTER_STATEMENT = /^(?:The epoch rolled over while the Chair was deliberating\.|The Chair asked for -?\d+ bps; the contract accepts |The contract accepts -?\d+\.\.-?\d+ bps here, so |The press (?:asked \d+ questions? since the last meeting|has \d+ questions? waiting)\.)/;

/**
 * `{head, own, tail}` with `head + own + tail` equal to the minutes' prose, when an AI chair's statement ends in a sentence that is not a line of the
 * book (so the Chair wrote it) and `own` is that sentence; else null. `tail` is whatever the agent added after the statement. Old texts, the rule chair's and fallbacks give null.
 */
export function splitClosing(text) {
  const { meta, prose } = splitMinutes(text);
  if (!AI_HEADER.test(meta[0] ?? "")) return null;
  const lines = prose.split("\n");
  const cut = lines.findIndex((line) => AFTER_STATEMENT.test(line));
  const statement = (cut < 0 ? lines : lines.slice(0, cut)).join("\n").trimEnd();
  const last = /[^.?!]*[.?!]$/.exec(statement)?.[0];
  const own = last?.trim();
  if (own === undefined || own === "" || BOOK_CLOSINGS.includes(own)) return null;
  const start = statement.length - last.length + (last.length - last.trimStart().length);
  return { head: prose.slice(0, start), own, tail: prose.slice(start + own.length) };
}

/** The closing sentence the Chair wrote itself, or null. */
export const ownClosing = (text) => splitClosing(text)?.own ?? null;

const move = (d) => {
  const delta = d.rateBps - d.previousRateBps;
  return delta === 0 ? `unchanged from ${fmtSignedPct(d.previousRateBps)}` : `${delta > 0 ? "up" : "down"} ${fmtPct(delta)} from ${fmtSignedPct(d.previousRateBps)}`;
};

/** A rate in the page's own words, with what it is measured over: "+0.29% a day". The Chair's header line beside it says "Rate in effect 29 bps" and is left as the chain has it. */
const rateLabel = (bps, unit = "each round") => `${fmtSignedPct(bps)}${bps > 0 ? ` ${unit}` : bps < 0 ? " of every transfer" : ""}`;

/** What a rate does, in the contract's terms (SPEC "Rollover"). */
const effect = (bps, unit = "each round") => (bps > 0 ? `Mints ${fmtPct(bps)} of supply ${unit} for stakers.` : bps < 0 ? `Burns ${fmtPct(bps)} of every transfer.` : "Nothing minted, nothing burned.");

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

/** The page's own plain line is only for a decision whose text is not already plain: no text, or a text still in basis points and epochs. */
const needsPlain = (p) => !p.rec || /basis points|bps|epoch/i.test(p.prose);

/**
 * The minutes as a quote. When the Chair wrote its closing sentence, that sentence is its own element with a plain label, inside the same quote, so the
 * text reads and copies as the one the hash covers (the label is not selectable). Only for a text that checked out and was not forced by a visitor through the press desk.
 */
function lead(doc, prose, closing) {
  if (closing === null) return h(doc, "blockquote", { class: "reasoning", lang: "en" }, prose);
  return h(doc, "blockquote", { class: "reasoning has-own", lang: "en" }, closing.head || null, h(doc, "span", { class: "m-own-line" }, closing.own), h(doc, "span", { class: "m-own-k" }, "Written by the AI this meeting"), closing.tail || null);
}

/** A rate for the choice row: "+0.12% a day", and in words when it is none. */
const choiceRate = (bps, unit) => (bps === 0 ? "no printing or burning" : rateLabel(bps, unit));

/** The row under the rate that sets the formula's number beside the Chair's, then the reason: "Formula suggested +0.12% a day · Chair chose +0.15% a day". */
function choiceRow(doc, c, ctx) {
  const said = { rule: "Rule chair applied it", agreed: "Chair agreed" };
  const gave = { chose: "Chair chose ", asked: "Chair asked for ", "rule-asked": "Rule chair asked for " };
  return h(doc, "span", { class: "rate-choice" },
    h(doc, "span", { class: "rc-line" }, "Formula suggested ", h(doc, "strong", {}, choiceRate(c.formula, ctx.unit)), " · ", c.kind in gave ? [gave[c.kind], h(doc, "strong", {}, choiceRate(c.chosen, ctx.unit))] : said[c.kind]),
    c.why === "" ? null : h(doc, "span", { class: "rc-why" }, c.why),
  );
}

/** The pieces of one decision: its state, the prose to lead with, the boilerplate as metadata, and the notes that belong with the proof. `saved` is a decision that was not read from the chain on this load. */
function parts(doc, d, ctx, saved = false) {
  const rec = ctx.resolved.get(d.tx);
  const state = !rec ? "absent" : saved && rec.verdict === "verified" ? "kept" : rec.verdict;
  if (!rec) {
    const lead = h(doc, "p", { class: "m-absent" }, ctx.texts === null ? "The bundled reasoning texts could not be loaded, so no text is shown for this decision." : "no reasoning text for this decision: its transaction carries none and none was saved");
    return { state, rec, lead, fallback: null, choice: null, prose: "", meta: null, notes: [] };
  }
  const shown = safeLines(rec.text);
  const { meta, prose, fallback } = splitMinutes(shown);
  // Only a text that hashed to the chain's and that the chair wrote itself is read for what the Chair wrote: a visitor can force any text through the press desk.
  const trusted = (state === "verified" || state === "kept") && !d.byVisitor;
  const src = rec.source && /^[\w.-]+$/.test(rec.source) && ctx.repoBase ? h(doc, "a", { href: `${ctx.repoBase}/docs/${rec.source}`, rel: "noopener noreferrer", target: "_blank" }, `docs/${rec.source}`) : null;
  return {
    state,
    rec,
    prose,
    fallback: fallback === null ? null : h(doc, "p", { class: "plain-line m-fallback" }, fallback),
    choice: trusted ? choiceMatching(parseChoice(meta.at(-1) ?? ""), d.rateBps) : null,
    lead: lead(doc, prose, trusted ? splitClosing(shown) : null),
    meta: meta.length === 0 && !d.byVisitor ? null : h(doc, "p", { class: "m-meta" }, d.byVisitor ? h(doc, "strong", { class: "visitor-tag" }, "Forced by a visitor through the press desk, not decided by the AI chair: the chair account signed it. ") : null, meta.map((line) => h(doc, "span", {}, line))),
    notes: [
      h(doc, "p", { class: `m-check ${MARKS[state].cls}` }, h(doc, "strong", {}, `${MARKS[state].mark} ${MARKS[state].short}.`), ` ${MARKS[state].long}`),
      shown !== rec.text ? h(doc, "p", { class: "note" }, "Some characters in this text are not printable and are shown as \\u{...} escapes. The check above ran on the exact text.") : null,
      rec.onChain ? h(doc, "p", { class: "note" }, "The text was read from the arguments of the transaction below.") : null,
      src ? h(doc, "p", { class: "note" }, "The text was recorded when the chair ran: ", src, ".") : null,
    ],
  };
}

const HOW_SAVED = "Your browser computed the SHA-256 of the exact text above and compared it with the reasoning_hash saved with it. The text and the hash were read from the chain on an earlier visit and kept in this browser; neither was read from the chain on this load. A match shows the saved copy is intact. It does not show what the chain says now.";
const HOW = "Your browser computed the SHA-256 of the exact text above and compared it with the reasoning_hash the contract logged for this decision. A match shows the text was not edited after the decision. It does not show the Chair was right, or that an AI wrote the text: the contract stores only the hash the chair sends.";

/** The mark's words: what was checked, and where. A recorded sandbox run is never called testnet. */
const verdictLabel = (state, ctx) => (state === "verified" ? (ctx.network ? `Verified on NEAR ${safeText(ctx.network, 12)}` : "Verified against the recorded sandbox run") : MARKS[state].short);

/**
 * A decision as the page's pull-quote: the prose large, the epoch, the rate as a percent with bps second, and the proof folded behind the mark.
 * `note` is a line of status under the rate. `saved` is a decision from this browser's saved copy, not read just now: it is never called the latest.
 */
function heroCard(doc, d, ctx, { note = null, saved = false } = {}) {
  const p = parts(doc, d, ctx, saved);
  const title = saved ? "Saved minutes of the Committee of One" : "Latest minutes of the Committee of One";
  return h(doc, "figure", { class: `minutes-paper ${p.state}`, "aria-label": `${saved ? "Saved" : "Latest"} minutes, meeting ${d.epoch}` },
    svg(doc, "svg", { class: "watermark", "aria-hidden": "true" }, svg(doc, "use", { href: "#seal" })),
    h(doc, "p", { class: "paper-head" }, h(doc, "span", {}, title), h(doc, "span", { class: "paper-epoch", title: `Epoch ${d.epoch}` }, `Meeting ${d.epoch}`)),
    p.fallback,
    needsPlain(p) ? [h(doc, "p", { class: "plain-line" }, plainDecision(d.rateBps, d.previousRateBps, ctx.unit)), h(doc, "p", { class: "said-k" }, "In the Chair's words")] : null,
    p.lead,
    h(doc, "figcaption", { class: "paper-rate" },
      h(doc, "span", { class: "rate-big" }, fmtSignedPct(d.rateBps)),
      h(doc, "span", { class: "rate-bps" }, fmtRate(d.rateBps)),
      h(doc, "span", { class: "rate-effect" }, effect(d.rateBps, ctx.unit)),
      h(doc, "span", { class: "rate-prev" }, `Before: ${plainSigned(d.previousRateBps)}.`),
      p.choice === null ? null : choiceRow(doc, p.choice, ctx),
    ),
    note ? h(doc, "p", { class: "m-status warn" }, note) : null,
    h(doc, "details", { class: `seal ${p.state}` },
      h(doc, "summary", {}, svg(doc, "svg", { class: "stamp", "aria-hidden": "true" }, svg(doc, "use", { href: "#seal" })), pill(doc, p.state, verdictLabel(p.state, ctx))),
      h(doc, "div", { class: "seal-body" },
        p.meta,
        p.rec ? h(doc, "p", { class: "note" }, saved ? HOW_SAVED : HOW) : null,
        who(doc, d, p.rec),
        p.notes,
        proof(doc, d, ctx),
      ),
    ),
  );
}

/** What to say over a saved decision: where it comes from, and what the chain itself says about whether a newer one exists. */
function savedNote(policy, d) {
  const why = "Read from this browser's saved copy because the transaction index is not answering.";
  if (policy.lastSetEpoch === d.epoch) return `${why} The chain confirms this was the last decision.`;
  return `${why} It may not be the newest decision${policy.lastSetEpoch === null ? "" : `: the chain says the last one was in meeting ${policy.lastSetEpoch}`}.`;
}

/** The hero when no decision can be shown at all: only what the chain's own views say, in a sentence. The numbers are the chain's, never a guess. */
function chainOnly(doc, d, ctx) {
  const { policy } = d;
  return h(doc, "p", { class: "empty hero-empty" }, h(doc, "span", {}, "The Chair's minutes could not be read just now. The chain itself says the rate in force is ", rateLabel(policy.rateBps, ctx.unit), ` (meeting ${policy.epoch}) and that `, h(doc, "span", { class: "acct" }, showAccount(policy.chair)), " is the Chair. See the status under the log."));
}

/**
 * `d` is `loadLog`'s result; `ctx` as for `renderMinutes`. Fills the hero's slot, and never leaves it empty: the latest decision, else (index not
 * readable) the newest one this browser saved, labelled as such, else what the chain's views say.
 */
export function renderHero(doc, host, d, ctx) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const [latest] = d.decisions;
  if (latest !== undefined) {
    const s = silence(d.policy, latest);
    return host.append(heroCard(doc, latest, ctx, { note: s.cls === "warn" ? s.text : null }));
  }
  if (d.status !== "incomplete") return host.append(h(doc, "p", { class: "empty hero-empty" }, "No decision has been recorded on chain yet."));
  const [saved] = d.remembered;
  host.append(saved === undefined ? chainOnly(doc, d, ctx) : heroCard(doc, saved, ctx, { note: savedNote(d.policy, saved), saved: true }));
}

function card(doc, d, ctx) {
  const p = parts(doc, d, ctx);
  return h(doc, "article", { class: `minute card ${p.state}` },
    p.fallback,
    needsPlain(p) ? h(doc, "p", { class: "plain-line" }, plainDecision(d.rateBps, d.previousRateBps, ctx.unit)) : null,
    p.lead,
    h(doc, "p", { class: "m-line" },
      h(doc, "strong", { title: `Epoch ${d.epoch}` }, `Meeting ${d.epoch}`),
      h(doc, "span", {}, `${rateLabel(d.rateBps, ctx.unit)} (${fmtRate(d.rateBps)}), ${move(d)}`),
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

/** The earlier decisions as cards, newest first (the latest is the hero). `ctx` is `{texts, resolved, explorer, indexerUrl, repoBase, network, unit}`: `indexerUrl` the transactions index, null on a recorded run; `texts` the bundled texts or null, `resolved` from `resolveTexts`. */
export function renderMinutes(doc, host, d, ctx) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const [latest, ...older] = d.decisions;
  const s = silence(d.policy, latest);
  host.append(h(doc, "p", { class: `m-status ${s.cls}`, role: "status" }, s.text));
  if (d.status === "incomplete") host.append(h(doc, "p", { class: "empty" }, "The decisions come from the transaction index, which could not be read. See the status under the log."));
  else if (latest === undefined) host.append(h(doc, "p", { class: "empty" }, "No decision has been recorded on chain yet."));
  if (older.length > 0) host.append(...cards(doc, older, ctx));
}
