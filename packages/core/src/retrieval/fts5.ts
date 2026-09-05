import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { SENSITIVITY_ORDER } from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { PortError } from "../contracts/ports";
import type {
  PortContext,
  PortDescriptor,
  PortHealth,
} from "../contracts/ports";
import { registerPort } from "../contracts/registry";
import {
  MAX_RETRIEVAL_LIMIT,
  RETRIEVAL_CONTRACT,
  RETRIEVAL_CONTRACT_MINOR,
  requireRetrievalCapability,
  validateRetrievalDoc,
  validateRetrievalQuery,
} from "../contracts/retrieval";
import type {
  AbsenceProof,
  EntityRef,
  GraphQueryOptions,
  GraphResult,
  RetrievalAuthority,
  RetrievalDoc,
  RetrievalDocKind,
  RetrievalHit,
  RetrievalMutationReport,
  RetrievalPort,
  RetrievalQuery,
  RetrievalResult,
} from "../contracts/retrieval";
import { ceilingSql, instantBound, instantSql } from "../query/sql";
import { toFtsQuery } from "../search/query";
import { isPlainObject } from "../util/validate";
import {
  FTS5_RETRIEVAL_ENGINE_REL,
  FTS5_RETRIEVAL_STORE_REL,
  UNLABELED_SENSITIVITY,
  initFts5RetrievalStore,
} from "./schema";

import { lockFtsGeneration, removeFtsGeneration, validateFtsGeneration } from "./fts5-owned";
import type { AdvisoryFileLock } from "../util/advisory-file-lock";

export const FTS5_RETRIEVAL_ID = "kizuki.retrieval.fts5";

export const FTS5_RETRIEVAL_DESCRIPTOR = {
  id: FTS5_RETRIEVAL_ID,
  kind: "retrieval",
  contract: RETRIEVAL_CONTRACT,
  contract_minor: RETRIEVAL_CONTRACT_MINOR,
  supports: ["lexical"],
  requires_lease: true,
  optional_package: null,
} as const satisfies PortDescriptor;

const OCCURRED_AT_INSTANT = instantSql("search_docs.occurred_at");
const LOOKUP_CHUNK = 500;
const SNIPPET_TOKENS = 24;
const MATCH_ALL_SNIPPET = 160;

interface EngineJson {
  readonly port: string;
  readonly contract: string;
  readonly contract_minor: number;
  readonly space: null;
  readonly created_at: string;
  readonly rebuilt_at: string | null;
}

interface SearchRow {
  doc_id: string;
  score: number;
  snippet: string;
  kind: RetrievalDocKind;
  sensitivity: Sensitivity;
  taint: "clean" | "quoted";
  authority: RetrievalAuthority;
}

