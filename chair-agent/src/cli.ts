import { parseArgs } from "node:util";
import { MAX_SEND_ATTEMPTS, tick, type TickResult } from "./agent.js";
import { ChainReader } from "./chain.js";
import type { DecideOptions } from "./decide.js";
import { AnthropicLlmClient, LlmChair, llmConfigured, type LlmClient } from "./llm-chair.js";
import { DecisionLog, findReasoning, verifyLog } from "./log.js";
import { NearRpc } from "./rpc.js";
import { ruleChair } from "./rule-chair.js";
import { ChairSigner, assertScoped, loadSecretKey, METHOD } from "./signer.js";
import { sanitize } from "./text.js";
import { accountId, int } from "./validate.js";
import type { Decision } from "./types.js";

const USAGE = `chair-agent: sets the $CHAIR rate once per epoch.

  chair-agent run [options]          read the chain, decide, and (unless --dry-run) send set_policy
  chair-agent verify-log <file> [hash]   recompute every logged reasoning hash; with a hash, print its text

run options (each also read from the environment variable in brackets):
  --rpc <url>          JSON-RPC endpoint [CHAIR_RPC_URL]            required
  --token <account>    the $CHAIR token contract [CHAIR_TOKEN]      required
  --account <account>  the chair account [CHAIR_ACCOUNT]            required
  --log <file>         decision log, JSON lines [CHAIR_LOG]         default ./decisions.jsonl
  --chair rule|llm     which chair decides                          default rule
  --dry-run            print the decision and the transaction; send nothing, write nothing, need no key
  --once               one pass instead of looping every epoch
  --allow-full-access-key  run although the chair account holds a full-access key (SPEC says it must not); warns
  --margin-ms <n>      stay valid across a rollover this close to epoch end   default 15000
  --llm-timeout-ms <n> give the model this long before the rule chair decides  default 30000

The key: CHAIR_KEY (ed25519:...) or CHAIR_KEY_FILE (a file holding it). The LLM chair also needs
ANTHROPIC_API_KEY; without it --chair llm falls back to the rule chair.
`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export interface CliDeps {
  /** Replaces the Anthropic SDK client; tests use it so nothing touches a network. */
  llmClient?: LlmClient;
  /** Replaces real sleeping; resolves early when aborted. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

const realSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/** Marks every printed line of chair-written text, so it can never pass for one of the agent's own lines. */
const QUOTE = "  | ";

/**
 * What a decision looks like on a terminal. The hash is of the reasoning text itself, without the `  | `
 * that is prefixed to each of its lines here and only here (the log and `verify-log <hash>` hold the bare text).
 */
export function formatDecision(d: Decision, token: string, account: string): string {
  const args = JSON.stringify({ rate_bps: d.rate, reasoning_hash: d.reasoningHash });
  return [
    `epoch ${d.epoch} | chair ${d.chair} (${d.kind}) | rate ${d.previousRateBps} -> ${d.rate} bps`,
    `reasoning_hash: ${d.reasoningHash}`,
    "--- reasoning (the text behind the hash; each line prefixed, the prefix is not hashed) ---",
    ...d.reasoning.split("\n").map((line) => `${QUOTE}${line}`),
    "--- transaction ---",
    `${account} -> ${token}.${METHOD}(${args})`,
  ].join("\n");
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv, io: Io, deps: CliDeps = {}): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "verify-log") return verifyCommand(rest, io);
    if (command === "run") return await runCommand(rest, env, io, deps);
    io.err(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  } catch (err) {
    io.err(`error: ${err instanceof Error ? sanitize(err.message, 300) : "unknown failure"}`);
    return 2;
  }
}

function verifyCommand(args: readonly string[], io: Io): number {
  const [file, hash] = args;
  if (file === undefined || args.length > 2) throw new Error("usage: chair-agent verify-log <file> [hash]");
  if (hash !== undefined) {
    const text = findReasoning(file, hash);
    if (text === null) {
      io.err(`no logged decision hashes to ${hash}`);
      return 1;
    }
    io.out(text);
    return 0;
  }
  const v = verifyLog(file);
  io.out(`${v.decisions} decisions, ${v.mismatches.length} hash mismatches, ${v.badLines.length} unreadable lines, ${v.badHashes.length} malformed hashes`);
  io.out(`token and account: ${v.scopes.length === 0 ? "none" : v.scopes.map((x) => sanitize(x, 140)).join("; ")}${v.scopes.length > 1 ? " (MIXED: this log was reused)" : ""}`);
  for (const m of v.mismatches) io.out(`epoch ${m.epoch}: logged ${sanitize(m.claimed, 70)}, text hashes to ${m.actual}`);
  return v.ok ? 0 : 1;
}

