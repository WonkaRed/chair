// The press conference panel: offline in voice, ask then wait then entered, own questions kept in this browser, and every string from
// the desk inert. The desk is a real local server (fake-press.mjs) for the main path; the failures are injected at the fetch boundary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeDoc, host, walk } from "./fakedom.mjs";
import { startFakePress } from "./fake-press.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const { createPress, deskBase, DESK_NOTE, OFFLINE, POLL_MS } = await import(join(root, "site", "js", "press.js"));

const EXPLORER = "https://example.invalid";
const DISCOVERY = "https://gist.example.invalid/raw/chair-press.json";
const DESK = "https://quiet-harbor-minutes.trycloudflare.com";
const DESK_B = "https://other-tunnel-words.trycloudflare.com";
const TX = "5".repeat(44);
const EVIL = "<img src=x onerror=alert(1)>\u202e\u2066\u200b\u0007 <script>alert(1)</script>";
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;
const FORBIDDEN = new Set(["script", "img", "iframe", "style", "object", "embed", "link"]);

function assertInert(root, label) {
  for (const n of walk(root)) {
    if (n.data !== undefined) {
      assert.equal(HIDDEN.test(n.data), false, `${label}: raw control, bidi or invisible character in ${JSON.stringify(n.data.slice(0, 50))}`);
      continue;
    }
    assert.equal(FORBIDDEN.has(n.tag), false, `${label}: element <${n.tag}>`);
    for (const [k, v] of Object.entries(n.attrs)) {
      assert.equal(/^on/i.test(k), false, `${label}: attribute ${k}`);
      if (k === "href") assert.match(v, /^https:\/\/example\.invalid\/txns\/[1-9A-HJ-NP-Za-km-z]{32,44}$/, `${label}: href`);
    }
  }
}

const memory = () => {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), data: m };
};
/** Timers that run only when the test says so; `queue` is what is waiting. */
const manual = () => {
  const queue = [];
  return {
    queue,
    set: (f, ms) => { queue.push({ f, ms }); return queue.length; },
    clear: () => queue.splice(0),
    tick: async () => { const t = queue.shift(); await t.f(); },
  };
};
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
/** The discovery document as a fetch boundary: `doc.url` is what it names now; other requests go to `onDesk(url, init)`. `seen` lists every URL asked for. */
const routed = (onDesk, doc = { url: DESK }, seen = []) => async (u, init) => {
  seen.push(u);
  if (u.startsWith(DISCOVERY)) return typeof doc.fail === "function" ? doc.fail() : { ok: true, status: 200, json: async () => ({ url: doc.url, updated_at_ms: 1 }) };
  return onDesk(u, init);
};
/** The real fake desk behind a made-up quick-tunnel name: its own discovery document, and every name under DESK or DESK_B mapped onto its loopback port. */
const viaFake = (fake, name = DESK) => {
  fake.state.advertise = name;
  return async (u, init) => fetch(u.startsWith(DISCOVERY) ? `${fake.url}/chair-press.json` : u.replace(/^https:\/\/[a-z-]+\.trycloudflare\.com/, fake.url), init);
};
const clock = (t = 1_000_000) => Object.assign(() => t, { advance: (ms) => (t += ms) });
const text = (n) => n.textContent;
const find = (root, pred) => [...walk(root)].find(pred);
const make = async (opts) => {
  const doc = fakeDoc();
  const root = host(doc);
  const timers = opts.timers ?? manual();
  const press = createPress(doc, root, { explorer: EXPLORER, storage: memory(), timers, ...opts });
  await press.refresh();
  return { root, press, timers, doc };
};
const button = (root) => find(root, (n) => n.tag === "button" && n.attrs.type === "submit");
const claim = (root, cls) => find(root, (n) => n.attrs?.class?.split(" ").includes(cls));

test("no press desk configured: the page says the Chair is not taking questions, says where the desk runs, disables the form, and never touches the network", async () => {
  let calls = 0;
  const { root, press, timers } = await make({ discoveryUrl: "", fetchImpl: async () => { calls++; throw new Error("no network"); } });
  assert.match(text(root), new RegExp(OFFLINE.replace(".", "\\.")));
  assert.ok(text(root).includes(DESK_NOTE) && /my workstation/.test(DESK_NOTE));
  assert.equal(button(root).disabled, true);
  assert.equal(press.input.disabled, true);
  assert.equal(find(root, (n) => n.tag === "button" && /Check again/.test(text(n))), undefined, "nothing to check again");
  await press.ask("Does the Chair intend to remain the Chair?");
  assert.equal(calls, 0);
  assert.equal(timers.queue.length, 0);
  assert.equal(find(root, (n) => n.tag === "h3"), undefined, "no record section without a record");
});

