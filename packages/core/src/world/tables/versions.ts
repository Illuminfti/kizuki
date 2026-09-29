/**
 * The only file that holds ledger migration numbers past the base. A schema
 * packet adds one line under its own slot marker and reads the number in
 * ledger/db.ts and in its table module as WORLD_MIGRATION_VERSIONS.<key>.
 * Numbers are claimed contiguously, in merge order. If another migration lands
 * first, add its count to WORLD_MIGRATION_BASE and to every entry in one commit.
 * A key that is not built keeps its marker and has no entry.
 */
export const WORLD_SLOT_KEYS = ["view", "known", "consol", "ident", "attn", "refs", "fcst"] as const;
export type WorldSlotKey = (typeof WORLD_SLOT_KEYS)[number];

export const PURGE_REINGEST_MIGRATION_VERSION = 34;
export const CURSOR_STORE_MIGRATION_VERSION = 35;
export const EVENT_CLASSES_MIGRATION_VERSION = 36;

/** The last ledger version before the world table slots. */
export const WORLD_MIGRATION_BASE = EVENT_CLASSES_MIGRATION_VERSION;

export const WORLD_MIGRATION_VERSIONS = {
  // slot: view
  // slot: known
  // slot: consol
  // slot: ident
  // slot: attn
  // slot: refs
  // slot: fcst
} as const satisfies Partial<Record<WorldSlotKey, number>>;
