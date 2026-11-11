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

test("the voice: each situation gets its own sentences, with every figure the numbers give", () => {
  const raise = ruleDecision(input(snapshot({ rate: 0, supply: 1_000_000n, staked: 480_000n })));
  assert.equal(raise.rateBps, 5); // wants 5, gap 5 is not under the dead band, one step reaches it
  assert.match(raise.reasoning, /^The Committee of One has met\. Staked share of supply is 48\.00%, below the 50\.00% target, which asks for 5 bps\./);
  assert.match(raise.reasoning, /The Chair raises the rate by 5 bps, from 0 bps to 5 bps\. The Chair thanks itself for its service\.$/);
  const cut = ruleDecision(input(snapshot({ rate: 20, supply: 1_000_000n, staked: 520_000n })));
  assert.match(cut.reasoning, /The Chair cuts the rate by 25 bps, from 20 bps to -5 bps\. The Committee of One was unanimous\.$/);
  const hold = ruleDecision(input(snapshot({ rate: 3, supply: 1_000_000n, staked: 490_000n })));
  assert.match(hold.reasoning, /The wanted rate 2 bps is within 5 bps of the current 3 bps\. The Chair holds at 3 bps and calls this leadership\.$/);
  const stepped = ruleDecision(input(snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n })));
  assert.match(stepped.reasoning, /The Chair wants 100 bps, but the contract allows a move of at most 50 bps per epoch\. The Chair raises the rate by 50 bps, from 0 bps to 50 bps, and files no objection\.$/);
  const empty = ruleDecision(input(snapshot({ rate: 0, supply: 1_000_000n, staked: 0n })));
  assert.match(empty.reasoning, /Nothing is staked, so an easing rate mints nothing until someone stakes\. The Chair notes the empty room\./);
  const none = ruleDecision(input(snapshot({ rate: 40, staked: null })));
  assert.match(none.reasoning, /^The Committee of One has met\. No staking figures are available, so there is nothing to steer by and the wanted rate is 0 bps\./);
});

test("the voice: brakes keep their figures, and a silent stretch is named without claiming how far the rate moved", () => {
  const s = snapshot({ epoch: 10, rate: 20, supply: 1_040_000n, staked: 100_000n });
  const grown = ruleDecision(input(s, [{ epoch: 8, totalSupply: 1_000_000n }]));
  assert.match(grown.reasoning, /Supply grew 4\.00% over the last 6 epochs, past the 3\.00% brake\. The Chair declines to ease and holds the wanted rate at 0 bps\./);
  const calm = ruleDecision(input(snapshot({ epoch: 10, rate: 0, supply: 1_010_000n, staked: 500_000n }), [{ epoch: 8, totalSupply: 1_000_000n }]));
  assert.match(calm.reasoning, /Supply moved 1\.00% over the last 6 epochs, inside the \+-3\.00% brake\. The Chair keeps its hand off the brake\./);
  const silent = (lastSet: number | null) => ruleDecision(input(snapshot({ epoch: 12, rate: 0, supply: 1_000_000n, staked: 500_000n, lastSet }))).reasoning;
  assert.match(silent(8), /^The Chair was silent for 3 epochs\. In a silent epoch the contract moves the rate toward zero without asking\. The Chair notes its place\.\n/);
  assert.match(silent(10), /^The Chair was silent for 1 epoch\. /);
  assert.doesNotMatch(silent(11), /silent/, "it set a rate last epoch");
  assert.doesNotMatch(silent(null), /silent/, "a rate never set is not a silence");
});

test("the voice: no dashes other than the hyphen, no emoji, no price talk, in any situation the rule chair meets", () => {
  for (const staked of [null, 0n, 100_000n, 480_000n, 500_000n, 520_000n, 900_000n]) {
    for (const rate of [-200, -50, -3, 0, 3, 50, 200]) {
      for (const lastSet of [null, 5, 10]) {
        const text = ruleDecision(input(snapshot({ epoch: 11, rate, supply: 1_000_000n, staked, lastSet }), [{ epoch: 6, totalSupply: 1_050_000n }])).reasoning;
        assert.doesNotMatch(text, /[\u2013\u2014\p{Extended_Pictographic}!]|price|moon/u, text);
      }
    }
  }
});

test("same input, same output (the log can be audited by rerunning it)", () => {
  const i = input(snapshot({ rate: 10, supply: 7_777_777n, staked: 1_234_567n }), [{ epoch: 4, totalSupply: 7_000_000n }]);
  assert.deepEqual(ruleDecision(i), ruleDecision(i));
});

test("staked share uses floor integer division", () => {
  assert.equal(stakedShareBps(1n, 3n), 3333);
  assert.equal(stakedShareBps(10n ** 30n, 3n * 10n ** 30n), 3333);
});
