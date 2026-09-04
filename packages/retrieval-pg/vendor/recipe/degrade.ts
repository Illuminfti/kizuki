/**
 * Declared-degradation envelope, forked from the public tip hybrid
 * search. Stages are set-like: each code is appended at most once.
 * Unavailable is never represented as an empty hit list without a
 * degraded entry.
 */

export function pushDegraded(degraded: string[], stage: string): void {
  if (stage.length === 0 || stage.length > 256) return;
  if (!degraded.includes(stage)) degraded.push(stage);
}
