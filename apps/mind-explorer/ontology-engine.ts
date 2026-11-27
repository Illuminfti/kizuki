// Local Compiled Semantic Ontology Engine (NVIDIA auto-ontology primitives + Ossie YAML)
// Compiles Kizuki vault canon pages, entities, codex, taste domains, and people into a local
// rebuildable SQLite ontology at <vault>/.kizuki/explorer-ontology.sqlite with sub-5ms queries,
// sticky owner certifications, shortest semantic join paths, pre-flight answerability checks,
// secret redaction, and Ossie YAML/JSON export.

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

export type OntologyTermKind =
  | "entity"
  | "concept"
  | "person"
  | "project"
  | "organization"
  | "codex"
  | "taste_domain"
  | "metric"
  | "family"
  | "fact";

export interface ProvenanceRef {
  path: string;
  source: string;
  page_id?: string;
}

export interface OntologyTerm {
  id: string;
  canonical_name: string;
  kind: OntologyTermKind;
  family_id: string;
  family_name: string;
  description: string;
  synonyms: string[];
  attributes: string[];
  provenance: ProvenanceRef[];
  support_count: number;
  certified: boolean;
  certified_at: string | null;
  certified_by: string | null;
  certification_receipt: string | null;
  certification_note: string | null;
}

export interface OntologyRelation {
  id: string;
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  predicate: string;
  confirmed: boolean;
  support_count: number;
  confidence: number;
  evidence_path: string | null;
}

export interface OntologyFamilySummary {
  id: string;
  name: string;
  description: string;
  synonyms: string[];
  term_count: number;
  certified_count: number;
}

export interface OntologyMetric {
  id: string;
  name: string;
  family_id: string;
  unit: string;
  value: number;
  definition: string;
  source: string;
}

export interface OntologyStatus {
  ok: boolean;
  ready: boolean;
  db_file: string;
  compiled_at: string | null;
  compile_ms: number;
  source_counts: {
    vault_db_pages: number;
    vault_db_edges: number;
    vault_db_claims: number;
    vault_people: number;
    codex_items: number;
    taste_domains: number;
    markdown_files: number;
  };
  stats: {
    terms: number;
    certified: number;
    families: number;
    relations: number;
    confirmed_relations: number;
    metrics: number;
  };
  families: OntologyFamilySummary[];
  metrics: OntologyMetric[];
}

export interface JoinPathStep {
  from_id: string;
  from_name: string;
  to_id: string;
  to_name: string;
  predicate: string;
  confirmed: boolean;
  support_count: number;
}

export interface JoinPathResult {
  found: boolean;
  from: { id: string; canonical_name: string } | null;
  to: { id: string; canonical_name: string } | null;
  hops: number;
  nodes: Array<{ id: string; canonical_name: string; kind: OntologyTermKind; certified: boolean }>;
  edges: JoinPathStep[];
  path_label: string;
  latency_ms: number;
}

export interface AnswerableMatch {
  id: string;
  canonical_name: string;
  kind: OntologyTermKind;
  family_id: string;
  family_name: string;
  certified: boolean;
  matched_phrase: string;
  match_type: "exact" | "synonym" | "family" | "token";
  support_count: number;
}

export interface AnswerableGap {
  phrase: string;
  reason: string;
}

export interface AnswerableResult {
  question: string;
  verdict: "answerable" | "partial" | "unanswerable";
  coverage_pct: number;
  matched_terms: AnswerableMatch[];
  missing_terms: AnswerableGap[];
  join_paths: JoinPathResult[];
  primary_join_path: string | null;
  recommended_families: Array<{ id: string; name: string; term_count: number }>;
  latency_ms: number;
}

export interface TermDetailResult {
  term: OntologyTerm;
  relations: OntologyRelation[];
  join_paths: JoinPathResult[];
}

export interface CertifyTermInput {
  id: string;
  certified?: boolean;
  description?: string;
  synonyms?: string[];
  family_id?: string;
  note?: string;
  certified_by?: string;
}

export interface CertifyTermResult {
  ok: boolean;
  term: OntologyTerm;
  receipt: {
    term_id: string;
    certified: boolean;
    certified_at: string;
    certified_by: string;
    receipt_hash: string;
    sticky: true;
  };
}

export interface ExternalCodexSeed {
  id: string;
  title: string;
  section?: string;
  domain?: string;
  summary?: string;
  thesis?: string;
  tags?: string[];
  linked_people?: string[];
}

export interface ExternalTasteSeed {
  id: string;
  name: string;
  description?: string;
  rule_count?: number;
  rules?: Array<{ id: string; title: string; summary?: string }>;
}

export interface OntologyEngineOptions {
  vaultPath?: string;
  dbPath?: string;
  maxVaultPages?: number;
  getCodexItems?: () => ExternalCodexSeed[];
  getTasteDomains?: () => ExternalTasteSeed[];
}

interface FamilyDef {
  id: string;
  name: string;
  description: string;
  synonyms: string[];
}

const CORE_FAMILIES: readonly FamilyDef[] = [
  {
    id: "family:world-model",
    name: "World Model & Commitments",
    description:
      "World model architecture, open commitments, obligations, forecasts, observations, and grounded canon state.",
    synonyms: [
      "world model",
      "world-model",
      "commitments",
      "commitment",
      "open commitments",
      "obligations",
      "open threads",
      "world consolidation",
      "canon",
      "observations",
      "forecasts",
      "promises",
    ],
  },
  {
    id: "family:projects-systems",
    name: "Projects & Systems",
    description:
      "Active engineering projects, repositories, tools, harnesses, pipelines, and local infrastructure.",
    synonyms: [
      "projects",
      "project",
      "systems",
      "system",
      "infrastructure",
      "pipelines",
      "repos",
      "repositories",
      "workstreams",
      "architecture",
    ],
  },
  {
    id: "family:people-network",
    name: "People & Relationships",
    description:
      "Collaborators, contacts, counterparties, meeting participants, and relationship dossiers.",
    synonyms: [
      "people",
      "person",
      "contacts",
      "collaborators",
      "relationships",
      "network",
      "team",
      "dossiers",
    ],
  },
  {
    id: "family:organizations",
    name: "Organizations & Partners",
    description:
      "Companies, protocols, funds, ecosystems, and partner organizations tracked in canon.",
    synonyms: [
      "organizations",
      "organization",
      "companies",
      "company",
      "partners",
      "partner",
      "orgs",
      "protocols",
      "vendors",
    ],
  },
  {
    id: "family:knowledge-concepts",
    name: "Knowledge & Concepts",
    description:
      "Reusable mental models, technical concepts, design principles, research notes, and synthesis.",
    synonyms: [
      "knowledge",
      "concepts",
      "concept",
      "principles",
      "patterns",
      "research",
      "topics",
      "notes",
      "ontology",
      "semantics",
    ],
  },
  {
    id: "family:codex-rules",
    name: "Codex & Operating Rules",
    description:
      "Owner principles, operating rubrics, decision policies, philosophies, ideas, and active playbooks.",
    synonyms: [
      "codex",
      "operating rules",
      "rules",
      "decisions",
      "decision",
      "policies",
      "philosophies",
      "ideas",
      "anchors",
      "owner anchors",
    ],
  },
  {
    id: "family:taste-craft",
    name: "Taste & Craft Domains",
    description:
      "Aesthetic standards, UI/UX craft guidelines, visual direction, typography, and quality floors.",
    synonyms: [
      "taste",
      "craft",
      "design",
      "aesthetic",
      "aesthetics",
      "ui",
      "ux",
      "visual",
      "motion",
      "brand",
      "typography",
    ],
  },
  {
    id: "family:metrics-telemetry",
    name: "Metrics & Telemetry",
    description:
      "Deterministic quantitative counts and vault coverage indicators compiled from ground truth.",
    synonyms: [
      "metrics",
      "metric",
      "telemetry",
      "stats",
      "counts",
      "coverage",
      "health",
      "kpi",
      "kpis",
    ],
  },
] as const;

const FAMILY_BY_ID = new Map<string, FamilyDef>(CORE_FAMILIES.map((f) => [f.id, f]));

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{14,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{20,}\b/gi,
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key|password|passwd|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._/+=-]{10,}["']?/gi,
];

const SENSITIVE_PATH_RE =
  /(?:^|[/\\])(?:\.env(?:\.[^/\\]+)?|agent-credentials|credentials(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|private[-_]?key|id_rsa|id_ed25519|serve\.token|git-credentials)(?:$|[/\\])/i;

const QUESTION_STOPWORDS = new Set<string>([
  "a",
  "about",
  "all",
  "am",
  "an",
  "and",
  "any",
  "are",
  "as",
  "at",
  "be",
  "been",
  "being",
  "between",
  "by",
  "can",
  "could",
  "current",
  "currently",
  "did",
  "do",
  "does",
  "doing",
  "explain",
  "find",
  "for",
  "from",
  "get",
  "give",
  "had",
  "has",
  "have",
  "having",
  "here",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "list",
  "many",
  "me",
  "more",
  "most",
  "much",
  "my",
  "need",
  "of",
  "on",
  "open",
  "or",
  "our",
  "ours",
  "out",
  "over",
  "please",
  "recent",
  "related",
  "show",
  "should",
  "some",
  "tell",
  "than",
  "that",
  "the",
  "their",
  "them",
  "there",
  "these",
  "they",
  "this",
  "those",
  "to",
  "today",
  "top",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
]);

const GENERIC_CONNECTORS = new Set<string>([
  "status",
  "summary",
  "overview",
  "active",
  "latest",
  "main",
  "key",
]);

export function stripEmDashes(input: string): string {
  return String(input || "")
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2014/g, "-");
}

