/**
 * The port's own clock and its rate window. Both are here rather than in the
 * port so the class that speaks to an endpoint holds one responsibility: the
 * window is a bound on a host-bound singleton, and proving it holds under
 * concurrent calls is a separate argument from anything about a request.
 */

export interface Clock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Monotonic, so a deadline cannot be moved by an NTP correction or a resume
 * from suspend. Nothing here is persisted or compared with a wall clock.
 */
export const defaultClock: Clock = {
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

export const RATE_WINDOW_MS = 60_000;

/**
 * A sliding window of the requests made in the last minute. `take` hands back
 * the time a request may go out at, or `null` when waiting for a slot would
 * run past the caller's deadline.
 */
export class RateWindow {
  private readonly slots: number[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly clock: Clock,
    private readonly perMinute: number,
  ) {}

  /**
   * One caller at a time reads the window and takes a slot in it. Without the
   * queue every concurrent call passed the same check before any of them had
   * recorded a request, and nothing in `kizuki.llm/v1` says a call is
   * single-flight.
   */
  async take(deadline: number): Promise<number | null> {
    const taken = this.queue.then(
      () => this.waitForSlot(deadline),
      () => this.waitForSlot(deadline),
    );
    // The queue outlives a failed call: a rejection here is the caller's.
    this.queue = taken.then(
      () => undefined,
      () => undefined,
    );
    return await taken;
  }

  /** Give back a slot whose request never left. */
  release(at: number): void {
    const index = this.slots.lastIndexOf(at);
    if (index >= 0) this.slots.splice(index, 1);
  }

  /**
   * The wait is clamped to the window so a backward clock step (an NTP
   * correction, a resume from suspend) cannot park a run for the size of the
   * step. Waiting is part of the call, so it is spent from the same deadline
   * rather than added on top of it.
   */
  private async waitForSlot(deadline: number): Promise<number | null> {
    this.prune();
    const oldest = this.slots[0];
    if (this.slots.length >= this.perMinute && oldest !== undefined) {
      const wait = Math.max(
        0,
        Math.min(oldest + RATE_WINDOW_MS - this.clock.now(), RATE_WINDOW_MS),
      );
      if (this.clock.now() + wait > deadline) return null;
      await this.clock.sleep(wait);
      this.prune();
    }
    // Taken here, with no await between the check above and this line.
    const at = this.clock.now();
    this.slots.push(at);
    return at;
  }

  private prune(): void {
    const cutoff = this.clock.now() - RATE_WINDOW_MS;
    while (this.slots.length > 0 && (this.slots[0] ?? 0) <= cutoff) {
      this.slots.shift();
    }
  }
}
