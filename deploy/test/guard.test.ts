import assert from "node:assert/strict";
import { test } from "node:test";
import { assertTestnetChain, subAccount, testnetAccount } from "../src/guard.ts";
import { Rpc } from "../src/rpc.ts";

const reply = (body: unknown, status = 200) => ({ status, text: async () => JSON.stringify(body) });
const noSleep = async (): Promise<void> => undefined;

test("only .testnet account ids can be built", () => {
  for (const ok of ["chair-coin.testnet", "token.chair-coin.testnet", "a1.b_2.testnet"]) assert.equal(testnetAccount(ok), ok);
  for (const bad of ["alice.near", "testnet", ".testnet", "Chair.testnet", "a..testnet", "chair.testnet.near", "x.testnet ", "", `${"a".repeat(60)}.testnet`, "-a.testnet"]) {
    assert.throws(() => testnetAccount(bad), /testnet/, bad);
  }
});

test("a sub-account is checked like any other account", () => {
  assert.equal(subAccount("token", testnetAccount("chair-coin.testnet")), "token.chair-coin.testnet");
  assert.throws(() => subAccount("x".repeat(60), testnetAccount("chair-coin.testnet")));
});

test("any chain id but testnet is refused", () => {
  assertTestnetChain("testnet");
  for (const id of ["mainnet", "localnet", "", null, undefined, 1]) assert.throws(() => assertTestnetChain(id), /testnet only/);
});

test("an RPC that reports another chain cannot be connected", async () => {
  const mainnet = async () => reply({ jsonrpc: "2.0", id: "x", result: { chain_id: "mainnet" } });
  await assert.rejects(Rpc.connect("https://rpc.mainnet.near.org", mainnet, noSleep), /not "testnet"/);
});

test("an RPC must be https unless it is local", async () => {
  const fetchImpl = async () => reply({ result: { chain_id: "testnet" } });
  await assert.rejects(Rpc.connect("http://example.com", fetchImpl, noSleep), /https/);
  await Rpc.connect("http://127.0.0.1:3030", fetchImpl, noSleep);
});

test("HTTP 429 is retried with a doubling wait, then the answer is used", async () => {
  const waits: number[] = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls <= 3 ? reply({}, 429) : reply({ jsonrpc: "2.0", id: "x", result: { chain_id: "testnet" } });
  };
  await Rpc.connect("https://test.rpc.fastnear.com", fetchImpl, async (ms) => void waits.push(ms));
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(calls, 4);
});

test("a node that keeps answering 429 is given up on, not retried forever", async () => {
  const fetchImpl = async () => reply({}, 429);
  await assert.rejects(Rpc.connect("https://test.rpc.fastnear.com", fetchImpl, noSleep), /HTTP 429/);
});

const A = "https://a.example";
const B = "https://b.example";
const C = "https://c.example";
const TESTNET = { jsonrpc: "2.0", id: "x", result: { chain_id: "testnet" } };

/** A fake network: `behaviour` says what each endpoint answers (a status, or "refused" for a transport failure); `seen` lists the endpoints asked, in order. */
function network(behaviour: Record<string, number | "refused">) {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    const how = behaviour[url];
    if (how === "refused") throw new TypeError("fetch failed");
    return how === 200 ? reply(TESTNET) : reply({}, how);
  };
  return { seen, fetchImpl };
}

test("a 429 on the first endpoint is answered by the second at once, and the second is then asked first", async () => {
  const net = network({ [A]: 429, [B]: 200 });
  const waits: number[] = [];
  const rpc = await Rpc.connect(`${A},${B}`, net.fetchImpl, async (ms) => void waits.push(ms));
  assert.deepEqual(net.seen, [A, B]);
  assert.deepEqual(waits, []);
  assert.deepEqual(rpc.urls, [A, B]);
  assert.equal(rpc.url, A);
  await rpc.call("status", []);
  assert.deepEqual(net.seen, [A, B, B]);
});

test("the wait comes after every endpoint has been tried, doubles per round, and ends in the last status", async () => {
  const net = network({ [A]: 429, [B]: "refused", [C]: 503 });
  const waits: number[] = [];
  await assert.rejects(Rpc.connect(`${A}, ${B} ,${C}`, net.fetchImpl, async (ms) => void waits.push(ms)), /HTTP 503/);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 32000]);
  assert.equal(net.seen.length, 7 * 3);
  assert.deepEqual(net.seen.slice(0, 4), [A, B, C, A]);
});

test("with several endpoints one that refuses outright (403) is skipped; with one it is the answer, as before", async () => {
  const net = network({ [A]: 403, [B]: 200 });
  await Rpc.connect(`${A},${B}`, net.fetchImpl, noSleep);
  assert.deepEqual(net.seen, [A, B]);
  const single = network({ [A]: 403 });
  await assert.rejects(Rpc.connect(A, single.fetchImpl, noSleep), /HTTP 403/);
  assert.deepEqual(single.seen, [A]);
});

test("a node's own error is an answer and is not retried on another endpoint", async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => {
    seen.push(url);
    return reply({ error: { name: "HANDLER_ERROR", message: "x", cause: { name: "UNKNOWN_BLOCK" } } });
  };
  await assert.rejects(Rpc.connect(`${A},${B}`, fetchImpl, noSleep), /UNKNOWN_BLOCK/);
  assert.deepEqual(seen, [A]);
});

test("every endpoint in a list must be https unless local, and an empty entry is refused", async () => {
  const net = network({ [A]: 200 });
  await assert.rejects(Rpc.connect(`${A},http://example.com`, net.fetchImpl, noSleep), /https/);
  await assert.rejects(Rpc.connect(`${A},`, net.fetchImpl, noSleep));
  assert.deepEqual(net.seen, []);
});

test("a missing account is null, any other node error is raised", async () => {
  const answers: unknown[] = [
    { result: { chain_id: "testnet" } },
    { error: { name: "HANDLER_ERROR", message: "x", cause: { name: "UNKNOWN_ACCOUNT" } } },
    { error: { name: "HANDLER_ERROR", message: "x", cause: { name: "INVALID_ACCOUNT" } } },
  ];
  const rpc = await Rpc.connect("https://test.rpc.fastnear.com", async () => reply(answers.shift()), noSleep);
  assert.equal(await rpc.account(testnetAccount("nobody.testnet")), null);
  await assert.rejects(rpc.account(testnetAccount("nobody.testnet")), /INVALID_ACCOUNT/);
});
