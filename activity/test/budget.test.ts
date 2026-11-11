import assert from "node:assert/strict";
import { test } from "node:test";
import { NEAR_FLOOR, projectBudget } from "../src/budget.ts";

const NEAR = 10n ** 24n;
const near = (n: number): bigint => BigInt(Math.round(n * 1e5)) * (NEAR / 100_000n);
const close = (a: number, b: number): void => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("the cost per holder per day is 1.4 calls x epochs a day / N x 0.00025 NEAR", () => {
  const balances = new Map([["a.testnet", near(1)]]);
  close(projectBudget(balances, 1, 90_000).perHolderPerDay, 1.4 * 960 * 0.00025);
  close(projectBudget(balances, 6, 90_000).perHolderPerDay, 1.4 * 160 * 0.00025);
});

test("the days to the floor come from each balance above the floor, and the first holder is named", () => {
  const balances = new Map([["alice.testnet", near(1.5)], ["bob.testnet", near(0.5)], ["carol.testnet", near(0.6)]]);
  const b = projectBudget(balances, 6, 90_000);
  close(b.daysToFloor.get("bob.testnet") as number, 0.45 / 0.056);
  close(b.daysToFloor.get("alice.testnet") as number, 1.45 / 0.056);
  assert.equal(b.first.account, "bob.testnet");
  close(b.first.days, 0.45 / 0.056);
});

test("a holder at or under the floor has no days left", () => {
  const b = projectBudget(new Map([["a.testnet", NEAR_FLOOR - 1n], ["b.testnet", near(1)]]), 1, 90_000);
  assert.equal(b.first.days, 0);
  assert.equal(b.first.account, "a.testnet");
});
