import { PAGE_TYPES, PAGE_CANDIDATE_SCHEMA } from "@kizuki/core";
import type { CaptureEventInput, PageSensitivity, PageType } from "@kizuki/core";
import type { FrontmatterValue } from "@kizuki/core/staging";
import { parseLegacyTimestamp, sanitizeLine } from "../legacy/coerce";
import {
  MAX_EXTENSIONS,
  jsonSafeFrontmatter,
  planFields,
  planSubjects,
  planTarget,
  planTitle,
  vocabulary,
} from "./decide";
import { parseLegacyFrontmatter } from "./frontmatter";
import { LEGACY_WIKI_CONNECTOR_ID } from "./mapping";
import type { LegacyWikiMapping } from "./mapping";
import type {
  LegacyWikiCounts,
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
const MAX_VOCABULARY = 64;
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
