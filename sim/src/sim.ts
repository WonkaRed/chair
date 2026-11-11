import { MAX_IMPEACH_THRESHOLD_BPS, Policy, QUORUM_BPS, burnAmount, impeachmentWinner, mintAmount, pendingReward, rewardPerShareDelta, type Candidate } from "./model.js";

export const EPOCHS = 60;
export const TOKEN = 10n ** 24n;
export const INITIAL_SUPPLY = 1_000_000n * TOKEN;
/** Share of total staked held by each of the three stakers, in bps. */
export const STAKER_WEIGHTS_BPS = [5000n, 3000n, 2000n] as const;
/** contract/src/staking.rs `STAKE_LOCK_EPOCHS`: stake in epoch `e`, unstake from epoch `e + 2`; every stake restarts the lock on the whole of it. */
export const STAKE_LOCK_EPOCHS = 2;

/** What a chair sees when it decides. */
export interface ChairView {
  readonly epoch: number;
  readonly rateBps: number;
  readonly lastSetEpoch: number | null;
  readonly supply: bigint;
  readonly totalStaked: bigint;
}

/** A chair behavior: a rate to set this epoch, or null to stay silent. */
export type ChairPolicy = (v: ChairView) => number | null;

export type Vote =
  | { readonly epoch: number; readonly action: "nominate"; readonly candidate: string }
  /** `staker` indexes STAKER_WEIGHTS_BPS; the staker's whole stake backs `candidate`, and keeps backing it as the stake moves. */
  | { readonly epoch: number; readonly action: "back"; readonly staker: number; readonly candidate: string };

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** The share of (liquid + staked) supply the stakers aim to hold each epoch, bps: they raise stake to it at once and lower it only once unlocked. */
  readonly stakedBps: number;
  /** Liquid supply moved by transfers each epoch, bps, split into `transfersPerEpoch` equal transfers. */
  readonly velocityBps: number;
  readonly transfersPerEpoch: number;
  /** The sitting chair first; later entries are what a nominated candidate of that name does once in office. A candidate with no entry never acts. */
  readonly chairs: readonly { readonly name: string; readonly policy: ChairPolicy }[];
  /** Impeachment: share of total staked a candidate's backing must strictly exceed (the contract caps it at 5000). */
  readonly impeachThresholdBps: number;
  readonly votes: readonly Vote[];
}

export interface Row {
  readonly epoch: number;
  readonly chair: string;
  /** `set <rate>`, `silent`, or `rejected: <reason>`. */
  readonly action: string;
  readonly rateBps: number;
  readonly supply: bigint;
  readonly minted: bigint;
  readonly burned: bigint;
  readonly totalStaked: bigint;
  readonly stakedShareBps: number;
  readonly liquid: bigint;
  /** Minted tokens not yet paid to a staker: always the floor remainders once everyone has claimed. */
  readonly poolUnclaimed: bigint;
  /** Mean reward paid per staked token this epoch, in parts per million of the stake. */
  readonly rewardPerStakedPpm: bigint;
  readonly events: readonly string[];
}

export interface Result {
  readonly scenario: Scenario;
  readonly rows: readonly Row[];
  readonly totalMinted: bigint;
  readonly totalBurned: bigint;
}

/** Throws unless supply is conserved: it equals initial + minted - burned, and equals every balance bucket. */
export function assertConserved(r: { supply: bigint; liquid: bigint; staked: bigint; pool: bigint; minted: bigint; burned: bigint }): void {
  if (r.supply !== INITIAL_SUPPLY + r.minted - r.burned) throw new Error("supply != initial + minted - burned");
  if (r.supply !== r.liquid + r.staked + r.pool) throw new Error("supply != liquid + staked + unclaimed pool");
}

const silent: ChairPolicy = () => null;

