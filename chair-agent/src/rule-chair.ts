import type { Chair, DecisionInput, Proposal } from "./types.js";

/**
 * rule-v1. The chair wants half of the supply staked: it eases in proportion to
 * how far staking falls short of that and tightens in proportion to how far it overshoots, asking for
 * (5000 - staked share in bps) / 40 bps, so nothing staked asks for +125 and everything staked for -125.
 * It never eases after supply grew more than 3% over the last 6 epochs and never tightens after it
 * shrank by more than 3%. It moves toward that rate one contract step at a time and ignores gaps under
 * 5 bps unless the wanted rate is 0; with no staking figures at all it has nothing to steer by and walks the rate back to 0.
 *
 * It writes the minutes in the chair's voice, "The Chair", a deadpan parody of a central banker, for a reader who has never seen a blockchain:
 * percent with two decimals (never bps), what the rate does in plain words, "meetings" and the meeting length (never epochs). The sentences are
 * fixed templates picked by the situation (silence, no staking, brake, hold, move, held back by the step limit), and every
 * figure in them is one of the inputs or the rate computed from them, so the text can be checked and never claims more than the numbers.
 */
export const RULE_NAME = "rule-v1";
export const TARGET_STAKED_BPS = 5000n;
export const BPS_PER_RATE_BPS = 40;
export const LOOKBACK_EPOCHS = 6;
export const BRAKE_BPS = 300n;
export const DEADBAND_BPS = 5;

export function stakedShareBps(totalStaked: bigint, totalSupply: bigint): number {
  return Number((totalStaked * 10_000n) / totalSupply);
}

/** Supply change in bps over the lookback window, or null with too little history. */
export function supplyDriftBps(input: DecisionInput): bigint | null {
  const from = input.snapshot.policy.epoch - LOOKBACK_EPOCHS;
  const oldest = input.history.find((h) => h.epoch >= from);
  if (oldest === undefined || oldest.totalSupply === 0n) return null;
  return ((input.snapshot.totalSupply - oldest.totalSupply) * 10_000n) / oldest.totalSupply;
}

/** A size in bps as the percent a stranger reads: 5 is "0.05%", -10 is "0.10%". The sign is never part of the figure; the words say whether it prints or burns. */
export function percent(bps: bigint | number): string {
  return `${(Math.abs(Number(bps)) / 100).toFixed(2)}%`;
}

/** The epoch length in the words the minutes use ("90 seconds"), exact for whole seconds and whole minutes of two or more. */
export function meetingLength(epochMs: number): string {
  if (epochMs >= 120_000 && epochMs % 60_000 === 0) return `${epochMs / 60_000} minutes`;
  const seconds = epochMs / 1000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

/** What a rate does while it stands (SPEC "Epochs and rollover", "Transfer burn"): the one sentence a stranger needs about it. A mint needs someone staked, so say so when it is known that nobody has. */
export function rateEffect(rate: number, every: string, nobodyStaked: boolean): string {
  if (rate > 0) return nobodyStaked ? "no coins are printed while nobody has staked" : `${percent(rate)} more coins are printed every ${every} for holders who staked`;
  if (rate < 0) return `${percent(rate)} of every transfer is burned`;
  return "no coins are printed and none are burned";
}

/** A rate as a noun phrase, for "from X to Y". */
function rateName(rate: number): string {
  return rate > 0 ? `a printing rate of ${percent(rate)}` : rate < 0 ? `a burn rate of ${percent(rate)}` : "zero";
}

/** Supply change over the lookback window as the sentence the minutes carry, or null with too little history. The span is the one the history really covers. */
export function supplyMoved(input: DecisionInput): { sentence: string; bps: bigint } | null {
  const bps = supplyDriftBps(input);
  const oldest = input.history.find((h) => h.epoch >= input.snapshot.policy.epoch - LOOKBACK_EPOCHS);
  if (bps === null || oldest === undefined) return null;
  const n = input.snapshot.policy.epoch - oldest.epoch;
  const span = n === 1 ? "since the last meeting" : `over the last ${n} meetings`;
  const how = bps > 0n ? `up ${percent(bps)}` : bps < 0n ? `down ${percent(bps)}` : "has moved less than 0.01%";
  return { sentence: bps === 0n ? `Supply ${how} ${span}.` : `Supply is ${how} ${span}.`, bps };
}

export function ruleDecision(input: DecisionInput): Proposal {
  const { snapshot } = input;
  const { maxRateBps, maxStepBps, epochMs } = snapshot.params;
  const current = snapshot.policy.rateBps;
  const { epoch, lastSetEpoch } = snapshot.policy;
  const every = meetingLength(epochMs);
  const nobodyStaked = snapshot.staking !== null && snapshot.staking.totalStaked === 0n;

  // Meetings the chair stayed silent since it last set a rate; the contract has decayed the rate toward zero in each.
  const silent = lastSetEpoch === null ? 0 : epoch - lastSetEpoch - 1;
  const lines: string[] = ["The Committee of One has met."];

  let wanted = 0;
  if (snapshot.staking !== null && snapshot.totalSupply !== 0n) {
    wanted = Math.trunc((Number(TARGET_STAKED_BPS) - stakedShareBps(snapshot.staking.totalStaked, snapshot.totalSupply)) / BPS_PER_RATE_BPS);
  }
  const drift = supplyMoved(input);
  const brake = drift !== null && ((drift.bps > BRAKE_BPS && wanted > 0) || (drift.bps < -BRAKE_BPS && wanted < 0));
  if (brake) wanted = 0;
  wanted = Math.max(-maxRateBps, Math.min(maxRateBps, wanted));

  const gap = wanted - current;
  const rate = gap === 0 || (wanted !== 0 && Math.abs(gap) < DEADBAND_BPS) ? current : current + Math.max(-maxStepBps, Math.min(maxStepBps, gap));
  // The decision first, in what the rate does.
  lines.push(
    rate === current
      ? `The Chair holds the rate: ${rateEffect(rate, every, nobodyStaked)}.`
      : `The Chair moves the rate from ${rateName(current)} to ${rateName(rate)}: ${rateEffect(rate, every, nobodyStaked)}.`,
  );
  if (rate !== wanted && rate !== current) {
    lines.push(`The Chair would go further, to ${rateName(wanted)}, but the contract lets it move the rate by at most ${percent(maxStepBps)} per meeting.`);
  }

  if (silent > 0) {
    lines.push(`The Chair was silent for ${silent} ${silent === 1 ? "meeting" : "meetings"}, and in a silent meeting the contract moves the rate toward zero without asking.`);
  }
  if (drift !== null) {
    lines.push(
      brake
        ? `${drift.sentence} That is past the ${percent(BRAKE_BPS)} the Chair allows itself, so it aims for ${drift.bps > 0n ? "no printing" : "no burning"}.`
        : drift.sentence,
    );
  }
  if (snapshot.staking === null || snapshot.totalSupply === 0n) {
    lines.push("The Chair cannot see how many coins are staked, so it steers toward a rate of zero.");
  } else {
    lines.push(`${percent(stakedShareBps(snapshot.staking.totalStaked, snapshot.totalSupply))} of all coins are staked, and the Chair would like ${percent(TARGET_STAKED_BPS)}.`);
  }

  lines.push(rate === current ? "The Chair calls this leadership." : rate !== wanted ? "The Chair files no objection." : rate > current ? "The Chair thanks itself for its service." : "The motion carries unanimously.");
  return { rateBps: rate, reasoning: lines.join(" ") };
}

export const ruleChair: Chair = {
  name: RULE_NAME,
  propose: (input) => Promise.resolve(ruleDecision(input)),
};
