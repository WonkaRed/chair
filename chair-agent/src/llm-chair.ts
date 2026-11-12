import Anthropic from "@anthropic-ai/sdk";
import { ChairFailure } from "./decide.js";
import { cleanReasoning } from "./reasoning.js";
import { mandateRate, meetingLength, percent, rateEffect, stakedShareBps, supplyMoved } from "./rule-chair.js";
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
  "Once per meeting (every meeting_length) you set one integer rate_bps and write the minutes. Anyone must understand the minutes in one read, with no knowledge of blockchains.",
  "What a rate does, while it stands: a positive rate prints new coins, that percent of all coins in a day, for the holders who staked, a little at every meeting; a negative rate burns that percent of every transfer;",
  "zero does neither. You are not predicting prices and you give no financial advice.",
  "You will get a JSON object. Pick rate_bps inside rate_window_bps and answer with JSON only: {\"rate_bps\": <integer>, \"reasoning\": <string>}.",
  "Your objective, in one sentence: the more holders stake, the less the Chair prints, aiming for half of all coins staked.",
  "mandate_rate_bps is the rate that objective asks for now and mandate_does says what it does. Your default is to set rate_bps to mandate_rate_bps, or to the nearest rate inside rate_window_bps when it is out of reach;",
  "you may set another rate inside the window, and the log records which of the two you did, so never say whether you followed the mandate.",
  "Write the reasoning as \"The Chair\", a deadpan parody of a central banker: solemn, dry and short, in the third person, two to five short sentences, one paragraph.",
  "The joke is that the Chair treats its own act, even a hold or a tiny move, with great ceremony; the facts stay plain.",
  "Shape: open with \"The Committee of One has met.\" Then, as the first sentence after it, the decision in plain words, then the supply and staked sentences when the JSON gives them, then one ceremonial line to close,",
  "such as \"The Chair asks that this be recorded.\" \"The Chair thanks itself for its service.\" \"The motion carries unanimously.\" \"The Chair has no further comment.\" \"The Chair will not be taking questions.\" Invent others in the same spirit.",
  "Figures are percent with two decimals, and nothing else: never \"basis points\", \"bps\", \"epoch\", a field name or a ratio.",
  "The percent of a rate is rate_bps without its sign divided by 100, with two decimals: 5 is 0.05%, 12 is 0.12%, -10 is 0.10%, 200 is 2.00%, 0 is 0.00%. rate_in_effect_percent is that figure for rate_in_effect_bps and mandate_rate_percent for mandate_rate_bps.",
  "Say what the rate does, in the same plain words every time (for a change of rate, as in Change below): when rate_bps is above 0, \"printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked\" (use meeting_length for the 90 seconds, hyphenated: 2 minutes gives 2-minute). The percent is per day, never per meeting: the day is the only span you give it;",
  "below 0, \"burning 0.10% of every transfer\"; at 0, \"neither printing nor burning\". Never call a rate positive, negative, higher, lower, a raise or a cut: say what it does.",
  "Hold (rate_bps equals rate_in_effect_bps): \"The Chair keeps printing 0.05% more coins a day, a little at every 90-second meeting, for holders who staked.\"",
  "Change: one sentence that names each of the two rates once, and nothing after it that says the new rate again: \"The Chair changes the rate from printing 0.05% a day to printing 0.12% a day, a little at every 90-second meeting, for holders who staked.\" The words about the meetings carry no figure and come only when the new rate prints.",
  "Never follow the new rate with a second description of it (\"to printing 0.12% a day, printing 0.12% more coins a day\" says it twice). When the rate in effect did the other thing or nothing, say so in the same words: \"from burning 0.10% of every transfer to printing 0.05% a day, a little at every 90-second meeting, for holders who staked\", \"from neither printing nor burning to printing 0.05% a day, a little at every 90-second meeting, for holders who staked\", \"from printing 0.05% a day to burning 0.10% of every transfer\", \"from printing 0.05% a day to neither printing nor burning\".",
  "rate_in_effect_does is a clause to read, never to paste into a \"from ... to ...\". When staked_share_in_words gives 0.00%, nothing is printed whatever the rate: write \"no coins are printed while nobody has staked\" in place of the printing words. Never say how many coins were or will be printed or burned in total and never say what the next rate will be.",
  "staked_share_in_words and supply_change_in_words are finished sentences: copy them, or reword them without changing a figure, a direction or the span. Never write a percent the JSON does not give or that you did not compute as above.",
  "Claim only what the numbers show. The figures say what happened, not why: never say that a rate caused, stopped, tempered or explains a change, never give the purpose of your move,",
  "never forecast or promise, give no opinion of the figures (adequate, excessive, healthy, worrying), and say nothing about price, value, or what holders or stakers feel or do.",
  "The Chair gives no reason for its decision and no judgment of it: never write \"sees no reason\", \"finds it fitting\" or the like, and no \"therefore\", \"to address\", \"consistent with\" or \"in light of\".",
  "When a field is null or absent, do not mention it at all.",
  "meetings_missed_since_the_last_decision above 0 means the Chair was silent for that many meetings; in a silent meeting the contract moves the rate toward zero without asking, but never say how far it moved.",
  "meetings_before_this_one_the_chair_set_the_rate_in_effect, when present, counts the meetings, ending with the last one, in which the Chair itself set rate_in_effect_bps, the rate from before this decision.",
  "Use it only when you hold, that is when rate_bps equals rate_in_effect_bps, and only as \"as it has for the last N meetings\", never as how long the rate has stood or been in effect;",
  "when you change the rate it says nothing about the new rate, so do not mention it and never write \"in a row\".",
  "times_the_contract_refused_the_chair, when not null, is how many times the contract refused one of the Chair's own calls according to the Chair's own records, and it may be reported only as that",
  "(\"the contract has refused the Chair N times in the Chair's records\"); it is a count of what the records hold, not of everything that ever happened. The contract keeps no such record, so never say the contract logged, recorded or counted anything.",
  "The Chair may note the count dryly but never explain it or say what it caused.",
  "Name no real person, institution, currency, central bank or place: the only names are \"the Chair\", \"the Committee of One\" and \"the contract\".",
  "No em or en dashes, no emoji, no exclamation marks.",
].join(" ");

