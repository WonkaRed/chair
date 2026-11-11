// node src/cli.ts <command>. Testnet only: an RPC that does not report chain_id "testnet" and an account id that
// does not end in .testnet are both refused before anything is sent (guard.ts, rpc.ts).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createParent, deployAll, newRecord, sha256Hex } from "./deploy.ts";
import { testnetAccount } from "./guard.ts";
import { KeyStore } from "./keys.ts";
import { describeMinutes } from "./minutes.ts";
import { loadRecord, saveRecord } from "./record.ts";
import { Run } from "./run.ts";
import { DEFAULT_RPC, Rpc } from "./rpc.ts";
import { runScenario } from "./scenario.ts";
import { describeState, evaluate, gather } from "./verify.ts";

const DOCS = resolve(import.meta.dirname, "..", "..", "docs");
const DEFAULT_RECORD = resolve(DOCS, "testnet-deployment.json");

const USAGE = `usage: node src/cli.ts <command> [options]
  bootstrap --parent <name.testnet>                 the faucet creates the parent account (10 NEAR); its key goes in the key directory
  deploy    --parent <name.testnet> --wasm <file>   create every account and launch the token (resumable)
  scenario                                          the scripted run on chain (resumable)
  verify    [--wasm <file>]                         re-check the deployment from public views; needs no key
options: --record <file> (default docs/testnet-deployment.json)  --rpc <url> (default ${DEFAULT_RPC})  --keys <dir> (default $CHAIR_TESTNET_KEYS or ~/.config/chair-testnet-keys)`;

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { parent: { type: "string" }, wasm: { type: "string" }, record: { type: "string" }, rpc: { type: "string" }, keys: { type: "string" } },
  });
  const [command, ...extra] = positionals;
  if (extra.length > 0 || command === undefined) {
    console.error(USAGE);
    return 2;
  }
  const recordPath = resolve(values.record ?? DEFAULT_RECORD);
  const say = (line: string): void => console.log(line);
  const wasm = values.wasm === undefined ? null : readFileSync(resolve(values.wasm));

  switch (command) {
    case "bootstrap": {
      if (values.parent === undefined) throw new Error("--parent is required");
      const rpc = await Rpc.connect(values.rpc ?? DEFAULT_RPC);
      await createParent(rpc, new KeyStore(values.keys), testnetAccount(values.parent), say);
      return 0;
    }
    case "deploy": {
      if (wasm === null) throw new Error("--wasm is required");
      const rpc = await Rpc.connect(values.rpc ?? DEFAULT_RPC);
      const keys = new KeyStore(values.keys);
      if (!existsSync(recordPath)) {
        if (values.parent === undefined) throw new Error("--parent is required for a new deployment");
        saveRecord(recordPath, await newRecord(rpc.url, keys, testnetAccount(values.parent), wasm));
      }
      const record = loadRecord(recordPath);
      if (record.wasm.sha256 !== sha256Hex(wasm)) throw new Error(`${recordPath} was made for another wasm (sha256 ${record.wasm.sha256}); use a new --record and --parent`);
      await deployAll(new Run(rpc, keys, record, recordPath, say), wasm);
      return verifyAndPrint(rpc, recordPath, wasm);
    }
    case "scenario": {
      const record = loadRecord(recordPath);
      const rpc = await Rpc.connect(values.rpc ?? record.rpc);
      await runScenario(new Run(rpc, new KeyStore(values.keys), record, recordPath, say));
      return 0;
    }
    case "verify": {
      const record = loadRecord(recordPath);
      return verifyAndPrint(await Rpc.connect(values.rpc ?? record.rpc), recordPath, wasm);
    }
    default:
      console.error(USAGE);
      return 2;
  }
}

async function verifyAndPrint(rpc: Rpc, recordPath: string, wasm: Buffer | null): Promise<number> {
  const record = loadRecord(recordPath);
  const snapshot = await gather(rpc, record, DOCS);
  const checks = evaluate(record, snapshot, wasm === null ? undefined : sha256Hex(wasm));
  for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n      ${c.detail}`);
  console.log(`\nnow: ${describeState(snapshot)}\n\n${describeMinutes(snapshot.minutes).join("\n")}`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed === 0 ? `\nOK: ${checks.length} checks passed` : `\nFAILED: ${failed} of ${checks.length} checks`);
  return failed === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
