import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { RouteModuleContext } from "./contracts.ts";
import {
  DEFAULT_FALLBACK_LLM_ENDPOINT,
  DEFAULT_FALLBACK_LLM_MODEL,
  DEFAULT_FALLBACK_LLM_TOKEN_PATH,
  DEFAULT_LLM_ENDPOINT,
  DEFAULT_LLM_MODEL,
  isCoherentLlmAnswer,
} from "./vault-api.ts";

export interface AskHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AskStreamRequest {
  input: string;
  history?: AskHistoryTurn[];
  contextView?: string;
  boardChannel?: string;
  boardThreadId?: string;
  fastOnly?: boolean;
}

export interface AskCitation {
  index: number;
  id: string;
  kind: string;
  title: string;
  snippet: string;
  meta: string;
  targetView: string;
  targetRef: Record<string, string>;
}

export interface AskSuggestedAction {
  id: string;
  kind: "action" | "note" | "codex" | "memt" | "open";
  label: string;
  title: string;
  body?: string;
  domain?: string;
  personKey?: string;
  targetView?: string;
  targetRef?: Record<string, string>;
}

export type QuickCaptureKind = "action" | "note" | "codex" | "memt";

export interface QuickCaptureRequest {
  kind: QuickCaptureKind;
  title: string;
  body?: string;
  domain?: string;
  personKey?: string;
  tags?: string[];
}

export interface QuickCaptureRecord {
  ok: true;
  kind: QuickCaptureKind;
  id: string;
  saved_at: string;
  label: string;
  title: string;
  domain?: string;
  path?: string;
}

export interface SemanticRecallHit {
  id?: string;
  kind?: string;
  title?: string;
  label?: string;
  snippet?: string;
  summary?: string;
  text?: string;
  meta?: string;
  score?: number;
  targetView?: string;
  view?: string;
  targetRef?: Record<string, string>;
  target?: Record<string, string>;
}

export interface SemanticMemoryProvider {
  recall: (
    query: string,
    opts?: { limit?: number },
  ) => Promise<SemanticRecallHit[] | { hits?: SemanticRecallHit[]; items?: SemanticRecallHit[]; results?: SemanticRecallHit[] }> | SemanticRecallHit[] | { hits?: SemanticRecallHit[]; items?: SemanticRecallHit[]; results?: SemanticRecallHit[] };
}

export interface AskStreamLlmOverride {
  primaryEndpoint?: string | null;
  primaryModel?: string;
  fallbackEndpoint?: string | null;
  fallbackModel?: string;
  fallbackTokenPath?: string;
  timeoutMs?: number;
  healthCheckMs?: number;
  fetchImpl?: typeof fetch;
}

declare global {
  var __kizukiSemanticMemory: SemanticMemoryProvider | undefined;
}

export class QuickCaptureError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "QuickCaptureError";
    this.status = status;
  }
}

const VALID_CAPTURE_KINDS = new Set<QuickCaptureKind>(["action", "note", "codex", "memt"]);
const DEFAULT_STREAM_TIMEOUT_MS = 12_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 600;
const SEMANTIC_BUDGET_MS = 14;

