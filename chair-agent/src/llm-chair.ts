import Anthropic from "@anthropic-ai/sdk";
import { ChairFailure } from "./decide.js";
import { cleanReasoning } from "./reasoning.js";
import { stakedShareBps, supplyDriftBps } from "./rule-chair.js";
import type { Chair, DecisionInput, Proposal } from "./types.js";

export const LLM_MODEL = "claude-sonnet-5-5";

/** What the model sees and may answer; the only thing that leaves this module is a `Proposal`. */
export interface LlmRequest {
  readonly system: string;
  readonly user: string;
  readonly signal: AbortSignal;
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

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    rate_bps: { type: "integer" },
    reasoning: { type: "string" },
  },
  required: ["rate_bps", "reasoning"],
  additionalProperties: false,
} as const;

const SYSTEM = [
  "You are the chair of $CHAIR, a toy monetary-policy experiment on a test network.",
  "Once per epoch you set one integer rate in basis points. A positive rate mints new supply to stakers at the end of the epoch;",
  "a negative rate burns that share of every transfer during the epoch. You are not predicting prices and you give no financial advice.",
  "You will get a JSON object of numbers. Pick a rate inside rate_window_bps and explain the choice in two to five plain sentences",
  "that someone can check against those numbers. Answer with JSON only: {\"rate_bps\": <integer>, \"reasoning\": <string>}.",
].join(" ");

/** Numbers only: no free-form chain text, so nothing a stranger controls reaches the prompt. */
export function buildPrompt(input: DecisionInput): { system: string; user: string } {
  const { snapshot, history } = input;
  const staking = snapshot.staking;
  const lastSet = snapshot.policy.lastSetEpoch;
  const user = JSON.stringify({
    epoch: snapshot.policy.epoch,
    rate_in_effect_bps: snapshot.policy.rateBps,
    rate_window_bps: [input.window.lo, input.window.hi],
    epochs_this_chair_has_held_the_seat: snapshot.policy.streak,
    // Epochs the chair stayed silent since it last set a rate (0: it set one last epoch); null: the rate was never set.
    // The agent stops before the model when this epoch is already set, so the count is never negative.
    epochs_since_last_decision: lastSet === null ? null : snapshot.policy.epoch - lastSet - 1,
    total_supply: snapshot.totalSupply.toString(),
    staked_share_bps:
      staking === null || snapshot.totalSupply === 0n ? null : stakedShareBps(staking.totalStaked, snapshot.totalSupply),
    supply_change_bps_last_6_epochs: supplyDriftBps(input)?.toString() ?? null,
    recent_supply: history.slice(-6).map((h) => ({ epoch: h.epoch, total_supply: h.totalSupply.toString() })),
  });
  return { system: SYSTEM, user };
}

/** Strict parse of the model's answer. Throws `ChairFailure` for anything that is not exactly the schema. */
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

export function parseAnswer(res: LlmResponse): Proposal {
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
  const { rate_bps: rate, reasoning } = data as Record<string, unknown>;
  if (keys !== "rate_bps,reasoning" || typeof rate !== "number" || !Number.isSafeInteger(rate) || typeof reasoning !== "string") {
    throw new ChairFailure("malformed", "answer does not match the schema");
  }
  const text = cleanReasoning(reasoning, 1500);
  if (text === null) throw new ChairFailure("malformed", "empty reasoning");
  return { rateBps: rate, reasoning: text };
}

export class LlmChair implements Chair {
  readonly name: string;
  constructor(private readonly client: LlmClient) {
    this.name = client.label ?? "llm:unlabelled-client";
  }

  async propose(input: DecisionInput, signal: AbortSignal): Promise<Proposal> {
    const { system, user } = buildPrompt(input);
    return parseAnswer(await this.client.complete({ system, user, signal }));
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
        max_tokens: 4000,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: { effort: "low", format: { type: "json_schema", schema: ANSWER_SCHEMA } },
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
