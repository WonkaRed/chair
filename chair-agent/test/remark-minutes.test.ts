import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tick } from "../src/agent.js";
import { decide } from "../src/decide.js";
import { FakeChain } from "../src/fake-chain.js";
import { LlmChair, type LlmClient, type LlmRequest } from "../src/llm-chair.js";
import { DecisionLog, findReasoning, verifyLog } from "../src/log.js";
import { reasoningHash } from "../src/reasoning.js";
import { PressStore, type PressEntry } from "../src/press-store.js";
import { BOOK } from "../src/press-book.js";
import { bookLine, REMARK_MEMORY } from "../src/remark.js";
import { mandateRate, ruleChair, statement } from "../src/rule-chair.js";
import type { Chair, Decision } from "../src/types.js";
import { PATIENT_MS, snapshot, tempDir } from "./helpers.js";

const REMARK = "The Chair has appointed a subcommittee of the Chair to look into the Chair.";
const opts = (chair: Chair, timeoutMs = PATIENT_MS) => ({ chair, marginMs: 15_000, timeoutMs });
const snap = snapshot({ rate: 24, staked: 404_000n }); // 40.4% staked: the formula holds the rate at 24
/** What the agent writes for a meeting that holds the rate at 24: the statement, up to the closing. */
const BODY = statement({ snapshot: snap, history: [], window: { lo: -50, hi: 50 } }, 24);

/** An AI chair whose decision is fixed and whose remark is `remark`. */
const chairWith = (remark: Chair["remark"]): Chair => ({
  name: "llm:stand-in",
  propose: () => Promise.resolve({ rateBps: 24, reason: "steady" }),
  ...(remark === undefined ? {} : { remark }),
});

test("the minutes of an AI chair close on its own remark, which is recorded as such; the text is body, a space, the remark", async () => {
  const d = await decide(snap, [], opts(chairWith(() => Promise.resolve(REMARK))));
  assert.equal(d.kind, "llm");
  assert.equal(d.remark, REMARK);
  assert.ok(d.reasoning.endsWith(`${BODY} ${REMARK}`), d.reasoning);
  assert.equal(d.reasoningHash, reasoningHash(d.reasoning), "the hash is of the text with the remark in it");
});

test("with no usable remark the minutes close on the book line of the meeting, and the record says there was no remark", async () => {
  const none = await decide(snap, [], opts(chairWith(() => Promise.resolve(null))));
  assert.equal(none.remark, null);
  assert.ok(none.reasoning.endsWith(`${BODY} ${bookLine(snap.policy.epoch)}`), none.reasoning);
  const noMethod = await decide(snap, [], opts(chairWith(undefined)));
  assert.equal(noMethod.remark, null);
  assert.ok(noMethod.reasoning.endsWith(bookLine(snap.policy.epoch)));
});

test("a remark that throws changes nothing about the decision", async () => {
  const d = await decide(snap, [], opts(chairWith(() => Promise.reject(new Error("model fell over")))));
  assert.deepEqual([d.kind, d.rate, d.remark], ["llm", 24, null]);
  assert.ok(d.reasoning.includes(BODY));
});

test("a remark that never answers costs the decision nothing but the remark's own time, and the book closes the minutes", async () => {
  // 1.6 s: the least time limit that still leaves the remark a turn (it is not asked for with under 1.5 s left); the remark takes all of it and loses.
  const d = await decide(snap, [], opts(chairWith(() => new Promise(() => undefined)), 1600));
  assert.deepEqual([d.kind, d.rate, d.remark], ["llm", 24, null]);
  assert.ok(d.reasoning.endsWith(bookLine(snap.policy.epoch)));
});

test("with too little of the decision's time left the remark is not asked for at all", async () => {
  let asked = 0;
  const d = await decide(snap, [], opts(chairWith(() => { asked++; return Promise.resolve(REMARK); }), 1000));
  assert.equal(asked, 0);
  assert.equal(d.remark, null);
  assert.equal(d.kind, "llm");
});

test("the remark is given the rate the chair proposed, and the same chain facts the decision was made on", async () => {
  let seen: unknown;
  await decide(snap, [], opts(chairWith((input, rateBps) => { seen = { rateBps, epoch: input.snapshot.policy.epoch }; return Promise.resolve(null); })));
  assert.deepEqual(seen, { rateBps: 24, epoch: snap.policy.epoch });
});

