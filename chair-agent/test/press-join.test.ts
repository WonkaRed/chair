import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join as join_ } from "node:path";
import { test } from "node:test";
import type { PoolReader } from "../src/chain.js";
import { FakeChain } from "../src/fake-chain.js";
import { BOOK } from "../src/press-book.js";
import { DEFAULT_JOIN_LIMITS, Join, plan, type JoinLimits, type Move } from "../src/press-join.js";
import type { Reply } from "../src/press-overreach.js";
import { createPressServer, listen } from "../src/press-server.js";
import { PressStore } from "../src/press-store.js";
import type { PoolSender, SubmitResult } from "../src/signer.js";
import type { PoolView } from "../src/types.js";
import { tempDir } from "./helpers.js";

const L = { stepBps: DEFAULT_JOIN_LIMITS.stepBps, capSteps: DEFAULT_JOIN_LIMITS.capSteps };
const SUPPLY = 10n ** 30n;
const STEP = SUPPLY / 100n;
const CAP = 4n * STEP;

/** The pool account against the in-memory token: stake and unstake with the contract's checks (staking.rs), and the chain's views of them. */
class FakePool implements PoolReader, PoolSender {
  staked = 0n;
  liquid = 10n * STEP;
  unlockEpoch = 0;
  backing: string | null = null;
  readsFail = false;
  /** Runs once the call has gone out, before the pool is read again: the chain moves, or the node starts failing. */
  afterCall: (() => void) | null = null;
  refuse: string | null = null;
  readonly calls: string[] = [];
  constructor(readonly chain: FakeChain) {}

  async pool(): Promise<PoolView> {
    if (this.readsFail) throw new Error("rpc down");
    const snapshot = await this.chain.snapshot();
    return { snapshot, staked: this.staked, liquid: this.liquid, unlockEpoch: this.unlockEpoch, backing: this.backing };
  }

  private call(text: string, onBroadcast: () => void, apply: () => string | null): Promise<SubmitResult> {
    onBroadcast();
    this.calls.push(text);
    const failure = this.refuse ?? apply();
    this.afterCall?.();
    return Promise.resolve({ txHash: `tx-${this.calls.length}`, failure });
  }

  stake(amount: bigint, onBroadcast: () => void): Promise<SubmitResult> {
    return this.call(`stake ${amount}`, onBroadcast, () => {
      if (amount > this.liquid) return "The account doesn't have enough balance";
      this.liquid -= amount;
      this.staked += amount;
      this.chain.totalStaked += amount;
      this.unlockEpoch = this.chain.epoch + 2;
      return null;
    });
  }

  unstake(amount: bigint, onBroadcast: () => void): Promise<SubmitResult> {
    return this.call(`unstake ${amount}`, onBroadcast, () => {
      if (amount > this.staked) return "amount exceeds the staked balance";
      if (this.chain.epoch < this.unlockEpoch) return `stake is locked until epoch ${this.unlockEpoch}`;
      this.staked -= amount;
      this.liquid += amount;
      this.chain.totalStaked -= amount;
      return null;
    });
  }
}

interface Rig {
  chain: FakeChain;
  pool: FakePool;
  join: Join;
  logs: string[];
}

function rig(o: { limits?: Partial<JoinLimits>; staked?: bigint } = {}): Rig {
  const chain = new FakeChain({ chair: "chair.test", totalSupply: SUPPLY, totalStaked: 10n ** 29n });
  chain.advanceEpochs(5, 10_000);
  const pool = new FakePool(chain);
  if (o.staked !== undefined) {
    pool.staked = o.staked;
    pool.liquid -= o.staked;
    chain.totalStaked += o.staked;
  }
  const logs: string[] = [];
  const join = new Join({
    reader: pool,
    sender: pool,
    poolAccount: "pool.test",
    now: () => chain.nowMs,
    sleep: (ms) => (chain.advanceTo(chain.nowMs + ms), Promise.resolve()),
    limits: o.limits,
    log: (l) => logs.push(l),
  });
  return { chain, pool, join, logs };
}

const tick = (chain: FakeChain, epochs = 1): void => chain.advanceEpochs(epochs, 10_000);

// ---- plan: the cap and the direction come from the chain's numbers alone ----

