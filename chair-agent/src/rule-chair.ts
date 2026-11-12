import type { Chair, DecisionInput, Snapshot } from "./types.js";

/**
 * rule-v1. The chair wants half of the supply staked: it eases in proportion to
 * how far staking falls short of that and tightens in proportion to how far it overshoots, asking for
 * (5000 - staked share in bps) / 40 bps, so nothing staked asks for +125 and everything staked for -125. A positive rate is
 * basis points of supply per day, minted in equal parts at each of the day's meetings (SPEC "The leash in numbers"); a negative
 * rate is basis points of every transfer.
 * That rate is the mandate (`mandateRate`), "the more holders stake, the less the Chair prints", and every chair works to it.
 * It moves toward that rate one contract step at a time and ignores gaps under
 * 5 bps unless the wanted rate is 0; with no staking figures at all it has nothing to steer by and walks the rate back to 0.
 * The contract, not the chair, holds printing to at most 2.02% of supply a day.
 *
 * What this rule asks for at one meeting is the formula (`formulaRate`): the mandate, one contract step at a time. An AI chair is given it as advice and
 * may choose another rate near it (choice.ts); this chair always takes it.
 *
 * It writes the minutes in the chair's voice, "The Chair", a deadpan parody of a central banker, for a reader who has never seen a blockchain:
 * percent with two decimals (never bps), what the rate does in plain words, "meetings" and the meeting length (never epochs). The sentences are
 * fixed templates picked by the situation (silence, no staking, hold, move, held back by the step limit), and every
 * figure in them is one of the inputs or the rate computed from them, so the text can be checked and never claims more than the numbers.
 */
export const RULE_NAME = "rule-v1";
export const TARGET_STAKED_BPS = 5000n;
export const BPS_PER_RATE_BPS = 40;
export const LOOKBACK_EPOCHS = 6;
export const DEADBAND_BPS = 5;
/** The mandate in the one sentence a non-crypto reader can follow. */
export const MANDATE_SENTENCE = "The more holders stake, the less the Chair prints.";

/** The fixed book of closing lines. The rule chair picks by situation; an AI chair whose own remark is unusable closes on `FALLBACK_CLOSINGS`, one by meeting. */
export const CLOSING = {
  leadership: "The Chair calls this leadership.",
  noObjection: "The Chair files no objection.",
  thanks: "The Chair thanks itself for its service.",
  unanimous: "The motion carries unanimously.",
  recorded: "The Chair asks that this be recorded.",
  noComment: "The Chair has no further comment.",
} as const;
/** The lines that read true after any decision, whatever the rate did. */
export const FALLBACK_CLOSINGS: readonly string[] = [CLOSING.recorded, CLOSING.thanks, CLOSING.unanimous, CLOSING.noComment];

export function stakedShareBps(totalStaked: bigint, totalSupply: bigint): number {
  return Number((totalStaked * 10_000n) / totalSupply);
}

/**
 * The mandate rate: (50% - staked share) / 40 bps a day, from +125 with nothing staked to -125 with everything staked, inside the contract's rate bound.
 * Zero when there are no staking figures to steer by.
 */
export function mandateRate(snapshot: Snapshot): number {
  if (snapshot.staking === null || snapshot.totalSupply === 0n) return 0;
  const wanted = Math.trunc((Number(TARGET_STAKED_BPS) - stakedShareBps(snapshot.staking.totalStaked, snapshot.totalSupply)) / BPS_PER_RATE_BPS);
  const { maxRateBps } = snapshot.params;
  return Math.max(-maxRateBps, Math.min(maxRateBps, wanted)) || 0; // `|| 0`: a truncated -0.025 is -0, which is not a rate to log
}

/** Supply change in bps over the last `lookback` meetings, from the oldest logged supply inside them, and the meetings that span covers; null with no such point. */
export function supplyDrift(input: DecisionInput, lookback: number): { bps: bigint; meetings: number } | null {
  const { epoch } = input.snapshot.policy;
  const oldest = input.history.find((h) => h.epoch >= epoch - lookback);
  if (oldest === undefined || oldest.totalSupply === 0n) return null;
  return { bps: ((input.snapshot.totalSupply - oldest.totalSupply) * 10_000n) / oldest.totalSupply, meetings: epoch - oldest.epoch };
}

