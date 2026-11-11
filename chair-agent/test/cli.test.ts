import assert from "node:assert/strict";
import { tempDir } from "./helpers.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KeyPair } from "near-api-js";
import { main, type Io } from "../src/cli.js";
import { FakeChain } from "../src/fake-chain.js";
import type { LlmClient } from "../src/llm-chair.js";
import { BOOK } from "../src/press-book.js";
import { PressStore } from "../src/press-store.js";
import { reasoningHash } from "../src/reasoning.js";
import { FakeNode } from "./fake-node.js";

const CHAIR = "chair.test";
const TOKEN = "token.test";
const pair = KeyPair.fromRandom("ed25519");
const secret = pair.toString();
const pub = pair.getPublicKey().toString();

let dir: string;
let chain: FakeChain;
let node: FakeNode;
before(async () => {
  dir = tempDir("chair-cli");
  chain = new FakeChain({ chair: CHAIR, totalSupply: 1_000_000n * 10n ** 24n, totalStaked: 100_000n * 10n ** 24n });
  node = new FakeNode(chain, TOKEN);
  node.keys.set(pub, { account: CHAIR, permission: { receiver_id: TOKEN, method_names: ["set_policy"] } });
  await node.start();
});
after(async () => {
  await node.stop();
  rmSync(dir, { recursive: true, force: true });
});

function io(): Io & { out_: string[]; err_: string[] } {
  const o: string[] = [];
  const e: string[] = [];
  return { out: (l) => o.push(l), err: (l) => e.push(l), out_: o, err_: e };
}
const base = () => ["run", "--rpc", node.url, "--token", TOKEN, "--account", CHAIR, "--once", "--log", join(dir, "log.jsonl")];
const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ CHAIR_KEY: secret, ...extra });
const nextEpoch = () => chain.advanceTo(chain.params.startMs + (chain.epoch + 1) * chain.params.epochMs + 1000);

test("dry run prints the decision and the transaction, sends nothing, writes no log, needs no key", async () => {
  const o = io();
  const code = await main([...base(), "--dry-run"], {}, o);
  assert.equal(code, 0, o.err_.join("\n"));
  const text = o.out_.join("\n");
  assert.match(text, /rate 0 -> 50 bps/);
  assert.match(text, /chair\.test -> token\.test\.set_policy\(\{"rate_bps":50,"reasoning_hash":"[0-9a-f]{64}"\} plus "reasoning": the text above\)/);
  assert.match(text, /dry run: nothing sent, nothing logged/);
  assert.equal(node.sent.length, 0);
  assert.equal(existsSync(join(dir, "log.jsonl")), false);
});

test("a real run signs with the scoped key, the contract model accepts it, and the log holds the hashed text", async () => {
  const o = io();
  const code = await main(base(), env(), o);
  assert.equal(code, 0, o.err_.join("\n"));
  assert.equal(node.sent.length, 1);
  assert.equal(chain.events.length, 1);
  assert.equal(chain.refusals.length, 0);
  const ev = chain.events[0]!;
  assert.equal(ev.rateBps, 50);
  const records = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(records.map((r) => r["kind"]), ["decision", "outcome"]);
  assert.equal(reasoningHash(records[0]!["reasoning"] as string), ev.reasoningHash);
  assert.equal(records[1]!["status"], "executed");
  assert.ok(!readFileSync(join(dir, "log.jsonl"), "utf8").includes(secret.slice(8)));
  const v = io();
  assert.equal(await main(["verify-log", join(dir, "log.jsonl")], {}, v), 0);
  assert.match(v.out_.join("\n"), /1 decisions, 0 hash mismatches/);
  const t = io();
  assert.equal(await main(["verify-log", join(dir, "log.jsonl"), ev.reasoningHash], {}, t), 0);
  assert.equal(reasoningHash(t.out_.join("\n")), ev.reasoningHash);
});

test("a second pass in the same epoch does nothing", async () => {
  const o = io();
  assert.equal(await main(base(), env(), o), 0);
  assert.match(o.out_.join("\n"), /policy already set this epoch/);
  assert.equal(node.sent.length, 1);
});

test("a failing LLM falls back to the rule chair end to end", async () => {
  nextEpoch();
  const broken: LlmClient = { complete: () => Promise.reject(new Error("network down")) };
  const o = io();
  const code = await main([...base(), "--chair", "llm"], env({ ANTHROPIC_API_KEY: "present" }), o, { llmClient: broken });
  assert.equal(code, 0, o.err_.join("\n"));
  assert.match(o.out_.join("\n"), /\(rule-fallback\)/);
  assert.match(o.out_.join("\n"), /failed \(error\)\. The rule chair decided instead\. The Chair has no comment/);
  assert.equal(chain.refusals.length, 0);
});

