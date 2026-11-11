// The chair's decisions as the chain records them: one `policy_set` event per `set_policy` call (SPEC "Events"):
// `{chair, epoch, rate_bps, previous_rate_bps, reasoning_hash}`. Same trust rules as every other event on the page
// (events.js): only the token's own logs from receipts that succeeded. An event of the wrong shape is counted, never guessed at.
// The transaction itself may carry the reasoning text as an extra `reasoning` argument (SPEC "set_policy"); it is untrusted
// until its SHA-256 equals the event's hash (minutes.js). The calls the contract refused are listed too, with its panic text.
import { eventsOfTx, nsToMs } from "./events.js";
import { isAccountId, isTxHash } from "./text.js";

export const HASH_RE = /^[0-9a-f]{64}$/;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

const PANIC = "Smart contract panicked: ";
const MAX_ARGS_CHARS = 20_000;

/** The transaction's first function call if it is `set_policy`, else null. */
function setPolicyCall(tx) {
  const call = Array.isArray(tx?.transaction?.actions) ? tx.transaction.actions.map((a) => a?.FunctionCall).find(isObj) : undefined;
  return call?.method_name === "set_policy" ? call : null;
}

/** The JSON object in the call's arguments (base64, as RPC and the index return them), or null. */
function argsOf(call) {
  if (typeof call?.args !== "string" || call.args.length > MAX_ARGS_CHARS) return null;
  try {
    const args = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(call.args), (c) => c.charCodeAt(0))));
    return isObj(args) ? args : null;
  } catch {
    return null;
  }
}

function readDecision(ev, chainText) {
  const d = ev.data;
  if (!isObj(d) || !isAccountId(d.chair) || !Number.isSafeInteger(d.epoch) || d.epoch < 0) return null;
  if (!Number.isSafeInteger(d.rate_bps) || !Number.isSafeInteger(d.previous_rate_bps) || typeof d.reasoning_hash !== "string" || !HASH_RE.test(d.reasoning_hash)) return null;
  return { chair: d.chair, epoch: d.epoch, rateBps: d.rate_bps, previousRateBps: d.previous_rate_bps, hash: d.reasoning_hash, chainText, tx: ev.hash, tsMs: ev.tsMs, height: ev.height };
}

/**
 * `{decisions, unreadable}`: every decision in these transactions, newest first, and how many `policy_set` events could not be read.
 * `chainText` is the transaction's `reasoning` argument or null: a claim, not yet checked against `hash`.
 */
export function decisionsOfTxs(txs, token) {
  const events = txs
    .flatMap((tx) => eventsOfTx(tx, token))
    .filter((ev) => ev.standard === "chair" && ev.event === "policy_set")
    .sort((a, b) => b.height - a.height || b.receiptIndex - a.receiptIndex || b.logIndex - a.logIndex);
  const texts = new Map(txs.map((tx) => [tx?.transaction?.hash, argsOf(setPolicyCall(tx))?.reasoning]));
  const decisions = [];
  let unreadable = 0;
  for (const ev of events) {
    const text = texts.get(ev.hash);
    const d = readDecision(ev, typeof text === "string" && text !== "" ? text : null);
    if (d === null) unreadable++;
    else decisions.push(d);
  }
  return { decisions, unreadable };
}

/**
 * Every `set_policy` call the token refused, newest first: `{tx, signer, rateBps, tsMs, height, reason}`. `reason` is the contract's
 * panic text (any other failure text is kept as it is). Only the token's own failed receipts count.
 */
export function refusalsOfTxs(txs, token) {
  const refusals = [];
  for (const tx of txs) {
    const call = setPolicyCall(tx);
    if (call === null || !isTxHash(tx.transaction.hash) || tx.transaction.receiver_id !== token || !Array.isArray(tx.receipts)) continue;
    const args = argsOf(call) ?? {};
    for (const r of tx.receipts) {
      const eo = r?.execution_outcome;
      const failure = eo?.outcome?.executor_id === token ? eo.outcome.status?.Failure : undefined;
      const height = Number(eo?.block_height);
      const tsMs = nsToMs(eo?.block_timestamp);
      if (!isObj(failure) || !Number.isSafeInteger(height) || tsMs === null) continue;
      const cause = failure.ActionError?.kind?.FunctionCallError;
      const message = isObj(cause) ? cause.ExecutionError : undefined;
      const reason = typeof message === "string" ? (message.startsWith(PANIC) ? message.slice(PANIC.length) : message) : "failed without a contract message";
      refusals.push({ tx: tx.transaction.hash, signer: isAccountId(tx.transaction.signer_id) ? tx.transaction.signer_id : null, rateBps: Number.isSafeInteger(args.rate_bps) ? args.rate_bps : null, tsMs, height, reason });
      break;
    }
  }
  return refusals.sort((a, b) => b.height - a.height);
}
