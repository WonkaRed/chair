// A stand-in chain and clock for the loop: the clock only moves when something sleeps or sends, and the chain's epoch is
// read off that clock, so hours of epochs pass in microseconds and nothing here ever waits.

import type { Chain, EpochInfo, Receipt } from "../src/chain.ts";
import type { Clock } from "../src/clock.ts";
import type { Log } from "../src/log.ts";
import { TOKEN, signerOf, type HolderAction, type HolderState, type World } from "../src/plan.ts";

export const EPOCH_MS = 90_000;
export const IDS = ["alice.t.testnet", "bob.t.testnet", "carol.t.testnet"] as const;

export class FakeClock implements Clock {
  time: number;
  readonly sleeps: number[] = [];
  /** Runs once per sleep, after the time has moved: a test's chance to abort or to change the chain. */
  onSleep: (clock: FakeClock) => void = () => undefined;
  constructor(start: number) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    this.sleeps.push(ms);
    this.time += ms;
    this.onSleep(this);
  }
}

export interface LogEntry {
  readonly at: number;
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

export class MemoryLog implements Log {
  readonly entries: LogEntry[] = [];
  private readonly clock: FakeClock;
  constructor(clock: FakeClock) {
    this.clock = clock;
  }

  write(fields: Record<string, unknown>, message: string): void {
    this.entries.push({ at: this.clock.now(), fields, message });
  }

  events(name: string): LogEntry[] {
    return this.entries.filter((e) => e.fields["event"] === name);
  }
}

export function holder(id: string, liquid: number, staked: number, pending = 0): HolderState {
  return { id, liquid: BigInt(liquid) * TOKEN, staked: BigInt(staked) * TOKEN, pending: BigInt(pending) * TOKEN, unlockEpoch: 0 };
}

/** Applies one action to `world` the way the contract would: a stake locks for two epochs, a claim pays the pending reward. */
export function applyAction(world: World, a: HolderAction): World {
  const holders = world.holders.map((h) => ({ ...h }));
  const get = (id: string) => holders.find((h) => h.id === id) as { -readonly [K in keyof HolderState]: HolderState[K] };
  const h = get(signerOf(a));
  let totalStaked = world.totalStaked;
  if (a.kind === "transfer") {
    h.liquid -= a.amount;
    get(a.to).liquid += a.amount;
  } else if (a.kind === "stake") {
    h.liquid -= a.amount;
    h.staked += a.amount;
    h.unlockEpoch = world.epoch + 2;
    totalStaked += a.amount;
  } else if (a.kind === "unstake") {
    h.staked -= a.amount;
    h.liquid += a.amount;
    totalStaked -= a.amount;
  } else {
    h.liquid += h.pending;
    h.pending = 0n;
  }
  return { ...world, totalStaked, holders };
}

/** Applies `plan`, then lets an epoch pass: stakers earn a thousandth of their stake as reward. */
export function applyPlan(world: World, plan: readonly HolderAction[]): World {
  const after = plan.reduce(applyAction, world);
  return { ...after, epoch: after.epoch + 1, holders: after.holders.map((h) => ({ ...h, pending: h.pending + h.staked / 1000n })) };
}

export interface FakeChainOptions {
  readonly near?: number;
  /** NEAR (as yocto) taken from the signer by every send. */
  readonly gasPerSend?: bigint;
  /** Time a send takes, in ms of fake clock. */
  readonly sendMs?: number;
}

/** A chain whose epoch is `floor(clock / EPOCH_MS)` and whose holders change as the contract would change them. */
export class FakeChain implements Chain {
  world0: World;
  readonly sent: { action: HolderAction; epoch: number }[] = [];
  readonly nearOf = new Map<string, bigint>();
  /** Reads that throw before the chain answers again. */
  readFailures = 0;
  /** Decides what a send does: returns a failure text to refuse it, throws to lose it, or undefined to let it through. */
  sendHook: (action: HolderAction, index: number) => string | undefined = () => undefined;
  private readonly clock: FakeClock;
  private readonly options: FakeChainOptions;
  constructor(clock: FakeClock, world: World, options: FakeChainOptions = {}) {
    this.clock = clock;
    this.world0 = world;
    this.options = options;
    for (const h of world.holders) this.nearOf.set(h.id, BigInt(Math.round((options.near ?? 1) * 1e6)) * 10n ** 18n);
  }

  private currentEpoch(): number {
    return Math.floor(this.clock.now() / EPOCH_MS);
  }

  private failRead(): void {
    if (this.readFailures > 0) {
      this.readFailures--;
      throw new Error("rpc: HTTP 503");
    }
  }

  async epochMs(): Promise<number> {
    return EPOCH_MS;
  }

  async epoch(): Promise<EpochInfo> {
    this.failRead();
    const epoch = this.currentEpoch();
    return { epoch, epochEndsMs: (epoch + 1) * EPOCH_MS };
  }

  async world(): Promise<World> {
    this.failRead();
    this.world0 = { ...this.world0, epoch: this.currentEpoch() };
    return this.world0;
  }

  async nearBalances(): Promise<ReadonlyMap<string, bigint>> {
    this.failRead();
    return new Map(this.nearOf);
  }

  async send(action: HolderAction): Promise<Receipt> {
    const index = this.sent.length;
    this.sent.push({ action, epoch: this.currentEpoch() });
    this.clock.time += this.options.sendMs ?? 0;
    const signer = signerOf(action);
    this.nearOf.set(signer, (this.nearOf.get(signer) as bigint) - (this.options.gasPerSend ?? 0n));
    const failure = this.sendHook(action, index);
    if (failure === undefined) this.world0 = applyAction({ ...this.world0, epoch: this.currentEpoch() }, action);
    return { hash: `hash${index}`, failure: failure ?? null };
  }
}
