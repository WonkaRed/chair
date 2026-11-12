// "Your own test coins" (js/mine.js): the panel model in every state, the contract's refusals in plain words, and the whole flow against a stubbed desk and a stubbed
// RPC node: a key made here, coins from the faucet, and stake, unstake, claim and send signed by that key (each signature is checked against the key's public half).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";
import { base58Decode, base58Encode, parseSecretKey, RpcError } from "../site/js/near.js";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { createPress, POLL_MS } = await import(join(root, "site", "js", "press.js"));
const { clock, createMine, describeFailure, describeOutcome, fmtCoins, KEPT_NOT, mineModel, NO_ED25519, parseAmount, parseFaucetState, parseRefusal, sharePercent, STORE_KEY, waitWords } = await import(join(root, "site", "js", "mine.js"));

const COIN = 10n ** 24n;
const EXPLORER = "https://example.invalid";
const TOKEN = "token.chair-coin-3.testnet";
const ME = "a".repeat(64);
const TX = "5".repeat(44);
const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007 <script>alert(1)</script>";
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const FORBIDDEN = new Set(["script", "img", "iframe", "style", "object", "embed", "link"]);
const NOW = 1_000_000;

const funded = { accountId: ME, funded: true };
const acct = (over = {}) => ({ wallet: 50n * COIN, staked: 0n, pending: 0n, unlockAtMs: null, ...over });
const model = (over = {}) => mineModel({ supported: true, desk: "on", key: funded, account: acct(), now: NOW, ...over });

// ---- the model: state in, view model out ----

test("no key: the panel is one button when the faucet is on, and is not there at all when it is off or the desk cannot be reached; a held key keeps it there either way", () => {
  const on = mineModel({ supported: true, desk: "on", now: NOW });
  assert.equal(on.visible, true);
  assert.equal(on.mode, "get");
  assert.equal(on.get.label, "Get 50 test coins");
  assert.equal(on.get.enabled, true);
  assert.equal(on.get.note, null);
  for (const desk of ["off", null]) {
    assert.equal(mineModel({ supported: true, desk, now: NOW }).visible, false, `desk ${desk}`);
    const held = mineModel({ supported: true, desk, key: { accountId: ME, funded: false }, now: NOW });
    assert.equal(held.visible, true, `desk ${desk} with a key that was never funded`);
    assert.equal(held.get.label, "Try again");
    assert.equal(held.get.enabled, true, "the desk answers a key it has seen even when it is closed to new ones");
    assert.match(held.get.note, /no coins have reached it yet/);
  }
  assert.equal(mineModel({ supported: false, desk: "off", key: { accountId: ME, funded: false }, now: NOW }).visible, true);
});

test("the first lines carry no crypto words, and the honest lines say what the money is, how small the share is, and why visitors cannot vote the Chair out", () => {
  const m = mineModel({ supported: true, desk: "on", grant: { coins: "50", percent: sharePercent("50", 1_000_000n * COIN), cap: sharePercent("10000", 1_000_000n * COIN) }, now: NOW });
  assert.deepEqual(m.honest, [
    "These are test coins from a pool I control. They have no value, and nothing of yours is spent.",
    "Your 50 coins are 0.005% of the supply, far too few to move the Chair's rate.",
    "The faucet can give out at most 10,000 coins in total (200 visitors x 50), 1% of the coins that exist, on purpose: visitors can never vote the Chair out, which takes over 5%.",
  ]);
  const unknown = mineModel({ supported: true, desk: "on", now: NOW }).honest;
  assert.match(unknown[1], /a tiny share of the supply/, "no figure is claimed before the supply is known");
  assert.match(unknown[2], /at most 10,000 coins in total \(200 visitors x 50\), about 1% of the coins that exist/);
  assert.equal(sharePercent("10000", 2_000_000n * COIN), "0.5%", "the share follows the live supply");
});

test("creating: the button says what is happening and cannot be pressed twice", () => {
  const m = mineModel({ supported: true, desk: "on", creating: true, key: { accountId: ME, funded: false }, now: NOW });
  assert.equal(m.visible, true);
  assert.equal(m.get.label, "Making your account…");
  assert.equal(m.get.enabled, false);
  assert.match(m.get.note, /about half a minute/);
});

test("funded: the account, the three numbers read from the chain, and the four buttons", () => {
  const m = model();
  assert.equal(m.mode, "funded");
  assert.equal(m.account.short, "aaaaaaaa…aaaaaa");
  assert.deepEqual(m.numbers.map((n) => [n.label, n.value]), [["In your wallet", "50"], ["Staked", "0"], ["Earned, not yet claimed", "0"]]);
  assert.deepEqual(Object.fromEntries(Object.entries(m.actions).map(([k, a]) => [k, a.enabled])), { stake: true, unstake: false, claim: false, send: false });
  assert.equal(m.lock, null);
  assert.equal(m.earnedNote, null);
});

test("until the chain has been read the numbers say so, and nothing can be pressed; a failed read says unavailable", () => {
  const waiting = model({ account: null });
  assert.deepEqual(waiting.numbers.map((n) => n.value), ["…", "…", "…"]);
  assert.equal(Object.values(waiting.actions).some((a) => a.enabled), false);
  assert.deepEqual(model({ account: null, readFailed: true }).numbers.map((n) => n.value), ["unavailable", "unavailable", "unavailable"]);
});

test("locked: a countdown, and Unstake waits for it; unlocked: the stake is free to take out", () => {
  const locked = model({ account: acct({ wallet: 40n * COIN, staked: 10n * COIN, unlockAtMs: NOW + 161_000 }), receiverText: "bob.testnet" });
  assert.match(locked.lock, /^Your staked coins unlock in 2:41\. The contract keeps a stake in for two meetings of the Chair\.$/);
  assert.equal(locked.actions.unstake.enabled, false);
  assert.equal(locked.actions.stake.enabled, true, "a stake can always grow");
  assert.equal(locked.actions.send.enabled, true);
  const free = model({ account: acct({ wallet: 40n * COIN, staked: 10n * COIN, unlockAtMs: NOW - 1 }) });
  assert.equal(free.lock, "Your staked coins are free to take out.");
  assert.equal(free.actions.unstake.enabled, true);
  assert.equal(model({ account: acct({ wallet: 40n * COIN, staked: 10n * COIN, unlockAtMs: NOW + 90_000 }), now: NOW + 89_000 }).lock.match(/in (\d:\d\d)/)[1], "0:01");
  assert.equal(clock(161), "2:41");
  assert.equal(clock(-5), "0:00");
});