test("an unreachable or unreadable desk is the same honest offline state, and Check again reopens it when the desk comes back", async () => {
  for (const fetchImpl of [async () => { throw new TypeError("Failed to fetch"); }, reply(500, { error: "x" }), reply(200, { entries: "nope" }), reply(200, { taking_questions: "yes", entries: [] }), async () => ({ ok: true, json: async () => { throw new SyntaxError("bad"); } })]) {
    const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(fetchImpl) });
    assert.ok(text(root).includes(OFFLINE) && text(root).includes(DESK_NOTE));
    assert.equal(press.state().online, false);
  }
  let up = false;
  const fetchImpl = async (u) => (up ? reply(200, { taking_questions: true, entries: [] })() : Promise.reject(new TypeError("down")));
  const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(fetchImpl) });
  const again = find(root, (n) => n.tag === "button" && /Check again/.test(text(n)));
  assert.ok(again);
  up = true;
  again.listeners.click[0]();
  await press.refresh();
  assert.ok(!text(root).includes(OFFLINE));
  assert.equal(button(root).disabled, false);
});

test("a desk that says it is not taking questions closes the form but still shows the record", async () => {
  const entry = { id: "a1", question_hash: "ab".repeat(32), answer: "The Chair notes the matter.", asked_at_ms: 1_700_000_000_000, epoch: 12, tx_hash: TX };
  const { root } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(reply(200, { taking_questions: false, entries: [entry] })) });
  assert.ok(text(root).includes(OFFLINE));
  assert.equal(button(root).disabled, true);
  assert.ok(text(root).includes("The Chair notes the matter."));
});

test("asking: the answer is quoted, the status reads Awaiting entry, then Entered into the record with the epoch and a transaction link; polling stops once nothing is pending", async () => {
  const desk = await startFakePress({ entryDelayMs: 60_000, firstEpoch: 777 });
  try {
    const timers = manual();
    const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: viaFake(desk), timers });
    assert.equal(timers.queue.length, 0, "no polling before anything is pending");
    assert.equal(button(root).disabled, false);
    const q = "Does the Chair intend to remain the Chair?";
    await press.ask(q);
    const answer = claim(root, "answer");
    assert.equal(answer.tag, "blockquote");
    assert.ok(text(answer).startsWith("The Committee of One has met"));
    assert.ok(text(claim(root, "asked")).includes(q), "the visitor's own question is shown with its answer");
    assert.equal(text(claim(root, "entry")), "Awaiting entry into the minutes");
    assert.deepEqual(timers.queue.map((t) => t.ms), [POLL_MS], "polls every 15 s while pending");

    await timers.tick();
    assert.equal(text(claim(root, "entry")), "Awaiting entry into the minutes", "the desk has not entered it yet");
    assert.equal(timers.queue.length, 1, "still pending, so it polls again");

    desk.state.entries[0].epoch = 777;
    desk.state.entries[0].tx_hash = TX;
    await timers.tick();
    assert.equal(text(claim(root, "entry")), "Entered into the record, epoch 777. See the transaction");
    assert.equal(find(claim(root, "entry"), (n) => n.tag === "a").attrs.href, `${EXPLORER}/txns/${TX}`);
    assert.equal(timers.queue.length, 0, "nothing pending, so the polling stopped");
    assert.equal(press.state().pollScheduled, false);
    assertInert(root, "entered");
  } finally {
    await desk.close();
  }
});

test("the public record shows three answers and a Show more button that reveals the rest in place", async () => {
  const desk = await startFakePress({ entryDelayMs: 0, firstEpoch: 1, seed: 5 });
  try {
    const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: viaFake(desk) });
    const rows = () => [...walk(root)].filter((n) => n.attrs?.class === "rec");
    assert.equal(rows().length, 5);
    assert.deepEqual(rows().map((r) => r.hidden), [false, false, false, true, true]);
    const more = find(root, (n) => n.tag === "button" && /^Show 2 more$/.test(text(n)));
    assert.ok(more, "the button says how many are folded");
    for (const fn of more.listeners.click) fn();
    assert.equal(rows().every((r) => r.hidden === false), true);
    assert.equal(find(root, (n) => n.tag === "button" && /^Show \d+ more$/.test(text(n))), undefined, "nothing left to show");
    press.stop();
  } finally {
    await desk.close();
  }
});

