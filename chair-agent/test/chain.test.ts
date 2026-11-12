import assert from "node:assert/strict";
import { test } from "node:test";
import { ChainReader } from "../src/chain.js";
import type { NearRpc } from "../src/rpc.js";

const START = 1_700_000_000_000;
const EPOCH_MS = 60_000;
const NOW = START + 5 * EPOCH_MS + 1000; // epoch 5

function reader(o: { policyEpoch?: number; epochEndsMs?: number; maxRate?: number; maxStep?: number; meetingsPerDay?: number | null } = {}): ChainReader {
  const epoch = o.policyEpoch ?? 5;
  const views: Record<string, unknown> = {
    get_params: { epoch_ms: EPOCH_MS, ...(o.meetingsPerDay === null ? {} : { meetings_per_day: o.meetingsPerDay ?? Math.ceil(86_400_000 / EPOCH_MS) }), start_ms: START, max_rate_bps: o.maxRate ?? 200, max_step_bps: o.maxStep ?? 50, impeach_threshold_bps: 5000, quorum_bps: 500, nominate_bond: "1" },
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

test("a token that does not report meetings_per_day (the old per-meeting rate) is refused, so the agent never writes per-day minutes for it", async () => {
  await assert.rejects(reader({ meetingsPerDay: null }).snapshot(), /meetings_per_day: expected an integer in 1\.\./);
});

test("a meetings_per_day that is not the epoch's own day divided up is refused", async () => {
  const day = Math.ceil(86_400_000 / EPOCH_MS);
  for (const bad of [1, day - 1, day + 1]) {
    await assert.rejects(reader({ meetingsPerDay: bad }).snapshot(), /is not \d+, the day divided into .* ms epochs; refusing to act/, String(bad));
  }
  assert.equal((await reader({ meetingsPerDay: day }).snapshot()).params.meetingsPerDay, day);
});

test("the pool's view comes from the newest block, with the snapshot, its stake, its unlock epoch, what it backs and its liquid coins", async () => {
  const asked: { finality: string | undefined; account: unknown; method: string; at: string }[] = [];
  const views: Record<string, unknown> = {
    get_params: { epoch_ms: EPOCH_MS, meetings_per_day: 1440, start_ms: START, max_rate_bps: 200, max_step_bps: 50, impeach_threshold_bps: 3000, quorum_bps: 500, nominate_bond: "1" },
    get_policy: { epoch: 5, rate_bps: 10, chair: "chair.test", streak: 1, last_set_epoch: null, epoch_ends_ms: START + 6 * EPOCH_MS },
    ft_total_supply: "1000000",
    get_reward_pool: { total_staked: "100", reward_pool: "0", reward_per_share: "0" },
    get_staking: { staked: "30", pending_reward: "0", backing: null, unlock_epoch: 7 },
    ft_balance_of: "70",
  };
  const rpc = {
    finalBlock: (finality?: string) => (asked.push({ finality, account: null, method: "block", at: "" }), Promise.resolve({ hash: "h", timestampMs: NOW })),
    view: (_c: string, method: string, args: Record<string, unknown>, at: string) => (asked.push({ finality: undefined, account: args["account_id"], method, at }), Promise.resolve(views[method])),
  };
  const reader = new ChainReader(rpc as unknown as NearRpc, "token.test", "pool.test");
  const p = await reader.pool();
  assert.deepEqual([p.staked, p.liquid, p.unlockEpoch, p.backing, p.snapshot.policy.epoch], [30n, 70n, 7, null, 5]);
  assert.equal(asked[0]!.finality, "optimistic");
  assert.deepEqual(asked.filter((a) => a.method === "get_staking" || a.method === "ft_balance_of").map((a) => [a.account, a.at]), [["pool.test", "h"], ["pool.test", "h"]]);

  views["get_staking"] = { staked: "30", pending_reward: "0", backing: "someone.test", unlock_epoch: 7 };
  assert.equal((await reader.pool()).backing, "someone.test");
  views["get_staking"] = { staked: 30, pending_reward: "0", backing: null, unlock_epoch: 7 };
  await assert.rejects(reader.pool(), /U128/);
  await assert.rejects(new ChainReader(rpc as unknown as NearRpc, "token.test").pool(), /no pool account/);
});
