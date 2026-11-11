// Entry point: `node src/main.ts [--epochs <n>]`, configured from the environment (see config.ts and ../README.md).

import { KeyStore } from "../../deploy/src/keys.ts";
import { Rpc } from "../../deploy/src/rpc.ts";
import { runBot } from "./bot.ts";
import { NearChain } from "./chain.ts";
import { systemClock } from "./clock.ts";
import { parseConfig } from "./config.ts";
import { FileLog } from "./log.ts";

async function main(): Promise<void> {
  const config = parseConfig(process.env, process.argv.slice(2));
  const rpc = await Rpc.connect(config.rpcUrl);
  const chain = new NearChain(rpc, config.token, config.holders, new KeyStore(config.keyDir));
  const log = new FileLog(config.logPath);
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => abort.abort());
  const options = {
    seed: config.seed,
    every: config.every,
    maxEpochs: config.maxEpochs,
    start: {
      fields: { token: config.token, holders: config.holders, rpc: config.rpcUrl, seed: config.seed, maxEpochs: config.maxEpochs },
      text: `${config.token} for ${config.holders.join(", ")}, log ${config.logPath}`,
    },
  };
  await runBot(chain, systemClock, log, options, abort.signal);
}

main().catch((e: unknown) => {
  console.error(`chair-activity: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 2;
});
