import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { KeyPair, baseEncode } from "near-api-js";
import { NearRpc } from "../src/rpc.js";
import { blockHash } from "./faucet-chain.js";
import { DEFAULT_FAUCET_LIMITS, FAUCET_GAS_MARGIN, Faucet, Refused, RpcFaucetReader, formatUnits, implicitAccount, limitsFromEnv, type FaucetDeps, type FaucetLimits } from "../src/press-faucet.js";
import { FAUCET_GRANT_CHAIR, FAUCET_GRANT_NEAR, FAUCET_STEPS, FAUCET_STORAGE_DEPOSIT, FaucetSigner, hashOf, type FaucetStep } from "../src/signer.js";
import { eventually, tempDir } from "./helpers.js";

const root = tempDir("faucet");
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;
const fresh = (): string => {
  const dir = join(root, String(++seq));
  mkdirSync(dir);
  return dir;
};

/** A pending record as the real signer writes it: the step's signed bytes and their hash. */
async function signedPending(step: FaucetStep, account: string, nonce = 101n): Promise<{ step: FaucetStep; hash: string; tx: string }> {
  const signed = await new FaucetSigner(KeyPair.fromRandom("ed25519").toString(), "faucet.test", "token.test", {} as NearRpc, {} as NearRpc).build(step, account, nonce, blockHash);
  return { step, hash: hashOf(signed), tx: Buffer.from(signed.encode()).toString("base64") };
}

const newKey = (): { key: string; account: string } => {
  const pub = KeyPair.fromRandom("ed25519").getPublicKey();
  return { key: pub.toString(), account: Buffer.from(pub.data).toString("hex") };
};

const ENOUGH = { near: FAUCET_GRANT_NEAR + FAUCET_STORAGE_DEPOSIT + FAUCET_GAS_MARGIN, chair: FAUCET_GRANT_CHAIR };
/** The hash the stand-in signer gives a step. */
const txFor = (step: FaucetStep, account: string): string => `${step}-${account.slice(0, 4)}`;
const allTxs = (account: string): string[] => FAUCET_STEPS.map((s) => txFor(s, account));

/**
 * A faucet with a chain and signer stand-in; the returned object exposes what they were asked and lets a test change what they answer. The stand-in
 * signer behaves as the real one does towards its hooks: onPending before each step, onStep after it, a recorded pending transaction settled as landed.
 */
function rig(over: Partial<FaucetDeps> = {}, limits: Partial<FaucetLimits> = {}) {
  const dir = fresh();
  const r = {
    stateFile: join(dir, "faucet.json"),
    killFile: join(dir, "kill"),
    clock: 1_000_000_000_000,
    existing: new Set<string>(),
    funds: ENOUGH as { near: bigint; chair: bigint },
    readFails: false,
    /** One entry per call of the signer: the account and the steps it was told were finished. */
    calls: [] as { account: string; finished: FaucetStep[]; pending: FaucetStep | null }[],
    inflight: 0,
    maxInflight: 0,
    gate: null as Promise<void> | null,
    failAt: null as FaucetStep | null,
    failure: null as string | null,
    beforeBroadcast: (): void => undefined,
    afterBroadcast: (): void => undefined,
    log: [] as string[],
    deps: undefined as unknown as FaucetDeps,
    faucet: undefined as unknown as Faucet,
    get granted(): string[] {
      return r.calls.map((c) => c.account);
    },
  };
  r.deps = {
    reader: {
      exists: (id) => (r.readFails ? Promise.reject(new Error("rpc down")) : Promise.resolve(r.existing.has(id))),
      funds: () => (r.readFails ? Promise.reject(new Error("rpc down")) : Promise.resolve(r.funds)),
    },
    sender: {
      grant: async (account, finished, pending, hooks) => {
        r.beforeBroadcast();
        if (r.gate !== null) await r.gate;
        r.inflight++;
        r.maxInflight = Math.max(r.maxInflight, r.inflight);
        try {
          r.calls.push({ account, finished: [...finished], pending: pending?.step ?? null });
          await new Promise((res) => setImmediate(res));
          const txs: string[] = [];
          for (const step of FAUCET_STEPS) {
            if (finished.has(step)) continue;
            if (pending?.step === step) {
              // The recorded transaction is settled: it landed.
              hooks.onStep(step, pending.hash);
              txs.push(pending.hash);
              continue;
            }
            if (hooks.halt()) return { txs, failed: null, halted: true };
            hooks.onPending({ step, hash: txFor(step, account), tx: "AAAA" });
            r.afterBroadcast();
            if (r.failAt === step) return { txs, failed: { step, failure: r.failure } };
            if (step === "transfer") r.existing.add(account);
            hooks.onStep(step, txFor(step, account));
            txs.push(txFor(step, account));
          }
          return { txs, failed: null };
        } finally {
          r.inflight--;
        }
      },
    },
    stateFile: r.stateFile,
    killFile: r.killFile,
    now: () => r.clock,
    limits,
    log: (line) => r.log.push(line),
    ...over,
  };
  r.faucet = new Faucet(r.deps);
  return r;
}

const HOUR = 3_600_000;
const body = (r: { body: Record<string, unknown> }): Record<string, unknown> => r.body;

test("the default limits pace the budget: 3 grants per address per day, 5 an hour, 20 a day, 200 in all", () => {
  assert.equal(DEFAULT_FAUCET_LIMITS.perIpGrants, 3);
  assert.equal(DEFAULT_FAUCET_LIMITS.perIpGrantsWindowMs, 24 * HOUR);
  assert.equal(DEFAULT_FAUCET_LIMITS.hourlyCap, 5);
  assert.equal(DEFAULT_FAUCET_LIMITS.hourlyWindowMs, HOUR);
  assert.equal(DEFAULT_FAUCET_LIMITS.dailyCap, 20);
  assert.equal(DEFAULT_FAUCET_LIMITS.dailyWindowMs, 24 * HOUR);
  assert.equal(DEFAULT_FAUCET_LIMITS.lifetimeCap, 200);
});

