import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BOUNDS } from "../src/bounds.js";
import type { Snapshot } from "../src/types.js";

/** Small seeded PRNG so randomized tests are reproducible. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A fresh directory for a test's files. It lives under the package's git-ignored `out/` (or
 * `CHAIR_TEST_TMP`), never under os.tmpdir(), which is RAM-backed on the machines this runs on.
 */
export function tempDir(prefix: string): string {
  const root = process.env["CHAIR_TEST_TMP"] ?? join(import.meta.dirname, "..", "..", "out", "test-tmp");
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${prefix}-`));
}

/** SPEC "Epochs and rollover" step 2, written from the SPEC and sharing nothing with src/bounds.ts. */
export function specDecay(rate: number): number {
  return rate - Math.sign(rate) * Math.min(Math.abs(rate), 50);
}

export const randInt = (r: () => number, lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));

/**
 * What the contract accepts, written again from SPEC.md "Methods" so tests do not check the agent
 * against the agent's own arithmetic. `rateInEffect` is after pending decay.
 */
export function contractAccepts(rateInEffect: number, rate: number): boolean {
  return Number.isInteger(rate) && Math.abs(rate) <= 200 && Math.abs(rate - rateInEffect) <= 50;
}

export function snapshot(o: Partial<{
  epoch: number;
  rate: number;
  supply: bigint;
  staked: bigint | null;
  timeLeftMs: number;
  chair: string;
  lastSet: number | null;
}> = {}): Snapshot {
  const epoch = o.epoch ?? 5;
  const epochMs = 60_000;
  const startMs = 1_700_000_000_000;
  const endsMs = startMs + (epoch + 1) * epochMs;
  const staked = o.staked === undefined ? 0n : o.staked;
  return {
    blockTimeMs: endsMs - (o.timeLeftMs ?? 30_000),
    params: { ...DEFAULT_BOUNDS, epochMs, startMs, impeachThresholdBps: 5000, nominateBond: 1n },
    policy: { epoch, rateBps: o.rate ?? 0, chair: o.chair ?? "chair.test", streak: epoch, lastSetEpoch: o.lastSet ?? null, epochEndsMs: endsMs },
    totalSupply: o.supply ?? 1_000_000n,
    staking: staked === null ? null : { totalStaked: staked, rewardPool: 0n },
  };
}
