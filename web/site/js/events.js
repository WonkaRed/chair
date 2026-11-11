// Reads NEP-297 events out of transactions in the shape FastNEAR's `/v0/transactions` returns, which is the shape of
// NEAR RPC `EXPERIMENTAL_tx_status`: `receipts[].execution_outcome.{block_height, block_timestamp, outcome.{executor_id, status, logs}}`.
//
// Trust rules (SPEC "Events"): only logs written by the token account itself count, only from receipts that succeeded,
// and a line must be `EVENT_JSON:` followed by valid JSON of a known shape. Anything else is ignored, never guessed at.
import { parseU128 } from "./amounts.js";
import { isAccountId, isTxHash } from "./text.js";

const PREFIX = "EVENT_JSON:";
const MAX_LOGS_PER_RECEIPT = 200;
const MAX_LOG_CHARS = 20_000;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const succeeded = (status) => isObj(status) && ("SuccessValue" in status || "SuccessReceiptId" in status);

function parseLog(line) {
  if (typeof line !== "string" || !line.startsWith(PREFIX) || line.length > MAX_LOG_CHARS) return null;
  let ev;
  try {
    ev = JSON.parse(line.slice(PREFIX.length));
  } catch {
    return null;
  }
  if (!isObj(ev) || typeof ev.standard !== "string" || typeof ev.event !== "string" || !("data" in ev)) return null;
  return { standard: ev.standard, version: ev.version, event: ev.event, data: ev.data };
}

/**
 * Milliseconds of a nanosecond timestamp, or null. A digit string (NEAR RPC) is exact; a JSON number (FastNEAR sends one) has
 * already lost its last digits to a double, which is far below a millisecond.
 */
export function nsToMs(v) {
  if (typeof v === "string") return /^\d{1,20}$/.test(v) ? BigInt(v) / 1_000_000n : null;
  return Number.isFinite(v) && v >= 0 ? BigInt(Math.trunc(v)) / 1_000_000n : null;
}

/**
 * Every event the token wrote in one transaction, in log order, each with where it came from.
 * `method` is the first function-call method of the transaction (what the signer asked for).
 */
export function eventsOfTx(tx, token) {
  const out = [];
  if (!isObj(tx) || !isObj(tx.transaction) || !isTxHash(tx.transaction.hash) || !Array.isArray(tx.receipts)) return out;
  const hash = tx.transaction.hash;
  const call = Array.isArray(tx.transaction.actions) ? tx.transaction.actions.map((a) => a?.FunctionCall).find(isObj) : undefined;
  const method = typeof call?.method_name === "string" ? call.method_name : "";
  const signer = tx.transaction.signer_id;
  tx.receipts.forEach((r, receiptIndex) => {
    const eo = r?.execution_outcome;
    const outcome = eo?.outcome;
    if (!isObj(eo) || !isObj(outcome) || outcome.executor_id !== token || !succeeded(outcome.status)) return;
    const tsMs = nsToMs(eo.block_timestamp);
    const height = Number(eo.block_height);
    if (tsMs === null || !Number.isSafeInteger(height) || !Array.isArray(outcome.logs)) return;
    outcome.logs.slice(0, MAX_LOGS_PER_RECEIPT).forEach((line, logIndex) => {
      const ev = parseLog(line);
      if (ev !== null) out.push({ ...ev, hash, method, signer: isAccountId(signer) ? signer : null, tsMs, height, receiptIndex, logIndex });
    });
  });
  return out;
}

/** The highest block in which the token executed anything in these transactions, or null. */
export function lastTokenHeight(txs, token) {
  let max = null;
  for (const tx of txs) {
    if (!isObj(tx) || !Array.isArray(tx.receipts)) continue;
    for (const r of tx.receipts) {
      const h = Number(r?.execution_outcome?.block_height);
      if (r?.execution_outcome?.outcome?.executor_id === token && Number.isSafeInteger(h) && (max === null || h > max)) max = h;
    }
  }
  return max;
}

/** `ft_mint` / `ft_burn` items of a NEP-141 event: `{owner_id, amount, memo}` with a valid amount, else null per item. */
export function nep141Items(ev) {
  if (ev.standard !== "nep141" || (ev.event !== "ft_mint" && ev.event !== "ft_burn") || !Array.isArray(ev.data)) return [];
  return ev.data.flatMap((d) => {
    if (!isObj(d)) return [];
    try {
      return [{ owner: d.owner_id, amount: parseU128(d.amount), memo: typeof d.memo === "string" ? d.memo : null }];
    } catch {
      return [];
    }
  });
}

/** A `chair` event's data as an object, with the named amount fields validated, or null. */
export function chairData(ev, name, amountFields) {
  if (ev.standard !== "chair" || ev.event !== name || !isObj(ev.data)) return null;
  const d = { ...ev.data };
  try {
    for (const f of amountFields) d[f] = parseU128(d[f], f);
  } catch {
    return null;
  }
  return Number.isSafeInteger(d.epoch) && d.epoch >= 0 ? d : null;
}
