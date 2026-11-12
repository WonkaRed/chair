// The 60-epoch simulation, run in the browser by the repo's own simulator (`sim/`, compiled by its own tsc and copied
// byte for byte into `vendor/sim/` by the build). Nothing here re-implements the model: it picks scenarios, calls `run`,
// and turns BigInt rows into the numbers a chart needs. `test/sim.test.mjs` checks them against the simulator's own export.
import { EPOCHS, INITIAL_SUPPLY, TOKEN, run } from "../vendor/sim/sim.js";
import { MEETINGS_PER_DAY } from "../vendor/sim/model.js";
import { SCENARIOS } from "../vendor/sim/scenarios.js";

/** The five chair behaviours the page compares, in the fixed order that fixes their colours. */
export const BEHAVIOURS = [
  { id: "honest-rule-chair", label: "Honest chair", note: "the shipped rule chair" },
  { id: "chair-goes-silent", label: "Silent chair", note: "eases to +150, then never acts again" },
  { id: "max-inflation", label: "Maximally inflationary", note: "+50 bps a step to the +200 bound" },
  { id: "max-deflation", label: "Maximally deflationary", note: "-50 bps a step to the -200 bound" },
  { id: "max-step-pusher", label: "Captured chair", note: "swings between +200 and -200 as fast as allowed" },
];

const pctOf = (n, d) => Number((n * 10_000n) / d) / 100;

export function simulate(ids = BEHAVIOURS.map((b) => b.id)) {
  const series = ids.map((id) => {
    const scenario = SCENARIOS.find((s) => s.id === id);
    if (scenario === undefined) throw new Error(`the simulator has no scenario ${id}`);
    const r = run(scenario);
    const meta = BEHAVIOURS.find((b) => b.id === id);
    return {
      id,
      label: meta?.label ?? scenario.title,
      note: meta?.note ?? "",
      description: scenario.description,
      params: { stakedBps: scenario.stakedBps, velocityBps: scenario.velocityBps, transfersPerEpoch: scenario.transfersPerEpoch },
      supplyPct: r.rows.map((x) => pctOf(x.supply, INITIAL_SUPPLY)),
      rateBps: r.rows.map((x) => x.rateBps),
      /** Reward per staked token in the epoch, as a percentage of the stake (the simulator reports parts per million). */
      rewardPct: r.rows.map((x) => Number(x.rewardPerStakedPpm) / 10_000),
      finalSupply: r.rows[EPOCHS - 1].supply,
      minted: r.totalMinted,
      burned: r.totalBurned,
    };
  });
  return { epochs: EPOCHS, initialSupply: INITIAL_SUPPLY, tokenBaseUnits: TOKEN, meetingsPerDay: Number(MEETINGS_PER_DAY), series };
}
