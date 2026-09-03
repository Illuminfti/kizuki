import { PAGE_TYPES } from "@kizuki/core";
import type { PageSensitivity, PageType } from "@kizuki/core";
import { sanitizeLine } from "../legacy/coerce";
import type { ScanResult, SkipReason } from "./scan";

/**
 * The decision record for a migration. It carries relpaths, legacy field
 * NAMES, the raw type and sensitivity VALUES (vocabulary, not content) and
 * the decisions taken — never a page title and never page prose, because the
 * report may be written outside the vault.
 */

export const LEGACY_WIKI_REPORT_SCHEMA =
  "kizuki.legacy-wiki-report/v1" as const;

export type FieldOutcome =
  "mapped" | "renamed" | "kept" | "coerced" | "dropped";

export type FieldNote =
  | "array_stringified"
  /** The field's NAME reads as a credential; the value never left the file. */
  | "credential"
  | "json_stringified"
  | "truncated"
  | "by_mapping"
  | "name_conflict"
  | "unnameable"
  | "over_limit"
  | "null"
  | "empty_array"
  | "unrepresentable"
  | "unusable";

export interface LegacyWikiFieldReport {
  key: string;
  outcome: FieldOutcome;
  /** Where the value landed: a mapping slot, or an `x-*` frontmatter name. */
  to?: string;
  note?: FieldNote;
}

export interface LegacyWikiPageReport {
  relpath: string;
  outcome: "imported" | "skipped";
  skip_reason?: "type_excluded" | SkipReason;
  target: string | null;
  kind: "entity" | "claim" | null;
  frontmatter: { status: "parsed" | "absent" | "unparsed"; problems: string[] };
  type: {
    legacy: string | null;
    mapped: PageType | null;
    decision: "mapped" | "defaulted" | "unmapped_value" | "excluded";
  };
  title: { source: "field" | "heading" | "filename" };
  sensitivity: {
    legacy: string | null;
    label: PageSensitivity | null;
    /**
     * `unreadable` is not `unlabeled`: the estate may well have labeled the
     * page, and the frontmatter it sits in could not be parsed. The two
     * resolve differently (RFC 0002 §8.1), so the report separates them.
     */
    decision: "labeled" | "unlabeled" | "unmapped_value" | "unreadable";
  };
  /** `observed` when the file's own mtime is outside the ledger's grammar. */
  occurred_at: "field" | "mtime" | "observed";
  subjects: number;
  fields: LegacyWikiFieldReport[];
  notes: string[];
}

export interface LegacyWikiCounts {
  files: number;
  imported: number;
  skipped: number;
  labeled: number;
  unlabeled: number;
  unmapped_sensitivity: number;
  unreadable_sensitivity: number;
  /** Labels the estate carried that the connector floor had to raise. */
  sensitivity_raised: number;
  types: Record<PageType, number>;
  type_defaulted: number;
  type_unmapped: number;
  fields_renamed: number;
  fields_dropped: number;
  fields_coerced: number;
  frontmatter_unparsed: number;
  scan_truncated: boolean;
}

export interface LegacyWikiReport {
  schema: typeof LEGACY_WIKI_REPORT_SCHEMA;
  generated_at: string;
  mapping_hash: string;
  counts: LegacyWikiCounts;
  /** Relpath order. */
  pages: LegacyWikiPageReport[];
  notes: string[];
}

export function emptyCounts(): LegacyWikiCounts {
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
export function tally(counts: LegacyWikiCounts, page: LegacyWikiPageReport): void {
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

export function skippedPage(
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

function cell(value: string): string {
  return sanitizeLine(value, 200).replace(/\|/g, "\\|");
}

function countsTable(counts: LegacyWikiCounts): string[] {
  const rows: [string, string][] = [
    ["files", String(counts.files)],
    ["imported", String(counts.imported)],
    ["skipped", String(counts.skipped)],
    ["labeled", String(counts.labeled)],
    ["unlabeled", String(counts.unlabeled)],
    ["unmapped sensitivity", String(counts.unmapped_sensitivity)],
    ["unreadable sensitivity", String(counts.unreadable_sensitivity)],
    ["sensitivity raised to floor", String(counts.sensitivity_raised)],
    ["type defaulted", String(counts.type_defaulted)],
    ["type unmapped", String(counts.type_unmapped)],
    ["fields renamed", String(counts.fields_renamed)],
    ["fields coerced", String(counts.fields_coerced)],
    ["fields dropped", String(counts.fields_dropped)],
    ["frontmatter unparsed", String(counts.frontmatter_unparsed)],
    ["scan truncated", String(counts.scan_truncated)],
  ];
  for (const [type, count] of Object.entries(counts.types)) {
    if (count > 0) rows.push([`type ${type}`, String(count)]);
  }
  return [
    "| measure | count |",
    "| --- | --- |",
    ...rows.map(([name, value]) => `| ${cell(name)} | ${cell(value)} |`),
  ];
}

function pageSection(page: LegacyWikiPageReport): string[] {
  const lines = [
    `## ${cell(page.relpath)}`,
    "",
    `- outcome: ${cell(page.outcome)}${page.skip_reason === undefined ? "" : ` (${cell(page.skip_reason)})`}`,
    `- target: ${page.target === null ? "none" : cell(page.target)}`,
    `- kind: ${page.kind === null ? "none" : cell(page.kind)}`,
    `- type: ${page.type.mapped ?? "none"} (${cell(page.type.decision)}${page.type.legacy === null ? "" : `, legacy ${cell(page.type.legacy)}`})`,
    `- sensitivity: ${page.sensitivity.label ?? "unlabeled"} (${cell(page.sensitivity.decision)}${page.sensitivity.legacy === null ? "" : `, legacy ${cell(page.sensitivity.legacy)}`})`,
    `- title from: ${cell(page.title.source)}`,
    `- occurred_at from: ${cell(page.occurred_at)}`,
    `- subjects: ${page.subjects}`,
    `- frontmatter: ${cell(page.frontmatter.status)}`,
  ];
  for (const problem of page.frontmatter.problems) {
    lines.push(`- frontmatter problem: ${cell(problem)}`);
  }
  for (const note of page.notes) lines.push(`- note: ${cell(note)}`);
  if (page.fields.length > 0) {
    lines.push(
      "",
      "| legacy field | outcome | to | note |",
      "| --- | --- | --- | --- |",
      ...page.fields.map(
        (field) =>
          `| ${cell(field.key)} | ${cell(field.outcome)} | ${cell(field.to ?? "")} | ${cell(field.note ?? "")} |`,
      ),
    );
  }
  lines.push("");
  return lines;
}

export function renderLegacyWikiReport(report: LegacyWikiReport): string {
  const lines = [
    "# Legacy wiki import report",
    "",
    `- generated at: ${cell(report.generated_at)}`,
    `- mapping hash: ${cell(report.mapping_hash)}`,
    ...report.notes.map((note) => `- note: ${cell(note)}`),
    "",
    ...countsTable(report.counts),
    "",
  ];
  for (const page of report.pages) lines.push(...pageSection(page));
  return `${lines.join("\n")}\n`;
}
