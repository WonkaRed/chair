// "Your own test coins": the visitor's browser makes its own testnet key, the press desk's faucet funds the account that key owns with test coins, and
// the visitor then stakes, unstakes, claims and sends with every transaction signed here, by that key. The page holds no key of mine: the only secret it
// ever touches is the visitor's own, kept in this browser's localStorage and shown on request. The page reads the chain straight from the RPC nodes; the desk
// is needed only for "Get coins" (POST /faucet), and is untrusted like the other desks: everything it returns is checked and reaches the page by `textContent`.
// `mineModel` is the whole panel as a pure function (state in, view model out); `createMine` holds the state and does the talking.
import { formatTokens, parseU128, UNIT } from "./amounts.js";
import { clear, h } from "./dom.js";
import { base58Decode, canEd25519, claimCall, encodeFunctionCall, generateKey, implicitAccountId, parseSecretKey, publicKeyText, rpcClient, secretKeyText, signTransaction, stakeCall, transferCall, unstakeCall } from "./near.js";
import { POLL_MS as DESK_POLL_MS } from "./press.js";
import { isAccountId, isTxHash, safeText } from "./text.js";
import { shortHash } from "./views.js";

export const STORE_KEY = "chair-mine-key";
const DEFAULT_AMOUNT = "10";
export const WATCH_MS = 1000;
const REFRESH_FLOOR_MS = 8_000; // the numbers are read at least this far apart
const REFRESH_CAP_MS = 120_000; // and at least this often while the page is open
const MEETING_GRACE_MS = 3_000; // the chain applies a meeting a little after it opens
const SETTLE_MS = 10_000; // after a call, the numbers are read again until they move, for at most this long
const SETTLE_STEP_MS = 1_000;
export const SEND_TIMEOUT_MS = 45_000; // one node's time to run a transaction

export const NO_ED25519 = "This browser cannot make the key your test account needs, so this part of the page is switched off. A recent Chrome, Edge, Firefox or Safari can.";
export const HELP = "Stake locks coins up: staked coins earn the new coins the Chair prints, and count as votes. Unstake takes them out again after two meetings. Claim moves what they earned into your wallet.";
export const KEY_NOTE = "This text is your account's key. Anyone who has it can move your test coins, and there is nothing else in the account. Keep it if you want to open this account again somewhere else.";
export const KEPT_NOT = "This browser would not let the page keep the key. Use Take your key and copy it before you leave, or this account is lost.";
const FAUCET_DOWN = "The faucet could not be reached. It runs on my workstation, which is not always on, and this page looks again by itself.";

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whole coins and up to 24 decimals as base units (BigInt), or null when the text is not a number of coins. */
export function parseAmount(text) {
  const m = /^(\d{1,12})(?:\.(\d{1,24}))?$/.exec(String(text ?? "").trim());
  return m === null ? null : BigInt(m[1]) * UNIT + BigInt((m[2] ?? "").padEnd(24, "0"));
}

/** Coins as people read them: up to four decimals, six for amounts under one coin, and "under" for dust. */
export function fmtCoins(n) {
  if (n === 0n) return "0";
  if (n < 10n ** 18n) return "under 0.000001";
  return formatTokens(n, n < UNIT ? 6 : 4);
}

