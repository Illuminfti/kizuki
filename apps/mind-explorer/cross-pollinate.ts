import type { CodexItem, KizukiCodexApi } from "./codex-api.ts";
import type { KizukiTasteApi, TasteAnswerHistoryItem, TasteDomainId, TasteRule } from "./taste-api.ts";
import type { KizukiTasteGardenerApi } from "./gardener-api.ts";

export const DEFAULT_EMBED_URL = process.env.KIZUKI_EMBED_URL || "http://127.0.0.1:8789/v1/embeddings";
export const DEFAULT_EMBED_MODEL = process.env.KIZUKI_EMBED_MODEL || "BAAI/bge-small-en-v1.5";
export const MAX_VECTOR_CACHE_ENTRIES = 12_000;
export const EMBED_DIMS = 384;
export const SEMANTIC_REINFORCE_THRESHOLD = 0.82;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LocalEmbedderConfig {
  embedUrl?: string;
  model?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxEntries?: number;
  enabled?: boolean;
}

export interface EmbedderStats {
  cachedVectors: number;
  maxEntries: number;
  estimatedBytes: number;
  available: boolean | null;
  lastError: string | null;
  requests: number;
  cacheHits: number;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "your", "their",
  "have", "has", "had", "are", "was", "were", "will", "should", "must", "only", "when", "where",
  "what", "which", "who", "how", "why", "all", "any", "not", "but", "can", "use", "used", "using",
  "make", "made", "more", "most", "less", "very", "just", "than", "then", "also", "each", "every",
  "about", "before", "after", "between", "through", "without", "never", "always", "avoid", "prefer",
]);

export function stripEmDashesSafe(input: string): string {
  if (!input) return "";
  return input
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2014/g, "-")
    .replace(/\s*\u2013\s*/g, " - ")
    .replace(/\u2013/g, "-");
}

export function normalizeTextKey(text: string): string {
  return stripEmDashesSafe(text).replace(/\s+/g, " ").trim().slice(0, 1600);
}

