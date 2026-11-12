// Keeps the hero alive: a countdown to the next meeting, and a light watch for the Chair's next decision. The page reads the chain once on load; this
// asks one cheap view (`get_policy`) only while a decision is due, and reads the whole log again only when that view says a newer one exists, so the
// transaction index (which throttles) is touched once per decision, not once per tick. Nothing here draws a minute: it asks the page to read again.
import { clear, h } from "./dom.js";

/** How long after a meeting starts the first look is made, and how long between looks while the Chair has not yet decided. */
export const FIRST_LOOK_MS = 4_000;
export const LOOK_MS = 20_000;
/** A Chair that has missed this many meetings is not expected to speak soon: look less often. */
const SILENT_AFTER = 3;
const SILENT_LOOK_MS = 60_000;
/** The index may be a few seconds behind the chain: a read that did not yet hold the new decision is made again, this many times. */
const REREAD_MS = 5_000;
const REREADS = 4;

/** "0:47" for 47 000 ms, "1:30" for 90 000; never negative. */
export function clock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * `host` holds the countdown line. `readPolicy()` resolves the chain's current `get_policy`; `reload()` reads the whole log again and resolves the meeting
 * of the newest decision it now shows (or -1). `now` and the timer functions are injectable for tests. Returns `{ setPolicy, stop }`: `setPolicy` is
 * called with every `get_policy` the page reads, `stop` ends the timers.
 */
export function createLive(doc, host, { readPolicy, reload, now = () => Date.now(), setTimer = (fn, ms) => globalThis.setTimeout(fn, ms), clearTimer = (id) => globalThis.clearTimeout(id), hidden = () => doc.hidden === true }) {
  const shown = h(doc, "span", { class: "nm-clock", "aria-hidden": "true" });
  const say = h(doc, "span", { class: "sr-only", role: "status" });
  let policy = null;
  let lookAt = Infinity; // when the next look at the chain is due
  let looking = false;
  let tick = null;

  const draw = () => {
    if (policy === null) return;
    const left = policy.epochEndsMs - now();
    host.hidden = false;
    shown.textContent = left > 0 ? `Next meeting in ${clock(left)}` : "The next meeting is starting";
  };

  /** When to look next, from what the chain last said. */
  const plan = () => {
    const decided = policy.lastSetEpoch === policy.epoch;
    const missed = policy.lastSetEpoch === null ? SILENT_AFTER : policy.epoch - policy.lastSetEpoch;
    const turnover = policy.epochEndsMs + FIRST_LOOK_MS; // a meeting already decided is looked at again just after it ends; a chain that still says it has not ended is not hammered
    lookAt = decided && turnover > now() ? turnover : now() + (decided || missed < SILENT_AFTER ? LOOK_MS : SILENT_LOOK_MS);
  };

  const look = async () => {
    if (looking) return;
    looking = true;
    try {
      const next = await readPolicy();
      const before = policy;
      setPolicy(next);
      const decidedBefore = before.lastSetEpoch ?? -1;
      if ((next.lastSetEpoch ?? -1) > decidedBefore) {
        for (let tries = 0; tries <= REREADS; tries++) {
          if ((await reload()) >= next.lastSetEpoch) {
            say.textContent = `New minutes: meeting ${next.lastSetEpoch}.`;
            break;
          }
          await new Promise((resolve) => setTimer(resolve, REREAD_MS));
        }
      }
    } catch {
      lookAt = now() + LOOK_MS; // a view that fails is looked at again later; the page keeps what it shows
    } finally {
      looking = false;
    }
  };

  function setPolicy(next) {
    const changed = policy === null || next.epochEndsMs !== policy.epochEndsMs || next.lastSetEpoch !== policy.lastSetEpoch;
    policy = next;
    if (changed || !(lookAt > now())) plan();
    draw();
    tick ??= setTimer(function again() {
      draw();
      if (policy !== null && !hidden() && now() >= lookAt) void look();
      tick = setTimer(again, 1_000);
    }, 1_000);
  }

  clear(host);
  host.hidden = true;
  host.append(shown, say);
  return {
    setPolicy,
    stop: () => {
      if (tick !== null) clearTimer(tick);
      tick = null;
      lookAt = Infinity;
    },
  };
}
