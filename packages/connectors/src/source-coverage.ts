import type { ScanCoverage } from "@kizuki/core/world";
import { matchesGlob } from "./legacy/coerce";

/** Rule vocabulary is hostile source configuration; keep receipts bounded and terminal-safe. */
export function coverageRules(rules: Iterable<string>, limit = 512): ScanCoverage["excluded"] {
  const counts = new Map<string, number>();
  for (const raw of rules) {
    const rule = raw.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 256) || "unnamed_rule";
    const key = counts.has(rule) || counts.size < limit - 1 ? rule : "other_exclusion_rules";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([rule, count]) => ({ rule, count }));
}

export function wikiCoverage(
  scan: import("./import-legacy-wiki/scan").ScanResult,
  report: import("./import-legacy-wiki/report").LegacyWikiReport,
  mapping: import("./import-legacy-wiki/mapping").LegacyWikiMapping,
): ScanCoverage {
  const rules: string[] = [];
  for (const skipped of scan.skipped) {
    if (skipped.reason === "ignored") {
      const pattern = mapping.ignore.find(pattern => matchesGlob(skipped.relpath, pattern));
      rules.push(`ignore:${pattern ?? "mapping"}`);
    }
  }
  for (const page of report.pages) {
    if (page.skip_reason === "type_excluded") rules.push(`type_excluded:${page.type.legacy ?? "unmapped"}`);
  }
  const excluded = coverageRules(rules, 510);
  for (const rule of coverageRules([...mapping.ignore.map(pattern => `ignore:${pattern}`),
    ...Object.entries(mapping.type.values).filter(([, value]) => value === null).map(([type]) => `type_excluded:${type}`)])) {
    if (!excluded.some(entry => entry.rule === rule.rule) && excluded.length < 510) excluded.push({ rule: rule.rule, count: 0 });
  }
  for (const rule of ["dot_entries", "mapping_file"] as const) {
    excluded.push({ rule, count: scan.omitted?.[rule] ?? 0 });
  }
  excluded.sort((a, b) => a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0);
  return { scanned: scan.files.length + scan.skipped.filter(entry => entry.kind === "file" && entry.reason !== "ignored").length,
    excluded, pending: 0, failed: scan.skipped.filter(entry => entry.reason !== "ignored").length,
    truncated: scan.truncated, content_exclusions: ["attachments and non-Markdown content are not captured"] };
}
