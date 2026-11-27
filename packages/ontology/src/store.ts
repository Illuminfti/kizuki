import { constants, Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dedupeStrings,
  isNamespacedSubjectId,
  isOntologySensitivity,
  normalizeAttributes,
  normalizeOntologySensitivity,
  normalizeTermKey,
  termMatchesAllowedSubjects,
  withinOntologySensitivity,
} from "./types";
import type {
  OntologyAttribute,
  OntologyCertification,
  OntologyCertificationAction,
  OntologyCertificationReceipt,
  OntologyMetric,
  OntologyRelation,
  OntologyScopeOptions,
  OntologySensitivity,
  OntologyStatus,
  OntologyTargetKind,
  OntologyTerm,
  OntologyTermFamily,
} from "./types";

export const ONTOLOGY_SCHEMA_VERSION = "1";

export function defaultOntologyDbPath(vaultPath: string): string {
  return join(vaultPath, ".kizuki", "ontology.sqlite");
}

const ONTOLOGY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ontology_terms (
  term_id TEXT PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  domain TEXT NOT NULL,
  description TEXT NOT NULL,
  synonyms_json TEXT NOT NULL,
  subjects_json TEXT NOT NULL DEFAULT '[]',
  attributes_json TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public', 'personal', 'private')),
  evidence_count INTEGER NOT NULL CHECK(evidence_count >= 0),
  certification TEXT NOT NULL CHECK(certification IN ('draft', 'certified')),
  certified_by TEXT,
  certified_at TEXT,
  family_id TEXT,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ontology_terms_domain
  ON ontology_terms(domain);

CREATE INDEX IF NOT EXISTS idx_ontology_terms_family
  ON ontology_terms(family_id);

CREATE INDEX IF NOT EXISTS idx_ontology_terms_cert_sens
  ON ontology_terms(certification, sensitivity);

CREATE TABLE IF NOT EXISTS ontology_term_families (
  family_id TEXT PRIMARY KEY,
  prefix TEXT NOT NULL,
  domain TEXT NOT NULL,
  members_json TEXT NOT NULL,
  twin_count INTEGER NOT NULL CHECK(twin_count >= 0),
  mirrored_edge_count INTEGER NOT NULL CHECK(mirrored_edge_count >= 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ontology_term_families_domain
  ON ontology_term_families(domain, prefix);

CREATE TABLE IF NOT EXISTS ontology_relations (
  relation_id TEXT PRIMARY KEY,
  source_term_id TEXT NOT NULL,
  target_term_id TEXT NOT NULL,
  relation_kind TEXT NOT NULL,
  evidence_count INTEGER NOT NULL CHECK(evidence_count >= 0),
  confidence REAL NOT NULL CHECK(confidence >= 0.0 AND confidence <= 1.0),
  is_default_join INTEGER NOT NULL CHECK(is_default_join IN (0, 1)),
  support_refs_json TEXT NOT NULL,
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public', 'personal', 'private')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ontology_relations_src
  ON ontology_relations(source_term_id);

CREATE INDEX IF NOT EXISTS idx_ontology_relations_dst
  ON ontology_relations(target_term_id);

CREATE INDEX IF NOT EXISTS idx_ontology_relations_pair
  ON ontology_relations(source_term_id, target_term_id, is_default_join DESC);

CREATE TABLE IF NOT EXISTS ontology_metrics (
  metric_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  term_id TEXT,
  description TEXT NOT NULL,
  expression TEXT NOT NULL,
  grain TEXT NOT NULL,
  certification TEXT NOT NULL CHECK(certification IN ('draft', 'certified')),
  sensitivity TEXT NOT NULL CHECK(sensitivity IN ('public', 'personal', 'private')),
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ontology_metrics_term
  ON ontology_metrics(term_id);

CREATE TABLE IF NOT EXISTS ontology_certifications (
  receipt_id TEXT PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('term', 'metric')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('certify', 'uncertify', 'undo')),
  actor TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_ontology_certifications_target
  ON ontology_certifications(target_kind, target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ontology_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

function enforceFileMode0600(filePath: string): void {
  if (filePath === ":memory:" || filePath === "") return;
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    if (existsSync(candidate)) {
      try {
        chmodSync(candidate, 0o600);
      } catch {
        // Best-effort on filesystems that disallow chmod.
      }
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends Record<string, unknown>>(raw: string): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as T;
    }
    return {} as T;
  } catch {
    return {} as T;
  }
}

interface TermRow {
  term_id: string;
  canonical_name: string;
  normalized_key: string;
  kind: string;
  domain: string;
  description: string;
  synonyms_json: string;
  subjects_json?: string | undefined;
  attributes_json: string;
  provenance_json: string;
  sensitivity: string;
  evidence_count: number;
  certification: string;
  certified_by: string | null;
  certified_at: string | null;
  family_id: string | null;
  updated_at: string;
}

interface FamilyRow {
  family_id: string;
  prefix: string;
  domain: string;
  members_json: string;
  twin_count: number;
  mirrored_edge_count: number;
  updated_at: string;
}

interface RelationRow {
  relation_id: string;
  source_term_id: string;
  target_term_id: string;
  relation_kind: string;
  evidence_count: number;
  confidence: number;
  is_default_join: number;
  support_refs_json: string;
  sensitivity: string;
  updated_at: string;
}

interface MetricRow {
  metric_id: string;
  name: string;
  term_id: string | null;
  description: string;
  expression: string;
  grain: string;
  certification: string;
  sensitivity: string;
  updated_at: string;
}

interface CertificationRow {
  receipt_id: string;
  target_kind: string;
  target_id: string;
  action: string;
  actor: string;
  before_json: string;
  after_json: string;
  created_at: string;
}

function rowToTerm(row: TermRow): OntologyTerm {
  return {
    termId: row.term_id,
    canonicalName: row.canonical_name,
    normalizedKey: row.normalized_key,
    kind: row.kind,
    domain: row.domain,
    description: row.description,
    synonyms: parseJsonArray<string>(row.synonyms_json),
    subjects:
      row.subjects_json !== undefined
        ? parseJsonArray<string>(row.subjects_json)
        : [],
    attributes: normalizeAttributes(
      parseJsonArray<string | OntologyAttribute>(row.attributes_json),
    ),
    provenance: parseJsonArray<string>(row.provenance_json),
    sensitivity: normalizeOntologySensitivity(row.sensitivity, "private"),
    evidenceCount: row.evidence_count,
    certification: row.certification === "certified" ? "certified" : "draft",
    certifiedBy: row.certified_by,
    certifiedAt: row.certified_at,
    familyId: row.family_id,
    updatedAt: row.updated_at,
  };
}

function rowToFamily(row: FamilyRow): OntologyTermFamily {
  const rawMembers = parseJsonObject<Record<string, unknown>>(row.members_json);
  const members: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawMembers)) {
    if (typeof v === "string") members[k] = v;
  }
  return {
    familyId: row.family_id,
    prefix: row.prefix,
    domain: row.domain,
    members,
    twinCount: row.twin_count,
    mirroredEdgeCount: row.mirrored_edge_count,
    updatedAt: row.updated_at,
  };
}

function rowToRelation(row: RelationRow): OntologyRelation {
  return {
    relationId: row.relation_id,
    sourceTermId: row.source_term_id,
    targetTermId: row.target_term_id,
    relationKind: row.relation_kind,
    evidenceCount: row.evidence_count,
    confidence: row.confidence,
    isDefaultJoin: row.is_default_join === 1,
    supportRefs: parseJsonArray<string>(row.support_refs_json),
    sensitivity: normalizeOntologySensitivity(row.sensitivity, "private"),
    updatedAt: row.updated_at,
  };
}

function rowToMetric(row: MetricRow): OntologyMetric {
  return {
    metricId: row.metric_id,
    name: row.name,
    termId: row.term_id,
    description: row.description,
    expression: row.expression,
    grain: row.grain,
    certification: row.certification === "certified" ? "certified" : "draft",
    sensitivity: normalizeOntologySensitivity(row.sensitivity, "private"),
    updatedAt: row.updated_at,
  };
}

function rowToCertification(row: CertificationRow): OntologyCertificationReceipt {
  return {
    receiptId: row.receipt_id,
    targetKind: row.target_kind === "metric" ? "metric" : "term",
    targetId: row.target_id,
    action:
      row.action === "undo"
        ? "undo"
        : row.action === "uncertify"
          ? "uncertify"
          : "certify",
    actor: row.actor,
    before: parseJsonObject<Record<string, unknown>>(row.before_json),
    after: parseJsonObject<Record<string, unknown>>(row.after_json),
    createdAt: row.created_at,
  };
}

export interface OpenOntologyStoreOptions {
  readonly busyTimeoutMs?: number | undefined;
}

export interface UpsertTermInput {
  readonly termId?: string | undefined;
  readonly canonicalName: string;
  readonly normalizedKey?: string | undefined;
  readonly kind?: string | undefined;
  readonly domain?: string | undefined;
  readonly description?: string | undefined;
  readonly synonyms?: readonly string[] | undefined;
  readonly subjects?: readonly string[] | undefined;
  readonly attributes?: readonly (string | OntologyAttribute)[] | undefined;
  readonly provenance?: readonly string[] | undefined;
  readonly sensitivity?: OntologySensitivity | undefined;
  readonly evidenceCount?: number | undefined;
  readonly certification?: OntologyCertification | undefined;
  readonly certifiedBy?: string | null | undefined;
  readonly certifiedAt?: string | null | undefined;
  readonly familyId?: string | null | undefined;
  readonly updatedAt?: string | undefined;
}

export interface UpsertTermFamilyInput {
  readonly familyId: string;
  readonly prefix: string;
  readonly domain: string;
  readonly members: Record<string, string>;
  readonly twinCount: number;
  readonly mirroredEdgeCount: number;
  readonly updatedAt?: string | undefined;
}

export interface UpsertRelationInput {
  readonly relationId?: string | undefined;
  readonly sourceTermId: string;
  readonly targetTermId: string;
  readonly relationKind: string;
  readonly evidenceCount?: number | undefined;
  readonly confidence?: number | undefined;
  readonly isDefaultJoin?: boolean | undefined;
  readonly supportRefs?: readonly string[] | undefined;
  readonly sensitivity?: OntologySensitivity | undefined;
  readonly updatedAt?: string | undefined;
}

export interface UpsertMetricInput {
  readonly metricId?: string | undefined;
  readonly name: string;
  readonly termId?: string | null | undefined;
  readonly description: string;
  readonly expression: string;
  readonly grain?: string | undefined;
  readonly certification?: OntologyCertification | undefined;
  readonly sensitivity?: OntologySensitivity | undefined;
  readonly updatedAt?: string | undefined;
}

export interface ListTermsFilter extends OntologyScopeOptions {
  readonly domain?: string | undefined;
  readonly kind?: string | undefined;
  readonly certification?: OntologyCertification | undefined;
  readonly familyId?: string | undefined;
}

export interface ListRelationsFilter extends OntologyScopeOptions {
  readonly sourceTermId?: string | undefined;
  readonly targetTermId?: string | undefined;
  readonly relationKind?: string | undefined;
  readonly defaultJoinsOnly?: boolean | undefined;
}

export interface ListMetricsFilter extends OntologyScopeOptions {
  readonly termId?: string | undefined;
  readonly certification?: OntologyCertification | undefined;
}

export interface CertifyTermInput {
  readonly termId?: string | undefined;
  readonly normalizedKey?: string | undefined;
  readonly actor: string;
  readonly canonicalName?: string | undefined;
  readonly description?: string | undefined;
  readonly synonyms?: readonly string[] | undefined;
  readonly domain?: string | undefined;
  readonly kind?: string | undefined;
  readonly certification?: OntologyCertification | undefined;
  readonly at?: string | undefined;
}

export interface CertifyMetricInput {
  readonly metricId?: string | undefined;
  readonly name?: string | undefined;
  readonly actor: string;
  readonly description?: string | undefined;
  readonly expression?: string | undefined;
  readonly grain?: string | undefined;
  readonly certification?: OntologyCertification | undefined;
  readonly at?: string | undefined;
}

export interface CertifyTermResult {
  readonly term: OntologyTerm;
  readonly receipt: OntologyCertificationReceipt;
}

export interface CertifyMetricResult {
  readonly metric: OntologyMetric;
  readonly receipt: OntologyCertificationReceipt;
}

export interface UndoCertificationResult {
  readonly targetKind: OntologyTargetKind;
  readonly restored: OntologyTerm | OntologyMetric;
  readonly undoReceipt: OntologyCertificationReceipt;
}

function assertValidSensitivity(value: unknown, label: string): OntologySensitivity {
  if (!isOntologySensitivity(value)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value;
}

export class OntologyStore {
  public readonly dbPath: string;
  public readonly db: Database;

  constructor(dbPath: string, options: OpenOntologyStoreOptions = {}) {
    const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
    if (
      !Number.isSafeInteger(busyTimeoutMs) ||
      busyTimeoutMs < 0 ||
      busyTimeoutMs > 60_000
    ) {
      throw new RangeError("busyTimeoutMs must be an integer between 0 and 60000");
    }

    if (dbPath !== ":memory:" && dbPath !== "") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }

    const db = new Database(dbPath);
    try {
      if (process.platform === "darwin" && dbPath !== ":memory:" && dbPath !== "") {
        db.fileControl(constants.SQLITE_FCNTL_PERSIST_WAL, 0);
      }
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec("PRAGMA temp_store = MEMORY");
      db.exec(ONTOLOGY_SCHEMA_SQL);
      const termColumns = new Set(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM pragma_table_info('ontology_terms')",
          )
          .all()
          .map((col) => col.name),
      );
      if (!termColumns.has("subjects_json")) {
        db.exec(
          "ALTER TABLE ontology_terms ADD COLUMN subjects_json TEXT NOT NULL DEFAULT '[]'",
        );
      }
      db.query(
        "INSERT OR IGNORE INTO ontology_meta (key, value) VALUES ('schema_version', ?)",
      ).run(ONTOLOGY_SCHEMA_VERSION);
      enforceFileMode0600(dbPath);
    } catch (error) {
      db.close();
      throw error;
    }

    this.dbPath = dbPath;
    this.db = db;
  }

  public static openInMemory(): OntologyStore {
    return new OntologyStore(":memory:");
  }

  public close(): void {
    this.db.close();
  }

  public transaction<T>(fn: () => T): T {
    const tx = this.db.transaction(fn);
    return tx();
  }

  public getMeta(key: string): string | null {
    const row = this.db
      .query<{ value: string }, [string]>(
        "SELECT value FROM ontology_meta WHERE key = ?",
      )
      .get(key);
    return row?.value ?? null;
  }

  public setMeta(key: string, value: string): void {
    this.db
      .query(
        "INSERT INTO ontology_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  public upsertTerm(input: UpsertTermInput): OntologyTerm {
    const canonicalName = input.canonicalName.trim();
    if (canonicalName.length === 0) {
      throw new Error("canonicalName must not be empty");
    }
    let normalizedKey =
      input.normalizedKey !== undefined && input.normalizedKey.trim().length > 0
        ? normalizeTermKey(input.normalizedKey)
        : normalizeTermKey(canonicalName);
    if (normalizedKey.length === 0) {
      throw new Error(`Unable to derive normalizedKey from "${canonicalName}"`);
    }

    const existingById =
      input.termId !== undefined
        ? this.db
            .query<TermRow, [string]>(
              "SELECT * FROM ontology_terms WHERE term_id = ?",
            )
            .get(input.termId)
        : null;
    let existingByKey = this.db
      .query<TermRow, [string]>(
        "SELECT * FROM ontology_terms WHERE normalized_key = ?",
      )
      .get(normalizedKey);
    const termId =
      input.termId ?? existingByKey?.term_id ?? `term:${normalizedKey}`;
    if (
      input.termId !== undefined &&
      input.normalizedKey === undefined &&
      existingByKey !== null &&
      existingByKey.term_id !== termId
    ) {
      const baseCandidate =
        existingById?.normalized_key ?? normalizeTermKey(termId);
      if (baseCandidate.length > 0 && baseCandidate !== normalizedKey) {
        normalizedKey = baseCandidate;
        existingByKey = this.db
          .query<TermRow, [string]>(
            "SELECT * FROM ontology_terms WHERE normalized_key = ?",
          )
          .get(normalizedKey);
      }
      let suffix = 2;
      while (existingByKey !== null && existingByKey.term_id !== termId) {
        normalizedKey = `${baseCandidate || normalizeTermKey(canonicalName)}_${suffix}`;
        suffix += 1;
        existingByKey = this.db
          .query<TermRow, [string]>(
            "SELECT * FROM ontology_terms WHERE normalized_key = ?",
          )
          .get(normalizedKey);
      }
    }

    const sensitivity =
      input.sensitivity !== undefined
        ? assertValidSensitivity(input.sensitivity, "term sensitivity")
        : "private";
    const certification: OntologyCertification = input.certification ?? "draft";
    const evidenceCount = Math.max(0, Math.floor(input.evidenceCount ?? 0));
    const updatedAt = input.updatedAt ?? nowIso();
    const synonyms = dedupeStrings(input.synonyms);
    const subjects =
      input.subjects !== undefined
        ? dedupeStrings(input.subjects)
        : input.termId !== undefined && isNamespacedSubjectId(input.termId)
          ? [input.termId.trim()]
          : [];
    const attributes = normalizeAttributes(input.attributes);
    const provenance = dedupeStrings(input.provenance);
    const kind = (input.kind ?? "concept").trim() || "concept";
    const domain = (input.domain ?? "general").trim() || "general";
    const description = (input.description ?? "").trim();
    const certifiedBy = input.certifiedBy ?? null;
    const certifiedAt = input.certifiedAt ?? null;
    const familyId = input.familyId ?? null;

    this.db
      .query(
        `INSERT INTO ontology_terms (
          term_id, canonical_name, normalized_key, kind, domain, description,
          synonyms_json, subjects_json, attributes_json, provenance_json, sensitivity,
          evidence_count, certification, certified_by, certified_at, family_id, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(term_id) DO UPDATE SET
          canonical_name = excluded.canonical_name,
          normalized_key = excluded.normalized_key,
          kind = excluded.kind,
          domain = excluded.domain,
          description = excluded.description,
          synonyms_json = excluded.synonyms_json,
          subjects_json = excluded.subjects_json,
          attributes_json = excluded.attributes_json,
          provenance_json = excluded.provenance_json,
          sensitivity = excluded.sensitivity,
          evidence_count = excluded.evidence_count,
          certification = excluded.certification,
          certified_by = excluded.certified_by,
          certified_at = excluded.certified_at,
          family_id = excluded.family_id,
          updated_at = excluded.updated_at`,
      )
      .run(
        termId,
        canonicalName,
        normalizedKey,
        kind,
        domain,
        description,
        JSON.stringify(synonyms),
        JSON.stringify(subjects),
        JSON.stringify(attributes),
        JSON.stringify(provenance),
        sensitivity,
        evidenceCount,
        certification,
        certifiedBy,
        certifiedAt,
        familyId,
        updatedAt,
      );

    const saved = this.getTerm(termId);
    if (saved === null) {
      throw new Error(`Failed to persist ontology term ${termId}`);
    }
    return saved;
  }

  public getTerm(
    termId: string,
    scope?: OntologyScopeOptions,
  ): OntologyTerm | null {
    const row = this.db
      .query<TermRow, [string]>(
        "SELECT * FROM ontology_terms WHERE term_id = ?",
      )
      .get(termId);
    if (row === null) return null;
    const term = rowToTerm(row);
    if (!this.termVisibleUnderScope(term, scope)) return null;
    return term;
  }

  public getTermByKey(
    key: string,
    scope?: OntologyScopeOptions,
  ): OntologyTerm | null {
    const normalizedKey = normalizeTermKey(key);
    if (normalizedKey.length === 0) return null;
    const row = this.db
      .query<TermRow, [string]>(
        "SELECT * FROM ontology_terms WHERE normalized_key = ?",
      )
      .get(normalizedKey);
    if (row === null) return null;
    const term = rowToTerm(row);
    if (!this.termVisibleUnderScope(term, scope)) return null;
    return term;
  }

  public listTerms(filter: ListTermsFilter = {}): OntologyTerm[] {
    if (filter.sensitivityCeiling !== undefined) {
      assertValidSensitivity(filter.sensitivityCeiling, "sensitivityCeiling");
    }
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.domain !== undefined) {
      clauses.push("domain = ?");
      params.push(filter.domain);
    }
    if (filter.kind !== undefined) {
      clauses.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.certification !== undefined) {
      clauses.push("certification = ?");
      params.push(filter.certification);
    }
    if (filter.familyId !== undefined) {
      clauses.push("family_id = ?");
      params.push(filter.familyId);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query<TermRow, string[]>(
        `SELECT * FROM ontology_terms ${whereSql}
         ORDER BY CASE certification WHEN 'certified' THEN 0 ELSE 1 END,
                  evidence_count DESC,
                  normalized_key ASC`,
      )
      .all(...params);
    return rows
      .map(rowToTerm)
      .filter((term) => this.termVisibleUnderScope(term, filter));
  }

  public deleteTerm(termId: string): boolean {
    const result = this.db
      .query("DELETE FROM ontology_terms WHERE term_id = ?")
      .run(termId);
    return result.changes > 0;
  }

  public upsertTermFamily(input: UpsertTermFamilyInput): OntologyTermFamily {
    const updatedAt = input.updatedAt ?? nowIso();
    const sortedMembers: Record<string, string> = {};
    for (const key of Object.keys(input.members).sort()) {
      const value = input.members[key];
      if (value !== undefined) sortedMembers[key] = value;
    }
    this.db
      .query(
        `INSERT INTO ontology_term_families (
          family_id, prefix, domain, members_json, twin_count, mirrored_edge_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(family_id) DO UPDATE SET
          prefix = excluded.prefix,
          domain = excluded.domain,
          members_json = excluded.members_json,
          twin_count = excluded.twin_count,
          mirrored_edge_count = excluded.mirrored_edge_count,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.familyId,
        input.prefix,
        input.domain,
        JSON.stringify(sortedMembers),
        Math.max(0, Math.floor(input.twinCount)),
        Math.max(0, Math.floor(input.mirroredEdgeCount)),
        updatedAt,
      );
    const saved = this.getTermFamily(input.familyId);
    if (saved === null) {
      throw new Error(`Failed to persist term family ${input.familyId}`);
    }
    return saved;
  }

  public getTermFamily(familyId: string): OntologyTermFamily | null {
    const row = this.db
      .query<FamilyRow, [string]>(
        "SELECT * FROM ontology_term_families WHERE family_id = ?",
      )
      .get(familyId);
    return row === null ? null : rowToFamily(row);
  }

  public listTermFamilies(domain?: string): OntologyTermFamily[] {
    const rows =
      domain !== undefined
        ? this.db
            .query<FamilyRow, [string]>(
              "SELECT * FROM ontology_term_families WHERE domain = ? ORDER BY domain ASC, prefix ASC",
            )
            .all(domain)
        : this.db
            .query<FamilyRow, []>(
              "SELECT * FROM ontology_term_families ORDER BY domain ASC, prefix ASC",
            )
            .all();
    return rows.map(rowToFamily);
  }

  public clearTermFamilies(): void {
    this.transaction(() => {
      this.db.exec("UPDATE ontology_terms SET family_id = NULL");
      this.db.exec("DELETE FROM ontology_term_families");
    });
  }

  public upsertRelation(input: UpsertRelationInput): OntologyRelation {
    const relationKind = input.relationKind.trim();
    if (relationKind.length === 0) {
      throw new Error("relationKind must not be empty");
    }
    const relationId =
      input.relationId ??
      `rel:${normalizeTermKey(input.sourceTermId)}:${normalizeTermKey(relationKind)}:${normalizeTermKey(input.targetTermId)}`;
    const sensitivity =
      input.sensitivity !== undefined
        ? assertValidSensitivity(input.sensitivity, "relation sensitivity")
        : "private";
    const evidenceCount = Math.max(0, Math.floor(input.evidenceCount ?? 1));
    const confidence = Math.max(0, Math.min(1, input.confidence ?? 0.5));
    const isDefaultJoin = input.isDefaultJoin === true ? 1 : 0;
    const supportRefs = dedupeStrings(input.supportRefs);
    const updatedAt = input.updatedAt ?? nowIso();

    this.db
      .query(
        `INSERT INTO ontology_relations (
          relation_id, source_term_id, target_term_id, relation_kind,
          evidence_count, confidence, is_default_join, support_refs_json,
          sensitivity, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(relation_id) DO UPDATE SET
          source_term_id = excluded.source_term_id,
          target_term_id = excluded.target_term_id,
          relation_kind = excluded.relation_kind,
          evidence_count = excluded.evidence_count,
          confidence = excluded.confidence,
          is_default_join = excluded.is_default_join,
          support_refs_json = excluded.support_refs_json,
          sensitivity = excluded.sensitivity,
          updated_at = excluded.updated_at`,
      )
      .run(
        relationId,
        input.sourceTermId,
        input.targetTermId,
        relationKind,
        evidenceCount,
        confidence,
        isDefaultJoin,
        JSON.stringify(supportRefs),
        sensitivity,
        updatedAt,
      );

    const saved = this.getRelation(relationId);
    if (saved === null) {
      throw new Error(`Failed to persist ontology relation ${relationId}`);
    }
    return saved;
  }

  public getRelation(
    relationId: string,
    scope?: OntologyScopeOptions,
  ): OntologyRelation | null {
    const row = this.db
      .query<RelationRow, [string]>(
        "SELECT * FROM ontology_relations WHERE relation_id = ?",
      )
      .get(relationId);
    if (row === null) return null;
    const rel = rowToRelation(row);
    if (
      scope?.sensitivityCeiling !== undefined &&
      !withinOntologySensitivity(rel.sensitivity, scope.sensitivityCeiling)
    ) {
      return null;
    }
    return rel;
  }

  public listRelations(filter: ListRelationsFilter = {}): OntologyRelation[] {
    if (filter.sensitivityCeiling !== undefined) {
      assertValidSensitivity(filter.sensitivityCeiling, "sensitivityCeiling");
    }
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.sourceTermId !== undefined) {
      clauses.push("source_term_id = ?");
      params.push(filter.sourceTermId);
    }
    if (filter.targetTermId !== undefined) {
      clauses.push("target_term_id = ?");
      params.push(filter.targetTermId);
    }
    if (filter.relationKind !== undefined) {
      clauses.push("relation_kind = ?");
      params.push(filter.relationKind);
    }
    if (filter.defaultJoinsOnly === true) {
      clauses.push("is_default_join = 1");
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query<RelationRow, (string | number)[]>(
        `SELECT * FROM ontology_relations ${whereSql}
         ORDER BY is_default_join DESC, evidence_count DESC, confidence DESC, relation_id ASC`,
      )
      .all(...params);
    const ceiling = filter.sensitivityCeiling;
    let visibleTermIds: Set<string> | null = null;
    if (ceiling !== undefined || filter.allowedSubjects !== undefined) {
      visibleTermIds = new Set(
        this.listTerms({
          sensitivityCeiling: ceiling,
          allowedSubjects: filter.allowedSubjects,
        }).map((t) => t.termId),
      );
    }

    return rows.map(rowToRelation).filter((rel) => {
      if (ceiling !== undefined && !withinOntologySensitivity(rel.sensitivity, ceiling)) {
        return false;
      }
      if (visibleTermIds !== null) {
        if (!visibleTermIds.has(rel.sourceTermId) || !visibleTermIds.has(rel.targetTermId)) {
          return false;
        }
      }
      return true;
    });
  }

  public deleteRelation(relationId: string): boolean {
    const result = this.db
      .query("DELETE FROM ontology_relations WHERE relation_id = ?")
      .run(relationId);
    return result.changes > 0;
  }

  public upsertMetric(input: UpsertMetricInput): OntologyMetric {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new Error("metric name must not be empty");
    }
    const existingByName = this.db
      .query<MetricRow, [string]>(
        "SELECT * FROM ontology_metrics WHERE name = ?",
      )
      .get(name);
    const metricId =
      input.metricId ?? existingByName?.metric_id ?? `metric:${normalizeTermKey(name)}`;
    const sensitivity =
      input.sensitivity !== undefined
        ? assertValidSensitivity(input.sensitivity, "metric sensitivity")
        : "private";
    const certification: OntologyCertification = input.certification ?? "draft";
    const grain = (input.grain ?? "vault").trim() || "vault";
    const updatedAt = input.updatedAt ?? nowIso();

    this.db
      .query(
        `INSERT INTO ontology_metrics (
          metric_id, name, term_id, description, expression, grain,
          certification, sensitivity, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(metric_id) DO UPDATE SET
          name = excluded.name,
          term_id = excluded.term_id,
          description = excluded.description,
          expression = excluded.expression,
          grain = excluded.grain,
          certification = excluded.certification,
          sensitivity = excluded.sensitivity,
          updated_at = excluded.updated_at`,
      )
      .run(
        metricId,
        name,
        input.termId ?? null,
        input.description.trim(),
        input.expression.trim(),
        grain,
        certification,
        sensitivity,
        updatedAt,
      );

    const saved = this.getMetric(metricId);
    if (saved === null) {
      throw new Error(`Failed to persist ontology metric ${metricId}`);
    }
    return saved;
  }

  public getMetric(
    metricId: string,
    scope?: OntologyScopeOptions,
  ): OntologyMetric | null {
    const row = this.db
      .query<MetricRow, [string]>(
        "SELECT * FROM ontology_metrics WHERE metric_id = ?",
      )
      .get(metricId);
    if (row === null) return null;
    const metric = rowToMetric(row);
    if (
      scope?.sensitivityCeiling !== undefined &&
      !withinOntologySensitivity(metric.sensitivity, scope.sensitivityCeiling)
    ) {
      return null;
    }
    return metric;
  }

  public getMetricByName(
    name: string,
    scope?: OntologyScopeOptions,
  ): OntologyMetric | null {
    const row = this.db
      .query<MetricRow, [string]>(
        "SELECT * FROM ontology_metrics WHERE name = ?",
      )
      .get(name.trim());
    if (row === null) return null;
    const metric = rowToMetric(row);
    if (
      scope?.sensitivityCeiling !== undefined &&
      !withinOntologySensitivity(metric.sensitivity, scope.sensitivityCeiling)
    ) {
      return null;
    }
    return metric;
  }

  public listMetrics(filter: ListMetricsFilter = {}): OntologyMetric[] {
    if (filter.sensitivityCeiling !== undefined) {
      assertValidSensitivity(filter.sensitivityCeiling, "sensitivityCeiling");
    }
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.termId !== undefined) {
      clauses.push("term_id = ?");
      params.push(filter.termId);
    }
    if (filter.certification !== undefined) {
      clauses.push("certification = ?");
      params.push(filter.certification);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .query<MetricRow, string[]>(
        `SELECT * FROM ontology_metrics ${whereSql}
         ORDER BY CASE certification WHEN 'certified' THEN 0 ELSE 1 END, name ASC`,
      )
      .all(...params);

    const ceiling = filter.sensitivityCeiling;
    const allowedSubjects = filter.allowedSubjects;
    let visibleTermIds: Set<string> | null = null;
    if (allowedSubjects !== undefined && allowedSubjects !== null) {
      visibleTermIds = new Set(
        this.listTerms({
          sensitivityCeiling: ceiling,
          allowedSubjects,
        }).map((t) => t.termId),
      );
    }

    return rows.map(rowToMetric).filter((metric) => {
      if (ceiling !== undefined && !withinOntologySensitivity(metric.sensitivity, ceiling)) {
        return false;
      }
      if (visibleTermIds !== null) {
        if (metric.termId !== null) {
          return visibleTermIds.has(metric.termId);
        }
        // Global metrics without a bound term are visible only if at least one
        // subject was allowed (empty allowedSubjects is fail-closed).
        return allowedSubjects !== null && allowedSubjects !== undefined && allowedSubjects.length > 0;
      }
      return true;
    });
  }

  public deleteMetric(metricId: string): boolean {
    const result = this.db
      .query("DELETE FROM ontology_metrics WHERE metric_id = ?")
      .run(metricId);
    return result.changes > 0;
  }

  public certifyTerm(input: CertifyTermInput): CertifyTermResult {
    const actor = input.actor.trim();
    if (actor.length === 0) {
      throw new Error("actor must not be empty");
    }
    const at = input.at ?? nowIso();
    return this.transaction(() => {
      const before =
        input.termId !== undefined
          ? this.getTerm(input.termId)
          : input.normalizedKey !== undefined
            ? this.getTermByKey(input.normalizedKey)
            : null;
      if (before === null) {
        throw new Error(
          `Term not found for certification: ${input.termId ?? input.normalizedKey ?? "(missing id)"}`,
        );
      }

      const nextCert: OntologyCertification = input.certification ?? "certified";
      const action: OntologyCertificationAction =
        nextCert === "certified" ? "certify" : "uncertify";
      const nextCanonical =
        input.canonicalName !== undefined && input.canonicalName.trim().length > 0
          ? input.canonicalName.trim()
          : before.canonicalName;
      const nextDescription =
        input.description !== undefined
          ? input.description.trim()
          : before.description;
      const nextSynonyms =
        input.synonyms !== undefined
          ? dedupeStrings(input.synonyms)
          : before.synonyms;
      const nextDomain =
        input.domain !== undefined && input.domain.trim().length > 0
          ? input.domain.trim()
          : before.domain;
      const nextKind =
        input.kind !== undefined && input.kind.trim().length > 0
          ? input.kind.trim()
          : before.kind;

      const updated = this.upsertTerm({
        termId: before.termId,
        canonicalName: nextCanonical,
        normalizedKey: before.normalizedKey,
        kind: nextKind,
        domain: nextDomain,
        description: nextDescription,
        synonyms: nextSynonyms,
        subjects: before.subjects,
        attributes: before.attributes,
        provenance: before.provenance,
        sensitivity: before.sensitivity,
        evidenceCount: before.evidenceCount,
        certification: nextCert,
        certifiedBy: nextCert === "certified" ? actor : null,
        certifiedAt: nextCert === "certified" ? at : null,
        familyId: before.familyId,
        updatedAt: at,
      });

      const receipt = this.insertCertificationReceipt(
        "term",
        before.termId,
        action,
        actor,
        before as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
        at,
      );
      return { term: updated, receipt };
    });
  }

  public certifyMetric(input: CertifyMetricInput): CertifyMetricResult {
    const actor = input.actor.trim();
    if (actor.length === 0) {
      throw new Error("actor must not be empty");
    }
    const at = input.at ?? nowIso();
    return this.transaction(() => {
      const before =
        input.metricId !== undefined
          ? this.getMetric(input.metricId)
          : input.name !== undefined
            ? this.getMetricByName(input.name)
            : null;
      if (before === null) {
        throw new Error(
          `Metric not found for certification: ${input.metricId ?? input.name ?? "(missing id)"}`,
        );
      }

      const nextCert: OntologyCertification = input.certification ?? "certified";
      const action: OntologyCertificationAction =
        nextCert === "certified" ? "certify" : "uncertify";

      const updated = this.upsertMetric({
        metricId: before.metricId,
        name: before.name,
        termId: before.termId,
        description:
          input.description !== undefined
            ? input.description.trim()
            : before.description,
        expression:
          input.expression !== undefined
            ? input.expression.trim()
            : before.expression,
        grain:
          input.grain !== undefined && input.grain.trim().length > 0
            ? input.grain.trim()
            : before.grain,
        certification: nextCert,
        sensitivity: before.sensitivity,
        updatedAt: at,
      });

      const receipt = this.insertCertificationReceipt(
        "metric",
        before.metricId,
        action,
        actor,
        before as unknown as Record<string, unknown>,
        updated as unknown as Record<string, unknown>,
        at,
      );
      return { metric: updated, receipt };
    });
  }

  public undoCertification(
    receiptId: string,
    actor = "owner",
  ): UndoCertificationResult {
    const at = nowIso();
    return this.transaction(() => {
      const row = this.db
        .query<CertificationRow, [string]>(
          "SELECT * FROM ontology_certifications WHERE receipt_id = ?",
        )
        .get(receiptId);
      if (row === null) {
        throw new Error(`Certification receipt not found: ${receiptId}`);
      }
      const receipt = rowToCertification(row);

      if (receipt.targetKind === "term") {
        const current = this.getTerm(receipt.targetId);
        const snap = receipt.before as unknown as OntologyTerm;
        const restored = this.upsertTerm({
          termId: snap.termId,
          canonicalName: snap.canonicalName,
          normalizedKey: snap.normalizedKey,
          kind: snap.kind,
          domain: snap.domain,
          description: snap.description,
          synonyms: snap.synonyms,
          subjects: Array.isArray(snap.subjects) ? snap.subjects : [],
          attributes: snap.attributes,
          provenance: snap.provenance,
          sensitivity: snap.sensitivity,
          evidenceCount: snap.evidenceCount,
          certification: snap.certification,
          certifiedBy: snap.certifiedBy,
          certifiedAt: snap.certifiedAt,
          familyId: snap.familyId,
          updatedAt: at,
        });
        const undoReceipt = this.insertCertificationReceipt(
          "term",
          restored.termId,
          "undo",
          actor,
          (current ?? {}) as Record<string, unknown>,
          restored as unknown as Record<string, unknown>,
          at,
        );
        return { targetKind: "term", restored, undoReceipt };
      }

      const current = this.getMetric(receipt.targetId);
      const snap = receipt.before as unknown as OntologyMetric;
      const restored = this.upsertMetric({
        metricId: snap.metricId,
        name: snap.name,
        termId: snap.termId,
        description: snap.description,
        expression: snap.expression,
        grain: snap.grain,
        certification: snap.certification,
        sensitivity: snap.sensitivity,
        updatedAt: at,
      });
      const undoReceipt = this.insertCertificationReceipt(
        "metric",
        restored.metricId,
        "undo",
        actor,
        (current ?? {}) as Record<string, unknown>,
        restored as unknown as Record<string, unknown>,
        at,
      );
      return { targetKind: "metric", restored, undoReceipt };
    });
  }

  public listCertifications(targetId?: string): OntologyCertificationReceipt[] {
    const rows =
      targetId !== undefined
        ? this.db
            .query<CertificationRow, [string]>(
              "SELECT * FROM ontology_certifications WHERE target_id = ? ORDER BY created_at DESC, receipt_id DESC",
            )
            .all(targetId)
        : this.db
            .query<CertificationRow, []>(
              "SELECT * FROM ontology_certifications ORDER BY created_at DESC, receipt_id DESC",
            )
            .all();
    return rows.map(rowToCertification);
  }

  public getStatus(scope?: OntologyScopeOptions): OntologyStatus {
    const terms = this.listTerms(scope);
    const relations = this.listRelations(scope);
    const metrics = this.listMetrics(scope);
    const families = this.listTermFamilies();
    const certRow = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM ontology_certifications",
      )
      .get();

    const certifiedTermCount = terms.filter(
      (t) => t.certification === "certified",
    ).length;
    const certifiedMetricCount = metrics.filter(
      (m) => m.certification === "certified",
    ).length;
    const defaultJoinCount = relations.filter((r) => r.isDefaultJoin).length;

    return {
      dbPath: this.dbPath,
      termCount: terms.length,
      certifiedTermCount,
      draftTermCount: terms.length - certifiedTermCount,
      familyCount: families.length,
      relationCount: relations.length,
      defaultJoinCount,
      metricCount: metrics.length,
      certifiedMetricCount,
      certificationReceiptCount: certRow?.count ?? 0,
      lastCompiledAt: this.getMeta("last_compiled_at"),
      schemaVersion: this.getMeta("schema_version") ?? ONTOLOGY_SCHEMA_VERSION,
    };
  }

  private termVisibleUnderScope(
    term: OntologyTerm,
    scope?: OntologyScopeOptions,
  ): boolean {
    if (scope?.sensitivityCeiling !== undefined) {
      if (!withinOntologySensitivity(term.sensitivity, scope.sensitivityCeiling)) {
        return false;
      }
    }
    if (!termMatchesAllowedSubjects(term, scope?.allowedSubjects)) {
      return false;
    }
    return true;
  }

  private insertCertificationReceipt(
    targetKind: OntologyTargetKind,
    targetId: string,
    action: OntologyCertificationAction,
    actor: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    createdAt: string,
  ): OntologyCertificationReceipt {
    const receiptId = `cert_${randomUUID()}`;
    this.db
      .query(
        `INSERT INTO ontology_certifications (
          receipt_id, target_kind, target_id, action, actor, before_json, after_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receiptId,
        targetKind,
        targetId,
        action,
        actor,
        JSON.stringify(before),
        JSON.stringify(after),
        createdAt,
      );
    return {
      receiptId,
      targetKind,
      targetId,
      action,
      actor,
      before,
      after,
      createdAt,
    };
  }
}

export function openOntologyStore(
  dbPath: string,
  options?: OpenOntologyStoreOptions,
): OntologyStore {
  return new OntologyStore(dbPath, options);
}
