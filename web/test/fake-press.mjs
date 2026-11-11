// A stand-in for the press desk (POST /ask, GET /record), for the page's tests and for viewing it locally before the real desk is up:
//   node test/fake-press.mjs 18950 [entryDelayMs]      with three entries already in the record; it also serves the discovery document at /chair-press.json.
// The page accepts only an https name under trycloudflare.com, so it cannot be pointed at this loopback server directly: the tests map a made-up
// trycloudflare.com name onto it at the fetch boundary, and a browser check can route that name to it (Playwright `page.route`).
// Its answers are canned and its transaction hashes are made up (they link to nothing real). The real desk's contract is the one in the brief:
// /ask takes {"question"} of 1 to 140 characters and returns the answer; /record lists answers with a question hash, never the question.
import { createServer } from "node:http";
import { createHash, randomInt } from "node:crypto";
import { fileURLToPath } from "node:url";

const ANSWERS = [
  "The Committee of One has met on the question. The Chair has seen the numbers and remains the Chair. The motion to take no further questions on the matter carries unanimously.",
  "The Chair thanks the questioner for the question. The Chair holds the view it held before the question. The Chair asks that this be recorded.",
  "The Chair declines to be drawn. The rate stays inside the corridor, as it must. The Chair has no further comment.",
];
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeTx = () => Array.from({ length: 44 }, () => B58[randomInt(B58.length)]).join("");

/** `{url, close, state}`; `state.taking` flips the desk open or shut, `state.entries` is the record, `state.limitAsk` makes /ask answer 429,
 *  `state.advertise` is the address the discovery document names (`null`: this server's own, `""`: no desk has been up). */
export async function startFakePress({ port = 0, entryDelayMs = 20_000, firstEpoch = 500, seed = 0 } = {}) {
  const state = { taking: true, limitAsk: false, advertise: null, entries: [], epoch: firstEpoch };
  for (let i = 0; i < seed; i++) state.entries.push({ id: `seed-${i}`, question_hash: createHash("sha256").update(`seed ${i}`).digest("hex"), answer: ANSWERS[i % ANSWERS.length], asked_at_ms: Date.now() - (i + 1) * 90_000, epoch: firstEpoch + seed - 1 - i, tx_hash: fakeTx() });
  state.epoch = firstEpoch + seed;
  const timers = new Set();
  const send = (res, code, body) => res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "GET, POST, OPTIONS" }).end(JSON.stringify(body));
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.method === "GET" && u.pathname === "/chair-press.json") return send(res, 200, { url: state.advertise ?? `http://127.0.0.1:${server.address().port}`, updated_at_ms: Date.now() });
    if (req.method === "GET" && u.pathname === "/record") {
      const limit = Math.max(1, Math.min(200, Number(u.searchParams.get("limit")) || 20));
      return send(res, 200, { taking_questions: state.taking, entries: state.entries.slice(0, limit).map((e) => ({ ...e })) });
    }
    if (req.method === "POST" && u.pathname === "/ask") {
      if (!state.taking) return send(res, 503, { error: "not taking questions" });
      if (state.limitAsk) return send(res, 429, { error: "slow down" });
      let q;
      try {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        q = JSON.parse(raw).question;
      } catch {
        return send(res, 400, { error: "body must be JSON with a question" });
      }
      if (typeof q !== "string" || q.length < 1 || q.length > 140) return send(res, 400, { error: "question must be 1 to 140 characters" });
      const entry = { id: `q${state.entries.length + 1}-${Date.now().toString(36)}`, question_hash: createHash("sha256").update(q).digest("hex"), answer: ANSWERS[state.entries.length % ANSWERS.length], asked_at_ms: Date.now(), epoch: null, tx_hash: null };
      state.entries.unshift(entry);
      const t = setTimeout(() => { timers.delete(t); entry.epoch = state.epoch++; entry.tx_hash = fakeTx(); }, entryDelayMs);
      timers.add(t);
      return send(res, 200, { id: entry.id, answer: entry.answer, question_hash: entry.question_hash, asked_at_ms: entry.asked_at_ms, status: "answered" });
    }
    send(res, 404, { error: "not found" });
  });
  await new Promise((ok) => server.listen(port, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    close: () => new Promise((ok) => { for (const t of timers) clearTimeout(t); server.close(ok); server.closeAllConnections(); }),
  };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  const desk = await startFakePress({ port: Number(process.argv[2] ?? 18950), entryDelayMs: Number(process.argv[3] ?? 20_000), seed: 3 });
  console.log(`fake press desk at ${desk.url}`);
}
