import { Database } from "bun:sqlite";
import type { Sensitivity } from "../agents/types";
import { contentSignature } from "../claims/hash";
import { initClaims } from "../claims/schema";
import {
  canonicalizeProducer,
  isAuthorityTier,
  isProducer,
  PROPOSAL_KINDS,
} from "../contracts/proposal";
import type {
  AuthorityTier,
  ClaimTaint,
  FrontmatterValue,
  Producer,
  ProposalKind,
} from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { requireExternalEvents } from "../ledger/event-origin";
import { requiresSourceTombstoneBinding, requireSourceTombstoneProposal } from "../canon/source-tombstone";
import type { SourceTombstoneContext } from "../canon/source-tombstone";
import { labelClaimSensitivity } from "../sensitivity/store";
import { stricter } from "../sensitivity/resolve";
import { cloneExactJson, isNonEmptyString, isPlainObject } from "../util/validate";
import { ulid } from "../util/ulid";

/**
 * Compatibility seam over the claims table (RFC 0002 §4.3). New callers
 * should use `insertClaim`. Identical content still dedupes; there is no
 * owner review queue and no rejection-suppression poison.
 */

export const STAGING_STATUSES = [
  "pending",
  "promoted",
  "rejected",
  "withdrawn",
] as const;
export type StagingStatus = (typeof STAGING_STATUSES)[number];

export type { FrontmatterScalar, FrontmatterValue } from "../contracts/proposal";

const MAX_BODY_CHARS = 64_000;
const MAX_TARGET_CHARS = 256;
const MAX_FRONTMATTER_KEYS = 64;
const MAX_SUBJECTS = 64;
const MAX_SUBJECT_CHARS = 256;
const MAX_PROVENANCE = 64;
const FRONTMATTER_OWNED = new Set(["type", "title"]);

export interface ProposalInput {
  kind: ProposalKind;
  /** Canon page this targets; null means the writer arbitrates. */
  target?: string | null;
  body: string;
  frontmatter: Record<string, FrontmatterValue>;
  provenance: string[];
  subjects?: string[];
  producer: Producer;
  confidence: number;
  sensitivity?: Sensitivity;
  taint?: ClaimTaint;
  authority?: AuthorityTier;
}

export interface StagedProposal {
  proposal_id: string;
  kind: ProposalKind;
  target: string | null;
  body: string;
  frontmatter: Record<string, FrontmatterValue>;
  provenance: string[];
  subjects: string[];
  producer: Producer;
  confidence: number;
  status: StagingStatus;
  created_at: string;
  body_hash: string;
  content_hash: string;
  sensitivity: Sensitivity;
  taint: ClaimTaint;
  authority: AuthorityTier;
}

export type FileProposalResult =
  | { outcome: "stored"; proposal: StagedProposal }
  | { outcome: "duplicate"; proposal: StagedProposal };

export class StagingError extends Error {
  override name = "StagingError";
}

interface ProposalRow {
  proposal_id: string;
  kind: string;
  target: string | null;
  body: string;
  frontmatter: string;
  provenance: string;
  subjects: string;
  producer: string;
  confidence: number;
  status: string;
  created_at: string;
  body_hash: string;
  content_hash: string;
}

export function initStaging(db: Database): void {
  initClaims(db);
}

export function openStagingDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  initStaging(db);
  return db;
}

export function hashBody(body: string): string {
  return new Bun.CryptoHasher("sha256").update(body).digest("hex");
}

function nowRfc3339(): string {
  return new Date().toISOString();
}

function isFrontmatterValue(value: unknown): value is FrontmatterValue {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean",
    )
  );
}

function parseJsonObject(raw: string): Record<string, FrontmatterValue> {
  const parsed: unknown = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new StagingError("frontmatter: stored value is not an object");
  }
  return parsed as Record<string, FrontmatterValue>;
}

