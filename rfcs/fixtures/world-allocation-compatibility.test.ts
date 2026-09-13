/** Design-only check that RFC 0004 baseline ledger numbers are historical, not current reservations. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RFC = join(ROOT, "rfcs/0004-world-storage.md");
const DB = join(ROOT, "packages/core/src/ledger/db.ts");
const MARKER = "<!-- world-allocation-compatibility -->";
const BASELINE_LEDGER_VERSIONS = [17, 18, 19] as const;

function currentLedgerVersions(source: string): number[] {
  const versions = [...source.matchAll(/\{\s*version:\s*(\d+)/g)].map((match) => Number(match[1]));
  expect(versions.length).toBeGreaterThan(0);
  return versions;
}

function compatibilitySection(markdown: string): string {
  const at = markdown.indexOf(MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(at);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function reservationErrors(
  section: string,
  baseline: readonly number[],
  currentMax: number,
): string[] {
  const errors: string[] = [];
  const lower = section.toLowerCase();
  if (!lower.includes("historical baseline")) errors.push("missing historical-baseline classification");
  if (!lower.includes("not an executable reservation")) {
    errors.push("missing current-main non-reservation statement");
  }
  if (/does not choose or reserve the next version/.test(lower) === false) {
    errors.push("note must not reserve the next version");
  }
  if (!section.includes(`continues through version ${currentMax}`)) {
    errors.push(`RFC does not classify current max ledger ${currentMax} as occupied`);
  }
  for (const version of baseline) {
    if (!section.includes(`ledger ${version} is occupied`)) {
      errors.push(`ledger ${version} is not classified as occupied`);
    }
    if (new RegExp(`ledger ${version} remains reserved for implementation`, "i").test(section)) {
      errors.push(`ledger ${version} restored as a current reservation`);
    }
  }
  return errors;
}

test("occupied baseline ledger versions are classified as historical on current main", () => {
  const occupied = currentLedgerVersions(readFileSync(DB, "utf8"));
  for (const version of BASELINE_LEDGER_VERSIONS) {
    expect(occupied).toContain(version);
  }
  const currentMax = Math.max(...occupied);
  expect(currentMax).toBeGreaterThanOrEqual(26);
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  expect(reservationErrors(section, BASELINE_LEDGER_VERSIONS, currentMax)).toEqual([]);
});

test("restoring an occupied baseline version as a current reservation fails the addendum", () => {
  const occupied = currentLedgerVersions(readFileSync(DB, "utf8"));
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  const counterexample = section.replace(
    "ledger 17 is occupied by `applyLedgerV16`",
    "ledger 17 remains reserved for implementation",
  );
  expect(reservationErrors(counterexample, BASELINE_LEDGER_VERSIONS, Math.max(...occupied)).length).toBeGreaterThan(0);
});

test("a stale max occupancy sentence fails the addendum", () => {
  const occupied = currentLedgerVersions(readFileSync(DB, "utf8"));
  const currentMax = Math.max(...occupied);
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  const stale = section.replace(`continues through version ${currentMax}`, "continues through version 26");
  expect(reservationErrors(stale, BASELINE_LEDGER_VERSIONS, currentMax).length).toBeGreaterThan(0);
});