function view(staked: bigint, o: { supply?: bigint; liquid?: bigint; unlockEpoch?: number; epoch?: number; backing?: string | null; staking?: boolean } = {}): PoolView {
  const chain = new FakeChain({ chair: "chair.test", totalSupply: o.supply ?? SUPPLY, totalStaked: staked });
  chain.advanceEpochs(o.epoch ?? 5, 10_000);
  const snapshot = { blockTimeMs: chain.nowMs, params: chain.params, policy: { epoch: chain.epoch, rateBps: 0, chair: "chair.test", streak: 0, lastSetEpoch: null, epochEndsMs: chain.params.startMs + (chain.epoch + 1) * chain.params.epochMs }, totalSupply: chain.totalSupply, staking: o.staking === false ? null : { totalStaked: staked, rewardPool: 0n } };
  return { snapshot, staked, liquid: o.liquid ?? 10n * STEP, unlockEpoch: o.unlockEpoch ?? 0, backing: o.backing ?? null };
}

const what = (m: Move): string => (m.kind === "go" ? m.direction : m.kind);

test("plan: a step is 1% of the supply, floored, and a stake is planned only while it leaves the pool within 4 steps", () => {
  for (const staked of [0n, STEP, 2n * STEP, 3n * STEP]) {
    const m = plan(view(staked), false, L);
    assert.deepEqual(m, { kind: "go", direction: "join", amount: STEP, descending: false }, `${staked}`);
  }
  const odd = plan(view(0n, { supply: 1_000_099n }), false, L);
  assert.deepEqual(odd.kind === "go" ? odd.amount : null, 10_000n, "floored");
  assert.deepEqual(plan(view(4n * STEP), false, L), { kind: "go", direction: "step_down", amount: STEP, descending: true }, "at the cap: step down, never over it");
  // One coin short of room for a whole step is already "full": the cap is never exceeded by a part-step.
  assert.equal(what(plan(view(3n * STEP + 1n), false, L)), "step_down");
});

test("plan: stepping down continues until the pool is empty, takes only what is left, and then flips to joining", () => {
  const down = (staked: bigint) => plan(view(staked), true, L);
  assert.deepEqual(down(2n * STEP), { kind: "go", direction: "step_down", amount: STEP, descending: true });
  assert.deepEqual(down(STEP / 3n), { kind: "go", direction: "step_down", amount: STEP / 3n, descending: true }, "the remainder, not a whole step");
  assert.deepEqual(down(0n), { kind: "go", direction: "join", amount: STEP, descending: false }, "empty: flips");
});

test("plan: a pool above its cap (the supply shrank) steps down; a pool without coins or with a locked stake is told so, with when it unlocks", () => {
  assert.equal(what(plan(view(6n * STEP), false, L)), "step_down");
  assert.deepEqual(plan(view(STEP, { liquid: STEP - 1n }), false, L), { kind: "dry", descending: false });
  const locked = plan(view(4n * STEP, { epoch: 5, unlockEpoch: 7 }), false, L);
  const v = view(4n * STEP, { epoch: 5, unlockEpoch: 7 });
  assert.deepEqual(locked, { kind: "locked", unlockAtMs: v.snapshot.policy.epochEndsMs + v.snapshot.params.epochMs, descending: true }, "epoch 7 opens one epoch after this one ends");
  assert.equal(what(plan(view(4n * STEP, { epoch: 7, unlockEpoch: 7 }), false, L)), "step_down", "unlocked in epoch 7");
});

test("plan refuses to plan from figures it cannot trust: no staking views, a zero step, a pool that backs a candidate", () => {
  assert.throws(() => plan(view(0n, { staking: false }), false, L), /no staking views/);
  assert.throws(() => plan(view(0n, { supply: 99n }), false, L), /zero coins/);
  assert.throws(() => plan(view(STEP, { backing: "challenger.test" }), false, L), /backs a candidate/);
});

// ---- the service ----

