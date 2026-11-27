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
import { basename, dirname, join } from "node:path";
import { BadRequestError, NotFoundError } from "./vault-api.ts";

export type TasteDomainId =
  | "ui_product"
  | "typography_copy"
  | "visual_brand"
  | "motion_feel"
  | "video_anime"
  | "merch_objects"
  | "spaces_life"
  | "agent_ops";

export type TasteOptionKey = "A" | "B" | "C" | "D";
export type TastePreviewKind = "swatch" | "type" | "copy" | "layout" | "motion";
export type TasteRulePolarity = "prefer" | "avoid";
export type TasteRuleSource = "baseline" | "derived" | "custom";

export interface TasteDomainDef {
  id: TasteDomainId;
  label: string;
  description: string;
  thin_in_profile: boolean;
}

export interface TasteOptionPreview {
  kind: TastePreviewKind;
  tokens?: string[];
  sample_head?: string;
  sample_body?: string;
  badge?: string;
}

export interface TasteQuestionOption {
  key: TasteOptionKey;
  label: string;
  rationale: string;
  trait_tag: string;
  signal_value: number;
  preview?: TasteOptionPreview;
}

export interface TasteQuestion {
  id: string;
  domain: TasteDomainId;
  title: string;
  context: string;
  axis: string;
  options: TasteQuestionOption[];
  source: "curated" | "ai_adaptive";
  priority: number;
  created_at: string;
}

export interface TasteAnswerRecord {
  question_id: string;
  domain: TasteDomainId;
  axis: string;
  chosen_key: TasteOptionKey;
  chosen_label: string;
  trait_tag: string;
  signal_value: number;
  note?: string;
  answered_at: string;
}

export interface TasteAnswerHistoryItem extends TasteAnswerRecord {
  question_title: string;
  question_context: string;
}

export interface TasteCustomRule {
  id: string;
  domain: TasteDomainId;
  polarity: TasteRulePolarity;
  rule: string;
  reason?: string;
  created_at: string;
}

export interface TasteCrosslinkRef {
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

export interface TasteRule {
  id: string;
  domain: TasteDomainId;
  polarity: TasteRulePolarity;
  rule: string;
  reason?: string;
  source: TasteRuleSource;
  editable: boolean;
  created_at: string;
  question_id?: string;
  vault_doc_path?: string;
  links?: TasteCrosslinkRef[];
}

export interface TasteVaultDoc {
  id: string;
  title: string;
  domain: TasteDomainId;
  category: "exemplar" | "anti_example" | "doctrine" | "anti_pattern" | "reference";
  polarity: "prefer" | "avoid" | "neutral";
  medium: string;
  brand: string;
  summary: string;
  source_path: string;
  vault_doc_path?: string;
  updated_at: string;
}

export interface TasteDomainSummary {
  id: TasteDomainId;
  label: string;
  description: string;
  answered: number;
  total: number;
  pct: number;
  signature_traits: string[];
  recent_verdicts: string[];
}

export interface TasteStats {
  total_questions: number;
  answered_count: number;
  remaining_count: number;
  skipped_count: number;
  custom_rules_count: number;
  vault_docs_count: number;
  calibration_pct: number;
  streak_count: number;
}

export interface TasteStateResponse {
  stats: TasteStats;
  domains: TasteDomainSummary[];
  queue: TasteQuestion[];
  answered_history: TasteAnswerHistoryItem[];
  rules: {
    prefer: TasteRule[];
    avoid: TasteRule[];
  };
  vault_docs: TasteVaultDoc[];
  compiled_codex_path: "world/taste-codex.md";
}

export interface TasteProfileStore {
  version: 1;
  updated_at: string;
  answers: TasteAnswerRecord[];
  skipped_ids: string[];
  custom_rules: TasteCustomRule[];
  dynamic_questions: TasteQuestion[];
}

export interface TasteApiConfig {
  vaultPath?: string;
  lifeOsWikiPath?: string | null;
  gardenPath?: string | null;
}

export interface SubmitAnswerRequest {
  question_id: string;
  chosen_key: string;
  note?: string;
}

export interface SubmitAnswerResponse {
  ok: true;
  answer: TasteAnswerRecord;
  next_question: TasteQuestion | null;
  state: TasteStateResponse;
}

export interface SkipQuestionResponse {
  ok: true;
  skipped_id: string;
  next_question: TasteQuestion | null;
  state: TasteStateResponse;
}

export interface UndoAnswerResponse {
  ok: true;
  undone: TasteAnswerRecord | null;
  state: TasteStateResponse;
}

export interface UpsertRuleRequest {
  id?: string;
  domain: string;
  polarity: string;
  rule: string;
  reason?: string;
}

export interface UpsertRuleResponse {
  ok: true;
  rule: TasteCustomRule;
  state: TasteStateResponse;
}

export interface DeleteRuleResponse {
  ok: true;
  deleted_id: string;
  state: TasteStateResponse;
}

export interface GenerateQuestionsPrompt {
  system: string;
  user: string;
  promptForCoherence: string;
  target_domain: TasteDomainId | "adaptive";
}

export interface IngestGeneratedQuestionsResponse {
  added: TasteQuestion[];
  count: number;
  skipped_duplicates: number;
  state: TasteStateResponse;
}

export const DEFAULT_TASTE_VAULT_PATH =
  process.env.KIZUKI_VAULT || process.env.KIZUKI_VAULT_PATH || join(homedir(), "Kizuki");
export const DEFAULT_TASTE_WIKI_PATH =
  process.env.KIZUKI_LIFEOS_WIKI_PATH || join(DEFAULT_TASTE_VAULT_PATH, "wiki");
export const DEFAULT_TASTE_GARDEN_PATH =
  process.env.KIZUKI_GARDEN_PATH || join(homedir(), ".local", "share", "garden", "knowledge");

export const TASTE_DOMAINS: readonly TasteDomainDef[] = [
  {
    id: "ui_product",
    label: "UI & Product Craft",
    description: "Density, surfaces, borders, light/dark polarity, tables, and live dashboards.",
    thin_in_profile: false,
  },
  {
    id: "typography_copy",
    label: "Typography & Copy Voice",
    description: "Headline tension, font pairings, brevity, public X rhythm, and banned corpse words.",
    thin_in_profile: false,
  },
  {
    id: "visual_brand",
    label: "Visual & Brand Direction",
    description: "Editorial grids, Swiss restraint, luxury vs brutalist texture, and color restraint.",
    thin_in_profile: false,
  },
  {
    id: "motion_feel",
    label: "Motion & Interaction",
    description: "Spring speed, crisp utility vs cinematic choreography, and tactile signatures.",
    thin_in_profile: false,
  },
  {
    id: "video_anime",
    label: "Film, Video & Anime",
    description: "Editorial cinema craft, anime satsuei 2s/3s over 1s worlds, color grading, and sound rhythm.",
    thin_in_profile: false,
  },
  {
    id: "merch_objects",
    label: "Personal Style, Merch & Objects",
    description: "Apparel silhouettes, VIP packaging, everyday hardware, desk gear, and personal gifts.",
    thin_in_profile: true,
  },
  {
    id: "spaces_life",
    label: "Spaces, Travel & Experiences",
    description: "City evenings out, theatre, hotels, dining, and step-free luxury family trips.",
    thin_in_profile: true,
  },
  {
    id: "agent_ops",
    label: "Agent Behavior & Reasoning",
    description: "Compression, bluntness, autonomy, decision framing, and output shape across all agents.",
    thin_in_profile: false,
  },
] as const;

const DOMAIN_MAP = new Map<TasteDomainId, TasteDomainDef>(TASTE_DOMAINS.map((d) => [d.id, d]));
const VALID_DOMAIN_IDS = new Set<TasteDomainId>(TASTE_DOMAINS.map((d) => d.id));
const VALID_OPTION_KEYS: readonly TasteOptionKey[] = ["A", "B", "C", "D"];
const VALID_PREVIEW_KINDS = new Set<TastePreviewKind>(["swatch", "type", "copy", "layout", "motion"]);

const CURATED_TIMESTAMP = "2026-11-26T00:00:00.000Z";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const SECRET_TOKEN_RE =
  /\b(?:s[k]-[a-zA-Z0-9_-]{16,}|g[h]p_[a-zA-Z0-9]{20,}|x[o]x[baprs]-[a-zA-Z0-9-]{10,}|AI[z]a[0-9A-Za-z_-]{20,}|A[K]IA[0-9A-Z]{16})\b/g;
const OAUTH_QUERY_RE =
  /https?:\/\/[^\s)]*(?:oauth|authorize|access_token|client_secret|refresh_token)[^\s)]*/gi;
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

export function sanitizeTasteText(input: string): string {
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
  const clean = sanitizeTasteText(input);
  if (clean.length <= maxLen) return clean;
  const cut = clean.slice(0, maxLen - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut).trim() + "...";
}

