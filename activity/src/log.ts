// One record per thing that happened, written twice: a JSON line appended to the log file (the permanent record, with
// the transaction hash of every action) and a plain line on stdout (the journal). Both say what this is.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TOKEN } from "./plan.ts";

export const DISCLOSURE = "scripted test activity by three accounts we control, not organic users";

export interface Log {
  /** `fields` go to the JSON line (bigints as decimal strings); `message` is the stdout line. */
  write(fields: Record<string, unknown>, message: string): void;
}

/** Whole tokens with up to two decimals, for messages: 12345.67 */
export function tokens(yocto: bigint): string {
  const hundredths = (yocto * 100n) / TOKEN;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/** NEAR with five decimals, for messages: 0.49657 */
export function near(yocto: bigint): string {
  const units = (yocto * 100_000n) / 10n ** 24n;
  return `${units / 100_000n}.${(units % 100_000n).toString().padStart(5, "0")}`;
}

export class FileLog implements Log {
  private readonly path: string;
  private readonly out: (line: string) => void;
  private readonly now: () => Date;
  constructor(path: string, out: (line: string) => void = (line) => console.log(line), now: () => Date = () => new Date()) {
    this.path = path;
    this.out = out;
    this.now = now;
    mkdirSync(dirname(path), { recursive: true });
  }

  write(fields: Record<string, unknown>, message: string): void {
    const at = this.now().toISOString();
    const line = JSON.stringify({ at, disclosure: DISCLOSURE, ...fields }, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    appendFileSync(this.path, `${line}\n`);
    this.out(`${at} chair-activity (${DISCLOSURE}): ${message}`);
  }
}
