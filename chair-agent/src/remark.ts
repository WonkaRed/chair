import { BOOK } from "./press-book.js";
import { CLOSING, FALLBACK_CLOSINGS, percent, stakedShareBps, supplyMoved, TARGET_STAKED_BPS } from "./rule-chair.js";
import type { LlmClient } from "./llm-chair.js";
import type { DecisionInput } from "./types.js";

/**
 * The Chair's own remark: the one sentence of the minutes the model writes freely. It is its own model call, separate from the decision
 * and from the press desk, and its prompt holds chain facts and the persona only, never a word a visitor wrote. What the model returns
 * goes on chain, so it is accepted only if `remarkFault` finds nothing wrong with it; otherwise the minutes close on a line of the fixed book.
 */

/** Latest logged remarks a new one must differ from, and that the prompt lists as already said. */
export const REMARK_MEMORY = 20;
/** How many of the latest remarks the prompt lists, and whose opening words a new remark may not repeat. */
const RECENT_SHOWN = 8;
const OPENING_WORDS = 4;

export const MIN_CHARS = 20;
export const MAX_CHARS = 140;

/** A refused remark is asked for once more, in the next form. The temperature stays at 1: some endpoints cap it there. */
export const ATTEMPTS = 2;
const TEMPERATURE = 1;

/** Tone guides shown to the model. A remark equal to one of them, or containing one, is refused: the model has to write its own. */
export const EXAMPLES: readonly string[] = [
  "The Chair accepts full responsibility, and has appointed the Chair to investigate.",
  "The Chair remains independent, chiefly because nobody else applied.",
  "The Committee of One has adjourned for lunch, though it has never been seen to eat.",
  "The Committee took the matter under advisement, and advised itself to wait.",
  "The Chair proposed an amendment to the Chair's own motion and was narrowly outvoted by the Chair.",
];

/** The Chair's book of closing lines, with the one the press desk adds. The page mirrors this list (web/site/js/minutes.js `BOOK_CLOSINGS`) to tell a closing the Chair wrote from one it was given. */
const BOOK_CLOSINGS: readonly string[] = [...Object.values(CLOSING), "The Chair will not be taking questions."];

/** Every line the Chair has been given to say that a remark must not repeat: its closing book, the rule chair's lines, the press desk's book, the tone guides. */
const KNOWN: readonly string[] = [...BOOK_CLOSINGS, ...BOOK, ...EXAMPLES];

/** Words that make a sentence advice or a claim about the market, a person or a place, that invent a count, or that have no place in a joke on chain. Whole words. */
const WORDS = new Set(
  (
    "invest invests invested investing investor investors investment investments bull bulls bullish bear bears bearish yield apy rich wealth millionaire lambo hodl " +
    "safe legit audit audited fraud ponzi illegal lawsuit regulator forecast predict predicts promise promises value valuable cheap expensive " +
    "ass damn hell crap tit tits fed ecb imf sec god jesus allah kike kikes spic spics coon coons dyke dykes gook gooks " +
    "i me my mine myself we us our ours ourselves you your yours yourself yourselves " +
    "two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy eighty ninety dozen twice thrice consecutive successive times " +
    "first second third fourth fifth sixth seventh eighth ninth tenth eleventh twelfth thirteenth fourteenth fifteenth sixteenth seventeenth eighteenth nineteenth twentieth thirtieth fortieth fiftieth hundredth thousandth " +
    "apple meta visa tether franc trump elon"
  ).split(" "),
);

/** Word beginnings with the same effect: advice and markets, profanity, slurs, violence and sex, people, companies, countries, currencies and other coins. */
const STEMS: readonly string[] = (
  "hundred thousand million billion buy sell guarant profit price pricing moon rug scam trade airdrop dollar euro yen yuan rupee peso sterling ruble rouble lira " +
  "soar rall crash plung surg pump dump gain return federal reserve treasur " +
  "bitcoin btc ethereum ether solana doge shib pepe xrp ripple litecoin cardano binance usdt usdc stablecoin crypto " +
  "fuck shit bitch bastard cunt dick cock piss whore slut nigg fag retard rape nazi hitler kill murder suicid terror sex porn nude drug cocaine twat wank prick bollock chink tranny " +
  "biden obama putin musk powell yellen lagarde bernanke greenspan volcker satoshi vitalik buterin buffett bezos zuckerberg altman jerome " +
  "google amazon microsoft tesla openai anthropic claude nvidia coinbase ftx blackrock goldman jpmorgan mastercard paypal twitter facebook " +
  "americ usa china russia ukrain israel palestin iran india japan german europ britain british england france canad mexic brazil korea taiwan venezuela argentin turkey nigeria swiss"
).split(" ");

