import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_TASTE_GARDEN_PATH,
  DEFAULT_TASTE_VAULT_PATH,
  DEFAULT_TASTE_WIKI_PATH,
  KizukiTasteApi,
  TASTE_DOMAINS,
  sanitizeTasteText,
  stripEmDashes,
  type TasteDomainDef,
  type TasteDomainId,
} from "./taste-api.ts";
import {
  BadRequestError,
  DEFAULT_FALLBACK_LLM_ENDPOINT,
  DEFAULT_FALLBACK_LLM_MODEL,
  DEFAULT_FALLBACK_LLM_TOKEN_PATH,
  DEFAULT_LLM_ENDPOINT,
  DEFAULT_LLM_MODEL,
  NotFoundError,
} from "./vault-api.ts";

export type GardenerId =
  | "taste-visual-architect"
  | "taste-editorial-voice"
  | "taste-cinema-anime"
  | "taste-objects-living"
  | "taste-systems-strategy";

export type GardenerStatusKind = "idle" | "running" | "error";
export type PolicyPolarity = "must" | "never";

export interface GardenerRosterDef {
  id: GardenerId;
  name: string;
  domains: readonly TasteDomainId[];
  codex_scope: string;
  focus: string;
}

export interface MasteryStage {
  level: number;
  stage: string;
  goal: string;
  concrete_milestones: string[];
  diagnostic_test: string;
}

export interface DomainFramework {
  name: string;
  purpose: string;
  steps: string[];
  when_to_use: string;
}

export interface DomainPrinciple {
  title: string;
  rule: string;
  anti_pattern: string;
}

export interface DomainPolicy {
  id: string;
  polarity: PolicyPolarity;
  policy: string;
  enforcement: string;
}

export interface DomainBestPractice {
  practice: string;
  benchmark: string;
  rationale: string;
}

export interface DomainReferenceCanon {
  name: string;
  why: string;
}

export interface DomainCultivation {
  domain: TasteDomainId;
  domain_label: string;
  gardener_id: GardenerId;
  depth_level: number;
  updated_at: string;
  engine: string;
  dossier_path: string;
  thesis: string;
  mastery_path: MasteryStage[];
  frameworks: DomainFramework[];
  principles: DomainPrinciple[];
  policies: DomainPolicy[];
  best_practices: DomainBestPractice[];
  reference_canons: DomainReferenceCanon[];
  linked_interests: string[];
  linked_philosophies: string[];
}

export interface GardenerRuntimeState {
  id: GardenerId;
  name: string;
  domains: TasteDomainId[];
  codex_scope: string;
  focus: string;
  status: GardenerStatusKind;
  current_task: string | null;
  last_run_at: string | null;
  runs_count: number;
  items_cultivated: number;
  last_engine: string | null;
  last_summary: string | null;
}

export interface GardenerActivityMetrics {
  mastery_stages: number;
  frameworks: number;
  principles: number;
  policies: number;
  best_practices: number;
  mcqs_added: number;
}

export interface GardenerActivityEntry {
  id: string;
  ts: string;
  gardener_id: GardenerId;
  gardener_name: string;
  domain: TasteDomainId;
  action: string;
  engine: string;
  duration_ms: number;
  summary: string;
  metrics: GardenerActivityMetrics;
  dossier_path: string;
}

export interface GardenerSchedulerInfo {
  timer_unit: "kizuki-taste-gardener.timer";
  interval: "Every 6h";
  enabled: boolean;
  next_run_hint: string;
}

export interface GardenerStoreFile {
  version: 1;
  updated_at: string;
  gardeners: GardenerRuntimeState[];
  domains: Record<string, DomainCultivation>;
  activity_log: GardenerActivityEntry[];
}

export interface GardenerDashboardStats {
  gardeners_total: number;
  gardeners_running: number;
  domains_cultivated: number;
  domains_total: number;
  total_frameworks: number;
  total_principles: number;
  total_policies: number;
  total_best_practices: number;
  total_mastery_stages: number;
  runs_total: number;
}

export interface GardenerStateResponse {
  stats: GardenerDashboardStats;
  gardeners: GardenerRuntimeState[];
  domains: Record<string, DomainCultivation>;
  activity_log: GardenerActivityEntry[];
  scheduler: GardenerSchedulerInfo;
  updated_at: string;
}

export interface GardenerSynthesizeRequest {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  promptForCoherence: string;
  primaryMaxTokens?: number;
  fallbackMaxTokens?: number;
}

export type GardenerSynthesizeResult =
  | { ok: true; engine: string; model?: string; content: string }
  | { ok: false; reason: string };

export type GardenerSynthesizeFn = (
  req: GardenerSynthesizeRequest
) => Promise<GardenerSynthesizeResult>;

export interface GardenerApiConfig {
  vaultPath?: string;
  lifeOsWikiPath?: string | null;
  gardenPath?: string | null;
  systemdUserDir?: string;
  tasteApi?: KizukiTasteApi | null;
  checkSchedulerFn?: () => { enabled: boolean; next_run_hint: string };
}

export interface RunGardenerOptions {
  gardenerId?: string;
  domain?: string;
  synthesizeFn?: GardenerSynthesizeFn;
  tasteApi?: KizukiTasteApi | null;
  dryRun?: boolean;
}

export interface DomainRunReceipt {
  gardener_id: GardenerId;
  gardener_name: string;
  domain: TasteDomainId;
  domain_label: string;
  depth_level: number;
  engine: string;
  used_fallback: boolean;
  duration_ms: number;
  dossier_path: string;
  summary: string;
  metrics: GardenerActivityMetrics;
}

export interface RunGardenerResponse {
  ok: true;
  dry_run: boolean;
  results: DomainRunReceipt[];
  state: GardenerStateResponse;
}

export interface DualEngineConfig {
  primaryEndpoint?: string;
  primaryModel?: string;
  fallbackEndpoint?: string;
  fallbackModel?: string;
  fallbackTokenPath?: string;
  primaryTimeoutMs?: number;
  fallbackTimeoutMs?: number;
}

const MAX_ACTIVITY_LOG = 80;
const TIMER_UNIT_NAME = "kizuki-taste-gardener.timer" as const;

export const GARDENER_ROSTER: readonly GardenerRosterDef[] = [
  {
    id: "taste-visual-architect",
    name: "Visual & Product Craft Gardener",
    domains: ["ui_product", "visual_brand", "motion_feel"],
    codex_scope: "UI Craft, Visual Direction & Motion Doctrine",
    focus:
      "UI density, Vercel Geist/Linear hairlines, Swiss grids, tactile micro-artifacts, 120 FPS compositor motion.",
  },
  {
    id: "taste-editorial-voice",
    name: "Typography, Copy & Philosophy Gardener",
    domains: ["typography_copy"],
    codex_scope: "Typography, Copy Voice & Codex Philosophies",
    focus:
      "Display/body font pairings, zero-slop copy wedges, operating theses, creative doctrine.",
  },
  {
    id: "taste-cinema-anime",
    name: "Film, Satsuei & Storycraft Gardener",
    domains: ["video_anime"],
    codex_scope: "Film, Anime, Editorial Trailers & Agentic Video",
    focus:
      "Anime satsuei 2s/3s over 1s worlds, cinematography, color grading, sound cut rhythm, film craft.",
  },
  {
    id: "taste-objects-living",
    name: "Merch, Objects, Spaces & Living Gardener",
    domains: ["merch_objects", "spaces_life"],
    codex_scope: "Personal Objects, Merch, Hobbies & Accessible Travel",
    focus:
      "Personal apparel/hardware/merch taste, city theatre & dining evenings, step-free luxury family travel.",
  },
  {
    id: "taste-systems-strategy",
    name: "Agents, Systems & Strategy Gardener",
    domains: ["agent_ops"],
    codex_scope: "AI Harnesses, Local Inference & Product Execution",
    focus:
      "Autonomous harness engineering, local model routing, distributed systems, execution policies.",
  },
] as const;

const ROSTER_MAP = new Map<GardenerId, GardenerRosterDef>(GARDENER_ROSTER.map((g) => [g.id, g]));
const DOMAIN_DEF_MAP = new Map<TasteDomainId, TasteDomainDef>(TASTE_DOMAINS.map((d) => [d.id, d]));
const DOMAIN_TO_GARDENER = new Map<TasteDomainId, GardenerRosterDef>();
for (const g of GARDENER_ROSTER) {
  for (const dom of g.domains) {
    DOMAIN_TO_GARDENER.set(dom, g);
  }
}

export function isGardenerId(value: string): value is GardenerId {
  return ROSTER_MAP.has(value as GardenerId);
}

export function isValidTasteDomainId(value: string): value is TasteDomainId {
  return DOMAIN_DEF_MAP.has(value as TasteDomainId);
}

export function getGardenerForDomain(domain: TasteDomainId): GardenerRosterDef {
  const found = DOMAIN_TO_GARDENER.get(domain);
  if (!found) {
    throw new BadRequestError(`No gardener assigned to domain: ${domain}`);
  }
  return found;
}

export function sanitizeGardenerText(input: string): string {
  if (!input) return "";
  return sanitizeTasteText(input).replace(/\s+/g, " ").trim();
}

function sanitizeMultilineMarkdown(input: string): string {
  if (!input) return "";
  return stripEmDashes(input)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function stripThinkBlocks(input: string): string {
  if (!input) return "";
  return input
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^[\s\S]*?<\/think>\s*/i, "")
    .trim();
}

function cleanShort(input: unknown, maxLen: number): string {
  if (typeof input !== "string") return "";
  const cleaned = sanitizeGardenerText(input);
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, Math.max(1, maxLen - 3)).trimEnd() + "...";
}

function slugifyId(input: string): string {
  return sanitizeGardenerText(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ensurePrivateDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dirPath, 0o700);
  } catch {
    // ignore chmod error on non-owned filesystems
  }
}

function writeAtomicPrivateFile(filePath: string, content: string): void {
  const dir = dirname(filePath);
  ensurePrivateDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // ignore
  }
  renameSync(tmpPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // ignore
  }
}

function computeNext6hHint(now = new Date()): string {
  // Schedule: OnCalendar=00/6:15 -> 00:15, 06:15, 12:15, 18:15 UTC
  const slots = [0, 6, 12, 18];
  const curH = now.getUTCHours();
  const curM = now.getUTCMinutes();
  for (const h of slots) {
    if (h > curH || (h === curH && 15 > curM)) {
      const hh = String(h).padStart(2, "0");
      return `Next sweep ${hh}:15 UTC (OnCalendar=00/6:15)`;
    }
  }
  return "Next sweep 00:15 UTC tomorrow (OnCalendar=00/6:15)";
}

