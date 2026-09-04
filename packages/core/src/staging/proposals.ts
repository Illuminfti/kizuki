import { Database } from "bun:sqlite";
import { initClaims } from "../claims/schema";
import { canonicalizeProducer, isProducer, PROPOSAL_KINDS } from "../contracts/proposal";
import type {
  FrontmatterValue,
  Producer,
  ProposalKind,
} from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
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

function parseJsonObject(raw: string): Record<string, FrontmatterValue> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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

function rowToProposal(row: ProposalRow): StagedProposal {
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
  if (!Array.isArray(input.provenance) || input.provenance.length === 0) {
    throw new StagingError("provenance: must name at least one event_id");
  }
  if (
    !input.provenance.every((id) => typeof id === "string" && id.length > 0)
  ) {
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
    if (input.target.length === 0) {
      throw new StagingError("target: must be null or a non-empty string");
    }
  }
}

function compatStatusToClaim(status: StagingStatus): string {
  switch (status) {
    case "promoted":
      return "live";
    case "rejected":
      return "superseded";
    case "withdrawn":
      return "skipped";
    default:
      return "skipped";
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
             'connector_evidence', 'private', 'quoted', NULL, ?, NULL, ?,
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
    proposal.created_at,
    proposal.created_at,
    status === "withdrawn" ? proposal.created_at : null,
    proposal.created_at,
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

/**
 * Idempotent file. Refiling identical content is a duplicate, not an error.
 * Owner rejection no longer poisons a body hash (RFC 0002 §18.2).
 */
export function fileProposal(
  db: Database,
  input: ProposalInput,
): FileProposalResult {
  validateInput(input);
  initStaging(db);

  const bodyHash = hashBody(input.body);
  const target = input.target ?? null;
  const targetKey = target ?? "";
  const provenance = input.kind === "purge_review"
    ? [...new Set(input.provenance)].sort()
    : [...input.provenance];

  const file = db.transaction((): FileProposalResult => {
    const existing = input.kind === "purge_review"
      ? db
          .query(
            `SELECT * FROM proposals
              WHERE kind = ? AND coalesce(target, '') = ? AND body_hash = ?
                AND provenance = ? AND status = 'pending'`,
          )
          .get(input.kind, targetKey, bodyHash, JSON.stringify(provenance)) as ProposalRow | null
      : db
          .query(
            "SELECT * FROM proposals WHERE kind = ? AND coalesce(target, '') = ? AND body_hash = ?",
          )
          .get(input.kind, targetKey, bodyHash) as ProposalRow | null;
    if (existing !== null) {
      return { outcome: "duplicate", proposal: rowToProposal(existing) };
    }

    const proposal: StagedProposal = {
      proposal_id: ulid(),
      kind: input.kind,
      target,
      body: input.body,
      frontmatter: input.frontmatter,
      provenance,
      subjects: [...(input.subjects ?? [])],
      producer: input.producer,
      confidence: input.confidence,
      status: "pending",
      created_at: nowRfc3339(),
      body_hash: bodyHash,
    };

    db.query(
      `INSERT INTO proposals
         (proposal_id, kind, target, body, frontmatter, provenance, subjects,
          producer, confidence, status, created_at, body_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  return row === null ? null : rowToProposal(row);
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
  return rows.map(rowToProposal);
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
  if (status === "rejected" && (_reason === undefined || _reason.length === 0)) {
    throw new StagingError("reason: rejection requires a reason");
  }

  const apply = db.transaction((): StagedProposal => {
    const existing = getProposal(db, proposalId);
    if (existing === null) {
      throw new StagingError(`proposal ${proposalId} does not exist`);
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
