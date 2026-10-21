import type { Claim } from "../contracts/proposal";
import type { PersonCard } from "../contracts/person-card";
import type { ServeContext } from "../serving/types";
import { authorizedClaimSql, authorizedSupportSql, validMeaningSql } from "./policy-sql";
import { heldClaimSql } from "./corroboration";
import { newReadFrame } from "./pipeline/frame";
import { readWorldCard } from "./pipeline/read";
import { worldNamespace } from "./references";
import { worldDependencies } from "./dependencies";

/** Prefer a Person only when the owner's identity evidence names its exact supplied source subject. */
export function sessionPerson(ctx: ServeContext, identity: Claim, at: string) {
  const subject = identity.subject;
  if (subject === null) return null;
  const permitted = authorizedSupportSql(ctx), claim = authorizedClaimSql(ctx);
  const held = heldClaimSql("base", permitted), valid = validMeaningSql({ kind: "at", at });
  return ctx.db.transaction(() => {
    const handles = ctx.db.query<{ handle_id: string }, (string | number)[]>(`SELECT DISTINCT b.handle_id
      FROM semantic_bindings b JOIN claim_v2_semantics c ON c.subject_kind=b.raw_kind AND c.subject_id=b.raw_id
        AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=b.raw_namespace
      JOIN claims base ON base.claim_id=c.claim_id
      WHERE b.raw_kind='supplied' AND b.raw_id=? AND base.status='live' AND c.predicate='world.kind' AND c.polarity='positive'
        AND json_extract(c.payload,'$.perspective.mode')='asserted' AND json_extract(c.payload,'$.object.ref.id')='world/person'
        AND ${claim.sql} AND ${valid.sql} AND NOT ${held.sql} AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id AND ${permitted.sql})
        AND EXISTS(SELECT 1 FROM events e JOIN source_event_bindings source ON source.event_id=e.event_id
          WHERE e.event_id IN (SELECT value FROM json_each(?))
          AND e.connector_id=json_extract(b.raw_namespace,'$.connector_id') AND source.source_key=json_extract(b.raw_namespace,'$.source_key')
          AND EXISTS(SELECT 1 FROM json_each(e.subjects) subject WHERE json_extract(subject.value,'$.subject_id')=b.raw_id))
      ORDER BY b.handle_id LIMIT 2`).all(subject, ...claim.bindings, ...valid.bindings, ...held.bindings, ...permitted.bindings, JSON.stringify(identity.provenance));
    // An unqualified legacy id cannot pick one of several connector identities.
    if (handles.length !== 1) return null;
    const deps = worldDependencies();
    // Session consumers render labels and qualified relations, never the summary.
    const frame = newReadFrame(ctx, worldNamespace(ctx.db, ctx.principal), { kind: "at", at }, deps);
    const card = readWorldCard({ ...frame, projection: "relations" }, handles[0]!.handle_id, "person");
    // The registered Person assembler owns this schema, as in projectWorldCard.
    return card?.schema === "kizuki.person-card/v1" ? { card: card as PersonCard, deps } : null;
  })();
}
