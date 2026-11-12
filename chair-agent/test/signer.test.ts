import assert from "node:assert/strict";
import { tempDir } from "./helpers.js";
import { chmodSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KeyPair, SignedTransaction, baseEncode } from "near-api-js";
import { createHash } from "node:crypto";
import { RateWindow, DEFAULT_BOUNDS, type RefusedRate } from "../src/bounds.js";
import { MAX_REASONING_CHARS, reasoningHash } from "../src/reasoning.js";
import { NearRpc } from "../src/rpc.js";
import { ChairSigner, GAS, KeyError, POOL_GAS, PoolSigner, STAKE_DEPOSIT, UNSTAKE_DEPOSIT, assertFullAccess, assertScoped, loadKeyFile, loadSecretKey } from "../src/signer.js";

const secret = KeyPair.fromRandom("ed25519").toString();
const blockHash = baseEncode(createHash("sha256").update("block").digest());
const rpc = new NearRpc("http://127.0.0.1:1");
const rate = RateWindow.around(0, DEFAULT_BOUNDS).pick(25);

test("the signed transaction is one zero-deposit set_policy call to the token, signed by the chair key", async () => {
  const signer = new ChairSigner(secret, "chair.test", "token.test", rpc);
  const signed = await signer.build(rate, "why", 41n, blockHash);
  const decoded = SignedTransaction.decode(signed.encode());
  const tx = decoded.transaction;
  assert.equal(tx.signerId, "chair.test");
  assert.equal(tx.receiverId, "token.test");
  assert.equal(tx.nonce, 42n);
  assert.equal(tx.publicKey.toString(), await signer.publicKey());
  assert.equal(tx.actions.length, 1);
  const call = tx.actions[0]!.functionCall;
  assert.ok(call, "the only action is a function call");
  assert.equal(call.methodName, "set_policy");
  assert.deepEqual(JSON.parse(Buffer.from(call.args).toString("utf8")), { rate_bps: 25, reasoning_hash: reasoningHash("why"), reasoning: "why" });
  assert.equal(call.deposit, 0n);
  assert.equal(call.gas, GAS);
  const digest = createHash("sha256").update(tx.encode()).digest();
  assert.ok(tx.publicKey.verify(digest, Uint8Array.from(decoded.signature.ed25519Signature!.data)), "signature verifies against the chair's public key");
});

test("the transaction carries the whole reasoning text, longest allowed included, and a hash computed from it", async () => {
  const signer = new ChairSigner(secret, "chair.test", "token.test", rpc);
  const longest = "\u20ac".repeat(MAX_REASONING_CHARS);
  const args = async (text: string): Promise<Record<string, unknown>> => {
    const call = SignedTransaction.decode((await signer.build(rate, text, 1n, blockHash)).encode()).transaction.actions[0]!.functionCall!;
    assert.ok(call.args.length <= 6200, `${call.args.length} bytes of arguments`);
    return JSON.parse(Buffer.from(call.args).toString("utf8")) as Record<string, unknown>;
  };
  for (const text of [longest, "line one\nline \u201ctwo\u201d with \"quotes\" and \\ and \u{1F600}"]) {
    const sent = await args(text);
    assert.deepEqual(Object.keys(sent).sort(), ["rate_bps", "reasoning", "reasoning_hash"]);
    assert.equal(sent["reasoning"], text);
    assert.equal(sent["reasoning_hash"], reasoningHash(text));
  }
});

test("text that is empty, too long or not cleaned never reaches a transaction", async () => {
  const signer = new ChairSigner(secret, "chair.test", "token.test", rpc);
  for (const bad of ["", " ", "x".repeat(MAX_REASONING_CHARS + 1), " padded ", "bell\u0007", "bidi\u202e", "zero\u200bwidth", "\ud800"]) {
    await assert.rejects(signer.build(rate, bad, 1n, blockHash), /cleaned text of 1 to 2000 characters/, JSON.stringify(bad));
  }
});

test("bad account ids and bad keys are refused without echoing the key", () => {
  assert.throws(() => new ChairSigner(secret, "Not An Account", "token.test", rpc), /not a NEAR account id/);
  assert.throws(() => new ChairSigner(secret, "chair.test", "../x", rpc), /not a NEAR account id/);
  const garbage = "ed25519:" + "1".repeat(88);
  try {
    new ChairSigner(garbage, "chair.test", "token.test", rpc);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof KeyError || e instanceof Error);
    assert.ok(!String((e as Error).message).includes(garbage));
  }
});

