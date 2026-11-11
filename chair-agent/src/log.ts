import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanReasoning, HASH_RE, reasoningHash } from "./reasoning.js";
import type { ChairKind, Decision, HistoryPoint, Snapshot } from "./types.js";
import { u128 } from "./validate.js";

/**
 * The decision log: append-only JSON lines. A `decision` record is written before the transaction is
 * sent, so the text behind a hash is on disk before the hash is public; an `outcome` record follows.
 * Anyone can recompute `sha256(reasoning)` and compare it with the on-chain `policy_set` event.
 */
export type LogRecord =
  | {
      readonly v: 2;
      readonly kind: "decision";
      /** The token and chair account the decision is for: a log reused for another pair is detectable. */
      readonly token: string;
      readonly account: string;
      readonly epoch: number;
      readonly chair: string;
      readonly chair_kind: ChairKind;
      readonly rate_bps: number;
      readonly previous_rate_bps: number;
      readonly reasoning: string;
      readonly reasoning_hash: string;
      readonly total_supply: string;
      readonly total_staked: string | null;
      readonly block_time_ms: number;
    }
  | {
      readonly v: 2;
      readonly kind: "outcome";
      readonly token: string;
      readonly account: string;
      readonly epoch: number;
      readonly reasoning_hash: string;
      readonly status: "executed" | "rejected" | "send_failed";
      readonly tx_hash: string | null;
      readonly error: string | null;
    };

/** What the log says about one epoch of this token and account. */
export interface EpochState {
  /** The latest decision logged for the epoch, or null. */
  readonly decision: Extract<LogRecord, { kind: "decision" }> | null;
  /** Send attempts of that decision that failed without a verdict from the chain. */
  readonly failedSends: number;
  /** The contract ruled on it: an `executed` or `rejected` outcome exists. */
  readonly settled: boolean;
}

export interface LogScope {
  readonly token: string;
  readonly account: string;
}

export class DecisionLog {
  constructor(
    readonly path: string,
    readonly scope: LogScope,
  ) {}

  private append(rec: LogRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(rec)}\n`, { encoding: "utf8", mode: 0o644 });
  }

  private mine(): LogRecord[] {
    return readRecords(this.path).records.filter((r) => r.token === this.scope.token && r.account === this.scope.account);
  }

  recordDecision(d: Decision, s: Snapshot): void {
    this.append({
      v: 2,
      kind: "decision",
      ...this.scope,
      epoch: d.epoch,
      chair: d.chair,
      chair_kind: d.kind,
      rate_bps: d.rate,
      previous_rate_bps: d.previousRateBps,
      reasoning: d.reasoning,
      reasoning_hash: d.reasoningHash,
      total_supply: s.totalSupply.toString(),
      total_staked: s.staking === null ? null : s.staking.totalStaked.toString(),
      block_time_ms: s.blockTimeMs,
    });
  }

  recordOutcome(d: Decision, status: "executed" | "rejected" | "send_failed", txHash: string | null, error: string | null): void {
    this.append({ v: 2, kind: "outcome", ...this.scope, epoch: d.epoch, reasoning_hash: d.reasoningHash, status, tx_hash: txHash, error });
  }

  /** The state of `epoch`: its decision (one per epoch is the rule; the latest wins if a hand-edit adds more) and its send attempts. */
  epochState(epoch: number): EpochState {
    let decision: EpochState["decision"] = null;
    let failedSends = 0;
    let settled = false;
    for (const rec of this.mine()) {
      if (rec.epoch !== epoch) continue;
      if (rec.kind === "decision") {
        decision = rec;
        failedSends = 0;
        settled = false;
      } else if (decision !== null && rec.reasoning_hash === decision.reasoning_hash) {
        if (rec.status === "send_failed") failedSends++;
        else settled = true;
      }
    }
    return { decision, failedSends, settled };
  }

  /** Supply at past decisions of this token and account, strictly before `beforeEpoch`, oldest first, one point per epoch. */
  history(beforeEpoch: number): HistoryPoint[] {
    const byEpoch = new Map<number, HistoryPoint>();
    for (const rec of this.mine()) {
      if (rec.kind !== "decision" || rec.epoch >= beforeEpoch) continue;
      try {
        byEpoch.set(rec.epoch, { epoch: rec.epoch, totalSupply: u128(rec.total_supply, "total_supply") });
      } catch {
        // A hand-edited line with a bad supply is skipped; `verifyLog` reports it.
      }
    }
    return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
  }
}

export function readRecords(path: string): { records: LogRecord[]; badLines: number[] } {
  if (!existsSync(path)) return { records: [], badLines: [] };
  const records: LogRecord[] = [];
  const badLines: number[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.trim() === "") return;
      try {
        const rec = JSON.parse(line) as LogRecord;
        if (rec.v !== 2 || (rec.kind !== "decision" && rec.kind !== "outcome") || typeof rec.token !== "string" || typeof rec.account !== "string") {
          throw new Error("shape");
        }
        records.push(rec);
      } catch {
        badLines.push(i + 1);
      }
    });
  return { records, badLines };
}

export interface LogVerification {
  readonly decisions: number;
  readonly mismatches: { epoch: number; claimed: string; actual: string }[];
  readonly badLines: number[];
  /** Decisions with a `reasoning_hash` that is not 64 hex characters. */
  readonly badHashes: number[];
  /** Distinct `token account` pairs in the log; more than one means it was reused. */
  readonly scopes: string[];
}

/** Recompute every logged hash from its text. `ok` means every line parsed and every hash matched. */
export function verifyLog(path: string): LogVerification & { ok: boolean } {
  const { records, badLines } = readRecords(path);
  const mismatches: LogVerification["mismatches"] = [];
  const badHashes: number[] = [];
  const scopes = new Set<string>();
  let decisions = 0;
  for (const rec of records) {
    scopes.add(`${rec.token} ${rec.account}`);
    if (rec.kind !== "decision") continue;
    decisions++;
    if (!HASH_RE.test(rec.reasoning_hash)) badHashes.push(rec.epoch);
    const actual = reasoningHash(String(rec.reasoning));
    if (actual !== rec.reasoning_hash) mismatches.push({ epoch: rec.epoch, claimed: rec.reasoning_hash, actual });
  }
  return {
    decisions,
    mismatches,
    badLines,
    badHashes,
    scopes: [...scopes],
    ok: mismatches.length === 0 && badLines.length === 0 && badHashes.length === 0 && scopes.size <= 1,
  };
}

/** The decision text behind an on-chain hash, or null. */
export function findReasoning(path: string, hash: string): string | null {
  for (const rec of readRecords(path).records) {
    // Text the agent did not itself write (anything cleanReasoning would change) is not printed.
    if (rec.kind === "decision" && rec.reasoning_hash === hash && reasoningHash(rec.reasoning) === hash && cleanReasoning(rec.reasoning) === rec.reasoning) {
      return rec.reasoning;
    }
  }
  return null;
}
