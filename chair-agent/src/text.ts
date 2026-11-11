/**
 * Text that came from outside (the RPC node, a model) is never written to a terminal, an Error message or
 * the log as it arrived. Everything outside printable ASCII is escaped, so no escape sequence, line break,
 * or look-alike character survives, and the length is capped.
 */
export function sanitize(value: unknown, maxChars = 200): string {
  const s = typeof value === "string" ? value : String(value);
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0x20 && cp <= 0x7e ? ch : cp <= 0xff ? `\\x${cp.toString(16).padStart(2, "0")}` : `\\u{${cp.toString(16)}}`;
    if (out.length >= maxChars) return `${out.slice(0, maxChars)}...`;
  }
  return out;
}
