import { DEFAULT_BOUNDS, meetingsPerDay } from "./bounds.js";
import { NearRpc, RpcError, type FinalBlock } from "./rpc.js";
import type { PoolView, Snapshot } from "./types.js";
import { parseParams, parsePolicy, parseStaking, parseStakingView, u128, ValidationError } from "./validate.js";

export interface Reader {
  snapshot(): Promise<Snapshot>;
}

/** What the visitor pool's decisions need, all from one block: the token's snapshot and the pool account's own stake and coins. */
export interface PoolReader {
  pool(): Promise<PoolView>;
}

/** Reads the token's views at one final block so time, policy and supply agree with each other. */
export class ChainReader implements Reader, PoolReader {
  constructor(
    private readonly rpc: NearRpc,
    private readonly token: string,
    /** The visitor pool's account, when the press desk runs "Join the Committee". */
    private readonly poolAccount: string | null = null,
  ) {}

  async snapshot(): Promise<Snapshot> {
    return this.snapshotAt(await this.rpc.finalBlock());
  }

  /** The newest block, not the newest final one: a stake the pool sent a moment ago is already in it, where `final` lags it by a few seconds. */
  async pool(): Promise<PoolView> {
    if (this.poolAccount === null) throw new Error("no pool account is configured");
    const block = await this.rpc.finalBlock("optimistic");
    const args = { account_id: this.poolAccount };
    const [snapshot, staking, liquid] = await Promise.all([
      this.snapshotAt(block),
      this.rpc.view(this.token, "get_staking", args, block.hash).then(parseStakingView),
      this.rpc.view(this.token, "ft_balance_of", args, block.hash).then((v) => u128(v, "ft_balance_of")),
    ]);
    return { snapshot, staked: staking.staked, unlockEpoch: staking.unlockEpoch, backing: staking.backing, liquid };
  }

  private async snapshotAt(block: FinalBlock): Promise<Snapshot> {
    const view = (m: string) => this.rpc.view(this.token, m, {}, block.hash);
    const [rawParams, rawPolicy, rawSupply, staking] = await Promise.all([
      view("get_params"),
      view("get_policy"),
      view("ft_total_supply"),
      view("get_reward_pool").then(parseStaking, (err: unknown) => {
        // Until the staking lane lands the method does not exist; that is "no figures", not a failure.
        if (err instanceof RpcError && err.methodMissing) return null;
        throw err;
      }),
    ]);
    const params = parseParams(rawParams);
    // The contract hard-codes these (SPEC "Methods"); a node reporting anything else is wrong or hostile, and the agent's clamping would be built on it.
    if (params.maxRateBps !== DEFAULT_BOUNDS.maxRateBps || params.maxStepBps !== DEFAULT_BOUNDS.maxStepBps) {
      throw new ValidationError("get_params", `bounds ${params.maxRateBps}/${params.maxStepBps} differ from the contract's ${DEFAULT_BOUNDS.maxRateBps}/${DEFAULT_BOUNDS.maxStepBps}; refusing to act`);
    }
    // A token without `meetings_per_day` (rejected in `parseParams`) has the old per-meeting rate, and the minutes say per day; a figure that is not the epoch's own is as wrong.
    if (params.meetingsPerDay !== meetingsPerDay(params.epochMs)) {
      throw new ValidationError("get_params", `meetings_per_day ${params.meetingsPerDay} is not ${meetingsPerDay(params.epochMs)}, the day divided into ${params.epochMs} ms epochs; refusing to act`);
    }
    const policy = parsePolicy(rawPolicy, params.maxRateBps);
    const epoch = block.timestampMs < params.startMs ? 0 : Math.floor((block.timestampMs - params.startMs) / params.epochMs);
    if (policy.epoch !== epoch || policy.epochEndsMs !== params.startMs + (epoch + 1) * params.epochMs) {
      throw new ValidationError("get_policy", "epoch does not match the block time and get_params");
    }
    return { blockTimeMs: block.timestampMs, params, policy, totalSupply: u128(rawSupply, "ft_total_supply"), staking };
  }
}
