// What the in-memory token must keep mirroring from contract/src (policy.rs, rollover.rs, lib.rs), and the
// one shape the agent may put in `reasoning_hash`. The expected values here are written from SPEC.md, not
// read back from the code under test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KeyPair, SignedTransaction } from "near-api-js";
import { tick } from "../src/agent.js";
import { main } from "../src/cli.js";
import { FakeChain } from "../src/fake-chain.js";
import { LlmChair } from "../src/llm-chair.js";
import { DecisionLog, findReasoning } from "../src/log.js";
import { ruleChair } from "../src/rule-chair.js";
import type { Chair, Decision } from "../src/types.js";
import { FakeNode } from "./fake-node.js";
import { PATIENT_MS, randInt, rng, tempDir } from "./helpers.js";

const CHAIR = "chair.test";
const HASH_PANIC = "reasoning_hash must be a SHA-256 digest: 64 lowercase hex characters";
const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const fresh = (o: Partial<ConstructorParameters<typeof FakeChain>[0]> = {}): FakeChain =>
  new FakeChain({ chair: CHAIR, totalSupply: 10n ** 30n, totalStaked: 10n ** 29n, ...o });

test("set_policy takes exactly a SHA-256 hex digest: 64 characters, 0-9 and a-f only", () => {
  const good = sha256("reasoning");
  const bad: [string, string][] = [
    ["empty", ""], ["short", "abc"], ["63 characters", good.slice(1)], ["65 characters", `${good}0`],
    ["uppercase", good.toUpperCase()], ["0x prefix", `0x${good.slice(2)}`], ["trailing newline", `${good.slice(1)}\n`],
    ["non-hex letter", `g${good.slice(1)}`], ["non-ASCII", `é${good.slice(1)}`], ["padded", ` ${good.slice(1)}`],
    ["old rule: 128 characters", "a".repeat(128)], ["old rule: 1 character", "a"],
  ];
  for (const [what, hash] of bad) {
    const c = fresh();
    assert.equal(c.setPolicy(CHAIR, 10, hash), HASH_PANIC, what);
    assert.equal(c.events.length, 0, what);
  }
  const c = fresh();
  assert.equal(c.setPolicy(CHAIR, 10, good), null);
  assert.equal(c.setPolicy(CHAIR, 0, "0".repeat(64)), "policy already set this epoch");
});

test("set_policy checks run in the contract's order: chair, hash, already set, bounds, step", () => {
  const c = fresh();
  assert.equal(c.setPolicy("other.test", 999, "bad"), "only the chair may set policy");
  assert.equal(c.setPolicy(CHAIR, 999, "bad"), HASH_PANIC);
  const h = sha256("x");
  assert.equal(c.setPolicy(CHAIR, 10, h), null);
  assert.equal(c.setPolicy(CHAIR, 999, "bad"), HASH_PANIC, "a bad hash is reported before the epoch is found already set");
  assert.equal(c.setPolicy(CHAIR, 999, h), "policy already set this epoch");
  c.advanceEpochs(1);
  assert.equal(c.setPolicy(CHAIR, 201, h), "rate_bps out of bounds: must be within -200..=200");
  assert.equal(c.setPolicy(CHAIR, 61, h), "rate step too large: must move at most 50 bps from the current rate");
  assert.equal(c.setPolicy(CHAIR, 60, h), null);
});

test("meetings_per_day is the day over the epoch, rounded up: 960 at 90 s, 2880 at 30 s, 1 from a day on", () => {
  for (const [epochMs, day] of [[90_000, 960], [30_000, 2880], [60_000, 1440], [100_000, 864], [70_000, 1235], [86_400_000, 1], [31_536_000_000, 1]] as const) {
    assert.equal(fresh({ epochMs }).params.meetingsPerDay, day, `${epochMs} ms`);
  }
});

test("the mint follows rollover.rs: per day, floor, cap at u128::MAX / 10000, and the reward pool and index grow with it", () => {
  // SPEC worked vector: supply 1_000_001_000, rate 33 a day, staked 500, 960 meetings a day -> minted 3437 (3437.5034 floored).
  const v = fresh({ totalSupply: 1_000_001_000n, totalStaked: 500n, epochMs: 90_000 });
  v.setPolicy(CHAIR, 33, sha256("v"));
  v.advanceEpochs(1);
  assert.equal(v.totalSupply, 1_000_004_437n);
  assert.equal(v.rewardPool, 3437n);
  assert.equal(v.rewardPerShare, (3437n * 10n ** 24n) / 500n);
  // A day of meetings at the top rate grows the supply by at most 2.02%, never the old 2% a meeting.
  const day = fresh({ totalSupply: 10n ** 30n, totalStaked: 10n ** 29n, epochMs: 90_000 });
  day.rateBps = 200;
  for (let e = 0; e < 960; e++) {
    day.lastSetEpoch = day.epoch; // the chair keeps setting 200, so no decay
    day.advanceEpochs(1);
  }
  const grown = (day.totalSupply * 10_000_000n) / 10n ** 30n;
  assert.equal(grown, 10_202_011n, "1.0202011 after 960 meetings, SPEC 'The leash in numbers'");
  const cap = (2n ** 128n - 1n) / 10_000n; // contract MAX_TOTAL_SUPPLY
  const near = fresh({ totalSupply: cap - 7n, totalStaked: 1n });
  near.rateBps = 200;
  near.lastSetEpoch = 0;
  near.advanceEpochs(1);
  assert.equal(near.totalSupply, cap, "the supply reaches the contract cap exactly, not one short of it");
  near.rateBps = 200;
  near.lastSetEpoch = 1;
  near.advanceEpochs(1);
  assert.equal(near.totalSupply, cap, "and never passes it");
  const nobody = fresh({ totalStaked: 0n });
  nobody.rateBps = 200;
  nobody.advanceEpochs(1);
  assert.deepEqual([nobody.totalSupply, nobody.rewardPool], [10n ** 30n, 0n], "nothing is minted with nobody staked");
});

