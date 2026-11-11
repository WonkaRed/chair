import type { Reader } from "./chain.js";
import { finalize, propose, windowFor, type DecideOptions } from "./decide.js";
import type { DecisionLog, EpochState } from "./log.js";
import { reasoningHash } from "./reasoning.js";
import type { Submitter } from "./signer.js";
import type { Decision, Snapshot } from "./types.js";

/** Send attempts per epoch for one decision; after that the agent sleeps until the next epoch. */
export const MAX_SEND_ATTEMPTS = 3;

export type TickResult =
  | { readonly status: "not-chair"; readonly snapshot: Snapshot }
  | { readonly status: "already-set"; readonly snapshot: Snapshot }
  | { readonly status: "dry-run"; readonly snapshot: Snapshot; readonly decision: Decision }
  /** This epoch's one decision cannot be sent (again); `reason` says why. Nothing more happens until the next epoch. */
  | { readonly status: "gave-up"; readonly snapshot: Snapshot; readonly reason: string }
  | {
      readonly status: "executed" | "rejected" | "send-failed";
      readonly snapshot: Snapshot;
      readonly decision: Decision;
      readonly txHash: string | null;
      readonly error: string | null;
      /** Failed sends of this decision so far this epoch, including this one when it failed. */
      readonly failedSends: number;
    };

export interface AgentDeps {
  readonly reader: Reader;
  readonly log: DecisionLog;
  readonly decideOptions: DecideOptions;
  readonly chairAccount: string;
  /** Absent in dry-run mode: nothing then signs, sends, or writes the log. */
  readonly submitter: Submitter | null;
}

/**
 * One pass: read the chain, and if this account is the chair and has not acted this epoch, either
 * re-send the decision already logged for the epoch (no new model call, no new log line) or make the one
 * decision of the epoch: ask the chair, re-read the chain, clamp against what the chain says now, record
 * the decision, send it, record the outcome.
 */
export async function tick(deps: AgentDeps): Promise<TickResult> {
  const snapshot = await deps.reader.snapshot();
  const { policy } = snapshot;
  if (policy.chair !== deps.chairAccount) return { status: "not-chair", snapshot };
  if (policy.lastSetEpoch === policy.epoch) return { status: "already-set", snapshot };

  if (deps.submitter !== null) {
    const prior = deps.log.epochState(policy.epoch);
    if (prior.decision !== null) return resend(deps, deps.submitter, snapshot, prior);
  }

  const proposed = await propose(snapshot, deps.log.history(policy.epoch), deps.decideOptions);
  // The chair may have taken a while: decide against the chain as it is now, not as it was.
  const fresh = await deps.reader.snapshot();
  if (fresh.policy.chair !== deps.chairAccount) return { status: "not-chair", snapshot: fresh };
  if (fresh.policy.lastSetEpoch === fresh.policy.epoch) return { status: "already-set", snapshot: fresh };
  const decision = finalize(fresh, deps.log.history(fresh.policy.epoch), proposed, deps.decideOptions);
  if (deps.submitter === null) return { status: "dry-run", snapshot: fresh, decision };

  deps.log.recordDecision(decision, fresh);
  return send(deps, deps.submitter, fresh, decision, 0);
}

/** The epoch already has its decision: send that one again if it is still allowed and still valid, else give up for the epoch. */
async function resend(deps: AgentDeps, submitter: Submitter, snapshot: Snapshot, prior: EpochState): Promise<TickResult> {
  const rec = prior.decision!;
  const giveUp = (reason: string): TickResult => ({ status: "gave-up", snapshot, reason });
  if (prior.settled) return giveUp("the contract already ruled on this epoch's decision");
  if (prior.failedSends >= MAX_SEND_ATTEMPTS) return giveUp(`sending failed ${prior.failedSends} times this epoch`);
  if (reasoningHash(rec.reasoning) !== rec.reasoning_hash) return giveUp("the logged reasoning does not match its hash");
  const window = windowFor(snapshot, deps.decideOptions.marginMs);
  if (!window.contains(rec.rate_bps)) return giveUp(`the logged rate ${rec.rate_bps} is no longer inside ${window.lo}..${window.hi}`);
  const decision: Decision = {
    epoch: snapshot.policy.epoch,
    previousRateBps: snapshot.policy.rateBps,
    rate: window.pick(rec.rate_bps),
    reasoning: rec.reasoning,
    reasoningHash: rec.reasoning_hash,
    chair: rec.chair,
    kind: rec.chair_kind,
  };
  return send(deps, submitter, snapshot, decision, prior.failedSends);
}

async function send(deps: AgentDeps, submitter: Submitter, snapshot: Snapshot, decision: Decision, failedBefore: number): Promise<TickResult> {
  try {
    const res = await submitter.submit(decision);
    const status = res.failure === null ? "executed" : "rejected";
    deps.log.recordOutcome(decision, status, res.txHash, res.failure);
    return { status, snapshot, decision, txHash: res.txHash, error: res.failure, failedSends: failedBefore };
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "send failed";
    deps.log.recordOutcome(decision, "send_failed", null, error);
    return { status: "send-failed", snapshot, decision, txHash: null, error, failedSends: failedBefore + 1 };
  }
}