test("an amount larger than what is there is said, not sent; Unstake takes from the stake, Stake and Send from the wallet", () => {
  const a = acct({ wallet: 5n * COIN, staked: 3n * COIN, unlockAtMs: null });
  const m = model({ account: a, amountText: "2", receiverText: "bob.testnet" });
  assert.deepEqual(Object.fromEntries(Object.entries(m.actions).map(([k, x]) => [k, x.enabled])), { stake: true, unstake: true, claim: false, send: true });
  assert.deepEqual(Object.fromEntries(Object.entries(model({ account: a, amountText: "4", receiverText: "bob.testnet" }).actions).map(([k, x]) => [k, x.enabled])), { stake: true, unstake: false, claim: false, send: true }, "more than is staked, less than is in the wallet");
  const big = model({ account: a, amountText: "6", receiverText: "bob.testnet" });
  assert.deepEqual(Object.fromEntries(Object.entries(big.actions).map(([k, x]) => [k, x.enabled])), { stake: false, unstake: false, claim: false, send: false });
  assert.equal(big.amountHint, "You only have 5 in your wallet and 3 staked.");
  assert.equal(model({ amountText: "abc" }).amountHint, "Write the number of coins, like 10 or 2.5.");
  assert.equal(model({ amountText: "0" }).amountHint, "Use more than zero coins.");
  assert.equal(model({ amountText: "-1" }).actions.stake.enabled, false);
});

test("earned coins: shown with their own number, Claim opens, and a stake that has earned nothing yet explains why", () => {
  const earned = model({ account: acct({ staked: 10n * COIN, pending: 31n * 10n ** 20n, unlockAtMs: NOW - 1 }) });
  assert.equal(earned.numbers[2].value, "0.0031");
  assert.equal(earned.actions.claim.enabled, true);
  assert.equal(earned.earnedNote, "The number is small because the Chair prints only a fraction of a percent a day.");
  const none = model({ account: acct({ staked: 10n * COIN, unlockAtMs: NOW - 1 }) });
  assert.equal(none.actions.claim.enabled, false);
  assert.match(none.earnedNote, /Coins are earned when the Chair meets, and only while its rate is above zero/);
  assert.equal(fmtCoins(5n * 10n ** 12n), "under 0.000001");
  assert.equal(fmtCoins(0n), "0");
  assert.match(fmtCoins(1234n * COIN + COIN / 2n), /^1\s?234\.5$/);
});

test("a receiver must be a NEAR account name and not your own account", () => {
  assert.equal(model({ receiverText: "alice.chair-coin-3.testnet" }).actions.send.enabled, true);
  assert.equal(model({ receiverText: "" }).actions.send.enabled, false);
  const bad = model({ receiverText: "Not An Account!" });
  assert.equal(bad.actions.send.enabled, false);
  assert.match(bad.receiverHint, /not a NEAR account name/);
  const self = model({ receiverText: ME });
  assert.equal(self.actions.send.enabled, false);
  assert.equal(self.receiverHint, "That is your own account.");
});

test("while a call is out nothing else can be pressed, and its button says what it is doing", () => {
  const m = model({ busy: "stake", receiverText: "bob.testnet" });
  assert.equal(Object.values(m.actions).some((a) => a.enabled), false);
  assert.equal(m.actions.stake.label, "Staking…");
  assert.equal(m.actions.claim.label, "Claim");
});

test("the desk down: with a stored funded key the panel is all there and needs no desk; without a key it is not there", () => {
  for (const desk of ["off", null]) {
    const withKey = model({ desk });
    assert.equal(withKey.visible, true, `desk ${desk}`);
    assert.equal(withKey.mode, "funded");
    assert.equal(withKey.actions.stake.enabled, true);
    assert.equal(model({ desk, key: null, account: null }).visible, false);
  }
});

test("the faucet limited or dry: the button waits, says when it reopens, and opens again when the time has passed", () => {
  const limited = mineModel({ supported: true, desk: "on", closed: { kind: "limited", untilMs: NOW + 300_000, words: "this address has already had its test coins today" }, now: NOW });
  assert.equal(limited.get.enabled, false);
  assert.equal(limited.get.note, "The faucet is handing coins out slowly so that everyone gets a turn. Try again in 5 minutes.");
  assert.equal(limited.get.words, "this address has already had its test coins today");
  assert.equal(mineModel({ supported: true, desk: "on", closed: { kind: "limited", untilMs: NOW + 300_000, words: null }, now: NOW + 300_001 }).get.enabled, true, "the wait is over");
  const dry = mineModel({ supported: true, desk: "on", closed: { kind: "dry", untilMs: NOW + 60_000, words: null }, now: NOW });
  assert.equal(dry.get.enabled, false);
  assert.equal(dry.get.note, "The faucet is not ready right now. This page checks again by itself.", "a dry faucet's 60 s is a re-check, not an opening time");
  const closed = mineModel({ supported: true, desk: "on", closed: { kind: "closed", untilMs: NOW + 45_000, words: null }, now: NOW });
  assert.equal(closed.get.note, "The faucet has handed out all it may for now. It opens again in 45 seconds.");
  const budget = mineModel({ supported: true, desk: "on", closed: { kind: "budget", untilMs: null, words: null }, now: NOW });
  assert.equal(budget.get.enabled, false);
  assert.doesNotMatch(budget.get.note, /opens again/, "no time is invented when the desk gives none");
  assert.equal(budget.get.note, "Every coin the faucet may give has been given. That limit is on purpose, and it is explained below.");
  for (const kind of ["off", "killed"]) assert.equal(mineModel({ supported: true, desk: "on", closed: { kind, untilMs: null, words: null }, now: NOW }).get.note, "The faucet is closed for now.");
  assert.equal(mineModel({ supported: true, desk: "on", closed: { kind: "unreadable", untilMs: null, words: null }, now: NOW }).get.note, dry.get.note);
  const heldBudget = mineModel({ supported: true, desk: "on", key: { accountId: ME, funded: false }, closed: { kind: "budget", untilMs: null, words: null }, now: NOW });
  assert.equal(heldBudget.get.enabled, true, "a held key is never shut out by a spent budget");
  assert.equal(heldBudget.get.label, "Try again");
  assert.equal(mineModel({ supported: true, desk: "on", key: { accountId: ME, funded: false }, closed: { kind: "limited", untilMs: NOW + 5000, words: null }, now: NOW }).get.enabled, false, "a wait the desk set still holds");
  const down = mineModel({ supported: true, desk: "on", closed: { kind: "down", untilMs: null, words: null }, now: NOW });
  assert.equal(down.get.enabled, true, "a faucet that could not be reached may be tried again");
  assert.match(down.get.note, /could not be reached/);
  const odd = mineModel({ supported: true, desk: "on", closed: { kind: "other", untilMs: null, words: "a reason from the future" }, now: NOW });
  assert.equal(odd.get.note, "a reason from the future", "a reason the page does not know is shown in the desk's own words");
  assert.equal(odd.get.enabled, true);
});

test("no ed25519 in this browser: one plain line and no button, and only where the panel would have shown", () => {
  const m = mineModel({ supported: false, desk: "on", now: NOW });
  assert.equal(m.mode, "unsupported");
  assert.equal(m.visible, true);
  assert.equal(m.unsupported, NO_ED25519);
  assert.doesNotMatch(NO_ED25519, /ed25519|webcrypto/i, "no jargon in the line");
  assert.equal("get" in m, false);
  assert.equal(mineModel({ supported: false, desk: "off", now: NOW }).visible, false);
  assert.equal(mineModel({ supported: false, desk: "off", key: funded, now: NOW }).visible, true);
});

test("a browser that will not keep the key is told to copy it", () => {
  assert.equal(model({ kept: false }).keepNote, KEPT_NOT);
  assert.equal(model().keepNote, null);
  assert.equal(mineModel({ supported: true, desk: "on", kept: false, now: NOW }).keepNote, KEPT_NOT);
});

