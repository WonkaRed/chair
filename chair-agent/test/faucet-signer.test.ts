import assert from "node:assert/strict";
import { test } from "node:test";
import { KeyPair, SignedTransaction } from "near-api-js";
import { NearRpc } from "../src/rpc.js";
import { ChainSim, blockHash as simBlock, hashOf } from "./faucet-chain.js";
import {
  FAUCET_GAS,
  FAUCET_GRANT_CHAIR,
  FAUCET_GRANT_NEAR,
  FAUCET_MEMO,
  FAUCET_STEPS,
  FAUCET_STORAGE_DEPOSIT,
  FaucetSigner,
  KeyError,
  type FaucetHooks,
  type FaucetStep,
  type PendingTx,
} from "../src/signer.js";

const secret = KeyPair.fromRandom("ed25519").toString();
const blockHash = simBlock;
const FAUCET = "faucet.test";
const TOKEN = "token.test";
const VISITOR = "ab".repeat(32);
const instant = { sleep: () => Promise.resolve(), attempts: 4, backoffMs: 1 };
const signer = (rpc: unknown = {}, archival: unknown = rpc): FaucetSigner => new FaucetSigner(secret, FAUCET, TOKEN, rpc as NearRpc, archival as NearRpc, instant);
/** Hooks that record what the signer reports, in order. */
const hooks = (halt: () => boolean = () => false): FaucetHooks & { steps: [FaucetStep, string][]; pending: PendingTx[] } => {
  const steps: [FaucetStep, string][] = [];
  const pending: PendingTx[] = [];
  return { steps, pending, onPending: (tx) => void pending.push(tx), onStep: (step, tx) => void steps.push([step, tx]), halt, nonceFloor: () => 0n };
};
const NONE: ReadonlySet<FaucetStep> = new Set();
/** A deadline far enough off not to matter. */
const far = (): number => Date.now() + 60_000;
const decode = async (step: FaucetStep, receiver = VISITOR) => SignedTransaction.decode((await signer().build(step, receiver, 41n, blockHash)).encode()).transaction;
const argsOf = (call: { args: Uint8Array }): unknown => JSON.parse(Buffer.from(call.args).toString("utf8"));

test("the grant's constants: 50 CHAIR at 24 decimals, 0.05 NEAR, the token's exact registration fee", () => {
  assert.equal(FAUCET_GRANT_CHAIR, 50_000_000_000_000_000_000_000_000n);
  assert.equal(FAUCET_GRANT_NEAR, 50_000_000_000_000_000_000_000n);
  assert.equal(FAUCET_STORAGE_DEPOSIT, 1_250_000_000_000_000_000_000n, "storage_balance_bounds on the live token: min = max = 0.00125 NEAR");
  assert.deepEqual(FAUCET_STEPS, ["transfer", "storage_deposit", "ft_transfer"]);
});

test("step 1 is one Transfer of the fixed NEAR to the visitor's account and nothing else", async () => {
  const tx = await decode("transfer");
  assert.equal(tx.signerId, FAUCET);
  assert.equal(tx.receiverId, VISITOR);
  assert.equal(tx.nonce, 42n);
  assert.equal(tx.actions.length, 1);
  assert.equal(tx.actions[0]!.transfer?.deposit, FAUCET_GRANT_NEAR);
  assert.equal(tx.actions[0]!.functionCall, undefined);
});

test("step 2 is one storage_deposit on the token for the visitor's account, with the fixed registration deposit", async () => {
  const tx = await decode("storage_deposit");
  assert.equal(tx.receiverId, TOKEN);
  assert.equal(tx.actions.length, 1);
  const call = tx.actions[0]!.functionCall!;
  assert.equal(call.methodName, "storage_deposit");
  assert.deepEqual(argsOf(call), { account_id: VISITOR });
  assert.equal(call.deposit, FAUCET_STORAGE_DEPOSIT);
  assert.equal(call.gas, FAUCET_GAS);
});

