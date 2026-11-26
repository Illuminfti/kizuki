import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MemTClient, MemTSession } from "./client";
import {
  defaultMemtRegistryPath,
  defaultMemtSnapshotDir,
  isPlainObject,
  normalizeSourceRefVariants,
  openMemtRegistryDb,
  sha256Hex,
  withinSensitivityCeiling,
} from "./db";
import type { MemtSensitivity } from "./db";
import { ExperienceBank } from "./experience";
import type { ExperienceRecord, ExperienceSearchHit } from "./experience";
import { CollaborationSliceStore } from "./collaboration";
import type {
  CollaborationSlice,
  CompileCollaborationSliceInput,
  PurgeCollaborationResult,
} from "./collaboration";
import { normalizeMemTModel } from "./protocol";
import type {
  MemTCapabilities,
  MemTIdentity,
  MemTModelFamily,
} from "./protocol";
import {
  MemTCustodyError,
  SnapshotCustodyRegistry,
  validateMemTSnapshotFile,
} from "./snapshot";
import type {
  InvalidateSnapshotsResult,
  MemtSnapshotRecord,
} from "./snapshot";

const MAX_SERVE_TOML_BYTES = 65_536;
const MAX_TOML_CACHE_ENTRIES = 64;

interface CachedMemtToml {
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly size: number;
  readonly ino: number;
  readonly table: Readonly<Record<string, unknown>>;
}

const memtTomlCache = new Map<string, CachedMemtToml>();

function loadMemtTomlTable(tomlPath: string): Readonly<Record<string, unknown>> {
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(tomlPath);
  } catch {
    memtTomlCache.delete(tomlPath);
    return {};
  }

  const cached = memtTomlCache.get(tomlPath);
  if (
    cached !== undefined &&
    cached.mtimeMs === st.mtimeMs &&
    cached.ctimeMs === st.ctimeMs &&
    cached.size === st.size &&
    cached.ino === st.ino
  ) {
    return cached.table;
  }

  let table: Record<string, unknown> = {};
  try {
    if (st.size <= MAX_SERVE_TOML_BYTES) {
      const parsed: unknown = Bun.TOML.parse(readFileSync(tomlPath, "utf8"));
      if (isPlainObject(parsed) && isPlainObject(parsed["memt"])) {
        table = parsed["memt"];
      }
    }
  } catch {
    table = {};
  }

  const frozen = Object.freeze({ ...table });
  if (memtTomlCache.size >= MAX_TOML_CACHE_ENTRIES) {
    const oldest = memtTomlCache.keys().next().value;
    if (oldest !== undefined) memtTomlCache.delete(oldest);
  }
  memtTomlCache.set(tomlPath, {
    mtimeMs: st.mtimeMs,
    ctimeMs: st.ctimeMs,
    size: st.size,
    ino: st.ino,
    table: frozen,
  });
  return frozen;
}

export interface MemtConfig {
  readonly enabled: boolean;
  readonly url: string | null;
  readonly apiKey: string | null;
  readonly model: MemTModelFamily | null;
  readonly probeTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly offlineBackoffMs: number;
  readonly defaultLeaseTtlSeconds: number;
  readonly snapshotDir: string;
  readonly registryPath: string;
  readonly rrfK: number;
  readonly defaultPartition: string;
}

function readBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return fallback;
  if (value < min || value > max) return fallback;
  return value;
}

function normalizeOptionalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function loadMemtConfig(
  vaultPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): MemtConfig {
  const tomlPath = join(vaultPath, ".kizuki", "serve.toml");
  const memtTable = loadMemtTomlTable(tomlPath);

  const envUrl = normalizeOptionalUrl(env["KIZUKI_MEMT_URL"]);
  const tomlUrl = normalizeOptionalUrl(memtTable["url"] ?? memtTable["endpoint"]);
  const url = envUrl ?? tomlUrl;

  const envApiKey = env["KIZUKI_MEMT_API_KEY"]?.trim();
  const tomlApiKey =
    typeof memtTable["api_key"] === "string"
      ? memtTable["api_key"].trim()
      : undefined;
  const apiKey =
    envApiKey !== undefined && envApiKey.length > 0
      ? envApiKey
      : tomlApiKey !== undefined && tomlApiKey.length > 0
        ? tomlApiKey
        : null;

  const envEnabledRaw = env["KIZUKI_MEMT_ENABLED"]?.trim().toLowerCase();
  const enabled =
    envEnabledRaw === "false" || envEnabledRaw === "0"
      ? false
      : envEnabledRaw === "true" || envEnabledRaw === "1"
        ? true
        : typeof memtTable["enabled"] === "boolean"
          ? memtTable["enabled"]
          : true;

  const model =
    normalizeMemTModel(env["KIZUKI_MEMT_MODEL"] ?? memtTable["model"]) ?? null;

  const snapshotDirRaw =
    typeof memtTable["snapshot_dir"] === "string" &&
    memtTable["snapshot_dir"].trim().length > 0
      ? memtTable["snapshot_dir"].trim()
      : defaultMemtSnapshotDir(vaultPath);

  const registryPathRaw =
    typeof memtTable["registry_path"] === "string" &&
    memtTable["registry_path"].trim().length > 0
      ? memtTable["registry_path"].trim()
      : defaultMemtRegistryPath(vaultPath);

  const defaultPartition =
    typeof memtTable["default_partition"] === "string" &&
    memtTable["default_partition"].trim().length > 0
      ? memtTable["default_partition"].trim()
      : "default";

  return Object.freeze({
    enabled,
    url,
    apiKey,
    model,
    probeTimeoutMs: readBoundedInt(memtTable["probe_timeout_ms"], 1_200, 100, 15_000),
    requestTimeoutMs: readBoundedInt(
      memtTable["request_timeout_ms"],
      20_000,
      500,
      300_000,
    ),
    offlineBackoffMs: readBoundedInt(
      memtTable["offline_backoff_ms"],
      15_000,
      500,
      300_000,
    ),
    defaultLeaseTtlSeconds: readBoundedInt(
      memtTable["lease_ttl_seconds"],
      300,
      1,
      3600,
    ),
    snapshotDir: snapshotDirRaw,
    registryPath: registryPathRaw,
    rrfK: readBoundedInt(memtTable["rrf_k"], 60, 1, 500),
    defaultPartition,
  });
}

export type System2EvidenceKind = "page" | "event" | "claim";

export interface System2EvidenceHit {
  readonly id: string;
  readonly kind: System2EvidenceKind;
  readonly title?: string;
  readonly text: string;
  readonly score: number;
  readonly sensitivity: MemtSensitivity;
  readonly taint: "clean" | "quoted";
  readonly authority?: string;
  readonly citations: readonly string[];
}

export interface MemtLatentSynthesis {
  readonly source: "memt-native-gpu" | "local-experience-distill";
  readonly text: string;
  readonly partitionKey?: string;
  readonly snapshotName?: string;
  readonly citations: readonly string[];
  readonly trustTag: "latent_synthesis_unverified" | "verified_procedure_summary";
}

export type HybridTrustTag =
  | "canon_evidence"
  | "untrusted_captured_text"
  | "verified_procedure"
  | "observed_procedure";

export interface HybridRecallItem {
  readonly id: string;
  readonly source: "system2" | "experience";
  readonly kind: System2EvidenceKind | "experience";
  readonly score: number;
  readonly system2Rank: number | null;
  readonly experienceRank: number | null;
  readonly sensitivity: MemtSensitivity;
  readonly taint: "clean" | "quoted";
  readonly trustTag: HybridTrustTag;
  readonly untrustedCapturedText: boolean;
  readonly text: string;
  readonly title?: string;
  readonly citations: readonly string[];
  readonly experience?: ExperienceRecord;
}

