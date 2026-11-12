// Reads the chain's views and the token's transactions, builds the mint/burn log and reconciles it with `get_supply`.
// The result says what is known and what is not; it never fills a gap with a guess.
//
// The log is the newest page of transactions (`partial` when older ones exist; `loadEarlier` reads the page before). Every figure is about the
// transactions read, and a partial log is reconciled over the blocks it covers, as a change in `get_supply`, never as the whole ledger.
//   status "complete"    the log's sums equal the chain's ledger at the last block in which the token logged an event (partial: the change over the blocks read)
//   status "mismatch"    the indexer answered, and its events do not add up to the chain's ledger
//   status "incomplete"  the indexer could not be read (down, rate limited): no sum is claimed. `remembered` then holds the
//                        newest decision an earlier visit kept (at most one), so the page has something true to show; `decisions` stays empty
//   status "unverified"  the log was read but could not be checked against the chain's ledger (the state at the blocks it covers could not be read, the transactions are still running, or they cover too few blocks); `reasons` says which
// `outOfReach` is not a status: the index was read, and no decision is in the transactions read (the newest is older). `unreadTestCalls` lists the known test
// refusals (refusals.js) that a windowed read could not get, which the page says instead of claiming them.
// RPC views failing is a different failure: nothing can be shown, `loadLog` throws.
import { parseU128 } from "./amounts.js";
import { decisionsOfTxs, refusalsOfTxs } from "./decisions.js";
import { buildEntries, identity, reconcile, reconcileWindow } from "./ledger.js";
import { eventBlocks, settledThrough, tokenSpan } from "./events.js";
import { PROJECT_TEST_CALLS } from "./refusals.js";
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
 *
 * `onLatest` is called at most once, with `{ decision, policy, params }`, when the newest transactions have been read ahead of the rest and hold a decision at least
 * as new as the one the chain's `get_policy` says was the last: the Chair's latest minutes, long before the whole list is in. It is never called after
 * `loadLog` has returned, and never when the newest transactions hold no such decision (the full read then supplies it).
 */
export async function loadLog(transport, { onViews, onLatest } = {}) {
  let over = false;
  try {
    return await read(transport, { onViews, onLatest: (latest) => (over ? undefined : onLatest?.(latest)) });
  } finally {
    over = true;
  }
}

/** Events within this many blocks of the oldest one read are left out of a windowed check: a transaction just older than the window may still have a receipt running there. */
const SETTLE_BLOCKS = 20;
/** A window with no decision in it is widened this many pages before the page gives up saying what the Chair last decided. */
const WIDEN_PAGES = 3;

async function read(transport, { onViews, onLatest }) {
  // The index is asked at once, beside the chain's views: they are different hosts, and the newest page of hashes is what the rest waits for. The
  // newest transactions on it are read ahead of the rest, for the hero.
  const first = transport.hashPage();
  first.catch(() => {}); // a failure is read where the page is awaited, below; this only keeps it from going unhandled if the views fail first
  const newest = first.then((page) => transport.peek?.(page.newest)).then((txs) => (txs ? decisionsOfTxs(txs, transport.token).decisions[0] ?? null : null)).catch(() => null); // the read-ahead only ever helps: any failure in it is no decision
  const [rawParams, rawPolicy, rawSupply, candidates] = await Promise.all([transport.view("get_params"), transport.view("get_policy"), transport.view("get_supply"), transport.view("get_candidates").then(parseCandidates, () => null)]);
  const params = parseParams(rawParams);
  const policy = parsePolicy(rawPolicy);
  const supply = parseSupply(rawSupply);
  onViews?.({ params, policy, supply, candidates });
  const keys = transport.accessKeys().then((n) => n, () => null);
  void newest.then((decision) => {
    if (decision !== null && decision.epoch >= (policy.lastSetEpoch ?? -1)) return onLatest?.({ decision, policy, params });
  }).catch(() => {}); // the caller's drawing (it may be async) failing must not become an unhandled rejection: the full read draws the same card

  const base = { params, policy, supply, candidates, identity: identity(supply), accessKeys: await keys, entries: [], decisions: [], remembered: [], refusals: [], anomalies: [], reconcile: null, pending: null, txCount: 0, reasons: [], window: { hashes: [], next: null, pinned: [] } };
  let out;
  try {
    const page = await first;
    const hashes = [...page.newest].reverse();
    // The project's own recorded test refusals are always read, whatever the window: they are known by hash, and are the oldest ones there are.
    const pinned = page.next === null ? Promise.resolve([]) : (transport.lookup?.([...PROJECT_TEST_CALLS]) ?? Promise.resolve([]));
    const txs = await transport.transactions(hashes);
    out = await assemble(transport, base, txs, { hashes, next: page.next, pinned: await pinned }, null);
    for (let widened = 0; out.decisions.length === 0 && out.window.next !== null && widened < WIDEN_PAGES; widened++) out = await older(transport, out);
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    const remembered = decisionsOfTxs(transport.remembered?.() ?? [], transport.token).decisions.slice(0, 1);
    return { ...base, remembered, status: "incomplete", reasons: [`The transaction index could not be read to its end (${e.source}: ${e.message}). Totals above come from the chain; no event total is claimed.`], retryable: e.retryable };
  }
  return out;
}

