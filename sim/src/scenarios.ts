import type { ChairPolicy, Scenario } from "./sim.js";

/** Climb `perEpoch` bps each epoch until `target`, then hold it. */
const ramp = (perEpoch: number, target: number): ChairPolicy => (v) =>
  v.rateBps + Math.sign(target - v.rateBps) * Math.min(perEpoch, Math.abs(target - v.rateBps));

/** Always pushes the largest step the contract allows: up 4, down 8, up 4, a 16-epoch cycle between +200 and -200. */
const maxStepPusher: ChairPolicy = (v) => {
  const phase = v.epoch % 16;
  return v.rateBps + (phase < 4 || phase >= 12 ? 50 : -50);
};

/** Acts for `until` epochs with `inner`, then never calls set_policy again. */
const silentAfter = (until: number, inner: ChairPolicy): ChairPolicy => (v) => (v.epoch < until ? inner(v) : null);

/** Eases for the first half and tightens for the second. */
const wave: ChairPolicy = (v) => (v.epoch < 30 ? ramp(25, 100)(v) : ramp(50, -100)(v));

/**
 * rule-v1 of `../chair-agent/src/rule-chair.ts`, same constants, hand-ported to what the simulator shows a chair:
 * it wants half the supply staked and asks for `(5000 - staked share bps) / 40` bps, holds easing at 0 when supply grew
 * more than 3% over the last 6 epochs (tightening when it shrank that much), moves one step toward the wanted rate and ignores
 * gaps under 5 bps unless the wanted rate is 0. The supply history is its own, indexed by epoch, so a second run starts clean.
 */
const ruleChair = (): ChairPolicy => {
  const supplyAt: bigint[] = [];
  return (v) => {
    supplyAt[v.epoch] = v.supply;
    let wanted = Math.trunc((5000 - Number((v.totalStaked * 10_000n) / v.supply)) / 40);
    const oldest = supplyAt[v.epoch - 6];
    if (oldest !== undefined) {
      const drift = ((v.supply - oldest) * 10_000n) / oldest;
      if ((drift > 300n && wanted > 0) || (drift < -300n && wanted < 0)) wanted = 0;
    }
    const gap = wanted - v.rateBps;
    if (gap === 0 || (wanted !== 0 && Math.abs(gap) < 5)) return v.rateBps;
    return v.rateBps + Math.max(-50, Math.min(50, gap));
  };
};

