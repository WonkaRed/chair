// "Make the Chair overreach": the visitor's input is checked before anything is sent, the desk's states each read plainly, the contract's text
// and every desk string stay inert, the curl is built only from checked strings, and a closed desk shows the chain's recorded refusals.
// The desk is the fetch boundary (`request`), which the page does not own; timers are driven by the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { createOverreach, curlCommand, parseAttempt, boundText, DOWN } = await import(join(root, "site", "js", "overreach.js"));
const { pressFromChain } = await import(join(root, "site", "js", "press.js"));

const EXPLORER = "https://example.invalid";
const RPC = "https://rpc.example.invalid";
const TX = "5".repeat(44);
const SIGNER = "challenger.chair-coin-3.testnet";
const ID = "123e4567-e89b-42d3-a456-426614174000";
const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007 <script>alert(1)</script>";
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const FORBIDDEN = new Set(["script", "img", "iframe", "style", "object", "embed", "link"]);

const manual = () => {
  const queue = [];
  return { queue, set: (f, ms) => (queue.push({ f, ms }), queue.length), clear: () => queue.splice(0), tick: async () => { const t = queue.shift(); await t.f(); } };
};
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k] ?? null }, json: async () => body });
const text = (n) => [...walk(n)].map((x) => x.data ?? "").join("");
const find = (n, pred) => [...walk(n)].filter((x) => x.tag !== undefined && pred(x));
const assertInert = (root) => {
  for (const n of walk(root)) {
    if (n.data !== undefined) assert.equal(HIDDEN.test(n.data), false, JSON.stringify(n.data.slice(0, 50)));
    else {
      assert.equal(FORBIDDEN.has(n.tag), false, n.tag);
      for (const [k, v] of Object.entries(n.attrs)) {
        assert.equal(/^on/i.test(k), false, k);
        if (k === "href") assert.match(v, /^https:\/\/example\.invalid\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      }
    }
  }
};

/** A panel whose desk answers `route(path, init)`; `open` is the /health answer. */
async function panel(route, { open = true, refusals = () => null } = {}) {
  const sent = [];
  const timers = manual();
  const request = async (path, init) => {
    const i = init();
    sent.push({ path, init: i });
    if (path === "/health") return open ? res(200, { ok: true, overreach: true }) : Promise.reject(new Error("no press desk"));
    return route(path, i);
  };
  const el = host();
  const wrote = [];
  const api = createOverreach(fakeDoc(), el, { request, explorer: EXPLORER, rpcUrl: RPC, refusals, timers, now: () => 1_000_000, clipboard: { writeText: async (t) => wrote.push(t) } });
  await new Promise((r) => setImmediate(r));
  return { el, api, sent, timers, wrote };
}
const refused = (extra = {}) => ({ status: "refused", rate_bps: 500, tx_hash: TX, signer: SIGNER, failure: "Smart contract panicked: rate_bps out of bounds: must be within -200..=200", hit: "absolute", bound: { kind: "absolute", lo: -200, hi: 200 }, ...extra });

test("input is validated before anything is sent: only a whole number of bps, within the cap", async () => {
  const p = await panel(() => res(202, { status: "waiting", id: ID }));
  for (const bad of ["", "abc", "1.5", "5e2", "1000001", "--5", "0x10", "1 000"]) {
    await p.api.submit(bad);
    assert.equal(p.sent.some((s) => s.path === "/overreach"), false, bad);
    assert.notEqual(p.api.state().message, null, bad);
  }
  assert.equal(p.api.state().busy, false);
});

test("a good rate is POSTed as JSON with nothing else, then polled by id until the contract answers, with the card showing its words, the bound, the tx and the curl", async () => {
  let polls = 0;
  const p = await panel((path, init) => {
    if (init.method === "POST") return res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000, fires_at_ms: 1_012_000 });
    return res(200, ++polls < 2 ? { status: "waiting", id: ID, now_ms: 1_000_000, fires_at_ms: 1_012_000 } : refused());
  });
  await p.api.submit("+500");
  const post = p.sent.find((s) => s.path === "/overreach");
  assert.deepEqual(JSON.parse(post.init.body), { rate_bps: 500 });
  assert.equal(post.init.credentials, "omit");
  assert.match(text(p.el), /The Chair can only speak once per meeting\. Next meeting in 12 s: your order goes in the moment it opens\./);
  assert.doesNotMatch(text(p.el), /step/i);
  await p.timers.tick();
  assert.equal(p.api.state().attempt.status, "waiting");
  await p.timers.tick();
  const out = text(p.el);
  assert.match(out, /Smart contract panicked: rate_bps out of bounds: must be within -200\.\.=200/);
  assert.match(out, /never allows a rate outside −200 bps to \+200 bps/);
  assert.doesNotMatch(out, /step/i, "no step wording anywhere: only rates beyond the absolute limit are sent");
  assert.match(out, /scripted reply/);
  assert.match(out, /real chair account sends it; the contract decides/);
  const link = find(p.el, (n) => n.tag === "a")[0];
  assert.equal(link.attrs.href, `${EXPLORER}/txns/${TX}`);
  const code = find(p.el, (n) => n.tag === "code")[0];
  assert.match(text(code), new RegExp(`^curl -s ${RPC} .*"tx_hash":"${TX}","sender_account_id":"${SIGNER}".* \\| head -1$`));
  await find(p.el, (n) => n.tag === "button" && text(n) === "Copy")[0].listeners.click[0]();
  assert.equal(p.wrote[0], text(code));
  assert.equal(p.timers.queue.length, 1, "only the copy-label reset is left waiting; polling stopped");
  assert.equal(p.api.state().busy, false);
});

