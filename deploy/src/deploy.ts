// Setup: a parent account from the public testnet faucet, then every account of the deployment as a sub-account
// of it, the token last.
//
// The token account is created, funded, given the contract and initialised in ONE transaction that adds no access
// key: it never has a key, so nothing can ever redeploy it or move its NEAR (SPEC.md "No admin, no owner"). The two
// chair accounts are created with their one function-call key (receiver: the token, methods: `set_policy` only) in
// the creating transaction, so they never hold a full-access key either. Only the three holders and the parent do.

import { createHash } from "node:crypto";
import { actions, baseEncode, PublicKey, type Action } from "near-api-js";
import { subAccount, type TestnetAccount } from "./guard.ts";
import type { KeyStore } from "./keys.ts";
import type { DeploymentRecord, Role } from "./record.ts";
import type { Run } from "./run.ts";
import type { Rpc } from "./rpc.ts";

export const FAUCET_URL = "https://helper.nearprotocol.com/account";
export const NEAR = 10n ** 24n;
/** One whole $CHAIR: the token has 24 decimals. */
export const TOKEN = 10n ** 24n;
const BYTE_COST = 10n ** 19n;

/** Launch parameters. The epoch is minutes, not days, so several epochs happen in an evening; a mainnet launch would use a longer one. */
export const LAUNCH = {
  supply: 1_000_000n * TOKEN,
  epochMs: 90_000,
  impeachThresholdBps: 3_000,
  nominateBond: NEAR / 10n,
} as const;

/** NEAR given to each non-token account at creation. */
const FUNDING: Readonly<Record<Exclude<Role, "token">, bigint>> = {
  chair: (NEAR * 3n) / 10n,
  challenger: (NEAR * 3n) / 10n,
  alice: (NEAR * 3n) / 2n,
  bob: NEAR / 2n,
  carol: NEAR / 2n,
};

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The code hash as the RPC reports it: the base58 form of the wasm's SHA-256. */
export function codeHashOf(wasm: Uint8Array): string {
  return baseEncode(createHash("sha256").update(wasm).digest());
}

export function accountsOf(parent: TestnetAccount): Record<Role, TestnetAccount> {
  return {
    token: subAccount("token", parent),
    chair: subAccount("chair", parent),
    challenger: subAccount("challenger", parent),
    alice: subAccount("alice", parent),
    bob: subAccount("bob", parent),
    carol: subAccount("carol", parent),
  };
}

/** The faucet pays for a new top-level account (10 NEAR) that the given key controls. */
export async function createParent(rpc: Rpc, keys: KeyStore, parent: TestnetAccount, say: (line: string) => void): Promise<void> {
  if ((await rpc.account(parent)) !== null) {
    say(`${parent} already exists`);
    return;
  }
  const publicKey = keys.has(parent) ? await keys.publicKey(parent) : keys.create(parent);
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ newAccountId: parent, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`the faucet answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  for (let i = 0; i < 20; i++) {
    if ((await rpc.account(parent)) !== null) {
      say(`the faucet created ${parent}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`the faucet accepted the request but ${parent} did not appear on chain`);
}

/** A fresh record for a new deployment: keys for the chair accounts are made here, so the record can name them. */
export async function newRecord(rpcUrl: string, keys: KeyStore, parent: TestnetAccount, wasm: Uint8Array): Promise<DeploymentRecord> {
  const accounts = accountsOf(parent);
  const publicKeyOf = async (a: TestnetAccount): Promise<string> => (keys.has(a) ? keys.publicKey(a) : keys.create(a));
  for (const role of ["alice", "bob", "carol"] as const) await publicKeyOf(accounts[role]);
  return {
    schema: "chair-testnet-deployment/1",
    network: "testnet",
    rpc: rpcUrl,
    parent,
    accounts,
    wasm: { sha256: sha256Hex(wasm), codeHash: codeHashOf(wasm), bytes: wasm.length },
    launch: { supply: LAUNCH.supply.toString(), epochMs: LAUNCH.epochMs, impeachThresholdBps: LAUNCH.impeachThresholdBps, nominateBond: LAUNCH.nominateBond.toString() },
    chairKeys: { chair: await publicKeyOf(accounts.chair), challenger: await publicKeyOf(accounts.challenger) },
    scenarioBaseEpoch: null,
    transactions: [],
  };
}

/** Creates every account and launches the token. Each creation is one recorded step; an account that already
 *  exists on chain without its step in the record is an error (we cannot know what created it). */
export async function deployAll(run: Run, wasm: Uint8Array): Promise<void> {
  const { record, rpc, keys } = run;
  const { parent, accounts } = record;
  const create = async (role: Role, what: string, proves: string, rest: Action[], funding: bigint) => {
    const id = accounts[role];
    const recorded = record.transactions.some((t) => t.step === `create-${role}`);
    if (!recorded && (await rpc.account(id)) !== null) throw new Error(`${id} exists on chain but its creation is not in the record: use a new parent account`);
    await run.step({
      id: `create-${role}`,
      signer: parent,
      receiver: id,
      actions: [actions.createAccount(), actions.transfer(funding), ...rest],
      what,
      proves,
      expect: { kind: "success" },
    });
  };

  for (const role of ["alice", "bob", "carol"] as const) {
    const key = PublicKey.from(await keys.publicKey(accounts[role]));
    await create(role, `create ${accounts[role]} with ${fmtNear(FUNDING[role])} NEAR and one full-access key (a holder)`, "an ordinary holder account exists", [actions.addFullAccessKey(key)], FUNDING[role]);
  }
  for (const role of ["chair", "challenger"] as const) {
    const key = PublicKey.from(record.chairKeys[role]);
    await create(
      role,
      `create ${accounts[role]} with ${fmtNear(FUNDING[role])} NEAR and ONE key: function-call, receiver ${accounts.token}, methods [set_policy], unlimited gas allowance`,
      "the chair account is born holding no full-access key: it can call set_policy and nothing else",
      [actions.addFunctionCallAccessKey(key, accounts.token, ["set_policy"], undefined)],
      FUNDING[role],
    );
  }

  const funding = BigInt(wasm.length) * BYTE_COST + NEAR;
  await create(
    "token",
    `create ${accounts.token} with ${fmtNear(funding)} NEAR, deploy the contract and call new({epoch_ms: ${LAUNCH.epochMs}, ...}) in the same transaction, adding no access key`,
    "the token account never had an access key, so nobody can redeploy it, add a key or move its NEAR",
    [
      actions.deployContract(wasm),
      actions.functionCall(
        "new",
        {
          owner_id: accounts.alice,
          total_supply: LAUNCH.supply.toString(),
          chair: accounts.chair,
          epoch_ms: LAUNCH.epochMs,
          impeach_threshold_bps: LAUNCH.impeachThresholdBps,
          nominate_bond: LAUNCH.nominateBond.toString(),
        },
        100_000_000_000_000n,
        0n,
      ),
    ],
    funding,
  );
}

export function fmtNear(yocto: bigint): string {
  const whole = yocto / NEAR;
  const frac = (yocto % NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}
