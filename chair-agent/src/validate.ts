// Boundary checks for everything read from the chain. A value that does not match is rejected,
// never coerced: the chair must not decide on figures it misread.
import type { Params, Policy, Staking } from "./types.js";

export class ValidationError extends Error {
  constructor(what: string, detail: string) {
    super(`${what}: ${detail}`);
    this.name = "ValidationError";
  }
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function accountId(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length < 2 || v.length > 64 || !ACCOUNT_RE.test(v)) {
    throw new ValidationError(what, "not a NEAR account id");
  }
  return v;
}

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ValidationError(what, "not an object");
  return v as Record<string, unknown>;
}

export function int(v: unknown, what: string, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) {
    throw new ValidationError(what, `expected an integer in ${min}..${max}`);
  }
  return v;
}

/** A U128 as the contract returns it: a decimal string, no sign, no leading zeros, at most u128::MAX. */
export function u128(v: unknown, what: string): bigint {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,38})$/.test(v)) throw new ValidationError(what, "not a U128 decimal string");
  const n = BigInt(v);
  if (n > (1n << 128n) - 1n) throw new ValidationError(what, "exceeds u128");
  return n;
}

export function parseParams(v: unknown): Params {
  const o = obj(v, "get_params");
  return {
    epochMs: int(o["epoch_ms"], "epoch_ms", 1),
    startMs: int(o["start_ms"], "start_ms", 0),
    maxRateBps: int(o["max_rate_bps"], "max_rate_bps", 0, 10_000),
    maxStepBps: int(o["max_step_bps"], "max_step_bps", 1, 10_000),
    impeachThresholdBps: int(o["impeach_threshold_bps"], "impeach_threshold_bps", 1, 10_000),
    nominateBond: u128(o["nominate_bond"], "nominate_bond"),
  };
}

export function parsePolicy(v: unknown, maxRateBps: number): Policy {
  const o = obj(v, "get_policy");
  const last = o["last_set_epoch"];
  return {
    epoch: int(o["epoch"], "epoch", 0),
    rateBps: int(o["rate_bps"], "rate_bps", -maxRateBps, maxRateBps),
    chair: accountId(o["chair"], "chair"),
    streak: int(o["streak"], "streak", 0),
    lastSetEpoch: last === null || last === undefined ? null : int(last, "last_set_epoch", 0),
    epochEndsMs: int(o["epoch_ends_ms"], "epoch_ends_ms", 0),
  };
}

export function parseStaking(v: unknown): Staking {
  const o = obj(v, "get_reward_pool");
  return { totalStaked: u128(o["total_staked"], "total_staked"), rewardPool: u128(o["reward_pool"], "reward_pool") };
}