async function runCommand(args: readonly string[], env: NodeJS.ProcessEnv, io: Io, deps: CliDeps): Promise<number> {
  const { values } = parseArgs({
    args: [...args],
    options: {
      rpc: { type: "string" },
      token: { type: "string" },
      account: { type: "string" },
      log: { type: "string" },
      chair: { type: "string" },
      "dry-run": { type: "boolean" },
      once: { type: "boolean" },
      "allow-full-access-key": { type: "boolean" },
      "margin-ms": { type: "string" },
      "llm-timeout-ms": { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  const rpcUrl = values.rpc ?? env["CHAIR_RPC_URL"];
  const token = accountId(values.token ?? env["CHAIR_TOKEN"], "--token");
  const account = accountId(values.account ?? env["CHAIR_ACCOUNT"], "--account");
  if (rpcUrl === undefined) throw new Error("--rpc (or CHAIR_RPC_URL) is required");
  const dryRun = values["dry-run"] === true;
  const marginMs = int(Number(values["margin-ms"] ?? 15_000), "--margin-ms", 0, 86_400_000);
  const timeoutMs = int(Number(values["llm-timeout-ms"] ?? 30_000), "--llm-timeout-ms", 1, 600_000);
  const wanted = values.chair ?? "rule";
  if (wanted !== "rule" && wanted !== "llm") throw new Error("--chair must be rule or llm");

  let chair = ruleChair;
  let llm: LlmChair | null = null;
  if (wanted === "llm") {
    if (deps.llmClient === undefined && !llmConfigured(env)) {
      io.err("ANTHROPIC_API_KEY is not set: using the rule-based chair");
    } else {
      llm = new LlmChair(deps.llmClient ?? new AnthropicLlmClient());
    }
  }
  const decideOptions: DecideOptions = { chair: llm ?? chair, marginMs, timeoutMs };

  const rpc = new NearRpc(rpcUrl);
  const chainId = await rpc.chainId();
  if (chainId === "mainnet") throw new Error("refusing to run against mainnet: this is a test-network experiment");

  let submitter: ChairSigner | null = null;
  if (!dryRun) {
    submitter = new ChairSigner(loadSecretKey(env, (m) => io.err(`WARNING: ${m}`)), account, token, rpc);
    assertScoped(await rpc.accessKey(account, await submitter.publicKey()), token);
    const full = (await rpc.accessKeyList(account)).filter((k) => k.permission === "FullAccess");
    if (full.length > 0) {
      const msg = `${account} holds ${full.length} full-access key(s); SPEC "The chair's key" says the chair account must hold none`;
      if (values["allow-full-access-key"] !== true) throw new Error(`${msg}. Remove them, or pass --allow-full-access-key`);
      io.err(`WARNING: ${msg}`);
    }
  }
  const log = new DecisionLog(values.log ?? env["CHAIR_LOG"] ?? "decisions.jsonl", { token, account });
  const agent = { reader: new ChainReader(rpc, token), log, decideOptions, chairAccount: account, submitter };
  io.out(`chair-agent on ${chainId}: token ${token}, chair ${account}, chair kind ${decideOptions.chair.name}${dryRun ? ", dry run" : ""}`);

  const signal = deps.signal ?? new AbortController().signal;
  const sleep = deps.sleep ?? realSleep;
  for (;;) {
    let wait = 10_000;
    let code = 1;
    try {
      const r = await tick(agent);
      report(r, io, token, account);
      code = exitCode(r);
      wait = nextWaitMs(r);
    } catch (err) {
      io.err(`tick failed: ${err instanceof Error ? sanitize(err.message, 300) : "unknown"}`);
    }
    if (values.once === true) return code;
    await sleep(wait, signal);
    if (signal.aborted) return 0;
  }
}

/** After a failed send: back off 10 s, 20 s; after the last attempt, like everything else, until the next epoch. */
export function nextWaitMs(r: TickResult): number {
  const untilNextEpoch = Math.max(1000, r.snapshot.policy.epochEndsMs - r.snapshot.blockTimeMs + 1000);
  if (r.status !== "send-failed" || r.failedSends >= MAX_SEND_ATTEMPTS) return untilNextEpoch;
  return Math.min(untilNextEpoch, 10_000 * 2 ** (r.failedSends - 1));
}

function exitCode(r: TickResult): number {
  switch (r.status) {
    case "executed":
    case "dry-run":
    case "already-set":
      return 0;
    case "not-chair":
      return 3;
    default:
      return 1;
  }
}

function report(r: TickResult, io: Io, token: string, account: string): void {
  const e = r.snapshot.policy.epoch;
  switch (r.status) {
    case "not-chair":
      io.out(`epoch ${e}: ${r.snapshot.policy.chair} is the chair, not ${account}; nothing to do`);
      return;
    case "already-set":
      io.out(`epoch ${e}: policy already set this epoch (rate ${r.snapshot.policy.rateBps} bps)`);
      return;
    case "dry-run":
      io.out(`${formatDecision(r.decision, token, account)}\n(dry run: nothing sent, nothing logged)`);
      return;
    case "gave-up":
      io.out(`epoch ${e}: giving up on this epoch: ${r.reason}`);
      return;
    default:
      io.out(formatDecision(r.decision, token, account));
      io.out(
        r.status === "executed"
          ? `executed, tx ${r.txHash}`
          : `${r.status}${r.txHash === null ? "" : ` (tx ${r.txHash})`}: ${r.error ?? "unknown"}`,
      );
  }
}
