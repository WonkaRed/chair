import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleDecision, stakedShareBps } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

const input = (s = snapshot(), history: DecisionInput["history"] = []): DecisionInput => ({ snapshot: s, history, window: { lo: -50, hi: 50 } });

test("little staked: eases one step toward the wanted rate", () => {
  const p = ruleDecision(input(snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n })));
  assert.equal(p.rateBps, 50); // 10% staked asks for +100, one step is 50
  assert.match(p.reasoning, /10\.00% of all coins are staked, and the Chair would like 50\.00%/);
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
  assert.match(grown.reasoning, /Supply is up 4\.00%/);
  const t = snapshot({ epoch: 10, rate: -20, supply: 960_000n, staked: 900_000n });
  const shrunk = ruleDecision(input(t, [{ epoch: 8, totalSupply: 1_000_000n }]));
  assert.equal(shrunk.rateBps, 0);
  assert.match(shrunk.reasoning, /Supply is down 4\.00%/);
});

test("history older than the lookback is ignored", () => {
  const s = snapshot({ epoch: 20, rate: 0, supply: 2_000_000n, staked: 100_000n });
  assert.equal(ruleDecision(input(s, [{ epoch: 3, totalSupply: 1_000_000n }])).rateBps, 50);
});

test("no staking figures: walks the rate back to 0 and says so", () => {
  const p = ruleDecision(input(snapshot({ rate: 40, staked: null })));
  assert.equal(p.rateBps, 0);
  assert.match(p.reasoning, /cannot see how many coins are staked/);
});

const rule = (s: ReturnType<typeof snapshot>, history: DecisionInput["history"] = []) => ruleDecision(input(s, history));

test("the voice: the minutes say what the rate does, in percent and plain words, decision first", () => {
  const mint = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 480_000n }));
  assert.equal(mint.rateBps, 5);
  assert.equal(
    mint.reasoning,
    "The Committee of One has met. The Chair moves the rate from zero to a printing rate of 0.05%: 0.05% more coins are printed every 60 seconds for holders who staked. " +
      "48.00% of all coins are staked, and the Chair would like 50.00%. The Chair thanks itself for its service.",
  );
  const burn = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 520_000n }));
  assert.equal(burn.rateBps, -5);
  assert.match(burn.reasoning, /^The Committee of One has met\. The Chair moves the rate from zero to a burn rate of 0\.05%: 0\.05% of every transfer is burned\./);
  assert.match(burn.reasoning, /The motion carries unanimously\.$/);
  const zero = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 500_000n }));
  assert.equal(zero.rateBps, 0);
  assert.match(zero.reasoning, /^The Committee of One has met\. The Chair holds the rate: no coins are printed and none are burned\. 50\.00% of all coins are staked, and the Chair would like 50\.00%\. The Chair calls this leadership\.$/);
  const keepsPrinting = rule(snapshot({ rate: 3, supply: 1_000_000n, staked: 490_000n }));
  assert.equal(keepsPrinting.rateBps, 3);
  assert.match(keepsPrinting.reasoning, /^The Committee of One has met\. The Chair holds the rate: 0\.03% more coins are printed every 60 seconds for holders who staked\./);
  const keepsBurning = rule(snapshot({ rate: -3, supply: 1_000_000n, staked: 510_000n }));
  assert.match(keepsBurning.reasoning, /^The Committee of One has met\. The Chair holds the rate: 0\.03% of every transfer is burned\./);
  const cut = rule(snapshot({ rate: 20, supply: 1_000_000n, staked: 520_000n }));
  assert.match(cut.reasoning, /The Chair moves the rate from a printing rate of 0\.20% to a burn rate of 0\.05%: 0\.05% of every transfer is burned\./);
  const stepped = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n }));
  assert.equal(stepped.rateBps, 50);
  assert.match(stepped.reasoning, /The Chair would go further, to a printing rate of 1\.00%, but the contract lets it move the rate by at most 0\.50% per meeting\./);
  assert.match(stepped.reasoning, /The Chair files no objection\.$/);
  const empty = rule(snapshot({ rate: 20, supply: 1_000_000n, staked: 0n }));
  assert.match(empty.reasoning, /: no coins are printed while nobody has staked\./, "a mint needs someone staked, and the minutes do not claim one");
  const none = rule(snapshot({ rate: 40, staked: null }));
  assert.equal(none.rateBps, 0);
  assert.equal(
    none.reasoning,
    "The Committee of One has met. The Chair moves the rate from a printing rate of 0.40% to zero: no coins are printed and none are burned. " +
      "The Chair cannot see how many coins are staked, so it steers toward a rate of zero. The motion carries unanimously.",
  );
  assert.doesNotMatch(rule(snapshot({ rate: 40, staked: null, supply: 0n })).reasoning, /nobody has staked/);
});

