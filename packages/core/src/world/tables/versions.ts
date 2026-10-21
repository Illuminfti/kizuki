/**
 * The only file that holds ledger migration numbers past the base. A schema
 * packet adds one line under its own slot marker and reads the number in
 * ledger/db.ts and in its table module as WORLD_MIGRATION_VERSIONS.<key>.
 * Numbers across ledger and world migrations are claimed contiguously, in
 * merge order. Existing numbers stay fixed when a later packet lands.
 * A key that is not built keeps its marker and has no entry.
 */
export const WORLD_SLOT_KEYS = ["view", "known", "consol", "ident", "attn", "refs", "fcst", "machine_images"] as const;
export type WorldSlotKey = (typeof WORLD_SLOT_KEYS)[number];

export const PURGE_REINGEST_MIGRATION_VERSION = 34;
export const CURSOR_STORE_MIGRATION_VERSION = 35;

/** Non-world ledger migrations keep their numbers as later packets land. */
export const LEDGER_MIGRATION_VERSIONS = {
  purgeReingest: PURGE_REINGEST_MIGRATION_VERSION,
  eventClasses: 38,
} as const;

/** The fixed ledger version before the first world table slot. */
export const WORLD_MIGRATION_BASE = CURSOR_STORE_MIGRATION_VERSION;

export const WORLD_MIGRATION_VERSIONS = {
  // slot: view
  view: 37,
  // slot: known
  // slot: consol
  // slot: ident
  // slot: attn
  // slot: refs
  // slot: fcst
  // slot: machine_images
  machine_images: 36,
} as const satisfies Partial<Record<WorldSlotKey, number>>;