test("the visitor's questions stay in this browser, keyed by id: a reload shows the question again, and the public record shows it only on the visitor's own entries", async () => {
  const desk = await startFakePress({ entryDelayMs: 0, firstEpoch: 1, seed: 2 });
  try {
    const storage = memory();
    const first = await make({ discoveryUrl: DISCOVERY, fetchImpl: viaFake(desk), storage });
    await first.press.ask("Is the Chair comfortable?");
    await first.press.ask("Does the Chair take questions?");
    first.press.stop();
    const stored = JSON.parse(storage.data.get("chair-press-questions"));
    assert.deepEqual(stored.map((e) => e.q), ["Does the Chair take questions?", "Is the Chair comfortable?"]);
    assert.ok(stored.every((e) => typeof e.id === "string" && !("question" in e)));

    await new Promise((r) => setTimeout(r, 10));
    const again = await make({ discoveryUrl: DISCOVERY, fetchImpl: viaFake(desk), storage });
    const page = text(again.root);
    assert.ok(page.includes("Is the Chair comfortable?") && page.includes("Does the Chair take questions?"));
    assert.equal(text(claim(again.root, "entry")).startsWith("Entered into the record, epoch"), true);
    const rows = [...walk(again.root)].filter((n) => n.attrs?.class === "rec");
    assert.equal(rows.length, 3, "two seeded answers and the earlier own entry; the latest own sits in the exchange above");
    assert.equal(rows.filter((r) => text(r).includes("You asked")).length, 1, "only the visitor's own entry shows a question");
    assert.ok(rows.every((r) => /Question [0-9a-f]{8}/.test(text(r))), "every entry carries its question-hash prefix");
    assert.ok(rows.every((r) => find(r, (n) => n.tag === "a" && /^https:\/\/example\.invalid\/txns\//.test(n.attrs.href))), "and its epoch link");
    assert.ok(rows.every((r) => !text(r).includes("seed ")), "the record never shows a question it was not given");
  } finally {
    await desk.close();
  }
});

test("a question that is empty or over 140 characters is stopped before it is sent; the desk's own refusals are said in voice", async () => {
  const sent = [];
  let next = reply(429, { error: "slow down" });
  const fetchImpl = async (u, init) => {
    if (init?.method === "POST") { sent.push(JSON.parse(init.body)); return next(); }
    return reply(200, { taking_questions: true, entries: [] })();
  };
  const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(fetchImpl) });
  const note = () => text(claim(root, "form-note"));
  await press.ask("   ");
  assert.match(note(), /Write a question first/);
  await press.ask("x".repeat(141));
  assert.match(note(), /140 characters at most/);
  assert.equal(sent.length, 0);
  assert.equal(find(root, (n) => n.tag === "textarea").attrs.maxlength, "140");
  await press.ask("x".repeat(140));
  assert.deepEqual(sent[0], { question: "x".repeat(140) });
  assert.match(note(), /taken enough questions/);
  next = reply(400, { error: EVIL });
  await press.ask("fine");
  assert.match(note(), /not accepted: <img src=x onerror=alert\(1\)>\\u\{202e\}/);
  assertInert(root, "400");
  next = reply(200, { id: "x", answer: 5 });
  await press.ask("fine");
  assert.match(note(), /cannot read/);
  next = reply(503, { error: "closed" });
  await press.ask("fine");
  assert.ok(text(root).includes(OFFLINE), "503 closes the desk");
  assert.equal(press.state().own.length, 0, "nothing was entered, so nothing is remembered");
});

test("a 503 that says the press room is full is not a closed desk: the form stays open and the visitor is told to ask again shortly", async () => {
  let next = reply(503, { error: "the press room is full; try again shortly", code: "press_full" });
  const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed((u, init) => (init?.method === "POST" ? next() : OPEN())) });
  await press.ask("fine");
  assert.match(text(root), /press room is full\. Ask again in a minute/);
  assert.equal(text(root).includes(OFFLINE), false, "the desk is still open");
  assert.equal(press.state().online, true);
  assert.equal(press.state().own.length, 0);
  next = reply(503, { error: "the Chair is not taking questions right now", code: "desk_closed" });
  await press.ask("fine");
  assert.ok(text(root).includes(OFFLINE), "a closed desk still closes the form");
});