export function extractJsonObjectFromLlm(raw: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== "string") return null;
  const cleaned = stripEmDashes(stripThinkBlocks(raw)).trim();

  // Attempt 1: direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // continue
  }

  // Attempt 2: fenced ```json ... ``` block
  const fenceMatches = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fenceMatches) {
    for (const block of fenceMatches) {
      const inner = block.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
      try {
        const parsed = JSON.parse(inner);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // continue
      }
    }
  }

  // Attempt 3: outermost balanced brace extraction
  const startIdx = cleaned.indexOf("{");
  const endIdx = cleaned.lastIndexOf("}");
  if (startIdx !== -1 && endIdx > startIdx) {
    const slice = cleaned.slice(startIdx, endIdx + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Attempt 4: fix trailing commas before } or ]
      try {
        const repaired = slice.replace(/,\s*([}\]])/g, "$1");
        const parsed = JSON.parse(repaired);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function createDualEngineSynthesizer(config: DualEngineConfig = {}): GardenerSynthesizeFn {
  const primaryEndpoint = config.primaryEndpoint || DEFAULT_LLM_ENDPOINT;
  const primaryModel = config.primaryModel || DEFAULT_LLM_MODEL;
  const fallbackEndpoint = config.fallbackEndpoint || DEFAULT_FALLBACK_LLM_ENDPOINT;
  const fallbackModel = config.fallbackModel || DEFAULT_FALLBACK_LLM_MODEL;
  const fallbackTokenPath = config.fallbackTokenPath || DEFAULT_FALLBACK_LLM_TOKEN_PATH;
  const primaryTimeoutMs = config.primaryTimeoutMs ?? 95_000;
  const fallbackTimeoutMs = config.fallbackTimeoutMs ?? 95_000;

  return async (req: GardenerSynthesizeRequest): Promise<GardenerSynthesizeResult> => {
    const maxPrimary = req.primaryMaxTokens ?? 6500;
    const maxFallback = req.fallbackMaxTokens ?? 6500;

    // Engine 1: Primary Local LLM (:8003)
    // CRITICAL: top_p: 0.95, temperature: 0.3, reasoning_effort: "low". NEVER pass chat_template_kwargs.
    let primaryErr = "";
    try {
      const healthUrl = primaryEndpoint.replace(/\/v1\/chat\/completions\/?$/, "/health");
      const hResp = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
      if (!hResp.ok) {
        throw new Error(`Local LLM health HTTP ${hResp.status}`);
      }

      const callPrimaryLlm = async (maxTokens: number) => {
        const payload = {
          model: primaryModel,
          max_tokens: maxTokens,
          temperature: 0.3,
          top_p: 0.95,
          reasoning_effort: "low",
          messages: req.messages,
        };
        const resp = await fetch(primaryEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(primaryTimeoutMs),
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          throw new Error(`Local LLM HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
        };
        const raw = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
        return {
          content: stripEmDashes(stripThinkBlocks(raw)),
          finishReason: data.choices?.[0]?.finish_reason || "",
        };
      };

      let attempt = await callPrimaryLlm(maxPrimary);
      if (!attempt.content || !extractJsonObjectFromLlm(attempt.content)) {
        attempt = await callPrimaryLlm(Math.max(8192, maxPrimary));
      }
      if (attempt.content && extractJsonObjectFromLlm(attempt.content)) {
        return {
          ok: true,
          engine: "Local LLM",
          model: primaryModel,
          content: attempt.content,
        };
      }
      primaryErr = `Local LLM returned incomplete JSON (finish=${attempt.finishReason || "unknown"}, len=${attempt.content.length})`;
    } catch (err) {
      primaryErr = sanitizeGardenerText(err instanceof Error ? err.message : String(err)).slice(0, 180);
    }

    // Engine 2: MiniMax M2.7 (:8788) fallback
    try {
      let token: string | null = null;
      if (existsSync(fallbackTokenPath)) {
        const t = readFileSync(fallbackTokenPath, "utf8").trim();
        if (t) token = t;
      }
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      const resp = await fetch(fallbackEndpoint, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(fallbackTimeoutMs),
        body: JSON.stringify({
          model: fallbackModel,
          max_tokens: maxFallback,
          temperature: 0.3,
          top_p: 0.95,
          messages: req.messages,
        }),
      });
      if (!resp.ok) {
        throw new Error(`MiniMax HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const raw = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
      const content = stripEmDashes(stripThinkBlocks(raw));
      if (content && content.length >= 120 && content.includes("{")) {
        return {
          ok: true,
          engine: "MiniMax M2.7",
          model: data.model || fallbackModel,
          content,
        };
      }
      return {
        ok: false,
        reason: `Primary (${primaryErr}); Fallback returned short or non-JSON content`,
      };
    } catch (err) {
      const fbErr = sanitizeGardenerText(err instanceof Error ? err.message : String(err)).slice(0, 180);
      return {
        ok: false,
        reason: `Primary (${primaryErr}); Fallback (${fbErr})`,
      };
    }
  };
}

// ============================================================================
// Domain-Expert Deterministic Baselines
// Used as structural floor + merge seed so no gardener run ever leaves a stub.
// ============================================================================

interface DomainFallbackSeed {
  thesis: string;
  mastery_path: MasteryStage[];
  frameworks: DomainFramework[];
  principles: DomainPrinciple[];
  policies: DomainPolicy[];
  best_practices: DomainBestPractice[];
  reference_canons: DomainReferenceCanon[];
  linked_interests: string[];
  linked_philosophies: string[];
  adaptive_questions: Array<Record<string, unknown>>;
}

const DOMAIN_FALLBACK_SEEDS: Record<TasteDomainId, DomainFallbackSeed> = {
  ui_product: {
    thesis:
      "Product UI earns trust through immediate working density, hairline surface precision, and single-decision clarity at Revolut, Linear, and Vercel Geist standards.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Establish crisp surface polarity, 1px hairline hierarchy, and zero-fluff data layouts across desktop and mobile.",
        concrete_milestones: [
          "Lock semantic OKLCH neutral and accent tokens with >= 4.5:1 contrast.",
          "Eliminate marketing hero padding on operator and trading tools; put working UI in the first viewport.",
          "Enforce tabular numerals (tabular-nums) on every metric, price, timestamp, and count.",
        ],
        diagnostic_test:
          "Inspect 1440x900 and 390x844 renders: can an operator complete the primary action in under 3 seconds without scrolling past filler cards?",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Ship dense, scannable multi-panel shells with zero stray overlays, clean empty states, and honest copy.",
        concrete_milestones: [
          "Build keyboard-first navigation (command bar, hotkeys, deterministic focus rings) across views.",
          "Replace stacked dashboard widget grids with calm architectural 1px structural rules.",
          "Verify zero clipped labels, zero horizontal overflow, and zero orphan badges across responsive breakpoints.",
        ],
        diagnostic_test:
          "Run a cold-stranger usability check on Kizuki or Nob: does every button label predict its exact state change?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Lead consumer and fintech surfaces where action confidence beats dark poster theatre.",
        concrete_milestones: [
          "Pair consumer-grade onboarding (Revolut/Robinhood clarity) with high-trust live market telemetry.",
          "Craft one subject-native tactile signature per surface and prove its value via ?detail=on|off subtraction.",
          "Maintain strict visual hierarchy where only 1 primary CTA competes for attention per decision screen.",
        ],
        diagnostic_test:
          "Strip all brand logos from the screenshot: does the layout still read as top-1% commercial craft rather than an AI SaaS template?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Set category benchmarks for live AI-native command centers, personal mind OS interfaces, and public trading cockpits.",
        concrete_milestones: [
          "Fuse live streaming telemetry, verifiable provenance drawers, and instant reversible controls into one calm cockpit.",
          "Automate multimodal pixel regression checks on every UI PR before a human ever inspects a build.",
          "Turn complex multi-agent and on-chain state into glanceable spatial instruments with zero cognitive tax.",
        ],
        diagnostic_test:
          "Does the shipped screen trigger an immediate unprompted 'holy shit' reaction on first load with zero overlay defects?",
      },
    ],
    frameworks: [
      {
        name: "First-Viewport Working-UI Audit",
        purpose: "Guarantee product and operator interfaces open on live state instead of vanity banners.",
        steps: [
          "Capture 1440x900 and 390x844 screenshots on initial load before interaction.",
          "Measure ratio of live actionable data vs decorative chrome above the fold.",
          "Cut any hero subtitle, status pill, or gradient card that does not drive an immediate user decision.",
          "Verify primary action reachability within 1 click or 1 keystroke.",
        ],
        when_to_use: "Before shipping any Kizuki, Nob, Sembler, or live trading cockpit screen.",
      },
      {
        name: "Three-Tier Surface & Hairline Ladder",
        purpose: "Replace muddy drop shadows with disciplined architectural elevation.",
        steps: [
          "Assign base canvas, recessed well, and elevated panel tokens with tight L-channel steps.",
          "Use 1px translucent hairline borders instead of heavy box shadows or thick cards.",
          "Reserve high-contrast ink exclusively for primary metrics, active selections, and primary actions.",
        ],
        when_to_use: "When building or refactoring dense tables, inspectors, and multi-column app shells.",
      },
      {
        name: "Consumer Finance Action-Confidence Gate",
        purpose: "Keep consumer surfaces (Nob, Encrypt retail flows) obvious, calm, and trustworthy.",
        steps: [
          "Limit each screen or modal to exactly one primary decision.",
          "State fees, stakes, and consequences in plain numbers right beside the trigger.",
          "Replace cryptic crypto jargon with clear human outcomes and verifiable receipts.",
        ],
        when_to_use: "For Nob onboarding, consumer payment qualification, and public financial dashboards.",
      },
    ],
    principles: [
      {
        title: "Product Experience First, Aesthetic Second",
        rule: "In consumer finance and daily tools, clarity and action confidence override moody poster styling.",
        anti_pattern: "Dark poster landing pages that hide what the product does or bury the primary action.",
      },
      {
        title: "Calm Density Over Empty Bento",
        rule: "Pack high-signal structured facts tightly with generous outer margins and hairline dividers.",
        anti_pattern: "Uniform 3-column bento grids padded with huge rounded boxes and two-word stats.",
      },
      {
        title: "Honest Live Telemetry",
        rule: "Every counter, sparkline, and status dot must reflect real backend state with visible timestamps.",
        anti_pattern: "Mocked demo numbers, stale caches dressed as live feeds, or decorative green status dots.",
      },
      {
        title: "Zero Stray Overlays Before Review",
        rule: "Inspect rendered pixels at desktop and mobile viewports before presenting any UI build.",
        anti_pattern: "Floating tooltips, clipped modals, or overlapping badges left behind in shipped previews.",
      },
    ],
    policies: [
      {
        id: "ui-must-tabular-nums",
        polarity: "must",
        policy: "Apply font-variant-numeric: tabular-nums to all financial figures, metrics, counts, and timestamps.",
        enforcement: "CSS token audit + visual inspection of live tables and KPI strips.",
      },
      {
        id: "ui-must-dual-viewport-proof",
        polarity: "must",
        policy: "Inspect live rendered PNGs at both 1440x900 desktop and 390x844 mobile after the final edit.",
        enforcement: "Completion gate requires multimodal screenshot review before reporting done.",
      },
      {
        id: "ui-never-ai-slop-chrome",
        polarity: "never",
        policy: "Never ship purple-blue neon glow blobs, generic glassmorphism cards, or centered SaaS template heroes.",
        enforcement: "Design review rejects any template gradient or unmotivated blur surface.",
      },
      {
        id: "ui-never-fake-onboarding",
        polarity: "never",
        policy: "Never ship stubbed onboarding flows or dead buttons on consumer products like Nob or Kizuki.",
        enforcement: "Every interactive control must execute real state transitions verified end-to-end.",
      },
    ],
    best_practices: [
      {
        practice: "Use a single neutral surface ladder plus one purposeful accent color.",
        benchmark: "Linear / Vercel Geist design systems",
        rationale: "Preserves visual calm so real alerts, P&L moves, and primary actions pop immediately.",
      },
      {
        practice: "Default dashboards to real live streaming or auto-refreshing data with explicit freshness indicators.",
        benchmark: "Public trading cockpits and Bloomberg-lite web terminals",
        rationale: "Builds instant operator confidence and matches the live-dashboard standard.",
      },
      {
        practice: "Make empty, loading, and error states domain-specific and immediately recoverable.",
        benchmark: "Stripe Dashboard & Revolut mobile flows",
        rationale: "Prevents dead ends and shows real engineering care on edge cases.",
      },
      {
        practice: "Anchor navigation in a slim, persistent rail or top bar under 52px tall.",
        benchmark: "Kizuki Mind Explorer & Raycast/Linear shells",
        rationale: "Maximizes vertical viewport for working data rather than oversized headers.",
      },
    ],
    reference_canons: [
      { name: "Linear App Shell", why: "Benchmark for keyboard speed, hairline borders, and zero-noise issue density." },
      { name: "Vercel Geist Design System", why: "Gold standard for crisp neutral polarity, monospace metadata, and structural restraint." },
      { name: "Revolut & Robinhood Consumer Flows", why: "Explicit bar for consumer finance clarity and one-decision-per-screen confidence." },
      { name: "Stripe Dashboard & Receipts", why: "Masterclass in tabular typography, calm density, and verifiable financial records." },
    ],
    linked_interests: [
      "Consumer UI Principles",
      "UI and Visual Language Taste",
      "Frontend Craft, AEO & Tactile Interfaces",
      "Command-Center & Dashboard UX Craft",
    ],
    linked_philosophies: [
      "Specificity Beats Polish",
      "Operator Design Principles",
      "Owner Anchors: Proof-First Execution",
    ],
    adaptive_questions: [
      {
        domain: "ui_product",
        title: "How should live P&L and risk telemetry sit inside a public trading cockpit?",
        context: "Designing a live public trading dashboard for live market desks without clutter.",
        axis: "Trading Cockpit Density",
        priority: 94,
        options: [
          {
            key: "A",
            label: "Tape-First Swiss Terminal",
            rationale: "Live order tape and sparklines dominate above the fold with 1px hairlines and zero hero banner.",
            trait_tag: "tape-first-swiss-terminal",
            signal_value: 2,
            preview: {
              kind: "layout",
              tokens: ["#0A0A0B", "#141416", "1px hairline", "tabular-nums"],
              sample_head: "LIVE DESK +4.82% 24H",
              sample_body: "SOL-PERP 142.10 | Fill 18ms | Idle Cash 0.0%",
              badge: "Terminal",
            },
          },
          {
            key: "B",
            label: "Editorial Split Cockpit",
            rationale: "Left narrative thesis and positions, right live chart and execution feed with generous breathing room.",
            trait_tag: "editorial-split-cockpit",
            signal_value: 1,
            preview: {
              kind: "layout",
              tokens: ["#F7F6F2", "#111111", "60/40 split"],
              sample_head: "Desk Snapshot",
              sample_body: "Active strategies paired with real-time execution audit.",
              badge: "Split",
            },
          },
          {
            key: "C",
            label: "Card Bento Summary",
            rationale: "Rounded KPI tiles grouped in a 3x2 grid with charts tucked below the fold.",
            trait_tag: "card-bento-summary",
            signal_value: -1,
            preview: {
              kind: "layout",
              tokens: ["#18181B", "16px radius", "3-col grid"],
              sample_head: "Total Return",
              sample_body: "Six equal summary cards above trade history.",
              badge: "Bento",
            },
          },
          {
            key: "D",
            label: "Dark Cinematic Promo",
            rationale: "Full-bleed dark hero headline with animated glow chart preview before scrolling to metrics.",
            trait_tag: "dark-cinematic-promo",
            signal_value: -2,
            preview: {
              kind: "layout",
              tokens: ["#050507", "#6366F1", "Full hero"],
              sample_head: "Next-Gen Trading",
              sample_body: "Atmospheric showcase before live desk table.",
              badge: "Poster",
            },
          },
        ],
      },
    ],
  },

  typography_copy: {
    thesis:
      "Specificity beats polish: every headline and sentence must name an enemy, carry a real stake, ban corporate corpse words, and contain a line worth stealing.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Eliminate AI copy tells, corporate corpse words, and em-dashes across every public and internal surface.",
        concrete_milestones: [
          "Enforce zero em-dashes (U+2014) in all copy, docs, X posts, and UI microcopy.",
          "Ban corpse words: unlock, empower, seamless, robust, next-generation, cutting-edge, revolutionary, innovative.",
          "Replace abstract adjectives with concrete numbers, named actors, and crisp verbs.",
        ],
        diagnostic_test:
          "Run a cold read of 5 random paragraphs: could a competitor paste their own logo onto this copy without changing a word?",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Master optical type hierarchy, purposeful display/body pairings, and high-compression public X rhythm.",
        concrete_milestones: [
          "Pair editorial display faces (tight tracking, controlled measure 45-68ch) with crisp technical mono metadata.",
          "Write public X posts as one sharp wedge per post with zero explainer bloat.",
          "Structure product copy around a single enemy, a single stake, and a verifiable proof line.",
        ],
        diagnostic_test:
          "Test headline + subhead at 390px mobile and 1440px desktop: zero orphan words, instant comprehension in 1.5 seconds.",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Build unforgettable category voices for flagship software, media, and studio products that sound impossible to confuse with anyone else.",
        concrete_milestones: [
          "Craft category-defining wedges like 'Private execution for a world that watches too much' and 'tiny judgmental doorman'.",
          "Maintain multi-script typographic discipline (Latin + CJK optical sizing, verified live document.fonts faces).",
          "Edit ruthlessly: cut 35% of every first draft until only load-bearing lines remain.",
        ],
        diagnostic_test:
          "Read the hero copy aloud: is there at least one sentence someone in crypto or design would screenshot and steal?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Turn typography and operating philosophy into a compounding moat across products, investor decks, and agent voices.",
        concrete_milestones: [
          "Align every agent face (Codex, Claude, local models) to crisp compression, directness, and proof-first cadence.",
          "Maintain live multi-script type specimens and voice lint gates across every outbound repo.",
          "Convert recurring taste verdicts into durable doctrine cards in the Taste Vault and Codex.",
        ],
        diagnostic_test:
          "Does every brand touchpoint from a 12-word tweet to a 20-page deck read like one unmistakable mind authored it?",
      },
    ],
    frameworks: [
      {
        name: "Enemy-Stake-Steal Copy Wedge",
        purpose: "Ensure every landing page, tweet, or manifesto carries real tension instead of smooth corporate air.",
        steps: [
          "Name the exact enemy (public mempool leakage, inbox spam, AI slop, theatre metrics).",
          "Quantify the real stake for a real user in one line.",
          "Write one memorable sentence worth quoting verbatim.",
          "Delete every introductory throat-clearing clause and polite hedge.",
        ],
        when_to_use: "Landing heroes, product launches and flagship releases, and X threads.",
      },
      {
        name: "Three-Script Optical Type Matrix",
        purpose: "Verify display, body, monospace, and CJK pairings under real copy before locking CSS.",
        steps: [
          "Render real headlines, body copy, unit-bearing numerals, and narrow 320px/390px wraps.",
          "Check optical weight balance and line-height rhythm across display (1.02-1.12) and body (1.45-1.6).",
          "Inspect live document.fonts to confirm intended faces loaded with clean fallback metrics.",
        ],
        when_to_use: "Whenever selecting or upgrading fonts for a brand site, dossier, or anime/editorial showcase.",
      },
      {
        name: "35% Brutal Compression Pass",
        purpose: "Strip filler cadence, summary recaps, and AI transition scaffolding from any draft.",
        steps: [
          "Delete opening preambles and closing recaps.",
          "Replace 'It is not X, it is Y' AI cadence with a single direct assertion.",
          "Verify zero em-dashes and zero banned corpse words remain.",
        ],
        when_to_use: "Final edit before shipping any brief, deck slide, or public post.",
      },
    ],
    principles: [
      {
        title: "Specificity Beats Polish",
        rule: "A jagged, concrete claim with real technical truth always beats smooth agency copy.",
        anti_pattern: "Generic launch copy promising to 'unlock seamless next-generation workflows'.",
      },
      {
        title: "One Sharp Wedge Per Post",
        rule: "Public X posts and headlines deliver one unmistakable idea without explainer padding.",
        anti_pattern: "Multi-paragraph corporate announcement threads padded with emojis and bullet recaps.",
      },
      {
        title: "Earned Display Typography",
        rule: "Choose distinctive, subject-native display and mono faces rather than default Inter or Arial.",
        anti_pattern: "Unstyled Inter/Poppins headings with loose default tracking and flat hierarchy.",
      },
      {
        title: "Honest Microcopy Over Marketing Fluff",
        rule: "Buttons, errors, and onboarding steps state plain facts and real actions.",
        anti_pattern: "Cute assistant banter, vague 'Something went wrong' alerts, or exaggerated claims.",
      },
    ],
    policies: [
      {
        id: "type-never-em-dash",
        polarity: "never",
        policy: "Never output em-dash characters (U+2014) in copy, docs, UI labels, or generated dossiers.",
        enforcement: "Automated sanitizer + unit test gate across all generators.",
      },
      {
        id: "type-never-corpse-words",
        polarity: "never",
        policy: "Never use banned corpse words: unlock, empower, seamless, robust, next-generation, cutting-edge, revolutionary, innovative.",
        enforcement: "Copy lint pass prior to publishing or presenting drafts.",
      },
      {
        id: "type-must-stealable-line",
        polarity: "must",
        policy: "Every public hero or campaign brief must contain at least one concrete, quotable thesis line.",
        enforcement: "Taste Vault review check before sign-off.",
      },
      {
        id: "type-must-normie-docs-for-family",
        polarity: "must",
        policy: "Deliver ordinary formatted documents (PDF, Word, Google Docs, slides) rather than raw markdown when writing for non-technical family such as Samina.",
        enforcement: "Audience check in household communications.",
      },
    ],
    best_practices: [
      {
        practice: "Set editorial display headlines with tight negative tracking (-0.025em to -0.04em) and crisp leading (1.02 to 1.12).",
        benchmark: "Bureau Borsche & It's Nice That editorial systems",
        rationale: "Gives large type physical authority and poster-grade tension.",
      },
      {
        practice: "Use monospace uppercase micro-labels (10px-12px, +0.08em tracking) strictly for metadata, indices, and timestamps.",
        benchmark: "Teenage Engineering & Swiss technical spec sheets",
        rationale: "Creates clear visual separation between narrative prose and instrument telemetry.",
      },
      {
        practice: "Keep body measure between 52 and 68 characters on editorial pages.",
        benchmark: "Classical Swiss typography standards",
        rationale: "Maximizes reading speed and prevents eye fatigue across long dossiers.",
      },
      {
        practice: "Lead every report and message with the concrete state change or verdict in line 1.",
        benchmark: "Standing copy preference in owner-profile.md",
        rationale: "Respects high-compression operator attention and kills preamble sludge.",
      },
    ],
    reference_canons: [
      { name: "Taste Vault Doctrine", why: "Core law: sound impossible to confuse with anyone else." },
      { name: "Encrypt Positioning & Landing Seeds", why: "Model sharp wedge: 'Private execution for a world that watches too much.'" },
      { name: "Bureau Borsche Type Specimens", why: "Editorial meets brutalist typographic hierarchy without ornament." },
      { name: "It's Nice That Long-Form Grids", why: "Pull-quotes as hero architectural anchors paired with tight journalism." },
    ],
    linked_interests: [
      "Voice and Phrases",
      "Editorial & Commercial Brand Design Precedents",
      "Encrypt Positioning Taste",
      "Founders, GTM Strategy & Leverage",
    ],
    linked_philosophies: [
      "Specificity Beats Polish",
      "Typography Discipline",
      "Visual & Copy Anti-Patterns",
      "Creative Doctrine",
    ],
    adaptive_questions: [
      {
        domain: "typography_copy",
        title: "Which typographic voice best fits a public technical manifesto?",
        context: "Setting display and body font pairing for a flagship Solana privacy manifesto page.",
        axis: "Manifesto Type Pairing",
        priority: 92,
        options: [
          {
            key: "A",
            label: "Editorial Serif + Technical Mono",
            rationale: "High-contrast serif display paired with stark monospace telemetry signals mythic craft plus cryptographic rigor.",
            trait_tag: "editorial-serif-plus-mono",
            signal_value: 2,
            preview: {
              kind: "type",
              tokens: ["Instrument Serif", "JetBrains Mono", "-0.03em"],
              sample_head: "Private execution for a watching world.",
              sample_body: "SPEC 01 / FHE-CKKS / SOLANA MAINNET",
              badge: "Editorial",
            },
          },
          {
            key: "B",
            label: "Swiss Grotesque + Hairline Specs",
            rationale: "Clinical neo-grotesque headlines with austere Swiss spec sheets and zero literary softness.",
            trait_tag: "swiss-grotesque-spec",
            signal_value: 1,
            preview: {
              kind: "type",
              tokens: ["Neue Haas Grotesk", "IBM Plex Mono", "1.05 leading"],
              sample_head: "ZERO LEAKAGE. FULL COMPOSABILITY.",
              sample_body: "PROTOCOL BRIEF / ENCRYPT LABS / 2026",
              badge: "Swiss",
            },
          },
          {
            key: "C",
            label: "Brutalist Condensed Poster",
            rationale: "Ultra-tight condensed display uppercase treated like an art book or A24 title card.",
            trait_tag: "brutalist-condensed-poster",
            signal_value: 0,
            preview: {
              kind: "type",
              tokens: ["Druk Condensed", "Space Mono", "Uppercase"],
              sample_head: "STOP LEAKING INTENT ON-CHAIN",
              sample_body: "MANIFESTO / SOLANA CONFIDENTIAL STATE",
              badge: "Brutalist",
            },
          },
          {
            key: "D",
            label: "Clean Geometric SaaS Sans",
            rationale: "Friendly rounded geometric sans with balanced paragraph spacing like a standard Web3 startup.",
            trait_tag: "generic-geometric-saas",
            signal_value: -2,
            preview: {
              kind: "type",
              tokens: ["Inter", "Plus Jakarta Sans", "Regular"],
              sample_head: "Unlock Seamless Privacy on Solana",
              sample_body: "Empowering next-generation decentralized applications.",
              badge: "SaaS",
            },
          },
        ],
      },
    ],
  },

  visual_brand: {
    thesis:
      "World-class brand direction starts from real commercial precedents, disciplined negative space, and unmistakable structural silhouette rather than palette swaps or AI glow gradients.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Ground every brand and landing direction in real art-direction precedents and restrained color palettes.",
        concrete_milestones: [
          "Query commercial design precedents before picking a grid, palette, or motif.",
          "Limit brand palettes to 1 dominant canvas, 1 ink, and 1 disciplined accent token.",
          "Ban generic purple-blue AI gradients, floating blobs, and symmetrical SaaS card walls.",
        ],
        diagnostic_test:
          "View the page in greyscale at 25% zoom: does the composition still hold strong silhouette and negative-space rhythm?",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Run Posters-First static explorations and structural A/B art-direction duels holding copy constant.",
        concrete_milestones: [
          "Build 3 architecturally distinct static compositions (never mere color swaps) before scaffolding full pages.",
          "Ensure mid-canvas compositions never collapse into empty voids (preventing empty mid-page spans).",
          "Enforce Swiss grid alignment, FolioPlate framing, and intentional visual anchors.",
        ],
        diagnostic_test:
          "Compare Poster A vs Poster B side by side: do they differ in grid geometry, reading flow, and focal mass rather than just hex codes?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Calibrate public showpieces directly to Bureau Borsche, A24, Nothing, Linear, and editorial print references.",
        concrete_milestones: [
          "Embed one unforgettable subject-native tactile signature (dial, grain plate, knife-blade rule, folio index).",
          "Maintain crisp brand differentiation across distinct products without collapsing into a single generic house template.",
          "Verify real-pixel craft across both dark cinema modes and warm archival editorial paper modes.",
        ],
        diagnostic_test:
          "Would this brand artifact survive beside A24, Pentagram, or Studio Dumbar on a curated design index without feeling derivative?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Codify living brand systems that scale effortlessly across web, motion reels, social title cards, and physical objects.",
        concrete_milestones: [
          "Unify web tokens, motion spec sheets, and print/object geometry under one coherent visual grammar.",
          "Establish automated visual-critic gauntlets calibrated against real commercial winners.",
          "Ship signature visual worlds that competitors attempt to imitate within a quarter.",
        ],
        diagnostic_test:
          "Can a viewer identify the brand from a 1-second cropped still with the wordmark removed?",
      },
    ],
    frameworks: [
      {
        name: "Posters-First Structural Duel",
        purpose: "Lock real compositional originality before writing application scaffolding.",
        steps: [
          "Hold headline, body copy, and data 100% constant.",
          "Design 2 to 3 static posters with genuinely different grid geometry and focal anchors.",
          "Render desktop (1440x900) and mobile (390x844) PNGs and critique pixels directly.",
          "Lock one winner and discard the rest before coding interactive state.",
        ],
        when_to_use: "Any new landing page, brand re-skin, or public venture showcase.",
      },
      {
        name: "FolioPlate + SpecSheet Canvas Balance",
        purpose: "Prevent mid-canvas editorial voids (verified across desktop and mobile full-page renders).",
        steps: [
          "Anchor top/bottom edges with crisp folio indices and technical metadata.",
          "Fill the middle third with a bold structural numeral, diagram, or visual artifact rather than polite empty space.",
          "Balance heavy typographic mass with deliberate, asymmetric negative space.",
        ],
        when_to_use: "Editorial websites, launch visuals, social title cards, and pitch decks.",
      },
      {
        name: "Color Restraint & Subject-Native Extraction",
        purpose: "Derive palettes from real physical or cinematic artifacts instead of synthetic UI defaults.",
        steps: [
          "Extract base canvas, ink, and 1 accent directly from subject references (film stock, archival paper, industrial hardware).",
          "Test contrast ratios across light and dark polarities.",
          "Verify accent usage stays below 8% of total viewport area.",
        ],
        when_to_use: "Start of any brand system or visual refresh.",
      },
    ],
    principles: [
      {
        title: "No Fake Color-Swap Comparisons",
        rule: "Alternative visual directions must diverge in layout architecture, type scale, and visual hierarchy.",
        anti_pattern: "Presenting the same layout in light mode vs dark mode as two 'art directions'.",
      },
      {
        title: "Mid-Canvas Authority",
        rule: "Empty space must look intentional and sculptural, never like an unfinished void with timid chrome.",
        anti_pattern: "Minimalist layouts where the center of the frame feels hollow and under-directed.",
      },
      {
        title: "Distinct Brand Silhouettes",
        rule: "Each product owns an unmistakable visual grammar calibrated to its subject.",
        anti_pattern: "Reusing one dark-mode developer template across unrelated ventures.",
      },
      {
        title: "Physical Materiality Over Digital Plastic",
        rule: "Borrow restraint and texture from books, industrial design, and 35mm film rather than SaaS mockups.",
        anti_pattern: "Glossy 3D icons, rainbow borders, and stock isometric illustrations.",
      },
    ],
    policies: [
      {
        id: "brand-must-posters-first",
        polarity: "must",
        policy: "Lock visual composition via static poster candidates before building full multi-section sites.",
        enforcement: "Pre-build visual review of rendered desktop + mobile stills.",
      },
      {
        id: "brand-never-lava-lamp-gradients",
        polarity: "never",
        policy: "Never use purple-pink-blue AI mesh gradients or generic glowing orbs on any brand canvas.",
        enforcement: "Automatic rejection during visual self-critique.",
      },
      {
        id: "brand-must-precedent-grounding",
        polarity: "must",
        policy: "Anchor every major brand direction in at least 2 verified commercial precedents before styling.",
        enforcement: "Art-direction brief cites exact precedents and why they apply.",
      },
      {
        id: "brand-never-generic-wordmark-clutter",
        polarity: "never",
        policy: "Never crowd logos or title cards with redundant badges, taglines, or partner logo soup.",
        enforcement: "Negative-space audit on hero and social templates.",
      },
    ],
    best_practices: [
      {
        practice: "Frame brand social cards like A24 title cards with consistent margin architecture and stark type.",
        benchmark: "A24 Instagram/X campaign system",
        rationale: "Builds instant scroll-stopping recognition across disparate releases.",
      },
      {
        practice: "Treat hardware and technical specs as graphic art (dot-matrix indices, schematic ticks, numbered plates).",
        benchmark: "Nothing Phone & Teenage Engineering brand systems",
        rationale: "Signals authentic engineering craft without corporate gloss.",
      },
      {
        practice: "Audit every layout in monochrome first to confirm mass, rhythm, and hierarchy.",
        benchmark: "Pentagram & Bureau Borsche print methodology",
        rationale: "Exposes weak composition that color would temporarily disguise.",
      },
      {
        practice: "Keep brand photography and artwork full-bleed or cleanly framed inside crisp hairline borders.",
        benchmark: "High-craft editorial magazines & monographs",
        rationale: "Respects image integrity and avoids dated drop-shadow frames.",
      },
    ],
    reference_canons: [
      { name: "A24 & Bureau Borsche Editorial Web", why: "Frontier editorial web benchmark for restrained cinema authority and negative space." },
      { name: "A24 Title Cards & Social Moodboards", why: "Unmistakable typographic consistency across wildly varied films." },
      { name: "Bureau Borsche Editorial x Brutalist", why: "Fearless Swiss hierarchy and print-grade layout tension." },
      { name: "Nothing Phone Reveal System", why: "Cohesive industrial palette (black, white, surgical red) and technical grid language." },
      { name: "Mastercard 2016 Pentagram Redesign", why: "Masterclass in subtracting wordmark bloat until pure geometry carries the brand." },
    ],
    linked_interests: [
      "Editorial & Commercial Brand Design Precedents",
      "A24 - Title Cards & Social Moodboards",
      "Bureau Borsche - Editorial x Brutalist",
      "Design, Motion & Visual Craft",
    ],
    linked_philosophies: [
      "Composition & Negative Space Laws",
      "Color & Surface Architecture",
      "Visual & Copy Anti-Patterns",
      "Pre-Build Research & Six-Lens Jury",
    ],
    adaptive_questions: [
      {
        domain: "visual_brand",
        title: "Which visual surface polarity fits a flagship Kizuki Personal Mind OS public site?",
        context: "Choosing the core brand world for Kizuki's public launch page.",
        axis: "Kizuki Brand World",
        priority: 91,
        options: [
          {
            key: "A",
            label: "Warm Archival Paper + Ink",
            rationale: "Off-white archival stock (#F6F4EF), deep charcoal ink, hairline rules, and one vermilion or forest accent.",
            trait_tag: "warm-archival-paper-ink",
            signal_value: 2,
            preview: {
              kind: "swatch",
              tokens: ["#F6F4EF", "#141413", "#C84B31", "1px hairline"],
              sample_head: "KIZUKI / ARCHIVE",
              sample_body: "Personal memory compiled like a rare Japanese monograph.",
              badge: "Archival",
            },
          },
          {
            key: "B",
            label: "Obsidian Swiss Instrument",
            rationale: "True matte carbon canvas with surgical hairline grids and high-contrast white + muted amber telemetry.",
            trait_tag: "obsidian-swiss-instrument",
            signal_value: 1,
            preview: {
              kind: "swatch",
              tokens: ["#09090B", "#FAFAFA", "#D97706", "Monospace"],
              sample_head: "KIZUKI OS // 01",
              sample_body: "High-precision dark cockpit for live personal intelligence.",
              badge: "Obsidian",
            },
          },
          {
            key: "C",
            label: "Industrial Nothing Monochrome",
            rationale: "Stark white and black with dot-matrix indices, exposed schematics, and surgical red focus points.",
            trait_tag: "industrial-nothing-monochrome",
            signal_value: 1,
            preview: {
              kind: "swatch",
              tokens: ["#FFFFFF", "#000000", "#E11D48", "Dot Grid"],
              sample_head: "MIND.SYS [v1.0]",
              sample_body: "Transparent hardware logic applied to personal recall.",
              badge: "Industrial",
            },
          },
          {
            key: "D",
            label: "Gradient Neural Glass",
            rationale: "Dark indigo backdrop with frosted translucent cards and glowing violet graph lines.",
            trait_tag: "gradient-neural-glass",
            signal_value: -2,
            preview: {
              kind: "swatch",
              tokens: ["#0F1028", "#7C3AED", "#38BDF8", "Blur 24px"],
              sample_head: "Your AI Second Brain",
              sample_body: "Glowing glass nodes floating over a soft purple mesh.",
              badge: "Glass",
            },
          },
        ],
      },
    ],
  },

  motion_feel: {
    thesis:
      "Motion must either carry real data state or deliver physical tactile authority at 120 FPS compositor speed; decorative idle jitter and sluggish eases are bugs.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Restrict UI transitions to GPU-composited properties (transform, opacity, clip-path) with crisp timing curves.",
        concrete_milestones: [
          "Audit CSS and JS animations to ban layout-thrashing width/height/top/left transitions.",
          "Eliminate fake idle breathing pulses, floating loops, and decorative background shimmers.",
          "Support prefers-reduced-motion cleanly on every animated surface.",
        ],
        diagnostic_test:
          "Record a 60/120fps Chrome performance trace during scroll and state change: zero layout thrash, zero dropped frames.",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Bind every dashboard and live-tool animation strictly to real incoming data events.",
        concrete_milestones: [
          "Trigger brief crisp pulses (180-320ms) only when an actual trade, message, or agent event lands.",
          "Use critically damped springs (fast attack, zero sloppy wobble) for drawers, tabs, and tactile toggles.",
          "Verify short pulses with frozen-clock frame captures rather than trusting mental playback.",
        ],
        diagnostic_test:
          "Disconnect live feed updates: does the entire interface fall completely calm and still with zero fake movement?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Ship one unforgettable physical micro-artifact per flagship experience and prove it with a subtraction test.",
        concrete_milestones: [
          "Build tactile toys (vernier detents, coupled paper drag, mechanical dials, frequency scrubbers) inspired by Teenage Engineering and bestdesignsonx.com.",
          "Wire a live ?detail=on|off toggle to visually prove the tactile artifact genuinely elevates craft.",
          "Choreograph launch reels (Linear/Arc/Encrypt v6 cadence) around tight beat grids and zero dead frames.",
        ],
        diagnostic_test:
          "Compare ?detail=on vs ?detail=off side by side: does removing the tactile detail visibly flatten the soul of the piece?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Merge WebGL/Three.js, depth-tested shaders, and physical micro-interactions into signature web instruments.",
        concrete_milestones: [
          "Build interactive WebGL/canvas toys that stay 60+ FPS across Mac, Safari, and mobile without SwiftShader traps.",
          "Pair micro-haptic visual detents with optional subtle procedural audio cues.",
          "Establish repeatable motion telemetry budgets and frame-by-frame review harnesses.",
        ],
        diagnostic_test:
          "Does a first-time visitor replay the interaction 3 times purely because the physics feel undeniably real?",
      },
    ],
    frameworks: [
      {
        name: "Information-Bearing Motion Audit",
        purpose: "Strip fake liveliness from dashboards, war rooms, and trading monitors.",
        steps: [
          "Inventory every active CSS @keyframes, transition, and requestAnimationFrame loop.",
          "Map each animation to a concrete data mutation or user input event.",
          "Delete any animation that runs on an idle clock without underlying state change.",
        ],
        when_to_use: "Every live trading dashboard, agent monitor, and Kizuki workspace view.",
      },
      {
        name: "Subtraction Proof (?detail=on|off)",
        purpose: "Prove a tactile micro-artifact earns its code weight and elevates perceived craft.",
        steps: [
          "Design one subject-native physical interaction (detent dial, magnetic hairline, spring drawer).",
          "Gate it cleanly behind a query toggle (?detail=on|off) and prefers-reduced-motion.",
          "Inspect rendered frames in both modes; keep only if removal visibly degrades the experience.",
        ],
        when_to_use: "Public showpieces, landing pages, and signature product interactions.",
      },
      {
        name: "Beat-Locked Launch Reel Choreography",
        purpose: "Keep product launch videos (15s-45s) taut, musical, and visually dense.",
        steps: [
          "Lock cuts to a strict BPM grid (e.g. 120 BPM beat-locked edits).",
          "Lead with real UI or FolioPlate geometry in frame 1; zero slow logo fades.",
          "End cleanly on one unmistakable feature name or URL hold.",
        ],
        when_to_use: "Linear-style product update reels, product launch edits, and social teasers.",
      },
    ],
    principles: [
      {
        title: "Every Pixel of Motion Carries Meaning",
        rule: "Movement communicates spatial origin, real data arrival, or direct physical manipulation.",
        anti_pattern: "Ambient floating cards, infinite pulse rings, or slow 800ms fade-ins on routine clicks.",
      },
      {
        title: "Crisp Utility Springs Over Bouncy Toys",
        rule: "Product UI transitions settle fast (140-260ms) with minimal overshoot so power users never wait.",
        anti_pattern: "Sluggish theatrical eases that block clicks or make a tool feel underwater.",
      },
      {
        title: "Compositor-Only Execution",
        rule: "Animate transform, opacity, and clip-path exclusively; keep main-thread jank at zero.",
        anti_pattern: "Animating height, margin, box-shadow blur, or CSS filter chains during scroll.",
      },
      {
        title: "One Tactile Signature Beats Ten Gimmicks",
        rule: "Invest craft depth into one physical interaction that belongs uniquely to the subject.",
        anti_pattern: "Sprinkling generic magnetic buttons, cursor trails, and confetti everywhere.",
      },
    ],
    policies: [
      {
        id: "motion-never-fake-idle-activity",
        polarity: "never",
        policy: "Never add fake idle pulses, synthetic heartbeats, or decorative loading loops to live data UIs.",
        enforcement: "Code audit of @keyframes and rAF loops + idle-state visual check.",
      },
      {
        id: "motion-must-reduced-motion",
        polarity: "must",
        policy: "Honor prefers-reduced-motion across all CSS animations, springs, and scroll choreography.",
        enforcement: "Automated media-query check and visual verification in reduced-motion mode.",
      },
      {
        id: "motion-must-compositor-only",
        polarity: "must",
        policy: "Restrict high-frequency animations to transform and opacity to sustain 60-120 FPS.",
        enforcement: "Performance trace / CSS property review.",
      },
      {
        id: "motion-must-frame-check",
        polarity: "must",
        policy: "Verify choreography across consecutive captured frames before presenting any animated build.",
        enforcement: "Pre-delivery motion review gate from taste ledger #1103.",
      },
    ],
    best_practices: [
      {
        practice: "Use 140-200ms ease-out curves for micro-state changes (tabs, toggles, hover borders).",
        benchmark: "Linear & Raycast desktop feel",
        rationale: "Feels instantaneous while preserving visual continuity.",
      },
      {
        practice: "Give trading ticks brief directional flash cues (200ms tint decay) keyed to real order deltas.",
        benchmark: "Institutional trading terminals",
        rationale: "Communicates market velocity at a glance without visual noise.",
      },
      {
        practice: "Treat the browser or UI itself as a physical character in 15-30s launch clips.",
        benchmark: "Arc Browser & Linear Launch Reels",
        rationale: "Shows real craft immediately without vague lifestyle b-roll.",
      },
      {
        practice: "Keep Three.js/Canvas textures safely bounded for Safari and headless verification.",
        benchmark: "neon-3d-webgl cross-browser guardrails",
        rationale: "Prevents silent black canvases on iOS/Safari and VPS headless runners.",
      },
    ],
    reference_canons: [
      { name: "Teenage Engineering Product Page Motion", why: "Benchmark for tactile mechanical detents and industrial micro-interactions." },
      { name: "Linear Launch Reels", why: "UI-only dark-mode choreography with crisp cuts and zero fluff." },
      { name: "Arc Browser Launch Campaigns", why: "Treats software interaction itself as expressive storytelling." },
      { name: "Apple Vision Pro WWDC 2023 Reveal", why: "Ceremonial pacing, deep black contrast, and disciplined product cinematography." },
      { name: "bestdesignsonx.com Tactile Craft", why: "Live frontier calibration bar for physical web details." },
    ],
    linked_interests: [
      "Teenage Engineering - Product Page Motion",
      "Linear - Launch Reels & Product Updates",
      "Design, Motion & Visual Craft",
      "Frontend Craft, AEO & Tactile Interfaces",
    ],
    linked_philosophies: [
      "Motion Craft Doctrine",
      "Operator Design Principles",
      "Owner Anchors: Proof-First Execution",
    ],
    adaptive_questions: [
      {
        domain: "motion_feel",
        title: "What tactile interaction feel belongs on an interactive parameter dial or filter?",
        context: "Adding one signature physical interaction to Kizuki or a public showpiece page.",
        axis: "Tactile Detent Feel",
        priority: 90,
        options: [
          {
            key: "A",
            label: "Mechanical Vernier Detent",
            rationale: "Crisp stepped magnetic clicks with tight 160ms snap and hairline degree ticks like a camera lens.",
            trait_tag: "mechanical-vernier-detent",
            signal_value: 2,
            preview: {
              kind: "motion",
              tokens: ["160ms snap", "stiffness 520", "damping 38"],
              sample_head: "DETENT 01 -> 02",
              sample_body: "Zero wobble, surgical click stop on every tick.",
              badge: "Vernier",
            },
          },
          {
            key: "B",
            label: "Weighted Inertia Glide",
            rationale: "Smooth physical momentum with subtle friction roll-off like a heavy metal jog wheel.",
            trait_tag: "weighted-inertia-glide",
            signal_value: 1,
            preview: {
              kind: "motion",
              tokens: ["friction 0.92", "60fps momentum", "ease-out"],
              sample_head: "INERTIA WHEEL",
              sample_body: "Physical glide that settles gently onto the target.",
              badge: "Weighted",
            },
          },
          {
            key: "C",
            label: "Playful Elastic Spring",
            rationale: "Noticeable bounce overshoot that adds lively cartoon energy to every drag.",
            trait_tag: "playful-elastic-spring",
            signal_value: -1,
            preview: {
              kind: "motion",
              tokens: ["stiffness 260", "damping 14", "overshoot"],
              sample_head: "BOUNCY SPRING",
              sample_body: "Springy wobble on release.",
              badge: "Elastic",
            },
          },
          {
            key: "D",
            label: "Zero Motion Instant Snap",
            rationale: "Pure instant DOM state swaps with no transitions or spatial cues.",
            trait_tag: "zero-motion-instant-snap",
            signal_value: -2,
            preview: {
              kind: "motion",
              tokens: ["0ms", "no transition"],
              sample_head: "INSTANT CUT",
              sample_body: "Hard state jump with no spatial continuity.",
              badge: "Static",
            },
          },
        ],
      },
    ],
  },

  video_anime: {
    thesis:
      "Anime and cinema direction demand genuine AAA craft: layered satsuei compositing (2s/3s cels or real rigged 3D/Live2D over 1s painted worlds), intentional camera blocking, lifted shadows, and ruthless sound-cut rhythm.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Eliminate raw AI anime slop, primitive procedural dolls, and flat ungraded composites.",
        concrete_milestones: [
          "Require genuine rigged 3D anime models (.vrm/.glb) or genuine Live2D rigs for anime-over-real-world shots.",
          "Separate character cels (animated on 2s/3s) from painted multi-plane camera environments (moving on 1s).",
          "Enforce consistent character identity lock and strict shot-sheet blocking before generating frames.",
        ],
        diagnostic_test:
          "Freeze any 3 consecutive frames: do character silhouettes, lighting direction, and eye proportions stay locked with zero AI melt?",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Execute full satsuei compositing, depth-plate typography, and broadcast-grade audio mix hierarchy.",
        concrete_milestones: [
          "Lift cast shadows, add atmospheric haze, subtle halation/bloom, and anime-safe rim relighting.",
          "Depth-test motion graphics and title cards behind foreground subjects using per-frame depth plates.",
          "Mix sound on a strict hierarchy (dialogue/impact lead, rhythmic foley, music bed ducked cleanly, verified LUFS).",
        ],
        diagnostic_test:
          "Watch the clip muted AND listen eyes-closed: does both visual storytelling and audio rhythm hold independently?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Direct anime sequences to studio polish and product trailers to theatrical cinema prestige.",
        concrete_milestones: [
          "Deliver Infinite Idol visuals that feel like a flagship studio gacha reveal rather than a Three.js VRM demo.",
          "Run immutable-candidate video gauntlets with independent frame-by-frame critic passes before acceptance.",
          "Ground film and video production in real cinematography, sound design, and pacing mechanics.",
        ],
        diagnostic_test:
          "Place the clip next to Hoyoverse / ufotable / A24 trailers: does lighting, camera cadence, and cut precision belong in the same room?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Industrialize agentic anime and cinema pipelines combining Shot-Reader cinematography analysis, Seedance 2.0, and programmatic satsuei.",
        concrete_milestones: [
          "Reverse-engineer reference shots into structured JSON shot sheets (lens, height, blocking, camera move) via Shot-Reader.",
          "Automate multi-pass repair loops for identity drift, unwanted extras, and off-beat cuts.",
          "Ship repeatable 15s-90s vertical and widescreen masters that consistently pass owner visual review on take one.",
        ],
        diagnostic_test:
          "Can the pipeline turn a raw brief into a graded, sound-mixed, identity-locked cinema cut that earns immediate approval?",
      },
    ],
    frameworks: [
      {
        name: "Satsuei Layered Anime Pipeline",
        purpose: "Replace flat AI video or raw WebGL dolls with authentic Japanese anime photography (satsuei).",
        steps: [
          "Lock character layer on 2s/3s cadence (authentic cel timing or high-craft rigged VRM/Live2D).",
          "Drive multi-plane painted backgrounds and camera parallax smoothly on 1s.",
          "Lift shadow blacks, apply environmental color bounce, directional rim light, and controlled lens halation.",
          "Composite subtle film grain and depth-of-field rack focus tied to narrative beat.",
        ],
        when_to_use: "Infinite Idol scenes, anime-over-real-world reels, and Seedance 2.0 repair passes.",
      },
      {
        name: "Shot-Reader to Storyboard Execution",
        purpose: "Ground camera blocking and lens choice in real cinema grammar instead of generic AI pans.",
        steps: [
          "Analyze reference footage via Shot-Reader to extract camera height, FOV, move, and actor staging.",
          "Translate shot sheet into an annotated beat-by-beat storyboard with exact duration splits.",
          "Generate immutable candidate takes and reject any take with identity drift or extra background characters.",
        ],
        when_to_use: "Generative video sequences, studio trailers, and launch edits.",
      },
      {
        name: "Three-Gate Video Production Gauntlet",
        purpose: "Guarantee no sloppy render ships past review.",
        steps: [
          "Gate 1: Consecutive frame inspection for identity lock, anatomy, and stray overlays.",
          "Gate 2: Audio preservation, beat alignment, and LUFS loudness verification.",
          "Gate 3: Independent adversarial visual critic review against AAA gacha / A24 standards.",
        ],
        when_to_use: "Before delivering any non-trivial video clip, trailer, or launch reel.",
      },
    ],
    principles: [
      {
        title: "AAA Gacha Bar for Infinite Idol",
        rule: "Infinite Idol must look and feel like a real AAA gacha production, never a bare VRM web app.",
        anti_pattern: "Flat lit Three.js avatars standing on empty grey grids with stiff idle animations.",
      },
      {
        title: "Genuine Rigs Over Primitive Dolls",
        rule: "Anime-over-real-world requires genuine rigged 3D (.vrm/.glb) or Live2D models integrated into real lighting.",
        anti_pattern: "Primitive procedural shapes, sticker-like cutouts, or unlit overlays pasted onto footage.",
      },
      {
        title: "2s/3s Characters Over 1s Worlds",
        rule: "Preserve authentic cel-frame cadence on characters while keeping camera moves and atmospheric effects fluid.",
        anti_pattern: "Soap-opera 60fps interpolated AI anime morphing with rubbery limb drift.",
      },
      {
        title: "Sound Drives the Cut",
        rule: "Picture cuts lock to transient audio beats, breaths, and dynamic silence rather than arbitrary 3-second timers.",
        anti_pattern: "Silent renders or generic stock synth loops slapped underneath mismatched cuts.",
      },
    ],
    policies: [
      {
        id: "video-never-primitive-dolls",
        polarity: "never",
        policy: "Never use primitive procedural dolls for anime-over-real-world video; require genuine rigged 3D/Live2D or satsuei cels.",
        enforcement: "High-conviction rule from the owner taste ledger.",
      },
      {
        id: "video-must-reject-identity-drift",
        polarity: "must",
        policy: "Reject and repair any Seedance or generative take showing character face drift or unwanted extra characters.",
        enforcement: "Immutable candidate inspection across extracted keyframes.",
      },
      {
        id: "video-must-preserve-source-audio",
        polarity: "must",
        policy: "Preserve clean source audio / intentional mix hierarchy and verify LUFS on every rendered master.",
        enforcement: "FFmpeg loudness + waveform inspection before delivery.",
      },
      {
        id: "video-never-unverified-points-claims",
        polarity: "never",
        policy: "Never alter locked master trailers or invent unconfirmed metrics in investor or launch materials.",
        enforcement: "Strict adherence to verified source facts & owner-profile.md gates.",
      },
    ],
    best_practices: [
      {
        practice: "Lift shadow floor with subtle cool-indigo or warm-sepia tint instead of crushing blacks to #000000.",
        benchmark: "Kyoto Animation & Makoto Shinkai satsuei grading",
        rationale: "Creates lush atmospheric depth and prevents muddy mobile playback.",
      },
      {
        practice: "Place display typography behind foreground actors using per-frame depth plates when integrating text into footage.",
        benchmark: "Modern cinema title sequences & taste-depth-plate-motion-graphics",
        rationale: "Grounds type inside the physical world of the shot instead of floating lazily on top.",
      },
      {
        practice: "Build 9:16, 1:1, and 16:9 safe-zone framing intentionally rather than blind center-cropping.",
        benchmark: "Beat-locked launch reel masters",
        rationale: "Protects headline legibility and character eyes across X, mobile, and cinema embeds.",
      },
      {
        practice: "Pair UK film finance narratives (AVEC tax credit, completion bonds) with crisp cinema visuals.",
        benchmark: "Cinema editorial positioning",
        rationale: "Bridges serious institutional film capital with filmmaker-grade aesthetic credibility.",
      },
    ],
    reference_canons: [
      { name: "A24 Trailer & Brand World", why: "Cinema-first restraint and deliberate theatrical pacing." },
      { name: "Infinite Idol AAA Gacha Benchmark", why: "High-conviction owner standard: real AAA gacha polish, zero web-demo feel." },
      { name: "Makoto Shinkai / ufotable Satsuei Craft", why: "Gold standard for light shafts, lifted shadows, and 2s/3s cel integration." },
      { name: "Beat-Locked 15s Launch Masters", why: "Proven 15s 3-act beat-locked title and spec-sheet motion structure." },
    ],
    linked_interests: [
      "Anime, Generative Video & Cinematography",
      "Agentic Video, Shot-Reader & Programmatic Cinema",
      "UK Film Finance, AVEC & Completion Bonds",
      "Anime Direction & Mythic Storytelling",
    ],
    linked_philosophies: [
      "Grading, Film Grain & Shadow Craft",
      "Sound Design & Mix Hierarchy",
      "Creative Doctrine",
    ],
    adaptive_questions: [
      {
        domain: "video_anime",
        title: "What visual lighting signature defines Infinite Idol's signature character reveal shot?",
        context: "Directing a 15-second character debut cut for Infinite Idol.",
        axis: "Infinite Idol Lighting Grade",
        priority: 95,
        options: [
          {
            key: "A",
            label: "Satsuei Rim Light + Lifted Indigo Shadows",
            rationale: "Deep indigo lifted blacks, crisp hair rim light, drifting dust motes, and subtle lens halation on highlights.",
            trait_tag: "satsuei-rim-lifted-indigo",
            signal_value: 2,
            preview: {
              kind: "swatch",
              tokens: ["#161829", "#F8FAFC", "#FF4D8D", "Halation 12%"],
              sample_head: "ACT 01 // STAGE ENTRANCE",
              sample_body: "2s character cel over 1s multi-plane concert haze.",
              badge: "Satsuei",
            },
          },
          {
            key: "B",
            label: "Golden Hour 35mm Anamorphic",
            rationale: "Warm tungsten rim flare, soft 35mm film grain, and nostalgic cinema warmth.",
            trait_tag: "golden-hour-35mm-anamorphic",
            signal_value: 1,
            preview: {
              kind: "swatch",
              tokens: ["#241A15", "#F5D0A9", "#E88D4F", "35mm Grain"],
              sample_head: "GOLDEN ANAMORPHIC",
              sample_body: "Warm backlight with shallow cinema rack focus.",
              badge: "35mm",
            },
          },
          {
            key: "C",
            label: "High-Key Pop Studio White",
            rationale: "Bright crisp studio key light with saturated pastel pops and clean graphic silhouettes.",
            trait_tag: "high-key-pop-studio",
            signal_value: 0,
            preview: {
              kind: "swatch",
              tokens: ["#F8FAFC", "#0F172A", "#38BDF8", "High-Key"],
              sample_head: "POP STUDIO REVEAL",
              sample_body: "Clean high-contrast idol showcase.",
              badge: "Studio",
            },
          },
          {
            key: "D",
            label: "Default Real-Time WebGL Neutral",
            rationale: "Standard directional light on a dark viewport with flat toon shading and zero compositing.",
            trait_tag: "default-webgl-neutral",
            signal_value: -2,
            preview: {
              kind: "swatch",
              tokens: ["#1F2937", "#D1D5DB", "No post-fx"],
              sample_head: "VRM VIEWER DEFAULT",
              sample_body: "Raw ungraded shader viewport.",
              badge: "Raw",
            },
          },
        ],
      },
    ],
  },

  merch_objects: {
    thesis:
      "Physical objects and apparel must carry heavy material honesty, Japanese streetwear silhouette precision (dropped shoulder, thick collar rib, sharp back graphic), and zero cheap conference-swag energy.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Eliminate generic startup swag and always run 3-5 targeted taste forks before producing physical batches.",
        concrete_milestones: [
          "Lock fabric weight floors (heavyweight 280-320gsm tees, 450-550gsm French terry hoodies).",
          "Run 3 to 5 crisp multiple-choice taste forks with visual references before commissioning any batch.",
          "Ban thin promotional blanks, loud front chest corporate logos, and cheap glossy poly-bags.",
        ],
        diagnostic_test:
          "Would you actually wear this garment out on a weekend without being paid to promote the brand?",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Master oversized Japanese streetwear cuts, sculptural typography back-prints, and tactile unboxing.",
        concrete_milestones: [
          "Specify exact garment geometry: dropped shoulder, boxy cropped torso, thick mock-rib collar.",
          "Pair understated front mark or woven label with bold typographic manifesto or graphic art on the back.",
          "Design VIP packaging with rigid matte board, embossed foil/deboss, and numbered edition cards.",
        ],
        diagnostic_test:
          "Inspect the garment inside-out: do seam stitching, collar density, woven tags, and print hand-feel pass boutique inspection?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Curate cohesive desk hardware, everyday carry, VIP venture drops, and meaningful personal gifts.",
        concrete_milestones: [
          "Apply industrial materiality (anodized aluminum, machined brass, matte ceramic, heavyweight cotton) across objects.",
          "Build limited-edition studio VIP drops that recipients keep on their desk permanently.",
          "Maintain clear personal-style guardrails for thoughtful personal gifts without generic luxury cliches.",
        ],
        diagnostic_test:
          "Does the recipient photograph the unboxing unprompted because the physical craft feels rare?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Turn physical artifacts into lasting brand mythology that bridges digital craft and real-world status.",
        concrete_milestones: [
          "Release numbered archival monographs, physical hardware keys, or capsule streetwear collabs with independent studios.",
          "Maintain a verified supplier and spec ledger (GSM, pantone/ink formulas, mill sources, packaging dielines).",
          "Continuously deepen personal object preferences through adaptive visual forks in Kizuki Taste Studio.",
        ],
        diagnostic_test:
          "Five years later, is the object still worn or kept on a shelf as a prized artifact rather than discarded?",
      },
    ],
    frameworks: [
      {
        name: "Pre-Batch 3-5 Fork Calibration Protocol",
        purpose: "Compensate for thin personal-merch docs before committing to physical designs.",
        steps: [
          "Present 3 to 5 concrete multiple-choice forks covering silhouette, graphic placement, palette, and packaging.",
          "Include concrete physical specs (GSM, weave, print technique) in each option.",
          "Lock verdicts into Taste Studio before ordering samples or manufacturing.",
        ],
        when_to_use: "Every new apparel drop, VIP founder kit, desk object, or personal gift shortlist.",
      },
      {
        name: "Boutique Streetwear Spec Sheet",
        purpose: "Translate taste into factory-ready garment instructions that prevent cheap blanks.",
        steps: [
          "Lock cut: dropped shoulder, boxy drape, thick high-rib neckband.",
          "Lock fabric: 280-320gsm combed cotton tee or 480gsm+ loopback hoodie.",
          "Lock decoration: minimal front detail, high-craft screenprint/puff/embroidery manifesto on back, custom woven hem label.",
        ],
        when_to_use: "Studio or personal capsule apparel production.",
      },
      {
        name: "Tactile Unboxing Sequence",
        purpose: "Make VIP boxes and gifts feel deliberate from outer shipper to final card.",
        steps: [
          "Use rigid uncoated matte outer box with subtle blind deboss.",
          "Include one numbered technical spec card or archival manifesto sheet (zero corporate flyers).",
          "Eliminate cheap foam or shiny plastic inserts in favor of molded pulp or wrapped tissue.",
        ],
        when_to_use: "Founder kits, investor gifts, and milestone deliveries.",
      },
    ],
    principles: [
      {
        title: "London Streetwear Credibility Test",
        rule: "Apparel must pass as independent Japanese or London boutique streetwear, never crypto conference swag.",
        anti_pattern: "Thin Gildan tees with a giant startup logo slapped across the chest.",
      },
      {
        title: "Heavyweight Material Honesty",
        rule: "Weight, drape, seam structure, and tactile finish carry more luxury than loud branding.",
        anti_pattern: "Lightweight synthetic blends masked by flashy colors or gimmicky packaging.",
      },
      {
        title: "Ask 3-5 Forks Before Shipping a Batch",
        rule: "Because personal object taste is still calibrating, lock explicit visual forks before drafting batches.",
        anti_pattern: "Guessing a generic gift or merch catalog and wasting review time on generic catalog options.",
      },
      {
        title: "Back-Canvas Graphic Authority",
        rule: "Keep the front understated and disciplined; use the back for crisp graphic art or typographic manifesto.",
        anti_pattern: "Cluttered multi-logo sleeve prints and sponsor walls.",
      },
    ],
    policies: [
      {
        id: "merch-must-fork-before-batch",
        polarity: "must",
        policy: "Ask 3 to 5 crisp multiple-choice taste questions before proposing a merch or personal object batch.",
        enforcement: "Explicit calibration protocol in owner-profile.md.",
      },
      {
        id: "merch-must-heavyweight-cut",
        polarity: "must",
        policy: "Default apparel specs to oversized Japanese streetwear silhouettes (dropped shoulder, thick collar rib, heavyweight cotton).",
        enforcement: "Calibrated Taste Studio verdict: japanese-graphic-streetwear.",
      },
      {
        id: "merch-never-conference-swag",
        polarity: "never",
        policy: "Never pitch thin promo blanks, cheap plastic trinkets, or loud front-chest corporate logos.",
        enforcement: "Spec-sheet review gate prior to quoting vendors.",
      },
      {
        id: "merch-never-spend-without-gate",
        polarity: "never",
        policy: "Never place paid orders or commit spend without explicit owner approval.",
        enforcement: "Standing spend gate in owner-profile.md.",
      },
    ],
    best_practices: [
      {
        practice: "Specify matte water-based discharge or high-density puff ink rather than plasticky heat transfers.",
        benchmark: "Cav Empt, Human Made & Japanese independent print houses",
        rationale: "Ages gracefully with washes and preserves fabric breathability.",
      },
      {
        practice: "Favor machined aluminum, matte titanium, or dark ceramic for desk hardware and everyday carry.",
        benchmark: "Teenage Engineering, Braun/Dieter Rams & Japanese stationery craft",
        rationale: "Matches the restrained tactile world across flagship digital products.",
      },
      {
        practice: "Number VIP editions (e.g., 014/100) on heavy 350gsm cotton card stock.",
        benchmark: "Art-book monographs & limited streetwear drops",
        rationale: "Signals intentional scarcity and collectible permanence.",
      },
      {
        practice: "Source physical garments with pre-shrunk enzyme-washed heavyweight cotton.",
        benchmark: "Los Angeles Apparel / Japanese loopwheel mills",
        rationale: "Eliminates fit distortion after the first wash.",
      },
    ],
    reference_canons: [
      { name: "Japanese Graphic Streetwear (Cav Empt / WTAPS / Neighborhood)", why: "Exact silhouette and back-print graphic authority calibrated to refined streetwear craft." },
      { name: "Teenage Engineering Industrial Hardware", why: "Benchmark for physical detents, typography on metal, and object delight." },
      { name: "A24 Physical Editions & Zines", why: "Collector-grade packaging and printed monographs people display." },
      { name: "Dieter Rams / Braun Object Restraint", why: "Timeless honest materials with zero decorative plastic." },
    ],
    linked_interests: [
      "Live Owner Taste Ledger & Verdicts",
      "Design, Motion & Visual Craft",
      "Editorial & Commercial Brand Design Precedents",
    ],
    linked_philosophies: [
      "Specificity Beats Polish",
      "Visual & Copy Anti-Patterns",
      "Composition & Negative Space Laws",
    ],
    adaptive_questions: [
      {
        domain: "merch_objects",
        title: "What physical VIP artifact should accompany a flagship product launch kit?",
        context: "Selecting a tactile collector object for 50 key partners and founders.",
        axis: "VIP Collector Object",
        priority: 96,
        options: [
          {
            key: "A",
            label: "Numbered Hardcover Monograph",
            rationale: "Heavy uncoated art book documenting the thesis, visual world, and numbered colophon.",
            trait_tag: "numbered-hardcover-monograph",
            signal_value: 2,
            preview: {
              kind: "swatch",
              tokens: ["350gsm Cotton", "Blind Deboss", "Edition /50"],
              sample_head: "MONOGRAPH NO. 01",
              sample_body: "Archival print edition built to live on a coffee table.",
              badge: "Print",
            },
          },
          {
            key: "B",
            label: "Heavyweight Capsule Hoodie",
            rationale: "500gsm washed charcoal oversized hoodie with tonal front seam mark and sharp back typography.",
            trait_tag: "heavyweight-capsule-hoodie",
            signal_value: 2,
            preview: {
              kind: "swatch",
              tokens: ["#1F2022", "500gsm Terry", "Dropped Shoulder"],
              sample_head: "CAPSULE HOODIE",
              sample_body: "Boutique Japanese cut people genuinely wear out.",
              badge: "Apparel",
            },
          },
          {
            key: "C",
            label: "Machined Metal Desk Instrument",
            rationale: "Bead-blasted aluminum paperweight, key tray, or numbered hardware token with engraved specs.",
            trait_tag: "machined-metal-desk-object",
            signal_value: 1,
            preview: {
              kind: "swatch",
              tokens: ["#A1A1AA", "CNC Aluminum", "Laser Spec"],
              sample_head: "CNC DESK ARTIFACT",
              sample_body: "Tactile industrial metal that stays on the desk.",
              badge: "Hardware",
            },
          },
          {
            key: "D",
            label: "Branded Tumbler & Sticker Pack",
            rationale: "Standard insulated mug, notebook, and die-cut stickers in a printed box.",
            trait_tag: "generic-conference-kit",
            signal_value: -2,
            preview: {
              kind: "swatch",
              tokens: ["Tumbler", "Stickers", "Logo Box"],
              sample_head: "SWAG BUNDLE",
              sample_body: "Standard startup welcome kit.",
              badge: "Swag",
            },
          },
        ],
      },
    ],
  },

  spaces_life: {
    thesis:
      "Real-world experiences split into two high standards: intentional theatre-plus-supper city evenings (zero phone presence) and step-free luxury family trips with zero access surprises.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Enforce hard household constraints on every family or couple plan before suggesting a single venue.",
        concrete_milestones: [
          "Apply a strict step-free accessibility filter: single-level or verified lifts, zero bunk-only rooms, zero stairs-only excursions.",
          "Respect real door-to-door logistics: build seamless taxi, driver, or step-free rail routing without assuming a rental car.",
          "Protect dedicated evening couple windows and personal firewall hours.",
        ],
        diagnostic_test:
          "Audit any proposed hotel or itinerary for complete step-free routing from drop-off to bedroom, bathroom, and dining with zero improvisation.",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Curate outward city evenings anchored in live theatre plus unhurried late supper.",
        concrete_milestones: [
          "Stretch outward into the city rather than defaulting to staying in.",
          "Pair sharp theatre (National Theatre, Donmar, Bridge, Almeida, West End) with nearby candlelit dining open post-curtain.",
          "Keep keto-compatible options effortless without wellness preachiness.",
        ],
        diagnostic_test:
          "Does the evening feel like a thoughtful move genuinely personal rather than a scripted automated calendar block?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Design multi-age luxury family trips that delight every age group in the family without parent burnout.",
        concrete_milestones: [
          "Layer memorable sparks for every child alongside sensory-rich step-free comfort.",
          "Pre-verify interconnecting or ground-floor accessible luxury suites, roll-in showers, and calm transfer timing.",
          "Respect real household budget trade-offs (two-income mortgage reality) by spending where friction vanishes.",
        ],
        diagnostic_test:
          "Does the trip plan remove logistical stress for both parents while creating at least 2 core memories per daughter?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Maintain a living, verified London and European venue canon tailored to the household rhythm.",
        concrete_milestones: [
          "Track verified step-free luxury hotels, private-transfer operators, and post-theatre supper spots in Kizuki.",
          "Pair calendar anchors (anniversaries Aug 8/9, birthdays Jan 8, Aug 27, Oct 23, Dec 17, Dec 20, Ramadan/Eid) with early zero-stress shortlists.",
          "Eliminate presence-by-proximity by making logistics invisible so everyone is 100% present without phone distractions.",
        ],
        diagnostic_test:
          "Can any family weekend or London couple night go from 1-line ask to verified, friction-free execution in 2 minutes?",
      },
    ],
    frameworks: [
      {
        name: "Step-Free Accessibility Venue Gate",
        purpose: "Filter out inaccessible hotels, chalets, and excursions before wasting a second reviewing them.",
        steps: [
          "Verify named step-free entrance, lift dimensions, and single-level suite or ground-floor bedroom.",
          "Reject two-storey lofts, bunk-only kids rooms, cobbled stairs-only transfers, and stairs-only mountain rides.",
          "Confirm accessible bathroom layout and smooth door-to-door vehicle transfer (no self-drive assumption).",
        ],
        when_to_use: "Every single family trip, restaurant, resort, or day out requiring step-free accessibility.",
      },
      {
        name: "Theatre + Late Supper Outward Evening Blueprint",
        purpose: "Hit the calibrated city-evening sweet spot while countering stay-at-home inertia.",
        steps: [
          "Pick one sharp, critically praised stage production worth going out for.",
          "Book a candlelit late-supper restaurant within a 6-minute walk or 4-minute black cab from the stage door.",
          "Confirm childcare handoff and a friction-free return ride.",
          "Leave work phone dark so presence is total, not presence-by-proximity.",
        ],
        when_to_use: "London couple nights, Friday evening planning, and milestone anniversaries.",
      },
      {
        name: "Three-Daughter Joy Matrix",
        purpose: "Balance family itineraries across ages 3, 7, and 9 with distinct needs and interests.",
        steps: [
          "Verify step-free comfort, sensory pacing, and evening bedtime rhythm.",
          "Anchor one high-energy cultural or sporting spark for older kids.",
          "Anchor one playful, wonder-filled hook for younger kids.",
        ],
        when_to_use: "School holidays, weekend outings, and European family travel planning.",
      },
    ],
    principles: [
      {
        title: "Wheelchair Access Is Operational, Never Optional",
        rule: "Every family travel recommendation must verify concrete step-free access before inclusion.",
        anti_pattern: "Listing boutique lofts, steep mountain lifts, or 'probably accessible' hotels without proof.",
      },
      {
        title: "Stretch Outward Into the City",
        rule: "Evening plans should stretch outward into live theatre and warm dining rather than defaulting to staying home.",
        anti_pattern: "Suggesting takeout on the sofa or generic spa packages when a sharp West End night fits better.",
      },
      {
        title: "Total Presence Over Presence-by-Proximity",
        rule: "Great household planning removes friction so attention stays fully present, not glancing at work on a phone.",
        anti_pattern: "Over-scheduled itineraries or visibly robotic system-scripted date templates.",
      },
      {
        title: "Zero Driving Assumption",
        rule: "Plan every city and travel leg around hired drivers, taxis, or verified step-free rail transfers.",
        anti_pattern: "Assuming self-drive car rentals in dense city trips.",
      },
    ],
    policies: [
      {
        id: "spaces-must-wheelchair-hard-filter",
        polarity: "must",
        policy: "Verify single-level or lift-equipped step-free access on every family trip and venue.",
        enforcement: "Non-negotiable accessibility filter in owner-profile.md.",
      },
      {
        id: "spaces-must-protect-friday-firewall",
        polarity: "must",
        policy: "Protect dedicated weekend evening firewalls and keep personal plans genuinely human.",
        enforcement: "Household scheduling policy in owner-profile.md.",
      },
      {
        id: "spaces-never-outbound-family-without-draft",
        polarity: "never",
        policy: "Never send outbound messages to family, schools, or clinicians directly; draft locally for explicit owner send.",
        enforcement: "Hard stop #2: zero unauthorized outbound sends.",
      },
      {
        id: "spaces-never-wellness-fluff",
        polarity: "never",
        policy: "Respect keto preferences pragmatically without lecturing or infantilizing wellness fluff.",
        enforcement: "Tone guard in owner-profile.md.",
      },
    ],
    best_practices: [
      {
        practice: "Shortlist National Theatre, Donmar Warehouse, Bridge Theatre, and Almeida alongside standout West End runs.",
        benchmark: "Calibrated Taste Studio verdict: theatre-plus-late-supper",
        rationale: "Consistently delivers sharp writing and memorable theatre and supper evenings.",
      },
      {
        practice: "Pair South Bank or Soho/Covent Garden shows with late-seating candlelit brasseries or grills.",
        benchmark: "Keto-friendly high-craft London dining (steaks, seafood, small plates)",
        rationale: "Works cleanly after a 22:00 curtain without rushing or rigid tasting-menu fatigue.",
      },
      {
        practice: "Confirm passport validity and accessible private airport/resort transfers at least 4 weeks out.",
        benchmark: "Smooth 6-person family trip operations (e.g., Garmisch 2026)",
        rationale: "Eliminates last-minute document or mobility surprises.",
      },
      {
        practice: "Keep Ramadan and Eid marked as cultural family anchors without religious assumptions.",
        benchmark: "owner-profile.md",
        rationale: "Honors real household rhythm accurately.",
      },
    ],
    reference_canons: [
      { name: "London National Theatre & West End + Late Supper", why: "Locked top-signal couple-night standard calibrated to refined streetwear craft." },
      { name: "Wheelchair-First European Luxury Family Resorts", why: "Step-free suites, verified lifts, and zero-friction step-free transfers." },
      { name: "Garmisch 6-Person Family Trip Template", why: "Proven real-world family logistics anchor." },
      { name: "Candlelit London Brasseries (Soho / Covent Garden / South Bank)", why: "Post-curtain warmth with effortless keto protein options." },
    ],
    linked_interests: [
      "City Theatre & Late Supper Nights",
      "Accessible Family Travel & Adventures",
      "Keto & Body-Recomp Discipline",
    ],
    linked_philosophies: [
      "Specificity Beats Polish",
      "Compounding Context",
      "Boil the Ocean (Zero Marginal Cost of Completeness)",
    ],
    adaptive_questions: [
      {
        domain: "spaces_life",
        title: "What style of late supper pairs best right after an evening theatre curtain?",
        context: "Locking the post-22:00 dining atmosphere after a West End or National Theatre show.",
        axis: "Post-Theatre Supper Vibe",
        priority: 95,
        options: [
          {
            key: "A",
            label: "Candlelit Brasserie / Wood-Fire Grill",
            rationale: "Warm dim lighting, crisp white linen or dark wood, great steak/seafood, and unhurried conversation.",
            trait_tag: "candlelit-brasserie-grill",
            signal_value: 2,
            preview: {
              kind: "copy",
              tokens: ["22:15 Table", "Candlelit", "Keto-Easy"],
              sample_head: "Late Supper Near Stage Door",
              sample_body: "Warm buzz, crisp grill menu, zero rush out the door.",
              badge: "Warm",
            },
          },
          {
            key: "B",
            label: "Intimate Counter Omakase / Izakaya",
            rationale: "Quiet high-craft counter dining with sharp Japanese plates and focused culinary theater.",
            trait_tag: "intimate-japanese-counter",
            signal_value: 1,
            preview: {
              kind: "copy",
              tokens: ["Counter", "Japanese", "Focused"],
              sample_head: "Late Counter Craft",
              sample_body: "Small plates, quiet intensity, minimal room noise.",
              badge: "Counter",
            },
          },
          {
            key: "C",
            label: "Grand Hotel Bar & Small Plates",
            rationale: "Plush classic London hotel lounge with polished service and quiet booths.",
            trait_tag: "grand-hotel-lounge",
            signal_value: 0,
            preview: {
              kind: "copy",
              tokens: ["Mayfair/Strand", "Quiet Booth", "Classic"],
              sample_head: "Classic Hotel Lounge",
              sample_body: "Calm luxury booths with late kitchen service.",
              badge: "Hotel",
            },
          },
          {
            key: "D",
            label: "Loud Trendy Tasting Menu",
            rationale: "High-volume hotspot with 12 rigid courses and bright scene lighting.",
            trait_tag: "loud-trendy-tasting",
            signal_value: -2,
            preview: {
              kind: "copy",
              tokens: ["2.5h Tasting", "High Noise", "Scene"],
              sample_head: "Scene Hotspot",
              sample_body: "Loud room and rigid multi-course pacing late at night.",
              badge: "Scene",
            },
          },
        ],
      },
    ],
  },

  agent_ops: {
    thesis:
      "Agents exist to reconstruct full intent from compressed prompts, boil the ocean autonomously inside two hard stops, route efficiently across local and fallback models, and never declare done without fresh observed proof.",
    mastery_path: [
      {
        level: 1,
        stage: "Foundation",
        goal: "Eliminate permission chatter, apology sludge, verbose essays, and unverified claims across every agent face.",
        concrete_milestones: [
          "Lead every reply with concrete state changes, numbers, and proof rather than activity logs.",
          "Act autonomously on reversible and authorized work; gate only on secret exfiltration, spend, and outbound sends as the owner.",
          "Strip em-dashes and never ask the user to copy, paste, or relay manually.",
        ],
        diagnostic_test:
          "Audit 10 recent agent replies: zero 'Would you like me to proceed?', zero em-dashes, 100% backed by fresh command or visual proof.",
      },
      {
        level: 2,
        stage: "Practitioner",
        goal: "Execute Fable Delta Doctrine: read to answer questions, discriminate hypotheses before editing, and verify after the final change.",
        concrete_milestones: [
          "Enumerate >=2 candidate causes on every failure and run the cheapest discriminating check before patching.",
          "Build falsifiable verification oracles (tests, live curls, rendered PNGs) BEFORE trusting green.",
          "Route fast local inference cleanly on the primary loopback LLM (:8003, top_p 0.95, reasoning_effort low) with automatic fallback (:8788).",
        ],
        diagnostic_test:
          "When a build breaks, does the agent name the invalidated assumption instead of retrying verbatim?",
      },
      {
        level: 3,
        stage: "Taste Authority",
        goal: "Orchestrate multi-agent continuity (Codex, Claude Code, local workers) and disjoint parallel swarms with zero drift.",
        concrete_milestones: [
          "Maintain one shared brain across ~/.operator/, .maestro/, Kizuki Vault, and Agent Board so any face resumes cleanly.",
          "Align every project harness with live repo ground truth and stranger-usable install verification.",
          "Enforce trading-desk truth: idle cash, blocked markets, and rules that cost profit are treated as P0 bugs.",
        ],
        diagnostic_test:
          "Hand an in-flight mission from Neon to Codex or Claude Code: can it resume from ledger state with zero repeated explanation from the owner?",
      },
      {
        level: 4,
        stage: "Frontier Pioneer",
        goal: "Build self-evolving, empirically hill-climbed autonomous systems that compound taste, memory, and execution quality unattended.",
        concrete_milestones: [
          "Run scheduled self-evolving gardeners (Taste, AEO/GTM, Kizuki consolidation) that deepen canon on local free compute.",
          "Capture every owner verdict into durable taste memory and MemT experiences automatically.",
          "Pair strict security boundaries (zero secret leaks, 0600 local stores) with maximum execution speed.",
        ],
        diagnostic_test:
          "Does the entire agent mesh get measurably sharper every week without repeating a single correction?",
      },
    ],
    frameworks: [
      {
        name: "Boil-the-Ocean Completeness Loop",
        purpose: "Ship the finished root-cause artifact rather than partial wins or plans.",
        steps: [
          "Expand compressed owner prompt against Taste Memory, owner-profile.md, and live repo ground truth.",
          "Map every must-be-true invariant into an explicit checklist.",
          "Execute parallel reads/edits or disjoint swarm lanes with zero stubs or deferred workarounds.",
          "Run fresh end-to-end verification AFTER the very last edit and attach exact receipts.",
        ],
        when_to_use: "Every engineering build, bug fix, infrastructure migration, or product ship.",
      },
      {
        name: "Primary Local LLM -> Fallback Dual-Engine Routing",
        purpose: "Maximize free local inference quality while surviving tunnel blips with zero hangs.",
        steps: [
          "Pre-flight primary loopback LLM :8003/health with a tight 1.5s timeout.",
          "Send top_p: 0.95, temperature: 0.3, reasoning_effort: 'low' (NEVER chat_template_kwargs).",
          "Strip <think> blocks and never expose reasoning_content.",
          "Fail over cleanly to local MiniMax M2.7 :8788 with Bearer token from Tomb/bridge.token, then deterministic fallback.",
        ],
        when_to_use: "All Kizuki Mind Explorer synthesis, enrichment, and Taste Gardener runs.",
      },
      {
        name: "Hypothesis Discrimination Protocol",
        purpose: "Kill guess-and-patch debugging loops.",
        steps: [
          "List at least 2 distinct candidate root causes for the observed symptom.",
          "Run the single cheapest read/check that separates them.",
          "After any failure, explicitly name which assumption died before touching code again.",
        ],
        when_to_use: "Any test failure, production regression, or unexpected runtime behavior.",
      },
    ],
    principles: [
      {
        title: "No Done Without Fresh Proof",
        rule: "Every completion claim attaches live command output, test counts, HTTP response, or inspected rendered pixels run after the last edit.",
        anti_pattern: "Claiming 'fixed' from static reading or stale test runs before a trailing edit.",
      },
      {
        title: "Reconstruct Full Intent From Compressed Prompts",
        rule: "Expand short prompts using the owner's local canon, projects, and history rather than asking clarifying filler.",
        anti_pattern: "Replying to a crisp ask with 8 tentative questions or a timid plan-only response.",
      },
      {
        title: "Distribution Reality Beats Technical Purity",
        rule: "Anchor technical and product strategy in verified ground truth and real distribution evidence.",
        anti_pattern: "Building academically pure infrastructure detached from liquidity, users, or distribution.",
      },
      {
        title: "Zero Theatre, Zero Idle-Cash Excuses",
        rule: "In trading and ops systems, blocked markets, idle capital, and profit-destroying safety theatre are bugs to fix at root cause.",
        anti_pattern: "Celebrating green mock unit tests while live execution sits idle or bleeds edge.",
      },
    ],
    policies: [
      {
        id: "ops-never-exfiltrate-secrets",
        polarity: "never",
        policy: "Never print, commit, upload, or transmit tokens, .env secrets, bridge.token values, or private keys.",
        enforcement: "Hard stop #1 + sanitizer redaction + 0600 file permissions.",
      },
      {
        id: "ops-never-send-outbound-as-owner",
        polarity: "never",
        policy: "Never send outbound DMs, emails, or public posts as the owner without explicit approval.",
        enforcement: "Hard stop #2: draft freely, gate sends.",
      },
      {
        id: "ops-must-respect-g4-sampling-contract",
        polarity: "must",
        policy: "Call primary loopback LLM :8003 with top_p: 0.95, temperature: 0.3, reasoning_effort: 'low', and NEVER chat_template_kwargs.",
        enforcement: "Dual-engine client contract + unit tests.",
      },
      {
        id: "ops-never-manual-relay",
        polarity: "never",
        policy: "Never ask the owner to manually copy, paste, or relay commands/data between systems an agent can wire directly.",
        enforcement: "Standing operating rule in owner-profile.md.",
      },
    ],
    best_practices: [
      {
        practice: "Use atomic write-to-tmp + chmod 0600 + rename for every local JSON state store and vault dossier.",
        benchmark: "Kizuki Taste & Gardener persistence layer",
        rationale: "Prevents partial writes under concurrent runs and protects private personal intelligence.",
      },
      {
        practice: "Keep Kizuki ready to the stranger-usable bar: install and operate cleanly with zero tribal context.",
        benchmark: "Stranger-usable Kizuki install bar",
        rationale: "Forces real product polish instead of fragile developer-only scripts.",
      },
      {
        practice: "Respect project ownership boundaries and verify scope before crossing repository seams.",
        benchmark: "owner-profile.md project boundaries",
        rationale: "Prevents costly misdirected effort and off-brand positioning.",
      },
      {
        practice: "Report state changes with exact numbers (e.g. '8/8 domains cultivated, 24/24 tests passing') instead of vague prose.",
        benchmark: "Fable Delta Doctrine section 11",
        rationale: "Maximizes signal per word for rapid owner verification.",
      },
    ],
    reference_canons: [
      { name: "Operator Constitution & Fable Delta Doctrine", why: "Canonical 11-section operating law across all four agent faces." },
      { name: "owner-profile.md Operating Card", why: "Verified ground truth for projects, preferences, and standing gates." },
      { name: "Kizuki Mind Explorer Architecture", why: "Local-first personal intelligence OS with dual-engine local LLM + fallback synthesis." },
      { name: "Local-First Agent Harness Design", why: "Deterministic verification and compounding local memory." },
    ],
    linked_interests: [
      "AI Agents, Harnesses & Local Models",
      "Solana is the home-team chain",
      "Crypto, Solana & On-Chain Markets",
      "Developer Tools, Systems & Infrastructure",
      "Multi-Agent Systems & Swarm Architecture",
    ],
    linked_philosophies: [
      "Boil the Ocean (Zero Marginal Cost of Completeness)",
      "Full Autonomy with Hard Gates Only",
      "Owner Anchors: Proof-First Execution",
      "Distribution Reality Beats Technical Purity",
      "AI-First Operating Philosophy",
    ],
    adaptive_questions: [
      {
        domain: "agent_ops",
        title: "When an autonomous gardener finishes a 6-hour sweep, how should it surface progress?",
        context: "Tuning ambient notification hygiene across Kizuki and Agent Board.",
        axis: "Gardener Reporting Cadence",
        priority: 93,
        options: [
          {
            key: "A",
            label: "Silent State + Live Dashboard Ledger",
            rationale: "Update dossiers and activity log quietly; only ping the owner on errors or concrete gate items.",
            trait_tag: "silent-state-live-ledger",
            signal_value: 2,
            preview: {
              kind: "copy",
              tokens: ["Zero Noise", "Live UI", "Alert on Error"],
              sample_head: "QUIET COMPOUNDING",
              sample_body: "State deepens every 6h; zero chat spam unless broken.",
              badge: "Silent",
            },
          },
          {
            key: "B",
            label: "One-Line Daily Digest Receipt",
            rationale: "Roll up all 4 daily sweeps into a single terse morning metric line.",
            trait_tag: "one-line-daily-digest",
            signal_value: 1,
            preview: {
              kind: "copy",
              tokens: ["08:00 UTC", "1 Line", "Delta Only"],
              sample_head: "MORNING DELTA",
              sample_body: "+4 frameworks, +6 policies, +8 MCQs across 8 domains.",
              badge: "Digest",
            },
          },
          {
            key: "C",
            label: "Per-Sweep Summary Ping",
            rationale: "Post a short bulleted recap to chat every 6 hours when each sweep ends.",
            trait_tag: "per-sweep-chat-ping",
            signal_value: -1,
            preview: {
              kind: "copy",
              tokens: ["Every 6h", "Chat Ping"],
              sample_head: "SWEEP COMPLETE",
              sample_body: "4 notifications per day even on routine runs.",
              badge: "Chatty",
            },
          },
          {
            key: "D",
            label: "Full Markdown Report Dump",
            rationale: "Send the entire updated dossier text into chat after every run.",
            trait_tag: "full-markdown-dump",
            signal_value: -2,
            preview: {
              kind: "copy",
              tokens: ["2000 words", "Wall of Text"],
              sample_head: "FULL DOSSIER REPORT",
              sample_body: "Long verbose summary pushed to main chat.",
              badge: "Verbose",
            },
          },
        ],
      },
    ],
  },
};

