import { OBSERVATION_SCHEMA, validateObservation, type Observation } from "../../contracts/observation";
import { parseScopedRef, type ScopedRef } from "../../contracts/scoped-refs";
import type { EvidenceRef } from "../../contracts/world-card-kit";
import { canonicalJson, sha256Hex } from "../../util/hash";
import { compareRfc3339 } from "../../agents/time";
import { tableExists } from "../../ledger/schema";
import { resolveKnownTime } from "../known/cutoff";
import { issueWorldRef } from "../references";
import { issueCapturedSubjectRef, issueEventVersionRef } from "../ref-kinds/evidence";
import { issueObservationRef, resolveObservationRef } from "../ref-kinds/observation";
import { NOT_FOUND } from "./outcome";
import type { ClaimsOp, WorldValidQuery } from "./types";
function matches(time: Observation["occurred"], valid: WorldValidQuery): boolean {
  if (valid.kind === "all") return true;
  if (time.kind === "unknown") return valid.kind === "unknown_only";
  if (valid.kind === "unknown_only") return false;
  const before = valid.kind === "at" ? valid.at : valid.until, after = valid.kind === "at" ? valid.at : valid.from;
  return compareRfc3339(time.from, "from", before, "at") <= (valid.kind === "at" ? 0 : -1) &&
    (time.until === null || compareRfc3339(time.until, "until", after, "at") > 0);
}
export const observationOp: ClaimsOp<ScopedRef> = {
  source: "claims", name: "observation", keys: { required: ["ref"], optional: [] }, knownAt: true,
  dataSchemas: [OBSERVATION_SCHEMA],
  parse: input => parseScopedRef(input.ref),
  run: ({ ctx, ns, dependencies }, value, { valid, knownAt }) => {
    if (!tableExists(ctx.db, "world_observations")) return { status: "unavailable", reason: "storage" };
    // Existing snapshots are bound to their originating semantic query. An
    // Observation never borrows a different query's historical capability.
    if (knownAt.kind === "snapshot") return { status: "unavailable", reason: "history" };
    const cutoff = knownAt.kind === "time" ? resolveKnownTime(ctx.db, knownAt.at) : undefined;
    const scope = { ctx, ns }, found = resolveObservationRef(scope, value, cutoff);
    if (found === null || !matches(found.record.occurred, valid)) return NOT_FOUND;
    const admission = issueWorldRef(ctx.db, ns, "admission", found.supportKey), evidence = new Map<string, EvidenceRef>();
    for (const item of found.record.evidence) {
      const eventVersion = issueEventVersionRef(scope, item.eventId);
      if (eventVersion === null) return NOT_FOUND;
      evidence.set(item.id, { admission, eventVersion, span: item.span });
    }
    const attribution: Observation["attribution"][number][] = [];
    for (const item of found.record.attribution) {
      const basis = item.evidenceIds.map(id => found.record.evidence.find(e => e.id === id));
      if (basis.length === 0 || basis.some(e => e === undefined || e.span.kind !== "metadata" || e.span.field !== item.field)) return NOT_FOUND;
      const eventId = basis[0]!.eventId;
      if (basis.some(e => e!.eventId !== eventId)) return NOT_FOUND;
      const ref = issueCapturedSubjectRef(scope, eventId, item.ref.id);
      if (ref === null) return NOT_FOUND;
      attribution.push({ role: item.role, ref, basis: "source_field", field: item.field, evidence: item.evidenceIds.map(id => evidence.get(id)!) });
    }
    const data: Observation = { schema: OBSERVATION_SCHEMA, ref: issueObservationRef(scope, found.record.id), evidence: [...evidence.values()], attribution,
      fidelity: found.record.fidelity, occurred: found.record.occurred, sourceObservedAt: found.record.sourceObservedAt, admittedAt: found.record.recorded.admittedAt };
    if (!validateObservation(data).ok) return NOT_FOUND;
    if (dependencies !== undefined) {
      if (cutoff !== undefined) dependencies.cutoff = cutoff;
      dependencies.supports.add(found.supportKey);
      for (const event of found.events) dependencies.events.add(event);
      dependencies.observations.set(found.record.id, sha256Hex(canonicalJson(found.record)));
    }
    return { status: "data", data, gaps: null };
  },
};
