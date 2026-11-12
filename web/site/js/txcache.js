// What the page keeps of the token's transactions between visits. A transaction cannot change once every receipt it spawned has run, so a reload
// only has to ask the index for hashes it has not seen: that keeps a page full of reloads under the index's per-address rate
// limit (its 429 carries no CORS header, so the browser reports it as a network error), and gives the hero something true to
// show when the index cannot be read at all. Storage is a convenience, never a dependency: every access is guarded, a missing,
// full, corrupt or oversized store is the same as an empty one, and the page behaves identically either way.

/** The whole entry may not exceed this many characters; past it the oldest transactions are left out. The origin's quota is shared with every page on it. */
export const MAX_CHARS = 1_500_000;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The part of a transaction every reader on this page uses, in the same positions, and nothing else (a full result is ~4 KB, this is a
 * fraction). Receipts the token did not execute become `null` so the positions of the others are unchanged: events are ordered by them.
 * Everything the page reads goes through this one shape whether it came from the index or from storage, so a cold and a warm load
 * cannot differ. A transaction with a receipt still to run carries `settledThrough` (see below). Null when `tx` is not a transaction at all.
 */
export function slim(tx, token) {
  const t = tx?.transaction;
  if (!isObj(t) || typeof t.hash !== "string") return null;
  const settled = settledThrough(tx);
  const calls = Array.isArray(t.actions) ? t.actions.filter((a) => isObj(a?.FunctionCall)) : [];
  return {
    transaction: { hash: t.hash, signer_id: t.signer_id, receiver_id: t.receiver_id, actions: calls.map(({ FunctionCall: c }) => ({ FunctionCall: { method_name: c.method_name, args: c.args } })) },
    ...(settled === Infinity ? {} : { settledThrough: settled }), // never kept: only a complete transaction is
    receipts: (Array.isArray(tx.receipts) ? tx.receipts : []).map((r) => {
      const eo = r?.execution_outcome;
      const o = eo?.outcome;
      return o?.executor_id === token ? { execution_outcome: { block_height: eo.block_height, block_timestamp: eo.block_timestamp, outcome: { executor_id: o.executor_id, status: o.status, logs: o.logs } } } : null;
    }),
  };
}

/**
 * Whether the index's result for `tx` (as it came, not slimmed) is final: every receipt that the transaction's own outcome and each receipt's
 * outcome says it spawned (refunds included) has its outcome in the result. A result with one still to run, or one the index left out, is not
 * kept, so an incomplete transaction cannot be remembered as whole. The rule reads the result's own bookkeeping, not anyone's clock.
 */
export function complete(tx) {
  if (!isObj(tx?.execution_outcome) || !Array.isArray(tx.receipts)) return false;
  const outcomes = [tx.execution_outcome, ...tx.receipts.map((r) => r?.execution_outcome)];
  const ran = new Set(outcomes.map((eo) => eo?.id));
  return outcomes.every((eo) => Array.isArray(eo?.outcome?.receipt_ids) && eo.outcome.receipt_ids.every((id) => ran.has(id)));
}

/**
 * The highest block up to which an incomplete transaction is known whole: a receipt that has not run yet runs after the one that spawned it, so
 * everything at or before the block of a receipt that spawned one still to run is settled, and nothing after it is promised. Infinity for a
 * complete transaction; -1 when the block is not given (nothing is promised).
 */
export function settledThrough(tx) {
  if (!isObj(tx?.execution_outcome) || !Array.isArray(tx.receipts)) return -1;
  const outcomes = [tx.execution_outcome, ...tx.receipts.map((r) => r?.execution_outcome)];
  const ran = new Set(outcomes.map((eo) => eo?.id));
  let bound = Infinity;
  for (const eo of outcomes) {
    const spawned = eo?.outcome?.receipt_ids;
    if (Array.isArray(spawned) && spawned.every((id) => ran.has(id))) continue;
    const h = Number(eo?.block_height);
    bound = Math.min(bound, Number.isSafeInteger(h) ? h : -1);
  }
  return bound;
}

/** `store` is a `Storage` or null; `key` names this token's entry (versioned by the caller, so a changed shape reads as empty). */
export function txCache({ store, key }) {
  /** `Map<hash, slim transaction>` of what an earlier visit kept; empty on any doubt. A single entry that is not what its key says is dropped alone. */
  const read = () => {
    const out = new Map();
    try {
      const raw = store?.getItem(key);
      if (typeof raw !== "string" || raw.length > MAX_CHARS) return out;
      const kept = JSON.parse(raw);
      if (!isObj(kept)) return out;
      for (const [hash, tx] of Object.entries(kept)) if (isObj(tx) && tx.transaction?.hash === hash && Array.isArray(tx.receipts)) out.set(hash, tx);
    } catch {
      // Blocked storage or text that is not JSON: nothing remembered.
    }
    return out;
  };

  /** Keeps `byHash` for the hashes in `hashes` (oldest first), newest first until the size cap is reached, replacing what was stored. */
  const write = (hashes, byHash) => {
    const kept = [];
    let size = 2; // the braces
    for (let i = hashes.length - 1; i >= 0; i--) {
      const tx = byHash.get(hashes[i]);
      if (tx === undefined) continue;
      const cost = JSON.stringify(tx).length + hashes[i].length + 4; // the quotes, the colon and the comma
      if (size + cost > MAX_CHARS) break;
      size += cost;
      kept.push([hashes[i], tx]);
    }
    try {
      store?.setItem(key, JSON.stringify(Object.fromEntries(kept.reverse())));
    } catch {
      // Full or blocked: the next visit asks the index again.
    }
  };

  /** Forgets everything kept, so the next read asks the index for all of it. */
  const clear = () => {
    try {
      store?.removeItem(key);
    } catch {
      // Blocked storage keeps nothing worth forgetting.
    }
  };

  return { read, write, clear };
}

/** `localStorage`, or null where the browser refuses even to name it (it throws in some privacy modes). */
export function browserStore() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
