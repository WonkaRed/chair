// "Join the Committee": one button, and the press desk has its pool account move a small step of test coins into (or out of) the staked share. The page
// shows the real transaction and the share before and after, counts down to the Chair's next meeting, then quotes the Chair's own minutes for it with the
// staked share marked, and says in one plain sentence what the data supports about why the rate did what it did. The desk is the same untrusted, tunnelled
// service as the press conference (press.js hands over `request`); everything it returns passes through the checks below and reaches the page by `textContent`.
import { clear, h } from "./dom.js";
import { splitMinutes } from "./minutes.js";
import { POLL_MS as DESK_POLL_MS } from "./press.js";
import { isAccountId, isTxHash, safeLines, safeText } from "./text.js";
import { fmtPct, fmtTime, shortHash } from "./views.js";

export const STORE_KEY = "chair-join-last";
const PRESSED_KEY = "chair-join-pressed"; // set once this browser has made a press: the page then does not tell it that "other visitors" did
export const WATCH_EVERY_MS = 8_000;
/** The page stops looking for the minutes after this many reads (about two minutes of meetings at the launch length). */
export const WATCH_TRIES = 15;
const MEETING_GRACE_MS = 4_000; // the Chair signs a little after a meeting opens
const NEAR_ENOUGH = 3; // meetings: how far past the one after the press the decision can be and still be "the next one"
const DIRECTIONS = new Set(["join", "step_down"]);
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v) => Number.isSafeInteger(v) && v >= 0;

export const DOWN = "The press desk is not reachable, so nobody can press the button right now. It runs on my workstation, not on a hosted server, and is closed whenever that machine is off. This page keeps checking by itself and opens the moment the desk is back.";
/** Why a press matters, in the Chair's own rule (rule-chair.ts `mandateRate`): "staked" is glossed where it is first used in this panel. */
export const WHY = "The Chair prints less new money the more coins are staked (locked up to vote), and more when fewer are. One press changes that share, and the Chair's next minutes say what it did.";
const AIMING = "so the rate the Chair is aiming for moves up a little: fewer coins staked (locked up to vote) means it prints more.";
/** What a press will do when the pool is on its way out, said for who is looking: a stranger to a full pool, someone who pressed before, or a pool part-way down. */
export const stepOutWords = ({ full, pressedHere }) => (full
  ? `${pressedHere ? "The Committee's seats are full." : "Other visitors have already filled the Committee's seats."} A press now takes one seat back out, ${AIMING}`
  : `Earlier presses put the pool's coins in, and the pool is on its way back out. A press now takes one more seat out, ${AIMING}`);
export const FOOTER = "The coins come from a pool account the project controls, on a test network where coins have no value. Nothing of yours is used, and you need nothing of your own to press the button.";

/** The mandate the rule chair follows (chair-agent/src/rule-chair.ts): it wants half the coins staked and eases the rate by (50% - share) / 40 a day. */
const TARGET_BPS = 5000;
const BPS_PER_RATE_BPS = 40;
const DEADBAND_BPS = 5;
const RULE_CHAIR = "rule-v1";

/** The desk's record of a move that went through, or null when it is not the documented shape. */
export function parseRecord(j) {
  if (!isObj(j) || !DIRECTIONS.has(j.direction) || !isTxHash(j.tx_hash)) return null;
  const shares = [j.share_before_bps, j.share_after_bps];
  if (!shares.every((s) => int(s) && s <= 10_000) || !int(j.epoch) || !int(j.meeting_epoch) || !Number.isFinite(j.meeting_at_ms) || !Number.isFinite(j.at_ms)) return null;
  return { direction: j.direction, tx: j.tx_hash, shareBefore: j.share_before_bps, shareAfter: j.share_after_bps, epoch: j.epoch, meetingEpoch: j.meeting_epoch, meetingAtMs: j.meeting_at_ms, atMs: j.at_ms };
}

/** The desk's step (bps of the supply) and the number of steps the pool may hold, or null when they are not both there and the pool's whole cap is under the whole supply. */
export function parseLimits(j) {
  const ok = int(j.step_bps) && int(j.cap_steps) && j.step_bps > 0 && j.cap_steps > 0 && j.step_bps * j.cap_steps < 10_000;
  return ok ? { stepBps: j.step_bps, capSteps: j.cap_steps } : null;
}

