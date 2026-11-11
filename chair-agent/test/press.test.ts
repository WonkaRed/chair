import assert from "node:assert/strict";
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tick } from "../src/agent.js";
import { decide, finalize, propose } from "../src/decide.js";
import { FakeChain } from "../src/fake-chain.js";
import { buildPrompt, LlmChair, type LlmRequest } from "../src/llm-chair.js";
import { DecisionLog } from "../src/log.js";
import { stayOffTheModel } from "../src/press-answer.js";
import { BOOK } from "../src/press-book.js";
import { pressSection } from "../src/press-section.js";
import { cleanQuestion, DECISION_MARKER_MAX_MS, entryLine, PressStore, toPublic, type PressEntry } from "../src/press-store.js";
import { cleanReasoning, MAX_REASONING_CHARS, reasoningHash } from "../src/reasoning.js";
import { ruleChair } from "../src/rule-chair.js";
import type { Chair } from "../src/types.js";
import { PATIENT_MS, snapshot, tempDir } from "./helpers.js";

const entry = (question: string, answer: string, askedAtMs = 1): PressEntry => ({
  id: `id-${askedAtMs}`, question, questionHash: reasoningHash(question), answer, source: "model", askedAtMs, epoch: null, txHash: null,
});

function store(): { store: PressStore; path: string; done: () => void } {
  const dir = tempDir("press");
  const path = join(dir, "press.jsonl");
  return { store: new PressStore(path), path, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const addAll = (s: PressStore, items: PressEntry[]): void => items.forEach((e) => s.add(e));

// ---- cleaning and the store

test("cleanQuestion: one clean line of 1 to 140 characters, the form that is hashed", () => {
  assert.equal(cleanQuestion("  wen\n\n moon\t? "), "wen moon ?");
  assert.equal(cleanQuestion("a\u0000b\u200bc"), "a bc", "a control character becomes a space, an invisible one is removed");
  assert.equal(cleanQuestion("   \n "), null);
  assert.equal(cleanQuestion(""), null);
  assert.equal(cleanQuestion("x".repeat(140))?.length, 140);
  assert.equal(cleanQuestion("x".repeat(141)), null, "over the limit after cleaning is refused, never cut");
  assert.equal(cleanQuestion(`x${" ".repeat(300)}y`), "x y", "whitespace is collapsed before the length is taken");
});

test("the store keeps the question for the hash, shows the public only its hash, and survives damaged lines and two writers", () => {
  const { store: s, path, done } = store();
  try {
    addAll(s, [entry("secret question one", BOOK[0]!, 1), entry("secret question two", BOOK[1]!, 2)]);
    appendFileSync(path, "not json\n");
    appendFileSync(path, `${JSON.stringify({ v: 1, kind: "ask", id: "forged", question: "q", question_hash: "0".repeat(64), answer: BOOK[0], source: "model", asked_at_ms: 3 })}\n`);
    const other = new PressStore(path);
    assert.deepEqual(other.recent(10).map((e) => e.id), ["id-2", "id-1"], "newest first; a bad line and a forged hash are skipped");
    for (const e of s.recent(10)) {
      const shown = JSON.stringify(toPublic(e));
      assert.ok(!shown.includes("secret"), "the question text is never in the public shape");
      assert.deepEqual(Object.keys(toPublic(e)).sort(), ["answer", "asked_at_ms", "epoch", "id", "question_hash", "tx_hash"]);
    }
    s.add(entry("later", BOOK[2]!, 3));
    assert.equal(other.pending().length, 3, "a second reader sees a write made through the first, without a restart");
  } finally {
    done();
  }
});

test("a row whose answer is not a line of the book is not an entry, even with a valid question hash: never pending, never in the record", () => {
  const { store: s, path, done } = store();
  try {
    const row = (id: string, question: string, answer: string, askedAtMs: number): string =>
      `${JSON.stringify({ v: 1, kind: "ask", id, question, question_hash: reasoningHash(question), answer, source: "model", asked_at_ms: askedAtMs })}\n`;
    appendFileSync(path, row("old", "an earlier design", "The Chair has noted it.", 1));
    appendFileSync(path, row("book", "a book answer", BOOK[3]!, 2));
    appendFileSync(path, row("edit", "a hand edit", `${BOOK[3]!} And more.`, 3));
    const reread = new PressStore(path);
    assert.deepEqual(reread.recent(10).map((e) => e.id), ["book"]);
    assert.deepEqual(reread.pending().map((e) => e.id), ["book"]);
    assert.equal(s.recent(10).length, 1);
  } finally {
    done();
  }
});

test("markEntered marks exactly the entries whose line is in the minutes that were sent, once", () => {
  const { store: s, done } = store();
  try {
    const [a, b, c] = [entry("qa", BOOK[0]!, 1), entry("qb", BOOK[1]!, 2), entry("qc", BOOK[2]!, 3)] as [PressEntry, PressEntry, PressEntry];
    addAll(s, [a, b, c]);
    const minutes = `header\n${entryLine(a)}\n${entryLine(c)}\nfooter`;
    assert.equal(s.markEntered(minutes, 42, "tx1"), 2);
    assert.equal(s.markEntered(minutes, 43, "tx2"), 0, "an entry is entered once");
    const byId = new Map(s.recent(10).map((e) => [e.id, e]));
    assert.deepEqual([byId.get(a.id)?.epoch, byId.get(a.id)?.txHash], [42, "tx1"]);
    assert.equal(byId.get(b.id)?.epoch, null);
    assert.deepEqual(s.pending().map((e) => e.id), [b.id]);
    assert.equal(s.markEntered(`${entryLine(b).slice(0, -3)}`, 44, "tx3"), 0, "a line that is not whole does not count");
  } finally {
    done();
  }
});

test("two identical entries with room for one in the minutes: exactly one is marked, the oldest", () => {
  const { store: s, done } = store();
  try {
    const [a, b] = [entry("same question", BOOK[0]!, 1), entry("same question", BOOK[0]!, 2)] as [PressEntry, PressEntry];
    addAll(s, [a, b]);
    assert.equal(entryLine(a), entryLine(b));
    assert.equal(s.markEntered(`header\n${entryLine(a)}`, 50, "tx1"), 1);
    assert.deepEqual(s.pending().map((e) => e.id), [b.id], "the second copy is still waiting");
    assert.equal(s.markEntered(`header\n${entryLine(a)}\n${entryLine(b)}`, 51, "tx2"), 1, "and is marked by a text that holds it");
    assert.equal(s.pending().length, 0);
  } finally {
    done();
  }
});

// ---- the press section of the minutes

test("pressSection: the count, then up to two entries oldest first, hash prefix and answer, never the question", () => {
  assert.equal(pressSection([]), "");
  const one = pressSection([entry("what is the plan", "The plan is the Chair.")]);
  assert.match(one, /^\nThe press asked 1 question since the last meeting\.\nA member of the press asked a question \([0-9a-f]{12}\)\. The Chair replied: The plan is the Chair\.$/);
  assert.ok(!one.includes("what is the plan"));
  const three = pressSection([entry("q1", "A1.", 1), entry("q2", "A2.", 2), entry("q3", "A3.", 3)]);
  assert.match(three, /^\nThe press asked 3 questions since the last meeting\. The Chair enters 2 here and the rest at the next meeting\./);
  assert.ok(three.includes("A1.") && three.includes("A2.") && !three.includes("A3."));
  assert.ok(three.includes(`(${reasoningHash("q1").slice(0, 12)})`));
});

test("pressSection drops entries rather than overrun the room it was given, and writes nothing when none fits", () => {
  const long = "x".repeat(240);
  const p = [entry("q1", long, 1), entry("q2", long, 2)];
  const both = pressSection(p);
  assert.equal(both.split("\n").length, 4);
  const room = both.length - 1;
  const fewer = pressSection(p, room);
  assert.ok(fewer.length <= room && fewer.split("\n").length === 3 && fewer.includes("enters 1 here"));
  assert.equal(pressSection(p, 100), "");
});

test("the decision text with a press section stays inside 2000 characters, is clean as it stands, and the hash is of that exact text", async () => {
  const snap = snapshot({ epoch: 9, rate: 10, staked: 100n });
  const pend = [entry("q1", "y".repeat(240), 1), entry("q2", "z".repeat(240), 2), entry("q3", "v", 3)];
  const sections: string[] = [];
  for (const bodyChars of [1500, 1300, 1000, 600, 10]) {
    const chair: Chair = { name: "llm:big", propose: () => Promise.resolve({ rateBps: 20, reasoning: "w".repeat(bodyChars) }) };
    const opts = { chair, marginMs: 15_000, timeoutMs: PATIENT_MS };
    const plain = await decide(snap, [], opts);
    const withPress = finalize(snap, [], await propose(snap, [], opts), opts, pend);
    assert.ok(withPress.reasoning.length <= MAX_REASONING_CHARS, `${bodyChars}`);
    assert.equal(cleanReasoning(withPress.reasoning), withPress.reasoning, `${bodyChars}: clean as it stands`);
    assert.equal(withPress.reasoningHash, reasoningHash(withPress.reasoning), `${bodyChars}: the hash is of the whole text`);
    assert.ok(withPress.reasoning.startsWith(plain.reasoning), `${bodyChars}: the decision text is untouched; the press section only follows it`);
    assert.equal(withPress.rate, plain.rate, `${bodyChars}: the rate does not depend on the press`);
    assert.equal(withPress.kind, plain.kind);
    sections.push(withPress.reasoning.slice(plain.reasoning.length));
  }
  assert.equal(sections[0], "", "a body that leaves no room carries no press section; the questions wait for the next meeting");
  assert.ok(sections[1]!.includes("The press asked 3 questions") && sections[1]!.includes("enters 1 here"), "one entry fits");
  assert.ok(sections[4]!.includes(entryLine(pend[0]!)) && sections[4]!.includes(entryLine(pend[1]!)) && !sections[4]!.includes(entryLine(pend[2]!)), "two entries fit in full, oldest first");
});

// ---- the agent: pending questions go into the minutes, and are marked when the transaction lands

const CHAIR = "chair.test";
function world(): { chain: FakeChain; log: DecisionLog; press: PressStore; done: () => void } {
  const dir = tempDir("press-agent");
  const chain = new FakeChain({ chair: CHAIR, totalSupply: 1_000_000n * 10n ** 24n, totalStaked: 100_000n * 10n ** 24n });
  chain.advanceTo(chain.params.startMs + 1000);
  return {
    chain, log: new DecisionLog(join(dir, "decisions.jsonl"), { token: "token.test", account: CHAIR }), press: new PressStore(join(dir, "press.jsonl")),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}
const deps = (w: ReturnType<typeof world>) => ({
  reader: w.chain, log: w.log, chairAccount: CHAIR, submitter: w.chain, press: w.press, decideOptions: { chair: ruleChair, marginMs: 15_000, timeoutMs: PATIENT_MS },
});

test("an epoch's decision enters two pending questions on chain and marks them with its epoch and transaction; the third waits", async () => {
  const w = world();
  try {
    addAll(w.press, [entry("one", BOOK[0]!, 1), entry("two", BOOK[1]!, 2), entry("three", BOOK[2]!, 3)]);
    const res = await tick(deps(w));
    assert.equal(res.status, "executed");
    if (res.status !== "executed") return;
    assert.ok(res.decision.reasoning.includes("The press asked 3 questions since the last meeting."));
    assert.ok(res.decision.reasoning.includes(`(${reasoningHash("one").slice(0, 12)}). The Chair replied: ${BOOK[0]}`));
    assert.ok(!res.decision.reasoning.includes("one\n") && !/ask(ed)? .*\bone\b.*\?/.test(res.decision.reasoning), "no question text");
    const byId = new Map(w.press.recent(10).map((e) => [e.id, e]));
    assert.deepEqual([byId.get("id-1")?.epoch, byId.get("id-1")?.txHash], [res.decision.epoch, res.txHash]);
    assert.equal(byId.get("id-2")?.epoch, res.decision.epoch);
    assert.equal(byId.get("id-3")?.epoch, null);
    // The next epoch carries the third.
    w.chain.advanceEpochs(1, 1000);
    const next = await tick(deps(w));
    assert.ok(next.status === "executed" && next.decision.reasoning.includes(BOOK[2]!) && next.decision.reasoning.includes("The press asked 1 question since"));
    assert.equal(w.press.pending().length, 0);
    // An epoch with no question has no press section at all.
    w.chain.advanceEpochs(1, 1000);
    const quiet = await tick(deps(w));
    assert.ok(quiet.status === "executed" && !quiet.decision.reasoning.includes("press"));
  } finally {
    w.done();
  }
});

test("a dry run shows the press section but marks nothing; a failed send marks nothing and the re-send marks once it lands; a refusal marks nothing", async () => {
  const w = world();
  try {
    addAll(w.press, [entry("one", BOOK[0]!, 1)]);
    const dry = await tick({ ...deps(w), submitter: null });
    assert.ok(dry.status === "dry-run" && dry.decision.reasoning.includes(BOOK[0]!));
    assert.equal(w.press.pending().length, 1);
    let calls = 0;
    const flaky = { submit: (d: Parameters<FakeChain["submit"]>[0]) => (calls++ < 1 ? Promise.reject(new Error("blip")) : w.chain.submit(d)) };
    assert.equal((await tick({ ...deps(w), submitter: flaky })).status, "send-failed");
    assert.equal(w.press.pending().length, 1, "not on chain yet");
    const again = await tick({ ...deps(w), submitter: flaky });
    assert.equal(again.status, "executed");
    assert.equal(w.press.pending().length, 0, "the re-sent text carried the question, so it is entered");
    w.press.add(entry("two", BOOK[1]!, 2));
    w.chain.advanceEpochs(1, 1000);
    const refusing = { submit: () => Promise.resolve({ txHash: "t", failure: "rate step too large" }) };
    assert.equal((await tick({ ...deps(w), submitter: refusing })).status, "rejected");
    assert.equal(w.press.pending().length, 1, "a refused call is not on chain");
  } finally {
    w.done();
  }
});

test("a press record that cannot be read never costs the chair its decision", async () => {
  const w = world();
  try {
    const broken = { pending: () => { throw new Error("disk"); }, markEntered: () => { throw new Error("disk"); } } as unknown as PressStore;
    const res = await tick({ ...deps(w), press: broken });
    assert.equal(res.status, "executed");
  } finally {
    w.done();
  }
});

// ---- the chair's memory

test("memory counts epochs in a row the chair itself set the rate now in effect, and the refusals in its log", async () => {
  const w = world();
  try {
    const set = async (rate: number): Promise<void> => {
      const chair: Chair = { name: "llm:c", propose: () => Promise.resolve({ rateBps: rate, reasoning: "r" }) };
      const res = await tick({ ...deps(w), decideOptions: { chair, marginMs: 15_000, timeoutMs: PATIENT_MS } });
      assert.equal(res.status, "executed");
      w.chain.advanceEpochs(1, 1000);
    };
    await set(10);
    await set(10);
    await set(10);
    assert.deepEqual(w.log.memory(w.chain.epoch, 10), { sameRateEpochs: 3, refusals: 0 });
    assert.equal(w.log.memory(w.chain.epoch, 20).sameRateEpochs, 0, "a different rate in effect: nothing in a row");
    w.chain.advanceEpochs(1, 1000);
    assert.equal(w.log.memory(w.chain.epoch, 10).sameRateEpochs, 0, "a silent epoch breaks the run");
    const refusing = { submit: () => Promise.resolve({ txHash: "t", failure: "rate step too large" }) };
    assert.equal((await tick({ ...deps(w), submitter: refusing })).status, "rejected");
    assert.equal(w.log.memory(w.chain.epoch, 10).refusals, 1);
  } finally {
    w.done();
  }
});

test("the decision prompt carries the memory as the log's numbers, only when it has them, and the system prompt says how far they may be read", () => {
  const snap = snapshot({ epoch: 20, rate: -5, lastSet: 19, staked: 10n });
  const input = { snapshot: snap, history: [], window: { lo: -50, hi: 50 } };
  assert.ok(!("epochs_in_a_row_the_chair_set_the_rate_in_effect" in (JSON.parse(buildPrompt(input).user) as object)));
  const withMemory = JSON.parse(buildPrompt({ ...input, memory: { sameRateEpochs: 4, refusals: 0 } }).user) as Record<string, unknown>;
  assert.equal(withMemory["epochs_in_a_row_the_chair_set_the_rate_in_effect"], 4);
  assert.equal(withMemory["times_the_contract_refused_the_chair"], null, "no refusal on record is null: the Chair never says zero times");
  const none = JSON.parse(buildPrompt({ ...input, memory: { sameRateEpochs: 0, refusals: 2 } }).user) as Record<string, unknown>;
  assert.equal(none["epochs_in_a_row_the_chair_set_the_rate_in_effect"], null, "no run is null, which the prompt says never to mention");
  assert.equal(none["times_the_contract_refused_the_chair"], 2);
  const { system } = buildPrompt(input);
  assert.match(system, /epochs_in_a_row_the_chair_set_the_rate_in_effect: when present/);
  assert.match(system, /times_the_contract_refused_the_chair, when not null/);
  assert.doesNotMatch(system, /[\u2013\u2014\p{Extended_Pictographic}]|moon/u);
});

test("the agent hands the log's memory to the model through the chair", async () => {
  const w = world();
  try {
    const seen: string[] = [];
    const chair = new LlmChair({ complete: (req: LlmRequest) => { seen.push(req.user); return Promise.resolve({ text: JSON.stringify({ rate_bps: 10, reasoning: "ok" }), stopReason: "end_turn" }); } });
    const opts = { chair, marginMs: 15_000, timeoutMs: PATIENT_MS };
    assert.equal((await tick({ ...deps(w), decideOptions: opts })).status, "executed");
    w.chain.advanceEpochs(1, 1000);
    assert.equal((await tick({ ...deps(w), decideOptions: opts })).status, "executed");
    w.chain.advanceEpochs(1, 1000);
    assert.equal((await tick({ ...deps(w), decideOptions: opts })).status, "executed");
    const run = (i: number) => (JSON.parse(seen[i]!) as Record<string, unknown>)["epochs_in_a_row_the_chair_set_the_rate_in_effect"];
    assert.equal(run(0), null);
    assert.equal(run(1), null, "one epoch is not a run");
    assert.equal(run(2), 2);
  } finally {
    w.done();
  }
});

test("the decision marker: the agent holds it exactly while it waits on the model, even when the model fails; a stale one counts for nothing", async () => {
  const w = world();
  try {
    assert.equal(w.press.decisionBusy(), false);
    w.press.decisionStarted();
    assert.equal(w.press.decisionBusy(), true);
    assert.equal(w.press.decisionBusy(Date.now() + DECISION_MARKER_MAX_MS + 1000), false, "a crash's leftover is ignored once it is old");
    w.press.decisionDone();
    assert.equal(w.press.decisionBusy(), false);
    w.press.decisionDone();

    const busyDuring: boolean[] = [];
    const ok = new LlmChair({ complete: () => { busyDuring.push(w.press.decisionBusy()); return Promise.resolve({ text: JSON.stringify({ rate_bps: 10, reasoning: "ok" }), stopReason: "end_turn" }); } });
    assert.equal((await tick({ ...deps(w), decideOptions: { chair: ok, marginMs: 15_000, timeoutMs: PATIENT_MS } })).status, "executed");
    assert.deepEqual(busyDuring, [true], "held while the model is asked");
    assert.equal(w.press.decisionBusy(), false, "and released after");

    w.chain.advanceEpochs(1, 1000);
    const broken = new LlmChair({ complete: () => { busyDuring.push(w.press.decisionBusy()); return Promise.reject(new Error("model down")); } });
    const res = await tick({ ...deps(w), decideOptions: { chair: broken, marginMs: 15_000, timeoutMs: PATIENT_MS } });
    assert.equal(res.status, "executed");
    assert.equal(res.status === "executed" && res.decision.kind, "rule-fallback");
    assert.deepEqual(busyDuring, [true, true]);
    assert.equal(w.press.decisionBusy(), false, "released when the model failed too");
  } finally {
    w.done();
  }
});

test("stayOffTheModel waits while busy, returns the moment it is not, and never waits past its limit", async () => {
  let busy = true;
  const t0 = Date.now();
  setTimeout(() => { busy = false; }, 120);
  await stayOffTheModel(() => busy, 5000, 10);
  const waited = Date.now() - t0;
  assert.ok(waited >= 100 && waited < 1500, `waited ${waited} ms`);
  const t1 = Date.now();
  await stayOffTheModel(() => true, 150, 10);
  assert.ok(Date.now() - t1 < 1500, "a marker that never clears holds the desk for the limit only");
  const t2 = Date.now();
  await stayOffTheModel(() => false, 5000, 10);
  assert.ok(Date.now() - t2 < 100, "not busy: no wait");
});
