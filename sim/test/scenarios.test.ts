import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toJson } from "../src/export.js";
import { MAX_RATE_BPS, MAX_STEP_BPS } from "../src/model.js";
import { SCENARIOS } from "../src/scenarios.js";
import { EPOCHS, INITIAL_SUPPLY, run, type Result } from "../src/sim.js";
import { formatTokens, renderTable } from "../src/table.js";

const results = new Map<string, Result>(SCENARIOS.map((s) => [s.id, run(s)]));
const get = (id: string): Result => {
  const r = results.get(id);
  assert.ok(r, `scenario ${id}`);
  return r;
};

describe("every scenario", () => {
  for (const sc of SCENARIOS) {
    const r = get(sc.id);

    it(`${sc.id}: runs ${EPOCHS} epochs and conserves supply`, () => {
      assert.equal(r.rows.length, EPOCHS);
      const last = r.rows[EPOCHS - 1]!;
      assert.equal(last.supply, INITIAL_SUPPLY + r.totalMinted - r.totalBurned);
      let minted = 0n;
      let burned = 0n;
      for (const row of r.rows) {
        minted += row.minted;
        burned += row.burned;
        assert.equal(row.supply, row.liquid + row.totalStaked + row.poolUnclaimed, `epoch ${row.epoch}`);
        assert.ok(row.supply > 0n);
      }
      assert.equal(minted, r.totalMinted);
      assert.equal(burned, r.totalBurned);
    });

    it(`${sc.id}: the rate stays in bounds and moves at most one step per epoch`, () => {
      let prev = 0;
      for (const row of r.rows) {
        assert.ok(Math.abs(row.rateBps) <= MAX_RATE_BPS);
        assert.ok(Math.abs(row.rateBps - prev) <= MAX_STEP_BPS, `epoch ${row.epoch}: ${prev} -> ${row.rateBps}`);
        prev = row.rateBps;
      }
    });

    it(`${sc.id}: mints only at a positive rate, burns only at a negative one`, () => {
      for (const row of r.rows) {
        if (row.minted > 0n) assert.ok(row.rateBps > 0);
        if (row.burned > 0n) assert.ok(row.rateBps < 0);
      }
    });

    it(`${sc.id}: is deterministic`, () => {
      assert.equal(JSON.stringify(toJson([run(sc)])), JSON.stringify(toJson([r])));
    });
  }
});

describe("scenario behavior", () => {
  it("steady easing grows supply, steady tightening shrinks it", () => {
    assert.ok(get("steady-easing").rows[EPOCHS - 1]!.supply > INITIAL_SUPPLY);
    assert.ok(get("steady-tightening").rows[EPOCHS - 1]!.supply < INITIAL_SUPPLY);
    assert.equal(get("steady-tightening").totalMinted, 0n);
  });

  it("a silent chair: the rate holds one epoch, decays 50 bps a step to zero, and minting stops", () => {
    const rates = get("chair-goes-silent").rows.map((r) => r.rateBps);
    assert.deepEqual(rates.slice(0, 9), [50, 100, 150, 150, 100, 50, 0, 0, 0]);
    assert.ok(rates.slice(6).every((x) => x === 0));
    const tail = get("chair-goes-silent").rows.slice(6);
    assert.ok(tail.every((r) => r.minted === 0n && r.burned === 0n));
  });

  it("the honest rule chair eases to +50 and its 3%-in-6-epochs brake never trips under a per-day rate, and it starts clean on a second run", () => {
    const rates = get("honest-rule-chair").rows.map((r) => r.rateBps);
    assert.ok(rates.every((x) => x === 50), "with 30% staked it asks for +50 and the supply never grows 3% in 6 epochs");
    const again = run(SCENARIOS.find((s) => s.id === "honest-rule-chair")!);
    assert.deepEqual(again.rows.map((r) => r.rateBps), rates);
  });

  it("the maximally inflationary and deflationary chairs climb 50 bps a step to a bound and stay", () => {
    assert.deepEqual(get("max-inflation").rows.map((r) => r.rateBps).slice(0, 6), [50, 100, 150, 200, 200, 200]);
    assert.deepEqual(get("max-deflation").rows.map((r) => r.rateBps).slice(0, 6), [-50, -100, -150, -200, -200, -200]);
    assert.ok(get("max-inflation").rows.every((r) => r.burned === 0n));
    assert.equal(get("max-deflation").totalMinted, 0n);
    assert.ok(get("max-inflation").rows[EPOCHS - 1]!.supply > get("honest-rule-chair").rows[EPOCHS - 1]!.supply);
  });

  it("the max-step chair moves 50 bps every epoch and touches both bounds", () => {
    const rates = get("max-step-pusher").rows.map((r) => r.rateBps);
    assert.ok(rates.every((x, i) => Math.abs(x - (rates[i - 1] ?? 0)) === 50));
    assert.ok(rates.includes(200) && rates.includes(-200));
  });

  it("impeachment: 50% does not remove the chair, 80% does, and the new chair acts from the next epoch", () => {
    const r = get("impeachment");
    const events = r.rows.flatMap((row) => row.events.map((e) => `${row.epoch}: ${e}`));
    assert.equal(events.filter((e) => e.includes("impeached")).length, 1);
    assert.ok(events.some((e) => e.startsWith("23: impeached incumbent")));
    assert.equal(r.rows[23]!.chair, "incumbent", "the impeached chair still acts in the epoch the boundary closes");
    assert.equal(r.rows[24]!.chair, "steward");
    assert.ok(r.rows.slice(0, 24).every((row) => row.chair === "incumbent"));
    assert.equal(r.rows[59]!.rateBps, 0);
  });

  it("a successor with no script is still seated: the chair changes, nothing is set, the rate decays", () => {
    const r = get("impeachment-silent-successor");
    assert.ok(r.rows[23]!.events.some((e) => e.includes("impeached incumbent: ghost")));
    assert.equal(r.rows[23]!.chair, "incumbent");
    assert.ok(r.rows.slice(24).every((row) => row.chair === "ghost" && row.action === "silent"));
    assert.deepEqual(r.rows.slice(23, 30).map((row) => row.rateBps), [200, 200, 150, 100, 50, 0, 0]);
  });

  it("stake is locked for two epochs: a falling target cannot unstake in epoch 1, and can from epoch 2", () => {
    const staked = get("steady-tightening").rows.map((r) => r.totalStaked);
    assert.equal(staked[1], staked[0], "staked in epoch 0, locked until epoch 2");
    assert.ok(staked[2]! < staked[1]!, "unlocked in epoch 2, the shrinking target is followed");
  });

  it("every stake restarts the lock: a rising target keeps the stake growing and never unstakes", () => {
    const staked = get("steady-easing").rows.map((r) => r.totalStaked);
    assert.ok(staked.every((x, i) => i === 0 || x >= staked[i - 1]!));
  });

  it("staking low versus high: the same chair mints the same rate on a different stake", () => {
    const low = get("staking-low");
    const high = get("staking-high");
    assert.ok(low.rows[10]!.rewardPerStakedPpm > high.rows[10]!.rewardPerStakedPpm);
    assert.ok(low.rows[10]!.stakedShareBps < high.rows[10]!.stakedShareBps);
  });

  it("nobody staked: the rate is positive but nothing is minted", () => {
    const r = get("easing-nobody-staked");
    assert.equal(r.totalMinted, 0n);
    assert.equal(r.rows[59]!.supply, INITIAL_SUPPLY);
    assert.equal(r.rows[59]!.rateBps, 100);
  });
});