const toWire = (r) => ({ direction: r.direction, tx_hash: r.tx, share_before_bps: r.shareBefore, share_after_bps: r.shareAfter, epoch: r.epoch, meeting_epoch: r.meetingEpoch, meeting_at_ms: r.meetingAtMs, at_ms: r.atMs });

/** The share the minutes state, in bps, and the words around it, or null: "11.00% of all coins are staked" (rule-chair.ts writes exactly that). */
export function minutesShare(text) {
  const m = /(\d{1,3}(?:\.\d{1,2})?)% of all coins are staked/.exec(String(text));
  if (m === null) return null;
  const bps = Math.round(Number(m[1]) * 100);
  return bps >= 0 && bps <= 10_000 ? { bps, from: m.index, to: m.index + m[0].length } : null;
}

const chairOf = (text) => /^\$CHAIR decision, epoch \d+, chair (.+)\.$/m.exec(String(text))?.[1] ?? null;
const rateWords = (bps) => (bps > 0 ? `${fmtPct(bps)} a day` : bps === 0 ? "nothing" : `a burn of ${fmtPct(bps)}`);
/** A rate without its unit when it is a printing rate and the unit is said elsewhere in the sentence: "down from 0.29%". */
const bare = (bps) => (bps > 0 ? fmtPct(bps) : rateWords(bps));
const rangeWords = (a, b) => (a > 0 && b > 0 ? `${fmtPct(a)} to ${fmtPct(b)} a day` : `${rateWords(a)} to ${rateWords(b)}`);

/** The rate the mandate asks for when `share` of the coins is staked, whoever the Chair is: rule-chair.ts `mandateRate`. */
const mandate = (share, maxRateBps) => Math.max(-maxRateBps, Math.min(maxRateBps, Math.trunc((TARGET_BPS - share) / BPS_PER_RATE_BPS))) || 0;

/** What the rule chair does with `was` (the rate in effect) when `share` of the coins is staked: the same arithmetic as rule-chair.ts `ruleDecision`. */
function ruleRate(share, was, maxRateBps, maxStepBps) {
  const wanted = mandate(share, maxRateBps);
  const gap = wanted - was;
  const rate = gap === 0 || (wanted !== 0 && Math.abs(gap) < DEADBAND_BPS) ? was : was + Math.max(-maxStepBps, Math.min(maxStepBps, gap));
  return { wanted, rate };
}

/**
 * One plain sentence on what the press did to the Chair's rate, and whether the data supports saying it did. `record` is the press, `decision` the
 * Chair's next decision (the chain's rate before and after), `minutes` the verified text it signed or null, `yours` whether the visitor looking made it.
 * Cause is claimed only when the Chair is the rule chair, the minutes state the share, and the rule applied to that share, without the step the press
 * added, gives a different rate than the one chosen. Any other Chair (a language model, which weighs more than the mandate) gets the part that is
 * arithmetic: the mandate's target before and after the press, and what the Chair then set, with no cause claimed. Anything else is said as what it is:
 * other accounts moved the share too, the step was inside the dead band, the step limit bound, or no cause can be shown.
 * @returns {{ sentence: string, cause: boolean }}
 */