/** Why a block-listed word is in `text`, or null. Letters split by hyphens or spaces ("f-u-c-k", "sh-it") are put back together first. */
function wordFault(text: string): string | null {
  const ws = words(text);
  if (/(?<![a-z])[a-z](?:[^a-z]+[a-z]){2}(?![a-z])/i.test(text)) return "a word spelled out letter by letter";
  const joined = words(text.toLowerCase().replace(/(?<=[a-z])-(?=[a-z])/g, ""));
  for (const word of [...ws, ...joined]) {
    if (WORDS.has(word) || STEMS.some((stem) => word.startsWith(stem))) return `the word "${word}"`;
  }
  return squash(text).includes("wall street") ? 'the words "wall street"' : null;
}

/** The words of `text`, lowercase: letters only, so "Chair's" is "chair" and "s", and a hyphen separates two words. */
const words = (text: string): string[] => text.toLowerCase().match(/[a-z]+/g) ?? [];

/** The text as it is compared with other lines: lowercase words and single spaces, nothing else. */
const squash = (text: string): string => words(text).join(" ");

/** Its first words, as they are compared with the opening of a recent remark. */
const openingOf = (text: string): string => words(text).slice(0, OPENING_WORDS).join(" ");

/** What the rate did at this meeting against the rate in effect. */
export type Move = "up" | "down" | "same";
/** The sign of the rate after this decision: printing, burning, or neither. */
export type Sign = "printing" | "burning" | "neither";
/** What a remark may not contradict: what the rate did, and what it is now. */
export interface Fact {
  readonly move: Move;
  readonly sign: Sign;
}
export const factOf = (rateBps: number, inEffectBps: number): Fact => ({
  move: rateBps === inEffectBps ? "same" : rateBps > inEffectBps ? "up" : "down",
  sign: rateBps > 0 ? "printing" : rateBps < 0 ? "burning" : "neither",
});

/** The words that say what the rate did or is, by the facts each one is true of. A remark may use one only when it is true of this meeting, or negated. */
const SAYS: readonly { readonly of: readonly (Move | Sign)[]; readonly words: ReadonlySet<string> }[] = [
  { of: ["up"], words: new Set("raise raised raises raising increase increased increases increasing hike hiked hikes hiking higher rise rises rose risen rising lift lifted lifts boost boosted".split(" ")) },
  { of: ["down"], words: new Set("cut cuts cutting lower lowered lowers lowering reduce reduced reduces reducing decrease decreased decreases decreasing drop dropped drops dropping slash slashed slashes trim trimmed trims".split(" ")) },
  { of: ["same"], words: new Set("hold holds held holding unchanged steady same maintain maintains maintained maintaining stay stays stayed stable".split(" ")) },
  { of: ["up", "down"], words: new Set("change changes changed changing alter alters altered adjust adjusts adjusted".split(" ")) },
  { of: ["printing"], words: new Set("print prints printed printing mint mints minted minting".split(" ")) },
  { of: ["burning"], words: new Set("burn burns burned burnt burning".split(" ")) },
];
/** A word that turns the claim after it into its denial, within `NEGATION_REACH` words ("did not raise", "declined to cut", "no change"). */
const NEGATORS = new Set("not never no nor neither nothing without t declined declines refused refuses refrained resisted resists avoided avoids".split(" "));
const NEGATION_REACH = 4;

/** What the words say at word `i`: "print more" is a rise, "print less" a fall, and the rest are the words of `SAYS`. */
function saidAt(ws: readonly string[], i: number): readonly (Move | Sign)[] | null {
  const word = ws[i]!;
  const says = SAYS.find((s) => s.words.has(word))?.of ?? null;
  if (says?.[0] !== "printing") return says;
  const next = ws[i + 1];
  return next === "more" || next === "extra" ? ["up"] : next === "less" || next === "fewer" ? ["down"] : says;
}

/** Why `text` says something false about what the rate did or is, or null. "Did not raise" is true of a hold and false of a rise; "burns" is false of a printing rate. */
export function factFault(text: string, fact: Fact): string | null {
  const ws = words(text);
  for (let i = 0; i < ws.length; i++) {
    const said = saidAt(ws, i);
    if (said === null) continue;
    const negated = ws.slice(Math.max(0, i - NEGATION_REACH), i).some((w) => NEGATORS.has(w));
    if (negated === said.some((s) => s === fact.move || s === fact.sign)) return `says what the rate did or is ("${ws[i]}") against a rate that went ${fact.move} and is ${fact.sign}`;
  }
  return null;
}

