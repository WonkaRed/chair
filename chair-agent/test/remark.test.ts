import assert from "node:assert/strict";
import { test } from "node:test";
import type { LlmClient, LlmRequest, LlmResponse } from "../src/llm-chair.js";
import { BOOK } from "../src/press-book.js";
import { ATTEMPTS, bookLine, buildRemarkPrompt, EXAMPLES, factFault, factOf, MAX_CHARS, REMARK_MEMORY, REMARK_SCHEMA, remarkFault, writeRemark, type Fact } from "../src/remark.js";
import { CLOSING, FALLBACK_CLOSINGS } from "../src/rule-chair.js";
import type { DecisionInput } from "../src/types.js";
import { snapshot } from "./helpers.js";

/** A held rate that is printing. */
const HELD: Fact = { move: "same", sign: "printing" };
const GOOD = "The Chair has appointed a subcommittee of the Chair to look into the Chair.";

test("a dry one-sentence remark that names the Chair passes", () => {
  for (const text of [GOOD, "The Committee of One was consulted, and was, as always, not surprised.", "The Chair is pleased; the Committee is, in a quiet way, relieved."]) {
    assert.equal(remarkFault(text, [], HELD), null, text);
  }
});

test("the shape: 20 to 140 characters, plain letters and . , ' ; : ? - only, one sentence, a capital first, the Chair or the Committee named", () => {
  const fault = (text: string) => remarkFault(text, [], HELD);
  assert.match(fault("The Chair adjourns.")!, /length 19/);
  assert.match(fault(`The Chair ${"adjourns ".repeat(20)}.`)!, new RegExp(`length \\d+ is outside 20..${MAX_CHARS}`));
  assert.equal(fault(`The Chair ${"a".repeat(MAX_CHARS - 11)}.`), null, "exactly the longest allowed");
  assert.match(fault(`The Chair ${"a".repeat(MAX_CHARS - 10)}.`)!, /length 141/);
  for (const bad of [
    "The Chair has moved the rate by 5 bps today.", // digit
    "The Chair holds a steady 4% of everything.", // percent sign
    "The Chair sends regards to $CHAIR holders.", // dollar
    "The Chair says hello to @everyone present.", // at
    "The Chair files this under #recorded forever.", // hash
    "The Chair reads www.example.com every morning.", // a dot inside a word is a second sentence stop
    "The Chair said \"no comment\" to the Committee.", // double quote
    "The Chair said `no comment` to the Committee.", // backtick
    "'The Chair has no comment on this matter.'", // single quotes that wrap
    "The Chair has no comment on this matter.\nThe Committee agrees.", // line break
    "The Chair’s comment is that there is no comment.", // curly apostrophe
    "The Chair has no comment — none at all, really.", // em dash
    "The Chair has no comment on this matter \u{1F600}.", // emoji
    "The Chair has no comment on thé matter.", // accent
    "the Chair has no comment on this matter.", // lower-case start
    "The Chair has  no comment on this matter.", // double space
    "The Chair has no comment on this matter", // no end
    "The Chair has no comment. The Committee agrees.", // two sentences
    "The Chair has no comment... again.", // ellipsis
    "The Chair has no comment on this matter, ok?!", // run of marks
    "The Chair has nothing to add to the minutes!", // an exclamation mark
    "The rate was held after a long and careful meeting.", // names neither
  ]) {
    assert.notEqual(fault(bad), null, JSON.stringify(bad));
  }
  assert.equal(fault("The Chair's comment is that the Committee's silence is, in fact, golden-plated."), null, "an apostrophe inside a word and a hyphen are plain");
});

test("no advice or market talk, no profanity, no real names, no first or second person, no numbers in words", () => {
  const sentence = (word: string) => `The Chair has a feeling about ${word} that the Committee shares.`;
  for (const word of [
    "buying", "selling", "investors", "guaranteed", "profits", "prices", "moonshots", "rugpulls", "scams", "bullish", "pumps", "wealth",
    "fuck", "shitty", "bitch", "ass",
    "Trump", "Powell", "Lagarde", "Google", "Tesla", "Binance", "America", "Russia", "China", "Germany", "dollars", "euros", "bitcoin", "dogecoin", "Ethereum",
    "me", "my", "we", "our", "you", "your", "I",
    "six", "twenty", "hundredth", "twice", "consecutive",
  ]) {
    assert.notEqual(remarkFault(sentence(word), [], HELD), null, word);
  }
  assert.equal(remarkFault("The Committee called an assembly, and the Chair found it skilful.", [], HELD), null, "a word is refused for what it is, not for the letters it holds");
  assert.notEqual(remarkFault("The Chair found it was I who was missing.", [], HELD), null, "a contraction's first word counts");
  assert.notEqual(remarkFault("The Chair thanks the Committee for its trust; I'm touched.", [], HELD), null);
  assert.equal(remarkFault("The Chair has no one to dissent from, which the Committee of One finds restful.", [], HELD), null, "\"one\" is the Committee's own name");
});

