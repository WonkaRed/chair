// The chain as the bot sees it: four reads and one write. `Chain` is the seam the tests replace; `NearChain` is the
// real thing, built from the deploy package's helpers (testnet-only guards, key store, RPC reads, token views and
// outcome parsing) so there is one implementation of each and nothing here handles a key itself.

import { Account, actions } from "near-api-js";
import type { TestnetAccount } from "../../deploy/src/guard.ts";
import type { KeyStore } from "../../deploy/src/keys.ts";
import { parseOutcome } from "../../deploy/src/outcome.ts";
import type { Rpc } from "../../deploy/src/rpc.ts";
import { TokenViews } from "../../deploy/src/views.ts";
import { toCall } from "./calls.ts";
import { signerOf, type HolderAction, type World } from "./plan.ts";

export interface EpochInfo {
  readonly epoch: number;
  readonly epochEndsMs: number;
}

/** What the node said about a sent transaction: its hash and the contract's refusal, or null when it succeeded. */
export interface Receipt {
  readonly hash: string;
  readonly failure: string | null;
}

export interface Chain {
  /** The epoch length in ms, fixed at launch. */
  epochMs(): Promise<number>;
  epoch(): Promise<EpochInfo>;
  world(): Promise<World>;
  /** Each holder's NEAR balance in yoctoNEAR (the gas budget). */
  nearBalances(): Promise<ReadonlyMap<string, bigint>>;
  /** Sends one holder action and waits for it to be final. Throws when the outcome is unknown. */
  send(action: HolderAction): Promise<Receipt>;
}

/** Far above the 5.3 Tgas of the heaviest rollover (SPEC.md "Transfer burn"): only the gas burnt is paid, the rest returns. */
const GAS = 30_000_000_000_000n;

export class NearChain implements Chain {
  private readonly rpc: Rpc;
  private readonly token: TestnetAccount;
  private readonly views: TokenViews;
  private readonly holders: readonly TestnetAccount[];
  private readonly accounts = new Map<string, Account>();

  /** Loads every holder's signer now, so a missing or readable-by-others key file stops the bot before it does anything. */
  constructor(rpc: Rpc, token: TestnetAccount, holders: readonly TestnetAccount[], keys: KeyStore) {
    this.rpc = rpc;
    this.token = token;
    this.views = new TokenViews(rpc, token);
    this.holders = holders;
    for (const id of holders) this.accounts.set(id, new Account(id, rpc.url, keys.signer(id)));
  }

  async epochMs(): Promise<number> {
    return (await this.views.params()).epochMs;
  }

  async epoch(): Promise<EpochInfo> {
    const policy = await this.views.policy();
    return { epoch: policy.epoch, epochEndsMs: policy.epochEndsMs };
  }

  async world(): Promise<World> {
    const policy = await this.views.policy();
    const supply = await this.views.supply();
    const holders = [];
    for (const id of this.holders) {
      const staking = await this.views.staking(id);
      holders.push({ id, liquid: await this.views.balance(id), staked: staking.staked, pending: staking.pendingReward, unlockEpoch: staking.unlockEpoch });
    }
    return { epoch: policy.epoch, rateBps: policy.rateBps, totalSupply: supply.total, totalStaked: supply.staked, holders };
  }

  async nearBalances(): Promise<ReadonlyMap<string, bigint>> {
    const balances = new Map<string, bigint>();
    for (const id of this.holders) {
      const info = await this.rpc.account(id);
      if (info === null) throw new Error(`holder account ${id} does not exist`);
      balances.set(id, info.amount);
    }
    return balances;
  }

  async send(action: HolderAction): Promise<Receipt> {
    const account = this.accounts.get(signerOf(action));
    if (account === undefined) throw new Error(`no signer loaded for ${signerOf(action)}`);
    const call = toCall(action);
    const raw = await account.signAndSendTransaction({
      receiverId: this.token,
      actions: [actions.functionCall(call.method, call.args, GAS, call.deposit)],
      waitUntil: "FINAL",
      throwOnFailure: false,
    });
    const outcome = parseOutcome(raw);
    return { hash: outcome.hash, failure: outcome.failure };
  }
}
