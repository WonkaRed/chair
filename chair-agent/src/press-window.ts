/** Keys kept before the expired ones are swept: a crowd of one-off addresses cannot grow the map without bound. */
const SWEEP_AT = 5_000;

/** At most `max` hits per key in the last `windowMs`. */
export class SlidingWindow {
  private readonly hits = new Map<string, number[]>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  private live(key: string, now: number): number[] {
    const live = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (live.length === 0) this.hits.delete(key);
    else this.hits.set(key, live);
    return live;
  }

  /** Milliseconds until `key` may hit again; 0 when it may now. */
  waitMs(key: string, now: number): number {
    const live = this.live(key, now);
    return live.length < this.max ? 0 : live[live.length - this.max]! + this.windowMs - now;
  }

  hit(key: string, now: number): void {
    if (this.hits.size > SWEEP_AT) for (const k of [...this.hits.keys()]) this.live(k, now);
    this.hits.set(key, [...this.live(key, now), now]);
  }
}

/** One job at a time; at most `maxWaiting` more may wait. */
export class SerialQueue {
  private waiting = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly maxWaiting: number) {}

  get hasRoom(): boolean {
    return this.waiting < this.maxWaiting;
  }

  run<T>(job: () => Promise<T>): Promise<T> {
    this.waiting++;
    const result = this.tail.then(() => {
      this.waiting--;
      return job();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
