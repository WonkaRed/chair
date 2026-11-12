// Where the numbers come from. Two transports with the same methods, so the page has one code path:
//   rpcTransport      NEAR JSON-RPC endpoints (source of truth for views; an ordered list, failed over) and FastNEAR's
//                     transactions API (an index: which transactions touched the token, read a page at a time newest first, with their receipts and logs), whose
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
export function rpcTransport({ rpcUrls, indexerUrl, account, fetchImpl = globalThis.fetch.bind(globalThis), sleep, store = null, pageLimit = PAGE_LIMIT }) {
  const rpc = failoverPoster(fetchImpl, "rpc", rpcUrls, sleep);
  const indexer = failoverPoster(fetchImpl, "indexer", [indexerUrl], sleep);
  const cache = txCache({ store, key: `chair-txs/1:${account}` });
  let drewOnCache = false; // whether the last `transactions` call used anything kept
  const session = new Map(); // complete transactions read from the index in this visit, so no hash is asked of it twice (storage may be full or off)
  let peeking = Promise.resolve(); // the `peek` in flight: `transactions` waits for it so the same hash is never asked for twice
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

  /**
   * One page of the hashes of the transactions that touched the token, newest first, with `next`: the token that asks for the page before it, or null
   * when this was the last one. A read of the page is one request however long the token has run; older pages come only when the caller asks.
   */
  const hashPage = async ({ resume = null } = {}) => {
    const reply = await indexer.post("/v0/account", { account_id: account, is_receiver: true, desc: true, limit: pageLimit, ...(resume === null ? {} : { resume_token: resume }) });
    const rows = reply?.account_txs;
    if (!Array.isArray(rows)) throw new SourceError("indexer", "unexpected response shape");
    const seen = new Set();
    const newest = [];
    for (const r of rows) if (typeof r?.transaction_hash === "string" && !seen.has(r.transaction_hash)) (seen.add(r.transaction_hash), newest.push(r.transaction_hash));
    const token = reply.resume_token;
    return { newest, next: rows.length < pageLimit || typeof token !== "string" || token === "" ? null : token };
  };

  /**
   * The newest transactions (the first `TX_BATCH` of `newest`, a newest-first list of hashes) read ahead of the rest, so the hero can show the latest
   * decision long before the whole list is in. One request for what is not already kept; complete results are held for `transactions`, so nothing is
   * asked twice. Null when they could not be read (the full read then decides what the page shows).
   */
  const peek = (newest) => {
    const wanted = newest.slice(0, TX_BATCH);
    peeking = (async () => {
      const have = new Map([...cache.read(), ...session]);
      const need = wanted.filter((h) => !have.has(h));
      const fetched = new Map();
      if (need.length > 0) {
        try {
          const reply = await indexer.post("/v0/transactions", { tx_hashes: need });
          if (!Array.isArray(reply?.transactions)) return null;
          for (const tx of reply.transactions) {
            const kept = slim(tx, account);
            if (kept === null) continue;
            fetched.set(kept.transaction.hash, kept);
            if (complete(tx)) session.set(kept.transaction.hash, kept);
          }
        } catch {
          return null;
        }
      }
      return wanted.map((h) => have.get(h) ?? fetched.get(h)).filter((tx) => tx !== undefined);
    })();
    return peeking;
  };

  /**
   * Particular transactions by hash (a few the page names itself, whatever the window), one request for those not already held. Never throws and
   * never touches what is kept for the next visit: the ones that could not be read are simply missing from the answer.
   */
  const lookup = async (wanted) => {
    const have = new Map([...cache.read(), ...session]);
    const need = wanted.filter((h) => !have.has(h)).slice(0, TX_BATCH);
    if (need.length > 0) {
      try {
        const reply = await indexer.post("/v0/transactions", { tx_hashes: need });
        for (const tx of Array.isArray(reply?.transactions) ? reply.transactions : []) {
          const kept = slim(tx, account);
          if (kept === null) continue;
          have.set(kept.transaction.hash, kept);
          if (complete(tx)) session.set(kept.transaction.hash, kept);
        }
      } catch {
        // A lookup is a convenience: what could not be read is not in the answer.
      }
    }
    return wanted.map((h) => have.get(h)).filter((tx) => tx !== undefined);
  };

  /**
   * The transactions for `hashes`, in that order. Only the hashes not kept from an earlier visit are asked of the index, in batches of
   * at most `TX_BATCH` (its limit), a few at a time; what arrives is kept as it arrives, so a failure part-way still saves the batches
   * that succeeded. The first failed batch (after the poster's retries) stops the others and fails the call.
   */
  const transactions = async (hashes) => {
    await peeking;
    const stored = cache.read();
    drewOnCache = stored.size > 0;
    const have = new Map([...stored, ...session]);
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
    for (const [hash, tx] of fresh) session.set(hash, tx);
    if (hashes.some((h) => !stored.has(h) && session.has(h))) cache.write(hashes, new Map([...have, ...fresh]));
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

  return { kind: "live", token: account, rpcInUse: rpc.inUse, view, accessKeys, hashPage, peek, lookup, transactions, remembered, distrust };
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
    hashPage: async () => ({ newest: doc.txs.map((t) => t.transaction.hash).reverse(), next: null }),
    lookup: async (hashes) => hashes.map((h) => doc.txs.find((t) => t.transaction.hash === h)).filter((t) => t !== undefined),
    transactions: async (hashes) => hashes.map((h) => doc.txs.find((t) => t.transaction.hash === h)),
  };
}