function slugify(input: string): string {
  return (
    sanitizeTasteText(input)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

function normalizeDedupKey(input: string): string {
  return sanitizeTasteText(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
      // ignore cleanup failure
    }
    throw err;
  }
}

export function isTasteDomainId(value: string): value is TasteDomainId {
  return VALID_DOMAIN_IDS.has(value as TasteDomainId);
}

export const CURATED_TASTE_QUESTIONS: readonly TasteQuestion[] = [
  // =========================================================================
  // 1. UI & PRODUCT CRAFT (4)
  // =========================================================================
  {
    id: "q_ui_consumer_polarity",
    domain: "ui_product",
    title: "Where should consumer finance apps sit on light versus dark?",
    context: "Designing an Encrypt send flow or Nob checkout where user trust and action speed decide conversion.",
    axis: "Surface Polarity",
    source: "curated",
    priority: 90,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Warm Daylight Utility",
        rationale: "Revolut and Robinhood trust: warm off-white surfaces, crisp black ink, deep violet privacy accent.",
        trait_tag: "daylight-consumer-trust",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#F7F6F2", "#111113", "#5B21B6", "#16A34A"],
          sample_head: "Send $4,200 privately",
          sample_body: "Route masked. Exposure low. Zero mempool leak.",
          badge: "Daylight",
        },
      },
      {
        key: "B",
        label: "Midnight Vault Terminal",
        rationale: "Black glass, bone white ink, razor dividers, and deep violet accents built like a villain bank.",
        trait_tag: "midnight-vault-terminal",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#09090D", "#F1EFF7", "#7C3AED", "#E11D48"],
          sample_head: "INTENT VEIL ACTIVE",
          sample_body: "Counterparty visibility delayed. Private relay locked.",
          badge: "Midnight",
        },
      },
      {
        key: "C",
        label: "Split Mode by Job",
        rationale: "Warm daylight for consumer flows and onboarding; dark obsidian exclusively for pro trading desks.",
        trait_tag: "context-split-polarity",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#F5F4EF", "#0B0D12", "#4C1D95", "#0EA5E9"],
          sample_head: "Light to pay, dark to trade",
          sample_body: "Match polarity to user mental mode, not habit.",
          badge: "Hybrid",
        },
      },
      {
        key: "D",
        label: "Warm Stone Editorial",
        rationale: "Uncoated paper cream, deep charcoal ink, and vermilion exception states with luxury calm.",
        trait_tag: "editorial-stone-surface",
        signal_value: 0,
        preview: {
          kind: "swatch",
          tokens: ["#EFECE5", "#191715", "#B91C1C", "#292524"],
          sample_head: "Review private transfer",
          sample_body: "Calm ledger paper; red appears only for real risk.",
          badge: "Editorial",
        },
      },
    ],
  },
  {
    id: "q_ui_density_vs_air",
    domain: "ui_product",
    title: "How dense should Kizuki and live trading screens feel on load?",
    context: "Opening Kizuki Mind OS or a live market operator desk on a 1440px laptop display.",
    axis: "Density vs Air",
    source: "curated",
    priority: 88,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Dense Linear Cockpit",
        rationale: "Tight 32px rows, keyboard-first chrome, visible metrics on load, zero wasted hero banners.",
        trait_tag: "linear-dense-chrome",
        signal_value: 2,
        preview: {
          kind: "layout",
          tokens: ["32px rows", "1px hairlines", "240px rail", "cmd+k"],
          sample_head: "Working UI on pixel 1",
          sample_body: "Live queue, metrics, and shortcuts visible above fold.",
          badge: "High Signal",
        },
      },
      {
        key: "B",
        label: "Bloomberg Wall-to-Wall",
        rationale: "Maximum telemetry per pixel: multi-pane live tapes, orderbooks, and zero dead margin.",
        trait_tag: "bloomberg-max-density",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["4-pane grid", "11px mono", "0px waste", "live tape"],
          sample_head: "Full-bleed war room",
          sample_body: "Every corner carries live state, fills, and alerts.",
          badge: "Terminal",
        },
      },
      {
        key: "C",
        label: "Editorial Focus + Drawer",
        rationale: "Generous breathing room on the primary canvas; dense inspection lives in a slide-over drawer.",
        trait_tag: "editorial-focus-drawer",
        signal_value: -1,
        preview: {
          kind: "layout",
          tokens: ["680px center", "slide inspector", "48px margins"],
          sample_head: "One focal object at a time",
          sample_body: "Keep secondary telemetry tucked until summoned.",
          badge: "Focused",
        },
      },
      {
        key: "D",
        label: "Single-Decision Card",
        rationale: "Strip the screen down to one card, one metric, and one primary action per viewport.",
        trait_tag: "one-decision-canvas",
        signal_value: -2,
        preview: {
          kind: "layout",
          tokens: ["1 card", "1 primary CTA", "high air"],
          sample_head: "Zero ambient distraction",
          sample_body: "Best for rapid approval flows and mobile review.",
          badge: "Minimal",
        },
      },
    ],
  },
  {
    id: "q_ui_border_elevation",
    domain: "ui_product",
    title: "How should panels and cards separate from the background canvas?",
    context: "Defining the elevation grammar for Kizuki modules, review sheets, and operator tables.",
    axis: "Surface Framing",
    source: "curated",
    priority: 82,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Razor 1px Hairline Grid",
        rationale: "Crisp hairline structural borders with zero drop-shadow mud; architectural and exact.",
        trait_tag: "razor-hairline-grid",
        signal_value: 2,
        preview: {
          kind: "layout",
          tokens: ["1px solid", "0px shadow", "4px radius", "engraved rules"],
          sample_head: "Architectural precision",
          sample_body: "Every divider earns its place like a Swiss instrument.",
          badge: "Hairline",
        },
      },
      {
        key: "B",
        label: "Tonal Step Without Strokes",
        rationale: "Subtle 3% luminance steps between canvas, rail, and card with almost invisible seams.",
        trait_tag: "tonal-step-elevation",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#F4F3EF", "#ECEAE4", "#FFFFFF", "#171717"],
          sample_head: "Quiet layered paper",
          sample_body: "Separation via tone alone; zero visual cage lines.",
          badge: "Tonal",
        },
      },
      {
        key: "C",
        label: "Engraved Rim + Specular Top",
        rationale: "Dark smoked surface with a 1px top highlight edge that feels machined from glass or metal.",
        trait_tag: "machined-specular-rim",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#0C0D12", "#151720", "#2A2E3F", "#94A3B8"],
          sample_head: "Machined hardware feel",
          sample_body: "Top bevel catches light without generic neon bloom.",
          badge: "Machined",
        },
      },
      {
        key: "D",
        label: "Hard Ink Swiss Rules",
        rationale: "High-contrast 1.5px black rules, sharp 0px corners, and zero soft gradients.",
        trait_tag: "brutalist-swiss-rules",
        signal_value: -2,
        preview: {
          kind: "layout",
          tokens: ["1.5px #111", "0px radius", "hard grid"],
          sample_head: "Unapologetic print ledger",
          sample_body: "Zero softness; looks like a customs manifest or gallery catalog.",
          badge: "Swiss",
        },
      },
    ],
  },
  {
    id: "q_ui_exception_voice",
    domain: "ui_product",
    title: "How should high-stakes transaction warnings speak in the UI?",
    context: "Encrypt spots a Solana route that leaks mempool intent right before the user clicks Execute.",
    axis: "Exception Feedback",
    source: "curated",
    priority: 84,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Consequential Refusal",
        rationale: "Name the exact threat and block silently-bad routes with teeth, not polite boilerplate.",
        trait_tag: "consequential-ui-warnings",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Execution refused.",
          sample_body: "This route leaks intent to mempool bots before fill. Switch to masked relay.",
          badge: "Sharp",
        },
      },
      {
        key: "B",
        label: "Calm Risk Review Sheet",
        rationale: "Consumer-clear side-by-side comparison showing exposure level and one-tap fix.",
        trait_tag: "calm-consumer-risk-sheet",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "High route exposure",
          sample_body: "Standard route exposes size publicly. Tap Masked Route to hide intent (+0.02% fee).",
          badge: "Revolut Bar",
        },
      },
      {
        key: "C",
        label: "Compact Telemetry Readout",
        rationale: "Zero prose: structured status pills showing exact exposure vector and override key.",
        trait_tag: "telemetry-status-pills",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "EXPOSURE: HIGH | VECTOR: MEMPOOL",
          sample_body: "MODE: PUBLIC -> SWITCH: PRIVATE_RELAY [ENTER]",
          badge: "Terminal",
        },
      },
      {
        key: "D",
        label: "Soft Guided Recovery",
        rationale: "Gentle reassurance explaining what happened and walking the user through next steps.",
        trait_tag: "soft-guided-warning",
        signal_value: -2,
        preview: {
          kind: "copy",
          sample_head: "Heads up before you send",
          sample_body: "We noticed a privacy setting you might want to adjust so your transfer stays safe.",
          badge: "Soft",
        },
      },
    ],
  },

  // =========================================================================
  // 2. TYPOGRAPHY & COPY VOICE (4)
  // =========================================================================
  {
    id: "q_type_display_voice",
    domain: "typography_copy",
    title: "Which display typeface carries the sharpest authority for launches?",
    context: "Choosing the H1 display voice for a flagship product or studio page.",
    axis: "Display Typeface Character",
    source: "curated",
    priority: 89,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Knife-Edged Editorial Serif",
        rationale: "GT Sectra or Editorial New: sharp wedge serifs with luxury cinema and print gravitas.",
        trait_tag: "editorial-knife-serif",
        signal_value: 2,
        preview: {
          kind: "type",
          tokens: ["GT Sectra Display", "Sohne Body", "-0.03em tracking"],
          sample_head: "Move without asking the room.",
          sample_body: "High-contrast serif display paired with restrained neo-grotesk body.",
          badge: "Editorial Serif",
        },
      },
      {
        key: "B",
        label: "Swiss Neo-Grotesk Display",
        rationale: "Neue Haas Grotesk Display or ABC Diatype: tight, architectural, impossible to look dated.",
        trait_tag: "swiss-neo-grotesk",
        signal_value: 1,
        preview: {
          kind: "type",
          tokens: ["Neue Haas Display", "ABC Diatype", "-0.04em tracking"],
          sample_head: "Private execution for Solana.",
          sample_body: "Precision Swiss scale with zero ornament and tight line-height.",
          badge: "Swiss Grotesk",
        },
      },
      {
        key: "C",
        label: "Technical Mono + Grotesk",
        rationale: "JetBrains/Berkeley Mono anchors for metadata and tension, grotesk for punch headlines.",
        trait_tag: "technical-mono-hybrid",
        signal_value: -1,
        preview: {
          kind: "type",
          tokens: ["Berkeley Mono", "ABC Diatype", "uppercase micro-labels"],
          sample_head: "01 // ZERO PRE-TRADE LEAKAGE",
          sample_body: "Instrument-panel discipline built for engineers and traders.",
          badge: "Tech Hybrid",
        },
      },
      {
        key: "D",
        label: "Condensed Film Poster Display",
        rationale: "Tall compressed uppercase display inspired by A24 posters and Japanese anime title cards.",
        trait_tag: "condensed-cinema-poster",
        signal_value: -2,
        preview: {
          kind: "type",
          tokens: ["Druk Condensed", "1.02 leading", "all-caps"],
          sample_head: "THE INTENT BEFORE THE TRADE",
          sample_body: "Unmistakable poster drama built for trailers and hero reveals.",
          badge: "Cinema Poster",
        },
      },
    ],
  },
  {
    id: "q_type_copy_edge",
    domain: "typography_copy",
    title: "Which hero headline wedge wins for Encrypt on frame one?",
    context: "First eight words a serious Solana trader reads before deciding if Encrypt is real or vaporware.",
    axis: "Copy Edge & Enemy",
    source: "curated",
    priority: 91,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Name the Predator",
        rationale: "Put the enemy and the concrete wound in the very first sentence; zero throat-clearing.",
        trait_tag: "enemy-first-copy",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Public execution made traders prey.",
          sample_body: "Encrypt hides your order intent before mempool predators can feed.",
          badge: "Enemy First",
        },
      },
      {
        key: "B",
        label: "Villain-Luxury Aphorism",
        rationale: "Short, quotable line worth stealing that frames privacy as power rather than compliance.",
        trait_tag: "aphorism-power-copy",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "Move size without asking the room.",
          sample_body: "Confidential capital markets on Solana. No leaked routes.",
          badge: "Stealable Line",
        },
      },
      {
        key: "C",
        label: "Cold Mechanic Proof",
        rationale: "Zero metaphor; state the exact technical guarantee in plain, falsifiable engineering English.",
        trait_tag: "cold-mechanic-copy",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "Encrypted order routing on Solana.",
          sample_body: "Composable confidential state with sub-second private settlement.",
          badge: "Pure Mechanic",
        },
      },
      {
        key: "D",
        label: "Category Manifesto",
        rationale: "Broad market thesis positioning the company as the inevitable new layer for capital.",
        trait_tag: "category-manifesto-copy",
        signal_value: -2,
        preview: {
          kind: "copy",
          sample_head: "The private layer for on-chain markets.",
          sample_body: "Bringing institutional confidentiality to every Solana protocol.",
          badge: "Category",
        },
      },
    ],
  },
  {
    id: "q_type_x_post_rhythm",
    domain: "typography_copy",
    title: "What post structure hits hardest on your public X account?",
    context: "Shipping a hot take on systems architecture, protocol design, or AI operator harnesses.",
    axis: "Public X Cadence",
    source: "curated",
    priority: 85,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Two-Beat Thesis + Kill Shot",
        rationale: "One sharp setup sentence, blank line, one undeniable closer. Zero thread bloat.",
        trait_tag: "two-beat-killshot",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Public chains solved settlement.",
          sample_body: "They also turned every size trade into free alpha for predators.",
          badge: "2-Beat",
        },
      },
      {
        key: "B",
        label: "Artifact + Dry 1-Line Verdict",
        rationale: "Drop a live clip or screenshot that proves the point and add one understated line.",
        trait_tag: "artifact-plus-one-liner",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "[Live video demo attached]",
          sample_body: "Stopped arguing about bridges and made chains programmable natively.",
          badge: "Proof First",
        },
      },
      {
        key: "C",
        label: "3-Bullet Concrete Teardown",
        rationale: "Name three hard numbers or structural flaws that nobody else is saying out loud.",
        trait_tag: "three-bullet-teardown",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "Why 90% of crypto UX still loses:",
          sample_body: "1. Exposes intent. 2. Explains cryptography. 3. Hides real risk.",
          badge: "Teardown",
        },
      },
      {
        key: "D",
        label: "Single-Breath Aphorism",
        rationale: "Under 12 words, meme-native, quotable, zero explanation or follow-up reply.",
        trait_tag: "single-breath-wedge",
        signal_value: 0,
        preview: {
          kind: "copy",
          sample_head: "Specificity beats polish.",
          sample_body: "If your homepage uses 'seamless', start over.",
          badge: "Wedge",
        },
      },
    ],
  },
  {
    id: "q_type_numerals_pairing",
    domain: "typography_copy",
    title: "How should live numbers and KPIs pair with body typography?",
    context: "Rendering PnL, fill latency, calibration scores, and balances across Kizuki and trading tools.",
    axis: "Numeric Typography",
    source: "curated",
    priority: 80,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Tabular Mono + Clean Sans",
        rationale: "Fixed-width tabular mono numerals keep live ticking rows rock-steady next to Sohne body.",
        trait_tag: "tabular-mono-numerals",
        signal_value: 2,
        preview: {
          kind: "type",
          tokens: ["font-variant-numeric: tabular-nums", "Berkeley Mono", "Sohne"],
          sample_head: "+$14,820.40  |  92ms",
          sample_body: "Columns never jitter when live order fills update.",
          badge: "Tabular Mono",
        },
      },
      {
        key: "B",
        label: "Lining Sans with Tight Tracking",
        rationale: "Keep numbers in the same neo-grotesk family with tabular lining figures for calmer unity.",
        trait_tag: "unified-lining-sans",
        signal_value: 1,
        preview: {
          kind: "type",
          tokens: ["ABC Diatype", "tnum lnum", "-0.02em"],
          sample_head: "94.2% calibrated",
          sample_body: "Seamless typographic harmony without terminal cosplay.",
          badge: "Unified Sans",
        },
      },
      {
        key: "C",
        label: "Editorial Serif Display Stats",
        rationale: "Set hero metrics in large optical-size serif with crisp uppercase micro-sans labels below.",
        trait_tag: "editorial-serif-metrics",
        signal_value: -1,
        preview: {
          kind: "type",
          tokens: ["Editorial New 48px", "10px tracked caps"],
          sample_head: "100,412",
          sample_body: "EVENTS INDEXED IN PERSONAL VAULT",
          badge: "Editorial Stat",
        },
      },
      {
        key: "D",
        label: "All-Mono Instrument Panel",
        rationale: "Every label, timestamp, and number in strict monospace for uniform telemetry scan speed.",
        trait_tag: "full-mono-telemetry",
        signal_value: -2,
        preview: {
          kind: "type",
          tokens: ["JetBrains Mono", "12px", "1.45 leading"],
          sample_head: "FILL 0.42s | SLIP 0.01% | OK",
          sample_body: "Zero typographic switching; pure operator ledger.",
          badge: "All Mono",
        },
      },
    ],
  },

  // =========================================================================
  // 3. VISUAL & BRAND DIRECTION (4)
  // =========================================================================
  {
    id: "q_brand_grid_discipline",
    domain: "visual_brand",
    title: "Which layout grammar defines a flagship public web release?",
    context: "Setting the structural poster direction for an editorial launch or new studio drop.",
    axis: "Compositional Structure",
    source: "curated",
    priority: 87,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Asymmetric Swiss Editorial Grid",
        rationale: "Exposed 12-column rail, purposeful negative space, sharp off-center tension, zero centered slop.",
        trait_tag: "asymmetric-swiss-grid",
        signal_value: 2,
        preview: {
          kind: "layout",
          tokens: ["12-col asymmetric", "left index rail", "large type tension"],
          sample_head: "Bureau Borsche / Swiss rigor",
          sample_body: "Rejection of centered SaaS symmetry in favor of editorial weight.",
          badge: "Swiss Grid",
        },
      },
      {
        key: "B",
        label: "Full-Bleed Cinema Frame",
        rationale: "Edge-to-edge moving image or 3D scene with whisper-thin edge telemetry and title lockup.",
        trait_tag: "full-bleed-cinema-frame",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["100vw plate", "corner metadata", "zero card clutter"],
          sample_head: "Editorial widescreen bar",
          sample_body: "The work occupies 90% of the viewport; UI stays razor-light.",
          badge: "Cinema Plate",
        },
      },
      {
        key: "C",
        label: "Live Working Product First",
        rationale: "Skip the marketing poster entirely; drop the visitor straight into the working interactive tool.",
        trait_tag: "product-first-canvas",
        signal_value: 0,
        preview: {
          kind: "layout",
          tokens: ["live sandbox", "real controls", "zero pitch deck"],
          sample_head: "Show the machine running",
          sample_body: "Prove utility in 3 seconds instead of promising it with headlines.",
          badge: "Live Tool",
        },
      },
      {
        key: "D",
        label: "Archival Artifact Specimen Sheet",
        rationale: "Numbered plates, tactile physical specimens, and dense margin notes like a museum monograph.",
        trait_tag: "archival-specimen-sheet",
        signal_value: -1,
        preview: {
          kind: "layout",
          tokens: ["Fig. 01-08", "margin footnotes", "catalog numbering"],
          sample_head: "Collected artifacts & receipts",
          sample_body: "Every section feels printed, numbered, and worth keeping.",
          badge: "Monograph",
        },
      },
    ],
  },
  {
    id: "q_brand_palette_restraint",
    domain: "visual_brand",
    title: "How much accent color earns a place on a brand system?",
    context: "Locking the OKLCH token spine before writing CSS for a new venture or Kizuki studio surface.",
    axis: "Color Restraint",
    source: "curated",
    priority: 86,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Warm Neutral + One Surgical Accent",
        rationale: "95% calm bone/charcoal neutral, 5% unmistakable signature accent reserved for active state.",
        trait_tag: "single-surgical-accent",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#F5F3EE", "#141413", "#5B21B6", "#D9D5CC"],
          sample_head: "Restraint creates signal",
          sample_body: "When only one thing is colored, the eye knows immediately.",
          badge: "1 Accent",
        },
      },
      {
        key: "B",
        label: "Ink, Parchment & Vermilion Stamp",
        rationale: "Japanese print balance: warm paper ground, sumi ink type, and rare seal-red punctuation.",
        trait_tag: "sumi-vermilion-restraint",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#F3EFE6", "#161513", "#C83E2B", "#78716C"],
          sample_head: "Print-grade ink discipline",
          sample_body: "Timeless warmth with razor editorial urgency.",
          badge: "Vermilion",
        },
      },
      {
        key: "C",
        label: "Obsidian Vault + Phosphor Signal",
        rationale: "Near-black slate, silver copy, and clinical phosphor green or blood red strictly for live status.",
        trait_tag: "obsidian-phosphor-signal",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#07090D", "#E2E8F0", "#22C55E", "#DC2626"],
          sample_head: "Forbidden terminal contrast",
          sample_body: "Dark command authority with zero lava-lamp gradient slop.",
          badge: "Terminal",
        },
      },
      {
        key: "D",
        label: "Chromatic Editorial Duotone",
        rationale: "Two deliberate high-taste brand hues (deep indigo + antique gold) anchored by charcoal.",
        trait_tag: "chromatic-luxury-duotone",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#12101C", "#EAE4D8", "#C9A227", "#4C1D95"],
          sample_head: "Rich two-hue luxury",
          sample_body: "Memorable brand silhouette without rainbow clutter.",
          badge: "Duotone",
        },
      },
    ],
  },
  {
    id: "q_brand_surface_texture",
    domain: "visual_brand",
    title: "What gives a flat digital surface authentic material presence?",
    context: "Killing sterile SaaS flatness and banned AI gradients without adding cheesy skeuomorphism.",
    axis: "Material Texture",
    source: "curated",
    priority: 81,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Subtle 35mm Grain & Paper Tooth",
        rationale: "2-4% organic monochrome film grain over flat surfaces makes screens feel tactile and warm.",
        trait_tag: "subtle-film-grain",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["3% monochrome grain", "matte finish", "zero glow"],
          sample_head: "Analog warmth without kitsch",
          sample_body: "Removes clinical LCD sterility while keeping text razor sharp.",
          badge: "Film Grain",
        },
      },
      {
        key: "B",
        label: "Engraved Hairlines & Tick Marks",
        rationale: "Ultra-fine ruler ticks, registration crosshairs, and precision micro-borders from watchmaking.",
        trait_tag: "watchmaker-micro-ticks",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["0.5px ticks", "registration +", "vernier scale"],
          sample_head: "Precision instrument craft",
          sample_body: "Signals obsession with measurement and tolerance.",
          badge: "Instrument",
        },
      },
      {
        key: "C",
        label: "Directional Specular Light Falloff",
        rationale: "Real cursor-tracked or directional overhead sheen across brushed dark surfaces.",
        trait_tag: "real-specular-falloff",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["directional key light", "1px rim", "dark slate"],
          sample_head: "Physical light physics",
          sample_body: "Surface reacts to angle instead of sitting under fake neon blobs.",
          badge: "Specular",
        },
      },
      {
        key: "D",
        label: "Pure Matte Swiss Ink",
        rationale: "Zero texture, zero noise, zero gradients: let typography, proportion, and spacing do 100% of the work.",
        trait_tag: "pure-matte-swiss",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#FAF9F6", "#111111", "0% noise", "pure proportion"],
          sample_head: "Nothing to hide behind",
          sample_body: "Maximum clarity; every pixel of spacing must be perfect.",
          badge: "Pure Matte",
        },
      },
    ],
  },
  {
    id: "q_brand_nob_doorman",
    domain: "visual_brand",
    title: "How should Nob balance minimal UX with unforgettable brand craft?",
    context: "Calibrating nob.me (the tiny judgmental doorman) so cold senders immediately feel the bar.",
    axis: "Minimalist Brand Tension",
    source: "curated",
    priority: 85,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Private Club Stationery",
        rationale: "Uncoated cream card, razor serif prompt, heavy stamp button: effortlessly expensive and selective.",
        trait_tag: "private-club-stationery",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#F4F0E8", "#141311", "#8C1D18", "letterpress stamp"],
          sample_head: "State your business.",
          sample_body: "Stake $25 to send a priority intro. Refunded if accepted.",
          badge: "Private Club",
        },
      },
      {
        key: "B",
        label: "Swiss Customs Manifest",
        rationale: "Stark monochrome border form, numbered fields, clinical judgement, zero flattery.",
        trait_tag: "swiss-customs-manifest",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["01 SENDER", "02 STAKE", "03 CLAIM", "HARD RULE"],
          sample_head: "QUALIFICATION FORM // NOB",
          sample_body: "Cold outreach requires disclosed skin in the game.",
          badge: "Manifest",
        },
      },
      {
        key: "C",
        label: "Dark Velvet-Rope Gate",
        rationale: "Near-black obsidian frame, single crisp input, subtle metallic border, high-status mystery.",
        trait_tag: "dark-velvet-gate",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#0A0A0C", "#F4F4F5", "#A78BFA", "1px chrome"],
          sample_head: "Knock with conviction.",
          sample_body: "Minimal dark entry; turns away noise before it reaches the inbox.",
          badge: "Velvet Rope",
        },
      },
      {
        key: "D",
        label: "Hyper-Clean Consumer Utility",
        rationale: "Zero theatricality: Apple Pay speed, plain language, instant clarity on stake and refund rules.",
        trait_tag: "zero-theatre-utility",
        signal_value: -2,
        preview: {
          kind: "layout",
          tokens: ["1-screen checkout", "plain English", "instant refund badge"],
          sample_head: "Send a qualified message",
          sample_body: "Fastest possible conversion with zero friction or attitude.",
          badge: "Pure Utility",
        },
      },
    ],
  },

  // =========================================================================
  // 4. MOTION & INTERACTION (4)
  // =========================================================================
  {
    id: "q_motion_ui_tempo",
    domain: "motion_feel",
    title: "How snappy should everyday UI drawers and state changes feel?",
    context: "Switching Kizuki tabs, answering Taste Studio cards, or opening a command palette.",
    axis: "Interaction Speed",
    source: "curated",
    priority: 87,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Mechanical 110ms Snap",
        rationale: "Camera-shutter fast with sharp expo-out deceleration; feels wired straight to your fingers.",
        trait_tag: "mechanical-110ms-snap",
        signal_value: 2,
        preview: {
          kind: "motion",
          tokens: ["110ms", "cubic-bezier(0.16, 1, 0.3, 1)", "0% overshoot"],
          sample_head: "Instant tactile response",
          sample_body: "Zero sluggish float; never slows down keyboard power users.",
          badge: "110ms Snap",
        },
      },
      {
        key: "B",
        label: "Crisp Critically-Damped Spring",
        rationale: "180ms physical spring with subtle weight and clean settle; alive without bouncing like a toy.",
        trait_tag: "critically-damped-spring",
        signal_value: 1,
        preview: {
          kind: "motion",
          tokens: ["180ms", "stiffness 420", "damping 34", "interruptible"],
          sample_head: "Physical Apple/Linear poise",
          sample_body: "Interruptible mid-flight with genuine mass and zero wobble.",
          badge: "180ms Spring",
        },
      },
      {
        key: "C",
        label: "Weighted Editorial Glide",
        rationale: "280ms smooth asymmetric ease-out on entry, faster ease-in on exit for luxurious composure.",
        trait_tag: "editorial-280ms-glide",
        signal_value: -1,
        preview: {
          kind: "motion",
          tokens: ["280ms in / 160ms out", "asymmetric ease", "GPU transform"],
          sample_head: "Composed gallery pacing",
          sample_body: "Lets major card transitions breathe without feeling slow.",
          badge: "280ms Glide",
        },
      },
      {
        key: "D",
        label: "Zero-Delay Hard Cuts",
        rationale: "Instant state swap with zero transition duration except where spatial continuity truly needs it.",
        trait_tag: "hard-cut-instant",
        signal_value: -2,
        preview: {
          kind: "motion",
          tokens: ["0ms swap", "terminal instant", "max throughput"],
          sample_head: "Pure terminal velocity",
          sample_body: "Every millisecond spent animating is latency.",
          badge: "0ms Cut",
        },
      },
    ],
  },
  {
    id: "q_motion_data_honesty",
    domain: "motion_feel",
    title: "What motion belongs on live trading and operator monitors?",
    context: "Building live visual motion for live trading and Kizuki telemetry without fake AI pulses.",
    axis: "Information-Bearing Motion",
    source: "curated",
    priority: 89,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Event-Bound Pulses + Live Tape",
        rationale: "Rich visual motion driven strictly by real ticks, fills, and regime shifts; zero fake idle breathing.",
        trait_tag: "event-bound-live-motion",
        signal_value: 2,
        preview: {
          kind: "motion",
          tokens: ["tick-triggered flash", "rolling fill tape", "0 fake loops"],
          sample_head: "Alive because the market moved",
          sample_body: "High visual energy where every pixel pulse maps to a real event.",
          badge: "Honest Live",
        },
      },
      {
        key: "B",
        label: "Kinetic War-Room Telemetry",
        rationale: "Bold animated equity curves, live depth heatmaps, and directional momentum cues built to watch.",
        trait_tag: "kinetic-war-room",
        signal_value: 1,
        preview: {
          kind: "motion",
          tokens: ["60fps canvas", "live heatmap", "delta trails"],
          sample_head: "Public showcase trading energy",
          sample_body: "Unmistakably alive on a public screen or stream without clutter.",
          badge: "War Room",
        },
      },
      {
        key: "C",
        label: "Quiet Micro-Flash Deltas",
        rationale: "Calm table rows where only changed cells flash for 350ms in muted green or crimson.",
        trait_tag: "quiet-delta-flashes",
        signal_value: -1,
        preview: {
          kind: "motion",
          tokens: ["350ms cell decay", "static chrome", "tabular lock"],
          sample_head: "Calm precision desk",
          sample_body: "Easy to monitor for six hours straight without eye fatigue.",
          badge: "Delta Flash",
        },
      },
      {
        key: "D",
        label: "Static Snapshot + Manual Refresh",
        rationale: "Minimal ambient motion; update figures cleanly in place without visual flashes.",
        trait_tag: "calm-static-figures",
        signal_value: -2,
        preview: {
          kind: "motion",
          tokens: ["no flashes", "calm diff", "low stimulation"],
          sample_head: "Zero peripheral noise",
          sample_body: "Pure analytical focus with no kinetic distractions.",
          badge: "Still",
        },
      },
    ],
  },
  {
    id: "q_motion_tactile_signature",
    domain: "motion_feel",
    title: "Which single physical micro-artifact elevates a flagship page?",
    context: "Choosing one unforgettable subtraction-tested tactile signature (Teenage Engineering / bestdesignsonx bar).",
    axis: "Tactile Signature",
    source: "curated",
    priority: 84,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Precision Vernier Detent Dial",
        rationale: "A touchable mechanical scrubber or mode dial with crisp visual detents and subtle tick feedback.",
        trait_tag: "vernier-detent-dial",
        signal_value: 2,
        preview: {
          kind: "motion",
          tokens: ["detent snaps", "haptic ticks", "Teenage Engineering"],
          sample_head: "Hardware on glass",
          sample_body: "Users play with it twice just because the resistance feels right.",
          badge: "Detent Dial",
        },
      },
      {
        key: "B",
        label: "Knife-Blade Split Reveal",
        rationale: "A razor divider that parts or masks content cleanly to reveal hidden state (like Encrypt's intent veil).",
        trait_tag: "knife-blade-reveal",
        signal_value: 1,
        preview: {
          kind: "motion",
          tokens: ["clip-path shear", "1px blade", "before/after mask"],
          sample_head: "Visible privacy boundary",
          sample_body: "Makes abstract concepts like masked intent physically legible.",
          badge: "Blade Mask",
        },
      },
      {
        key: "C",
        label: "Coupled Paper-Drag Deck",
        rationale: "Physical card stack with real pointer velocity, friction, and crisp throw-to-decide physics.",
        trait_tag: "coupled-paper-drag",
        signal_value: 0,
        preview: {
          kind: "motion",
          tokens: ["pointer velocity", "spring throw", "stack depth"],
          sample_head: "Direct manipulation joy",
          sample_body: "Feels like flicking thick museum stock cards across a desk.",
          badge: "Card Physics",
        },
      },
      {
        key: "D",
        label: "Real-Time Light & Shadow Sweep",
        rationale: "Subtle WebGL or CSS directional light tracing edges and foil embossing as you move.",
        trait_tag: "specular-light-sweep",
        signal_value: -1,
        preview: {
          kind: "motion",
          tokens: ["WebGL rim light", "subtle foil", "reduced-motion safe"],
          sample_head: "Luxury material presence",
          sample_body: "Elevates a dark card into a physical obsidian object.",
          badge: "Light Sweep",
        },
      },
    ],
  },
  {
    id: "q_motion_scroll_choreography",
    domain: "motion_feel",
    title: "How much scroll choreography is right for a showpiece launch site?",
    context: "Reviewing an interactive studio or product site before approving it for public launch.",
    axis: "Scroll Choreography",
    source: "curated",
    priority: 80,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Native Scroll + Linked Reveals",
        rationale: "Never hijack the scrollbar; drive crisp compositor transforms directly off natural scroll position.",
        trait_tag: "native-linked-scroll",
        signal_value: 2,
        preview: {
          kind: "motion",
          tokens: ["native scrollbar", "transform/opacity only", "120fps"],
          sample_head: "Zero scroll trap",
          sample_body: "Fast users fly through; slow readers enjoy silk choreography.",
          badge: "Native Linked",
        },
      },
      {
        key: "B",
        label: "One Pinned Centerpiece Beat",
        rationale: "Pin a single unforgettable 1.5-viewport product reveal, then return immediately to crisp native scroll.",
        trait_tag: "single-pinned-centerpiece",
        signal_value: 1,
        preview: {
          kind: "motion",
          tokens: ["1 pinned hero beat", "ScrollTrigger", "native rest"],
          sample_head: "Earned cinema moment",
          sample_body: "Delivers Apple-level spectacle without turning the site into a slog.",
          badge: "1 Pin Beat",
        },
      },
      {
        key: "C",
        label: "Full Directed Storyboard Scroll",
        rationale: "Multi-act GSAP / WebGL camera sequence where scrolling acts like scrubbing a film timeline.",
        trait_tag: "full-storyboard-scroll",
        signal_value: -1,
        preview: {
          kind: "motion",
          tokens: ["chapter timeline", "camera scrub", "webgl stage"],
          sample_head: "Film-grade interactive piece",
          sample_body: "Best reserved for flagship trailers and showcase microsites.",
          badge: "Full Scrub",
        },
      },
      {
        key: "D",
        label: "Zero Scroll Tricks; Pure Hover/Click",
        rationale: "Keep scrolling 100% static print-like; put all delight into fast direct hover and click interactions.",
        trait_tag: "static-scroll-fast-hover",
        signal_value: -2,
        preview: {
          kind: "motion",
          tokens: ["zero scroll-jack", "instant read", "tactile clicks"],
          sample_head: "Respects the reader's pace",
          sample_body: "Never hides content behind scroll progress bars.",
          badge: "Zero Hijack",
        },
      },
    ],
  },

  // =========================================================================
  // 5. FILM, VIDEO & ANIME (4)
  // =========================================================================
  {
    id: "q_video_anime_bar",
    domain: "video_anime",
    title: "What visual bar passes for anime-over-real-world and Infinite Idol?",
    context: "Judging whether an Infinite Idol prototype or anime launch clip looks AAA or looks like AI slop.",
    axis: "Anime Production Bar",
    source: "curated",
    priority: 92,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Layered Satsuei 2s/3s Over 1s World",
        rationale: "Rigged/cel characters animated on 2s/3s with lifted cast shadows composited over smooth 1s painted worlds.",
        trait_tag: "satsuei-2s-over-1s",
        signal_value: 2,
        preview: {
          kind: "layout",
          tokens: ["cels on 2s/3s", "world on 1s", "lifted shadows", "halation"],
          sample_head: "True studio satsuei craft",
          sample_body: "Reads immediately like theatrical anime compositing, not a raw generator.",
          badge: "Satsuei",
        },
      },
      {
        key: "B",
        label: "AAA Gacha Real-Time Shaders",
        rationale: "Hoyoverse / ZZZ-grade rigged character shaders, crisp rim lighting, expressive camera blocking, never a VRM demo.",
        trait_tag: "aaa-gacha-shader-bar",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["custom NPR ramp", "rigged .glb/Live2D", "dynamic camera"],
          sample_head: "Real AAA gacha polish",
          sample_body: "Zero primitive dolls; every frame looks like a funded studio release.",
          badge: "AAA Gacha",
        },
      },
      {
        key: "C",
        label: "90s OVA Cel + Analog Gate",
        rationale: "Hand-inked line weight, painted gouache skies, soft chromatic bloom, and 35mm dust.",
        trait_tag: "90s-ova-cel-craft",
        signal_value: 0,
        preview: {
          kind: "swatch",
          tokens: ["#1C1924", "#E6D5B8", "#D9483B", "#4B6B7A"],
          sample_head: "Timeless theatrical cel",
          sample_body: "Avoids glossy modern CGI plastics completely.",
          badge: "90s OVA",
        },
      },
      {
        key: "D",
        label: "Graphic Monochrome + Spot Color",
        rationale: "Manga ink starkness with one electric signature color and hyper-kinetic impact frames.",
        trait_tag: "graphic-manga-impact",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#0D0D0F", "#F7F5F0", "#E11D48", "impact frames"],
          sample_head: "High-voltage ink impact",
          sample_body: "Unmistakable silhouette even as a tiny muted timeline thumbnail.",
          badge: "Impact Ink",
        },
      },
    ],
  },
  {
    id: "q_video_pacing_rhythm",
    domain: "video_anime",
    title: "What edit cadence hits hardest in a 15-second launch reel?",
    context: "Directing a Seedance 2.0 or Remotion launch sequence for a flagship product or film launch.",
    axis: "Trailer Edit Cadence",
    source: "curated",
    priority: 86,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Pressurized Hold -> Razor Montage",
        rationale: "Hold 3.5 seconds of eerie calm to hook posture, then snap into razor-precise 0.5s proof cuts.",
        trait_tag: "hold-then-razor-montage",
        signal_value: 2,
        preview: {
          kind: "motion",
          tokens: ["3.5s tension hold", "0.5s cut burst", "hard black end-card"],
          sample_head: "Tension earns the explosion",
          sample_body: "Separates real film direction from frantic TikTok noise.",
          badge: "Tension -> Snap",
        },
      },
      {
        key: "B",
        label: "A24 Title Cards + 3 Iconic Shots",
        rationale: "Stark typographic thesis cards alternating with three unforgettable, unhurried hero frames.",
        trait_tag: "a24-title-card-cadence",
        signal_value: 1,
        preview: {
          kind: "motion",
          tokens: ["serif title cards", "3 hero plates", "silence beats"],
          sample_head: "Poster-grade restraint",
          sample_body: "Reads crystal clear even on mute in an X feed.",
          badge: "A24 Rhythm",
        },
      },
      {
        key: "C",
        label: "Continuous Unbroken Tracking Shot",
        rationale: "One choreographed camera move pushing through space with escalating reveals and zero cuts.",
        trait_tag: "continuous-tracking-shot",
        signal_value: 0,
        preview: {
          kind: "motion",
          tokens: ["1 continuous move", "depth parallax", "escalating light"],
          sample_head: "Hypnotic spatial authority",
          sample_body: "Feels impossibly expensive and controlled.",
          badge: "One-Take",
        },
      },
      {
        key: "D",
        label: "Hard Percussive Beat-Locked Cuts",
        rationale: "Frame-accurate 0.7s cuts locked to a driving mechanical percussion groove from second zero.",
        trait_tag: "beat-locked-percussive",
        signal_value: -1,
        preview: {
          kind: "motion",
          tokens: ["0.7s hard cuts", "128bpm lock", "instant hook"],
          sample_head: "Immediate kinetic grip",
          sample_body: "Captures scrolling thumbs in the first 0.5 seconds.",
          badge: "Percussive",
        },
      },
    ],
  },
  {
    id: "q_video_color_grade",
    domain: "video_anime",
    title: "Which color grade makes a film look theatrical instead of AI?",
    context: "Setting the look LUT for cinema teasers and dark product reels without orange-teal slop.",
    axis: "Color Grading Palette",
    source: "curated",
    priority: 84,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Lifted Charcoal + Tungsten Halation",
        rationale: "Rich lifted shadows, warm sodium/tungsten practical lights, subtle red halation around highlights.",
        trait_tag: "tungsten-halation-grade",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#181619", "#3B312B", "#E09F5A", "#C84B31"],
          sample_head: "35mm night-exterior cinema",
          sample_body: "Zero synthetic teal-orange; feels shot on real glass.",
          badge: "35mm Tungsten",
        },
      },
      {
        key: "B",
        label: "Bleach-Bypass Silver & Crimson",
        rationale: "Desaturated cool slate midtones, deep contrast, and surgical crimson accent pops.",
        trait_tag: "bleach-bypass-silver",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#0E1116", "#64748B", "#E2E8F0", "#B91C1C"],
          sample_head: "Cold thriller steel",
          sample_body: "High-stakes precision suited to Encrypt and institutional finance.",
          badge: "Bleach Bypass",
        },
      },
      {
        key: "C",
        label: "Natural Daylight Film Stock",
        rationale: "Clean Kodak 2383 greens, authentic skin tones, airy highlights, zero heavy filter look.",
        trait_tag: "natural-kodak-2383",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#EFECE4", "#2B3A32", "#C99E7A", "#1C1D1B"],
          sample_head: "Sunlit editorial documentary",
          sample_body: "Confident enough to let lighting and framing carry the shot.",
          badge: "Kodak 2383",
        },
      },
      {
        key: "D",
        label: "High-Contrast Noir Monochrome",
        rationale: "Pure black-and-white silver halide look with one deliberate color-flash reveal at the climax.",
        trait_tag: "silver-halide-noir",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#0A0A0A", "#525252", "#F5F5F5", "#7C3AED"],
          sample_head: "Unmistakable auteur signature",
          sample_body: "Cuts through noisy feeds instantly.",
          badge: "Noir",
        },
      },
    ],
  },
  {
    id: "q_video_sound_design",
    domain: "video_anime",
    title: "How should sound and voice carry a product or film teaser?",
    context: "Mixing SFX, score, and voiceover so the reel dominates both muted feeds and headphones.",
    axis: "Sound & Voice Direction",
    source: "curated",
    priority: 83,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Mechanical Foley + Sub-Bass + Silence",
        rationale: "Tactile switches, shutter clicks, deep room tone, and deliberate half-second drops into pure silence.",
        trait_tag: "tactile-foley-silence",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Click. Sub-drop. Dead silence. Reveal.",
          sample_body: "Silence is the loudest weapon in a crowded social feed.",
          badge: "Foley + Silence",
        },
      },
      {
        key: "B",
        label: "Deadpan Low-Register Voiceover",
        rationale: "Two razor-written lines spoken calmly with zero hype-trailer announcer voice.",
        trait_tag: "deadpan-calm-vo",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "'Most apps leak your intent before you act.'",
          sample_body: "Understated conviction hits ten times harder than shouting.",
          badge: "Dry VO",
        },
      },
      {
        key: "C",
        label: "Zero Voiceover; Pure Score + Type",
        rationale: "Let a sharp minimal electronic/orchestral pulse and hard screen typography do all the speaking.",
        trait_tag: "pure-score-and-type",
        signal_value: 0,
        preview: {
          kind: "copy",
          sample_head: "100% legible muted or loud",
          sample_body: "Zero cringe narration risk; pure audiovisual posture.",
          badge: "Score + Type",
        },
      },
      {
        key: "D",
        label: "Stylized Anime Foley + Sharp Dialogue",
        rationale: "Crisp character line with IPA-tight lip sync, anime whoosh accents, and sudden synth swell.",
        trait_tag: "anime-foley-dialogue",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "Character-led anime energy",
          sample_body: "Essential when stylized anime character presence is the hook.",
          badge: "Anime Mix",
        },
      },
    ],
  },

  // =========================================================================
  // 6. PERSONAL STYLE, MERCH & OBJECTS (4) - THIN DOMAIN, HIGHEST PRIORITY
  // =========================================================================
  {
    id: "q_merch_apparel_silhouette",
    domain: "merch_objects",
    title: "What hoodie or tee cut would you actually wear out in London?",
    context: "Personal style and studio apparel and physical objects is explicitly thin in your profile; lock the real bar.",
    axis: "Merch Silhouette",
    source: "curated",
    priority: 99,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "480gsm Boxy Washed-Black, Tonal Mark",
        rationale: "Heavy architectural drape, pigment-washed charcoal/black, tiny tonal embroidery you notice up close.",
        trait_tag: "heavy-boxy-tonal-stealth",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#1B1B1D", "#2E2E32", "480gsm cotton", "tonal stitch"],
          sample_head: "Stealth luxury streetwear",
          sample_body: "Zero billboard logo; feels like Represent / Cole Buxton weight.",
          badge: "Heavy Stealth",
        },
      },
      {
        key: "B",
        label: "Tailored Minimalist Knit, Zero Outer Logo",
        rationale: "Clean luxury merino or heavyweight interlock tee with branding strictly on the woven inside neck tag.",
        trait_tag: "quiet-tailored-zero-logo",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#141414", "#EAE7DF", "#3B3732", "interior tag only"],
          sample_head: "Quiet old-money restraint",
          sample_body: "Wearable to investor dinners and theatre without screaming startup.",
          badge: "Zero Logo",
        },
      },
      {
        key: "C",
        label: "Oversized Japanese Streetwear + Back Print",
        rationale: "Dropped shoulder, thick collar rib, crisp graphic art or typographic manifesto on the back.",
        trait_tag: "japanese-graphic-streetwear",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#111111", "#F4F1EA", "#C83E2B", "heavy back print"],
          sample_head: "Cav Empt / anime-adjacent drop",
          sample_body: "Collectible statement piece for conferences and creative circles.",
          badge: "Graphic Drop",
        },
      },
      {
        key: "D",
        label: "Technical Matte Shell + Hidden Emblem",
        rationale: "Weather-ready matte nylon overshirt or jacket with precision zippers and hidden interior sigil.",
        trait_tag: "technical-matte-outerwear",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#181A1F", "#2D3139", "matte ripstop", "YKK Excella"],
          sample_head: "Acronym-adjacent London utility",
          sample_body: "Built for London rain, commute comfort, and sharp silhouette.",
          badge: "Tech Shell",
        },
      },
    ],
  },
  {
    id: "q_merch_packaging_unboxing",
    domain: "merch_objects",
    title: "What VIP drop or partner gift box feels genuinely high-taste?",
    context: "Sending physical artifacts to Solana partners, Points backers, or close collaborators.",
    axis: "Packaging & Print Tactility",
    source: "curated",
    priority: 97,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Blind-Debossed Matte Charcoal Box",
        rationale: "Heavy magnetic rigid board, zero gloss, blind-debossed emblem, 600gsm cotton letterpress insert.",
        trait_tag: "blind-debossed-charcoal",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#161618", "#27272B", "600gsm cotton", "blind deboss"],
          sample_head: "Private vault unboxing",
          sample_body: "Heavy in the hand; zero cheap foam or glossy startup sleeves.",
          badge: "Blind Deboss",
        },
      },
      {
        key: "B",
        label: "Raw Machined Aluminum + Spec Label",
        rationale: "Brushed anodized aluminum case with serialized industrial spec sticker like pro audio hardware.",
        trait_tag: "machined-aluminum-spec",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#C7CCD1", "#1B1E23", "#E85D04", "001/100 etched"],
          sample_head: "Teenage Engineering object energy",
          sample_body: "Nobody throws the container away; it lives on their desk.",
          badge: "Machined Tin",
        },
      },
      {
        key: "C",
        label: "Japanese Cloth Wrap + Uncoated Ivory Paper",
        rationale: "Heavy textured linen or furoshiki wrap, raw deckle-edge ivory note, vermilion wax or ink seal.",
        trait_tag: "japanese-tactile-craft",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#F1ECE1", "#23211E", "#B83227", "uncoated linen"],
          sample_head: "Ceremonial human craft",
          sample_body: "Feels hand-assembled by a human with obsessive taste.",
          badge: "Furoshiki",
        },
      },
      {
        key: "D",
        label: "Archival Mylar Pouch + Heavy Metal Token",
        rationale: "Heat-sealed matte archival bag containing a weighted custom hardware/metal object and spec card.",
        trait_tag: "archival-mylar-industrial",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#1E2024", "#9CA3AF", "#F8FAFC", "archival seal"],
          sample_head: "Underground art-drop energy",
          sample_body: "Fast to ship globally, brutalist, impossible to ignore.",
          badge: "Archival Drop",
        },
      },
    ],
  },
  {
    id: "q_merch_everyday_objects",
    domain: "merch_objects",
    title: "Which physical object language fits your desk and everyday gear?",
    context: "Calibrating hardware, bags, stationery, and personal studio gear recommendations.",
    axis: "Object Design Language",
    source: "curated",
    priority: 96,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Stealth Matte Titanium & Black Ceramic",
        rationale: "Monochrome matte black, bead-blasted titanium, zero visible branding, clean weighted feel.",
        trait_tag: "stealth-titanium-minimal",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#111214", "#3A3D45", "#8B909A", "bead-blasted Ti"],
          sample_head: "Silent dark hardware",
          sample_body: "Disappears visually until you pick it up and feel the weight.",
          badge: "Stealth Ti",
        },
      },
      {
        key: "B",
        label: "Braun / Dieter Rams Functional Precision",
        rationale: "Anodized aluminum, exact geometric dials, single orange or red functional accent key.",
        trait_tag: "rams-precision-industrial",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#E5E5E0", "#222222", "#E64A19", "anodized Al"],
          sample_head: "Honest industrial design",
          sample_body: "Every switch has a mechanical reason to exist.",
          badge: "Rams / TE",
        },
      },
      {
        key: "C",
        label: "Warm Walnut, Brushed Brass & Leather",
        rationale: "Natural materials that patina over years: dark walnut, vegetable-tanned leather, warm brass.",
        trait_tag: "warm-patina-heirloom",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#3E2723", "#B08D57", "#1F1A17", "#EFE8DC"],
          sample_head: "Heirloom analog warmth",
          sample_body: "Gets better after five years of daily use instead of wearing out.",
          badge: "Heirloom",
        },
      },
      {
        key: "D",
        label: "Utilitarian Japanese Stationery Restraint",
        rationale: "Muji / Midori clarity: zero ego, whisper-light utility, pure function over status signaling.",
        trait_tag: "japanese-quiet-utility",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#F5F3EE", "#4A4843", "#1C1B19", "raw kraft"],
          sample_head: "Effortless everyday clarity",
          sample_body: "No luxury posture; simply works cleanly every single day.",
          badge: "Quiet Utility",
        },
      },
    ],
  },
  {
    id: "q_merch_gift_philosophy",
    domain: "merch_objects",
    title: "What makes a personal gift feel genuinely from you, not outsourced?",
    context: "Helping plan anniversaries, anniversaries, milestones, or thoughtful gifts without feeling scripted.",
    axis: "Gifting Philosophy",
    source: "curated",
    priority: 95,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Private Memory Reference + Sharp Note",
        rationale: "Something tied to a specific line she mentioned months ago, proving real attention and memory.",
        trait_tag: "deep-memory-gift",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Proof you actually listened",
          sample_body: "Impossible for a concierge or generic gift list to fake.",
          badge: "Deep Memory",
        },
      },
      {
        key: "B",
        label: "Frictionless Experience Night Out",
        rationale: "Best-seat theatre tickets, dinner booked, transport sorted, childcare locked so she just enjoys it.",
        trait_tag: "zero-friction-experience",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "Carry 100% of the logistics",
          sample_body: "The gift is both the night out and zero mental load.",
          badge: "Experience",
        },
      },
      {
        key: "C",
        label: "Quiet Top-Tier Daily Upgrade",
        rationale: "Replace something used every morning with the single best crafted version on earth.",
        trait_tag: "daily-craft-upgrade",
        signal_value: 0,
        preview: {
          kind: "copy",
          sample_head: "Compounding daily delight",
          sample_body: "Felt every single day rather than put on a shelf.",
          badge: "Daily Upgrade",
        },
      },
      {
        key: "D",
        label: "Bespoke Physical Keepsake",
        rationale: "Custom-commissioned piece (print, jewellery, or bound family photo book) made once.",
        trait_tag: "bespoke-keepsake",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "One-of-one artifact",
          sample_body: "Carries permanence and family archive value.",
          badge: "Keepsake",
        },
      },
    ],
  },

  // =========================================================================
  // 7. SPACES, TRAVEL & EXPERIENCES (4) - THIN DOMAIN, HIGH PRIORITY
  // =========================================================================
  {
    id: "q_spaces_london_couple_night",
    domain: "spaces_life",
    title: "Which evening out in the city hits the true sweet spot?",
    context: "Stretching past stay-at-home defaults for an unscripted, genuinely great evening out.",
    axis: "City Evening Out",
    source: "curated",
    priority: 98,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "West End / National Theatre + Late Supper",
        rationale: "Sharp play or production she will love, followed by an unhurried candlelit supper nearby.",
        trait_tag: "theatre-plus-late-supper",
        signal_value: 2,
        preview: {
          kind: "layout",
          tokens: ["19:30 curtain", "21:45 supper", "driver home", "phones away"],
          sample_head: "Classic London high-note",
          sample_body: "Matches her love of theatre while keeping your transport friction zero.",
          badge: "Theatre + Supper",
        },
      },
      {
        key: "B",
        label: "Intimate Hidden Dining + Cocktail Room",
        rationale: "Low-lit Soho or Mayfair room with exceptional food, real conversation, and zero tourist noise.",
        trait_tag: "intimate-soho-dining",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["dim acoustic room", "tasting or grill", "quiet corner booth"],
          sample_head: "Unhurried two-person bubble",
          sample_body: "High atmosphere, great food, full attention.",
          badge: "Hidden Room",
        },
      },
      {
        key: "C",
        label: "Late Gallery Opening + Neighbourhood Dinner",
        rationale: "Cultural spark at Tate/Royal Academy late view, then a relaxed unpretentious table.",
        trait_tag: "culture-walk-bistro",
        signal_value: 0,
        preview: {
          kind: "layout",
          tokens: ["evening exhibition", "short walk", "neighbourhood table"],
          sample_head: "Fresh shared stimulus",
          sample_body: "Gives you both something vivid to dissect over dinner.",
          badge: "Culture Night",
        },
      },
      {
        key: "D",
        label: "Live Comedy or Jazz Cellar + Late Bites",
        rationale: "High-energy Soho comedy/jazz set where you laugh hard and break routine completely.",
        trait_tag: "live-comedy-jazz-night",
        signal_value: -1,
        preview: {
          kind: "layout",
          tokens: ["front-row energy", "zero stiffness", "late street eats"],
          sample_head: "Zero-pretension reset",
          sample_body: "High joy, zero formality, unforgettable mood shift.",
          badge: "Live Energy",
        },
      },
    ],
  },
  {
    id: "q_spaces_family_trip",
    domain: "spaces_life",
    title: "What makes a step-free luxury family trip feel effortless?",
    context: "Planning a multi-age family trip where full step-free access is a hard filter.",
    axis: "Family Luxury Travel",
    source: "curated",
    priority: 97,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Single-Level Private Villa + Heated Pool",
        rationale: "Zero stairs anywhere, wide terrace roll-out, and private space so everyone relaxes at their own pace.",
        trait_tag: "single-level-private-villa",
        signal_value: 2,
        preview: {
          kind: "layout",
          tokens: ["1-level step-free", "private heated pool", "private chef opt", "driver"],
          sample_head: "Zero friction, maximum calm",
          sample_body: "Full step-free access everywhere with plenty of space to unwind and play.",
          badge: "Step-Free Villa",
        },
      },
      {
        key: "B",
        label: "5-Star Lift-First Resort + Kids Club",
        rationale: "Verified accessible connecting suites, full resort lifts, pools, and structured kids activities.",
        trait_tag: "five-star-accessible-resort",
        signal_value: 1,
        preview: {
          kind: "layout",
          tokens: ["verified lifts", "adjoining suites", "kids club", "concierge"],
          sample_head: "Full-service parent recovery",
          sample_body: "Parents actually get real downtime while everyone is cared for.",
          badge: "5-Star Resort",
        },
      },
      {
        key: "C",
        label: "Accessible Alpine or Coastal Lodge",
        rationale: "Dramatic scenery (like Garmisch) with step-free cable cars, flat promenades, and private van transfers.",
        trait_tag: "scenic-accessible-lodge",
        signal_value: 0,
        preview: {
          kind: "layout",
          tokens: ["step-free views", "private van", "ground-floor suite"],
          sample_head: "Big-landscape family memory",
          sample_body: "Cinematic nature without ever hitting an inaccessible bottleneck.",
          badge: "Scenic Lodge",
        },
      },
      {
        key: "D",
        label: "UK Luxury Country Estate (Zero Flights)",
        rationale: "Chauffeur-driven 2-hour escape from London to a grand accessible ground-floor cottage with grounds.",
        trait_tag: "uk-country-estate-escape",
        signal_value: -1,
        preview: {
          kind: "layout",
          tokens: ["0 airport friction", "2h driver", "accessible spa & grounds"],
          sample_head: "Maximum rest per weekend",
          sample_body: "Skip airport wheelchair anxiety for short half-term breaks.",
          badge: "Zero-Flight UK",
        },
      },
    ],
  },
  {
    id: "q_spaces_hotel_interior",
    domain: "spaces_life",
    title: "Which hotel room atmosphere lets you switch off fastest?",
    context: "Choosing hotels for London staycations, work trips, or short European breaks.",
    axis: "Hotel Room Atmosphere",
    source: "curated",
    priority: 94,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Quiet Japanese Timber Minimalism",
        rationale: "Aman / Tokyo-grade serene wood, warm indirect shadow, deep soaking tub, zero visual clutter.",
        trait_tag: "aman-japanese-serenity",
        signal_value: 2,
        preview: {
          kind: "swatch",
          tokens: ["#D8CFC2", "#4A3F35", "#1E1B18", "warm indirect light"],
          sample_head: "Instant nervous-system drop",
          sample_body: "Quiet architectural peace the second the door shuts.",
          badge: "Aman Quiet",
        },
      },
      {
        key: "B",
        label: "Moody Mayfair Dark Oak & Velvet",
        rationale: "Dim lamp-lit library warmth, heavy blackout drapes, rich wood, intimate late-night sanctuary.",
        trait_tag: "moody-mayfair-sanctuary",
        signal_value: 1,
        preview: {
          kind: "swatch",
          tokens: ["#1A1512", "#3B2820", "#C4A46C", "heavy blackout"],
          sample_head: "Cocooned nocturnal luxury",
          sample_body: "Feels like a private members suite built for deep sleep.",
          badge: "Mayfair Moody",
        },
      },
      {
        key: "C",
        label: "Architectural Concrete & Big Daylight",
        rationale: "Floor-to-ceiling skyline glass, crisp stone, clean modern lines, inspiring desk to think.",
        trait_tag: "modern-skyline-glass",
        signal_value: -1,
        preview: {
          kind: "swatch",
          tokens: ["#E7E5E1", "#787A7C", "#18191B", "full-height glass"],
          sample_head: "Sharp high-altitude clarity",
          sample_body: "Great for work-plus-reset trips where light keeps energy high.",
          badge: "Skyline Modern",
        },
      },
      {
        key: "D",
        label: "Classic Grand Suite & Crisp White Linen",
        rationale: "High ceilings, tall windows, spotless white sheets, effortless five-star room service.",
        trait_tag: "grand-classic-suite",
        signal_value: -2,
        preview: {
          kind: "swatch",
          tokens: ["#FAF9F6", "#D4C9B8", "#2B2927", "high ceilings"],
          sample_head: "Timeless Claridge's polish",
          sample_body: "Proven luxury comfort with zero experimental design quirks.",
          badge: "Grand Classic",
        },
      },
    ],
  },
  {
    id: "q_spaces_dining_vibe",
    domain: "spaces_life",
    title: "What dining energy feels right when you go out properly?",
    context: "Filtering London restaurant picks for date nights, keto-friendly steak/seafood, or founder dinners.",
    axis: "Dining & Hospitality",
    source: "curated",
    priority: 93,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Dim Craft Counter (Omakase / Live Fire)",
        rationale: "Sit close to serious culinary mastery: clean protein, bold smoke or sashimi, zero fluff.",
        trait_tag: "craft-counter-omakase",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Obsessive craft, clean plates",
          sample_body: "Naturally keto-friendly, high theatre, zero generic filler.",
          badge: "Craft Counter",
        },
      },
      {
        key: "B",
        label: "Quiet Acoustic Intimacy, Invisible Service",
        rationale: "Spaced tables where you never shout, crisp service that anticipates without hovering.",
        trait_tag: "quiet-invisible-service",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "Real conversation comes first",
          sample_body: "Best for meaningful couple nights and high-stakes 1:1 dinners.",
          badge: "Quiet Luxury",
        },
      },
      {
        key: "C",
        label: "Buzzing Neighbourhood Bistro, Bold Food",
        rationale: "Warm unpretentious room, incredible ingredients, lively pulse without clubby gimmicks.",
        trait_tag: "bold-neighbourhood-bistro",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "High flavor, zero stiffness",
          sample_body: "Relaxed warmth where great cooking speaks for itself.",
          badge: "Bistro",
        },
      },
      {
        key: "D",
        label: "High-Precision Tasting Room",
        rationale: "Michelin-caliber pacing and surprise for rare milestone celebrations.",
        trait_tag: "michelin-tasting-theatre",
        signal_value: -2,
        preview: {
          kind: "copy",
          sample_head: "Event-level culinary direction",
          sample_body: "Saved for anniversaries and big wins worth marking properly.",
          badge: "Tasting Room",
        },
      },
    ],
  },

  // =========================================================================
  // 8. AGENT BEHAVIOR & REASONING (4)
  // =========================================================================
  {
    id: "q_ops_response_shape",
    domain: "agent_ops",
    title: "How should an agent answer a compressed 8-word ask from you?",
    context: "You fire a short 1-line prompt to Codex, Claude Code, or a local agent and expect the full shape.",
    axis: "Response Compression",
    source: "curated",
    priority: 91,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Ship Finished Thing + 3-Line Receipt",
        rationale: "Infer the complete bar, execute end-to-end, verify, and return only what changed plus proof.",
        trait_tag: "ship-plus-proof-receipt",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "Done. 41/41 tests green. PNG inspected.",
          sample_body: "Zero preamble, zero narration, full completeness attached.",
          badge: "Boil + Receipt",
        },
      },
      {
        key: "B",
        label: "One-Line Verdict + Expand on Demand",
        rationale: "Give the single sharpest answer in 1-2 lines; attach links/diffs if you want to drill in.",
        trait_tag: "one-line-verdict-first",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "Root cause was stale cache TTL; fixed and verified.",
          sample_body: "Respects mobile scan speed; zero essay bloat.",
          badge: "1-Line Verdict",
        },
      },
      {
        key: "C",
        label: "1 Sharpest Fork Question -> Then Full Build",
        rationale: "Only pause when a real irreversible fork exists; ask 1 multiple-choice card, then finish everything.",
        trait_tag: "one-fork-then-boil",
        signal_value: 0,
        preview: {
          kind: "copy",
          sample_head: "1 call needed: Light Revolut (Rec) or Dark Vault?",
          sample_body: "Prevents wasted direction without slipping into confirmation loops.",
          badge: "1 Fork -> Exec",
        },
      },
      {
        key: "D",
        label: "Compact 5-Bullet Executive Plan First",
        rationale: "Outline architecture, blast radius, and verification gates before mutating files.",
        trait_tag: "compact-plan-first",
        signal_value: -2,
        preview: {
          kind: "copy",
          sample_head: "Scope / Seams / Risks / Verification",
          sample_body: "Best only for rare high-blast-radius migrations.",
          badge: "Plan First",
        },
      },
    ],
  },
  {
    id: "q_ops_decision_framing",
    domain: "agent_ops",
    title: "When an agent hits a true gate, how should it frame the decision?",
    context: "Spend approval, outbound draft as you, or a major product fork needing a 2-second tap.",
    axis: "Decision Framing",
    source: "curated",
    priority: 89,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "1 Recommended Default + 2 Crisp Options",
        rationale: "Put the sharpest pick first with a 1-line why, plus two clean alternatives so tapping takes 2 seconds.",
        trait_tag: "recommended-mc-card",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "[A - Rec] Ship warm daylight flow | [B] Dark vault | [C] Hold",
          sample_body: "One live decision at a time; zero sprawling prose.",
          badge: "Rec + 2 Alts",
        },
      },
      {
        key: "B",
        label: "Show Live Visual / Draft, Not Description",
        rationale: "Never describe an option in adjectives; render the actual A/B mock or exact draft text to tap.",
        trait_tag: "artifact-over-prose-fork",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "[Poster A.png] vs [Poster B.png] -> Pick 1 or 2",
          sample_body: "Real pixels and real copy kill 90% of alignment waste.",
          badge: "Show Artifact",
        },
      },
      {
        key: "C",
        label: "Blunt Single Call + Downside Check",
        rationale: "Commit to one recommendation, state the exact downside if wrong, and ask for yes/no.",
        trait_tag: "single-call-with-downside",
        signal_value: 0,
        preview: {
          kind: "copy",
          sample_head: "Recommend X (90%). Downside: 2h rollback if Y fails. Go?",
          sample_body: "Highest velocity when the agent has deep context.",
          badge: "Single Call",
        },
      },
      {
        key: "D",
        label: "Structured Risk / Upside Matrix",
        rationale: "Compact 3-row table comparing cost, upside, reversibility, and timeline.",
        trait_tag: "structured-tradeoff-matrix",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "Option | Upside | Risk | Time",
          sample_body: "Useful for cap-table, fundraising, or legal forks.",
          badge: "Matrix",
        },
      },
    ],
  },
  {
    id: "q_ops_bluntness_pushback",
    domain: "agent_ops",
    title: "How hard should agents push back when your quick take has a flaw?",
    context: "Mid-build when real data, taste craft, or architecture shows a much stronger path than your first hunch.",
    axis: "Bluntness & Pushback",
    source: "curated",
    priority: 88,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Flat Truth on Line 1 + Proof",
        rationale: "Zero cushioning, zero apology: name why it breaks and show the better move immediately.",
        trait_tag: "flat-line1-truth",
        signal_value: 2,
        preview: {
          kind: "copy",
          sample_head: "That breaks mobile density. Here is the cleaner seam.",
          sample_body: "Saves time, protects quality, treats you like an operator.",
          badge: "Blunt Truth",
        },
      },
      {
        key: "B",
        label: "Build the Stronger Alternative Side-by-Side",
        rationale: "Don't lecture; render both your ask and the sharper invention live so the better one wins on sight.",
        trait_tag: "prove-by-building-better",
        signal_value: 1,
        preview: {
          kind: "copy",
          sample_head: "Built your spec (A) plus a sharper layout (B). Look at B.",
          sample_body: "Lets taste and proof settle disagreements instantly.",
          badge: "Show Better",
        },
      },
      {
        key: "C",
        label: "Flag Risk in 2 Lines, Respect Fast Override",
        rationale: "Register the objection cleanly once, never nag twice, and execute fast once you confirm.",
        trait_tag: "flag-once-obey-fast",
        signal_value: 0,
        preview: {
          kind: "copy",
          sample_head: "Risk noted in 2 lines. Say 'ship A' and it lands.",
          sample_body: "Sharp judgment without stubbornness or friction.",
          badge: "Flag Once",
        },
      },
      {
        key: "D",
        label: "Socratic Surgical Question",
        rationale: "Ask the one diagnostic question that reveals the hidden tradeoff without preaching.",
        trait_tag: "surgical-question-pushback",
        signal_value: -1,
        preview: {
          kind: "copy",
          sample_head: "If a stranger lands cold on this screen, what do they tap?",
          sample_body: "Keeps ownership crisp while testing assumptions.",
          badge: "Surgical Q",
        },
      },
    ],
  },
  {
    id: "q_ops_autonomy_cadence",
    domain: "agent_ops",
    title: "When should autonomous background agents ping you during the day?",
    context: "Tuning background agents, orchestrators, and Kizuki watchers across work sprints and family hours.",
    axis: "Proactive Interruption",
    source: "curated",
    priority: 86,
    created_at: CURATED_TIMESTAMP,
    options: [
      {
        key: "A",
        label: "Hard Gates, Real Failures & High Alpha Only",
        rationale: "Stay dead silent on routine green runs; wake you immediately only when action truly moves the needle.",
        trait_tag: "exception-and-alpha-only",
        signal_value: 2,
        preview: {
          kind: "motion",
          tokens: ["silent green", "instant red/gate", "0 noise"],
          sample_head: "Zero ambient notification tax",
          sample_body: "Every ping carries real consequence.",
          badge: "Signal Only",
        },
      },
      {
        key: "B",
        label: "Two Compressed Windows (AM + Post-22:00)",
        rationale: "Batch non-urgent updates into a crisp morning brief and a post-bedtime London wrap.",
        trait_tag: "batched-london-windows",
        signal_value: 1,
        preview: {
          kind: "motion",
          tokens: ["08:30 brief", "22:15 wrap", "family hours protected"],
          sample_head: "Respects school & bedtime rhythm",
          sample_body: "Protects family presence while keeping full visibility.",
          badge: "2x Windows",
        },
      },
      {
        key: "C",
        label: "Silent Execution; Pull Inside Kizuki",
        rationale: "Do everything silently into Kizuki and the ledger; zero unprompted pings unless blocked.",
        trait_tag: "pull-inside-kizuki",
        signal_value: 0,
        preview: {
          kind: "motion",
          tokens: ["pull-only", "ledger updated", "zero push"],
          sample_head: "Total focus sovereignty",
          sample_body: "You choose when to open the cockpit.",
          badge: "Pull Only",
        },
      },
      {
        key: "D",
        label: "Instant Milestone Pings + 1 Proof Still",
        rationale: "Send a fast one-liner with a screenshot whenever a major build or trade milestone lands.",
        trait_tag: "instant-proof-pings",
        signal_value: -1,
        preview: {
          kind: "motion",
          tokens: ["shipped ping", "1 PNG proof", "high momentum"],
          sample_head: "Real-time build momentum",
          sample_body: "Feels like a fast studio floor shipping all day.",
          badge: "Live Ships",
        },
      },
    ],
  },
];

