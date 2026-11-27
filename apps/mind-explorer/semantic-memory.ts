import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KizukiAgentBoardApi } from "./agent-board-api.ts";
import type { KizukiBoardMindBridge } from "./board-mind-bridge.ts";
import type { CodexItem, KizukiCodexApi } from "./codex-api.ts";
import {
  DEFAULT_EMBED_MODEL,
  DEFAULT_EMBED_URL,
  EMBED_DIMS,
  stripEmDashesSafe,
  type FetchLike,
} from "./cross-pollinate.ts";
import { loadCanonicalPersonCards } from "./people-intel.ts";
import type { KizukiTasteApi, TasteRule, TasteStateResponse } from "./taste-api.ts";
import type { KizukiVaultApi, MemtExperience, PersonDirectoryItem } from "./vault-api.ts";

export const SEMANTIC_DOMAINS = [
  "person",
  "memt",
  "codex",
  "taste",
  "board",
  "doc",
  "node",
] as const;

export type SemanticKind = (typeof SEMANTIC_DOMAINS)[number];

export type SemanticMatchMode = "neural" | "hybrid" | "lexical";

export type SemanticBackend = "bge-small-onnx" | "lexical-fallback";

export interface SemanticDocument {
  id: string;
  kind: SemanticKind;
  title: string;
  subtitle: string;
  snippet: string;
  text: string;
  target_view: string;
  target_ref: string;
}

export interface SemanticRecallHit {
  id: string;
  kind: SemanticKind;
  title: string;
  subtitle: string;
  snippet: string;
  score: number;
  semantic_score: number;
  lexical_score: number;
  match_mode: SemanticMatchMode;
  target_view: string;
  target_ref: string;
}

export interface SemanticRecallOptions {
  limit?: number;
  kinds?: SemanticKind[];
  minScore?: number;
}

export interface SemanticRecallResponse {
  query: string;
  backend: SemanticBackend;
  elapsed_ms: number;
  total_indexed: number;
  hits: SemanticRecallHit[];
}

export interface SemanticRelatedResponse {
  source_id: string;
  source_kind: string;
  elapsed_ms: number;
  related: SemanticRecallHit[];
}

export interface SemanticStatsResponse {
  ready: boolean;
  syncing: boolean;
  total_indexed: number;
  vectorized_count: number;
  by_kind: Record<SemanticKind, number>;
  dims: number;
  cache_path: string;
  last_synced_at: string | null;
  embed_endpoint: string;
  backend_available: boolean | null;
}

export interface SemanticSyncResult {
  total_indexed: number;
  vectorized_count: number;
  reused_count: number;
  embedded_count: number;
  failed_batches: number;
  elapsed_ms: number;
  persisted: boolean;
}

export interface SemanticMemoryConfig {
  api?: Partial<KizukiVaultApi> | null;
  codexApi?: Partial<KizukiCodexApi> | null;
  tasteApi?: (Partial<KizukiTasteApi> & { getState?: () => TasteStateResponse }) | null;
  agentBoardApi?: Partial<KizukiAgentBoardApi> | null;
  boardBridge?: Partial<KizukiBoardMindBridge> | null;
  cacheDir?: string;
  embedUrl?: string;
  model?: string;
  dims?: number;
  batchSize?: number;
  embedTimeoutMs?: number;
  maxItems?: number;
  queryCacheSize?: number;
  fetchImpl?: FetchLike;
  autoLoadDiskCache?: boolean;
  customCollector?: () => Promise<SemanticDocument[]> | SemanticDocument[];
}

interface StoredMetaItem {
  key: string;
  id: string;
  kind: SemanticKind;
  title: string;
  subtitle: string;
  snippet: string;
  lexicalText: string;
  textHash: string;
  target_view: string;
  target_ref: string;
  hasVector: boolean;
}

interface DiskCacheManifest {
  version: 1;
  model: string;
  dims: number;
  saved_at: string;
  count: number;
  items: StoredMetaItem[];
}

interface IndexedSemanticItem extends StoredMetaItem {
  titleLower: string;
  lexicalTextLower: string;
  tokens: Set<string>;
  titleTokens: Set<string>;
}

const CACHE_BASENAME = "semantic-vectors-v1";
const DEFAULT_BATCH_SIZE = 32;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ITEMS = 2500;
const DEFAULT_QUERY_CACHE_SIZE = 128;
const RRF_K = 40;
const MAX_TEXT_CHARS = 900;
const MAX_LEXICAL_TEXT_CHARS = 480;
const EMBED_BACKOFF_MS = 10_000;

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /(?:^|\/)\.env(?:\.|$)/i,
  /(?:^|\/)\.git-credentials$/i,
  /(?:^|\/)\.claude\/\.credentials\.json$/i,
  /\.kizuki\/agent-credentials/i,
  /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa)(?:\.pub)?$/i,
  /(?:^|\/)credentials\.json$/i,
  /(?:^|\/)secrets?\.(?:json|ya?ml|toml|env|txt)$/i,
  /\.pem$|\.key$|\.p12$/i,
];

const SENSITIVE_TEXT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?[P]RIVATE KEY-----/i,
  /\bs[k]-(?:live|proj|ant|or-v1)-[A-Za-z0-9_-]{20,}\b/,
  /\bg[h]p_[A-Za-z0-9]{30,}\b/,
  /\bx[o]x[baprs]-[A-Za-z0-9-]{20,}\b/,
];

export function isSemanticKind(value: string): value is SemanticKind {
  return (SEMANTIC_DOMAINS as readonly string[]).includes(value);
}

export function isTestEnvironment(): boolean {
  if (process.env.NODE_ENV === "test") return true;
  if (typeof Bun !== "undefined" && /\.test\.ts$/.test(String(Bun.main || ""))) {
    return true;
  }
  return false;
}

function assertLoopbackEmbedUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid embedUrl: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && host !== "[::1]") {
    throw new Error(`Refusing non-loopback embedUrl host: ${host}`);
  }
  return parsed.toString();
}

