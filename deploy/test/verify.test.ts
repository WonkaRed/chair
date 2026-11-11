import assert from "node:assert/strict";
import { test } from "node:test";
import { baseEncode } from "near-api-js";
import { accountsOf, codeHashOf, sha256Hex } from "../src/deploy.ts";
import { testnetAccount } from "../src/guard.ts";
import type { DeploymentRecord } from "../src/record.ts";
import type { AccessKey } from "../src/rpc.ts";
import { describeState, evaluate, type Snapshot } from "../src/verify.ts";

const wasm = Buffer.from("\0asm\x01\0\0\0 pretend contract");
const accounts = accountsOf(testnetAccount("chair-coin.testnet"));
const record: DeploymentRecord = {
  schema: "chair-testnet-deployment/1",
  network: "testnet",
  rpc: "https://test.rpc.fastnear.com",
  parent: testnetAccount("chair-coin.testnet"),
  accounts,
  wasm: { sha256: sha256Hex(wasm), codeHash: codeHashOf(wasm), bytes: wasm.length },
  launch: { supply: "1000", epochMs: 90000, impeachThresholdBps: 3000, nominateBond: "100" },
  chairKeys: { chair: "ed25519:CHAIRKEY", challenger: "ed25519:CHALLKEY" },
  scenarioBaseEpoch: 1,
  transactions: [],
};
const scoped = (publicKey: string): AccessKey => ({ publicKey, permission: { receiverId: accounts.token, methodNames: ["set_policy"], allowance: null } });
const full = (publicKey: string): AccessKey => ({ publicKey, permission: "FullAccess" });

function good(): Snapshot {
  return {
    tokenCodeHash: record.wasm.codeHash,
    tokenCodeSha256: record.wasm.sha256,
    keys: { token: [], chair: [scoped("ed25519:CHAIRKEY")], challenger: [scoped("ed25519:CHALLKEY")], alice: [full("a")], bob: [full("b")], carol: [full("c")] },
    params: { epochMs: 90000, startMs: 1, maxRateBps: 200, maxStepBps: 50, impeachThresholdBps: 3000, quorumBps: 500, nominateBond: 100n },
    supply: { epoch: 12, launch: 1000n, minted: 80n, burned: 5n, total: 1075n, staked: 400n, rewardPool: 70n },
    totalSupplyView: 1075n,
    policy: { epoch: 12, rateBps: 20, chair: accounts.challenger, streak: 2, lastSetEpoch: 12, epochEndsMs: 9 },
    recordedHoldings: 1000n,
  };
}
const failing = (s: Snapshot, wasmSha?: string): string[] => evaluate(record, s, wasmSha).filter((c) => !c.ok).map((c) => c.name);

test("a deployment that matches its record passes every check", () => {
  assert.deepEqual(failing(good(), record.wasm.sha256), []);
});

test("the base58 code hash is checked against the bytes the node serves", () => {
  assert.equal(baseEncode(Buffer.from(record.wasm.sha256, "hex")), record.wasm.codeHash);
  const s = { ...good(), tokenCodeHash: "11111111111111111111111111111111" };
  assert.deepEqual(failing(s), ["code hash on chain equals the recorded wasm", "the reported code hash is the hash of the code the node serves"]);
});

test("different code on chain, or a different local build, fails", () => {
  assert.deepEqual(failing({ ...good(), tokenCodeSha256: sha256Hex("other") }).length > 0, true);
  assert.deepEqual(failing(good(), sha256Hex("rebuilt differently")), ["code hash on chain equals the local wasm"]);
});

test("any key on the token account fails", () => {
  const s = good();
  assert.deepEqual(failing({ ...s, keys: { ...s.keys, token: [full("x")] } }), ["the token account holds no access key at all"]);
});

test("a chair account must hold exactly one set_policy-only key with no allowance cap", () => {
  const s = good();
  const bad = (keys: AccessKey[]) => failing({ ...s, keys: { ...s.keys, chair: keys } });
  const name = "chair holds only a function-call key limited to set_policy on the token";
  assert.deepEqual(bad([full("ed25519:CHAIRKEY")]), [name]);
  assert.deepEqual(bad([scoped("ed25519:CHAIRKEY"), full("z")]), [name]);
  assert.deepEqual(bad([]), [name]);
  assert.deepEqual(bad([scoped("ed25519:OTHER")]), [name]);
  assert.deepEqual(bad([{ publicKey: "ed25519:CHAIRKEY", permission: { receiverId: accounts.token, methodNames: ["set_policy", "ft_transfer"], allowance: null } }]), [name]);
  assert.deepEqual(bad([{ publicKey: "ed25519:CHAIRKEY", permission: { receiverId: accounts.bob, methodNames: ["set_policy"], allowance: null } }]), [name]);
  assert.deepEqual(bad([{ publicKey: "ed25519:CHAIRKEY", permission: { receiverId: accounts.token, methodNames: ["set_policy"], allowance: "1000" } }]), [name]);
});

test("bounds other than 200, 50 and a 500 bps quorum, or other launch parameters, fail", () => {
  const s = good();
  const bounds = "hard bounds: rate within +-200 bps, step at most 50 bps, backing over 5% of the supply to seat a chair";
  assert.deepEqual(failing({ ...s, params: { ...s.params, maxRateBps: 300 } }), [bounds]);
  assert.deepEqual(failing({ ...s, params: { ...s.params, quorumBps: 1 } }), [bounds]);
  assert.deepEqual(failing({ ...s, params: { ...s.params, epochMs: 1000 } }), ["launch parameters are the recorded ones"]);
});

test("the supply identity must hold on the chain's own numbers", () => {
  const s = good();
  assert.deepEqual(failing({ ...s, supply: { ...s.supply, total: 1076n } }), ["total supply = launch + minted - burned", "ft_total_supply equals get_supply.total_supply"]);
  assert.deepEqual(failing({ ...s, supply: { ...s.supply, launch: 999n } }), ["launch supply is the recorded one", "total supply = launch + minted - burned"]);
});

test("recorded accounts can never hold more than the supply", () => {
  assert.deepEqual(failing({ ...good(), recordedHoldings: 1100n }), ["recorded accounts' balances and stake never exceed the supply"]);
});

test("the state line names the epoch, rate, chair and supply", () => {
  const line = describeState(good());
  for (const part of ["epoch 12", "rate 20 bps", accounts.challenger, "supply 1075"]) assert.ok(line.includes(part), part);
});
