import assert from "node:assert/strict";
import { test } from "node:test";
import { parseParams } from "../src/validate.js";

const NEAR = 10n ** 24n;
const params = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  epoch_ms: 60_000, start_ms: 0, max_rate_bps: 200, max_step_bps: 50,
  impeach_threshold_bps: 5000, quorum_bps: 500, nominate_bond: "1", ...over,
});

test("get_params as the contract returns it parses, quorum included", () => {
  const p = parseParams(params({ nominate_bond: String(100n * NEAR) }));
  assert.equal(p.quorumBps, 500);
  assert.equal(p.impeachThresholdBps, 5000);
  assert.equal(p.nominateBond, 100n * NEAR);
});

test("an impeach threshold outside the 1..=5000 that `new` allows is refused", () => {
  assert.equal(parseParams(params({ impeach_threshold_bps: 1 })).impeachThresholdBps, 1);
  for (const bad of [0, 5001, 10_000]) {
    assert.throws(() => parseParams(params({ impeach_threshold_bps: bad })), /impeach_threshold_bps: expected an integer in 1\.\.5000/, String(bad));
  }
});

test("a nominate bond outside 1..=100 NEAR that `new` allows is refused", () => {
  for (const bad of ["0", String(100n * NEAR + 1n)]) {
    assert.throws(() => parseParams(params({ nominate_bond: bad })), /nominate_bond: expected 1\.\./, bad);
  }
});

test("quorum_bps must be present and a share of the supply", () => {
  const { quorum_bps: _omitted, ...withoutQuorum } = params();
  assert.throws(() => parseParams(withoutQuorum), /quorum_bps: expected an integer in 1\.\.10000/);
  for (const bad of [0, 10_001, 5.5, "500"]) {
    assert.throws(() => parseParams(params({ quorum_bps: bad })), /quorum_bps/, String(bad));
  }
});
