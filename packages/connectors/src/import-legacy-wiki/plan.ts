import { PAGE_TYPES, PAGE_CANDIDATE_SCHEMA, targetProblem } from "@kizuki/core";
import type {
  CaptureEventInput,
  PageSensitivity,
  PageType,
  SubjectRef,
} from "@kizuki/core";
import type { FrontmatterValue } from "@kizuki/core/staging";
import {
  sanitizeLine,
  slug,
  subjectId,
  toFrontmatterValue,
} from "../legacy/coerce";
import { parseLegacyTimestamp } from "../legacy/coerce";
import { parseLegacyFrontmatter } from "./frontmatter";
import { LEGACY_WIKI_CONNECTOR_ID } from "./mapping";
import type { LegacyWikiMapping } from "./mapping";
import type {
  LegacyWikiCounts,
  LegacyWikiFieldReport,
  LegacyWikiPageReport,
  LegacyWikiReport,
} from "./report";
import { LEGACY_WIKI_REPORT_SCHEMA } from "./report";
import type { ScanResult } from "./scan";

/**
 * The whole decision layer of the wiki migration, as one pure function: the
 * same wiki and the same mapping always produce the same events and the same
 * report, and nothing here touches the filesystem.
 */

export const MAX_TEXT_LENGTH = 262_144;
export const MAX_EXTENSIONS = 64;
const MAX_SUBJECTS = 200;
const MAX_VOCABULARY = 64;
const MAX_METADATA_FRONTMATTER = 64 * 1024;
const EXTENSION_NAME = /^x-[A-Za-z0-9][A-Za-z0-9_-]*$/;
const IDENTITY_SENSITIVITIES = ["public", "personal", "private"] as const;
const ENTITY_TYPES = ["person", "org", "project", "place", "topic"] as const;

export interface PlanOptions {
  observedAt: string;
  mappingHash: string;
}

interface PageDraft {
  report: LegacyWikiPageReport;
  event: CaptureEventInput | null;
}

function stem(relpath: string): string {
  const name = relpath.slice(relpath.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

/** A legacy value usable as vocabulary; anything else is reported unusable. */
function vocabulary(raw: unknown): string | null | "unusable" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw);
  if (typeof raw === "boolean") return String(raw);
  return "unusable";
}

function headingTitle(body: string): string | null {
  const heading = /^#[ \t]+(.+)$/m.exec(body);
  if (heading === null) return null;
  const title = sanitizeLine(heading[1] as string, 200);
  return title.length === 0 ? null : title;
}

function planTitle(
  data: Record<string, unknown>,
  mapping: LegacyWikiMapping,
  relpath: string,
  body: string,
): { title: string; source: "field" | "heading" | "filename" } {
  const raw = data[mapping.title.field];
  if (typeof raw === "string") {
    const title = sanitizeLine(raw, 200);
    if (title.length > 0) return { title, source: "field" };
  }
  const heading = headingTitle(body);
  if (heading !== null) return { title: heading, source: "heading" };
  const name = sanitizeLine(stem(relpath), 200);
  return { title: name.length === 0 ? "page" : name, source: "filename" };
}

function planSubjects(
  data: Record<string, unknown>,
  mapping: LegacyWikiMapping,
): SubjectRef[] {
  if (mapping.subjects === null) return [];
  const raw = data[mapping.subjects.field];
  const values =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((item): item is string => typeof item === "string")
        : [];
  const subjects: SubjectRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (subjects.length >= MAX_SUBJECTS) break;
    const id = subjectId(mapping.subjects.namespace, value);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    subjects.push({
      subject_id: id,
      role: mapping.subjects.role,
      display_name: sanitizeLine(value, 120),
    });
  }
  return subjects;
}

interface FieldPlan {
  extensions: Record<string, FrontmatterValue>;
  reports: LegacyWikiFieldReport[];
}

