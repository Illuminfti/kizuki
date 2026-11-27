// Live Box AI Telemetry & Process-to-Brain Topology Engine (Lane W1)
// Strictly local, read-only, secret-redacted OS-wide AI observability.

import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  statSync,
} from "node:fs";
import { cpus, freemem, homedir, loadavg, totalmem } from "node:os";
import { basename, join } from "node:path";
import type { KizukiAgentBoardApi } from "./agent-board-api.ts";
import { SSE_HEADERS } from "./live-bus.ts";

export type BoxAiCategory = "building" | "designing" | "predicting" | "orchestrating";

export const BOX_AI_CATEGORIES: readonly BoxAiCategory[] = [
  "building",
  "designing",
  "predicting",
  "orchestrating",
] as const;

export type BoxAiResourceKind = "brain" | "bus" | "model" | "pipeline" | "repo";
export type BoxAiEdgeKind = "writes" | "reads" | "embeds" | "orchestrates" | "critiques" | "serves";
export type BoxAiSourceKind = "ps" | "systemd" | "tmux" | "transcript" | "board";

export interface BoxAiAgentNode {
  id: string;
  kind: "agent";
  name: string;
  runtime: string;
  category: BoxAiCategory;
  status: "active" | "busy" | "idle" | "activating";
  pid: number | null;
  pids: number[];
  worker_count: number;
  cpu_pct: number;
  mem_pct: number;
  rss_mb: number;
  uptime_s: number;
  repo: string | null;
  cwd_label: string | null;
  unit: string | null;
  tmux_session: string | null;
  active_tool: string | null;
  current_action: string;
  recent_actions: string[];
  resources: string[];
  sources: BoxAiSourceKind[];
  score: number;
}

export interface BoxAiResourceNode {
  id: string;
  kind: BoxAiResourceKind;
  name: string;
  subtitle: string;
  online: boolean;
  agent_count: number;
  metrics: Record<string, number | string | boolean | null>;
}

export interface BoxAiTopologyEdge {
  id: string;
  from: string;
  to: string;
  category: BoxAiCategory;
  kind: BoxAiEdgeKind;
  label: string;
  weight: number;
  cpu_pct: number;
  active: boolean;
}

export interface BoxAiTranscriptActivity {
  id: string;
  runtime: "claude" | "codex";
  session_id: string;
  repo: string | null;
  active_tool: string | null;
  current_action: string;
  recent_actions: string[];
  mtime_ms: number;
  age_s: number;
  file_bytes: number;
}

export interface BoxAiSystemdUnit {
  unit: string;
  sub_state: string;
  description: string;
  category: BoxAiCategory;
}

export interface BoxAiTmuxPane {
  session: string;
  pid: number;
  command: string;
  repo: string | null;
  category: BoxAiCategory;
}

export interface BoxAiSharedBrainTelemetry {
  load_avg: [number, number, number];
  cpu_cores: number;
  mem_total_gb: number;
  mem_free_gb: number;
  embedder: {
    online: boolean;
    model: string | null;
    backend: string | null;
    rss_mb: number | null;
    requests_total: number | null;
    texts_total: number | null;
    cache_hits: number | null;
    cache_misses: number | null;
    cache_hit_rate: number | null;
    avg_latency_ms: number | null;
    uptime_s: number | null;
  };
  semantic_memory: {
    available: boolean;
    stats: Record<string, unknown> | null;
  };
  agent_board: {
    online: boolean;
    board_online: boolean;
    cockpit_online: boolean;
    brain_online: boolean;
    active_runs: number;
    open_tasks: number;
    blocked_gates: number;
    seats_count: number;
    dispatcher_status: string;
    seats: Array<Record<string, unknown>>;
  };
}

export interface BoxAiRadarSnapshot {
  ok: boolean;
  generated_at: string;
  scan_ms: number;
  cache_hit: boolean;
  category_filter: BoxAiCategory | null;
  summary: {
    total_live: number;
    raw_processes: number;
    systemd_units: number;
    tmux_ai_panes: number;
    active_transcripts: number;
    total_cpu_pct: number;
    total_rss_mb: number;
    by_category: Record<BoxAiCategory, number>;
    top_repos: Array<{ repo: string; agents: number; cpu_pct: number }>;
  };
  agents: BoxAiAgentNode[];
  resources: BoxAiResourceNode[];
  nodes: Array<BoxAiAgentNode | BoxAiResourceNode>;
  edges: BoxAiTopologyEdge[];
  transcripts: BoxAiTranscriptActivity[];
  systemd_services: BoxAiSystemdUnit[];
  tmux_panes: BoxAiTmuxPane[];
  brain: BoxAiSharedBrainTelemetry;
  source_health: {
    ps: boolean;
    systemd: boolean;
    tmux: boolean;
    transcripts: boolean;
    embedder: boolean;
    agent_board: boolean;
  };
}

export interface BoxAiRadarStreamStatus {
  connected_clients: number;
  timer_active: boolean;
  events_emitted: number;
}

export interface BoxAiRadarEngineOptions {
  agentBoardApi?: Pick<KizukiAgentBoardApi, "getHealth" | "getBlockers" | "getAgents"> | null;
  embedHealthUrl?: string;
  cacheTtlMs?: number;
  staleWindowMs?: number;
  streamIntervalMs?: number;
  transcriptWindowMs?: number;
  maxTranscripts?: number;
  maxAgentNodes?: number;
  homeDir?: string;
  isTestEnv?: boolean;
  nowFn?: () => number;
  fetchFn?: typeof fetch;
}

interface RawProcessRow {
  pid: number;
  ppid: number;
  pcpu: number;
  pmem: number;
  rssKb: number;
  etimes: number;
  comm: string;
  args: string;
}

interface DetectedProcess {
  row: RawProcessRow;
  runtime: string;
  label: string;
  category: BoxAiCategory;
  groupKey: string;
  repo: string | null;
  cwdLabel: string | null;
  sessionId: string | null;
  unitHint: string | null;
  resources: Array<{ id: string; kind: BoxAiEdgeKind; label: string }>;
}

interface StreamClient {
  id: number;
  category: BoxAiCategory | null;
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
  detachSignal?: () => void;
}

const DEFAULT_CACHE_TTL_MS = 2_500;
const DEFAULT_STALE_WINDOW_MS = 10_000;
const DEFAULT_STREAM_INTERVAL_MS = 2_500;
const DEFAULT_TRANSCRIPT_WINDOW_MS = 2 * 60 * 60 * 1000;
const DEFAULT_MAX_TRANSCRIPTS = 6;
const DEFAULT_MAX_AGENT_NODES = 28;
const DEFAULT_EMBED_HEALTH_URL = "http://127.0.0.1:8789/health";
const TAIL_BYTES = 8_192;
const ACTION_MAX_LEN = 96;
const ENCODER = new TextEncoder();

export function isBoxAiCategory(value: string | null | undefined): value is BoxAiCategory {
  return (
    value === "building" ||
    value === "designing" ||
    value === "predicting" ||
    value === "orchestrating"
  );
}