test("--chair llm without ANTHROPIC_API_KEY uses the rule chair and says so", async () => {
  nextEpoch();
  const o = io();
  assert.equal(await main([...base(), "--chair", "llm", "--dry-run"], {}, o), 0);
  assert.match(o.err_.join("\n"), /ANTHROPIC_API_KEY is not set: using the rule-based chair/);
  assert.match(o.out_.join("\n"), /chair kind rule-v1/);
});

test("--llm-endpoint and --llm-model name a local chair: the decision says local:<id>, and one without the other is refused", async () => {
  nextEpoch();
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({
      id: "chatcmpl-test", type: "message", role: "assistant", model: "qwen-test", stop_reason: "end_turn", stop_sequence: null,
      content: [{ type: "text", text: '{"rate_bps": 25, "reasoning": "answered by the local stand-in"}' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const o = io();
    // No ANTHROPIC_API_KEY in this environment: the local endpoint is all the chair needs.
    assert.equal(await main([...base(), "--chair", "llm", "--dry-run", "--llm-endpoint", url, "--llm-model", "qwen-test"], {}, o), 0, o.err_.join("\n"));
    assert.match(o.out_.join("\n"), /chair local:qwen-test \(llm\)/);
    assert.match(o.out_.join("\n"), /answered by the local stand-in/);
    const lone = io();
    assert.equal(await main([...base(), "--chair", "llm", "--dry-run", "--llm-endpoint", url], {}, lone), 2);
    assert.match(lone.err_.join("\n"), /must be given together/);
  } finally {
    server.close();
  }
});

test("a full-access key is refused before anything is sent", async () => {
  const other = KeyPair.fromRandom("ed25519");
  const otherPub = other.getPublicKey().toString();
  node.keys.set(otherPub, { account: CHAIR, permission: "FullAccess" });
  try {
    nextEpoch();
    const before = node.sent.length;
    const o = io();
    assert.equal(await main(base(), { CHAIR_KEY: other.toString() }, o), 2);
    assert.match(o.err_.join("\n"), /refusing a full-access key/);
    assert.equal(node.sent.length, before);
  } finally {
    node.keys.delete(otherPub);
  }
});

test("a key scoped to other methods is refused", async () => {
  const other = KeyPair.fromRandom("ed25519");
  const otherPub = other.getPublicKey().toString();
  node.keys.set(otherPub, { account: CHAIR, permission: { receiver_id: TOKEN, method_names: ["set_policy", "ft_transfer"] } });
  try {
    const o = io();
    assert.equal(await main(base(), { CHAIR_KEY: other.toString() }, o), 2);
    assert.match(o.err_.join("\n"), /scoped to receiver/);
  } finally {
    node.keys.delete(otherPub);
  }
});

test("mainnet is refused", async () => {
  node.chainId = "mainnet";
  try {
    const o = io();
    assert.equal(await main([...base(), "--dry-run"], {}, o), 2);
    assert.match(o.err_.join("\n"), /refusing to run against mainnet/);
  } finally {
    node.chainId = "testnet";
  }
});

test("an account that is not the chair does nothing and exits 3", async () => {
  const o = io();
  assert.equal(await main(["run", "--rpc", node.url, "--token", TOKEN, "--account", "someone.test", "--once", "--dry-run"], {}, o), 3);
  assert.match(o.out_.join("\n"), /chair\.test is the chair, not someone\.test/);
});

test("a contract without staking views still gets a decision (no staking figures: rate walks to 0)", async () => {
  chain.hasStaking = false;
  nextEpoch();
  try {
    const o = io();
    assert.equal(await main([...base(), "--dry-run"], {}, o), 0, o.err_.join("\n"));
    assert.match(o.out_.join("\n"), /cannot see how many coins are staked/);
  } finally {
    chain.hasStaking = true;
  }
});

test("bad arguments are rejected at the boundary", async () => {
  for (const args of [
    ["run", "--rpc", node.url, "--token", "NOT VALID", "--account", CHAIR],
    ["run", "--rpc", "ftp://x", "--token", TOKEN, "--account", CHAIR],
    ["run", "--rpc", node.url, "--token", TOKEN, "--account", CHAIR, "--chair", "gpt"],
    ["run", "--rpc", node.url, "--token", TOKEN, "--account", CHAIR, "--margin-ms", "-1"],
    ["run", "--rpc", node.url, "--token", TOKEN, "--account", CHAIR, "--bogus"],
    ["run", "--token", TOKEN, "--account", CHAIR],
  ]) {
    const o = io();
    assert.equal(await main(args, {}, o), 2, args.join(" "));
  }
});

test("a node that is down is a clean error, not a crash", async () => {
  // A node that drops every connection: the port stays held by this test, so no other process can answer on it.
  const down = createServer();
  down.on("connection", (socket) => socket.destroy());
  await new Promise<void>((r) => down.listen(0, "127.0.0.1", r));
  try {
    const o = io();
    const url = `http://127.0.0.1:${(down.address() as AddressInfo).port}`;
    assert.equal(await main(["run", "--rpc", url, "--token", TOKEN, "--account", CHAIR, "--dry-run", "--once"], {}, o), 2);
    assert.match(o.err_.join("\n"), /rpc status/);
  } finally {
    down.close();
  }
});

test("the loop sleeps until the epoch ends, acts once per epoch, and stops on abort", async () => {
  const sleeps: number[] = [];
  const ac = new AbortController();
  const o = io();
  const argv = base().filter((a) => a !== "--once");
  const code = await main(argv, env(), o, {
    signal: ac.signal,
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) ac.abort();
      else nextEpoch();
      return Promise.resolve();
    },
  });
  assert.equal(code, 0, o.err_.join("\n"));
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps.every((s) => s >= 1000 && s <= chain.params.epochMs + 1000), sleeps.join(","));
  assert.equal(chain.refusals.length, 0);
});

