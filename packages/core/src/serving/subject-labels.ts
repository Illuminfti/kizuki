import type { AuditItem, Grant } from "../agents";
import { isSensitivity, SENSITIVITY_ORDER } from "../agents";
import { MAX_AUDIT_ITEMS } from "../agents/types";
import { compareRfc3339 } from "../agents/time";
import { claimKey } from "../claims/hash";
import { getClaim } from "../claims/store";
import { compareText } from "../util/order";
import { stringArray, type CanonPage } from "../vault/pages";
import { pageDecision, type CanonIndex } from "./canon";
import { claimReader } from "./claims";
import type { CanonChunk, QuotedChunk, SubjectLabel, SubjectLabelDegradation } from "./types";

const MAX_SUBJECTS = 50;
const MAX_PER_SUBJECT = 32;
const MAX_CLAIMS = 256;
const MAX_HANDLES = 4;
const MAX_LABEL_POINTS = 160;

export interface SubjectLabelProjection {
  labels: Map<string, SubjectLabel>;
  audit: Map<string, AuditItem>;
  degraded: SubjectLabelDegradation[];
}

/** The writer's current hash-bound subject, never an unbound metadata alias. */
export function canonSubjects(index: CanonIndex, page: CanonPage): string[] {
  const row = index.sourceContext.db.query<{ subject_key: string | null }, [string, string, string]>(
    "SELECT subject_key FROM page_index WHERE page_id=? AND rel_path=? AND last_hash=?",
  ).get(page.id, page.relPath, page.contentHash);
  return [...new Set([...stringArray(page.data["subjects"]), ...(row?.subject_key ? [row.subject_key] : [])])];
}

/** One bounded projection per serving call, after ordinary result admission. */
export function projectSubjectLabels(index: CanonIndex, grant: Grant, at: string, subjects: readonly string[], baseAuditItems = 0): SubjectLabelProjection {
  try {
    const result = readSubjectLabels(index, grant, at, subjects);
    // Every released label claim must fit the existing single-row audit cap.
    // Decide before matching names so an unauditable label cannot nominate a hit.
    if (result.audit.size + baseAuditItems > MAX_AUDIT_ITEMS) {
      result.labels.clear(); result.audit.clear();
      if (!result.degraded.includes("subject-labels-overflow")) result.degraded.push("subject-labels-overflow");
    }
    return result;
  }
  catch { return { labels: new Map(), audit: new Map(), degraded: ["subject-labels-unavailable"] }; }
}

