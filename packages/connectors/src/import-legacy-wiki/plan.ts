import {
  ENTITY_PAGE_TYPES,
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
  PAGE_TYPES,
  validatePageCandidate,
} from "@kizuki/core";
import type { CaptureEventInput, PageSensitivity, PageType } from "@kizuki/core";
import type { FrontmatterValue } from "@kizuki/core/staging";
import {
  mappedValue,
  parseLegacyTimestamp,
  rfc3339From,
  sanitizeLine,
} from "../legacy/coerce";
import {
  LEGACY_SENSITIVITY_FLOOR,
  atLegacyFloor,
} from "../legacy/sensitivity";
import { compareStrings } from "../util";
import {
  jsonSafeFrontmatter,
  newTargetIndex,
  planFields,
  planSubjects,
  planTarget,
  planTitle,
  vocabulary,
} from "./decide";
import type { TargetIndex } from "./decide";
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

export interface PlanOptions {
  observedAt: string;
  mappingHash: string;
  /**
   * Relpath to the target a previous run already emitted for it. Collision
   * suffixes are decided over the whole wiki, but a sync only emits what
   * changed, so a page added later would otherwise be handed the unsuffixed
   * target an earlier page is already staged at. A page keeps the target it
   * was emitted with; only pages the ledger has never seen are placed around
   * those.
   */
  pinned?: Record<string, string>;
}

interface PageDraft {
  report: LegacyWikiPageReport;
  event: CaptureEventInput | null;
}

function planPage(
  file: ScanResult["files"][number],
  mapping: LegacyWikiMapping,
  opts: PlanOptions,
  targets: TargetIndex,
): PageDraft {
  const pinned = opts.pinned?.[file.relpath];
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
  const unusableType = !rawType.ok && rawType.reason === "unusable";
  const legacyType = rawType.ok ? rawType.value : null;
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
  const unusableSensitivity =
    !rawSensitivity.ok && rawSensitivity.reason === "unusable";
  const legacySensitivity = rawSensitivity.ok ? rawSensitivity.value : null;
  const read =
    legacySensitivity === null
      ? null
      : (mappedValue(mapping.sensitivity.values, legacySensitivity) ??
        ((IDENTITY_SENSITIVITIES as readonly string[]).includes(
          legacySensitivity,
        )
          ? (legacySensitivity as PageSensitivity)
          : null));
  const sensitivityDecision: LegacyWikiPageReport["sensitivity"]["decision"] =
    read !== null
      ? "labeled"
      : legacySensitivity !== null
        ? "unmapped_value"
        : parsed.status === "unparsed" || unusableSensitivity
          ? "unreadable"
          : "unlabeled";
  // Nothing leaves this planner unlabeled, and only a page the estate really
  // carried no label for takes the connector default: a value the mapping
  // cannot read, or a page whose frontmatter did not parse at all, is
  // unknown, and unknown resolves to `private` (RFC 0002 section 8.1).
  const resolved: PageSensitivity =
    read ??
    (sensitivityDecision === "unlabeled"
      ? mapping.sensitivity.default
      : "private");
  // The floor is the connector's, not the mapping's: an owner who widens the
  // default cannot publish an estate below the class it belongs to (8.2).
  const label = atLegacyFloor(resolved);
  if (label !== resolved) notes.push("sensitivity: raised_to_floor");

  let occurredAt: string | null = null;
  if (mapping.occurred_at !== null) {
    occurredAt = parseLegacyTimestamp(
      data[mapping.occurred_at.field],
      mapping.occurred_at.format,
    );
  }
  // A filesystem stores 64-bit timestamps; the ledger's grammar covers years
  // 0000..9999. An mtime outside it would make the whole event invalid, and
  // one invalid event holds the run's cursor back forever — every later run
  // re-walks the wiki, no snapshot persists, and no deletion is tombstoned.
  const mtime = rfc3339From(new Date(file.mtimeMs));
  if (occurredAt === null && mtime === null) {
    notes.push("occurred_at: unusable_mtime");
  }
  const occurredSource: LegacyWikiPageReport["occurred_at"] =
    occurredAt !== null ? "field" : mtime !== null ? "mtime" : "observed";
  const occurred = occurredAt ?? mtime ?? opts.observedAt;

  const subjects = planSubjects(data, mapping);
  const fields = planFields(data, mapping, slots);
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
    type: {
      // Vocabulary, capped like the sensitivity value below it: the raw string
      // is a page's own frontmatter, and the JSON report is written verbatim.
      legacy:
        legacyType === null
          ? null
          : sanitizeLine(legacyType, MAX_VOCABULARY),
      mapped: type,
      decision: typeDecision,
    },
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

  const target = planTarget(relpath, type, mapping, targets, notes, pinned);
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
  // Only a label the estate really carried: a defaulted one would read as
  // evidence of a decision the previous system never made.
  if (read !== null) extensions["x-legacy-sensitivity"] = read;

  const candidate = {
    schema: PAGE_CANDIDATE_SCHEMA,
    type,
    title: title.title,
    target,
    extensions,
    confidence,
  };
  // The floor validates a candidate before it stages one and silently falls
  // back to a blockquoted capture note when it fails. A page that would lose
  // its type, title and target that way is a reported decision here, not a
  // surprise three layers down.
  const checked = validatePageCandidate({ [PAGE_CANDIDATE_KEY]: candidate });
  const usable = checked !== null && checked.ok;
  if (!usable) notes.push("candidate_rejected");

  const report: LegacyWikiPageReport = {
    ...base,
    target: usable ? target : null,
    // The floor decides the proposal kind from the same list, so the
    // report cannot disagree with what staging actually files.
    kind: !usable
      ? null
      : (ENTITY_PAGE_TYPES as readonly string[]).includes(type)
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
      sensitivity_hint: label,
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
        ...(usable ? { [PAGE_CANDIDATE_KEY]: candidate } : {}),
        // The decision record travels with the evidence, so a page reviewed
        // months later still says what the migration did to it.
        migration,
      },
    },
  };
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
    unreadable_sensitivity: 0,
    sensitivity_raised: 0,
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

