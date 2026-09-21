import type { Database } from "bun:sqlite";
import { WORLD_TABLES } from "../../src/world/schema";

/** Test-only reconstruction of the actual pre32 schema; never used on a vault. */
export function removeWorldSchema(db: Database): void {
  for (const { name } of db
    .query<
      { name: string },
      []
    >("SELECT name FROM sqlite_master WHERE type='trigger' AND (name GLOB 'world_*' OR name GLOB 'semantic_*')")
    .all())
    db.exec(`DROP TRIGGER ${name}`);
  for (const table of [...WORLD_TABLES].reverse())
    db.exec(`DROP TABLE ${table}`);
  db.exec(
    "DROP INDEX world_semantic_predicate; DROP INDEX world_semantic_object; DROP INDEX claims_idempotency; ALTER TABLE claims DROP COLUMN is_world_typed; ALTER TABLE claim_v2_support DROP COLUMN support_origin;",
  );
  db.exec(
    "CREATE UNIQUE INDEX claims_idempotency ON claims(kind,coalesce(target,''),body_hash) WHERE status='live' AND kind<>'purge_review' AND (content_hash IS NULL OR content_hash='')",
  );
}