test("implicitAccount is the 64 lowercase hex characters of the key's 32 bytes, and only for a well-formed ed25519 key", () => {
  assert.equal(implicitAccount(`ed25519:${baseEncode(Buffer.alloc(32, 1))}`), "01".repeat(32));
  const { key, account } = newKey();
  assert.equal(implicitAccount(key), account);
  assert.match(account, /^[0-9a-f]{64}$/);
  const bad: unknown[] = [
    undefined, null, 5, {}, [], "", "ed25519:", key.slice(8), `secp256k1:${key.slice(8)}`, `ED25519:${key.slice(8)}`, ` ${key}`, `${key}\n`, `${key}0`, `${key}=`,
    `ed25519:${baseEncode(Buffer.alloc(31, 1))}`, `ed25519:${baseEncode(Buffer.alloc(33, 1))}`, `ed25519:${"1".repeat(44)}`, `ed25519:${"l".repeat(44)}`, `ed25519:${"0OIl".repeat(11)}`,
  ];
  for (const b of bad) assert.equal(implicitAccount(b), null, JSON.stringify(b));
});

test("formatUnits writes 50 CHAIR as 50 and 0.05 NEAR as 0.05", () => {
  assert.equal(formatUnits(FAUCET_GRANT_CHAIR, 24), "50");
  assert.equal(formatUnits(FAUCET_GRANT_NEAR, 24), "0.05");
  assert.equal(formatUnits(5n * 10n ** 22n, 24), "0.05");
  assert.equal(formatUnits(0n, 24), "0");
  assert.equal(formatUnits(1n, 24), "0.000000000000000000000001");
  assert.equal(formatUnits(12_340_000_000_000_000_000_000_000n, 24), "12.34");
});

test("a grant answers 200 with the account, the three transactions and the amounts, and the state file records it", async () => {
  const r = rig();
  const { key, account } = newKey();
  const res = await r.faucet.start(key, "1.1.1.1");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { account_id: account, txs: allTxs(account), chair: "50", near: "0.05" });
  assert.deepEqual(r.granted, [account]);
  const steps = Object.fromEntries(FAUCET_STEPS.map((st) => [st, txFor(st, account)]));
  assert.deepEqual(JSON.parse(readFileSync(r.stateFile, "utf8")), { v: 1, grants: [{ at: r.clock, account, steps, signed: 0 }] });
});

test("a malformed key is 400 and reaches neither the chain nor the signer", async () => {
  const r = rig();
  for (const bad of [undefined, 7, "", "ed25519:abc", `ed25519:${"1".repeat(44)}`, "not a key"]) {
    const res = await r.faucet.start(bad, "1.1.1.1");
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.match(String(body(res)["error"]), /ed25519/);
  }
  assert.deepEqual(r.granted, []);
});

test("an account that exists on chain and is not in the record is 409 and nothing is sent or counted", async () => {
  const r = rig();
  const { key, account } = newKey();
  r.existing.add(account);
  const res = await r.faucet.start(key, "1.1.1.1");
  assert.equal(res.status, 409);
  assert.match(String(body(res)["error"]), /already exists/);
  assert.deepEqual(r.granted, []);
  assert.equal(body(r.faucet.state())["remaining"], 200);
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200, "the refused visitor's address was not charged for it");
});

test("three grants per address per day: the fourth is 429 with retry_after_s and limit \"address\", another address is served, and the day later it is open again", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100 });
  for (let i = 0; i < 3; i++) assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200, `grant ${i + 1}`);
  const res = await r.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 429);
  assert.equal(body(res)["retry_after_s"], 24 * 3600);
  assert.equal(body(res)["limit"], "address", "the page tells this network's own cap from the desk's totals by this field");
  assert.match(String(body(res)["error"]), /this address has already had its 3 test coin grants for today/);
  assert.equal(res.headers?.["retry-after"], 24 * 3600);
  assert.equal((await r.faucet.start(newKey().key, "2.2.2.2")).status, 200);
  r.clock += 24 * HOUR + 1;
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200);
  assert.equal(r.granted.length, 5);
});

test("the per-address cap is configurable: CHAIR_FAUCET_PER_ADDRESS of 1 stops the second grant", async () => {
  const r = rig({}, { ...limitsFromEnv({ CHAIR_FAUCET_PER_ADDRESS: "1" }), hourlyCap: 100, dailyCap: 100 });
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200);
  const res = await r.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 429);
  assert.match(String(body(res)["error"]), /its 1 test coin grants/);
});

test("the hourly cap: past it every address gets 429 until the oldest grant is an hour old", async () => {
  const r = rig({}, { hourlyCap: 3 });
  for (let i = 0; i < 3; i++) {
    assert.equal((await r.faucet.start(newKey().key, `9.9.9.${i}`)).status, 200);
    r.clock += 1_000;
  }
  const res = await r.faucet.start(newKey().key, "8.8.8.8");
  assert.equal(res.status, 429);
  assert.equal(body(res)["retry_after_s"], 3597);
  assert.equal(body(res)["limit"], undefined, "the desk's totals carry no limit field: only the per-address cap does");
  assert.equal(r.granted.length, 3);
  r.clock += 3_597_000;
  assert.equal((await r.faucet.start(newKey().key, "8.8.8.8")).status, 200);
});

