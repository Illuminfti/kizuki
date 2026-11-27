import type { Database } from "bun:sqlite";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import type { OpenLoopItem, RelationshipLedger, RelationshipLedgerWeek } from "./contracts.ts";

export type { OpenLoopItem, RelationshipLedger, RelationshipLedgerWeek };

const DEFAULT_WIKI_ROOT =
  process.env.KIZUKI_LIFEOS_WIKI_PATH ||
  join(process.env.KIZUKI_VAULT || process.env.KIZUKI_VAULT_PATH || join(homedir(), "Kizuki"), "wiki");

export const DEFAULT_LIFEOS_PEOPLE_DIR = join(DEFAULT_WIKI_ROOT, "03-entities", "people");
export const DEFAULT_LIFEOS_RELATIONSHIPS_DIR = join(DEFAULT_WIKI_ROOT, "03-entities", "relationships");

export type RelationshipTier = "Core" | "Family" | "Active" | "Warm" | "Ambient";
export type ProfileTier = "v2" | "lifeos" | "claims" | "live";
export type OwnerNoteKind = "insight" | "taste" | "leverage" | "risk" | "wrong" | "outdated" | "open_loop";

export const VALID_OWNER_NOTE_KINDS: ReadonlySet<OwnerNoteKind> = new Set([
  "insight",
  "taste",
  "leverage",
  "risk",
  "wrong",
  "outdated",
  "open_loop",
]);

export interface PersonWorldModel {
  schema_version: "person-card-v2" | "person-card-v1" | "synthesized" | "none";
  source_path: string | null;
  updated_at: string | null;
  confidence: string;
  relationship_state: string;
  relationship_tier: RelationshipTier;
  role: string;
  org: string;
  handles: {
    email?: string;
    telegram?: string;
    x?: string;
    github?: string;
    url?: string;
  };
  aliases: string[];
  canonical_read: string;
  at_a_glance: Array<{ field: string; value: string }>;
  operating_loop: string;
  current_read_bullets: string[];
  why_they_matter: string[];
  tastes_preferences: string[];
  philosophies_decision_model: string[];
  goals_explicit: string[];
  goals_inferred: string[];
  our_leverage: string[];
  their_leverage: string[];
  trust_builders: string[];
  degraders: string[];
  engagement_playbook: string[];
  do_not_assume: string[];
  open_loops: Array<{ loop: string; state: string; next_evidence: string }>;
  contradictions: string[];
  hypotheses: Array<{ judgment: string; read: string; confidence: string; falsifier: string }>;
  evidence_table: Array<{ signal: string; evidence: string; interpretation: string; confidence: string }>;
  relationship_timeline: Array<{ date: string; sentiment: "positive" | "neutral" | "negative"; text: string }>;
  velocity: { trajectory: string; l4w?: number; p4w?: number; span?: string } | null;
  collaborators: Array<{ name: string; slug: string; shared_events: number; note?: string }>;
  owner_notes: Array<{ date: string; kind: string; text: string }>;
  full_markdown: string;
}

export interface CanonicalPersonCard {
  slug: string;
  canonical_name: string;
  display_name: string;
  is_self: boolean;
  profile_tier: "v2" | "lifeos";
  source_path: string;
  tags: string[];
  merged_from: string[];
  world_model: PersonWorldModel;
  match_tokens: {
    exact_slugs: Set<string>;
    full_names: Set<string>;
    first_names_only: Set<string>;
    emails: Set<string>;
    handles: Set<string>;
    surnames: Set<string>;
  };
}

export interface RelationshipDyad {
  slugA: string;
  nameA: string;
  slugB: string;
  nameB: string;
  shared_events: number;
  trajectory: string;
  sparkline: string;
  workstreams: string;
  source_path: string;
}

export interface SqlitePersonClaim {
  id: string;
  kind: string;
  target: string;
  text: string;
  confidence: number;
  created_at: string;
  authority: string;
}

export interface SqlitePersonIntel {
  total_claims: number;
  claims: SqlitePersonClaim[];
}

export interface PersonProfileVisuals {
  archetype: {
    title: string;
    tagline: string;
    operating_mode: string;
    comms_register: string;
    decision_trigger: string;
    blind_spot: string;
    basis_note: string;
  };
  axes: Array<{
    key: "proof" | "candor" | "tempo" | "autonomy" | "reciprocity" | "leverage";
    label: string;
    score: number;
    evidence: string;
  }>;
  leverage_balance: {
    our_count: number;
    their_count: number;
    our_pct: number;
    their_pct: number;
    sentiment_pos: number;
    sentiment_neu: number;
    sentiment_neg: number;
    trust_score: number;
  };
  cadence_series: Array<{
    week_label: string;
    week_start: string;
    total: number;
    whatsapp: number;
    telegram: number;
    imessage: number;
    gmail: number;
    calendar: number;
  }>;
  channel_breakdown: Array<{
    channel: string;
    label: string;
    count: number;
    pct: number;
  }>;
  reciprocity_ratio: {
    you_count: number;
    them_count: number;
    you_pct: number;
  };
  contact_links: Array<{
    kind: "email" | "telegram" | "x" | "github" | "web" | "linkedin" | "phone" | "repo";
    label: string;
    value: string;
    href: string | null;
    copyable: boolean;
  }>;
  ego_graph: {
    center: { name: string; initials: string; tier: string; role: string };
    nodes: Array<{
      id: string;
      key: string | null;
      label: string;
      kind: "person" | "company" | "workstream";
      weight: number;
      meta: string;
    }>;
  };
  ledger?: RelationshipLedger;
}

export interface ComputePersonProfileVisualsInput {
  key: string;
  name: string;
  initials: string;
  role: string;
  org: string;
  relationshipTier: RelationshipTier;
  relationshipState: string;
  worldModel: PersonWorldModel;
  timeline: Array<{
    channel: string;
    sender: string;
    direction?: string;
    occurred_at: string;
    text: string;
  }>;
  meetings: Array<{
    title: string;
    start: string;
    is_upcoming?: boolean;
  }>;
  collaborators: Array<{
    name: string;
    slug: string;
    key: string | null;
    shared_events: number;
    note?: string;
  }>;
  messageCount: number;
  claimCount: number;
  meetingCount: number;
  aliases: string[];
  nowMs?: number;
}

export interface ParsedFrontmatter {
  title: string;
  canonical_name: string;
  display_name: string;
  status: string;
  entity_status: string;
  schema_version: string;
  updated: string;
  confidence: string;
  relationship_state: string;
  relationship_role: string;
  org: string;
  email: string;
  telegram_handle: string;
  telegram_user_id: string;
  x_handle: string;
  github_handle: string;
  official_url: string;
  last_meaningful_contact: string;
  aliases: string[];
  tags: string[];
  raw: Record<string, string | string[]>;
}

export interface LoadedCanonicalCardsResult {
  cards: CanonicalPersonCard[];
  bySlug: Map<string, CanonicalPersonCard>;
  mergeMap: Map<string, string>;
  selfSlugs: Set<string>;
  dyads: RelationshipDyad[];
}

// Known alias-card merges where legacy LifeOS cards lacked explicit x-status: merged
const EXTRA_CARD_MERGES: Record<string, string> = {
  larz: "lars",
};

// Known cross-channel bridge handles/emails/display names for key canonical people
const KNOWN_BRIDGE_ENRICHMENTS: Record<
  string,
  {
    emails?: string[];
    handles?: string[];
    fullNames?: string[];
    displayNameOverride?: string;
    canonicalNameOverride?: string;
  }
> = {};

const FAMILY_SLUGS = new Set<string>([]);
const CORE_SLUGS = new Set<string>([]);

const GENERIC_CLAIM_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "owner",
  "boss",
  "wife",
  "mother",
  "father",
  "sister",
  "brother",
  "contact",
  "unknown",
  "person",
  "user",
  "team",
  "chat",
  "group",
  "death",
  "cat",
  "alex",
  "sam",
  "max",
  "ben",
  "dan",
  "tom",
  "tim",
  "jon",
  "joe",
  "jay",
  "ash",
  "ali",
  "eli",
  "ian",
  "leo",
  "kai",
  "ray",
  "rob",
  "ron",
  "roy",
  "guy",
  "van",
  "der",
  "not",
  "new",
  "one",
  "two",
]);

const FICTIONAL_NOISE_RE =
  /professor david sterling|david sterling|autonovel|oral-history novel|the economist.*london school of economics|dr\.\s*sarah chen|fiction-judging/i;

export function stripEmDashesIntel(text: string): string {
  if (!text) return "";
  return String(text)
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2014/g, "-")
    .replace(/[ \t]{2,}/g, " ");
}

export function normalizeSlug(raw: string): string {
  const cleaned = stripEmDashesIntel(String(raw || ""))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (/^\+?\d{7,15}$/.test(cleaned)) {
    return cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) {
    return cleaned;
  }
  return cleaned
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

export function isValidPersonSlug(slug: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,96}$/.test(slug);
}

export function trimWordBoundary(raw: string, maxLen: number): string {
  const s = String(raw || "").trim();
  if (!s || maxLen <= 0) return "";
  if (s.length <= maxLen) return s;

  // Prefer keeping a complete sentence if one terminates cleanly within the budget
  const minSentenceEnd = Math.min(60, Math.floor(maxLen * 0.45));
  const sentenceRe = /(?<=[a-zA-Z0-9)"'\u201d\u2019])[.!?](?=\s+[A-Z0-9"'\u201c(]|$)/g;
  let bestSentenceEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(s)) !== null) {
    const endIdx = m.index + 1;
    if (endIdx > maxLen) break;
    if (endIdx >= minSentenceEnd) {
      bestSentenceEnd = endIdx;
    }
  }
  if (bestSentenceEnd > 0) {
    return s.slice(0, bestSentenceEnd).trim();
  }

  const budget = Math.max(1, maxLen - 3);
  let cut = s.slice(0, budget);
  const nextChar = s.charAt(budget);
  if (nextChar && !/[\s.,;:!?)\]]/.test(nextChar)) {
    const lastSpace = cut.lastIndexOf(" ");
    if (lastSpace >= Math.floor(budget * 0.4)) {
      cut = cut.slice(0, lastSpace);
    }
  }

  const stripTrailingJunk = (val: string): string =>
    val.replace(/[\s,;:\-\u2013/]+$/, "").trimEnd();

  cut = stripTrailingJunk(cut);

  // Strip or close dangling unbalanced ASCII double quotes (e.g. `"I'm...`)
  const asciiQuoteCount = (cut.match(/"/g) || []).length;
  if (asciiQuoteCount % 2 === 1) {
    const lastQ = cut.lastIndexOf('"');
    if (lastQ >= Math.floor(cut.length * 0.35)) {
      cut = stripTrailingJunk(cut.slice(0, lastQ));
    } else {
      cut = cut.slice(0, lastQ) + cut.slice(lastQ + 1);
    }
  }

  // Strip or close dangling unbalanced curly double quotes (e.g. “I’m...)
  while ((cut.match(/\u201c/g) || []).length > (cut.match(/\u201d/g) || []).length) {
    const lastOpen = cut.lastIndexOf("\u201c");
    if (lastOpen === -1) break;
    if (lastOpen >= Math.floor(cut.length * 0.35)) {
      cut = stripTrailingJunk(cut.slice(0, lastOpen));
    } else {
      cut = cut.slice(0, lastOpen) + cut.slice(lastOpen + 1);
    }
  }

  // Strip dangling unbalanced opening parenthesis (e.g. `(audit, finance...`)
  while ((cut.match(/\(/g) || []).length > (cut.match(/\)/g) || []).length) {
    const lastParen = cut.lastIndexOf("(");
    if (lastParen === -1) break;
    if (lastParen >= Math.floor(cut.length * 0.35)) {
      cut = stripTrailingJunk(cut.slice(0, lastParen));
    } else {
      cut = cut.slice(0, lastParen) + cut.slice(lastParen + 1);
    }
  }

  // Strip dangling unbalanced markdown bold marker `**`
  const boldCount = (cut.match(/\*\*/g) || []).length;
  if (boldCount % 2 === 1) {
    const lastBold = cut.lastIndexOf("**");
    if (lastBold >= 0) {
      cut = stripTrailingJunk(cut.slice(0, lastBold) + cut.slice(lastBold + 2));
    }
  }

  cut = stripTrailingJunk(cut);
  if (!cut) return s.slice(0, budget).trimEnd() + "...";
  if (/[.!?]$/.test(cut) || cut.endsWith("...")) return cut;
  return cut + "...";
}

function cleanLineText(raw: string, maxLen = 500): string {
  const s = stripEmDashesIntel(raw)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[\[[^|\]]+\|([^\]]+)\]\]/g, "$1")
    .replace(/\[\[(?:03-entities\/(?:people|companies|workstreams|relationships)\/)?([^\]]+)\]\]/g, "$1")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+\.\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return trimWordBoundary(s, maxLen);
}

function cleanCell(raw: string): string {
  return cleanLineText(raw.replace(/^\*\*|\*\*$/g, "").trim(), 400);
}

function dedupeStrings(items: string[], limit = 60): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const cleaned = cleanLineText(item, 480);
    if (!cleaned) continue;
    const norm = cleaned.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function parseYamlScalar(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1);
  }
  return stripEmDashesIntel(s).trim();
}

function parseYamlList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((v) => stripEmDashesIntel(String(v || "")).trim()).filter(Boolean);
      }
    } catch {
      // Fall back to comma split inside brackets
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((p) => parseYamlScalar(p))
        .filter(Boolean);
    }
  }
  return [parseYamlScalar(trimmed)].filter(Boolean);
}

export function parseFrontmatter(md: string): { frontmatter: ParsedFrontmatter; body: string } {
  const empty: ParsedFrontmatter = {
    title: "",
    canonical_name: "",
    display_name: "",
    status: "",
    entity_status: "",
    schema_version: "",
    updated: "",
    confidence: "",
    relationship_state: "",
    relationship_role: "",
    org: "",
    email: "",
    telegram_handle: "",
    telegram_user_id: "",
    x_handle: "",
    github_handle: "",
    official_url: "",
    last_meaningful_contact: "",
    aliases: [],
    tags: [],
    raw: {},
  };

  if (!md || (!md.startsWith("---\n") && !md.startsWith("---\r\n"))) {
    return { frontmatter: empty, body: md || "" };
  }

  const endIdx = md.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { frontmatter: empty, body: md };
  }

  const fmBlock = md.slice(4, endIdx);
  const body = md.slice(endIdx + 4).replace(/^\r?\n/, "");
  const lines = fmBlock.split(/\r?\n/);

  const rawMap: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;

  for (const line of lines) {
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentListKey) {
      const existing = rawMap[currentListKey];
      const val = parseYamlScalar(listMatch[1]);
      if (val) {
        if (Array.isArray(existing)) {
          existing.push(val);
        } else {
          rawMap[currentListKey] = [val];
        }
      }
      continue;
    }

    const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!kvMatch) {
      currentListKey = null;
      continue;
    }

    const key = kvMatch[1].trim().toLowerCase();
    const rawVal = kvMatch[2].trim();

    if (!rawVal) {
      rawMap[key] = [];
      currentListKey = key;
    } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
      rawMap[key] = parseYamlList(rawVal);
      currentListKey = null;
    } else {
      rawMap[key] = parseYamlScalar(rawVal);
      currentListKey = null;
    }
  }

  const getStr = (...keys: string[]): string => {
    for (const k of keys) {
      const v = rawMap[k];
      if (typeof v === "string" && v.trim()) return v.trim();
      if (Array.isArray(v) && v.length > 0 && v[0]) return v[0];
    }
    return "";
  };

  const getArr = (...keys: string[]): string[] => {
    const acc: string[] = [];
    for (const k of keys) {
      const v = rawMap[k];
      if (Array.isArray(v)) acc.push(...v);
      else if (typeof v === "string" && v.trim()) acc.push(...parseYamlList(v));
    }
    return Array.from(new Set(acc.map((s) => s.trim()).filter(Boolean)));
  };

  const xStatus = getStr("x-status");
  const plainStatus = getStr("status");

  const fm: ParsedFrontmatter = {
    title: getStr("title"),
    canonical_name: getStr("canonical_name", "x-canonical_name"),
    display_name: getStr("display_name", "x-display_name"),
    status: plainStatus,
    entity_status: xStatus || plainStatus,
    schema_version: getStr("schema_version", "x-schema_version"),
    updated: getStr("updated", "x-updated"),
    confidence: getStr("confidence", "x-confidence") || "medium",
    relationship_state: getStr("relationship_state", "x-relationship_state"),
    relationship_role: getStr("relationship_role", "x-relationship_role", "role", "x-role"),
    org: getStr("org", "x-org", "company", "x-company"),
    email: getStr("email", "x-email"),
    telegram_handle: getStr("telegram_handle", "x-telegram_handle").replace(/^@+/, ""),
    telegram_user_id: getStr("telegram_user_id", "x-telegram_user_id"),
    x_handle: getStr("x_handle", "x-x_handle").replace(/^@+/, ""),
    github_handle: getStr("github_handle", "x-github_handle").replace(/^@+/, ""),
    official_url: getStr("official_url", "x-official_url", "url", "x-url"),
    last_meaningful_contact: getStr("last_meaningful_contact", "x-last_meaningful_contact"),
    aliases: getArr("aliases", "x-aliases"),
    tags: getArr("tags", "x-tags"),
    raw: rawMap,
  };

  return { frontmatter: fm, body };
}

interface MarkdownSection {
  level: number;
  heading: string;
  parentHeading: string;
  lines: string[];
}

function splitMarkdownSections(body: string): { preamble: string[]; sections: MarkdownSection[] } {
  const lines = body.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: MarkdownSection[] = [];
  let current: MarkdownSection | null = null;
  let currentH2 = "";
  let inCodeBlock = false;
  let inBackrefs = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (current && !inBackrefs) current.lines.push(line);
      else if (!inBackrefs) preamble.push(line);
      continue;
    }

    if (!inCodeBlock) {
      if (/<!--\s*backrefs:start\s*-->/i.test(line)) {
        inBackrefs = true;
        continue;
      }
      if (/<!--\s*backrefs:end\s*-->/i.test(line)) {
        inBackrefs = false;
        continue;
      }
      if (inBackrefs) continue;

      const hMatch = line.match(/^(#{1,4})\s+(.+?)\s*$/);
      if (hMatch) {
        const level = hMatch[1].length;
        const heading = stripEmDashesIntel(hMatch[2].replace(/<!--[\s\S]*?-->/g, "").trim());
        if (level === 1) {
          currentH2 = "";
          continue;
        }
        if (level === 2) {
          currentH2 = heading;
        }
        current = {
          level,
          heading,
          parentHeading: level > 2 ? currentH2 : "",
          lines: [],
        };
        sections.push(current);
        continue;
      }
    }

    if (inBackrefs) continue;
    if (current) current.lines.push(line);
    else preamble.push(line);
  }

  return { preamble, sections };
}

function parseGfmTable(lines: string[]): string[][] {
  const rows: string[][] = [];
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const inner = trimmed.slice(1, -1);
    const cells = inner.split("|").map((c) => c.trim());
    // Skip separator row like |---|---|
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    rows.push(cells);
  }
  // Drop header row if present
  return rows.length > 1 ? rows.slice(1) : [];
}