export function hashContent(text: string): string {
  const norm = normalizeTextKey(text);
  if (typeof Bun !== "undefined" && typeof Bun.hash === "function") {
    return Bun.hash(norm).toString(36);
  }
  let h = 2166136261;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function tokenizeForSearch(input: string): string[] {
  const clean = stripEmDashesSafe(input || "").toLowerCase();
  const raw = clean.match(/[a-z0-9][a-z0-9_-]{1,}/g) || [];
  const out: string[] = [];
  for (const tok of raw) {
    if (tok.length < 2) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
    if (tok.includes("-") || tok.includes("_")) {
      for (const part of tok.split(/[-_]+/)) {
        if (part.length >= 2 && !STOPWORDS.has(part)) {
          out.push(part);
        }
      }
    }
  }
  return out;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i];
    const bv = b[i];
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function buildIdfMap(docTokensList: string[][]): Map<string, number> {
  const df = new Map<string, number>();
  const n = Math.max(1, docTokensList.length);
  for (const tokens of docTokensList) {
    const uniq = new Set(tokens);
    for (const t of uniq) {
      df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [tok, count] of df.entries()) {
    idf.set(tok, Math.log((n + 1) / (count + 1)) + 1);
  }
  return idf;
}

export function computeTfidfCosine(tokensA: string[], tokensB: string[], idf: Map<string, number>): number {
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const tfA = new Map<string, number>();
  for (const t of tokensA) tfA.set(t, (tfA.get(t) || 0) + 1);
  const tfB = new Map<string, number>();
  for (const t of tokensB) tfB.set(t, (tfB.get(t) || 0) + 1);

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (const [t, cA] of tfA.entries()) {
    const w = idf.get(t) || 1;
    const valA = (1 + Math.log(cA)) * w;
    normA += valA * valA;
    const cB = tfB.get(t);
    if (cB) {
      const valB = (1 + Math.log(cB)) * w;
      dot += valA * valB;
    }
  }

  for (const [t, cB] of tfB.entries()) {
    const w = idf.get(t) || 1;
    const valB = (1 + Math.log(cB)) * w;
    normB += valB * valB;
  }

  if (normA <= 0 || normB <= 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function assertLoopbackEmbedUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid embedUrl: ${rawUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(`Refusing non-loopback embedUrl host: ${host}`);
  }
}

export class LocalEmbedder {
  readonly embedUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly maxEntries: number;
  readonly enabled: boolean;

  private readonly fetchImpl: FetchLike;
  // Strictly in-memory LRU cache keyed by content hash. Never persisted to disk.
  private readonly cache = new Map<string, Float32Array>();
  private available: boolean | null = null;
  private lastError: string | null = null;
  private unavailableUntil = 0;
  private requests = 0;
  private cacheHits = 0;

  constructor(config: LocalEmbedderConfig = {}) {
    this.embedUrl = config.embedUrl || DEFAULT_EMBED_URL;
    assertLoopbackEmbedUrl(this.embedUrl);
    this.model = config.model || DEFAULT_EMBED_MODEL;
    this.timeoutMs = Math.max(150, config.timeoutMs ?? 2500);
    this.maxEntries = Math.max(64, Math.min(MAX_VECTOR_CACHE_ENTRIES, config.maxEntries ?? MAX_VECTOR_CACHE_ENTRIES));
    this.enabled = config.enabled !== false;
    this.fetchImpl = config.fetchImpl || fetch;
  }

  getStats(): EmbedderStats {
    const bytesPerEntry = EMBED_DIMS * 4 + 48;
    return {
      cachedVectors: this.cache.size,
      maxEntries: this.maxEntries,
      estimatedBytes: this.cache.size * bytesPerEntry,
      available: this.available,
      lastError: this.lastError,
      requests: this.requests,
      cacheHits: this.cacheHits,
    };
  }

  clearCache(): void {
    this.cache.clear();
  }

  getCached(text: string): Float32Array | null {
    const key = hashContent(text);
    const hit = this.cache.get(key);
    if (!hit) return null;
    // Refresh LRU order
    this.cache.delete(key);
    this.cache.set(key, hit);
    this.cacheHits += 1;
    return hit;
  }

  private setCached(key: string, vec: Float32Array): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, vec);
  }

  async embedBatch(texts: string[], opts?: { timeoutMs?: number }): Promise<Array<Float32Array | null>> {
    if (!this.enabled || texts.length === 0) {
      return texts.map(() => null);
    }

    const keys = texts.map((t) => hashContent(t));
    const normTexts = texts.map((t) => normalizeTextKey(t));
    const result: Array<Float32Array | null> = new Array(texts.length).fill(null);

    const missingIndices: number[] = [];
    const missingUnique = new Map<string, { text: string; positions: number[] }>();

    for (let i = 0; i < texts.length; i++) {
      const key = keys[i];
      const hit = this.cache.get(key);
      if (hit) {
        this.cache.delete(key);
        this.cache.set(key, hit);
        this.cacheHits += 1;
        result[i] = hit;
      } else if (normTexts[i].length > 0) {
        const entry = missingUnique.get(key);
        if (entry) {
          entry.positions.push(i);
        } else {
          missingUnique.set(key, { text: normTexts[i], positions: [i] });
          missingIndices.push(i);
        }
      }
    }

    if (missingUnique.size === 0) {
      return result;
    }

    const now = Date.now();
    if (this.unavailableUntil > now) {
      return result;
    }

    const toFetch = Array.from(missingUnique.entries());
    const batchSize = 32;
    const timeoutMs = Math.max(150, opts?.timeoutMs ?? this.timeoutMs);

    for (let offset = 0; offset < toFetch.length; offset += batchSize) {
      const slice = toFetch.slice(offset, offset + batchSize);
      const inputs = slice.map(([, item]) => item.text);
      try {
        this.requests += 1;
        const resp = await this.fetchImpl(this.embedUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, input: inputs }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!resp.ok) {
          throw new Error(`Embed HTTP ${resp.status}`);
        }
        const json = (await resp.json()) as {
          data?: Array<{ index?: number; embedding?: number[] }>;
        };
        if (!json || !Array.isArray(json.data)) {
          throw new Error("Invalid embedding response shape");
        }
        this.available = true;
        this.lastError = null;
        this.unavailableUntil = 0;

        for (let j = 0; j < json.data.length; j++) {
          const item = json.data[j];
          const idx = typeof item.index === "number" ? item.index : j;
          if (idx < 0 || idx >= slice.length || !Array.isArray(item.embedding)) continue;
          const [key, meta] = slice[idx];
          const f32 = Float32Array.from(item.embedding);
          this.setCached(key, f32);
          for (const pos of meta.positions) {
            result[pos] = f32;
          }
        }
      } catch (err) {
        this.available = false;
        this.lastError = stripEmDashesSafe(err instanceof Error ? err.message : String(err)).slice(0, 180);
        // Short backoff (5s) so unit tests or transient restarts recover fast without spamming
        this.unavailableUntil = Date.now() + 5_000;
        break;
      }
    }

    return result;
  }

  async embedSingle(text: string, opts?: { timeoutMs?: number }): Promise<Float32Array | null> {
    const arr = await this.embedBatch([text], opts);
    return arr[0] || null;
  }
}

