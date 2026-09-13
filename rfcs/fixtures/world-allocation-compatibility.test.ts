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

function reservationErrors(section: string, occupied: readonly number[]): string[] {
  const errors: string[] = [];
  const lower = section.toLowerCase();
  if (!lower.includes("historical baseline")) errors.push("missing historical-baseline classification");
  if (!lower.includes("not an executable reservation")) {
    errors.push("missing current-main non-reservation statement");
  }
  if (/does not choose or reserve the next version/.test(lower) === false) {
    errors.push("note must not reserve the next version");
  }
  if (!section.includes("packages/core/src/ledger/db.ts")) {
    errors.push("missing live migration-chain authority");
  }
  if (/continues through version \d+/.test(section)) {
    errors.push("unqualified numeric current-tip claim");
  }
  for (const version of occupied) {
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
  expect(Math.max(...occupied)).toBeGreaterThanOrEqual(26);
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  expect(reservationErrors(section, BASELINE_LEDGER_VERSIONS)).toEqual([]);
});

test("current-main compatibility delegates the live ledger tip to the migration chain", () => {
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  expect(section).toContain("packages/core/src/ledger/db.ts");
  expect(section).not.toMatch(/continues through version \d+/);
  expect(reservationErrors(section, BASELINE_LEDGER_VERSIONS)).toEqual([]);
});

test("restoring an occupied baseline version as a current reservation fails the addendum", () => {
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  const counterexample = section.replace(
    "ledger 17 is occupied by `applyLedgerV16`",
    "ledger 17 remains reserved for implementation",
  );
  expect(reservationErrors(counterexample, BASELINE_LEDGER_VERSIONS).length).toBeGreaterThan(0);
});

test("an unqualified numeric current-tip claim fails the compatibility addendum", () => {
  const section = compatibilitySection(readFileSync(RFC, "utf8"));
  const stale = section.replace(
    "continues through the live migration chain in that file",
    "continues through version 26",
  );
  expect(reservationErrors(stale, BASELINE_LEDGER_VERSIONS)).toContain("unqualified numeric current-tip claim");
});