// ============================================================================
// Merging, Validation & Dossier Compilation Helpers
// ============================================================================

function mergeUniqueByKey<T>(
  existing: T[],
  incoming: T[],
  keyFn: (item: T) => string,
  maxItems: number
): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  // Prefer newer incoming refinements first if same key, then preserve remaining existing items
  for (const item of incoming) {
    const k = keyFn(item).toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= maxItems) return out;
  }
  for (const item of existing) {
    const k = keyFn(item).toLowerCase().trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
    if (out.length >= maxItems) return out;
  }
  return out;
}

function mergeUniqueStrings(existing: string[], incoming: string[], maxItems: number): string[] {
  return mergeUniqueByKey(
    existing.map((s) => cleanShort(s, 120)).filter(Boolean),
    incoming.map((s) => cleanShort(s, 120)).filter(Boolean),
    (s) => s,
    maxItems
  );
}

const CANONICAL_STAGE_NAMES = [
  "Foundation",
  "Practitioner",
  "Taste Authority",
  "Frontier Pioneer",
] as const;

function parseMasteryPath(raw: unknown, fallback: MasteryStage[]): MasteryStage[] {
  if (!Array.isArray(raw) || raw.length === 0) return fallback;
  const parsed: MasteryStage[] = [];
  for (let idx = 0; idx < 4; idx++) {
    const fb = fallback[idx] || fallback[fallback.length - 1];
    const item = raw[idx];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      parsed.push(fb);
      continue;
    }
    const obj = item as Record<string, unknown>;
    const goal = cleanShort(obj.goal, 260) || fb.goal;
    const rawMilestones = Array.isArray(obj.concrete_milestones)
      ? obj.concrete_milestones.map((m) => cleanShort(m, 200)).filter(Boolean)
      : [];
    const milestones = rawMilestones.length >= 2 ? rawMilestones.slice(0, 4) : fb.concrete_milestones;
    const diag = cleanShort(obj.diagnostic_test, 260) || fb.diagnostic_test;
    const stageRaw = cleanShort(obj.stage, 48);
    const stage = stageRaw || CANONICAL_STAGE_NAMES[idx];
    parsed.push({
      level: idx + 1,
      stage,
      goal,
      concrete_milestones: milestones,
      diagnostic_test: diag,
    });
  }
  return parsed;
}

