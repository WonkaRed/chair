// The one place to point the page at a deployment. The build reads this file to write the page's Content-Security-Policy
// (connect-src allows exactly the hosts of rpcUrls and indexerUrl, and only when `fixture` is null, plus the press desk's discovery hosts and its quick tunnels when `pressDiscoveryUrl` is set), then copies it unchanged.
export const config = {
  network: "testnet",
  // The deployed token: docs/testnet-deployment.json records it, `make -C deploy verify` re-checks it.
  account: "token.chair-coin-3.testnet",
  // NEAR JSON-RPC: the source of truth for every total on the page. Ordered: the page starts at the first and moves to the next when one
  // is throttled (429), down, or unreachable, then sticks with whichever answered last. Each must answer `query` (call_function,
  // view_access_key_list) and send CORS headers on its answers. Measured 2026-11-11 with the account's own calls, ordered by fewest 429s.
  rpcUrls: ["https://rpc.testnet.fastnear.com", "https://near-testnet.drpc.org", "https://rpc.testnet.near.org"],
  // FastNEAR transactions API: which transactions touched the token, with their logs. An index, checked against the RPC.
  indexerUrl: "https://tx.test.fastnear.com",
  explorerUrl: "https://testnet.nearblocks.io",
  // Source links in the guarantees section.
  repoUrl: "https://github.com/WonkaRed/chair",
  repoRef: "main",
  // Where the page finds the press desk (POST /ask, GET /record). The desk sits behind a quick tunnel whose address changes on every restart, so this
  // is a small JSON document, {"url": "https://<words>.trycloudflare.com", "updated_at_ms": <number>}, that a script on the desk's machine rewrites.
  // Empty: no desk, the page says the Chair is not taking questions. The build adds this host and *.trycloudflare.com to connect-src.
  pressDiscoveryUrl: "https://gist.githubusercontent.com/WonkaRed/03480ab34ee914911577adfd2a8b6a63/raw/chair-press.json",
  // The same gist through the GitHub API (CORS *, cached 60 s), which the page reads first. The raw file above is cached for 5 minutes and lags an update by
  // minutes even with a cache-busting query (measured 2026-11-11), so after a desk restart it would keep naming the dead address. The API lets one address
  // read 60 times an hour, so the page reads it at most every 90 s, and only while the desk is not answering. Empty: the raw file only. The build adds this host to connect-src.
  pressDiscoveryApiUrl: "https://api.github.com/gists/03480ab34ee914911577adfd2a8b6a63",
  // null reads the live chain. A path (fixtures/sandbox-run.json) shows a recorded sandbox run instead, with a banner saying so.
  fixture: null,
};