test("the rule chair and a fallen-back chair write their own closing line and no remark", async () => {
  const rule = await decide(snap, [], opts(ruleChair));
  assert.equal(rule.remark, null);
  assert.match(rule.reasoning, /The Chair (?:calls this leadership|files no objection)\.$|The motion carries unanimously\.$|thanks itself for its service\.$/);
  let asked = 0;
  const failing: Chair = { name: "llm:down", propose: () => Promise.reject(new Error("down")), remark: () => { asked++; return Promise.resolve(REMARK); } };
  const fell = await decide(snap, [], opts(failing));
  assert.deepEqual([fell.kind, fell.remark, asked], ["rule-fallback", null, 0]);
});

// The agent, the log and the model together.

const CHAIR = "chair.test";
function world(): { chain: FakeChain; log: DecisionLog; done: () => void } {
  const dir = tempDir("remark-agent");
  const chain = new FakeChain({ chair: CHAIR, totalSupply: 1_000_000n * 10n ** 24n, totalStaked: 380_000n * 10n ** 24n });
  chain.advanceTo(chain.params.startMs + 1000);
  return { chain, log: new DecisionLog(join(dir, "decisions.jsonl"), { token: "token.test", account: CHAIR }), done: () => rmSync(dir, { recursive: true, force: true }) };
}
const agentDeps = (w: ReturnType<typeof world>, chair: Chair, reader: { snapshot: FakeChain["snapshot"] } = w.chain) => ({
  reader, log: w.log, chairAccount: CHAIR, submitter: w.chain, decideOptions: { chair, marginMs: 15_000, timeoutMs: PATIENT_MS },
});

/** A model that decides a rate of 10 and, when asked for a remark (the call that carries a schema), answers from `remarks` in turn. */
function scripted(remarks: string[]): LlmClient & { remarkPrompts: LlmRequest[] } {
  const remarkPrompts: LlmRequest[] = [];
  return {
    remarkPrompts,
    complete: (req) => {
      if (req.schema === undefined) return Promise.resolve({ text: JSON.stringify({ rate_bps: 10, reason: "smaller_move" }), stopReason: "end_turn" });
      remarkPrompts.push(req);
      return Promise.resolve({ text: JSON.stringify({ remark: remarks[remarkPrompts.length - 1] ?? "" }), stopReason: "end_turn" });
    },
  };
}

test("through the agent: the remark is in the logged text, recorded in the decision, hashed, and remembered for the next meeting", async () => {
  const w = world();
  try {
    const second = "The Committee of One was unanimous, and the Chair intends to be shocked about it later.";
    const client = scripted([REMARK, REMARK, second]);
    const chair = new LlmChair(client);

    assert.equal((await tick(agentDeps(w, chair))).status, "executed");
    const first = w.log.epochState(w.chain.epoch).decision!;
    assert.equal(first.remark, REMARK);
    assert.ok(first.reasoning.endsWith(` ${REMARK}`));
    assert.equal(first.reasoning_hash, reasoningHash(first.reasoning));
    assert.equal(findReasoning(w.log.path, first.reasoning_hash), first.reasoning);
    assert.deepEqual(w.log.memory(w.chain.epoch + 1, 10).remarks, [REMARK]);

    // The next meeting: the model repeats itself, is refused (the log remembers), and its second try is a new line.
    w.chain.advanceEpochs(1, 1000);
    assert.equal((await tick(agentDeps(w, chair))).status, "executed");
    const next = w.log.epochState(w.chain.epoch).decision!;
    assert.equal(next.remark, second);
    assert.deepEqual((JSON.parse(client.remarkPrompts[1]!.user) as { already_said: string[] }).already_said, [REMARK], "the log's remark is in the next prompt");
    assert.ok(verifyLog(w.log.path).ok);
  } finally {
    w.done();
  }
});

