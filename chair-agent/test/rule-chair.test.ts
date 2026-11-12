import assert from "node:assert/strict";
import { test } from "node:test";
import { formulaRate, mandateRate, ruleDecision, stakedShareBps, supplyMoved } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

const COIN = 10n ** 24n;
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

test("no brake: supply growth or shrinkage never changes the rate the mandate asks for, only what the minutes report", () => {
  const s = snapshot({ epoch: 10, rate: 20, supply: 1_400_000n * COIN, staked: 100_000n * COIN });
  const grown = ruleDecision(input(s, [{ epoch: 8, totalSupply: 1_000_000n * COIN }]));
  assert.equal(grown.rateBps, 70); // 10% staked asks for +100, one step from 20 is 50 more
  assert.match(grown.reasoning, /Supply is up 400,000 coins over the last 2 meetings\./);
  assert.doesNotMatch(grown.reasoning, /allows itself|no printing/);
  const t = snapshot({ epoch: 10, rate: -20, supply: 600_000n * COIN, staked: 540_000n * COIN });
  const shrunk = ruleDecision(input(t, [{ epoch: 8, totalSupply: 1_000_000n * COIN }]));
  assert.equal(shrunk.rateBps, -70);
  assert.match(shrunk.reasoning, /Supply is down 400,000 coins over the last 2 meetings\./);
});

test("history older than the lookback is ignored", () => {
  const s = snapshot({ epoch: 20, rate: 0, supply: 2_000_000n, staked: 100_000n });
  const p = ruleDecision(input(s, [{ epoch: 3, totalSupply: 1_000_000n }]));
  assert.equal(p.rateBps, 50);
  assert.doesNotMatch(p.reasoning, /Supply/);
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
    "The Committee of One has met. The Chair moves the rate from neither printing nor burning to printing 0.05% a day, a little at every 60-second meeting, for holders who staked. " +
      "48.00% of all coins are staked, and the Chair would like 50.00%. The more holders stake, the less the Chair prints. The Chair thanks itself for its service.",
  );
  const burn = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 520_000n }));
  assert.equal(burn.rateBps, -5);
  assert.match(burn.reasoning, /^The Committee of One has met\. The Chair moves the rate from neither printing nor burning to burning 0\.05% of every transfer\. 52\.00%/);
  assert.match(burn.reasoning, /The motion carries unanimously\.$/);
  const zero = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 500_000n }));
  assert.equal(zero.rateBps, 0);
  assert.match(zero.reasoning, /^The Committee of One has met\. The Chair holds the rate: no coins are printed and none are burned\. 50\.00% of all coins are staked, and the Chair would like 50\.00%\. The more holders stake, the less the Chair prints\. The Chair calls this leadership\.$/);
  const keepsPrinting = rule(snapshot({ rate: 3, supply: 1_000_000n, staked: 490_000n }));
  assert.equal(keepsPrinting.rateBps, 3);
  assert.match(keepsPrinting.reasoning, /^The Committee of One has met\. The Chair holds the rate: 0\.03% more coins are printed a day, a little at every 60-second meeting, for holders who staked\./);
  const keepsBurning = rule(snapshot({ rate: -3, supply: 1_000_000n, staked: 510_000n }));
  assert.match(keepsBurning.reasoning, /^The Committee of One has met\. The Chair holds the rate: 0\.03% of every transfer is burned\./);
  const cut = rule(snapshot({ rate: 20, supply: 1_000_000n, staked: 520_000n }));
  assert.match(cut.reasoning, /The Chair moves the rate from printing 0\.20% a day to burning 0\.05% of every transfer\. 52\.00%/);
  const stepped = rule(snapshot({ rate: 0, supply: 1_000_000n, staked: 100_000n }));
  assert.equal(stepped.rateBps, 50);
  assert.match(stepped.reasoning, /The Chair would go further, to printing 1\.00% a day, but the contract lets it move the rate by at most 0\.50% per meeting\./);
  assert.match(stepped.reasoning, /The Chair files no objection\.$/);
  const toZero = rule(snapshot({ rate: 100, supply: 1_000_000n, staked: 500_000n }));
  assert.equal(toZero.rateBps, 50);
  assert.match(toZero.reasoning, /The Chair would go further, all the way to a rate of zero, but the contract lets it move the rate by at most 0\.50% per meeting\./);
  assert.doesNotMatch(toZero.reasoning, /to neither printing nor burning, but/);
  const empty = rule(snapshot({ rate: 20, supply: 1_000_000n, staked: 0n }));
  assert.match(empty.reasoning, /to printing 0\.70% a day, though no coins are printed while nobody has staked\./, "a mint needs someone staked, and the minutes do not claim one");
  const none = rule(snapshot({ rate: 40, staked: null }));
  assert.equal(none.rateBps, 0);
  assert.equal(
    none.reasoning,
    "The Committee of One has met. The Chair moves the rate from printing 0.40% a day to neither printing nor burning. " +
      "The Chair cannot see how many coins are staked, so it steers toward a rate of zero. The motion carries unanimously.",
  );
  assert.doesNotMatch(rule(snapshot({ rate: 40, staked: null, supply: 0n })).reasoning, /nobody has staked/);
});

