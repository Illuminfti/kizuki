import type { Database } from "bun:sqlite";
import { detectTermFamiliesFromOntology } from "./term-families";
import type { OntologyStore } from "./store";
import {
  dedupeStrings,
  maxOntologySensitivity,
  normalizeAttributes,
  normalizeOntologySensitivity,
  normalizeTermKey,
} from "./types";
import type {
  OntologyAttribute,
  OntologyMetric,
  OntologyRelation,
  OntologySensitivity,
  OntologyTerm,
} from "./types";

export interface CompilerEntityInput {
  readonly id?: string | undefined;
  readonly name: string;
  readonly kind?: string | undefined;
  readonly domain?: string | undefined;
  readonly description?: string | undefined;
  readonly synonyms?: readonly string[] | undefined;
  readonly attributes?: readonly (string | OntologyAttribute)[] | undefined;
  readonly provenance?: readonly string[] | undefined;
  readonly sensitivity?: OntologySensitivity | string | undefined;
  readonly evidenceCount?: number | undefined;
}

export interface CompilerPageInput {
  readonly id?: string | undefined;
  readonly title: string;
  readonly path?: string | undefined;
  readonly domain?: string | undefined;
  readonly kind?: string | undefined;
  readonly body?: string | undefined;
  readonly synonyms?: readonly string[] | undefined;
  readonly subjects?: readonly string[] | undefined;
  readonly provenance?: readonly string[] | undefined;
  readonly sensitivity?: OntologySensitivity | string | undefined;
}

export interface CompilerClaimInput {
  readonly claimId: string;
  readonly kind?: string | undefined;
  readonly subject?: string | null | undefined;
  readonly predicate?: string | null | undefined;
  readonly object?: string | null | undefined;
  readonly body?: string | undefined;
  readonly status?: string | undefined;
  readonly polarity?: string | undefined;
  readonly confidence?: number | undefined;
  readonly corroboration?: number | undefined;
  readonly sensitivity?: OntologySensitivity | string | undefined;
  readonly subjects?: readonly string[] | undefined;
  readonly provenance?: readonly string[] | undefined;
}

export interface CompilerEventInput {
  readonly eventId: string;
  readonly connectorId?: string | undefined;
  readonly kind?: string | undefined;
  readonly text?: string | undefined;
  readonly subjects?: readonly string[] | undefined;
  readonly sensitivity?: OntologySensitivity | string | undefined;
  readonly deleted?: boolean | undefined;
}

export interface CompilerLinkInput {
  readonly source: string;
  readonly target: string;
  readonly relationKind: string;
  readonly confidence?: number | undefined;
  readonly evidenceCount?: number | undefined;
  readonly supportRefs?: readonly string[] | undefined;
  readonly sensitivity?: OntologySensitivity | string | undefined;
}

export interface CompilerIdentityAliasInput {
  readonly subjectA: string;
  readonly subjectB: string;
  readonly score?: number | undefined;
  readonly status?: string | undefined;
}

export interface CompilerInputs {
  readonly entities?: readonly CompilerEntityInput[] | undefined;
  readonly pages?: readonly CompilerPageInput[] | undefined;
  readonly claims?: readonly CompilerClaimInput[] | undefined;
  readonly events?: readonly CompilerEventInput[] | undefined;
  readonly links?: readonly CompilerLinkInput[] | undefined;
  readonly identityAliases?: readonly CompilerIdentityAliasInput[] | undefined;
  readonly sourceTables?: readonly string[] | undefined;
}

export interface CompileOptions {
  readonly compiledAt?: string | undefined;
  readonly defaultDomain?: string | undefined;
  readonly includeBuiltInMetrics?: boolean | undefined;
  readonly minFamilyPairEvidence?: number | undefined;
}

export interface OntologyCompileReport {
  readonly compiledAt: string;
  readonly termsCompiled: number;
  readonly termsCreated: number;
  readonly termsUpdated: number;
  readonly preservedCertified: number;
  readonly familiesDetected: number;
  readonly relationsCompiled: number;
  readonly defaultJoinsSelected: number;
  readonly metricsCompiled: number;
  readonly sourceTables: string[];
}

interface TermAccumulator {
  termId: string;
  canonicalName: string;
  normalizedKey: string;
  kind: string;
  domain: string;
  description: string;
  synonyms: Set<string>;
  attributes: OntologyAttribute[];
  provenance: Set<string>;
  sensitivity: OntologySensitivity;
  evidenceCount: number;
}

interface RelationAccumulator {
  sourceTermId: string;
  targetTermId: string;
  relationKind: string;
  evidenceCount: number;
  confidenceSum: number;
  confidenceCount: number;
  maxConfidence: number;
  supportRefs: Set<string>;
  sensitivity: OntologySensitivity;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJsonStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === "string");
  }
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") return item;
          if (typeof item === "object" && item !== null) {
            const rec = item as Record<string, unknown>;
            if (typeof rec.id === "string") return rec.id;
            if (typeof rec.name === "string") return rec.name;
            if (typeof rec.subject === "string") return rec.subject;
          }
          return "";
        })
        .filter((s) => s.length > 0);
    }
  } catch {
    // Plain comma-separated fallback for synthetic tables.
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return [];
}

