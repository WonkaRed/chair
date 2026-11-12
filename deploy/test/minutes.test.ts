import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { sha256Hex } from "../src/deploy.ts";
import { describeMinutes, gatherMinutes, listEpochs } from "../src/minutes.ts";

const scratch = join(homedir(), ".scratch", "tmp");
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, "chair-deploy-minutes."));
after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "token.chair-coin.testnet";
const ACCOUNT = "challenger.chair-coin.testnet";
const text = (epoch: number) => `$CHAIR decision, epoch ${epoch}.\nRate in effect 0 bps; decision 10 bps.\n${"A long reasoning line. ".repeat(10)}`;
const txHash = (n: number) => `${String(n)}`.repeat(44).slice(0, 44);

/** One `set_policy` transaction in the shape the indexer returns it; `reasoning` is the extra argument the chair sends with the text. */
function tx(n: number, epoch: number, rate: number, hash: string, reasoning?: string) {
  const args = Buffer.from(JSON.stringify({ rate_bps: rate, reasoning_hash: hash, ...(reasoning === undefined ? {} : { reasoning }) })).toString("base64");
  const event = { standard: "chair", version: "1.0.0", event: "policy_set", data: { chair: ACCOUNT, epoch, rate_bps: rate, previous_rate_bps: 0, reasoning_hash: hash } };
  return {
    transaction: { hash: txHash(n), signer_id: ACCOUNT, actions: [{ FunctionCall: { method_name: "set_policy", args } }] },
    receipts: [{ execution_outcome: { block_height: 100 + n, block_timestamp: "1700000000000000000", outcome: { executor_id: TOKEN, status: { SuccessValue: "" }, logs: [`EVENT_JSON:${JSON.stringify(event)}`] } } }],
  };
}

/** A stand-in for the transaction index: lists `txs` and serves them back. Nothing else is reachable. */
function indexer(txs: ReturnType<typeof tx>[]): typeof fetch {
  return async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? "{}")) as { tx_hashes?: string[] };
    if (path === "/v0/account") return Response.json({ account_txs: txs.map((t) => ({ transaction_hash: t.transaction.hash })) });
    if (path === "/v0/transactions") return Response.json({ transactions: txs.filter((t) => body.tx_hashes?.includes(t.transaction.hash)) });
    return new Response("unexpected", { status: 404 });
  };
}

function docs(name: string, records: { epoch: number; reasoning: string; hash: string }[]): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const lines = records.map((r) => JSON.stringify({ v: 2, kind: "decision", epoch: r.epoch, chair: "local:model", chair_kind: "llm", rate_bps: 10, previous_rate_bps: 0, reasoning: r.reasoning, reasoning_hash: r.hash }));
  writeFileSync(join(dir, "testnet-run-agent-x-decisions.jsonl"), `${lines.join("\n")}\n`);
  return dir;
}

test("a recorded text that hashes to the chain's hash is verified; a decision without one says so", async () => {
  const dir = docs("match", [{ epoch: 1, reasoning: text(1), hash: sha256Hex(text(1)) }]);
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, dir, indexer([tx(1, 1, 10, sha256Hex(text(1))), tx(2, 2, 20, "b".repeat(64))]));
  assert.equal(m.error, null);
  assert.deepEqual(m.warnings, []);
  assert.deepEqual(m.decisions.map((d) => [d.epoch, d.rateBps, d.verdict]), [[2, 20, null], [1, 10, "verified"]]);
  const lines = describeMinutes(m);
  assert.equal(lines[0], "latest decisions on chain (2 of 2, newest first):");
  assert.equal(lines[1], `  epoch 2, rate +20 bps, reasoning_hash ${"b".repeat(64)}`);
  assert.equal(lines[2], "      no text in the transaction or in docs/ for this hash, so nothing to compare (not an error)");
  assert.equal(lines[3], `  epoch 1, rate +10 bps, reasoning_hash ${sha256Hex(text(1))}`);
  assert.equal(lines[4], `      "${text(1).replace(/\s+/g, " ").slice(0, 100)}..."`);
  assert.equal(lines[5], "      SHA-256 of the text recorded in docs/ equals the hash on chain");
  assert.deepEqual(lines.slice(6), ["", "decisions with no checkable text (1 of 2), by epoch: 2"]);
});

