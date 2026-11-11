import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BOOK } from "./press-book.js";
import { cleanReasoning, reasoningHash } from "./reasoning.js";

/** Longest question, in UTF-16 code units (what a browser's `maxlength` counts), after `cleanQuestion`. */
export const MAX_QUESTION_CHARS = 140;

/** How the line was chosen: by the model's pick, or (a failed call, a pick that was unusable or used lately) from the question's hash. Either way it is a line of the book. */
export type AnswerSource = "model" | "canned";

export interface PressEntry {
  readonly id: string;
  /** Kept here only so the hash can be rechecked; no API and no on-chain text ever carries it. */
  readonly question: string;
  /** SHA-256 of `question`, lowercase hex. */
  readonly questionHash: string;
  readonly answer: string;
  readonly source: AnswerSource;
  readonly askedAtMs: number;
  /** Set once a decision whose text carries this entry has landed on chain. */
  readonly epoch: number | null;
  readonly txHash: string | null;
}

/** An entry as the API shows it: the hash, never the question. */
export interface PublicEntry {
  readonly id: string;
  readonly question_hash: string;
  readonly answer: string;
  readonly asked_at_ms: number;
  readonly epoch: number | null;
  readonly tx_hash: string | null;
}

export const toPublic = (e: PressEntry): PublicEntry => ({
  id: e.id,
  question_hash: e.questionHash,
  answer: e.answer,
  asked_at_ms: e.askedAtMs,
  epoch: e.epoch,
  tx_hash: e.txHash,
});

/**
 * The question as it is hashed and shown to the model: control and invisible characters dropped (`cleanReasoning`), every run of
 * whitespace one space, trimmed. Null when nothing is left or more than `MAX_QUESTION_CHARS` remain. A browser can reproduce it
 * from a typed question and compare its SHA-256 with `question_hash`.
 */
export function cleanQuestion(raw: string): string | null {
  const text = cleanReasoning(raw, 100_000)?.replace(/\s+/g, " ").trim() ?? "";
  return text.length >= 1 && text.length <= MAX_QUESTION_CHARS ? text : null;
}

/** The answer as one line, the form in which it is stored and written into the minutes. */
export const oneLine = (answer: string): string => cleanReasoning(answer, 2000)?.replace(/\s+/g, " ").trim() ?? "";

/** The first 12 hex characters of the question hash, the form in which it is written into the minutes. */
export const hashPrefix = (e: Pick<PressEntry, "questionHash">): string => e.questionHash.slice(0, 12);

/** How long a decision may hold the marker: past the model's own time limit for a decision (30 s by default) with room to spare. */
export const DECISION_MARKER_MAX_MS = 90_000;

/** The one line of the minutes that stands for an entry; `PressStore.markEntered` finds entries by exactly this line. */
export const entryLine = (e: Pick<PressEntry, "questionHash" | "answer">): string =>
  `A member of the press asked a question (${hashPrefix(e)}). The Chair replied: ${oneLine(e.answer)}`;

type Row =
  | { v: 1; kind: "ask"; id: string; question: string; question_hash: string; answer: string; source: AnswerSource; asked_at_ms: number }
  | { v: 1; kind: "entered"; id: string; epoch: number; tx_hash: string };

/**
 * The press record: append-only JSON lines. The press server appends `ask` rows and the chair agent appends `entered` rows, from
 * two processes, one write per line; each side rereads the file when its size or modification time changes.
 */
export class PressStore {
  private cache: { size: number; mtimeMs: number; entries: PressEntry[] } | null = null;

  constructor(readonly path: string) {}