test("a remark may not be a line the Chair already has: an example, the closing book, the rule's lines, the press book, or a recent remark", () => {
  const known = "a line the Chair has already said";
  for (const line of [...EXAMPLES, ...Object.values(CLOSING), "The Chair will not be taking questions."]) {
    assert.equal(remarkFault(line, [], HELD), /\bthe (?:chair|committee)\b/i.test(line) ? known : "names neither the Chair nor the Committee", line);
  }
  for (const line of BOOK) assert.notEqual(remarkFault(line, [], HELD), null, line);
  assert.equal(remarkFault(EXAMPLES[1]!.toUpperCase().replace(".", "?"), [], HELD), known, "case and punctuation do not make it new");
  assert.equal(remarkFault(`${EXAMPLES[1]!.slice(0, -1)}, said the Committee.`, [], HELD), known, "a copy with something added is still the copy");
  assert.equal(remarkFault(GOOD, [], HELD), null);
  const filler = Array.from({ length: 8 }, (_, i) => `Remark ${String.fromCharCode(97 + i)} by the Committee of One, in due course.`);
  assert.equal(remarkFault(GOOD, [GOOD.toLowerCase().replace(".", ""), ...filler], HELD), "a line the Chair has already said", "a remark of the last 20, however punctuated (older than the 8 whose openings count)");
  assert.match(remarkFault(GOOD, [...filler, GOOD], HELD)!, /opens with the same words/, "the latest: refused for its opening, which is the more general rule");
  // A short book line ("The motion carries unanimously.") is only repeated by an equal remark, not by a longer one that happens to hold its words.
  assert.equal(remarkFault("The Chair confirms the motion carries unanimously, in that order.", [], HELD), null);
});