interface BaselineRuleSeed {
  id: string;
  domain: TasteDomainId;
  polarity: TasteRulePolarity;
  rule: string;
  reason: string;
  vaultRel?: string;
}

const BASELINE_RULE_SEEDS: readonly BaselineRuleSeed[] = [
  {
    id: "base_prefer_specificity",
    domain: "typography_copy",
    polarity: "prefer",
    rule: "Specificity beats polish: every artifact needs an enemy, a stake, a real user, and a sentence worth stealing.",
    reason: "Core doctrine from owner-profile.md and Taste Vault Doctrine.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_avoid_corpse_words",
    domain: "typography_copy",
    polarity: "avoid",
    rule: "Never use corporate corpse words: unlock, empower, seamless, robust, next-generation, cutting-edge, revolutionary, innovative.",
    reason: "Banned in owner-profile.md and Voice & Phrases.",
    vaultRel: "auto/entities/05-knowledge/taste/voice-and-phrases.md",
  },
  {
    id: "base_avoid_em_dashes",
    domain: "typography_copy",
    polarity: "avoid",
    rule: "Zero em-dashes in any outward or internal artifact; use plain hyphens, colons, or clean periods.",
    reason: "Standing preference in owner-profile.md.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_prefer_consumer_clarity",
    domain: "ui_product",
    polarity: "prefer",
    rule: "Consumer finance UI puts product clarity and action confidence first, one decision per screen.",
    reason: "Core bar in Consumer UI Principles.",
    vaultRel: "auto/entities/05-knowledge/taste/consumer-ui-principles.md",
  },
  {
    id: "base_avoid_lava_lamp_slop",
    domain: "visual_brand",
    polarity: "avoid",
    rule: "Never use purple-blue-pink AI lava-lamp gradients, generic default typefaces (Inter/Poppins/Arial), or centered SaaS template symmetry.",
    reason: "Craft anti-patterns locked in Taste Vault.",
    vaultRel: "auto/entities/05-knowledge/craft/anti-patterns/ai-lava-lamp-gradients.md",
  },
  {
    id: "base_prefer_live_data_motion",
    domain: "motion_feel",
    polarity: "prefer",
    rule: "Bind UI and live dashboard motion to real data events; never add fake idle pulses or decorative breathing loops.",
    reason: "Information-bearing motion craft rule.",
    vaultRel: "auto/entities/05-knowledge/taste/ui-and-visual-language.md",
  },
  {
    id: "base_prefer_satsuei_anime",
    domain: "video_anime",
    polarity: "prefer",
    rule: "Anime-over-real-world scenes require genuine rigged 3D/Live2D models or layered satsuei 2s/3s cels over 1s worlds, never primitive dolls.",
    reason: "Locked high-conviction verdict from the owner taste ledger.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_prefer_merch_mc_first",
    domain: "merch_objects",
    polarity: "prefer",
    rule: "When physical object or merch preferences are thin in existing docs, run 3-5 crisp multiple-choice forks before committing to a batch.",
    reason: "Explicit calibration protocol in owner-profile.md.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_prefer_step_free_first",
    domain: "spaces_life",
    polarity: "prefer",
    rule: "Verify step-free access on every family trip: single-level or verified lifts, zero stairs-only venues or bunk-only lofts.",
    reason: "Non-negotiable accessibility constraint in owner-profile.md.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_prefer_stretch_outward",
    domain: "spaces_life",
    polarity: "prefer",
    rule: "Evenings out should stretch outward into theatre, culture, and warm dining rather than defaulting to staying in.",
    reason: "Household preference in owner-profile.md.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_prefer_boil_compressed",
    domain: "agent_ops",
    polarity: "prefer",
    rule: "Reconstruct full intent from compressed short asks, execute to completeness, and report concrete state changes with proof.",
    reason: "Core operating bar in owner-profile.md.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
  {
    id: "base_avoid_verbose_essays",
    domain: "agent_ops",
    polarity: "avoid",
    rule: "Never reply to short asks with verbose essays, confirmation loops, permission chatter, or generic assistant apologies.",
    reason: "Top correction trigger in owner-profile.md.",
    vaultRel: "auto/entities/05-knowledge/owner-profile.md",
  },
];

interface ParsedFrontmatterDoc {
  frontmatter: Record<string, string>;
  title: string;
  summary: string;
}

function parseMarkdownDoc(raw: string, fallbackName: string): ParsedFrontmatterDoc {
  const fm: Record<string, string> = {};
  let body = raw;
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fmMatch) {
    body = raw.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = /^([A-Za-z0-9_-]+)\s*:\s*(.+)$/.exec(line.trim());
      if (!m) continue;
      const key = m[1].toLowerCase();
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      fm[key] = sanitizeTasteText(val);
    }
  }

  let title = fm.title || "";
  if (!title) {
    const h1 = /^#\s+(.+)$/m.exec(body);
    if (h1) title = sanitizeTasteText(h1[1]);
  }
  if (!title) {
    title = sanitizeTasteText(
      fallbackName
        .replace(/\.md$/i, "")
        .replace(/[-_]+/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  // Extract first meaningful paragraph or Rule line
  const ruleLine = /\*\*Rule:\*\*\s*(.+)/i.exec(body);
  let summary = "";
  if (ruleLine) {
    summary = truncateClean(ruleLine[1], 220);
  } else {
    const blocks = body
      .split(/\r?\n\s*\r?\n/)
      .map((b) => b.trim())
      .filter((b) => b && !b.startsWith("#") && !b.startsWith("```") && !b.startsWith("---"));
    for (const block of blocks) {
      const cleaned = sanitizeTasteText(
        block
          .replace(/^>\s*/gm, "")
          .replace(/^[-*]\s+/gm, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
      );
      if (cleaned.length >= 24) {
        summary = truncateClean(cleaned, 220);
        break;
      }
    }
  }
  if (!summary) {
    summary = truncateClean(body.replace(/^#+\s+.+$/gm, ""), 200) || title;
  }

  return { frontmatter: fm, title, summary };
}

function classifyDocDomain(filename: string, title: string, medium: string): TasteDomainId {
  const hay = `${filename} ${title} ${medium}`.toLowerCase();
  if (/\b(agent-identity|agent|persona|familiar)\b/.test(hay)) return "agent_ops";
  if (/\b(motion|reel|launch-v|vision-pro|arc-browser|teenage-engineering)\b/.test(hay)) return "motion_feel";
  if (/\b(a24|film|video|anime|trailer|cinema|grading|sound)\b/.test(hay)) return "video_anime";
  if (/\b(ui|consumer-ui|dashboard|vercel|intent-veil|interface)\b/.test(hay)) return "ui_product";
  if (/\b(voice|phrase|copy|anti-example|banned-phrase|typeface|outreach|x-post)\b/.test(hay)) {
    return "typography_copy";
  }
  if (/\b(merch|object|apparel|packaging|gift|nothing-phone)\b/.test(hay)) return "merch_objects";
  if (/\b(travel|hotel|london|space|dining|family)\b/.test(hay)) return "spaces_life";
  return "visual_brand";
}

function classifyDocCategory(
  isAntiPatternDir: boolean,
  filename: string,
  polarityRaw: string
): { category: TasteVaultDoc["category"]; polarity: TasteVaultDoc["polarity"] } {
  const lower = filename.toLowerCase();
  const pol = polarityRaw.toLowerCase();
  if (isAntiPatternDir) {
    return { category: "anti_pattern", polarity: "avoid" };
  }
  if (pol.includes("anti") || lower.includes("anti-") || lower.includes("failed-") || lower.includes("rejected")) {
    return { category: "anti_example", polarity: "avoid" };
  }
  if (lower.includes("doctrine")) {
    return { category: "doctrine", polarity: "prefer" };
  }
  if (lower.includes("readme") || lower.includes("template")) {
    return { category: "reference", polarity: "neutral" };
  }
  return { category: "exemplar", polarity: "prefer" };
}

function computeStreakCount(answers: TasteAnswerRecord[]): number {
  if (answers.length === 0) return 0;
  const sorted = [...answers].sort(
    (a, b) => Date.parse(b.answered_at || "0") - Date.parse(a.answered_at || "0")
  );
  let streak = 1;
  const MAX_GAP_MS = 36 * 60 * 60 * 1000;
  for (let i = 1; i < sorted.length; i++) {
    const prevTs = Date.parse(sorted[i - 1].answered_at || "0");
    const currTs = Date.parse(sorted[i].answered_at || "0");
    if (!Number.isFinite(prevTs) || !Number.isFinite(currTs)) break;
    if (Math.abs(prevTs - currTs) <= MAX_GAP_MS) {
      streak += 1;
    } else {
      break;
    }
  }
  return streak;
}

function extractJsonArrayFromLlm(rawText: string): unknown[] {
  const trimmed = (rawText || "").trim();
  if (!trimmed) return [];

  const candidates: string[] = [];
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fenceRegex.exec(trimmed)) !== null) {
    if (match[1] && match[1].trim()) candidates.push(match[1].trim());
  }
  candidates.push(trimmed);

  // Also try extracting first [...] slice
  const firstBracket = trimmed.indexOf("[");
  const lastBracket = trimmed.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket > firstBracket) {
    candidates.push(trimmed.slice(firstBracket, lastBracket + 1));
  }

  for (const cand of candidates) {
    try {
      const parsed = JSON.parse(cand) as unknown;
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.questions)) return obj.questions;
        if (Array.isArray(obj.items)) return obj.items;
      }
    } catch {
      // try next candidate
    }
  }
  return [];
}

