// The faucet with its real signer (FaucetSigner) over a model of the chain (faucet-chain.ts), driven through the ways a grant can be left unsure:
// an answer lost for a transaction that did or did not land, a record lost after one landed, a crash between the two. Each says a step is paid at most
// once, because a step is identified by its transaction (hash and signed bytes, recorded before the send), never by what the chain looks like.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { KeyPair, SignedTransaction } from "near-api-js";
import { FAUCET_GAS_MARGIN, Faucet, MAX_SIGNATURES, type FaucetLimits, type FaucetReader } from "../src/press-faucet.js";
import { FAUCET_GRANT_CHAIR, FAUCET_GRANT_NEAR, FAUCET_STEPS, FAUCET_STORAGE_DEPOSIT, FaucetSigner, type FaucetSender, type FaucetStep } from "../src/signer.js";
import { ChainSim } from "./faucet-chain.js";
import { tempDir } from "./helpers.js";

const root = tempDir("faucet-resume");
after(() => rmSync(root, { recursive: true, force: true }));
let seq = 0;

const secret = KeyPair.fromRandom("ed25519").toString();
const ENOUGH = { near: FAUCET_GRANT_NEAR + FAUCET_STORAGE_DEPOSIT + FAUCET_GAS_MARGIN, chair: FAUCET_GRANT_CHAIR };
const instant = { sleep: () => Promise.resolve(), attempts: 4, backoffMs: 1 };
const newKey = (): { key: string; account: string } => {
  const pub = KeyPair.fromRandom("ed25519").getPublicKey();
  return { key: pub.toString(), account: Buffer.from(pub.data).toString("hex") };
};
const body = (r: { body: Record<string, unknown> }): Record<string, unknown> => r.body;
const decoded = (b64: string): SignedTransaction => SignedTransaction.decode(Buffer.from(b64, "base64"));

function desk(sim = new ChainSim()) {
  const dir = join(root, String(++seq));
  mkdirSync(dir);
  const stateFile = join(dir, "faucet.json");
  // The chain's own answer for "does this account exist": the reader that finds out about a visitor's key, as the live one does.
  const reader: FaucetReader = { exists: (id) => Promise.resolve(sim.count("transfer", id) > 0), funds: () => Promise.resolve(ENOUGH) };
  /** A desk process: a faucet and a signer, new every time (a restart forgets what the signer remembered), over the same file and the same chain. */
  const boot = (wrap: (real: FaucetSigner) => FaucetSender = (real) => real, limits: Partial<FaucetLimits> = {}): Faucet =>
    new Faucet({ reader, sender: wrap(new FaucetSigner(secret, "faucet.test", "token.test", sim.rpc, sim.archival, instant)), stateFile, limits: { hourlyCap: 100, dailyCap: 100, ...limits } });
  const ledger = (): { grants: { account: string; steps: Record<string, string>; signed: number; gaveUp?: string; pending?: { step: string; hash: string; tx: string } }[] } => JSON.parse(readFileSync(stateFile, "utf8"));
  return { sim, boot, ledger };
}

test("transfer sent, its answer lost, the visitor asks again before it lands: no second transfer is signed, and when it lands the grant completes with one transfer", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n === 1 ? "pool-lost" : "land");
  const f = boot();
  const { key, account } = newKey();
  const first = await f.start(key, "1.1.1.1");
  assert.equal(first.status, 502);
  assert.equal(body(first)["failed_step"], "transfer");
  const stored = ledger().grants[0]!.pending!;
  assert.equal(stored.step, "transfer");
  assert.equal(new Set(sim.sends).size, 1);

  const early = await f.start(key, "1.1.1.1");
  assert.equal(early.status, 502);
  assert.equal(new Set(sim.sends).size, 1, "still the one transaction: nothing was signed to replace it");
  assert.equal(ledger().grants[0]!.pending!.hash, stored.hash);

  sim.mine();
  const done = await f.start(key, "1.1.1.1");
  assert.equal(done.status, 200);
  assert.equal(sim.count("transfer", account), 1, "0.05 NEAR, not 0.10");
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
  assert.equal((body(done)["txs"] as string[])[0], stored.hash);
});

test("the same restart, a new process: a transfer that is waiting is still waited for, not replaced", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n === 1 ? "pool-lost" : "land");
  const { key, account } = newKey();
  assert.equal((await boot().start(key, "1.1.1.1")).status, 502);
  const stored = ledger().grants[0]!.pending!;
  assert.equal((await boot().start(key, "1.1.1.1")).status, 502);
  assert.equal(new Set(sim.sends).size, 1);
  sim.mine();
  assert.equal((await boot().start(key, "1.1.1.1")).status, 200);
  assert.equal(sim.count("transfer", account), 1);
  assert.equal(ledger().grants[0]!.steps["transfer"], stored.hash);
});