test("the chair account holding any full-access key is refused unless --allow-full-access-key, which warns", async () => {
  const spare = KeyPair.fromRandom("ed25519").getPublicKey().toString();
  node.keys.set(spare, { account: CHAIR, permission: "FullAccess" });
  try {
    nextEpoch();
    const before = node.sent.length;
    const refused = io();
    assert.equal(await main(base(), env(), refused), 2);
    assert.match(refused.err_.join("\n"), /holds 1 full-access key\(s\).*--allow-full-access-key/);
    assert.equal(node.sent.length, before, "nothing was sent");
    const allowed = io();
    assert.equal(await main([...base(), "--allow-full-access-key"], env(), allowed), 0, allowed.err_.join("\n"));
    assert.match(allowed.err_.join("\n"), /WARNING: chair\.test holds 1 full-access key/);
    assert.equal(node.sent.length, before + 1);
  } finally {
    node.keys.delete(spare);
  }
});

test("a node that reports other bounds than the contract's is not acted on", async () => {
  const original = chain.params;
  (chain as { params: typeof original }).params = { ...original, maxRateBps: 10_000, maxStepBps: 10_000 };
  try {
    nextEpoch();
    const o = io();
    assert.equal(await main([...base(), "--dry-run"], {}, o), 1, o.err_.join("\n"));
    assert.match(o.err_.join("\n"), /differ from the contract's 200\/50; refusing to act/);
  } finally {
    (chain as { params: typeof original }).params = original;
  }
});

test("a hostile node cannot put escape sequences or fake lines on the terminal", async () => {
  node.hostile = true;
  try {
    const o = io();
    assert.equal(await main([...base(), "--dry-run"], {}, o), 2);
    const text = [...o.err_, ...o.out_].join("\n");
    assert.match(text, /HOSTILE/);
    assert.equal(o.err_.length, 1, "one error line, however many newlines the node sent");
    assert.ok(/^[\x20-\x7e]*$/.test(text), JSON.stringify(text));
  } finally {
    node.hostile = false;
  }
});

test("model text on the terminal is quoted line by line, free of invisible characters, and reconciles with the hash", async () => {
  nextEpoch();
  const hostileLlm: LlmClient = {
    complete: () =>
      Promise.resolve({
        text: JSON.stringify({ rate_bps: 10, reasoning: "line one\nexecuted, tx FAKE\n\u001b[2Jsecret\u200b\u202e\u2060\u061c\u200fend" }),
        stopReason: "end_turn",
      }),
  };
  const o = io();
  assert.equal(await main([...base(), "--chair", "llm", "--dry-run"], env({ ANTHROPIC_API_KEY: "present" }), o, { llmClient: hostileLlm }), 0);
  const lines = o.out_.join("\n").split("\n");
  const from = lines.findIndex((l) => l.startsWith("--- reasoning")) + 1;
  const to = lines.findIndex((l) => l.startsWith("--- transaction"));
  const quoted = lines.slice(from, to);
  assert.ok(quoted.length >= 4 && quoted.every((l) => l.startsWith("  | ")), quoted.join("\n"));
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u061c\u001b]/.test(o.out_.join("\n")));
  assert.ok(quoted.some((l) => l === "  | executed, tx FAKE"), "the fake report line is visibly quoted text");
  const text = quoted.map((l) => l.slice(4)).join("\n");
  const hash = /reasoning_hash: ([0-9a-f]{64})/.exec(lines.join("\n"))![1];
  assert.equal(reasoningHash(text), hash, "the printed text minus the prefix is exactly what is hashed");
});

