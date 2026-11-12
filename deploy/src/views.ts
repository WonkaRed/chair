// The token's views (SPEC.md "Views") as typed reads. `U128` fields are decimal strings on the wire; they are
// converted to bigint once, here, so no caller does arithmetic on strings.

import type { TestnetAccount } from "./guard.ts";
import type { Rpc } from "./rpc.ts";

export interface Params {
  readonly epochMs: number;
  /** Meetings in a day: the divisor of a mint, since a positive rate is basis points of supply per day. */
  readonly meetingsPerDay: number;
  readonly startMs: number;
  readonly maxRateBps: number;
  readonly maxStepBps: number;
  readonly impeachThresholdBps: number;
  readonly quorumBps: number;
  readonly nominateBond: bigint;
}

export interface Policy {
  readonly epoch: number;
  readonly rateBps: number;
  readonly chair: string;
  readonly streak: number;
  readonly lastSetEpoch: number | null;
  readonly epochEndsMs: number;
}

export interface Supply {
  readonly epoch: number;
  readonly launch: bigint;
  readonly minted: bigint;
  readonly burned: bigint;
  readonly total: bigint;
  readonly staked: bigint;
  readonly rewardPool: bigint;
}

export interface Staking {
  readonly staked: bigint;
  readonly pendingReward: bigint;
  readonly backing: string | null;
  readonly unlockEpoch: number;
}

export interface Candidate {
  readonly candidate: string;
  readonly nominator: string;
  readonly backing: bigint;
  readonly bond: bigint;
}

type Wire = Record<string, unknown>;

function num(w: Wire, key: string): number {
  const v = w[key];
  if (!Number.isSafeInteger(v)) throw new Error(`view field ${key} is not an integer`);
  return v as number;
}

function big(w: Wire, key: string): bigint {
  const v = w[key];
  if (typeof v !== "string" || !/^\d+$/.test(v)) throw new Error(`view field ${key} is not a decimal string`);
  return BigInt(v);
}

function text(w: Wire, key: string): string {
  const v = w[key];
  if (typeof v !== "string") throw new Error(`view field ${key} is not a string`);
  return v;
}

export class TokenViews {
  private readonly rpc: Rpc;
  readonly token: TestnetAccount;
  constructor(rpc: Rpc, token: TestnetAccount) {
    this.rpc = rpc;
    this.token = token;
  }

  async params(): Promise<Params> {
    const w = await this.rpc.view<Wire>(this.token, "get_params");
    return { epochMs: num(w, "epoch_ms"), meetingsPerDay: num(w, "meetings_per_day"), startMs: num(w, "start_ms"), maxRateBps: num(w, "max_rate_bps"), maxStepBps: num(w, "max_step_bps"), impeachThresholdBps: num(w, "impeach_threshold_bps"), quorumBps: num(w, "quorum_bps"), nominateBond: big(w, "nominate_bond") };
  }

  async policy(): Promise<Policy> {
    const w = await this.rpc.view<Wire>(this.token, "get_policy");
    const last = w["last_set_epoch"];
    return { epoch: num(w, "epoch"), rateBps: num(w, "rate_bps"), chair: text(w, "chair"), streak: num(w, "streak"), lastSetEpoch: last === null ? null : num(w, "last_set_epoch"), epochEndsMs: num(w, "epoch_ends_ms") };
  }

  async supply(): Promise<Supply> {
    const w = await this.rpc.view<Wire>(this.token, "get_supply");
    return { epoch: num(w, "epoch"), launch: big(w, "launch_supply"), minted: big(w, "minted"), burned: big(w, "burned"), total: big(w, "total_supply"), staked: big(w, "total_staked"), rewardPool: big(w, "reward_pool") };
  }

  async staking(account: string): Promise<Staking> {
    const w = await this.rpc.view<Wire>(this.token, "get_staking", { account_id: account });
    const backing = w["backing"];
    return { staked: big(w, "staked"), pendingReward: big(w, "pending_reward"), backing: backing === null ? null : text(w, "backing"), unlockEpoch: num(w, "unlock_epoch") };
  }

  async candidates(): Promise<Candidate[]> {
    const list = await this.rpc.view<Wire[]>(this.token, "get_candidates");
    return list.map((w) => ({ candidate: text(w, "candidate"), nominator: text(w, "nominator"), backing: big(w, "backing"), bond: big(w, "bond") }));
  }

  async balance(account: string): Promise<bigint> {
    const v = await this.rpc.view<string>(this.token, "ft_balance_of", { account_id: account });
    if (typeof v !== "string") throw new Error("ft_balance_of: not a string");
    return BigInt(v);
  }

  async totalSupply(): Promise<bigint> {
    return BigInt(await this.rpc.view<string>(this.token, "ft_total_supply"));
  }

  /** The storage deposit an account must attach to register (`storage_balance_bounds.min`). */
  async storageMin(): Promise<bigint> {
    const w = await this.rpc.view<Wire>(this.token, "storage_balance_bounds");
    return big(w, "min");
  }
}
