import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DecisionVerdict, OmniIndexSearch } from "./contracts.ts";
import type { KizukiVaultApi, OmniSearchResponse } from "./vault-api.ts";
import type { CodexSection, KizukiCodexApi } from "./codex-api.ts";
import { isTasteDomainId, type KizukiTasteApi, type TasteDomainId } from "./taste-api.ts";
import type { KizukiTasteGardenerApi } from "./gardener-api.ts";
import type { KizukiAgentBoardApi } from "./agent-board-api.ts";
import type { KizukiBoardMindBridge } from "./board-mind-bridge.ts";
import {
  LocalEmbedder,
  cosineSimilarity,
  normalizeTextKey,
  stripEmDashesSafe,
  tokenizeForSearch,
  type FetchLike,
} from "./cross-pollinate.ts";

export type ActionableVerb =
  | "open"
  | "approve"
  | "revise"
  | "defer"
  | "draft"
  | "prep"
  | "task"
  | "note"
  | "capture"
  | "rule"
  | "snooze"
  | "ask";

export type CommandVerb = ActionableVerb | "search";

export type CommandTargetKind =
  | "view"
  | "entity"
  | "thread"
  | "person"
  | "meeting"
  | "board"
  | "codex"
  | "taste"
  | "item"
  | "question"
  | "query";

export interface CommandVerbSpec {
  verb: ActionableVerb;
  syntax: string;
  summary: string;
  isWrite: boolean;
  localOnly?: boolean;
  endpoint: string;
  method: "GET" | "POST" | "NAVIGATE";
  examples: string[];
}

export const COMMAND_VERB_REGISTRY: readonly CommandVerbSpec[] = [
  {
    verb: "open",
    syntax: "open <view|entity>",
    summary: "Jump to a workspace view or open a resolved person, doc, codex item, or thread.",
    isWrite: false,
    endpoint: "/#navigate",
    method: "NAVIGATE",
    examples: ["open today", "open board", "open atlas"],
  },
  {
    verb: "approve",
    syntax: "approve #thread [note]",
    summary: "Stamp a durable APPROVE decision gate via C1 decision ledger.",
    isWrite: true,
    endpoint: "/api/decisions/stamp",
    method: "POST",
    examples: ["approve #2494", "approve 2494 ship tonight"],
  },
  {
    verb: "revise",
    syntax: "revise #thread [note]",
    summary: "Stamp a durable REVISE decision gate via C1 decision ledger.",
    isWrite: true,
    endpoint: "/api/decisions/stamp",
    method: "POST",
    examples: ["revise #2494 tighten hero copy"],
  },
  {
    verb: "defer",
    syntax: "defer #thread [note]",
    summary: "Stamp a durable DEFER decision gate via C1 decision ledger.",
    isWrite: true,
    endpoint: "/api/decisions/stamp",
    method: "POST",
    examples: ["defer #2494 revisit Friday"],
  },
  {
    verb: "draft",
    syntax: "draft <person> [topic]",
    summary: "Generate a local-only reply draft for a person (never sends outbound).",
    isWrite: false,
    localOnly: true,
    endpoint: "/api/draft",
    method: "POST",
    examples: ["draft sam dinner friday", "draft alex roadmap deck"],
  },
  {
    verb: "prep",
    syntax: "prep <person|meeting>",
    summary: "Assemble a local-only relationship and meeting prep pack via C3.",
    isWrite: false,
    localOnly: true,
    endpoint: "/api/people/prep",
    method: "GET",
    examples: ["prep alex", "prep design sync"],
  },
  {
    verb: "task",
    syntax: "task <text> [@agent] [#room]",
    summary: "Dispatch an actionable task to Agent Board via boardBridge.",
    isWrite: true,
    endpoint: "/api/agent-board/dispatch",
    method: "POST",
    examples: ["task audit queue latency @codex #agent-work", "task refresh replay map #box"],
  },
  {
    verb: "note",
    syntax: "note <text>",
    summary: "Capture a quick note entry directly into Mind Codex.",
    isWrite: true,
    endpoint: "/api/codex/item",
    method: "POST",
    examples: ["note Launch page needs one sharp headline"],
  },
  {
    verb: "capture",
    syntax: "capture <title> :: <summary>",
    summary: "Add a structured Codex entry with title and summary.",
    isWrite: true,
    endpoint: "/api/codex/item",
    method: "POST",
    examples: ["capture Density Over Bento :: Pack high-signal facts behind 1px hairlines #philosophy"],
  },
  {
    verb: "rule",
    syntax: "rule prefer|avoid <text>",
    summary: "Lock a custom prefer or avoid Taste rule into Taste Studio.",
    isWrite: true,
    endpoint: "/api/taste/rule",
    method: "POST",
    examples: ["rule avoid pastel SaaS gradients", "rule prefer tabular numerals in all tables #ui_product"],
  },
  {
    verb: "snooze",
    syntax: "snooze <id> [hours]",
    summary: "Snooze a Today triage item or thread for N hours (default 4h).",
    isWrite: true,
    endpoint: "/api/today/triage",
    method: "POST",
    examples: ["snooze 2494 6h", "snooze inbox:msg-42 24h"],
  },
  {
    verb: "ask",
    syntax: "ask <question>",
    summary: "Run hybrid lexical + semantic recall and hand context to Ask Mind.",
    isWrite: false,
    endpoint: "/api/ask",
    method: "POST",
    examples: ["ask what did David say about Solana?", "ask people I should reconnect with"],
  },
] as const;

const VERB_SPEC_MAP = new Map<ActionableVerb, CommandVerbSpec>(
  COMMAND_VERB_REGISTRY.map((spec) => [spec.verb, spec])
);

const VIEW_ALIASES: Record<string, { view: string; label: string; sub: string }> = {
  today: { view: "today", label: "Today Workbench", sub: "Morning brief, schedule, next moves, and inbox" },
  home: { view: "today", label: "Today Workbench", sub: "Morning brief, schedule, next moves, and inbox" },
  brief: { view: "today", label: "Today Workbench", sub: "Morning brief, schedule, next moves, and inbox" },
  morning: { view: "today", label: "Today Workbench", sub: "Morning brief, schedule, next moves, and inbox" },
  people: { view: "people", label: "People Dossiers", sub: "Cross-channel timelines, ledger, and drift radar" },
  contacts: { view: "people", label: "People Dossiers", sub: "Cross-channel timelines, ledger, and drift radar" },
  dossiers: { view: "people", label: "People Dossiers", sub: "Cross-channel timelines, ledger, and drift radar" },
  replay: { view: "replay", label: "Life Replay", sub: "Offline life map, trips, calendar, and day stories" },
  timeline: { view: "replay", label: "Life Replay", sub: "Offline life map, trips, calendar, and day stories" },
  codex: { view: "codex", label: "Mind Codex", sub: "Philosophies, interests, hobbies, ideas, and actions" },
  principles: { view: "codex", label: "Mind Codex", sub: "Philosophies, interests, hobbies, ideas, and actions" },
  ideas: { view: "codex", label: "Mind Codex", sub: "Philosophies, interests, hobbies, ideas, and actions" },
  taste: { view: "taste", label: "Taste Studio", sub: "Calibration deck, rules ledger, and taste vault" },
  studio: { view: "taste", label: "Taste Studio", sub: "Calibration deck, rules ledger, and taste vault" },
  board: { view: "board", label: "Agent Board", sub: "Live rooms, decision gates, blockers, and mesh" },
  agents: { view: "board", label: "Agent Board", sub: "Live rooms, decision gates, blockers, and mesh" },
  blockers: { view: "board", label: "Agent Board (Blockers)", sub: "Escalated blockers and owner decisions" },
  vault: { view: "vault", label: "Vault Explorer", sub: "Kizuki, Obsidian, Apple Notes, and Wispr docs" },
  docs: { view: "vault", label: "Vault Explorer", sub: "Kizuki, Obsidian, Apple Notes, and Wispr docs" },
  notes: { view: "vault", label: "Vault Explorer", sub: "Kizuki, Obsidian, Apple Notes, and Wispr docs" },
  graph: { view: "graph", label: "Mind Graph", sub: "Interactive world graph topology and inspector" },
  stream: { view: "stream", label: "Live Event Stream", sub: "Chronological events across pipelines" },
  events: { view: "stream", label: "Live Event Stream", sub: "Chronological events across pipelines" },
  atlas: { view: "atlas", label: "World Atlas", sub: "Resume, changed, stale, commitments, and questions" },
  memt: { view: "memt", label: "MemT Library", sub: "Verified operating rules and repeatable recipes" },
  recipes: { view: "memt", label: "MemT Library", sub: "Verified operating rules and repeatable recipes" },
};