/** An account as a sentence carries it: the 64 hex characters of a visitor's account become `a0bd33c1…09d2f7`, and a name people wrote stays whole. The full name goes in a `title`. */
export const shortId = (id) => (id.length > 40 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

/** An amount of coins with its unit: "1 coin", "2.5 coins". */
export const coinsOf = (text) => `${text} ${text === "1" ? "coin" : "coins"}`;

/** A wait as a person says it: seconds under two minutes, then minutes, then hours. */
export function waitWords(s) {
  const n = Math.max(1, Math.ceil(s));
  if (n < 120) return `${n} second${n === 1 ? "" : "s"}`;
  if (n < 7200) return `${Math.ceil(n / 60)} minutes`;
  return `${Math.ceil(n / 3600)} hours`;
}

/** The clock for a short countdown: 2:41. */
export const clock = (s) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.max(0, s) % 60).padStart(2, "0")}`;

/** A share of the supply, as a percentage with up to four decimals, or null when the supply is not known. */
export function sharePercent(coins, totalSupply) {
  const n = parseAmount(coins);
  if (n === null || typeof totalSupply !== "bigint" || totalSupply <= 0n) return null;
  const ppm = (n * 1_000_000n) / totalSupply; // millionths of the supply
  if (ppm === 0n) return "under 0.0001%";
  return `${(Number(ppm) / 10_000).toFixed(4).replace(/\.?0+$/, "")}%`;
}

/** The faucet's GET /faucet/state, in the documented shape, or null. `reason` is the desk's word for why it is closed, when it gives one. */
export function parseFaucetState(j) {
  if (!isObj(j) || typeof j.open !== "boolean") return null;
  const coins = typeof j.grant_chair === "string" && /^[1-9]\d{0,8}$/.test(j.grant_chair) ? j.grant_chair : null;
  const wait = Number.isSafeInteger(j.next_opening_s) && j.next_opening_s > 0 ? j.next_opening_s : null;
  const reason = ["off", "killed", "dry", "budget", "unreadable"].includes(j.reason) ? j.reason : null;
  return { open: j.open, coins, wait, reason };
}

/** The faucet's refusal of a request for coins, as `closed`: its kind, when it may be tried again (seconds) and the desk's own words. */
export function parseRefusal(status, body) {
  const words = isObj(body) && typeof body.error === "string" ? safeText(body.error, 160) : null;
  if (status === 429) return { kind: body?.limit === "address" ? "address" : "limited", wait: Number.isFinite(body?.retry_after_s) ? Math.max(1, Math.min(86_400, Math.ceil(body.retry_after_s))) : 60, words: body?.limit === "address" ? null : words };
  if (status === 503) return { kind: ["off", "killed", "dry", "budget", "unreadable"].includes(body?.reason) ? body.reason : "other", wait: null, words };
  if (status === 400) return { kind: "bad", wait: null, words };
  return { kind: "down", wait: null, words: null };
}

const CLOSED_LINE = {
  off: "The faucet is closed for now.",
  killed: "The faucet is closed for now.",
  dry: "The faucet is not ready right now. This page checks again by itself.",
  unreadable: "The faucet is not ready right now. This page checks again by itself.",
  budget: "Every coin the faucet may give has been given. That limit is on purpose, and it is explained below.",
  closed: "The faucet has handed out all it may for now.",
  limited: "The faucet is handing coins out slowly so that everyone gets a turn.",
  address: "This network has had its test coins for today.",
  unreachable: FAUCET_DOWN,
  bad: "The faucet did not accept the key this page made. Press the button again to try with a new one.",
  taken: "The faucet found that key already has an account it did not fund, so this page dropped the key. Press the button to make a new one.",
  retry: "The faucet stopped before it finished. Your key is kept, and pressing the button picks up where it left off.",
  down: FAUCET_DOWN,
};
const HELD = "This browser already made a test account, but no coins have reached it yet. Press Try again and the faucet picks up where it left off.";
/** These end the offer for now: the button waits until the stated time, or until the page sees the faucet open again. */
const BLOCKS = new Set(["off", "killed", "dry", "budget", "unreadable", "closed", "limited", "address", "unreachable"]);
/** Only these come with a time the desk means: its own caps reopening, or the wait it set. A dry or unreadable faucet is only looked at again. */
const TIMED = new Set(["closed", "limited", "address"]);
/** The waits the desk set for one visitor, which even a held key must sit out. */
const WAITS = new Set(["limited", "address"]);
const UNREACHABLE = { kind: "unreachable", untilMs: null, words: null };

function closedNote(closed, now) {
  if (closed === null) return null;
  const left = TIMED.has(closed.kind) && closed.untilMs !== null ? Math.ceil((closed.untilMs - now) / 1000) : null;
  if (left !== null && left <= 0) return null; // the wait is over
  const when = left === null ? "" : WAITS.has(closed.kind) ? ` Try again in ${waitWords(left)}.` : ` It opens again in ${waitWords(left)}.`;
  const known = CLOSED_LINE[closed.kind];
  const base = known ?? closed.words ?? CLOSED_LINE.down; // a reason this page does not know is shown in the desk's own words
  return { text: `${base}${when}`, words: known === undefined ? null : closed.words ?? null, blocks: BLOCKS.has(closed.kind) };
}

/**
 * The whole panel, from plain state. `supported` is whether this browser has ed25519 (null while that is being checked), `desk` is "on" when the faucet reports
 * it is on, `key` is `{ accountId, funded }` or null, `account` is the last read of the chain (`wallet`, `staked`, `pending` as BigInt, `unlockAtMs`), `readFailed`
 * says the last read did not work, `closed` is why the faucet will not give coins now, `result` is what the last action did, `grant` is `{ coins, percent }`:
 * what one visit gets, and that as a share of the supply (null while the supply is not known). A browser that holds a key sees
 * the panel and a Try again button whatever the faucet says: the desk answers a key it has already seen even when it is closed to new ones.
 */
export function mineModel({ supported = null, desk = null, key = null, creating = false, closed = null, account = null, readFailed = false, busy = null, amountText = DEFAULT_AMOUNT, receiverText = "", result = null, kept = true, grant = { coins: "50", percent: null }, now = 0 } = {}) {
  const funded = key?.funded === true;
  const honest = [
    "These are test coins from a pool I control. They have no value, and nothing of yours is spent.",
    `Your ${grant.coins} coins are ${grant.percent === null ? "a tiny share" : grant.percent} of the supply, far too few to move the Chair's rate.`,
  ];
  const base = { honest, help: HELP, result };
  const held = key !== null;
  const visible = creating || held || desk !== null; // once the desk has been asked the panel is there, with its reason when it is closed
  if (supported === false) return { ...base, visible, mode: "unsupported", unsupported: NO_ED25519 };
  if (!funded) {
    const why = closed ?? (desk === "off" && !held ? UNREACHABLE : null); // a desk that is off and said nothing more is a desk that did not answer
    const note = closedNote(why, now);
    const blocked = (note?.blocks ?? false) && (!held || WAITS.has(why.kind)); // a held key is never turned away by the faucet's state, only by a wait the desk set
    return {
      ...base, visible, mode: "get",
      get: { label: creating ? "Making your account…" : held ? "Try again" : `Get ${grant.coins} test coins`, enabled: visible && supported === true && !creating && !blocked, note: creating ? "Making your account and sending the coins. This takes a few seconds." : note?.text ?? (held ? HELD : null), words: creating ? null : note?.words ?? null },
      keepNote: kept ? null : KEPT_NOT,
    };
  }

  const ready = account !== null;
  const show = (v) => (ready ? fmtCoins(v) : readFailed ? "unavailable" : "…");
  const locked = ready && account.staked > 0n && account.unlockAtMs !== null && account.unlockAtMs > now;
  const amount = parseAmount(amountText);
  const receiver = receiverText.trim();
  let amountHint = null;
  if (ready) {
    if (amount === null) amountHint = "Write the number of coins, like 10 or 2.5.";
    else if (amount === 0n) amountHint = "Use more than zero coins.";
  }
  const usable = ready && supported === true && busy === null && amount !== null && amount > 0n;
  const receiverOk = isAccountId(receiver) && receiver !== key.accountId;
  const receiverHint = receiver === "" || receiverOk ? null : receiver === key.accountId ? "That is your own account." : "That is not a NEAR account name, like alice.chair-coin-3.testnet.";
  const tooMany = (have) => usable && amount > have;
  const label = (action, idle, working) => (busy === action ? working : idle);
  return {
    ...base, visible: true, mode: "funded",
    account: { id: key.accountId, short: shortId(key.accountId) },
    numbers: [
      { key: "wallet", label: "In your wallet", value: show(account?.wallet ?? 0n) },
      { key: "staked", label: "Staked", value: show(account?.staked ?? 0n) },
      { key: "earned", label: "Earned, not yet claimed", value: show(account?.pending ?? 0n) },
    ],
    lock: !ready || account.staked === 0n ? null : locked ? `Locked for two meetings of the Chair. Unlocks in ${clock(Math.ceil((account.unlockAtMs - now) / 1000))}.` : "Your staked coins are free to take out.",
    earnedNote: ready && account.staked > 0n ? (account.pending === 0n ? "Coins are earned when the Chair meets, and only while its rate is above zero. Check back after the next meeting." : "The number is small because the Chair prints only a fraction of a percent a day.") : null,
    amountHint: amountHint ?? (tooMany(account?.wallet ?? 0n) && tooMany(account?.staked ?? 0n) ? `You only have ${fmtCoins(account.wallet)} in your wallet${account.staked > 0n ? ` and ${fmtCoins(account.staked)} staked` : ""}.` : null),
    receiverHint,
    actions: {
      stake: { label: label("stake", "Stake", "Staking…"), enabled: usable && amount <= account.wallet },
      unstake: { label: label("unstake", "Unstake", "Unstaking…"), enabled: usable && !locked && amount <= account.staked },
      claim: { label: label("claim", "Claim", "Claiming…"), enabled: ready && supported === true && busy === null && account.pending > 0n },
      send: { label: label("send", "Send", "Sending…"), enabled: usable && receiverOk && amount <= account.wallet },
    },
    readFailed,
    keepNote: kept ? null : KEPT_NOT,
  };
}

