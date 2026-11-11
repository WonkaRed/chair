// A local pass-through to the Anthropic API that records only what a call cost. The chair agent logs decisions but not
// token usage; pointing it here (ANTHROPIC_BASE_URL=http://127.0.0.1:<port>) measures the spend without changing the agent.
//
//   node tools/llm-usage-proxy.mjs [--port 8788] [--max-calls 5] [--max-usd 0.5]
//
// It forwards each request unchanged, so the API key travels in the caller's header and is never read, stored or printed
// here. It prints one line per call (status, model, token counts, dollars) and refuses further calls once a cap is reached.
// Prices are USD per million tokens, Claude Sonnet 5.5 (the model the agent names): input 2.00, output 10.00, cache read 0.10.

import { createServer } from "node:http";
import { parseArgs } from "node:util";

const UPSTREAM = "https://api.anthropic.com";
const PRICE = { input: 2.0, output: 10.0, cacheRead: 0.1 };

const { values } = parseArgs({ options: { port: { type: "string", default: "8788" }, "max-calls": { type: "string", default: "5" }, "max-usd": { type: "string", default: "0.5" } } });
const maxCalls = Number(values["max-calls"]);
const maxUsd = Number(values["max-usd"]);
let calls = 0;
let usd = 0;

const dollars = (u) => ((u.input_tokens ?? 0) * PRICE.input + (u.output_tokens ?? 0) * PRICE.output + (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead) / 1e6;

createServer(async (req, res) => {
  if (calls >= maxCalls || usd >= maxUsd) {
    console.log(`refused: cap reached (${calls} calls, $${usd.toFixed(6)})`);
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "usage proxy cap reached" } }));
    return;
  }
  calls += 1;
  const body = Buffer.concat(await req.toArray());
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["host", "content-length", "accept-encoding", "connection"].includes(k)));
  const up = await fetch(UPSTREAM + req.url, { method: req.method, headers, body: body.length > 0 ? body : undefined });
  const text = await up.text();
  let line = `call ${calls}: HTTP ${up.status}`;
  try {
    const j = JSON.parse(text);
    if (j.usage) {
      usd += dollars(j.usage);
      line += ` ${j.model} input ${j.usage.input_tokens} output ${j.usage.output_tokens} cache_read ${j.usage.cache_read_input_tokens ?? 0} stop ${j.stop_reason}; $${dollars(j.usage).toFixed(6)}, total $${usd.toFixed(6)}`;
    }
  } catch {
    line += " (body not JSON)";
  }
  console.log(line);
  res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" }).end(text);
}).listen(Number(values.port), "127.0.0.1", () => console.log(`usage proxy on 127.0.0.1:${values.port}, caps ${maxCalls} calls / $${maxUsd}`));
