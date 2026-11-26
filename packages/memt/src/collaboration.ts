import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  MEMT_SENSITIVITY_ORDER,
  allowedSensitivitiesForCeiling,
  canonicalSourceRef,
  defaultMemtRegistryPath,
  isMemtSensitivity,
  normalizeSourceRefVariants,
  openMemtRegistryDb,
  sha256Hex,
  withinSensitivityCeiling,
} from "./db";
import type { MemtSensitivity } from "./db";

export const COLLABORATION_SLICE_SCHEMA = "kizuki.collaboration-slice/v1" as const;
export const COLLABORATION_HOST_CONTRACT_VERSION = "kizuki.collaboration-host/v1" as const;

export const COLLABORATION_AREAS = [
  "communication",
  "work_standards",
  "collaboration_protocol",
  "knowledge",
  "decision_values",
  "developing_taste",
] as const;
export type CollaborationArea = (typeof COLLABORATION_AREAS)[number];

export const COLLABORATION_RECORD_KINDS = [
  "rule",
  "example_positive",
  "example_negative",
  "criterion",
] as const;
export type CollaborationRecordKind = (typeof COLLABORATION_RECORD_KINDS)[number];

export const COLLABORATION_AUTHORITY_LEVELS = [
  "inferred_taste",
  "observed_preference",
  "owner_instruction",
] as const;
export type CollaborationAuthorityLevel = (typeof COLLABORATION_AUTHORITY_LEVELS)[number];

export const COLLABORATION_EPISTEMIC_STATUSES = [
  "hypothesis",
  "corroborated",
  "owner_instruction",
  "contested",
  "retracted",
] as const;
export type CollaborationEpistemicStatus = (typeof COLLABORATION_EPISTEMIC_STATUSES)[number];

export const COLLABORATION_HANDOFF_KINDS = [
  "agent_claim",
  "owner_edit",
  "owner_correction",
  "observed_outcome",
] as const;
export type CollaborationHandoffKind = (typeof COLLABORATION_HANDOFF_KINDS)[number];

export type CollaborationOutcomeStatus =
  | "unverified_agent_claim"
  | "observed_pass"
  | "observed_fail"
  | "owner_corrected";

export type CollaborationConnectionStage =
  | "connecting"
  | "partial_backfill"
  | "complete";

export type RubricRequirementLevel =
  | "hard_owner_instruction"
  | "soft_guidance"
  | "hypothesis_check";

export interface CollaborationException {
  readonly condition: string;
  readonly note: string;
}

export interface CollaborationRecord {
  readonly id: string;
  readonly person_id: string;
  readonly partition_key: string;
  readonly area: CollaborationArea;
  readonly kind: CollaborationRecordKind;
  readonly condition: string;
  readonly guidance: string;
  readonly reason: string;
  readonly verification: string;
  readonly scope: readonly string[];
  readonly exceptions: readonly CollaborationException[];
  readonly evidence_refs: readonly string[];
  readonly source_roots: readonly string[];
  readonly sensitivity: MemtSensitivity;
  readonly taint: "clean" | "quoted";
  readonly authority_level: CollaborationAuthorityLevel;
  readonly epistemic_status: CollaborationEpistemicStatus;
  readonly confidence: number;
  readonly uncertainty: number;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly conflict_group: string | null;
  readonly superseded_by: string | null;
  readonly grants_authority: false;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecordCollaborationFacetInput {
  readonly id?: string;
  readonly person_id: string;
  readonly partition_key?: string;
  readonly area: CollaborationArea;
  readonly kind?: CollaborationRecordKind;
  readonly condition: string;
  readonly guidance: string;
  readonly reason?: string;
  readonly verification?: string;
  readonly scope: readonly string[];
  readonly exceptions?: readonly CollaborationException[];
  readonly evidence_refs: readonly string[];
  readonly source_roots?: readonly string[];
  readonly sensitivity: MemtSensitivity;
  readonly dedupSensitivityCeiling?: MemtSensitivity;
  readonly taint?: "clean" | "quoted";
  readonly authority_level?: CollaborationAuthorityLevel;
  readonly confidence?: number;
  readonly valid_from?: string | null;
  readonly valid_until?: string | null;
  readonly conflict_group?: string | null;
  readonly now?: string;
}

export interface RecordCollaborationFacetResult {
  readonly record: CollaborationRecord;
  readonly deduplicated: boolean;
  readonly mergedIntoId?: string;
}

export interface ConnectionProgressState {
  readonly person_id: string;
  readonly partition_key: string;
  readonly stage: CollaborationConnectionStage;
  readonly historical_complete: boolean;
  readonly resume_cursor: string;
  readonly high_info_indexed: number;
  readonly updated_at: string;
}

export interface UpdateConnectionProgressInput {
  readonly person_id: string;
  readonly partition_key?: string;
  readonly stage: CollaborationConnectionStage;
  readonly historical_complete: boolean;
  readonly resume_cursor?: string;
  readonly sensitivityCeiling?: MemtSensitivity;
  readonly now?: string;
}

export interface CollaborationHandoffRecord {
  readonly id: string;
  readonly idempotency_key: string;
  readonly person_id: string;
  readonly partition_key: string;
  readonly agent_id: string;
  readonly served_slice_hash: string;
  readonly task: string;
  readonly area: CollaborationArea;
  readonly kind: CollaborationHandoffKind;
  readonly outcome_status: CollaborationOutcomeStatus;
  readonly endorsed_by_owner: boolean;
  readonly work_summary: string;
  readonly artifact_ref: string;
  readonly correction_text: string;
  readonly supersedes_record_id: string | null;
  readonly created_record_id: string | null;
  readonly evidence_refs: readonly string[];
  readonly sensitivity: MemtSensitivity;
  readonly reverted_at: string | null;
  readonly created_at: string;
}

export interface RecordCrossAgentHandoffInput {
  readonly idempotency_key: string;
  readonly person_id: string;
  readonly partition_key?: string;
  readonly agent_id: string;
  readonly served_slice_hash: string;
  readonly task: string;
  readonly area: CollaborationArea;
  readonly kind: CollaborationHandoffKind;
  readonly work_summary: string;
  readonly artifact_ref?: string;
  readonly correction_text?: string;
  readonly condition?: string;
  readonly scope?: readonly string[];
  readonly exceptions?: readonly CollaborationException[];
  readonly supersedes_record_id?: string;
  readonly evidence_refs: readonly string[];
  readonly sensitivity: MemtSensitivity;
  readonly sensitivityCeiling?: MemtSensitivity;
  readonly callerAgentId?: string | null;
  readonly allowedSubjects?: readonly string[] | null;
  readonly observed_passed?: boolean;
  readonly now?: string;
}

export interface RecordCrossAgentHandoffResult {
  readonly handoff: CollaborationHandoffRecord;
  readonly idempotentReplay: boolean;
  readonly createdRecord: CollaborationRecord | null;
}

export interface UndoHandoffResult {
  readonly undone: boolean;
  readonly handoff_id: string;
  readonly retracted_record_id: string | null;
  readonly restored_record_id: string | null;
}

export interface CollaborationAreaCoverage {
  readonly area: CollaborationArea;
  readonly status: "known" | "unknown";
  readonly reason?: "no_permitted_evidence" | "ingestion_in_progress";
  readonly record_count: number;
  readonly highest_authority: CollaborationAuthorityLevel | null;
}

export interface CompiledBriefRule {
  readonly id: string;
  readonly area: CollaborationArea;
  readonly condition: string;
  readonly guidance: string;
  readonly scope: readonly string[];
  readonly exceptions: readonly CollaborationException[];
  readonly evidence_refs: readonly string[];
  readonly epistemic_status: CollaborationEpistemicStatus;
  readonly authority_level: CollaborationAuthorityLevel;
  readonly confidence: number;
  readonly uncertainty: number;
  readonly taint: "clean" | "quoted";
  readonly grants_authority: false;
}

export interface TriggeredExceptionItem {
  readonly rule_id: string;
  readonly area: CollaborationArea;
  readonly base_guidance: string;
  readonly matched_condition: string;
  readonly exception_note: string;
  readonly evidence_refs: readonly string[];
  readonly uncertainty: number;
}

export interface CollaborationConflictItem {
  readonly conflict_group: string;
  readonly area: CollaborationArea;
  readonly record_ids: readonly string[];
  readonly statements: readonly string[];
  readonly evidence_refs: readonly string[];
}

export interface GroundedExampleItem {
  readonly id: string;
  readonly polarity: "positive" | "negative";
  readonly area: CollaborationArea;
  readonly condition: string;
  readonly example: string;
  readonly reason: string;
  readonly scope: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly epistemic_status: CollaborationEpistemicStatus;
  readonly authority_level: CollaborationAuthorityLevel;
  readonly uncertainty: number;
  readonly taint: "clean" | "quoted";
  readonly grants_authority: false;
}

export interface RubricCriterionItem {
  readonly id: string;
  readonly area: CollaborationArea;
  readonly criterion: string;
  readonly verification: string;
  readonly requirement_level: RubricRequirementLevel;
  readonly authority_level: CollaborationAuthorityLevel;
  readonly epistemic_status: CollaborationEpistemicStatus;
  readonly evidence_refs: readonly string[];
  readonly uncertainty: number;
  readonly grants_authority: false;
}

export interface CollaborationHostContract {
  readonly contract_version: typeof COLLABORATION_HOST_CONTRACT_VERSION;
  readonly mode: "pull_only";
  readonly grants_action_authority: false;
  readonly per_user_finetuning_required: false;
  readonly hosted_agent_loop: false;
  readonly supported_operations: readonly string[];
  readonly unsupported_operations: readonly string[];
}

export interface CompileCollaborationSliceInput {
  readonly person_id: string;
  readonly task: string;
  readonly task_kind?: string;
  readonly partition_key?: string;
  readonly sensitivityCeiling: MemtSensitivity;
  readonly allowedSubjects?: readonly string[] | null;
  readonly areas?: readonly CollaborationArea[];
  readonly budgetTokens?: number;
  readonly asOf?: string;
  readonly priorSliceHash?: string;
  readonly hostId?: string;
  readonly maxRules?: number;
  readonly maxExamplesPerPolarity?: number;
  readonly maxRubricItems?: number;
  readonly ingestionProgress?: {
    readonly stage: CollaborationConnectionStage;
    readonly historical_complete: boolean;
    readonly resume_cursor?: string;
  };
  readonly isEvidenceAuthorized?: (evidenceRefs: readonly string[]) => boolean;
}

export interface CollaborationSlice {
  readonly schema: typeof COLLABORATION_SLICE_SCHEMA;
  readonly person_id: string;
  readonly partition_key: string;
  readonly task: string;
  readonly task_kind: string | null;
  readonly refresh_status: "current" | "refreshed" | "unchanged";
  readonly slice_hash: string;
  readonly sensitivity_ceiling: MemtSensitivity;
  readonly grants_action_authority: false;
  readonly budget_tokens: number;
  readonly estimated_tokens: number;
  readonly truncated: boolean;
  readonly progress: {
    readonly stage: CollaborationConnectionStage;
    readonly historical_complete: boolean;
    readonly resume_cursor: string;
    readonly high_info_indexed: number;
  };
  readonly areas: Readonly<Record<CollaborationArea, CollaborationAreaCoverage>>;
  readonly brief: {
    readonly summary: string;
    readonly active_rules: readonly CompiledBriefRule[];
    readonly triggered_exceptions: readonly TriggeredExceptionItem[];
    readonly conflicts: readonly CollaborationConflictItem[];
    readonly insufficient_areas: readonly {
      readonly area: CollaborationArea;
      readonly reason: "no_permitted_evidence" | "ingestion_in_progress";
    }[];
  };
  readonly examples: {
    readonly positive: readonly GroundedExampleItem[];
    readonly negative: readonly GroundedExampleItem[];
  };
  readonly rubric: readonly RubricCriterionItem[];
  readonly recent_handoffs: readonly {
    readonly id: string;
    readonly agent_id: string;
    readonly kind: CollaborationHandoffKind;
    readonly outcome_status: CollaborationOutcomeStatus;
    readonly endorsed_by_owner: boolean;
    readonly area: CollaborationArea;
    readonly correction_text: string;
    readonly evidence_refs: readonly string[];
  }[];
  readonly host_contract: CollaborationHostContract;
}

export interface PurgeCollaborationResult {
  readonly purgedRecordIds: readonly string[];
  readonly purgedHandoffIds: readonly string[];
  readonly purgedCount: number;
}

export interface CollaborationStoreOptions {
  readonly db?: Database;
  readonly dbPath?: string;
  readonly vaultPath?: string;
}

const HOST_CONTRACT: CollaborationHostContract = Object.freeze({
  contract_version: COLLABORATION_HOST_CONTRACT_VERSION,
  mode: "pull_only",
  grants_action_authority: false,
  per_user_finetuning_required: false,
  hosted_agent_loop: false,
  supported_operations: Object.freeze([
    "compile_slice",
    "refresh_slice",
    "record_facet",
    "record_handoff",
    "correct_facet",
    "undo_handoff",
  ]),
  unsupported_operations: Object.freeze([
    "autonomous_external_action",
    "push_webhook",
    "background_finetune",
  ]),
});

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "by", "do", "for", "from",
  "how", "i", "if", "in", "into", "is", "it", "its", "me", "my", "of", "on",
  "or", "our", "should", "so", "that", "the", "their", "them", "these", "they",
  "this", "to", "us", "was", "we", "what", "when", "where", "which", "who",
  "why", "will", "with", "would", "you", "your",
]);

