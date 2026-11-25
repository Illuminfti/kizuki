import type { Database, SQLQueryBindings, Statement } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  MEMT_SENSITIVITY_ORDER,
  allowedSensitivitiesForCeiling,
  canonicalSourceRef,
  defaultMemtRegistryPath,
  isMemtSensitivity,
  maxSensitivity,
  normalizeSourceRefVariants,
  openMemtRegistryDb,
  sha256Hex,
  withinSensitivityCeiling,
} from "./db";
import type { MemtSensitivity } from "./db";

export const EXPERIENCE_OUTCOMES = [
  "verified",
  "observed",
  "failed",
  "superseded",
] as const;
export type ExperienceOutcome = (typeof EXPERIENCE_OUTCOMES)[number];

export interface ExperienceRecord {
  readonly id: string;
  readonly domain: string;
  readonly scope_key: string;
  readonly sensitivity: MemtSensitivity;
  readonly condition: string;
  readonly recommendation: string;
  readonly verification: string;
  readonly outcome: ExperienceOutcome;
  readonly citations: readonly string[];
  readonly confidence: number;
  readonly use_count: number;
  readonly internalized_in_snapshot: string | null;
  readonly has_embedding: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface RecordExperienceInput {
  readonly id?: string;
  readonly domain: string;
  readonly scope_key: string;
  readonly sensitivity: MemtSensitivity;
  readonly condition: string;
  readonly recommendation: string;
  readonly verification?: string;
  readonly outcome?: ExperienceOutcome;
  readonly citations?: readonly string[];
  readonly confidence?: number;
  readonly embedding?: Float32Array | readonly number[];
  readonly now?: string;
}

export interface RecordExperienceResult {
  readonly experience: ExperienceRecord;
  readonly deduplicated: boolean;
  readonly mergedIntoId?: string;
}

export interface SearchExperiencesInput {
  readonly query: string;
  readonly sensitivityCeiling: MemtSensitivity;
  readonly domain?: string;
  readonly scopeKey?: string;
  readonly outcomes?: readonly ExperienceOutcome[];
  readonly queryVector?: Float32Array | readonly number[];
  readonly limit?: number;
  readonly rrfK?: number;
  readonly diversityLambda?: number;
  readonly now?: Date;
}

export interface ExperienceSearchHit {
  readonly experience: ExperienceRecord;
  readonly score: number;
  readonly bm25Rank: number | null;
  readonly vectorRank: number | null;
  readonly cosineSimilarity: number | null;
}

export interface MarkOutcomeOptions {
  readonly confidence?: number;
  readonly verification?: string;
  readonly addCitations?: readonly string[];
  readonly incrementUseCount?: boolean;
  readonly now?: string;
}

export interface UninternalizedExperiencesFilter {
  readonly domain?: string;
  readonly sensitivityCeiling?: MemtSensitivity;
  readonly minConfidence?: number;
  readonly limit?: number;
}

export interface PurgeExperiencesResult {
  readonly purgedIds: readonly string[];
  readonly purgedCount: number;
}

export interface ExperienceCountStats {
  readonly total: number;
  readonly uninternalized: number;
  readonly verified: number;
  readonly observed: number;
  readonly failed: number;
}

interface ExperienceRow {
  id: string;
  domain: string;
  scope_key: string;
  sensitivity: string;
  condition: string;
  recommendation: string;
  verification: string;
  outcome: string;
  citations_json: string;
  confidence: number;
  use_count: number;
  internalized_in_snapshot: string | null;
  embedding: Uint8Array | null;
  dedup_key: string;
  created_at: string;
  updated_at: string;
}

interface ExperienceMetaRow {
  id: string;
  domain: string;
  scope_key: string;
  sensitivity: string;
  condition: string;
  recommendation: string;
  verification: string;
  outcome: string;
  citations_json: string;
  confidence: number;
  use_count: number;
  internalized_in_snapshot: string | null;
  has_embedding: number;
  created_at: string;
  updated_at: string;
}

interface ScopeCandidateRow {
  id: string;
  dedup_key: string;
  condition: string;
  recommendation: string;
  embedding: Uint8Array | null;
}

interface VectorCacheRow {
  id: string;
  domain: string;
  scope_key: string;
  sensitivity: string;
  outcome: string;
  confidence: number;
  use_count: number;
  updated_at: string;
  embedding: Uint8Array;
}

interface VectorBucket {
  readonly dim: number;
  count: number;
  capacity: number;
  data: Float32Array;
  ids: string[];
  domains: string[];
  scopeKeys: string[];
  sensitivityRanks: Uint8Array;
  outcomeBits: Uint8Array;
  confidences: Float32Array;
  useCounts: Uint32Array;
  updatedAtMs: Float64Array;
  readonly indexById: Map<string, number>;
}

interface DedupEntry {
  readonly id: string;
  dedupKey: string;
  tokens: Set<string>;
  unitVector: Float32Array | null;
  dim: number;
}

const EXPERIENCE_META_COLS = `e.id, e.domain, e.scope_key, e.sensitivity, e.condition, e.recommendation,
  e.verification, e.outcome, e.citations_json, e.confidence, e.use_count,
  e.internalized_in_snapshot,
  (e.embedding IS NOT NULL AND length(e.embedding) > 0) AS has_embedding,
  e.created_at, e.updated_at`;

const IS_LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

const OUTCOME_BIT: Readonly<Record<ExperienceOutcome, number>> = {
  verified: 1,
  observed: 2,
  failed: 4,
  superseded: 8,
};

const FTS_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "for", "from", "had", "has",
  "have", "having", "he", "her", "hers", "him", "his", "how", "i", "if", "in",
  "into", "is", "it", "its", "me", "my", "no", "nor", "not", "of", "on", "or",
  "our", "ours", "out", "she", "should", "so", "some", "than", "that", "the",
  "their", "theirs", "them", "then", "there", "these", "they", "this", "those",
  "to", "too", "up", "us", "very", "was", "we", "were", "what", "when", "where",
  "which", "while", "who", "whom", "why", "will", "with", "would", "you", "your",
  "yours",
]);

const MAX_DEDUP_SCOPES = 4096;
const MAX_DEDUP_ENTRIES_PER_SCOPE = 100;
const MAX_CACHED_FTS_STATEMENTS = 64;

function outcomeToBit(raw: string): number {
  switch (raw) {
    case "verified":
      return 1;
    case "observed":
      return 2;
    case "failed":
      return 4;
    case "superseded":
      return 8;
    default:
      return 0;
  }
}

function sensitivityToRank(raw: string): number {
  return isMemtSensitivity(raw) ? MEMT_SENSITIVITY_ORDER[raw] : 3;
}

function generateExperienceId(): string {
  const ts = Date.now().toString(36).padStart(9, "0");
  const rand = randomBytes(6).toString("hex");
  return `exp_${ts}_${rand}`;
}

