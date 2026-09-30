import type { Database } from "bun:sqlite";
import type { Sensitivity } from "../agents/types";
import { machineOriginSql } from "../canon/origin";
import { MAX_RETRIEVAL_LIMIT } from "../contracts/retrieval";
import type { RetrievalAuthority } from "../contracts/retrieval";
import { readDerivedHolds } from "../derived-holds";
import { readDerivedMeta } from "../derived-meta";
import { tableExists } from "../ledger/schema";
import { sourceServingSql, type SourcePurpose } from "../ledger/source-grants";
import { ceilingSql, instantBoundPair, instantPairSql, requireCeiling } from "../query/sql";
import { placeholders } from "../util/sql";
import type { DocScope } from "./indexer";
import { isQuestionQuery, RELAX_BELOW_MATCHES, toRelaxedFtsQuery } from "./relax";
import type { RelaxedQuery } from "./relax";
import { currentVersionSql } from "./versions";

export interface SearchOptions {
  scope?: DocScope | "all";
  limit?: number;
  ceiling: Sensitivity;
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
  /**
   * Share of the query's content terms this hit contains, in (0, 1]. A
   * literal match is 1. A relaxed match is below 1 when it lacks some terms,
   * so a caller can abstain on a weak answer.
   */
  coverage: number;
}

export interface SearchResult {
  hits: SearchHit[];
  degraded: string[];
}

interface SearchRow extends Omit<SearchHit, "subjects"> {
  subjects: string;
}

/** Labels a relaxed search: it answered, or it tried and found nothing. */
export const RELAXED_LABEL = "query-relaxed";
export const NO_MATCH_LABEL = "query-no-match";

const BOOLEAN_OPERATORS = new Set(["AND", "OR", "NOT", "NEAR"]);
const OCCURRED_AT_PAIR = instantPairSql("search_docs.occurred_at");
const HAS_TOKEN_CHAR = /[\p{L}\p{N}]/u;
const MAX_QUERY_CHARS = 32_000;
const MAX_FILTER = 1_000;
// Count highlighted match spans, rather than corpus-wide BM25 statistics:
// adding evidence a reader cannot see must not change their ranking. Titles
// count four times as much as body matches; length normalization is capped so
// long entity pages are not buried by short digests.
const matchSpans = (column: number, text: string) =>
  `(length(highlight(search_docs, ${column}, char(1), char(2))) - length(${text})) / 2.0`;
// Repeated mentions saturate instead of letting a long archive or digest
// overwhelm the short page that records the decision.
const frequency = (spans: string) => `(${spans}) / (1.0 + (${spans}))`;
const RANK_SQL = `-(4.0 * (${frequency(matchSpans(2, "search_docs.title"))}) + (${frequency(matchSpans(3, "search_docs.body"))})) / (1000.0 + min(length(search_docs.body), 1000))`;
/**
 * Rank is negative, so scaling toward zero ranks a page lower. Loop-written
 * pages and rollups lose a close call to a page the owner wrote.
 */
const MACHINE_EXHAUST_WEIGHT = 0.5;
const MACHINE_EXHAUST_SQL = `(search_docs.scope = 'canon' AND (${machineOriginSql("search_docs.path")} OR search_docs.page_type = 'rollup'))`;
const ADJUSTED_RANK_SQL = `${RANK_SQL} * CASE WHEN ${MACHINE_EXHAUST_SQL} THEN ${MACHINE_EXHAUST_WEIGHT} ELSE 1.0 END`;

interface SearchPlan {
  /** A WITH clause the relaxed query needs ahead of its SELECT, or empty. */
  head: string;
  tail: string | null;
  /** Bindings for `head`, then for `tail`. */
  bindings: (string | number)[];
  /** SQL for the hit's share of the query's terms; null for a literal match, which is 1. */
  coverage: string | null;
  relaxed: boolean;
  degraded: string[];
}

const EMPTY_PLAN = { head: "", tail: null, bindings: [], coverage: null, relaxed: false };

/** Names a relaxed search's outcome from the rows it produced. */
function relaxedOutcome(plan: SearchPlan, rows: number, skip: number): string[] {
  if (!plan.relaxed) return [];
  return [RELAXED_LABEL, ...(rows === 0 && skip === 0 ? [NO_MATCH_LABEL] : [])];
}

/**
 * Candidates that contain at least `required` of the query's terms. Each term
 * is matched on its own, so the count is exact rather than a ranking guess.
 */
function coverageCte(relaxed: RelaxedQuery): { sql: string; bindings: string[] } {
  const terms = relaxed.terms
    .map(() => "SELECT rowid AS id FROM search_docs WHERE search_docs MATCH ?")
    .join(" UNION ALL ");
  return {
    sql: `WITH covered(id, terms) AS (SELECT id, count(*) FROM (${terms}) GROUP BY id HAVING count(*) >= ${relaxed.required}) `,
    bindings: relaxed.terms,
  };
}