const SECRET_RULES: Array<{ label: string; re: RegExp }> = [
  { label: "private key block", re: /-----BEGIN\s+[A-Z0-9\s-]*[P]RIVATE KEY-----/i },
  { label: "OpenAI/Anthropic API key", re: /\bs[k]-(?:proj-|ant-[a-z0-9-]+-)?[A-Za-z0-9_-]{16,}\b/ },
  { label: "GitHub token", re: /\bg[h](?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/ },
  { label: "GitHub fine-grained token", re: /\bgit[h]ub_pat_[A-Za-z0-9_]{22,}\b/ },
  { label: "Slack token", re: /\bx[o]x[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "Google API key", re: /\bAI[z]a[0-9A-Za-z_-]{20,}\b/ },
  { label: "AWS access key", re: /\bA[K]IA[0-9A-Z]{16}\b/ },
  { label: "Bearer JWT/token", re: /\bBearer\s+(?:eyJ[A-Za-z0-9_-]{12,}|[A-Za-z0-9._~+/=-]{24,})\b/i },
  { label: "credential assignment", re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9._+/=-]{16,}["']?/i },
];

export function stripEmDashes(input: string): string {
  if (!input) return "";
  return input
    .replace(/\u2028|\u2029/g, " ")
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2014/g, "-");
}

function cleanLine(raw: unknown, maxLen = 220): string {
  const s = stripEmDashes(String(raw ?? ""))
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(1, maxLen - 3)).trimEnd()}...`;
}

export function detectSecret(text: string): string | null {
  const s = String(text || "");
  if (!s) return null;
  for (const rule of SECRET_RULES) {
    if (rule.re.test(s)) {
      return rule.label;
    }
  }
  return null;
}

/**
 * Stateful streaming filter that strips <think>...</think> blocks even when
 * tags are split across SSE chunks, and strips em-dashes on the fly.
 */
export class StreamingThinkFilter {
  private inThink = false;
  private carry = "";

  push(chunk: string): string {
    if (!chunk) return "";
    let buf = this.carry + chunk;
    this.carry = "";
    let out = "";

    while (buf.length > 0) {
      if (this.inThink) {
        const lower = buf.toLowerCase();
        const endIdx = lower.indexOf("</think>");
        if (endIdx >= 0) {
          buf = buf.slice(endIdx + "</think>".length);
          this.inThink = false;
          continue;
        }
        // Keep trailing partial "</think" match
        const lastLt = buf.lastIndexOf("<");
        if (lastLt >= 0 && buf.length - lastLt < "</think>".length) {
          this.carry = buf.slice(lastLt);
        }
        buf = "";
        break;
      }

      const lower = buf.toLowerCase();
      const startIdx = lower.indexOf("<think>");
      if (startIdx >= 0) {
        out += buf.slice(0, startIdx);
        buf = buf.slice(startIdx + "<think>".length);
        this.inThink = true;
        continue;
      }

      // Hold a possible partial "<think>" prefix at end of chunk
      const lastLt = buf.lastIndexOf("<");
      if (lastLt >= 0) {
        const tail = lower.slice(lastLt);
        if ("<think>".startsWith(tail)) {
          out += buf.slice(0, lastLt);
          this.carry = buf.slice(lastLt);
          buf = "";
          break;
        }
      }

      out += buf;
      buf = "";
    }

    return out.replace(/\u2028|\u2029/g, " ").replace(/\u2014/g, "-");
  }

  flush(): string {
    if (this.inThink) {
      this.carry = "";
      return "";
    }
    const rest = this.carry;
    this.carry = "";
    return rest.replace(/\u2028|\u2029/g, " ").replace(/\u2014/g, "-");
  }
}

interface CandidateCitation {
  priority: number;
  dedupeKey: string;
  id: string;
  kind: string;
  title: string;
  snippet: string;
  meta: string;
  targetView: string;
  targetRef: Record<string, string>;
}

function normalizeSemanticResult(raw: unknown): SemanticRecallHit[] {
  if (Array.isArray(raw)) return raw as SemanticRecallHit[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.hits)) return obj.hits as SemanticRecallHit[];
    if (Array.isArray(obj.items)) return obj.items as SemanticRecallHit[];
    if (Array.isArray(obj.results)) return obj.results as SemanticRecallHit[];
  }
  return [];
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolveDone) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolveDone(null);
      }
    }, ms);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    promise.then(
      (val) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolveDone(val);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolveDone(null);
        }
      },
    );
  });
}

function addOmniGroupCitations(
  omniRes: Record<string, unknown>,
  candidates: CandidateCitation[],
): void {
  const groups = (omniRes.groups && typeof omniRes.groups === "object"
    ? omniRes.groups
    : omniRes) as Record<string, unknown>;

  const push = (c: CandidateCitation) => {
    if (!c.title) return;
    candidates.push(c);
  };

  if (Array.isArray(groups.people)) {
    for (const raw of groups.people.slice(0, 4)) {
      const p = raw as Record<string, unknown>;
      const key = String(p.key || p.id || p.name || "").trim();
      const name = cleanLine(p.name || p.display_name || key, 80);
      const channels = Array.isArray(p.channels) ? p.channels.join("/") : "";
      const role = cleanLine(p.role || p.company || p.tier || "", 60);
      const snippet = cleanLine(p.latest_snippet || p.summary || p.relationship_note || role || "Person dossier", 180);
      push({
        priority: 92,
        dedupeKey: `person:${key.toLowerCase() || name.toLowerCase()}`,
        id: `person:${key || name}`,
        kind: "person",
        title: name,
        snippet,
        meta: [role, channels].filter(Boolean).join(" | ") || "People Dossier",
        targetView: "people",
        targetRef: key ? { personKey: key } : { view: "people" },
      });
    }
  }

  if (Array.isArray(groups.board)) {
    for (const raw of groups.board.slice(0, 4)) {
      const b = raw as Record<string, unknown>;
      const tid = String(b.id || b.target || "").trim();
      const channel = String(b.channel || "box").trim();
      const title = cleanLine(b.title || `Thread #${tid}`, 90);
      const snippet = cleanLine(b.snippet || b.text || "", 180);
      const metaParts = [`#${channel}`];
      if (b.by) metaParts.push(String(b.by));
      if (b.isBlocked) metaParts.push("blocked");
      push({
        priority: b.isBlocked ? 95 : 88,
        dedupeKey: `board:${tid}`,
        id: `board:${tid}`,
        kind: "board",
        title,
        snippet: snippet || title,
        meta: metaParts.join(" | "),
        targetView: "board",
        targetRef: { threadId: tid, channel },
      });
    }
  }

  if (Array.isArray(groups.codex)) {
    for (const raw of groups.codex.slice(0, 4)) {
      const c = raw as Record<string, unknown>;
      const id = String(c.id || "").trim();
      const title = cleanLine(c.title || id, 90);
      const section = String(c.section || "ideas");
      const domain = String(c.domain || "general");
      push({
        priority: 86,
        dedupeKey: `codex:${id || title.toLowerCase()}`,
        id: `codex:${id || title}`,
        kind: "codex",
        title,
        snippet: cleanLine(c.subtitle || c.summary || c.thesis || title, 180),
        meta: `${section} | ${domain}`,
        targetView: "codex",
        targetRef: id ? { itemId: id, section } : { view: "codex", section },
      });
    }
  }

  if (Array.isArray(groups.inbox)) {
    for (const raw of groups.inbox.slice(0, 3)) {
      const m = raw as Record<string, unknown>;
      const id = String(m.id || m.thread_id || m.sender || "").trim();
      const sender = cleanLine(m.sender || m.from || "Message", 70);
      const threadTitle = cleanLine(m.thread_title || m.subject || sender, 90);
      const preview = cleanLine(m.preview || m.snippet || m.text || "", 180);
      const ch = cleanLine(m.channel_label || m.channel || "Inbox", 40);
      const personKey = String(m.person_key || m.personKey || "").trim();
      push({
        priority: 85,
        dedupeKey: `inbox:${id || threadTitle.toLowerCase()}`,
        id: `inbox:${id || sender}`,
        kind: "inbox",
        title: sender !== threadTitle ? `${sender}: ${threadTitle}` : threadTitle,
        snippet: preview || threadTitle,
        meta: ch,
        targetView: personKey ? "people" : "today",
        targetRef: personKey ? { personKey } : { view: "today" },
      });
    }
  }

  if (Array.isArray(groups.calendar)) {
    for (const raw of groups.calendar.slice(0, 3)) {
      const ev = raw as Record<string, unknown>;
      const id = String(ev.id || ev.title || "").trim();
      const title = cleanLine(ev.title || "Calendar Event", 90);
      const start = cleanLine(ev.start || ev.countdown || "", 40);
      const cal = cleanLine(ev.calendar || "Calendar", 40);
      push({
        priority: 84,
        dedupeKey: `calendar:${id || title.toLowerCase()}`,
        id: `calendar:${id || title}`,
        kind: "calendar",
        title,
        snippet: cleanLine(ev.notes || ev.body || `${start} (${cal})`, 180),
        meta: [cal, start].filter(Boolean).join(" | "),
        targetView: "today",
        targetRef: { view: "today" },
      });
    }
  }

  if (Array.isArray(groups.docs)) {
    for (const raw of groups.docs.slice(0, 3)) {
      const d = raw as Record<string, unknown>;
      const docPath = String(d.path || d.rel_path || d.id || "").trim();
      const title = cleanLine(d.title || docPath || "Vault Doc", 90);
      const snippet = cleanLine(d.snippet || d.excerpt || d.summary || docPath, 180);
      const category = cleanLine(d.category || d.source || "vault", 40);
      push({
        priority: 82,
        dedupeKey: `doc:${docPath.toLowerCase() || title.toLowerCase()}`,
        id: `doc:${docPath || title}`,
        kind: "doc",
        title,
        snippet,
        meta: category,
        targetView: "vault",
        targetRef: docPath ? { docPath } : { view: "vault" },
      });
    }
  }

  if (Array.isArray(groups.memt)) {
    for (const raw of groups.memt.slice(0, 3)) {
      const m = raw as Record<string, unknown>;
      const id = String(m.id || m.experience_id || "").trim();
      const domain = cleanLine(m.domain || "general", 40);
      const title = cleanLine(m.condition || m.title || m.recommendation || "MemT Recipe", 90);
      const snippet = cleanLine(m.recommendation || m.summary || title, 180);
      push({
        priority: 83,
        dedupeKey: `memt:${id || title.toLowerCase()}`,
        id: `memt:${id || title}`,
        kind: "memt",
        title,
        snippet,
        meta: `MemT | ${domain}`,
        targetView: "memt",
        targetRef: { view: "memt" },
      });
    }
  }

  if (Array.isArray(groups.taste)) {
    for (const raw of groups.taste.slice(0, 3)) {
      const t = raw as Record<string, unknown>;
      const id = String(t.id || "").trim();
      const domain = cleanLine(t.domain || "design", 40);
      const polarity = cleanLine(t.polarity || "prefer", 20);
      const title = cleanLine(t.rule || t.title || "Taste Rule", 90);
      push({
        priority: 81,
        dedupeKey: `taste:${id || title.toLowerCase()}`,
        id: `taste:${id || title}`,
        kind: "taste",
        title,
        snippet: cleanLine(t.reason || title, 180),
        meta: `Taste ${polarity} | ${domain}`,
        targetView: "taste",
        targetRef: { view: "taste", domain },
      });
    }
  }

  if (Array.isArray(groups.nodes)) {
    for (const raw of groups.nodes.slice(0, 3)) {
      const n = raw as Record<string, unknown>;
      const id = String(n.id || n.handle_id || "").trim();
      const title = cleanLine(n.label || n.title || id, 90);
      const kind = cleanLine(n.kind || "concept", 32);
      push({
        priority: 79,
        dedupeKey: `node:${id || title.toLowerCase()}`,
        id: `node:${id || title}`,
        kind: "node",
        title,
        snippet: cleanLine(n.summary || title, 180),
        meta: `Graph ${kind}`,
        targetView: "graph",
        targetRef: id ? { nodeId: id } : { view: "graph" },
      });
    }
  }
}