function readSubjectLabels(index: CanonIndex, grant: Grant, at: string, subjects: readonly string[]): SubjectLabelProjection {
  const result: SubjectLabelProjection = { labels: new Map(), audit: new Map(), degraded: [] };
  const degrade = (code: SubjectLabelDegradation): void => { if (!result.degraded.includes(code)) result.degraded.push(code); };
  const exact = [...new Set(subjects)].sort(compareText);
  if (exact.length > MAX_SUBJECTS) { degrade("subject-labels-overflow"); return result; }
  const ctx = index.sourceContext;
  const reader = claimReader(ctx.db, grant, { owner: ctx.principal.kind === "owner", purpose: ctx.sourcePurpose ?? "recall" });
  let count = 0;
  for (const subject of exact) {
    const rows = ctx.db.query<{ claim_id: string }, [string, number]>(`
      SELECT claim_id FROM claims WHERE subject=? AND status='live'
        AND predicate IN ('identity.display_name','identity.handle_on')
      ORDER BY claim_id LIMIT ?
    `).all(subject, MAX_PER_SUBJECT + 1);
    count += rows.length;
    if (count > MAX_CLAIMS) {
      result.labels.clear(); result.audit.clear(); degrade("subject-labels-overflow"); return result;
    }
    if (rows.length > MAX_PER_SUBJECT) { degrade("subject-labels-overflow"); continue; }
    const names = new Set<string>(), handles = new Set<string>();
    const evidence: SubjectLabel["evidence"] = [];
    let unusable = false, disputed = false;
    for (const row of rows) {
      const claim = getClaim(ctx.db, row.claim_id);
      if (!claim || claim.subject !== subject || claim.status !== "live" ||
          claim.receipt_id === null || (claim.predicate !== "identity.display_name" && claim.predicate !== "identity.handle_on") || claim.claim_key !== claimKey(subject, claim.predicate) ||
          !reader.canRead(claim)) continue;
      try {
        if (compareRfc3339(claim.valid_from, "valid_from", at, "at") > 0 ||
            claim.valid_to !== null && compareRfc3339(at, "at", claim.valid_to, "valid_to") >= 0) continue;
      } catch { unusable = true; continue; }
      // A historical claim row is insufficient: its actual writer receipt and
      // current claim-key/page binding must still lead to an admitted revision.
      const binding = ctx.db.query<{ page_id: string; rel_path: string; last_hash: string }, [string, string, string]>(`
        SELECT p.page_id,p.rel_path,p.last_hash FROM canon_receipts r
        JOIN page_index p ON p.rel_path=r.page_path
        JOIN claim_bindings b ON b.page_id=p.page_id AND b.claim_key=?
        WHERE r.receipt_id=? AND r.reverted_by IS NULL
          AND EXISTS (SELECT 1 FROM json_each(r.claim_ids) WHERE value=?) LIMIT 1
      `).get(claim.claim_key, claim.receipt_id, claim.claim_id);
      const page = binding === null ? undefined : index.byId.get(binding.page_id);
      if (page === undefined || page.relPath !== binding?.rel_path || page.contentHash !== binding.last_hash) continue;
      const decision = pageDecision(index, grant, page);
      if (!decision.allow || !claim.provenance.every(id => decision.evidence.sourceIds.includes(id))) continue;
      if (claim.polarity !== "positive") { disputed = true; continue; }
      const value = claim.object;
      // Exact values decide ambiguity; display truncation is never an identity key.
      if (value === null || value.trim() === "" || [...value].length > MAX_LABEL_POINTS || /[\u0000-\u001f\u007f]/.test(value)) {
        unusable = true; continue;
      }
      if (claim.predicate === "identity.display_name") names.add(value);
      else handles.add(value);
      evidence.push({ claim_id: claim.claim_id, authority: claim.authority, sources: [...claim.provenance] });
    }
    if (unusable) { degrade("subject-labels-unavailable"); continue; }
    if (names.size > 1 || disputed) { degrade("subject-labels-ambiguous"); continue; }
    if (handles.size > MAX_HANDLES) { degrade("subject-labels-overflow"); continue; }
    if (evidence.length === 0) continue;
    result.labels.set(subject, { subject, display_name: [...names][0] ?? null, handles: [...handles].sort(compareText), evidence });
    for (const item of evidence) for (const audit of reader.auditClaim(item.claim_id)) result.audit.set(audit.id, audit);
  }
  return result;
}

export function labelsFor(projection: SubjectLabelProjection, subjects: readonly string[]): SubjectLabel[] {
  return [...new Set(subjects)].sort(compareText).flatMap(subject => {
    const label = projection.labels.get(subject); return label === undefined ? [] : [label];
  });
}

/** Attach only to admitted results and audit exactly the label claims released. */
export function attachSubjectLabels(projection: SubjectLabelProjection, chunk: CanonChunk | QuotedChunk, subjects: readonly string[]): AuditItem[] {
  const labels = labelsFor(projection, subjects);
  if (labels.length === 0) return [];
  chunk.subject_labels = labels;
  if ("sources" in chunk) chunk.sources = [...new Set([...chunk.sources, ...labels.flatMap(label => label.evidence.flatMap(item => item.sources))])];
  const audit = [...new Set(labels.flatMap(label => label.evidence.map(item => item.claim_id)))].flatMap(id => {
    const audit = projection.audit.get(id); return audit === undefined ? [] : [audit];
  });
  for (const item of audit) if (isSensitivity(item.sensitivity) && SENSITIVITY_ORDER[item.sensitivity] > SENSITIVITY_ORDER[chunk.sensitivity]) chunk.sensitivity = item.sensitivity;
  return audit;
}