test("a desk that does not answer in time, or whose tunnel answers 5xx, is not said to have entered nothing: it may still answer, and the record below then shows it", async () => {
  const late = /The desk did not answer in time\. If it does, the answer will appear in the record below\./;
  const cases = [
    ["a timeout", async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, late],
    ["a tunnel's 502", reply(502, { error: "bad gateway" }), late],
    ["a tunnel's 524", reply(524, null), late],
    ["a reply that cannot be read", reply(200, { id: "x", answer: 5 }), /If the question was answered, the answer will appear in the record below/],
    ["a refusal is still a refusal", reply(400, { error: "the question must be 1 to 140 characters" }), /not accepted/],
  ];
  for (const [why, next, expected] of cases) {
    const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed((u, init) => (init?.method === "POST" ? next() : OPEN())) });
    await press.ask("fine");
    assert.match(text(root), expected, why);
    assert.equal(text(root).includes("Nothing was entered"), false, why);
  }
});

test("text from the desk and from the visitor is never put in as HTML: answers, hashes and questions reach the page as inert text", async () => {
  const entry = { id: "e1", question_hash: EVIL, answer: EVIL, asked_at_ms: 1_700_000_000_000, epoch: 9, tx_hash: TX };
  const bad = [{ ...entry, id: "e2", tx_hash: EVIL }, { ...entry, id: "e3", answer: 5 }, { ...entry, id: EVIL }, "x", null, { ...entry, id: "e4", asked_at_ms: "now" }];
  const fetchImpl = async (u, init) => (init?.method === "POST"
    ? reply(200, { id: "own1", answer: EVIL, question_hash: EVIL, asked_at_ms: Date.now(), status: "answered" })()
    : reply(200, { taking_questions: true, entries: [entry, ...bad] })());
  const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(fetchImpl) });
  await press.ask(`<b>${EVIL}`.slice(0, 140));
  assertInert(root, "hostile");
  const page = text(root);
  assert.match(page, /<img src=x onerror=alert\(1\)>\\u\{202e\}/, "markup is shown as text, controls as escapes");
  assert.equal(press.state().entries.length, 2, "malformed entries are dropped; a tx_hash that is not one makes an entry pending, never entered");
  assert.equal([...walk(root)].filter((n) => n.attrs?.class === "wait").length, 1);
  const html = [...walk(root)].filter((n) => n.tag && !["div", "p", "span", "blockquote", "ol", "li", "article", "h3", "code", "form", "label", "textarea", "button", "a"].includes(n.tag));
  assert.deepEqual(html.map((n) => n.tag), [], "only the panel's own elements exist");
});

const OPEN = reply(200, { taking_questions: true, entries: [] });
const ANSWERED = reply(200, { id: "q1", answer: "The Chair has noted the question.", question_hash: "cd".repeat(32), asked_at_ms: 1_700_000_000_000, status: "answered" });
const onDesk = (name) => async (u, init) => (u.startsWith(name) ? (init?.method === "POST" ? ANSWERED() : OPEN()) : Promise.reject(new TypeError("Failed to fetch")));

test("discovery: the page reads the discovery document with a cache-busting query, then talks to the address it names, through the real fake desk", async () => {
  const fake = await startFakePress({ firstEpoch: 5, seed: 1 });
  try {
    const seen = [];
    const fetchImpl = viaFake(fake);
    const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: async (u, i) => (seen.push(u), fetchImpl(u, i)), now: clock(1_234_567) });
    assert.equal(seen[0], `${DISCOVERY}?t=1234567`);
    assert.equal(seen[1], `${DESK}/record?limit=50`);
    assert.equal(press.state().desk, DESK);
    assert.equal(press.state().online, true);
    assert.equal(button(root).disabled, false);
    assert.equal(press.state().entries.length, 1);
    await press.ask("Does the Chair take questions?");
    assert.equal(press.state().own.length, 1, "asked through the discovered address");
  } finally {
    await fake.close();
  }
});