function extractBulletsOrLines(lines: string[], opts: { includeNumbered?: boolean; filterFiction?: boolean } = {}): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (t.startsWith("```")) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !t || t.startsWith("<!--") || t.startsWith("|")) continue;
    if (/^_Auto-maintained by/i.test(t) || /^\*\*(State|LifeOS read|Next evidence required):\*\*/i.test(t)) {
      continue;
    }
    const isBullet = /^[-*+]\s+/.test(t);
    const isNum = opts.includeNumbered !== false && /^\d+\.\s+/.test(t);
    if (!isBullet && !isNum) continue;
    const cleaned = cleanLineText(t, 480);
    if (!cleaned) continue;
    if (opts.filterFiction && FICTIONAL_NOISE_RE.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out;
}

function inferRelationshipTier(opts: {
  slug: string;
  tags: string[];
  relationshipState: string;
  role: string;
  canonicalRead: string;
  schemaVersion: PersonWorldModel["schema_version"];
  velocityEvents?: number;
}): RelationshipTier {
  const tagsLower = new Set(opts.tags.map((t) => t.toLowerCase()));
  const stateLower = (opts.relationshipState || "").toLowerCase();
  const hay = `${opts.role} ${opts.canonicalRead}`.toLowerCase();

  if (
    FAMILY_SLUGS.has(opts.slug) ||
    tagsLower.has("family") ||
    /\b(wife|daughter|son|husband|mother|mum|father|sister|brother)\b/i.test(opts.role) ||
    /\bowner'?s (?:wife|spouse|partner)\b|\bfamily-critical\b/i.test(hay)
  ) {
    return "Family";
  }
  if (
    CORE_SLUGS.has(opts.slug) ||
    tagsLower.has("priority-high") ||
    stateLower === "core"
  ) {
    return "Core";
  }
  if (
    stateLower === "active" ||
    opts.schemaVersion === "person-card-v2" ||
    (opts.velocityEvents !== undefined && opts.velocityEvents >= 12)
  ) {
    return "Active";
  }
  if (
    stateLower === "warm" ||
    tagsLower.has("priority-medium") ||
    opts.schemaVersion === "person-card-v1"
  ) {
    return "Warm";
  }
  return "Ambient";
}

function parseSentimentFromText(raw: string): "positive" | "neutral" | "negative" {
  const l = raw.toLowerCase();
  if (raw.includes("▲") || /\(positive\)/i.test(raw)) return "positive";
  if (raw.includes("▼") || /\(negative\)/i.test(raw)) return "negative";
  if (raw.includes("•") || /\(neutral\)/i.test(raw)) return "neutral";
  if (/\b(frustrat|tense|conflict|stall|blocker|degrad|complaint|friction)\b/i.test(l)) return "negative";
  if (/\b(trust|warm|deepen|strong|peer|collaborat|proves|respected|active)\b/i.test(l)) return "positive";
  return "neutral";
}

export function parsePersonCardMarkdown(
  md: string,
  fmInput?: ParsedFrontmatter,
  opts: { slug?: string; sourcePath?: string | null; isWorldV2?: boolean } = {}
): PersonWorldModel {
  const parsed = fmInput ? { frontmatter: fmInput, body: parseFrontmatter(md).body } : parseFrontmatter(md);
  const fm = parsed.frontmatter;
  const body = parsed.body;
  const cleanFullMd = stripEmDashesIntel(md);
  const { preamble, sections } = splitMarkdownSections(body);

  let schemaVersion: PersonWorldModel["schema_version"] = "person-card-v1";
  if (
    opts.isWorldV2 ||
    fm.schema_version === "person-card-v2" ||
    /<!--\s*person-card:v2\s*-->/i.test(body)
  ) {
    schemaVersion = "person-card-v2";
  } else if (fm.schema_version === "synthesized") {
    schemaVersion = "synthesized";
  } else if (
    fm.schema_version === "person-card-v1" ||
    /<!--\s*person-card:v1\s*-->/i.test(body) ||
    sections.length > 0
  ) {
    schemaVersion = "person-card-v1";
  } else {
    schemaVersion = "none";
  }

  // Canonical read from blockquote in preamble or first section
  let canonicalRead = "";
  for (const line of preamble) {
    const m = line.match(/^>\s*\*\*Canonical read:\*\*\s*(.+)$/i);
    if (m && m[1]) {
      canonicalRead = cleanLineText(m[1], 700);
      break;
    }
  }

  const atAGlance: Array<{ field: string; value: string }> = [];
  let operatingLoop = "";
  const currentReadBullets: string[] = [];
  const whyTheyMatter: string[] = [];
  const tastesPreferences: string[] = [];
  const philosophiesDecisionModel: string[] = [];
  const goalsExplicit: string[] = [];
  const goalsInferred: string[] = [];
  const ourLeverage: string[] = [];
  const theirLeverage: string[] = [];
  const trustBuilders: string[] = [];
  const degraders: string[] = [];
  const engagementPlaybook: string[] = [];
  const doNotAssume: string[] = [];
  const openLoops: Array<{ loop: string; state: string; next_evidence: string }> = [];
  const contradictions: string[] = [];
  const hypotheses: Array<{ judgment: string; read: string; confidence: string; falsifier: string }> = [];
  const evidenceTable: Array<{ signal: string; evidence: string; interpretation: string; confidence: string }> = [];
  const relationshipTimeline: Array<{ date: string; sentiment: "positive" | "neutral" | "negative"; text: string }> = [];
  let velocity: PersonWorldModel["velocity"] = null;
  const collaborators: Array<{ name: string; slug: string; shared_events: number; note?: string }> = [];
  const ownerNotes: Array<{ date: string; kind: string; text: string }> = [];

  let role = fm.relationship_role || "";
  let org = fm.org || "";
  let email = fm.email || "";

  for (const sec of sections) {
    const h = sec.heading.toLowerCase();
    const p = sec.parentHeading.toLowerCase();

    if (
      h === "referenced by" ||
      h === "update protocol" ||
      h === "related" ||
      h.startsWith("mentioned in backtrack") ||
      h === "privacy and confidence boundaries" ||
      h === "what this page is for" ||
      h === "crm intelligence" ||
      h === "distinct meeting titles" ||
      h === "workstream links" ||
      h === "current linked themes"
    ) {
      continue;
    }

    if (h === "at a glance") {
      const rows = parseGfmTable(sec.lines);
      for (const cells of rows) {
        if (cells.length < 2) continue;
        const field = cleanCell(cells[0]);
        const value = cleanCell(cells[1]);
        if (!field || !value) continue;
        atAGlance.push({ field, value });
        if (field.toLowerCase() === "do not assume") {
          doNotAssume.push(value);
        } else if (!role && (field.toLowerCase() === "role" || field.toLowerCase() === "relationship")) {
          role = value;
        }
      }
      continue;
    }

    if (h === "operating loop & current read" || h === "current read" || h === "operating loop") {
      // Extract prose / numbered loop for operating_loop
      const proseLines: string[] = [];
      for (const rawLine of sec.lines) {
        const t = rawLine.trim();
        if (!t || t.startsWith("<!--") || t.startsWith("|")) continue;
        // Extract structured Role / Email hints from auto-enriched cards
        const roleM = t.match(/^-\s+\*\*Role:\*\*\s*(.+)$/i);
        if (roleM && !role) {
          role = cleanLineText(roleM[1], 180);
        }
        const emailM = t.match(/^-\s+\*\*Email:\*\*\s*([^\s,]+@[^\s,]+)/i);
        if (emailM && !email) {
          email = emailM[1].trim().toLowerCase();
        }
        if (/^[-*+]\s+/.test(t)) {
          const b = cleanLineText(t, 450);
          if (b && !FICTIONAL_NOISE_RE.test(b) && !/^Entity-resolution\b/i.test(b)) {
            currentReadBullets.push(b);
          }
        } else {
          proseLines.push(cleanLineText(t, 500));
        }
      }
      if (proseLines.length > 0 && !operatingLoop) {
        operatingLoop = trimWordBoundary(proseLines.join(" "), 1200);
      }
      continue;
    }

    if (h.startsWith("why he matters") || h.startsWith("why she matters") || h.startsWith("why they matter")) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      whyTheyMatter.push(...bullets);
      continue;
    }

    if (
      h.includes("tastes") ||
      h.includes("sensibilities") ||
      h.startsWith("what recharges") ||
      h.startsWith("preferences") ||
      h.startsWith("load and rhythm") ||
      h === "known for" ||
      h.includes("technical signature") ||
      h.includes("technical and professional signature") ||
      p.includes("technical and professional signature")
    ) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      if (p.includes("technical and professional signature") && bullets.length > 0) {
        tastesPreferences.push(`${sec.heading}: ${bullets.slice(0, 4).join(", ")}`);
      } else {
        tastesPreferences.push(...bullets);
      }
      continue;
    }

    if (
      h.includes("philosoph") ||
      h.includes("decision model") ||
      h.includes("decision and working model") ||
      h.startsWith("how he decides") ||
      h.startsWith("how she decides") ||
      h.startsWith("how they decide") ||
      h.includes("mental model")
    ) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      philosophiesDecisionModel.push(...bullets);
      continue;
    }

    if (h === "explicitly observed" || (h.includes("goals") && !h.includes("inferred"))) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      goalsExplicit.push(...bullets);
      continue;
    }

    if (h === "inferred" && p.includes("goal")) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      goalsInferred.push(...bullets);
      continue;
    }

    if (
      h.startsWith("our edge") ||
      h.includes("our leverage") ||
      h.includes("how we win") ||
      h.includes("how we align")
    ) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      ourLeverage.push(...bullets);
      continue;
    }

    if (
      h.startsWith("their edge") ||
      h.includes("their leverage") ||
      h.includes("exposure") ||
      h.includes("watch-out") ||
      h.startsWith("the core complaint") ||
      h.startsWith("primary risk")
    ) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      theirLeverage.push(...bullets);
      if (h.startsWith("the core complaint")) {
        degraders.push(...bullets);
      }
      continue;
    }

    if (h.startsWith("what builds trust") || h === "trust basis") {
      trustBuilders.push(...extractBulletsOrLines(sec.lines, { filterFiction: true }));
      continue;
    }

    if (h.startsWith("what degrades")) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      degraders.push(...bullets);
      continue;
    }

    if (
      h === "engagement playbook" ||
      h === "playbook" ||
      h.startsWith("how to collaborate") ||
      h.startsWith("what to remember for future calls")
    ) {
      engagementPlaybook.push(...extractBulletsOrLines(sec.lines, { filterFiction: true }));
      continue;
    }

    if (h === "do not assume") {
      doNotAssume.push(...extractBulletsOrLines(sec.lines, { filterFiction: true }));
      continue;
    }

    if (h === "open loops" || h === "active threads") {
      const rows = parseGfmTable(sec.lines);
      if (rows.length > 0) {
        for (const cells of rows) {
          if (cells.length >= 2) {
            openLoops.push({
              loop: cleanCell(cells[0]),
              state: cleanCell(cells[1]),
              next_evidence: cleanCell(cells[2] || ""),
            });
          }
        }
      } else {
        for (const b of extractBulletsOrLines(sec.lines, { filterFiction: true })) {
          openLoops.push({ loop: b, state: "active", next_evidence: "" });
        }
      }
      continue;
    }

    if (h.includes("contradiction") || p.includes("contradiction")) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      if (p.includes("contradiction")) {
        const resLine = sec.lines
          .map((l) => l.trim())
          .find((l) => /^\*\*(Resolution|Canonical rule):\*\*/i.test(l));
        if (resLine) {
          contradictions.push(`${sec.heading}: ${cleanLineText(resLine, 360)}`);
        } else if (bullets.length > 0) {
          contradictions.push(`${sec.heading}: ${bullets[0]}`);
        }
      } else {
        contradictions.push(...bullets);
      }
      continue;
    }

    if (h.includes("judgments") || h.includes("hypotheses")) {
      const rows = parseGfmTable(sec.lines);
      for (const cells of rows) {
        if (cells.length >= 2) {
          hypotheses.push({
            judgment: cleanCell(cells[0]),
            read: cleanCell(cells[1]),
            confidence: cleanCell(cells[2] || "Medium"),
            falsifier: cleanCell(cells[3] || ""),
          });
        }
      }
      continue;
    }

    if (h.startsWith("evidence and lifeos") || h === "evidence" || h === "evidence table") {
      const rows = parseGfmTable(sec.lines);
      for (const cells of rows) {
        if (cells.length >= 2) {
          evidenceTable.push({
            signal: cleanCell(cells[0]),
            evidence: cleanCell(cells[1]),
            interpretation: cleanCell(cells[2] || ""),
            confidence: cleanCell(cells[3] || "Medium"),
          });
        }
      }
      continue;
    }

    if (h === "relationship timeline") {
      const rows = parseGfmTable(sec.lines);
      if (rows.length > 0) {
        for (const cells of rows) {
          if (cells.length < 2) continue;
          const date = cleanCell(cells[0]);
          const event = cleanCell(cells[1]);
          const meaning = cleanCell(cells[2] || "");
          const text = meaning ? `${event}: ${meaning}` : event;
          if (!date || !text) continue;
          relationshipTimeline.push({
            date,
            sentiment: parseSentimentFromText(text),
            text,
          });
        }
      }
      for (const rawLine of sec.lines) {
        const t = rawLine.trim();
        if (!/^[-*+]\s+/.test(t)) continue;
        const m = t.match(
          /^[-*+]\s+(\d{4}-\d{2}-\d{2}|[A-Za-z]{3,9}\s+\d{4}(?:\s+to\s+[A-Za-z]{3,9}\s+\d{4})?)\s*(?:([▲•▼])\s*)?(?:\((positive|neutral|negative)\)\s*)?(.+)$/i
        );
        if (m) {
          const date = m[1].trim();
          const sym = m[2] || "";
          const word = (m[3] || "").toLowerCase();
          const rest = cleanLineText(m[4], 420);
          const sentiment: "positive" | "neutral" | "negative" =
            word === "positive" || sym === "▲"
              ? "positive"
              : word === "negative" || sym === "▼"
                ? "negative"
                : word === "neutral" || sym === "•"
                  ? "neutral"
                  : parseSentimentFromText(rest);
          if (rest) {
            relationshipTimeline.push({ date, sentiment, text: rest });
          }
        }
      }
      continue;
    }

    if (h.startsWith("velocity")) {
      let trajectory = "";
      let l4w: number | undefined;
      let p4w: number | undefined;
      let span: string | undefined;
      for (const rawLine of sec.lines) {
        const t = rawLine.trim();
        const trajM = t.match(/\*\*Trajectory:\*\*\s*\*{0,2}([A-Za-z_-]+)\*{0,2}/i);
        if (trajM) trajectory = trajM[1].toUpperCase();
        const evM = t.match(/\*\*Events \(last 4w \/ prior 4w\):\*\*\s*(\d+)\s*\/\s*(\d+)/i);
        if (evM) {
          l4w = Number(evM[1]);
          p4w = Number(evM[2]);
        }
        const spanM = t.match(/\*\*Span:\*\*\s*(.+)$/i);
        if (spanM) span = cleanLineText(spanM[1], 80);
      }
      if (trajectory || l4w !== undefined) {
        velocity = { trajectory: trajectory || "UNKNOWN", l4w, p4w, span };
      }
      continue;
    }

    if (h.startsWith("top collaborators") || h === "network map" || h === "relationship pages") {
      for (const rawLine of sec.lines) {
        const t = rawLine.trim();
        if (!/^[-*+]\s+/.test(t)) continue;
        // Format 1: - [[03-entities/people/gilad|Gilad]] - 43 shared events
        const linkM = t.match(/\[\[03-entities\/people\/([a-z0-9_-]+)(?:\|([^\]]+))?\]\]/i);
        if (linkM) {
          const cSlug = normalizeSlug(linkM[1]);
          const cName = cleanLineText(linkM[2] || linkM[1], 80);
          const countM = t.match(/(\d+)\s+shared/i);
          const shared = countM ? Number(countM[1]) : 0;
          const noteM = t.match(/\]\]:\s*(.+)$/);
          collaborators.push({
            name: cName,
            slug: cSlug,
            shared_events: shared,
            note: noteM ? cleanLineText(noteM[1], 180) : undefined,
          });
          continue;
        }
        // Format 2: - **Alex:** recurring systems engineering support.
        const boldM = t.match(/^[-*+]\s+\*\*([^*:]+?):?\*\*:?\s*(.+)$/);
        if (boldM) {
          const rawName = cleanLineText(boldM[1], 80);
          const note = cleanLineText(boldM[2], 180);
          if (rawName && !/^(owner|you|me|self)$/i.test(rawName) && !rawName.includes(",")) {
            collaborators.push({
              name: rawName,
              slug: normalizeSlug(rawName),
              shared_events: 0,
              note,
            });
          }
        }
      }
      continue;
    }

    if (h === "owner observations" || h === "owner notes") {
      for (const rawLine of sec.lines) {
        const t = rawLine.trim();
        const m = t.match(/^[-*+]\s+\[(\d{4}-\d{2}-\d{2})\]\s+\[([a-z0-9_-]+)\]\s+(.+)$/i);
        if (m) {
          ownerNotes.push({
            date: m[1],
            kind: m[2].toLowerCase(),
            text: cleanLineText(m[3], 600),
          });
        }
      }
      continue;
    }

    if (h.startsWith("mined evidence")) {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      for (const b of bullets.slice(0, 8)) {
        if (!FICTIONAL_NOISE_RE.test(b)) {
          currentReadBullets.push(b);
        }
      }
      continue;
    }

    if (h === "workstreams (co-occurring)") {
      const bullets = extractBulletsOrLines(sec.lines, { filterFiction: true });
      tastesPreferences.push(...bullets.slice(0, 4).map((b) => `Workstream focus: ${b}`));
      continue;
    }
  }

  // Fallback enrichment for v1 LifeOS cards so strategic fields are never blank when rich signal exists
  if (!canonicalRead) {
    if (operatingLoop) {
      canonicalRead = trimWordBoundary(operatingLoop, 420);
    } else if (currentReadBullets.length > 0) {
      canonicalRead = trimWordBoundary(currentReadBullets.slice(0, 2).join(" "), 420);
    }
  }

  if (ourLeverage.length === 0) {
    for (const item of whyTheyMatter.slice(0, 5)) ourLeverage.push(item);
    for (const item of trustBuilders.slice(0, 3)) ourLeverage.push(`Trust lever: ${item}`);
    const advHyp = hypotheses.find((h) => /advantage|role for owner|moat/i.test(h.judgment));
    if (advHyp) ourLeverage.push(`${advHyp.judgment}: ${advHyp.read}`);
  }

  if (theirLeverage.length === 0) {
    for (const item of degraders.slice(0, 4)) theirLeverage.push(item);
    const riskHyp = hypotheses.find((h) => /risk|blocker|exposure/i.test(h.judgment));
    if (riskHyp) theirLeverage.push(`${riskHyp.judgment}: ${riskHyp.read}`);
    for (const b of currentReadBullets) {
      if (/\b(blocker|stall|unresponsive|unavailable|go-ahead|conflict|tension|caution|liability)\b/i.test(b)) {
        theirLeverage.push(b);
      }
    }
  }

  if (tastesPreferences.length === 0 && currentReadBullets.length > 0) {
    for (const b of currentReadBullets) {
      if (/\b(prefer|dislike|slop|likes|loves|style|design|direct|blunt|honest|security|telegram|discord)\b/i.test(b)) {
        tastesPreferences.push(b);
      }
    }
  }

  if (philosophiesDecisionModel.length === 0) {
    for (const b of currentReadBullets) {
      if (/\b(decid|framed|thesis|principle|prefers|views|numbers game|readiness|sovereignty|composability)\b/i.test(b)) {
        philosophiesDecisionModel.push(b);
      }
    }
  }

  const handles: PersonWorldModel["handles"] = {};
  if (email) handles.email = email;
  if (fm.telegram_handle) handles.telegram = `@${fm.telegram_handle.replace(/^@+/, "")}`;
  if (fm.x_handle) handles.x = `@${fm.x_handle.replace(/^@+/, "")}`;
  if (fm.github_handle) handles.github = fm.github_handle;
  if (fm.official_url) handles.url = fm.official_url;

  const slug = opts.slug || normalizeSlug(fm.canonical_name || fm.title || "");
  const relationshipTier = inferRelationshipTier({
    slug,
    tags: fm.tags,
    relationshipState: fm.relationship_state,
    role,
    canonicalRead,
    schemaVersion,
    velocityEvents: velocity?.l4w,
  });

  return {
    schema_version: schemaVersion,
    source_path: opts.sourcePath ?? null,
    updated_at: fm.updated || null,
    confidence: fm.confidence || "medium",
    relationship_state: fm.relationship_state || (relationshipTier === "Family" ? "family" : relationshipTier === "Core" ? "active" : "warm"),
    relationship_tier: relationshipTier,
    role: cleanLineText(role, 200),
    org: cleanLineText(org, 120),
    handles,
    aliases: Array.from(new Set(fm.aliases.map((a) => stripEmDashesIntel(a).trim()).filter(Boolean))),
    canonical_read: canonicalRead,
    at_a_glance: atAGlance,
    operating_loop: operatingLoop,
    current_read_bullets: dedupeStrings(currentReadBullets, 35),
    why_they_matter: dedupeStrings(whyTheyMatter, 15),
    tastes_preferences: dedupeStrings(tastesPreferences, 20),
    philosophies_decision_model: dedupeStrings(philosophiesDecisionModel, 20),
    goals_explicit: dedupeStrings(goalsExplicit, 15),
    goals_inferred: dedupeStrings(goalsInferred, 15),
    our_leverage: dedupeStrings(ourLeverage, 15),
    their_leverage: dedupeStrings(theirLeverage, 15),
    trust_builders: dedupeStrings(trustBuilders, 15),
    degraders: dedupeStrings(degraders, 15),
    engagement_playbook: dedupeStrings(engagementPlaybook, 15),
    do_not_assume: dedupeStrings(doNotAssume, 15),
    open_loops: openLoops.slice(0, 20),
    contradictions: dedupeStrings(contradictions, 15),
    hypotheses: hypotheses.slice(0, 15),
    evidence_table: evidenceTable.slice(0, 15),
    relationship_timeline: relationshipTimeline.slice(0, 40),
    velocity,
    collaborators: dedupeCollaborators(collaborators),
    owner_notes: ownerNotes,
    full_markdown: cleanFullMd,
  };
}

