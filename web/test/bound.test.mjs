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

test("the worst case at the deployed token's settings: 2% a meeting, about 2.2 times an hour, the supply limit after about 530 meetings (13 hours)", () => {
  const w = worstCase(LAUNCH);
  assert.equal(w.perMeetingPct, 2);
  assert.ok(Math.abs(w.perHour - 1.02 ** 40) < 1e-9 && Math.abs(w.perHour - 2.208) < 0.001);
  assert.equal(w.rampMeetings, 4);
  assert.ok(Math.abs(w.capMultiple - 34_028.236) < 0.01);
  assert.equal(w.capMeetings, 529, "the contract's ramp (+50 a meeting up to +200) is counted");
  assert.ok(Math.abs(w.capHours - 13.2) < 0.1);
  assert.equal(worstCase({ ...LAUNCH, epochMs: 3_600_000 }).perHour, 1.02, "a longer meeting is one step an hour");
});

test("the text states the per-meeting and per-hour worst case, admits it is hyperinflation, and lists the three real restraints", () => {
  const t = boundText({});
  assert.match(t.lead, /^The Chair can print at most 2% of all coins in one meeting, and a meeting comes every 90 seconds\./);
  assert.match(t.lead, /at most 0\.5% a meeting, so getting there takes 4 meetings/);
  assert.match(t.worst, /about 2\.2 times an hour/);
  assert.match(t.worst, /about 34,000 times the launch supply/);
  assert.match(t.worst, /about 530 meetings, roughly 13 hours/);
  assert.match(t.worst, /That is hyperinflation, and the contract alone does not prevent it\./);
  assert.deepEqual(t.restraints.map((r) => r.head), ["Holders can fire the Chair.", "New coins go only to people who staked.", "A silent Chair fades out."]);
  assert.match(t.restraints[0].body, /more than 30% of the staked coins.*more than 5% of all coins.*meeting 10\. My own scripted accounts did it, not a crowd\./);
  assert.match(t.restraints[1].body, /Stake or be diluted\./);
  assert.match(t.restraints[2].body, /moves the rate 0\.5% toward zero/);
  const all = JSON.stringify(t);
  assert.doesNotMatch(all, /daily|budget|per day|a day/i, "no cap that the contract does not enforce is claimed");
});

test("every number follows the chain's params, and one restraint is one entry in one list", () => {
  const t = boundText({ maxRateBps: 100, epochMs: 3_600_000, impeachThresholdBps: 2_500, launchSupply: 10n ** 27n });
  assert.match(t.lead, /at most 1% of all coins in one meeting, and a meeting comes every hour/);
  assert.match(t.restraints[0].body, /more than 25% of the staked coins/);
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
  assert.doesNotMatch(text(bare), /—|–|NaN|undefined/);
});
