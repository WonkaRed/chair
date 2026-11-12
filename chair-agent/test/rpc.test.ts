import assert from "node:assert/strict";
import { test } from "node:test";
import { NearRpc } from "../src/rpc.js";
import { sanitize } from "../src/text.js";

const EVIL = "\u001b[2J\u001b]0;pwned\u0007\nFAKE LINE\r‮\u0085";
const printable = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

const nodeReplying = (body: unknown): NearRpc =>
  new NearRpc("http://127.0.0.1:1", 1000, () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) }));

test("sanitize escapes everything outside printable ASCII and caps the length", () => {
  assert.equal(sanitize("ok text"), "ok text");
  assert.equal(sanitize("a\u001b[31mb\nc"), "a\\x1b[31mb\\x0ac");
  assert.equal(sanitize("‮\u{1f600}"), "\\u{202e}\\u{1f600}");
  assert.ok(sanitize("x".repeat(1000)).length <= 203);
  assert.ok(printable(sanitize(EVIL)));
});

test("every RPC-derived error text reaching an Error message is printable ASCII", async () => {
  const cases: [string, () => Promise<unknown>][] = [
    ["rpc error", () => nodeReplying({ error: { name: EVIL, message: EVIL, data: EVIL } }).chainId()],
    ["view error", () => nodeReplying({ result: { error: EVIL } }).view("c.test", "m", {}, "h")],
    ["access key error", () => nodeReplying({ result: { error: EVIL } }).accessKey("a.test", "ed25519:x")],
    ["access key list error", () => nodeReplying({ result: { error: EVIL } }).accessKeyList("a.test")],
    [
      "send_tx failure",
      () => nodeReplying({ result: { transaction: { hash: "1".repeat(44) }, status: { Failure: { ActionError: { kind: `Smart contract panicked: ${EVIL}` } } } } })
        .sendTx("AA==")
        .then((r) => {
          assert.ok(r.failure !== null && printable(r.failure), String(r.failure));
          throw new Error(`reported: ${r.failure}`);
        }),
    ],
  ];
  for (const [name, run] of cases) {
    await assert.rejects(run(), (e: Error) => {
      assert.ok(printable(e.message), `${name}: ${JSON.stringify(e.message)}`);
      return true;
    }, name);
  }
});

test("the access key list is parsed and a full-access key is recognised", async () => {
  const keys = await nodeReplying({
    result: { keys: [
      { public_key: "ed25519:a", access_key: { nonce: 1, permission: "FullAccess" } },
      { public_key: "ed25519:b", access_key: { nonce: 2, permission: { FunctionCall: { receiver_id: "t.test", method_names: ["set_policy"] } } } },
    ] },
  }).accessKeyList("a.test");
  assert.deepEqual(keys, [
    { publicKey: "ed25519:a", permission: "FullAccess" },
    { publicKey: "ed25519:b", permission: { receiverId: "t.test", methodNames: ["set_policy"] } },
  ]);
  await assert.rejects(nodeReplying({ result: { keys: "nope" } }).accessKeyList("a.test"), /malformed key list/);
});

test("account: balance and storage when it exists; null for an unknown account in either shape a node uses; any other failure is an error", async () => {
  const found = await nodeReplying({ result: { amount: "5100000000000000000000000", locked: "0", storage_usage: 182 } }).account("a".repeat(64));
  assert.deepEqual(found, { amount: 5_100_000_000_000_000_000_000_000n, storageUsage: 182 });
  const current = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT", info: {} }, code: -32000, message: "Server error", data: "account x does not exist while viewing" } };
  assert.equal(await nodeReplying(current).account("a".repeat(64)), null);
  assert.equal(await nodeReplying({ result: { error: "account x does not exist while viewing" } }).account("a".repeat(64)), null);
  await assert.rejects(nodeReplying({ error: { name: "HANDLER_ERROR", cause: { name: "UNAVAILABLE_SHARD" }, message: "Server error" } }).account("a".repeat(64)), /UNAVAILABLE_SHARD/);
  await assert.rejects(nodeReplying({ result: { error: "node is syncing" } }).account("a".repeat(64)), /node is syncing/);
  await assert.rejects(nodeReplying({ result: { amount: "-1", storage_usage: 1 } }).account("a".repeat(64)));
  await assert.rejects(nodeReplying({ result: { amount: "1" } }).account("a".repeat(64)));
  await assert.rejects(new NearRpc("http://127.0.0.1:1", 1000, () => Promise.resolve({ ok: false, status: 502, text: () => Promise.resolve("") })).account("a".repeat(64)), /HTTP 502/, "a node that is down is not 'no such account'");
});

