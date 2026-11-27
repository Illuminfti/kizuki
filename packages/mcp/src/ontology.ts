import { Database } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import {
  ServeError,
  gate,
  toolAllowed,
} from "@kizuki/core";
import type { AuditItem, Principal, Sensitivity, ServeContext } from "@kizuki/core";
import { createRedactor } from "@kizuki/core/internal";
import {
  ONTOLOGY_SCHEMA_VERSION,
  OntologyStore,
  checkAnswerable,
  compileOntologyFromVault,
  computeVaultOntologyFingerprint,
  dedupeStrings,
  defaultOntologyDbPath,
  normalizeOntologySensitivity,
  normalizeTermKey,
  openOntologyStore,
  retrieveOntology,
  termMatchesAllowedSubjects,
  withinOntologySensitivity,
} from "@kizuki/ontology";
import type {
  JoinPath,
  OntologyAttribute,
  OntologyCertification,
  OntologyCertificationReceipt,
  OntologyMetric,
  OntologyRelation,
  OntologyRetrievePurpose,
  OntologyScopeOptions,
  OntologySensitivity,
  OntologyTerm,
} from "@kizuki/ontology";

export const ONTOLOGY_TOOL_NAMES = [
  "ontology_status",
  "ontology_search",
  "ontology_check_answerable",
  "ontology_certify",
] as const;

export type OntologyToolName = (typeof ONTOLOGY_TOOL_NAMES)[number];

