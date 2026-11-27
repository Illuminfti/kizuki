import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BadRequestError, NotFoundError, ServiceUnavailableError } from "./vault-api.ts";

export { BadRequestError, NotFoundError, ServiceUnavailableError };

export const DEFAULT_AGENT_BOARD_DB_PATH =
  process.env.AGENT_BOARD_DB_PATH || join(homedir(), ".local", "share", "agent-board", "local.db");
export const DEFAULT_BOARD_URL =
  process.env.AGENT_BOARD_URL || "http://127.0.0.1:4100/api/board";
export const DEFAULT_COCKPIT_API_URL =
  process.env.AGENT_BOARD_COCKPIT_URL || "http://127.0.0.1:4111";
export const DEFAULT_BRAIN_API_URL =
  process.env.AGENT_BOARD_BRAIN_URL || "http://127.0.0.1:4113";
export const DEFAULT_VB_BIN_PATH =
  process.env.AGENT_BOARD_VB_BIN || "vb";
export const DEFAULT_GITLEAKS_BIN_PATH =
  process.env.GITLEAKS_BIN ||
  (existsSync(join(homedir(), ".local", "bin", "gitleaks"))
    ? join(homedir(), ".local", "bin", "gitleaks")
    : "gitleaks");

const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,48}(\/[a-z0-9][a-z0-9_-]{0,48})?$/;
const NUMERIC_THREAD_ID_RE = /^\d{1,12}$/;
const MAX_THREAD_ID_CHARS = 180;
const LABEL_KEY_RE = /^[a-zA-Z0-9._-]{1,48}$/;
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const MAX_TEXT_CHARS = 16_384;
const MAX_LABEL_VALUE_CHARS = 128;
const FORBIDDEN_RELAY_PORT = "4114";

const FINISHED_TASK_STATES = new Set(["completed", "failed", "canceled", "cancelled"]);
const OPEN_TASK_STATES = new Set([
  "ready",
  "claimed",
  "waiting",
  "running",
  "blocked",
  "open",
  "paused",
]);

const KNOWN_TOP_GROUPS = new Set([
  "box",
  "agent-board",
  "design",
  "crypto",
  "estate",
  "world",
  "board",
  "lobby",
]);