test("the daily cap: past it every address gets 429 until the oldest grant is a day old", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 4 });
  for (let i = 0; i < 4; i++) {
    assert.equal((await r.faucet.start(newKey().key, `9.9.9.${i}`)).status, 200);
    r.clock += 2 * HOUR;
  }
  assert.equal((await r.faucet.start(newKey().key, "8.8.8.8")).status, 429);
  r.clock += 15 * HOUR;
  assert.equal((await r.faucet.start(newKey().key, "8.8.8.8")).status, 429, "the first grant is 23 h old: still inside the window");
  r.clock += 2 * HOUR;
  assert.equal((await r.faucet.start(newKey().key, "8.8.8.8")).status, 200);
});

test("the lifetime budget: when it is spent the answer is 503 budget, however long you wait", async () => {
  const r = rig({}, { lifetimeCap: 2, hourlyCap: 100, dailyCap: 100 });
  for (let i = 0; i < 2; i++) assert.equal((await r.faucet.start(newKey().key, `9.9.9.${i}`)).status, 200);
  assert.equal(body(r.faucet.state())["remaining"], 0);
  r.clock += 1000 * 24 * HOUR;
  const res = await r.faucet.start(newKey().key, "8.8.8.8");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "budget");
  assert.equal(r.granted.length, 2);
  assert.deepEqual(body(r.faucet.state()), { open: false, grant_chair: "50", grant_near: "0.05", remaining: 0, next_opening_s: 0, reason: "budget" });
});

test("the lifetime and daily counts survive a restart: a new Faucet on the same file knows what was given", async () => {
  const limits = { lifetimeCap: 3, hourlyCap: 100, dailyCap: 100 };
  const r = rig({}, limits);
  const done = [newKey(), newKey()];
  for (const [i, k] of done.entries()) assert.equal((await r.faucet.start(k.key, `9.9.9.${i}`)).status, 200);

  const restarted = new Faucet({ ...r.deps, limits });
  assert.equal(body(restarted.state())["remaining"], 1);
  const again = await restarted.start(done[0]!.key, "7.7.7.7");
  assert.equal(again.status, 200, "an account already granted is answered from the record, not granted twice");
  assert.deepEqual(again.body["txs"], allTxs(done[0]!.account));
  assert.equal(r.granted.length, 2);
  assert.equal((await restarted.start(newKey().key, "7.7.7.7")).status, 200);
  assert.equal(body(restarted.state())["remaining"], 0);
  assert.equal((await restarted.start(newKey().key, "6.6.6.6")).status, 503);

  assert.equal(body(new Faucet({ ...r.deps, limits }).state())["remaining"], 0);
  const tight = new Faucet({ ...r.deps, limits: { dailyCap: 3, hourlyCap: 100 } });
  assert.equal((await tight.start(newKey().key, "5.5.5.5")).status, 429, "the daily window counts the grants from before the restart");
});

test("a state file that is not a list of grants stops the faucet from starting; so does a path that cannot be written", () => {
  const dir = fresh();
  const acct = "a".repeat(64);
  const bad = [
    "", "{", "[]", '{"grants":5}', '{"grants":[{"at":1}]}', `{"grants":[{"at":-1,"account":"${acct}","steps":{}}]}`, '{"grants":[{"at":1,"account":"ABC","steps":{}}]}',
    `{"grants":[{"at":1,"account":"${acct}"}]}`, `{"grants":[{"at":1,"account":"${acct}","steps":[]}]}`, `{"grants":[{"at":1,"account":"${acct}","steps":{"deploy":"x"}}]}`, `{"grants":[{"at":1,"account":"${acct}","steps":{"transfer":5}}]}`,
  ];
  for (const text of bad) {
    const file = join(dir, "bad.json");
    writeFileSync(file, text);
    assert.throws(() => rig({ stateFile: file }), Error, text);
  }
  assert.throws(() => rig({ stateFile: join(dir, "no-such-dir", "faucet.json") }));
});

test("a low faucet balance is 503 dry, whichever coin is short, and the state says so until the balance is read again", async () => {
  const r = rig();
  for (const funds of [{ near: ENOUGH.near - 1n, chair: ENOUGH.chair }, { near: ENOUGH.near, chair: ENOUGH.chair - 1n }, { near: 0n, chair: 0n }]) {
    r.funds = funds;
    const res = await r.faucet.start(newKey().key, "1.1.1.1");
    assert.equal(res.status, 503);
    assert.equal(body(res)["reason"], "dry");
  }
  assert.deepEqual(r.granted, []);
  assert.equal(r.log.filter((l) => /dry/.test(l)).length, 1, "the journal says once that the faucet went dry, not on every ask while it is");
  const state = body(r.faucet.state());
  assert.equal(state["open"], false);
  assert.equal(state["reason"], "dry");
  assert.equal(r.faucet.live(), false, "/health agrees");
  r.funds = ENOUGH;
  assert.equal(body(r.faucet.state())["reason"], "dry", "until it is read again");
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200, "refilled: the next ask reads it again, and the dry visitor's address was not charged");
  assert.equal(body(r.faucet.state())["open"], true);
  assert.equal(r.faucet.live(), true);
  assert.equal(r.log.filter((l) => /funded again/.test(l)).length, 1);
});

test("a faucet that runs dry between visitors says so on its own: watch() reads the balance, so the state and /health are true with nobody asking", async () => {
  const r = rig({}, { readyRetryMs: 20 });
  const stop = r.faucet.watch();
  try {
    const until = async (want: boolean): Promise<void> => {
      await eventually(() => r.faucet.live() === want);
      assert.equal(r.faucet.live(), want);
    };
    await until(true);
    r.funds = { near: 0n, chair: 0n };
    await until(false);
    assert.equal(body(r.faucet.state())["reason"], "dry");
    r.funds = ENOUGH;
    await until(true);
    assert.equal(body(r.faucet.state())["open"], true);
  } finally {
    stop();
  }
});

