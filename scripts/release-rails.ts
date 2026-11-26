/**
 * Rail ids the packaged doctor must report. Release scripts stay free of the
 * product import graph so source custody can enumerate them; the sibling test
 * `packages/cli/test/doctor/release-rail-ids.test.ts` pins this list to the
 * registry.
 */
export const RELEASE_RAIL_IDS: readonly string[] = Object.freeze([
  "sync", "retrieval-sweep", "purge-sweep", "embed-backfill", "brief",
  "doctor-sweep", "journal-prune", "backup", "verify-world",
]);