const GROUP_LABELS: Record<string, string> = {
  box: "Box",
  "agent-board": "Agent Board",
  design: "Design",
  crypto: "Crypto",
  estate: "Estate",
  world: "World",
  board: "Board",
  lobby: "Lobby",
  projects: "Projects",
  other: "Other",
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const FALLBACK_SECRET_PATTERNS: Array<{ ruleId: string; description: string; re: RegExp }> = [
  {
    ruleId: "github-pat",
    description: "GitHub personal access token pattern detected",
    re: /\bg[h][pousr]_[A-Za-z0-9_]{20,}\b/,
  },
  {
    ruleId: "github-fine-grained-pat",
    description: "GitHub fine-grained personal access token pattern detected",
    re: /\bgit[h]ub_pat_[A-Za-z0-9_]{20,}\b/,
  },
  {
    ruleId: "openai-api-key",
    description: "Secret provider API key pattern detected",
    re: /\bs[k]-(?:proj-|live-|test-|ant-api\d*-)?[A-Za-z0-9_-]{20,}\b/,
  },
  {
    ruleId: "aws-access-key",
    description: "AWS access key ID pattern detected",
    re: /\bA[KS]IA[0-9A-Z]{16}\b/,
  },
  {
    ruleId: "slack-token",
    description: "Slack token pattern detected",
    re: /\bx[o]x[baprs]-[A-Za-z0-9-]{10,}\b/,
  },
  {
    ruleId: "private-key",
    description: "PEM private key header detected",
    re: /-----BEGIN [A-Z0-9 ]*[P]RIVATE KEY-----/,
  },
];

export type AgentBrand =
  | "owner"
  | "claude"
  | "codex"
  | "designer"
  | "brain"
  | "worker"
  | "bot";

export type AgentRole =
  | "owner"
  | "claude"
  | "codex"
  | "designer"
  | "daemon"
  | "worker"
  | "bot";

export interface SecretFinding {
  ruleId: string;
  description: string;
}

export interface SecretScanResult {
  blocked: boolean;
  findings: SecretFinding[];
  error?: string;
}

export class SecretDetectedError extends Error {
  status = 422;
  findings: SecretFinding[];

  constructor(message: string, findings: SecretFinding[] = []) {
    super(message);
    this.name = "SecretDetectedError";
    this.findings = findings;
  }
}

export interface VbExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type VbExecutor = (
  argv: string[],
  opts?: { env?: Record<string, string>; stdin?: string },
) => Promise<VbExecResult>;

export type SecretScanner = (
  content: string,
) => Promise<SecretScanResult> | SecretScanResult;

export interface AgentBoardConfig {
  dbPath: string;
  boardUrl: string;
  cockpitApiUrl: string;
  brainApiUrl: string;
  vbBinPath: string;
  gitleaksBinPath: string;
  fetchImpl?: typeof fetch;
  execVb?: VbExecutor;
  secretScanner?: SecretScanner;
  fetchTimeoutMs: number;
  cacheTtlMs: number;
  upstreamPollMs?: number;
  upstreamIdleStopMs?: number;
}

export interface BoardTaskInfo {
  state: string | null;
  owner: string | null;
  by: string | null;
  for: string | null;
  needs: string[];
  epoch: number | null;
  claim: unknown;
  blocked: { kind?: string; reason?: string } | null;
  result: string | null;
  reason: string | null;
}

export interface BoardReplyPreview {
  id: string;
  by: string;
  displayName: string;
  brand: AgentBrand;
  role: AgentRole;
  createdAt: string;
  excerpt: string;
}

export interface BoardMessageItem {
  id: string;
  numericId: number;
  eventId: string;
  channel: string;
  re: string | null;
  replyTo: string | null;
  thread: string | null;
  title: string;
  text: string;
  by: string;
  displayName: string;
  byActor: string;
  byPrincipal: string;
  byProfile: string | null;
  role: AgentRole;
  brand: AgentBrand;
  labels: Record<string, string>;
  reactions: Record<string, unknown>;
  attachments: unknown[];
  links: unknown[];
  replies: number;
  createdAt: string;
  createdAtMs: number;
  editedAt: string | null;
  lastAt: string;
  lastAtMs: number;
  task: BoardTaskInfo | null;
  taskState: string | null;
  isBlocked: boolean;
  isPaused: boolean;
  isOpenTask: boolean;
  replyPreview?: BoardReplyPreview[];
  participants?: string[];
}

export interface BoardRoom {
  channel: string;
  name: string;
  group: string;
  groupLabel: string;
  messages: number;
  threads: number;
  openTasks: number;
  blockedTasks: number;
  lastAt: string | null;
  lastAtMs: number;
  lastMessageId: number;
  lastAuthor: string | null;
  lastBrand: AgentBrand;
  lastPreview: string;
}

export interface BoardRoomGroup {
  id: string;
  label: string;
  count: number;
}

export interface AgentPresenceItem {
  actor: string;
  handle: string;
  displayName: string;
  principal: string;
  profile: string | null;
  role: AgentRole;
  brand: AgentBrand;
  messagesCount: number;
  threadsStarted: number;
  repliesCount: number;
  channelsCount: number;
  recentChannels: string[];
  lastSeenAt: string | null;
  lastSeenMs: number;
  activeRecent: boolean;
}

export interface BoardHealthResponse {
  ok: boolean;
  boardOnline: boolean;
  cockpitOnline: boolean;
  brainOnline: boolean;
  synthReady?: boolean;
  totals: {
    channels: number;
    threads: number;
    messages: number;
    openTasks: number;
    blocked: number;
  };
  dispatcher: unknown;
  seats: unknown[];
  mesh: unknown;
}

export interface BoardRoomsResponse {
  rooms: BoardRoom[];
  groups: BoardRoomGroup[];
  total: number;
}

export interface RoomThreadsOptions {
  channel: string;
  limit?: number;
  state?: "all" | "open" | "blocked";
  q?: string;
  signalOnly?: boolean;
}

export interface BoardRoomThreadsResponse {
  channel: string;
  threads: BoardMessageItem[];
  total: number;
  signalCount: number;
  telemetryCount: number;
}

export type RoomThreadsResponse = BoardRoomThreadsResponse;

export interface BoardThreadResponse {
  root: BoardMessageItem;
  replies: BoardMessageItem[];
  runs: unknown[];
  pause: unknown | null;
}

export interface FeedOptions {
  limit?: number;
  channel?: string;
  author?: string;
  q?: string;
  signalOnly?: boolean;
}

export interface BoardFeedResponse {
  items: BoardMessageItem[];
  latestId: number;
  signalCount: number;
  telemetryCount: number;
}

export type FeedResponse = BoardFeedResponse;

export interface BoardAgentsResponse {
  agents: AgentPresenceItem[];
  meshNodes: unknown[];
  seats: unknown[];
  capacityBlockers: string[];
  activeRuns: unknown[];
}

export interface BoardBlockersResponse {
  counts: {
    orchestratorQueue: number;
    escalations: number;
    paused: number;
    stalled: number;
    intake: number;
    attentionTotal: number;
  };
  orchestratorQueue: unknown[];
  escalations: unknown[];
  paused: unknown[];
  stalled: unknown[];
  intake: unknown[];
}

export interface PostMessageRequest {
  channel: string;
  text: string;
  labels?: Record<string, string>;
  idempotencyKey?: string;
}

export interface PostMessageResponse {
  ok: true;
  id: string;
  channel: string;
  raw: unknown;
}

export interface ReplyToThreadRequest {
  threadId: string;
  text: string;
  resumePaused?: boolean;
}

export interface ReplyToThreadResponse {
  ok: true;
  id: string;
  threadId: string;
}

interface RawMessageRow {
  id: number;
  event_id: string;
  channel: string;
  re: number | null;
  by_actor: string;
  by_principal: string;
  by_profile: string | null;
  from_key: string | null;
  no_sync: number;
  text_lower: string;
  deleted: number;
  created_at: number;
  replies: number;
  at: number | null;
  data: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

interface UpstreamFetchResult {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
}

interface UpstreamSnapshotSlot {
  key: string;
  url: string;
  hasValue: boolean;
  result: UpstreamFetchResult;
  fetchedAt: number;
  inFlight: Promise<UpstreamFetchResult> | null;
}

interface SqliteMemoBucket {
  dataVersion: number;
  totals: {
    channels: number;
    threads: number;
    messages: number;
    openTasks: number;
    blocked: number;
  } | null;
  allRooms: BoardRoom[] | null;
  roomsQueries: Map<string, BoardRoomsResponse>;
  roomThreadsQueries: Map<string, BoardRoomThreadsResponse>;
  feedQueries: Map<string, BoardFeedResponse>;
  agentSql: {
    actorRows: Array<{
      by_actor: string;
      by_principal: string;
      by_profile: string | null;
      messages_count: number;
      threads_started: number;
      replies_count: number;
      channels_count: number;
      last_seen_ms: number;
    }>;
    recentChannelsByActor: Map<string, string[]>;
  } | null;
  fallbackBlockers: BoardBlockersResponse | null;
}

const DEFAULT_UPSTREAM_POLL_MS = 2_000;
const DEFAULT_UPSTREAM_IDLE_STOP_MS = 60_000;
const SQL_MEMO_MAX_ENTRIES = 64;

export function stripEmDashes(input: string): string {
  return String(input ?? "")
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2014/g, "-");
}

export function assertLoopbackUrl(rawUrl: string, label: string): string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new BadRequestError(`${label} must be a non-empty loopback URL`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new BadRequestError(`${label} is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BadRequestError(`${label} must use http or https protocol`);
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestError(`${label} must not embed credentials`);
  }
  const host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new BadRequestError(
      `${label} must target a loopback host (127.0.0.1, localhost, or ::1), got "${parsed.hostname}"`,
    );
  }
  if (parsed.port === FORBIDDEN_RELAY_PORT) {
    throw new BadRequestError(
      `${label} must never target port ${FORBIDDEN_RELAY_PORT} (external relay is forbidden)`,
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function validateChannel(channel: string): string {
  const clean = String(channel ?? "").trim();
  if (!CHANNEL_RE.test(clean)) {
    throw new BadRequestError(
      "Invalid channel name: expected lowercase slug or group/slug (e.g. box/work)",
    );
  }
  return clean;
}

export function validateThreadId(threadId: string): string {
  const clean = String(threadId ?? "").trim();
  if (!clean || clean.length > MAX_THREAD_ID_CHARS) {
    throw new BadRequestError(
      "Invalid threadId: expected numeric id or non-empty event_id (max 180 chars)",
    );
  }
  if (/[\x00-\x1f\x7f/\\\s]/.test(clean) || clean.startsWith("-")) {
    throw new BadRequestError(
      "Invalid threadId: contains control characters, slashes, whitespace, or leading dash",
    );
  }
  return clean;
}

export function validateMessageText(text: string): string {
  if (typeof text !== "string") {
    throw new BadRequestError("Message text must be a string");
  }
  const stripped = text.replace(/\0/g, "").trim();
  if (stripped.length === 0) {
    throw new BadRequestError("Message text must not be empty");
  }
  if (stripped.length > MAX_TEXT_CHARS) {
    throw new BadRequestError(
      `Message text exceeds maximum length of ${MAX_TEXT_CHARS} characters`,
    );
  }
  return stripped;
}

function validateLabels(
  labels?: Record<string, string>,
): Array<[string, string]> {
  if (!labels) return [];
  if (typeof labels !== "object" || Array.isArray(labels)) {
    throw new BadRequestError("Labels must be a key-value object");
  }
  const out: Array<[string, string]> = [];
  for (const [rawKey, rawVal] of Object.entries(labels)) {
    const key = String(rawKey ?? "").replace(/\0/g, "").trim();
    const val = String(rawVal ?? "").replace(/\0/g, "").trim();
    if (!LABEL_KEY_RE.test(key) || key.startsWith("-")) {
      throw new BadRequestError(`Invalid label key: "${key}"`);
    }
    if (!val || val.length > MAX_LABEL_VALUE_CHARS || /[\r\n]/.test(val)) {
      throw new BadRequestError(`Invalid label value for "${key}"`);
    }
    out.push([key, val]);
  }
  return out;
}

function validateIdempotencyKey(key?: string): string | null {
  if (key === undefined || key === null || key === "") return null;
  const clean = String(key).replace(/\0/g, "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(clean) || clean.startsWith("-")) {
    throw new BadRequestError("Invalid idempotencyKey format");
  }
  return clean;
}

export function classifyChannelGroup(channel: string): string {
  const p = String(channel ?? "");
  const head = p.split("/")[0];
  if (KNOWN_TOP_GROUPS.has(head)) return head;
  if (p.includes("/")) return "projects";
  return "other";
}

export function getGroupLabel(groupId: string): string {
  return GROUP_LABELS[groupId] || stripEmDashes(groupId);
}

function titleCaseSlug(slug: string): string {
  const acronyms: Record<string, string> = {
    ui: "UI",
    ux: "UX",
    ai: "AI",
    api: "API",
    os: "OS",
    db: "DB",
    sse: "SSE",
    pr: "PR",
    qa: "QA",
  };
  return stripEmDashes(slug)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => {
      const low = part.toLowerCase();
      if (acronyms[low]) return acronyms[low];
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(" ");
}

const TELEMETRY_LABEL_TOKENS = new Set([
  "telemetry",
  "heartbeat",
  "cron",
  "sync",
  "auto",
  "ping",
]);

const BOX_TELEMETRY_PATTERNS: RegExp[] = [
  /^(?:[a-z0-9_.:-]{2,32}\s+)?woke\s+up(?:\b.*)?$/i,
  /^fleet\s+health\s+changed\s*:/i,
  /^(?:[a-z0-9_.:-]{2,32}\s+)?added\s+[A-Z]{1,6}(?:[.-][A-Z0-9]{1,4})?(?:\s*,\s*(?:[a-z0-9_.:-]{2,32}\s+)?added\s+[A-Z]{1,6}(?:[.-][A-Z0-9]{1,4})?)*$/,
  /^heavy\s+job\s+done(?:\b.*)?$/i,
];

function hasTelemetryLabel(labels: Record<string, string> | null | undefined): boolean {
  if (!labels) return false;
  for (const [rawKey, rawVal] of Object.entries(labels)) {
    const k = String(rawKey ?? "").trim().toLowerCase();
    const v = String(rawVal ?? "").trim().toLowerCase();
    if (TELEMETRY_LABEL_TOKENS.has(k) || TELEMETRY_LABEL_TOKENS.has(v)) {
      return true;
    }
  }
  return false;
}

export function isTelemetryMessage(
  item: Pick<
    BoardMessageItem,
    "channel" | "text" | "labels" | "replies" | "isBlocked" | "isPaused"
  >,
): boolean {
  if (item.isBlocked || item.isPaused) return false;
  if ((Number(item.replies) || 0) > 0) return false;

  if (hasTelemetryLabel(item.labels)) {
    return true;
  }

  const normalizedChannel = String(item.channel ?? "")
    .trim()
    .replace(/^#/, "")
    .toLowerCase();
  if (normalizedChannel === "box") {
    const trimmed = String(item.text ?? "").trim();
    if (trimmed.length > 0 && trimmed.length <= 240) {
      for (const pattern of BOX_TELEMETRY_PATTERNS) {
        if (pattern.test(trimmed)) return true;
      }
    }
  }

  return false;
}

function unwrapActorRef(raw: string): string {
  const trimmed = String(raw ?? "").trim();
  const bracketed = /^@\[(.+)\]$/.exec(trimmed);
  return (bracketed ? bracketed[1] : trimmed).trim();
}

function extractActorSlug(actor: string, profile: string | null): string | null {
  if (profile && profile.trim()) {
    return unwrapActorRef(profile).replace(/^@+/, "");
  }
  const clean = unwrapActorRef(actor).replace(/^@+/, "");
  if (!clean) return null;
  if (/^tailscale:user:[^:+@]+(?:\+[^:@]+)?@[^:]+$/i.test(clean)) {
    return null;
  }
  if (clean.includes("+")) {
    const afterPlus = clean.split("+").slice(1).join("+").trim();
    return afterPlus || null;
  }
  const colonMatch = /^(?:local|tailscale):user:[^:+]+:(.+)$/i.exec(clean);
  if (colonMatch && colonMatch[1]) {
    return colonMatch[1].trim() || null;
  }
  if (/^(?:local|tailscale):user:[^:+]+$/i.test(clean)) {
    return null;
  }
  return clean;
}

export function classifyAgentIdentity(
  byActor: string,
  byPrincipal: string,
  byProfile: string | null,
): { handle: string; displayName: string; role: AgentRole; brand: AgentBrand } {
  const actor = unwrapActorRef(byActor);
  const principal = unwrapActorRef(byPrincipal);
  const profile = byProfile ? unwrapActorRef(byProfile) : null;

  const derivedProfile = extractActorSlug(actor, profile);
  const lower = (derivedProfile || "").toLowerCase();
  const principalLower = principal.toLowerCase();
  const actorLower = actor.toLowerCase();

  if (
    !derivedProfile &&
    (principalLower === "local:user:ubuntu" ||
      principalLower.startsWith("tailscale:user:") ||
      actorLower.startsWith("tailscale:user:") ||
      /^(?:local|tailscale):user:[^:+]+$/i.test(actorLower))
  ) {
    const handle =
      principalLower.startsWith("tailscale:user:") ||
      actorLower.startsWith("tailscale:user:")
        ? "owner"
        : "ubuntu";
    return { handle, displayName: "Owner", role: "owner", brand: "owner" };
  }

  if (
    lower === "owner" ||
    lower === "ubuntu"
  ) {
    return {
      handle: derivedProfile || "owner",
      displayName: "Owner",
      role: "owner",
      brand: "owner",
    };
  }

  if (lower.includes("claude")) {
    const short = (derivedProfile || "")
      .replace(/^(?:w-)?claude[-_]?/i, "")
      .trim();
    return {
      handle: derivedProfile || actor,
      displayName: short ? `Claude · ${short}` : "Claude",
      role: "claude",
      brand: "claude",
    };
  }

  if (lower.includes("codex") || lower.includes("scout-fleet")) {
    let displayName: string;
    if (lower.includes("codex")) {
      const short = (derivedProfile || "")
        .replace(/^(?:w-)?codex[-_]?/i, "")
        .trim();
      displayName = short ? `Codex · ${short}` : "Codex";
    } else {
      displayName = titleCaseSlug(derivedProfile || "codex");
    }
    return {
      handle: derivedProfile || actor,
      displayName,
      role: "codex",
      brand: "codex",
    };
  }

  if (
    lower === "scribe-ui" ||
    lower === "scribe-web" ||
    lower === "scribe-motion" ||
    lower === "scribe-films" ||
    lower === "scribe-video" ||
    lower === "scribe-playbook" ||
    lower === "dreamer" ||
    lower.includes("dreamer") ||
    lower.includes("design") ||
    lower.includes("visual") ||
    lower.includes("neon") ||
    lower.includes("antigravity") ||
    lower.includes("rabbit")
  ) {
    const displayName =
      lower === "antigravity-swarm"
        ? "Antigravity Swarm"
        : lower === "antigravity"
          ? "Antigravity"
          : titleCaseSlug(derivedProfile || "designer");
    return {
      handle: derivedProfile || actor,
      displayName,
      role: "designer",
      brand: "designer",
    };
  }

  if (
    lower.includes("board-keeper") ||
    lower.includes("orchestrator") ||
    lower.includes("brain") ||
    lower === "kizuki" ||
    lower === "dispatch" ||
    lower === "daemon" ||
    lower.startsWith("daemon-")
  ) {
    const displayName =
      lower === "daemon"
        ? "Daemon"
        : titleCaseSlug(derivedProfile || "brain");
    return {
      handle: derivedProfile || actor,
      displayName,
      role: "daemon",
      brand: "brain",
    };
  }

  if (lower === "scribe" || lower.startsWith("scribe-")) {
    return {
      handle: derivedProfile || actor,
      displayName: titleCaseSlug(derivedProfile || "worker"),
      role: "worker",
      brand: "worker",
    };
  }

  if (derivedProfile) {
    return {
      handle: derivedProfile,
      displayName: titleCaseSlug(derivedProfile),
      role: "worker",
      brand: "worker",
    };
  }

  return {
    handle: actor || "bot",
    displayName: titleCaseSlug(actor || "bot"),
    role: "bot",
    brand: "bot",
  };
}

const RAW_BOARD_MENTION_RE =
  /@\[(?:local|tailscale):user:[^+\]]+(?:\+([^\]]+))?\]/g;

export function humanizeMentions(text: string): string {
  return String(text ?? "").replace(
    RAW_BOARD_MENTION_RE,
    (_match, slug?: string) => (slug ? `@${slug}` : "@owner"),
  );
}

function makeExcerpt(text: string, maxLen = 140): string {
  const clean = stripEmDashes(humanizeMentions(String(text ?? "")))
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxLen) return clean;
  const slice = clean.slice(0, maxLen - 3);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:.\-/\s]+$/, "")}...`;
}

function makeTitle(text: string): string {
  const firstLine = humanizeMentions(String(text ?? ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const clean = stripEmDashes(firstLine || "").replace(/\s+/g, " ").trim();
  if (clean.length <= 140) return clean;
  const slice = clean.slice(0, 137);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= 80 ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:.\-/\s]+$/, "")}...`;
}

function toIso(epochMs: number | null | undefined, fallbackIso?: unknown): string {
  if (typeof fallbackIso === "string" && fallbackIso.trim()) {
    return fallbackIso;
  }
  const ms = Number(epochMs);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

function normalizeLabelsRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function parseBoardTask(rawTask: unknown, labels: Record<string, string>): BoardTaskInfo | null {
  if (!rawTask || typeof rawTask !== "object" || Array.isArray(rawTask)) {
    const labelState = labels["board.task"];
    if (!labelState) return null;
    return {
      state: labelState,
      owner: null,
      by: null,
      for: null,
      needs: [],
      epoch: null,
      claim: null,
      blocked: null,
      result: null,
      reason: null,
    };
  }
  const t = rawTask as Record<string, unknown>;
  const blockedRaw =
    t.blocked && typeof t.blocked === "object" && !Array.isArray(t.blocked)
      ? (t.blocked as Record<string, unknown>)
      : null;
  return {
    state: typeof t.state === "string" ? t.state : labels["board.task"] ?? null,
    owner: typeof t.owner === "string" ? t.owner : null,
    by: typeof t.by === "string" ? t.by : null,
    for: typeof t.for === "string" ? t.for : null,
    needs: Array.isArray(t.needs) ? t.needs.map(String) : [],
    epoch: typeof t.epoch === "number" ? t.epoch : null,
    claim: t.claim ?? null,
    blocked: blockedRaw
      ? {
          kind: typeof blockedRaw.kind === "string" ? blockedRaw.kind : undefined,
          reason:
            typeof blockedRaw.reason === "string"
              ? stripEmDashes(blockedRaw.reason)
              : undefined,
        }
      : null,
    result: typeof t.result === "string" ? t.result : null,
    reason: typeof t.reason === "string" ? t.reason : null,
  };
}

function rowToMessageItem(row: RawMessageRow): BoardMessageItem {
  let parsed: Record<string, unknown> = {};
  try {
    const obj = JSON.parse(row.data);
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const byObj =
    parsed.by && typeof parsed.by === "object" && !Array.isArray(parsed.by)
      ? (parsed.by as Record<string, unknown>)
      : {};
  const byActor =
    typeof byObj.actor === "string" && byObj.actor ? byObj.actor : row.by_actor;
  const byPrincipal =
    typeof byObj.principal === "string" && byObj.principal
      ? byObj.principal
      : row.by_principal;
  const byProfile =
    typeof byObj.profile === "string" && byObj.profile
      ? byObj.profile
      : row.by_profile;

  const identity = classifyAgentIdentity(byActor, byPrincipal, byProfile);
  const labels = normalizeLabelsRecord(parsed.labels);
  const task = parseBoardTask(parsed.task, labels);
  const taskState = task?.state ?? labels["board.task"] ?? null;
  const isFinished = taskState !== null && FINISHED_TASK_STATES.has(taskState);
  const isPaused = !isFinished && Boolean(labels.pause);
  const isBlocked =
    !isFinished &&
    (taskState === "blocked" || isPaused || Boolean(labels.escalation));
  const isOpenTask =
    !isFinished &&
    ((taskState !== null && OPEN_TASK_STATES.has(taskState)) || isPaused);

  const text = typeof parsed.text === "string" ? parsed.text : row.text_lower;
  const createdAtMs = Number(row.created_at) || 0;
  // In local.db, `at` can be a small message sequence ID (e.g. 2642), not epoch ms.
  // Only treat `at` as an epoch timestamp if it is >= 1e12 (year 2001+ in ms).
  const rawAt = row.at != null ? Number(row.at) : NaN;
  const lastAtMs = Number.isFinite(rawAt) && rawAt >= 1e12 ? rawAt : createdAtMs;

  return {
    id: String(row.id),
    numericId: row.id,
    eventId: row.event_id,
    channel: row.channel,
    re: row.re === null || row.re === undefined ? null : String(row.re),
    replyTo:
      parsed.replyTo === null || parsed.replyTo === undefined
        ? null
        : String(parsed.replyTo),
    thread: typeof parsed.thread === "string" ? parsed.thread : null,
    title: makeTitle(text),
    text,
    by: identity.handle,
    displayName: identity.displayName,
    byActor,
    byPrincipal,
    byProfile,
    role: identity.role,
    brand: identity.brand,
    labels,
    reactions:
      parsed.reactions &&
      typeof parsed.reactions === "object" &&
      !Array.isArray(parsed.reactions)
        ? (parsed.reactions as Record<string, unknown>)
        : {},
    attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
    links: Array.isArray(parsed.links) ? parsed.links : [],
    replies: Number(row.replies) || 0,
    createdAt: toIso(createdAtMs, parsed.createdAt),
    createdAtMs,
    editedAt: typeof parsed.editedAt === "string" ? parsed.editedAt : null,
    lastAt: toIso(lastAtMs),
    lastAtMs,
    task,
    taskState,
    isBlocked,
    isPaused,
    isOpenTask,
  };
}

function runFallbackSecretPatterns(content: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of FALLBACK_SECRET_PATTERNS) {
    if (rule.re.test(content)) {
      findings.push({ ruleId: rule.ruleId, description: rule.description });
    }
  }
  return findings;
}

export function createGitleaksSecretScanner(gitleaksBinPath: string): SecretScanner {
  return (content: string): SecretScanResult => {
    let proc: ReturnType<typeof Bun.spawnSync>;
    try {
      proc = Bun.spawnSync(
        [
          gitleaksBinPath,
          "stdin",
          "--redact",
          "--no-banner",
          "--no-color",
          "--log-level",
          "fatal",
          "--exit-code",
          "9",
          "--report-format",
          "json",
          "--report-path",
          "-",
        ],
        {
          stdin: new TextEncoder().encode(content),
          stdout: "pipe",
          stderr: "pipe",
        },
      );
    } catch (err) {
      return {
        blocked: true,
        findings: [],
        error: `Secret scanner failed to execute: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (proc.exitCode === 9) {
      const findings: SecretFinding[] = [];
      try {
        const rawOut = new TextDecoder().decode(proc.stdout).trim();
        if (rawOut) {
          const parsed = JSON.parse(rawOut);
          if (Array.isArray(parsed)) {
            for (const item of parsed) {
              if (item && typeof item === "object") {
                const rec = item as Record<string, unknown>;
                findings.push({
                  ruleId: String(rec.RuleID ?? "gitleaks-rule"),
                  description: stripEmDashes(
                    String(rec.Description ?? "Secret detected by gitleaks"),
                  ),
                });
              }
            }
          }
        }
      } catch {
        findings.push({
          ruleId: "gitleaks-secret",
          description: "Secret detected by gitleaks",
        });
      }
      return {
        blocked: true,
        findings:
          findings.length > 0
            ? findings
            : [{ ruleId: "gitleaks-secret", description: "Secret detected by gitleaks" }],
      };
    }

    if (proc.exitCode !== 0) {
      return {
        blocked: true,
        findings: [],
        error: `Secret scanner exited unexpectedly with code ${proc.exitCode}`,
      };
    }

    const extraFindings = runFallbackSecretPatterns(content);
    if (extraFindings.length > 0) {
      return { blocked: true, findings: extraFindings };
    }

    return { blocked: false, findings: [] };
  };
}