test("the kill file closes the faucet on the very next request, and removing it opens it again, with no restart", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100 });
  assert.equal(r.faucet.live(), true);
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200);
  writeFileSync(r.killFile, "");
  assert.equal(r.faucet.live(), false);
  const res = await r.faucet.start(newKey().key, "2.2.2.2");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "killed");
  assert.equal((await r.faucet.start("garbage", "2.2.2.2")).status, 400);
  assert.equal(body(r.faucet.state())["reason"], "killed");
  assert.equal(body(r.faucet.state())["open"], false);
  assert.equal(r.granted.length, 1);
  rmSync(r.killFile);
  assert.equal(r.faucet.live(), true);
  assert.equal((await r.faucet.start(newKey().key, "2.2.2.2")).status, 200);
});

test("the kill file also stops a request that was already waiting its turn", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100 });
  let release!: () => void;
  r.gate = new Promise<void>((res) => (release = res));
  const first = r.faucet.start(newKey().key, "1.1.1.1");
  const second = r.faucet.start(newKey().key, "2.2.2.2");
  await new Promise((res) => setImmediate(res));
  writeFileSync(r.killFile, "");
  release();
  for (const res of [await first, await second]) {
    assert.equal(res.status, 503, "the one in flight stops before its next step, the one waiting never starts");
    assert.equal(body(res)["reason"], "killed");
  }
  assert.equal(body(r.faucet.state())["remaining"], 200, "nothing was sent or counted");
});

test("a partial failure is reported with the step that failed and the hashes that went through, it counts against the budget, and it charges the address's day", async () => {
  const r = rig({}, { lifetimeCap: 5, hourlyCap: 100, dailyCap: 100, perIpGrants: 1 });
  r.failAt = "storage_deposit";
  r.failure = "Smart contract panicked: x";
  const { key, account } = newKey();
  const res = await r.faucet.start(key, "1.1.1.1");
  assert.equal(res.status, 502);
  assert.equal(body(res)["failed_step"], "storage_deposit");
  assert.equal(body(res)["account_id"], account);
  assert.deepEqual(body(res)["txs"], [txFor("transfer", account)]);
  assert.match(String(body(res)["error"]), /no CHAIR was sent yet/);
  assert.equal(body(r.faucet.state())["remaining"], 4, "the budget is down by one");
  const [grant] = JSON.parse(readFileSync(r.stateFile, "utf8")).grants;
  assert.deepEqual(grant.steps, { transfer: txFor("transfer", account) });
  assert.equal(grant.pending.step, "storage_deposit", "kept even though the chain said it failed: the next ask looks it up, and only that look may lead to a new signature");
  assert.ok(r.log.some((l) => /failed at storage_deposit.*Smart contract panicked: x/.test(l)));
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 429, "a visitor cannot make step 3 fail and start over with a new key from the same address");

  for (const [i, step] of (["transfer", "ft_transfer"] as const).entries()) {
    r.failAt = step;
    r.failure = null;
    const other = await r.faucet.start(newKey().key, `3.3.3.${i}`);
    assert.equal(other.status, 502);
    assert.equal(body(other)["failed_step"], step);
  }
  assert.equal(body(r.faucet.state())["remaining"], 2);
});

test("a step whose outcome is not known is kept as pending in the record, with its hash and bytes, to be settled when the key asks again", async () => {
  const r = rig();
  r.failAt = "ft_transfer";
  const { key, account } = newKey();
  assert.equal((await r.faucet.start(key, "1.1.1.1")).status, 502);
  const [grant] = JSON.parse(readFileSync(r.stateFile, "utf8")).grants;
  assert.deepEqual(grant.pending, { step: "ft_transfer", hash: txFor("ft_transfer", account), tx: "AAAA" });
  r.failAt = null;
  const res = await r.faucet.start(key, "9.9.9.9");
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls[1], { account, finished: ["transfer", "storage_deposit"], pending: "ft_transfer" }, "the sender was handed the recorded transaction");
  assert.equal(JSON.parse(readFileSync(r.stateFile, "utf8")).grants[0].pending, undefined);
});

test("the same key asking again repairs an unfinished grant: it resumes from the first unfinished step, answers 200, and counts nothing new", async () => {
  const r = rig({}, { lifetimeCap: 5, hourlyCap: 100, dailyCap: 100 });
  r.failAt = "storage_deposit";
  r.failure = "Smart contract panicked: x";
  const { key, account } = newKey();
  assert.equal((await r.faucet.start(key, "1.1.1.1")).status, 502);
  r.failAt = null;
  assert.equal((await r.faucet.start(newKey().key, "2.2.2.2")).status, 200);

  const res = await r.faucet.start(key, "9.9.9.9");
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { account_id: account, txs: allTxs(account), chair: "50", near: "0.05" });
  assert.deepEqual(r.calls.filter((c) => c.account === account).map((c) => c.finished), [[], ["transfer"]], "the second call was told the first step is done");
  assert.equal(body(r.faucet.state())["remaining"], 3, "two grants begun, the resume added none");
  assert.equal(JSON.parse(readFileSync(r.stateFile, "utf8")).grants.length, 2);
  assert.equal((await r.faucet.start(newKey().key, "9.9.9.9")).status, 200, "the resume did not charge the address that sent it");
});

test("a finished grant asked for again is answered from the record: 200, the same body, nothing sent, any address, caps notwithstanding", async () => {
  const r = rig({}, { lifetimeCap: 1, hourlyCap: 1, dailyCap: 1 });
  const { key } = newKey();
  const first = await r.faucet.start(key, "1.1.1.1");
  assert.equal(first.status, 200);
  assert.equal(body(r.faucet.state())["remaining"], 0);
  assert.equal(r.faucet.live(), false);
  for (const who of ["1.1.1.1", "2.2.2.2"]) {
    const again = await r.faucet.start(key, who);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, first.body);
  }
  assert.equal(r.calls.length, 1);
  assert.equal(JSON.parse(readFileSync(r.stateFile, "utf8")).grants.length, 1);
});

