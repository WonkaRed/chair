// The live hero: the countdown to the next meeting, and the light watch for the Chair's next decision. Time and timers are injected: no clock, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { clock, createLive, FIRST_LOOK_MS, LOOK_MS } = await import(join(root, "site", "js", "live.js"));

test("clock: minutes and zero-padded seconds, rounded up, never negative", () => {
  assert.equal(clock(47_000), "0:47");
  assert.equal(clock(90_000), "1:30");
  assert.equal(clock(46_001), "0:47");
  assert.equal(clock(5), "0:01");
  assert.equal(clock(0), "0:00");
  assert.equal(clock(-5_000), "0:00");
});

/** A manual clock: `advance(ms)` runs every timer that falls due, in order, one second at a time as the page's own tick does. */
function rig({ readPolicy, reload }) {
  let t = 1_000_000;
  const timers = [];
  const doc = fakeDoc();
  const el = host(doc);
  const live = createLive(doc, el, {
    readPolicy,
    reload,
    now: () => t,
    setTimer: (fn, ms) => timers.push({ at: t + ms, fn }) && timers.at(-1),
    clearTimer: (id) => timers.splice(timers.indexOf(id), 1),
    hidden: () => false,
  });
  const advance = async (ms) => {
    const end = t + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers.find((x) => x.at <= end);
      if (next === undefined) break;
      timers.splice(timers.indexOf(next), 1);
      t = Math.max(t, next.at);
      next.fn();
      for (let i = 0; i < 10; i++) await Promise.resolve(); // let a look settle
    }
    t = end;
  };
  return { live, el, advance, now: () => t, timers };
}
const policy = (over) => ({ epoch: 10, lastSetEpoch: 9, epochEndsMs: 1_000_000 + 47_000, rateBps: 25, ...over });

test("the countdown is hidden until the chain has answered, then counts down each second", async () => {
  const r = rig({ readPolicy: async () => policy(), reload: async () => 9 });
  assert.equal(r.el.hidden, true);
  r.live.setPolicy(policy());
  assert.equal(r.el.hidden, false);
  assert.match(r.el.textContent, /Next meeting in 0:47/);
  await r.advance(2_000);
  assert.match(r.el.textContent, /Next meeting in 0:45/);
  await r.advance(46_000);
  assert.match(r.el.textContent, /The next meeting is starting/);
  r.live.stop();
});

test("no look at the chain before the meeting turns over, then one cheap view; the whole log is read again only when a newer decision exists", async () => {
  let views = 0;
  let reloads = 0;
  const answers = [policy({ epoch: 11, lastSetEpoch: 9, epochEndsMs: 1_000_000 + 137_000 }), policy({ epoch: 11, lastSetEpoch: 11, epochEndsMs: 1_000_000 + 137_000 })];
  const r = rig({ readPolicy: async () => answers[Math.min(views++, answers.length - 1)], reload: async () => (reloads++, 11) });
  r.live.setPolicy(policy({ epoch: 10, lastSetEpoch: 10 }));
  await r.advance(47_000 + FIRST_LOOK_MS - 2_000);
  assert.equal(views, 0, "nothing is asked while the meeting runs");
  await r.advance(3_000);
  assert.equal(views, 1, "one view just after the meeting turns");
  assert.equal(reloads, 0, "the Chair has not decided: the log is not read");
  await r.advance(LOOK_MS + 1_000);
  assert.equal(views, 2);
  assert.equal(reloads, 1, "a newer decision: the log is read once");
  assert.match(r.el.textContent, /New minutes: meeting 11\./);
  await r.advance(60_000);
  assert.equal(views, 2, "decided and waiting for the next meeting: no further looks");
  r.live.stop();
});

test("an index that has not caught up is read again a few times, then left alone; a failing view is retried later and never throws", async () => {
  let reloads = 0;
  const decided = policy({ epoch: 10, lastSetEpoch: 10 });
  const r = rig({ readPolicy: async () => decided, reload: async () => (reloads++, 9) });
  r.live.setPolicy(policy({ epoch: 10, lastSetEpoch: 9, epochEndsMs: 1_000_000 + 47_000 }));
  await r.advance(47_000 + LOOK_MS + 40_000);
  assert.equal(reloads, 5, "the first read and four more, then it stops");
  r.live.stop();
  let tries = 0;
  const bad = rig({ readPolicy: async () => { tries++; throw new Error("rpc down"); }, reload: async () => 9 });
  bad.live.setPolicy(policy({ lastSetEpoch: 9, epoch: 10 }));
  await bad.advance(47_000 + FIRST_LOOK_MS + 2 * LOOK_MS);
  assert.ok(tries >= 2 && tries <= 5, `retried every ${LOOK_MS / 1000} s, not in a loop (${tries})`);
  bad.live.stop();
});

test("a hidden tab asks nothing, and stop ends the timers", async () => {
  let views = 0;
  let t = 1_000_000;
  const timers = [];
  const doc = fakeDoc();
  const live = createLive(doc, host(doc), { readPolicy: async () => (views++, policy()), reload: async () => 9, now: () => t, setTimer: (fn, ms) => timers.push({ at: t + ms, fn }) && timers.at(-1), clearTimer: (id) => timers.splice(timers.indexOf(id), 1), hidden: () => true });
  live.setPolicy(policy({ lastSetEpoch: 9, epoch: 10, epochEndsMs: t + 1_000 }));
  for (let i = 0; i < 100; i++) {
    t += 1_000;
    const due = timers.splice(0).filter((x) => x.at <= t);
    for (const x of due) x.fn();
  }
  assert.equal(views, 0);
  live.stop();
  assert.equal(timers.length, 0);
});

test("a chain that keeps saying a decided meeting has ended is asked every LOOK_MS at most, never every second", async () => {
  let views = 0;
  const stale = policy({ epoch: 10, lastSetEpoch: 10 });
  const r = rig({ readPolicy: async () => (views++, stale), reload: async () => 10 });
  r.live.setPolicy(stale);
  await r.advance(47_000 + FIRST_LOOK_MS + 5 * LOOK_MS);
  assert.ok(views <= 6, `${views} looks`);
  r.live.stop();
});