test("amounts, shares, waits and the desk's two documents are read strictly", () => {
  assert.equal(parseAmount("10"), 10n * COIN);
  assert.equal(parseAmount(" 2.5 "), 25n * COIN / 10n);
  assert.equal(parseAmount("0.000000000000000000000001"), 1n);
  for (const bad of ["", "abc", "1e3", "-1", "1.", ".5", "1,5", "1.0000000000000000000000001", "1".repeat(13), null]) assert.equal(parseAmount(bad), null, String(bad));
  assert.equal(sharePercent("50", 1_000_000n * COIN), "0.005%");
  assert.equal(sharePercent("50", 10_000n * COIN), "0.5%");
  assert.equal(sharePercent("50", 1_000_000_000_000_000n * COIN), "under 0.0001%");
  assert.equal(sharePercent("50", null), null);
  assert.equal(waitWords(1), "1 second");
  assert.equal(waitWords(90), "90 seconds");
  assert.equal(waitWords(300), "5 minutes");
  assert.equal(waitWords(7200), "2 hours");
  assert.deepEqual(parseFaucetState({ open: false, grant_chair: "50", grant_near: "0.03", remaining: 3, next_opening_s: 120, reason: "dry" }), { open: false, coins: "50", wait: 120, reason: "dry" });
  assert.deepEqual(parseFaucetState({ open: true, grant_chair: "50", next_opening_s: 0 }), { open: true, coins: "50", wait: null, reason: null });
  assert.equal(parseFaucetState({ open: false, reason: "unreadable" }).reason, "unreadable");
  assert.equal(parseFaucetState({ open: "yes" }), null);
  assert.equal(parseFaucetState({ open: true, grant_chair: "<b>50</b>" }).coins, null);
  assert.deepEqual(parseRefusal(429, { error: "slow down", retry_after_s: 90 }), { kind: "limited", wait: 90, words: "slow down" });
  assert.equal(parseRefusal(429, { error: "x" }).wait, 60);
  assert.equal(parseRefusal(503, { error: "x", reason: "budget" }).kind, "budget");
  assert.equal(parseRefusal(503, { error: "x", reason: "unreadable" }).kind, "unreadable");
  assert.equal(parseRefusal(503, { error: "x", reason: "something else" }).kind, "other");
  assert.equal(parseRefusal(400, { error: "x" }).kind, "bad");
  assert.equal(parseRefusal(500, null).kind, "down");
});

// ---- what a call did, in plain words ----