function dedupeCollaborators(
  list: Array<{ name: string; slug: string; shared_events: number; note?: string }>
): Array<{ name: string; slug: string; shared_events: number; note?: string }> {
  const bySlug = new Map<string, { name: string; slug: string; shared_events: number; note?: string }>();
  for (const c of list) {
    if (!c.slug) continue;
    const prev = bySlug.get(c.slug);
    if (!prev) {
      bySlug.set(c.slug, { ...c });
    } else {
      prev.shared_events = Math.max(prev.shared_events, c.shared_events);
      if (!prev.note && c.note) prev.note = c.note;
      if (c.name.length > prev.name.length) prev.name = c.name;
    }
  }
  return Array.from(bySlug.values()).sort((a, b) => b.shared_events - a.shared_events || a.name.localeCompare(b.name));
}

function extractMergeTarget(fm: ParsedFrontmatter, body: string, slug: string): string | null {
  if (EXTRA_CARD_MERGES[slug]) return EXTRA_CARD_MERGES[slug];
  const m = body.match(/merged\s+into\s+\[\[(?:03-entities\/people\/)?([a-z0-9_-]+)(?:\|[^\]]+)?\]\]/i);
  if (m && m[1]) {
    const target = normalizeSlug(m[1]);
    if (target && target !== slug) return target;
  }
  if (fm.entity_status.toLowerCase() === "merged") {
    // Fallback: look for first people link in first 15 lines
    const topLines = body.split(/\r?\n/).slice(0, 15).join("\n");
    const linkM = topLines.match(/\[\[03-entities\/people\/([a-z0-9_-]+)(?:\|[^\]]+)?\]\]/i);
    if (linkM && linkM[1]) {
      const target = normalizeSlug(linkM[1]);
      if (target && target !== slug) return target;
    }
  }
  return null;
}

function extractSurnames(names: string[]): Set<string> {
  const surnames = new Set<string>();
  for (const raw of names) {
    const clean = stripEmDashesIntel(raw)
      .replace(/\([^)]*\)/g, " ")
      .replace(/[^a-zA-Z\s'-]/g, " ")
      .trim();
    const parts = clean.split(/\s+/).filter((p) => p.length >= 2);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].toLowerCase();
      if (!["dagon", "boss", "wife", "mother", "labs", "finance", "foundation"].includes(last)) {
        surnames.add(last);
      }
    }
  }
  return surnames;
}

function buildMatchTokens(
  slug: string,
  canonicalName: string,
  displayName: string,
  wm: PersonWorldModel,
  mergedFrom: string[]
): CanonicalPersonCard["match_tokens"] {
  const exact_slugs = new Set<string>([slug, ...mergedFrom]);
  const full_names = new Set<string>();
  const first_names_only = new Set<string>();
  const emails = new Set<string>();
  const handles = new Set<string>();

  const enrich = KNOWN_BRIDGE_ENRICHMENTS[slug];
  const allNames = [
    canonicalName,
    displayName,
    ...wm.aliases,
    ...(enrich?.fullNames || []),
  ].filter(Boolean);

  for (const raw of allNames) {
    const trimmed = stripEmDashesIntel(raw).trim();
    if (!trimmed) continue;
    if (trimmed.includes("@") && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      emails.add(trimmed.toLowerCase());
      continue;
    }
    if (trimmed.startsWith("@")) {
      const h = normalizeSlug(trimmed.slice(1));
      if (h.length >= 2) handles.add(h);
      continue;
    }
    const norm = normalizeSlug(trimmed);
    if (!norm || norm.length < 2) continue;
    if (trimmed.includes(" ") || trimmed.includes("-")) {
      full_names.add(norm);
    } else if (norm.length >= 3 && !GENERIC_CLAIM_STOPWORDS.has(norm)) {
      first_names_only.add(norm);
    }
  }

  if (wm.handles.email) emails.add(wm.handles.email.toLowerCase());
  if (wm.handles.telegram) handles.add(normalizeSlug(wm.handles.telegram));
  if (wm.handles.x) handles.add(normalizeSlug(wm.handles.x));
  if (wm.handles.github) handles.add(normalizeSlug(wm.handles.github));

  if (enrich?.emails) {
    for (const e of enrich.emails) emails.add(e.toLowerCase());
  }
  if (enrich?.handles) {
    for (const h of enrich.handles) handles.add(normalizeSlug(h));
  }

  // Also add single-word slug as first_names_only if not generic
  if (!slug.includes("-") && slug.length >= 3 && !GENERIC_CLAIM_STOPWORDS.has(slug)) {
    first_names_only.add(slug);
  }
  // If canonical name is "First Last", also allow exact single-token first name when unambiguous
  const parts = canonicalName
    .replace(/\([^)]*\)/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    const first = normalizeSlug(parts[0]);
    if (first.length >= 4 && !GENERIC_CLAIM_STOPWORDS.has(first)) {
      first_names_only.add(first);
    }
  }

  const surnames = extractSurnames(allNames);
  return { exact_slugs, full_names, first_names_only, emails, handles, surnames };
}

