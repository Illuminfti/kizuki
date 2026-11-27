import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

export type CodexSection = "philosophies" | "interests" | "hobbies" | "ideas" | "actions";
export type IdeaStage = "spark" | "validating" | "building" | "shipped" | "parked";
export type ConvictionLevel = "core" | "active" | "testing";
export type CodexStatus = "living" | "active" | "open" | "done" | "archived";
export type CodexSynthesizeMode = "sharpen" | "next_moves" | "challenge";

export interface CodexBookmarkRef {
  author: string;
  text: string;
  url: string;
  date: string;
  likes: number;
}

export interface CodexFeedBookmark extends CodexBookmarkRef {
  id: string;
  domain: string;
}

export interface CodexCrosslinkRef {
  id: string;
  target_kind: "codex" | "taste";
  target_id: string;
  target_title: string;
  target_domain: string;
  kind: "reinforces" | "conflicts";
  subkind: "alignment" | "guardrail" | "contradiction";
  score: number;
  evidence: string;
}

export interface CodexItem {
  id: string;
  section: CodexSection;
  title: string;
  subtitle: string;
  summary: string;
  thesis?: string;
  anti_pattern?: string;
  next_move?: string;
  domain: string;
  stage?: IdeaStage;
  conviction: ConvictionLevel;
  status: CodexStatus;
  leverage_score: number;
  pinned: boolean;
  tags: string[];
  linked_people: string[];
  source_label: string;
  source_path?: string;
  vault_doc_path?: string;
  bookmarks?: CodexBookmarkRef[];
  ai_brief?: string;
  ai_engine?: string;
  ai_updated_at?: string;
  updated_at: string;
  origin: "discovered" | "owner";
  links?: CodexCrosslinkRef[];
}

export interface CodexUpsertRequest {
  id?: string;
  section?: CodexSection;
  title?: string;
  subtitle?: string;
  summary?: string;
  thesis?: string;
  anti_pattern?: string;
  next_move?: string;
  domain?: string;
  stage?: IdeaStage;
  conviction?: ConvictionLevel;
  status?: CodexStatus;
  leverage_score?: number;
  pinned?: boolean;
  archived?: boolean;
  tags?: string[];
  linked_people?: string[];
}

export interface CodexQueryOptions {
  section?: string;
  q?: string;
  stage?: string;
  tag?: string;
  domain?: string;
  includeArchived?: boolean;
}

export interface CodexStats {
  total: number;
  philosophies: number;
  interests: number;
  hobbies: number;
  ideas: number;
  actions_open: number;
  actions_done: number;
  bookmarks: number;
  decisions_open: number;
  pinned: number;
}

export interface CodexSectionMeta {
  id: CodexSection;
  label: string;
  count: number;
  description: string;
}

export interface CodexDomainStat {
  domain: string;
  count: number;
  pct: number;
}

export interface CodexResponse {
  stats: CodexStats;
  sections: CodexSectionMeta[];
  domains: CodexDomainStat[];
  stages: Record<IdeaStage, number>;
  items: CodexItem[];
  recent_bookmarks: CodexFeedBookmark[];
  open_decisions: CodexItem[];
  updated_at: string;
}

export interface CodexPromoteRequest {
  id: string;
  title?: string;
  detail?: string;
  tag?: string;
  createNote?: boolean;
}

export interface CodexPromoteResponse {
  ok: true;
  action_id: string;
  note_path?: string;
  item: CodexItem;
}

export interface CodexSynthesizePrompt {
  system: string;
  user: string;
  promptForCoherence: string;
}

export interface CodexOmniHit {
  id: string;
  section: CodexSection;
  title: string;
  subtitle: string;
  domain: string;
  stage?: IdeaStage;
  url_view: "codex";
}

export interface CodexApiConfig {
  vaultPath?: string;
  bridgesDir?: string;
  lifeOsWikiPath?: string | null;
  gardenPath?: string | null;
  db?: Database | null;
  memtDbPath?: string | null;
}

interface CodexOverride {
  section?: CodexSection;
  title?: string;
  subtitle?: string;
  summary?: string;
  thesis?: string;
  anti_pattern?: string;
  next_move?: string;
  domain?: string;
  stage?: IdeaStage;
  conviction?: ConvictionLevel;
  status?: CodexStatus;
  leverage_score?: number;
  pinned?: boolean;
  archived?: boolean;
  tags?: string[];
  linked_people?: string[];
  ai_brief?: string;
  ai_engine?: string;
  ai_updated_at?: string;
  updated_at?: string;
}

interface CodexStore {
  version: 1;
  updated_at: string;
  custom_items: CodexItem[];
  overrides: Record<string, CodexOverride>;
  deleted_ids: string[];
}

interface OwnerActionRecord {
  id: string;
  title: string;
  detail: string;
  tag: string;
  done: boolean;
  source: string;
  created_at: string;
}

interface ParsedMarkdown {
  frontmatter: Record<string, string | string[]>;
  body: string;
  title: string;
  sections: Map<string, string>;
}

interface CorpusSnapshot {
  builtAt: number;
  discovered: CodexItem[];
  recentBookmarks: CodexFeedBookmark[];
  totalBookmarks: number;
}

export const DEFAULT_CODEX_VAULT_PATH =
  process.env.KIZUKI_VAULT || process.env.KIZUKI_VAULT_PATH || join(homedir(), "Kizuki");
export const DEFAULT_CODEX_BRIDGES_DIR =
  process.env.KIZUKI_BRIDGES_DIR || join(DEFAULT_CODEX_VAULT_PATH, ".kizuki", "bridges");
export const DEFAULT_LIFEOS_WIKI_PATH =
  process.env.KIZUKI_LIFEOS_WIKI_PATH || join(DEFAULT_CODEX_VAULT_PATH, "wiki");
export const DEFAULT_GARDEN_KNOWLEDGE_PATH =
  process.env.KIZUKI_GARDEN_PATH || join(homedir(), ".local", "share", "garden", "knowledge");

const CACHE_TTL_MS = 30_000;

const VALID_SECTIONS = new Set<CodexSection>(["philosophies", "interests", "hobbies", "ideas", "actions"]);
const VALID_STAGES = new Set<IdeaStage>(["spark", "validating", "building", "shipped", "parked"]);
const VALID_CONVICTIONS = new Set<ConvictionLevel>(["core", "active", "testing"]);
const VALID_STATUSES = new Set<CodexStatus>(["living", "active", "open", "done", "archived"]);

const SECTION_DESCRIPTIONS: Record<CodexSection, { label: string; description: string }> = {
  philosophies: {
    label: "Philosophies & Principles",
    description: "Operating theses, creative doctrines, craft laws, and verified rules.",
  },
  interests: {
    label: "Interests & Passions",
    description: "Clustered X bookmarks, Taste Vault references, and active research threads.",
  },
  hobbies: {
    label: "Hobbies & Personal Craft",
    description: "Hands-on labs, trading experiments, generative art, and personal life anchors.",
  },
  ideas: {
    label: "Ideas & Ventures",
    description: "Active companies, product incubations, and staged concepts from spark to shipped.",
  },
  actions: {
    label: "Action Plane",
    description: "Live owner actions, open high-stakes decisions, commitments, and next moves.",
  },
};

const CANONICAL_PEOPLE_MATCHERS: Array<{ name: string; re: RegExp }> = [];

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SECRET_TOKEN_RE =
  /\b(?:s[k]-[a-zA-Z0-9_-]{16,}|g[h]p_[a-zA-Z0-9]{20,}|x[o]x[baprs]-[a-zA-Z0-9-]{10,}|AI[z]a[0-9A-Za-z_-]{20,}|A[K]IA[0-9A-Z]{16})\b/g;
const OAUTH_QUERY_RE = /https?:\/\/[^\s)]*(?:oauth|authorize|access_token|client_secret|refresh_token)[^\s)]*/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi;
const UK_POSTCODE_RE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/g;

export function stripEmDashes(input: string): string {
  if (!input) return "";
  return input
    .replace(/\u2028|\u2029/g, " ")
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2014/g, "-")
    .replace(/\s*\u2013\s*/g, " - ")
    .replace(/\u2013/g, "-");
}

export function sanitizeText(input: string): string {
  if (!input) return "";
  let s = stripEmDashes(input);
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(OAUTH_QUERY_RE, "[redacted-url]");
  s = s.replace(SECRET_TOKEN_RE, "[redacted-token]");
  s = s.replace(BEARER_RE, "Bearer [redacted]");
  s = s.replace(EMAIL_RE, "[redacted-email]");
  s = s.replace(UK_POSTCODE_RE, "[redacted-postcode]");
  s = s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, target: string) => {
    const seg = target.split("/").pop() || target;
    return seg.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
  });
  s = s.replace(/\s*\[(?:wiki|agent-memory|worker-memory|family|session|Source)[^\]]*\]/gi, "");
  s = s.replace(/\s+/g, " ").trim();
  return stripEmDashes(s);
}

function truncateClean(input: string, maxLen: number): string {
  const clean = sanitizeText(input);
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "...";
}

function slugify(input: string): string {
  return (input || "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56) || "item";
}

function extractLinkedPeople(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const matcher of CANONICAL_PEOPLE_MATCHERS) {
    if (matcher.re.test(text)) {
      found.push(matcher.name);
    }
  }
  return found;
}

function uniqueStrings(list: string[], max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const clean = sanitizeText(raw).toLowerCase().replace(/^#/, "").trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function parseMarkdown(raw: string, fallbackTitle: string): ParsedMarkdown {
  const frontmatter: Record<string, string | string[]> = {};
  let body = raw;

  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const fmBlock = raw.slice(4, endIdx);
      body = raw.slice(endIdx + 4).replace(/^\r?\n/, "");
      let currentKey: string | null = null;
      for (const line of fmBlock.split(/\r?\n/)) {
        const listMatch = /^\s*-\s+(.+)$/.exec(line);
        if (listMatch && currentKey) {
          const val = listMatch[1].trim().replace(/^["']|["']$/g, "");
          const existing = frontmatter[currentKey];
          if (Array.isArray(existing)) existing.push(val);
          else frontmatter[currentKey] = [val];
          continue;
        }
        const kvMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
        if (kvMatch) {
          currentKey = kvMatch[1].toLowerCase();
          const val = kvMatch[2].trim();
          if (val.startsWith("[") && val.endsWith("]")) {
            frontmatter[currentKey] = val
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim().replace(/^["']|["']$/g, ""))
              .filter(Boolean);
          } else if (val === "") {
            frontmatter[currentKey] = [];
          } else {
            frontmatter[currentKey] = val.replace(/^["']|["']$/g, "");
          }
        }
      }
    }
  }

  const sections = new Map<string, string>();
  let currentHeading = "_intro";
  let buf: string[] = [];
  let h1Title = "";

  for (const line of body.split(/\r?\n/)) {
    if (!h1Title && /^#\s+(.+)$/.test(line)) {
      h1Title = line.replace(/^#\s+/, "").trim();
      continue;
    }
    const h2 = /^##+\s+(.+)$/.exec(line);
    if (h2) {
      sections.set(currentHeading, buf.join("\n").trim());
      currentHeading = h2[1].trim().toLowerCase();
      buf = [];
    } else {
      buf.push(line);
    }
  }
  sections.set(currentHeading, buf.join("\n").trim());

  const fmTitle = typeof frontmatter.title === "string" ? frontmatter.title : "";
  const title = sanitizeText(fmTitle || h1Title || fallbackTitle);
  return { frontmatter, body, title, sections };
}

function getFmString(fm: Record<string, string | string[]>, key: string): string {
  const v = fm[key];
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.join(", ").trim();
  return "";
}

function getFmTags(fm: Record<string, string | string[]>): string[] {
  const v = fm.tags;
  if (Array.isArray(v)) return v.map((s) => String(s));
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim());
  return [];
}

function extractFirstParagraph(md: string): string {
  const cleaned = md.replace(/<!--[\s\S]*?-->/g, "").trim();
  for (const block of cleaned.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("#") || trimmed.startsWith("|") || trimmed.startsWith("```") || trimmed === "---") {
      continue;
    }
    const noBullets = trimmed
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*•\d.]+\s*/, "").replace(/\*\*([^*]+)\*\*/g, "$1").trim())
      .filter(Boolean)
      .join(" ");
    if (noBullets.length >= 18) return sanitizeText(noBullets);
  }
  return sanitizeText(cleaned);
}

function extractBullets(md: string, max = 5): string[] {
  const out: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*(?:[-*•]|\d+\.)\s+(.+)$/.exec(line);
    if (!m) continue;
    const cleaned = sanitizeText(m[1].replace(/\*\*([^*]+)\*\*/g, "$1"));
    if (cleaned.length >= 8) {
      out.push(cleaned);
      if (out.length >= max) break;
    }
  }
  return out;
}

function findSectionText(sections: Map<string, string>, keys: string[]): string {
  for (const key of keys) {
    const exact = sections.get(key);
    if (exact && exact.trim()) return exact;
    for (const [secKey, secVal] of sections.entries()) {
      if (secKey.includes(key) && secVal.trim()) return secVal;
    }
  }
  return "";
}