function sanitizePreview(raw: unknown): TasteOptionPreview | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const rawKind = typeof obj.kind === "string" ? obj.kind.trim().toLowerCase() : "";
  const kind: TastePreviewKind = VALID_PREVIEW_KINDS.has(rawKind as TastePreviewKind)
    ? (rawKind as TastePreviewKind)
    : "copy";

  const tokens = Array.isArray(obj.tokens)
    ? obj.tokens
        .filter((t): t is string => typeof t === "string" && t.trim().length > 0)
        .map((t) => truncateClean(t, 40))
        .filter(Boolean)
        .slice(0, 6)
    : undefined;

  const sample_head =
    typeof obj.sample_head === "string" && obj.sample_head.trim()
      ? truncateClean(obj.sample_head, 90)
      : undefined;
  const sample_body =
    typeof obj.sample_body === "string" && obj.sample_body.trim()
      ? truncateClean(obj.sample_body, 180)
      : undefined;
  const badge =
    typeof obj.badge === "string" && obj.badge.trim() ? truncateClean(obj.badge, 32) : undefined;

  if (!tokens?.length && !sample_head && !sample_body && !badge) return undefined;
  return {
    kind,
    ...(tokens && tokens.length > 0 ? { tokens } : {}),
    ...(sample_head ? { sample_head } : {}),
    ...(sample_body ? { sample_body } : {}),
    ...(badge ? { badge } : {}),
  };
}

