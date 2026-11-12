import { formulaRate, rateDoes, stakedShareBps, supplyMoved, TARGET_STAKED_BPS } from "./rule-chair.js";
import type { AnswerFault, DecisionInput } from "./types.js";

/**
 * The AI chair's choice of rate. The formula (rule-chair.ts `formulaRate`) is advice: the model may choose any whole rate within `BAND_BPS` of it that
 * the contract accepts, and says why by picking one of `REASONS`, sentences written here. Its choice is structured: no free text of the model's reaches
 * the minutes through the decision, so a reason on chain is always one of these, and always one that the agent has checked against the chain's numbers.
 *
 * The page (web/site/js/minutes.js `parseChoice`) reads `choiceLine` back from the minutes; chair-agent/test/choice.test.ts runs the page's reader on every
 * form this module writes, so the two cannot drift.
 */

/**
 * How far from the formula the AI chair may go, either way: half the contract's step of 50 bps a meeting. Wide enough that a choice is plainly the Chair's
 * (the formula's own dead band is 5 bps), narrow enough that the formula still leads and the contract's step still leashes it.
 */
export const BAND_BPS = 25;

/** What a reason may be checked against: the chain's numbers for this meeting, and the rate asked for (null while it is not yet chosen: a reason about it is then still possible). */
interface Facts {
  /** Share of all coins staked, in bps; null when the agent cannot see staking. */
  readonly stakedBps: number | null;
  /** The supply's net change since the last logged meeting, in base units; null with no such meeting. */
  readonly supplyDelta: bigint | null;
  readonly current: number;
  readonly formula: number;
  readonly chosen: number | null;
}

/**
 * The reasons the model may give. `because` is the fact or intent, as the minutes word it; `holds` is when it is true; `leans` is the side of the
 * formula a rate that takes this reason lies on (1 above it, -1 below, 0 either), so that a reason never sits beside a rate that points the other way; `lies` says where the
 * rate lies, in the words the model is shown.
 */
const REASONS = {
  stake_low: { because: "fewer than half of all coins are staked", leans: 1, lies: "at or above the formula's number", holds: (f: Facts) => f.stakedBps !== null && f.stakedBps < Number(TARGET_STAKED_BPS) },
  stake_high: { because: "more than half of all coins are staked", leans: -1, lies: "at or below the formula's number", holds: (f: Facts) => f.stakedBps !== null && f.stakedBps > Number(TARGET_STAKED_BPS) },
  supply_up: { because: "supply has grown since the Chair's last decision", leans: -1, lies: "at or below the formula's number", holds: (f: Facts) => f.supplyDelta !== null && f.supplyDelta > 0n },
  supply_down: { because: "supply has shrunk since the Chair's last decision", leans: 1, lies: "at or above the formula's number", holds: (f: Facts) => f.supplyDelta !== null && f.supplyDelta < 0n },
  steady: { because: "the Chair prefers to hold the rate steady", leans: 0, lies: "exactly the rate in effect", holds: (f: Facts) => f.chosen === null || f.chosen === f.current },
  smaller_move: { because: "the Chair prefers to move the rate by less than the formula does", leans: 0, lies: "nearer the rate in effect than the formula's number is", holds: (f: Facts) => f.chosen === null || Math.abs(f.chosen - f.current) < Math.abs(f.formula - f.current) },
  larger_move: { because: "the Chair prefers to move the rate by more than the formula does", leans: 0, lies: "farther from the rate in effect than the formula's number is", holds: (f: Facts) => f.chosen === null || Math.abs(f.chosen - f.current) > Math.abs(f.formula - f.current) },
} as const;

export type ModelReason = keyof typeof REASONS;
export const MODEL_REASONS = Object.keys(REASONS) as ModelReason[];

/** Why a rate was set, as the log records it: a model's reason, `formula` when the rule chair took the formula's number, `fallback` when the AI chair's answer could not be used. */
export type ReasonId = ModelReason | "formula" | "fallback";

/** What the minutes record of a choice, and the log: the formula's number, the one the Chair chose, and why. */
export interface Choice {
  readonly formulaBps: number;
  readonly chosenBps: number;
  readonly reason: ReasonId;
}

