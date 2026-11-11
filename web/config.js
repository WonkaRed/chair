// The one place to point the page at a deployment. The build reads this file to write the page's Content-Security-Policy
// (connect-src allows exactly the hosts of rpcUrl and indexerUrl, and only when `fixture` is null), then copies it unchanged.
export const config = {
  network: "testnet",
  // The deployed token: docs/testnet-deployment.json records it, `make -C deploy verify` re-checks it.
  account: "token.chair-coin.testnet",
  // NEAR JSON-RPC: the source of truth for every total on the page.
  rpcUrl: "https://rpc.testnet.fastnear.com",
  // FastNEAR transactions API: which transactions touched the token, with their logs. An index, checked against the RPC.
  indexerUrl: "https://tx.test.fastnear.com",
  explorerUrl: "https://testnet.nearblocks.io",
  // Source links in the guarantees section.
  repoUrl: "https://github.com/WonkaRed/chair",
  repoRef: "main",
  // null reads the live chain. A path (fixtures/sandbox-run.json) shows a recorded sandbox run instead, with a banner saying so.
  fixture: null,
};
