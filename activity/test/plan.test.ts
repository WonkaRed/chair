import assert from "node:assert/strict";
import { test } from "node:test";
import { METHODS, toCall } from "../src/calls.ts";
import { BAND_HIGH_BPS, BAND_LOW_BPS, TOKEN, planEpoch, signerOf, type HolderAction, type HolderState, type World } from "../src/plan.ts";
import { IDS, applyAction, applyPlan, holder } from "./fakes.ts";

function worldOf(holders: HolderState[], supplyTokens: number, epoch = 10): World {
  const staked = holders.reduce((a, h) => a + h.staked, 0n);
  return { epoch, rateBps: -60, totalSupply: BigInt(supplyTokens) * TOKEN, totalStaked: staked, holders };
}

const live = (): World => worldOf([holder(IDS[0], 500_000, 300_000), holder(IDS[1], 0, 100_000, 40_000), holder(IDS[2], 100_000, 0)], 1_100_000);
const shareBps = (w: World): bigint => (w.totalStaked * 10_000n) / w.totalSupply;

/** Runs the plan for `epochs` epochs, handing every plan and the world it was made from to `check`. */
function simulate(start: World, seed: string, epochs: number, check: (plan: HolderAction[], before: World, after: World) => void): World {
  let world = start;
  for (let i = 0; i < epochs; i++) {
    const plan = planEpoch(seed, world);
    const next = applyPlan(world, plan);
    check(plan, world, next);
    world = next;
  }
  return world;
}

test("the plan is a pure function of the seed and the state: same in, same out; another seed or epoch, another plan", () => {
  const world = live();
  assert.deepEqual(planEpoch("s", world), planEpoch("s", world));
  const plans = (seed: string, from: number): string =>
    JSON.stringify(Array.from({ length: 20 }, (_, i) => planEpoch(seed, { ...world, epoch: from + i })), (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  assert.notEqual(plans("s", 10), plans("t", 10));
  assert.notEqual(plans("s", 10), plans("s", 11));
  assert.equal(plans("s", 10), plans("s", 10));
});

test("every holder takes one or two actions, never two of a kind, only among the three accounts", () => {
  const ids = new Set<string>(IDS);
  let two = 0;
  simulate(live(), "kinds", 300, (plan) => {
    for (const id of IDS) {
      const mine = plan.filter((a) => signerOf(a) === id);
      assert.ok(mine.length <= 2);
      const families = mine.map((a) => (a.kind === "unstake" ? "stake" : a.kind));
      assert.equal(new Set(families).size, families.length);
      if (mine.length === 2) two++;
    }
    for (const a of plan) {
      assert.ok(ids.has(signerOf(a)));
      if (a.kind === "transfer") assert.ok(ids.has(a.to) && a.to !== a.from);
    }
  });
  assert.ok(two > 0, "some holders take a second action");
});

test("the staked share stays in the band, whatever the seed and wherever it starts inside it", () => {
  for (const seed of ["a", "b", "c", "d"]) {
    for (const staked of [250_000, 500_000, 590_000]) {
      const start = worldOf([holder(IDS[0], 400_000, staked), holder(IDS[1], 150_000, 0), holder(IDS[2], 50_000, 0, 5_000)], 600_000 + staked);
      simulate(start, seed, 400, (_p, _b, after) => {
        assert.ok(shareBps(after) >= BAND_LOW_BPS && shareBps(after) <= BAND_HIGH_BPS, `share ${shareBps(after)} bps`);
      });
    }
  }
});

test("outside the band the plan only moves toward it (and so never leaves again), and the share does move inside it", () => {
  const above = worldOf([holder(IDS[0], 100_000, 900_000), holder(IDS[1], 50_000, 0), holder(IDS[2], 50_000, 0)], 1_100_000);
  simulate(above, "hi", 80, (_p, before, after) => {
    if (shareBps(before) > BAND_HIGH_BPS) assert.ok(shareBps(after) <= shareBps(before));
    else assert.ok(shareBps(after) >= BAND_LOW_BPS && shareBps(after) <= BAND_HIGH_BPS);
  });
  const below = worldOf([holder(IDS[0], 1_000_000, 0), holder(IDS[1], 50_000, 0), holder(IDS[2], 50_000, 0)], 1_100_000);
  simulate(below, "lo", 80, (_p, before, after) => {
    if (shareBps(before) < BAND_LOW_BPS) assert.ok(shareBps(after) >= shareBps(before));
    else assert.ok(shareBps(after) >= BAND_LOW_BPS && shareBps(after) <= BAND_HIGH_BPS);
  });

  const seen: bigint[] = [];
  simulate(live(), "walk", 200, (_p, _b, after) => seen.push(shareBps(after)));
  assert.ok(Math.max(...seen.map(Number)) - Math.min(...seen.map(Number)) >= 1_000, "the share ranges over at least ten points");
  assert.ok(new Set(seen).size > 50, "and changes most epochs");
});

test("no account can be drained: whole tokens, at most 5% of the liquid balance moved, 10% staked or unstaked", () => {
  simulate(live(), "drain", 1_000, (plan, before, after) => {
    let world = before;
    for (const a of plan) {
      if (a.kind !== "claim") {
        assert.equal(a.amount % TOKEN, 0n);
        assert.ok(a.amount >= TOKEN);
        const h = world.holders.find((x) => x.id === signerOf(a)) as HolderState;
        if (a.kind === "unstake") assert.ok(a.amount * 10n <= h.staked);
        else assert.ok(a.amount * (a.kind === "transfer" ? 20n : 10n) <= h.liquid);
      }
      world = applyAction(world, a);
    }
    for (const h of after.holders) assert.ok(h.liquid + h.staked > 0n);
  });
});

test("a stake is never unstaked inside its lock, and a claim needs a reward to claim", () => {
  let unstakes = 0;
  let claims = 0;
  simulate(live(), "lock", 600, (plan, before) => {
    const byId = new Map(before.holders.map((h) => [h.id, h]));
    for (const a of plan) {
      const h = byId.get(signerOf(a)) as HolderState;
      if (a.kind === "unstake") {
        unstakes++;
        assert.ok(h.unlockEpoch <= before.epoch, `unlock ${h.unlockEpoch} at epoch ${before.epoch}`);
      }
      if (a.kind === "claim") {
        claims++;
        assert.ok(h.pending >= TOKEN);
      }
    }
  });
  assert.ok(unstakes > 0 && claims > 0);
});

test("a world with nothing to move plans nothing", () => {
  assert.deepEqual(planEpoch("s", worldOf([holder(IDS[0], 0, 0), holder(IDS[1], 0, 0), holder(IDS[2], 5, 0)], 100)), []);
  assert.deepEqual(planEpoch("s", { ...live(), totalSupply: 0n }), []);
});

test("holders never nominate, back, unback, withdraw a nomination or set a policy: the only methods are the four token calls", () => {
  const methods = new Set<string>();
  for (const seed of ["g1", "g2", "g3"]) {
    simulate(live(), seed, 300, (plan) => {
      for (const a of plan) methods.add(toCall(a).method);
    });
  }
  assert.deepEqual([...methods].sort(), [...METHODS].sort());
  for (const m of methods) assert.doesNotMatch(m, /nominate|back|withdraw|policy/);
});
