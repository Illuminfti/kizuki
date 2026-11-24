import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import {
  allowedSensitivitiesForCeiling,
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
  return new Set(norm.split(" ").filter((token) => token.length >= 2));
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
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
  const arr =
    vector instanceof Float32Array ? vector : Float32Array.from(vector);
  const bytes = new Uint8Array(arr.length * 4);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < arr.length; i += 1) {
    const val = arr[i];
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
  const count = bytes.byteLength / 4;
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i += 1) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

export function cosineSimilarity(
  a: Float32Array | readonly number[],
  b: Float32Array | readonly number[],
): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0 || !Number.isFinite(denom)) return 0;
  return dot / denom;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function parseCitationsJson(raw: string): string[] {
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

function rowToExperience(row: ExperienceRow): ExperienceRecord {
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
    has_embedding: row.embedding !== null && row.embedding.byteLength > 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

function tokenizeForFts5(raw: string): string[] {
  const matches = raw.match(/[\p{L}\p{N}_]+/gu);
  if (matches === null) return [];
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of matches) {
    const lower = token.toLowerCase();
    if (lower.length > 0 && !seen.has(lower)) {
      seen.add(lower);
      tokens.push(lower);
    }
    if (tokens.length >= 24) break;
  }
  return tokens;
}

function buildFts5MatchExpression(
  tokens: readonly string[],
  mode: "AND" | "OR",
): string {
  return tokens.map((token) => `"${token.replaceAll('"', "")}"`).join(` ${mode} `);
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

function recencyFactor(updatedAt: string, now: Date): number {
  const parsedMs = Date.parse(updatedAt);
  if (!Number.isFinite(parsedMs)) return 0.85;
  const ageDays = Math.max(0, (now.getTime() - parsedMs) / 86_400_000);
  const decay = Math.exp((-Math.LN2 * ageDays) / 90);
  return 0.75 + 0.25 * decay;
}

function mergeOutcomes(
  existing: ExperienceOutcome,
  incoming: ExperienceOutcome,
): ExperienceOutcome {
  if (incoming === "superseded" || incoming === "failed") return incoming;
  if (existing === "verified" || incoming === "verified") return "verified";
  return incoming;
}

export interface ExperienceBankOptions {
  readonly db?: Database;
  readonly dbPath?: string;
  readonly vaultPath?: string;
  readonly nearDuplicateThreshold?: number;
}

export class ExperienceBank {
  private readonly db: Database;
  private readonly ownsDb: boolean;
  private readonly nearDuplicateThreshold: number;

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

    const confidence = clampConfidence(
      input.confidence ?? (outcome === "verified" ? 0.85 : 0.6),
    );
    const citations = mergeCitations([], input.citations ?? []);
    const now = input.now ?? new Date().toISOString();
    const dedupKey = computeDedupKey(domain, scopeKey, condition, recommendation);
    const embeddingBlob =
      input.embedding !== undefined
        ? encodeFloat32Vector(input.embedding)
        : null;

    const candidates = this.db
      .query<ExperienceRow, [string, string]>(
        `SELECT * FROM experiences
         WHERE domain = ? AND scope_key = ? AND outcome != 'superseded'
         ORDER BY updated_at DESC
         LIMIT 100`,
      )
      .all(domain, scopeKey);

    let duplicateRow: ExperienceRow | null = null;
    const incomingTokens = tokenizeNormalized(`${condition} ${recommendation}`);

    for (const candidate of candidates) {
      if (candidate.dedup_key === dedupKey) {
        duplicateRow = candidate;
        break;
      }
      const existingTokens = tokenizeNormalized(
        `${candidate.condition} ${candidate.recommendation}`,
      );
      if (
        jaccardSimilarity(incomingTokens, existingTokens) >=
        this.nearDuplicateThreshold
      ) {
        duplicateRow = candidate;
        break;
      }
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
      const mergedEmbedding = embeddingBlob ?? duplicateRow.embedding;

      const tx = this.db.transaction(() => {
        this.db
          .query(
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
          )
          .run(
            mergedSensitivity,
            mergedVerification,
            mergedOutcome,
            JSON.stringify(mergedCitations),
            mergedConfidence,
            mergedUseCount,
            mergedEmbedding,
            now,
            duplicateRow.id,
          );

        this.db
          .query("DELETE FROM experiences_fts WHERE id = ?")
          .run(duplicateRow.id);
        this.db
          .query(
            `INSERT INTO experiences_fts (id, domain, scope_key, condition, recommendation, verification)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            duplicateRow.id,
            duplicateRow.domain,
            duplicateRow.scope_key,
            duplicateRow.condition,
            duplicateRow.recommendation,
            mergedVerification,
          );
      });
      tx();

      const updated = this.getExperience(duplicateRow.id)!;
      return {
        experience: updated,
        deduplicated: true,
        mergedIntoId: duplicateRow.id,
      };
    }

    const id = input.id?.trim() || generateExperienceId();
    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO experiences (
            id, domain, scope_key, sensitivity, condition, recommendation,
            verification, outcome, citations_json, confidence, use_count,
            internalized_in_snapshot, embedding, dedup_key, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?)`,
        )
        .run(
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
          now,
        );

      this.db
        .query(
          `INSERT INTO experiences_fts (id, domain, scope_key, condition, recommendation, verification)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, domain, scopeKey, condition, recommendation, verification);
    });
    tx();

    const created = this.getExperience(id)!;
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
    const allowedSens = allowedSensitivitiesForCeiling(input.sensitivityCeiling);
    const allowedOutcomes: readonly ExperienceOutcome[] =
      input.outcomes ?? ["verified", "observed", "failed"];

    if (allowedOutcomes.length === 0) return [];

    const sensPlaceholders = allowedSens.map(() => "?").join(", ");
    const outcomePlaceholders = allowedOutcomes.map(() => "?").join(", ");

    const baseFilters: string[] = [
      `e.sensitivity IN (${sensPlaceholders})`,
      `e.outcome IN (${outcomePlaceholders})`,
    ];
    const baseParams: (string | number)[] = [...allowedSens, ...allowedOutcomes];
    if (input.domain !== undefined && input.domain.trim().length > 0) {
      baseFilters.push("e.domain = ?");
      baseParams.push(input.domain.trim());
    }
    if (input.scopeKey !== undefined && input.scopeKey.trim().length > 0) {
      baseFilters.push("e.scope_key = ?");
      baseParams.push(input.scopeKey.trim());
    }
    const whereClause = baseFilters.join(" AND ");

    const bm25RankById = new Map<string, number>();
    const rowById = new Map<string, ExperienceRow>();
    const tokens = tokenizeForFts5(input.query);

    const runFts = (expr: string, cap: number): ExperienceRow[] =>
      this.db
        .query<ExperienceRow, (string | number)[]>(
          `SELECT e.*
           FROM experiences_fts f
           JOIN experiences e ON e.id = f.id
           WHERE experiences_fts MATCH ? AND ${whereClause}
           ORDER BY bm25(experiences_fts) ASC
           LIMIT ?`,
        )
        .all(expr, ...baseParams, cap);

    if (tokens.length > 0) {
      const fetchCap = Math.min(200, Math.max(limit * 4, 25));
      const lexicalRows = runFts(buildFts5MatchExpression(tokens, "AND"), fetchCap);
      if (lexicalRows.length < limit && tokens.length > 1) {
        const seen = new Set(lexicalRows.map((r) => r.id));
        const orRows = runFts(buildFts5MatchExpression(tokens, "OR"), fetchCap);
        for (const row of orRows) {
          if (!seen.has(row.id)) {
            lexicalRows.push(row);
            seen.add(row.id);
          }
        }
      }
      lexicalRows.forEach((row, index) => {
        if (
          isMemtSensitivity(row.sensitivity) &&
          withinSensitivityCeiling(row.sensitivity, input.sensitivityCeiling)
        ) {
          bm25RankById.set(row.id, index + 1);
          rowById.set(row.id, row);
        }
      });
    }

    const vectorRankById = new Map<string, number>();
    const cosineById = new Map<string, number>();
    if (input.queryVector !== undefined && input.queryVector.length > 0) {
      const vecRows = this.db
        .query<ExperienceRow, (string | number)[]>(
          `SELECT e.*
           FROM experiences e
           WHERE e.embedding IS NOT NULL AND ${whereClause}`,
        )
        .all(...baseParams);

      const scoredVec: { row: ExperienceRow; sim: number }[] = [];
      for (const row of vecRows) {
        if (row.embedding === null) continue;
        const vec = decodeFloat32Vector(row.embedding);
        if (vec.length !== input.queryVector.length) continue;
        const sim = cosineSimilarity(input.queryVector, vec);
        if (sim > 0) {
          scoredVec.push({ row, sim });
        }
      }
      scoredVec.sort((a, b) => b.sim - a.sim);
      scoredVec.forEach((entry, index) => {
        vectorRankById.set(entry.row.id, index + 1);
        cosineById.set(entry.row.id, entry.sim);
        if (!rowById.has(entry.row.id)) {
          rowById.set(entry.row.id, entry.row);
        }
      });
    }

    if (tokens.length === 0 && input.queryVector === undefined) {
      const fallbackRows = this.db
        .query<ExperienceRow, (string | number)[]>(
          `SELECT e.*
           FROM experiences e
           WHERE ${whereClause}
           ORDER BY e.confidence DESC, e.use_count DESC, e.updated_at DESC
           LIMIT ?`,
        )
        .all(...baseParams, limit);
      return fallbackRows.map((row, index) => {
        const exp = rowToExperience(row);
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

    const hits: ExperienceSearchHit[] = [];
    for (const [id, row] of rowById.entries()) {
      const exp = rowToExperience(row);
      if (!withinSensitivityCeiling(exp.sensitivity, input.sensitivityCeiling)) {
        continue;
      }
      const bm25Rank = bm25RankById.get(id) ?? null;
      const vectorRank = vectorRankById.get(id) ?? null;
      const cos = cosineById.get(id) ?? null;

      let rrfScore = 0;
      if (bm25Rank !== null) rrfScore += 1 / (rrfK + bm25Rank);
      if (vectorRank !== null) rrfScore += 1 / (rrfK + vectorRank);

      const confidenceBoost = 0.5 + 0.5 * exp.confidence;
      const useBoost = 1 + Math.min(0.15, Math.log1p(exp.use_count) * 0.04);
      const finalScore =
        rrfScore *
        confidenceBoost *
        outcomeWeight(exp.outcome) *
        recencyFactor(exp.updated_at, now) *
        useBoost;

      hits.push({
        experience: exp,
        score: finalScore,
        bm25Rank,
        vectorRank,
        cosineSimilarity: cos,
      });
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.experience.updated_at.localeCompare(a.experience.updated_at);
    });

    return hits.slice(0, limit);
  }

  recordOutcome(
    id: string,
    outcome: ExperienceOutcome,
    options: MarkOutcomeOptions = {},
  ): ExperienceRecord | null {
    if (!(EXPERIENCE_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new Error(`invalid outcome: ${String(outcome)}`);
    }
    const existing = this.db
      .query<ExperienceRow, [string]>("SELECT * FROM experiences WHERE id = ?")
      .get(id);
    if (existing === null) return null;

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
      this.db
        .query(
          `UPDATE experiences
           SET outcome = ?,
               confidence = ?,
               verification = ?,
               citations_json = ?,
               use_count = ?,
               updated_at = ?
           WHERE id = ?`,
        )
        .run(
          outcome,
          nextConfidence,
          nextVerification,
          JSON.stringify(nextCitations),
          nextUseCount,
          now,
          id,
        );

      this.db.query("DELETE FROM experiences_fts WHERE id = ?").run(id);
      this.db
        .query(
          `INSERT INTO experiences_fts (id, domain, scope_key, condition, recommendation, verification)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          existing.domain,
          existing.scope_key,
          existing.condition,
          existing.recommendation,
          nextVerification,
        );
    });
    tx();

    return this.getExperience(id);
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
      "internalized_in_snapshot IS NULL",
      "outcome IN ('verified', 'observed')",
    ];
    const params: (string | number)[] = [];

    if (filter.domain !== undefined && filter.domain.trim().length > 0) {
      clauses.push("domain = ?");
      params.push(filter.domain.trim());
    }
    if (filter.sensitivityCeiling !== undefined) {
      const allowed = allowedSensitivitiesForCeiling(filter.sensitivityCeiling);
      clauses.push(`sensitivity IN (${allowed.map(() => "?").join(", ")})`);
      params.push(...allowed);
    }
    if (filter.minConfidence !== undefined) {
      clauses.push("confidence >= ?");
      params.push(clampConfidence(filter.minConfidence));
    }

    const limit = Math.max(1, Math.min(1000, filter.limit ?? 200));
    const rows = this.db
      .query<ExperienceRow, (string | number)[]>(
        `SELECT * FROM experiences
         WHERE ${clauses.join(" AND ")}
         ORDER BY confidence DESC, updated_at ASC
         LIMIT ?`,
      )
      .all(...params, limit);

    return rows.map(rowToExperience);
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
    let updated = 0;
    const tx = this.db.transaction(() => {
      const stmt = this.db.query(
        "UPDATE experiences SET internalized_in_snapshot = ?, updated_at = ? WHERE id = ?",
      );
      for (const id of experienceIds) {
        const res = stmt.run(snapshotName, now, id);
        updated += res.changes;
      }
    });
    tx();
    return updated;
  }

  purgeBySourceRefs(sourceRefs: readonly string[]): PurgeExperiencesResult {
    const targetVariants = new Set<string>();
    for (const ref of sourceRefs) {
      for (const variant of normalizeSourceRefVariants(ref)) {
        targetVariants.add(variant);
      }
    }
    if (targetVariants.size === 0) {
      return { purgedIds: [], purgedCount: 0 };
    }

    const rows = this.db
      .query<{ id: string; citations_json: string }, []>(
        "SELECT id, citations_json FROM experiences",
      )
      .all();

    const toPurge: string[] = [];
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
        toPurge.push(row.id);
      }
    }

    if (toPurge.length > 0) {
      const tx = this.db.transaction(() => {
        const delMain = this.db.query("DELETE FROM experiences WHERE id = ?");
        const delFts = this.db.query("DELETE FROM experiences_fts WHERE id = ?");
        for (const id of toPurge) {
          delMain.run(id);
          delFts.run(id);
        }
      });
      tx();
    }

    return {
      purgedIds: Object.freeze(toPurge),
      purgedCount: toPurge.length,
    };
  }

  getExperience(id: string): ExperienceRecord | null {
    const row = this.db
      .query<ExperienceRow, [string]>("SELECT * FROM experiences WHERE id = ?")
      .get(id);
    return row === null ? null : rowToExperience(row);
  }

  listExperiences(
    filter: {
      readonly domain?: string;
      readonly sensitivityCeiling?: MemtSensitivity;
      readonly limit?: number;
    } = {},
  ): ExperienceRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.domain !== undefined && filter.domain.trim().length > 0) {
      clauses.push("domain = ?");
      params.push(filter.domain.trim());
    }
    if (filter.sensitivityCeiling !== undefined) {
      const allowed = allowedSensitivitiesForCeiling(filter.sensitivityCeiling);
      clauses.push(`sensitivity IN (${allowed.map(() => "?").join(", ")})`);
      params.push(...allowed);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(1000, filter.limit ?? 100));
    const rows = this.db
      .query<ExperienceRow, (string | number)[]>(
        `SELECT * FROM experiences ${where} ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(...params, limit);
    return rows.map(rowToExperience);
  }

  countExperiences(): { total: number; uninternalized: number } {
    const totalRow = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM experiences")
      .get();
    const unintRow = this.db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM experiences WHERE internalized_in_snapshot IS NULL AND outcome IN ('verified', 'observed')",
      )
      .get();
    return {
      total: totalRow?.count ?? 0,
      uninternalized: unintRow?.count ?? 0,
    };
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
