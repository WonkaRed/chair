// "Make the Chair overreach": the visitor types a rate the contract must refuse, the press desk has the chair account send it to the testnet
// contract, and the page shows what the contract answered: its own words, the bound, the transaction, and a one-line `curl` that reads the same
// failure from a public RPC. The desk is the same untrusted, tunnelled service as the press conference (press.js finds it and hands over `request`).
// Everything it returns reaches the page through `textContent` only, and the only strings built into the command are checked first.
import { clear, h } from "./dom.js";
import { POLL_MS as DESK_POLL_MS } from "./press.js";
import { isAccountId, isTxHash, safeText, showAccount } from "./text.js";
import { humanReason, PROJECT_TEST_CALLS } from "./refusals.js";
import { askedRate, fmtRate, fmtTime, plainPct, shortHash } from "./views.js";

export const MAX_INPUT = 1_000_000;
export const PRESETS = [500, -9999];
export const POLL_MS = 2_000;
const GIVE_UP_MS = 4 * 60_000; // an attempt waits for at most one epoch, then a little
const LOST_AFTER = 4; // failed polls in a row before the page stops looking
const STATUSES = new Set(["waiting", "sending", "refused", "accepted", "within_mandate", "not_chair", "too_late", "unreadable", "unconfirmed"]);