const factsOf = (input: DecisionInput, chosen: number | null): Facts => {
  const { staking, totalSupply, policy } = input.snapshot;
  return {
    stakedBps: staking === null || totalSupply === 0n ? null : stakedShareBps(staking.totalStaked, totalSupply),
    supplyDelta: supplyMoved(input)?.delta ?? null,
    current: policy.rateBps,
    formula: formulaRate(input.snapshot),
    chosen,
  };
};

/**
 * The rates an AI chair may choose: the band around the formula, inside the window the contract accepts now. The formula lies inside `RateWindow.around`, but not
 * always inside `RateWindow.acrossRollover` (a rollover may be crossed), so the band can be empty (`lo > hi`): then no choice exists and the AI chair is not asked.
 */
export const bandFor = (formula: number, window: DecisionInput["window"]): { lo: number; hi: number } => ({
  lo: Math.max(formula - BAND_BPS, window.lo),
  hi: Math.min(formula + BAND_BPS, window.hi),
});

/** Why `reason` cannot go with `rate`, or null: it must be true of the meeting and of the rate, and lie on the side of the formula the rate does. */
function reasonFault(input: DecisionInput, rate: number, reason: ModelReason): AnswerFault | null {
  const facts = factsOf(input, rate);
  const { holds, leans } = REASONS[reason];
  if (!holds(facts)) return "reason_not_true";
  if (leans !== 0 && rate !== facts.formula && Math.sign(rate - facts.formula) !== leans) return "reason_points_other_way";
  return null;
}

/** The reasons the model is shown: those that some rate in the band can have, with where that rate lies. A reason it could not give truthfully is never offered. */
export function offeredReasons(input: DecisionInput): { id: ModelReason; because: string; rate_lies: string }[] {
  const { lo, hi } = bandFor(formulaRate(input.snapshot), input.window);
  const rates = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  return MODEL_REASONS.filter((id) => rates.some((rate) => reasonFault(input, rate, id) === null)).map((id) => ({ id, because: REASONS[id].because, rate_lies: REASONS[id].lies }));
}

/** Why `rate` with `reason` may not be the AI chair's choice, or null when it may: inside the band and the window, and a reason that fits it. */
export function choiceFault(input: DecisionInput, rate: number, reason: ReasonId): AnswerFault | null {
  if (!MODEL_REASONS.some((id) => id === reason)) return "wrong_shape";
  const { lo, hi } = bandFor(formulaRate(input.snapshot), input.window);
  return !Number.isSafeInteger(rate) || rate < lo || rate > hi ? "rate_outside_band" : reasonFault(input, rate, reason as ModelReason);
}

/**
 * The line of the minutes that sets the formula's number beside the Chair's, in plain words, where `setBps` is the rate the contract took:
 * "The formula suggested printing 0.12% a day. The Chair chose printing 0.15% a day: fewer than half of all coins are staked."
 * "The formula suggested printing 0.12% a day. The Chair agreed: fewer than half of all coins are staked."
 * "The formula suggested printing 0.12% a day. The rule chair applied it."
 * and, when the window changed the rate after the choice, so that the line never says a rate was chosen or applied that was not set:
 * "The formula suggested printing 0.12% a day. The Chair asked for printing 0.15% a day: fewer than half of all coins are staked."
 * "The formula suggested printing 0.12% a day. The rule chair asked for it."
 * It states the reason and nothing about which way the rate went: the two rates beside it do, and a direction word is false for some pairs (burning, crossing zero).
 */
export function choiceLine({ formulaBps, chosenBps, reason }: Choice, setBps: number): string {
  const suggested = `The formula suggested ${rateDoes(formulaBps)}.`;
  const clamped = setBps !== chosenBps;
  if (reason === "formula" || reason === "fallback") return `${suggested} The rule chair ${clamped ? "asked for" : "applied"} it.`;
  const { because } = REASONS[reason];
  if (clamped) return `${suggested} The Chair asked for ${rateDoes(chosenBps)}: ${because}.`;
  if (chosenBps === formulaBps) return `${suggested} The Chair agreed: ${because}.`;
  return `${suggested} The Chair chose ${rateDoes(chosenBps)}: ${because}.`;
}