function parseFrameworks(raw: unknown, fallback: DomainFramework[]): DomainFramework[] {
  if (!Array.isArray(raw)) return fallback;
  const out: DomainFramework[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = cleanShort(obj.name, 90);
    const purpose = cleanShort(obj.purpose, 220);
    const when_to_use = cleanShort(obj.when_to_use, 200);
    const steps = Array.isArray(obj.steps)
      ? obj.steps.map((s) => cleanShort(s, 180)).filter(Boolean).slice(0, 6)
      : [];
    if (name && purpose && steps.length >= 2) {
      out.push({
        name,
        purpose,
        steps,
        when_to_use: when_to_use || "Apply during design, production, or review passes.",
      });
    }
  }
  return out.length >= 2 ? out : fallback;
}

function parsePrinciples(raw: unknown, fallback: DomainPrinciple[]): DomainPrinciple[] {
  if (!Array.isArray(raw)) return fallback;
  const out: DomainPrinciple[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const title = cleanShort(obj.title, 90);
    const rule = cleanShort(obj.rule, 240);
    const anti_pattern = cleanShort(obj.anti_pattern, 220);
    if (title && rule && anti_pattern) {
      out.push({ title, rule, anti_pattern });
    }
  }
  return out.length >= 2 ? out : fallback;
}