export interface ParsedCommandTarget {
  kind: CommandTargetKind;
  id: string;
  label: string;
}

export interface ParsedCommand {
  raw: string;
  verb: CommandVerb;
  isWrite: boolean;
  executable: boolean;
  valid: boolean;
  hint?: string;
  target: ParsedCommandTarget;
  args: Record<string, unknown>;
}

export interface CommandPreview {
  method: "GET" | "POST" | "NAVIGATE";
  endpoint: string;
  targetLabel: string;
  summary: string;
  requiresConfirm: boolean;
  localOnly?: boolean;
  payload?: Record<string, unknown>;
}

export interface CommandHit {
  id: string;
  kind: "view" | "person" | "board" | "codex" | "taste" | "doc" | "calendar" | "inbox" | "memt" | "node";
  title: string;
  subtitle: string;
  snippet: string;
  badge: string;
  target: Record<string, unknown>;
  lexicalRank?: number;
  semanticScore?: number;
  rrfScore: number;
  verbs: ActionableVerb[];
}

export interface SemanticDocInput {
  id: string;
  kind: CommandHit["kind"];
  title: string;
  subtitle?: string;
  text: string;
  badge?: string;
  target?: Record<string, unknown>;
  verbs?: ActionableVerb[];
}

export interface ResolveCommandRequest {
  q: string;
  includeSemantic?: boolean;
  limit?: number;
}

export interface ResolveCommandResponse {
  ok: true;
  q: string;
  verb: CommandVerb;
  isWrite: boolean;
  executable: boolean;
  valid: boolean;
  hint?: string;
  target: ParsedCommandTarget;
  args: Record<string, unknown>;
  preview: CommandPreview | null;
  hits: CommandHit[];
  total: number;
  semanticUsed: boolean;
  lexicalMs: number;
  semanticMs: number;
  ms: number;
}

export interface ExecuteCommandRequest {
  q: string;
  confirm?: boolean;
  localOrigin?: string;
}

export interface ExecuteCommandOutcome {
  status: number;
  body: Record<string, unknown>;
}

export interface CommandPlaneConfig {
  api: KizukiVaultApi;
  codexApi: KizukiCodexApi;
  tasteApi: KizukiTasteApi;
  gardenerApi?: KizukiTasteGardenerApi | null;
  agentBoardApi: KizukiAgentBoardApi;
  boardBridge: KizukiBoardMindBridge;
  embedder?: LocalEmbedder;
  fetchImpl?: FetchLike;
  omniIndex?: OmniIndexSearch | null;
  stampDecision?: (req: {
    threadId: string;
    verdict: DecisionVerdict;
    note?: string;
    idempotencyKey: string;
  }) => Promise<Record<string, unknown>>;
  prepPerson?: (key: string) => Promise<Record<string, unknown> | null>;
  snoozeItem?: (req: { id: string; hours: number; until: string }) => Promise<Record<string, unknown>>;
}

function inferTasteDomainFromRuleText(text: string): TasteDomainId {
  const s = text.toLowerCase();
  if (/\b(em-?dash(?:es)?|corpse|copy|headlines?|fonts?|typefaces?|typography|serifs?|grotesk|words?|prose|tweets?|posts?|tracking|leading|buzzwords?)\b/.test(s)) {
    return "typography_copy";
  }
  if (/\b(motion|springs?|easing|fps|animations?|pulses?|idle|scroll|choreograph\w*|transitions?|hover|tactile)\b/.test(s)) {
    return "motion_feel";
  }
  if (/\b(anime|videos?|films?|satsuei|cels?|vrm|live2d|cameras?|grading|luts?|cinema|seedance|sound|lufs)\b/.test(s)) {
    return "video_anime";
  }
  if (/\b(brand|logos?|palettes?|gradients?|lava-?lamp|swiss|editorial|posters?|colors?|colours?|aesthetics?|luxury|pastel|blobs?)\b/.test(s)) {
    return "visual_brand";
  }
  if (/\b(merch|hoodies?|tees?|shirts?|jackets?|packaging|desk|hardware|objects?|gifts?|bottles?|hats?)\b/.test(s)) {
    return "merch_objects";
  }
  if (/\b(accessible|hotels?|trips?|travel|flights?|london|theatre|dinners?|restaurants?|family)\b/.test(s)) {
    return "spaces_life";
  }
  if (/\b(agents?|autonomy|confirm|gates?|prompts?|diffs?|tests?|proof|verify|commits?|harness|cli|brevity)\b/.test(s)) {
    return "agent_ops";
  }
  return "ui_product";
}

function parseSnoozeHours(raw: string | undefined): number {
  if (!raw) return 4;
  const trimmed = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours|d|day|days)?$/.exec(trimmed);
  if (!match) return 4;
  const val = Number(match[1]);
  if (!Number.isFinite(val) || val <= 0) return 4;
  const unit = match[2] || "h";
  if (unit.startsWith("m")) return Math.max(0.25, Math.min(24 * 14, val / 60));
  if (unit.startsWith("d")) return Math.max(1, Math.min(24 * 14, val * 24));
  return Math.max(0.5, Math.min(24 * 14, val));
}

function extractCodexSectionTag(text: string): { section: CodexSection; cleanText: string } {
  const m = /(?:^|\s)#(philosoph(?:y|ies)|principle|ideas?|interests?|hobbies?|hobby|actions?)\b/i.exec(text);
  if (!m) return { section: "ideas", cleanText: text.trim() };
  const raw = m[1].toLowerCase();
  let section: CodexSection = "ideas";
  if (raw.startsWith("philosoph") || raw === "principle") section = "philosophies";
  else if (raw.startsWith("interest")) section = "interests";
  else if (raw.startsWith("hobb")) section = "hobbies";
  else if (raw.startsWith("action")) section = "actions";
  const cleanText = text.replace(m[0], " ").replace(/\s+/g, " ").trim();
  return { section, cleanText };
}