function fileMtimeIso(filePath: string): string {
  try {
    return statSync(filePath).mtime.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function atomicWriteFile(targetPath: string, content: string, mode = 0o600): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = join(dir, `.${basename(targetPath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, content, { encoding: "utf8", mode });
    chmodSync(tmpPath, mode);
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}

interface BookmarkClusterDef {
  id: string;
  domain: string;
  title: string;
  subtitle: string;
  thesis: string;
  next_move: string;
  tags: string[];
  keywords: RegExp;
}

const BOOKMARK_CLUSTERS: BookmarkClusterDef[] = [
  {
    id: "interest_cluster_ai_agents",
    domain: "AI Agents & Local Models",
    title: "AI Agents, Harnesses & Local Models",
    subtitle: "Autonomous loops, multi-agent harnesses, local GPU inference, and memory systems",
    thesis:
      "Treat agents as persistent execution operators with real environment access, verification loops, and compounding memory rather than stateless chat windows.",
    next_move: "Audit top bookmarked harness patterns and port the highest-leverage workflows into Kizuki.",
    tags: ["ai-agents", "harnesses", "local-models", "memory", "x-bookmarks"],
    keywords:
      /\b(agent|agents|claude|codex|mcp|llm|model|gpt|gemini|qwen|deepseek|llama|vllm|sglang|harness|prompt|memory|context|cursor|anthropic|openai|local\s+ai|gpu|fine-?tun|rlhf|eval|subagent|workflow|autonomous|computer\s+use)\b/i,
  },
  {
    id: "interest_cluster_design_motion",
    domain: "Design, Motion & Visual Craft",
    title: "Design, Motion & Visual Craft",
    subtitle: "Editorial interfaces, tactile shaders, typography, and high-craft product choreography",
    thesis:
      "Great visual work has a concrete subject, sharp typographic hierarchy, and purposeful motion rather than generic AI dark gradients.",
    next_move: "Distill top bookmarked motion and UI references into reusable Taste Vault patterns.",
    tags: ["design", "motion", "typography", "shaders", "ui-craft", "x-bookmarks"],
    keywords:
      /\b(design|ui|ux|motion|gsap|shader|webgl|three\.?js|typography|font|css|tailwind|layout|brand|editorial|interface|figma|animation|framer|rive|tactile|gradient|minimal|palette|frontend|component|portfolio|landing\s+page)\b/i,
  },
  {
    id: "interest_cluster_crypto_solana",
    domain: "Distributed Systems & Markets",
    title: "Distributed Systems & On-Chain Markets",
    subtitle: "Protocol design, multi-chain architecture, privacy markets, and DeFi microstructure",
    thesis:
      "Distribution and market gravity beat abstract technical purity in protocol and capital-market design.",
    next_move: "Convert top protocol and market-structure signals into concrete technical research notes.",
    tags: ["solana", "crypto", "defi", "markets", "x-bookmarks"],
    keywords:
      /\b(solana|sol\b|crypto|defi|btc|bitcoin|eth|ethereum|token|chain|on-?chain|wallet|mpc|fhe|zk|privacy|trading|arb|arbitrage|polymarket|perp|liquidity|dex|validator|mev|sui|near|nft|web3|stablecoin|yield)\b/i,
  },
  {
    id: "interest_cluster_anime_video",
    domain: "Anime & Video Production",
    title: "Anime, Generative Video & Cinematography",
    subtitle: "Layered satsuei compositing, ComfyUI workflows, camera language, and film craft",
    thesis:
      "Authentic anime and video direction relies on layered cel timing, real camera blocking, and deliberate pacing rather than raw single-pass AI clips.",
    next_move: "Feed top video and anime breakdowns into the studio visual pipeline.",
    tags: ["anime", "video", "cinema", "comfyui", "seedance", "x-bookmarks"],
    keywords:
      /\b(anime|video|film|cinema|movie|storyboard|shot|camera|render|blender|comfyui|seedance|kling|sora|veo|runway|remotion|vrm|live2d|3d|character|gacha|vtuber|director|trailer|editing|sound|music|audio|satsuei)\b/i,
  },
  {
    id: "interest_cluster_founders_strategy",
    domain: "Founders, Strategy & Leverage",
    title: "Founders, GTM Strategy & Leverage",
    subtitle: "Distribution wedges, fundraising positioning, high-agency operating models, and consulting leverage",
    thesis:
      "Small teams with clear taste, asymmetric distribution, and relentless execution out-ship bloated incumbents.",
    next_move: "Apply top GTM and fundraising frameworks to Points, Nob, and NFA consultancy retainers.",
    tags: ["founders", "strategy", "gtm", "leverage", "growth", "x-bookmarks"],
    keywords:
      /\b(founder|startup|gtm|growth|distribution|marketing|sales|revenue|pricing|raise|fundrais|vc|investor|retainer|consult|business|strategy|leverage|audience|viral|positioning|copywriting|launch|pitch|moat|product)\b/i,
  },
  {
    id: "interest_cluster_tools_infra",
    domain: "Tools & Infrastructure",
    title: "Developer Tools, Systems & Infrastructure",
    subtitle: "Fast runtimes, CLI tools, SQLite, local-first servers, browsers, and automation plumbing",
    thesis:
      "Own your local-first runtime and data plane so every personal workflow runs in milliseconds without SaaS lock-in.",
    next_move: "Evaluate bookmarked developer tools for adoption into the VPS and Mac operator stack.",
    tags: ["tools", "infra", "cli", "systems", "devex", "x-bookmarks"],
    keywords:
      /\b(github|repo|open-?source|cli|terminal|linux|vps|docker|sqlite|postgres|rust|typescript|bun|python|browser|playwright|cdp|scrape|firecrawl|obsidian|sync|backup|server|api|sdk|database|self-?host|cloudflare|tailscale)\b/i,
  },
];

function classifyBookmarkDomain(text: string): BookmarkClusterDef {
  let best = BOOKMARK_CLUSTERS[0];
  let bestScore = -1;
  for (const cluster of BOOKMARK_CLUSTERS) {
    const matches = text.match(new RegExp(cluster.keywords.source, "gi"));
    const score = matches ? matches.length : 0;
    if (score > bestScore) {
      bestScore = score;
      best = cluster;
    }
  }
  return bestScore > 0 ? best : BOOKMARK_CLUSTERS[5];
}

function cleanBookmarkTweetText(rawText: string): string {
  const lines = (rawText || "").split(/\r?\n/);
  const bodyLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith("# X Bookmark by") ||
      trimmed.startsWith("URL:") ||
      trimmed.startsWith("Date:") ||
      trimmed.startsWith("Engagement:")
    ) {
      continue;
    }
    bodyLines.push(trimmed);
  }
  const joined = bodyLines.join(" ").replace(/https?:\/\/t\.co\/\w+/g, "").trim();
  return truncateClean(joined || rawText, 240);
}

function sectionToActionTag(section: CodexSection): string {
  switch (section) {
    case "philosophies":
      return "Principle";
    case "interests":
      return "Research";
    case "hobbies":
      return "Personal";
    case "ideas":
      return "Venture";
    case "actions":
      return "Action";
  }
}

export class KizukiCodexApi {
  readonly vaultPath: string;
  readonly bridgesDir: string;
  readonly lifeOsWikiPath: string | null;
  readonly gardenPath: string | null;
  readonly db: Database | null;
  readonly memtDbPath: string | null;
  readonly storePath: string;
  readonly actionsPath: string;

  private codexCache: CorpusSnapshot | null = null;
  private crosslinksProvider:
    | (() => Map<string, CodexCrosslinkRef[]> | Record<string, CodexCrosslinkRef[]>)
    | null = null;

  constructor(config: CodexApiConfig = {}) {
    this.vaultPath = config.vaultPath || DEFAULT_CODEX_VAULT_PATH;
    this.bridgesDir = config.bridgesDir || DEFAULT_CODEX_BRIDGES_DIR;
    this.lifeOsWikiPath =
      config.lifeOsWikiPath === undefined ? DEFAULT_LIFEOS_WIKI_PATH : config.lifeOsWikiPath;
    this.gardenPath = config.gardenPath === undefined ? DEFAULT_GARDEN_KNOWLEDGE_PATH : config.gardenPath;
    this.db = config.db === undefined ? null : config.db;
    this.memtDbPath =
      config.memtDbPath === undefined
        ? join(this.vaultPath, ".kizuki", "memt", "registry.sqlite")
        : config.memtDbPath;
    this.storePath = join(this.vaultPath, "world", "codex.json");
    this.actionsPath = join(this.vaultPath, "owner-actions.json");
  }

  invalidateCache(): void {
    this.codexCache = null;
  }

  setCrosslinksProvider(
    provider: (() => Map<string, CodexCrosslinkRef[]> | Record<string, CodexCrosslinkRef[]>) | null
  ): void {
    this.crosslinksProvider = provider;
  }

  getCrosslinksForItem(id: string): CodexCrosslinkRef[] {
    if (!this.crosslinksProvider || !id) return [];
    try {
      const data = this.crosslinksProvider();
      if (data instanceof Map) {
        return data.get(id) || [];
      }
      if (data && typeof data === "object") {
        return data[id] || [];
      }
    } catch {
      // fail-soft if provider unavailable
    }
    return [];
  }

  private attachCrosslinks(item: CodexItem): CodexItem {
    const links = this.getCrosslinksForItem(item.id);
    if (links.length === 0) return item;
    return { ...item, links };
  }

  listActiveItems(): CodexItem[] {
    const { items } = this.assembleAllItems();
    return items.filter((i) => i.status !== "archived").map((i) => this.attachCrosslinks(i));
  }

  listPrinciples(): CodexItem[] {
    return this.listActiveItems().filter((i) => i.section === "philosophies");
  }

  private resolveVaultDocPath(candidateRel: string | undefined): string | undefined {
    if (!candidateRel) return undefined;
    const normalized = candidateRel.replace(/^\/+/, "").replace(/\/+/g, "/");
    if (!normalized.endsWith(".md") || normalized.includes("..")) return undefined;
    if (normalized.startsWith("obsidian/")) {
      const full = join(this.bridgesDir, "mac-obsidian", normalized.slice("obsidian/".length));
      return existsSync(full) ? normalized : undefined;
    }
    if (normalized.startsWith("apple-notes/")) {
      const full = join(this.bridgesDir, "mac-notes", normalized.slice("apple-notes/".length));
      return existsSync(full) ? normalized : undefined;
    }
    const full = join(this.vaultPath, normalized);
    return existsSync(full) ? normalized : undefined;
  }

  private resolveWikiVaultDoc(wikiRelPath: string): string | undefined {
    return this.resolveVaultDocPath(`auto/entities/${wikiRelPath.replace(/^\/+/, "")}`);
  }

  private loadStore(): CodexStore {
    if (!existsSync(this.storePath)) {
      return {
        version: 1,
        updated_at: new Date().toISOString(),
        custom_items: [],
        overrides: {},
        deleted_ids: [],
      };
    }
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as Partial<CodexStore>;
      return {
        version: 1,
        updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
        custom_items: Array.isArray(raw.custom_items) ? raw.custom_items : [],
        overrides: raw.overrides && typeof raw.overrides === "object" ? raw.overrides : {},
        deleted_ids: Array.isArray(raw.deleted_ids) ? raw.deleted_ids : [],
      };
    } catch {
      return {
        version: 1,
        updated_at: new Date().toISOString(),
        custom_items: [],
        overrides: {},
        deleted_ids: [],
      };
    }
  }

  private saveStore(store: CodexStore): void {
    store.updated_at = new Date().toISOString();
    atomicWriteFile(this.storePath, JSON.stringify(store, null, 2) + "\n", 0o600);
    this.invalidateCache();
  }

  private getCorpus(): CorpusSnapshot {
    const now = Date.now();
    if (this.codexCache && now - this.codexCache.builtAt < CACHE_TTL_MS) {
      return this.codexCache;
    }

    const items: CodexItem[] = [];
    const seenIds = new Set<string>();
    const addItem = (item: CodexItem) => {
      if (seenIds.has(item.id)) return;
      seenIds.add(item.id);
      items.push(this.cleanItem(item));
    };

    const ownerProfile = this.readOwnerProfile();

    // 1. Philosophies & Operating Principles
    this.collectPhilosophies(addItem, ownerProfile);

    // 2. Interests & Passions + X Bookmarks
    const bookmarkResult = this.collectInterests(addItem);

    // 3. Hobbies & Personal Craft
    this.collectHobbies(addItem, ownerProfile);

    // 4. Ideas Incubator & Ventures
    const collectedIdeas: CodexItem[] = [];
    this.collectIdeas((item) => {
      addItem(item);
      if (item.section === "ideas") collectedIdeas.push(item);
    }, ownerProfile);

    // 5. Action Plane
    this.collectActions(addItem, ownerProfile, collectedIdeas);

    const snapshot: CorpusSnapshot = {
      builtAt: now,
      discovered: items,
      recentBookmarks: bookmarkResult.recentBookmarks,
      totalBookmarks: bookmarkResult.totalBookmarks,
    };
    this.codexCache = snapshot;
    return snapshot;
  }

  private cleanItem(item: CodexItem): CodexItem {
    const cleaned: CodexItem = {
      ...item,
      title: sanitizeText(item.title),
      subtitle: sanitizeText(item.subtitle),
      summary: sanitizeText(item.summary),
      domain: sanitizeText(item.domain || "General"),
      source_label: sanitizeText(item.source_label || "Personal Vault"),
      leverage_score: clampScore(item.leverage_score),
      tags: uniqueStrings(item.tags || []),
      linked_people: Array.from(new Set((item.linked_people || []).map((p) => sanitizeText(p)).filter(Boolean))),
    };
    if (item.thesis) cleaned.thesis = sanitizeText(item.thesis);
    if (item.anti_pattern) cleaned.anti_pattern = sanitizeText(item.anti_pattern);
    if (item.next_move) cleaned.next_move = sanitizeText(item.next_move);
    if (item.ai_brief) cleaned.ai_brief = sanitizeText(item.ai_brief);
    if (item.bookmarks) {
      cleaned.bookmarks = item.bookmarks.map((b) => ({
        author: sanitizeText(b.author),
        text: sanitizeText(b.text),
        url: b.url,
        date: b.date,
        likes: Number(b.likes) || 0,
      }));
    }
    return cleaned;
  }

  private readOwnerProfile(): { raw: string; path: string; vaultDocPath?: string; updatedAt: string } | null {
    const candidates: Array<{ full: string; vaultDoc?: string }> = [];
    if (this.lifeOsWikiPath) {
      candidates.push({
        full: join(this.lifeOsWikiPath, "05-knowledge", "owner-profile.md"),
        vaultDoc: this.resolveWikiVaultDoc("05-knowledge/owner-profile.md"),
      });
    }
    const autoFallback = join(this.vaultPath, "auto", "entities", "05-knowledge", "owner-profile.md");
    candidates.push({ full: autoFallback, vaultDoc: this.resolveVaultDocPath("auto/entities/05-knowledge/owner-profile.md") });

    for (const c of candidates) {
      if (existsSync(c.full)) {
        try {
          return {
            raw: readFileSync(c.full, "utf8"),
            path: c.full,
            vaultDocPath: c.vaultDoc,
            updatedAt: fileMtimeIso(c.full),
          };
        } catch {
          // continue
        }
      }
    }
    return null;
  }

  private collectPhilosophies(
    addItem: (item: CodexItem) => void,
    ownerProfile: { raw: string; path: string; vaultDocPath?: string; updatedAt: string } | null
  ): void {
    // 1a. Theses
    if (this.lifeOsWikiPath) {
      const thesesDir = join(this.lifeOsWikiPath, "05-knowledge", "theses");
      if (existsSync(thesesDir)) {
        for (const fn of readdirSync(thesesDir).sort()) {
          if (!fn.endsWith(".md")) continue;
          const full = join(thesesDir, fn);
          try {
            const raw = readFileSync(full, "utf8");
            const parsed = parseMarkdown(raw, basename(fn, ".md"));
            const thesisSec = findSectionText(parsed.sections, ["thesis", "core claim", "claim"]);
            const whySec = findSectionText(parsed.sections, ["why", "summary", "context"]);
            const implSec = findSectionText(parsed.sections, ["operational implication", "implication", "action"]);
            const bullets = extractBullets(implSec || parsed.body, 3);
            const thesis = truncateClean(thesisSec || extractFirstParagraph(parsed.body), 260);
            const summary = truncateClean(whySec || bullets.join(" ") || extractFirstParagraph(parsed.body), 340);
            addItem({
              id: `phil_thesis_${slugify(basename(fn, ".md"))}`,
              section: "philosophies",
              title: parsed.title,
              subtitle: "Canonical Operating Thesis",
              summary,
              thesis,
              next_move: bullets[0] ? truncateClean(bullets[0], 180) : undefined,
              domain: "Operating Philosophy",
              conviction: "core",
              status: "living",
              leverage_score: 94,
              pinned: true,
              tags: uniqueStrings(["thesis", "philosophy", ...getFmTags(parsed.frontmatter)]),
              linked_people: extractLinkedPeople(`${parsed.title} ${parsed.body}`),
              source_label: "Owner Wiki / Theses",
              source_path: full,
              vault_doc_path: this.resolveWikiVaultDoc(`05-knowledge/theses/${fn}`),
              updated_at: fileMtimeIso(full),
              origin: "discovered",
            });
          } catch {
            // skip unreadable file
          }
        }
      }

      // 1b. Curated Concepts
      const conceptsDir = join(this.lifeOsWikiPath, "05-knowledge", "concepts");
      if (existsSync(conceptsDir)) {
        const skipConceptFiles = new Set([
          "claude-code-100-repos.md",
          "inputlengthroutingmatrixandverbositythresholds.md",
          "memoryretentionpolicyv11mcontext.md",
        ]);
        for (const fn of readdirSync(conceptsDir).sort()) {
          if (!fn.endsWith(".md") || skipConceptFiles.has(fn)) continue;
          const full = join(conceptsDir, fn);
          try {
            const raw = readFileSync(full, "utf8");
            const parsed = parseMarkdown(raw, basename(fn, ".md"));
            if (/^enriched:/i.test(parsed.title)) continue;
            const defSec = findSectionText(parsed.sections, ["definition", "core claim", "thesis", "summary"]);
            const rejectsSec = findSectionText(parsed.sections, ["what this rejects", "anti-pattern", "rejects"]);
            const heuristicSec = findSectionText(parsed.sections, ["heuristic", "operational implication", "what this prefers"]);
            const rejectBullets = extractBullets(rejectsSec, 2);
            const nextBullets = extractBullets(heuristicSec, 2);
            const thesis = truncateClean(
              findSectionText(parsed.sections, ["core claim", "thesis", "definition"]) || extractFirstParagraph(parsed.body),
              260
            );
            const summary = truncateClean(defSec || extractFirstParagraph(parsed.body), 340);
            const isCore = /ai-first|creative-doctrine|design-principles|second-brain|codex-maxxing/i.test(fn);
            addItem({
              id: `phil_concept_${slugify(basename(fn, ".md"))}`,
              section: "philosophies",
              title: parsed.title,
              subtitle: "Operating Concept & Mental Model",
              summary,
              thesis,
              anti_pattern: rejectBullets.length > 0 ? truncateClean(rejectBullets.join("; "), 220) : undefined,
              next_move: nextBullets[0] ? truncateClean(nextBullets[0], 180) : undefined,
              domain: /creative/i.test(fn) ? "Creative Craft" : "AI & Operating Systems",
              conviction: isCore ? "core" : "active",
              status: "living",
              leverage_score: isCore ? 91 : 83,
              pinned: /ai-first|creative-doctrine/i.test(fn),
              tags: uniqueStrings(["concept", "philosophy", ...getFmTags(parsed.frontmatter)]),
              linked_people: extractLinkedPeople(`${parsed.title} ${parsed.body}`),
              source_label: "Owner Wiki / Concepts",
              source_path: full,
              vault_doc_path: this.resolveWikiVaultDoc(`05-knowledge/concepts/${fn}`),
              updated_at: fileMtimeIso(full),
              origin: "discovered",
            });
          } catch {
            // skip
          }
        }
      }

      // 1c. Craft Doctrines (grouped cleanly by craft discipline)
      const craftDir = join(this.lifeOsWikiPath, "05-knowledge", "craft");
      if (existsSync(craftDir)) {
        const craftLabels: Record<string, { title: string; subtitle: string; domain: string; score: number }> = {
          motion: {
            title: "Motion Craft Doctrine",
            subtitle: "Asymmetric easing, beat-locked cuts, clamped interpolations, and physical spring heft",
            domain: "Creative Craft",
            score: 88,
          },
          typography: {
            title: "Typography Discipline",
            subtitle: "Opinionated typefaces, tight display tracking, eyebrow discipline, and strict variant caps",
            domain: "Creative Craft",
            score: 86,
          },
          color: {
            title: "Color & Surface Architecture",
            subtitle: "Warm blacks, OKLCH precision, restrained accents, and low-alpha depth layering",
            domain: "Creative Craft",
            score: 85,
          },
          grading: {
            title: "Grading, Film Grain & Shadow Craft",
            subtitle: "Lifted shadows, subtle film grain, halation control, and LUT-before-scope discipline",
            domain: "Anime & Video",
            score: 84,
          },
          composition: {
            title: "Composition & Negative Space Laws",
            subtitle: "Grid before elements, single focal point, safe areas, and intentional negative space",
            domain: "Creative Craft",
            score: 86,
          },
          "anti-patterns": {
            title: "Visual & Copy Anti-Patterns",
            subtitle: "Hard bans on AI lava-lamp gradients, symmetric soup, default fonts, and corpse phrases",
            domain: "Taste & Standards",
            score: 92,
          },
          sound: {
            title: "Sound Design & Mix Hierarchy",
            subtitle: "J-cuts, L-cuts, beat-aligned SFX, channel LUFS targets, and zero stock cliches",
            domain: "Anime & Video",
            score: 81,
          },
          research: {
            title: "Pre-Build Research & Six-Lens Jury",
            subtitle: "Taste corpus before concept, DESIGN.md before render, and brutal post-mortems",
            domain: "Operating Philosophy",
            score: 87,
          },
        };

        for (const sub of readdirSync(craftDir).sort()) {
          const subPath = join(craftDir, sub);
          try {
            if (!statSync(subPath).isDirectory()) continue;
          } catch {
            continue;
          }
          const mdFiles = readdirSync(subPath)
            .filter((f) => f.endsWith(".md"))
            .sort();
          if (mdFiles.length === 0) continue;

          const rules: string[] = [];
          const antiPatterns: string[] = [];
          let latestMtime = "";
          for (const fn of mdFiles) {
            const fp = join(subPath, fn);
            const mt = fileMtimeIso(fp);
            if (mt > latestMtime) latestMtime = mt;
            const raw = readFileSync(fp, "utf8");
            const parsed = parseMarkdown(raw, basename(fn, ".md"));
            const ruleMatch = /\*\*Rule:\*\*\s*([^\n]+)/i.exec(parsed.body);
            if (ruleMatch) {
              rules.push(`${parsed.title}: ${sanitizeText(ruleMatch[1])}`);
            } else {
              rules.push(parsed.title);
            }
            const neverMatch = /\b(?:Never|Avoid|Banned)[^.\n]{10,140}/i.exec(parsed.body);
            if (neverMatch) antiPatterns.push(sanitizeText(neverMatch[0]));
          }

          const meta = craftLabels[sub] || {
            title: `${sub.charAt(0).toUpperCase() + sub.slice(1)} Craft Doctrine`,
            subtitle: `${mdFiles.length} concrete craft rules`,
            domain: "Creative Craft",
            score: 82,
          };
          addItem({
            id: `phil_craft_${slugify(sub)}`,
            section: "philosophies",
            title: meta.title,
            subtitle: meta.subtitle,
            summary: truncateClean(rules.slice(0, 4).join(" | "), 380),
            thesis: truncateClean(rules[0] || meta.subtitle, 220),
            anti_pattern: antiPatterns.length > 0 ? truncateClean(antiPatterns.slice(0, 2).join(" | "), 220) : undefined,
            next_move: `Run ${sub} craft checks before shipping any visual, web, or video artifact.`,
            domain: meta.domain,
            conviction: sub === "anti-patterns" || sub === "motion" ? "core" : "active",
            status: "living",
            leverage_score: meta.score,
            pinned: sub === "anti-patterns",
            tags: uniqueStrings(["craft", sub, "doctrine", "taste"]),
            linked_people: [],
            source_label: `Owner Wiki / Craft (${mdFiles.length} rules)`,
            source_path: join(subPath, mdFiles[0]),
            vault_doc_path: this.resolveWikiVaultDoc(`05-knowledge/craft/${sub}/${mdFiles[0]}`),
            updated_at: latestMtime || new Date().toISOString(),
            origin: "discovered",
          });
        }
      }
    }

    // 1d. Distilled Principles from owner-profile.md (Taste notes + Standing preferences)
    if (ownerProfile) {
      const parsed = parseMarkdown(ownerProfile.raw, "Owner Profile");
      const tasteText = findSectionText(parsed.sections, ["taste notes"]);
      const prefText = findSectionText(parsed.sections, ["standing preferences"]);

      if (tasteText) {
        const tasteBullets = extractBullets(tasteText, 8);
        addItem({
          id: "phil_know_specificity_beats_polish",
          section: "philosophies",
          title: "Specificity Beats Polish",
          subtitle: "Core Owner Taste Standard",
          summary: truncateClean(
            tasteBullets[0] ||
              "Good work has an enemy, a stake, a real user, technical respect, and a sentence worth stealing.",
            340
          ),
          thesis: "Every artifact must carry real stakes, technical respect, and a sharp point of view.",
          anti_pattern:
            "Smooth corporate dead copy using corpse words: unlock, empower, seamless, robust, next-generation, cutting-edge, revolutionary, innovative.",
          next_move: "Rewrite any draft that still sounds like a generic stranger before showing it.",
          domain: "Taste & Standards",
          conviction: "core",
          status: "living",
          leverage_score: 97,
          pinned: true,
          tags: ["taste", "voice", "anti-slop", "owner-profile"],
          linked_people: [],
          source_label: "Owner Profile / Taste Notes",
          source_path: ownerProfile.path,
          vault_doc_path: ownerProfile.vaultDocPath,
          updated_at: ownerProfile.updatedAt,
          origin: "discovered",
        });

        addItem({
          id: "phil_know_boil_the_ocean",
          section: "philosophies",
          title: "Boil the Ocean (Zero Marginal Cost of Completeness)",
          subtitle: "Binary Quality Bar & Root-Cause Standard",
          summary: truncateClean(
            tasteBullets.find((b) => /marginal cost|boil the ocean/i.test(b)) ||
              "The marginal cost of completeness is near zero with AI. Do the whole thing so well that it genuinely impresses.",
            340
          ),
          thesis: "Quality is binary: impress or fail. Prefer permanent root-cause fixes over partial wins.",
          anti_pattern: "Partial wins dressed as complete work, verbose essays for short asks, and confirmation loops.",
          next_move: "Ship finished, verified end-to-end systems rather than plans or partial stubs.",
          domain: "Operating Philosophy",
          conviction: "core",
          status: "living",
          leverage_score: 98,
          pinned: true,
          tags: ["completeness", "execution", "standards", "owner-profile"],
          linked_people: [],
          source_label: "Owner Profile / Taste Notes",
          source_path: ownerProfile.path,
          vault_doc_path: ownerProfile.vaultDocPath,
          updated_at: ownerProfile.updatedAt,
          origin: "discovered",
        });
      }

      if (prefText) {
        const prefBullets = extractBullets(prefText, 12);
        addItem({
          id: "phil_know_three_gates_autonomy",
          section: "philosophies",
          title: "Full Autonomy with Hard Gates Only",
          subtitle: "Standing Delegation & Approval Contract",
          summary: truncateClean(
            prefBullets.slice(0, 4).join(" | ") ||
              "Act freely on local work. Gate only outbound sends as the owner, spend, and new credentials. One live decision at a time.",
            360
          ),
          thesis: "Reserve human attention for real decisions and hard gates; execute everything else unbidden.",
          anti_pattern: "Asking for manual copy-paste, interrupting for reversible local edits, or dumping multiple unstructured asks.",
          next_move: "Present any gated decision as a single concise multiple-choice card with a recommended default.",
          domain: "Operating Philosophy",
          conviction: "core",
          status: "living",
          leverage_score: 96,
          pinned: true,
          tags: ["autonomy", "gates", "standing-preferences", "owner-profile"],
          linked_people: [],
          source_label: "Owner Profile / Standing Preferences",
          source_path: ownerProfile.path,
          vault_doc_path: ownerProfile.vaultDocPath,
          updated_at: ownerProfile.updatedAt,
          origin: "discovered",
        });
      }
    }

    // 1e. Owner Anchors
    const anchorsPath = join(this.vaultPath, "owner-anchors.md");
    if (existsSync(anchorsPath)) {
      try {
        const raw = readFileSync(anchorsPath, "utf8");
        const parsed = parseMarkdown(raw, "Owner Anchors");
        const rulesSec = findSectionText(parsed.sections, ["operating rules", "rules"]);
        const bullets = extractBullets(rulesSec || parsed.body, 5);
        addItem({
          id: "phil_owner_anchors_rules",
          section: "philosophies",
          title: "Owner Anchors: Proof-First Execution",
          subtitle: "Session-Start Grounding Contract",
          summary: truncateClean(bullets.join(" | ") || extractFirstParagraph(parsed.body), 340),
          thesis: bullets[0] || "Verify real behavior after the final edit before claiming done.",
          anti_pattern: "Claiming done from unverified code edits or letting em-dashes leak into output.",
          next_move: "Keep owner-anchors.md concise so every coding session starts grounded in under 500ms.",
          domain: "Operating Philosophy",
          conviction: "core",
          status: "living",
          leverage_score: 95,
          pinned: true,
          tags: ["owner-anchors", "verification", "rules"],
          linked_people: [],
          source_label: "Kizuki / owner-anchors.md",
          source_path: anchorsPath,
          vault_doc_path: this.resolveVaultDocPath("owner-anchors.md"),
          updated_at: fileMtimeIso(anchorsPath),
          origin: "discovered",
        });
      } catch {
        // skip
      }
    }

    // 1f. Verified MemT procedural rules (from provided db or registry.sqlite)
    this.collectMemtPhilosophies(addItem);
  }

  private collectMemtPhilosophies(addItem: (item: CodexItem) => void): void {
    type MemtRow = {
      id: string;
      domain: string;
      condition: string;
      recommendation: string;
      outcome: string;
      confidence: number;
      updated_at?: string;
    };

    const rows: MemtRow[] = [];

    const queryDb = (database: Database, tableName: string) => {
      try {
        const check = database
          .query(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
          .get(tableName) as { name?: string } | null;
        if (!check?.name) return;
        const fetched = database
          .query(
            `SELECT id, domain, condition, recommendation, outcome, confidence
             FROM ${tableName}
             WHERE outcome = 'verified' AND confidence >= 0.85
             ORDER BY confidence DESC, id DESC
             LIMIT 6`
          )
          .all() as MemtRow[];
        for (const r of fetched) rows.push(r);
      } catch {
        // ignore schema differences
      }
    };

    if (this.db) {
      queryDb(this.db, "memt_experiences");
      if (rows.length === 0) queryDb(this.db, "experiences");
    }

    if (rows.length === 0 && this.memtDbPath && existsSync(this.memtDbPath)) {
      let memtDb: Database | null = null;
      try {
        memtDb = new Database(this.memtDbPath, { readonly: true });
        queryDb(memtDb, "experiences");
      } catch {
        // ignore
      } finally {
        try {
          memtDb?.close();
        } catch {
          // ignore
        }
      }
    }

    for (const r of rows) {
      const domainLabel = sanitizeText(r.domain || "memt");
      addItem({
        id: `phil_memt_${slugify(r.id)}`,
        section: "philosophies",
        title: truncateClean(`MemT Rule [${domainLabel}]: ${r.condition}`, 96),
        subtitle: `Verified MemT Experience (${Math.round((Number(r.confidence) || 0.9) * 100)}% confidence)`,
        summary: truncateClean(r.recommendation, 360),
        thesis: truncateClean(`When ${r.condition}: ${r.recommendation}`, 260),
        domain: domainLabel === "design" || domainLabel === "video" ? "Creative Craft" : "AI & Operating Systems",
        conviction: (Number(r.confidence) || 0) >= 0.95 ? "core" : "active",
        status: "living",
        leverage_score: clampScore(Math.round((Number(r.confidence) || 0.9) * 94)),
        pinned: false,
        tags: uniqueStrings(["memt", "verified-rule", domainLabel]),
        linked_people: extractLinkedPeople(`${r.condition} ${r.recommendation}`),
        source_label: "Kizuki MemT-1.0",
        updated_at: r.updated_at || new Date().toISOString(),
        origin: "discovered",
      });
    }
  }

  private collectInterests(addItem: (item: CodexItem) => void): {
    recentBookmarks: CodexFeedBookmark[];
    totalBookmarks: number;
  } {
    // 2a. X Bookmarks (clustered by domain + feed)
    const recentBookmarks: CodexFeedBookmark[] = [];
    let totalBookmarks = 0;

    const bmPath = join(this.bridgesDir, "x-bookmarks", "events.jsonl");
    if (existsSync(bmPath)) {
      try {
        const lines = readFileSync(bmPath, "utf8").split(/\r?\n/).filter((l) => l.trim());
        const byCluster = new Map<string, CodexFeedBookmark[]>();
        for (const c of BOOKMARK_CLUSTERS) byCluster.set(c.id, []);

        const allParsed: CodexFeedBookmark[] = [];
        for (const line of lines) {
          try {
            const row = JSON.parse(line) as {
              id?: string;
              occurred_at?: string;
              author_handle?: string;
              url?: string;
              like_count?: number;
              text?: string;
            };
            const cleanText = cleanBookmarkTweetText(row.text || "");
            if (!cleanText || cleanText.length < 12) continue;
            const cluster = classifyBookmarkDomain(`${row.author_handle || ""} ${cleanText}`);
            const item: CodexFeedBookmark = {
              id: sanitizeText(row.id || `bm_${allParsed.length}`),
              author: sanitizeText(row.author_handle || "@unknown"),
              text: cleanText,
              url: typeof row.url === "string" && row.url.startsWith("http") ? row.url : "",
              date: typeof row.occurred_at === "string" ? row.occurred_at.slice(0, 10) : "",
              likes: Number(row.like_count) || 0,
              domain: cluster.domain,
            };
            allParsed.push(item);
            byCluster.get(cluster.id)?.push(item);
          } catch {
            // skip malformed json line
          }
        }

        totalBookmarks = allParsed.length;

        // Sort recent feed newest first, tiebreak by likes
        const sortedFeed = [...allParsed].sort((a, b) => {
          if (b.date !== a.date) return b.date.localeCompare(a.date);
          return b.likes - a.likes;
        });
        recentBookmarks.push(...sortedFeed.slice(0, 48));

        const bmMtime = fileMtimeIso(bmPath);
        for (const cluster of BOOKMARK_CLUSTERS) {
          const clusterItems = byCluster.get(cluster.id) || [];
          if (clusterItems.length === 0) continue;
          const topBySignal = [...clusterItems]
            .sort((a, b) => {
              const recencyA = a.date >= "2026-01-01" ? 1 : 0;
              const recencyB = b.date >= "2026-01-01" ? 1 : 0;
              if (recencyB !== recencyA) return recencyB - recencyA;
              return b.likes - a.likes;
            })
            .slice(0, 6);

          const sampleAuthors = Array.from(new Set(topBySignal.map((b) => b.author))).slice(0, 4).join(", ");
          addItem({
            id: cluster.id,
            section: "interests",
            title: cluster.title,
            subtitle: `${clusterItems.length} X bookmarks | Top voices: ${sampleAuthors}`,
            summary: `${cluster.subtitle}. Curated from ${clusterItems.length} real saved X bookmarks spanning ${topBySignal[0]?.date || "recent"} threads.`,
            thesis: cluster.thesis,
            next_move: cluster.next_move,
            domain: cluster.domain,
            conviction: clusterItems.length >= 25 ? "core" : "active",
            status: "living",
            leverage_score: clampScore(78 + Math.min(18, Math.round(clusterItems.length / 4))),
            pinned: clusterItems.length >= 40,
            tags: cluster.tags,
            linked_people: extractLinkedPeople(topBySignal.map((b) => `${b.author} ${b.text}`).join(" ")),
            source_label: `X Bookmarks (${clusterItems.length} saved)`,
            source_path: bmPath,
            bookmarks: topBySignal.map(({ author, text, url, date, likes }) => ({
              author,
              text,
              url,
              date,
              likes,
            })),
            updated_at: bmMtime,
            origin: "discovered",
          });
        }
      } catch {
        // skip
      }
    }

    // 2b. Garden Knowledge Domains
    if (this.gardenPath && existsSync(this.gardenPath)) {
      this.collectGardenInterests(addItem);
    }

    // 2c. Taste Vault References
    if (this.lifeOsWikiPath) {
      this.collectTasteVaultInterests(addItem);
    }

    return { recentBookmarks, totalBookmarks };
  }

  private collectGardenInterests(addItem: (item: CodexItem) => void): void {
    if (!this.gardenPath) return;

    // Group domain interest notes from knowledge garden
    const interestsNotesDir = join(this.gardenPath, "interests", "notes");
    if (existsSync(interestsNotesDir)) {
      const files = readdirSync(interestsNotesDir).filter((f) => f.endsWith(".md")).sort();
      for (const fn of files.slice(0, 6)) {
        const full = join(interestsNotesDir, fn);
        const parsed = parseMarkdown(readFileSync(full, "utf8"), basename(fn, ".md"));
        addItem({
          id: `interest_garden_note_${slugify(basename(fn, ".md"))}`,
          section: "interests",
          title: parsed.title,
          subtitle: "Garden Knowledge Research Brief",
          summary: truncateClean(extractFirstParagraph(parsed.body), 340),
          thesis: truncateClean(extractFirstParagraph(parsed.body), 220),
          domain: "Research & Interests",
          conviction: "active",
          status: "living",
          leverage_score: 84,
          pinned: false,
          tags: uniqueStrings(["interests", "garden", ...getFmTags(parsed.frontmatter)]),
          linked_people: extractLinkedPeople(`${parsed.title} ${parsed.body}`),
          source_label: "Garden Knowledge / interests",
          source_path: full,
          updated_at: fileMtimeIso(full),
          origin: "discovered",
        });
      }
    }

    // Curated domain summaries for agentic-video, design, taste, frontend
    const gardenDomains: Array<{
      dir: string;
      id: string;
      title: string;
      domain: string;
      thesis: string;
      nextMove: string;
      tags: string[];
    }> = [
      {
        dir: "agentic-video",
        id: "interest_garden_agentic_video",
        title: "Agentic Video, Shot-Reader & Programmatic Cinema",
        domain: "Anime & Video Production",
        thesis: "Combine shot-reader camera analysis, layered satsuei compositing, and deterministic code-video engines.",
        nextMove: "Apply adopted agentic-video techniques directly to Infinite Idol and launch reels.",
        tags: ["agentic-video", "shot-reader", "motion", "garden"],
      },
      {
        dir: "design",
        id: "interest_garden_design_systems",
        title: "Editorial & Commercial Brand Design Precedents",
        domain: "Design, Motion & Visual Craft",
        thesis: "Ground every web and brand interface in verified editorial precedents rather than generic SaaS templates.",
        nextMove: "Pull concrete typographic and layout references from the design garden before any new page build.",
        tags: ["design", "editorial", "branding", "garden"],
      },
      {
        dir: "taste",
        id: "interest_garden_taste_ledger",
        title: "Live Owner Taste Ledger & Verdicts",
        domain: "Taste & Standards",
        thesis: "Codify every real acceptance and rejection verdict so agents converge on the owner's exact visual and UX bar.",
        nextMove: "Keep distilling high-signal verdicts from live builds into canonical taste skills.",
        tags: ["taste-ledger", "craft", "standards", "garden"],
      },
      {
        dir: "frontend",
        id: "interest_garden_frontend_craft",
        title: "Frontend Craft, AEO & Tactile Interfaces",
        domain: "Design, Motion & Visual Craft",
        thesis: "Pair dense working product UI with tactile micro-artifacts and clean agent-discoverable surfaces.",
        nextMove: "Bring AEO agent-layer and responsive craft into Kizuki and active studio surfaces.",
        tags: ["frontend", "aeo", "ui-craft", "garden"],
      },
    ];

    for (const gd of gardenDomains) {
      const notesDir = join(this.gardenPath, gd.dir, "notes");
      if (!existsSync(notesDir)) continue;
      const allNotes = readdirSync(notesDir).filter((f) => f.endsWith(".md")).sort();
      const nonBm = allNotes.filter(
        (f) => !f.startsWith("bm-") && !f.startsWith("board-") && f !== "skills-catalog.md"
      );
      if (allNotes.length === 0) continue;

      const sampleTitles: string[] = [];
      let latestMtime = "";
      for (const fn of (nonBm.length > 0 ? nonBm : allNotes).slice(0, 6)) {
        const fp = join(notesDir, fn);
        const mt = fileMtimeIso(fp);
        if (mt > latestMtime) latestMtime = mt;
        try {
          const parsed = parseMarkdown(readFileSync(fp, "utf8"), basename(fn, ".md"));
          if (parsed.title) sampleTitles.push(parsed.title);
        } catch {
          // ignore
        }
      }

      addItem({
        id: gd.id,
        section: "interests",
        title: gd.title,
        subtitle: `${allNotes.length} garden knowledge notes (${nonBm.length} curated references)`,
        summary: truncateClean(
          sampleTitles.length > 0
            ? `Highlights: ${sampleTitles.slice(0, 5).join(" | ")}`
            : `${allNotes.length} distilled notes tracked in garden/${gd.dir}.`,
          360
        ),
        thesis: gd.thesis,
        next_move: gd.nextMove,
        domain: gd.domain,
        conviction: "active",
        status: "living",
        leverage_score: 84,
        pinned: false,
        tags: gd.tags,
        linked_people: [],
        source_label: `Garden Knowledge / ${gd.dir} (${allNotes.length} notes)`,
        source_path: join(this.gardenPath, gd.dir, "index.md"),
        updated_at: latestMtime || new Date().toISOString(),
        origin: "discovered",
      });
    }
  }

  private collectTasteVaultInterests(addItem: (item: CodexItem) => void): void {
    if (!this.lifeOsWikiPath) return;
    const tasteDir = join(this.lifeOsWikiPath, "05-knowledge", "taste");
    if (!existsSync(tasteDir)) return;

    const pickedFiles: Array<{ file: string; domain: string; score: number }> = [
      { file: "consumer-ui-principles.md", domain: "Design, Motion & Visual Craft", score: 89 },
      { file: "ui-and-visual-language.md", domain: "Design, Motion & Visual Craft", score: 88 },
      { file: "motion-linear-launch-reels.md", domain: "Anime & Video Production", score: 85 },
      { file: "motion-teenage-engineering-product-pages.md", domain: "Design, Motion & Visual Craft", score: 86 },
      { file: "editorial-bureau-borsche.md", domain: "Design, Motion & Visual Craft", score: 83 },
      { file: "social-a24-title-cards.md", domain: "Film & Media", score: 84 },
      { file: "voice-and-phrases.md", domain: "Taste & Standards", score: 89 },
      { file: "encrypt-positioning.md", domain: "Crypto, Solana & Markets", score: 86 },
    ];

    for (const pick of pickedFiles) {
      const full = join(tasteDir, pick.file);
      if (!existsSync(full)) continue;
      try {
        const raw = readFileSync(full, "utf8");
        const parsed = parseMarkdown(raw, basename(pick.file, ".md"));
        const medium = getFmString(parsed.frontmatter, "medium");
        const polarity = getFmString(parsed.frontmatter, "polarity");
        const summary = truncateClean(extractFirstParagraph(parsed.body), 340);
        addItem({
          id: `interest_taste_${slugify(basename(pick.file, ".md"))}`,
          section: "interests",
          title: parsed.title,
          subtitle: [medium ? `Medium: ${medium}` : "Taste Vault Reference", polarity || ""].filter(Boolean).join(" | "),
          summary,
          thesis: truncateClean(
            findSectionText(parsed.sections, ["correction", "why it works", "core", "principle"]) || summary,
            240
          ),
          domain: pick.domain,
          conviction: polarity === "exemplar" ? "core" : "active",
          status: "living",
          leverage_score: pick.score,
          pinned: false,
          tags: uniqueStrings(["taste-vault", medium, polarity, ...getFmTags(parsed.frontmatter)]),
          linked_people: extractLinkedPeople(`${parsed.title} ${parsed.body}`),
          source_label: "Owner Wiki / Taste Vault",
          source_path: full,
          vault_doc_path: this.resolveWikiVaultDoc(`05-knowledge/taste/${pick.file}`),
          updated_at: fileMtimeIso(full),
          origin: "discovered",
        });
      } catch {
        // skip
      }
    }
  }

  private collectHobbies(
    addItem: (item: CodexItem) => void,
    ownerProfile: { raw: string; path: string; vaultDocPath?: string; updatedAt: string } | null
  ): void {
    // 3a. Obsidian Craft Labs
    const obsidianRoot = join(this.bridgesDir, "mac-obsidian");
    if (existsSync(obsidianRoot)) {
      const obsidianLabs: Array<{
        id: string;
        relDir: string;
        anchorFile: string;
        title: string;
        subtitle: string;
        domain: string;
        thesis: string;
        nextMove: string;
        tags: string[];
        score: number;
      }> = [
        {
          id: "hobby_obsidian_polymarket",
          relDir: "Trading/Polymarket",
          anchorFile: "Trading/Polymarket/survival-log.md",
          title: "Polymarket Prediction Market Systems",
          subtitle: "Live probability modeling, survival logs, and market-making experiments",
          domain: "Trading & Quant Craft",
          thesis: "Treat prediction markets as real-time calibration engines where edge comes from speed, discipline, and zero idle capital.",
          nextMove: "Review Polymarket survival-log lessons before scaling any new automated strategy.",
          tags: ["polymarket", "trading", "prediction-markets", "obsidian"],
          score: 84,
        },
        {
          id: "hobby_obsidian_cataclysm",
          relDir: "Trading/Project cataclysm",
          anchorFile: "Trading/Project cataclysm/Multi-Pair Momentum Architecture.md",
          title: "Project Cataclysm: Multi-Pair Momentum Lab",
          subtitle: "Multi-pair scanner architecture and momentum trading prototypes",
          domain: "Trading & Quant Craft",
          thesis: "Systematic multi-pair scanning beats manual chart watching when risk rules never sabotage positive EV.",
          nextMove: "Extract reusable scanner primitives into active trading prototypes.",
          tags: ["cataclysm", "momentum", "scanners", "trading", "obsidian"],
          score: 80,
        },
        {
          id: "hobby_obsidian_solana_arb",
          relDir: "Trading/Solana",
          anchorFile: "Trading/Solana/solana-arb-architecture.md",
          title: "Solana On-Chain Arbitrage Research",
          subtitle: "Competitive analysis, execution architecture, and low-latency routing on Solana",
          domain: "Trading & Quant Craft",
          thesis: "Solana execution edge requires understanding Jito/RPC microstructure and exact competitive latency.",
          nextMove: "Keep execution research warm for on-chain routing benchmarks.",
          tags: ["solana", "arbitrage", "mev", "trading", "obsidian"],
          score: 82,
        },
        {
          id: "hobby_obsidian_sui_bots",
          relDir: "Trading/Sui Bots",
          anchorFile: "Trading/BELLMAN-FORD-CYCLE-DETECTION.md",
          title: "DeFi Graph Arbitrage & Liquidation Labs",
          subtitle: "Bellman-Ford cycle detection, PTB routers, and DeFi liquidation research (archived unless revived)",
          domain: "Trading & Quant Craft",
          thesis: "Cycle detection and direct PTB routing taught battle-tested lessons on on-chain execution reliability.",
          nextMove: "Keep archived per standing rule unless explicitly revived; reuse execution patterns on Solana.",
          tags: ["bellman-ford", "defi", "bots", "trading", "obsidian"],
          score: 72,
        },
        {
          id: "hobby_obsidian_agents_lab",
          relDir: "Agents",
          anchorFile: "Agents/AGENT_REGISTRY.md",
          title: "Multi-Agent Systems & Swarm Architecture",
          subtitle: "Agent registries, coordination protocols, and post-mortem mistake ledgers",
          domain: "AI & Systems Craft",
          thesis: "Multi-agent teams compound only when roles, memory boundaries, and post-mortem lessons are explicitly encoded.",
          nextMove: "Fold sharpest agent lessons from Obsidian into Kizuki MemT and Neon core doctrine.",
          tags: ["multi-agent", "swarms", "coordination", "obsidian"],
          score: 89,
        },
        {
          id: "hobby_obsidian_comfyui",
          relDir: "Reviews/comfyui-deep-dive",
          anchorFile: "Reviews/comfyui-deep-dive/sora-research.md",
          title: "ComfyUI & Generative Visual Pipelines",
          subtitle: "Node-graph image/video pipelines, prompt engineering, and visual quality audits",
          domain: "Anime & Visual Craft",
          thesis: "Local node-graph generation and strict visual QA unlock bespoke aesthetics without generic cloud AI sameness.",
          nextMove: "Bridge ComfyUI visual control with Infinite Idol character consistency workflows.",
          tags: ["comfyui", "generative-art", "visuals", "obsidian"],
          score: 83,
        },
        {
          id: "hobby_obsidian_theatre_audits",
          relDir: "Reviews/theatre",
          anchorFile: "Reviews/theatre/theatre-detection-audit.md",
          title: "Anti-Theatre & System Truth Auditing",
          subtitle: "Detecting fake progress, stubbed telemetry, and silent failures across services",
          domain: "AI & Systems Craft",
          thesis: "An oracle that cannot fail is theatre; every live system needs real end-to-end verification.",
          nextMove: "Keep applying anti-theatre audits to every Kizuki and trading dashboard release.",
          tags: ["anti-theatre", "audits", "verification", "obsidian"],
          score: 85,
        },
        {
          id: "hobby_obsidian_dashboard_craft",
          relDir: "Reviews/dashboard-ux-2026-01-30",
          anchorFile: "Reviews/dashboard-ux-2026-01-30/CONSOLIDATED-REPORT.md",
          title: "Command-Center & Dashboard UX Craft",
          subtitle: "Dense real-time interfaces, visual consistency teardowns, and mobile ergonomics",
          domain: "Design, Motion & Visual Craft",
          thesis: "Operator dashboards should feel live, high-density, and calm under load rather than decorative toy widgets.",
          nextMove: "Channel dashboard UX teardowns directly into Kizuki Mind Explorer.",
          tags: ["dashboards", "ux-craft", "obsidian"],
          score: 84,
        },
        {
          id: "hobby_obsidian_simp_wars",
          relDir: "Reviews/simp-wars",
          anchorFile: "Reviews/simp-wars/simp-wars-final-verdict.md",
          title: "Game Loops, Gacha Craft & Interactive Toys",
          subtitle: "Copy audits, engagement loops, and game-feel iteration notes",
          domain: "Anime & Visual Craft",
          thesis: "Interactive products win when copy, feedback loops, and progression feel unmistakably alive.",
          nextMove: "Carry game-feel polish lessons into Infinite Idol.",
          tags: ["games", "gacha", "interactive", "obsidian"],
          score: 79,
        },
      ];

      for (const lab of obsidianLabs) {
        const dirFull = join(obsidianRoot, lab.relDir);
        const anchorFull = join(obsidianRoot, lab.anchorFile);
        if (!existsSync(dirFull) && !existsSync(anchorFull)) continue;

        let docCount = 0;
        if (existsSync(dirFull)) {
          try {
            docCount = readdirSync(dirFull).filter((f) => f.endsWith(".md")).length;
          } catch {
            docCount = 0;
          }
        }
        let excerpt = "";
        let updatedAt = new Date().toISOString();
        if (existsSync(anchorFull)) {
          try {
            const raw = readFileSync(anchorFull, "utf8");
            const parsed = parseMarkdown(raw, lab.title);
            excerpt = truncateClean(extractFirstParagraph(parsed.body), 240);
            updatedAt = fileMtimeIso(anchorFull);
          } catch {
            // ignore
          }
        }

        addItem({
          id: lab.id,
          section: "hobbies",
          title: lab.title,
          subtitle: docCount > 0 ? `${lab.subtitle} (${docCount} notes)` : lab.subtitle,
          summary: excerpt ? `${lab.subtitle}. ${excerpt}` : lab.subtitle,
          thesis: lab.thesis,
          next_move: lab.nextMove,
          domain: lab.domain,
          conviction: "active",
          status: lab.id === "hobby_obsidian_sui_bots" ? "active" : "living",
          leverage_score: lab.score,
          pinned: false,
          tags: lab.tags,
          linked_people: [],
          source_label: `Obsidian / ${lab.relDir}`,
          source_path: existsSync(anchorFull) ? anchorFull : dirFull,
          vault_doc_path: this.resolveVaultDocPath(`obsidian/${lab.anchorFile}`),
          updated_at: updatedAt,
          origin: "discovered",
        });
      }
    }

    // 3b. Personal Craft & Lifestyle Anchors from owner-profile.md
    if (ownerProfile) {
      const anchors: Array<{
        id: string;
        title: string;
        subtitle: string;
        summary: string;
        thesis: string;
        anti_pattern: string;
        next_move: string;
        domain: string;
        tags: string[];
        people: string[];
        score: number;
      }> = [
        {
          id: "hobby_personal_physical_discipline",
          title: "Physical Energy & Training Discipline",
          subtitle: "Measured nutrition and training cadence as foundational operating energy",
          summary:
            "Consistent nutrition and strength protocol tracked with direct, measurable checkpoints and zero wellness fluff.",
          thesis: "Physical energy is foundational infrastructure for high-output creative and engineering work.",
          anti_pattern: "Generic wellness pep talks or unmeasured routine drift.",
          next_move: "Log weekly checkpoint and keep training cadence locked during intense sprint weeks.",
          domain: "Health & Vitality",
          tags: ["health", "discipline", "personal"],
          people: [],
          score: 88,
        },
        {
          id: "hobby_personal_anime_direction",
          title: "Anime Direction & Visual Storytelling",
          subtitle: "High-craft anime aesthetics, satsuei compositing, and studio visual standards",
          summary:
            "Deep creative interest in genuine anime direction, layered cel timing, rigged 3D/Live2D craft, and cinematic framing.",
          thesis: "Strong flavor succeeds when execution hits a genuine studio craft bar.",
          anti_pattern: "Primitive procedural dolls, flat raw AI video clips, or generic template UI.",
          next_move: "Run visual clips through strict layered satsuei and frame-by-frame pixel reviews.",
          domain: "Anime & Visual Craft",
          tags: ["anime", "storytelling", "satsuei", "personal"],
          people: [],
          score: 89,
        },
      ];

      for (const a of anchors) {
        addItem({
          id: a.id,
          section: "hobbies",
          title: a.title,
          subtitle: a.subtitle,
          summary: a.summary,
          thesis: a.thesis,
          anti_pattern: a.anti_pattern,
          next_move: a.next_move,
          domain: a.domain,
          conviction: "core",
          status: "living",
          leverage_score: a.score,
          pinned: a.id === "hobby_personal_anime_direction",
          tags: a.tags,
          linked_people: a.people,
          source_label: "Owner Profile / Personal Anchors",
          source_path: ownerProfile.path,
          vault_doc_path: ownerProfile.vaultDocPath,
          updated_at: ownerProfile.updatedAt,
          origin: "discovered",
        });
      }
    }
  }

  private collectIdeas(
    addItem: (item: CodexItem) => void,
    ownerProfile: { raw: string; path: string; vaultDocPath?: string; updatedAt: string } | null
  ): void {
    const addedSlugs = new Set<string>();

    // 4a. Core Projects & Workstreams (grounded in owner-profile.md & owner-anchors.md)
    const ventures: Array<{
      id: string;
      slugKey: string;
      title: string;
      subtitle: string;
      summary: string;
      thesis: string;
      next_move: string;
      domain: string;
      stage: IdeaStage;
      conviction: ConvictionLevel;
      score: number;
      pinned: boolean;
      tags: string[];
      people: string[];
      vaultDoc?: string;
    }> = [
      {
        id: "idea_venture_kizuki",
        slugKey: "kizuki",
        title: "Kizuki Personal Mind OS",
        subtitle: "Local-first Personal Knowledge Vault, MemT-1.0 & Mind Explorer",
        summary:
          "Compounding personal memory vault, world consolidation engine, MemT procedural memory, and navigable Mind Explorer built to a stranger-usable install bar.",
        thesis: "A second brain should be an autonomous execution environment with verified memory, not a dead folder of notes.",
        next_move: "Ship stranger-usable Mind Codex, Replay, and People intelligence with zero manual setup friction.",
        domain: "AI & Systems",
        stage: "building",
        conviction: "core",
        score: 96,
        pinned: true,
        tags: ["venture", "kizuki", "memory", "life-os", "memt"],
        people: [],
        vaultDoc: this.resolveVaultDocPath("owner-anchors.md"),
      },
      {
        id: "idea_venture_local_llm_stack",
        slugKey: "local-llm",
        title: "Local GPU Inference & Model Stack",
        subtitle: "Private Loopback Inference & Automatic Failover",
        summary:
          "Dedicated local GPU inference infrastructure powering low-latency private models and MemT experiments without mandatory cloud dependency.",
        thesis: "Sovereign local compute removes token anxiety and unlocks continuous private cognition.",
        next_move: "Benchmark local inference latency and wire local model capacity into daily Kizuki synthesis.",
        domain: "AI & Systems",
        stage: "building",
        conviction: "active",
        score: 86,
        pinned: false,
        tags: ["infra", "gpu", "local-models"],
        people: [],
        vaultDoc: this.resolveVaultDocPath("owner-anchors.md"),
      },
    ];

    const updatedBase = ownerProfile?.updatedAt || new Date().toISOString();
    if (ownerProfile || existsSync(join(this.vaultPath, "owner-anchors.md"))) {
      for (const v of ventures) {
        addedSlugs.add(v.slugKey);
        addItem({
          id: v.id,
          section: "ideas",
          title: v.title,
          subtitle: v.subtitle,
          summary: v.summary,
          thesis: v.thesis,
          next_move: v.next_move,
          domain: v.domain,
          stage: v.stage,
          conviction: v.conviction,
          status: v.stage === "parked" ? "active" : "living",
          leverage_score: v.score,
          pinned: v.pinned,
          tags: v.tags,
          linked_people: v.people,
          source_label: "Projects Registry / Owner Profile",
          source_path: ownerProfile?.path,
          vault_doc_path: v.vaultDoc,
          updated_at: updatedBase,
          origin: "discovered",
        });
      }
    }

    // 4b. Active Projects from Owner Wiki
    if (this.lifeOsWikiPath) {
      const projDir = join(this.lifeOsWikiPath, "04-work", "projects", "active");
      if (existsSync(projDir)) {
        const mdFiles = readdirSync(projDir).filter((f) => f.endsWith(".md")).sort().slice(0, 12);
        const pickedProjects: Array<{ file: string; stage: IdeaStage; domain: string; score: number }> = mdFiles.map(
          (file) => ({
            file,
            stage: "building" as IdeaStage,
            domain: "AI & Systems",
            score: 84,
          }),
        );

        for (const p of pickedProjects) {
          const full = join(projDir, p.file);
          if (!existsSync(full)) continue;
          try {
            const raw = readFileSync(full, "utf8").slice(0, 14_000);
            const parsed = parseMarkdown(raw, basename(p.file, ".md"));
            const cleanedBody = parsed.body
              .split(/\r?\n/)
              .filter((ln) => !/pre-compaction snapshot|sha256:/i.test(ln))
              .join("\n");
            const summary = truncateClean(
              findSectionText(parsed.sections, ["summary", "overview", "goal", "mission", "purpose"]) ||
                extractFirstParagraph(cleanedBody) ||
                `Active operational project (${p.domain}) tracked inside the Kizuki vault.`,
              340
            );
            const nextBullets = extractBullets(
              findSectionText(parsed.sections, ["next", "human main quests", "action", "milestones"]) || parsed.body,
              2
            );
            addItem({
              id: `idea_proj_${slugify(basename(p.file, ".md"))}`,
              section: "ideas",
              title: parsed.title,
              subtitle: `Active Project | Stage: ${p.stage}`,
              summary,
              thesis: truncateClean(extractFirstParagraph(parsed.body), 220),
              next_move: nextBullets[0] ? truncateClean(nextBullets[0], 180) : undefined,
              domain: p.domain,
              stage: p.stage,
              conviction: p.score >= 87 ? "core" : "active",
              status: "living",
              leverage_score: p.score,
              pinned: false,
              tags: uniqueStrings(["project", p.stage, ...getFmTags(parsed.frontmatter)]),
              linked_people: extractLinkedPeople(`${parsed.title} ${raw.slice(0, 3000)}`),
              source_label: "Owner Wiki / Active Projects",
              source_path: full,
              vault_doc_path: this.resolveWikiVaultDoc(`04-work/projects/active/${p.file}`),
              updated_at: fileMtimeIso(full),
              origin: "discovered",
            });
          } catch {
            // skip
          }
        }
      }
    }

    // 4c. Obsidian Ideas Inbox
    const ideasInboxPath = join(this.bridgesDir, "mac-obsidian", "Ideas", "Ideas Inbox.md");
    if (existsSync(ideasInboxPath)) {
      try {
        const raw = readFileSync(ideasInboxPath, "utf8");
        const parsed = parseMarkdown(raw, "Ideas Inbox");
        const toExplore = extractBullets(findSectionText(parsed.sections, ["to explore"]), 8);
        const parked = extractBullets(findSectionText(parsed.sections, ["parked"]), 6);
        const mt = fileMtimeIso(ideasInboxPath);
        const vaultDoc = this.resolveVaultDocPath("obsidian/Ideas/Ideas Inbox.md");

        for (const ideaLine of toExplore) {
          addItem({
            id: `idea_inbox_${slugify(ideaLine.slice(0, 42))}`,
            section: "ideas",
            title: truncateClean(ideaLine.split(" - ")[0] || ideaLine, 76),
            subtitle: "Obsidian Ideas Inbox | To Explore",
            summary: truncateClean(ideaLine, 260),
            domain: "AI & Systems",
            stage: "spark",
            conviction: "testing",
            status: "open",
            leverage_score: 72,
            pinned: false,
            tags: ["idea-inbox", "spark", "obsidian"],
            linked_people: extractLinkedPeople(ideaLine),
            source_label: "Obsidian / Ideas Inbox",
            source_path: ideasInboxPath,
            vault_doc_path: vaultDoc,
            updated_at: mt,
            origin: "discovered",
          });
        }

        for (const ideaLine of parked) {
          addItem({
            id: `idea_inbox_parked_${slugify(ideaLine.slice(0, 42))}`,
            section: "ideas",
            title: truncateClean(ideaLine.split(" - ")[0] || ideaLine, 76),
            subtitle: "Obsidian Ideas Inbox | Parked",
            summary: truncateClean(ideaLine, 260),
            domain: "AI & Systems",
            stage: "parked",
            conviction: "testing",
            status: "active",
            leverage_score: 60,
            pinned: false,
            tags: ["idea-inbox", "parked", "obsidian"],
            linked_people: extractLinkedPeople(ideaLine),
            source_label: "Obsidian / Ideas Inbox",
            source_path: ideasInboxPath,
            vault_doc_path: vaultDoc,
            updated_at: mt,
            origin: "discovered",
          });
        }
      } catch {
        // skip
      }
    }

    // 4d. Curated High-Signal Personal Apple Notes (strictly filtered for zero spam/OAuth/legacy CRM)
    const macNotesDir = join(this.bridgesDir, "mac-notes");
    if (existsSync(macNotesDir)) {
      const rejectNoteRe =
        /oauth|authorize|onedome|conveyanc|mailinator|last-login|sketch|new-note|account-details|invoice|email|firstname|surname|openclaw-source/i;
      const signalNoteRe =
        /\b(sovereign|chains|bridges|custodian|crypto|agent|token|anime|film|game|protocol|startup|idea)\b/i;

      try {
        const files = readdirSync(macNotesDir)
          .filter((f) => f.endsWith(".md") && !rejectNoteRe.test(f))
          .sort((a, b) => {
            const na = Number.parseInt(a.split("-", 1)[0], 10) || 0;
            const nb = Number.parseInt(b.split("-", 1)[0], 10) || 0;
            return nb - na;
          });

        let picked = 0;
        for (const fn of files) {
          if (picked >= 5) break;
          const full = join(macNotesDir, fn);
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (st.size < 240 || st.size > 24_000) continue;

          const raw = readFileSync(full, "utf8");
          if (/oauth|access_token|onedome|conveyancing|mailinator|client_id=/i.test(raw)) continue;
          const parsed = parseMarkdown(raw, basename(fn, ".md"));
          if (!parsed.title || parsed.title.length < 6 || /^[{•"']/.test(parsed.title)) continue;
          if (!signalNoteRe.test(`${parsed.title} ${parsed.body.slice(0, 600)}`)) continue;

          const summary = truncateClean(extractFirstParagraph(parsed.body), 280);
          if (summary.length < 40) continue;

          picked++;
          addItem({
            id: `idea_note_${slugify(basename(fn, ".md"))}`,
            section: "ideas",
            title: truncateClean(parsed.title, 78),
            subtitle: "Apple Notes Creative Spark",
            summary,
            domain: /chain|crypto|token|custodian|protocol/i.test(`${parsed.title} ${summary}`)
              ? "Systems & Protocols"
              : "Creative & Strategy",
            stage: "spark",
            conviction: "testing",
            status: "open",
            leverage_score: 74,
            pinned: false,
            tags: uniqueStrings(["apple-notes", "spark"]),
            linked_people: extractLinkedPeople(`${parsed.title} ${summary}`),
            source_label: "Apple Notes",
            source_path: full,
            vault_doc_path: this.resolveVaultDocPath(`apple-notes/${fn}`),
            updated_at: st.mtime.toISOString(),
            origin: "discovered",
          });
        }
      } catch {
        // skip
      }
    }
  }

  private collectActions(
    addItem: (item: CodexItem) => void,
    ownerProfile: { raw: string; path: string; vaultDocPath?: string; updatedAt: string } | null,
    ideas: CodexItem[]
  ): void {
    // 5a. Live Owner Actions from owner-actions.json
    const ownerActions = this.readOwnerActions();
    for (const act of ownerActions) {
      const done = Boolean(act.done);
      addItem({
        id: `action_owner_${slugify(act.id)}`,
        section: "actions",
        title: truncateClean(act.title, 110),
        subtitle: `Owner Action | ${sanitizeText(act.tag || "General")} (${done ? "Completed" : "Open"})`,
        summary: truncateClean(act.detail || act.title, 320),
        next_move: done ? undefined : truncateClean(act.title, 180),
        domain: sanitizeText(act.tag || "Execution"),
        conviction: done ? "active" : "core",
        status: done ? "done" : "open",
        leverage_score: done ? 65 : 88,
        pinned: !done,
        tags: uniqueStrings(["owner-action", act.tag || "action", done ? "done" : "open"]),
        linked_people: extractLinkedPeople(`${act.title} ${act.detail}`),
        source_label: `owner-actions.json (${sanitizeText(act.source || "manual")})`,
        source_path: this.actionsPath,
        updated_at: act.created_at || new Date().toISOString(),
        origin: "discovered",
      });
    }

    // 5b. High-Stakes Open Decisions from owner-profile.md
    if (ownerProfile) {
      const parsedProfile = parseMarkdown(ownerProfile.raw, "Owner Profile");
      const openDecisionSec = findSectionText(parsedProfile.sections, ["open decisions", "decisions"]);
      const decisionBullets = extractBullets(openDecisionSec, 8);
      for (const bullet of decisionBullets) {
        addItem({
          id: `action_decision_${slugify(bullet.slice(0, 40))}`,
          section: "actions",
          title: truncateClean(bullet, 96),
          subtitle: "Open Decision | Owner Profile",
          summary: truncateClean(bullet, 280),
          next_move: truncateClean(bullet, 180),
          domain: "Execution",
          conviction: "core",
          status: "open",
          leverage_score: 90,
          pinned: true,
          tags: ["decision", "open"],
          linked_people: extractLinkedPeople(bullet),
          source_label: "Owner Profile / Open Decisions",
          source_path: ownerProfile.path,
          vault_doc_path: ownerProfile.vaultDocPath,
          updated_at: ownerProfile.updatedAt,
          origin: "discovered",
        });
      }
    }

    // 5c. Active Commitments from Owner Wiki (filtered, deduplicated, top 12 crisp items)
    if (this.lifeOsWikiPath) {
      const commDir = join(this.lifeOsWikiPath, "06-execution", "commitments");
      if (existsSync(commDir)) {
        interface ParsedCommitment {
          fn: string;
          full: string;
          title: string;
          owner: string;
          to: string;
          due: string;
          confidence: string;
          created: string;
          summary: string;
          score: number;
          mtime: string;
        }

        const noiseRe =
          /talk tomorrow|call at 2:00|sports day|message earlier|another call in 30/i;
        const parsedList: ParsedCommitment[] = [];
        const seenTitles = new Set<string>();

        for (const fn of readdirSync(commDir)) {
          if (!fn.startsWith("c-") || !fn.endsWith(".md")) continue;
          const full = join(commDir, fn);
          try {
            const raw = readFileSync(full, "utf8");
            const parsed = parseMarkdown(raw, basename(fn, ".md"));
            const fmStatus = getFmString(parsed.frontmatter, "status").toLowerCase();
            if (fmStatus && fmStatus !== "active" && fmStatus !== "open") continue;

            const bodyStatusMatch = /\*\*status\*\*:\s*([a-z]+)/i.exec(parsed.body);
            const bodyStatus = bodyStatusMatch ? bodyStatusMatch[1].toLowerCase() : "open";
            if (bodyStatus !== "open" && bodyStatus !== "active") continue;

            const owner = getFmString(parsed.frontmatter, "owner") || "Owner";
            const toMatch = /\*\*to\*\*:\s*([^\n]+)/i.exec(parsed.body);
            const to = sanitizeText(toMatch ? toMatch[1].replace(/^-$/, "").trim() : "");

            const h1CommitMatch = /^#\s+Commitment:\s*(.+)$/m.exec(parsed.body);
            const rawCommitTitle = h1CommitMatch ? h1CommitMatch[1].trim() : parsed.title;
            const cleanTitle = sanitizeText(rawCommitTitle.replace(/^Owner:\s*/i, ""));
            if (!cleanTitle || cleanTitle.length < 14 || noiseRe.test(cleanTitle)) continue;
            const normKey = cleanTitle.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            if (seenTitles.has(normKey)) continue;
            seenTitles.add(normKey);

            const dueMatch = /\*\*due\*\*:\s*([^\n]+)/i.exec(parsed.body);
            const due = sanitizeText(dueMatch ? dueMatch[1].trim() : "unspecified");
            const confidence = getFmString(parsed.frontmatter, "confidence").toLowerCase() || "medium";
            const created = getFmString(parsed.frontmatter, "created") || "2026-06-01";
            const highSignalBoost =
              (confidence === "high" ? 12 : 0) +
              (created >= "2026-07-01" ? 8 : 0) +
              (/ux|kizuki|infra|website|review|audit|release/i.test(cleanTitle)
                ? 6
                : 0);

            parsedList.push({
              fn,
              full,
              title: cleanTitle,
              owner,
              to: to && to !== "-" ? to : "",
              due,
              confidence,
              created,
              summary: `Commitment (${created}${due && due !== "unspecified" ? `, due ${due}` : ""}${to && to !== "-" ? `, with ${to}` : ""}): ${cleanTitle}`,
              score: Math.min(84, clampScore(58 + highSignalBoost)),
              mtime: fileMtimeIso(full),
            });
          } catch {
            // skip
          }
        }

        parsedList.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return b.created.localeCompare(a.created);
        });

        for (const c of parsedList.slice(0, 12)) {
          addItem({
            id: `action_commit_${slugify(basename(c.fn, ".md"))}`,
            section: "actions",
            title: truncateClean(c.title, 108),
            subtitle: `Open Commitment | ${c.confidence} confidence | ${c.created}`,
            summary: truncateClean(c.summary, 300),
            next_move: truncateClean(c.title, 180),
            domain: /protocol|website|launch/i.test(c.title)
              ? "Products & GTM"
              : /agent|infra|ux/i.test(c.title)
              ? "AI & Systems"
              : "Execution",
            conviction: c.confidence === "high" ? "core" : "active",
            status: "open",
            leverage_score: c.score,
            pinned: false,
            tags: uniqueStrings(["commitment", c.confidence, c.to ? `with-${slugify(c.to)}` : ""]),
            linked_people: extractLinkedPeople(`${c.title} ${c.to}`),
            source_label: `Owner Wiki / Commitments (${c.created})`,
            source_path: c.full,
            vault_doc_path: this.resolveWikiVaultDoc(`06-execution/commitments/${c.fn}`),
            updated_at: c.mtime,
            origin: "discovered",
          });
        }
      }
    }

    // 5d. Derived Next-Move Actions from Building/Validating Ideas
    const actionableIdeas = ideas
      .filter((i) => (i.stage === "building" || i.stage === "validating") && i.next_move && i.leverage_score >= 85)
      .sort((a, b) => b.leverage_score - a.leverage_score)
      .slice(0, 5);

    for (const idea of actionableIdeas) {
      addItem({
        id: `action_next_${slugify(idea.id)}`,
        section: "actions",
        title: truncateClean(`${idea.title}: ${idea.next_move}`, 110),
        subtitle: `Next Move from ${idea.stage?.toUpperCase() || "ACTIVE"} Venture`,
        summary: truncateClean(idea.summary, 280),
        next_move: idea.next_move,
        domain: idea.domain,
        conviction: idea.conviction,
        status: "open",
        leverage_score: clampScore(idea.leverage_score - 2),
        pinned: false,
        tags: uniqueStrings(["idea-next-move", idea.stage || "building", ...idea.tags.slice(0, 3)]),
        linked_people: idea.linked_people,
        source_label: `Derived from Idea: ${idea.title}`,
        source_path: idea.source_path,
        vault_doc_path: idea.vault_doc_path,
        updated_at: idea.updated_at,
        origin: "discovered",
      });
    }
  }

  private readOwnerActions(): OwnerActionRecord[] {
    if (!existsSync(this.actionsPath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.actionsPath, "utf8"));
      return Array.isArray(parsed) ? (parsed as OwnerActionRecord[]) : [];
    } catch {
      return [];
    }
  }

  private writeOwnerActions(actions: OwnerActionRecord[]): void {
    atomicWriteFile(this.actionsPath, JSON.stringify(actions, null, 2) + "\n", 0o600);
  }

  private assembleAllItems(): {
    items: CodexItem[];
    recentBookmarks: CodexFeedBookmark[];
    totalBookmarks: number;
  } {
    const corpus = this.getCorpus();
    const store = this.loadStore();
    const deleted = new Set(store.deleted_ids);

    const merged: CodexItem[] = [];
    const seen = new Set<string>();

    for (const base of corpus.discovered) {
      if (deleted.has(base.id)) continue;
      const ov = store.overrides[base.id];
      const item = ov ? this.applyOverride(base, ov) : base;
      merged.push(item);
      seen.add(item.id);
    }

    for (const custom of store.custom_items) {
      if (deleted.has(custom.id) || seen.has(custom.id)) continue;
      const ov = store.overrides[custom.id];
      const item = ov ? this.applyOverride(custom, ov) : this.cleanItem(custom);
      merged.push(item);
      seen.add(item.id);
    }

    merged.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (b.leverage_score !== a.leverage_score) return b.leverage_score - a.leverage_score;
      return b.updated_at.localeCompare(a.updated_at);
    });

    return {
      items: merged,
      recentBookmarks: corpus.recentBookmarks,
      totalBookmarks: corpus.totalBookmarks,
    };
  }

  private applyOverride(base: CodexItem, ov: CodexOverride): CodexItem {
    const next: CodexItem = {
      ...base,
      ...(ov.section && VALID_SECTIONS.has(ov.section) ? { section: ov.section } : {}),
      ...(typeof ov.title === "string" && ov.title.trim() ? { title: ov.title } : {}),
      ...(typeof ov.subtitle === "string" ? { subtitle: ov.subtitle } : {}),
      ...(typeof ov.summary === "string" ? { summary: ov.summary } : {}),
      ...(typeof ov.thesis === "string" ? { thesis: ov.thesis } : {}),
      ...(typeof ov.anti_pattern === "string" ? { anti_pattern: ov.anti_pattern } : {}),
      ...(typeof ov.next_move === "string" ? { next_move: ov.next_move } : {}),
      ...(typeof ov.domain === "string" && ov.domain.trim() ? { domain: ov.domain } : {}),
      ...(ov.stage && VALID_STAGES.has(ov.stage) ? { stage: ov.stage } : {}),
      ...(ov.conviction && VALID_CONVICTIONS.has(ov.conviction) ? { conviction: ov.conviction } : {}),
      ...(ov.status && VALID_STATUSES.has(ov.status) ? { status: ov.status } : {}),
      ...(typeof ov.leverage_score === "number" ? { leverage_score: clampScore(ov.leverage_score) } : {}),
      ...(typeof ov.pinned === "boolean" ? { pinned: ov.pinned } : {}),
      ...(Array.isArray(ov.tags) ? { tags: ov.tags } : {}),
      ...(Array.isArray(ov.linked_people) ? { linked_people: ov.linked_people } : {}),
      ...(typeof ov.ai_brief === "string" ? { ai_brief: ov.ai_brief } : {}),
      ...(typeof ov.ai_engine === "string" ? { ai_engine: ov.ai_engine } : {}),
      ...(typeof ov.ai_updated_at === "string" ? { ai_updated_at: ov.ai_updated_at } : {}),
      ...(typeof ov.updated_at === "string" ? { updated_at: ov.updated_at } : {}),
    };
    if (ov.archived === true) {
      next.status = "archived";
    } else if (ov.archived === false && next.status === "archived") {
      next.status = next.section === "actions" ? "open" : "living";
    }
    return this.cleanItem(next);
  }

  private computeStats(allItems: CodexItem[], totalBookmarks: number): {
    stats: CodexStats;
    sections: CodexSectionMeta[];
    domains: CodexDomainStat[];
    stages: Record<IdeaStage, number>;
    open_decisions: CodexItem[];
  } {
    const activeItems = allItems.filter((i) => i.status !== "archived");

    let philosophies = 0;
    let interests = 0;
    let hobbies = 0;
    let ideas = 0;
    let actionsOpen = 0;
    let actionsDone = 0;
    let pinned = 0;

    const stages: Record<IdeaStage, number> = {
      spark: 0,
      validating: 0,
      building: 0,
      shipped: 0,
      parked: 0,
    };

    const domainCounts = new Map<string, number>();
    const openDecisions: CodexItem[] = [];

    for (const item of activeItems) {
      if (item.pinned) pinned++;
      domainCounts.set(item.domain, (domainCounts.get(item.domain) || 0) + 1);

      switch (item.section) {
        case "philosophies":
          philosophies++;
          break;
        case "interests":
          interests++;
          break;
        case "hobbies":
          hobbies++;
          break;
        case "ideas":
          ideas++;
          if (item.stage && stages[item.stage] !== undefined) {
            stages[item.stage]++;
          }
          break;
        case "actions":
          if (item.status === "done") actionsDone++;
          else actionsOpen++;
          if (item.status !== "done" && item.tags.includes("decision")) {
            openDecisions.push(item);
          }
          break;
      }
    }

    const stats: CodexStats = {
      total: activeItems.length,
      philosophies,
      interests,
      hobbies,
      ideas,
      actions_open: actionsOpen,
      actions_done: actionsDone,
      bookmarks: totalBookmarks,
      decisions_open: openDecisions.length,
      pinned,
    };

    const sectionCounts: Record<CodexSection, number> = {
      philosophies,
      interests,
      hobbies,
      ideas,
      actions: actionsOpen + actionsDone,
    };

    const sections: CodexSectionMeta[] = (["philosophies", "interests", "hobbies", "ideas", "actions"] as CodexSection[]).map(
      (id) => ({
        id,
        label: SECTION_DESCRIPTIONS[id].label,
        count: sectionCounts[id],
        description: SECTION_DESCRIPTIONS[id].description,
      })
    );

    const totalForPct = Math.max(1, activeItems.length);
    const domains: CodexDomainStat[] = Array.from(domainCounts.entries())
      .map(([domain, count]) => ({
        domain,
        count,
        pct: Math.round((count / totalForPct) * 100),
      }))
      .sort((a, b) => b.count - a.count);

    return { stats, sections, domains, stages, open_decisions: openDecisions };
  }

  getCodex(opts: CodexQueryOptions = {}): CodexResponse {
    const { items: allItems, recentBookmarks, totalBookmarks } = this.assembleAllItems();
    const { stats, sections, domains, stages, open_decisions } = this.computeStats(allItems, totalBookmarks);

    let filtered = opts.includeArchived ? allItems : allItems.filter((i) => i.status !== "archived");

    if (opts.section && opts.section !== "all") {
      const sec = opts.section.trim().toLowerCase();
      filtered = filtered.filter((i) => i.section === sec);
    }

    if (opts.stage && opts.stage !== "all") {
      const st = opts.stage.trim().toLowerCase();
      filtered = filtered.filter((i) => i.stage === st);
    }

    if (opts.tag) {
      const tg = opts.tag.trim().toLowerCase();
      filtered = filtered.filter((i) => i.tags.some((t) => t.toLowerCase() === tg));
    }

    if (opts.domain && opts.domain !== "all") {
      const dm = opts.domain.trim().toLowerCase();
      filtered = filtered.filter((i) => i.domain.toLowerCase() === dm);
    }

    if (opts.q && opts.q.trim()) {
      const tokens = opts.q
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
      filtered = filtered.filter((item) => {
        const hay = [
          item.title,
          item.subtitle,
          item.summary,
          item.thesis || "",
          item.anti_pattern || "",
          item.next_move || "",
          item.domain,
          item.tags.join(" "),
          item.linked_people.join(" "),
          item.source_label,
        ]
          .join(" ")
          .toLowerCase();
        return tokens.every((tok) => hay.includes(tok));
      });
    }

    const enrichedItems = this.crosslinksProvider
      ? filtered.map((i) => this.attachCrosslinks(i))
      : filtered;

    return {
      stats,
      sections,
      domains,
      stages,
      items: enrichedItems,
      recent_bookmarks: recentBookmarks,
      open_decisions,
      updated_at: new Date().toISOString(),
    };
  }

  getItem(id: string): CodexItem | null {
    if (!id || typeof id !== "string") return null;
    const { items } = this.assembleAllItems();
    const found = items.find((i) => i.id === id) || null;
    return found && this.crosslinksProvider ? this.attachCrosslinks(found) : found;
  }

  upsertItem(req: CodexUpsertRequest): { ok: true; item: CodexItem; stats: CodexStats } {
    if (!req || typeof req !== "object") {
      throw new Error("Invalid upsert payload");
    }
    if (req.section !== undefined && !VALID_SECTIONS.has(req.section)) {
      throw new Error(`Invalid section: ${String(req.section)}`);
    }
    if (req.stage !== undefined && !VALID_STAGES.has(req.stage)) {
      throw new Error(`Invalid stage: ${String(req.stage)}`);
    }
    if (req.conviction !== undefined && !VALID_CONVICTIONS.has(req.conviction)) {
      throw new Error(`Invalid conviction: ${String(req.conviction)}`);
    }
    if (req.status !== undefined && !VALID_STATUSES.has(req.status)) {
      throw new Error(`Invalid status: ${String(req.status)}`);
    }

    const store = this.loadStore();
    const nowIso = new Date().toISOString();
    const corpus = this.getCorpus();

    const targetId = typeof req.id === "string" && req.id.trim() ? req.id.trim() : "";
    const existingDiscovered = targetId ? corpus.discovered.find((i) => i.id === targetId) : undefined;
    const existingCustomIdx = targetId ? store.custom_items.findIndex((i) => i.id === targetId) : -1;

    let savedItem: CodexItem;

    if (existingDiscovered) {
      store.deleted_ids = store.deleted_ids.filter((d) => d !== targetId);
      const prevOv = store.overrides[targetId] || {};
      const nextOv: CodexOverride = {
        ...prevOv,
        ...(req.section !== undefined ? { section: req.section } : {}),
        ...(req.title !== undefined ? { title: sanitizeText(req.title) } : {}),
        ...(req.subtitle !== undefined ? { subtitle: sanitizeText(req.subtitle) } : {}),
        ...(req.summary !== undefined ? { summary: sanitizeText(req.summary) } : {}),
        ...(req.thesis !== undefined ? { thesis: sanitizeText(req.thesis) } : {}),
        ...(req.anti_pattern !== undefined ? { anti_pattern: sanitizeText(req.anti_pattern) } : {}),
        ...(req.next_move !== undefined ? { next_move: sanitizeText(req.next_move) } : {}),
        ...(req.domain !== undefined ? { domain: sanitizeText(req.domain) } : {}),
        ...(req.stage !== undefined ? { stage: req.stage } : {}),
        ...(req.conviction !== undefined ? { conviction: req.conviction } : {}),
        ...(req.status !== undefined ? { status: req.status } : {}),
        ...(req.leverage_score !== undefined ? { leverage_score: clampScore(req.leverage_score) } : {}),
        ...(req.pinned !== undefined ? { pinned: Boolean(req.pinned) } : {}),
        ...(req.archived !== undefined ? { archived: Boolean(req.archived) } : {}),
        ...(req.tags !== undefined ? { tags: uniqueStrings(req.tags) } : {}),
        ...(req.linked_people !== undefined
          ? { linked_people: req.linked_people.map((p) => sanitizeText(p)).filter(Boolean) }
          : {}),
        updated_at: nowIso,
      };
      store.overrides[targetId] = nextOv;
      this.saveStore(store);
      savedItem = this.applyOverride(existingDiscovered, nextOv);
    } else if (existingCustomIdx !== -1) {
      store.deleted_ids = store.deleted_ids.filter((d) => d !== targetId);
      const existing = store.custom_items[existingCustomIdx];
      const updated = this.applyOverride(existing, {
        ...(req.section !== undefined ? { section: req.section } : {}),
        ...(req.title !== undefined ? { title: sanitizeText(req.title) } : {}),
        ...(req.subtitle !== undefined ? { subtitle: sanitizeText(req.subtitle) } : {}),
        ...(req.summary !== undefined ? { summary: sanitizeText(req.summary) } : {}),
        ...(req.thesis !== undefined ? { thesis: sanitizeText(req.thesis) } : {}),
        ...(req.anti_pattern !== undefined ? { anti_pattern: sanitizeText(req.anti_pattern) } : {}),
        ...(req.next_move !== undefined ? { next_move: sanitizeText(req.next_move) } : {}),
        ...(req.domain !== undefined ? { domain: sanitizeText(req.domain) } : {}),
        ...(req.stage !== undefined ? { stage: req.stage } : {}),
        ...(req.conviction !== undefined ? { conviction: req.conviction } : {}),
        ...(req.status !== undefined ? { status: req.status } : {}),
        ...(req.leverage_score !== undefined ? { leverage_score: clampScore(req.leverage_score) } : {}),
        ...(req.pinned !== undefined ? { pinned: Boolean(req.pinned) } : {}),
        ...(req.archived !== undefined ? { archived: Boolean(req.archived) } : {}),
        ...(req.tags !== undefined ? { tags: uniqueStrings(req.tags) } : {}),
        ...(req.linked_people !== undefined
          ? { linked_people: req.linked_people.map((p) => sanitizeText(p)).filter(Boolean) }
          : {}),
        updated_at: nowIso,
      });
      store.custom_items[existingCustomIdx] = updated;
      this.saveStore(store);
      savedItem = updated;
    } else {
      const title = sanitizeText(req.title || "");
      if (!title) {
        throw new Error("title is required when creating a new Codex item");
      }
      const section: CodexSection = req.section || "ideas";
      const id = targetId || `codex_owner_${slugify(title)}_${randomUUID().slice(0, 6)}`;
      const stage: IdeaStage | undefined =
        req.stage || (section === "ideas" ? "spark" : undefined);
      const status: CodexStatus = req.archived
        ? "archived"
        : req.status || (section === "actions" ? "open" : "living");
      const summary = sanitizeText(req.summary || req.thesis || title);
      const linked =
        req.linked_people && req.linked_people.length > 0
          ? req.linked_people.map((p) => sanitizeText(p)).filter(Boolean)
          : extractLinkedPeople(`${title} ${summary} ${req.thesis || ""}`);

      savedItem = this.cleanItem({
        id,
        section,
        title,
        subtitle: sanitizeText(req.subtitle || `${SECTION_DESCRIPTIONS[section].label} | Owner Entry`),
        summary,
        thesis: req.thesis ? sanitizeText(req.thesis) : undefined,
        anti_pattern: req.anti_pattern ? sanitizeText(req.anti_pattern) : undefined,
        next_move: req.next_move ? sanitizeText(req.next_move) : undefined,
        domain: sanitizeText(req.domain || "Personal"),
        stage,
        conviction: req.conviction || "active",
        status,
        leverage_score: clampScore(req.leverage_score ?? 80),
        pinned: Boolean(req.pinned),
        tags: uniqueStrings(["owner", ...(req.tags || [])]),
        linked_people: linked,
        source_label: "Owner Codex",
        updated_at: nowIso,
        origin: "owner",
      });

      store.deleted_ids = store.deleted_ids.filter((d) => d !== id);
      store.custom_items.push(savedItem);
      this.saveStore(store);
    }

    const { items, totalBookmarks } = this.assembleAllItems();
    const { stats } = this.computeStats(items, totalBookmarks);
    return { ok: true, item: savedItem, stats };
  }

  deleteItem(id: string): { ok: true; id: string } {
    const cleanId = (id || "").trim();
    if (!cleanId) {
      throw new Error("id is required");
    }
    const store = this.loadStore();
    const beforeCustomLen = store.custom_items.length;
    store.custom_items = store.custom_items.filter((i) => i.id !== cleanId);
    delete store.overrides[cleanId];
    if (store.custom_items.length === beforeCustomLen && !store.deleted_ids.includes(cleanId)) {
      store.deleted_ids.push(cleanId);
    }
    this.saveStore(store);
    return { ok: true, id: cleanId };
  }

  promoteToAction(req: CodexPromoteRequest): CodexPromoteResponse {
    if (!req || typeof req.id !== "string" || !req.id.trim()) {
      throw new Error("id is required");
    }
    const item = this.getItem(req.id.trim());
    if (!item) {
      throw new Error(`Codex item not found: ${req.id}`);
    }

    const nowIso = new Date().toISOString();
    const actionSlug = slugify(item.title).slice(0, 32);
    const actionId = `act_codex_${actionSlug}_${randomUUID().slice(0, 6)}`;
    const title = truncateClean(req.title || item.next_move || `Act on: ${item.title}`, 120);
    const detail = truncateClean(
      req.detail || item.summary || item.thesis || `Promoted from Mind Codex (${item.section})`,
      380
    );
    const tag = sanitizeText(req.tag || sectionToActionTag(item.section)) || "Action";

    const actions = this.readOwnerActions();
    actions.unshift({
      id: actionId,
      title,
      detail,
      tag,
      done: false,
      source: `codex:${item.id}`,
      created_at: nowIso,
    });
    this.writeOwnerActions(actions);

    let notePath: string | undefined;
    if (req.createNote) {
      const noteSlug = slugify(item.title);
      const relPath = `owner-notes/codex-${noteSlug}.md`;
      const fullNotePath = join(this.vaultPath, relPath);
      const mdLines = [
        `# ${item.title}`,
        "",
        `- **Codex ID**: \`${item.id}\``,
        `- **Section**: ${item.section}`,
        `- **Domain**: ${item.domain}`,
        ...(item.stage ? [`- **Stage**: ${item.stage}`] : []),
        `- **Conviction**: ${item.conviction}`,
        `- **Action ID**: \`${actionId}\``,
        `- **Promoted At**: ${nowIso}`,
        "",
        "## Summary",
        item.summary,
        "",
      ];
      if (item.thesis) {
        mdLines.push("## Thesis", item.thesis, "");
      }
      if (item.anti_pattern) {
        mdLines.push("## Anti-Pattern", item.anti_pattern, "");
      }
      mdLines.push("## Next Move", title, "");
      if (item.linked_people.length > 0) {
        mdLines.push("## Linked People", item.linked_people.map((p) => `- ${p}`).join("\n"), "");
      }
      if (item.ai_brief) {
        mdLines.push("## AI Synthesis Brief", item.ai_brief, "");
      }
      atomicWriteFile(fullNotePath, stripEmDashes(mdLines.join("\n").trim() + "\n"), 0o600);
      notePath = relPath;
    }

    this.invalidateCache();
    return {
      ok: true,
      action_id: actionId,
      ...(notePath ? { note_path: notePath } : {}),
      item,
    };
  }

  buildSynthesizePrompt(item: CodexItem, mode: CodexSynthesizeMode): CodexSynthesizePrompt {
    const modeGoal: Record<CodexSynthesizeMode, string> = {
      sharpen:
        "Sharpen this card into a razor-clear thesis, cut any soft phrasing, name the real enemy/anti-pattern, and state the single highest-leverage decision.",
      next_moves:
        "Produce 3 concrete, immediately executable next moves ordered by leverage, naming exact artifacts, people, or verification criteria.",
      challenge:
        "Steelman the strongest counter-argument, expose hidden assumptions or blind spots, and name the exact falsifiable test that would prove or kill this.",
    };

    const system = stripEmDashes(
      [
        "You are Kizuki's Mind Codex strategist inside Kizuki Personal Mind OS.",
        "Voice: terse, sharp, operator-grade, zero corporate filler, zero help-center tone, zero em-dashes.",
        "Never use the character U+2014 (em-dash). Use plain hyphens, colons, or periods.",
        "Ground every recommendation in concrete stakes, leverage, and verifiable execution.",
      ].join(" ")
    );

    const cardLines = [
      `Mode: ${mode}`,
      `Section: ${item.section}`,
      `Title: ${item.title}`,
      `Domain: ${item.domain}`,
      item.stage ? `Stage: ${item.stage}` : "",
      `Conviction: ${item.conviction} | Leverage: ${item.leverage_score}/100`,
      `Summary: ${item.summary}`,
      item.thesis ? `Thesis: ${item.thesis}` : "",
      item.anti_pattern ? `Anti-Pattern: ${item.anti_pattern}` : "",
      item.next_move ? `Current Next Move: ${item.next_move}` : "",
      item.linked_people.length > 0 ? `Linked People: ${item.linked_people.join(", ")}` : "",
      item.tags.length > 0 ? `Tags: ${item.tags.join(", ")}` : "",
      "",
      `Task: ${modeGoal[mode]}`,
      "Output crisp markdown (max 180 words) with short bullets and zero em-dashes.",
    ].filter(Boolean);

    const user = stripEmDashes(cardLines.join("\n"));
    const promptForCoherence = stripEmDashes(`${system}\n\n${user}`);
    return { system, user, promptForCoherence };
  }

  saveAiBrief(id: string, brief: string, engine: string): CodexItem {
    const cleanId = (id || "").trim();
    if (!cleanId) throw new Error("id is required");
    const existing = this.getItem(cleanId);
    if (!existing) throw new Error(`Codex item not found: ${cleanId}`);

    const cleanBrief = sanitizeText(brief || "");
    const cleanEngine = sanitizeText(engine || "local-llm");
    const nowIso = new Date().toISOString();

    const store = this.loadStore();
    const customIdx = store.custom_items.findIndex((i) => i.id === cleanId);
    if (customIdx !== -1) {
      store.custom_items[customIdx] = this.cleanItem({
        ...store.custom_items[customIdx],
        ai_brief: cleanBrief,
        ai_engine: cleanEngine,
        ai_updated_at: nowIso,
        updated_at: nowIso,
      });
      this.saveStore(store);
      return store.custom_items[customIdx];
    }

    store.overrides[cleanId] = {
      ...(store.overrides[cleanId] || {}),
      ai_brief: cleanBrief,
      ai_engine: cleanEngine,
      ai_updated_at: nowIso,
      updated_at: nowIso,
    };
    this.saveStore(store);
    return this.applyOverride(existing, store.overrides[cleanId]);
  }

  searchForOmni(q: string, limit = 12): CodexOmniHit[] {
    const query = (q || "").trim().toLowerCase();
    const { items } = this.assembleAllItems();
    const active = items.filter((i) => i.status !== "archived");

    if (!query) {
      return active.slice(0, limit).map((i) => ({
        id: i.id,
        section: i.section,
        title: i.title,
        subtitle: i.subtitle,
        domain: i.domain,
        ...(i.stage ? { stage: i.stage } : {}),
        url_view: "codex" as const,
      }));
    }

    const tokens = query.split(/\s+/).filter(Boolean);
    const scored: Array<{ item: CodexItem; score: number }> = [];

    for (const item of active) {
      const titleLow = item.title.toLowerCase();
      const domainLow = item.domain.toLowerCase();
      const tagsLow = item.tags.join(" ").toLowerCase();
      const peopleLow = item.linked_people.join(" ").toLowerCase();
      const bodyLow = `${item.subtitle} ${item.summary} ${item.thesis || ""} ${item.next_move || ""}`.toLowerCase();
      const fullHay = `${titleLow} ${domainLow} ${tagsLow} ${peopleLow} ${bodyLow}`;

      if (!tokens.every((t) => fullHay.includes(t))) continue;

      let score = item.leverage_score * 0.25;
      if (titleLow === query) score += 100;
      else if (titleLow.includes(query)) score += 60;
      for (const t of tokens) {
        if (titleLow.includes(t)) score += 22;
        if (domainLow.includes(t) || tagsLow.includes(t)) score += 14;
        if (peopleLow.includes(t)) score += 18;
      }
      if (item.pinned) score += 10;
      if (item.tags.includes("decision")) score += 8;

      scored.push({ item, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ item }) => ({
      id: item.id,
      section: item.section,
      title: item.title,
      subtitle: item.subtitle,
      domain: item.domain,
      ...(item.stage ? { stage: item.stage } : {}),
      url_view: "codex" as const,
    }));
  }
}

export function relativeDocPath(root: string, full: string): string {
  return relative(root, full);
}
