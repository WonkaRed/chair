import { createHash } from "node:crypto";

/** What `set_policy` accepts as `reasoning_hash` (policy.rs `is_sha256_hex`): a SHA-256 digest as 64 lowercase hex characters. */
export const HASH_RE = /^[0-9a-f]{64}$/;

/** Cap on the text a decision may carry. Model output is cut, never trusted to be short. */
export const MAX_REASONING_CHARS = 2000;

/** `reasoning_hash` as sent on chain: SHA-256 of the UTF-8 bytes of the logged text, lowercase hex. */
export function reasoningHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Normalizes text from a chair before it is hashed and logged: no control, bidi or invisible formatting
 * characters other than newline, no lone surrogates, trimmed, bounded. The hash is of this text exactly. Returns null when nothing printable is left.
 */
export function cleanReasoning(raw: string, maxChars = MAX_REASONING_CHARS): string | null {
  const text = raw
    .toWellFormed()
    .replace(/\r\n?/g, "\n")
    // Control characters except \n, line/paragraph separators, and bidi overrides become spaces.
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    // Invisible formatting characters (zero-width, direction marks, invisible operators, BOM) are removed.
    .replace(/[\u200b-\u200f\u061c\u2060-\u2064\ufeff]/g, "")
    .trim();
  if (text.length === 0) return null;
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1).toWellFormed()}…`;
}
