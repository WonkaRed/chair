// The worst case the page states, re-derived: from the contract's own constants, not from the page's copy of them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const site = (f) => import(join(root, "site", "js", f));
const { worstCase, boundText, renderBound, RESTRAINTS, LAUNCH, MAX_TOTAL_SUPPLY, IMPEACHMENT } = await site("bound.js");
const contract = (f) => readFile(join(root, "..", "contract", "src", f), "utf8");
const text = (n) => n.textContent;

test("the page's constants are the contract's: bounds, step, quorum, supply limit", async () => {
  const policy = await contract("policy.rs");
  assert.equal(Number(policy.match(/pub const MAX_RATE_BPS: i32 = (\d+);/)[1]), LAUNCH.maxRateBps);
  assert.equal(Number(policy.match(/pub const MAX_STEP_BPS: i32 = (\d+);/)[1]), LAUNCH.maxStepBps);
  assert.equal(Number((await contract("rollover.rs")).match(/pub const QUORUM_BPS: u32 = (\d+);/)[1]), LAUNCH.quorumBps);
  assert.match(await contract("lib.rs"), /const MAX_TOTAL_SUPPLY: u128 = u128::MAX \/ 10_000;/);
  assert.equal(MAX_TOTAL_SUPPLY, (2n ** 128n - 1n) / 10_000n);
  const deployment = JSON.parse(await readFile(join(root, "..", "docs", "testnet-deployment.json"), "utf8"));
  assert.equal(BigInt(deployment.launch.supply), LAUNCH.launchSupply);
  assert.equal(deployment.launch.epochMs, LAUNCH.epochMs);
  assert.equal(deployment.launch.impeachThresholdBps, LAUNCH.impeachThresholdBps);
});

const perDay = { ...LAUNCH, meetingsPerDay: 960 };
/** The same figures by brute force: one meeting at a time, the contract's ramp, no closed form. */
function simulated({ maxRateBps, maxStepBps, epochMs, launchSupply, meetingsPerDay }) {
  const cap = Number((MAX_TOTAL_SUPPLY * 1_000n) / launchSupply) / 1_000;
  let growth = 1;
  let rate = 0;
  let n = 0;
  while (growth < cap) {
    rate = Math.min(maxRateBps, rate + maxStepBps);
    growth *= 1 + rate / (10_000 * meetingsPerDay);
    n += 1;
  }
  return n;
}

test("without meetings_per_day (the older per-meeting rule): 2% a meeting, about 2.2 times an hour, the supply limit after about 530 meetings (13 hours)", () => {
  const w = worstCase(LAUNCH);
  assert.equal(w.perMeetingPct, 2);
  assert.ok(Math.abs(w.perHour - 1.02 ** 40) < 1e-9 && Math.abs(w.perHour - 2.208) < 0.001);
  assert.equal(w.rampMeetings, 4);
  assert.ok(Math.abs(w.capMultiple - 34_028.236) < 0.01);
  assert.equal(w.capMeetings, 529, "the contract's ramp (+50 a meeting up to +200) is counted");
  assert.equal(w.capMeetings, simulated({ ...LAUNCH, meetingsPerDay: 1 }));
  assert.ok(Math.abs(w.capHours - 13.2) < 0.1);
  assert.equal(worstCase({ ...LAUNCH, epochMs: 3_600_000 }).perHour, 1.02, "a longer meeting is one step an hour");
  assert.deepEqual(worstCase({ ...LAUNCH, meetingsPerDay: null }), w, "null is absent");
});

test("with meetings_per_day 960 (the per-day rule): at most 2.02011% a day, 1.15 times a week, 1.82 times in 30 days, about 17 months to the supply limit", () => {
  const w = worstCase(perDay);
  assert.ok(Math.abs(w.perMeetingPct - 200 / 960 / 100) < 1e-12, "a meeting prints one 960th of the day's 2%");
  assert.ok(Math.abs((w.perDay - 1) * 100 - 2.02011) < 1e-5, "SPEC: (1 + 1/48000)^960 = 1.0202011");
  assert.ok(Math.abs(w.perWeek - 1.1502721) < 1e-6, "SPEC: 6720 meetings");
  assert.ok(Math.abs(w.perMonth - 1.8221074) < 1e-6, "SPEC: 28800 meetings");
  assert.ok(Math.abs(w.perHour - (1 + 1 / 48_000) ** 40) < 1e-12);
  assert.equal(w.rampMeetings, 4);
  const brute = simulated(perDay);
  assert.ok(Math.abs(w.capMeetings - brute) <= 1, `closed form ${w.capMeetings} against ${brute} one meeting at a time`);
  assert.ok(w.capMeetings > 490_000 && w.capMeetings < 510_000, "about 500,000 meetings");
  const months = (w.capHours / 24) / 30.44;
  assert.ok(months > 16.5 && months < 17.5, `${months} months`);
  assert.ok(worstCase({ ...perDay, epochMs: 86_400_000, meetingsPerDay: 1 }).perDay <= 1.02 + 1e-12, "a 24 hour epoch is at most the rate a day");
  assert.ok(worstCase({ ...perDay, epochMs: 3_600_000 * 13, meetingsPerDay: 2 }).perDay <= 1.01 ** 2 + 1e-12, "so is an epoch past 12 hours");
});

