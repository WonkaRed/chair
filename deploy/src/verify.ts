// `verify`: re-check a deployment from public views alone, with no key. `gather` reads the chain; `evaluate` is a pure
// function from what was read and the record to a list of checks, so every rule below is testable without a network.

import { createHash } from "node:crypto";
import { baseEncode } from "near-api-js";
import type { DeploymentRecord, Role } from "./record.ts";
import { gatherMinutes, type Minutes } from "./minutes.ts";
import type { AccessKey, Rpc } from "./rpc.ts";
import { TokenViews, type Params, type Policy, type Supply } from "./views.ts";

export interface Snapshot {
  /** The token account's code hash as `view_account` reports it, and the SHA-256 of the bytes `view_code` returns. */
  readonly tokenCodeHash: string | null;
  readonly tokenCodeSha256: string | null;
  readonly keys: Readonly<Record<Role, readonly AccessKey[]>>;
  readonly params: Params;
  readonly supply: Supply;
  readonly totalSupplyView: bigint;
  readonly policy: Policy;
  /** `ft_balance_of` plus stake for every recorded account. */
  readonly recordedHoldings: bigint;
  /** The chair's decisions from the chain's events, with the recorded reasoning text matched to each hash. */
  readonly minutes: Minutes;
}

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** `docsDir`: the folder whose `testnet-run-agent-*` files record the chair's reasoning texts. */
export async function gather(rpc: Rpc, record: DeploymentRecord, docsDir: string): Promise<Snapshot> {
  const token = record.accounts.token;
  const views = new TokenViews(rpc, token);
  const info = await rpc.account(token);
  const code = info === null || info.codeHash === "11111111111111111111111111111111" ? null : await rpc.code(token);
  const entries = await Promise.all(Object.entries(record.accounts).map(async ([role, id]) => [role, await rpc.accessKeys(id)] as const));
  let held = 0n;
  for (const [role, id] of Object.entries(record.accounts)) {
    if (role === "token") continue;
    held += (await views.balance(id)) + (await views.staking(id)).staked;
  }
  return {
    tokenCodeHash: info?.codeHash ?? null,
    tokenCodeSha256: code === null ? null : createHash("sha256").update(code).digest("hex"),
    keys: Object.fromEntries(entries) as Record<Role, AccessKey[]>,
    params: await views.params(),
    supply: await views.supply(),
    totalSupplyView: await views.totalSupply(),
    policy: await views.policy(),
    recordedHoldings: held,
    minutes: await gatherMinutes(rpc.url, token, docsDir),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** `wasmSha256`: the SHA-256 of a locally built wasm, when the caller has one to compare. */
export function evaluate(record: DeploymentRecord, s: Snapshot, wasmSha256?: string): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });

  const onChainHex = s.tokenCodeSha256;
  check(
    "code hash on chain equals the recorded wasm",
    s.tokenCodeHash === record.wasm.codeHash && onChainHex === record.wasm.sha256,
    `chain ${s.tokenCodeHash ?? "no account"} (sha256 ${onChainHex ?? "none"}); record ${record.wasm.codeHash} (sha256 ${record.wasm.sha256})`,
  );
  check(
    "the reported code hash is the hash of the code the node serves",
    onChainHex !== null && s.tokenCodeHash === baseEncode(Buffer.from(onChainHex, "hex")),
    "view_account code_hash (base58) against sha256 of view_code",
  );
  if (wasmSha256 !== undefined) check("code hash on chain equals the local wasm", wasmSha256 === onChainHex, `local ${wasmSha256}; chain ${onChainHex ?? "none"}`);

  check("the token account holds no access key at all", s.keys.token.length === 0, `${s.keys.token.length} keys`);
  for (const role of ["chair", "challenger"] as const) {
    const keys = s.keys[role];
    const only = keys[0];
    const scoped =
      keys.length === 1 &&
      only !== undefined &&
      only.publicKey === record.chairKeys[role] &&
      only.permission !== "FullAccess" &&
      only.permission.receiverId === record.accounts.token &&
      sameList(only.permission.methodNames, ["set_policy"]) &&
      only.permission.allowance === null;
    check(
      `${role} holds only a function-call key limited to set_policy on the token`,
      scoped,
      keys.map((k) => `${k.publicKey} ${k.permission === "FullAccess" ? "FULL ACCESS" : `${k.permission.receiverId}.[${k.permission.methodNames.join(",")}]`}`).join("; ") || "no keys",
    );
  }

  const p = s.params;
  check(
    "hard bounds: rate within +-200 bps, step at most 50 bps, backing over 5% of the supply to seat a chair",
    p.maxRateBps === 200 && p.maxStepBps === 50 && p.quorumBps === 500,
    `max_rate_bps ${p.maxRateBps}, max_step_bps ${p.maxStepBps}, quorum_bps ${p.quorumBps}`,
  );
  check(
    "launch parameters are the recorded ones",
    p.epochMs === record.launch.epochMs && p.impeachThresholdBps === record.launch.impeachThresholdBps && p.nominateBond.toString() === record.launch.nominateBond,
    `epoch_ms ${p.epochMs}, impeach_threshold_bps ${p.impeachThresholdBps}, nominate_bond ${p.nominateBond}`,
  );

  const u = s.supply;
  check("launch supply is the recorded one", u.launch.toString() === record.launch.supply, `${u.launch}`);
  check("total supply = launch + minted - burned", u.total === u.launch + u.minted - u.burned, `${u.total} = ${u.launch} + ${u.minted} - ${u.burned}`);
  check("ft_total_supply equals get_supply.total_supply", s.totalSupplyView === u.total, `${s.totalSupplyView}`);
  check(
    "recorded accounts' balances and stake never exceed the supply",
    s.recordedHoldings + u.rewardPool <= u.total,
    `recorded accounts hold ${s.recordedHoldings}, unclaimed rewards ${u.rewardPool}, supply ${u.total} (the rest is in accounts not in the record)`,
  );

  // An unreadable transaction index (a third party, unlike the RPC) skips this check and `describeMinutes` says so; it never fails the
  // deployment. A recorded text that does not hash to its own hash is wrong whether or not the index is up, so that still fails.
  const m = s.minutes;
  if (m.error === null || m.warnings.length > 0) {
    const recorded = m.decisions.filter((d) => d.verdict !== null).length;
    const verified = m.decisions.filter((d) => d.verdict === "verified").length;
    const docsProblems = m.warnings.length > 0 ? `docs/ problems: ${m.warnings.join("; ")}` : "";
    check(
      "each recorded reasoning text hashes (SHA-256) to the reasoning_hash the chain holds",
      m.warnings.length === 0 && verified === recorded,
      m.error === null
        ? `${recorded} of ${m.decisions.length} decisions on chain have a text recorded in docs/, ${verified} of them match${docsProblems === "" ? "" : `; ${docsProblems}`}`
        : `${docsProblems}; the decisions on chain could not be read, so no text was compared with the chain`,
    );
  }

  return checks;
}

/** Where the token stands now: information, not a check (the chair can legitimately change by vote). */
export function describeState(s: Snapshot): string {
  const { policy: p, supply: u } = s;
  return `epoch ${p.epoch}: rate ${p.rateBps} bps, chair ${p.chair}, streak ${p.streak}; supply ${u.total} (launch ${u.launch}, minted ${u.minted}, burned ${u.burned}), staked ${u.staked}`;
}
