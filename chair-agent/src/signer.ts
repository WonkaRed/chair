import { readFileSync, statSync } from "node:fs";
import { actions, baseDecode, createTransaction, KeyPairSigner, type SignedTransaction } from "near-api-js";
import { DEFAULT_BOUNDS, type Rate, type RefusedRate } from "./bounds.js";
import { NearRpc, type AccessKeyInfo } from "./rpc.js";
import type { Decision } from "./types.js";
import { cleanReasoning, MAX_REASONING_CHARS, reasoningHash } from "./reasoning.js";
import { accountId as checkAccountId } from "./validate.js";

export const METHOD = "set_policy";
/**
 * set_policy is a few reads and writes; rollover can add at most a handful of decay events. The reasoning text adds
 * at most 6000 bytes of arguments (MAX_REASONING_CHARS UTF-16 units, 3 bytes each in UTF-8): sandbox-tests/tests/policy.rs
 * sends that much to the contract's wasm and asserts it burns under half of these 30 Tgas.
 */
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
 * The arguments of `set_policy`: the rate, the SHA-256 of the reasoning text and the text itself. The contract declares
 * only the first two and ignores `reasoning` (sandbox-tests/tests/policy.rs proves it), so the text rides on the
 * transaction without touching the hash it stores: anyone can read it from the transaction and hash it. Nothing but the
 * text is added, and the hash is computed here from the text, so the two cannot disagree.
 */
export function policyArgs(rate: Rate | RefusedRate, reasoning: string): { rate_bps: number; reasoning_hash: string; reasoning: string } {
  if (cleanReasoning(reasoning) !== reasoning) throw new Error(`reasoning must be cleaned text of 1 to ${MAX_REASONING_CHARS} characters`);
  return { rate_bps: rate, reasoning_hash: reasoningHash(reasoning), reasoning };
}

/**
 * Builds and sends `set_policy` transactions. The only action it can construct is one function call to
 * `set_policy` with zero deposit; the only fields taken from a `Decision` are its `Rate` and its reasoning text.
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
  async build(rate: Rate | RefusedRate, reasoning: string, nonce: bigint, blockHash: string): Promise<SignedTransaction> {
    const args = policyArgs(rate, reasoning);
    const publicKey = await this.keys.getPublicKey();
    const tx = createTransaction(
      this.accountId,
      publicKey,
      this.token,
      nonce + 1n,
      [actions.functionCall(METHOD, args, GAS, 0n)],
      baseDecode(blockHash),
    );
    const { signedTransaction } = await this.keys.signTransaction(tx);
    return signedTransaction;
  }

  async submit(decision: Decision): Promise<SubmitResult> {
    return this.send(decision.rate, decision.reasoning);
  }

  /**
   * The press desk's overreach: a rate beyond the contract's absolute limit, sent with a fixed text, to show the contract refuses it. Checked
   * here again, independently of the desk's own `judge`: a rate the contract might accept would set the token's real rate, so it never leaves.
   * `onBroadcast` runs once, just before the transaction is sent; a throw before it means nothing was sent.
   */
  async submitRefused(rate: RefusedRate, reasoning: string, onBroadcast: () => void = () => undefined): Promise<SubmitResult> {
    if (!Number.isSafeInteger(rate) || Math.abs(rate) <= DEFAULT_BOUNDS.maxRateBps) {
      throw new RangeError(`refusing to send ${rate} as an overreach: only a rate beyond +-${DEFAULT_BOUNDS.maxRateBps} is certain to be refused`);
    }
    return this.send(rate, reasoning, onBroadcast);
  }

  /**
   * Both the agent's decision and the desk's overreach go through here, signed by the same key, so the nonce is read at `optimistic` finality: a call
   * the other one sent moments ago is already counted, where `final` lags it by a block or two and would reuse its nonce.
   */
  private async send(rate: Rate | RefusedRate, reasoning: string, onBroadcast: () => void = () => undefined): Promise<SubmitResult> {
    const key = await this.publicKey();
    const info = await this.rpc.accessKey(this.accountId, key, "optimistic");
    assertScoped(info, this.token);
    const block = await this.rpc.finalBlock();
    const signed = await this.build(rate, reasoning, info.nonce, block.hash);
    onBroadcast();
    return this.rpc.sendTx(Buffer.from(signed.encode()).toString("base64"));
  }
}