export class KizukiTasteApi {
  readonly vaultPath: string;
  readonly lifeOsWikiPath: string | null;
  readonly gardenPath: string | null;
  readonly profilePath: string;
  readonly codexPath: string;
  private crosslinksProvider:
    | (() => Map<string, TasteCrosslinkRef[]> | Record<string, TasteCrosslinkRef[]>)
    | null = null;

  constructor(config: TasteApiConfig = {}) {
    this.vaultPath = config.vaultPath || DEFAULT_TASTE_VAULT_PATH;
    this.lifeOsWikiPath =
      config.lifeOsWikiPath === undefined ? DEFAULT_TASTE_WIKI_PATH : config.lifeOsWikiPath;
    this.gardenPath =
      config.gardenPath === undefined ? DEFAULT_TASTE_GARDEN_PATH : config.gardenPath;
    this.profilePath = join(this.vaultPath, "world", "taste-profile.json");
    this.codexPath = join(this.vaultPath, "world", "taste-codex.md");
  }

  private emptyStore(): TasteProfileStore {
    return {
      version: 1,
      updated_at: new Date().toISOString(),
      answers: [],
      skipped_ids: [],
      custom_rules: [],
      dynamic_questions: [],
    };
  }

  private loadStore(): TasteProfileStore {
    if (!existsSync(this.profilePath)) {
      return this.emptyStore();
    }
    try {
      const raw = JSON.parse(readFileSync(this.profilePath, "utf8")) as Partial<TasteProfileStore>;
      return {
        version: 1,
        updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
        answers: Array.isArray(raw.answers) ? raw.answers : [],
        skipped_ids: Array.isArray(raw.skipped_ids)
          ? raw.skipped_ids.filter((x): x is string => typeof x === "string")
          : [],
        custom_rules: Array.isArray(raw.custom_rules) ? raw.custom_rules : [],
        dynamic_questions: Array.isArray(raw.dynamic_questions) ? raw.dynamic_questions : [],
      };
    } catch {
      return this.emptyStore();
    }
  }