// ============================================================================
// Cross-Pollination Types & Scoring
// ============================================================================

export type CrosslinkKind = "reinforces" | "conflicts";
export type CrosslinkSubkind = "alignment" | "guardrail" | "contradiction";

export interface CrosslinkItem {
  id: string;
  taste_rule_id: string;
  taste_domain: TasteDomainId;
  taste_polarity: "prefer" | "avoid";
  taste_rule: string;
  codex_id: string;
  codex_section: string;
  codex_title: string;
  codex_domain: string;
  kind: CrosslinkKind;
  subkind: CrosslinkSubkind;
  score: number;
  semantic_score: number;
  lexical_score: number;
  evidence: string;
  source: "embedding" | "tfidf";
}

export interface CrosslinkRef {
  id: string;
  target_kind: "codex" | "taste";
  target_id: string;
  target_title: string;
  target_domain: string;
  kind: CrosslinkKind;
  subkind: CrosslinkSubkind;
  score: number;
  evidence: string;
}

export interface CodexDraftProposal {
  id: string;
  kind: "codex_draft";
  taste_domain: TasteDomainId;
  domain_label: string;
  agreeing_count: number;
  trait_tags: string[];
  proposed_title: string;
  proposed_section: "philosophies";
  proposed_thesis: string;
  proposed_summary: string;
  evidence: string[];
}

export interface TasteQuestionProposal {
  id: string;
  kind: "taste_question";
  codex_id: string;
  codex_title: string;
  codex_domain: string;
  suggested_taste_domain: TasteDomainId;
  proposed_question: string;
  proposed_axis: string;
  evidence: string[];
}

export type CrosslinkProposal = CodexDraftProposal | TasteQuestionProposal;

export interface CrosslinksResponse {
  ok: true;
  kind: "taste" | "codex" | "all";
  generated_at: string;
  source: "embedding" | "tfidf";
  total: number;
  links: CrosslinkItem[];
  proposals: CrosslinkProposal[];
  stats: {
    total_links: number;
    reinforces: number;
    conflicts: number;
    guardrails: number;
    codex_draft_proposals: number;
    taste_question_proposals: number;
    taste_rules_scanned: number;
    codex_items_scanned: number;
  };
}

export interface CrossPollinatorConfig {
  codexApi: KizukiCodexApi;
  tasteApi: KizukiTasteApi;
  gardenerApi?: KizukiTasteGardenerApi | null;
  embedder?: LocalEmbedder;
  reinforceThreshold?: number;
}

const TASTE_DOMAIN_LABELS: Record<TasteDomainId, string> = {
  ui_product: "UI & Product Craft",
  typography_copy: "Typography & Copy Voice",
  visual_brand: "Visual & Brand Direction",
  motion_feel: "Motion & Interaction",
  video_anime: "Film, Video & Anime",
  merch_objects: "Personal Style, Merch & Objects",
  spaces_life: "Spaces, Travel & Experiences",
  agent_ops: "Agent Behavior & Reasoning",
};

