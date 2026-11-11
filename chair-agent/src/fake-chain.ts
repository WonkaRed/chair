// An in-memory stand-in for the token, used by the tests and the offline demo. It follows SPEC.md
// ("Methods", "Epochs and rollover") and is not the contract: sandbox-tests/ is where the real wasm
// is exercised. It exists so the chair can be driven through many epochs without a network.
import type { Reader } from "./chain.js";
import type { Submitter, SubmitResult } from "./signer.js";
import type { Decision, Params, Policy, Snapshot } from "./types.js";

const MAX_TOTAL_SUPPLY = (1n << 128n) / 10_000n - 1n;

export class FakeChain implements Reader, Submitter {
  readonly params: Params;
  nowMs: number;
  rateBps = 0;
  lastSetEpoch: number | null = null;
  chair: string;
  chairSince = 0;
  totalSupply: bigint;
  totalStaked: bigint;
  /** Set to false to model a contract that has no staking views yet. */
  hasStaking = true;
  /** Every `set_policy` that went through: what a `policy_set` event would carry. */
  readonly events: { epoch: number; rateBps: number; reasoningHash: string }[] = [];
  /** Every call the fake refused, with the SPEC panic message. */
  readonly refusals: string[] = [];
  private applied = 0;

  constructor(o: { chair: string; totalSupply: bigint; totalStaked: bigint; epochMs?: number; startMs?: number }) {
    const epochMs = o.epochMs ?? 60_000;
    const startMs = o.startMs ?? 1_700_000_000_000;
    this.params = { epochMs, startMs, maxRateBps: 200, maxStepBps: 50, impeachThresholdBps: 5000, nominateBond: 1n };
    this.nowMs = startMs;
    this.chair = o.chair;
    this.totalSupply = o.totalSupply;
    this.totalStaked = o.totalStaked;
  }

  get epoch(): number {
    return Math.max(0, Math.floor((this.nowMs - this.params.startMs) / this.params.epochMs));
  }

  /** Applies every boundary up to the new time, in order: mint at the closing epoch's rate, then decay. */
  advanceTo(nowMs: number): void {
    this.nowMs = nowMs;
    while (this.applied < this.epoch) {
      const closing = this.applied;
      if (this.rateBps > 0 && this.totalStaked > 0n) {
        const room = MAX_TOTAL_SUPPLY - this.totalSupply;
        const minted = (this.totalSupply * BigInt(this.rateBps)) / 10_000n;
        this.totalSupply += minted < room ? minted : room;
      }
      if (this.lastSetEpoch !== closing) this.rateBps -= Math.sign(this.rateBps) * Math.min(Math.abs(this.rateBps), 50); // SPEC step 2, written here on its own, not shared with bounds.ts
      this.applied++;
    }
  }

  advanceEpochs(n: number, intoEpochMs = 0): void {
    this.advanceTo(this.params.startMs + (this.epoch + n) * this.params.epochMs + intoEpochMs);
  }

  snapshot(): Promise<Snapshot> {
    const policy: Policy = {
      epoch: this.epoch,
      rateBps: this.rateBps,
      chair: this.chair,
      streak: this.epoch - this.chairSince,
      lastSetEpoch: this.lastSetEpoch,
      epochEndsMs: this.params.startMs + (this.epoch + 1) * this.params.epochMs,
    };
    return Promise.resolve({
      blockTimeMs: this.nowMs,
      params: this.params,
      policy,
      totalSupply: this.totalSupply,
      staking: this.hasStaking ? { totalStaked: this.totalStaked, rewardPool: 0n } : null,
    });
  }

  /** `set_policy` with the contract's checks in the contract's order; returns the panic text or null. */
  setPolicy(caller: string, rateBps: number, reasoningHash: string): string | null {
    const { maxRateBps, maxStepBps } = this.params;
    let panic: string | null = null;
    if (caller !== this.chair) panic = "only the chair may set policy";
    else if (reasoningHash.length < 1 || reasoningHash.length > 128) panic = "reasoning_hash must be 1..=128 bytes";
    else if (this.lastSetEpoch === this.epoch) panic = "policy already set this epoch";
    else if (!Number.isInteger(rateBps) || Math.abs(rateBps) > maxRateBps) panic = `rate_bps out of bounds: must be within -${maxRateBps}..=${maxRateBps}`;
    else if (Math.abs(rateBps - this.rateBps) > maxStepBps) panic = "rate step too large: must move at most 50 bps from the current rate";
    if (panic !== null) {
      this.refusals.push(panic);
      return panic;
    }
    this.rateBps = rateBps;
    this.lastSetEpoch = this.epoch;
    this.events.push({ epoch: this.epoch, rateBps, reasoningHash });
    return null;
  }

  submit(d: Decision): Promise<SubmitResult> {
    const failure = this.setPolicy(this.chair, d.rate, d.reasoningHash);
    return Promise.resolve({ txHash: `fake-tx-${this.events.length}-${this.refusals.length}`, failure });
  }
}
