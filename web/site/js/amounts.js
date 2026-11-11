// $CHAIR has 24 decimals (SPEC "Parameters"). All arithmetic is BigInt; Number is used only for drawing.

export const DECIMALS = 24;
export const UNIT = 10n ** 24n;
const U128_MAX = (1n << 128n) - 1n;

/** A U128 decimal string as the contract writes it; throws on anything else (no sign, no leading zeros, no overflow). */
export function parseU128(v, what = "amount") {
  if (typeof v !== "string" || !/^(0|[1-9]\d{0,38})$/.test(v)) throw new TypeError(`${what}: not a U128 decimal string`);
  const n = BigInt(v);
  if (n > U128_MAX) throw new RangeError(`${what}: exceeds u128`);
  return n;
}

const group = (digits) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** Whole tokens with up to `places` decimals, trailing zeros dropped; below 10^-places shows base units instead. */
export function formatTokens(n, places = 4) {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / UNIT;
  const frac = (abs % UNIT).toString().padStart(DECIMALS, "0");
  const shown = frac.slice(0, places).replace(/0+$/, "");
  if (whole === 0n && abs !== 0n && shown === "") return `${neg ? "-" : ""}${group(abs.toString())} base units`;
  return `${neg ? "-" : ""}${group(whole.toString())}${shown ? `.${shown}` : ""}`;
}

/** Exact value for a tooltip: every digit, in base units. */
export const formatExact = (n) => `${n.toString()} base units`;

/** `n / d` as a Number in [0, 1e15) with two decimals, for charts only. */
export function ratioPct(n, d) {
  if (d === 0n) return 0;
  return Number((n * 10_000n) / d) / 100;
}