const AREA_SYNONYMS: Readonly<Record<CollaborationArea, readonly string[]>> = {
  communication: ["communication", "tone", "brief", "concise", "summary", "status", "update", "email", "memo", "slack", "writing", "bullet", "format", "report"],
  work_standards: ["standard", "quality", "test", "review", "code", "technical", "architecture", "benchmark", "proof", "verify", "rigor", "coverage", "security", "audit", "pr"],
  collaboration_protocol: ["protocol", "autonomy", "escalate", "checkpoint", "handoff", "ask", "plan", "workflow", "delegate", "approval", "blocker", "sync", "cadence"],
  knowledge: ["knowledge", "domain", "architecture", "system", "terminology", "model", "stack", "concept", "background", "sql", "sqlite", "mcp", "database", "api"],
  decision_values: ["decision", "tradeoff", "priority", "risk", "speed", "correctness", "privacy", "security", "cost", "budget", "principle", "value", "rollback"],
  developing_taste: ["taste", "design", "poster", "layout", "visual", "typography", "aesthetic", "style", "ui", "editorial", "minimal", "craft", "motion", "palette"],
};

const UNIVERSAL_SCOPES = new Set(["*", "all", "any", "general", "default"]);

export function isCollaborationArea(value: unknown): value is CollaborationArea {
  return typeof value === "string" && (COLLABORATION_AREAS as readonly string[]).includes(value);
}

export function isCollaborationRecordKind(value: unknown): value is CollaborationRecordKind {
  return typeof value === "string" && (COLLABORATION_RECORD_KINDS as readonly string[]).includes(value);
}

export function isCollaborationAuthorityLevel(value: unknown): value is CollaborationAuthorityLevel {
  return typeof value === "string" && (COLLABORATION_AUTHORITY_LEVELS as readonly string[]).includes(value);
}

export function isCollaborationHandoffKind(value: unknown): value is CollaborationHandoffKind {
  return typeof value === "string" && (COLLABORATION_HANDOFF_KINDS as readonly string[]).includes(value);
}

function generateId(prefix: string): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = randomBytes(6).toString("hex");
  return `${prefix}_${ts}_${rand}`;
}

function clampUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function stemToken(token: string): string {
  if (token.length < 5 || !/^[a-z]+$/.test(token)) return token;
  if (token.endsWith("ations") && token.length >= 8) return token.slice(0, -5);
  if (token.endsWith("ation") && token.length >= 7) return token.slice(0, -4);
  if (token.endsWith("ing") && token.length >= 6) return token.slice(0, -3);
  if (token.endsWith("ies") && token.length >= 5) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ed") && token.length >= 5) return token.slice(0, -2);
  if (token.endsWith("s") && !token.endsWith("ss") && token.length >= 5) return token.slice(0, -1);
  return token;
}

function extractTokens(text: string): Set<string> {
  const out = new Set<string>();
  const norm = normalizeText(text);
  if (norm.length === 0) return out;
  for (const part of norm.split(" ")) {
    for (const sub of part.split("_")) {
      if (sub.length < 2 || STOPWORDS.has(sub)) continue;
      out.add(sub);
      const stemmed = stemToken(sub);
      if (stemmed.length >= 3) out.add(stemmed);
    }
    if (part.includes("_") && part.length >= 3) {
      out.add(part);
    }
  }
  return out;
}

function deriveSourceRoot(ref: string): string {
  const canon = canonicalSourceRef(ref);
  if (canon.length === 0) return "";
  // Strip copy/replay suffixes like `#copy2`, `:dup:3`, or `@v2` so repeated copies
  // of the same source never masquerade as independent corroboration.
  const withoutFrag = canon.split("#")[0]!.split("@")[0]!;
  const copyStripped = withoutFrag.replace(/(?::(?:copy|dup|replay|mirror|chunk)[-_a-z0-9]*)+$/i, "");
  return copyStripped.trim().toLowerCase();
}