  private saveStore(store: TasteProfileStore): void {
    store.updated_at = new Date().toISOString();
    atomicWriteFile(this.profilePath, stripEmDashes(JSON.stringify(store, null, 2) + "\n"), 0o600);
  }

  private resolveVaultDocPath(candidateRel: string | undefined): string | undefined {
    if (!candidateRel) return undefined;
    const normalized = candidateRel.replace(/^\/+/, "").replace(/\/+/g, "/");
    if (!normalized.endsWith(".md") || normalized.includes("..")) return undefined;
    const full = join(this.vaultPath, normalized);
    if (existsSync(full)) return normalized;

    // Fallback for lowercase filename mirror (e.g. README.md -> readme.md)
    const dir = dirname(normalized);
    const lowerBase = basename(normalized).toLowerCase();
    const lowerRel = dir === "." ? lowerBase : `${dir}/${lowerBase}`;
    if (existsSync(join(this.vaultPath, lowerRel))) {
      return lowerRel;
    }
    return undefined;
  }

  private getAllQuestions(store: TasteProfileStore): TasteQuestion[] {
    const seen = new Set<string>();
    const all: TasteQuestion[] = [];
    for (const q of CURATED_TASTE_QUESTIONS) {
      seen.add(q.id);
      all.push(q);
    }
    for (const dq of store.dynamic_questions) {
      if (!dq || !dq.id || seen.has(dq.id)) continue;
      seen.add(dq.id);
      all.push(dq);
    }
    return all;
  }