/**
 * Why `text` may not be the Chair's remark, or null when it may. `avoid` is what it must not repeat (the latest remarks, oldest first) and `fact`
 * what the rate did at this meeting and is now, which the remark may not contradict. Pure.
 */
export function remarkFault(text: string, avoid: readonly string[], fact: Fact): string | null {
  if (text.length < MIN_CHARS || text.length > MAX_CHARS) return `length ${text.length} is outside ${MIN_CHARS}..${MAX_CHARS}`;
  if (!/^[A-Z][A-Za-z ,.';:?-]*$/.test(text)) return "not plain letters, spaces and . , ' ; : ? - starting with a capital";
  if (/ {2}/.test(text)) return "stray spaces";
  if (/(?<![A-Za-z])'|'(?![A-Za-z])/.test(text)) return "an apostrophe that is not inside a word";
  if (!/[.?]$/.test(text) || /[.?]./.test(text)) return "not exactly one sentence";
  if (!/\bthe (?:chair|committee)\b/i.test(text)) return "names neither the Chair nor the Committee";
  const blocked = wordFault(text) ?? factFault(text, fact);
  if (blocked !== null) return blocked;
  const opening = openingOf(text);
  if (avoid.slice(-RECENT_SHOWN).some((line) => openingOf(line) === opening)) return "opens with the same words as a recent remark";
  const said = ` ${squash(text)} `;
  // A short known line ("Noted.") is only repeated by an equal remark; a long one is repeated by any remark that holds it whole.
  const repeated = [...KNOWN, ...avoid].find((line) => {
    const known = squash(line);
    return known !== "" && (said === ` ${known} ` || (known.split(" ").length >= 5 && said.includes(` ${known} `)));
  });
  return repeated === undefined ? null : "a line the Chair has already said";
}

/** The book line that closes the minutes of `epoch` when the model's remark is not used: one a meeting, in turn. */
export const bookLine = (epoch: number): string => FALLBACK_CLOSINGS[epoch % FALLBACK_CLOSINGS.length]!;

const SYSTEM = [
  "You write the Chair's one-line remark at the end of each meeting's minutes.",
  "The Chair is the only member of the Committee of One, which sets the rate of $CHAIR, a toy memecoin on a test network. It is a deadpan parody of a central banker: pompous, dry and solemn about trivia, and it speaks of itself only in the third person, as \"the Chair\".",
  "Write one short sentence of 18 words at most that a stranger would screenshot: plain words, the turn in the last few. Treat one small fact from the JSON with the gravity of a constitutional ruling, and undercut it with a dry, absurd detail of procedure:",
  "the Chair reports to itself, consults only itself, and concludes that the Chair acted properly. Do not restate the fact; the minutes above already do. No \"notes that\" or \"observes that\".",
  "Start with a capital letter. Plain English letters and . , ' ; : ? - only: no digits, numbers in words, symbols, exclamation marks or quotation marks. No advice, forecasts, prices, markets, or real names.",
  "Tone guides, for register only: invent a new situation, never reuse theirs or their shape:",
  ...EXAMPLES.map((line) => `- ${line}`),
  "The remark must be true of the facts in the JSON: say nothing about what the rate did, or about printing or burning, unless it agrees with the_rate_is_now and this_meeting, and invent no count, run or event. Follow form_this_time.",
  "already_said lists recent remarks: be different, and do not open with the same four words as any of them.",
  "Your reasoning must be three short lines at most: pick the idea, write the sentence, answer. Do not restate the context or the rules, count characters, or write drafts. Never list alternatives or variants: think of one sentence, write it once, and answer.",
  "Answer with JSON only: {\"remark\": <string>}.",
].join("\n");

export const REMARK_SCHEMA = {
  type: "object",
  properties: { remark: { type: "string" } },
  required: ["remark"],
  additionalProperties: false,
} as const;

/** The shape of remark a meeting calls for, in turn by meeting number, so that the Chair does not keep making the same joke. Static text, no chain data. */
const FORMS: readonly string[] = [
  "a ruling the Chair makes against itself, with its absurd consequence",
  "something the Committee of One did or agreed, with the Committee as the sentence's subject",
  "a question the Chair puts to itself and answers at once",
  "a sentence that opens with a time or a place (at the close of the meeting, in the Chair's view) and ends flat",
  "a solemn half and a flat half joined by a semicolon",
  "an apology or a grievance the Chair addresses to the Chair",
  "a commendation or a censure of an unlikely object: the minutes, the gavel, the agenda, the quorum",
  "something enormous described as routine, in the driest possible words",
];

/**
 * What a remark can lean on that a later read can make false, in the coarse form that matters: the meeting, the rate in effect and the rate set, which side of the
 * target the staked share is on, and which way the supply went. A remark is kept only when this is the same on the read the decision is made on; the filter bans every
 * digit, number word and ordinal, so no remark can state a count or a figure, but "most coins are staked" or "the supply grew" is still a claim about the chain.
 */
export function remarkBasis(input: DecisionInput, rateBps: number): string {
  const { snapshot } = input;
  const side = snapshot.staking === null || snapshot.totalSupply === 0n ? null : Math.sign(stakedShareBps(snapshot.staking.totalStaked, snapshot.totalSupply) - Number(TARGET_STAKED_BPS));
  const drift = supplyMoved(input);
  return JSON.stringify([snapshot.policy.epoch, snapshot.policy.rateBps, rateBps, side, drift === null ? null : Math.sign(Number(drift.delta))]);
}

/** What the Chair knows of this meeting, in words for the model to react to. Chain facts only: nothing a visitor wrote, no question, no count of questions. */
export function buildRemarkPrompt(input: DecisionInput, rateBps: number, recent: readonly string[], attempt = 0): { system: string; user: string } {
  const { snapshot, memory } = input;
  const { staking } = snapshot;
  const current = snapshot.policy.rateBps;
  const drift = supplyMoved(input);
  const run = memory === undefined || memory.sameRateEpochs < 2 ? null : memory.sameRateEpochs;
  const user = JSON.stringify({
    meeting: snapshot.policy.epoch,
    form_this_time: FORMS[(snapshot.policy.epoch + attempt) % FORMS.length],
    the_rate_is_now: rateBps === 0 ? "neither printing nor burning" : `${rateBps > 0 ? "printing" : "burning"} ${percent(rateBps)}`,
    this_meeting: { same: "the Chair held the rate: it did not change", up: "the Chair raised the rate", down: "the Chair lowered the rate" }[factOf(rateBps, current).move],
    meetings_the_chair_has_held_this_rate: rateBps === current ? run : null,
    coins_staked: staking === null || snapshot.totalSupply === 0n ? null : percent(stakedShareBps(staking.totalStaked, snapshot.totalSupply)),
    coins_staked_the_chair_would_like: percent(TARGET_STAKED_BPS),
    supply: drift?.sentence ?? null,
    already_said: recent.slice(-RECENT_SHOWN),
  });
  return { system: SYSTEM, user };
}

/** Room for the model's reasoning and the answer; the reasoning is what runs away (see `SYSTEM`), and the call's time limit bounds the rest. */
const REMARK_TOKENS = 800;

/** One attempt: the model's remark as it wrote it, trimmed. Throws when the call fails or the answer is not `{"remark": <string>}`. */
export async function askRemark(client: LlmClient, prompt: { system: string; user: string }, signal: AbortSignal): Promise<string> {
  const res = await client.complete({ ...prompt, signal, schema: REMARK_SCHEMA, maxTokens: REMARK_TOKENS, temperature: TEMPERATURE });
  if (res.stopReason !== "end_turn") throw new Error(`stop reason ${String(res.stopReason)}`);
  const data: unknown = JSON.parse(res.text);
  const remark = typeof data === "object" && data !== null ? (data as Record<string, unknown>)["remark"] : undefined;
  if (typeof remark !== "string") throw new Error("answer is not {remark: string}");
  return remark.trim();
}

/**
 * The model's remark for this decision, or null. Each temperature in turn is asked once; the first answer `remarkFault` passes is returned.
 * Never throws: a failed call, an abort or a refused answer all end in null, and the caller closes the minutes with a book line.
 */
export async function writeRemark(client: LlmClient, input: DecisionInput, rateBps: number, signal: AbortSignal): Promise<string | null> {
  const recent = input.memory?.remarks ?? [];
  const fact = factOf(rateBps, input.snapshot.policy.rateBps);
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (signal.aborted) break;
    try {
      const remark = await askRemark(client, buildRemarkPrompt(input, rateBps, recent, attempt), signal);
      if (remarkFault(remark, recent, fact) === null) return remark;
    } catch {
      // A failed call or a malformed answer is as good as a refused one: the next attempt, or the book.
    }
  }
  return null;
}
