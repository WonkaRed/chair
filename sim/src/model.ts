// The contract's integer arithmetic, written again from SPEC.md "Epochs and rollover" and read against
// contract/src/{policy,rollover,staking,voting}.rs (see README.md for the state of those files). It does
// not execute the contract. Amounts are bigint (u128 on chain), rates are plain integers (i32).
// bigint division truncates toward zero, which is floor for the non-negative operands used here.

export const MAX_RATE_BPS = 200;
export const MAX_STEP_BPS = 50;
/** contract `QUORUM_BPS`: share of the whole supply a seated candidate's backing must also exceed. */
export const QUORUM_BPS = 500;
/** contract `MAX_IMPEACH_THRESHOLD_BPS`: `new` rejects a threshold above half the stake, so the seat stays within a majority's reach. */
export const MAX_IMPEACH_THRESHOLD_BPS = 5_000;
export const REWARD_SCALE = 10n ** 24n;
export const MAX_TOTAL_SUPPLY = (2n ** 128n - 1n) / 10_000n;
const U256_MAX = 2n ** 256n - 1n;

/** Multiply then floor-divide with the 256-bit intermediate the contract uses. */
function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  const p = a * b;
  if (p > U256_MAX) throw new RangeError("intermediate exceeds 256 bits");
  return p / d;
}

/** Step 1 (easing): `min(supply * rate / 10_000, MAX_TOTAL_SUPPLY - supply)`, nothing if rate <= 0 or nobody staked. */
export function mintAmount(totalSupply: bigint, rateBps: number, totalStaked: bigint): bigint {
  if (rateBps <= 0 || totalStaked === 0n) return 0n;
  const minted = mulDiv(totalSupply, BigInt(rateBps), 10_000n);
  const room = MAX_TOTAL_SUPPLY - totalSupply;
  return minted < room ? minted : room < 0n ? 0n : room;
}

/** `reward_per_share += minted * REWARD_SCALE / total_staked`, floor; the remainder stays in the pool. */
export function rewardPerShareDelta(minted: bigint, totalStaked: bigint): bigint {
  return mulDiv(minted, REWARD_SCALE, totalStaked);
}

/** A staker's pending reward: `staked * (reward_per_share - paid_per_share) / REWARD_SCALE`, floor. */
export function pendingReward(staked: bigint, rewardPerShare: bigint, paidPerShare: bigint): bigint {
  return mulDiv(staked, rewardPerShare - paidPerShare, REWARD_SCALE);
}

/** Transfer burn: `amount * abs(rate) / 10_000`, floor, only while the rate is negative. */
export function burnAmount(amount: bigint, rateBps: number): bigint {
  return rateBps >= 0 ? 0n : mulDiv(amount, BigInt(-rateBps), 10_000n);
}

/** Step 2 (decay): one `MAX_STEP_BPS` step toward zero, never past it. */
export function decay(rateBps: number): number {
  return rateBps - Math.sign(rateBps) * Math.min(Math.abs(rateBps), MAX_STEP_BPS);
}

export type PolicyError = "policy already set this epoch" | "rate_bps out of bounds" | "rate step too large";

/** The chair's rate state: the rate in effect and the last epoch the chair acted in. */
export class Policy {
  rateBps = 0;
  lastSetEpoch: number | null = null;

  /** `set_policy` checks 3 to 5 of SPEC "Methods", in order. Returns the error or null when accepted. */
  setRate(epoch: number, rateBps: number): PolicyError | null {
    if (this.lastSetEpoch === epoch) return "policy already set this epoch";
    if (!Number.isInteger(rateBps) || Math.abs(rateBps) > MAX_RATE_BPS) return "rate_bps out of bounds";
    if (Math.abs(rateBps - this.rateBps) > MAX_STEP_BPS) return "rate step too large";
    this.rateBps = rateBps;
    this.lastSetEpoch = epoch;
    return null;
  }

  /** Boundary step 2 for the epoch being closed; returns the rate the closing epoch ran at. */
  decayAfter(closing: number): void {
    if (this.lastSetEpoch !== closing) this.rateBps = decay(this.rateBps);
  }
}

export interface Candidate {
  readonly id: string;
  /** Backing in token base units, as of the boundary. */
  readonly backing: bigint;
  /** Order of nomination (the contract's never-reused candidate id), lowest first; breaks ties. */
  readonly order: number;
}

/**
 * Step 3: among candidates with `backing * 10_000 > max(threshold_bps * total_staked, QUORUM_BPS * total_supply)`
 * (strictly greater), the one with the most backing wins; ties go to the earliest nomination. `totalSupply` is the
 * supply before the boundary's mint.
 */
export function impeachmentWinner(
  candidates: readonly Candidate[], thresholdBps: number, totalStaked: bigint, totalSupply: bigint,
): Candidate | null {
  const stakeBar = BigInt(thresholdBps) * totalStaked;
  const supplyBar = BigInt(QUORUM_BPS) * totalSupply;
  const bar = stakeBar > supplyBar ? stakeBar : supplyBar;
  let best: Candidate | null = null;
  for (const c of candidates) {
    if (c.backing * 10_000n <= bar) continue;
    if (best === null || c.backing > best.backing || (c.backing === best.backing && c.order < best.order)) best = c;
  }
  return best;
}
