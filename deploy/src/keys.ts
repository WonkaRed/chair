// Secret keys live in one directory outside the repository, mode 700, one file per account, mode 600, holding the bare
// `ed25519:...` string. Nothing here prints a key, and a key file is only ever created, never overwritten.

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import type { TestnetAccount } from "./guard.ts";

export const DEFAULT_KEY_DIR = join(homedir(), ".claude", "secrets", "survival-testnet", "chair");
const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}$/;

export class KeyStore {
  readonly dir: string;
  constructor(dir: string = process.env["CHAIR_TESTNET_KEYS"] ?? DEFAULT_KEY_DIR) {
    this.dir = dir;
  }

  path(account: TestnetAccount): string {
    return join(this.dir, `${account}.key`);
  }

  has(account: TestnetAccount): boolean {
    return existsSync(this.path(account));
  }

  /** Generates and stores a new key pair for `account` and returns its public key. Refuses to replace a key file. */
  create(account: TestnetAccount): string {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const pair = KeyPair.fromRandom("ed25519");
    writeFileSync(this.path(account), `${pair.toString()}\n`, { mode: 0o600, flag: "wx" });
    return pair.getPublicKey().toString();
  }

  /** The signer for `account`; refuses a key file that others can read. */
  signer(account: TestnetAccount): KeyPairSigner {
    const file = this.path(account);
    if (!existsSync(file)) throw new Error(`no key file for ${account} (expected ${file})`);
    if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by group or others: chmod 600 it`);
    const secret = readFileSync(file, "utf8").trim();
    if (!KEY_RE.test(secret)) throw new Error(`${file} does not hold an ed25519 secret key`);
    return KeyPairSigner.fromSecretKey(secret as KeyPairString);
  }

  async publicKey(account: TestnetAccount): Promise<string> {
    return (await this.signer(account).getPublicKey()).toString();
  }
}