export interface FuseHybridRecallInput {
  readonly system2Hits: readonly System2EvidenceHit[];
  readonly experienceHits: readonly ExperienceSearchHit[];
  readonly sensitivityCeiling: MemtSensitivity;
  readonly memtSynthesis?: MemtLatentSynthesis | null;
  readonly mode?: "native-gpu" | "local-hybrid";
  readonly degraded?: readonly string[];
  readonly limit?: number;
  readonly rrfK?: number;
  readonly system2Weight?: number;
  readonly experienceWeight?: number;
}

export interface HybridRecallResult {
  readonly mode: "native-gpu" | "local-hybrid";
  readonly items: readonly HybridRecallItem[];
  readonly system2Count: number;
  readonly experienceCount: number;
  readonly synthesis: MemtLatentSynthesis | null;
  readonly degraded: readonly string[];
}

function experienceOutcomeFusionFactor(outcome: ExperienceRecord["outcome"]): number {
  switch (outcome) {
    case "verified":
      return 1.15;
    case "observed":
      return 0.95;
    case "failed":
      return 0.4;
    case "superseded":
      return 0.2;
  }
}

export function fuseHybridRecall(
  input: FuseHybridRecallInput,
): HybridRecallResult {
  const rrfK = input.rrfK ?? 60;
  const s2Weight = input.system2Weight ?? 1.0;
  const expWeight = input.experienceWeight ?? 0.9;
  const limit = Math.max(1, Math.min(200, input.limit ?? 20));

  // Pre-index eligible System-2 citations & topical anchors for cross-source corroboration
  const eligibleS2: System2EvidenceHit[] = [];
  const s2SourceRefToIndices = new Map<string, number[]>();
  const s2TopicalTextParts: string[] = [];

  for (const hit of input.system2Hits) {
    if (!withinSensitivityCeiling(hit.sensitivity, input.sensitivityCeiling)) {
      continue;
    }
    const idx = eligibleS2.length;
    eligibleS2.push(hit);
    const refs = hit.citations.length > 0 ? [hit.id, ...hit.citations] : [hit.id];
    for (const ref of refs) {
      for (const variant of normalizeSourceRefVariants(ref)) {
        const list = s2SourceRefToIndices.get(variant);
        if (list === undefined) {
          s2SourceRefToIndices.set(variant, [idx]);
        } else if (list[list.length - 1] !== idx) {
          list.push(idx);
        }
      }
    }
    if (hit.title !== undefined && hit.title.length > 0) {
      s2TopicalTextParts.push(hit.title);
    }
    if (hit.text.length > 0) {
      s2TopicalTextParts.push(hit.text.slice(0, 256));
    }
  }

  const s2TopicalHaystack =
    s2TopicalTextParts.length > 0
      ? s2TopicalTextParts.join(" ").toLowerCase()
      : "";
  const corroboratedS2Indices = new Set<number>();

  const expItems: HybridRecallItem[] = [];
  let expRank = 0;
  for (const hit of input.experienceHits) {
    const exp = hit.experience;
    if (!withinSensitivityCeiling(exp.sensitivity, input.sensitivityCeiling)) {
      continue;
    }
    expRank += 1;
    const citations =
      exp.citations.length > 0 ? [...exp.citations] : [`experience:${exp.id}`];

    // Check cross-source corroboration against System-2 evidence
    let directCorroboration = false;
    if (s2SourceRefToIndices.size > 0 && exp.citations.length > 0) {
      for (const citation of exp.citations) {
        for (const variant of normalizeSourceRefVariants(citation)) {
          const matchedS2 = s2SourceRefToIndices.get(variant);
          if (matchedS2 !== undefined) {
            directCorroboration = true;
            if (exp.outcome === "verified" || exp.outcome === "observed") {
              for (const s2Idx of matchedS2) {
                corroboratedS2Indices.add(s2Idx);
              }
            }
          }
        }
      }
    }

    let topicalCorroboration = false;
    if (!directCorroboration && s2TopicalHaystack.length > 0) {
      const domainLower = exp.domain.toLowerCase();
      const scopeLower = exp.scope_key.toLowerCase();
      if (
        (domainLower.length >= 3 && s2TopicalHaystack.includes(domainLower)) ||
        (scopeLower.length >= 3 && s2TopicalHaystack.includes(scopeLower))
      ) {
        topicalCorroboration = true;
      }
    }

    const corroborationFactor = directCorroboration
      ? 1.22
      : topicalCorroboration
        ? 1.06
        : 1.0;
    const outcomeFactor = experienceOutcomeFusionFactor(exp.outcome);
    const confidenceFactor = 0.72 + 0.28 * exp.confidence;

    const trustTag: HybridTrustTag =
      exp.outcome === "verified" ? "verified_procedure" : "observed_procedure";
    const summaryText =
      `When: ${exp.condition}\nDo: ${exp.recommendation}` +
      (exp.verification.length > 0 ? `\nVerify: ${exp.verification}` : "");
    expItems.push({
      id: `experience:${exp.id}`,
      source: "experience",
      kind: "experience",
      score:
        (expWeight / (rrfK + expRank)) *
        outcomeFactor *
        confidenceFactor *
        corroborationFactor,
      system2Rank: null,
      experienceRank: expRank,
      sensitivity: exp.sensitivity,
      taint: "clean",
      trustTag,
      untrustedCapturedText: false,
      text: summaryText,
      title: `${exp.domain}/${exp.scope_key}`,
      citations: Object.freeze(citations),
      experience: exp,
    });
  }

  const fused: HybridRecallItem[] = [];
  for (let i = 0; i < eligibleS2.length; i += 1) {
    const hit = eligibleS2[i]!;
    const s2Rank = i + 1;
    const untrusted = hit.taint === "quoted" || hit.kind === "event";
    const citations =
      hit.citations.length > 0 ? [...hit.citations] : [hit.id];
    const normScore = Number.isFinite(hit.score)
      ? Math.max(0, Math.min(1, hit.score))
      : 0.5;
    const corroborationBoost = corroboratedS2Indices.has(i) ? 1.08 : 1.0;
    fused.push({
      id: hit.id,
      source: "system2",
      kind: hit.kind,
      score:
        (s2Weight / (rrfK + s2Rank)) *
        (0.94 + 0.06 * normScore) *
        corroborationBoost,
      system2Rank: s2Rank,
      experienceRank: null,
      sensitivity: hit.sensitivity,
      taint: untrusted ? "quoted" : "clean",
      trustTag: untrusted ? "untrusted_captured_text" : "canon_evidence",
      untrustedCapturedText: untrusted,
      text: hit.text,
      ...(hit.title !== undefined ? { title: hit.title } : {}),
      citations: Object.freeze(citations),
    });
  }

  for (const item of expItems) {
    fused.push(item);
  }

  fused.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.id.localeCompare(b.id);
  });

  const sliced = fused.slice(0, limit);
  return {
    mode: input.mode ?? "local-hybrid",
    items: Object.freeze(sliced),
    system2Count: sliced.filter((i) => i.source === "system2").length,
    experienceCount: sliced.filter((i) => i.source === "experience").length,
    synthesis: input.memtSynthesis ?? null,
    degraded: Object.freeze([...(input.degraded ?? [])]),
  };
}

