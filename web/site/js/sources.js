// Where the numbers come from. Two transports with the same four methods, so the page has one code path:
//   rpcTransport      a NEAR JSON-RPC endpoint (source of truth for views) and FastNEAR's transactions API
//                     (an index: which transactions touched the token, with their receipts and logs)
//   fixtureTransport  a recorded sandbox run, served from a file
// Every failure is a SourceError saying which side failed and whether trying again may help.

export class SourceError extends Error {
  constructor(source, message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = "SourceError";
    this.source = source; // "rpc" | "indexer"
    this.retryable = retryable;
    this.status = status;
  }
}

const TIMEOUT_MS = 15_000;
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const TX_BATCH = 20;
const CONCURRENCY = 3;

async function postJson(fetchImpl, source, url, body) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    throw new SourceError(source, e?.name === "TimeoutError" ? "timed out" : "network error", { retryable: true });
  }
  if (res.status === 429) throw new SourceError(source, "rate limited", { retryable: true, status: 429 });
  if (!res.ok) throw new SourceError(source, `HTTP ${res.status}`, { retryable: res.status >= 500, status: res.status });
  try {
    return await res.json();
  } catch {
    throw new SourceError(source, "response was not JSON");
  }
}

export function rpcTransport({ rpcUrl, indexerUrl, account, fetchImpl = globalThis.fetch.bind(globalThis) }) {
  const view = async (method, { blockHeight = null } = {}) => {
    const where = blockHeight === null ? { finality: "final" } : { block_id: blockHeight };
    const body = { jsonrpc: "2.0", id: "chair-web", method: "query", params: { request_type: "call_function", account_id: account, method_name: method, args_base64: "e30=", ...where } };
    const reply = await postJson(fetchImpl, "rpc", rpcUrl, body);
    if (reply?.error) throw new SourceError("rpc", `${reply.error.name ?? "error"}: ${reply.error.cause?.name ?? reply.error.message ?? "rejected"}`.slice(0, 120));
    const bytes = reply?.result?.result;
    if (!Array.isArray(bytes)) throw new SourceError("rpc", `${method}: the node returned an error instead of a value`.slice(0, 120));
    try {
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes)));
    } catch {
      throw new SourceError("rpc", `${method}: result is not JSON`);
    }
  };

  const accessKeys = async () => {
    const reply = await postJson(fetchImpl, "rpc", rpcUrl, { jsonrpc: "2.0", id: "chair-web", method: "query", params: { request_type: "view_access_key_list", account_id: account, finality: "final" } });
    const keys = reply?.result?.keys;
    if (!Array.isArray(keys)) throw new SourceError("rpc", "access key list unavailable");
    return keys.length;
  };

  /** Hashes of every transaction that touched the token, oldest first. Throws if the index cannot be read to its end. */
  const txHashes = async () => {
    const hashes = [];
    const seen = new Set();
    let resume;
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = await postJson(fetchImpl, "indexer", `${indexerUrl}/v0/account`, { account_id: account, is_receiver: true, desc: false, limit: PAGE_LIMIT, ...(resume ? { resume_token: resume } : {}) });
      const rows = reply?.account_txs;
      if (!Array.isArray(rows)) throw new SourceError("indexer", "unexpected response shape");
      for (const r of rows) if (typeof r?.transaction_hash === "string" && !seen.has(r.transaction_hash)) (seen.add(r.transaction_hash), hashes.push(r.transaction_hash));
      if (rows.length < PAGE_LIMIT) return hashes;
      resume = reply.resume_token;
      if (typeof resume !== "string" || resume === "") return hashes;
    }
    throw new SourceError("indexer", `more than ${MAX_PAGES * PAGE_LIMIT} transactions: not read to the end`);
  };

  const transactions = async (hashes) => {
    const batches = [];
    for (let i = 0; i < hashes.length; i += TX_BATCH) batches.push(hashes.slice(i, i + TX_BATCH));
    const out = [];
    let next = 0;
    const worker = async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const reply = await postJson(fetchImpl, "indexer", `${indexerUrl}/v0/transactions`, { tx_hashes: batch });
        if (!Array.isArray(reply?.transactions)) throw new SourceError("indexer", "unexpected response shape");
        out.push(...reply.transactions);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    const byHash = new Map(out.map((t) => [t?.transaction?.hash, t]));
    const missing = hashes.filter((h) => !byHash.has(h));
    if (missing.length > 0) throw new SourceError("indexer", `${missing.length} of ${hashes.length} transactions were not returned`);
    return hashes.map((h) => byHash.get(h));
  };

  return { kind: "live", token: account, view, accessKeys, txHashes, transactions };
}

/** `doc` is a parsed `chair-web-fixture/1` file (a recorded sandbox run). */
export function fixtureTransport(doc) {
  const view = async (method, { blockHeight = null } = {}) => {
    if (method === "get_params") return doc.params;
    if (method === "get_policy") return doc.policyNow;
    if (method === "get_supply") return blockHeight === null ? doc.supplyNow : doc.supplyAtLastTx;
    throw new SourceError("rpc", `fixture has no ${method}`);
  };
  return {
    kind: "fixture",
    token: doc.token,
    view,
    accessKeys: async () => doc.accessKeys.length,
    txHashes: async () => doc.txs.map((t) => t.transaction.hash),
    transactions: async (hashes) => hashes.map((h) => doc.txs.find((t) => t.transaction.hash === h)),
  };
}
