#!/usr/bin/env node
// Moves testnet NEAR between two accounts of the $CHAIR / Preflight demos: one plain Transfer, signed here with the
// from-account's key file. Testnet only: it refuses a non-testnet RPC and any account id that is not `<name>.testnet`
// (the to-account may also be a 64-hex implicit id).
//
//   node topup.mjs <from-account> <to-account> <NEAR>      e.g.  node topup.mjs chair-gas-3.testnet bob.chair-coin-3.testnet 1.5
//
// stdout: the transaction hash, then both balances after it. Nothing else is printed, no key or part of one, ever.
// Exit 1 with one line on stderr when the key is missing, the amount is bad, or the chain refuses the transfer.
// No dependencies beyond Node 22: the transaction is borsh-encoded and signed with node:crypto.
//
// Env (all optional): TOPUP_KEYS_DIR (default ~/.claude/secrets/survival-testnet; the key is <dir>/<from>.key or
// <dir>/<subdir>/<from>.key, a bare `ed25519:<base58>` string or a near-cli credentials JSON), CHAIR_RPC_URL
// (default https://test.rpc.fastnear.com).

import { createHash, createPrivateKey, sign } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RPC = process.env.CHAIR_RPC_URL ?? "https://test.rpc.fastnear.com";
const KEYS_DIR = process.env.TOPUP_KEYS_DIR ?? join(homedir(), ".claude", "secrets", "survival-testnet");

if (!/^(test\.|rpc\.testnet\.)/.test(new URL(RPC).hostname)) throw new Error(`refusing a non-testnet RPC: ${RPC}`);

const YOCTO_DIGITS = 24;
const TRANSFER_ACTION = 3; // borsh enum index of Transfer in a NEAR action
const ED25519 = 0; // borsh enum index of the ed25519 key and signature types
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const NAMED = /^(?=.{2,64}$)([a-z0-9]+([-_][a-z0-9]+)*\.)+testnet$/;
const IMPLICIT = /^[0-9a-f]{64}$/;

const fail = (msg) => {
  console.error(`topup: ${msg}`);
  process.exit(1);
};

/** "1.5" -> yoctoNEAR as a BigInt, exactly: a decimal string with at most 24 decimals, no sign, no exponent, above zero. */
function parseNear(text) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(text ?? "");
  if (!m) fail(`bad amount "${text}": a positive decimal NEAR amount like 1.5`);
  const yocto = BigInt(m[1]) * 10n ** BigInt(YOCTO_DIGITS) + BigInt((m[2] ?? "").padEnd(YOCTO_DIGITS, "0"));
  if (yocto <= 0n) fail("the amount must be above zero");
  return yocto;
}

function b58decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error("bad base58");
    n = n * 58n + BigInt(i);
  }
  let hex = n === 0n ? "" : n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const zeros = s.length - s.replace(/^1+/, "").length; // each leading "1" is one leading zero byte
  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, "hex")]);
}