test("while the attempt waits for the next meeting the page says why, and shows the latest refusal on chain first, above the countdown, labelled as an earlier one with its transaction", async () => {
  const rows = [{ tx: "7".repeat(44), rateBps: 500, reason: "rate_bps out of bounds: must be within -200..=200", signer: SIGNER, tsMs: 1_700_000_000_000, byVisitor: true }, ROWS[1]];
  const p = await panel(() => res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000, fires_at_ms: 1_038_000 }), { refusals: chain(rows) });
  await p.api.submit("500");
  const out = text(p.el);
  assert.match(out, /While you wait, here is the most recent refusal on chain:/);
  assert.match(out, /Asked for 5% a day \(\+500 bps\)/);
  assert.equal(out.match(/not yours/g).length, 1, "said once, in the card's note, not again in the lead");
  assert.match(out, /The Chair can only speak once per meeting\. Next meeting in 38 s/);
  assert.match(out, /refused as late and say nothing about your rate/);
  assert.ok(out.indexOf("most recent refusal on chain") < out.indexOf("Next meeting in 38 s"), "the refusal comes above the countdown");
  assert.deepEqual(find(p.el, (n) => n.tag === "a").map((n) => n.attrs.href), [`${EXPLORER}/txns/${"7".repeat(44)}`], "the earlier refusal's own transaction, and nothing else");
  assertInert(p.el);
});

test("while it waits with the chain's list unreadable the page shows the fixed recorded refusal, said as such; with a readable empty list, only the countdown", async () => {
  const waiting = () => res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000, fires_at_ms: 1_038_000 });
  const blind = await panel(waiting);
  await blind.api.submit("500");
  assert.match(text(blind.el), /a recorded refusal, since the chain's list could not be read just now/);
  assert.match(text(blind.el), /Next meeting in 38 s/);
  const none = await panel(waiting, { refusals: () => ({ status: "complete", refusals: [], policy: { rateBps: 0 } }) });
  await none.api.submit("500");
  assert.doesNotMatch(text(none.el), /While you wait/);
  assert.match(text(none.el), /Next meeting in 38 s/);
});