test("step 3 is one ft_transfer of exactly the fixed CHAIR and the fixed memo, with exactly 1 yoctoNEAR", async () => {
  const tx = await decode("ft_transfer");
  assert.equal(tx.receiverId, TOKEN);
  assert.equal(tx.actions.length, 1);
  const call = tx.actions[0]!.functionCall!;
  assert.equal(call.methodName, "ft_transfer");
  assert.deepEqual(argsOf(call), { receiver_id: VISITOR, amount: "50000000000000000000000000", memo: FAUCET_MEMO });
  assert.equal(FAUCET_MEMO, "chair faucet: test coins for a page visitor");
  assert.equal(call.deposit, 1n);
  assert.equal(call.gas, FAUCET_GAS);
});

test("no other receiver shape is accepted: not a named account, not the faucet's, not upper case, not the wrong length", async () => {
  const bad = ["", "alice.testnet", TOKEN, FAUCET, VISITOR.toUpperCase(), VISITOR.slice(1), `${VISITOR}a`, `0x${VISITOR.slice(2)}`, `${VISITOR.slice(0, 63)}g`, `${VISITOR}\n`, ` ${VISITOR}`];
  for (const receiver of bad) {
    for (const step of FAUCET_STEPS) await assert.rejects(signer().build(step, receiver, 1n, blockHash), RangeError, `${step} ${JSON.stringify(receiver)}`);
    let touched = 0;
    const rpc = { accessKey: () => (touched++, Promise.reject(new Error("no"))), finalBlock: () => (touched++, Promise.reject(new Error("no"))), sendTx: () => (touched++, Promise.reject(new Error("no"))) };
    await assert.rejects(signer(rpc).grant(receiver, NONE, null, { ...hooks(), onPending: () => void touched++ }, far()), RangeError, JSON.stringify(receiver));
    assert.equal(touched, 0, "nothing was read, signed or sent");
  }
  assert.ok(await decode("transfer", "00".repeat(32)));
});

test("no other step exists at run time", async () => {
  for (const step of ["deploy_contract", "ft_transfer_call", "stake", "delete_account", "", "Transfer"]) {
    await assert.rejects(signer().build(step as FaucetStep, VISITOR, 1n, blockHash), /no such faucet step/, step);
  }
});


const grant = (sim: ChainSim, h: ReturnType<typeof hooks> = hooks(), pending: PendingTx | null = null, finished: ReadonlySet<FaucetStep> = NONE) =>
  signer(sim.rpc).grant(VISITOR, finished, pending, h, far());
const decoded = (b64: string): SignedTransaction => SignedTransaction.decode(Buffer.from(b64, "base64"));

test("a grant records each transaction before it is sent, with its hash and its signed bytes, sends the three steps in order each with the next nonce, and reports each step after it executed", async () => {
  const sim = new ChainSim();
  const order: string[] = [];
  const h = hooks();
  const record = { ...h, onPending: (tx: PendingTx) => (order.push(`pending ${tx.step} after ${sim.sends.length} sent`), h.onPending(tx)), onStep: (s: FaucetStep, t: string) => (order.push(`done ${s}`), h.onStep(s, t)) };
  const out = await grant(sim, record);
  assert.deepEqual(out.failed, null);
  assert.deepEqual(order, ["pending transfer after 0 sent", "done transfer", "pending storage_deposit after 1 sent", "done storage_deposit", "pending ft_transfer after 2 sent", "done ft_transfer"]);
  assert.deepEqual(sim.sends.map((b) => decoded(b).transaction.nonce), [101n, 102n, 103n]);
  assert.deepEqual(h.pending.map((p) => p.tx), sim.sends, "what was recorded is what was sent");
  assert.deepEqual(h.pending.map((p) => p.hash), sim.sends.map((b) => hashOf(decoded(b))));
  assert.deepEqual(out.txs, h.pending.map((p) => p.hash));
  assert.deepEqual(h.steps.map(([s]) => s), [...FAUCET_STEPS]);
  for (const step of FAUCET_STEPS) assert.equal(sim.count(step, VISITOR), 1);
});

