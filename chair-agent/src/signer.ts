import { readFileSync, statSync } from "node:fs";
import { actions, baseDecode, createTransaction, KeyPairSigner, type SignedTransaction } from "near-api-js";
import type { Rate } from "./bounds.js";
import { NearRpc, type AccessKeyInfo } from "./rpc.js";
import type { Decision } from "./types.js";
import { HASH_RE } from "./reasoning.js";
import { accountId as checkAccountId } from "./validate.js";

export const METHOD = "set_policy";
/** set_policy is a few reads and writes; rollover can add at most a handful of decay events. */
export const GAS = 30_000_000_000_000n;
const KEY_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,100}$/;

export class KeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyError";
  }
}

/**
 * Finds the chair's secret key: `CHAIR_KEY` holds it, or `CHAIR_KEY_FILE` names a file with it (either the
 * bare `ed25519:...` string or a near-cli credentials JSON with `private_key`). Messages never contain
 * the key or any part of it.
 */
export function loadSecretKey(env: NodeJS.ProcessEnv, warn: (message: string) => void = () => undefined): string {
  const inline = env["CHAIR_KEY"];
  const path = env["CHAIR_KEY_FILE"];
  if (inline && path) throw new KeyError("set only one of CHAIR_KEY and CHAIR_KEY_FILE");
  let raw: string;
  if (inline) {
    raw = inline;
  } else if (path) {
    try {
      const st = statSync(path);
      if (st.size > 4096) throw new KeyError("CHAIR_KEY_FILE is too large to be a key file");
      if ((st.mode & 0o077) !== 0) warn("CHAIR_KEY_FILE is readable by group or others; run chmod 600 on it");
      raw = readFileSync(path, "utf8");
    } catch (err) {
      if (err instanceof KeyError) throw err;
      throw new KeyError("CHAIR_KEY_FILE cannot be read");
    }
  } else {
    throw new KeyError("no key: set CHAIR_KEY or CHAIR_KEY_FILE (a function-call key scoped to set_policy)");
  }
  let key = raw.trim();
  if (key.startsWith("{")) {
    try {
      const j = JSON.parse(key) as Record<string, unknown>;
      const v = j["private_key"] ?? j["secret_key"];
      key = typeof v === "string" ? v : "";
    } catch {
      key = "";
    }
  }
  if (!KEY_RE.test(key)) throw new KeyError("the key is not an ed25519 secret key (expected ed25519:<base58>)");
  return key;
}

/** SPEC "The chair's key": a function-call key for the token, method set_policy and nothing else. */
export function assertScoped(info: AccessKeyInfo, token: string): void {
  const p = info.permission;
  if (p === "FullAccess") throw new KeyError("refusing a full-access key: use a function-call key scoped to set_policy");
  if (p.receiverId !== token || p.methodNames.length !== 1 || p.methodNames[0] !== METHOD) {
    throw new KeyError(`key must be scoped to receiver ${token} and methods [${METHOD}] only`);
  }
}

export interface SubmitResult {
  readonly txHash: string;
  /** The contract's refusal or failure text, or null when the call executed. */
  readonly failure: string | null;
}

export interface Submitter {
  submit(decision: Decision): Promise<SubmitResult>;
}

/**
 * Builds and sends `set_policy` transactions. The only action it can construct is one function call to
 * `set_policy` with zero deposit; the only fields taken from a `Decision` are its `Rate` and its hash.
 */
export class ChairSigner implements Submitter {
  private readonly keys: KeyPairSigner;
  constructor(
    secretKey: string,
    readonly accountId: string,
    readonly token: string,
    private readonly rpc: NearRpc,
  ) {
    checkAccountId(accountId, "chair account");
    checkAccountId(token, "token account");
    try {
      this.keys = KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`);
    } catch {
      throw new KeyError("the key could not be loaded");
    }
  }

  async publicKey(): Promise<string> {
    return (await this.keys.getPublicKey()).toString();
  }

  /** Sign one set_policy call. Exposed for tests; `submit` is the normal path. */
  async build(rate: Rate, reasoningHash: string, nonce: bigint, blockHash: string): Promise<SignedTransaction> {
    if (!HASH_RE.test(reasoningHash)) throw new Error("reasoning hash must be 64 lowercase hex characters");
    const publicKey = await this.keys.getPublicKey();
    const tx = createTransaction(
      this.accountId,
      publicKey,
      this.token,
      nonce + 1n,
      [actions.functionCall(METHOD, { rate_bps: rate, reasoning_hash: reasoningHash }, GAS, 0n)],
      baseDecode(blockHash),
    );
    const { signedTransaction } = await this.keys.signTransaction(tx);
    return signedTransaction;
  }

  async submit(decision: Decision): Promise<SubmitResult> {
    const key = await this.publicKey();
    const info = await this.rpc.accessKey(this.accountId, key);
    assertScoped(info, this.token);
    const block = await this.rpc.finalBlock();
    const signed = await this.build(decision.rate, decision.reasoningHash, info.nonce, block.hash);
    return this.rpc.sendTx(Buffer.from(signed.encode()).toString("base64"));
  }
}
