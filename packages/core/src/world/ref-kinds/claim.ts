import { getClaim } from "../../claims/store";
import type { Claim } from "../../contracts/proposal";
import type { ClaimGroupRef, ScopedRef } from "../../contracts/scoped-refs";
import { authorizedClaimSql } from "../../serving/claim-policy-sql";
import { claimReader } from "../../serving/claims";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { issueWorldRef, resolveWorldClaim } from "../references";
import { allocateRef, ref, type RefScope } from "./common";

export function readableClaim(scope: RefScope, id: string): Claim | null {
  const policy = authorizedClaimSql(scope.ctx);
  if (scope.ctx.db.query(`SELECT 1 FROM claims WHERE claim_id=? AND ${policy.sql}`).get(id, ...policy.bindings) === null) return null;
  const claim = getClaim(scope.ctx.db, id);
  return claim !== null && claimReader(scope.ctx.db, scope.ctx.principal.grant, { owner: scope.ctx.principal.kind === "owner", purpose: scope.ctx.sourcePurpose ?? "recall" }).canRead(claim) ? claim : null;
}
export function issueClaimRef(scope: RefScope, id: string): ScopedRef<"claim"> | null {
  return readableClaim(scope, id) === null ? null : issueWorldRef(scope.ctx.db, scope.ns, "claim", id);
}
export function resolveClaimRef(scope: RefScope, value: ScopedRef): Claim | null {
  if (value.kind !== "claim") return null;
  const id = resolveWorldClaim(scope.ctx.db, scope.ns, value.token);
  return id === null ? null : readableClaim(scope, id);
}
export function issueClaimGroupRef(scope: RefScope, ids: readonly string[]): ClaimGroupRef | null {
  const members = [...new Set(ids)].sort();
  if (members.length < 2 || members.length > 16 || members.some(id => readableClaim(scope, id) === null)) return null;
  const key = sha256Hex(canonicalJson(members));
  const existing = scope.ctx.db.query<{ wire_ref: string }, [string, string]>("SELECT wire_ref FROM world_wire_claim_group_targets WHERE namespace_id=? AND group_key=?").get(scope.ns.id, key);
  if (existing !== null) return ref("claim_group", existing.wire_ref);
  const token = allocateRef(scope.ctx.db, scope.ns, "claim_group");
  scope.ctx.db.query("INSERT INTO world_wire_claim_group_targets(namespace_id,wire_ref,group_key,member_count) VALUES (?,?,?,?)").run(scope.ns.id, token, key, members.length);
  const insert = scope.ctx.db.query("INSERT INTO world_wire_claim_group_members(namespace_id,wire_ref,claim_id) VALUES (?,?,?)");
  for (const id of members) insert.run(scope.ns.id, token, id);
  return ref("claim_group", token);
}
export function resolveClaimGroupRef(scope: RefScope, value: ScopedRef): Claim[] | null {
  if (value.kind !== "claim_group") return null;
  const row = scope.ctx.db.query<{ member_count: number; group_key: string }, [string, string]>("SELECT member_count,group_key FROM world_wire_claim_group_targets WHERE namespace_id=? AND wire_ref=?").get(scope.ns.id, value.token);
  if (row === null) return null;
  const ids = scope.ctx.db.query<{ claim_id: string }, [string, string]>("SELECT claim_id FROM world_wire_claim_group_members WHERE namespace_id=? AND wire_ref=? ORDER BY claim_id LIMIT 17").all(scope.ns.id, value.token).map(row => row.claim_id);
  if (ids.length !== row.member_count || ids.length < 2 || ids.length > 16 || sha256Hex(canonicalJson(ids)) !== row.group_key) return null;
  const claims = ids.map(id => readableClaim(scope, id));
  return claims.every((claim): claim is Claim => claim !== null) ? claims : null;
}
