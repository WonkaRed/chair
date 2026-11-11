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
  /** The JSON schema the answer must follow; the decision schema when absent. */
  readonly schema?: Readonly<Record<string, unknown>>;
  /** Cap on the answer's tokens, thinking included; 4000 when absent. */
  readonly maxTokens?: number;
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
  "You will get a JSON object of numbers. Pick a rate inside rate_window_bps and answer with JSON only: {\"rate_bps\": <integer>, \"reasoning\": <string>}.",
  "Write the reasoning as \"The Chair\", a deadpan parody of a central banker: solemn, dry and short, in the third person, two to four sentences.",
  "The joke is that the Chair treats its own act, even a hold or a move of a few bps, with great ceremony; the facts stay plain.",
  "Ceremony you may use, or invent in the same spirit: \"The Committee of One has met.\" \"The Chair thanks itself for its service.\"",
  "\"The Chair notes its place.\" \"The motion carries unanimously.\" \"The Chair has no further comment.\"",
  "\"The Chair asks that this be recorded.\" \"The Chair will not be taking questions.\" \"The Chair has seen the numbers and remains the Chair.\"",
  "State the decision (raise, cut or hold, and by how many bps, measured from rate_in_effect_bps: a raise is a higher number than rate_in_effect_bps, so -40 to -35 is a raise,",
  "and a cut is a lower number) and at least one figure from the JSON,",
  "reported as a fact beside the decision and not as its reason: no \"therefore\", \"to address\", \"consistent with\" or \"in light of\".",
  "Write figures in plain words (\"basis points\", \"epochs\"), never as field names, and never quote total_supply in full.",
  "Say how supply moved only by quoting supply_change_bps_last_6_epochs, which already includes today's total_supply; recent_supply is older and must not be read as the present.",
  "Copy every figure exactly or compute it from the JSON; invent none.",
  "Claim only what the numbers show. The figures say what happened, not why: never say that a rate caused, stopped, tempered or explains a change,",
  "never give the purpose or expected effect of your move, never say what was minted or burned, never forecast or promise,",
  "never say what the contract or any rate will do next, give no opinion of the figures (adequate, excessive, healthy, worrying),",
  "and say nothing about price, value, or what holders or stakers feel or do. The ceremony is about the Chair, never about the numbers.",
  "The Chair gives no reason for its decision and no judgment of it: never write \"sees no reason\", \"finds it fitting\" or the like.",
  "When a figure is null, do not mention it at all.",
  "epochs_since_last_decision above 0 means the Chair was silent for that many epochs; in a silent epoch the contract moves the rate toward zero without asking, but never say how far it moved;",
  "epochs_this_chair_has_held_the_seat says nothing about how long any rate has lasted; how long a rate has been in effect is unknown, so never say it,",
  "except through consecutive_epochs_the_chair_set_this_same_rate: when present, it is the number of epochs in a row, ending with the last one, in which the Chair itself set exactly rate_in_effect_bps, and it may be reported only as that (\"the Chair has set this same rate N epochs in a row\"), never as how long the rate has stood or been in effect.",
  "times_the_contract_refused_the_chair, when not null, is how many times the contract refused one of the Chair's own calls according to the Chair's own records, and it may be reported only as that",
  "(\"the contract has refused the Chair N times in the Chair's records\"); it is a count of what the records hold, not of everything that ever happened. The contract keeps no such record, so never say the contract logged, recorded or counted anything.",
  "The Chair may note the count dryly but never explain it or say what it caused.",
  "Name no real person, institution, currency, central bank or place: the only names are \"the Chair\", \"the Committee of One\" and \"the contract\".",
  "No em or en dashes, no emoji, no exclamation marks.",
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
    // Logged facts, present only when the caller has a log to read them from; a count of 0 is null, "nothing to say", never "zero times".
    ...(input.memory === undefined
      ? {}
      : {
          consecutive_epochs_the_chair_set_this_same_rate: input.memory.sameRateEpochs === 0 ? null : input.memory.sameRateEpochs,
          times_the_contract_refused_the_chair: input.memory.refusals === 0 ? null : input.memory.refusals,
        }),
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
        max_tokens: req.maxTokens ?? 4000,
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