/**
 * The page's data with one more page of older transactions read in: the same call `loadLog` makes, over the transactions read so far plus the page
 * before them. Throws a `SourceError` when the index cannot be read; the data it was given stays as it was.
 */
export async function loadEarlier(transport, data) {
  if (data.window.next === null) return data;
  return older(transport, data);
}

async function older(transport, data) {
  const page = await transport.hashPage({ resume: data.window.next });
  const known = new Set(data.window.hashes);
  const hashes = [...page.newest.filter((h) => !known.has(h)).reverse(), ...data.window.hashes];
  const txs = await transport.transactions(hashes);
  const base = { ...data, status: undefined, retryable: undefined, reasons: [], reconcile: null, pending: null };
  // The known test refusals that could not be read before are asked for again, unless this page has them.
  const again = page.next === null ? [] : data.unreadTestCalls.filter((h) => !page.newest.includes(h));
  const pinned = again.length > 0 ? [...data.window.pinned, ...((await transport.lookup?.(again)) ?? [])] : data.window.pinned;
  return assemble(transport, base, txs, { hashes, next: page.next, pinned }, data.pin);
}

/**
 * Everything the page shows from the transactions read so far. `window` is `{ hashes (oldest first), next, pinned }`: `next` null means the whole
 * history is in `txs`, anything else means older transactions exist and every figure here is about the ones read. `pin` is the chain's ledger at the
 * newest logged block (`{supply, ok, height}`) when an earlier call already read it: it is reused only for that same block.
 */