// What a failed call says. Each pattern is the contract's own panic text (contract/src/staking.rs, token.rs and near-contract-standards), so the plain
// sentence above the contract's words is never a guess about something else.
const REFUSALS = [
  [/locked until epoch/, "Your coins are still locked. The contract keeps a stake in for two meetings of the Chair, and it said no."],
  [/nothing to claim/, "There is nothing to claim yet. Coins are earned when the Chair meets, and only while its rate is above zero."],
  [/no stake/, "You have nothing staked, so there is nothing to take out."],
  [/exceeds the staked balance/, "That is more than you have staked."],
  [/not registered/, "That account is not set up to hold these coins, so the contract refused to send them there. Try an account that already holds some, such as one made on this page."],
  [/enough balance/, "That is more coins than you have in your wallet."],
  [/Sender and receiver should be different/, "You cannot send coins to yourself."],
];
const NO_FEES = "Your test account has run out of the NEAR it pays network fees with, so the call was not made.";

/** The panic text the contract gave, without the runtime's prefix, or null. `status` is a transaction outcome's `status`. */
export function contractWords(status) {
  const text = status?.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return typeof text === "string" ? safeText(text.replace(/^Smart contract panicked:\s*/, ""), 240) : null;
}

/**
 * What a transaction did, from the node's reply to `send_tx`: `{ tone: "ok" | "refused" | "failed", title, contract, tx }`. `what` is `{ action, coins, receiver }`
 * for the words, `tx` the transaction hash the visitor can open. A call the contract refused changes nothing, and the contract's own words go under a plain sentence.
 */
