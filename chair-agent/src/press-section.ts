import { MAX_REASONING_CHARS } from "./reasoning.js";
import { entryLine, type PressEntry } from "./press-store.js";

/** Entries written into one decision's minutes; the rest stay pending, and no sentence promises when they are entered. */
export const MAX_PRESS_ENTRIES = 2;

const plural = (n: number): string => `${n} question${n === 1 ? "" : "s"}`;

/**
 * The press section of the minutes: how many questions are waiting (some may have waited through earlier meetings, so no sentence says since when), then up to `MAX_PRESS_ENTRIES` of them, oldest first, each as its
 * hash prefix and the Chair's answer. Never the question. `room` is how many characters of the 2000-character cap the base text leaves;
 * when two entries do not fit one is written, and when none fits the section is empty (the entries stay pending). Returns "" or
 * text that starts with a newline.
 */
export function pressSection(pending: readonly PressEntry[], room: number = MAX_REASONING_CHARS): string {
  for (let k = Math.min(MAX_PRESS_ENTRIES, pending.length); k >= 1; k--) {
    const left = pending.length - k;
    const head = `The press has ${plural(pending.length)} waiting.${left === 0 ? "" : ` The Chair enters ${k} here; ${left === 1 ? "the other waits" : "the rest wait"}.`}`;
    const text = `\n${[head, ...pending.slice(0, k).map(entryLine)].join("\n")}`;
    if (text.length <= room) return text;
  }
  return "";
}