type Reply = { status: number; body: string } | Error;
/** A fetch that answers from a script, one reply per call (the last repeats), and records each URL and parsed request. */
function scripted(replies: Reply[]): { fetch: ConstructorParameters<typeof NearRpc>[2]; seen: { url: string; req: { method: string; params: Record<string, unknown> } }[] } {
  const seen: { url: string; req: { method: string; params: Record<string, unknown> } }[] = [];
  const f: ConstructorParameters<typeof NearRpc>[2] = (url, init) => {
    seen.push({ url: String(url), req: JSON.parse(String(init?.body)) as { method: string; params: Record<string, unknown> } });
    const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
    return r instanceof Error ? Promise.reject(r) : Promise.resolve({ ok: r.status < 400, status: r.status, text: () => Promise.resolve(r.body) });
  };
  return { fetch: f, seen };
}
const ok = (result: unknown): Reply => ({ status: 200, body: JSON.stringify({ result }) });
const rpcError = (cause: string): Reply => ({ status: 200, body: JSON.stringify({ error: { name: "HANDLER_ERROR", cause: { name: cause }, message: "Server error" } }) });
const noSleep = (log: number[] = []) => (ms: number): Promise<void> => (log.push(ms), Promise.resolve());

test("a read that gets no answer is tried again with growing pauses, and the first good answer wins", async () => {
  const pauses: number[] = [];
  const s = scripted([{ status: 429, body: "" }, new Error("ECONNRESET"), ok({ chain_id: "testnet" })]);
  const rpc = new NearRpc("http://a.test", 1000, s.fetch, { attempts: 4, backoffMs: 100, sleep: noSleep(pauses) });
  assert.equal(await rpc.chainId(), "testnet");
  assert.equal(s.seen.length, 3);
  assert.deepEqual(pauses, [100, 200]);
});

test("the tries give up after the attempts and throw the last error", async () => {
  const s = scripted([{ status: 503, body: "" }]);
  const rpc = new NearRpc("http://a.test", 1000, s.fetch, { attempts: 3, sleep: noSleep() });
  await assert.rejects(rpc.chainId(), /HTTP 503/);
  assert.equal(s.seen.length, 3);
});

test("with several endpoints a try that gets no answer moves to the next, round the list", async () => {
  const s = scripted([{ status: 502, body: "" }, { status: 502, body: "" }, ok({ chain_id: "testnet" })]);
  const rpc = new NearRpc("http://a.test, http://b.test ,http://c.test", 1000, s.fetch, { attempts: 3, sleep: noSleep() });
  assert.equal(await rpc.chainId(), "testnet");
  assert.deepEqual(s.seen.map((x) => x.url), ["http://a.test", "http://b.test", "http://c.test"]);
  assert.equal(await rpc.chainId(), "testnet", "the good node stays the current one");
  assert.equal(s.seen[3]!.url, "http://c.test");
  assert.throws(() => new NearRpc("http://a.test,ftp://b.test"), /http or https/);
});

test("only a failure that says nothing about the request is retried: a refusal, a missing method and a bad answer are thrown at once", async () => {
  for (const reply of [rpcError("UNKNOWN_ACCOUNT"), ok({ chain_id: 7 })] as const) {
    const s = scripted([reply]);
    await assert.rejects(new NearRpc("http://a.test", 1000, s.fetch, { attempts: 4, sleep: noSleep() }).chainId());
    assert.equal(s.seen.length, 1);
  }
  for (const cause of ["TIMEOUT_ERROR", "UNAVAILABLE_SHARD", "UNKNOWN_BLOCK", "NOT_SYNCED", "INTERNAL_ERROR"]) {
    const s = scripted([rpcError(cause), ok({ chain_id: "testnet" })]);
    assert.equal(await new NearRpc("http://a.test", 1000, s.fetch, { attempts: 2, sleep: noSleep() }).chainId(), "testnet", cause);
  }
  const garbled = scripted([{ status: 200, body: "<html>" }, ok({ chain_id: "testnet" })]);
  assert.equal(await new NearRpc("http://a.test", 1000, garbled.fetch, { attempts: 2, sleep: noSleep() }).chainId(), "testnet");
});

