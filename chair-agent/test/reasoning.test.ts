import assert from "node:assert/strict";
import { test } from "node:test";
import { HASH_RE, MAX_REASONING_CHARS, cleanReasoning, reasoningHash } from "../src/reasoning.js";

test("the hash is the SHA-256 of the UTF-8 text, lowercase hex (FIPS 180 vector for 'abc')", () => {
  assert.equal(reasoningHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.match(reasoningHash("\u00e9"), HASH_RE);
  // Same-looking text, different bytes, different hash: the hash is over the exact logged string.
  assert.notEqual(reasoningHash("\u00e9"), reasoningHash("e\u0301"));
});

test("cleanReasoning strips control, separator and bidi characters but keeps newlines", () => {
  const out = cleanReasoning("a\u0000b\u001bc\r\nd\u2028e\u202ef\u0085g\ud800h");
  assert.equal(out, "a b c\nd e f g\ufffdh");
});

test("cleanReasoning bounds length and rejects empty text", () => {
  assert.equal(cleanReasoning("   \n\t "), null);
  assert.equal(cleanReasoning(""), null);
  const long = cleanReasoning("x".repeat(10_000))!;
  assert.equal(long.length, MAX_REASONING_CHARS);
  assert.equal(cleanReasoning("😀".repeat(5000), 11)!.isWellFormed(), true);
});

test("cleanReasoning removes zero-width, direction-mark and invisible-operator characters (and the BOM) and keeps visible text intact", () => {
  const invisible = ["\u200b", "\u200c", "\u200d", "\u200e", "\u200f", "\u061c", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064", "\ufeff"];
  for (const ch of invisible) assert.equal(cleanReasoning(`a${ch}b`), "ab", `U+${ch.codePointAt(0)!.toString(16)}`);
  assert.equal(cleanReasoning("caf\u00e9 \u4e2d\u6587 \u{1f600}"), "caf\u00e9 \u4e2d\u6587 \u{1f600}");
  assert.equal(cleanReasoning("\u200b\u200f"), null);
});