function mergeUniqueStrings(existing: readonly string[], incoming: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...existing, ...incoming]) {
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function normalizeExceptions(raw: readonly CollaborationException[] | undefined): CollaborationException[] {
  if (!Array.isArray(raw)) return [];
  const out: CollaborationException[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const cond = typeof item.condition === "string" ? item.condition.trim() : "";
    const note = typeof item.note === "string" ? item.note.trim() : "";
    if (cond.length === 0) continue;
    const key = `${normalizeTag(cond)}\0${normalizeText(note)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(Object.freeze({ condition: cond, note: note.length > 0 ? note : cond }));
  }
  return out;
}

function computeEpistemicStatus(
  authority: CollaborationAuthorityLevel,
  sourceRoots: readonly string[],
  hasConflict: boolean,
): CollaborationEpistemicStatus {
  if (hasConflict) return "contested";
  if (authority === "owner_instruction") return "owner_instruction";
  if (sourceRoots.length >= 2) return "corroborated";
  return "hypothesis";
}

/**
 * B5 hard invariant: inferred taste or weak hypothesis can NEVER become a hard owner instruction.
 */
export function rubricRequirementLevelFor(
  authority: CollaborationAuthorityLevel,
  epistemic: CollaborationEpistemicStatus,
): RubricRequirementLevel {
  if (authority === "owner_instruction" && epistemic === "owner_instruction") {
    return "hard_owner_instruction";
  }
  if (epistemic === "hypothesis" || epistemic === "contested") {
    return "hypothesis_check";
  }
  return "soft_guidance";
}

function isValidRfc3339(value: string): boolean {
  if (value.length < 20 || value.length > 40) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isTemporallyApplicable(
  validFrom: string | null,
  validUntil: string | null,
  asOfMs: number,
): boolean {
  if (validFrom !== null) {
    const fromMs = Date.parse(validFrom);
    if (Number.isFinite(fromMs) && asOfMs < fromMs) return false;
  }
  if (validUntil !== null) {
    const untilMs = Date.parse(validUntil);
    if (Number.isFinite(untilMs) && asOfMs >= untilMs) return false;
  }
  return true;
}

function estimateTokens(value: unknown): number {
  const bytes = Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return Math.max(1, Math.ceil(bytes / 4));
}

function parseStringArrayJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    }
  } catch {
    // ignore malformed
  }
  return [];
}

function parseExceptionsJson(raw: string): CollaborationException[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeExceptions(parsed as CollaborationException[]);
    }
  } catch {
    // ignore malformed
  }
  return [];
}

interface RecordRow {
  id: string;
  person_id: string;
  partition_key: string;
  area: string;
  kind: string;
  condition: string;
  guidance: string;
  reason: string;
  verification: string;
  scope_json: string;
  exceptions_json: string;
  evidence_refs_json: string;
  source_roots_json: string;
  sensitivity: string;
  taint: string;
  authority_level: string;
  epistemic_status: string;
  confidence: number;
  uncertainty: number;
  valid_from: string | null;
  valid_until: string | null;
  conflict_group: string | null;
  superseded_by: string | null;
  dedup_key: string;
  created_at: string;
  updated_at: string;
}

interface HandoffRow {
  id: string;
  idempotency_key: string;
  person_id: string;
  partition_key: string;
  agent_id: string;
  served_slice_hash: string;
  task: string;
  area: string;
  kind: string;
  outcome_status: string;
  work_summary: string;
  artifact_ref: string;
  correction_text: string;
  supersedes_record_id: string | null;
  created_record_id: string | null;
  evidence_refs_json: string;
  sensitivity: string;
  reverted_at: string | null;
  created_at: string;
}

/**
 * B4 validation gate: validate a persisted record before serving.
 * Records with missing provenance, invalid area/kind/sensitivity, or retracted state are excluded fail-closed.
 */
export function validateCollaborationRecord(record: CollaborationRecord): boolean {
  if (record.id.trim().length === 0) return false;
  if (record.person_id.trim().length === 0) return false;
  if (record.partition_key.trim().length === 0) return false;
  if (!isCollaborationArea(record.area)) return false;
  if (!isCollaborationRecordKind(record.kind)) return false;
  if (record.condition.trim().length === 0 || record.guidance.trim().length === 0) return false;
  if (record.scope.length === 0) return false;
  if (record.evidence_refs.length === 0) return false;
  if (!isMemtSensitivity(record.sensitivity)) return false;
  if (record.taint !== "clean" && record.taint !== "quoted") return false;
  if (!isCollaborationAuthorityLevel(record.authority_level)) return false;
  if (!Number.isFinite(record.confidence) || record.confidence < 0 || record.confidence > 1) return false;
  if (!Number.isFinite(record.uncertainty) || record.uncertainty < 0 || record.uncertainty > 1) return false;
  if (record.grants_authority !== false) return false;
  if (record.valid_from !== null && !isValidRfc3339(record.valid_from)) return false;
  if (record.valid_until !== null && !isValidRfc3339(record.valid_until)) return false;
  return true;
}

function rowToRecord(row: RecordRow): CollaborationRecord | null {
  if (!isCollaborationArea(row.area)) return null;
  if (!isCollaborationRecordKind(row.kind)) return null;
  if (!isMemtSensitivity(row.sensitivity)) return null;
  if (!isCollaborationAuthorityLevel(row.authority_level)) return null;
  const evidenceRefs = parseStringArrayJson(row.evidence_refs_json);
  const scope = parseStringArrayJson(row.scope_json);
  const sourceRoots = parseStringArrayJson(row.source_roots_json);
  const exceptions = parseExceptionsJson(row.exceptions_json);
  const rec: CollaborationRecord = Object.freeze({
    id: row.id,
    person_id: row.person_id,
    partition_key: row.partition_key,
    area: row.area,
    kind: row.kind,
    condition: row.condition,
    guidance: row.guidance,
    reason: row.reason,
    verification: row.verification,
    scope: Object.freeze(scope),
    exceptions: Object.freeze(exceptions),
    evidence_refs: Object.freeze(evidenceRefs),
    source_roots: Object.freeze(sourceRoots.length > 0 ? sourceRoots : mergeUniqueStrings([], evidenceRefs.map(deriveSourceRoot))),
    sensitivity: row.sensitivity,
    taint: row.taint === "clean" ? "clean" : "quoted",
    authority_level: row.authority_level,
    epistemic_status: row.epistemic_status as CollaborationEpistemicStatus,
    confidence: row.confidence,
    uncertainty: row.uncertainty,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    conflict_group: row.conflict_group,
    superseded_by: row.superseded_by,
    grants_authority: false,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
  return validateCollaborationRecord(rec) ? rec : null;
}

function rowToHandoff(row: HandoffRow): CollaborationHandoffRecord | null {
  if (!isCollaborationArea(row.area)) return null;
  if (!isCollaborationHandoffKind(row.kind)) return null;
  if (!isMemtSensitivity(row.sensitivity)) return null;
  const evidenceRefs = parseStringArrayJson(row.evidence_refs_json);
  if (evidenceRefs.length === 0) return null;
  const outcomeStatus = row.outcome_status as CollaborationOutcomeStatus;
  return Object.freeze({
    id: row.id,
    idempotency_key: row.idempotency_key,
    person_id: row.person_id,
    partition_key: row.partition_key,
    agent_id: row.agent_id,
    served_slice_hash: row.served_slice_hash,
    task: row.task,
    area: row.area,
    kind: row.kind,
    outcome_status: outcomeStatus,
    endorsed_by_owner: row.kind === "owner_correction" || row.kind === "owner_edit",
    work_summary: row.work_summary,
    artifact_ref: row.artifact_ref,
    correction_text: row.correction_text,
    supersedes_record_id: row.supersedes_record_id,
    created_record_id: row.created_record_id,
    evidence_refs: Object.freeze(evidenceRefs),
    sensitivity: row.sensitivity,
    reverted_at: row.reverted_at,
    created_at: row.created_at,
  });
}

function matchException(
  exceptions: readonly CollaborationException[],
  taskNormalized: string,
  taskKindNormalized: string,
  taskTokens: Set<string>,
): CollaborationException | null {
  for (const ex of exceptions) {
    const condNorm = normalizeText(ex.condition);
    const condTag = normalizeTag(ex.condition);
    if (condTag.length > 0 && taskKindNormalized === condTag) {
      return ex;
    }
    if (condNorm.length >= 4 && taskNormalized.includes(condNorm)) {
      return ex;
    }
    const exTokens = extractTokens(ex.condition);
    if (exTokens.size === 0) continue;
    let hits = 0;
    for (const tok of exTokens) {
      if (taskTokens.has(tok)) hits += 1;
    }
    if (hits === exTokens.size || (exTokens.size >= 2 && hits / exTokens.size >= 0.75)) {
      return ex;
    }
  }
  return null;
}

function computeRecordTaskRelevance(
  record: CollaborationRecord,
  taskNormalized: string,
  taskKindNormalized: string,
  taskTokens: Set<string>,
  requestedAreas: ReadonlySet<CollaborationArea> | null,
): { relevant: boolean; score: number; scopeMatched: boolean; directLexicalOverlap: number } {
  if (requestedAreas !== null && !requestedAreas.has(record.area)) {
    return { relevant: false, score: 0, scopeMatched: false, directLexicalOverlap: 0 };
  }

  let scopeExact = false;
  let scopePartial = false;
  let universalScope = false;

  for (const rawScope of record.scope) {
    const tag = normalizeTag(rawScope);
    if (UNIVERSAL_SCOPES.has(tag)) {
      universalScope = true;
      continue;
    }
    if (taskKindNormalized.length > 0 && tag === taskKindNormalized) {
      scopeExact = true;
      continue;
    }
    const scopeNorm = normalizeText(rawScope);
    if (scopeNorm.length >= 3 && taskNormalized.includes(scopeNorm)) {
      scopeExact = true;
      continue;
    }
    const scopeTokens = extractTokens(rawScope);
    if (scopeTokens.size > 0) {
      let matched = 0;
      for (const tok of scopeTokens) {
        if (taskTokens.has(tok)) matched += 1;
      }
      if (matched === scopeTokens.size) {
        scopeExact = true;
      } else if (matched > 0) {
        scopePartial = true;
      }
    }
  }

  const recordTextTokens = extractTokens(
    `${record.condition} ${record.guidance} ${record.reason} ${record.verification} ${record.scope.join(" ")}`,
  );
  let directHits = 0;
  for (const tok of taskTokens) {
    if (recordTextTokens.has(tok)) directHits += 1;
  }
  const directLexicalOverlap = taskTokens.size > 0 ? directHits / taskTokens.size : 0;

  let areaHintHits = 0;
  const areaHints = AREA_SYNONYMS[record.area];
  for (const hint of areaHints) {
    if (taskTokens.has(hint) || taskTokens.has(stemToken(hint))) {
      areaHintHits += 1;
    }
  }

  // B2 strict task discrimination: a domain-scoped record (not universal) whose scope
  // does not match the task and has insufficient lexical overlap must not pollute another task.
  const scopeMatched = scopeExact || scopePartial;
  const relevant =
    scopeExact ||
    (scopePartial && directHits >= 1) ||
    (universalScope && (directHits >= 1 || areaHintHits >= 1 || taskTokens.size === 0 || requestedAreas !== null)) ||
    (!universalScope && directHits >= 2 && directLexicalOverlap >= 0.3);

  if (!relevant) {
    return { relevant: false, score: 0, scopeMatched: false, directLexicalOverlap };
  }

  let score = 0;
  if (scopeExact) score += 3.2;
  else if (scopePartial) score += 1.6;
  else if (universalScope) score += 0.9;

  score += directHits * 0.85 + directLexicalOverlap * 2.0 + Math.min(2, areaHintHits) * 0.35;

  // High-information prioritization (B3) + epistemic rigor
  const authorityBoost =
    record.authority_level === "owner_instruction"
      ? 1.35
      : record.authority_level === "observed_preference"
        ? 1.05
        : 0.9;
  const epistemicBoost =
    record.epistemic_status === "owner_instruction"
      ? 1.25
      : record.epistemic_status === "corroborated"
        ? 1.15
        : record.epistemic_status === "hypothesis"
          ? 0.85
          : 0.9;

  score *= authorityBoost * epistemicBoost * (0.65 + 0.35 * record.confidence);

  return { relevant: true, score, scopeMatched: scopeMatched || universalScope, directLexicalOverlap };
}

function computeHandoffTaskRelevance(
  handoff: CollaborationHandoffRecord,
  taskNormalized: string,
  taskKindNormalized: string,
  taskTokens: Set<string>,
  requestedAreas: ReadonlySet<CollaborationArea> | null,
): { relevant: boolean; score: number } {
  if (requestedAreas !== null && !requestedAreas.has(handoff.area)) {
    return { relevant: false, score: 0 };
  }

  const handoffTaskNorm = normalizeText(handoff.task);
  const handoffTaskTag = normalizeTag(handoff.task);
  const exactTask =
    (taskKindNormalized.length > 0 && handoffTaskTag === taskKindNormalized) ||
    (handoffTaskNorm.length > 0 && handoffTaskNorm === taskNormalized) ||
    (handoffTaskNorm.length >= 4 && taskNormalized.includes(handoffTaskNorm)) ||
    (taskNormalized.length >= 4 && handoffTaskNorm.includes(taskNormalized));

  const handoffTokens = extractTokens(
    `${handoff.task} ${handoff.work_summary} ${handoff.correction_text}`,
  );
  let directHits = 0;
  for (const tok of taskTokens) {
    if (handoffTokens.has(tok)) directHits += 1;
  }
  const overlap = taskTokens.size > 0 ? directHits / taskTokens.size : 0;

  const relevant =
    exactTask ||
    (taskTokens.size === 0) ||
    (taskTokens.size === 1 && directHits >= 1) ||
    (taskTokens.size >= 2 && (directHits >= 2 || (directHits >= 1 && overlap >= 0.4)));

  if (!relevant) {
    return { relevant: false, score: 0 };
  }

  let score = exactTask ? 3.0 : 0;
  score += directHits * 0.8 + overlap * 2.0;
  if (handoff.endorsed_by_owner) score += 0.5;
  return { relevant: true, score };
}

export class CollaborationSliceStore {
  private readonly db: Database;
  private readonly ownsDb: boolean;

  constructor(options: CollaborationStoreOptions) {
    if (options.db !== undefined) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const dbPath =
        options.dbPath ??
        (options.vaultPath !== undefined
          ? defaultMemtRegistryPath(options.vaultPath)
          : ":memory:");
      this.db = openMemtRegistryDb(dbPath);
      this.ownsDb = true;
    }
  }

  recordFacet(input: RecordCollaborationFacetInput): RecordCollaborationFacetResult {
    const personId = input.person_id.trim();
    const partitionKey = (input.partition_key ?? "default").trim();
    const condition = input.condition.trim();
    const guidance = input.guidance.trim();
    const reason = (input.reason ?? "").trim();
    const verification = (input.verification ?? "").trim();
    const kind: CollaborationRecordKind = input.kind ?? "rule";
    const authorityLevel: CollaborationAuthorityLevel = input.authority_level ?? "observed_preference";
    const taint: "clean" | "quoted" = input.taint ?? "quoted";

    if (personId.length === 0) throw new Error("person_id must be non-empty");
    if (partitionKey.length === 0) throw new Error("partition_key must be non-empty");
    if (!isCollaborationArea(input.area)) throw new Error(`invalid collaboration area: ${String(input.area)}`);
    if (!isCollaborationRecordKind(kind)) throw new Error(`invalid collaboration kind: ${String(kind)}`);
    if (!isMemtSensitivity(input.sensitivity)) throw new Error(`invalid sensitivity: ${String(input.sensitivity)}`);
    if (!isCollaborationAuthorityLevel(authorityLevel)) {
      throw new Error(`invalid authority_level: ${String(authorityLevel)}`);
    }
    if (condition.length === 0) throw new Error("condition must be non-empty");
    if (guidance.length === 0) throw new Error("guidance must be non-empty");

    const scope = mergeUniqueStrings([], input.scope.map((s) => s.trim()));
    if (scope.length === 0) throw new Error("scope must contain at least one task or domain tag");

    const evidenceRefs = mergeUniqueStrings([], input.evidence_refs);
    if (evidenceRefs.length === 0) {
      throw new Error("evidence_refs must contain at least one provenance reference");
    }

    const derivedRoots = mergeUniqueStrings(
      [],
      evidenceRefs.map(deriveSourceRoot).filter((r) => r.length > 0),
    );
    const explicitRoots = mergeUniqueStrings(
      [],
      (input.source_roots ?? []).map(deriveSourceRoot).filter((r) => r.length > 0),
    );
    if (explicitRoots.length > derivedRoots.length) {
      throw new Error("source_roots cannot exceed distinct evidence roots");
    }
    const sourceRoots = explicitRoots.length > 0 ? explicitRoots : derivedRoots;
    const exceptions = normalizeExceptions(input.exceptions);

    const validFrom = input.valid_from === undefined || input.valid_from === null || input.valid_from.trim() === ""
      ? null
      : input.valid_from.trim();
    const validUntil = input.valid_until === undefined || input.valid_until === null || input.valid_until.trim() === ""
      ? null
      : input.valid_until.trim();
    if (validFrom !== null && !isValidRfc3339(validFrom)) {
      throw new Error("valid_from must be an RFC3339 timestamp");
    }
    if (validUntil !== null && !isValidRfc3339(validUntil)) {
      throw new Error("valid_until must be an RFC3339 timestamp");
    }

    const conflictGroup =
      input.conflict_group !== undefined && input.conflict_group !== null && input.conflict_group.trim().length > 0
        ? input.conflict_group.trim()
        : null;
    const now = input.now ?? new Date().toISOString();
    const confidence = clampUnit(
      input.confidence ?? (authorityLevel === "owner_instruction" ? 0.95 : sourceRoots.length >= 2 ? 0.8 : 0.55),
      0.6,
    );
    const uncertainty = Number((1 - confidence).toFixed(4));

    const dedupKey = sha256Hex(
      [
        personId.toLowerCase(),
        partitionKey.toLowerCase(),
        input.area,
        kind,
        normalizeText(condition),
        normalizeText(guidance),
      ].join("\0"),
    );

    const dedupCeilingRank =
      input.dedupSensitivityCeiling !== undefined
        ? MEMT_SENSITIVITY_ORDER[input.dedupSensitivityCeiling]
        : null;

    const existing = this.db
      .query<RecordRow, [string, string, string]>(
        `SELECT * FROM collaboration_records
         WHERE person_id = ? AND partition_key = ? AND dedup_key = ?
           AND epistemic_status != 'retracted' AND superseded_by IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(personId, partitionKey, dedupKey);

    if (
      existing !== null &&
      isMemtSensitivity(existing.sensitivity) &&
      (dedupCeilingRank === null || MEMT_SENSITIVITY_ORDER[existing.sensitivity] <= dedupCeilingRank)
    ) {
      const existingEvidence = parseStringArrayJson(existing.evidence_refs_json);
      const existingRoots = parseStringArrayJson(existing.source_roots_json);
      const existingDerivedRoots = new Set(
        existingEvidence.map(deriveSourceRoot).filter((r) => r.length > 0),
      );
      const newDerivedRoots = derivedRoots.filter((r) => !existingDerivedRoots.has(r));
      const mergedEvidence = mergeUniqueStrings(existingEvidence, evidenceRefs);
      let mergedRoots = existingRoots;
      if (newDerivedRoots.length > 0) {
        const candidateNewRoots = sourceRoots.filter((r) => !existingRoots.includes(r));
        mergedRoots = mergeUniqueStrings(
          existingRoots,
          candidateNewRoots.slice(0, newDerivedRoots.length),
        );
      }
      // Never let a lower-authority proposal widen scope, add exceptions, or
      // overwrite authoritative fields on an existing owner_instruction.
      const preserveOwnerInstruction =
        existing.authority_level === "owner_instruction" &&
        authorityLevel !== "owner_instruction";
      const mergedScope = preserveOwnerInstruction
        ? parseStringArrayJson(existing.scope_json)
        : mergeUniqueStrings(parseStringArrayJson(existing.scope_json), scope);
      const mergedExceptions = preserveOwnerInstruction
        ? parseExceptionsJson(existing.exceptions_json)
        : normalizeExceptions([...parseExceptionsJson(existing.exceptions_json), ...exceptions]);
      const mergedAuthority: CollaborationAuthorityLevel =
        existing.authority_level === "owner_instruction" || authorityLevel === "owner_instruction"
          ? "owner_instruction"
          : existing.authority_level === "observed_preference" || authorityLevel === "observed_preference"
            ? "observed_preference"
            : "inferred_taste";
      const mergedSensitivity: MemtSensitivity =
        MEMT_SENSITIVITY_ORDER[existing.sensitivity] >= MEMT_SENSITIVITY_ORDER[input.sensitivity]
          ? existing.sensitivity
          : input.sensitivity;
      const mergedTaint: "clean" | "quoted" = preserveOwnerInstruction
        ? (existing.taint === "clean" ? "clean" : "quoted")
        : existing.taint === "quoted" || taint === "quoted"
          ? "quoted"
          : "clean";
      const hadNewIndependentRoot = mergedRoots.length > existingRoots.length;
      // B3 invariant: repeated copies from the SAME source root never boost confidence or promote a hypothesis.
      const mergedConfidence = hadNewIndependentRoot
        ? clampUnit(Math.max(existing.confidence, confidence) + 0.08, existing.confidence)
        : Math.max(existing.confidence, authorityLevel === "owner_instruction" ? confidence : existing.confidence);
      const mergedUncertainty = Number((1 - mergedConfidence).toFixed(4));
      const mergedEpistemic = computeEpistemicStatus(
        mergedAuthority,
        mergedRoots,
        existing.epistemic_status === "contested",
      );
      const mergedReason = preserveOwnerInstruction
        ? existing.reason
        : reason.length > existing.reason.length
          ? reason
          : existing.reason;
      const mergedVerification = preserveOwnerInstruction
        ? existing.verification
        : verification.length > existing.verification.length
          ? verification
          : existing.verification;
      const mergedValidFrom = preserveOwnerInstruction ? null : validFrom;
      const mergedValidUntil = preserveOwnerInstruction ? null : validUntil;
      const mergedConflictGroup = preserveOwnerInstruction ? null : conflictGroup;

      const tx = this.db.transaction(() => {
        this.db
          .query(
            `UPDATE collaboration_records
             SET reason = ?, verification = ?, scope_json = ?, exceptions_json = ?,
                 evidence_refs_json = ?, source_roots_json = ?, sensitivity = ?, taint = ?,
                 authority_level = ?, epistemic_status = ?, confidence = ?, uncertainty = ?,
                 valid_from = COALESCE(?, valid_from), valid_until = COALESCE(?, valid_until),
                 conflict_group = COALESCE(?, conflict_group), updated_at = ?
             WHERE id = ?`,
          )
          .run(
            mergedReason,
            mergedVerification,
            JSON.stringify(mergedScope),
            JSON.stringify(mergedExceptions),
            JSON.stringify(mergedEvidence),
            JSON.stringify(mergedRoots),
            mergedSensitivity,
            mergedTaint,
            mergedAuthority,
            mergedEpistemic,
            mergedConfidence,
            mergedUncertainty,
            mergedValidFrom,
            mergedValidUntil,
            mergedConflictGroup,
            now,
            existing.id,
          );
        const insertSource = this.db.query(
          "INSERT OR IGNORE INTO collaboration_record_sources (record_id, source_ref) VALUES (?, ?)",
        );
        for (const ref of evidenceRefs) {
          const canon = canonicalSourceRef(ref);
          if (canon.length > 0) insertSource.run(existing.id, canon);
        }
      });
      tx();

      const updatedRow = this.db
        .query<RecordRow, [string]>("SELECT * FROM collaboration_records WHERE id = ?")
        .get(existing.id)!;
      return {
        record: rowToRecord(updatedRow)!,
        deduplicated: true,
        mergedIntoId: existing.id,
      };
    }

    const id = input.id?.trim() || generateId("cfr");
    const epistemicStatus = computeEpistemicStatus(authorityLevel, sourceRoots, false);

    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO collaboration_records (
            id, person_id, partition_key, area, kind, condition, guidance, reason, verification,
            scope_json, exceptions_json, evidence_refs_json, source_roots_json,
            sensitivity, taint, authority_level, epistemic_status,
            confidence, uncertainty, valid_from, valid_until, conflict_group,
            superseded_by, dedup_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        )
        .run(
          id,
          personId,
          partitionKey,
          input.area,
          kind,
          condition,
          guidance,
          reason,
          verification,
          JSON.stringify(scope),
          JSON.stringify(exceptions),
          JSON.stringify(evidenceRefs),
          JSON.stringify(sourceRoots),
          input.sensitivity,
          taint,
          authorityLevel,
          epistemicStatus,
          confidence,
          uncertainty,
          validFrom,
          validUntil,
          conflictGroup,
          dedupKey,
          now,
          now,
        );
      const insertSource = this.db.query(
        "INSERT OR IGNORE INTO collaboration_record_sources (record_id, source_ref) VALUES (?, ?)",
      );
      for (const ref of evidenceRefs) {
        const canon = canonicalSourceRef(ref);
        if (canon.length > 0) insertSource.run(id, canon);
      }
      // Advance ingestion-driven progress from connecting -> partial_backfill once records land.
      this.db
        .query(
          `UPDATE collaboration_progress
           SET stage = 'partial_backfill', updated_at = ?
           WHERE person_id = ? AND partition_key = ? AND stage = 'connecting'`,
        )
        .run(now, personId, partitionKey);
    });
    tx();

    const inserted = this.db
      .query<RecordRow, [string]>("SELECT * FROM collaboration_records WHERE id = ?")
      .get(id)!;
    return {
      record: rowToRecord(inserted)!,
      deduplicated: false,
    };
  }

  getFacet(id: string): CollaborationRecord | null {
    const row = this.db
      .query<RecordRow, [string]>("SELECT * FROM collaboration_records WHERE id = ?")
      .get(id);
    return row === null ? null : rowToRecord(row);
  }

  retractFacet(id: string, now: string = new Date().toISOString()): boolean {
    const res = this.db
      .query(
        `UPDATE collaboration_records
         SET epistemic_status = 'retracted', updated_at = ?
         WHERE id = ? AND epistemic_status != 'retracted'`,
      )
      .run(now, id);
    return res.changes > 0;
  }

  updateConnectionProgress(input: UpdateConnectionProgressInput): ConnectionProgressState {
    const personId = input.person_id.trim();
    const partitionKey = (input.partition_key ?? "default").trim();
    if (personId.length === 0) throw new Error("person_id must be non-empty");
    if (partitionKey.length === 0) throw new Error("partition_key must be non-empty");
    const ceiling: MemtSensitivity = input.sensitivityCeiling ?? "public";
    if (!isMemtSensitivity(ceiling)) {
      throw new Error(`invalid sensitivityCeiling: ${String(ceiling)}`);
    }
    const now = input.now ?? new Date().toISOString();
    const cursor = (input.resume_cursor ?? "").trim();

    this.db
      .query(
        `INSERT INTO collaboration_progress (person_id, partition_key, stage, historical_complete, resume_cursor, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(person_id, partition_key) DO UPDATE SET
           stage = excluded.stage,
           historical_complete = excluded.historical_complete,
           resume_cursor = excluded.resume_cursor,
           updated_at = excluded.updated_at`,
      )
      .run(personId, partitionKey, input.stage, input.historical_complete ? 1 : 0, cursor, now);

    return this.getConnectionProgress(personId, partitionKey, ceiling);
  }

  getConnectionProgress(
    personId: string,
    partitionKey: string,
    sensitivityCeiling: MemtSensitivity,
    isEvidenceAuthorized?: (evidenceRefs: readonly string[]) => boolean,
  ): ConnectionProgressState {
    const row = this.db
      .query<{
        stage: CollaborationConnectionStage;
        historical_complete: number;
        resume_cursor: string;
        updated_at: string;
      }, [string, string]>(
        `SELECT stage, historical_complete, resume_cursor, updated_at
         FROM collaboration_progress
         WHERE person_id = ? AND partition_key = ?`,
      )
      .get(personId, partitionKey);

    const allowedSens = allowedSensitivitiesForCeiling(sensitivityCeiling);
    const placeholders = allowedSens.map(() => "?").join(", ");
    let highInfo = 0;
    if (isEvidenceAuthorized === undefined) {
      highInfo = this.db
        .query<{ cnt: number }, SQLQueryBindings[]>(
          `SELECT COUNT(*) AS cnt FROM collaboration_records
           WHERE person_id = ? AND partition_key = ?
             AND sensitivity IN (${placeholders})
             AND epistemic_status IN ('owner_instruction', 'corroborated')
             AND superseded_by IS NULL`,
        )
        .get(personId, partitionKey, ...allowedSens)?.cnt ?? 0;
    } else {
      const candidateRows = this.db
        .query<{ evidence_refs_json: string }, SQLQueryBindings[]>(
          `SELECT evidence_refs_json FROM collaboration_records
           WHERE person_id = ? AND partition_key = ?
             AND sensitivity IN (${placeholders})
             AND epistemic_status IN ('owner_instruction', 'corroborated')
             AND superseded_by IS NULL`,
        )
        .all(personId, partitionKey, ...allowedSens);
      for (const recRow of candidateRows) {
        const refs = parseStringArrayJson(recRow.evidence_refs_json);
        if (refs.length > 0 && isEvidenceAuthorized(refs)) {
          highInfo += 1;
        }
      }
    }

    if (row === null) {
      return {
        person_id: personId,
        partition_key: partitionKey,
        stage: "complete",
        historical_complete: true,
        resume_cursor: "",
        high_info_indexed: highInfo,
        updated_at: "",
      };
    }

    return {
      person_id: personId,
      partition_key: partitionKey,
      stage: row.stage,
      historical_complete: row.historical_complete === 1,
      resume_cursor: row.resume_cursor,
      high_info_indexed: highInfo,
      updated_at: row.updated_at,
    };
  }

  recordCrossAgentHandoff(input: RecordCrossAgentHandoffInput): RecordCrossAgentHandoffResult {
    const idempotencyKey = input.idempotency_key.trim();
    const personId = input.person_id.trim();
    const partitionKey = (input.partition_key ?? "default").trim();
    const agentId = input.agent_id.trim();
    const servedSliceHash = input.served_slice_hash.trim();
    const task = input.task.trim();
    const workSummary = input.work_summary.trim();

    if (idempotencyKey.length === 0) throw new Error("idempotency_key must be non-empty");
    if (personId.length === 0) throw new Error("person_id must be non-empty");
    if (partitionKey.length === 0) throw new Error("partition_key must be non-empty");
    if (agentId.length === 0) throw new Error("agent_id must be non-empty");
    if (!/^[0-9a-f]{64}$/i.test(servedSliceHash)) {
      throw new Error("served_slice_hash must be a valid 64-character hex slice digest");
    }
    if (task.length === 0) throw new Error("task must be non-empty");
    if (workSummary.length === 0) throw new Error("work_summary must be non-empty");
    if (!isCollaborationArea(input.area)) throw new Error(`invalid area: ${String(input.area)}`);
    if (!isCollaborationHandoffKind(input.kind)) throw new Error(`invalid handoff kind: ${String(input.kind)}`);
    if (!isMemtSensitivity(input.sensitivity)) throw new Error(`invalid sensitivity: ${String(input.sensitivity)}`);

    const effectiveCeiling: MemtSensitivity = input.sensitivityCeiling ?? input.sensitivity;
    if (!isMemtSensitivity(effectiveCeiling)) {
      throw new Error(`invalid sensitivityCeiling: ${String(effectiveCeiling)}`);
    }
    if (!withinSensitivityCeiling(input.sensitivity, effectiveCeiling)) {
      throw new Error("requested sensitivity exceeds caller ceiling");
    }
    if (
      input.allowedSubjects !== undefined &&
      input.allowedSubjects !== null &&
      !input.allowedSubjects.includes(personId)
    ) {
      throw new Error("subject outside caller grant");
    }

    const evidenceRefs = mergeUniqueStrings([], input.evidence_refs);
    if (evidenceRefs.length === 0) {
      throw new Error("evidence_refs must contain at least one provenance reference");
    }
    if (input.kind === "observed_outcome" && typeof input.observed_passed !== "boolean") {
      throw new Error("observed_passed boolean is required for observed_outcome");
    }

    // B6 idempotency: repeated delivery with the same idempotency key returns the original receipt
    // ONLY when authorized under the caller's live ceiling and identity.
    const existing = this.db
      .query<HandoffRow, [string, string, string]>(
        `SELECT * FROM collaboration_handoffs
         WHERE person_id = ? AND partition_key = ? AND idempotency_key = ?`,
      )
      .get(personId, partitionKey, idempotencyKey);
    if (existing !== null) {
      if (
        !isMemtSensitivity(existing.sensitivity) ||
        !withinSensitivityCeiling(existing.sensitivity, effectiveCeiling) ||
        (input.callerAgentId !== undefined &&
          input.callerAgentId !== null &&
          existing.agent_id !== input.callerAgentId)
      ) {
        throw new Error("handoff replay denied for current caller");
      }
      const rawExistingRec =
        existing.created_record_id !== null ? this.getFacet(existing.created_record_id) : null;
      const existingRec =
        rawExistingRec !== null && withinSensitivityCeiling(rawExistingRec.sensitivity, effectiveCeiling)
          ? rawExistingRec
          : null;
      return {
        handoff: rowToHandoff(existing)!,
        idempotentReplay: true,
        createdRecord: existingRec,
      };
    }

    const now = input.now ?? new Date().toISOString();
    const handoffId = generateId("chf");
    const correctionText = (input.correction_text ?? "").trim();
    const artifactRef = (input.artifact_ref ?? "").trim();
    const supersedesId =
      input.supersedes_record_id !== undefined && input.supersedes_record_id.trim().length > 0
        ? input.supersedes_record_id.trim()
        : null;

    // B6: an agent's self-claim is NEVER an independently observed outcome or owner endorsement.
    const outcomeStatus: CollaborationOutcomeStatus =
      input.kind === "agent_claim"
        ? "unverified_agent_claim"
        : input.kind === "owner_correction" || input.kind === "owner_edit"
          ? "owner_corrected"
          : input.observed_passed === false
            ? "observed_fail"
            : "observed_pass";

    let createdRecord: CollaborationRecord | null = null;
    let ownedCreatedRecordId: string | null = null;
    let authorizedSupersedesId: string | null = null;

    // Commit facet creation/supersession and handoff receipt in one atomic transaction.
    const tx = this.db.transaction(() => {
      if (
        (input.kind === "owner_correction" || input.kind === "owner_edit") &&
        correctionText.length > 0
      ) {
        const rawSuperseded =
          supersedesId !== null
            ? this.db
                .query<RecordRow, [string]>("SELECT * FROM collaboration_records WHERE id = ?")
                .get(supersedesId)
            : null;
        // Authorize predecessor BEFORE reading or inheriting any of its fields.
        const authorizedSuperseded =
          rawSuperseded !== null &&
          rawSuperseded.person_id === personId &&
          rawSuperseded.partition_key === partitionKey &&
          isMemtSensitivity(rawSuperseded.sensitivity) &&
          withinSensitivityCeiling(rawSuperseded.sensitivity, effectiveCeiling)
            ? rawSuperseded
            : null;
        const scope =
          input.scope !== undefined && input.scope.length > 0
            ? input.scope
            : authorizedSuperseded !== null
              ? parseStringArrayJson(authorizedSuperseded.scope_json)
              : [normalizeTag(task) || "all"];
        const condition =
          input.condition !== undefined && input.condition.trim().length > 0
            ? input.condition.trim()
            : authorizedSuperseded !== null
              ? authorizedSuperseded.condition
              : task;
        const exceptions =
          input.exceptions !== undefined
            ? input.exceptions
            : authorizedSuperseded !== null
              ? parseExceptionsJson(authorizedSuperseded.exceptions_json)
              : [];

        const facetRes = this.recordFacet({
          person_id: personId,
          partition_key: partitionKey,
          area: input.area,
          kind: "rule",
          condition,
          guidance: correctionText,
          reason: `Owner ${input.kind === "owner_edit" ? "edit" : "correction"} to ${agentId} work`,
          scope,
          exceptions,
          evidence_refs: evidenceRefs,
          sensitivity: input.sensitivity,
          dedupSensitivityCeiling: effectiveCeiling,
          taint: "clean",
          authority_level: "owner_instruction",
          confidence: 0.96,
          now,
        });
        createdRecord = facetRes.record;
        // Only attribute ownership of created_record_id when this handoff actually
        // created the record; deduplicated merges must not let undo retract a pre-existing rule.
        ownedCreatedRecordId = facetRes.deduplicated ? null : facetRes.record.id;

        if (authorizedSuperseded !== null && authorizedSuperseded.id !== facetRes.record.id) {
          authorizedSupersedesId = authorizedSuperseded.id;
          this.db
            .query(
              "UPDATE collaboration_records SET superseded_by = ?, updated_at = ? WHERE id = ?",
            )
            .run(facetRes.record.id, now, authorizedSuperseded.id);
        }
      }

      this.db
        .query(
          `INSERT INTO collaboration_handoffs (
            id, idempotency_key, person_id, partition_key, agent_id, served_slice_hash,
            task, area, kind, outcome_status, work_summary, artifact_ref, correction_text,
            supersedes_record_id, created_record_id, evidence_refs_json, sensitivity,
            reverted_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(
          handoffId,
          idempotencyKey,
          personId,
          partitionKey,
          agentId,
          servedSliceHash,
          task,
          input.area,
          input.kind,
          outcomeStatus,
          workSummary,
          artifactRef,
          correctionText,
          authorizedSupersedesId,
          ownedCreatedRecordId,
          JSON.stringify(evidenceRefs),
          input.sensitivity,
          now,
        );
      const insertSource = this.db.query(
        "INSERT OR IGNORE INTO collaboration_handoff_sources (handoff_id, source_ref) VALUES (?, ?)",
      );
      for (const ref of evidenceRefs) {
        const canon = canonicalSourceRef(ref);
        if (canon.length > 0) insertSource.run(handoffId, canon);
      }
    });
    tx();

    const row = this.db
      .query<HandoffRow, [string]>("SELECT * FROM collaboration_handoffs WHERE id = ?")
      .get(handoffId)!;
    return {
      handoff: rowToHandoff(row)!,
      idempotentReplay: false,
      createdRecord,
    };
  }

  /**
   * B6 undo: revert a cross-agent handoff correction without resurrecting purged evidence
   * or retracting records not created by this handoff.
   */
  undoHandoff(
    handoffId: string,
    sensitivityCeiling: MemtSensitivity,
    now: string = new Date().toISOString(),
    allowedSubjects?: readonly string[] | null,
  ): UndoHandoffResult {
    const row = this.db
      .query<HandoffRow, [string]>("SELECT * FROM collaboration_handoffs WHERE id = ?")
      .get(handoffId);
    if (
      row === null ||
      !isMemtSensitivity(row.sensitivity) ||
      !withinSensitivityCeiling(row.sensitivity, sensitivityCeiling) ||
      (allowedSubjects !== undefined &&
        allowedSubjects !== null &&
        !allowedSubjects.includes(row.person_id))
    ) {
      return {
        undone: false,
        handoff_id: handoffId,
        retracted_record_id: null,
        restored_record_id: null,
      };
    }

    let retractedId: string | null = null;
    let restoredId: string | null = null;

    const tx = this.db.transaction(() => {
      this.db
        .query("UPDATE collaboration_handoffs SET reverted_at = ? WHERE id = ?")
        .run(now, handoffId);

      if (row.created_record_id !== null) {
        const createdRec = this.db
          .query<RecordRow, [string]>("SELECT * FROM collaboration_records WHERE id = ?")
          .get(row.created_record_id);
        if (
          createdRec !== null &&
          createdRec.person_id === row.person_id &&
          createdRec.partition_key === row.partition_key &&
          isMemtSensitivity(createdRec.sensitivity) &&
          withinSensitivityCeiling(createdRec.sensitivity, sensitivityCeiling)
        ) {
          const res = this.db
            .query(
              `UPDATE collaboration_records
               SET epistemic_status = 'retracted', updated_at = ?
               WHERE id = ? AND epistemic_status != 'retracted'`,
            )
            .run(now, row.created_record_id);
          if (res.changes > 0) retractedId = row.created_record_id;
        }
      }

      // Restore superseded record ONLY if it still exists and is authorized under the caller's grant.
      if (row.supersedes_record_id !== null && row.created_record_id !== null) {
        const supersededRec = this.db
          .query<RecordRow, [string]>("SELECT * FROM collaboration_records WHERE id = ?")
          .get(row.supersedes_record_id);
        if (
          supersededRec !== null &&
          supersededRec.person_id === row.person_id &&
          supersededRec.partition_key === row.partition_key &&
          isMemtSensitivity(supersededRec.sensitivity) &&
          withinSensitivityCeiling(supersededRec.sensitivity, sensitivityCeiling)
        ) {
          const res = this.db
            .query(
              `UPDATE collaboration_records
               SET superseded_by = NULL, updated_at = ?
               WHERE id = ? AND superseded_by = ? AND epistemic_status != 'retracted'`,
            )
            .run(now, row.supersedes_record_id, row.created_record_id);
          if (res.changes > 0) restoredId = row.supersedes_record_id;
        }
      }
    });
    tx();

    return {
      undone: true,
      handoff_id: handoffId,
      retracted_record_id: retractedId,
      restored_record_id: restoredId,
    };
  }

  purgeBySourceRefs(sourceRefs: readonly string[]): PurgeCollaborationResult {
    const targetSet = new Set<string>();
    for (const ref of sourceRefs) {
      const canon = canonicalSourceRef(ref);
      if (canon.length > 0) targetSet.add(canon);
      for (const variant of normalizeSourceRefVariants(ref)) {
        targetSet.add(variant);
      }
    }
    if (targetSet.size === 0) {
      return { purgedRecordIds: [], purgedHandoffIds: [], purgedCount: 0 };
    }

    const targets = [...targetSet];
    const recordIds = new Set<string>();
    const handoffIds = new Set<string>();
    const chunkSize = 200;

    for (let i = 0; i < targets.length; i += chunkSize) {
      const slice = targets.slice(i, i + chunkSize);
      const placeholders = slice.map(() => "?").join(", ");
      const matchedRecords = this.db
        .query<{ record_id: string }, string[]>(
          `SELECT DISTINCT record_id FROM collaboration_record_sources WHERE source_ref IN (${placeholders})`,
        )
        .all(...slice);
      for (const r of matchedRecords) recordIds.add(r.record_id);

      const matchedHandoffs = this.db
        .query<{ handoff_id: string }, string[]>(
          `SELECT DISTINCT handoff_id FROM collaboration_handoff_sources WHERE source_ref IN (${placeholders})`,
        )
        .all(...slice);
      for (const h of matchedHandoffs) handoffIds.add(h.handoff_id);
    }

    const purgedRecordIds = [...recordIds].sort();
    const purgedHandoffIds = [...handoffIds].sort();

    if (purgedRecordIds.length > 0 || purgedHandoffIds.length > 0) {
      const tx = this.db.transaction(() => {
        const delRec = this.db.query("DELETE FROM collaboration_records WHERE id = ?");
        const clearSuperseded = this.db.query(
          "UPDATE collaboration_records SET superseded_by = NULL WHERE superseded_by = ?",
        );
        for (const id of purgedRecordIds) {
          clearSuperseded.run(id);
          delRec.run(id);
        }

        const delHandoff = this.db.query("DELETE FROM collaboration_handoffs WHERE id = ?");
        for (const id of purgedHandoffIds) {
          delHandoff.run(id);
        }
      });
      tx();
    }

    return {
      purgedRecordIds: Object.freeze(purgedRecordIds),
      purgedHandoffIds: Object.freeze(purgedHandoffIds),
      purgedCount: purgedRecordIds.length + purgedHandoffIds.length,
    };
  }

  compileSlice(input: CompileCollaborationSliceInput): CollaborationSlice {
    const personId = input.person_id.trim();
    const partitionKey = (input.partition_key ?? "default").trim();
    const task = input.task.trim();
    const taskKind =
      input.task_kind !== undefined && input.task_kind.trim().length > 0
        ? normalizeTag(input.task_kind)
        : null;
    const budgetTokens = Math.max(100, Math.min(4000, input.budgetTokens ?? 1200));
    const maxRules = Math.max(1, Math.min(24, input.maxRules ?? 8));
    const maxExamples = Math.max(1, Math.min(12, input.maxExamplesPerPolarity ?? 4));
    const maxRubric = Math.max(1, Math.min(24, input.maxRubricItems ?? 8));

    if (personId.length === 0) throw new Error("person_id must be non-empty");
    if (partitionKey.length === 0) throw new Error("partition_key must be non-empty");
    if (task.length === 0) throw new Error("task must be non-empty");
    if (!isMemtSensitivity(input.sensitivityCeiling)) {
      throw new Error(`invalid sensitivityCeiling: ${String(input.sensitivityCeiling)}`);
    }

    const asOfMs =
      input.asOf !== undefined && isValidRfc3339(input.asOf)
        ? Date.parse(input.asOf)
        : Date.now();

    // B2 grant enforcement BEFORE any discovery, traversal, ranking, or counting.
    const subjectAllowed =
      input.allowedSubjects === undefined ||
      input.allowedSubjects === null ||
      input.allowedSubjects.includes(personId);

    const allowedSens = allowedSensitivitiesForCeiling(input.sensitivityCeiling);
    const sensPlaceholders = allowedSens.map(() => "?").join(", ");

    const storedProgress = subjectAllowed
      ? this.getConnectionProgress(
          personId,
          partitionKey,
          input.sensitivityCeiling,
          input.isEvidenceAuthorized,
        )
      : {
          person_id: personId,
          partition_key: partitionKey,
          stage: "complete" as const,
          historical_complete: true,
          resume_cursor: "",
          high_info_indexed: 0,
          updated_at: "",
        };
    const progress: ConnectionProgressState =
      subjectAllowed &&
      input.ingestionProgress !== undefined &&
      !input.ingestionProgress.historical_complete
        ? {
            ...storedProgress,
            stage: input.ingestionProgress.stage,
            historical_complete: false,
            resume_cursor: input.ingestionProgress.resume_cursor ?? storedProgress.resume_cursor,
          }
        : storedProgress;

    const permittedRows = subjectAllowed
      ? this.db
          .query<RecordRow, SQLQueryBindings[]>(
            `SELECT * FROM collaboration_records
             WHERE person_id = ? AND partition_key = ?
               AND sensitivity IN (${sensPlaceholders})
               AND epistemic_status != 'retracted'
               AND superseded_by IS NULL
             ORDER BY updated_at DESC, id ASC`,
          )
          .all(personId, partitionKey, ...allowedSens)
      : [];

    const permittedRecords: CollaborationRecord[] = [];
    for (const row of permittedRows) {
      const rec = rowToRecord(row);
      if (rec === null) continue;
      if (!withinSensitivityCeiling(rec.sensitivity, input.sensitivityCeiling)) continue;
      if (!isTemporallyApplicable(rec.valid_from, rec.valid_until, asOfMs)) continue;
      if (input.isEvidenceAuthorized !== undefined && !input.isEvidenceAuthorized(rec.evidence_refs)) {
        continue;
      }
      permittedRecords.push(rec);
    }

    // B1: Build explicit coverage across all 6 collaboration areas using ONLY permitted records.
    const areaRecords = new Map<CollaborationArea, CollaborationRecord[]>();
    for (const area of COLLABORATION_AREAS) areaRecords.set(area, []);
    for (const rec of permittedRecords) {
      areaRecords.get(rec.area)!.push(rec);
    }

    const unknownReason: "no_permitted_evidence" | "ingestion_in_progress" =
      progress.historical_complete ? "no_permitted_evidence" : "ingestion_in_progress";

    const areasObj = {} as Record<CollaborationArea, CollaborationAreaCoverage>;
    const insufficientAreas: {
      readonly area: CollaborationArea;
      readonly reason: "no_permitted_evidence" | "ingestion_in_progress";
    }[] = [];

    for (const area of COLLABORATION_AREAS) {
      const list = areaRecords.get(area)!;
      if (list.length === 0) {
        areasObj[area] = Object.freeze({
          area,
          status: "unknown",
          reason: unknownReason,
          record_count: 0,
          highest_authority: null,
        });
        insufficientAreas.push(Object.freeze({ area, reason: unknownReason }));
      } else {
        const highest: CollaborationAuthorityLevel = list.some((r) => r.authority_level === "owner_instruction")
          ? "owner_instruction"
          : list.some((r) => r.authority_level === "observed_preference")
            ? "observed_preference"
            : "inferred_taste";
        areasObj[area] = Object.freeze({
          area,
          status: "known",
          record_count: list.length,
          highest_authority: highest,
        });
      }
    }

    const requestedAreas =
      input.areas !== undefined && input.areas.length > 0 ? new Set(input.areas) : null;
    const taskNormalized = normalizeText(task);
    const taskKindNormalized = taskKind ?? "";
    const taskTokens = extractTokens(`${task} ${taskKindNormalized}`);

    interface ScoredRecord {
      readonly record: CollaborationRecord;
      readonly score: number;
      readonly triggeredException: CollaborationException | null;
    }

    const matched: ScoredRecord[] = [];
    for (const rec of permittedRecords) {
      if (requestedAreas !== null && !requestedAreas.has(rec.area)) continue;
      const rel = computeRecordTaskRelevance(
        rec,
        taskNormalized,
        taskKindNormalized,
        taskTokens,
        requestedAreas,
      );
      const triggered = matchException(rec.exceptions, taskNormalized, taskKindNormalized, taskTokens);
      if (!rel.relevant && triggered === null) continue;
      matched.push({
        record: rec,
        score: triggered !== null ? Math.max(rel.score, 2.5) : rel.score,
        triggeredException: triggered,
      });
    }

    matched.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.record.id.localeCompare(b.record.id);
    });

    // Detect explicit conflicts among matched permitted records sharing a conflict_group
    const conflictBuckets = new Map<string, CollaborationRecord[]>();
    for (const entry of matched) {
      const group = entry.record.conflict_group;
      if (group !== null && entry.triggeredException === null) {
        const list = conflictBuckets.get(group);
        if (list === undefined) conflictBuckets.set(group, [entry.record]);
        else list.push(entry.record);
      }
    }
    const conflicts: CollaborationConflictItem[] = [];
    for (const [group, recs] of conflictBuckets.entries()) {
      const distinctGuidance = new Set(recs.map((r) => normalizeText(r.guidance)));
      if (recs.length >= 2 && distinctGuidance.size >= 2) {
        const sortedRecs = [...recs].sort((a, b) => a.id.localeCompare(b.id));
        conflicts.push(
          Object.freeze({
            conflict_group: group,
            area: sortedRecs[0]!.area,
            record_ids: Object.freeze(sortedRecs.map((r) => r.id)),
            statements: Object.freeze(sortedRecs.map((r) => r.guidance)),
            evidence_refs: Object.freeze(
              mergeUniqueStrings([], sortedRecs.flatMap((r) => r.evidence_refs)),
            ),
          }),
        );
      }
    }
    conflicts.sort((a, b) => a.conflict_group.localeCompare(b.conflict_group));

    // Separate into triggered exceptions, active rules, positive/negative examples, and rubric criteria
    const triggeredExceptions: TriggeredExceptionItem[] = [];
    const candidateRules: CompiledBriefRule[] = [];
    const candidatePositive: GroundedExampleItem[] = [];
    const candidateNegative: GroundedExampleItem[] = [];
    const candidateRubric: RubricCriterionItem[] = [];
    const seenRubricKeys = new Set<string>();

    for (const entry of matched) {
      const rec = entry.record;
      if (entry.triggeredException !== null) {
        triggeredExceptions.push(
          Object.freeze({
            rule_id: rec.id,
            area: rec.area,
            base_guidance: rec.guidance,
            matched_condition: entry.triggeredException.condition,
            exception_note: entry.triggeredException.note,
            evidence_refs: rec.evidence_refs,
            uncertainty: rec.uncertainty,
          }),
        );
        continue;
      }

      if (rec.kind === "rule") {
        if (candidateRules.length < maxRules) {
          candidateRules.push(
            Object.freeze({
              id: rec.id,
              area: rec.area,
              condition: rec.condition,
              guidance: rec.guidance,
              scope: rec.scope,
              exceptions: rec.exceptions,
              evidence_refs: rec.evidence_refs,
              epistemic_status: rec.epistemic_status,
              authority_level: rec.authority_level,
              confidence: rec.confidence,
              uncertainty: rec.uncertainty,
              taint: rec.taint,
              grants_authority: false,
            }),
          );
        }
        // Derive a grounded rubric item from rules that carry explicit verification or owner instruction
        const rubricKey = `${rec.area}\0${normalizeText(rec.guidance)}`;
        if (
          candidateRubric.length < maxRubric &&
          !seenRubricKeys.has(rubricKey) &&
          (rec.verification.length > 0 || rec.authority_level === "owner_instruction")
        ) {
          seenRubricKeys.add(rubricKey);
          candidateRubric.push(
            Object.freeze({
              id: rec.id,
              area: rec.area,
              criterion: rec.guidance,
              verification: rec.verification.length > 0 ? rec.verification : `Verify output aligns with: ${rec.guidance}`,
              requirement_level: rubricRequirementLevelFor(rec.authority_level, rec.epistemic_status),
              authority_level: rec.authority_level,
              epistemic_status: rec.epistemic_status,
              evidence_refs: rec.evidence_refs,
              uncertainty: rec.uncertainty,
              grants_authority: false,
            }),
          );
        }
      } else if (rec.kind === "example_positive") {
        if (candidatePositive.length < maxExamples) {
          candidatePositive.push(
            Object.freeze({
              id: rec.id,
              polarity: "positive",
              area: rec.area,
              condition: rec.condition,
              example: rec.guidance,
              reason: rec.reason.length > 0 ? rec.reason : "Accepted example grounded in evidence",
              scope: rec.scope,
              evidence_refs: rec.evidence_refs,
              epistemic_status: rec.epistemic_status,
              authority_level: rec.authority_level,
              uncertainty: rec.uncertainty,
              taint: rec.taint,
              grants_authority: false,
            }),
          );
        }
      } else if (rec.kind === "example_negative") {
        if (candidateNegative.length < maxExamples) {
          candidateNegative.push(
            Object.freeze({
              id: rec.id,
              polarity: "negative",
              area: rec.area,
              condition: rec.condition,
              example: rec.guidance,
              reason: rec.reason.length > 0 ? rec.reason : "Rejected example grounded in evidence",
              scope: rec.scope,
              evidence_refs: rec.evidence_refs,
              epistemic_status: rec.epistemic_status,
              authority_level: rec.authority_level,
              uncertainty: rec.uncertainty,
              taint: rec.taint,
              grants_authority: false,
            }),
          );
        }
      } else if (rec.kind === "criterion") {
        const rubricKey = `${rec.area}\0${normalizeText(rec.guidance)}`;
        if (candidateRubric.length < maxRubric && !seenRubricKeys.has(rubricKey)) {
          seenRubricKeys.add(rubricKey);
          candidateRubric.push(
            Object.freeze({
              id: rec.id,
              area: rec.area,
              criterion: rec.guidance,
              verification: rec.verification.length > 0 ? rec.verification : rec.condition,
              requirement_level: rubricRequirementLevelFor(rec.authority_level, rec.epistemic_status),
              authority_level: rec.authority_level,
              epistemic_status: rec.epistemic_status,
              evidence_refs: rec.evidence_refs,
              uncertainty: rec.uncertainty,
              grants_authority: false,
            }),
          );
        }
      }
    }

    // Recent non-reverted permitted handoffs for B6 cross-agent continuity,
    // filtered by area and task relevance BEFORE budget packing.
    const handoffRows = subjectAllowed
      ? this.db
          .query<HandoffRow, SQLQueryBindings[]>(
            `SELECT * FROM collaboration_handoffs
             WHERE person_id = ? AND partition_key = ?
               AND sensitivity IN (${sensPlaceholders})
               AND reverted_at IS NULL
             ORDER BY created_at DESC, id ASC
             LIMIT 64`,
          )
          .all(personId, partitionKey, ...allowedSens)
      : [];
    const candidateHandoffs = handoffRows
      .map(rowToHandoff)
      .filter((h): h is CollaborationHandoffRecord => h !== null)
      .filter(
        (h) => input.isEvidenceAuthorized === undefined || input.isEvidenceAuthorized(h.evidence_refs),
      )
      .map((h) => ({
        handoff: h,
        rel: computeHandoffTaskRelevance(
          h,
          taskNormalized,
          taskKindNormalized,
          taskTokens,
          requestedAreas,
        ),
      }))
      .filter((entry) => entry.rel.relevant)
      .sort((a, b) => {
        if (b.rel.score !== a.rel.score) return b.rel.score - a.rel.score;
        if (b.handoff.created_at !== a.handoff.created_at) {
          return b.handoff.created_at.localeCompare(a.handoff.created_at);
        }
        return a.handoff.id.localeCompare(b.handoff.id);
      })
      .slice(0, 6)
      .map(({ handoff: h }) =>
        Object.freeze({
          id: h.id,
          agent_id: h.agent_id,
          kind: h.kind,
          outcome_status: h.outcome_status,
          endorsed_by_owner: h.endorsed_by_owner,
          area: h.area,
          correction_text: h.correction_text,
          evidence_refs: h.evidence_refs,
        }),
      );

    // Budget packing (B5): enforce budgetTokens on the COMPLETE response object.
    // Prioritize triggered exceptions -> active rules -> rubric -> conflicts -> examples -> handoffs.
    const candidateExceptions = triggeredExceptions;
    const candidateConflicts = conflicts;
    const packedExceptions: TriggeredExceptionItem[] = [];
    const activeRules: CompiledBriefRule[] = [];
    const packedConflicts: CollaborationConflictItem[] = [];
    const positiveExamples: GroundedExampleItem[] = [];
    const negativeExamples: GroundedExampleItem[] = [];
    const rubricItems: RubricCriterionItem[] = [];
    const recentHandoffs: CollaborationSlice["recent_handoffs"][number][] = [];

    const buildSummary = (
      rules: readonly CompiledBriefRule[],
      exs: readonly TriggeredExceptionItem[],
      compact = false,
    ): string => {
      if (rules.length === 0 && exs.length === 0) {
        if (compact) return "";
        return progress.historical_complete
          ? `No permitted task-specific collaboration guidance recorded for ${personId} on "${task}".`
          : `Connection-time ingestion in progress for ${personId}; no task-specific guidance available yet for "${task}".`;
      }
      const parts: string[] = [];
      for (const ex of exs.slice(0, compact ? 1 : 2)) {
        parts.push(`[Exception:${ex.area}] ${ex.exception_note}`);
      }
      for (const r of rules.slice(0, compact ? 1 : 4)) {
        parts.push(`[${r.area}] ${r.guidance}`);
      }
      const joined = parts.join(" | ");
      return compact && joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
    };

    const progressPayload = Object.freeze({
      stage: progress.stage,
      historical_complete: progress.historical_complete,
      resume_cursor: progress.resume_cursor,
      high_info_indexed: progress.high_info_indexed,
    });
    const frozenAreas = Object.freeze(areasObj);

    const buildResponseShape = (opts: {
      refreshStatus: "current" | "refreshed" | "unchanged";
      sliceHash: string;
      estimatedTokens: number;
      truncated: boolean;
      summary: string;
      exs: readonly TriggeredExceptionItem[];
      rules: readonly CompiledBriefRule[];
      confs: readonly CollaborationConflictItem[];
      pos: readonly GroundedExampleItem[];
      neg: readonly GroundedExampleItem[];
      rubric: readonly RubricCriterionItem[];
      handoffs: readonly CollaborationSlice["recent_handoffs"][number][];
    }) => ({
      schema: COLLABORATION_SLICE_SCHEMA,
      person_id: personId,
      partition_key: partitionKey,
      task,
      task_kind: taskKind,
      refresh_status: opts.refreshStatus,
      slice_hash: opts.sliceHash,
      sensitivity_ceiling: input.sensitivityCeiling,
      grants_action_authority: false as const,
      budget_tokens: budgetTokens,
      estimated_tokens: opts.estimatedTokens,
      truncated: opts.truncated,
      progress: progressPayload,
      areas: frozenAreas,
      brief: {
        summary: opts.summary,
        active_rules: opts.rules,
        triggered_exceptions: opts.exs,
        conflicts: opts.confs,
        insufficient_areas: insufficientAreas,
      },
      examples: {
        positive: opts.pos,
        negative: opts.neg,
      },
      rubric: opts.rubric,
      recent_handoffs: opts.handoffs,
      host_contract: HOST_CONTRACT,
    });

    const PLACEHOLDER_HASH = "0".repeat(64);
    const measureCandidate = (
      exs: readonly TriggeredExceptionItem[],
      rules: readonly CompiledBriefRule[],
      confs: readonly CollaborationConflictItem[],
      pos: readonly GroundedExampleItem[],
      neg: readonly GroundedExampleItem[],
      rubric: readonly RubricCriterionItem[],
      handoffs: readonly CollaborationSlice["recent_handoffs"][number][],
      compactSummary = false,
    ): number =>
      estimateTokens(
        buildResponseShape({
          refreshStatus: "refreshed",
          sliceHash: PLACEHOLDER_HASH,
          estimatedTokens: budgetTokens,
          truncated: false,
          summary: buildSummary(rules, exs, compactSummary),
          exs,
          rules,
          confs,
          pos,
          neg,
          rubric,
          handoffs,
        }),
      );

    let compactSummary = false;
    let minimalTokens = measureCandidate([], [], [], [], [], [], [], false);
    if (minimalTokens > budgetTokens) {
      const compactMinimal = measureCandidate([], [], [], [], [], [], [], true);
      if (compactMinimal <= budgetTokens) {
        compactSummary = true;
        minimalTokens = compactMinimal;
      } else {
        throw new Error(
          `budget_tokens (${budgetTokens}) is below the minimum required for the mandatory slice envelope (${compactMinimal})`,
        );
      }
    }

    let truncated = compactSummary;
    const packCandidates = <T>(candidates: readonly T[], target: T[]): void => {
      for (const item of candidates) {
        target.push(item);
        const tokens = measureCandidate(
          packedExceptions,
          activeRules,
          packedConflicts,
          positiveExamples,
          negativeExamples,
          rubricItems,
          recentHandoffs,
          compactSummary,
        );
        if (tokens > budgetTokens) {
          target.pop();
          truncated = true;
        }
      }
    };

    packCandidates(candidateExceptions, packedExceptions);
    packCandidates(candidateRules, activeRules);
    packCandidates(candidateRubric, rubricItems);
    packCandidates(candidateConflicts, packedConflicts);
    packCandidates(candidatePositive, positiveExamples);
    packCandidates(candidateNegative, negativeExamples);
    packCandidates(candidateHandoffs, recentHandoffs);

    const summary = buildSummary(activeRules, packedExceptions, compactSummary);

    // Deterministic canonical slice hash from ONLY authorized content (strict noninterference!)
    const hashPayload = {
      schema: COLLABORATION_SLICE_SCHEMA,
      person_id: personId,
      partition_key: partitionKey,
      task,
      task_kind: taskKind,
      sensitivity_ceiling: input.sensitivityCeiling,
      progress: progressPayload,
      areas: frozenAreas,
      brief: {
        summary,
        active_rules: activeRules,
        triggered_exceptions: packedExceptions,
        conflicts: packedConflicts,
        insufficient_areas: insufficientAreas,
      },
      examples: {
        positive: positiveExamples,
        negative: negativeExamples,
      },
      rubric: rubricItems,
      recent_handoffs: recentHandoffs,
    };
    const sliceHash = sha256Hex(JSON.stringify(hashPayload));

    const priorHash =
      input.priorSliceHash !== undefined && input.priorSliceHash.trim().length > 0
        ? input.priorSliceHash.trim()
        : null;
    const refreshStatus: "current" | "refreshed" | "unchanged" =
      priorHash === null
        ? "current"
        : priorHash === sliceHash
          ? "unchanged"
          : "refreshed";

    let finalEstimatedTokens = estimateTokens(
      buildResponseShape({
        refreshStatus,
        sliceHash,
        estimatedTokens: budgetTokens,
        truncated,
        summary,
        exs: packedExceptions,
        rules: activeRules,
        confs: packedConflicts,
        pos: positiveExamples,
        neg: negativeExamples,
        rubric: rubricItems,
        handoffs: recentHandoffs,
      }),
    );
    // Converge exact serialized token count of the complete response (at most 1 digit shift).
    const converged = estimateTokens(
      buildResponseShape({
        refreshStatus,
        sliceHash,
        estimatedTokens: finalEstimatedTokens,
        truncated,
        summary,
        exs: packedExceptions,
        rules: activeRules,
        confs: packedConflicts,
        pos: positiveExamples,
        neg: negativeExamples,
        rubric: rubricItems,
        handoffs: recentHandoffs,
      }),
    );
    finalEstimatedTokens = converged;

    return Object.freeze({
      schema: COLLABORATION_SLICE_SCHEMA,
      person_id: personId,
      partition_key: partitionKey,
      task,
      task_kind: taskKind,
      refresh_status: refreshStatus,
      slice_hash: sliceHash,
      sensitivity_ceiling: input.sensitivityCeiling,
      grants_action_authority: false,
      budget_tokens: budgetTokens,
      estimated_tokens: finalEstimatedTokens,
      truncated,
      progress: progressPayload,
      areas: frozenAreas,
      brief: Object.freeze({
        summary,
        active_rules: Object.freeze(activeRules),
        triggered_exceptions: Object.freeze(packedExceptions),
        conflicts: Object.freeze(packedConflicts),
        insufficient_areas: Object.freeze(insufficientAreas),
      }),
      examples: Object.freeze({
        positive: Object.freeze(positiveExamples),
        negative: Object.freeze(negativeExamples),
      }),
      rubric: Object.freeze(rubricItems),
      recent_handoffs: Object.freeze(recentHandoffs),
      host_contract: HOST_CONTRACT,
    });
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
