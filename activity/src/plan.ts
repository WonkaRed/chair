// The plan for one epoch: what each of our holder accounts does, as a pure function of (seed, observed state).
// The same seed and the same chain state give the same plan, so a restart or a test replays it exactly.
//
// Three properties are built into the arithmetic rather than checked afterwards:
//  - an action is only ever a transfer, stake, unstake or claim (`HolderAction` has no other member),
//  - no action moves more than a fixed fraction of a balance, so no account can be drained,
//  - a stake or unstake is clamped so the staked share of the supply stays inside the band.

import { createHash } from "node:crypto";

export const TOKEN = 10n ** 24n;
/** Staked share of the total supply, in basis points: the plan never moves it outside this band. */
export const BAND_LOW_BPS = 2_000n;
export const BAND_HIGH_BPS = 6_000n;
/** The contract's `STAKE_LOCK_EPOCHS` (SPEC.md "Staking"): staked in epoch `e`, unstake allowed from `e + 2`. */
const STAKE_LOCK_EPOCHS = 2;
/** Each holder takes one action, or two with this chance (percent). */
const SECOND_ACTION_PERCENT = 40;
/** What a holder does in an acting epoch on average, when it can: one action, plus the second with its chance. */
export const EXPECTED_ACTIONS_PER_HOLDER = 1 + SECOND_ACTION_PERCENT / 100;
/** Fraction of the sender's liquid balance, in basis points: a transfer moves 1% to 5%. */
const TRANSFER_BPS = { min: 100, max: 500 } as const;
/** Fraction of the liquid balance (stake) or the staked balance (unstake): 2% to 10%. */
const STAKE_BPS = { min: 200, max: 1_000 } as const;
/** Relative weights of the three kinds of move; the weight of stake against unstake is set by the band. */
const WEIGHT = { transfer: 40, stakeChange: 40, claim: 20 } as const;

export type HolderAction =
  | { readonly kind: "transfer"; readonly from: string; readonly to: string; readonly amount: bigint }
  | { readonly kind: "stake"; readonly account: string; readonly amount: bigint }
  | { readonly kind: "unstake"; readonly account: string; readonly amount: bigint }
  | { readonly kind: "claim"; readonly account: string };

/** The account that signs the action. */
export function signerOf(action: HolderAction): string {
  return action.kind === "transfer" ? action.from : action.account;
}

export interface HolderState {
  readonly id: string;
  readonly liquid: bigint;
  readonly staked: bigint;
  readonly pending: bigint;
  readonly unlockEpoch: number;
}

export interface World {
  readonly epoch: number;
  /** The rate in effect, for the log only: the plan does not depend on it. */
  readonly rateBps: number;
  readonly totalSupply: bigint;
  readonly totalStaked: bigint;
  readonly holders: readonly HolderState[];
}

/** mulberry32 seeded from sha256(seed:epoch): every epoch has its own stream, whatever happened before it. */
class Rng {
  private state: number;
  constructor(seed: string, epoch: number) {
    this.state = createHash("sha256").update(`${seed}:${epoch}`).digest().readUInt32BE(0);
  }

  private next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** An integer in [min, max]. */
  between(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(percent: number): boolean {
    return this.next() * 100 < percent;
  }

  /** The index of a weighted draw; `weights` must have a positive sum. */
  weighted(weights: readonly number[]): number {
    let point = this.next() * weights.reduce((a, b) => a + b, 0);
    for (const [i, w] of weights.entries()) {
      if (point < w) return i;
      point -= w;
    }
    return weights.length - 1;
  }

  shuffled<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.between(0, i);
      [out[i], out[j]] = [out[j] as T, out[i] as T];
    }
    return out;
  }
}

const floorToTokens = (v: bigint): bigint => v - (v % TOKEN);
const clamp = (v: bigint, lo: bigint, hi: bigint): bigint => (v < lo ? lo : v > hi ? hi : v);

/** The state the plan changes as it goes, so a holder's second action and the next holder see the first. */
interface SimHolder {
  liquid: bigint;
  staked: bigint;
  pending: bigint;
  unlockEpoch: number;
}

interface Sim {
  readonly epoch: number;
  readonly totalSupply: bigint;
  totalStaked: bigint;
  readonly holders: Map<string, SimHolder>;
}

function holderOf(sim: Sim, id: string): SimHolder {
  const h = sim.holders.get(id);
  if (h === undefined) throw new Error(`unknown holder ${id}`);
  return h;
}

/** An amount of 1 whole token up to `cap`, `bps` of `balance` (the fraction drawn from [min, max]), in whole tokens. */
function amountOf(rng: Rng, balance: bigint, range: { readonly min: number; readonly max: number }, cap: bigint): bigint {
  const wanted = floorToTokens((balance * BigInt(rng.between(range.min, range.max))) / 10_000n);
  return clamp(wanted, TOKEN, floorToTokens(cap));
}

