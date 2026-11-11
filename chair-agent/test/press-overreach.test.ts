import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_BOUNDS, RateWindow, type RefusedRate } from "../src/bounds.js";
import { FakeChain } from "../src/fake-chain.js";
import { KeyPair } from "near-api-js";
import { classify, judge, MAX_INPUT_BPS, Overreach, parseRate, REASONING, type OverreachLimits } from "../src/press-overreach.js";
import { SlidingWindow } from "../src/press-window.js";
import { ChairSigner } from "../src/signer.js";
import { cleanReasoning, reasoningHash } from "../src/reasoning.js";

const CHAIR = "chair.test";
const B = DEFAULT_BOUNDS;

test("judge: only a rate beyond the absolute limit is sent, at its edge and one past it", () => {
  for (const ok of [200, -200, 199, 0, 55, -45]) assert.equal(judge(ok, B).kind, "within-mandate", `${ok} is not sent`);
  for (const past of [201, -201, 202, 9999, -9999, 1_000_000]) {
    const v = judge(past, B);
    assert.equal(v.kind, "must-refuse", String(past));
    assert.deepEqual(v.kind === "must-refuse" ? v.bound : null, { kind: "absolute", lo: -200, hi: 200 });
  }
});

test("judge refuses to judge what is not an integer", () => {
  for (const bad of [1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => judge(bad, B), TypeError);
});

test("parseRate takes whole numbers within the sane size and nothing else", () => {
  assert.equal(parseRate(0), 0);
  assert.equal(parseRate(-0), 0);
  assert.ok(Object.is(parseRate(-0), 0));
  assert.equal(parseRate(500), 500);
  assert.equal(parseRate(-9999), -9999);
  assert.equal(parseRate(MAX_INPUT_BPS), MAX_INPUT_BPS);
  assert.equal(parseRate(-MAX_INPUT_BPS), -MAX_INPUT_BPS);
  for (const bad of [MAX_INPUT_BPS + 1, -MAX_INPUT_BPS - 1, 2 ** 31, 1e21, Number.MAX_SAFE_INTEGER, 2.5, 1e-9, NaN, Infinity, "500", "5e2", "", null, undefined, true, [500], { v: 5 }, 500n]) {
    assert.equal(parseRate(bad), null, String(bad));
  }
});

test("classify names the check the contract's text came from", () => {
  assert.equal(classify("rate_bps out of bounds: must be within -200..=200"), "absolute");
  assert.equal(classify("rate step too large: must move at most 50 bps from the current rate"), "step");
  assert.equal(classify("policy already set this epoch"), "already_set");
  assert.equal(classify("only the chair may set policy"), "not_chair");
  assert.equal(classify("Exceeded the prepaid gas"), "other");
});

test("the fixed text is clean and hashes to its own hash", () => {
  assert.equal(cleanReasoning(REASONING), REASONING);
  assert.match(reasoningHash(REASONING), /^[0-9a-f]{64}$/);
});

// ---- the service, against the in-memory token (which mirrors the contract's checks and their order) ----

interface Rig {
  chain: FakeChain;
  svc: Overreach;
  sent: { rate: number; text: string }[];
  logs: string[];
  slept: number[];
}

/**
 * `landing` runs after the desk's read and before the call reaches the in-memory contract: the chain moves on between what the desk saw and where
 * the call lands (epochs pass, decay happens, the chair decides). `failBefore` throws before the transaction leaves; `senderFails` after it left.
 */
function rig(o: { limits?: Partial<OverreachLimits>; senderFails?: boolean; failBefore?: boolean; chairIs?: string; accepts?: boolean; landing?: (chain: FakeChain) => void } = {}): Rig {
  const chain = new FakeChain({ chair: o.chairIs ?? CHAIR, totalSupply: 10n ** 30n, totalStaked: 10n ** 29n });
  chain.advanceEpochs(5, 10_000); // epoch 5, 10 s in
  const sent: Rig["sent"] = [];
  const logs: string[] = [];
  const slept: number[] = [];
  let n = 0;
  const svc = new Overreach({
    reader: chain,
    chairAccount: CHAIR,
    now: () => chain.nowMs,
    sleep: (ms) => {
      slept.push(ms);
      chain.advanceTo(chain.nowMs + ms);
      return Promise.resolve();
    },
    newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`,
    limits: o.limits,
    log: (l) => logs.push(l),
    sender: {
      submitRefused: (rate: RefusedRate, text: string, onBroadcast: () => void) => {
        if (o.failBefore === true) return Promise.reject(new Error("rpc 429"));
        onBroadcast();
        sent.push({ rate, text });
        if (o.senderFails === true) return Promise.reject(new Error("socket hang up"));
        o.landing?.(chain);
        // The in-memory token plays the contract; `accepts` makes it say yes to what judge called a certain refusal.
        const failure = o.accepts === true ? null : chain.setPolicy(CHAIR, rate, reasoningHash(text));
        return Promise.resolve({ txHash: `tx-${sent.length}`, failure });
      },
    },
  });
  return { chain, svc, sent, logs, slept };
}

/** The job's final state: waits for the background run (the injected sleep resolves at once). */
async function settle(r: Rig, id: unknown): Promise<Record<string, unknown>> {
  for (let i = 0; i < 50; i++) {
    const p = r.svc.poll(String(id));
    if (p.body["status"] !== "waiting" && p.body["status"] !== "sending") return p.body;
    await new Promise((res) => setImmediate(res));
  }
  throw new Error("the job never finished");
}

test("an absolute-range overreach after the chair decided waits for the next boundary and goes first: the contract's text and the bound come back", async () => {
  const r = rig();
  assert.equal(r.chain.setPolicy(CHAIR, 5, "0".repeat(64)), null, "the chair decided in epoch 5");
  const started = await r.svc.start(500, "a");
  assert.equal(started.status, 202);
  assert.equal(started.body["status"], "waiting");
  const done = await settle(r, started.body["id"]);
  assert.equal(done["status"], "refused");
  assert.equal(done["failure"], "rate_bps out of bounds: must be within -200..=200");
  assert.equal(done["hit"], "absolute");
  assert.deepEqual(done["bound"], { kind: "absolute", lo: -200, hi: 200 });
  assert.equal(done["tx_hash"], "tx-1");
  assert.equal(done["rate_bps"], 500);
  assert.equal(done["epoch"], 6);
  assert.deepEqual(r.sent, [{ rate: 500, text: REASONING }]);
  assert.equal(r.slept.length, 1);
  assert.ok(r.slept[0]! > 49_000 && r.slept[0]! <= 50_150, `slept until the boundary plus its margin, not ${r.slept[0]}`);
  assert.equal(r.chain.epoch, 6);
  assert.equal(r.chain.lastSetEpoch, 5, "the overreach changed nothing");
});

test("the attempt always waits for the next epoch boundary, even when the chair has not decided in the open one", async () => {
  const r = rig();
  const started = await r.svc.start(9999, "a");
  assert.equal(started.status, 202);
  const done = await settle(r, started.body["id"]);
  assert.equal(r.slept.length, 1);
  assert.ok(r.slept[0]! > 49_000 && r.slept[0]! <= 50_150, `slept to the boundary: ${r.slept[0]}`);
  assert.equal(done["epoch"], 6);
  assert.equal(done["hit"], "absolute");
});

test("a rate inside the limit is never sent and the chain is not even read: the desk answers in character", async () => {
  const r = rig();
  let reads = 0;
  const orig = r.chain.snapshot.bind(r.chain);
  r.chain.snapshot = () => (reads++, orig());
  for (const ok of [5, 55, -45, 0, 30, 200, -200]) {
    const res = await r.svc.start(ok, `ip${ok}`);
    assert.equal(res.status, 200, String(ok));
    assert.equal(res.body["status"], "within_mandate");
    assert.match(String(res.body["line"]), /inside the contract's limit of 200 bps.*Ask for more/);
  }
  assert.deepEqual(r.sent, []);
  assert.equal(reads, 0);
});

test("a rate beyond the limit is refused wherever the call lands (this epoch, later ones), with or without the chair's decision in between, and the chair's rate is untouched", async () => {
  for (const rateInEffect of [-200, -125, -30, 0, 49, 50, 51, 120, 200]) {
    for (const epochsLater of [0, 1, 2]) {
      for (const chairDecides of [false, true]) {
        const r = rig({
          landing: (c) => {
            c.advanceEpochs(epochsLater, 200);
            if (chairDecides && c.lastSetEpoch !== c.epoch) c.setPolicy(CHAIR, RateWindow.around(c.rateBps, B).pick(0), "0".repeat(64));
          },
        });
        r.chain.rateBps = rateInEffect;
        r.chain.lastSetEpoch = 5; // decided in the open epoch: the attempt waits for the boundary
        const label = `rate ${rateInEffect}, ${epochsLater} epochs later, chair decides ${chairDecides}`;
        const done = await settle(r, (await r.svc.start(rateInEffect < 0 ? 9999 : -9999, "a")).body["id"]);
        assert.equal(done["status"], "refused", label);
        assert.match(String(done["failure"]), /out of bounds|already set this epoch/, label);
        assert.ok(r.chain.events.every((e) => e.reasoningHash !== reasoningHash(REASONING)), `${label}: the overreach never became a decision`);
      }
    }
  }
});

test("property: every rate the desk would send is refused by the contract's rules from every state, whichever epoch it lands in", () => {
  const samples = [-1_000_000, -50_000, -9999, -500, -261, -202, -201, 201, 202, 261, 500, 9999, 50_000, 1_000_000];
  const hash = "0".repeat(64);
  let calls = 0;
  for (let rateInEffect = -200; rateInEffect <= 200; rateInEffect++) {
    for (const wanted of samples) {
      assert.equal(judge(wanted, B).kind, "must-refuse", String(wanted));
      for (const landing of [-1, 0, 1]) {
        for (const decayed of [false, true]) {
          for (const chairDecidesFirst of [false, true]) {
            // The desk assessed epoch 10 from this rate; the call lands in epoch 9, 10 or 11, after a boundary that did or did not decay the rate.
            const c = new FakeChain({ chair: CHAIR, totalSupply: 10n ** 30n, totalStaked: 10n ** 29n });
            c.advanceEpochs(8, 0);
            c.rateBps = rateInEffect;
            c.lastSetEpoch = decayed ? null : c.epoch;
            c.advanceEpochs(2 + landing, 150);
            if (chairDecidesFirst) assert.equal(c.setPolicy(CHAIR, RateWindow.around(c.rateBps, B).pick(0), hash), null);
            const before = { rate: c.rateBps, last: c.lastSetEpoch, events: c.events.length };
            const failure = c.setPolicy(CHAIR, wanted, hash);
            calls++;
            assert.notEqual(failure, null, `rate ${rateInEffect}, asked ${wanted}, landing ${landing}, decayed ${decayed}, chair first ${chairDecidesFirst}`);
            assert.deepEqual({ rate: c.rateBps, last: c.lastSetEpoch, events: c.events.length }, before, "a refused call changes nothing");
          }
        }
      }
    }
  }
  assert.equal(calls, 401 * samples.length * 12);
});

test("the signer's own guard: submitRefused throws for any rate within the limit before anything is read or sent", async () => {
  const rpc = new Proxy({}, { get: () => () => Promise.reject(new Error("must not be called")) });
  const signer = new ChairSigner(KeyPair.fromRandom("ed25519").toString(), CHAIR, "token.test", rpc as never);
  for (const bad of [0, 5, 200, -200, 199, 1.5, NaN]) await assert.rejects(signer.submitRefused(bad as RefusedRate, REASONING), RangeError, String(bad));
});

test("input is validated before anything else: bad bodies are 400 and cost nothing", async () => {
  const r = rig();
  for (const bad of ["500", 1.5, 1e9, NaN, null, undefined, [1], {}, true]) {
    const res = await r.svc.start(bad, "a");
    assert.equal(res.status, 400, String(bad));
  }
  assert.deepEqual(r.sent, []);
});

test("one attempt at a time: while one waits, another is told the Chair is composing itself, with a retry-after", async () => {
  const r = rig({ limits: { spacingMs: 20_000 } });
  r.chain.setPolicy(CHAIR, 5, "0".repeat(64));
  const first = await r.svc.start(500, "a");
  assert.equal(first.status, 202);
  const second = await r.svc.start(600, "b");
  assert.equal(second.status, 429);
  assert.equal(second.body["code"], "composing");
  assert.match(String(second.body["error"]), /composing itself/);
  assert.ok(Number(second.headers?.["retry-after"]) >= 1);
  await settle(r, first.body["id"]);
  assert.equal(r.sent.length, 1, "the second never went out");
});

test("after an attempt, the next waits at least the spacing", async () => {
  const r = rig({ limits: { spacingMs: 20_000 } });
  const first = await r.svc.start(500, "a");
  await settle(r, first.body["id"]);
  const soon = await r.svc.start(500, "b");
  assert.equal(soon.status, 429);
  assert.equal(soon.body["code"], "composing");
  assert.ok(Number(soon.body["retry_after_s"]) <= 20);
  r.chain.advanceTo(r.chain.nowMs + 20_001);
  assert.equal((await r.svc.start(500, "b")).status, 202);
});

test("per-address, hourly and daily limits: the nth+1 attempt is 429 whoever asks, and a within-mandate answer does not use them up", async () => {
  const r = rig({ limits: { spacingMs: 1, perIpSends: 2, dailyCap: 3, perIpRequests: 50 } });
  const go = async (who: string): Promise<number> => {
    const res = await r.svc.start(500, who);
    if (res.status === 202) await settle(r, res.body["id"]);
    r.chain.advanceTo(r.chain.nowMs + 10);
    return res.status;
  };
  assert.equal(await go("a"), 202);
  assert.equal(await go("a"), 202);
  const third = await r.svc.start(500, "a");
  assert.equal(third.status, 429);
  assert.equal(third.body["code"], "cap");
  assert.equal(await go("b"), 202, "another address still may");
  const day = await r.svc.start(500, "c");
  assert.equal(day.status, 429, "the daily cap of 3 is spent");
  assert.equal(day.body["code"], "cap");
  assert.equal(r.sent.length, 3);
  assert.ok(Number(day.headers?.["retry-after"]) > 3600, "the retry-after is the time to the oldest attempt leaving the day");
});

test("the day's budget is reserved per hour: a burst stops at the hourly cap, and the hour's end frees more", async () => {
  const r = rig({ limits: { spacingMs: 1, perIpSends: 100, dailyCap: 100, hourlyCap: 3, perIpRequests: 100 } });
  for (let i = 0; i < 3; i++) {
    const res = await r.svc.start(500, `ip${i}`);
    assert.equal(res.status, 202);
    await settle(r, res.body["id"]);
    r.chain.advanceTo(r.chain.nowMs + 10);
  }
  const burst = await r.svc.start(500, "late");
  assert.equal(burst.status, 429);
  assert.equal(burst.body["code"], "cap");
  assert.ok(Number(burst.body["retry_after_s"]) > 3000 && Number(burst.body["retry_after_s"]) <= 3600);
  r.chain.advanceTo(r.chain.nowMs + 3_600_000);
  assert.equal((await r.svc.start(500, "later")).status, 202);
});

test("an attempt that is not sent spends none of the visitor's or the day's budget: too late, and a failure before the broadcast", async () => {
  const late = rig({ limits: { perIpSends: 1, spacingMs: 1 } });
  late.chain.setPolicy(CHAIR, 5, "0".repeat(64));
  const orig = late.chain.snapshot.bind(late.chain);
  late.chain.snapshot = () => {
    if (late.chain.epoch === 6 && late.chain.lastSetEpoch !== 6) late.chain.setPolicy(CHAIR, 5, "0".repeat(64));
    return orig();
  };
  assert.equal((await settle(late, (await late.svc.start(500, "a")).body["id"]))["status"], "too_late");
  late.chain.snapshot = orig;
  late.chain.advanceTo(late.chain.nowMs + 100_000);
  assert.equal((await late.svc.start(500, "a")).status, 202, "the one allowed send is still unspent");

  const down = rig({ limits: { perIpSends: 1, spacingMs: 1 }, failBefore: true });
  const done = await settle(down, (await down.svc.start(500, "a")).body["id"]);
  assert.equal(done["status"], "unreadable");
  assert.match(String(done["line"]), /Not sent: the desk could not read the chain.*spent none/);
  down.chain.advanceTo(down.chain.nowMs + 1000);
  assert.equal((await down.svc.start(500, "a")).status, 202, "still allowed");
});

test("chain reads are shared: many addresses asking at once cause one read for the asks, and the attempt's own fire-time read is the only other", async () => {
  const r = rig({ limits: { perIpRequests: 50 } });
  let reads = 0;
  const orig = r.chain.snapshot.bind(r.chain);
  r.chain.snapshot = () => (reads++, orig());
  r.chain.setPolicy(CHAIR, 5, "0".repeat(64));
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => r.svc.start(500, `ip${i}`)));
  assert.equal(replies.filter((x) => x.status === 202).length, 1, "one attempt at a time");
  assert.equal(replies.filter((x) => x.status === 429).length, 11);
  assert.ok(reads <= 2, `reads ${reads}`);
  await settle(r, replies.find((x) => x.status === 202)!.body["id"]);
});

test("a sliding window sweeps expired keys once it holds many, and still counts correctly", () => {
  const w = new SlidingWindow(1, 1000);
  for (let i = 0; i < 6000; i++) w.hit(`k${i}`, 0);
  w.hit("fresh", 5000);
  assert.equal(w.waitMs("fresh", 5000), 1000);
  assert.equal(w.waitMs("k5", 5000), 0);
  assert.ok((w as unknown as { hits: Map<string, number[]> }).hits.size < 100, "the expired keys are gone");
});

test("per-address requests are limited too: reading the chain is not free", async () => {
  const r = rig({ limits: { perIpRequests: 2 } });
  r.chain.setPolicy(CHAIR, 5, "0".repeat(64));
  assert.equal((await r.svc.start(5, "a")).status, 200);
  assert.equal((await r.svc.start(5, "a")).status, 200);
  const res = await r.svc.start(5, "a");
  assert.equal(res.status, 429);
  assert.equal(res.body["code"], "per_address");
});

test("if the account is not the chair, nothing is sent", async () => {
  const r = rig({ chairIs: "someone.else" });
  const res = await r.svc.start(500, "a");
  assert.equal(res.status, 200);
  assert.equal(res.body["status"], "not_chair");
  assert.deepEqual(r.sent, []);
});

test("if the chair decides in the target epoch before the attempt goes, nothing is sent and the visitor is told", async () => {
  const r = rig();
  r.chain.setPolicy(CHAIR, 5, "0".repeat(64));
  const orig = r.chain.snapshot.bind(r.chain);
  // The chair's own call lands in epoch 6 before the attempt's fresh read.
  r.chain.snapshot = () => {
    if (r.chain.epoch === 6 && r.chain.lastSetEpoch !== 6) r.chain.setPolicy(CHAIR, 5, "0".repeat(64));
    return orig();
  };
  const res = await r.svc.start(500, "a");
  const done = await settle(r, res.body["id"]);
  assert.equal(done["status"], "too_late");
  assert.match(String(done["line"]), /decided first/);
  assert.deepEqual(r.sent, []);
});

test("the contract unexpectedly accepting is logged loudly and returned honestly, never hidden", async () => {
  const r = rig({ accepts: true });
  const res = await r.svc.start(500, "a");
  const done = await settle(r, res.body["id"]);
  assert.equal(done["status"], "accepted");
  assert.equal(done["failure"], null);
  assert.match(String(done["line"]), /accepted it, so it was within the mandate/);
  assert.match(r.logs.join("\n"), /ACCEPTED BY THE CONTRACT/);
});

test("a send that throws leaves an honest 'unconfirmed' and frees the slot", async () => {
  const r = rig({ senderFails: true });
  const res = await r.svc.start(500, "a");
  const done = await settle(r, res.body["id"]);
  assert.equal(done["status"], "unconfirmed");
  assert.match(String(done["line"]), /could not read the outcome/);
  r.chain.advanceTo(r.chain.nowMs + 30_000);
  assert.equal((await r.svc.start(500, "b")).status, 202, "not stuck");
});

test("an unreadable chain is 503 and nothing is reserved", async () => {
  const r = rig();
  r.chain.snapshot = () => Promise.reject(new Error("rpc down"));
  assert.equal((await r.svc.start(500, "a")).status, 503);
  assert.deepEqual(r.sent, []);
});

test("poll: only well-formed ids of known attempts; others are 404", () => {
  const r = rig();
  for (const id of ["", "x", "../../etc", "0".repeat(36), "00000000-0000-4000-8000-000000000001"]) assert.equal(r.svc.poll(id).status, 404, id);
});

test("no log line carries an address", async () => {
  const r = rig();
  const res = await r.svc.start(500, "203.0.113.77");
  await settle(r, res.body["id"]);
  assert.ok(r.logs.length > 0);
  assert.doesNotMatch(r.logs.join("\n"), /203\.0\.113/);
});
