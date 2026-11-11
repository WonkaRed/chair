// docs/testnet-deployment.json: the public record of a deployment. `verify` reads it with no key; `deploy` and
// `scenario` append to it after every transaction, so a rerun skips what is recorded. Public keys only, never a secret.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { TestnetAccount } from "./guard.ts";

export const ROLES = ["token", "chair", "challenger", "alice", "bob", "carol"] as const;
export type Role = (typeof ROLES)[number];

/** `success`: executed. `refused`: executed and the contract panicked (the failed transaction is on chain).
 *  `protocol-rejected`: the node refused it before inclusion, so no transaction exists. */
export type Outcome = "success" | "refused" | "protocol-rejected";

export interface TxRecord {
  readonly step: string;
  /** Null for `protocol-rejected`: the node refused it, so nothing was included. */
  readonly hash: string | null;
  readonly signer: string;
  readonly receiver: string;
  readonly what: string;
  readonly proves: string;
  readonly outcome: Outcome;
  /** The contract's panic text, or the protocol error name; null on success. */
  readonly detail: string | null;
  /** Free text the step wants kept with the transaction (the reasoning behind a decision, an amount). */
  readonly note: string | null;
  readonly at: string;
}

export interface DeploymentRecord {
  readonly schema: "chair-testnet-deployment/1";
  readonly network: "testnet";
  readonly rpc: string;
  readonly parent: TestnetAccount;
  readonly accounts: Readonly<Record<Role, TestnetAccount>>;
  readonly wasm: { readonly sha256: string; readonly codeHash: string; readonly bytes: number };
  readonly launch: {
    readonly supply: string;
    readonly epochMs: number;
    readonly impeachThresholdBps: number;
    readonly nominateBond: string;
  };
  /** Public keys of the two chair accounts' only keys, each a function-call key limited to `set_policy`. */
  readonly chairKeys: Readonly<Record<"chair" | "challenger", string>>;
  /** Epoch 0 of the scripted run (set when it starts); null before. */
  scenarioBaseEpoch: number | null;
  transactions: TxRecord[];
}

export function loadRecord(path: string): DeploymentRecord {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || (parsed as { schema?: unknown }).schema !== "chair-testnet-deployment/1") {
    throw new Error(`${path} is not a chair-testnet-deployment/1 record`);
  }
  return parsed as DeploymentRecord;
}

/** Atomic (temp file, then rename) so a crash never leaves half a record. */
export function saveRecord(path: string, record: DeploymentRecord): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, path);
}

export function recordedStep(record: DeploymentRecord, step: string): TxRecord | undefined {
  return record.transactions.find((t) => t.step === step);
}
