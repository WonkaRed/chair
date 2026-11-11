// One recorded transaction at a time. `Run.step` signs and sends a transaction, checks that it did what the step
// says it must (succeed, be refused by the contract with a given panic, or be refused by the protocol), appends it to
// the deployment record on disk, and prints one line. A step already in the record is skipped, which is what makes a
// rerun resume instead of repeat.

import { Account, type Action } from "near-api-js";
import type { TestnetAccount } from "./guard.ts";
import { parseOutcome, type TxOutcome } from "./outcome.ts";
import { recordedStep, saveRecord, type DeploymentRecord, type Outcome, type TxRecord } from "./record.ts";
import { Rpc } from "./rpc.ts";
import type { KeyStore } from "./keys.ts";

export type Expect =
  | { readonly kind: "success" }
  /** The contract must panic with a message containing `text`. */
  | { readonly kind: "panic"; readonly text: string }
  /** The node must refuse the transaction before inclusion with an error containing `name`. */
  | { readonly kind: "protocol"; readonly name: string };

export interface StepSpec {
  readonly id: string;
  readonly signer: TestnetAccount;
  readonly receiver: TestnetAccount;
  readonly actions: Action[];
  readonly what: string;
  readonly proves: string;
  readonly expect: Expect;
  readonly note?: string;
}

export class StepError extends Error {
  constructor(step: string, message: string) {
    super(`step ${step}: ${message}`);
    this.name = "StepError";
  }
}

export class Run {
  readonly rpc: Rpc;
  readonly keys: KeyStore;
  readonly record: DeploymentRecord;
  readonly say: (line: string) => void;
  private readonly recordPath: string;
  private readonly accounts = new Map<TestnetAccount, Account>();
  constructor(rpc: Rpc, keys: KeyStore, record: DeploymentRecord, recordPath: string, say: (line: string) => void) {
    this.rpc = rpc;
    this.keys = keys;
    this.record = record;
    this.recordPath = recordPath;
    this.say = say;
  }

  private account(id: TestnetAccount): Account {
    let account = this.accounts.get(id);
    if (account === undefined) {
      account = new Account(id, this.rpc.url, this.keys.signer(id));
      this.accounts.set(id, account);
    }
    return account;
  }

  /** The recorded outcome of `id` was already produced by an earlier run: nothing is sent and null is returned. */
  async step(spec: StepSpec): Promise<TxOutcome | null> {
    if (recordedStep(this.record, spec.id) !== undefined) {
      this.say(`  [${spec.id}] already recorded, skipped`);
      return null;
    }
    let outcome: TxOutcome | null = null;
    let kind: Outcome;
    let detail: string | null = null;
    try {
      outcome = parseOutcome(
        await this.account(spec.signer).signAndSendTransaction({ receiverId: spec.receiver, actions: spec.actions, waitUntil: "FINAL", throwOnFailure: false }),
      );
      kind = outcome.failure === null ? "success" : "refused";
      detail = outcome.failure;
    } catch (e) {
      // Only a protocol-level refusal is an expected throw; anything else (network, key, nonce) is a real failure.
      const text = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (spec.expect.kind !== "protocol" || !text.includes(spec.expect.name)) throw new StepError(spec.id, `transaction could not be sent: ${text.slice(0, 300)}`);
      kind = "protocol-rejected";
      detail = spec.expect.name;
    }
    const expected = spec.expect.kind === "success" ? "success" : spec.expect.kind === "panic" ? "refused" : "protocol-rejected";
    if (kind !== expected || (spec.expect.kind === "panic" && !(detail ?? "").includes(spec.expect.text))) {
      // Not recorded, so a rerun tries the step again; the transaction (if any) stays on chain, named here.
      throw new StepError(spec.id, `expected ${expected}${spec.expect.kind === "panic" ? ` "${spec.expect.text}"` : ""}, got ${kind}${detail === null ? "" : ` "${detail}"`}${outcome === null ? "" : ` (tx ${outcome.hash})`}`);
    }
    this.append(spec, outcome, kind, detail);
    this.say(`  [${spec.id}] ${kind === "success" ? "ok" : kind === "refused" ? `refused: ${detail}` : `refused by the protocol: ${detail}`}${outcome === null ? "" : `  tx ${outcome.hash}`}`);
    return outcome;
  }

  /** Writes the record to disk (for state that is not a transaction, like the scenario's base epoch). */
  save(): void {
    saveRecord(this.recordPath, this.record);
  }

  private append(spec: StepSpec, outcome: TxOutcome | null, kind: Outcome, detail: string | null): void {
    const tx: TxRecord = {
      step: spec.id,
      hash: outcome?.hash ?? null,
      signer: spec.signer,
      receiver: spec.receiver,
      what: spec.what,
      proves: spec.proves,
      outcome: kind,
      detail,
      note: spec.note ?? null,
      at: new Date().toISOString(),
    };
    this.record.transactions.push(tx);
    this.save();
  }
}
