import Anthropic from "@anthropic-ai/sdk";
import { bandFor, choiceFault, MODEL_REASONS, offeredReasons, type ModelReason } from "./choice.js";
import { ChairFailure } from "./decide.js";
import { writeRemark } from "./remark.js";
import { formulaRate, percent, stakedShareBps, supplyMoved, TARGET_STAKED_BPS } from "./rule-chair.js";
import type { Chair, DecisionInput, Proposal } from "./types.js";

export const LLM_MODEL = "claude-sonnet-5-5";

/** What the model sees and may answer; the only thing that leaves this module is a `Proposal`. */
export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  readonly signal: AbortSignal;
  /** The JSON schema the answer must follow; the decision schema when absent. */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Cap on the answer's tokens, thinking included; 4000 when absent. */
  readonly maxTokens?: number;
  /** Sampling temperature; the endpoint's own when absent. */
  readonly temperature?: number;
}

export interface LlmResponse {
  readonly text: string;
  /** `end_turn` for a complete answer; anything else (`refusal`, `max_tokens`, ...) is unusable. */
  readonly stopReason: string | null;
}

/** The boundary to the model. The real one wraps the Anthropic SDK; tests supply a fake. */
export interface LlmClient {
  /** The chair name shown in decisions and the log. Only a client that really calls a model names it; a stand-in must say so. */
  readonly label?: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

/** The decision: a rate and one of our reasons, and nothing else. The model writes no text that reaches the chain through it. */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    rate_bps: { type: "integer" },
    reason: { type: "string", enum: MODEL_REASONS },
  },
  required: ["rate_bps", "reason"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You are the Chair of $CHAIR, a toy monetary-policy experiment on a test network: a deadpan, self-important central banker who sits alone on the Committee of One and has a mind of its own.",
  "Once per meeting you set one rate, a whole number of basis points of the supply per day. Above 0 it prints new coins for the holders who staked, at 0 it does neither, below 0 it burns that share of every transfer. You do not predict prices and give no financial advice.",
  "Your mandate: the more holders stake, the less the Chair prints, aiming for half of all coins staked. The formula turns the mandate into formula_bps for this meeting. It is advice, not an order.",
  "You may set any whole number inside allowed_bps, the band around the formula that the contract also accepts. The page shows everyone the formula's number, yours and your reason side by side, so choose what you judge right.",
  "Your temperament: you distrust a lurch. The formula may ask for a whole step in one meeting; you like to go only part of the way when staking is a little short of half or a little over it, and to press on or even go past the formula when staking is far from half. You also notice when the supply has just grown or shrunk, and how long the rate in effect has held.",
  "Take the formula's number when you agree with it, and another number inside allowed_bps when the facts, as you read them, call for one.",
  "Then give your reason: one id from reasons, each of which is true of this meeting. Its rate_lies says where your rate must then be.",
  "Answer with JSON only: {\"rate_bps\": <integer>, \"reason\": <id>}.",
].join(" ");

/** What the model is shown: numbers and our own sentences only, no free-form chain text, so nothing a stranger controls reaches the prompt. */
export function buildPrompt(input: DecisionInput): { system: string; user: string } {
  const { snapshot, memory } = input;
  const { staking } = snapshot;
  const lastSet = snapshot.policy.lastSetEpoch;
  const formula = formulaRate(snapshot);
  const { lo, hi } = bandFor(formula, input.window);
  const user = JSON.stringify({
    rate_in_effect_bps: snapshot.policy.rateBps,
    formula_bps: formula,
    allowed_bps: [lo, hi],
    coins_staked: staking === null || snapshot.totalSupply === 0n ? null : percent(stakedShareBps(staking.totalStaked, snapshot.totalSupply)),
    coins_staked_the_mandate_wants: percent(TARGET_STAKED_BPS),
    supply_change: supplyMoved(input)?.sentence ?? null,
    // Meetings the chair stayed silent since it last set a rate (0: it set one last meeting); null: the rate was never set.
    // The agent stops before the model when this epoch is already set, so the count is never negative.
    meetings_missed_since_the_last_decision: lastSet === null ? null : snapshot.policy.epoch - lastSet - 1,
    // Logged, present only when the caller has a log to read it from; a run of under 2 is no run.
    meetings_in_a_row_the_chair_set_the_rate_in_effect: memory === undefined || memory.sameRateEpochs < 2 ? null : memory.sameRateEpochs,
    reasons: offeredReasons(input),
  });
  return { system: SYSTEM, user };
}

