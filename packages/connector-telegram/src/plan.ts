import type { CaptureEventInput } from "@kizuki/core";

/** Source record ids retained per subject before the oldest are dropped. */
export const MAX_PLAN_IDS = 10_000;

/**
 * What this connector emitted, per subject, since its latest from-null sweep. It
 * backs `purgeSource`, which names Kizuki's copies; Telegram's own copies are
 * not reachable from the client API and the plan never pretends otherwise.
 */
export class PurgeIndex {
  readonly #bySubject = new Map<string, Set<string>>();
  readonly #truncated = new Set<string>();

  reset(): void { this.#bySubject.clear(); this.#truncated.clear(); }

  truncated(subject_id: string): boolean { return this.#truncated.has(subject_id); }

  record(event: CaptureEventInput): void {
    for (const subject of event.subjects) {
      let ids = this.#bySubject.get(subject.subject_id);
      if (ids === undefined) {
        ids = new Set<string>();
        this.#bySubject.set(subject.subject_id, ids);
      }
      ids.delete(event.source_record_id);
      ids.add(event.source_record_id);
      // Keep the newest but retain a truncation witness. Local ledger erasure
      // has its own subject scope; this source plan must remain incomplete.
      for (const oldest of ids) {
        if (ids.size <= MAX_PLAN_IDS) break;
        ids.delete(oldest);
        this.#truncated.add(subject.subject_id);
      }
    }
  }

  forSubject(subject_id: string): string[] {
    const ids = this.#bySubject.get(subject_id);
    return ids === undefined ? [] : [...ids].sort();
  }
}
