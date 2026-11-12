// The little of NEAR the "Your own test coins" panel needs, with no library: base58, a key made by WebCrypto, Borsh for one function-call
// transaction, its ed25519 signature, and the four calls the panel makes on the token. Nothing here touches the page. The one network
// helper, `rpcClient`, takes a `post(body)` and is told nothing about endpoints. Adapted from the sister project's web/src/near.js (MIT, same author);
// test/near.test.mjs checks every byte against transactions built and signed by near-api-js 7.4.0 (test/data/near-vectors.json).

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encoder = new TextEncoder();

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const byte of bytes) n = n * 256n + BigInt(byte);
  let out = "";
  for (; n > 0n; n /= 58n) out = ALPHABET[Number(n % 58n)] + out;
  return "1".repeat(zeros) + out;
}

export function base58Decode(text) {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros++;
  let n = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) throw new RangeError("not base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 0xffn));
  return Uint8Array.from([...new Array(zeros).fill(0), ...bytes]);
}

/** Whether `text` is a base58 string of exactly 32 bytes: the shape of every NEAR hash (block hash, transaction hash). */
export function isHash(text) {
  if (typeof text !== "string" || text.length > 44) return false;
  try {
    return base58Decode(text).length === 32;
  } catch {
    return false;
  }
}

const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

// Borsh, little endian. Integers outside their width are an error, never a silent wrap.
const uint = (value, bytes) => {
  const big = BigInt(value);
  if (big < 0n || big >= 1n << BigInt(8 * bytes)) throw new RangeError(`${value} does not fit in u${8 * bytes}`);
  return Uint8Array.from({ length: bytes }, (_, i) => Number((big >> BigInt(8 * i)) & 0xffn));
};
const vec = (bytes) => concat([uint(bytes.length, 4), bytes]);
const string = (text) => vec(encoder.encode(text));
const fixed = (bytes, length, what) => {
  if (bytes.length !== length) throw new RangeError(`${what} must be ${length} bytes`);
  return bytes;
};

const ED25519 = 0;
const FUNCTION_CALL = 2;

/** The Borsh bytes of a transaction with one FunctionCall action. `args` is the raw argument bytes. Keys and hashes are bytes. */
export function encodeFunctionCall({ signerId, publicKey, nonce, receiverId, blockHash, method, args, gas, deposit = 0n }) {
  return concat([
    string(signerId), uint(ED25519, 1), fixed(publicKey, 32, "public key"), uint(nonce, 8), string(receiverId), fixed(blockHash, 32, "block hash"),
    uint(1, 4), uint(FUNCTION_CALL, 1), string(method), vec(args), uint(gas, 8), uint(deposit, 16),
  ]);
}

// PKCS#8 wrapper of a raw ed25519 seed (RFC 8410): WebCrypto imports and exports private keys only in this form.
const PKCS8_ED25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/** `ed25519:<base58 of the 32-byte public key>`, the form NEAR prints a public key in. */
export const publicKeyText = (publicKey) => `ed25519:${base58Encode(fixed(publicKey, 32, "public key"))}`;
/** `ed25519:<base58 of seed then public key>`, the form NEAR prints a secret key in. */
export const secretKeyText = ({ seed, publicKey }) => `ed25519:${base58Encode(concat([fixed(seed, 32, "seed"), fixed(publicKey, 32, "public key")]))}`;
/** The account a key owns without anyone creating it: the 64 hex characters of its public key. */
export const implicitAccountId = (publicKey) => hex(fixed(publicKey, 32, "public key"));

export function parseSecretKey(text) {
  const match = typeof text === "string" ? /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(text) : null;
  let bytes = null;
  try {
    bytes = match && base58Decode(match[1]);
  } catch {
    bytes = null;
  }
  if (!bytes || bytes.length !== 64) throw new RangeError("not an ed25519 secret key");
  return { seed: bytes.slice(0, 32), publicKey: bytes.slice(32) };
}

/** A fresh key from this browser's WebCrypto: `{ seed, publicKey }` as bytes. Throws when the browser has no ed25519. */
export async function generateKey(subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("WebCrypto is not available here (it needs https or localhost)");
  const pair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const prefix = pkcs8.slice(0, PKCS8_ED25519.length);
  if (pkcs8.length !== PKCS8_ED25519.length + 32 || prefix.some((b, i) => b !== PKCS8_ED25519[i])) throw new Error("this browser exported the key in a form this page cannot read");
  return { seed: pkcs8.slice(PKCS8_ED25519.length), publicKey: new Uint8Array(await subtle.exportKey("raw", pair.publicKey)) };
}

/** Whether this browser can make and use an ed25519 key. */
export async function canEd25519(subtle = globalThis.crypto?.subtle) {
  try {
    await generateKey(subtle);
    return true;
  } catch {
    return false;
  }
}

/**
 * Signs the transaction the way NEAR does (ed25519 over the SHA-256 of its bytes). Returns the signed transaction as base64, ready for
 * `send_tx`, and the transaction hash, which is also its explorer id. The signature is checked against the key's own public half before
 * it is returned, so a secret key whose halves do not match fails here, loudly, and not as a rejected transaction.
 */
