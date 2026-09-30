import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { SENSITIVITY_ORDER, type Grant } from "../../agents/types";
import { OWNER_AGENT_GRANT } from "../../agents/types";
import { validateAgentGrant } from "../../agents/identity";
import { canonicalJson } from "../../util/hash";
import { isPlainObject } from "../../util/validate";
import type { WorldNamespace } from "../references";
import type { WorldValidQuery } from "../ops/types";
import { hasWorldKeys, parseWorldValid } from "../ops/parse";
import { viewPartitionOf } from "./partitions";
import { fingerprintOf, wireDigest } from "./store";

export const RESUME_SCHEMA = "kizuki.resume-handle/v1";
export const RESUME_TTL_MS = 24 * 60 * 60 * 1000;
export type ShareData = {
  readonly schema: typeof RESUME_SCHEMA;
  readonly handle: string;
  readonly expiresAt: string;
};
type Scope = Pick<Grant, "ceiling" | "types" | "subjects" | "since" | "until">;

function scopeOf(grant: Grant): Scope {
  const sorted = (values: readonly string[] | null) => values === null ? null : [...new Set(values)].sort();
  return { ceiling: grant.ceiling, types: sorted(grant.types), subjects: sorted(grant.subjects), since: grant.since, until: grant.until };
}

/** Does the reader's grant omit any part of the issuer's grant? No evidence is inspected for this bit. */
export function scopeClipped(reader: Grant, issuer: Scope): boolean {
  const covers = (wide: readonly string[] | null, narrow: readonly string[] | null) =>
    wide === null || (narrow !== null && narrow.every((item) => wide.includes(item)));
  return SENSITIVITY_ORDER[reader.ceiling] < SENSITIVITY_ORDER[issuer.ceiling] ||
    !covers(reader.types, issuer.types) || !covers(reader.subjects, issuer.subjects) ||
    (reader.since !== null && (issuer.since === null || Date.parse(reader.since) > Date.parse(issuer.since))) ||
    (reader.until !== null && (issuer.until === null || Date.parse(reader.until) < Date.parse(issuer.until)));
}

/** The caller holds the read transaction; a savepoint contains every cache mutation on failure. */
export function issueResume(db: Database, ns: WorldNamespace, grant: Grant, operation: string, handleId: string, valid: WorldValidQuery): ShareData | null {
  const partition = viewPartitionOf(db, ns.principalId);
  if (partition === null) return null;
  try {
    return db.transaction((): ShareData | null => {
      const now = new Date().toISOString(), expiresAt = new Date(Date.parse(now) + RESUME_TTL_MS).toISOString();
      const scope = canonicalJson(scopeOf(grant));
      // Find a free random digest before eviction, so even exhausted retries leave earlier handles intact.
      for (let attempt = 0; attempt < 4; attempt++) {
        const handle = randomBytes(32).toString("base64url"), hash = wireDigest(handle);
        if (db.query("SELECT 1 FROM world_resume_handles WHERE handle_hash=?").get(hash) !== null) continue;
        db.query("DELETE FROM world_resume_handles WHERE partition_id=? AND expires_at<=?").run(partition, now);
        db.query(`DELETE FROM world_resume_handles WHERE handle_hash IN (
          SELECT handle_hash FROM world_resume_handles WHERE partition_id=?
          ORDER BY created_at DESC, handle_hash DESC LIMIT -1 OFFSET 15)`).run(partition);
        db.query(`INSERT INTO world_resume_handles(handle_hash,partition_id,handle_id,operation,valid,scope,scope_digest,recorded_at,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(hash, partition, handleId, operation, canonicalJson(valid), scope, fingerprintOf(Buffer.from(scope)), now, now, expiresAt);
        return { schema: RESUME_SCHEMA, handle, expiresAt };
      }
      return null;
    })();
  } catch (error) {
    if (error instanceof Error && error.name === "SQLiteError") return null;
    throw error;
  }
}

export interface ResumeRead {
  readonly handle_id: string;
  readonly operation: string;
  readonly valid: WorldValidQuery;
  readonly scope: Scope;
}

/** Unknown, expired and inactive issuers are one lookup miss, with no existence signal. */
export function lookupResume(db: Database, handle: string): ResumeRead | null {
  const row = db.query<{ handle_id: string; operation: string; valid: string; scope: string; scope_digest: string }, [string, string]>(`
    SELECT h.handle_id,h.operation,h.valid,h.scope,h.scope_digest FROM world_resume_handles h
    JOIN world_view_partitions p USING(partition_id)
    WHERE h.handle_hash=? AND h.expires_at>? AND (p.principal_id='owner' OR EXISTS (
      SELECT 1 FROM agents a WHERE a.agent_id=p.principal_id AND a.revoked_at IS NULL AND a.quarantined_at IS NULL))
  `).get(wireDigest(handle), new Date().toISOString());
  if (row === null || fingerprintOf(Buffer.from(row.scope)) !== row.scope_digest) return null;
  try {
    const valid = parseWorldValid(JSON.parse(row.valid)), scope: unknown = JSON.parse(row.scope);
    if (valid === null || !isPlainObject(scope) || !hasWorldKeys(scope, ["ceiling", "types", "subjects", "since", "until"], [])) return null;
    const grant = validateAgentGrant({ ...OWNER_AGENT_GRANT, ...scope } as Grant);
    return { handle_id: row.handle_id, operation: row.operation, valid, scope: scopeOf(grant) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return null;
    throw error;
  }
}