  private read(): PressEntry[] {
    if (!existsSync(this.path)) return [];
    const st = statSync(this.path);
    if (this.cache !== null && this.cache.size === st.size && this.cache.mtimeMs === st.mtimeMs) return this.cache.entries;
    const byId = new Map<string, PressEntry>();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        const row = JSON.parse(line) as Row;
        if (row.v !== 1) continue;
        if (row.kind === "ask") {
          // A hand-edited line whose hash does not match its question, whose text would not survive cleaning, or whose answer is not a line of the book, is not an entry:
          // so everything shown, stored and signed is a line of the reviewed book.
          const ok =
            typeof row.id === "string" && typeof row.question === "string" && typeof row.answer === "string" &&
            Number.isSafeInteger(row.asked_at_ms) && (row.source === "model" || row.source === "canned") &&
            cleanQuestion(row.question) === row.question && reasoningHash(row.question) === row.question_hash &&
            BOOK.includes(row.answer);
          if (ok && !byId.has(row.id)) {
            byId.set(row.id, { id: row.id, question: row.question, questionHash: row.question_hash, answer: row.answer, source: row.source, askedAtMs: row.asked_at_ms, epoch: null, txHash: null });
          }
        } else if (row.kind === "entered") {
          const e = byId.get(row.id);
          if (e !== undefined && e.epoch === null && Number.isSafeInteger(row.epoch) && typeof row.tx_hash === "string") {
            byId.set(row.id, { ...e, epoch: row.epoch, txHash: row.tx_hash });
          }
        }
      } catch {
        // A damaged line is skipped, never fatal: the rest of the record still stands.
      }
    }
    const entries = [...byId.values()].sort((a, b) => a.askedAtMs - b.askedAtMs);
    this.cache = { size: st.size, mtimeMs: st.mtimeMs, entries };
    return entries;
  }

  private append(row: Row): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  }

  add(e: Pick<PressEntry, "id" | "question" | "questionHash" | "answer" | "source" | "askedAtMs">): void {
    this.append({ v: 1, kind: "ask", id: e.id, question: e.question, question_hash: e.questionHash, answer: e.answer, source: e.source, asked_at_ms: e.askedAtMs });
  }

  /** The marker the chair agent keeps while a decision waits on the model, beside the record so that both processes find it. */
  private get marker(): string {
    return `${this.path}.deciding`;
  }

  /** The agent is about to wait on the model for a decision: the desk stays off the model until `decisionDone`. */
  decisionStarted(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.marker, `${Date.now()}\n`, { mode: 0o600 });
  }

  decisionDone(): void {
    rmSync(this.marker, { force: true });
  }

  /** True while a decision is waiting on the model. A marker older than `DECISION_MARKER_MAX_MS` is a crash's leftover and counts for nothing. */
  decisionBusy(nowMs: number = Date.now()): boolean {
    try {
      return nowMs - statSync(this.marker).mtimeMs < DECISION_MARKER_MAX_MS;
    } catch {
      return false;
    }
  }

  /** The newest `limit` entries, newest first. */
  recent(limit: number): PressEntry[] {
    return this.read().slice(-limit).reverse();
  }

  /** Entries not yet in any minutes, oldest first. */
  pending(): PressEntry[] {
    return this.read().filter((e) => e.epoch === null);
  }

  /**
   * Marks the pending entries whose line (`entryLine`) is a line of `minutes` as entered in `epoch` by `txHash`, oldest first, and no more
   * of them than the minutes hold copies of that line (two identical entries, one written, mark one); returns how many.
   * Going by the text that was sent, not by what was meant to be sent, keeps a re-sent decision and a trimmed one honest.
   */
  markEntered(minutes: string, epoch: number, txHash: string): number {
    const copies = new Map<string, number>();
    for (const line of minutes.split("\n")) copies.set(line, (copies.get(line) ?? 0) + 1);
    let n = 0;
    for (const e of this.pending()) {
      const line = entryLine(e);
      const left = copies.get(line) ?? 0;
      if (left === 0) continue;
      copies.set(line, left - 1);
      this.append({ v: 1, kind: "entered", id: e.id, epoch, tx_hash: txHash });
      n++;
    }
    return n;
  }
}
