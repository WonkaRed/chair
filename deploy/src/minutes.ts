// The chair's decisions as the chain records them, matched to their reasoning texts: the `reasoning` argument of the decision's own
// transaction, or for older decisions the text saved in docs/. This is the page's own code (web/site/js: which transactions touched the
// token, which `policy_set` events and arguments they hold, the SHA-256 comparison; web/scripts/minutes.mjs: which texts docs/ records),
// imported rather than rewritten, so `verify` and the page's "Chair minutes" cannot disagree about a match.

import { bundleMinutes } from "../../web/scripts/minutes.mjs";
import { config as webConfig } from "../../web/config.js";
import { decisionsOfTxs } from "../../web/site/js/decisions.js";
import { resolveTexts } from "../../web/site/js/minutes.js";
import { rpcTransport, SourceError } from "../../web/site/js/sources.js";

export type Verdict = "verified" | "mismatch" | "unchecked";

export interface Decision {
  readonly epoch: number;
  readonly rateBps: number;
  /** The `reasoning_hash` in the chain's `policy_set` event: 64 lowercase hex characters. */
  readonly hash: string;
  readonly tx: string;
  /** The text checked against `hash`, or null; `verdict` is null exactly when there is none. */
  readonly text: string | null;
  /** True when `text` was read from the transaction's arguments, false when it comes from docs/. */
  readonly onChain: boolean;
  readonly verdict: Verdict | null;
}

export interface Minutes {
  /** Every decision on chain, newest first. */
  readonly decisions: readonly Decision[];
  /** What the bundler could not use in docs/ (a text that does not hash to the hash its record claims, an unreadable file). */
  readonly warnings: readonly string[];
  /** Set when the transaction index could not be read; then `decisions` is empty and nothing was compared. */
  readonly error: string | null;
}

interface RawDecision {
  readonly epoch: number;
  readonly rateBps: number;
  readonly hash: string;
  readonly tx: string;
  readonly chainText: string | null;
}
interface Bundled {
  readonly text: string;
}
interface Resolved extends Bundled {
  readonly onChain: boolean;
  readonly verdict: Verdict;
}

/**
 * The hash of every transaction that touched the token, oldest first: this audit must read the whole history, so it asks for older pages until the
 * index says there are none, with no page cap. A token the index hands back twice would loop for ever, so that is a failure, not a silent end.
 */
async function everyHash(transport: ReturnType<typeof rpcTransport>): Promise<string[]> {
  const hashes = new Set<string>();
  const asked = new Set<string>();
  let resume: string | null = null;
  do {
    const page: { newest: string[]; next: string | null } = await transport.hashPage({ resume });
    for (const hash of page.newest) hashes.add(hash);
    resume = page.next;
    if (resume !== null && asked.has(resume)) throw new SourceError("indexer", "the index repeated a page token: history not read to the end");
    if (resume !== null) asked.add(resume);
  } while (resume !== null);
  return [...hashes].reverse();
}

/** `fetchImpl` is the network boundary (a stub in tests). `docsDir` holds the `testnet-run-agent-*` records. */
export async function gatherMinutes(rpcUrls: readonly string[], token: string, docsDir: string, fetchImpl: typeof fetch = fetch): Promise<Minutes> {
  const { bundle, warnings } = await bundleMinutes(docsDir);
  const texts = new Map<string, Bundled>(Object.entries(bundle.texts as Record<string, Bundled>));
  let raw: RawDecision[];
  try {
    const transport = rpcTransport({ rpcUrls, indexerUrl: webConfig.indexerUrl, account: token, fetchImpl, sleep: undefined }); // undefined: the transport's own pause between rounds
    raw = decisionsOfTxs(await transport.transactions(await everyHash(transport)), token).decisions;
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    return { decisions: [], warnings, error: `${e.source}: ${e.message}` };
  }
  const resolved: Map<string, Resolved> = await resolveTexts(raw, texts);
  const decisions = raw.map((d): Decision => {
    const r = resolved.get(d.tx);
    return { epoch: d.epoch, rateBps: d.rateBps, hash: d.hash, tx: d.tx, text: r?.text ?? null, onChain: r?.onChain ?? false, verdict: r?.verdict ?? null };
  });
  return { decisions, warnings, error: null };
}

const signed = (bps: number): string => `${bps > 0 ? "+" : ""}${bps} bps`;

const verdictLine = (verdict: Verdict, onChain: boolean): string => {
  const text = onChain ? "the text in the transaction's arguments" : "the text recorded in docs/";
  return {
    verified: `SHA-256 of ${text} equals the hash on chain`,
    mismatch: `MISMATCH: SHA-256 of ${text} is NOT the hash on chain`,
    unchecked: "not checked: no SHA-256 available",
  }[verdict];
};

function describeDecision(d: Decision): string[] {
  const head = `  epoch ${d.epoch}, rate ${signed(d.rateBps)}, reasoning_hash ${d.hash}`;
  // Not a failure: a decision made before the chair sent its text, and never saved in docs/, has nothing to compare.
  if (d.text === null || d.verdict === null) return [head, "      no text in the transaction or in docs/ for this hash, so nothing to compare (not an error)"];
  const oneLine = d.text.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "?");
  return [head, `      "${oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine}"`, `      ${verdictLine(d.verdict, d.onChain)}`];
}

/** Epochs in ascending order, a run of three or more as `a to b`: `1 to 4, 7, 8, 31`. */
export function listEpochs(epochs: readonly number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < epochs.length; ) {
    let end = i;
    while (epochs[end + 1] === (epochs[end] as number) + 1) end++;
    const run = epochs.slice(i, end + 1);
    parts.push(...(run.length >= 3 ? [`${run[0]} to ${run.at(-1)}`] : run.map(String)));
    i = end + 1;
  }
  return parts.join(", ");
}

/**
 * The `limit` newest decisions, then up to `recordedLimit` of the newest ones with a checkable text that are not already listed, then
 * the epochs of every decision with none: a decision made before the chair sent its text and never saved in docs/ cannot be compared.
 */
export function describeMinutes(m: Minutes, limit = 5, recordedLimit = 3): string[] {
  if (m.error !== null) return [`NOTE: the decisions on chain could not be read (${m.error}), so the reasoning-hash check was skipped and is not counted; the other checks read the RPC only.`];
  const shown = m.decisions.slice(0, limit);
  const lines = [`latest decisions on chain (${shown.length} of ${m.decisions.length}, newest first):`, ...shown.flatMap(describeDecision)];
  const recorded = m.decisions.filter((d) => d.text !== null && !shown.includes(d)).slice(0, recordedLimit);
  if (recorded.length > 0) lines.push("", `latest decisions with a checkable text (${recorded.length} more):`, ...recorded.flatMap(describeDecision));
  const bare = m.decisions.filter((d) => d.text === null).map((d) => d.epoch).sort((a, b) => a - b);
  lines.push("", `decisions with no checkable text (${bare.length} of ${m.decisions.length}), by epoch: ${bare.length === 0 ? "none" : listEpochs(bare)}`);
  return lines;
}