function parseStringArray(raw: string, field: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
    throw new StagingError(`${field}: stored value is not a string array`);
  }
  return parsed;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function claimLabels(
  db: Database,
  proposalId: string,
): {
  sensitivity: Sensitivity;
  taint: ClaimTaint;
  authority: AuthorityTier;
} {
  const defaults = {
    sensitivity: "private" as const,
    taint: "quoted" as const,
    authority: "connector_evidence" as const,
  };
  if (!tableExists(db, "claims")) return defaults;
  const row = db
    .query<
      { sensitivity: string | null; taint: string; authority: string },
      [string]
    >(
      "SELECT sensitivity, taint, authority FROM claims WHERE claim_id = ?",
    )
    .get(proposalId);
  if (row === null) return defaults;
  return {
    sensitivity: (row.sensitivity ?? "private") as Sensitivity,
    taint: row.taint === "clean" ? "clean" : "quoted",
    authority: isAuthorityTier(row.authority)
      ? row.authority
      : "connector_evidence",
  };
}

function rowToProposal(db: Database, row: ProposalRow): StagedProposal {
  return {
    proposal_id: row.proposal_id,
    kind: row.kind as ProposalKind,
    target: row.target,
    body: row.body,
    frontmatter: parseJsonObject(row.frontmatter),
    provenance: parseStringArray(row.provenance, "provenance"),
    subjects: parseStringArray(row.subjects, "subjects"),
    producer: row.producer as Producer,
    confidence: row.confidence,
    status: row.status as StagingStatus,
    created_at: row.created_at,
    body_hash: row.body_hash,
    content_hash: row.content_hash,
    ...claimLabels(db, row.proposal_id),
  };
}

function validateInput(input: ProposalInput): void {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(input.kind)) {
    throw new StagingError(
      `kind: must be one of ${PROPOSAL_KINDS.join(" | ")}`,
    );
  }
  if (typeof input.body !== "string") {
    throw new StagingError("body: must be a string");
  }
  if (input.body.length > MAX_BODY_CHARS) {
    throw new StagingError(`body: must be at most ${MAX_BODY_CHARS} characters`);
  }
  if (!Array.isArray(input.provenance) || input.provenance.length === 0) {
    throw new StagingError("provenance: must name at least one event_id");
  }
  if (input.provenance.length > MAX_PROVENANCE) {
    throw new StagingError(
      `provenance: must name at most ${MAX_PROVENANCE} event_ids`,
    );
  }
  if (!input.provenance.every(isNonEmptyString)) {
    throw new StagingError(
      "provenance: every entry must be a non-empty string",
    );
  }
  if (!isProducer(input.producer)) {
    throw new StagingError(
      'producer: must be "deterministic", "llm", "model", "owner", or "agent:<id>"',
    );
  }
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new StagingError("confidence: must be a number in [0, 1]");
  }
  if (input.target !== undefined && input.target !== null) {
    if (typeof input.target !== "string" || input.target.length === 0) {
      throw new StagingError("target: must be null or a non-empty string");
    }
    if (input.target.length > MAX_TARGET_CHARS) {
      throw new StagingError(
        `target: must be at most ${MAX_TARGET_CHARS} characters`,
      );
    }
  }
  if (!isPlainObject(input.frontmatter)) {
    throw new StagingError("frontmatter: must be a plain object");
  }
  const keys = Object.keys(input.frontmatter);
  if (keys.length > MAX_FRONTMATTER_KEYS) {
    throw new StagingError(
      `frontmatter: must have at most ${MAX_FRONTMATTER_KEYS} keys`,
    );
  }
  for (const key of keys) {
    if (!FRONTMATTER_OWNED.has(key) && !key.startsWith("x-")) {
      throw new StagingError(
        `frontmatter: ${key} is unknown; extensions must start with "x-"`,
      );
    }
    if (!isFrontmatterValue(input.frontmatter[key])) {
      throw new StagingError(
        "frontmatter: values must be scalars or scalar arrays",
      );
    }
  }
  const subjects = input.subjects ?? [];
  if (!Array.isArray(subjects) || !subjects.every((item) => typeof item === "string")) {
    throw new StagingError("subjects: must be a string array");
  }
  if (subjects.length > MAX_SUBJECTS) {
    throw new StagingError(`subjects: must name at most ${MAX_SUBJECTS} ids`);
  }
  if (!subjects.every((id) => isNonEmptyString(id) && id.length <= MAX_SUBJECT_CHARS)) {
    throw new StagingError(
      `subjects: every entry must be a non-empty string of at most ${MAX_SUBJECT_CHARS} characters`,
    );
  }
  if (input.taint !== undefined && input.taint !== "clean" && input.taint !== "quoted") {
    throw new StagingError('taint: must be "clean" or "quoted"');
  }
  if (input.authority !== undefined && !isAuthorityTier(input.authority)) {
    throw new StagingError("authority: must be a known authority tier");
  }
}

