import type { Database } from "bun:sqlite";
import { rawSubjectNamespace, type RawSubjectRef } from "../contracts/claim-v2";
import type { Relation } from "../contracts/concept-card";
import type { ServeContext } from "../serving/types";
import type { Eligible, EligibleSupport } from "./pipeline/eligible";
import { WorldProjectionBudgetError } from "./pipeline/frame";
import { issueWorldRef, type WireRef, type WorldNamespace } from "./references";

/** The random handle a raw endpoint was bound to when it was first supported. */
export function handleFor(db: Database, ref: RawSubjectRef): string | null {
  return (
    db
      .query<
        { handle_id: string },
        [string, string, string]
      >("SELECT handle_id FROM semantic_bindings WHERE raw_kind=? AND raw_namespace=? AND raw_id=?")
      .get(ref.kind, rawSubjectNamespace(ref), ref.id)?.handle_id ?? null
  );
}

export function objectRef(
  db: Database,
  ns: WorldNamespace,
  ref: RawSubjectRef,
): WireRef<"object"> {
  const handle = handleFor(db, ref);
  if (handle === null) throw new Error("world endpoint support changed");
  return issueWorldRef(db, ns, "object", handle);
}

/**
 * One eligible claim as the wire `Relation`. Conflict and independence are
 * `unknown` here on purpose: only an enricher that proves them may say more.
 */
export function relation(
  ctx: ServeContext,
  ns: WorldNamespace,
  item: Eligible,
): Relation {
  const semantic = item.semantic;
  if (
    item.supports.reduce(
      (count, support) =>
        count + support.admission.semantic.perspective.anchors.length,
      0,
    ) > 256
  )
    throw new WorldProjectionBudgetError();
  const evidence = (
    support: EligibleSupport,
    anchors = support.admission.semantic.anchors,
  ) =>
    anchors.map((anchor) => ({
      admission: issueWorldRef(
        ctx.db,
        ns,
        "admission",
        support.row.support_key,
      ),
      eventVersion: issueWorldRef(ctx.db, ns, "event_version", anchor.event_id),
      span: {
        kind: "text" as const,
        startUtf16: anchor.start_utf16,
        endUtf16: anchor.end_utf16,
      },
    }));
  const ref = (value: RawSubjectRef | null) =>
    value === null ? null : objectRef(ctx.db, ns, value);
  return {
    schema: "kizuki.relation/v1",
    claim: issueWorldRef(ctx.db, ns, "claim", item.claimId),
    subject: objectRef(ctx.db, ns, semantic.subject),
    predicate: semantic.predicate,
    object:
      semantic.object.kind === "literal"
        ? { kind: "literal", value: semantic.object.value }
        : semantic.object.kind === "vocabulary"
          ? { kind: "vocabulary", id: semantic.object.ref.id }
          : { kind: "node", ref: objectRef(ctx.db, ns, semantic.object.ref) },
    perspective: {
      holder: ref(semantic.perspective.holder),
      speaker: ref(semantic.perspective.speaker),
      addressee: ref(semantic.perspective.addressee),
      mode: semantic.perspective.mode,
      interpretation: semantic.perspective.interpretation,
      evidence: item.supports.flatMap((support) =>
        evidence(support, support.admission.semantic.perspective.anchors),
      ),
    },
    context: semantic.context.map((value) => objectRef(ctx.db, ns, value)),
    polarity: semantic.polarity,
    valid:
      semantic.temporal_basis === "unknown" || semantic.valid_from === null
        ? { kind: "unknown" }
        : {
            kind: "known",
            from: semantic.valid_from,
            until: semantic.valid_to,
          },
    temporalBasis: semantic.temporal_basis,
    assessments: item.supports.map((support) => ({
      admission: issueWorldRef(
        ctx.db,
        ns,
        "admission",
        support.row.support_key,
      ),
      epistemicKind: support.admission.epistemicKind,
      authority: support.admission.authority,
      confidence: { kind: "known", value: support.admission.confidence },
      independence: "unknown",
      evidence: evidence(support),
    })),
    conflict: "unknown",
  };
}
