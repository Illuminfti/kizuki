/**
 * Honest progress measure for the world design fixtures: every oracle unit is
 * either bound to an executable test or deferred to a named owner. A unit with
 * neither is a gap, and so is a registry line that names a unit that is gone.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  FIXTURE_STATUS,
  ORACLE_ASSERTION_STATUS,
  type FixtureRegistry,
  type FixtureStatus,
} from "./status";

export interface CoverageRow {
  readonly unit: string;
  readonly status: FixtureStatus | null;
}

export interface OracleCoverage {
  readonly rows: readonly CoverageRow[];
  /** Units that are neither executable nor deferred to an owner. */
  readonly uncovered: readonly string[];
  /** Assertion registry lines whose assertion no longer exists. */
  readonly stale: readonly string[];
}

const DIRECTORY = import.meta.dir;

function assertionIds(fixture: unknown): string[] {
  if (fixture === null || typeof fixture !== "object") return [];
  const oracle = (fixture as { oracle?: unknown }).oracle;
  if (oracle === null || typeof oracle !== "object") return [];
  const list = (oracle as { assertions?: unknown }).assertions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item) =>
    item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
      ? [(item as { id: string }).id]
      : [],
  );
}

export function oracleCoverage(
  directory: string = DIRECTORY,
  fixtures: FixtureRegistry = FIXTURE_STATUS,
  assertions: FixtureRegistry = ORACLE_ASSERTION_STATUS,
): OracleCoverage {
  const rows: CoverageRow[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()) {
    const id = name.slice(0, -".json".length);
    const ids = assertionIds(JSON.parse(readFileSync(join(directory, name), "utf8")));
    const registry = ids.length === 0 ? fixtures : assertions;
    for (const unit of ids.length === 0 ? [id] : ids.map((one) => `${id}#${one}`)) {
      seen.add(unit);
      rows.push({ unit, status: Object.hasOwn(registry, unit) ? registry[unit]! : null });
    }
  }
  const stale = Object.keys(assertions).filter((unit) => !seen.has(unit));
  return { rows, uncovered: rows.filter((row) => row.status === null).map((row) => row.unit), stale };
}

export function formatCoverageTable(coverage: OracleCoverage): string {
  const width = Math.max(4, ...coverage.rows.map((row) => row.unit.length));
  const line = (row: CoverageRow): string => {
    const status = row.status;
    const cell =
      status === null
        ? "UNCOVERED"
        : status.status === "executable"
          ? `executable  ${status.test}`
          : `deferred    ${status.owner}`;
    return `${row.unit.padEnd(width)}  ${cell}`;
  };
  const executable = coverage.rows.filter((row) => row.status?.status === "executable").length;
  return [
    `${"unit".padEnd(width)}  status`,
    ...coverage.rows.map(line),
    `${executable} executable, ${coverage.rows.length - executable} not executable, ${coverage.rows.length} oracle units`,
  ].join("\n");
}
