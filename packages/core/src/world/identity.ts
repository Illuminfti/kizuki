import { heldClaimSql } from "./corroboration";
import { supportLineage } from "./lineage";
import { authorizedClaimSql, authorizedSupportSql, validMeaningSql } from "./policy-sql";
import { verifyClaim } from "./pipeline/collect";
import { claimVisibleSql, type ReadFrame } from "./pipeline/frame";
import type { Cluster, Grouper } from "./pipeline/group";
import type { Eligible } from "./pipeline/eligible";
import type { RawSubjectRef } from "../contracts/claim-v2";
import type { ServeContext } from "../serving/types";
import { handleFor } from "./relation";
import { newReadFrame } from "./pipeline/frame";
import { worldNamespace } from "./references";
import { getCanonReceipt } from "../canon/receipts";
import { isWorldCanonReceipt } from "../canon/world-receipt";

export const IDENTITY_MAX_MEMBERS = 256;
export const IDENTITY_MAX_EDGES = 1024;

type Edge = { claim_id: string; left: string; right: string };
type Pair = { left: string; right: string; claims: Eligible[]; blocked: boolean };

/** Identity is a read projection over ordinary claims, never a persistent representative. */
const frames = new WeakMap<ReadFrame, Map<string, Cluster>>();

function asserted(item: Eligible): boolean {
  const p = item.semantic.perspective;
  return p.mode === "asserted" && p.holder === null && p.speaker === null && p.addressee === null && item.semantic.context.length === 0;
}

function nativeReceipted(frame: ReadFrame, item: Eligible): boolean {
  const id = frame.ctx.db.query<{ receipt_id: string | null }, [string]>("SELECT receipt_id FROM claims WHERE claim_id=?").get(item.claimId)?.receipt_id;
  if (!id) return false;
  const receipt = getCanonReceipt(frame.ctx.db, id);
  return receipt !== null && isWorldCanonReceipt(receipt) && receipt.state === "retained" && receipt.claim_ids.includes(item.claimId);
}

/** Complete current policy is applied to both endpoints before an edge can consume a scan slot. */
function classificationRule(frame: ReadFrame, endpoint: string) {
  const support = authorizedSupportSql(frame.ctx), claim = authorizedClaimSql(frame.ctx, "classified"),
    time = validMeaningSql(frame.valid, "kind"), held = heldClaimSql("classified", support);
  return {
    sql: `kind.subject_kind=${endpoint}.raw_kind AND kind.subject_id=${endpoint}.raw_id
      AND coalesce(json_extract(kind.payload,'$.subject.namespace'),'')=${endpoint}.raw_namespace
      AND kind.predicate='world.kind' AND kind.polarity='positive'
      AND json_extract(kind.payload,'$.object.ref.id')='world/concept'
      AND json_extract(kind.payload,'$.perspective.mode')='asserted'
      AND ${claimVisibleSql(frame, "classified")} AND ${claim.sql} AND ${time.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=kind.claim_id AND ${support.sql})
      AND NOT ${held.sql}`,
    bindings: [...claim.bindings, ...time.bindings, ...support.bindings, ...held.bindings],
  };
}

function classificationSql(frame: ReadFrame, endpoint: string) {
  const rule = classificationRule(frame, endpoint);
  return { ...rule, sql: `EXISTS(SELECT 1 FROM claim_v2_semantics kind JOIN claims classified USING(claim_id) WHERE ${rule.sql})` };
}

/** Full proof also records endpoint classification dependencies for publication. */
function verifyClassification(frame: ReadFrame, handle: string): boolean {
  const rule = classificationRule(frame, "b");
  const rows = frame.ctx.db.query<{ claim_id: string }, (string | number)[]>(`
    SELECT kind.claim_id FROM semantic_bindings b, claim_v2_semantics kind JOIN claims classified USING(claim_id)
    WHERE b.handle_id=? AND ${rule.sql} ORDER BY kind.claim_id LIMIT 32
  `).all(handle, ...rule.bindings);
  frame.stats.rowsExamined += rows.length;
  return rows.some(row => verifyClaim(frame, row.claim_id) !== null);
}

/**
 * Walk only eligible same-as edges. Weak nominations do not join components;
 * negative same-as or a semantic distinction blocks the entire disputed
 * component, rather than choosing a path that evades the negative constraint.
 */
