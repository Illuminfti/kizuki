import { SENSITIVITY_ORDER } from "@kizuki/core";
import type { Sensitivity } from "@kizuki/core";
import {
  MAX_RETRIEVAL_LIMIT,
  PortError,
  requireRetrievalCapability,
  validateRetrievalDoc,
  validateRetrievalQuery,
} from "@kizuki/core";
import type {
  AbsenceProof,
  Chunk,
  EmbeddingPort,
  EntityRef,
  GraphQueryOptions,
  GraphResult,
  PortContext,
  PortDescriptor,
  PortHealth,
  RetrievalDoc,
  RetrievalHit,
  RetrievalMutationReport,
  RetrievalPort,
  RetrievalQuery,
  RetrievalResult,
  RetrievalGraphEdge,
} from "@kizuki/core";
import { sha256Text, writeAtomic } from "./atomic";
import { EMBEDDED_RETRIEVAL_DESCRIPTOR } from "./descriptor";
import { WriterLease } from "./lease";
import type { LeaseReceipt } from "./lease";
import {
  applyTierWeight,
  compareHits,
  cosine,
  filterNearDuplicates,
  lexicalScore,
  reciprocalRankFusion,
  snippetFor,
} from "./rank";
import {
  chunkDocument,
  engineMismatch,
  storedFromDoc,
  EmbeddedStore,
} from "./store";
import type {
  EmbedCheckpoint,
  EngineJson,
  StoredChunk,
  StoredDoc,
  StoredEdge,
  StoredEntity,
} from "./store";
import { assertNoStoreTransaction, runStoreTransaction } from "./txn";
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

const DEFAULT_ACQUIRE_TIMEOUT_MS = 50;

export class EmbeddedRetrievalPort implements RetrievalPort {
  readonly descriptor: PortDescriptor = EMBEDDED_RETRIEVAL_DESCRIPTOR;
  readonly leaseReceipt: LeaseReceipt;
  private readonly ctx: PortContext;
  private readonly store: EmbeddedStore;
  private readonly lease: WriterLease;
  private readonly embedding: EmbeddingPort | undefined;
  private readonly chunkTokens: number;
  private readonly chunkOverlap: number;
  private closed = false;
  private watcher: RefreshWatcher | undefined;
  lastRefreshPass = 0;

  constructor(ctx: PortContext, options: EmbeddedRetrievalOptions = {}) {
    this.ctx = ctx;
    this.embedding = options.embedding;
    this.chunkTokens = options.chunk_tokens ?? 32;
    this.chunkOverlap = options.chunk_overlap ?? 4;
    this.store = new EmbeddedStore(ctx.data_dir);
    const expected: EngineJson = {
      port: this.descriptor.id,
      contract: this.descriptor.contract,
      contract_minor: this.descriptor.contract_minor,
      space: this.embedding?.space().id ?? null,
      created_at: ctx.clock(),
      rebuilt_at: this.store.engine?.rebuilt_at ?? null,
    };
    engineMismatch(this.store.engine, expected);
    if (this.store.engine === null) {
      this.store.writeEngine(expected);
    } else if (this.store.engine.space === null && expected.space !== null) {
      this.store.writeEngine({ ...this.store.engine, space: expected.space });
    }
    this.lease = new WriterLease(ctx.data_dir, {
      ...(options.heartbeat_ms === undefined
        ? {}
        : { heartbeat_ms: options.heartbeat_ms }),
      clock: ctx.clock,
    });
    this.leaseReceipt = this.lease.tryAcquire(
      options.holder_id ?? `pid:${process.pid}`,
    );
  }

  async upsert(
    docs: readonly RetrievalDoc[],
  ): Promise<RetrievalMutationReport> {
    this.assertOpen();
    const validated = docs.map(validateRetrievalDoc);
    runStoreTransaction(() => {
      for (const doc of validated) {
        const previous = this.store.docs.get(doc.doc_id);
        const chunks =
          previous !== undefined &&
          previous.title === doc.title &&
          previous.text === doc.text
            ? previous.chunks
            : chunkDocument(doc, this.chunkTokens, this.chunkOverlap);
        this.store.docs.set(doc.doc_id, { ...doc, chunks });
        this.indexDocGraph(doc);
      }
      this.store.persist();
    });
    if (this.embedding !== undefined) {
      await this.embedPending();
    }
    return { processed: validated.length };
  }

  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    this.assertOpen();
    const started = Date.now();
    const validated = validateRetrievalQuery(query);
    this.assertDeadline(started, validated.deadline_ms);

    const degraded: string[] = [];
    const timings: Record<string, number> = {};
    const space = this.embedding?.space().id ?? this.store.engine?.space ?? null;

