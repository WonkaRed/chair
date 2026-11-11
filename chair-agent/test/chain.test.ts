import assert from "node:assert/strict";
import { test } from "node:test";
import { ChainReader } from "../src/chain.js";
import type { NearRpc } from "../src/rpc.js";

const START = 1_700_000_000_000;
const EPOCH_MS = 60_000;
const NOW = START + 5 * EPOCH_MS + 1000; // epoch 5

function reader(o: { policyEpoch?: number; epochEndsMs?: number; maxRate?: number; maxStep?: number } = {}): ChainReader {
  const epoch = o.policyEpoch ?? 5;
  const views: Record<string, unknown> = {
    get_params: { epoch_ms: EPOCH_MS, start_ms: START, max_rate_bps: o.maxRate ?? 200, max_step_bps: o.maxStep ?? 50, impeach_threshold_bps: 5000, quorum_bps: 500, nominate_bond: "1" },
    get_policy: { epoch, rate_bps: 10, chair: "chair.test", streak: 1, last_set_epoch: null, epoch_ends_ms: o.epochEndsMs ?? START + (epoch + 1) * EPOCH_MS },
    ft_total_supply: "1000000",
    get_reward_pool: { total_staked: "100", reward_pool: "0", reward_per_share: "0" },
  };
  const rpc = {
    finalBlock: () => Promise.resolve({ hash: "h", timestampMs: NOW }),
    view: (_c: string, method: string) => Promise.resolve(views[method]),
  };
  return new ChainReader(rpc as unknown as NearRpc, "token.test");
}

test("a consistent chain reads as a snapshot", async () => {
  const s = await reader().snapshot();
  assert.equal(s.policy.epoch, 5);
  assert.equal(s.totalSupply, 1_000_000n);
  assert.equal(s.staking?.totalStaked, 100n);
});

test("a policy whose epoch disagrees with the block time and the params is refused", async () => {
  for (const policyEpoch of [4, 6, 0]) {
    await assert.rejects(reader({ policyEpoch }).snapshot(), /epoch does not match the block time/, `epoch ${policyEpoch}`);
  }
  // The policy lies about its epoch but reports the end of the real epoch 5: only the epoch comparison can catch it.
  await assert.rejects(reader({ policyEpoch: 4, epochEndsMs: START + 6 * EPOCH_MS }).snapshot(), /epoch does not match the block time/);
  await assert.rejects(reader({ epochEndsMs: START + 6 * EPOCH_MS + 1 }).snapshot(), /epoch does not match the block time/);
});

test("params that differ from the contract's hard-coded bounds are refused, not trusted", async () => {
  await assert.rejects(reader({ maxRate: 10_000 }).snapshot(), /differ from the contract's 200\/50; refusing to act/);
  await assert.rejects(reader({ maxStep: 51 }).snapshot(), /differ from the contract's 200\/50/);
  await assert.rejects(reader({ maxRate: 199 }).snapshot(), /differ from the contract's 200\/50/);
});
