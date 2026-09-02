import type { PageSensitivity, PageType } from "@kizuki/core";
import { sanitizeLine } from "../legacy/coerce";
import type { SkipReason } from "./scan";

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
    decision: "labeled" | "unlabeled" | "unmapped_value";
  };
  occurred_at: "field" | "mtime";
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