test("the voice: the meeting length is the epoch length of the chain, in seconds or minutes", () => {
  const at = (epochMs: number) => {
    const s = snapshot({ rate: 5, supply: 1_000_000n, staked: 480_000n });
    return ruleDecision(input({ ...s, params: { ...s.params, epochMs } })).reasoning;
  };
  assert.match(at(90_000), /every 90 seconds for holders who staked/);
  assert.match(at(1_000), /every 1 second for holders who staked/);
  assert.match(at(3_600_000), /every 60 minutes for holders who staked/);
  assert.match(at(60_000), /every 60 seconds/, "one minute stays in seconds");
});

test("the voice: supply is named over the span the history covers, and the brake says what the Chair aims for", () => {
  const s = snapshot({ epoch: 10, rate: 20, supply: 1_040_000n, staked: 100_000n });
  const grown = rule(s, [{ epoch: 8, totalSupply: 1_000_000n }]);
  assert.match(grown.reasoning, /Supply is up 4\.00% over the last 2 meetings\. That is past the 3\.00% the Chair allows itself, so it aims for no printing\./);
  const shrunk = rule(snapshot({ epoch: 10, rate: -20, supply: 960_000n, staked: 900_000n }), [{ epoch: 9, totalSupply: 1_000_000n }]);
  assert.match(shrunk.reasoning, /Supply is down 4\.00% since the last meeting\. That is past the 3\.00% the Chair allows itself, so it aims for no burning\./);
  const calm = rule(snapshot({ epoch: 10, rate: 0, supply: 1_010_000n, staked: 500_000n }), [{ epoch: 4, totalSupply: 1_000_000n }]);
  assert.match(calm.reasoning, /Supply is up 1\.00% over the last 6 meetings\. 49\.50% of all coins/);
  assert.doesNotMatch(calm.reasoning, /allows itself/);
  const still = rule(snapshot({ epoch: 10, rate: 0, supply: 1_000_050n, staked: 500_000n }), [{ epoch: 4, totalSupply: 1_000_000n }]);
  assert.match(still.reasoning, /Supply has moved less than 0\.01% over the last 6 meetings\./);
  assert.doesNotMatch(rule(snapshot({ epoch: 10 })).reasoning, /Supply/, "no history, no supply sentence");
});

test("the voice: a silent stretch is named without claiming how far the rate moved", () => {
  const silent = (lastSet: number | null) => rule(snapshot({ epoch: 12, rate: 0, supply: 1_000_000n, staked: 500_000n, lastSet })).reasoning;
  assert.match(silent(8), /^The Committee of One has met\. [^.]*\. The Chair was silent for 3 meetings, and in a silent meeting the contract moves the rate toward zero without asking\./);
  assert.match(silent(10), /The Chair was silent for 1 meeting, and/);
  assert.doesNotMatch(silent(11), /silent/, "it set a rate last epoch");
  assert.doesNotMatch(silent(null), /silent/, "a rate never set is not a silence");
});

test("the voice: no jargon reaches the reader, in any situation the rule chair meets", () => {
  for (const staked of [null, 0n, 100_000n, 480_000n, 500_000n, 520_000n, 900_000n]) {
    for (const rate of [-200, -50, -3, 0, 3, 50, 200]) {
      for (const lastSet of [null, 5, 10]) {
        const text = ruleDecision(input(snapshot({ epoch: 11, rate, supply: 1_000_000n, staked, lastSet }), [{ epoch: 6, totalSupply: 1_050_000n }])).reasoning;
        assert.doesNotMatch(text, /\bbps\b|basis point|epoch|\bbrake\b|staked share|supply delta|\n/i, text);
      }
    }
  }
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