test("a text in the transaction's arguments is checked against the event's hash, and a wrong one is a mismatch", async () => {
  const txs = [tx(1, 1, 10, sha256Hex(text(1)), text(1)), tx(2, 2, 20, sha256Hex(text(2)), "not what was hashed"), tx(3, 3, 30, "e".repeat(64))];
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, docs("empty-chain", []), indexer(txs));
  assert.deepEqual(m.decisions.map((d) => [d.epoch, d.onChain, d.verdict]), [[3, false, null], [2, true, "mismatch"], [1, true, "verified"]]);
  const lines = describeMinutes(m);
  assert.ok(lines.includes("      SHA-256 of the text in the transaction's arguments equals the hash on chain"));
  assert.ok(lines.includes("      MISMATCH: SHA-256 of the text in the transaction's arguments is NOT the hash on chain"));
  assert.equal(lines.at(-1), "decisions with no checkable text (1 of 3), by epoch: 3");
});

test("the epochs without a checkable text are listed in order, runs of three or more as a range", () => {
  assert.equal(listEpochs([]), "");
  assert.equal(listEpochs([1, 2, 3, 4, 7, 8, 9, 10, 31, 32, 36, 37, 219, 220, 310]), "1 to 4, 7 to 10, 31, 32, 36, 37, 219, 220, 310");
  assert.equal(listEpochs([5, 6, 9]), "5, 6, 9");
});

test("a recorded text that does not hash to the chain's hash is a mismatch, never a pass", async () => {
  const dir = docs("mismatch", [{ epoch: 1, reasoning: text(1), hash: sha256Hex(text(1)) }]);
  // The chain holds a different hash for this decision than the one the record claims: the recorded text cannot be the chair's.
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, dir, indexer([tx(1, 1, 10, sha256Hex("something else"))]));
  assert.deepEqual(m.decisions.map((d) => d.verdict), [null]);
  // A record whose text was edited after the hash was written is refused by the bundler and reported, which fails the check.
  const edited = docs("edited", [{ epoch: 1, reasoning: `${text(1)} edited`, hash: sha256Hex(text(1)) }]);
  const e = await gatherMinutes(["https://rpc.invalid"], TOKEN, edited, indexer([tx(1, 1, 10, sha256Hex(text(1)))]));
  assert.equal(e.warnings.length, 1);
  assert.match(e.warnings[0] ?? "", /does not hash to its reasoning_hash/);
  assert.deepEqual(e.decisions.map((d) => d.verdict), [null]);
});

test("the list shows only the newest five, and a text is cut to 100 characters with control characters neutralised", async () => {
  const txs = [1, 2, 3, 4, 5, 6].map((n) => tx(n, n, 0, "c".repeat(64)));
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, docs("empty", []), indexer(txs));
  const lines = describeMinutes(m);
  assert.equal(lines[0], "latest decisions on chain (5 of 6, newest first):");
  assert.equal(lines.filter((l) => l.startsWith("  epoch ")).length, 5);
  assert.ok(lines[1]?.startsWith("  epoch 6, rate 0 bps"));
  const weird = { ...m, decisions: [{ ...(m.decisions[0] as (typeof m.decisions)[number]), text: "a\u001b[2Jb", verdict: "verified" as const }] };
  assert.equal(describeMinutes(weird)[2], '      "a?[2Jb"');
  const bad = { ...weird, decisions: weird.decisions.map((d) => ({ ...d, verdict: "mismatch" as const })) };
  assert.equal(describeMinutes(bad)[3], "      MISMATCH: SHA-256 of the text recorded in docs/ is NOT the hash on chain");
});