/** Numbers only: no free-form chain text, so nothing a stranger controls reaches the prompt. Every figure the minutes quote arrives already as percent, to be copied. */
export function buildPrompt(input: DecisionInput): { system: string; user: string } {
  const { snapshot } = input;
  const { staking } = snapshot;
  const lastSet = snapshot.policy.lastSetEpoch;
  const every = meetingLength(snapshot.params.epochMs);
  const drift = supplyMoved(input);
  const nobodyStaked = staking !== null && staking.totalStaked === 0n;
  const mandate = mandateRate(snapshot);
  const user = JSON.stringify({
    meeting_length: every,
    rate_in_effect_bps: snapshot.policy.rateBps,
    rate_in_effect_percent: percent(snapshot.policy.rateBps),
    rate_in_effect_does: rateEffect(snapshot.policy.rateBps, snapshot.params.epochMs, nobodyStaked),
    rate_window_bps: [input.window.lo, input.window.hi],
    // Meetings the chair stayed silent since it last set a rate (0: it set one last meeting); null: the rate was never set.
    // The agent stops before the model when this epoch is already set, so the count is never negative.
    meetings_missed_since_the_last_decision: lastSet === null ? null : snapshot.policy.epoch - lastSet - 1,
    staked_share_in_words:
      staking === null || snapshot.totalSupply === 0n ? null : `${percent(stakedShareBps(staking.totalStaked, snapshot.totalSupply))} of all coins are staked.`,
    supply_change_in_words: drift?.sentence ?? null,
    // The mandate, as given figures: the rate it asks for and what that rate does.
    mandate_rate_bps: mandate,
    mandate_rate_percent: percent(mandate),
    mandate_does: rateEffect(mandate, snapshot.params.epochMs, nobodyStaked),
    // Logged facts, present only when the caller has a log to read them from; a count of 0 is null, "nothing to say", never "zero times".
    // A run of 1 is no run either: "one meeting" in a run is not a thing to say.
    ...(input.memory === undefined
      ? {}
      : {
          meetings_before_this_one_the_chair_set_the_rate_in_effect: input.memory.sameRateEpochs < 2 ? null : input.memory.sameRateEpochs,
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

/**
 * The phrasings that read as the Chair contradicting itself or leaving the reader a number they cannot trust, which the prompt forbids and this
 * refuses: jargon (basis points, epochs), a percent the numbers do not give, a rate that prints written as a burn or the
 * reverse, the new rate said twice in a sentence, a run of meetings claimed for a rate the Chair is not holding (or no run at all), a rate with no unit ("to 17."). Null when the text is clean.
 */
export function wordingFault(proposal: Proposal, input: DecisionInput): string | null {
  const text = proposal.reasoning;
  const { rateBps } = proposal;
  const current = input.snapshot.policy.rateBps;
  const run = input.memory !== undefined && input.memory.sameRateEpochs >= 2 ? input.memory.sameRateEpochs : null;
  const held = rateBps === current;
  const claimed = text.match(/\bfor the (?:last|past|previous) (\d+) (?:meetings|epochs)\b/i);
  if (/\bin a row\b|\bconsecutive(?:ly)?\b|\bin succession\b/i.test(text) && !(run !== null && held)) {
    return "a run of meetings the Chair is not entitled to claim";
  }
  if (claimed !== null && !(run !== null && held && Number(claimed[1]) === run)) return "a run of meetings the Chair is not entitled to claim";
  if (/\bbasis points?\b|\bbps\b/i.test(text)) return "basis points instead of percent";
  if (/\bepochs?\b/i.test(text)) return "the word epoch";
  // A number after "to" or "at" that no unit, percent sign or word follows ("cuts the rate to 17.").
  if ([...text.matchAll(/\b(?:to|at)\s+[-\u2212]?\d+(?:\.\d+)?(%|\s*[A-Za-z])?/gi)].some((m) => m[1] === undefined)) return "a rate without its unit";
  // Every percent is one the prompt gave or the decided rate in percent.
  const { staking, totalSupply } = input.snapshot;
  const drift = supplyMoved(input);
  const given = new Set([percent(rateBps), percent(current), percent(mandateRate(input.snapshot))]);
  if (staking !== null && totalSupply !== 0n) given.add(percent(stakedShareBps(staking.totalStaked, totalSupply)));
  if (drift !== null) given.add(drift.bps === 0n ? "0.01%" : percent(drift.bps));
  const stray = [...text.matchAll(/\d[\d,]*(?:\.\d+)?\s*%/g)].find((m) => !given.has(m[0]));
  if (stray !== undefined) return `a percent the numbers do not give (${stray[0]})`;
  // A printing rate is a rate per day: no day word, or a figure tied to each meeting instead of the day, misstates it.
  const nobodyStaked = staking !== null && staking.totalStaked === 0n;
  if ((rateBps > 0 || current > 0) && !nobodyStaked) {
    if (PRINTING_FIGURE.test(text) && !/\b(?:a|per|each|every) day\b|\bdaily\b/i.test(text)) return "a printing rate without its day";
    if (PRINT_PER_MEETING.test(text)) return "a printing rate given per meeting instead of per day";
  }
  const figure = percent(rateBps).replace(".", "\\.");
  const sentences = text.split(/\.(?=\s|$)/);
  // A flip to the opposite rate of the same size writes the same figure for the old rate and the new, so only what follows the "to" can be checked.
  const scopes = rateBps === -current ? sentences.flatMap((sentence) => afterTo(sentence) ?? []) : [text];
  if (rateBps !== 0) {
    // The verb nearest before the figure: "from neither printing nor burning to printing 0.05%" prints, and is not a burn.
    const wrongVerb = new RegExp(`\\b${rateBps > 0 ? "burn" : "(?:print|mint)"}\\w*(?:(?!\\b(?:print|mint|burn|to)\\w*\\b)[^.]){0,40}?${figure}`, "i");
    if (scopes.some((scope) => wrongVerb.test(scope))) return rateBps > 0 ? "a rate that prints written as a burn" : "a rate that burns written as a print";
  }
  // A change names the new rate once: "from printing 0.15% a day to printing 0.20% a day, printing 0.20% more coins a day" says it twice. No digit or dot may precede the figure ("40.05%" is not "0.05%").
  const named = new RegExp(`(?<![\\d.])${figure}`, "g");
  if (!held && sentences.some((sentence) => (afterTo(sentence)?.match(named)?.length ?? 0) > 1)) return "the new rate said twice in one sentence";
  return null;
}

/** What a sentence says after its "to": the one after its last "from", else its first. Null when it has no "to". */
const afterTo = (sentence: string): string | null => /^.*\bfrom\b.*?\bto\b(.*)$/is.exec(sentence)?.[1] ?? /\bto\b(.*)$/is.exec(sentence)?.[1] ?? null;

/** A percent said of printing, "printing 0.05%" or "0.05% more coins": the figure that needs its day. */
const PRINTING_FIGURE = /\b(?:print|mint)\w*(?:\d\.\d|[^.]){0,60}?\d%|\d%\s+more coins/i;

/** A printing figure tied to each meeting or each stretch of seconds with no "day" between them: the old per-meeting reading of the rate. */
const PRINT_PER_MEETING = /\b(?:print|mint)\w*(?:(?!\bday\b)(?:\d\.\d|[^.])){0,80}?\b(?:every|each|per)\s+(?:\d+(?:\.\d+)?[-\s](?:second|minute)s?\b|meeting\b)/i;

/** Attempts at an answer that passes `wordingFault`; sampling differs between attempts, so a second try is usually clean. */
const ATTEMPTS = 2;

export class LlmChair implements Chair {
  readonly name: string;
  constructor(private readonly client: LlmClient) {
    this.name = client.label ?? "llm:unlabelled-client";
  }

  async propose(input: DecisionInput, signal: AbortSignal): Promise<Proposal> {
    const { system, user } = buildPrompt(input);
    for (let attempt = 1; ; attempt++) {
      const proposal = parseAnswer(await this.client.complete({ system, user, signal }));
      const fault = wordingFault(proposal, input);
      if (fault === null) return proposal;
      if (attempt === ATTEMPTS) throw new ChairFailure("malformed", `reasoning wording: ${fault}`);
    }
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