export function redactSecrets(input: string): string {
  let out = stripEmDashes(input);
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

export function isSensitivePath(relPath: string): boolean {
  return SENSITIVE_PATH_RE.test(relPath || "");
}

function normalizePhrase(input: string): string {
  return stripEmDashes(input)
    .toLowerCase()
    .replace(/[`'"()[\]{}<>.,;:!?/\\|]+/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(input: string): string {
  const clean = normalizePhrase(input)
    .replace(/[^a-z0-9\s]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return clean.slice(0, 72) || "term";
}

function tokenize(input: string): string[] {
  const norm = normalizePhrase(input);
  if (!norm) return [];
  return norm.split(" ").filter((t) => t.length >= 2);
}

function stemToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && token.endsWith("es") && /(?:sh|ch|x|z|s)es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

function cleanDescription(raw: string, maxLen = 280): string {
  const redacted = redactSecrets(raw || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^---[\s\S]*?---/m, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b || a)
    .replace(/[#*_>`]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length <= maxLen) return redacted;
  return redacted.slice(0, maxLen - 3).trimEnd() + "...";
}

function uniqueStrings(list: string[], max = 24): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const clean = redactSecrets(item || "").trim();
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function classifyFamilyAndKind(
  relPath: string,
  pageType: string,
  title: string
): { familyId: string; kind: OntologyTermKind } {
  const p = (relPath || "").toLowerCase();
  const t = (title || "").toLowerCase();
  const pt = (pageType || "").toLowerCase();

  if (p.includes("/people/") || p.startsWith("world/people/") || pt === "person") {
    return { familyId: "family:people-network", kind: "person" };
  }
  if (p.includes("/companies/") || pt === "org" || pt === "organization") {
    return { familyId: "family:organizations", kind: "organization" };
  }
  if (p.includes("/taste/") || p.includes("taste-") || t.includes("taste")) {
    return { familyId: "family:taste-craft", kind: "taste_domain" };
  }
  if (
    p.includes("codex") ||
    p.includes("owner-anchors") ||
    p.includes("decisions") ||
    t.includes("decision") ||
    t.includes("rubric")
  ) {
    return { familyId: "family:codex-rules", kind: "codex" };
  }
  if (
    p.includes("world-model") ||
    p.includes("world_model") ||
    p.includes("auto-canon") ||
    p.startsWith("world/") ||
    p === "canon.md" ||
    p === "schema.md" ||
    t.includes("world model") ||
    t.includes("world-model") ||
    t.includes("commitment") ||
    t.includes("canon")
  ) {
    return { familyId: "family:world-model", kind: "concept" };
  }
  if (
    pt === "project" ||
    p.includes("/04-work/") ||
    p.includes("/06-execution/") ||
    p.includes("project")
  ) {
    return { familyId: "family:projects-systems", kind: "project" };
  }
  if (p.includes("/05-knowledge/") || pt === "topic") {
    return { familyId: "family:knowledge-concepts", kind: "concept" };
  }
  if (pt === "fact" || p.includes("/facts/")) {
    return { familyId: "family:world-model", kind: "fact" };
  }
  return { familyId: "family:knowledge-concepts", kind: "entity" };
}

function escapeYamlScalar(val: string): string {
  const safe = redactSecrets(val);
  if (!safe) return '""';
  if (/[\n\r":#{}[\],&*?|<>=!%@`\\]|^\s|\s$|^(?:true|false|null|yes|no|on|off|~|\d)/i.test(safe)) {
    return JSON.stringify(safe);
  }
  return safe;
}

interface CertRow {
  term_id: string;
  certified: number;
  custom_description: string | null;
  custom_synonyms: string | null;
  custom_family_id: string | null;
  note: string | null;
  certified_by: string;
  certified_at: string;
  receipt_hash: string;
}

interface CompiledTermDraft {
  id: string;
  canonical_name: string;
  kind: OntologyTermKind;
  family_id: string;
  description: string;
  synonyms: Set<string>;
  attributes: Set<string>;
  provenance: ProvenanceRef[];
  support_count: number;
}

interface CompiledRelationDraft {
  id: string;
  from_id: string;
  to_id: string;
  predicate: string;
  confirmed: boolean;
  support_count: number;
  confidence: number;
  evidence_path: string | null;
}

export class KizukiOntologyEngine {
  readonly vaultPath: string;
  readonly dbPath: string;
  private readonly maxVaultPages: number;
  private readonly getCodexItems?: () => ExternalCodexSeed[];
  private readonly getTasteDomains?: () => ExternalTasteSeed[];

  private db: Database;
  private termsById = new Map<string, OntologyTerm>();
  private phraseToTermIds = new Map<string, Set<string>>();
  private tokenToTermIds = new Map<string, Set<string>>();
  private adjacency = new Map<string, OntologyRelation[]>();
  private allRelations: OntologyRelation[] = [];
  private allMetrics: OntologyMetric[] = [];
  private familiesSummary: OntologyFamilySummary[] = [];
  private lastCompiledAt: string | null = null;
  private lastCompileMs = 0;
  private lastSourceCounts: OntologyStatus["source_counts"] = {
    vault_db_pages: 0,
    vault_db_edges: 0,
    vault_db_claims: 0,
    vault_people: 0,
    codex_items: 0,
    taste_domains: 0,
    markdown_files: 0,
  };
  private warmed = false;

  constructor(opts: OntologyEngineOptions = {}) {
    this.vaultPath = resolve(opts.vaultPath || process.env.KIZUKI_VAULT || join(homedir(), "Kizuki"));
    this.dbPath = resolve(opts.dbPath || join(this.vaultPath, ".kizuki", "explorer-ontology.sqlite"));
    this.maxVaultPages = Math.max(200, opts.maxVaultPages ?? 3500);
    this.getCodexItems = opts.getCodexItems;
    this.getTasteDomains = opts.getTasteDomains;

    const dbDir = resolve(this.dbPath, "..");
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true, mode: 0o700 });
    }
    const existed = existsSync(this.dbPath);
    this.db = new Database(this.dbPath);
    if (!existed) {
      try {
        chmodSync(this.dbPath, 0o600);
      } catch {
        // ignore chmod failures on restricted filesystems
      }
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS term_families (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        synonyms_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terms (
        id TEXT PRIMARY KEY,
        canonical_name TEXT NOT NULL,
        kind TEXT NOT NULL,
        family_id TEXT NOT NULL,
        family_name TEXT NOT NULL,
        description TEXT NOT NULL,
        synonyms_json TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        support_count INTEGER NOT NULL DEFAULT 1,
        certified INTEGER NOT NULL DEFAULT 0,
        certified_at TEXT,
        certified_by TEXT,
        certification_receipt TEXT,
        certification_note TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_terms_family ON terms(family_id);
      CREATE INDEX IF NOT EXISTS idx_terms_kind ON terms(kind);
      CREATE INDEX IF NOT EXISTS idx_terms_cert ON terms(certified);
      CREATE INDEX IF NOT EXISTS idx_terms_name ON terms(canonical_name COLLATE NOCASE);

      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        predicate TEXT NOT NULL,
        confirmed INTEGER NOT NULL DEFAULT 1,
        support_count INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 0.85,
        evidence_path TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_rel_from ON relations(from_id);
      CREATE INDEX IF NOT EXISTS idx_rel_to ON relations(to_id);

      CREATE TABLE IF NOT EXISTS metrics (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        family_id TEXT NOT NULL,
        unit TEXT NOT NULL,
        value REAL NOT NULL,
        definition TEXT NOT NULL,
        source TEXT NOT NULL
      );

      -- Sticky owner certification receipts: preserved across every rebuildable recompile.
      CREATE TABLE IF NOT EXISTS certifications (
        term_id TEXT PRIMARY KEY,
        certified INTEGER NOT NULL DEFAULT 1,
        custom_description TEXT,
        custom_synonyms TEXT,
        custom_family_id TEXT,
        note TEXT,
        certified_by TEXT NOT NULL,
        certified_at TEXT NOT NULL,
        receipt_hash TEXT NOT NULL
      );
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  ensureReady(): void {
    if (this.warmed && this.termsById.size > 0) return;
    const countRow = this.db.query("SELECT COUNT(*) AS n FROM terms").get() as { n: number } | null;
    if (countRow && countRow.n > 0) {
      this.loadIntoMemory();
      return;
    }
    this.compile();
  }

  compile(): OntologyStatus {
    const t0 = performance.now();
    const compiledAt = new Date().toISOString();

    const termsMap = new Map<string, CompiledTermDraft>();
    const relationsMap = new Map<string, CompiledRelationDraft>();
    const pageIdToTermId = new Map<string, string>();
    const nameKeyToTermId = new Map<string, string>();

    const sourceCounts: OntologyStatus["source_counts"] = {
      vault_db_pages: 0,
      vault_db_edges: 0,
      vault_db_claims: 0,
      vault_people: 0,
      codex_items: 0,
      taste_domains: 0,
      markdown_files: 0,
    };

    const upsertTerm = (input: {
      id: string;
      canonical_name: string;
      kind: OntologyTermKind;
      family_id: string;
      description?: string;
      synonyms?: string[];
      attributes?: string[];
      provenance?: ProvenanceRef[];
      support_count?: number;
    }): CompiledTermDraft => {
      const famId = FAMILY_BY_ID.has(input.family_id)
        ? input.family_id
        : "family:knowledge-concepts";
      const safeName = redactSecrets(input.canonical_name || input.id).trim();
      const existing = termsMap.get(input.id);
      if (existing) {
        if (input.description && input.description.length > existing.description.length) {
          existing.description = cleanDescription(input.description);
        }
        if (input.synonyms) {
          for (const s of input.synonyms) {
            const clean = redactSecrets(s).trim();
            if (clean && clean.length <= 80) existing.synonyms.add(clean);
          }
        }
        if (input.attributes) {
          for (const a of input.attributes) {
            const clean = redactSecrets(a).trim();
            if (clean) existing.attributes.add(clean);
          }
        }
        if (input.provenance) {
          for (const p of input.provenance) {
            if (!isSensitivePath(p.path) && existing.provenance.length < 10) {
              if (!existing.provenance.some((e) => e.path === p.path)) {
                existing.provenance.push(p);
              }
            }
          }
        }
        existing.support_count += input.support_count ?? 1;
        return existing;
      }

      const syns = new Set<string>();
      for (const s of input.synonyms || []) {
        const clean = redactSecrets(s).trim();
        if (clean && clean.length <= 80 && clean.toLowerCase() !== safeName.toLowerCase()) {
          syns.add(clean);
        }
      }
      const attrs = new Set<string>();
      for (const a of input.attributes || []) {
        const clean = redactSecrets(a).trim();
        if (clean) attrs.add(clean);
      }
      const provs: ProvenanceRef[] = [];
      for (const p of input.provenance || []) {
        if (!isSensitivePath(p.path)) provs.push(p);
      }

      const draft: CompiledTermDraft = {
        id: input.id,
        canonical_name: safeName,
        kind: input.kind,
        family_id: famId,
        description: cleanDescription(input.description || `${safeName} in the compiled vault ontology.`),
        synonyms: syns,
        attributes: attrs,
        provenance: provs,
        support_count: Math.max(1, input.support_count ?? 1),
      };
      termsMap.set(draft.id, draft);
      const nk = normalizePhrase(safeName);
      if (nk && !nameKeyToTermId.has(nk)) {
        nameKeyToTermId.set(nk, draft.id);
      }
      return draft;
    };

    const addRelation = (input: {
      from_id: string;
      to_id: string;
      predicate: string;
      confirmed?: boolean;
      support_count?: number;
      confidence?: number;
      evidence_path?: string | null;
    }): void => {
      if (!input.from_id || !input.to_id || input.from_id === input.to_id) return;
      if (!termsMap.has(input.from_id) || !termsMap.has(input.to_id)) return;
      const pred = slugify(input.predicate || "related_to").replace(/-/g, "_");
      const id = `${input.from_id}|${pred}|${input.to_id}`;
      const existing = relationsMap.get(id);
      if (existing) {
        existing.support_count += input.support_count ?? 1;
        existing.confirmed = existing.confirmed || (input.confirmed ?? true);
        existing.confidence = Math.max(existing.confidence, input.confidence ?? 0.85);
        return;
      }
      relationsMap.set(id, {
        id,
        from_id: input.from_id,
        to_id: input.to_id,
        predicate: pred,
        confirmed: input.confirmed ?? true,
        support_count: Math.max(1, input.support_count ?? 1),
        confidence: Math.max(0.1, Math.min(1, input.confidence ?? 0.85)),
        evidence_path:
          input.evidence_path && !isSensitivePath(input.evidence_path) ? input.evidence_path : null,
      });
    };

    // 1. Seed canonical Term Family root nodes so multi-hop join paths always bridge cleanly
    for (const fam of CORE_FAMILIES) {
      upsertTerm({
        id: fam.id,
        canonical_name: fam.name,
        kind: "family",
        family_id: fam.id,
        description: fam.description,
        synonyms: fam.synonyms,
        attributes: ["term_family", "root_concept"],
        support_count: 2,
      });
    }

    // Seed core vault semantic anchor terms (generic, personal-name-free)
    upsertTerm({
      id: "concept:kizuki-vault",
      canonical_name: "Kizuki Vault",
      kind: "project",
      family_id: "family:world-model",
      description:
        "Local personal knowledge vault storing canon pages, world consolidation observations, entity dossiers, and MemT experiences.",
      synonyms: ["kizuki", "vault", "knowledge vault", "personal vault", "mind explorer", "mind os"],
      attributes: ["local_first", "sqlite_backed", "canon_store"],
      provenance: existsSync(join(this.vaultPath, "CANON.md"))
        ? [{ path: "CANON.md", source: "vault_canon" }]
        : [],
      support_count: 5,
    });
    upsertTerm({
      id: "concept:world-model",
      canonical_name: "World Model",
      kind: "concept",
      family_id: "family:world-model",
      description:
        "Grounded representation of entities, live claims, observations, and temporal state compiled from vault evidence.",
      synonyms: [
        "world model",
        "world-model",
        "world state",
        "world consolidation",
        "kizuki world model",
      ],
      attributes: ["evidence_backed", "temporal_claims"],
      support_count: 5,
    });
    upsertTerm({
      id: "concept:open-commitments",
      canonical_name: "Open Commitments",
      kind: "concept",
      family_id: "family:world-model",
      description:
        "Tracked promises, open action threads, decisions, and pending obligations across people and projects.",
      synonyms: [
        "commitments",
        "commitment",
        "open commitments",
        "obligations",
        "open threads",
        "promises",
        "actions",
      ],
      attributes: ["trackable", "actionable"],
      support_count: 4,
    });
    addRelation({
      from_id: "concept:kizuki-vault",
      to_id: "concept:world-model",
      predicate: "maintains",
      confirmed: true,
      support_count: 5,
      confidence: 0.96,
      evidence_path: "CANON.md",
    });
    addRelation({
      from_id: "concept:world-model",
      to_id: "concept:open-commitments",
      predicate: "tracks",
      confirmed: true,
      support_count: 4,
      confidence: 0.94,
      evidence_path: "SCHEMA.md",
    });
    addRelation({
      from_id: "concept:kizuki-vault",
      to_id: "family:world-model",
      predicate: "belongs_to_family",
      confirmed: true,
      support_count: 4,
      confidence: 0.98,
    });

    // 2. Compile from live Kizuki SQLite database (<vault>/.kizuki/kizuki.db) when present
    let totalClaimsLive = 0;
    let totalWorldObservations = 0;
    let totalDbPages = 0;
    const kizukiDbPath = join(this.vaultPath, ".kizuki", "kizuki.db");
    if (existsSync(kizukiDbPath)) {
      let srcDb: Database | null = null;
      try {
        srcDb = new Database(kizukiDbPath, { readonly: true });

        const tableRows = srcDb
          .query("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as Array<{ name: string }>;
        const tables = new Set(tableRows.map((r) => r.name));

        if (tables.has("claims")) {
          const row = srcDb
            .query("SELECT COUNT(*) AS n FROM claims WHERE status = 'live'")
            .get() as { n: number } | null;
          totalClaimsLive = row?.n ?? 0;
          sourceCounts.vault_db_claims = totalClaimsLive;
        }
        if (tables.has("world_observations")) {
          const row = srcDb
            .query("SELECT COUNT(*) AS n FROM world_observations")
            .get() as { n: number } | null;
          totalWorldObservations = row?.n ?? 0;
        }

        // Gather wikilink degree per page to prioritize richest semantic entities/concepts/projects
        const degreeMap = new Map<string, number>();
        let wikilinkEdges: Array<{ src: string; dst: string; kind: string }> = [];
        if (tables.has("graph_edges")) {
          wikilinkEdges = srcDb
            .query(
              "SELECT src, dst, kind FROM graph_edges WHERE kind = 'wikilink' LIMIT 12000"
            )
            .all() as Array<{ src: string; dst: string; kind: string }>;
          for (const e of wikilinkEdges) {
            degreeMap.set(e.src, (degreeMap.get(e.src) || 0) + 1);
            degreeMap.set(e.dst, (degreeMap.get(e.dst) || 0) + 1);
          }
        }

        // Load canon pages from graph_pages joined with search_documents (skip noisy raw capture dumps)
        if (tables.has("graph_pages")) {
          const cnt = srcDb
            .query("SELECT COUNT(*) AS n FROM graph_pages WHERE active = 1")
            .get() as { n: number } | null;
          totalDbPages = cnt?.n ?? 0;

          const hasSearchDocs = tables.has("search_documents");
          const pageRows = (
            hasSearchDocs
              ? srcDb
                  .query(
                    `SELECT gp.page_id, gp.rel_path, gp.title, sd.page_type, substr(sd.body, 1, 420) AS snippet
                     FROM graph_pages gp
                     LEFT JOIN search_documents sd ON sd.doc_id = ('page:' || gp.page_id)
                     WHERE gp.active = 1
                       AND gp.rel_path NOT LIKE 'auto/captures/%'
                       AND gp.rel_path NOT LIKE 'auto/kizuki.%'
                     LIMIT ?`
                  )
                  .all(this.maxVaultPages * 2)
              : srcDb
                  .query(
                    `SELECT page_id, rel_path, title, 'topic' AS page_type, '' AS snippet
                     FROM graph_pages
                     WHERE active = 1
                       AND rel_path NOT LIKE 'auto/captures/%'
                     LIMIT ?`
                  )
                  .all(this.maxVaultPages * 2)
          ) as Array<{
            page_id: string;
            rel_path: string;
            title: string | null;
            page_type: string | null;
            snippet: string | null;
          }>;

          // Score and select top semantic pages so compile stays fast and high-signal
          const scored = pageRows
            .filter((r) => !isSensitivePath(r.rel_path))
            .map((r) => {
              const deg = degreeMap.get(r.page_id) || 0;
              const p = r.rel_path.toLowerCase();
              let prio = deg * 4;
              if (p.startsWith("auto/entities/03-entities/")) prio += 30;
              else if (p.startsWith("auto/entities/04-work/")) prio += 28;
              else if (p.startsWith("auto/entities/05-knowledge/")) prio += 26;
              else if (p.startsWith("auto/entities/06-execution/")) prio += 24;
              else if (p.startsWith("auto/entities/")) prio += 22;
              else if (p.startsWith("world/") || p.startsWith("entities/")) prio += 32;
              else if (p.startsWith("dashboards/")) prio += 8;
              if (r.page_type === "org" || r.page_type === "project") prio += 12;
              return { row: r, deg, prio };
            })
            .sort((a, b) => b.prio - a.prio)
            .slice(0, this.maxVaultPages);

          for (const { row, deg } of scored) {
            const rawTitle = (row.title || basename(row.rel_path, ".md")).trim();
            if (!rawTitle || rawTitle.length < 2) continue;
            const { familyId, kind } = classifyFamilyAndKind(
              row.rel_path,
              row.page_type || "topic",
              rawTitle
            );
            const termId = `${kind}:${slugify(rawTitle)}`;
            const fileStem = basename(row.rel_path, ".md").replace(/[-_]+/g, " ");
            const synonyms: string[] = [];
            if (fileStem.toLowerCase() !== rawTitle.toLowerCase() && fileStem.length <= 64) {
              synonyms.push(fileStem);
            }
            const slashParts = rawTitle.split(/[<>|/]+/).map((s) => s.trim()).filter((s) => s.length >= 2);
            if (slashParts.length > 1) {
              for (const part of slashParts) synonyms.push(part);
            }

            const draft = upsertTerm({
              id: termId,
              canonical_name: rawTitle,
              kind,
              family_id: familyId,
              description: row.snippet || `${rawTitle} (${row.page_type || kind}) compiled from ${row.rel_path}.`,
              synonyms,
              attributes: [row.page_type || kind, deg > 0 ? `links:${deg}` : "canon_page"],
              provenance: [{ path: row.rel_path, source: "kizuki_db", page_id: row.page_id }],
              support_count: 1 + deg,
            });
            pageIdToTermId.set(row.page_id, draft.id);
            sourceCounts.vault_db_pages += 1;
          }

          // Wire confirmed wikilink relations between compiled terms
          for (const e of wikilinkEdges) {
            const fromId = pageIdToTermId.get(e.src);
            const toId = pageIdToTermId.get(e.dst);
            if (fromId && toId && fromId !== toId) {
              addRelation({
                from_id: fromId,
                to_id: toId,
                predicate: "references",
                confirmed: true,
                support_count: 1,
                confidence: 0.92,
              });
              sourceCounts.vault_db_edges += 1;
            }
          }
        }
      } catch {
        // Vault SQLite unreadable or locked; continue cleanly with markdown/JSON sources
      } finally {
        try {
          srcDb?.close();
        } catch {
          // ignore
        }
      }
    }

    // 3. Compile world/people/*.md dossiers
    const peopleDir = join(this.vaultPath, "world", "people");
    if (existsSync(peopleDir)) {
      try {
        const files = readdirSync(peopleDir).filter((f) => f.endsWith(".md")).sort();
        for (const f of files) {
          const relPath = `world/people/${f}`;
          if (isSensitivePath(relPath)) continue;
          const abs = join(peopleDir, f);
          let content = "";
          try {
            content = readFileSync(abs, "utf8").slice(0, 4096);
          } catch {
            continue;
          }
          const headingMatch = /^#\s+(.+)$/m.exec(content);
          const name = (headingMatch ? headingMatch[1] : basename(f, ".md").replace(/[-_]+/g, " ")).trim();
          if (!name) continue;
          const termId = `person:${slugify(name)}`;
          const firstPara = content
            .split(/\r?\n\r?\n/)
            .find((p) => p.trim() && !p.trim().startsWith("#") && !p.trim().startsWith("---")) || "";
          upsertTerm({
            id: termId,
            canonical_name: name,
            kind: "person",
            family_id: "family:people-network",
            description: firstPara || `Person dossier for ${name}.`,
            synonyms: [basename(f, ".md").replace(/[-_]+/g, " ")],
            attributes: ["person_dossier", "world_people"],
            provenance: [{ path: relPath, source: "world_people" }],
            support_count: 2,
          });
          sourceCounts.vault_people += 1;
        }
      } catch {
        // ignore unreadable people dir
      }
    }

    // 4. Compile Codex items (from adapter or <vault>/world/codex.json)
    const codexSeeds: ExternalCodexSeed[] = [];
    if (this.getCodexItems) {
      try {
        codexSeeds.push(...this.getCodexItems());
      } catch {
        // ignore adapter error
      }
    }
    const codexJsonPath = join(this.vaultPath, "world", "codex.json");
    if (codexSeeds.length === 0 && existsSync(codexJsonPath)) {
      try {
        const raw = JSON.parse(readFileSync(codexJsonPath, "utf8")) as {
          custom_items?: ExternalCodexSeed[];
          overrides?: Record<string, { ai_brief?: string }>;
        };
        if (Array.isArray(raw.custom_items)) {
          codexSeeds.push(...raw.custom_items);
        }
        if (raw.overrides && typeof raw.overrides === "object") {
          for (const [k, v] of Object.entries(raw.overrides)) {
            codexSeeds.push({
              id: k,
              title: k.replace(/^(?:phil|int|hob|idea|act)_[a-z]+_/, "").replace(/[-_]+/g, " "),
              summary: v?.ai_brief || "",
            });
          }
        }
      } catch {
        // ignore malformed codex.json
      }
    }
    for (const item of codexSeeds) {
      if (!item || !item.title) continue;
      const termId = `codex:${slugify(item.id || item.title)}`;
      upsertTerm({
        id: termId,
        canonical_name: item.title,
        kind: "codex",
        family_id: "family:codex-rules",
        description: item.thesis || item.summary || `Codex entry: ${item.title}.`,
        synonyms: [...(item.tags || []), item.domain || ""].filter(Boolean),
        attributes: [item.section || "codex", item.domain || "general"].filter(Boolean),
        provenance: [{ path: "world/codex.json", source: "codex" }],
        support_count: 2,
      });
      sourceCounts.codex_items += 1;
      for (const pName of item.linked_people || []) {
        const personId = nameKeyToTermId.get(normalizePhrase(pName)) || `person:${slugify(pName)}`;
        if (termsMap.has(personId)) {
          addRelation({
            from_id: termId,
            to_id: personId,
            predicate: "involves",
            confirmed: true,
            support_count: 1,
            confidence: 0.9,
            evidence_path: "world/codex.json",
          });
        }
      }
    }

    // 5. Compile Taste domains & rules (from adapter or <vault>/world/taste-profile.json)
    const tasteSeeds: ExternalTasteSeed[] = [];
    if (this.getTasteDomains) {
      try {
        tasteSeeds.push(...this.getTasteDomains());
      } catch {
        // ignore adapter error
      }
    }
    const tasteProfilePath = join(this.vaultPath, "world", "taste-profile.json");
    if (tasteSeeds.length === 0 && existsSync(tasteProfilePath)) {
      try {
        const raw = JSON.parse(readFileSync(tasteProfilePath, "utf8")) as {
          custom_rules?: Array<{ id?: string; domain?: string; title?: string; summary?: string }>;
          answers?: Array<{ domain?: string; question_id?: string }>;
        };
        const domains = new Map<string, ExternalTasteSeed>();
        for (const r of raw.custom_rules || []) {
          const dom = (r.domain || "general").trim();
          const entry = domains.get(dom) || { id: dom, name: `${dom} taste`, rules: [] };
          entry.rules!.push({ id: r.id || slugify(r.title || dom), title: r.title || dom, summary: r.summary });
          domains.set(dom, entry);
        }
        for (const a of raw.answers || []) {
          const dom = (a.domain || "general").trim();
          if (!domains.has(dom)) {
            domains.set(dom, { id: dom, name: `${dom} taste`, rules: [] });
          }
        }
        tasteSeeds.push(...domains.values());
      } catch {
        // ignore malformed taste-profile.json
      }
    }
    let totalTasteRules = 0;
    for (const dom of tasteSeeds) {
      if (!dom || !dom.name) continue;
      const domId = `taste:${slugify(dom.id || dom.name)}`;
      upsertTerm({
        id: domId,
        canonical_name: dom.name,
        kind: "taste_domain",
        family_id: "family:taste-craft",
        description: dom.description || `Taste and craft domain for ${dom.name}.`,
        synonyms: [dom.id, `${dom.id} domain`, `${dom.id} craft`].filter(Boolean),
        attributes: ["taste_domain", `rules:${dom.rule_count ?? dom.rules?.length ?? 0}`],
        provenance: [{ path: "world/taste-profile.json", source: "taste" }],
        support_count: Math.max(2, dom.rule_count ?? dom.rules?.length ?? 1),
      });
      sourceCounts.taste_domains += 1;
      totalTasteRules += Math.max(dom.rule_count ?? 0, dom.rules?.length ?? 0);
      for (const rule of (dom.rules || []).slice(0, 12)) {
        if (!rule.title) continue;
        const ruleId = `taste-rule:${slugify(rule.id || rule.title)}`;
        upsertTerm({
          id: ruleId,
          canonical_name: rule.title,
          kind: "taste_domain",
          family_id: "family:taste-craft",
          description: rule.summary || `Craft rule in ${dom.name}: ${rule.title}.`,
          attributes: ["taste_rule", dom.id],
          provenance: [{ path: "world/taste-profile.json", source: "taste" }],
          support_count: 2,
        });
        addRelation({
          from_id: ruleId,
          to_id: domId,
          predicate: "governs",
          confirmed: true,
          support_count: 1,
          confidence: 0.94,
          evidence_path: "world/taste-profile.json",
        });
      }
    }

    // 6. Compile local Markdown files (owner-anchors.md + entities/facts/world when standalone)
    const scanMarkdownRoots = [
      join(this.vaultPath, "owner-anchors.md"),
      join(this.vaultPath, "CANON.md"),
      join(this.vaultPath, "SCHEMA.md"),
    ];
    if (sourceCounts.vault_db_pages === 0) {
      for (const sub of ["entities", "world", "facts", "dashboards"]) {
        const dir = join(this.vaultPath, sub);
        if (!existsSync(dir)) continue;
        this.walkMarkdownFiles(dir, 250, (absFile) => {
          scanMarkdownRoots.push(absFile);
        });
      }
    }

    const mdWikilinkPairs: Array<{ fromId: string; targetRaw: string; relPath: string }> = [];
    for (const absFile of scanMarkdownRoots) {
      if (!existsSync(absFile)) continue;
      let st;
      try {
        st = statSync(absFile);
        if (!st.isFile() || st.size > 512 * 1024) continue;
      } catch {
        continue;
      }
      const relPath = relative(this.vaultPath, absFile).replace(/\\/g, "/");
      if (isSensitivePath(relPath)) continue;
      let raw = "";
      try {
        raw = readFileSync(absFile, "utf8");
      } catch {
        continue;
      }
      sourceCounts.markdown_files += 1;

      // Special structured parsing for owner-anchors.md bold bullets (- **Name**: desc)
      if (relPath === "owner-anchors.md") {
        const bulletRe = /^-\s+\*\*([^*]+)\*\*:\s*(.+)$/gm;
        let m: RegExpExecArray | null;
        while ((m = bulletRe.exec(raw)) !== null) {
          const title = m[1].trim();
          const desc = m[2].trim();
          const termId = `project:${slugify(title)}`;
          upsertTerm({
            id: termId,
            canonical_name: title,
            kind: "project",
            family_id: "family:projects-systems",
            description: desc,
            attributes: ["owner_anchor", "active_project"],
            provenance: [{ path: relPath, source: "owner_anchors" }],
            support_count: 5,
          });
          addRelation({
            from_id: termId,
            to_id: "concept:kizuki-vault",
            predicate: "anchored_in",
            confirmed: true,
            support_count: 3,
            confidence: 0.95,
            evidence_path: relPath,
          });
        }
        continue;
      }

      if (relPath.startsWith("world/people/")) continue;
      const h1 = /^#\s+(.+)$/m.exec(raw);
      const fmTitle = /^title:\s*["']?([^"'\n]+)["']?$/m.exec(raw);
      const title = (fmTitle?.[1] || h1?.[1] || basename(relPath, ".md").replace(/[-_]+/g, " ")).trim();
      if (!title) continue;
      const fmType = /^type:\s*["']?([^"'\n]+)["']?$/m.exec(raw)?.[1] || "topic";
      const { familyId, kind } = classifyFamilyAndKind(relPath, fmType, title);
      const termId = `${kind}:${slugify(title)}`;

      upsertTerm({
        id: termId,
        canonical_name: title,
        kind,
        family_id: familyId,
        description: raw.slice(0, 500),
        synonyms: [basename(relPath, ".md").replace(/[-_]+/g, " ")],
        attributes: ["markdown_doc", fmType],
        provenance: [{ path: relPath, source: "vault_markdown" }],
        support_count: 2,
      });

      const linkRe = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(raw)) !== null) {
        mdWikilinkPairs.push({ fromId: termId, targetRaw: lm[1].trim(), relPath });
      }
    }

    for (const pair of mdWikilinkPairs) {
      const targetNorm = normalizePhrase(basename(pair.targetRaw, ".md"));
      const toId = nameKeyToTermId.get(targetNorm);
      if (toId && toId !== pair.fromId) {
        addRelation({
          from_id: pair.fromId,
          to_id: toId,
          predicate: "references",
          confirmed: true,
          support_count: 1,
          confidence: 0.92,
          evidence_path: pair.relPath,
        });
      }
    }

    // 7. Wire every non-family term into its canonical Term Family (enables multi-hop join paths!)
    for (const draft of termsMap.values()) {
      if (draft.kind === "family") continue;
      if (termsMap.has(draft.family_id)) {
        addRelation({
          from_id: draft.id,
          to_id: draft.family_id,
          predicate: "belongs_to_family",
          confirmed: true,
          support_count: 1,
          confidence: 0.9,
        });
      }
    }

    // Cross-family bridge relations backed by the vault schema
    const familyBridges: Array<[string, string, string]> = [
      ["family:world-model", "family:projects-systems", "grounds"],
      ["family:projects-systems", "family:people-network", "owned_by"],
      ["family:people-network", "family:organizations", "affiliated_with"],
      ["family:world-model", "family:codex-rules", "governed_by"],
      ["family:codex-rules", "family:taste-craft", "enforces"],
      ["family:world-model", "family:knowledge-concepts", "synthesizes"],
      ["family:world-model", "family:metrics-telemetry", "measured_by"],
    ];
    for (const [a, b, pred] of familyBridges) {
      addRelation({
        from_id: a,
        to_id: b,
        predicate: pred,
        confirmed: true,
        support_count: 3,
        confidence: 0.95,
      });
    }

    // 8. Load sticky owner certifications BEFORE persisting so they survive every recompile!
    const stickyRows = this.db
      .query("SELECT * FROM certifications")
      .all() as CertRow[];
    const stickyByTermId = new Map<string, CertRow>(stickyRows.map((r) => [r.term_id, r]));

    // 9. Compile deterministic vault metrics & register metric terms
    let certifiedCount = 0;
    for (const draft of termsMap.values()) {
      const cert = stickyByTermId.get(draft.id);
      if (cert && cert.certified === 1) certifiedCount += 1;
    }

    const compiledMetrics: OntologyMetric[] = [
      {
        id: "metric:compiled-terms",
        name: "Compiled Semantic Terms",
        family_id: "family:metrics-telemetry",
        unit: "terms",
        value: termsMap.size,
        definition: "Total canonical entities, concepts, people, projects, codex entries, and domains.",
        source: "explorer-ontology.sqlite",
      },
      {
        id: "metric:confirmed-relations",
        name: "Data-Confirmed Relations",
        family_id: "family:metrics-telemetry",
        unit: "edges",
        value: Array.from(relationsMap.values()).filter((r) => r.confirmed).length,
        definition: "Semantic edges backed by vault wikilinks, codex links, taste rules, or schema bindings.",
        source: "explorer-ontology.sqlite",
      },
      {
        id: "metric:canon-pages",
        name: "Active Vault Canon Pages",
        family_id: "family:world-model",
        unit: "pages",
        value: totalDbPages || sourceCounts.markdown_files,
        definition: "Total active canon documents indexed in the local vault.",
        source: "kizuki.db:graph_pages",
      },
      {
        id: "metric:live-claims",
        name: "Live World Claims",
        family_id: "family:world-model",
        unit: "claims",
        value: totalClaimsLive,
        definition: "Active grounded claims in the vault world ledger.",
        source: "kizuki.db:claims",
      },
      {
        id: "metric:world-observations",
        name: "World Observations",
        family_id: "family:world-model",
        unit: "observations",
        value: totalWorldObservations,
        definition: "Consolidated evidence observations admitted to the world model.",
        source: "kizuki.db:world_observations",
      },
      {
        id: "metric:people-dossiers",
        name: "People Network Dossiers",
        family_id: "family:people-network",
        unit: "people",
        value: sourceCounts.vault_people,
        definition: "Compiled person dossiers under world/people.",
        source: "world/people",
      },
      {
        id: "metric:certified-terms",
        name: "Owner Certified Terms",
        family_id: "family:metrics-telemetry",
        unit: "terms",
        value: certifiedCount,
        definition: "Ontology terms carrying sticky owner certification receipts.",
        source: "explorer-ontology.sqlite:certifications",
      },
      {
        id: "metric:taste-rules",
        name: "Taste & Craft Rules",
        family_id: "family:taste-craft",
        unit: "rules",
        value: totalTasteRules,
        definition: "Compiled aesthetic and engineering craft rules across taste domains.",
        source: "world/taste-profile.json",
      },
    ];

    for (const metric of compiledMetrics) {
      upsertTerm({
        id: metric.id,
        canonical_name: metric.name,
        kind: "metric",
        family_id: metric.family_id,
        description: `${metric.definition} Current value: ${metric.value} ${metric.unit}.`,
        synonyms: [metric.id.replace(/^metric:/, "").replace(/-/g, " ")],
        attributes: [`unit:${metric.unit}`, `value:${metric.value}`, `source:${metric.source}`],
        support_count: 3,
      });
      addRelation({
        from_id: metric.id,
        to_id: metric.family_id,
        predicate: "measures",
        confirmed: true,
        support_count: 2,
        confidence: 0.96,
      });
    }

    // 10. Persist atomically into rebuildable SQLite tables (certifications table untouched!)
    const tx = this.db.transaction(() => {
      this.db.exec("DELETE FROM term_families; DELETE FROM terms; DELETE FROM relations; DELETE FROM metrics;");

      const insFam = this.db.prepare(
        "INSERT INTO term_families (id, name, description, synonyms_json) VALUES (?, ?, ?, ?)"
      );
      for (const fam of CORE_FAMILIES) {
        insFam.run(fam.id, fam.name, fam.description, JSON.stringify(fam.synonyms));
      }

      const insTerm = this.db.prepare(`
        INSERT INTO terms (
          id, canonical_name, kind, family_id, family_name, description,
          synonyms_json, attributes_json, provenance_json, support_count,
          certified, certified_at, certified_by, certification_receipt, certification_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const draft of termsMap.values()) {
        const cert = stickyByTermId.get(draft.id);
        const famId =
          cert?.custom_family_id && FAMILY_BY_ID.has(cert.custom_family_id)
            ? cert.custom_family_id
            : draft.family_id;
        const famName = FAMILY_BY_ID.get(famId)?.name || "Knowledge & Concepts";
        const desc = cert?.custom_description
          ? cleanDescription(cert.custom_description, 480)
          : draft.description;

        let synList = Array.from(draft.synonyms);
        if (cert?.custom_synonyms) {
          try {
            const parsed = JSON.parse(cert.custom_synonyms) as string[];
            if (Array.isArray(parsed)) synList = uniqueStrings([...parsed, ...synList], 24);
          } catch {
            // ignore invalid custom_synonyms JSON
          }
        } else {
          synList = uniqueStrings(synList, 24);
        }

        insTerm.run(
          draft.id,
          draft.canonical_name,
          draft.kind,
          famId,
          famName,
          desc,
          JSON.stringify(synList),
          JSON.stringify(uniqueStrings(Array.from(draft.attributes), 12)),
          JSON.stringify(draft.provenance.slice(0, 10)),
          draft.support_count,
          cert?.certified === 1 ? 1 : 0,
          cert?.certified === 1 ? cert.certified_at : null,
          cert?.certified === 1 ? cert.certified_by : null,
          cert?.certified === 1 ? cert.receipt_hash : null,
          cert?.note || null
        );
      }

      const insRel = this.db.prepare(`
        INSERT INTO relations (
          id, from_id, to_id, predicate, confirmed, support_count, confidence, evidence_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const rel of relationsMap.values()) {
        insRel.run(
          rel.id,
          rel.from_id,
          rel.to_id,
          rel.predicate,
          rel.confirmed ? 1 : 0,
          rel.support_count,
          rel.confidence,
          rel.evidence_path
        );
      }

      const insMetric = this.db.prepare(`
        INSERT INTO metrics (id, name, family_id, unit, value, definition, source)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const m of compiledMetrics) {
        insMetric.run(m.id, m.name, m.family_id, m.unit, m.value, m.definition, m.source);
      }

      const compileMs = Math.max(1, Math.round(performance.now() - t0));
      const upsertMeta = this.db.prepare(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)"
      );
      upsertMeta.run("compiled_at", compiledAt);
      upsertMeta.run("compile_ms", String(compileMs));
      upsertMeta.run("source_counts", JSON.stringify(sourceCounts));
    });

    tx();
    this.loadIntoMemory();
    return this.getStatus();
  }

  private walkMarkdownFiles(dir: string, limit: number, onFile: (absPath: string) => void): void {
    let seen = 0;
    const stack = [dir];
    while (stack.length > 0 && seen < limit) {
      const cur = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (seen >= limit) break;
        if (e.name.startsWith(".")) continue;
        const full = join(cur, e.name);
        if (e.isDirectory()) {
          if (isSensitivePath(full)) continue;
          stack.push(full);
        } else if (e.isFile() && e.name.endsWith(".md")) {
          seen += 1;
          onFile(full);
        }
      }
    }
  }

  private loadIntoMemory(): void {
    this.termsById.clear();
    this.phraseToTermIds.clear();
    this.tokenToTermIds.clear();
    this.adjacency.clear();
    this.allRelations = [];
    this.allMetrics = [];

    const metaRows = this.db.query("SELECT key, value FROM meta").all() as Array<{
      key: string;
      value: string;
    }>;
    const meta = new Map(metaRows.map((r) => [r.key, r.value]));
    this.lastCompiledAt = meta.get("compiled_at") || null;
    this.lastCompileMs = Number(meta.get("compile_ms") || 0);
    if (meta.has("source_counts")) {
      try {
        this.lastSourceCounts = JSON.parse(meta.get("source_counts")!) as OntologyStatus["source_counts"];
      } catch {
        // keep defaults
      }
    }

    const termRows = this.db
      .query("SELECT * FROM terms ORDER BY certified DESC, support_count DESC, canonical_name ASC")
      .all() as Array<{
      id: string;
      canonical_name: string;
      kind: OntologyTermKind;
      family_id: string;
      family_name: string;
      description: string;
      synonyms_json: string;
      attributes_json: string;
      provenance_json: string;
      support_count: number;
      certified: number;
      certified_at: string | null;
      certified_by: string | null;
      certification_receipt: string | null;
      certification_note: string | null;
    }>;

    const addPhrase = (phrase: string, termId: string) => {
      const norm = normalizePhrase(phrase);
      if (!norm || norm.length < 2) return;
      let set = this.phraseToTermIds.get(norm);
      if (!set) {
        set = new Set<string>();
        this.phraseToTermIds.set(norm, set);
      }
      set.add(termId);
      const toks = tokenize(norm);
      for (const tok of toks) {
        if (QUESTION_STOPWORDS.has(tok) || tok.length < 2) continue;
        for (const variant of [tok, stemToken(tok)]) {
          let tset = this.tokenToTermIds.get(variant);
          if (!tset) {
            tset = new Set<string>();
            this.tokenToTermIds.set(variant, tset);
          }
          tset.add(termId);
        }
      }
    };

    const famCounts = new Map<string, { terms: number; certified: number }>();
    for (const f of CORE_FAMILIES) {
      famCounts.set(f.id, { terms: 0, certified: 0 });
    }

    for (const r of termRows) {
      let synonyms: string[] = [];
      let attributes: string[] = [];
      let provenance: ProvenanceRef[] = [];
      try {
        synonyms = JSON.parse(r.synonyms_json) as string[];
      } catch {
        synonyms = [];
      }
      try {
        attributes = JSON.parse(r.attributes_json) as string[];
      } catch {
        attributes = [];
      }
      try {
        provenance = JSON.parse(r.provenance_json) as ProvenanceRef[];
      } catch {
        provenance = [];
      }
      const term: OntologyTerm = {
        id: r.id,
        canonical_name: r.canonical_name,
        kind: r.kind,
        family_id: r.family_id,
        family_name: r.family_name,
        description: r.description,
        synonyms,
        attributes,
        provenance,
        support_count: r.support_count,
        certified: r.certified === 1,
        certified_at: r.certified_at,
        certified_by: r.certified_by,
        certification_receipt: r.certification_receipt,
        certification_note: r.certification_note,
      };
      this.termsById.set(term.id, term);
      addPhrase(term.canonical_name, term.id);
      for (const syn of term.synonyms) addPhrase(syn, term.id);

      const fc = famCounts.get(term.family_id);
      if (fc) {
        fc.terms += 1;
        if (term.certified) fc.certified += 1;
      }
    }

    const relRows = this.db.query("SELECT * FROM relations").all() as Array<{
      id: string;
      from_id: string;
      to_id: string;
      predicate: string;
      confirmed: number;
      support_count: number;
      confidence: number;
      evidence_path: string | null;
    }>;
    for (const r of relRows) {
      const fromTerm = this.termsById.get(r.from_id);
      const toTerm = this.termsById.get(r.to_id);
      if (!fromTerm || !toTerm) continue;
      const rel: OntologyRelation = {
        id: r.id,
        from_id: r.from_id,
        from_name: fromTerm.canonical_name,
        to_id: r.to_id,
        to_name: toTerm.canonical_name,
        predicate: r.predicate,
        confirmed: r.confirmed === 1,
        support_count: r.support_count,
        confidence: r.confidence,
        evidence_path: r.evidence_path,
      };
      this.allRelations.push(rel);
      let aList = this.adjacency.get(rel.from_id);
      if (!aList) {
        aList = [];
        this.adjacency.set(rel.from_id, aList);
      }
      aList.push(rel);

      let bList = this.adjacency.get(rel.to_id);
      if (!bList) {
        bList = [];
        this.adjacency.set(rel.to_id, bList);
      }
      bList.push(rel);
    }

    this.allMetrics = this.db.query("SELECT * FROM metrics ORDER BY id ASC").all() as OntologyMetric[];

    this.familiesSummary = CORE_FAMILIES.map((f) => {
      const fc = famCounts.get(f.id) || { terms: 0, certified: 0 };
      return {
        id: f.id,
        name: f.name,
        description: f.description,
        synonyms: [...f.synonyms],
        term_count: fc.terms,
        certified_count: fc.certified,
      };
    });

    this.warmed = true;
  }

  getStatus(): OntologyStatus {
    this.ensureReady();
    let certified = 0;
    for (const t of this.termsById.values()) {
      if (t.certified) certified += 1;
    }
    const confirmedRelations = this.allRelations.filter((r) => r.confirmed).length;
    return {
      ok: true,
      ready: this.warmed,
      db_file: basename(this.dbPath),
      compiled_at: this.lastCompiledAt,
      compile_ms: this.lastCompileMs,
      source_counts: { ...this.lastSourceCounts },
      stats: {
        terms: this.termsById.size,
        certified,
        families: this.familiesSummary.length,
        relations: this.allRelations.length,
        confirmed_relations: confirmedRelations,
        metrics: this.allMetrics.length,
      },
      families: this.familiesSummary,
      metrics: this.allMetrics,
    };
  }

  searchTerms(opts: {
    q?: string;
    family?: string;
    kind?: string;
    certified?: boolean;
    limit?: number;
  } = {}): {
    query: string;
    total: number;
    latency_ms: number;
    terms: OntologyTerm[];
  } {
    const t0 = performance.now();
    this.ensureReady();

    const qRaw = (opts.q || "").trim();
    const qNorm = normalizePhrase(qRaw);
    const qTokens = tokenize(qNorm);
    const famFilter = (opts.family || "").trim().toLowerCase();
    const kindFilter = (opts.kind || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, opts.limit ?? 60));

    let candidates: OntologyTerm[];
    if (qNorm) {
      const candidateIds = new Set<string>();
      const exact = this.phraseToTermIds.get(qNorm);
      if (exact) {
        for (const id of exact) candidateIds.add(id);
      }
      for (const tok of qTokens) {
        for (const v of [tok, stemToken(tok)]) {
          const hit = this.tokenToTermIds.get(v);
          if (hit) {
            for (const id of hit) candidateIds.add(id);
          }
        }
      }
      // Substring fallback if inverted lookup yielded few items
      if (candidateIds.size < 25) {
        for (const term of this.termsById.values()) {
          if (
            term.canonical_name.toLowerCase().includes(qNorm) ||
            term.description.toLowerCase().includes(qNorm) ||
            term.synonyms.some((s) => s.toLowerCase().includes(qNorm))
          ) {
            candidateIds.add(term.id);
          }
        }
      }
      candidates = Array.from(candidateIds)
        .map((id) => this.termsById.get(id)!)
        .filter(Boolean);
    } else {
      candidates = Array.from(this.termsById.values());
    }

    const filtered = candidates.filter((t) => {
      if (famFilter && famFilter !== "all" && t.family_id.toLowerCase() !== famFilter) return false;
      if (kindFilter && kindFilter !== "all" && t.kind.toLowerCase() !== kindFilter) return false;
      if (opts.certified === true && !t.certified) return false;
      if (opts.certified === false && t.certified) return false;
      return true;
    });

    const scored = filtered.map((t) => {
      let score = t.support_count * 2 + (t.certified ? 40 : 0);
      if (qNorm) {
        const nameNorm = normalizePhrase(t.canonical_name);
        if (nameNorm === qNorm) score += 200;
        else if (nameNorm.startsWith(qNorm)) score += 120;
        else if (nameNorm.includes(qNorm)) score += 80;
        if (t.synonyms.some((s) => normalizePhrase(s) === qNorm)) score += 140;
        for (const tok of qTokens) {
          if (nameNorm.includes(tok)) score += 25;
          if (t.description.toLowerCase().includes(tok)) score += 8;
        }
      }
      return { term: t, score };
    });

    scored.sort((a, b) => b.score - a.score || a.term.canonical_name.localeCompare(b.term.canonical_name));
    const terms = scored.slice(0, limit).map((s) => s.term);
    return {
      query: qRaw,
      total: filtered.length,
      latency_ms: Number((performance.now() - t0).toFixed(2)),
      terms,
    };
  }

  resolveTermRef(ref: string): OntologyTerm | null {
    this.ensureReady();
    const raw = (ref || "").trim();
    if (!raw) return null;
    if (this.termsById.has(raw)) return this.termsById.get(raw)!;

    const norm = normalizePhrase(raw);
    const exactIds = this.phraseToTermIds.get(norm);
    if (exactIds && exactIds.size > 0) {
      return this.pickBestTerm(Array.from(exactIds));
    }
    const stemIds = this.tokenToTermIds.get(stemToken(norm));
    if (stemIds && stemIds.size > 0) {
      return this.pickBestTerm(Array.from(stemIds));
    }
    return null;
  }

  private pickBestTerm(ids: string[]): OntologyTerm | null {
    let best: OntologyTerm | null = null;
    let bestScore = -1;
    for (const id of ids) {
      const t = this.termsById.get(id);
      if (!t) continue;
      const score =
        (t.certified ? 100 : 0) +
        (t.kind === "family" ? 5 : 20) +
        Math.min(50, t.support_count * 3);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  getTermDetail(idOrName: string): TermDetailResult | null {
    this.ensureReady();
    const term = this.resolveTermRef(idOrName);
    if (!term) return null;

    const rels = (this.adjacency.get(term.id) || [])
      .slice()
      .sort((a, b) => b.support_count - a.support_count || b.confidence - a.confidence)
      .slice(0, 48);

    // Compute up to 3 illustrative join paths to key connected concepts or anchor terms
    const joinPaths: JoinPathResult[] = [];
    const targets = new Set<string>();
    for (const r of rels) {
      const other = r.from_id === term.id ? r.to_id : r.from_id;
      if (other !== term.family_id) targets.add(other);
      if (targets.size >= 2) break;
    }
    if (term.id !== "concept:world-model" && this.termsById.has("concept:world-model")) {
      targets.add("concept:world-model");
    }
    for (const tid of targets) {
      const jp = this.findJoinPath(term.id, tid, 4);
      if (jp.found && jp.hops > 0) joinPaths.push(jp);
    }

    return { term, relations: rels, join_paths: joinPaths };
  }

  findJoinPath(fromRef: string, toRef: string, maxHops = 5): JoinPathResult {
    const t0 = performance.now();
    this.ensureReady();

    const fromTerm = this.resolveTermRef(fromRef);
    const toTerm = this.resolveTermRef(toRef);
    if (!fromTerm || !toTerm) {
      return {
        found: false,
        from: fromTerm ? { id: fromTerm.id, canonical_name: fromTerm.canonical_name } : null,
        to: toTerm ? { id: toTerm.id, canonical_name: toTerm.canonical_name } : null,
        hops: 0,
        nodes: [],
        edges: [],
        path_label: "",
        latency_ms: Number((performance.now() - t0).toFixed(2)),
      };
    }

    if (fromTerm.id === toTerm.id) {
      return {
        found: true,
        from: { id: fromTerm.id, canonical_name: fromTerm.canonical_name },
        to: { id: toTerm.id, canonical_name: toTerm.canonical_name },
        hops: 0,
        nodes: [
          {
            id: fromTerm.id,
            canonical_name: fromTerm.canonical_name,
            kind: fromTerm.kind,
            certified: fromTerm.certified,
          },
        ],
        edges: [],
        path_label: fromTerm.canonical_name,
        latency_ms: Number((performance.now() - t0).toFixed(2)),
      };
    }

    // BFS shortest path over confirmed relations (prioritizing direct non-family links first)
    const visited = new Set<string>([fromTerm.id]);
    const parent = new Map<string, { prev: string; rel: OntologyRelation }>();
    const queue: Array<{ id: string; depth: number }> = [{ id: fromTerm.id, depth: 0 }];
    let found = false;

    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (cur.depth >= maxHops) continue;
      const neighbors = this.adjacency.get(cur.id) || [];
      // Explore direct entity/concept links before family hubs for sharpest paths
      const ordered = neighbors.slice().sort((a, b) => {
        const aFam = a.predicate === "belongs_to_family" ? 1 : 0;
        const bFam = b.predicate === "belongs_to_family" ? 1 : 0;
        if (aFam !== bFam) return aFam - bFam;
        return b.support_count - a.support_count;
      });
      for (const rel of ordered) {
        const nextId = rel.from_id === cur.id ? rel.to_id : rel.from_id;
        if (visited.has(nextId)) continue;
        visited.add(nextId);
        parent.set(nextId, { prev: cur.id, rel });
        if (nextId === toTerm.id) {
          found = true;
          break;
        }
        queue.push({ id: nextId, depth: cur.depth + 1 });
      }
      if (found) break;
    }

    if (!found) {
      return {
        found: false,
        from: { id: fromTerm.id, canonical_name: fromTerm.canonical_name },
        to: { id: toTerm.id, canonical_name: toTerm.canonical_name },
        hops: 0,
        nodes: [],
        edges: [],
        path_label: "",
        latency_ms: Number((performance.now() - t0).toFixed(2)),
      };
    }

    const nodeIds: string[] = [];
    const edges: JoinPathStep[] = [];
    let cur = toTerm.id;
    while (cur !== fromTerm.id) {
      nodeIds.push(cur);
      const step = parent.get(cur)!;
      const aTerm = this.termsById.get(step.prev)!;
      const bTerm = this.termsById.get(cur)!;
      edges.push({
        from_id: aTerm.id,
        from_name: aTerm.canonical_name,
        to_id: bTerm.id,
        to_name: bTerm.canonical_name,
        predicate: step.rel.predicate,
        confirmed: step.rel.confirmed,
        support_count: step.rel.support_count,
      });
      cur = step.prev;
    }
    nodeIds.push(fromTerm.id);
    nodeIds.reverse();
    edges.reverse();

    const nodes = nodeIds.map((id) => {
      const t = this.termsById.get(id)!;
      return {
        id: t.id,
        canonical_name: t.canonical_name,
        kind: t.kind,
        certified: t.certified,
      };
    });

    return {
      found: true,
      from: { id: fromTerm.id, canonical_name: fromTerm.canonical_name },
      to: { id: toTerm.id, canonical_name: toTerm.canonical_name },
      hops: edges.length,
      nodes,
      edges,
      path_label: nodes.map((n) => n.canonical_name).join(" -> "),
      latency_ms: Number((performance.now() - t0).toFixed(2)),
    };
  }

  checkAnswerable(questionRaw: string): AnswerableResult {
    const t0 = performance.now();
    this.ensureReady();

    const question = redactSecrets(questionRaw || "").trim();
    const norm = normalizePhrase(question);
    const allTokens = norm ? norm.split(" ").filter(Boolean) : [];
    const contentTokens = allTokens.filter(
      (tok) => tok.length >= 2 && !QUESTION_STOPWORDS.has(tok) && !GENERIC_CONNECTORS.has(tok)
    );

    if (contentTokens.length === 0) {
      return {
        question,
        verdict: "unanswerable",
        coverage_pct: 0,
        matched_terms: [],
        missing_terms: question
          ? [{ phrase: question, reason: "No domain concepts detected in question." }]
          : [],
        join_paths: [],
        primary_join_path: null,
        recommended_families: [],
        latency_ms: Number((performance.now() - t0).toFixed(2)),
      };
    }

    const matchedTermMap = new Map<string, AnswerableMatch>();
    const coveredIndices = new Set<number>();

    const recordMatch = (
      term: OntologyTerm,
      phrase: string,
      matchType: AnswerableMatch["match_type"],
      indices: number[]
    ) => {
      for (const idx of indices) coveredIndices.add(idx);
      if (!matchedTermMap.has(term.id)) {
        matchedTermMap.set(term.id, {
          id: term.id,
          canonical_name: term.canonical_name,
          kind: term.kind,
          family_id: term.family_id,
          family_name: term.family_name,
          certified: term.certified,
          matched_phrase: phrase,
          match_type: matchType,
          support_count: term.support_count,
        });
      }
    };

    // Pass 1: Match 3-grams and 2-grams over content tokens against canonical phrases & synonyms
    for (const n of [3, 2]) {
      for (let i = 0; i <= contentTokens.length - n; i += 1) {
        const spanIndices = Array.from({ length: n }, (_, k) => i + k);
        if (spanIndices.every((idx) => coveredIndices.has(idx))) continue;
        const phrase = spanIndices.map((idx) => contentTokens[idx]).join(" ");
        const stemmedPhrase = spanIndices.map((idx) => stemToken(contentTokens[idx])).join(" ");

        const ids = this.phraseToTermIds.get(phrase) || this.phraseToTermIds.get(stemmedPhrase);
        if (ids && ids.size > 0) {
          const best = this.pickBestTerm(Array.from(ids));
          if (best) {
            const mType =
              normalizePhrase(best.canonical_name) === phrase
                ? "exact"
                : best.kind === "family"
                  ? "family"
                  : "synonym";
            recordMatch(best, phrase, mType, spanIndices);
          }
        }
      }
    }

    // Pass 2: Match uncovered single content tokens strictly against exact phrases, synonyms, or single-token canonical terms
    for (let i = 0; i < contentTokens.length; i += 1) {
      if (coveredIndices.has(i)) continue;
      const tok = contentTokens[i];
      const stemmed = stemToken(tok);

      // Exact phrase or synonym hit (e.g., "kizuki", "commitments", "codex", "taste")
      const exactIds = this.phraseToTermIds.get(tok) || this.phraseToTermIds.get(stemmed);
      if (exactIds && exactIds.size > 0) {
        const best = this.pickBestTerm(Array.from(exactIds));
        if (best) {
          const mType =
            normalizePhrase(best.canonical_name) === tok
              ? "exact"
              : best.kind === "family"
                ? "family"
                : "synonym";
          recordMatch(best, tok, mType, [i]);
          continue;
        }
      }

      // Token-level hit ONLY if a term's canonical name or synonym is compact (<= 2 tokens) and contains this significant token (len >= 4)
      if (tok.length >= 4) {
        const tokIds = this.tokenToTermIds.get(tok) || this.tokenToTermIds.get(stemmed);
        if (tokIds && tokIds.size > 0) {
          const strongCandidates = Array.from(tokIds)
            .map((id) => this.termsById.get(id)!)
            .filter((t) => {
              if (!t) return false;
              const nameToks = tokenize(t.canonical_name);
              const synHit = t.synonyms.some((s) => {
                const st = tokenize(s);
                return st.length <= 2 && (st.includes(tok) || st.includes(stemmed));
              });
              return (
                (nameToks.length <= 2 && (nameToks.includes(tok) || nameToks.includes(stemmed))) ||
                synHit
              );
            });
          if (strongCandidates.length > 0) {
            const best = this.pickBestTerm(strongCandidates.map((c) => c.id));
            if (best) {
              recordMatch(best, tok, "token", [i]);
            }
          }
        }
      }
    }

    // Group contiguous uncovered tokens into crisp missing-term gap phrases
    const missingTerms: AnswerableGap[] = [];
    let gapBuf: string[] = [];
    const flushGap = () => {
      if (gapBuf.length === 0) return;
      const phrase = gapBuf.join(" ");
      missingTerms.push({
        phrase,
        reason: "Not grounded in compiled vault ontology terms or synonyms.",
      });
      gapBuf = [];
    };
    for (let i = 0; i < contentTokens.length; i += 1) {
      if (coveredIndices.has(i)) {
        flushGap();
      } else {
        gapBuf.push(contentTokens[i]);
      }
    }
    flushGap();

    const matchedTerms = Array.from(matchedTermMap.values()).sort(
      (a, b) => (b.certified ? 1 : 0) - (a.certified ? 1 : 0) || b.support_count - a.support_count
    );

    const coveragePct = Math.round((coveredIndices.size / contentTokens.length) * 100);
    let verdict: AnswerableResult["verdict"];
    if (matchedTerms.length === 0 || coveragePct === 0) {
      verdict = "unanswerable";
    } else if (coveragePct >= 75 && missingTerms.length === 0) {
      verdict = "answerable";
    } else if (coveragePct >= 75 && matchedTerms.length >= 2) {
      verdict = "answerable";
    } else {
      verdict = "partial";
    }

    // Compute shortest multi-hop semantic join paths connecting matched terms
    const joinPaths: JoinPathResult[] = [];
    if (matchedTerms.length >= 2) {
      const anchor = matchedTerms[0];
      for (let i = 1; i < Math.min(matchedTerms.length, 4); i += 1) {
        const jp = this.findJoinPath(anchor.id, matchedTerms[i].id, 5);
        if (jp.found && jp.hops > 0) joinPaths.push(jp);
      }
    } else if (matchedTerms.length === 1) {
      const single = matchedTerms[0];
      if (single.id !== single.family_id) {
        const jp = this.findJoinPath(single.id, single.family_id, 3);
        if (jp.found && jp.hops > 0) joinPaths.push(jp);
      }
    }

    // Collect recommended families
    const famIds = new Set<string>(matchedTerms.map((m) => m.family_id));
    const recommendedFamilies = this.familiesSummary
      .filter((f) => famIds.has(f.id))
      .map((f) => ({ id: f.id, name: f.name, term_count: f.term_count }));

    return {
      question,
      verdict,
      coverage_pct: coveragePct,
      matched_terms: matchedTerms,
      missing_terms: missingTerms,
      join_paths: joinPaths,
      primary_join_path: joinPaths[0]?.path_label || matchedTerms[0]?.canonical_name || null,
      recommended_families: recommendedFamilies,
      latency_ms: Number((performance.now() - t0).toFixed(2)),
    };
  }

  certifyTerm(input: CertifyTermInput): CertifyTermResult {
    this.ensureReady();
    const term = this.resolveTermRef(input.id);
    if (!term) {
      throw new Error(`Ontology term not found: ${input.id}`);
    }

    const certified = input.certified !== false;
    const certifiedAt = new Date().toISOString();
    const certifiedBy = redactSecrets(input.certified_by || "owner").trim() || "owner";
    const customDesc =
      typeof input.description === "string" && input.description.trim()
        ? cleanDescription(input.description, 480)
        : term.description;
    const customSyns = Array.isArray(input.synonyms)
      ? uniqueStrings(input.synonyms, 24)
      : term.synonyms;
    const customFamilyId =
      input.family_id && FAMILY_BY_ID.has(input.family_id) ? input.family_id : term.family_id;
    const famName = FAMILY_BY_ID.get(customFamilyId)?.name || term.family_name;
    const note = typeof input.note === "string" ? cleanDescription(input.note, 240) : term.certification_note;

    const receiptHash = createHash("sha256")
      .update(
        JSON.stringify({
          term_id: term.id,
          certified,
          description: customDesc,
          synonyms: customSyns,
          family_id: customFamilyId,
          certified_by: certifiedBy,
          certified_at: certifiedAt,
        })
      )
      .digest("hex")
      .slice(0, 16);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO certifications (
            term_id, certified, custom_description, custom_synonyms, custom_family_id,
            note, certified_by, certified_at, receipt_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          term.id,
          certified ? 1 : 0,
          customDesc,
          JSON.stringify(customSyns),
          customFamilyId,
          note || null,
          certifiedBy,
          certifiedAt,
          receiptHash
        );

      this.db
        .prepare(
          `UPDATE terms SET
            family_id = ?,
            family_name = ?,
            description = ?,
            synonyms_json = ?,
            certified = ?,
            certified_at = ?,
            certified_by = ?,
            certification_receipt = ?,
            certification_note = ?
          WHERE id = ?`
        )
        .run(
          customFamilyId,
          famName,
          customDesc,
          JSON.stringify(customSyns),
          certified ? 1 : 0,
          certified ? certifiedAt : null,
          certified ? certifiedBy : null,
          certified ? receiptHash : null,
          note || null,
          term.id
        );
    });
    tx();

    // Refresh certified metric & memory index cleanly
    const certTotal = (
      this.db.query("SELECT COUNT(*) AS n FROM terms WHERE certified = 1").get() as { n: number }
    ).n;
    this.db
      .prepare("UPDATE metrics SET value = ? WHERE id = 'metric:certified-terms'")
      .run(certTotal);

    this.loadIntoMemory();
    const updated = this.termsById.get(term.id)!;

    return {
      ok: true,
      term: updated,
      receipt: {
        term_id: updated.id,
        certified,
        certified_at: certifiedAt,
        certified_by: certifiedBy,
        receipt_hash: receiptHash,
        sticky: true,
      },
    };
  }

  exportOntology(
    format: "ossie-yaml" | "json",
    opts: { maxTerms?: number; maxRelations?: number } = {}
  ): { contentType: string; filename: string; body: string } {
    this.ensureReady();
    const status = this.getStatus();
    const maxTerms = Math.max(20, Math.min(2000, opts.maxTerms ?? 400));
    const maxRelations = Math.max(20, Math.min(4000, opts.maxRelations ?? 800));

    const terms = Array.from(this.termsById.values())
      .sort((a, b) => (b.certified ? 1 : 0) - (a.certified ? 1 : 0) || b.support_count - a.support_count)
      .slice(0, maxTerms);
    const includedIds = new Set(terms.map((t) => t.id));
    const relations = this.allRelations
      .filter((r) => includedIds.has(r.from_id) && includedIds.has(r.to_id))
      .sort((a, b) => b.support_count - a.support_count)
      .slice(0, maxRelations);

    if (format === "json") {
      const payload = {
        schema: "ossie/v1",
        ontology: {
          name: "kizuki-vault-ontology",
          compiled_at: status.compiled_at,
          stats: status.stats,
        },
        term_families: status.families,
        terms,
        relations,
        metrics: status.metrics,
      };
      return {
        contentType: "application/json; charset=utf-8",
        filename: "kizuki-ontology.ossie.json",
        body: redactSecrets(JSON.stringify(payload, null, 2)) + "\n",
      };
    }

    // Spec-aligned Ossie YAML export (zero secrets, zero em-dashes)
    const lines: string[] = [
      "schema: ossie/v1",
      "ontology:",
      "  name: kizuki-vault-ontology",
      `  compiled_at: ${escapeYamlScalar(status.compiled_at || new Date().toISOString())}`,
      "  stats:",
      `    terms: ${status.stats.terms}`,
      `    certified: ${status.stats.certified}`,
      `    families: ${status.stats.families}`,
      `    confirmed_relations: ${status.stats.confirmed_relations}`,
      `    metrics: ${status.stats.metrics}`,
      "term_families:",
    ];

    for (const fam of status.families) {
      lines.push(`  - id: ${escapeYamlScalar(fam.id)}`);
      lines.push(`    name: ${escapeYamlScalar(fam.name)}`);
      lines.push(`    description: ${escapeYamlScalar(fam.description)}`);
      lines.push(`    term_count: ${fam.term_count}`);
      lines.push(`    certified_count: ${fam.certified_count}`);
      if (fam.synonyms.length > 0) {
        lines.push(`    synonyms: [${fam.synonyms.map(escapeYamlScalar).join(", ")}]`);
      }
    }

    lines.push("terms:");
    for (const t of terms) {
      lines.push(`  - id: ${escapeYamlScalar(t.id)}`);
      lines.push(`    canonical_name: ${escapeYamlScalar(t.canonical_name)}`);
      lines.push(`    kind: ${escapeYamlScalar(t.kind)}`);
      lines.push(`    family_id: ${escapeYamlScalar(t.family_id)}`);
      lines.push(`    certified: ${t.certified ? "true" : "false"}`);
      lines.push(`    support_count: ${t.support_count}`);
      lines.push(`    description: ${escapeYamlScalar(t.description)}`);
      if (t.synonyms.length > 0) {
        lines.push(`    synonyms: [${t.synonyms.slice(0, 10).map(escapeYamlScalar).join(", ")}]`);
      }
      if (t.certification_receipt) {
        lines.push(`    certification_receipt: ${escapeYamlScalar(t.certification_receipt)}`);
      }
      if (t.provenance.length > 0) {
        lines.push(`    provenance: [${t.provenance.slice(0, 4).map((p) => escapeYamlScalar(p.path)).join(", ")}]`);
      }
    }

    lines.push("relations:");
    for (const r of relations) {
      lines.push(`  - from: ${escapeYamlScalar(r.from_id)}`);
      lines.push(`    predicate: ${escapeYamlScalar(r.predicate)}`);
      lines.push(`    to: ${escapeYamlScalar(r.to_id)}`);
      lines.push(`    confirmed: ${r.confirmed ? "true" : "false"}`);
      lines.push(`    support_count: ${r.support_count}`);
      lines.push(`    confidence: ${r.confidence.toFixed(2)}`);
    }

    lines.push("metrics:");
    for (const m of status.metrics) {
      lines.push(`  - id: ${escapeYamlScalar(m.id)}`);
      lines.push(`    name: ${escapeYamlScalar(m.name)}`);
      lines.push(`    family_id: ${escapeYamlScalar(m.family_id)}`);
      lines.push(`    unit: ${escapeYamlScalar(m.unit)}`);
      lines.push(`    value: ${m.value}`);
      lines.push(`    definition: ${escapeYamlScalar(m.definition)}`);
    }

    return {
      contentType: "text/yaml; charset=utf-8",
      filename: "kizuki-ontology.ossie.yaml",
      body: redactSecrets(lines.join("\n")) + "\n",
    };
  }
}