export interface MemtEngineStatus {
  readonly mode: "native-gpu" | "local-hybrid";
  readonly gpu_backend: "online" | "offline";
  readonly gpu_configured: boolean;
  readonly url: string | null;
  readonly identity: MemTIdentity | null;
  readonly capabilities: MemTCapabilities | null;
  readonly last_probe_at: string | null;
  readonly last_probe_error: string | null;
  readonly experience_count: number;
  readonly uninternalized_experience_count: number;
  readonly snapshot_count: number;
  readonly invalidated_snapshot_count: number;
}

export interface MemtHybridRecallInput {
  readonly query: string;
  readonly sensitivityCeiling: MemtSensitivity;
  readonly domain?: string;
  readonly scopeKey?: string;
  readonly partitionKey?: string;
  readonly queryVector?: Float32Array | readonly number[];
  readonly system2Hits?: readonly System2EvidenceHit[];
  readonly limit?: number;
  readonly includeSynthesis?: boolean;
  readonly maxSynthesisTokens?: number;
}

export interface InternalizePartitionInput {
  readonly partitionKey: string;
  readonly domain: string;
  readonly sensitivityCeiling: MemtSensitivity;
  readonly summaryTexts?: readonly string[];
  readonly sourceIds?: readonly string[];
  readonly eventWatermark?: string;
  readonly minConfidence?: number;
  readonly snapshotName?: string;
}