    switch (validated.mode) {
      case "lexical":
        break;
      case "hybrid":
        if (this.embedding === undefined || this.spaceMismatch()) {
          degraded.push(
            this.spaceMismatch()
              ? "embedding-space-mismatch"
              : "vector-skipped",
          );
        }
        break;
      case "vector":
        requireRetrievalCapability(this.descriptor, "vector");
        if (this.embedding === undefined) {
          throw new PortError(
            "unavailable",
            "vector search requires an embedding port",
            false,
          );
        }
        if (this.spaceMismatch()) {
          throw new PortError(
            "space_mismatch",
            `embedding-space-mismatch; lexical fallback is available via hybrid`,
            false,
          );
        }
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
        space: validated.mode === "lexical" ? null : space,
      };
    }

    const visible = this.visibleDocs(validated);
    const lexicalStarted = Date.now();
    const lexicalRanked = this.rankLexical(validated.text, visible);
    timings.lexical = Date.now() - lexicalStarted;

    let fusedIds: string[];
    let scores = new Map<string, number>();

    if (
      validated.mode === "lexical" ||
      this.embedding === undefined ||
      this.spaceMismatch()
    ) {
      fusedIds = lexicalRanked;
      lexicalRanked.forEach((id, index) => {
        scores.set(id, 1 / (60 + index + 1));
      });
    } else {
      const vectorStarted = Date.now();
      const queryVectors = await this.embedQuery(validated.text);
      const vectorRanked = this.rankVector(queryVectors, visible);
      timings.vector = Date.now() - vectorStarted;
      if (validated.mode === "vector") {
        fusedIds = vectorRanked;
        vectorRanked.forEach((id, index) => {
          scores.set(id, 1 / (60 + index + 1));
        });
      } else {
        scores = reciprocalRankFusion([lexicalRanked, vectorRanked]);
        fusedIds = [...scores.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
          .map(([id]) => id);
      }
    }

    this.assertDeadline(started, validated.deadline_ms);

    const docs = new Map(visible.map((doc) => [doc.doc_id, doc]));
    const rawHits: RetrievalHit[] = fusedIds.flatMap((id) => {
      const doc = docs.get(id);
      if (doc === undefined || doc.sensitivity === null) return [];
      return [
        {
          doc_id: id,
          score: applyTierWeight(scores.get(id) ?? 0, doc.authority),
          snippet: snippetFor(validated.text, doc.text),
          kind: doc.kind,
          sensitivity: doc.sensitivity,
          taint: doc.taint,
          authority: doc.authority,
        },
      ];
    });
    rawHits.sort(compareHits);
    const hits = filterNearDuplicates(rawHits, docs).slice(0, validated.limit);

    return {
      hits,
      degraded,
      timings_ms: timings,
      space: validated.mode === "lexical" && this.embedding === undefined
        ? null
        : space,
    };
  }

  async remove(ids: readonly string[]): Promise<RetrievalMutationReport> {
    this.assertOpen();
    runStoreTransaction(() => {
      for (const id of ids) {
        this.store.docs.delete(id);
        this.store.graph.edges = this.store.graph.edges.filter(
          (edge) => edge.from !== id && edge.to !== id,
        );
      }
      this.store.persist();
    });
    return { processed: ids.length };
  }

  async verifyAbsent(ids: readonly string[]): Promise<AbsenceProof> {
    this.assertOpen();
    const found = ids.filter((id) => this.store.docs.has(id));
    return {
      checked: ids.length,
      found,
      store: this.descriptor.id,
      method: `lookup-limit-${MAX_RETRIEVAL_LIMIT}`,
      at: this.ctx.clock(),
    };
  }

  async neighbors(
    entity: EntityRef,
    options: GraphQueryOptions,
  ): Promise<GraphResult> {
    this.assertOpen();
    requireRetrievalCapability(this.descriptor, "graph");
    if (options.hops < 1 || options.limit < 1) {
      throw new PortError("config_invalid", "graph query is invalid", false);
    }
    const start = this.store.graph.entities[entity.entity_id];
    if (start === undefined || !this.entityVisible(start, options.ceiling)) {
      return { entity: entity.entity_id, edges: [], truncated: false };
    }

    const seen = new Set<string>([entity.entity_id]);
    let frontier = [entity.entity_id];
    const collected: RetrievalGraphEdge[] = [];
    let truncated = false;

    for (let hop = 0; hop < options.hops; hop += 1) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const edge of this.store.graph.edges) {
          if (edge.from !== node && edge.to !== node) continue;
          const other = edge.from === node ? edge.to : edge.from;
          if (!this.nodeVisible(other, options.ceiling)) continue;
          collected.push({
            from: edge.from,
            to: edge.to,
            type: edge.type,
            weight: edge.weight,
            provenance: [...edge.provenance],
          });
          if (collected.length >= options.limit) {
            truncated = true;
            return {
              entity: entity.entity_id,
              edges: collected.slice(0, options.limit),
              truncated,
            };
          }
          if (!seen.has(other)) {
            seen.add(other);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return { entity: entity.entity_id, edges: collected, truncated };
  }

  async health(): Promise<PortHealth> {
    this.assertOpen();
    const phantoms = this.store.phantoms();
    const snapshot = this.lease.inspect();
    const space = this.embedding?.space().id ?? this.store.engine?.space ?? null;
    const detail = {
      documents: this.store.docs.size,
      queue_depth: snapshot.queue_depth,
      backlog_depth: this.store.pendingEmbedChunks(space),
      checkpoint: this.store.checkpoint,
      phantoms: phantoms.length,
      lease_pid: snapshot.holder?.pid ?? null,
    };
    if (phantoms.length > 0) {
      return {
        status: "unavailable",
        reason: "phantom embeddings are present; rebuild --layer vector",
      };
    }
    if (this.spaceMismatch()) {
      return {
        status: "degraded",
        degraded: ["embedding-space-mismatch"],
        detail,
      };
    }
    return { status: "ready", detail };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    this.lease.release();
  }

  watch(options: Omit<RefreshWatcherOptions, "isSelfWrite" | "refresh"> & {
    refresh?: () => Promise<void>;
  }): RefreshWatcher {
    this.assertOpen();
    this.watcher?.close();
    this.watcher = new RefreshWatcher({
      root: options.root,
      refresh: options.refresh ?? (async () => {
        this.lastRefreshPass += 1;
      }),
      isSelfWrite: (path, digest) => this.store.selfWrites.get(path) === digest,
    });
    this.watcher.start();
    return this.watcher;
  }

  recordSelfWrite(path: string, contents: string): void {
    this.assertOpen();
    const digest = sha256Text(contents);
    this.store.selfWrites.set(path, digest);
    writeAtomic(path, contents);
    this.store.persist();
  }

  isSelfWrite(path: string, digest: string): boolean {
    return this.store.selfWrites.get(path) === digest;
  }

  embedCheckpoint(): EmbedCheckpoint | null {
    return this.store.checkpoint;
  }

  injectPhantom(docId: string): void {
    this.assertOpen();
    const doc = this.store.docs.get(docId);
    if (doc === undefined) {
      throw new PortError("config_invalid", "phantom target is missing", false);
    }
    const chunks = doc.chunks.map((chunk) => ({
      ...chunk,
      vector: null,
      embedded_at: this.ctx.clock(),
    }));
    this.store.docs.set(docId, { ...doc, chunks });
    this.store.persist();
  }

  async rebuildLayer(
    layer: "search" | "vector" | "graph" | "entities" | "all",
  ): Promise<void> {
    this.assertOpen();
    switch (layer) {
      case "search":
        break;
      case "graph":
      case "entities":
        runStoreTransaction(() => {
          this.store.graph = { entities: {}, edges: [] };
          for (const doc of this.store.docs.values()) this.indexDocGraph(doc);
          this.store.persist();
        });
        break;
      case "vector":
        runStoreTransaction(() => {
          for (const [id, doc] of this.store.docs) {
            this.store.docs.set(id, {
              ...doc,
              chunks: doc.chunks.map((chunk) => ({
                ...chunk,
                vector: null,
                embedded_at: null,
                space: null,
              })),
            });
          }
          this.store.checkpoint = null;
          this.store.persist();
        });
        await this.embedPending();
        break;
      case "all":
        await this.rebuildLayer("graph");
        await this.rebuildLayer("vector");
        break;
      default: {
        const _exhaustive: never = layer;
        throw new PortError(
          "not_supported",
          `rebuild layer ${_exhaustive} is not supported`,
          false,
        );
      }
    }
    if (this.store.engine !== null) {
      this.store.writeEngine({
        ...this.store.engine,
        rebuilt_at: this.ctx.clock(),
      });
    }
  }

  async embedPending(): Promise<void> {
    this.assertOpen();
    if (this.embedding === undefined) {
      throw new PortError(
        "unavailable",
        "embedding port is not configured",
        false,
      );
    }
    assertNoStoreTransaction("embedPending");
    const space = this.embedding.space();
    const pending = [...this.store.docs.values()].sort((left, right) => {
      if (right.updated_at !== left.updated_at) {
        return right.updated_at.localeCompare(left.updated_at);
      }
      return left.doc_id.localeCompare(right.doc_id);
    });
    let resume = this.store.checkpoint;
    for (const doc of pending) {
      const start =
        resume !== null &&
        resume.doc_id === doc.doc_id &&
        resume.space === space.id
          ? resume.chunk_index
          : 0;
      for (let index = start; index < doc.chunks.length; index += 1) {
        const chunk = doc.chunks[index];
        if (chunk === undefined) continue;
        if (chunk.vector !== null && chunk.space === space.id) continue;
        const payload: Chunk = {
          chunk_id: chunk.chunk_id,
          doc_id: doc.doc_id,
          text: chunk.text,
          index: chunk.index,
        };
        const [vector] = await this.embedDocs([payload]);
        if (vector === undefined) {
          throw new PortError("unavailable", "embedder returned no vector", false);
        }
        this.writeEmbeddedChunk(doc.doc_id, index, vector, space.id);
        resume = {
          doc_id: doc.doc_id,
          chunk_index: index + 1,
          space: space.id,
        };
      }
      if (resume?.doc_id === doc.doc_id) resume = null;
    }
    runStoreTransaction(() => {
      this.store.checkpoint = resume;
      this.store.persist();
    });
  }

  embedInsideOpenTransaction(): Promise<Float32Array[]> {
    return runStoreTransaction(() => this.embedDocs([{
      chunk_id: "guard",
      doc_id: "guard",
      text: "guard",
      index: 0,
    }]));
  }

  async acquireWaiting(
    holderId: string,
    timeoutMs: number,
  ): Promise<LeaseReceipt> {
    return this.lease.acquire(holderId, timeoutMs);
  }

  queueDepth(): number {
    return this.lease.inspect().queue_depth;
  }

  upsertEntities(entities: readonly StoredEntity[]): void {
    this.assertOpen();
    runStoreTransaction(() => {
      for (const entity of entities) {
        this.store.graph.entities[entity.entity_id] = entity;
      }
      this.store.persist();
    });
  }

  upsertEdges(edges: readonly StoredEdge[]): void {
    this.assertOpen();
    runStoreTransaction(() => {
      this.store.graph.edges.push(...edges);
      this.store.persist();
    });
  }

  private async embedQuery(text: string): Promise<Float32Array[]> {
    assertNoStoreTransaction("embedQuery");
    if (this.embedding === undefined) {
      throw new PortError("unavailable", "embedding port is not configured", false);
    }
    return this.embedding.embedQuery([text]);
  }

  private async embedDocs(chunks: readonly Chunk[]): Promise<Float32Array[]> {
    assertNoStoreTransaction("embedDocs");
    if (this.embedding === undefined) {
      throw new PortError("unavailable", "embedding port is not configured", false);
    }
    return this.embedding.embedDocs(chunks);
  }

  private writeEmbeddedChunk(
    docId: string,
    index: number,
    vector: Float32Array,
    space: string,
  ): void {
    runStoreTransaction(() => {
      const doc = this.store.docs.get(docId);
      if (doc === undefined) return;
      const chunks: StoredChunk[] = doc.chunks.map((chunk) =>
        chunk.index === index
          ? {
              ...chunk,
              vector: [...vector],
              embedded_at: this.ctx.clock(),
              space,
            }
          : chunk,
      );
      this.store.docs.set(docId, { ...doc, chunks });
      this.store.checkpoint = {
        doc_id: docId,
        chunk_index: index + 1,
        space,
      };
      this.store.persist();
    });
  }

  private visibleDocs(query: RetrievalQuery): StoredDoc[] {
    const ceiling = SENSITIVITY_ORDER[query.ceiling];
    const kinds = query.scope.kinds;
    const subjects = query.scope.subjects;
    const since = query.scope.since;
    const until = query.scope.until;
    return [...this.store.docs.values()].filter((doc) => {
      if (doc.sensitivity === null) return false;
      if (SENSITIVITY_ORDER[doc.sensitivity] > ceiling) return false;
      if (kinds !== undefined && !kinds.includes(doc.kind)) return false;
      if (
        subjects !== undefined &&
        !subjects.some((subject) => doc.subjects.includes(subject))
      ) {
        return false;
      }
      if (since !== undefined) {
        if (doc.occurred_at === null || doc.occurred_at < since) return false;
      }
      if (until !== undefined) {
        if (doc.occurred_at === null || doc.occurred_at >= until) return false;
      }
      return true;
    });
  }

  private rankLexical(text: string, docs: readonly StoredDoc[]): string[] {
    return [...docs]
      .map((doc) => ({ id: doc.doc_id, score: lexicalScore(text, doc) }))
      .filter((row) => text.trim().length === 0 || row.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.id.localeCompare(right.id);
      })
      .map((row) => row.id);
  }

  private rankVector(
    queryVectors: readonly Float32Array[],
    docs: readonly StoredDoc[],
  ): string[] {
    const query = queryVectors[0];
    if (query === undefined) return [];
    const space = this.embedding?.space().id;
    return [...docs]
      .map((doc) => {
        let best = 0;
        for (const chunk of doc.chunks) {
          if (chunk.vector === null) continue;
          if (space !== undefined && chunk.space !== space) continue;
          best = Math.max(best, cosine(query, Float32Array.from(chunk.vector)));
        }
        return { id: doc.doc_id, score: best };
      })
      .filter((row) => row.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return left.id.localeCompare(right.id);
      })
      .map((row) => row.id);
  }

  private spaceMismatch(): boolean {
    const runtime = this.embedding?.space().id;
    const stored = this.store.engine?.space;
    return (
      runtime !== undefined &&
      stored !== null &&
      stored !== undefined &&
      runtime !== stored
    );
  }

  private indexDocGraph(doc: RetrievalDoc): void {
    for (const subject of doc.subjects) {
      const kind = subject.includes(":") ? subject.split(":")[0] ?? "entity" : "entity";
      const name = subject.includes(":")
        ? subject.slice(subject.indexOf(":") + 1)
        : subject;
      const existing = this.store.graph.entities[subject];
      this.store.graph.entities[subject] = {
        entity_id: subject,
        kind,
        canonical_name: existing?.canonical_name ?? name,
        aliases: existing?.aliases ?? [],
        confidence: existing?.confidence ?? 1,
        source_claims:
          doc.kind === "claim"
            ? [...new Set([...(existing?.source_claims ?? []), doc.doc_id])]
            : (existing?.source_claims ?? []),
        sensitivity: tighterSensitivity(existing?.sensitivity ?? null, doc.sensitivity),
      };
      const edge: StoredEdge = {
        from: doc.doc_id,
        to: subject,
        type: "subject",
        weight: 1,
        valid_from: doc.occurred_at,
        valid_to: null,
        provenance: [...doc.provenance],
      };
      if (
        !this.store.graph.edges.some(
          (item) =>
            item.from === edge.from &&
            item.to === edge.to &&
            item.type === edge.type,
        )
      ) {
        this.store.graph.edges.push(edge);
      }
    }
  }

  private entityVisible(
    entity: StoredEntity,
    ceiling: Sensitivity,
  ): boolean {
    if (entity.sensitivity === null) return false;
    return SENSITIVITY_ORDER[entity.sensitivity] <= SENSITIVITY_ORDER[ceiling];
  }

  private nodeVisible(id: string, ceiling: Sensitivity): boolean {
    const entity = this.store.graph.entities[id];
    if (entity !== undefined) return this.entityVisible(entity, ceiling);
    const doc = this.store.docs.get(id);
    if (doc === undefined || doc.sensitivity === null) return false;
    return SENSITIVITY_ORDER[doc.sensitivity] <= SENSITIVITY_ORDER[ceiling];
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new PortError("unavailable", "retrieval port is closed", false);
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
}

