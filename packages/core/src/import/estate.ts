import { ESTATE_IMPORT_LIMITS, type EstateImportIssue, type EstateImportReport, type EstateIssueCode } from "../contracts/estate-import";
import { EVENT_SCHEMA, raiseSensitivity, validateEventInput, type CaptureEventInput, type SensitivityHint } from "../contracts/event";
import { sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";

const FIELDS = ["text", "times", "authority", "provenance", "subjects", "aliases", "relationships", "attachments", "domain_state"] as const;
const RECORD_KEYS = ["record_id", "domain", "text", "occurred_at", "observed_at", "valid_from", "valid_to", "asserted_at", "authority", "sensitivity", "subjects", "aliases", "correction_of", "supersedes", "attachments", "provenance", "state", "value"];
const DOMAINS = ["memory", "goals", "projects", "commitments", "habits", "metrics", "insights", "conversation"];
const AUTHORITIES = ["connector_evidence", "owner_authored", "owner_correction", "model_inference"];
const LIMITATIONS = ["dry_run_only_no_records_written", "durable_authorization_and_revocation_not_implemented", "disconnect_is_not_revocation", "claim_identity_and_canon_changes_not_applied", "external_backups_not_covered_by_purge", "slice_omissions_never_infer_deletion"];

/** Fixed error codes only: never include paths, source IDs, text or JSON errors. */
export class EstateImportError extends Error {
  override name = "EstateImportError";
  constructor(readonly code: string) { super(code); }
}
function fail(code: string): never { throw new EstateImportError(code); }
function object(value: unknown, keys: readonly string[], code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key))) fail(code);
  return row;
}
function array(value: unknown, max: number, code: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(code);
  return value;
}
function text(value: unknown, max: number, code: string): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) fail(code);
  return value;
}
function id(value: unknown, code: string): string {
  const result = text(value, 256, code);
  if (result.length === 0 || /[\u0000-\u001f\u007f]/.test(result)) fail(code);
  return result;
}
function integer(value: unknown, code: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(code);
  return value as number;
}
function sensitivity(value: unknown, code: string): SensitivityHint {
  if (value !== "public" && value !== "personal" && value !== "private") fail(code);
  return value;
}
function date(value: unknown, code: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 || !isRfc3339(value)) fail(code);
  return value;
}
function parse(input: string, max: number, label: string): unknown {
  if (typeof input !== "string") fail(`invalid_${label}`);
  if (Buffer.byteLength(input) > max) fail(`${label}_too_large`);
  try { return JSON.parse(input) as unknown; } catch { return fail(`invalid_${label}`); }
}

/** Public report contains only digests, indices and fixed codes. No authorization enforcement is implied. */
export function planEstateImport(sourceJson: string, authorizationJson: string): EstateImportReport {
  return buildEstatePlan(sourceJson, authorizationJson).report;
}