test("a model that cannot write a passing remark still decides: the minutes close on the book and the record has no remark", async () => {
  const w = world();
  try {
    const res = await tick(agentDeps(w, new LlmChair(scripted(["buy now", "buy now"]))));
    assert.equal(res.status, "executed");
    const rec = w.log.epochState(w.chain.epoch).decision!;
    assert.equal(rec.chair_kind, "llm");
    assert.equal(rec.remark, null);
    assert.ok(rec.reasoning.endsWith(bookLine(w.chain.epoch)));
    assert.deepEqual(w.log.memory(w.chain.epoch + 1, 10).remarks, [], "a book line is not a remark and is not remembered");
  } finally {
    w.done();
  }
});

test("the remark history is read from the log, newest last, and held to REMARK_MEMORY; lines without a remark are skipped", async () => {
  const w = world();
  try {
    const base: Decision = await decide(snap, [], opts(ruleChair));
    for (let e = 1; e <= REMARK_MEMORY + 5; e++) {
      const reasoning = `meeting ${e}`;
      const remark = e % 7 === 0 ? null : `Remark ${e}`;
      w.log.recordDecision({ ...base, epoch: e, reasoning, reasoningHash: reasoningHash(reasoning), remark }, snap);
    }
    const remarks = w.log.memory(99, 0).remarks;
    assert.equal(remarks.length, REMARK_MEMORY);
    assert.equal(remarks.at(-1), `Remark ${REMARK_MEMORY + 5}`);
    assert.ok(!remarks.includes("Remark 7") && !remarks.some((r) => r === "null"));
    assert.deepEqual(remarks, [...remarks].sort((a, b) => Number(a.slice(7)) - Number(b.slice(7))), "oldest first");
  } finally {
    w.done();
  }
});

// One read: the text, the logged figures and the decision's mandate all come from the same read of the chain.

/** A reader that returns the chain as it is, and moves the stake right after the first read: the second read sees another share. */
function stakeMovesAfterFirstRead(chain: FakeChain, to: bigint): { snapshot: FakeChain["snapshot"] } {
  let reads = 0;
  return {
    snapshot: async () => {
      const s = await chain.snapshot();
      if (++reads === 1) chain.totalStaked = to;
      return s;
    },
  };
}

test("a stake that moves while the model thinks: the minutes, the logged stake and the mandate are all of the read taken after the answer, and the answer is checked against it", async () => {
  const w = world();
  try {
    const reader = stakeMovesAfterFirstRead(w.chain, 422_600n * 10n ** 24n);
    const choosing: LlmClient = {
      complete: (req) => {
        if (req.schema !== undefined) return Promise.resolve({ text: JSON.stringify({ remark: "" }), stopReason: "end_turn" });
        return Promise.resolve({ text: JSON.stringify({ rate_bps: 30, reason: "stake_low" }), stopReason: "end_turn" }); // the formula for the 38% the model sees; still a fair choice for 42.26%
      },
    };
    assert.equal((await tick(agentDeps(w, new LlmChair(choosing), reader))).status, "executed");
    const rec = w.log.epochState(w.chain.epoch).decision!;
    const after = await w.chain.snapshot();
    assert.equal(rec.chair_kind, "llm");
    assert.ok(rec.reasoning.includes("42.26% of all coins are staked"), rec.reasoning);
    assert.ok(!rec.reasoning.includes("38.00%"), "nothing cites the read the model saw");
    assert.ok(rec.reasoning.includes("The formula suggested printing 0.19% a day. The Chair chose printing 0.30% a day: fewer than half of all coins are staked."), rec.reasoning);
    assert.equal(rec.total_staked, after.staking!.totalStaked.toString());
    assert.equal(rec.mandate_rate_bps, mandateRate(after));
    assert.equal(rec.formula_bps, 19);
  } finally {
    w.done();
  }
});

test("a stake that moves so that the reason no longer holds: the answer is not used, the rule chair decides on the fresh read and the minutes say so", async () => {
  const w = world();
  try {
    const reader = stakeMovesAfterFirstRead(w.chain, 600_000n * 10n ** 24n);
    const choosing: LlmClient = {
      complete: (req) => Promise.resolve({ text: JSON.stringify(req.schema !== undefined ? { remark: "" } : { rate_bps: 30, reason: "stake_low" }), stopReason: "end_turn" }),
    };
    assert.equal((await tick(agentDeps(w, new LlmChair(choosing), reader))).status, "executed");
    const rec = w.log.epochState(w.chain.epoch).decision!;
    assert.equal(rec.chair_kind, "rule-fallback");
    assert.ok(rec.reasoning.includes("gave an answer that no longer fit the chain when it arrived, so the rule chair, the Chair's built-in fallback, decided this meeting."), rec.reasoning);
    assert.ok(rec.reasoning.includes("60.00% of all coins are staked"), rec.reasoning);
    assert.equal(rec.reason, "fallback");
  } finally {
    w.done();
  }
});

