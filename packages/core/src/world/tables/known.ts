import type { Database } from "bun:sqlite";
import { CLAIM_STATUSES } from "../../contracts/proposal";
import type { WorldTableSpec } from "./registry";
import { WORLD_MIGRATION_VERSIONS } from "./versions";
// Internal recorded positions only. Never serialize these in a serving DTO,
// wire reference, cursor or fingerprint (RFC 0004 proposed Amendment 1).
const STATUS_SQL = CLAIM_STATUSES.map(status => `'${status}'`).join(",");
const MAX_SEQUENCE = Number.MAX_SAFE_INTEGER;
const CLOCK_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const HISTORY_COLUMNS = ["claim_id", "sequence", "recorded_at", "support_key", "receipt_id", "before_status", "after_status", "valid_to", "superseded_by", "retracted_at"] as const;
const TRIGGERS = ["insert", "update", "admission", "supersession_receipt", "purge", "delete", "event_loss", "support_loss", "semantic_loss", "immutable", "delete_guard", "clock_guard"] as const;
const triggerName = (name: typeof TRIGGERS[number]) => `world_claim_history_${name}`;
function createTables(db: Database): void {
    db.exec(`
    CREATE TABLE IF NOT EXISTS claim_history_clock (
      id INTEGER PRIMARY KEY CHECK(id=1),
      last_recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',last_recorded_at) IS NOT NULL AND length(last_recorded_at)=24 AND last_recorded_at=strftime('%Y-%m-%dT%H:%M:%fZ',last_recorded_at)),
      last_sequence INTEGER NOT NULL CHECK(last_sequence BETWEEN 0 AND ${MAX_SEQUENCE})
    ) STRICT;
    INSERT OR IGNORE INTO claim_history_clock VALUES(1,'1970-01-01T00:00:00.000Z',0);
    CREATE TABLE IF NOT EXISTS claim_lifecycle_history (
      claim_id TEXT NOT NULL REFERENCES claims(claim_id) ON DELETE CASCADE,
      sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND ${MAX_SEQUENCE}),
      recorded_at TEXT NOT NULL CHECK(strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at) IS NOT NULL AND length(recorded_at)=24 AND recorded_at=strftime('%Y-%m-%dT%H:%M:%fZ',recorded_at)),
      support_key TEXT, receipt_id TEXT, before_status TEXT CHECK(before_status IS NULL OR before_status IN (${STATUS_SQL})),
      after_status TEXT NOT NULL CHECK(after_status IN (${STATUS_SQL}) AND after_status<>'purged'),
      valid_to TEXT, superseded_by TEXT, retracted_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS claim_lifecycle_history_claim ON claim_lifecycle_history(claim_id,sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS claim_lifecycle_history_admission ON claim_lifecycle_history(support_key) WHERE support_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS claim_history_coverage (
      claim_id TEXT PRIMARY KEY REFERENCES claims(claim_id) ON DELETE CASCADE,
      coverage TEXT NOT NULL CHECK(coverage IN ('baseline_only','complete')),
      complete_from_sequence INTEGER NOT NULL CHECK(complete_from_sequence BETWEEN 1 AND ${MAX_SEQUENCE})
    ) STRICT;
  `);
}
const advanceClock = (count = "1") => `UPDATE claim_history_clock SET last_sequence=last_sequence+(${count}), last_recorded_at=max(last_recorded_at,${CLOCK_NOW}) WHERE id=1 AND (${count})>0;`;
/** Replace only affected surviving histories with an honest present baseline.
 * No source text, event identity or old supersession target survives the reset.
 * The unchanged, unrelated histories cannot reveal a hidden source's erasure.
 */