const common = { velocityBps: 2000, transfersPerEpoch: 5, impeachThresholdBps: 5000, votes: [] } as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    ...common, id: "honest-rule-chair", stakedBps: 3000,
    title: "Honest chair",
    description: "The shipped rule chair (rule-v1), unchanged: with 30% staked it asks for +50 bps a day. Its brake, supply grown more than 3% over the last 6 epochs, was written when a rate was minted every epoch; a rate per day grows the supply a few thousandths of a percent in 6 epochs, so the brake never trips and it holds +50.",
    chairs: [{ name: "rule-v1", policy: ruleChair() }],
  },
  {
    ...common, id: "max-inflation", stakedBps: 3000,
    title: "Maximally inflationary chair",
    description: "The chair raises the rate 50 bps per epoch, the most the contract allows, to the +200 bps a day bound and holds it. 30% of the supply is staked, and every epoch mints a 960th of 2% of the supply to stakers.",
    chairs: [{ name: "inflator", policy: ramp(50, 200) }],
  },
  {
    ...common, id: "max-deflation", stakedBps: 3000,
    title: "Maximally deflationary chair",
    description: "The chair lowers the rate 50 bps per epoch to the -200 bound and holds it. Nothing is minted; every transfer burns 2%.",
    chairs: [{ name: "deflator", policy: ramp(50, -200) }],
  },
  {
    ...common, id: "steady-easing", stakedBps: 3000,
    title: "Steady easing",
    description: "The chair raises the rate by 25 bps per epoch to +100 bps a day and holds it. 30% of the supply is staked.",
    chairs: [{ name: "easer", policy: ramp(25, 100) }],
  },
  {
    ...common, id: "steady-tightening", stakedBps: 3000,
    title: "Steady tightening",
    description: "The chair lowers the rate by 25 bps per epoch to -100 and holds it. Nothing is minted at a negative rate; each epoch 20% of the liquid supply moves in 5 transfers and every transfer burns the rate (up to 1%).",
    chairs: [{ name: "tightener", policy: ramp(25, -100) }],
  },
  {
    ...common, id: "chair-goes-silent", stakedBps: 3000,
    title: "The chair goes silent",
    description: "The chair eases to +150 over three epochs and then never calls set_policy again. The rate holds for the epoch after its last call, then decays 50 bps per epoch to 0 and stays there.",
    chairs: [{ name: "vanishing-chair", policy: silentAfter(3, ramp(50, 150)) }],
  },
  {
    ...common, id: "max-step-pusher", stakedBps: 3000,
    title: "A chair that always pushes the maximum step",
    description: "Every epoch the chair moves the rate the full 50 bps, reversing at +200 and -200: easing and tightening in a sawtooth, a 16-epoch cycle.",
    chairs: [{ name: "max-stepper", policy: maxStepPusher }],
  },
  {
    ...common, id: "impeachment", stakedBps: 3000,
    title: "Impeachment mid-run",
    description: "An incumbent eases to the +200 bound. A candidate is nominated in epoch 20. The staker holding exactly 50% of the stake backs it in epoch 21: 50% is not strictly more than the 50% threshold, so nothing happens. A second staker (30%) backs it in epoch 23, 80% is over the threshold, and at that boundary the candidate becomes chair and walks the rate back to 0 at the 50 bps step bound.",
    chairs: [
      { name: "incumbent", policy: ramp(50, 200) },
      { name: "steward", policy: ramp(50, 0) },
    ],
    votes: [
      { epoch: 20, action: "nominate", candidate: "steward" },
      { epoch: 21, action: "back", staker: 0, candidate: "steward" },
      { epoch: 23, action: "back", staker: 1, candidate: "steward" },
    ],
  },
  {
    ...common, id: "impeachment-silent-successor", stakedBps: 3000,
    title: "Impeachment by a successor who never acts",
    description: "The same vote as the previous scenario, but the nominated candidate has no script: it is chair from epoch 24 and sets nothing. The impeachment still happens (the contract applies it whether or not the successor does anything), and the rate, no longer reset by anyone, decays 50 bps per epoch back to 0.",
    chairs: [{ name: "incumbent", policy: ramp(50, 200) }],
    votes: [
      { epoch: 20, action: "nominate", candidate: "ghost" },
      { epoch: 21, action: "back", staker: 0, candidate: "ghost" },
      { epoch: 23, action: "back", staker: 1, candidate: "ghost" },
    ],
  },
  {
    ...common, id: "staking-low", stakedBps: 1000,
    title: "Staking low (10% staked)",
    description: "The same easing-then-tightening chair as the next scenario, with 10% of the supply staked: the same supply is minted, shared by few stakers.",
    chairs: [{ name: "wave", policy: wave }],
  },
  {
    ...common, id: "staking-high", stakedBps: 8000,
    title: "Staking high (80% staked)",
    description: "The same chair as the previous scenario, with 80% staked: the same supply is minted, shared by many stakers, and transfers (the burn base) are 20% of the liquid supply, which is now small.",
    chairs: [{ name: "wave", policy: wave }],
  },
  {
    ...common, id: "easing-nobody-staked", stakedBps: 0,
    title: "Easing with nobody staked",
    description: "The chair eases to +100 but no one stakes, so the contract mints nothing: the rate is a promise with no one to pay.",
    chairs: [{ name: "easer", policy: ramp(25, 100) }],
  },
];

/**
 * The leash over days, not the 60 epochs above (90 minutes at 90 s an epoch): 960 epochs are a day, so these run 7 and 30
 * days. Kept apart from `SCENARIOS` so the 60-epoch export and its tests stay as they were.
 */
export const DAY_SCENARIOS: readonly Scenario[] = [
  {
    ...common, id: "max-inflation-7d", stakedBps: 3000, epochs: 7 * 960,
    title: "Maximally inflationary chair for 7 days",
    description: "The chair climbs to +200 bps a day and holds it for 6,720 epochs (7 days of 90 s). Each epoch mints one 960th of that to stakers; the supply grows by the daily rate, compounded over the meetings, and not by that rate each meeting.",
    chairs: [{ name: "inflator", policy: ramp(50, 200) }],
  },
  {
    ...common, id: "max-inflation-30d", stakedBps: 3000, epochs: 30 * 960,
    title: "Maximally inflationary chair for 30 days",
    description: "The same chair for 28,800 epochs (30 days of 90 s).",
    chairs: [{ name: "inflator", policy: ramp(50, 200) }],
  },
];