export async function gatherGroundedEvidence(
  ctx: RouteModuleContext,
  req: AskStreamRequest,
): Promise<{ citations: AskCitation[]; contextLines: string[]; sourcesUsed: string[] }> {
  const q = cleanLine(req.input, 400);
  const candidates: CandidateCitation[] = [];
  const contextLines: string[] = [];
  const sourcesUsed: string[] = [];

  // 1. In-memory OmniIndex (sub-5ms when warm)
  const omni = (globalThis as unknown as {
    __kizukiOmniIndex?: {
      isReady?: () => boolean;
      search: (query: string, limit?: number) => Record<string, unknown> | Promise<Record<string, unknown>>;
    };
  }).__kizukiOmniIndex;

  let omniHitCount = 0;
  if (omni && typeof omni.search === "function") {
    try {
      const ready = typeof omni.isReady === "function" ? omni.isReady() : true;
      if (ready) {
        const res = await withTimeout(Promise.resolve(omni.search(q, 5)), 12);
        if (res && typeof res === "object") {
          const before = candidates.length;
          addOmniGroupCitations(res, candidates);
          omniHitCount = candidates.length - before;
          if (omniHitCount > 0) sourcesUsed.push("omni");
        }
      }
    } catch {
      // fail-soft
    }
  }

  // 2. Neural semantic memory recall (if loaded, strict budget so TTFE stays <25ms)
  const sem = globalThis.__kizukiSemanticMemory;
  if (sem && typeof sem.recall === "function") {
    try {
      const rawSem = await withTimeout(Promise.resolve(sem.recall(q, { limit: 6 })), SEMANTIC_BUDGET_MS);
      const hits = normalizeSemanticResult(rawSem);
      if (hits.length > 0) {
        sourcesUsed.push("semantic");
        for (let i = 0; i < hits.length && i < 6; i += 1) {
          const h = hits[i];
          const kind = cleanLine(h.kind || "memory", 32).toLowerCase();
          const id = String(h.id || `sem:${i}`).trim();
          const title = cleanLine(h.title || h.label || id, 90);
          const snippet = cleanLine(h.snippet || h.summary || h.text || title, 180);
          const scoreStr = typeof h.score === "number" ? `sim ${h.score.toFixed(2)}` : "semantic";
          const targetView = String(h.targetView || h.view || (kind === "person" ? "people" : kind === "codex" ? "codex" : kind === "board" ? "board" : kind === "doc" ? "vault" : "today"));
          const targetRef =
            h.targetRef && typeof h.targetRef === "object"
              ? h.targetRef
              : h.target && typeof h.target === "object"
                ? h.target
                : { view: targetView };
          candidates.push({
            priority: 94 - i,
            dedupeKey: `${kind}:${id.toLowerCase()}`,
            id: id.includes(":") ? id : `sem:${id}`,
            kind,
            title,
            snippet,
            meta: cleanLine(h.meta || scoreStr, 70),
            targetView,
            targetRef,
          });
        }
      }
    } catch {
      // fail-soft
    }
  }

  // 3. Agent Board grounded context (bounded SQLite query, ~1-3ms)
  try {
    const boardCtx = ctx.boardBridge.getAskContext(q, {
      channel: req.boardChannel,
      threadId: req.boardThreadId,
    });
    if (boardCtx.lines.length > 0) {
      contextLines.push(...boardCtx.lines.slice(0, 6));
    }
    if (boardCtx.citations.length > 0) {
      sourcesUsed.push("board");
      for (const c of boardCtx.citations.slice(0, 5)) {
        const tid = String(c.id);
        candidates.push({
          priority: req.boardThreadId && String(req.boardThreadId) === tid ? 99 : c.isBlocked ? 93 : 87,
          dedupeKey: `board:${tid}`,
          id: `board:${tid}`,
          kind: "board",
          title: cleanLine(c.title || `Thread #${tid}`, 90),
          snippet: cleanLine(c.snippet || c.title, 180),
          meta: `#${c.channel} | ${c.by}${c.isBlocked ? " | blocked" : ""}`,
          targetView: "board",
          targetRef: { threadId: tid, channel: c.channel },
        });
      }
    }
  } catch {
    // fail-soft
  }

  // 4. Cold-start fast supplement if OmniIndex was unavailable or yielded nothing
  if (omniHitCount === 0) {
    try {
      const codexHits = ctx.codexApi.searchForOmni(q, 4);
      if (codexHits.length > 0) {
        sourcesUsed.push("codex");
        for (const c of codexHits) {
          candidates.push({
            priority: 86,
            dedupeKey: `codex:${c.id}`,
            id: `codex:${c.id}`,
            kind: "codex",
            title: cleanLine(c.title, 90),
            snippet: cleanLine(c.subtitle || c.title, 180),
            meta: `${c.section} | ${c.domain}`,
            targetView: "codex",
            targetRef: { itemId: c.id, section: c.section },
          });
        }
      }
    } catch {
      // fail-soft
    }
  }

  // 5. Local quick captures fast match (makes recently captured notes/memt immediately retrievable)
  try {
    const recent = readQuickCapturesFile(ctx.api.vaultPath, 24);
    const qTerms = q
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length >= 3);
    if (recent.length > 0 && qTerms.length > 0) {
      for (const item of recent) {
        const hay = `${item.title} ${item.label} ${item.domain || ""}`.toLowerCase();
        if (qTerms.some((t) => hay.includes(t))) {
          candidates.push({
            priority: 80,
            dedupeKey: `capture:${item.id}`,
            id: `capture:${item.id}`,
            kind: item.kind,
            title: cleanLine(item.title, 90),
            snippet: cleanLine(item.label, 180),
            meta: `Captured ${item.kind}${item.domain ? ` | ${item.domain}` : ""}`,
            targetView: item.kind === "codex" ? "codex" : item.kind === "memt" ? "memt" : item.kind === "note" ? "vault" : "today",
            targetRef: item.path ? { docPath: item.path } : { view: item.kind === "codex" ? "codex" : "today" },
          });
        }
      }
    }
  } catch {
    // fail-soft
  }

  // Deduplicate & sort descending by priority
  candidates.sort((a, b) => b.priority - a.priority);
  const seen = new Set<string>();
  const citations: AskCitation[] = [];

  for (const c of candidates) {
    if (citations.length >= 10) break;
    if (seen.has(c.dedupeKey)) continue;
    seen.add(c.dedupeKey);
    const idx = citations.length + 1;
    citations.push({
      index: idx,
      id: c.id,
      kind: c.kind,
      title: c.title,
      snippet: c.snippet,
      meta: c.meta,
      targetView: c.targetView,
      targetRef: c.targetRef,
    });
  }

  return { citations, contextLines, sourcesUsed };
}