test("a send that keeps failing: one model call, one logged decision, three sends with backoff, then quiet until the next epoch", async () => {
  nextEpoch();
  let llmCalls = 0;
  const counting: LlmClient = {
    complete: () => {
      llmCalls++;
      return Promise.resolve({ text: JSON.stringify({ rate_bps: 20, reasoning: `call ${llmCalls}` }), stopReason: "end_turn" });
    },
  };
  const logPath = join(dir, "retry.jsonl");
  const argv = ["run", "--rpc", node.url, "--token", TOKEN, "--account", CHAIR, "--chair", "llm", "--log", logPath];
  const sleeps: number[] = [];
  const ac = new AbortController();
  node.failSends = 1000;
  const sendsBefore = node.sendCalls;
  const o = io();
  await main(argv, env({ ANTHROPIC_API_KEY: "present" }), o, {
    llmClient: counting,
    signal: ac.signal,
    sleep: (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 6) ac.abort();
      return Promise.resolve();
    },
  });
  node.failSends = 0;
  assert.equal(llmCalls, 1, "one model call for the epoch");
  assert.equal(node.sendCalls - sendsBefore, 3, "three send attempts, no more");
  const records = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(records.map((r) => r["kind"]), ["decision", "outcome", "outcome", "outcome"]);
  assert.deepEqual(records.slice(1).map((r) => r["status"]), ["send_failed", "send_failed", "send_failed"]);
  assert.equal(new Set(records.map((r) => r["reasoning_hash"])).size, 1, "every attempt carries the same hash");
  assert.equal(sleeps[0], 10_000);
  assert.equal(sleeps[1], 20_000);
  assert.ok(sleeps.slice(2).every((s) => s > 20_000 || s === sleeps[2]), `after the last attempt the wait is until the epoch ends: ${sleeps.join(",")}`);
  assert.match(o.out_.join("\n"), /giving up on this epoch: sending failed 3 times/);

  // The next epoch gets a fresh decision, and the same log carries on.
  nextEpoch();
  const next = io();
  assert.equal(await main([...argv, "--once"], env({ ANTHROPIC_API_KEY: "present" }), next, { llmClient: counting }), 0, next.err_.join("\n"));
  assert.equal(llmCalls, 2);
  assert.equal(node.sendCalls - sendsBefore, 4);
  assert.equal(chain.refusals.length, 0);
});

test("verify-log reports the token and account, and flags a log shared by two of them", async () => {
  const p = join(dir, "log.jsonl");
  const lines = readFileSync(p, "utf8").trim().split("\n");
  const first = JSON.parse(lines[0]!) as Record<string, unknown>;
  const v = io();
  assert.equal(await main(["verify-log", p], {}, v), 0);
  assert.match(v.out_.join("\n"), /token and account: token\.test chair\.test$/m);
  const mixed = join(dir, "mixed.jsonl");
  writeFileSync(mixed, `${lines.join("\n")}\n${JSON.stringify({ ...first, account: "other.test" })}\n`);
  const m = io();
  assert.equal(await main(["verify-log", mixed], {}, m), 1);
  assert.match(m.out_.join("\n"), /MIXED: this log was reused/);
});

test("run --press enters a pending question into the minutes and marks it with the transaction, over the real signing path", async () => {
  nextEpoch();
  const pressFile = join(dir, "press.jsonl");
  const store = new PressStore(pressFile);
  const question = "does the chair dream of basis points";
  store.add({ id: "q1", question, questionHash: reasoningHash(question), answer: BOOK[0]!, source: "model", askedAtMs: 1 });
  const o = io();
  assert.equal(await main([...base(), "--press", pressFile], env(), o), 0, o.err_.join("\n"));
  const sent = node.sent.at(-1);
  assert.ok(sent !== undefined);
  const ev = chain.events.at(-1)!;
  const logged = readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => r["kind"] === "decision").at(-1)!;
  const text = logged["reasoning"] as string;
  assert.ok(text.includes(`(${reasoningHash(question).slice(0, 12)}). The Chair replied: ${BOOK[0]}`));
  assert.ok(!text.includes(question), "the question itself is never in the minutes");
  assert.equal(reasoningHash(text), ev.reasoningHash);
  const [entry] = store.recent(1);
  assert.equal(entry?.epoch, chain.epoch);
  assert.match(entry?.txHash ?? "", /\S/);
});
