// Time a test moves by hand: nothing here reads the real clock, so a test that waits on it can neither be slow nor fast.
import type { Clock } from "../src/rpc.js";

export class FakeClock implements Clock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fire: () => void }>();

  now(): number {
    return this.time;
  }

  after(ms: number, fire: () => void): () => void {
    const id = this.seq++;
    this.timers.set(id, { at: this.time + ms, fire });
    return () => void this.timers.delete(id);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => this.after(ms, resolve));
  }

  /** Moves time to the earliest timer and fires it; false when none is left. */
  private fireNext(): boolean {
    let first: number | undefined;
    for (const [id, t] of this.timers) if (first === undefined || t.at < this.timers.get(first)!.at) first = id;
    if (first === undefined) return false;
    const { at, fire } = this.timers.get(first)!;
    this.timers.delete(first);
    this.time = Math.max(this.time, at);
    fire();
    return true;
  }

  /** Runs `work` to its end: whenever everything that can run has run, time jumps to the next timer. Throws when it is waiting on nothing. */
  async run<T>(work: Promise<T>): Promise<T> {
    let over = false;
    work.then(() => (over = true), () => (over = true));
    for (;;) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (over) return work;
      if (!this.fireNext()) throw new Error("the work waits on nothing: no timer is left to fire");
    }
  }
}