const TASTE_TO_CODEX_AFFINITY_RE: Record<TasteDomainId, RegExp> = {
  ui_product: /\b(ui|ux|product|interface|dashboard|surface|hairline|consumer|revolut|linear|density|frontend|layout|design)\b/i,
  typography_copy: /\b(typography|typeface|font|copy|voice|writing|em-?dash|corpse|specificity|polish|editorial|tracking|headline|anti-?pattern)\b/i,
  visual_brand: /\b(brand|visual|color|colour|composition|negative space|swiss|gradient|lava-?lamp|anti-?pattern|craft|aesthetic|taste)\b/i,
  motion_feel: /\b(motion|animation|spring|easing|physics|fps|telemetry|interactive|choreograph|tactile|pulse)\b/i,
  video_anime: /\b(anime|video|film|cinema|satsuei|grading|sound|camera|seedance|cel|live2d|vrm)\b/i,
  merch_objects: /\b(merch|apparel|object|hardware|packaging|gift|physical|wearable|garment|desk)\b/i,
  spaces_life: /\b(travel|trip|london|theatre|hotel|dining|accessible|family|home|space)\b/i,
  agent_ops: /\b(agent|autonomy|harness|gate|verification|proof|boil the ocean|operator|codex|claude|daemon|kizuki|anchor|rule)\b/i,
};

function inferTasteDomainForCodex(item: CodexItem): TasteDomainId {
  const hay = `${item.title} ${item.subtitle} ${item.domain} ${item.tags.join(" ")} ${item.summary}`;
  let best: TasteDomainId = "agent_ops";
  let bestHits = 0;
  for (const [dom, re] of Object.entries(TASTE_TO_CODEX_AFFINITY_RE) as Array<[TasteDomainId, RegExp]>) {
    const matches = hay.match(new RegExp(re.source, "gi"));
    const hits = matches ? matches.length : 0;
    if (hits > bestHits) {
      bestHits = hits;
      best = dom;
    }
  }
  return best;
}

function computeDomainAffinity(tasteDomain: TasteDomainId, item: CodexItem): number {
  const re = TASTE_TO_CODEX_AFFINITY_RE[tasteDomain];
  if (!re) return 0;
  const primary = `${item.title} ${item.domain} ${item.tags.join(" ")}`;
  const secondary = `${item.subtitle} ${item.summary} ${item.thesis || ""} ${item.anti_pattern || ""}`;
  const m1 = primary.match(new RegExp(re.source, "gi"));
  const m2 = secondary.match(new RegExp(re.source, "gi"));
  const primaryHits = m1 ? m1.length : 0;
  const secondaryHits = m2 ? m2.length : 0;
  if (primaryHits >= 2) return 1.0;
  if (primaryHits === 1) return secondaryHits >= 1 ? 0.85 : 0.7;
  if (secondaryHits >= 2) return 0.55;
  if (secondaryHits === 1) return 0.3;
  return 0;
}

function buildRuleEmbedText(rule: TasteRule): string {
  const domLabel = TASTE_DOMAIN_LABELS[rule.domain] || rule.domain;
  const polarityTag = rule.polarity === "avoid" ? "AVOID" : "PREFER";
  const reason = rule.reason ? ` ${rule.reason}` : "";
  return normalizeTextKey(`${domLabel} ${polarityTag}: ${rule.rule}${reason}`);
}

function buildCodexEmbedText(item: CodexItem): string {
  const parts = [
    item.title,
    item.subtitle,
    item.domain,
    item.thesis || "",
    item.summary,
    item.anti_pattern ? `Anti-pattern: ${item.anti_pattern}` : "",
    item.tags.length > 0 ? `Tags: ${item.tags.join(", ")}` : "",
  ].filter(Boolean);
  return normalizeTextKey(parts.join(". "));
}

