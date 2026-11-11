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
