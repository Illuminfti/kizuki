import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { WorldNamespace } from "../references";

/** RFC 0004: a fixed 15 minutes from issuance, never extended by a read. */
export const VIEW_TTL_MS = 15 * 60 * 1000;
/** Sixteen tokens and 4 MiB of retained payload per principal, 256 KiB at most for one. */
export const VIEW_SLOTS = 16;
export const VIEW_PRINCIPAL_BYTES = 4 * 1024 * 1024;
export const VIEW_TOKEN_BYTES = 256 * 1024;

/** The digest a random wire value is stored under: SHA-256 of its 32 bytes. The value itself is never stored. */
export function wireDigest(token: string): string {
  return createHash("sha256").update(Buffer.from(token, "base64url")).digest("hex");
}

export function fingerprintOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface StoredView {
  readonly fingerprint: string;
  readonly projection: Uint8Array;
  readonly validUntil: string;
}

/**
 * The baseline a token names, only if it is this principal's, bound to this
 * exact query, and unexpired. Every other case is the same null.
 */
export function lookupView(
  db: Database,
  partition: number,
  namespaceId: string,
  queryDigest: string,
  token: string,
  now: string,
): StoredView | null {
  const row = db
    .query<
      { fingerprint: string; projection: Uint8Array; expires_at: string },
      [string, number, string, string, string]
    >(
      `SELECT fingerprint,projection,expires_at FROM world_view_tokens
       WHERE token_hash=? AND partition_id=? AND namespace_id=? AND query_digest=? AND expires_at>?`,
    )
    .get(wireDigest(token), partition, namespaceId, queryDigest, now);
  return row === null ? null : { fingerprint: row.fingerprint, projection: row.projection, validUntil: row.expires_at };
}

/**
 * Deletes, from the newest down, every token of the partition that would not
 * fit beside one more of `?3` bytes: the oldest go first and a tie breaks on
 * the digest. One statement whatever the partition holds, so the work a read
 * does never depends on how full its cache is.
 */
const MAKE_ROOM = `
  DELETE FROM world_view_tokens WHERE token_hash IN (
    SELECT token_hash FROM (
      SELECT token_hash,
             row_number() OVER newest AS place,
             sum(bytes) OVER newest AS held
      FROM world_view_tokens WHERE partition_id=?
      WINDOW newest AS (ORDER BY created_at DESC, token_hash DESC)
    ) WHERE place>? OR held>?)`;

export interface IssuedView {
  readonly token: string;
  readonly validUntil: string;
}

/**
 * Stores one complete projection under a fresh random token. The caller holds
 * the write transaction. Returns null when the projection is too large for one
 * token, in which case the read is served with no view.
 */
export function issueView(
  db: Database,
  partition: number,
  ns: WorldNamespace,
  queryDigest: string,
  projection: Uint8Array,
  refs: readonly string[],
  now: string,
): IssuedView | null {
  if (projection.byteLength > VIEW_TOKEN_BYTES) return null;
  const validUntil = new Date(Date.parse(now) + VIEW_TTL_MS).toISOString();
  const insert = db.query(
    `INSERT INTO world_view_tokens(token_hash,partition_id,namespace_id,query_digest,projection,fingerprint,bytes,created_at,expires_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = randomBytes(32).toString("base64url");
    const hash = wireDigest(token);
    if (db.query("SELECT 1 FROM world_view_tokens WHERE token_hash=?").get(hash) !== null) continue;
    db.query("DELETE FROM world_view_tokens WHERE partition_id=? AND expires_at<=?").run(partition, now);
    db.query(MAKE_ROOM).run(partition, VIEW_SLOTS - 1, VIEW_PRINCIPAL_BYTES - projection.byteLength);
    insert.run(hash, partition, ns.id, queryDigest, projection, fingerprintOf(projection), projection.byteLength, now, validUntil);
    const link = db.query(
      `INSERT OR IGNORE INTO world_view_token_deps(token_hash,namespace_id,wire_ref)
       SELECT ?,namespace_id,wire_ref FROM world_wire_refs WHERE namespace_id=? AND wire_ref=?`,
    );
    for (const ref of refs) link.run(hash, ns.id, ref);
    return { token, validUntil };
  }
  return null;
}

/** A service start invalidates every token, as a restore does: the next use of any is `new_view_required`. */
export function clearViewTokens(db: Database): void {
  if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_view_tokens'").get() === null) return;
  db.query("DELETE FROM world_view_tokens").run();
}
