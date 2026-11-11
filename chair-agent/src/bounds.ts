// The contract's rate rules, as numbers. SPEC.md "Methods" (set_policy checks 4 and 5) and "Rollover"
// (decay) are the source; contract/src/policy.rs is the reference implementation.

export interface Bounds {
  readonly maxRateBps: number;
  readonly maxStepBps: number;
}

/** What the deployed contract reports through get_params; the contract hard-codes 200 and 50. */
export const DEFAULT_BOUNDS: Bounds = { maxRateBps: 200, maxStepBps: 50 };

declare const accepted: unique symbol;

/**
 * An integer rate inside a `RateWindow`. The only way to get one is `RateWindow.pick`, and the only
 * thing the signer accepts is a `Rate`, so a proposal outside the bounds cannot reach a transaction.
 */
export type Rate = number & { readonly [accepted]: true };

/** The set of rates `set_policy` accepts: `lo..=hi`, both ends included. */
export class RateWindow {
  private constructor(
    readonly lo: number,
    readonly hi: number,
  ) {}

  /** Rates reachable from `rateInEffect` in one call: within the step and within the rate bound. */
  static around(rateInEffect: number, b: Bounds): RateWindow {
    assertRate(rateInEffect, b);
    return new RateWindow(
      Math.max(-b.maxRateBps, rateInEffect - b.maxStepBps),
      Math.min(b.maxRateBps, rateInEffect + b.maxStepBps),
    );
  }

  /**
   * Rates valid whether the call lands in the current epoch or, after a rollover in flight, in the next
   * one. A chair that has not acted this epoch sees its rate decayed at the boundary, and the step
   * is then measured from the decayed rate. `rateInEffect` itself is always in both windows, so the
   * result is never empty.
   */
  static acrossRollover(rateInEffect: number, b: Bounds): RateWindow {
    const now = RateWindow.around(rateInEffect, b);
    const next = RateWindow.around(decay(rateInEffect, b), b);
    return new RateWindow(Math.max(now.lo, next.lo), Math.min(now.hi, next.hi));
  }

  contains(rate: number): boolean {
    return Number.isInteger(rate) && rate >= this.lo && rate <= this.hi;
  }

  /** The nearest accepted rate to `wanted`. Throws on anything that is not a finite integer. */
  pick(wanted: number): Rate {
    if (!Number.isSafeInteger(wanted)) throw new TypeError(`rate must be an integer, got ${wanted}`);
    return Math.min(this.hi, Math.max(this.lo, wanted)) as Rate;
  }
}

/** One missed-epoch decay step toward zero, never overshooting it (policy.rs `advance_to`). */
export function decay(rate: number, b: Bounds): number {
  return rate - Math.sign(rate) * Math.min(Math.abs(rate), b.maxStepBps);
}

function assertRate(rate: number, b: Bounds): void {
  if (!Number.isSafeInteger(rate) || Math.abs(rate) > b.maxRateBps) {
    throw new RangeError(`rate in effect ${rate} is outside +-${b.maxRateBps}`);
  }
}