test("discovery: a document with no address (the desk has never been up) is the offline state, and the page asks again no faster than every 15 s until the desk appears", async () => {
  const doc = { url: "" };
  const seen = [];
  const now = clock();
  const { root, press, timers } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(onDesk(DESK), doc, seen), timers: manual(), now });
  assert.ok(text(root).includes(OFFLINE) && text(root).includes(DESK_NOTE));
  assert.equal(button(root).disabled, true);
  assert.equal(seen.length, 1, "one discovery request and nothing sent to any desk");
  assert.deepEqual(timers.queue.map((t) => t.ms), [POLL_MS], "keeps trying by itself while offline");

  now.advance(POLL_MS - 1); // a tick that fires early still must not hit the document again
  await timers.tick();
  assert.equal(seen.length, 1, "no faster than every 15 s");
  assert.equal(timers.queue.length, 1);

  doc.url = DESK; // the desk comes up and the script rewrites the document
  now.advance(5);
  await timers.tick();
  assert.equal(press.state().online, true);
  assert.ok(!text(root).includes(OFFLINE));
  assert.equal(button(root).disabled, false);
  assert.equal(timers.queue.length, 0, "back online with nothing pending: no more polling");
});

test("discovery: an address that is not exactly a quick-tunnel origin is refused, and nothing is ever sent to it", async () => {
  const good = ["https://quiet-harbor-minutes.trycloudflare.com", "https://a.trycloudflare.com/", "https://a.b-c.trycloudflare.com"];
  assert.deepEqual(good.map(deskBase), ["https://quiet-harbor-minutes.trycloudflare.com", "https://a.trycloudflare.com", "https://a.b-c.trycloudflare.com"]);
  const hostile = [
    "http://x.trycloudflare.com", "https://trycloudflare.com", "https://x.trycloudflare.com.evil.example", "https://evil.example/x.trycloudflare.com",
    "https://user:pw@x.trycloudflare.com", "https://x.trycloudflare.com@evil.example", "https://x.trycloudflare.com:8443", "https://x.trycloudflare.com/path",
    "https://x.trycloudflare.com/?a=1", "https://x.trycloudflare.com#f", "https://x.trycloudflare.com\\@evil.example", "https://x.trycloudflare.com ", "https://-x-.evil.example",
    "javascript:alert(1)", "//x.trycloudflare.com", "x.trycloudflare.com", "https://evil.example", "https://x.trycloudflare.com.", "https://x\u202e.trycloudflare.com", "", " ", "https://" + "a".repeat(250) + ".trycloudflare.com",
    5, null, undefined, {}, ["https://x.trycloudflare.com"],
  ];
  for (const url of hostile) assert.equal(deskBase(url), "", JSON.stringify(url));
  for (const url of hostile) {
    const seen = [];
    const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(onDesk("https://"), { url }, seen) });
    assert.ok(text(root).includes(OFFLINE), JSON.stringify(url));
    assert.equal(press.state().desk, "");
    assert.deepEqual(seen.filter((u) => !u.startsWith(DISCOVERY)), [], `nothing sent to ${JSON.stringify(url)}`);
  }
  for (const body of [null, "x", [], { url: 5 }, { nope: 1 }]) {
    const { root } = await make({ discoveryUrl: DISCOVERY, fetchImpl: async (u) => (u.startsWith(DISCOVERY) ? { ok: true, status: 200, json: async () => body } : OPEN()) });
    assert.ok(text(root).includes(OFFLINE), `document ${JSON.stringify(body)}`);
  }
  const { root } = await make({ discoveryUrl: DISCOVERY, fetchImpl: routed(OPEN, { fail: () => Promise.reject(new TypeError("Failed to fetch")) }) });
  assert.ok(text(root).includes(OFFLINE), "an unreachable document is offline");
  assertInert(root, "offline");
});

