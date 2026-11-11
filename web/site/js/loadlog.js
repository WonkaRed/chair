// Reads the chain's views and the token's transactions, builds the mint/burn log and reconciles it with `get_supply`.
// The result says what is known and what is not; it never fills a gap with a guess.
//
//   status "complete"    the log's sums equal the chain's ledger at the block of the last logged transaction
//   status "mismatch"    the indexer answered, and its events do not add up to the chain's ledger
//   status "incomplete"  the indexer could not be read (down, rate limited, truncated): no sum is claimed
//   status "unverified"  the log was read but the state at its last block could not be, so the sums cannot be pinned
// RPC views failing is a different failure: nothing can be shown, `loadLog` throws.
import { parseU128 } from "./amounts.js";
import { decisionsOfTxs } from "./decisions.js";
import { buildEntries, identity, reconcile } from "./ledger.js";
import { lastTokenHeight } from "./events.js";
import { SourceError } from "./sources.js";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v, what) => {
  if (!Number.isSafeInteger(v) || v < 0) throw new SourceError("rpc", `${what}: not a non-negative integer`);
  return v;
};

export function parseSupply(v) {
  if (!isObj(v)) throw new SourceError("rpc", "get_supply: not an object");
  try {
    return {
      epoch: int(v.epoch, "epoch"),
      launchSupply: parseU128(v.launch_supply, "launch_supply"),
      minted: parseU128(v.minted, "minted"),
      burned: parseU128(v.burned, "burned"),
      totalSupply: parseU128(v.total_supply, "total_supply"),
      totalStaked: parseU128(v.total_staked, "total_staked"),
      rewardPool: parseU128(v.reward_pool, "reward_pool"),
    };
  } catch (e) {
    if (e instanceof SourceError) throw e;
    throw new SourceError("rpc", `get_supply: ${e.message}`);
  }
}

export function parseParams(v) {
  if (!isObj(v)) throw new SourceError("rpc", "get_params: not an object");
  return { epochMs: int(v.epoch_ms, "epoch_ms"), startMs: int(v.start_ms, "start_ms"), maxRateBps: int(v.max_rate_bps, "max_rate_bps"), maxStepBps: int(v.max_step_bps, "max_step_bps"), impeachThresholdBps: int(v.impeach_threshold_bps, "impeach_threshold_bps") };
}

export function parsePolicy(v) {
  if (!isObj(v)) throw new SourceError("rpc", "get_policy: not an object");
  if (!Number.isSafeInteger(v.rate_bps) || typeof v.chair !== "string") throw new SourceError("rpc", "get_policy: bad shape");
  return { epoch: int(v.epoch, "epoch"), rateBps: v.rate_bps, chair: v.chair, streak: int(v.streak, "streak"), lastSetEpoch: v.last_set_epoch === null || v.last_set_epoch === undefined ? null : int(v.last_set_epoch, "last_set_epoch"), epochEndsMs: int(v.epoch_ends_ms, "epoch_ends_ms") };
}

export async function loadLog(transport) {
  const [rawParams, rawPolicy, rawSupply] = await Promise.all([transport.view("get_params"), transport.view("get_policy"), transport.view("get_supply")]);
  const params = parseParams(rawParams);
  const policy = parsePolicy(rawPolicy);
  const supply = parseSupply(rawSupply);
  const keys = await transport.accessKeys().then((n) => n, () => null);

  const base = { params, policy, supply, identity: identity(supply), accessKeys: keys, entries: [], decisions: [], anomalies: [], reconcile: null, pending: null, txCount: 0, reasons: [] };
  let txs;
  try {
    txs = await transport.transactions(await transport.txHashes());
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    return { ...base, status: "incomplete", reasons: [`The transaction index could not be read to its end (${e.source}: ${e.message}). Totals above come from the chain; no event total is claimed.`], retryable: e.retryable };
  }
  const { entries, anomalies } = buildEntries(txs, transport.token, params);
  const height = lastTokenHeight(txs, transport.token);
  const { decisions, unreadable } = decisionsOfTxs(txs, transport.token);
  if (unreadable > 0) anomalies.push(`${unreadable} policy_set event${unreadable === 1 ? "" : "s"} could not be read and ${unreadable === 1 ? "is" : "are"} not listed in the chair minutes`);
  const out = { ...base, entries, decisions, anomalies, txCount: txs.length };

  // Pin the chain's ledger to the block of the last logged transaction, so a mint that is due but not yet applied
  // (views project it, no event exists until the next transaction) is not mistaken for a missing event.
  let pinned = supply;
  let pinnedOk = height === null;
  if (height !== null) {
    try {
      pinned = parseSupply(await transport.view("get_supply", { blockHeight: height }));
      pinnedOk = true;
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
    }
  }
  out.pinnedHeight = height;
  out.reconcile = reconcile(entries, pinned);
  out.pinnedSupply = pinned;
  out.pending = pinnedOk && pinned.minted !== supply.minted ? { minted: supply.minted - pinned.minted } : null;
  if (out.reconcile.ok) return { ...out, status: "complete" };
  if (!pinnedOk) return { ...out, status: "unverified", reasons: ["The chain's state at the last logged block could not be read (a non-archival RPC node drops old blocks), so the event sums cannot be pinned to it. A difference may be a mint that is due and not yet applied."] };
  return { ...out, status: "mismatch", reasons: ["The events found do not add up to the chain's ledger. The log below is not complete."] };
}
