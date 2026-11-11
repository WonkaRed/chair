// The chair's decisions as the chain records them: one `policy_set` event per `set_policy` call (SPEC "Events"):
// `{chair, epoch, rate_bps, previous_rate_bps, reasoning_hash}`. Same trust rules as every other event on the page
// (events.js): only the token's own logs from receipts that succeeded. An event of the wrong shape is counted, never guessed at.
import { eventsOfTx } from "./events.js";
import { isAccountId } from "./text.js";

export const HASH_RE = /^[0-9a-f]{64}$/;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function readDecision(ev) {
  const d = ev.data;
  if (!isObj(d) || !isAccountId(d.chair) || !Number.isSafeInteger(d.epoch) || d.epoch < 0) return null;
  if (!Number.isSafeInteger(d.rate_bps) || !Number.isSafeInteger(d.previous_rate_bps) || typeof d.reasoning_hash !== "string" || !HASH_RE.test(d.reasoning_hash)) return null;
  return { chair: d.chair, epoch: d.epoch, rateBps: d.rate_bps, previousRateBps: d.previous_rate_bps, hash: d.reasoning_hash, tx: ev.hash, tsMs: ev.tsMs, height: ev.height };
}

/** `{decisions, unreadable}`: every decision in these transactions, newest first, and how many `policy_set` events could not be read. */
export function decisionsOfTxs(txs, token) {
  const events = txs
    .flatMap((tx) => eventsOfTx(tx, token))
    .filter((ev) => ev.standard === "chair" && ev.event === "policy_set")
    .sort((a, b) => b.height - a.height || b.receiptIndex - a.receiptIndex || b.logIndex - a.logIndex);
  const decisions = [];
  let unreadable = 0;
  for (const ev of events) {
    const d = readDecision(ev);
    if (d === null) unreadable++;
    else decisions.push(d);
  }
  return { decisions, unreadable };
}
