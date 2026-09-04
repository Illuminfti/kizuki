import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import type { RetrievalAuthority } from "../contracts/retrieval";
import { readDerivedMeta } from "../derived-meta";
import { tableExists } from "../ledger/schema";
import { ceilingSql, instantBound, instantSql } from "../query/sql";
import { placeholders } from "../util/sql";
import type { DocScope } from "./indexer";

export interface SearchOptions {
  scope?: DocScope | "all";
  limit?: number;
  ceiling?: Sensitivity;
  types?: string[];
  since?: string;
  until?: string;
  subjects?: string[];
  excludePaths?: string[];
}

export interface SearchHit {
  doc_id: string;
  scope: DocScope;
  title: string;
  path: string;
  page_type: string;
  sensitivity: string;
  taint: "clean" | "quoted";
  authority: RetrievalAuthority;
  occurred_at: string;
  connector_id: string;
  subjects: string[];
  snippet: string;
  rank: number;
}

export interface SearchResult {
  hits: SearchHit[];
  degraded: string[];
}

interface SearchRow extends Omit<SearchHit, "subjects"> {
  subjects: string;
}

const BOOLEAN_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
const OCCURRED_AT_INSTANT = instantSql("search_docs.occurred_at");
const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u;
const MAX_QUERY_CHARS = 32_000;
const MAX_FILTER = 1_000;

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
  let value = raw.replace(/[\u0000-\u001f\u007f]/g, "");
  if (BOOLEAN_OPERATORS.has(value.toUpperCase())) return null;

  const prefix =
    value.length > 1 &&
    value.endsWith("*") &&
    value.indexOf("*") === value.length - 1;
  value = value.replace(/\*/g, "");
  if (!HAS_TOKEN_CHAR.test(value)) return null;
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

function validLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_RETRIEVAL_LIMIT) {
    throw new RangeError(
      `search limit must be an integer between 0 and ${MAX_RETRIEVAL_LIMIT}`,
    );
  }
  return limit;
}

function validQueryText(query: string): string {
  if (query.length > MAX_QUERY_CHARS) {
    throw new RangeError(
      `search query must be at most ${MAX_QUERY_CHARS} characters`,
    );
  }
  return query;
}

function validFilters(values: string[] | undefined, field: string): string[] | undefined {
  if (values === undefined) return undefined;
  if (values.length > MAX_FILTER) {
    throw new RangeError(`search ${field} must have at most ${MAX_FILTER} entries`);
  }
  if (
    values.some(
      (value) => value.length === 0 || value.length > 4_096,
    )
  ) {
    throw new RangeError(`search ${field} entries are invalid`);
  }
  return values;
}

export function searchResult(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): SearchResult {
  const ftsQuery = toFtsQuery(validQueryText(query));
  const degraded: string[] = [];
  if (ftsQuery.length === 0) {
    return { hits: [], degraded: ["query-empty"] };
  }
  const limit = validLimit(opts.limit ?? 50);
  const types = validFilters(opts.types, "types");
  const subjects = validFilters(opts.subjects, "subjects");
  const excludePaths = validFilters(opts.excludePaths, "excludePaths");
  if (limit === 0 || types?.length === 0 || subjects?.length === 0) {
    return { hits: [], degraded: [...degraded, "scope-empty"] };
  }

  const meta = readDerivedMeta(db, "search");
  if (meta !== null && meta.status !== "ok") {
    degraded.push(`index-${meta.status}`);
  }
  if (!tableExists(db, "search_docs")) {
    return { hits: [], degraded: [...degraded, "index-degraded"] };
  }

  const clauses = ["search_docs MATCH ?"];
  const bindings: (string | number)[] = [ftsQuery];
  if (opts.scope !== undefined && opts.scope !== "all") {
    clauses.push("scope = ?");
    bindings.push(opts.scope);
  }
  if (opts.ceiling !== undefined) {
    clauses.push(ceilingSql("search_docs.sensitivity"));
    bindings.push(SENSITIVITY_ORDER[opts.ceiling]);
  }
  if (types !== undefined) {
    clauses.push(`page_type IN (${placeholders(types.length)})`);
    bindings.push(...types);
  }
  if (opts.since !== undefined) {
    clauses.push(
      `(search_docs.scope = 'canon' OR ${OCCURRED_AT_INSTANT} >= julianday(?))`,
    );
    bindings.push(instantBound(opts.since, "search since"));
  }
  if (opts.until !== undefined) {
    clauses.push(
      `(search_docs.scope = 'canon' OR ${OCCURRED_AT_INSTANT} < julianday(?))`,
    );
    bindings.push(instantBound(opts.until, "search until"));
  }
  if (subjects !== undefined) {
    clauses.push(`EXISTS (
      SELECT 1 FROM json_each(search_docs.subjects)
      WHERE value IN (${placeholders(subjects.length)})
    )`);
    bindings.push(...subjects);
  }
  if (excludePaths !== undefined && excludePaths.length > 0) {
    clauses.push(`path NOT IN (${placeholders(excludePaths.length)})`);
    bindings.push(...excludePaths);
  }
  bindings.push(limit);

  // bm25() weights are positional over every declared column, UNINDEXED ones
  // included: doc_id, scope, title, body, then the remaining metadata columns.
  const rows = db
    .query<SearchRow, (string | number)[]>(
      `SELECT
         doc_id,
         scope,
         title,
         path,
         page_type,
         sensitivity,
         taint,
         authority,
         occurred_at,
         connector_id,
         subjects,
         snippet(search_docs, 3, '[', ']', '…', 24) AS snippet,
         bm25(search_docs, 0, 0, 4.0, 1.0, 0, 0, 0, 0, 0, 0, 0, 0, 0) AS rank
       FROM search_docs
       WHERE ${clauses.join(" AND ")}
       ORDER BY rank, scope, doc_id
       LIMIT ?`,
    )
    .all(...bindings);

  return {
    hits: rows.map((row) => ({
      ...row,
      subjects: JSON.parse(row.subjects) as string[],
    })),
    degraded,
  };
}

export function search(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  return searchResult(db, query, opts).hits;
}