function cleanText(raw: unknown, maxLen = 220): string {
  const s = stripEmDashesSafe(String(raw ?? ""))
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, Math.max(1, maxLen - 3));
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:.\-/\s]+$/, "")}...`;
}

function isSensitiveDoc(pathOrId: string, text: string): boolean {
  const p = String(pathOrId || "").trim();
  for (let i = 0; i < SENSITIVE_PATH_PATTERNS.length; i += 1) {
    if (SENSITIVE_PATH_PATTERNS[i].test(p)) return true;
  }
  for (let i = 0; i < SENSITIVE_TEXT_PATTERNS.length; i += 1) {
    if (SENSITIVE_TEXT_PATTERNS[i].test(text)) return true;
  }
  return false;
}

function canonicalKey(kind: SemanticKind, id: string): string {
  return `${kind}:${id}`;
}

function computeTextHash(kind: SemanticKind, id: string, text: string): string {
  return createHash("sha256")
    .update(kind)
    .update("\0")
    .update(id)
    .update("\0")
    .update(text)
    .digest("hex")
    .slice(0, 24);
}

const FAST_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "your", "their",
  "have", "has", "had", "are", "was", "were", "will", "should", "must", "only", "when", "where",
  "what", "which", "who", "how", "why", "all", "any", "not", "but", "can", "use", "used", "using",
  "make", "made", "more", "most", "less", "very", "just", "than", "then", "also", "each", "every",
  "about", "before", "after", "between", "through", "without", "never", "always", "avoid", "prefer",
]);

function tokenizeFastIntoSet(input: string, out: Set<string>): Set<string> {
  const s = input.toLowerCase();
  const len = s.length;
  let start = -1;
  for (let i = 0; i <= len; i += 1) {
    const ch = i < len ? s.charCodeAt(i) : 32;
    const isAlnum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57);
    if (isAlnum) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const tokLen = i - start;
      if (tokLen >= 2) {
        const tok = s.slice(start, Math.min(i, start + 36));
        if (!FAST_STOPWORDS.has(tok)) {
          out.add(tok);
        }
      }
      start = -1;
    }
  }
  return out;
}

function buildQueryTokens(input: string): string[] {
  const out = tokenizeFastIntoSet(stripEmDashesSafe(input || ""), new Set<string>());
  if (out.size > 0) return Array.from(out);
  const fallback = stripEmDashesSafe(input || "")
    .toLowerCase()
    .match(/[a-z0-9]{2,}/g);
  return fallback ? Array.from(new Set(fallback)) : [];
}

function buildTokenSetFast(input: string): Set<string> {
  return tokenizeFastIntoSet(input, new Set<string>());
}

interface TopKEntry {
  idx: number;
  score: number;
}

function insertTopK(buf: TopKEntry[], k: number, idx: number, score: number): void {
  const len = buf.length;
  if (len === k && score <= buf[len - 1].score) return;
  let pos = len < k ? len : len - 1;
  if (len < k) {
    buf.push({ idx, score });
  } else {
    buf[pos].idx = idx;
    buf[pos].score = score;
  }
  while (pos > 0 && buf[pos].score > buf[pos - 1].score) {
    const tmp = buf[pos - 1];
    buf[pos - 1] = buf[pos];
    buf[pos] = tmp;
    pos -= 1;
  }
}

function l2NormalizeInto(src: ArrayLike<number>, dst: Float32Array, offset: number, dims: number): boolean {
  let normSq = 0;
  const len = Math.min(src.length, dims);
  for (let i = 0; i < len; i += 1) {
    const v = Number(src[i]) || 0;
    normSq += v * v;
  }
  if (!Number.isFinite(normSq) || normSq <= 1e-12) {
    for (let i = 0; i < dims; i += 1) {
      dst[offset + i] = 0;
    }
    return false;
  }
  const invNorm = 1 / Math.sqrt(normSq);
  for (let i = 0; i < len; i += 1) {
    dst[offset + i] = (Number(src[i]) || 0) * invNorm;
  }
  for (let i = len; i < dims; i += 1) {
    dst[offset + i] = 0;
  }
  return true;
}

function l2NormalizeCopy(src: ArrayLike<number>, dims: number): Float32Array | null {
  const out = new Float32Array(dims);
  const ok = l2NormalizeInto(src, out, 0, dims);
  return ok ? out : null;
}

function isLikelyHexHash(s: string): boolean {
  return /^[0-9a-f]{16,}$/i.test(String(s || "").trim());
}

function normalizeNodeKind(raw: unknown, fallback = "concept"): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return fallback;
  return s.replace(/^world\./, "");
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyKindCounts(): Record<SemanticKind, number> {
  return {
    person: 0,
    memt: 0,
    codex: 0,
    taste: 0,
    board: 0,
    doc: 0,
    node: 0,
  };
}

export class SemanticMemoryEngine {
  readonly embedUrl: string;
  readonly model: string;
  readonly dims: number;
  readonly batchSize: number;
  readonly embedTimeoutMs: number;
  readonly maxItems: number;
  readonly cacheDir: string;
  readonly metaCachePath: string;
  readonly binCachePath: string;

  private readonly api: Partial<KizukiVaultApi> | null;
  private readonly codexApi: Partial<KizukiCodexApi> | null;
  private readonly tasteApi: (Partial<KizukiTasteApi> & { getState?: () => TasteStateResponse }) | null;
  private readonly agentBoardApi: Partial<KizukiAgentBoardApi> | null;
  private readonly boardBridge: Partial<KizukiBoardMindBridge> | null;
  private readonly fetchImpl: FetchLike;
  private readonly queryCacheSize: number;
  private readonly customCollector?: () => Promise<SemanticDocument[]> | SemanticDocument[];

  private items: IndexedSemanticItem[] = [];
  private vectors: Float32Array = new Float32Array(0);
  private hasVector: Uint8Array = new Uint8Array(0);
  private keyToIndex = new Map<string, number>();
  private idToIndices = new Map<string, number[]>();
  private byKindCounts: Record<SemanticKind, number> = emptyKindCounts();
  private vectorizedCount = 0;

  private queryVecCache = new Map<string, Float32Array>();
  private syncing = false;
  private syncInFlight: Promise<SemanticSyncResult> | null = null;
  private lastSyncedAt: string | null = null;
  private backendAvailable: boolean | null = null;
  private unavailableUntil = 0;

  constructor(config: SemanticMemoryConfig = {}) {
    this.api = config.api ?? null;
    this.codexApi = config.codexApi ?? null;
    this.tasteApi = config.tasteApi ?? null;
    this.agentBoardApi = config.agentBoardApi ?? null;
    this.boardBridge = config.boardBridge ?? null;
    this.embedUrl = assertLoopbackEmbedUrl(config.embedUrl || DEFAULT_EMBED_URL);
    this.model = config.model || DEFAULT_EMBED_MODEL;
    this.dims = Math.max(8, Math.min(4096, Math.floor(config.dims ?? EMBED_DIMS)));
    this.batchSize = Math.max(1, Math.min(64, Math.floor(config.batchSize ?? DEFAULT_BATCH_SIZE)));
    this.embedTimeoutMs = Math.max(200, Math.floor(config.embedTimeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxItems = Math.max(10, Math.min(2500, Math.floor(config.maxItems ?? DEFAULT_MAX_ITEMS)));
    this.queryCacheSize = Math.max(8, Math.min(512, Math.floor(config.queryCacheSize ?? DEFAULT_QUERY_CACHE_SIZE)));
    this.fetchImpl = config.fetchImpl || fetch;
    this.customCollector = config.customCollector;

    this.cacheDir = config.cacheDir || join(homedir(), ".cache", "kizuki-mind-explorer");
    this.metaCachePath = join(this.cacheDir, `${CACHE_BASENAME}.json`);
    this.binCachePath = join(this.cacheDir, `${CACHE_BASENAME}.bin`);

    const shouldAutoLoad = config.autoLoadDiskCache !== false;
    if (shouldAutoLoad) {
      this.loadFromDisk();
    }
  }

  isReady(): boolean {
    return this.items.length > 0;
  }

  isSyncing(): boolean {
    return this.syncing;
  }

  clearQueryCache(): void {
    this.queryVecCache.clear();
  }

  getStats(): SemanticStatsResponse {
    return {
      ready: this.items.length > 0,
      syncing: this.syncing,
      total_indexed: this.items.length,
      vectorized_count: this.vectorizedCount,
      by_kind: { ...this.byKindCounts },
      dims: this.dims,
      cache_path: this.metaCachePath,
      last_synced_at: this.lastSyncedAt,
      embed_endpoint: this.embedUrl,
      backend_available: this.backendAvailable,
    };
  }

  loadFromDisk(): boolean {
    if (!existsSync(this.metaCachePath) || !existsSync(this.binCachePath)) {
      return false;
    }
    try {
      const rawMeta = readFileSync(this.metaCachePath, "utf8");
      const parsed = JSON.parse(rawMeta) as Partial<DiskCacheManifest>;
      if (
        !parsed ||
        parsed.version !== 1 ||
        parsed.dims !== this.dims ||
        parsed.model !== this.model ||
        !Array.isArray(parsed.items)
      ) {
        return false;
      }

      const count = parsed.items.length;
      const binBuf = readFileSync(this.binCachePath);
      const expectedBytes = count * this.dims * 4;
      if (binBuf.byteLength !== expectedBytes) {
        return false;
      }

      // Copy into an aligned ArrayBuffer to avoid unaligned Float32Array view issues
      const alignedBuf = new ArrayBuffer(expectedBytes);
      new Uint8Array(alignedBuf).set(new Uint8Array(binBuf.buffer, binBuf.byteOffset, binBuf.byteLength));
      const vectors = new Float32Array(alignedBuf);

      const hasVector = new Uint8Array(count);
      const indexed: IndexedSemanticItem[] = new Array(count);
      const keyToIndex = new Map<string, number>();
      const idToIndices = new Map<string, number[]>();
      const byKind = emptyKindCounts();
      let vectorizedCount = 0;

      for (let i = 0; i < count; i += 1) {
        const raw = parsed.items[i];
        if (!raw || !isSemanticKind(raw.kind) || !raw.id) {
          return false;
        }
        const title = String(raw.title || raw.id);
        const subtitle = String(raw.subtitle || raw.kind);
        const snippet = String(raw.snippet || "");
        const lexicalText = String(raw.lexicalText || `${title} ${subtitle} ${snippet}`);
        const key = canonicalKey(raw.kind, raw.id);
        const titleLower = title.toLowerCase();
        const lexicalTextLower = lexicalText.toLowerCase();
        const tokens = buildTokenSetFast(`${titleLower} ${subtitle.toLowerCase()} ${lexicalTextLower}`);
        const titleTokens = buildTokenSetFast(titleLower);
        const item: IndexedSemanticItem = {
          key,
          id: raw.id,
          kind: raw.kind,
          title,
          subtitle,
          snippet,
          lexicalText,
          textHash: String(raw.textHash || ""),
          target_view: String(raw.target_view || raw.kind),
          target_ref: String(raw.target_ref || raw.id),
          hasVector: Boolean(raw.hasVector),
          titleLower,
          lexicalTextLower,
          tokens,
          titleTokens,
        };

        indexed[i] = item;
        keyToIndex.set(key, i);
        const idLow = raw.id.toLowerCase();
        const existingIds = idToIndices.get(idLow);
        if (existingIds) existingIds.push(i);
        else idToIndices.set(idLow, [i]);

        byKind[raw.kind] += 1;
        if (item.hasVector) {
          // Ensure loaded vectors are unit-normalized and non-zero
          let normSq = 0;
          const base = i * this.dims;
          for (let d = 0; d < this.dims; d += 1) {
            const v = vectors[base + d];
            normSq += v * v;
          }
          if (normSq > 1e-10) {
            hasVector[i] = 1;
            vectorizedCount += 1;
          } else {
            item.hasVector = false;
            hasVector[i] = 0;
          }
        }
      }

      this.items = indexed;
      this.vectors = vectors;
      this.hasVector = hasVector;
      this.keyToIndex = keyToIndex;
      this.idToIndices = idToIndices;
      this.byKindCounts = byKind;
      this.vectorizedCount = vectorizedCount;
      this.lastSyncedAt = typeof parsed.saved_at === "string" ? parsed.saved_at : null;
      return true;
    } catch {
      return false;
    }
  }

  saveToDisk(): boolean {
    try {
      mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(this.cacheDir, 0o700);
      } catch {
        // best-effort permission tightening
      }

      const suffix = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tmpBin = `${this.binCachePath}${suffix}`;
      const tmpMeta = `${this.metaCachePath}${suffix}`;

      const savedAt = this.lastSyncedAt || new Date().toISOString();
      const manifest: DiskCacheManifest = {
        version: 1,
        model: this.model,
        dims: this.dims,
        saved_at: savedAt,
        count: this.items.length,
        items: this.items.map((it) => ({
          key: it.key,
          id: it.id,
          kind: it.kind,
          title: it.title,
          subtitle: it.subtitle,
          snippet: it.snippet,
          lexicalText: it.lexicalText,
          textHash: it.textHash,
          target_view: it.target_view,
          target_ref: it.target_ref,
          hasVector: it.hasVector,
        })),
      };

      const binBytes = Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength);

      try {
        writeFileSync(tmpBin, binBytes, { mode: 0o600 });
        chmodSync(tmpBin, 0o600);
        writeFileSync(tmpMeta, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
        chmodSync(tmpMeta, 0o600);

        renameSync(tmpBin, this.binCachePath);
        renameSync(tmpMeta, this.metaCachePath);
        try {
          chmodSync(this.binCachePath, 0o600);
          chmodSync(this.metaCachePath, 0o600);
        } catch {
          // ignore on restricted filesystems
        }
        return true;
      } catch (err) {
        for (const p of [tmpBin, tmpMeta]) {
          try {
            if (existsSync(p)) unlinkSync(p);
          } catch {
            // ignore cleanup error
          }
        }
        throw err;
      }
    } catch {
      return false;
    }
  }

  private async embedTextsBatch(texts: string[]): Promise<Array<Float32Array | null>> {
    if (texts.length === 0) return [];
    const now = Date.now();
    if (this.unavailableUntil > now) {
      return texts.map(() => null);
    }

    try {
      const resp = await this.fetchImpl(this.embedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
        signal: AbortSignal.timeout(this.embedTimeoutMs),
      });
      if (!resp.ok) {
        throw new Error(`Embedder HTTP ${resp.status}`);
      }
      const json = (await resp.json()) as {
        data?: Array<{ index?: number; embedding?: number[] }>;
      };
      if (!json || !Array.isArray(json.data)) {
        throw new Error("Malformed embedding response");
      }

      this.backendAvailable = true;
      this.unavailableUntil = 0;

      const out: Array<Float32Array | null> = new Array(texts.length).fill(null);
      for (let i = 0; i < json.data.length; i += 1) {
        const entry = json.data[i];
        const idx = typeof entry?.index === "number" ? entry.index : i;
        if (idx < 0 || idx >= texts.length || !Array.isArray(entry?.embedding)) continue;
        const normalized = l2NormalizeCopy(entry.embedding, this.dims);
        if (normalized) {
          out[idx] = normalized;
        }
      }
      return out;
    } catch {
      this.backendAvailable = false;
      this.unavailableUntil = Date.now() + EMBED_BACKOFF_MS;
      return texts.map(() => null);
    }
  }

  private getCachedQueryVector(normQuery: string): Float32Array | null {
    const hit = this.queryVecCache.get(normQuery);
    if (!hit) return null;
    this.queryVecCache.delete(normQuery);
    this.queryVecCache.set(normQuery, hit);
    return hit;
  }

  private setCachedQueryVector(normQuery: string, vec: Float32Array): void {
    if (this.queryVecCache.has(normQuery)) {
      this.queryVecCache.delete(normQuery);
    } else if (this.queryVecCache.size >= this.queryCacheSize) {
      const oldest = this.queryVecCache.keys().next().value;
      if (oldest !== undefined) {
        this.queryVecCache.delete(oldest);
      }
    }
    this.queryVecCache.set(normQuery, vec);
  }

  private async embedQuery(query: string): Promise<Float32Array | null> {
    const norm = cleanText(query, 512).toLowerCase();
    if (!norm) return null;

    const cached = this.getCachedQueryVector(norm);
    if (cached) return cached;

    const res = await this.embedTextsBatch([norm]);
    const vec = res[0] || null;
    if (vec) {
      this.setCachedQueryVector(norm, vec);
    }
    return vec;
  }

  async collectDocuments(): Promise<SemanticDocument[]> {
    if (this.customCollector) {
      const rawDocs = await this.customCollector();
      return this.sanitizeAndCapDocuments(rawDocs);
    }

    const [peopleDocs, memtDocs, codexDocs, tasteDocs, boardDocs, vaultDocs, nodeDocs] =
      await Promise.all([
        this.collectPeopleDocs(),
        this.collectMemtDocs(),
        this.collectCodexDocs(),
        this.collectTasteDocs(),
        this.collectBoardDocs(),
        this.collectVaultDocs(),
        this.collectNodeDocs(),
      ]);

    const combined: SemanticDocument[] = [
      ...peopleDocs,
      ...memtDocs,
      ...codexDocs,
      ...tasteDocs,
      ...boardDocs,
      ...vaultDocs,
      ...nodeDocs,
    ];

    return this.sanitizeAndCapDocuments(combined);
  }

  private sanitizeAndCapDocuments(docs: SemanticDocument[]): SemanticDocument[] {
    const out: SemanticDocument[] = [];
    const seen = new Set<string>();

    for (let i = 0; i < docs.length; i += 1) {
      if (out.length >= this.maxItems) break;
      const d = docs[i];
      if (!d || !d.id || !isSemanticKind(d.kind)) continue;
      const key = canonicalKey(d.kind, d.id);
      if (seen.has(key)) continue;

      const text = cleanText(d.text, MAX_TEXT_CHARS);
      if (!text || isSensitiveDoc(d.id, text) || isSensitiveDoc(d.target_ref, text)) {
        continue;
      }

      seen.add(key);
      out.push({
        id: String(d.id),
        kind: d.kind,
        title: cleanText(d.title || d.id, 140),
        subtitle: cleanText(d.subtitle || d.kind, 140),
        snippet: cleanText(d.snippet || text, 220),
        text,
        target_view: String(d.target_view || d.kind),
        target_ref: String(d.target_ref || d.id),
      });
    }

    return out;
  }

  private async collectPeopleDocs(): Promise<SemanticDocument[]> {
    if (!this.api || typeof this.api.listPeople !== "function") return [];
    const docs: SemanticDocument[] = [];
    const seen = new Set<string>();

    const [peopleRes, canonicalRes] = await Promise.all([
      this.api.listPeople({ limit: 250 }).catch(() => null),
      this.api.vaultPath
        ? loadCanonicalPersonCards({
            vaultPath: this.api.vaultPath,
            lifeosPeopleDir: this.api.lifeosPeopleDir,
            relationshipsDir: this.api.relationshipsDir,
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const cardBioBySlug = new Map<string, string>();
    if (canonicalRes?.cards) {
      for (const card of canonicalRes.cards) {
        const slug = String(card.slug || "").toLowerCase();
        if (!slug) continue;
        const notes = [
          card.world_model?.canonical_read || "",
          ...(card.world_model?.aliases || []),
          card.world_model?.role || "",
          card.world_model?.org || "",
        ]
          .filter(Boolean)
          .join(". ");
        if (notes) cardBioBySlug.set(slug, notes);
      }
    }

    const items: PersonDirectoryItem[] = peopleRes?.items || [];
    for (let i = 0; i < items.length && docs.length < 250; i += 1) {
      const p = items[i];
      const key = String(p.key || "").trim();
      if (!key || seen.has(key.toLowerCase())) continue;
      seen.add(key.toLowerCase());

      const name = cleanText(p.name || key, 100);
      const roleOrg = [p.role, p.org].filter(Boolean).join(" at ");
      const rel = [p.relationship_tier, p.relationship_state, p.trajectory].filter(Boolean).join(" / ");
      const channels = Array.isArray(p.channels) ? p.channels.slice(0, 6).join(", ") : "";
      const bio = cardBioBySlug.get(key.toLowerCase()) || "";
      const notes = cleanText(p.preview || p.last_snippet || bio, 220);
      const subtitle = cleanText([roleOrg, p.relationship_tier].filter(Boolean).join(" / ") || "Person", 140);

      const textParts = [
        `Person: ${name}.`,
        roleOrg ? `Role: ${roleOrg}.` : "",
        rel ? `Relationship: ${rel}.` : "",
        channels ? `Channels: ${channels}.` : "",
        notes ? `Notes: ${notes}.` : "",
        bio && bio !== notes ? `Context: ${cleanText(bio, 260)}.` : "",
      ].filter(Boolean);

      docs.push({
        id: key,
        kind: "person",
        title: name,
        subtitle,
        snippet: notes || subtitle,
        text: textParts.join(" "),
        target_view: "people",
        target_ref: key,
      });
    }

    return docs;
  }

  private async collectMemtDocs(): Promise<SemanticDocument[]> {
    if (!this.api || typeof this.api.getMemtExperiences !== "function") return [];
    const list: MemtExperience[] = await this.api.getMemtExperiences(200).catch(() => []);
    const docs: SemanticDocument[] = [];

    for (let i = 0; i < list.length && docs.length < 200; i += 1) {
      const m = list[i];
      if (!m?.id) continue;
      const domain = cleanText(m.domain || "general", 60);
      const condition = cleanText(m.condition || m.id, 180);
      const recommendation = cleanText(m.recommendation || "", 260);
      const outcome = cleanText(m.outcome || "recorded", 60);
      const verification = cleanText(m.verification || "", 160);

      docs.push({
        id: m.id,
        kind: "memt",
        title: cleanText(condition, 140),
        subtitle: `${domain} / ${outcome}`,
        snippet: cleanText(recommendation || condition, 220),
        text: [
          `MemT lesson (${domain}):`,
          `Condition: ${condition}.`,
          recommendation ? `Recommendation: ${recommendation}.` : "",
          outcome ? `Outcome: ${outcome}.` : "",
          verification ? `Verification: ${verification}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        target_view: "memt",
        target_ref: m.id,
      });
    }

    return docs;
  }

  private async collectCodexDocs(): Promise<SemanticDocument[]> {
    if (!this.codexApi || typeof this.codexApi.getCodex !== "function") return [];
    let items: CodexItem[] = [];
    try {
      const res = this.codexApi.getCodex({ includeArchived: false });
      items = Array.isArray(res?.items) ? res.items : [];
    } catch {
      return [];
    }

    const docs: SemanticDocument[] = [];
    for (let i = 0; i < items.length && docs.length < 300; i += 1) {
      const item = items[i];
      if (!item?.id) continue;
      const title = cleanText(item.title || item.id, 140);
      const section = cleanText(item.section || "codex", 40);
      const domain = cleanText(item.domain || "general", 60);
      const summary = cleanText(item.summary || item.subtitle || "", 240);
      const tags = Array.isArray(item.tags) ? item.tags.slice(0, 10).join(", ") : "";

      docs.push({
        id: item.id,
        kind: "codex",
        title,
        subtitle: `${section} / ${domain}`,
        snippet: summary || title,
        text: [
          `Codex ${section} (${domain}): ${title}.`,
          item.subtitle ? `${cleanText(item.subtitle, 160)}.` : "",
          summary ? `${summary}.` : "",
          item.thesis ? `Thesis: ${cleanText(item.thesis, 180)}.` : "",
          item.anti_pattern ? `Anti-pattern: ${cleanText(item.anti_pattern, 160)}.` : "",
          tags ? `Tags: ${tags}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        target_view: "codex",
        target_ref: item.id,
      });
    }

    return docs;
  }

  private async collectTasteDocs(): Promise<SemanticDocument[]> {
    if (!this.tasteApi) return [];
    let state: TasteStateResponse | null = null;
    try {
      if (typeof this.tasteApi.getTasteState === "function") {
        state = this.tasteApi.getTasteState();
      } else if (typeof this.tasteApi.getState === "function") {
        state = this.tasteApi.getState();
      }
    } catch {
      return [];
    }
    if (!state) return [];

    const docs: SemanticDocument[] = [];
    const rules: TasteRule[] = [
      ...(state.rules?.prefer || []),
      ...(state.rules?.avoid || []),
    ];

    for (let i = 0; i < rules.length && docs.length < 300; i += 1) {
      const r = rules[i];
      if (!r?.id) continue;
      const domain = cleanText(r.domain || "taste", 50);
      const polarity = cleanText(r.polarity || "prefer", 20);
      const rule = cleanText(r.rule || "", 200);
      const reason = cleanText(r.reason || "", 220);

      docs.push({
        id: r.id,
        kind: "taste",
        title: cleanText(`${polarity.toUpperCase()}: ${rule}`, 140),
        subtitle: `${domain} / ${polarity}`,
        snippet: reason || rule,
        text: [
          `Taste rule (${domain}, ${polarity}): ${rule}.`,
          reason ? `Reason: ${reason}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
        target_view: "taste",
        target_ref: r.id,
      });
    }

    return docs;
  }

  private async collectBoardDocs(): Promise<SemanticDocument[]> {
    if (!this.agentBoardApi) return [];
    const docs: SemanticDocument[] = [];

    if (typeof this.agentBoardApi.getDb === "function") {
      try {
        const db = this.agentBoardApi.getDb();
        const rows = db
          .query(
            `SELECT id, channel, by_actor, by_profile, text_lower, replies, at, created_at, data
             FROM board_messages
             WHERE deleted = 0 AND re IS NULL
             ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, id DESC
             LIMIT 300`,
          )
          .all() as Array<{
          id: number;
          channel: string;
          by_actor: string;
          by_profile: string | null;
          text_lower: string;
          replies: number;
          at: number | null;
          created_at: number;
          data: string;
        }>;

        for (let i = 0; i < rows.length && docs.length < 300; i += 1) {
          const row = rows[i];
          let rawText = row.text_lower || "";
          try {
            const parsed = JSON.parse(row.data) as { text?: string };
            if (typeof parsed?.text === "string" && parsed.text.trim()) {
              rawText = parsed.text;
            }
          } catch {
            // use text_lower
          }

          const cleanBody = stripEmDashesSafe(rawText).replace(
            /@\[(?:local|tailscale):user:[^+\]]+(?:\+([^\]]+))?\]/g,
            (_m, slug?: string) => (slug ? `@${slug}` : "@owner"),
          );
          const firstLine =
            cleanBody
              .split(/\r?\n/)
              .map((l) => l.trim())
              .find(Boolean) || `Thread #${row.id}`;
          const title = cleanText(firstLine, 140);
          const snippet = cleanText(cleanBody, 220);
          const author = cleanText(
            row.by_profile ||
              (row.by_actor?.includes("+")
                ? row.by_actor.split("+").slice(1).join("+")
                : row.by_actor || "agent"),
            60,
          );
          const channel = cleanText(row.channel || "box", 40);

          docs.push({
            id: String(row.id),
            kind: "board",
            title,
            subtitle: `#${channel} / ${author}`,
            snippet,
            text: `Agent Board #${channel} by ${author}: ${title}. ${cleanText(cleanBody, 480)}`,
            target_view: "board",
            target_ref: String(row.id),
          });
        }
        return docs;
      } catch {
        // fall through to getFeed fallback
      }
    }

    if (typeof this.agentBoardApi.getFeed === "function") {
      try {
        const feed = this.agentBoardApi.getFeed({ limit: 300 }) as unknown as {
          items?: Array<{
            id?: string | number;
            channel?: string;
            title?: string;
            text?: string;
            snippet?: string;
            by?: string;
            author?: string;
          }>;
        };
        const items = Array.isArray(feed?.items) ? feed.items : [];
        for (let i = 0; i < items.length && docs.length < 300; i += 1) {
          const item = items[i];
          if (!item?.id) continue;
          const channel = cleanText(item.channel || "box", 40);
          const author = cleanText(item.by || item.author || "agent", 60);
          const body = cleanText(item.text || item.snippet || item.title || "", 480);
          const title = cleanText(item.title || body || `Thread #${item.id}`, 140);
          docs.push({
            id: String(item.id),
            kind: "board",
            title,
            subtitle: `#${channel} / ${author}`,
            snippet: cleanText(item.snippet || body, 220),
            text: `Agent Board #${channel} by ${author}: ${title}. ${body}`,
            target_view: "board",
            target_ref: String(item.id),
          });
        }
      } catch {
        // fail-soft
      }
    }

    return docs;
  }

  private async collectVaultDocs(): Promise<SemanticDocument[]> {
    if (!this.api || typeof this.api.listDocs !== "function") return [];
    const docs: SemanticDocument[] = [];
    const seen = new Set<string>();

    // listDocs caps each page at 200 items, so fetch up to two pages (400 total recent docs)
    const firstPage = await this.api
      .listDocs({ category: "all", limit: 200, offset: 0, sort: "recent" })
      .catch(() => null);
    const items = [...(firstPage?.items || [])];

    if (items.length >= 200) {
      const secondPage = await this.api
        .listDocs({ category: "all", limit: 200, offset: 200, sort: "recent" })
        .catch(() => null);
      if (secondPage?.items?.length) {
        items.push(...secondPage.items);
      }
    }

    for (let i = 0; i < items.length && docs.length < 400; i += 1) {
      const d = items[i];
      if (!d?.path || seen.has(d.path)) continue;
      if (isSensitiveDoc(d.path, d.excerpt || "")) continue;
      seen.add(d.path);

      const title = cleanText(d.title || d.path, 140);
      const category = cleanText(d.category || "doc", 40);
      const excerpt = cleanText(d.excerpt || "", 260);

      docs.push({
        id: d.path,
        kind: "doc",
        title,
        subtitle: `${category} / ${cleanText(d.path, 90)}`,
        snippet: excerpt || title,
        text: `Document (${category}) ${title} [${d.path}]: ${excerpt}`,
        target_view: "vault",
        target_ref: d.path,
      });
    }

    return docs;
  }

  private async collectNodeDocs(): Promise<SemanticDocument[]> {
    if (!this.api || typeof this.api.getDb !== "function") return [];
    const docs: SemanticDocument[] = [];
    const seen = new Set<string>();

    try {
      const db = this.api.getDb();

      try {
        const worldRows = db
          .query(
            `SELECT wc.handle_id,
                    wc.kind,
                    wc.summary,
                    COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                    MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                             THEN json_extract(s.payload, '$.object.value') END) AS sem_label
             FROM world_consolidation wc
             LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
             LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
             GROUP BY wc.basis_digest
             ORDER BY CASE WHEN wc.status = 'complete' THEN 0 ELSE 1 END, updated_at DESC
             LIMIT 400`,
          )
          .all() as Array<{
          handle_id: string;
          kind: string | null;
          summary: string | null;
          updated_at: string | null;
          sem_label: string | null;
        }>;

        for (let i = 0; i < worldRows.length && docs.length < 400; i += 1) {
          const r = worldRows[i];
          if (!r?.handle_id || seen.has(r.handle_id)) continue;
          seen.add(r.handle_id);

          const summary = cleanText(r.summary || "", 280);
          const semLabel =
            r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanText(r.sem_label, 100) : "";
          const label = semLabel || cleanText(summary.split(/[.!?]/)[0] || r.handle_id, 100);
          const nodeKind = normalizeNodeKind(r.kind, "concept");

          docs.push({
            id: r.handle_id,
            kind: "node",
            title: label,
            subtitle: `world / ${nodeKind}`,
            snippet: summary || label,
            text: `World node (${nodeKind}): ${label}. ${summary}`,
            target_view: "graph",
            target_ref: r.handle_id,
          });
        }
      } catch {
        // table absent in minimal fixtures
      }

      if (docs.length < 400) {
        try {
          const semRows = db
            .query(
              `SELECT s.subject_id,
                      MAX(CASE WHEN s.predicate IN ('situation.label','concept.label','identity.display_name','artifact.label')
                               THEN json_extract(s.payload, '$.object.value') END) AS label,
                      MAX(CASE WHEN s.predicate = 'world.kind'
                               THEN json_extract(s.payload, '$.object.ref.id') END) AS world_kind,
                      MAX(CASE WHEN s.predicate IN ('concept.definition','situation.objective','situation.blocker','situation.commitment','situation.change','project.status')
                               THEN json_extract(s.payload, '$.object.value') END) AS detail_text,
                      MAX(c.created_at) AS updated_at
               FROM claim_v2_semantics s
               JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
               WHERE s.subject_id IS NOT NULL
               GROUP BY s.subject_id
               HAVING label IS NOT NULL OR detail_text IS NOT NULL
               ORDER BY updated_at DESC
               LIMIT ?`,
            )
            .all(400 - docs.length) as Array<{
            subject_id: string;
            label: string | null;
            world_kind: string | null;
            detail_text: string | null;
            updated_at: string | null;
          }>;

          for (let i = 0; i < semRows.length && docs.length < 400; i += 1) {
            const r = semRows[i];
            if (!r?.subject_id || seen.has(r.subject_id)) continue;
            const label =
              (r.label && !isLikelyHexHash(r.label) ? cleanText(r.label, 100) : "") ||
              (r.detail_text ? cleanText(r.detail_text, 80) : "");
            if (!label) continue;
            seen.add(r.subject_id);

            const nodeKind = normalizeNodeKind(r.world_kind, "situation");
            const summary = cleanText(r.detail_text || label, 260);
            docs.push({
              id: r.subject_id,
              kind: "node",
              title: label,
              subtitle: `world / ${nodeKind}`,
              snippet: summary,
              text: `World node (${nodeKind}): ${label}. ${summary}`,
              target_view: "graph",
              target_ref: r.subject_id,
            });
          }
        } catch {
          // fail-soft
        }
      }
    } catch {
      // fail-soft
    }

    return docs;
  }

  syncInBackground(): void {
    if (this.syncInFlight) return;
    void this.sync().catch(() => {
      // fail-soft background sync
    });
  }

  async sync(): Promise<SemanticSyncResult> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }

    const task = (async (): Promise<SemanticSyncResult> => {
      const t0 = performance.now();
      this.syncing = true;
      try {
        const docs = await this.collectDocuments();
        const count = docs.length;
        const nextVectors = new Float32Array(count * this.dims);
        const nextHasVector = new Uint8Array(count);
        const nextItems: IndexedSemanticItem[] = new Array(count);
        const nextKeyToIndex = new Map<string, number>();
        const nextIdToIndices = new Map<string, number[]>();
        const nextByKind = emptyKindCounts();

        const missingPositions: number[] = [];
        const missingTexts: string[] = [];
        let reusedCount = 0;
        let vectorizedCount = 0;

        for (let i = 0; i < count; i += 1) {
          const doc = docs[i];
          const key = canonicalKey(doc.kind, doc.id);
          const textHash = computeTextHash(doc.kind, doc.id, doc.text);
          const lexicalText = cleanText(doc.text, MAX_LEXICAL_TEXT_CHARS);

          const titleLower = doc.title.toLowerCase();
          const lexicalTextLower = lexicalText.toLowerCase();
          const item: IndexedSemanticItem = {
            key,
            id: doc.id,
            kind: doc.kind,
            title: doc.title,
            subtitle: doc.subtitle,
            snippet: doc.snippet,
            lexicalText,
            textHash,
            target_view: doc.target_view,
            target_ref: doc.target_ref,
            hasVector: false,
            titleLower,
            lexicalTextLower,
            tokens: buildTokenSetFast(`${titleLower} ${doc.subtitle.toLowerCase()} ${lexicalTextLower}`),
            titleTokens: buildTokenSetFast(titleLower),
          };

          const prevIdx = this.keyToIndex.get(key);
          if (
            prevIdx !== undefined &&
            this.hasVector[prevIdx] === 1 &&
            this.items[prevIdx]?.textHash === textHash
          ) {
            const srcStart = prevIdx * this.dims;
            const dstStart = i * this.dims;
            nextVectors.set(this.vectors.subarray(srcStart, srcStart + this.dims), dstStart);
            nextHasVector[i] = 1;
            item.hasVector = true;
            reusedCount += 1;
            vectorizedCount += 1;
          } else {
            missingPositions.push(i);
            missingTexts.push(doc.text);
          }

          nextItems[i] = item;
          nextKeyToIndex.set(key, i);
          const idLow = doc.id.toLowerCase();
          const bucket = nextIdToIndices.get(idLow);
          if (bucket) bucket.push(i);
          else nextIdToIndices.set(idLow, [i]);
          nextByKind[doc.kind] += 1;
        }

        // Embed missing/changed items in sequential batches of 32, yielding between batches
        let embeddedCount = 0;
        let failedBatches = 0;
        for (let offset = 0; offset < missingPositions.length; offset += this.batchSize) {
          const batchTexts = missingTexts.slice(offset, offset + this.batchSize);
          const batchVectors = await this.embedTextsBatch(batchTexts);
          let batchSuccess = 0;

          for (let j = 0; j < batchTexts.length; j += 1) {
            const vec = batchVectors[j];
            if (!vec) continue;
            const pos = missingPositions[offset + j];
            nextVectors.set(vec, pos * this.dims);
            nextHasVector[pos] = 1;
            nextItems[pos].hasVector = true;
            embeddedCount += 1;
            vectorizedCount += 1;
            batchSuccess += 1;
          }

          if (batchSuccess === 0) {
            failedBatches += 1;
            // Stop hammering an offline embedder; remaining items stay indexed for lexical recall
            break;
          }

          if (offset + this.batchSize < missingPositions.length) {
            await yieldToEventLoop();
          }
        }

        const changed =
          embeddedCount > 0 ||
          count !== this.items.length ||
          !existsSync(this.metaCachePath) ||
          !existsSync(this.binCachePath);

        this.items = nextItems;
        this.vectors = nextVectors;
        this.hasVector = nextHasVector;
        this.keyToIndex = nextKeyToIndex;
        this.idToIndices = nextIdToIndices;
        this.byKindCounts = nextByKind;
        this.vectorizedCount = vectorizedCount;
        this.lastSyncedAt = new Date().toISOString();

        const persisted = changed ? this.saveToDisk() : true;

        return {
          total_indexed: count,
          vectorized_count: vectorizedCount,
          reused_count: reusedCount,
          embedded_count: embeddedCount,
          failed_batches: failedBatches,
          elapsed_ms: round2(performance.now() - t0),
          persisted,
        };
      } finally {
        this.syncing = false;
        this.syncInFlight = null;
      }
    })();

    this.syncInFlight = task;
    return task;
  }

  private scoreLexical(item: IndexedSemanticItem, queryLower: string, queryTokens: string[]): number {
    if (!queryLower) return 0;

    let score = 0;
    if (item.titleLower === queryLower) {
      score += 0.95;
    } else if (item.titleLower.startsWith(queryLower)) {
      score += 0.72;
    } else if (queryLower.length >= 3 && item.titleLower.includes(queryLower)) {
      score += 0.56;
    } else if (queryLower.length >= 4 && item.lexicalTextLower.includes(queryLower)) {
      score += 0.34;
    }

    if (queryTokens.length > 0) {
      let bodyHits = 0;
      let titleHits = 0;
      for (let i = 0; i < queryTokens.length; i += 1) {
        const tok = queryTokens[i];
        if (item.titleTokens.has(tok)) {
          titleHits += 1;
          bodyHits += 1;
        } else if (item.tokens.has(tok)) {
          bodyHits += 1;
        }
      }
      const tokenCoverage = bodyHits / queryTokens.length;
      const titleCoverage = titleHits / queryTokens.length;
      const tokScore = tokenCoverage * 0.62 + titleCoverage * 0.35;
      if (tokScore > score) {
        score = tokScore;
      } else if (bodyHits > 0) {
        score = Math.min(1, score + tokScore * 0.18);
      }
    }

    return Math.min(1, Math.max(0, score));
  }

  async recall(query: string, opts: SemanticRecallOptions = {}): Promise<SemanticRecallResponse> {
    const t0 = performance.now();
    const cleanedQuery = cleanText(query || "", 512);
    const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 12)));

    const allowedKinds =
      opts.kinds && opts.kinds.length > 0
        ? new Set<SemanticKind>(opts.kinds.filter((k): k is SemanticKind => isSemanticKind(k)))
        : null;

    if (!cleanedQuery || this.items.length === 0) {
      return {
        query: cleanedQuery,
        backend: this.backendAvailable === false ? "lexical-fallback" : "bge-small-onnx",
        elapsed_ms: round2(performance.now() - t0),
        total_indexed: this.items.length,
        hits: [],
      };
    }

    const queryLower = cleanedQuery.toLowerCase();
    const queryTokens = buildQueryTokens(cleanedQuery);

    const canUseVectors = this.vectorizedCount > 0;
    const queryVec = canUseVectors ? await this.embedQuery(cleanedQuery) : null;
    const backend: SemanticBackend = queryVec ? "bge-small-onnx" : "lexical-fallback";

    const n = this.items.length;
    const dims = this.dims;
    const vectors = this.vectors;
    const hasVector = this.hasVector;
    const candidateLimit = Math.max(limit * 6, 80);

    const semScores = new Float32Array(n);
    const lexScores = new Float32Array(n);
    const topSem: TopKEntry[] = [];
    const topLex: TopKEntry[] = [];

    for (let i = 0; i < n; i += 1) {
      const item = this.items[i];
      if (allowedKinds && !allowedKinds.has(item.kind)) continue;

      const lex = this.scoreLexical(item, queryLower, queryTokens);
      if (lex > 0) {
        lexScores[i] = lex;
        insertTopK(topLex, candidateLimit, i, lex);
      }

      if (queryVec && hasVector[i] === 1) {
        const base = i * dims;
        let dot = 0;
        for (let d = 0; d < dims; d += 1) {
          dot += queryVec[d] * vectors[base + d];
        }
        if (dot > 0) {
          semScores[i] = dot;
          insertTopK(topSem, candidateLimit, i, dot);
        }
      }
    }

    const lexRank = new Map<number, number>();
    for (let r = 0; r < topLex.length; r += 1) {
      lexRank.set(topLex[r].idx, r + 1);
    }

    const semRank = new Map<number, number>();
    for (let r = 0; r < topSem.length; r += 1) {
      semRank.set(topSem[r].idx, r + 1);
    }

    // Gather candidate set: union of top semantic and top lexical items
    const candidateIndices = new Set<number>();
    for (let r = 0; r < topSem.length; r += 1) {
      candidateIndices.add(topSem[r].idx);
    }
    for (let r = 0; r < topLex.length; r += 1) {
      candidateIndices.add(topLex[r].idx);
    }

    const minSemanticFloor = opts.minScore ?? 0.15;
    const maxRawHybrid = 1.15 / (RRF_K + 1) + 1.0 / (RRF_K + 1) + 0.045 + 0.025;

    const scored: Array<{ idx: number; hit: SemanticRecallHit }> = [];

    for (const idx of candidateIndices) {
      const item = this.items[idx];
      const sem = queryVec ? Math.max(0, semScores[idx]) : 0;
      const lex = lexScores[idx];

      if (!queryVec) {
        if (lex <= 0) continue;
        scored.push({
          idx,
          hit: {
            id: item.id,
            kind: item.kind,
            title: item.title,
            subtitle: item.subtitle,
            snippet: item.snippet,
            score: round4(lex),
            semantic_score: 0,
            lexical_score: round4(lex),
            match_mode: "lexical",
            target_view: item.target_view,
            target_ref: item.target_ref,
          },
        });
        continue;
      }

      if (lex <= 0 && sem < minSemanticFloor) continue;

      const sRank = semRank.get(idx);
      const lRank = lexRank.get(idx);
      const rrfSem = sRank ? 1.15 / (RRF_K + sRank) : 0;
      const rrfLex = lRank ? 1.0 / (RRF_K + lRank) : 0;

      // Boost zero-lexical-overlap conceptual matches cleanly when cosine similarity is strong
      const conceptualBoost = lex === 0 && sem >= 0.45 ? (sem - 0.4) * 0.032 : 0;
      const rawScore = rrfSem + rrfLex + sem * 0.045 + lex * 0.025 + conceptualBoost;
      const normalizedScore = Math.min(1, rawScore / maxRawHybrid);

      let matchMode: SemanticMatchMode;
      if (lex > 0 && sem >= 0.32) {
        matchMode = "hybrid";
      } else if (lex === 0 && sem > 0) {
        matchMode = "neural";
      } else if (sem >= 0.45 && sem > lex) {
        matchMode = "neural";
      } else {
        matchMode = "lexical";
      }

      scored.push({
        idx,
        hit: {
          id: item.id,
          kind: item.kind,
          title: item.title,
          subtitle: item.subtitle,
          snippet: item.snippet,
          score: round4(normalizedScore),
          semantic_score: round4(sem),
          lexical_score: round4(lex),
          match_mode: matchMode,
          target_view: item.target_view,
          target_ref: item.target_ref,
        },
      });
    }

    scored.sort((a, b) => {
      if (b.hit.score !== a.hit.score) return b.hit.score - a.hit.score;
      if (b.hit.semantic_score !== a.hit.semantic_score) {
        return b.hit.semantic_score - a.hit.semantic_score;
      }
      return b.hit.lexical_score - a.hit.lexical_score;
    });

    return {
      query: cleanedQuery,
      backend,
      elapsed_ms: round2(performance.now() - t0),
      total_indexed: this.items.length,
      hits: scored.slice(0, limit).map((entry) => entry.hit),
    };
  }

  related(id: string, kind?: string, limit = 8): SemanticRelatedResponse {
    const t0 = performance.now();
    const cleanId = String(id || "").trim();
    const cleanKind = String(kind || "").trim().toLowerCase();
    const safeLimit = Math.max(1, Math.min(30, Math.floor(limit || 8)));

    if (!cleanId || this.items.length === 0) {
      return {
        source_id: cleanId,
        source_kind: cleanKind,
        elapsed_ms: round2(performance.now() - t0),
        related: [],
      };
    }

    let srcIdx: number | undefined;
    if (cleanKind && isSemanticKind(cleanKind)) {
      srcIdx = this.keyToIndex.get(canonicalKey(cleanKind, cleanId));
    }
    if (srcIdx === undefined) {
      const candidates = this.idToIndices.get(cleanId.toLowerCase());
      if (candidates && candidates.length > 0) {
        if (cleanKind) {
          srcIdx = candidates.find((idx) => this.items[idx].kind === cleanKind) ?? candidates[0];
        } else {
          srcIdx = candidates[0];
        }
      }
    }

    if (srcIdx === undefined) {
      return {
        source_id: cleanId,
        source_kind: cleanKind,
        elapsed_ms: round2(performance.now() - t0),
        related: [],
      };
    }

    const src = this.items[srcIdx];
    const dims = this.dims;
    const vectors = this.vectors;
    const hasVector = this.hasVector;
    const useVector = hasVector[srcIdx] === 1;
    const srcOffset = srcIdx * dims;
    const srcTokens = src.tokens;

    const topRelated: Array<{ idx: number; score: number; sem: number; lex: number }> = [];

    const pushTopRelated = (idx: number, score: number, sem: number, lex: number) => {
      const len = topRelated.length;
      if (len === safeLimit && score <= topRelated[len - 1].score) return;
      let pos = len < safeLimit ? len : len - 1;
      if (len < safeLimit) {
        topRelated.push({ idx, score, sem, lex });
      } else {
        const slot = topRelated[pos];
        slot.idx = idx;
        slot.score = score;
        slot.sem = sem;
        slot.lex = lex;
      }
      while (pos > 0 && topRelated[pos].score > topRelated[pos - 1].score) {
        const tmp = topRelated[pos - 1];
        topRelated[pos - 1] = topRelated[pos];
        topRelated[pos] = tmp;
        pos -= 1;
      }
    };

    const srcKind = src.kind;
    for (let i = 0; i < this.items.length; i += 1) {
      if (i === srcIdx) continue;
      const other = this.items[i];

      if (useVector && hasVector[i] === 1) {
        const otherOffset = i * dims;
        let dot = 0;
        for (let d = 0; d < dims; d += 1) {
          dot += vectors[srcOffset + d] * vectors[otherOffset + d];
        }
        const sem = dot > 0 ? dot : 0;
        const crossDomainBonus = other.kind !== srcKind ? 0.035 : 0;
        // Fast upper-bound prune before token set iteration
        if (
          topRelated.length === safeLimit &&
          sem + 0.12 + crossDomainBonus <= topRelated[safeLimit - 1].score
        ) {
          continue;
        }

        let overlap = 0;
        if (srcTokens.size > 0 && other.tokens.size > 0) {
          for (const tok of srcTokens) {
            if (other.tokens.has(tok)) overlap += 1;
          }
        }
        const union = srcTokens.size + other.tokens.size - overlap;
        const lexSim = union > 0 ? overlap / union : 0;
        if (sem < 0.15 && lexSim <= 0) continue;

        const combined = Math.min(1, sem + lexSim * 0.12 + crossDomainBonus);
        pushTopRelated(i, combined, sem, lexSim);
      } else {
        let overlap = 0;
        if (srcTokens.size > 0 && other.tokens.size > 0) {
          for (const tok of srcTokens) {
            if (other.tokens.has(tok)) overlap += 1;
          }
        }
        if (overlap === 0) continue;
        const union = srcTokens.size + other.tokens.size - overlap;
        const lexSim = union > 0 ? overlap / union : 0;
        const crossDomainBonus = other.kind !== srcKind ? 0.02 : 0;
        const combined = Math.min(1, lexSim + crossDomainBonus);
        pushTopRelated(i, combined, 0, lexSim);
      }
    }

    const relatedHits: SemanticRecallHit[] = topRelated.map((entry) => {
      const other = this.items[entry.idx];
      const matchMode: SemanticMatchMode =
        entry.lex >= 0.08 && entry.sem >= 0.3
          ? "hybrid"
          : entry.sem > 0
            ? "neural"
            : "lexical";
      return {
        id: other.id,
        kind: other.kind,
        title: other.title,
        subtitle: other.subtitle,
        snippet: other.snippet,
        score: round4(entry.score),
        semantic_score: round4(entry.sem),
        lexical_score: round4(entry.lex),
        match_mode: matchMode,
        target_view: other.target_view,
        target_ref: other.target_ref,
      };
    });

    return {
      source_id: src.id,
      source_kind: src.kind,
      elapsed_ms: round2(performance.now() - t0),
      related: relatedHits,
    };
  }
}

declare global {
  var __kizukiSemanticMemory: SemanticMemoryEngine | undefined;
}
