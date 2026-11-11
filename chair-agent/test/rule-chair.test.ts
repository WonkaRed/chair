import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleDecision, stakedShareBps } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

const input = (s = snapshot(), history: DecisionInput["history"] = []): DecisionInput => ({ snapshot: s, history, window: { lo: -50, hi: 50 } });

test("little staked: eases one step toward the wanted rate", () => {
  const p = ruleDecision(input(snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n })));
  assert.equal(p.rateBps, 50); // 10% staked asks for +100, one step is 50
  assert.match(p.reasoning, /10\.00%, below the 50\.00% target/);
});

test("a lot staked: tightens", () => {
  const p = ruleDecision(input(snapshot({ rate: 0, supply: 1_000_000n, staked: 800_000n })));
  assert.equal(p.rateBps, -50); // 80% staked asks for -75
});

test("near the target it holds inside the dead band, and settles the last bps when 0 is wanted", () => {
  assert.equal(ruleDecision(input(snapshot({ rate: 3, supply: 1_000_000n, staked: 490_000n }))).rateBps, 3); // wants 2, gap 1
  assert.equal(ruleDecision(input(snapshot({ rate: 3, supply: 1_000_000n, staked: 500_000n }))).rateBps, 0);
});

test("brakes: no easing after >3% growth, no tightening after >3% shrinkage", () => {
  const s = snapshot({ epoch: 10, rate: 20, supply: 1_040_000n, staked: 100_000n });
  const grown = ruleDecision(input(s, [{ epoch: 8, totalSupply: 1_000_000n }]));
  assert.equal(grown.rateBps, 0); // wanted held at 0, so 20 -> 0 in one step
  assert.match(grown.reasoning, /Supply grew 4\.00%/);
  const t = snapshot({ epoch: 10, rate: -20, supply: 960_000n, staked: 900_000n });
  const shrunk = ruleDecision(input(t, [{ epoch: 8, totalSupply: 1_000_000n }]));
  assert.equal(shrunk.rateBps, 0);
  assert.match(shrunk.reasoning, /Supply shrank 4\.00%/);
});

test("history older than the lookback is ignored", () => {
  const s = snapshot({ epoch: 20, rate: 0, supply: 2_000_000n, staked: 100_000n });
  assert.equal(ruleDecision(input(s, [{ epoch: 3, totalSupply: 1_000_000n }])).rateBps, 50);
});

test("no staking figures: walks the rate back to 0 and says so", () => {
  const p = ruleDecision(input(snapshot({ rate: 40, staked: null })));
  assert.equal(p.rateBps, 0);
  assert.match(p.reasoning, /No staking figures/);
});

test("same input, same output (the log can be audited by rerunning it)", () => {
  const i = input(snapshot({ rate: 10, supply: 7_777_777n, staked: 1_234_567n }), [{ epoch: 4, totalSupply: 7_000_000n }]);
  assert.deepEqual(ruleDecision(i), ruleDecision(i));
});

test("staked share uses floor integer division", () => {
  assert.equal(stakedShareBps(1n, 3n), 3333);
  assert.equal(stakedShareBps(10n ** 30n, 3n * 10n ** 30n), 3333);
});