function normalizeTextForDedup(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenizeNormalized(value: string): Set<string> {
  const norm = normalizeTextForDedup(value);
  if (norm.length === 0) return new Set();
  const out = new Set<string>();
  for (const token of norm.split(" ")) {
    if (token.length >= 2) out.add(token);
  }
  return out;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function computeDedupKey(
  domain: string,
  scopeKey: string,
  condition: string,
  recommendation: string,
): string {
  return sha256Hex(
    [
      domain.trim().toLowerCase(),
      scopeKey.trim().toLowerCase(),
      normalizeTextForDedup(condition),
      normalizeTextForDedup(recommendation),
    ].join("\0"),
  );
}

export function encodeFloat32Vector(
  vector: Float32Array | readonly number[],
): Uint8Array {
  const len = vector.length;
  const bytes = new Uint8Array(len * 4);
  if (IS_LITTLE_ENDIAN) {
    const f32 = new Float32Array(bytes.buffer, 0, len);
    for (let i = 0; i < len; i += 1) {
      const val = vector[i];
      if (val === undefined || !Number.isFinite(val)) {
        throw new RangeError(
          `embedding vector contains non-finite value at index ${i}`,
        );
      }
      f32[i] = val;
    }
    return bytes;
  }
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < len; i += 1) {
    const val = vector[i];
    if (val === undefined || !Number.isFinite(val)) {
      throw new RangeError(
        `embedding vector contains non-finite value at index ${i}`,
      );
    }
    view.setFloat32(i * 4, val, true);
  }
  return bytes;
}

export function decodeFloat32Vector(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength % 4 !== 0) {
    return new Float32Array(0);
  }
  const count = bytes.byteLength >>> 2;
  const out = new Float32Array(count);
  if (IS_LITTLE_ENDIAN && (bytes.byteOffset & 3) === 0) {
    out.set(new Float32Array(bytes.buffer, bytes.byteOffset, count));
    return out;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

function encodeAndNormalizeFloat32(
  vector: Float32Array | readonly number[],
): { blob: Uint8Array; unit: Float32Array | null } {
  const len = vector.length;
  const blob = new Uint8Array(len * 4);
  if (len === 0) return { blob, unit: null };

  let normSq = 0;
  if (IS_LITTLE_ENDIAN) {
    const f32 = new Float32Array(blob.buffer, 0, len);
    for (let i = 0; i < len; i += 1) {
      const val = vector[i];
      if (val === undefined || !Number.isFinite(val)) {
        throw new RangeError(
          `embedding vector contains non-finite value at index ${i}`,
        );
      }
      f32[i] = val;
      normSq += val * val;
    }
    if (normSq <= 0 || !Number.isFinite(normSq)) return { blob, unit: null };
    const inv = 1 / Math.sqrt(normSq);
    const unit = new Float32Array(len);
    for (let i = 0; i < len; i += 1) unit[i] = f32[i]! * inv;
    return { blob, unit };
  }

  const view = new DataView(blob.buffer);
  for (let i = 0; i < len; i += 1) {
    const val = vector[i];
    if (val === undefined || !Number.isFinite(val)) {
      throw new RangeError(
        `embedding vector contains non-finite value at index ${i}`,
      );
    }
    view.setFloat32(i * 4, val, true);
    normSq += val * val;
  }
  if (normSq <= 0 || !Number.isFinite(normSq)) return { blob, unit: null };
  const inv = 1 / Math.sqrt(normSq);
  const unit = new Float32Array(len);
  for (let i = 0; i < len; i += 1) unit[i] = (vector[i] ?? 0) * inv;
  return { blob, unit };
}

function normalizeToUnitFloat32(
  vector: Float32Array | readonly number[],
): Float32Array | null {
  const len = vector.length;
  if (len === 0) return null;
  let normSq = 0;
  for (let i = 0; i < len; i += 1) {
    const v = vector[i];
    if (v === undefined || !Number.isFinite(v)) return null;
    normSq += v * v;
  }
  if (normSq <= 0 || !Number.isFinite(normSq)) return null;
  const inv = 1 / Math.sqrt(normSq);
  const unit = new Float32Array(len);
  for (let i = 0; i < len; i += 1) {
    unit[i] = (vector[i] ?? 0) * inv;
  }
  return unit;
}

function decodeAndNormalizeInto(
  bytes: Uint8Array,
  target: Float32Array,
  targetOffset: number,
  dim: number,
): boolean {
  if (bytes.byteLength !== dim * 4) return false;
  let normSq = 0;
  if (IS_LITTLE_ENDIAN && (bytes.byteOffset & 3) === 0) {
    const src = new Float32Array(bytes.buffer, bytes.byteOffset, dim);
    for (let i = 0; i < dim; i += 1) {
      const v = src[i]!;
      if (!Number.isFinite(v)) return false;
      normSq += v * v;
    }
    if (normSq <= 0 || !Number.isFinite(normSq)) return false;
    const inv = 1 / Math.sqrt(normSq);
    for (let i = 0; i < dim; i += 1) {
      target[targetOffset + i] = src[i]! * inv;
    }
    return true;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < dim; i += 1) {
    const v = view.getFloat32(i * 4, true);
    if (!Number.isFinite(v)) return false;
    target[targetOffset + i] = v;
    normSq += v * v;
  }
  if (normSq <= 0 || !Number.isFinite(normSq)) return false;
  const inv = 1 / Math.sqrt(normSq);
  for (let i = 0; i < dim; i += 1) {
    target[targetOffset + i] = target[targetOffset + i]! * inv;
  }
  return true;
}

function unitDotPacked(
  query: Float32Array,
  packed: Float32Array,
  base: number,
  dim: number,
): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let i = 0;
  const limit4 = dim - 3;
  for (; i < limit4; i += 4) {
    const b = base + i;
    s0 += query[i]! * packed[b]!;
    s1 += query[i + 1]! * packed[b + 1]!;
    s2 += query[i + 2]! * packed[b + 2]!;
    s3 += query[i + 3]! * packed[b + 3]!;
  }
  let dot = s0 + s1 + s2 + s3;
  for (; i < dim; i += 1) {
    dot += query[i]! * packed[base + i]!;
  }
  return dot;
}

function unitDotPackedPair(
  packedA: Float32Array,
  baseA: number,
  packedB: Float32Array,
  baseB: number,
  dim: number,
): number {
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let i = 0;
  const limit4 = dim - 3;
  for (; i < limit4; i += 4) {
    s0 += packedA[baseA + i]! * packedB[baseB + i]!;
    s1 += packedA[baseA + i + 1]! * packedB[baseB + i + 1]!;
    s2 += packedA[baseA + i + 2]! * packedB[baseB + i + 2]!;
    s3 += packedA[baseA + i + 3]! * packedB[baseB + i + 3]!;
  }
  let dot = s0 + s1 + s2 + s3;
  for (; i < dim; i += 1) {
    dot += packedA[baseA + i]! * packedB[baseB + i]!;
  }
  return dot;
}

export function cosineSimilarity(
  a: Float32Array | readonly number[],
  b: Float32Array | readonly number[],
): number {
  const len = a.length;
  if (len === 0 || len !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let i = 0;
  const limit4 = len - 3;
  for (; i < limit4; i += 4) {
    const a0 = a[i] ?? 0;
    const b0 = b[i] ?? 0;
    const a1 = a[i + 1] ?? 0;
    const b1 = b[i + 1] ?? 0;
    const a2 = a[i + 2] ?? 0;
    const b2 = b[i + 2] ?? 0;
    const a3 = a[i + 3] ?? 0;
    const b3 = b[i + 3] ?? 0;
    dot += a0 * b0 + a1 * b1 + a2 * b2 + a3 * b3;
    normA += a0 * a0 + a1 * a1 + a2 * a2 + a3 * a3;
    normB += b0 * b0 + b1 * b1 + b2 * b2 + b3 * b3;
  }
  for (; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA * normB);
  if (denom === 0 || !Number.isFinite(denom)) return 0;
  return dot / denom;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function parseCitationsJson(raw: string): string[] {
  if (raw === "[]" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
  } catch {
    // fallback
  }
  return [];
}

function mergeCitations(
  existing: readonly string[],
  incoming: readonly string[],
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of [...existing, ...incoming]) {
    const trimmed = item.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

function metaRowToExperience(row: ExperienceMetaRow): ExperienceRecord {
  return Object.freeze({
    id: row.id,
    domain: row.domain,
    scope_key: row.scope_key,
    sensitivity: isMemtSensitivity(row.sensitivity) ? row.sensitivity : "private",
    condition: row.condition,
    recommendation: row.recommendation,
    verification: row.verification,
    outcome: row.outcome as ExperienceOutcome,
    citations: Object.freeze(parseCitationsJson(row.citations_json)),
    confidence: row.confidence,
    use_count: row.use_count,
    internalized_in_snapshot: row.internalized_in_snapshot,
    has_embedding: row.has_embedding !== 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

interface AnalyzedQueryTerm {
  readonly raw: string;
  readonly stem: string | null;
  readonly allowPrefix: boolean;
}

function stemEnglishToken(token: string): { stem: string | null; allowPrefix: boolean } {
  if (token.length < 4 || !/^[a-z]+$/.test(token)) {
    return { stem: null, allowPrefix: false };
  }

  if (token.length >= 7 && token.endsWith("ations")) {
    return { stem: token.slice(0, -5), allowPrefix: true };
  }
  if (token.length >= 6 && token.endsWith("ation")) {
    return { stem: token.slice(0, -4), allowPrefix: true };
  }
  if (token.length >= 7 && token.endsWith("ments")) {
    return { stem: token.slice(0, -5), allowPrefix: true };
  }
  if (token.length >= 6 && token.endsWith("ment")) {
    return { stem: token.slice(0, -4), allowPrefix: true };
  }
  if (token.length >= 6 && token.endsWith("ying")) {
    const base = token.slice(0, -4);
    if (base.length >= 4) return { stem: base, allowPrefix: true };
  }
  if (token.length >= 6 && token.endsWith("ing")) {
    let base = token.slice(0, -3);
    if (base.length >= 4 && /(?:pp|tt|nn|mm|gg|dd|bb|rr)$/.test(base)) {
      base = base.slice(0, -1);
    }
    if (base.length >= 4) return { stem: base, allowPrefix: true };
    if (base.length === 3) return { stem: base, allowPrefix: false };
  }
  if (token.length >= 6 && token.endsWith("ied")) {
    const base = token.slice(0, -3);
    if (base.length >= 4) return { stem: base, allowPrefix: true };
  }
  if (token.length >= 5 && token.endsWith("ies")) {
    const base = token.slice(0, -3);
    if (base.length >= 4) return { stem: base, allowPrefix: true };
    if (base.length === 3) return { stem: `${base}y`, allowPrefix: false };
  }
  if (token.length >= 5 && token.endsWith("ed")) {
    let base = token.slice(0, -2);
    if (base.length >= 4 && /(?:pp|tt|nn|mm|gg|dd|bb|rr)$/.test(base)) {
      base = base.slice(0, -1);
    }
    if (base.length >= 4) return { stem: base, allowPrefix: true };
    if (base.length === 3) return { stem: base, allowPrefix: false };
  }
  if (token.length >= 5 && /(?:sh|ch|ss|x|z)es$/.test(token)) {
    const base = token.slice(0, -2);
    if (base.length >= 3) return { stem: base, allowPrefix: base.length >= 4 };
  }
  if (
    token.length >= 4 &&
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    const base = token.slice(0, -1);
    if (base.length >= 4) return { stem: base, allowPrefix: true };
    if (base.length === 3) return { stem: base, allowPrefix: false };
  }
  if (token.length >= 6 && token.endsWith("ly")) {
    const base = token.slice(0, -2);
    if (base.length >= 4) return { stem: base, allowPrefix: true };
  }
  return { stem: null, allowPrefix: false };
}

function analyzeQueryForFts5(raw: string): AnalyzedQueryTerm[] {
  const matches = raw.match(/[\p{L}\p{N}_]+/gu);
  if (matches === null) return [];

  const allTokens: string[] = [];
  const seenAll = new Set<string>();
  for (const token of matches) {
    const lower = token.toLowerCase();
    if (lower.length > 0 && !seenAll.has(lower)) {
      seenAll.add(lower);
      allTokens.push(lower);
    }
    if (allTokens.length >= 24) break;
  }
  if (allTokens.length === 0) return [];

  const filtered = allTokens.filter(
    (t) =>
      !FTS_STOPWORDS.has(t) &&
      (t.length >= 2 || /[0-9]/.test(t)),
  );
  const chosen = filtered.length > 0 ? filtered : allTokens;

  return chosen.map((token) => {
    const { stem, allowPrefix } = stemEnglishToken(token);
    return { raw: token, stem, allowPrefix };
  });
}

function escapeFtsQuote(token: string): string {
  return token.replaceAll('"', "");
}

function buildSmartFts5Expression(
  terms: readonly AnalyzedQueryTerm[],
  mode: "AND" | "OR",
): string {
  const parts: string[] = [];
  for (const term of terms) {
    const safeRaw = escapeFtsQuote(term.raw);
    if (safeRaw.length === 0) continue;
    if (term.stem !== null && term.stem !== term.raw) {
      const safeStem = escapeFtsQuote(term.stem);
      if (term.allowPrefix) {
        parts.push(`("${safeRaw}" OR "${safeStem}"*)`);
      } else {
        parts.push(`("${safeRaw}" OR "${safeStem}")`);
      }
    } else {
      parts.push(`"${safeRaw}"`);
    }
  }
  return parts.join(` ${mode} `);
}

function buildSimpleFts5Expression(
  terms: readonly AnalyzedQueryTerm[],
  mode: "AND" | "OR",
): string {
  return terms
    .map((t) => `"${escapeFtsQuote(t.raw)}"`)
    .filter((s) => s.length > 2)
    .join(` ${mode} `);
}

function computeLexicalCoverage(
  row: ExperienceMetaRow,
  terms: readonly AnalyzedQueryTerm[],
): { coverage: number; exactRatio: number } {
  if (terms.length === 0) return { coverage: 1, exactRatio: 1 };
  const haystack =
    `${row.domain} ${row.scope_key} ${row.condition} ${row.recommendation} ${row.verification}`.toLowerCase();
  let matched = 0;
  let exactMatched = 0;
  for (const term of terms) {
    if (haystack.includes(term.raw)) {
      matched += 1;
      exactMatched += 1;
    } else if (term.stem !== null && haystack.includes(term.stem)) {
      matched += 1;
    }
  }
  return {
    coverage: matched / terms.length,
    exactRatio: exactMatched / terms.length,
  };
}

function outcomeWeight(outcome: ExperienceOutcome): number {
  switch (outcome) {
    case "verified":
      return 1.2;
    case "observed":
      return 1.0;
    case "failed":
      return 0.4;
    case "superseded":
      return 0.2;
  }
}

function recencyFactorFromMs(parsedMs: number, nowMs: number): number {
  if (!Number.isFinite(parsedMs)) return 0.85;
  const ageDays = Math.max(0, (nowMs - parsedMs) / 86_400_000);
  const decay = Math.exp((-Math.LN2 * ageDays) / 90);
  return 0.75 + 0.25 * decay;
}

function recencyFactor(updatedAt: string, now: Date): number {
  return recencyFactorFromMs(Date.parse(updatedAt), now.getTime());
}

function outcomeWeightFromBit(bit: number): number {
  switch (bit) {
    case 1:
      return 1.2;
    case 2:
      return 1.0;
    case 4:
      return 0.4;
    case 8:
      return 0.2;
    default:
      return 0.2;
  }
}

function mergeOutcomes(
  existing: ExperienceOutcome,
  incoming: ExperienceOutcome,
): ExperienceOutcome {
  if (incoming === "superseded" || incoming === "failed") return incoming;
  if (existing === "verified" || incoming === "verified") return "verified";
  return incoming;
}

function createVectorBucket(dim: number, initialCapacity = 64): VectorBucket {
  return {
    dim,
    count: 0,
    capacity: initialCapacity,
    data: new Float32Array(initialCapacity * dim),
    ids: new Array<string>(initialCapacity),
    domains: new Array<string>(initialCapacity),
    scopeKeys: new Array<string>(initialCapacity),
    sensitivityRanks: new Uint8Array(initialCapacity),
    outcomeBits: new Uint8Array(initialCapacity),
    confidences: new Float32Array(initialCapacity),
    useCounts: new Uint32Array(initialCapacity),
    updatedAtMs: new Float64Array(initialCapacity),
    indexById: new Map<string, number>(),
  };
}

function ensureBucketCapacity(bucket: VectorBucket, needed: number): void {
  if (needed <= bucket.capacity) return;
  let nextCap = bucket.capacity;
  while (nextCap < needed) nextCap *= 2;
  const nextData = new Float32Array(nextCap * bucket.dim);
  nextData.set(bucket.data.subarray(0, bucket.count * bucket.dim));
  const nextSens = new Uint8Array(nextCap);
  nextSens.set(bucket.sensitivityRanks.subarray(0, bucket.count));
  const nextOut = new Uint8Array(nextCap);
  nextOut.set(bucket.outcomeBits.subarray(0, bucket.count));
  const nextConf = new Float32Array(nextCap);
  nextConf.set(bucket.confidences.subarray(0, bucket.count));
  const nextUses = new Uint32Array(nextCap);
  nextUses.set(bucket.useCounts.subarray(0, bucket.count));
  const nextUpdated = new Float64Array(nextCap);
  nextUpdated.set(bucket.updatedAtMs.subarray(0, bucket.count));
  bucket.data = nextData;
  bucket.sensitivityRanks = nextSens;
  bucket.outcomeBits = nextOut;
  bucket.confidences = nextConf;
  bucket.useCounts = nextUses;
  bucket.updatedAtMs = nextUpdated;
  bucket.ids.length = nextCap;
  bucket.domains.length = nextCap;
  bucket.scopeKeys.length = nextCap;
  bucket.capacity = nextCap;
}

export interface ExperienceBankOptions {
  readonly db?: Database;
  readonly dbPath?: string;
  readonly vaultPath?: string;
  readonly nearDuplicateThreshold?: number;
  readonly semanticDuplicateThreshold?: number;
}

export class ExperienceBank {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly nearDuplicateThreshold: number;
  private readonly semanticDuplicateThreshold: number;

  // Prepared read-only statements
  private readonly stmtDataVersion: Statement<{ data_version: number }, []>;
  private readonly stmtGetByIdFull: Statement<ExperienceRow, [string]>;
  private readonly stmtGetByIdMeta: Statement<ExperienceMetaRow, [string]>;
  private readonly stmtGetByDedup: Statement<ExperienceRow, [string]>;
  private readonly stmtScopeCandidates: Statement<ScopeCandidateRow, [string, string]>;
  private readonly stmtLoadVectors: Statement<VectorCacheRow, []>;
  private readonly stmtCheckSourcesTable: Statement<{ ok: number }, []>;
  private readonly ftsStmtCache = new Map<
    string,
    Statement<ExperienceMetaRow, SQLQueryBindings[]>
  >();
  private readonly inStmtCache = new Map<
    number,
    Statement<ExperienceMetaRow, string[]>
  >();

  // Lazy write statements (never prepared on read-only DB handles)
  private stmtInsertExp: Statement<unknown, SQLQueryBindings[]> | null = null;
  private stmtUpdateExp: Statement<unknown, SQLQueryBindings[]> | null = null;
  private stmtDeleteFts: Statement<unknown, [string]> | null = null;
  private stmtInsertFts: Statement<unknown, [string, string, string, string, string, string]> | null = null;
  private stmtInsertSource: Statement<unknown, [string, string]> | null = null;
  private stmtDeleteExp: Statement<unknown, [string]> | null = null;
  private stmtUpdateOutcome: Statement<unknown, SQLQueryBindings[]> | null = null;
  private stmtMarkInternalized: Statement<unknown, [string, string, string]> | null = null;
  private txInsertExp: ((
    id: string,
    domain: string,
    scopeKey: string,
    sensitivity: MemtSensitivity,
    condition: string,
    recommendation: string,
    verification: string,
    outcome: ExperienceOutcome,
    citationsJson: string,
    confidence: number,
    embeddingBlob: Uint8Array | null,
    dedupKey: string,
    now: string,
    citations: readonly string[],
  ) => void) | null = null;
  private txUpdateExp: ((
    dupId: string,
    dupDomain: string,
    dupScope: string,
    dupCondition: string,
    dupRec: string,
    mergedSensitivity: MemtSensitivity,
    mergedVerification: string,
    mergedOutcome: ExperienceOutcome,
    mergedCitationsJson: string,
    mergedConfidence: number,
    mergedUseCount: number,
    mergedEmbedding: Uint8Array | null,
    now: string,
    newCitations: readonly string[],
  ) => void) | null = null;

  private hasSourcesTableCached: boolean | null = null;
  private vectorCacheLoaded = false;
  private vectorCacheDataVersion = -1;
  private readonly vectorBuckets = new Map<number, VectorBucket>();
  private readonly vectorDimById = new Map<string, number>();

  // Per-(domain, scope_key) dedup cache synced with PRAGMA data_version
  private dedupCacheDataVersion = -1;
  private readonly dedupScopeCache = new Map<string, DedupEntry[]>();
  private readonly dedupScopeKeyById = new Map<string, string>();

  constructor(options: ExperienceBankOptions) {
    if (options.db !== undefined) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const dbPath =
        options.dbPath ??
        (options.vaultPath !== undefined
          ? defaultMemtRegistryPath(options.vaultPath)
          : ":memory:");
      this.db = openMemtRegistryDb(dbPath);
      this.ownsDb = true;
    }
    this.nearDuplicateThreshold = options.nearDuplicateThreshold ?? 0.82;
    this.semanticDuplicateThreshold = options.semanticDuplicateThreshold ?? 0.92;

    this.stmtDataVersion = this.db.query<{ data_version: number }, []>(
      "PRAGMA data_version",
    );
    this.stmtGetByIdFull = this.db.query<ExperienceRow, [string]>(
      "SELECT * FROM experiences WHERE id = ?",
    );
    this.stmtGetByIdMeta = this.db.query<ExperienceMetaRow, [string]>(
      `SELECT ${EXPERIENCE_META_COLS} FROM experiences e WHERE e.id = ?`,
    );
    this.stmtGetByDedup = this.db.query<ExperienceRow, [string]>(
      "SELECT * FROM experiences WHERE dedup_key = ? AND outcome != 'superseded' ORDER BY updated_at DESC LIMIT 1",
    );
    this.stmtScopeCandidates = this.db.query<ScopeCandidateRow, [string, string]>(
      `SELECT id, dedup_key, condition, recommendation, embedding
       FROM experiences
       WHERE domain = ? AND scope_key = ? AND outcome != 'superseded'
       ORDER BY updated_at DESC
       LIMIT ${MAX_DEDUP_ENTRIES_PER_SCOPE}`,
    );
    this.stmtLoadVectors = this.db.query<VectorCacheRow, []>(
      "SELECT id, domain, scope_key, sensitivity, outcome, confidence, use_count, updated_at, embedding FROM experiences WHERE embedding IS NOT NULL",
    );
    this.stmtCheckSourcesTable = this.db.query<{ ok: number }, []>(
      "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='experience_sources' LIMIT 1",
    );
  }

  private readDataVersion(): number {
    return this.stmtDataVersion.get()?.data_version ?? 0;
  }

  private hasSourcesTable(): boolean {
    if (this.hasSourcesTableCached === null) {
      this.hasSourcesTableCached = this.stmtCheckSourcesTable.get() !== null;
    }
    return this.hasSourcesTableCached;
  }

  private ensureWriteStatements(): void {
    if (this.stmtInsertExp !== null) return;
    this.stmtInsertExp = this.db.query(
      `INSERT INTO experiences (
        id, domain, scope_key, sensitivity, condition, recommendation,
        verification, outcome, citations_json, confidence, use_count,
        internalized_in_snapshot, embedding, dedup_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
    );
    this.stmtUpdateExp = this.db.query(
      `UPDATE experiences
       SET sensitivity = ?,
           verification = ?,
           outcome = ?,
           citations_json = ?,
           confidence = ?,
           use_count = ?,
           embedding = ?,
           updated_at = ?
       WHERE id = ?`,
    );
    this.stmtDeleteFts = this.db.query("DELETE FROM experiences_fts WHERE id = ?");
    this.stmtInsertFts = this.db.query(
      `INSERT INTO experiences_fts (id, domain, scope_key, condition, recommendation, verification)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.stmtDeleteExp = this.db.query("DELETE FROM experiences WHERE id = ?");
    this.stmtUpdateOutcome = this.db.query(
      `UPDATE experiences
       SET outcome = ?,
           confidence = ?,
           verification = ?,
           citations_json = ?,
           use_count = ?,
           updated_at = ?
       WHERE id = ?`,
    );
    this.stmtMarkInternalized = this.db.query(
      "UPDATE experiences SET internalized_in_snapshot = ?, updated_at = ? WHERE id = ?",
    );
    if (this.hasSourcesTable()) {
      this.stmtInsertSource = this.db.query(
        "INSERT OR IGNORE INTO experience_sources (experience_id, source_ref) VALUES (?, ?)",
      );
    }

    this.txInsertExp = this.db.transaction(
      (
        id: string,
        domain: string,
        scopeKey: string,
        sensitivity: MemtSensitivity,
        condition: string,
        recommendation: string,
        verification: string,
        outcome: ExperienceOutcome,
        citationsJson: string,
        confidence: number,
        embeddingBlob: Uint8Array | null,
        dedupKey: string,
        now: string,
        citations: readonly string[],
      ) => {
        this.stmtInsertExp!.run(
          id,
          domain,
          scopeKey,
          sensitivity,
          condition,
          recommendation,
          verification,
          outcome,
          citationsJson,
          confidence,
          embeddingBlob,
          dedupKey,
          now,
          now,
        );
        this.stmtInsertFts!.run(
          id,
          domain,
          scopeKey,
          condition,
          recommendation,
          verification,
        );
        this.indexExperienceSources(id, citations);
      },
    );

    this.txUpdateExp = this.db.transaction(
      (
        dupId: string,
        dupDomain: string,
        dupScope: string,
        dupCondition: string,
        dupRec: string,
        mergedSensitivity: MemtSensitivity,
        mergedVerification: string,
        mergedOutcome: ExperienceOutcome,
        mergedCitationsJson: string,
        mergedConfidence: number,
        mergedUseCount: number,
        mergedEmbedding: Uint8Array | null,
        now: string,
        newCitations: readonly string[],
      ) => {
        this.stmtUpdateExp!.run(
          mergedSensitivity,
          mergedVerification,
          mergedOutcome,
          mergedCitationsJson,
          mergedConfidence,
          mergedUseCount,
          mergedEmbedding,
          now,
          dupId,
        );
        this.stmtDeleteFts!.run(dupId);
        this.stmtInsertFts!.run(
          dupId,
          dupDomain,
          dupScope,
          dupCondition,
          dupRec,
          mergedVerification,
        );
        this.indexExperienceSources(dupId, newCitations);
      },
    );
  }

  private indexExperienceSources(experienceId: string, citations: readonly string[]): void {
    if (citations.length === 0 || this.stmtInsertSource === null) return;
    for (const citation of citations) {
      const ref = canonicalSourceRef(citation);
      if (ref.length > 0) {
        this.stmtInsertSource.run(experienceId, ref);
      }
    }
  }

  private getCachedFtsStatement(
    whereClause: string,
  ): Statement<ExperienceMetaRow, SQLQueryBindings[]> {
    const cached = this.ftsStmtCache.get(whereClause);
    if (cached !== undefined) return cached;
    const stmt = this.db.query<ExperienceMetaRow, SQLQueryBindings[]>(
      `SELECT ${EXPERIENCE_META_COLS}
       FROM experiences_fts f
       JOIN experiences e ON e.id = f.id
       WHERE experiences_fts MATCH ? AND ${whereClause}
       ORDER BY f.rank ASC
       LIMIT ?`,
    );
    if (this.ftsStmtCache.size >= MAX_CACHED_FTS_STATEMENTS) {
      const oldest = this.ftsStmtCache.keys().next().value;
      if (oldest !== undefined) this.ftsStmtCache.delete(oldest);
    }
    this.ftsStmtCache.set(whereClause, stmt);
    return stmt;
  }

  private fetchMetaRowsByIds(ids: readonly string[]): ExperienceMetaRow[] {
    if (ids.length === 0) return [];
    if (ids.length === 1) {
      const row = this.stmtGetByIdMeta.get(ids[0]!);
      return row === null ? [] : [row];
    }
    const out: ExperienceMetaRow[] = [];
    const chunkSize = 200;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const slice = ids.slice(i, i + chunkSize);
      const n = slice.length;
      let stmt = this.inStmtCache.get(n);
      if (stmt === undefined) {
        const placeholders = Array.from({ length: n }, () => "?").join(", ");
        stmt = this.db.query<ExperienceMetaRow, string[]>(
          `SELECT ${EXPERIENCE_META_COLS} FROM experiences e WHERE e.id IN (${placeholders})`,
        );
        if (this.inStmtCache.size < 64) {
          this.inStmtCache.set(n, stmt);
        }
      }
      const rows = stmt.all(...slice);
      for (const r of rows) out.push(r);
    }
    return out;
  }

  private invalidateVectorCache(): void {
    this.vectorCacheLoaded = false;
    this.vectorBuckets.clear();
    this.vectorDimById.clear();
  }

  private ensureVectorCache(): void {
    const dv = this.readDataVersion();
    if (this.vectorCacheLoaded && dv === this.vectorCacheDataVersion) {
      return;
    }
    this.rebuildVectorCache(dv);
  }

  private rebuildVectorCache(dataVersion: number): void {
    this.vectorBuckets.clear();
    this.vectorDimById.clear();

    const rows = this.stmtLoadVectors.all();
    for (const row of rows) {
      const bytes = row.embedding;
      if (bytes === null || bytes.byteLength === 0 || (bytes.byteLength & 3) !== 0) {
        continue;
      }
      const dim = bytes.byteLength >>> 2;
      let bucket = this.vectorBuckets.get(dim);
      if (bucket === undefined) {
        bucket = createVectorBucket(dim, Math.max(64, Math.min(4096, rows.length)));
        this.vectorBuckets.set(dim, bucket);
      }
      const idx = bucket.count;
      ensureBucketCapacity(bucket, idx + 1);
      if (!decodeAndNormalizeInto(bytes, bucket.data, idx * dim, dim)) {
        continue;
      }
      bucket.ids[idx] = row.id;
      bucket.domains[idx] = row.domain;
      bucket.scopeKeys[idx] = row.scope_key;
      bucket.sensitivityRanks[idx] = sensitivityToRank(row.sensitivity);
      bucket.outcomeBits[idx] = outcomeToBit(row.outcome);
      bucket.confidences[idx] = row.confidence;
      bucket.useCounts[idx] = row.use_count;
      bucket.updatedAtMs[idx] = Date.parse(row.updated_at);
      bucket.indexById.set(row.id, idx);
      bucket.count = idx + 1;
      this.vectorDimById.set(row.id, dim);
    }

    this.vectorCacheDataVersion = dataVersion;
    this.vectorCacheLoaded = true;
  }

  private upsertVectorCacheEntry(
    id: string,
    domain: string,
    scopeKey: string,
    sensitivity: MemtSensitivity,
    outcome: ExperienceOutcome,
    confidence: number,
    useCount: number,
    updatedAt: string,
    unitVector: Float32Array | null,
  ): void {
    if (!this.vectorCacheLoaded) return;
    if (this.readDataVersion() !== this.vectorCacheDataVersion) {
      this.invalidateVectorCache();
      return;
    }

    const updatedMs = Date.parse(updatedAt);
    const prevDim = this.vectorDimById.get(id);
    if (unitVector === null) {
      if (prevDim !== undefined) {
        const bucket = this.vectorBuckets.get(prevDim);
        const idx = bucket?.indexById.get(id);
        if (bucket !== undefined && idx !== undefined) {
          bucket.sensitivityRanks[idx] = MEMT_SENSITIVITY_ORDER[sensitivity];
          bucket.outcomeBits[idx] = OUTCOME_BIT[outcome];
          bucket.confidences[idx] = confidence;
          bucket.useCounts[idx] = useCount;
          bucket.updatedAtMs[idx] = updatedMs;
        }
      }
      return;
    }

    const dim = unitVector.length;
    if (prevDim !== undefined && prevDim !== dim) {
      this.removeVectorCacheEntry(id);
    }

    let bucket = this.vectorBuckets.get(dim);
    if (bucket === undefined) {
      bucket = createVectorBucket(dim);
      this.vectorBuckets.set(dim, bucket);
    }

    const existingIdx = bucket.indexById.get(id);
    if (existingIdx !== undefined) {
      bucket.data.set(unitVector, existingIdx * dim);
      bucket.domains[existingIdx] = domain;
      bucket.scopeKeys[existingIdx] = scopeKey;
      bucket.sensitivityRanks[existingIdx] = MEMT_SENSITIVITY_ORDER[sensitivity];
      bucket.outcomeBits[existingIdx] = OUTCOME_BIT[outcome];
      bucket.confidences[existingIdx] = confidence;
      bucket.useCounts[existingIdx] = useCount;
      bucket.updatedAtMs[existingIdx] = updatedMs;
      return;
    }

    const idx = bucket.count;
    ensureBucketCapacity(bucket, idx + 1);
    bucket.data.set(unitVector, idx * dim);
    bucket.ids[idx] = id;
    bucket.domains[idx] = domain;
    bucket.scopeKeys[idx] = scopeKey;
    bucket.sensitivityRanks[idx] = MEMT_SENSITIVITY_ORDER[sensitivity];
    bucket.outcomeBits[idx] = OUTCOME_BIT[outcome];
    bucket.confidences[idx] = confidence;
    bucket.useCounts[idx] = useCount;
    bucket.updatedAtMs[idx] = updatedMs;
    bucket.indexById.set(id, idx);
    bucket.count = idx + 1;
    this.vectorDimById.set(id, dim);
  }

  private removeVectorCacheEntry(id: string): void {
    if (!this.vectorCacheLoaded) return;
    const dim = this.vectorDimById.get(id);
    if (dim === undefined) return;
    this.vectorDimById.delete(id);
    const bucket = this.vectorBuckets.get(dim);
    if (bucket === undefined) return;
    const idx = bucket.indexById.get(id);
    if (idx === undefined) return;
    bucket.indexById.delete(id);

    const lastIdx = bucket.count - 1;
    if (idx !== lastIdx) {
      const movedId = bucket.ids[lastIdx]!;
      bucket.data.copyWithin(idx * dim, lastIdx * dim, (lastIdx + 1) * dim);
      bucket.ids[idx] = movedId;
      bucket.domains[idx] = bucket.domains[lastIdx]!;
      bucket.scopeKeys[idx] = bucket.scopeKeys[lastIdx]!;
      bucket.sensitivityRanks[idx] = bucket.sensitivityRanks[lastIdx]!;
      bucket.outcomeBits[idx] = bucket.outcomeBits[lastIdx]!;
      bucket.confidences[idx] = bucket.confidences[lastIdx]!;
      bucket.useCounts[idx] = bucket.useCounts[lastIdx]!;
      bucket.updatedAtMs[idx] = bucket.updatedAtMs[lastIdx]!;
      bucket.indexById.set(movedId, idx);
    }
    bucket.count = lastIdx;
  }

  private getScopeDedupEntries(domain: string, scopeKey: string): DedupEntry[] {
    const dv = this.readDataVersion();
    if (dv !== this.dedupCacheDataVersion) {
      this.dedupScopeCache.clear();
      this.dedupScopeKeyById.clear();
      this.dedupCacheDataVersion = dv;
    }

    const cacheKey = `${domain}\0${scopeKey}`;
    const cached = this.dedupScopeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const rows = this.stmtScopeCandidates.all(domain, scopeKey);
    const entries: DedupEntry[] = [];
    for (const row of rows) {
      let unitVector: Float32Array | null = null;
      let dim = 0;
      if (row.embedding !== null && row.embedding.byteLength > 0) {
        const decoded = decodeFloat32Vector(row.embedding);
        unitVector = normalizeToUnitFloat32(decoded);
        dim = unitVector !== null ? unitVector.length : 0;
      }
      entries.push({
        id: row.id,
        dedupKey: row.dedup_key,
        tokens: tokenizeNormalized(`${row.condition} ${row.recommendation}`),
        unitVector,
        dim,
      });
      this.dedupScopeKeyById.set(row.id, cacheKey);
    }

    if (this.dedupScopeCache.size >= MAX_DEDUP_SCOPES) {
      const oldestKey = this.dedupScopeCache.keys().next().value;
      if (oldestKey !== undefined) {
        const evicted = this.dedupScopeCache.get(oldestKey);
        if (evicted !== undefined) {
          for (const e of evicted) this.dedupScopeKeyById.delete(e.id);
        }
        this.dedupScopeCache.delete(oldestKey);
      }
    }
    this.dedupScopeCache.set(cacheKey, entries);
    return entries;
  }

  recordExperience(input: RecordExperienceInput): RecordExperienceResult {
    const domain = input.domain.trim();
    const scopeKey = input.scope_key.trim();
    const condition = input.condition.trim();
    const recommendation = input.recommendation.trim();
    const verification = (input.verification ?? "").trim();

    if (domain.length === 0) throw new Error("experience domain must be non-empty");
    if (scopeKey.length === 0) {
      throw new Error("experience scope_key must be non-empty");
    }
    if (condition.length === 0) {
      throw new Error("experience condition must be non-empty");
    }
    if (recommendation.length === 0) {
      throw new Error("experience recommendation must be non-empty");
    }
    if (!isMemtSensitivity(input.sensitivity)) {
      throw new Error(
        `invalid experience sensitivity: ${String(input.sensitivity)}`,
      );
    }

    const outcome: ExperienceOutcome = input.outcome ?? "observed";
    if (!(EXPERIENCE_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error(`invalid experience outcome: ${String(outcome)}`);
    }

    this.ensureWriteStatements();

    const confidence = clampConfidence(
      input.confidence ?? (outcome === "verified" ? 0.85 : 0.6),
    );
    const citations = mergeCitations([], input.citations ?? []);
    const now = input.now ?? new Date().toISOString();
    const dedupKey = computeDedupKey(domain, scopeKey, condition, recommendation);

    let embeddingBlob: Uint8Array | null = null;
    let incomingUnit: Float32Array | null = null;
    if (input.embedding !== undefined) {
      const encoded = encodeAndNormalizeFloat32(input.embedding);
      embeddingBlob = encoded.blob;
      incomingUnit = encoded.unit;
    }
    const incomingDim = incomingUnit !== null ? incomingUnit.length : 0;

    const scopeEntries = this.getScopeDedupEntries(domain, scopeKey);
    const incomingTokens = tokenizeNormalized(`${condition} ${recommendation}`);
    const incomingTokenCount = incomingTokens.size;
    const jaccThreshold = this.nearDuplicateThreshold;
    const semThreshold = this.semanticDuplicateThreshold;

    let matchedEntry: DedupEntry | null = null;
    let duplicateRow: ExperienceRow | null = null;

    // 1. Fast exact dedup_key check in scope cache (or indexed DB lookup)
    for (const entry of scopeEntries) {
      if (entry.dedupKey === dedupKey) {
        matchedEntry = entry;
        break;
      }
    }
    if (matchedEntry === null && scopeEntries.length >= MAX_DEDUP_ENTRIES_PER_SCOPE) {
      const exactRow = this.stmtGetByDedup.get(dedupKey);
      if (exactRow !== null && exactRow.domain === domain && exactRow.scope_key === scopeKey) {
        duplicateRow = exactRow;
      }
    }

    // 2. Lexical Jaccard (with O(1) length-bound prune) + semantic cosine near-duplicate check
    if (matchedEntry === null && duplicateRow === null) {
      let bestScore = -1;
      for (const entry of scopeEntries) {
        const entrySize = entry.tokens.size;
        const maxLen =
          incomingTokenCount >= entrySize ? incomingTokenCount : entrySize;
        const minLen =
          incomingTokenCount <= entrySize ? incomingTokenCount : entrySize;
        if (maxLen === 0 || minLen / maxLen >= jaccThreshold) {
          const jacc = jaccardSimilarity(incomingTokens, entry.tokens);
          if (jacc >= jaccThreshold && jacc > bestScore) {
            bestScore = jacc;
            matchedEntry = entry;
            continue;
          }
        }
        if (
          incomingUnit !== null &&
          entry.unitVector !== null &&
          entry.dim === incomingDim
        ) {
          const sim = unitDotPacked(incomingUnit, entry.unitVector, 0, incomingDim);
          if (sim >= semThreshold && sim > bestScore) {
            bestScore = sim;
            matchedEntry = entry;
          }
        }
      }
    }

    if (matchedEntry !== null && duplicateRow === null) {
      duplicateRow = this.stmtGetByIdFull.get(matchedEntry.id);
    }

    if (duplicateRow !== null) {
      const mergedSensitivity = maxSensitivity(
        isMemtSensitivity(duplicateRow.sensitivity)
          ? duplicateRow.sensitivity
          : "private",
        input.sensitivity,
      );
      const mergedCitations = mergeCitations(
        parseCitationsJson(duplicateRow.citations_json),
        citations,
      );
      const mergedOutcome = mergeOutcomes(
        duplicateRow.outcome as ExperienceOutcome,
        outcome,
      );
      const mergedConfidence =
        outcome === "failed"
          ? clampConfidence(Math.min(duplicateRow.confidence, confidence) * 0.85)
          : clampConfidence(
              Math.min(1, Math.max(duplicateRow.confidence, confidence) + 0.05),
            );
      const mergedVerification =
        verification.length > duplicateRow.verification.length
          ? verification
          : duplicateRow.verification;
      const mergedUseCount = duplicateRow.use_count + 1;

      // Centroid blend when both existing & incoming carry embeddings of same dimension
      let mergedEmbedding = embeddingBlob ?? duplicateRow.embedding;
      let mergedUnit: Float32Array | null = incomingUnit;
      if (
        incomingUnit !== null &&
        duplicateRow.embedding !== null &&
        duplicateRow.embedding.byteLength === incomingDim * 4
      ) {
        const existingVec = decodeFloat32Vector(duplicateRow.embedding);
        const existingUnit = normalizeToUnitFloat32(existingVec);
        if (existingUnit !== null) {
          const wExisting = duplicateRow.use_count + 1;
          const blended = new Float32Array(incomingDim);
          for (let i = 0; i < incomingDim; i += 1) {
            blended[i] = existingUnit[i]! * wExisting + incomingUnit[i]!;
          }
          const centroid = normalizeToUnitFloat32(blended);
          if (centroid !== null) {
            mergedUnit = centroid;
            mergedEmbedding = encodeFloat32Vector(centroid);
          }
        }
      }

      const dupId = duplicateRow.id;
      const dupDomain = duplicateRow.domain;
      const dupScope = duplicateRow.scope_key;
      const dupCondition = duplicateRow.condition;
      const dupRec = duplicateRow.recommendation;

      this.txUpdateExp!(
        dupId,
        dupDomain,
        dupScope,
        dupCondition,
        dupRec,
        mergedSensitivity,
        mergedVerification,
        mergedOutcome,
        JSON.stringify(mergedCitations),
        mergedConfidence,
        mergedUseCount,
        mergedEmbedding,
        now,
        citations,
      );

      if (matchedEntry !== null && mergedUnit !== null) {
        matchedEntry.unitVector = mergedUnit;
        matchedEntry.dim = mergedUnit.length;
      }
      if (mergedOutcome === "superseded") {
        const idx = scopeEntries.findIndex((e) => e.id === dupId);
        if (idx >= 0) scopeEntries.splice(idx, 1);
        this.dedupScopeKeyById.delete(dupId);
      }
      this.upsertVectorCacheEntry(
        dupId,
        dupDomain,
        dupScope,
        mergedSensitivity,
        mergedOutcome,
        mergedConfidence,
        mergedUseCount,
        now,
        mergedUnit,
      );

      const updated: ExperienceRecord = Object.freeze({
        id: dupId,
        domain: dupDomain,
        scope_key: dupScope,
        sensitivity: mergedSensitivity,
        condition: dupCondition,
        recommendation: dupRec,
        verification: mergedVerification,
        outcome: mergedOutcome,
        citations: Object.freeze(mergedCitations),
        confidence: mergedConfidence,
        use_count: mergedUseCount,
        internalized_in_snapshot: duplicateRow.internalized_in_snapshot,
        has_embedding: mergedEmbedding !== null && mergedEmbedding.byteLength > 0,
        created_at: duplicateRow.created_at,
        updated_at: now,
      });

      return {
        experience: updated,
        deduplicated: true,
        mergedIntoId: dupId,
      };
    }

    const id = input.id?.trim() || generateExperienceId();
    this.txInsertExp!(
      id,
      domain,
      scopeKey,
      input.sensitivity,
      condition,
      recommendation,
      verification,
      outcome,
      JSON.stringify(citations),
      confidence,
      embeddingBlob,
      dedupKey,
      now,
      citations,
    );

    if (outcome !== "superseded") {
      const cacheKey = `${domain}\0${scopeKey}`;
      scopeEntries.unshift({
        id,
        dedupKey,
        tokens: incomingTokens,
        unitVector: incomingUnit,
        dim: incomingDim,
      });
      this.dedupScopeKeyById.set(id, cacheKey);
      if (scopeEntries.length > MAX_DEDUP_ENTRIES_PER_SCOPE) {
        const dropped = scopeEntries.pop();
        if (dropped !== undefined) this.dedupScopeKeyById.delete(dropped.id);
      }
    }
    if (incomingUnit !== null) {
      this.upsertVectorCacheEntry(
        id,
        domain,
        scopeKey,
        input.sensitivity,
        outcome,
        confidence,
        0,
        now,
        incomingUnit,
      );
    }

    const created: ExperienceRecord = Object.freeze({
      id,
      domain,
      scope_key: scopeKey,
      sensitivity: input.sensitivity,
      condition,
      recommendation,
      verification,
      outcome,
      citations: Object.freeze(citations),
      confidence,
      use_count: 0,
      internalized_in_snapshot: null,
      has_embedding: embeddingBlob !== null && embeddingBlob.byteLength > 0,
      created_at: now,
      updated_at: now,
    });

    return {
      experience: created,
      deduplicated: false,
    };
  }

  searchExperiences(input: SearchExperiencesInput): ExperienceSearchHit[] {
    if (!isMemtSensitivity(input.sensitivityCeiling)) {
      throw new Error(
        `invalid sensitivityCeiling: ${String(input.sensitivityCeiling)}`,
      );
    }
    const limit = Math.max(1, Math.min(100, input.limit ?? 10));
    const rrfK = input.rrfK ?? 60;
    const now = input.now ?? new Date();
    const ceilingRank = MEMT_SENSITIVITY_ORDER[input.sensitivityCeiling];
    const allowedSens = allowedSensitivitiesForCeiling(input.sensitivityCeiling);
    const allowedOutcomes: readonly ExperienceOutcome[] =
      input.outcomes ?? ["verified", "observed", "failed"];

    if (allowedOutcomes.length === 0) return [];

    let outcomeMask = 0;
    for (const o of allowedOutcomes) {
      outcomeMask |= OUTCOME_BIT[o] ?? 0;
    }

    const domainFilter =
      input.domain !== undefined && input.domain.trim().length > 0
        ? input.domain.trim()
        : null;
    const scopeFilter =
      input.scopeKey !== undefined && input.scopeKey.trim().length > 0
        ? input.scopeKey.trim()
        : null;

    const sensPlaceholders = allowedSens.map(() => "?").join(", ");
    const outcomePlaceholders = allowedOutcomes.map(() => "?").join(", ");

    const baseFilters: string[] = [
      `e.sensitivity IN (${sensPlaceholders})`,
      `e.outcome IN (${outcomePlaceholders})`,
    ];
    const baseParams: SQLQueryBindings[] = [...allowedSens, ...allowedOutcomes];
    if (domainFilter !== null) {
      baseFilters.push("e.domain = ?");
      baseParams.push(domainFilter);
    }
    if (scopeFilter !== null) {
      baseFilters.push("e.scope_key = ?");
      baseParams.push(scopeFilter);
    }
    const whereClause = baseFilters.join(" AND ");

    const bm25RankById = new Map<string, number>();
    const lexicalCoverageById = new Map<string, number>();
    const rowById = new Map<string, ExperienceMetaRow>();
    const terms = analyzeQueryForFts5(input.query);

    if (terms.length > 0) {
      const ftsStmt = this.getCachedFtsStatement(whereClause);

      const runFtsSafe = (
        smartExpr: string,
        fallbackExpr: string,
        cap: number,
      ): ExperienceMetaRow[] => {
        if (smartExpr.length === 0) return [];
        try {
          return ftsStmt.all(smartExpr, ...baseParams, cap);
        } catch {
          if (fallbackExpr.length === 0) return [];
          try {
            return ftsStmt.all(fallbackExpr, ...baseParams, cap);
          } catch {
            return [];
          }
        }
      };

      const fetchCap = Math.min(80, Math.max(limit * 4, 24));
      const andRows = runFtsSafe(
        buildSmartFts5Expression(terms, "AND"),
        buildSimpleFts5Expression(terms, "AND"),
        fetchCap,
      );

      interface LexicalCandidate {
        readonly row: ExperienceMetaRow;
        readonly isAndTier: boolean;
        readonly rawOrder: number;
        readonly coverage: number;
        readonly exactRatio: number;
      }

      const lexicalCandidates: LexicalCandidate[] = [];
      const seenLex = new Set<string>();
      for (let i = 0; i < andRows.length; i += 1) {
        const row = andRows[i]!;
        if (
          !isMemtSensitivity(row.sensitivity) ||
          !withinSensitivityCeiling(row.sensitivity, input.sensitivityCeiling)
        ) {
          continue;
        }
        seenLex.add(row.id);
        const { coverage, exactRatio } = computeLexicalCoverage(row, terms);
        lexicalCandidates.push({
          row,
          isAndTier: true,
          rawOrder: i,
          coverage,
          exactRatio,
        });
      }

      const hasQueryVector =
        input.queryVector !== undefined && input.queryVector.length > 0;
      const orThreshold = hasQueryVector ? Math.min(limit, 3) : Math.max(limit * 2, 10);
      if (lexicalCandidates.length < orThreshold && terms.length > 1) {
        const orCap = Math.min(48, Math.max(limit * 4, 20));
        const orRows = runFtsSafe(
          buildSmartFts5Expression(terms, "OR"),
          buildSimpleFts5Expression(terms, "OR"),
          orCap,
        );
        for (let i = 0; i < orRows.length; i += 1) {
          const row = orRows[i]!;
          if (seenLex.has(row.id)) continue;
          if (
            !isMemtSensitivity(row.sensitivity) ||
            !withinSensitivityCeiling(row.sensitivity, input.sensitivityCeiling)
          ) {
            continue;
          }
          seenLex.add(row.id);
          const { coverage, exactRatio } = computeLexicalCoverage(row, terms);
          lexicalCandidates.push({
            row,
            isAndTier: false,
            rawOrder: i,
            coverage,
            exactRatio,
          });
        }
      }

      lexicalCandidates.sort((a, b) => {
        if (a.isAndTier !== b.isAndTier) return a.isAndTier ? -1 : 1;
        const scoreA =
          1 / (20 + a.rawOrder) + a.coverage * 0.045 + a.exactRatio * 0.012;
        const scoreB =
          1 / (20 + b.rawOrder) + b.coverage * 0.045 + b.exactRatio * 0.012;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return a.rawOrder - b.rawOrder;
      });

      for (let i = 0; i < lexicalCandidates.length; i += 1) {
        const cand = lexicalCandidates[i]!;
        bm25RankById.set(cand.row.id, i + 1);
        lexicalCoverageById.set(cand.row.id, cand.coverage);
        rowById.set(cand.row.id, cand.row);
      }
    }

    const vectorRankById = new Map<string, number>();
    const cosineById = new Map<string, number>();
    let activeVectorBucket: VectorBucket | null = null;

    if (input.queryVector !== undefined && input.queryVector.length > 0) {
      const queryUnit = normalizeToUnitFloat32(input.queryVector);
      if (queryUnit !== null) {
        this.ensureVectorCache();
        const dim = queryUnit.length;
        const bucket = this.vectorBuckets.get(dim);
        if (bucket !== undefined && bucket.count > 0) {
          activeVectorBucket = bucket;
          const vecCap = Math.min(128, Math.max(limit * 6, 32));
          const {
            count,
            data,
            ids,
            domains,
            scopeKeys,
            sensitivityRanks,
            outcomeBits,
          } = bucket;

          const topIds: string[] = [];
          const topSims: number[] = [];
          let minSim = 0;

          for (let i = 0; i < count; i += 1) {
            if (sensitivityRanks[i]! > ceilingRank) continue;
            if ((outcomeBits[i]! & outcomeMask) === 0) continue;
            if (domainFilter !== null && domains[i] !== domainFilter) continue;
            if (scopeFilter !== null && scopeKeys[i] !== scopeFilter) continue;

            const sim = unitDotPacked(queryUnit, data, i * dim, dim);
            if (sim <= minSim) continue;

            const id = ids[i]!;
            if (topSims.length < vecCap) {
              let lo = 0;
              let hi = topSims.length;
              while (lo < hi) {
                const mid = (lo + hi) >>> 1;
                if (topSims[mid]! >= sim) lo = mid + 1;
                else hi = mid;
              }
              topSims.splice(lo, 0, sim);
              topIds.splice(lo, 0, id);
              if (topSims.length === vecCap) {
                minSim = topSims[vecCap - 1]!;
              }
            } else {
              let pos = vecCap - 1;
              while (pos > 0 && topSims[pos - 1]! < sim) {
                topSims[pos] = topSims[pos - 1]!;
                topIds[pos] = topIds[pos - 1]!;
                pos -= 1;
              }
              topSims[pos] = sim;
              topIds[pos] = id;
              minSim = topSims[vecCap - 1]!;
            }
          }

          // Pure-vector fast path: score + MMR 100% in memory, then hydrate ONLY final `limit` rows!
          if (terms.length === 0) {
            const nowMs = now.getTime();
            const scoredPure: {
              id: string;
              bucketIdx: number;
              score: number;
              vectorRank: number;
              cos: number;
              updatedAtMs: number;
            }[] = [];
            for (let i = 0; i < topIds.length; i += 1) {
              const id = topIds[i]!;
              const bIdx = bucket.indexById.get(id);
              if (bIdx === undefined) continue;
              const cos = topSims[i]!;
              const clampedCos = cos > 1 ? 1 : cos < 0 ? 0 : cos;
              const vRank = i + 1;
              const combined =
                (1 / (rrfK + vRank)) * (0.45 + 0.55 * clampedCos) +
                0.022 * clampedCos * clampedCos;
              const confBoost = 0.5 + 0.5 * bucket.confidences[bIdx]!;
              const useBoost = 1 + Math.min(0.15, Math.log1p(bucket.useCounts[bIdx]!) * 0.04);
              const score =
                combined *
                confBoost *
                outcomeWeightFromBit(bucket.outcomeBits[bIdx]!) *
                recencyFactorFromMs(bucket.updatedAtMs[bIdx]!, nowMs) *
                useBoost;
              scoredPure.push({
                id,
                bucketIdx: bIdx,
                score,
                vectorRank: vRank,
                cos,
                updatedAtMs: bucket.updatedAtMs[bIdx]!,
              });
            }
            scoredPure.sort((a, b) => {
              if (b.score !== a.score) return b.score - a.score;
              return b.updatedAtMs - a.updatedAtMs;
            });

            const diversityLambda =
              input.diversityLambda !== undefined && Number.isFinite(input.diversityLambda)
                ? Math.max(0, Math.min(1, input.diversityLambda))
                : 0.68;

            let chosenPure = scoredPure.slice(0, limit);
            if (diversityLambda < 1 && scoredPure.length > 1 && limit > 1) {
              const poolSize = Math.min(scoredPure.length, Math.max(limit * 4, 24));
              const pool = scoredPure.slice(0, poolSize);
              const maxScore = pool[0]!.score;
              if (maxScore > 0) {
                const selected: number[] = [0];
                const used = new Uint8Array(poolSize);
                used[0] = 1;
                const maxSim = new Float64Array(poolSize);
                const b0 = pool[0]!.bucketIdx * dim;
                for (let i = 1; i < poolSize; i += 1) {
                  const d = unitDotPackedPair(data, pool[i]!.bucketIdx * dim, data, b0, dim);
                  maxSim[i] = d > 0 ? d : 0;
                }
                const excessThreshold = 0.42;
                const excessDenom = 1 - excessThreshold;
                while (selected.length < limit && selected.length < poolSize) {
                  let bestIdx = -1;
                  let bestMmr = -Infinity;
                  for (let i = 1; i < poolSize; i += 1) {
                    if (used[i] === 1) continue;
                    const normRel = pool[i]!.score / maxScore;
                    const rawSim = maxSim[i]!;
                    const excess =
                      rawSim <= excessThreshold ? 0 : (rawSim - excessThreshold) / excessDenom;
                    const mmr =
                      diversityLambda * normRel * (1 - excess * excess) -
                      (1 - diversityLambda) * excess;
                    if (mmr > bestMmr) {
                      bestMmr = mmr;
                      bestIdx = i;
                    }
                  }
                  if (bestIdx < 0) break;
                  used[bestIdx] = 1;
                  selected.push(bestIdx);
                  const bSel = pool[bestIdx]!.bucketIdx * dim;
                  for (let i = 1; i < poolSize; i += 1) {
                    if (used[i] === 1) continue;
                    const d = unitDotPackedPair(data, pool[i]!.bucketIdx * dim, data, bSel, dim);
                    if (d > maxSim[i]!) maxSim[i] = d;
                  }
                }
                chosenPure = selected.map((idx) => pool[idx]!);
              }
            }

            const hydrated = new Map<string, ExperienceMetaRow>();
            for (const row of this.fetchMetaRowsByIds(chosenPure.map((c) => c.id))) {
              if (
                isMemtSensitivity(row.sensitivity) &&
                withinSensitivityCeiling(row.sensitivity, input.sensitivityCeiling)
              ) {
                hydrated.set(row.id, row);
              }
            }

            const outHits: ExperienceSearchHit[] = [];
            for (const item of chosenPure) {
              const row = hydrated.get(item.id);
              if (row === undefined) continue;
              outHits.push({
                experience: metaRowToExperience(row),
                score: item.score,
                bm25Rank: null,
                vectorRank: item.vectorRank,
                cosineSimilarity: item.cos,
              });
            }
            return outHits;
          }

          // Batch-fetch ONLY rows not already hydrated from FTS5, without reading embedding BLOBs
          const missingIds: string[] = [];
          for (let i = 0; i < topIds.length; i += 1) {
            const id = topIds[i]!;
            vectorRankById.set(id, i + 1);
            cosineById.set(id, topSims[i]!);
            if (!rowById.has(id)) {
              missingIds.push(id);
            }
          }

          if (missingIds.length > 0) {
            for (const row of this.fetchMetaRowsByIds(missingIds)) {
              if (
                isMemtSensitivity(row.sensitivity) &&
                withinSensitivityCeiling(row.sensitivity, input.sensitivityCeiling)
              ) {
                rowById.set(row.id, row);
              }
            }
          }
        }
      }
    }

    if (terms.length === 0 && input.queryVector === undefined) {
      const fallbackRows = this.db
        .query<ExperienceMetaRow, SQLQueryBindings[]>(
          `SELECT ${EXPERIENCE_META_COLS}
           FROM experiences e
           WHERE ${whereClause}
           ORDER BY e.confidence DESC, e.use_count DESC, e.updated_at DESC
           LIMIT ?`,
        )
        .all(...baseParams, limit);
      return fallbackRows.map((row, index) => {
        const exp = metaRowToExperience(row);
        const score =
          (1 / (rrfK + index + 1)) *
          (0.5 + 0.5 * exp.confidence) *
          outcomeWeight(exp.outcome) *
          recencyFactor(exp.updated_at, now);
        return {
          experience: exp,
          score,
          bm25Rank: null,
          vectorRank: null,
          cosineSimilarity: null,
        };
      });
    }

    const nowMs = now.getTime();
    interface ScoredMetaHit {
      readonly row: ExperienceMetaRow;
      readonly score: number;
      readonly bm25Rank: number | null;
      readonly vectorRank: number | null;
      readonly cosineSimilarity: number | null;
    }

    const scoredHits: ScoredMetaHit[] = [];
    for (const [id, row] of rowById.entries()) {
      if (
        !isMemtSensitivity(row.sensitivity) ||
        !withinSensitivityCeiling(row.sensitivity, input.sensitivityCeiling)
      ) {
        continue;
      }
      const bm25Rank = bm25RankById.get(id) ?? null;
      const vectorRank = vectorRankById.get(id) ?? null;
      const cos = cosineById.get(id) ?? null;
      const coverage = lexicalCoverageById.get(id) ?? 0;

      let combinedScore = 0;
      if (bm25Rank !== null) {
        const lexFactor =
          coverage >= 0.55
            ? 0.85 + 0.3 * coverage
            : 0.16 + 1.25 * coverage;
        combinedScore += (1 / (rrfK + bm25Rank)) * lexFactor;
      }
      if (vectorRank !== null) {
        const clampedCos = Math.max(0, Math.min(1, cos ?? 0));
        combinedScore +=
          (1 / (rrfK + vectorRank)) * (0.45 + 0.55 * clampedCos) +
          0.022 * clampedCos * clampedCos;
      }

      if (
        bm25Rank !== null &&
        vectorRank !== null &&
        coverage >= 0.4 &&
        (cos ?? 0) >= 0.35
      ) {
        combinedScore *= 1.12;
      }

      const confidenceBoost = 0.5 + 0.5 * row.confidence;
      const useBoost = 1 + Math.min(0.15, Math.log1p(row.use_count) * 0.04);
      const finalScore =
        combinedScore *
        confidenceBoost *
        outcomeWeight(row.outcome as ExperienceOutcome) *
        recencyFactorFromMs(Date.parse(row.updated_at), nowMs) *
        useBoost;

      scoredHits.push({
        row,
        score: finalScore,
        bm25Rank,
        vectorRank,
        cosineSimilarity: cos,
      });
    }

    scoredHits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.row.updated_at.localeCompare(a.row.updated_at);
    });

    const diversityLambda =
      input.diversityLambda !== undefined && Number.isFinite(input.diversityLambda)
        ? Math.max(0, Math.min(1, input.diversityLambda))
        : 0.68;

    const selectedMeta =
      diversityLambda >= 1 || scoredHits.length <= 1 || limit <= 1
        ? scoredHits.slice(0, limit)
        : this.applyMmrDiversityMeta(scoredHits, limit, diversityLambda, activeVectorBucket);

    return selectedMeta.map((h) => ({
      experience: metaRowToExperience(h.row),
      score: h.score,
      bm25Rank: h.bm25Rank,
      vectorRank: h.vectorRank,
      cosineSimilarity: h.cosineSimilarity,
    }));
  }

  private applyMmrDiversityMeta<
    T extends { readonly row: ExperienceMetaRow; readonly score: number },
  >(
    sortedHits: readonly T[],
    limit: number,
    lambda: number,
    primaryBucket: VectorBucket | null,
  ): T[] {
    const poolSize = Math.min(sortedHits.length, Math.max(limit * 4, 24));
    const pool = sortedHits.slice(0, poolSize);
    const maxScore = pool[0]!.score;
    if (maxScore <= 0) return pool.slice(0, limit);

    const vecIndices = new Int32Array(poolSize).fill(-1);
    const tokenSets: (Set<string> | null)[] = new Array(poolSize).fill(null);
    const bucket = primaryBucket;
    const dim = bucket?.dim ?? 0;

    for (let i = 0; i < poolSize; i += 1) {
      const id = pool[i]!.row.id;
      if (bucket !== null) {
        const idx = bucket.indexById.get(id);
        if (idx !== undefined) {
          vecIndices[i] = idx;
          continue;
        }
      }
      const row = pool[i]!.row;
      tokenSets[i] = tokenizeNormalized(`${row.condition} ${row.recommendation}`);
    }

    const pairSimilarity = (i: number, j: number): number => {
      const vi = vecIndices[i]!;
      const vj = vecIndices[j]!;
      if (bucket !== null && vi >= 0 && vj >= 0) {
        const dot = unitDotPackedPair(bucket.data, vi * dim, bucket.data, vj * dim, dim);
        return dot > 0 ? dot : 0;
      }
      const ti =
        tokenSets[i] ??
        (tokenSets[i] = tokenizeNormalized(
          `${pool[i]!.row.condition} ${pool[i]!.row.recommendation}`,
        ));
      const tj =
        tokenSets[j] ??
        (tokenSets[j] = tokenizeNormalized(
          `${pool[j]!.row.condition} ${pool[j]!.row.recommendation}`,
        ));
      return jaccardSimilarity(ti, tj);
    };

    const selectedIndices: number[] = [0]; // Rank #1 strictly preserved
    const chosen = new Uint8Array(poolSize);
    chosen[0] = 1;
    const maxSimToSelected = new Float64Array(poolSize);

    for (let i = 1; i < poolSize; i += 1) {
      maxSimToSelected[i] = pairSimilarity(i, 0);
    }

    const excessThreshold = 0.42;
    const excessDenom = 1 - excessThreshold;

    while (selectedIndices.length < limit && selectedIndices.length < poolSize) {
      let bestIdx = -1;
      let bestMmr = -Infinity;

      for (let i = 1; i < poolSize; i += 1) {
        if (chosen[i] === 1) continue;
        const normRel = pool[i]!.score / maxScore;
        const rawSim = maxSimToSelected[i]!;
        const excess =
          rawSim <= excessThreshold ? 0 : (rawSim - excessThreshold) / excessDenom;
        const novelty = 1 - excess * excess;
        const mmr = lambda * normRel * novelty - (1 - lambda) * excess;
        if (mmr > bestMmr) {
          bestMmr = mmr;
          bestIdx = i;
        }
      }

      if (bestIdx < 0) break;
      chosen[bestIdx] = 1;
      selectedIndices.push(bestIdx);

      for (let i = 1; i < poolSize; i += 1) {
        if (chosen[i] === 1) continue;
        const sim = pairSimilarity(i, bestIdx);
        if (sim > maxSimToSelected[i]!) {
          maxSimToSelected[i] = sim;
        }
      }
    }

    return selectedIndices.map((idx) => pool[idx]!);
  }

  recordOutcome(
    id: string,
    outcome: ExperienceOutcome,
    options: MarkOutcomeOptions = {},
  ): ExperienceRecord | null {
    if (!(EXPERIENCE_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error(`invalid outcome: ${String(outcome)}`);
    }
    const existing = this.stmtGetByIdMeta.get(id);
    if (existing === null) return null;

    this.ensureWriteStatements();

    const now = options.now ?? new Date().toISOString();
    const nextConfidence =
      options.confidence !== undefined
        ? clampConfidence(options.confidence)
        : outcome === "verified"
          ? clampConfidence(Math.max(existing.confidence, 0.85))
          : outcome === "failed"
            ? clampConfidence(existing.confidence * 0.6)
            : existing.confidence;
    const nextVerification =
      options.verification !== undefined
        ? options.verification.trim()
        : existing.verification;
    const nextCitations =
      options.addCitations !== undefined
        ? mergeCitations(
            parseCitationsJson(existing.citations_json),
            options.addCitations,
          )
        : parseCitationsJson(existing.citations_json);
    const nextUseCount =
      existing.use_count + (options.incrementUseCount === true ? 1 : 0);

    const tx = this.db.transaction(() => {
      this.stmtUpdateOutcome!.run(
        outcome,
        nextConfidence,
        nextVerification,
        JSON.stringify(nextCitations),
        nextUseCount,
        now,
        id,
      );
      this.stmtDeleteFts!.run(id);
      this.stmtInsertFts!.run(
        id,
        existing.domain,
        existing.scope_key,
        existing.condition,
        existing.recommendation,
        nextVerification,
      );
      if (options.addCitations !== undefined && options.addCitations.length > 0) {
        this.indexExperienceSources(id, options.addCitations);
      }
    });
    tx();

    const sens: MemtSensitivity = isMemtSensitivity(existing.sensitivity)
      ? existing.sensitivity
      : "private";
    this.upsertVectorCacheEntry(
      id,
      existing.domain,
      existing.scope_key,
      sens,
      outcome,
      nextConfidence,
      nextUseCount,
      now,
      null,
    );
    if (outcome === "superseded") {
      const scopeKey = `${existing.domain}\0${existing.scope_key}`;
      const scopeEntries = this.dedupScopeCache.get(scopeKey);
      if (scopeEntries !== undefined) {
        const idx = scopeEntries.findIndex((e) => e.id === id);
        if (idx >= 0) scopeEntries.splice(idx, 1);
      }
      this.dedupScopeKeyById.delete(id);
    }

    return Object.freeze({
      id: existing.id,
      domain: existing.domain,
      scope_key: existing.scope_key,
      sensitivity: sens,
      condition: existing.condition,
      recommendation: existing.recommendation,
      verification: nextVerification,
      outcome,
      citations: Object.freeze(nextCitations),
      confidence: nextConfidence,
      use_count: nextUseCount,
      internalized_in_snapshot: existing.internalized_in_snapshot,
      has_embedding: existing.has_embedding !== 0,
      created_at: existing.created_at,
      updated_at: now,
    });
  }

  markVerified(
    id: string,
    options: MarkOutcomeOptions = {},
  ): ExperienceRecord | null {
    return this.recordOutcome(id, "verified", {
      ...options,
      incrementUseCount: options.incrementUseCount ?? true,
    });
  }

  getUninternalizedExperiences(
    filter: UninternalizedExperiencesFilter = {},
  ): ExperienceRecord[] {
    const clauses: string[] = [
      "e.internalized_in_snapshot IS NULL",
      "e.outcome IN ('verified', 'observed')",
    ];
    const params: SQLQueryBindings[] = [];

    if (filter.domain !== undefined && filter.domain.trim().length > 0) {
      clauses.push("e.domain = ?");
      params.push(filter.domain.trim());
    }
    if (filter.sensitivityCeiling !== undefined) {
      const allowed = allowedSensitivitiesForCeiling(filter.sensitivityCeiling);
      clauses.push(`e.sensitivity IN (${allowed.map(() => "?").join(", ")})`);
      params.push(...allowed);
    }
    if (filter.minConfidence !== undefined) {
      clauses.push("e.confidence >= ?");
      params.push(clampConfidence(filter.minConfidence));
    }

    const limit = Math.max(1, Math.min(1000, filter.limit ?? 200));
    const rows = this.db
      .query<ExperienceMetaRow, SQLQueryBindings[]>(
        `SELECT ${EXPERIENCE_META_COLS}
         FROM experiences e
         WHERE ${clauses.join(" AND ")}
         ORDER BY e.confidence DESC, e.updated_at ASC
         LIMIT ?`,
      )
      .all(...params, limit);

    return rows.map(metaRowToExperience);
  }

  markInternalized(
    experienceIds: readonly string[],
    snapshotName: string,
    now: string = new Date().toISOString(),
  ): number {
    if (experienceIds.length === 0) return 0;
    if (snapshotName.trim().length === 0) {
      throw new Error("snapshotName must be non-empty");
    }
    this.ensureWriteStatements();
    let updated = 0;
    const tx = this.db.transaction(() => {
      for (const id of experienceIds) {
        const res = this.stmtMarkInternalized!.run(snapshotName, now, id);
        updated += res.changes;
      }
    });
    tx();
    return updated;
  }

  purgeBySourceRefs(sourceRefs: readonly string[]): PurgeExperiencesResult {
    const canonicalTargets = new Set<string>();
    const targetVariants = new Set<string>();
    for (const ref of sourceRefs) {
      const canon = canonicalSourceRef(ref);
      if (canon.length > 0) canonicalTargets.add(canon);
      for (const variant of normalizeSourceRefVariants(ref)) {
        targetVariants.add(variant);
      }
    }
    if (targetVariants.size === 0) {
      return { purgedIds: [], purgedCount: 0 };
    }

    const toPurgeSet = new Set<string>();

    if (this.hasSourcesTable()) {
      // Query canonical refs (and raw variants for backward compat with any pre-existing rows)
      const targets = [...new Set([...canonicalTargets, ...targetVariants])];
      const chunkSize = 200;
      for (let i = 0; i < targets.length; i += chunkSize) {
        const slice = targets.slice(i, i + chunkSize);
        const placeholders = slice.map(() => "?").join(", ");
        const matched = this.db
          .query<{ experience_id: string }, string[]>(
            `SELECT DISTINCT experience_id FROM experience_sources WHERE source_ref IN (${placeholders})`,
          )
          .all(...slice);
        for (const row of matched) {
          toPurgeSet.add(row.experience_id);
        }
      }
    } else {
      const rows = this.db
        .query<{ id: string; citations_json: string }, []>(
          "SELECT id, citations_json FROM experiences WHERE citations_json != '[]'",
        )
        .all();

      for (const row of rows) {
        const citations = parseCitationsJson(row.citations_json);
        let matched = false;
        for (const citation of citations) {
          for (const variant of normalizeSourceRefVariants(citation)) {
            if (targetVariants.has(variant)) {
              matched = true;
              break;
            }
          }
          if (matched) break;
        }
        if (matched) {
          toPurgeSet.add(row.id);
        }
      }
    }

    const toPurge = [...toPurgeSet];

    if (toPurge.length > 0) {
      this.ensureWriteStatements();
      const tx = this.db.transaction(() => {
        for (const id of toPurge) {
          this.stmtDeleteExp!.run(id);
          this.stmtDeleteFts!.run(id);
        }
      });
      tx();

      for (const id of toPurge) {
        this.removeVectorCacheEntry(id);
        const scopeKey = this.dedupScopeKeyById.get(id);
        if (scopeKey !== undefined) {
          this.dedupScopeKeyById.delete(id);
          const entries = this.dedupScopeCache.get(scopeKey);
          if (entries !== undefined) {
            const idx = entries.findIndex((e) => e.id === id);
            if (idx >= 0) entries.splice(idx, 1);
          }
        }
      }
    }

    return {
      purgedIds: Object.freeze(toPurge),
      purgedCount: toPurge.length,
    };
  }

  getExperience(id: string): ExperienceRecord | null {
    const row = this.stmtGetByIdMeta.get(id);
    return row === null ? null : metaRowToExperience(row);
  }

  listExperiences(
    filter: {
      readonly domain?: string;
      readonly sensitivityCeiling?: MemtSensitivity;
      readonly limit?: number;
    } = {},
  ): ExperienceRecord[] {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (filter.domain !== undefined && filter.domain.trim().length > 0) {
      clauses.push("e.domain = ?");
      params.push(filter.domain.trim());
    }
    if (filter.sensitivityCeiling !== undefined) {
      const allowed = allowedSensitivitiesForCeiling(filter.sensitivityCeiling);
      clauses.push(`e.sensitivity IN (${allowed.map(() => "?").join(", ")})`);
      params.push(...allowed);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
    const rows = this.db
      .query<ExperienceMetaRow, SQLQueryBindings[]>(
        `SELECT ${EXPERIENCE_META_COLS} FROM experiences e ${where} ORDER BY e.updated_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map(metaRowToExperience);
  }

  countExperiences(
    filter: { readonly sensitivityCeiling?: MemtSensitivity } = {},
  ): ExperienceCountStats {
    let where = "";
    const params: string[] = [];
    if (filter.sensitivityCeiling !== undefined) {
      const allowed = allowedSensitivitiesForCeiling(filter.sensitivityCeiling);
      where = `WHERE sensitivity IN (${allowed.map(() => "?").join(", ")})`;
      params.push(...allowed);
    }

    const row = this.db
      .query<
        {
          total: number;
          verified: number | null;
          observed: number | null;
          failed: number | null;
          uninternalized: number | null;
        },
        string[]
      >(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN outcome = 'verified' THEN 1 ELSE 0 END) AS verified,
           SUM(CASE WHEN outcome = 'observed' THEN 1 ELSE 0 END) AS observed,
           SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN internalized_in_snapshot IS NULL AND outcome IN ('verified', 'observed') THEN 1 ELSE 0 END) AS uninternalized
         FROM experiences ${where}`,
      )
      .get(...params);

    return {
      total: row?.total ?? 0,
      uninternalized: row?.uninternalized ?? 0,
      verified: row?.verified ?? 0,
      observed: row?.observed ?? 0,
      failed: row?.failed ?? 0,
    };
  }

  close(): void {
    this.invalidateVectorCache();
    this.dedupScopeCache.clear();
    this.dedupScopeKeyById.clear();
    this.ftsStmtCache.clear();
    this.inStmtCache.clear();
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