function parsePolicies(
  raw: unknown,
  domain: TasteDomainId,
  fallback: DomainPolicy[]
): DomainPolicy[] {
  if (!Array.isArray(raw)) return fallback;
  const out: DomainPolicy[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const rawPol = typeof obj.polarity === "string" ? obj.polarity.trim().toLowerCase() : "";
    const polarity: PolicyPolarity = rawPol === "never" ? "never" : "must";
    const policy = cleanShort(obj.policy, 240);
    const enforcement = cleanShort(obj.enforcement, 180);
    const rawId = typeof obj.id === "string" ? slugifyId(obj.id).slice(0, 48) : "";
    if (policy) {
      out.push({
        id: rawId || `${domain}-${polarity}-${slugifyId(policy).slice(0, 24) || i + 1}`,
        polarity,
        policy,
        enforcement: enforcement || "Verified in pre-ship review gate.",
      });
    }
  }
  return out.length >= 2 ? out : fallback;
}

function parseBestPractices(raw: unknown, fallback: DomainBestPractice[]): DomainBestPractice[] {
  if (!Array.isArray(raw)) return fallback;
  const out: DomainBestPractice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const practice = cleanShort(obj.practice, 220);
    const benchmark = cleanShort(obj.benchmark, 140);
    const rationale = cleanShort(obj.rationale, 220);
    if (practice && rationale) {
      out.push({
        practice,
        benchmark: benchmark || "Frontier commercial craft bar",
        rationale,
      });
    }
  }
  return out.length >= 2 ? out : fallback;
}

