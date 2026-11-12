// The worst case the contract allows, stated plainly and from the contract's own numbers. Every figure in the "How bad could a rogue Chair get?"
// section comes from `worstCase`, and the restraints are one list (`RESTRAINTS`): to change or add a sentence, edit it here and nowhere else.
// Nothing is claimed that the contract does not enforce.
import { h } from "./dom.js";
import { everyEpoch } from "./views.js";

/** The contract's ceiling on total supply, `u128::MAX / 10_000` (contract/src/lib.rs `MAX_TOTAL_SUPPLY`). */
export const MAX_TOTAL_SUPPLY = ((1n << 128n) - 1n) / 10_000n;

/**
 * The deployed token's launch values (docs/testnet-deployment.json), used until the chain answers. The bounds are constants in the
 * contract (policy.rs `MAX_RATE_BPS`, `MAX_STEP_BPS`; rollover.rs `QUORUM_BPS`); the epoch length, launch supply and threshold are set at launch.
 */
export const LAUNCH = { maxRateBps: 200, maxStepBps: 50, epochMs: 90_000, launchSupply: 10n ** 30n, impeachThresholdBps: 3_000, quorumBps: 500 };

/** The impeachment that already happened on the testnet: the first call that went through after meeting 10 (event `impeached`, in this transaction). */
export const IMPEACHMENT = {
  tx: "6Wd6BQSZ7GdNYcD2sXkaubK86y4DSnAYeVWnT2SWE7Cn",
  epoch: 10,
  backing: "400,000",
  staked: "400,000",
  firstChair: "chair.chair-coin-3.testnet",
  newChair: "challenger.chair-coin-3.testnet",
};

/**
 * What an account is to the seat, said beside its name so that "the account that signed was not the chair" is not read as a contradiction: the account `get_policy`
 * names now (`sitting`) is the sitting Chair; the one the impeachment replaced is the first Chair. Any other account gets no label.
 */
export function seatRole(account, sitting) {
  if (typeof account !== "string") return null;
  if (account === sitting) return "sitting Chair";
  return account === IMPEACHMENT.firstChair ? `first Chair, voted out at meeting ${IMPEACHMENT.epoch}` : null;
}

/** A ramp of this many meetings is not the contract's (it takes `ceil(MAX_RATE_BPS / MAX_STEP_BPS)`); it only keeps a malformed `max_step_bps` of 0 from looping. */
const MAX_RAMP = 1_000;
const DAY_MS = 86_400_000;

/**
 * What a Chair that holds the rate at the ceiling does to the supply, with the contract's own ramp (the rate moves at most `maxStepBps` a meeting)
 * and the supply limit. `meetingsPerDay` is the chain's (`get_params`): under the per-day rule a meeting mints `rate / (10_000 * meetingsPerDay)` of the
 * supply; a token that does not report it is the older per-meeting rule, `meetingsPerDay = 1`. A span of `ms` holds at most `ceil(ms / epochMs)` meetings
 * (SPEC "The leash in numbers"). Floating point: these are "about" figures and are only ever shown rounded.
 */
export function worstCase({ maxRateBps, maxStepBps, epochMs, launchSupply, meetingsPerDay = null }) {
  const divisor = 10_000 * (meetingsPerDay ?? 1);
  const perMeeting = maxRateBps / divisor;
  const over = (ms) => (1 + perMeeting) ** Math.ceil(ms / epochMs);
  const capMultiple = Number((MAX_TOTAL_SUPPLY * 1_000n) / launchSupply) / 1_000;
  let growth = 1;
  let rate = 0;
  let meetings = 0;
  while (rate < maxRateBps && growth < capMultiple && meetings < MAX_RAMP) {
    rate = Math.min(maxRateBps, rate + maxStepBps);
    growth *= 1 + rate / divisor;
    meetings += 1;
  }
  if (growth < capMultiple) meetings += Math.ceil(Math.log(capMultiple / growth) / Math.log1p(perMeeting));
  return {
    perMeetingPct: perMeeting * 100,
    perHour: over(3_600_000),
    perDay: over(DAY_MS),
    perWeek: over(7 * DAY_MS),
    perMonth: over(30 * DAY_MS),
    rampMeetings: Math.ceil(maxRateBps / maxStepBps),
    capMultiple,
    capMeetings: meetings,
    capHours: (meetings * epochMs) / 3_600_000,
  };
}

/** Basis points as the plainest percent: 50 is "0.5%", 3000 is "30%". */
const plainPct = (bps) => `${bps / 100}%`;
const sig = (n, digits) => Number(n.toPrecision(digits));
const grouped = (n) => n.toLocaleString("en-US");
/** Round to the nearest `step` so a figure reads as the "about" it is: 529 meetings is "about 530". */
const near = (n, step) => Math.round(n / step) * step;
/** A long wait in the unit a reader thinks in: hours up to two days, days up to two months, then months, then years. */
function longSpan(hours) {
  const days = hours / 24;
  if (hours < 48) return `${Math.round(hours)} hours`;
  if (days < 60) return `${Math.round(days)} days`;
  const months = days / 30.44;
  return months < 24 ? `${Math.round(months)} months` : `${sig(months / 12, 2)} years`;
}