test("a desk that does not connect makes the page read the document once more and retry only if the address changed; otherwise it stays offline", async () => {
  // Changed address: A is down, the document now names B.
  const doc = { url: DESK };
  const seen = [];
  const down = new Set();
  const fetchImpl = routed(async (u) => (down.has(new URL(u).origin) ? Promise.reject(new TypeError("Failed to fetch")) : OPEN()), doc, seen);
  const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl, timers: manual(), now: clock() });
  assert.equal(press.state().desk, DESK);
  down.add(DESK);
  doc.url = DESK_B;
  seen.length = 0;
  await press.refresh();
  assert.deepEqual(seen.map((u) => u.replace(/\?t=\d+/, "?t=")), [`${DESK}/record?limit=50`, `${DISCOVERY}?t=`, `${DESK_B}/record?limit=50`], "failed, looked again once, retried on the new address");
  assert.equal(press.state().desk, DESK_B);
  assert.equal(press.state().online, true);
  assert.ok(!text(root).includes(OFFLINE));

  // Same address, still down: one more look at the document, no retry, offline.
  down.add(DESK_B);
  seen.length = 0;
  await press.refresh();
  assert.deepEqual(seen.map((u) => u.replace(/\?t=\d+/, "?t=")), [`${DESK_B}/record?limit=50`, `${DISCOVERY}?t=`]);
  assert.equal(press.state().online, false);
  assert.ok(text(root).includes(OFFLINE));

  // A tunnel that answers with a server error (not the desk's own 503) is treated the same way.
  down.clear();
  doc.url = DESK;
  const errs = [];
  const f2 = routed(async (u) => (u.startsWith(DESK_B) ? reply(530, { error: "tunnel" })() : OPEN()), { url: DESK_B }, errs);
  const second = await make({ discoveryUrl: DISCOVERY, fetchImpl: f2, now: clock() });
  assert.equal(second.press.state().online, false);
  assert.equal(errs.filter((u) => u.startsWith(DISCOVERY)).length, 2, "the server error triggered one more look");
});

test("the desk's address changing during a session: asking after a restart finds the new desk, and a desk that says 503 is closed, not re-discovered", async () => {
  const doc = { url: DESK };
  const seen = [];
  const down = new Set();
  const fetchImpl = routed(async (u, init) => (down.has(new URL(u).origin) ? Promise.reject(new TypeError("Failed to fetch")) : init?.method === "POST" ? ANSWERED() : OPEN()), doc, seen);
  const { root, press } = await make({ discoveryUrl: DISCOVERY, fetchImpl, timers: manual(), now: clock() });
  down.add(DESK); // the desk restarts behind a new tunnel
  doc.url = DESK_B;
  await press.ask("Does the Chair take questions?");
  assert.equal(press.state().desk, DESK_B);
  assert.equal(press.state().own.length, 1, "the question went to the new desk, once");
  assert.equal(seen.filter((u) => u === `${DESK_B}/ask`).length, 1);
  assert.equal(seen.filter((u) => u === `${DESK}/ask`).length, 1, "the dead address was tried once");
  assert.ok(text(root).includes("Awaiting entry into the minutes"));

  const before = seen.filter((u) => u.startsWith(DISCOVERY)).length;
  const closed = routed(reply(503, { error: "not taking questions" }), { url: DESK }, seen);
  const shut = await make({ discoveryUrl: DISCOVERY, fetchImpl: closed });
  assert.ok(text(shut.root).includes(OFFLINE));
  assert.equal(seen.filter((u) => u.startsWith(DISCOVERY)).length, before + 1, "503 is the desk's own word: no second look at the document");
});

test("while the desk is shut or unreachable the page keeps checking by itself, pauses while the tab is hidden, and the form comes back when the desk does", async () => {
  const doc = { url: DESK };
  let up = false;
  const fetchImpl = routed(async () => (up ? OPEN() : Promise.reject(new TypeError("Failed to fetch"))), doc);
  const now = clock();
  const d = fakeDoc();
  const rootNode = host(d);
  const timers = manual();
  const press = createPress(d, rootNode, { discoveryUrl: DISCOVERY, explorer: EXPLORER, storage: memory(), timers, fetchImpl, now });
  await press.refresh();
  assert.equal(press.state().online, false);
  assert.equal(timers.queue.length, 1);
  d.hidden = true;
  await timers.tick();
  assert.equal(timers.queue.length, 1, "re-armed, but nothing fetched while hidden");
  d.hidden = false;
  up = true;
  now.advance(POLL_MS);
  await timers.tick();
  assert.equal(press.state().online, true);
  assert.equal(button(rootNode).disabled, false);
  assert.equal(timers.queue.length, 0);
});
