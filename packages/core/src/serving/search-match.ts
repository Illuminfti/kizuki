import { Database } from "bun:sqlite";
import { neutralizeControlTags, sanitizeCapturedText, scrubText } from "../producer/scrub";
import { toRelaxedFtsQuery } from "../search/relax";
import { toFtsQuery } from "../search/query";

/**
 * Searchable visible content, excluding only markers the scrubber inserted.
 * Keep their width until after the excerpt cut so a clipped marker cannot
 * confirm a hidden value, and content beyond the served bound cannot move in.
 * Literal marker-shaped source prose remains ordinary searchable content.
 */
export function searchableText(value: string, maxChars?: number, exactSecrets: readonly string[] = []): string {
  const scrubbed = scrubText(sanitizeCapturedText(value), exactSecrets);
  let masked = "", cursor = 0;
  for (const span of scrubbed.redactions) {
    masked += scrubbed.text.slice(cursor, span.out_start) + " ".repeat(span.out_end - span.out_start);
    cursor = span.out_end;
  }
  masked += scrubbed.text.slice(cursor);
  masked = neutralizeControlTags(masked);
  return maxChars === undefined ? masked : Array.from(masked).slice(0, maxChars).join("");
}

/** Recheck a nomination against the exact text released, using the floor's FTS grammar. */
export function servedTextMatcher(query: string) {
  const db = new Database(":memory:");
  db.exec("CREATE VIRTUAL TABLE served_text USING fts5(title, body, tokenize='unicode61 remove_diacritics 2')");
  const ftsQuery = toFtsQuery(query);
  const relaxed = toRelaxedFtsQuery(query);
  const insert = db.prepare("INSERT INTO served_text(title,body) VALUES (?,?)");
  const matches = db.prepare<{ found: number }, [string]>("SELECT 1 AS found FROM served_text WHERE served_text MATCH ? LIMIT 1");
  const coverage = (title: string, body: string): number => {
    if (ftsQuery === "") return 0;
    db.exec("DELETE FROM served_text");
    insert.run(title, body);
    if (matches.get(ftsQuery) !== null) return 1;
    if (relaxed === null) return 0;
    const found = relaxed.terms.filter(term => matches.get(term) !== null).length;
    return found < relaxed.required ? 0 : found / relaxed.terms.length;
  };
  return {
    coverage,
    matches(title: string, body: string): boolean { return coverage(title, body) > 0; },
    close() { db.close(); },
  };
}
