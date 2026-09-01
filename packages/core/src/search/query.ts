import type { Database } from "bun:sqlite";
import type { PageSensitivity } from "../vault/schema";

export interface SearchOptions {
  scope?: "canon" | "ledger" | "all";
  limit?: number;
  ceiling?: PageSensitivity;
  types?: string[];
  since?: string;
  until?: string;
  subjects?: string[];
  excludePaths?: string[];
}

export interface SearchHit {
  doc_id: string;
  scope: "canon" | "ledger";
  title: string;
  path: string;
  page_type: string;
  sensitivity: string;
  occurred_at: string;
  connector_id: string;
  subjects: string[];
  snippet: string;
  rank: number;
}

interface SearchRow extends Omit<SearchHit, "subjects"> {
  subjects: string;
}

const BOOLEAN_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
const CEILING_RANK: Record<PageSensitivity, number> = {
  public: 0,
  personal: 1,
  private: 2,
};

function tokens(raw: string): string[] {
  const result: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index] as string;
    if (character === '"') {
      if (quoted && raw[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (/\s/.test(character) && !quoted) {
      if (current.length > 0) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function sanitizeToken(raw: string): { value: string; prefix: boolean } | null {
  let value = raw.trim();
  if (BOOLEAN_OPERATORS.has(value.toUpperCase())) return null;

  value = value.replace(/^NEAR(?:\/\d+)?\(/i, "");
  const prefix =
    value.length > 1 &&
    value.endsWith("*") &&
    value.indexOf("*") === value.length - 1;
  value = value.replace(/\*/g, "").replace(/[()\[\]{}:^+~-]/g, "").trim();

  if (value.length === 0 || BOOLEAN_OPERATORS.has(value.toUpperCase())) {
    return null;
  }
  return { value, prefix };
}

export function toFtsQuery(raw: string): string {
  return tokens(raw)
    .map(sanitizeToken)
    .filter((token): token is { value: string; prefix: boolean } => token !== null)
    .map(({ value, prefix }) =>
      `"${value.replaceAll('"', '""')}"${prefix ? "*" : ""}`,
    )
    .join(" ");
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

function validLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError("search limit must be a non-negative integer");
  }
  return limit;
}

export function search(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  const ftsQuery = toFtsQuery(query);
  if (ftsQuery.length === 0) return [];
  const limit = validLimit(opts.limit ?? 50);
  if (limit === 0 || opts.types?.length === 0 || opts.subjects?.length === 0) {
    return [];
  }

  const clauses = ["search_docs MATCH ?"];
  const bindings: (string | number)[] = [ftsQuery];
  if (opts.scope !== undefined && opts.scope !== "all") {
    clauses.push("scope = ?");
    bindings.push(opts.scope);
  }
  if (opts.ceiling !== undefined) {
    clauses.push(`
      CASE sensitivity
        WHEN 'public' THEN 0
        WHEN 'personal' THEN 1
        WHEN 'private' THEN 2
        ELSE NULL
      END <= ?
    `);
    bindings.push(CEILING_RANK[opts.ceiling]);
  }
  if (opts.types !== undefined) {
    clauses.push(`page_type IN (${placeholders(opts.types.length)})`);
    bindings.push(...opts.types);
  }
  if (opts.since !== undefined) {
    clauses.push("occurred_at >= ?");
    bindings.push(opts.since);
  }
  if (opts.until !== undefined) {
    clauses.push("occurred_at < ?");
    bindings.push(opts.until);
  }
  if (opts.subjects !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(search_docs.subjects)
      WHERE value IN (${placeholders(opts.subjects.length)})
    )`);
    bindings.push(...opts.subjects);
  }
  if (opts.excludePaths !== undefined && opts.excludePaths.length > 0) {
    clauses.push(`path NOT IN (${placeholders(opts.excludePaths.length)})`);
    bindings.push(...opts.excludePaths);
  }
  bindings.push(limit);

  const rows = db
    .query<SearchRow, (string | number)[]>(
      `SELECT
         doc_id,
         scope,
         title,
         path,
         page_type,
         sensitivity,
         occurred_at,
         connector_id,
         subjects,
         snippet(search_docs, 3, '[', ']', '…', 24) AS snippet,
         bm25(search_docs, 4.0, 1.0) AS rank
       FROM search_docs
       WHERE ${clauses.join(" AND ")}
       ORDER BY rank, doc_id
       LIMIT ?`,
    )
    .all(...bindings);

  return rows.map((row) => ({
    ...row,
    scope: row.scope,
    subjects: JSON.parse(row.subjects) as string[],
  }));
}