export function isTestRuntime(): boolean {
  if (process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test") {
    return true;
  }
  if (typeof Bun !== "undefined" && /\.test\.ts$/.test(String(Bun.main || ""))) {
    return true;
  }
  return false;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function stripEmDashes(input: string): string {
  return input.replace(/\s*\u2014\s*/g, " - ").replace(/\u2014/g, "-");
}

// Strict secret and sensitive-path redaction applied to all surfaced strings.
export function redactSecrets(input: string): string {
  if (!input) return "";
  let out = stripEmDashes(String(input));

  // PEM private key blocks (multi-line or single-line headers)
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*[P]RIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*[P]RIVATE KEY-----|$)/gi,
    "[REDACTED_PRIVATE_KEY]",
  );

  // Known provider API keys and tokens
  out = out.replace(/\bs[k]-(?:proj-|ant-|live-|test-)?[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]");
  out = out.replace(/\bg[h][pousr]_[A-Za-z0-9_]{10,}\b/g, "[REDACTED_GH_TOKEN]");
  out = out.replace(/\bA[K]IA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]");
  out = out.replace(/\bAI[z]a[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_GOOGLE_KEY]");
  out = out.replace(/\bx[o]x[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED_SLACK_TOKEN]");

  // Bearer headers / tokens (including shell env placeholders)
  out = out.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");

  // Key=value or key: value credentials
  out = out.replace(
    /\b(token|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|auth[_-]?token)\s*([:=])\s*["']?[^\s"'&,;}{]+["']?/gi,
    "$1$2[REDACTED]",
  );

  // Sensitive file paths: .env*, .credentials*, credentials.json, agent-credentials/*, .git-credentials
  out = out.replace(
    /(?:[A-Za-z0-9_.~/-]*\/)?(?:\.env(?:\.[A-Za-z0-9._-]+)?|\.credentials(?:\.[A-Za-z0-9._-]+)?|credentials\.json|\.git-credentials|agent-credentials(?:\/[^\s"'(),;:]*)?)/gi,
    "[REDACTED_SECRET_PATH]",
  );

  // Clean whitespace and control characters
  out = out.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return out;
}

function clampAction(input: string, maxLen = ACTION_MAX_LEN): string {
  const clean = redactSecrets(input);
  if (clean.length <= maxLen) return clean;
  return `${clean.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function extractRepoFromPath(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  const clean = rawPath.trim().replace(/\/+$/, "");
  const home = homedir().replace(/\/+$/, "");
  if (!clean || clean === "/" || clean === home || clean === "/tmp") {
    return null;
  }
  if (/(?:\.env|\.credentials|agent-credentials|\.ssh|\.gnupg)/i.test(clean)) {
    return null;
  }

  const knownPrefixes = [
    join(home, "work") + "/",
    join(home, "projects") + "/",
    join(home, "repos") + "/",
    home + "/",
    "/workspace/",
  ];

  for (const prefix of knownPrefixes) {
    if (clean.startsWith(prefix)) {
      const rest = clean.slice(prefix.length);
      const first = rest.split("/")[0] || "";
      if (!first || first.startsWith(".") || first === "tmp" || first === "bin") {
        return null;
      }
      return redactSecrets(first);
    }
  }

  const base = basename(clean);
  if (!base || base.startsWith(".") || base === "ubuntu" || base === "home") {
    return null;
  }
  return redactSecrets(base);
}

function extractRepoFromEncodedClaudeDir(dirName: string): string | null {
  // e.g. "-home-ubuntu-codex-capabilities" -> "codex-capabilities"
  // "-home-ubuntu" -> null
  if (!dirName) return null;
  if (dirName === "-home-ubuntu" || dirName === "-tmp" || dirName === "-") return null;
  if (dirName.includes("--claude-")) return null;
  if (dirName.startsWith("-home-ubuntu-")) {
    const rest = dirName.slice("-home-ubuntu-".length);
    return rest ? redactSecrets(rest) : null;
  }
  if (dirName.startsWith("-data-")) {
    const rest = dirName.slice("-data-".length);
    return rest ? redactSecrets(rest) : null;
  }
  return redactSecrets(dirName.replace(/^-+/, "")) || null;
}

function formatSafeCwdLabel(rawPath: string | null | undefined): string | null {
  if (!rawPath) return null;
  if (/(?:\.env|\.credentials|agent-credentials|\.ssh|\.gnupg)/i.test(rawPath)) {
    return "[REDACTED_SECRET_PATH]";
  }
  const clean = rawPath.trim().replace(/^\/home\/ubuntu(?=\/|$)/, "~");
  const redacted = redactSecrets(clean);
  return redacted.length > 64 ? `...${redacted.slice(-61)}` : redacted;
}

function safeReadProcCwd(pid: number): string | null {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

async function runCommandWithTimeout(
  cmd: string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });

    const timeoutPromise = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });

    const readPromise = (async () => {
      const text = await new Response(proc!.stdout as ReadableStream<Uint8Array>).text();
      const code = await proc!.exited;
      return { timedOut: false as const, text, code };
    })();

    const winner = await Promise.race([readPromise, timeoutPromise]);
    if (winner.timedOut) {
      try {
        proc.kill();
      } catch {
        // ignore kill error
      }
      return { ok: false, stdout: "" };
    }
    return { ok: winner.code === 0, stdout: winner.text };
  } catch {
    try {
      proc?.kill();
    } catch {
      // ignore
    }
    return { ok: false, stdout: "" };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });
    return await Promise.race([promise, timeoutPromise]);
  } catch {
    return fallback;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function normalizeToolName(raw: string): string {
  const name = raw.trim();
  if (!name) return "Tool";
  if (/^mcp__/i.test(name) || /mcp/i.test(name)) return "MCP";
  if (/^(exec_command|bash|shell|run_command|terminal)$/i.test(name)) return "Bash";
  if (/^(edit|edit_file|multiedit|apply_patch|str_replace)$/i.test(name)) return "Edit";
  if (/^(write|write_file|create_file)$/i.test(name)) return "Write";
  if (/^(read|read_file|view_file)$/i.test(name)) return "Read";
  if (/^(grep|ripgrep|grep_search|search_files)$/i.test(name)) return "Grep";
  if (/^(glob|find_by_name|list_dir)$/i.test(name)) return "Glob";
  if (/^(web_search|websearch|search_web|webfetch|web_fetch)$/i.test(name)) return "WebSearch";
  if (/^(agent|task|invoke_subagent|subagent)$/i.test(name)) return "Agent";
  return redactSecrets(name).slice(0, 28);
}

function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== "object") {
    return tool;
  }
  const rec = input as Record<string, unknown>;
  const filePath =
    (typeof rec.file_path === "string" && rec.file_path) ||
    (typeof rec.path === "string" && rec.path) ||
    (typeof rec.target_file === "string" && rec.target_file) ||
    "";
  if (filePath) {
    const safePath = redactSecrets(filePath);
    const label = safePath.includes("[REDACTED") ? safePath : basename(safePath) || safePath;
    return clampAction(`${tool} ${label}`);
  }
  const cmd =
    (typeof rec.command === "string" && rec.command) ||
    (typeof rec.cmd === "string" && rec.cmd) ||
    (typeof rec.CommandLine === "string" && rec.CommandLine) ||
    "";
  if (cmd) {
    return clampAction(`${tool}: ${cmd}`);
  }
  const query =
    (typeof rec.pattern === "string" && rec.pattern) ||
    (typeof rec.query === "string" && rec.query) ||
    (typeof rec.url === "string" && rec.url) ||
    (typeof rec.description === "string" && rec.description) ||
    (typeof rec.prompt === "string" && rec.prompt) ||
    "";
  if (query) {
    return clampAction(`${tool}: ${query}`);
  }
  return clampAction(tool);
}

export interface TailReadResult {
  runtime: "claude" | "codex";
  session_id: string;
  repo: string | null;
  active_tool: string | null;
  current_action: string;
  recent_actions: string[];
  file_bytes: number;
  bytes_read: number;
}

// O(1) tail reader: reads ONLY the last `maxTailBytes` (default 8 KB) via openSync + readSync.
export function readTranscriptTail(
  filePath: string,
  opts: {
    runtime?: "claude" | "codex";
    maxTailBytes?: number;
    repoHint?: string | null;
  } = {},
): TailReadResult | null {
  const maxTailBytes =
    typeof opts.maxTailBytes === "number" && opts.maxTailBytes > 256
      ? Math.trunc(opts.maxTailBytes)
      : TAIL_BYTES;
  const runtime: "claude" | "codex" =
    opts.runtime ?? (filePath.includes(".codex") ? "codex" : "claude");

  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    const st = fstatSync(fd);
    const fileBytes = st.size;
    if (fileBytes <= 0) return null;

    const toRead = Math.min(fileBytes, maxTailBytes);
    const startOffset = Math.max(0, fileBytes - toRead);
    const buf = Buffer.allocUnsafe(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, startOffset);
    closeSync(fd);
    fd = null;

    let text = buf.subarray(0, bytesRead).toString("utf8");
    if (startOffset > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline !== -1) {
        text = text.slice(firstNewline + 1);
      }
    }

    const lines = text.split("\n").filter((line) => line.trim().length > 0);
    let sessionId = basename(filePath, ".jsonl");
    let repo: string | null = opts.repoHint ?? null;
    let activeTool: string | null = null;
    const actions: string[] = [];

    const pushAction = (actionText: string) => {
      const clean = clampAction(actionText);
      if (!clean) return;
      if (actions[actions.length - 1] !== clean) {
        actions.push(clean);
      }
    };

    for (const line of lines) {
      let obj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        obj = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      if (typeof obj.sessionId === "string" && obj.sessionId) {
        sessionId = obj.sessionId;
      }
      if (typeof obj.cwd === "string" && obj.cwd) {
        const extracted = extractRepoFromPath(obj.cwd);
        if (extracted) repo = extracted;
      }

      // Claude Code message.content blocks
      const message =
        obj.message && typeof obj.message === "object"
          ? (obj.message as Record<string, unknown>)
          : null;
      if (message && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (!block || typeof block !== "object") continue;
          const b = block as Record<string, unknown>;
          if (b.type === "tool_use" && typeof b.name === "string") {
            const tool = normalizeToolName(b.name);
            activeTool = tool;
            pushAction(summarizeToolInput(tool, b.input));
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            pushAction(b.text.trim());
          }
        }
      }

      // Direct tool_use or tool call records
      if (obj.type === "tool_use" && typeof obj.name === "string") {
        const tool = normalizeToolName(obj.name);
        activeTool = tool;
        pushAction(summarizeToolInput(tool, obj.input));
      }

      // Codex JSONL payload records
      const payload =
        obj.payload && typeof obj.payload === "object"
          ? (obj.payload as Record<string, unknown>)
          : null;
      if (payload) {
        if (typeof payload.session_id === "string" && payload.session_id) {
          sessionId = payload.session_id;
        }
        if (typeof payload.cwd === "string" && payload.cwd) {
          const extracted = extractRepoFromPath(payload.cwd);
          if (extracted) repo = extracted;
        }
        const pType = typeof payload.type === "string" ? payload.type : "";
        if (
          (pType === "function_call" || pType === "custom_tool_call" || pType === "tool_call") &&
          typeof payload.name === "string"
        ) {
          const tool = normalizeToolName(payload.name);
          activeTool = tool;
          let parsedArgs: unknown = payload.arguments ?? payload.input;
          if (typeof parsedArgs === "string") {
            try {
              parsedArgs = JSON.parse(parsedArgs);
            } catch {
              parsedArgs = { command: parsedArgs };
            }
          }
          pushAction(summarizeToolInput(tool, parsedArgs));
        } else if (pType === "task_complete" && typeof payload.last_agent_message === "string") {
          pushAction(`Completed: ${payload.last_agent_message}`);
        } else if (pType === "agent_message" && typeof payload.message === "string") {
          pushAction(payload.message);
        }
      }

      // Queue operations / task notifications (Claude Code background tasks)
      if (obj.type === "queue-operation" && typeof obj.operation === "string") {
        if (!activeTool) activeTool = "Agent";
        pushAction(`Queue ${obj.operation} subagent task`);
      }
    }

    const recentActions = actions.slice(-4).reverse();
    const currentAction =
      recentActions[0] ||
      (activeTool ? `${activeTool} active` : `${runtime === "codex" ? "Codex" : "Claude"} session active`);

    return {
      runtime,
      session_id: redactSecrets(sessionId).slice(0, 64),
      repo,
      active_tool: activeTool,
      current_action: clampAction(currentAction),
      recent_actions: recentActions,
      file_bytes: fileBytes,
      bytes_read: bytesRead,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
}

export function classifySystemdUnit(unit: string, description: string): BoxAiCategory | null {
  const u = unit.toLowerCase();
  const d = description.toLowerCase();
  const text = `${u} ${d}`;

  // Ignore non-AI system plumbing
  if (
    u.startsWith("dbus") ||
    u.startsWith("gpg-") ||
    u.startsWith("gnome-") ||
    u.startsWith("at-spi") ||
    u.startsWith("xdg-") ||
    u.startsWith("xvfb") ||
    u.startsWith("x11vnc") ||
    u.startsWith("openbox")
  ) {
    return null;
  }

  // Must match AI / Kizuki / Agent-Board / Embed / Gauntlet / Gardener / T3 / Cogent / Predict / Inkling / Watch
  const isAiUnit =
    /(kizuki|agent-daemon|agent-board|t3code|codex|claude|antigravity|embed|gauntlet|gardener|earshot|shot-reader|cogent|predict|inkling|minimax|firecrawl|watch\.service)/i.test(
      u,
    );
  if (!isAiUnit) return null;

  if (/(taste-gardener|gardener|earshot|shot-reader|remotion|design|visual)/i.test(text)) {
    return "designing";
  }
  if (/(mind-explorer|codex|claude|antigravity|builder)/i.test(u)) {
    return "building";
  }
  if (
    /(kizuki-local-embed|kizuki-gauntlet|kizuki-endstate-gauntlet|kizuki-minimax|kizuki-free-mgr|kizuki@|cogent|predict|inkling)/i.test(
      u,
    )
  ) {
    return "predicting";
  }
  if (/(agent-daemon|agent-board|t3code|relay|dispatch|bridge|gate|mesh|watch)/i.test(u)) {
    return "orchestrating";
  }
  return "predicting";
}

function classifyTmuxCommand(command: string): BoxAiCategory | null {
  const c = command.trim().toLowerCase();
  if (c === "claude" || c === "codex" || c === "agy" || c === "antigravity" || c === "bun") {
    return "building";
  }
  if (c === "agent-daemon") {
    return "orchestrating";
  }
  if (c === "python" || c === "python3" || c === "kizuki") {
    return "predicting";
  }
  return null;
}

function detectAiProcess(row: RawProcessRow): DetectedProcess | null {
  const comm = row.comm.toLowerCase();
  const args = row.args;
  const argsLower = args.toLowerCase();

  // Skip kernel threads, ps/grep itself, and noisy system/browser sub-helpers
  if (args.startsWith("[") && args.endsWith("]")) return null;
  if (comm === "ps" || comm === "grep" || comm === "awk" || comm === "sed") return null;
  if (comm === "networkd-dispat" || argsLower.includes("networkd-dispatcher")) return null;
  if (comm === "chrome_crashpad" || argsLower.includes("chrome_crashpad_handler")) return null;
  if (
    (comm.includes("chrome") || argsLower.includes("chrome")) &&
    /--type=(zygote|utility|renderer|gpu-process|broker|crashpad)/i.test(args)
  ) {
    return null;
  }
  // Skip transient wrapper shells spawned just to wrap systemd-run/t3-claude
  if ((comm === "sh" || comm === "bash") && argsLower.includes("t3-claude") && argsLower.includes("systemd-run")) {
    return null;
  }
  if (comm === "bwrap") return null;

  let runtime: string | null = null;
  let label = "";
  let category: BoxAiCategory = "building";
  let unitHint: string | null = null;
  let sessionId: string | null = null;
  const resources: Array<{ id: string; kind: BoxAiEdgeKind; label: string }> = [];

  // Extract --resume=<uuid> for Claude sessions
  const resumeMatch = /--resume[=\s]+([a-z0-9-]{8,})/i.exec(args);
  if (resumeMatch) {
    sessionId = resumeMatch[1];
  }

  // 1. DESIGNING: earshot, joins.py, remotion, shot-reader, taste-gardener, playwright, chrome-headless / chrome automation
  if (
    argsLower.includes("earshot") ||
    argsLower.includes("joins.py") ||
    argsLower.includes("remotion") ||
    argsLower.includes("shot-reader") ||
    argsLower.includes("taste-gardener") ||
    argsLower.includes("gardener")
  ) {
    runtime = argsLower.includes("earshot")
      ? "earshot"
      : argsLower.includes("joins.py")
        ? "joins"
        : argsLower.includes("remotion")
          ? "remotion"
          : argsLower.includes("shot-reader")
            ? "shot-reader"
            : "taste-gardener";
    label =
      runtime === "earshot"
        ? "Earshot Audio Critic"
        : runtime === "joins"
          ? "Joins Media Pipeline"
          : runtime === "remotion"
            ? "Remotion Video Renderer"
            : runtime === "shot-reader"
              ? "Shot Reader Vision"
              : "Kizuki Taste Gardener";
    category = "designing";
    resources.push({ id: "res:media-pipeline", kind: "critiques", label: "critiques media" });
    if (runtime === "taste-gardener") {
      resources.push({ id: "res:kizuki-vault", kind: "writes", label: "updates taste" });
    }
  } else if (
    argsLower.includes("playwright") ||
    comm.includes("chrome-headless") ||
    (comm === "chrome" && (argsLower.includes("remote-debugging") || argsLower.includes("headless") || argsLower.includes("oracle")))
  ) {
    runtime = argsLower.includes("playwright") ? "playwright" : "chrome";
    label = runtime === "playwright" ? "Playwright Visual Runner" : "Chrome Visual Critic";
    category = "designing";
    resources.push({ id: "res:media-pipeline", kind: "critiques", label: "renders & inspects UI" });
  }
  // 2. ORCHESTRATING: agent-daemon, agent-board*, dispatch, he-mcp, kizuki-mcp, chrome-devtools-mcp, mcp-remote, firecrawl, t3 acp-mcp-bridge, t3code
  else if (
    comm === "agent-daemon" ||
    argsLower.includes("agent-daemon")
  ) {
    runtime = "agent-daemon";
    const isDash = argsLower.includes("dashboard");
    const isGw = argsLower.includes("gateway");
    label = isDash ? "Agent Dashboard" : isGw ? "Agent Gateway" : "Ambient Agent";
    category = "orchestrating";
    unitHint = isDash ? "agent-dashboard.service" : isGw ? "agent-gateway.service" : null;
    resources.push(
      { id: "res:agent-board", kind: "orchestrates", label: "routes board & DMs" },
      { id: "res:kizuki-vault", kind: "reads", label: "reads memory" },
    );
  } else if (argsLower.includes("agent-board") || argsLower.includes("vb serve")) {
    runtime = "agent-board";
    const sub = argsLower.includes("dispatcher")
      ? "Dispatcher"
      : argsLower.includes("bridge")
        ? "Bridges"
        : argsLower.includes("relay")
          ? "Relay"
          : argsLower.includes("cockpit-api")
            ? "Cockpit API"
            : argsLower.includes("cockpit")
              ? "Cockpit UI"
              : argsLower.includes("brain")
                ? "Living Brain"
                : argsLower.includes("mesh")
                  ? "Mesh Server"
                  : argsLower.includes("gate")
                    ? "Device Gate"
                    : "Bus";
    label = `Agent Board ${sub}`;
    category = "orchestrating";
    resources.push({ id: "res:agent-board", kind: "orchestrates", label: "serves bus" });
    if (sub === "Bridges" || sub === "Living Brain") {
      resources.push({ id: "res:kizuki-vault", kind: "writes", label: "syncs scribe" });
    }
  } else if (
    comm !== "claude" &&
    comm !== "codex" &&
    (argsLower.includes("acp-mcp-bridge") ||
      argsLower.includes("t3code") ||
      (argsLower.includes("t3-code") && !argsLower.includes("mcp__t3-code__")))
  ) {
    runtime = "t3-bridge";
    label = argsLower.includes("acp-mcp-bridge") ? "T3 ACP-MCP Bridge" : "T3 Code Server";
    category = "orchestrating";
    resources.push({ id: "res:agent-board", kind: "orchestrates", label: "coordinates sessions" });
  } else if (
    comm !== "claude" &&
    comm !== "codex" &&
    (comm === "he-mcp" ||
      comm === "kizuki-mcp" ||
      comm === "chrome-devtools" ||
      argsLower.includes("chrome-devtools-mcp") ||
      argsLower.includes("mcp-remote") ||
      argsLower.includes("firecrawl") ||
      argsLower.includes("/bin/rea mcp") ||
      /\bmcp\b/i.test(args))
  ) {
    runtime = "mcp";
    const bridge =
      comm === "he-mcp" || argsLower.includes("he-mcp")
        ? "HyperExtract MCP"
        : comm === "kizuki-mcp" || argsLower.includes("kizuki-mcp")
          ? "Kizuki Vault MCP"
          : argsLower.includes("chrome-devtools")
            ? "Chrome DevTools MCP"
            : argsLower.includes("firecrawl")
              ? "Firecrawl MCP"
              : argsLower.includes("higgsfield")
                ? "Higgsfield Media MCP"
                : argsLower.includes("rea mcp")
                  ? "REA MCP"
                  : "MCP Bridge";
    label = bridge;
    category = "orchestrating";
    if (bridge === "Kizuki Vault MCP") {
      resources.push({ id: "res:kizuki-vault", kind: "reads", label: "queries vault" });
    } else if (bridge === "Chrome DevTools MCP" || bridge === "Higgsfield Media MCP") {
      resources.push({ id: "res:media-pipeline", kind: "critiques", label: "drives browser/media" });
    } else {
      resources.push({ id: "res:agent-board", kind: "orchestrates", label: "bridges tools" });
    }
  }
  // 3. PREDICTING: kizuki daemons, embedder, gauntlet, minimax, free-mgr, cogent, predictd, inkling, lifeos-kernel
  else if (
    argsLower.includes("kizuki-local-embed") ||
    argsLower.includes("bge-small") ||
    argsLower.includes("embed_server") ||
    argsLower.includes(":8789")
  ) {
    runtime = "kizuki-embed";
    label = "Kizuki Local Embed (BGE-Small ONNX)";
    category = "predicting";
    unitHint = "kizuki-local-embed.service";
    resources.push(
      { id: "res:bge-embed", kind: "embeds", label: "serves 384d vectors" },
      { id: "res:kizuki-vault", kind: "embeds", label: "indexes semantic memory" },
    );
  } else if (argsLower.includes("kizuki-minimax")) {
    runtime = "kizuki-minimax";
    label = "Kizuki MiniMax Bridge";
    category = "predicting";
    unitHint = "kizuki-minimax-subscription.service";
    resources.push({ id: "res:minimax-llm", kind: "serves", label: "routes MiniMax inference" });
  } else if (argsLower.includes("kizuki-endstate-gauntlet") || argsLower.includes("kizuki-gauntlet")) {
    runtime = "kizuki-gauntlet";
    label = argsLower.includes("endstate") ? "Kizuki Endstate Gauntlet" : "Kizuki Gauntlet Observer";
    category = "predicting";
    resources.push(
      { id: "res:kizuki-vault", kind: "reads", label: "verifies invariants" },
      { id: "res:agent-board", kind: "orchestrates", label: "reports telemetry" },
    );
  } else if (argsLower.includes("kizuki-free-mgr")) {
    runtime = "kizuki-free-mgr";
    label = "Kizuki Free-Compute Manager";
    category = "predicting";
    unitHint = "kizuki-free-mgr.service";
    resources.push({ id: "res:minimax-llm", kind: "serves", label: "manages free compute" });
  } else if (
    argsLower.includes("kizuki-mind-explorer") &&
    !argsLower.includes("box-ai-radar.test")
  ) {
    runtime = "kizuki-explorer";
    label = "Kizuki Mind Explorer";
    category = "building";
    unitHint = "kizuki-mind-explorer.service";
    resources.push(
      { id: "res:kizuki-vault", kind: "reads", label: "explores vault" },
      { id: "res:bge-embed", kind: "embeds", label: "semantic search" },
      { id: "res:agent-board", kind: "reads", label: "reads board" },
    );
  } else if (
    comm === "kizuki" ||
    /\bkizuki\s+(serve|sync|daemon|watch)\b/i.test(args)
  ) {
    runtime = "kizuki";
    label = argsLower.includes("sync") ? "Kizuki Sync" : "Kizuki Vault Server";
    category = "predicting";
    resources.push(
      { id: "res:kizuki-vault", kind: "serves", label: "serves vault" },
      { id: "res:bge-embed", kind: "embeds", label: "embeds canon" },
    );
  } else if (
    argsLower.includes("cogentd") ||
    argsLower.includes("predictd.py") ||
    argsLower.includes("inkling")
  ) {
    runtime = argsLower.includes("cogent")
      ? "cogent"
      : argsLower.includes("predictd")
        ? "predict"
        : "inkling";
    label =
      runtime === "cogent"
        ? "Cogent-Large Decision Daemon"
        : runtime === "predict"
          ? "Local Signal Predictor"
          : "Inkling Credal Loop";
    category = "predicting";
    resources.push({ id: "res:kizuki-vault", kind: "reads", label: "reads graph/canon" });
  }
  // 4. BUILDING: claude, codex, antigravity / agy, cargo / bun builders
  else if (
    comm === "claude" ||
    /(?:^|\/)claude(?:\s|$)/i.test(args)
  ) {
    if (argsLower.includes("claude-1000") && (comm === "bash" || comm === "sh")) {
      return null;
    }
    runtime = "claude";
    label = "Claude Code";
    category = "building";
    resources.push(
      { id: "res:kizuki-vault", kind: "reads", label: "context & canon" },
      { id: "res:agent-board", kind: "orchestrates", label: "board coordination" },
    );
  } else if (
    comm === "codex" ||
    /(?:^|\/)codex(?:\s|$)/i.test(args)
  ) {
    runtime = "codex";
    label = argsLower.includes("app-server") ? "Codex App Server" : "OpenAI Codex CLI";
    category = "building";
    resources.push(
      { id: "res:kizuki-vault", kind: "reads", label: "reads context" },
      { id: "res:agent-board", kind: "orchestrates", label: "posts status" },
    );
  } else if (
    comm === "agy" ||
    comm.includes("antigravity") ||
    argsLower.includes("antigravity") ||
    /(?:^|\/)agy(?:\s|$)/i.test(args)
  ) {
    runtime = "antigravity";
    label = "Antigravity / Neon";
    category = "building";
    resources.push(
      { id: "res:kizuki-vault", kind: "reads", label: "reads vault & taste" },
      { id: "res:agent-board", kind: "orchestrates", label: "swarms & board" },
    );
  } else if (
    comm === "cargo" ||
    (comm === "bun" && /\b(build|test|run)\b/i.test(args) && !argsLower.includes("box-ai-radar.test"))
  ) {
    runtime = comm;
    label = comm === "cargo" ? "Cargo Rust Builder" : "Bun Runtime Builder";
    category = "building";
  }

  if (!runtime) return null;

  // Resolve /proc/<pid>/cwd safely for matched AI processes only
  const procCwd = safeReadProcCwd(row.pid);
  let repo = extractRepoFromPath(procCwd);

  // Fallback repo hint from --add-dir= or explicit workspace path in args
  if (!repo) {
    const addDirMatch = /--add-dir[=\s]+([^\s]+)/.exec(args);
    if (addDirMatch) {
      repo = extractRepoFromPath(addDirMatch[1]);
    }
  }
  if (!repo) {
    const dataPathMatch = /(\/data\/[A-Za-z0-9._-]+|\/home\/ubuntu\/[A-Za-z0-9._-]+)/.exec(args);
    if (dataPathMatch) {
      repo = extractRepoFromPath(dataPathMatch[1]);
    }
  }

  const cwdLabel = formatSafeCwdLabel(procCwd);

  // Deduplication group key
  let groupKey: string;
  if (unitHint) {
    groupKey = `unit:${unitHint}`;
  } else if (runtime === "mcp" || runtime === "agent-board" || runtime === "t3-bridge") {
    groupKey = `${runtime}:${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  } else if (runtime === "claude" || runtime === "codex" || runtime === "antigravity") {
    // Keep distinct active sessions/repos visible while grouping identical idle sessions in the same repo
    const bucket = repo || "home";
    const activeBucket = sessionId ? `sess:${sessionId.slice(0, 8)}` : bucket;
    groupKey = `${runtime}:${activeBucket}`;
  } else {
    groupKey = `${runtime}:${(repo || label).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  }

  return {
    row,
    runtime,
    label,
    category,
    groupKey,
    repo,
    cwdLabel,
    sessionId,
    unitHint,
    resources,
  };
}

export class BoxAiRadarEngine {
  private readonly agentBoardApi: BoxAiRadarEngineOptions["agentBoardApi"];
  private readonly embedHealthUrl: string;
  private readonly cacheTtlMs: number;
  private readonly staleWindowMs: number;
  private readonly streamIntervalMs: number;
  private readonly transcriptWindowMs: number;
  private readonly maxTranscripts: number;
  private readonly maxAgentNodes: number;
  private readonly homeDir: string;
  private readonly isTestEnv: boolean;
  private readonly nowFn: () => number;
  private readonly fetchFn: typeof fetch;

  private cachedSnapshot: BoxAiRadarSnapshot | null = null;
  private cachedAtMs = 0;
  private inflightScan: Promise<BoxAiRadarSnapshot> | null = null;

  private readonly clients = new Set<StreamClient>();
  private streamTimer: ReturnType<typeof setInterval> | null = null;
  private nextClientId = 1;
  private eventsEmitted = 0;
  private broadcastInflight = false;

  constructor(opts: BoxAiRadarEngineOptions = {}) {
    this.agentBoardApi = opts.agentBoardApi ?? null;
    this.embedHealthUrl = opts.embedHealthUrl ?? DEFAULT_EMBED_HEALTH_URL;
    this.cacheTtlMs =
      typeof opts.cacheTtlMs === "number" && opts.cacheTtlMs >= 50
        ? opts.cacheTtlMs
        : DEFAULT_CACHE_TTL_MS;
    this.staleWindowMs =
      typeof opts.staleWindowMs === "number" && opts.staleWindowMs >= this.cacheTtlMs
        ? opts.staleWindowMs
        : DEFAULT_STALE_WINDOW_MS;
    this.streamIntervalMs =
      typeof opts.streamIntervalMs === "number" && opts.streamIntervalMs >= 100
        ? opts.streamIntervalMs
        : DEFAULT_STREAM_INTERVAL_MS;
    this.transcriptWindowMs =
      typeof opts.transcriptWindowMs === "number" && opts.transcriptWindowMs > 0
        ? opts.transcriptWindowMs
        : DEFAULT_TRANSCRIPT_WINDOW_MS;
    this.maxTranscripts =
      typeof opts.maxTranscripts === "number" && opts.maxTranscripts > 0
        ? opts.maxTranscripts
        : DEFAULT_MAX_TRANSCRIPTS;
    this.maxAgentNodes =
      typeof opts.maxAgentNodes === "number" && opts.maxAgentNodes > 0
        ? opts.maxAgentNodes
        : DEFAULT_MAX_AGENT_NODES;
    this.homeDir = opts.homeDir ?? homedir();
    this.isTestEnv = opts.isTestEnv ?? isTestRuntime();
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  getStreamStatus(): BoxAiRadarStreamStatus {
    return {
      connected_clients: this.clients.size,
      timer_active: this.streamTimer !== null,
      events_emitted: this.eventsEmitted,
    };
  }

  async getSnapshot(opts: {
    refresh?: boolean;
    category?: BoxAiCategory | null;
  } = {}): Promise<BoxAiRadarSnapshot> {
    const refresh = Boolean(opts.refresh);
    const category = opts.category ?? null;
    const now = this.nowFn();
    const age = this.cachedSnapshot ? now - this.cachedAtMs : Infinity;

    if (!refresh && this.cachedSnapshot && age < this.cacheTtlMs) {
      return this.applyCategoryFilter(this.cachedSnapshot, category, true);
    }

    if (!refresh && this.cachedSnapshot && age < this.staleWindowMs && !this.isTestEnv) {
      // Stale-while-revalidate: return immediately and coalesce background refresh
      void this.triggerScan().catch(() => {});
      return this.applyCategoryFilter(this.cachedSnapshot, category, true);
    }

    const fresh = await this.triggerScan();
    return this.applyCategoryFilter(fresh, category, false);
  }

  connectStream(signal?: AbortSignal, category: BoxAiCategory | null = null): Response {
    let client: StreamClient | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (signal?.aborted) {
          try {
            controller.close();
          } catch {
            // ignore
          }
          return;
        }

        const entry: StreamClient = {
          id: this.nextClientId++,
          category,
          controller,
          closed: false,
        };
        client = entry;

        if (signal) {
          const onAbort = () => {
            this.removeClient(entry, true);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          entry.detachSignal = () => {
            signal.removeEventListener("abort", onAbort);
          };
        }

        this.clients.add(entry);
        this.ensureStreamTimer();

        // Emit immediate snapshot
        const now = this.nowFn();
        if (this.cachedSnapshot && now - this.cachedAtMs < this.staleWindowMs) {
          const snap = this.applyCategoryFilter(this.cachedSnapshot, category, true);
          this.writeEvent(entry, "snapshot", snap);
        } else {
          void this.getSnapshot({ category })
            .then((snap) => {
              if (!entry.closed) {
                this.writeEvent(entry, "snapshot", snap);
              }
            })
            .catch(() => {
              // ignore transient scan error on closed client
            });
        }
      },
      cancel: () => {
        if (client) {
          this.removeClient(client, false);
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { ...SSE_HEADERS },
    });
  }

  close(): void {
    for (const client of Array.from(this.clients)) {
      this.removeClient(client, true);
    }
    this.stopStreamTimer();
  }

  private ensureStreamTimer(): void {
    if (this.streamTimer !== null || this.clients.size === 0) return;
    this.streamTimer = setInterval(() => {
      void this.tickStream();
    }, this.streamIntervalMs);
    if (typeof (this.streamTimer as { unref?: () => void }).unref === "function") {
      (this.streamTimer as { unref: () => void }).unref();
    }
  }

  private stopStreamTimer(): void {
    if (this.streamTimer !== null) {
      clearInterval(this.streamTimer);
      this.streamTimer = null;
    }
  }

  private async tickStream(): Promise<void> {
    if (this.clients.size === 0) {
      this.stopStreamTimer();
      return;
    }
    if (this.broadcastInflight) return;
    this.broadcastInflight = true;
    try {
      const fresh = await this.triggerScan();
      if (this.clients.size === 0) {
        this.stopStreamTimer();
        return;
      }
      for (const client of Array.from(this.clients)) {
        if (client.closed) continue;
        const payload = this.applyCategoryFilter(fresh, client.category, false);
        this.writeEvent(client, "update", payload);
      }
    } catch {
      // fail-soft on periodic tick
    } finally {
      this.broadcastInflight = false;
    }
  }

  private writeEvent(client: StreamClient, eventName: string, payload: unknown): void {
    if (client.closed) return;
    const chunk = ENCODER.encode(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    try {
      client.controller.enqueue(chunk);
      this.eventsEmitted += 1;
    } catch {
      this.removeClient(client, false);
    }
  }

  private removeClient(client: StreamClient, closeController: boolean): void {
    if (client.closed) return;
    client.closed = true;
    if (client.detachSignal) {
      try {
        client.detachSignal();
      } catch {
        // ignore
      }
      client.detachSignal = undefined;
    }
    this.clients.delete(client);
    if (closeController) {
      try {
        client.controller.close();
      } catch {
        // ignore
      }
    }
    if (this.clients.size === 0) {
      this.stopStreamTimer();
    }
  }

  private triggerScan(): Promise<BoxAiRadarSnapshot> {
    if (this.inflightScan) {
      return this.inflightScan;
    }
    const p = this.performFullScan().finally(() => {
      if (this.inflightScan === p) {
        this.inflightScan = null;
      }
    });
    this.inflightScan = p;
    return p;
  }

  private applyCategoryFilter(
    base: BoxAiRadarSnapshot,
    category: BoxAiCategory | null,
    cacheHit: boolean,
  ): BoxAiRadarSnapshot {
    if (!category) {
      return {
        ...base,
        cache_hit: cacheHit,
        category_filter: null,
      };
    }

    const filteredAgents = base.agents.filter((a) => a.category === category);
    const agentIds = new Set(filteredAgents.map((a) => a.id));
    const filteredEdges = base.edges.filter((e) => agentIds.has(e.from));
    const touchedRes = new Set(filteredEdges.map((e) => e.to));
    const filteredResources = base.resources.filter((r) => touchedRes.has(r.id));

    return {
      ...base,
      cache_hit: cacheHit,
      category_filter: category,
      agents: filteredAgents,
      resources: filteredResources,
      nodes: [...filteredAgents, ...filteredResources],
      edges: filteredEdges,
    };
  }

  // Source 1: Live Linux Processes
  private async scanProcesses(): Promise<{ ok: boolean; rows: RawProcessRow[] }> {
    const res = await runCommandWithTimeout(
      ["ps", "-eo", "pid,ppid,pcpu,pmem,rss,etimes,comm,args", "--no-headers"],
      750,
    );
    if (!res.ok) return { ok: false, rows: [] };

    const rows: RawProcessRow[] = [];
    for (const rawLine of res.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = /^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      rows.push({
        pid: Number(m[1]),
        ppid: Number(m[2]),
        pcpu: Number(m[3]) || 0,
        pmem: Number(m[4]) || 0,
        rssKb: Number(m[5]) || 0,
        etimes: Number(m[6]) || 0,
        comm: m[7],
        args: m[8],
      });
    }
    return { ok: true, rows };
  }

  // Source 2: Live systemd --user AI Services
  private async scanSystemdUnits(): Promise<{ ok: boolean; units: BoxAiSystemdUnit[] }> {
    const res = await runCommandWithTimeout(
      [
        "systemctl",
        "--user",
        "list-units",
        "--type=service",
        "--state=running,activating",
        "--no-legend",
        "--no-pager",
        "--full",
      ],
      750,
    );
    if (!res.ok) return { ok: false, units: [] };

    const units: BoxAiSystemdUnit[] = [];
    for (const rawLine of res.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      // Format: <unit> <load> <active> <sub> <description...>
      const m = /^(\S+\.service)\s+\S+\s+\S+\s+(\S+)\s+(.*)$/.exec(line);
      if (!m) continue;
      const unit = m[1];
      const subState = m[2];
      const description = clampAction(m[3], 120);
      const category = classifySystemdUnit(unit, description);
      if (!category) continue;
      units.push({
        unit,
        sub_state: subState,
        description,
        category,
      });
    }
    return { ok: true, units };
  }

  // Source 3: Live tmux AI Panes
  private async scanTmuxPanes(): Promise<{ ok: boolean; panes: BoxAiTmuxPane[] }> {
    const res = await runCommandWithTimeout(
      [
        "tmux",
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}",
      ],
      600,
    );
    if (!res.ok) return { ok: false, panes: [] };

    const panes: BoxAiTmuxPane[] = [];
    for (const line of res.stdout.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      if (parts.length < 4) continue;
      const session = redactSecrets(parts[0]);
      const pid = Number(parts[1]);
      const command = redactSecrets(parts[2]);
      const pathStr = parts[3];
      const category = classifyTmuxCommand(command);
      if (!category || !Number.isFinite(pid)) continue;
      panes.push({
        session,
        pid,
        command,
        repo: extractRepoFromPath(pathStr),
        category,
      });
    }
    return { ok: true, panes };
  }

  // Source 4: O(1) Active Transcript Tail Reader
  private scanActiveTranscripts(): { ok: boolean; transcripts: BoxAiTranscriptActivity[] } {
    const now = this.nowFn();
    const cutoffMs = now - this.transcriptWindowMs;
    const candidates: Array<{
      path: string;
      runtime: "claude" | "codex";
      mtimeMs: number;
      size: number;
      repoHint: string | null;
    }> = [];

    // 4a. ~/.claude/projects/*/*.jsonl (depth 2)
    const claudeProjectsDir = join(this.homeDir, ".claude", "projects");
    try {
      const projectDirs = readdirSync(claudeProjectsDir, { withFileTypes: true });
      for (const projEntry of projectDirs) {
        if (!projEntry.isDirectory()) continue;
        const projPath = join(claudeProjectsDir, projEntry.name);
        const repoHint = extractRepoFromEncodedClaudeDir(projEntry.name);
        try {
          const files = readdirSync(projPath, { withFileTypes: true });
          for (const f of files) {
            if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
            const fullPath = join(projPath, f.name);
            try {
              const st = statSync(fullPath);
              if (st.mtimeMs >= cutoffMs && st.size > 0) {
                candidates.push({
                  path: fullPath,
                  runtime: "claude",
                  mtimeMs: st.mtimeMs,
                  size: st.size,
                  repoHint,
                });
              }
            } catch {
              // ignore unreadable file
            }
          }
        } catch {
          // ignore unreadable project dir
        }
      }
    } catch {
      // ~/.claude/projects absent
    }

    // 4b. ~/.codex/sessions/YYYY/MM/DD/*.jsonl (bounded depth 4, latest years/months/days first)
    const codexSessionsDir = join(this.homeDir, ".codex", "sessions");
    try {
      const years = readdirSync(codexSessionsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse()
        .slice(0, 2);
      for (const year of years) {
        const yDir = join(codexSessionsDir, year);
        let months: string[] = [];
        try {
          months = readdirSync(yDir, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name)
            .sort()
            .reverse()
            .slice(0, 2);
        } catch {
          continue;
        }
        for (const month of months) {
          const mDir = join(yDir, month);
          let days: string[] = [];
          try {
            days = readdirSync(mDir, { withFileTypes: true })
              .filter((d) => d.isDirectory())
              .map((d) => d.name)
              .sort()
              .reverse()
              .slice(0, 3);
          } catch {
            continue;
          }
          for (const day of days) {
            const dDir = join(mDir, day);
            try {
              const files = readdirSync(dDir, { withFileTypes: true });
              for (const f of files) {
                if (!f.isFile() || !f.name.endsWith(".jsonl")) continue;
                const fullPath = join(dDir, f.name);
                try {
                  const st = statSync(fullPath);
                  if (st.mtimeMs >= cutoffMs && st.size > 0) {
                    candidates.push({
                      path: fullPath,
                      runtime: "codex",
                      mtimeMs: st.mtimeMs,
                      size: st.size,
                      repoHint: null,
                    });
                  }
                } catch {
                  // ignore
                }
              }
            } catch {
              // ignore
            }
          }
        }
      }
    } catch {
      // ~/.codex/sessions absent
    }

    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const topCandidates = candidates.slice(0, this.maxTranscripts);

    const transcripts: BoxAiTranscriptActivity[] = [];
    for (const c of topCandidates) {
      const parsed = readTranscriptTail(c.path, {
        runtime: c.runtime,
        maxTailBytes: TAIL_BYTES,
        repoHint: c.repoHint,
      });
      if (!parsed) continue;
      transcripts.push({
        id: `tx:${parsed.runtime}:${parsed.session_id.slice(0, 12)}`,
        runtime: parsed.runtime,
        session_id: parsed.session_id,
        repo: parsed.repo,
        active_tool: parsed.active_tool,
        current_action: parsed.current_action,
        recent_actions: parsed.recent_actions,
        mtime_ms: Math.trunc(c.mtimeMs),
        age_s: Math.max(0, Math.round((now - c.mtimeMs) / 1000)),
        file_bytes: parsed.file_bytes,
      });
    }

    return { ok: true, transcripts };
  }

  // Source 5: Live Shared Brain Telemetry
  private async scanSharedBrain(): Promise<{
    brain: BoxAiSharedBrainTelemetry;
    embedderOk: boolean;
    boardOk: boolean;
  }> {
    const load = loadavg();
    const cpuCount = Math.max(1, cpus().length || 1);
    const memTotalGb = round2(totalmem() / (1024 * 1024 * 1024));
    const memFreeGb = round2(freemem() / (1024 * 1024 * 1024));

    const embedPromise = (async () => {
      try {
        const res = await this.fetchFn(this.embedHealthUrl, {
          signal: AbortSignal.timeout(300),
        });
        if (!res.ok) return null;
        const data = (await res.json()) as Record<string, unknown>;
        return data;
      } catch {
        return null;
      }
    })();

    const boardPromise = (async () => {
      if (!this.agentBoardApi) return null;
      try {
        const [health, blockers] = await Promise.all([
          withTimeout(this.agentBoardApi.getHealth(), 550, null),
          typeof this.agentBoardApi.getBlockers === "function"
            ? withTimeout(this.agentBoardApi.getBlockers(), 550, null)
            : Promise.resolve(null),
        ]);
        return { health, blockers };
      } catch {
        return null;
      }
    })();

    const [embedData, boardData] = await Promise.all([embedPromise, boardPromise]);

    let semanticStats: Record<string, unknown> | null = null;
    try {
      const g = globalThis as unknown as {
        __kizukiSemanticMemory?: { getStats?: () => Record<string, unknown> };
      };
      if (typeof g.__kizukiSemanticMemory?.getStats === "function") {
        semanticStats = g.__kizukiSemanticMemory.getStats();
      }
    } catch {
      semanticStats = null;
    }

    const cacheHits = typeof embedData?.cache_hits === "number" ? embedData.cache_hits : null;
    const cacheMisses = typeof embedData?.cache_misses === "number" ? embedData.cache_misses : null;
    const cacheTotal = (cacheHits ?? 0) + (cacheMisses ?? 0);
    const cacheHitRate = cacheTotal > 0 && cacheHits !== null ? round2(cacheHits / cacheTotal) : null;

    const embedder = {
      online: Boolean(embedData && embedData.status === "ok"),
      model: typeof embedData?.model === "string" ? redactSecrets(embedData.model) : null,
      backend: typeof embedData?.backend === "string" ? redactSecrets(embedData.backend) : null,
      rss_mb: typeof embedData?.rss_mib === "number" ? round1(embedData.rss_mib) : null,
      requests_total:
        typeof embedData?.requests_total === "number" ? embedData.requests_total : null,
      texts_total: typeof embedData?.texts_total === "number" ? embedData.texts_total : null,
      cache_hits: cacheHits,
      cache_misses: cacheMisses,
      cache_hit_rate: cacheHitRate,
      avg_latency_ms:
        typeof embedData?.avg_request_latency_ms === "number"
          ? round2(embedData.avg_request_latency_ms)
          : null,
      uptime_s: typeof embedData?.uptime_s === "number" ? Math.round(embedData.uptime_s) : null,
    };

    const health = boardData?.health ?? null;
    const blockers = boardData?.blockers ?? null;
    const dispatcherObj =
      health?.dispatcher && typeof health.dispatcher === "object"
        ? (health.dispatcher as Record<string, unknown>)
        : null;
    const activeRuns =
      typeof dispatcherObj?.active_runs === "number"
        ? dispatcherObj.active_runs
        : typeof dispatcherObj?.running === "number"
          ? dispatcherObj.running
          : Array.isArray(dispatcherObj?.runs)
            ? dispatcherObj.runs.length
            : 0;
    const dispatcherStatus =
      typeof dispatcherObj?.status === "string"
        ? redactSecrets(dispatcherObj.status)
        : health?.cockpitOnline
          ? "online"
          : "offline";

    const seatsRaw = Array.isArray(health?.seats) ? health!.seats : [];
    const safeSeats = seatsRaw.slice(0, 8).map((seat) => {
      if (!seat || typeof seat !== "object") return {};
      const rec = seat as Record<string, unknown>;
      const safe: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (/(token|secret|key|password|cookie|auth)/i.test(k)) continue;
        safe[k] = typeof v === "string" ? redactSecrets(v) : v;
      }
      return safe;
    });

    const blockedGates =
      typeof blockers?.total === "number"
        ? blockers.total
        : typeof health?.totals?.blocked === "number"
          ? health.totals.blocked
          : 0;

    const agentBoard = {
      online: Boolean(health?.ok),
      board_online: Boolean(health?.boardOnline),
      cockpit_online: Boolean(health?.cockpitOnline),
      brain_online: Boolean(health?.brainOnline),
      active_runs: activeRuns,
      open_tasks: Number(health?.totals?.openTasks) || 0,
      blocked_gates: blockedGates,
      seats_count: safeSeats.length,
      dispatcher_status: dispatcherStatus,
      seats: safeSeats,
    };

    return {
      brain: {
        load_avg: [round2(load[0] || 0), round2(load[1] || 0), round2(load[2] || 0)],
        cpu_cores: cpuCount,
        mem_total_gb: memTotalGb,
        mem_free_gb: memFreeGb,
        embedder,
        semantic_memory: {
          available: semanticStats !== null,
          stats: semanticStats,
        },
        agent_board: agentBoard,
      },
      embedderOk: embedder.online,
      boardOk: agentBoard.online,
    };
  }

  private async performFullScan(): Promise<BoxAiRadarSnapshot> {
    const t0 = performance.now();

    const [psRes, systemdRes, tmuxRes, brainRes] = await Promise.all([
      this.scanProcesses(),
      this.scanSystemdUnits(),
      this.scanTmuxPanes(),
      this.scanSharedBrain(),
    ]);
    const txRes = this.scanActiveTranscripts();

    // Index tmux panes by pid for parent/child correlation
    const tmuxByPid = new Map<number, BoxAiTmuxPane>();
    for (const pane of tmuxRes.panes) {
      tmuxByPid.set(pane.pid, pane);
    }

    // Index raw processes by pid for parent chain walk
    const ppidMap = new Map<number, number>();
    for (const row of psRes.rows) {
      ppidMap.set(row.pid, row.ppid);
    }

    const findTmuxForPid = (pid: number): BoxAiTmuxPane | null => {
      let cur: number | undefined = pid;
      for (let depth = 0; depth < 4 && cur && cur > 1; depth += 1) {
        const hit = tmuxByPid.get(cur);
        if (hit) return hit;
        cur = ppidMap.get(cur);
      }
      return null;
    };

    // Index transcripts by sessionId and by runtime:repo
    const txBySession = new Map<string, BoxAiTranscriptActivity>();
    const txByRuntimeRepo = new Map<string, BoxAiTranscriptActivity>();
    for (const tx of txRes.transcripts) {
      txBySession.set(tx.session_id, tx);
      const rk = `${tx.runtime}:${tx.repo || "home"}`;
      if (!txByRuntimeRepo.has(rk)) {
        txByRuntimeRepo.set(rk, tx);
      }
    }

    // Detect and group live AI processes
    const detected: DetectedProcess[] = [];
    for (const row of psRes.rows) {
      const det = detectAiProcess(row);
      if (det) detected.push(det);
    }

    interface GroupAccum {
      key: string;
      runtime: string;
      label: string;
      category: BoxAiCategory;
      pids: number[];
      cpuPct: number;
      memPct: number;
      rssKb: number;
      uptimeS: number;
      repo: string | null;
      cwdLabel: string | null;
      unit: string | null;
      tmuxSession: string | null;
      sessionId: string | null;
      sources: Set<BoxAiSourceKind>;
      resourceSpecs: Map<string, { id: string; kind: BoxAiEdgeKind; label: string }>;
    }

    const groups = new Map<string, GroupAccum>();
    const representedUnits = new Set<string>();

    for (const det of detected) {
      const tmuxHit = findTmuxForPid(det.row.pid);
      const repo = det.repo || tmuxHit?.repo || null;
      const gKey = det.groupKey;

      let g = groups.get(gKey);
      if (!g) {
        g = {
          key: gKey,
          runtime: det.runtime,
          label: det.label,
          category: det.category,
          pids: [],
          cpuPct: 0,
          memPct: 0,
          rssKb: 0,
          uptimeS: det.row.etimes,
          repo,
          cwdLabel: det.cwdLabel,
          unit: det.unitHint,
          tmuxSession: tmuxHit?.session ?? null,
          sessionId: det.sessionId,
          sources: new Set<BoxAiSourceKind>(["ps"]),
          resourceSpecs: new Map(),
        };
        groups.set(gKey, g);
      }

      g.pids.push(det.row.pid);
      g.cpuPct += det.row.pcpu;
      g.memPct += det.row.pmem;
      g.rssKb += det.row.rssKb;
      g.uptimeS = Math.max(g.uptimeS, det.row.etimes);
      if (!g.repo && repo) g.repo = repo;
      if (!g.cwdLabel && det.cwdLabel) g.cwdLabel = det.cwdLabel;
      if (!g.unit && det.unitHint) g.unit = det.unitHint;
      if (!g.tmuxSession && tmuxHit) g.tmuxSession = tmuxHit.session;
      if (!g.sessionId && det.sessionId) g.sessionId = det.sessionId;
      if (tmuxHit) g.sources.add("tmux");

      for (const r of det.resources) {
        g.resourceSpecs.set(r.id, r);
      }
      if (det.unitHint) {
        representedUnits.add(det.unitHint);
      }
    }

    // Correlate systemd units with grouped processes or add unrepresented AI units
    for (const unit of systemdRes.units) {
      const uLower = unit.unit.toLowerCase();
      let matched = false;
      for (const g of groups.values()) {
        if (
          g.unit === unit.unit ||
          (uLower.includes("agent-dashboard") && g.label.includes("Agent Dashboard")) ||
          (uLower.includes("agent-gateway") && g.label.includes("Agent Gateway")) ||
          (uLower.includes("kizuki-local-embed") && g.runtime === "kizuki-embed") ||
          (uLower.includes("kizuki-mind-explorer") && g.runtime === "kizuki-explorer") ||
          (uLower.includes("kizuki-minimax") && g.runtime === "kizuki-minimax") ||
          (uLower.includes("kizuki-free-mgr") && g.runtime === "kizuki-free-mgr") ||
          (uLower.includes("kizuki@") && g.runtime === "kizuki") ||
          (uLower.includes("t3code") && g.label === "T3 Code Server") ||
          (uLower.includes("agent-board-dispatcher") && g.label === "Agent Board Dispatcher") ||
          (uLower.includes("agent-board-bridges") && g.label === "Agent Board Bridges") ||
          (uLower.includes("agent-board-relay") && g.label === "Agent Board Relay") ||
          (uLower.includes("agent-board-brain") && g.label === "Agent Board Living Brain") ||
          (uLower.includes("agent-board-cockpit-api") && g.label === "Agent Board Cockpit API") ||
          (uLower.includes("agent-board-mesh") && g.label === "Agent Board Mesh Server")
        ) {
          g.unit = unit.unit;
          g.sources.add("systemd");
          representedUnits.add(unit.unit);
          matched = true;
          break;
        }
      }

      if (!matched && !representedUnits.has(unit.unit)) {
        const shortName = unit.unit.replace(/\.service$/, "");
        const resourceSpecs = new Map<string, { id: string; kind: BoxAiEdgeKind; label: string }>();
        if (uLower.includes("embed")) {
          resourceSpecs.set("res:bge-embed", { id: "res:bge-embed", kind: "embeds", label: "serves embeddings" });
        } else if (uLower.includes("minimax") || uLower.includes("inkling")) {
          resourceSpecs.set("res:minimax-llm", { id: "res:minimax-llm", kind: "serves", label: "serves inference" });
        } else if (uLower.includes("agent-board") || uLower.includes("agent-daemon") || uLower.includes("t3code") || uLower.includes("watch")) {
          resourceSpecs.set("res:agent-board", { id: "res:agent-board", kind: "orchestrates", label: "orchestrates bus" });
        } else if (uLower.includes("gardener") || uLower.includes("earshot")) {
          resourceSpecs.set("res:media-pipeline", { id: "res:media-pipeline", kind: "critiques", label: "critiques craft" });
        } else {
          resourceSpecs.set("res:kizuki-vault", { id: "res:kizuki-vault", kind: "reads", label: "reads vault" });
        }

        groups.set(`unit:${unit.unit}`, {
          key: `unit:${unit.unit}`,
          runtime: shortName.split("-")[0] || "service",
          label: shortName,
          category: unit.category,
          pids: [],
          cpuPct: 0,
          memPct: 0,
          rssKb: 0,
          uptimeS: 0,
          repo: null,
          cwdLabel: null,
          unit: unit.unit,
          tmuxSession: null,
          sessionId: null,
          sources: new Set<BoxAiSourceKind>(["systemd"]),
          resourceSpecs,
        });
      }
    }

    // Convert groups into BoxAiAgentNode[]
    const allAgents: BoxAiAgentNode[] = [];
    const repoStats = new Map<string, { agents: number; cpu_pct: number }>();

    for (const g of groups.values()) {
      // Match transcript telemetry if Claude/Codex
      let matchedTx: BoxAiTranscriptActivity | undefined;
      if (g.sessionId && txBySession.has(g.sessionId)) {
        matchedTx = txBySession.get(g.sessionId);
      } else if (g.runtime === "claude" || g.runtime === "codex") {
        matchedTx = txByRuntimeRepo.get(`${g.runtime}:${g.repo || "home"}`);
      }

      if (matchedTx) {
        g.sources.add("transcript");
        if (!g.repo && matchedTx.repo) {
          g.repo = matchedTx.repo;
        }
      }

      // Attach repo as a touched resource if present
      if (g.repo) {
        const repoResId = `res:repo:${g.repo}`;
        g.resourceSpecs.set(repoResId, {
          id: repoResId,
          kind: g.category === "building" ? "writes" : g.category === "designing" ? "critiques" : "reads",
          label: g.category === "building" ? `builds ${g.repo}` : `inspects ${g.repo}`,
        });
      }

      const cpuPct = round1(g.cpuPct);
      const memPct = round1(g.memPct);
      const rssMb = round1(g.rssKb / 1024);

      const unitRec = g.unit ? systemdRes.units.find((u) => u.unit === g.unit) : null;
      const status: BoxAiAgentNode["status"] =
        unitRec?.sub_state === "start" || unitRec?.sub_state === "activating"
          ? "activating"
          : cpuPct >= 2.0 || (matchedTx && matchedTx.age_s < 180)
            ? "busy"
            : cpuPct >= 0.1 || g.pids.length > 0
              ? "active"
              : "idle";

      const displayName =
        g.repo && !g.label.toLowerCase().includes(g.repo.toLowerCase())
          ? `${g.label} (${g.repo})`
          : g.label;

      const currentAction = matchedTx
        ? matchedTx.current_action
        : unitRec?.description
          ? clampAction(unitRec.description)
          : g.repo
            ? clampAction(`${g.category === "building" ? "Working in" : "Monitoring"} ${g.repo}`)
            : clampAction(`${g.label} running`);

      const recentActions = matchedTx ? matchedTx.recent_actions : [];
      const activeTool = matchedTx?.active_tool ?? null;

      // Priority score for sorting top crisp nodes
      const score = round1(
        cpuPct * 10 +
          (status === "busy" ? 28 : status === "activating" ? 18 : status === "active" ? 10 : 2) +
          (matchedTx ? 24 : 0) +
          (g.repo ? 6 : 0) +
          Math.min(rssMb / 180, 12) +
          Math.min(g.pids.length, 4),
      );

      const safeId = `agent:${g.key.replace(/[^a-zA-Z0-9:._-]/g, "-")}`;
      const resourceIds = Array.from(g.resourceSpecs.keys());

      allAgents.push({
        id: safeId,
        kind: "agent",
        name: clampAction(displayName, 72),
        runtime: g.runtime,
        category: g.category,
        status,
        pid: g.pids[0] ?? null,
        pids: g.pids.slice(0, 16),
        worker_count: Math.max(1, g.pids.length),
        cpu_pct: cpuPct,
        mem_pct: memPct,
        rss_mb: rssMb,
        uptime_s: g.uptimeS,
        repo: g.repo,
        cwd_label: g.cwdLabel,
        unit: g.unit,
        tmux_session: g.tmuxSession,
        active_tool: activeTool,
        current_action: currentAction,
        recent_actions: recentActions,
        resources: resourceIds,
        sources: Array.from(g.sources),
        score,
      });

      if (g.repo) {
        const prev = repoStats.get(g.repo) ?? { agents: 0, cpu_pct: 0 };
        prev.agents += 1;
        prev.cpu_pct = round1(prev.cpu_pct + cpuPct);
        repoStats.set(g.repo, prev);
      }
    }

    // Sort agents by activity score descending and keep top crisp nodes
    allAgents.sort((a, b) => b.score - a.score || b.cpu_pct - a.cpu_pct || a.name.localeCompare(b.name));

    // Preserve category balance in top N: ensure every present category gets representation
    const selectedAgents: BoxAiAgentNode[] = [];
    const selectedIds = new Set<string>();
    for (const cat of BOX_AI_CATEGORIES) {
      const topInCat = allAgents.filter((a) => a.category === cat).slice(0, 3);
      for (const a of topInCat) {
        if (!selectedIds.has(a.id) && selectedAgents.length < this.maxAgentNodes) {
          selectedIds.add(a.id);
          selectedAgents.push(a);
        }
      }
    }
    for (const a of allAgents) {
      if (selectedAgents.length >= this.maxAgentNodes) break;
      if (!selectedIds.has(a.id)) {
        selectedIds.add(a.id);
        selectedAgents.push(a);
      }
    }
    selectedAgents.sort((a, b) => b.score - a.score || b.cpu_pct - a.cpu_pct || a.name.localeCompare(b.name));

    // Build concrete Resource/Brain nodes and directed Topology Edges
    const resourceMap = new Map<string, BoxAiResourceNode>();
    const ensureResource = (
      id: string,
      kind: BoxAiResourceKind,
      name: string,
      subtitle: string,
      online: boolean,
      metrics: Record<string, number | string | boolean | null>,
    ) => {
      if (!resourceMap.has(id)) {
        resourceMap.set(id, {
          id,
          kind,
          name,
          subtitle,
          online,
          agent_count: 0,
          metrics,
        });
      }
    };

    const brain = brainRes.brain;
    ensureResource(
      "res:kizuki-vault",
      "brain",
      "Kizuki Vault",
      "Canon, MemT & Semantic Memory",
      true,
      {
        semantic_ready: brain.semantic_memory.available,
        load_1m: brain.load_avg[0],
      },
    );
    ensureResource(
      "res:agent-board",
      "bus",
      "Agent Board Bus",
      `Dispatcher ${brain.agent_board.dispatcher_status}`,
      brain.agent_board.online || brain.agent_board.board_online,
      {
        open_tasks: brain.agent_board.open_tasks,
        blocked_gates: brain.agent_board.blocked_gates,
        active_runs: brain.agent_board.active_runs,
        seats: brain.agent_board.seats_count,
      },
    );
    ensureResource(
      "res:bge-embed",
      "model",
      "BGE-Small ONNX :8789",
      brain.embedder.online
        ? `${brain.embedder.texts_total ?? 0} texts | ${Math.round((brain.embedder.cache_hit_rate ?? 0) * 100)}% cache hit`
        : "Loopback embedder offline",
      brain.embedder.online,
      {
        requests_total: brain.embedder.requests_total,
        cache_hits: brain.embedder.cache_hits,
        rss_mb: brain.embedder.rss_mb,
        avg_latency_ms: brain.embedder.avg_latency_ms,
      },
    );
    ensureResource(
      "res:minimax-llm",
      "model",
      "MiniMax LLM",
      "Local OAuth inference & free-compute rail",
      systemdRes.units.some((u) => u.unit.includes("minimax")) ||
        selectedAgents.some((a) => a.runtime === "kizuki-minimax"),
      {},
    );
    ensureResource(
      "res:media-pipeline",
      "pipeline",
      "Media/Audio Pipeline",
      "Chrome, Earshot, Remotion & Visual Critics",
      selectedAgents.some((a) => a.category === "designing"),
      {},
    );

    const edges: BoxAiTopologyEdge[] = [];
    const seenEdgeIds = new Set<string>();

    for (const agent of selectedAgents) {
      const groupObj = groups.get(agent.id.replace(/^agent:/, ""));
      for (const resId of agent.resources) {
        if (resId.startsWith("res:repo:")) {
          const repoName = resId.slice("res:repo:".length);
          const stats = repoStats.get(repoName);
          ensureResource(resId, "repo", repoName, "Active git workspace", true, {
            agents: stats?.agents ?? 1,
            cpu_pct: stats?.cpu_pct ?? agent.cpu_pct,
          });
        }
        const resNode = resourceMap.get(resId);
        if (!resNode) continue;
        resNode.agent_count += 1;

        const spec = groupObj?.resourceSpecs.get(resId);
        const edgeKind: BoxAiEdgeKind =
          spec?.kind ??
          (agent.category === "building"
            ? "writes"
            : agent.category === "designing"
              ? "critiques"
              : agent.category === "predicting"
                ? "embeds"
                : "orchestrates");
        const edgeLabel = spec?.label ?? edgeKind;
        const edgeId = `edge:${agent.id}->${resId}`;
        if (seenEdgeIds.has(edgeId)) continue;
        seenEdgeIds.add(edgeId);

        const weight = Math.max(
          1,
          Math.min(10, Math.round(1 + agent.cpu_pct / 2 + (agent.status === "busy" ? 3 : 1))),
        );
        edges.push({
          id: edgeId,
          from: agent.id,
          to: resId,
          category: agent.category,
          kind: edgeKind,
          label: clampAction(edgeLabel, 48),
          weight,
          cpu_pct: agent.cpu_pct,
          active: agent.status === "busy" || agent.status === "active",
        });
      }
    }

    const resources = Array.from(resourceMap.values()).filter(
      (r) => r.kind !== "repo" || r.agent_count > 0,
    );

    const byCategory: Record<BoxAiCategory, number> = {
      building: 0,
      designing: 0,
      predicting: 0,
      orchestrating: 0,
    };
    let totalCpu = 0;
    let totalRss = 0;
    for (const a of selectedAgents) {
      byCategory[a.category] += 1;
      totalCpu += a.cpu_pct;
      totalRss += a.rss_mb;
    }

    const topRepos = Array.from(repoStats.entries())
      .map(([repo, info]) => ({ repo, agents: info.agents, cpu_pct: info.cpu_pct }))
      .sort((a, b) => b.agents - a.agents || b.cpu_pct - a.cpu_pct || a.repo.localeCompare(b.repo))
      .slice(0, 8);

    const scanMs = round2(performance.now() - t0);
    const snapshot: BoxAiRadarSnapshot = {
      ok: true,
      generated_at: new Date(this.nowFn()).toISOString(),
      scan_ms: scanMs,
      cache_hit: false,
      category_filter: null,
      summary: {
        total_live: selectedAgents.length,
        raw_processes: detected.length,
        systemd_units: systemdRes.units.length,
        tmux_ai_panes: tmuxRes.panes.length,
        active_transcripts: txRes.transcripts.length,
        total_cpu_pct: round1(totalCpu),
        total_rss_mb: round1(totalRss),
        by_category: byCategory,
        top_repos: topRepos,
      },
      agents: selectedAgents,
      resources,
      nodes: [...selectedAgents, ...resources],
      edges,
      transcripts: txRes.transcripts,
      systemd_services: systemdRes.units,
      tmux_panes: tmuxRes.panes,
      brain,
      source_health: {
        ps: psRes.ok,
        systemd: systemdRes.ok,
        tmux: tmuxRes.ok,
        transcripts: txRes.ok,
        embedder: brainRes.embedderOk,
        agent_board: brainRes.boardOk,
      },
    };

    this.cachedSnapshot = snapshot;
    this.cachedAtMs = this.nowFn();
    return snapshot;
  }
}