function extractForbiddenSubjectTokens(ruleText: string): string[] {
  // Strip negation framing so we isolate what the AVOID rule forbids
  const stripped = stripEmDashesSafe(ruleText)
    .toLowerCase()
    .replace(/\b(?:never|zero|no|avoid|do not|don't|stop|forbid|ban|banned|without)\b/g, " ");
  return tokenizeForSearch(stripped);
}

function classifyLinkRelation(
  rule: TasteRule,
  item: CodexItem,
): { kind: CrosslinkKind; subkind: CrosslinkSubkind; note: string } {
  if (rule.polarity !== "avoid") {
    return {
      kind: "reinforces",
      subkind: "alignment",
      note: "Prefer rule reinforces Codex principle",
    };
  }

  // Distinguish anti-pattern reinforcement (guardrail) vs direct contradiction (conflict):
  // 1. If the Codex item's anti_pattern or ban/discipline framing rejects the same forbidden tokens,
  //    the AVOID rule is a reinforcing guardrail.
  // 2. If the Codex item's thesis/title/summary endorses the forbidden tokens without banning them,
  //    flag as direct conflict!
  const forbiddenTokens = extractForbiddenSubjectTokens(rule.rule);
  const antiText = `${item.anti_pattern || ""}`.toLowerCase();
  const titleAndThesis = `${item.title} ${item.subtitle} ${item.thesis || ""} ${item.summary}`.toLowerCase();
  const hasDisciplineFraming =
    /\b(anti-?pattern|discipline|ban|bans|never|zero|avoid|forbid|standards?|craft|proof-?first|specificity)\b/i.test(
      `${item.title} ${item.subtitle} ${item.tags.join(" ")} ${item.anti_pattern || ""}`
    );

  let antiOverlap = 0;
  let endorseOverlap = 0;
  for (const tok of forbiddenTokens) {
    if (tok.length < 3) continue;
    if (antiText.includes(tok)) antiOverlap += 1;
    if (titleAndThesis.includes(tok)) endorseOverlap += 1;
  }

  // Direct contradiction: Codex principle promotes/endorses the forbidden concept and does NOT ban it in anti_pattern
  if (endorseOverlap > 0 && antiOverlap === 0 && !hasDisciplineFraming) {
    return {
      kind: "conflicts",
      subkind: "contradiction",
      note: "AVOID rule conflicts with Codex principle direction",
    };
  }

  // Anti-pattern reinforcement: Codex item shares discipline or anti_pattern guardrails
  if (antiOverlap > 0 || hasDisciplineFraming) {
    return {
      kind: "reinforces",
      subkind: "guardrail",
      note: "AVOID guardrail reinforces Codex craft standard",
    };
  }

  // Default for an AVOID rule matching a non-guardrail principle topic
  return {
    kind: "conflicts",
    subkind: "contradiction",
    note: "AVOID rule flags tension against Codex principle",
  };
}

export class CrossPollinator {
  readonly codexApi: KizukiCodexApi;
  readonly tasteApi: KizukiTasteApi;
  readonly gardenerApi: KizukiTasteGardenerApi | null;
  readonly embedder: LocalEmbedder;
  readonly reinforceThreshold: number;

  private cachedResponse: CrosslinksResponse | null = null;
  private cachedFingerprint = "";
  private linksByCodexId = new Map<string, CrosslinkRef[]>();
  private linksByTasteId = new Map<string, CrosslinkRef[]>();
  private inflight: Promise<CrosslinksResponse> | null = null;

  constructor(config: CrossPollinatorConfig) {
    this.codexApi = config.codexApi;
    this.tasteApi = config.tasteApi;
    this.gardenerApi = config.gardenerApi || null;
    this.embedder = config.embedder || new LocalEmbedder();
    this.reinforceThreshold = config.reinforceThreshold ?? SEMANTIC_REINFORCE_THRESHOLD;
  }

  private getRulesAndPrinciples(): {
    rules: TasteRule[];
    codexItems: CodexItem[];
    answeredHistory: TasteAnswerHistoryItem[];
    fingerprint: string;
  } {
    const tasteState = this.tasteApi.getTasteState();
    const rules: TasteRule[] = [...tasteState.rules.prefer, ...tasteState.rules.avoid];
    const codexResp = this.codexApi.getCodex();
    // Focus primarily on philosophies + pinned/core craft principles + recent owner captures
    const codexItems = codexResp.items.filter(
      (i) => i.status !== "archived" && (i.section === "philosophies" || i.origin === "owner" || i.pinned)
    );
    const fingerprint = [
      rules.length,
      tasteState.answered_history.length,
      codexItems.length,
      rules.map((r) => `${r.id}:${r.rule.length}`).join("|"),
      codexItems.map((c) => `${c.id}:${c.updated_at}`).join("|"),
    ].join("#");

    return {
      rules,
      codexItems,
      answeredHistory: tasteState.answered_history,
      fingerprint,
    };
  }

  getCachedCrosslinks(): CrosslinksResponse | null {
    return this.cachedResponse;
  }

  getLinksForCodexItem(id: string): CrosslinkRef[] {
    return this.linksByCodexId.get(id) || [];
  }

  getLinksForTasteRule(id: string): CrosslinkRef[] {
    return this.linksByTasteId.get(id) || [];
  }

  getDomainSummaryLines(domain: TasteDomainId): string[] {
    if (!this.cachedResponse) return [];
    return this.cachedResponse.links
      .filter((l) => l.taste_domain === domain)
      .slice(0, 6)
      .map(
        (l) =>
          `[${l.kind}/${l.subkind} ${l.score.toFixed(2)}] Taste(${l.taste_polarity}): "${l.taste_rule.slice(0, 90)}" <-> Codex "${l.codex_title}"`
      );
  }

  attachToApis(): void {
    this.codexApi.setCrosslinksProvider(() => this.linksByCodexId);
    this.tasteApi.setCrosslinksProvider(() => this.linksByTasteId);
    if (this.gardenerApi) {
      this.gardenerApi.setCrosslinksSummaryProvider((domain) => this.getDomainSummaryLines(domain));
    }
  }

  private rebuildIndexes(links: CrosslinkItem[]): void {
    const byCodex = new Map<string, CrosslinkRef[]>();
    const byTaste = new Map<string, CrosslinkRef[]>();

    for (const link of links) {
      const codexList = byCodex.get(link.codex_id) || [];
      codexList.push({
        id: link.id,
        target_kind: "taste",
        target_id: link.taste_rule_id,
        target_title: link.taste_rule,
        target_domain: link.taste_domain,
        kind: link.kind,
        subkind: link.subkind,
        score: link.score,
        evidence: link.evidence,
      });
      byCodex.set(link.codex_id, codexList);

      const tasteList = byTaste.get(link.taste_rule_id) || [];
      tasteList.push({
        id: link.id,
        target_kind: "codex",
        target_id: link.codex_id,
        target_title: link.codex_title,
        target_domain: link.codex_domain,
        kind: link.kind,
        subkind: link.subkind,
        score: link.score,
        evidence: link.evidence,
      });
      byTaste.set(link.taste_rule_id, tasteList);
    }

    this.linksByCodexId = byCodex;
    this.linksByTasteId = byTaste;
  }

  async computeCrosslinks(opts?: {
    force?: boolean;
    kind?: "taste" | "codex" | "all";
    includeProposals?: boolean;
  }): Promise<CrosslinksResponse> {
    const requestedKind = opts?.kind === "taste" || opts?.kind === "codex" ? opts.kind : "all";
    const includeProposals = opts?.includeProposals !== false;

    const { rules, codexItems, answeredHistory, fingerprint } = this.getRulesAndPrinciples();

    if (!opts?.force && this.cachedResponse && this.cachedFingerprint === fingerprint) {
      return this.formatFilteredResponse(this.cachedResponse, requestedKind, includeProposals);
    }

    if (this.inflight && !opts?.force) {
      const base = await this.inflight;
      return this.formatFilteredResponse(base, requestedKind, includeProposals);
    }

    const computePromise = this.runCompute(rules, codexItems, answeredHistory, fingerprint);
    this.inflight = computePromise;
    try {
      const base = await computePromise;
      return this.formatFilteredResponse(base, requestedKind, includeProposals);
    } finally {
      if (this.inflight === computePromise) {
        this.inflight = null;
      }
    }
  }

  private async runCompute(
    rules: TasteRule[],
    codexItems: CodexItem[],
    answeredHistory: TasteAnswerHistoryItem[],
    fingerprint: string,
  ): Promise<CrosslinksResponse> {
    const ruleTexts = rules.map(buildRuleEmbedText);
    const codexTexts = codexItems.map(buildCodexEmbedText);

    const ruleTokens = ruleTexts.map(tokenizeForSearch);
    const codexTokens = codexTexts.map(tokenizeForSearch);
    const idf = buildIdfMap([...ruleTokens, ...codexTokens]);

    const allVectors = await this.embedder.embedBatch([...ruleTexts, ...codexTexts]);
    const ruleVecs = allVectors.slice(0, rules.length);
    const codexVecs = allVectors.slice(rules.length);

    const hasEmbeddings =
      ruleVecs.some((v) => v !== null) && codexVecs.some((v) => v !== null);
    const source: "embedding" | "tfidf" = hasEmbeddings ? "embedding" : "tfidf";

    const links: CrosslinkItem[] = [];
    const seenPairs = new Set<string>();

    for (let ri = 0; ri < rules.length; ri++) {
      const rule = rules[ri];
      const rVec = ruleVecs[ri];
      const rTok = ruleTokens[ri];

      for (let ci = 0; ci < codexItems.length; ci++) {
        const item = codexItems[ci];
        const cVec = codexVecs[ci];
        const cTok = codexTokens[ci];

        const lexicalScore = computeTfidfCosine(rTok, cTok, idf);
        const domainAffinity = computeDomainAffinity(rule.domain, item);
        const semanticScore = rVec && cVec ? cosineSimilarity(rVec, cVec) : 0;

        let matched = false;
        let combinedScore = 0;

        if (rVec && cVec) {
          combinedScore = Math.min(
            1,
            semanticScore + domainAffinity * 0.18 + lexicalScore * 0.25
          );
          if (semanticScore >= this.reinforceThreshold) {
            matched = true;
          } else if (
            semanticScore >= 0.56 &&
            (domainAffinity >= 0.5 || lexicalScore >= 0.12) &&
            combinedScore >= 0.68
          ) {
            matched = true;
          } else if (
            rule.polarity === "avoid" &&
            semanticScore >= 0.54 &&
            (domainAffinity >= 0.65 || lexicalScore >= 0.14)
          ) {
            matched = true;
          }
        } else {
          // Deterministic offline TF-IDF + domain-affinity fallback
          combinedScore = Math.min(1, lexicalScore + domainAffinity * 0.32);
          if (lexicalScore >= 0.22 || (lexicalScore >= 0.08 && domainAffinity >= 0.55) || (domainAffinity >= 0.85 && lexicalScore >= 0.04)) {
            matched = true;
          }
        }

        if (!matched) continue;

        const pairKey = `${rule.id}::${item.id}`;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);

        const relation = classifyLinkRelation(rule, item);
        const evidenceParts: string[] = [relation.note];
        if (rVec && cVec) {
          evidenceParts.push(`cosine ${semanticScore.toFixed(2)}`);
        } else {
          evidenceParts.push(`tfidf ${lexicalScore.toFixed(2)}`);
        }
        if (domainAffinity >= 0.5) {
          evidenceParts.push(`domain match (${TASTE_DOMAIN_LABELS[rule.domain]} <-> ${item.domain})`);
        }

        links.push({
          id: `xlink_${hashContent(pairKey)}`,
          taste_rule_id: rule.id,
          taste_domain: rule.domain,
          taste_polarity: rule.polarity,
          taste_rule: stripEmDashesSafe(rule.rule),
          codex_id: item.id,
          codex_section: item.section,
          codex_title: stripEmDashesSafe(item.title),
          codex_domain: stripEmDashesSafe(item.domain),
          kind: relation.kind,
          subkind: relation.subkind,
          score: Number(combinedScore.toFixed(4)),
          semantic_score: Number(semanticScore.toFixed(4)),
          lexical_score: Number(lexicalScore.toFixed(4)),
          evidence: stripEmDashesSafe(evidenceParts.join(" | ")),
          source,
        });
      }
    }

    links.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    this.rebuildIndexes(links);

    const proposals = this.detectProposals(links, codexItems, answeredHistory);

    const reinforces = links.filter((l) => l.kind === "reinforces").length;
    const conflicts = links.filter((l) => l.kind === "conflicts").length;
    const guardrails = links.filter((l) => l.subkind === "guardrail").length;
    const codexDrafts = proposals.filter((p) => p.kind === "codex_draft").length;
    const tasteQs = proposals.filter((p) => p.kind === "taste_question").length;

    const fullResponse: CrosslinksResponse = {
      ok: true,
      kind: "all",
      generated_at: new Date().toISOString(),
      source,
      total: links.length,
      links,
      proposals,
      stats: {
        total_links: links.length,
        reinforces,
        conflicts,
        guardrails,
        codex_draft_proposals: codexDrafts,
        taste_question_proposals: tasteQs,
        taste_rules_scanned: rules.length,
        codex_items_scanned: codexItems.length,
      },
    };

    this.cachedResponse = fullResponse;
    this.cachedFingerprint = fingerprint;
    return fullResponse;
  }

  private detectProposals(
    links: CrosslinkItem[],
    codexItems: CodexItem[],
    answeredHistory: TasteAnswerHistoryItem[],
  ): CrosslinkProposal[] {
    const proposals: CrosslinkProposal[] = [];

    const linkedTasteDomains = new Set<TasteDomainId>();
    const linkedCodexIds = new Set<string>();
    for (const l of links) {
      linkedTasteDomains.add(l.taste_domain);
      linkedCodexIds.add(l.codex_id);
    }

    // Proposal 1: 3+ agreeing Taste answers in a domain with no linked Codex principle -> propose Codex draft
    const answersByDomain = new Map<TasteDomainId, TasteAnswerHistoryItem[]>();
    for (const ans of answeredHistory) {
      const list = answersByDomain.get(ans.domain) || [];
      list.push(ans);
      answersByDomain.set(ans.domain, list);
    }

    for (const [domain, answers] of answersByDomain.entries()) {
      if (linkedTasteDomains.has(domain)) continue;
      // Check agreeing answers: >= 3 positive-leaning, >= 3 negative-leaning, or >= 3 consistent verdicts in domain
      const pos = answers.filter((a) => a.signal_value >= 0);
      const neg = answers.filter((a) => a.signal_value < 0);
      const agreeing = pos.length >= 3 ? pos : neg.length >= 3 ? neg : answers.length >= 3 ? answers : [];
      if (agreeing.length < 3) continue;

      const label = TASTE_DOMAIN_LABELS[domain] || domain;
      const tags = Array.from(new Set(agreeing.map((a) => a.trait_tag).filter(Boolean))).slice(0, 6);
      const topChoices = agreeing.slice(0, 3).map((a) => `${a.axis}: ${a.chosen_label}`);

      proposals.push({
        id: `prop_codex_${domain}`,
        kind: "codex_draft",
        taste_domain: domain,
        domain_label: label,
        agreeing_count: agreeing.length,
        trait_tags: tags,
        proposed_title: `${label} Doctrine`,
        proposed_section: "philosophies",
        proposed_thesis: stripEmDashesSafe(
          `Codify ${agreeing.length} consistent ${label} verdicts (${tags.slice(0, 3).join(", ")}) into a durable operating principle.`
        ),
        proposed_summary: stripEmDashesSafe(topChoices.join(" | ")),
        evidence: topChoices.map(stripEmDashesSafe),
      });
    }

    // Proposal 2: Codex philosophy (or recent owner capture) with no linked Taste rule -> propose Taste question
    for (const item of codexItems) {
      if (linkedCodexIds.has(item.id)) continue;
      if (item.section !== "philosophies" && item.origin !== "owner") continue;

      const suggestedDomain = inferTasteDomainForCodex(item);
      proposals.push({
        id: `prop_taste_${item.id}`,
        kind: "taste_question",
        codex_id: item.id,
        codex_title: stripEmDashesSafe(item.title),
        codex_domain: stripEmDashesSafe(item.domain),
        suggested_taste_domain: suggestedDomain,
        proposed_question: stripEmDashesSafe(
          `How strictly should "${item.title}" govern ${TASTE_DOMAIN_LABELS[suggestedDomain]} tradeoffs?`
        ),
        proposed_axis: stripEmDashesSafe(item.title.slice(0, 48)),
        evidence: [
          stripEmDashesSafe(`Codex ${item.section} (${item.domain}) has no linked Taste rule yet`),
          ...(item.thesis ? [stripEmDashesSafe(`Thesis: ${item.thesis.slice(0, 140)}`)] : []),
        ],
      });
    }

    return proposals;
  }

  private formatFilteredResponse(
    base: CrosslinksResponse,
    kind: "taste" | "codex" | "all",
    includeProposals: boolean,
  ): CrosslinksResponse {
    const proposals = includeProposals
      ? kind === "taste"
        ? base.proposals.filter((p) => p.kind === "taste_question")
        : kind === "codex"
          ? base.proposals.filter((p) => p.kind === "codex_draft")
          : base.proposals
      : [];

    return {
      ...base,
      kind,
      proposals,
    };
  }
}