/** The restraints, each `{ head, body }` built from the params; `body` ends without its transaction link, which the renderer adds to the first. */
export const RESTRAINTS = [
  {
    head: "Holders can fire the Chair.",
    body: (p) => `Anyone who stakes can back a challenger. A challenger with more than ${plainPct(p.impeachThresholdBps)} of the staked coins behind them (and more than ${plainPct(p.quorumBps)} of all coins) takes the seat at the next meeting. This has already happened on the testnet, at meeting ${IMPEACHMENT.epoch}.`,
  },
  {
    head: "New coins go only to people who staked.",
    body: () => "Nothing is printed while nobody is staked, and every printed coin goes to the stakers: the same people who can fire the Chair. Holders who do not stake are diluted. Stake or be diluted.",
  },
  {
    head: "A silent Chair fades out.",
    body: (p) => `Each meeting without a decision moves the rate ${plainPct(p.maxStepBps)} toward zero, and at zero nothing is printed.`,
  },
];

/**
 * The section's text for the given chain values (`LAUNCH` fills what the chain has not said yet). A token that reports `meetingsPerDay` runs the per-day
 * rule; one that does not runs the older per-meeting rule, and gets the older, harsher text, because that is what its contract does.
 */
export function boundText(params) {
  const p = { ...LAUNCH, ...params };
  const w = worstCase(p);
  const perDay = p.meetingsPerDay !== undefined && p.meetingsPerDay !== null;
  const restraints = RESTRAINTS.map((r) => ({ head: r.head, body: r.body(p) }));
  const ramp = `the rate moves at most ${plainPct(p.maxStepBps)} a meeting, so getting there takes ${w.rampMeetings} meetings.`;
  if (!perDay) {
    return {
      lead: `The Chair can print at most ${plainPct(p.maxRateBps)} of all coins in one meeting, and a meeting comes ${everyEpoch(p.epochMs)}. It cannot jump to that ceiling: ${ramp}`,
      worst: `Held at the ceiling, the supply grows about ${sig(w.perHour, 2)} times an hour. The only hard stop is a supply limit written into the code, about ${grouped(sig(w.capMultiple, 2))} times the launch supply, which a Chair at the ceiling reaches in about ${grouped(near(w.capMeetings, 10))} meetings, roughly ${Math.round(w.capHours)} hours. That is hyperinflation, and the contract alone does not prevent it.`,
      figures: null,
      restraints,
    };
  }
  const times = (n) => `${sig(n, 3)} times`;
  return {
    lead: `The rate can never go above ${plainPct(p.maxRateBps)} a day. A meeting comes ${everyEpoch(p.epochMs)}, and each one prints only ${p.meetingsPerDay > 1 ? `1/${grouped(p.meetingsPerDay)} of ` : ""}that day's rate. It cannot jump to the ceiling either: ${ramp}`,
    worst: `Even if it holds the rate at the ceiling forever, the supply grows by at most about ${sig((w.perDay - 1) * 100, 3)}% a day: the ${plainPct(p.maxRateBps)} plus a little, because each meeting's new coins count toward the next. The only hard stop is a supply limit written into the code, about ${grouped(sig(w.capMultiple, 2))} times the launch supply.`,
    figures: [
      { k: "In a day", v: `+${sig((w.perDay - 1) * 100, 3)}%` },
      { k: "In a week", v: times(w.perWeek) },
      { k: "In 30 days", v: times(w.perMonth) },
      { k: "To the supply limit", v: `about ${longSpan(w.capHours)}` },
    ],
    restraints,
  };
}

/** `params` is the chain's (`parseParams`) with `launchSupply` from `get_supply`; anything missing falls back to `LAUNCH`. */
export function renderBound(doc, host, params = {}, { explorer = null } = {}) {
  while (host.firstChild) host.removeChild(host.firstChild);
  const known = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== null && v !== undefined));
  const t = boundText(known);
  const proof = explorer === null ? null : h(doc, "a", { href: `${explorer}/txns/${IMPEACHMENT.tx}`, rel: "noopener noreferrer", target: "_blank" }, "See the transaction");
  host.append(
    h(doc, "p", { class: "bound-lead" }, t.lead),
    h(doc, "p", { class: t.figures === null ? "bound-worst" : "bound-pace" }, t.worst),
    ...(t.figures === null ? [] : [h(doc, "dl", { class: "bound-figures" }, t.figures.map((f) => h(doc, "div", {}, h(doc, "dt", {}, f.k), h(doc, "dd", {}, f.v))))]),
    h(doc, "p", { class: "bound-h" }, "Three things restrain it:"),
    h(doc, "ol", { class: "restraints" }, t.restraints.map((r, i) => h(doc, "li", {}, h(doc, "strong", {}, r.head), " ", r.body, i === 0 && proof !== null ? [" ", proof, "."] : null))),
  );
}