export function buildDeterministicSynthesis(
  query: string,
  citations: AskCitation[],
  contextLines: string[],
  fallbackNote?: string,
): string {
  const cleanQ = cleanLine(query, 180);
  if (citations.length === 0) {
    const lines = [
      `### Grounded Read: ${cleanQ}`,
      "",
      "No matching local records were found across OmniIndex, Semantic Memory, Codex, or Agent Board for this query yet.",
      "- Try a specific person name, project codename, or `#channel` term.",
      "- Use **Quick Capture** (`Alt+N`) to anchor a new action, note, Codex idea, or MemT lesson directly into your local vault.",
    ];
    if (fallbackNote) {
      lines.push("", `> Mode: local evidence synthesis (${cleanLine(fallbackNote, 120)}).`);
    }
    return stripEmDashes(lines.join("\n"));
  }

  const lines: string[] = [`### Grounded Read: ${cleanQ}`, ""];
  const top = citations.slice(0, 6);
  lines.push(
    `Found **${citations.length}** grounded local ${citations.length === 1 ? "signal" : "signals"} across ${Array.from(new Set(citations.map((c) => c.kind))).join(", ")}.`,
    "",
  );

  for (const c of top) {
    const metaSuffix = c.meta ? ` (${c.meta})` : "";
    lines.push(`- **[${c.index}] ${c.title}**${metaSuffix}: ${c.snippet}`);
  }

  if (citations.length > 6) {
    const refs = citations
      .slice(6)
      .map((c) => `[${c.index}] ${c.title}`)
      .join(", ");
    lines.push("", `Additional supporting references: ${refs}.`);
  }

  if (contextLines.length > 0) {
    lines.push("", "#### Live Board Signals");
    for (const ln of contextLines.slice(0, 3)) {
      lines.push(`- ${cleanLine(ln, 180)}`);
    }
  }

  if (fallbackNote) {
    lines.push("", `> Grounded local synthesis (${cleanLine(fallbackNote, 120)}).`);
  }

  return stripEmDashes(lines.join("\n"));
}

