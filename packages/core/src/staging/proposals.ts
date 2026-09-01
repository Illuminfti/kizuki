import { Database } from "bun:sqlite";
import { PROPOSAL_KINDS, isProducer } from "../contracts/proposal";
import type { Producer, ProposalKind } from "../contracts/proposal";
import { ulid } from "../util/ulid";

/**
 * Staging is the holding pen between the ledger and canon. A row here is a
 * candidate page, never canon: only `promote` writes the vault, and only the
 * owner may invoke it.
 */

export const STAGING_STATUSES = [
  "pending",
  "promoted",
  "rejected",
  "withdrawn",
] as const;
export type StagingStatus = (typeof STAGING_STATUSES)[number];

export type FrontmatterScalar = string | number | boolean;
export type FrontmatterValue = FrontmatterScalar | FrontmatterScalar[];

export interface ProposalInput {
  kind: ProposalKind;
  /** Canon page this targets; null means "mint a new page at promote time". */
  target?: string | null;
  body: string;
  frontmatter: Record<string, FrontmatterValue>;
  provenance: string[]; // event_ids; never empty
  subjects?: string[];
  producer: Producer;
  confidence: number; // 0..1
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
  /** The identical candidate is already staged; the existing row is returned. */
  | { outcome: "duplicate"; proposal: StagedProposal }
  /** The owner rejected this exact body before; refiling it is not allowed. */
  | { outcome: "suppressed"; body_hash: string; reason: string };

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  proposal_id TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  target      TEXT,
  body        TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  provenance  TEXT NOT NULL,
  subjects    TEXT NOT NULL,
  producer    TEXT NOT NULL,
  confidence  REAL NOT NULL,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  body_hash   TEXT NOT NULL
) STRICT;

-- SQLite cannot express an expression in a table-level UNIQUE clause, so the
-- (kind, target, body_hash) idempotency key lives in this index instead. The
-- coalesce keeps NULL targets colliding with each other, which plain SQL NULL
-- semantics would not do.
CREATE UNIQUE INDEX IF NOT EXISTS proposals_idempotency
  ON proposals (kind, coalesce(target, ''), body_hash);

CREATE INDEX IF NOT EXISTS proposals_by_status
  ON proposals (status, created_at);

CREATE TABLE IF NOT EXISTS rejections (
  body_hash   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  proposal_id TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (body_hash, proposal_id)
) STRICT;

CREATE TABLE IF NOT EXISTS promotions (
  receipt_id  TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL UNIQUE,
  provenance  TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  page_path   TEXT NOT NULL,
  page_hash   TEXT NOT NULL,
  at          TEXT NOT NULL
) STRICT;
`;

export function initStaging(db: Database): void {
  db.exec(SCHEMA);
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
      'producer: must be "deterministic", "llm", or "agent:<id>"',
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

/**
 * Idempotent file. Refiling identical content is a duplicate, not an error, so
 * a connector replay cannot flood the review queue; refiling content the owner
 * already rejected is suppressed, so no producer can nag by repetition.
 */
export function fileProposal(
  db: Database,
  input: ProposalInput,
): FileProposalResult {
  validateInput(input);

  const bodyHash = hashBody(input.body);
  const target = input.target ?? null;
  const targetKey = target ?? "";

  const file = db.transaction((): FileProposalResult => {
    const rejection = db
      .query("SELECT reason FROM rejections WHERE body_hash = ? LIMIT 1")
      .get(bodyHash) as { reason: string } | null;
    if (rejection !== null) {
      return {
        outcome: "suppressed",
        body_hash: bodyHash,
        reason: rejection.reason,
      };
    }

    const existing = db
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
      provenance: [...input.provenance],
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

/**
 * A rejection is durable: the body hash is remembered so the same content is
 * suppressed on every later filing, whichever producer sends it.
 */
export function setProposalStatus(
  db: Database,
  proposalId: string,
  status: StagingStatus,
  reason?: string,
): StagedProposal {
  if (!(STAGING_STATUSES as readonly string[]).includes(status)) {
    throw new StagingError(
      `status: must be one of ${STAGING_STATUSES.join(" | ")}`,
    );
  }
  if (status === "rejected" && (reason === undefined || reason.length === 0)) {
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
    if (status === "rejected") {
      db.query(
        `INSERT INTO rejections (body_hash, reason, proposal_id, at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (body_hash, proposal_id) DO UPDATE SET reason = excluded.reason`,
      ).run(existing.body_hash, reason as string, proposalId, nowRfc3339());
    }
    return { ...existing, status };
  });

  return apply();
}

export function isSuppressed(db: Database, bodyHash: string): boolean {
  const row = db
    .query("SELECT 1 AS hit FROM rejections WHERE body_hash = ? LIMIT 1")
    .get(bodyHash) as { hit: number } | null;
  return row !== null;
}