test("what the rate did: a remark may not say it differently from what the Chair did, and may deny what it did not do", () => {
  const fault = (text: string, move: Fact["move"]) => remarkFault(text, [], { move, sign: "printing" });
  // A hold.
  assert.equal(fault("The Chair did not raise the rate, and the Committee of One has called this restraint.", "same"), null, "a true denial passes");
  assert.equal(fault("The Chair resisted the urge to lower the rate, and rewarded itself.", "same"), null);
  assert.equal(fault("The Chair held the rate, as the Committee had expected of the Chair.", "same"), null);
  assert.match(fault("The Chair raised the rate, to the Committee's mild surprise.", "same")!, /"raised"/);
  assert.match(fault("The Chair lowered the rate and lowered its voice.", "same")!, /"lowered"/);
  assert.match(fault("The Chair did not hold the rate, and the Committee agreed.", "same")!, /"hold"/, "a false denial is refused too");
  assert.match(fault("The Chair announces a change, and the Committee of One applauds.", "same")!, /"change"/);
  assert.equal(fault("The Chair announces no change, and the Committee of One applauds.", "same"), null);
  assert.match(fault("The Chair is printing more coins this meeting, to nobody's surprise but the Chair's.", "same")!, /"print/);
  // A rise.
  assert.equal(fault("The Chair raised the rate and then asked the Committee to forget it.", "up"), null);
  assert.equal(fault("The Chair did not cut the rate, which the Committee of One noted.", "up"), null);
  assert.match(fault("The Chair held the rate and asked the Committee to be impressed.", "up")!, /"held"/);
  assert.match(fault("The Chair did not raise the rate, said the Committee of One.", "up")!, /"raise"/);
  assert.match(fault("The Chair cut the rate with a very small pair of scissors.", "up")!, /"cut"/);
  assert.equal(fault("The Chair is printing more coins, which the Committee of One calls leadership.", "up"), null);
  // A fall.
  assert.equal(fault("The Chair cut the rate by a little, and thanked the Chair.", "down"), null);
  assert.match(fault("The Chair is printing less, and the Committee will have a word.", "up")!, /"print/);
  assert.match(fault("The Chair raised the rate and a glass to the Committee of One.", "down")!, /"raised"/);
  assert.equal(factFault("The Chair has the Committee's full confidence.", { move: "up", sign: "printing" }), null, "a remark that says nothing of the rate says nothing false");
  assert.deepEqual([factOf(5, 5), factOf(6, 5), factOf(4, 5), factOf(-3, 0), factOf(0, 0)], [
    { move: "same", sign: "printing" }, { move: "up", sign: "printing" }, { move: "down", sign: "printing" }, { move: "down", sign: "burning" }, { move: "same", sign: "neither" },
  ]);
});

test("what the rate is: a remark may not print when the Chair burns or burn when it prints, and on a rate of zero may only deny both", () => {
  const faultAt = (text: string, rate: number) => remarkFault(text, [], factOf(rate, rate));
  const burns = "The Chair burns the minutes, and the Committee of One approves.";
  const prints = "The Chair prints the minutes, and the Committee of One approves.";
  assert.equal(faultAt(prints, 24), null);
  assert.match(faultAt(burns, 24)!, /"burns"/);
  assert.equal(faultAt(burns, -24), null);
  assert.match(faultAt(prints, -24)!, /"prints"/);
  assert.match(faultAt("The Chair minted a fresh gavel, said the Committee of One.", -24)!, /"minted"/);
  assert.match(faultAt(prints, 0)!, /"prints"/);
  assert.match(faultAt(burns, 0)!, /"burns"/);
  assert.equal(faultAt("The Chair is neither printing nor burning, and the Committee of One is neither.", 0), null, "a denial is true of zero");
  assert.equal(faultAt("The Chair did not burn anything, and the Committee of One noticed.", 24), null, "a true denial passes");
  assert.match(faultAt("The Chair did not print anything, and the Committee of One noticed.", 24)!, /"print"/, "a false denial does not");
  assert.equal(faultAt("The Chair did not print anything, and the Committee of One noticed.", -24), null);
});

test("the word filter is not fooled by spelling: letters split by hyphens or spaces, and the slurs, market words and ordinals it once let through", () => {
  const sentence = (word: string) => `The Chair has a feeling about ${word} that the Committee shares.`;
  for (const word of ["f-u-c-k", "f u c k", "s-h-i-t", "sh-it", "fu-ck", "b-u-y"]) assert.notEqual(remarkFault(sentence(word), [], HELD), null, word);
  for (const word of ["twat", "wankers", "prick", "bollocks", "kike", "spic", "chinks", "gook", "coon", "tranny", "dykes"]) assert.notEqual(remarkFault(sentence(word), [], HELD), null, word);
  for (const word of ["soaring", "rally", "rallied", "crashed", "plunging", "surged", "pumped", "dumped", "gained", "returns", "federal", "reserves", "treasury", "Treasuries"]) {
    assert.notEqual(remarkFault(sentence(word), [], HELD), null, word);
  }
  assert.notEqual(remarkFault("The Chair has been to Wall Street, said the Committee of One.", [], HELD), null);
  for (const word of ["first", "second", "third", "eleventh", "twentieth", "hundredth", "times", "us", "yourself"]) assert.notEqual(remarkFault(sentence(word), [], HELD), null, word);
  assert.equal(remarkFault("The Chair seconded its own motion, to the Committee's quiet satisfaction.", [], HELD), null, "a longer word that starts like one is not it");
  assert.equal(remarkFault("The Chair has a well-worn gavel, a stool and a grudge against the Committee.", [], HELD), null, "plain hyphens and short words are fine");
  assert.equal(remarkFault("The Chair, a stickler, holds that a Committee of One is always quorate.", [], HELD), null, "single words 'a' are not a spelled-out run");
});

test("a remark may not open with the same four words as any of the last 8 remarks, and an older one is free to be echoed", () => {
  const text = "The Chair formally commends the quorum for attending, as is its custom.";
  assert.match(remarkFault(text, ["The Chair formally commends something else entirely, today."], HELD)!, /opens with the same words/);
  assert.match(remarkFault("THE CHAIR FORMALLY COMMENDS the quorum for attending?", ["the chair formally commends, and so on, and so on"], HELD)!, /opens with/);
  assert.equal(remarkFault(text, ["The Chair formally observes the quorum, quietly."], HELD), null, "three equal opening words are not four");
  const older = ["The Chair formally commends something else entirely, today.", ...Array.from({ length: 8 }, (_, i) => `Remark ${String.fromCharCode(97 + i)} by the Committee of One, in due course.`)];
  assert.equal(remarkFault(text, older, HELD), null, "ninth from last: out of reach");
  assert.match(remarkFault(text, older.slice(1).concat("The Chair formally commends the last one, too."), HELD)!, /opens with/);
});

test("the book: the closing lines are known, distinct and written for any decision, and one is chosen by meeting, in turn", () => {
  assert.equal(new Set(FALLBACK_CLOSINGS).size, FALLBACK_CLOSINGS.length);
  for (const line of FALLBACK_CLOSINGS) assert.ok(/^The [A-Za-z ]+\.$/.test(line) && line.length < MAX_CHARS, line);
  const picks = Array.from({ length: FALLBACK_CLOSINGS.length }, (_, i) => bookLine(100 + i));
  assert.deepEqual(new Set(picks).size, FALLBACK_CLOSINGS.length, "a run of meetings uses every line before it repeats");
  assert.equal(bookLine(5), bookLine(5 + FALLBACK_CLOSINGS.length));
});

const WINDOW = { lo: -50, hi: 50 };
const input = (o: { rate?: number; epoch?: number; memory?: DecisionInput["memory"] } = {}): DecisionInput => ({
  snapshot: snapshot({ epoch: o.epoch ?? 30, rate: o.rate ?? 24, supply: 1_000_000n, staked: 402_500n }),
  history: [{ epoch: 24, totalSupply: 1_000_000n }],
  window: WINDOW,
  ...(o.memory === undefined ? {} : { memory: o.memory }),
});

test("the remark prompt holds the persona and chain facts only: a fixed set of keys, and the only free text in it is the Chair's own earlier remarks", () => {
  const { system, user } = buildRemarkPrompt(input({ memory: { sameRateEpochs: 4, refusals: 1, remarks: ["The Chair has spoken."] } }), 24, ["The Chair has spoken."]);
  const data = JSON.parse(user) as Record<string, unknown>;
  assert.deepEqual(Object.keys(data).sort(), [
    "already_said", "coins_staked", "coins_staked_the_chair_would_like", "form_this_time", "meeting", "meetings_the_chair_has_held_this_rate",
    "supply", "the_rate_is_now", "this_meeting",
  ]);
  assert.deepEqual(data["already_said"], ["The Chair has spoken."]);
  assert.equal(data["coins_staked"], "40.25%");
  assert.equal(data["meetings_the_chair_has_held_this_rate"], 4);
  assert.equal(data["this_meeting"], "the Chair held the rate: it did not change");
  assert.equal(data["the_rate_is_now"], "printing 0.24%");
  assert.match(system, /deadpan parody of a central banker/);
  assert.match(system, /Committee of One/);
  for (const example of EXAMPLES) assert.ok(system.includes(example), "the tone guides are in the prompt");
  assert.doesNotMatch(system, /[–—\p{Extended_Pictographic}]/u);
  assert.ok(!/question|press|visitor/i.test(user), "nothing of the press desk");
});

test("the prompt tells a held rate from a changed one, a run from no run, and shows only the latest remarks", () => {
  const held = JSON.parse(buildRemarkPrompt(input({ rate: 24 }), 24, []).user) as Record<string, unknown>;
  assert.equal(held["meetings_the_chair_has_held_this_rate"], null, "no memory: no run");
  const moved = JSON.parse(buildRemarkPrompt(input({ rate: 24, memory: { sameRateEpochs: 9, refusals: 0, remarks: [] } }), 31, []).user) as Record<string, unknown>;
  assert.equal(moved["this_meeting"], "the Chair raised the rate");
  assert.equal(JSON.parse(buildRemarkPrompt(input({ rate: 24 }), 10, []).user)["this_meeting"], "the Chair lowered the rate");
  assert.equal(moved["meetings_the_chair_has_held_this_rate"], null, "a run belongs to a hold");
  const burn = JSON.parse(buildRemarkPrompt(input({ rate: 24 }), -10, []).user) as Record<string, unknown>;
  assert.equal(burn["the_rate_is_now"], "burning 0.10%");
  assert.equal(JSON.parse(buildRemarkPrompt(input(), 0, []).user)["the_rate_is_now"], "neither printing nor burning");
  const many = Array.from({ length: REMARK_MEMORY }, (_, i) => `Remark ${String.fromCharCode(97 + i)}.`);
  assert.deepEqual((JSON.parse(buildRemarkPrompt(input(), 24, many).user) as { already_said: string[] }).already_said, many.slice(-8));
  const forms = new Set(Array.from({ length: 8 }, (_, e) => (JSON.parse(buildRemarkPrompt(input({ epoch: e }), 24, []).user) as { form_this_time: string }).form_this_time));
  assert.equal(forms.size, 8, "a meeting's form changes with its number");
});

/** A model stand-in that answers each call from `answers` (a string is the remark, an Error is a failed call, anything else is the raw response). */
function model(answers: (string | Error | LlmResponse)[]): LlmClient & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    calls,
    complete: (req) => {
      calls.push(req);
      const a = answers[calls.length - 1] ?? new Error("no more answers");
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve(typeof a === "string" ? { text: JSON.stringify({ remark: a }), stopReason: "end_turn" } : a);
    },
  };
}
const live = new AbortController().signal;