/** A submitter that forwards to the chain and keeps every decision the agent signed. */
function recorder(chain: FakeChain): { sent: Decision[]; submit: (d: Decision) => ReturnType<FakeChain["submit"]> } {
  const sent: Decision[] = [];
  return { sent, submit: (d) => (sent.push(d), chain.submit(d)) };
}

test("every reasoning_hash the agent sends is the SHA-256 of the reasoning text it logs, whichever chair decided", async () => {
  const r = rng(11);
  const wild = new LlmChair({ complete: () => Promise.resolve({ text: JSON.stringify({ rate_bps: randInt(r, -9_000, 9_000), reasoning: "r‮\u0007 é中" }), stopReason: "end_turn" }) });
  const garbage = new LlmChair({ complete: () => Promise.resolve({ text: "not json", stopReason: "end_turn" }) });
  const chairs: [string, Chair][] = [["rule", ruleChair], ["wild model", wild], ["failing model (fallback)", garbage]];
  for (const [name, chair] of chairs) {
    const dir = tempDir("chair-mirror");
    try {
      const chain = fresh();
      const path = join(dir, "decisions.jsonl");
      const log = new DecisionLog(path, { token: "token.test", account: CHAIR });
      const rec = recorder(chain);
      for (let e = 0; e < 30; e++) {
        chain.advanceTo(chain.params.startMs + e * chain.params.epochMs + 1000);
        const res = await tick({ reader: chain, log, chairAccount: CHAIR, submitter: rec, decideOptions: { chair, marginMs: 15_000, timeoutMs: PATIENT_MS } });
        assert.equal(res.status, "executed", `${name} epoch ${e}`);
      }
      assert.equal(rec.sent.length, 30, name);
      assert.deepEqual(chain.refusals, [], name);
      for (const d of rec.sent) {
        assert.match(d.reasoningHash, /^[0-9a-f]{64}$/, name);
        assert.equal(d.reasoningHash, sha256(d.reasoning), `${name}: the hash is of the text the decision carries`);
        assert.equal(findReasoning(path, d.reasoningHash), d.reasoning, `${name}: that text is the one in the log`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a decision carrying a hash in the old 1..=128-byte style is refused by the chain model", async () => {
  const chain = fresh();
  chain.advanceTo(chain.params.startMs + 1000);
  const dir = tempDir("chair-mirror");
  try {
    const log = new DecisionLog(join(dir, "d.jsonl"), { token: "token.test", account: CHAIR });
    const rec = recorder(chain);
    const res = await tick({ reader: chain, log, chairAccount: CHAIR, submitter: rec, decideOptions: { chair: ruleChair, marginMs: 15_000, timeoutMs: 100 } });
    assert.equal(res.status, "executed");
    // The same decision with a 1..=128-byte, non-digest hash is what the old contract took and the new one refuses.
    const old = { ...rec.sent[0]!, reasoningHash: "rule-v1 epoch 0" };
    chain.advanceEpochs(1);
    const refused = await chain.submit(old);
    assert.equal(refused.failure, HASH_PANIC);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const TOKEN = "token.test";
const pair = KeyPair.fromRandom("ed25519");
let dir: string;
let chain: FakeChain;
let node: FakeNode;
before(async () => {
  dir = tempDir("chair-mirror-node");
  chain = fresh();
  node = new FakeNode(chain, TOKEN);
  node.keys.set(pair.getPublicKey().toString(), { account: CHAIR, permission: { receiver_id: TOKEN, method_names: ["set_policy"] } });
  await node.start();
});
after(async () => {
  await node.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("on the wire: the decoded set_policy arguments of every signed transaction carry the logged text and its 64-hex digest", async () => {
  const log = join(dir, "log.jsonl");
  for (let e = 0; e < 4; e++) {
    chain.advanceTo(chain.params.startMs + e * chain.params.epochMs + 1000);
    const lines: string[] = [];
    const code = await main(["run", "--rpc", node.url, "--token", TOKEN, "--account", CHAIR, "--once", "--log", log], { CHAIR_KEY: pair.toString() }, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
    assert.equal(code, 0, lines.join("\n"));
  }
  assert.equal(node.sent.length, 4);
  for (const signed of node.sent) {
    const call = SignedTransaction.decode(signed.encode()).transaction.actions[0]!.functionCall!;
    const args = JSON.parse(Buffer.from(call.args).toString("utf8")) as Record<string, unknown>;
    assert.deepEqual(Object.keys(args).sort(), ["rate_bps", "reasoning", "reasoning_hash"]);
    const hash = args["reasoning_hash"];
    assert.match(String(hash), /^[0-9a-f]{64}$/);
    const text = findReasoning(log, String(hash));
    assert.ok(text !== null, "the logged text exists");
    assert.equal(sha256(text), hash);
    assert.equal(args["reasoning"], text, "the text on the wire is the logged text");
  }
  assert.deepEqual(chain.refusals, []);
});