export interface InternalizePartitionResult {
  readonly mode: "native-gpu" | "local-hybrid";
  readonly internalized: boolean;
  readonly partitionKey: string;
  readonly experienceIds: readonly string[];
  readonly snapshotRecord?: MemtSnapshotRecord;
  readonly snapshotPath?: string;
  readonly tokensCommitted: number;
  readonly reason?: string;
}

export interface MemtPurgeResult {
  readonly snapshots: InvalidateSnapshotsResult;
  readonly experiences: {
    readonly purgedIds: readonly string[];
    readonly purgedCount: number;
  };
  readonly collaboration: PurgeCollaborationResult;
}

export interface MemtEngineOptions {
  readonly vaultPath: string;
  readonly config?: Partial<MemtConfig>;
  readonly dbPath?: string;
  readonly client?: MemTClient;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}

export class MemtEngine {
  readonly vaultPath: string;
  readonly config: MemtConfig;
  readonly experiences: ExperienceBank;
  readonly snapshots: SnapshotCustodyRegistry;
  readonly collaboration: CollaborationSliceStore;
  readonly client: MemTClient | null;

  private readonly db: Database;
  private readonly clock: () => number;
  private gpuOnline = false;
  private lastProbeMs = 0;
  private lastProbeAt: string | null = null;
  private lastProbeError: string | null = null;
  private cachedIdentity: MemTIdentity | null = null;
  private cachedCapabilities: MemTCapabilities | null = null;
  private activeSessions = new Map<string, MemTSession>();
  private loadedSnapshotByPartition = new Map<string, string>();
  private closed = false;

  get isGpuOnline(): boolean {
    return !this.closed && this.gpuOnline;
  }

  constructor(options: MemtEngineOptions) {
    this.vaultPath = options.vaultPath;
    const loaded = loadMemtConfig(options.vaultPath, options.env);
    this.config = Object.freeze({
      ...loaded,
      ...(options.config ?? {}),
    });
    this.clock = options.now ?? (() => Date.now());

    const dbPath = options.dbPath ?? this.config.registryPath;
    this.db = openMemtRegistryDb(dbPath);
    this.experiences = new ExperienceBank({ db: this.db });
    this.snapshots = new SnapshotCustodyRegistry({ db: this.db });
    this.collaboration = new CollaborationSliceStore({ db: this.db });

    if (options.client !== undefined) {
      this.client = options.client;
    } else if (this.config.enabled && this.config.url !== null) {
      this.client = new MemTClient({
        baseUrl: this.config.url,
        ...(this.config.apiKey !== null ? { apiKey: this.config.apiKey } : {}),
        timeoutMs: this.config.requestTimeoutMs,
        probeTimeoutMs: this.config.probeTimeoutMs,
        ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      });
    } else {
      this.client = null;
    }
  }

  async probe(
    options: { readonly force?: boolean } = {},
  ): Promise<MemtEngineStatus> {
    if (this.closed || !this.config.enabled || this.client === null) {
      this.gpuOnline = false;
      return this.buildStatus();
    }

    const nowMs = this.clock();
    if (
      options.force !== true &&
      this.lastProbeMs > 0 &&
      nowMs - this.lastProbeMs < this.config.offlineBackoffMs
    ) {
      return this.buildStatus();
    }

    this.lastProbeMs = nowMs;
    this.lastProbeAt = new Date(nowMs).toISOString();

    try {
      const caps = await this.client.getCapabilities({
        timeoutMs: this.config.probeTimeoutMs,
      });
      const identity = await this.client.getIdentity({
        timeoutMs: this.config.probeTimeoutMs,
      });
      this.cachedCapabilities = caps;
      this.cachedIdentity = identity;
      this.gpuOnline = true;
      this.lastProbeError = null;
    } catch (error) {
      this.gpuOnline = false;
      this.lastProbeError =
        error instanceof Error ? error.message : String(error);
    }

    return this.buildStatus();
  }

