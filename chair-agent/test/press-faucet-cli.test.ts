import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { KeyPair } from "near-api-js";
import { main } from "../src/cli.js";
import { FakeChain } from "../src/fake-chain.js";
import { FakeNode } from "./fake-node.js";
import { eventually, tempDir } from "./helpers.js";

const FAUCET = "faucet.test";
const TOKEN = "token.test";
const pair = KeyPair.fromRandom("ed25519");
const scopedPair = KeyPair.fromRandom("ed25519");
let dir: string;
let node: FakeNode;
before(async () => {
  dir = tempDir("faucet-cli");
  node = new FakeNode(new FakeChain({ chair: "chair.test", totalSupply: 10n ** 30n, totalStaked: 0n }), TOKEN);
  node.keys.set(pair.getPublicKey().toString(), { account: FAUCET, permission: "FullAccess" });
  node.keys.set(scopedPair.getPublicKey().toString(), { account: FAUCET, permission: { receiver_id: TOKEN, method_names: ["ft_transfer"] } });
  await node.start();
});
after(async () => {
  await node.stop();
  rmSync(dir, { recursive: true, force: true });
});

const llmClient = { complete: () => Promise.resolve({ text: JSON.stringify({ picks: [0, 1, 2] }), stopReason: "end_turn" }) };

/** Runs `chair-agent press` with `env`, hands the test its port and log, and stops it. */
let runs = 0;
async function press(env: NodeJS.ProcessEnv, run: (port: string, log: string[]) => Promise<void>, stateDir = join(dir, `run${++runs}`)): Promise<void> {
  const ac = new AbortController();
  const log: string[] = [];
  mkdirSync(stateDir, { recursive: true });
  const done = main(["press", "--port", "0", "--press", join(stateDir, "press.jsonl")], { CHAIR_RPC_URL: node.url, CHAIR_TOKEN: TOKEN, ...env }, { out: (l) => log.push(l), err: (l) => log.push(l) }, { llmClient, signal: ac.signal });
  try {
    await eventually(() => log.some((l) => l.includes("press on 127.0.0.1")));
    const port = /127\.0\.0\.1:(\d+)/.exec(log.join("\n"))?.[1];
    assert.ok(port !== undefined, log.join("\n"));
    await run(port, log);
  } finally {
    ac.abort();
    assert.equal(await done, 0);
  }
}

const faucetOn = async (port: string): Promise<boolean> => ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { faucet: boolean }).faucet;

function files(name: string, key: KeyPair): { CHAIR_FAUCET_KEY_FILE: string; CHAIR_FAUCET_ACCOUNT: string; CHAIR_FAUCET_STATE_FILE: string; CHAIR_FAUCET_KILL_FILE: string } {
  const keyFile = join(dir, `${name}.key`);
  writeFileSync(keyFile, key.toString(), { mode: 0o600 });
  return { CHAIR_FAUCET_KEY_FILE: keyFile, CHAIR_FAUCET_ACCOUNT: FAUCET, CHAIR_FAUCET_STATE_FILE: join(dir, `${name}.json`), CHAIR_FAUCET_KILL_FILE: join(dir, `${name}.kill`) };
}

test("press with the faucet's env switches it on; the kill file switches it off without a restart", async () => {
  const env = files("on", pair);
  await press(env, async (port, log) => {
    assert.ok(log.some((l) => l.startsWith(`faucet on: ${FAUCET}`)), log.join("\n"));
    assert.ok(!log.join("\n").includes(pair.toString().slice(8)), "the log never holds the key");
    assert.equal(await eventually(() => faucetOn(port)), true, "up once the chain checks pass");
    assert.ok(log.some((l) => l === "faucet ready: the chain checks passed"), log.join("\n"));
    assert.equal(((await (await fetch(`http://127.0.0.1:${port}/faucet/state`)).json()) as { open: boolean }).open, true);
    writeFileSync(env.CHAIR_FAUCET_KILL_FILE, "");
    assert.equal(await faucetOn(port), false);
    rmSync(env.CHAIR_FAUCET_KILL_FILE);
    assert.equal(await faucetOn(port), true);
  });
});

test("without the key file the faucet is off and silent; the desk still starts", async () => {
  await press({}, async (port, log) => {
    assert.equal(await faucetOn(port), false);
    assert.ok(!log.some((l) => /^faucet/.test(l)), log.join("\n"));
  });
});

test("an unusable faucet setup leaves it off with the reason in the log and the desk still starts: no state file, a function-call key, no account", async () => {
  const { CHAIR_FAUCET_STATE_FILE: _unused, ...noState } = files("nostate", pair);
  const cases: [NodeJS.ProcessEnv, RegExp][] = [
    [noState, /faucet off: CHAIR_FAUCET_STATE_FILE is required/],
    [files("scoped", scopedPair), /faucet off: the signing key must be a full-access key/],
    [{ ...files("noacct", pair), CHAIR_FAUCET_ACCOUNT: "" }, /faucet off: CHAIR_FAUCET_ACCOUNT: not a NEAR account id/],
    [{ ...files("badcap", pair), CHAIR_FAUCET_DAILY: "0" }, /faucet off: CHAIR_FAUCET_DAILY/],
    [{ ...files("asvisitor", pair), CHAIR_VISITOR_ACCOUNT: FAUCET }, /faucet off: CHAIR_FAUCET_ACCOUNT is also CHAIR_VISITOR_ACCOUNT/],
    [{ ...files("aschair", pair), CHAIR_ACCOUNT: FAUCET }, /faucet off: CHAIR_FAUCET_ACCOUNT is also CHAIR_ACCOUNT/],
  ];
  for (const [env, why] of cases) {
    await press(env, async (port, log) => {
      assert.equal(await eventually(() => why.test(log.join("\n"))), true, log.join("\n"));
      assert.equal(await faucetOn(port), false);
    });
  }
});

test("a chain id of mainnet leaves the faucet off for good, with the reason in the log", async () => {
  const main = new FakeNode(new FakeChain({ chair: "chair.test", totalSupply: 10n ** 30n, totalStaked: 0n }), TOKEN);
  main.chainId = "mainnet";
  main.keys.set(pair.getPublicKey().toString(), { account: FAUCET, permission: "FullAccess" });
  await main.start();
  try {
    await press({ ...files("mainnet", pair), CHAIR_RPC_URL: main.url }, async (port, log) => {
      assert.equal(await eventually(() => log.some((l) => /faucet off: refusing to run against mainnet/.test(l))), true, log.join("\n"));
      assert.equal(await faucetOn(port), false);
    });
  } finally {
    await main.stop();
  }
});

test("moving the state file to a new path does not hand out the budget again: the marker made with the first one keeps the faucet off, with the reason", async () => {
  const stateDir = join(dir, "moved");
  const env = files("first", pair);
  await press(env, async (port) => assert.equal(await eventually(() => faucetOn(port)), true), stateDir);
  assert.ok(existsSync(join(stateDir, `faucet-${FAUCET}.began`)), "the marker is beside the press record");
  await press(files("second", pair), async (port, log) => {
    assert.equal(await eventually(() => /faucet off: this faucet has run on this desk before, but its state file is missing/.test(log.join("\n"))), true, log.join("\n"));
    assert.equal(await faucetOn(port), false);
  }, stateDir);
  await press(env, async (port) => assert.equal(await eventually(() => faucetOn(port)), true), stateDir); // the same path as before still starts
});
