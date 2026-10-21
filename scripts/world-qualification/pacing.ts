/** Admission can lag the client request start. Pace from response completion instead. */
export const RESPONSE_GAP_MS = 61_000;
export interface PaceClock { now(): number; sleep(ms: number): Promise<void> }
export function responsePacer(clock: PaceClock, initialDelay = 0) {
  let next = clock.now() + Math.max(0, initialDelay);
  return {
    completed() { next = clock.now() + RESPONSE_GAP_MS; },
    async ready(stopped: () => boolean = () => false) {
      // Short sleeps make between-request stops responsive; an active turn is never aborted.
      while (!stopped() && clock.now() < next) await clock.sleep(Math.min(1000, next - clock.now()));
      return !stopped();
    },
  };
}