  async status(
    options: { readonly probe?: boolean } = {},
  ): Promise<MemtEngineStatus> {
    if (options.probe === true) {
      return this.probe({ force: true });
    }
    return this.buildStatus();
  }

  private buildStatus(): MemtEngineStatus {
    const expCounts = this.experiences.countExperiences();
    const snapCounts = this.snapshots.countSnapshots();
    return Object.freeze({
      mode: this.gpuOnline ? "native-gpu" : "local-hybrid",
      gpu_backend: this.gpuOnline ? "online" : "offline",
      gpu_configured: this.config.enabled && this.client !== null,
      url: this.config.url,
      identity: this.cachedIdentity,
      capabilities: this.cachedCapabilities,
      last_probe_at: this.lastProbeAt,
      last_probe_error: this.lastProbeError,
      experience_count: expCounts.total,
      uninternalized_experience_count: expCounts.uninternalized,
      snapshot_count: snapCounts.total,
      invalidated_snapshot_count: snapCounts.purgedInvalidated,
    });
  }

  private distillLocalSynthesis(
    query: string,
    hits: readonly ExperienceSearchHit[],
  ): MemtLatentSynthesis | null {
    const top = hits
      .filter(
        (h) =>
          h.experience.outcome === "verified" ||
          h.experience.outcome === "observed",
      )
      .slice(0, 3);
    if (top.length === 0) return null;

    const lines = top.map((h, i) => {
      const e = h.experience;
      return `${i + 1}. [${e.domain}/${e.scope_key}] (${e.outcome}, conf=${e.confidence.toFixed(2)}) When: ${e.condition} -> Do: ${e.recommendation}`;
    });
    const citations = [
      ...new Set(
        top.flatMap((h) =>
          h.experience.citations.length > 0
            ? h.experience.citations
            : [`experience:${h.experience.id}`],
        ),
      ),
    ];

    return {
      source: "local-experience-distill",
      text: `Procedural guidance for "${query}":\n${lines.join("\n")}`,
      citations: Object.freeze(citations),
      trustTag: "verified_procedure_summary",
    };
  }

  async recall(input: MemtHybridRecallInput): Promise<HybridRecallResult> {
    const degraded: string[] = [];

    const expHits = this.experiences.searchExperiences({
      query: input.query,
      sensitivityCeiling: input.sensitivityCeiling,
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      ...(input.scopeKey !== undefined ? { scopeKey: input.scopeKey } : {}),
      ...(input.queryVector !== undefined
        ? { queryVector: input.queryVector }
        : {}),
      limit: input.limit ?? 10,
      rrfK: this.config.rrfK,
    });

    let synthesis: MemtLatentSynthesis | null = null;
    const wantSynthesis = input.includeSynthesis ?? true;

    if (wantSynthesis && this.client !== null && this.config.enabled) {
      const currentStatus = await this.probe();
      if (currentStatus.mode === "native-gpu") {
        const partitionKey =
          input.partitionKey ?? input.domain ?? this.config.defaultPartition;
        try {
          synthesis = await this.runNativeSynthesis(
            input.query,
            partitionKey,
            input.sensitivityCeiling,
            input.maxSynthesisTokens ?? 256,
            expHits,
          );
        } catch (error) {
          if (error instanceof MemTCustodyError) {
            degraded.push(`memt-custody-${error.code}`);
          } else {
            this.gpuOnline = false;
            this.lastProbeMs = this.clock();
            this.lastProbeError =
              error instanceof Error ? error.message : String(error);
            degraded.push("memt-gpu-offline");
          }
        }
      } else {
        degraded.push("memt-gpu-offline");
      }
    }

    if (wantSynthesis && synthesis === null) {
      synthesis = this.distillLocalSynthesis(input.query, expHits);
    }

    return fuseHybridRecall({
      system2Hits: input.system2Hits ?? [],
      experienceHits: expHits,
      sensitivityCeiling: input.sensitivityCeiling,
      memtSynthesis: synthesis,
      mode: this.gpuOnline ? "native-gpu" : "local-hybrid",
      degraded,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      rrfK: this.config.rrfK,
    });
  }