test("steps already finished are not sent again", async () => {
  const sim = new ChainSim();
  const out = await grant(sim, hooks(), null, new Set<FaucetStep>(["transfer", "storage_deposit"]));
  assert.equal(out.failed, null);
  assert.deepEqual(sim.effects.map((e) => e.step), ["ft_transfer"]);
  assert.equal((await grant(sim, hooks(), null, new Set(FAUCET_STEPS))).txs.length, 0);
  assert.equal(sim.sends.length, 1);
});

test("a recorder that cannot write stops the grant before anything is sent", async () => {
  const sim = new ChainSim();
  await assert.rejects(signer(sim.rpc).grant(VISITOR, NONE, null, { ...hooks(), onPending: () => { throw new Error("disk full"); } }, far()), /disk full/);
  assert.equal(sim.sends.length, 0);
});

test("a step the chain ran and failed is reported with the contract's text, stops the grant, and is not reported as done", async () => {
  const sim = new ChainSim();
  sim.plan = (n) => (n === 2 ? "fail" : "land");
  const h = hooks();
  const out = await grant(sim, h);
  assert.deepEqual(out.failed, { step: "storage_deposit", failure: "Smart contract panicked: simulated" });
  assert.deepEqual(h.steps.map(([s]) => s), ["transfer"]);
  assert.equal(sim.sends.length, 2);
});

test("a function-call key is refused before anything is signed", async () => {
  const sim = new ChainSim();
  const rpc = { ...sim.rpc, accessKey: () => Promise.resolve({ nonce: 1n, permission: { receiverId: TOKEN, methodNames: ["ft_transfer"] } }) } as unknown as NearRpc;
  const h = hooks();
  await assert.rejects(signer(rpc).grant(VISITOR, NONE, null, h, far()), KeyError);
  assert.deepEqual(h.pending, []);
});

test("the nonce is above both the chain's and the last one this signer used, so a lagging node cannot make it reuse one", async () => {
  const sim = new ChainSim();
  const s = signer(sim.rpc);
  await s.grant(VISITOR, new Set<FaucetStep>(["storage_deposit", "ft_transfer"]), null, hooks(), far());
  sim.nonce = 90n; // a node that is behind
  await s.grant(VISITOR, new Set<FaucetStep>(["transfer", "ft_transfer"]), null, hooks(), far());
  assert.deepEqual(sim.sends.map((b) => decoded(b).transaction.nonce), [101n, 102n]);
  sim.nonce = 500n; // a node that is ahead
  await s.grant(VISITOR, new Set<FaucetStep>(["transfer", "storage_deposit"]), null, hooks(), far());
  assert.equal(decoded(sim.sends[2]!).transaction.nonce, 501n);
});

test("an answer that is lost for a transaction that did execute is settled by looking it up: it is not sent again", async () => {
  const sim = new ChainSim();
  sim.plan = (n) => (n === 1 ? "land-lost" : "land");
  const out = await grant(sim);
  assert.equal(out.failed, null);
  assert.equal(sim.sends.length, 3);
  assert.equal(sim.count("transfer", VISITOR), 1);
});

test("an answer that is lost for a transaction the network never saw is settled by sending the same bytes again, once", async () => {
  const sim = new ChainSim();
  sim.plan = (n) => (n === 1 ? "drop-lost" : "land");
  const out = await grant(sim);
  assert.equal(out.failed, null);
  assert.equal(sim.sends[0], sim.sends[1], "the very same signed bytes");
  assert.equal(sim.count("transfer", VISITOR), 1);
});

