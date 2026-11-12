import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { KeyPair } from "near-api-js";
import { BOOK } from "../src/press-book.js";
import { Faucet, FAUCET_GAS_MARGIN, type FaucetLimits } from "../src/press-faucet.js";
import { createPressServer, listen } from "../src/press-server.js";
import { PressStore } from "../src/press-store.js";
import { FAUCET_GRANT_CHAIR, FAUCET_GRANT_NEAR, FAUCET_STEPS, FAUCET_STORAGE_DEPOSIT } from "../src/signer.js";
import { tempDir } from "./helpers.js";

const newKey = (): { key: string; account: string } => {
  const pub = KeyPair.fromRandom("ed25519").getPublicKey();
  return { key: pub.toString(), account: Buffer.from(pub.data).toString("hex") };
};

interface Desk {
  base: string;
  killFile: string;
  sent: string[];
  post(body: string, headers?: Record<string, string>, type?: string): Promise<Response>;
}

/** The desk over real HTTP; with `on` false it has no faucet at all. */
async function withDesk(on: boolean, run: (d: Desk) => Promise<void>, limits: Partial<FaucetLimits> = {}): Promise<void> {
  const dir = tempDir("faucet-server");
  mkdirSync(dir, { recursive: true });
  const sent: string[] = [];
  const killFile = join(dir, "kill");
  const faucet = on
    ? new Faucet({
        reader: {
          exists: () => Promise.resolve(false),
          funds: () => Promise.resolve({ near: FAUCET_GRANT_NEAR + FAUCET_STORAGE_DEPOSIT + FAUCET_GAS_MARGIN, chair: FAUCET_GRANT_CHAIR }),
        },
        sender: {
          grant: (account, _finished, _pending, hooks) => {
            sent.push(account);
            FAUCET_STEPS.forEach((step, i) => {
              hooks.onPending({ step, hash: `t${i + 1}`, tx: "AAAA" });
              hooks.onStep(step, `t${i + 1}`);
            });
            return Promise.resolve({ txs: ["t1", "t2", "t3"], failed: null });
          },
        },
        limits,
        stateFile: join(dir, "faucet.json"),
        killFile,
      })
    : undefined;
  const server = createPressServer({ store: new PressStore(join(dir, "press.jsonl")), answer: () => Promise.resolve({ answer: BOOK[0]!, source: "model" as const }), available: () => true, ...(faucet === undefined ? {} : { faucet }) });
  const base = `http://127.0.0.1:${await listen(server, 0)}`;
  try {
    await run({ base, killFile, sent, post: (body, headers = {}, type = "application/json") => fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": type, ...headers }, body }) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}

const OFF_STATE = { open: false, grant_chair: "50", grant_near: "0.05", remaining: 0, next_opening_s: 0, reason: "off" };

test("without a faucet: /health says false, POST /faucet is 503 off, and the state says off", async () => {
  await withDesk(false, async (d) => {
    assert.equal(((await (await fetch(`${d.base}/health`)).json()) as { faucet: boolean }).faucet, false);
    const res = await d.post(JSON.stringify({ public_key: newKey().key }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "the faucet is not switched on", reason: "off" });
    const state = await fetch(`${d.base}/faucet/state`);
    assert.equal(state.status, 200);
    assert.deepEqual(await state.json(), OFF_STATE);
  });
});

test("with a faucet: POST /faucet answers the documented shape, /faucet/state and /health show it open", async () => {
  await withDesk(true, async (d) => {
    assert.equal(((await (await fetch(`${d.base}/health`)).json()) as { faucet: boolean }).faucet, true);
    assert.deepEqual(await (await fetch(`${d.base}/faucet/state`)).json(), { open: true, grant_chair: "50", grant_near: "0.05", remaining: 200, next_opening_s: 0 });
    const { key, account } = newKey();
    const res = await d.post(JSON.stringify({ public_key: key }), { "cf-connecting-ip": "203.0.113.9" });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.deepEqual(await res.json(), { account_id: account, txs: ["t1", "t2", "t3"], chair: "50", near: "0.05" });
    assert.deepEqual(d.sent, [account]);
    assert.equal(((await (await fetch(`${d.base}/faucet/state`)).json()) as { remaining: number }).remaining, 199);
  });
});

test("the visitor's address is the one from the tunnel header: a fourth grant to the same CF-Connecting-IP is 429 with Retry-After and limit \"address\", another address is served", async () => {
  await withDesk(true, async (d) => {
    for (let i = 0; i < 3; i++) assert.equal((await d.post(JSON.stringify({ public_key: newKey().key }), { "cf-connecting-ip": "203.0.113.9" })).status, 200);
    const again = await d.post(JSON.stringify({ public_key: newKey().key }), { "cf-connecting-ip": "203.0.113.9" });
    assert.equal(again.status, 429);
    assert.equal(again.headers.get("retry-after"), String(24 * 3600));
    const j = (await again.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(j).sort(), ["error", "limit", "retry_after_s"]);
    assert.equal(j["retry_after_s"], 24 * 3600);
    assert.equal(j["limit"], "address");
    assert.equal((await d.post(JSON.stringify({ public_key: newKey().key }), { "cf-connecting-ip": "203.0.113.10" })).status, 200);
  });
});

test("a bad key, a wrong content type, broken JSON, a non-object and an oversized body are 400 and send nothing", async () => {
  await withDesk(true, async (d) => {
    const good = JSON.stringify({ public_key: newKey().key });
    for (const [body, type] of [
      [JSON.stringify({ public_key: "ed25519:short" }), "application/json"],
      [JSON.stringify({}), "application/json"],
      [JSON.stringify({ public_key: 5 }), "application/json"],
      [good, "text/plain"],
      ["{nope", "application/json"],
      ["[1]", "application/json"],
      [JSON.stringify({ public_key: newKey().key, pad: "x".repeat(2000) }), "application/json"],
    ] as const) {
      const res = await d.post(body, {}, type);
      assert.equal(res.status, 400, `${type} ${body.slice(0, 40)}`);
      assert.equal(typeof ((await res.json()) as { error: unknown }).error, "string");
    }
    assert.deepEqual(d.sent, []);
  });
});

test("the kill file closes the faucet on the next request: POST is 503 killed, /health says false, the state says killed", async () => {
  await withDesk(true, async (d) => {
    writeFileSync(d.killFile, "");
    assert.equal(((await (await fetch(`${d.base}/health`)).json()) as { faucet: boolean }).faucet, false);
    const res = await d.post(JSON.stringify({ public_key: newKey().key }));
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "the faucet has been switched off for now", reason: "killed" });
    assert.deepEqual(await (await fetch(`${d.base}/faucet/state`)).json(), { open: false, grant_chair: "50", grant_near: "0.05", remaining: 200, next_opening_s: 0, reason: "killed" });
    assert.deepEqual(d.sent, []);
  });
});

test("when the budget is spent /health goes false and the state says budget, but a finished grant is still answered for its key", async () => {
  await withDesk(
    true,
    async (d) => {
      const { key, account } = newKey();
      const first = await d.post(JSON.stringify({ public_key: key }));
      assert.equal(first.status, 200);
      assert.equal(((await (await fetch(`${d.base}/health`)).json()) as { faucet: boolean }).faucet, false);
      assert.deepEqual(await (await fetch(`${d.base}/faucet/state`)).json(), { open: false, grant_chair: "50", grant_near: "0.05", remaining: 0, next_opening_s: 0, reason: "budget" });
      const again = await d.post(JSON.stringify({ public_key: key }));
      assert.equal(again.status, 200);
      assert.deepEqual(await again.json(), { account_id: account, txs: ["t1", "t2", "t3"], chair: "50", near: "0.05" });
      assert.equal((await d.post(JSON.stringify({ public_key: newKey().key }))).status, 503);
      assert.deepEqual(d.sent, [account]);
    },
    { lifetimeCap: 1 },
  );
});

test("every refusal a visitor can get is JSON with an error text and the CORS headers for the page: killed, budget, busy, bad key, off", async () => {
  const origin = { origin: "http://localhost:5173" };
  await withDesk(
    true,
    async (d) => {
      const refusals: Response[] = [];
      refusals.push(await d.post(JSON.stringify({ public_key: "nope" }), origin));
      refusals.push(await d.post(JSON.stringify({ public_key: newKey().key }), { ...origin, "cf-connecting-ip": "203.0.113.9" }));
      refusals.push(await d.post(JSON.stringify({ public_key: newKey().key }), { ...origin, "cf-connecting-ip": "203.0.113.9" })); // 429 or 503 budget
      writeFileSync(d.killFile, "");
      refusals.push(await d.post(JSON.stringify({ public_key: newKey().key }), origin));
      refusals.push(await d.post("{nope", origin));
      assert.deepEqual(refusals.map((r) => r.status), [400, 200, 503, 503, 400]);
      for (const res of refusals.filter((r) => r.status >= 400)) {
        assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
        assert.equal(res.headers.get("access-control-allow-origin"), origin.origin);
        assert.equal(typeof ((await res.json()) as { error: unknown }).error, "string");
      }
    },
    { lifetimeCap: 1 },
  );
  await withDesk(false, async (d) => {
    const res = await d.post(JSON.stringify({ public_key: newKey().key }), origin);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("access-control-allow-origin"), origin.origin);
    assert.equal(typeof ((await res.json()) as { error: unknown }).error, "string");
  });
});

test("wrong methods are 405", async () => {
  await withDesk(true, async (d) => {
    assert.equal((await fetch(`${d.base}/faucet`)).status, 405);
    assert.equal((await fetch(`${d.base}/faucet/state`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 405);
  });
});