test("a resume is not held back by the address's day or the hourly, daily and lifetime caps, but it is by the kill file and by the dry check", async () => {
  const r = rig({}, { lifetimeCap: 1, hourlyCap: 1, dailyCap: 1 });
  r.failAt = "ft_transfer";
  const { key, account } = newKey();
  assert.equal((await r.faucet.start(key, "1.1.1.1")).status, 502);
  assert.equal((await r.faucet.start(newKey().key, "2.2.2.2")).status, 503, "a new grant is refused: the budget is spent");
  r.failAt = null;

  writeFileSync(r.killFile, "");
  assert.equal(body(await r.faucet.start(key, "1.1.1.1"))["reason"], "killed");
  rmSync(r.killFile);
  r.funds = { near: 0n, chair: 0n };
  assert.equal(body(await r.faucet.start(key, "1.1.1.1"))["reason"], "dry");
  r.funds = ENOUGH;
  r.clock += 60_000;
  const res = await r.faucet.start(key, "1.1.1.1");
  assert.equal(res.status, 200);
  assert.deepEqual(body(res)["txs"], allTxs(account));
  assert.equal(r.calls.length, 2);
});

test("a recorded transaction is handed to the sender with the finished steps; the chain's balances play no part in what counts as done", async () => {
  const dir = fresh();
  const { key, account } = newKey();
  const stateFile = join(dir, "faucet.json");
  const kept = await signedPending("storage_deposit", account);
  writeFileSync(stateFile, JSON.stringify({ v: 1, grants: [{ at: 1_000_000_000_000, account, steps: { transfer: "t1" }, signed: 1, pending: kept }] }));
  const r = rig({ stateFile });
  r.existing.add(account); // the account is on chain, as the first step made it: not a reason for 409
  const res = await r.faucet.start(key, "1.1.1.1");
  assert.equal(res.status, 200);
  assert.deepEqual(r.calls, [{ account, finished: ["transfer"], pending: "storage_deposit" }]);
  assert.deepEqual(body(res)["txs"], ["t1", kept.hash, txFor("ft_transfer", account)]);

  // A grant begun, with nothing on record for it but its start: the whole grant is sent, however the chain looks.
  const { key: key2, account: account2 } = newKey();
  const stateFile2 = join(dir, "faucet2.json");
  writeFileSync(stateFile2, JSON.stringify({ v: 1, grants: [{ at: 1_000_000_000_000, account: account2, steps: {}, signed: 0 }] }));
  const r2 = rig({ stateFile: stateFile2 });
  assert.equal((await r2.faucet.start(key2, "1.1.1.1")).status, 200);
  assert.deepEqual(r2.calls, [{ account: account2, finished: [], pending: null }]);
});

test("a state file with a pending transaction for the wrong step, with bytes that are not its hash, or with bad fields, stops the faucet from starting", async () => {
  const dir = fresh();
  const acct = "ab".repeat(32);
  const ok = await signedPending("storage_deposit", acct);
  const other = await signedPending("storage_deposit", acct, 102n);
  const bad = [
    { ...ok, step: "ft_transfer" }, { ...ok, step: "deploy" }, { ...ok, hash: "" }, { ...ok, tx: "not base64!" }, { ...ok, tx: "A".repeat(4001) }, { ...ok, tx: 5 }, "x", 5, null,
    { ...ok, tx: "AAAA" }, { ...ok, hash: "abc" }, { ...ok, tx: other.tx },
  ];
  const write = (name: string, grant: Record<string, unknown>): string => {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify({ v: 1, grants: [{ at: 1, account: acct, steps: { transfer: "t" }, ...grant }] }));
    return file;
  };
  for (const pending of bad) assert.throws(() => rig({ stateFile: write("bad", { signed: 1, pending }) }), Error, JSON.stringify(pending));
  for (const signed of [-1, 4, 1.5, "1", null]) assert.throws(() => rig({ stateFile: write("badsigned", { signed, pending: ok }) }), Error, JSON.stringify(signed));
  assert.throws(() => rig({ stateFile: write("nosigned-pending", { pending: ok }) }), Error, "a pending transaction with no count would reset the cap");
  assert.throws(() => rig({ stateFile: write("nosigned", {}) }), Error, "a recorded step with no count would reset the cap");
  assert.throws(() => rig({ stateFile: write("zero-pending", { signed: 0, pending: ok }) }), Error, "a pending transaction was signed at least once");
  for (const gaveUp of ["transfer", "ft_transfer", "deploy", 5, null]) assert.throws(() => rig({ stateFile: write("badgaveup", { signed: 3, gaveUp }) }), Error, `gaveUp ${JSON.stringify(gaveUp)}`);
  assert.throws(() => rig({ stateFile: write("gaveup-pending", { signed: 3, gaveUp: "storage_deposit", pending: ok }) }), Error, "a given-up step has nothing pending");
  assert.ok(rig({ stateFile: write("good", { signed: 1, pending: ok }) }));
  assert.ok(rig({ stateFile: write("counted", { signed: 2, pending: ok }) }));
  assert.ok(rig({ stateFile: write("over", { signed: 3, gaveUp: "storage_deposit" }) }));
});