test("a transaction that is accepted and still waiting is waited for, never replaced: the step stays unfinished, with its transaction kept to settle later", async () => {
  const sim = new ChainSim();
  sim.plan = (n) => (n === 1 ? "pool-lost" : "land");
  const h = hooks();
  const out = await grant(sim, h);
  assert.deepEqual(out.failed, { step: "transfer", failure: null });
  assert.equal(new Set(sim.sends).size, 1, "nothing else was signed: every send is the same bytes");
  assert.deepEqual(h.steps, []);
  const waiting = h.pending[0]!;
  // The visitor asks again before it landed: still nothing new.
  const again = hooks();
  assert.deepEqual((await grant(sim, again, waiting)).failed, { step: "transfer", failure: null });
  assert.equal(new Set(sim.sends).size, 1);
  assert.deepEqual(again.pending, []);
  // It lands; the next ask finds it done and carries on with the other two steps.
  sim.mine();
  const last = hooks();
  const done = await grant(sim, last, waiting);
  assert.equal(done.failed, null);
  assert.deepEqual(last.steps.map(([s]) => s), [...FAUCET_STEPS]);
  assert.equal(last.steps[0]![1], waiting.hash);
  assert.equal(sim.count("transfer", VISITOR), 1);
  assert.equal(sim.count("storage_deposit", VISITOR), 1);
  assert.equal(sim.count("ft_transfer", VISITOR), 1);
});

test("a stored transaction nobody has seen is sent again byte for byte on resume, and a lookup that fails does not stop it", async () => {
  const sim = new ChainSim();
  sim.plan = () => "drop-lost";
  const h = hooks();
  const first = await grant(sim, h);
  assert.deepEqual(first.failed, { step: "transfer", failure: null });
  const stored = h.pending[0]!;
  sim.plan = () => "land";
  sim.lookupsDown = 2;
  const resumed = await grant(sim, hooks(), stored);
  assert.equal(resumed.failed, null);
  assert.ok(sim.sends.filter((b) => b === stored.tx).length >= 2, "the stored bytes were sent again");
  assert.equal(sim.count("transfer", VISITOR), 1);
});

test("a stored transaction the chain ran and failed is replaced by a new one, with a new nonce and a new hash", async () => {
  const sim = new ChainSim();
  sim.plan = (n) => (n === 1 ? "fail" : "land");
  const h = hooks();
  const failed = await grant(sim, h);
  assert.equal(failed.failed?.failure, "Smart contract panicked: simulated");
  const old = h.pending[0]!;
  const again = hooks();
  const out = await grant(sim, again, old);
  assert.equal(out.failed, null);
  assert.notEqual(again.pending[0]!.hash, old.hash);
  assert.ok(decoded(again.pending[0]!.tx).transaction.nonce > decoded(old.tx).transaction.nonce);
});

test("a stored transaction the network refuses and no node knows is never replaced: its bytes are sent once more, nothing is signed, and the grant stays unconfirmed", async () => {
  const sim = new ChainSim();
  sim.plan = () => "drop-lost";
  const s = signer(sim.rpc, sim.archival);
  const h = hooks();
  await s.grant(VISITOR, NONE, null, h, far());
  const stored = h.pending[0]!;
  sim.rejected.add(stored.hash);
  sim.plan = () => "land";
  const sent = sim.sends.length;
  const again = hooks();
  const out = await s.grant(VISITOR, NONE, stored, again, far());
  assert.deepEqual(out.failed, { step: "transfer", failure: null });
  assert.deepEqual(again.pending, [], "no fresh signature");
  assert.equal(sim.sends.length, sent + 1, "the stored bytes, once");
  assert.equal(new Set(sim.sends).size, 1);
  assert.equal(sim.count("transfer", VISITOR), 0);
});