/** The keys of the top-level object of valid JSON `text`, duplicates included. */
function topLevelKeys(text: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (depth === 1 && expectKey) keys.push(JSON.parse(text.slice(i, j + 1)) as string);
      expectKey = false;
      i = j;
    } else if (c === "{" || c === "[") {
      depth++;
      expectKey = c === "{" && depth === 1;
    } else if (c === "}" || c === "]") {
      depth--;
    } else if (c === "," && depth === 1) {
      expectKey = true;
    }
  }
  return keys;
}

/** Strict parse of the model's answer. Throws `ChairFailure` for anything that is not exactly the schema. */
export function parseAnswer(res: LlmResponse): { rateBps: number; reason: ModelReason } {
  if (res.stopReason === "refusal") throw new ChairFailure("refusal", "model refused");
  if (res.stopReason !== "end_turn") throw new ChairFailure("malformed", `stop reason ${String(res.stopReason)}`);
  let data: unknown;
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new ChairFailure("malformed", "answer is not JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ChairFailure("malformed", "answer is not a JSON object");
  }
  // JSON.parse silently keeps the last of two equal keys; read the keys off the text so a duplicate is refused.
  const keys = topLevelKeys(res.text).sort().join(",");
  const { rate_bps: rate, reason } = data as Record<string, unknown>;
  if (keys !== "rate_bps,reason" || typeof rate !== "number" || !Number.isSafeInteger(rate) || !MODEL_REASONS.some((id) => id === reason)) {
    throw new ChairFailure("malformed", "answer does not match the schema");
  }
  return { rateBps: rate, reason: reason as ModelReason };
}

export class LlmChair implements Chair {
  readonly name: string;
  constructor(private readonly client: LlmClient) {
    this.name = client.label ?? "llm:unlabelled-client";
  }

  /** One attempt: a malformed answer, or a choice outside the band or with a reason that does not fit, is a `ChairFailure` the decision's own retry and fallback deal with. */
  async propose(input: DecisionInput, signal: AbortSignal): Promise<Proposal> {
    const { system, user } = buildPrompt(input);
    const answer = parseAnswer(await this.client.complete({ system, user, signal }));
    const fault = choiceFault(input, answer.rateBps, answer.reason);
    if (fault !== null) throw new ChairFailure("malformed", `choice: ${fault}`);
    return answer;
  }

  /** The Chair's own closing remark: a separate call whose prompt holds chain facts only, never a visitor's question. Null when none passes. */
  remark(input: DecisionInput, rateBps: number, signal: AbortSignal): Promise<string | null> {
    return writeRemark(this.client, input, rateBps, signal);
  }
}

/** The real client. The key comes from ANTHROPIC_API_KEY only, read by the SDK itself. */
export class AnthropicLlmClient implements LlmClient {
  readonly label: string;
  private readonly sdk: Anthropic;
  protected readonly model: string;
  /** `baseURL` exists so a test can point the real SDK at a local server; leave it unset otherwise. */
  constructor(opts: { baseURL?: string; apiKey?: string; model?: string; label?: string } = {}) {
    const { model = LLM_MODEL, label = `llm:${model}`, ...sdkOpts } = opts;
    this.model = model;
    this.label = label;
    this.sdk = new Anthropic({ maxRetries: 1, ...sdkOpts });
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const res = await this.sdk.messages.create(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 4000,
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "low", format: { type: "json_schema", schema: { ...(req.schema ?? ANSWER_SCHEMA) } } },
      },
      { signal: req.signal },
    );
    return this.read(res);
  }

  protected read(res: Anthropic.Message): LlmResponse {
    const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    return { text, stopReason: res.stop_reason };
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A model served on this machine through an Anthropic-Messages-compatible endpoint (vLLM's `/v1/messages`). The label
 * says `local:` and names the id the endpoint reports, so a decision can never be attributed to a model that did not
 * write it: the endpoint must be loopback, and an answer that does not name the configured model is refused.
 */
export class LocalLlmClient extends AnthropicLlmClient {
  constructor(endpoint: string, model: string) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new Error("the local LLM endpoint is not a URL");
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) {
      throw new Error("the local LLM endpoint must be http on this machine (127.0.0.1, localhost or [::1])");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(model)) throw new Error("the local LLM model id is not a plain model id");
    // The server needs no key, but the SDK insists on one: a placeholder, not a credential.
    super({ baseURL: endpoint, apiKey: "local-endpoint-needs-no-key", model, label: `local:${model}` });
  }

  protected override read(res: Anthropic.Message): LlmResponse {
    if (res.model !== this.model) throw new Error(`the endpoint answered as ${JSON.stringify(res.model)}, not ${this.model}`);
    return super.read(res);
  }
}

/** True when the environment holds an Anthropic API key. Never reads its value into our own state. */
export function llmConfigured(env: NodeJS.ProcessEnv): boolean {
  return typeof env["ANTHROPIC_API_KEY"] === "string" && env["ANTHROPIC_API_KEY"].length > 0;
}