export function explainJoin({ record, decision, minutes = null, yours = false, maxRateBps = 200, maxStepBps = 50 }) {
  const { rateBps: now, previousRateBps: was } = decision;
  const figures = `${rateWords(was)} before, ${rateWords(now)} now`;
  const moved = record.shareAfter - record.shareBefore;
  const stated = minutes === null ? null : minutesShare(minutes);
  if (stated === null || moved === 0) {
    return { sentence: now === was ? `The Chair left the rate at ${rateWords(now)}. The minutes do not tie that to this press.` : `The Chair set ${rateWords(now)}, from ${rateWords(was)}. The minutes do not tie that to this press, so none is claimed.`, cause: false };
  }
  const sign = moved > 0 ? 1 : -1;
  if ((stated.bps - record.shareAfter) * sign < 0) {
    return { sentence: `The minutes count ${fmtPct(stated.bps)} staked, ${sign > 0 ? "below" : "above"} the ${fmtPct(record.shareAfter)} right after this press: other coins moved the other way before the meeting, so this decision cannot be put down to the press (${figures}).`, cause: false };
  }
  const others = stated.bps === record.shareAfter ? "" : " Other accounts moved the share the same way too.";
  if (chairOf(minutes) !== RULE_CHAIR) {
    const asks = mandate(stated.bps, maxRateBps);
    const without = mandate(stated.bps - moved, maxRateBps);
    const target = asks === without ? `At ${fmtPct(stated.bps)} staked the Chair's mandate asks for ${rateWords(asks)}, and it would have asked for the same without this press: one step is too small to move it.` : `${yours ? "Your" : "This"} press moved the Chair's target from ${rangeWords(without, asks)}.`;
    const set = now === was ? `The Chair kept its rate at ${rateWords(now)}.` : `The Chair then set ${rateWords(now)}, ${now > was ? "up" : "down"} from ${bare(was)}.`;
    const stepLimit = Math.abs(asks - was) > maxStepBps && Math.abs(now - was) === maxStepBps ? ` The contract lets the Chair move its rate ${fmtPct(maxStepBps)} a meeting at most.` : "";
    return { sentence: `${target} ${set}${stepLimit}${others}`, cause: false };
  }
  const wouldBe = ruleRate(stated.bps - moved, was, maxRateBps, maxStepBps);
  const did = ruleRate(stated.bps, was, maxRateBps, maxStepBps);
  if (did.rate !== now) return { sentence: `The Chair set ${rateWords(now)}, from ${rateWords(was)}. That is not what its rule gives for ${fmtPct(stated.bps)} staked, so something else moved it too (a silent meeting, for one), and no cause is claimed for the press.${others}`, cause: false };
  if (now === was) {
    const why = did.wanted === was ? `at ${fmtPct(stated.bps)} staked its rule asks for the rate already in place` : `its rule wants ${rateWords(did.wanted)} at ${fmtPct(stated.bps)} staked, which is within the ${fmtPct(DEADBAND_BPS)} a day it ignores as noise`;
    return { sentence: `The Chair held the rate at ${rateWords(now)}: ${why}, so this press did not change what it did.${others}`, cause: false };
  }
  const caused = wouldBe.rate !== now;
  const aligned = (now - was) * sign < 0; // the share went up and the rate went down, or the reverse: the way the mandate points
  const lead = sign > 0 ? "More coins are staked" : "Fewer coins are staked";
  if (aligned) {
    const verb = sign > 0 ? "printed less" : "printed more";
    return caused
      ? { sentence: `${lead}, so the Chair ${verb}: ${figures}.${others}`, cause: true }
      : { sentence: `The Chair ${verb}: ${figures}. Its rule would have done the same without this press (the contract limits a rate to a ${fmtPct(maxStepBps)} move a meeting), so the press is not the cause.${others}`, cause: false };
  }
  return {
    sentence: `The rate went ${now > was ? "up" : "down"} anyway: ${figures}. At ${fmtPct(stated.bps)} staked the rule still wants ${rateWords(did.wanted)}, and the press only ${sign > 0 ? "lowered" : "raised"} that target${caused ? ` (it would have chosen ${rateWords(wouldBe.rate)} without it)` : ""}.${others}`,
    cause: caused,
  };
}

/** The first decision at or just after the meeting the press was counted in, and its minutes if they are known and verified. */
export function findMinutes(record, data, resolved) {
  const decision = (data?.decisions ?? []).filter((d) => !d.byVisitor && d.epoch >= record.meetingEpoch && d.epoch - record.meetingEpoch <= NEAR_ENOUGH).reduce((a, d) => (a === null || d.epoch < a.epoch ? d : a), null);
  if (decision === null) return null;
  const r = resolved?.get(decision.tx);
  return { decision, text: r?.verdict === "verified" ? r.text : null, unverified: r !== undefined && r.verdict !== "verified" };
}

const waitWords = (s) => (s >= 90 ? `${Math.ceil(s / 60)} minutes` : `${s} s`);