export function fuseWorldModels(target: PersonWorldModel, source: PersonWorldModel, preferSourceAsV2 = false): PersonWorldModel {
  const primary = preferSourceAsV2 ? source : target;
  const secondary = preferSourceAsV2 ? target : source;

  const mergedHandles: PersonWorldModel["handles"] = {
    email: primary.handles.email || secondary.handles.email,
    telegram: primary.handles.telegram || secondary.handles.telegram,
    x: primary.handles.x || secondary.handles.x,
    github: primary.handles.github || secondary.handles.github,
    url: primary.handles.url || secondary.handles.url,
  };

  const mergedTimeline = [...primary.relationship_timeline, ...secondary.relationship_timeline];
  const seenTl = new Set<string>();
  const dedupedTimeline = mergedTimeline
    .filter((t) => {
      const k = `${t.date}|${t.text.slice(0, 60).toLowerCase()}`;
      if (seenTl.has(k)) return false;
      seenTl.add(k);
      return true;
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 45);

  const mergedOwnerNotes = [...primary.owner_notes, ...secondary.owner_notes];
  const seenNotes = new Set<string>();
  const dedupedNotes = mergedOwnerNotes.filter((n) => {
    const k = `${n.date}|${n.kind}|${n.text.toLowerCase()}`;
    if (seenNotes.has(k)) return false;
    seenNotes.add(k);
    return true;
  });

  const mergedOpenLoops = [...primary.open_loops, ...secondary.open_loops];
  const seenLoops = new Set<string>();
  const dedupedLoops = mergedOpenLoops.filter((l) => {
    const k = l.loop.toLowerCase().slice(0, 50);
    if (seenLoops.has(k)) return false;
    seenLoops.add(k);
    return true;
  });

  const mergedHyps = primary.hypotheses.length > 0 ? primary.hypotheses : secondary.hypotheses;
  const mergedEv = primary.evidence_table.length > 0 ? primary.evidence_table : secondary.evidence_table;

  // Prefer higher-priority relationship tier
  const tierRank: Record<RelationshipTier, number> = { Family: 5, Core: 4, Active: 3, Warm: 2, Ambient: 1 };
  const bestTier =
    tierRank[primary.relationship_tier] >= tierRank[secondary.relationship_tier]
      ? primary.relationship_tier
      : secondary.relationship_tier;

  return {
    schema_version: primary.schema_version,
    source_path: primary.source_path || secondary.source_path,
    updated_at: primary.updated_at || secondary.updated_at,
    confidence: primary.confidence || secondary.confidence,
    relationship_state: primary.relationship_state || secondary.relationship_state,
    relationship_tier: bestTier,
    role: primary.role || secondary.role,
    org: primary.org || secondary.org,
    handles: mergedHandles,
    aliases: Array.from(new Set([...primary.aliases, ...secondary.aliases])),
    canonical_read: primary.canonical_read || secondary.canonical_read,
    at_a_glance: primary.at_a_glance.length > 0 ? primary.at_a_glance : secondary.at_a_glance,
    operating_loop: primary.operating_loop || secondary.operating_loop,
    current_read_bullets: dedupeStrings([...primary.current_read_bullets, ...secondary.current_read_bullets], 40),
    why_they_matter: dedupeStrings([...primary.why_they_matter, ...secondary.why_they_matter], 15),
    tastes_preferences: dedupeStrings([...primary.tastes_preferences, ...secondary.tastes_preferences], 20),
    philosophies_decision_model: dedupeStrings(
      [...primary.philosophies_decision_model, ...secondary.philosophies_decision_model],
      20
    ),
    goals_explicit: dedupeStrings([...primary.goals_explicit, ...secondary.goals_explicit], 15),
    goals_inferred: dedupeStrings([...primary.goals_inferred, ...secondary.goals_inferred], 15),
    our_leverage: dedupeStrings([...primary.our_leverage, ...secondary.our_leverage], 15),
    their_leverage: dedupeStrings([...primary.their_leverage, ...secondary.their_leverage], 15),
    trust_builders: dedupeStrings([...primary.trust_builders, ...secondary.trust_builders], 15),
    degraders: dedupeStrings([...primary.degraders, ...secondary.degraders], 15),
    engagement_playbook: dedupeStrings([...primary.engagement_playbook, ...secondary.engagement_playbook], 15),
    do_not_assume: dedupeStrings([...primary.do_not_assume, ...secondary.do_not_assume], 15),
    open_loops: dedupedLoops.slice(0, 20),
    contradictions: dedupeStrings([...primary.contradictions, ...secondary.contradictions], 15),
    hypotheses: mergedHyps,
    evidence_table: mergedEv,
    relationship_timeline: dedupedTimeline,
    velocity: primary.velocity || secondary.velocity,
    collaborators: dedupeCollaborators([...primary.collaborators, ...secondary.collaborators]),
    owner_notes: dedupedNotes,
    full_markdown: primary.full_markdown || secondary.full_markdown,
  };
}

export async function loadRelationshipDyads(
  relationshipsDir: string = DEFAULT_LIFEOS_RELATIONSHIPS_DIR,
  mergeMap: Map<string, string> = new Map()
): Promise<RelationshipDyad[]> {
  let files: string[];
  try {
    files = (await readdir(relationshipsDir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
  } catch {
    return [];
  }

  const resolveSlug = (s: string): string => {
    const n = normalizeSlug(s);
    return mergeMap.get(n) || n;
  };

  const results = await Promise.all(
    files.map(async (file): Promise<RelationshipDyad | null> => {
      const fullPath = join(relationshipsDir, file);
      try {
        const raw = await readFile(fullPath, "utf8");
        const { body } = parseFrontmatter(raw);
        const participants: Array<{ slug: string; name: string }> = [];
        const pMatches = body.matchAll(/\[\[03-entities\/people\/([a-z0-9_-]+)(?:\|([^\]]+))?\]\]/gi);
        for (const m of pMatches) {
          const slug = resolveSlug(m[1]);
          const name = cleanLineText(m[2] || m[1], 80);
          if (slug && !participants.some((p) => p.slug === slug)) {
            participants.push({ slug, name });
          }
          if (participants.length >= 2) break;
        }
        if (participants.length < 2) {
          // Fallback to filename split on __
          const stem = file.replace(/\.md$/i, "");
          const parts = stem.split("__");
          if (parts.length === 2) {
            participants.length = 0;
            participants.push(
              { slug: resolveSlug(parts[0]), name: parts[0].replace(/-/g, " ") },
              { slug: resolveSlug(parts[1]), name: parts[1].replace(/-/g, " ") }
            );
          }
        }
        if (participants.length < 2 || participants[0].slug === participants[1].slug) return null;

        const sharedM = body.match(/\*\*Shared events:\*\*\s*(\d+)/i);
        const trajM = body.match(/\*\*Trajectory:\*\*\s*\*{0,2}([A-Za-z_-]+)\*{0,2}/i);
        const wsM = body.match(/\*\*Dominant workstreams:\*\*\s*(.+)$/im);
        const sparkM = body.match(/```[^\n]*\n([^\n]+)\n/);

        return {
          slugA: participants[0].slug,
          nameA: participants[0].name,
          slugB: participants[1].slug,
          nameB: participants[1].name,
          shared_events: sharedM ? Number(sharedM[1]) : 1,
          trajectory: trajM ? trajM[1].toUpperCase() : "UNKNOWN",
          sparkline: sparkM ? sparkM[1].trim() : "",
          workstreams: wsM ? cleanLineText(wsM[1], 160) : "",
          source_path: fullPath,
        };
      } catch {
        return null;
      }
    })
  );

  return results.filter((d): d is RelationshipDyad => d !== null);
}

export async function loadCanonicalPersonCards(opts: {
  vaultPath: string;
  lifeosPeopleDir?: string | null;
  relationshipsDir?: string | null;
}): Promise<LoadedCanonicalCardsResult> {
  const autoPeopleDir = join(opts.vaultPath, "auto", "entities", "03-entities", "people");
  const worldPeopleDir = join(opts.vaultPath, "world", "people");
  const draftPeopleDir = join(opts.vaultPath, ".kizuki", "drafts", "people");

  const readMdDir = async (dir: string, relPrefix: string): Promise<Array<{ slug: string; relPath: string; fullPath: string; content: string }>> => {
    let entries: string[];
    try {
      entries = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".md")).sort();
    } catch {
      return [];
    }
    const items = await Promise.all(
      entries.map(async (f) => {
        const fullPath = join(dir, f);
        try {
          const content = await readFile(fullPath, "utf8");
          const slug = normalizeSlug(f.replace(/\.md$/i, ""));
          if (!slug) return null;
          return { slug, relPath: `${relPrefix}${f}`, fullPath, content };
        } catch {
          return null;
        }
      })
    );
    return items.filter((x): x is NonNullable<typeof x> => x !== null);
  };

  let legacyFiles = await readMdDir(autoPeopleDir, "auto/entities/03-entities/people/");
  if (legacyFiles.length === 0 && opts.lifeosPeopleDir) {
    legacyFiles = await readMdDir(opts.lifeosPeopleDir, "lifeos/03-entities/people/");
  }
  const worldV2Files = await readMdDir(worldPeopleDir, "world/people/");
  const draftV2Files = await readMdDir(draftPeopleDir, ".kizuki/drafts/people/");

  interface RawParsedCard {
    slug: string;
    relPath: string;
    isWorldV2: boolean;
    fm: ParsedFrontmatter;
    wm: PersonWorldModel;
    mergeTarget: string | null;
  }

  const rawBySlug = new Map<string, RawParsedCard>();
  const worldOverrideBySlug = new Map<string, RawParsedCard>();

  for (const f of legacyFiles) {
    const { frontmatter, body } = parseFrontmatter(f.content);
    const wm = parsePersonCardMarkdown(f.content, frontmatter, {
      slug: f.slug,
      sourcePath: f.relPath,
      isWorldV2: false,
    });
    const mergeTarget = extractMergeTarget(frontmatter, body, f.slug);
    rawBySlug.set(f.slug, {
      slug: f.slug,
      relPath: f.relPath,
      isWorldV2: false,
      fm: frontmatter,
      wm,
      mergeTarget,
    });
  }

  for (const f of worldV2Files) {
    const { frontmatter } = parseFrontmatter(f.content);
    const wm = parsePersonCardMarkdown(f.content, frontmatter, {
      slug: f.slug,
      sourcePath: f.relPath,
      isWorldV2: true,
    });
    worldOverrideBySlug.set(f.slug, {
      slug: f.slug,
      relPath: f.relPath,
      isWorldV2: true,
      fm: frontmatter,
      wm,
      mergeTarget: null,
    });
  }

  for (const f of draftV2Files) {
    const { frontmatter } = parseFrontmatter(f.content);
    const wm = parsePersonCardMarkdown(f.content, frontmatter, {
      slug: f.slug,
      sourcePath: f.relPath,
      isWorldV2: true,
    });
    const existingWorld = worldOverrideBySlug.get(f.slug);
    worldOverrideBySlug.set(f.slug, {
      slug: f.slug,
      relPath: f.relPath,
      isWorldV2: true,
      fm: existingWorld ? { ...existingWorld.fm, ...frontmatter } : frontmatter,
      wm: existingWorld ? fuseWorldModels(existingWorld.wm, wm, true) : wm,
      mergeTarget: null,
    });
  }

  // Resolve transitive merge map
  const mergeMap = new Map<string, string>();
  const resolveCanonicalSlug = (slug: string): string => {
    let cur = slug;
    const visited = new Set<string>([cur]);
    while (true) {
      const rec = rawBySlug.get(cur);
      const next = rec?.mergeTarget || EXTRA_CARD_MERGES[cur] || null;
      if (!next || visited.has(next)) break;
      // Only follow merge target if it exists in legacy or world overrides, or is "owner"
      if (next !== "owner" && !rawBySlug.has(next) && !worldOverrideBySlug.has(next)) break;
      visited.add(next);
      cur = next;
    }
    return cur;
  };

  for (const slug of rawBySlug.keys()) {
    const resolved = resolveCanonicalSlug(slug);
    if (resolved !== slug) {
      mergeMap.set(slug, resolved);
    }
  }

  const selfSlugs = new Set<string>(["owner"]);
  for (const [src, dst] of mergeMap.entries()) {
    if (dst === "owner") selfSlugs.add(src);
  }

  // Group legacy raw cards by canonical slug
  const groupedSources = new Map<string, RawParsedCard[]>();
  const allCanonicalSlugs = new Set<string>();
  for (const [slug, raw] of rawBySlug.entries()) {
    const target = mergeMap.get(slug) || slug;
    allCanonicalSlugs.add(target);
    const arr = groupedSources.get(target) || [];
    arr.push(raw);
    groupedSources.set(target, arr);
  }
  for (const slug of worldOverrideBySlug.keys()) {
    allCanonicalSlugs.add(slug);
  }

  const bySlug = new Map<string, CanonicalPersonCard>();

  for (const slug of allCanonicalSlugs) {
    const isSelf = selfSlugs.has(slug);
    const group = groupedSources.get(slug) || [];
    const primaryLegacy = group.find((g) => g.slug === slug) || group[0] || null;
    const mergedLegacy = group.filter((g) => g !== primaryLegacy);
    const worldV2 = worldOverrideBySlug.get(slug) || null;

    let wm: PersonWorldModel;
    let profileTier: "v2" | "lifeos";
    let sourcePath: string;
    const tagsSet = new Set<string>();
    const mergedFrom: string[] = [];

    if (primaryLegacy) {
      wm = { ...primaryLegacy.wm };
      profileTier = "lifeos";
      sourcePath = primaryLegacy.relPath;
      for (const t of primaryLegacy.fm.tags) tagsSet.add(t);
    } else if (worldV2) {
      wm = { ...worldV2.wm };
      profileTier = "v2";
      sourcePath = worldV2.relPath;
      for (const t of worldV2.fm.tags) tagsSet.add(t);
    } else {
      continue;
    }

    for (const src of mergedLegacy) {
      mergedFrom.push(src.slug);
      wm = fuseWorldModels(wm, src.wm, false);
      for (const t of src.fm.tags) tagsSet.add(t);
      if (src.fm.title) wm.aliases = Array.from(new Set([...wm.aliases, src.fm.title]));
      if (src.fm.canonical_name) wm.aliases = Array.from(new Set([...wm.aliases, src.fm.canonical_name]));
    }

    // World/people person-card-v2 takes precedence over legacy LifeOS card!
    if (worldV2 && primaryLegacy) {
      wm = fuseWorldModels(wm, worldV2.wm, true);
      profileTier = "v2";
      sourcePath = worldV2.relPath;
      for (const t of worldV2.fm.tags) tagsSet.add(t);
    }

    // Remap collaborator slugs through mergeMap and drop self-references
    wm.collaborators = dedupeCollaborators(
      wm.collaborators
        .map((c) => {
          const mapped = mergeMap.get(c.slug) || c.slug;
          return { ...c, slug: mapped };
        })
        .filter((c) => c.slug !== slug && !selfSlugs.has(c.slug))
    );

    const enrich = KNOWN_BRIDGE_ENRICHMENTS[slug];
    const baseFm = worldV2?.fm || primaryLegacy?.fm;
    const canonicalName =
      enrich?.canonicalNameOverride ||
      baseFm?.canonical_name ||
      baseFm?.title ||
      slug
        .split("-")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ""))
        .join(" ");
    const displayName = enrich?.displayNameOverride || baseFm?.display_name || canonicalName;

    if (enrich?.emails?.length && !wm.handles.email) {
      wm.handles.email = enrich.emails[0];
    }
    if (enrich?.fullNames?.length) {
      wm.aliases = Array.from(new Set([...wm.aliases, ...enrich.fullNames]));
    }
    if (enrich?.handles?.length) {
      wm.aliases = Array.from(new Set([...wm.aliases, ...enrich.handles]));
    }

    const match_tokens = buildMatchTokens(slug, canonicalName, displayName, wm, mergedFrom);

    bySlug.set(slug, {
      slug,
      canonical_name: stripEmDashesIntel(canonicalName),
      display_name: stripEmDashesIntel(displayName),
      is_self: isSelf,
      profile_tier: profileTier,
      source_path: sourcePath,
      tags: Array.from(tagsSet),
      merged_from: mergedFrom,
      world_model: wm,
      match_tokens,
    });
  }

  // Load 25 LifeOS relationship dyads and link collaborators bidirectionally
  const dyads = opts.relationshipsDir
    ? await loadRelationshipDyads(opts.relationshipsDir, mergeMap)
    : [];

  for (const dyad of dyads) {
    const cardA = bySlug.get(dyad.slugA);
    const cardB = bySlug.get(dyad.slugB);
    if (cardA && !selfSlugs.has(dyad.slugB)) {
      cardA.world_model.collaborators = dedupeCollaborators([
        ...cardA.world_model.collaborators,
        {
          name: cardB?.canonical_name || dyad.nameB,
          slug: dyad.slugB,
          shared_events: dyad.shared_events,
          note: dyad.workstreams
            ? `${dyad.workstreams} (${dyad.trajectory})`
            : dyad.trajectory !== "UNKNOWN"
              ? `Trajectory: ${dyad.trajectory}`
              : undefined,
        },
      ]);
    }
    if (cardB && !selfSlugs.has(dyad.slugA)) {
      cardB.world_model.collaborators = dedupeCollaborators([
        ...cardB.world_model.collaborators,
        {
          name: cardA?.canonical_name || dyad.nameA,
          slug: dyad.slugA,
          shared_events: dyad.shared_events,
          note: dyad.workstreams
            ? `${dyad.workstreams} (${dyad.trajectory})`
            : dyad.trajectory !== "UNKNOWN"
              ? `Trajectory: ${dyad.trajectory}`
              : undefined,
        },
      ]);
    }
  }

  // Refresh collaborator display names from resolved canonical cards
  for (const card of bySlug.values()) {
    card.world_model.collaborators = card.world_model.collaborators.map((c) => {
      const peer = bySlug.get(c.slug);
      return peer ? { ...c, name: peer.canonical_name } : c;
    });
  }

  const cards = Array.from(bySlug.values()).filter((c) => !c.is_self);
  return { cards, bySlug, mergeMap, selfSlugs, dyads };
}

export interface CanonicalCardMatcher {
  match(input: {
    rawKey?: string;
    displayName?: string;
    email?: string;
    extraAliases?: string[];
  }): CanonicalPersonCard | null;
}

export function createCanonicalCardMatcher(cards: CanonicalPersonCard[]): CanonicalCardMatcher {
  const byEmail = new Map<string, CanonicalPersonCard>();
  const byHandle = new Map<string, CanonicalPersonCard>();
  const bySlug = new Map<string, CanonicalPersonCard>();
  const byFullName = new Map<string, CanonicalPersonCard>();
  const byFirstName = new Map<string, CanonicalPersonCard[]>();

  for (const card of cards) {
    if (card.is_self) continue;
    for (const e of card.match_tokens.emails) byEmail.set(e, card);
    for (const h of card.match_tokens.handles) byHandle.set(h, card);
    for (const s of card.match_tokens.exact_slugs) bySlug.set(s, card);
    for (const fn of card.match_tokens.full_names) byFullName.set(fn, card);
    for (const first of card.match_tokens.first_names_only) {
      const list = byFirstName.get(first) || [];
      if (!list.includes(card)) list.push(card);
      byFirstName.set(first, list);
    }
  }

  const extractIncomingSurnames = (candidates: string[]): Set<string> => {
    const out = new Set<string>();
    for (const raw of candidates) {
      if (!raw || raw.includes("@") || raw.includes(":")) continue;
      const clean = stripEmDashesIntel(raw)
        .replace(/\([^)]*\)/g, " ")
        .replace(/[^a-zA-Z\s'-]/g, " ")
        .trim();
      const parts = clean.split(/\s+/).filter((p) => p.length >= 2);
      if (parts.length >= 2) {
        const last = parts[parts.length - 1].toLowerCase();
        if (!["dagon", "labs", "finance", "inc", "ltd"].includes(last)) {
          out.add(last);
        }
      }
    }
    return out;
  };

  return {
    match(input) {
      const rawCandidates = [
        input.email || "",
        input.rawKey || "",
        input.displayName || "",
        ...(input.extraAliases || []),
      ]
        .map((s) => stripEmDashesIntel(String(s || "")).trim())
        .filter(Boolean);

      // 1. Exact email match
      for (const c of rawCandidates) {
        const lower = c.toLowerCase();
        if (lower.includes("@") && byEmail.has(lower)) {
          return byEmail.get(lower)!;
        }
      }

      // 2. Exact handle match (including telegram:handle / whatsapp:slug)
      for (const c of rawCandidates) {
        const stripped = c.replace(/^(?:telegram|whatsapp|imessage|gmail):/i, "").replace(/^@+/, "");
        const norm = normalizeSlug(stripped);
        if (norm && byHandle.has(norm)) {
          return byHandle.get(norm)!;
        }
      }

      // 3. Exact full name match
      for (const c of rawCandidates) {
        if (c.includes("@")) continue;
        const stripped = c.replace(/^(?:telegram|whatsapp|imessage|gmail):/i, "");
        const norm = normalizeSlug(stripped);
        if (norm && byFullName.has(norm)) {
          return byFullName.get(norm)!;
        }
      }

      // 4. Exact canonical or merged slug match (with surname collision guard!)
      const incomingSurnames = extractIncomingSurnames([input.displayName || "", ...(input.extraAliases || [])]);

      const hasConflictingSurname = (card: CanonicalPersonCard): boolean => {
        if (incomingSurnames.size === 0 || card.match_tokens.surnames.size === 0) return false;
        for (const inc of incomingSurnames) {
          if (card.match_tokens.surnames.has(inc)) return false;
        }
        return true;
      };

      for (const c of rawCandidates) {
        if (c.includes("@")) continue;
        const stripped = c.replace(/^(?:telegram|whatsapp|imessage|gmail):/i, "");
        const norm = normalizeSlug(stripped);
        if (norm && bySlug.has(norm)) {
          const hit = bySlug.get(norm)!;
          if (!hasConflictingSurname(hit)) return hit;
        }
      }

      // 5. Exact single-token first-name match ONLY when unambiguous and no conflicting surname
      const primaryName = stripEmDashesIntel(input.displayName || input.rawKey || "")
        .replace(/^(?:telegram|whatsapp|imessage|gmail):/i, "")
        .trim();
      if (primaryName && !primaryName.includes("@") && !primaryName.includes(" ")) {
        const norm = normalizeSlug(primaryName);
        const hits = byFirstName.get(norm);
        if (hits && hits.length === 1 && !hasConflictingSurname(hits[0])) {
          return hits[0];
        }
      }

      return null;
    },
  };
}

export function buildStrongPersonSearchTerms(personName: string, aliases: string[] = []): string[] {
  const candidates = [personName, ...aliases]
    .map((s) => stripEmDashesIntel(String(s || "")).replace(/^@+/, "").trim())
    .filter(Boolean);

  const terms: string[] = [];
  const seen = new Set<string>();
  const addTerm = (t: string) => {
    const clean = t.trim();
    const lower = clean.toLowerCase();
    if (!clean || seen.has(lower)) return;
    if (lower.includes("@") && lower.includes(".")) {
      seen.add(lower);
      terms.push(clean);
      return;
    }
    if (clean.length <= 3) return;
    if (GENERIC_CLAIM_STOPWORDS.has(lower)) return;
    seen.add(lower);
    terms.push(clean);
  };

  for (const c of candidates) {
    // Strip parentheticals like "Alex (Alexander Rivera)" -> add both parts
    const parenM = c.match(/^([^(]+?)\s*\(([^)]+)\)$/);
    if (parenM) {
      addTerm(parenM[1]);
      addTerm(parenM[2]);
    } else {
      addTerm(c);
    }
    // Also add first name if >= 4 chars and not generic (e.g. "Alex", "Sam", "Jordan")
    const parts = c
      .replace(/\([^)]*\)/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length >= 2) {
      addTerm(parts[0]);
    }
  }

  return terms.slice(0, 8);
}

interface CompiledPersonTerms {
  singleWords: Set<string>;
  phrases: string[];
}

const CLAIM_WORD_TOKEN_RE = /[a-z0-9_]{4,}/g;

function compilePersonSearchTerms(personName: string, aliases: string[] = []): CompiledPersonTerms {
  const singleWords = new Set<string>();
  const phrases: string[] = [];
  const seenPhrases = new Set<string>();
  const terms = buildStrongPersonSearchTerms(personName, aliases);

  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.includes(" ") || lower.includes("@") || lower.includes("-")) {
      if (!seenPhrases.has(lower)) {
        seenPhrases.add(lower);
        phrases.push(lower);
      }
    } else if (lower.length >= 4 && !GENERIC_CLAIM_STOPWORDS.has(lower)) {
      singleWords.add(lower);
    }
  }

  return { singleWords, phrases };
}

function claimTextMatchesCompiledTerms(lower: string, compiled: CompiledPersonTerms): boolean {
  if (lower.length < 4) return false;
  let matched = false;

  if (compiled.singleWords.size > 0) {
    CLAIM_WORD_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLAIM_WORD_TOKEN_RE.exec(lower)) !== null) {
      if (compiled.singleWords.has(m[0])) {
        matched = true;
        break;
      }
    }
  }

  if (!matched && compiled.phrases.length > 0) {
    for (let i = 0; i < compiled.phrases.length; i++) {
      if (lower.includes(compiled.phrases[i])) {
        matched = true;
        break;
      }
    }
  }

  if (!matched) return false;
  if (FICTIONAL_NOISE_RE.test(lower)) return false;
  return true;
}

export function querySqlitePersonIntelligence(
  db: Database,
  personName: string,
  aliases: string[] = [],
  limit = 80
): SqlitePersonIntel {
  const terms = buildStrongPersonSearchTerms(personName, aliases);
  const compiled = compilePersonSearchTerms(personName, aliases);
  if (terms.length === 0 || (compiled.singleWords.size === 0 && compiled.phrases.length === 0)) {
    return { total_claims: 0, claims: [] };
  }

  const orClauses: string[] = [];
  const params: string[] = [];
  for (const t of terms) {
    const like = `%${t}%`;
    orClauses.push("(target LIKE ? OR body LIKE ?)");
    params.push(like, like);
  }

  const whereSql = `
    status != 'retracted'
    AND (${orClauses.join(" OR ")})
  `;

  try {
    const rows = db
      .query(
        `SELECT claim_id, kind, target, body, confidence, status, created_at, authority
         FROM claims
         WHERE ${whereSql}
         ORDER BY created_at DESC`
      )
      .all(...params) as Array<{
        claim_id: string;
        kind: string;
        target: string | null;
        body: string;
        confidence: number;
        status: string;
        created_at: string;
        authority: string;
      }>;

    let totalClaims = 0;
    const matchedClaims: SqlitePersonClaim[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const lower = `${r.target || ""} ${r.body || ""}`.toLowerCase();
      if (!claimTextMatchesCompiledTerms(lower, compiled)) continue;
      totalClaims += 1;
      if (matchedClaims.length < limit) {
        matchedClaims.push({
          id: r.claim_id,
          kind: r.kind,
          target: stripEmDashesIntel(r.target || ""),
          text: trimWordBoundary(stripEmDashesIntel(r.body || ""), 600),
          confidence: Number(r.confidence ?? 0.7),
          created_at: r.created_at || "",
          authority: r.authority || "connector_evidence",
        });
      }
    }

    return {
      total_claims: totalClaims,
      claims: matchedClaims,
    };
  } catch {
    return { total_claims: 0, claims: [] };
  }
}

export function batchCountSqliteClaimsForPeople(
  db: Database,
  people: Array<{ key: string; name: string; aliases: string[] }>
): Map<string, number> {
  const counts = new Map<string, number>();
  if (people.length === 0) return counts;

  // O(1) inverted token index + anchor-word-indexed phrase map so we NEVER run O(claims * people) scans.
  const tokenToKeys = new Map<string, string[]>();
  const anchorToPhrases = new Map<string, Array<{ key: string; phrase: string }>>();
  const unanchoredPhrases: Array<{ key: string; phrase: string }> = [];
  const wordTokenRe = /[a-z0-9_]{4,}/g;

  for (const p of people) {
    counts.set(p.key, 0);
    const compiled = compilePersonSearchTerms(p.name, p.aliases);
    for (const lower of compiled.singleWords) {
      const arr = tokenToKeys.get(lower) || [];
      if (!arr.includes(p.key)) arr.push(p.key);
      tokenToKeys.set(lower, arr);
    }
    for (const lower of compiled.phrases) {
      const words = (lower.match(wordTokenRe) || []).filter((w) => !GENERIC_CLAIM_STOPWORDS.has(w));
      if (words.length === 0) {
        unanchoredPhrases.push({ key: p.key, phrase: lower });
        continue;
      }
      words.sort((a, b) => b.length - a.length);
      const anchor = words[0];
      const list = anchorToPhrases.get(anchor) || [];
      if (!list.some((x) => x.key === p.key && x.phrase === lower)) {
        list.push({ key: p.key, phrase: lower });
        anchorToPhrases.set(anchor, list);
      }
    }
  }

  try {
    const stmt = db.query(
      `SELECT coalesce(target, '') AS target, coalesce(body, '') AS body
       FROM claims
       WHERE status != 'retracted'`
    );
    const rows = stmt.all() as Array<{ target: string; body: string }>;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const lower = `${row.target} ${row.body}`.toLowerCase();
      if (lower.length < 4) continue;

      let matchedKeys: Set<string> | null = null;
      wordTokenRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = wordTokenRe.exec(lower)) !== null) {
        const tok = m[0];
        const hitKeys = tokenToKeys.get(tok);
        if (hitKeys) {
          if (!matchedKeys) matchedKeys = new Set<string>();
          for (let j = 0; j < hitKeys.length; j++) matchedKeys.add(hitKeys[j]);
        }
        const phraseHits = anchorToPhrases.get(tok);
        if (phraseHits) {
          for (let j = 0; j < phraseHits.length; j++) {
            const entry = phraseHits[j];
            if (matchedKeys?.has(entry.key)) continue;
            if (lower.includes(entry.phrase)) {
              if (!matchedKeys) matchedKeys = new Set<string>();
              matchedKeys.add(entry.key);
            }
          }
        }
      }

      if (unanchoredPhrases.length > 0) {
        for (let j = 0; j < unanchoredPhrases.length; j++) {
          const entry = unanchoredPhrases[j];
          if (matchedKeys?.has(entry.key)) continue;
          if (lower.includes(entry.phrase)) {
            if (!matchedKeys) matchedKeys = new Set<string>();
            matchedKeys.add(entry.key);
          }
        }
      }

      if (!matchedKeys) continue;
      // Only run fictional noise filter on rows that actually matched a person
      if (FICTIONAL_NOISE_RE.test(lower)) continue;

      for (const k of matchedKeys) {
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
  } catch {
    // ignore DB errors in isolated tests without claims table
  }

  return counts;
}

export function buildEmptySynthesizedWorldModel(opts: {
  name: string;
  channels: string[];
  aliases: string[];
  claimCount: number;
  messageCount: number;
  meetingCount: number;
  preview: string;
  firstSeen: string | null;
  lastSeen: string | null;
}): PersonWorldModel {
  const hasRichLive = opts.messageCount >= 10 || opts.claimCount >= 10;
  return {
    schema_version: "none",
    source_path: null,
    updated_at: opts.lastSeen ? opts.lastSeen.slice(0, 10) : null,
    confidence: hasRichLive ? "medium" : "low",
    relationship_state: opts.messageCount > 0 ? "active" : "ambient",
    relationship_tier: opts.messageCount >= 25 || opts.claimCount >= 25 ? "Active" : "Ambient",
    role: "",
    org: "",
    handles: {},
    aliases: opts.aliases.slice(0, 10),
    canonical_read: opts.preview
      ? `Unprofiled live contact (${opts.messageCount} msgs, ${opts.claimCount} claims). Latest signal: ${opts.preview}`
      : `Unprofiled contact across ${opts.channels.join(", ") || "vault"} (${opts.messageCount} msgs, ${opts.claimCount} claims). Run World-Model Synthesis to build a full person-card-v2 profile.`,
    at_a_glance: [
      { field: "Channels", value: opts.channels.join(", ") || "None" },
      { field: "Messages", value: String(opts.messageCount) },
      { field: "SQLite Claims", value: String(opts.claimCount) },
      { field: "Meetings", value: String(opts.meetingCount) },
      ...(opts.firstSeen ? [{ field: "First seen", value: opts.firstSeen.slice(0, 10) }] : []),
    ],
    operating_loop: "",
    current_read_bullets: [],
    why_they_matter: [],
    tastes_preferences: [],
    philosophies_decision_model: [],
    goals_explicit: [],
    goals_inferred: [],
    our_leverage: [],
    their_leverage: [],
    trust_builders: [],
    degraders: [],
    engagement_playbook: [],
    do_not_assume: [],
    open_loops: [],
    contradictions: [],
    hypotheses: [],
    evidence_table: [],
    relationship_timeline: [],
    velocity: null,
    collaborators: [],
    owner_notes: [],
    full_markdown: "",
  };
}

function compactExistingCardForSynthesis(rawMd: string, maxChars = 5500): string {
  const clean = stripEmDashesIntel(rawMd || "").trim();
  if (!clean) return "";
  if (clean.length <= maxChars) return clean;

  // Strip backrefs and backtrack mention lists first
  const stripped = clean
    .replace(/<!--\s*backrefs:start\s*-->[\s\S]*?<!--\s*backrefs:end\s*-->/gi, "")
    .replace(/<!--\s*backtrack-mentions:start\s*-->[\s\S]*?<!--\s*backtrack-mentions:end\s*-->/gi, "")
    .trim();
  if (stripped.length <= maxChars) return stripped;

  const { body } = parseFrontmatter(stripped);
  const { preamble, sections } = splitMarkdownSections(body);

  const chunks: string[] = [];
  const preambleText = preamble
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("<!--"))
    .join("\n");
  if (preambleText) {
    chunks.push(preambleText.slice(0, 900));
  }

  const priorityScore = (heading: string): number => {
    const h = heading.toLowerCase();
    if (
      h === "referenced by" ||
      h === "update protocol" ||
      h === "related" ||
      h.startsWith("mentioned in backtrack") ||
      h === "what this page is for" ||
      h === "privacy and confidence boundaries"
    ) {
      return -1;
    }
    if (h.includes("owner observations") || h.includes("owner notes")) return 100;
    if (h.includes("leverage") || h.includes("our edge") || h.includes("their edge")) return 95;
    if (h.includes("tastes") || h.includes("sensibilities") || h.includes("load and rhythm")) return 90;
    if (h.includes("philosoph") || h.includes("decision model") || h.includes("mental model")) return 88;
    if (h.includes("operating loop") || h.includes("current read") || h === "at a glance") return 85;
    if (h.includes("relationship timeline") || h.includes("trust") || h.includes("playbook") || h.includes("do not assume")) return 80;
    if (h.includes("goals") || h.includes("open loops") || h.includes("contradiction") || h.includes("why")) return 75;
    if (h.includes("hypotheses") || h.includes("judgments") || h.includes("evidence")) return 60;
    return 40;
  };

  const ranked = sections
    .map((sec, idx) => ({ sec, idx, score: priorityScore(sec.heading) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx);

  let used = chunks.reduce((s, c) => s + c.length, 0);
  for (const item of ranked) {
    const remaining = maxChars - used;
    if (remaining <= 160) break;
    const prefix = item.sec.level === 2 ? "##" : "###";
    const secBody = item.sec.lines.join("\n").trim();
    if (!secBody) continue;
    const secCap = Math.min(remaining - 24, 950);
    const block = `${prefix} ${item.sec.heading}\n${secBody.slice(0, secCap).trimEnd()}`;
    chunks.push(block);
    used += block.length + 2;
  }

  return chunks.join("\n\n").slice(0, maxChars).trimEnd();
}

export function buildWorldModelSynthesisPrompt(opts: {
  slug: string;
  name: string;
  existingCardMd: string;
  existingOwnerNotes: Array<{ date: string; kind: string; text: string }>;
  messages: Array<{ channel: string; sender: string; occurred_at: string; text: string }>;
  claims: SqlitePersonClaim[];
  meetings: Array<{ title: string; start: string; notes: string }>;
  collaborators: Array<{ name: string; shared_events: number; note?: string }>;
  handles: PersonWorldModel["handles"];
  aliases: string[];
  focus?: string;
}): { systemPrompt: string; userPrompt: string } {
  const today = new Date().toISOString().slice(0, 10);

  const systemPrompt = [
    "You are Kizuki's World-Model Psychographic & Strategic People Profiler for Kizuki Personal Mind OS.",
    "Your job is to synthesize ALL observed evidence (existing dossier, historical and recent cross-channel messages, Kizuki SQLite claims, meetings, and owner notes) into a razor-sharp, candid, evidence-grounded `person-card-v2` Markdown dossier.",
    "",
    "STRICT QUALITY LAWS:",
    "1. ZERO flattery, ZERO corporate HR filler, ZERO AI slop, ZERO horoscope/astrology generalizations.",
    "2. Explicitly separate OBSERVED FACT (cite dates/artifacts/messages) from STRATEGIC INFERENCE.",
    "3. Be brutally honest and useful on asymmetric leverage: where the owner holds leverage and aligns cleanly, AND where the counterpart holds leverage, creates dependencies/blockers, or could stall or create asymmetric exposure.",
    "4. ZERO em-dashes (never output the character U+2014 anywhere). Use colons, parentheses, or hyphens with spaces (` - `) instead.",
    "5. Preserve ALL existing `## Owner observations` entries verbatim.",
    "6. Output ONLY the complete Markdown document starting with `---` YAML frontmatter (no outer code fences, no preamble).",
    "",
    "REQUIRED DOCUMENT STRUCTURE (use these exact headings):",
    "```markdown",
    "---",
    `title: "${opts.name}"`,
    `canonical_name: "${opts.name}"`,
    `display_name: "${opts.name}"`,
    `schema_version: "person-card-v2"`,
    `status: "canonical"`,
    `updated: "${today}"`,
    `confidence: "high|medium|low"`,
    `relationship_state: "core|family|active|warm|cooling|dormant"`,
    `relationship_role: "<concise sharp role>"`,
    `org: "<org or Personal/Family>"`,
    `aliases: [...]`,
    "---",
    `# ${opts.name}`,
    "",
    "<!-- person-card:v2 -->",
    "",
    "> **Canonical read:** <3-4 crisp sentences capturing who they are, their recurring operating pattern, and their real role in the owner's life/work.>",
    "",
    "## At a glance",
    "| Field | Current state |",
    "| --- | --- |",
    "| **Role** | ... |",
    "| **Relationship** | ... |",
    "| **Primary overlap** | ... |",
    "| **Current move** | ... |",
    "| **Do not assume** | ... |",
    "",
    "## Operating loop & current read",
    "<Short paragraph + numbered operating loop + crisp dated bullets>",
    "",
    "## Tastes, preferences & sensibilities",
    "- <Concrete observed tastes, communication register, what recharges/energizes them, pet peeves>",
    "",
    "## Core philosophies & decision model",
    "- <First principles, mental models, how they actually make decisions under pressure>",
    "",
    "## Goals, motivations & incentives",
    "### Explicitly observed",
    "- ...",
    "### Inferred",
    "- ...",
    "",
    "## Asymmetric dynamics & leverage map",
    "### Our edge (how we align and win)",
    "- <What the owner controls, brings, or can deploy that this person genuinely values>",
    "### Their edge (exposure, dependencies & watch-outs)",
    "- <Where they can block, stall, dictate terms, or create asymmetric exposure>",
    "",
    "## Trust mechanics & engagement playbook",
    "### What builds trust",
    "- ...",
    "### What degrades the relationship",
    "- ...",
    "### Playbook",
    "- ...",
    "### Do not assume",
    "- ...",
    "",
    "## Open loops",
    "| Open loop | State | Owner / next evidence |",
    "| --- | --- | --- |",
    "",
    "## Contradictions & changing state",
    "- ...",
    "",
    "## World-model judgments & hypotheses",
    "| Judgment | Current read | Confidence | Falsifier or update signal |",
    "| --- | --- | --- | --- |",
    "",
    "## Relationship timeline",
    "- YYYY-MM-DD ▲ (positive) ...",
    "- YYYY-MM-DD • (neutral) ...",
    "- YYYY-MM-DD ▼ (negative) ...",
    "",
    "## Owner observations",
    "<Preserve every existing dated owner note verbatim here>",
    "```",
  ].join("\n");

  const msgBlock =
    opts.messages.length > 0
      ? opts.messages
          .slice(0, 32)
          .map(
            (m) =>
              `- [${m.occurred_at.slice(0, 16).replace("T", " ")} | ${m.channel} | ${m.sender}]: ${cleanLineText(m.text, 240)}`
          )
          .join("\n")
      : "(No cross-channel messages indexed)";

  const claimsBlock =
    opts.claims.length > 0
      ? opts.claims
          .slice(0, 20)
          .map((c) => `- [${c.created_at.slice(0, 10)} | ${c.kind} | conf=${c.confidence.toFixed(2)}]: ${cleanLineText(c.text, 220)}`)
          .join("\n")
      : "(No SQLite claims indexed)";

  const meetingsBlock =
    opts.meetings.length > 0
      ? opts.meetings
          .slice(0, 12)
          .map((m) => `- [${m.start.slice(0, 16).replace("T", " ")}] ${m.title}${m.notes ? ` | ${cleanLineText(m.notes, 140)}` : ""}`)
          .join("\n")
      : "(No meetings indexed)";

  const collabBlock =
    opts.collaborators.length > 0
      ? opts.collaborators
          .slice(0, 10)
          .map((c) => `- ${c.name} (${c.shared_events} shared${c.note ? `, ${c.note}` : ""})`)
          .join("\n")
      : "(None)";

  const ownerNotesBlock =
    opts.existingOwnerNotes.length > 0
      ? opts.existingOwnerNotes.map((n) => `- [${n.date}] [${n.kind}] ${n.text}`).join("\n")
      : "(None yet)";

  const cardExcerpt = compactExistingCardForSynthesis(opts.existingCardMd, 5500);

  const userPrompt = [
    `Target Person: ${opts.name} (slug: ${opts.slug})`,
    `Known Aliases: ${opts.aliases.join(", ") || opts.name}`,
    `Handles: ${JSON.stringify(opts.handles)}`,
    opts.focus ? `Special Synthesis Focus from Owner: ${stripEmDashesIntel(opts.focus)}` : "",
    "",
    "=== EXISTING CANONICAL DOSSIER (preserve verified facts & enrich) ===",
    cardExcerpt || "(No existing card; build fresh from live evidence below)",
    "",
    "=== EXISTING OWNER OBSERVATIONS (MUST PRESERVE VERBATIM) ===",
    ownerNotesBlock,
    "",
    "=== CROSS-CHANNEL MESSAGE HISTORY (spanning earliest to latest) ===",
    msgBlock,
    "",
    "=== KIZUKI SQLITE CLAIMS & BACKTRACK EVIDENCE ===",
    claimsBlock,
    "",
    "=== CALENDAR MEETINGS ===",
    meetingsBlock,
    "",
    "=== COLLABORATOR NETWORK ===",
    collabBlock,
  ]
    .filter((s) => s !== undefined)
    .join("\n");

  return { systemPrompt, userPrompt };
}

function upsertFrontmatterScalar(fm: string, key: string, value: string): string {
  const line = `${key}: "${value}"`;
  const re = new RegExp(`^${key}:.*$`, "m");
  if (re.test(fm)) {
    return fm.replace(re, line);
  }
  return `${fm}\n${line}`;
}

function enforceDraftFrontmatter(fm: string, slug: string, today: string): string {
  const targetCanonPath = `world/people/${slug}.md`;
  let next = upsertFrontmatterScalar(fm, "schema_version", "person-card-v2");
  next = upsertFrontmatterScalar(next, "status", "draft");
  if (/^x-status:/m.test(next)) {
    next = next.replace(/^x-status:.*$/m, `x-status: "draft"`);
  }
  next = upsertFrontmatterScalar(next, "target_canon_path", targetCanonPath);
  next = upsertFrontmatterScalar(next, "promotion_via", "kizuki-receipted-writer");
  next = upsertFrontmatterScalar(next, "updated", today);
  return next;
}

export async function writeWorldModelPersonCard(
  vaultPath: string,
  rawSlug: string,
  markdown: string
): Promise<{
  card_path: string;
  full_path: string;
  content: string;
  draft: true;
  target_canon_path: string;
}> {
  const slug = normalizeSlug(rawSlug);
  if (!isValidPersonSlug(slug)) {
    throw new Error(`Invalid person slug: ${rawSlug}`);
  }

  let cleanMd = stripEmDashesIntel(markdown).trim();
  // Strip outer markdown fence if LLM wrapped it
  const fenceM = cleanMd.match(/^```(?:markdown|md)?\s*\n([\s\S]+?)\n```\s*$/i);
  if (fenceM && fenceM[1]) {
    cleanMd = fenceM[1].trim();
  }
  if (!cleanMd || cleanMd.length < 40) {
    throw new Error("Refusing to write empty or malformed person-card-v2 markdown");
  }

  const today = new Date().toISOString().slice(0, 10);
  const targetCanonPath = `world/people/${slug}.md`;
  if (!cleanMd.startsWith("---\n")) {
    cleanMd = [
      "---",
      `title: "${slug}"`,
      `schema_version: "person-card-v2"`,
      `status: "draft"`,
      `target_canon_path: "${targetCanonPath}"`,
      `promotion_via: "kizuki-receipted-writer"`,
      `updated: "${today}"`,
      "---",
      "",
      cleanMd,
    ].join("\n");
  } else {
    const endIdx = cleanMd.indexOf("\n---", 3);
    if (endIdx !== -1) {
      const fm = enforceDraftFrontmatter(cleanMd.slice(4, endIdx), slug, today);
      cleanMd = `---\n${fm}${cleanMd.slice(endIdx)}`;
    }
  }
  cleanMd = stripEmDashesIntel(cleanMd).trimEnd() + "\n";

  const rootResolved = resolve(vaultPath);
  const targetDir = resolve(rootResolved, ".kizuki", "drafts", "people");
  const fullPath = resolve(targetDir, `${slug}.md`);
  if (!fullPath.startsWith(targetDir + sep)) {
    throw new Error("Path traversal blocked for person draft card");
  }

  await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
  const tmpPath = join(targetDir, `.${slug}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, cleanMd, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, fullPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  return {
    card_path: `.kizuki/drafts/people/${slug}.md`,
    full_path: fullPath,
    content: cleanMd,
    draft: true,
    target_canon_path: targetCanonPath,
  };
}

export async function appendOwnerObservation(
  vaultPath: string,
  rawSlug: string,
  personName: string,
  existingCardMd: string | null,
  note: { kind: OwnerNoteKind; text: string }
): Promise<{
  card_path: string;
  full_path: string;
  content: string;
  note_line: string;
  draft: true;
  target_canon_path: string;
}> {
  const slug = normalizeSlug(rawSlug);
  if (!isValidPersonSlug(slug)) {
    throw new Error(`Invalid person slug: ${rawSlug}`);
  }
  const cleanText = stripEmDashesIntel(note.text || "")
    .replace(/\r?\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleanText) {
    throw new Error("Observation text is required");
  }
  const kind: OwnerNoteKind = VALID_OWNER_NOTE_KINDS.has(note.kind) ? note.kind : "insight";
  const today = new Date().toISOString().slice(0, 10);
  const noteLine = `- [${today}] [${kind}] ${cleanText}`;
  const targetCanonPath = `world/people/${slug}.md`;

  const rootResolved = resolve(vaultPath);
  const targetDir = resolve(rootResolved, ".kizuki", "drafts", "people");
  const fullPath = resolve(targetDir, `${slug}.md`);
  if (!fullPath.startsWith(targetDir + sep)) {
    throw new Error("Path traversal blocked for owner observation");
  }

  // Read existing draft first; if absent, seed read-only from canonical world/people/<slug>.md or existingCardMd
  let baseMd = "";
  try {
    baseMd = await readFile(fullPath, "utf8");
  } catch {
    const canonicalDir = resolve(rootResolved, "world", "people");
    const canonicalPath = resolve(canonicalDir, `${slug}.md`);
    if (canonicalPath.startsWith(canonicalDir + sep)) {
      try {
        baseMd = await readFile(canonicalPath, "utf8");
      } catch {
        baseMd = existingCardMd ? stripEmDashesIntel(existingCardMd) : "";
      }
    } else {
      baseMd = existingCardMd ? stripEmDashesIntel(existingCardMd) : "";
    }
  }

  if (!baseMd.trim()) {
    const cleanName = stripEmDashesIntel(personName || slug);
    baseMd = [
      "---",
      `title: "${cleanName}"`,
      `canonical_name: "${cleanName}"`,
      `display_name: "${cleanName}"`,
      `schema_version: "person-card-v2"`,
      `status: "draft"`,
      `target_canon_path: "${targetCanonPath}"`,
      `promotion_via: "kizuki-receipted-writer"`,
      `updated: "${today}"`,
      `confidence: "medium"`,
      `relationship_state: "active"`,
      "---",
      `# ${cleanName}`,
      "",
      "<!-- person-card:v2 -->",
      "",
      `> **Draft read:** ${cleanName} is tracked in Kizuki Personal Mind OS. Owner observations below capture direct ground-truth signals for promotion via Core receipted writer.`,
      "",
      "## Owner observations",
      "",
      noteLine,
      "",
    ].join("\n");
  } else {
    if (baseMd.startsWith("---\n")) {
      const endIdx = baseMd.indexOf("\n---", 3);
      if (endIdx !== -1) {
        const fm = enforceDraftFrontmatter(baseMd.slice(4, endIdx), slug, today);
        baseMd = `---\n${fm}${baseMd.slice(endIdx)}`;
      }
    } else {
      const cleanName = stripEmDashesIntel(personName || slug);
      baseMd = [
        "---",
        `title: "${cleanName}"`,
        `schema_version: "person-card-v2"`,
        `status: "draft"`,
        `target_canon_path: "${targetCanonPath}"`,
        `promotion_via: "kizuki-receipted-writer"`,
        `updated: "${today}"`,
        "---",
        "",
        baseMd,
      ].join("\n");
    }

    const headingRe = /^##\s+Owner observations\s*$/im;
    const match = headingRe.exec(baseMd);
    if (match) {
      const afterHeadingIdx = match.index + match[0].length;
      const rest = baseMd.slice(afterHeadingIdx);
      const nextH2 = rest.search(/\n##\s+/);
      if (nextH2 === -1) {
        baseMd = `${baseMd.trimEnd()}\n${noteLine}\n`;
      } else {
        const insertPos = afterHeadingIdx + nextH2;
        const before = baseMd.slice(0, insertPos).trimEnd();
        const after = baseMd.slice(insertPos);
        baseMd = `${before}\n${noteLine}\n${after}`;
      }
    } else {
      baseMd = `${baseMd.trimEnd()}\n\n## Owner observations\n\n${noteLine}\n`;
    }
  }

  const finalMd = stripEmDashesIntel(baseMd).trimEnd() + "\n";

  await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
  const tmpPath = join(targetDir, `.${slug}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmpPath, finalMd, { encoding: "utf8", mode: 0o600 });
    await rename(tmpPath, fullPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }

  return {
    card_path: `.kizuki/drafts/people/${slug}.md`,
    full_path: fullPath,
    content: finalMd,
    note_line: noteLine,
    draft: true,
    target_canon_path: targetCanonPath,
  };
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  imessage: "iMessage",
  gmail: "Gmail",
  calendar: "Calendar",
};
const SELF_EMAILS_SET = new Set([
  "unknownorganizer@calendar.google.com",
  ...(process.env.KIZUKI_OWNER_EMAILS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
]);

function clampInt(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(val)));
}

function countPatternHits(text: string, patterns: RegExp[]): number {
  let hits = 0;
  for (const re of patterns) {
    if (re.test(text)) hits += 1;
  }
  return hits;
}

function getMondayUtcMs(ms: number): number {
  const dt = new Date(ms);
  const utcMid = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
  const dow = new Date(utcMid).getUTCDay(); // 0=Sun..6=Sat
  const offsetDays = dow === 0 ? 6 : dow - 1;
  return utcMid - offsetDays * 86_400_000;
}

function formatWeekLabelUtc(ms: number): string {
  const dt = new Date(ms);
  const mon = SHORT_MONTHS[dt.getUTCMonth()] || "Jan";
  return `${mon} ${dt.getUTCDate()}`;
}

function isDisallowedContactUrl(rawUrl: string): boolean {
  const lower = rawUrl.toLowerCase();
  return (
    lower.includes("localhost") ||
    lower.includes("127.0.0.1") ||
    lower.includes("0.0.0.0") ||
    lower.includes("redacted") ||
    lower.includes("meet.google.com") ||
    lower.includes("support.google.com") ||
    lower.includes("calendar.google.com") ||
    lower.includes("oauth") ||
    lower.includes("access_token=") ||
    lower.includes("client_id=") ||
    lower.includes("example.com") ||
    lower.includes("://t.co/")
  );
}

function formatEmailLabel(email: string, maxLen = 28): string {
  const clean = email.replace(/^mailto:/i, "").replace(/\s+/g, "").toLowerCase();
  if (clean.length <= maxLen) return clean;
  const atIdx = clean.indexOf("@");
  if (atIdx > 0) {
    const local = clean.slice(0, atIdx);
    const domain = clean.slice(atIdx + 1);
    const localBudget = maxLen - domain.length - 4; // "...@"
    if (localBudget >= 3) {
      return `${local.slice(0, localBudget)}...@${domain}`;
    }
  }
  return `${clean.slice(0, Math.max(1, maxLen - 3))}...`;
}

function normalizeEmailCandidate(raw: string): string {
  return String(raw || "")
    .replace(/^mailto:/i, "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function extractContactLinks(input: ComputePersonProfileVisualsInput): PersonProfileVisuals["contact_links"] {
  type LinkItem = PersonProfileVisuals["contact_links"][number];
  const links: LinkItem[] = [];
  const seen = new Set<string>();

  const pushLink = (item: LinkItem) => {
    let cleanVal = stripEmDashesIntel(item.value || "").trim();
    if (item.kind === "email") {
      cleanVal = normalizeEmailCandidate(cleanVal);
    }
    if (!cleanVal) return;

    const normVal =
      item.kind === "email"
        ? cleanVal
        : cleanVal
            .toLowerCase()
            .replace(/^@+/, "")
            .replace(/^(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com|t\.me|github\.com)\//, "")
            .replace(/\/+$/, "")
            .trim();
    const cleanHref =
      item.kind === "email"
        ? `mailto:${cleanVal}`
        : item.href
          ? stripEmDashesIntel(item.href).trim()
          : null;
    const normHref = (cleanHref || "")
      .toLowerCase()
      .replace(/^https?:\/\/(?:www\.)?twitter\.com\//, "https://x.com/")
      .replace(/\/+$/, "")
      .trim();
    const key1 = `${item.kind}:${normVal}`;
    const key2 = normHref ? `href:${normHref}` : "";
    if (seen.has(key1) || (key2 && seen.has(key2))) return;
    seen.add(key1);
    if (key2) seen.add(key2);
    links.push({
      ...item,
      label: stripEmDashesIntel(item.label).trim(),
      value: cleanVal,
      href: cleanHref,
    });
  };

  const fullMd = input.worldModel.full_markdown || "";
  const mdWithoutBackrefs = fullMd
    .replace(/<!--\s*backrefs:start\s*-->[\s\S]*?<!--\s*backrefs:end\s*-->/gi, "")
    .replace(/<!--\s*backtrack-mentions:start\s*-->[\s\S]*?<!--\s*backtrack-mentions:end\s*-->/gi, "");
  const parsedFm = fullMd ? parseFrontmatter(fullMd).frontmatter : null;

  // 1. Structured handles from world model & frontmatter
  const emailCandidates = new Set<string>();
  const addEmailCandidate = (raw: string | undefined | null) => {
    if (!raw) return;
    const norm = normalizeEmailCandidate(raw);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(norm)) return;
    if (
      SELF_EMAILS_SET.has(norm) ||
      norm.startsWith("noreply@") ||
      norm.startsWith("no-reply@") ||
      norm.includes("calendar.google.com") ||
      norm.includes("example.com")
    ) {
      return;
    }
    emailCandidates.add(norm);
  };
  addEmailCandidate(input.worldModel.handles.email);
  addEmailCandidate(parsedFm?.email);
  for (const cand of [input.key, ...input.aliases]) {
    addEmailCandidate(cand);
  }
  const mdEmailMatches = mdWithoutBackrefs.match(/\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g) || [];
  for (const em of mdEmailMatches) {
    addEmailCandidate(em);
  }
  for (const em of emailCandidates) {
    pushLink({
      kind: "email",
      label: formatEmailLabel(em, 28),
      value: em,
      href: `mailto:${em}`,
      copyable: true,
    });
  }

  const tgHandle = (input.worldModel.handles.telegram || parsedFm?.telegram_handle || "").replace(/^@+/, "").trim();
  if (tgHandle && /^[a-zA-Z0-9_]{3,40}$/.test(tgHandle)) {
    pushLink({
      kind: "telegram",
      label: `@${tgHandle}`,
      value: `@${tgHandle}`,
      href: `https://t.me/${tgHandle}`,
      copyable: true,
    });
  }

  const xHandle = (input.worldModel.handles.x || parsedFm?.x_handle || "").replace(/^@+/, "").trim();
  if (xHandle && /^[a-zA-Z0-9_]{2,30}$/.test(xHandle)) {
    pushLink({
      kind: "x",
      label: `@${xHandle}`,
      value: `@${xHandle}`,
      href: `https://x.com/${xHandle}`,
      copyable: true,
    });
  }

  const ghHandle = (input.worldModel.handles.github || parsedFm?.github_handle || "").replace(/^@+/, "").trim();
  if (ghHandle && /^[a-zA-Z0-9-]{2,40}$/.test(ghHandle)) {
    pushLink({
      kind: "github",
      label: `github/${ghHandle}`,
      value: ghHandle,
      href: `https://github.com/${ghHandle}`,
      copyable: true,
    });
  }

  // Phone from key or aliases
  for (const cand of [input.key, ...input.aliases]) {
    const s = String(cand || "").trim();
    if (/^\+?\d{8,15}$/.test(s)) {
      const normalizedPhone = s.startsWith("+") ? s : `+${s}`;
      pushLink({
        kind: "phone",
        label: normalizedPhone,
        value: normalizedPhone,
        href: `tel:${normalizedPhone}`,
        copyable: true,
      });
      break;
    }
  }

  // 2. Collect URLs from official_url, frontmatter sources:, and markdown body
  const rawUrls: string[] = [];
  if (input.worldModel.handles.url) rawUrls.push(input.worldModel.handles.url);
  if (parsedFm?.official_url) rawUrls.push(parsedFm.official_url);
  const fmSources = parsedFm?.raw?.sources;
  if (Array.isArray(fmSources)) {
    for (const src of fmSources) {
      if (typeof src === "string" && /^https?:\/\//i.test(src.trim())) {
        rawUrls.push(src.trim());
      }
    }
  }
  const bodyUrls = mdWithoutBackrefs.match(/https?:\/\/[^\s<>)"'`\]]+/gi) || [];
  for (const u of bodyUrls) rawUrls.push(u);

  for (const raw of rawUrls) {
    const cleaned = raw.replace(/[.,;:!?)'"]+$/, "").trim();
    if (!cleaned || isDisallowedContactUrl(cleaned)) continue;
    let parsed: URL;
    try {
      parsed = new URL(cleaned);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const segs = parsed.pathname.split("/").filter(Boolean);
    const cleanHref = `${parsed.protocol}//${parsed.hostname}${parsed.pathname.replace(/\/+$/, "") || "/"}`;

    if (host === "github.com") {
      if (segs.length >= 2 && !["orgs", "topics", "search", "features", "settings"].includes(segs[0].toLowerCase())) {
        const repoPath = `${segs[0]}/${segs[1]}`;
        pushLink({
          kind: "repo",
          label: repoPath,
          value: `github.com/${repoPath}`,
          href: `https://github.com/${repoPath}`,
          copyable: true,
        });
      } else if (segs.length === 1) {
        const user = segs[0].replace(/^@+/, "");
        pushLink({
          kind: "github",
          label: user ? `github/${user}` : "GitHub",
          value: user,
          href: `https://github.com/${user}`,
          copyable: true,
        });
      }
      continue;
    }

    if (host === "x.com" || host === "twitter.com") {
      if (segs.length === 1 && !["home", "explore", "search", "i", "intent"].includes(segs[0].toLowerCase())) {
        const handle = segs[0].replace(/^@+/, "");
        pushLink({
          kind: "x",
          label: handle ? `@${handle}` : "X profile",
          value: `@${handle}`,
          href: `https://x.com/${handle}`,
          copyable: true,
        });
      }
      continue;
    }

    if (host === "t.me") {
      if (segs.length === 1 && !segs[0].startsWith("+")) {
        const handle = segs[0].replace(/^@+/, "");
        pushLink({
          kind: "telegram",
          label: handle ? `@${handle}` : "Telegram",
          value: `@${handle}`,
          href: `https://t.me/${handle}`,
          copyable: true,
        });
      }
      continue;
    }

    if (host === "linkedin.com" || host.endsWith(".linkedin.com")) {
      if (segs[0] === "in" && segs[1]) {
        pushLink({
          kind: "linkedin",
          label: `in/${segs[1]}`,
          value: segs[1],
          href: `https://www.linkedin.com/in/${segs[1]}`,
          copyable: true,
        });
      }
      continue;
    }

    const displayPath = segs.length > 0 ? `${host}/${segs.slice(0, 2).join("/")}` : host;
    pushLink({
      kind: "web",
      label: host,
      value: displayPath.slice(0, 64),
      href: cleanHref,
      copyable: true,
    });
  }

  const kindOrder: Record<LinkItem["kind"], number> = {
    email: 1,
    telegram: 2,
    x: 3,
    github: 4,
    linkedin: 5,
    phone: 6,
    web: 7,
    repo: 8,
  };
  return links.sort((a, b) => kindOrder[a.kind] - kindOrder[b.kind]).slice(0, 12);
}

const KNOWN_EGO_ENTITIES: Array<{
  label: string;
  kind: "company" | "workstream";
  re: RegExp;
  meta: string;
}> = [
  { label: "Kizuki", kind: "workstream", re: /\bkizuki\b/i, meta: "Personal OS overlap" },
  { label: "Engineering", kind: "workstream", re: /\bengineering\b|\binfra\b|\bsystems\b/i, meta: "Technical workstream" },
  { label: "Product", kind: "workstream", re: /\bproduct\b|\bdesign\b|\bux\b/i, meta: "Product workstream" },
  { label: "Family", kind: "workstream", re: /\bfamily\b|\bhousehold\b|\bschool\s+runs?\b/i, meta: "Household & family" },
];

function extractEgoGraph(input: ComputePersonProfileVisualsInput): PersonProfileVisuals["ego_graph"] {
  const nodes: PersonProfileVisuals["ego_graph"]["nodes"] = [];
  const seenIds = new Set<string>();

  // Top 8 collaborators with clickable directory keys
  for (const c of input.collaborators.slice(0, 8)) {
    const id = `person:${c.key || c.slug}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    nodes.push({
      id,
      key: c.key,
      label: stripEmDashesIntel(c.name),
      kind: "person",
      weight: Math.max(1, c.shared_events || 1),
      meta: c.note
        ? cleanLineText(c.note, 64)
        : c.shared_events > 0
          ? `${c.shared_events} shared events`
          : "Collaborator",
    });
  }

  // Up to 4 real linked companies / workstreams
  const entityScores = new Map<
    string,
    { label: string; kind: "company" | "workstream"; weight: number; meta: string }
  >();
  const upsertEntity = (label: string, kind: "company" | "workstream", weightDelta: number, meta: string) => {
    const clean = cleanLineText(label, 48);
    const norm = normalizeSlug(clean);
    if (!norm || norm === normalizeSlug(input.name) || norm === input.key) return;
    const prev = entityScores.get(norm);
    if (!prev) {
      entityScores.set(norm, { label: clean, kind, weight: weightDelta, meta });
    } else {
      prev.weight += weightDelta;
    }
  };

  if (input.org && !/^(personal|none|unknown|n\/a)$/i.test(input.org.trim())) {
    const isFam = /family/i.test(input.org);
    upsertEntity(input.org, isFam ? "workstream" : "company", 8, isFam ? "Household & family" : "Primary organization");
  }
  if (input.relationshipTier === "Family") {
    upsertEntity("Family", "workstream", 9, "Household & family");
  }

  const mdNoBackrefs = (input.worldModel.full_markdown || "")
    .replace(/<!--\s*backrefs:start\s*-->[\s\S]*?<!--\s*backrefs:end\s*-->/gi, "")
    .slice(0, 12000);

  // Explicit [[03-entities/companies/...]] links in card
  const compLinks = mdNoBackrefs.matchAll(/\[\[03-entities\/companies\/([a-z0-9_-]+)(?:\|([^\]]+))?\]\]/gi);
  for (const m of compLinks) {
    const slug = m[1].toLowerCase();
    const rawLabel = m[2] || m[1];
    // Map known clean names first; skip multi-entity composite slugs
    const known = KNOWN_EGO_ENTITIES.find((k) => k.re.test(rawLabel) || normalizeSlug(k.label) === slug);
    if (known) {
      upsertEntity(known.label, known.kind, 6, known.meta);
    } else if (slug.split("-").length <= 2) {
      const pretty = rawLabel
        .replace(/-/g, " ")
        .replace(/\b\w/g, (ch) => ch.toUpperCase());
      upsertEntity(pretty, "company", 5, "Linked company");
    }
  }

  // Known workstreams/companies mentioned in high-signal profile text
  const signalText = [
    input.role,
    input.org,
    input.worldModel.canonical_read,
    ...input.worldModel.at_a_glance.map((r) => r.value),
    ...input.worldModel.current_read_bullets.slice(0, 10),
    ...input.worldModel.why_they_matter.slice(0, 5),
    mdNoBackrefs.slice(0, 5000),
  ].join(" ");

  for (const ent of KNOWN_EGO_ENTITIES) {
    if (ent.label === "Family" && input.relationshipTier !== "Family") continue;
    const matches = signalText.match(new RegExp(ent.re.source, "gi"));
    if (matches && matches.length > 0) {
      upsertEntity(ent.label, ent.kind, Math.min(7, 2 + matches.length), ent.meta);
    }
  }

  const topEntities = Array.from(entityScores.values())
    .sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label))
    .slice(0, 4);

  for (const ent of topEntities) {
    const id = `${ent.kind}:${normalizeSlug(ent.label)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    nodes.push({
      id,
      key: null,
      label: ent.label,
      kind: ent.kind,
      weight: clampInt(ent.weight, 1, 10),
      meta: ent.meta,
    });
  }

  return {
    center: {
      name: stripEmDashesIntel(input.name),
      initials: input.initials,
      tier: input.relationshipTier,
      role: cleanLineText(input.role || input.org || input.relationshipTier, 80),
    },
    nodes,
  };
}

function buildCadenceAndChannels(input: ComputePersonProfileVisualsInput): {
  cadence_series: PersonProfileVisuals["cadence_series"];
  channel_breakdown: PersonProfileVisuals["channel_breakdown"];
  reciprocity_ratio: PersonProfileVisuals["reciprocity_ratio"];
  recent4wCount: number;
} {
  const nowMs = input.nowMs ?? Date.now();
  let youCount = 0;
  let themCount = 0;
  const channelCounts = new Map<string, number>();

  const pastEvents: Array<{ ms: number; channel: "whatsapp" | "telegram" | "imessage" | "gmail" | "calendar" }> = [];
  let latestEventMs = 0;

  for (const msg of input.timeline) {
    const ms = Date.parse(msg.occurred_at);
    if (!Number.isFinite(ms) || ms > nowMs) continue;
    if (ms > latestEventMs) latestEventMs = ms;

    const isYou =
      msg.direction === "You" ||
      msg.sender === "You" ||
      msg.sender.startsWith("You -> ") ||
      /^(owner|you|me|self)$/i.test(msg.sender.trim());
    if (isYou) youCount += 1;
    else themCount += 1;

    const ch = msg.channel.toLowerCase();
    if (ch === "whatsapp" || ch === "telegram" || ch === "imessage" || ch === "gmail") {
      channelCounts.set(ch, (channelCounts.get(ch) || 0) + 1);
      pastEvents.push({ ms, channel: ch });
    }
  }

  let pastMeetingsCount = 0;
  for (const m of input.meetings) {
    const ms = Date.parse(m.start);
    if (!Number.isFinite(ms)) continue;
    if (ms <= nowMs) {
      pastMeetingsCount += 1;
      if (ms > latestEventMs) latestEventMs = ms;
      pastEvents.push({ ms, channel: "calendar" });
    }
  }
  const calBreakdownCount = pastMeetingsCount > 0 ? pastMeetingsCount : input.meetings.length;
  if (calBreakdownCount > 0) {
    channelCounts.set("calendar", calBreakdownCount);
  }

  // Anchor 16-week span to current week, or shift to latest interaction week if activity is >12 weeks old
  const currentWeekStartMs = getMondayUtcMs(nowMs);
  const TWELVE_WEEKS_MS = 12 * 7 * 86_400_000;
  const anchorWeekStartMs =
    latestEventMs > 0 && nowMs - latestEventMs > TWELVE_WEEKS_MS
      ? getMondayUtcMs(latestEventMs)
      : currentWeekStartMs;

  const buckets = new Map<string, PersonProfileVisuals["cadence_series"][number]>();
  const series: PersonProfileVisuals["cadence_series"] = [];
  for (let i = 15; i >= 0; i--) {
    const wMs = anchorWeekStartMs - i * 7 * 86_400_000;
    const weekStart = new Date(wMs).toISOString().slice(0, 10);
    const entry = {
      week_label: formatWeekLabelUtc(wMs),
      week_start: weekStart,
      total: 0,
      whatsapp: 0,
      telegram: 0,
      imessage: 0,
      gmail: 0,
      calendar: 0,
    };
    buckets.set(weekStart, entry);
    series.push(entry);
  }

  const fourWeeksAgoMs = nowMs - 28 * 86_400_000;
  let recent4wCount = 0;

  for (const ev of pastEvents) {
    if (ev.ms >= fourWeeksAgoMs) recent4wCount += 1;
    const wStart = new Date(getMondayUtcMs(ev.ms)).toISOString().slice(0, 10);
    const bucket = buckets.get(wStart);
    if (bucket) {
      bucket[ev.channel] += 1;
      bucket.total += 1;
    }
  }

  const totalChannelEvents = Array.from(channelCounts.values()).reduce((s, n) => s + n, 0);
  const channel_breakdown: PersonProfileVisuals["channel_breakdown"] = Array.from(channelCounts.entries())
    .filter(([, count]) => count > 0)
    .map(([channel, count]) => ({
      channel,
      label: CHANNEL_LABELS[channel] || channel,
      count,
      pct: totalChannelEvents > 0 ? Math.round((count / totalChannelEvents) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel));

  const msgTotal = youCount + themCount;
  const reciprocity_ratio = {
    you_count: youCount,
    them_count: themCount,
    you_pct: msgTotal > 0 ? Math.round((youCount / msgTotal) * 100) : 50,
  };

  return { cadence_series: series, channel_breakdown, reciprocity_ratio, recent4wCount };
}

export interface LedgerMessageInput {
  channel: string;
  sender: string;
  direction?: string;
  occurred_at: string;
  text: string;
  is_group?: boolean;
}

export interface LedgerMeetingInput {
  title: string;
  start: string;
  is_upcoming?: boolean;
}

export interface BuildRelationshipLedgerOptions {
  name?: string;
  tier?: RelationshipTier;
  relationshipState?: string;
}

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const GROUP_OR_BOT_NAME_RE =
  /\b(group\s*help|circle|team\s*chat|group|community|traders|elites|district|channel|announcements?|network\s*spotlight|builders|tar\s*heels|classic|validators?|watcher[\s._-]*guru|just\s+in:|lookonchain|whale[\s._-]*alert|coindesk|cointelegraph|decrypt|the\s+block|news[\s._-]*bot|alerts?|year\s+\d+\b|nft\s*wg|factorydao|noreply|no-reply|mailer-daemon|notifications?|bot\b|automated|webhook)\b/i;

const BOT_MESSAGE_NOISE_RE =
  /press\s+the\s+button|verify\s+you\s+are\s+human|captcha|within\s+\d+\s+minutes|unsubscribe|do\s+not\s+reply|this\s+is\s+an\s+automated|verification\s+code|one-time\s+passcode|\botp\b/i;

const INBOUND_ASK_RE =
  /\?|\b(can you|could you|would you|will you|let me know|lmk|thoughts|what do you think|are you free|are you around|are you available|send me|share the|ping me|wdyt|any update|status on|do you have|have you had a chance|please review|can we)\b/i;

const OWNER_PROMISE_RE =
  /\b(i['’]?ll|i will|will send|let me|i['’]?m going to send|going to send|i can send|will follow up|i['’]?ll get back|will share|i['’]?ll check|i['’]?ll send|i['’]?ll share|i['’]?ll look into|i['’]?ll review|will circle back)\b/i;

export function isGroupOrBotContact(name: string, key = "", snippet = ""): boolean {
  const n = String(name || "").trim();
  const k = String(key || "").trim();
  const s = String(snippet || "").trim();
  if (!n && !k) return true;
  if (/(?:[^/]+\/){2,}/.test(n)) return true;
  if (GROUP_OR_BOT_NAME_RE.test(n) || GROUP_OR_BOT_NAME_RE.test(k)) return true;
  if (/\bbot$/i.test(n) || /_bot$/i.test(k) || /-bot$/i.test(k)) return true;
  if (s && BOT_MESSAGE_NOISE_RE.test(s) && /\b(help|group|wg|dao|bot|system)\b/i.test(n)) return true;
  return false;
}

export function isOutboundMessage(msg: { sender?: string; direction?: string }): boolean {
  const dir = String(msg.direction || "").trim();
  const sender = String(msg.sender || "").trim();
  if (dir === "You" || dir.toLowerCase() === "out" || dir.toLowerCase() === "outbound") return true;
  if (dir.toLowerCase() === "in" || dir.toLowerCase() === "inbound") return false;
  if (sender === "You" || sender.startsWith("You -> ")) return true;
  return /^(owner|you|me|self)$/i.test(sender);
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function formatAgeBrief(ageHours: number): string {
  if (ageHours < 1) return `${Math.max(1, Math.round(ageHours * 60))}m`;
  if (ageHours < 48) return `${Math.round(ageHours)}h`;
  return `${Math.round(ageHours / 24)}d`;
}

function normalizeLedgerChannel(raw: string): string {
  const ch = String(raw || "").trim().toLowerCase();
  if (!ch) return "direct";
  if (ch === "wa") return "whatsapp";
  if (ch === "tg") return "telegram";
  if (ch === "imsg" || ch === "sms" || ch === "messages") return "imessage";
  if (ch === "email" || ch === "mail") return "gmail";
  if (ch === "cal" || ch === "gcal") return "calendar";
  return ch;
}

function displayChannelName(ch: string): string {
  return CHANNEL_LABELS[ch] || ch;
}

export function buildRelationshipLedger(
  messages: LedgerMessageInput[],
  meetings: LedgerMeetingInput[],
  nowMs: number = Date.now(),
  opts: BuildRelationshipLedgerOptions = {}
): RelationshipLedger {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const anchorWeekStartMs = getMondayUtcMs(safeNowMs);
  const window52StartMs = anchorWeekStartMs - 51 * WEEK_MS;

  const weekMap = new Map<string, { weekStart: string; in: number; out: number; meetings: number; channelSet: Set<string> }>();
  const weekBuckets: Array<{ weekStart: string; in: number; out: number; meetings: number; channelSet: Set<string> }> = [];

  for (let i = 51; i >= 0; i--) {
    const wMs = anchorWeekStartMs - i * WEEK_MS;
    const weekStart = new Date(wMs).toISOString().slice(0, 10);
    const bucket = {
      weekStart,
      in: 0,
      out: 0,
      meetings: 0,
      channelSet: new Set<string>(),
    };
    weekMap.set(weekStart, bucket);
    weekBuckets.push(bucket);
  }

  interface ParsedMsg {
    ms: number;
    occurred_at: string;
    channel: string;
    outbound: boolean;
    text: string;
    is_group: boolean;
    is_bot_noise: boolean;
  }

  const pastMessages: ParsedMsg[] = [];
  const allTouchMs: number[] = [];
  const channelCounts52 = new Map<string, number>();

  for (const raw of messages || []) {
    if (!raw || !raw.occurred_at) continue;
    const ms = Date.parse(raw.occurred_at);
    if (!Number.isFinite(ms) || ms > safeNowMs) continue;
    const outbound = isOutboundMessage(raw);
    const channel = normalizeLedgerChannel(raw.channel);
    const text = stripEmDashesIntel(String(raw.text || "")).trim();
    const isGroup = Boolean(raw.is_group);
    const isBotNoise = !outbound && (BOT_MESSAGE_NOISE_RE.test(text) || isGroupOrBotContact(raw.sender || "", "", text));

    pastMessages.push({
      ms,
      occurred_at: raw.occurred_at,
      channel,
      outbound,
      text,
      is_group: isGroup,
      is_bot_noise: isBotNoise,
    });
    allTouchMs.push(ms);

    if (ms >= window52StartMs) {
      const wStart = new Date(getMondayUtcMs(ms)).toISOString().slice(0, 10);
      const bucket = weekMap.get(wStart);
      if (bucket) {
        if (outbound) bucket.out += 1;
        else bucket.in += 1;
        bucket.channelSet.add(channel);
        channelCounts52.set(channel, (channelCounts52.get(channel) || 0) + 1);
      }
    }
  }

  let nextUpcomingMeeting: { title: string; startMs: number } | null = null;
  for (const m of meetings || []) {
    if (!m || !m.start) continue;
    const ms = Date.parse(m.start);
    if (!Number.isFinite(ms)) continue;
    if (ms <= safeNowMs) {
      allTouchMs.push(ms);
      if (ms >= window52StartMs) {
        const wStart = new Date(getMondayUtcMs(ms)).toISOString().slice(0, 10);
        const bucket = weekMap.get(wStart);
        if (bucket) {
          bucket.meetings += 1;
          bucket.channelSet.add("calendar");
          channelCounts52.set("calendar", (channelCounts52.get("calendar") || 0) + 1);
        }
      }
    } else if (ms <= safeNowMs + 14 * DAY_MS) {
      if (!nextUpcomingMeeting || ms < nextUpcomingMeeting.startMs) {
        nextUpcomingMeeting = { title: stripEmDashesIntel(m.title || "Meeting").trim(), startMs: ms };
      }
    }
  }

  const weeks: RelationshipLedgerWeek[] = weekBuckets.map((b) => ({
    weekStart: b.weekStart,
    in: b.in,
    out: b.out,
    meetings: b.meetings,
    channels: Array.from(b.channelSet).sort(),
  }));

  // Sort touches chronologically and collapse same-session bursts (<12h apart) for true inter-contact cadence gaps
  allTouchMs.sort((a, b) => a - b);
  const sessionTimestamps: number[] = [];
  for (const ms of allTouchMs) {
    if (sessionTimestamps.length === 0 || ms - sessionTimestamps[sessionTimestamps.length - 1] >= 12 * HOUR_MS) {
      sessionTimestamps.push(ms);
    }
  }

  const latestTouchMs = allTouchMs.length > 0 ? allTouchMs[allTouchMs.length - 1] : 0;
  const current_gap_days = latestTouchMs > 0 ? round1(Math.max(0, (safeNowMs - latestTouchMs) / DAY_MS)) : 0;

  // Compute rolling 26-week inter-contact gaps (falling back to latest 26w active window or 52w if needed)
  const extractGaps = (timestamps: number[], fromMs: number): number[] => {
    const filtered = timestamps.filter((t) => t >= fromMs);
    const gaps: number[] = [];
    for (let i = 1; i < filtered.length; i++) {
      gaps.push((filtered[i] - filtered[i - 1]) / DAY_MS);
    }
    return gaps;
  };

  let gaps26w = extractGaps(sessionTimestamps, safeNowMs - 26 * WEEK_MS);
  if (gaps26w.length < 2 && latestTouchMs > 0) {
    gaps26w = extractGaps(sessionTimestamps, latestTouchMs - 26 * WEEK_MS);
  }
  if (gaps26w.length < 2) {
    gaps26w = extractGaps(sessionTimestamps, window52StartMs);
  }
  if (gaps26w.length < 2) {
    gaps26w = extractGaps(sessionTimestamps, 0);
  }

  let median_gap_days = 0;
  let drift_z = 0;
  if (gaps26w.length >= 2 && latestTouchMs > 0) {
    const rawMedian = computeMedian(gaps26w);
    const absDevs = gaps26w.map((g) => Math.abs(g - rawMedian));
    const mad = computeMedian(absDevs);
    const rawCurrentGap = Math.max(0, (safeNowMs - latestTouchMs) / DAY_MS);
    median_gap_days = round1(rawMedian);
    drift_z = round2((rawCurrentGap - rawMedian) / Math.max(2, mad));
  } else if (gaps26w.length === 1 && latestTouchMs > 0) {
    median_gap_days = round1(gaps26w[0]);
    drift_z = 0;
  }

  // 52-week reciprocity balance (0..1, where 1.0 = perfectly balanced 50/50)
  let in52 = 0;
  let out52 = 0;
  let meetings52 = 0;
  for (const w of weeks) {
    in52 += w.in;
    out52 += w.out;
    meetings52 += w.meetings;
  }
  const msgTotal52 = in52 + out52;
  const reciprocity_52w =
    msgTotal52 > 0 ? round2(Math.max(0, Math.min(1, 1 - Math.abs(out52 - in52) / msgTotal52))) : 0;

  // Initiation ratio: share of conversation bursts (>=6h gap) started by owner
  pastMessages.sort((a, b) => a.ms - b.ms);
  const directMessages = pastMessages.filter((m) => !m.is_group && !m.is_bot_noise);
  let totalBursts = 0;
  let ownerBursts = 0;
  let prevBurstMsgMs = -Infinity;
  for (const m of directMessages) {
    if (m.ms - prevBurstMsgMs >= 6 * HOUR_MS) {
      totalBursts += 1;
      if (m.outbound) ownerBursts += 1;
    }
    prevBurstMsgMs = m.ms;
  }
  const initiation_ratio = totalBursts > 0 ? round2(ownerBursts / totalBursts) : 0;

  // Streak of consecutive active weeks ending this week (51) or last week (50)
  const isWeekActive = (w: RelationshipLedgerWeek | undefined): boolean =>
    Boolean(w && w.in + w.out + w.meetings > 0);
  let streak_weeks = 0;
  let streakIdx = isWeekActive(weeks[51]) ? 51 : isWeekActive(weeks[50]) ? 50 : -1;
  while (streakIdx >= 0 && isWeekActive(weeks[streakIdx])) {
    streak_weeks += 1;
    streakIdx -= 1;
  }

  // Last inbound unanswered (1:1 human messages only)
  const latestDirectMsg = directMessages.length > 0 ? directMessages[directMessages.length - 1] : null;
  let lastOutboundMs = -Infinity;
  for (let i = directMessages.length - 1; i >= 0; i--) {
    if (directMessages[i].outbound) {
      lastOutboundMs = directMessages[i].ms;
      break;
    }
  }
  const last_inbound_unanswered = Boolean(latestDirectMsg && !latestDirectMsg.outbound);

  // Detect open loops both ways:
  // 1. Inbound asks with no later outbound reply
  // 2. Owner promises with no subsequent outbound follow-up after 72h
  const open_loops: OpenLoopItem[] = [];
  const loopCutoffMs = safeNowMs - 120 * DAY_MS;
  const recentDirect = directMessages.filter((m) => m.ms >= loopCutoffMs);

  for (let i = recentDirect.length - 1; i >= 0; i--) {
    const m = recentDirect[i];
    if (!m.text || m.text.length < 4) continue;
    const ageHours = round1(Math.max(0, (safeNowMs - m.ms) / HOUR_MS));

    if (!m.outbound) {
      if (m.ms > lastOutboundMs && INBOUND_ASK_RE.test(m.text)) {
        open_loops.push({
          kind: "inbound_ask",
          channel: m.channel,
          date: m.occurred_at,
          ageHours,
          excerpt: trimWordBoundary(m.text, 150),
        });
      }
    } else {
      const hasLaterOutbound = m.ms < lastOutboundMs;
      if (!hasLaterOutbound && ageHours >= 72 && OWNER_PROMISE_RE.test(m.text)) {
        open_loops.push({
          kind: "owner_promise",
          channel: m.channel,
          date: m.occurred_at,
          ageHours,
          excerpt: trimWordBoundary(m.text, 150),
        });
      }
    }
    if (open_loops.length >= 8) break;
  }

  // Determine top channel in last 52w
  const topChannels = Array.from(channelCounts52.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ch]) => displayChannelName(ch));
  const primaryChannel = topChannels[0] || "Direct";

  const firstInboundLoop = open_loops.find((l) => l.kind === "inbound_ask");
  const firstPromiseLoop = open_loops.find((l) => l.kind === "owner_promise");

  // Concrete next_touch recommendation (zero em-dashes)
  let next_touch = "No recent direct exchange recorded.";
  if (nextUpcomingMeeting && nextUpcomingMeeting.startMs - safeNowMs <= 48 * HOUR_MS) {
    const hrs = Math.max(1, Math.round((nextUpcomingMeeting.startMs - safeNowMs) / HOUR_MS));
    next_touch = `Prep for "${trimWordBoundary(nextUpcomingMeeting.title, 48)}" in ${formatAgeBrief(hrs)}.`;
  } else if (last_inbound_unanswered && firstInboundLoop) {
    next_touch = `Reply to open question on ${displayChannelName(firstInboundLoop.channel)} (waiting ${formatAgeBrief(firstInboundLoop.ageHours)}).`;
  } else if (last_inbound_unanswered && latestDirectMsg) {
    const waitHrs = Math.max(0.1, (safeNowMs - latestDirectMsg.ms) / HOUR_MS);
    next_touch = `Reply to last inbound message on ${displayChannelName(latestDirectMsg.channel)} (waiting ${formatAgeBrief(waitHrs)}).`;
  } else if (firstPromiseLoop) {
    next_touch = `Follow up on your open promise from ${formatAgeBrief(firstPromiseLoop.ageHours)} ago on ${displayChannelName(firstPromiseLoop.channel)}.`;
  } else if (drift_z > 2 && median_gap_days > 0) {
    next_touch = `Reconnect on ${primaryChannel}: ${current_gap_days}d silent vs ${median_gap_days}d median cadence.`;
  } else if (nextUpcomingMeeting) {
    const days = Math.max(1, Math.round((nextUpcomingMeeting.startMs - safeNowMs) / DAY_MS));
    next_touch = `Confirm agenda ahead of "${trimWordBoundary(nextUpcomingMeeting.title, 48)}" in ${days}d.`;
  } else if (streak_weeks >= 3) {
    next_touch = `Keep ${streak_weeks}-week cadence steady on ${primaryChannel}.`;
  } else if (msgTotal52 + meetings52 > 0) {
    next_touch = `Light check-in when relevant (${current_gap_days}d since last touch).`;
  }

  // 1 crisp editorial summary sentence (zero em-dashes)
  const recipPct = Math.round(reciprocity_52w * 100);
  const chanPhrase = topChannels.length > 1 ? `${topChannels[0]} and ${topChannels[1]}` : primaryChannel;
  let summary_sentence = "";

  if (msgTotal52 + meetings52 === 0 && latestTouchMs === 0) {
    summary_sentence = `No direct exchanges logged in the past 52 weeks${opts.tier ? ` (${opts.tier} tier)` : ""}.`;
  } else if (drift_z > 2 && median_gap_days > 0) {
    summary_sentence = `Normally connects every ${median_gap_days}d on ${chanPhrase}, now ${current_gap_days}d silent (drift z ${drift_z}) with ${recipPct}% reciprocity.`;
  } else if (last_inbound_unanswered && latestDirectMsg) {
    const waitHrs = Math.max(0.1, (safeNowMs - latestDirectMsg.ms) / HOUR_MS);
    const cadenceBit = streak_weeks >= 2 ? `${streak_weeks}-week streak` : `${msgTotal52} msgs in 52w`;
    summary_sentence = `${cadenceBit} across ${chanPhrase} (${recipPct}% balanced reciprocity), with an unanswered inbound message waiting ${formatAgeBrief(waitHrs)}.`;
  } else if (streak_weeks >= 2) {
    summary_sentence = `Active ${streak_weeks}-week streak across ${chanPhrase} (${msgTotal52} msgs, ${meetings52} meetings) at ${recipPct}% balanced reciprocity.`;
  } else if (median_gap_days > 0) {
    summary_sentence = `Connects roughly every ${median_gap_days}d on ${chanPhrase} (${msgTotal52} msgs in 52w, ${recipPct}% balanced reciprocity, last touch ${current_gap_days}d ago).`;
  } else {
    summary_sentence = `${msgTotal52} direct messages and ${meetings52} meetings over 52 weeks via ${chanPhrase}, last touch ${current_gap_days}d ago.`;
  }

  return {
    weeks,
    median_gap_days,
    current_gap_days,
    drift_z,
    reciprocity_52w,
    initiation_ratio,
    streak_weeks,
    last_inbound_unanswered,
    open_loops,
    next_touch: stripEmDashesIntel(next_touch),
    summary_sentence: stripEmDashesIntel(summary_sentence),
  };
}

export function computePersonProfileVisuals(input: ComputePersonProfileVisualsInput): PersonProfileVisuals {
  const wm = input.worldModel;
  const { cadence_series, channel_breakdown, reciprocity_ratio, recent4wCount } = buildCadenceAndChannels(input);
  const ledger = buildRelationshipLedger(input.timeline, input.meetings, input.nowMs ?? Date.now(), {
    name: input.name,
    tier: input.relationshipTier,
    relationshipState: input.relationshipState,
  });
  const contact_links = extractContactLinks(input);
  const ego_graph = extractEgoGraph(input);

  // Leverage & sentiment telemetry
  const our_count = wm.our_leverage.length;
  const their_count = wm.their_leverage.length;
  const levTotal = our_count + their_count;
  const our_pct = levTotal > 0 ? Math.round((our_count / levTotal) * 100) : 50;
  const their_pct = levTotal > 0 ? 100 - our_pct : 50;

  let sentiment_pos = 0;
  let sentiment_neu = 0;
  let sentiment_neg = 0;
  for (const item of wm.relationship_timeline) {
    if (item.sentiment === "positive") sentiment_pos += 1;
    else if (item.sentiment === "negative") sentiment_neg += 1;
    else sentiment_neu += 1;
  }

  const tierBaseTrust: Record<RelationshipTier, number> = {
    Family: 84,
    Core: 74,
    Active: 64,
    Warm: 56,
    Ambient: 46,
  };
  let trustScore = tierBaseTrust[input.relationshipTier] ?? 52;
  const stateLow = (input.relationshipState || "").toLowerCase();
  if (stateLow === "family") trustScore += 6;
  else if (stateLow === "core") trustScore += 4;
  else if (stateLow === "cooling") trustScore -= 10;
  else if (stateLow === "dormant") trustScore -= 8;
  else if (stateLow === "tense") trustScore -= 14;

  const sentPolar = sentiment_pos + sentiment_neg;
  if (sentPolar > 0) {
    trustScore += Math.round(((sentiment_pos - sentiment_neg) / sentPolar) * 12);
  }
  trustScore += Math.min(8, wm.trust_builders.length * 2) - Math.min(8, wm.degraders.length * 2);
  const totalMsgs = reciprocity_ratio.you_count + reciprocity_ratio.them_count;
  if (totalMsgs >= 4) {
    trustScore += Math.round((1 - Math.abs(reciprocity_ratio.you_pct - 50) / 50) * 6);
  }
  trustScore += Math.min(6, Math.round(Math.log2(input.messageCount + input.meetingCount + 1) * 1.2));

  const leverage_balance: PersonProfileVisuals["leverage_balance"] = {
    our_count,
    their_count,
    our_pct,
    their_pct,
    sentiment_pos,
    sentiment_neu,
    sentiment_neg,
    trust_score: clampInt(trustScore, 15, 98),
  };

  // Build searchable psychographic corpus
  const corpus = [
    input.role,
    input.org,
    wm.canonical_read,
    wm.operating_loop,
    ...wm.tastes_preferences,
    ...wm.philosophies_decision_model,
    ...wm.our_leverage,
    ...wm.their_leverage,
    ...wm.trust_builders,
    ...wm.degraders,
    ...wm.engagement_playbook,
    ...wm.why_they_matter,
    ...wm.current_read_bullets.slice(0, 16),
  ]
    .join(" ")
    .toLowerCase();

  // 6 Deterministic Psychographic & Behavioral Axes (18..98)
  const proofHits = countPatternHits(corpus, [
    /\bproof\b|\bfalsifi/,
    /\bbenchmark\b|\bmetric\b|\bdata\b/,
    /\bdemo\b|\bprototype\b|\bartifact\b/,
    /\bcode\b|\bcontract\b|\bworking\b/,
    /\binspectable\b|\bsources\b|\bevidence\b/,
    /\bship\b|\bverify\b|\brigor\b|\btest/,
    /\bsecurity\b|\bprivacy\b|\bcrypto/,
  ]);
  const proofScore = clampInt(
    36 + proofHits * 8 + Math.min(10, wm.evidence_table.length * 2 + wm.hypotheses.length * 2) + Math.min(8, Math.log2(input.claimCount + 1) * 1.1),
    18,
    98
  );

  const candorHits = countPatternHits(corpus, [
    /\bblunt\b|\bconfrontational\b/,
    /\bdirect\b|\bcandid\b|\bhonest\b/,
    /\bslop\b|\bno fluff\b|\bzero fluff\b/,
    /\bcritique\b|\bchallenge\b|\bpushback\b/,
    /\bfriction\b|\bcomplaint\b|\bstraight\b/,
    /\btransparent\b|\bpressure-test/,
  ]);
  const politeOffset = countPatternHits(corpus, [/\bformal\b|\bdiplomatic\b|\bcautious\b/]) * 5;
  const candorScore = clampInt(
    42 + candorHits * 9 - politeOffset + Math.min(6, wm.degraders.length * 2),
    18,
    98
  );

  const tempoHits = countPatternHits(corpus, [
    /\brapid\b|\bfast\b|\bvelocity\b/,
    /\bimmediate\b|\burgent\b|\bearly as possible\b/,
    /\biterate\b|\bship\b|\bsprint\b/,
    /\b2[-–]3am\b|\bdemanding\b|\bhigh-tempo\b/,
    /\bpersistent\b|\bmomentum\b|\bactive\b/,
  ]);
  const traj = (wm.velocity?.trajectory || "").toUpperCase();
  const trajBoost =
    traj === "ACCELERATING" || traj === "RISING"
      ? 14
      : traj === "STABLE" || traj === "ACTIVE"
        ? 8
        : traj === "COOLING" || traj === "DORMANT"
          ? -8
          : 0;
  const tempoScore = clampInt(
    34 +
      tempoHits * 8 +
      trajBoost +
      Math.min(14, Math.log2(recent4wCount + 1) * 3.5) +
      Math.min(10, Math.log2(input.messageCount + input.meetingCount + 1) * 1.4),
    18,
    98
  );

  const autonomyHits = countPatternHits(corpus, [
    /\bfounder\b|\bco-founder\b|\bceo\b|\bcto\b/,
    /\bsovereign\b|\bownership\b|\bindependent\b/,
    /\bboss\b|\bdecision\b|\bgo-ahead\b/,
    /\barchitect\b|\bbuilder\b|\btechnical lead\b/,
    /\bself-directed\b|\bowner\b|\blawyer\b/,
    /\bdecisive\b|\bcontrol\b|\bstrong opinions\b/,
  ]);
  const autonomyScore = clampInt(
    38 + autonomyHits * 9 + (input.relationshipTier === "Core" || input.relationshipTier === "Family" ? 8 : 0),
    18,
    98
  );

  const recipHits = countPatternHits(corpus, [
    /\breciprocal\b|\bmutual\b/,
    /\bpeer\b|\bcollaborat\b|\bco-builder\b/,
    /\btogether\b|\balternate\b|\bshared\b/,
    /\bsupport\b|\bintro\b|\bpartner\b/,
  ]);
  const balanceBonus = totalMsgs >= 4 ? Math.round((1 - Math.abs(reciprocity_ratio.you_pct - 50) / 50) * 26) : 10;
  const reciprocityScore = clampInt(
    30 + balanceBonus + recipHits * 8 + Math.min(12, input.collaborators.length * 1.5),
    18,
    98
  );

  const leverageHits = countPatternHits(corpus, [
    /\bblocker\b|\bchoke-point\b|\bgatekeeper\b/,
    /\bboss\b|\blaunch\b|\btoken timing\b/,
    /\bdependency\b|\bstall\b|\bgo-ahead\b/,
    /\bhousehold\b|\bfamily-critical\b|\binseparable\b/,
    /\binvestor\b|\bfundrais\b|\bpartner\b|\bmoat\b/,
    /\bleverage\b|\bstrategic\b|\bcentral\b/,
  ]);
  const tierLevBoost =
    input.relationshipTier === "Core"
      ? 22
      : input.relationshipTier === "Family"
        ? 20
        : input.relationshipTier === "Active"
          ? 12
          : input.relationshipTier === "Warm"
            ? 6
            : 0;
  const leverageScore = clampInt(
    26 +
      tierLevBoost +
      leverageHits * 7 +
      Math.min(14, (our_count + their_count) * 2) +
      Math.min(8, Math.log2(input.claimCount + input.meetingCount + 1) * 1.1),
    18,
    98
  );

  const firstName = stripEmDashesIntel(input.name).split(/\s+/)[0] || input.name;
  const axes: PersonProfileVisuals["axes"] = [
    {
      key: "proof",
      label: "Proof",
      score: proofScore,
      evidence:
        wm.evidence_table.length > 0
          ? `${wm.evidence_table.length} structured evidence signals & ${input.claimCount.toLocaleString("en-US")} claims`
          : `${proofHits} artifact/proof signals across ${input.claimCount.toLocaleString("en-US")} claims`,
    },
    {
      key: "candor",
      label: "Candor",
      score: candorScore,
      evidence:
        candorHits >= 2
          ? "Direct, low-fluff communication register noted in dossier"
          : wm.tastes_preferences.length > 0
            ? cleanLineText(wm.tastes_preferences[0], 78)
            : "Standard conversational register from observed threads",
    },
    {
      key: "tempo",
      label: "Tempo",
      score: tempoScore,
      evidence: `${traj ? `Trajectory ${traj}; ` : ""}${input.messageCount.toLocaleString("en-US")} msgs & ${input.meetingCount} meetings`,
    },
    {
      key: "autonomy",
      label: "Autonomy",
      score: autonomyScore,
      evidence:
        input.role
          ? cleanLineText(`Role: ${input.role}`, 78)
          : `${autonomyHits} ownership & independent-decision markers`,
    },
    {
      key: "reciprocity",
      label: "Reciprocity",
      score: reciprocityScore,
      evidence:
        totalMsgs >= 2
          ? `${reciprocity_ratio.you_pct}% You / ${100 - reciprocity_ratio.you_pct}% ${firstName} across ${totalMsgs} indexed msgs`
          : `${input.collaborators.length} shared network links & ${recipHits} mutual-value markers`,
    },
    {
      key: "leverage",
      label: "Leverage",
      score: leverageScore,
      evidence: `${our_count} our-edge / ${their_count} their-edge levers (${input.relationshipTier} tier)`,
    },
  ];

  // Deterministic Archetype synthesis grounded in real world_model signals
  let title = "Ambient Signal";
  let tagline = "Live vault contact awaiting deeper world-model synthesis.";
  let operating_mode = "Intermittent cross-channel touchpoint";
  let comms_register = "Concise, context-dependent";
  let decision_trigger = "Clear next action & concrete context";
  let blind_spot = "Thin behavioral history; verify assumptions directly";

  const isSpouseOrHousehold =
    input.relationshipTier === "Family" &&
    /\b(wife|husband|partner|household|school runs|kids)\b/i.test(corpus);
  const isFamilyOther = input.relationshipTier === "Family" && !isSpouseOrHousehold;
  const isGatekeeper =
    /\b(boss|go-ahead|choke-point|blocker|token timing|launch dependencies)\b/i.test(corpus) ||
    wm.their_leverage.some((s) => /\b(blocker|stall|go-ahead|unavailable|unresponsive)\b/i.test(s));
  const isTangibleBuilder =
    /\b(tangible-systems|interface-mediated|creative developer|embodied computing|inspectable)\b/i.test(corpus);
  const isProofFounder =
    /\b(founder|co-founder|ceo|cto)\b/i.test(`${input.role} ${wm.canonical_read}`) &&
    (proofScore >= 65 || /\b(demo|artifact|prototype|builder|ship)\b/i.test(corpus));
  const isEcosystemArch = /\b(ecosystem|validator|protocol|fundrais|investor|gtm|partner|bd)\b/i.test(
    `${input.role} ${wm.canonical_read}`
  );
  const isTechOperator = /\b(engineer|developer|infra|security|systems|protocol|ai|agent|crypto|technical)\b/i.test(
    `${input.role} ${wm.canonical_read}`
  );

  if (isSpouseOrHousehold) {
    title = "Household Anchor";
    tagline = "Core partner governing family logistics, home rhythm, and shared life decisions.";
    operating_mode = "Co-pilot of household logistics, school runs, and family planning";
    comms_register = "High-bandwidth, load-sensitive, low-overhead";
    decision_trigger = "Reduced coordination friction & reliable follow-through";
    blind_spot = "Coordination overhead during peak late-night work weeks";
  } else if (isFamilyOther) {
    title = "Family Core";
    tagline = "Close family tie anchored in personal care, milestones, and household support.";
    operating_mode = "Personal family rhythm & milestone coordination";
    comms_register = "Warm, direct, personal";
    decision_trigger = "Presence, clarity, and timely family logistics";
    blind_spot = "Work-schedule drift crowding out family planning";
  } else if (isTangibleBuilder) {
    title = "Tangible-Systems Builder";
    tagline = "Turns hidden crypto, AI, and data infrastructure into inspectable, user-owned interfaces.";
    operating_mode = "Interface-mediated trust & rapid cross-stack prototyping";
    comms_register = "Curious, technical, source-checking peer";
    decision_trigger = "Inspectable systems, provenance, and real demos";
    blind_spot = "Parallelism across too many competing build lanes";
  } else if (isGatekeeper) {
    title = "Strategic Gatekeeper";
    tagline = "High-leverage decision node across launch timing, narrative, and dependency clearing.";
    operating_mode = "Option generator & launch decision choke-point";
    comms_register = "Direct, candid, zero fluff";
    decision_trigger = "Readiness proof, crisp options, and zero AI slop";
    blind_spot = "Bottleneck concentration when unavailable or heads-down";
  } else if (isProofFounder) {
    title = "Proof-Driven Founder";
    tagline = "Ships working technical artifacts first and compounds trust through execution velocity.";
    operating_mode = "Rapid technical absorption into live demos & integrations";
    comms_register = "Direct, builder-to-builder, benchmark-led";
    decision_trigger = "Working demo, benchmark proof, and single clear wedge";
    blind_spot = "Broad technical exploration competing with one fundable wedge";
  } else if (isEcosystemArch) {
    title = "Ecosystem Architect";
    tagline = "Connects protocol strategy, partner routing, and builder growth across workstreams.";
    operating_mode = "Partner network routing & strategic positioning";
    comms_register = "High-signal, outcome-oriented";
    decision_trigger = "Aligned incentives & credible execution path";
    blind_spot = "Signal dilution across overlapping partner threads";
  } else if (isTechOperator) {
    title = "Technical Operator";
    tagline = "Execution-focused builder clearing engineering dependencies across shared stacks.";
    operating_mode = "Hands-on implementation & systems debugging";
    comms_register = "Concise, concrete, artifact-first";
    decision_trigger = "Reproducible specs & clean technical tradeoffs";
    blind_spot = "Silent scope creep without explicit closure checkpoints";
  } else if (input.relationshipTier === "Warm" || input.relationshipTier === "Active") {
    title = "Reciprocal Collaborator";
    tagline = "Active counterparty with recurring cross-channel touchpoints and shared context.";
    operating_mode = "Periodic syncs & mutual context exchange";
    comms_register = "Direct and collaborative";
    decision_trigger = "Clear mutual upside & concrete next step";
    blind_spot = "Long gaps between touchpoints letting threads cool";
  } else if (input.messageCount >= 10) {
    title = "Active Correspondent";
    tagline = "Recurring live messaging contact ready for structured world-model profiling.";
  }

  // Refine tagline/fields directly from observed worldModel bullets when richer evidence exists
  if (wm.canonical_read && !wm.canonical_read.startsWith("Unprofiled")) {
    const firstSentence = wm.canonical_read.split(/(?<=[.!?])\s+/)[0] || wm.canonical_read;
    if (firstSentence.length >= 28) {
      tagline = cleanLineText(firstSentence, 220);
    }
  }
  operating_mode = cleanLineText(operating_mode, 220);
  if (wm.philosophies_decision_model.length > 0) {
    decision_trigger = cleanLineText(wm.philosophies_decision_model[0], 220);
  }
  if (wm.tastes_preferences.length > 0 && !wm.tastes_preferences[0].startsWith("Workstream focus:")) {
    comms_register = cleanLineText(wm.tastes_preferences[0], 220);
  }
  if (wm.degraders.length > 0) {
    blind_spot = cleanLineText(wm.degraders[0], 220);
  } else if (wm.their_leverage.length > 0) {
    blind_spot = cleanLineText(wm.their_leverage[0], 220);
  }

  const basis_note = `Inferred from ${input.messageCount.toLocaleString("en-US")} messages, ${input.claimCount.toLocaleString("en-US")} claims, ${input.meetingCount.toLocaleString("en-US")} meetings (Falsifiable)`;

  return {
    archetype: {
      title,
      tagline,
      operating_mode,
      comms_register,
      decision_trigger,
      blind_spot,
      basis_note,
    },
    axes,
    leverage_balance,
    cadence_series,
    channel_breakdown,
    reciprocity_ratio,
    contact_links,
    ego_graph,
    ledger,
  };
}