function planFields(
  data: Record<string, unknown>,
  mapping: LegacyWikiMapping,
  slots: Map<string, string>,
  reserved: number,
): FieldPlan {
  const extensions: Record<string, FrontmatterValue> = {};
  const reports: LegacyWikiFieldReport[] = [];
  const taken = new Set<string>();
  const budget = MAX_EXTENSIONS - reserved;

  for (const key of Object.keys(data)) {
    const label = sanitizeLine(key, 120);
    const slot = slots.get(key);
    if (slot !== undefined) {
      reports.push({ key: label, outcome: "mapped", to: slot });
      continue;
    }
    const explicit = Object.prototype.hasOwnProperty.call(mapping.fields, key)
      ? mapping.fields[key]
      : undefined;
    if (explicit === null) {
      reports.push({ key: label, outcome: "dropped", note: "by_mapping" });
      continue;
    }
    if (!/[A-Za-z0-9]/.test(key.normalize("NFKC"))) {
      reports.push({ key: label, outcome: "dropped", note: "unnameable" });
      continue;
    }
    const name = explicit ?? (EXTENSION_NAME.test(key) ? key : `x-${slug(key)}`);
    if (taken.has(name)) {
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: "name_conflict",
      });
      continue;
    }
    if (taken.size >= budget) {
      // The page-candidate contract caps the extension bag; past the cap the
      // page still imports, and the report says which fields did not.
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: "over_limit",
      });
      continue;
    }
    const coerced = toFrontmatterValue(data[key]);
    if (!coerced.ok) {
      reports.push({
        key: label,
        outcome: "dropped",
        to: name,
        note: coerced.reason,
      });
      continue;
    }
    taken.add(name);
    extensions[name] = coerced.value;
    if (coerced.note !== "kept") {
      reports.push({
        key: label,
        outcome: "coerced",
        to: name,
        note: coerced.note,
      });
      continue;
    }
    reports.push({
      key: label,
      outcome: name === key ? "kept" : "renamed",
      to: name,
    });
  }
  return { extensions, reports };
}

function planTarget(
  relpath: string,
  type: PageType,
  mapping: LegacyWikiMapping,
  taken: Set<string>,
  notes: string[],
): string {
  const directory = mapping.target.directories[type];
  const leaf = slug(stem(relpath));
  const parents = relpath.slice(0, relpath.lastIndexOf("/") + 1);
  let target = `${directory}/${leaf}`;
  if (mapping.target.mode === "mirror" && parents.length > 0) {
    const mirrored = parents
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => slug(segment));
    const candidate = `${directory}/${mirrored.join("/")}/${leaf}`;
    if (targetProblem(candidate) === null) target = candidate;
    else notes.push("target: flattened");
  }
  if (targetProblem(target) !== null) {
    // Unreachable by construction; a wrong path is a bug, not a page loss.
    target = `${directory}/${leaf}`;
    notes.push("target: flattened");
  }

  let unique = target;
  let suffix = 2;
  while (taken.has(unique)) {
    unique = `${target.slice(0, target.lastIndexOf("/") + 1)}${slug(`${leaf}-${suffix}`)}`;
    suffix += 1;
  }
  if (unique !== target) notes.push("target_collision");
  taken.add(unique);
  return unique;
}

function jsonSafeFrontmatter(
  data: Record<string, unknown>,
): { frontmatter: Record<string, unknown> } | { omitted: "size" } {
  let serialized: string;
  try {
    serialized = JSON.stringify(data) ?? "";
  } catch {
    return { omitted: "size" };
  }
  if (serialized.length === 0 || serialized.length > MAX_METADATA_FRONTMATTER) {
    return { omitted: "size" };
  }
  return { frontmatter: JSON.parse(serialized) as Record<string, unknown> };
}

