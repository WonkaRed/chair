import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { toJson } from "./export.js";
import { SCENARIOS } from "./scenarios.js";
import { run } from "./sim.js";
import { renderTable } from "./table.js";

const USAGE = "usage: node dist/src/main.js [--all] [--out <file.json>]";
const defaultOut = join(import.meta.dirname, "..", "..", "out", "scenarios.json");

function parseArgs(argv: readonly string[]): { all: boolean; out: string } {
  let all = false;
  let out = defaultOut;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") all = true;
    else if (a === "--out" && argv[i + 1] !== undefined) out = resolve(argv[++i]!);
    else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  return { all, out };
}

try {
  const { all, out } = parseArgs(process.argv.slice(2));
  const results = SCENARIOS.map(run);
  console.log(results.map((r) => renderTable(r, all)).join("\n\n"));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(toJson(results), null, 2)}\n`);
  console.log(`\nwrote ${out}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
}
