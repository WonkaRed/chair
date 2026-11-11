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

const common = { velocityBps: 2000, transfersPerEpoch: 5, impeachThresholdBps: 5000, votes: [] } as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    ...common, id: "steady-easing", stakedBps: 3000,
    title: "Steady easing",
    description: "The chair raises the rate by 25 bps per epoch to +100 and holds it. 30% of the supply is staked.",
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
