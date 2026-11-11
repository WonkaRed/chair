// Everything the bot is told from outside, checked once at the boundary. The key directory has no default: a key
// location is a decision of whoever runs the bot, not a path baked into the repository.

import { homedir } from "node:os";
import { join } from "node:path";
import { testnetAccount, type TestnetAccount } from "../../deploy/src/guard.ts";
import { DEFAULT_RPC } from "../../deploy/src/rpc.ts";

export interface Config {
  readonly rpcUrl: string;
  readonly token: TestnetAccount;
  /** Exactly three: the disclosure in every log line says "three accounts we control". */
  readonly holders: readonly TestnetAccount[];
  readonly keyDir: string;
  readonly logPath: string;
  readonly seed: string;
  /** Acts in the epochs that are a multiple of this: 1 is every epoch, 6 every sixth. */
  readonly every: number;
  /** Stop after acting in this many epochs (a trial run); null runs until stopped. */
  readonly maxEpochs: number | null;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`set ${name}`);
  return v;
}

function parseEvery(value: string | undefined): number {
  if (value === undefined) return 1;
  if (!/^[1-9][0-9]{0,5}$/.test(value)) throw new Error(`CHAIR_ACTIVITY_EVERY must be a whole number of epochs, at least 1 (got "${value.slice(0, 20)}")`);
  return Number(value);
}

function parseEpochs(argv: readonly string[]): number | null {
  if (argv.length === 0) return null;
  const [flag, value, ...rest] = argv;
  if (flag !== "--epochs" || value === undefined || rest.length > 0 || !/^[1-9][0-9]{0,5}$/.test(value)) {
    throw new Error("usage: main.ts [--epochs <n>]   (n: a positive integer; without it the bot runs until stopped)");
  }
  return Number(value);
}

export function parseConfig(env: Env, argv: readonly string[]): Config {
  const holders = required(env, "CHAIR_ACTIVITY_HOLDERS").split(",").map((id) => testnetAccount(id.trim()));
  if (holders.length !== 3 || new Set(holders).size !== 3) throw new Error("CHAIR_ACTIVITY_HOLDERS must name three different accounts, comma separated");
  const state = env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return {
    rpcUrl: env["CHAIR_RPC_URL"] ?? DEFAULT_RPC,
    token: testnetAccount(required(env, "CHAIR_TOKEN")),
    holders,
    keyDir: required(env, "CHAIR_ACTIVITY_KEY_DIR"),
    logPath: env["CHAIR_ACTIVITY_LOG"] ?? join(state, "chair-activity", "activity.jsonl"),
    seed: env["CHAIR_ACTIVITY_SEED"] ?? "chair-activity",
    every: parseEvery(env["CHAIR_ACTIVITY_EVERY"]),
    maxEpochs: parseEpochs(argv),
  };
}