/** Internal mapping seam for synthetic tests; never exported from the core public surface. No writes. */
export function buildEstatePlan(sourceJson: string, authorizationJson: string): { report: EstateImportReport; templates: CaptureEventInput[] } {
  const root = object(parse(sourceJson, ESTATE_IMPORT_LIMITS.sourceBytes, "source"), ["schema", "sources"], "invalid_source");
  if (root.schema !== "kizuki.estate-slice/v1") fail("invalid_source");
  const sources = array(root.sources, ESTATE_IMPORT_LIMITS.sources, "invalid_source");
  if (sources.length === 0) fail("invalid_source");
  const auth = object(parse(authorizationJson, ESTATE_IMPORT_LIMITS.authorizationBytes, "authorization"), ["schema", "source_sha256", "source_ids", "generation", "revoked", "purpose", "retention", "egress", "sensitivity_floor", "allowed_fields"], "invalid_authorization");
  if (auth.schema !== "kizuki.estate-authorization/v1" || auth.purpose !== "estate-import" || typeof auth.revoked !== "boolean") fail("invalid_authorization");
  const digest = sha256Hex(sourceJson);
  if (auth.source_sha256 !== digest) fail("authorization_digest_mismatch");
  const generation = integer(auth.generation, "invalid_authorization");
  const floor = sensitivity(auth.sensitivity_floor, "invalid_authorization");
  const authorizedIds = array(auth.source_ids, ESTATE_IMPORT_LIMITS.sources, "invalid_authorization").map((value) => id(value, "invalid_authorization"));
  if (new Set(authorizedIds).size !== authorizedIds.length) fail("invalid_authorization");
  const allowed = array(auth.allowed_fields, FIELDS.length, "invalid_authorization").map((value) => {
    if (typeof value !== "string" || !(FIELDS as readonly string[]).includes(value)) fail("invalid_authorization");
    return value;
  });
  if (new Set(allowed).size !== allowed.length) fail("invalid_authorization");
  text(auth.retention, 64, "invalid_authorization");
  text(auth.egress, 64, "invalid_authorization");
  const issues: EstateImportIssue[] = [];
  const mappings: EstateImportReport["mappings"] = [];
  const templates: CaptureEventInput[] = [];
  const issue = (code: EstateIssueCode, source: number | null, record: number | null, blocked = true) => {
    issues.push({ code, source, record, disposition: blocked ? "blocked" : "preserved_as_source_metadata" });
  };
  if (auth.revoked) issue("authorization_revoked", null, null);
  if (auth.retention !== "persistent_owned_copy") issue("retention_incompatible", null, null);
  if (auth.egress !== "local_only") issue("egress_unsupported", null, null);
  const sourceIds = new Set<string>();
  let total = 0;
  for (const [sourceIndex, sourceValue] of sources.entries()) {
    const source = object(sourceValue, ["source_id", "consent_generation", "records"], "invalid_source");
    const sourceId = id(source.source_id, "invalid_source");
    if (sourceIds.has(sourceId)) fail("duplicate_source");
    sourceIds.add(sourceId);
    if (!authorizedIds.includes(sourceId)) fail("authorization_source_mismatch");
    if (integer(source.consent_generation, "invalid_source") !== generation) fail("authorization_generation_mismatch");
    const records = array(source.records, ESTATE_IMPORT_LIMITS.records, "invalid_source");
    total += records.length;
    if (total > ESTATE_IMPORT_LIMITS.records) fail("too_many_records");
    const recordIds = new Set<string>();
    // Validate exact record shape before extracting any fields or relationships.
    const rows = records.map((value) => object(value, RECORD_KEYS, "invalid_record"));
    for (const row of rows) {
      const recordId = id(row.record_id, "invalid_record");
      if (recordIds.has(recordId)) fail("duplicate_record");
      recordIds.add(recordId);
    }
    const aliasOwners = new Map<string, Set<string>>();
    for (const row of rows) {
      for (const value of array(row.aliases, 64, "invalid_record")) {
        const alias = object(value, ["subject_id", "display_name"], "invalid_record");
        const subject = id(alias.subject_id, "invalid_record");
        const name = id(alias.display_name, "invalid_record");
        const owners = aliasOwners.get(name) ?? new Set<string>(); owners.add(subject); aliasOwners.set(name, owners);
      }
    }
    for (const [recordIndex, row] of rows.entries()) {
      const before = issues.length;
      const body = text(row.text, 65_536, "invalid_record");
      if (!DOMAINS.includes(row.domain as string) || !AUTHORITIES.includes(row.authority as string)) fail("invalid_record");
      const occurred = date(row.occurred_at, "invalid_record");
      const observed = date(row.observed_at, "invalid_record");
      const validFrom = date(row.valid_from, "invalid_record");
      const validTo = date(row.valid_to, "invalid_record");
      const asserted = date(row.asserted_at, "invalid_record");
      if (validFrom !== null && validTo !== null && Date.parse(validTo) < Date.parse(validFrom)) fail("invalid_record");
      const label = sensitivity(row.sensitivity, "invalid_record");
      const provenance = object(row.provenance, ["sha256", "line_start", "line_end"], "invalid_provenance");
      if (provenance.sha256 !== sha256Hex(body)) fail("provenance_digest_mismatch");
      const lineStart = integer(provenance.line_start, "invalid_provenance");
      const lineEnd = integer(provenance.line_end, "invalid_provenance");
      if (lineEnd < lineStart) fail("invalid_provenance");
      const subjects = array(row.subjects, 64, "invalid_record").map((value) => id(value, "invalid_record"));
      const aliases = array(row.aliases, 64, "invalid_record");
      const supersedes = array(row.supersedes, 64, "invalid_record").map((value) => id(value, "invalid_record"));
      const correction = row.correction_of === null ? null : id(row.correction_of, "invalid_record");
      const attachments = array(row.attachments, 64, "invalid_record").map((value) => {
        const attachment = object(value, ["attachment_id", "media_type"], "invalid_record");
        return { attachment_id: id(attachment.attachment_id, "invalid_record"), media_type: id(attachment.media_type, "invalid_record") };
      });
      if (row.state !== null) id(row.state, "invalid_record");
      if (row.value !== null && (typeof row.value !== "number" || !Number.isFinite(row.value))) fail("invalid_record");
      const fields = ["text", "times", "authority", "provenance", ...(subjects.length ? ["subjects"] : []), ...(aliases.length ? ["aliases"] : []), ...(supersedes.length || correction !== null ? ["relationships"] : []), ...(attachments.length ? ["attachments"] : []), ...(row.state !== null || row.value !== null ? ["domain_state"] : [])];
      if (fields.some((field) => !allowed.includes(field))) issue("field_not_allowed", sourceIndex, recordIndex);
      if (occurred === null || observed === null) issue("unknown_event_time", sourceIndex, recordIndex);
      if (row.domain !== "memory" || row.state !== null || row.value !== null) issue("domain_not_owned", sourceIndex, recordIndex);
      if (row.authority !== "connector_evidence") issue("foreign_authority_not_applied", sourceIndex, recordIndex);
      if (validFrom !== null || validTo !== null || asserted !== null) issue("historical_claim_times_metadata_only", sourceIndex, recordIndex, false);
      if (aliases.length) {
        const ambiguous = aliases.some((value) => (aliasOwners.get((value as Record<string, string>).display_name!)?.size ?? 0) > 1);
        issue(ambiguous ? "alias_ambiguous" : "aliases_not_applied", sourceIndex, recordIndex);
      }
      if (correction !== null || supersedes.length) {
        const refs = [...supersedes, ...(correction === null ? [] : [correction])];
        issue(refs.some((ref) => !recordIds.has(ref) || ref === row.record_id) ? "relationship_unresolved" : "relationships_not_applied", sourceIndex, recordIndex);
      }
      if (attachments.length) issue("attachment_bytes_not_transferred", sourceIndex, recordIndex);
      const targetId = `estate:${sha256Hex(JSON.stringify([sourceId, row.record_id]))}`;
      const blocked = issues.slice(before).some((entry) => entry.disposition === "blocked");
      mappings.push({ source: sourceIndex, record: recordIndex, target_source_record_id: targetId, disposition: blocked ? "blocked" : "event_template" });
      if (!blocked && occurred !== null && observed !== null) {
        const candidate = { schema: EVENT_SCHEMA, connector_id: "estate-slice", source_record_id: targetId,
          kind: "estate_evidence", occurred_at: occurred, observed_at: observed, text: body,
          subjects: subjects.map((subject) => ({ subject_id: `estate:${sha256Hex(JSON.stringify([sourceId, subject]))}`, role: "about" as const })),
          sensitivity_hint: raiseSensitivity(label, floor), deleted: false, attachments: [],
          metadata: { estate: { source_id: sourceId, record_id: row.record_id, provenance,
            authority: row.authority, valid_from: validFrom, valid_to: validTo, asserted_at: asserted,
            subject_ids: subjects, domain: row.domain } } };
        const validated = validateEventInput(candidate);
        if (!validated.ok) fail("invalid_event_mapping");
        templates.push(validated.value);
      }
    }
  }
  if (authorizedIds.length !== sourceIds.size) fail("authorization_source_mismatch");
  const blocked = issues.some((entry) => entry.disposition === "blocked");
  if (blocked) { templates.length = 0; for (const mapping of mappings) mapping.disposition = "blocked"; }
  const base = { schema: "kizuki.estate-plan/v1" as const, source_sha256: digest,
    authorization_sha256: sha256Hex(authorizationJson), status: blocked ? "blocked" as const : "compatible" as const,
    records: total, mappings, issues, limitations: [...LIMITATIONS] };
  return { report: { ...base, plan_sha256: sha256Hex(JSON.stringify(base)) }, templates };
}