test("without meetings_per_day the text states the old per-meeting worst case and admits it is hyperinflation; the three real restraints stay", () => {
  const t = boundText({});
  assert.match(t.lead, /^The Chair can print at most 2% of all coins in one meeting, and a meeting comes every 90 seconds\./);
  assert.match(t.lead, /at most 0\.5% a meeting, so getting there takes 4 meetings/);
  assert.match(t.worst, /about 2\.2 times an hour/);
  assert.match(t.worst, /about 34,000 times the launch supply/);
  assert.match(t.worst, /about 530 meetings, roughly 13 hours/);
  assert.match(t.worst, /That is hyperinflation, and the contract alone does not prevent it\./);
  assert.equal(t.figures, null);
  assert.deepEqual(t.restraints.map((r) => r.head), ["Holders can fire the Chair.", "New coins go only to people who staked.", "A silent Chair fades out."]);
  assert.match(t.restraints[0].body, /more than 30% of the staked coins.*more than 5% of all coins.*meeting 10\./);
  assert.match(t.restraints[1].body, /Stake or be diluted\./);
  assert.match(t.restraints[2].body, /moves the rate 0\.5% toward zero/);
});

test("with meetings_per_day the text is per day: at most about 2.02% a day, a week, 30 days, the time to the supply limit, and no hyperinflation warning", () => {
  const t = boundText({ meetingsPerDay: 960 });
  assert.equal(t.lead, "The rate can never go above 2% a day. A meeting comes every 90 seconds, and each one prints only 1/960 of that day's rate. It cannot jump to the ceiling either: the rate moves at most 0.5% a meeting, so getting there takes 4 meetings.");
  assert.equal(t.worst, "Even if it holds the rate at the ceiling forever, the supply grows by at most about 2.02% a day: the 2% plus a little, because each meeting's new coins count toward the next. The only hard stop is a supply limit written into the code, about 34,000 times the launch supply.");
  assert.deepEqual(t.figures, [{ k: "In a day", v: "+2.02%" }, { k: "In a week", v: "1.15 times" }, { k: "In 30 days", v: "1.82 times" }, { k: "To the supply limit", v: "about 17 months" }]);
  assert.deepEqual(t.restraints.map((r) => r.head), ["Holders can fire the Chair.", "New coins go only to people who staked.", "A silent Chair fades out."]);
  assert.doesNotMatch(t.restraints[0].body, /scripted accounts/, "the disclosure lives under the honest limits");
  const all = JSON.stringify(t);
  assert.doesNotMatch(all, /hyperinflation|times an hour|does not prevent/i, "the warning is gone: it is no longer true");
  assert.doesNotMatch(all, /—|–|NaN|undefined|Infinity/);
});

test("every number follows the chain's params, and one restraint is one entry in one list", () => {
  const t = boundText({ maxRateBps: 100, epochMs: 3_600_000, impeachThresholdBps: 2_500, launchSupply: 10n ** 27n });
  assert.match(t.lead, /at most 1% of all coins in one meeting, and a meeting comes every hour/);
  assert.match(t.restraints[0].body, /more than 25% of the staked coins/);
  const day = boundText({ maxRateBps: 100, epochMs: 3_600_000, meetingsPerDay: 24, impeachThresholdBps: 2_500, launchSupply: 10n ** 27n });
  assert.match(day.lead, /^The rate can never go above 1% a day\. A meeting comes every hour, and each one prints only 1\/24 of that day's rate/);
  assert.match(day.figures[0].v, /^\+1(\.\d+)?%$/);
  assert.ok(RESTRAINTS.length === 3 && RESTRAINTS.every((r) => typeof r.head === "string" && typeof r.body === "function"));
});

test("it renders the lead, the worst case and the list; the transaction link needs an explorer and a real hash", () => {
  const doc = fakeDoc();
  const el = host(doc);
  renderBound(doc, el, { epochMs: null }, { explorer: "https://explorer.example" });
  renderBound(doc, el, {}, { explorer: "https://explorer.example" });
  assert.equal([...walk(el)].filter((n) => n.attrs?.class === "restraints")[0].children.length, 3, "re-rendering replaces, never stacks");
  const link = [...walk(el)].filter((n) => n.tag === "a");
  assert.equal(link.length, 1);
  assert.equal(link[0].attrs.href, `https://explorer.example/txns/${IMPEACHMENT.tx}`);
  assert.match(IMPEACHMENT.tx, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  const bare = host(doc);
  renderBound(doc, bare, {});
  assert.equal([...walk(bare)].filter((n) => n.tag === "a").length, 0);
  assert.match(text(bare), /Three things restrain it:/);
  const day = host(doc);
  renderBound(doc, day, { meetingsPerDay: 960 });
  assert.deepEqual([...walk(day)].filter((n) => n.tag === "dt").map(text), ["In a day", "In a week", "In 30 days", "To the supply limit"]);
  assert.equal([...walk(day)].filter((n) => n.attrs?.class === "bound-worst").length, 0, "no red warning box under the per-day rule");
  assert.equal([...walk(bare)].filter((n) => n.attrs?.class === "bound-worst").length, 1, "and the older rule keeps it, because there it is true");
  assert.doesNotMatch(text(day), /—|–|NaN|undefined|null/);
  assert.doesNotMatch(text(bare), /—|–|NaN|undefined/);
});