/**
 * Every count except `files` and `skipped` describes the import. A page the
 * walk never read has no decisions to report — `skippedPage` fills its row
 * with placeholders — and counting those placeholders told the owner they had
 * more pages to label than the import actually produced.
 */
function tally(counts: LegacyWikiCounts, page: LegacyWikiPageReport): void {
  counts.files += 1;
  if (page.outcome === "skipped") {
    counts.skipped += 1;
    return;
  }
  counts.imported += 1;
  if (page.type.mapped !== null) counts.types[page.type.mapped] += 1;
  if (page.sensitivity.decision === "labeled") counts.labeled += 1;
  if (page.sensitivity.decision === "unlabeled") counts.unlabeled += 1;
  if (page.sensitivity.decision === "unmapped_value") {
    counts.unmapped_sensitivity += 1;
  }
  if (page.sensitivity.decision === "unreadable") {
    counts.unreadable_sensitivity += 1;
  }
  if (page.notes.includes("sensitivity: raised_to_floor")) {
    counts.sensitivity_raised += 1;
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
    relpath: sanitizeLine(entry.relpath, 200),
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
  const targets = newTargetIndex(Object.values(opts.pinned ?? {}));

  // Relpath order, whatever the caller handed over: collision suffixes and
  // therefore page paths would otherwise depend on directory read order.
  const files = [...scan.files].sort((a, b) =>
    compareStrings(a.relpath, b.relpath),
  );
  for (const file of files) {
    const draft = planPage(file, mapping, opts, targets);
    pages.push(draft.report);
    if (draft.event !== null) events.push(draft.event);
  }
  for (const entry of scan.skipped) pages.push(skippedPage(entry));
  pages.sort((a, b) => compareStrings(a.relpath, b.relpath));

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