function resolveProvenance(db: Database, ids: readonly string[]): void {
  if (!tableExists(db, "events")) {
    throw new StagingError("provenance: events table is missing");
  }
  const unique = uniqueStrings(ids);
  const placeholders = unique.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT count(*) AS n FROM events WHERE event_id IN (${placeholders})`,
    )
    .get(...unique);
  if (row === null || row.n !== unique.length) {
    throw new StagingError(
      "provenance: one or more event_ids do not resolve in the ledger",
    );
  }
}

function loadEventFacts(
  db: Database,
  ids: readonly string[],
): { connector_ids: string[]; hints: unknown[] } {
  const unique = uniqueStrings(ids);
  const placeholders = unique.map(() => "?").join(", ");
  const rows = db
    .query<
      { connector_id: string; sensitivity_hint: string | null },
      string[]
    >(
      `SELECT connector_id, sensitivity_hint FROM events WHERE event_id IN (${placeholders})`,
    )
    .all(...unique);
  return {
    connector_ids: [...new Set(rows.map((row) => row.connector_id))],
    hints: rows.map((row) => row.sensitivity_hint),
  };
}

function resolveLabels(
  db: Database,
  input: ProposalInput,
  provenance: readonly string[],
): {
  sensitivity: Sensitivity;
  taint: ClaimTaint;
  authority: AuthorityTier;
} {
  const facts = loadEventFacts(db, provenance);
  const sensitivity = labelClaimSensitivity(db, {
    connector_ids: facts.connector_ids,
    event_hints: facts.hints,
    ...(input.sensitivity === undefined
      ? {}
      : { model_label: input.sensitivity }),
  }).sensitivity;
  return {
    sensitivity,
    taint: input.taint ?? "quoted",
    authority: input.authority ?? "connector_evidence",
  };
}

function signatureOf(
  input: Pick<
    StagedProposal,
    | "kind"
    | "target"
    | "body"
    | "frontmatter"
    | "subjects"
    | "producer"
    | "confidence"
    | "sensitivity"
    | "taint"
    | "authority"
  >,
): string {
  return contentSignature({
    kind: input.kind,
    target: input.target,
    body: input.body,
    frontmatter: input.frontmatter,
    subjects: input.subjects,
    producer: canonicalizeProducer(input.producer),
    confidence: input.confidence,
    sensitivity: input.sensitivity,
    taint: input.taint,
    authority: input.authority,
  });
}

function compatStatusToClaim(status: StagingStatus): string {
  switch (status) {
    case "pending":
      // A filed claim is live. There is no review queue and no pending
      // holding pen: the receipted writer acts on live rows (RFC 0002 §4.3).
      return "live";
    case "promoted":
      return "live";
    case "rejected":
      return "superseded";
    case "withdrawn":
      return "skipped";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function insertCompatClaim(
  db: Database,
  proposal: StagedProposal,
  status: StagingStatus,
): void {
  if (!tableExists(db, "claims")) return;
  const subject = proposal.subjects[0] ?? null;
  const producer = canonicalizeProducer(proposal.producer);
  db.query(
    `INSERT OR IGNORE INTO claims
       (claim_id, kind, target, body, frontmatter, provenance, subjects,
        producer, confidence, status, created_at, body_hash,
        subject, predicate, object, polarity, claim_key, authority,
        sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
        retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'positive', NULL,
             ?, ?, ?, NULL, ?, NULL, ?,
             ?, NULL, NULL, 1, ?)`,
  ).run(
    proposal.proposal_id,
    proposal.kind,
    proposal.target,
    proposal.body,
    JSON.stringify(proposal.frontmatter),
    JSON.stringify(proposal.provenance),
    JSON.stringify(proposal.subjects),
    producer,
    proposal.confidence,
    compatStatusToClaim(status),
    proposal.created_at,
    proposal.body_hash,
    subject,
    proposal.authority,
    proposal.sensitivity,
    proposal.taint,
    proposal.created_at,
    proposal.created_at,
    status === "withdrawn" ? proposal.created_at : null,
    proposal.created_at,
  );
}

function corroborateCompatClaim(
  db: Database,
  proposal: StagedProposal,
  provenance: readonly string[],
  at: string,
): void {
  if (!tableExists(db, "claims")) return;
  const live = db
    .query<
      { claim_id: string; provenance: string; corroboration: number; sensitivity: string | null },
      [string]
    >(
      `SELECT claim_id, provenance, corroboration, sensitivity
         FROM claims WHERE claim_id = ? AND status = 'live'`,
    )
    .get(proposal.proposal_id);
  if (live === null) return;
  const current = parseStringArray(live.provenance, "provenance");
  const merged = uniqueStrings([...current, ...provenance]);
  const sensitivity = stricter(
    (live.sensitivity ?? "private") as Sensitivity,
    proposal.sensitivity,
  );
  db.query(
    `UPDATE claims
        SET provenance = ?, corroboration = ?, last_confirmed_at = ?, sensitivity = ?
      WHERE claim_id = ?`,
  ).run(
    JSON.stringify(merged),
    live.corroboration + 1,
    at,
    sensitivity,
    live.claim_id,
  );
}

function updateCompatClaim(
  db: Database,
  proposalId: string,
  status: StagingStatus,
): void {
  if (!tableExists(db, "claims")) return;
  const retracted = status === "withdrawn" || status === "rejected"
    ? nowRfc3339()
    : null;
  db.query(
    "UPDATE claims SET status = ?, retracted_at = ? WHERE claim_id = ?",
  ).run(compatStatusToClaim(status), retracted, proposalId);
}

export { isSourceTombstoneProposal } from "../canon/source-tombstone";

/**
 * Idempotent file. Semantic fields form the content signature. A later
 * sighting with new provenance corroborates the live row. A withdrawn or
 * rejected historical row does not block improved evidence.
 */
export function fileProposal(
  db: Database,
  input: ProposalInput,
  context?: SourceTombstoneContext,
): FileProposalResult {
  const errors: string[] = [];
  const snapshot = cloneExactJson(input, "proposal", {
    maxDepth: 32, maxKeysPerObject: 512, maxArrayLength: 4096,
    maxStringBytes: 4_194_304, maxKeyBytes: 2048, maxTotalBytes: 8_388_608,
  }, errors);
  if (snapshot === undefined || snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new StagingError("proposal: bounded exact JSON data is required");
  }
  input = snapshot as unknown as ProposalInput;
  validateInput(input);
  initStaging(db);

  const bodyHash = hashBody(input.body);
  const target = input.target ?? null;
  const provenance = input.kind === "purge_review"
    ? [...new Set(input.provenance)].sort()
    : uniqueStrings(input.provenance);
  resolveProvenance(db, provenance);
  const subjects = [...(input.subjects ?? [])];
  const labels = resolveLabels(db, input, provenance);
  const contentHash = signatureOf({
    kind: input.kind,
    target,
    body: input.body,
    frontmatter: input.frontmatter,
    subjects,
    producer: input.producer,
    confidence: input.confidence,
    ...labels,
  });

  const file = db.transaction((): FileProposalResult => {
    const sourceDeletion = requiresSourceTombstoneBinding(db, input);
    if (sourceDeletion) requireSourceTombstoneProposal(db, input, context);
    else requireExternalEvents(db, provenance);
    const existing = db
      .query(
        `SELECT * FROM proposals
          WHERE content_hash = ? AND status = 'pending'`,
      )
      .get(contentHash) as ProposalRow | null;
    if (existing !== null) {
      const current = rowToProposal(db, existing);
      if (sourceDeletion) requireSourceTombstoneProposal(db, current, context);
      const merged = uniqueStrings([...current.provenance, ...provenance]);
      if (merged.length === current.provenance.length) {
        return { outcome: "duplicate", proposal: current };
      }
      const at = nowRfc3339();
      db.query(
        "UPDATE proposals SET provenance = ? WHERE proposal_id = ?",
      ).run(JSON.stringify(merged), current.proposal_id);
      const updated: StagedProposal = { ...current, provenance: merged };
      corroborateCompatClaim(db, updated, provenance, at);
      return { outcome: "duplicate", proposal: rowToProposal(db, {
        ...existing,
        provenance: JSON.stringify(merged),
      }) };
    }

    const proposal: StagedProposal = {
      proposal_id: ulid(),
      kind: input.kind,
      target,
      body: input.body,
      frontmatter: input.frontmatter,
      provenance,
      subjects,
      producer: input.producer,
      confidence: input.confidence,
      status: "pending",
      created_at: nowRfc3339(),
      body_hash: bodyHash,
      content_hash: contentHash,
      ...labels,
    };

    db.query(
      `INSERT INTO proposals
         (proposal_id, kind, target, body, frontmatter, provenance, subjects,
          producer, confidence, status, created_at, body_hash, content_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      proposal.proposal_id,
      proposal.kind,
      proposal.target,
      proposal.body,
      JSON.stringify(proposal.frontmatter),
      JSON.stringify(proposal.provenance),
      JSON.stringify(proposal.subjects),
      proposal.producer,
      proposal.confidence,
      proposal.status,
      proposal.created_at,
      proposal.body_hash,
      proposal.content_hash,
    );
    insertCompatClaim(db, proposal, "pending");

    return { outcome: "stored", proposal };
  });

  return file();
}

