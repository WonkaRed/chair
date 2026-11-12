#!/usr/bin/env node
// Daily-ish watch over the live $CHAIR demo (run by chair3-balance-watch.timer, every 6 h). Testnet only; reads, never signs.
//
// 1. Every account the demo spends gas from: how many days its NEAR lasts at the burn measured over the last 24 h,
//    against the end of judging (WATCH_UNTIL). The burn is read from the RPC's own history (one balance sample every 2 h,
//    only the drops counted, so a top-up never hides spending). Days left are counted from the spendable balance:
//    amount, minus the NEAR locked for storage, minus a 0.05 NEAR reserve (the activity bot stops there too).
// 2. The four chair3 units are active, the decision log is fresh, and the address the gist publishes answers /health.
//
// One line per account on stdout. Any problem prints a PROBLEM line, runs
//   pixelbot-notify "<what> | 0 | Survival"
// and makes the exit status 1. No dependencies beyond Node 22 and systemctl.
//
// Env (all optional): CHAIR_RPC_URL, WATCH_UNTIL (default 2026-11-26T23:59:59Z), WATCH_MARGIN_DAYS (default 1: alert a day
// before an account would run dry, so there is time to fund it), PRESS_GIST_ID, CHAIR_STATE_DIR, WATCH_NO_NOTIFY=1 (print only).

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const RPC = process.env.CHAIR_RPC_URL ?? "https://test.rpc.fastnear.com";
const UNTIL_MS = Date.parse(process.env.WATCH_UNTIL ?? "2026-11-26T23:59:59Z");
const MARGIN_DAYS = Number(process.env.WATCH_MARGIN_DAYS ?? "1");
const GIST_ID = process.env.PRESS_GIST_ID ?? "03480ab34ee914911577adfd2a8b6a63";
const GIST_OWNER = "WonkaRed";
const STATE = process.env.CHAIR_STATE_DIR ?? join(homedir(), ".local", "state", "chair3-agent");
const NO_NOTIFY = process.env.WATCH_NO_NOTIFY === "1";

if (!Number.isFinite(UNTIL_MS) || !Number.isFinite(MARGIN_DAYS)) throw new Error("bad WATCH_UNTIL or WATCH_MARGIN_DAYS");
if (!/^(test\.|rpc\.testnet\.)/.test(new URL(RPC).hostname)) throw new Error(`refusing a non-testnet RPC: ${RPC}`);

/** The live token's accounts, read from its deployment record, so the watch cannot drift from the token the units run. */
const { parent, accounts: deployed } = JSON.parse(readFileSync(new URL("../../docs/testnet-deployment.json", import.meta.url), "utf8"));

/** Everything the live demo spends gas from: the chair signer, the three activity bots, the Join pool, the visitor faucet, and the sister demo's three spenders. */
const ACCOUNTS = [
  deployed.challenger,
  deployed.alice,
  deployed.bob,
  deployed.carol,
  `visitors.${parent}`,
  "chair-faucet-3.testnet",
  "switch.preflight-guard.testnet",
  "chameleon.preflight-guard.testnet",
  "robber.preflight-guard.testnet",
];
const UNITS = ["chair3-agent", "chair3-activity", "chair3-press", "chair3-press-tunnel"];

const YOCTO = 10n ** 24n;
const RESERVE = 5n * 10n ** 22n; // 0.05 NEAR
const BYTE_COST = 10n ** 19n; // yoctoNEAR locked per byte of storage
const HOUR_MS = 3_600_000;
const STEP_BLOCKS = 7200; // 2 h of blocks at about 1 s
const SAMPLES = 12; // one per 2 h, back 24 h: fewer calls, the public RPC rate-limits
const MIN_SPAN_MS = 2 * HOUR_MS; // below this the measured burn means nothing
const MIN_UNMEASURED = 2n * 10n ** 23n; // 0.2 NEAR: with no burn to measure (a fresh account), alert only when it is nearly dry
const DECISION_STALE_MS = 20 * 60_000; // epochs are 90 s

const near = (y) => (Number(y) / 1e24).toFixed(3);

async function rpc(method, params) {
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json();
      if (body.error) {
        // A block the node no longer keeps, or an account that did not exist yet: the caller treats it as a missing sample.
        const e = new Error(`${method}: ${body.error.cause?.name ?? body.error.name ?? JSON.stringify(body.error).slice(0, 200)}`);
        e.rpcCause = body.error.cause?.name;
        throw e;
      }
      return body.result;
    } catch (e) {
      last = e;
      if (e.rpcCause) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); // the public RPC rate-limits (429): back off
    }
  }
  throw last;
}

/** Runs `fn` over `items` with at most `n` in flight; results keep the order of `items`. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** The final block now, then one block every 2 h back (heights are about 1 s apart; the block's own timestamp is what is used). */
async function sampleBlocks() {
  const head = (await rpc("block", { finality: "final" })).header;
  const blocks = [{ hash: head.hash, ms: Number(BigInt(head.timestamp) / 1_000_000n) }];
  const older = await pool(Array.from({ length: SAMPLES }, (_, i) => i + 1), 3, async (k) => {
    for (let skip = 0; skip < 5; skip++) {
      try {
        const h = (await rpc("block", { block_id: head.height - k * STEP_BLOCKS + skip })).header;
        return { hash: h.hash, ms: Number(BigInt(h.timestamp) / 1_000_000n) };
      } catch {
        // skipped height or a block the node has dropped: try the next height, then give up on this sample
      }
    }
    return null;
  });
  return [...blocks, ...older.filter(Boolean)].sort((a, b) => a.ms - b.ms);
}