export function describeOutcome(what, result, tx) {
  const status = result?.status;
  if (isObj(status) && "SuccessValue" in status) {
    let earned = null;
    if (what.action === "claim" && typeof status.SuccessValue === "string" && status.SuccessValue !== "") {
      try {
        earned = parseU128(JSON.parse(atob(status.SuccessValue)), "claimed");
      } catch {
        earned = null;
      }
    }
    const to = what.action === "send" ? shortId(what.receiver) : null;
    const title = {
      stake: `Staked ${coinsOf(what.coins)}. They are locked for two meetings of the Chair, and they start earning at the next one.`,
      unstake: `Took ${coinsOf(what.coins)} out of the stake. They are back in your wallet.`,
      claim: earned === null ? "Moved what you earned into your wallet." : `Moved ${coinsOf(fmtCoins(earned))} you earned into your wallet.`,
      send: `Sent ${coinsOf(what.coins)} to ${to}.`,
    }[what.action];
    return { tone: "ok", title, full: to !== null && to !== what.receiver ? what.receiver : null, contract: null, tx };
  }
  if (isObj(status) && isObj(status.Failure)) {
    const words = contractWords(status);
    const sentence = words === null ? null : REFUSALS.find(([re]) => re.test(words))?.[1] ?? null;
    if (words !== null) return { tone: "refused", title: sentence ?? "The contract refused this call, and nothing changed.", contract: words, tx };
    return { tone: "failed", title: /LackBalance|NotEnoughBalance/.test(JSON.stringify(status.Failure)) ? NO_FEES : "The network did not run this call, and nothing changed.", contract: null, tx };
  }
  return { tone: "failed", title: "The call was sent, but this page could not tell what it did. Open the transaction to see.", contract: null, tx };
}

/** What a transaction that never got an answer, or was turned away before it ran, says. */
export function describeFailure(error, tx) {
  const detail = String(error?.detail ?? "");
  if (/NotEnoughBalance|LackBalance/.test(detail)) return { tone: "failed", title: NO_FEES, contract: null, tx: null };
  if (error?.kind === "network") return { tone: "failed", title: tx === null ? "No network node answered, so nothing was sent. Try again in a moment." : "The call was sent, but no node answered about it. It may still go through: open the transaction to see.", contract: null, tx };
  return { tone: "failed", title: "The network turned this call away, and nothing changed.", contract: null, tx: null };
}

/** What each call must have changed once the chain shows it: `a` is the account as read now, `b` as it was before the call. */
const MOVED = {
  stake: (a, b) => a.wallet < b.wallet && a.staked > b.staked,
  unstake: (a, b) => a.wallet > b.wallet && a.staked < b.staked,
  claim: (a, b) => a.wallet > b.wallet,
  send: (a, b) => a.wallet < b.wallet,
};

const txLink = (doc, explorer, hash, text = shortHash(hash)) => (explorer && isTxHash(hash) ? h(doc, "a", { href: `${explorer}/txns/${hash}`, rel: "noopener noreferrer", target: "_blank" }, text) : text);

/** localStorage when it is there and allowed, else a store that forgets. */
function safeStore() {
  try {
    const s = globalThis.localStorage;
    if (s) return { get: (k) => s.getItem(k), set: (k, v) => s.setItem(k, v) };
  } catch {
    // Blocked: fall through.
  }
  return { get: () => null, set: () => { throw new Error("storage is blocked"); } };
}

/** The key this browser kept: `{ secret, funded }`, or null when there is none or it is not a key. */
function readKey(store) {
  try {
    const j = JSON.parse(store.get(STORE_KEY) ?? "null");
    if (!isObj(j) || typeof j.secret !== "string") return null;
    const { publicKey } = parseSecretKey(j.secret);
    return { secret: j.secret, funded: j.funded === true, accountId: implicitAccountId(publicKey), publicKey: publicKeyText(publicKey) };
  } catch {
    return null;
  }
}

/**
 * Builds the panel into `host`; `section` is the page section, shown only while there is something true to show in it, and `link` the nav item that points at it
 * (shown with it). `request(path, init)` talks to the
 * press desk and throws when there is none. `post(body)` sends one JSON-RPC body to a NEAR node, failing over between nodes, and throws when none answers.
 * `supply()` is the token's total supply as the page last read it (BigInt, or null). `token` is the contract, `sample` a receiver that holds coins.
 */
