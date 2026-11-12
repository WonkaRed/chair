import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_RATE_BPS, MEETINGS_PER_DAY, perMeetingCurve } from "../src/model.js";
import { DAY_SCENARIOS } from "../src/scenarios.js";
import { INITIAL_SUPPLY, run, type Result } from "../src/sim.js";
import { maxDayGrowth, renderDaily } from "../src/table.js";

const DAY = Number(MEETINGS_PER_DAY);
const SCALE = 10_000_000_000n;
const results = new Map<string, Result>(DAY_SCENARIOS.map((s) => [s.id, run(s)]));
const get = (id: string): Result => {
  const r = results.get(id);
  assert.ok(r, `scenario ${id}`);
  return r;
};
const ratio = (result: Result, epochs: number): bigint => (result.rows[epochs - 1]!.supply * SCALE) / INITIAL_SUPPLY;

describe("the leash in numbers", () => {
  it("a day is 960 meetings of 90 s", () => {
    assert.equal(DAY * 90, 86_400);
    assert.equal(MAX_RATE_BPS, 200);
  });

  it("a chair pinned at +200 bps for a week grows the supply by at most 1.150273x, and for 30 days by at most 1.822108x", () => {
    const week = get("max-inflation-7d");
    assert.equal(week.rows.length, 7 * DAY);
    assert.ok(ratio(week, 7 * DAY) > 11_502_000_000n && ratio(week, 7 * DAY) <= 11_502_730_000n, `${ratio(week, 7 * DAY)}`);
    const month = get("max-inflation-30d");
    assert.equal(month.rows.length, 30 * DAY);
    assert.ok(ratio(month, 30 * DAY) > 18_220_000_000n && ratio(month, 30 * DAY) <= 18_221_080_000n, `${ratio(month, 30 * DAY)}`);
  });

  it("no 24 h stretch of a pinned chair grows the supply past 1.0202012x, the exact compounding of 1/48000 per meeting", () => {
    for (const id of ["max-inflation-7d", "max-inflation-30d"]) {
      const peak = maxDayGrowth(get(id));
      assert.ok(peak.ratio > 10_202_000_000n && peak.ratio <= 10_202_012_000n, `${id}: ${peak.ratio}`);
    }
  });

  it("no single meeting grows the supply by more than one part in 48,000", () => {
    for (const row of get("max-inflation-30d").rows) {
      assert.ok(row.minted * 48_000n <= row.supply - row.minted, `epoch ${row.epoch}`);
    }
  });

  it("the old per-meeting rule on the same rates ran to the supply ceiling inside a day", () => {
    const rows = get("max-inflation-7d").rows;
    const old = perMeetingCurve(INITIAL_SUPPLY, rows.map((r) => r.rateBps));
    assert.ok(old[39]! > INITIAL_SUPPLY * 2n && old[39]! < INITIAL_SUPPLY * 3n, "about 2.2x in the first hour");
    assert.ok(old[DAY - 1]! > INITIAL_SUPPLY * 10_000n);
  });

  it("the daily table prints and names the bound", () => {
    const text = renderDaily(get("max-inflation-7d"));
    assert.match(text, /max-inflation-7d/);
    assert.match(text, /1\.020201x/);
  });
});
