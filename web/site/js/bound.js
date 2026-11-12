// The worst case the contract allows, stated plainly and from the contract's own numbers. Every figure in the "What if the Chair went rogue?"
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

/** The impeachment that already happened on the testnet: the first call after meeting 10 (event `impeached`, in this transaction). */
export const IMPEACHMENT = {
  tx: "CvqCjCU3ngrttKnZotBwPzczw6aVHTpkwPEZnYwwZqoD",
  epoch: 10,
  backing: "400,000",
  staked: "400,000",
  newChair: "challenger.chair-coin-2.testnet",
};

const MAX_MEETINGS = 100_000;

/**
 * What a Chair that holds the rate at the ceiling does to the supply, with the contract's own ramp (the rate moves at most `maxStepBps` a meeting)
 * and the supply limit. Floating point: these are "about" figures and are only ever shown rounded.
 */
export function worstCase({ maxRateBps, maxStepBps, epochMs, launchSupply }) {
  const meetingsPerHour = 3_600_000 / epochMs;
  const capMultiple = Number((MAX_TOTAL_SUPPLY * 1_000n) / launchSupply) / 1_000;
  let growth = 1;
  let rate = 0;
  let meetings = 0;
  while (growth < capMultiple && meetings < MAX_MEETINGS) {
    rate = Math.min(maxRateBps, rate + maxStepBps);
    growth *= 1 + rate / 10_000;
    meetings += 1;
  }
  return {
    perMeetingPct: maxRateBps / 100,
    perHour: (1 + maxRateBps / 10_000) ** meetingsPerHour,
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

/** The restraints, each `{ head, body }` built from the params; `body` ends without its transaction link, which the renderer adds to the first. */
export const RESTRAINTS = [
  {
    head: "Holders can fire the Chair.",
    body: (p) => `Anyone who stakes can back a challenger. A challenger with more than ${plainPct(p.impeachThresholdBps)} of the staked coins behind them (and more than ${plainPct(p.quorumBps)} of all coins) takes the seat at the next meeting. This has already happened on the testnet, at meeting ${IMPEACHMENT.epoch}. My own scripted accounts did it, not a crowd.`,
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

/** The section's text for the given chain values (`LAUNCH` fills what the chain has not said yet). */
export function boundText(params) {
  const p = { ...LAUNCH, ...params };
  const w = worstCase(p);
  return {
    lead: `The Chair can print at most ${plainPct(p.maxRateBps)} of all coins in one meeting, and a meeting comes ${everyEpoch(p.epochMs)}. It cannot jump to that ceiling: the rate moves at most ${plainPct(p.maxStepBps)} a meeting, so getting there takes ${w.rampMeetings} meetings.`,
    worst: `Held at the ceiling, the supply grows about ${sig(w.perHour, 2)} times an hour. The only hard stop is a supply limit written into the code, about ${grouped(sig(w.capMultiple, 2))} times the launch supply, which a Chair at the ceiling reaches in about ${grouped(near(w.capMeetings, 10))} meetings, roughly ${Math.round(w.capHours)} hours. That is hyperinflation, and the contract alone does not prevent it.`,
    restraints: RESTRAINTS.map((r) => ({ head: r.head, body: r.body(p) })),
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
    h(doc, "p", { class: "bound-worst" }, t.worst),
    h(doc, "p", { class: "bound-h" }, "Three things restrain it:"),
    h(doc, "ol", { class: "restraints" }, t.restraints.map((r, i) => h(doc, "li", {}, h(doc, "strong", {}, r.head), " ", r.body, i === 0 && proof !== null ? [" ", proof, "."] : null))),
  );
}
