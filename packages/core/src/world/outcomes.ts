import { canonicalizeRfc3339Utc } from "../util/time";
import { parseStoredOutcomeEvidence, type StoredOutcomeEvidence } from "./outcome-binding";
import { getClaim } from "../claims/store";
import type { Claim } from "../contracts/proposal";
import { validateOutcomeCard, type OutcomeCard, type OutcomeEvidence, type OutcomeStage } from "../contracts/outcome-card";
import { claimReader, claimPublicationFingerprint } from "../serving/claims";
import { authorizedEventSql } from "./policy-sql";
import { issueWorldRef } from "./references";
import { coverageOf } from "./pipeline/assemble";
import { charge, type ReadFrame } from "./pipeline/frame";
import { eventDerivation } from "./lineage";
import { canonicalJson, sha256Hex } from "../util/hash";
import { sealCard } from "./kinds/kit";

export type OutcomeEntry = { claim: Claim; value: StoredOutcomeEvidence | null; stage: OutcomeStage; observedAt:string|null; sources: Set<string>; texts: Set<string>; rooted: boolean };
function same(a: StoredOutcomeEvidence, b: StoredOutcomeEvidence): boolean {
  return a.subjectRef === b.subjectRef && a.task === b.task && a.attempt === b.attempt && a.criterion === b.criterion && canonicalJson(a.artifactVersion) === canonicalJson(b.artifactVersion) && a.environment === b.environment && a.assistance === b.assistance;
}
/** Root independence is shared by current outcome evaluation and frozen forecasts. */
export function independentOutcomeRoots(report: OutcomeEntry, other: OutcomeEntry): boolean {
  return report.claim.producer !== other.claim.producer && report.claim.producer.startsWith("agent:") && other.claim.producer.startsWith("agent:") &&
    report.rooted && other.rooted && ![...report.sources].some(key => other.sources.has(key)) && ![...report.texts].some(key => other.texts.has(key));
}
function independent(report: OutcomeEntry, other: OutcomeEntry): boolean {
  return report.value !== null && other.value !== null && same(report.value, other.value) && independentOutcomeRoots(report,other);
}
/** Storage binding hashes are never exposed as cross-principal identifiers. */
function publicEvidence(value: StoredOutcomeEvidence | null): OutcomeEvidence | null {
  return value === null ? null : { ...value, subjectRef: value.subjectRef === "none" ? "none" : "bound", artifactVersion: typeof value.artifactVersion === "string" ? value.artifactVersion : "bound" };
}
/** Legacy claims remain the authoritative outcome record. No outcome cache or additional writer.
 * A node-deliverable consumer first projects that exact ArtifactVersion with this
 * frame, retaining its authority dependencies, then supplies its stable binding.
 * An unqualified standalone read never upgrades an opaque binding to completion. */
