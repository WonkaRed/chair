// The only contract calls this bot can make, as data. `HolderAction` has four members and `toCall` is exhaustive over
// them, so there is no way to ask it for `nominate`, `back`, `unback`, `withdraw_nomination` or `set_policy`: holders
// of this bot never touch governance (the chair, its policy and its votes belong to the live demo).

import type { HolderAction } from "./plan.ts";

export const METHODS = ["ft_transfer", "stake", "unstake", "claim"] as const;
export type Method = (typeof METHODS)[number];

export const ONE_YOCTO = 1n;
/**
 * Attached to every `stake`: the first stake of an account pays for its stake record (about 0.001 NEAR of storage), and
 * the contract refunds everything above 1 yocto plus that cost, so a later stake gets back all but 1 yocto.
 */
export const STAKE_DEPOSIT = 10n ** 22n;

export interface Call {
  readonly method: Method;
  readonly args: Record<string, string>;
  readonly deposit: bigint;
}

export function toCall(action: HolderAction): Call {
  switch (action.kind) {
    case "transfer":
      return { method: "ft_transfer", args: { receiver_id: action.to, amount: action.amount.toString() }, deposit: ONE_YOCTO };
    case "stake":
      return { method: "stake", args: { amount: action.amount.toString() }, deposit: STAKE_DEPOSIT };
    case "unstake":
      return { method: "unstake", args: { amount: action.amount.toString() }, deposit: ONE_YOCTO };
    case "claim":
      return { method: "claim", args: {}, deposit: ONE_YOCTO };
  }
}
