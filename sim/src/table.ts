import { MAX_RATE_BPS, MEETINGS_PER_DAY, perMeetingCurve } from "./model.js";
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

const DAY = Number(MEETINGS_PER_DAY);
const multiple = (supply: bigint, base: bigint): string => `${(Number((supply * 10_000_000_000n) / base) / 10_000_000_000).toFixed(6)}x`;
/** The most the supply can multiply over `epochs` meetings: every one mints the top rate's share of the supply it finds, unfloored. */
const boundAfter = (epochs: number): number => (1 + MAX_RATE_BPS / (10_000 * DAY)) ** epochs;

/** The largest growth of supply over any `DAY` consecutive epochs, as `supply[e] / supply[e - DAY]`, in parts per 10^10. */
export function maxDayGrowth(result: Result): { ratio: bigint; fromEpoch: number } {
  let best = { ratio: 0n, fromEpoch: 0 };
  for (let e = DAY; e < result.rows.length; e++) {
    const ratio = (result.rows[e]!.supply * 10_000_000_000n) / result.rows[e - DAY]!.supply;
    if (ratio > best.ratio) best = { ratio, fromEpoch: e - DAY };
  }
  return best;
}

/** One line per day of a multi-day run (the first three, then every seventh and the last): the supply the contract reaches against its bound and against the per-meeting rule it replaced. */
export function renderDaily(result: Result): string {
  const rows = result.rows;
  const days = Math.floor(rows.length / DAY);
  const old = perMeetingCurve(INITIAL_SUPPLY, rows.map((r) => r.rateBps));
  const heads = ["day", "epochs", "supply", "growth vs launch", "bound (1 + 200/9.6M)^n", "old rule, same rates"];
  const lines: string[][] = [];
  for (let day = 1; day <= days; day++) {
    if (day > 3 && day % 7 !== 0 && day !== days) continue;
    const end = day * DAY;
    const last = rows[end - 1]!;
    lines.push([
      String(day), `${end - DAY}-${end - 1}`, formatTokens(last.supply), multiple(last.supply, INITIAL_SUPPLY),
      `${boundAfter(end).toFixed(6)}x`, multiple(old[end - 1]!, INITIAL_SUPPLY),
    ]);
  }
  const widths = heads.map((h, i) => Math.max(h.length, ...lines.map((l) => l[i]!.length)));
  const fmt = (cells: readonly string[]): string => cells.map((c, i) => c.padStart(widths[i]!)).join("  ");
  const peak = maxDayGrowth(result);
  const hours = (n: number): string => `${multiple(old[n - 1]!, INITIAL_SUPPLY)} after ${(n * 90) / 3600} h`;
  return [
    `== ${result.scenario.title} [${result.scenario.id}] ==`,
    result.scenario.description,
    "",
    fmt(heads),
    ...lines.map(fmt),
    "",
    `largest growth over any ${DAY} consecutive epochs (24 h): ${multiple(peak.ratio, 10_000_000_000n)} (epochs ${peak.fromEpoch + 1}-${peak.fromEpoch + DAY}); the bound is ${boundAfter(DAY).toFixed(6)}x`,
    `the old per-meeting rule, same rates: ${[40, 480, 960].map(hours).join(", ")}`,
  ].join("\n");
}