test("a transfer the network never received is sent again as the very same bytes, once, and lands once", async () => {
  const { sim, boot } = desk();
  sim.plan = (n) => (n <= 2 ? "drop-lost" : "land");
  const f = boot();
  const { key, account } = newKey();
  assert.equal((await f.start(key, "1.1.1.1")).status, 502);
  assert.equal((await f.start(key, "1.1.1.1")).status, 200);
  assert.equal(new Set(sim.sends.slice(0, 3)).size, 1, "three sends of one transaction");
  assert.equal(sim.count("transfer", account), 1);
});

test("ft_transfer landed, its answer lost and the record of it lost; the visitor moves the CHAIR away and asks again: no second 50 CHAIR", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n === 3 ? "land-lost" : "land");
  sim.onReach = () => {
    if (sim.sends.length === 3) sim.lookupsDown = 99; // the node that lost the answer cannot say either
  };
  const { key, account } = newKey();
  const first = await boot().start(key, "1.1.1.1");
  assert.equal(first.status, 502);
  assert.equal(body(first)["failed_step"], "ft_transfer");
  assert.equal(sim.count("ft_transfer", account), 1, "it did land");
  assert.equal(ledger().grants[0]!.steps["ft_transfer"], undefined, "and the desk has no record of it");
  assert.ok(ledger().grants[0]!.pending, "only the transaction it sent");

  // The visitor spends the CHAIR: the account now holds none. The desk does not look.
  sim.lookupsDown = 0;
  const done = await boot().start(key, "1.1.1.1");
  assert.equal(done.status, 200);
  assert.equal(sim.count("ft_transfer", account), 1, "still one");
  assert.equal(sim.sends.length, 3);
  assert.equal(ledger().grants[0]!.pending, undefined);
});

test("a crash between a step landing and its record being written: the next ask finds the transaction by its hash and does not send the step again", async () => {
  const { sim, boot } = desk();
  let crashed = false;
  const f = boot((real) => ({
    grant: (receiver, finished, pending, hooks, deadlineAt) =>
      real.grant(receiver, finished, pending, {
        ...hooks,
        onStep: (step, tx) => {
          if (step === "storage_deposit" && !crashed) {
            crashed = true;
            throw new Error("the process died here");
          }
          hooks.onStep(step, tx);
        },
      }, deadlineAt),
  }));
  const { key, account } = newKey();
  assert.equal((await f.start(key, "1.1.1.1")).status, 502);
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal((await boot().start(key, "1.1.1.1")).status, 200);
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
  assert.equal(sim.sends.length, 3);
});

test("a step the chain ran and failed is signed afresh on the next ask, and only that one counts", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n === 2 ? "fail" : "land");
  const f = boot();
  const { key, account } = newKey();
  const first = await f.start(key, "1.1.1.1");
  assert.equal(first.status, 502);
  assert.equal(body(first)["failed_step"], "storage_deposit");
  const failed = ledger().grants[0]!.pending!;
  assert.equal(failed.step, "storage_deposit", "kept: the next ask looks it up, and only that look (executed with a failure) lets it sign again");
  assert.equal((await f.start(key, "1.1.1.1")).status, 200);
  assert.notEqual(ledger().grants[0]!.steps["storage_deposit"], failed.hash);
  assert.equal(sim.sends.length, 4, "transfer, storage_deposit (failed), storage_deposit (again), ft_transfer");
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
});

test("a stored transaction the network now refuses (expired, nonce used) and no node knows is never replaced: no fresh signature, the record keeps it, the grant stays on try again", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n <= 2 ? "drop-lost" : "land");
  const f = boot();
  const { key, account } = newKey();
  assert.equal((await f.start(key, "1.1.1.1")).status, 502);
  const old = ledger().grants[0]!.pending!;
  sim.rejected.add(old.hash);
  for (let i = 0; i < 3; i++) assert.equal((await f.start(key, "1.1.1.1")).status, 502);
  assert.equal(new Set(sim.sends).size, 1, "only the stored bytes were ever sent");
  assert.equal(ledger().grants[0]!.pending!.hash, old.hash);
  assert.equal(sim.count("transfer", account), 0);
});

test("a grant whose first send is refused with a 429 before it was accepted is settled by the lookup and resent: one transfer", async () => {
  const { sim, boot } = desk();
  sim.plan = (n) => (n === 1 ? "refuse-429" : "land");
  const { key, account } = newKey();
  assert.equal((await boot().start(key, "1.1.1.1")).status, 200);
  assert.equal(sim.count("transfer", account), 1);
});

