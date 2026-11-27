import { statSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type {
  GraphResponse,
  KizukiVaultApi,
  MemtExperience,
  NodeDetailResponse,
  OverviewResponse,
  PersonDossierQueryOptions,
  PersonDossierResponse,
  SearchResponse,
  StreamResponse,
} from "./vault-api.ts";

export interface HotReadCacheConfig {
  api: KizukiVaultApi;
  statThrottleMs?: number;
  enableBootPrewarm?: boolean;
  prewarmDelayMs?: number;
  prewarmSpacingMs?: number;
  isTestRun?: boolean;
  nowFn?: () => number;
}

export interface LruEntry<T> {
  value: T;
  fingerprint: string;
  createdAt: number;
  softExpiresAt: number;
}

export interface LruCacheStats {
  size: number;
  maxEntries: number;
  hits: number;
  staleHits: number;
  misses: number;
  invalidations: number;
}

export interface StreamQueryParams {
  connector?: string;
  source?: string;
  kind?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface GraphQueryParams {
  limit?: number;
  kind?: string;
  q?: string;
}

export function isTestRuntime(): boolean {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return true;
  }
  if (typeof Bun !== "undefined" && /\.test\.[cm]?[jt]sx?$/.test(String(Bun.main || ""))) {
    return true;
  }
  if (Array.isArray(process.argv)) {
    for (const arg of process.argv) {
      if (arg === "test" || /\.test\.[cm]?[jt]sx?$/.test(arg)) return true;
    }
  }
  return false;
}

export function readSqliteDataVersion(db: Database): number {
  try {
    const row = db.query("PRAGMA data_version").get() as { data_version?: number } | null;
    return Number(row?.data_version ?? 0) || 0;
  } catch {
    return 0;
  }
}

function stripEmDashesLocal(raw: string): string {
  return raw.replace(/\s*\u2014\s*/g, " - ").replace(/\u2014/g, "-");
}

function cleanTextLocal(raw: unknown, maxLen = 280): string {
  const s = stripEmDashesLocal(String(raw ?? ""))
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, Math.max(1, maxLen - 3));
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:.\-/\s]+$/, "")}...`;
}

function isLikelyHexHash(s: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(String(s || "").trim());
}

function normalizeKind(raw: unknown, fallback = "concept"): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return fallback;
  return s.replace(/^world\./, "");
}

function extractLabelFromSummary(summary: string | null, fallbackId: string): string {
  const clean = cleanTextLocal(summary || "", 120);
  if (!clean) return fallbackId.slice(0, 24);
  const firstSentence = clean.split(/[.!?]/)[0]?.trim() || clean;
  return cleanTextLocal(firstSentence, 72) || fallbackId.slice(0, 24);
}

function tokenizeQuery(text: string): string[] {
  const lower = stripEmDashesLocal(String(text ?? "")).toLowerCase();
  const out = new Set<string>();
  let start = -1;
  for (let i = 0; i <= lower.length; i += 1) {
    const ch = i < lower.length ? lower.charCodeAt(i) : 32;
    const isAlnum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57);
    if (isAlnum) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      if (i - start >= 2) {
        out.add(lower.slice(start, Math.min(i, start + 36)));
      }
      start = -1;
    }
  }
  return Array.from(out);
}

function lowerBound(arr: string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Bounded LRU cache with fingerprint validation, stale-while-revalidate soft TTL,
 * and single-flight request coalescing.
 */
export class BoundedLruCache<T> {
  private readonly maxEntries: number;
  private readonly softTtlMs: number;
  private readonly nowFn: () => number;
  private readonly allowBackgroundRevalidate: boolean;

  private readonly entries = new Map<string, LruEntry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();

  private hits = 0;
  private staleHits = 0;
  private misses = 0;
  private invalidations = 0;

  constructor(opts: {
    maxEntries: number;
    softTtlMs: number;
    nowFn?: () => number;
    allowBackgroundRevalidate?: boolean;
  }) {
    this.maxEntries = Math.max(1, opts.maxEntries);
    this.softTtlMs = Math.max(500, opts.softTtlMs);
    this.nowFn = opts.nowFn || Date.now;
    this.allowBackgroundRevalidate = opts.allowBackgroundRevalidate !== false;
  }

  getStats(): LruCacheStats {
    return {
      size: this.entries.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      invalidations: this.invalidations,
    };
  }

  peek(key: string, expectedFingerprint?: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (expectedFingerprint !== undefined && entry.fingerprint !== expectedFingerprint) {
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, fingerprint: string): void {
    const now = this.nowFn();
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
      }
    }
    this.entries.set(key, {
      value,
      fingerprint,
      createdAt: now,
      softExpiresAt: now + this.softTtlMs,
    });
  }

  delete(key: string): boolean {
    const removed = this.entries.delete(key);
    if (removed) this.invalidations += 1;
    return removed;
  }

  deleteWhere(predicate: (key: string) => boolean): number {
    let count = 0;
    for (const key of Array.from(this.entries.keys())) {
      if (predicate(key)) {
        this.entries.delete(key);
        count += 1;
      }
    }
    if (count > 0) this.invalidations += count;
    return count;
  }

  clear(): void {
    if (this.entries.size > 0) {
      this.invalidations += this.entries.size;
      this.entries.clear();
    }
  }

  async getOrLoad(
    key: string,
    getFingerprint: string | (() => string),
    loader: () => Promise<T>,
    opts: { cachePredicate?: (val: T) => boolean } = {},
  ): Promise<T> {
    const readFp = typeof getFingerprint === "function" ? getFingerprint : () => getFingerprint;
    const fingerprint = readFp();
    const now = this.nowFn();
    const existing = this.entries.get(key);

    if (existing && existing.fingerprint === fingerprint) {
      // Touch LRU recency
      this.entries.delete(key);
      this.entries.set(key, existing);

      if (now < existing.softExpiresAt) {
        this.hits += 1;
        return existing.value;
      }

      // Fingerprint still matches, soft TTL expired -> serve stale immediately and revalidate in background
      this.staleHits += 1;
      if (this.allowBackgroundRevalidate && !this.inFlight.has(key)) {
        void this.loadSingleFlight(key, fingerprint, readFp, loader, opts.cachePredicate).catch(() => {
          // Keep last valid entry on background refresh failure
        });
      }
      return existing.value;
    }

    if (existing && existing.fingerprint !== fingerprint) {
      this.entries.delete(key);
      this.invalidations += 1;
    }

    this.misses += 1;
    return this.loadSingleFlight(key, fingerprint, readFp, loader, opts.cachePredicate);
  }

  private loadSingleFlight(
    key: string,
    initialFingerprint: string,
    readFp: () => string,
    loader: () => Promise<T>,
    cachePredicate?: (val: T) => boolean,
  ): Promise<T> {
    const inflightKey = `${key}@@${initialFingerprint}`;
    const active = this.inFlight.get(inflightKey);
    if (active) return active;

    const promise = (async () => {
      const val = await loader();
      if (!cachePredicate || cachePredicate(val)) {
        // Store under post-load fingerprint so concurrent background daemon ticks during a slow cold load
        // do not immediately invalidate the fresh result on the very next read.
        const finalFp = readFp();
        this.set(key, val, finalFp);
      }
      return val;
    })().finally(() => {
      if (this.inFlight.get(inflightKey) === promise) {
        this.inFlight.delete(inflightKey);
      }
    });

    this.inFlight.set(inflightKey, promise);
    return promise;
  }
}

interface SearchWorldRecord {
  hit: SearchResponse["world_hits"][number];
  searchLower: string;
}

interface SearchClaimRecord {
  hit: SearchResponse["claim_hits"][number];
  searchLower: string;
}

interface SearchEventRecord {
  hit: SearchResponse["event_hits"][number];
  searchLower: string;
}

interface SearchMemtRecord {
  hit: SearchResponse["memt_hits"][number];
  searchLower: string;
}

interface SearchCorpusIndex<R> {
  records: R[];
  vocab: string[];
  postings: Map<string, Uint32Array>;
}

interface HotSearchSnapshot {
  builtAt: number;
  dataVersion: number;
  world: SearchCorpusIndex<SearchWorldRecord>;
  claims: SearchCorpusIndex<SearchClaimRecord>;
  events: SearchCorpusIndex<SearchEventRecord>;
  memt: SearchCorpusIndex<SearchMemtRecord>;
}

function buildCompactCorpusIndex<R extends { searchLower: string }>(
  records: R[],
): SearchCorpusIndex<R> {
  const raw = new Map<string, number[]>();
  for (let i = 0; i < records.length; i += 1) {
    const tokens = tokenizeQuery(records[i].searchLower);
    for (let j = 0; j < tokens.length; j += 1) {
      const tok = tokens[j];
      let list = raw.get(tok);
      if (!list) {
        list = [];
        raw.set(tok, list);
      }
      list.push(i);
    }
  }
  const vocab = Array.from(raw.keys()).sort();
  const postings = new Map<string, Uint32Array>();
  for (let i = 0; i < vocab.length; i += 1) {
    const key = vocab[i];
    postings.set(key, Uint32Array.from(raw.get(key)!));
  }
  return { records, vocab, postings };
}

function queryCorpusIndex<R extends { searchLower: string }>(
  corpus: SearchCorpusIndex<R>,
  qLower: string,
  qTokens: string[],
  limit: number,
  maxSubstringScan: number,
): R[] {
  const { records, vocab, postings } = corpus;
  if (records.length === 0 || limit <= 0) return [];

  // Fast O(limit) path for single-token queries: postings are already ordered newest-first!
  if (qTokens.length === 1) {
    const qt = qTokens[0];
    const picked: Array<{ idx: number; score: number }> = [];
    const seenIdx = new Set<number>();
    const targetCandidates = limit * 4;

    const exactList = postings.get(qt);
    if (exactList) {
      const cap = Math.min(exactList.length, targetCandidates);
      for (let i = 0; i < cap; i += 1) {
        const idx = exactList[i];
        seenIdx.add(idx);
        picked.push({ idx, score: 70 });
      }
    }

    if (picked.length < targetCandidates) {
      const startIdx = lowerBound(vocab, qt);
      let expanded = 0;
      for (let vi = startIdx; vi < vocab.length && expanded < 80 && picked.length < targetCandidates; vi += 1) {
        const term = vocab[vi];
        if (!term.startsWith(qt)) break;
        expanded += 1;
        if (term === qt) continue;
        const list = postings.get(term);
        if (!list) continue;
        const cap = Math.min(list.length, targetCandidates - picked.length);
        for (let pi = 0; pi < cap; pi += 1) {
          const idx = list[pi];
          if (seenIdx.has(idx)) continue;
          seenIdx.add(idx);
          picked.push({ idx, score: 40 });
        }
      }
    }

    if (picked.length < limit && qLower.length >= 2) {
      const scanCap = Math.min(records.length, maxSubstringScan);
      for (let i = 0; i < scanCap && picked.length < limit; i += 1) {
        if (seenIdx.has(i)) continue;
        if (!records[i].searchLower.includes(qLower)) continue;
        seenIdx.add(i);
        picked.push({ idx: i, score: 20 });
      }
    }

    if (picked.length === 0) return [];
    picked.sort((a, b) => b.score - a.score || a.idx - b.idx);
    const out: R[] = [];
    for (let i = 0; i < picked.length && out.length < limit; i += 1) {
      out.push(records[picked[i].idx]);
    }
    return out;
  }

  // Multi-token path: bounded scan per token (sorted ascending by index)
  const matchedIds = new Map<number, number>();
  const tokenHits = new Map<number, number>();
  const perTokenCap = Math.max(limit * 24, 320);

  for (let t = 0; t < qTokens.length; t += 1) {
    const qt = qTokens[t];
    const startIdx = lowerBound(vocab, qt);
    let expanded = 0;
    const seenTok = new Set<number>();

    for (let vi = startIdx; vi < vocab.length && expanded < 60 && seenTok.size < perTokenCap; vi += 1) {
      const term = vocab[vi];
      if (!term.startsWith(qt)) break;
      expanded += 1;
      const weight = term.length === qt.length ? 30 : 16;
      const list = postings.get(term);
      if (!list) continue;
      const cap = Math.min(list.length, perTokenCap - seenTok.size);
      for (let pi = 0; pi < cap; pi += 1) {
        const docId = list[pi];
        if (!seenTok.has(docId)) {
          seenTok.add(docId);
          matchedIds.set(docId, (matchedIds.get(docId) || 0) + weight);
          tokenHits.set(docId, (tokenHits.get(docId) || 0) + 1);
        }
      }
    }
  }

  const picked: Array<{ idx: number; score: number }> = [];
  const seenIdx = new Set<number>();
  for (const [idx, baseScore] of matchedIds.entries()) {
    const rec = records[idx];
    const hits = tokenHits.get(idx) || 0;
    const hasPhrase = rec.searchLower.includes(qLower);
    if (qTokens.length > 1 && hits < qTokens.length && !hasPhrase) {
      continue;
    }
    seenIdx.add(idx);
    const score = baseScore + (hasPhrase ? 40 : 0);
    picked.push({ idx, score });
  }

  if (picked.length < limit && qLower.length >= 2) {
    const scanCap = Math.min(records.length, maxSubstringScan);
    for (let i = 0; i < scanCap && picked.length < limit; i += 1) {
      if (seenIdx.has(i)) continue;
      if (!records[i].searchLower.includes(qLower)) continue;
      seenIdx.add(i);
      picked.push({ idx: i, score: 20 });
    }
  }

  if (picked.length === 0) return [];
  picked.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const out: R[] = [];
  for (let i = 0; i < picked.length && out.length < limit; i += 1) {
    out.push(records[picked[i].idx]);
  }
  return out;
}

/**
 * In-memory inverted search index for GET /api/search?q=...
 * Matches KizukiVaultApi.search() exact response shape while eliminating
 * SQLite LIKE table scans and MemT subprocess spawns on warm queries.
 */
export class HotSearchIndex {
  private readonly api: KizukiVaultApi;
  private snapshot: HotSearchSnapshot | null = null;
  private buildInFlight: Promise<HotSearchSnapshot> | null = null;
  private closed = false;

  constructor(api: KizukiVaultApi) {
    this.api = api;
  }

  isReady(): boolean {
    return this.snapshot !== null;
  }

  canServe(liveDataVersion: number, allowStaleMs = 0): boolean {
    if (!this.snapshot) return false;
    if (this.snapshot.dataVersion === liveDataVersion) return true;
    if (allowStaleMs > 0 && Date.now() - this.snapshot.builtAt < allowStaleMs) {
      return true;
    }
    return false;
  }

  getStats(): {
    ready: boolean;
    builtAt: number;
    dataVersion: number;
    worldCount: number;
    claimsCount: number;
    eventsCount: number;
    memtCount: number;
  } {
    if (!this.snapshot) {
      return {
        ready: false,
        builtAt: 0,
        dataVersion: 0,
        worldCount: 0,
        claimsCount: 0,
        eventsCount: 0,
        memtCount: 0,
      };
    }
    return {
      ready: true,
      builtAt: this.snapshot.builtAt,
      dataVersion: this.snapshot.dataVersion,
      worldCount: this.snapshot.world.records.length,
      claimsCount: this.snapshot.claims.records.length,
      eventsCount: this.snapshot.events.records.length,
      memtCount: this.snapshot.memt.records.length,
    };
  }

  invalidate(): void {
    this.snapshot = null;
  }

  close(): void {
    this.closed = true;
    this.snapshot = null;
    this.buildInFlight = null;
  }

  warmInBackground(): void {
    if (this.closed || this.buildInFlight) return;
    void this.rebuild().catch(() => {
      // fail-soft background build
    });
  }

  async rebuild(): Promise<HotSearchSnapshot> {
    if (this.buildInFlight) return this.buildInFlight;

    const task = (async (): Promise<HotSearchSnapshot> => {
      // Load MemT first (async subprocess) BEFORE reading SQLite + data_version so snapshot dataVersion stays fresh!
      const memtList: MemtExperience[] = await this.api
        .getMemtExperiences(200)
        .catch(() => []);

      const db = this.api.getDb();

      // 1. World consolidation rows
      const worldRecords: SearchWorldRecord[] = [];
      try {
        const rows = db
          .query(
            `SELECT wc.handle_id,
                    wc.kind,
                    wc.status,
                    wc.summary,
                    COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                    MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                             THEN json_extract(s.payload, '$.object.value') END) AS sem_label
             FROM world_consolidation wc
             LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
             LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
             GROUP BY wc.basis_digest
             ORDER BY CASE WHEN wc.status = 'complete' THEN 0 ELSE 1 END, updated_at DESC
             LIMIT 10000`,
          )
          .all() as Array<{
          handle_id: string;
          kind: string;
          status: string;
          summary: string | null;
          updated_at: string | null;
          sem_label: string | null;
        }>;
        for (const r of rows) {
          const label =
            (r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanTextLocal(r.sem_label, 72) : "") ||
            extractLabelFromSummary(r.summary, r.handle_id);
          const summary = cleanTextLocal(r.summary, 360);
          const hit: SearchResponse["world_hits"][number] = {
            id: r.handle_id,
            label,
            kind: normalizeKind(r.kind, "concept"),
            status: r.status || "complete",
            summary,
            updated_at: r.updated_at || null,
          };
          worldRecords.push({
            hit,
            searchLower: `${label} ${r.sem_label || ""} ${summary} ${r.handle_id}`.toLowerCase(),
          });
        }
      } catch {
        // fail-soft on minimal fixture DBs
      }

      // 2. Live claims (newest 8,000 live claims ordered newest-first for sub-250ms build and sub-2ms query)
      const claimRecords: SearchClaimRecord[] = [];
      try {
        const rows = db
          .query(
            `SELECT c.claim_id,
                    c.kind,
                    c.target,
                    c.subject,
                    COALESCE(s.predicate, c.predicate) AS predicate,
                    COALESCE(json_extract(s.payload, '$.object.value'), c.body) AS body_val,
                    substr(COALESCE(c.body, ''), 1, 200) AS raw_body,
                    c.confidence,
                    c.created_at
             FROM claims c
             LEFT JOIN claim_v2_semantics s ON s.claim_id = c.claim_id
             WHERE c.status = 'live'
             ORDER BY c.created_at DESC
             LIMIT 8000`,
          )
          .all() as Array<{
          claim_id: string;
          kind: string;
          target: string | null;
          subject: string | null;
          predicate: string | null;
          body_val: string | null;
          raw_body: string | null;
          confidence: number;
          created_at: string;
        }>;
        for (const r of rows) {
          const text = cleanTextLocal(r.body_val, 300);
          const hit: SearchResponse["claim_hits"][number] = {
            claim_id: r.claim_id,
            kind: r.kind,
            target: r.target,
            predicate: r.predicate,
            text,
            confidence: Number(r.confidence ?? 0.5),
            created_at: r.created_at,
          };
          const searchLower = `${text} ${r.raw_body || ""} ${r.target || ""} ${r.subject || ""} ${r.predicate || ""}`.toLowerCase();
          claimRecords.push({ hit, searchLower });
        }
      } catch {
        // fail-soft on minimal fixture DBs
      }

      // 3. Recent 5,000 non-deleted events (exact window of vault-api.ts search())
      const eventRecords: SearchEventRecord[] = [];
      try {
        const rows = db
          .query(
            `SELECT event_id, connector_id, kind, occurred_at, substr(text, 1, 320) AS snippet
             FROM events
             WHERE deleted = 0
             ORDER BY occurred_at DESC
             LIMIT 5000`,
          )
          .all() as Array<{
          event_id: string;
          connector_id: string;
          kind: string;
          occurred_at: string;
          snippet: string | null;
        }>;
        for (const r of rows) {
          const snippet = cleanTextLocal(r.snippet, 280);
          const hit: SearchResponse["event_hits"][number] = {
            event_id: r.event_id,
            connector_id: r.connector_id,
            kind: r.kind,
            occurred_at: r.occurred_at,
            snippet,
          };
          eventRecords.push({
            hit,
            searchLower: `${snippet} ${r.connector_id} ${r.kind}`.toLowerCase(),
          });
        }
      } catch {
        // fail-soft on minimal fixture DBs
      }

      // 4. MemT experiences
      const memtRecords: SearchMemtRecord[] = [];
      for (const exp of memtList) {
        const condition = cleanTextLocal(exp.condition, 240);
        const recommendation = cleanTextLocal(exp.recommendation, 360);
        const verification = exp.verification ? cleanTextLocal(exp.verification, 200) : undefined;
        const hit: SearchResponse["memt_hits"][number] = {
          id: exp.id,
          domain: exp.domain,
          condition,
          recommendation,
          ...(verification ? { verification } : {}),
          outcome: exp.outcome,
          confidence: Number(exp.confidence ?? 0.9),
          score: 1,
        };
        memtRecords.push({
          hit,
          searchLower: `${exp.domain} ${condition} ${recommendation} ${verification || ""} ${exp.id}`.toLowerCase(),
        });
      }

      const world = buildCompactCorpusIndex(worldRecords);
      const claims = buildCompactCorpusIndex(claimRecords);
      const events = buildCompactCorpusIndex(eventRecords);
      const memt = buildCompactCorpusIndex(memtRecords);
      const dataVersion = readSqliteDataVersion(db);
      const snap: HotSearchSnapshot = {
        builtAt: Date.now(),
        dataVersion,
        world,
        claims,
        events,
        memt,
      };

      if (!this.closed) {
        this.snapshot = snap;
      }
      return snap;
    })().finally(() => {
      if (this.buildInFlight === task) {
        this.buildInFlight = null;
      }
    });

    this.buildInFlight = task;
    return task;
  }

  search(rawQuery: string, limitOverride?: number): SearchResponse | null {
    const snap = this.snapshot;
    if (!snap) return null;

    const t0 = performance.now();
    const query = (rawQuery || "").trim();
    if (!query) {
      return {
        query: "",
        ms: 0,
        memt_hits: [],
        world_hits: [],
        claim_hits: [],
        event_hits: [],
      };
    }

    const qLower = query.toLowerCase();
    const qTokens = tokenizeQuery(qLower);

    const memtLimit = limitOverride ? Math.max(1, Math.min(30, limitOverride)) : 8;
    const defaultLimit = limitOverride ? Math.max(1, Math.min(50, limitOverride)) : 15;

    const memtMatched = queryCorpusIndex(snap.memt, qLower, qTokens, memtLimit, 300);
    const worldMatched = queryCorpusIndex(snap.world, qLower, qTokens, defaultLimit, 1500);
    const claimMatched = queryCorpusIndex(snap.claims, qLower, qTokens, defaultLimit, 6000);
    const eventMatched = queryCorpusIndex(snap.events, qLower, qTokens, defaultLimit, 5000);

    const ms = Math.round((performance.now() - t0) * 10) / 10;

    return {
      query,
      ms,
      memt_hits: memtMatched.map((r) => r.hit),
      world_hits: worldMatched.map((r) => r.hit),
      claim_hits: claimMatched.map((r) => r.hit),
      event_hits: eventMatched.map((r) => r.hit),
    };
  }
}

/**
 * Unified Sub-2ms Hot-Path Acceleration Engine for Kizuki Mind Explorer.
 * Accelerates /api/stream, /api/search, /api/node/:id, /api/people/dossier,
 * /api/overview, and /api/graph with PRAGMA data_version + JSONL mtime invalidation,
 * bounded LRU caches, SWR background refresh, and staggered low-priority boot prewarming.
 */
export class HotReadCacheEngine {
  private readonly api: KizukiVaultApi;
  private readonly statThrottleMs: number;
  private readonly prewarmDelayMs: number;
  private readonly prewarmSpacingMs: number;
  private readonly testMode: boolean;
  private readonly nowFn: () => number;

  private readonly streamCache: BoundedLruCache<StreamResponse>;
  private readonly searchCache: BoundedLruCache<SearchResponse>;
  private readonly nodeCache: BoundedLruCache<NodeDetailResponse | null>;
  private readonly dossierCache: BoundedLruCache<PersonDossierResponse>;
  private readonly overviewCache: BoundedLruCache<OverviewResponse>;
  private readonly graphCache: BoundedLruCache<GraphResponse>;

  readonly searchIndex: HotSearchIndex;

  // Throttled Antigravity JSONL stat cache
  private jsonlFingerprint = "init";
  private jsonlStatAt = -1;

  // Manual invalidation epochs per scope
  private globalEpoch = 0;
  private streamEpoch = 0;
  private searchEpoch = 0;
  private nodeEpoch = 0;
  private dossierEpoch = 0;
  private overviewEpoch = 0;
  private graphEpoch = 0;
  private readonly personEpochs = new Map<string, number>();
  private readonly personAliasToCanonical = new Map<string, string>();

  // Pre-warmer timer management
  private prewarmTimer: ReturnType<typeof setTimeout> | null = null;
  private prewarmStepTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(cfg: HotReadCacheConfig) {
    this.api = cfg.api;
    this.statThrottleMs = Math.max(0, cfg.statThrottleMs ?? 1_000);
    this.prewarmDelayMs = Math.max(100, cfg.prewarmDelayMs ?? 3_500);
    this.prewarmSpacingMs = Math.max(25, cfg.prewarmSpacingMs ?? 150);
    this.testMode = cfg.isTestRun ?? isTestRuntime();
    this.nowFn = cfg.nowFn || Date.now;

    const allowBg = !this.testMode;

    this.streamCache = new BoundedLruCache<StreamResponse>({
      maxEntries: 64,
      softTtlMs: 15_000,
      nowFn: this.nowFn,
      allowBackgroundRevalidate: allowBg,
    });
    this.searchCache = new BoundedLruCache<SearchResponse>({
      maxEntries: 256,
      softTtlMs: 30_000,
      nowFn: this.nowFn,
      allowBackgroundRevalidate: allowBg,
    });
    this.nodeCache = new BoundedLruCache<NodeDetailResponse | null>({
      maxEntries: 512,
      softTtlMs: 60_000,
      nowFn: this.nowFn,
      allowBackgroundRevalidate: allowBg,
    });
    this.dossierCache = new BoundedLruCache<PersonDossierResponse>({
      maxEntries: 128,
      softTtlMs: 45_000,
      nowFn: this.nowFn,
      allowBackgroundRevalidate: allowBg,
    });
    this.overviewCache = new BoundedLruCache<OverviewResponse>({
      maxEntries: 8,
      softTtlMs: 20_000,
      nowFn: this.nowFn,
      allowBackgroundRevalidate: allowBg,
    });
    this.graphCache = new BoundedLruCache<GraphResponse>({
      maxEntries: 32,
      softTtlMs: 25_000,
      nowFn: this.nowFn,
      allowBackgroundRevalidate: allowBg,
    });

    this.searchIndex = new HotSearchIndex(this.api);

    const shouldPrewarm = cfg.enableBootPrewarm ?? !this.testMode;
    if (shouldPrewarm && !this.testMode) {
      this.scheduleBootPrewarm();
    }
  }

  getDataVersion(): number {
    return readSqliteDataVersion(this.api.getDb());
  }

  getJsonlFingerprint(force = false): string {
    const now = this.nowFn();
    if (!force && this.jsonlStatAt >= 0 && now - this.jsonlStatAt < this.statThrottleMs) {
      return this.jsonlFingerprint;
    }
    this.jsonlStatAt = now;
    try {
      const st = statSync(this.api.antigravityJsonlPath);
      this.jsonlFingerprint = `${Math.floor(st.mtimeMs)}:${st.size}`;
    } catch {
      this.jsonlFingerprint = "missing";
    }
    return this.jsonlFingerprint;
  }

  private streamFingerprint(): string {
    return `${this.getDataVersion()}:${this.getJsonlFingerprint()}:${this.globalEpoch}:${this.streamEpoch}`;
  }

  private searchFingerprint(): string {
    return `${this.getDataVersion()}:${this.globalEpoch}:${this.searchEpoch}`;
  }

  private nodeFingerprint(): string {
    return `${this.getDataVersion()}:${this.globalEpoch}:${this.nodeEpoch}`;
  }

  private overviewFingerprint(): string {
    return `${this.getDataVersion()}:${this.getJsonlFingerprint()}:${this.globalEpoch}:${this.overviewEpoch}`;
  }

  private graphFingerprint(): string {
    return `${this.getDataVersion()}:${this.globalEpoch}:${this.graphEpoch}`;
  }

  private dossierFingerprint(keyLower: string): string {
    const canonical = this.personAliasToCanonical.get(keyLower) || keyLower;
    const pEpoch = this.personEpochs.get(canonical) || this.personEpochs.get(keyLower) || 0;
    return `${this.getDataVersion()}:${this.globalEpoch}:${this.dossierEpoch}:${pEpoch}`;
  }

  async getStream(params: StreamQueryParams = {}): Promise<StreamResponse> {
    const connector = (params.connector || params.source || "all").trim() || "all";
    const source = (params.source || "").trim();
    const kind = (params.kind || "").trim();
    const q = (params.q || "").trim();
    const limit = Math.max(1, Math.min(100, Number(params.limit || 40) || 40));
    const offset = Math.max(0, Number(params.offset || 0) || 0);

    const cacheKey = `${connector}|${source}|${kind}|${limit}|${offset}|${q.toLowerCase()}`;

    return this.streamCache.getOrLoad(
      cacheKey,
      () => this.streamFingerprint(),
      () => this.api.getStream({ connector, q, limit, offset }),
    );
  }

  async search(rawQuery: string, limitOverride?: number): Promise<SearchResponse> {
    const query = (rawQuery || "").trim();
    if (!query) {
      return {
        query: "",
        ms: 0,
        memt_hits: [],
        world_hits: [],
        claim_hits: [],
        event_hits: [],
      };
    }

    const qLower = query.toLowerCase();
    const safeLimit =
      limitOverride !== undefined && Number.isFinite(limitOverride) && limitOverride > 0
        ? Math.max(1, Math.min(50, Math.floor(limitOverride)))
        : undefined;
    const cacheKey = `${qLower}|${safeLimit ?? ""}`;

    return this.searchCache.getOrLoad(
      cacheKey,
      () => this.searchFingerprint(),
      async () => {
        const liveDataVersion = this.getDataVersion();
        // Fast path: warm in-memory inverted index matches live SQLite data_version (or SWR in live server mode)
        const allowStaleMs = this.testMode ? 0 : 30_000;
        if (this.searchIndex.canServe(liveDataVersion, allowStaleMs)) {
          const indexed = this.searchIndex.search(query, safeLimit);
          if (!this.testMode && !this.searchIndex.canServe(liveDataVersion, 0)) {
            this.searchIndex.warmInBackground();
          }
          if (indexed) return indexed;
        }

        // Cold or version-bumped path: delegate to vault API and trigger background index warmup
        if (!this.testMode) {
          this.searchIndex.warmInBackground();
        }
        const res = await this.api.search(query);
        if (safeLimit !== undefined) {
          return {
            ...res,
            memt_hits: res.memt_hits.slice(0, safeLimit),
            world_hits: res.world_hits.slice(0, safeLimit),
            claim_hits: res.claim_hits.slice(0, safeLimit),
            event_hits: res.event_hits.slice(0, safeLimit),
          };
        }
        return res;
      },
    );
  }

  async getNodeDetail(id: string): Promise<NodeDetailResponse | null> {
    const cleanId = id.trim();
    if (!cleanId) return null;

    // Never cache null (404) node lookups as hits
    return this.nodeCache.getOrLoad(
      cleanId,
      () => this.nodeFingerprint(),
      () => this.api.getNodeDetail(cleanId),
      { cachePredicate: (val) => val !== null },
    );
  }

  async getPersonDossier(opts: PersonDossierQueryOptions): Promise<PersonDossierResponse> {
    const rawKey = (opts.key || "").trim();
    const keyLower = rawKey.toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 80) || 80));
    const offset = Math.max(0, Number(opts.offset ?? 0) || 0);
    const channel = (opts.channel || "all").trim() || "all";
    const q = (opts.q || "").trim();

    if (!rawKey) {
      // Delegate directly so vault-api throws exact BadRequestError
      return this.api.getPersonDossier(opts);
    }

    const cacheKey = `${keyLower}|${limit}|${offset}|${channel.toLowerCase()}|${q.toLowerCase()}`;

    const res = await this.dossierCache.getOrLoad(
      cacheKey,
      () => this.dossierFingerprint(keyLower),
      () =>
        this.api.getPersonDossier({
          key: rawKey,
          limit,
          offset,
          channel,
          q,
        }),
    );

    const canonicalKey = res?.person?.key ? String(res.person.key).trim().toLowerCase() : "";
    if (canonicalKey) {
      this.personAliasToCanonical.set(keyLower, canonicalKey);
      this.personAliasToCanonical.set(canonicalKey, canonicalKey);
    }
    return res;
  }

  async getOverview(): Promise<OverviewResponse> {
    return this.overviewCache.getOrLoad(
      "overview",
      () => this.overviewFingerprint(),
      () => this.api.getOverview(),
    );
  }

  async getGraph(params: GraphQueryParams = {}): Promise<GraphResponse> {
    const limit = Math.max(20, Math.min(400, Number(params.limit || 180) || 180));
    const kind = (params.kind || "all").trim().toLowerCase() || "all";
    const q = (params.q || "").trim().toLowerCase();
    const cacheKey = `${limit}|${kind}|${q}`;

    return this.graphCache.getOrLoad(
      cacheKey,
      () => this.graphFingerprint(),
      () => this.api.getGraph({ limit, kind, q }),
    );
  }

  invalidatePerson(rawKey?: string): void {
    const keyLower = (rawKey || "").trim().toLowerCase();
    if (!keyLower) {
      this.dossierEpoch += 1;
      this.dossierCache.clear();
      return;
    }
    const canonical = this.personAliasToCanonical.get(keyLower) || keyLower;
    const nextEpoch = Math.max(
      this.personEpochs.get(keyLower) || 0,
      this.personEpochs.get(canonical) || 0,
    ) + 1;
    this.personEpochs.set(keyLower, nextEpoch);
    this.personEpochs.set(canonical, nextEpoch);

    // Collect all aliases mapped to this canonical person
    const matchingKeys = new Set<string>([keyLower, canonical]);
    for (const [alias, canon] of this.personAliasToCanonical.entries()) {
      if (canon === canonical || alias === keyLower) {
        matchingKeys.add(alias);
      }
    }
    this.dossierCache.deleteWhere((cacheKey) => {
      const k = cacheKey.split("|", 1)[0];
      return matchingKeys.has(k);
    });
  }

  invalidate(scope?: string): void {
    const normalized = (scope || "all").trim().toLowerCase();
    if (!normalized || normalized === "all" || normalized === "*") {
      this.globalEpoch += 1;
      this.jsonlStatAt = -1;
      this.streamCache.clear();
      this.searchCache.clear();
      this.nodeCache.clear();
      this.dossierCache.clear();
      this.overviewCache.clear();
      this.graphCache.clear();
      this.searchIndex.invalidate();
      return;
    }

    if (normalized === "stream") {
      this.streamEpoch += 1;
      this.jsonlStatAt = -1;
      this.streamCache.clear();
      return;
    }

    if (normalized === "search") {
      this.searchEpoch += 1;
      this.searchCache.clear();
      this.searchIndex.invalidate();
      return;
    }

    if (normalized === "node" || normalized === "nodes") {
      this.nodeEpoch += 1;
      this.nodeCache.clear();
      return;
    }
    if (normalized.startsWith("node:")) {
      const targetId = (scope || "").slice(5).trim();
      if (targetId) this.nodeCache.delete(targetId);
      return;
    }

    if (normalized === "dossier" || normalized === "people" || normalized === "dossiers") {
      this.dossierEpoch += 1;
      this.dossierCache.clear();
      return;
    }
    if (normalized.startsWith("dossier:") || normalized.startsWith("person:")) {
      const personKey = normalized.slice(normalized.indexOf(":") + 1).trim();
      this.invalidatePerson(personKey);
      return;
    }

    if (normalized === "overview") {
      this.overviewEpoch += 1;
      this.jsonlStatAt = -1;
      this.overviewCache.clear();
      return;
    }

    if (normalized === "graph") {
      this.graphEpoch += 1;
      this.graphCache.clear();
      return;
    }

    // Unknown scope: safe fallback to global invalidation
    this.globalEpoch += 1;
    this.streamCache.clear();
    this.searchCache.clear();
    this.nodeCache.clear();
    this.dossierCache.clear();
    this.overviewCache.clear();
    this.graphCache.clear();
  }

  getStats() {
    return {
      dataVersion: this.getDataVersion(),
      jsonlFingerprint: this.jsonlFingerprint,
      searchIndex: this.searchIndex.getStats(),
      caches: {
        stream: this.streamCache.getStats(),
        search: this.searchCache.getStats(),
        node: this.nodeCache.getStats(),
        dossier: this.dossierCache.getStats(),
        overview: this.overviewCache.getStats(),
        graph: this.graphCache.getStats(),
      },
    };
  }

  private scheduleBootPrewarm(): void {
    if (this.closed || this.prewarmTimer !== null) return;
    this.prewarmTimer = setTimeout(() => {
      this.prewarmTimer = null;
      if (this.closed) return;
      void this.runStaggeredPrewarm();
    }, this.prewarmDelayMs);
    if (typeof (this.prewarmTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.prewarmTimer as unknown as { unref: () => void }).unref();
    }
  }

  private sleepUnref(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      this.prewarmStepTimer = setTimeout(() => {
        this.prewarmStepTimer = null;
        resolve();
      }, ms);
      if (typeof (this.prewarmStepTimer as unknown as { unref?: () => void }).unref === "function") {
        (this.prewarmStepTimer as unknown as { unref: () => void }).unref();
      }
    });
  }

  async runStaggeredPrewarm(): Promise<void> {
    if (this.closed) return;

    const steps: Array<() => Promise<unknown>> = [
      () => this.searchIndex.rebuild(),
      () => this.getOverview(),
      () => this.getGraph({ limit: 150, kind: "all", q: "" }),
      () => this.getGraph({ limit: 180, kind: "all", q: "" }),
      () => this.getStream({ connector: "all", q: "", limit: 50, offset: 0 }),
      () => this.getStream({ connector: "all", q: "", limit: 40, offset: 0 }),
    ];

    for (const step of steps) {
      if (this.closed) return;
      try {
        await step();
      } catch {
        // fail-soft prewarm
      }
      await this.sleepUnref(this.prewarmSpacingMs);
    }

    if (this.closed) return;

    // Collect top 15 Priority / Today people keys
    const personKeys: string[] = [];
    const seenKeys = new Set<string>();
    const addKey = (raw: unknown) => {
      const k = String(raw || "").trim().toLowerCase();
      if (!k || seenKeys.has(k) || personKeys.length >= 15) return;
      seenKeys.add(k);
      personKeys.push(k);
    };

    try {
      const today = await this.api.getToday({ includeNoise: false });
      const inboxItems = Array.isArray(today?.inbox) ? today.inbox : [];
      for (const item of inboxItems) {
        if ((item as { person_key?: string }).person_key) {
          addKey((item as { person_key?: string }).person_key);
        }
      }
    } catch {
      // fail-soft
    }

    try {
      const peopleRes = await this.api.listPeople({ limit: 25 });
      for (const p of peopleRes?.items || []) {
        addKey(p.key);
      }
    } catch {
      // fail-soft
    }

    for (const key of personKeys) {
      if (this.closed) return;
      try {
        await this.getPersonDossier({
          key,
          limit: 80,
          offset: 0,
          channel: "all",
          q: "",
        });
      } catch {
        // fail-soft per person
      }
      await this.sleepUnref(this.prewarmSpacingMs);
    }
  }

  close(): void {
    this.closed = true;
    if (this.prewarmTimer !== null) {
      clearTimeout(this.prewarmTimer);
      this.prewarmTimer = null;
    }
    if (this.prewarmStepTimer !== null) {
      clearTimeout(this.prewarmStepTimer);
      this.prewarmStepTimer = null;
    }
    this.searchIndex.close();
  }
}
