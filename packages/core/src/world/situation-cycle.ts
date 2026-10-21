import type { Database } from "bun:sqlite";
import type { ClaimV2Assertion, RawSubjectRef } from "../contracts/claim-v2";
import { rawSubjectNamespace, rawSubjectRefKey } from "../contracts/claim-v2";
import { ClaimError } from "../claims/errors";
import type { ClaimVisibility } from "../claims/visibility";
import { getClaim } from "../claims/store";
import { sourceServingSql, type SourceReadScope } from "../ledger/source-grants";
import { LIVE_PREDICATE } from "../ledger/ledger";
import { canonicalJson } from "../util/hash";
import { compareRfc3339 } from "../agents/time";

export const ACYCLIC_SITUATION_PREDICATES = ["situation.requires","situation.enables","situation.blocks"] as const;
export const isSituationDependency = (predicate: string) => (ACYCLIC_SITUATION_PREDICATES as readonly string[]).includes(predicate);
export function dependencyPerspective(value: ClaimV2Assertion): string {
  const { holder, speaker, addressee, mode, interpretation } = value.perspective;
  return canonicalJson({holder,speaker,addressee,mode,interpretation,context:value.context});
}
function overlaps(a: Pick<ClaimV2Assertion,"valid_from"|"valid_to">,b: Pick<ClaimV2Assertion,"valid_from"|"valid_to">): boolean {
  return !(a.valid_to !== null && b.valid_from !== null && compareRfc3339(a.valid_to,"until",b.valid_from,"from") <= 0)
    && !(b.valid_to !== null && a.valid_from !== null && compareRfc3339(b.valid_to,"until",a.valid_from,"from") <= 0);
}

/** The shared insertion transaction checks only evidence visible to this writer. No graph is persisted. */
export function assertSituationAcyclic(db: Database, semantic: ClaimV2Assertion, scope: SourceReadScope, visibility?: ClaimVisibility): void {
  if (!isSituationDependency(semantic.predicate) || semantic.polarity !== "positive" || semantic.perspective.mode !== "asserted" || semantic.object.kind !== "subject") return;
  const goal = rawSubjectRefKey(semantic.subject), perspective = dependencyPerspective(semantic);
  const source = sourceServingSql(db,scope,2);
  const visible = visibility?.sql ?? "1";
  const query = db.query<{claim_id:string;payload:string},(string|number)[]>(`
    SELECT c.claim_id,c.payload FROM claim_v2_semantics c JOIN claims USING(claim_id)
    WHERE claims.status='live' AND claims.is_world_typed=1 AND c.subject_kind=? AND c.subject_id=?
      AND coalesce(json_extract(c.payload,'$.subject.namespace'),'')=?
      AND c.predicate IN ('situation.requires','situation.enables','situation.blocks') AND c.polarity='positive'
      AND json_extract(c.payload,'$.perspective.mode')='asserted' AND json_extract(c.payload,'$.object.kind')='subject'
      AND ${visible} AND EXISTS(SELECT 1 FROM claim_v2_support s WHERE s.claim_id=c.claim_id
        AND EXISTS(SELECT 1 FROM claim_v2_support_events se WHERE se.support_key=s.support_key)
        AND NOT EXISTS(SELECT 1 FROM claim_v2_support_events se LEFT JOIN events ON events.event_id=se.event_id
          WHERE se.support_key=s.support_key AND (events.event_id IS NULL OR events.content_hash<>se.event_content_hash
            OR NOT (${LIVE_PREDICATE}${source === null ? "" : ` AND ${source.sql}`}))))
    ORDER BY c.claim_id LIMIT 129`);
  const queue: { endpoint: RawSubjectRef; valid_from: string | null; valid_to: string | null }[] = [
    {endpoint: semantic.object.ref,valid_from: semantic.valid_from,valid_to: semantic.valid_to}], seen = new Set<string>();
  let edges = 0;
  while (queue.length) {
    const current = queue.shift()!, endpoint = current.endpoint, key = rawSubjectRefKey(endpoint);
    if (key === goal) throw new ClaimError("world_cycle","situation dependency would create a cycle");
    const intervalKey = `${key}:${current.valid_from}:${current.valid_to}`;
    if (seen.has(intervalKey)) continue;
    seen.add(intervalKey);
    if (seen.size > 128) throw new ClaimError("schema_invalid","situation dependency traversal exceeds its bound");
    const rows = query.all(endpoint.kind,endpoint.id,rawSubjectNamespace(endpoint),...(visibility?.bindings ?? []),...(source?.bindings ?? []));
    if (rows.length > 128 || (edges += rows.length) > 512) throw new ClaimError("schema_invalid","situation dependency traversal exceeds its bound");
    for (const row of rows) {
      if (visibility !== undefined) { const claim = getClaim(db,row.claim_id); if (claim === null || !visibility.canRead(claim)) continue; }
      const next = JSON.parse(row.payload) as ClaimV2Assertion;
      if (next.object.kind === "subject" && dependencyPerspective(next) === perspective && overlaps(current,next)) queue.push({endpoint:next.object.ref,
        valid_from: current.valid_from === null ? next.valid_from : next.valid_from === null ? current.valid_from : compareRfc3339(current.valid_from,"from",next.valid_from,"from") >= 0 ? current.valid_from : next.valid_from,
        valid_to: current.valid_to === null ? next.valid_to : next.valid_to === null ? current.valid_to : compareRfc3339(current.valid_to,"until",next.valid_to,"until") <= 0 ? current.valid_to : next.valid_to,
      });
    }
  }
}
