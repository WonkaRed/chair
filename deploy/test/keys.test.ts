import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { testnetAccount } from "../src/guard.ts";
import { KeyStore } from "../src/keys.ts";

// Scratch lives on disk under ~/.scratch/tmp, not in /tmp (RAM).
const scratch = join(homedir(), ".scratch", "tmp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "chair-deploy-keys."));
after(() => rmSync(root, { recursive: true, force: true }));
const alice = testnetAccount("alice.chair-coin.testnet");

test("a new key is stored mode 600 in a mode 700 directory and only its public half is returned", () => {
  const store = new KeyStore(join(root, "a"));
  const publicKey = store.create(alice);
  assert.match(publicKey, /^ed25519:/);
  assert.equal(statSync(store.dir).mode & 0o777, 0o700);
  assert.equal(statSync(store.path(alice)).mode & 0o777, 0o600);
  const secret = readFileSync(store.path(alice), "utf8").trim();
  assert.ok(secret.startsWith("ed25519:") && secret !== publicKey);
  assert.ok(!publicKey.includes(secret));
});

test("a key file is never replaced", () => {
  const store = new KeyStore(join(root, "b"));
  store.create(alice);
  assert.throws(() => store.create(alice), /EEXIST/);
});

test("the signer matches the public key that was returned", async () => {
  const store = new KeyStore(join(root, "c"));
  const publicKey = store.create(alice);
  assert.equal(await store.publicKey(alice), publicKey);
});

test("a key file that others can read is refused", () => {
  const store = new KeyStore(join(root, "d"));
  store.create(alice);
  chmodSync(store.path(alice), 0o644);
  assert.throws(() => store.signer(alice), /chmod 600/);
});

test("a missing key file names the file", () => {
  const store = new KeyStore(join(root, "e"));
  assert.throws(() => store.signer(alice), /no key file for alice\.chair-coin\.testnet/);
});