function tighterSensitivity(
  left: Sensitivity | null,
  right: Sensitivity | null,
): Sensitivity | null {
  if (left === null) return right;
  if (right === null) return left;
  return SENSITIVITY_ORDER[left] >= SENSITIVITY_ORDER[right] ? left : right;
}

export function createEmbeddedRetrievalPort(
  ctx: PortContext,
  options: EmbeddedRetrievalOptions = {},
): EmbeddedRetrievalPort {
  return new EmbeddedRetrievalPort(ctx, options);
}

export async function openEmbeddedRetrievalPort(
  ctx: PortContext,
  options: EmbeddedRetrievalOptions = {},
): Promise<EmbeddedRetrievalPort> {
  try {
    return createEmbeddedRetrievalPort(ctx, options);
  } catch (error) {
    if (
      !(error instanceof PortError) ||
      error.code !== "lease_required"
    ) {
      throw error;
    }
  }
  const timeout = options.acquire_timeout_ms ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const lease = new WriterLease(ctx.data_dir, {
    ...(options.heartbeat_ms === undefined
      ? {}
      : { heartbeat_ms: options.heartbeat_ms }),
    clock: ctx.clock,
  });
  await lease.acquire(
    options.holder_id ?? `wait:${process.pid}`,
    timeout,
  );
  lease.release();
  return createEmbeddedRetrievalPort(ctx, options);
}