function cleanThreadIdToken(raw: string): string {
  const t = raw.trim().replace(/^#/, "").replace(/^thread:/i, "");
  return t;
}

// ============================================================================
// Deterministic Command Grammar Parser: verb [object] [args]
// ============================================================================

export function parseCommand(rawInput: string): ParsedCommand {
  const raw = stripEmDashesSafe(String(rawInput || "")).trim();
  if (!raw || raw === "?") {
    return {
      raw,
      verb: "search",
      isWrite: false,
      executable: false,
      valid: false,
      hint: raw === "?" ? "Showing command grammar cheat sheet" : "Type a verb or search query",
      target: { kind: "query", id: raw, label: raw },
      args: {},
    };
  }

  const firstSpace = raw.search(/\s/);
  const head = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
  const rest = firstSpace === -1 ? "" : raw.slice(firstSpace).trim();

  // Unknown verbs NEVER execute; they fall back cleanly to search.
  if (!VERB_SPEC_MAP.has(head as ActionableVerb)) {
    return {
      raw,
      verb: "search",
      isWrite: false,
      executable: false,
      valid: true,
      target: { kind: "query", id: raw, label: raw },
      args: { query: raw },
    };
  }

  const verb = head as ActionableVerb;
  const spec = VERB_SPEC_MAP.get(verb)!;

  switch (verb) {
    case "open": {
      if (!rest) {
        return {
          raw,
          verb: "open",
          isWrite: false,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "view", id: "", label: "" },
          args: {},
        };
      }
      const lowerRest = rest.toLowerCase();
      const viewAlias = VIEW_ALIASES[lowerRest];
      if (viewAlias) {
        return {
          raw,
          verb: "open",
          isWrite: false,
          executable: true,
          valid: true,
          target: { kind: "view", id: viewAlias.view, label: viewAlias.label },
          args: { view: viewAlias.view, sub: viewAlias.sub },
        };
      }
      if (/^#\d+$/.test(rest) || /^thread:\S+$/i.test(rest)) {
        const tid = cleanThreadIdToken(rest);
        return {
          raw,
          verb: "open",
          isWrite: false,
          executable: true,
          valid: true,
          target: { kind: "thread", id: tid, label: `Thread #${tid}` },
          args: { threadId: tid },
        };
      }
      return {
        raw,
        verb: "open",
        isWrite: false,
        executable: true,
        valid: true,
        target: { kind: "entity", id: rest, label: rest },
        args: { query: rest },
      };
    }

    case "approve":
    case "revise":
    case "defer": {
      if (!rest) {
        return {
          raw,
          verb,
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "thread", id: "", label: "" },
          args: { verdict: verb },
        };
      }
      const m = /^(#?\S+)(?:\s+([\s\S]+))?$/.exec(rest);
      const rawId = m ? m[1] : rest;
      const threadId = cleanThreadIdToken(rawId);
      const note = m && m[2] ? m[2].trim() : undefined;
      if (!threadId || !/^[a-zA-Z0-9._:-]{1,64}$/.test(threadId)) {
        return {
          raw,
          verb: "search",
          isWrite: false,
          executable: false,
          valid: true,
          target: { kind: "query", id: raw, label: raw },
          args: { query: raw },
        };
      }
      return {
        raw,
        verb,
        isWrite: true,
        executable: true,
        valid: true,
        target: { kind: "thread", id: threadId, label: `Thread #${threadId}` },
        args: { threadId, verdict: verb as DecisionVerdict, ...(note ? { note } : {}) },
      };
    }

    case "draft": {
      if (!rest) {
        return {
          raw,
          verb: "draft",
          isWrite: false,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "person", id: "", label: "" },
          args: {},
        };
      }
      // Support `draft "Alex Rivera" topic` or `draft alex :: topic` or `draft alex topic`
      let person = "";
      let topic = "";
      const quoted = /^"([^"]+)"(?:\s+([\s\S]+))?$/.exec(rest);
      if (quoted) {
        person = quoted[1].trim();
        topic = (quoted[2] || "").trim();
      } else if (rest.includes("::")) {
        const [p, ...tParts] = rest.split("::");
        person = p.trim();
        topic = tParts.join("::").trim();
      } else {
        const sp = rest.search(/\s/);
        person = sp === -1 ? rest : rest.slice(0, sp);
        topic = sp === -1 ? "" : rest.slice(sp).trim();
      }
      const personKey = person.toLowerCase().replace(/^@/, "").trim();
      return {
        raw,
        verb: "draft",
        isWrite: false,
        executable: Boolean(personKey),
        valid: Boolean(personKey),
        target: { kind: "person", id: personKey, label: person },
        args: { person, personKey, topic, localOnly: true },
      };
    }

    case "prep": {
      if (!rest) {
        return {
          raw,
          verb: "prep",
          isWrite: false,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "person", id: "", label: "" },
          args: {},
        };
      }
      const isMeeting = /\b(sync|call|standup|meeting|review|retro|demo|board|pitch|1:1)\b/i.test(rest);
      const targetId = rest.toLowerCase().replace(/^@/, "").trim();
      return {
        raw,
        verb: "prep",
        isWrite: false,
        executable: true,
        valid: true,
        target: { kind: isMeeting ? "meeting" : "person", id: targetId, label: rest },
        args: { query: rest, key: targetId, localOnly: true },
      };
    }

    case "task": {
      if (!rest) {
        return {
          raw,
          verb: "task",
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "board", id: "box", label: "#box" },
          args: {},
        };
      }
      let channel = "box";
      const agents: string[] = [];
      let text = rest;

      const roomMatch = /(?:^|\s)#([a-zA-Z0-9._-]{1,48})\b/.exec(text);
      if (roomMatch) {
        channel = roomMatch[1].toLowerCase();
        text = text.replace(roomMatch[0], " ");
      }
      const agentMatches = Array.from(text.matchAll(/(?:^|\s)@([a-zA-Z0-9._-]{1,32})\b/g));
      for (const am of agentMatches) {
        agents.push(am[1].toLowerCase());
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) {
        return {
          raw,
          verb: "task",
          isWrite: true,
          executable: false,
          valid: false,
          hint: "Task text is required",
          target: { kind: "board", id: channel, label: `#${channel}` },
          args: { channel, agents },
        };
      }
      return {
        raw,
        verb: "task",
        isWrite: true,
        executable: true,
        valid: true,
        target: { kind: "board", id: channel, label: `#${channel}` },
        args: { text, channel, agents },
      };
    }

    case "note": {
      if (!rest) {
        return {
          raw,
          verb: "note",
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "codex", id: "new-note", label: "Mind Codex" },
          args: {},
        };
      }
      const { section, cleanText } = extractCodexSectionTag(rest);
      let title = cleanText;
      let summary = cleanText;
      if (cleanText.includes("::")) {
        const [t, ...sParts] = cleanText.split("::");
        title = t.trim() || cleanText.slice(0, 64);
        summary = sParts.join("::").trim() || title;
      } else if (cleanText.length > 72) {
        const cut = cleanText.slice(0, 68);
        const sp = cut.lastIndexOf(" ");
        title = (sp > 28 ? cut.slice(0, sp) : cut).trim();
      }
      return {
        raw,
        verb: "note",
        isWrite: true,
        executable: Boolean(title),
        valid: Boolean(title),
        target: { kind: "codex", id: section, label: title },
        args: { title, summary, section },
      };
    }

    case "capture": {
      if (!rest) {
        return {
          raw,
          verb: "capture",
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "codex", id: "new-capture", label: "Mind Codex" },
          args: {},
        };
      }
      const { section, cleanText } = extractCodexSectionTag(rest);
      let title = cleanText;
      let summary = cleanText;
      if (cleanText.includes("::")) {
        const [t, ...sParts] = cleanText.split("::");
        title = t.trim();
        summary = sParts.join("::").trim() || title;
      }
      if (!title) {
        return {
          raw,
          verb: "capture",
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "codex", id: section, label: "Mind Codex" },
          args: {},
        };
      }
      return {
        raw,
        verb: "capture",
        isWrite: true,
        executable: true,
        valid: true,
        target: { kind: "codex", id: section, label: title },
        args: { title, summary, section },
      };
    }

    case "rule": {
      const m = /^(prefer|avoid)\s+([\s\S]+)$/i.exec(rest);
      if (!m) {
        // Natural queries like "rule of thumb" fall back safely to search!
        if (rest && !/^(prefer|avoid)\b/i.test(rest)) {
          return {
            raw,
            verb: "search",
            isWrite: false,
            executable: false,
            valid: true,
            target: { kind: "query", id: raw, label: raw },
            args: { query: raw },
          };
        }
        return {
          raw,
          verb: "rule",
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "taste", id: "taste", label: "Taste Studio" },
          args: {},
        };
      }
      const polarity = m[1].toLowerCase() as "prefer" | "avoid";
      let ruleText = m[2].trim();
      let domain: TasteDomainId | null = null;

      // Support optional domain tag `#ui_product` or `[typography_copy]` or `domain:motion_feel`
      const domTag = /(?:^|\s)(?:#|domain:|\[)(ui_product|typography_copy|visual_brand|motion_feel|video_anime|merch_objects|spaces_life|agent_ops)\]?(?=\s|$)/i.exec(ruleText);
      if (domTag && isTasteDomainId(domTag[1].toLowerCase())) {
        domain = domTag[1].toLowerCase() as TasteDomainId;
        ruleText = ruleText.replace(domTag[0], " ").replace(/\s+/g, " ").trim();
      }
      if (!domain) {
        domain = inferTasteDomainFromRuleText(ruleText);
      }

      return {
        raw,
        verb: "rule",
        isWrite: true,
        executable: Boolean(ruleText),
        valid: Boolean(ruleText),
        target: { kind: "taste", id: domain, label: `${polarity.toUpperCase()} (${domain})` },
        args: { polarity, domain, rule: ruleText },
      };
    }

    case "snooze": {
      if (!rest) {
        return {
          raw,
          verb: "snooze",
          isWrite: true,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "item", id: "", label: "" },
          args: {},
        };
      }
      const parts = rest.split(/\s+/);
      const id = parts[0].replace(/^#/, "").trim();
      const hours = parseSnoozeHours(parts[1]);
      return {
        raw,
        verb: "snooze",
        isWrite: true,
        executable: Boolean(id),
        valid: Boolean(id),
        target: { kind: "item", id, label: `Item ${id}` },
        args: { id, hours },
      };
    }

    case "ask": {
      if (!rest) {
        return {
          raw,
          verb: "ask",
          isWrite: false,
          executable: false,
          valid: false,
          hint: spec.syntax,
          target: { kind: "question", id: "", label: "" },
          args: {},
        };
      }
      return {
        raw,
        verb: "ask",
        isWrite: false,
        executable: true,
        valid: true,
        target: { kind: "question", id: rest.slice(0, 80), label: rest },
        args: { question: rest },
      };
    }
  }
}

