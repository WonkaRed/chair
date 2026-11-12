import { RateWindow, type Rate } from "./bounds.js";
import { pressSection } from "./press-section.js";
import type { PressEntry } from "./press-store.js";
import { choiceLine } from "./choice.js";
import { cleanReasoning, MAX_REASONING_CHARS, reasoningHash } from "./reasoning.js";
import { bookLine, factFault, factOf } from "./remark.js";
import { formulaRate, mandateRate, ruleChair, ruleDecision, statement, supplyDrift } from "./rule-chair.js";
import type { Chair, ChairKind, ChairMemory, Decision, DecisionInput, HistoryPoint, Proposal, Snapshot } from "./types.js";

/** Why the primary chair's answer was not used; a fixed label, never raw error text. */
export type FallbackReason = "error" | "timeout" | "malformed" | "refusal";

/** What the minutes say went wrong, per reason, in words a reader needs no background for. The page (web/site/js/minutes.js `FALLBACK_NEW`) reads this sentence back, so change them together. */
const FALLBACK_WHY: Record<FallbackReason, string> = {
  timeout: "did not answer in time",
  refusal: "declined to answer",
  malformed: "gave an answer the Chair could not use",
  error: "ran into an error",
};

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
  /** The model's own closing remark, already checked; null when there is none and the minutes close on the book. */
  readonly remark: string | null;
  readonly fallbackNote: string;
  /** The read of the chain the chair saw: the text cites its figures, so the decision's figures are its figures. */
  readonly basis: Snapshot;
}

/** A malformed answer is asked for once more only while at least this much of the time limit is left. */
const RETRY_MIN_MS = 10_000;

/** The most time the Chair's own remark gets, both attempts together; it is also never given more than what is left of the decision's time limit. */
export const REMARK_TIMEOUT_MS = 15_000;
/** With less than this left, the remark is not asked for at all. */
const REMARK_MIN_MS = 1_500;

/** The chair's own remark within `ms`, or null. A remark is an extra: it never throws, and never runs past the time the decision was allowed. */
async function remarkWithin(chair: Chair, input: DecisionInput, rateBps: number, leftMs: number): Promise<string | null> {
  const ms = Math.min(REMARK_TIMEOUT_MS, leftMs);
  if (chair.remark === undefined || ms < REMARK_MIN_MS) return null;
  try {
    return await withTimeout(ms, (signal) => chair.remark!(input, rateBps, signal));
  } catch {
    return null;
  }
}

/**
 * Ask the chair, within the time limit. A malformed answer is asked for once more with the time that remains;
 * any other failure, or a second malformed answer, of a non-rule chair falls back to the rule chair, which
 * cannot fail. The chair sees a window that stays valid across a rollover whenever the model's own time
 * allowance could carry the call past the epoch end.
 */
export async function propose(snapshot: Snapshot, history: readonly HistoryPoint[], opts: DecideOptions, memory?: ChairMemory): Promise<Proposed> {
  const isRule = opts.chair === ruleChair;
  const w = windowFor(snapshot, opts.marginMs, isRule ? 0 : opts.timeoutMs);
  const input = { snapshot, history: before(history, snapshot.policy.epoch), window: { lo: w.lo, hi: w.hi }, ...(memory === undefined ? {} : { memory }) };
  if (!isRule) {
    const startedMs = Date.now();
    const leftMs = () => opts.timeoutMs - (Date.now() - startedMs);
    for (let attempt = 1; ; attempt++) {
      try {
        const proposal = await withTimeout(leftMs(), (signal) => opts.chair.propose(input, signal));
        if (!Number.isSafeInteger(proposal.rateBps)) throw new ChairFailure("malformed", "proposal is not an integer rate");
        const remark = await remarkWithin(opts.chair, input, proposal.rateBps, leftMs());
        return { used: opts.chair, kind: "llm", proposal, remark, fallbackNote: "", basis: snapshot };
      } catch (err) {
        const reason: FallbackReason = err instanceof ChairFailure ? err.reason : "error";
        if (reason === "malformed" && attempt === 1 && leftMs() >= RETRY_MIN_MS) continue;
        const fallbackNote = `The AI chair (${opts.chair.name}) ${FALLBACK_WHY[reason]}, so the rule chair, the Chair's built-in fallback, decided this meeting.\n`;
        const { rateBps } = await ruleChair.propose(input, new AbortController().signal);
        return { used: ruleChair, kind: "rule-fallback", proposal: { rateBps, reason: "fallback" }, remark: null, fallbackNote, basis: snapshot };
      }
    }
  }
  return { used: ruleChair, kind: "rule", proposal: await ruleChair.propose(input, new AbortController().signal), remark: null, fallbackNote: "", basis: snapshot };
}

