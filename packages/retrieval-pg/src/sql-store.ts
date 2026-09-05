import type { PGlite, Transaction } from "@electric-sql/pglite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PortError, SENSITIVITY_ORDER } from "@kizuki/core";
import type { RetrievalDoc, RetrievalQuery, EmbeddingSpace, Sensitivity } from "@kizuki/core";
import { runStoreTransaction } from "./txn";
import { openDatabase } from "./assets";
import { chunkDocument } from "./store";
import type { StoredEdge } from "./store";
export interface CandidateRow {
  doc: RetrievalDoc;
  score: number;
  chunk_index?: number;
  body?: string;
  vector?: string;
}
export interface PendingRow {
  chunk_id: string;
  doc_id: string;
  body: string;
  chunk_index: number;
  revision: string;
}
const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY);
INSERT INTO schema_migrations VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS retrieval_meta(key text PRIMARY KEY, value jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS retrieval_docs (
doc_id text PRIMARY KEY, doc jsonb NOT NULL, title text NOT NULL, body text NOT NULL,
sensitivity integer CHECK(sensitivity BETWEEN 0 AND 2), kind text NOT NULL,
subjects text[] NOT NULL, provenance text[] NOT NULL,
occurred_at timestamptz, updated_at timestamptz NOT NULL, search_doc tsvector NOT NULL);
CREATE TABLE IF NOT EXISTS retrieval_chunks (
chunk_id text PRIMARY KEY, doc_id text REFERENCES retrieval_docs ON DELETE CASCADE,
chunk_index integer NOT NULL, body text NOT NULL, revision text NOT NULL,
embedding vector, space text, embedded_at timestamptz,
UNIQUE(doc_id,chunk_index));
CREATE TABLE IF NOT EXISTS entity_edges (
source text NOT NULL REFERENCES retrieval_docs ON DELETE CASCADE,
target text NOT NULL, payload jsonb NOT NULL, PRIMARY KEY(source,target));
CREATE OR REPLACE VIEW entities AS SELECT e.target AS entity_id,
split_part(e.target,':',1) AS kind, substring(e.target from position(':' in e.target)+1) AS canonical_name,
ARRAY[]::text[] AS aliases, 1::real AS confidence,
coalesce(array_agg(d.doc_id ORDER BY d.doc_id) FILTER(WHERE d.kind='claim'),ARRAY[]::text[]) AS source_claims,
CASE WHEN bool_or(d.sensitivity IS NULL) THEN NULL ELSE max(d.sensitivity) END AS sensitivity
FROM entity_edges e JOIN retrieval_docs d ON d.doc_id=e.source GROUP BY e.target;
CREATE INDEX IF NOT EXISTS retrieval_docs_fts_gin ON retrieval_docs USING gin(search_doc);
CREATE INDEX IF NOT EXISTS retrieval_docs_title_trgm ON retrieval_docs USING gin(title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS retrieval_docs_scope ON retrieval_docs(sensitivity,kind,occurred_at,updated_at);
CREATE INDEX IF NOT EXISTS retrieval_docs_subjects ON retrieval_docs USING gin(subjects);
CREATE INDEX IF NOT EXISTS entity_edges_target ON entity_edges(target);
INSERT INTO retrieval_meta VALUES ('schema', '1') ON CONFLICT DO NOTHING;
`;
/** One FIFO serializes complete interactions; model calls never enter it. */
export class SqlStore {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(readonly db: PGlite, private readonly dispose: () => void) { }
  static async open(dataDir: string): Promise<SqlStore> {
    const resource = await openDatabase(dataDir);
    const store = new SqlStore(resource.db, resource.dispose);
    try {
      const versionTable=(await resource.db.query<{name:string|null}>("SELECT to_regclass('public.schema_migrations')::text AS name")).rows[0]?.name;
      if(versionTable!==null && versionTable!==undefined){
        const versions=(await resource.db.query<{version:number}>("SELECT version FROM schema_migrations")).rows;
        if(versions.some(row=>row.version!==1 && row.version!==2))throw new PortError("config_invalid","unsupported retrieval SQL schema version",false);
      }
      await resource.db.exec(SCHEMA);
      await resource.db.transaction(async tx => {
        const applied = await tx.query("SELECT version FROM schema_migrations WHERE version=2");
        if (applied.rows.length === 0) {
          await tx.exec("ALTER TABLE retrieval_docs ALTER COLUMN updated_at DROP NOT NULL; INSERT INTO schema_migrations VALUES(2)");
          await tx.query("UPDATE retrieval_meta SET value='2'::jsonb WHERE key='schema'");
        }
      });
      const legacy = ["docs.json", "graph.json"].some(name => existsSync(join(dataDir, "store", name)));
      if (legacy && await store.meta("rebuilt") === null) {
        await store.setMeta("migration_required", true);
      }
      return store;
    }
    catch (error) {
      await resource.db.close();
      resource.dispose();
      throw error;
    }
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    const pending = this.tail.then(fn).catch(error => {
      if (error instanceof PortError) {
        throw error;
      }
      throw new PortError("unavailable", "retrieval SQL operation failed", false);
    });
    this.tail = pending.catch(() => { });
    return pending;
  }
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> { return this.db.transaction(tx => runStoreTransaction(() => fn(tx))); }
  async close(): Promise<void> { await this.run(() => this.db.close()); this.dispose(); }
  async meta(key: string): Promise<unknown> {
    return (await this.db.query<{
      value: unknown;
    }>("SELECT value FROM retrieval_meta WHERE key=$1", [key])).rows[0]?.value ?? null;
  }
  async setMeta(key: string, value: unknown, tx: Transaction | PGlite = this.db): Promise<void> {
    await tx.query("INSERT INTO retrieval_meta VALUES ($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, JSON.stringify(value)]);
  }
  async writeDoc(tx: Transaction, doc: RetrievalDoc, tokens: number, overlap: number): Promise<void> {
    const old = (await tx.query<{
      title: string;
      body: string;
    }>("SELECT title,body FROM retrieval_docs WHERE doc_id=$1", [doc.doc_id])).rows[0];
    await tx.query(`INSERT INTO retrieval_docs VALUES ($1,$2::jsonb,$3,$4,$5,$6,$7,$8,$9,$10,
   setweight(to_tsvector('simple',$3),'A') || setweight(to_tsvector('simple',$4),'B'))
   ON CONFLICT(doc_id) DO UPDATE SET doc=excluded.doc,title=excluded.title,body=excluded.body,
   sensitivity=excluded.sensitivity,kind=excluded.kind,subjects=excluded.subjects,provenance=excluded.provenance,
   occurred_at=excluded.occurred_at,updated_at=excluded.updated_at,search_doc=excluded.search_doc`, [doc.doc_id, JSON.stringify(doc), doc.title, doc.text, doc.sensitivity === null ? null : SENSITIVITY_ORDER[doc.sensitivity], doc.kind, [...doc.subjects], [...doc.provenance], doc.occurred_at, doc.updated_at]);
    if (old?.title !== doc.title || old.body !== doc.text) {
      await tx.query("DELETE FROM retrieval_chunks WHERE doc_id=$1", [doc.doc_id]);
      for (const chunk of chunkDocument(doc, tokens, overlap)) {
        await tx.query("INSERT INTO retrieval_chunks(chunk_id,doc_id,chunk_index,body,revision) VALUES($1,$2,$3,$4,$5)", [chunk.chunk_id, doc.doc_id, chunk.index, chunk.text, crypto.randomUUID()]);
      }
    }
    await tx.query("DELETE FROM entity_edges WHERE source=$1", [doc.doc_id]);
    for (const target of new Set(doc.subjects)) {
      const edge: StoredEdge = { from: doc.doc_id, to: target, type: "subject", weight: 1, valid_from: doc.occurred_at, valid_to: null, provenance: [...doc.provenance] };
      await tx.query("INSERT INTO entity_edges VALUES($1,$2,$3::jsonb)", [doc.doc_id, target, JSON.stringify(edge)]);
    }
  }
  scope(query: RetrievalQuery, args: unknown[], alias = "d"): string {
    const param = (value: unknown) => { args.push(value); return `$${args.length}`; };
    const clauses = [`${alias}.sensitivity IS NOT NULL`, `${alias}.sensitivity <= ${param(SENSITIVITY_ORDER[query.ceiling])}`];
    if (query.scope.kinds !== undefined) {
      clauses.push(`${alias}.kind = ANY(${param(query.scope.kinds)}::text[])`);
    }
    if (query.scope.subjects !== undefined) {
      clauses.push(`${alias}.subjects && ${param(query.scope.subjects)}::text[]`);
    }
    if (query.scope.since !== undefined) {
      clauses.push(`${alias}.occurred_at >= ${param(query.scope.since)}::timestamptz`);
    }
    if (query.scope.until !== undefined) {
      clauses.push(`${alias}.occurred_at < ${param(query.scope.until)}::timestamptz`);
    }
    return clauses.join(" AND ");
  }
  async lexical(query: RetrievalQuery): Promise<CandidateRow[]> {
    const args: unknown[] = [query.text];
    const scope = this.scope(query, args);
    args.push(Math.min(1000, Math.max(200, query.limit * 20)));
    return this.transaction(async (tx) => {
      await tx.exec("SET LOCAL pg_trgm.similarity_threshold=0.2");
      return (await tx.query<CandidateRow>(`SELECT d.doc,
   ts_rank_cd(search_doc,websearch_to_tsquery('simple',$1)) + similarity(title,$1)*0.1 AS score
   FROM retrieval_docs d WHERE ${scope} AND ($1='' OR search_doc @@ websearch_to_tsquery('simple',$1) OR title % $1)
   ORDER BY score DESC, doc_id ASC LIMIT $${args.length}`, args)).rows;
    });
  }
  async vector(query: RetrievalQuery, vector: Float32Array, space: EmbeddingSpace): Promise<CandidateRow[]> {
    if(!Number.isInteger(space.dims)||space.dims<1||space.dims>2000)throw new PortError("config_invalid","invalid HNSW dimensions",false);
    const args: unknown[] = [JSON.stringify([...vector]), space.id];
    const scope = this.scope(query, args);
    args.push(Math.min(1000, Math.max(200, query.limit * 20)));
    return this.transaction(async (tx) => {
      await tx.exec("SET LOCAL hnsw.ef_search=200; SET LOCAL hnsw.iterative_scan='strict_order'");
      return (await tx.query<CandidateRow>(`SELECT d.doc, 1-(c.embedding::vector(${space.dims}) <=> $1::vector(${space.dims})) AS score,
    c.chunk_index,c.body,c.embedding::text AS vector FROM retrieval_chunks c JOIN retrieval_docs d USING(doc_id)
    WHERE ${scope} AND c.space=$2 AND c.embedding IS NOT NULL
    ORDER BY c.embedding::vector(${space.dims}) <=> $1::vector(${space.dims}),d.doc_id,c.chunk_index LIMIT $${args.length}`, args)).rows;
    });
  }
  async spaceMismatch(space: EmbeddingSpace): Promise<boolean> {
    const stored = await this.meta("space");
    if (stored !== null && canonical(stored) !== canonical(space)) {
      return true;
    }
    const result = await this.db.query<{
      mismatch: boolean;
    }>("SELECT EXISTS(SELECT 1 FROM retrieval_chunks WHERE embedding IS NOT NULL AND (space IS DISTINCT FROM $1 OR vector_dims(embedding)<>$2 OR embedded_at IS NULL)) AS mismatch", [space.id, space.dims]);
    return result.rows[0]?.mismatch === true;
  }
  async ensureSpace(space: EmbeddingSpace): Promise<void> {
    if (!Number.isInteger(space.dims) || space.dims < 1 || space.dims > 2000) {
      throw new PortError("config_invalid", "embedding dimensions must be 1..2000 for HNSW", false);
    }
    const stored = await this.meta("space");
    if (await this.spaceMismatch(space)) {
      throw new PortError("space_mismatch", "embedding-space-mismatch; lexical fallback is available", false);
    }
    if (stored !== null && JSON.stringify(stored) !== JSON.stringify(space)) {
      // JSONB key order is not stable; compare canonical keys recursively.
      if (canonical(stored) !== canonical(space)) {
        throw new PortError("space_mismatch", "embedding-space-mismatch; lexical fallback is available", false);
      }
    }
    if (stored === null) {
      await this.transaction(async (tx) => {
        await tx.exec(`CREATE INDEX IF NOT EXISTS retrieval_chunks_hnsw_cosine ON retrieval_chunks USING hnsw((embedding::vector(${space.dims})) vector_cosine_ops)`);
        await this.setMeta("space", space, tx);
      });
    }
  }
  async pending(): Promise<PendingRow | undefined> {
    return (await this.db.query<PendingRow>(`SELECT c.chunk_id,c.doc_id,c.body,c.chunk_index,c.revision FROM retrieval_chunks c
   JOIN retrieval_docs d USING(doc_id) WHERE c.embedding IS NULL ORDER BY d.updated_at DESC NULLS LAST,c.doc_id,c.chunk_index LIMIT 1`)).rows[0];
  }
  async edges(ceiling: Sensitivity, query?: RetrievalQuery, candidateIds?: readonly string[]): Promise<StoredEdge[]> {
    const args: unknown[] = [];
    const scope = this.scope(query ?? { text: "", mode: "lexical", scope: {}, ceiling, limit: 100, deadline_ms: 1000 }, args);
    let candidates = "";
    if (candidateIds !== undefined) {
      args.push([...candidateIds]);
      candidates = ` AND e.source=ANY($${args.length}::text[])`;
    }
    return (await this.db.query<{
      payload: StoredEdge;
    }>(`SELECT e.payload FROM entity_edges e JOIN retrieval_docs d ON d.doc_id=e.source WHERE ${scope}${candidates} ORDER BY e.source,e.target LIMIT 10001`, args)).rows.map(row => row.payload);
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