function parseReferenceCanons(raw: unknown, fallback: DomainReferenceCanon[]): DomainReferenceCanon[] {
  if (!Array.isArray(raw)) return fallback;
  const out: DomainReferenceCanon[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const obj = item as Record<string, unknown>;
    const name = cleanShort(obj.name, 100);
    const why = cleanShort(obj.why, 220);
    if (name && why) {
      out.push({ name, why });
    }
  }
  return out.length >= 2 ? out : fallback;
}

function countCultivationItems(c: DomainCultivation): number {
  return (
    c.mastery_path.length +
    c.frameworks.length +
    c.principles.length +
    c.policies.length +
    c.best_practices.length
  );
}

export function compileDomainDossierMarkdown(
  cultivation: DomainCultivation,
  gardener: GardenerRosterDef
): string {
  const lines: string[] = [
    "---",
    `title: "${cultivation.domain_label} - Taste Gardener Dossier"`,
    `domain: "${cultivation.domain}"`,
    `gardener_id: "${cultivation.gardener_id}"`,
    `gardener_name: "${gardener.name}"`,
    `depth_level: ${cultivation.depth_level}`,
    `engine: "${cultivation.engine}"`,
    `updated_at: "${cultivation.updated_at}"`,
    "tags:",
    "  - taste-gardener",
    `  - ${cultivation.domain}`,
    "---",
    "",
    `# ${cultivation.domain_label} (Depth L${cultivation.depth_level}/5)`,
    "",
    `> **Core Thesis:** ${cultivation.thesis}`,
    "",
    `- **Gardener**: ${gardener.name} (\`${gardener.id}\`)`,
    `- **Domain ID**: \`${cultivation.domain}\``,
    `- **Codex Scope**: ${gardener.codex_scope}`,
    `- **Last Cultivated**: ${cultivation.updated_at} via **${cultivation.engine}**`,
    `- **Cultivated Inventory**: ${cultivation.mastery_path.length} mastery stages, ${cultivation.frameworks.length} frameworks, ${cultivation.principles.length} principles, ${cultivation.policies.length} policies, ${cultivation.best_practices.length} best practices, ${cultivation.reference_canons.length} reference canons`,
    "",
    "## Mastery Path (L1 Foundation -> L4 Frontier Pioneer)",
    "",
  ];

  for (const stage of cultivation.mastery_path) {
    lines.push(`### ${stage.level}. ${stage.stage}`);
    lines.push(`- **Goal**: ${stage.goal}`);
    lines.push("- **Concrete Milestones**:");
    for (const m of stage.concrete_milestones) {
      lines.push(`  - ${m}`);
    }
    lines.push(`- **Diagnostic Test**: ${stage.diagnostic_test}`);
    lines.push("");
  }

  lines.push("## Operating Frameworks", "");
  for (const fw of cultivation.frameworks) {
    lines.push(`### ${fw.name}`);
    lines.push(`- **Purpose**: ${fw.purpose}`);
    lines.push(`- **When to Use**: ${fw.when_to_use}`);
    lines.push("- **Steps**:");
    fw.steps.forEach((step, idx) => {
      lines.push(`  ${idx + 1}. ${step}`);
    });
    lines.push("");
  }

  lines.push("## Core Principles", "");
  for (const p of cultivation.principles) {
    lines.push(`- **${p.title}**: ${p.rule}`);
    lines.push(`  - *Anti-Pattern*: ${p.anti_pattern}`);
  }
  lines.push("");

  lines.push("## Enforced Policies (Must / Never)", "");
  lines.push("| ID | Polarity | Policy | Enforcement |");
  lines.push("| :--- | :--- | :--- | :--- |");
  for (const pol of cultivation.policies) {
    const esc = (s: string) => s.replace(/\|/g, "/");
    lines.push(
      `| \`${esc(pol.id)}\` | **${pol.polarity.toUpperCase()}** | ${esc(pol.policy)} | ${esc(pol.enforcement)} |`
    );
  }
  lines.push("");

  lines.push("## Best Practices & Benchmarks", "");
  for (const bp of cultivation.best_practices) {
    lines.push(`- **${bp.practice}** *(Benchmark: ${bp.benchmark})*`);
    lines.push(`  - *Rationale*: ${bp.rationale}`);
  }
  lines.push("");

  lines.push("## Reference Canons", "");
  for (const rc of cultivation.reference_canons) {
    lines.push(`- **${rc.name}**: ${rc.why}`);
  }
  lines.push("");

  lines.push("## Linked Interests & Philosophies", "");
  lines.push(
    `- **Linked Interests**: ${cultivation.linked_interests.length > 0 ? cultivation.linked_interests.join(", ") : "None recorded"}`
  );
  lines.push(
    `- **Linked Philosophies**: ${cultivation.linked_philosophies.length > 0 ? cultivation.linked_philosophies.join(", ") : "None recorded"}`
  );
  lines.push("");

  return sanitizeMultilineMarkdown(lines.join("\n")) + "\n";
}

