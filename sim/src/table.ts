import { INITIAL_SUPPLY, TOKEN, type Result, type Row } from "./sim.js";

/** Whole tokens with two decimals, e.g. 1_234.56. Base units are 10^-24 of a token. */
export function formatTokens(units: bigint): string {
  const negative = units < 0n;
  const hundredths = (negative ? -units : units) / (TOKEN / 100n);
  const whole = (hundredths / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${whole}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

const pct = (bps: number): string => `${(bps / 100).toFixed(1)}%`;

const COLUMNS: readonly { head: string; right: boolean; cell: (r: Row) => string }[] = [
  { head: "epoch", right: true, cell: (r) => String(r.epoch) },
  { head: "chair", right: false, cell: (r) => r.chair },
  { head: "action", right: false, cell: (r) => r.action },
  { head: "rate bps", right: true, cell: (r) => String(r.rateBps) },
  { head: "supply", right: true, cell: (r) => formatTokens(r.supply) },
  { head: "minted", right: true, cell: (r) => formatTokens(r.minted) },
  { head: "burned", right: true, cell: (r) => formatTokens(r.burned) },
  { head: "staked", right: true, cell: (r) => pct(r.stakedShareBps) },
];

/** Epochs worth a line in the compact view: every fifth, the last, and any with an event. */
const shown = (r: Row, last: number): boolean => r.epoch % 5 === 0 || r.epoch === last || r.events.length > 0;

export function renderTable(result: Result, all: boolean): string {
  const rows = all ? result.rows : result.rows.filter((r) => shown(r, result.rows.length - 1));
  const cells = rows.map((r) => COLUMNS.map((c) => c.cell(r)));
  const widths = COLUMNS.map((c, i) => Math.max(c.head.length, ...cells.map((row) => row[i]!.length)));
  const line = (row: readonly string[]): string =>
    row.map((v, i) => (COLUMNS[i]!.right ? v.padStart(widths[i]!) : v.padEnd(widths[i]!))).join("  ").trimEnd();
  const out = [`== ${result.scenario.title} [${result.scenario.id}] ==`, result.scenario.description, ""];
  out.push(line(COLUMNS.map((c) => c.head)), line(widths.map((w) => "-".repeat(w))), ...cells.map(line));
  for (const r of result.rows) for (const e of r.events) out.push(`  epoch ${r.epoch}: ${e}`);
  const final = result.rows[result.rows.length - 1]!;
  const change = ((final.supply - INITIAL_SUPPLY) * 10_000n) / INITIAL_SUPPLY;
  out.push(
    `  minted ${formatTokens(result.totalMinted)}  burned ${formatTokens(result.totalBurned)}  ` +
      `final supply ${formatTokens(final.supply)} (${Number(change) / 100}% vs start)`,
  );
  return out.join("\n");
}