async function assemble(transport, base, txs, window, pin) {
  const { params, policy, supply } = base;
  const partial = window.next !== null;
  const { entries, anomalies } = buildEntries(txs, transport.token, params);
  const span = tokenSpan(txs, transport.token);
  const { decisions, unreadable } = decisionsOfTxs(txs, transport.token);
  if (unreadable > 0) anomalies.push(`${unreadable} policy_set event${unreadable === 1 ? "" : "s"} could not be read and ${unreadable === 1 ? "is" : "are"} not listed in the chair minutes`);
  const read = new Set(window.hashes);
  const listed = [...window.pinned.filter((tx) => !read.has(tx.transaction.hash)), ...txs];
  const out = { ...base, entries, decisions, refusals: refusalsOfTxs(listed, transport.token, [policy.chair, ...decisions.map((d) => d.chair)]), anomalies, txCount: txs.length, window, partial, sinceMs: span.firstMs, unreadTestCalls: partial ? [...PROJECT_TEST_CALLS].filter((h) => !read.has(h) && !window.pinned.some((tx) => tx.transaction.hash === h)) : [], outOfReach: partial && decisions.length === 0 && (policy.lastSetEpoch ?? -1) > -1 };

  // Pin the chain's ledger to the block of the last logged event, so a mint that is due but not yet applied (views project it, no event exists until a
  // transaction that rolls the epochs runs) is not mistaken for a missing event. Only a block in which the token logged an event is such a block: a
  // receipt that logged nothing (a storage deposit) may not have rolled anything. A block that a receipt still to run could add events to is not one.
  const blocks = eventBlocks(txs, transport.token);
  const settled = blocks.filter((b) => b <= settledThrough(txs));
  const height = settled.at(-1) ?? null;
  const unsettled = height === null && blocks.length > 0; // events are read but none is yet known whole
  let pinned = supply;
  let pinnedOk = height === null && !unsettled;
  if (height !== null && pin?.ok && pin.height === height) {
    pinned = pin.supply;
    pinnedOk = true;
  } else if (height !== null) {
    try {
      pinned = parseSupply(await transport.view("get_supply", { blockHeight: height }));
      pinnedOk = true;
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
    }
  }
  out.pinnedHeight = height;
  out.pinnedSupply = pinned;
  out.pin = { supply: pinned, ok: pinnedOk, height };
  out.pending = pinnedOk && pinned.minted !== supply.minted ? { minted: supply.minted - pinned.minted } : null;
  const upTo = entries.filter((e) => e.height <= (height ?? Infinity));
  // A log of the newest transactions only is checked against the change in the chain's ledger over the blocks it covers, not against the totals: from
  // the first event block at least SETTLE_BLOCKS after the oldest block read (a transaction just older than the window may still have a receipt running
  // before it) up to the pinned block, both blocks in which the contract rolled, so neither ledger reading holds a mint the log has not yet written.
  let from = null;
  let tooFew = false;
  if (!partial) out.reconcile = reconcile(upTo, pinned);
  else if (pinnedOk && height !== null && span.first !== null) {
    from = settled.find((b) => b >= span.first + SETTLE_BLOCKS && b < height) ?? null;
    tooFew = from === null;
    if (from !== null) {
      try {
        out.reconcile = reconcileWindow(upTo.filter((e) => e.height > from), parseSupply(await transport.view("get_supply", { blockHeight: from })), pinned);
      } catch (e) {
        if (!(e instanceof SourceError)) throw e;
      }
    }
  }
  out.pinnedFrom = from;
  // A window with no decision in it has not hidden one: it has not reached it (`outOfReach`). Only a decision older than the chain's last that the log does show is a sign of a gap.
  const hidden = decisions.length > 0 ? decisions[0].epoch < (policy.lastSetEpoch ?? -1) : !partial && (policy.lastSetEpoch ?? -1) > -1;
  const settle = (verdict) => {
    // What was kept from an earlier visit must never outlive a sign that it is wrong: a log that does not add up, or one whose newest decision is older than the chain's last (a decision it hides), is read afresh next time. (A newer one only means the views were read first.)
    if (verdict.status === "mismatch" || hidden) transport.distrust?.();
    return verdict;
  };
  if (out.reconcile?.ok) return settle({ ...out, status: "complete" });
  if (partial && blocks.length === 0) return settle({ ...out, status: "unverified", reasons: ["No mint, burn or decision was logged in the transactions read, so there is nothing in them to check against the chain's ledger."] });
  if (unsettled) return settle({ ...out, status: "unverified", reasons: ["The newest transactions are still being processed, so the event sums cannot be pinned to the chain's state yet. Load the page again in a minute."] });
  if (tooFew) return settle({ ...out, status: "unverified", reasons: ["The transactions read cover too few blocks to check against the chain's ledger: every mint or burn in them is within a few blocks of the oldest one read. Earlier transactions are read when you ask."] });
  if (!pinnedOk || out.reconcile === null) return settle({ ...out, status: "unverified", reasons: ["The chain's state at the blocks the log covers could not be read (a non-archival RPC node drops old blocks), so the event sums cannot be pinned to it. A difference may be a mint that is due and not yet applied."] });
  return settle({ ...out, status: "mismatch", reasons: ["The events found do not add up to the chain's ledger. The log below is not complete."] });
}