function b58encode(buf) {
  let n = BigInt("0x" + (buf.toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  const zeros = buf.findIndex((b) => b !== 0);
  return "1".repeat(zeros < 0 ? buf.length : zeros) + out;
}

/** The account's secret key (64 bytes: seed then public key), read from its key file. The file's contents never reach an error message. */
function loadKey(account) {
  const dirs = [KEYS_DIR, ...readdirSync(KEYS_DIR).map((d) => join(KEYS_DIR, d)).filter((d) => statSync(d).isDirectory())];
  const file = dirs.map((d) => join(d, `${account}.key`)).find((f) => { try { return statSync(f).isFile(); } catch { return false; } });
  if (!file) fail(`no key file ${account}.key under ${KEYS_DIR}`);
  let raw = readFileSync(file, "utf8").trim();
  if (raw.startsWith("{")) {
    try {
      const j = JSON.parse(raw);
      raw = j.private_key ?? j.secret_key ?? "";
    } catch {
      raw = "";
    }
  }
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(raw)) fail(`${account}.key is not an ed25519 secret key (expected ed25519:<base58>)`);
  const key = b58decode(raw.slice("ed25519:".length));
  if (key.length !== 64) fail(`${account}.key is not an ed25519 secret key (wrong length)`);
  return key;
}

async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json();
      if (body.error) {
        const info = body.error.data?.TxExecutionError ?? body.error.cause?.info; // why the node refused a transaction
        const e = new Error(`${method}: ${body.error.cause?.name ?? body.error.name ?? JSON.stringify(body.error).slice(0, 200)}${info ? ` ${JSON.stringify(info).slice(0, 300)}` : ""}`);
        e.definite = body.error.cause?.name !== "TIMEOUT_ERROR";
        throw e;
      }
      return body.result;
    } catch (e) {
      last = e;
      if (e.definite) break; // the node answered: asking again changes nothing
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // transport trouble or a 429: back off
    }
  }
  throw last;
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const b = Buffer.alloc(16); b.writeBigUInt64LE(n & (2n ** 64n - 1n)); b.writeBigUInt64LE(n >> 64n, 8); return b; };
const str = (s) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);

async function balanceOf(account) {
  try {
    return BigInt((await rpc("query", { request_type: "view_account", finality: "final", account_id: account })).amount);
  } catch (e) {
    if (/UnknownAccount/.test(e.message)) return null;
    throw e;
  }
}

const near = (y) => (y === null ? "no account" : (Number(y) / 1e24).toFixed(5));

const [from, to, amountText, ...extra] = process.argv.slice(2);
if (!from || !to || amountText === undefined || extra.length) fail("usage: node topup.mjs <from-account> <to-account> <NEAR>");
if (!NAMED.test(from)) fail(`refusing ${from}: the from-account must be a <name>.testnet account`);
if (!NAMED.test(to) && !IMPLICIT.test(to)) fail(`refusing ${to}: the to-account must be a <name>.testnet account or a 64-hex implicit id`);
if (from === to) fail("from and to are the same account");
const deposit = parseNear(amountText);

const secret = loadKey(from);
const seed = secret.subarray(0, 32);
const publicKey = secret.subarray(32);
const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });

const keyInfo = await rpc("query", { request_type: "view_access_key", finality: "optimistic", account_id: from, public_key: `ed25519:${b58encode(publicKey)}` }).catch((e) => fail(`${from} does not accept this key: ${e.message}`));
if (keyInfo.permission !== "FullAccess") fail(`${from}'s key is not a full-access key: a transfer needs one`);
const block = await rpc("block", { finality: "final" });

const tx = Buffer.concat([
  str(from),
  Buffer.from([ED25519]),
  publicKey,
  u64(BigInt(keyInfo.nonce) + 1n),
  str(to),
  b58decode(block.header.hash),
  u32(1),
  Buffer.from([TRANSFER_ACTION]),
  u128(deposit),
]);
const signature = sign(null, createHash("sha256").update(tx).digest(), privateKey);
const signedBase64 = Buffer.concat([tx, Buffer.from([ED25519]), signature]).toString("base64");

// Sending the same signed bytes again is harmless (same hash), so a timeout is retried inside rpc().
const result = await rpc("send_tx", { signed_tx_base64: signedBase64, wait_until: "FINAL" }).catch((e) => fail(`send failed: ${e.message}`));
const failure = [result.status, ...result.receipts_outcome.map((o) => o.outcome.status)].find((s) => s.Failure);
if (failure) fail(`the chain refused the transfer (tx ${result.transaction.hash}): ${JSON.stringify(failure.Failure).slice(0, 300)}`);

console.log(`tx ${result.transaction.hash}`);
console.log(`${from.padEnd(40)} ${near(await balanceOf(from))} NEAR`);
console.log(`${to.padEnd(40)} ${near(await balanceOf(to))} NEAR`);