  private discoverVaultDocs(): TasteVaultDoc[] {
    const docs: TasteVaultDoc[] = [];
    const seenIds = new Set<string>();

    const scanDir = (
      dirPath: string | null,
      wikiRelPrefix: string,
      isAntiPatternDir: boolean
    ) => {
      if (!dirPath || !existsSync(dirPath)) return;
      let entries: string[];
      try {
        entries = readdirSync(dirPath)
          .filter((f) => f.toLowerCase().endsWith(".md"))
          .sort((a, b) => a.localeCompare(b));
      } catch {
        return;
      }

      for (const fn of entries) {
        const fullPath = join(dirPath, fn);
        const relSource = `${wikiRelPrefix}/${fn}`;
        const id = `tdoc_${slugify(wikiRelPrefix.replace(/\//g, "_") + "_" + fn.replace(/\.md$/i, ""))}`;
        if (seenIds.has(id)) continue;

        let raw = "";
        let updatedAt = new Date().toISOString();
        try {
          raw = readFileSync(fullPath, "utf8");
          updatedAt = statSync(fullPath).mtime.toISOString();
        } catch {
          continue;
        }

        const parsed = parseMarkdownDoc(raw, fn);
        const medium = parsed.frontmatter.medium || (isAntiPatternDir ? "anti-pattern" : "taste");
        const brand = parsed.frontmatter.brand || "Owner";
        const domain = classifyDocDomain(fn, parsed.title, medium);
        const { category, polarity } = classifyDocCategory(
          isAntiPatternDir,
          fn,
          parsed.frontmatter.polarity || ""
        );
        const vaultDocPath = this.resolveVaultDocPath(`auto/entities/${relSource}`);

        seenIds.add(id);
        docs.push({
          id,
          title: sanitizeTasteText(parsed.title),
          domain,
          category,
          polarity,
          medium: sanitizeTasteText(medium),
          brand: sanitizeTasteText(brand),
          summary: sanitizeTasteText(parsed.summary),
          source_path: relSource,
          ...(vaultDocPath ? { vault_doc_path: vaultDocPath } : {}),
          updated_at: updatedAt,
        });
      }
    };

    if (this.lifeOsWikiPath) {
      scanDir(join(this.lifeOsWikiPath, "05-knowledge", "taste"), "05-knowledge/taste", false);
      scanDir(
        join(this.lifeOsWikiPath, "05-knowledge", "craft", "anti-patterns"),
        "05-knowledge/craft/anti-patterns",
        true
      );
    }

    // Fallback: also scan vault mirrors directly so vault-only environments still discover Taste Vault docs
    scanDir(
      join(this.vaultPath, "auto", "entities", "05-knowledge", "taste"),
      "05-knowledge/taste",
      false
    );
    scanDir(
      join(this.vaultPath, "auto", "entities", "05-knowledge", "craft", "anti-patterns"),
      "05-knowledge/craft/anti-patterns",
      true
    );

    const categoryRank: Record<TasteVaultDoc["category"], number> = {
      doctrine: 0,
      exemplar: 1,
      anti_example: 2,
      anti_pattern: 3,
      reference: 4,
    };

    docs.sort((a, b) => {
      const rankDiff = categoryRank[a.category] - categoryRank[b.category];
      if (rankDiff !== 0) return rankDiff;
      return a.title.localeCompare(b.title);
    });

    return docs;
  }

  private buildRules(store: TasteProfileStore, questionById: Map<string, TasteQuestion>): {
    prefer: TasteRule[];
    avoid: TasteRule[];
  } {
    const prefer: TasteRule[] = [];
    const avoid: TasteRule[] = [];
    const seenNorm = new Set<string>();

    const pushRule = (rule: TasteRule) => {
      const norm = `${rule.polarity}:${normalizeDedupKey(rule.rule)}`;
      if (!rule.rule || seenNorm.has(norm)) return;
      seenNorm.add(norm);
      const links = this.getCrosslinksForRule(rule.id);
      const enriched = links.length > 0 ? { ...rule, links } : rule;
      if (enriched.polarity === "prefer") prefer.push(enriched);
      else avoid.push(enriched);
    };

    // 1. Custom owner rules first (highest precedence, editable)
    const sortedCustom = [...store.custom_rules].sort(
      (a, b) => Date.parse(b.created_at || "0") - Date.parse(a.created_at || "0")
    );
    for (const cr of sortedCustom) {
      pushRule({
        id: cr.id,
        domain: cr.domain,
        polarity: cr.polarity,
        rule: sanitizeTasteText(cr.rule),
        ...(cr.reason ? { reason: sanitizeTasteText(cr.reason) } : {}),
        source: "custom",
        editable: true,
        created_at: cr.created_at,
      });
    }

    // 2. Derived rules from recorded answers
    const sortedAnswers = [...store.answers].sort(
      (a, b) => Date.parse(b.answered_at || "0") - Date.parse(a.answered_at || "0")
    );
    for (const ans of sortedAnswers) {
      const q = questionById.get(ans.question_id);
      const opt = q?.options.find((o) => o.key === ans.chosen_key);
      const derivedText = sanitizeTasteText(
        `${ans.axis}: ${ans.chosen_label}${opt?.rationale ? ` - ${opt.rationale}` : ""}`
      );
      const reason = ans.note
        ? sanitizeTasteText(`Owner note: ${ans.note}`)
        : sanitizeTasteText(`Calibrated via "${q?.title || ans.question_id}" (${ans.trait_tag}).`);
      pushRule({
        id: `derived_${ans.question_id}`,
        domain: ans.domain,
        polarity: "prefer",
        rule: truncateClean(derivedText, 240),
        reason,
        source: "derived",
        editable: false,
        created_at: ans.answered_at,
        question_id: ans.question_id,
      });
    }

    // 3. Curated baseline rules grounded in owner-profile.md & Taste Vault
    for (const seed of BASELINE_RULE_SEEDS) {
      const vaultDocPath = this.resolveVaultDocPath(seed.vaultRel);
      pushRule({
        id: seed.id,
        domain: seed.domain,
        polarity: seed.polarity,
        rule: sanitizeTasteText(seed.rule),
        reason: sanitizeTasteText(seed.reason),
        source: "baseline",
        editable: false,
        created_at: CURATED_TIMESTAMP,
        ...(vaultDocPath ? { vault_doc_path: vaultDocPath } : {}),
      });
    }

    return { prefer, avoid };
  }

  private buildStateFromStore(store: TasteProfileStore, opts?: { domain?: string }): TasteStateResponse {
    const allQuestions = this.getAllQuestions(store);
    const questionById = new Map<string, TasteQuestion>(allQuestions.map((q) => [q.id, q]));
    const answerByQuestionId = new Map<string, TasteAnswerRecord>();
    for (const a of store.answers) {
      answerByQuestionId.set(a.question_id, a);
    }

    const skippedSet = new Set<string>(
      store.skipped_ids.filter((id) => questionById.has(id) && !answerByQuestionId.has(id))
    );

    // Build domain summaries across all 8 domains
    const domainTotals = new Map<TasteDomainId, number>();
    const domainAnswers = new Map<TasteDomainId, TasteAnswerRecord[]>();
    for (const d of TASTE_DOMAINS) {
      domainTotals.set(d.id, 0);
      domainAnswers.set(d.id, []);
    }

    for (const q of allQuestions) {
      domainTotals.set(q.domain, (domainTotals.get(q.domain) || 0) + 1);
    }

    const sortedAnswers = [...store.answers].sort(
      (a, b) => Date.parse(b.answered_at || "0") - Date.parse(a.answered_at || "0")
    );
    for (const ans of sortedAnswers) {
      const list = domainAnswers.get(ans.domain);
      if (list) list.push(ans);
    }

    const domains: TasteDomainSummary[] = TASTE_DOMAINS.map((def) => {
      const total = domainTotals.get(def.id) || 0;
      const ansList = domainAnswers.get(def.id) || [];
      const answered = ansList.length;
      const pct = total > 0 ? Math.round((answered / total) * 100) : 0;

      const traits: string[] = [];
      const seenTraits = new Set<string>();
      const verdicts: string[] = [];
      for (const a of ansList) {
        if (a.trait_tag && !seenTraits.has(a.trait_tag)) {
          seenTraits.add(a.trait_tag);
          traits.push(sanitizeTasteText(a.trait_tag));
        }
        if (verdicts.length < 4) {
          verdicts.push(sanitizeTasteText(`${a.axis}: ${a.chosen_label}`));
        }
      }

      return {
        id: def.id,
        label: def.label,
        description: def.description,
        answered,
        total,
        pct,
        signature_traits: traits.slice(0, 6),
        recent_verdicts: verdicts,
      };
    });

    const domainPctMap = new Map<TasteDomainId, TasteDomainSummary>(domains.map((d) => [d.id, d]));

    // Build prioritized unanswered queue (excluding skipped)
    const filterDomain =
      opts?.domain && opts.domain.trim() && opts.domain.trim() !== "all"
        ? opts.domain.trim()
        : undefined;

    const unansweredAll = allQuestions.filter(
      (q) => !answerByQuestionId.has(q.id) && !skippedSet.has(q.id)
    );

    const queue = unansweredAll
      .filter((q) => (!filterDomain ? true : q.domain === filterDomain))
      .sort((a, b) => {
        const da = domainPctMap.get(a.domain);
        const db = domainPctMap.get(b.domain);
        const pctDiff = (da?.pct ?? 0) - (db?.pct ?? 0);
        if (pctDiff !== 0) return pctDiff;

        const ansDiff = (da?.answered ?? 0) - (db?.answered ?? 0);
        if (ansDiff !== 0) return ansDiff;

        const prioDiff = (b.priority || 0) - (a.priority || 0);
        if (prioDiff !== 0) return prioDiff;

        return a.id.localeCompare(b.id);
      });

    const answeredHistory: TasteAnswerHistoryItem[] = sortedAnswers.map((a) => {
      const q = questionById.get(a.question_id);
      return {
        ...a,
        question_title: q?.title || a.question_id,
        question_context: q?.context || "",
      };
    });

    const rules = this.buildRules(store, questionById);
    const vaultDocs = this.discoverVaultDocs();

    const totalQuestions = allQuestions.length;
    const answeredCount = store.answers.filter((a) => questionById.has(a.question_id)).length;
    const skippedCount = skippedSet.size;
    const remainingCount = unansweredAll.length;
    const calibrationPct = totalQuestions > 0 ? Math.round((answeredCount / totalQuestions) * 100) : 0;

    return {
      stats: {
        total_questions: totalQuestions,
        answered_count: answeredCount,
        remaining_count: remainingCount,
        skipped_count: skippedCount,
        custom_rules_count: store.custom_rules.length,
        vault_docs_count: vaultDocs.length,
        calibration_pct: calibrationPct,
        streak_count: computeStreakCount(store.answers),
      },
      domains,
      queue,
      answered_history: answeredHistory,
      rules,
      vault_docs: vaultDocs,
      compiled_codex_path: "world/taste-codex.md",
    };
  }

  compileTasteCodex(storeOverride?: TasteProfileStore): string {
    const store = storeOverride || this.loadStore();
    const state = this.buildStateFromStore(store);
    const nowIso = new Date().toISOString();

    const allTraits: string[] = [];
    const seenTrait = new Set<string>();
    for (const d of state.domains) {
      for (const t of d.signature_traits) {
        if (!seenTrait.has(t)) {
          seenTrait.add(t);
          allTraits.push(t);
        }
      }
    }

    const lines: string[] = [
      "# Owner Taste Codex",
      "",
      "Auto-compiled agent-readable taste canon from `world/taste-profile.json`, `owner-profile.md`, and the Taste Vault.",
      "Read this before generating UI, copy, brand systems, motion, video/anime, merch, family/couple plans, or agent outputs.",
      "",
      `- **Last Compiled**: ${nowIso}`,
      `- **Calibration Coverage**: ${state.stats.answered_count} / ${state.stats.total_questions} questions (${state.stats.calibration_pct}%)`,
      `- **Active Calibration Streak**: ${state.stats.streak_count}`,
      `- **Locked Custom Rules**: ${state.stats.custom_rules_count}`,
      `- **Indexed Taste Vault Docs**: ${state.stats.vault_docs_count}`,
      `- **Signature Traits**: ${allTraits.length > 0 ? allTraits.slice(0, 14).join(", ") : "None calibrated yet"}`,
      "",
      "## Domain Profiles",
      "",
    ];

    for (const d of state.domains) {
      lines.push(`### ${d.label} (\`${d.id}\`) - ${d.answered}/${d.total} (${d.pct}%)`);
      lines.push(`- **Focus**: ${d.description}`);
      lines.push(
        `- **Signature Traits**: ${d.signature_traits.length > 0 ? d.signature_traits.join(", ") : "Uncalibrated (prioritize next)"}`
      );
      if (d.recent_verdicts.length > 0) {
        lines.push("- **Locked Verdicts**:");
        for (const v of d.recent_verdicts) {
          lines.push(`  - ${v}`);
        }
      }
      lines.push("");
    }

    lines.push("## Locked Prefer Rules", "");
    for (const r of state.rules.prefer) {
      const domLabel = DOMAIN_MAP.get(r.domain)?.label || r.domain;
      const tag = r.source === "custom" ? "Custom" : r.source === "derived" ? "Calibrated" : "Baseline";
      const reasonSuffix = r.reason ? ` (${r.reason})` : "";
      lines.push(`- **[${tag} | ${domLabel}]** ${r.rule}${reasonSuffix}`);
    }

    lines.push("", "## Locked Avoid Rules", "");
    for (const r of state.rules.avoid) {
      const domLabel = DOMAIN_MAP.get(r.domain)?.label || r.domain;
      const tag = r.source === "custom" ? "Custom" : r.source === "derived" ? "Calibrated" : "Baseline";
      const reasonSuffix = r.reason ? ` (${r.reason})` : "";
      lines.push(`- **[${tag} | ${domLabel}]** ${r.rule}${reasonSuffix}`);
    }

    lines.push("", "## Recent Calibration Verdicts", "");
    if (state.answered_history.length === 0) {
      lines.push("- No rapid-fire calibration answers recorded yet.");
    } else {
      for (const h of state.answered_history.slice(0, 20)) {
        const day = (h.answered_at || "").slice(0, 10) || "unknown-date";
        const domLabel = DOMAIN_MAP.get(h.domain)?.label || h.domain;
        const notePart = h.note ? ` | Note: ${h.note}` : "";
        lines.push(
          `- **${day}** [${domLabel}] **${h.axis}**: ${h.chosen_label} (\`${h.trait_tag}\`, signal ${h.signal_value}) - Q: ${h.question_title}${notePart}`
        );
      }
    }

    if (state.vault_docs.length > 0) {
      lines.push("", "## Taste Vault Reference Anchors", "");
      for (const doc of state.vault_docs.slice(0, 20)) {
        const pathLabel = doc.vault_doc_path || doc.source_path;
        lines.push(`- \`${pathLabel}\` (${doc.category} / ${doc.polarity}): **${doc.title}** - ${doc.summary}`);
      }
    }

    const markdown = stripEmDashes(lines.join("\n").trim() + "\n");
    atomicWriteFile(this.codexPath, markdown, 0o600);
    return markdown;
  }

  setCrosslinksProvider(
    provider: (() => Map<string, TasteCrosslinkRef[]> | Record<string, TasteCrosslinkRef[]>) | null
  ): void {
    this.crosslinksProvider = provider;
  }

