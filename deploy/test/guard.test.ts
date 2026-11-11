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