test("sendTx goes to the next endpoint only when the node refused before accepting it (HTTP 429, connection refused); an answer that never came is thrown and never resent", async () => {
  const done = ok({ transaction: { hash: "1".repeat(44) }, status: { SuccessValue: "" } });
  const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  for (const first of [{ status: 429, body: "" } as Reply, refused]) {
    const s = scripted([first, done]);
    const rpc = new NearRpc("http://a.test,http://b.test", 1000, s.fetch, { attempts: 1, sleep: noSleep() });
    assert.equal((await rpc.sendTx("AA==")).failure, null);
    assert.deepEqual(s.seen.map((x) => x.url), ["http://a.test", "http://b.test"]);
  }
  for (const lost of [{ status: 504, body: "" } as Reply, new Error("timeout"), rpcError("TIMEOUT_ERROR"), { status: 200, body: "<html>" } as Reply]) {
    const s = scripted([lost, done]);
    await assert.rejects(new NearRpc("http://a.test,http://b.test", 1000, s.fetch, { attempts: 5, sleep: noSleep() }).sendTx("AA=="));
    assert.equal(s.seen.length, 1, "sent once");
  }
  const everywhere = scripted([{ status: 429, body: "" }]);
  await assert.rejects(new NearRpc("http://a.test,http://b.test", 1000, everywhere.fetch, { sleep: noSleep() }).sendTx("AA=="), /HTTP 429/);
  assert.equal(everywhere.seen.length, 2, "once on each endpoint");
});

test("txOutcome asks with wait_until NONE, which answers at once: null when never seen, executed false while it waits, its outcome once it ran, and any other error is thrown", async () => {
  const hash = "2".repeat(44);
  const ran = scripted([ok({ final_execution_status: "FINAL", status: { SuccessValue: "" }, transaction: { hash } })]);
  assert.deepEqual(await new NearRpc("http://a.test", 1000, ran.fetch).txOutcome(hash, "me.test"), { txHash: hash, failure: null, executed: true });
  assert.equal(ran.seen[0]!.req.method, "tx");
  assert.deepEqual(ran.seen[0]!.req.params, { tx_hash: hash, sender_account_id: "me.test", wait_until: "NONE" });
  const unknown = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, data: `Transaction ${hash} doesn't exist` } };
  assert.equal(await new NearRpc("http://a.test", 1000, scripted([{ status: 200, body: JSON.stringify(unknown) }]).fetch).txOutcome(hash, "me.test"), null);
  for (const waiting of [{ final_execution_status: "NONE" }, { status: "Started" }, { status: "NotStarted", transaction: { hash } }, { status: {} }]) {
    assert.deepEqual(await new NearRpc("http://a.test", 1000, scripted([ok(waiting)]).fetch).txOutcome(hash, "me.test"), { txHash: hash, failure: null, executed: false }, JSON.stringify(waiting));
  }
  const failed = await new NearRpc("http://a.test", 1000, scripted([ok({ status: { Failure: { ActionError: { kind: "boom" } } } })]).fetch).txOutcome(hash, "me.test");
  assert.equal(failed?.executed, true);
  assert.match(failed?.failure ?? "", /boom/);
  const refused = { status: { Failure: { InvalidTxError: "NotEnoughBalance" } } };
  assert.deepEqual(await new NearRpc("http://a.test", 1000, scripted([ok(refused)]).fetch).txOutcome(hash, "me.test"), { txHash: hash, failure: null, executed: false }, "a transaction refused as invalid is not one that ran");
  await assert.rejects(new NearRpc("http://a.test", 1000, scripted([rpcError("UNAVAILABLE_SHARD")]).fetch).txOutcome(hash, "me.test"), /UNAVAILABLE_SHARD/);
});

test("view reads at a block hash by block_id, and at optimistic or final by finality", async () => {
  const s = scripted([ok({ result: [...Buffer.from("1")] })]);
  const rpc = new NearRpc("http://a.test", 1000, s.fetch);
  await rpc.view("c.test", "m", {}, "H".repeat(10));
  await rpc.view("c.test", "m", {}, "optimistic");
  await rpc.view("c.test", "m", {}, "final");
  assert.equal(s.seen[0]!.req.params["block_id"], "H".repeat(10));
  assert.equal(s.seen[0]!.req.params["finality"], undefined);
  assert.equal(s.seen[1]!.req.params["finality"], "optimistic");
  assert.equal(s.seen[1]!.req.params["block_id"], undefined);
  assert.equal(s.seen[2]!.req.params["finality"], "final");
});