async function defaultVbExecutor(
  argv: string[],
  opts?: { env?: Record<string, string>; stdin?: string },
): Promise<VbExecResult> {
  const proc = Bun.spawn(argv, {
    stdin:
      opts?.stdin !== undefined
        ? new Response(opts.stdin)
        : undefined,
    stdout: "pipe",
    stderr: "pipe",
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { exitCode, stdout, stderr };
}

function parseJsonSafe(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export class KizukiAgentBoardApi {
  readonly dbPath: string;
  readonly boardUrl: string;
  readonly cockpitApiUrl: string;
  readonly brainApiUrl: string;
  readonly vbBinPath: string;
  readonly gitleaksBinPath: string;

  private readonly fetchImpl: typeof fetch;
  private readonly execVb: VbExecutor;
  private readonly secretScanner: SecretScanner;
  private readonly fetchTimeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly upstreamPollMs: number;
  private readonly upstreamIdleStopMs: number;

  private db: Database | null = null;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly upstreamSlots = new Map<string, UpstreamSnapshotSlot>();
  private readonly activeUpstreamKeys = new Set<string>();
  private upstreamPollTimer: ReturnType<typeof setInterval> | null = null;
  private lastUpstreamReadAt = 0;
  private closed = false;
  private sqlMemo: SqliteMemoBucket | null = null;

  constructor(opts: Partial<AgentBoardConfig> = {}) {
    this.dbPath = opts.dbPath || DEFAULT_AGENT_BOARD_DB_PATH;
    this.boardUrl = assertLoopbackUrl(
      opts.boardUrl || DEFAULT_BOARD_URL,
      "boardUrl",
    );
    this.cockpitApiUrl = assertLoopbackUrl(
      opts.cockpitApiUrl || DEFAULT_COCKPIT_API_URL,
      "cockpitApiUrl",
    );
    this.brainApiUrl = assertLoopbackUrl(
      opts.brainApiUrl || DEFAULT_BRAIN_API_URL,
      "brainApiUrl",
    );
    this.vbBinPath = opts.vbBinPath || DEFAULT_VB_BIN_PATH;
    this.gitleaksBinPath = opts.gitleaksBinPath || DEFAULT_GITLEAKS_BIN_PATH;
    this.fetchImpl = opts.fetchImpl || globalThis.fetch.bind(globalThis);
    this.execVb = opts.execVb || defaultVbExecutor;
    this.secretScanner =
      opts.secretScanner || createGitleaksSecretScanner(this.gitleaksBinPath);
    this.fetchTimeoutMs = Math.max(250, opts.fetchTimeoutMs ?? 2500);
    this.cacheTtlMs = Math.max(0, opts.cacheTtlMs ?? 3000);
    this.upstreamPollMs = Math.max(250, opts.upstreamPollMs ?? DEFAULT_UPSTREAM_POLL_MS);
    this.upstreamIdleStopMs = Math.max(
      this.upstreamPollMs,
      opts.upstreamIdleStopMs ?? DEFAULT_UPSTREAM_IDLE_STOP_MS,
    );
  }

  close(): void {
    this.closed = true;
    this.stopUpstreamPoller();
    this.activeUpstreamKeys.clear();
    this.upstreamSlots.clear();
    this.sqlMemo = null;
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore close errors
      }
      this.db = null;
    }
    this.cache.clear();
  }

  getCockpitStreamUrl(): string {
    return `${this.cockpitApiUrl}/api/cc/stream`;
  }

  getDb(): Database {
    return this.openDb();
  }

  getDataVersion(): number {
    const db = this.openDb();
    return this.readDataVersion(db);
  }

  private readDataVersion(db: Database): number {
    try {
      const row = db.query("PRAGMA data_version").get() as { data_version?: number } | null;
      return Number(row?.data_version) || 0;
    } catch {
      return 0;
    }
  }

  private getSqlMemoBucket(db: Database): SqliteMemoBucket {
    const dataVersion = this.readDataVersion(db);
    if (this.sqlMemo && this.sqlMemo.dataVersion === dataVersion) {
      return this.sqlMemo;
    }
    this.sqlMemo = {
      dataVersion,
      totals: null,
      allRooms: null,
      roomsQueries: new Map(),
      roomThreadsQueries: new Map(),
      feedQueries: new Map(),
      agentSql: null,
      fallbackBlockers: null,
    };
    return this.sqlMemo;
  }

  private setBoundedMemo<T>(map: Map<string, T>, key: string, value: T): T {
    if (map.size >= SQL_MEMO_MAX_ENTRIES) {
      const firstKey = map.keys().next().value;
      if (firstKey !== undefined) {
        map.delete(firstKey);
      }
    }
    map.set(key, value);
    return value;
  }

  private stopUpstreamPoller(): void {
    if (this.upstreamPollTimer !== null) {
      clearInterval(this.upstreamPollTimer);
      this.upstreamPollTimer = null;
    }
  }

  private ensureUpstreamPoller(): void {
    if (this.closed || this.cacheTtlMs <= 0 || this.upstreamPollTimer !== null) {
      return;
    }
    const timer = setInterval(() => {
      if (this.closed) {
        this.stopUpstreamPoller();
        return;
      }
      if (
        this.activeUpstreamKeys.size === 0 ||
        Date.now() - this.lastUpstreamReadAt >= this.upstreamIdleStopMs
      ) {
        this.stopUpstreamPoller();
        return;
      }
      for (const key of this.activeUpstreamKeys) {
        const slot = this.upstreamSlots.get(key);
        if (slot && !slot.inFlight) {
          void this.refreshUpstreamSlot(slot);
        }
      }
    }, this.upstreamPollMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.upstreamPollTimer = timer;
  }

  private getOrCreateUpstreamSlot(key: string, url: string): UpstreamSnapshotSlot {
    let slot = this.upstreamSlots.get(key);
    if (!slot) {
      slot = {
        key,
        url,
        hasValue: false,
        result: { ok: false, status: 0, data: null },
        fetchedAt: 0,
        inFlight: null,
      };
      this.upstreamSlots.set(key, slot);
    } else if (slot.url !== url) {
      slot.url = url;
    }
    return slot;
  }

  private refreshUpstreamSlot(slot: UpstreamSnapshotSlot): Promise<UpstreamFetchResult> {
    if (slot.inFlight) {
      return slot.inFlight;
    }
    const req = this.fetchJson(slot.url)
      .then((res) => {
        if (!this.closed) {
          slot.result = res;
          slot.hasValue = true;
          slot.fetchedAt = Date.now();
        }
        return res;
      })
      .finally(() => {
        if (slot.inFlight === req) {
          slot.inFlight = null;
        }
      });
    slot.inFlight = req;
    return req;
  }

  private readUpstreamSnapshot(key: string, url: string): Promise<UpstreamFetchResult> | UpstreamFetchResult {
    if (this.cacheTtlMs <= 0) {
      return this.fetchJson(url);
    }
    this.lastUpstreamReadAt = Date.now();
    this.activeUpstreamKeys.add(key);
    const slot = this.getOrCreateUpstreamSlot(key, url);
    this.ensureUpstreamPoller();

    if (slot.hasValue) {
      if (
        !this.closed &&
        !slot.inFlight &&
        Date.now() - slot.fetchedAt >= this.upstreamPollMs
      ) {
        void this.refreshUpstreamSlot(slot);
      }
      return slot.result;
    }
    return this.refreshUpstreamSlot(slot);
  }

  refreshUpstreamsNow(keys?: string[]): void {
    if (this.closed || this.cacheTtlMs <= 0) return;
    const targets = keys && keys.length > 0 ? keys : Array.from(this.activeUpstreamKeys);
    for (const key of targets) {
      const slot = this.upstreamSlots.get(key);
      if (slot && !slot.inFlight) {
        void this.refreshUpstreamSlot(slot);
      }
    }
  }

  getUpstreamSnapshotStats(): {
    polling: boolean;
    activeKeys: string[];
    warmKeys: string[];
    lastReadAt: number;
  } {
    const warmKeys: string[] = [];
    for (const [key, slot] of this.upstreamSlots.entries()) {
      if (slot.hasValue) warmKeys.push(key);
    }
    return {
      polling: this.upstreamPollTimer !== null,
      activeKeys: Array.from(this.activeUpstreamKeys).sort(),
      warmKeys: warmKeys.sort(),
      lastReadAt: this.lastUpstreamReadAt,
    };
  }

  private invalidateAfterWrite(): void {
    this.cache.clear();
    this.sqlMemo = null;
    for (const slot of this.upstreamSlots.values()) {
      slot.hasValue = false;
      slot.fetchedAt = 0;
    }
  }

  private openDb(): Database {
    if (this.db) return this.db;
    if (!existsSync(this.dbPath)) {
      throw new ServiceUnavailableError(
        `Agent Board database not found at ${this.dbPath}`,
      );
    }
    const db = new Database(this.dbPath, { readonly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
    this.db = db;
    return db;
  }

  private getCached<T>(key: string): T | undefined {
    if (this.cacheTtlMs <= 0) return undefined;
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    if (Date.now() > hit.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  private setCached<T>(key: string, value: T): T {
    if (this.cacheTtlMs > 0) {
      this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
    }
    return value;
  }

  private async fetchJson(
    url: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
    assertLoopbackUrl(url, "upstream request URL");
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.fetchTimeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        ...init,
        signal: ac.signal,
      });
      const text = await res.text();
      const parsed = parseJsonSafe(text);
      const data =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private async getCachedUpstreamJson(
    cacheKey: string,
    url: string,
  ): Promise<Record<string, unknown> | null> {
    const cached = this.getCached<Record<string, unknown> | null>(cacheKey);
    if (cached !== undefined) return cached;
    const res = await this.fetchJson(url);
    if (!res.ok || !res.data) return null;
    return this.setCached(cacheKey, res.data);
  }

  private async assertNoSecrets(content: string): Promise<void> {
    let result: SecretScanResult;
    try {
      result = await this.secretScanner(content);
    } catch (err) {
      throw new SecretDetectedError(
        `Write blocked: secret scanner failed (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    if (!result || result.blocked) {
      const rules = (result?.findings ?? [])
        .map((f) => f.ruleId)
        .filter(Boolean);
      const detail = result?.error
        ? stripEmDashes(result.error)
        : rules.length > 0
          ? `Detected secret pattern (${rules.join(", ")})`
          : "Secret detected in outgoing message";
      throw new SecretDetectedError(`Write blocked: ${detail}`, result?.findings ?? []);
    }
  }

  private computeSqliteTotals(): {
    channels: number;
    threads: number;
    messages: number;
    openTasks: number;
    blocked: number;
  } {
    const db = this.openDb();
    const memo = this.getSqlMemoBucket(db);
    if (memo.totals) {
      return memo.totals;
    }

    const counts = db
      .query(
        `SELECT
           COUNT(*) AS messages,
           COALESCE(SUM(CASE WHEN re IS NULL THEN 1 ELSE 0 END), 0) AS threads,
           COUNT(DISTINCT channel) AS channels
         FROM board_messages
         WHERE deleted = 0`,
      )
      .get() as { messages: number; threads: number; channels: number } | null;

    const rootRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0
           AND re IS NULL
           AND (
             instr(data, '"task":{') > 0
             OR instr(data, '"board.task"') > 0
             OR instr(data, '"pause"') > 0
             OR instr(data, '"escalation"') > 0
           )`,
      )
      .all() as RawMessageRow[];

    let openTasks = 0;
    let blocked = 0;
    for (const row of rootRows) {
      const item = rowToMessageItem(row);
      if (item.isOpenTask) openTasks += 1;
      if (item.isBlocked) blocked += 1;
    }

    memo.totals = {
      channels: Number(counts?.channels) || 0,
      threads: Number(counts?.threads) || 0,
      messages: Number(counts?.messages) || 0,
      openTasks,
      blocked,
    };
    return memo.totals;
  }

  async getHealth(): Promise<BoardHealthResponse> {
    let totals = {
      channels: 0,
      threads: 0,
      messages: 0,
      openTasks: 0,
      blocked: 0,
    };
    let dbOk = false;
    try {
      totals = this.computeSqliteTotals();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const boardRes = this.readUpstreamSnapshot("board", this.boardUrl);
    const healthRes = this.readUpstreamSnapshot(
      "cc:health",
      `${this.cockpitApiUrl}/api/cc/health`,
    );
    const overviewRes = this.readUpstreamSnapshot(
      "cc:overview",
      `${this.cockpitApiUrl}/api/cc/overview`,
    );
    const brainRes = this.readUpstreamSnapshot(
      "brain:health",
      `${this.brainApiUrl}/api/brain/health`,
    );

    const [boardProbe, cockpitHealth, cockpitOverview, brainProbe] =
      boardRes instanceof Promise ||
      healthRes instanceof Promise ||
      overviewRes instanceof Promise ||
      brainRes instanceof Promise
        ? await Promise.all([boardRes, healthRes, overviewRes, brainRes])
        : [boardRes, healthRes, overviewRes, brainRes];

    const cockpitUpstreams =
      cockpitHealth.data?.upstreams &&
      typeof cockpitHealth.data.upstreams === "object"
        ? (cockpitHealth.data.upstreams as Record<string, unknown>)
        : {};
    const brainFromCockpit =
      cockpitUpstreams.brain &&
      typeof cockpitUpstreams.brain === "object" &&
      Boolean((cockpitUpstreams.brain as Record<string, unknown>).online);

    const boardOnline =
      boardProbe.ok || Boolean(cockpitHealth.data?.board_online);
    const cockpitOnline = cockpitHealth.ok && cockpitHealth.data?.ok !== false;
    const brainOnline = brainProbe.ok || brainFromCockpit;

    const dispatcher = cockpitOverview.data?.dispatcher ?? null;
    const seats = Array.isArray(cockpitOverview.data?.seats)
      ? cockpitOverview.data.seats
      : [];
    const mesh =
      cockpitOverview.data?.mesh_summary ??
      (cockpitUpstreams.mesh && typeof cockpitUpstreams.mesh === "object"
        ? cockpitUpstreams.mesh
        : null);

    return {
      ok: dbOk || boardOnline || cockpitOnline,
      boardOnline,
      cockpitOnline,
      brainOnline,
      totals,
      dispatcher,
      seats,
      mesh,
    };
  }

  private loadAllRoomsMemoized(db: Database): BoardRoom[] {
    const memo = this.getSqlMemoBucket(db);
    if (memo.allRooms) {
      return memo.allRooms;
    }

    // Direct read-only SQLite GROUP BY channel avoids cockpit :4111/api/cc/channels duplication bug.
    const aggRows = db
      .query(
        `SELECT
           channel,
           COUNT(*) AS messages,
           COALESCE(SUM(CASE WHEN re IS NULL THEN 1 ELSE 0 END), 0) AS threads,
           MAX(CASE WHEN at >= 1000000000000 THEN at ELSE created_at END) AS last_at_ms,
           MAX(id) AS last_message_id
         FROM board_messages
         WHERE deleted = 0
         GROUP BY channel`,
      )
      .all() as Array<{
      channel: string;
      messages: number;
      threads: number;
      last_at_ms: number;
      last_message_id: number;
    }>;

    const taskStatsByChannel = new Map<
      string,
      { openTasks: number; blockedTasks: number }
    >();
    const rootRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0
           AND re IS NULL
           AND (
             instr(data, '"task":{') > 0
             OR instr(data, '"board.task"') > 0
             OR instr(data, '"pause"') > 0
             OR instr(data, '"escalation"') > 0
           )`,
      )
      .all() as RawMessageRow[];

    for (const row of rootRows) {
      const item = rowToMessageItem(row);
      if (!item.isOpenTask && !item.isBlocked) continue;
      let stat = taskStatsByChannel.get(row.channel);
      if (!stat) {
        stat = { openTasks: 0, blockedTasks: 0 };
        taskStatsByChannel.set(row.channel, stat);
      }
      if (item.isOpenTask) stat.openTasks += 1;
      if (item.isBlocked) stat.blockedTasks += 1;
    }

    const latestById = new Map<number, BoardMessageItem>();
    if (aggRows.length > 0) {
      const latestIds = aggRows.map((r) => r.last_message_id);
      const placeholders = latestIds.map(() => "?").join(", ");
      const latestRows = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE id IN (${placeholders})`,
        )
        .all(...latestIds) as RawMessageRow[];
      for (const row of latestRows) {
        latestById.set(row.id, rowToMessageItem(row));
      }
    }

    memo.allRooms = aggRows.map((row) => {
      const group = classifyChannelGroup(row.channel);
      const taskStat = taskStatsByChannel.get(row.channel);
      const latest = latestById.get(row.last_message_id);
      const leafName = row.channel.includes("/")
        ? row.channel.split("/").slice(1).join("/")
        : row.channel;

      const lastAtMs = Number(row.last_at_ms) || 0;
      const guardedLastAtMs = lastAtMs >= 1e12 ? lastAtMs : (latest?.lastAtMs ?? lastAtMs);

      return {
        channel: row.channel,
        name: leafName,
        group,
        groupLabel: getGroupLabel(group),
        messages: Number(row.messages) || 0,
        threads: Number(row.threads) || 0,
        openTasks: taskStat?.openTasks ?? 0,
        blockedTasks: taskStat?.blockedTasks ?? 0,
        lastAt: guardedLastAtMs ? new Date(guardedLastAtMs).toISOString() : null,
        lastAtMs: guardedLastAtMs,
        lastMessageId: row.last_message_id,
        lastAuthor: latest?.by ?? null,
        lastBrand: latest?.brand ?? "bot",
        lastPreview: latest?.title ?? "",
      };
    });
    return memo.allRooms;
  }

  listRooms(opts: {
    group?: string;
    q?: string;
    sort?: "recent" | "volume" | "alpha";
  } = {}): BoardRoomsResponse {
    const db = this.openDb();
    const memo = this.getSqlMemoBucket(db);
    const q = (opts.q || "").trim().toLowerCase();
    const groupFilter = (opts.group || "").trim().toLowerCase();
    const sort = opts.sort || "recent";
    const cacheKey = `${groupFilter}|${sort}|${q}`;
    const cached = memo.roomsQueries.get(cacheKey);
    if (cached) {
      return cached;
    }

    const allRooms = this.loadAllRoomsMemoized(db);

    const searchedRooms = q
      ? allRooms.filter(
          (room) =>
            room.channel.toLowerCase().includes(q) ||
            room.group.toLowerCase().includes(q) ||
            room.groupLabel.toLowerCase().includes(q) ||
            room.lastPreview.toLowerCase().includes(q) ||
            (room.lastAuthor || "").toLowerCase().includes(q),
        )
      : allRooms;

    const groupCounts = new Map<string, number>();
    for (const room of searchedRooms) {
      groupCounts.set(room.group, (groupCounts.get(room.group) || 0) + 1);
    }

    const groups: BoardRoomGroup[] = Array.from(groupCounts.entries())
      .map(([id, count]) => ({ id, label: getGroupLabel(id), count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const filtered = (
      groupFilter && groupFilter !== "all"
        ? searchedRooms.filter((r) => r.group === groupFilter)
        : searchedRooms
    ).slice();

    filtered.sort((a, b) => {
      if (sort === "alpha") {
        return a.channel.localeCompare(b.channel);
      }
      if (sort === "volume") {
        return (
          b.messages - a.messages ||
          b.lastAtMs - a.lastAtMs ||
          a.channel.localeCompare(b.channel)
        );
      }
      return (
        b.lastAtMs - a.lastAtMs ||
        b.messages - a.messages ||
        a.channel.localeCompare(b.channel)
      );
    });

    return this.setBoundedMemo(memo.roomsQueries, cacheKey, {
      rooms: filtered,
      groups,
      total: filtered.length,
    });
  }

  getRoomThreads(opts: RoomThreadsOptions): BoardRoomThreadsResponse {
    const channel = validateChannel(opts.channel);
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const state = opts.state || "all";
    const q = (opts.q || "").trim().toLowerCase();
    const signalOnly = Boolean(opts.signalOnly);

    const db = this.openDb();
    const memo = this.getSqlMemoBucket(db);
    const cacheKey = `${channel}|${limit}|${state}|${signalOnly ? 1 : 0}|${q}`;
    const cached = memo.roomThreadsQueries.get(cacheKey);
    if (cached) {
      return cached;
    }

    const rows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0 AND re IS NULL AND channel = ?
         ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, id DESC`,
      )
      .all(channel) as RawMessageRow[];

    const matchedItems = rows.map(rowToMessageItem).filter((item) => {
      if (state === "open" && !item.isOpenTask) return false;
      if (state === "blocked" && !item.isBlocked) return false;
      if (q) {
        const labelHaystack = Object.entries(item.labels)
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")
          .toLowerCase();
        const match =
          item.text.toLowerCase().includes(q) ||
          item.by.toLowerCase().includes(q) ||
          item.byActor.toLowerCase().includes(q) ||
          labelHaystack.includes(q);
        if (!match) return false;
      }
      return true;
    });

    let signalCount = 0;
    let telemetryCount = 0;
    const signalItems: BoardMessageItem[] = [];
    for (const item of matchedItems) {
      if (isTelemetryMessage(item)) {
        telemetryCount += 1;
      } else {
        signalCount += 1;
        signalItems.push(item);
      }
    }

    const visibleItems = signalOnly ? signalItems : matchedItems;
    const pageThreads = visibleItems.slice(0, limit);

    if (pageThreads.length > 0) {
      const threadIds = pageThreads.map((t) => t.numericId);
      const placeholders = threadIds.map(() => "?").join(", ");
      const replyRows = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE deleted = 0 AND re IN (${placeholders})
           ORDER BY created_at DESC, id DESC`,
        )
        .all(...threadIds) as RawMessageRow[];

      const previewsByThread = new Map<number, BoardReplyPreview[]>();
      const participantsByThread = new Map<number, Set<string>>();

      for (const thread of pageThreads) {
        previewsByThread.set(thread.numericId, []);
        const set = new Set<string>();
        if (thread.by) set.add(thread.by);
        participantsByThread.set(thread.numericId, set);
      }

      for (const replyRow of replyRows) {
        if (replyRow.re === null || replyRow.re === undefined) continue;
        const replyItem = rowToMessageItem(replyRow);
        const participants = participantsByThread.get(replyRow.re);
        if (participants && replyItem.by) {
          participants.add(replyItem.by);
        }
        const previews = previewsByThread.get(replyRow.re);
        if (previews && previews.length < 3) {
          previews.push({
            id: replyItem.id,
            by: replyItem.by,
            displayName: replyItem.displayName,
            brand: replyItem.brand,
            role: replyItem.role,
            createdAt: replyItem.createdAt,
            excerpt: makeExcerpt(replyItem.text),
          });
        }
      }

      for (const thread of pageThreads) {
        thread.replyPreview = previewsByThread.get(thread.numericId) ?? [];
        thread.participants = Array.from(
          participantsByThread.get(thread.numericId) ?? [],
        );
      }
    }

    return this.setBoundedMemo(memo.roomThreadsQueries, cacheKey, {
      channel,
      threads: pageThreads,
      total: visibleItems.length,
      signalCount,
      telemetryCount,
    });
  }

  async getThread(threadId: string): Promise<BoardThreadResponse> {
    const idStr = validateThreadId(threadId);
    const db = this.openDb();

    let rootRow: RawMessageRow | null = null;
    if (NUMERIC_THREAD_ID_RE.test(idStr)) {
      rootRow = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE id = ? AND deleted = 0`,
        )
        .get(Number(idStr)) as RawMessageRow | null;
    } else {
      rootRow = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE event_id = ? AND deleted = 0`,
        )
        .get(idStr) as RawMessageRow | null;

      if (!rootRow && idStr.startsWith("key:")) {
        const bareKey = idStr.slice(4);
        rootRow = db
          .query(
            `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                    from_key, no_sync, text_lower, deleted, created_at, replies, at, data
             FROM board_messages
             WHERE (from_key = ? OR from_key = ?) AND deleted = 0`,
          )
          .get(idStr, bareKey) as RawMessageRow | null;
      }
    }

    if (!rootRow) {
      throw new NotFoundError(`Thread #${idStr} not found`);
    }

    if (rootRow.re !== null && rootRow.re !== undefined) {
      const parentRow = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE id = ? AND deleted = 0`,
        )
        .get(rootRow.re) as RawMessageRow | null;
      if (parentRow) {
        rootRow = parentRow;
      }
    }

    const root = rowToMessageItem(rootRow);
    const replyRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE re = ? AND deleted = 0
         ORDER BY created_at ASC, id ASC`,
      )
      .all(root.numericId) as RawMessageRow[];

    const replies = replyRows.map(rowToMessageItem);

    let runs: unknown[] = [];
    let pause: unknown | null = root.isPaused
      ? { active: true, label: root.labels.pause }
      : null;

    const ccThread = await this.fetchJson(
      `${this.cockpitApiUrl}/api/cc/threads/${encodeURIComponent(root.id)}`,
    );
    if (ccThread.ok && ccThread.data?.thread && typeof ccThread.data.thread === "object") {
      const t = ccThread.data.thread as Record<string, unknown>;
      if (Array.isArray(t.runs)) {
        runs = t.runs;
      }
      if ("pause" in t) {
        pause = t.pause ?? null;
      }
    }

    return {
      root,
      replies,
      runs,
      pause,
    };
  }

  getFeed(opts: FeedOptions = {}): BoardFeedResponse {
    const limit = Math.min(200, Math.max(1, Math.floor(opts.limit ?? 50)));
    const channel = opts.channel ? validateChannel(opts.channel) : null;
    const author = (opts.author || "").trim().toLowerCase();
    const q = (opts.q || "").trim().toLowerCase();
    const signalOnly = Boolean(opts.signalOnly);

    const db = this.openDb();
    const memo = this.getSqlMemoBucket(db);
    const cacheKey = `${limit}|${channel || ""}|${author}|${signalOnly ? 1 : 0}|${q}`;
    const cached = memo.feedQueries.get(cacheKey);
    if (cached) {
      return cached;
    }

    const latestRow = db
      .query(
        `SELECT COALESCE(MAX(id), 0) AS latest_id FROM board_messages WHERE deleted = 0`,
      )
      .get() as { latest_id: number } | null;
    const latestId = Number(latestRow?.latest_id) || 0;

    const where: string[] = ["deleted = 0"];
    const params: Array<string | number> = [];

    if (channel) {
      where.push("channel = ?");
      params.push(channel);
    }
    if (author) {
      where.push(
        "(LOWER(COALESCE(by_profile, '')) = ? OR LOWER(by_actor) = ? OR LOWER(by_actor) LIKE ?)",
      );
      params.push(author, author, `%${author}%`);
    }
    if (q) {
      where.push("(text_lower LIKE ? OR LOWER(channel) LIKE ? OR LOWER(by_actor) LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const scanLimit = signalOnly ? Math.min(2000, Math.max(limit * 10, 500)) : limit;
    params.push(scanLimit);

    const rows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE ${where.join(" AND ")}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...params) as RawMessageRow[];

    const mapped = rows.map(rowToMessageItem);
    let signalCount = 0;
    let telemetryCount = 0;
    const signalItems: BoardMessageItem[] = [];
    for (const item of mapped) {
      if (isTelemetryMessage(item)) {
        telemetryCount += 1;
      } else {
        signalCount += 1;
        if (signalItems.length < limit) {
          signalItems.push(item);
        }
      }
    }

    return this.setBoundedMemo(memo.feedQueries, cacheKey, {
      items: signalOnly ? signalItems : mapped,
      latestId,
      signalCount,
      telemetryCount,
    });
  }

  private loadAgentSqlMemoized(db: Database): NonNullable<SqliteMemoBucket["agentSql"]> {
    const memo = this.getSqlMemoBucket(db);
    if (memo.agentSql) {
      return memo.agentSql;
    }

    const actorRows = db
      .query(
        `SELECT
           by_actor,
           by_principal,
           by_profile,
           COUNT(*) AS messages_count,
           COALESCE(SUM(CASE WHEN re IS NULL THEN 1 ELSE 0 END), 0) AS threads_started,
           COALESCE(SUM(CASE WHEN re IS NOT NULL THEN 1 ELSE 0 END), 0) AS replies_count,
           COUNT(DISTINCT channel) AS channels_count,
           MAX(CASE WHEN at >= 1000000000000 THEN at ELSE created_at END) AS last_seen_ms
         FROM board_messages
         WHERE deleted = 0
         GROUP BY by_actor, by_principal, by_profile
         ORDER BY last_seen_ms DESC, messages_count DESC`,
      )
      .all() as Array<{
      by_actor: string;
      by_principal: string;
      by_profile: string | null;
      messages_count: number;
      threads_started: number;
      replies_count: number;
      channels_count: number;
      last_seen_ms: number;
    }>;

    const channelActivityRows = db
      .query(
        `SELECT by_actor, channel,
                MAX(CASE WHEN at >= 1000000000000 THEN at ELSE created_at END) AS last_at
         FROM board_messages
         WHERE deleted = 0
         GROUP BY by_actor, channel
         ORDER BY last_at DESC`,
      )
      .all() as Array<{ by_actor: string; channel: string; last_at: number }>;

    const recentChannelsByActor = new Map<string, string[]>();
    for (const row of channelActivityRows) {
      let list = recentChannelsByActor.get(row.by_actor);
      if (!list) {
        list = [];
        recentChannelsByActor.set(row.by_actor, list);
      }
      if (list.length < 3) {
        list.push(row.channel);
      }
    }

    memo.agentSql = { actorRows, recentChannelsByActor };
    return memo.agentSql;
  }

  async getAgents(): Promise<BoardAgentsResponse> {
    const db = this.openDb();
    const { actorRows, recentChannelsByActor } = this.loadAgentSqlMemoized(db);

    const meshRes = this.readUpstreamSnapshot(
      "cc:mesh",
      `${this.cockpitApiUrl}/api/cc/mesh`,
    );
    const overviewRes = this.readUpstreamSnapshot(
      "cc:overview",
      `${this.cockpitApiUrl}/api/cc/overview`,
    );
    const factoryRes = this.readUpstreamSnapshot(
      "cc:factory",
      `${this.cockpitApiUrl}/api/cc/factory`,
    );

    const [meshSnap, overviewSnap, factorySnap] =
      meshRes instanceof Promise ||
      overviewRes instanceof Promise ||
      factoryRes instanceof Promise
        ? await Promise.all([meshRes, overviewRes, factoryRes])
        : [meshRes, overviewRes, factoryRes];

    const meshData = meshSnap.ok ? meshSnap.data : null;
    const overviewData = overviewSnap.ok ? overviewSnap.data : null;
    const factoryData = factorySnap.ok ? factorySnap.data : null;

    const meshNodes = Array.isArray(meshData?.nodes) ? meshData.nodes : [];
    const seats = Array.isArray(overviewData?.seats) ? overviewData.seats : [];

    const rawBlockers = Array.isArray(overviewData?.capacity_blockers)
      ? overviewData.capacity_blockers
      : Array.isArray(factoryData?.capacity_blockers)
        ? factoryData.capacity_blockers
        : [];
    const capacityBlockers = rawBlockers.map((b) => stripEmDashes(String(b)));

    const dispatcherObj =
      factoryData?.dispatcher && typeof factoryData.dispatcher === "object"
        ? (factoryData.dispatcher as Record<string, unknown>)
        : null;
    const dispatcherStatus =
      dispatcherObj?.status && typeof dispatcherObj.status === "object"
        ? (dispatcherObj.status as Record<string, unknown>)
        : null;
    const activeRuns = Array.isArray(dispatcherStatus?.running)
      ? dispatcherStatus.running
      : [];

    const recentCutoffMs = Date.now() - 60 * 60 * 1000;
    const agents: AgentPresenceItem[] = actorRows.map((row) => {
      const identity = classifyAgentIdentity(
        row.by_actor,
        row.by_principal,
        row.by_profile,
      );
      const lastSeenMs = Number(row.last_seen_ms) || 0;
      return {
        actor: row.by_actor,
        handle: identity.handle,
        displayName: identity.displayName,
        principal: row.by_principal,
        profile: row.by_profile,
        role: identity.role,
        brand: identity.brand,
        messagesCount: Number(row.messages_count) || 0,
        threadsStarted: Number(row.threads_started) || 0,
        repliesCount: Number(row.replies_count) || 0,
        channelsCount: Number(row.channels_count) || 0,
        recentChannels: recentChannelsByActor.get(row.by_actor) || [],
        lastSeenAt: lastSeenMs ? new Date(lastSeenMs).toISOString() : null,
        lastSeenMs,
        activeRecent: lastSeenMs >= recentCutoffMs,
      };
    });

    return {
      agents,
      meshNodes,
      seats,
      capacityBlockers,
      activeRuns,
    };
  }

  async getBlockers(): Promise<BoardBlockersResponse> {
    const inboxRes = this.readUpstreamSnapshot(
      "cc:inbox",
      `${this.cockpitApiUrl}/api/cc/inbox`,
    );
    const inbox = inboxRes instanceof Promise ? await inboxRes : inboxRes;
    if (inbox.ok && inbox.data && inbox.data.ok !== false) {
      const rawCounts =
        inbox.data.counts && typeof inbox.data.counts === "object"
          ? (inbox.data.counts as Record<string, unknown>)
          : {};
      const orchestratorQueue = Array.isArray(inbox.data.orchestrator_queue)
        ? inbox.data.orchestrator_queue
        : [];
      const escalations = Array.isArray(inbox.data.escalations)
        ? inbox.data.escalations
        : [];
      const paused = Array.isArray(inbox.data.paused) ? inbox.data.paused : [];
      const stalled = Array.isArray(inbox.data.stalled) ? inbox.data.stalled : [];
      const intake = Array.isArray(inbox.data.intake) ? inbox.data.intake : [];

      return {
        counts: {
          orchestratorQueue: Number(rawCounts.orchestrator_queue) || orchestratorQueue.length,
          escalations: Number(rawCounts.escalations) || escalations.length,
          paused: Number(rawCounts.paused) || paused.length,
          stalled: Number(rawCounts.stalled) || stalled.length,
          intake: Number(rawCounts.intake) || intake.length,
          attentionTotal:
            Number(rawCounts.attention_total) ||
            escalations.length + paused.length + orchestratorQueue.length,
        },
        orchestratorQueue,
        escalations,
        paused,
        stalled,
        intake,
      };
    }

    // Read-only SQLite fallback when cockpit :4111 is unreachable (memoized on PRAGMA data_version).
    const db = this.openDb();
    const memo = this.getSqlMemoBucket(db);
    if (memo.fallbackBlockers) {
      return memo.fallbackBlockers;
    }

    const rootRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0 AND re IS NULL
         ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, id DESC`,
      )
      .all() as RawMessageRow[];

    const orchestratorQueue: unknown[] = [];
    const escalations: unknown[] = [];
    const paused: unknown[] = [];
    const stalled: unknown[] = [];
    const intake: unknown[] = [];

    for (const row of rootRows) {
      const item = rowToMessageItem(row);
      const summary = {
        id: item.id,
        channel: item.channel,
        title: item.title,
        text: item.text,
        by: item.by,
        brand: item.brand,
        state: item.taskState,
        created_at: item.createdAt,
        replies: item.replies,
        labels: item.labels,
        blocked: item.task?.blocked ?? null,
      };

      if (item.isPaused) {
        paused.push(summary);
      }
      if (item.isBlocked) {
        if (item.labels.escalation === "owner") {
          escalations.push(summary);
        } else if (item.labels.escalation === "orchestrator") {
          orchestratorQueue.push(summary);
        } else if (!item.isPaused) {
          stalled.push(summary);
        }
      }
      if (item.channel.endsWith("/intake") && item.isOpenTask) {
        intake.push(summary);
      }
    }

    memo.fallbackBlockers = {
      counts: {
        orchestratorQueue: orchestratorQueue.length,
        escalations: escalations.length,
        paused: paused.length,
        stalled: stalled.length,
        intake: intake.length,
        attentionTotal: escalations.length + paused.length + orchestratorQueue.length,
      },
      orchestratorQueue,
      escalations,
      paused,
      stalled,
      intake,
    };

    return memo.fallbackBlockers;
  }

  async postMessage(req: PostMessageRequest): Promise<PostMessageResponse> {
    const channel = validateChannel(req.channel);
    const text = validateMessageText(req.text);
    const labels = validateLabels(req.labels);
    const idempotencyKey = validateIdempotencyKey(req.idempotencyKey);

    const scanParts = [text];
    for (const [k, v] of labels) {
      scanParts.push(`${k}=${v}`);
    }
    await this.assertNoSecrets(scanParts.join("\n"));

    const useStdin = text.startsWith("-");
    const argv: string[] = [
      this.vbBinPath,
      "post",
      channel,
      useStdin ? "-" : text,
      "--url",
      this.boardUrl,
      "--label",
      "source=kizuki-mind-explorer",
    ];

    for (const [k, v] of labels) {
      if (k === "source") continue;
      argv.push("--label", `${k}=${v}`);
    }
    if (idempotencyKey) {
      argv.push("--idempotency-key", idempotencyKey);
    }
    argv.push("--json");

    const res = await this.execVb(argv, {
      env: { BOARD_URL: this.boardUrl },
      stdin: useStdin ? text : undefined,
    });

    if (res.exitCode !== 0) {
      const errMsg = stripEmDashes(
        res.stderr.trim() || res.stdout.trim() || `vb post exited with code ${res.exitCode}`,
      );
      throw new ServiceUnavailableError(`Failed to post board message: ${errMsg}`);
    }

    const raw = parseJsonSafe(res.stdout) ?? { stdout: res.stdout.trim() };
    const rawObj =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const msgObj =
      rawObj.message && typeof rawObj.message === "object" && !Array.isArray(rawObj.message)
        ? (rawObj.message as Record<string, unknown>)
        : rawObj;
    const id = String(msgObj.id ?? rawObj.id ?? "");

    this.invalidateAfterWrite();
    return {
      ok: true,
      id,
      channel,
      raw,
    };
  }

  async replyToThread(req: ReplyToThreadRequest): Promise<ReplyToThreadResponse> {
    const rawThreadId = validateThreadId(req.threadId);
    let threadId = rawThreadId;
    if (!NUMERIC_THREAD_ID_RE.test(rawThreadId)) {
      const db = this.openDb();
      let row = db
        .query(
          `SELECT id, re FROM board_messages WHERE event_id = ? AND deleted = 0`,
        )
        .get(rawThreadId) as { id: number; re: number | null } | null;
      if (!row && rawThreadId.startsWith("key:")) {
        row = db
          .query(
            `SELECT id, re FROM board_messages WHERE (from_key = ? OR from_key = ?) AND deleted = 0`,
          )
          .get(rawThreadId, rawThreadId.slice(4)) as { id: number; re: number | null } | null;
      }
      if (!row) {
        throw new BadRequestError("Invalid threadId: expected numeric id or known event_id");
      }
      threadId = String(row.re ?? row.id);
    }
    const text = validateMessageText(req.text);

    await this.assertNoSecrets(text);

    const endpoint = req.resumePaused
      ? `${this.cockpitApiUrl}/api/cc/actions/resume`
      : `${this.cockpitApiUrl}/api/cc/actions/reply`;
    const body = req.resumePaused
      ? { id: threadId, answer: text }
      : { id: threadId, text };

    const ccRes = await this.fetchJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    if (ccRes.ok && ccRes.data && ccRes.data.ok !== false) {
      this.invalidateAfterWrite();
      return {
        ok: true,
        id: String(ccRes.data.id ?? threadId),
        threadId,
      };
    }

    if (ccRes.status >= 400 && ccRes.status < 500) {
      const msg = stripEmDashes(
        String(ccRes.data?.error || `Cockpit rejected reply (HTTP ${ccRes.status})`),
      );
      throw new BadRequestError(msg);
    }

    // Fallback to direct local `vb reply` CLI when cockpit :4111 is down or 5xx.
    const useStdin = text.startsWith("-");
    const argv: string[] = [
      this.vbBinPath,
      "reply",
      threadId,
      useStdin ? "-" : text,
      "--url",
      this.boardUrl,
      "--label",
      "source=kizuki-mind-explorer",
      "--json",
    ];

    const res = await this.execVb(argv, {
      env: { BOARD_URL: this.boardUrl },
      stdin: useStdin ? text : undefined,
    });

    if (res.exitCode !== 0) {
      const errMsg = stripEmDashes(
        res.stderr.trim() || res.stdout.trim() || `vb reply exited with code ${res.exitCode}`,
      );
      throw new ServiceUnavailableError(`Failed to reply to thread #${threadId}: ${errMsg}`);
    }

    const raw = parseJsonSafe(res.stdout);
    const rawObj =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const msgObj =
      rawObj.message && typeof rawObj.message === "object" && !Array.isArray(rawObj.message)
        ? (rawObj.message as Record<string, unknown>)
        : rawObj;

    this.invalidateAfterWrite();
    return {
      ok: true,
      id: String(msgObj.id ?? rawObj.id ?? threadId),
      threadId,
    };
  }
}