export function isOntologyToolName(name: string): name is OntologyToolName {
  return (ONTOLOGY_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Zero-widening derived grants: every ontology tool is authorized strictly by
 * existing core grants already held by the principal.
 */
export function ontologyToolAllowed(
  principal: Principal,
  tool: OntologyToolName,
): boolean {
  if (principal.kind === "owner") return true;
  const grant = principal.grant;
  switch (tool) {
    case "ontology_status":
      return toolAllowed(grant, "system_health");
    case "ontology_search":
      return toolAllowed(grant, "search") && toolAllowed(grant, "context_packet");
    case "ontology_check_answerable":
      return toolAllowed(grant, "search") && toolAllowed(grant, "context_packet");
    case "ontology_certify":
      return toolAllowed(grant, "propose");
  }
}

function assertNoActivePurgeDiscovery(db: Database): void {
  const hasTable =
    db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'purge_batches'",
      )
      .get() !== null;
  if (!hasTable) return;
  const pending = db
    .query<{ batch_id: string }, []>(
      "SELECT batch_id FROM purge_batches WHERE state != 'ready' LIMIT 1",
    )
    .get();
  if (pending !== null) {
    throw new ServeError("held", "canon unavailable during purge recovery");
  }
}

function readPersistedFingerprint(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const hasMeta =
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ontology_meta'",
        )
        .get() !== null;
    if (!hasMeta) return null;
    return (
      db
        .query<{ value: string }, [string]>(
          "SELECT value FROM ontology_meta WHERE key = ?",
        )
        .get("vault_fingerprint")?.value ?? null
    );
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function toOntologySensitivity(s: Sensitivity): OntologySensitivity {
  return s;
}

function scopeForPrincipal(principal: Principal): {
  ceiling: OntologySensitivity;
  allowedSubjects: readonly string[] | null;
} {
  const ceiling = toOntologySensitivity(principal.grant.ceiling);
  const allowedSubjects =
    principal.kind === "owner" ? null : principal.grant.subjects;
  return { ceiling, allowedSubjects };
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseJsonStringMap(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

interface TextRedactor {
  text(value: string): string;
}

function redactAttribute(
  attr: OntologyAttribute,
  redactor: TextRedactor,
): OntologyAttribute {
  const out: OntologyAttribute = { name: redactor.text(attr.name) };
  if (attr.kind !== undefined) out.kind = redactor.text(attr.kind);
  if (attr.description !== undefined) {
    out.description = redactor.text(attr.description);
  }
  if (attr.values !== undefined && attr.values.length > 0) {
    out.values = attr.values.map((v) => redactor.text(v));
  }
  return out;
}

function redactTerm(
  term: OntologyTerm,
  redactor: TextRedactor,
): Record<string, unknown> {
  return {
    term_id: redactor.text(term.termId),
    canonical_name: redactor.text(term.canonicalName),
    normalized_key: redactor.text(term.normalizedKey),
    kind: redactor.text(term.kind),
    domain: redactor.text(term.domain),
    description: redactor.text(term.description),
    synonyms: term.synonyms.map((s) => redactor.text(s)),
    subjects: term.subjects.map((s) => redactor.text(s)),
    attributes: term.attributes.map((a) => redactAttribute(a, redactor)),
    provenance: term.provenance.map((p) => redactor.text(p)),
    sensitivity: term.sensitivity,
    evidence_count: term.evidenceCount,
    certification: term.certification,
    certified_by: term.certifiedBy === null ? null : redactor.text(term.certifiedBy),
    certified_at: term.certifiedAt,
    family_id: term.familyId === null ? null : redactor.text(term.familyId),
    updated_at: term.updatedAt,
  };
}

function redactRelation(
  rel: OntologyRelation,
  redactor: TextRedactor,
): Record<string, unknown> {
  return {
    relation_id: redactor.text(rel.relationId),
    source_term_id: redactor.text(rel.sourceTermId),
    target_term_id: redactor.text(rel.targetTermId),
    relation_kind: redactor.text(rel.relationKind),
    evidence_count: rel.evidenceCount,
    confidence: rel.confidence,
    is_default_join: rel.isDefaultJoin,
    support_refs: rel.supportRefs.map((r) => redactor.text(r)),
    sensitivity: rel.sensitivity,
    updated_at: rel.updatedAt,
  };
}

function redactJoinPath(
  path: JoinPath,
  redactor: TextRedactor,
): Record<string, unknown> {
  return {
    from_term_id: redactor.text(path.fromTermId),
    to_term_id: redactor.text(path.toTermId),
    hops: path.hops,
    node_ids: path.nodeIds.map((id) => redactor.text(id)),
    path_string: redactor.text(path.pathString),
    total_evidence: path.totalEvidence,
    all_default_joins: path.allDefaultJoins,
    max_sensitivity: path.maxSensitivity,
    edges: path.edges.map((edge) => ({
      relation_id: redactor.text(edge.relationId),
      from_term_id: redactor.text(edge.fromTermId),
      to_term_id: redactor.text(edge.toTermId),
      relation_kind: redactor.text(edge.relationKind),
      direction: edge.direction,
      evidence_count: edge.evidenceCount,
      confidence: edge.confidence,
      is_default_join: edge.isDefaultJoin,
      sensitivity: edge.sensitivity,
    })),
  };
}

function redactMetric(
  metric: OntologyMetric,
  redactor: TextRedactor,
): Record<string, unknown> {
  return {
    metric_id: redactor.text(metric.metricId),
    name: redactor.text(metric.name),
    term_id: metric.termId === null ? null : redactor.text(metric.termId),
    description: redactor.text(metric.description),
    expression: redactor.text(metric.expression),
    grain: redactor.text(metric.grain),
    certification: metric.certification,
    sensitivity: metric.sensitivity,
    updated_at: metric.updatedAt,
  };
}

function redactReceipt(
  receipt: OntologyCertificationReceipt,
  redactor: TextRedactor,
): Record<string, unknown> {
  return {
    receipt_id: redactor.text(receipt.receiptId),
    target_kind: receipt.targetKind,
    target_id: redactor.text(receipt.targetId),
    action: receipt.action,
    actor: redactor.text(receipt.actor),
    created_at: receipt.createdAt,
  };
}

/**
 * Computes scoped status payload from an open `OntologyStore` (such as a fresh
 * in-memory fallback compiled when persisted `ontology.sqlite` is stale).
 */
function inspectStatusFromStore(
  store: OntologyStore,
  dbPath: string,
  principal: Principal,
  ceiling: OntologySensitivity,
  allowedSubjects: readonly string[] | null,
  compiled: boolean,
): Record<string, unknown> {
  const scope: OntologyScopeOptions = {
    sensitivityCeiling: ceiling,
    allowedSubjects,
  };
  const visibleTerms = store.listTerms(scope);
  const visibleTermIds = new Set(visibleTerms.map((t) => t.termId));
  const certifiedTermCount = visibleTerms.filter(
    (t) => t.certification === "certified",
  ).length;
  const visibleRelations = store.listRelations(scope);
  const defaultJoinCount = visibleRelations.filter((r) => r.isDefaultJoin).length;
  const visibleMetrics = store.listMetrics(scope);
  const visibleMetricIds = new Set(visibleMetrics.map((m) => m.metricId));
  const certifiedMetricCount = visibleMetrics.filter(
    (m) => m.certification === "certified",
  ).length;

  let familyCount = 0;
  for (const fam of store.listTermFamilies()) {
    if (
      principal.kind === "owner" ||
      Object.keys(fam.members).some((tid) => visibleTermIds.has(tid))
    ) {
      familyCount += 1;
    }
  }

  let certificationReceiptCount = 0;
  for (const receipt of store.listCertifications()) {
    if (
      principal.kind === "owner" ||
      (receipt.targetKind === "term" && visibleTermIds.has(receipt.targetId)) ||
      (receipt.targetKind === "metric" && visibleMetricIds.has(receipt.targetId))
    ) {
      certificationReceiptCount += 1;
    }
  }

  return {
    schema: "kizuki.ontology-status/v1",
    compiled,
    ceiling,
    ...(principal.kind === "owner" ? { db_path: dbPath } : {}),
    term_count: visibleTerms.length,
    certified_term_count: certifiedTermCount,
    draft_term_count: visibleTerms.length - certifiedTermCount,
    family_count: familyCount,
    relation_count: visibleRelations.length,
    default_join_count: defaultJoinCount,
    metric_count: visibleMetrics.length,
    certified_metric_count: certifiedMetricCount,
    certification_receipt_count: certificationReceiptCount,
    last_compiled_at: compiled ? store.getMeta("last_compiled_at") : null,
    schema_version: store.getMeta("schema_version") ?? ONTOLOGY_SCHEMA_VERSION,
  };
}

/**
 * Strictly read-only, scope-enforced inspection of an existing `ontology.sqlite`.
 * Never creates or modifies any database or WAL/SHM file.
 * Returns `null` when the on-disk file exists but its `vault_fingerprint` does
 * not match `liveFingerprint` so the caller can recompile fresh in-memory.
 */
function inspectStatusReadOnly(
  dbPath: string,
  principal: Principal,
  ceiling: OntologySensitivity,
  allowedSubjects: readonly string[] | null,
  liveFingerprint: string,
): Record<string, unknown> | null {
  if (!existsSync(dbPath)) {
    return {
      schema: "kizuki.ontology-status/v1",
      compiled: false,
      ceiling,
      ...(principal.kind === "owner" ? { db_path: dbPath } : {}),
      term_count: 0,
      certified_term_count: 0,
      draft_term_count: 0,
      family_count: 0,
      relation_count: 0,
      default_join_count: 0,
      metric_count: 0,
      certified_metric_count: 0,
      certification_receipt_count: 0,
      last_compiled_at: null,
      schema_version: ONTOLOGY_SCHEMA_VERSION,
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = new Set(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .all()
        .map((r) => r.name),
    );

    const metaOf = (key: string): string | null => {
      if (!tables.has("ontology_meta")) return null;
      return (
        db
          .query<{ value: string }, [string]>(
            "SELECT value FROM ontology_meta WHERE key = ?",
          )
          .get(key)?.value ?? null
      );
    };

    const persistedFingerprint = metaOf("vault_fingerprint");
    if (persistedFingerprint !== liveFingerprint) {
      return null;
    }

    const visibleTermIds = new Set<string>();
    let certifiedTermCount = 0;

    if (tables.has("ontology_terms")) {
      const termCols = new Set(
        db
          .query<{ name: string }, []>(
            "SELECT name FROM pragma_table_info('ontology_terms')",
          )
          .all()
          .map((c) => c.name),
      );
      const hasSubjects = termCols.has("subjects_json");
      const rows = db
        .query<
          {
            term_id: string;
            subjects_json: string;
            sensitivity: string;
            certification: string;
          },
          []
        >(
          hasSubjects
            ? "SELECT term_id, subjects_json, sensitivity, certification FROM ontology_terms"
            : "SELECT term_id, '[]' AS subjects_json, sensitivity, certification FROM ontology_terms",
        )
        .all();

      for (const row of rows) {
        const sens = normalizeOntologySensitivity(row.sensitivity, "private");
        if (!withinOntologySensitivity(sens, ceiling)) continue;
        const okSubject = termMatchesAllowedSubjects(
          {
            subjects: parseJsonStringArray(row.subjects_json),
          },
          allowedSubjects,
        );
        if (!okSubject) continue;
        visibleTermIds.add(row.term_id);
        if (row.certification === "certified") certifiedTermCount += 1;
      }
    }

    let relationCount = 0;
    let defaultJoinCount = 0;
    if (tables.has("ontology_relations")) {
      const rows = db
        .query<
          {
            source_term_id: string;
            target_term_id: string;
            is_default_join: number;
            sensitivity: string;
          },
          []
        >(
          "SELECT source_term_id, target_term_id, is_default_join, sensitivity FROM ontology_relations",
        )
        .all();
      for (const row of rows) {
        const sens = normalizeOntologySensitivity(row.sensitivity, "private");
        if (!withinOntologySensitivity(sens, ceiling)) continue;
        if (
          !visibleTermIds.has(row.source_term_id) ||
          !visibleTermIds.has(row.target_term_id)
        ) {
          continue;
        }
        relationCount += 1;
        if (row.is_default_join === 1) defaultJoinCount += 1;
      }
    }

    const visibleMetricIds = new Set<string>();
    let certifiedMetricCount = 0;
    if (tables.has("ontology_metrics")) {
      const rows = db
        .query<
          {
            metric_id: string;
            term_id: string | null;
            certification: string;
            sensitivity: string;
          },
          []
        >(
          "SELECT metric_id, term_id, certification, sensitivity FROM ontology_metrics",
        )
        .all();
      for (const row of rows) {
        const sens = normalizeOntologySensitivity(row.sensitivity, "private");
        if (!withinOntologySensitivity(sens, ceiling)) continue;
        if (allowedSubjects !== null) {
          if (row.term_id !== null) {
            if (!visibleTermIds.has(row.term_id)) continue;
          } else if (allowedSubjects.length === 0) {
            continue;
          }
        }
        visibleMetricIds.add(row.metric_id);
        if (row.certification === "certified") certifiedMetricCount += 1;
      }
    }

    let familyCount = 0;
    if (tables.has("ontology_term_families")) {
      const rows = db
        .query<{ members_json: string }, []>(
          "SELECT members_json FROM ontology_term_families",
        )
        .all();
      for (const row of rows) {
        if (principal.kind === "owner") {
          familyCount += 1;
          continue;
        }
        const members = parseJsonStringMap(row.members_json);
        if (Object.keys(members).some((tid) => visibleTermIds.has(tid))) {
          familyCount += 1;
        }
      }
    }

    let certificationReceiptCount = 0;
    if (tables.has("ontology_certifications")) {
      if (principal.kind === "owner") {
        certificationReceiptCount =
          db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM ontology_certifications",
            )
            .get()?.count ?? 0;
      } else {
        const rows = db
          .query<{ target_kind: string; target_id: string }, []>(
            "SELECT target_kind, target_id FROM ontology_certifications",
          )
          .all();
        for (const row of rows) {
          if (
            (row.target_kind === "term" && visibleTermIds.has(row.target_id)) ||
            (row.target_kind === "metric" && visibleMetricIds.has(row.target_id))
          ) {
            certificationReceiptCount += 1;
          }
        }
      }
    }

    const lastCompiledAt = metaOf("last_compiled_at");
    const schemaVersion = metaOf("schema_version") ?? ONTOLOGY_SCHEMA_VERSION;
    const termCount = visibleTermIds.size;
    const metricCount = visibleMetricIds.size;
    const compiled =
      lastCompiledAt !== null || termCount > 0 || metricCount > 0;

    return {
      schema: "kizuki.ontology-status/v1",
      compiled,
      ceiling,
      ...(principal.kind === "owner" ? { db_path: dbPath } : {}),
      term_count: termCount,
      certified_term_count: certifiedTermCount,
      draft_term_count: termCount - certifiedTermCount,
      family_count: familyCount,
      relation_count: relationCount,
      default_join_count: defaultJoinCount,
      metric_count: metricCount,
      certified_metric_count: certifiedMetricCount,
      certification_receipt_count: certificationReceiptCount,
      last_compiled_at: lastCompiledAt,
      schema_version: schemaVersion,
    };
  } finally {
    db.close();
  }
}

export interface OntologyBridge {
  handleStatus: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  handleSearch: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  handleCheckAnswerable: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  handleCertify: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}

export function createOntologyBridge(ctx: ServeContext): OntologyBridge {
  const dbPath = defaultOntologyDbPath(ctx.vaultPath);
  let ownedStore: OntologyStore | null = null;
  let ownedStoreIno: number | null = null;

  const currentIno = (): number | null => {
    if (!existsSync(dbPath)) return null;
    try {
      return statSync(dbPath).ino;
    } catch {
      return null;
    }
  };

  const resetOwnedStore = (): void => {
    if (ownedStore !== null) {
      ownedStore.close();
      ownedStore = null;
    }
    ownedStoreIno = null;
  };

  const syncOwnedStoreHandle = (): void => {
    if (ownedStore === null) return;
    const ino = currentIno();
    if (ino === null || ino !== ownedStoreIno) {
      resetOwnedStore();
    }
  };

  const getFreshOnDiskStore = (liveFingerprint: string): OntologyStore | null => {
    syncOwnedStoreHandle();
    if (!existsSync(dbPath)) return null;
    if (ownedStore !== null) {
      return ownedStore.getMeta("vault_fingerprint") === liveFingerprint
        ? ownedStore
        : null;
    }
    if (readPersistedFingerprint(dbPath) !== liveFingerprint) {
      return null;
    }
    ownedStore = openOntologyStore(dbPath);
    ownedStoreIno = currentIno();
    return ownedStore;
  };

  const getWritableFreshStore = (liveDb: Database): OntologyStore => {
    syncOwnedStoreHandle();
    const liveFingerprint = computeVaultOntologyFingerprint(liveDb);
    if (ownedStore === null) {
      ownedStore = openOntologyStore(dbPath);
      ownedStoreIno = currentIno();
    }
    if (
      ownedStore.getMeta("vault_fingerprint") !== liveFingerprint ||
      (ownedStore.getMeta("last_compiled_at") === null &&
        ownedStore.listTerms().length === 0)
    ) {
      compileOntologyFromVault(liveDb, ownedStore, {
        vaultFingerprint: liveFingerprint,
      });
    }
    return ownedStore;
  };

  const withReadableStore = <T>(
    liveDb: Database,
    run: (store: OntologyStore, compiledOnDisk: boolean) => T,
  ): T => {
    const liveFingerprint = computeVaultOntologyFingerprint(liveDb);
    const existing = getFreshOnDiskStore(liveFingerprint);
    if (existing !== null) {
      return run(existing, true);
    }
    // Compile fresh in-memory without mutating the vault on disk.
    const memStore = OntologyStore.openInMemory();
    try {
      compileOntologyFromVault(liveDb, memStore, {
        vaultFingerprint: liveFingerprint,
      });
      return run(memStore, false);
    } finally {
      memStore.close();
    }
  };

  const handleStatus = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const envelope = gate(
      ctx,
      "system_health",
      { ontology_tool: "ontology_status", ...args },
      ({ ctx: live }) => {
        assertNoActivePurgeDiscovery(live.db);
        syncOwnedStoreHandle();
        const { ceiling, allowedSubjects } = scopeForPrincipal(live.principal);
        const liveFingerprint = computeVaultOntologyFingerprint(live.db);
        const diskStatus = inspectStatusReadOnly(
          dbPath,
          live.principal,
          ceiling,
          allowedSubjects,
          liveFingerprint,
        );
        if (diskStatus !== null) {
          return {
            canon: [],
            quoted: [],
            withheld: [],
            data: diskStatus,
          };
        }
        const memStore = OntologyStore.openInMemory();
        try {
          compileOntologyFromVault(live.db, memStore, {
            vaultFingerprint: liveFingerprint,
          });
          return {
            canon: [],
            quoted: [],
            withheld: [],
            data: inspectStatusFromStore(
              memStore,
              dbPath,
              live.principal,
              ceiling,
              allowedSubjects,
              false,
            ),
          };
        } finally {
          memStore.close();
        }
      },
    );
    return envelope.data!;
  };

  const handleSearch = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const envelope = gate(
      ctx,
      "search",
      { ontology_tool: "ontology_search", ...args },
      ({ ctx: live }) => {
        if (
          live.principal.kind !== "owner" &&
          !toolAllowed(live.principal.grant, "context_packet")
        ) {
          throw new ServeError("tool_not_granted", "tool not granted");
        }
        assertNoActivePurgeDiscovery(live.db);
        const { ceiling, allowedSubjects } = scopeForPrincipal(live.principal);
        const redactor =
          live.redactor ?? createRedactor(live.principal, live.servingSecrets);

        const query = asString(args["query"]);
        if (query === undefined || query.length > 512) {
          throw new ServeError("invalid_arguments", "invalid arguments: query");
        }
        const rawPurpose = args["purpose"];
        const purpose: OntologyRetrievePurpose =
          rawPurpose === "information" ||
          rawPurpose === "relations" ||
          rawPurpose === "metrics" ||
          rawPurpose === "all"
            ? rawPurpose
            : "all";
        const rawMaxChars = args["max_chars"];
        const maxChars =
          typeof rawMaxChars === "number" &&
          Number.isInteger(rawMaxChars) &&
          rawMaxChars >= 64 &&
          rawMaxChars <= 16_000
            ? rawMaxChars
            : 4000;
        const rawLimit = args["limit"];
        const limit =
          typeof rawLimit === "number" &&
          Number.isInteger(rawLimit) &&
          rawLimit >= 1 &&
          rawLimit <= 50
            ? rawLimit
            : 20;
        const rawFullHits = args["full_hits"];
        const fullHits =
          typeof rawFullHits === "number" &&
          Number.isInteger(rawFullHits) &&
          rawFullHits >= 0 &&
          rawFullHits <= 10
            ? rawFullHits
            : 2;
        const rawMaxHops = args["max_join_hops"];
        const maxJoinHops =
          typeof rawMaxHops === "number" &&
          Number.isInteger(rawMaxHops) &&
          rawMaxHops >= 1 &&
          rawMaxHops <= 12
            ? rawMaxHops
            : 6;

        return withReadableStore(live.db, (store, compiledOnDisk) => {
          const result = retrieveOntology(store, query, {
            purpose,
            maxChars,
            limit,
            fullHits,
            maxJoinHops,
            sensitivityCeiling: ceiling,
            allowedSubjects,
          });
          const rendered = redactor.text(result.rendered);
          const auditServed: AuditItem[] = result.terms.map((entry) => ({
            id: entry.term.termId,
            sensitivity: entry.term.sensitivity,
            taint: null,
            authority: entry.term.certification,
            provenance_count: entry.term.provenance.length,
          }));
          return {
            canon: [],
            quoted: [],
            withheld: [],
            audit_served: auditServed,
            data: {
              schema: "kizuki.ontology-search/v1",
              compiled: compiledOnDisk,
              ceiling,
              query: redactor.text(result.query),
              purpose: result.purpose,
              terms: result.terms.map((entry) => ({
                term: redactTerm(entry.term, redactor),
                score: entry.score,
                tier: entry.tier,
              })),
              relations: result.relations.map((rel) =>
                redactRelation(rel, redactor),
              ),
              join_paths: result.joinPaths.map((jp) =>
                redactJoinPath(jp, redactor),
              ),
              metrics: result.metrics.map((m) => redactMetric(m, redactor)),
              rendered,
              truncated: result.truncated,
              total_chars: rendered.length,
            },
          };
        });
      },
    );
    return envelope.data!;
  };

  const handleCheckAnswerable = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const envelope = gate(
      ctx,
      "search",
      { ontology_tool: "ontology_check_answerable", ...args },
      ({ ctx: live }) => {
        if (
          live.principal.kind !== "owner" &&
          !toolAllowed(live.principal.grant, "context_packet")
        ) {
          throw new ServeError("tool_not_granted", "tool not granted");
        }
        assertNoActivePurgeDiscovery(live.db);
        const { ceiling, allowedSubjects } = scopeForPrincipal(live.principal);
        const redactor =
          live.redactor ?? createRedactor(live.principal, live.servingSecrets);

        const question = asString(args["question"]);
        if (question === undefined || question.length > 1024) {
          throw new ServeError(
            "invalid_arguments",
            "invalid arguments: question",
          );
        }
        const rawMaxHops = args["max_join_hops"];
        const maxJoinHops =
          typeof rawMaxHops === "number" &&
          Number.isInteger(rawMaxHops) &&
          rawMaxHops >= 1 &&
          rawMaxHops <= 12
            ? rawMaxHops
            : 6;
        const rawOverlap = args["min_token_overlap"];
        const minTokenOverlap =
          typeof rawOverlap === "number" &&
          Number.isFinite(rawOverlap) &&
          rawOverlap >= 0 &&
          rawOverlap <= 1
            ? rawOverlap
            : undefined;

        return withReadableStore(live.db, (store, compiledOnDisk) => {
          const report = checkAnswerable(store, question, {
            sensitivityCeiling: ceiling,
            allowedSubjects,
            maxJoinHops,
            ...(minTokenOverlap !== undefined ? { minTokenOverlap } : {}),
          });
          const auditServed: AuditItem[] = report.resolved.map((entry) => ({
            id: entry.termId,
            sensitivity: entry.sensitivity,
            taint: null,
            authority: entry.certification,
            provenance_count: 0,
          }));
          return {
            canon: [],
            quoted: [],
            withheld: [],
            audit_served: auditServed,
            data: {
              schema: "kizuki.ontology-check-answerable/v1",
              compiled: compiledOnDisk,
              ceiling,
              question: redactor.text(report.question),
              candidates: report.candidates.map((c) => redactor.text(c)),
              coverage: report.coverage,
              verdict: report.verdict,
              resolved: report.resolved.map((entry) => ({
                query_concept: redactor.text(entry.queryConcept),
                term_id: redactor.text(entry.termId),
                canonical_name: redactor.text(entry.canonicalName),
                matched_by: entry.matchedBy,
                certification: entry.certification,
                score: entry.score,
                domain: redactor.text(entry.domain),
                sensitivity: entry.sensitivity,
              })),
              missing: report.missing.map((m) => redactor.text(m)),
              join_paths: report.joinPaths.map((jp) =>
                redactJoinPath(jp, redactor),
              ),
              suggested_metrics: report.suggestedMetrics.map((m) =>
                redactMetric(m, redactor),
              ),
              clarification:
                report.clarification === null
                  ? null
                  : redactor.text(report.clarification),
            },
          };
        });
      },
    );
    return envelope.data!;
  };

  const handleCertify = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const envelope = gate(
      ctx,
      "propose",
      { ontology_tool: "ontology_certify", ...args },
      ({ ctx: live }) => {
        assertNoActivePurgeDiscovery(live.db);
        const { ceiling, allowedSubjects } = scopeForPrincipal(live.principal);
        const redactor =
          live.redactor ?? createRedactor(live.principal, live.servingSecrets);

        const termIdArg = asString(args["term_id"]);
        const normalizedKeyArg = asString(args["normalized_key"]);
        if (termIdArg === undefined && normalizedKeyArg === undefined) {
          throw new ServeError(
            "invalid_arguments",
            "invalid arguments: term_id or normalized_key is required",
          );
        }

        const canonicalName = asString(args["canonical_name"]);
        const description =
          typeof args["description"] === "string"
            ? args["description"]
            : undefined;
        const rawSynonyms = args["synonyms"];
        const synonyms = Array.isArray(rawSynonyms)
          ? dedupeStrings(
              rawSynonyms.filter((s): s is string => typeof s === "string"),
            )
          : undefined;
        const domain = asString(args["domain"]);
        const kind = asString(args["kind"]);
        const rawCertification = args["certification"];
        const certification: OntologyCertification =
          rawCertification === "draft" ? "draft" : "certified";

        const store = getWritableFreshStore(live.db);
        const scope: OntologyScopeOptions = {
          sensitivityCeiling: ceiling,
          allowedSubjects,
        };

        // Resolve strictly within caller sensitivity ceiling & subject scope.
        let target: OntologyTerm | null = null;
        if (termIdArg !== undefined) {
          target =
            store.getTerm(termIdArg, scope) ??
            store.getTermByKey(termIdArg, scope);
        }
        if (target === null && normalizedKeyArg !== undefined) {
          target = store.getTermByKey(normalizedKeyArg, scope);
        }
        if (target === null) {
          const lookup = (termIdArg ?? normalizedKeyArg ?? "").toLowerCase();
          const lookupNorm = normalizeTermKey(lookup);
          for (const candidate of store.listTerms(scope)) {
            if (
              candidate.canonicalName.toLowerCase() === lookup ||
              candidate.synonyms.some(
                (s) =>
                  s.toLowerCase() === lookup ||
                  normalizeTermKey(s) === lookupNorm,
              )
            ) {
              target = candidate;
              break;
            }
          }
        }

        if (target === null) {
          throw new ServeError("not_found", "term not found");
        }

        const actor =
          live.principal.kind === "owner"
            ? "owner"
            : `agent:${live.principal.agent.name}`;
        const result = store.certifyTerm({
          termId: target.termId,
          actor,
          ...(canonicalName !== undefined ? { canonicalName } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(synonyms !== undefined ? { synonyms } : {}),
          ...(domain !== undefined ? { domain } : {}),
          ...(kind !== undefined ? { kind } : {}),
          certification,
        });

        const auditServed: AuditItem[] = [
          {
            id: result.term.termId,
            sensitivity: result.term.sensitivity,
            taint: null,
            authority: result.term.certification,
            provenance_count: result.term.provenance.length,
          },
        ];

        return {
          canon: [],
          quoted: [],
          withheld: [],
          audit_served: auditServed,
          audit_ids: { ontology_receipt_id: [result.receipt.receiptId] },
          data: {
            schema: "kizuki.ontology-certify/v1",
            ceiling,
            term: redactTerm(result.term, redactor),
            receipt: redactReceipt(result.receipt, redactor),
          },
        };
      },
    );
    return envelope.data!;
  };

  const close = (): void => {
    resetOwnedStore();
  };

  return {
    handleStatus,
    handleSearch,
    handleCheckAnswerable,
    handleCertify,
    close,
  };
}
