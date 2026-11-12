// site/js/near.js: base58, the key a browser makes, the Borsh transaction and its signature, byte for byte against transactions built and
// signed by near-api-js 7.4.0 (test/data/near-vectors.json, written by scripts/near-vectors.mjs from a public throwaway seed).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { base58Decode, base58Encode, canEd25519, claimCall, encodeFunctionCall, FIRST_STAKE_DEPOSIT, GAS, generateKey, implicitAccountId, isHash, parseSecretKey, publicKeyText, rpcClient, RpcError, secretKeyText, signTransaction, stakeCall, transferCall, unstakeCall } from "../site/js/near.js";

const vector = JSON.parse(readFileSync(new URL("data/near-vectors.json", import.meta.url), "utf8"));
const seed = Uint8Array.from(Buffer.from(vector.seedHex, "hex"));
const publicKey = base58Decode(vector.publicKey.slice("ed25519:".length));
const hex = (bytes) => Buffer.from(bytes).toString("hex");
const [VSTAKE, VUNSTAKE, VCLAIM, VSEND] = vector.transactions;
const encode = (t, over = {}) => encodeFunctionCall({
  signerId: t.signerId, publicKey, nonce: BigInt(t.nonce), receiverId: t.receiverId, blockHash: base58Decode(t.blockHash),
  method: t.method, args: new TextEncoder().encode(t.argsJson), gas: BigInt(t.gas), deposit: BigInt(t.deposit), ...over,
});
const ONE_COIN = 10n ** 24n;

test("base58 round-trips, keeps leading zero bytes, and rejects characters outside the alphabet", () => {
  for (const bytes of [[], [0], [0, 0, 1], [255], Array.from({ length: 32 }, (_, i) => i * 8)]) assert.deepEqual([...base58Decode(base58Encode(Uint8Array.from(bytes)))], bytes);
  for (const bad of ["0", "O", "I", "l", "a b", "+"]) assert.throws(() => base58Decode(bad), RangeError, bad);
  assert.equal(isHash(VCLAIM.txHash), true);
  for (const bad of ["", "abc", `${VCLAIM.txHash}0`, null, 42]) assert.equal(isHash(bad), false, String(bad));
});

test("the key text, the public key text and the implicit account id are what near-api-js prints", () => {
  assert.equal(secretKeyText({ seed, publicKey }), vector.secretKey);
  assert.equal(publicKeyText(publicKey), vector.publicKey);
  assert.equal(implicitAccountId(publicKey), vector.implicitId);
  assert.match(vector.implicitId, /^[0-9a-f]{64}$/);
  const parsed = parseSecretKey(vector.secretKey);
  assert.equal(hex(parsed.seed), vector.seedHex);
  assert.equal(hex(parsed.publicKey), hex(publicKey));
  for (const bad of ["", "ed25519:", "secp256k1:abc", `ed25519:${base58Encode(new Uint8Array(32).fill(1))}`, vector.secretKey.slice("ed25519:".length), "ed25519:0OIl", null]) assert.throws(() => parseSecretKey(bad), RangeError, String(bad));
  assert.throws(() => publicKeyText(new Uint8Array(31)), RangeError);
});

test("a key this browser makes comes out as 32-byte halves that sign and verify, and its text parses back", async () => {
  const key = await generateKey();
  assert.equal(key.seed.length, 32);
  assert.equal(key.publicKey.length, 32);
  const text = secretKeyText(key);
  assert.deepEqual(parseSecretKey(text).seed, key.seed);
  const { signedBase64, txHash } = await signTransaction(encode(VCLAIM, { publicKey: key.publicKey, signerId: implicitAccountId(key.publicKey) }), text);
  assert.ok(signedBase64.length > 100 && isHash(txHash));
  assert.notEqual(hex((await generateKey()).seed), hex(key.seed), "two keys are never the same");
  assert.equal(await canEd25519(), true);
});

test("a browser without ed25519, or without WebCrypto, is told so rather than failing later", async () => {
  const none = { generateKey: async () => { throw new DOMException("no", "NotSupportedError"); } };
  assert.equal(await canEd25519(none), false);
  assert.equal(await canEd25519(null), false);
  await assert.rejects(() => generateKey(none), { name: "NotSupportedError" });
});

