import type { Database } from "bun:sqlite";
import { LedgerStoreError } from "../../ledger/errors";
import { tableColumns, tableExists } from "../../ledger/schema";
import { WORLD_TABLE_COLUMNS, type WorldTable } from "../schema";
import { WORLD_VIEW_TABLE_SPECS } from "./views";
import { WORLD_MIGRATION_BASE } from "./versions";

/**
 * How a world table behaves under backup, restore, rebuild and purge.
 * - authority: durable truth. Exported, restored, erased with its sources.
 * - bookkeeping: durable identity and delivery state. Exported like authority.
 * - derived: rebuildable from authority. Never exported, empty after restore,
 *   cleared by `kizuki rebuild --layer world`.
 * - cache: runtime state that may hold sensitive tokens. Never exported,
 *   reinitialised on restore, cleared by `kizuki rebuild --layer world`.
 *
 * Authority and bookkeeping tables must name a purge path (cascade or trigger).
 * A derived or cache table may declare `none`: purge does not touch it and only
 * `rebuild --layer world` clears it, so a table that holds content of a purged
 * source must name a cascade or trigger instead.
 */
export type WorldTableClass = "authority" | "bookkeeping" | "derived" | "cache";

/**
 * How purge reaches the rows. Cascade and trigger are checked against the
 * database for tables past the frozen ledger. `none` is valid only for derived
 * and cache tables.
 */
export type WorldErasure =
  | { readonly via: "cascade"; readonly parent: string }
  | { readonly via: "trigger"; readonly triggers: readonly string[] }
  | { readonly via: "none"; readonly reason: string };

export interface WorldTableSpec {
  readonly name: string;
  readonly class: WorldTableClass;
  /** Ledger version whose migration creates the table. Read it from WORLD_MIGRATION_VERSIONS. */
  readonly since: number;
  /** Every column, in export order. Exported rows must carry exactly these keys. */
  readonly columns: readonly string[];
  readonly erasure: WorldErasure;
  /**
   * Idempotent DDL for the table and its triggers. The migration that creates
   * the table calls it, and so does restore before it imports. Absent for the
   * frozen ledger32 tables.
   */
  readonly create?: (db: Database) => void;
  /** Initial state for a derived or cache table. Default: create, then delete every row. */
  readonly reset?: (db: Database) => void;
}

const FROZEN_ERASURE: Record<WorldTable, WorldErasure> = {
  claim_occurrences: { via: "cascade", parent: "events" },
  semantic_handles: {
    via: "trigger",
    triggers: ["semantic_allocations_cleanup"],
  },
  semantic_bindings: { via: "cascade", parent: "semantic_handles" },
  semantic_allocations: { via: "cascade", parent: "semantic_handles" },
  world_authorization_namespaces: {
    via: "trigger",
    triggers: ["world_agent_deleted"],
  },
  world_wire_refs: { via: "cascade", parent: "world_authorization_namespaces" },
  world_wire_object_targets: { via: "cascade", parent: "world_wire_refs" },
  world_wire_claim_targets: { via: "cascade", parent: "world_wire_refs" },
  world_wire_admission_targets: { via: "cascade", parent: "world_wire_refs" },
  world_wire_event_version_targets: {
    via: "cascade",
    parent: "world_wire_refs",
  },
  world_wire_principal_targets: { via: "cascade", parent: "world_wire_refs" },
};

/** Ledger32, frozen in world/schema.ts. Object order is foreign-key order. */
const LEDGER_32_TABLES: readonly WorldTableSpec[] = (
  Object.keys(WORLD_TABLE_COLUMNS) as WorldTable[]
).map((name) => ({
  name,
  class: "bookkeeping",
  since: 32,
  columns: WORLD_TABLE_COLUMNS[name],
  erasure: FROZEN_ERASURE[name],
}));

/**
 * Every world table, parents before children. A schema packet appends its
 * table module directly under its own slot marker; a deleted marker fails the
 * slot test.
 */
export const WORLD_TABLE_SPECS: readonly WorldTableSpec[] = [
  ...LEDGER_32_TABLES,
  // slot: view
  ...WORLD_VIEW_TABLE_SPECS,
  // slot: known
  // slot: consol
  // slot: ident
  // slot: attn
  // slot: refs
  // slot: fcst
];

