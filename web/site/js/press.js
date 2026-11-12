// The press conference: a visitor puts one question to the Chair, reads the answer, then watches it enter the on-chain minutes.
// The press desk (POST /ask, GET /record) is a separate service behind a quick tunnel whose address changes on every restart, so the page
// finds it through a small discovery document (config.pressDiscoveryUrl, a gist file). The raw file is served with `cache-control: max-age=300` and
// lags a restart by minutes even with a cache-busting query, so the page reads it through the GitHub API (config.pressDiscoveryApiUrl, about a
// minute behind at worst) when it may, and the raw file otherwise. Both the document and the desk are untrusted: the address is
// checked strictly before use and everything the desk returns reaches the page through `textContent` only. The record never holds question text, so a visitor's own questions stay in this browser (localStorage).
import { clear, h } from "./dom.js";
import { isTxHash, safeLines, safeText } from "./text.js";
import { fmtTime } from "./views.js";

export const MAX_QUESTION = 140;
export const OFFLINE = "The Chair is not taking questions at this time.";
// What the page says when it does not know whether the desk answered: the desk may still answer and enter it, and the record below then shows it.
const LATE = "The desk did not answer in time. If it does, the answer will appear in the record below.";
export const RETRY_NOTE = "This page keeps checking by itself and opens the moment the desk is back.";
export const DESK_NOTE = "The press desk runs on my workstation, not on a hosted server, so it is closed whenever that machine is off.";
export const POLL_MS = 20_000;
/** The GitHub API lets one address read 60 times an hour: one page reads it at most this often (40 an hour). */
export const API_EVERY_MS = 90_000;
const DOC_CAP = 2_000; // bytes of discovery document the page will parse
/** An address that did not answer is left alone for POLL_MS, then twice as long after each miss, up to this. */
const REST_MAX_MS = 160_000;
const STALE_MS = 15 * 60_000; // an answer asked longer ago than this stops being polled for
const KEEP = 20; // own questions remembered
const FETCH_RECORD = 50; // entries asked of the desk, so a visitor's own entry stays in the window on a busy day
const SHOW_RECORD = 10;
const FIRST_RECORD = 3; // answers shown before "Show more"
const STORE_KEY = "chair-press-questions";
const ANSWER_CAP = 1200;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** The desk's origin when `raw` is exactly a quick-tunnel address (https, a name under trycloudflare.com, no credentials, port, path or query), else "". */
export function deskBase(raw) {
  if (typeof raw !== "string" || raw.length > 200 || /[?#\\\s]/.test(raw)) return "";
  let u;
  try {
    u = new URL(raw);
  } catch {
    return "";
  }
  const named = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.trycloudflare\.com$/.test(u.hostname);
  return u.protocol === "https:" && named && !u.username && !u.password && u.port === "" && u.pathname === "/" ? u.origin : "";
}

const idOf = (v) => (typeof v === "string" && /^[\w.:-]{1,80}$/.test(v) ? v : Number.isSafeInteger(v) ? String(v) : null);

/** The desk's reply to POST /ask, or null when it is not the documented shape. */
function parseAnswer(j) {
  if (!isObj(j) || j.status !== "answered" || typeof j.answer !== "string" || typeof j.question_hash !== "string" || !Number.isFinite(j.asked_at_ms)) return null;
  const id = idOf(j.id);
  return id === null ? null : { id, answer: j.answer, hash: j.question_hash, at: j.asked_at_ms };
}

/** One entry of GET /record, or null. A tx_hash that is not a transaction hash counts as none: nothing is claimed as entered. */
function parseEntry(e) {
  if (!isObj(e) || typeof e.answer !== "string" || typeof e.question_hash !== "string" || !Number.isFinite(e.asked_at_ms)) return null;
  const id = idOf(e.id);
  if (id === null) return null;
  return { id, answer: e.answer, hash: e.question_hash, at: e.asked_at_ms, epoch: Number.isSafeInteger(e.epoch) && e.epoch >= 0 ? e.epoch : null, tx: isTxHash(e.tx_hash) ? e.tx_hash : null };
}

/** The text of a decision that the chain's own hash vouches for, or null: the press section of the minutes is only read from verified text. */
const verifiedText = (resolved, tx) => {
  const r = resolved?.get(tx);
  return r?.verdict === "verified" && typeof r.text === "string" ? r.text : null;
};
const CHAIN_LINE = /^A member of the press asked a question \(([0-9a-f]{12})\)\. The Chair replied: (.+)$/;

/**
 * The press answers the chain holds, newest first, in the shape of the desk's record: each rides in the minutes of a decision (SPEC "set_policy",
 * chair-agent press-section.ts), one line apiece. `decisions` and `resolved` are the minutes' (decisions.js, minutes.js `resolveTexts`); only a text
 * whose SHA-256 equals the hash on chain is read, so what shows here is text the chain's hash fixes, not what an index says.
 */
export function pressFromChain(decisions, resolved) {
  const out = [];
  for (const d of decisions ?? []) {
    const text = verifiedText(resolved, d.tx);
    if (text === null) continue;
    text.split("\n").forEach((line, i) => {
      const m = CHAIN_LINE.exec(line);
      if (m) out.push({ id: `chain-${d.tx}-${i}`, answer: m[2], hash: m[1], at: Number(d.tsMs), epoch: Number.isSafeInteger(d.epoch) ? d.epoch : null, tx: isTxHash(d.tx) ? d.tx : null });
    });
  }
  return out;
}

const validOwn = (e) => isObj(e) && idOf(e.id) !== null && typeof e.q === "string" && typeof e.a === "string" && Number.isFinite(e.t);

function loadOwn(storage) {
  try {
    const v = JSON.parse(storage?.getItem(STORE_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter(validOwn).slice(0, KEEP) : [];
  } catch {
    return [];
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // blocked storage: the questions last for this page view
  }
}

const answerText = (s) => safeLines(s.slice(0, ANSWER_CAP));

/**
 * Builds the panel into `host` and returns its controller. `fetchImpl`, `storage`, `timers` and `now` are the boundaries, injectable for tests.
 * An empty `discoveryUrl` renders the offline state and never touches the network. `discoveryApiUrl` (optional) is the same document through the
 * GitHub gist API, `https://api.github.com/gists/<id>`; the file read from it is the one the last segment of `discoveryUrl` names.
 */
export function createPress(doc, host, { discoveryUrl = "", discoveryApiUrl = "", explorer = null, fetchImpl = globalThis.fetch?.bind(globalThis), storage = defaultStorage(), timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }, now = Date.now } = {}) {
  let desk = ""; // the validated origin of the press desk, "" while none is known
  let lastDiscovery = -Infinity;
  let discovering = null;
  let docAt = -1; // updated_at_ms of the newest discovery document taken: an older one (a lagging copy) never replaces it
  let apiAfter = -Infinity; // the API is not read before this time
  let resting = { url: "", wait: 0, until: 0 }; // the address that last failed to answer, and until when the page leaves it alone
  let checking = discoveryUrl !== "";
  let online = false; // the desk answered the last request about the record
  let open = false; // and said it is taking questions
  let loaded = false; // the record has been read at least once
  let entries = [];
  let chainEntries = []; // the same, read from the chain: what shows while the desk cannot be reached
  let own = loadOwn(storage);
  let busy = false;
  let message = null;
  let timer = null;
  let inflight = null;
  let announced = "";
  let recordAll = false; // the visitor asked for the rest of the record

  const input = h(doc, "textarea", { id: "press-q", name: "question", rows: 3, maxlength: MAX_QUESTION, required: true, autocomplete: "off", placeholder: "Does the Chair intend to remain the Chair?" });
  const counter = h(doc, "span", { class: "count", "aria-hidden": "true" });
  const button = h(doc, "button", { type: "submit", class: "ask" }, "Ask the Chair");
  const note = h(doc, "p", { class: "form-note", role: "status" });
  const form = h(doc, "form", { class: "ask-form", novalidate: true },
    h(doc, "label", { for: "press-q" }, `Your question for the Chair, ${MAX_QUESTION} characters at most`),
    input,
    h(doc, "div", { class: "ask-row" }, counter, button),
    note,
  );
  const closed = h(doc, "div", { class: "closed" });
  const exchange = h(doc, "div", { class: "exchange-slot" });
  const record = h(doc, "div", { class: "record" });
  const live = h(doc, "p", { class: "sr-only", role: "status" });
  const left = h(doc, "div", { class: "press-col" }, closed, form, exchange);
  host.append(h(doc, "div", { class: "press-grid" }, left, record), live);

  const accepting = () => online && open;
  const entryOf = (e) => entries.find((x) => x.id === e.id);
  /** "entered" once the record shows a transaction for it, "outside" when the record was read and no longer lists it, else "waiting". */
  const stateOf = (e) => {
    const rec = entryOf(e);
    if (rec?.tx) return { state: "entered", rec };
    if (!rec && loaded && online && now() - e.t > STALE_MS) return { state: "outside", rec };
    return { state: "waiting", rec };
  };
  const pending = () => own.some((e) => stateOf(e).state === "waiting" && now() - e.t <= STALE_MS);

  function link(tx, text) {
    return explorer && isTxHash(tx) ? h(doc, "a", { href: `${explorer}/txns/${tx}`, rel: "noopener noreferrer", target: "_blank" }, text) : text;
  }

  function status(e) {
    const { state, rec } = stateOf(e);
    if (state === "entered") return { cls: "entered", nodes: [rec.epoch === null ? "Entered into the record. " : `Entered into the record, meeting ${rec.epoch}. `, link(rec.tx, "See the transaction")], text: `Entered into the record${rec.epoch === null ? "" : `, meeting ${rec.epoch}`}` };
    if (state === "outside") return { cls: "waiting", nodes: ["No longer among the latest entries of the record."], text: "No longer among the latest entries of the record" };
    return { cls: "waiting", nodes: ["Awaiting entry into the minutes"], text: "Awaiting entry into the minutes" };
  }

  function renderForm() {
    const len = input.value?.length ?? 0;
    counter.textContent = `${len} / ${MAX_QUESTION}`;
    const off = !accepting() || busy;
    input.disabled = off;
    button.disabled = off;
    button.textContent = busy ? "Asking…" : "Ask the Chair";
    form.classList.toggle("off", !accepting());
    note.textContent = message ?? "";
  }

  function renderClosed() {
    clear(closed);
    closed.hidden = accepting();
    if (accepting()) return;
    if (checking) return closed.append(h(doc, "p", { class: "closed-line" }, "Checking whether the press desk is open…"));
    const again = discoveryUrl === "" ? null : h(doc, "button", { type: "button", class: "chip" }, "Check again");
    again?.addEventListener("click", () => { checking = true; lastDiscovery = -Infinity; resting = { url: "", wait: 0, until: 0 }; render(); refresh(); });
    closed.append(h(doc, "p", { class: "closed-line" }, OFFLINE), h(doc, "p", { class: "note" }, discoveryUrl === "" ? DESK_NOTE : `${DESK_NOTE} ${RETRY_NOTE}`));
    if (again) closed.append(again);
  }

  function renderExchange() {
    clear(exchange);
    const e = own[0];
    if (!e) return;
    const s = status(e);
    exchange.append(h(doc, "article", { class: "exchange", "aria-label": "Your question and the Chair's answer" },
      h(doc, "p", { class: "asked" }, h(doc, "span", { class: "k" }, "You asked"), " ", safeText(e.q, MAX_QUESTION + 20)),
      h(doc, "blockquote", { class: "answer", lang: "en" }, answerText(e.a)),
      h(doc, "p", { class: `entry ${s.cls}` }, h(doc, "span", { class: "dot", "aria-hidden": "true" }), s.nodes),
    ));
    if (s.text !== announced) live.textContent = announced = s.text;
  }

  function renderRecord() {
    clear(record);
    const fromChain = !online;
    const source = fromChain ? chainEntries : entries;
    if (!fromChain && !loaded && entries.length === 0) return;
    if (fromChain && source.length === 0) return;
    const shown = source.filter((x) => x.id !== own[0]?.id).slice(0, SHOW_RECORD);
    record.append(h(doc, "h3", {}, "The public record"), h(doc, "p", { class: "note" }, fromChain
      ? "The press desk cannot be reached, so these are the answers entered in the Chair's recent on-chain minutes, read from the chain and checked against each decision's hash. Answers not yet entered are not shown."
      : "Answers only. Each is listed with the start of its question's hash: the record never holds the question. Questions you asked from this browser are marked \u201cYou asked\u201d, because this browser remembers them; your newest one is in the panel above, not in this list."));
    if (shown.length === 0) return record.append(h(doc, "p", { class: "empty" }, "No other answer has been entered into the record yet."));
    const rows = shown.map((x) => {
      const mine = own.find((e) => e.id === x.id);
      return h(doc, "li", { class: "rec" },
        mine ? h(doc, "p", { class: "asked" }, h(doc, "span", { class: "k" }, "You asked"), " ", safeText(mine.q, MAX_QUESTION + 20)) : null,
        h(doc, "blockquote", { class: "answer", lang: "en" }, answerText(x.answer)),
        h(doc, "p", { class: "rec-meta" },
          h(doc, "span", {}, "Question ", h(doc, "code", {}, safeText(x.hash.slice(0, 8), 8))),
          h(doc, "span", { class: x.tx ? "in" : "wait" }, x.tx ? link(x.tx, x.epoch === null ? "Entered" : `Meeting ${x.epoch}`) : "Awaiting entry into the minutes"),
          h(doc, "span", {}, fmtTime(x.at)),
        ),
      );
    });
    record.append(h(doc, "ol", { class: "rec-list" }, rows));
    if (shown.length > FIRST_RECORD && !recordAll) {
      rows.forEach((li, i) => (li.hidden = i >= FIRST_RECORD));
      const more = h(doc, "button", { type: "button", class: "chip more" }, `Show ${shown.length - FIRST_RECORD} more`);
      more.addEventListener("click", () => ((recordAll = true), renderRecord()));
      record.append(more);
    }
  }

  function render() {
    renderClosed();
    renderForm();
    renderExchange();
    renderRecord();
  }

  /** Polls while an own entry waits, and while the desk is shut or unreachable so that the panel comes back by itself. */
  function schedule() {
    if (timer !== null || discoveryUrl === "" || !(pending() || !accepting())) return;
    timer = timers.set(async () => {
      timer = null;
      if (doc.hidden !== true) await refresh();
      schedule();
    }, POLL_MS);
  }

  /** A GET of a discovery source, the parsed JSON; throws on any failure. */
  async function getJson(url) {
    const res = await fetchImpl(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`discovery answered ${res.status}`);
    return res.json();
  }
  /** The discovery document as the raw file serves it. A cache-busting query keeps the browser and the CDN from replaying an old copy, but the file itself can lag a restart by minutes. */
  const readRaw = () => getJson(`${discoveryUrl}${discoveryUrl.includes("?") ? "&" : "?"}t=${now()}`);
  /** The same document through the gist API, whose answers are cached for 60 s at most: the file's text, parsed. Throws when the file is not there whole. */
  async function readApi() {
    const file = new URL(discoveryUrl).pathname.split("/").pop();
    const j = await getJson(discoveryApiUrl);
    const f = isObj(j) && isObj(j.files) && Object.hasOwn(j.files, file) ? j.files[file] : null;
    if (!isObj(f) || f.truncated === true || typeof f.content !== "string" || f.content.length > DOC_CAP) throw new Error("the API did not return the file");
    return JSON.parse(f.content);
  }
  /** The newest copy of the document it can get: the API when it is allowed (each read costs part of the visitor's hourly allowance), else, or when that fails, the raw file. Null when neither answers. */
  async function readDocument() {
    if (discoveryApiUrl !== "" && now() >= apiAfter) {
      apiAfter = now() + API_EVERY_MS;
      try {
        return await readApi();
      } catch {
        // Throttled, down or not the shape: the raw file is the fallback.
      }
    }
    return readRaw().catch(() => null);
  }

  /** Reads the discovery document and keeps its address if it is a quick-tunnel one and the document is not older than the last one taken. An empty or hostile address means no desk; an unreadable document changes nothing. */
  function discover() {
    discovering ??= (async () => {
      lastDiscovery = now();
      try {
        const j = await readDocument();
        if (isObj(j) && typeof j.url === "string") {
          const at = Number.isFinite(j.updated_at_ms) ? j.updated_at_ms : 0;
          if (at >= docAt) {
            docAt = at;
            desk = deskBase(j.url);
          }
        }
      } finally {
        discovering = null;
      }
      return desk;
    })();
    return discovering;
  }

  const lookUp = (eager) => discovering ?? (eager || now() - lastDiscovery >= POLL_MS ? discover() : null);
  const isResting = (url) => url === resting.url && now() < resting.until;

  /** Whether `reply` came from the desk itself: below 500, its own 503, or a server error whose body is JSON with an `error` text (the faucet's 502). A tunnel's 502 or 524 page is none of these. */
  async function fromDesk(reply) {
    if (reply.status < 500 || reply.status === 503) return true;
    try {
      const j = await reply.clone().json();
      return isObj(j) && typeof j.error === "string";
    } catch {
      return false;
    }
  }

  /**
   * One try at `url`. A reply the desk did not send itself (see `fromDesk`) or no connection puts the address to rest, so a dead tunnel is
   * not asked again (and does not fill the console with failed requests) until its rest is over; each miss doubles the rest.
   */
  async function tryDesk(url, path, init) {
    if (url === resting.url) resting.until = now() + resting.wait; // this request is the probe: concurrent ones leave the address alone
    let reply = null;
    let failure = null;
    try {
      reply = await fetchImpl(url + path, init());
    } catch (err) {
      failure = err;
    }
    const answered = reply !== null && (await fromDesk(reply));
    if (answered && url === resting.url) resting = { url: "", wait: 0, until: 0 };
    if (!answered) {
      const wait = url === resting.url ? Math.min(resting.wait * 2, REST_MAX_MS) : POLL_MS;
      resting = { url, wait, until: now() + wait };
    }
    return { reply, failure, answered };
  }

  /**
   * A request to the desk. With no desk known it looks one up first (at most every POLL_MS); an address that did not answer is left alone while it rests,
   * and the document is read again meanwhile in case the desk has moved. When the desk does not connect, or its tunnel answers with a server error that is not the desk's own JSON, it looks
   * again once and retries only if the address changed. Anything else is the caller's to read. `eager` (a visitor's "Check again") ignores the rest.
   */
  async function call(path, init, eager = false) {
    if (eager) resting = { url: "", wait: 0, until: 0 };
    if (desk === "" || isResting(desk)) await lookUp(eager);
    if (desk === "") throw new Error("no press desk");
    if (isResting(desk)) throw new Error("press desk not answering");
    const tried = desk;
    const first = await tryDesk(tried, path, init);
    if (first.answered) return first.reply;
    await discover();
    if (desk !== "" && desk !== tried) {
      const second = await tryDesk(desk, path, init);
      if (second.failure) throw second.failure;
      return second.reply;
    }
    if (first.failure) throw first.failure;
    return first.reply;
  }

  /** Reads the record. Any failure, or a reply that is not the documented shape, means the desk is closed; the last good entries stay shown. */
  function refresh() {
    if (discoveryUrl === "") return Promise.resolve();
    inflight ??= (async () => {
      try {
        const res = await call(`/record?limit=${FETCH_RECORD}`, () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }));
        const j = res.ok ? await res.json() : null;
        if (!isObj(j) || !Array.isArray(j.entries) || typeof j.taking_questions !== "boolean") throw new Error("not the record");
        entries = j.entries.map(parseEntry).filter((x) => x !== null);
        open = j.taking_questions;
        online = true;
        loaded = true;
      } catch {
        online = false;
      } finally {
        checking = false;
        inflight = null;
        render();
      }
    })();
    return inflight;
  }

  /** The desk's own word for "the room is full, ask again shortly" (a 503 that is not a closed desk). */
  const isFull = (status, body) => status === 503 && isObj(body) && body.code === "press_full";
  const refuse = (status, body) => {
    if (status === 429) return "The Chair has taken enough questions for now. Ask again later.";
    if (isFull(status, body)) return "The press room is full. Ask again in a minute.";
    if (status === 400 && isObj(body) && typeof body.error === "string") return `The question was not accepted: ${safeText(body.error, 140)}`;
    if (status >= 500) return LATE; // a tunnel's 502 or 524 says nothing about whether the desk went on to answer
    return "The press desk did not take the question. Nothing was entered.";
  };

  async function ask(raw) {
    const q = String(raw ?? "").trim();
    if (busy || !accepting()) return;
    if (q === "") return void ((message = "Write a question first."), render());
    if (q.length > MAX_QUESTION) return void ((message = `Questions are ${MAX_QUESTION} characters at most.`), render());
    busy = true;
    message = "The Chair is considering the question. This can take a while.";
    render();
    try {
      const res = await call("/ask", () => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: q }), credentials: "omit", signal: AbortSignal.timeout(120_000) }));
      const body = await res.json().catch(() => null);
      const a = res.ok ? parseAnswer(body) : null;
      if (a) {
        own = [{ id: a.id, q, a: a.answer, t: a.at }, ...own.filter((e) => e.id !== a.id)].slice(0, KEEP);
        try {
          storage?.setItem(STORE_KEY, JSON.stringify(own));
        } catch {
          // Storage blocked or full: the exchange stays on the page for this view.
        }
        input.value = "";
        message = null;
        schedule();
      } else {
        message = res.ok ? "The press desk sent a reply this page cannot read. If the question was answered, the answer will appear in the record below." : refuse(res.status, body);
        if (res.status === 503 && !isFull(res.status, body)) online = false;
      }
    } catch {
      message = LATE;
      online = false;
    } finally {
      busy = false;
      render();
      schedule();
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    ask(input.value);
  });
  input.addEventListener("input", renderForm);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      form.requestSubmit();
    }
  });

  render();
  refresh().then(schedule);
  return {
    ask,
    /** The chain's press answers (`pressFromChain`), shown while the desk is out of reach. */
    setChain: (list) => {
      chainEntries = list;
      renderRecord();
    },
    /** A request to the press desk, finding it first (the overreach panel shares the desk). Throws when there is none. */
    request: call,
    refresh: () => refresh().then(schedule),
    stop: () => {
      if (timer !== null) timers.clear(timer);
      timer = null;
    },
    state: () => ({ desk, online, open, entries, own, pollScheduled: timer !== null, pending: pending() }),
    input,
  };
}