async function balanceAt(account, block) {
  try {
    const r = await rpc("query", { request_type: "view_account", block_id: block.hash, account_id: account });
    return { ms: block.ms, amount: BigInt(r.amount), storage: BigInt(r.storage_usage) };
  } catch (e) {
    if (e.rpcCause) return null; // did not exist yet, or history dropped
    throw e;
  }
}

async function checkAccount(account, blocks) {
  const samples = (await pool(blocks, 3, (b) => balanceAt(account, b))).filter(Boolean);
  const now = samples.at(-1);
  if (!now || now.ms !== blocks.at(-1).ms) throw new Error(`${account}: no account at the latest block`);
  const spendable = now.amount - now.storage * BYTE_COST - RESERVE;
  const spanMs = now.ms - samples[0].ms;
  let drops = 0n;
  for (let i = 1; i < samples.length; i++) if (samples[i].amount < samples[i - 1].amount) drops += samples[i - 1].amount - samples[i].amount;
  const base = { account, balance: now.amount, spendable, spanH: spanMs / HOUR_MS };
  if (spanMs < MIN_SPAN_MS) return { ...base, burnPerDay: null, daysLeft: null };
  const burnPerDay = (Number(drops) / 1e24) * (86_400_000 / spanMs);
  const daysLeft = burnPerDay === 0 ? Infinity : Math.max(Number(spendable) / 1e24, 0) / burnPerDay;
  return { ...base, burnPerDay, daysLeft };
}

async function unitProblems() {
  const problems = [];
  const { stdout } = await run("systemctl", ["--user", "is-active", ...UNITS]).catch((e) => ({ stdout: e.stdout ?? "" }));
  const states = stdout.trim().split("\n");
  UNITS.forEach((u, i) => {
    if (states[i] !== "active") problems.push(`${u} is ${states[i] || "unknown"}, not active`);
  });
  try {
    const age = Date.now() - statSync(join(STATE, "decisions.jsonl")).mtimeMs;
    if (age > DECISION_STALE_MS) problems.push(`chair decision log not written for ${Math.round(age / 60_000)} min`);
  } catch (e) {
    problems.push(`chair decision log unreadable: ${e.code ?? e.message}`);
  }
  return problems;
}

async function gistProblem() {
  try {
    const raw = `https://gist.githubusercontent.com/${GIST_OWNER}/${GIST_ID}/raw/chair-press.json?t=${Date.now()}`;
    const { url } = await (await fetch(raw, { signal: AbortSignal.timeout(15_000) })).json();
    if (typeof url !== "string" || !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(url)) return `gist publishes no tunnel address (${String(url).slice(0, 60)})`;
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(15_000) });
    return res.ok ? null : `press tunnel ${url} answers /health with HTTP ${res.status}`;
  } catch (e) {
    return `press tunnel check failed: ${e.message}`;
  }
}

async function notify(message) {
  if (NO_NOTIFY) return;
  try {
    await run("pixelbot-notify", [`${message} | 0 | Survival`], { timeout: 90_000 });
  } catch (e) {
    console.error(`pixelbot-notify failed: ${e.message.split("\n")[0]}`);
  }
}

const problems = [];
const needDays = (UNTIL_MS - Date.now()) / 86_400_000 + MARGIN_DAYS;

try {
  const blocks = await sampleBlocks();
  const results = await pool(ACCOUNTS, 1, (a) => checkAccount(a, blocks).catch((e) => ({ account: a, error: e.message })));
  for (const r of results) {
    if (r.error) {
      console.log(`${r.account.padEnd(36)} ERROR ${r.error}`);
      problems.push(`${r.account} unreadable: ${r.error}`);
      continue;
    }
    const low = r.daysLeft === null ? r.spendable < MIN_UNMEASURED : r.daysLeft < needDays;
    const burn = r.burnPerDay === null ? `burn unmeasured (history under 2 h), spendable ${near(r.spendable)}` : `burn ${r.burnPerDay.toFixed(4)}/day over ${r.spanH.toFixed(1)} h, about ${Number.isFinite(r.daysLeft) ? r.daysLeft.toFixed(1) : "unlimited"} days left (need ${needDays.toFixed(1)})`;
    console.log(`${r.account.padEnd(36)} ${near(r.balance).padStart(8)} NEAR  ${burn}  ${low ? "LOW" : "ok"}`);
    if (low) problems.push(`${r.account} low: ${near(r.balance)} NEAR, about ${r.daysLeft === null ? "0" : r.daysLeft.toFixed(1)} days left`);
  }
} catch (e) {
  console.log(`RPC ${RPC} unreadable: ${e.message}`);
  problems.push(`balance watch cannot read ${RPC}: ${e.message}`);
}

const gist = await gistProblem();
const units = await unitProblems();
for (const p of [...units, ...(gist ? [gist] : [])]) problems.push(p);
console.log(`units ${UNITS.join(" ")}: ${units.length === 0 ? "active, decision log fresh" : "PROBLEM"}; press tunnel via gist: ${gist ?? "answers /health"}`);

for (const p of problems) {
  console.log(`PROBLEM ${p}`);
  await notify(p);
}
process.exitCode = problems.length === 0 ? 0 : 1;