/**
 * Builds the panel into `host`; `section` is the page section, shown only while there is something true to show in it. `request(path, init)` talks to the
 * press desk and throws when there is none. `chain()` is the page's chain read, `{ data, resolved }`: loadLog's data and the resolved minutes texts, `reload()` reads it again.
 */
export function createJoin(doc, host, { section = null, request, explorer = null, chain = () => ({ data: null, resolved: null }), reload = async () => undefined, store = safeStore(), timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }, now = Date.now } = {}) {
  let mode = "checking"; // checking | ready | off
  let busy = false;
  let message = null;
  let mine = null; // this visitor's press: the record the desk returned
  let blocked = null; // a press that did not go through: { text, retryAtMs }
  let earlier = readStored(); // the latest press on record that is not this visitor's: from the desk, or kept from an earlier visit
  let next = "join";
  let pool = null;
  let limits = null; // the desk's step and cap, as it reports them: { stepBps, capSteps }
  let steps = null; // how many steps the pool holds, as the desk last read it from the chain
  let pressedHere = (() => {
    try {
      return store.get(PRESSED_KEY) === "1"; // this browser has made a press, now or on an earlier visit
    } catch {
      return false;
    }
  })();
  let retry = null;
  let skew = 0; // the desk's clock minus this one
  let tries = 0;
  let lastRead = 0;
  let reading = false;
  let ticker = null;

  const button = h(doc, "button", { type: "button", class: "ask jn-btn" }, "Join the Committee");
  const who = h(doc, "p", { class: "jn-who" }, "One press, one small step. Nothing of yours is spent.");
  const note = h(doc, "p", { class: "form-note", role: "status" });
  const why = h(doc, "p", { class: "jn-why" }, WHY);
  const act = h(doc, "div", { class: "jn-act" }, why, button, who, note);
  const result = h(doc, "div", { class: "jn-result", "aria-live": "polite" });
  const how = h(doc, "details", { class: "fold jn-how" }, h(doc, "summary", {}, "How this works, and its limits"));
  host.append(act, result, h(doc, "p", { class: "note jn-foot" }, FOOTER), how);

  const txLink = (n) => (explorer && isTxHash(n) ? h(doc, "a", { href: `${explorer}/txns/${n}`, rel: "noopener noreferrer", target: "_blank" }, shortHash(n)) : shortHash(String(n)));

  function renderHow() {
    clear(how);
    const step = limits === null ? null : fmtPct(limits.stepBps);
    const cap = limits === null ? null : fmtPct(limits.stepBps * limits.capSteps);
    const shift = limits === null ? "only slightly" : `by about ${fmtPct(limits.stepBps / BPS_PER_RATE_BPS)} a day`;
    how.append(h(doc, "summary", {}, "How this works, and its limits"),
      h(doc, "p", { class: "note" }, `Each press has the press desk send one call to the token contract on NEAR testnet from a pool account the project funded: stake one step (${step === null ? "a small share" : step} of all coins) while the pool holds less than ${cap === null ? "its limit" : cap}, then unstake one step a press until it is empty, then start again. The staked share is what the Chair's mandate reads: it eases the rate by (50% minus the staked share) divided by 40 basis points a day.`),
      h(doc, "p", { class: "note" }, `The pool can only stake and unstake. It never backs a challenger and never transfers, and a stake of ${cap === null ? "under 5%" : `at most ${cap}`} cannot impeach the Chair, which needs a challenger with over 30% of the staked coins and over 5% of all coins. The desk reads the pool's stake from the chain before every press and sends nothing if the call would pass the limit or the read fails. The contract keeps a stake in for two meetings, so a step out right after a step in has to wait.`),
      h(doc, "p", { class: "note" }, `A press is not always a visible change: one step shifts the Chair's target ${shift}, the Chair ignores a difference of under ${fmtPct(DEADBAND_BPS)} a day, so a single press can change nothing, and the minutes say so. Each address gets 3 presses an hour and the desk 20 an hour and 200 a day.`),
      ...(pool === null ? [] : [h(doc, "p", { class: "note" }, "The pool account: ", explorer ? h(doc, "a", { href: `${explorer}/address/${pool}`, rel: "noopener noreferrer", target: "_blank" }, pool) : pool, ".")]));
  }

  /** The seconds until `ms` by the desk's clock, or null when that is not a wait a person could be looking at. */
  const secondsTo = (ms) => {
    const s = Math.ceil((ms - (now() + skew)) / 1000);
    return s > 3600 ? null : Math.max(0, s);
  };

  function quote(text) {
    const prose = splitMinutes(text).prose;
    const at = minutesShare(prose);
    const body = at === null ? [safeLines(prose)] : [safeLines(prose.slice(0, at.from)), h(doc, "mark", {}, safeLines(prose.slice(at.from, at.to))), safeLines(prose.slice(at.to))];
    return h(doc, "blockquote", { class: "answer jn-quote", lang: "en" }, ...body);
  }

  /** The minutes for a press: the quote with the share marked, and the sentence the data supports. Null while they are not on the page. */
  function minutesCard(record, found, yours) {
    const { decision } = found;
    const params = chain().data?.params;
    const kids = [h(doc, "p", { class: "or-k" }, `The Chair's minutes, meeting ${decision.epoch}`)];
    if (found.text !== null) {
      kids.push(quote(found.text));
      kids.push(h(doc, "p", { class: "jn-says" }, h(doc, "span", { class: "k" }, "In plain words"), " ", explainJoin({ record, decision, minutes: found.text, yours, ...(params ? { maxRateBps: params.maxRateBps, maxStepBps: params.maxStepBps } : {}) }).sentence));
    } else {
      kids.push(h(doc, "p", { class: "note" }, found.unverified ? "The text for these minutes does not match the fingerprint the chain holds, so it is not shown and nothing is claimed from it." : "The text of these minutes is not available on this page, so nothing is claimed from it."));
      kids.push(h(doc, "p", { class: "jn-says" }, h(doc, "span", { class: "k" }, "What the chain recorded"), ` The rate went from ${rateWords(decision.previousRateBps)} to ${rateWords(decision.rateBps)}.`));
    }
    kids.push(h(doc, "p", { class: "or-tx" }, "The decision: ", txLink(decision.tx)));
    return h(doc, "div", { class: "jn-minutes" }, kids);
  }

  const shares = (r) => h(doc, "p", { class: "jn-shares" }, h(doc, "span", { class: "k" }, "Staked share of all coins"), " ", h(doc, "strong", {}, fmtPct(r.shareBefore)), " before, ", h(doc, "strong", {}, fmtPct(r.shareAfter)), " after");

  const wait = h(doc, "p", { class: "or-count" });
  function updateWait() {
    if (mine === null) return;
    const found = findMinutes(mine, chain().data, chain().resolved);
    if (found !== null) return;
    const s = secondsTo(mine.meetingAtMs);
    wait.textContent = tries >= WATCH_TRIES
      ? `The Chair's minutes for meeting ${mine.meetingEpoch} have not reached this page. They will be on chain once the Chair signs them; check back, or find them in the Chair's minutes further down.`
      : s === null ? "The Chair's next meeting is coming up." : s > 0 ? `The Chair's next meeting opens in ${waitWords(s)}. It will count these staked coins.` : "The Chair is meeting now. Waiting for its minutes…";
  }

  /** A press on record: the transaction, the share before and after, and the meeting whose minutes cited it. `live` marks the visitor's own. */
  function recordCard(record, { lead = null, live = false }) {
    const found = findMinutes(record, chain().data, chain().resolved);
    const did = record.direction === "join" ? "It put one step of the pool's coins into the staked share." : "It took one step of the pool's coins back out of the staked share. The pool goes in until it reaches its limit, then out a step at a time until it is empty, so the share can move both ways.";
    return h(doc, "article", { class: `or-card jn-card${live ? " live" : " earlier"}`, "aria-label": live ? "Your press" : "An earlier press" },
      lead ? h(doc, "p", { class: "or-lead" }, lead) : null,
      live ? h(doc, "p", { class: "or-stamp jn-stamp" }, "Sent. Here is the transaction") : h(doc, "p", { class: "or-k" }, "The transaction"),
      h(doc, "p", { class: "or-tx" }, txLink(record.tx), " ", fmtTime(record.atMs)),
      h(doc, "p", { class: "or-plain" }, did),
      shares(record),
      found === null ? (live ? wait : h(doc, "p", { class: "note" }, `The Chair's minutes for meeting ${record.meetingEpoch}, the first to count it, are not on this page.`)) : minutesCard(record, found, live));
  }

  function renderResult() {
    clear(result);
    if (blocked !== null) {
      const s = blocked.retryAtMs === null ? null : secondsTo(blocked.retryAtMs);
      result.append(h(doc, "p", { class: "jn-line" }, blocked.text, s === null || s === 0 ? "" : ` Try again in ${waitWords(s)}.`));
    }
    if (mine !== null) result.append(recordCard(mine, { live: true }));
    else if (earlier !== null && (blocked !== null || mode === "off")) result.append(recordCard(earlier, { lead: mode === "off" ? "The latest press on record, so you can still see what it did:" : "Meanwhile, here is the latest press on record, not yours:" }));
    if (mine !== null) updateWait();
  }

  function render() {
    const visible = mode === "ready" || (mode === "off" && earlier !== null) || mine !== null;
    if (section !== null) section.hidden = !visible;
    act.hidden = mode !== "ready";
    button.disabled = busy || mode !== "ready";
    button.textContent = busy ? "Sending…" : next === "step_down" ? "Step back out of the Committee" : "Join the Committee";
    why.textContent = next === "step_down" ? stepOutWords({ full: steps === null || limits === null || steps >= limits.capSteps, pressedHere: pressedHere || mine !== null }) : WHY;
    note.textContent = message ?? "";
    if (mode === "off") {
      clear(result);
      result.append(h(doc, "p", { class: "closed-line" }, "Nobody can join the Committee just now."), h(doc, "p", { class: "note" }, DOWN));
      const again = h(doc, "button", { type: "button", class: "chip" }, "Check again");
      again.addEventListener("click", () => void check());
      result.append(again);
      if (earlier !== null) result.append(recordCard(earlier, { lead: "The latest press on record, so you can still see what it did:" }));
      return renderHow();
    }
    renderResult();
    renderHow();
  }

  function remember(record) {
    try {
      store.set(STORE_KEY, JSON.stringify(toWire(record)));
    } catch {
      // Storage blocked or full: the record lasts for this page view.
    }
  }

  function readStored() {
    try {
      return parseRecord(JSON.parse(store.get(STORE_KEY) ?? "null"));
    } catch {
      return null;
    }
  }

  /** The desk's latest press, if it names a valid one: kept, and kept across visits. */
  function sawLast(j) {
    const r = parseRecord(j);
    if (r === null) return;
    if (mine === null || mine.tx !== r.tx) earlier = r;
    remember(r);
  }

  /** A second a time: the countdown, and once the meeting has opened, a read of the chain every few seconds until the Chair's minutes for it appear. */
  function tick() {
    ticker = null;
    if (mine === null) return;
    const found = findMinutes(mine, chain().data, chain().resolved);
    if (found !== null || tries >= WATCH_TRIES) return render();
    const t = now();
    if (t + skew >= mine.meetingAtMs + MEETING_GRACE_MS && t - lastRead >= WATCH_EVERY_MS && !reading) {
      reading = true;
      lastRead = t;
      tries++;
      Promise.resolve(reload()).catch(() => undefined).finally(() => {
        reading = false;
        render();
      });
    }
    updateWait();
    ticker = timers.set(tick, 1000);
  }

  function watch() {
    if (ticker !== null) timers.clear(ticker);
    tries = 0;
    lastRead = 0;
    ticker = timers.set(tick, 1000);
  }

  /** What the desk says comes next and the latest press it has made. A courtesy: the button works without it. */
  async function readState() {
    try {
      const res = await request("/join/state", () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }));
      const j = res.ok ? await res.json() : null;
      if (!isObj(j)) return;
      next = j.next === "step_down" ? "step_down" : "join";
      pool = isAccountId(j.pool) ? j.pool : null;
      limits = parseLimits(j);
      steps = int(j.pool_steps) ? j.pool_steps : null;
      sawLast(j.last);
    } catch {
      // Keep what was known.
    }
  }

  /** While the desk is out of reach or has this off, look again every DESK_POLL_MS (not while the tab is hidden), so the panel opens by itself. */
  function retryLater() {
    if (retry !== null) return;
    retry = timers.set(() => {
      retry = null;
      if (doc.hidden === true) return retryLater();
      void check(true);
    }, DESK_POLL_MS);
  }

  /** Whether the desk is up and has this switched on (GET /health); anything else is the closed state, never an error. `auto` is the page's own look: it changes nothing on screen until it has an answer, and it respects a dead address's rest. */
  async function check(auto = false) {
    if (!auto) mode = "checking";
    try {
      const res = await request("/health", () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }), !auto);
      const j = res.ok ? await res.json() : null;
      mode = isObj(j) && j.join === true ? "ready" : "off";
    } catch {
      mode = "off";
    }
    if (mode === "ready") await readState();
    else retryLater();
    render();
  }

  const limitText = (code) => (code === "composing" ? "Someone else is joining right now." : code === "cap" ? "The desk has had all the joiners it allows for the moment." : "This address has used its presses for the moment.");

  async function press() {
    if (busy || mode !== "ready") return;
    busy = true;
    message = null;
    blocked = null;
    mine = null;
    render();
    try {
      const res = await request("/join", () => ({ method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "omit", signal: AbortSignal.timeout(60_000) }));
      const body = await res.json().catch(() => null);
      busy = false;
      if (res.status === 503) return void check();
      if (isObj(body) && Number.isFinite(body.now_ms)) skew = body.now_ms - now();
      if (isObj(body)) sawLast(body.last);
      if (res.status === 429) {
        const s = Math.max(1, Math.min(3600, Number(isObj(body) ? body.retry_after_s : res.headers?.get?.("retry-after")) || 20));
        blocked = { text: limitText(isObj(body) ? body.code : null), retryAtMs: now() + skew + s * 1000 };
        return render();
      }
      if (res.status !== 200 || !isObj(body)) {
        message = isObj(body) && typeof body.error === "string" ? `Not accepted: ${safeText(body.error, 140)}` : "The press desk did not accept that.";
        return render();
      }
      if (body.status === "joined" || body.status === "stepped_down") {
        const r = parseRecord(body);
        if (r === null || (body.status === "joined") !== (r.direction === "join")) {
          message = "The press desk sent a reply this page cannot read.";
          return render();
        }
        mine = r;
        pressedHere = true;
        try {
          store.set(PRESSED_KEY, "1");
        } catch {
          // Storage blocked: the sentence is right for this page view.
        }
        remember(r);
        watch();
        render();
        return void readState().then(render);
      }
      const retryAt = Number.isFinite(body.retry_at_ms) ? body.retry_at_ms : null;
      blocked = body.status === "locked" ? { text: "The pool's coins went in a moment ago, and the contract keeps them in for two meetings, so the pool cannot step back out yet.", retryAtMs: retryAt }
        : body.status === "dry" ? { text: "The pool has no coins left to put in, so nothing was sent.", retryAtMs: null }
          : body.status === "failed" ? { text: `The contract refused the call, and nothing about the stake changed.${typeof body.failure === "string" ? ` Its words: ${safeText(body.failure, 240)}` : ""}`, retryAtMs: null }
            : body.status === "unconfirmed" ? { text: `The call was sent, but the desk could not confirm the new share.${isTxHash(body.tx_hash) ? " The transaction may still show on chain." : ""}`, retryAtMs: null }
              : { text: "The press desk sent a reply this page cannot read.", retryAtMs: null };
      render();
    } catch {
      busy = false;
      check();
    }
  }

  button.addEventListener("click", () => void press());
  render();
  check();
  return {
    press,
    check,
    /** The chain's data changed (loadLog's result): the minutes may now be there. */
    refresh: () => render(),
    stop: () => {
      if (ticker !== null) timers.clear(ticker);
      if (retry !== null) timers.clear(retry);
      ticker = retry = null;
    },
    state: () => ({ mode, busy, mine, blocked, earlier, message, next }),
    button,
  };
}

/** localStorage when it is there and allowed, else a store that forgets. */
function safeStore() {
  try {
    const s = globalThis.localStorage;
    if (s) return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v) };
  } catch {
    // Blocked: fall through.
  }
  return { get: () => null, set: () => undefined };
}
