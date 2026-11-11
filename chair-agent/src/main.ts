#!/usr/bin/env node
import { main } from "./cli.js";

const ac = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => ac.abort());

process.exitCode = await main(process.argv.slice(2), process.env, {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
}, { signal: ac.signal });
