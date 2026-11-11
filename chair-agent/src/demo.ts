// Offline demo: the chair runs 16 epochs against an in-memory model of the token. No network, no key,
// no spend. Three epochs are scripted to show what the guard rails do: the agent is down for two epochs
// (the rate decays), a scripted stand-in for the LLM (labelled `llm:scripted-stand-in`, no model is called) answers garbage (fallback to the rule chair), and a fake LLM asks for
// a rate far outside the bounds (clamped).
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tick } from "./agent.js";
import { FakeChain } from "./fake-chain.js";
import { LlmChair, type LlmClient } from "./llm-chair.js";
import { DecisionLog, findReasoning, verifyLog } from "./log.js";
import { reasoningHash } from "./reasoning.js";
import { ruleChair } from "./rule-chair.js";

const CHAIR = "chair.demo.testnet";
const TOKEN = "token.demo.testnet";
const EPOCHS = 16;
const DOWN = new Set([9, 10]);
const FAKE_LLM: Record<number, string> = {
  3: "I think the rate should be about fifteen",
  6: JSON.stringify({ rate_bps: 900, reasoning: "Staking is thin; ease as hard as possible." }),
};

function fakeLlm(epoch: () => number): LlmClient {
  return {
    label: "llm:scripted-stand-in",
    complete: () => Promise.resolve({ text: FAKE_LLM[epoch()] ?? "", stopReason: "end_turn" }),
  };
}

async function main(): Promise<void> {
  const dir = join(import.meta.dirname, "..", "..", "out");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "demo-decisions.jsonl");
  rmSync(logPath, { force: true });
  const log = new DecisionLog(logPath, { token: TOKEN, account: CHAIR });

  const chain = new FakeChain({ chair: CHAIR, totalSupply: 1_000_000n * 10n ** 24n, totalStaked: 100_000n * 10n ** 24n });
  const llm = new LlmChair(fakeLlm(() => chain.epoch));
  let stakedBps = 1000;

  console.log("epoch  rate in effect  what happened                           supply (CHAIR)  staked");
  for (let e = 0; e < EPOCHS; e++) {
    chain.advanceTo(chain.params.startMs + e * chain.params.epochMs + 1000);
    let note = "";
    if (DOWN.has(e)) {
      note = "agent down: no decision, rate decays";
    } else {
      const useLlm = e in FAKE_LLM;
      const r = await tick({
        reader: chain,
        log,
        chairAccount: CHAIR,
        submitter: chain,
        decideOptions: { chair: useLlm ? llm : ruleChair, marginMs: 15_000, timeoutMs: 1000 },
      });
      if (r.status !== "executed") throw new Error(`epoch ${e}: expected executed, got ${r.status}`);
      note = `${r.decision.previousRateBps} -> ${r.decision.rate} bps by ${r.decision.chair}${r.decision.kind === "rule-fallback" ? " (fallback)" : ""}`;
    }
    const whole = chain.totalSupply / 10n ** 24n;
    console.log(`${String(e).padStart(5)}  ${String(chain.rateBps).padStart(11)}  ${note.padEnd(52)} ${whole.toString().padStart(10)}  ${(stakedBps / 100).toFixed(1)}%`);
    // Stakers respond to the rate for the epoch just handled, then the boundary applies.
    stakedBps = Math.max(500, Math.min(9000, stakedBps + chain.rateBps * 3 + ((e * 37) % 11) * 10 - 40));
    chain.totalStaked = (chain.totalSupply * BigInt(stakedBps)) / 10_000n;
  }

  const v = verifyLog(logPath);
  const onChainMatchesLog = chain.events.every((ev) => {
    const text = findReasoning(logPath, ev.reasoningHash);
    return text !== null && reasoningHash(text) === ev.reasoningHash;
  });
  const bounded = chain.refusals.length === 0;
  console.log(`\n${chain.events.length} set_policy calls, ${chain.refusals.length} refused by the contract model`);
  console.log(`log: ${v.decisions} decisions, ${v.mismatches.length} hash mismatches; every on-chain hash has its text in ${logPath}: ${onChainMatchesLog}`);
  if (!v.ok || !onChainMatchesLog || !bounded || chain.events.length !== EPOCHS - DOWN.size) {
    console.error("FAIL: the demo's own checks did not hold");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: every decision stayed inside the bounds and every hash matches its logged text");
}

await main();
