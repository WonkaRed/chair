import { EPOCHS, INITIAL_SUPPLY, STAKER_WEIGHTS_BPS, TOKEN, type Result } from "./sim.js";

/** Shape of out/scenarios.json; documented in README.md. Every amount is a decimal string of base units. */
export interface ScenariosFile {
  readonly schema: "chair-sim/1";
  readonly epochs: number;
  readonly tokenBaseUnits: string;
  readonly initialSupply: string;
  readonly stakerWeightsBps: readonly number[];
  readonly scenarios: readonly unknown[];
}

export function toJson(results: readonly Result[]): ScenariosFile {
  return {
    schema: "chair-sim/1",
    epochs: EPOCHS,
    tokenBaseUnits: TOKEN.toString(),
    initialSupply: INITIAL_SUPPLY.toString(),
    stakerWeightsBps: STAKER_WEIGHTS_BPS.map(Number),
    scenarios: results.map((r) => {
      const last = r.rows[r.rows.length - 1]!;
      const sc = r.scenario;
      return {
        id: sc.id,
        title: sc.title,
        description: sc.description,
        params: {
          stakedBps: sc.stakedBps,
          velocityBps: sc.velocityBps,
          transfersPerEpoch: sc.transfersPerEpoch,
          impeachThresholdBps: sc.impeachThresholdBps,
          chairs: sc.chairs.map((c) => c.name),
        },
        totals: { minted: r.totalMinted.toString(), burned: r.totalBurned.toString(), finalSupply: last.supply.toString() },
        rows: r.rows.map((row) => ({
          epoch: row.epoch,
          chair: row.chair,
          action: row.action,
          rateBps: row.rateBps,
          supply: row.supply.toString(),
          minted: row.minted.toString(),
          burned: row.burned.toString(),
          totalStaked: row.totalStaked.toString(),
          stakedShareBps: row.stakedShareBps,
          liquid: row.liquid.toString(),
          poolUnclaimed: row.poolUnclaimed.toString(),
          rewardPerStakedPpm: row.rewardPerStakedPpm.toString(),
          events: row.events,
        })),
      };
    }),
  };
}
