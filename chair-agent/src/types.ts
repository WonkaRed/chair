import type { Bounds, Rate } from "./bounds.js";

/** get_params, validated. Time is block time in milliseconds. */
export interface Params extends Bounds {
  readonly epochMs: number;
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
}

export interface DecisionInput {
  readonly snapshot: Snapshot;
  /** Oldest first, strictly before `snapshot.policy.epoch`. */
  readonly history: readonly HistoryPoint[];
  /** Rates the contract accepts for this call; a chair's answer is clamped into it afterwards. */
  readonly window: { readonly lo: number; readonly hi: number };
  readonly memory?: ChairMemory;
}

/** What a chair says it wants. Untrusted until `decide` has clamped and cleaned it. */
export interface Proposal {
  readonly rateBps: number;
  readonly reasoning: string;
}

export interface Chair {
  /** Short stable label recorded in the log, e.g. `rule-v1`. */
  readonly name: string;
  propose(input: DecisionInput, signal: AbortSignal): Promise<Proposal>;
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
}