  getCrosslinksForRule(id: string): TasteCrosslinkRef[] {
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

  listAllRules(): TasteRule[] {
    const state = this.getTasteState();
    return [...state.rules.prefer, ...state.rules.avoid];
  }

  getAnsweredHistory(): TasteAnswerHistoryItem[] {
    return this.getTasteState().answered_history;
  }

  getTasteState(opts?: { domain?: string }): TasteStateResponse {
    const store = this.loadStore();
    return this.buildStateFromStore(store, opts);
  }

  submitAnswer(req: SubmitAnswerRequest): SubmitAnswerResponse {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Request body must be an object");
    }
    const questionId = typeof req.question_id === "string" ? req.question_id.trim() : "";
    if (!questionId) {
      throw new BadRequestError("question_id is required");
    }
    const rawKey = typeof req.chosen_key === "string" ? req.chosen_key.trim().toUpperCase() : "";
    if (!VALID_OPTION_KEYS.includes(rawKey as TasteOptionKey)) {
      throw new BadRequestError("chosen_key must be one of A, B, C, D");
    }
    const chosenKey = rawKey as TasteOptionKey;

    const store = this.loadStore();
    const allQuestions = this.getAllQuestions(store);
    const question = allQuestions.find((q) => q.id === questionId);
    if (!question) {
      throw new NotFoundError(`Taste question not found: ${questionId}`);
    }

    const option = question.options.find((o) => o.key === chosenKey);
    if (!option) {
      throw new BadRequestError(`Option ${chosenKey} not found on question ${questionId}`);
    }

    const cleanNote =
      typeof req.note === "string" && req.note.trim() ? truncateClean(req.note, 500) : undefined;

    const answer: TasteAnswerRecord = {
      question_id: question.id,
      domain: question.domain,
      axis: sanitizeTasteText(question.axis),
      chosen_key: option.key,
      chosen_label: sanitizeTasteText(option.label),
      trait_tag: sanitizeTasteText(option.trait_tag),
      signal_value: option.signal_value,
      ...(cleanNote ? { note: cleanNote } : {}),
      answered_at: new Date().toISOString(),
    };

    // Replace existing answer if re-answering, moving to end (most recent)
    store.answers = store.answers.filter((a) => a.question_id !== question.id);
    store.answers.push(answer);

    // Remove from skipped_ids if previously skipped
    store.skipped_ids = store.skipped_ids.filter((id) => id !== question.id);

    this.saveStore(store);
    this.compileTasteCodex(store);

    const state = this.buildStateFromStore(store);
    return {
      ok: true,
      answer,
      next_question: state.queue[0] || null,
      state,
    };
  }

  skipQuestion(questionId: string): SkipQuestionResponse {
    const cleanId = typeof questionId === "string" ? questionId.trim() : "";
    if (!cleanId) {
      throw new BadRequestError("question_id is required");
    }

    const store = this.loadStore();
    const allQuestions = this.getAllQuestions(store);
    const exists = allQuestions.some((q) => q.id === cleanId);
    if (!exists) {
      throw new NotFoundError(`Taste question not found: ${cleanId}`);
    }

    const alreadyAnswered = store.answers.some((a) => a.question_id === cleanId);
    if (!alreadyAnswered && !store.skipped_ids.includes(cleanId)) {
      store.skipped_ids.push(cleanId);
      this.saveStore(store);
    }

    const state = this.buildStateFromStore(store);
    return {
      ok: true,
      skipped_id: cleanId,
      next_question: state.queue[0] || null,
      state,
    };
  }

  undoLastAnswer(): UndoAnswerResponse {
    const store = this.loadStore();
    if (store.answers.length === 0) {
      const state = this.buildStateFromStore(store);
      return { ok: true, undone: null, state };
    }

    // Remove the most recently answered entry (by timestamp, breaking ties by last position)
    let latestIdx = store.answers.length - 1;
    let latestTs = Date.parse(store.answers[latestIdx].answered_at || "0");
    for (let i = store.answers.length - 2; i >= 0; i--) {
      const ts = Date.parse(store.answers[i].answered_at || "0");
      if (ts > latestTs) {
        latestTs = ts;
        latestIdx = i;
      }
    }

    const [undone] = store.answers.splice(latestIdx, 1);
    this.saveStore(store);
    this.compileTasteCodex(store);

    const state = this.buildStateFromStore(store);
    return {
      ok: true,
      undone,
      state,
    };
  }

  upsertRule(req: UpsertRuleRequest): UpsertRuleResponse {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Request body must be an object");
    }
    const rawDomain = typeof req.domain === "string" ? req.domain.trim() : "";
    if (!isTasteDomainId(rawDomain)) {
      throw new BadRequestError(
        `Invalid domain "${rawDomain}". Must be one of: ${TASTE_DOMAINS.map((d) => d.id).join(", ")}`
      );
    }
    const rawPolarity = typeof req.polarity === "string" ? req.polarity.trim().toLowerCase() : "";
    if (rawPolarity !== "prefer" && rawPolarity !== "avoid") {
      throw new BadRequestError('polarity must be "prefer" or "avoid"');
    }
    const cleanRule = typeof req.rule === "string" ? truncateClean(req.rule, 320) : "";
    if (!cleanRule) {
      throw new BadRequestError("rule text is required");
    }
    const cleanReason =
      typeof req.reason === "string" && req.reason.trim() ? truncateClean(req.reason, 240) : undefined;

    const store = this.loadStore();
    const nowIso = new Date().toISOString();
    const requestedId = typeof req.id === "string" ? req.id.trim() : "";

    let savedRule: TasteCustomRule;
    if (requestedId) {
      const idx = store.custom_rules.findIndex((r) => r.id === requestedId);
      if (idx !== -1) {
        savedRule = {
          ...store.custom_rules[idx],
          domain: rawDomain,
          polarity: rawPolarity,
          rule: cleanRule,
          ...(cleanReason ? { reason: cleanReason } : {}),
        };
        if (!cleanReason) delete savedRule.reason;
        store.custom_rules[idx] = savedRule;
      } else {
        savedRule = {
          id: requestedId,
          domain: rawDomain,
          polarity: rawPolarity,
          rule: cleanRule,
          ...(cleanReason ? { reason: cleanReason } : {}),
          created_at: nowIso,
        };
        store.custom_rules.push(savedRule);
      }
    } else {
      savedRule = {
        id: `trule_${rawDomain}_${slugify(cleanRule).slice(0, 20)}_${randomUUID().slice(0, 6)}`,
        domain: rawDomain,
        polarity: rawPolarity,
        rule: cleanRule,
        ...(cleanReason ? { reason: cleanReason } : {}),
        created_at: nowIso,
      };
      store.custom_rules.push(savedRule);
    }

    this.saveStore(store);
    this.compileTasteCodex(store);

    const state = this.buildStateFromStore(store);
    return {
      ok: true,
      rule: savedRule,
      state,
    };
  }

  deleteRule(id: string): DeleteRuleResponse {
    const cleanId = typeof id === "string" ? id.trim() : "";
    if (!cleanId) {
      throw new BadRequestError("rule id is required");
    }

    const store = this.loadStore();
    const before = store.custom_rules.length;
    store.custom_rules = store.custom_rules.filter((r) => r.id !== cleanId);
    if (store.custom_rules.length === before) {
      throw new NotFoundError(`Custom taste rule not found: ${cleanId}`);
    }

    this.saveStore(store);
    this.compileTasteCodex(store);

    const state = this.buildStateFromStore(store);
    return {
      ok: true,
      deleted_id: cleanId,
      state,
    };
  }

  buildGenerateQuestionsPrompt(domain?: string): GenerateQuestionsPrompt {
    const store = this.loadStore();
    const state = this.buildStateFromStore(store);
    const allQuestions = this.getAllQuestions(store);

    const cleanDomain =
      domain && domain.trim() && domain.trim() !== "all" && isTasteDomainId(domain.trim())
        ? (domain.trim() as TasteDomainId)
        : undefined;

    // Pick thinnest domains if no specific domain is requested
    const thinnest = [...state.domains]
      .sort((a, b) => a.pct - b.pct || a.answered - b.answered)
      .slice(0, 3);

    const targetDescription = cleanDomain
      ? `Focus all 5 questions on domain "${cleanDomain}" (${DOMAIN_MAP.get(cleanDomain)?.label}: ${DOMAIN_MAP.get(cleanDomain)?.description}).`
      : `Focus across the owner's thinnest domains: ${thinnest
          .map((d) => `"${d.id}" (${d.label}, ${d.answered}/${d.total} answered)`)
          .join(", ")}.`;

    const existingVerdicts = state.answered_history
      .slice(0, 14)
      .map((a) => `- [${a.domain}] ${a.axis}: ${a.chosen_label} (${a.trait_tag})${a.note ? ` | Note: ${a.note}` : ""}`);

    const existingTitlesAndAxes = allQuestions
      .filter((q) => !cleanDomain || q.domain === cleanDomain)
      .slice(0, 40)
      .map((q) => `- [${q.domain}] (${q.axis}) ${q.title}`);

    const system = stripEmDashes(
      [
        "You are Kizuki Taste Studio's adaptive question designer.",
        "Generate exactly 5 razor-sharp, non-generic multiple-choice taste calibration questions as a strict JSON array.",
        "Ground every question in real craft decisions across dense product UI, editorial typography, brand direction, motion physics, cinema/anime production, physical objects/merch, spaces/travel, and autonomous agent workflows.",
        "STRICT OUTPUT RULES: Return ONLY a raw JSON array of 5 objects (no markdown prose outside JSON). ZERO em-dashes (never use U+2014). Use plain hyphens, colons, or periods. Never repeat any existing question title or axis.",
      ].join(" ")
    );

    const userLines = [
      `Target: ${targetDescription}`,
      "",
      "Existing calibration verdicts (probe deeper edge cases, never repeat basics):",
      ...(existingVerdicts.length > 0 ? existingVerdicts : ["- None answered yet; probe sharp high-leverage forks."]),
      "",
      "Existing questions to NEVER duplicate:",
      ...existingTitlesAndAxes,
      "",
      "Required JSON schema for each of the 5 items:",
      "{",
      '  "domain": "ui_product|typography_copy|visual_brand|motion_feel|video_anime|merch_objects|spaces_life|agent_ops",',
      '  "title": "Crisp 6-14 word fork question",',
      '  "context": "Short real scenario from the owner\'s work or life",',
      '  "axis": "Distinct 2-4 word taste axis",',
      '  "priority": 95,',
      '  "options": [',
      '    {',
      '      "key": "A",',
      '      "label": "Short 2-5 word option name",',
      '      "rationale": "Sharp 1-sentence reason this direction wins",',
      '      "trait_tag": "kebab-case-trait-tag",',
      '      "signal_value": 2,',
      '      "preview": {',
      '        "kind": "swatch|type|copy|layout|motion",',
      '        "tokens": ["#111111", "#F5F4F0", "short spec"],',
      '        "sample_head": "Concrete short visual/copy headline",',
      '        "sample_body": "Concrete short specimen body",',
      '        "badge": "Short Tag"',
      "      }",
      "    }",
      "  ] // exactly 4 options with keys A, B, C, D",
      "}",
      "",
      "Output ONLY the JSON array of 5 objects now. Zero em-dashes.",
    ];

    const user = stripEmDashes(userLines.join("\n"));
    const promptForCoherence = stripEmDashes(
      `Generate 5 adaptive taste calibration questions for ${cleanDomain || thinnest.map((d) => d.id).join(", ")}`
    );

    return {
      system,
      user,
      promptForCoherence,
      target_domain: cleanDomain || "adaptive",
    };
  }

  ingestGeneratedQuestions(rawLlmText: string, domain?: string): IngestGeneratedQuestionsResponse {
    const store = this.loadStore();
    const existingAll = this.getAllQuestions(store);

    const existingIds = new Set<string>(existingAll.map((q) => q.id));
    const existingTitleKeys = new Set<string>(existingAll.map((q) => normalizeDedupKey(q.title)));
    const existingAxisKeys = new Set<string>(
      existingAll.map((q) => `${q.domain}:${normalizeDedupKey(q.axis)}`)
    );
    const answeredIds = new Set<string>(store.answers.map((a) => a.question_id));

    const fallbackDomain =
      domain && domain.trim() && isTasteDomainId(domain.trim())
        ? (domain.trim() as TasteDomainId)
        : undefined;

    const rawItems = extractJsonArrayFromLlm(rawLlmText);
    const added: TasteQuestion[] = [];
    let skippedDuplicates = 0;
    const nowIso = new Date().toISOString();

    for (const item of rawItems) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const obj = item as Record<string, unknown>;

      const rawDom = typeof obj.domain === "string" ? obj.domain.trim() : "";
      const resolvedDomain: TasteDomainId | undefined = isTasteDomainId(rawDom)
        ? rawDom
        : fallbackDomain;
      if (!resolvedDomain) continue;

      const title = typeof obj.title === "string" ? truncateClean(obj.title, 140) : "";
      const context = typeof obj.context === "string" ? truncateClean(obj.context, 240) : "";
      const axis = typeof obj.axis === "string" ? truncateClean(obj.axis, 64) : "";
      if (!title || title.length < 10 || !axis) continue;

      const titleKey = normalizeDedupKey(title);
      const axisKey = `${resolvedDomain}:${normalizeDedupKey(axis)}`;
      const candidateRawId = typeof obj.id === "string" ? obj.id.trim() : "";

      if (
        existingTitleKeys.has(titleKey) ||
        existingAxisKeys.has(axisKey) ||
        (candidateRawId && (existingIds.has(candidateRawId) || answeredIds.has(candidateRawId)))
      ) {
        skippedDuplicates += 1;
        continue;
      }

      if (!Array.isArray(obj.options) || obj.options.length < 4) continue;

      const cleanOptions: TasteQuestionOption[] = [];
      const usedKeys = new Set<TasteOptionKey>();
      const defaultSignals = [2, 1, -1, -2];

      for (let i = 0; i < 4; i++) {
        const rawOpt = obj.options[i];
        if (!rawOpt || typeof rawOpt !== "object" || Array.isArray(rawOpt)) break;
        const optObj = rawOpt as Record<string, unknown>;

        const rawKey = typeof optObj.key === "string" ? optObj.key.trim().toUpperCase() : "";
        let key: TasteOptionKey = VALID_OPTION_KEYS[i];
        if (VALID_OPTION_KEYS.includes(rawKey as TasteOptionKey) && !usedKeys.has(rawKey as TasteOptionKey)) {
          key = rawKey as TasteOptionKey;
        }
        if (usedKeys.has(key)) break;
        usedKeys.add(key);

        const label = typeof optObj.label === "string" ? truncateClean(optObj.label, 80) : "";
        const rationale =
          typeof optObj.rationale === "string" ? truncateClean(optObj.rationale, 200) : "";
        if (!label || !rationale) break;

        const rawTag = typeof optObj.trait_tag === "string" ? optObj.trait_tag : label;
        const trait_tag = slugify(rawTag).slice(0, 42) || `trait-${key.toLowerCase()}`;
        const signal_value =
          typeof optObj.signal_value === "number" && Number.isFinite(optObj.signal_value)
            ? Math.max(-10, Math.min(10, optObj.signal_value))
            : defaultSignals[i];

        const preview = sanitizePreview(optObj.preview);

        cleanOptions.push({
          key,
          label,
          rationale,
          trait_tag,
          signal_value,
          ...(preview ? { preview } : {}),
        });
      }

      if (cleanOptions.length !== 4) continue;

      const id = `dyn_${resolvedDomain}_${slugify(axis).slice(0, 20)}_${randomUUID().slice(0, 6)}`;
      const priority =
        typeof obj.priority === "number" && Number.isFinite(obj.priority)
          ? Math.max(1, Math.min(100, Math.round(obj.priority)))
          : 95;

      const question: TasteQuestion = {
        id,
        domain: resolvedDomain,
        title,
        context: context || `Adaptive calibration fork for ${DOMAIN_MAP.get(resolvedDomain)?.label}.`,
        axis,
        options: cleanOptions,
        source: "ai_adaptive",
        priority,
        created_at: nowIso,
      };

      existingIds.add(id);
      existingTitleKeys.add(titleKey);
      existingAxisKeys.add(axisKey);
      store.dynamic_questions.push(question);
      added.push(question);

      if (added.length >= 5) break;
    }

    if (added.length > 0) {
      this.saveStore(store);
    }

    const state = this.buildStateFromStore(store);
    return {
      added,
      count: added.length,
      skipped_duplicates: skippedDuplicates,
      state,
    };
  }
}
