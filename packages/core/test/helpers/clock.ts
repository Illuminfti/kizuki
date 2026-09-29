/**
 * A hand-driven clock for the recorded-time seams. Hand `now` to
 * `ClaimsIo.now` so `asserted_at` and `admitted_at` are exactly the times a
 * known-at test names, with no sleep and no wall-clock race. Time only moves
 * forward: recorded time is monotone, so a test that asks to go back has a
 * mistake worth failing on.
 */
export interface TestClock {
  /** The current instant. Reading it never moves it. */
  readonly now: () => string;
  /** Move forward by `ms` and return the new instant. */
  advance(ms: number): string;
  /** Jump forward to `at` (an ISO instant no earlier than now) and return it. */
  set(at: string): string;
}

const DEFAULT_START = "2026-01-01T00:00:00.000Z";

function instant(at: string): number {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) throw new RangeError(`clock: not an instant: ${at}`);
  return time;
}

export function testClock(start: string = DEFAULT_START): TestClock {
  let current = instant(start);
  const read = (): string => new Date(current).toISOString();
  return {
    now: read,
    advance(ms) {
      if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError("clock: advance by a non-negative whole number of ms");
      current += ms;
      return read();
    },
    set(at) {
      const next = instant(at);
      if (next < current) throw new RangeError("clock: time does not run backwards");
      current = next;
      return read();
    },
  };
}
