import { DEFAULT_BOUNDS, meetingsPerDay } from "./bounds.js";
import { NearRpc, RpcError } from "./rpc.js";
import type { Snapshot } from "./types.js";
import { parseParams, parsePolicy, parseStaking, u128, ValidationError } from "./validate.js";

export interface Reader {
  snapshot(): Promise<Snapshot>;
}

/** Reads the token's views at one final block so time, policy and supply agree with each other. */
export class ChainReader implements Reader {
  constructor(
    private readonly rpc: NearRpc,
    private readonly token: string,
  ) {}

  async snapshot(): Promise<Snapshot> {
    const block = await this.rpc.finalBlock();
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