/** A size in bps as the percent a stranger reads: 5 is "0.05%", -10 is "0.10%". The sign is never part of the figure; the words say whether it prints or burns. */
export function percent(bps: bigint | number): string {
  return `${(Math.abs(Number(bps)) / 100).toFixed(2)}%`;
}

/** The epoch length as a count and a unit, exact for whole seconds and whole minutes of two or more. */
function lengthParts(epochMs: number): [number, string] {
  return epochMs >= 120_000 && epochMs % 60_000 === 0 ? [epochMs / 60_000, "minute"] : [epochMs / 1000, "second"];
}

/** The epoch length in the words the minutes use ("90 seconds"). */
export function meetingLength(epochMs: number): string {
  const [n, unit] = lengthParts(epochMs);
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** The epoch length as the adjective of "meeting" ("90-second"). */
export function meetingAdjective(epochMs: number): string {
  const [n, unit] = lengthParts(epochMs);
  return `${n}-${unit}`;
}

/** What a rate does while it stands (SPEC "Epochs and rollover", "Transfer burn"): the one sentence a stranger needs about it. A mint needs someone staked, so say so when it is known that nobody has. */
export function rateEffect(rate: number, epochMs: number, nobodyStaked: boolean): string {
  if (rate > 0) {
    return nobodyStaked ? "no coins are printed while nobody has staked" : `${percent(rate)} more coins are printed a day, a little at every ${meetingAdjective(epochMs)} meeting, for holders who staked`;
  }
  if (rate < 0) return `${percent(rate)} of every transfer is burned`;
  return "no coins are printed and none are burned";
}

/** What a rate does, as the clause after "from" or "to": "printing 0.20% a day", "burning 0.10% of every transfer", "neither printing nor burning". */
export function rateDoes(rate: number): string {
  return rate > 0 ? `printing ${percent(rate)} a day` : rate < 0 ? `burning ${percent(rate)} of every transfer` : "neither printing nor burning";
}

/** A change of rate in one sentence that names each rate once; the words about the meetings come only after a printing rate and carry no figure. */
function moveSentence(current: number, rate: number, epochMs: number, nobodyStaked: boolean): string {
  const change = `The Chair moves the rate from ${rateDoes(current)} to ${rateDoes(rate)}`;
  if (rate <= 0) return `${change}.`;
  return nobodyStaked ? `${change}, though no coins are printed while nobody has staked.` : `${change}, a little at every ${meetingAdjective(epochMs)} meeting, for holders who staked.`;
}

/** One coin in base units: $CHAIR has 24 decimals (SPEC "Parameters"). */
const COIN = 10n ** 24n;

/** An amount of coins, whole and with thousands separators ("1,563 coins"); below one coin, "less than 1 coin". */
function coinsIn(units: bigint): string {
  const whole = units / COIN;
  return whole === 0n ? "less than 1 coin" : `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${whole === 1n ? "coin" : "coins"}`;
}

/**
 * How much the supply moved since the latest logged meeting, at most `LOOKBACK_EPOCHS` ago, as the sentence the minutes carry, or null with no such
 * meeting. The difference of two supplies the chain reported, net of any burn in between (a mint is due at each meeting, SPEC "Rollover"), shown in whole coins (the amount is cut down to a whole coin, not rounded);
 * `meetings` is the span the two reads really cover (1 when the Chair decided at the last meeting too).
 */
export function supplyMoved(input: DecisionInput): { sentence: string; delta: bigint; meetings: number } | null {
  const { epoch } = input.snapshot.policy;
  const last = input.history.at(-1);
  if (last === undefined || last.epoch < epoch - LOOKBACK_EPOCHS) return null;
  const delta = input.snapshot.totalSupply - last.totalSupply;
  const meetings = epoch - last.epoch;
  const span = meetings === 1 ? "since the last meeting" : `over the last ${meetings} meetings`;
  const sentence = delta === 0n ? `Supply has not changed ${span}.` : `Supply is ${delta > 0n ? "up" : "down"} ${coinsIn(delta < 0n ? -delta : delta)} ${span}.`;
  return { sentence, delta, meetings };
}

/**
 * The formula for this meeting: the mandate rate, reached one contract step at a time, and left where it is when the gap is under the dead band
 * (unless the mandate is 0). It always lies inside the contract's window.
 */
export function formulaRate(snapshot: Snapshot): number {
  const { maxStepBps } = snapshot.params;
  const current = snapshot.policy.rateBps;
  const wanted = mandateRate(snapshot);
  const gap = wanted - current;
  return gap === 0 || (wanted !== 0 && Math.abs(gap) < DEADBAND_BPS) ? current : current + Math.max(-maxStepBps, Math.min(maxStepBps, gap));
}

/**
 * The minutes' statement of a meeting that sets `rate`, up to its closing line: the same sentences whoever chose the rate. Every figure is an input or
 * the rate, so the same inputs give the same text and it never claims more than the numbers.
 */
export function statement(input: DecisionInput, rate: number): string {
  const { snapshot } = input;
  const { maxStepBps, epochMs } = snapshot.params;
  const current = snapshot.policy.rateBps;
  const { epoch, lastSetEpoch } = snapshot.policy;
  const nobodyStaked = snapshot.staking !== null && snapshot.staking.totalStaked === 0n;

  // Meetings the chair stayed silent since it last set a rate; the contract has decayed the rate toward zero in each.
  const silent = lastSetEpoch === null ? 0 : epoch - lastSetEpoch - 1;
  const lines: string[] = ["The Committee of One has met."];

  const wanted = mandateRate(snapshot);
  const drift = supplyMoved(input);

  // The decision first, in what the rate does.
  lines.push(
    rate === current
      ? `The Chair holds the rate: ${rateEffect(rate, epochMs, nobodyStaked)}.`
      : moveSentence(current, rate, epochMs, nobodyStaked),
  );
  // Only the formula is held back by the step, so only a rate that takes the formula's number can be said to be.
  if (rate === formulaRate(snapshot) && rate !== wanted && rate !== current) {
    lines.push(`The Chair would go further, ${wanted === 0 ? "all the way to a rate of zero" : `to ${rateDoes(wanted)}`}, but the contract lets it move the rate by at most ${percent(maxStepBps)} per meeting.`);
  }

  if (silent > 0) {
    lines.push(`The Chair was silent for ${silent} ${silent === 1 ? "meeting" : "meetings"}, and in a silent meeting the contract moves the rate toward zero without asking.`);
  }
  if (drift !== null) lines.push(drift.sentence);
  if (snapshot.staking === null || snapshot.totalSupply === 0n) {
    lines.push("The Chair cannot see how many coins are staked, so it steers toward a rate of zero.");
  } else {
    lines.push(`${percent(stakedShareBps(snapshot.staking.totalStaked, snapshot.totalSupply))} of all coins are staked, and the Chair would like ${percent(TARGET_STAKED_BPS)}. ${MANDATE_SENTENCE}`);
  }
  return lines.join(" ");
}

/** The rule chair's whole text: the minutes that set `rate`, the formula's unless the contract's window moved it, closed on a line of the book picked by the situation. */
export function ruleDecision(input: DecisionInput, rate = formulaRate(input.snapshot)): { rateBps: number; reasoning: string } {
  const { snapshot } = input;
  const current = snapshot.policy.rateBps;
  const closing = rate === current ? CLOSING.leadership : rate !== mandateRate(snapshot) ? CLOSING.noObjection : rate > current ? CLOSING.thanks : CLOSING.unanimous;
  return { rateBps: rate, reasoning: `${statement(input, rate)} ${closing}` };
}

export const ruleChair: Chair = {
  name: RULE_NAME,
  propose: (input) => Promise.resolve({ rateBps: formulaRate(input.snapshot), reason: "formula" }),
};