function parseJsonAttributes(raw: unknown): (string | OntologyAttribute)[] {
  if (Array.isArray(raw)) {
    return raw as (string | OntologyAttribute)[];
  }
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is string | OntologyAttribute =>
          typeof item === "string" ||
          (typeof item === "object" &&
            item !== null &&
            typeof (item as Record<string, unknown>).name === "string"),
      );
    }
  } catch {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return [];
}

function inferDomainFromSubject(raw: string, fallback: string): string {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0 && colonIdx < trimmed.length - 1) {
    const prefix = trimmed.slice(0, colonIdx).toLowerCase();
    if (/^[a-z][a-z0-9_-]*$/.test(prefix)) {
      return prefix;
    }
  }
  return fallback;
}

function inferDomainFromPath(path: string | undefined, fallback: string): string {
  if (path === undefined || path.trim().length === 0) return fallback;
  const cleaned = path.trim().replace(/^\/+/, "");
  const parts = cleaned.split("/").filter((p) => p.length > 0);
  const first = parts[0];
  if (first !== undefined && parts.length > 1) {
    return normalizeTermKey(first) || fallback;
  }
  return fallback;
}

function humanizeSubjectName(raw: string): string {
  const trimmed = raw.trim();
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx > 0 && colonIdx < trimmed.length - 1) {
    const after = trimmed.slice(colonIdx + 1).trim();
    if (after.length > 0) return after;
  }
  return trimmed;
}

function summarizeBody(body: string | undefined, maxLen = 220): string {
  if (body === undefined) return "";
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLen) return compact;
  return `${compact.slice(0, maxLen - 3).trimEnd()}...`;
}

function listTables(db: Database): Set<string> {
  const rows = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
    )
    .all();
  return new Set(rows.map((r) => r.name));
}

