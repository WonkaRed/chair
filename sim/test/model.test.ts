import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_IMPEACH_THRESHOLD_BPS, MAX_TOTAL_SUPPLY, Policy, QUORUM_BPS, burnAmount, decay, impeachmentWinner, mintAmount, pendingReward, rewardPerShareDelta,
} from "../src/model.js";

describe("SPEC worked vectors", () => {
  it("mint: supply 1_000_001, rate 33, staked 500 -> 3300", () => {
    assert.equal(mintAmount(1_000_001n, 33, 500n), 3300n);
  });

  it("burn: 12_345 at -75 -> 92", () => {
    assert.equal(burnAmount(12_345n, -75), 92n);
  });

  it("decay: 120 -> 70 -> 20 -> 0 and -120 -> -70 -> -20 -> 0, chair silent", () => {
    for (const [start, seq] of [[120, [120, 70, 20, 0]], [-120, [-120, -70, -20, 0]]] as const) {
      const p = new Policy();
      p.rateBps = start;
      const seen: number[] = [];
      for (let epoch = 1; epoch <= 4; epoch++) {
        seen.push(p.rateBps);
        p.decayAfter(epoch);
      }
      assert.deepEqual(seen, seq);
      assert.equal(p.rateBps, 0);
    }
  });

  it("step: in effect -10 allows 40 and rejects 41", () => {
    const ok = new Policy();
    ok.rateBps = -10;
    assert.equal(ok.setRate(1, 40), null);
    const bad = new Policy();
    bad.rateBps = -10;
    assert.equal(bad.setRate(1, 41), "rate step too large");
    assert.equal(bad.rateBps, -10, "a rejected call changes nothing");
    assert.equal(bad.lastSetEpoch, null);
  });

  it("bounds: in effect 150 allows 200 and rejects 201", () => {
    const ok = new Policy();
    ok.rateBps = 150;
    assert.equal(ok.setRate(1, 200), null);
    const bad = new Policy();
    bad.rateBps = 150;
    assert.equal(bad.setRate(1, 201), "rate_bps out of bounds");
  });
});

describe("mint", () => {
  it("mints nothing at a non-positive rate or with nobody staked", () => {
    assert.equal(mintAmount(1_000_000n, 0, 5n), 0n);
    assert.equal(mintAmount(1_000_000n, -50, 5n), 0n);
    assert.equal(mintAmount(1_000_000n, 100, 0n), 0n);
  });

  it("is capped at MAX_TOTAL_SUPPLY", () => {
    assert.equal(mintAmount(MAX_TOTAL_SUPPLY - 7n, 200, 1n), 7n);
    assert.equal(mintAmount(MAX_TOTAL_SUPPLY, 200, 1n), 0n);
    assert.equal(mintAmount(MAX_TOTAL_SUPPLY + 1n, 200, 1n), 0n);
  });

  it("floors", () => {
    assert.equal(mintAmount(9_999n, 1, 1n), 0n);
    assert.equal(mintAmount(10_000n, 1, 1n), 1n);
  });
});

describe("rewards", () => {
  it("per-share accounting never pays out more than was minted and loses less than one unit per staker", () => {
    const minted = 1_000_003n;
    const stakes = [333_333n, 333_333n, 333_334n];
    const total = stakes.reduce((a, b) => a + b, 0n);
    const rps = rewardPerShareDelta(minted, total);
    const paid = stakes.reduce((a, s) => a + pendingReward(s, rps, 0n), 0n);
    assert.ok(paid <= minted);
    assert.ok(minted - paid <= BigInt(stakes.length));
  });

  it("rounds the index and each payout down, to the literal: 1_000_003 over 3 staked yocto", () => {
    assert.equal(rewardPerShareDelta(1_000_003n, 3n), 333_334_333_333_333_333_333_333_333_333n);
    assert.equal(rewardPerShareDelta(1n, 3n), 333_333_333_333_333_333_333_333n);
    assert.equal(pendingReward(1n, 5n * 10n ** 23n, 0n), 0n);
    assert.equal(pendingReward(3n, 5n * 10n ** 23n, 0n), 1n);
    assert.equal(pendingReward(3n, 333_333_333_333_333_333_333_333n, 0n), 0n);
  });

  it("pays nothing for a reward index already paid", () => {
    assert.equal(pendingReward(10n ** 24n, 5n * 10n ** 24n, 5n * 10n ** 24n), 0n);
  });
});

