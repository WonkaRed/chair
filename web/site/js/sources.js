// Where the numbers come from. Two transports with the same four methods, so the page has one code path:
//   rpcTransport      NEAR JSON-RPC endpoints (source of truth for views; an ordered list, failed over) and FastNEAR's
//                     transactions API (an index: which transactions touched the token, with their receipts and logs), whose
//                     complete results are kept in the browser (txcache.js) so a reload asks only for what it has not seen
//   fixtureTransport  a recorded sandbox run, served from a file
// Every failure is a SourceError saying which side failed and whether trying again may help.

import { complete, slim, txCache } from "./txcache.js";

export class SourceError extends Error {
  constructor(source, message, { retryable = false, status = null } = {}) {
    super(message);
    this.name = "SourceError";
    this.source = source; // "rpc" | "indexer"
    this.retryable = retryable;
    this.status = status;
  }
}

const TIMEOUT_MS = 10_000;
const ROUNDS = 2; // passes over the whole endpoint list before a call is reported as failed
const ROUND_PAUSE_MS = 400;
const PAGE_LIMIT = 200;
const MAX_PAGES = 50;
const TX_BATCH = 20;
const CONCURRENCY = 3;

// One POST to one URL. Everything thrown here is the transport failing (no answer, throttled, a server error, a body that
// is not JSON), which is what failover is for. A JSON-RPC error is a real answer: it comes back as a reply, not a throw.
async function postJson(fetchImpl, source, url, body, timeoutMs) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  } catch (e) {
    // A throttled host whose 429 carries no CORS header looks like this to the browser too (a TypeError, no status), so the message names both.
    throw new SourceError(source, e?.name === "TimeoutError" ? "timed out" : "unreachable or rate limited", { retryable: true });
  }
  if (res.status === 429) throw new SourceError(source, "rate limited", { retryable: true, status: 429 });
  if (!res.ok) throw new SourceError(source, `HTTP ${res.status}`, { retryable: res.status >= 500, status: res.status });
  try {
    return await res.json();
  } catch {
    throw new SourceError(source, "response was not JSON", { retryable: true });
  }
}

/**
 * POSTs to the first endpoint of `urls` that answers, starting at the one that answered last. A failed endpoint hands
 * the call to the next at once; after a whole failed round it pauses and tries one more round, then throws the last
 * failure. `inUse()` is the endpoint that answered last (the first until one has). `timeoutMs` is how long one endpoint may take.
 */
export function failoverPoster(fetchImpl, source, urls, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), timeoutMs = TIMEOUT_MS) {
  if (!Array.isArray(urls) || urls.length === 0) throw new Error(`no ${source} endpoint is configured`);
  let sticky = 0;
  const post = async (path, body) => {
    let last;
    let retryable = false;
    for (let round = 0; round < ROUNDS; round++) {
      if (round > 0) await sleep(ROUND_PAUSE_MS);
      for (let i = 0; i < urls.length; i++) {
        const at = (sticky + i) % urls.length;
        try {
          const reply = await postJson(fetchImpl, source, `${urls[at]}${path}`, body, timeoutMs);
          sticky = at;
          return reply;
        } catch (e) {
          last = e;
          retryable ||= e.retryable;
        }
      }
    }
    const tried = urls.length > 1 ? `all ${urls.length} endpoints failed, the last: ` : "";
    throw new SourceError(source, `${tried}${last.message}`, { retryable, status: last.status });
  };
  return { post, inUse: () => urls[sticky] };
}

/** `store` is where complete transactions are kept between visits (a `Storage`; null keeps nothing). */
export function rpcTransport({ rpcUrls, indexerUrl, account, fetchImpl = globalThis.fetch.bind(globalThis), sleep, store = null }) {
  const rpc = failoverPoster(fetchImpl, "rpc", rpcUrls, sleep);
  const indexer = failoverPoster(fetchImpl, "indexer", [indexerUrl], sleep);
  const cache = txCache({ store, key: `chair-txs/1:${account}` });
  let drewOnCache = false; // whether the last `transactions` call used anything kept
  const view = async (method, { blockHeight = null } = {}) => {
    const where = blockHeight === null ? { finality: "final" } : { block_id: blockHeight };
    const body = { jsonrpc: "2.0", id: "chair-web", method: "query", params: { request_type: "call_function", account_id: account, method_name: method, args_base64: "e30=", ...where } };
    const reply = await rpc.post("", body);
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
    const reply = await rpc.post("", { jsonrpc: "2.0", id: "chair-web", method: "query", params: { request_type: "view_access_key_list", account_id: account, finality: "final" } });
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
      const reply = await indexer.post("/v0/account", { account_id: account, is_receiver: true, desc: false, limit: PAGE_LIMIT, ...(resume ? { resume_token: resume } : {}) });
      const rows = reply?.account_txs;
      if (!Array.isArray(rows)) throw new SourceError("indexer", "unexpected response shape");
      for (const r of rows) if (typeof r?.transaction_hash === "string" && !seen.has(r.transaction_hash)) (seen.add(r.transaction_hash), hashes.push(r.transaction_hash));
      if (rows.length < PAGE_LIMIT) return hashes;
      resume = reply.resume_token;
      if (typeof resume !== "string" || resume === "") return hashes;
    }
    throw new SourceError("indexer", `more than ${MAX_PAGES * PAGE_LIMIT} transactions: not read to the end`);
  };

  /**
   * The transactions for `hashes`, in that order. Only the hashes not kept from an earlier visit are asked of the index, in batches of
   * at most `TX_BATCH` (its limit), a few at a time; what arrives is kept as it arrives, so a failure part-way still saves the batches
   * that succeeded. The first failed batch (after the poster's retries) stops the others and fails the call.
   */
  const transactions = async (hashes) => {
    const have = cache.read();
    drewOnCache = have.size > 0;
    const need = hashes.filter((h) => !have.has(h));
    const batches = [];
    for (let i = 0; i < need.length; i += TX_BATCH) batches.push(need.slice(i, i + TX_BATCH));
    const fetched = new Map();
    const fresh = new Map();
    let failure = null;
    let next = 0;
    const worker = async () => {
      while (failure === null && next < batches.length) {
        try {
          const reply = await indexer.post("/v0/transactions", { tx_hashes: batches[next++] });
          if (!Array.isArray(reply?.transactions)) throw new SourceError("indexer", "unexpected response shape");
          for (const tx of reply.transactions) {
            const kept = slim(tx, account);
            if (kept === null) continue;
            fetched.set(kept.transaction.hash, kept);
            if (complete(tx)) fresh.set(kept.transaction.hash, kept);
          }
        } catch (e) {
          failure ??= e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    if (fresh.size > 0) cache.write(hashes, new Map([...have, ...fresh]));
    if (failure !== null) throw failure;
    const missing = hashes.filter((h) => !have.has(h) && !fetched.has(h));
    if (missing.length > 0) throw new SourceError("indexer", `${missing.length} of ${hashes.length} transactions were not returned`);
    return hashes.map((h) => have.get(h) ?? fetched.get(h));
  };

  /** What an earlier visit kept (see `txcache.js`), for when the index cannot be read now: slim transactions, in no particular order. */
  const remembered = () => [...cache.read().values()];

  /** The caller found the log inconsistent with the chain. If the last read drew on what was kept, that is forgotten so the next read asks the index for everything; a read that did not is the index's own answer, which forgetting cannot change. */
  const distrust = () => {
    if (drewOnCache) cache.clear();
  };

  return { kind: "live", token: account, rpcInUse: rpc.inUse, view, accessKeys, txHashes, transactions, remembered, distrust };
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