export function run(sc: Scenario): Result {
  if (!Number.isInteger(sc.impeachThresholdBps) || sc.impeachThresholdBps < 1 || sc.impeachThresholdBps > MAX_IMPEACH_THRESHOLD_BPS) {
    throw new RangeError(`impeachThresholdBps must be an integer in 1..=${MAX_IMPEACH_THRESHOLD_BPS}, as the contract's \`new\` requires`);
  }
  const policy = new Policy();
  let supply = INITIAL_SUPPLY;
  let liquid = INITIAL_SUPPLY;
  const staked = STAKER_WEIGHTS_BPS.map(() => 0n);
  const paid = STAKER_WEIGHTS_BPS.map(() => 0n);
  const unlock = STAKER_WEIGHTS_BPS.map(() => 0);
  let rps = 0n;
  let pool = 0n;
  let mintedTotal = 0n;
  let burnedTotal = 0n;
  let chair = sc.chairs[0]!;
  let nextOrder = 1;
  const candidates: (Candidate & { backers: Set<number> })[] = [];
  const rows: Row[] = [];
  const sumStaked = (): bigint => staked.reduce((a, b) => a + b, 0n);

  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    const events: string[] = [];

    // Stakers claim (internal accounting, never burns), then move toward the scenario's staked share.
    staked.forEach((s, i) => {
      const owed = pendingReward(s, rps, paid[i]!);
      paid[i] = rps;
      liquid += owed;
      pool -= owed;
    });
    const target = ((liquid + sumStaked()) * BigInt(sc.stakedBps)) / 10_000n;
    // The last staker takes the rounding remainder, so the wanted stakes sum to exactly `target`.
    let assigned = 0n;
    staked.forEach((s, i) => {
      const want = i === staked.length - 1 ? target - assigned : (target * STAKER_WEIGHTS_BPS[i]!) / 10_000n;
      assigned += want;
      if (want > s) {
        const add = want - s < liquid ? want - s : liquid;
        if (add > 0n) {
          liquid -= add;
          staked[i] = s + add;
          unlock[i] = epoch + STAKE_LOCK_EPOCHS;
        }
      } else if (want < s && epoch >= unlock[i]!) {
        liquid += s - want;
        staked[i] = want;
      }
    });
    const totalStaked = sumStaked();

    // Votes of this epoch.
    for (const v of sc.votes.filter((x) => x.epoch === epoch)) {
      if (v.action === "nominate") {
        candidates.push({ id: v.candidate, backing: 0n, order: nextOrder++, backers: new Set() });
        events.push(`nominated ${v.candidate}`);
      } else {
        const c = candidates.find((x) => x.id === v.candidate);
        if (c === undefined || staked[v.staker]! === 0n) continue;
        for (const other of candidates) other.backers.delete(v.staker);
        c.backers.add(v.staker);
        events.push(`staker ${v.staker} (${Number(STAKER_WEIGHTS_BPS[v.staker]!) / 100}% of stake) backs ${c.id}`);
      }
    }

    // The chair acts.
    const actingChair = chair.name;
    const wanted = chair.policy({ epoch, rateBps: policy.rateBps, lastSetEpoch: policy.lastSetEpoch, supply, totalStaked });
    let action = "silent";
    if (wanted !== null) {
      const err = policy.setRate(epoch, wanted);
      action = err === null ? `set ${wanted}` : `rejected: ${err}`;
    }
    const rateInEffect = policy.rateBps;

    // Transfers during the epoch, each burning at the rate in effect.
    let burned = 0n;
    const per = (liquid * BigInt(sc.velocityBps)) / 10_000n / BigInt(sc.transfersPerEpoch);
    for (let t = 0; t < sc.transfersPerEpoch; t++) burned += burnAmount(per, rateInEffect);
    liquid -= burned;
    supply -= burned;
    burnedTotal += burned;

    // Boundary closing this epoch: mint at the pre-decay rate, then decay, then impeachment. The quorum is
    // counted on the supply as it stood before this mint.
    const supplyBeforeMint = supply;
    const minted = mintAmount(supply, rateInEffect, totalStaked);
    if (minted > 0n) {
      supply += minted;
      pool += minted;
      mintedTotal += minted;
      rps += rewardPerShareDelta(minted, totalStaked);
    }
    policy.decayAfter(epoch);
    const live: Candidate[] = candidates.map((c) => ({
      id: c.id, order: c.order, backing: [...c.backers].reduce((a, i) => a + staked[i]!, 0n),
    }));
    const winner = impeachmentWinner(live, sc.impeachThresholdBps, totalStaked, supplyBeforeMint);
    if (winner !== null) {
      events.push(
        `impeached ${chair.name}: ${winner.id} backed by ${(Number((winner.backing * 10_000n) / totalStaked) / 100).toFixed(1)}% of stake ` +
          `(threshold ${sc.impeachThresholdBps / 100}% of stake and ${QUORUM_BPS / 100}% of supply, both strictly exceeded); chair from epoch ${epoch + 1}`,
      );
      chair = sc.chairs.find((c) => c.name === winner.id) ?? { name: winner.id, policy: silent };
      candidates.length = 0;
    }

    assertConserved({ supply, liquid, staked: sumStaked(), pool, minted: mintedTotal, burned: burnedTotal });
    rows.push({
      epoch, chair: actingChair, action, rateBps: rateInEffect, supply, minted, burned, totalStaked,
      stakedShareBps: Number((totalStaked * 10_000n) / supply), liquid, poolUnclaimed: pool,
      rewardPerStakedPpm: totalStaked === 0n ? 0n : (minted * 1_000_000n) / totalStaked,
      events,
    });
  }
  return { scenario: sc, rows, totalMinted: mintedTotal, totalBurned: burnedTotal };
}