test("the refusal shown while waiting is never the visitor's own previous one: that row is skipped and the next one is shown", async () => {
  let posts = 0;
  const p = await panel((path, init) => (init.method === "POST" ? (posts++ === 0 ? res(200, refused()) : res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000, fires_at_ms: 1_038_000 })) : res(200, refused())), { refusals: chain() });
  await p.api.submit("500"); // refused, its tx is TX: the first row of the chain's list
  assert.equal(p.api.state().attempt.status, "refused");
  await p.api.submit("500");
  const out = text(p.el);
  assert.match(out, /Next meeting in 38 s/);
  const links = find(p.el, (n) => n.tag === "a").map((n) => n.attrs.href);
  assert.ok(!links.includes(`${EXPLORER}/txns/${TX}`), "the visitor's own refusal is not shown as an earlier one");
  assert.ok(links.includes(`${EXPLORER}/txns/${"6".repeat(44)}`), "the next row stands in");
  const only = await panel((path, init) => (init.method === "POST" ? (only.posts++ === 0 ? res(200, refused()) : res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000, fires_at_ms: 1_038_000 })) : res(200, refused())), { refusals: () => ({ status: "complete", refusals: [ROWS[0]], policy: { rateBps: 5 } }) });
  only.posts = 0;
  await only.api.submit("500");
  await only.api.submit("500");
  assert.doesNotMatch(text(only.el), /While you wait/, "nothing but the visitor's own: only the countdown");
});

test("a waiting attempt with no firing time never prints \"null\"", async () => {
  const p = await panel(() => res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000 }), { refusals: chain() });
  await p.api.submit("500");
  const out = text(p.el);
  assert.doesNotMatch(out, /null|NaN|undefined/);
  assert.match(out, /Your order goes in the moment the next meeting opens\./);
});

test("once the call has gone out the earlier refusal makes way for the answer", async () => {
  const p = await panel((path, init) => (init.method === "POST" ? res(202, { status: "waiting", id: ID, rate_bps: 500, now_ms: 1_000_000, fires_at_ms: 1_000_000 }) : res(200, refused())), { refusals: chain() });
  await p.api.submit("500");
  assert.match(text(p.el), /The call has gone to the contract/);
  assert.doesNotMatch(text(p.el), /While you wait/);
});

test("the presets fill the input and send nothing", async () => {
  const p = await panel(() => res(500, null));
  const chips = find(p.el, (n) => n.tag === "button" && n.attrs["data-rate"] !== undefined);
  assert.deepEqual(chips.map((c) => text(c)), ["5% a day+500 bps", "−99.99%−9999 bps"], "the plain percent is the big label, the basis points the small tag");
  assert.equal(chips[1].attrs["aria-pressed"], "false");
  chips[1].listeners.click[0]();
  assert.equal(p.api.input.value, "-9999");
  assert.equal(p.sent.filter((s) => s.path === "/overreach").length, 0);
});

test("429 composing, 400, and a within-mandate answer each read plainly and free the form at the right time", async () => {
  const p = await panel(() => res(429, { code: "composing", retry_after_s: 40 }));
  await p.api.submit("500");
  assert.match(p.api.state().message, /composing itself.*40 s/);
  assert.equal(p.api.state().busy, true, "held until the wait is over");
  await p.timers.tick();
  assert.equal(p.api.state().busy, false);

  const q = await panel(() => res(400, { error: EVIL }));
  await q.api.submit("500");
  assert.match(q.api.state().message, /^Not accepted:/);
  assertInert(q.el);

  const w = await panel(() => res(200, { status: "within_mandate", line: "That is within the mandate. Ask for more." }));
  await w.api.submit("20");
  assert.match(text(w.el), /within the mandate. Ask for more/);
  assert.equal(w.api.state().busy, false);
});