describe("burn", () => {
  it("burns nothing at zero or positive rates", () => {
    assert.equal(burnAmount(1_000n, 0), 0n);
    assert.equal(burnAmount(1_000n, 200), 0n);
  });
  it("burns at most the rate bound", () => {
    assert.equal(burnAmount(10_000n, -200), 200n);
  });
});

describe("decay", () => {
  it("moves one step toward zero and never past it", () => {
    assert.equal(decay(200), 150);
    assert.equal(decay(30), 0);
    assert.equal(decay(-30), 0);
    assert.equal(decay(0), 0);
  });
});

describe("Policy.setRate", () => {
  it("checks already-set, then bounds, then step", () => {
    const p = new Policy();
    assert.equal(p.setRate(3, 50), null);
    assert.equal(p.setRate(3, 5000), "policy already set this epoch");
    assert.equal(p.setRate(4, 5000), "rate_bps out of bounds");
    assert.equal(p.setRate(4, 150), "rate step too large");
    assert.equal(p.setRate(4, 1.5), "rate_bps out of bounds");
    assert.equal(p.setRate(4, 100), null);
  });

  it("an accepted call in the closing epoch suppresses decay; a rejected one does not", () => {
    const p = new Policy();
    p.setRate(1, 50);
    p.decayAfter(1);
    assert.equal(p.rateBps, 50);
    p.setRate(2, 500);
    p.decayAfter(2);
    assert.equal(p.rateBps, 0);
  });
});

describe("impeachmentWinner", () => {
  const cand = (id: string, backing: bigint, order: number) => ({ id, backing, order });
  // Supply 1: the quorum bar is below 1 yocto, so a stake-only expectation holds unless a test raises the supply.
  const SUPPLY = 1n;

  it("requires strictly more than the threshold", () => {
    assert.equal(impeachmentWinner([cand("a", 50n, 0)], 5000, 100n, SUPPLY), null);
    assert.equal(impeachmentWinner([cand("a", 51n, 0)], 5000, 100n, SUPPLY)?.id, "a");
  });

  it("the most backing wins, and a tie goes to the earliest nomination", () => {
    assert.equal(impeachmentWinner([cand("a", 60n, 2), cand("b", 70n, 5)], 5000, 100n, SUPPLY)?.id, "b");
    assert.equal(impeachmentWinner([cand("late", 70n, 5), cand("early", 70n, 2)], 5000, 100n, SUPPLY)?.id, "early");
  });

  it("nobody wins with nothing staked", () => {
    assert.equal(impeachmentWinner([cand("a", 0n, 0)], 5000, 0n, SUPPLY), null);
  });

  it("also requires strictly more than 5% of the whole supply, however large the share of the stake", () => {
    // All of the stake (100 of 100) backs "a", but 100 is not more than 5% of a supply of 2000.
    assert.equal(impeachmentWinner([cand("a", 100n, 0)], 5000, 100n, 2000n), null);
    assert.equal(impeachmentWinner([cand("a", 101n, 0)], 5000, 101n, 2000n)?.id, "a");
    assert.equal(impeachmentWinner([cand("a", 100n, 0)], 5000, 100n, 1999n)?.id, "a");
  });

  it("a candidate under the bar does not block one over it, and the higher of the two bars applies", () => {
    const quorumOnly = [cand("small", 99n, 0), cand("big", 101n, 1)];
    assert.equal(impeachmentWinner(quorumOnly, 1, 200n, 2000n)?.id, "big");
    // The stake bar (50% of 400 = 200) is the higher of the two bars here: 150 clears the quorum (100) and still loses.
    assert.equal(impeachmentWinner([cand("a", 150n, 0)], 5000, 400n, 2000n), null);
  });
});

describe("quorum constants", () => {
  it("match the contract: 5% of supply, thresholds up to 50% of stake", () => {
    assert.equal(QUORUM_BPS, 500);
    assert.equal(MAX_IMPEACH_THRESHOLD_BPS, 5000);
  });
});