// What the chain really does that a model without these states hid: an ordinary node forgets a transaction after about 31 hours while the archival node
// still knows it; a transaction can be included (nonce used) before its receipts have run. Payments are counted from the executed transactions the chain
// kept (`sim.count`), never from the faucet's own record.

/** A transfer that executed, its answer lost and the node that lost it unable to say either; the desk's record holds it as pending. */
async function landedAndLost(boot: () => Faucet, sim: ChainSim, key: string): Promise<void> {
  sim.plan = (n) => (n === 1 ? "land-lost" : "land");
  sim.onReach = () => {
    if (sim.sends.length === 1) sim.lookupsDown = 99;
  };
  assert.equal((await boot().start(key, "1.1.1.1")).status, 502);
  sim.lookupsDown = 0;
}

test("a step that landed, was forgotten by the ordinary nodes and is resumed days later is found on the archival node: one payment, not two", async () => {
  const { sim, boot, ledger } = desk();
  const { key, account } = newKey();
  await landedAndLost(boot, sim, key);
  assert.equal(sim.count("transfer", account), 1);
  const stored = ledger().grants[0]!.pending!;
  sim.gc();
  const done = await boot().start(key, "1.1.1.1");
  assert.equal(done.status, 200);
  assert.equal(sim.count("transfer", account), 1, "0.05 NEAR, not 0.10");
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
  assert.equal(ledger().grants[0]!.steps["transfer"], stored.hash, "the very transaction that landed");
});

test("a transaction included but not yet executed when the resent bytes are refused is waited for, never replaced: one payment, and the next ask completes the grant", async () => {
  const { sim, boot, ledger } = desk();
  const { key, account } = newKey();
  sim.plan = () => "pool-lost";
  assert.equal((await boot().start(key, "1.1.1.1")).status, 502);
  const stored = ledger().grants[0]!.pending!;
  const before = sim.sends.length;
  sim.beforeSend = (n) => {
    if (n === before + 1) sim.include(); // a block takes it between the lookup that found nothing and the send
  };
  const second = await boot().start(key, "1.1.1.1");
  assert.equal(second.status, 502);
  assert.equal(body(second)["failed_step"], "transfer");
  assert.equal(new Set(sim.sends).size, 1, "nothing was signed to replace it");
  assert.equal(ledger().grants[0]!.pending!.hash, stored.hash);
  sim.mine();
  sim.plan = () => "land";
  const done = await boot().start(key, "1.1.1.1");
  assert.equal(done.status, 200);
  assert.equal(sim.count("transfer", account), 1);
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
  assert.equal(ledger().grants[0]!.steps["transfer"], stored.hash);
});

test("no archival node answers: the stored transaction is kept and nothing is signed; when one answers again the grant completes with one payment", async () => {
  const { sim, boot, ledger } = desk();
  const { key, account } = newKey();
  await landedAndLost(boot, sim, key);
  const stored = ledger().grants[0]!.pending!;
  sim.gc();
  sim.archivalDown = 99;
  const blind = await boot().start(key, "1.1.1.1");
  assert.equal(blind.status, 502);
  assert.equal(body(blind)["failed_step"], "transfer");
  assert.equal(new Set(sim.sends).size, 1, "nothing was signed: only the stored bytes were sent again");
  assert.equal(ledger().grants[0]!.pending!.hash, stored.hash, "kept");
  assert.equal(sim.count("transfer", account), 1);
  sim.archivalDown = 0;
  assert.equal((await boot().start(key, "1.1.1.1")).status, 200);
  assert.equal(sim.count("transfer", account), 1);
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
});

test("a step the chain keeps failing is signed three times in all, counted in the record, then answers a permanent failure for that key without sending", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n === 1 ? "land" : "fail");
  const { key, account } = newKey();
  const f = boot();
  for (let i = 1; i <= MAX_SIGNATURES; i++) {
    const r = await f.start(key, "1.1.1.1");
    assert.equal(r.status, 502);
    assert.equal(body(r)["failed_step"], "storage_deposit");
    assert.equal(ledger().grants[0]!.signed, i);
  }
  assert.equal(sim.sends.length, 1 + MAX_SIGNATURES);
  for (const asker of [f, boot()]) {
    const r = await asker.start(key, "1.1.1.1");
    assert.equal(r.status, 502);
    assert.equal(body(r)["failed_step"], "storage_deposit");
    assert.match(String(body(r)["error"]), /will not try again/);
  }
  assert.equal(sim.sends.length, 1 + MAX_SIGNATURES, "nothing more was signed or sent");
  assert.equal(ledger().grants[0]!.signed, MAX_SIGNATURES);
  assert.equal(ledger().grants[0]!.gaveUp, "storage_deposit", "the give-up is in the record");
  const reads = sim.reads;
  const later = await boot().start(key, "1.1.1.1");
  assert.equal(later.status, 502);
  assert.equal(body(later)["failed_step"], "storage_deposit");
  assert.equal(sim.reads, reads, "answered from the record: the chain was not read");
  assert.equal(sim.count("transfer", account), 1);
  assert.equal(sim.count("storage_deposit", account), 0);
});