function placeholders(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function writeAtomic(path: string, contents: string): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, contents, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function storedSensitivity(value: Sensitivity | null): string {
  return value ?? UNLABELED_SENSITIVITY;
}

function matchAllSnippet(text: string): string {
  if (text.length <= MATCH_ALL_SNIPPET) return text;
  return `${text.slice(0, MATCH_ALL_SNIPPET)}…`;
}

export class Fts5RetrievalPort implements RetrievalPort {
  readonly descriptor: PortDescriptor;
  private readonly ctx: PortContext;
  private readonly db: Database;
  private closed = false;
  private readonly lock: AdvisoryFileLock;
  private rebuilding = false;

  constructor(
    ctx: PortContext,
    descriptor: PortDescriptor = FTS5_RETRIEVAL_DESCRIPTOR,
  ) {
    this.ctx = { ...ctx };
    this.descriptor = descriptor;
    mkdirSync(join(ctx.data_dir, "store"), { recursive: true, mode: 0o700 });
    const dbPath = join(ctx.data_dir, FTS5_RETRIEVAL_STORE_REL);
    this.lock = lockFtsGeneration(ctx.data_dir);
    try {
      this.db = new Database(dbPath);
    } catch (error) { this.lock.release(); throw error; }
    try {
      this.db.exec("PRAGMA busy_timeout = 0");
      this.db.exec("PRAGMA journal_mode = WAL");
      initFts5RetrievalStore(this.db);
      chmodSync(dbPath, 0o600);
      this.ensureEngineJson();
    } catch (error) {
      this.db.close();
      this.lock.release();
      throw error;
    }
  }

  async upsert(
    docs: readonly RetrievalDoc[],
  ): Promise<RetrievalMutationReport> {
    this.assertMutable();
    return this.writeDocs(docs.map(validateRetrievalDoc));
  }

  private writeDocs(validated: readonly RetrievalDoc[]): RetrievalMutationReport {
    this.db.transaction(() => {
      const removeDocs = this.db.query<never, [string]>(
        "DELETE FROM search_docs WHERE doc_id = ?",
      );
      const replace = this.db.query<
        never,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      >(
        `INSERT OR REPLACE INTO search_documents (
           doc_id, kind, title, text, sensitivity, taint, authority,
           subjects, provenance, occurred_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insert = this.db.query<
        never,
        [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ]
      >(
        `INSERT INTO search_docs (
           doc_id, kind, title, text, sensitivity, taint, authority,
           subjects, provenance, occurred_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const doc of validated) {
        removeDocs.run(doc.doc_id);
        const bindings: [
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
          string,
        ] = [
          doc.doc_id,
          doc.kind,
          doc.title,
          doc.text,
          storedSensitivity(doc.sensitivity),
          doc.taint,
          doc.authority,
          JSON.stringify(doc.subjects),
          JSON.stringify(doc.provenance),
          doc.occurred_at ?? "",
          doc.updated_at ?? "",
        ];
        replace.run(...bindings);
        insert.run(...bindings);
      }
    }).immediate();
    return { processed: validated.length };
  }

  async rebuildFromDocuments(source: AsyncIterable<RetrievalDoc> | Iterable<RetrievalDoc>): Promise<void> {
    this.assertMutable();
    this.rebuilding = true;
    try {
      const docs: RetrievalDoc[] = [];
      for await (const doc of source) {
        if (docs.length >= 10_000) throw new PortError("config_invalid", "FTS rebuild exceeds 10000 documents", false);
        docs.push(validateRetrievalDoc(doc));
      }
      this.assertOpen();
      this.db.transaction(() => {
        this.db.exec("DELETE FROM search_docs; DELETE FROM search_documents");
        this.writeDocs(docs);
      }).immediate();
    } finally {
      this.rebuilding = false;
    }
  }

  private assertMutable(): void {
    this.assertOpen();
    if (this.rebuilding) throw new PortError("unavailable", "retrieval rebuild is in progress", true);
  }

  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    this.assertOpen();
    const started = Date.now();
    const validated = validateRetrievalQuery(query);
    this.assertDeadline(started, validated.deadline_ms);

    const degraded: string[] = [];
    switch (validated.mode) {
      case "lexical":
        break;
      case "hybrid":
        degraded.push("vector-skipped");
        break;
      case "vector":
        requireRetrievalCapability(this.descriptor, "vector");
        break;
      default: {
        const _exhaustive: never = validated.mode;
        throw new PortError(
          "not_supported",
          `retrieval mode ${_exhaustive} is not supported`,
          false,
        );
      }
    }

    if (
      validated.scope.kinds?.length === 0 ||
      validated.scope.subjects?.length === 0
    ) {
      return {
        hits: [],
        degraded: [...degraded, "scope-empty"],
        timings_ms: { lexical: 0 },
        space: null,
      };
    }

    const ftsQuery = toFtsQuery(validated.text);
    const clauses: string[] = [
      ceilingSql("search_docs.sensitivity"),
    ];
    const bindings: (string | number)[] = [
      SENSITIVITY_ORDER[validated.ceiling],
    ];

    if (ftsQuery.length > 0) {
      clauses.push("search_docs MATCH ?");
      bindings.push(ftsQuery);
    }
    if (validated.scope.kinds !== undefined) {
      clauses.push(`kind IN (${placeholders(validated.scope.kinds.length)})`);
      bindings.push(...validated.scope.kinds);
    }
    if (validated.scope.subjects !== undefined) {
      clauses.push(`EXISTS (
        SELECT 1 FROM json_each(search_docs.subjects)
        WHERE value IN (${placeholders(validated.scope.subjects.length)})
      )`);
      bindings.push(...validated.scope.subjects);
    }
    if (validated.scope.since !== undefined) {
      clauses.push(
        `(search_docs.occurred_at != '' AND ${OCCURRED_AT_INSTANT} >= julianday(?))`,
      );
      bindings.push(instantBound(validated.scope.since, "retrieval since"));
    }
    if (validated.scope.until !== undefined) {
      clauses.push(
        `(search_docs.occurred_at != '' AND ${OCCURRED_AT_INSTANT} < julianday(?))`,
      );
      bindings.push(instantBound(validated.scope.until, "retrieval until"));
    }
    bindings.push(validated.limit);

    const snippetExpr =
      ftsQuery.length > 0
        ? `snippet(search_docs, 3, '[', ']', '…', ${SNIPPET_TOKENS})`
        : `substr(text, 1, ${MATCH_ALL_SNIPPET})`;
    const rankExpr =
      ftsQuery.length > 0
        ? "bm25(search_docs, 0, 0, 4.0, 1.0, 0, 0, 0, 0, 0, 0, 0)"
        : "0";

    const rows = this.db
      .query<SearchRow, (string | number)[]>(
        `SELECT
           doc_id,
           -(${rankExpr}) AS score,
           ${snippetExpr} AS snippet,
           kind,
           sensitivity,
           taint,
           authority
         FROM search_docs
         WHERE ${clauses.join(" AND ")}
         ORDER BY ${rankExpr},
           CASE authority
             WHEN 'owner_correction' THEN 0
             WHEN 'owner_authored' THEN 1
             WHEN 'connector_evidence' THEN 2
             WHEN 'model_inference' THEN 3
             ELSE 4
           END,
           doc_id
         LIMIT ?`,
      )
      .all(...bindings);

    this.assertDeadline(started, validated.deadline_ms);

    const hits: RetrievalHit[] = rows.map((row) => ({
      doc_id: row.doc_id,
      score: row.score,
      snippet:
        ftsQuery.length === 0 ? matchAllSnippet(row.snippet) : row.snippet,
      kind: row.kind,
      sensitivity: row.sensitivity,
      taint: row.taint,
      authority: row.authority,
    }));

    return {
      hits,
      degraded,
      timings_ms: { lexical: 0 },
      space: null,
    };
  }

  async remove(ids: readonly string[]): Promise<RetrievalMutationReport> {
    this.assertMutable();
    this.db.transaction(() => {
      const removeFts = this.db.query<never, [string]>(
        "DELETE FROM search_docs WHERE doc_id = ?",
      );
      const removeDocs = this.db.query<never, [string]>(
        "DELETE FROM search_documents WHERE doc_id = ?",
      );
      for (const id of ids) {
        removeFts.run(id);
        removeDocs.run(id);
      }
    }).immediate();
    return { processed: ids.length };
  }

  async verifyAbsent(ids: readonly string[]): Promise<AbsenceProof> {
    this.assertOpen();
    const found: string[] = [];
    for (const group of chunks(ids, LOOKUP_CHUNK)) {
      if (group.length === 0) continue;
      found.push(
        ...this.db
          .query<{ doc_id: string }, string[]>(
            `SELECT doc_id FROM search_documents
             WHERE doc_id IN (${placeholders(group.length)})`,
          )
          .all(...group)
          .map(({ doc_id }) => doc_id),
      );
    }
    return {
      checked: ids.length,
      found,
      store: this.descriptor.id,
      method: `lookup-limit-${MAX_RETRIEVAL_LIMIT}`,
      at: this.ctx.clock(),
    };
  }

  async neighbors(
    _entity: EntityRef,
    _options: GraphQueryOptions,
  ): Promise<GraphResult> {
    requireRetrievalCapability(this.descriptor, "graph");
    return { entity: "", edges: [], truncated: false };
  }

  async health(): Promise<PortHealth> {
    this.assertOpen();
    const count =
      this.db
        .query<{ count: number }, []>(
          "SELECT count(*) AS count FROM search_docs",
        )
        .get()?.count ?? 0;
    return { status: "ready", detail: { documents: count } };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
    this.lock.release();
  }

  /** Dispose only this separate derived store; the main ledger is never opened here. */
  async eraseOwnedGeneration(): Promise<void> {
    this.assertOpen();
    validateFtsGeneration(this.ctx);
    const checkpoint = this.db.query<{ busy: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy !== 0) throw new PortError("unavailable", "owned FTS generation has active readers", true);
    this.closed = true;
    this.db.close();
    try { removeFtsGeneration(this.ctx); } finally { this.lock.release(); }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PortError(
        "unavailable",
        "retrieval port is closed",
        false,
      );
    }
  }

  private assertDeadline(started: number, deadlineMs: number): void {
    if (Date.now() - started > deadlineMs) {
      throw new PortError(
        "timeout",
        "retrieval search exceeded deadline_ms",
        true,
      );
    }
  }

  private ensureEngineJson(): void {
    const path = join(this.ctx.data_dir, FTS5_RETRIEVAL_ENGINE_REL);
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (
        !isPlainObject(raw) ||
        raw["port"] !== this.descriptor.id ||
        raw["contract"] !== this.descriptor.contract ||
        raw["contract_minor"] !== this.descriptor.contract_minor ||
        raw["space"] !== null
      ) {
        throw new PortError(
          "config_invalid",
          "retrieval engine.json does not match this port",
          false,
        );
      }
      return;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const engine: EngineJson = {
      port: this.descriptor.id,
      contract: this.descriptor.contract,
      contract_minor: this.descriptor.contract_minor,
      space: null,
      created_at: this.ctx.clock(),
      rebuilt_at: null,
    };
    writeAtomic(path, `${JSON.stringify(engine)}\n`);
  }
}

export function createFts5RetrievalPort(
  ctx: PortContext,
  descriptor: PortDescriptor = FTS5_RETRIEVAL_DESCRIPTOR,
): Fts5RetrievalPort {
  return new Fts5RetrievalPort(ctx, descriptor);
}

let registered = false;

export function registerFts5RetrievalPort(): void {
  if (registered) return;
  registerPort(FTS5_RETRIEVAL_DESCRIPTOR, (ctx) => new Fts5RetrievalPort(ctx));
  registered = true;
}

/** Retry disposal of a partial/broken store without opening SQLite. */
export async function eraseOwnedFts5Generation(ctx: PortContext): Promise<void> {
  validateFtsGeneration(ctx);
  const lock = lockFtsGeneration(ctx.data_dir);
  try { removeFtsGeneration(ctx); } finally { lock.release(); }
}
