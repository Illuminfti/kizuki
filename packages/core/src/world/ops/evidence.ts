import type { ConceptEvidenceRef } from "../../contracts/concept-card";
import { evidenceRef } from "../../contracts/world-card-kit";
import { expandTimelineDetail, EXPAND_OFFSET_MAX, EXPAND_SPAN_MAX } from "../../serving/expand";
import { currentQuotedSource } from "../../serving/ledger";
import { createRedactor } from "../../serving/redact";
import { authorizedClaimSql, authorizedSupportSql, validMeaningSql } from "../policy-sql";
import { verifyClaim } from "../pipeline/collect";
import { newReadFrame, claimVisibleSql } from "../pipeline/frame";
import { NOT_FOUND } from "./outcome";
import type { ClaimsOp } from "./types";

export const evidenceOp: ClaimsOp<ConceptEvidenceRef> = {
  source: "claims", name: "evidence", keys: { required: ["evidence"], optional: [] },
  dataSchemas: ["kizuki.world-evidence/v1"],
  parse: (input) => evidenceRef(input.evidence) && input.evidence.span.kind === "text" ? input.evidence : null,
  run: ({ ctx, ns }, evidence, { valid }) => {
    const frame = newReadFrame(ctx, ns, valid);
    const permitted = authorizedSupportSql(ctx), claim = authorizedClaimSql(ctx), time = validMeaningSql(valid);
    // Push every policy restriction ahead of lookup/work accounting, even for
    // refs issued before revocation. A reference never confers authority.
    const target = ctx.db.query<{ claim_id: string; support_key: string; event_id: string; text_hash: string }, (string | number)[]>(
      `SELECT s.claim_id,s.support_key,e.event_id,e.text_hash FROM world_wire_admission_targets a
       JOIN world_wire_refs ar ON ar.namespace_id=a.namespace_id AND ar.wire_ref=a.wire_ref AND ar.ref_kind='admission'
       JOIN claim_v2_support s USING(support_key) JOIN claim_v2_semantics c USING(claim_id) JOIN claims base USING(claim_id)
       JOIN world_wire_event_version_targets e ON e.namespace_id=a.namespace_id
       JOIN world_wire_refs er ON er.namespace_id=e.namespace_id AND er.wire_ref=e.wire_ref AND er.ref_kind='event_version'
       JOIN claim_v2_support_events se ON se.support_key=s.support_key AND se.event_id=e.event_id
       JOIN events ev ON ev.event_id=e.event_id AND ev.content_hash_version=e.content_hash_version AND ev.content_hash=e.content_hash
         AND ev.text_hash=e.text_hash AND ev.origin_binding=e.origin_binding AND ev.accepted_at=e.accepted_at
       WHERE a.namespace_id=? AND a.wire_ref=? AND e.wire_ref=? AND ${claimVisibleSql(frame, "base")}
         AND ${claim.sql} AND ${time.sql} AND ${permitted.sql}`,
    ).get(ns.id, evidence.admission.token, evidence.eventVersion.token, ...claim.bindings, ...time.bindings, ...permitted.bindings);
    if (!target) return NOT_FOUND;
    const eligible = verifyClaim(frame, target.claim_id);
    const support = eligible?.supports.find((s) => s.row.support_key === target.support_key);
    if (!support || evidence.span.kind !== "text") return NOT_FOUND;
    const { startUtf16: start, endUtf16: end } = evidence.span;
    if (![...support.admission.semantic.anchors, ...support.admission.semantic.perspective.anchors].some((a) => a.event_id === target.event_id && a.start_utf16 === start && a.end_utf16 === end)) return NOT_FOUND;
    const source = currentQuotedSource(ctx.db, target.event_id);
    if (!source) return NOT_FOUND;
    // Map raw UTF-16 anchors into the fully redacted code-point stream used
    // by timeline expansion. Refuse a cut through a credential-shaped span.
    const mapping = createRedactor(ctx.principal);
    const prefix = mapping.text(source.text.slice(0, start)), selected = mapping.text(source.text.slice(start, end));
    if (prefix + selected + mapping.text(source.text.slice(end)) !== mapping.text(source.text)) return NOT_FOUND;
    const offset = Array.from(prefix).length, length = Array.from(selected).length;
    if (offset > EXPAND_OFFSET_MAX || length === 0) return NOT_FOUND;
    const expanded = expandTimelineDetail(ctx, { event_id: target.event_id, integrity: target.text_hash, offset, span: Math.min(length, EXPAND_SPAN_MAX) });
    const quote = expanded.quoted[0];
    if (!quote || !expanded.data) return NOT_FOUND;
    return { status: "data", data: { schema: "kizuki.world-evidence/v1", evidence }, gaps: null,
      quoted: [{ ...quote, ...expanded.data, evidence, truncated: expanded.data.returned < length }],
    };
  },
};
