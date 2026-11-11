// The chair's decisions as the chain records them, matched to the reasoning texts saved in docs/. This is the page's own code
// (web/site/js: which transactions touched the token, which `policy_set` events they hold, the SHA-256 comparison; web/scripts/minutes.mjs:
// which texts docs/ records), imported rather than rewritten, so `verify` and the page's "Chair minutes" cannot disagree about a match.

import { bundleMinutes } from "../../web/scripts/minutes.mjs";
import { config as webConfig } from "../../web/config.js";
import { decisionsOfTxs } from "../../web/site/js/decisions.js";
import { checkDecisions } from "../../web/site/js/minutes.js";
import { rpcTransport, SourceError } from "../../web/site/js/sources.js";

export type Verdict = "verified" | "mismatch" | "unchecked";

export interface Decision {
  readonly epoch: number;
  readonly rateBps: number;
  /** The `reasoning_hash` in the chain's `policy_set` event: 64 lowercase hex characters. */
  readonly hash: string;
  readonly tx: string;
  /** The reasoning text docs/ records for this hash, or null; `verdict` is null exactly when there is none. */
  readonly text: string | null;
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
}
interface Bundled {
  readonly text: string;
}

/** `fetchImpl` is the network boundary (a stub in tests). `docsDir` holds the `testnet-run-agent-*` records. */
export async function gatherMinutes(rpcUrl: string, token: string, docsDir: string, fetchImpl: typeof fetch = fetch): Promise<Minutes> {
  const { bundle, warnings } = await bundleMinutes(docsDir);
  const texts = new Map<string, Bundled>(Object.entries(bundle.texts as Record<string, Bundled>));
  let raw: RawDecision[];
  try {
    const transport = rpcTransport({ rpcUrl, indexerUrl: webConfig.indexerUrl, account: token, fetchImpl });
    raw = decisionsOfTxs(await transport.transactions(await transport.txHashes()), token).decisions;
  } catch (e) {
    if (!(e instanceof SourceError)) throw e;
    return { decisions: [], warnings, error: `${e.source}: ${e.message}` };
  }
  const verdicts: Map<string, Verdict> = await checkDecisions(raw, texts);
  const decisions = raw.map((d): Decision => ({ epoch: d.epoch, rateBps: d.rateBps, hash: d.hash, tx: d.tx, text: texts.get(d.hash)?.text ?? null, verdict: verdicts.get(d.hash) ?? null }));
  return { decisions, warnings, error: null };
}

const signed = (bps: number): string => `${bps > 0 ? "+" : ""}${bps} bps`;

const VERDICT_LINE: Record<Verdict, string> = {
  verified: "SHA-256 of the recorded text equals the hash on chain",
  mismatch: "MISMATCH: SHA-256 of the recorded text is NOT the hash on chain",
  unchecked: "not checked: no SHA-256 available",
};

function describeDecision(d: Decision): string[] {
  const head = `  epoch ${d.epoch}, rate ${signed(d.rateBps)}, reasoning_hash ${d.hash}`;
  // Not a failure: only texts saved in docs/ can be compared, and a running agent's newest decisions are saved elsewhere.
  if (d.text === null || d.verdict === null) return [head, "      no text recorded in docs/ for this hash, so nothing to compare (not an error)"];
  const oneLine = d.text.replace(/\s+/g, " ").replace(/[\p{Cc}\p{Cf}]/gu, "?");
  return [head, `      "${oneLine.length > 100 ? `${oneLine.slice(0, 100)}...` : oneLine}"`, `      ${VERDICT_LINE[d.verdict]}`];
}

/**
 * The `limit` newest decisions, then up to `recordedLimit` of the newest ones with a text recorded in docs/ that are not already
 * listed (the chain moves every epoch and a running agent's texts are not in docs/, so the newest few may have none to compare).
 */
export function describeMinutes(m: Minutes, limit = 5, recordedLimit = 3): string[] {
  if (m.error !== null) return [`NOTE: the decisions on chain could not be read (${m.error}), so the reasoning-hash check was skipped and is not counted; the other checks read the RPC only.`];
  const shown = m.decisions.slice(0, limit);
  const lines = [`latest decisions on chain (${shown.length} of ${m.decisions.length}, newest first):`, ...shown.flatMap(describeDecision)];
  const recorded = m.decisions.filter((d) => d.text !== null && !shown.includes(d)).slice(0, recordedLimit);
  if (recorded.length > 0) lines.push("", `latest decisions with a text recorded in docs/ (${recorded.length} more):`, ...recorded.flatMap(describeDecision));
  return lines;
}
