import type { Bounds, Rate } from "./bounds.js";
import type { Choice, ReasonId } from "./choice.js";

/** get_params, validated. Time is block time in milliseconds. */
export interface Params extends Bounds {
  readonly epochMs: number;
  /** Meetings in a day; a positive rate is basis points of supply per day, minted in equal parts at each of them. */
  readonly meetingsPerDay: number;
  readonly startMs: number;
  readonly impeachThresholdBps: number;
  /** Share of the whole supply a candidate's backing must also exceed. */
  readonly quorumBps: number;
  readonly nominateBond: bigint;
}

/** get_policy, validated. */
export interface Policy {
  readonly epoch: number;
  readonly rateBps: number;
  readonly chair: string;
  readonly streak: number;
  readonly lastSetEpoch: number | null;
  readonly epochEndsMs: number;
}

/** Staking figures from get_reward_pool; absent while the deployed contract has no staking. */
export interface Staking {
  readonly totalStaked: bigint;
  readonly rewardPool: bigint;
}

/** Everything the chair reads from the chain for one decision, all at one block. */
export interface Snapshot {
  readonly blockTimeMs: number;
  readonly params: Params;
  readonly policy: Policy;
  readonly totalSupply: bigint;
  readonly staking: Staking | null;
}

/** The visitor pool's account at one block: the token's snapshot, and what the pool has staked and holds. */
export interface PoolView {
  readonly snapshot: Snapshot;
  readonly staked: bigint;
  /** The pool's coins that are not staked: what a stake draws on. */
  readonly liquid: bigint;
  /** First epoch in which the pool's stake may be unstaked. */
  readonly unlockEpoch: number;
  /** The candidate the pool backs; the pool never backs one, so anything but null is wrong. */
  readonly backing: string | null;
}

/** Supply as it stood when an earlier decision was made; read back from the decision log. */
export interface HistoryPoint {
  readonly epoch: number;
  readonly totalSupply: bigint;
}

/** What the decision log says about this chair's own record; absent when no log is at hand. */
export interface ChairMemory {
  /** Epochs in a row, ending with the one before this, in which an executed decision of the chair set exactly the rate now in effect. */
  readonly sameRateEpochs: number;
  /** Times the contract refused one of the chair's calls, as logged. */
  readonly refusals: number;
  /** The model-written remarks of the latest logged decisions, oldest first, at most `REMARK_MEMORY` of them. */
  readonly remarks: readonly string[];
}

export interface DecisionInput {
  readonly snapshot: Snapshot;
  /** Oldest first, strictly before `snapshot.policy.epoch`. */
  readonly history: readonly HistoryPoint[];
  /** Rates the contract accepts for this call; a chair's answer is clamped into it afterwards. */
  readonly window: { readonly lo: number; readonly hi: number };
  readonly memory?: ChairMemory;
}

/** What a chair says it wants, and why. The rate is untrusted until `decide` has clamped it; the reason is one of ours (choice.ts), never text. */
export interface Proposal {
  readonly rateBps: number;
  readonly reason: ReasonId;
}

/**
 * What was wrong with an AI chair's answer, as a label from this closed list: our own names for our own checks, never any text of the model's. The retry is
 * told which one it was (llm-chair.ts `FAULT_TEXT`).
 */
export type AnswerFault = "incomplete" | "not_json" | "wrong_shape" | "rate_outside_band" | "reason_not_true" | "reason_points_other_way";

export interface Chair {
  /** Short stable label recorded in the log, e.g. `rule-v1`. */
  readonly name: string;
  /** `previous` is set on the one retry: the fault of the answer this one replaces. */
  propose(input: DecisionInput, signal: AbortSignal, previous?: AnswerFault): Promise<Proposal>;
  /** The Chair's own closing remark on a decision of `rateBps`, or null when it has none worth keeping. Only a chair that calls a model has one. */
  remark?(input: DecisionInput, rateBps: number, signal: AbortSignal): Promise<string | null>;
}

/** The mandate as it stood for one decision, for the log. */
export interface MandateReport {
  /** What the mandate asks for, in bps a day: the more holders stake, the less the Chair prints. */
  readonly rateBps: number;
  /** Supply change over the last day (`meetings_per_day` meetings) in bps, and the meetings that span really covers; null with no history. */
  readonly supplyChangeBps: number | null;
  readonly supplyChangeMeetings: number | null;
}

export type ChairKind = "rule" | "llm" | "rule-fallback";

/** A decision that is safe to sign: the rate is a `Rate`, the text is cleaned, the hash is of that text. */
export interface Decision {
  readonly epoch: number;
  readonly previousRateBps: number;
  readonly rate: Rate;
  readonly reasoning: string;
  readonly reasoningHash: string;
  readonly chair: string;
  readonly kind: ChairKind;
  /** The closing sentence of the minutes when the model wrote it; null when the minutes close on a line of the fixed book, or the chair is not a model. */
  readonly remark: string | null;
  /** Absent when a decision is rebuilt from a log line to be sent again; nothing then logs it. */
  readonly mandate?: MandateReport;
  /** The formula's number, the Chair's and why: what the minutes' choice line says. Absent as `mandate` is. */
  readonly choice?: Choice;
}