// ============================================================================
// Main API Class: KizukiTasteGardenerApi
// ============================================================================

export class KizukiTasteGardenerApi {
  readonly vaultPath: string;
  readonly lifeOsWikiPath: string | null;
  readonly gardenPath: string | null;
  readonly gardenersDir: string;
  readonly dossiersDir: string;
  readonly statePath: string;
  readonly systemdUserDir: string;
  private readonly defaultTasteApi: KizukiTasteApi | null;
  private readonly checkSchedulerFn?: () => { enabled: boolean; next_run_hint: string };
  private crosslinksSummaryProvider: ((domain: TasteDomainId) => string[]) | null = null;

  constructor(config: GardenerApiConfig = {}) {
    this.vaultPath = config.vaultPath || DEFAULT_TASTE_VAULT_PATH;
    this.lifeOsWikiPath =
      config.lifeOsWikiPath === undefined ? DEFAULT_TASTE_WIKI_PATH : config.lifeOsWikiPath;
    this.gardenPath =
      config.gardenPath === undefined ? DEFAULT_TASTE_GARDEN_PATH : config.gardenPath;
    this.gardenersDir = join(this.vaultPath, "world", "gardeners");
    this.dossiersDir = join(this.gardenersDir, "dossiers");
    this.statePath = join(this.gardenersDir, "state.json");
    this.systemdUserDir =
      config.systemdUserDir ||
      join(process.env.HOME || homedir(), ".config", "systemd", "user");
    this.defaultTasteApi = config.tasteApi === undefined ? null : config.tasteApi;
    this.checkSchedulerFn = config.checkSchedulerFn;
  }

  private createDefaultGardeners(): GardenerRuntimeState[] {
    return GARDENER_ROSTER.map((g) => ({
      id: g.id,
      name: g.name,
      domains: [...g.domains],
      codex_scope: g.codex_scope,
      focus: g.focus,
      status: "idle",
      current_task: null,
      last_run_at: null,
      runs_count: 0,
      items_cultivated: 0,
      last_engine: null,
      last_summary: null,
    }));
  }

  private normalizeStore(raw: Partial<GardenerStoreFile> | null | undefined): GardenerStoreFile {
    const existingById = new Map<string, Partial<GardenerRuntimeState>>();
    if (Array.isArray(raw?.gardeners)) {
      for (const g of raw.gardeners) {
        if (g && typeof g === "object" && typeof g.id === "string") {
          existingById.set(g.id, g);
        }
      }
    }

    const domains: Record<string, DomainCultivation> = {};
    if (raw?.domains && typeof raw.domains === "object" && !Array.isArray(raw.domains)) {
      for (const [k, v] of Object.entries(raw.domains)) {
        if (isValidTasteDomainId(k) && v && typeof v === "object") {
          domains[k] = v as DomainCultivation;
        }
      }
    }

    const gardeners: GardenerRuntimeState[] = GARDENER_ROSTER.map((def) => {
      const prev = existingById.get(def.id);
      const ownedCount = def.domains.reduce((acc, dom) => {
        const cult = domains[dom];
        return acc + (cult ? countCultivationItems(cult) : 0);
      }, 0);
      const validStatus: GardenerStatusKind =
        prev?.status === "running" || prev?.status === "error" ? prev.status : "idle";
      return {
        id: def.id,
        name: def.name,
        domains: [...def.domains],
        codex_scope: def.codex_scope,
        focus: def.focus,
        status: validStatus,
        current_task: typeof prev?.current_task === "string" ? prev.current_task : null,
        last_run_at: typeof prev?.last_run_at === "string" ? prev.last_run_at : null,
        runs_count: typeof prev?.runs_count === "number" && Number.isFinite(prev.runs_count) ? prev.runs_count : 0,
        items_cultivated: ownedCount || (typeof prev?.items_cultivated === "number" ? prev.items_cultivated : 0),
        last_engine: typeof prev?.last_engine === "string" ? prev.last_engine : null,
        last_summary: typeof prev?.last_summary === "string" ? prev.last_summary : null,
      };
    });

    const activity_log: GardenerActivityEntry[] = Array.isArray(raw?.activity_log)
      ? raw.activity_log.slice(0, MAX_ACTIVITY_LOG)
      : [];

    return {
      version: 1,
      updated_at: typeof raw?.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
      gardeners,
      domains,
      activity_log,
    };
  }

  private loadStore(): GardenerStoreFile {
    if (!existsSync(this.statePath)) {
      return this.normalizeStore(null);
    }
    try {
      const text = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(text) as Partial<GardenerStoreFile>;
      return this.normalizeStore(parsed);
    } catch {
      return this.normalizeStore(null);
    }
  }

  private saveStore(store: GardenerStoreFile): void {
    store.updated_at = new Date().toISOString();
    store.activity_log = store.activity_log.slice(0, MAX_ACTIVITY_LOG);
    ensurePrivateDir(this.gardenersDir);
    ensurePrivateDir(this.dossiersDir);
    const serialized = stripEmDashes(JSON.stringify(store, null, 2)) + "\n";
    writeAtomicPrivateFile(this.statePath, serialized);
  }

  private mutateStore(mutator: (store: GardenerStoreFile) => void): GardenerStoreFile {
    const store = this.loadStore();
    mutator(store);
    this.saveStore(store);
    return store;
  }

  private getSchedulerInfo(): GardenerSchedulerInfo {
    if (this.checkSchedulerFn) {
      const custom = this.checkSchedulerFn();
      return {
        timer_unit: TIMER_UNIT_NAME,
        interval: "Every 6h",
        enabled: Boolean(custom.enabled),
        next_run_hint: sanitizeGardenerText(custom.next_run_hint || computeNext6hHint()),
      };
    }

    const wantsLink = join(this.systemdUserDir, "timers.target.wants", TIMER_UNIT_NAME);
    const unitFile = join(this.systemdUserDir, TIMER_UNIT_NAME);
    const enabled = existsSync(wantsLink) && existsSync(unitFile);
    return {
      timer_unit: TIMER_UNIT_NAME,
      interval: "Every 6h",
      enabled,
      next_run_hint: enabled
        ? computeNext6hHint()
        : "Timer installed but not enabled (run systemctl --user enable --now kizuki-taste-gardener.timer)",
    };
  }

  private buildStateResponse(store: GardenerStoreFile): GardenerStateResponse {
    let totalFrameworks = 0;
    let totalPrinciples = 0;
    let totalPolicies = 0;
    let totalBestPractices = 0;
    let totalMasteryStages = 0;

    const domainValues = Object.values(store.domains);
    for (const d of domainValues) {
      totalFrameworks += d.frameworks.length;
      totalPrinciples += d.principles.length;
      totalPolicies += d.policies.length;
      totalBestPractices += d.best_practices.length;
      totalMasteryStages += d.mastery_path.length;
    }

    const runsTotal = store.gardeners.reduce((sum, g) => sum + g.runs_count, 0);
    const gardenersRunning = store.gardeners.filter((g) => g.status === "running").length;

    return {
      stats: {
        gardeners_total: store.gardeners.length,
        gardeners_running: gardenersRunning,
        domains_cultivated: domainValues.length,
        domains_total: TASTE_DOMAINS.length,
        total_frameworks: totalFrameworks,
        total_principles: totalPrinciples,
        total_policies: totalPolicies,
        total_best_practices: totalBestPractices,
        total_mastery_stages: totalMasteryStages,
        runs_total: runsTotal,
      },
      gardeners: store.gardeners,
      domains: store.domains,
      activity_log: store.activity_log,
      scheduler: this.getSchedulerInfo(),
      updated_at: store.updated_at,
    };
  }

  setCrosslinksSummaryProvider(provider: ((domain: TasteDomainId) => string[]) | null): void {
    this.crosslinksSummaryProvider = provider;
  }

  getCrosslinksContext(domain: TasteDomainId): string[] {
    if (!this.crosslinksSummaryProvider) return [];
    try {
      return this.crosslinksSummaryProvider(domain) || [];
    } catch {
      return [];
    }
  }

  listDomainPrinciples(domain?: TasteDomainId): Array<{ domain: TasteDomainId; principle: DomainPrinciple }> {
    const store = this.loadStore();
    const out: Array<{ domain: TasteDomainId; principle: DomainPrinciple }> = [];
    for (const [domKey, cult] of Object.entries(store.domains)) {
      if (domain && domKey !== domain) continue;
      if (!isValidTasteDomainId(domKey)) continue;
      for (const principle of cult.principles || []) {
        out.push({ domain: domKey, principle });
      }
    }
    return out;
  }

  getState(): GardenerStateResponse {
    const store = this.loadStore();
    return this.buildStateResponse(store);
  }

  getDomainDossier(domain: string): {
    domain: TasteDomainId;
    dossier_path: string;
    cultivation: DomainCultivation | null;
    markdown: string | null;
  } {
    const cleanDom = typeof domain === "string" ? domain.trim() : "";
    if (!isValidTasteDomainId(cleanDom)) {
      throw new BadRequestError(`Invalid taste domain: ${cleanDom}`);
    }
    const store = this.loadStore();
    const cultivation = store.domains[cleanDom] || null;
    const relPath = `world/gardeners/dossiers/${cleanDom}.md`;
    const absPath = join(this.vaultPath, relPath);
    const markdown = existsSync(absPath) ? readFileSync(absPath, "utf8") : null;
    return {
      domain: cleanDom,
      dossier_path: relPath,
      cultivation,
      markdown,
    };
  }

  private readGroundingContext(
    domain: TasteDomainId,
    gardener: GardenerRosterDef,
    existing: DomainCultivation | undefined,
    tasteApi?: KizukiTasteApi | null
  ): string {
    const lines: string[] = [];
    const domDef = DOMAIN_DEF_MAP.get(domain);
    if (domDef) {
      lines.push(`Domain: ${domDef.label} (${domDef.id}) - ${domDef.description}`);
    }
    lines.push(`Gardener: ${gardener.name} (${gardener.id})`);
    lines.push(`Codex Scope: ${gardener.codex_scope}`);
    lines.push(`Focus: ${gardener.focus}`);

    // Pull Taste API state if available
    const activeTaste =
      tasteApi ||
      this.defaultTasteApi ||
      new KizukiTasteApi({
        vaultPath: this.vaultPath,
        lifeOsWikiPath: this.lifeOsWikiPath,
        gardenPath: this.gardenPath,
      });

    try {
      const tState = activeTaste.getState();
      const dSummary = tState.domains.find((d) => d.id === domain);
      if (dSummary) {
        lines.push(
          `Calibration progress: ${dSummary.answered}/${dSummary.total} answered (${dSummary.pct}%). Signature traits: ${
            dSummary.signature_traits.join(", ") || "none yet"
          }.`
        );
        if (dSummary.recent_verdicts.length > 0) {
          lines.push(`Recent owner verdicts: ${dSummary.recent_verdicts.slice(0, 5).join(" | ")}`);
        }
      }
      const preferRules = tState.rules.prefer
        .filter((r) => r.domain === domain)
        .slice(0, 6)
        .map((r) => `- PREFER: ${r.rule}`);
      const avoidRules = tState.rules.avoid
        .filter((r) => r.domain === domain)
        .slice(0, 6)
        .map((r) => `- AVOID: ${r.rule}`);
      if (preferRules.length > 0 || avoidRules.length > 0) {
        lines.push("Locked Taste Rules:", ...preferRules, ...avoidRules);
      }

      const relevantDocs = tState.vault_docs
        .filter((doc) => doc.domain === domain)
        .slice(0, 6)
        .map((doc) => `- [${doc.category}/${doc.polarity}] ${doc.title}: ${doc.summary}`);
      if (relevantDocs.length > 0) {
        lines.push("Taste Vault Reference Anchors:", ...relevantDocs);
      }
    } catch {
      // ignore if taste store unavailable in minimal test workspace
    }

    const crosslinkLines = this.getCrosslinksContext(domain);
    if (crosslinkLines.length > 0) {
      lines.push("Cross-Pollinated Codex Links:", ...crosslinkLines.map((l) => `- ${l}`));
    }

    // Pull concise owner-profile.md ventures + taste slice
    const knowCandidates = [
      this.lifeOsWikiPath ? join(this.lifeOsWikiPath, "05-knowledge", "owner-profile.md") : null,
      join(this.vaultPath, "auto", "entities", "05-knowledge", "owner-profile.md"),
    ].filter((p): p is string => Boolean(p));

    for (const kp of knowCandidates) {
      if (existsSync(kp)) {
        try {
          const text = readFileSync(kp, "utf8");
          const snippet = stripEmDashes(text).slice(0, 1800);
          lines.push("Owner Profile Grounding Excerpt:", snippet);
          break;
        } catch {
          // ignore
        }
      }
    }

    if (existing) {
      lines.push(
        `Existing Cultivation (Depth L${existing.depth_level}/5): Thesis="${existing.thesis}". Existing frameworks: ${existing.frameworks
          .map((f) => f.name)
          .join(", ")}. Deepen to Level ${Math.min(5, existing.depth_level + 1)} with sharper concrete milestones, frameworks, and non-redundant policies.`
      );
    }

    return stripEmDashes(lines.join("\n"));
  }