  private async runNativeSynthesis(
    query: string,
    partitionKey: string,
    sensitivityCeiling: MemtSensitivity,
    maxTokens: number,
    expHits: readonly ExperienceSearchHit[],
  ): Promise<MemtLatentSynthesis | null> {
    if (this.client === null) return null;

    const record = this.snapshots.getSnapshot(partitionKey);
    let loadedSnapshotName: string | undefined;

    if (record !== null) {
      const snapshotPath = join(this.config.snapshotDir, record.snapshot_name);
      const verified = this.snapshots.assertLoadable(partitionKey, {
        requiredSensitivityCeiling: sensitivityCeiling,
        ...(this.cachedIdentity !== null
          ? { expectedIdentitySha256: this.cachedIdentity.config_sha256 }
          : {}),
        ...(existsSync(snapshotPath) ? { filePath: snapshotPath } : {}),
      });
      loadedSnapshotName = verified.snapshot_name;
    }

    const session = await this.getOrCreateSession(partitionKey);
    if (
      loadedSnapshotName !== undefined &&
      this.loadedSnapshotByPartition.get(partitionKey) !== loadedSnapshotName
    ) {
      await session.loadSnapshot({
        name: loadedSnapshotName,
        path: join(this.config.snapshotDir, loadedSnapshotName),
      });
      this.loadedSnapshotByPartition.set(partitionKey, loadedSnapshotName);
    }

    const res = await session.query(
      `Synthesize concise factual and procedural recall for: ${query}`,
      { maxNewTokens: maxTokens },
    );

    const citations = [
      ...new Set(
        expHits.flatMap((h) =>
          h.experience.citations.length > 0
            ? h.experience.citations
            : [`experience:${h.experience.id}`],
        ),
      ),
    ];

    return {
      source: "memt-native-gpu",
      text: res.text,
      partitionKey,
      ...(loadedSnapshotName !== undefined
        ? { snapshotName: loadedSnapshotName }
        : {}),
      citations: Object.freeze(citations),
      trustTag: "latent_synthesis_unverified",
    };
  }

  private async getOrCreateSession(partitionKey: string): Promise<MemTSession> {
    const existing = this.activeSessions.get(partitionKey);
    if (existing !== undefined && !existing.isClosed) {
      return existing;
    }
    if (this.client === null) {
      throw new Error("MemT GPU client is not configured");
    }
    const created = await this.client.createSession({
      memoryRead: true,
      retainKv: false,
      leaseTtlSeconds: this.config.defaultLeaseTtlSeconds,
    });
    this.activeSessions.set(partitionKey, created);
    this.loadedSnapshotByPartition.delete(partitionKey);
    return created;
  }