export function getProposal(
  db: Database,
  proposalId: string,
): StagedProposal | null {
  const row = db
    .query("SELECT * FROM proposals WHERE proposal_id = ?")
    .get(proposalId) as ProposalRow | null;
  return row === null ? null : rowToProposal(db, row);
}

export interface ListProposalsOptions {
  status?: StagingStatus;
  kind?: ProposalKind;
  limit?: number;
}

export function listProposals(
  db: Database,
  opts: ListProposalsOptions = {},
): StagedProposal[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status !== undefined) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.kind !== undefined) {
    clauses.push("kind = ?");
    params.push(opts.kind);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  const rows = db
    .query(
      `SELECT * FROM proposals${where} ORDER BY created_at, proposal_id LIMIT ?`,
    )
    .all(...params, limit) as ProposalRow[];
  return rows.map((row) => rowToProposal(db, row));
}

export function setProposalStatus(
  db: Database,
  proposalId: string,
  status: StagingStatus,
  _reason?: string,
): StagedProposal {
  if (!(STAGING_STATUSES as readonly string[]).includes(status)) {
    throw new StagingError(
      `status: must be one of ${STAGING_STATUSES.join(" | ")}`,
    );
  }
  if (status !== "withdrawn") {
    throw new StagingError(
      "status: legacy writes only withdraw pending rows; claim transitions are receipt-driven",
    );
  }

  const apply = db.transaction((): StagedProposal => {
    const existing = getProposal(db, proposalId);
    if (existing === null) {
      throw new StagingError(`proposal ${proposalId} does not exist`);
    }
    if (existing.status !== "pending") {
      throw new StagingError(
        `status: cannot withdraw a ${existing.status} proposal`,
      );
    }
    db.query("UPDATE proposals SET status = ? WHERE proposal_id = ?").run(
      status,
      proposalId,
    );
    updateCompatClaim(db, proposalId, status);
    return { ...existing, status };
  });

  return apply();
}
