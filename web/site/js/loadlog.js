// Reads the chain's views and the token's transactions, builds the mint/burn log and reconciles it with `get_supply`.
// The result says what is known and what is not; it never fills a gap with a guess.
//
//   status "complete"    the log's sums equal the chain's ledger at the block of the last logged transaction
//   status "mismatch"    the indexer answered, and its events do not add up to the chain's ledger
//   status "incomplete"  the indexer could not be read (down, rate limited, truncated): no sum is claimed. `remembered` then holds the
//                        newest decision an earlier visit kept (at most one), so the page has something true to show; `decisions` stays empty
//   status "unverified"  the log was read but the state at its last block could not be, so the sums cannot be pinned
// RPC views failing is a different failure: nothing can be shown, `loadLog` throws.
import { parseU128 } from "./amounts.js";
import { decisionsOfTxs, refusalsOfTxs } from "./decisions.js";
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

/** `meetings_per_day` divides the mint, so a chain that reports 0 is malformed, not "no limit". */
const positive = (v, what) => {
  if (int(v, what) === 0) throw new SourceError("rpc", `${what}: must be at least 1`);
  return v;
};

export function parseParams(v) {
  if (!isObj(v)) throw new SourceError("rpc", "get_params: not an object");
  return { epochMs: int(v.epoch_ms, "epoch_ms"), startMs: int(v.start_ms, "start_ms"), maxRateBps: int(v.max_rate_bps, "max_rate_bps"), maxStepBps: int(v.max_step_bps, "max_step_bps"), impeachThresholdBps: int(v.impeach_threshold_bps, "impeach_threshold_bps"), quorumBps: v.quorum_bps === undefined ? null : int(v.quorum_bps, "quorum_bps"), meetingsPerDay: v.meetings_per_day === undefined ? null : positive(v.meetings_per_day, "meetings_per_day") };
}

/** `get_candidates`: who is up against the Chair and how many staked coins back each. Any other shape is an error, never a guess. */
export function parseCandidates(v) {
  if (!Array.isArray(v)) throw new SourceError("rpc", "get_candidates: not a list");
  return v.map((c) => {
    if (!isObj(c) || typeof c.candidate !== "string") throw new SourceError("rpc", "get_candidates: bad shape");
    try {
      return { candidate: c.candidate, backing: parseU128(c.backing, "backing") };
    } catch (e) {
      throw new SourceError("rpc", `get_candidates: ${e.message}`);
    }
  });
}

export function parsePolicy(v) {
  if (!isObj(v)) throw new SourceError("rpc", "get_policy: not an object");
  if (!Number.isSafeInteger(v.rate_bps) || typeof v.chair !== "string") throw new SourceError("rpc", "get_policy: bad shape");
  return { epoch: int(v.epoch, "epoch"), rateBps: v.rate_bps, chair: v.chair, streak: int(v.streak, "streak"), lastSetEpoch: v.last_set_epoch === null || v.last_set_epoch === undefined ? null : int(v.last_set_epoch, "last_set_epoch"), epochEndsMs: int(v.epoch_ends_ms, "epoch_ends_ms") };
}

/**
 * `onViews` is called with the chain's own numbers (`{ params, policy, supply, candidates }`) as soon as the four quick views have answered,
 * before the slow transaction index is read, so the page can show them at once. `candidates` is null when that view could not be read: the rest
 * does not depend on it.
 */
export async function loadLog(transport, { onViews } = {}) {
  const [rawParams, rawPolicy, rawSupply, candidates] = await Promise.all([transport.view("get_params"), transport.view("get_policy"), transport.view("get_supply"), transport.view("get_candidates").then(parseCandidates, () => null)]);
  const params = parseParams(rawParams);
  const policy = parsePolicy(rawPolicy);
  const supply = parseSupply(rawSupply);
  onViews?.({ params, policy, supply, candidates });
  const keys = await transport.accessKeys().then((n) => n, () => null);

  const base = { params, policy, supply, candidates, identity: identity(supply), accessKeys: keys, entries: [], decisions: [], remembered: [], refusals: [], anomalies: [], reconcile: null, pending: null, txCount: 0, reasons: [] };
  let txs;
  try {
    txs = await transport.transactions(await transport.txHashes());
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    const remembered = decisionsOfTxs(transport.remembered?.() ?? [], transport.token).decisions.slice(0, 1);
    return { ...base, remembered, status: "incomplete", reasons: [`The transaction index could not be read to its end (${e.source}: ${e.message}). Totals above come from the chain; no event total is claimed.`], retryable: e.retryable };
  }
  const { entries, anomalies } = buildEntries(txs, transport.token, params);
  const height = lastTokenHeight(txs, transport.token);
  const { decisions, unreadable } = decisionsOfTxs(txs, transport.token);
  if (unreadable > 0) anomalies.push(`${unreadable} policy_set event${unreadable === 1 ? "" : "s"} could not be read and ${unreadable === 1 ? "is" : "are"} not listed in the chair minutes`);
  const out = { ...base, entries, decisions, refusals: refusalsOfTxs(txs, transport.token, [policy.chair, ...decisions.map((d) => d.chair)]), anomalies, txCount: txs.length };

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
  const settle = (verdict) => {
    // What was kept from an earlier visit must never outlive a sign that it is wrong: a log that does not add up, or one whose newest decision is older than the chain's last (a decision it hides), is read afresh next time. (A newer one only means the views were read first.)
    if (verdict.status === "mismatch" || (decisions[0]?.epoch ?? -1) < (policy.lastSetEpoch ?? -1)) transport.distrust?.();
    return verdict;
  };
  if (out.reconcile.ok) return settle({ ...out, status: "complete" });
  if (!pinnedOk) return settle({ ...out, status: "unverified", reasons: ["The chain's state at the last logged block could not be read (a non-archival RPC node drops old blocks), so the event sums cannot be pinned to it. A difference may be a mint that is due and not yet applied."] });
  return settle({ ...out, status: "mismatch", reasons: ["The events found do not add up to the chain's ledger. The log below is not complete."] });
}