export function deriveSuggestedActions(
  query: string,
  citations: AskCitation[],
): AskSuggestedAction[] {
  const cleanQ = cleanLine(query, 90);
  const topCitation = citations[0];
  const topDomain =
    (topCitation?.meta || "")
      .split("|")
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("#") && !s.startsWith("sim ") && s.toLowerCase() !== "blocked") ||
    "general";
  const citationSummary = citations
    .slice(0, 3)
    .map((c) => `[${c.index}] ${c.title}`)
    .join("; ");

  const actions: AskSuggestedAction[] = [
    {
      id: "suggest-action",
      kind: "action",
      label: "Save Action",
      title: cleanLine(topCitation ? `Follow up: ${topCitation.title}` : `Follow up: ${cleanQ}`, 110),
      body: citationSummary ? `From Instant Ask ("${cleanQ}"): ${citationSummary}` : `From Instant Ask: ${cleanQ}`,
      domain: topDomain,
    },
    {
      id: "suggest-codex",
      kind: "codex",
      label: "Pin to Codex",
      title: cleanLine(topCitation ? topCitation.title : cleanQ, 100),
      body: citationSummary ? `${cleanQ} | Refs: ${citationSummary}` : cleanQ,
      domain: topDomain,
    },
    {
      id: "suggest-memt",
      kind: "memt",
      label: "Save MemT Lesson",
      title: cleanLine(`Lesson: ${cleanQ}`, 110),
      body: citationSummary || cleanQ,
      domain: topDomain,
    },
  ];

  const personCit = citations.find((c) => c.kind === "person" && c.targetRef.personKey);
  if (personCit) {
    actions.push({
      id: `suggest-open-${personCit.targetRef.personKey}`,
      kind: "open",
      label: `Open ${cleanLine(personCit.title, 28)}`,
      title: personCit.title,
      personKey: personCit.targetRef.personKey,
      targetView: "people",
      targetRef: personCit.targetRef,
    });
  } else {
    actions.push({
      id: "suggest-note",
      kind: "note",
      label: "Save Note",
      title: cleanLine(`Note: ${cleanQ}`, 100),
      body: citationSummary ? `Query: ${cleanQ}\n\nReferences:\n${citations.slice(0, 5).map((c) => `- [${c.index}] ${c.title}: ${c.snippet}`).join("\n")}` : cleanQ,
      domain: topDomain,
    });
  }

  return actions;
}

function buildLlmMessages(
  req: AskStreamRequest,
  citations: AskCitation[],
  contextLines: string[],
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const citationBlock =
    citations.length > 0
      ? citations
          .map((c) => `[${c.index}] (${c.kind}) ${c.title} [${c.meta}]: ${c.snippet}`)
          .join("\n")
      : "(No local citations matched.)";

  const extraBoard =
    contextLines.length > 0 ? `\n\nLive Board Context:\n${contextLines.slice(0, 5).join("\n")}` : "";

  const systemPrompt = [
    "You are Kizuki Mind OS answering the vault owner directly from their grounded local vault.",
    "Cite supporting evidence inline with bracketed numbers like [1], [2] matching the numbered list below.",
    "Be terse, concrete, and high-signal. Never invent facts outside the evidence. Never use em-dashes.",
    req.contextView ? `Active workspace view: ${cleanLine(req.contextView, 40)}.` : "",
    "",
    "Grounded Evidence:",
    citationBlock + extraBoard,
  ]
    .filter(Boolean)
    .join("\n");

  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    { role: "system", content: systemPrompt },
  ];

  if (Array.isArray(req.history)) {
    for (const turn of req.history.slice(-6)) {
      if (!turn || (turn.role !== "user" && turn.role !== "assistant")) continue;
      const content = cleanLine(turn.content, 600);
      if (content) {
        messages.push({ role: turn.role, content });
      }
    }
  }

  messages.push({ role: "user", content: cleanLine(req.input, 1200) });
  return messages;
}

function resolveLlmConfig(ctx: RouteModuleContext, override?: AskStreamLlmOverride) {
  const apiAny = ctx.api as unknown as Record<string, unknown>;
  const primaryEndpoint =
    override?.primaryEndpoint !== undefined
      ? override.primaryEndpoint
      : typeof apiAny.llmEndpoint === "string"
        ? apiAny.llmEndpoint
        : DEFAULT_LLM_ENDPOINT;
  const primaryModel =
    override?.primaryModel ||
    (typeof apiAny.llmModel === "string" ? apiAny.llmModel : DEFAULT_LLM_MODEL);
  const fallbackEndpoint =
    override?.fallbackEndpoint !== undefined
      ? override.fallbackEndpoint
      : typeof apiAny.fallbackLlmEndpoint === "string"
        ? apiAny.fallbackLlmEndpoint
        : apiAny.fallbackLlmEndpoint === null
          ? null
          : DEFAULT_FALLBACK_LLM_ENDPOINT;
  const fallbackModel =
    override?.fallbackModel ||
    (typeof apiAny.fallbackLlmModel === "string" ? apiAny.fallbackLlmModel : DEFAULT_FALLBACK_LLM_MODEL);
  const fallbackTokenPath =
    override?.fallbackTokenPath ||
    (typeof apiAny.fallbackLlmTokenPath === "string" ? apiAny.fallbackLlmTokenPath : DEFAULT_FALLBACK_LLM_TOKEN_PATH);

  return {
    primaryEndpoint,
    primaryModel,
    fallbackEndpoint,
    fallbackModel,
    fallbackTokenPath,
    timeoutMs: override?.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS,
    healthCheckMs: override?.healthCheckMs ?? DEFAULT_HEALTH_TIMEOUT_MS,
    fetchImpl: override?.fetchImpl ?? fetch,
  };
}