test("a tx that the contract accepted is said plainly, never presented as a refusal", async () => {
  const p = await panel(() => res(200, { status: "accepted", rate_bps: 500, tx_hash: TX }));
  await p.api.submit("500");
  assert.match(text(p.el), /The contract accepted it/);
  assert.doesNotMatch(text(p.el), /The contract's own answer/);
});

test("hostile strings from the desk are inert, and a bad tx hash or signer yields no link and no command", async () => {
  const p = await panel(() => res(200, refused({ failure: EVIL, tx_hash: EVIL, signer: EVIL, line: EVIL })));
  await p.api.submit("500");
  assertInert(p.el);
  assert.equal(find(p.el, (n) => n.tag === "code").length, 0);
  assert.equal(find(p.el, (n) => n.tag === "a").length, 0);
  assert.equal(curlCommand("http://rpc.example.invalid", TX, SIGNER), null, "https only");
  assert.equal(curlCommand("https://user:pw@rpc.example.invalid", TX, SIGNER), null);
  assert.equal(curlCommand(RPC, TX, "x; rm -rf ~"), null);
  assert.equal(parseAttempt({ status: "bogus" }), null);
  assert.equal(parseAttempt(null), null);
  assert.equal(boundText({ bound: null, hit: "other" }), null);
});

test("desk closed: it says so plainly, offers no form, and lists the chain's last refusals with visitor-forced ones marked", async () => {
  const rows = [
    { tx: TX, rateBps: 500, reason: "rate step too large", signer: SIGNER, tsMs: 1_700_000_000_000, byVisitor: true },
    { tx: "6".repeat(44), rateBps: 300, reason: EVIL, signer: SIGNER, tsMs: 1_700_000_000_000, byVisitor: false },
  ];
  const p = await panel(() => res(500, null), { open: false, refusals: () => ({ refusals: rows, policy: { rateBps: 0 } }) });
  const out = text(p.el);
  assert.ok(out.includes(DOWN));
  assert.match(out, /forced by a visitor/);
  assert.match(out, /the chair account's own call/);
  assert.equal(find(p.el, (n) => n.tag === "button" && n.attrs.type === "submit")[0].disabled, true);
  assertInert(p.el);
  const none = await panel(() => res(500, null), { open: false });
  assert.match(text(none.el), /could not be read just now/);
  assert.match(text(none.el), /An earlier recorded attempt, not yours and not live/);
  assert.equal(find(none.el, (n) => n.tag === "a" && n.attrs.href === `${EXPLORER}/txns/Efagw855yoDeJXjNyui9Bt9d4JXfhisMoTm9JCPkHWjf`).length, 1);
  assertInert(none.el);
  const clean = await panel(() => res(500, null), { open: false, refusals: () => ({ status: "complete", refusals: [], policy: { rateBps: 0 } }) });
  assert.match(text(clean.el), /has refused no set_policy call yet/, "a readable, empty list is not replaced by a recorded one");
  assert.doesNotMatch(text(clean.el), /recorded attempt/);
});

test("press fallback: only chain-verified press answers are shown from chain data", () => {
  const line = "A member of the press asked a question (0123456789ab). The Chair replied: The Chair is seated.";
  const dec = (tx) => ({ tx, epoch: 7, tsMs: 1 });
  const decisions = [dec("a".repeat(44)), dec("b".repeat(44)), dec("c".repeat(44))];
  const resolved = new Map([["a".repeat(44), { verdict: "verified", text: line }], ["b".repeat(44), { verdict: "mismatch", text: line }], ["c".repeat(44), { verdict: "verified", text: "plain minutes" }]]);
  const out = pressFromChain(decisions, resolved);
  assert.equal(out.length, 1);
  assert.equal(out[0].answer, "The Chair is seated.");
  assert.equal(out[0].tx, "a".repeat(44));
});

test("a decision whose transaction carries the overreach text is marked as forced by a visitor, never as the AI chair's own", async () => {
  const { decisionsOfTxs, OVERREACH_MARK } = await import(join(root, "site", "js", "decisions.js"));
  const { renderHero } = await import(join(root, "site", "js", "minutes.js"));
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
  const ev = (rate) => `EVENT_JSON:${JSON.stringify({ standard: "chair", version: "1.0.0", event: "policy_set", data: { chair: SIGNER, epoch: 9, rate_bps: rate, previous_rate_bps: 0, reasoning_hash: "a".repeat(64) } })}`;
  const tx = (reasoning) => ({ transaction: { hash: TX, signer_id: SIGNER, receiver_id: "token.test", actions: [{ FunctionCall: { method_name: "set_policy", args: b64({ rate_bps: 500, reasoning }) } }] }, receipts: [{ receipt: {}, execution_outcome: { block_timestamp: "1700000000000000000", block_height: 100, outcome: { executor_id: "token.test", status: { SuccessValue: "" }, logs: [ev(500)] } } }] });
  const marked = decisionsOfTxs([tx(`${OVERREACH_MARK} The press desk sent this call.`)], "token.test");
  const plain = decisionsOfTxs([tx("The Chair is seated.")], "token.test");
  assert.equal(marked.decisions.length, 1);
  assert.equal(plain.decisions.length, 1);
  assert.equal(marked.decisions[0].byVisitor, true);
  assert.equal(plain.decisions[0].byVisitor, false);
  const el = host();
  renderHero(fakeDoc(), el, { decisions: marked.decisions, policy: { rateBps: 500, epoch: 9, lastSetEpoch: 9 }, status: "ok" }, { texts: [], resolved: new Map([[TX, { text: "x", verdict: "verified", chair: null, kind: null, source: null, onChain: true }]]), explorer: null, indexerUrl: null, repoBase: "", network: null });
  assert.match(text(el), /Forced by a visitor through the press desk, not decided by the AI chair/);
});

test("a refusal that came back as 'already set' says so plainly instead of claiming the bound; an unreadable chain says nothing was sent", async () => {
  const p = await panel(() => res(200, refused({ failure: "Smart contract panicked: policy already set this epoch", hit: "already_set", bound: null })));
  await p.api.submit("500");
  assert.match(text(p.el), /refused this one as already set/);
  assert.doesNotMatch(text(p.el), /absolute limit: the contract never/);
  const q = await panel(() => res(200, { status: "unreadable", line: "Not sent: the desk could not read the chain just now, so it sent nothing and spent none of your attempts. Try again in a moment." }));
  await q.api.submit("500");
  assert.match(text(q.el), /Not sent: the desk could not read the chain/);
  assert.equal(q.api.state().busy, false);
});

test("press.request waits for a discovery already under way instead of reporting no desk (the overreach panel asks at page load, while the first lookup is still in flight)", async () => {
  const { createPress } = await import(join(root, "site", "js", "press.js"));
  const DISCOVERY = "https://gist.example.invalid/raw/chair-press.json";
  let release;
  const gate = new Promise((r) => (release = r));
  const seen = [];
  const fetchImpl = async (u) => {
    seen.push(u);
    if (u.startsWith(DISCOVERY)) {
      await gate;
      return { ok: true, status: 200, json: async () => ({ url: "https://quiet-harbor-minutes.trycloudflare.com", updated_at_ms: 1 }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, overreach: true }) };
  };
  const press = createPress(fakeDoc(), host(), { discoveryUrl: DISCOVERY, fetchImpl, storage: { getItem: () => null, setItem: () => {} }, timers: manual(), now: () => 1_000_000 });
  const asked = press.request("/health", () => ({}));
  release();
  const r = await asked;
  assert.equal(r.ok, true);
  assert.ok(seen.some((u) => u === "https://quiet-harbor-minutes.trycloudflare.com/health"));
  press.stop();
});

// ---- forged refusals: the marked text alone proves nothing ----
const TOKEN = "token.test";
const MARKED = "$CHAIR overreach test. The press desk sent this call at a visitor's request, signed by the chair account's key. The visitor chose the rate; the contract decides.";
const failedCall = (hash, signer, rate, reasoning, panic) => ({
  transaction: { hash, signer_id: signer, receiver_id: TOKEN, actions: [{ FunctionCall: { method_name: "set_policy", args: Buffer.from(JSON.stringify({ rate_bps: rate, reasoning })).toString("base64") } }] },
  receipts: [{ execution_outcome: { block_height: 50, block_timestamp: "1700000000000000000", outcome: { executor_id: TOKEN, status: { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${panic}` } } } } }, logs: [] } } }],
});

test("byVisitor needs the chair as signer, a rate beyond the limit, and the mark: a stranger's marked call is an ordinary refusal that names who signed it", async () => {
  const { refusalsOfTxs } = await import(join(root, "site", "js", "decisions.js"));
  const { renderRefusals } = await import(join(root, "site", "js", "refusals.js"));
  const CHAIRS = [SIGNER];
  const hashes = ["2", "3", "4", "5"].map((c) => c.repeat(44));
  const txs = [
    failedCall(hashes[0], "stranger.testnet", 5, MARKED, "only the chair may set policy"),
    failedCall(hashes[1], SIGNER, 5, MARKED, "rate step too large: must move at most 50 bps from the current rate"),
    failedCall(hashes[2], SIGNER, 500, MARKED, "rate_bps out of bounds: must be within -200..=200"),
    failedCall(hashes[3], "stranger.testnet", 500, MARKED, "only the chair may set policy"),
  ];
  const out = refusalsOfTxs(txs, TOKEN, CHAIRS);
  const by = Object.fromEntries(out.map((r) => [r.tx, r]));
  console.log("forged stranger (rate 5, marked text, signer stranger.testnet):", JSON.stringify({ signer: by[hashes[0]].signer, rateBps: by[hashes[0]].rateBps, reason: by[hashes[0]].reason, byVisitor: by[hashes[0]].byVisitor }));
  assert.equal(by[hashes[0]].byVisitor, false, "stranger, rate 5");
  assert.equal(by[hashes[1]].byVisitor, false, "chair as signer but rate 5");
  assert.equal(by[hashes[2]].byVisitor, true, "chair, rate 500, mark");
  assert.equal(by[hashes[3]].byVisitor, false, "stranger, rate 500: not the chair's key, so not the desk");
  assert.equal(refusalsOfTxs(txs, TOKEN)[2].byVisitor, false, "no known chair accounts: nothing is labelled");
  assert.equal(typeof out[0].tsMs, "bigint", "the index timestamp is a BigInt");

  // What the page says about the stranger's call: who signed it, and nothing about the chair or the desk.
  const doc = fakeDoc();
  const el = host(doc);
  renderRefusals(doc, el, { status: "complete", refusals: [by[hashes[0]]], policy: { chair: SIGNER } }, { explorer: EXPLORER });
  const shown = text(el);
  assert.match(shown, /stranger\.testnet/);
  assert.match(shown, /The account that signed was not the chair/);
  assert.doesNotMatch(shown, /visitor|press desk|AI chair|never been refused/i);
  assert.match(shown, /2023-11-14 22:13 UTC/, "a BigInt timestamp formats as a date");
});

test("a hostile 'hit' from the desk is no known check: the generic Chair line is used, never a lookup on the object's prototype", async () => {
  for (const hit of ["__proto__", "constructor", "toString", "accepted", 5]) {
    const p = await panel(() => res(200, refused({ hit, bound: null })));
    await p.api.submit("500");
    assert.match(text(p.el), /The Chair notes that the contract has declined/, String(hit));
    assertInert(p.el);
  }
  assert.equal(parseAttempt(refused({ hit: "__proto__" })).hit, null);
});

test("the idle hint says each address may send a few attempts an hour", async () => {
  const p = await panel(() => res(500, null));
  assert.match(text(p.el), /a few an hour per address/);
});

const ROWS = [
  { tx: TX, rateBps: 500, reason: "rate_bps out of bounds: must be within -200..=200", signer: SIGNER, tsMs: 1_700_000_000_000, byVisitor: true },
  { tx: "6".repeat(44), rateBps: 300, reason: EVIL, signer: SIGNER, tsMs: 1_700_000_000_000, byVisitor: false },
];
const chain = (rows = ROWS) => () => ({ refusals: rows, policy: { rateBps: 5 } });

test("a cap or per-address 429 never dead-ends: the latest real refusal is shown at once, labelled an earlier attempt, with a try-again wait", async () => {
  for (const [code, words] of [["cap", /sent all the attempts it allows/], ["per_address", /This address has used its attempts/], ["other", /This address has used its attempts/]]) {
    const p = await panel(() => res(429, { code, retry_after_s: 600 }), { refusals: chain() });
    await p.api.submit("500");
    assert.match(p.api.state().message, words, code);
    assert.match(p.api.state().message, /Try again in 10 minutes\./, code);
    const out = text(p.el);
    assert.match(out, /Refused by the contract/, code);
    assert.match(out, /An earlier attempt, not yours\./, code);
    assert.match(out, /Asked for 5% a day \(\+500 bps\)/, code);
    assert.match(out, /forced by a visitor/, code);
    assert.match(out, /about 10 minutes/, code);
    assert.equal(find(p.el, (n) => n.tag === "a" && n.attrs.href === `${EXPLORER}/txns/${TX}`).length >= 1, true, "the tx link is on the page");
    assertInert(p.el);
  }
});

test("a 429 with no Retry-After body falls back to a short wait, and the label is never upgraded: a project test call and a plain signer read as what they are", async () => {
  const { PROJECT_TEST_CALLS } = await import(join(root, "site", "js", "refusals.js"));
  const known = [...PROJECT_TEST_CALLS][0];
  const a = await panel(() => res(429, { code: "cap" }), { refusals: chain([{ tx: known, rateBps: 400, reason: "rate step too large", signer: SIGNER, tsMs: 1, byVisitor: false }]) });
  await a.api.submit("500");
  assert.match(a.api.state().message, /Try again in 20 s\./);
  assert.match(text(a.el), /deliberate test call that I made/);
  assert.doesNotMatch(text(a.el), /forced by a visitor/);
  const b = await panel(() => res(429, { code: "cap", retry_after_s: 30 }), { refusals: chain([ROWS[1]]) });
  await b.api.submit("500");
  assert.match(text(b.el), /A refused call signed by/);
  assert.doesNotMatch(text(b.el), /forced by a visitor|deliberate test call/);
  assertInert(b.el);
});

test("429 with nothing on chain to replay shows only the wait; composing shows no replay; the next try clears the replay", async () => {
  const none = await panel(() => res(429, { code: "cap", retry_after_s: 60 }), { refusals: () => ({ status: "complete", refusals: [], policy: { rateBps: 0 } }) });
  await none.api.submit("500");
  assert.match(none.api.state().message, /Try again in 60 s\./);
  assert.doesNotMatch(text(none.el), /An earlier (recorded )?attempt, not yours/);
  const blind = await panel(() => res(429, { code: "cap", retry_after_s: 600 }));
  await blind.api.submit("500");
  assert.match(text(blind.el), /about 10 minutes before another attempt\. Meanwhile, here is one recorded earlier/);
  assert.match(text(blind.el), /An earlier recorded attempt, not yours and not live/);
  assert.match(text(blind.el), /Asked for 2\.01% a day \(\+201 bps\)/);
  assertInert(blind.el);
  const comp = await panel(() => res(429, { code: "composing", retry_after_s: 40 }), { refusals: chain() });
  await comp.api.submit("500");
  assert.doesNotMatch(text(comp.el), /An earlier attempt, not yours/);
  let n = 0;
  const p = await panel((path, init) => (init.method === "POST" && ++n === 1 ? res(429, { code: "cap", retry_after_s: 5 }) : res(200, refused())), { refusals: chain() });
  await p.api.submit("500");
  assert.match(text(p.el), /An earlier attempt, not yours/);
  await p.timers.tick();
  await p.api.submit("500");
  assert.doesNotMatch(text(p.el), /An earlier attempt, not yours/);
  assert.match(text(p.el), /Refused by the contract/);
});

test("desk offline: the latest refusal replays under a stamp, with the older ones listed after it and every label truthful", async () => {
  const p = await panel(() => res(500, null), { open: false, refusals: chain() });
  const out = text(p.el);
  assert.match(out, /Refused by the contract/);
  assert.match(out, /An earlier attempt, not yours\./);
  assert.match(out, /forced by a visitor/);
  assert.ok(out.includes(DOWN));
  assertInert(p.el);
});

test("while the desk is out of reach the panel looks again every 20 s and opens by itself when the desk is back; the closed text says it will", async () => {
  assert.match(DOWN, /keeps checking by itself/);
  let up = false;
  const timers = manual();
  const request = async (path) => (up ? res(200, { ok: true, overreach: true }) : Promise.reject(new Error("no press desk")));
  const el = host();
  const api = createOverreach(fakeDoc(), el, { request, explorer: EXPLORER, rpcUrl: RPC, refusals: () => null, timers, now: () => 1_000_000 });
  await new Promise((r) => setImmediate(r));
  assert.equal(api.state().mode, "down");
  assert.equal(timers.queue.length, 1);
  assert.equal(timers.queue[0].ms, 20_000);
  await timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(api.state().mode, "down");
  assert.equal(timers.queue.length, 1);
  up = true;
  await timers.tick();
  await new Promise((r) => setImmediate(r));
  assert.equal(api.state().mode, "ready");
  assert.equal(timers.queue.length, 0);
});