for (const [name, calls] of Object.entries({ stake: [VSTAKE, stakeCall(50n * ONE_COIN, { first: true })], unstake: [VUNSTAKE, unstakeCall(125n * ONE_COIN / 10n)], claim: [VCLAIM, claimCall()], send: [VSEND, transferCall("alice.chair-coin-3.testnet", ONE_COIN)] })) {
  test(`${name}: the call, the transaction bytes, the signature and the hash are what near-api-js produces`, async () => {
    const [t, call] = calls;
    assert.equal(call.method, t.method);
    assert.equal(call.argsJson, t.argsJson, "the arguments are the ones the contract reads");
    assert.equal(String(call.gas), t.gas);
    assert.equal(String(call.deposit), t.deposit);
    const bytes = encode(t, { method: call.method, args: new TextEncoder().encode(call.argsJson), gas: call.gas, deposit: call.deposit });
    assert.equal(hex(bytes), t.txHex);
    const { signedBase64, txHash } = await signTransaction(bytes, vector.secretKey);
    assert.equal(txHash, t.txHash);
    assert.equal(signedBase64, t.signedBase64);
  });
}

test("the first stake carries the deposit for its record and every later call exactly one yoctoNEAR", () => {
  assert.equal(stakeCall(1n, { first: true }).deposit, FIRST_STAKE_DEPOSIT);
  assert.equal(stakeCall(1n).deposit, 1n);
  assert.equal(unstakeCall(1n).deposit, 1n);
  assert.equal(claimCall().deposit, 1n);
  assert.equal(transferCall("a.testnet", 1n).deposit, 1n);
  assert.equal(GAS, 15n * 10n ** 12n);
  assert.equal(stakeCall(1n).gas, 20n * 10n ** 12n);
  assert.equal(claimCall().gas, GAS);
});

test("integers outside their width and keys or hashes of the wrong length are errors, never a silent wrap", () => {
  assert.throws(() => encode(VCLAIM, { nonce: 2n ** 64n }), RangeError);
  assert.throws(() => encode(VCLAIM, { gas: -1n }), RangeError);
  assert.throws(() => encode(VCLAIM, { deposit: 2n ** 128n }), RangeError);
  assert.throws(() => encode(VCLAIM, { blockHash: new Uint8Array(31) }), RangeError);
  assert.throws(() => encode(VCLAIM, { publicKey: new Uint8Array(33) }), RangeError);
});

test("a secret key whose halves do not match fails at signing, not at the chain", async () => {
  const other = publicKey.map((b) => b ^ 1);
  await assert.rejects(() => signTransaction(encode(VCLAIM), secretKeyText({ seed, publicKey: other })));
  await assert.rejects(() => signTransaction(encode(VCLAIM), vector.secretKey, null), /WebCrypto/);
});

const reply = (result) => async () => ({ jsonrpc: "2.0", id: "x", result });
const failure = (error) => async () => ({ jsonrpc: "2.0", id: "x", error });

test("rpc: a view returns the contract's JSON, the nonce is null for a key that does not exist, and errors say which side failed", async () => {
  const bodies = [];
  const post = async (body) => {
    bodies.push(body);
    return { result: { result: [...new TextEncoder().encode('"50"')], logs: [], block_height: 1 } };
  };
  const rpc = rpcClient(post);
  assert.equal(await rpc.view("token.testnet", "ft_balance_of", { account_id: "a.testnet" }), "50");
  assert.equal(bodies[0].params.finality, "optimistic");
  assert.equal(bodies[0].params.method_name, "ft_balance_of");
  assert.deepEqual(JSON.parse(atob(bodies[0].params.args_base64)), { account_id: "a.testnet" });
  assert.equal(await rpcClient(failure({ name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } })).nonce("a", "k"), null);
  assert.equal(await rpcClient(reply({ nonce: 7 })).nonce("a", "k"), 7);
  await assert.rejects(() => rpcClient(failure({ name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } })).nonce("a", "k"), { kind: "rpc" });
  await assert.rejects(() => rpcClient(async () => { throw new Error("all endpoints failed"); }).view("t", "m"), (e) => e instanceof RpcError && e.kind === "network");
  await assert.rejects(() => rpcClient(reply({ error: "wasm execution failed", logs: [] })).view("t", "m"), { kind: "rpc" });
  await assert.rejects(() => rpcClient(reply({ header: { hash: "nope" } })).blockHash(), { kind: "rpc" });
  assert.equal(await rpcClient(reply({ header: { hash: VCLAIM.txHash } })).blockHash(), VCLAIM.txHash);
});