function readTokenSilent(tokenPath: string): string | null {
  try {
    if (!tokenPath || !existsSync(tokenPath)) return null;
    const raw = readFileSync(tokenPath, "utf8").trim();
    return raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

async function tryStreamFromUpstream(opts: {
  endpoint: string;
  model: string;
  headers: Record<string, string>;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  promptForCoherence: string;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  useTopP: boolean;
  onDelta: (text: string) => void;
  externalSignal?: AbortSignal;
}): Promise<{ ok: true; text: string; emittedCount: number } | { ok: false; reason: string; emittedCount: number }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, opts.timeoutMs);
  if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
    (timer as unknown as { unref: () => void }).unref();
  }

  const onExternalAbort = () => controller.abort();
  if (opts.externalSignal) {
    if (opts.externalSignal.aborted) {
      clearTimeout(timer);
      return { ok: false, reason: "client disconnected", emittedCount: 0 };
    }
    opts.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let emittedCount = 0;
  let accumulated = "";

  try {
    const payload: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      max_tokens: 900,
      temperature: 0.25,
      stream: true,
    };
    if (opts.useTopP) {
      payload.top_p = 0.95;
      payload.reasoning_effort = "low";
    }

    const resp = await opts.fetchImpl(opts.endpoint, {
      method: "POST",
      headers: opts.headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!resp.ok) {
      return { ok: false, reason: `HTTP ${resp.status}`, emittedCount: 0 };
    }

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();

    // Support non-streaming JSON fallback if an endpoint ignores stream: true
    if (contentType.includes("application/json")) {
      const data = (await resp.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const raw = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
      const filter = new StreamingThinkFilter();
      const cleaned = (filter.push(raw) + filter.flush()).trim();
      const check = isCoherentLlmAnswer(cleaned, opts.promptForCoherence);
      if (!check.ok) {
        return { ok: false, reason: check.reason || "coherence check failed", emittedCount: 0 };
      }
      opts.onDelta(cleaned);
      return { ok: true, text: cleaned, emittedCount: 1 };
    }

    if (!resp.body) {
      return { ok: false, reason: "empty stream body", emittedCount: 0 };
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    const thinkFilter = new StreamingThinkFilter();
    let lineBuffer = "";
    const promptLatinOnly = !/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\uAC00-\uD7AF\u0900-\u097F]/.test(
      opts.promptForCoherence,
    );

    const emitSafe = (deltaText: string): boolean => {
      if (!deltaText) return true;
      if (deltaText.includes("\uFFFD")) {
        return false;
      }
      if (promptLatinOnly) {
        const foreign = deltaText.match(/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\uAC00-\uD7AF\u0900-\u097F]/g);
        if (foreign && foreign.length >= 2) {
          return false;
        }
      }
      accumulated += deltaText;
      emittedCount += 1;
      opts.onDelta(deltaText);
      return true;
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });

      let nlIdx = lineBuffer.indexOf("\n");
      while (nlIdx >= 0) {
        const rawLine = lineBuffer.slice(0, nlIdx).trim();
        lineBuffer = lineBuffer.slice(nlIdx + 1);
        nlIdx = lineBuffer.indexOf("\n");

        if (!rawLine.startsWith("data:")) continue;
        const dataStr = rawLine.slice(5).trim();
        if (!dataStr || dataStr === "[DONE]") continue;

        let parsed: {
          choices?: Array<{
            delta?: { content?: string | null };
            message?: { content?: string | null };
          }>;
        };
        try {
          parsed = JSON.parse(dataStr) as typeof parsed;
        } catch {
          continue;
        }

        const token =
          typeof parsed.choices?.[0]?.delta?.content === "string"
            ? parsed.choices[0].delta.content
            : typeof parsed.choices?.[0]?.message?.content === "string"
              ? parsed.choices[0].message.content
              : "";
        if (!token) continue;

        const cleanDelta = thinkFilter.push(token);
        if (!emitSafe(cleanDelta)) {
          try {
            await reader.cancel();
          } catch {
            // ignore
          }
          return { ok: false, reason: "coherence guard rejected stream", emittedCount };
        }
      }
    }

    const tail = thinkFilter.flush();
    if (tail) {
      if (!emitSafe(tail)) {
        return { ok: false, reason: "coherence guard rejected stream tail", emittedCount };
      }
    }

    const trimmed = accumulated.trim();
    const coherence = isCoherentLlmAnswer(trimmed, opts.promptForCoherence);
    if (!coherence.ok) {
      return { ok: false, reason: coherence.reason || "coherence check failed", emittedCount };
    }

    return { ok: true, text: trimmed, emittedCount };
  } catch (err) {
    const reason = timedOut ? "upstream timed out" : err instanceof Error ? err.message : "upstream error";
    return { ok: false, reason: cleanLine(reason, 120), emittedCount };
  } finally {
    clearTimeout(timer);
    if (opts.externalSignal) {
      opts.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

function encodeSseEvent(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

export function createAskStreamResponse(
  ctx: RouteModuleContext,
  req: AskStreamRequest,
  opts?: { llm?: AskStreamLlmOverride; signal?: AbortSignal },
): Response {
  const startedAt = performance.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const pushEvent = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseEvent(event, data));
        } catch {
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      try {
        // Phase 1: Instant Grounded Evidence (<25ms TTFE target)
        const { citations, contextLines, sourcesUsed } = await gatherGroundedEvidence(ctx, req);
        const firstEvidenceMs = Math.max(0.1, Math.round((performance.now() - startedAt) * 10) / 10);

        pushEvent("evidence", {
          query: cleanLine(req.input, 400),
          first_evidence_ms: firstEvidenceMs,
          sources: sourcesUsed,
          citations,
        });

        // Phase 2: Live Token Streaming Synthesis (or deterministic <5ms synthesis)
        let mode: "stream" | "fast" | "fallback" = "fast";
        let engine = "Vault Grounded";
        let streamedSuccessfully = false;
        let emittedUpstreamTokens = false;
        let fallbackReason = "";

        if (!req.fastOnly) {
          const llmCfg = resolveLlmConfig(ctx, opts?.llm);
          const messages = buildLlmMessages(req, citations, contextLines);

          // Try Primary Engine (with fast /health preflight when targeting default :8003)
          if (llmCfg.primaryEndpoint) {
            let primaryHealthy = true;
            if (llmCfg.primaryEndpoint === DEFAULT_LLM_ENDPOINT && llmCfg.healthCheckMs > 0) {
              try {
                const healthUrl = llmCfg.primaryEndpoint.replace(/\/v1\/chat\/completions\/?$/, "/health");
                const hResp = await llmCfg.fetchImpl(healthUrl, {
                  signal: AbortSignal.timeout(llmCfg.healthCheckMs),
                });
                if (!hResp.ok) {
                  primaryHealthy = false;
                  fallbackReason = `primary health HTTP ${hResp.status}`;
                }
              } catch {
                primaryHealthy = false;
                fallbackReason = "primary tunnel unreachable";
              }
            }

            if (primaryHealthy) {
              const res = await tryStreamFromUpstream({
                endpoint: llmCfg.primaryEndpoint,
                model: llmCfg.primaryModel,
                headers: { "Content-Type": "application/json" },
                messages,
                promptForCoherence: req.input,
                timeoutMs: llmCfg.timeoutMs,
                fetchImpl: llmCfg.fetchImpl,
                useTopP: true,
                externalSignal: opts?.signal,
                onDelta: (text) => {
                  emittedUpstreamTokens = true;
                  pushEvent("delta", { text });
                },
              });
              if (res.ok) {
                streamedSuccessfully = true;
                mode = "stream";
                engine = "Local LLM (Live)";
              } else {
                fallbackReason = res.reason;
              }
            }
          }

          // Try Fallback Engine only if nothing was streamed yet
          if (!streamedSuccessfully && !emittedUpstreamTokens && llmCfg.fallbackEndpoint) {
            const token = readTokenSilent(llmCfg.fallbackTokenPath);
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            if (token) headers["Authorization"] = `Bearer ${token}`;

            const res = await tryStreamFromUpstream({
              endpoint: llmCfg.fallbackEndpoint,
              model: llmCfg.fallbackModel,
              headers,
              messages,
              promptForCoherence: req.input,
              timeoutMs: llmCfg.timeoutMs,
              fetchImpl: llmCfg.fetchImpl,
              useTopP: false,
              externalSignal: opts?.signal,
              onDelta: (text) => {
                emittedUpstreamTokens = true;
                pushEvent("delta", { text });
              },
            });
            if (res.ok) {
              streamedSuccessfully = true;
              mode = "stream";
              engine = "MiniMax M2.7 (Live)";
            } else if (!fallbackReason) {
              fallbackReason = res.reason;
            }
          }
        }

        // Deterministic synthesis path (fastOnly OR fail-soft when upstream unreachable/timed out)
        if (!streamedSuccessfully) {
          mode = req.fastOnly ? "fast" : "fallback";
          engine = req.fastOnly ? "Instant Evidence" : "Grounded Fallback";
          const deterministicText = buildDeterministicSynthesis(
            req.input,
            citations,
            contextLines,
            req.fastOnly ? undefined : fallbackReason || "live engine offline",
          );
          const prefix = emittedUpstreamTokens ? "\n\n---\n\n" : "";
          const fullText = prefix + deterministicText;
          // Emit in crisp markdown line groups so client sees immediate progressive deltas
          const lines = fullText.split("\n");
          for (let i = 0; i < lines.length; i += 3) {
            const chunk = lines.slice(i, i + 3).join("\n") + (i + 3 < lines.length ? "\n" : "");
            if (chunk) pushEvent("delta", { text: chunk });
          }
        }

        // Phase 3: Done + concrete local suggested actions
        const suggestedActions = deriveSuggestedActions(req.input, citations);
        const elapsedMs = Math.max(0.1, Math.round((performance.now() - startedAt) * 10) / 10);

        pushEvent("done", {
          ok: true,
          elapsed_ms: elapsedMs,
          first_evidence_ms: firstEvidenceMs,
          mode,
          engine,
          citations,
          suggested_actions: suggestedActions,
        });
      } catch (err) {
        const elapsedMs = Math.max(0.1, Math.round((performance.now() - startedAt) * 10) / 10);
        pushEvent("done", {
          ok: false,
          elapsed_ms: elapsedMs,
          first_evidence_ms: elapsedMs,
          mode: "fallback",
          engine: "Error",
          error: cleanLine(err instanceof Error ? err.message : String(err), 180),
          citations: [],
          suggested_actions: [],
        });
      } finally {
        finish();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}

// ============================================================================
// Instant Local Quick Capture (100% local only, 0600 atomic writes)
// ============================================================================

function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  }
}

function writeFileAtomic0600(targetPath: string, content: string): void {
  ensureDir(dirname(targetPath));
  const tmpPath = `${targetPath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmpPath, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmpPath, 0o600);
  renameSync(tmpPath, targetPath);
  chmodSync(targetPath, 0o600);
}

function appendJsonlAtomic0600(targetPath: string, record: Record<string, unknown>, maxLines = 400): void {
  ensureDir(dirname(targetPath));
  let lines: string[] = [];
  if (existsSync(targetPath)) {
    try {
      lines = readFileSync(targetPath, "utf8")
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      lines = [];
    }
  }
  lines.push(JSON.stringify(record));
  if (lines.length > maxLines) {
    lines = lines.slice(-maxLines);
  }
  writeFileAtomic0600(targetPath, `${lines.join("\n")}\n`);
}

function sanitizeSlug(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "note";
}

function ownerNotesDir(vaultPath: string): string {
  return resolve(vaultPath, "owner-notes");
}

function assertPathContained(baseDir: string, candidatePath: string): string {
  const resolvedBase = resolve(baseDir);
  const resolvedCandidate = resolve(candidatePath);
  if (
    resolvedCandidate !== resolvedBase &&
    !resolvedCandidate.startsWith(resolvedBase + sep)
  ) {
    throw new QuickCaptureError(400, "Invalid capture file path");
  }
  return resolvedCandidate;
}

function readQuickCapturesFile(vaultPath: string, limit = 12): QuickCaptureRecord[] {
  const logPath = join(ownerNotesDir(vaultPath), "quick-captures.jsonl");
  if (!existsSync(logPath)) return [];
  try {
    const raw = readFileSync(logPath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const out: QuickCaptureRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]) as QuickCaptureRecord;
        if (parsed && typeof parsed === "object" && parsed.id && parsed.kind) {
          out.push(parsed);
        }
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function getRecentQuickCaptures(vaultPath: string, limit = 12): QuickCaptureRecord[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 12)));
  return readQuickCapturesFile(vaultPath, safeLimit);
}

export async function saveQuickCapture(
  ctx: RouteModuleContext,
  rawReq: QuickCaptureRequest,
): Promise<QuickCaptureRecord> {
  if (!rawReq || typeof rawReq !== "object") {
    throw new QuickCaptureError(400, "Request body must be a JSON object");
  }

  const kind = String(rawReq.kind || "").trim().toLowerCase() as QuickCaptureKind;
  if (!VALID_CAPTURE_KINDS.has(kind)) {
    throw new QuickCaptureError(400, "kind must be one of: action, note, codex, memt");
  }

  const rawTitle = String(rawReq.title || "").trim();
  const rawBody = typeof rawReq.body === "string" ? rawReq.body.trim() : "";
  const rawDomain = typeof rawReq.domain === "string" ? rawReq.domain.trim() : "";
  const rawPersonKey = typeof rawReq.personKey === "string" ? rawReq.personKey.trim() : "";
  const rawTags = Array.isArray(rawReq.tags)
    ? rawReq.tags.map((t) => String(t || "").trim()).filter(Boolean).slice(0, 12)
    : [];

  if (!rawTitle) {
    throw new QuickCaptureError(400, "title is required");
  }

  // Secret-redaction guard across every incoming field (zero secret persistence)
  const combinedForScan = [rawTitle, rawBody, rawDomain, rawPersonKey, ...rawTags].join("\n");
  const secretHit = detectSecret(combinedForScan);
  if (secretHit) {
    throw new QuickCaptureError(400, `Secret detected (${secretHit}): local capture blocked`);
  }

  const title = cleanLine(rawTitle, 160);
  const body = stripEmDashes(rawBody).slice(0, 6000);
  const domain = cleanLine(rawDomain || "general", 48).toLowerCase() || "general";
  const personKey = cleanLine(rawPersonKey, 80);
  const tags = rawTags.map((t) => cleanLine(t, 40)).filter(Boolean);
  const savedAt = new Date().toISOString();
  const vaultPath = ctx.api.vaultPath;

  let record: QuickCaptureRecord;

  if (kind === "action") {
    const tagMap: Record<string, string> = {
      family: "Family",
      reply: "Reply",
      personal: "Personal",
      work: "Work",
    };
    const actionTag = tagMap[domain] || "Work";
    const detail = [body, personKey ? `Person: ${personKey}` : "", tags.length ? `Tags: ${tags.join(", ")}` : ""]
      .filter(Boolean)
      .join(" | ");
    const res = await ctx.api.mutateActions({
      op: "add",
      title,
      detail,
      tag: actionTag,
      source: "quick-capture",
    });
    // Ensure owner-actions.json is locked 0600
    const actionsFile = join(vaultPath, "owner-actions.json");
    if (existsSync(actionsFile)) {
      try {
        chmodSync(actionsFile, 0o600);
      } catch {
        // ignore if custom actionsPath
      }
    }
    const created = res.actions[0];
    const id = created?.id || `act_${randomUUID().slice(0, 8)}`;
    record = {
      ok: true,
      kind: "action",
      id,
      saved_at: savedAt,
      label: `Action: ${title}`,
      title,
      domain,
    };
  } else if (kind === "codex") {
    const upserted = ctx.codexApi.upsertItem({
      section: "ideas",
      title,
      summary: body || title,
      domain,
      tags,
      linked_people: personKey ? [personKey] : [],
      pinned: true,
    });
    record = {
      ok: true,
      kind: "codex",
      id: upserted.item.id,
      saved_at: savedAt,
      label: `Codex: ${upserted.item.title}`,
      title: upserted.item.title,
      domain: upserted.item.domain,
    };
  } else if (kind === "note") {
    const notesDir = ownerNotesDir(vaultPath);
    ensureDir(notesDir);
    const tsCompact = savedAt.replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
    const slug = sanitizeSlug(title);
    const fileName = `capture-${tsCompact}-${slug}.md`;
    const fullPath = assertPathContained(notesDir, join(notesDir, fileName));
    const relPath = `owner-notes/${fileName}`;
    const frontmatterLines = [
      "---",
      `title: "${title.replace(/"/g, "'")}"`,
      `captured_at: "${savedAt}"`,
      `domain: "${domain}"`,
      personKey ? `person: "${personKey.replace(/"/g, "'")}"` : "",
      tags.length > 0 ? `tags: [${tags.map((t) => `"${t.replace(/"/g, "'")}"`).join(", ")}]` : "",
      "source: quick-capture",
      "---",
      "",
      `# ${title}`,
      "",
      body || title,
      "",
    ].filter((ln, idx) => idx >= 7 || ln !== "");
    writeFileAtomic0600(fullPath, frontmatterLines.join("\n"));
    record = {
      ok: true,
      kind: "note",
      id: `note_${tsCompact}_${randomUUID().slice(0, 6)}`,
      saved_at: savedAt,
      label: `Note: ${title}`,
      title,
      domain,
      path: relPath,
    };
  } else {
    // memt: local append-only jsonl under vault/owner-notes/memt-captures.jsonl (0600)
    const notesDir = ownerNotesDir(vaultPath);
    ensureDir(notesDir);
    const memtPath = assertPathContained(notesDir, join(notesDir, "memt-captures.jsonl"));
    const id = `memt_${randomUUID().slice(0, 8)}`;
    const entry = {
      id,
      kind: "memt",
      saved_at: savedAt,
      title,
      body: body || title,
      domain,
      personKey: personKey || undefined,
      tags,
      source: "quick-capture",
    };
    appendJsonlAtomic0600(memtPath, entry, 1000);
    record = {
      ok: true,
      kind: "memt",
      id,
      saved_at: savedAt,
      label: `MemT: ${title}`,
      title,
      domain,
      path: "owner-notes/memt-captures.jsonl",
    };
  }

  // Record in quick-captures recent index (0600)
  const logPath = assertPathContained(
    ownerNotesDir(vaultPath),
    join(ownerNotesDir(vaultPath), "quick-captures.jsonl"),
  );
  appendJsonlAtomic0600(logPath, record as unknown as Record<string, unknown>, 200);

  return record;
}