test("a remark that passes is returned at once, from one call that carries the remark schema", async () => {
  const client = model([GOOD]);
  assert.equal(await writeRemark(client, input(), 24, live), GOOD);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0]!.temperature, 1);
  assert.deepEqual(client.calls[0]!.schema, REMARK_SCHEMA);
});

test("a refused remark is asked for once more, in the next form, and a second refusal ends in null: the book", async () => {
  const retried = model(["The Chair buys the dip.", GOOD]);
  assert.equal(await writeRemark(retried, input(), 24, live), GOOD);
  assert.equal(retried.calls.length, ATTEMPTS);
  assert.ok(retried.calls.every((c) => c.temperature === 1), "no call asks for more than 1, which some endpoints cap");
  const forms = retried.calls.map((c) => (JSON.parse(c.user) as { form_this_time: string }).form_this_time);
  assert.notEqual(forms[0], forms[1], "the retry asks for a different shape");
  const failed = model(["The Chair buys the dip.", "Too short."]);
  assert.equal(await writeRemark(failed, input(), 24, live), null);
  assert.equal(failed.calls.length, 2, "never a third call");
});

test("a remark equal to a recent one is refused, so the history in the log keeps the Chair from repeating itself", async () => {
  const client = model([GOOD, "The Chair declines to dissent from the Chair, again, with feeling."]);
  const memory = { sameRateEpochs: 0, refusals: 0, remarks: [GOOD] };
  assert.equal(await writeRemark(client, input({ memory }), 24, live), "The Chair declines to dissent from the Chair, again, with feeling.");
  assert.equal(client.calls.length, 2);
});

