// Everything the chain, an indexer or a fixture supplies is untrusted text. It reaches the page only through
// `safeText` and `textContent`, never as markup. `safeText` makes controls, bidi marks and invisible formatting
// characters visible as \u{...} escapes, so no string can reorder, hide or forge what is displayed around it.

const HIDDEN =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u2028-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\ufffb]|[\u{e0000}-\u{e0fff}]/gu;

const escapeOne = (ch) => `\\u{${ch.codePointAt(0).toString(16)}}`;

/** `s` as text that is safe to show: hidden characters escaped, lone surrogates replaced, length capped. */
export function safeText(s, max = 200) {
  const str = typeof s === "string" ? s : String(s);
  const clean = str.toWellFormed().replace(HIDDEN, escapeOne);
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
/** A NEAR account id as the protocol defines it (2..=64 characters); anything else is not shown as an account. */
export const isAccountId = (v) => typeof v === "string" && v.length >= 2 && v.length <= 64 && ACCOUNT_RE.test(v);

const BASE58_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isTxHash = (v) => typeof v === "string" && BASE58_HASH_RE.test(v);

/** Account ids are shown verbatim when valid; otherwise escaped and capped, so a forged id cannot pass for a real one. */
export const showAccount = (v) => (isAccountId(v) ? v : `invalid id: ${safeText(v, 40)}`);

/** Like `safeText` for a passage: hidden characters are escaped, line breaks are kept, nothing is cut. */
export const safeLines = (s) => String(s).split("\n").map((line) => safeText(line, Infinity)).join("\n");