/** A real `NearRpc` over a node that answers each JSON-RPC call as `handler` says (a result, or an `error` object), counting the methods asked. */
function node(handler: (method: string, params: Record<string, unknown>) => Record<string, unknown>): { rpc: NearRpc; asked: string[] } {
  const asked: string[] = [];
  const fetch = (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body) as { method: string; params: Record<string, unknown> };
    asked.push(req.method === "query" ? String(req.params["request_type"]) : req.method);
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify({ jsonrpc: "2.0", id: "x", ...handler(req.method, req.params) })) });
  };
  return { rpc: new NearRpc("http://node.test", 1000, fetch as ConstructorParameters<typeof NearRpc>[2]), asked };
}
const UNKNOWN = { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, data: "unknown" } };
const INVALID = { error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION" }, data: "invalid" } };
/** A stored transaction of the `transfer` step, signed for real. */
async function stored(): Promise<PendingTx> {
  const signed = await signer().build("transfer", VISITOR, 100n, blockHash);
  return { step: "transfer", hash: hashOf(signed), tx: Buffer.from(signed.encode()).toString("base64") };
}
const ONLY_TRANSFER: ReadonlySet<FaucetStep> = new Set<FaucetStep>(["storage_deposit", "ft_transfer"]);

test("a stored transaction the chain answers with an InvalidTxError is not one that ran: nothing is signed, whatever else the nodes say", async () => {
  const pending = await stored();
  const { rpc, asked } = node((method) => (method === "tx" ? { result: { status: { Failure: { InvalidTxError: "NotEnoughBalance" } } } } : INVALID));
  const again = hooks();
  const out = await signer(rpc, rpc).grant(VISITOR, ONLY_TRANSFER, pending, again, far());
  assert.deepEqual(out.failed, { step: "transfer", failure: null });
  assert.deepEqual(again.pending, [], "no fresh signature");
  assert.ok(!asked.includes("view_access_key") && !asked.includes("block"), `nothing was prepared: ${asked.join(",")}`);
});

test("a stored transaction one of whose actions failed (ActionError) is the one case that is signed again", async () => {
  const pending = await stored();
  const { rpc } = node((method, params) => {
    if (method === "tx") return { result: { status: { Failure: { ActionError: { index: 0, kind: "boom" } } } } };
    if (method === "block") return { result: { header: { hash: blockHash, timestamp_nanosec: "1700000000000000000" } } };
    if (method === "send_tx") return { result: { transaction: { hash: hashOf(SignedTransaction.decode(Buffer.from(String(params["signed_tx_base64"]), "base64"))) }, status: { SuccessValue: "" } } };
    return { result: { nonce: 200, permission: "FullAccess" } };
  });
  const again = hooks();
  const out = await signer(rpc, rpc).grant(VISITOR, ONLY_TRANSFER, pending, again, far());
  assert.equal(out.failed, null);
  assert.equal(again.pending.length, 1);
  assert.notEqual(again.pending[0]!.hash, pending.hash);
});

test("a stored transaction nobody knows, whose resend is refused, is not replaced either (the same node errors, an unknown answer): one more look, then the transient failure", async () => {
  const pending = await stored();
  const { rpc, asked } = node((method) => (method === "tx" ? UNKNOWN : INVALID));
  const again = hooks();
  assert.deepEqual((await signer(rpc, rpc).grant(VISITOR, ONLY_TRANSFER, pending, again, far())).failed, { step: "transfer", failure: null });
  assert.deepEqual(again.pending, []);
  assert.deepEqual(asked, ["tx", "tx", "send_tx", "tx", "tx"], "ordinary and archival look, the same bytes once, ordinary and archival look");
});

test("halt() is asked before each new step: true stops the grant there and nothing more is signed", async () => {
  const sim = new ChainSim();
  let asked = 0;
  const h = hooks(() => ++asked > 1);
  const out = await grant(sim, h);
  assert.deepEqual(out, { txs: [h.steps[0]![1]], failed: null, halted: true });
  assert.deepEqual(h.steps.map(([s]) => s), ["transfer"]);
  assert.equal(sim.sends.length, 1);
});
