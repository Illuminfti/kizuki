import type { OntologyStore } from "./store";
import {
  isOntologySensitivity,
  normalizeAttributes,
  normalizeOntologySensitivity,
} from "./types";
import type {
  OntologyAttribute,
  OntologyScopeOptions,
  OntologySensitivity,
} from "./types";

export const OSSIE_MODEL_VERSION = "ossie/v1" as const;

export interface OssieAttribute {
  name: string;
  kind?: string;
  description?: string;
  values?: string[];
}

export interface OssieConcept {
  id: string;
  name: string;
  normalized_key: string;
  kind: string;
  domain: string;
  description: string;
  synonyms: string[];
  subjects: string[];
  attributes: OssieAttribute[];
  provenance: string[];
  sensitivity: OntologySensitivity;
  evidence_count: number;
  certified: boolean;
  certified_by: string | null;
  certified_at: string | null;
  family_id: string | null;
}

export interface OssieTermFamily {
  id: string;
  prefix: string;
  domain: string;
  members: Record<string, string>;
  twin_count: number;
  mirrored_edge_count: number;
}

export interface OssieRelationship {
  id: string;
  source: string;
  target: string;
  kind: string;
  evidence_count: number;
  confidence: number;
  default_join: boolean;
  support_refs: string[];
  sensitivity: OntologySensitivity;
}

export interface OssieMetric {
  id: string;
  name: string;
  term_id: string | null;
  description: string;
  expression: string;
  grain: string;
  certified: boolean;
  sensitivity: OntologySensitivity;
}

export interface OssieModelDocument {
  version: typeof OSSIE_MODEL_VERSION;
  exported_at: string;
  metadata: Record<string, string>;
  concepts: OssieConcept[];
  term_families: OssieTermFamily[];
  relationships: OssieRelationship[];
  metrics: OssieMetric[];
}

export interface ExportOssieOptions extends OntologyScopeOptions {
  readonly exportedAt?: string | undefined;
  readonly metadata?: Record<string, string> | undefined;
}

export interface ImportOssieOptions {
  readonly replace?: boolean | undefined;
  readonly preserveCertified?: boolean | undefined;
  readonly importedAt?: string | undefined;
}