test("assertScoped accepts only a function-call key for the token with set_policy alone", () => {
  const fc = (receiverId: string, methodNames: string[]) => ({ nonce: 1n, permission: { receiverId, methodNames } });
  assertScoped(fc("token.test", ["set_policy"]), "token.test");
  assert.throws(() => assertScoped({ nonce: 1n, permission: "FullAccess" }, "token.test"), /full-access/);
  assert.throws(() => assertScoped(fc("other.test", ["set_policy"]), "token.test"), /scoped to receiver/);
  assert.throws(() => assertScoped(fc("token.test", []), "token.test"), /scoped/);
  assert.throws(() => assertScoped(fc("token.test", ["ft_transfer"]), "token.test"), /scoped/);
  assert.throws(() => assertScoped(fc("token.test", ["set_policy", "ft_transfer"]), "token.test"), /scoped/);
});

test("loadSecretKey: env var, bare file, credentials JSON; errors never contain the key", () => {
  const dir = tempDir("chair-key");
  try {
    assert.equal(loadSecretKey({ CHAIR_KEY: secret }), secret);
    const bare = join(dir, "bare");
    writeFileSync(bare, `${secret}\n`);
    assert.equal(loadSecretKey({ CHAIR_KEY_FILE: bare }), secret);
    const json = join(dir, "cred.json");
    writeFileSync(json, JSON.stringify({ account_id: "chair.test", public_key: "x", private_key: secret }));
    assert.equal(loadSecretKey({ CHAIR_KEY_FILE: json }), secret);

    assert.throws(() => loadSecretKey({}), /no key/);
    assert.throws(() => loadSecretKey({ CHAIR_KEY: secret, CHAIR_KEY_FILE: bare }), /only one/);
    assert.throws(() => loadSecretKey({ CHAIR_KEY_FILE: join(dir, "missing") }), /cannot be read/);
    const bad = `ed25519:notakey-${secret.slice(10, 30)}`;
    assert.throws(
      () => loadSecretKey({ CHAIR_KEY: bad }),
      (e: Error) => /not an ed25519 secret key/.test(e.message) && !e.message.includes(bad) && !e.message.includes(secret),
    );
    const big = join(dir, "big");
    writeFileSync(big, "x".repeat(5000));
    assert.throws(() => loadSecretKey({ CHAIR_KEY_FILE: big }), /CHAIR_KEY_FILE is too large/);
    // The toys' keys are named by their own variables, and an error names the one that was used.
    assert.equal(loadKeyFile(bare, "CHAIR_VISITOR_KEY_FILE"), secret);
    assert.throws(() => loadKeyFile(join(dir, "missing"), "CHAIR_VISITOR_KEY_FILE"), /^KeyError: CHAIR_VISITOR_KEY_FILE cannot be read$/);
    assert.throws(() => loadKeyFile(big, "CHAIR_OVERREACH_KEY_FILE"), /CHAIR_OVERREACH_KEY_FILE is too large/);
    const warned: string[] = [];
    chmodSync(bare, 0o644);
    loadKeyFile(bare, "CHAIR_VISITOR_KEY_FILE", (m) => warned.push(m));
    assert.deepEqual(warned, ["CHAIR_VISITOR_KEY_FILE is readable by group or others; run chmod 600 on it"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submit re-checks the key's scope on the chain and sends nothing when it is wrong", async () => {
  const decision = { epoch: 1, previousRateBps: 0, rate, reasoning: "x", reasoningHash: reasoningHash("x"), chair: "rule-v1", kind: "rule" as const };
  for (const permission of ["FullAccess", { receiverId: "other.test", methodNames: ["set_policy"] }, { receiverId: "token.test", methodNames: ["set_policy", "ft_transfer"] }] as const) {
    let sent = 0;
    const stub = {
      accessKey: () => Promise.resolve({ nonce: 1n, permission }),
      finalBlock: () => Promise.resolve({ hash: blockHash, timestampMs: 1 }),
      sendTx: () => { sent++; return Promise.resolve({ txHash: "t", failure: null }); },
    } as unknown as NearRpc;
    const signer = new ChairSigner(secret, "chair.test", "token.test", stub);
    await assert.rejects(signer.submit(decision), KeyError, JSON.stringify(permission));
    assert.equal(sent, 0, "nothing was broadcast");
  }
  let sent = 0;
  const good = {
    accessKey: () => Promise.resolve({ nonce: 1n, permission: { receiverId: "token.test", methodNames: ["set_policy"] } }),
    finalBlock: () => Promise.resolve({ hash: blockHash, timestampMs: 1 }),
    sendTx: () => { sent++; return Promise.resolve({ txHash: "t", failure: null }); },
  } as unknown as NearRpc;
  assert.equal((await new ChairSigner(secret, "chair.test", "token.test", good).submit(decision)).txHash, "t");
  assert.equal(sent, 1);
});

test("a key file readable by group or others draws a warning that never contains the key; a private one does not", () => {
  const dir = tempDir("chair-keyperm");
  try {
    const f = join(dir, "k");
    writeFileSync(f, secret);
    const warnings: string[] = [];
    chmodSync(f, 0o644);
    assert.equal(loadSecretKey({ CHAIR_KEY_FILE: f }, (m) => warnings.push(m)), secret);
    chmodSync(f, 0o640);
    loadSecretKey({ CHAIR_KEY_FILE: f }, (m) => warnings.push(m));
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((w) => /readable by group or others/.test(w) && !w.includes(secret.slice(8))));
    chmodSync(f, 0o600);
    loadSecretKey({ CHAIR_KEY_FILE: f }, (m) => warnings.push(m));
    assert.equal(warnings.length, 2, "0600 is quiet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both the agent's decision and the desk's overreach read the access key at optimistic finality, so a call sent moments ago by the other is counted in the nonce", async () => {
  const seen: string[] = [];
  const stub = {
    accessKey: (_a: string, _k: string, finality: string) => {
      seen.push(finality);
      return Promise.resolve({ nonce: 41n, permission: { receiverId: "token.test", methodNames: ["set_policy"] } });
    },
    finalBlock: () => Promise.resolve({ hash: blockHash, height: 1, timestampMs: 0 }),
    sendTx: () => Promise.resolve({ txHash: "tx", failure: null }),
  };
  const signer = new ChairSigner(secret, "chair.test", "token.test", stub as unknown as NearRpc);
  await signer.submit({ rate, reasoning: "why", reasoningHash: reasoningHash("why") } as never);
  await signer.submitRefused(500 as RefusedRate, "overreach");
  assert.deepEqual(seen, ["optimistic", "optimistic"]);
});

test("the pool signs one stake or one unstake on the token with the deposit that call needs, and nothing else can be built", async () => {
  const signer = new PoolSigner(secret, "pool.test", "token.test", rpc);
  for (const [method, deposit] of [["stake", STAKE_DEPOSIT], ["unstake", UNSTAKE_DEPOSIT]] as const) {
    const decoded = SignedTransaction.decode((await signer.build(method, 12345n, 7n, blockHash)).encode());
    const tx = decoded.transaction;
    assert.equal(tx.signerId, "pool.test");
    assert.equal(tx.receiverId, "token.test");
    assert.equal(tx.nonce, 8n);
    assert.equal(tx.actions.length, 1);
    const call = tx.actions[0]!.functionCall;
    assert.ok(call, "the only action is a function call");
    assert.equal(call.methodName, method);
    assert.deepEqual(JSON.parse(Buffer.from(call.args).toString("utf8")), { amount: "12345" });
    assert.equal(call.deposit, deposit);
    assert.equal(call.gas, POOL_GAS);
  }
  assert.equal(STAKE_DEPOSIT, 10n ** 22n, "0.01 NEAR: pays a first stake's record, the rest is refunded");
  assert.equal(UNSTAKE_DEPOSIT, 1n, "unstake wants exactly 1 yoctoNEAR");
  // The amount is a positive U128 and nothing else; no other method name type-checks, and none is reachable at run time.
  for (const bad of [0n, -1n, 1n << 128n]) await assert.rejects(signer.build("stake", bad, 7n, blockHash), RangeError, String(bad));
});

test("the pool sends only with a full-access key, at optimistic finality; a function-call key is refused before anything is signed", async () => {
  const seen: string[] = [];
  let sent = 0;
  const stub = (permission: unknown) => ({
    accessKey: (_a: string, _k: string, finality: string) => {
      seen.push(finality);
      return Promise.resolve({ nonce: 41n, permission });
    },
    finalBlock: () => Promise.resolve({ hash: blockHash, height: 1, timestampMs: 0 }),
    sendTx: () => (sent++, Promise.resolve({ txHash: "tx", failure: null })),
  });
  const full = new PoolSigner(secret, "pool.test", "token.test", stub("FullAccess") as unknown as NearRpc);
  let broadcast = 0;
  assert.equal((await full.stake(5n, () => broadcast++)).txHash, "tx");
  assert.equal((await full.unstake(5n, () => broadcast++)).txHash, "tx");
  assert.deepEqual([seen, sent, broadcast], [["optimistic", "optimistic"], 2, 2]);

  const scoped = new PoolSigner(secret, "pool.test", "token.test", stub({ receiverId: "token.test", methodNames: ["stake", "unstake"] }) as unknown as NearRpc);
  await assert.rejects(scoped.stake(5n, () => broadcast++), KeyError);
  assert.deepEqual([sent, broadcast], [2, 2], "nothing was signed or sent");
  assert.doesNotThrow(() => assertFullAccess({ nonce: 1n, permission: "FullAccess" }));
});