test("two requests for the same key at once: one grant is sent, both are answered 200 with the same body", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100 });
  const { key, account } = newKey();
  const both = await Promise.all([r.faucet.start(key, "1.1.1.1"), r.faucet.start(key, "2.2.2.2")]);
  assert.deepEqual(both.map((x) => x.status), [200, 200]);
  assert.deepEqual(both[0]!.body, both[1]!.body);
  assert.deepEqual(r.granted, [account]);
  assert.equal(r.maxInflight, 1);
});

test("two requests from the same address at once: one grant, the other is 429 once the first is confirmed", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100, perIpGrants: 1 });
  const both = await Promise.all([r.faucet.start(newKey().key, "1.1.1.1"), r.faucet.start(newKey().key, "1.1.1.1")]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 429]);
  assert.equal(r.calls.length, 1);
  assert.equal(body(r.faucet.state())["remaining"], 199);
});

test("a signer that throws after the grant was counted is a 502 that names the account, and the grant stays on the record; one that threw before is 503 and counts nothing", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100 });
  const { key, account } = newKey();
  r.deps = {
    ...r.deps,
    sender: {
      grant: (_a, _f, _p, hooks) => {
        hooks.onPending({ step: "transfer", hash: "h", tx: "AAAA" });
        return Promise.reject(new Error("record write failed"));
      },
    },
  };
  const f = new Faucet(r.deps);
  const res = await f.start(key, "1.1.1.1");
  assert.equal(res.status, 502);
  assert.equal(body(res)["account_id"], account);
  assert.deepEqual(body(res)["txs"], []);
  assert.equal(body(f.state())["remaining"], 199);
  assert.ok(r.log.some((l) => /unconfirmed/.test(l)));
});

test("the journal says when the budget first drops below 50 and below 10, and when it is spent", async () => {
  const r = rig({}, { lifetimeCap: 51, hourlyCap: 100, dailyCap: 100 });
  let visitors = 0;
  const asked = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) await r.faucet.start(newKey().key, `5.5.5.${++visitors}`);
  };
  await asked(1);
  assert.deepEqual(r.log.filter((l) => /budget/.test(l)), [], "50 left is not below 50");
  await asked(1);
  assert.equal(r.log.filter((l) => /below 50/.test(l)).length, 1);
  await asked(30);
  assert.equal(r.log.filter((l) => /below 50/.test(l)).length, 1, "only the first time");
  assert.equal(r.log.filter((l) => /below 10/.test(l)).length, 0);
  await asked(10);
  assert.equal(r.log.filter((l) => /below 10/.test(l)).length, 1);
  await asked(9);
  assert.equal(r.log.filter((l) => /all 51 grants are given/.test(l)).length, 1);
  assert.equal(r.faucet.live(), false, "spent: /health goes false");
});

test("the caps come from the environment as positive whole numbers; anything else is refused with the variable's name", () => {
  assert.deepEqual(limitsFromEnv({}), {});
  assert.deepEqual(limitsFromEnv({ CHAIR_FAUCET_PER_ADDRESS: "2" }), { perIpGrants: 2 });
  assert.deepEqual(limitsFromEnv({ CHAIR_FAUCET_HOURLY: "7" }), { hourlyCap: 7 });
  assert.deepEqual(limitsFromEnv({ CHAIR_FAUCET_DAILY: "40" }), { dailyCap: 40 });
  assert.deepEqual(limitsFromEnv({ CHAIR_FAUCET_LIFETIME: "150" }), { lifetimeCap: 150 });
  assert.deepEqual(limitsFromEnv({ CHAIR_FAUCET_HOURLY: "1", CHAIR_FAUCET_DAILY: "2", CHAIR_FAUCET_LIFETIME: "3" }), { hourlyCap: 1, dailyCap: 2, lifetimeCap: 3 });
  for (const name of ["CHAIR_FAUCET_PER_ADDRESS", "CHAIR_FAUCET_HOURLY", "CHAIR_FAUCET_DAILY", "CHAIR_FAUCET_LIFETIME"]) {
    for (const bad of ["", " ", "0", "-3", "1.5", "abc", "1e3", "0x10", "9999999", "5 "]) assert.throws(() => limitsFromEnv({ [name]: bad }), new RegExp(name), `${name}=${JSON.stringify(bad)}`);
  }
});

test("each cap applies as set: an hourly cap of 2, a daily cap of 3 and a lifetime cap of 4 stop the grants at those counts", async () => {
  const hourly = rig({}, { ...limitsFromEnv({ CHAIR_FAUCET_HOURLY: "2" }), dailyCap: 100 });
  for (let i = 0; i < 3; i++) await hourly.faucet.start(newKey().key, `6.6.6.${i}`);
  assert.equal(hourly.calls.length, 2);
  const daily = rig({}, { ...limitsFromEnv({ CHAIR_FAUCET_DAILY: "3" }), hourlyCap: 100 });
  for (let i = 0; i < 5; i++) await daily.faucet.start(newKey().key, `6.6.6.${i}`);
  assert.equal(daily.calls.length, 3);
  const lifetime = rig({}, { ...limitsFromEnv({ CHAIR_FAUCET_LIFETIME: "4" }), hourlyCap: 100, dailyCap: 100 });
  for (let i = 0; i < 6; i++) await lifetime.faucet.start(newKey().key, `6.6.6.${i}`);
  assert.equal(lifetime.calls.length, 4);
  assert.equal(body(lifetime.faucet.state())["reason"], "budget");
});