export interface OssieImportReport {
  readonly conceptsImported: number;
  readonly familiesImported: number;
  readonly relationshipsImported: number;
  readonly metricsImported: number;
  readonly preservedCertified: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function exportOssieModel(
  store: OntologyStore,
  opts: ExportOssieOptions = {},
): OssieModelDocument {
  if (opts.sensitivityCeiling !== undefined && !isOntologySensitivity(opts.sensitivityCeiling)) {
    throw new Error(`Invalid sensitivityCeiling: ${String(opts.sensitivityCeiling)}`);
  }
  const scope: OntologyScopeOptions = {
    sensitivityCeiling: opts.sensitivityCeiling,
    allowedSubjects: opts.allowedSubjects,
  };

  const terms = store
    .listTerms(scope)
    .sort((a, b) => a.normalizedKey.localeCompare(b.normalizedKey));
  const termIds = new Set(terms.map((t) => t.termId));
  const relations = store
    .listRelations(scope)
    .sort((a, b) => a.relationId.localeCompare(b.relationId));
  const metrics = store
    .listMetrics(scope)
    .sort((a, b) => a.name.localeCompare(b.name));
  const families = store
    .listTermFamilies()
    .map((fam) => {
      const visibleMembers: Record<string, string> = {};
      for (const [tid, base] of Object.entries(fam.members).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        if (termIds.has(tid)) visibleMembers[tid] = base;
      }
      return { fam, visibleMembers };
    })
    .filter(({ visibleMembers }) => Object.keys(visibleMembers).length > 0)
    .sort((a, b) => a.fam.familyId.localeCompare(b.fam.familyId));

  const metadata: Record<string, string> = {
    schema_version: store.getMeta("schema_version") ?? "1",
    ...(opts.metadata ?? {}),
  };
  const lastCompiled = store.getMeta("last_compiled_at");
  if (lastCompiled !== null && metadata.last_compiled_at === undefined) {
    metadata.last_compiled_at = lastCompiled;
  }

  return {
    version: OSSIE_MODEL_VERSION,
    exported_at: opts.exportedAt ?? nowIso(),
    metadata,
    concepts: terms.map((term) => ({
      id: term.termId,
      name: term.canonicalName,
      normalized_key: term.normalizedKey,
      kind: term.kind,
      domain: term.domain,
      description: term.description,
      synonyms: [...term.synonyms],
      subjects: [...term.subjects],
      attributes: term.attributes.map((attr) => {
        const out: OssieAttribute = { name: attr.name };
        if (attr.kind !== undefined) out.kind = attr.kind;
        if (attr.description !== undefined) out.description = attr.description;
        if (attr.values !== undefined && attr.values.length > 0) {
          out.values = [...attr.values];
        }
        return out;
      }),
      provenance: [...term.provenance],
      sensitivity: term.sensitivity,
      evidence_count: term.evidenceCount,
      certified: term.certification === "certified",
      certified_by: term.certifiedBy,
      certified_at: term.certifiedAt,
      family_id: term.familyId,
    })),
    term_families: families.map(({ fam, visibleMembers }) => ({
      id: fam.familyId,
      prefix: fam.prefix,
      domain: fam.domain,
      members: visibleMembers,
      twin_count: fam.twinCount,
      mirrored_edge_count: fam.mirroredEdgeCount,
    })),
    relationships: relations.map((rel) => ({
      id: rel.relationId,
      source: rel.sourceTermId,
      target: rel.targetTermId,
      kind: rel.relationKind,
      evidence_count: rel.evidenceCount,
      confidence: rel.confidence,
      default_join: rel.isDefaultJoin,
      support_refs: [...rel.supportRefs],
      sensitivity: rel.sensitivity,
    })),
    metrics: metrics.map((metric) => ({
      id: metric.metricId,
      name: metric.name,
      term_id: metric.termId,
      description: metric.description,
      expression: metric.expression,
      grain: metric.grain,
      certified: metric.certification === "certified",
      sensitivity: metric.sensitivity,
    })),
  };
}

export function exportOssieJson(
  store: OntologyStore,
  opts: ExportOssieOptions = {},
): string {
  return `${JSON.stringify(exportOssieModel(store, opts), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Zero-dependency deterministic YAML serializer and parser for ossie/v1
// ---------------------------------------------------------------------------

const SAFE_PLAIN_SCALAR_RE = /^[A-Za-z0-9_./@-][A-Za-z0-9_./@ -]*$/;
const RESERVED_SCALAR_RE = /^(?:true|false|null|~|yes|no|on|off|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)$/i;

function formatYamlScalar(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "null";
  }
  const str = String(value);
  if (
    str.length > 0 &&
    SAFE_PLAIN_SCALAR_RE.test(str) &&
    !RESERVED_SCALAR_RE.test(str) &&
    !str.startsWith("-") &&
    !str.endsWith(" ") &&
    !str.includes(": ") &&
    !str.includes(" #")
  ) {
    return str;
  }
  return JSON.stringify(str);
}

function formatYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key) && !RESERVED_SCALAR_RE.test(key)) {
    return key;
  }
  return JSON.stringify(key);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeYamlValue(value: unknown, indent: number): string[] {
  const pad = " ".repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (Array.isArray(item)) {
        if (item.length === 0) {
          lines.push(`${pad}- []`);
        } else {
          lines.push(`${pad}-`);
          lines.push(...serializeYamlValue(item, indent + 2));
        }
      } else if (isPlainRecord(item)) {
        const entries = Object.entries(item).filter(([, v]) => v !== undefined);
        if (entries.length === 0) {
          lines.push(`${pad}- {}`);
        } else {
          const first = entries[0];
          if (first !== undefined) {
            const [firstKey, firstVal] = first;
            lines.push(
              ...serializeMappingEntry(firstKey, firstVal, indent + 2, `${pad}- `),
            );
          }
          for (let i = 1; i < entries.length; i += 1) {
            const entry = entries[i];
            if (entry === undefined) continue;
            const [k, v] = entry;
            lines.push(...serializeMappingEntry(k, v, indent + 2));
          }
        }
      } else {
        lines.push(`${pad}- ${formatYamlScalar(item)}`);
      }
    }
    return lines;
  }

  if (isPlainRecord(value)) {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return [`${pad}{}`];
    const lines: string[] = [];
    for (const [k, v] of entries) {
      lines.push(...serializeMappingEntry(k, v, indent));
    }
    return lines;
  }

  return [`${pad}${formatYamlScalar(value)}`];
}

function serializeMappingEntry(
  key: string,
  val: unknown,
  indent: number,
  firstPrefix?: string,
): string[] {
  const lead = firstPrefix ?? " ".repeat(indent);
  const formattedKey = formatYamlKey(key);

  if (Array.isArray(val)) {
    if (val.length === 0) {
      return [`${lead}${formattedKey}: []`];
    }
    return [`${lead}${formattedKey}:`, ...serializeYamlValue(val, indent + 2)];
  }
  if (isPlainRecord(val)) {
    const entries = Object.entries(val).filter(([, v]) => v !== undefined);
    if (entries.length === 0) {
      return [`${lead}${formattedKey}: {}`];
    }
    return [`${lead}${formattedKey}:`, ...serializeYamlValue(val, indent + 2)];
  }
  return [`${lead}${formattedKey}: ${formatYamlScalar(val)}`];
}

export function exportOssieYaml(
  store: OntologyStore,
  opts: ExportOssieOptions = {},
): string {
  const model = exportOssieModel(store, opts);
  const lines = [
    "# Kizuki Semantic Ontology (Apache Ossie compatible ossie/v1)",
    ...serializeYamlValue(model, 0),
  ];
  return `${lines.join("\n")}\n`;
}

interface ParsedLine {
  readonly indent: number;
  readonly content: string;
  readonly lineNo: number;
}

function parseYamlScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~" || trimmed === "") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "[]") return [];
  if (trimmed === "{}") return {};
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return JSON.parse(trimmed);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (Number.isFinite(num)) return num;
  }
  return trimmed;
}

function splitKeyValue(content: string): { key: string; valueRaw: string } | null {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === "\\" && inDouble) {
      i += 1;
      continue;
    }
    if (ch === "\"" && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (!inDouble && !inSingle && ch === ":") {
      const next = content[i + 1];
      if (next === undefined || next === " " || next === "\t") {
        const rawKey = content.slice(0, i).trim();
        const key =
          rawKey.startsWith("\"") && rawKey.endsWith("\"")
            ? String(JSON.parse(rawKey))
            : rawKey.startsWith("'") && rawKey.endsWith("'")
              ? rawKey.slice(1, -1).replace(/''/g, "'")
              : rawKey;
        const valueRaw = content.slice(i + 1).trim();
        return { key, valueRaw };
      }
    }
  }
  return null;
}

function preprocessYamlLines(yaml: string): ParsedLine[] {
  const rawLines = yaml.replace(/\r\n/g, "\n").split("\n");
  const lines: ParsedLine[] = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    const line = rawLines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    let indent = 0;
    while (indent < line.length && line[indent] === " ") {
      indent += 1;
    }
    lines.push({ indent, content: trimmed, lineNo: i + 1 });
  }
  return lines;
}

function parseYamlBlock(
  lines: readonly ParsedLine[],
  startIdx: number,
  expectedIndent: number,
): { value: unknown; nextIdx: number } {
  const first = lines[startIdx];
  if (first === undefined) {
    return { value: {}, nextIdx: startIdx };
  }
  if (first.content === "-" || first.content.startsWith("- ")) {
    return parseYamlSequence(lines, startIdx, expectedIndent);
  }
  return parseYamlMapping(lines, startIdx, expectedIndent);
}

function parseYamlSequence(
  lines: readonly ParsedLine[],
  startIdx: number,
  seqIndent: number,
): { value: unknown[]; nextIdx: number } {
  const items: unknown[] = [];
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line === undefined || line.indent < seqIndent) break;
    if (line.indent > seqIndent) {
      throw new Error(`Unexpected indentation at YAML line ${line.lineNo}`);
    }
    if (line.content !== "-" && !line.content.startsWith("- ")) break;

    const rest = line.content === "-" ? "" : line.content.slice(2).trim();
    idx += 1;

    if (rest.length === 0) {
      const next = lines[idx];
      if (next !== undefined && next.indent > seqIndent) {
        const nested = parseYamlBlock(lines, idx, next.indent);
        items.push(nested.value);
        idx = nested.nextIdx;
      } else {
        items.push(null);
      }
      continue;
    }

    const kv = splitKeyValue(rest);
    if (kv !== null) {
      const obj: Record<string, unknown> = {};
      const itemIndent = seqIndent + 2;
      if (kv.valueRaw.length > 0) {
        obj[kv.key] = parseYamlScalar(kv.valueRaw);
      } else {
        const next = lines[idx];
        if (next !== undefined && next.indent > itemIndent) {
          const nested = parseYamlBlock(lines, idx, next.indent);
          obj[kv.key] = nested.value;
          idx = nested.nextIdx;
        } else {
          obj[kv.key] = null;
        }
      }

      // Consume remaining sibling keys at itemIndent
      while (idx < lines.length) {
        const next = lines[idx];
        if (next === undefined || next.indent < itemIndent) break;
        if (next.indent !== itemIndent) {
          throw new Error(`Unexpected indentation at YAML line ${next.lineNo}`);
        }
        const nextKv = splitKeyValue(next.content);
        if (nextKv === null) {
          throw new Error(`Expected mapping entry at YAML line ${next.lineNo}`);
        }
        idx += 1;
        if (nextKv.valueRaw.length > 0) {
          obj[nextKv.key] = parseYamlScalar(nextKv.valueRaw);
        } else {
          const child = lines[idx];
          if (child !== undefined && child.indent > itemIndent) {
            const nested = parseYamlBlock(lines, idx, child.indent);
            obj[nextKv.key] = nested.value;
            idx = nested.nextIdx;
          } else {
            obj[nextKv.key] = null;
          }
        }
      }
      items.push(obj);
      continue;
    }

    items.push(parseYamlScalar(rest));
  }

  return { value: items, nextIdx: idx };
}

function parseYamlMapping(
  lines: readonly ParsedLine[],
  startIdx: number,
  mapIndent: number,
): { value: Record<string, unknown>; nextIdx: number } {
  const obj: Record<string, unknown> = {};
  let idx = startIdx;

  while (idx < lines.length) {
    const line = lines[idx];
    if (line === undefined || line.indent < mapIndent) break;
    if (line.indent > mapIndent) {
      throw new Error(`Unexpected indentation at YAML line ${line.lineNo}`);
    }
    if (line.content === "-" || line.content.startsWith("- ")) break;

    const kv = splitKeyValue(line.content);
    if (kv === null) {
      throw new Error(`Expected key: value at YAML line ${line.lineNo}`);
    }
    idx += 1;

    if (kv.valueRaw.length > 0) {
      obj[kv.key] = parseYamlScalar(kv.valueRaw);
    } else {
      const next = lines[idx];
      if (next !== undefined && next.indent > mapIndent) {
        const nested = parseYamlBlock(lines, idx, next.indent);
        obj[kv.key] = nested.value;
        idx = nested.nextIdx;
      } else {
        obj[kv.key] = null;
      }
    }
  }

  return { value: obj, nextIdx: idx };
}

function validateOssieDocument(raw: unknown): OssieModelDocument {
  if (!isPlainRecord(raw)) {
    throw new Error("Invalid Ossie document: expected top-level mapping");
  }
  if (raw.version !== OSSIE_MODEL_VERSION) {
    throw new Error(
      `Unsupported Ossie version: ${String(raw.version)} (expected ${OSSIE_MODEL_VERSION})`,
    );
  }

  const metadata: Record<string, string> = {};
  if (isPlainRecord(raw.metadata)) {
    for (const [k, v] of Object.entries(raw.metadata)) {
      if (v !== null && v !== undefined) metadata[k] = String(v);
    }
  }

  const rawConcepts = Array.isArray(raw.concepts) ? raw.concepts : [];
  const concepts: OssieConcept[] = rawConcepts.map((entry, idx) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`Invalid Ossie concept at index ${idx}`);
    }
    const rawAttrs = Array.isArray(entry.attributes) ? entry.attributes : [];
    const attributes: OssieAttribute[] = normalizeAttributes(
      rawAttrs.map((a) => {
        if (typeof a === "string") return a;
        if (isPlainRecord(a)) {
          const out: OntologyAttribute = { name: String(a.name ?? "") };
          if (typeof a.kind === "string") out.kind = a.kind;
          if (typeof a.description === "string") out.description = a.description;
          if (Array.isArray(a.values)) out.values = a.values.map(String);
          return out;
        }
        return "";
      }),
    );

    return {
      id: String(entry.id ?? ""),
      name: String(entry.name ?? ""),
      normalized_key: String(entry.normalized_key ?? ""),
      kind: String(entry.kind ?? "concept"),
      domain: String(entry.domain ?? "general"),
      description: String(entry.description ?? ""),
      synonyms: Array.isArray(entry.synonyms) ? entry.synonyms.map(String) : [],
      subjects: Array.isArray(entry.subjects) ? entry.subjects.map(String) : [],
      attributes,
      provenance: Array.isArray(entry.provenance)
        ? entry.provenance.map(String)
        : [],
      sensitivity: normalizeOntologySensitivity(entry.sensitivity, "private"),
      evidence_count:
        typeof entry.evidence_count === "number" ? entry.evidence_count : 0,
      certified: entry.certified === true,
      certified_by:
        typeof entry.certified_by === "string" ? entry.certified_by : null,
      certified_at:
        typeof entry.certified_at === "string" ? entry.certified_at : null,
      family_id: typeof entry.family_id === "string" ? entry.family_id : null,
    };
  });

  const rawFamilies = Array.isArray(raw.term_families) ? raw.term_families : [];
  const term_families: OssieTermFamily[] = rawFamilies.map((entry, idx) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`Invalid Ossie term family at index ${idx}`);
    }
    const members: Record<string, string> = {};
    if (isPlainRecord(entry.members)) {
      for (const [k, v] of Object.entries(entry.members)) {
        if (typeof v === "string") members[k] = v;
      }
    }
    return {
      id: String(entry.id ?? ""),
      prefix: String(entry.prefix ?? ""),
      domain: String(entry.domain ?? "general"),
      members,
      twin_count: typeof entry.twin_count === "number" ? entry.twin_count : 0,
      mirrored_edge_count:
        typeof entry.mirrored_edge_count === "number"
          ? entry.mirrored_edge_count
          : 0,
    };
  });

  const rawRels = Array.isArray(raw.relationships) ? raw.relationships : [];
  const relationships: OssieRelationship[] = rawRels.map((entry, idx) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`Invalid Ossie relationship at index ${idx}`);
    }
    return {
      id: String(entry.id ?? ""),
      source: String(entry.source ?? ""),
      target: String(entry.target ?? ""),
      kind: String(entry.kind ?? "related_to"),
      evidence_count:
        typeof entry.evidence_count === "number" ? entry.evidence_count : 1,
      confidence: typeof entry.confidence === "number" ? entry.confidence : 0.5,
      default_join: entry.default_join === true,
      support_refs: Array.isArray(entry.support_refs)
        ? entry.support_refs.map(String)
        : [],
      sensitivity: normalizeOntologySensitivity(entry.sensitivity, "private"),
    };
  });

  const rawMetrics = Array.isArray(raw.metrics) ? raw.metrics : [];
  const metrics: OssieMetric[] = rawMetrics.map((entry, idx) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`Invalid Ossie metric at index ${idx}`);
    }
    return {
      id: String(entry.id ?? ""),
      name: String(entry.name ?? ""),
      term_id: typeof entry.term_id === "string" ? entry.term_id : null,
      description: String(entry.description ?? ""),
      expression: String(entry.expression ?? ""),
      grain: String(entry.grain ?? "vault"),
      certified: entry.certified === true,
      sensitivity: normalizeOntologySensitivity(entry.sensitivity, "private"),
    };
  });

  return {
    version: OSSIE_MODEL_VERSION,
    exported_at:
      typeof raw.exported_at === "string" ? raw.exported_at : nowIso(),
    metadata,
    concepts,
    term_families,
    relationships,
    metrics,
  };
}

export function parseOssieYaml(yaml: string): OssieModelDocument {
  const trimmed = yaml.trim();
  if (trimmed.length === 0) {
    throw new Error("Empty Ossie YAML input");
  }
  if (trimmed.startsWith("{")) {
    return validateOssieDocument(JSON.parse(trimmed));
  }
  const lines = preprocessYamlLines(trimmed);
  if (lines.length === 0) {
    throw new Error("Empty Ossie YAML input");
  }
  const firstIndent = lines[0]?.indent ?? 0;
  const { value } = parseYamlBlock(lines, 0, firstIndent);
  return validateOssieDocument(value);
}

export function importOssieModel(
  store: OntologyStore,
  input: OssieModelDocument | string,
  opts: ImportOssieOptions = {},
): OssieImportReport {
  const model =
    typeof input === "string"
      ? parseOssieYaml(input)
      : validateOssieDocument(input);
  const preserveCertified = opts.preserveCertified ?? true;
  const replace = opts.replace ?? false;
  const importedAt = opts.importedAt ?? nowIso();

  let conceptsImported = 0;
  let familiesImported = 0;
  let relationshipsImported = 0;
  let metricsImported = 0;
  let preservedCertified = 0;

  store.transaction(() => {
    if (replace) {
      store.db.exec("DELETE FROM ontology_relations");
      store.db.exec("DELETE FROM ontology_term_families");
      if (!preserveCertified) {
        store.db.exec("DELETE FROM ontology_terms");
        store.db.exec("DELETE FROM ontology_metrics");
      } else {
        store.db.exec(
          "DELETE FROM ontology_terms WHERE certification != 'certified'",
        );
        store.db.exec(
          "DELETE FROM ontology_metrics WHERE certification != 'certified'",
        );
      }
    }

    for (const concept of model.concepts) {
      const existing =
        store.getTerm(concept.id) ??
        store.getTermByKey(concept.normalized_key || concept.name);

      if (
        preserveCertified &&
        existing !== null &&
        existing.certification === "certified" &&
        !concept.certified
      ) {
        store.upsertTerm({
          termId: existing.termId,
          canonicalName: existing.canonicalName,
          normalizedKey: existing.normalizedKey,
          kind: existing.kind,
          domain: existing.domain,
          description: existing.description,
          synonyms: existing.synonyms,
          subjects: concept.subjects.length > 0 ? concept.subjects : existing.subjects,
          attributes: normalizeAttributes([
            ...existing.attributes,
            ...concept.attributes,
          ]),
          provenance: [...existing.provenance, ...concept.provenance],
          sensitivity: existing.sensitivity,
          evidenceCount: concept.evidence_count,
          certification: "certified",
          certifiedBy: existing.certifiedBy,
          certifiedAt: existing.certifiedAt,
          familyId: concept.family_id ?? existing.familyId,
          updatedAt: importedAt,
        });
        preservedCertified += 1;
      } else {
        store.upsertTerm({
          termId: concept.id.length > 0 ? concept.id : undefined,
          canonicalName: concept.name,
          normalizedKey:
            concept.normalized_key.length > 0
              ? concept.normalized_key
              : undefined,
          kind: concept.kind,
          domain: concept.domain,
          description: concept.description,
          synonyms: concept.synonyms,
          subjects: concept.subjects,
          attributes: concept.attributes,
          provenance: concept.provenance,
          sensitivity: concept.sensitivity,
          evidenceCount: concept.evidence_count,
          certification: concept.certified ? "certified" : "draft",
          certifiedBy: concept.certified_by,
          certifiedAt: concept.certified_at,
          familyId: concept.family_id,
          updatedAt: importedAt,
        });
      }
      conceptsImported += 1;
    }

    for (const fam of model.term_families) {
      store.upsertTermFamily({
        familyId: fam.id,
        prefix: fam.prefix,
        domain: fam.domain,
        members: fam.members,
        twinCount: fam.twin_count,
        mirroredEdgeCount: fam.mirrored_edge_count,
        updatedAt: importedAt,
      });
      familiesImported += 1;
    }

    for (const rel of model.relationships) {
      store.upsertRelation({
        relationId: rel.id.length > 0 ? rel.id : undefined,
        sourceTermId: rel.source,
        targetTermId: rel.target,
        relationKind: rel.kind,
        evidenceCount: rel.evidence_count,
        confidence: rel.confidence,
        isDefaultJoin: rel.default_join,
        supportRefs: rel.support_refs,
        sensitivity: rel.sensitivity,
        updatedAt: importedAt,
      });
      relationshipsImported += 1;
    }

    for (const metric of model.metrics) {
      const existing =
        store.getMetric(metric.id) ?? store.getMetricByName(metric.name);
      if (
        preserveCertified &&
        existing !== null &&
        existing.certification === "certified" &&
        !metric.certified
      ) {
        preservedCertified += 1;
      } else {
        store.upsertMetric({
          metricId: metric.id.length > 0 ? metric.id : undefined,
          name: metric.name,
          termId: metric.term_id,
          description: metric.description,
          expression: metric.expression,
          grain: metric.grain,
          certification: metric.certified ? "certified" : "draft",
          sensitivity: metric.sensitivity,
          updatedAt: importedAt,
        });
      }
      metricsImported += 1;
    }

    for (const [k, v] of Object.entries(model.metadata)) {
      if (k !== "schema_version") {
        store.setMeta(k, v);
      }
    }
  });

  return {
    conceptsImported,
    familiesImported,
    relationshipsImported,
    metricsImported,
    preservedCertified,
  };
}