export function buildCommandPreview(parsed: ParsedCommand): CommandPreview | null {
  if (parsed.verb === "search" || !parsed.valid) return null;
  const spec = VERB_SPEC_MAP.get(parsed.verb);
  if (!spec) return null;

  switch (parsed.verb) {
    case "open":
      return {
        method: "NAVIGATE",
        endpoint: spec.endpoint,
        targetLabel: parsed.target.label,
        summary: `Open ${parsed.target.label}`,
        requiresConfirm: false,
        payload: { target: parsed.target, ...parsed.args },
      };

    case "approve":
    case "revise":
    case "defer": {
      const threadId = String(parsed.args.threadId || parsed.target.id);
      const note = typeof parsed.args.note === "string" ? parsed.args.note : "";
      return {
        method: "POST",
        endpoint: "/api/decisions/stamp",
        targetLabel: `Thread #${threadId}`,
        summary: `${parsed.verb.toUpperCase()} thread #${threadId}${note ? ` - "${note}"` : ""}`,
        requiresConfirm: true,
        payload: { threadId, verdict: parsed.verb, ...(note ? { note } : {}) },
      };
    }

    case "draft": {
      const person = String(parsed.args.person || parsed.target.label);
      const topic = typeof parsed.args.topic === "string" && parsed.args.topic ? parsed.args.topic : "";
      return {
        method: "POST",
        endpoint: "/api/draft",
        targetLabel: person,
        summary: `Generate local-only reply draft for ${person}${topic ? ` about "${topic}"` : ""} (never sends)`,
        requiresConfirm: false,
        localOnly: true,
        payload: { person, topic, local_only: true },
      };
    }

    case "prep": {
      const label = parsed.target.label;
      return {
        method: "GET",
        endpoint: `/api/people/prep?key=${encodeURIComponent(parsed.target.id)}`,
        targetLabel: label,
        summary: `Build local-only prep pack for ${label}`,
        requiresConfirm: false,
        localOnly: true,
        payload: { key: parsed.target.id, local_only: true },
      };
    }

    case "task": {
      const channel = String(parsed.args.channel || "box");
      const text = String(parsed.args.text || "");
      return {
        method: "POST",
        endpoint: "/api/agent-board/dispatch",
        targetLabel: `#${channel}`,
        summary: `Dispatch task to #${channel}: "${text.slice(0, 100)}"`,
        requiresConfirm: true,
        payload: { channel, text, agents: parsed.args.agents || [] },
      };
    }

    case "note":
    case "capture": {
      const title = String(parsed.args.title || parsed.target.label);
      const section = String(parsed.args.section || "ideas");
      return {
        method: "POST",
        endpoint: "/api/codex/item",
        targetLabel: `${section}: ${title}`,
        summary: `Add Codex ${section} entry "${title}"`,
        requiresConfirm: true,
        payload: { section, title, summary: parsed.args.summary },
      };
    }

    case "rule": {
      const polarity = String(parsed.args.polarity || "prefer");
      const domain = String(parsed.args.domain || "ui_product");
      const rule = String(parsed.args.rule || "");
      return {
        method: "POST",
        endpoint: "/api/taste/rule",
        targetLabel: `${polarity.toUpperCase()} / ${domain}`,
        summary: `Lock Taste ${polarity} rule in ${domain}: "${rule.slice(0, 100)}"`,
        requiresConfirm: true,
        payload: { domain, polarity, rule },
      };
    }

    case "snooze": {
      const id = String(parsed.args.id || parsed.target.id);
      const hours = Number(parsed.args.hours || 4);
      return {
        method: "POST",
        endpoint: "/api/today/triage",
        targetLabel: `Item ${id}`,
        summary: `Snooze ${id} for ${hours}h`,
        requiresConfirm: true,
        payload: { id, action: "snooze", hours },
      };
    }

    case "ask": {
      const question = String(parsed.args.question || parsed.target.label);
      return {
        method: "POST",
        endpoint: "/api/ask",
        targetLabel: "Ask Mind",
        summary: `Ask Mind with hybrid semantic context: "${question.slice(0, 100)}"`,
        requiresConfirm: false,
        payload: { question },
      };
    }
  }
}

// ============================================================================
// Command Plane Engine (Lexical + Semantic RRF + Execution)
// ============================================================================

const RRF_K = 60;
const SEMANTIC_CORPUS_MAX_DOCS = 2500;
const SEMANTIC_CORPUS_REFRESH_MS = 120_000;

interface IndexedSemanticDoc {
  doc: SemanticDocInput;
  embedText: string;
}

export class CommandPlaneEngine {
  readonly api: KizukiVaultApi;
  readonly codexApi: KizukiCodexApi;
  readonly tasteApi: KizukiTasteApi;
  readonly gardenerApi: KizukiTasteGardenerApi | null;
  readonly agentBoardApi: KizukiAgentBoardApi;
  readonly boardBridge: KizukiBoardMindBridge;
  readonly embedder: LocalEmbedder;

  private readonly fetchImpl: FetchLike;
  private readonly injectedOmniIndex: OmniIndexSearch | null | undefined;
  private readonly stampDecisionFn?: CommandPlaneConfig["stampDecision"];
  private readonly prepPersonFn?: CommandPlaneConfig["prepPerson"];
  private readonly snoozeItemFn?: CommandPlaneConfig["snoozeItem"];

  // Strictly in-memory semantic corpus (zero disk persistence, bounded size)
  private semanticCorpus: IndexedSemanticDoc[] = [];
  private customCorpus: IndexedSemanticDoc[] = [];
  private lastCorpusBuildAt = 0;
  private corpusBuildPromise: Promise<void> | null = null;

  constructor(config: CommandPlaneConfig) {
    this.api = config.api;
    this.codexApi = config.codexApi;
    this.tasteApi = config.tasteApi;
    this.gardenerApi = config.gardenerApi || null;
    this.agentBoardApi = config.agentBoardApi;
    this.boardBridge = config.boardBridge;
    this.embedder = config.embedder || new LocalEmbedder({ fetchImpl: config.fetchImpl });
    this.fetchImpl = config.fetchImpl || fetch;
    this.injectedOmniIndex = config.omniIndex;
    this.stampDecisionFn = config.stampDecision;
    this.prepPersonFn = config.prepPerson;
    this.snoozeItemFn = config.snoozeItem;
  }