export async function signTransaction(txBytes, secretKey, subtle = globalThis.crypto?.subtle) {
  if (!subtle) throw new Error("WebCrypto is not available here (it needs https or localhost)");
  const { seed, publicKey } = parseSecretKey(secretKey);
  const hash = new Uint8Array(await subtle.digest("SHA-256", txBytes));
  let signature;
  try {
    const key = await subtle.importKey("pkcs8", concat([PKCS8_ED25519, seed]), "Ed25519", false, ["sign"]);
    signature = new Uint8Array(await subtle.sign("Ed25519", key, hash));
    const pub = await subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
    if (!(await subtle.verify("Ed25519", pub, signature, hash))) throw new RangeError("the secret key does not match its public key");
  } catch (error) {
    if (error?.name === "NotSupportedError") throw new Error("this browser cannot sign with ed25519 (WebCrypto)");
    throw error;
  }
  return { signedBase64: btoa(String.fromCharCode(...concat([txBytes, uint(ED25519, 1), signature]))), txHash: base58Encode(hash) };
}

// What each call needs (contract/src/staking.rs, token.rs): `stake` needs at least 1 yoctoNEAR and its first call also pays for the stake record,
// the excess is refunded; the other three need exactly 1 yoctoNEAR. The chain reserves about 0.001 NEAR per attached Tgas up front and refunds what is
// not used, so the gas is lean: a call measured on testnet uses about 10 Tgas.
export const STAKE_GAS = 20_000_000_000_000n;
export const GAS = 15_000_000_000_000n;
export const FIRST_STAKE_DEPOSIT = 3n * 10n ** 21n; // 0.003 NEAR: the stake record costs about 0.0011, the rest comes back
const ONE_YOCTO = 1n;
const call = (method, args, deposit, gas = GAS) => ({ method, argsJson: JSON.stringify(args), gas, deposit });

/** The token contract's calls as `{ method, argsJson, gas, deposit }`; amounts are base units (BigInt). `first` is a stake with no stake record yet. */
export const stakeCall = (amount, { first = false } = {}) => call("stake", { amount: String(amount) }, first ? FIRST_STAKE_DEPOSIT : ONE_YOCTO, STAKE_GAS);
export const unstakeCall = (amount) => call("unstake", { amount: String(amount) }, ONE_YOCTO);
export const claimCall = () => call("claim", {}, ONE_YOCTO);
export const transferCall = (receiverId, amount) => call("ft_transfer", { receiver_id: receiverId, amount: String(amount) }, ONE_YOCTO);

/** A failed JSON-RPC call: `kind` is "network" when no node answered, "rpc" when a node answered with an error (`detail` is that error as text). */
export class RpcError extends Error {
  constructor(message, kind, detail = "") {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
    this.detail = detail;
  }
}

const decoder = new TextDecoder();

/**
 * The few JSON-RPC calls the panel makes. `post(body)` sends one JSON-RPC body to the node (failing over as the page's other reads do) and returns
 * the parsed reply, or throws when no node answers. `finality` is "optimistic" so the panel sees its own transaction as soon as it has run.
 */
export function rpcClient(post, { finality = "optimistic" } = {}) {
  const rpc = async (method, params) => {
    let reply;
    try {
      reply = await post({ jsonrpc: "2.0", id: "chair-mine", method, params });
    } catch (e) {
      throw new RpcError(e?.message ?? "no node answered", "network");
    }
    if (reply?.error) throw new RpcError(reply.error.cause?.name ?? reply.error.name ?? "rpc error", "rpc", JSON.stringify(reply.error));
    if (reply?.result === undefined) throw new RpcError("the node sent no result", "rpc");
    return reply.result;
  };
  return {
    /** A view call of `contract`: the JSON it returns. */
    async view(contract, method, args = {}) {
      const result = await rpc("query", { request_type: "call_function", account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)), finality });
      if (!Array.isArray(result.result)) throw new RpcError(`${method}: the node returned an error instead of a value`, "rpc", String(result.error ?? ""));
      return JSON.parse(decoder.decode(Uint8Array.from(result.result)));
    },
    /** The access key's nonce, or null when the account or the key does not exist yet. */
    async nonce(accountId, publicKey) {
      try {
        const key = await rpc("query", { request_type: "view_access_key", account_id: accountId, public_key: publicKey, finality });
        return Number.isSafeInteger(key.nonce) ? key.nonce : null;
      } catch (e) {
        if (e.kind === "rpc" && /UNKNOWN_(ACCOUNT|ACCESS_KEY)/.test(e.detail)) return null;
        throw e;
      }
    },
    async blockHash() {
      const block = await rpc("block", { finality: "final" });
      if (!isHash(block?.header?.hash)) throw new RpcError("the block answer is unusable", "rpc");
      return block.header.hash;
    },
    /** A transaction already sent, by hash: its result once the call has run. Throws when no node knows it. */
    status: (txHash, signerId) => rpc("tx", { tx_hash: txHash, sender_account_id: signerId, wait_until: "EXECUTED_OPTIMISTIC" }),
    /** Sends a signed transaction and returns the node's result once the call has run. */
    send: (signedBase64) => rpc("send_tx", { signed_tx_base64: signedBase64, wait_until: "EXECUTED_OPTIMISTIC" }),
  };
}
