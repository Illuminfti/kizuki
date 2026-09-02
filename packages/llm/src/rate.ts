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
 * How long one call may run. Queueing for a rate slot is this host's own
 * backpressure, not the endpoint's latency, so the wait extends the call's
 * deadline instead of being spent from it: charged to the request, a wait
 * left a throttled call a fraction of its configured timeout and the cut-off
 * answer reached the caller as a model outage. The extension is capped at one
 * window, so a call stays bounded by `deadline_ms + RATE_WINDOW_MS`.
 */
export class CallDeadline {
  private credited = 0;

  constructor(private end: number) {}

  /** The instant the call is over, waits credited so far included. */
  get at(): number {
    return this.end;
  }

  /** The furthest a wait for a slot may reach, on the credit left to give. */
  get rateBound(): number {
    return this.end + (RATE_WINDOW_MS - this.credited);
  }

  credit(waited: number): void {
    const given = Math.min(waited, RATE_WINDOW_MS - this.credited);
    if (given > 0) {
      this.credited += given;
      this.end += given;
    }
  }
}

/** A slot in the window, and what waiting for it cost. */
export interface RateSlot {
  readonly at: number;
  readonly waited: number;
}

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
  async take(deadline: number): Promise<RateSlot | null> {
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
   * step. What the wait cost is reported rather than swallowed, so the caller
   * can credit it back to the deadline it holds.
   */
  private async waitForSlot(deadline: number): Promise<RateSlot | null> {
    this.prune();
    const oldest = this.slots[0];
    let waited = 0;
    if (this.slots.length >= this.perMinute && oldest !== undefined) {
      const wait = Math.max(
        0,
        Math.min(oldest + RATE_WINDOW_MS - this.clock.now(), RATE_WINDOW_MS),
      );
      if (this.clock.now() + wait > deadline) return null;
      await this.clock.sleep(wait);
      waited = wait;
      this.prune();
    }
    // Taken here, with no await between the check above and this line.
    const at = this.clock.now();
    this.slots.push(at);
    return { at, waited };
  }

  private prune(): void {
    const cutoff = this.clock.now() - RATE_WINDOW_MS;
    while (this.slots.length > 0 && (this.slots[0] ?? 0) <= cutoff) {
      this.slots.shift();
    }
  }
}
