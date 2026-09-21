import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import type { Principal } from "../agents";
import { canonicalJson } from "../util/hash";

export type WireKind =
  | "object"
  | "claim"
  | "admission"
  | "event_version"
  | "principal";
export type WireRef<K extends WireKind = WireKind> = {
  readonly kind: K;
  readonly token: string;
};
export interface WorldNamespace {
  readonly id: string;
  readonly principalId: string;
}

/** Only current authenticated authority establishes the namespace. No source/global epoch enters it. */
export function worldNamespace(
  db: Database,
  principal: Principal,
): WorldNamespace {
  if (!db.inTransaction)
    throw new Error("world reference issuance requires a transaction");
  const principalId =
    principal.kind === "owner" ? "owner" : principal.agent.agent_id;
  const authorization = canonicalJson({
    schema: "kizuki.world-view/v1",
    purpose: "recall",
    kind: principal.kind,
    grant: {
      ...principal.grant,
      types:
        principal.grant.types === null
          ? null
          : [...new Set(principal.grant.types)].sort(),
      subjects:
        principal.grant.subjects === null
          ? null
          : [...new Set(principal.grant.subjects)].sort(),
      tools: [...new Set(principal.grant.tools)].sort(),
    },
    grant_epoch: principal.kind === "owner" ? null : principal.grant_epoch,
  });
  const existing = db
    .query<
      { namespace_id: string; authorization: string },
      [string]
    >("SELECT namespace_id,authorization FROM world_authorization_namespaces WHERE principal_id=?")
    .get(principalId);
  if (existing !== null && existing.authorization === authorization)
    return { id: existing.namespace_id, principalId };
  if (existing !== null)
    db.query(
      "DELETE FROM world_authorization_namespaces WHERE namespace_id=?",
    ).run(existing.namespace_id);
  let id: string;
  do {
    id = randomBytes(16).toString("hex");
  } while (
    db
      .query(
        "SELECT 1 FROM world_authorization_namespaces WHERE namespace_id=?",
      )
      .get(id) !== null
  );
  db.query(
    "INSERT INTO world_authorization_namespaces(namespace_id,principal_id,authorization) VALUES (?,?,?)",
  ).run(id, principalId, authorization);
  return { id, principalId };
}

const TARGETS = {
  object: ["world_wire_object_targets", "handle_id"],
  claim: ["world_wire_claim_targets", "claim_id"],
  admission: ["world_wire_admission_targets", "support_key"],
  event_version: ["world_wire_event_version_targets", "event_id"],
  principal: ["world_wire_principal_targets", "principal_id"],
} as const;

/** Internal only: callers first establish complete current support for each target. */
export function issueWorldRef<K extends WireKind>(
  db: Database,
  ns: WorldNamespace,
  kind: K,
  target: string,
): WireRef<K> {
  if (!db.inTransaction)
    throw new Error("world reference issuance requires a transaction");
  const [table, column] = TARGETS[kind];
  const existing = db
    .query<
      { wire_ref: string },
      [string, string]
    >(`SELECT wire_ref FROM ${table} WHERE namespace_id=? AND ${column}=?`)
    .get(ns.id, target);
  if (existing !== null) return { kind, token: existing.wire_ref };
  let token: string;
  do {
    token = randomBytes(32).toString("base64url");
  } while (
    db
      .query(
        "SELECT 1 FROM world_wire_refs WHERE namespace_id=? AND wire_ref=?",
      )
      .get(ns.id, token) !== null
  );
  db.query(
    "INSERT INTO world_wire_refs(namespace_id,wire_ref,ref_kind) VALUES (?,?,?)",
  ).run(ns.id, token, kind);
  if (kind === "event_version") {
    const row = db
      .query<
        {
          content_hash_version: number;
          content_hash: string;
          text_hash: string;
          origin_binding: string;
          accepted_at: string;
        },
        [string]
      >(
        "SELECT content_hash_version,content_hash,text_hash,origin_binding,accepted_at FROM events WHERE event_id=?",
      )
      .get(target);
    if (row === null) throw new Error("world evidence target unavailable");
    db.query(
      `INSERT INTO ${table}(namespace_id,wire_ref,event_id,content_hash_version,content_hash,text_hash,origin_binding,accepted_at) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      ns.id,
      token,
      target,
      row.content_hash_version,
      row.content_hash,
      row.text_hash,
      row.origin_binding,
      row.accepted_at,
    );
  } else {
    db.query(
      `INSERT INTO ${table}(namespace_id,wire_ref,${column}) VALUES (?,?,?)`,
    ).run(ns.id, token, target);
  }
  return { kind, token };
}

export function resolveWorldObject(
  db: Database,
  ns: WorldNamespace,
  token: string,
): string | null {
  return (
    db
      .query<{ handle_id: string }, [string, string]>(
        `SELECT t.handle_id FROM world_wire_object_targets t
    JOIN world_wire_refs r USING(namespace_id,wire_ref)
    WHERE t.namespace_id=? AND t.wire_ref=? AND r.ref_kind='object'`,
      )
      .get(ns.id, token)?.handle_id ?? null
  );
}