/**
 * The read every figure of a decision comes from: the one the model was shown, because the text it wrote cites that read's staked share and
 * supply. The rule chair does not wait on anything, so it is simply decided again on the fresh read. The fresh read still rules the contract's
 * side of the call (the epoch, the rate in effect, the window), which only the chain's present state can say.
 */
export const basisOf = (proposed: Proposed, fresh: Snapshot): Snapshot => (proposed.used === ruleChair ? fresh : proposed.basis);

/**
 * Turns a proposal into a `Decision` against `fresh`, a snapshot read AFTER the proposal arrived: the
 * rate is clamped into the window of the epoch the call will actually land in, the epoch recorded is that
 * one, and the hash is taken of the exact text returned (and logged). The figures of the decision (the formula, the mandate and the supply change here, the logged
 * supply and stake in the caller) come from `basisOf`, the read the chair saw, never from a later one that a stake may have moved. If the epoch
 * rolled over while the chair was thinking, a model's answer is only clamped. The minutes are the agent's own sentences throughout: the statement of the rate set,
 * the formula's number beside the Chair's and the reason, and a closing line: the AI chair's own checked remark, else the book line of the meeting; the rule chair's text closes itself.
 */
export function finalize(
  fresh: Snapshot,
  history: readonly HistoryPoint[],
  proposed: Proposed,
  opts: Pick<DecideOptions, "marginMs">,
  press: readonly PressEntry[] = [],
): Decision {
  const { policy } = fresh;
  const basis = basisOf(proposed, fresh);
  const rolled = policy.epoch !== basis.policy.epoch;
  const window = windowFor(fresh, opts.marginMs);
  const input: DecisionInput = { snapshot: basis, history: before(history, basis.policy.epoch), window: { lo: window.lo, hi: window.hi } };
  // The rule chair does not wait on anything, so it is simply decided again on the fresh read.
  const formula = formulaRate(basis);
  const chosen = proposed.used === ruleChair ? formula : proposed.proposal.rateBps;
  const rate: Rate = window.pick(chosen);
  const rolloverNote = rolled ? "\nThe epoch rolled over while the Chair was deliberating. Time does not wait for the Committee of One." : "";
  const clampNote =
    rate === chosen
      ? ""
      : `\nThe Chair asked for ${chosen} bps; the contract accepts ${window.lo}..${window.hi} bps here, so ${rate} bps is set. The Chair defers.`;
  const mandate = mandateRate(basis);
  const day = supplyDrift(input, basis.params.meetingsPerDay);
  // The remark was checked against the rate the model proposed and the rate in effect when it asked; the rate sent may differ (clamped, or the rate in effect decayed).
  const remark = proposed.remark !== null && factFault(proposed.remark, factOf(rate, policy.rateBps)) === null ? proposed.remark : null;
  const choice = { formulaBps: formula, chosenBps: chosen, reason: proposed.proposal.reason };
  const body = proposed.kind === "llm" ? `${statement(input, rate)} ${remark ?? bookLine(policy.epoch)}` : ruleDecision(input).reasoning;
  const base =
    `$CHAIR decision, epoch ${policy.epoch}, chair ${proposed.used.name}.\n${proposed.fallbackNote}` +
    `Rate in effect ${policy.rateBps} bps; decision ${rate} bps.\n${choiceLine(choice)}\n${body}${rolloverNote}${clampNote}`;
  // The press section only ever follows the decision text, and only in the room the 2000-character cap leaves.
  const text = cleanReasoning(`${base}${pressSection(press, MAX_REASONING_CHARS - base.length)}`);
  if (text === null) throw new Error("unreachable: decision text is never empty");
  return {
    epoch: policy.epoch,
    previousRateBps: policy.rateBps,
    rate,
    reasoning: text,
    reasoningHash: reasoningHash(text),
    chair: proposed.used.name,
    kind: proposed.kind,
    remark,
    mandate: {
      rateBps: mandate,
      supplyChangeBps: day === null ? null : Number(day.bps),
      supplyChangeMeetings: day === null ? null : day.meetings,
    },
    choice,
  };
}

/** Propose and finalize against the same snapshot: for callers that do not re-read the chain (tests, tools). */
export async function decide(snapshot: Snapshot, history: readonly HistoryPoint[], opts: DecideOptions): Promise<Decision> {
  return finalize(snapshot, history, await propose(snapshot, history, opts), opts);
}