const failed = (text) => ({ status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${text}` } } } } } });

test("a call the contract refused gives a plain sentence and the contract's own words under it", () => {
  const cases = [
    ["unstake", "stake is locked until epoch 12", /^Your coins are still locked\./],
    ["claim", "nothing to claim", /^There is nothing to claim yet\./],
    ["unstake", "no stake", /^You have nothing staked/],
    ["unstake", "amount exceeds the staked balance", /^That is more than you have staked\./],
    ["send", "The account bob.testnet is not registered", /^That account is not set up to hold these coins/],
    ["stake", "The account doesn't have enough balance", /^That is more coins than you have in your wallet\./],
    ["send", "Sender and receiver should be different", /^You cannot send coins to yourself\./],
    ["send", "something nobody planned for", /^The contract refused this call, and nothing changed\./],
  ];
  for (const [action, words, plain] of cases) {
    const d = describeOutcome({ action, coins: "1", receiver: "bob.testnet" }, failed(words), TX);
    assert.equal(d.tone, "refused", words);
    assert.match(d.title, plain, words);
    assert.equal(d.contract, words, "the contract's words, without the runtime's prefix");
    assert.equal(d.tx, TX);
  }
});

test("a call that ran says what it did, with the amount the contract returned for a claim", () => {
  const ok = (v = "") => ({ status: { SuccessValue: v } });
  assert.equal(describeOutcome({ action: "stake", coins: "10" }, ok(), TX).title, "Staked 10 coins. They are locked for two meetings of the Chair, and they start earning at the next one.");
  assert.equal(describeOutcome({ action: "unstake", coins: "10" }, ok(), TX).title, "Took 10 coins out of the stake. They are back in your wallet.");
  assert.equal(describeOutcome({ action: "send", coins: "2", receiver: "alice.chair-coin-3.testnet" }, ok(), TX).title, "Sent 2 coins to alice.chair-coin-3.testnet.");
  assert.equal(describeOutcome({ action: "claim", coins: "" }, ok(btoa(`"${31n * 10n ** 20n}"`)), TX).title, "Moved 0.0031 earned coins into your wallet.");
  assert.equal(describeOutcome({ action: "claim", coins: "" }, ok(), TX).title, "Moved what you earned into your wallet.");
  assert.equal(describeOutcome({ action: "claim", coins: "" }, ok(), TX).tone, "ok");
  assert.equal(describeOutcome({ action: "stake", coins: "1" }, { status: "Unknown" }, TX).tone, "failed");
});

test("a call turned away before it ran, or never answered, says so and keeps the transaction link only when one was sent", () => {
  assert.match(describeFailure(new RpcError("x", "rpc", '{"InvalidTxError":{"NotEnoughBalance":{}}}'), null).title, /run out of the NEAR it pays network fees with/);
  assert.match(describeOutcome({ action: "stake", coins: "1" }, { status: { Failure: { ActionError: { kind: { LackBalanceForState: {} } } } } }, TX).title, /run out of the NEAR/);
  assert.match(describeFailure(new RpcError("x", "network"), null).title, /nothing was sent/);
  const sent = describeFailure(new RpcError("x", "network"), TX);
  assert.match(sent.title, /may still go through/);
  assert.equal(sent.tx, TX);
  assert.equal(describeFailure(new RpcError("x", "rpc", "{}"), TX).tx, null, "a call the network turned away has no transaction to open");
});

// ---- the whole panel, against a stubbed desk and a stubbed node ----

const text = (n) => [...walk(n)].map((x) => x.data ?? "").join("");
/** The nodes a visitor can see: everything not under a hidden one. */
function* seen(n) {
  if (n.hidden === true) return;
  yield n;
  for (const c of n.children ?? []) yield* seen(c);
}
const shown = (n) => [...seen(n)];
const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));
const links = (n) => find(n, (x) => x.tag === "a").map((a) => a.attrs.href);
const assertInert = (el) => {
  for (const n of walk(el)) {
    if (n.data !== undefined) assert.equal(HIDDEN.test(n.data), false, JSON.stringify(n.data.slice(0, 50)));
    else {
      assert.equal(FORBIDDEN.has(n.tag), false, n.tag);
      for (const [k, v] of Object.entries(n.attrs)) {
        assert.equal(/^on/i.test(k), false, k);
        if (k === "href") assert.match(v, /^https:\/\/example\.invalid\/(txns\/[1-9A-HJ-NP-Za-km-z]{32,44}|address\/[a-z0-9._-]+)$/);
      }
    }
  }
};
// Waits for real async work (WebCrypto runs on a thread pool, so a fixed number of ticks is not enough) until `cond` holds, or fails the test.
const settle = async (cond, ms = 5000) => {
  for (const end = Date.now() + ms; !cond(); await new Promise((r) => setTimeout(r, 1))) assert.ok(Date.now() < end, "timed out waiting for the panel");
};
const click = (el) => el.listeners.click[0]();
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: () => null } });

/** Reads a signed transaction the panel sent, and checks its signature against the key's public half. */
async function decode(signedBase64) {
  const all = Buffer.from(signedBase64, "base64");
  const tx = all.subarray(0, all.length - 65);
  assert.equal(all[all.length - 65], 0, "an ed25519 signature");
  const sig = all.subarray(all.length - 64);
  let at = 0;
  const u32 = () => ((at += 4), tx.readUInt32LE(at - 4));
  const str = () => { const n = u32(); return tx.subarray(at, (at += n)).toString(); };
  const signerId = str();
  at += 1;
  const publicKey = tx.subarray(at, (at += 32));
  const nonce = tx.readBigUInt64LE(at); at += 8;
  const receiverId = str();
  at += 32;
  assert.equal(u32(), 1, "one action");
  assert.equal(tx[at++], 2, "a function call");
  const method = str();
  const args = JSON.parse(str());
  const gas = tx.readBigUInt64LE(at); at += 8;
  const deposit = tx.readBigUInt64LE(at) + (tx.readBigUInt64LE(at + 8) << 64n);
  const key = await crypto.subtle.importKey("raw", publicKey, "Ed25519", false, ["verify"]);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", tx));
  assert.equal(await crypto.subtle.verify("Ed25519", key, sig, hash), true, "signed by the key whose public half is in the transaction");
  return { signerId, publicKeyHex: publicKey.toString("hex"), nonce, receiverId, method, args, gas, deposit, hash: base58Encode(hash) };
}

/** A stub NEAR node for one account: the token's views, the access key, a block, send_tx that applies the call, and a log of what it was sent. */
function stubChain(over = {}) {
  const chain = { wallet: 50n * COIN, staked: 0n, pending: 0n, unlock: 0, epoch: 10, endsMs: NOW + 60_000, epochMs: 90_000, nonce: 100, sent: [], reads: 0, fail: null, nonceErrors: 0, down: false, sendThrows: false, registered: new Set(["alice.chair-coin-3.testnet"]), exists: true, ...over };
  chain.post = async (body) => {
    if (chain.down) throw new Error("no node answered");
    const p = body.params;
    if (body.method === "query" && p.request_type === "call_function") {
      chain.reads++;
      const args = JSON.parse(atob(p.args_base64));
      const value = {
        ft_balance_of: () => String(chain.wallet),
        get_staking: () => ({ staked: String(chain.staked), pending_reward: String(chain.pending), backing: null, unlock_epoch: chain.unlock }),
        get_policy: () => ({ epoch: chain.epoch, rate_bps: 100, chair: "chair.testnet", streak: 1, last_set_epoch: 9, epoch_ends_ms: chain.endsMs }),
        get_params: () => ({ epoch_ms: chain.epochMs }),
      }[p.method_name]?.(args);
      assert.notEqual(value, undefined, `a view the stub knows: ${p.method_name}`);
      return { result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 5 } };
    }
    if (body.method === "query" && p.request_type === "view_access_key") return chain.exists ? { result: { nonce: chain.nonce } } : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" } } };
    if (body.method === "block") return { result: { header: { hash: base58Encode(new Uint8Array(32).fill(9)) } } };
    if (body.method === "tx") return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };
    assert.equal(body.method, "send_tx");
    if (chain.sendThrows) {
      await decode(p.signed_tx_base64);
      throw new Error("all 3 endpoints failed");
    }
    if (chain.nonceErrors > 0) {
      chain.nonceErrors--;
      return { error: { name: "HANDLER_ERROR", cause: { name: "INVALID_TRANSACTION", info: { InvalidTxError: { InvalidNonce: { tx_nonce: 1, ak_nonce: 2 } } } } } };
    }
    const tx = await decode(p.signed_tx_base64);
    chain.sent.push(tx);
    chain.nonce = Number(tx.nonce);
    if (chain.fail) return { result: chain.fail(tx) };
    const amount = BigInt(tx.args.amount ?? 0);
    if (tx.method === "stake") (chain.wallet -= amount, chain.staked += amount, chain.unlock = chain.epoch + 2);
    if (tx.method === "unstake") (chain.wallet += amount, chain.staked -= amount);
    if (tx.method === "claim") (chain.wallet += chain.pending, chain.pending = 0n);
    if (tx.method === "ft_transfer") {
      if (!chain.registered.has(tx.args.receiver_id)) return { result: failed(`The account ${tx.args.receiver_id} is not registered`) };
      chain.wallet -= amount;
    }
    return { result: { status: { SuccessValue: tx.method === "claim" ? btoa('"0"') : "" }, final_execution_status: "EXECUTED_OPTIMISTIC" } };
  };
  return chain;
}

/** A stub press desk: `routes` maps "METHOD /path" to a reply (or a function of the parsed request body). */
function stubDesk(routes) {
  const desk = { calls: [] };
  desk.request = async (path, init) => {
    const opts = init();
    const key = `${opts.method ?? "GET"} ${path}`;
    desk.calls.push({ key, opts, body: opts.body === undefined ? null : JSON.parse(opts.body) });
    const route = routes[key];
    if (route === undefined) throw new Error("no press desk");
    return typeof route === "function" ? route(desk.calls.at(-1).body) : route;
  };
  return desk;
}
const faucetOn = { "GET /health": reply(200, { ok: true, faucet: true }), "GET /faucet/state": reply(200, { open: true, grant_chair: "50", grant_near: "0.03", remaining: 100, next_opening_s: 0 }) };

function memoryStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { get: (k) => m.get(k) ?? null, set: (k, v) => m.set(k, v), map: m };
}

function setup({ desk = stubDesk(faucetOn), store = memoryStore(), chain = stubChain({ exists: store.map?.size > 0 }), supported = true, supply = 1_000_000n * COIN } = {}) {
  const doc = fakeDoc();
  const el = host(doc);
  const section = doc.createElement("section");
  section.hidden = true;
  const timers = { fns: [], set: (f) => (timers.fns.push(f), timers.fns.length), clear: () => undefined };
  const clockState = { now: NOW };
  const subtle = supported ? globalThis.crypto.subtle : { generateKey: async () => { throw new DOMException("no ed25519", "NotSupportedError"); } };
  const mine = createMine(doc, el, { section, request: desk.request, post: chain.post, token: TOKEN, explorer: EXPLORER, sample: "alice.chair-coin-3.testnet", supply: () => supply, store, subtle, timers, now: () => clockState.now });
  return { doc, el, section, mine, desk, chain, store, timers, clock: clockState };
}
const secretOf = (store) => JSON.parse(store.get(STORE_KEY));
const BUTTON = (ui, label) => find(ui.el, (x) => x.tag === "button" && text(x) === label)[0];

test("the whole flow: a key made in the browser, coins from the faucet, then stake, claim, unstake and send, every call signed by that key", async () => {
  const chain = stubChain({ wallet: 0n });
  const desk = stubDesk({
    ...faucetOn,
    "POST /faucet": (body) => {
      assert.match(body.public_key, /^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
      chain.wallet = 50n * COIN;
      return reply(200, { account_id: Buffer.from(base58Decode(body.public_key.slice(8))).toString("hex"), txs: [TX, "6".repeat(44), "7".repeat(44)], chair: "50", near: "0.03" });
    },
  });
  const ui = setup({ chain, desk });
  assert.equal(ui.section.hidden, true, "hidden until the desk says the faucet is on");
  await settle(() => ui.section.hidden === false);
  assert.equal(ui.section.hidden, false);
  assert.equal(BUTTON(ui, "Get 50 test coins").disabled, false);
  assert.equal(ui.store.map.size, 0, "no key is made until it is asked for");
  assert.match(text(ui.el), /Your 50 coins are 0\.005% of the supply/);

  await click(ui.mine.elements.get);
  await settle(() => ui.mine.state().key?.funded === true && ui.mine.state().account !== null);
  const kept = secretOf(ui.store);
  assert.equal(kept.funded, true);
  const { publicKey } = parseSecretKey(kept.secret);
  const me = Buffer.from(publicKey).toString("hex");
  assert.deepEqual(ui.desk.calls.map((c) => c.key), ["GET /health", "GET /faucet/state", "POST /faucet"]);
  assert.equal(ui.desk.calls[2].opts.headers["content-type"], "application/json");
  assert.equal(ui.desk.calls[2].opts.credentials, "omit");
  assert.match(text(ui.el), /Your test account, funded by my faucet/);
  assert.match(text(ui.el), /Your account is made and the faucet has sent its test coins/);
  assert.ok(links(ui.el).includes(`${EXPLORER}/address/${me}`), "the account links to the explorer");
  assert.equal(links(ui.el).filter((l) => l.startsWith(`${EXPLORER}/txns/`)).length, 3, "the faucet's three transactions");
  assertInert(ui.el);
  const nums = () => find(ui.el, (x) => x.tag === "strong").map(text);
  assert.deepEqual(nums(), ["50", "0", "0"]);

  // Stake 10: the first stake pays for its record, 0.003 NEAR, signed by the visitor's key.
  ui.mine.elements.amount.value = "10";
  await ui.mine.act("stake");
  const first = ui.chain.sent[0];
  assert.deepEqual([first.signerId, first.publicKeyHex, first.receiverId, first.method, first.args, first.deposit, first.gas], [me, me, TOKEN, "stake", { amount: String(10n * COIN) }, 3n * 10n ** 21n, 20n * 10n ** 12n]);
  assert.equal(first.nonce, 101n);
  assert.deepEqual(nums(), ["40", "10", "0"]);
  assert.match(text(ui.el), /Staked 10 coins/);
  assert.ok(links(ui.el).includes(`${EXPLORER}/txns/${first.hash}`), "the result links to the real transaction");
  assert.match(text(ui.el), /Your staked coins unlock in \d:\d\d/);
  assert.equal(BUTTON(ui, "Unstake").disabled, true, "locked");

  // A second stake needs only 1 yoctoNEAR; the nonce moves on.
  await ui.mine.act("stake");
  assert.equal(ui.chain.sent[1].deposit, 1n);
  assert.equal(ui.chain.sent[1].nonce, 102n);

  // Earned coins appear after a meeting; claim them.
  ui.chain.pending = 3n * 10n ** 21n;
  ui.chain.epoch += 2;
  ui.chain.endsMs = NOW + 30_000;
  ui.clock.now += 120_000;
  await ui.mine.readAccount();
  assert.equal(nums()[2], "0.003");
  assert.equal(BUTTON(ui, "Unstake").disabled, false, "unlocked after two meetings");
  await ui.mine.act("claim");
  assert.equal(ui.chain.sent[2].method, "claim");
  assert.deepEqual(ui.chain.sent[2].args, {});
  assert.equal(ui.chain.sent[2].deposit, 1n);
  assert.equal(nums()[2], "0");

  // Unstake 5, then send 2 to a holder.
  ui.mine.elements.amount.value = "5";
  await ui.mine.act("unstake");
  assert.equal(ui.chain.sent[3].method, "unstake");
  assert.deepEqual(ui.chain.sent[3].args, { amount: String(5n * COIN) });
  ui.mine.elements.receiver.value = "alice.chair-coin-3.testnet";
  ui.mine.elements.amount.value = "2";
  await ui.mine.act("send");
  const sent = ui.chain.sent[4];
  assert.deepEqual([sent.method, sent.args, sent.deposit], ["ft_transfer", { receiver_id: "alice.chair-coin-3.testnet", amount: String(2n * COIN) }, 1n]);
  assert.match(text(ui.el), /Sent 2 coins to alice\.chair-coin-3\.testnet\./);
  assert.deepEqual(nums(), ["33.003", "15", "0"]);
  assertInert(ui.el);
  assert.equal(new Set(ui.chain.sent.map((s) => s.nonce)).size, 5, "no nonce is used twice");
});

test("a send to an account the token does not know is refused by the contract: the plain sentence, then its own words, and a link to the transaction", async () => {
  const chain = stubChain({ wallet: 50n * COIN });
  const store = memoryStore({ [STORE_KEY]: JSON.stringify({ secret: `ed25519:${base58Encode(Uint8Array.from([...new Uint8Array(32).fill(3), ...(await publicHalf(3))]))}`, funded: true }) });
  const ui = setup({ chain, store, desk: stubDesk({}) });
  await settle(() => ui.mine.state().account !== null);
  ui.mine.elements.receiver.value = "stranger.testnet";
  ui.mine.elements.amount.value = "1";
  await ui.mine.act("send");
  const out = text(ui.el);
  assert.match(out, /That account is not set up to hold these coins, so the contract refused to send them there\./);
  assert.match(out, /The contract's words The account stranger\.testnet is not registered/);
  assert.ok(links(ui.el).some((l) => l === `${EXPLORER}/txns/${ui.chain.sent[0].hash}`));
  assert.equal(ui.chain.wallet, 50n * COIN, "a refused call moves nothing");
  assert.equal(find(ui.el, (x) => x.attrs.class?.includes("mn-card refused")).length, 1);
  assertInert(ui.el);
});

async function publicHalf(byte) {
  const pkcs8 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20, ...new Uint8Array(32).fill(byte)]);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, "Ed25519", true, ["sign"]);
  return Buffer.from((await crypto.subtle.exportKey("jwk", key)).x, "base64url");
}
async function storedKey(byte = 3, funded = true) {
  const pub = await publicHalf(byte);
  return { store: memoryStore({ [STORE_KEY]: JSON.stringify({ secret: `ed25519:${base58Encode(Uint8Array.from([...new Uint8Array(32).fill(byte), ...pub]))}`, funded }) }), me: Buffer.from(pub).toString("hex") };
}

test("a visitor who comes back with a funded key finds the panel with the desk off: no desk call at all, the chain is read directly", async () => {
  const { store, me } = await storedKey();
  const desk = stubDesk({}); // every route throws "no press desk"
  const ui = setup({ store, desk });
  await settle(() => ui.mine.state().account !== null);
  assert.equal(ui.section.hidden, false);
  assert.deepEqual(desk.calls, []);
  assert.match(text(ui.el), /Your test account, funded by my faucet/);
  assert.ok(links(ui.el).includes(`${EXPLORER}/address/${me}`));
  assert.equal(shown(ui.el).some((x) => x.tag === "button" && text(x) === "Get 50 test coins"), false, "the faucet button is not offered");
});

test("with no key and the desk unreachable, or the faucet off, the panel is not on the page", async () => {
  for (const routes of [{}, { "GET /health": reply(200, { ok: true, faucet: false }) }, { "GET /health": reply(502, null) }]) {
    const ui = setup({ desk: stubDesk(routes) });
    await settle(() => ui.mine.state().desk !== null);
    assert.equal(ui.section.hidden, true);
    assert.equal(ui.store.map.size, 0, "no key was made");
    assert.equal(ui.timers.fns.length, 1, "it looks again by itself");
    ui.mine.stop();
  }
});

test("no ed25519: the one line, no button, and no key made", async () => {
  const ui = setup({ supported: false });
  await settle(() => ui.mine.state().supported !== null && ui.mine.state().desk !== null);
  assert.equal(ui.section.hidden, false);
  assert.match(shown(ui.el).map((x) => x.data ?? "").join(""), /cannot make the key your test account needs/);
  assert.equal(shown(ui.el).some((x) => x.tag === "button" && text(x) === "Get 50 test coins"), false);
  await ui.mine.getCoins();
  assert.equal(ui.store.map.size, 0);
  assert.equal(ui.desk.calls.some((c) => c.key === "POST /faucet"), false);
});

test("the faucet's refusals: closed with a time, a limit with its own words, and a desk that is not there", async () => {
  const dry = setup({ desk: stubDesk({ ...faucetOn, "GET /faucet/state": reply(200, { open: false, grant_chair: "50", grant_near: "0.03", remaining: 4, next_opening_s: 60, reason: "dry" }) }) });
  await settle(() => dry.mine.state().closed !== null);
  assert.match(text(dry.el), /The faucet is not ready right now\. This page checks again by itself\./);
  assert.doesNotMatch(text(dry.el), /opens again/);
  assert.equal(dry.mine.elements.get.disabled, true);
  const closed = setup({ desk: stubDesk({ ...faucetOn, "GET /faucet/state": reply(200, { open: false, grant_chair: "50", grant_near: "0.03", remaining: 4, next_opening_s: 600 }) }) });
  await settle(() => closed.mine.state().closed !== null);
  assert.match(text(closed.el), /The faucet has handed out all it may for now\. It opens again in 10 minutes\./);
  assert.equal(closed.mine.elements.get.disabled, true);
  closed.clock.now += 601_000;
  closed.mine.refresh();
  assert.equal(closed.mine.elements.get.disabled, false, "when the time has passed the button is back");

  const limited = setup({ desk: stubDesk({ ...faucetOn, "POST /faucet": reply(429, { error: `this address has already had its test coins today ${EVIL}`, retry_after_s: 7200 }) }) });
  await settle(() => limited.mine.state().supported === true && limited.mine.state().desk === "on");
  await limited.mine.getCoins();
  assert.match(text(limited.el), /handing coins out slowly[^]*Try again in 2 hours\./);
  assert.match(text(limited.el), /The faucet's words: this address has already had its test coins today/);
  assert.equal(limited.mine.state().key.funded, false);
  assertInert(limited.el);

  const gone = setup({ desk: stubDesk({ ...faucetOn, "POST /faucet": () => { throw new Error("no press desk"); } }) });
  await settle(() => gone.mine.state().supported === true && gone.mine.state().desk === "on");
  await gone.mine.getCoins();
  assert.match(text(gone.el), /could not be reached/);
  assert.equal(gone.mine.elements.get.disabled, false, "and it may be tried again");
});

test("a faucet that stopped part way, or could not be reached, keeps the key and says Try again; pressing it sends the same key and finishes", async () => {
  const chain = stubChain({ wallet: 0n });
  let failures = 2;
  const keys = [];
  const desk = stubDesk({
    ...faucetOn,
    "POST /faucet": (b) => {
      keys.push(b.public_key);
      if (failures-- === 2) return reply(502, { error: `the token transfer failed ${EVIL}`, failed_step: "ft_transfer", account_id: Buffer.from(base58Decode(b.public_key.slice(8))).toString("hex"), txs: [TX] });
      if (failures === 0) throw new Error("no press desk");
      chain.wallet = 50n * COIN;
      return reply(200, { account_id: Buffer.from(base58Decode(b.public_key.slice(8))).toString("hex"), txs: [TX], chair: "50", near: "0.03" });
    },
  });
  const ui = setup({ desk, chain });
  await settle(() => ui.mine.state().desk === "on" && ui.mine.state().supported);
  await ui.mine.getCoins();
  assert.equal(ui.mine.state().key.funded, false);
  const kept = ui.store.get(STORE_KEY);
  assert.notEqual(kept, "", "the key is kept");
  assert.equal(ui.mine.elements.get.textContent, "Try again");
  assert.equal(ui.mine.elements.get.disabled, false);
  assert.match(text(ui.el), /The faucet stopped before it finished\. Your key is kept/);
  assert.match(text(ui.el), /The faucet's words: the token transfer failed/);
  assertInert(ui.el);
  await ui.mine.getCoins(); // the desk does not answer at all
  assert.equal(ui.mine.elements.get.textContent, "Try again");
  assert.match(text(ui.el), /could not be reached/);
  assert.equal(ui.store.get(STORE_KEY), kept);
  await ui.mine.getCoins();
  await settle(() => ui.mine.state().account !== null);
  assert.equal(new Set(keys).size, 1, "the same public key every time");
  assert.equal(keys.length, 3);
  assert.equal(ui.mine.state().key.funded, true);
  assert.equal(secretOf(ui.store).funded, true);
  assert.match(text(ui.el), /Your account is made and the faucet has sent its test coins/);
});

test("a 409 means the account exists but this faucet never funded it: the key is forgotten, in the browser too, and the next press makes another", async () => {
  const seenKeys = [];
  const ui = setup({ desk: stubDesk({ ...faucetOn, "POST /faucet": (b) => (seenKeys.push(b.public_key), reply(409, { error: "that account already exists" })) }) });
  await settle(() => ui.mine.state().desk === "on" && ui.mine.state().supported);
  await ui.mine.getCoins();
  assert.equal(ui.mine.state().key, null);
  assert.equal(ui.store.get(STORE_KEY), "", "gone from localStorage as well, so a reload does not bring it back");
  assert.match(text(ui.el), /already has an account it did not fund, so this page dropped the key/);
  assert.equal(ui.mine.elements.get.textContent, "Get 50 test coins");
  await ui.mine.getCoins();
  assert.equal(seenKeys.length, 2);
  assert.notEqual(seenKeys[0], seenKeys[1], "a new key");
});

test("a desk that names some other account than this key's is not believed", async () => {
  const ui = setup({ desk: stubDesk({ ...faucetOn, "POST /faucet": reply(200, { account_id: "b".repeat(64), txs: [TX], chair: "50", near: "0.03" }) }) });
  await settle(() => ui.mine.state().desk === "on" && ui.mine.state().supported);
  await ui.mine.getCoins();
  assert.equal(ui.mine.state().key.funded, false);
  assert.equal(ui.mine.elements.get.disabled, false);
});

test("an invalid nonce is read again and the call signed again, once; a node that never answers leaves the transaction link and a plain line", async () => {
  const { store } = await storedKey();
  const chain = stubChain({ nonceErrors: 1 });
  const ui = setup({ store, chain, desk: stubDesk({}) });
  await settle(() => ui.mine.state().account !== null);
  await ui.mine.act("stake");
  assert.equal(chain.sent.length, 1);
  assert.match(text(ui.el), /Staked 10 coins/);

  const quiet = stubChain();
  const q = setup({ store: (await storedKey()).store, chain: quiet, desk: stubDesk({}) });
  await settle(() => q.mine.state().account !== null);
  quiet.sendThrows = true;
  await q.mine.act("stake");
  assert.match(text(q.el), /The call was sent, but no node answered about it\. It may still go through/);
  assert.equal(links(q.el).filter((l) => l.includes("/txns/")).length, 1);
});

test("a failed read of the chain says so and keeps the buttons off; the panel reads again by itself at the next meeting", async () => {
  const { store } = await storedKey();
  const chain = stubChain({ down: true });
  const ui = setup({ store, chain, desk: stubDesk({}) });
  await settle(() => ui.mine.state().readFailed);
  assert.deepEqual(find(ui.el, (x) => x.tag === "strong").map(text), ["unavailable", "unavailable", "unavailable"]);
  assert.equal(ui.mine.elements.stake.disabled, true);
  chain.down = false;
  ui.clock.now += 20_000;
  ui.timers.fns.splice(0).forEach((f) => f());
  await settle(() => ui.mine.state().account !== null);
  assert.deepEqual(find(ui.el, (x) => x.tag === "strong").map(text), ["50", "0", "0"]);
  ui.mine.stop();
});

test("Take your key shows the account's secret in NEAR's own form, and a browser that will not keep it is told to copy it", async () => {
  const { store, me } = await storedKey();
  const ui = setup({ store, desk: stubDesk({}) });
  await settle(() => ui.mine.state().account !== null);
  assert.doesNotMatch(text(ui.el), /ed25519:/, "the secret is not on the page until it is asked for");
  click(ui.mine.elements.keyButton);
  const secret = JSON.parse(store.get(STORE_KEY)).secret;
  assert.ok(text(ui.el).includes(secret));
  assert.ok(text(ui.el).includes(me));
  assert.equal(find(ui.el, (x) => x.tag === "button" && text(x) === "Copy").length, 1);
  assert.equal(ui.mine.elements.keyButton.textContent, "Hide your key");
  click(ui.mine.elements.keyButton);
  assert.doesNotMatch(text(ui.el), /ed25519:/);

  const blocked = { get: () => null, set: () => { throw new Error("blocked"); } };
  const b = setup({ store: blocked });
  await settle(() => b.mine.state().desk === "on" && b.mine.state().supported);
  await b.mine.getCoins();
  assert.match(text(b.el), new RegExp(KEPT_NOT.slice(0, 40)));
});

test("a stored value that is not a key is ignored, never used", async () => {
  for (const junk of ["not json", "{}", JSON.stringify({ secret: "ed25519:abc", funded: true }), JSON.stringify({ secret: 5 }), "null"]) {
    const ui = setup({ store: memoryStore({ [STORE_KEY]: junk }) });
    await settle(() => ui.mine.state().desk !== null);
    assert.equal(ui.mine.state().key, null, junk);
    ui.mine.stop();
  }
});

test("the keys this browser makes are never the same, and the account name is the public key in hex", async () => {
  const ids = new Set();
  for (let i = 0; i < 3; i++) {
    const chain = stubChain({ wallet: 0n });
    const ui = setup({ chain, desk: stubDesk({ ...faucetOn, "POST /faucet": (b) => reply(200, { account_id: Buffer.from(base58Decode(b.public_key.slice(8))).toString("hex"), txs: [], chair: "50", near: "0.03" }) }) });
    await settle(() => ui.mine.state().desk === "on" && ui.mine.state().supported);
    await ui.mine.getCoins();
    ids.add(ui.mine.state().key.accountId);
    assert.match(ui.mine.state().key.accountId, /^[0-9a-f]{64}$/);
    ui.mine.stop();
  }
  assert.equal(ids.size, 3);
});

test("a stored key that was never marked funded: the panel stays up with the faucet reported off or spent, and the chain is asked before the desk", async () => {
  // Nothing on the chain yet: Try again, and pressing it sends the same key and finishes, though the desk says its faucet is off for new keys.
  const { store, me } = await storedKey(3, false);
  const chain = stubChain({ wallet: 0n, exists: false });
  const routes = { "GET /health": reply(200, { ok: true, faucet: false }), "POST /faucet": () => (chain.exists = true, chain.wallet = 50n * COIN, reply(200, { account_id: me, txs: [TX], chair: "50", near: "0.03" })) };
  const desk = stubDesk(routes);
  const ui = setup({ store, chain, desk });
  await settle(() => ui.mine.state().desk === "off" && ui.mine.state().supported);
  assert.equal(ui.section.hidden, false, "this browser holds a key, so the panel is there");
  assert.equal(ui.mine.elements.get.textContent, "Try again");
  assert.equal(ui.mine.elements.get.disabled, false);
  assert.match(text(ui.el), /no coins have reached it yet/);
  assert.equal(ui.mine.state().key.funded, false);
  await ui.mine.getCoins();
  await settle(() => ui.mine.state().account !== null);
  assert.equal(secretOf(ui.store).funded, true);
  assert.equal(desk.calls.filter((c) => c.key === "POST /faucet").length, 1);
  assert.match(desk.calls.find((c) => c.key === "POST /faucet").body.public_key, /^ed25519:/);
  ui.mine.stop();

  // Coins already on the chain: the funded panel with no desk call at all but the health look, and no POST.
  const held = await storedKey(3, false);
  const found = setup({ store: held.store, chain: stubChain({ wallet: 7n * COIN, exists: true }), desk: stubDesk({}) });
  await settle(() => found.mine.state().account !== null);
  assert.equal(found.mine.state().key.funded, true);
  assert.equal(JSON.parse(held.store.get(STORE_KEY)).funded, true, "remembered");
  assert.match(text(found.el), /Your test account, funded by my faucet/);
  assert.match(text(found.el), /already had a test account with coins in it/);
  assert.deepEqual(find(found.el, (x) => x.tag === "strong").map(text), ["7", "0", "0"]);
  assert.equal(found.desk.calls.some((c) => c.key === "POST /faucet"), false);
  found.mine.stop();

  // An account with the key but no coins (a grant that stopped half way), or a chain that cannot be read: Try again, never a funded panel with nothing to do.
  for (const over of [{ wallet: 0n, exists: true }, { down: true }]) {
    const k = await storedKey(3, false);
    const half = setup({ store: k.store, chain: stubChain(over), desk: stubDesk({}) });
    await settle(() => half.mine.state().desk === "off");
    await settle(() => half.chain.reads > 0 || over.down === true);
    assert.equal(half.section.hidden, false);
    assert.equal(half.mine.state().key.funded, false);
    assert.equal(half.mine.elements.get.textContent, "Try again");
    assert.equal(half.mine.elements.get.disabled, false);
    half.mine.stop();
  }
});

test("a held key is not shut out by the faucet's state, a lost 200 is found on the chain, and the desk's refusal of a held key says so in plain words", async () => {
  const budgetState = reply(200, { open: false, grant_chair: "50", grant_near: "0.03", remaining: 0, next_opening_s: 0, reason: "budget" });
  const { store } = await storedKey(3, false);
  const ui = setup({ store, chain: stubChain({ wallet: 0n, exists: false }), desk: stubDesk({ "GET /health": reply(200, { ok: true, faucet: true }), "GET /faucet/state": budgetState }) });
  await settle(() => ui.mine.state().desk === "on");
  await settle(() => ui.desk.calls.length === 2);
  assert.equal(ui.mine.state().closed, null);
  assert.equal(ui.mine.elements.get.disabled, false);
  assert.equal(ui.mine.elements.get.textContent, "Try again");
  ui.mine.stop();

  // The press reaches the desk, the grant lands, and the reply never arrives: the chain shows the coins, so the panel opens.
  const chain = stubChain({ wallet: 0n, exists: false });
  const lost = setup({ chain, desk: stubDesk({ ...faucetOn, "POST /faucet": () => (chain.exists = true, chain.wallet = 50n * COIN, (() => { throw new TypeError("Failed to fetch"); })()) }) });
  await settle(() => lost.mine.state().desk === "on" && lost.mine.state().supported);
  await lost.mine.getCoins();
  await settle(() => lost.mine.state().account !== null);
  assert.equal(lost.mine.state().key.funded, true);
  assert.deepEqual(find(lost.el, (x) => x.tag === "strong").map(text), ["50", "0", "0"]);
  lost.mine.stop();

  // A closed faucet's 503 to a held key says so, and Try again stays.
  for (const [reason, line] of [["off", /closed for now/], ["killed", /closed for now/], ["dry", /not ready right now/], ["unreadable", /not ready right now/], ["budget", /Every coin the faucet may give has been given/]]) {
    const k = await storedKey(3, false);
    const refused = setup({ store: k.store, chain: stubChain({ wallet: 0n, exists: false }), desk: stubDesk({ ...faucetOn, "POST /faucet": reply(503, { error: `the desk says ${reason}`, reason }) }) });
    await settle(() => refused.mine.state().desk === "on" && refused.mine.state().supported);
    await refused.mine.getCoins();
    assert.match(text(refused.el), line, reason);
    assert.equal(refused.mine.elements.get.textContent, "Try again", reason);
    assert.equal(refused.mine.elements.get.disabled, false, reason);
    refused.mine.stop();
  }
});

/** The real press client (js/press.js, `createPress`) over a fake `fetch`: the panel's desk, with the desk's address resting and discovery as the page does them. */
function realDesk(onFaucet) {
  const DESK = "https://quiet-harbor-minutes.trycloudflare.com";
  const DISCOVERY = "https://gist.example.invalid/raw/chair-press.json";
  const seen = [];
  const t = { now: NOW };
  const fetchImpl = async (u, init) => {
    seen.push(`${init?.method ?? "GET"} ${u}`);
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.startsWith(DISCOVERY)) return json(200, { url: DESK, updated_at_ms: 1 });
    if (u === `${DESK}/health`) return json(200, { ok: true, faucet: true });
    if (u === `${DESK}/faucet/state`) return json(200, { open: true, grant_chair: "50", grant_near: "0.03", remaining: 100, next_opening_s: 0 });
    if (u === `${DESK}/faucet`) return onFaucet(JSON.parse(init.body), json);
    return json(404, { error: "not found" });
  };
  const doc = fakeDoc();
  const press = createPress(doc, host(doc), { discoveryUrl: DISCOVERY, explorer: EXPLORER, storage: { getItem: () => null, setItem: () => undefined }, timers: { set: () => 0, clear: () => undefined }, fetchImpl, now: () => t.now });
  return { request: press.request, seen, press, t, posts: () => seen.filter((x) => x === `POST ${DESK}/faucet`).length };
}

test("through the real press client: the faucet's own 502 (JSON) leaves the desk alone and Try again sends the same key and finishes; a Cloudflare HTML 502 rests the desk", async () => {
  const chain = stubChain({ wallet: 0n, exists: false });
  const keys = [];
  let first = true;
  const desk = realDesk((b, json) => {
    keys.push(b.public_key);
    const account_id = Buffer.from(base58Decode(b.public_key.slice(8))).toString("hex");
    if (first) return (first = false, json(502, { error: "the token transfer failed", failed_step: "ft_transfer", account_id, txs: [TX] }));
    chain.exists = true;
    chain.wallet = 50n * COIN;
    return json(200, { account_id, txs: [TX], chair: "50", near: "0.03" });
  });
  const ui = setup({ chain, desk });
  await settle(() => ui.mine.state().desk === "on" && ui.mine.state().supported);
  await ui.mine.getCoins();
  assert.match(text(ui.el), /The faucet stopped before it finished\. Your key is kept/);
  assert.equal(ui.mine.elements.get.textContent, "Try again");
  assert.equal(ui.mine.elements.get.disabled, false);
  assert.equal(ui.mine.state().key.funded, false);
  await ui.mine.getCoins(); // no rest: the desk answered, so this goes straight out
  await settle(() => ui.mine.state().account !== null);
  assert.equal(desk.posts(), 2);
  assert.equal(new Set(keys).size, 1, "the same key both times");
  assert.equal(ui.mine.state().key.funded, true);
  assert.match(text(ui.el), /Your account is made and the faucet has sent its test coins/);
  ui.mine.stop();

  // A tunnel's own HTML 502 is not the desk talking: the address rests, and the next press does not reach it.
  const page = realDesk(() => new Response("<!doctype html><title>Bad gateway</title>", { status: 502, headers: { "content-type": "text/html" } }));
  const html = setup({ chain: stubChain({ wallet: 0n, exists: false }), desk: page });
  await settle(() => html.mine.state().desk === "on" && html.mine.state().supported);
  await html.mine.getCoins();
  assert.equal(page.posts(), 1);
  assert.equal(html.mine.elements.get.textContent, "Try again", "the key is kept either way");
  await html.mine.getCoins();
  assert.equal(page.posts(), 1, "the dead-looking address was left alone");
  assert.match(text(html.el), /could not be reached/);
  page.t.now += POLL_MS;
  await html.mine.getCoins();
  assert.equal(page.posts(), 2, "after its rest it is asked again");
  html.mine.stop();
});

test("the page carries the panel's section hidden, its stylesheet, and the disclosure that test accounts may appear", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(join(root, "site", "index.html"), "utf8");
  assert.match(html, /<section id="mine"[^>]*\bhidden\b/);
  assert.match(html, /<link rel="stylesheet" href="mine\.css">/);
  assert.match(html, /<div id="mine-body"/);
  assert.match(html, /plus test accounts funded by the faucet for page visitors/);
  assert.match(html, /Test accounts funded by the faucet for page visitors may appear here too\./);
});
