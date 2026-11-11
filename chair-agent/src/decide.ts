import { RateWindow, type Rate } from "./bounds.js";
import { cleanReasoning, reasoningHash } from "./reasoning.js";
import { ruleChair, ruleDecision } from "./rule-chair.js";
import type { Chair, ChairKind, Decision, HistoryPoint, Proposal, Snapshot } from "./types.js";

/** Longest chair-written body; the agent's own header and notes come on top of it. */
const BODY_CHARS = 1500;

/** Why the primary chair's answer was not used; a fixed label, never raw error text. */
export type FallbackReason = "error" | "timeout" | "malformed" | "refusal";

/** Thrown by a chair that could not produce a usable proposal. */
export class ChairFailure extends Error {
  constructor(
    readonly reason: FallbackReason,
    detail: string,
  ) {
    super(detail);
    this.name = "ChairFailure";
  }
}

export interface DecideOptions {
  readonly chair: Chair;
  /** A call landing within this many ms of the epoch end may cross a rollover; see `RateWindow.acrossRollover`. */
  readonly marginMs: number;
  readonly timeoutMs: number;
}

/** Wait for `p`, but give up after `ms` even when `p` ignores the abort signal. */
export async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new ChairFailure("timeout", `no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(ac.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** Decision-relevant history only: strictly before `epoch`, so a reused or hand-edited log cannot leak the future. */
const before = (history: readonly HistoryPoint[], epoch: number): HistoryPoint[] => history.filter((h) => h.epoch < epoch);

/**
 * The rates a `set_policy` call sent now can have accepted. A call landing within `marginMs` (plus
 * `extraMs`, the time still to be spent waiting on a model) of the epoch end may cross a rollover.
 */
export function windowFor(snapshot: Snapshot, marginMs: number, extraMs = 0): RateWindow {
  const { policy, params } = snapshot;
  return policy.epochEndsMs - snapshot.blockTimeMs < marginMs + extraMs
    ? RateWindow.acrossRollover(policy.rateBps, params)
    : RateWindow.around(policy.rateBps, params);
}

/** A chair's answer, not yet tied to the chain state it will be sent against. */
export interface Proposed {
  readonly used: Chair;
  readonly kind: ChairKind;
  readonly proposal: Proposal;
  readonly fallbackNote: string;
  /** The epoch of the snapshot the chair saw. */
  readonly basedOnEpoch: number;
}

/**
 * Ask the chair, within the time limit. Any failure of a non-rule chair falls back to the rule chair, which
 * cannot fail. The chair sees a window that stays valid across a rollover whenever the model's own time
 * allowance could carry the call past the epoch end.
 */
export async function propose(snapshot: Snapshot, history: readonly HistoryPoint[], opts: DecideOptions): Promise<Proposed> {
  const isRule = opts.chair === ruleChair;
  const w = windowFor(snapshot, opts.marginMs, isRule ? 0 : opts.timeoutMs);
  const input = { snapshot, history: before(history, snapshot.policy.epoch), window: { lo: w.lo, hi: w.hi } };
  const basedOnEpoch = snapshot.policy.epoch;
  if (!isRule) {
    try {
      const proposal = await withTimeout(opts.timeoutMs, (signal) => opts.chair.propose(input, signal));
      if (!Number.isSafeInteger(proposal.rateBps) || cleanReasoning(proposal.reasoning, BODY_CHARS) === null) {
        throw new ChairFailure("malformed", "proposal is not an integer rate with text");
      }
      return { used: opts.chair, kind: "llm", proposal, fallbackNote: "", basedOnEpoch };
    } catch (err) {
      const reason: FallbackReason = err instanceof ChairFailure ? err.reason : "error";
      const fallbackNote = `Chair ${opts.chair.name} failed (${reason}); the rule chair decided instead.\n`;
      const proposal = await ruleChair.propose(input, new AbortController().signal);
      return { used: ruleChair, kind: "rule-fallback", proposal, fallbackNote, basedOnEpoch };
    }
  }
  return { used: ruleChair, kind: "rule", proposal: await ruleChair.propose(input, new AbortController().signal), fallbackNote: "", basedOnEpoch };
}

/**
 * Turns a proposal into a `Decision` against `fresh`, a snapshot read AFTER the proposal arrived: the
 * rate is clamped into the window of the epoch the call will actually land in, the epoch recorded is that
 * one, and the hash is taken of the exact text returned (and logged). If the epoch rolled over while the
 * chair was thinking, a rule-chair proposal is recomputed from the fresh state and a model's answer is
 * only clamped.
 */
export function finalize(fresh: Snapshot, history: readonly HistoryPoint[], proposed: Proposed, opts: Pick<DecideOptions, "marginMs">): Decision {
  const { policy } = fresh;
  const rolled = policy.epoch !== proposed.basedOnEpoch;
  const window = windowFor(fresh, opts.marginMs);
  let { proposal } = proposed;
  if (rolled && proposed.used === ruleChair) {
    proposal = ruleDecision({ snapshot: fresh, history: before(history, policy.epoch), window: { lo: window.lo, hi: window.hi } });
  }
  const rate: Rate = window.pick(proposal.rateBps);
  const rolloverNote = rolled && proposed.used !== ruleChair ? "\nThe epoch rolled over while the chair was answering." : "";
  const clampNote =
    rate === proposal.rateBps
      ? ""
      : `\nThe chair asked for ${proposal.rateBps} bps; the contract accepts ${window.lo}..${window.hi} bps here, so ${rate} bps is set.`;
  const body = cleanReasoning(proposal.reasoning, BODY_CHARS) ?? "";
  const text = cleanReasoning(
    `$CHAIR decision, epoch ${policy.epoch}, chair ${proposed.used.name}.\n${proposed.fallbackNote}` +
      `Rate in effect ${policy.rateBps} bps; decision ${rate} bps.\n${body}${rolloverNote}${clampNote}`,
  );
  if (text === null) throw new Error("unreachable: decision text is never empty");
  return {
    epoch: policy.epoch,
    previousRateBps: policy.rateBps,
    rate,
    reasoning: text,
    reasoningHash: reasoningHash(text),
    chair: proposed.used.name,
    kind: proposed.kind,
  };
}

/** Propose and finalize against the same snapshot: for callers that do not re-read the chain (tests, tools). */
export async function decide(snapshot: Snapshot, history: readonly HistoryPoint[], opts: DecideOptions): Promise<Decision> {
  return finalize(snapshot, history, await propose(snapshot, history, opts), opts);
}
