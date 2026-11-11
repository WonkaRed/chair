import assert from "node:assert/strict";
import { test } from "node:test";
import { ONE_YOCTO, STAKE_DEPOSIT, toCall } from "../src/calls.ts";
import { TOKEN } from "../src/plan.ts";

test("each action becomes the token call the contract expects, with the deposit it requires", () => {
  const amount = 7n * TOKEN;
  assert.deepEqual(toCall({ kind: "transfer", from: "a.testnet", to: "b.testnet", amount }), { method: "ft_transfer", args: { receiver_id: "b.testnet", amount: amount.toString() }, deposit: ONE_YOCTO });
  assert.deepEqual(toCall({ kind: "stake", account: "a.testnet", amount }), { method: "stake", args: { amount: amount.toString() }, deposit: STAKE_DEPOSIT });
  assert.deepEqual(toCall({ kind: "unstake", account: "a.testnet", amount }), { method: "unstake", args: { amount: amount.toString() }, deposit: ONE_YOCTO });
  assert.deepEqual(toCall({ kind: "claim", account: "a.testnet" }), { method: "claim", args: {}, deposit: ONE_YOCTO });
});
