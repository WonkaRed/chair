import assert from "node:assert/strict";
import { test } from "node:test";
import { runBot, type Stop } from "../src/bot.ts";
import { NEAR_FLOOR } from "../src/budget.ts";
import { METHODS, toCall } from "../src/calls.ts";
import { TOKEN, type World } from "../src/plan.ts";
import { EPOCH_MS, FakeChain, FakeClock, IDS, MemoryLog, holder, type FakeChainOptions } from "./fakes.ts";

const START = 10 * EPOCH_MS + 1_000;
const HOUR = 3_600_000;
const NEAR = 10n ** 24n;

const world = (): World => ({
  epoch: 10,
  rateBps: -60,
  totalSupply: 1_100_000n * TOKEN,
  totalStaked: 400_000n * TOKEN,
  holders: [holder(IDS[0], 500_000, 300_000, 30_000), holder(IDS[1], 0, 100_000, 10_000), holder(IDS[2], 100_000, 0)],
});

function setup(options: FakeChainOptions = {}, every = 1, seed = "test") {
  const clock = new FakeClock(START);
  const chain = new FakeChain(clock, world(), options);
  const log = new MemoryLog(clock);
  const abort = new AbortController();
  const start = { fields: { token: "token.t.testnet" }, text: "token.t.testnet" };
  const run = (maxEpochs: number | null): Promise<Stop> => runBot(chain, clock, log, { seed, every, maxEpochs, start }, abort.signal);
  return { clock, chain, log, abort, run };
}

test("it acts once in each epoch, on the epoch change read from the chain, and never twice in one", async () => {
  const { clock, chain, log, run } = setup();
  assert.equal(await run(4), "done");
  assert.deepEqual([...new Set(chain.sent.map((s) => s.epoch))], [10, 11, 12, 13]);
  assert.deepEqual(log.events("epoch").map((e) => e.fields["epoch"]), [10, 11, 12, 13]);
  assert.ok(chain.sent.length >= 4 * 3, "each of the three holders acts every epoch");
  assert.ok(clock.time < START + 4 * EPOCH_MS, "it waited for the boundaries, not for a fixed interval");
  assert.ok(clock.sleeps.every((ms) => ms <= 32_000), "it never sleeps long without looking at the chain");
});

test("an epoch that was missed is logged and skipped, not replayed", async () => {
  const { log, run } = setup({ sendMs: 40_000 });
  await run(4);
  const epochs = log.events("epoch").map((e) => e.fields["epoch"] as number);
  assert.ok(epochs.every((e, i) => i === 0 || e > (epochs[i - 1] as number)));
  const missed = log.events("epoch").reduce((n, e) => n + (e.fields["missedActingEpochs"] as number), 0);
  assert.equal(missed, (epochs.at(-1) as number) - 10 - (epochs.length - 1));
  assert.ok(missed > 0);
});

test("one call that fails is logged and the next one goes ahead", async () => {
  const { chain, log, run } = setup();
  chain.sendHook = (_a, i) => {
    if (i === 0) throw new Error("connection reset");
    return i === 1 ? "The account doesn't have enough balance" : undefined;
  };
  assert.equal(await run(2), "done");
  const actions = log.events("action");
  assert.deepEqual(actions.slice(0, 3).map((e) => e.fields["outcome"]), ["error", "refused", "success"]);
  assert.equal(actions[0]?.fields["hash"], null);
  assert.equal(actions[1]?.fields["failure"], "The account doesn't have enough balance");
  assert.equal(actions[2]?.fields["hash"], "hash2");
  assert.deepEqual([...new Set(chain.sent.map((s) => s.epoch))], [10, 11], "the next epoch is acted in as usual");
});

test("a failed read backs off with doubling waits, then carries on where it was", async () => {
  const { clock, chain, log, run } = setup();
  chain.readFailures = 3;
  assert.equal(await run(1), "done");
  assert.deepEqual(clock.sleeps.slice(0, 3), [5_000, 10_000, 20_000]);
  assert.equal(log.events("read_error").length, 3);
  assert.ok(chain.sent.length > 0);
});