function titleKey(query: string): string {
  return query.trim().replace(/\s+/g, " ");
}

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

/** Internal ranked-window skip. Not a public search cursor. */
function validOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("search offset must be a non-negative integer");
  }
  return offset;
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

/** Shared bounded selection; only the internal audit projection omits a ceiling. */
function searchPlan(
  db: Database,
  query: string,
  opts: Omit<SearchOptions, "ceiling">,
  ceiling: number | null,
  source?: { owner: boolean; purpose?: SourcePurpose },
  offset?: number,
  canonIds?: readonly string[],
): SearchPlan {
  const ftsQuery = toFtsQuery(validQueryText(query));
  const degraded: string[] = [];
  if (ftsQuery.length === 0) {
    return { ...EMPTY_PLAN, degraded: ["query-empty"] };
  }
  const limit = validLimit(opts.limit ?? 50);
  const skip = validOffset(offset);
  const types = validFilters(opts.types, "types");
  const subjects = validFilters(opts.subjects, "subjects");
  const excludePaths = validFilters(opts.excludePaths, "excludePaths");
  if (limit === 0 || types?.length === 0 || subjects?.length === 0) {
    return { ...EMPTY_PLAN, degraded: [...degraded, "scope-empty"] };
  }

  const meta = readDerivedMeta(db, "search");
  if (source?.owner !== false && meta !== null && meta.status !== "ok") {
    degraded.push(`index-${meta.status}`);
  }
  if (!tableExists(db, "search_docs")) {
    return { ...EMPTY_PLAN, degraded: [...degraded, "index-degraded"] };
  }

  const clauses: string[] = [];
  const bindings: (string | number)[] = [];
  const heldPaths = [...readDerivedHolds(db).paths];
  if (heldPaths.length > 0) {
    clauses.push(
      `(search_docs.scope != 'canon' OR path NOT IN (${placeholders(heldPaths.length)}))`,
    );
    bindings.push(...heldPaths);
  }
  if (opts.scope !== undefined && opts.scope !== "all") {
    clauses.push("scope = ?");
    bindings.push(opts.scope);
  }
  if (ceiling !== null) {
    clauses.push(ceilingSql("search_docs.sensitivity"));
    bindings.push(ceiling);
  }
  if (canonIds !== undefined) {
    clauses.push(`(search_docs.scope != 'canon' OR search_docs.doc_id IN (SELECT value FROM json_each(?)))`);
    bindings.push(JSON.stringify(canonIds));
  }
  if (types !== undefined) {
    clauses.push(`page_type IN (${placeholders(types.length)})`);
    bindings.push(...types);
  }
  if (opts.since !== undefined || opts.until !== undefined) {
    // Canon pages have no occurrence-time contract; never bypass a time bound.
    clauses.push("search_docs.scope = 'ledger'");
    if (opts.scope !== "ledger") degraded.push("canon-time-scope-unsupported");
  }
  if (opts.since !== undefined) {
    clauses.push(`${OCCURRED_AT_PAIR} >= (?, ?)`);
    bindings.push(...instantBoundPair(opts.since, "search since"));
  }
  if (opts.until !== undefined) {
    clauses.push(`${OCCURRED_AT_PAIR} < (?, ?)`);
    bindings.push(...instantBoundPair(opts.until, "search until"));
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
  if (source !== undefined) {
    const predicate = sourceServingSql(db, source, ceiling);
    if (predicate !== null) {
      // Ledger rows correlate to events so LIMIT counts authorized identities.
      // Canon live provenance is vault-admitted, not an FTS primitive.
      clauses.push(`(search_docs.scope != 'ledger' OR EXISTS (
        SELECT 1 FROM events
         WHERE events.event_id = CASE
           WHEN search_docs.doc_id LIKE 'event:%' THEN substr(search_docs.doc_id, 7)
           ELSE search_docs.doc_id
         END
           AND ${predicate.sql}
      ))`);
      bindings.push(...predicate.bindings);
    }
  }
  // A standalone floor projection can be queried without a ledger. Serving
  // still requires live ledger evidence; when it is present, choose the
  // reader's current source version before counting or limiting matches.
  if (tableExists(db, "events")) {
    const current = currentVersionSql(db, {
      ceiling,
      ...(types === undefined ? {} : { types }),
      ...(subjects === undefined ? {} : { subjects }),
      ...(opts.since === undefined ? {} : { since: opts.since }),
      ...(opts.until === undefined ? {} : { until: opts.until }),
      ...(source === undefined ? {} : { source }),
    });
    clauses.push(`(search_docs.scope != 'ledger' OR NOT EXISTS (
      SELECT 1 FROM events WHERE events.event_id = CASE
        WHEN search_docs.doc_id LIKE 'event:%' THEN substr(search_docs.doc_id, 7)
        ELSE search_docs.doc_id END AND NOT (${current.sql})
    ))`);
    bindings.push(...current.bindings);
  }
  const filters = clauses.map((clause) => ` AND ${clause}`).join("");

  // A question that finds almost nothing literally is retried as its content
  // words; an unanswerable one then matches nothing instead of everything.
  const question = toRelaxedFtsQuery(query);
  const literal = question === null
    ? RELAX_BELOW_MATCHES
    : db
        .query<{ found: number }, (string | number)[]>(
          `SELECT count(*) AS found FROM (
             SELECT 1 FROM search_docs WHERE search_docs MATCH ?${filters} LIMIT ${RELAX_BELOW_MATCHES}
           )`,
        )
        .get(ftsQuery, ...bindings)!.found;
  const relaxed = question !== null && literal < RELAX_BELOW_MATCHES ? question : null;

  // An exact title keeps its boost even when a question takes the relaxed path.
  const order = ["CASE WHEN trim(search_docs.title) = ? COLLATE NOCASE THEN 0 ELSE 1 END"];
  const orderBindings = [titleKey(query)];
  if (relaxed !== null) order.push("covered.terms DESC");
  order.push(ADJUSTED_RANK_SQL, "scope", "doc_id");

  const covered = relaxed === null ? null : coverageCte(relaxed);
  const tailBindings = [
    relaxed === null ? ftsQuery : relaxed.fts,
    ...bindings,
    ...orderBindings,
    limit,
    ...(skip === 0 ? [] : [skip]),
  ];
  return {
    head: covered?.sql ?? "",
    tail: `FROM search_docs${covered === null ? "" : " JOIN covered ON covered.id = search_docs.rowid"} WHERE search_docs MATCH ?${filters} ORDER BY ${order.join(", ")} LIMIT ?${skip === 0 ? "" : " OFFSET ?"}`,
    bindings: [...(covered?.bindings ?? []), ...tailBindings],
    coverage: relaxed === null ? null : `covered.terms * 1.0 / ${relaxed.terms.length}`,
    relaxed: relaxed !== null,
    degraded,
  };
}

export function searchResult(
  db: Database,
  query: string,
  opts: SearchOptions,
): SearchResult {
  const ceiling = requireCeiling(opts?.ceiling);
  const plan = searchPlan(db, query, opts, ceiling);
  if (plan.tail === null) return { hits: [], degraded: plan.degraded };

  const rows = db
    .query<SearchRow, (string | number)[]>(
      `${plan.head}SELECT
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
         ${RANK_SQL} AS rank,
         ${plan.coverage ?? "1.0"} AS coverage
       ${plan.tail}`,
    )
    .all(...plan.bindings);

  return {
    hits: rows.map((row) => ({
      ...row,
      subjects: JSON.parse(row.subjects) as string[],
    })),
    degraded: [...new Set([...plan.degraded, ...relaxedOutcome(plan, rows.length, 0), ...(rows.length === 0 && isQuestionQuery(query) ? [NO_MATCH_LABEL] : [])])],
  };
}

/** An identity, plus the share of the query's terms it holds when the query was relaxed. */
export type AuditCandidate = Pick<SearchHit, "doc_id" | "scope"> & { coverage?: number };

/** Internal audit identities only. Deliberately excluded from public exports. */
export function searchAuditCandidates(
  db: Database,
  query: string,
  opts: Omit<SearchOptions, "ceiling"> & {
    source?: { owner: boolean; purpose?: SourcePurpose };
    /** Ranked-window skip for serving. Absent from SearchOptions and public search(). */
    offset?: number;
    /** Serving admits live provenance before matching, limiting and ranking. */
    canonIds?: readonly string[];
    ceiling?: Sensitivity;
  },
): { candidates: AuditCandidate[]; degraded: string[] } {
  const { source, offset, canonIds, ceiling, ...rest } = opts;
  const plan = searchPlan(
    db,
    query,
    rest,
    ceiling === undefined ? null : requireCeiling(ceiling),
    source,
    offset,
    canonIds,
  );
  const candidates = plan.tail === null ? [] : db
    .query<AuditCandidate, (string | number)[]>(
      `${plan.head}SELECT doc_id, scope${plan.coverage === null ? "" : `, ${plan.coverage} AS coverage`} ${plan.tail}`,
    )
    .all(...plan.bindings);
  return {
    candidates,
    degraded: [...plan.degraded, ...relaxedOutcome(plan, candidates.length, offset ?? 0)],
  };
}

export function search(
  db: Database,
  query: string,
  opts: SearchOptions,
): SearchHit[] {
  return searchResult(db, query, opts).hits;
}
