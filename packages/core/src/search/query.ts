import type { Database } from "bun:sqlite";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import {
  ceilingSql,
  instantBound,
  instantParam,
  instantSql,
  placeholders,
  validLimit,
} from "../query/sql";
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
const OCCURRED_AT_INSTANT = instantSql("search_docs.occurred_at");
const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u;

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

/**
 * C0 controls, DEL, and surrogates left without their pair. A lone surrogate
 * has no UTF-8 encoding, so SQLite truncates the bound MATCH string at it and
 * raises "unterminated string" — quoting cannot neutralize that.
 */
const UNQUOTABLE =
  /[\u0000-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function sanitizeToken(raw: string): { value: string; prefix: boolean } | null {
  let value = raw.replace(UNQUOTABLE, "");
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

export function search(
  db: Database,
  query: string,
  opts: SearchOptions = {},
): SearchHit[] {
  // Arguments are checked before any short-circuit: an empty answer is a
  // result, and it must not hide a bound the caller mistyped.
  const limit = validLimit(opts.limit ?? 50, "search");
  const since =
    opts.since === undefined
      ? undefined
      : instantBound(opts.since, "search since");
  const until =
    opts.until === undefined
      ? undefined
      : instantBound(opts.until, "search until");

  const ftsQuery = toFtsQuery(query);
  if (ftsQuery.length === 0) return [];
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
    clauses.push(ceilingSql("search_docs.sensitivity"));
    bindings.push(SENSITIVITY_ORDER[opts.ceiling]);
  }
  if (opts.types !== undefined) {
    clauses.push(`page_type IN (${placeholders(opts.types.length)})`);
    bindings.push(...opts.types);
  }
  if (since !== undefined) {
    clauses.push(
      `(search_docs.scope = 'canon' OR ${OCCURRED_AT_INSTANT} >= ${instantParam})`,
    );
    bindings.push(since);
  }
  if (until !== undefined) {
    clauses.push(
      `(search_docs.scope = 'canon' OR ${OCCURRED_AT_INSTANT} < ${instantParam})`,
    );
    bindings.push(until);
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

  // bm25() weights are positional over every declared column, UNINDEXED ones
  // included: doc_id, scope, title, body, then the remaining six metadata
  // columns. Title is 4.0 so a title hit outranks a body hit of the same term.
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
         bm25(search_docs, 0, 0, 4.0, 1.0, 0, 0, 0, 0, 0, 0) AS rank
       FROM search_docs
       WHERE ${clauses.join(" AND ")}
       ORDER BY rank, scope, doc_id
       LIMIT ?`,
    )
    .all(...bindings);

  return rows.map((row) => ({
    ...row,
    subjects: JSON.parse(row.subjects) as string[],
  }));
}