export function createMine(doc, host, { section = null, link = null, request, post, token, explorer = null, sample = "", supply = () => null, store = safeStore(), subtle = globalThis.crypto?.subtle, timers = { set: (f, ms) => setTimeout(f, ms), clear: (t) => clearTimeout(t) }, sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now } = {}) {
  let supported = null;
  let desk = null;
  let key = readKey(store);
  let kept = true;
  let creating = false;
  let closed = null; // why the faucet will not give coins now: { kind, untilMs, words }
  let grantCoins = "50";
  let account = null;
  let readFailed = false;
  let epochMs = null;
  let busy = null;
  let result = null;
  let shown = null;
  let reading = null;
  let refreshAt = 0;
  let lastNonce = 0;
  let ticker = null;
  let retry = null;
  let revealed = false;
  const rpc = rpcClient(post);

  const amount = h(doc, "input", { id: "mine-amount", name: "amount", type: "text", inputmode: "decimal", autocomplete: "off", spellcheck: "false" });
  amount.value = DEFAULT_AMOUNT;
  const receiver = h(doc, "input", { id: "mine-receiver", name: "receiver", type: "text", autocomplete: "off", spellcheck: "false", autocapitalize: "none", placeholder: sample });
  receiver.value = "";
  const btn = (cls, text) => h(doc, "button", { type: "button", class: cls }, text);
  const get = btn("ask jn-btn mn-get", "Get 50 test coins");
  const getNote = h(doc, "p", { class: "form-note", role: "status" });
  const getWords = h(doc, "p", { class: "note mn-words" });
  const getWho = h(doc, "p", { class: "jn-who" }, "Test coins have no value. Nothing of yours is used, and you need nothing of your own to start.");
  const getBox = h(doc, "div", { class: "mn-get-box" }, get, getWho, getNote, getWords);
  const unsupported = h(doc, "p", { class: "closed-line" });
  const accountLine = h(doc, "p", { class: "mn-acct" });
  const numbers = new Map(["wallet", "staked", "earned"].map((k) => [k, { value: h(doc, "strong", {}), label: h(doc, "span", { class: "mn-k" }) }]));
  const tiles = h(doc, "div", { class: "mn-nums" }, [...numbers].map(([k, n]) => h(doc, "div", { class: `mn-num mn-${k}` }, n.value, n.label)));
  const lock = h(doc, "p", { class: "mn-lock" });
  const earnedNote = h(doc, "p", { class: "note mn-soon" });
  const stake = btn("ask mn-act", "Stake");
  const unstake = btn("ask mn-act mn-quiet", "Unstake");
  const claim = btn("ask mn-act mn-quiet", "Claim");
  const send = btn("ask mn-act mn-quiet", "Send");
  const amountHint = h(doc, "p", { class: "form-note mn-hint", role: "status" });
  const receiverHint = h(doc, "p", { class: "form-note mn-hint", role: "status" });
  const keepNote = h(doc, "p", { class: "form-note mn-keep", role: "status" });
  const outcome = h(doc, "div", { class: "mn-result", "aria-live": "polite" });
  const keyBody = h(doc, "div", { class: "mn-keybody" });
  const keyButton = btn("chip", "Take your key");
  const fundedBox = h(doc, "div", { class: "mn-funded" },
    h(doc, "p", { class: "mn-head" }, "Your test account, funded by my faucet"), accountLine, tiles, earnedNote,
    h(doc, "div", { class: "mn-form" },
      h(doc, "label", { for: "mine-amount" }, "How many coins, for Stake, Unstake and Send"), amount, amountHint,
      h(doc, "div", { class: "mn-row" }, stake, unstake, claim), lock,
      h(doc, "label", { for: "mine-receiver" }, "Send coins to another account"), receiver, receiverHint,
      h(doc, "div", { class: "mn-row" }, send)),
    outcome, keepNote, h(doc, "p", { class: "note mn-help" }, HELP),
    h(doc, "div", { class: "mn-key" }, keyButton, keyBody));
  const honest = h(doc, "ul", { class: "mn-honest" });
  const how = h(doc, "details", { class: "fold mn-how" });
  host.append(getBox, unsupported, fundedBox, honest, how);

  const snapshot = () => ({ supported, desk, key, creating, closed, account, readFailed, busy, amountText: amount.value ?? "", receiverText: receiver.value ?? "", result, kept, grant: { coins: grantCoins, percent: sharePercent(grantCoins, supply()) }, now: now() });
  const model = () => mineModel(snapshot());

  function renderHow() {
    clear(how);
    how.append(h(doc, "summary", {}, "How this works, for people who check"),
      h(doc, "p", { class: "note" }, "Your browser makes an ed25519 key with its own WebCrypto and keeps it in this browser's localStorage. The account is the key's public half written as 64 hex characters, a NEAR implicit account, so nobody had to create it for you. Only the public half is sent to the faucet, which opens the account with a little NEAR for network fees and sends the coins."),
      h(doc, "p", { class: "note" }, `Each button signs one call to the token, ${token}, with that key in your browser, and sends it to a public NEAR testnet node. Stake attaches 1 yoctoNEAR, or 0.003 NEAR the first time to pay for the stake record (the rest is refunded). Unstake, claim and ft_transfer attach exactly 1 yoctoNEAR. There is no key of mine on this page, and the faucet never sees yours.`),
      h(doc, "p", { class: "note" }, "A stake is locked for two meetings of the Chair. Send needs a receiver the token already knows: the contract refuses coins for an account that is not registered with it, and says so under the result."),
      h(doc, "p", { class: "note" }, "While the Chair's rate is below zero the token burns a slice of every transfer, so you may hold a little under what the faucet sent, and a receiver gets a little under what you send. The numbers here are always read from the chain."));
  }

  function renderResult(m) {
    if (m.result === shown) return;
    shown = m.result;
    clear(outcome);
    const r = m.result;
    if (r === null) return;
    outcome.append(h(doc, "article", { class: `mn-card ${r.tone}`, "aria-label": r.tone === "ok" ? "What your call did" : "Your call did not go through" },
      h(doc, "p", { class: "mn-title", title: r.full ?? null }, r.title),
      r.contract === null ? null : h(doc, "p", { class: "mn-says" }, h(doc, "span", { class: "k" }, "The contract's words"), " ", h(doc, "code", {}, r.contract)),
      r.extra ?? null,
      r.tx ? h(doc, "p", { class: "or-tx" }, "The transaction: ", txLink(doc, explorer, r.tx)) : null));
  }

  function render() {
    const m = model();
    if (section !== null) section.hidden = !m.visible;
    if (link !== null) link.hidden = !m.visible;
    getBox.hidden = !(m.visible && m.mode === "get");
    unsupported.hidden = !(m.visible && m.mode === "unsupported");
    fundedBox.hidden = !(m.visible && m.mode === "funded");
    honest.hidden = how.hidden = !m.visible || m.mode === "unsupported";
    clear(honest);
    honest.append(...m.honest.map((t) => h(doc, "li", {}, t)));
    if (m.mode === "get") {
      get.textContent = m.get.label;
      get.disabled = !m.get.enabled;
      getNote.textContent = m.get.note ?? "";
      getWords.textContent = m.get.words === null ? "" : `The faucet's words: ${m.get.words}`;
      getWords.hidden = m.get.words === null;
    }
    if (m.mode === "unsupported") unsupported.textContent = m.unsupported;
    keepNote.textContent = m.keepNote ?? "";
    if (m.mode === "funded") {
      clear(accountLine);
      accountLine.append("Account ", explorer ? h(doc, "a", { href: `${explorer}/address/${m.account.id}`, rel: "noopener noreferrer", target: "_blank", title: m.account.id }, m.account.short) : h(doc, "span", { title: m.account.id }, m.account.short));
      for (const n of m.numbers) {
        numbers.get(n.key).value.textContent = n.value;
        numbers.get(n.key).label.textContent = n.label;
      }
      lock.textContent = m.lock ?? "";
      lock.hidden = m.lock === null;
      earnedNote.textContent = m.earnedNote ?? "";
      earnedNote.hidden = m.earnedNote === null;
      for (const [name, el] of Object.entries({ stake, unstake, claim, send })) {
        el.textContent = m.actions[name].label;
        el.disabled = !m.actions[name].enabled;
      }
      amountHint.textContent = m.amountHint ?? "";
      receiverHint.textContent = m.receiverHint ?? "";
      renderResult(m);
    }
    renderKey();
    if (how.children.length === 0) renderHow();
  }

  function renderKey() {
    keyButton.textContent = revealed ? "Hide your key" : "Take your key";
    keyButton.setAttribute("aria-expanded", String(revealed));
    clear(keyBody);
    if (!revealed || key === null) return;
    const copy = btn("chip", "Copy");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(key.secret);
        copy.textContent = "Copied";
      } catch {
        copy.textContent = "Select the key and copy it";
      }
    });
    keyBody.append(h(doc, "p", { class: "note" }, KEY_NOTE),
      h(doc, "p", { class: "note" }, "Account name: ", h(doc, "code", {}, key.accountId)),
      h(doc, "div", { class: "cmd" }, h(doc, "code", { class: "mn-secret" }, key.secret), copy));
  }

  /** Drops a key that is no use: the next press makes another. */
  function forget() {
    key = null;
    try {
      store.set(STORE_KEY, "");
    } catch {
      kept = false;
    }
  }

  function save() {
    try {
      store.set(STORE_KEY, JSON.stringify({ secret: key.secret, funded: key.funded }));
      kept = true;
    } catch {
      kept = false; // blocked or full: the key lasts for this page view, and the panel says to copy it
    }
  }

  // ---- the chain: balances, stake, and the lock ----

  async function readAccount() {
    if (key === null) return;
    reading ??= (async () => {
      try {
        const [wallet, staking, policy, params] = await Promise.all([
          rpc.view(token, "ft_balance_of", { account_id: key.accountId }),
          rpc.view(token, "get_staking", { account_id: key.accountId }),
          rpc.view(token, "get_policy"),
          epochMs === null ? rpc.view(token, "get_params") : Promise.resolve(null),
        ]);
        if (params !== null) epochMs = Number.isSafeInteger(params.epoch_ms) && params.epoch_ms > 0 ? params.epoch_ms : null;
        const unlock = staking.unlock_epoch;
        if (!Number.isSafeInteger(unlock) || !Number.isSafeInteger(policy.epoch) || !Number.isSafeInteger(policy.epoch_ends_ms)) throw new Error("unexpected shape");
        const unlockAtMs = unlock > policy.epoch && epochMs !== null ? policy.epoch_ends_ms + (unlock - policy.epoch - 1) * epochMs : null;
        account = { wallet: parseU128(wallet, "wallet"), staked: parseU128(staking.staked, "staked"), pending: parseU128(staking.pending_reward, "pending"), firstStake: unlock === 0, unlockAtMs, endsMs: policy.epoch_ends_ms };
        readFailed = false;
        const t = now();
        const meeting = policy.epoch_ends_ms + MEETING_GRACE_MS;
        refreshAt = Math.max(t + REFRESH_FLOOR_MS, Math.min(meeting, t + REFRESH_CAP_MS));
        if (unlockAtMs !== null) refreshAt = Math.min(refreshAt, Math.max(t + REFRESH_FLOOR_MS, unlockAtMs + MEETING_GRACE_MS));
      } catch {
        readFailed = true;
        refreshAt = now() + REFRESH_FLOOR_MS * 2;
      } finally {
        reading = null;
        render();
      }
    })();
    return reading;
  }

  /**
   * Reads the chain after a call and again until `moved(account)`, for at most SETTLE_MS, then leaves what the chain says. A node can be a block behind the one that
   * ran the call, and each number is its own request, so one read can come back with some numbers new and one old; waiting for the next scheduled read would
   * leave that old number up for a couple of minutes. The read that was already out when the call finished is waited for, not reused: it began before the call ran.
   * Buttons stay off meanwhile, so no call is made from a number that is about to change.
   */
  async function settle(moved) {
    busy = "settling";
    render();
    try {
      await reading;
      for (const stop = now() + SETTLE_MS; ; await sleep(SETTLE_STEP_MS)) {
        await readAccount();
        if ((account !== null && !readFailed && moved(account)) || now() >= stop) return;
      }
    } finally {
      busy = null;
      render();
    }
  }

  /** One tick a second while the funded panel is up: the lock's countdown, and a read of the chain when it is due and the tab is showing. */
  function tick() {
    ticker = null;
    if (key?.funded !== true) return;
    if (doc.hidden !== true && busy === null && creating === false && now() >= refreshAt) void readAccount();
    render();
    ticker = timers.set(tick, WATCH_MS);
  }

  function watch() {
    if (ticker !== null) timers.clear(ticker);
    ticker = timers.set(tick, WATCH_MS);
  }

  // ---- signing and sending ----

  /** Builds, signs and sends one call, and returns the node's result with the transaction's hash. Throws an error carrying `tx` once a hash is known. */
  async function submit(call) {
    let hash = null;
    for (let attempt = 0; ; attempt++) {
      try {
        const [chainNonce, blockHash] = await Promise.all([rpc.nonce(key.accountId, key.publicKey), rpc.blockHash()]);
        if (chainNonce === null) throw Object.assign(new Error("the account does not exist"), { kind: "rpc", detail: "UNKNOWN_ACCOUNT" });
        const nonce = Math.max(chainNonce, lastNonce) + 1;
        const { publicKey } = parseSecretKey(key.secret);
        const bytes = encodeFunctionCall({ signerId: key.accountId, publicKey, nonce, receiverId: token, blockHash: base58Decode(blockHash), method: call.method, args: new TextEncoder().encode(call.argsJson), gas: call.gas, deposit: call.deposit });
        const signed = await signTransaction(bytes, key.secret, subtle);
        hash = signed.txHash;
        lastNonce = nonce;
        try {
          return { hash, result: await rpc.send(signed.signedBase64) };
        } catch (e) {
          // A node that took the transaction and then did not answer, or a second node told about it, may report an error for a call that ran: ask for it by hash first.
          const landed = await rpc.status(hash, key.accountId).catch(() => null);
          if (landed !== null) return { hash, result: landed };
          if (e.kind === "rpc" && /InvalidNonce/.test(e.detail) && attempt === 0) continue;
          throw e;
        }
      } catch (e) {
        throw Object.assign(e, { tx: e.tx ?? hash });
      }
    }
  }

  async function act(action) {
    const m = model();
    if (busy !== null || m.mode !== "funded" || !m.actions[action]?.enabled) return;
    const coins = amount.value.trim();
    const units = parseAmount(coins);
    const to = receiver.value.trim();
    const call = { stake: () => stakeCall(units, { first: account.firstStake }), unstake: () => unstakeCall(units), claim: () => claimCall(), send: () => transferCall(to, units) }[action]();
    const before = account;
    busy = action;
    result = null;
    render();
    try {
      const sent = await submit(call);
      result = describeOutcome({ action, coins: fmtCoins(units ?? 0n), receiver: to }, sent.result, sent.hash);
    } catch (e) {
      result = describeFailure(e, isTxHash(e.tx) ? e.tx : null);
    }
    if (action === "send" && result.tone === "ok") receiver.value = ""; // sent: Send waits for a new receiver instead of standing ready to repeat the payment
    // A call that ran must show in the wallet, and in the stake for the two calls that move it; one that did not run changes nothing, so one read is enough.
    await settle(result.tone === "ok" ? (a) => MOVED[action](a, before) : () => true);
  }

  // ---- the faucet ----

  /** Whether the desk has told this visitor to wait, and the wait is not over. */
  const waiting = () => WAITS.has(closed?.kind) && closed.untilMs > now();

  /** Whether the desk has the faucet on (GET /health), and what it would give (GET /faucet/state). Anything else is a closed panel for a visitor with no account. */
  async function check(auto = false) {
    if (key?.funded === true) return;
    try {
      const res = await request("/health", () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }), !auto);
      const j = res.ok ? await res.json() : null;
      desk = isObj(j) && j.faucet === true ? "on" : "off";
    } catch {
      desk = "off";
    }
    if (key === null && !waiting()) closed = null; // what the state says next replaces what an older look said, and a desk that stops answering leaves nothing to show
    await readFaucetState(); // when the desk is off this says why (killed, dry, spent); when it did not answer there is nothing to read, and the panel says so
    if (desk !== "on") retryLater();
    render();
  }

  async function readFaucetState() {
    try {
      const res = await request("/faucet/state", () => ({ credentials: "omit", signal: AbortSignal.timeout(10_000) }));
      const s = res.ok ? parseFaucetState(await res.json()) : null;
      if (s === null) return;
      if (s.coins !== null) grantCoins = s.coins;
      if (key !== null) return; // a held key is not turned away by the state: the desk answers a key it has seen even when it is closed to new ones
      if (waiting()) return; // the desk's wait for this visitor is not undone by the state, which is the same for everyone
      closed = s.open ? null : { kind: s.reason ?? "closed", untilMs: s.wait === null ? null : now() + s.wait * 1000, words: null };
      if (!s.open) retryLater();
    } catch {
      // A courtesy: the button works without it.
    }
  }

  /** While the faucet is off or closed, look again every DESK_POLL_MS (not while the tab is hidden), so the panel opens by itself. */
  function retryLater() {
    if (retry !== null) return;
    retry = timers.set(() => {
      retry = null;
      if (doc.hidden === true) return retryLater();
      void check(true);
    }, DESK_POLL_MS);
  }

  /**
   * A key this browser holds that was never marked funded: the grant may have landed while the page was away or its 200 was lost, and the desk may be off, so the
   * chain is asked first. An account that holds coins is the funded panel, with no desk needed; anything else leaves Try again, which sends the same key again.
   */
  async function recover() {
    const held = key;
    try {
      if ((await rpc.nonce(held.accountId, held.publicKey)) === null) return;
      const coins = parseU128(await rpc.view(token, "ft_balance_of", { account_id: held.accountId }), "wallet");
      if (coins > 0n && key === held && !held.funded) await granted([], "This browser already had a test account with coins in it, so it is open again. The numbers above are read from the chain.");
    } catch {
      // The chain could not be read: the panel stays as it is.
    }
  }

  /** The faucet's 200: the account the desk made must be this key's own, and the transactions must be real hashes. */
  const grantedTxs = (body) => (isObj(body) && body.account_id === key.accountId && Array.isArray(body.txs) ? body.txs.filter(isTxHash).slice(0, 5) : null);

  const granted = (txs, title, tone = "ok") => {
    key.funded = true;
    save();
    closed = null;
    account = null;
    result = { tone, title, contract: null, tx: null, extra: txs.length === 0 ? null : h(doc, "p", { class: "or-tx" }, txs.length === 1 ? "The faucet's transaction: " : "The faucet's transactions: ", txs.flatMap((t, i) => [i === 0 ? "" : " ", txLink(doc, explorer, t)])) };
    shown = null;
    watch();
    return settle((a) => a.wallet > 0n); // the grant's last step may not show on the first read
  };

  async function getCoins() {
    if (creating || supported !== true || key?.funded === true) return;
    creating = true;
    closed = null;
    render();
    try {
      if (key === null) {
        const made = await generateKey(subtle);
        key = { secret: secretKeyText(made), funded: false, accountId: implicitAccountId(made.publicKey), publicKey: publicKeyText(made.publicKey) };
        save();
      }
      const res = await request("/faucet", () => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ public_key: key.publicKey }), credentials: "omit", signal: AbortSignal.timeout(120_000) }));
      const body = await res.json().catch(() => null);
      if (res.status === 200 && grantedTxs(body) !== null) {
        creating = false;
        return await granted(grantedTxs(body), "Your account is made and the faucet has sent its test coins. The numbers above are read from the chain.");
      }
      if (res.status === 409) {
        // The account exists but this faucet never funded it: the key is no use here, so it is forgotten and the next press makes another.
        forget();
        closed = { kind: "taken", untilMs: null, words: null };
        return;
      }
      if (res.status === 502) {
        // The faucet stopped part way. Sending the same key again resumes it (or returns what it already recorded), so the key is kept and the button says Try again.
        closed = { kind: "retry", untilMs: null, words: isObj(body) && typeof body.error === "string" ? safeText(body.error, 160) : null };
        return;
      }
      const refusal = parseRefusal(res.status, body);
      closed = { kind: refusal.kind, untilMs: refusal.wait === null ? null : now() + refusal.wait * 1000, words: refusal.words };
      if (refusal.kind === "bad") forget(); // the desk did not take this key: the next press makes another
      if (BLOCKS.has(refusal.kind)) retryLater();
    } catch {
      closed = { kind: "down", untilMs: null, words: null };
      retryLater();
    } finally {
      creating = false;
      render();
      if (key !== null && !key.funded) void recover(); // a press that did not end in coins may still have left some
    }
  }

  get.addEventListener("click", () => void getCoins());
  for (const [name, el] of Object.entries({ stake, unstake, claim, send })) el.addEventListener("click", () => void act(name));
  for (const el of [amount, receiver]) el.addEventListener("input", render);
  keyButton.addEventListener("click", () => {
    revealed = !revealed;
    render();
  });

  render();
  (async () => {
    supported = await canEd25519(subtle);
    if (key?.funded === true) {
      watch();
      await readAccount();
    } else {
      if (key !== null) void recover();
      await check();
    }
    render();
  })();
  return {
    getCoins,
    act,
    check,
    readAccount,
    /** The page's chain read changed: the supply behind "0.005% of the supply" may now be known. */
    refresh: render,
    stop: () => {
      for (const t of [ticker, retry]) if (t !== null) timers.clear(t);
      ticker = retry = null;
    },
    state: () => ({ ...snapshot(), epochMs }),
    elements: { get, stake, unstake, claim, send, amount, receiver, keyButton },
  };
}