function planPage(
  file: ScanResult["files"][number],
  mapping: LegacyWikiMapping,
  opts: PlanOptions,
  taken: Set<string>,
): PageDraft {
  const relpath = sanitizeLine(file.relpath, 200);
  const parsed = parseLegacyFrontmatter(file.content);
  const data = parsed.data;
  const notes: string[] = [];

  const slots = new Map<string, string>([
    [mapping.title.field, "title"],
    [mapping.type.field, "type"],
    [mapping.sensitivity.field, "sensitivity"],
  ]);
  if (mapping.occurred_at !== null)
    slots.set(mapping.occurred_at.field, "occurred_at");
  if (mapping.subjects !== null) slots.set(mapping.subjects.field, "subjects");

  const rawType = vocabulary(data[mapping.type.field]);
  const unusableType = rawType === "unusable";
  const legacyType = unusableType ? null : rawType;
  let type: PageType | null = mapping.type.default;
  let typeDecision: LegacyWikiPageReport["type"]["decision"] = "defaulted";
  let confidence = 0.75;
  if (legacyType !== null) {
    if (Object.prototype.hasOwnProperty.call(mapping.type.values, legacyType)) {
      type = mapping.type.values[legacyType] ?? null;
      typeDecision = type === null ? "excluded" : "mapped";
      confidence = 1;
    } else {
      typeDecision = "unmapped_value";
      confidence = 0.5;
    }
  }

  const title = planTitle(data, mapping, relpath, parsed.body);

  const rawSensitivity = vocabulary(data[mapping.sensitivity.field]);
  const unusableSensitivity = rawSensitivity === "unusable";
  const legacySensitivity = unusableSensitivity ? null : rawSensitivity;
  let label: PageSensitivity | null = null;
  let sensitivityDecision: LegacyWikiPageReport["sensitivity"]["decision"] =
    "unlabeled";
  if (legacySensitivity !== null) {
    label =
      mapping.sensitivity.values[legacySensitivity] ??
      ((IDENTITY_SENSITIVITIES as readonly string[]).includes(legacySensitivity)
        ? (legacySensitivity as PageSensitivity)
        : null);
    sensitivityDecision = label === null ? "unmapped_value" : "labeled";
  }

  let occurredAt: string | null = null;
  if (mapping.occurred_at !== null) {
    occurredAt = parseLegacyTimestamp(
      data[mapping.occurred_at.field],
      mapping.occurred_at.format,
    );
  }
  const occurredSource: "field" | "mtime" =
    occurredAt === null ? "mtime" : "field";
  const occurred = occurredAt ?? new Date(file.mtimeMs).toISOString();

  const subjects = planSubjects(data, mapping);
  const reserved = 2 + (legacyType === null ? 0 : 1) + (label === null ? 0 : 1);
  const fields = planFields(data, mapping, slots, reserved);
  if (unusableType) {
    fields.reports.push({
      key: sanitizeLine(mapping.type.field, 120),
      outcome: "dropped",
      to: "type",
      note: "unusable",
    });
  }
  if (unusableSensitivity) {
    fields.reports.push({
      key: sanitizeLine(mapping.sensitivity.field, 120),
      outcome: "dropped",
      to: "sensitivity",
      note: "unusable",
    });
  }

  const base: LegacyWikiPageReport = {
    relpath,
    outcome: "imported",
    target: null,
    kind: null,
    frontmatter: { status: parsed.status, problems: parsed.problems },
    type: { legacy: legacyType, mapped: type, decision: typeDecision },
    title: { source: title.source },
    sensitivity: {
      legacy:
        legacySensitivity === null
          ? null
          : sanitizeLine(legacySensitivity, MAX_VOCABULARY),
      label,
      decision: sensitivityDecision,
    },
    occurred_at: occurredSource,
    subjects: subjects.length,
    fields: fields.reports,
    notes,
  };

  if (type === null) {
    return {
      report: { ...base, outcome: "skipped", skip_reason: "type_excluded" },
      event: null,
    };
  }

  const target = planTarget(relpath, type, mapping, taken, notes);
  const points = [...parsed.body];
  const truncated = points.length > MAX_TEXT_LENGTH;
  if (truncated) notes.push("text_truncated");
  const text = truncated
    ? points.slice(0, MAX_TEXT_LENGTH).join("")
    : parsed.body;

  const extensions: Record<string, FrontmatterValue> = {
    ...fields.extensions,
    "x-legacy-path": relpath,
    "x-legacy-title-source": title.source,
  };
  if (legacyType !== null) {
    extensions["x-legacy-type"] = sanitizeLine(legacyType, MAX_VOCABULARY);
  }
  if (label !== null) extensions["x-legacy-sensitivity"] = label;

  const report: LegacyWikiPageReport = {
    ...base,
    target,
    kind: (ENTITY_TYPES as readonly string[]).includes(type)
      ? "entity"
      : "claim",
    notes,
  };
  const { relpath: _relpath, ...migration } = report;
  const frontmatter = jsonSafeFrontmatter(data);

  return {
    report,
    event: {
      schema: "kizuki.event/v1",
      connector_id: LEGACY_WIKI_CONNECTOR_ID,
      source_record_id: file.relpath,
      kind: "page",
      occurred_at: occurred,
      observed_at: opts.observedAt,
      text,
      subjects,
      ...(label !== null ? { sensitivity_hint: label } : {}),
      deleted: false,
      attachments: [],
      metadata: {
        relpath,
        size: file.size,
        mapping_hash: opts.mappingHash,
        frontmatter_status: parsed.status,
        ...("frontmatter" in frontmatter
          ? { frontmatter: frontmatter.frontmatter }
          : { frontmatter_omitted: frontmatter.omitted }),
        ...(truncated ? { text_truncated: true } : {}),
        page_candidate: {
          schema: PAGE_CANDIDATE_SCHEMA,
          type,
          title: title.title,
          target,
          extensions,
          confidence,
        },
        // The decision record travels with the evidence, so a page reviewed
        // months later still says what the migration did to it.
        migration,
      },
    },
  };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyCounts(): LegacyWikiCounts {
  const types = {} as Record<PageType, number>;
  for (const type of PAGE_TYPES) types[type] = 0;
  return {
    files: 0,
    imported: 0,
    skipped: 0,
    labeled: 0,
    unlabeled: 0,
    unmapped_sensitivity: 0,
    types,
    type_defaulted: 0,
    type_unmapped: 0,
    fields_renamed: 0,
    fields_dropped: 0,
    fields_coerced: 0,
    frontmatter_unparsed: 0,
    scan_truncated: false,
  };
}

function tally(counts: LegacyWikiCounts, page: LegacyWikiPageReport): void {
  counts.files += 1;
  if (page.outcome === "skipped") {
    counts.skipped += 1;
  } else {
    counts.imported += 1;
    if (page.type.mapped !== null) counts.types[page.type.mapped] += 1;
  }
  if (page.sensitivity.decision === "labeled") counts.labeled += 1;
  if (page.sensitivity.decision === "unlabeled") counts.unlabeled += 1;
  if (page.sensitivity.decision === "unmapped_value") {
    counts.unmapped_sensitivity += 1;
  }
  if (page.type.decision === "defaulted") counts.type_defaulted += 1;
  if (page.type.decision === "unmapped_value") counts.type_unmapped += 1;
  if (page.frontmatter.status === "unparsed") counts.frontmatter_unparsed += 1;
  for (const field of page.fields) {
    if (field.outcome === "renamed") counts.fields_renamed += 1;
    if (field.outcome === "coerced") counts.fields_coerced += 1;
    if (field.outcome === "dropped") counts.fields_dropped += 1;
  }
}

function skippedPage(
  entry: ScanResult["skipped"][number],
): LegacyWikiPageReport {
  return {
    relpath: entry.relpath,
    outcome: "skipped",
    skip_reason: entry.reason,
    target: null,
    kind: null,
    frontmatter: { status: "absent", problems: [] },
    type: { legacy: null, mapped: null, decision: "excluded" },
    title: { source: "filename" },
    sensitivity: { legacy: null, label: null, decision: "unlabeled" },
    occurred_at: "mtime",
    subjects: 0,
    fields: [],
    notes: [],
  };
}

export function planLegacyWiki(
  scan: ScanResult,
  mapping: LegacyWikiMapping,
  opts: PlanOptions,
): { events: CaptureEventInput[]; report: LegacyWikiReport } {
  const events: CaptureEventInput[] = [];
  const pages: LegacyWikiPageReport[] = [];
  const taken = new Set<string>();

  // Relpath order, whatever the caller handed over: collision suffixes and
  // therefore page paths would otherwise depend on directory read order.
  const files = [...scan.files].sort((a, b) => compare(a.relpath, b.relpath));
  for (const file of files) {
    const draft = planPage(file, mapping, opts, taken);
    pages.push(draft.report);
    if (draft.event !== null) events.push(draft.event);
  }
  for (const entry of scan.skipped) pages.push(skippedPage(entry));
  pages.sort((a, b) =>
    a.relpath < b.relpath ? -1 : a.relpath > b.relpath ? 1 : 0,
  );

  const counts = emptyCounts();
  for (const page of pages) tally(counts, page);
  counts.scan_truncated = scan.truncated;

  return {
    events,
    report: {
      schema: LEGACY_WIKI_REPORT_SCHEMA,
      generated_at: opts.observedAt,
      mapping_hash: opts.mappingHash,
      counts,
      pages,
      notes: [],
    },
  };
}