/** What each kind of move may reach right now, as an upper bound in yocto; below one token it is not possible. */
function caps(sim: Sim, id: string): { transfer: bigint; stake: bigint; unstake: bigint; claim: bigint } {
  const h = holderOf(sim, id);
  const lowStake = (BAND_LOW_BPS * sim.totalSupply) / 10_000n;
  const highStake = (BAND_HIGH_BPS * sim.totalSupply) / 10_000n;
  const unlocked = h.unlockEpoch <= sim.epoch;
  return {
    transfer: (h.liquid * BigInt(TRANSFER_BPS.max)) / 10_000n,
    stake: clamp(highStake - sim.totalStaked, 0n, (h.liquid * BigInt(STAKE_BPS.max)) / 10_000n),
    unstake: unlocked ? clamp(sim.totalStaked - lowStake, 0n, (h.staked * BigInt(STAKE_BPS.max)) / 10_000n) : 0n,
    claim: h.pending,
  };
}

/** Chance (basis points) that a stake change is a stake: 100% at the bottom of the band, 0% at the top. */
function stakeBias(sim: Sim): number {
  const share = (sim.totalStaked * 10_000n) / sim.totalSupply;
  return Number(clamp(((BAND_HIGH_BPS - share) * 10_000n) / (BAND_HIGH_BPS - BAND_LOW_BPS), 0n, 10_000n));
}

type Move = "transfer" | "stake" | "unstake" | "claim";

/** A holder takes at most one move of each family an epoch: stake and unstake are one family. */
const familyOf = (move: Move): string => (move === "unstake" ? "stake" : move);

function applyMove(rng: Rng, sim: Sim, id: string, move: Move): HolderAction {
  const h = holderOf(sim, id);
  const cap = caps(sim, id);
  switch (move) {
    case "transfer": {
      const others = [...sim.holders.keys()].filter((o) => o !== id);
      const to = others[rng.between(0, others.length - 1)] as string;
      const amount = amountOf(rng, h.liquid, TRANSFER_BPS, cap.transfer);
      h.liquid -= amount;
      holderOf(sim, to).liquid += amount;
      return { kind: "transfer", from: id, to, amount };
    }
    case "stake": {
      const amount = amountOf(rng, h.liquid, STAKE_BPS, cap.stake);
      h.liquid -= amount;
      h.staked += amount;
      h.unlockEpoch = sim.epoch + STAKE_LOCK_EPOCHS;
      sim.totalStaked += amount;
      return { kind: "stake", account: id, amount };
    }
    case "unstake": {
      const amount = amountOf(rng, h.staked, STAKE_BPS, cap.unstake);
      h.staked -= amount;
      h.liquid += amount;
      sim.totalStaked -= amount;
      return { kind: "unstake", account: id, amount };
    }
    case "claim":
      h.liquid += h.pending;
      h.pending = 0n;
      return { kind: "claim", account: id };
  }
}

/** One or two actions per holder, in a seeded order. A holder with nothing sensible to do (no balance) does nothing. */
export function planEpoch(seed: string, world: World): HolderAction[] {
  if (world.totalSupply <= 0n || world.holders.length < 2) return [];
  const rng = new Rng(seed, world.epoch);
  const sim: Sim = {
    epoch: world.epoch,
    totalSupply: world.totalSupply,
    totalStaked: world.totalStaked,
    holders: new Map(world.holders.map((h) => [h.id, { liquid: h.liquid, staked: h.staked, pending: h.pending, unlockEpoch: h.unlockEpoch }])),
  };
  const plan: HolderAction[] = [];
  for (const id of rng.shuffled(world.holders.map((h) => h.id))) {
    const taken = new Set<string>();
    for (let n = rng.chance(SECOND_ACTION_PERCENT) ? 2 : 1; n > 0; n--) {
      const cap = caps(sim, id);
      const bias = stakeBias(sim);
      // A kind below one token is not possible.
      const offers: { move: Move; weight: number }[] = [
        { move: "transfer", weight: cap.transfer >= TOKEN ? WEIGHT.transfer : 0 },
        { move: "stake", weight: cap.stake >= TOKEN ? (WEIGHT.stakeChange * bias) / 10_000 : 0 },
        { move: "unstake", weight: cap.unstake >= TOKEN ? (WEIGHT.stakeChange * (10_000 - bias)) / 10_000 : 0 },
        { move: "claim", weight: cap.claim >= TOKEN ? WEIGHT.claim : 0 },
      ];
      const options = offers.filter((o) => o.weight > 0 && !taken.has(familyOf(o.move)));
      if (options.length === 0) break;
      const { move } = options[rng.weighted(options.map((o) => o.weight))] as (typeof options)[number];
      taken.add(familyOf(move));
      plan.push(applyMove(rng, sim, id, move));
    }
  }
  return plan;
}