test("a chain that is down at start does not keep the faucet off: it is closed (unreadable) and tried again, and comes up by itself", async () => {
  let up = false;
  let checks = 0;
  const r = rig({ check: () => (checks++, up ? Promise.resolve() : Promise.reject(new Error("rpc down"))) }, { readyRetryMs: 30_000 });
  assert.equal(r.faucet.live(), false);
  assert.equal(body(r.faucet.state())["reason"], "unreadable");
  const res = await r.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "unreadable");
  assert.equal(checks, 1);
  await r.faucet.start(newKey().key, "2.2.2.2");
  assert.equal(checks, 1, "not tried again before the retry interval has passed");
  assert.equal(r.log.filter((l) => /waiting for the chain/.test(l)).length, 1);
  up = true;
  r.clock += 15_001;
  assert.equal((await r.faucet.start(newKey().key, "3.3.3.3")).status, 200);
  assert.equal(r.faucet.live(), true);
  assert.equal(checks, 2);
  await r.faucet.start(newKey().key, "4.4.4.4");
  assert.equal(checks, 2, "once it has passed it is not asked again");
});

test("watch() brings the faucet up by itself, with no request, once the chain answers", async () => {
  let up = false;
  const dir = fresh();
  let checks = 0;
  const f = new Faucet({
    reader: rig().deps.reader,
    sender: rig().deps.sender,
    stateFile: join(dir, "faucet.json"),
    check: () => (checks++, up ? Promise.resolve() : Promise.reject(new Error("rpc down"))),
    limits: { readyRetryMs: 20 },
  });
  const stop = f.watch();
  try {
    await eventually(() => checks >= 2);
    assert.equal(f.live(), false, "the check was tried again and failed again");
    up = true;
    await eventually(() => f.live());
    assert.equal(f.live(), true);
  } finally {
    stop();
  }
});

test("a check that can never pass (Refused) keeps the faucet off for good: 503 off, the state says off, and it is not tried again", async () => {
  let checks = 0;
  const r = rig({ check: () => (checks++, Promise.reject(new Refused("refusing to run against mainnet"))) });
  assert.equal(r.faucet.live(), false);
  const res = await r.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "unreadable", "the first ask runs the check");
  r.clock += 10 * 60_000;
  const again = await r.faucet.start(newKey().key, "2.2.2.2");
  assert.equal(body(again)["reason"], "off");
  assert.equal(body(r.faucet.state())["reason"], "off");
  assert.equal(checks, 1);
  assert.ok(r.log.some((l) => /off: refusing to run against mainnet/.test(l)));
  assert.equal(r.calls.length, 0);
});

test("a grant that never left (the signer threw before recording anything) is 503, is not counted, and does not charge the address", async () => {
  const r = rig();
  r.beforeBroadcast = () => {
    throw new Error("rpc down");
  };
  const res = await r.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "unreadable");
  assert.equal(body(r.faucet.state())["remaining"], 200);
  r.beforeBroadcast = () => undefined;
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 200);
});

test("a chain that cannot be read is 503 and nothing is sent or counted", async () => {
  const r = rig();
  r.readFails = true;
  const res = await r.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "unreadable");
  assert.deepEqual(r.granted, []);
  assert.equal(body(r.faucet.state())["remaining"], 200);
});

test("the grant is written to the state file before anything is sent, and if it cannot be written nothing is sent", async () => {
  const r = rig();
  const { key, account } = newKey();
  const sawFile: string[] = [];
  const watching = new Faucet({
    ...r.deps,
    sender: {
      grant: (_account, _finished, _pending, hooks) => {
        const first = { step: "transfer" as const, hash: "h1", tx: "AAAA" };
        hooks.onPending(first);
        sawFile.push(readFileSync(r.stateFile, "utf8"));
        for (const step of FAUCET_STEPS) hooks.onStep(step, `t-${step}`);
        return Promise.resolve({ txs: [], failed: null });
      },
    },
  });
  assert.equal((await watching.start(key, "1.1.1.1")).status, 200);
  assert.deepEqual(JSON.parse(sawFile[0]!).grants, [{ at: r.clock, account, steps: {}, signed: 1, pending: { step: "transfer", hash: "h1", tx: "AAAA" } }]);

  const r2 = rig();
  mkdirSync(`${r2.stateFile}.tmp`);
  const res = await r2.faucet.start(newKey().key, "1.1.1.1");
  assert.equal(res.status, 503, "the write failed, so the recorder threw and the signer sent nothing");
  assert.equal(r2.existing.size, 0, "nothing was sent");
  assert.equal(body(r2.faucet.state())["remaining"], 200);
});

test("one grant is in flight at a time, and when the queue is full the visitor is told to retry", async () => {
  const r = rig({}, { queueMax: 2, hourlyCap: 100, dailyCap: 100 });
  let release!: () => void;
  r.gate = new Promise<void>((res) => (release = res));
  const calls = [r.faucet.start(newKey().key, "4.4.4.0")];
  await new Promise((res) => setImmediate(res)); // the first is now the one in flight; two more may wait behind it
  for (const i of [1, 2, 3, 4]) calls.push(r.faucet.start(newKey().key, `4.4.4.${i}`));
  await new Promise((res) => setImmediate(res));
  release();
  const replies = await Promise.all(calls);
  assert.equal(r.maxInflight, 1);
  assert.deepEqual(replies.map((x) => x.status).sort(), [200, 200, 200, 429, 429]);
  assert.equal(body(replies.find((x) => x.status === 429)!)["retry_after_s"], 10);
  assert.equal(r.granted.length, 3);
});

test("an address that keeps asking is 429 before it can cost the node more reads", async () => {
  const r = rig({}, { perIpRequests: 3 });
  for (let i = 0; i < 3; i++) {
    const { key, account } = newKey();
    r.existing.add(account);
    assert.equal((await r.faucet.start(key, "1.1.1.1")).status, 409);
  }
  assert.equal((await r.faucet.start(newKey().key, "1.1.1.1")).status, 429);
  assert.equal((await r.faucet.start("junk", "1.1.1.1")).status, 400, "a malformed key is refused before it counts");
  assert.equal((await r.faucet.start(newKey().key, "2.2.2.2")).status, 200);
});

