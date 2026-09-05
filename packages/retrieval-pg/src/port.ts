import { removeOwnedGeneration, validateOwnedGeneration } from "./owned-generation";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { openOwnedDirectory, PortError, validatePortDescriptor, validateRetrievalDoc, validateRetrievalQuery, SENSITIVITY_ORDER } from "@kizuki/core";
import type { OwnedDirectory, AbsenceProof, EmbeddingPort, EmbeddingSpace, EntityRef, GraphQueryOptions, GraphResult, PortContext, PortDescriptor, PortHealth, RetrievalDoc, RetrievalMutationReport, RetrievalPort, RetrievalQuery, RetrievalResult } from "@kizuki/core";
import { EMBEDDED_RETRIEVAL_DESCRIPTOR } from "./descriptor";
import { WriterLease } from "./lease";
import type { LeaseReceipt } from "./lease";
import { candidateFromDoc, finalizeRecipe, hitsFromCandidates, walkNeighbors, MAX_WALK_DEPTH } from "./rank";
import { SqlStore } from "./sql-store";
import type { CandidateRow } from "./sql-store";
import { chunkDocument, engineMismatch } from "./store";
import type { EngineJson, EmbedCheckpoint } from "./store";
import { assertNoStoreTransaction, runStoreTransaction } from "./txn";
import { sha256Text, writeAtomic } from "./atomic";
import { RefreshWatcher } from "./watcher";
import type { RefreshWatcherOptions } from "./watcher";
export interface EmbeddedRetrievalOptions {
  readonly embedding?: EmbeddingPort;
  readonly acquire_timeout_ms?: number;
  readonly heartbeat_ms?: number;
  readonly chunk_tokens?: number;
  readonly chunk_overlap?: number;
  readonly holder_id?: string;
}
export class EmbeddedRetrievalPort implements RetrievalPort {
  static validateOwnedGeneration(ctx: PortContext): void { validateOwnedGeneration(ctx.vault_path, ctx.data_dir); }
  ownsGeneration(vaultPath: string): boolean {
    return resolve(vaultPath) === resolve(this.ownedVaultPath) && resolve(this.ownedDataDir) === resolve(vaultPath, ".kizuki/retrieval", EMBEDDED_RETRIEVAL_DESCRIPTOR.id);
  }
  readonly descriptor: PortDescriptor;
  private closed = false;
  private readonly ownedDataDir: string;
  private readonly ownedVaultPath: string;
  private closing:Promise<void>|undefined;
  private rebuilding = false;
  private embeddingWork: Promise<void> | undefined;
  private watcher: RefreshWatcher | undefined;
  private selfWrites = new Map<string, string>();
  private checkpoint: EmbedCheckpoint | null = null;
  lastRefreshPass = 0;
  constructor(private readonly ctx: PortContext, private readonly store: SqlStore, private readonly lease: WriterLease, readonly leaseReceipt: LeaseReceipt, private readonly options: EmbeddedRetrievalOptions, private readonly ownedRoot: OwnedDirectory | null) {
    this.ownedDataDir = ctx.data_dir;
    this.ownedVaultPath = ctx.vault_path;
    // The catalog names implementation capabilities; callers use the bound
    // descriptor to decide whether vector nomination is actually available.
    this.descriptor = validatePortDescriptor({
      ...EMBEDDED_RETRIEVAL_DESCRIPTOR,
      supports: EMBEDDED_RETRIEVAL_DESCRIPTOR.supports.filter(
        (capability) => capability !== "vector" || options.embedding !== undefined,
      ),
    });
  }
  private effectiveSpace(): EmbeddingSpace {
    if (this.embedding === undefined) {
      throw new PortError("unavailable", "embedding port is not configured", false);
    }
    return { ...this.embedding.space(), chunk: { tokens: this.tokens, overlap: this.overlap } };
  }
  private get embedding(): EmbeddingPort | undefined { return this.options.embedding; }
  private get tokens(): number { return this.options.chunk_tokens ?? this.embedding?.space().chunk.tokens ?? 800; }
  private get overlap(): number { return this.options.chunk_overlap ?? this.embedding?.space().chunk.overlap ?? 120; }
  private assertOpen(): void {
    if (this.closed) {
      throw new PortError("unavailable", "retrieval port is closed", false);
    }
  }
  private assertMutable(): void {
    this.assertOpen();
    if (this.rebuilding) {
      throw new PortError("unavailable", "retrieval rebuild is in progress; retry mutation", true);
    }
  }
  private async assertAvailable(): Promise<void> {
    if (await this.store.meta("migration_required") === true) {
      throw new PortError("unavailable", "legacy retrieval requires authoritative rebuild", false);
    }
  }
  async initialize(): Promise<void> {
    this.checkpoint = await this.store.meta("checkpoint") as EmbedCheckpoint | null;
    await this.syncEngineMetadata();
  }
  async upsert(docs: readonly RetrievalDoc[]): Promise<RetrievalMutationReport> {
    this.assertMutable();
    const validated = docs.map(validateRetrievalDoc);
    await this.store.run(async () => {
      this.assertMutable();
      await this.assertAvailable();
      await this.store.transaction(async (tx) => {
        for (const doc of validated) {
          await this.store.writeDoc(tx, doc, this.tokens, this.overlap);
        }
      });
    });
    if (this.embedding !== undefined) {
      await this.embedPending();
    }
    return { processed: validated.length };
  }
  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    this.assertOpen();
    const q = validateRetrievalQuery(query);
    const started = Date.now();
    const degraded: string[] = [];
    let vector: Float32Array | null = null;
    let space: EmbeddingSpace | null = null;
    if (q.mode !== "lexical") {
      if (this.embedding === undefined) {
        if (q.mode === "vector") {
          throw new PortError("unavailable", "vector search requires an embedding port", false);
        }
        degraded.push("vector-skipped");
      }
      else {
        space = this.effectiveSpace();
        const mismatch = await this.store.run(() => this.store.spaceMismatch(space!));
        if (mismatch) {
          if (q.mode === "vector") {
            throw new PortError("space_mismatch", "embedding-space-mismatch; lexical fallback is available", false);
          }
          degraded.push("embedding-space-mismatch");
          space = null;
        }
        else {
          assertNoStoreTransaction("embedQuery");
          const vectors = await withDeadline(this.embedding.embedQuery([q.text]), Math.max(1, q.deadline_ms - (Date.now() - started)));
          vector = vectors[0] ?? null;
          this.validateVector(vector, space);
        }
      }
    }
    return this.store.run(async () => {
      this.assertOpen();
      await this.assertAvailable();
      const lexical = q.mode === "vector" ? [] : await this.store.lexical(q);
      const vectors = vector !== null && space !== null ? await this.store.vector(q, vector, space) : [];
      const edges = await this.store.edges(q.ceiling, q, [...new Set([...lexical, ...vectors].map(row => row.doc.doc_id))]);
      if (edges.length > 10000) {
        degraded.push("graph-window");
      }
      const docs = new Map([...lexical, ...vectors].map(row => [row.doc.doc_id, row.doc]));
      const visible = new Set(edges.flatMap(edge => [edge.from, edge.to]));
      const asCandidate = (row: CandidateRow) => candidateFromDoc(row.doc, row.score, {
        chunk_id: row.chunk_index ?? 0, keyword_hit: row.vector === undefined,
        text: row.body ?? row.doc.text, vector: row.vector === undefined ? null : Float32Array.from(JSON.parse(row.vector) as number[]),
      });
      const final = finalizeRecipe({ lexical: lexical.map(asCandidate), vector: vector === null ? null : vectors.map(asCandidate), queryVector: vector, edges, visible: id => visible.has(id) });
      if (q.scope.kinds?.length === 0 || q.scope.subjects?.length === 0) {
        degraded.push("scope-empty");
      }
      if (lexical.length === 0 && q.text.trim() !== "" && q.mode !== "vector") {
        degraded.push("keyword-zero");
      }
      if (Date.now() - started > q.deadline_ms) {
        throw new PortError("timeout", "retrieval search exceeded deadline_ms", true);
      }
      return { hits: hitsFromCandidates(final, docs, q.text, q.limit), degraded, timings_ms: { total: Date.now() - started }, space: space?.id ?? null };
    });
  }
  async remove(ids: readonly string[]): Promise<RetrievalMutationReport> {
    this.assertMutable();
    await this.store.run(async () => {
      this.assertMutable();
      await this.assertAvailable();
      return this.store.transaction(async (tx) => {
        await tx.query("DELETE FROM retrieval_docs WHERE doc_id=ANY($1::text[]) OR provenance && $1::text[]", [[...ids]]);
        if (this.checkpoint !== null && ids.includes(this.checkpoint.doc_id)) {
          this.checkpoint = null;
          await this.store.setMeta("checkpoint", null, tx);
        }
      });
    });
    this.selfWrites.clear();
    return { processed: ids.length };
  }
  async verifyAbsent(ids: readonly string[]): Promise<AbsenceProof> {
    this.assertOpen();
    const found = await this.store.run(async () => {
      await this.assertAvailable();
      return (await this.store.db.query<{
        doc_id: string;
      }>("SELECT doc_id FROM retrieval_docs WHERE doc_id=ANY($1::text[]) OR provenance && $1::text[] ORDER BY doc_id", [[...ids]])).rows.map(row => row.doc_id);
    });
    return { checked: ids.length, found, store: this.descriptor.id, method: "sql-docs-provenance-cascade", at: this.ctx.clock() };
  }
  async neighbors(entity: EntityRef, options: GraphQueryOptions): Promise<GraphResult> {
    this.assertOpen();
    if (!(options.ceiling in SENSITIVITY_ORDER) || !Number.isInteger(options.hops) || options.hops < 1 || options.hops > MAX_WALK_DEPTH || !Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100) {
      throw new PortError("config_invalid", "graph query is invalid", false);
    }
    return this.store.run(async () => {
      await this.assertAvailable();
      const edges = await this.store.edges(options.ceiling);
      const visible = new Set(edges.flatMap(edge => [edge.from, edge.to]));
      const walked = walkNeighbors(entity.entity_id, edges, { hops: options.hops, limit: options.limit, visible: id => visible.has(id) });
      return { entity: entity.entity_id, edges: walked.edges, truncated: walked.truncated || edges.length > 10000 };
    });
  }
  async health(): Promise<PortHealth> {
    this.assertOpen();
    return this.store.run(async () => {
      if (await this.store.meta("migration_required") === true) {
        return { status: "unavailable", reason: "legacy retrieval requires authoritative rebuild" };
      }
      const counts = (await this.store.db.query<{
        documents: number;
        backlog_depth: number;
        phantoms: number;
      }>(`SELECT
    (SELECT count(*)::int FROM retrieval_docs) AS documents,
    count(*) FILTER(WHERE embedding IS NULL)::int AS backlog_depth,
    count(*) FILTER(WHERE embedding IS NULL AND embedded_at IS NOT NULL)::int AS phantoms FROM retrieval_chunks`)).rows[0]!;
      if (counts.phantoms > 0) {
        return { status: "unavailable", reason: "phantom embeddings are present; rebuild --layer vector" };
      }
      const stored = await this.store.meta("space");
      const detail = { ...counts, queue_depth: this.queueDepth(), checkpoint: this.checkpoint };
      if (stored !== null && this.embedding !== undefined && await this.store.spaceMismatch(this.effectiveSpace())) {
        return { status: "degraded", degraded: ["embedding-space-mismatch"], detail };
      }
      return { status: "ready", detail };
    });
  }
  async close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    this.watcher?.close();
    this.closing = this.store.close().then(() => { this.lease.release(); }).finally(() => { this.ownedRoot?.close(); });
    return this.closing;
  }
  /** Final native maintenance call. The old object stays closed after disposal. */
  async eraseOwnedGeneration(): Promise<void> {
    if (this.closed) return Promise.reject(new PortError("unavailable", "retrieval port is already closing or closed", false));
    const root = this.ownedRoot;
    if (root === null) throw new Error("owned_directory_unsupported");
    try { root.assertCurrent(); } catch {
      const active = this.store.abortForErasure();
      this.closed = true; this.watcher?.close(); this.lease.suspendForErasure(); root.close();
      const error = new PortError("unavailable", active ? "owned_generation_changed_restart_required: active_sql_uncontained" : "owned_generation_changed_restart_required", false);
      this.closing = Promise.reject(error);
      void this.closing.catch(() => {});
      return this.closing;
    }
    validateOwnedGeneration(this.ownedVaultPath, this.ownedDataDir);
    const expectedStore = root.childIdentity("store");
    const releaseNative = this.lease.suspendForErasure();
    this.closed = true;
    this.watcher?.close();
    this.selfWrites.clear(); this.checkpoint = null;
    this.closing = (async () => {
      // No lease release if SQL shutdown cannot be confirmed. After shutdown,
      // failed deletion remains pending and a native no-SQL retry can finish it.
      try { await this.store.close(false); } catch (error) { root.close(); throw error; }
      try {
        try { root.assertCurrent(); } catch { throw new Error("owned_generation_changed_restart_required: active_sql_uncontained"); }
        removeOwnedGeneration(this.ownedVaultPath, this.ownedDataDir, root, expectedStore);
      }
      finally { root.close(); releaseNative(); }
    })();
    return this.closing;
  }
  embedCheckpoint(): EmbedCheckpoint | null { return this.checkpoint; }
  queueDepth(): number { return this.lease.inspect().queue_depth; }
  acquireWaiting(holderId: string, timeoutMs: number): Promise<LeaseReceipt> { return this.lease.acquire(holderId, timeoutMs); }
  embedPending(): Promise<void> {
    this.assertMutable();
    assertNoStoreTransaction("embedPending");
    if (this.embeddingWork !== undefined) {
      return this.embeddingWork;
    }
    this.embeddingWork = this.drainEmbeddings().finally(() => { this.embeddingWork = undefined; });
    return this.embeddingWork;
  }
  private async drainEmbeddings(): Promise<void> {
    const embedding = this.embedding;
    if (embedding === undefined) {
      throw new PortError("unavailable", "embedding port is not configured", false);
    }
    const space = this.effectiveSpace();
    await this.store.run(async () => { await this.store.ensureSpace(space); await this.syncEngineMetadata(); });
    while (!this.closed) {
      const pending = await this.store.run(() => this.store.pending());
      if (pending === undefined || this.closed) {
        break;
      }
      assertNoStoreTransaction("embedDocs");
      const [vector] = await embedding.embedDocs([{ chunk_id: pending.chunk_id, doc_id: pending.doc_id, text: pending.body, index: pending.chunk_index }]);
      this.validateVector(vector ?? null, space);
      if (this.closed) {
        break;
      }
      await this.store.run(() => this.store.transaction(async (tx) => {
        const result = await tx.query("UPDATE retrieval_chunks SET embedding=$1::vector,space=$2,embedded_at=$3 WHERE chunk_id=$4 AND revision=$5 RETURNING chunk_id", [JSON.stringify([...vector!]), space.id, this.ctx.clock(), pending.chunk_id, pending.revision]);
        if (result.rows.length > 0) {
          this.checkpoint = { doc_id: pending.doc_id, chunk_index: pending.chunk_index + 1, space: space.id };
          await this.store.setMeta("checkpoint", this.checkpoint, tx);
        }
      }));
    }
  }
  private validateVector(vector: Float32Array | null, space: EmbeddingSpace): void {
    if (vector === null || vector.length !== space.dims || [...vector].some(value => !Number.isFinite(value))) {
      throw new PortError("space_mismatch", "embedding-space-mismatch; lexical fallback is available", false);
    }
  }
  embedInsideOpenTransaction(): Promise<Float32Array[]> {
    const guarded = () => { assertNoStoreTransaction("embedDocs"); return Promise.resolve([] as Float32Array[]); };
    return runStoreTransaction(guarded);
  }
  async injectPhantom(docId: string): Promise<void> { this.assertOpen(); await this.store.run(() => this.store.db.query("UPDATE retrieval_chunks SET embedding=NULL,embedded_at=$2 WHERE doc_id=$1", [docId, this.ctx.clock()])); }
  async rebuildLayer(layer: "search" | "vector" | "graph" | "entities" | "all"): Promise<void> {
    this.assertMutable();
    if(this.embeddingWork!==undefined)throw new PortError("unavailable","embedding work is active; retry rebuild",true);
    if (layer === "all") {
      throw new PortError("config_invalid", "all-layer rebuild requires authoritative documents via rebuildFromDocuments", false);
    }
    if (layer === "vector") {
      if (this.embedding === undefined) throw new PortError("unavailable", "vector rebuild requires an embedding port", false);
      const store = this.store;
      await this.rebuildFromDocuments((async function* () {
        let last = "";
        for (;;) {
          const rows = await store.run(async () => (await store.db.query<{doc: RetrievalDoc}>(
            "SELECT doc FROM retrieval_docs WHERE doc_id>$1 ORDER BY doc_id LIMIT 100", [last])).rows);
          if (rows.length === 0) break;
          for (const row of rows) { last = row.doc.doc_id; yield row.doc; }
        }
      })());
    }
    else {
      await this.store.run(() => this.store.transaction(async tx => {
        if(layer === "search") {
          await tx.exec("UPDATE retrieval_docs SET search_doc=setweight(to_tsvector('simple',title),'A')||setweight(to_tsvector('simple',body),'B'); REINDEX TABLE retrieval_docs");
        } else {
          await tx.exec(`DELETE FROM entity_edges;
            INSERT INTO entity_edges SELECT DISTINCT d.doc_id, subject,
              jsonb_build_object('from',d.doc_id,'to',subject,'type','subject','weight',1,
                'valid_from',d.doc->'occurred_at','valid_to',NULL,'provenance',d.doc->'provenance')
              FROM retrieval_docs d CROSS JOIN LATERAL unnest(d.subjects) AS subject;
            REINDEX TABLE entity_edges`);
        }
        await this.store.setMeta("rebuilt", this.ctx.clock(), tx);
      }));
      await this.store.run(() => this.syncEngineMetadata());
    }
  }
  /** Stage documents and required vectors before atomically replacing the active index. */
  async rebuildFromDocuments(docs: AsyncIterable<RetrievalDoc> | Iterable<RetrievalDoc>): Promise<void> {
    this.assertMutable();
    if (this.embeddingWork !== undefined) throw new PortError("unavailable", "embedding work is active; retry rebuild", true);
    const space = this.embedding === undefined ? null : this.effectiveSpace();
    this.rebuilding = true;
    try {
      const requiresEmbedding = space === null && await this.store.run(() => this.store.meta("space")) !== null;
      if (space !== null && (!Number.isInteger(space.dims) || space.dims < 1 || space.dims > 2000)) {
        throw new PortError("config_invalid", "embedding dimensions must be 1..2000 for HNSW", false);
      }
      await this.store.run(() => this.store.db.exec(`
        CREATE TEMP TABLE rebuild_docs (doc_id text PRIMARY KEY,doc jsonb NOT NULL);
        CREATE TEMP TABLE rebuild_vectors (chunk_id text PRIMARY KEY,embedding vector NOT NULL);`));
      for await (const raw of docs) {
        this.assertOpen();
        if (requiresEmbedding) throw new PortError("unavailable", "rebuilding an embedded index requires its embedding port", false);
        const doc = validateRetrievalDoc(raw);
        await this.store.run(() => this.store.db.query("INSERT INTO rebuild_docs VALUES($1,$2::jsonb) ON CONFLICT(doc_id) DO UPDATE SET doc=excluded.doc", [doc.doc_id, JSON.stringify(doc)]));
      }
      if (space !== null) {
        let last = "";
        for (;;) {
          const rows = await this.store.run(async () => (await this.store.db.query<{doc: RetrievalDoc}>(
            "SELECT doc FROM rebuild_docs WHERE doc_id>$1 ORDER BY doc_id LIMIT 100", [last])).rows);
          if (rows.length === 0) break;
          for (const {doc} of rows) {
            for (const chunk of chunkDocument(doc, this.tokens, this.overlap)) {
              assertNoStoreTransaction("embedDocs");
              const [vector] = await this.embedding!.embedDocs([{chunk_id: chunk.chunk_id, doc_id: doc.doc_id, text: chunk.text, index: chunk.index}]);
              this.validateVector(vector ?? null, space);
              this.assertOpen();
              await this.store.run(() => this.store.db.query("INSERT INTO rebuild_vectors VALUES($1,$2::vector)", [chunk.chunk_id, JSON.stringify([...vector!])]));
            }
            last = doc.doc_id;
          }
        }
      }
      await this.store.run(async () => {
        this.assertOpen();
        await this.store.transaction(async tx => {
          await tx.exec("DELETE FROM retrieval_docs; DROP INDEX IF EXISTS retrieval_chunks_hnsw_cosine; DELETE FROM retrieval_meta WHERE key IN ('space','checkpoint')");
          let last = "";
          for (;;) {
            const rows = (await tx.query<{doc: RetrievalDoc}>("SELECT doc FROM rebuild_docs WHERE doc_id>$1 ORDER BY doc_id LIMIT 100", [last])).rows;
            if (rows.length === 0) break;
            for (const {doc} of rows) { await this.store.writeDoc(tx, doc, this.tokens, this.overlap); last = doc.doc_id; }
          }
          if (space !== null) {
            await tx.query("UPDATE retrieval_chunks c SET embedding=v.embedding,space=$1,embedded_at=$2 FROM rebuild_vectors v WHERE c.chunk_id=v.chunk_id", [space.id, this.ctx.clock()]);
            await tx.exec(`CREATE INDEX retrieval_chunks_hnsw_cosine ON retrieval_chunks USING hnsw((embedding::vector(${space.dims})) vector_cosine_ops)`);
            await this.store.setMeta("space", space, tx);
          }
          await this.store.setMeta("rebuilt", this.ctx.clock(), tx);
          await this.store.setMeta("migration_required", false, tx);
        });
        this.checkpoint = null;
        await this.syncEngineMetadata();
      });
      for (const name of ["docs.json", "graph.json", "embed-checkpoint.json", "self-writes.json"]) {
        rmSync(join(this.ctx.data_dir, "store", name), { force: true });
      }
    } finally {
      try { if (!this.closed) await this.store.run(() => this.store.db.exec("DROP TABLE IF EXISTS rebuild_vectors; DROP TABLE IF EXISTS rebuild_docs")); }
      finally { this.rebuilding = false; }
    }
  }

  /** engine.json is a recoverable projection of committed SQL identity metadata. */
  private async syncEngineMetadata(): Promise<void> {
    const space = await this.store.meta("space") as EmbeddingSpace | null;
    const metadata: EngineJson = {
      port: this.descriptor.id, contract: this.descriptor.contract, contract_minor: this.descriptor.contract_minor,
      space: space?.id ?? null, created_at: await this.store.meta("created_at") as string,
      rebuilt_at: await this.store.meta("rebuilt") as string | null,
    };
    engineMismatch(metadata, metadata);
    const path = join(this.ctx.data_dir, "engine.json");
    const content = JSON.stringify({...metadata, engine: "pglite", schema: 2}) + "\n";
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) writeAtomic(path, content);
  }

  watch(options: Omit<RefreshWatcherOptions, "isSelfWrite" | "refresh"> & {
    refresh?: () => Promise<void>;
  }): RefreshWatcher {
    this.assertOpen();
    this.watcher?.close();
    this.watcher = new RefreshWatcher({ root: options.root, refresh: options.refresh ?? (async () => { this.lastRefreshPass += 1; }), isSelfWrite: (path, digest) => this.selfWrites.get(path) === digest });
    this.watcher.start();
    return this.watcher;
  }
  recordSelfWrite(path: string, contents: string): void { this.assertOpen(); this.selfWrites.set(path, sha256Text(contents)); writeAtomic(path, contents); }
  isSelfWrite(path: string, digest: string): boolean { return this.selfWrites.get(path) === digest; }
}
export async function openEmbeddedRetrievalPort(ctx: PortContext, options: EmbeddedRetrievalOptions = {}): Promise<EmbeddedRetrievalPort> {
  if(existsSync(ctx.data_dir)&&lstatSync(ctx.data_dir).isSymbolicLink())throw new PortError("config_invalid","retrieval storage directory must not be a symlink",false);
  const tokens = options.chunk_tokens ?? options.embedding?.space().chunk.tokens ?? 800;
  const overlap = options.chunk_overlap ?? options.embedding?.space().chunk.overlap ?? 120;
  if (!Number.isInteger(tokens) || tokens < 1 || tokens > 100000 || !Number.isInteger(overlap) || overlap < 0 || overlap >= tokens) {
    throw new PortError("config_invalid", "invalid retrieval chunk configuration", false);
  }
  const lease = new WriterLease(ctx.data_dir, { ...(options.heartbeat_ms === undefined ? {} : { heartbeat_ms: options.heartbeat_ms }), clock: ctx.clock });
  const receipt = options.acquire_timeout_ms === undefined ? lease.tryAcquire(options.holder_id ?? `pid:${process.pid}`) : await lease.acquire(options.holder_id ?? `pid:${process.pid}`, options.acquire_timeout_ms);
  let store: SqlStore | undefined;
  let ownedRoot: OwnedDirectory | null = null;
  try {
    try { ownedRoot = openOwnedDirectory(ctx.data_dir); } catch (error) { if (!(error instanceof Error) || error.message !== "owned_directory_unsupported") throw error; }
    const enginePath = join(ctx.data_dir, "engine.json");
    const expected: EngineJson = { port: EMBEDDED_RETRIEVAL_DESCRIPTOR.id, contract: EMBEDDED_RETRIEVAL_DESCRIPTOR.contract, contract_minor: EMBEDDED_RETRIEVAL_DESCRIPTOR.contract_minor, space: null, created_at: ctx.clock(), rebuilt_at: null };
    const existing = existsSync(enginePath) ? JSON.parse(readFileSync(enginePath, "utf8")) as EngineJson : null;
    engineMismatch(existing, expected);
    store = await SqlStore.open(ctx.data_dir);
    if (await store.meta("created_at") === null) await store.setMeta("created_at", existing?.created_at ?? expected.created_at);
    const port = new EmbeddedRetrievalPort(ctx, store, lease, receipt, options, ownedRoot);
    await port.initialize();
    return port;
  }
  catch (error) {
    try { await store?.close(); } finally { ownedRoot?.close(); }
    lease.release();
    throw error;
  }
}
/** @deprecated Await openEmbeddedRetrievalPort instead. */
export const createEmbeddedRetrievalPort = openEmbeddedRetrievalPort;
async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new PortError("timeout", "retrieval embedding exceeded deadline_ms", true)), milliseconds); })]);
  }
  finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Retry physical erasure of a partial/broken owned generation without opening SQL. */
export async function eraseOwnedEmbeddedGeneration(ctx: PortContext): Promise<void> {
  const vaultPath = ctx.vault_path, dataDir = ctx.data_dir;
  validateOwnedGeneration(vaultPath, dataDir);
  const root = openOwnedDirectory(dataDir);
  let releaseNative: (() => void) | undefined;
  try {
    const expectedStore = root.childIdentity("store");
    const lease = new WriterLease(dataDir, { clock: ctx.clock });
    releaseNative = lease.acquireMaintenance(root);
    removeOwnedGeneration(vaultPath, dataDir, root, expectedStore);
  } finally { root.close(); releaseNative?.(); }
}
