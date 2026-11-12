// The mint/burn log and its reconciliation against `get_supply` (SPEC "Events": the public log of every mint and burn).
//
//   supply change              NEP-141 event (cause in memo)                chair event (epoch and detail)
//   launch                     ft_mint  memo "launch"                       none
//   easing mint                ft_mint  memo "chair:easing"                 epoch_minted
//   transfer burn              ft_burn  memo "chair:tightening"             transfer_burned
//   forced storage_unregister  ft_burn  memo "storage_unregister"           none
//   ft_transfer_call refund    ft_burn  memo "refund"                       none
//
// The NEP-141 events are the ledger (they cover every cause); chair events add the epoch. An entry without a chair
// event gets its epoch from block time and says so.
import { chairData, eventsOfTx, nep141Items } from "./events.js";

export function epochAt(tsMs, params) {
  const t = BigInt(tsMs);
  const start = BigInt(params.startMs);
  return t <= start ? 0 : Number((t - start) / BigInt(params.epochMs));
}

/** Entries oldest first: `{kind: "launch"|"mint"|"burn", amount, reason, memo, epoch, epochFrom, ...}`. */
export function buildEntries(txs, token, params) {
  const events = txs.flatMap((tx) => eventsOfTx(tx, token)).sort((a, b) => a.height - b.height || a.receiptIndex - b.receiptIndex || a.logIndex - b.logIndex);
  const entries = [];
  const anomalies = [];
  // Chair events waiting for the NEP-141 event of the same change (same transaction, same amount, in order).
  const pendingMinted = new Map();
  const pendingBurned = new Map();
  for (const ev of events) {
    const m = chairData(ev, "epoch_minted", ["amount", "total_staked"]);
    if (m !== null) (pendingMinted.get(ev.hash) ?? pendingMinted.set(ev.hash, []).get(ev.hash)).push({ ev, m, used: false });
    const b = chairData(ev, "transfer_burned", ["amount", "burned"]);
    if (b !== null) (pendingBurned.get(ev.hash) ?? pendingBurned.set(ev.hash, []).get(ev.hash)).push({ ev, b, used: false });
  }
  for (const ev of events) {
    for (const item of nep141Items(ev)) {
      const base = { hash: ev.hash, signer: ev.signer, method: ev.method, tsMs: ev.tsMs, height: ev.height, amount: item.amount, memo: item.memo, account: item.owner };
      if (ev.event === "ft_mint") {
        if (item.memo === "launch") {
          entries.push({ ...base, kind: "launch", epoch: 0, epochFrom: "launch", reason: "Launch mint to the owner account" });
          continue;
        }
        const pair = (pendingMinted.get(ev.hash) ?? []).find((p) => !p.used && p.m.amount === item.amount);
        if (item.memo === "chair:easing" && pair) {
          pair.used = true;
          entries.push({ ...base, kind: "mint", epoch: pair.m.epoch, epochFrom: "event", rateBps: pair.m.rate_bps, totalStaked: pair.m.total_staked, reason: "Easing mint into the staking reward pool" });
        } else {
          anomalies.push(`mint of ${item.amount} with memo ${JSON.stringify(item.memo)} has no matching epoch_minted event`);
          entries.push({ ...base, kind: "mint", epoch: epochAt(ev.tsMs, params), epochFrom: "block time", unpaired: true, reason: "Mint without a matching chair event" });
        }
      } else {
        const pair = item.memo === "chair:tightening" ? (pendingBurned.get(ev.hash) ?? []).find((p) => !p.used && p.b.burned === item.amount && p.b.account_id === item.owner) : undefined;
        if (pair) {
          pair.used = true;
          entries.push({ ...base, kind: "burn", epoch: pair.b.epoch, epochFrom: "event", rateBps: pair.b.rate_bps, spent: pair.b.amount, reason: "Transfer burn while the rate is negative" });
        } else {
          const why = { "chair:tightening": "Transfer burn without a matching chair event", storage_unregister: "Balance destroyed by a forced storage_unregister", refund: "ft_transfer_call refund after the sender unregistered mid-call" }[item.memo] ?? "Burn with an unrecognised reason";
          if (!(item.memo === "storage_unregister" || item.memo === "refund")) anomalies.push(`burn of ${item.amount} with memo ${JSON.stringify(item.memo)} has no matching transfer_burned event`);
          entries.push({ ...base, kind: "burn", epoch: epochAt(ev.tsMs, params), epochFrom: "block time", unpaired: !(item.memo === "storage_unregister" || item.memo === "refund"), reason: why });
        }
      }
    }
  }
  for (const list of [...pendingMinted.values(), ...pendingBurned.values()]) {
    for (const p of list) if (!p.used) anomalies.push(`${p.ev.event} event in ${p.ev.hash} has no matching NEP-141 event`);
  }
  return { entries, anomalies };
}

/** The ledger identity from `get_supply`: `total_supply == launch_supply + minted - burned`. */
export function identity(s) {
  const expected = s.launchSupply + s.minted - s.burned;
  return { holds: expected === s.totalSupply, expected, actual: s.totalSupply };
}

const sum = (entries, pick) => entries.filter(pick).reduce((a, e) => a + e.amount, 0n);

/**
 * Event sums against the chain's ledger at the same block. Three lines, each exact: launch, minted, burned.
 * `ok` is true only when all three are equal. A mint with an unrecognised memo counts as minted, so it shows up as a difference.
 */
export function reconcile(entries, supply) {
  const lines = [
    { name: "launch supply", logged: sum(entries, (e) => e.kind === "launch"), chain: supply.launchSupply },
    { name: "minted", logged: sum(entries, (e) => e.kind === "mint"), chain: supply.minted },
    { name: "burned", logged: sum(entries, (e) => e.kind === "burn"), chain: supply.burned },
  ].map((l) => ({ ...l, ok: l.logged === l.chain }));
  return { lines, ok: lines.every((l) => l.ok) };
}

/**
 * Event sums against the change in the chain's ledger over a stretch of blocks, for a log that holds only the newest transactions: `from` and `to` are
 * `get_supply` at the first and the last block of the stretch, and `entries` are the logged events after `from`. A launch is never in the middle
 * of a stretch, so there are two lines, each exact. `ok` is true only when both are equal.
 */
export function reconcileWindow(entries, from, to) {
  const lines = [
    { name: "minted", logged: sum(entries, (e) => e.kind === "mint"), chain: to.minted - from.minted },
    { name: "burned", logged: sum(entries, (e) => e.kind === "burn"), chain: to.burned - from.burned },
  ].map((l) => ({ ...l, ok: l.logged === l.chain }));
  return { lines, ok: lines.every((l) => l.ok) };
}