test("the same for the rule chair: nothing it writes cites a read other than the one it is logged against", async () => {
  const w = world();
  try {
    const reader = stakeMovesAfterFirstRead(w.chain, 422_600n * 10n ** 24n);
    assert.equal((await tick(agentDeps(w, ruleChair, reader))).status, "executed");
    const rec = w.log.epochState(w.chain.epoch).decision!;
    const after = await w.chain.snapshot();
    assert.ok(rec.reasoning.includes("42.26% of all coins are staked"), rec.reasoning);
    assert.equal(rec.total_staked, after.staking!.totalStaked.toString());
    assert.equal(rec.mandate_rate_bps, mandateRate(after));
  } finally {
    w.done();
  }
});

test("the decision prompt has no free text for the model to write and names no closing line: the minutes' closing is the remark step's alone", async () => {
  const { buildPrompt } = await import("../src/llm-chair.js");
  const { system } = buildPrompt({ snapshot: snap, history: [], window: { lo: -50, hi: 50 } });
  assert.match(system, /Answer with JSON only: \{"rate_bps": <integer>, "reason": <id>\}/);
  assert.doesNotMatch(system, /asks that this be recorded|thanks itself|carries unanimously|no further comment|taking questions/);
});

test("a decision that crosses an epoch rollover is filed, with its supply, under the epoch it is for", async () => {
  const w = world();
  try {
    const first = w.chain.epoch;
    let reads = 0;
    const reader = {
      snapshot: async () => {
        const s = await w.chain.snapshot();
        if (++reads === 1) w.chain.advanceEpochs(1, 1000);
        return s;
      },
    };
    const res = await tick(agentDeps(w, new LlmChair(scripted([])), reader));
    assert.equal(res.status, "executed");
    const rec = w.log.epochState(first + 1).decision!;
    assert.equal(rec.epoch, first + 1, "the decision is for the new epoch");
    assert.equal(rec.supply_epoch, first + 1, "its figures are of the read taken after the answer, in the new epoch");
    assert.deepEqual(w.log.history(first + 2).map((p) => p.epoch), [first + 1], "so the history has the supply once, at the epoch it belongs to");
  } finally {
    w.done();
  }
});

test("no model call of a meeting, the decision's or the remark's, holds a word a visitor wrote; the minutes still carry the press section", async () => {
  const w = world();
  try {
    const press = new PressStore(join(w.log.path, "..", "press.jsonl"));
    const SENTINEL = "SENTINEL-xyzzy-what-is-the-rate";
    const entry: PressEntry = { id: "id-1", question: SENTINEL, questionHash: reasoningHash(SENTINEL), answer: BOOK[0]!, source: "model", askedAtMs: 1, epoch: null, txHash: null };
    press.add(entry);
    const seen: string[] = [];
    const inner = scripted([REMARK]);
    const recording: LlmClient = { complete: (req) => { seen.push(`${req.system}\n${req.user}`); return inner.complete(req); } };
    const res = await tick({ ...agentDeps(w, new LlmChair(recording)), press });
    assert.equal(res.status, "executed");
    if (res.status !== "executed") return;
    assert.ok(seen.length >= 2, "both the decision call and the remark call were made");
    assert.ok(inner.remarkPrompts.length >= 1, "(the remark call among them)");
    for (const call of seen) assert.ok(!call.includes(SENTINEL) && !call.includes(reasoningHash(SENTINEL).slice(0, 12)), "no call sees the question or its hash");
    assert.ok(res.decision.reasoning.includes(reasoningHash(SENTINEL).slice(0, 12)) && !res.decision.reasoning.includes(SENTINEL), "the minutes name the question by hash only");
    assert.ok(res.decision.reasoning.includes(REMARK) && res.decision.reasoning.includes(BOOK[0]!), "the remark and the press answer are both in the text");
  } finally {
    w.done();
  }
});