test("clicks join up to the cap, then step down to nothing, then join again; the cap holds on the chain after every click", async () => {
  const r = rig();
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await r.join.start(`10.0.0.${i}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    seen.push(String(res.body["status"]));
    assert.ok(r.pool.staked <= CAP, `after click ${i} the pool holds ${r.pool.staked}`);
    tick(r.chain, 2); // past the stake lock
  }
  assert.deepEqual(seen.slice(0, 9), ["joined", "joined", "joined", "joined", "stepped_down", "stepped_down", "stepped_down", "stepped_down", "joined"]);
  assert.deepEqual(r.pool.calls.slice(0, 5), [`stake ${STEP}`, `stake ${STEP}`, `stake ${STEP}`, `stake ${STEP}`, `unstake ${STEP}`]);
});

test("a move reports the shares read from the chain before and after and the meeting that follows", async () => {
  const r = rig();
  const before = Number((r.chain.totalStaked * 10_000n) / r.chain.totalSupply);
  const res = await r.join.start("1.1.1.1");
  assert.equal(res.status, 200);
  assert.deepEqual(
    { ...res.body, at_ms: undefined, now_ms: undefined },
    {
      status: "joined",
      direction: "join",
      tx_hash: "tx-1",
      share_before_bps: before,
      share_after_bps: Number((r.chain.totalStaked * 10_000n) / r.chain.totalSupply),
      epoch: 5,
      meeting_epoch: 6,
      meeting_at_ms: r.chain.params.startMs + 6 * r.chain.params.epochMs,
      at_ms: undefined,
      now_ms: undefined,
      pool: "pool.test",
    },
  );
  assert.equal(before, 1000);
  assert.equal(res.body["share_after_bps"], 1100, "10% staked by others, plus the 1% step");
  assert.match(r.logs.join("\n"), /join join tx tx-1 share 1000 -> 1100 bps/);
  assert.deepEqual((r.join.state().body as { last: unknown }).last, { direction: "join", tx_hash: "tx-1", share_before_bps: 1000, share_after_bps: 1100, epoch: 5, meeting_epoch: 6, meeting_at_ms: r.chain.params.startMs + 6 * r.chain.params.epochMs, at_ms: r.chain.nowMs });
});

test("nothing is signed when the chain says the pool is already past its cap for a stake, or backs a candidate, or the read fails", async () => {
  const over = rig({ staked: 5n * STEP });
  over.chain.advanceEpochs(3);
  const a = await over.join.start("1.1.1.1");
  assert.equal(a.body["status"], "stepped_down", "above the cap the only move is down");
  assert.deepEqual(over.pool.calls, [`unstake ${STEP}`]);

  const backs = rig({ staked: STEP });
  backs.pool.backing = "challenger.test";
  assert.equal((await backs.join.start("1.1.1.1")).status, 503);
  assert.deepEqual(backs.pool.calls, []);

  const down = rig();
  down.pool.readsFail = true;
  const res = await down.join.start("1.1.1.1");
  assert.deepEqual([res.status, res.body["code"]], [503, "desk_closed"]);
  assert.deepEqual(down.pool.calls, [], "a failed read signs nothing");
  down.pool.readsFail = false;
  for (let i = 0; i < 3; i++) assert.equal((await down.join.start("1.1.1.1")).body["status"], "joined", "and spent none of the visitor's tries");
});

test("a step down inside the contract's lock sends nothing, says when it can go, and shows the latest real move", async () => {
  const r = rig({ staked: 3n * STEP });
  assert.equal((await r.join.start("1.1.1.1")).body["status"], "joined");
  const res = await r.join.start("2.2.2.2");
  assert.equal(res.status, 200);
  assert.equal(res.body["status"], "locked");
  assert.equal(res.body["retry_at_ms"], r.chain.params.startMs + 7 * r.chain.params.epochMs);
  assert.equal((res.body["last"] as { tx_hash: string }).tx_hash, "tx-1");
  assert.deepEqual(r.pool.calls, [`stake ${STEP}`], "no gas spent on a refusal");
  assert.equal((r.join.state().body as { next: string }).next, "step_down");
  tick(r.chain, 2);
  assert.equal((await r.join.start("2.2.2.2")).body["status"], "stepped_down");
});

test("a pool without coins sends nothing and shows the latest real move", async () => {
  const r = rig();
  assert.equal((await r.join.start("1.1.1.1")).body["status"], "joined");
  r.pool.liquid = 0n;
  const res = await r.join.start("2.2.2.2");
  assert.deepEqual([res.body["status"], (res.body["last"] as { tx_hash: string }).tx_hash, r.pool.calls.length], ["dry", "tx-1", 1]);
});

test("the contract refusing the call, or the new stake never showing, or the read after the call failing, are each said as they are", async () => {
  const refused = rig();
  refused.pool.refuse = "stake is locked until epoch 9";
  const a = await refused.join.start("1.1.1.1");
  assert.deepEqual([a.body["status"], a.body["failure"], a.body["tx_hash"]], ["failed", "stake is locked until epoch 9", "tx-1"]);

  const lost = rig();
  lost.pool.afterCall = () => {
    lost.pool.readsFail = true;
  };
  const b = await lost.join.start("1.1.1.1");
  assert.deepEqual([b.status, b.body["status"], b.body["tx_hash"]], [200, "unconfirmed", "tx-1"]);
  assert.match(lost.logs.join("\n"), /unconfirmed/);

  const invisible = rig();
  const stake = invisible.pool.stake.bind(invisible.pool);
  invisible.pool.stake = async (amount, onBroadcast) => {
    const res = await stake(amount, onBroadcast);
    invisible.pool.staked -= amount; // the newest block does not show it
    return res;
  };
  const c = await invisible.join.start("1.1.1.1");
  assert.equal(c.body["status"], "unconfirmed");
  assert.equal(c.body["share_after_bps"], undefined, "no figure is shown that the chain did not give");
});

test("limits: 3 moves per address an hour, 20 an hour and 200 a day over everyone, 8 asks per address in ten minutes; a capped visitor gets the latest real move", async () => {
  const r = rig({ limits: { perIpSendsWindowMs: 3_600_000 } });
  for (let i = 0; i < 3; i++) assert.equal((await r.join.start("1.1.1.1")).status, 200);
  const capped = await r.join.start("1.1.1.1");
  assert.deepEqual([capped.status, capped.body["code"]], [429, "cap"]);
  assert.equal(typeof capped.body["retry_after_s"], "number");
  assert.equal(capped.headers?.["retry-after"], capped.body["retry_after_s"]);
  assert.equal((capped.body["last"] as { tx_hash: string }).tx_hash, "tx-3");
  assert.equal(r.pool.calls.length, 3, "the refused click sent nothing");
  r.chain.advanceTo(r.chain.nowMs + 3_600_001);
  assert.equal((await r.join.start("1.1.1.1")).status, 200, "an hour later the address may again");

  const hourly = rig();
  for (let i = 0; i < 20; i++) {
    assert.equal((await hourly.join.start(`9.9.9.${i}`)).status, 200);
    tick(hourly.chain, 2); // past the stake lock, well inside the hour
  }
  const h = await hourly.join.start("9.9.9.99");
  assert.deepEqual([h.status, h.body["code"]], [429, "cap"]);
  hourly.chain.advanceTo(hourly.chain.nowMs + 3_600_001);
  assert.equal((await hourly.join.start("9.9.9.99")).status, 200);

  const daily = rig({ limits: { hourlyCap: 1000, dailyCap: 3 } });
  for (let i = 0; i < 3; i++) assert.equal((await daily.join.start(`8.8.8.${i}`)).status, 200);
  assert.equal((await daily.join.start("8.8.8.9")).body["code"], "cap");

  const asks = rig({ limits: { perIpSends: 100, hourlyCap: 100 } });
  for (let i = 0; i < 8; i++) assert.equal((await asks.join.start("7.7.7.7")).status, 200);
  const ninth = await asks.join.start("7.7.7.7");
  assert.deepEqual([ninth.status, ninth.body["code"]], [429, "per_address"]);
});

test("only moves that reach the chain use up a visitor's tries: a locked or empty pool costs none", async () => {
  const r = rig({ staked: 3n * STEP });
  await r.join.start("1.1.1.1"); // joined: the pool is full and locked
  for (let i = 0; i < 2; i++) assert.equal((await r.join.start("1.1.1.1")).body["status"], "locked");
  tick(r.chain, 2);
  assert.equal((await r.join.start("1.1.1.1")).body["status"], "stepped_down");
  assert.equal((await r.join.start("1.1.1.1")).status, 200);
  assert.equal((await r.join.start("1.1.1.1")).body["code"], "cap");
});

test("clicks are served one at a time in order, a few may wait and the rest are told to try again", async () => {
  const r = rig();
  const pool = r.pool;
  const read = pool.pool.bind(pool);
  let open!: () => void;
  const gate = new Promise<void>((res) => (open = res));
  pool.pool = async () => {
    await gate; // the first click is held at its read while the others arrive
    return read();
  };
  const results: Promise<Reply>[] = [];
  for (const who of ["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"]) {
    results.push(r.join.start(who));
    await new Promise((res) => setImmediate(res)); // the first is under way when the next arrives, as over the network
  }
  open();
  const done = await Promise.all(results);
  assert.deepEqual(done.map((x) => x.status), [200, 200, 200, 429, 429], "one running, two waiting, the rest turned away at once");
  assert.equal(done[3]!.body["code"], "composing");
  assert.equal(pool.calls.length, 3);
  assert.deepEqual(pool.calls, [`stake ${STEP}`, `stake ${STEP}`, `stake ${STEP}`]);
  assert.deepEqual(done.slice(0, 3).map((x) => [x.body["share_before_bps"], x.body["share_after_bps"]]), [[1000, 1100], [1100, 1200], [1200, 1300]], "each click saw the one before it");
});

test("the state is memory only: what the next click does and the latest move, without touching the chain", async () => {
  const r = rig();
  assert.deepEqual((r.join.state().body as { next: string; last: unknown }).next, "join");
  assert.equal((r.join.state().body as { last: unknown }).last, null);
  r.pool.readsFail = true;
  assert.equal(r.join.state().status, 200);
  r.pool.readsFail = false;
  for (let i = 0; i < 4; i++) await r.join.start(`1.0.0.${i}`);
  assert.equal((r.join.state().body as { next: string }).next, "step_down", "the pool is full: the next click takes a step out");
});

// ---- the routes ----

async function withDesk(join: { start(who: string): Promise<Reply>; state(): Reply } | undefined, run: (base: string) => Promise<void>): Promise<void> {
  const dir = tempDir("join-server");
  const server = createPressServer({ store: new PressStore(join_(dir, "press.jsonl")), answer: () => Promise.resolve({ answer: BOOK[0]!, source: "model" as const }), available: () => true, ...(join === undefined ? {} : { join }) });
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  try {
    await run(base);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = (base: string, body = "{}", type = "application/json"): Promise<Response> => fetch(`${base}/join`, { method: "POST", headers: { "content-type": type }, body });

test("POST /join hands the visitor's key to the service and relays its status, body and retry-after; /join/state and /health say what is on", async () => {
  const seen: string[] = [];
  const svc = {
    start: (who: string): Promise<Reply> => (seen.push(who), Promise.resolve({ status: 429, body: { code: "cap", retry_after_s: 7, last: null }, headers: { "retry-after": 7 } })),
    state: (): Reply => ({ status: 200, body: { next: "join", last: null } }),
  };
  await withDesk(svc, async (base) => {
    const res = await post(base);
    assert.equal(res.status, 429);
    assert.equal(res.headers.get("retry-after"), "7");
    assert.deepEqual(await res.json(), { code: "cap", retry_after_s: 7, last: null });
    assert.deepEqual(seen, ["127.0.0.1"]);
    assert.deepEqual(await (await fetch(`${base}/join/state`)).json(), { next: "join", last: null });
    assert.equal(((await (await fetch(`${base}/health`)).json()) as { join: boolean }).join, true);
  });
});

test("a click that is not JSON, not an object or too big never reaches the service", async () => {
  let called = 0;
  const svc = { start: (): Promise<Reply> => (called++, Promise.resolve({ status: 200, body: {} })), state: (): Reply => ({ status: 200, body: {} }) };
  await withDesk(svc, async (base) => {
    assert.equal((await post(base, "{}", "text/plain")).status, 400);
    assert.equal((await post(base, "{nope")).status, 400);
    assert.equal((await post(base, "[1]")).status, 400);
    assert.equal((await post(base, JSON.stringify({ pad: "x".repeat(2000) }))).status, 400);
  });
  assert.equal(called, 0);
});

test("without the join service the routes answer that the desk is closed and /health says join is off; wrong methods are 405", async () => {
  await withDesk(undefined, async (base) => {
    assert.equal((await post(base)).status, 503);
    assert.equal((await fetch(`${base}/join/state`)).status, 503);
    assert.equal(((await (await fetch(`${base}/health`)).json()) as { join: boolean }).join, false);
  });
  const svc = { start: (): Promise<Reply> => Promise.resolve({ status: 200, body: {} }), state: (): Reply => ({ status: 200, body: {} }) };
  await withDesk(svc, async (base) => {
    assert.equal((await fetch(`${base}/join`)).status, 405);
    assert.equal((await fetch(`${base}/join/state`, { method: "POST" })).status, 405);
  });
});