test("the voice: a change of rate names each rate once, for printing and burning, a sign change, to zero and from zero, and never says the new rate a second time", () => {
  const says = (rate: number, staked: bigint): string => rule(snapshot({ rate, supply: 1_000_000n, staked })).reasoning.replace(/ \d+\.\d\d% of all coins are staked.*$/, "");
  assert.equal(says(15, 480_000n), "The Committee of One has met. The Chair moves the rate from printing 0.15% a day to printing 0.05% a day, a little at every 60-second meeting, for holders who staked.");
  assert.equal(says(-10, 480_000n), "The Committee of One has met. The Chair moves the rate from burning 0.10% of every transfer to printing 0.05% a day, a little at every 60-second meeting, for holders who staked.");
  assert.equal(says(10, 520_000n), "The Committee of One has met. The Chair moves the rate from printing 0.10% a day to burning 0.05% of every transfer.");
  assert.equal(says(-15, 520_000n), "The Committee of One has met. The Chair moves the rate from burning 0.15% of every transfer to burning 0.05% of every transfer.");
  assert.equal(says(40, 500_000n), "The Committee of One has met. The Chair moves the rate from printing 0.40% a day to neither printing nor burning.");
  assert.equal(says(0, 480_000n), "The Committee of One has met. The Chair moves the rate from neither printing nor burning to printing 0.05% a day, a little at every 60-second meeting, for holders who staked.");
  assert.equal(says(-40, 500_000n), "The Committee of One has met. The Chair moves the rate from burning 0.40% of every transfer to neither printing nor burning.");
  for (const [rate, staked] of [[15, 480_000n], [-10, 480_000n], [10, 520_000n], [0, 480_000n], [40, 500_000n]] as const) {
    assert.doesNotMatch(rule(snapshot({ rate, supply: 1_000_000n, staked })).reasoning, /more coins are printed|is burned/, "no second description of the new rate");
  }
  const empty = rule(snapshot({ rate: 20, supply: 1_000_000n, staked: 0n })).reasoning;
  assert.match(empty, /The Chair moves the rate from printing 0\.20% a day to printing 0\.70% a day, though no coins are printed while nobody has staked\./, "a mint needs someone staked, and the minutes do not claim one");
});

test("the voice: the meeting length is the epoch length of the chain, in seconds or minutes", () => {
  const at = (epochMs: number) => {
    const s = snapshot({ rate: 5, supply: 1_000_000n, staked: 480_000n });
    return ruleDecision(input({ ...s, params: { ...s.params, epochMs } })).reasoning;
  };
  assert.match(at(90_000), /a day, a little at every 90-second meeting, for holders who staked/);
  assert.match(at(1_000), /a day, a little at every 1-second meeting, for holders who staked/);
  assert.match(at(3_600_000), /a day, a little at every 60-minute meeting, for holders who staked/);
  assert.match(at(60_000), /a little at every 60-second meeting/, "one minute stays in seconds");
});

