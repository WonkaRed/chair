import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { accountsOf, codeHashOf, newRecord, sha256Hex } from "../src/deploy.ts";
import { testnetAccount } from "../src/guard.ts";
import { KeyStore } from "../src/keys.ts";
import { loadRecord, recordedStep, saveRecord, type TxRecord } from "../src/record.ts";
import { Run } from "../src/run.ts";
import { Rpc } from "../src/rpc.ts";

const scratch = join(homedir(), ".scratch", "tmp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "chair-deploy-record."));
after(() => rmSync(root, { recursive: true, force: true }));
const parent = testnetAccount("chair-coin.testnet");
const wasm = Buffer.from("\0asm\x01\0\0\0 pretend contract");

test("the sha256 and the base58 code hash are two spellings of the same 32 bytes", () => {
  const hex = sha256Hex(wasm);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.match(codeHashOf(wasm), /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("every account of a deployment is a sub-account of the parent", () => {
  const a = accountsOf(parent);
  assert.deepEqual(Object.values(a).sort(), ["alice", "bob", "carol", "chair", "challenger", "token"].map((n) => `${n}.chair-coin.testnet`));
});

test("a new record names the chair keys by their public half and holds no secret", async () => {
  const keys = new KeyStore(join(root, "keys"));
  const record = await newRecord("https://test.rpc.fastnear.com", keys, parent, wasm);
  assert.equal(record.chairKeys.chair, await keys.publicKey(record.accounts.chair));
  assert.equal(record.chairKeys.challenger, await keys.publicKey(record.accounts.challenger));
  assert.equal(record.wasm.sha256, sha256Hex(wasm));
  assert.equal(record.wasm.bytes, wasm.length);
  const secrets = ["chair", "challenger", "alice", "bob", "carol"].map((r) => readFileSync(keys.path(record.accounts[r as "chair"]), "utf8").trim());
  for (const secret of secrets) assert.ok(!JSON.stringify(record).includes(secret));
});

test("a record round-trips and a foreign file is refused", async () => {
  const record = await newRecord("https://test.rpc.fastnear.com", new KeyStore(join(root, "keys2")), parent, wasm);
  const file = join(root, "rec.json");
  saveRecord(file, record);
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.deepEqual(loadRecord(file), record);
  writeFileSync(file, '{"schema":"other"}');
  assert.throws(() => loadRecord(file), /not a chair-testnet-deployment\/1 record/);
});

test("a step already in the record is skipped without signing or sending", async () => {
  const keys = new KeyStore(join(root, "keys3"));
  const record = await newRecord("https://test.rpc.fastnear.com", keys, parent, wasm);
  const done: TxRecord = { step: "s1", hash: "H", signer: record.accounts.chair, receiver: record.accounts.token, what: "w", proves: "p", outcome: "success", detail: null, note: null, at: "2026-01-01T00:00:00.000Z" };
  record.transactions.push(done);
  const rpc = await Rpc.connect("https://test.rpc.fastnear.com", async () => ({ status: 200, text: async () => '{"result":{"chain_id":"testnet"}}' }), async () => undefined);
  const lines: string[] = [];
  const run = new Run(rpc, keys, record, join(root, "rec3.json"), (l) => void lines.push(l));
  const out = await run.step({ id: "s1", signer: done.signer as typeof parent, receiver: done.receiver as typeof parent, actions: [], what: "w", proves: "p", expect: { kind: "success" } });
  assert.equal(out, null);
  assert.match(lines.join("\n"), /already recorded/);
  assert.equal(recordedStep(record, "s1"), done);
  assert.equal(record.transactions.length, 1);
});