test("a congested shard refuses a transaction that still sits in a pool, on the first send and on the resume: nothing is signed, and when it lands the grant completes with one payment", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n <= 2 ? "refuse-congested" : "land");
  const { key, account } = newKey();
  const f = boot(); // one process throughout: its next nonce is above the stored one, so a fresh signature could land beside it
  assert.equal((await f.start(key, "1.1.1.1")).status, 502);
  const stored = ledger().grants[0]!.pending!;
  assert.equal((await f.start(key, "1.1.1.1")).status, 502, "the resend is refused too, and no node knows the transaction");
  assert.equal(new Set(sim.sends).size, 1, "nothing was signed to replace it");
  assert.equal(ledger().grants[0]!.pending!.hash, stored.hash);
  sim.mine();
  const done = await f.start(key, "1.1.1.1");
  assert.equal(done.status, 200);
  assert.equal(sim.count("transfer", account), 1, "0.05 NEAR, not 0.10");
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
  assert.equal(ledger().grants[0]!.steps["transfer"], stored.hash);
});

test("an archival node that never answers cannot hold a request: it ends in a 502 within the deadline, the stored transaction is kept, and the queue serves the next key", async () => {
  const { sim, boot, ledger } = desk();
  const { key, account } = newKey();
  await landedAndLost(boot, sim, key);
  const stored = ledger().grants[0]!.pending!;
  sim.gc();
  sim.archivalHangs = true;
  const f = boot(undefined, { requestDeadlineMs: 1_000 });
  const t0 = Date.now();
  const stuck = await f.start(key, "1.1.1.1");
  assert.equal(stuck.status, 502);
  assert.ok(Date.now() - t0 < 5_000, `answered in ${Date.now() - t0} ms`);
  assert.equal(ledger().grants[0]!.pending!.hash, stored.hash);
  sim.plan = () => "land";
  const other = newKey();
  assert.equal((await f.start(other.key, "2.2.2.2")).status, 200, "the queue is free");
  sim.archivalHangs = false;
  assert.equal((await f.start(key, "1.1.1.1")).status, 200);
  assert.equal(sim.count("transfer", account), 1);
  assert.equal(sim.count("storage_deposit", account), 1);
  assert.equal(sim.count("ft_transfer", account), 1);
});

test("three slow but successful steps stop with a 502 inside the request's deadline, whichever step it falls in, and the next ask finishes the grant with one payment each", async () => {
  const { sim, boot, ledger } = desk();
  sim.latencyMs = 120; // 360 ms of sends against a 300 ms deadline
  const { key, account } = newKey();
  const f = boot(undefined, { requestDeadlineMs: 300 });
  const t0 = Date.now();
  const cut = await f.start(key, "1.1.1.1");
  assert.ok(Date.now() - t0 < 1_500, `answered in ${Date.now() - t0} ms`);
  assert.equal(cut.status, 502);
  assert.ok(FAUCET_STEPS.includes(body(cut)["failed_step"] as FaucetStep), JSON.stringify(body(cut)));
  assert.ok(ledger().grants[0]!.pending, "the step in hand is kept");
  sim.latencyMs = 0;
  assert.equal((await boot().start(key, "1.1.1.1")).status, 200);
  for (const step of FAUCET_STEPS) assert.equal(sim.count(step, account), 1, step);
});

test("a restart forgets the nonce the signer used: a new grant is signed above a transaction still pending for another key, so both complete with one payment each", async () => {
  const { sim, boot, ledger } = desk();
  sim.plan = (n) => (n === 1 ? "pool-lost" : "land");
  const a = newKey();
  const b = newKey();
  assert.equal((await boot().start(a.key, "1.1.1.1")).status, 502);
  assert.equal(ledger().grants[0]!.account, a.account);
  const pooled = decoded(ledger().grants[0]!.pending!.tx).transaction.nonce;
  // A new process, with the first one's transaction still in a pool: the chain's own count does not show it yet.
  const restarted = boot();
  assert.equal((await restarted.start(b.key, "2.2.2.2")).status, 200);
  assert.ok(decoded(sim.sends[sim.sends.length - 1]!).transaction.nonce > pooled);
  sim.mine();
  assert.equal((await restarted.start(a.key, "1.1.1.1")).status, 200);
  for (const who of [a, b]) for (const step of FAUCET_STEPS) assert.equal(sim.count(step, who.account), 1, `${step} for ${who.account.slice(0, 6)}`);
});
