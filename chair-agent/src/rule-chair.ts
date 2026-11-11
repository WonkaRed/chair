import type { Chair, DecisionInput, Proposal } from "./types.js";

/**
 * rule-v1, in three sentences. The chair wants half of the supply staked: it eases in proportion to
 * how far staking falls short of that and tightens in proportion to how far it overshoots, asking for
 * (5000 - staked share in bps) / 40 bps, so nothing staked asks for +125 and everything staked for -125.
 * It never eases after supply grew more than 3% over the last 6 epochs and never tightens after it
 * shrank by more than 3%. It moves toward that rate one contract step at a time and ignores gaps under
 * 5 bps unless the wanted rate is 0; with no staking figures at all it has nothing to steer by and walks the rate back to 0.
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

function pct(bps: bigint | number): string {
  const n = Number(bps);
  return `${(n / 100).toFixed(2)}%`;
}

export function ruleDecision(input: DecisionInput): Proposal {
  const { snapshot } = input;
  const { maxRateBps, maxStepBps } = snapshot.params;
  const current = snapshot.policy.rateBps;
  const lines: string[] = [];

  let wanted = 0;
  if (snapshot.staking === null || snapshot.totalSupply === 0n) {
    lines.push("No staking figures are available, so there is nothing to steer by: the wanted rate is 0 bps.");
  } else {
    const share = stakedShareBps(snapshot.staking.totalStaked, snapshot.totalSupply);
    wanted = Math.trunc((Number(TARGET_STAKED_BPS) - share) / BPS_PER_RATE_BPS);
    const side = share < TARGET_STAKED_BPS ? "below" : share > TARGET_STAKED_BPS ? "above" : "at";
    lines.push(
      `Staked share of supply is ${pct(share)}, ${side} the ${pct(TARGET_STAKED_BPS)} target, which asks for ${wanted} bps.`,
    );
    if (snapshot.staking.totalStaked === 0n && wanted > 0) {
      lines.push("Nothing is staked, so an easing rate mints nothing until someone stakes.");
    }
  }

  const drift = supplyDriftBps(input);
  if (drift !== null) {
    if (drift > BRAKE_BPS && wanted > 0) {
      lines.push(`Supply grew ${pct(drift)} over the last ${LOOKBACK_EPOCHS} epochs, past ${pct(BRAKE_BPS)}, so easing is held at 0 bps.`);
      wanted = 0;
    } else if (drift < -BRAKE_BPS && wanted < 0) {
      lines.push(`Supply shrank ${pct(-drift)} over the last ${LOOKBACK_EPOCHS} epochs, past ${pct(BRAKE_BPS)}, so tightening is held at 0 bps.`);
      wanted = 0;
    } else {
      lines.push(`Supply moved ${pct(drift)} over the last ${LOOKBACK_EPOCHS} epochs, inside the +-${pct(BRAKE_BPS)} brake.`);
    }
  }

  wanted = Math.max(-maxRateBps, Math.min(maxRateBps, wanted));
  const gap = wanted - current;
  let rate = current;
  if (gap === 0 || (wanted !== 0 && Math.abs(gap) < DEADBAND_BPS)) {
    lines.push(`The wanted rate ${wanted} bps is within ${DEADBAND_BPS} bps of the current ${current} bps: holding.`);
  } else {
    rate = current + Math.max(-maxStepBps, Math.min(maxStepBps, gap));
    lines.push(`Moving from ${current} bps toward ${wanted} bps by at most ${maxStepBps} bps: ${rate} bps.`);
  }
  return { rateBps: rate, reasoning: lines.join("\n") };
}

export const ruleChair: Chair = {
  name: RULE_NAME,
  propose: (input) => Promise.resolve(ruleDecision(input)),
};