export function identityCluster(frame: ReadFrame, anchor: string, joining?: string): Cluster {
  let cache = frames.get(frame);
  if (!cache) { cache = new Map(); frames.set(frame, cache); }
  const hit = joining === undefined ? cache.get(anchor) : undefined;
  if (hit) return hit;
  const support = authorizedSupportSql(frame.ctx), claim = authorizedClaimSql(frame.ctx),
    time = validMeaningSql(frame.valid), held = heldClaimSql("base", support),
    left = classificationSql(frame, "l"), right = classificationSql(frame, "r");
  const query = frame.ctx.db.query<Edge, (string | number)[]>(`
    SELECT c.claim_id,l.handle_id AS left,r.handle_id AS right
    FROM claim_v2_semantics c JOIN claims base USING(claim_id)
    JOIN semantic_bindings l ON l.raw_kind=c.subject_kind AND l.raw_id=c.subject_id
      AND l.raw_namespace=coalesce(json_extract(c.payload,'$.subject.namespace'),'')
    JOIN semantic_bindings r ON r.raw_kind=json_extract(c.payload,'$.object.ref.kind')
      AND r.raw_id=json_extract(c.payload,'$.object.ref.id')
      AND r.raw_namespace=coalesce(json_extract(c.payload,'$.object.ref.namespace'),'')
    WHERE c.discriminator='assertion' AND c.predicate IN ('concept.same_as','concept.distinguished_from')
      AND (l.handle_id=? OR r.handle_id=?) AND l.handle_id<>r.handle_id
      AND ${claimVisibleSql(frame, "base")} AND ${claim.sql} AND ${time.sql}
      AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${support.sql})
      AND NOT ${held.sql} AND ${left.sql} AND ${right.sql}
    ORDER BY c.claim_id LIMIT ?`);
  const bindings = [...claim.bindings, ...time.bindings, ...support.bindings, ...held.bindings, ...left.bindings, ...right.bindings];
  const members = new Set(joining === undefined ? [anchor] : [anchor, joining]), seen = new Set<string>(), pairs = new Map<string, Pair>();
  const queue = [...members], classified = new Map<string, boolean>();
  const endpointAllowed = (handle: string): boolean => {
    if (!classified.has(handle)) classified.set(handle, verifyClassification(frame, handle));
    return classified.get(handle)!;
  };
  let ambiguous = false, overflow = false;
  for (let cursor = 0; cursor < queue.length && !overflow; cursor++) {
    const node = queue[cursor]!;
    const rows = query.all(node, node, ...bindings, IDENTITY_MAX_EDGES + 1);
    frame.stats.rowsExamined += rows.length;
    if (rows.length > IDENTITY_MAX_EDGES) { overflow = true; break; }
    for (const row of rows) {
      if (seen.has(row.claim_id)) continue;
      seen.add(row.claim_id);
      if (seen.size + (joining === undefined ? 0 : 1) > IDENTITY_MAX_EDGES) { overflow = true; break; }
      const item = verifyClaim(frame, row.claim_id);
      if (!item || !asserted(item) || !endpointAllowed(row.left) || !endpointAllowed(row.right)) continue;
      // Filing a native statement precedes its reserved canon write. Until the
      // receipt exists it cannot change identity, including after a failed write.
      if (item.supports.every(s => s.row.support_origin === "native_owner") && !nativeReceipted(frame, item)) continue;
      const ends = [row.left, row.right].sort(), key = JSON.stringify(ends);
      let pair = pairs.get(key);
      if (!pair) { pair = { left: ends[0]!, right: ends[1]!, claims: [], blocked: false }; pairs.set(key, pair); }
      const negative = item.semantic.predicate === "concept.same_as" ? item.semantic.polarity === "negative" : item.semantic.polarity === "positive";
      if (negative) pair.blocked = true;
      else if (item.semantic.predicate === "concept.same_as") pair.claims.push(item);
    }
    // Two assertions of the same pair may carry independent supports even
    // when their validity starts differ. Copies and shared roots still count once.
    for (const pair of pairs.values()) {
      if (!members.has(pair.left) && !members.has(pair.right)) continue;
      const supports = pair.claims.flatMap(item => item.supports);
      const qualifies = pair.claims.some(item => nativeReceipted(frame, item) && item.supports.some(s => s.row.support_origin === "native_owner")) ||
        (supports.length > 0 && supportLineage(frame, supports).count >= 2);
      if (pair.blocked || !qualifies) { ambiguous = true; continue; }
      for (const next of [pair.left, pair.right]) if (!members.has(next)) {
        if (members.size === IDENTITY_MAX_MEMBERS) { overflow = true; break; }
        members.add(next); queue.push(next);
      }
    }
  }
  const disputed = [...pairs.values()].some(pair => pair.blocked && members.has(pair.left) && members.has(pair.right));
  const component = [...members].sort();
  // Never publish an incomplete component as a resolved identity.
  const split = overflow || disputed;
  const result = (member: string): Cluster => ({
    anchor: member, members: split ? [member] : component,
    resolution: split || ambiguous ? "ambiguous" : component.length > 1 ? "resolved" : "distinct",
    ...(overflow ? { overflow: true } : {}),
  });
  if (joining !== undefined) return result(anchor);
  for (const member of component) cache.set(member, result(member));
  return cache.get(anchor)!;
}

export const identityGrouper: Grouper = (frame, cluster) => identityCluster(frame, cluster.anchor);

/** Native correction preflight uses the same scoped traversal, before recording any statement. */
export function identityCorrectionAllowed(ctx: ServeContext, subject: RawSubjectRef, object: RawSubjectRef): boolean {
  return ctx.db.transaction(() => {
    const left = handleFor(ctx.db, subject), right = handleFor(ctx.db, object);
    if (left === null || right === null || left === right) return false;
    const frame = newReadFrame(ctx, worldNamespace(ctx.db, ctx.principal), { kind: "all" });
    const classification = classificationSql(frame, "b");
    const rows = ctx.db.query<{ handle_id: string }, (string | number)[]>(
      `SELECT b.handle_id FROM semantic_bindings b WHERE b.handle_id IN (?,?) AND ${classification.sql}`,
    ).all(left, right, ...classification.bindings);
    return rows.length === 2 && identityCluster(frame, left, right).overflow !== true;
  }).immediate();
}