  async internalizePartition(
    input: InternalizePartitionInput,
  ): Promise<InternalizePartitionResult> {
    const status = await this.probe({ force: true });
    if (status.mode !== "native-gpu" || this.client === null) {
      return {
        mode: "local-hybrid",
        internalized: false,
        partitionKey: input.partitionKey,
        experienceIds: [],
        tokensCommitted: 0,
        reason: status.last_probe_error ?? "MemT GPU backend is offline",
      };
    }

    const pending = this.experiences.getUninternalizedExperiences({
      domain: input.domain,
      sensitivityCeiling: input.sensitivityCeiling,
      ...(input.minConfidence !== undefined
        ? { minConfidence: input.minConfidence }
        : {}),
    });

    const docs: string[] = [];
    const sourceIdSet = new Set<string>(input.sourceIds ?? []);

    for (const exp of pending) {
      docs.push(
        `[Procedure ${exp.id} | ${exp.domain}/${exp.scope_key} | ${exp.outcome}]\n` +
          `Condition: ${exp.condition}\n` +
          `Recommendation: ${exp.recommendation}\n` +
          (exp.verification.length > 0
            ? `Verification: ${exp.verification}\n`
            : "") +
          `Citations: ${exp.citations.join(", ")}`,
      );
      for (const citation of exp.citations) {
        sourceIdSet.add(citation);
      }
    }

    for (const summary of input.summaryTexts ?? []) {
      if (summary.trim().length > 0) {
        docs.push(summary.trim());
      }
    }

    if (docs.length === 0) {
      return {
        mode: "native-gpu",
        internalized: false,
        partitionKey: input.partitionKey,
        experienceIds: [],
        tokensCommitted: 0,
        reason: "no uninternalized experiences or summaries to commit",
      };
    }

    mkdirSync(this.config.snapshotDir, { recursive: true, mode: 0o700 });
    const safePartition = input.partitionKey.replace(/[^A-Za-z0-9._-]/g, "_");
    const snapshotName =
      input.snapshotName ??
      `${safePartition}-${Date.now().toString(36)}.safetensors`;
    const snapshotPath = join(this.config.snapshotDir, snapshotName);

    const session = await this.getOrCreateSession(input.partitionKey);
    const commitRes = await session.ingestDocument(docs.join("\n\n---\n\n"));
    const exportRes = await session.saveSnapshot({
      name: snapshotName,
      path: snapshotPath,
    });

    const exportedPath = exportRes.snapshotPath ?? snapshotPath;
    if (existsSync(exportedPath)) {
      const validation = validateMemTSnapshotFile(exportedPath);
      if (!validation.ok) {
        throw new MemTCustodyError(
          "invalid_snapshot_file",
          input.partitionKey,
          `Exported snapshot '${exportedPath}' failed memt-memory-v1 validation: ${validation.errors.join("; ")}`,
        );
      }
    }

    const identitySha =
      this.cachedIdentity?.config_sha256 ?? sha256Hex(commitRes.epoch);
    const snapshotRecord = this.snapshots.registerSnapshot({
      partition_key: input.partitionKey,
      sensitivity_ceiling: input.sensitivityCeiling,
      source_ids: [...sourceIdSet],
      snapshot_name: exportRes.snapshotName ?? snapshotName,
      identity_sha256: identitySha,
      event_watermark: input.eventWatermark ?? new Date().toISOString(),
      taint_state: "clean",
    });

    const expIds = pending.map((e) => e.id);
    if (expIds.length > 0) {
      this.experiences.markInternalized(expIds, snapshotRecord.snapshot_name);
    }
    this.loadedSnapshotByPartition.set(
      input.partitionKey,
      snapshotRecord.snapshot_name,
    );

    return {
      mode: "native-gpu",
      internalized: true,
      partitionKey: input.partitionKey,
      experienceIds: Object.freeze(expIds),
      snapshotRecord,
      snapshotPath: exportedPath,
      tokensCommitted: commitRes.tokensCommitted,
    };
  }

  compileCollaborationSlice(
    input: CompileCollaborationSliceInput,
  ): CollaborationSlice {
    return this.collaboration.compileSlice(input);
  }

  purgeSources(sourceIds: readonly string[]): MemtPurgeResult {
    const snapshots = this.snapshots.invalidateForPurgedSources(sourceIds);
    for (const partitionKey of snapshots.invalidatedPartitions) {
      this.loadedSnapshotByPartition.delete(partitionKey);
    }
    const experiences = this.experiences.purgeBySourceRefs(sourceIds);
    const collaboration = this.collaboration.purgeBySourceRefs(sourceIds);
    return { snapshots, experiences, collaboration };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const sessions = [...this.activeSessions.values()];
    this.activeSessions.clear();
    this.loadedSnapshotByPartition.clear();
    await Promise.allSettled(sessions.map((session) => session.close()));
    this.db.close();
  }
}

export function createMemtEngine(
  vaultPath: string,
  options: Omit<MemtEngineOptions, "vaultPath"> = {},
): MemtEngine {
  return new MemtEngine({ vaultPath, ...options });
}