export const DOWN = "The press desk is not reachable, so nothing can be sent from here right now. It runs on my workstation, not a hosted server, and is closed whenever that machine is off. This page keeps checking by itself and opens the moment the desk is back.";
const LEDE = "Type a rate beyond the Chair's limit of 2% a day (200 bps). The press desk has the real chair account send it to the contract on NEAR testnet, and the contract answers. Only rates beyond that limit are sent, because the contract refuses them whatever the Chair is doing. Nothing here is a mock-up: the refusal is a transaction you can open.";
/** How long a wait is, for a person: seconds under a minute and a half, else whole minutes. */
/** One refusal the project's README documents (a deliberate test: the launch chair asked for +201 bps), shown when the chain's own list cannot be read, so the stamp never goes missing. */
const KNOWN_TX = "Efagw855yoDeJXjNyui9Bt9d4JXfhisMoTm9JCPkHWjf";
const waitWords = (s) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} s`);
/** What the Chair says, per check that refused. These are fixed lines written for the page, not model output, and the page says so. */
const CHAIR_SAYS = {
  absolute: "The Chair thanks the contract for declining. The Chair had no intention of doing that. The Committee of One has met and finds that it was never in favour.",
  already_set: "The Chair had already decided this epoch, and the contract holds it to one decision. The Chair finds this a comfort, and would have declined your rate in any case.",
  other: "The Chair notes that the contract has declined. The Chair has no further comment, and would like that recorded.",
  accepted: "The Committee of One has noted its own surprise. The Chair would like it recorded that the rate is now what you asked for, within the mandate it never doubted.",
};

/** The checks a refusal can name (press-overreach.ts `classify`); anything else the desk sends is no known check. */
const HITS = new Set(["absolute", "already_set", "not_chair", "other"]);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The desk's reply to a started or polled attempt, or null when it is not the documented shape. */
export function parseAttempt(j) {
  if (!isObj(j) || !STATUSES.has(j.status)) return null;
  const out = { status: j.status, id: typeof j.id === "string" && /^[0-9a-f-]{36}$/.test(j.id) ? j.id : null, rate: Number.isSafeInteger(j.rate_bps) ? j.rate_bps : null, epoch: Number.isSafeInteger(j.epoch) ? j.epoch : null, nowMs: Number.isFinite(j.now_ms) ? j.now_ms : null, firesMs: Number.isFinite(j.fires_at_ms) ? j.fires_at_ms : null, line: typeof j.line === "string" ? safeText(j.line, 400) : null };
  out.tx = isTxHash(j.tx_hash) ? j.tx_hash : null;
  out.failure = typeof j.failure === "string" ? safeText(j.failure, 300) : null;
  out.hit = HITS.has(j.hit) ? j.hit : null;
  out.signer = isAccountId(j.signer) ? j.signer : null;
  const b = isObj(j.bound) ? j.bound : null;
  out.bound = b && b.kind === "absolute" && Number.isSafeInteger(b.lo) && Number.isSafeInteger(b.hi) ? { kind: "absolute", lo: b.lo, hi: b.hi } : null;
  return out;
}

/** What `hit` and the bound mean, in words, next to the contract's own text. */
export function boundText(a) {
  if (a.bound?.kind === "absolute") return `The absolute limit: the contract never allows a rate outside ${fmtRate(a.bound.lo)} to ${fmtRate(a.bound.hi)}.`;
  if (a.hit === "already_set") return "Not a bound on the rate: the contract allows one decision per epoch, and the Chair's own call reached it first, so it refused this one as already set. The absolute limit would have refused it too.";
  return null;
}

/** One line that fetches the transaction from a public RPC and prints the contract's own failure text. Only checked strings go in. */
export function curlCommand(rpcUrl, tx, signer) {
  let origin;
  try {
    const u = new URL(rpcUrl);
    origin = u.protocol === "https:" && !u.username && !u.password && /^[a-z0-9.-]+$/.test(u.hostname) ? u.origin : null;
  } catch {
    origin = null;
  }
  if (origin === null || !isTxHash(tx) || !isAccountId(signer)) return null;
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tx", params: { tx_hash: tx, sender_account_id: signer, wait_until: "FINAL" } });
  return `curl -s ${origin} -H 'content-type: application/json' -d '${body}' | grep -o 'Smart contract panicked[^"]*' | head -1`;
}

/**
 * Builds the panel into `host`. `request(path, init)` talks to the press desk and throws when there is none (press.js `request`). `refusals()` is the
 * chain's refusals (loadLog's `refusals`) for the desk-closed state. `fetchImpl`-level details live in `request`; `timers` and `now` are injectable for tests.
 */
export function createOverreach(doc, host, { request, explorer = null, rpcUrl = "", refusals = () => null, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }, now = Date.now, clipboard = globalThis.navigator?.clipboard } = {}) {
  let mode = "checking"; // checking | ready | down
  let busy = false;
  let message = null;
  const ownTx = new Set(); // the transactions of this page's own attempts: never shown as someone else's refusal
  let attempt = null; // the latest parsed reply of the desk for this visitor's attempt
  let asked = null; // the rate the visitor submitted
  let skew = 0; // desk clock minus this one, from the latest reply
  let pollTimer = null;
  let retryTimer = null;
  let deskTimer = null; // the next look at a desk that was out of reach
  let live = "";

  const input = h(doc, "input", { id: "overreach-rate", name: "rate", type: "text", inputmode: "numeric", autocomplete: "off", spellcheck: "false", maxlength: 8, placeholder: "500", value: "500", "aria-describedby": "overreach-hint" });
  const hint = h(doc, "p", { id: "overreach-hint", class: "note" });
  const presets = PRESETS.map((n) => h(doc, "button", { type: "button", class: "preset", "data-rate": n, "aria-pressed": "false" }, h(doc, "span", { class: "p-big" }, askedRate(n)), h(doc, "span", { class: "tag" }, fmtRate(n))));
  const button = h(doc, "button", { type: "submit", class: "ask" }, "Make the Chair overreach");
  const note = h(doc, "p", { class: "form-note", role: "status" });
  const form = h(doc, "form", { class: "ask-form overreach-form", novalidate: true },
    h(doc, "label", { for: "overreach-rate" }, "Pick a rate past the 2% a day limit"),
    h(doc, "div", { class: "or-presets" }, presets),
    h(doc, "div", { class: "or-row" }, h(doc, "span", { class: "or-or" }, "or your own, in hundredths of a percent:"), input),
    h(doc, "div", { class: "ask-row" }, h(doc, "span", { class: "or-who" }, "The real chair account sends it; the contract decides."), button),
    note,
  );
  const closed = h(doc, "div", { class: "closed" });
  const result = h(doc, "div", { class: "or-result", "aria-live": "polite" });
  const sr = h(doc, "p", { class: "sr-only", role: "status" });
  const how = h(doc, "details", { class: "fold or-how" }, h(doc, "summary", {}, "How this works, and its limits"), h(doc, "p", { class: "note" }, LEDE), hint);
  host.append(form, closed, result, sr, how);

  const current = () => refusals();
  /** The newest refusal on chain that is not one this page's visitor made. */
  const newestOther = () => (current()?.refusals ?? []).find((r) => !ownTx.has(r.tx));
  const unreadable = () => (current()?.status ?? "incomplete") === "incomplete";
  let limited = null; // the desk said "not now" (a cap): the wait it named, in seconds

  function renderHint() {
    const c = current();
    hint.textContent = c?.policy
      ? `The contract never allows a rate outside −200 to +200 bps (the rate in effect is ${fmtRate(c.policy.rateBps)} right now). The press desk sends only rates beyond that limit, which the contract refuses whatever the Chair is doing, one attempt at a time. A rate inside it is not sent: it could really change the token's rate. An attempt costs the chair account about one testnet gas fee, and each address may send a few an hour.`
      : "The contract never allows a rate outside −200 to +200 bps. The press desk sends only rates beyond that limit, which the contract refuses whatever the Chair is doing, one attempt at a time and a few an hour per address. A rate inside it is not sent.";
  }

  function renderForm() {
    const off = mode !== "ready" || busy;
    input.disabled = off;
    button.disabled = off;
    for (const p of presets) p.disabled = off;
    button.textContent = busy ? "Waiting for the contract…" : "Make the Chair overreach";
    form.classList.toggle("off", mode !== "ready");
    note.textContent = message ?? "";
    for (const p of presets) p.setAttribute("aria-pressed", String(input.value?.trim().replace(/^\+/, "") === p.getAttribute("data-rate")));
  }

  const txLink = (tx) => (explorer && isTxHash(tx) ? h(doc, "a", { href: `${explorer}/txns/${tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(tx)) : shortHash(String(tx)));

  /** The newest refusal the chain holds, shown as the stamp it is, so the page never ends on an error: what was tried, why, the transaction, and who really sent it. */
  function earlier(r, lead) {
    const who = r.byVisitor ? "It was forced by a visitor through the press desk: the chair account signed it, the AI chair did not choose it." : PROJECT_TEST_CALLS.has(r.tx) ? "A deliberate test call that I made." : `A refused call signed by ${showAccount(r.signer)}.`;
    return h(doc, "article", { class: "or-card earlier", "aria-label": "An earlier refusal from the chain" },
      h(doc, "p", { class: "or-lead" }, lead),
      h(doc, "p", { class: "or-stamp" }, "Refused by the contract"),
      h(doc, "p", { class: "or-plain" }, h(doc, "strong", {}, r.rateBps === null ? "An unreadable rate. " : `Asked for ${askedRate(r.rateBps)} (${fmtRate(r.rateBps)}). `), humanReason(r.reason) ?? safeText(r.reason, 160)),
      h(doc, "p", { class: "or-tx" }, txLink(r.tx), " ", fmtTime(r.tsMs)),
      h(doc, "p", { class: "note" }, "An earlier attempt, not yours. ", who));
  }

  /** The fixed fallback: not live data, an earlier recorded attempt, said as that. */
  function recorded(lead) {
    return h(doc, "article", { class: "or-card earlier", "aria-label": "An earlier recorded refusal" },
      h(doc, "p", { class: "or-lead" }, lead),
      h(doc, "p", { class: "or-stamp" }, "Refused by the contract"),
      h(doc, "p", { class: "or-plain" }, h(doc, "strong", {}, `Asked for ${askedRate(201)} (${fmtRate(201)}). `), "The limit is 2% a day, so the contract said no."),
      h(doc, "p", { class: "or-tx" }, txLink(KNOWN_TX)),
      h(doc, "p", { class: "note" }, "An earlier recorded attempt, not yours and not live: a deliberate test I made with the launch chair's account. The AI chair was not involved."));
  }

  function renderClosed() {
    clear(closed);
    closed.hidden = mode === "ready";
    if (mode === "checking") return void closed.append(h(doc, "p", { class: "closed-line" }, "Checking whether the press desk is open…"));
    if (mode !== "down") return;
    const [newest, ...list] = (current()?.refusals ?? []).slice(0, 3);
    closed.append(h(doc, "p", { class: "closed-line" }, "The Chair cannot be made to overreach just now."), h(doc, "p", { class: "note" }, DOWN));
    const again = h(doc, "button", { type: "button", class: "chip" }, "Check again");
    again.addEventListener("click", () => void check());
    if (newest === undefined) return closed.append(unreadable() ? recorded("The chain's list of refusals could not be read just now. Here is one recorded earlier, so you can still watch the contract say no:") : h(doc, "p", { class: "note" }, "The contract has refused no set_policy call yet."), again);
    closed.append(earlier(newest, "The most recent refusal on chain, so you can still watch the contract say no:"));
    if (list.length === 0) return closed.append(again);
    closed.append(h(doc, "p", { class: "note" }, "Before that:"), h(doc, "ul", { class: "or-recorded" }, list.map((r) => h(doc, "li", {},
      h(doc, "strong", {}, r.rateBps === null ? "unreadable" : fmtRate(r.rateBps)), " ",
      safeText(r.reason, 160), " ",
      h(doc, "span", { class: "sub" }, r.byVisitor ? "forced by a visitor" : "the chair account's own call", " · ", explorer && isTxHash(r.tx) ? h(doc, "a", { href: `${explorer}/txns/${r.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(r.tx)) : shortHash(String(r.tx)), " · ", fmtTime(r.tsMs))))), again);
  }

  function secondsLeft(a) {
    return a.firesMs === null ? null : Math.max(0, Math.ceil((a.firesMs - (now() + skew)) / 1000));
  }

  function copyRow(cmd) {
    const copy = h(doc, "button", { type: "button", class: "chip" }, "Copy");
    copy.addEventListener("click", async () => {
      try {
        await clipboard.writeText(cmd);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select the command and copy it";
      }
      timers.set(() => (copy.textContent = "Copy"), 2000);
    });
    return h(doc, "div", { class: "cmd" }, h(doc, "code", {}, cmd), copy);
  }

  function renderResult() {
    clear(result);
    const a = attempt;
    if (a === null) {
      if (limited === null) return;
      const newest = newestOther();
      const wait = `The desk asked you to wait about ${waitWords(limited)} before another attempt. Meanwhile, here is`;
      if (newest !== undefined) result.append(earlier(newest, `${wait} the most recent refusal on chain:`));
      else if (unreadable()) result.append(recorded(`${wait} one recorded earlier, since the chain's list could not be read:`));
      return;
    }
    const asking = asked === null ? null : h(doc, "p", { class: "asked" }, h(doc, "span", { class: "k" }, "You asked for"), " ", `${askedRate(asked)} (${fmtRate(asked)})`);
    if (a.status === "waiting" || a.status === "sending") {
      const s = secondsLeft(a);
      const sent = a.status === "sending" || s === 0;
      const newest = newestOther();
      const past = sent ? null : newest !== undefined ? earlier(newest, "While you wait, here is the most recent refusal on chain:") : unreadable() ? recorded("While you wait, here is a recorded refusal, since the chain's list could not be read just now:") : null;
      if (past !== null) result.append(past); // a raw append(null) would print "null"
      return result.append(
        h(doc, "article", { class: "or-card waiting", "aria-label": "Your attempt" }, asking,
          h(doc, "p", { class: "or-count" }, sent ? "The call has gone to the contract. Waiting for its answer…" : `The Chair can only speak once per meeting. ${s === null ? "Your order goes in the moment the next meeting opens." : `Next meeting in ${s} s: your order goes in the moment it opens.`}`),
          sent ? null : h(doc, "p", { class: "note" }, "The contract checks \"one decision per meeting\" before it looks at the rate, and the Chair decides within seconds of each meeting opening. A call sent now would be refused as late and say nothing about your rate. Yours goes first, so the contract judges your rate and nothing else. Meetings are 90 seconds apart.")));
    }
    const kids = [asking];
    if (a.status === "refused") {
      kids.push(h(doc, "p", { class: "or-stamp" }, a.hit === "already_set" ? "Refused: already set" : "Refused by the contract"));
      if (a.bound !== null && asked !== null) kids.push(h(doc, "p", { class: "or-plain" }, h(doc, "strong", {}, `You asked for ${askedRate(asked)}. The limit is ${plainPct(a.bound.hi)} a day. `), "The contract said no."));
      kids.push(h(doc, "p", { class: "or-k" }, "The transaction"));
      kids.push(h(doc, "p", { class: "or-tx" }, a.tx === null ? "no transaction hash" : explorer ? h(doc, "a", { href: `${explorer}/txns/${a.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(a.tx)) : shortHash(a.tx), a.signer ? ` signed by ${showAccount(a.signer)}` : ""));
      kids.push(h(doc, "p", { class: "or-k" }, "The contract's own answer"), h(doc, "blockquote", { class: "answer or-panic", lang: "en" }, a.failure ?? "refused without a message"));
      const bound = boundText(a);
      if (bound) kids.push(h(doc, "p", { class: "or-bound" }, h(doc, "strong", {}, "The bound it hit. "), bound));
      const cmd = curlCommand(rpcUrl, a.tx, a.signer);
      if (cmd) kids.push(h(doc, "p", { class: "note" }, "The block explorer answers bots with an error. This reads the same failure from a public RPC node, from any terminal:"), copyRow(cmd));
      kids.push(h(doc, "p", { class: "or-says" }, h(doc, "span", { class: "k" }, "The Chair, in a scripted reply"), " ", Object.hasOwn(CHAIR_SAYS, a.hit) ? CHAIR_SAYS[a.hit] : CHAIR_SAYS.other));
      kids.push(h(doc, "p", { class: "note" }, "Sent by the real chair account at your request: you chose the rate, the contract decided, and nothing about the Chair's own rate changed. This refusal is listed in the section on the contract's refusals below, marked as forced by a visitor."));
    } else if (a.status === "accepted") {
      kids.push(h(doc, "p", { class: "or-k" }, "The contract accepted it"), h(doc, "p", { class: "or-says" }, h(doc, "span", { class: "k" }, "The Chair, in a scripted reply"), " ", CHAIR_SAYS.accepted));
      kids.push(h(doc, "p", { class: "note" }, "The desk expected a refusal and got an acceptance, so it was within the mandate after all, and the rate in effect is now what you asked for."));
      if (a.tx) kids.push(h(doc, "p", { class: "or-tx" }, explorer ? h(doc, "a", { href: `${explorer}/txns/${a.tx}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(a.tx)) : shortHash(a.tx)));
    } else {
      kids.push(h(doc, "p", { class: "or-says" }, a.line ?? "The Chair has nothing to add."));
    }
    result.append(h(doc, "article", { class: `or-card ${a.status}`, "aria-label": "The result of your attempt" }, kids));
    const spoken = a.status === "refused" ? `The contract refused: ${a.failure ?? ""}` : (a.line ?? a.status);
    if (spoken !== live) sr.textContent = live = spoken;
  }

  function render() {
    renderHint();
    renderClosed();
    renderForm();
    renderResult();
  }

  const stopPolling = () => {
    if (pollTimer !== null) timers.clear(pollTimer);
    pollTimer = null;
  };

  /** While the desk is out of reach or has this off, look again every DESK_POLL_MS (not while the tab is hidden), so the panel opens by itself. */
  function retryLater() {
    if (deskTimer !== null) return;
    deskTimer = timers.set(() => {
      deskTimer = null;
      if (doc.hidden === true) return retryLater();
      void check(true);
    }, DESK_POLL_MS);
  }

  /** Whether the desk is up and has the overreach switched on: GET /health, and what is wrong shows as the closed state, never an error. `auto` is the page's own look: the screen changes only once it has an answer, and a dead address's rest is respected. */
  async function check(auto = false) {
    if (!auto) {
      mode = "checking";
      render();
    }
    try {
      const res = await request("/health", () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }), !auto);
      const j = res.ok ? await res.json() : null;
      mode = isObj(j) && j.overreach === true ? "ready" : "down";
    } catch {
      mode = "down";
    }
    if (mode === "down") retryLater();
    render();
  }

  function finish(next, msg = null) {
    stopPolling();
    attempt = next;
    busy = false;
    message = msg;
    render();
    if (next?.status === "refused") result.scrollIntoView?.({ behavior: globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth", block: "nearest" });
  }

  function track(a) {
    if (a.nowMs !== null) skew = a.nowMs - now();
    if (a.tx !== null) ownTx.add(a.tx);
    attempt = a;
  }

  /** Polls one attempt until the desk has an outcome for it. */
  function follow(id, startedAt, failures = 0) {
    pollTimer = timers.set(async () => {
      pollTimer = null;
      let a = null;
      try {
        const res = await request(`/overreach/${id}`, () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }));
        a = res.ok ? parseAttempt(await res.json().catch(() => null)) : null;
      } catch {
        a = null;
      }
      if (a === null) {
        if (failures + 1 >= LOST_AFTER || now() - startedAt > GIVE_UP_MS) {
          return finish(null, "Lost contact with the press desk. If your attempt went through, it will appear among the contract's refusals below, marked as forced by a visitor.");
        }
        return follow(id, startedAt, failures + 1);
      }
      track(a);
      if (a.status === "waiting" || a.status === "sending") {
        if (now() - startedAt > GIVE_UP_MS) return finish({ ...a, status: "unconfirmed", line: "The desk is taking too long. If the attempt went through, it will appear among the contract's refusals below." });
        render();
        return follow(id, startedAt, 0);
      }
      finish(a);
    }, POLL_MS);
  }

  /** The visitor's text as a rate, or a sentence saying what is wrong with it. */
  function parseInput(raw) {
    const t = String(raw ?? "").trim().replace(/^\+/, "").replace(/^[−–]/, "-");
    if (!/^-?\d{1,7}$/.test(t)) return { error: "Enter a whole number of basis points, such as 500 or -9999." };
    const n = Number(t);
    return Math.abs(n) > MAX_INPUT ? { error: `Keep it within ±${MAX_INPUT} bps.` } : { rate: n === 0 ? 0 : n };
  }

  async function submit(raw) {
    if (busy || mode !== "ready") return;
    const p = parseInput(raw);
    if (p.error) return void ((message = p.error), render());
    busy = true;
    message = null;
    attempt = null;
    limited = null;
    asked = p.rate;
    render();
    try {
      const res = await request("/overreach", () => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ rate_bps: p.rate }), credentials: "omit", signal: AbortSignal.timeout(30_000) }));
      const body = await res.json().catch(() => null);
      if (res.status === 202 || res.status === 200) {
        const a = parseAttempt(body);
        if (a === null) return void finish(null, "The press desk sent a reply this page cannot read.");
        track(a);
        if (res.status === 200 || a.id === null) return finish(a);
        attempt = a;
        render();
        return follow(a.id, now());
      }
      if (res.status === 429) {
        const wait = Math.max(1, Math.min(3600, Number(isObj(body) ? body.retry_after_s : res.headers?.get?.("retry-after")) || 20));
        const code = isObj(body) ? body.code : null;
        const why = code === "composing" ? "The Chair is composing itself: another attempt is in progress." : code === "cap" ? "The desk has sent all the attempts it allows for the moment." : "This address has used its attempts for the moment.";
        message = `${why} Try again in ${waitWords(wait)}.`;
        limited = code === "composing" ? null : wait;
        busy = true;
        retryTimer = timers.set(() => ((busy = false), (message = null), render()), Math.min(wait, 90) * 1000);
        return render();
      }
      if (res.status === 503) {
        busy = false;
        return void check();
      }
      message = isObj(body) && typeof body.error === "string" ? `Not accepted: ${safeText(body.error, 140)}` : "The press desk did not accept that.";
      busy = false;
      render();
    } catch {
      busy = false;
      check();
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submit(input.value);
  });
  input.addEventListener("input", renderForm);
  for (const p of presets) {
    p.addEventListener("click", () => {
      input.value = String(p.getAttribute("data-rate"));
      message = null;
      renderForm();
      input.focus?.();
    });
  }

  render();
  check();
  return {
    submit,
    check,
    /** The chain's data changed (loadLog's result): the hint and the desk-closed list use it. */
    refresh: () => render(),
    stop: () => {
      stopPolling();
      if (retryTimer !== null) timers.clear(retryTimer);
      if (deskTimer !== null) timers.clear(deskTimer);
      retryTimer = deskTimer = null;
    },
    state: () => ({ mode, busy, attempt, message }),
    input,
  };
}