export function collectOutcomeEntries(frame: ReadFrame, subject: string, subjectRef?: string, artifactBinding?: string): { entries: OutcomeEntry[]; overflow: boolean } {
  const { ctx } = frame;
  const reader = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" });
  const policy = reader.visibility;
  const rows = ctx.db.query<{ claim_id: string }, (string | number)[]>(`SELECT claim_id FROM claims WHERE subject=? AND is_world_typed=0 AND status='live'
    AND predicate IN ('outcome.self_report','outcome.provider_ack','outcome.observation','outcome.review','outcome.reached','outcome.missed')
    AND ${policy.sql}${subjectRef === undefined ? "" : " AND json_extract(CASE WHEN json_valid(object) THEN object ELSE '{}' END,'$.subjectRef')=?"}
    ${artifactBinding === undefined ? "" : "AND json_extract(CASE WHEN json_valid(object) THEN object ELSE '{}' END,'$.artifactVersion.kind')='artifact_binding' AND json_extract(CASE WHEN json_valid(object) THEN object ELSE '{}' END,'$.artifactVersion.digest')=?"}
    ORDER BY claim_id LIMIT 129`).all(subject, ...policy.bindings, ...(subjectRef === undefined ? [] : [subjectRef]), ...(artifactBinding === undefined ? [] : [artifactBinding]));
  frame.stats.rowsExamined += rows.length;
  const eventsPolicy = authorizedEventSql(ctx);
  const entries: OutcomeEntry[] = [];
  for (const row of rows.slice(0, 128)) {
    const claim = getClaim(ctx.db, row.claim_id);
    if (claim === null || !reader.canRead(claim) || claim.polarity !== "positive") continue;
    charge(frame.budget, claim.body); charge(frame.budget, claim.object ?? "");
    const legacy = claim.predicate === "outcome.reached" || claim.predicate === "outcome.missed";
    const value = parseStoredOutcomeEvidence(claim.predicate!, claim.object);
    if ((!legacy && value === null) || (subjectRef !== undefined && value?.subjectRef !== subjectRef) ||
        (artifactBinding !== undefined && (value === null || typeof value.artifactVersion === "string" || value.artifactVersion.digest !== artifactBinding))) continue;
    const events = ctx.db.query<{ source_key: string | null; text_hash: string; text: string; metadata: string; origin: string; occurred_at:string }, (string | number)[]>(
      `SELECT b.source_key,events.text_hash,events.text,events.metadata,events.origin,events.occurred_at FROM events LEFT JOIN source_event_bindings b USING(event_id)
       WHERE event_id IN (SELECT value FROM json_each(?)) AND ${eventsPolicy.clauses.join(" AND ")}`,
    ).all(JSON.stringify(claim.provenance), ...eventsPolicy.bindings);
    frame.stats.rowsExamined += events.length;
    let rooted = events.length === claim.provenance.length;
    const sources = new Set<string>(), texts = new Set<string>();
    for (const event of events) {
      charge(frame.budget, event.metadata); charge(frame.budget, event.text);
      let metadata: unknown; try { metadata = JSON.parse(event.metadata); } catch { rooted = false; continue; }
      rooted &&= sha256Hex(event.text) === event.text_hash && event.source_key !== null && event.origin !== "self" && eventDerivation(metadata) === "independent";
      if (event.source_key !== null) sources.add(event.source_key);
      texts.add(event.text_hash);
    }
    const stage: OutcomeStage["stage"] = legacy || claim.predicate === "outcome.self_report" ? "agent_reported" :
      claim.predicate === "outcome.provider_ack" ? "provider_acknowledged" : claim.predicate === "outcome.observation" ? "observed" : "reviewed";
    frame.dependencies?.legacyClaims.set(claim.claim_id, claimPublicationFingerprint(claim));
    for (const id of claim.provenance) frame.dependencies?.events.add(id);
    const times=new Set(events.map(e=>canonicalizeRfc3339Utc(e.occurred_at)));
    entries.push({ claim, value, rooted, observedAt:times.size===1&&!times.has(null)?[...times][0]!:null, sources, texts, stage: { claim: issueWorldRef(ctx.db, frame.ns, "claim", claim.claim_id), stage, evidence: publicEvidence(value), quoted: (value === null ? claim.object ?? claim.body : canonicalJson(publicEvidence(value))).slice(0, 1024), independent: false } });
  }
  return { entries, overflow: rows.length > 128 };
}
export function readOutcomes(frame: ReadFrame, subject: string, subjectRef?: string, artifactBinding?: string): OutcomeCard {
  const { entries, overflow } = collectOutcomeEntries(frame,subject,subjectRef,artifactBinding);
  const reports = entries.filter(e => e.stage.stage === "agent_reported");
  const groups: OutcomeEntry[][] = [];
  for (const report of reports) {
    const group = groups.find(items => report.value !== null && items[0]!.value !== null && same(report.value, items[0]!.value));
    if (group === undefined) groups.push([report]); else group.push(report);
  }
  const evaluations = groups.map(group => {
    const report = group[0]!;
    const observations = entries.filter(e => e.stage.stage === "observed" && group.every(r => independent(r, e)));
    const reviews = entries.filter(e => e.stage.stage === "reviewed" && group.every(r => independent(r, e)));
    const artifactQualified = report.value !== null && (typeof report.value.artifactVersion === "string" || artifactBinding === report.value.artifactVersion.digest);
    const unconfounded = artifactQualified && !overflow && report.value !== null && group.every(r => r.value !== null && !r.value.confounded) && [...observations, ...reviews].every(e => !e.value!.confounded);
    const negative = observations.some(e => e.value!.result === "not_met") || reviews.some(e => e.value!.result === "rejected");
    const latestReview = reviews.at(-1)?.value?.result, latestObservation = observations.at(-1)?.value?.result;
    const accepted = latestReview === "accepted";
    const met = latestObservation === "met";
    const result = unconfounded && accepted && met && !negative ? "met" as const :
      unconfounded && latestObservation === "not_met" && latestReview === "rejected" ? "not_met" as const : "unknown" as const;
    return { report: report.stage.claim, conditions: publicEvidence(report.value), observations: observations.map(e => e.stage.claim), reviews: reviews.map(e => e.stage.claim),
      result, goalAchieved: result === "met", independentMastery: false };
  });
  const stages = entries.map(e => ({ ...e.stage, independent: groups.some(group => group.every(report => independent(report, e))) }));
  const card: OutcomeCard = { schema: "kizuki.outcome-card/v1", stages, evaluations,
    goalAchieved: evaluations.length > 0 && evaluations.every(e => e.goalAchieved), coverage: coverageOf(frame, overflow) };
  return sealCard(card, validateOutcomeCard, "outcome");
}