test("older decisions with a recorded text are listed after the newest five when those have none", async () => {
  const dir = docs("older", [{ epoch: 1, reasoning: text(1), hash: sha256Hex(text(1)) }]);
  const txs = [tx(1, 1, 10, sha256Hex(text(1))), ...[2, 3, 4, 5, 6, 7].map((n) => tx(n, n, 0, "d".repeat(64)))];
  const lines = describeMinutes(await gatherMinutes(["https://rpc.invalid"], TOKEN, dir, indexer(txs)));
  const at = lines.indexOf("latest decisions with a checkable text (1 more):");
  assert.ok(at > 0, lines.join("\n"));
  assert.equal(lines[at - 1], "");
  assert.equal(lines[at + 1], `  epoch 1, rate +10 bps, reasoning_hash ${sha256Hex(text(1))}`);
  assert.equal(lines.at(-3), "      SHA-256 of the text recorded in docs/ equals the hash on chain");
  assert.equal(lines.at(-1), "decisions with no checkable text (6 of 7), by epoch: 2 to 7");
});

test("an index that cannot be read is reported, not hidden, and a missing docs folder is a warning", async () => {
  const down: typeof fetch = async () => new Response("no", { status: 503 });
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, join(root, "does-not-exist"), down);
  assert.equal(m.error, "indexer: HTTP 503");
  assert.equal(m.warnings.length, 1);
  assert.deepEqual(describeMinutes(m), ["NOTE: the decisions on chain could not be read (indexer: HTTP 503), so the reasoning-hash check was skipped and is not counted; the other checks read the RPC only."]);
});

/** A stand-in index that pages like the real one: newest first, `limit` rows, a `resume_token` that names the next offset. */
function pagedIndexer(txs: ReturnType<typeof tx>[], loop = false): { fetch: typeof fetch; pages: () => number } {
  let pages = 0;
  const newestFirst = [...txs].reverse();
  return {
    pages: () => pages,
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = JSON.parse(String(init?.body ?? "{}")) as { tx_hashes?: string[]; limit?: number; resume_token?: string };
      if (path === "/v0/account") {
        pages++;
        const start = body.resume_token === undefined ? 0 : Number(body.resume_token);
        const rows = newestFirst.slice(start, start + (body.limit ?? 0));
        return Response.json({ account_txs: rows.map((t) => ({ transaction_hash: t.transaction.hash })), resume_token: loop ? "0" : String(start + rows.length) });
      }
      if (path === "/v0/transactions") return Response.json({ transactions: txs.filter((t) => body.tx_hashes?.includes(t.transaction.hash)) });
      return new Response("unexpected", { status: 404 });
    },
  };
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58Hash = (n: number) => `${B58[Math.floor(n / 58) % 58]}${B58[n % 58]}`.repeat(22);

test("the whole history is read, however many pages the index splits it into, oldest decision included", async () => {
  const many = Array.from({ length: 450 }, (_, i) => {
    const t = tx(i + 1, i + 1, 10, "b".repeat(64));
    t.transaction.hash = b58Hash(i);
    return t;
  });
  const index = pagedIndexer(many);
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, join(root, "does-not-exist"), index.fetch);
  assert.equal(m.error, null);
  assert.equal(index.pages(), 3);
  assert.equal(m.decisions.length, 450);
  assert.deepEqual([m.decisions[0]?.epoch, m.decisions.at(-1)?.epoch], [450, 1]);
});

test("an index that keeps handing back the same page token is a failure, not a quiet end of the history", async () => {
  const many = Array.from({ length: 450 }, (_, i) => {
    const t = tx(i + 1, i + 1, 10, "b".repeat(64));
    t.transaction.hash = b58Hash(i);
    return t;
  });
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, join(root, "does-not-exist"), pagedIndexer(many, true).fetch);
  assert.deepEqual(m.decisions, []);
  assert.equal(m.error, "indexer: the index repeated a page token: history not read to the end");
});

test("an index that never ends is a failure after the page cap, not a hang and not a truncated audit", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ transaction_hash: b58Hash(i) }));
  let pages = 0;
  const endless: typeof fetch = async (url) => {
    if (new URL(String(url)).pathname !== "/v0/account") return new Response("unexpected", { status: 404 });
    pages++;
    return Response.json({ account_txs: rows, resume_token: `page:${pages}` });
  };
  const m = await gatherMinutes(["https://rpc.invalid"], TOKEN, join(root, "does-not-exist"), endless);
  assert.deepEqual(m.decisions, []);
  assert.equal(m.error, "indexer: more than 10000 pages: history not read to the end");
  assert.equal(pages, 10_000);
});
