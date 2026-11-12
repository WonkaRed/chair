import type { Reader } from "./chain.js";
import { basisOf, finalize, propose, windowFor, type DecideOptions, type Proposed } from "./decide.js";
import type { DecisionLog, EpochState } from "./log.js";
import type { PressEntry, PressStore } from "./press-store.js";
import { reasoningHash } from "./reasoning.js";
import { unconfirmedHash, type Submitter, type SubmitResult } from "./signer.js";
import type { Decision, Snapshot } from "./types.js";

/** Send attempts per epoch for one decision; after that the agent sleeps until the next epoch. */
export const MAX_SEND_ATTEMPTS = 3;

/** The identical bytes are not sent again this long before the meeting ends (local time): the contract counts a call in the meeting open when it executes, and the decision's minutes are this meeting's. */
export const RESEND_CUTOFF_MS = 3_000;

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
  /** The press record, when questions are taken: pending ones go into the minutes, and are marked once the transaction lands. */
  readonly press?: PressStore;
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
  const submitter = deps.submitter;
  const prior = submitter === null ? null : deps.log.epochState(policy.epoch);
  if (submitter !== null && prior !== null && prior.decision !== null) {
    // A send whose answer was lost may have landed: record what it did before anything else, the chain's own "already set" included.
    const landed = await lookUpEarlier(submitter, prior);
    if (landed !== null && landed !== "pending") return landedOutcome(deps, snapshot, loggedDecision(deps, snapshot, prior.decision), landed, prior.failedSends);
    if (policy.lastSetEpoch !== policy.epoch) return resend(deps, submitter, snapshot, prior, landed);
  }
  if (policy.lastSetEpoch === policy.epoch) return { status: "already-set", snapshot };

  const proposed = await proposeWhileDeskWaits(deps, snapshot, policy);
  // The chair may have taken a while: decide against the chain as it is now, not as it was.
  const fresh = await deps.reader.snapshot();
  if (fresh.policy.chair !== deps.chairAccount) return { status: "not-chair", snapshot: fresh };
  if (fresh.policy.lastSetEpoch === fresh.policy.epoch) return { status: "already-set", snapshot: fresh };
  const decision = finalize(fresh, deps.log.history(fresh.policy.epoch), proposed, deps.decideOptions, pendingQuestions(deps));
  if (deps.submitter === null) return { status: "dry-run", snapshot: fresh, decision };

  deps.log.recordDecision(decision, basisOf(proposed, fresh));
  return send(deps, deps.submitter, fresh, decision, 0);
}

/**
 * The chair's call to the model, with the press desk told to keep off the model until it is done: the desk and the chair share one model, and a
 * decision must not wait behind answers to the press. The marker is a courtesy: a store that cannot write it only means the desk does not yield.
 */
async function proposeWhileDeskWaits(deps: AgentDeps, snapshot: Snapshot, policy: Snapshot["policy"]): Promise<Proposed> {
  try {
    deps.press?.decisionStarted();
  } catch {
    // No marker, no yielding; the decision goes on.
  }
  try {
    return await propose(snapshot, deps.log.history(policy.epoch), deps.decideOptions, deps.log.memory(policy.epoch, policy.rateBps));
  } finally {
    try {
      deps.press?.decisionDone();
    } catch {
      // A marker that stays is ignored once it is old.
    }
  }
}

/** The questions waiting for these minutes. The press is a side lane: a store that cannot be read means no press section, never a missed decision. */
function pendingQuestions(deps: AgentDeps): PressEntry[] {
  try {
    return deps.press?.pending() ?? [];
  } catch {
    return [];
  }
}

/** What the chain says of the transaction of this decision's last lost send, when there was one: its result when executed, "pending" when it is not settled (or the lookup failed), null when no node knows it or there is none. */
async function lookUpEarlier(submitter: Submitter, prior: EpochState): Promise<SubmitResult | "pending" | null> {
  if (prior.settled || prior.lastTxHash === null || submitter.lookUp === undefined) return null;
  const seen = await submitter.lookUp(prior.lastTxHash).catch(() => undefined);
  if (seen === null) return null;
  return seen?.executed === true ? { txHash: seen.txHash, failure: seen.failure } : "pending";
}