  private getOmniIndex(): OmniIndexSearch | null {
    if (this.injectedOmniIndex !== undefined) return this.injectedOmniIndex;
    const g = globalThis as unknown as { __kizukiOmniIndex?: OmniIndexSearch };
    if (g.__kizukiOmniIndex && typeof g.__kizukiOmniIndex.search === "function") {
      return g.__kizukiOmniIndex;
    }
    return null;
  }

  /**
   * Register additional in-memory documents for semantic recall (e.g. background corpus or tests).
   * Strictly memory-only and bounded.
   */
  indexSemanticDocuments(docs: SemanticDocInput[]): void {
    const out: IndexedSemanticDoc[] = [];
    for (const doc of docs.slice(0, SEMANTIC_CORPUS_MAX_DOCS)) {
      const embedText = normalizeTextKey(`${doc.title}. ${doc.subtitle || ""} ${doc.text}`);
      if (!embedText) continue;
      out.push({ doc, embedText });
    }
    this.customCorpus = out;
  }

  async warmSemanticCorpus(): Promise<void> {
    const now = Date.now();
    if (this.semanticCorpus.length > 0 && now - this.lastCorpusBuildAt < SEMANTIC_CORPUS_REFRESH_MS) {
      return;
    }
    if (this.corpusBuildPromise) {
      return this.corpusBuildPromise;
    }
    const job = this.buildSemanticCorpusInternal();
    this.corpusBuildPromise = job;
    try {
      await job;
    } finally {
      if (this.corpusBuildPromise === job) {
        this.corpusBuildPromise = null;
      }
    }
  }

  private async buildSemanticCorpusInternal(): Promise<void> {
    const docs: IndexedSemanticDoc[] = [];
    const seen = new Set<string>();
    const addDoc = (doc: SemanticDocInput) => {
      if (docs.length >= SEMANTIC_CORPUS_MAX_DOCS) return;
      if (seen.has(doc.id)) return;
      const embedText = normalizeTextKey(`${doc.title}. ${doc.subtitle || ""} ${doc.text}`);
      if (!embedText) return;
      seen.add(doc.id);
      docs.push({ doc, embedText });
    };

    try {
      const codex = this.codexApi.getCodex();
      for (const item of codex.items.slice(0, 400)) {
        addDoc({
          id: `codex:${item.id}`,
          kind: "codex",
          title: item.title,
          subtitle: `${item.section} | ${item.domain}`,
          text: `${item.summary} ${item.thesis || ""} ${item.anti_pattern || ""} ${item.tags.join(" ")}`,
          badge: item.stage || item.section,
          target: { view: "codex", section: item.section, itemId: item.id },
          verbs: ["open", "ask"],
        });
      }
    } catch {
      // fail-soft
    }

    try {
      const rules = this.tasteApi.listAllRules();
      for (const rule of rules.slice(0, 300)) {
        addDoc({
          id: `taste:${rule.id}`,
          kind: "taste",
          title: rule.rule,
          subtitle: `${rule.polarity.toUpperCase()} | ${rule.domain}`,
          text: `${rule.polarity} ${rule.domain} ${rule.rule} ${rule.reason || ""}`,
          badge: rule.polarity === "avoid" ? "Avoid" : "Prefer",
          target: { view: "taste", domain: rule.domain, ruleId: rule.id },
          verbs: ["open", "ask"],
        });
      }
    } catch {
      // fail-soft
    }

    this.semanticCorpus = docs;
    this.lastCorpusBuildAt = Date.now();

    // Background embed in bounded batches (never throws if :8789 offline)
    if (docs.length > 0) {
      await this.embedder.embedBatch(
        docs.map((d) => d.embedText),
        { timeoutMs: 3500 }
      );
    }
  }

  private getEffectiveSearchQuery(parsed: ParsedCommand): string {
    if (parsed.verb === "search") return parsed.raw;
    if (parsed.verb === "open" && parsed.target.kind === "entity") return parsed.target.label;
    if (parsed.verb === "draft") return String(parsed.args.person || parsed.target.label);
    if (parsed.verb === "prep") return String(parsed.args.query || parsed.target.label);
    if (parsed.verb === "ask") return String(parsed.args.question || parsed.target.label);
    if (parsed.verb === "approve" || parsed.verb === "revise" || parsed.verb === "defer") {
      return parsed.target.id;
    }
    return "";
  }