function baselineSql(predicate: string): string {
    const selected = `SELECT claim_id FROM claims WHERE is_world_typed=1 AND status<>'purged' AND EXISTS(SELECT 1 FROM claim_v2_semantics s WHERE s.claim_id=claims.claim_id) AND (${predicate})`;
    return `
    ${advanceClock(`SELECT count(*) FROM (${selected})`)}
    INSERT INTO claim_history_coverage(claim_id,coverage,complete_from_sequence)
      SELECT claim_id,'baseline_only',last_sequence-(SELECT count(*) FROM (${selected}))+row_number() OVER(ORDER BY claim_id)
      FROM claims CROSS JOIN claim_history_clock WHERE claims.claim_id IN (${selected}) AND id=1
      ON CONFLICT(claim_id) DO UPDATE SET coverage=excluded.coverage,complete_from_sequence=excluded.complete_from_sequence;
    INSERT INTO claim_lifecycle_history(${HISTORY_COLUMNS.join(",")})
      SELECT c.claim_id,v.complete_from_sequence,k.last_recorded_at,NULL,NULL,NULL,c.status,c.valid_to,NULL,c.retracted_at
      FROM claims c JOIN claim_history_coverage v USING(claim_id) CROSS JOIN claim_history_clock k
      WHERE c.claim_id IN (${selected}) AND k.id=1;
    DELETE FROM claim_lifecycle_history WHERE sequence < (
      SELECT complete_from_sequence FROM claim_history_coverage v WHERE v.claim_id=claim_lifecycle_history.claim_id);
  `;
}
// During canon completion the new receipt and still-present intent coexist
// only inside the writer's atomic transaction. A pending intent alone is not
// causation: unrelated extraction may run while file publication is pending.
const retainedSupersession = (reference: string) => `CASE WHEN EXISTS(SELECT 1 FROM claims target JOIN claim_v2_semantics semantic USING(claim_id) WHERE target.claim_id=${reference} AND target.status<>'purged') THEN ${reference} END`;
const referencingClaim = (id: string) => `claims.superseded_by=${id} OR EXISTS(SELECT 1 FROM claim_lifecycle_history h WHERE h.claim_id=claims.claim_id AND h.superseded_by=${id})`;
const completingReceipt = `(SELECT r.receipt_id FROM canon_write_intents i JOIN canon_receipts r USING(receipt_id) WHERE i.singleton=1)`;
function transitionSql(before: string, receipt = "NEW.receipt_id"): string {
    return `
    ${advanceClock()}
    INSERT INTO claim_lifecycle_history(${HISTORY_COLUMNS.join(",")})
      SELECT NEW.claim_id,last_sequence,last_recorded_at,NULL,${receipt},${before},NEW.status,NEW.valid_to,${retainedSupersession("NEW.superseded_by")},NEW.retracted_at FROM claim_history_clock WHERE id=1;
    INSERT OR IGNORE INTO claim_history_coverage(claim_id,coverage,complete_from_sequence)
      SELECT NEW.claim_id,'complete',last_sequence FROM claim_history_clock WHERE id=1;
  `;
}
function installTriggers(db: Database): void {
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${triggerName("insert")} AFTER INSERT ON claims
      WHEN NEW.is_world_typed=1 AND NEW.status<>'purged'
      BEGIN ${transitionSql("NULL")} END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("update")} AFTER UPDATE ON claims
      WHEN NEW.is_world_typed=1 AND NEW.status<>'purged' AND EXISTS(SELECT 1 FROM claim_v2_semantics WHERE claim_id=NEW.claim_id) AND
        (OLD.is_world_typed<>1 OR NEW.status IS NOT OLD.status OR NEW.valid_to IS NOT OLD.valid_to OR
         NEW.superseded_by IS NOT OLD.superseded_by OR NEW.retracted_at IS NOT OLD.retracted_at OR NEW.receipt_id IS NOT OLD.receipt_id)
      BEGIN ${transitionSql("CASE WHEN OLD.is_world_typed=1 THEN OLD.status ELSE NULL END", `coalesce(${completingReceipt},CASE WHEN NEW.receipt_id IS NOT OLD.receipt_id THEN (SELECT receipt_id FROM canon_receipts WHERE receipt_id=NEW.receipt_id) END)`)} END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("admission")} AFTER INSERT ON claim_v2_support
      WHEN EXISTS(SELECT 1 FROM claims WHERE claim_id=NEW.claim_id AND is_world_typed=1 AND status<>'purged')
      BEGIN
        ${advanceClock()}
        INSERT INTO claim_lifecycle_history(${HISTORY_COLUMNS.join(",")})
          SELECT c.claim_id,k.last_sequence,k.last_recorded_at,NEW.support_key,NULL,NULL,c.status,c.valid_to,${retainedSupersession("c.superseded_by")},c.retracted_at
          FROM claims c CROSS JOIN claim_history_clock k WHERE c.claim_id=NEW.claim_id AND k.id=1;
      END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("supersession_receipt")} AFTER UPDATE OF receipt_id ON claim_supersessions
      WHEN NEW.receipt_id IS NOT OLD.receipt_id AND EXISTS(SELECT 1 FROM canon_receipts WHERE receipt_id=NEW.receipt_id)
        AND EXISTS(SELECT 1 FROM claims c JOIN claim_v2_semantics s USING(claim_id) WHERE c.claim_id=NEW.loser AND c.is_world_typed=1 AND c.status<>'purged')
      BEGIN
        ${advanceClock()}
        INSERT INTO claim_lifecycle_history(${HISTORY_COLUMNS.join(",")})
          SELECT c.claim_id,k.last_sequence,k.last_recorded_at,NULL,NEW.receipt_id,c.status,c.status,c.valid_to,${retainedSupersession("c.superseded_by")},c.retracted_at
          FROM claims c CROSS JOIN claim_history_clock k WHERE c.claim_id=NEW.loser AND k.id=1;
      END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("purge")} AFTER UPDATE OF status ON claims
      WHEN NEW.is_world_typed=1 AND NEW.status='purged' AND OLD.status<>'purged'
      BEGIN
        ${advanceClock()}
        ${baselineSql(referencingClaim("NEW.claim_id"))}
        DELETE FROM claim_lifecycle_history WHERE claim_id=NEW.claim_id;
        DELETE FROM claim_history_coverage WHERE claim_id=NEW.claim_id;
      END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("delete")} AFTER DELETE ON claims
      WHEN OLD.is_world_typed=1 BEGIN ${advanceClock()} ${baselineSql(referencingClaim("OLD.claim_id"))} END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("event_loss")} BEFORE DELETE ON events BEGIN
      ${baselineSql(`claims.claim_id IN (SELECT claim_id FROM claim_v2_support s JOIN claim_v2_support_events e USING(support_key) WHERE e.event_id=OLD.event_id)
        OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(claims.provenance) THEN claims.provenance ELSE '[]' END) p WHERE p.value=OLD.event_id)`)}
    END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("support_loss")} BEFORE DELETE ON claim_v2_support BEGIN
      ${baselineSql("claims.claim_id=OLD.claim_id")}
    END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("semantic_loss")} AFTER DELETE ON claim_v2_semantics
      WHEN EXISTS(SELECT 1 FROM claim_history_coverage WHERE claim_id=OLD.claim_id)
      BEGIN
        ${advanceClock()}
        ${baselineSql(referencingClaim("OLD.claim_id"))}
        DELETE FROM claim_lifecycle_history WHERE claim_id=OLD.claim_id;
        DELETE FROM claim_history_coverage WHERE claim_id=OLD.claim_id;
      END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("immutable")} BEFORE UPDATE ON claim_lifecycle_history
      BEGIN SELECT RAISE(ABORT,'claim history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("delete_guard")} BEFORE DELETE ON claim_lifecycle_history
      WHEN EXISTS(SELECT 1 FROM claims c JOIN claim_history_coverage v USING(claim_id)
        WHERE c.claim_id=OLD.claim_id AND c.status<>'purged' AND OLD.sequence>=v.complete_from_sequence AND EXISTS(SELECT 1 FROM claim_v2_semantics s WHERE s.claim_id=c.claim_id))
      BEGIN SELECT RAISE(ABORT,'claim history erasure requires a coverage boundary'); END;
    CREATE TRIGGER IF NOT EXISTS ${triggerName("clock_guard")} BEFORE UPDATE ON claim_history_clock
      WHEN NEW.last_sequence<OLD.last_sequence OR NEW.last_recorded_at<OLD.last_recorded_at
      BEGIN SELECT RAISE(ABORT,'claim history clock cannot go backwards'); END;
  `);
}
export function applyClaimHistorySchema(db: Database): void {
    db.transaction(() => {
        createTables(db);
        // A migration cannot infer previous transitions from source-supplied times.
        db.exec(baselineSql("NOT EXISTS(SELECT 1 FROM claim_lifecycle_history h WHERE h.claim_id=claims.claim_id)"));
        installTriggers(db);
    }).immediate();
}
/** Only private restore staging calls these, inside its single transaction.
 * Transactional DDL rolls back on failure; no persisted bypass flag exists.
 */
export function beginClaimHistoryRestore(db: Database): void {
    if (!db.inTransaction)
        throw new Error("claim history restore requires a transaction");
    for (const name of TRIGGERS)
        db.exec(`DROP TRIGGER IF EXISTS ${triggerName(name)}`);
}
export function prepareClaimHistoryImport(db: Database, sourceVersion: number): void {
    if (!db.inTransaction)
        throw new Error("claim history restore requires a transaction");
    if (sourceVersion >= WORLD_MIGRATION_VERSIONS.known)
        db.exec("DELETE FROM claim_history_clock");
}
export function finishClaimHistoryRestore(db: Database, sourceVersion: number): void {
    if (!db.inTransaction)
        throw new Error("claim history restore requires a transaction");
    if (sourceVersion < WORLD_MIGRATION_VERSIONS.known)
        applyClaimHistorySchema(db);
    else {
        assertClaimHistory(db);
        installTriggers(db);
    }
}
/** Validate imported positions before a restored vault can be published. */
export function assertClaimHistory(db: Database): void {
    const bad = db.query(`SELECT 1 WHERE
    (SELECT count(*) FROM claim_history_clock)<>1 OR
    EXISTS(SELECT 1 FROM claim_lifecycle_history h CROSS JOIN claim_history_clock k
      JOIN claims c ON c.claim_id=h.claim_id
      WHERE h.sequence>k.last_sequence OR h.recorded_at>k.last_recorded_at OR c.is_world_typed<>1 OR c.status='purged' OR NOT EXISTS(SELECT 1 FROM claim_v2_semantics s WHERE s.claim_id=c.claim_id)
        OR (h.receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM canon_receipts r WHERE r.receipt_id=h.receipt_id))
        OR (h.superseded_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM claims target JOIN claim_v2_semantics semantic USING(claim_id) WHERE target.claim_id=h.superseded_by AND target.status<>'purged'))
        OR (h.support_key IS NOT NULL AND NOT EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=h.claim_id AND s.support_key=h.support_key))) OR
    EXISTS(SELECT 1 FROM claim_history_coverage v JOIN claims c USING(claim_id)
      WHERE c.is_world_typed<>1 OR c.status='purged' OR NOT EXISTS(
        SELECT 1 FROM claim_lifecycle_history h WHERE h.claim_id=v.claim_id AND h.sequence=v.complete_from_sequence)) OR
    EXISTS(SELECT 1 FROM claims c WHERE c.is_world_typed=1 AND c.status<>'purged' AND EXISTS(SELECT 1 FROM claim_v2_semantics s WHERE s.claim_id=c.claim_id) AND NOT EXISTS(
      SELECT 1 FROM claim_history_coverage v WHERE v.claim_id=c.claim_id)) OR
    EXISTS(SELECT 1 FROM claim_lifecycle_history h WHERE NOT EXISTS(SELECT 1 FROM claim_history_coverage v WHERE v.claim_id=h.claim_id AND h.sequence>=v.complete_from_sequence)) OR
    EXISTS(SELECT 1 FROM claims c JOIN claim_lifecycle_history h ON h.claim_id=c.claim_id
      WHERE h.sequence=(SELECT max(sequence) FROM claim_lifecycle_history last WHERE last.claim_id=c.claim_id)
        AND (h.after_status IS NOT c.status OR h.valid_to IS NOT c.valid_to OR h.retracted_at IS NOT c.retracted_at)) OR
    EXISTS(SELECT 1 FROM (SELECT recorded_at,lag(recorded_at) OVER(ORDER BY sequence) AS prior FROM claim_lifecycle_history) WHERE recorded_at<prior)
  `).get();
    if (bad !== null)
        throw new Error("claim history coverage or clock is invalid");
}
export const KNOWN_TABLE_SPECS: readonly WorldTableSpec[] = [
    { name: "claim_history_clock", class: "bookkeeping", since: WORLD_MIGRATION_VERSIONS.known,
        columns: ["id", "last_recorded_at", "last_sequence"],
        erasure: { via: "trigger", triggers: TRIGGERS.map(triggerName) }, create: createTables },
    { name: "claim_lifecycle_history", class: "authority", since: WORLD_MIGRATION_VERSIONS.known,
        columns: HISTORY_COLUMNS, erasure: { via: "cascade", parent: "claims" }, create: createTables },
    { name: "claim_history_coverage", class: "bookkeeping", since: WORLD_MIGRATION_VERSIONS.known,
        columns: ["claim_id", "coverage", "complete_from_sequence"], erasure: { via: "cascade", parent: "claims" }, create: createTables },
];
