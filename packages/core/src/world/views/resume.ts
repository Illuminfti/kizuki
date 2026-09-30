import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { SENSITIVITY_ORDER, type Grant } from "../../agents/types";
import { OWNER_AGENT_GRANT } from "../../agents/types";
import { validateAgentGrant } from "../../agents/identity";
import { compareRfc3339 } from "../../agents/time";
import { canonicalJson } from "../../util/hash";
import { isPlainObject } from "../../util/validate";
import type { WorldNamespace } from "../references";
import type { WorldValidQuery } from "../ops/types";
import { hasWorldKeys, parseWorldValid } from "../ops/parse";
import { viewPartitionOf } from "./partitions";
import { fingerprintOf, wireDigest } from "./store";
import { authorizedClaimSql, authorizedSupportSql, validMeaningSql } from "../policy-sql";
import type { ServeContext } from "../../serving/types";

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
    (reader.since !== null && (issuer.since === null || compareRfc3339(reader.since, "since", issuer.since, "since") > 0)) ||
    (reader.until !== null && (issuer.until === null || compareRfc3339(reader.until, "until", issuer.until, "until") < 0));
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

interface ResumeRow {
  readonly handle_id: string | null;
  readonly operation: string;
  readonly valid: string;
  readonly scope: string;
  readonly scope_digest: string;
}

function decodeResume(row: ResumeRow | null): ResumeRead | null {
  if (row?.handle_id == null || fingerprintOf(Buffer.from(row.scope)) !== row.scope_digest) return null;
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

/** Unknown, expired, inactive and unreadable targets are one bounded lookup miss before projection. */
export function lookupResume(ctx: ServeContext, handle: string): ResumeRead | null {
  const { db } = ctx, permitted = authorizedSupportSql(ctx), claim = authorizedClaimSql(ctx);
  // The unique hash selects at most one handle. The aggregate returns one row
  // even after erasure; every cause then runs the same authorization query.
  const row = db.query<ResumeRow, [string, string]>(`
    SELECT max(h.handle_id) AS handle_id,h.operation,h.valid,h.scope,h.scope_digest FROM world_resume_handles h
    JOIN world_view_partitions p USING(partition_id)
    WHERE h.handle_hash=? AND h.expires_at>? AND (p.principal_id='owner' OR EXISTS (
      SELECT 1 FROM agents a WHERE a.agent_id=p.principal_id AND a.revoked_at IS NULL AND a.quarantined_at IS NULL))
  `).get(wireDigest(handle), new Date().toISOString());
  const saved = decodeResume(row), time = validMeaningSql(saved?.valid ?? { kind: "all" });
  const allowed = db.query<{ readable: number }, (string | number)[]>(`
    SELECT EXISTS (
      SELECT 1 FROM semantic_bindings b JOIN claim_v2_semantics c
        ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id
          AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace
      JOIN claims base USING(claim_id) JOIN claim_v2_support s USING(claim_id)
      WHERE b.handle_id=? AND base.status='live' AND c.discriminator='assertion' AND c.predicate='world.kind'
        AND c.polarity='positive' AND json_extract(c.payload,'$.perspective.mode')='asserted'
        AND json_extract(c.payload,'$.object.ref.id')=? AND ${permitted.sql}
        AND ${time.sql} AND ${claim.sql}) AS readable
  `).get(saved?.handle_id ?? "", `world/${saved?.operation ?? ""}`, ...permitted.bindings, ...time.bindings, ...claim.bindings);
  return allowed?.readable === 1 ? saved : null;
}
