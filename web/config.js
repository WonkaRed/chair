// The one place to point the page at a deployment. The build reads this file to write the page's Content-Security-Policy
// (connect-src allows exactly the hosts of rpcUrl and indexerUrl, and only when `fixture` is null, plus the press desk's discovery host and its quick tunnels when `pressDiscoveryUrl` is set), then copies it unchanged.
export const config = {
  network: "testnet",
  // The deployed token: docs/testnet-deployment.json records it, `make -C deploy verify` re-checks it.
  account: "token.chair-coin-2.testnet",
  // NEAR JSON-RPC: the source of truth for every total on the page.
  rpcUrl: "https://rpc.testnet.fastnear.com",
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
  // null reads the live chain. A path (fixtures/sandbox-run.json) shows a recorded sandbox run instead, with a banner saying so.
  fixture: null,
};