  private async runLexicalSearch(query: string, limit: number): Promise<CommandHit[]> {
    const cleanQ = query.trim();
    const hits: CommandHit[] = [];
    const seen = new Set<string>();

    const pushHit = (hit: Omit<CommandHit, "lexicalRank" | "rrfScore">) => {
      if (seen.has(hit.id)) return;
      seen.add(hit.id);
      const rank = hits.length + 1;
      hits.push({
        ...hit,
        lexicalRank: rank,
        rrfScore: 1 / (RRF_K + rank),
      });
    };

    const qLower = cleanQ.toLowerCase();

    // 1. Built-in View matches
    if (qLower) {
      const seenViews = new Set<string>();
      for (const [alias, meta] of Object.entries(VIEW_ALIASES)) {
        if (seenViews.has(meta.view)) continue;
        if (alias.includes(qLower) || meta.label.toLowerCase().includes(qLower) || meta.sub.toLowerCase().includes(qLower)) {
          seenViews.add(meta.view);
          pushHit({
            id: `view:${meta.view}`,
            kind: "view",
            title: meta.label,
            subtitle: meta.sub,
            snippet: meta.sub,
            badge: "View",
            target: { view: meta.view },
            verbs: ["open"],
          });
        }
      }
    }

    if (!cleanQ) {
      return hits.slice(0, limit);
    }

    // 2. C4 OmniIndex (fast <25ms) or fallback to api.omniSearch
    let omniData: Partial<OmniSearchResponse> & {
      codex?: Array<Record<string, unknown>>;
      board?: Array<Record<string, unknown>>;
    } = {};

    const c4 = this.getOmniIndex();
    if (c4) {
      try {
        omniData = (await c4.search(cleanQ, Math.max(limit, 50))) as typeof omniData;
      } catch {
        omniData = {};
      }
    } else {
      try {
        omniData = (await this.api.omniSearch(cleanQ, Math.min(20, limit))) as typeof omniData;
      } catch {
        omniData = {};
      }
    }

    const groups = (omniData && omniData.groups) || ({} as OmniSearchResponse["groups"]);

    // People
    if (Array.isArray(groups.people)) {
      for (const p of groups.people) {
        const key = String(p.key || p.name || "");
        const name = String(p.name || p.key || "Person");
        pushHit({
          id: `person:${key}`,
          kind: "person",
          title: name,
          subtitle: Array.isArray(p.channels) ? p.channels.join(" / ") : "Relationship Dossier",
          snippet: stripEmDashesSafe(String(p.preview || p.last_snippet || "")),
          badge: "Person",
          target: { view: "people", personKey: key, name },
          verbs: ["open", "prep", "draft", "ask"],
        });
      }
    }

    // Board threads (either from C4/omni groups.board or boardBridge.searchForOmni)
    const boardHits: Array<Record<string, unknown>> = [];
    if (Array.isArray((groups as Record<string, unknown>).board)) {
      boardHits.push(...((groups as Record<string, unknown>).board as Array<Record<string, unknown>>));
    } else if (Array.isArray(omniData.board)) {
      boardHits.push(...omniData.board);
    } else if (typeof this.boardBridge.searchForOmni === "function") {
      try {
        const bRes = this.boardBridge.searchForOmni(cleanQ, 12);
        if (Array.isArray(bRes)) boardHits.push(...(bRes as unknown as Array<Record<string, unknown>>));
      } catch {
        // fail-soft
      }
    }
    for (const b of boardHits) {
      const tid = String(b.id || b.threadId || "");
      const ch = String(b.channel || "box").replace(/^#/, "");
      const title = stripEmDashesSafe(String(b.title || b.subject || b.preview || `Thread #${tid}`));
      pushHit({
        id: `board:${tid}`,
        kind: "board",
        title: `#${ch} | ${title}`,
        subtitle: b.author ? `by ${String(b.author)}` : `Agent Board #${ch}`,
        snippet: stripEmDashesSafe(String(b.snippet || b.preview || "")),
        badge: "Board",
        target: { view: "board", channel: ch, threadId: tid },
        verbs: ["open", "approve", "revise", "defer", "snooze"],
      });
    }

    // Codex entries
    const codexHits = Array.isArray(omniData.codex)
      ? omniData.codex
      : Array.isArray((groups as Record<string, unknown>).codex)
        ? ((groups as Record<string, unknown>).codex as Array<Record<string, unknown>>)
        : this.codexApi.searchForOmni(cleanQ, 12);
    for (const c of codexHits as Array<Record<string, unknown>>) {
      const cid = String(c.id || "");
      pushHit({
        id: `codex:${cid}`,
        kind: "codex",
        title: stripEmDashesSafe(String(c.title || cid)),
        subtitle: stripEmDashesSafe([c.domain, c.subtitle].filter(Boolean).join(" | ")),
        snippet: stripEmDashesSafe(String(c.subtitle || c.summary || "")),
        badge: String(c.stage || c.section || "Codex"),
        target: { view: "codex", section: c.section, itemId: cid },
        verbs: ["open", "ask"],
      });
    }

    // Taste rules (direct fast lexical match)
    try {
      const tokens = tokenizeForSearch(cleanQ);
      const rules = this.tasteApi.listAllRules();
      for (const r of rules) {
        const hay = `${r.rule} ${r.reason || ""} ${r.domain} ${r.polarity}`.toLowerCase();
        const matches = tokens.length > 0 ? tokens.every((t) => hay.includes(t)) : hay.includes(qLower);
        if (!matches) continue;
        pushHit({
          id: `taste:${r.id}`,
          kind: "taste",
          title: stripEmDashesSafe(r.rule),
          subtitle: `${r.polarity.toUpperCase()} | ${r.domain}`,
          snippet: stripEmDashesSafe(r.reason || r.rule),
          badge: r.polarity === "avoid" ? "Avoid" : "Prefer",
          target: { view: "taste", domain: r.domain, ruleId: r.id },
          verbs: ["open", "ask"],
        });
      }
    } catch {
      // fail-soft
    }

    // Calendar
    if (Array.isArray(groups.calendar)) {
      for (const ev of groups.calendar) {
        pushHit({
          id: `cal:${ev.id}`,
          kind: "calendar",
          title: stripEmDashesSafe(ev.title || "Calendar Event"),
          subtitle: `${ev.start || ""}${ev.calendar ? ` | ${ev.calendar}` : ""}`,
          snippet: stripEmDashesSafe(ev.preview || ""),
          badge: "Calendar",
          target: { view: "today", meetingId: ev.id, title: ev.title },
          verbs: ["open", "prep", "snooze"],
        });
      }
    }

    // Inbox
    if (Array.isArray(groups.inbox)) {
      for (const msg of groups.inbox) {
        pushHit({
          id: `inbox:${msg.id}`,
          kind: "inbox",
          title: stripEmDashesSafe(`${msg.sender ? `${msg.sender}: ` : ""}${msg.thread_title || msg.preview}`),
          subtitle: `${msg.channel_label || msg.channel || "Inbox"} | ${msg.occurred_at || ""}`,
          snippet: stripEmDashesSafe(msg.preview || ""),
          badge: String(msg.channel_label || msg.channel || "Inbox"),
          target: { view: "today", inboxId: msg.id, sender: msg.sender, threadKey: msg.thread_key },
          verbs: ["open", "draft", "snooze"],
        });
      }
    }

    // Vault docs
    if (Array.isArray(groups.docs)) {
      for (const d of groups.docs) {
        pushHit({
          id: `doc:${d.path}`,
          kind: "doc",
          title: stripEmDashesSafe(d.title || d.path),
          subtitle: d.path,
          snippet: stripEmDashesSafe(d.excerpt || ""),
          badge: d.category || "Doc",
          target: { view: "vault", docPath: d.path },
          verbs: ["open", "ask"],
        });
      }
    }

    // MemT
    if (Array.isArray(groups.memt)) {
      for (const m of groups.memt) {
        pushHit({
          id: `memt:${m.id}`,
          kind: "memt",
          title: stripEmDashesSafe(m.condition || m.id),
          subtitle: stripEmDashesSafe(m.recommendation || m.domain || ""),
          snippet: stripEmDashesSafe(m.recommendation || ""),
          badge: m.domain || "MemT",
          target: { view: "memt", memtId: m.id },
          verbs: ["open", "ask"],
        });
      }
    }

    // Graph nodes
    if (Array.isArray(groups.nodes)) {
      for (const n of groups.nodes) {
        pushHit({
          id: `node:${n.id}`,
          kind: "node",
          title: stripEmDashesSafe(n.label || n.id),
          subtitle: n.kind || "Node",
          snippet: stripEmDashesSafe(n.summary || ""),
          badge: n.kind || "Node",
          target: { view: "graph", nodeId: n.id },
          verbs: ["open", "ask"],
        });
      }
    }

    return hits.slice(0, Math.max(limit, 50));
  }

  /**
   * Rerank lexical hits + in-memory semantic corpus with local :8789 embeddings using RRF.
   * Gracefully returns lexical hits unchanged when embeddings are unavailable.
   */
  async rerankWithSemantics(
    query: string,
    lexicalHits: CommandHit[],
    limit = 20,
  ): Promise<{ hits: CommandHit[]; semanticUsed: boolean; semanticMs: number }> {
    const t0 = performance.now();
    const cleanQ = query.trim();
    if (!cleanQ) {
      return { hits: lexicalHits.slice(0, limit), semanticUsed: false, semanticMs: 0 };
    }

    const qVec = await this.embedder.embedSingle(cleanQ, { timeoutMs: 1200 });
    if (!qVec) {
      return {
        hits: lexicalHits.slice(0, limit),
        semanticUsed: false,
        semanticMs: Math.round(performance.now() - t0),
      };
    }

    // Gather candidate pool: lexical top 50 + custom/background semantic corpus
    const candidateMap = new Map<string, { hit: CommandHit; embedText: string }>();
    for (const h of lexicalHits.slice(0, 50)) {
      candidateMap.set(h.id, {
        hit: { ...h },
        embedText: normalizeTextKey(`${h.title}. ${h.subtitle} ${h.snippet}`),
      });
    }

    // Combine custom corpus + cached semantic corpus (trigger background build lazily if empty)
    if (this.semanticCorpus.length === 0 && this.customCorpus.length === 0) {
      // Trigger non-blocking background warm if cold, or await quickly if small
      await this.warmSemanticCorpus();
    }

    const corpusPool = [...this.customCorpus, ...this.semanticCorpus];
    for (const item of corpusPool) {
      if (candidateMap.has(item.doc.id)) continue;
      candidateMap.set(item.doc.id, {
        hit: {
          id: item.doc.id,
          kind: item.doc.kind,
          title: stripEmDashesSafe(item.doc.title),
          subtitle: stripEmDashesSafe(item.doc.subtitle || ""),
          snippet: stripEmDashesSafe(item.doc.text.slice(0, 180)),
          badge: item.doc.badge || item.doc.kind,
          target: item.doc.target || {},
          rrfScore: 0,
          verbs: item.doc.verbs || ["open", "ask"],
        },
        embedText: item.embedText,
      });
    }

    const entries = Array.from(candidateMap.values());
    const vecs = await this.embedder.embedBatch(
      entries.map((e) => e.embedText),
      { timeoutMs: 2500 }
    );

    const scoredSem: Array<{ id: string; semScore: number }> = [];
    let anyVec = false;
    for (let i = 0; i < entries.length; i++) {
      const v = vecs[i];
      if (!v) continue;
      anyVec = true;
      const semScore = cosineSimilarity(qVec, v);
      entries[i].hit.semanticScore = Number(semScore.toFixed(4));
      scoredSem.push({ id: entries[i].hit.id, semScore });
    }

    if (!anyVec) {
      return {
        hits: lexicalHits.slice(0, limit),
        semanticUsed: false,
        semanticMs: Math.round(performance.now() - t0),
      };
    }

    scoredSem.sort((a, b) => b.semScore - a.semScore);
    const semRankMap = new Map<string, number>();
    const semScoreMap = new Map<string, number>();
    for (let i = 0; i < scoredSem.length; i++) {
      semRankMap.set(scoredSem[i].id, i + 1);
      semScoreMap.set(scoredSem[i].id, scoredSem[i].semScore);
    }

    // Reciprocal Rank Fusion (RRF): fuse lexical rank + semantic rank
    const fused: CommandHit[] = [];
    for (const { hit } of entries) {
      const lexRank = hit.lexicalRank;
      const semRank = semRankMap.get(hit.id);
      const semScore = semScoreMap.get(hit.id) ?? 0;

      // Filter out purely semantic candidates below minimum conceptual similarity
      if (lexRank === undefined && semScore < 0.35) continue;

      const lexTerm = lexRank !== undefined ? 1.0 / (RRF_K + lexRank) : 0;
      // Weight semantic rank slightly higher when semantic similarity is genuinely strong
      const semWeight = semScore >= 0.55 ? 1.35 : 1.0;
      const semTerm = semRank !== undefined ? semWeight / (RRF_K + semRank) : 0;
      const tieBoost = semScore * 0.002;
      hit.rrfScore = Number((lexTerm + semTerm + tieBoost).toFixed(6));
      fused.push(hit);
    }

    fused.sort((a, b) => b.rrfScore - a.rrfScore || (b.semanticScore || 0) - (a.semanticScore || 0));

    return {
      hits: fused.slice(0, limit),
      semanticUsed: true,
      semanticMs: Math.round(performance.now() - t0),
    };
  }

  async resolveCommand(req: ResolveCommandRequest): Promise<ResolveCommandResponse> {
    const t0 = performance.now();
    const rawQ = String(req?.q || "");
    const limit = Math.max(1, Math.min(50, Number(req?.limit) || 20));
    const includeSemantic = req?.includeSemantic !== false;

    const parsed = parseCommand(rawQ);
    const preview = buildCommandPreview(parsed);
    const searchQuery = this.getEffectiveSearchQuery(parsed);

    const tLex0 = performance.now();
    const lexicalHits = searchQuery ? await this.runLexicalSearch(searchQuery, Math.max(limit, 50)) : [];
    const lexicalMs = Math.max(0, Math.round(performance.now() - tLex0));

    let finalHits = lexicalHits.slice(0, limit);
    let semanticUsed = false;
    let semanticMs = 0;

    if (includeSemantic && searchQuery) {
      const semRes = await this.rerankWithSemantics(searchQuery, lexicalHits, limit);
      finalHits = semRes.hits;
      semanticUsed = semRes.semanticUsed;
      semanticMs = semRes.semanticMs;
    }

    return {
      ok: true,
      q: parsed.raw,
      verb: parsed.verb,
      isWrite: parsed.isWrite,
      executable: parsed.executable,
      valid: parsed.valid,
      ...(parsed.hint ? { hint: parsed.hint } : {}),
      target: parsed.target,
      args: parsed.args,
      preview,
      hits: finalHits,
      total: finalHits.length,
      semanticUsed,
      lexicalMs,
      semanticMs,
      ms: Math.max(0, Math.round(performance.now() - t0)),
    };
  }

  async executeCommand(req: ExecuteCommandRequest): Promise<ExecuteCommandOutcome> {
    const parsed = parseCommand(req?.q || "");
    const preview = buildCommandPreview(parsed);

    // Unknown verbs NEVER execute
    if (parsed.verb === "search" || !parsed.executable || !parsed.valid) {
      return {
        status: 400,
        body: {
          ok: false,
          error: parsed.verb === "search" ? "not_executable" : "invalid_command",
          verb: parsed.verb,
          executed: false,
          message:
            parsed.verb === "search"
              ? "Unknown or search-only query cannot be executed. Use a registered command verb."
              : parsed.hint || "Command is missing required arguments.",
        },
      };
    }

    // Write verbs strictly require confirm: true
    if (parsed.isWrite && req?.confirm !== true) {
      return {
        status: 400,
        body: {
          ok: false,
          error: "confirmation_required",
          verb: parsed.verb,
          executed: false,
          preview,
          message: `Write verb "${parsed.verb}" requires confirm: true.`,
        },
      };
    }

    const localOrigin = req.localOrigin;

    switch (parsed.verb) {
      case "open": {
        let resolvedHit: CommandHit | null = null;
        if (parsed.target.kind === "entity") {
          const hits = await this.runLexicalSearch(parsed.target.label, 5);
          resolvedHit = hits[0] || null;
        }
        return {
          status: 200,
          body: {
            ok: true,
            verb: "open",
            executed: true,
            preview,
            navigation:
              parsed.target.kind === "view"
                ? { view: parsed.target.id }
                : parsed.target.kind === "thread"
                  ? { view: "board", threadId: parsed.target.id }
                  : resolvedHit
                    ? resolvedHit.target
                    : { view: "today", q: parsed.target.label },
            resolved: resolvedHit,
          },
        };
      }

      case "approve":
      case "revise":
      case "defer": {
        const threadId = String(parsed.args.threadId || parsed.target.id);
        const verdict = parsed.verb as DecisionVerdict;
        const note = typeof parsed.args.note === "string" ? parsed.args.note : undefined;
        const idempotencyKey = `cmdp_${threadId}_${verdict}_${Date.now()}`;
        const result = await this.executeDecisionStamp(
          { threadId, verdict, note, idempotencyKey },
          localOrigin
        );
        return {
          status: 200,
          body: {
            ok: true,
            verb: parsed.verb,
            executed: true,
            preview,
            result,
          },
        };
      }

      case "draft": {
        const person = String(parsed.args.person || parsed.target.label);
        const personKey = String(parsed.args.personKey || parsed.target.id);
        const topic = typeof parsed.args.topic === "string" ? parsed.args.topic : "";
        let contextText = `Recipient: ${person}.`;
        if (topic) contextText += ` Topic: ${topic}.`;
        try {
          const dossier = await this.api.getPersonDossier(personKey);
          if (dossier && typeof dossier === "object") {
            const name = (dossier as { name?: string }).name || person;
            contextText = `Local reply draft for ${name}.${topic ? ` Topic: ${topic}.` : ""}`;
          }
        } catch {
          // dossier lookup optional
        }
        const draftRes = await this.api.createDraft({
          kind: "reply",
          title: `Draft reply to ${person}${topic ? `: ${topic}` : ""}`,
          context_text: stripEmDashesSafe(contextText),
          instructions: topic || "Write a terse, direct reply in the owner's voice with zero em-dashes.",
        });
        return {
          status: 200,
          body: {
            ok: true,
            verb: "draft",
            executed: true,
            local_only: true,
            preview,
            result: { ...draftRes, local_only: true },
          },
        };
      }

      case "prep": {
        const key = parsed.target.id;
        const label = parsed.target.label;
        const prepResult = await this.executePrep(key, label, localOrigin);
        return {
          status: 200,
          body: {
            ok: true,
            verb: "prep",
            executed: true,
            local_only: true,
            preview,
            result: { ...prepResult, local_only: true },
          },
        };
      }

      case "task": {
        const channel = String(parsed.args.channel || "box");
        const text = String(parsed.args.text || "");
        const dispatchRes = await this.boardBridge.dispatchMindItemToBoard({
          channel,
          text: stripEmDashesSafe(text),
          sourceKind: "command",
          sourceId: `cmdp_${randomUUID().slice(0, 8)}`,
          sourceLabel: `Cmd+K Task (#${channel})`,
        });
        return {
          status: 200,
          body: {
            ok: true,
            verb: "task",
            executed: true,
            preview,
            result: dispatchRes,
          },
        };
      }

      case "note":
      case "capture": {
        const title = stripEmDashesSafe(String(parsed.args.title || parsed.target.label));
        const summary = stripEmDashesSafe(String(parsed.args.summary || title));
        const section = (parsed.args.section as CodexSection) || "ideas";
        const upsertRes = this.codexApi.upsertItem({
          section,
          title,
          summary,
          tags: [parsed.verb === "note" ? "command-note" : "command-capture"],
        });
        return {
          status: 200,
          body: {
            ok: true,
            verb: parsed.verb,
            executed: true,
            preview,
            result: upsertRes,
          },
        };
      }

      case "rule": {
        const domain = String(parsed.args.domain || "ui_product");
        const polarity = String(parsed.args.polarity || "prefer");
        const rule = stripEmDashesSafe(String(parsed.args.rule || ""));
        const ruleRes = this.tasteApi.upsertRule({
          domain,
          polarity,
          rule,
          reason: "Locked via Unified Command Plane",
        });
        return {
          status: 200,
          body: {
            ok: true,
            verb: "rule",
            executed: true,
            preview,
            result: {
              ok: true,
              rule: ruleRes.rule,
            },
          },
        };
      }

      case "snooze": {
        const id = String(parsed.args.id || parsed.target.id);
        const hours = Number(parsed.args.hours || 4);
        const until = new Date(Date.now() + hours * 3_600_000).toISOString();
        const snoozeRes = await this.executeSnooze({ id, hours, until }, localOrigin);
        return {
          status: 200,
          body: {
            ok: true,
            verb: "snooze",
            executed: true,
            preview,
            result: snoozeRes,
          },
        };
      }

      case "ask": {
        const question = stripEmDashesSafe(String(parsed.args.question || parsed.target.label));
        const resolved = await this.resolveCommand({ q: question, includeSemantic: true, limit: 8 });
        const contextLines = resolved.hits.map(
          (h) => `[${h.kind.toUpperCase()}] ${h.title}${h.snippet ? ` - ${h.snippet.slice(0, 180)}` : ""}`
        );
        const citations = resolved.hits.map((h) => ({
          id: h.id,
          label: h.title,
          kind: h.kind,
        }));
        const interactRes = await this.api.interact(
          { mode: "ask", input: question },
          contextLines.length > 0 ? { lines: contextLines, citations } : undefined
        );
        return {
          status: 200,
          body: {
            ok: true,
            verb: "ask",
            executed: true,
            preview,
            semanticUsed: resolved.semanticUsed,
            entities: resolved.hits.slice(0, 8),
            result: interactRes,
          },
        };
      }
    }
  }

  private async executeDecisionStamp(
    req: { threadId: string; verdict: DecisionVerdict; note?: string; idempotencyKey: string },
    localOrigin?: string,
  ): Promise<Record<string, unknown>> {
    // 1. Injected callback (tests or coordinator wiring)
    if (this.stampDecisionFn) {
      return this.stampDecisionFn(req);
    }

    // 2. Shared runtime C1 Decision Ledger if loaded by Area 4
    const g = globalThis as unknown as {
      __kizukiDecisionLedger?: {
        stamp: (r: typeof req) => Promise<Record<string, unknown>>;
      };
    };
    if (g.__kizukiDecisionLedger && typeof g.__kizukiDecisionLedger.stamp === "function") {
      return g.__kizukiDecisionLedger.stamp(req);
    }

    // 3. Loopback HTTP call to C1 /api/decisions/stamp if localOrigin is known
    if (localOrigin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(localOrigin)) {
      try {
        const resp = await this.fetchImpl(`${localOrigin}/api/decisions/stamp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(4000),
        });
        if (resp.ok) {
          return (await resp.json()) as Record<string, unknown>;
        }
      } catch {
        // fall through to direct fail-closed board reply
      }
    }

    // 4. Fallback directly through Agent Board's fail-closed replyToThread
    const stampText = stripEmDashesSafe(
      `[DECISION: ${req.verdict.toUpperCase()}]${req.note ? ` ${req.note}` : " Stamped via Command Plane."}`
    );
    const reply = await this.agentBoardApi.replyToThread({
      threadId: req.threadId,
      text: stampText,
    });
    return {
      ok: true,
      threadId: req.threadId,
      verdict: req.verdict,
      idempotencyKey: req.idempotencyKey,
      deduplicated: false,
      replyId: (reply as unknown as { id?: number | string })?.id ?? null,
      stampedAt: new Date().toISOString(),
    };
  }

  private async executePrep(
    key: string,
    label: string,
    localOrigin?: string,
  ): Promise<Record<string, unknown>> {
    if (this.prepPersonFn) {
      const res = await this.prepPersonFn(key);
      if (res) return { ...res, local_only: true };
    }

    if (localOrigin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(localOrigin)) {
      try {
        const resp = await this.fetchImpl(
          `${localOrigin}/api/people/prep?key=${encodeURIComponent(key)}`,
          { signal: AbortSignal.timeout(4000) }
        );
        if (resp.ok) {
          const data = (await resp.json()) as Record<string, unknown>;
          return { ...data, local_only: true };
        }
      } catch {
        // fall through to local draft prep pack
      }
    }

    let contextText = `Meeting / relationship prep for ${label}.`;
    try {
      const dossier = await this.api.getPersonDossier(key);
      if (dossier && typeof dossier === "object") {
        const d = dossier as { name?: string; summary?: string; channels?: string[] };
        contextText = `Prep pack for ${d.name || label}. Channels: ${(d.channels || []).join(", ")}. ${d.summary || ""}`;
      }
    } catch {
      // dossier optional
    }

    const draft = await this.api.createDraft({
      kind: "meeting_prep",
      title: `Prep pack: ${label}`,
      context_text: stripEmDashesSafe(contextText),
      instructions: "Produce a crisp local-only prep brief: last context, open loops, and 3 sharp openers. Zero em-dashes.",
    });

    return {
      ok: true,
      local_only: true,
      key,
      label,
      draft: draft.draft,
      engine: draft.engine,
    };
  }

  private async executeSnooze(
    req: { id: string; hours: number; until: string },
    localOrigin?: string,
  ): Promise<Record<string, unknown>> {
    if (this.snoozeItemFn) {
      return this.snoozeItemFn(req);
    }

    const g = globalThis as unknown as {
      __kizukiTodayTriage?: {
        snooze: (id: string, hours: number) => Promise<Record<string, unknown>> | Record<string, unknown>;
      };
    };
    if (g.__kizukiTodayTriage && typeof g.__kizukiTodayTriage.snooze === "function") {
      return await g.__kizukiTodayTriage.snooze(req.id, req.hours);
    }

    if (localOrigin && /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(localOrigin)) {
      try {
        const resp = await this.fetchImpl(`${localOrigin}/api/today/triage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: req.id, action: "snooze", hours: req.hours, until: req.until }),
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          return (await resp.json()) as Record<string, unknown>;
        }
      } catch {
        // fall through to local durable JSONL append
      }
    }

    const triagePath = join(this.api.vaultPath, "today-triage.jsonl");
    const dir = dirname(triagePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const entry = {
      id: req.id,
      action: "snooze",
      hours: req.hours,
      until: req.until,
      created_at: new Date().toISOString(),
      source: "command-plane",
    };
    appendFileSync(triagePath, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(triagePath, 0o600);
    } catch {
      // ignore chmod error
    }
    return { ok: true, ...entry };
  }
}