  buildCultivationPrompt(
    domain: TasteDomainId,
    gardener: GardenerRosterDef,
    existing: DomainCultivation | undefined,
    tasteApi?: KizukiTasteApi | null
  ): { system: string; user: string; promptForCoherence: string } {
    const domDef = DOMAIN_DEF_MAP.get(domain)!;
    const context = this.readGroundingContext(domain, gardener, existing, tasteApi);
    const targetDepth = Math.min(5, (existing?.depth_level || 0) + 1);

    const system = stripEmDashes(
      [
        `You are ${gardener.name} (${gardener.id}), an autonomous Taste Gardener cultivating the owner's personal domain mastery canon in Kizuki.`,
        "Return ONLY a single valid JSON object (no markdown outside JSON, no commentary).",
        "STRICT RULES: ZERO em-dashes (never use U+2014). Use plain hyphens, colons, or periods. Never use banned corporate corpse words (unlock, empower, seamless, robust, next-generation, cutting-edge, revolutionary, innovative).",
        "Ground every framework, principle, policy, best practice, reference canon, and MCQ in concrete craft bars (Linear, Vercel Geist, Bureau Borsche, A24, satsuei anime, step-free travel logistics, and disciplined agent engineering).",
      ].join(" ")
    );

    const user = stripEmDashes(
      [
        `Cultivate domain "${domain}" (${domDef.label}) to Depth Level ${targetDepth}/5.`,
        "",
        "GROUNDING CONTEXT:",
        context,
        "",
        "Return ONE valid JSON object with EXACTLY these keys:",
        "{",
        '  "thesis": "Crisp 1-2 sentence core taste thesis for this domain",',
        '  "summary": "1-sentence summary of what this cultivation pass deepened",',
        '  "mastery_path": [',
        '    { "level": 1, "stage": "Foundation", "goal": "...", "concrete_milestones": ["...", "...", "..."], "diagnostic_test": "..." },',
        '    { "level": 2, "stage": "Practitioner", "goal": "...", "concrete_milestones": ["...", "...", "..."], "diagnostic_test": "..." },',
        '    { "level": 3, "stage": "Taste Authority", "goal": "...", "concrete_milestones": ["...", "...", "..."], "diagnostic_test": "..." },',
        '    { "level": 4, "stage": "Frontier Pioneer", "goal": "...", "concrete_milestones": ["...", "...", "..."], "diagnostic_test": "..." }',
        "  ],",
        '  "frameworks": [',
        '    { "name": "Distinct Framework Name", "purpose": "...", "steps": ["Step 1", "Step 2", "Step 3"], "when_to_use": "..." }',
        "  ], // 3 to 4 frameworks",
        '  "principles": [',
        '    { "title": "Sharp Principle", "rule": "...", "anti_pattern": "..." }',
        "  ], // 4 to 5 principles",
        '  "policies": [',
        `    { "id": "${domain}-must-slug", "polarity": "must", "policy": "...", "enforcement": "..." },`,
        `    { "id": "${domain}-never-slug", "polarity": "never", "policy": "...", "enforcement": "..." }`,
        "  ], // 4 to 6 concrete must/never policies",
        '  "best_practices": [',
        '    { "practice": "...", "benchmark": "Named real-world benchmark", "rationale": "..." }',
        "  ], // 4 to 5 best practices",
        '  "reference_canons": [',
        '    { "name": "Named real work, studio, or system", "why": "..." }',
        "  ], // 4 to 5 reference canons",
        '  "linked_interests": ["Interest 1", "Interest 2", "Interest 3"],',
        '  "linked_philosophies": ["Philosophy 1", "Philosophy 2", "Philosophy 3"],',
        '  "adaptive_questions": [',
        "    {",
        `      "domain": "${domain}",`,
        '      "title": "Crisp 7-13 word multiple-choice calibration fork?",',
        '      "context": "Concrete real scenario from the owner\'s work or life",',
        '      "axis": "Distinct 2-4 word axis",',
        '      "priority": 94,',
        '      "options": [',
        '        { "key": "A", "label": "2-5 word label", "rationale": "1 sharp sentence", "trait_tag": "kebab-tag", "signal_value": 2, "preview": { "kind": "swatch|type|copy|layout|motion", "tokens": ["tok1", "tok2"], "sample_head": "Short Head", "sample_body": "Short Body", "badge": "Tag" } },',
        '        { "key": "B", "label": "...", "rationale": "...", "trait_tag": "...", "signal_value": 1, "preview": { "kind": "copy", "tokens": ["..."], "sample_head": "...", "sample_body": "...", "badge": "..." } },',
        '        { "key": "C", "label": "...", "rationale": "...", "trait_tag": "...", "signal_value": -1, "preview": { "kind": "copy", "tokens": ["..."], "sample_head": "...", "sample_body": "...", "badge": "..." } },',
        '        { "key": "D", "label": "...", "rationale": "...", "trait_tag": "...", "signal_value": -2, "preview": { "kind": "copy", "tokens": ["..."], "sample_head": "...", "sample_body": "...", "badge": "..." } }',
        "      ]",
        "    }",
        "  ] // exactly 1 sharp adaptive calibration MCQ (keep every field concise)",
        "}",
        "",
        "Keep every string crisp, dense, and 1 sentence max so the full JSON fits comfortably. Output ONLY the raw JSON object now. Zero em-dashes.",
      ].join("\n")
    );

    return {
      system,
      user,
      promptForCoherence: stripEmDashes(
        `Cultivate ${domDef.label} (${domain}) mastery path, frameworks, principles, policies, best practices`
      ),
    };
  }

  private resolveTargets(gardenerId?: string, domain?: string): Array<{
    gardener: GardenerRosterDef;
    domain: TasteDomainId;
  }> {
    const cleanGardener = typeof gardenerId === "string" ? gardenerId.trim() : "";
    const cleanDomain = typeof domain === "string" ? domain.trim() : "";

    if (cleanDomain) {
      if (!isValidTasteDomainId(cleanDomain)) {
        throw new BadRequestError(
          `Invalid domain "${cleanDomain}". Valid domains: ${TASTE_DOMAINS.map((d) => d.id).join(", ")}`
        );
      }
      const owner = getGardenerForDomain(cleanDomain);
      if (cleanGardener && cleanGardener !== owner.id) {
        throw new BadRequestError(
          `Domain "${cleanDomain}" is owned by "${owner.id}", not "${cleanGardener}"`
        );
      }
      return [{ gardener: owner, domain: cleanDomain }];
    }

    if (cleanGardener) {
      if (!isGardenerId(cleanGardener)) {
        throw new NotFoundError(
          `Unknown gardener "${cleanGardener}". Valid gardeners: ${GARDENER_ROSTER.map((g) => g.id).join(", ")}`
        );
      }
      const g = ROSTER_MAP.get(cleanGardener)!;
      return g.domains.map((dom) => ({ gardener: g, domain: dom }));
    }

    // Default when neither specified: pick the thinnest / least-recently-cultivated domain
    const store = this.loadStore();
    const sorted = [...TASTE_DOMAINS].sort((a, b) => {
      const ca = store.domains[a.id];
      const cb = store.domains[b.id];
      const depthDiff = (ca?.depth_level || 0) - (cb?.depth_level || 0);
      if (depthDiff !== 0) return depthDiff;
      const ta = ca?.updated_at || "";
      const tb = cb?.updated_at || "";
      return ta.localeCompare(tb);
    });
    const pick = sorted[0].id;
    return [{ gardener: getGardenerForDomain(pick), domain: pick }];
  }

  private async cultivateSingleDomain(
    gardener: GardenerRosterDef,
    domain: TasteDomainId,
    synthesizeFn: GardenerSynthesizeFn,
    tasteApi: KizukiTasteApi | null,
    dryRun: boolean
  ): Promise<DomainRunReceipt> {
    const domDef = DOMAIN_DEF_MAP.get(domain)!;
    const dossierRelPath = `world/gardeners/dossiers/${domain}.md`;
    const t0 = performance.now();

    if (dryRun) {
      const existing = this.loadStore().domains[domain];
      const nextDepth = Math.min(5, (existing?.depth_level || 0) + 1);
      return {
        gardener_id: gardener.id,
        gardener_name: gardener.name,
        domain,
        domain_label: domDef.label,
        depth_level: nextDepth,
        engine: "Dry Run",
        used_fallback: false,
        duration_ms: Math.max(1, Math.round(performance.now() - t0)),
        dossier_path: dossierRelPath,
        summary: `[dry-run] Would cultivate ${domDef.label} (${domain}) via ${gardener.id} to Depth L${nextDepth}/5.`,
        metrics: {
          mastery_stages: 4,
          frameworks: existing?.frameworks.length || 3,
          principles: existing?.principles.length || 4,
          policies: existing?.policies.length || 4,
          best_practices: existing?.best_practices.length || 4,
          mcqs_added: 0,
        },
      };
    }

    // Step 1: Mark gardener running immediately so UI sees live progress
    this.mutateStore((store) => {
      const rt = store.gardeners.find((g) => g.id === gardener.id);
      if (rt) {
        rt.status = "running";
        rt.current_task = `Cultivating ${domDef.label} (${domain})`;
      }
    });

    try {
      const existing = this.loadStore().domains[domain];
      const prompt = this.buildCultivationPrompt(domain, gardener, existing, tasteApi);

      const synthRes = await synthesizeFn({
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        promptForCoherence: prompt.promptForCoherence,
        primaryMaxTokens: 6500,
        fallbackMaxTokens: 6500,
      });

      const seed = DOMAIN_FALLBACK_SEEDS[domain];
      let parsedObj: Record<string, unknown> | null = null;
      let engineLabel = "Deterministic Canon Fallback";
      let usedFallback = true;

      if (synthRes.ok && synthRes.content) {
        parsedObj = extractJsonObjectFromLlm(synthRes.content);
        if (parsedObj) {
          engineLabel = sanitizeGardenerText(synthRes.engine || "Local LLM");
          usedFallback = false;
        }
      }

      const incomingThesis = parsedObj ? cleanShort(parsedObj.thesis, 320) : "";
      const incomingMastery = parsedObj ? parseMasteryPath(parsedObj.mastery_path, seed.mastery_path) : seed.mastery_path;
      const incomingFrameworks = parsedObj ? parseFrameworks(parsedObj.frameworks, seed.frameworks) : seed.frameworks;
      const incomingPrinciples = parsedObj ? parsePrinciples(parsedObj.principles, seed.principles) : seed.principles;
      const incomingPolicies = parsedObj ? parsePolicies(parsedObj.policies, domain, seed.policies) : seed.policies;
      const incomingBestPractices = parsedObj
        ? parseBestPractices(parsedObj.best_practices, seed.best_practices)
        : seed.best_practices;
      const incomingCanons = parsedObj
        ? parseReferenceCanons(parsedObj.reference_canons, seed.reference_canons)
        : seed.reference_canons;
      const incomingInterests =
        parsedObj && Array.isArray(parsedObj.linked_interests) && parsedObj.linked_interests.length > 0
          ? parsedObj.linked_interests.map((s) => cleanShort(s, 100)).filter(Boolean)
          : seed.linked_interests;
      const incomingPhilosophies =
        parsedObj && Array.isArray(parsedObj.linked_philosophies) && parsedObj.linked_philosophies.length > 0
          ? parsedObj.linked_philosophies.map((s) => cleanShort(s, 100)).filter(Boolean)
          : seed.linked_philosophies;

      const nowIso = new Date().toISOString();
      const nextDepth = Math.min(5, (existing?.depth_level || 0) + 1);

      // Merge incoming cultivated items with existing domain canon (deduped, deepening)
      const mergedFrameworks = mergeUniqueByKey(
        existing?.frameworks || [],
        incomingFrameworks,
        (f) => f.name,
        8
      );
      const mergedPrinciples = mergeUniqueByKey(
        existing?.principles || [],
        incomingPrinciples,
        (p) => p.title,
        10
      );
      const mergedPolicies = mergeUniqueByKey(
        existing?.policies || [],
        incomingPolicies,
        (p) => `${p.polarity}:${p.policy.slice(0, 48)}`,
        12
      );
      const mergedBestPractices = mergeUniqueByKey(
        existing?.best_practices || [],
        incomingBestPractices,
        (b) => b.practice.slice(0, 60),
        10
      );
      const mergedCanons = mergeUniqueByKey(
        existing?.reference_canons || [],
        incomingCanons,
        (c) => c.name,
        10
      );
      const mergedInterests = mergeUniqueStrings(existing?.linked_interests || [], incomingInterests, 10);
      const mergedPhilosophies = mergeUniqueStrings(existing?.linked_philosophies || [], incomingPhilosophies, 8);

      const cultivation: DomainCultivation = {
        domain,
        domain_label: domDef.label,
        gardener_id: gardener.id,
        depth_level: nextDepth,
        updated_at: nowIso,
        engine: engineLabel,
        dossier_path: dossierRelPath,
        thesis: incomingThesis || existing?.thesis || seed.thesis,
        mastery_path: incomingMastery,
        frameworks: mergedFrameworks,
        principles: mergedPrinciples,
        policies: mergedPolicies,
        best_practices: mergedBestPractices,
        reference_canons: mergedCanons,
        linked_interests: mergedInterests,
        linked_philosophies: mergedPhilosophies,
      };

      // Step 2: Compile full-length GFM dossier to world/gardeners/dossiers/<domain>.md (0600)
      const dossierAbsPath = join(this.vaultPath, dossierRelPath);
      const dossierMd = compileDomainDossierMarkdown(cultivation, gardener);
      writeAtomicPrivateFile(dossierAbsPath, dossierMd);

      // Step 3: Optionally ingest 1-2 fresh adaptive calibration MCQs into Taste Studio
      let mcqsAdded = 0;
      const targetTasteApi = tasteApi || this.defaultTasteApi;
      if (targetTasteApi) {
        const rawQuestions =
          parsedObj && Array.isArray(parsedObj.adaptive_questions) && parsedObj.adaptive_questions.length > 0
            ? parsedObj.adaptive_questions.slice(0, 2)
            : seed.adaptive_questions.slice(0, 2);
        try {
          const ingestRes = targetTasteApi.ingestGeneratedQuestions(
            stripEmDashes(JSON.stringify(rawQuestions)),
            domain
          );
          mcqsAdded = ingestRes.count;
        } catch {
          // Do not fail gardener cultivation if MCQ ingest encounters duplicates or lock
          mcqsAdded = 0;
        }
      }

      const durationMs = Math.max(1, Math.round(performance.now() - t0));
      const metrics: GardenerActivityMetrics = {
        mastery_stages: cultivation.mastery_path.length,
        frameworks: cultivation.frameworks.length,
        principles: cultivation.principles.length,
        policies: cultivation.policies.length,
        best_practices: cultivation.best_practices.length,
        mcqs_added: mcqsAdded,
      };

      const rawSummary = parsedObj ? cleanShort(parsedObj.summary, 220) : "";
      const summary =
        rawSummary ||
        `Cultivated ${domDef.label} to Depth L${nextDepth}/5 (${metrics.frameworks} frameworks, ${metrics.principles} principles, ${metrics.policies} policies, ${metrics.best_practices} best practices${mcqsAdded > 0 ? `, +${mcqsAdded} MCQs` : ""}).`;

      const activityEntry: GardenerActivityEntry = {
        id: `gact_${domain}_${randomUUID().slice(0, 8)}`,
        ts: nowIso,
        gardener_id: gardener.id,
        gardener_name: gardener.name,
        domain,
        action: existing ? `deepen_L${nextDepth}` : "cultivate_L1",
        engine: engineLabel,
        duration_ms: durationMs,
        summary,
        metrics,
        dossier_path: dossierRelPath,
      };

      // Step 4: Persist state atomically and mark gardener idle
      this.mutateStore((store) => {
        store.domains[domain] = cultivation;
        store.activity_log.unshift(activityEntry);
        if (store.activity_log.length > MAX_ACTIVITY_LOG) {
          store.activity_log = store.activity_log.slice(0, MAX_ACTIVITY_LOG);
        }
        const rt = store.gardeners.find((g) => g.id === gardener.id);
        if (rt) {
          rt.status = "idle";
          rt.current_task = null;
          rt.last_run_at = nowIso;
          rt.runs_count += 1;
          rt.last_engine = engineLabel;
          rt.last_summary = summary;
          rt.items_cultivated = gardener.domains.reduce((sum, dom) => {
            const c = store.domains[dom];
            return sum + (c ? countCultivationItems(c) : 0);
          }, 0);
        }
      });

      return {
        gardener_id: gardener.id,
        gardener_name: gardener.name,
        domain,
        domain_label: domDef.label,
        depth_level: nextDepth,
        engine: engineLabel,
        used_fallback: usedFallback,
        duration_ms: durationMs,
        dossier_path: dossierRelPath,
        summary,
        metrics,
      };
    } catch (err) {
      const errMsg = sanitizeGardenerText(err instanceof Error ? err.message : String(err)).slice(0, 220);
      this.mutateStore((store) => {
        const rt = store.gardeners.find((g) => g.id === gardener.id);
        if (rt) {
          rt.status = "error";
          rt.current_task = null;
          rt.last_summary = `Error on ${domain}: ${errMsg}`;
        }
      });
      throw err;
    }
  }

  async runGardener(opts: RunGardenerOptions = {}): Promise<RunGardenerResponse> {
    const targets = this.resolveTargets(opts.gardenerId, opts.domain);
    const synthesizeFn = opts.synthesizeFn || createDualEngineSynthesizer();
    const tasteApi = opts.tasteApi === undefined ? this.defaultTasteApi : opts.tasteApi;
    const dryRun = Boolean(opts.dryRun);

    const results: DomainRunReceipt[] = [];
    for (const target of targets) {
      const receipt = await this.cultivateSingleDomain(
        target.gardener,
        target.domain,
        synthesizeFn,
        tasteApi,
        dryRun
      );
      results.push(receipt);
    }

    return {
      ok: true,
      dry_run: dryRun,
      results,
      state: this.getState(),
    };
  }

  async runAll(opts: {
    concurrency?: number;
    synthesizeFn?: GardenerSynthesizeFn;
    tasteApi?: KizukiTasteApi | null;
    dryRun?: boolean;
    onDomainComplete?: (receipt: DomainRunReceipt) => void;
  } = {}): Promise<RunGardenerResponse> {
    const concurrency = Math.max(1, Math.min(5, Math.floor(opts.concurrency ?? 2)));
    const synthesizeFn = opts.synthesizeFn || createDualEngineSynthesizer();
    const tasteApi = opts.tasteApi === undefined ? this.defaultTasteApi : opts.tasteApi;
    const dryRun = Boolean(opts.dryRun);

    // Group by gardener so one gardener never flips its own status concurrently while different gardeners run in parallel
    const gardenerQueues = GARDENER_ROSTER.map((g) => ({
      gardener: g,
      domains: [...g.domains],
    }));

    const results: DomainRunReceipt[] = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < gardenerQueues.length) {
        const idx = cursor++;
        const lane = gardenerQueues[idx];
        for (const dom of lane.domains) {
          const receipt = await this.cultivateSingleDomain(
            lane.gardener,
            dom,
            synthesizeFn,
            tasteApi,
            dryRun
          );
          results.push(receipt);
          if (opts.onDomainComplete) {
            opts.onDomainComplete(receipt);
          }
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, gardenerQueues.length) }, () => worker());
    await Promise.all(workers);

    // Sort results in canonical TASTE_DOMAINS order
    const orderIdx = new Map<TasteDomainId, number>(TASTE_DOMAINS.map((d, i) => [d.id, i]));
    results.sort((a, b) => (orderIdx.get(a.domain) ?? 99) - (orderIdx.get(b.domain) ?? 99));

    return {
      ok: true,
      dry_run: dryRun,
      results,
      state: this.getState(),
    };
  }
}

export function getGardenerFileModeOctal(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const st = statSync(filePath);
  return (st.mode & 0o777).toString(8).padStart(4, "0");
}
