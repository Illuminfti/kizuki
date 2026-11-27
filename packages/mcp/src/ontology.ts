import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  ServeError,
  resolvePrincipal,
  toolAllowed,
} from "@kizuki/core";
import type { Principal, Sensitivity, ServeContext, Tool } from "@kizuki/core";
import { createRedactor } from "@kizuki/core/internal";
import {
  ONTOLOGY_SCHEMA_VERSION,
  OntologyStore,
  checkAnswerable,
  compileOntologyFromVault,
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

function requireLivePrincipal(
  ctx: ServeContext,
  requiredTools: readonly Tool[],
): Principal {
  const principal = resolvePrincipal(ctx.db, ctx.principal);
  if (principal === null) throw new ServeError("unknown_agent", "unknown agent");
  if (principal.kind !== "owner") {
    for (const req of requiredTools) {
      if (!toolAllowed(principal.grant, req)) {
        throw new ServeError("tool_not_granted", "tool not granted");
      }
    }
  }
  return principal;
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
 * Strictly read-only, scope-enforced inspection of an existing `ontology.sqlite`.
 * Never creates or modifies any database or WAL/SHM file.
 */
function inspectStatusReadOnly(
  dbPath: string,
  principal: Principal,
  ceiling: OntologySensitivity,
  allowedSubjects: readonly string[] | null,
): Record<string, unknown> {
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

    const visibleTermIds = new Set<string>();
    let certifiedTermCount = 0;

    if (tables.has("ontology_terms")) {
      const rows = db
        .query<
          {
            term_id: string;
            canonical_name: string;
            normalized_key: string;
            domain: string;
            synonyms_json: string;
            provenance_json: string;
            sensitivity: string;
            certification: string;
          },
          []
        >(
          "SELECT term_id, canonical_name, normalized_key, domain, synonyms_json, provenance_json, sensitivity, certification FROM ontology_terms",
        )
        .all();

      for (const row of rows) {
        const sens = normalizeOntologySensitivity(row.sensitivity, "private");
        if (!withinOntologySensitivity(sens, ceiling)) continue;
        const okSubject = termMatchesAllowedSubjects(
          {
            termId: row.term_id,
            normalizedKey: row.normalized_key,
            canonicalName: row.canonical_name,
            domain: row.domain,
            synonyms: parseJsonStringArray(row.synonyms_json),
            provenance: parseJsonStringArray(row.provenance_json),
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

  const getExistingOnDiskStore = (): OntologyStore | null => {
    if (ownedStore !== null) return ownedStore;
    if (!existsSync(dbPath)) return null;
    ownedStore = openOntologyStore(dbPath);
    return ownedStore;
  };

  const getWritableStore = (): OntologyStore => {
    if (ownedStore === null) {
      ownedStore = openOntologyStore(dbPath);
    }
    if (
      ownedStore.getMeta("last_compiled_at") === null &&
      ownedStore.listTerms().length === 0
    ) {
      compileOntologyFromVault(ctx.db, ownedStore);
    }
    return ownedStore;
  };

  const withReadableStore = <T>(
    run: (store: OntologyStore, compiledOnDisk: boolean) => T,
  ): T => {
    const existing = getExistingOnDiskStore();
    if (existing !== null) {
      return run(existing, true);
    }
    // Auto-compile in-memory without mutating the vault on disk.
    const memStore = OntologyStore.openInMemory();
    try {
      compileOntologyFromVault(ctx.db, memStore);
      return run(memStore, false);
    } finally {
      memStore.close();
    }
  };

  const handleStatus = async (
    _args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const principal = requireLivePrincipal(ctx, ["system_health"]);
    const { ceiling, allowedSubjects } = scopeForPrincipal(principal);
    return inspectStatusReadOnly(dbPath, principal, ceiling, allowedSubjects);
  };

  const handleSearch = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const principal = requireLivePrincipal(ctx, ["search", "context_packet"]);
    const { ceiling, allowedSubjects } = scopeForPrincipal(principal);
    const redactor = createRedactor(principal, ctx.servingSecrets);

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

    return withReadableStore((store, compiledOnDisk) => {
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
      return {
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
        relations: result.relations.map((rel) => redactRelation(rel, redactor)),
        join_paths: result.joinPaths.map((jp) => redactJoinPath(jp, redactor)),
        metrics: result.metrics.map((m) => redactMetric(m, redactor)),
        rendered,
        truncated: result.truncated,
        total_chars: rendered.length,
      };
    });
  };

  const handleCheckAnswerable = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const principal = requireLivePrincipal(ctx, ["search", "context_packet"]);
    const { ceiling, allowedSubjects } = scopeForPrincipal(principal);
    const redactor = createRedactor(principal, ctx.servingSecrets);

    const question = asString(args["question"]);
    if (question === undefined || question.length > 1024) {
      throw new ServeError("invalid_arguments", "invalid arguments: question");
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

    return withReadableStore((store, compiledOnDisk) => {
      const report = checkAnswerable(store, question, {
        sensitivityCeiling: ceiling,
        allowedSubjects,
        maxJoinHops,
        ...(minTokenOverlap !== undefined ? { minTokenOverlap } : {}),
      });
      return {
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
        join_paths: report.joinPaths.map((jp) => redactJoinPath(jp, redactor)),
        suggested_metrics: report.suggestedMetrics.map((m) =>
          redactMetric(m, redactor),
        ),
        clarification:
          report.clarification === null
            ? null
            : redactor.text(report.clarification),
      };
    });
  };

  const handleCertify = async (
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const principal = requireLivePrincipal(ctx, ["propose"]);
    const { ceiling, allowedSubjects } = scopeForPrincipal(principal);
    const redactor = createRedactor(principal, ctx.servingSecrets);

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
      typeof args["description"] === "string" ? args["description"] : undefined;
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

    const store = getWritableStore();
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
              s.toLowerCase() === lookup || normalizeTermKey(s) === lookupNorm,
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
      principal.kind === "owner" ? "owner" : `agent:${principal.agent.name}`;
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

    return {
      schema: "kizuki.ontology-certify/v1",
      ceiling,
      term: redactTerm(result.term, redactor),
      receipt: redactReceipt(result.receipt, redactor),
    };
  };

  const close = (): void => {
    if (ownedStore !== null) {
      ownedStore.close();
      ownedStore = null;
    }
  };

  return {
    handleStatus,
    handleSearch,
    handleCheckAnswerable,
    handleCertify,
    close,
  };
}