test("the backoff is capped at five minutes, and a good read resets it", async () => {
  const capped = setup();
  capped.chain.readFailures = 9;
  await capped.run(1);
  assert.deepEqual(capped.clock.sleeps.slice(0, 9), [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);

  const { clock, chain, log, run } = setup();
  chain.readFailures = 2;
  let failedAgain = false;
  clock.onSleep = () => {
    if (!failedAgain && log.events("epoch").length > 0) {
      failedAgain = true;
      chain.readFailures = 1;
    }
  };
  await run(2);
  // Two failed reads, the wait for the next epoch (the boundary is 89 s away: 30 s look-again cap plus 2 s settling), a third failure that backs off from the start.
  assert.deepEqual(clock.sleeps.slice(0, 4), [5_000, 10_000, 32_000, 5_000]);
});

test("a holder under the NEAR floor at the start stops the bot before it sends anything, naming the account", async () => {
  const { chain, log, run } = setup();
  chain.nearOf.set(IDS[1], NEAR_FLOOR - 1n);
  assert.equal(await run(null), "floor");
  assert.equal(chain.sent.length, 0);
  const [floor] = log.events("floor");
  assert.equal(floor?.fields["account"], IDS[1]);
  assert.match(floor?.message ?? "", /below the floor of 0\.05000 NEAR/);
  assert.equal(log.events("stopped").length, 1);
});

test("NEAR is read at the start and then every hour, and the bot stops at the first hourly read that finds a holder short", async () => {
  const { chain, log, run } = setup({ near: 0.3, gasPerSend: NEAR / 100n });
  assert.equal(await run(null), "floor");
  const reads = log.entries.filter((e) => e.fields["event"] === "start" || e.fields["event"] === "near_balances");
  assert.equal(reads[0]?.fields["event"], "start");
  assert.equal(reads[0]?.at, START);
  assert.ok(reads.slice(1).every((r, i) => r.at - (reads[i]?.at ?? 0) >= HOUR));
  assert.ok([...chain.nearOf.values()].some((v) => v < NEAR_FLOOR));
  const [floor] = log.events("floor");
  assert.ok((floor?.at ?? 0) >= START + HOUR, "it kept going until the hourly read, even though a holder fell under the floor in between");
  assert.equal(log.events("floor").length, 1);
});

test("a stop signal ends the loop with a stopped record", async () => {
  const { clock, chain, log, abort, run } = setup();
  clock.onSleep = () => {
    if (clock.time > START + 3 * EPOCH_MS) abort.abort();
  };
  assert.equal(await run(null), "signal");
  assert.equal(log.events("stopped")[0]?.fields["reason"], "signal");
  assert.ok(chain.sent.length > 0);
});

test("holders never govern: every method the loop sends is one of the four token calls", async () => {
  const { chain, run } = setup();
  await run(20);
  assert.ok(chain.sent.length > 0);
  for (const { action } of chain.sent) assert.ok((METHODS as readonly string[]).includes(toCall(action).method));
});

test("with every=6 it acts only in the epochs that are multiples of 6 and logs nothing for the others", async () => {
  const { chain, log, run } = setup({}, 6);
  assert.equal(await run(3), "done");
  assert.deepEqual([...new Set(chain.sent.map((s) => s.epoch))], [12, 18, 24]);
  assert.deepEqual(log.events("epoch").map((e) => e.fields["epoch"]), [12, 18, 24]);
  assert.ok(log.events("epoch").every((e) => e.fields["missedActingEpochs"] === 0));
  const kinds = new Set(log.entries.map((e) => e.fields["event"]));
  assert.deepEqual([...kinds].sort(), ["action", "epoch", "start", "stopped"]);
});

test("a round that outlasts the next acting epoch is logged as missed, and every acted epoch is still a multiple of N", async () => {
  const { log, run } = setup({ sendMs: 200_000 }, 6);
  await run(3);
  const epochs = log.events("epoch").map((e) => e.fields["epoch"] as number);
  assert.ok(epochs.every((e) => e % 6 === 0));
  assert.ok(log.events("epoch").reduce((n, e) => n + (e.fields["missedActingEpochs"] as number), 0) > 0);
});

test("the plan stays deterministic for a seed and N: the same run twice sends the same calls, another seed does not", async () => {
  const sentOf = async (every: number, seed: string): Promise<string> => {
    const { chain, run } = setup({}, every, seed);
    await run(3);
    return JSON.stringify(chain.sent, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
  };
  assert.equal(await sentOf(6, "x"), await sentOf(6, "x"));
  assert.notEqual(await sentOf(6, "x"), await sentOf(6, "y"));
});

test("the start line states N, the cost per day at N, and the days until the first holder reaches the floor", async () => {
  const { log, run } = setup({ near: 0.5 }, 6);
  await run(1);
  const [start] = log.events("start");
  assert.equal(start?.fields["everyEpochs"], 6);
  // 3 holders x 1.4 calls x 160 acting epochs a day x 0.00025 NEAR
  assert.ok(Math.abs((start?.fields["nearPerDay"] as number) - 0.168) < 1e-9);
  assert.ok(Math.abs((start?.fields["daysToFloor"] as Record<string, number>)[IDS[0]]! - 0.45 / 0.056) < 1e-9);
  assert.match(start?.message ?? "", /acting every 6th epoch, about 0\.168 NEAR a day for 3 holders/);
  assert.match(start?.message ?? "", /reaches the 0\.05000 NEAR floor first, in about 8\.0 days/);
});
