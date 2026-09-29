/** Design-only check that RFC 0004 baseline ledger numbers are historical, not current reservations. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const RFC = join(ROOT, "rfcs/0004-world-storage.md");
const PARENT = join(ROOT, "rfcs/0004-living-epistemic-world-model.md");
const DB = join(ROOT, "packages/core/src/ledger/db.ts");
const MARKER = "<!-- world-allocation-compatibility -->";
const PARENT_MIGRATION = "## Migration, recovery and export";
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

function markdownSection(markdown: string, heading: string): string {
  const at = markdown.indexOf(heading);
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

function parentReservationErrors(section: string, occupied: readonly number[]): string[] {
  const errors: string[] = [];
  const compact = section.toLowerCase().replace(/\s+/g, " ");
  if (!compact.includes("pinned baseline")) errors.push("missing baseline qualification");
  if (!compact.includes("collision consumes a fresh version")) {
    errors.push("missing fresh-version-on-collision rule");
  }
  if (!compact.includes("never different ddl under an already used number")) {
    errors.push("missing already-used-number collision rule");
  }
  for (const version of occupied) {
    if (new RegExp(`ledger ${version} remains reserved for implementation`, "i").test(section)) {
      errors.push(`parent restored ledger ${version} as a current reservation`);
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

test("parent and storage appendix cannot disagree about current ledger reservations", () => {
  const occupied = currentLedgerVersions(readFileSync(DB, "utf8"));
  const appendix = compatibilitySection(readFileSync(RFC, "utf8"));
  const parent = markdownSection(readFileSync(PARENT, "utf8"), PARENT_MIGRATION);
  expect(reservationErrors(appendix, BASELINE_LEDGER_VERSIONS)).toEqual([]);
  expect(parentReservationErrors(parent, occupied)).toEqual([]);

  const reserved = parent.replace(
    "a collision consumes a fresh\nversion through review, never different DDL under an already used number.",
    "ledger 17 remains reserved for implementation.",
  );
  expect(parentReservationErrors(reserved, BASELINE_LEDGER_VERSIONS)).toContain(
    "parent restored ledger 17 as a current reservation",
  );
  expect(reservationErrors(appendix, BASELINE_LEDGER_VERSIONS)).toEqual([]);

  const unpinned = parent.replace("pinned baseline", "current main");
  expect(parentReservationErrors(unpinned, BASELINE_LEDGER_VERSIONS)).toContain("missing baseline qualification");

  const noCollision = parent.replace(
    "a collision consumes a fresh\nversion through review, never different DDL under an already used number.",
    "reuse the occupied number.",
  );
  expect(parentReservationErrors(noCollision, BASELINE_LEDGER_VERSIONS)).toEqual(
    expect.arrayContaining([
      "missing fresh-version-on-collision rule",
      "missing already-used-number collision rule",
    ]),
  );
});

const SHIPPED_MARKER = "<!-- world-shipped-subset -->";
const CLAIMS_SCHEMA = join(ROOT, "packages/core/src/claims/schema.ts");
const PURGE_SCHEMA = join(ROOT, "packages/core/src/ledger/purge-schema.ts");
const CORE_SRC = join(ROOT, "packages/core/src");
const SHIPPED_LEDGER_VERSIONS = [31, 32, 33] as const;
const ALLOCATION_CLASSES = new Set(["authority", "bookkeeping", "derived", "cache"]);
const FIRST_EXPANSION_VERSION = 34;

function shippedSubsetSection(markdown: string): string {
  const at = markdown.indexOf(SHIPPED_MARKER);
  expect(at).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(at);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function migrationFunction(source: string, version: number): string | null {
  const match = new RegExp(`\\{\\s*version:\\s*${version},\\s*apply:\\s*(\\w+)`).exec(source);
  return match?.[1] ?? null;
}

function shippedErrors(section: string, dbSource: string): string[] {
  const errors: string[] = [];
  for (const version of SHIPPED_LEDGER_VERSIONS) {
    const fn = migrationFunction(dbSource, version);
    if (fn === null) {
      errors.push(`ledger ${version} is not in the live migration chain`);
      continue;
    }
    if (!section.includes(`ledger ${version} is applied by \`${fn}\``)) {
      errors.push(`ledger ${version} is not classified as applied by \`${fn}\``);
    }
  }
  const lower = section.toLowerCase();
  for (const item of ["purge 6", "`id_origin`", "`claims_v4`", "`core_authority_commits`"]) {
    const line = section
      .split("\n")
      .find((candidate) => candidate.toLowerCase().includes(item) && /^- /.test(candidate));
    if (line === undefined) errors.push(`${item} is not listed as deferred`);
    else if (!/deferred/i.test(line)) errors.push(`${item} is listed without the word deferred`);
  }
  if (!lower.includes("d22")) errors.push("deferral does not cite D22");
  if (!lower.includes("not shipped")) errors.push("missing not-shipped classification");
  return errors;
}

function allocationRows(section: string): Array<{ version: number; owner: string; klass: string }> {
  const rows: Array<{ version: number; owner: string; klass: string }> = [];
  const lines = section.split("\n");
  const header = lines.findIndex((line) => /^\|\s*Version\s*\|/.test(line));
  expect(header).toBeGreaterThanOrEqual(0);
  for (let index = header + 2; index < lines.length && (lines[index] ?? "").startsWith("|"); index += 1) {
    const cells = (lines[index] ?? "").split("|").map((cell) => cell.trim());
    rows.push({ version: Number(cells[1]), owner: cells[2] ?? "", klass: (cells[4] ?? "").toLowerCase() });
  }
  return rows;
}

function allocationErrors(section: string): string[] {
  const errors: string[] = [];
  const lower = section.toLowerCase();
  if (!lower.includes("not reservations")) errors.push("missing not-a-reservation statement");
  if (!lower.includes("claimed at merge time")) errors.push("missing claim-at-merge-time rule");
  if (!section.includes("world/tables/versions.ts")) errors.push("missing single-file number authority");
  if (/remains reserved for implementation/i.test(section)) errors.push("allocation restored a reservation");
  const rows = allocationRows(section);
  if (rows.length === 0) errors.push("no allocation rows");
  let previous = FIRST_EXPANSION_VERSION - 1;
  for (const row of rows) {
    if (!Number.isInteger(row.version) || row.version <= previous) errors.push(`version ${row.version} is not ascending`);
    if (row.version < FIRST_EXPANSION_VERSION) errors.push(`version ${row.version} reuses an occupied number`);
    if (!ALLOCATION_CLASSES.has(row.klass)) errors.push(`version ${row.version} has no table class`);
    if (row.owner === "") errors.push(`version ${row.version} has no owner`);
    previous = row.version;
  }
  return errors;
}

test("the shipped subset is classified against the live migration chain and defers what did not ship", () => {
  const section = shippedSubsetSection(readFileSync(RFC, "utf8"));
  expect(shippedErrors(section, readFileSync(DB, "utf8"))).toEqual([]);
});

test("deferred storage work is really absent from core, so the deferral cannot go stale", () => {
  expect(readFileSync(PURGE_SCHEMA, "utf8")).toMatch(/PURGE_SCHEMA_VERSION\s*=\s*5\b/);
  expect(readFileSync(CLAIMS_SCHEMA, "utf8")).toMatch(/CLAIMS_SCHEMA_VERSION\s*=\s*3\b/);
  const found = Bun.spawnSync(
    ["grep", "-rlE", "CREATE TABLE (IF NOT EXISTS )?(core_authority_commits|claims_v4)\\b", CORE_SRC],
    { stdout: "pipe" },
  );
  expect(found.stdout.toString().trim()).toBe("");
});

test("a shipped version left unclassified or a deferral dropped fails the appendix", () => {
  const section = shippedSubsetSection(readFileSync(RFC, "utf8"));
  const dbSource = readFileSync(DB, "utf8");
  expect(shippedErrors(section.replace("ledger 33 is applied by", "ledger 33 is"), dbSource).length).toBeGreaterThan(0);
  expect(shippedErrors(section.replace(/deferred/gi, "planned"), dbSource).length).toBeGreaterThan(0);
});

test("the expansion allocation starts after the shipped tip, ascends and is not a reservation", () => {
  const section = shippedSubsetSection(readFileSync(RFC, "utf8"));
  expect(allocationErrors(section)).toEqual([]);
  const occupied = allocationErrors(section.replace(/\|\s*34\s*\|/, "| 33 |"));
  expect(occupied.length).toBeGreaterThan(0);
  const reserved = allocationErrors(`${section}\nledger 34 remains reserved for implementation.`);
  expect(reserved).toContain("allocation restored a reservation");
});

test("the storage appendix keeps its historical-baseline note beside the shipped subset section", () => {
  const markdown = readFileSync(RFC, "utf8");
  expect(markdown.indexOf(MARKER)).toBeLessThan(markdown.indexOf(SHIPPED_MARKER));
  expect(reservationErrors(compatibilitySection(markdown), BASELINE_LEDGER_VERSIONS)).toEqual([]);
});
