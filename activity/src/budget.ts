// What the bot costs in NEAR and how long the holders' balances last: an estimate for the start line, from the gas
// measured on the live token, not a promise.

import { EXPECTED_ACTIONS_PER_HOLDER } from "./plan.ts";

/** A holder under 0.05 NEAR stops the bot: gas for dozens of epochs, so the stop comes before any call fails for want of it. */
export const NEAR_FLOOR = 5n * 10n ** 22n;
/** Gas burnt per call in NEAR, measured on the live token: 12 calls burnt 0.00302 NEAR (README.md, "Failure and gas"). */
const NEAR_PER_CALL = 0.00025;
const DAY_MS = 86_400_000;
const NEAR_YOCTO = 1e24;

export interface Budget {
  /** Expected NEAR one holder spends in a day. */
  readonly perHolderPerDay: number;
  /** Days until each holder falls under the floor at that rate, from the balances given. */
  readonly daysToFloor: ReadonlyMap<string, number>;
  /** The holder that reaches the floor first, and when. */
  readonly first: { readonly account: string; readonly days: number };
}

/** `every` is the acting period in epochs: the bot acts in one epoch of every `every`. `balances` must not be empty. */
export function projectBudget(balances: ReadonlyMap<string, bigint>, every: number, epochMs: number): Budget {
  const perHolderPerDay = (EXPECTED_ACTIONS_PER_HOLDER * NEAR_PER_CALL * (DAY_MS / epochMs)) / every;
  const daysToFloor = new Map([...balances].map(([id, v]) => [id, Math.max(Number(v - NEAR_FLOOR) / NEAR_YOCTO, 0) / perHolderPerDay]));
  const [account, days] = [...daysToFloor].reduce((a, b) => (b[1] < a[1] ? b : a));
  return { perHolderPerDay, daysToFloor, first: { account, days } };
}