/** The logged decision as it would be sent now: the rate clamped into the window the chain allows. */
function loggedDecision(deps: AgentDeps, snapshot: Snapshot, rec: NonNullable<EpochState["decision"]>): Decision {
  return {
    epoch: snapshot.policy.epoch,
    previousRateBps: snapshot.policy.rateBps,
    rate: windowFor(snapshot, deps.decideOptions.marginMs).pick(rec.rate_bps),
    reasoning: rec.reasoning,
    reasoningHash: rec.reasoning_hash,
    chair: rec.chair,
    kind: rec.chair_kind,
    remark: rec.remark ?? null,
  };
}

/** The epoch already has its decision: send that one again if it is still allowed and still valid, else give up for the epoch. `earlier` is what `lookUpEarlier` found. */
async function resend(deps: AgentDeps, submitter: Submitter, snapshot: Snapshot, prior: EpochState, earlier: "pending" | null): Promise<TickResult> {
  const rec = prior.decision!;
  const giveUp = (reason: string): TickResult => ({ status: "gave-up", snapshot, reason });
  if (prior.settled) return giveUp("the contract already ruled on this epoch's decision");
  if (prior.failedSends >= MAX_SEND_ATTEMPTS) return giveUp(`sending failed ${prior.failedSends} times this epoch`);
  if (reasoningHash(rec.reasoning) !== rec.reasoning_hash) return giveUp("the logged reasoning does not match its hash");
  const window = windowFor(snapshot, deps.decideOptions.marginMs);
  if (!window.contains(rec.rate_bps)) return giveUp(`the logged rate ${rec.rate_bps} is no longer inside ${window.lo}..${window.hi}`);
  const decision = loggedDecision(deps, snapshot, rec);
  // The earlier transaction may still land: signing another now would race it, so this attempt only waits (and counts, so the epoch's attempts stay bounded).
  if (earlier === "pending") return failed(deps, snapshot, decision, prior.failedSends, prior.lastTxHash, "the earlier transaction is not settled yet");
  return send(deps, submitter, snapshot, decision, prior.failedSends);
}

/** The transaction landed: every question whose line is in the text that was sent now has its epoch and transaction. */
function enterQuestions(deps: AgentDeps, decision: Decision, txHash: string): void {
  try {
    deps.press?.markEntered(decision.reasoning, decision.epoch, txHash);
  } catch {
    // The decision is on chain and logged; a failed mark only leaves the question pending, so it is entered again.
  }
}

/** The contract ruled on the call: log it and enter the questions it carried, once (a settled epoch is never sent or looked up again). */
function landedOutcome(deps: AgentDeps, snapshot: Snapshot, decision: Decision, res: SubmitResult, failedBefore: number): TickResult {
  const status = res.failure === null ? "executed" : "rejected";
  deps.log.recordOutcome(decision, status, res.txHash, res.failure);
  if (res.failure === null) enterQuestions(deps, decision, res.txHash);
  return { status, snapshot, decision, txHash: res.txHash, error: res.failure, failedSends: failedBefore };
}

function failed(deps: AgentDeps, snapshot: Snapshot, decision: Decision, failedBefore: number, txHash: string | null, error: string): TickResult {
  deps.log.recordOutcome(decision, "send_failed", txHash, error);
  return { status: "send-failed", snapshot, decision, txHash, error, failedSends: failedBefore + 1 };
}

/** The window's end in the local clock, less the cutoff: `epochEndsMs - blockTimeMs` is what the agent's window (`windowFor`) already takes as the time left. */
const resendBefore = (snapshot: Snapshot): number => Date.now() + (snapshot.policy.epochEndsMs - snapshot.blockTimeMs) - RESEND_CUTOFF_MS;

async function send(deps: AgentDeps, submitter: Submitter, snapshot: Snapshot, decision: Decision, failedBefore: number): Promise<TickResult> {
  try {
    return landedOutcome(deps, snapshot, decision, await submitter.submit(decision, resendBefore(snapshot)), failedBefore);
  } catch (err) {
    const error = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "send failed";
    return failed(deps, snapshot, decision, failedBefore, unconfirmedHash(err), error);
  }
}