/** Durable classes must reach purge; only derived and cache tables may opt out with `none`. */
export function assertErasureDeclared(spec: WorldTableSpec): void {
  if (
    spec.erasure.via === "none" &&
    (spec.class === "authority" || spec.class === "bookkeeping")
  )
    throw new Error(
      `world table ${spec.name} is ${spec.class} and must declare a cascade or trigger erasure`,
    );
}

let registered: readonly WorldTableSpec[] = [];

/** Test seam behind `@kizuki/core/testing`: specs live until the returned disposer runs. */
export function registerWorldTableSpecs(
  specs: readonly WorldTableSpec[],
): () => void {
  const names = new Set(worldTableSpecs().map((spec) => spec.name));
  for (const spec of specs) {
    assertErasureDeclared(spec);
    if (names.has(spec.name))
      throw new Error(`world table ${spec.name} is already registered`);
    names.add(spec.name);
  }
  const added = [...specs];
  registered = [...registered, ...added];
  return () => {
    registered = registered.filter((spec) => !added.includes(spec));
  };
}

export function worldTableSpecs(): readonly WorldTableSpec[] {
  return [...WORLD_TABLE_SPECS, ...registered];
}

/** Tables a backup at `ledgerVersion` streams: authority and bookkeeping. */
export function exportedWorldTables(
  ledgerVersion: number,
): readonly WorldTableSpec[] {
  return worldTableSpecs().filter(
    (spec) =>
      spec.since <= ledgerVersion &&
      (spec.class === "authority" || spec.class === "bookkeeping"),
  );
}

/** Tables that must be empty or initial after a restore or a world rebuild: derived and cache. */
export function resettableWorldTables(
  ledgerVersion: number,
): readonly WorldTableSpec[] {
  return worldTableSpecs().filter(
    (spec) =>
      spec.since <= ledgerVersion &&
      (spec.class === "derived" || spec.class === "cache"),
  );
}

export function createWorldTables(db: Database, ledgerVersion: number): void {
  for (const spec of worldTableSpecs())
    if (spec.since <= ledgerVersion) spec.create?.(db);
}

/**
 * Puts derived and cache tables in their initial state and returns the names
 * it touched, in registry order. Default clearing runs children first so a
 * foreign key between derived tables never blocks it; custom `reset` hooks run
 * afterwards in registry order and must not depend on that order.
 */
export function resetWorldTables(
  db: Database,
  ledgerVersion: number,
): string[] {
  const specs = resettableWorldTables(ledgerVersion);
  const standard = specs.filter((spec) => spec.reset === undefined);
  for (const spec of standard) spec.create?.(db);
  for (const spec of [...standard].reverse())
    if (tableExists(db, spec.name)) db.exec(`DELETE FROM ${spec.name}`);
  for (const spec of specs) spec.reset?.(db);
  return specs.map((spec) => spec.name);
}

/**
 * Integrity for the tables whose migration versions.ts numbers: each exists
 * with its declared columns and the erasure path its spec names. The frozen
 * ledger32 tables keep their own check in world/schema.ts.
 */
export function assertWorldTableSchema(db: Database, expectedVersion: number): void {
  for (const spec of worldTableSpecs()) {
    if (spec.since <= WORLD_MIGRATION_BASE || spec.since > expectedVersion) continue;
    const columns = tableColumns(db, spec.name);
    if (!tableExists(db, spec.name) || spec.columns.some((column) => !columns.includes(column))) {
      throw new LedgerStoreError("corrupt", `world storage missing ${spec.name}`);
    }
    const { erasure } = spec;
    const reached =
      erasure.via === "cascade"
        ? db.query(`SELECT 1 FROM pragma_foreign_key_list(?) WHERE "table"=? AND on_delete='CASCADE'`).get(spec.name, erasure.parent) !== null
        : erasure.via === "trigger"
          ? erasure.triggers.every((name) => db.query("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name) !== null)
          : spec.class === "derived" || spec.class === "cache";
    if (!reached) throw new LedgerStoreError("corrupt", `world storage erasure missing for ${spec.name}`);
  }
}
