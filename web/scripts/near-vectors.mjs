// Writes test/data/near-vectors.json: transactions the panel's near.js must reproduce byte for byte, built and signed by near-api-js 7.4.0
// (the version chair-agent and deploy pin). The web page has no package.json, so this reads the library from chair-agent's install
// (`npm ci` there first). The key is a throwaway whose seed is 0x01..0x20 and is public on purpose: it holds nothing and signs only these vectors.
// Every method, argument, gas and deposit below is written out literally, not taken from near.js, so the test compares two independent sources.
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const need = createRequire(join(here, "..", "..", "chair-agent", "package.json"));
const lib = need("near-api-js");
const { ed25519 } = need("@noble/curves/ed25519.js");
const { KeyPair, actions, baseDecode, createTransaction, encodeTransaction, keyToImplicitAddress } = lib;

const seed = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const pair = KeyPair.fromString(`ed25519:${lib.baseEncode(Uint8Array.from([...seed, ...ed25519.getPublicKey(seed)]))}`);

const publicKey = pair.getPublicKey();
const signerId = keyToImplicitAddress(publicKey.toString());
const token = "token.chair-coin-3.testnet";
const blockHash = "4Hb7yQ9dEPm1b8uVQe7ZcXv3m9Zr2rQ3sWjKq7oV1NfT";
const calls = [
  { name: "stake, first time", method: "stake", argsJson: '{"amount":"50000000000000000000000000"}', gas: "20000000000000", deposit: "3000000000000000000000" },
  { name: "unstake", method: "unstake", argsJson: '{"amount":"12500000000000000000000000"}', gas: "15000000000000", deposit: "1" },
  { name: "claim", method: "claim", argsJson: "{}", gas: "15000000000000", deposit: "1" },
  { name: "send", method: "ft_transfer", argsJson: '{"receiver_id":"alice.chair-coin-3.testnet","amount":"1000000000000000000000000"}', gas: "15000000000000", deposit: "1" },
];

const transactions = calls.map((c, i) => {
  const nonce = 1234567890123n + BigInt(i);
  const tx = createTransaction(signerId, publicKey, token, nonce, [actions.functionCall(c.method, JSON.parse(c.argsJson), BigInt(c.gas), BigInt(c.deposit))], baseDecode(blockHash));
  const bytes = encodeTransaction(tx);
  const hash = createHash("sha256").update(bytes).digest();
  const { signature } = pair.sign(hash);
  const signedBytes = Buffer.concat([Buffer.from(bytes), Buffer.from([0]), Buffer.from(signature)]);
  return { ...c, signerId, receiverId: token, nonce: String(nonce), blockHash, txHex: Buffer.from(bytes).toString("hex"), txHash: lib.baseEncode(hash), signedBase64: signedBytes.toString("base64") };
});

const out = {
  generatedBy: "near-api-js 7.4.0 (KeyPair, createTransaction, actions.functionCall, encodeTransaction, keyToImplicitAddress), by web/scripts/near-vectors.mjs",
  note: "A throwaway key (seed 01..20), public on purpose: it holds nothing and signs only these vectors.",
  seedHex: Buffer.from(seed).toString("hex"),
  secretKey: pair.toString(),
  publicKey: publicKey.toString(),
  implicitId: signerId,
  transactions,
};
await writeFile(join(here, "..", "test", "data", "near-vectors.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${transactions.length} vectors for ${signerId}`);