test("the voice: supply is named in coins, since the latest logged meeting and over the span between", () => {
  const grown = rule(snapshot({ epoch: 10, rate: 20, supply: 1_040_000n * COIN, staked: 100_000n * COIN }), [{ epoch: 8, totalSupply: 1_000_000n * COIN }]);
  assert.match(grown.reasoning, /Supply is up 40,000 coins over the last 2 meetings\. 9\.61% of all coins/);
  const shrunk = rule(snapshot({ epoch: 10, rate: -20, supply: 960_000n * COIN, staked: 900_000n * COIN }), [{ epoch: 9, totalSupply: 1_000_000n * COIN }]);
  assert.match(shrunk.reasoning, /Supply is down 40,000 coins since the last meeting\. 93\.75% of all coins/);
  const still = rule(snapshot({ epoch: 10, rate: 0, supply: 1_000_000n * COIN, staked: 500_000n * COIN }), [{ epoch: 4, totalSupply: 1_000_000n * COIN }]);
  assert.match(still.reasoning, /Supply has not changed over the last 6 meetings\./);
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

test("the mandate: the more holders stake, the less the Chair prints, from +125 with nothing staked to -125 with everything", () => {
  const at = (staked: bigint | null, supply = 10_000n) => mandateRate(snapshot({ supply, staked }));
  assert.equal(at(0n), 125);
  assert.equal(at(4_000n), 25);
  assert.equal(at(5_000n), 0);
  assert.equal(at(6_000n), -25);
  assert.equal(at(10_000n), -125);
  assert.equal(at(null), 0, "no staking figures: nothing to steer by");
  assert.equal(at(5n, 0n), 0, "no supply");
  assert.ok(Object.is(at(5_001n), 0), "a truncated -0.025 is 0, not -0");
  assert.equal(at(50_000n), -200, "never beyond the contract's rate bound, whatever a node reports");
  let last = Infinity;
  for (let staked = 0n; staked <= 10_000n; staked += 137n) {
    const r = at(staked);
    assert.ok(r <= last, `staking ${staked} must not raise the rate`);
    last = r;
  }
});

test("the rule chair and the mandate agree, within the dead band and the contract step", () => {
  for (const staked of [0n, 100_000n, 300_000n, 480_000n, 520_000n, 700_000n, 1_000_000n]) {
    const s = snapshot({ epoch: 11, rate: 0, supply: 1_000_000n, staked });
    const m = mandateRate(s);
    assert.equal(ruleDecision(input(s)).rateBps, Math.abs(m) < 5 ? 0 : Math.max(-50, Math.min(50, m)), `staked ${staked}`);
  }
});

test("the rate is per day, in every minutes sentence the rule chair writes: a day is named whenever coins are printed, and no per-meeting or per-seconds figure appears", () => {
  for (const staked of [null, 0n, 100_000n, 480_000n, 500_000n, 520_000n, 900_000n]) {
    for (const rate of [-200, -50, -3, 0, 3, 50, 200]) {
      const text = ruleDecision(input(snapshot({ epoch: 11, rate, supply: 1_000_000n, staked }), [{ epoch: 6, totalSupply: 1_050_000n }])).reasoning;
      if (/more coins are printed/.test(text)) assert.match(text, /more coins are printed a day, a little at every 60-second meeting, for holders who staked/, text);
      assert.doesNotMatch(text, /every \d+ (?:second|minute)s?\b|each (?:meeting|epoch)|per epoch|every meeting|every epoch/i, text);
    }
  }
});

test("the minutes for +35, -35 and 0 a day at a 90-second epoch, word for word", () => {
  const at = (rate: number, staked: bigint) => {
    const s = snapshot({ rate, supply: 1_000_000n, staked });
    return rule({ ...s, params: { ...s.params, epochMs: 90_000, meetingsPerDay: 960 } }).reasoning;
  };
  assert.equal(
    at(35, 360_000n), // 36.00% staked asks for (5000 - 3600) / 40 = +35
    "The Committee of One has met. The Chair holds the rate: 0.35% more coins are printed a day, a little at every 90-second meeting, for holders who staked. " +
      "36.00% of all coins are staked, and the Chair would like 50.00%. The more holders stake, the less the Chair prints. The Chair calls this leadership.",
  );
  assert.equal(
    at(-35, 640_000n), // 64.00% staked asks for -35
    "The Committee of One has met. The Chair holds the rate: 0.35% of every transfer is burned. " +
      "64.00% of all coins are staked, and the Chair would like 50.00%. The more holders stake, the less the Chair prints. The Chair calls this leadership.",
  );
  assert.equal(
    at(0, 500_000n),
    "The Committee of One has met. The Chair holds the rate: no coins are printed and none are burned. " +
      "50.00% of all coins are staked, and the Chair would like 50.00%. The more holders stake, the less the Chair prints. The Chair calls this leadership.",
  );
});

test("supply is told in the coins it really moved, exactly, since the latest logged meeting", () => {
  const said = (supply: bigint, history: DecisionInput["history"]) => supplyMoved(input(snapshot({ epoch: 20, supply }), history))?.sentence ?? null;
  assert.equal(said(1_001_563n * COIN, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]), "Supply is up 1,563 coins since the last meeting.");
  assert.equal(said(1_000_001n * COIN, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]), "Supply is up 1 coin since the last meeting.");
  assert.equal(said(1_000_000n * COIN + 5n, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]), "Supply is up less than 1 coin since the last meeting.");
  assert.equal(said(999_000n * COIN, [{ epoch: 17, totalSupply: 1_000_000n * COIN }]), "Supply is down 1,000 coins over the last 3 meetings.");
  assert.equal(said(1_000_000n * COIN, [{ epoch: 19, totalSupply: 1_000_000n * COIN }]), "Supply has not changed since the last meeting.");
  assert.equal(said(12_345_678n * COIN, [{ epoch: 14, totalSupply: 1n * COIN }, { epoch: 19, totalSupply: 2n * COIN }]), "Supply is up 12,345,676 coins since the last meeting.", "the latest logged meeting, not the oldest");
  assert.equal(said(1n, [{ epoch: 13, totalSupply: 1n }]), null, "older than the lookback of 6 meetings");
  assert.equal(said(1n, []), null, "no history");
});

test("the formula is the rule chair's rate, always inside the contract's step", () => {
  for (const [rate, staked] of [[0, 100_000n], [3, 490_000n], [-50, 900_000n], [120, 0n], [200, 0n]] as const) {
    const s = snapshot({ rate, supply: 1_000_000n, staked });
    assert.equal(formulaRate(s), ruleDecision(input(s)).rateBps);
    assert.ok(Math.abs(formulaRate(s) - rate) <= 50 && Math.abs(formulaRate(s)) <= 200);
  }
});
