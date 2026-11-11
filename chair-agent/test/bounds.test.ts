import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BOUNDS, RateWindow, decay } from "../src/bounds.js";
import { contractAccepts, randInt, rng, specDecay } from "./helpers.js";

test("SPEC vector: decay from 120 and -120", () => {
  const seq = (start: number) => {
    const out = [start];
    for (let i = 0; i < 3; i++) out.push(decay(out[i]!, DEFAULT_BOUNDS));
    return out;
  };
  assert.deepEqual(seq(120), [120, 70, 20, 0]);
  assert.deepEqual(seq(-120), [-120, -70, -20, 0]);
});

test("decay: literal expected values, one 50 bps step toward zero and never past it", () => {
  const cases: [number, number][] = [[200, 150], [120, 70], [51, 1], [50, 0], [49, 0], [1, 0], [0, 0], [-1, 0], [-50, 0], [-51, -1], [-70, -20], [-200, -150]];
  for (const [from, to] of cases) assert.equal(decay(from, DEFAULT_BOUNDS), to, `decay(${from})`);
});

test("SPEC vector: in effect -10 allows 40 and rejects 41", () => {
  const w = RateWindow.around(-10, DEFAULT_BOUNDS);
  assert.ok(w.contains(40));
  assert.ok(!w.contains(41));
  assert.equal(w.pick(41), 40);
});

test("SPEC vector: in effect 150 allows 200 and rejects 201", () => {
  const w = RateWindow.around(150, DEFAULT_BOUNDS);
  assert.ok(w.contains(200));
  assert.ok(!w.contains(201));
  assert.equal(w.pick(201), 200);
});

test("pick refuses anything that is not a safe integer", () => {
  const w = RateWindow.around(0, DEFAULT_BOUNDS);
  for (const bad of [NaN, Infinity, -Infinity, 1.5, 2 ** 60, Number.MAX_VALUE]) {
    assert.throws(() => w.pick(bad), TypeError, String(bad));
  }
});

test("around() rejects a rate in effect the contract could not hold", () => {
  assert.throws(() => RateWindow.around(201, DEFAULT_BOUNDS), RangeError);
  assert.throws(() => RateWindow.around(0.5, DEFAULT_BOUNDS), RangeError);
});

test("every pick is accepted by the contract rules, now and after a rollover, for every rate in effect", () => {
  for (let rate = -200; rate <= 200; rate++) {
    const now = RateWindow.around(rate, DEFAULT_BOUNDS);
    const across = RateWindow.acrossRollover(rate, DEFAULT_BOUNDS);
    for (let wanted = -400; wanted <= 400; wanted += 7) {
      assert.ok(contractAccepts(rate, now.pick(wanted)), `around ${rate} wanted ${wanted}`);
      const p = across.pick(wanted);
      assert.ok(contractAccepts(rate, p), `across now ${rate} wanted ${wanted}`);
      assert.ok(contractAccepts(specDecay(rate), p), `across next ${rate} wanted ${wanted}`);
    }
  }
});

test("acrossRollover is never empty and always contains the rate in effect", () => {
  const r = rng(1);
  for (let i = 0; i < 2000; i++) {
    const rate = randInt(r, -200, 200);
    const w = RateWindow.acrossRollover(rate, DEFAULT_BOUNDS);
    assert.ok(w.lo <= w.hi && w.contains(rate), `rate ${rate}`);
  }
});