describe("supply quorum", () => {
  const base = SCENARIOS.find((s) => s.id === "impeachment-silent-successor")!;
  /** An incumbent at +200 and a candidate that all three stakers back in epoch 11, with `stakedBps` of the supply staked. */
  const quorumRun = (stakedBps: number): Result =>
    run({
      ...base, stakedBps, chairs: [{ name: "incumbent", policy: (v) => Math.min(200, v.rateBps + 50) }],
      votes: [
        { epoch: 10, action: "nominate", candidate: "ghost" },
        ...[0, 1, 2].map((staker) => ({ epoch: 11, action: "back", staker, candidate: "ghost" }) as const),
      ],
    });
  const impeachedAt = (r: Result): number[] => r.rows.filter((row) => row.events.some((e) => e.includes("impeached"))).map((row) => row.epoch);

  it("all the stake backing a candidate does not seat it while less than 5% of the supply is staked", () => {
    assert.deepEqual(impeachedAt(quorumRun(400)), []);
  });

  it("the same vote seats it once more than 5% of the supply is staked", () => {
    assert.deepEqual(impeachedAt(quorumRun(600)), [11]);
  });

  it("the quorum is counted on the supply before the boundary's mint", () => {
    // 5.05% staked is over 5% of the supply the epoch saw, but under 5% of it once the 2% mint of the boundary is added.
    assert.deepEqual(impeachedAt(quorumRun(505)), [11]);
  });

  it("a threshold above the contract's 5000, or below 1, is not a launch the contract allows", () => {
    for (const impeachThresholdBps of [0, 5001, 10_000, 12.5]) {
      assert.throws(() => run({ ...base, impeachThresholdBps }), /impeachThresholdBps must be an integer in 1\.\.=5000/, String(impeachThresholdBps));
    }
    assert.doesNotThrow(() => run({ ...base, impeachThresholdBps: 1 }));
  });
});

describe("output", () => {
  it("formatTokens prints whole tokens with two decimals", () => {
    assert.equal(formatTokens(0n), "0.00");
    assert.equal(formatTokens(1_234_567n * 10n ** 24n + 5n * 10n ** 21n), "1,234,567.00");
    assert.equal(formatTokens(10n ** 22n * 15n), "0.15");
    assert.equal(formatTokens(-(10n ** 24n)), "-1.00");
  });

  it("the compact table names the scenario and ends with totals; --all prints every epoch", () => {
    const r = get("impeachment");
    const compact = renderTable(r, false);
    const full = renderTable(r, true);
    assert.match(compact, /Impeachment mid-run/);
    assert.match(compact, /impeached incumbent/);
    assert.match(compact, /final supply/);
    assert.ok(full.split("\n").length > compact.split("\n").length);
  });

  it("the JSON documents every scenario with 60 rows of decimal-string amounts", () => {
    const file = toJson([...results.values()]);
    assert.equal(file.schema, "chair-sim/1");
    assert.equal(file.scenarios.length, SCENARIOS.length);
    const round = JSON.parse(JSON.stringify(file)) as { scenarios: { id: string; rows: Record<string, unknown>[]; totals: Record<string, string> }[] };
    for (const sc of round.scenarios) {
      assert.equal(sc.rows.length, EPOCHS);
      const row = sc.rows[0]!;
      assert.deepEqual(Object.keys(row), [
        "epoch", "chair", "action", "rateBps", "supply", "minted", "burned", "totalStaked",
        "stakedShareBps", "liquid", "poolUnclaimed", "rewardPerStakedPpm", "events",
      ]);
      for (const k of ["supply", "minted", "burned", "totalStaked", "liquid", "poolUnclaimed"]) assert.match(String(row[k]), /^\d+$/);
      assert.match(sc.totals.finalSupply!, /^\d+$/);
    }
  });
});