test("the state: open with the budget left, and closed with a countdown while the hourly cap is full", async () => {
  const r = rig({}, { hourlyCap: 1 });
  assert.deepEqual(body(r.faucet.state()), { open: true, grant_chair: "50", grant_near: "0.05", remaining: 200, next_opening_s: 0 });
  await r.faucet.start(newKey().key, "1.1.1.1");
  assert.deepEqual(body(r.faucet.state()), { open: false, grant_chair: "50", grant_near: "0.05", remaining: 199, next_opening_s: 3600 });
  r.clock += 1_000;
  assert.equal(body(r.faucet.state())["next_opening_s"], 3599);
});

test("the chain reader: spendable NEAR is the balance less the storage the account must keep, CHAIR is read at optimistic finality, and a missing account is an error", async () => {
  const asked: Record<string, unknown>[] = [];
  const answer = (account: Record<string, unknown> | "missing", views: Record<string, unknown>): NearRpc =>
    new NearRpc("http://n.test", 1000, (_url, init) => {
      const req = JSON.parse(String(init?.body)) as { params: Record<string, unknown> };
      asked.push(req.params);
      const name = String(req.params["method_name"]);
      let reply: unknown;
      if (req.params["request_type"] === "view_account") reply = account === "missing" ? { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } } : { result: account };
      else reply = { result: { result: [...Buffer.from(JSON.stringify(views[name]))] } };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(reply)) });
    });
  const reader = new RpcFaucetReader(answer({ amount: String(10n ** 24n), storage_usage: 1000 }, { ft_balance_of: "123" }), "token.test", "faucet.test");
  assert.deepEqual(await reader.funds(), { near: 10n ** 24n - 1000n * 10n ** 19n, chair: 123n });
  assert.equal(await reader.exists("a".repeat(64)), true);
  assert.ok(asked.every((p) => p["finality"] === "optimistic"), "every read is at the latest block, where a just-sent step shows");
  const null_ = new RpcFaucetReader(answer({ amount: "5", storage_usage: 1000 }, { ft_balance_of: "0" }), "token.test", "faucet.test");
  assert.deepEqual(await null_.funds(), { near: 0n, chair: 0n }, "less than the storage cost is none, never negative");
  await assert.rejects(new RpcFaucetReader(answer("missing", {}), "token.test", "faucet.test").funds(), /does not exist/);
  assert.equal(await new RpcFaucetReader(answer("missing", {}), "token.test", "faucet.test").exists("a".repeat(64)), false);
});

test("a finished grant is still answered 200 from the record while the faucet is killed; an unfinished one is refused with reason killed", async () => {
  const r = rig({}, { hourlyCap: 100, dailyCap: 100 });
  const done = newKey();
  const first = await r.faucet.start(done.key, "1.1.1.1");
  assert.equal(first.status, 200);
  r.failAt = "ft_transfer";
  const half = newKey();
  assert.equal((await r.faucet.start(half.key, "2.2.2.2")).status, 502);
  r.failAt = null;
  writeFileSync(r.killFile, "");
  const again = await r.faucet.start(done.key, "3.3.3.3");
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, first.body);
  const refused = await r.faucet.start(half.key, "2.2.2.2");
  assert.equal(refused.status, 503);
  assert.equal(body(refused)["reason"], "killed");
  assert.equal(typeof body(refused)["error"], "string");
  rmSync(r.killFile);
  assert.equal((await r.faucet.start(half.key, "2.2.2.2")).status, 200);
});

test("the kill file is looked at between the steps: a grant stops there, with the steps done kept, and goes on from the next step when the file is gone", async () => {
  const r = rig();
  const { key, account } = newKey();
  r.afterBroadcast = () => writeFileSync(r.killFile, "");
  const res = await r.faucet.start(key, "1.1.1.1");
  assert.equal(res.status, 503);
  assert.equal(body(res)["reason"], "killed");
  assert.deepEqual(JSON.parse(readFileSync(r.stateFile, "utf8")).grants[0].steps, { transfer: txFor("transfer", account) });
  r.afterBroadcast = () => undefined;
  assert.equal(body(await r.faucet.start(key, "1.1.1.1"))["reason"], "killed");
  rmSync(r.killFile);
  const done = await r.faucet.start(key, "1.1.1.1");
  assert.equal(done.status, 200);
  assert.deepEqual(r.calls[1], { account, finished: ["transfer"], pending: null });
});

test("a state file that has gone missing while the marker made with the first one is there keeps the faucet off, with the reason; with neither, it starts and makes both", () => {
  const dir = fresh();
  const stateFile = join(dir, "faucet.json");
  const markerFile = join(dir, "faucet-x.began");
  const r = rig({ stateFile, markerFile });
  assert.ok(existsSync(stateFile) && existsSync(markerFile), "made together");
  assert.ok(r.faucet);
  assert.ok(rig({ stateFile, markerFile }), "with both present it starts as ever");
  rmSync(stateFile);
  assert.throws(() => rig({ stateFile, markerFile }), /this faucet has run on this desk before, but its state file is missing/);
  assert.equal(existsSync(stateFile), false, "and nothing was made");
  // A state file that exists but has no marker (a desk from before the marker) gets one.
  const other = join(dir, "other.json");
  writeFileSync(other, JSON.stringify({ v: 1, grants: [] }));
  const otherMarker = join(dir, "other.began");
  assert.ok(rig({ stateFile: other, markerFile: otherMarker }));
  assert.ok(existsSync(otherMarker));
  // A different state path with the same marker (the path was changed in the unit file) is refused too.
  assert.throws(() => rig({ stateFile: join(dir, "moved.json"), markerFile: otherMarker }), /has run on this desk before/);
});