test("a failed call, a malformed answer or an unfinished one is never thrown: the book follows", async () => {
  for (const answer of [
    new Error("model down"),
    { text: "not json", stopReason: "end_turn" },
    { text: JSON.stringify({ remark: 5 }), stopReason: "end_turn" },
    { text: JSON.stringify([GOOD]), stopReason: "end_turn" },
    { text: JSON.stringify({ remark: GOOD }), stopReason: "max_tokens" },
    { text: JSON.stringify({ remark: GOOD }), stopReason: "refusal" },
    { text: "", stopReason: "end_turn" },
  ]) {
    const client = model([answer, answer]);
    assert.equal(await writeRemark(client, input(), 24, live), null, JSON.stringify(answer));
    assert.equal(client.calls.length, 2);
  }
});

test("an aborted call asks for nothing more", async () => {
  const ac = new AbortController();
  const client = model([new Error("aborted"), GOOD]);
  const first = writeRemark({ complete: (req) => { ac.abort(); return client.complete(req); } }, input(), 24, ac.signal);
  assert.equal(await first, null);
  assert.equal(client.calls.length, 1, "no second attempt after the abort");
  const already = model([GOOD]);
  ac.abort();
  assert.equal(await writeRemark(already, input(), 24, ac.signal), null);
  assert.equal(already.calls.length, 0);
});

test("the text is trimmed before it is judged", async () => {
  assert.equal(await writeRemark(model([`  ${GOOD}\n`]), input(), 24, live), GOOD);
});