function tableColumns(db: Database, tableName: string): Set<string> {
  const rows = db
    .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
    .all(tableName);
  return new Set(rows.map((r) => r.name));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function extractInputsFromVault(vaultDb: Database): CompilerInputs {
  const tables = listTables(vaultDb);
  const sourceTables: string[] = [];
  const entities: CompilerEntityInput[] = [];
  const pages: CompilerPageInput[] = [];
  const claims: CompilerClaimInput[] = [];
  const events: CompilerEventInput[] = [];
  const links: CompilerLinkInput[] = [];
  const identityAliases: CompilerIdentityAliasInput[] = [];

  if (tables.has("entities")) {
    sourceTables.push("entities");
    const cols = tableColumns(vaultDb, "entities");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM entities")
      .all();
    for (const row of rows) {
      const name =
        asString(row.canonical_name) ??
        asString(row.name) ??
        asString(row.title) ??
        asString(row.entity_id) ??
        asString(row.id);
      if (name === undefined) continue;
      entities.push({
        id: asString(row.entity_id) ?? asString(row.id),
        name,
        kind: asString(row.kind) ?? asString(row.type) ?? "entity",
        domain: asString(row.domain),
        description: asString(row.description) ?? asString(row.summary),
        synonyms: parseJsonStringArray(
          cols.has("synonyms")
            ? row.synonyms
            : cols.has("synonyms_json")
              ? row.synonyms_json
              : row.aliases,
        ),
        attributes: parseJsonAttributes(
          cols.has("attributes") ? row.attributes : row.attributes_json,
        ),
        provenance: parseJsonStringArray(
          cols.has("provenance") ? row.provenance : row.provenance_json,
        ),
        sensitivity: asString(row.sensitivity),
        evidenceCount: asNumber(row.evidence_count),
      });
    }
  }

  if (tables.has("canon_pages")) {
    sourceTables.push("canon_pages");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM canon_pages")
      .all();
    for (const row of rows) {
      const title =
        asString(row.title) ??
        asString(row.name) ??
        asString(row.subject_key) ??
        asString(row.path) ??
        asString(row.rel_path);
      if (title === undefined) continue;
      pages.push({
        id: asString(row.page_id) ?? asString(row.id),
        title,
        path: asString(row.path) ?? asString(row.rel_path),
        domain: asString(row.domain) ?? asString(row.page_type),
        kind: asString(row.kind) ?? asString(row.page_type) ?? "page",
        body: asString(row.body) ?? asString(row.summary) ?? asString(row.content),
        synonyms: parseJsonStringArray(row.aliases ?? row.synonyms),
        subjects: parseJsonStringArray(row.subjects),
        provenance: parseJsonStringArray(row.provenance),
        sensitivity: asString(row.sensitivity),
      });
    }
  }

  if (tables.has("graph_pages")) {
    sourceTables.push("graph_pages");
    const rows = vaultDb
      .query<Record<string, unknown>, []>(
        "SELECT * FROM graph_pages WHERE active = 1",
      )
      .all();
    for (const row of rows) {
      const title =
        asString(row.title) ?? asString(row.rel_path) ?? asString(row.page_id);
      if (title === undefined) continue;
      pages.push({
        id: asString(row.page_id),
        title,
        path: asString(row.rel_path),
        kind: "page",
        provenance: parseJsonStringArray(row.provenance),
        sensitivity: asString(row.sensitivity),
      });
    }
  }

  if (tables.has("search_documents")) {
    sourceTables.push("search_documents");
    const cols = tableColumns(vaultDb, "search_documents");
    const sql = cols.has("scope")
      ? "SELECT * FROM search_documents WHERE scope = 'canon'"
      : "SELECT * FROM search_documents";
    const rows = vaultDb.query<Record<string, unknown>, []>(sql).all();
    for (const row of rows) {
      const title = asString(row.title) ?? asString(row.path) ?? asString(row.doc_id);
      if (title === undefined) continue;
      pages.push({
        id: asString(row.doc_id),
        title,
        path: asString(row.path),
        domain: asString(row.page_type),
        kind: asString(row.page_type) ?? "page",
        body: asString(row.body),
        subjects: parseJsonStringArray(row.subjects),
        provenance: parseJsonStringArray(row.provenance),
        sensitivity: asString(row.sensitivity),
      });
    }
  }

  if (tables.has("page_index") && !tables.has("graph_pages") && !tables.has("canon_pages")) {
    sourceTables.push("page_index");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM page_index")
      .all();
    for (const row of rows) {
      const title = asString(row.subject_key) ?? asString(row.rel_path) ?? asString(row.page_id);
      if (title === undefined) continue;
      pages.push({
        id: asString(row.page_id),
        title,
        path: asString(row.rel_path),
        kind: "page",
      });
    }
  }

  if (tables.has("claims")) {
    sourceTables.push("claims");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM claims")
      .all();
    for (const row of rows) {
      const claimId = asString(row.claim_id) ?? asString(row.id);
      if (claimId === undefined) continue;
      claims.push({
        claimId,
        kind: asString(row.kind),
        subject: asString(row.subject) ?? null,
        predicate: asString(row.predicate) ?? null,
        object: asString(row.object) ?? null,
        body: asString(row.body),
        status: asString(row.status) ?? "live",
        polarity: asString(row.polarity) ?? "positive",
        confidence: asNumber(row.confidence),
        corroboration: asNumber(row.corroboration),
        sensitivity: asString(row.sensitivity),
        subjects: parseJsonStringArray(row.subjects),
        provenance: parseJsonStringArray(row.provenance),
      });
    }
  }

  if (tables.has("events")) {
    sourceTables.push("events");
    const cols = tableColumns(vaultDb, "events");
    const sql = cols.has("deleted")
      ? "SELECT * FROM events WHERE deleted = 0"
      : "SELECT * FROM events";
    const rows = vaultDb.query<Record<string, unknown>, []>(sql).all();
    for (const row of rows) {
      const eventId = asString(row.event_id) ?? asString(row.id);
      if (eventId === undefined) continue;
      events.push({
        eventId,
        connectorId: asString(row.connector_id),
        kind: asString(row.kind),
        text: asString(row.text),
        subjects: parseJsonStringArray(row.subjects),
        sensitivity:
          asString(row.sensitivity) ?? asString(row.sensitivity_hint) ?? "private",
        deleted: row.deleted === 1 || row.deleted === true,
      });
    }
  }

  if (tables.has("claim_links")) {
    sourceTables.push("claim_links");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM claim_links")
      .all();
    for (const row of rows) {
      const source =
        asString(row.source_id) ??
        asString(row.source_term) ??
        asString(row.from_id) ??
        asString(row.src);
      const target =
        asString(row.target_id) ??
        asString(row.target_term) ??
        asString(row.to_id) ??
        asString(row.dst);
      const relationKind =
        asString(row.relation_kind) ??
        asString(row.relation) ??
        asString(row.predicate) ??
        asString(row.kind) ??
        "related_to";
      if (source === undefined || target === undefined) continue;
      links.push({
        source,
        target,
        relationKind,
        confidence: asNumber(row.confidence),
        evidenceCount: asNumber(row.evidence_count),
        supportRefs: parseJsonStringArray(row.support_refs ?? row.provenance),
        sensitivity: asString(row.sensitivity),
      });
    }
  }

  if (tables.has("graph_edges")) {
    sourceTables.push("graph_edges");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM graph_edges")
      .all();
    for (const row of rows) {
      const src = asString(row.src);
      const dst = asString(row.dst);
      const kind = asString(row.kind) ?? "links_to";
      if (src === undefined || dst === undefined) continue;
      const srcSens = normalizeOntologySensitivity(row.sensitivity, "private");
      const dstSens =
        row.dest_sensitivity !== null && row.dest_sensitivity !== undefined
          ? normalizeOntologySensitivity(row.dest_sensitivity, "private")
          : srcSens;
      links.push({
        source: src,
        target: dst,
        relationKind: kind,
        confidence: 0.9,
        evidenceCount: 1,
        supportRefs: parseJsonStringArray(row.provenance),
        sensitivity: maxOntologySensitivity(srcSens, dstSens),
      });
    }
  }

  if (tables.has("identity_links")) {
    sourceTables.push("identity_links");
    const rows = vaultDb
      .query<Record<string, unknown>, []>("SELECT * FROM identity_links")
      .all();
    for (const row of rows) {
      const subjectA = asString(row.subject_a);
      const subjectB = asString(row.subject_b);
      if (subjectA === undefined || subjectB === undefined) continue;
      identityAliases.push({
        subjectA,
        subjectB,
        score: asNumber(row.score),
        status: asString(row.status),
      });
    }
  }

  return {
    entities,
    pages,
    claims,
    events,
    links,
    identityAliases,
    sourceTables,
  };
}

/**
 * Compiles structured vault records into the local SQLite ontology store.
 *
 * Enforces the Sticky Certification Invariant: any existing term or metric with
 * `certification === "certified"` keeps its owner-certified canonical name,
 * description, synonyms, expression/grain, and certification metadata while
 * live evidence counts, attributes, provenance, and family links are refreshed.
 */
export function compileOntologyFromInputs(
  inputs: CompilerInputs,
  store: OntologyStore,
  opts: CompileOptions = {},
): OntologyCompileReport {
  const compiledAt = opts.compiledAt ?? nowIso();
  const defaultDomain = opts.defaultDomain ?? "general";
  const includeBuiltInMetrics = opts.includeBuiltInMetrics ?? true;

  // Snapshot existing store entries to enforce sticky certification.
  const existingTermsByKey = new Map<string, OntologyTerm>();
  const existingTermsById = new Map<string, OntologyTerm>();
  for (const term of store.listTerms()) {
    existingTermsByKey.set(term.normalizedKey, term);
    existingTermsById.set(term.termId, term);
  }
  const existingMetricsByName = new Map<string, OntologyMetric>();
  for (const metric of store.listMetrics()) {
    existingMetricsByName.set(metric.name, metric);
  }

  const termsByKey = new Map<string, TermAccumulator>();
  const aliasToKey = new Map<string, string>();

  const registerAlias = (raw: string | undefined, key: string): void => {
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    aliasToKey.set(trimmed.toLowerCase(), key);
    const norm = normalizeTermKey(trimmed);
    if (norm.length > 0) aliasToKey.set(norm, key);
  };

  const ensureTerm = (seed: {
    id?: string | undefined;
    name: string;
    kind?: string | undefined;
    domain?: string | undefined;
    description?: string | undefined;
    synonyms?: readonly string[] | undefined;
    attributes?: readonly (string | OntologyAttribute)[] | undefined;
    provenance?: readonly string[] | undefined;
    sensitivity?: OntologySensitivity | string | undefined;
    evidenceDelta?: number | undefined;
  }): TermAccumulator | null => {
    const cleanName = seed.name.trim();
    const normKey = normalizeTermKey(cleanName);
    if (normKey.length === 0) return null;

    const sens = normalizeOntologySensitivity(seed.sensitivity, "private");
    const existing = termsByKey.get(normKey);
    const existingStored =
      existingTermsByKey.get(normKey) ??
      (seed.id !== undefined ? existingTermsById.get(seed.id) : undefined);

    if (existing === undefined) {
      const termId =
        existingStored?.termId ??
        (seed.id !== undefined && seed.id.trim().length > 0
          ? seed.id.trim()
          : `term:${normKey}`);
      const acc: TermAccumulator = {
        termId,
        canonicalName: cleanName,
        normalizedKey: normKey,
        kind: (seed.kind ?? "concept").trim() || "concept",
        domain: (seed.domain ?? defaultDomain).trim() || defaultDomain,
        description: (seed.description ?? "").trim(),
        synonyms: new Set(dedupeStrings(seed.synonyms)),
        attributes: normalizeAttributes(seed.attributes),
        provenance: new Set(dedupeStrings(seed.provenance)),
        sensitivity: sens,
        evidenceCount: Math.max(0, Math.floor(seed.evidenceDelta ?? 1)),
      };
      termsByKey.set(normKey, acc);
      registerAlias(termId, normKey);
      registerAlias(cleanName, normKey);
      registerAlias(normKey, normKey);
      for (const syn of acc.synonyms) registerAlias(syn, normKey);
      return acc;
    }

    if (
      existing.description.length === 0 &&
      seed.description !== undefined &&
      seed.description.trim().length > 0
    ) {
      existing.description = seed.description.trim();
    }
    if (
      existing.domain === defaultDomain &&
      seed.domain !== undefined &&
      seed.domain.trim().length > 0
    ) {
      existing.domain = seed.domain.trim();
    }
    if (
      existing.kind === "concept" &&
      seed.kind !== undefined &&
      seed.kind.trim().length > 0
    ) {
      existing.kind = seed.kind.trim();
    }
    if (seed.synonyms !== undefined) {
      for (const syn of dedupeStrings(seed.synonyms)) {
        if (normalizeTermKey(syn) !== normKey) {
          existing.synonyms.add(syn);
        }
        registerAlias(syn, normKey);
      }
    }
    if (seed.attributes !== undefined && seed.attributes.length > 0) {
      existing.attributes = normalizeAttributes([
        ...existing.attributes,
        ...seed.attributes,
      ]);
    }
    if (seed.provenance !== undefined) {
      for (const ref of dedupeStrings(seed.provenance)) {
        existing.provenance.add(ref);
      }
    }
    if (seed.id !== undefined) registerAlias(seed.id, normKey);
    // Sensitivity rises monotonically so private evidence can never be downgraded.
    existing.sensitivity = maxOntologySensitivity(existing.sensitivity, sens);
    existing.evidenceCount += Math.max(0, Math.floor(seed.evidenceDelta ?? 1));
    return existing;
  };

  // 1. Entities
  for (const ent of inputs.entities ?? []) {
    ensureTerm({
      id: ent.id,
      name: ent.name,
      kind: ent.kind ?? "entity",
      domain: ent.domain ?? defaultDomain,
      description: ent.description,
      synonyms: ent.synonyms,
      attributes: ent.attributes,
      provenance: ent.provenance ?? (ent.id !== undefined ? [`entity:${ent.id}`] : []),
      sensitivity: ent.sensitivity,
      evidenceDelta: ent.evidenceCount ?? 1,
    });
  }

  // 2. Canon / Graph pages
  for (const page of inputs.pages ?? []) {
    const domain =
      page.domain ?? inferDomainFromPath(page.path, defaultDomain);
    const prov = dedupeStrings([
      ...(page.provenance ?? []),
      ...(page.path !== undefined ? [`page:${page.path}`] : []),
      ...(page.id !== undefined ? [`page_id:${page.id}`] : []),
    ]);
    const term = ensureTerm({
      id: page.id,
      name: page.title,
      kind: page.kind ?? "page",
      domain,
      description: summarizeBody(page.body),
      synonyms: page.synonyms,
      provenance: prov,
      sensitivity: page.sensitivity,
      evidenceDelta: 1,
    });
    if (term !== null && page.path !== undefined) {
      registerAlias(page.path, term.normalizedKey);
    }
    if (term !== null && page.subjects !== undefined) {
      for (const subj of page.subjects) {
        const cleanSubj = humanizeSubjectName(subj);
        if (
          normalizeTermKey(cleanSubj) !== term.normalizedKey &&
          cleanSubj.length > 0
        ) {
          ensureTerm({
            name: cleanSubj,
            kind: "entity",
            domain: inferDomainFromSubject(subj, domain),
            synonyms: subj !== cleanSubj ? [subj] : [],
            provenance: prov,
            sensitivity: page.sensitivity,
            evidenceDelta: 1,
          });
        }
      }
    }
  }

  // 3. Claims (live/active claims contribute terms, attributes, and triple relations)
  const rawLinks: CompilerLinkInput[] = [...(inputs.links ?? [])];
  let activeCommitmentCount = 0;
  let openConflictCount = 0;
  const conflictBuckets = new Map<string, Set<string>>();
  let commitmentSensitivity: OntologySensitivity = "public";
  let conflictSensitivity: OntologySensitivity = "public";

  for (const claim of inputs.claims ?? []) {
    const status = (claim.status ?? "live").toLowerCase();
    if (status === "superseded" || status === "retracted" || status === "purged") {
      continue;
    }
    const sens = normalizeOntologySensitivity(claim.sensitivity, "private");
    const prov = dedupeStrings([
      ...(claim.provenance ?? []),
      `claim:${claim.claimId}`,
    ]);
    const evidenceDelta = Math.max(1, Math.floor(claim.corroboration ?? 1));

    const claimKind = (claim.kind ?? "claim").toLowerCase();
    const predicateLower = (claim.predicate ?? "").toLowerCase();
    if (
      claimKind === "commitment" ||
      predicateLower.includes("commit") ||
      predicateLower === "promised" ||
      predicateLower === "owns_deliverable"
    ) {
      activeCommitmentCount += 1;
      commitmentSensitivity = maxOntologySensitivity(commitmentSensitivity, sens);
    }

    if (claim.subject !== undefined && claim.subject !== null && claim.subject.trim().length > 0) {
      const subjRaw = claim.subject.trim();
      const subjName = humanizeSubjectName(subjRaw);
      const subjDomain = inferDomainFromSubject(subjRaw, defaultDomain);
      const attrs: OntologyAttribute[] = [];
      if (claim.predicate !== undefined && claim.predicate !== null && claim.predicate.trim().length > 0) {
        const attr: OntologyAttribute = {
          name: claim.predicate.trim(),
          kind: "predicate",
        };
        if (claim.object !== undefined && claim.object !== null && claim.object.trim().length > 0) {
          attr.values = [claim.object.trim()];
        }
        attrs.push(attr);
      }

      const subjTerm = ensureTerm({
        name: subjName,
        kind: "entity",
        domain: subjDomain,
        description: summarizeBody(claim.body),
        synonyms: subjRaw !== subjName ? [subjRaw] : [],
        attributes: attrs,
        provenance: prov,
        sensitivity: sens,
        evidenceDelta,
      });
      if (subjTerm !== null) {
        registerAlias(subjRaw, subjTerm.normalizedKey);
      }

      // Track potential open conflicts on (subject, predicate) with differing objects or negative polarity.
      if (claim.predicate !== undefined && claim.predicate !== null && claim.predicate.trim().length > 0) {
        const bucketKey = `${normalizeTermKey(subjName)}::${normalizeTermKey(claim.predicate)}`;
        let values = conflictBuckets.get(bucketKey);
        if (values === undefined) {
          values = new Set<string>();
          conflictBuckets.set(bucketKey, values);
        }
        const polarity = (claim.polarity ?? "positive").toLowerCase();
        values.add(`${polarity}:${(claim.object ?? claim.body ?? "").trim().toLowerCase()}`);
        if (polarity === "negative" || status === "contested" || status === "conflict") {
          openConflictCount += 1;
          conflictSensitivity = maxOntologySensitivity(conflictSensitivity, sens);
        }
      }

      // If object looks like a named entity or resolves to an entity, emit a triple relation.
      if (
        claim.predicate !== undefined &&
        claim.predicate !== null &&
        claim.predicate.trim().length > 0 &&
        claim.object !== undefined &&
        claim.object !== null &&
        claim.object.trim().length > 0
      ) {
        const objRaw = claim.object.trim();
        const objName = humanizeSubjectName(objRaw);
        const objKey = normalizeTermKey(objName);
        const existingObj =
          termsByKey.has(objKey) ||
          aliasToKey.has(objRaw.toLowerCase()) ||
          objRaw.includes(":");
        if (existingObj || /^[A-Z][A-Za-z0-9 _-]+$/.test(objName)) {
          const objTerm = ensureTerm({
            name: objName,
            kind: "entity",
            domain: inferDomainFromSubject(objRaw, subjDomain),
            synonyms: objRaw !== objName ? [objRaw] : [],
            provenance: prov,
            sensitivity: sens,
            evidenceDelta: 1,
          });
          if (objTerm !== null) {
            registerAlias(objRaw, objTerm.normalizedKey);
            rawLinks.push({
              source: subjName,
              target: objName,
              relationKind: claim.predicate.trim(),
              confidence: claim.confidence ?? 0.8,
              evidenceCount: evidenceDelta,
              supportRefs: prov,
              sensitivity: sens,
            });
          }
        }
      }
    }

    for (const subj of claim.subjects ?? []) {
      const cleanSubj = humanizeSubjectName(subj);
      if (cleanSubj.length === 0) continue;
      const t = ensureTerm({
        name: cleanSubj,
        kind: "entity",
        domain: inferDomainFromSubject(subj, defaultDomain),
        synonyms: subj !== cleanSubj ? [subj] : [],
        provenance: prov,
        sensitivity: sens,
        evidenceDelta: 1,
      });
      if (t !== null) registerAlias(subj, t.normalizedKey);
    }
  }

  for (const vals of conflictBuckets.values()) {
    if (vals.size > 1) {
      openConflictCount += 1;
    }
  }

  // 4. Events (extract recurring event subjects into ontology terms)
  for (const ev of inputs.events ?? []) {
    if (ev.deleted === true) continue;
    const sens = normalizeOntologySensitivity(ev.sensitivity, "private");
    const prov = [`event:${ev.eventId}`];
    for (const subj of ev.subjects ?? []) {
      const cleanSubj = humanizeSubjectName(subj);
      if (cleanSubj.length === 0) continue;
      const t = ensureTerm({
        name: cleanSubj,
        kind: "entity",
        domain: inferDomainFromSubject(subj, ev.connectorId ?? defaultDomain),
        synonyms: subj !== cleanSubj ? [subj] : [],
        provenance: prov,
        sensitivity: sens,
        evidenceDelta: 1,
      });
      if (t !== null) registerAlias(subj, t.normalizedKey);
    }
  }

  // 5. Identity aliases merge synonyms
  for (const alias of inputs.identityAliases ?? []) {
    const status = (alias.status ?? "accepted").toLowerCase();
    if (status === "rejected") continue;
    if (alias.score !== undefined && alias.score < 0.7) continue;
    const keyA =
      aliasToKey.get(alias.subjectA.toLowerCase()) ??
      normalizeTermKey(humanizeSubjectName(alias.subjectA));
    const termA = termsByKey.get(keyA);
    if (termA !== undefined) {
      const syn = humanizeSubjectName(alias.subjectB);
      if (normalizeTermKey(syn) !== termA.normalizedKey && syn.length > 0) {
        termA.synonyms.add(syn);
        registerAlias(alias.subjectB, termA.normalizedKey);
      }
    }
  }

  const resolveEndpointKey = (raw: string): string | null => {
    const lower = raw.trim().toLowerCase();
    if (aliasToKey.has(lower)) return aliasToKey.get(lower) ?? null;
    const norm = normalizeTermKey(humanizeSubjectName(raw));
    if (aliasToKey.has(norm)) return aliasToKey.get(norm) ?? null;
    if (termsByKey.has(norm)) return norm;
    return null;
  };

  // 6. Aggregate data-confirmed semantic relations
  const relationsByKey = new Map<string, RelationAccumulator>();
  for (const link of rawLinks) {
    const srcKey = resolveEndpointKey(link.source);
    const dstKey = resolveEndpointKey(link.target);
    if (srcKey === null || dstKey === null || srcKey === dstKey) continue;
    const srcTerm = termsByKey.get(srcKey);
    const dstTerm = termsByKey.get(dstKey);
    if (srcTerm === undefined || dstTerm === undefined) continue;

    const relationKind = link.relationKind.trim();
    if (relationKind.length === 0) continue;

    const relKey = `${srcTerm.termId}\u0000${relationKind.toLowerCase()}\u0000${dstTerm.termId}`;
    const linkSens = maxOntologySensitivity(
      normalizeOntologySensitivity(link.sensitivity, "private"),
      maxOntologySensitivity(srcTerm.sensitivity, dstTerm.sensitivity),
    );
    const evCount = Math.max(1, Math.floor(link.evidenceCount ?? 1));
    const conf = Math.max(0, Math.min(1, link.confidence ?? 0.75));

    const existing = relationsByKey.get(relKey);
    if (existing === undefined) {
      relationsByKey.set(relKey, {
        sourceTermId: srcTerm.termId,
        targetTermId: dstTerm.termId,
        relationKind,
        evidenceCount: evCount,
        confidenceSum: conf,
        confidenceCount: 1,
        maxConfidence: conf,
        supportRefs: new Set(dedupeStrings(link.supportRefs)),
        sensitivity: linkSens,
      });
    } else {
      existing.evidenceCount += evCount;
      existing.confidenceSum += conf;
      existing.confidenceCount += 1;
      existing.maxConfidence = Math.max(existing.maxConfidence, conf);
      for (const ref of dedupeStrings(link.supportRefs)) {
        existing.supportRefs.add(ref);
      }
      existing.sensitivity = maxOntologySensitivity(existing.sensitivity, linkSens);
    }
  }

  // Select exactly ONE default join per (sourceTermId, targetTermId) pair.
  const relationsByPair = new Map<string, RelationAccumulator[]>();
  for (const rel of relationsByKey.values()) {
    const pairKey = `${rel.sourceTermId}\u0000${rel.targetTermId}`;
    let group = relationsByPair.get(pairKey);
    if (group === undefined) {
      group = [];
      relationsByPair.set(pairKey, group);
    }
    group.push(rel);
  }

  const defaultJoinKeys = new Set<string>();
  for (const group of relationsByPair.values()) {
    group.sort((a, b) => {
      if (a.evidenceCount !== b.evidenceCount) {
        return b.evidenceCount - a.evidenceCount;
      }
      if (a.maxConfidence !== b.maxConfidence) {
        return b.maxConfidence - a.maxConfidence;
      }
      return a.relationKind.localeCompare(b.relationKind);
    });
    const winner = group[0];
    if (winner !== undefined) {
      defaultJoinKeys.add(
        `${winner.sourceTermId}\u0000${winner.relationKind.toLowerCase()}\u0000${winner.targetTermId}`,
      );
    }
  }

  // 7. Persist atomically inside a SQLite transaction, enforcing Sticky Certification.
  let termsCreated = 0;
  let termsUpdated = 0;
  let preservedCertified = 0;
  let familiesDetected = 0;
  let relationsCompiled = 0;
  let defaultJoinsSelected = 0;
  let metricsCompiled = 0;

  store.transaction(() => {
    const persistedTerms: OntologyTerm[] = [];

    for (const acc of termsByKey.values()) {
      const prior =
        existingTermsByKey.get(acc.normalizedKey) ??
        existingTermsById.get(acc.termId);

      if (prior !== undefined && prior.certification === "certified") {
        // Sticky Certification Invariant: preserve owner's certified name,
        // description, synonyms, and certification fields while refreshing live
        // evidence count, attributes, and provenance.
        const mergedAttrs = normalizeAttributes([
          ...prior.attributes,
          ...acc.attributes,
        ]);
        const mergedProv = dedupeStrings([...prior.provenance, ...acc.provenance]);
        const saved = store.upsertTerm({
          termId: prior.termId,
          canonicalName: prior.canonicalName,
          normalizedKey: prior.normalizedKey,
          kind: prior.kind,
          domain: prior.domain,
          description: prior.description,
          synonyms: prior.synonyms,
          attributes: mergedAttrs,
          provenance: mergedProv,
          sensitivity: maxOntologySensitivity(prior.sensitivity, acc.sensitivity),
          evidenceCount: acc.evidenceCount,
          certification: "certified",
          certifiedBy: prior.certifiedBy,
          certifiedAt: prior.certifiedAt,
          familyId: prior.familyId,
          updatedAt: compiledAt,
        });
        persistedTerms.push(saved);
        preservedCertified += 1;
        termsUpdated += 1;
      } else {
        const saved = store.upsertTerm({
          termId: acc.termId,
          canonicalName: acc.canonicalName,
          normalizedKey: acc.normalizedKey,
          kind: acc.kind,
          domain: acc.domain,
          description: acc.description,
          synonyms: [...acc.synonyms],
          attributes: acc.attributes,
          provenance: [...acc.provenance],
          sensitivity: acc.sensitivity,
          evidenceCount: acc.evidenceCount,
          certification: "draft",
          certifiedBy: null,
          certifiedAt: null,
          familyId: null,
          updatedAt: compiledAt,
        });
        persistedTerms.push(saved);
        if (prior === undefined) {
          termsCreated += 1;
        } else {
          termsUpdated += 1;
        }
      }
    }

    // Persist compiled relations.
    const persistedRelations: OntologyRelation[] = [];
    for (const [relKey, rel] of relationsByKey.entries()) {
      const isDefaultJoin = defaultJoinKeys.has(relKey);
      const avgConf =
        rel.confidenceCount > 0 ? rel.confidenceSum / rel.confidenceCount : 0.5;
      const saved = store.upsertRelation({
        sourceTermId: rel.sourceTermId,
        targetTermId: rel.targetTermId,
        relationKind: rel.relationKind,
        evidenceCount: rel.evidenceCount,
        confidence: Number(avgConf.toFixed(4)),
        isDefaultJoin,
        supportRefs: [...rel.supportRefs],
        sensitivity: rel.sensitivity,
        updatedAt: compiledAt,
      });
      persistedRelations.push(saved);
      relationsCompiled += 1;
      if (isDefaultJoin) defaultJoinsSelected += 1;
    }

    // Detect and persist term families across all current store terms + relations.
    const allTerms = store.listTerms();
    const allRelations = store.listRelations();
    const detectedFamilies = detectTermFamiliesFromOntology(
      allTerms,
      allRelations,
      opts.minFamilyPairEvidence !== undefined
        ? { minPairEvidence: opts.minFamilyPairEvidence }
        : {},
    );

    store.clearTermFamilies();
    const termFamilyAssignment = new Map<string, string>();
    for (const fam of detectedFamilies) {
      store.upsertTermFamily({
        familyId: fam.familyId,
        prefix: fam.prefix,
        domain: fam.domain,
        members: fam.members,
        twinCount: fam.twins,
        mirroredEdgeCount: fam.mirroredEdges,
        updatedAt: compiledAt,
      });
      for (const termId of Object.keys(fam.members)) {
        termFamilyAssignment.set(termId, fam.familyId);
      }
    }
    familiesDetected = detectedFamilies.length;

    // Stamp family_id onto member terms without altering certification fields.
    if (termFamilyAssignment.size > 0) {
      const updateFamily = store.db.query(
        "UPDATE ontology_terms SET family_id = ?, updated_at = ? WHERE term_id = ?",
      );
      for (const [termId, familyId] of termFamilyAssignment.entries()) {
        updateFamily.run(familyId, compiledAt, termId);
      }
    }

    // Generate built-in vault metrics (respecting Sticky Certification).
    if (includeBuiltInMetrics) {
      const currentTerms = store.listTerms();
      const totalTerms = currentTerms.length;
      const certifiedCount = currentTerms.filter(
        (t) => t.certification === "certified",
      ).length;
      const distinctDomains = new Set(currentTerms.map((t) => t.domain));
      const certifiedPct =
        totalTerms > 0 ? ((certifiedCount / totalTerms) * 100).toFixed(1) : "0.0";

      const builtInSpecs: Array<{
        name: string;
        description: string;
        expression: string;
        grain: string;
        sensitivity: OntologySensitivity;
      }> = [
        {
          name: "active_commitments",
          description: `Count of live commitment claims currently tracked in the vault (observed: ${activeCommitmentCount}).`,
          expression:
            "COUNT(claims WHERE status = 'live' AND (kind = 'commitment' OR predicate LIKE '%commit%'))",
          grain: "vault",
          sensitivity: commitmentSensitivity,
        },
        {
          name: "open_conflicts",
          description: `Count of contested or multi-valued conflicting claim groups awaiting resolution (observed: ${openConflictCount}).`,
          expression:
            "COUNT(claims_groups WHERE status = 'contested' OR distinct_live_values > 1)",
          grain: "vault",
          sensitivity: conflictSensitivity,
        },
        {
          name: "domain_coverage",
          description: `Number of distinct semantic domains represented across compiled ontology terms (observed: ${distinctDomains.size} domains across ${totalTerms} terms).`,
          expression:
            "COUNT(DISTINCT ontology_terms.domain) / NULLIF(COUNT(ontology_terms.term_id), 0)",
          grain: "domain",
          sensitivity: "public",
        },
        {
          name: "certified_ratio",
          description: `Share of compiled ontology terms verified and certified by the owner (observed: ${certifiedCount}/${totalTerms} = ${certifiedPct}%).`,
          expression:
            "CAST(COUNT(ontology_terms WHERE certification = 'certified') AS REAL) / NULLIF(COUNT(ontology_terms.term_id), 0)",
          grain: "vault",
          sensitivity: "public",
        },
      ];

      for (const spec of builtInSpecs) {
        const priorMetric = existingMetricsByName.get(spec.name);
        if (priorMetric !== undefined && priorMetric.certification === "certified") {
          store.upsertMetric({
            metricId: priorMetric.metricId,
            name: priorMetric.name,
            termId: priorMetric.termId,
            description: priorMetric.description,
            expression: priorMetric.expression,
            grain: priorMetric.grain,
            certification: "certified",
            sensitivity: priorMetric.sensitivity,
            updatedAt: compiledAt,
          });
          preservedCertified += 1;
        } else {
          store.upsertMetric({
            name: spec.name,
            termId: null,
            description: spec.description,
            expression: spec.expression,
            grain: spec.grain,
            certification: "draft",
            sensitivity: spec.sensitivity,
            updatedAt: compiledAt,
          });
        }
        metricsCompiled += 1;
      }
    }

    store.setMeta("last_compiled_at", compiledAt);
  });

  return {
    compiledAt,
    termsCompiled: termsByKey.size,
    termsCreated,
    termsUpdated,
    preservedCertified,
    familiesDetected,
    relationsCompiled,
    defaultJoinsSelected,
    metricsCompiled,
    sourceTables: [...(inputs.sourceTables ?? [])],
  };
}

/**
 * Defensively inspects `vaultDb` (`sqlite_master`) and compiles all discovered
 * Kizuki tables (`canon_pages`, `graph_pages`, `search_documents`, `page_index`,
 * `entities`, `claims`, `events`, `claim_links`, `graph_edges`, `identity_links`)
 * into the local SQLite `OntologyStore`.
 */
export function compileOntologyFromVault(
  vaultDb: Database,
  store: OntologyStore,
  opts: CompileOptions = {},
): OntologyCompileReport {
  const inputs = extractInputsFromVault(vaultDb);
  return compileOntologyFromInputs(inputs, store, opts);
}
