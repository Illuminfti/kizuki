import type { Database } from "bun:sqlite";

/** RFC 0004: at most 64 principal partitions per vault, so at most 256 MiB of retained view payload. */
export const VIEW_PARTITIONS = 64;

/** The owner's principal id in `world_view_partitions`, the same one `worldNamespace` uses. */
export const OWNER_PRINCIPAL = "owner";

/** The partition a principal holds, or null when none is reserved and its reads are `not_issued`. */
export function viewPartitionOf(db: Database, principalId: string): number | null {
  return (
    db
      .query<{ partition_id: number }, [string]>(
        "SELECT partition_id FROM world_view_partitions WHERE principal_id=?",
      )
      .get(principalId)?.partition_id ?? null
  );
}

/**
 * Reserve a partition for a principal, idempotently. Called by the owner-plane
 * acts that create or change a principal, inside their transaction. A full
 * vault answers false and never displaces a reservation another principal holds.
 */
export function reserveViewPartition(db: Database, principalId: string, at: string = new Date().toISOString()): boolean {
  if (viewPartitionOf(db, principalId) !== null) return true;
  const used = new Set(
    db
      .query<{ partition_id: number }, []>("SELECT partition_id FROM world_view_partitions")
      .all()
      .map((row) => row.partition_id),
  );
  for (let partition = 0; partition < VIEW_PARTITIONS; partition += 1) {
    if (used.has(partition)) continue;
    db.query("INSERT INTO world_view_partitions(partition_id,principal_id,reserved_at) VALUES (?,?,?)").run(
      partition,
      principalId,
      at,
    );
    return true;
  }
  return false;
}

/**
 * The reservations a vault starts with: the owner first, then every agent that
 * is not revoked, oldest first, until the 64 partitions are taken. The
 * migration and a world rebuild both start from this, so restore never leaves a
 * live principal without one.
 */
export function seedViewPartitions(db: Database): void {
  reserveViewPartition(db, OWNER_PRINCIPAL);
  for (const { agent_id } of db
    .query<{ agent_id: string }, []>("SELECT agent_id FROM agents WHERE revoked_at IS NULL ORDER BY created_at, agent_id")
    .all()) {
    if (!reserveViewPartition(db, agent_id)) return;
  }
}
