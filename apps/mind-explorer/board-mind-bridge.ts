import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  assertLoopbackUrl,
  BadRequestError,
  classifyAgentIdentity,
  classifyChannelGroup,
  getGroupLabel,
  humanizeMentions,
  KizukiAgentBoardApi,
  NotFoundError,
  ServiceUnavailableError,
  stripEmDashes,
  validateChannel,
  validateMessageText,
  validateThreadId,
  type AgentBrand,
  type AgentRole,
  type BoardMessageItem,
  type BoardReplyPreview,
  type BoardTaskInfo,
} from "./agent-board-api.ts";
import {
  KizukiCodexApi,
  type CodexItem,
  type CodexSection,
  type CodexStats,
} from "./codex-api.ts";
import { loadCanonicalPersonCards, type CanonicalPersonCard } from "./people-intel.ts";
import { KizukiTasteApi } from "./taste-api.ts";
import {
  DEFAULT_LLM_ENDPOINT,
  DEFAULT_LLM_MODEL,
  isCoherentLlmAnswer,
  KizukiVaultApi,
} from "./vault-api.ts";

export type SignalKind =
  | "telemetry"
  | "decision"
  | "debate"
  | "rsi"
  | "taste"
  | "debrief"
  | "work";

export interface SignalClassification {
  isTelemetry: boolean;
  signalKind: SignalKind;
  weight: number;
  reason: string;
}

export type MindLinkKind = "person" | "codex" | "taste" | "vault" | "replay" | "commit";

export interface MindLink {
  kind: MindLinkKind;
  id: string;
  label: string;
  view: "people" | "codex" | "taste" | "vault" | "replay";
  target: string;
  excerpt: string;
}

export interface ReplyPreviewItem extends BoardReplyPreview {
  numericId: number;
  text: string;
  createdAtMs: number;
}

export interface MissionFeedItem extends BoardMessageItem {
  signal: SignalClassification;
  mindLinks: MindLink[];
  replyPreview: ReplyPreviewItem[];
  participants: string[];
}

export interface TelemetryBucket {
  kind: string;
  label: string;
  count: number;
  latestAt: string;
  channels: string[];
  sample: string;
}

export interface ActiveRoomSummary {
  channel: string;
  name: string;
  group: string;
  groupLabel: string;
  signalCount: number;
  telemetryCount: number;
  blockedCount: number;
  decisionCount: number;
  debateCount: number;
  lastAt: string;
  lastAtMs: number;
  participants: string[];
}

export interface MissionFeedOptions {
  limit?: number;
  channel?: string;
  signalKind?: SignalKind;
  includeTelemetry?: boolean;
  sinceHours?: number;
  q?: string;
}

export interface MissionFeedResponse {
  items: MissionFeedItem[];
  telemetryCount: number;
  signalCount: number;
  telemetrySummary: TelemetryBucket[];
  activeRooms: ActiveRoomSummary[];
  synthReady: boolean;
  generatedAt: string;
}

export type EntityThreadKind = "person" | "codex" | "taste" | "vault";

export interface EntityThreadMatch {
  root: BoardMessageItem;
  signal: SignalClassification;
  matchedTerms: string[];
  matchCount: number;
  score: number;
  matchedInReply: boolean;
  participants: string[];
  replyPreview: ReplyPreviewItem[];
}

export interface EntityThreadsResponse {
  kind: EntityThreadKind;
  key: string;
  label: string;
  total: number;
  threads: EntityThreadMatch[];
}

export interface TodayPulseAgent {
  handle: string;
  displayName: string;
  brand: AgentBrand;
  role: AgentRole;
  recentMessages: number;
  lastAt: string;
}

export interface TodayBoardPulseResponse {
  available: boolean;
  openDecisions: number;
  blockedCount: number;
  activeAgents: TodayPulseAgent[];
  topThreads: MissionFeedItem[];
  generatedAt: string;
}

export interface PromoteThreadToCodexRequest {
  threadId: string;
  section: CodexSection;
  title?: string;
  note?: string;
}

export interface PromoteThreadToCodexResponse {
  ok: true;
  threadId: string;
  channel: string;
  codexItem: CodexItem;
  stats: CodexStats;
}

export interface DispatchMindItemRequest {
  channel: string;
  text: string;
  targetAgent?: string;
  sourceKind: string;
  sourceId: string;
  sourceLabel: string;
  idempotencyKey?: string;
}

export interface DispatchMindItemResponse {
  ok: true;
  id: string;
  channel: string;
  text: string;
  sourceKind: string;
  sourceId: string;
  raw: unknown;
}

export interface SynthesizeBoardRequest {
  threadId?: string;
  channel?: string;
}

export interface SynthesizeBoardResponse {
  ok: true;
  scope: "thread" | "channel";
  target: string;
  engine: "local-llm" | "deterministic";
  model: string;
  summary: string;
  decisions: string[];
  openQuestions: string[];
  nextActions: string[];
  participants: string[];
  mindLinks: MindLink[];
  threadCount: number;
  messageCount: number;
  fallbackReason?: string;
  generatedAt: string;
}

export interface BoardOmniHit {
  id: string;
  numericId: number;
  channel: string;
  title: string;
  snippet: string;
  by: string;
  brand: AgentBrand;
  signalKind: SignalKind;
  weight: number;
  replies: number;
  isBlocked: boolean;
  lastAt: string;
  view: "board";
  target: string;
}

export interface BoardAskCitation {
  id: string;
  channel: string;
  title: string;
  by: string;
  signalKind: SignalKind;
  lastAt: string;
}

export interface BoardAskContextOptions {
  channel?: string;
  threadId?: string;
}

export interface BoardAskContext {
  lines: string[];
  citations: BoardAskCitation[];
  matchedThreads: number;
  blockedCount: number;
}

export interface BoardMindBridgeConfig {
  agentBoardApi: KizukiAgentBoardApi;
  vaultApi: KizukiVaultApi;
  codexApi: KizukiCodexApi;
  tasteApi: KizukiTasteApi;
  localLlmUrl?: string;
  localLlmModel?: string;
  fetchImpl?: typeof fetch;
  indexTtlMs?: number;
  probeTtlMs?: number;
  probeTimeoutMs?: number;
  synthTimeoutMs?: number;
}

export type SignalClassifiableItem = {
  text: string;
  channel?: string;
  labels?: Record<string, string>;
  replies?: number;
  isBlocked?: boolean;
  isPaused?: boolean;
  isOpenTask?: boolean;
  taskState?: string | null;
};

interface RawBoardRow {
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

interface IndexedEntityRef {
  kind: "person" | "codex" | "taste" | "vault";
  id: string;
  label: string;
  view: "people" | "codex" | "taste" | "vault";
  target: string;
  excerpt: string;
  searchTerms: string[];
  priority: number;
}

interface EntityLookupIndex {
  builtAt: number;
  singleTokenMap: Map<string, IndexedEntityRef[]>;
  phrase2Map: Map<string, IndexedEntityRef[]>;
  phrase3Map: Map<string, IndexedEntityRef[]>;
  handleMap: Map<string, IndexedEntityRef>;
  vaultPathMap: Map<string, IndexedEntityRef>;
  byEntityKey: Map<string, IndexedEntityRef>;
  allByKind: Record<EntityThreadKind, IndexedEntityRef[]>;
}

interface ProbeCacheEntry {
  checkedAt: number;
  ok: boolean;
  modelId: string | null;
  reason?: string;
}

const DEFAULT_INDEX_TTL_MS = 45_000;
const DEFAULT_PROBE_TTL_MS = 60_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_200;
const DEFAULT_SYNTH_TIMEOUT_MS = 25_000;

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

const VALID_CODEX_SECTIONS = new Set<CodexSection>([
  "philosophies",
  "interests",
  "hobbies",
  "ideas",
  "actions",
]);

const VALID_ENTITY_KINDS = new Set<EntityThreadKind>([
  "person",
  "codex",
  "taste",
  "vault",
]);

const TELEMETRY_LABELS = new Set([
  "telemetry",
  "heartbeat",
  "cron",
  "sync",
  "auto",
  "ping",
]);

const RE_WOKE_UP = /^[A-Za-z0-9]{4,10}\s+woke up$/i;
const RE_FLEET_HEALTH = /^Fleet health changed:/i;
const RE_ADDED_ASSET = /^[A-Za-z0-9]{4,8}\s+added\s+[A-Z0-9]{2,10}\b/i;
const RE_HEAVY_JOB = /^heavy job (?:started|done)\b/i;

const RE_DECISION_PREFIX = /^\[?decision\]?[:\s]/i;
const RE_DECISION_PHRASE =
  /\b(?:need decision|decision needed|needs decision|awaiting owner|owner sign-?off|approve or reject|go\/no-go|sign-?off required|blocking question|escalat(?:ed|ion))\b/i;
const RE_DEBATE_PHRASE =
  /\b(?:rfc|trade-?off|tradeoffs|proposal|debate|counterargument|pros and cons|option\s+[ab12]|versus|vs\.)\b/i;
const RE_RSI_TAG = /\[RSI\b[^\]]{0,80}\]/i;
const RE_TASTE_PREFIX = /(?:^|\s)taste:\s+\S/i;
const RE_DEBRIEF_PREFIX = /^debrief\s+\S/i;
const RE_DEBRIEF_DREAM = /\bdream\s+20\d{2}-\d{2}-\d{2}\b/i;

const RE_MD_PATH = /(?:^|[\s([`"'=:])([A-Za-z0-9_./-]{2,140}\.md)(?=$|[\s)\]`"',:;!?])/g;
const RE_REPLAY_DATE = /\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/g;
const RE_COMMIT_WORD = /\bcommit\s+([0-9a-f]{7,40})\b/gi;
const RE_COMMIT_BACKTICK = /`([0-9a-f]{7,40})`/gi;
const RE_HANDLE_TOKEN = /(?:^|[\s(])@([a-zA-Z0-9._-]{2,48})\b/g;
const RE_PURE_DIGITS = /^\d+$/;
const RE_NUMERIC_ID = /^\d{1,12}$/;
const RE_SOURCE_KIND = /^[a-zA-Z0-9._-]{1,32}$/;
const RE_AGENT_HANDLE = /^[a-zA-Z0-9._-]{1,64}$/;

const ENTITY_STOPWORDS = new Set([
  "about", "above", "action", "actions", "active", "actual", "added", "after",
  "again", "against", "agent", "agents", "alert", "alerts", "align", "alive",
  "allow", "almost", "alone", "along", "already", "also", "always", "among",
  "analysis", "another", "answer", "answers", "append", "apply", "approval",
  "approve", "approved", "archive", "archived", "around", "artifact", "assert",
  "assign", "assigned", "async", "atomic", "attach", "audit", "author", "auto",
  "automated", "available", "avoid", "await", "awaiting", "back", "backup",
  "balance", "balanced", "base", "baseline", "basic", "batch", "batched",
  "because", "become", "before", "begin", "behind", "being", "below", "bench",
  "best", "better", "between", "beyond", "block", "blocked", "blocker", "blockers",
  "board", "body", "both", "bottom", "bound", "bounded", "branch", "brand",
  "break", "bridge", "brief", "bring", "broken", "bucket", "buckets", "buffer",
  "build", "building", "built", "bundle", "business", "button", "bytes",
  "cache", "cached", "call", "called", "caller", "calls", "cancel", "canonical",
  "card", "cards", "care", "case", "cases", "catch", "category", "cause",
  "center", "certain", "chain", "change", "changed", "changes", "channel",
  "channels", "char", "chars", "check", "checked", "checks", "child", "choice",
  "choose", "chosen", "claim", "claimed", "claims", "class", "clean", "clear",
  "click", "client", "close", "closed", "cluster", "code", "codex", "color",
  "column", "combine", "combined", "come", "command", "comment", "commit",
  "common", "compare", "compile", "complete", "completed", "complex", "compute",
  "concept", "config", "confirm", "confirmed", "connect", "connected", "console",
  "const", "contact", "contain", "contains", "content", "context", "continue",
  "contract", "control", "convert", "copy", "core", "correct", "cost", "could",
  "count", "counts", "cover", "craft", "create", "created", "credit", "critic",
  "critical", "cron", "cross", "current", "currently", "cursor", "custom",
  "cycle", "daily", "dark", "data", "database", "date", "dates", "days", "dead",
  "deal", "debate", "debrief", "debug", "decide", "decision", "decisions",
  "default", "defaults", "defer", "deferred", "define", "delete", "deleted",
  "delta", "demo", "dense", "deploy", "deployed", "depth", "derive", "derived",
  "describe", "design", "desktop", "detail", "detailed", "details", "detect",
  "detected", "device", "diff", "different", "digest", "direct", "directly",
  "dirty", "disable", "discard", "discover", "dispatch", "display", "distinct",
  "docs", "doctrine", "document", "does", "domain", "domains", "done", "door",
  "down", "draft", "dream", "drift", "drive", "drop", "dual", "during", "each",
  "early", "edge", "edit", "edited", "editor", "effect", "effort", "either",
  "element", "else", "email", "emit", "empty", "enable", "enabled", "encode",
  "engine", "enough", "ensure", "enter", "entity", "entries", "entry", "enum",
  "error", "errors", "escape", "essential", "eval", "even", "event", "events",
  "ever", "every", "evidence", "exact", "example", "examples", "exceed",
  "except", "excerpt", "exclude", "exec", "execute", "exist", "existing",
  "exists", "exit", "expand", "expect", "expected", "explain", "explicit",
  "explore", "explorer", "export", "expose", "extend", "external", "extra",
  "extract", "face", "fact", "facts", "fail", "failed", "failure", "fake",
  "fall", "fallback", "false", "family", "fast", "feature", "feed", "feedback",
  "feel", "fetch", "fetched", "field", "fields", "file", "files", "fill",
  "filter", "filtered", "final", "find", "finding", "findings", "fine", "finish",
  "finished", "first", "five", "fixed", "flag", "flags", "flat", "fleet",
  "float", "floor", "flow", "focus", "folder", "follow", "font", "force",
  "form", "format", "found", "four", "frame", "frames", "free", "fresh", "from",
  "front", "full", "function", "future", "game", "gate", "gated", "gather",
  "general", "generate", "generated", "generic", "give", "given", "global",
  "goal", "goals", "goes", "going", "good", "grade", "graph", "great", "green",
  "grid", "ground", "grounded", "group", "groups", "grow", "guard", "guess",
  "guide", "half", "hand", "handle", "handles", "hard", "harness", "hash",
  "have", "head", "header", "health", "heartbeat", "heavy", "help", "helper",
  "here", "hero", "hidden", "hide", "high", "higher", "hint", "history", "hits",
  "hold", "home", "honest", "hook", "hooks", "host", "hour", "hours", "house",
  "html", "http", "https", "human", "idea", "ideas", "ident", "identity",
  "idle", "ignore", "image", "impact", "import", "improve", "include",
  "included", "includes", "index", "indexed", "info", "ingest", "init",
  "initial", "inject", "inline", "input", "inputs", "insert", "inside",
  "insight", "inspect", "install", "instance", "instead", "intake", "intel",
  "intent", "interest", "internal", "into", "invalid", "invoke", "isolated",
  "issue", "issues", "item", "items", "itself", "jobs", "join", "json", "judge",
  "jump", "just", "keep", "kept", "keys", "keyword", "keywords", "kill", "kind",
  "kinds", "know", "known", "label", "labels", "landing", "lane", "lanes",
  "lang", "large", "last", "late", "later", "latest", "launch", "layer",
  "layers", "layout", "lead", "leading", "learn", "least", "leave", "ledger",
  "left", "legacy", "length", "lens", "less", "letter", "level", "levels",
  "leverage", "library", "life", "lift", "light", "like", "limit", "limited",
  "line", "linear", "lines", "link", "linked", "links", "list", "listed",
  "listen", "live", "living", "load", "loaded", "loader", "local", "locate",
  "location", "lock", "locked", "logic", "login", "logs", "long", "longer",
  "look", "lookup", "loop", "loopback", "loops", "loss", "lower", "machine",
  "macro", "made", "mail", "main", "maintain", "major", "make", "makes",
  "making", "manage", "manifest", "manual", "many", "mapped", "mark", "markdown",
  "market", "mask", "match", "matched", "matches", "matrix", "matter", "maybe",
  "mean", "meaning", "means", "measure", "media", "medium", "meet", "meeting",
  "member", "memory", "mention", "menu", "merge", "merged", "mesh", "message",
  "messages", "meta", "metadata", "meter", "method", "methods", "metric",
  "metrics", "micro", "middle", "might", "mind", "minimal", "minor", "minute",
  "minutes", "mirror", "miss", "missing", "mission", "mixed", "mock", "mocked",
  "mode", "model", "models", "modes", "modify", "module", "modules", "moment",
  "money", "monitor", "month", "more", "most", "motion", "mount", "move",
  "moved", "moves", "much", "multi", "multiple", "must", "mutate", "name",
  "named", "names", "narrow", "native", "natural", "near", "need", "needed",
  "needs", "negative", "neighbor", "neither", "nest", "nested", "network",
  "neutral", "never", "newest", "next", "nice", "nine", "node", "nodes",
  "noise", "noisy", "none", "normal", "note", "notes", "nothing", "notify",
  "null", "number", "numbers", "numeric", "object", "objects", "observe",
  "observed", "obtain", "obvious", "occur", "offer", "offline", "offset",
  "often", "okay", "older", "oldest", "omni", "once", "ones", "online", "only",
  "onto", "open", "opened", "opening", "operate", "operator", "opinion",
  "option", "optional", "options", "oracle", "order", "ordered", "origin",
  "original", "other", "others", "otherwise", "ought", "ours", "outcome",
  "outer", "outline", "output", "outputs", "outside", "over", "overall",
  "overlap", "overlay", "override", "overview", "owned", "owner", "owners",
  "pack", "package", "packet", "page", "pages", "pair", "paired", "pairs",
  "palette", "panel", "panels", "paper", "parallel", "param", "params",
  "parent", "parity", "parked", "parse", "parsed", "parser", "part", "partial",
  "parts", "pass", "passed", "passes", "passing", "past", "paste", "patch",
  "path", "paths", "pattern", "patterns", "pause", "paused", "payload", "peak",
  "peer", "pending", "people", "percent", "perf", "perfect", "perform", "period",
  "persist", "person", "personal", "phase", "phone", "phrase", "phrases",
  "physical", "pick", "picked", "piece", "pieces", "ping", "pinned", "pipe",
  "pipeline", "pixel", "pixels", "place", "plain", "plan", "planned", "planning",
  "plate", "platform", "play", "playbook", "player", "please", "plugin",
  "plugins", "plus", "point", "pointer", "points", "polarity", "policy",
  "polish", "poll", "pool", "port", "portal", "position", "positive", "possible",
  "post", "posted", "poster", "posters", "posting", "posts", "power", "pragma",
  "prefix", "prepare", "presence", "present", "preserve", "press", "pretty",
  "prev", "prevent", "preview", "previous", "price", "primary", "prime",
  "principal", "print", "prior", "priority", "private", "probe", "problem",
  "problems", "proceed", "process", "produce", "product", "profile", "profiled",
  "profiles", "profit", "program", "progress", "project", "projects", "promise",
  "promote", "promoted", "prompt", "prompts", "proof", "proper", "property",
  "propose", "proposal", "protect", "protocol", "prove", "proven", "provide",
  "provided", "provider", "proxy", "public", "publish", "pull", "pulse", "pure",
  "purge", "purpose", "push", "pushed", "quality", "query", "queries", "question",
  "questions", "queue", "queued", "quick", "quiet", "quite", "quote", "race",
  "rail", "raise", "random", "range", "rank", "ranked", "ranking", "rapid",
  "rare", "ratchet", "rate", "rather", "ratio", "reach", "react", "reaction",
  "read", "readable", "reader", "reading", "readonly", "reads", "ready", "real",
  "really", "reason", "reasons", "rebuild", "recall", "recap", "receipt",
  "receive", "recent", "recently", "record", "records", "recover", "recovery",
  "redact", "redacted", "reduce", "reduced", "refer", "refers", "refresh",
  "regex", "region", "register", "registry", "regress", "regular", "reject",
  "rejected", "relate", "related", "relation", "relative", "relay", "release",
  "relevant", "reload", "rely", "remain", "remains", "remember", "remind",
  "remote", "remove", "removed", "rename", "render", "rendered", "renders",
  "repair", "repeat", "repeated", "replace", "replaced", "replay", "replies",
  "reply", "report", "reported", "reports", "repro", "request", "requests",
  "require", "required", "requires", "research", "reset", "resolve", "resolved",
  "resolver", "resource", "respect", "respond", "response", "rest", "restart",
  "restore", "restrict", "result", "results", "resume", "retain", "retry",
  "return", "returned", "returns", "reuse", "reveal", "reverse", "revert",
  "review", "reviewed", "reviewer", "reviews", "revise", "revisit", "rich",
  "right", "risk", "risks", "roadmap", "robust", "role", "roles", "roll",
  "rollback", "rollup", "room", "rooms", "root", "roots", "roster", "round",
  "rounds", "route", "router", "routes", "routine", "rows", "rule", "rules",
  "running", "runs", "runtime", "safe", "safety", "said", "same", "sample",
  "samples", "sandbox", "sanity", "save", "saved", "scale", "scan", "scanned",
  "scanner", "scanning", "scene", "schedule", "schema", "scheme", "scope",
  "scoped", "score", "scored", "scores", "scoring", "scout", "scrape", "scratch",
  "screen", "script", "scripts", "scroll", "scrub", "seam", "seams", "search",
  "searched", "seat", "seats", "second", "seconds", "secret", "secrets",
  "section", "sections", "secure", "security", "seed", "seeded", "seeking",
  "seem", "seems", "seen", "segment", "select", "selected", "self", "send",
  "sender", "sending", "sends", "sense", "sent", "sentence", "separate",
  "sequence", "series", "serious", "serve", "server", "servers", "service",
  "services", "session", "sessions", "sets", "setting", "settings", "settle",
  "settled", "setup", "seven", "several", "shadow", "shape", "share", "shared",
  "sharp", "sharpen", "sheet", "shell", "shift", "ship", "shipped", "shipping",
  "short", "shorter", "shortlist", "shot", "shots", "should", "show", "shown",
  "shows", "shrink", "shut", "shutdown", "side", "sides", "sign", "signal",
  "signals", "signed", "silent", "similar", "simple", "simplify", "simply",
  "simulate", "since", "single", "site", "sites", "size", "sizes", "skill",
  "skills", "skip", "skipped", "skips", "sleep", "slice", "slices", "slide",
  "slim", "slop", "slot", "slots", "slow", "slug", "slugs", "small", "smaller",
  "smart", "smooth", "snap", "snapshot", "snippet", "snippets", "snooze",
  "social", "socket", "soft", "solid", "solution", "solve", "solved", "some",
  "someone", "somewhat", "soon", "sort", "sorted", "sorting", "soul", "sound",
  "source", "sources", "space", "spaces", "span", "spark", "spawn", "spawned",
  "speak", "spec", "special", "specific", "specimen", "specs", "speed", "spend",
  "spine", "split", "spoof", "spot", "spring", "sqlite", "stable", "stack",
  "stage", "stages", "stale", "stall", "stalled", "stamp", "stand", "standard",
  "standing", "star", "start", "started", "starter", "starting", "starts",
  "state", "stated", "states", "static", "stats", "status", "stay", "stays",
  "steady", "steer", "step", "steps", "stick", "still", "stills", "stdin",
  "stdio", "stdout", "stderr", "stop", "stopped", "stops", "storage", "store",
  "stored", "stores", "story", "straight", "strategy", "streak", "stream",
  "streams", "strength", "stress", "strict", "strictly", "string", "strings",
  "strip", "stripped", "strong", "struck", "struct", "stub", "stubs", "stuck",
  "student", "studio", "study", "stuff", "style", "styled", "styles", "subagent",
  "subject", "submit", "subtitle", "subtle", "subtract", "succeed", "success",
  "such", "suffix", "suggest", "suite", "summary", "super", "supply", "support",
  "surface", "surfaces", "surname", "surprise", "survey", "swallow", "swap",
  "swarm", "swatch", "sweep", "switch", "symbol", "symbols", "sync", "synced",
  "synth", "system", "systems", "table", "tables", "tactile", "tagged", "tags",
  "tail", "take", "taken", "takes", "taking", "talk", "target", "targets",
  "task", "tasks", "taste", "tastes", "teach", "team", "teams", "tech",
  "telemetry", "tell", "tells", "temp", "template", "tempo", "temporal",
  "tend", "tension", "term", "terminal", "terms", "test", "tested", "testing",
  "tests", "text", "texts", "than", "thank", "that", "their", "them", "theme",
  "themes", "then", "theory", "there", "these", "thesis", "they", "thin",
  "thing", "things", "think", "thinking", "third", "this", "thorough", "those",
  "though", "thought", "thread", "threads", "three", "through", "throw",
  "throws", "thus", "tick", "tier", "tiers", "tight", "tile", "time", "timed",
  "timeline", "timeout", "timer", "timers", "times", "title", "titles", "today",
  "toggle", "token", "tokens", "told", "tomorrow", "tone", "took", "tool",
  "tooling", "tools", "topic", "topics", "total", "totals", "touch", "touched",
  "tour", "toward", "towards", "trace", "track", "tracked", "tracker", "trade",
  "tradeoff", "trading", "traffic", "trail", "trailing", "train", "trait",
  "traits", "transfer", "transit", "transmit", "trap", "traps", "treat",
  "treated", "tree", "trees", "trend", "trial", "trigger", "triggers", "trim",
  "trimmed", "trip", "trivial", "true", "trust", "trusted", "truth", "trying",
  "tune", "tuning", "tunnel", "turn", "turned", "turns", "twice", "type",
  "typed", "types", "typical", "typing", "ugly", "unable", "unasked", "unblock",
  "under", "undo", "undone", "unify", "union", "unique", "unit", "units",
  "unknown", "unless", "unlike", "unlink", "unlock", "unmask", "unread",
  "unsafe", "unset", "until", "unwanted", "unwatch", "upcoming", "update",
  "updated", "updates", "updating", "upgrade", "upload", "uploaded", "upon",
  "upper", "upsert", "upstream", "urls", "usage", "used", "useful", "user",
  "users", "uses", "using", "usual", "usually", "utility", "vague", "valid",
  "validate", "value", "values", "variable", "varied", "variant", "various",
  "vault", "vector", "verb", "verbatim", "verbs", "verdict", "verdicts",
  "verified", "verifier", "verify", "version", "versions", "versus", "very",
  "video", "view", "viewer", "views", "visible", "visibly", "visit", "visual",
  "visuals", "voice", "volume", "vote", "wait", "waited", "waiting", "waits",
  "wake", "wakeup", "walk", "wall", "wallet", "wallets", "want", "wanted",
  "wants", "warm", "warn", "warning", "watch", "watched", "watcher", "watches",
  "wave", "waves", "ways", "weak", "website", "week", "weekly", "weeks",
  "weight", "weights", "weird", "welcome", "well", "went", "were", "west",
  "what", "whatever", "when", "whenever", "where", "whereas", "whether",
  "which", "while", "white", "whole", "whom", "whose", "wide", "wider", "width",
  "wiki", "will", "window", "winner", "wins", "wire", "wired", "wiring", "with",
  "within", "without", "woke", "word", "words", "work", "worked", "worker",
  "workers", "workflow", "working", "works", "world", "worry", "worse", "worst",
  "worth", "would", "wrap", "wrapped", "wrapper", "write", "writer", "writes",
  "writing", "written", "wrong", "wrote", "yaml", "year", "yearly", "years",
  "yellow", "yield", "your", "yours", "zero", "zone", "zoom",
]);

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function cleanText(raw: string, maxLen?: number): string {
  const cleaned = stripEmDashes(String(raw ?? ""))
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!maxLen || cleaned.length <= maxLen) return cleaned;
  const slice = cleaned.slice(0, Math.max(1, maxLen - 3));
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(maxLen * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:.\-/\s]+$/, "")}...`;
}

const RE_NOISY_PERSON_TERM =
  /\b(?:accounts?|notifications?|support|no[-_\s]?reply|do[-_\s]?not[-_\s]?reply|alerts?|newsletters?|mailer(?:[-_\s]?daemon)?|postmaster|billing|invoices?|receipts?|helpdesk|customer[-_\s]?(?:care|service)|auto[-_\s]?reply|automated|unsubscribe|digest|marketing|promotions?|verify|verification|auth(?:entication)?|security|service[-_\s]?desk|services?|system|team|bot|daemon|webhook|admin|info|hello|orders?|shipping|delivery|confirmations?|payments?|subscriptions?|updates?|press|careers?|jobs|recruiting|legal|privacy|compliance|status|monitoring|cloud|corp|inc|llc|ltd)\b/i;

const RE_EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isNoisyPersonEntity(name: string, slug?: string): boolean {
  const cleanName = stripEmDashes(String(name ?? "")).trim();
  if (!cleanName) return true;
  if (RE_EMAIL_LIKE.test(cleanName)) return true;
  const normalizedName = cleanName.replace(/[-_]+/g, " ");
  if (RE_NOISY_PERSON_TERM.test(normalizedName)) return true;
  if (slug) {
    const cleanSlug = stripEmDashes(String(slug)).trim();
    if (RE_EMAIL_LIKE.test(cleanSlug)) return true;
    const normalizedSlug = cleanSlug.replace(/[-_]+/g, " ");
    if (RE_NOISY_PERSON_TERM.test(normalizedSlug)) return true;
  }
  return false;
}

function isRealHumanName(name: string): boolean {
  const clean = stripEmDashes(String(name ?? "")).trim();
  if (!clean || isNoisyPersonEntity(clean)) return false;
  const words = tokenizeNormalized(clean).filter(
    (w) => w.length >= 2 && /^[a-z][a-z-]*$/.test(w),
  );
  return words.length >= 2;
}

function isValidPersonAliasOrHandle(raw: string): boolean {
  const norm = stripEmDashes(String(raw ?? ""))
    .replace(/^@+/, "")
    .trim()
    .toLowerCase();
  if (norm.length < 5) return false;
  if (RE_PURE_DIGITS.test(norm)) return false;
  if (ENTITY_STOPWORDS.has(norm)) return false;
  if (RE_EMAIL_LIKE.test(norm)) return false;
  if (RE_NOISY_PERSON_TERM.test(norm.replace(/[-_]+/g, " "))) return false;
  return true;
}

function singleLineExcerpt(raw: string, maxLen = 160): string {
  return cleanText(humanizeMentions(String(raw ?? "")).replace(/\s+/g, " "), maxLen);
}

function escapeLikeParam(term: string): string {
  return term.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
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

function normalizeLabelsRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function parseBoardTask(
  rawTask: unknown,
  labels: Record<string, string>,
): BoardTaskInfo | null {
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
    reason: typeof t.reason === "string" ? stripEmDashes(t.reason) : null,
  };
}

function rowToBoardMessageItem(row: RawBoardRow): BoardMessageItem {
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

  const rawText = typeof parsed.text === "string" ? parsed.text : row.text_lower;
  const text = stripEmDashes(rawText);
  const createdAtMs = Number(row.created_at) || 0;
  // In real local.db, `at` is a message sequence ID (e.g. 2642), not epoch ms.
  // Only treat `at` as an epoch timestamp if it is >= 1e12 (year 2001+ in ms).
  const rawAt = Number(row.at);
  const lastAtMs =
    Number.isFinite(rawAt) && rawAt >= 1_000_000_000_000 ? rawAt : createdAtMs;

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
    displayName: stripEmDashes(identity.displayName),
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

function titleCaseChannelLeaf(channel: string): string {
  const leaf = channel.includes("/") ? channel.split("/").slice(1).join("/") : channel;
  return stripEmDashes(leaf)
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function tokenizeNormalized(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  let start = -1;
  for (let i = 0; i <= lower.length; i++) {
    const ch = i < lower.length ? lower.charCodeAt(i) : 32;
    const isWord =
      (ch >= 97 && ch <= 122) ||
      (ch >= 48 && ch <= 57) ||
      ch === 45 || // -
      ch === 95; // _
    if (isWord) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const tok = lower.slice(start, i).replace(/^[-_]+|[-_]+$/g, "");
      if (tok.length > 0) tokens.push(tok);
      start = -1;
    }
  }
  return tokens;
}

function isDistinctiveSingleToken(token: string): boolean {
  if (token.length < 4) return false;
  if (RE_PURE_DIGITS.test(token)) return false;
  if (ENTITY_STOPWORDS.has(token)) return false;
  return true;
}

function stripThinkBlocks(raw: string): string {
  return String(raw ?? "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .replace(/^[\s\S]*?<\/think>\s*/i, "")
    .trim();
}

function detectTelemetrySubtype(item: SignalClassifiableItem): {
  kind: string;
  label: string;
  weight: number;
  reason: string;
} | null {
  const sample = String(item.text ?? "").slice(0, 1200).trim();
  const firstLine = (sample.split(/\r?\n/)[0] || "").trim();
  const replies = Number(item.replies ?? 0) || 0;
  const isBlocked = Boolean(item.isBlocked);
  const isPaused = Boolean(item.isPaused);
  const labels = item.labels ?? {};

  if (replies === 0 && !isBlocked && !isPaused) {
    if (RE_WOKE_UP.test(firstLine)) {
      return {
        kind: "woke_up",
        label: "Agent wakeups",
        weight: 6,
        reason: "agent wakeup heartbeat",
      };
    }
    if (RE_FLEET_HEALTH.test(firstLine)) {
      return {
        kind: "fleet_health",
        label: "Fleet health transitions",
        weight: 10,
        reason: "fleet health status ping",
      };
    }
    if (RE_ADDED_ASSET.test(firstLine)) {
      return {
        kind: "member_added",
        label: "Roster / key additions",
        weight: 8,
        reason: "automated node or key addition",
      };
    }
    if (RE_HEAVY_JOB.test(firstLine)) {
      return {
        kind: "heavy_job",
        label: "Heavy job notices",
        weight: 12,
        reason: "unreplied heavy job status line",
      };
    }
  }

  for (const [k, v] of Object.entries(labels)) {
    const kLow = k.toLowerCase();
    const vLow = String(v ?? "").toLowerCase();
    if (
      (TELEMETRY_LABELS.has(kLow) && vLow !== "false" && vLow !== "0") ||
      ((kLow === "kind" || kLow === "type" || kLow === "source" || kLow === "category") &&
        TELEMETRY_LABELS.has(vLow))
    ) {
      if (replies === 0 && !isBlocked && !isPaused) {
        return {
          kind: `label_${TELEMETRY_LABELS.has(vLow) ? vLow : kLow}`,
          label: "Telemetry / automated pings",
          weight: 9,
          reason: `telemetry label (${kLow}=${vLow})`,
        };
      }
    }
  }

  return null;
}

function inferCodexDomainFromChannel(channel: string): string {
  const group = classifyChannelGroup(channel);
  switch (group) {
    case "design":
      return "Design & Craft";
    case "crypto":
      return "Crypto & Trading";
    case "estate":
      return "Real Estate & Ops";
    case "world":
      return "World Model";
    case "box":
    case "agent-board":
      return "Systems & Agents";
    default:
      return getGroupLabel(group);
  }
}

function parseBulletSection(markdown: string, headingRegex: RegExp): string[] {
  const lines = markdown.split(/\r?\n/);
  let inside = false;
  const items: string[] = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^#{1,4}\s+/.test(line) || /^\*\*[A-Za-z ]+:\*\*$/.test(line)) {
      if (headingRegex.test(line)) {
        inside = true;
        continue;
      }
      if (inside) break;
    }
    if (!inside) continue;
    const bulletMatch = line.match(/^(?:[-*]|\d+\.)\s+(.+)$/);
    if (bulletMatch) {
      const cleaned = singleLineExcerpt(bulletMatch[1], 220);
      if (cleaned && !/^none\b/i.test(cleaned)) {
        items.push(cleaned);
      }
    }
  }
  return items.slice(0, 6);
}

export class KizukiBoardMindBridge {
  readonly agentBoardApi: KizukiAgentBoardApi;
  readonly vaultApi: KizukiVaultApi;
  readonly codexApi: KizukiCodexApi;
  readonly tasteApi: KizukiTasteApi;
  readonly localLlmUrl: string;
  readonly localLlmModel: string;

  private readonly fetchImpl: typeof fetch;
  private readonly indexTtlMs: number;
  private readonly probeTtlMs: number;
  private readonly probeTimeoutMs: number;
  private readonly synthTimeoutMs: number;

  private ownedDb: Database | null = null;
  private indexCache: EntityLookupIndex | null = null;
  private indexInFlight: Promise<EntityLookupIndex> | null = null;
  private indexDirty = false;
  private indexVersion = 0;
  private closed = false;
  private probeCache: ProbeCacheEntry | null = null;
  private probeInFlight: Promise<ProbeCacheEntry> | null = null;
  private missionFeedMemo = new Map<string, { builtAt: number; value: MissionFeedResponse }>();
  private todayPulseMemo: {
    dataVersion: number;
    indexVersion: number;
    builtAt: number;
    value: TodayBoardPulseResponse;
  } | null = null;

  constructor(config: BoardMindBridgeConfig) {
    if (!config || typeof config !== "object") {
      throw new BadRequestError("BoardMindBridgeConfig is required");
    }
    this.agentBoardApi = config.agentBoardApi;
    this.vaultApi = config.vaultApi;
    this.codexApi = config.codexApi;
    this.tasteApi = config.tasteApi;
    this.localLlmUrl = assertLoopbackUrl(
      config.localLlmUrl || DEFAULT_LLM_ENDPOINT,
      "localLlmUrl",
    );
    this.localLlmModel = (config.localLlmModel || DEFAULT_LLM_MODEL).trim();
    this.fetchImpl = config.fetchImpl || globalThis.fetch.bind(globalThis);
    this.indexTtlMs = Math.max(1_000, config.indexTtlMs ?? DEFAULT_INDEX_TTL_MS);
    this.probeTtlMs = Math.max(1_000, config.probeTtlMs ?? DEFAULT_PROBE_TTL_MS);
    this.probeTimeoutMs = Math.max(100, config.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
    this.synthTimeoutMs = Math.max(250, config.synthTimeoutMs ?? DEFAULT_SYNTH_TIMEOUT_MS);
  }

  close(): void {
    this.closed = true;
    if (this.ownedDb) {
      try {
        this.ownedDb.close();
      } catch {
        // ignore close errors
      }
      this.ownedDb = null;
    }
    this.indexCache = null;
    this.indexInFlight = null;
    this.indexDirty = false;
    this.probeCache = null;
    this.probeInFlight = null;
    this.missionFeedMemo.clear();
    this.todayPulseMemo = null;
  }

  invalidateEntityIndex(): void {
    this.indexDirty = true;
    this.missionFeedMemo.clear();
    this.todayPulseMemo = null;
    if (!this.closed) {
      this.triggerBackgroundEntityIndexRefresh();
    }
  }

  private getBoardDataVersion(db: Database): number {
    const maybeFn = (this.agentBoardApi as unknown as { getDataVersion?: () => number }).getDataVersion;
    if (typeof maybeFn === "function") {
      try {
        return maybeFn.call(this.agentBoardApi);
      } catch {
        // fall through to direct pragma
      }
    }
    try {
      const row = db.query("PRAGMA data_version").get() as { data_version?: number } | null;
      return Number(row?.data_version) || 0;
    } catch {
      return 0;
    }
  }

  private tryGetBoardDb(): Database | null {
    const maybeGetter = (this.agentBoardApi as unknown as { getDb?: () => Database }).getDb;
    if (typeof maybeGetter === "function") {
      try {
        const external = maybeGetter.call(this.agentBoardApi);
        if (external) return external;
      } catch {
        // fall through to readonly open
      }
    }
    if (this.ownedDb) return this.ownedDb;
    const dbPath = this.agentBoardApi.dbPath;
    if (!dbPath || !existsSync(dbPath)) {
      return null;
    }
    try {
      const db = new Database(dbPath, { readonly: true });
      db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;");
      this.ownedDb = db;
      return db;
    } catch {
      return null;
    }
  }

  private requireBoardDb(): Database {
    const db = this.tryGetBoardDb();
    if (!db) {
      throw new ServiceUnavailableError(
        `Agent Board database not available at ${this.agentBoardApi.dbPath}`,
      );
    }
    return db;
  }

  // ============================================================================
  // 1. classifySignal(item)
  // ============================================================================

  classifySignal(item: SignalClassifiableItem): SignalClassification {
    const telemetry = detectTelemetrySubtype(item);
    if (telemetry) {
      return {
        isTelemetry: true,
        signalKind: "telemetry",
        weight: clamp(telemetry.weight, 5, 15),
        reason: telemetry.reason,
      };
    }

    const sample = String(item.text ?? "").slice(0, 1200).trim();
    const firstLine = (sample.split(/\r?\n/)[0] || "").trim();
    const labels = item.labels ?? {};
    const channel = String(item.channel ?? "").toLowerCase();
    const replies = Number(item.replies ?? 0) || 0;
    const isBlocked = Boolean(item.isBlocked);
    const isPaused = Boolean(item.isPaused);
    const isOpenTask = Boolean(item.isOpenTask);
    const labelKind = String(labels.kind ?? "").toLowerCase();
    const labelSource = String(labels.source ?? "").toLowerCase();

    // Decision (85..100)
    if (
      isBlocked ||
      isPaused ||
      Boolean(labels.escalation) ||
      labelKind === "decision" ||
      channel === "decisions" ||
      channel.endsWith("/decisions") ||
      RE_DECISION_PREFIX.test(firstLine) ||
      RE_DECISION_PHRASE.test(sample)
    ) {
      const weight = clamp(
        86 +
          (isBlocked ? 6 : 0) +
          (isPaused ? 3 : 0) +
          (labels.escalation === "owner" ? 4 : labels.escalation ? 2 : 0) +
          Math.min(4, replies),
        85,
        100,
      );
      return {
        isTelemetry: false,
        signalKind: "decision",
        weight,
        reason: isBlocked
          ? "blocked or escalated decision thread"
          : "decision request or approval thread",
      };
    }

    // Explicit debate / RFC / tradeoff (76..92)
    if (
      labelKind === "debate" ||
      labelKind === "rfc" ||
      RE_DEBATE_PHRASE.test(sample)
    ) {
      const weight = clamp(
        78 + Math.min(10, replies * 3) + (isOpenTask ? 3 : 0),
        76,
        92,
      );
      return {
        isTelemetry: false,
        signalKind: "debate",
        weight,
        reason: "tradeoff or RFC debate thread",
      };
    }

    // RSI (72..86)
    if (
      labelSource === "rsi" ||
      labelKind === "rsi" ||
      RE_RSI_TAG.test(sample)
    ) {
      const weight = clamp(
        74 + Math.min(8, replies * 3) + (isOpenTask ? 4 : 0),
        72,
        86,
      );
      return {
        isTelemetry: false,
        signalKind: "rsi",
        weight,
        reason: "RSI improvement thread",
      };
    }

    // Taste (70..84)
    if (
      channel === "box/taste" ||
      channel.endsWith("/taste") ||
      labelKind === "taste" ||
      RE_TASTE_PREFIX.test(sample)
    ) {
      const weight = clamp(
        72 + Math.min(9, replies * 3) + (isOpenTask ? 3 : 0),
        70,
        84,
      );
      return {
        isTelemetry: false,
        signalKind: "taste",
        weight,
        reason: "owner taste or aesthetic verdict",
      };
    }

    // Debrief (68..82)
    if (
      labelKind === "debrief" ||
      RE_DEBRIEF_PREFIX.test(firstLine) ||
      RE_DEBRIEF_DREAM.test(sample)
    ) {
      const weight = clamp(
        70 + Math.min(9, replies * 3) + (sample.length > 260 ? 3 : 0),
        68,
        82,
      );
      return {
        isTelemetry: false,
        signalKind: "debrief",
        weight,
        reason: "session debrief or dream summary",
      };
    }

    // Multi-reply discussion -> debate (76..92)
    if (replies >= 2) {
      const weight = clamp(
        76 + Math.min(12, replies * 2) + (isOpenTask ? 4 : 0),
        76,
        92,
      );
      return {
        isTelemetry: false,
        signalKind: "debate",
        weight,
        reason: `multi-agent thread (${replies} replies)`,
      };
    }

    // Standard work thread (42..66)
    const weight = clamp(
      46 +
        (replies === 1 ? 8 : 0) +
        (isOpenTask ? 6 : 0) +
        (sample.length > 180 ? 4 : 0) +
        (labelKind === "task" ? 2 : 0),
      42,
      66,
    );
    return {
      isTelemetry: false,
      signalKind: "work",
      weight,
      reason: isOpenTask ? "active work task" : "work update",
    };
  }

  // ============================================================================
  // 2. resolveMindLinks(text, channel?, maxLinks = 8)
  // ============================================================================

  private triggerBackgroundEntityIndexRefresh(): Promise<EntityLookupIndex> {
    if (this.indexInFlight) {
      return this.indexInFlight;
    }
    const task = this.buildEntityIndex({ vaultPeopleTimeoutMs: null })
      .then((idx) => {
        if (!this.closed) {
          this.indexCache = idx;
          this.indexDirty = false;
          this.indexVersion += 1;
          this.missionFeedMemo.clear();
          this.todayPulseMemo = null;
        }
        return idx;
      })
      .finally(() => {
        if (this.indexInFlight === task) {
          this.indexInFlight = null;
        }
      });
    this.indexInFlight = task;
    return task;
  }

  private async getEntityIndex(opts?: {
    nonBlocking?: boolean;
    vaultPeopleTimeoutMs?: number;
  }): Promise<EntityLookupIndex> {
    const now = Date.now();
    if (this.indexCache) {
      if (this.indexDirty || now - this.indexCache.builtAt >= this.indexTtlMs) {
        if (!this.closed) {
          void this.triggerBackgroundEntityIndexRefresh();
        }
      }
      return this.indexCache;
    }

    if (opts?.nonBlocking) {
      const budgetMs = opts.vaultPeopleTimeoutMs ?? 120;
      const fastIdx = await this.buildEntityIndex({ vaultPeopleTimeoutMs: budgetMs });
      if (!this.closed) {
        this.indexCache = fastIdx;
        this.indexDirty = false;
        this.indexVersion += 1;
      }
      return fastIdx;
    }

    return this.triggerBackgroundEntityIndexRefresh();
  }

  private async buildEntityIndex(opts?: {
    vaultPeopleTimeoutMs?: number | null;
  }): Promise<EntityLookupIndex> {
    const singleTokenMap = new Map<string, IndexedEntityRef[]>();
    const phrase2Map = new Map<string, IndexedEntityRef[]>();
    const phrase3Map = new Map<string, IndexedEntityRef[]>();
    const handleMap = new Map<string, IndexedEntityRef>();
    const vaultPathMap = new Map<string, IndexedEntityRef>();
    const byEntityKey = new Map<string, IndexedEntityRef>();
    const allByKind: Record<EntityThreadKind, IndexedEntityRef[]> = {
      person: [],
      codex: [],
      taste: [],
      vault: [],
    };

    const addMapList = (
      map: Map<string, IndexedEntityRef[]>,
      key: string,
      ref: IndexedEntityRef,
    ) => {
      if (!key) return;
      let list = map.get(key);
      if (!list) {
        list = [];
        map.set(key, list);
      }
      if (!list.some((item) => item.kind === ref.kind && item.id === ref.id)) {
        list.push(ref);
      }
    };

    const indexPhrasesAndTokens = (
      ref: IndexedEntityRef,
      rawStrings: string[],
      allowSingleWords: boolean,
    ) => {
      for (const raw of rawStrings) {
        const clean = stripEmDashes(raw).trim();
        if (!clean) continue;
        const toks = tokenizeNormalized(clean);
        if (toks.length === 0) continue;

        if (toks.length >= 2) {
          const p2 = `${toks[0]} ${toks[1]}`;
          if (p2.length >= 6) {
            addMapList(phrase2Map, p2, ref);
          }
        }
        if (toks.length >= 3) {
          const p3 = `${toks[0]} ${toks[1]} ${toks[2]}`;
          if (p3.length >= 9) {
            addMapList(phrase3Map, p3, ref);
          }
        }
        if (allowSingleWords) {
          for (const t of toks) {
            if (isDistinctiveSingleToken(t)) {
              addMapList(singleTokenMap, t, ref);
            }
          }
        }
      }
    };

    const registerEntity = (
      ref: IndexedEntityRef,
      phrases: string[],
      singleAllow: boolean,
      handles: string[] = [],
    ) => {
      const entityKey = `${ref.kind}:${ref.id}`;
      if (byEntityKey.has(entityKey)) return;
      byEntityKey.set(entityKey, ref);
      allByKind[ref.kind].push(ref);
      indexPhrasesAndTokens(ref, phrases, singleAllow);
      for (const h of handles) {
        const norm = h.replace(/^@+/, "").trim().toLowerCase();
        if (norm.length >= 2 && !handleMap.has(norm)) {
          handleMap.set(norm, ref);
        }
      }
    };

    const vaultPeopleTimeoutMs = opts?.vaultPeopleTimeoutMs ?? null;
    let vaultPeopleTimedOut = false;
    const peoplePromise = this.vaultApi.listPeople({ limit: 250 }).catch(() => null);
    let peopleRace: Promise<Awaited<typeof peoplePromise>> = peoplePromise;
    if (vaultPeopleTimeoutMs !== null && vaultPeopleTimeoutMs >= 0) {
      let timerId: ReturnType<typeof setTimeout> | null = null;
      const timeoutPromise = new Promise<null>((resolve) => {
        timerId = setTimeout(() => {
          vaultPeopleTimedOut = true;
          resolve(null);
        }, vaultPeopleTimeoutMs);
        if (typeof (timerId as unknown as { unref?: () => void }).unref === "function") {
          (timerId as unknown as { unref: () => void }).unref();
        }
      });
      peopleRace = Promise.race([
        peoplePromise.then((res) => {
          if (timerId !== null) clearTimeout(timerId);
          return res;
        }),
        timeoutPromise,
      ]);
    }

    // Fetch all 4 mind surfaces concurrently (fail-soft per surface, bounded wait on slow vault rebuilds)
    const [peopleRes, canonicalRes, docsRes, codexRes, tasteRes] = await Promise.all([
      peopleRace,
      loadCanonicalPersonCards({
        vaultPath: this.vaultApi.vaultPath,
        lifeosPeopleDir: this.vaultApi.lifeosPeopleDir,
        relationshipsDir: this.vaultApi.relationshipsDir,
      }).catch(() => null),
      this.vaultApi
        .listDocs({ category: "all", limit: 300, sort: "recent" })
        .catch(() => null),
      Promise.resolve()
        .then(() => this.codexApi.getCodex({ includeArchived: false }))
        .catch(() => null),
      Promise.resolve()
        .then(() => this.tasteApi.getTasteState())
        .catch(() => null),
    ]);

    if (vaultPeopleTimedOut && !this.closed) {
      void peoplePromise.then((latePeople) => {
        if (!this.closed && latePeople?.items?.length) {
          this.indexDirty = true;
          void this.triggerBackgroundEntityIndexRefresh();
        }
      });
    }

    // 1. Canonical person cards (highest fidelity)
    const canonicalBySlug = new Map<string, CanonicalPersonCard>();
    if (canonicalRes?.cards) {
      for (const card of canonicalRes.cards) {
        canonicalBySlug.set(card.slug.toLowerCase(), card);
        const label = stripEmDashes(card.display_name || card.canonical_name || card.slug);
        if (isNoisyPersonEntity(label, card.slug)) continue;

        const wm = card.world_model;
        const rawHandles: string[] = [];
        if (wm.handles?.x) rawHandles.push(wm.handles.x);
        if (wm.handles?.github) rawHandles.push(wm.handles.github);
        if (wm.handles?.telegram) rawHandles.push(wm.handles.telegram);
        rawHandles.push(card.slug);

        const validHandles = Array.from(
          new Set(
            rawHandles
              .map((h) => stripEmDashes(String(h || "")).replace(/^@+/, "").trim().toLowerCase())
              .filter((h) => isValidPersonAliasOrHandle(h)),
          ),
        );

        const multiWordNames = [label, card.canonical_name, ...wm.aliases]
          .map((s) => stripEmDashes(String(s || "")).trim())
          .filter((s) => isRealHumanName(s));

        const singleAliases: string[] = [];
        for (const candidate of [...wm.aliases, ...(multiWordNames.length === 0 ? [label] : [])]) {
          const clean = stripEmDashes(String(candidate || "")).trim();
          const toks = tokenizeNormalized(clean);
          if (toks.length === 1 && isValidPersonAliasOrHandle(toks[0])) {
            singleAliases.push(toks[0]);
            if (!validHandles.includes(toks[0])) {
              validHandles.push(toks[0]);
            }
          }
        }

        // Require either a real multi-word human name (>=2 words) or a valid handle/alias >=5 chars
        if (multiWordNames.length === 0 && validHandles.length === 0 && singleAliases.length === 0) {
          continue;
        }

        const searchTerms = Array.from(
          new Set(
            [
              label,
              card.canonical_name,
              card.slug,
              ...wm.aliases,
              ...validHandles,
            ]
              .map((s) => stripEmDashes(String(s || "")).trim())
              .filter(Boolean),
          ),
        );

        const ref: IndexedEntityRef = {
          kind: "person",
          id: card.slug,
          label,
          view: "people",
          target: card.slug,
          excerpt: singleLineExcerpt(
            wm.canonical_read ||
              [wm.role, wm.org].filter(Boolean).join(" at ") ||
              `${wm.relationship_tier} contact`,
            140,
          ),
          searchTerms,
          priority: 100,
        };
        registerEntity(ref, multiWordNames, false, validHandles);
        for (const aliasTok of singleAliases) {
          addMapList(singleTokenMap, aliasTok, ref);
        }
      }
    }

    // 2. Vault People directory items
    if (peopleRes?.items) {
      for (const p of peopleRes.items) {
        const slug = String(p.key || "").trim();
        if (!slug) continue;
        if (canonicalBySlug.has(slug.toLowerCase())) continue;
        const label = stripEmDashes(p.name || slug);
        if (isNoisyPersonEntity(label, slug)) continue;

        const multiWordNames = isRealHumanName(label) ? [label] : [];
        const validHandles = isValidPersonAliasOrHandle(slug) ? [slug.toLowerCase()] : [];
        const singleAliases: string[] = [];
        if (multiWordNames.length === 0) {
          const labelToks = tokenizeNormalized(label);
          if (labelToks.length === 1 && isValidPersonAliasOrHandle(labelToks[0])) {
            singleAliases.push(labelToks[0]);
            if (!validHandles.includes(labelToks[0])) {
              validHandles.push(labelToks[0]);
            }
          }
        }

        if (multiWordNames.length === 0 && validHandles.length === 0 && singleAliases.length === 0) {
          continue;
        }

        const ref: IndexedEntityRef = {
          kind: "person",
          id: slug,
          label,
          view: "people",
          target: slug,
          excerpt: singleLineExcerpt(
            p.preview ||
              [p.role, p.org].filter(Boolean).join(" at ") ||
              `${p.relationship_tier} contact`,
            140,
          ),
          searchTerms: Array.from(new Set([label, slug].filter(Boolean))),
          priority: 92,
        };
        registerEntity(ref, multiWordNames, false, validHandles);
        for (const aliasTok of singleAliases) {
          addMapList(singleTokenMap, aliasTok, ref);
        }
      }
    }

    // 3. Codex items
    if (codexRes?.items) {
      for (const item of codexRes.items) {
        const label = stripEmDashes(item.title || item.id);
        const searchTerms = Array.from(
          new Set(
            [
              label,
              item.id,
              ...(item.tags || []),
              item.domain,
            ]
              .map((s) => stripEmDashes(String(s || "")).trim())
              .filter(Boolean),
          ),
        );
        const ref: IndexedEntityRef = {
          kind: "codex",
          id: item.id,
          label,
          view: "codex",
          target: item.id,
          excerpt: singleLineExcerpt(item.summary || item.subtitle || label, 140),
          searchTerms,
          priority: 85,
        };
        const titleToks = tokenizeNormalized(label).filter(isDistinctiveSingleToken);
        const allowSingle = titleToks.length <= 2;
        registerEntity(ref, [label, item.id], allowSingle);
        // Also index distinctive multi-token title words >= 6 chars for recall
        for (const tok of titleToks) {
          if (tok.length >= 6) {
            addMapList(singleTokenMap, tok, ref);
          }
        }
      }
    }

    // 4. Taste rules + vault docs
    if (tasteRes) {
      const allRules = [
        ...(tasteRes.rules?.prefer || []),
        ...(tasteRes.rules?.avoid || []),
      ];
      for (const rule of allRules) {
        const label = singleLineExcerpt(rule.rule, 96);
        const ref: IndexedEntityRef = {
          kind: "taste",
          id: rule.id,
          label,
          view: "taste",
          target: rule.id,
          excerpt: singleLineExcerpt(
            rule.reason || `${rule.polarity.toUpperCase()} rule in ${rule.domain}`,
            140,
          ),
          searchTerms: [label, rule.domain, rule.id].filter(Boolean),
          priority: 80,
        };
        registerEntity(ref, [label, rule.id], false);
      }

      for (const doc of tasteRes.vault_docs || []) {
        const label = stripEmDashes(doc.title || doc.id);
        const ref: IndexedEntityRef = {
          kind: "taste",
          id: doc.id,
          label,
          view: "taste",
          target: doc.id,
          excerpt: singleLineExcerpt(doc.summary || `${doc.brand} (${doc.domain})`, 140),
          searchTerms: [label, doc.brand, doc.domain, doc.id].filter(Boolean),
          priority: 82,
        };
        const brandNorm = stripEmDashes(doc.brand || "").trim();
        registerEntity(ref, [label, brandNorm].filter(Boolean), true);
      }
    }

    // 5. Vault docs
    if (docsRes?.items) {
      for (const doc of docsRes.items) {
        const relPath = String(doc.path || "").trim();
        if (!relPath) continue;
        const baseName = relPath.split("/").pop() || relPath;
        const stem = baseName.replace(/\.md$/i, "");
        const label = stripEmDashes(doc.title || stem || relPath);
        const ref: IndexedEntityRef = {
          kind: "vault",
          id: relPath,
          label,
          view: "vault",
          target: relPath,
          excerpt: singleLineExcerpt(doc.excerpt || `${doc.category} document`, 140),
          searchTerms: Array.from(new Set([relPath, baseName, stem, label].filter(Boolean))),
          priority: 78,
        };
        const titleToks = tokenizeNormalized(label).filter(isDistinctiveSingleToken);
        const stemToks = tokenizeNormalized(stem).filter(isDistinctiveSingleToken);
        registerEntity(ref, [label, stem], stemToks.length === 1 && stem.length >= 5);
        for (const tok of titleToks) {
          if (tok.length >= 6) {
            addMapList(singleTokenMap, tok, ref);
          }
        }
        vaultPathMap.set(relPath.toLowerCase(), ref);
        if (baseName.toLowerCase().endsWith(".md") && !vaultPathMap.has(baseName.toLowerCase())) {
          vaultPathMap.set(baseName.toLowerCase(), ref);
        }
      }
    }

    // Prune overly ambiguous single-token buckets (> 3 entities) to prevent noisy links
    for (const [tok, refs] of singleTokenMap.entries()) {
      if (refs.length > 3) {
        singleTokenMap.delete(tok);
      }
    }

    return {
      builtAt: Date.now(),
      singleTokenMap,
      phrase2Map,
      phrase3Map,
      handleMap,
      vaultPathMap,
      byEntityKey,
      allByKind,
    };
  }

  private resolveMindLinksSync(
    index: EntityLookupIndex,
    text: string,
    channel?: string,
    maxLinks = 8,
  ): MindLink[] {
    const cap = clamp(Number(maxLinks) || 8, 1, 24);
    const sample = stripEmDashes(String(text ?? "").slice(0, 4000));
    if (!sample.trim()) return [];

    const channelLower = String(channel ?? "").toLowerCase();
    const candidates = new Map<string, { link: MindLink; score: number }>();

    const addCandidate = (link: MindLink, score: number) => {
      const dedupeKey = `${link.kind}:${link.target.toLowerCase()}`;
      const existing = candidates.get(dedupeKey);
      if (!existing || score > existing.score) {
        candidates.set(dedupeKey, { link, score });
      }
    };

    // Linear extractor 1: .md vault paths
    RE_MD_PATH.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE_MD_PATH.exec(sample)) !== null) {
      const rawPath = m[1].replace(/^\/+/, "");
      if (rawPath.includes("..")) continue;
      const lowerPath = rawPath.toLowerCase();
      const baseLower = (rawPath.split("/").pop() || rawPath).toLowerCase();
      const matchedDoc = index.vaultPathMap.get(lowerPath) || index.vaultPathMap.get(baseLower);
      if (matchedDoc) {
        addCandidate(
          {
            kind: "vault",
            id: matchedDoc.id,
            label: matchedDoc.label,
            view: "vault",
            target: matchedDoc.target,
            excerpt: matchedDoc.excerpt,
          },
          220,
        );
      } else {
        addCandidate(
          {
            kind: "vault",
            id: rawPath,
            label: stripEmDashes(rawPath.split("/").pop() || rawPath),
            view: "vault",
            target: rawPath,
            excerpt: `Referenced markdown document ${rawPath}`,
          },
          185,
        );
      }
    }

    // Linear extractor 2: Replay dates (20YY-MM-DD)
    RE_REPLAY_DATE.lastIndex = 0;
    while ((m = RE_REPLAY_DATE.exec(sample)) !== null) {
      const dateStr = m[1];
      addCandidate(
        {
          kind: "replay",
          id: dateStr,
          label: dateStr,
          view: "replay",
          target: dateStr,
          excerpt: `Daily activity replay for ${dateStr}`,
        },
        180,
      );
    }

    // Linear extractor 3: Commit SHAs (commit <sha> and backticked 7-40 hex, ignoring pure digits)
    const addCommitSha = (shaRaw: string, bonus: number) => {
      const sha = shaRaw.toLowerCase();
      if (RE_PURE_DIGITS.test(sha)) return;
      addCandidate(
        {
          kind: "commit",
          id: sha,
          label: `Commit ${sha.slice(0, 8)}`,
          view: "replay",
          target: sha,
          excerpt: `Git commit ${sha.slice(0, 12)}`,
        },
        170 + bonus,
      );
    };

    RE_COMMIT_WORD.lastIndex = 0;
    while ((m = RE_COMMIT_WORD.exec(sample)) !== null) {
      addCommitSha(m[1], 10);
    }
    RE_COMMIT_BACKTICK.lastIndex = 0;
    while ((m = RE_COMMIT_BACKTICK.exec(sample)) !== null) {
      addCommitSha(m[1], 0);
    }

    // Linear extractor 4: @handles
    RE_HANDLE_TOKEN.lastIndex = 0;
    while ((m = RE_HANDLE_TOKEN.exec(sample)) !== null) {
      const handle = m[1].toLowerCase();
      const ref = index.handleMap.get(handle);
      if (ref) {
        addCandidate(
          {
            kind: ref.kind,
            id: ref.id,
            label: ref.label,
            view: ref.view,
            target: ref.target,
            excerpt: ref.excerpt,
          },
          ref.priority + 95,
        );
      }
    }

    // O(tokens) Map lookups (3-gram, 2-gram, and >=4 char non-stopword 1-gram)
    const tokens = tokenizeNormalized(sample);
    const tokenLimit = Math.min(tokens.length, 450);

    for (let i = 0; i < tokenLimit; i++) {
      const t0 = tokens[i];

      if (i + 2 < tokenLimit) {
        const p3 = `${t0} ${tokens[i + 1]} ${tokens[i + 2]}`;
        const hits3 = index.phrase3Map.get(p3);
        if (hits3) {
          for (const ref of hits3) {
            const channelBoost =
              ref.kind === "taste" && channelLower.includes("taste") ? 15 : 0;
            addCandidate(
              {
                kind: ref.kind,
                id: ref.id,
                label: ref.label,
                view: ref.view,
                target: ref.target,
                excerpt: ref.excerpt,
              },
              ref.priority + 90 + channelBoost,
            );
          }
        }
      }

      if (i + 1 < tokenLimit) {
        const p2 = `${t0} ${tokens[i + 1]}`;
        const hits2 = index.phrase2Map.get(p2);
        if (hits2) {
          for (const ref of hits2) {
            const channelBoost =
              ref.kind === "taste" && channelLower.includes("taste") ? 15 : 0;
            addCandidate(
              {
                kind: ref.kind,
                id: ref.id,
                label: ref.label,
                view: ref.view,
                target: ref.target,
                excerpt: ref.excerpt,
              },
              ref.priority + 75 + channelBoost,
            );
          }
        }
      }

      if (isDistinctiveSingleToken(t0)) {
        const hits1 = index.singleTokenMap.get(t0);
        if (hits1) {
          for (const ref of hits1) {
            const channelBoost =
              ref.kind === "taste" && channelLower.includes("taste") ? 15 : 0;
            addCandidate(
              {
                kind: ref.kind,
                id: ref.id,
                label: ref.label,
                view: ref.view,
                target: ref.target,
                excerpt: ref.excerpt,
              },
              ref.priority + 35 + channelBoost,
            );
          }
        }
      }
    }

    return Array.from(candidates.values())
      .sort((a, b) => b.score - a.score || a.link.label.localeCompare(b.link.label))
      .slice(0, cap)
      .map((entry) => ({
        ...entry.link,
        label: stripEmDashes(entry.link.label),
        excerpt: stripEmDashes(entry.link.excerpt),
      }));
  }

  async resolveMindLinks(
    text: string,
    channel?: string,
    maxLinks = 8,
  ): Promise<MindLink[]> {
    const index = await this.getEntityIndex();
    return this.resolveMindLinksSync(index, text, channel, maxLinks);
  }

  // ============================================================================
  // Batched reply loader (single SQLite query, zero N+1)
  // ============================================================================

  private batchFetchReplies(
    db: Database,
    rootIds: number[],
  ): Map<number, BoardMessageItem[]> {
    const grouped = new Map<number, BoardMessageItem[]>();
    if (rootIds.length === 0) return grouped;

    const uniqueIds = Array.from(new Set(rootIds));
    // SQLite default parameter limit is 999; 600 fits in one single query.
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0 AND re IN (${placeholders})
         ORDER BY created_at DESC, id DESC`,
      )
      .all(...uniqueIds) as RawBoardRow[];

    for (const row of rows) {
      if (row.re === null || row.re === undefined) continue;
      let list = grouped.get(row.re);
      if (!list) {
        list = [];
        grouped.set(row.re, list);
      }
      list.push(rowToBoardMessageItem(row));
    }
    return grouped;
  }

  private buildReplyPreview(repliesDesc: BoardMessageItem[], max = 3): ReplyPreviewItem[] {
    return repliesDesc.slice(0, max).map((r) => {
      const excerpt = singleLineExcerpt(r.text, 240);
      return {
        id: r.id,
        numericId: r.numericId,
        by: r.by,
        displayName: r.displayName,
        brand: r.brand,
        role: r.role,
        excerpt,
        text: excerpt,
        createdAt: r.createdAt,
        createdAtMs: r.createdAtMs,
      };
    });
  }

  private collectParticipants(root: BoardMessageItem, replies: BoardMessageItem[], max = 8): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const push = (handle: string) => {
      const clean = stripEmDashes(String(handle || "")).trim();
      if (!clean || seen.has(clean)) return;
      seen.add(clean);
      out.push(clean);
    };
    push(root.by);
    for (const r of replies) {
      if (out.length >= max) break;
      push(r.by);
    }
    return out;
  }

  // ============================================================================
  // 3. getMissionFeed(opts?)
  // ============================================================================

  async getMissionFeed(opts: MissionFeedOptions = {}): Promise<MissionFeedResponse> {
    const limit = clamp(Number(opts.limit ?? 40) || 40, 1, 200);
    const sinceHours = clamp(Number(opts.sinceHours ?? 168) || 168, 1, 24 * 365);
    const includeTelemetry = Boolean(opts.includeTelemetry);
    const channelFilter = opts.channel ? validateChannel(opts.channel) : null;
    const signalKindFilter = opts.signalKind || null;
    const qLower = String(opts.q ?? "").trim().toLowerCase();

    const db = this.tryGetBoardDb();
    if (!db) {
      const synthReady = await this.isLocalLlmReady();
      return {
        items: [],
        telemetryCount: 0,
        signalCount: 0,
        telemetrySummary: [],
        activeRooms: [],
        synthReady,
        generatedAt: new Date().toISOString(),
      };
    }

    const [index, synthReady] = await Promise.all([
      this.getEntityIndex({ nonBlocking: true, vaultPeopleTimeoutMs: 120 }),
      this.isLocalLlmReady(),
    ]);

    const dataVersion = this.getBoardDataVersion(db);
    const memoKey = `${dataVersion}|${this.indexVersion}|${synthReady ? 1 : 0}|${limit}|${sinceHours}|${includeTelemetry ? 1 : 0}|${channelFilter || ""}|${signalKindFilter || ""}|${qLower}`;
    const cached = this.missionFeedMemo.get(memoKey);
    if (cached && Date.now() - cached.builtAt < 30_000) {
      return cached.value;
    }

    const generatedAt = new Date().toISOString();
    const nowMs = Date.now();
    const windowMs = sinceHours * 3600 * 1000;
    const cutoffMs = nowMs - windowMs;

    const rootRows = channelFilter
      ? (db
          .query(
            `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                    from_key, no_sync, text_lower, deleted, created_at, replies, at, data
             FROM board_messages
             WHERE deleted = 0 AND re IS NULL AND channel = ?
               AND (created_at >= ? OR (at >= 1000000000000 AND at >= ?))
             ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
             LIMIT 600`,
          )
          .all(channelFilter, cutoffMs, cutoffMs) as RawBoardRow[])
      : (db
          .query(
            `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                    from_key, no_sync, text_lower, deleted, created_at, replies, at, data
             FROM board_messages
             WHERE deleted = 0 AND re IS NULL
               AND (created_at >= ? OR (at >= 1000000000000 AND at >= ?))
             ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
             LIMIT 600`,
          )
          .all(cutoffMs, cutoffMs) as RawBoardRow[]);

    const telemetryBuckets = new Map<
      string,
      {
        kind: string;
        label: string;
        count: number;
        latestAtMs: number;
        latestAt: string;
        channels: Set<string>;
        sample: string;
      }
    >();

    const roomStats = new Map<
      string,
      {
        channel: string;
        signalCount: number;
        telemetryCount: number;
        blockedCount: number;
        decisionCount: number;
        debateCount: number;
        lastAtMs: number;
        lastAt: string;
        participants: Set<string>;
      }
    >();

    let telemetryCount = 0;
    let signalCount = 0;

    const classifiedRoots: Array<{
      item: BoardMessageItem;
      signal: SignalClassification;
    }> = [];

    for (const row of rootRows) {
      const item = rowToBoardMessageItem(row);
      const signal = this.classifySignal(item);
      classifiedRoots.push({ item, signal });

      let room = roomStats.get(item.channel);
      if (!room) {
        room = {
          channel: item.channel,
          signalCount: 0,
          telemetryCount: 0,
          blockedCount: 0,
          decisionCount: 0,
          debateCount: 0,
          lastAtMs: item.lastAtMs,
          lastAt: item.lastAt,
          participants: new Set<string>(),
        };
        roomStats.set(item.channel, room);
      }
      if (item.lastAtMs > room.lastAtMs) {
        room.lastAtMs = item.lastAtMs;
        room.lastAt = item.lastAt;
      }
      room.participants.add(item.by);

      if (signal.isTelemetry) {
        telemetryCount++;
        room.telemetryCount++;
        const subtype = detectTelemetrySubtype(item) || {
          kind: "telemetry",
          label: "Telemetry",
        };
        let bucket = telemetryBuckets.get(subtype.kind);
        if (!bucket) {
          bucket = {
            kind: subtype.kind,
            label: subtype.label,
            count: 0,
            latestAtMs: item.lastAtMs,
            latestAt: item.lastAt,
            channels: new Set<string>(),
            sample: singleLineExcerpt(item.text, 120),
          };
          telemetryBuckets.set(subtype.kind, bucket);
        }
        bucket.count++;
        bucket.channels.add(item.channel);
        if (item.lastAtMs > bucket.latestAtMs) {
          bucket.latestAtMs = item.lastAtMs;
          bucket.latestAt = item.lastAt;
          bucket.sample = singleLineExcerpt(item.text, 120);
        }
      } else {
        signalCount++;
        room.signalCount++;
        if (item.isBlocked) room.blockedCount++;
        if (signal.signalKind === "decision") room.decisionCount++;
        if (signal.signalKind === "debate") room.debateCount++;
      }
    }

    // Filter candidate roots
    let candidates = classifiedRoots.filter(({ signal }) => {
      if (!includeTelemetry && signal.isTelemetry) return false;
      if (signalKindFilter && signal.signalKind !== signalKindFilter) return false;
      return true;
    });

    // ONE single batched SQLite query for replies across all candidate roots
    const candidateRootIds = candidates.map((c) => c.item.numericId);
    const repliesByRoot = this.batchFetchReplies(db, candidateRootIds);

    // Enrich room participants from batched replies
    for (const { item } of candidates) {
      const room = roomStats.get(item.channel);
      const reps = repliesByRoot.get(item.numericId);
      if (room && reps) {
        for (const r of reps) {
          room.participants.add(r.by);
        }
      }
    }

    // Apply optional text query filter across root + replies
    if (qLower) {
      candidates = candidates.filter(({ item }) => {
        if (
          item.text.toLowerCase().includes(qLower) ||
          item.channel.toLowerCase().includes(qLower) ||
          item.by.toLowerCase().includes(qLower) ||
          item.title.toLowerCase().includes(qLower)
        ) {
          return true;
        }
        const reps = repliesByRoot.get(item.numericId);
        if (reps) {
          return reps.some(
            (r) =>
              r.text.toLowerCase().includes(qLower) ||
              r.by.toLowerCase().includes(qLower),
          );
        }
        return false;
      });
    }

    // Rank so rich multi-agent threads (blocked, replies >= 1, signal weight, recency) float to top
    const rankScore = (item: BoardMessageItem, signal: SignalClassification): number => {
      if (signal.isTelemetry) {
        const ageMs = Math.max(0, nowMs - item.lastAtMs);
        const recency = Math.max(0, 10 * (1 - ageMs / windowMs));
        return signal.weight + recency;
      }
      const reps = repliesByRoot.get(item.numericId) || [];
      const effectiveReplies = Math.max(item.replies, reps.length);
      const participantsCount = this.collectParticipants(item, reps, 8).length;
      const ageMs = Math.max(0, nowMs - item.lastAtMs);
      const recency = Math.max(0, 120 * (1 - ageMs / windowMs));
      return (
        (item.isBlocked ? 500 : 0) +
        (item.isPaused ? 220 : 0) +
        signal.weight * 3 +
        (effectiveReplies >= 1 ? 85 + Math.min(120, effectiveReplies * 22) : 0) +
        (participantsCount >= 2 ? Math.min(60, (participantsCount - 1) * 20) : 0) +
        recency
      );
    };

    candidates.sort((a, b) => {
      const diff = rankScore(b.item, b.signal) - rankScore(a.item, a.signal);
      if (diff !== 0) return diff;
      return b.item.lastAtMs - a.item.lastAtMs || b.item.numericId - a.item.numericId;
    });

    const selected = candidates.slice(0, limit);

    const items: MissionFeedItem[] = selected.map(({ item, signal }) => {
      const reps = repliesByRoot.get(item.numericId) || [];
      const replyPreview = this.buildReplyPreview(reps, 3);
      const participants = this.collectParticipants(item, reps, 8);
      const latestReplyMs = reps.length > 0 ? reps[0].createdAtMs : 0;
      const effectiveLastAtMs = Math.max(item.lastAtMs, latestReplyMs);
      const linkSourceText =
        replyPreview.length > 0
          ? `${item.text}\n${replyPreview.map((r) => r.text).join("\n")}`
          : item.text;
      const mindLinks = this.resolveMindLinksSync(index, linkSourceText, item.channel, 8);
      return {
        ...item,
        lastAtMs: effectiveLastAtMs,
        lastAt: toIso(effectiveLastAtMs),
        replies: Math.max(item.replies, reps.length),
        signal,
        mindLinks,
        replyPreview,
        participants,
      };
    });

    const telemetrySummary: TelemetryBucket[] = Array.from(telemetryBuckets.values())
      .sort((a, b) => b.count - a.count || b.latestAtMs - a.latestAtMs)
      .map((b) => ({
        kind: b.kind,
        label: b.label,
        count: b.count,
        latestAt: b.latestAt,
        channels: Array.from(b.channels).sort(),
        sample: b.sample,
      }));

    const activeRooms: ActiveRoomSummary[] = Array.from(roomStats.values())
      .map((r) => {
        const group = classifyChannelGroup(r.channel);
        return {
          channel: r.channel,
          name: titleCaseChannelLeaf(r.channel),
          group,
          groupLabel: getGroupLabel(group),
          signalCount: r.signalCount,
          telemetryCount: r.telemetryCount,
          blockedCount: r.blockedCount,
          decisionCount: r.decisionCount,
          debateCount: r.debateCount,
          lastAt: r.lastAt,
          lastAtMs: r.lastAtMs,
          participants: Array.from(r.participants).slice(0, 8),
        };
      })
      .sort((a, b) => {
        const scoreA =
          a.blockedCount * 40 +
          a.decisionCount * 25 +
          a.debateCount * 15 +
          a.signalCount * 5;
        const scoreB =
          b.blockedCount * 40 +
          b.decisionCount * 25 +
          b.debateCount * 15 +
          b.signalCount * 5;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return b.lastAtMs - a.lastAtMs;
      });

    const response: MissionFeedResponse = {
      items,
      telemetryCount,
      signalCount,
      telemetrySummary,
      activeRooms,
      synthReady,
      generatedAt,
    };
    if (this.missionFeedMemo.size >= 32) {
      const firstKey = this.missionFeedMemo.keys().next().value;
      if (firstKey !== undefined) {
        this.missionFeedMemo.delete(firstKey);
      }
    }
    this.missionFeedMemo.set(memoKey, { builtAt: Date.now(), value: response });
    return response;
  }

  // ============================================================================
  // 4. getEntityThreads(kind, key, limit = 12)
  // ============================================================================

  private deriveEntityTerms(
    index: EntityLookupIndex,
    kind: EntityThreadKind,
    rawKey: string,
  ): { label: string; terms: string[] } {
    const keyClean = stripEmDashes(rawKey).trim();
    const keyLower = keyClean.toLowerCase();

    let ref = index.byEntityKey.get(`${kind}:${keyClean}`);
    if (!ref) {
      for (const candidate of index.allByKind[kind]) {
        if (
          candidate.id.toLowerCase() === keyLower ||
          candidate.target.toLowerCase() === keyLower ||
          candidate.label.toLowerCase() === keyLower
        ) {
          ref = candidate;
          break;
        }
      }
    }

    const label = ref ? ref.label : keyClean;
    const rawPool: string[] = [];

    if (ref) {
      rawPool.push(ref.label);
      rawPool.push(...ref.searchTerms);
      if (kind === "vault") {
        const base = ref.target.split("/").pop() || ref.target;
        rawPool.push(ref.target, base, base.replace(/\.md$/i, ""));
      }
    } else {
      rawPool.push(keyClean);
      if (kind === "vault") {
        const base = keyClean.split("/").pop() || keyClean;
        rawPool.push(base, base.replace(/\.md$/i, ""));
      }
    }

    const termSet = new Set<string>();
    const addTerm = (t: string) => {
      const clean = t.trim().toLowerCase();
      if (!clean) return;
      if (clean.includes(" ") || clean.includes("/") || clean.endsWith(".md")) {
        if (clean.length >= 4) termSet.add(clean);
        return;
      }
      if (clean.startsWith("@") && clean.length >= 3) {
        termSet.add(clean);
        const bare = clean.slice(1);
        if (isDistinctiveSingleToken(bare)) termSet.add(bare);
        return;
      }
      if (isDistinctiveSingleToken(clean)) {
        termSet.add(clean);
      }
    };

    for (const raw of rawPool) {
      const clean = stripEmDashes(raw).trim();
      if (!clean) continue;
      addTerm(clean);
      const toks = tokenizeNormalized(clean);
      if (toks.length >= 2) {
        addTerm(`${toks[0]} ${toks[1]}`);
      }
      for (const tok of toks) {
        if (tok.length >= 5 && isDistinctiveSingleToken(tok)) {
          addTerm(tok);
        }
      }
    }

    // If we still have < 2 terms, relax single-token length down to >= 4 non-stopword
    if (termSet.size < 2) {
      for (const raw of rawPool) {
        for (const tok of tokenizeNormalized(raw)) {
          if (isDistinctiveSingleToken(tok)) {
            termSet.add(tok);
          }
        }
      }
    }

    // Order most specific first (paths / multi-word / longer terms)
    const ordered = Array.from(termSet)
      .sort((a, b) => {
        const specA = (a.includes("/") || a.endsWith(".md") ? 50 : 0) + (a.includes(" ") ? 30 : 0) + a.length;
        const specB = (b.includes("/") || b.endsWith(".md") ? 50 : 0) + (b.includes(" ") ? 30 : 0) + b.length;
        return specB - specA;
      })
      .slice(0, 8);

    return { label: stripEmDashes(label), terms: ordered };
  }

  async getEntityThreads(
    kind: EntityThreadKind,
    key: string,
    limit = 12,
  ): Promise<EntityThreadsResponse> {
    if (!VALID_ENTITY_KINDS.has(kind)) {
      throw new BadRequestError(
        `Invalid entity kind "${String(kind)}": expected person, codex, taste, or vault`,
      );
    }
    const cleanKey = String(key ?? "").trim();
    if (!cleanKey || cleanKey.length > 240) {
      throw new BadRequestError("Entity key must be a non-empty string (max 240 chars)");
    }
    const cap = clamp(Number(limit) || 12, 1, 50);

    const index = await this.getEntityIndex();
    const { label, terms } = this.deriveEntityTerms(index, kind, cleanKey);

    const db = this.tryGetBoardDb();
    if (!db || terms.length === 0) {
      return { kind, key: cleanKey, label, total: 0, threads: [] };
    }

    const likeClauses = terms.map(() => "text_lower LIKE ? ESCAPE '\\'").join(" OR ");
    const likeParams = terms.map((t) => `%${escapeLikeParam(t)}%`);

    const hitRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0 AND (${likeClauses})
         ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
         LIMIT 200`,
      )
      .all(...likeParams) as RawBoardRow[];

    if (hitRows.length === 0) {
      return { kind, key: cleanKey, label, total: 0, threads: [] };
    }

    // Collect root IDs and fetch missing root rows in ONE batched query
    const rootMap = new Map<number, BoardMessageItem>();
    const missingRootIds: number[] = [];
    const matchedTextsByRoot = new Map<number, { texts: string[]; inReply: boolean }>();

    for (const row of hitRows) {
      const item = rowToBoardMessageItem(row);
      const rootId = row.re !== null && row.re !== undefined ? row.re : row.id;
      if (row.re === null || row.re === undefined) {
        rootMap.set(row.id, item);
      } else if (!rootMap.has(rootId)) {
        missingRootIds.push(rootId);
      }
      let bucket = matchedTextsByRoot.get(rootId);
      if (!bucket) {
        bucket = { texts: [], inReply: false };
        matchedTextsByRoot.set(rootId, bucket);
      }
      bucket.texts.push(item.text.toLowerCase());
      if (row.re !== null && row.re !== undefined) {
        bucket.inReply = true;
      }
    }

    const uniqueMissing = Array.from(new Set(missingRootIds)).filter((id) => !rootMap.has(id));
    if (uniqueMissing.length > 0) {
      const ph = uniqueMissing.map(() => "?").join(", ");
      const parentRows = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE deleted = 0 AND id IN (${ph})`,
        )
        .all(...uniqueMissing) as RawBoardRow[];
      for (const pRow of parentRows) {
        rootMap.set(pRow.id, rowToBoardMessageItem(pRow));
      }
    }

    const resolvedRootIds = Array.from(rootMap.keys());
    const repliesByRoot = this.batchFetchReplies(db, resolvedRootIds);

    const matches: EntityThreadMatch[] = [];
    for (const [rootId, root] of rootMap.entries()) {
      const signal = this.classifySignal(root);
      const meta = matchedTextsByRoot.get(rootId);
      const reps = repliesByRoot.get(rootId) || [];
      const corpusLower = [
        root.text.toLowerCase(),
        ...(meta?.texts || []),
        ...reps.slice(0, 6).map((r) => r.text.toLowerCase()),
      ].join("\n");

      const matchedTerms: string[] = [];
      let termScore = 0;
      for (const term of terms) {
        if (corpusLower.includes(term)) {
          matchedTerms.push(term);
          const specificity =
            (term.includes("/") || term.endsWith(".md") ? 35 : 0) +
            (term.includes(" ") ? 25 : 0) +
            Math.min(18, term.length * 2);
          termScore += 20 + specificity;
        }
      }
      if (matchedTerms.length === 0) continue;

      const score =
        termScore +
        signal.weight +
        (root.isBlocked ? 40 : 0) +
        Math.min(30, Math.max(root.replies, reps.length) * 6);

      matches.push({
        root: {
          ...root,
          replies: Math.max(root.replies, reps.length),
        },
        signal,
        matchedTerms,
        matchCount: matchedTerms.length,
        score,
        matchedInReply: Boolean(meta?.inReply),
        participants: this.collectParticipants(root, reps, 8),
        replyPreview: this.buildReplyPreview(reps, 3),
      });
    }

    matches.sort(
      (a, b) =>
        b.score - a.score ||
        b.root.lastAtMs - a.root.lastAtMs ||
        b.root.numericId - a.root.numericId,
    );

    return {
      kind,
      key: cleanKey,
      label,
      total: matches.length,
      threads: matches.slice(0, cap),
    };
  }

  // ============================================================================
  // 5. getTodayBoardPulse()
  // ============================================================================

  async getTodayBoardPulse(): Promise<TodayBoardPulseResponse> {
    const db = this.tryGetBoardDb();
    if (!db) {
      return {
        available: false,
        openDecisions: 0,
        blockedCount: 0,
        activeAgents: [],
        topThreads: [],
        generatedAt: new Date().toISOString(),
      };
    }

    const index = await this.getEntityIndex({ nonBlocking: true, vaultPeopleTimeoutMs: 120 });
    const dataVersion = this.getBoardDataVersion(db);
    if (
      this.todayPulseMemo &&
      this.todayPulseMemo.dataVersion === dataVersion &&
      this.todayPulseMemo.indexVersion === this.indexVersion &&
      Date.now() - this.todayPulseMemo.builtAt < 30_000
    ) {
      return this.todayPulseMemo.value;
    }

    const generatedAt = new Date().toISOString();
    const nowMs = Date.now();
    const weekCutoffMs = nowMs - 7 * 24 * 3600 * 1000;
    const dayCutoffMs = nowMs - 24 * 3600 * 1000;

    const rootRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE deleted = 0 AND re IS NULL
           AND (created_at >= ? OR (at >= 1000000000000 AND at >= ?))
         ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
         LIMIT 250`,
      )
      .all(weekCutoffMs, weekCutoffMs) as RawBoardRow[];

    let openDecisions = 0;
    let blockedCount = 0;
    const signalCandidates: Array<{ item: BoardMessageItem; signal: SignalClassification }> = [];

    for (const row of rootRows) {
      const item = rowToBoardMessageItem(row);
      const signal = this.classifySignal(item);
      if (item.isBlocked) blockedCount++;
      const isFinished = item.taskState !== null && FINISHED_TASK_STATES.has(item.taskState);
      if (signal.signalKind === "decision" && !isFinished) {
        openDecisions++;
      }
      if (!signal.isTelemetry) {
        signalCandidates.push({ item, signal });
      }
    }

    // Active agents in last 24h (pure SQLite)
    const agentRows = db
      .query(
        `SELECT by_actor, by_principal, by_profile,
                COUNT(*) AS recent_messages,
                MAX(created_at) AS last_at_ms
         FROM board_messages
         WHERE deleted = 0 AND created_at >= ?
         GROUP BY by_actor, by_principal, by_profile
         ORDER BY last_at_ms DESC
         LIMIT 12`,
      )
      .all(dayCutoffMs) as Array<{
      by_actor: string;
      by_principal: string;
      by_profile: string | null;
      recent_messages: number;
      last_at_ms: number;
    }>;

    const agentMap = new Map<string, TodayPulseAgent>();
    for (const r of agentRows) {
      const id = classifyAgentIdentity(r.by_actor, r.by_principal, r.by_profile);
      const prev = agentMap.get(id.handle);
      const lastIso = toIso(r.last_at_ms);
      if (!prev) {
        agentMap.set(id.handle, {
          handle: id.handle,
          displayName: stripEmDashes(id.displayName),
          brand: id.brand,
          role: id.role,
          recentMessages: Number(r.recent_messages) || 0,
          lastAt: lastIso,
        });
      } else {
        prev.recentMessages += Number(r.recent_messages) || 0;
        if (lastIso > prev.lastAt) prev.lastAt = lastIso;
      }
    }

    const activeAgents = Array.from(agentMap.values())
      .sort((a, b) => b.recentMessages - a.recentMessages)
      .slice(0, 8);

    // Pre-rank top 20 candidates, batch-fetch replies once, then pick top 4 multi-agent high-signal threads
    signalCandidates.sort((a, b) => {
      const scoreA =
        (a.item.isBlocked ? 500 : 0) +
        (a.item.replies >= 1 ? 120 + a.item.replies * 20 : 0) +
        a.signal.weight * 3;
      const scoreB =
        (b.item.isBlocked ? 500 : 0) +
        (b.item.replies >= 1 ? 120 + b.item.replies * 20 : 0) +
        b.signal.weight * 3;
      return scoreB - scoreA || b.item.lastAtMs - a.item.lastAtMs;
    });

    const shortlist = signalCandidates.slice(0, 20);
    const repliesByRoot = this.batchFetchReplies(
      db,
      shortlist.map((c) => c.item.numericId),
    );

    shortlist.sort((a, b) => {
      const repsA = repliesByRoot.get(a.item.numericId) || [];
      const repsB = repliesByRoot.get(b.item.numericId) || [];
      const partA = this.collectParticipants(a.item, repsA, 8).length;
      const partB = this.collectParticipants(b.item, repsB, 8).length;
      const scoreA =
        (a.item.isBlocked ? 500 : 0) +
        (partA >= 2 ? 140 + partA * 20 : 0) +
        Math.max(a.item.replies, repsA.length) * 18 +
        a.signal.weight * 3;
      const scoreB =
        (b.item.isBlocked ? 500 : 0) +
        (partB >= 2 ? 140 + partB * 20 : 0) +
        Math.max(b.item.replies, repsB.length) * 18 +
        b.signal.weight * 3;
      return scoreB - scoreA || b.item.lastAtMs - a.item.lastAtMs;
    });

    const top4 = shortlist.slice(0, 4);

    const topThreads: MissionFeedItem[] = top4.map(({ item, signal }) => {
      const reps = repliesByRoot.get(item.numericId) || [];
      const replyPreview = this.buildReplyPreview(reps, 3);
      const participants = this.collectParticipants(item, reps, 8);
      const latestReplyMs = reps.length > 0 ? reps[0].createdAtMs : 0;
      const effectiveLastAtMs = Math.max(item.lastAtMs, latestReplyMs);
      const linkText =
        replyPreview.length > 0
          ? `${item.text}\n${replyPreview.map((r) => r.text).join("\n")}`
          : item.text;
      const mindLinks = this.resolveMindLinksSync(index, linkText, item.channel, 6);
      return {
        ...item,
        lastAtMs: effectiveLastAtMs,
        lastAt: toIso(effectiveLastAtMs),
        replies: Math.max(item.replies, reps.length),
        signal,
        mindLinks,
        replyPreview,
        participants,
      };
    });

    const pulse: TodayBoardPulseResponse = {
      available: true,
      openDecisions,
      blockedCount,
      activeAgents,
      topThreads,
      generatedAt,
    };
    this.todayPulseMemo = {
      dataVersion,
      indexVersion: this.indexVersion,
      builtAt: Date.now(),
      value: pulse,
    };
    return pulse;
  }

  // ============================================================================
  // 6. promoteThreadToCodex({ threadId, section, title?, note? })
  // ============================================================================

  async promoteThreadToCodex(
    req: PromoteThreadToCodexRequest,
  ): Promise<PromoteThreadToCodexResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("promoteThreadToCodex payload is required");
    }
    const threadId = validateThreadId(req.threadId);
    if (!VALID_CODEX_SECTIONS.has(req.section)) {
      throw new BadRequestError(
        `Invalid Codex section "${String(req.section)}": expected philosophies, interests, hobbies, ideas, or actions`,
      );
    }

    const thread = await this.agentBoardApi.getThread(threadId);
    const root = thread.root;
    const replies = thread.replies || [];
    const signal = this.classifySignal(root);

    const deterministicId = `codex_board_${root.numericId}`;
    const cleanTitle = cleanText(req.title || root.title || `Board Thread #${root.numericId}`, 140);
    const cleanNote = req.note ? cleanText(req.note, 600) : "";

    const replySnippets = replies
      .slice(-4)
      .map((r) => `${r.by}: ${singleLineExcerpt(r.text, 160)}`);
    const summaryParts = [
      cleanNote,
      singleLineExcerpt(root.text, 420),
      replySnippets.length > 0 ? `Thread replies: ${replySnippets.join(" | ")}` : "",
    ].filter(Boolean);

    const combinedText = `${root.text}\n${replies.map((r) => r.text).join("\n")}`;
    const links = await this.resolveMindLinks(combinedText, root.channel, 8);
    const linkedPeople = links
      .filter((l) => l.kind === "person")
      .map((l) => l.label);

    const participants = this.collectParticipants(root, replies, 8);
    const subtitle = cleanText(
      `Agent Board #${root.numericId} in ${root.channel} (${participants.join(", ")})`,
      160,
    );

    const upserted = this.codexApi.upsertItem({
      id: deterministicId,
      section: req.section,
      title: cleanTitle,
      subtitle,
      summary: cleanText(summaryParts.join(" "), 1200),
      thesis: cleanNote || singleLineExcerpt(root.text, 280),
      domain: inferCodexDomainFromChannel(root.channel),
      conviction: signal.signalKind === "decision" ? "core" : "active",
      status: req.section === "actions" ? "open" : "living",
      leverage_score: clamp(signal.weight, 50, 98),
      tags: [
        "agent-board",
        `channel:${root.channel}`,
        `thread:${root.numericId}`,
        signal.signalKind,
      ],
      linked_people: linkedPeople,
    });

    this.invalidateEntityIndex();

    return {
      ok: true,
      threadId: root.id,
      channel: root.channel,
      codexItem: upserted.item,
      stats: upserted.stats,
    };
  }

  // ============================================================================
  // 7. dispatchMindItemToBoard(...)
  // ============================================================================

  async dispatchMindItemToBoard(
    req: DispatchMindItemRequest,
  ): Promise<DispatchMindItemResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("dispatchMindItemToBoard payload is required");
    }

    // Defense-in-depth loopback + :4114 check
    assertLoopbackUrl(this.agentBoardApi.boardUrl, "boardUrl");

    const channel = validateChannel(req.channel);
    const bodyText = stripEmDashes(validateMessageText(req.text));

    const sourceKind = String(req.sourceKind ?? "").trim();
    if (!RE_SOURCE_KIND.test(sourceKind)) {
      throw new BadRequestError(
        "Invalid sourceKind: expected 1-32 alphanumeric/._- characters",
      );
    }

    const sourceId = stripEmDashes(String(req.sourceId ?? "").replace(/\0/g, "").trim());
    if (!sourceId || sourceId.length > 180 || /[\x00-\x1f\x7f\r\n]/.test(sourceId)) {
      throw new BadRequestError(
        "Invalid sourceId: expected non-empty single-line identifier (max 180 chars)",
      );
    }

    const sourceLabel = stripEmDashes(String(req.sourceLabel ?? "").replace(/\0/g, "").trim());
    if (!sourceLabel || sourceLabel.length > 140 || /[\x00-\x1f\x7f\r\n]/.test(sourceLabel)) {
      throw new BadRequestError(
        "Invalid sourceLabel: expected non-empty single-line label (max 140 chars)",
      );
    }

    let prefix = "";
    if (req.targetAgent !== undefined && req.targetAgent !== null && String(req.targetAgent).trim() !== "") {
      const cleanAgent = String(req.targetAgent).trim().replace(/^@+/, "");
      if (!RE_AGENT_HANDLE.test(cleanAgent)) {
        throw new BadRequestError(
          "Invalid targetAgent: expected 1-64 alphanumeric/._- characters",
        );
      }
      const escaped = cleanAgent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const alreadyMentioned = new RegExp(`(?:^|\\s)@${escaped}(?=$|[\\s,.:;!?])`, "i").test(
        bodyText,
      );
      if (!alreadyMentioned) {
        prefix = `@${cleanAgent} `;
      }
    }

    const tagLine = `[Kizuki ${sourceKind}: ${sourceLabel} (${sourceId})]`;
    const composedText = stripEmDashes(`${prefix}${bodyText}\n\n${tagLine}`);

    const posted = await this.agentBoardApi.postMessage({
      channel,
      text: composedText,
      labels: {
        origin: "kizuki-bridge",
        source_kind: sourceKind,
      },
      idempotencyKey: req.idempotencyKey,
    });

    return {
      ok: true,
      id: posted.id,
      channel: posted.channel,
      text: composedText,
      sourceKind,
      sourceId,
      raw: posted.raw,
    };
  }

  // ============================================================================
  // 8. synthesizeWithLocalLlm({ threadId?, channel? })
  // ============================================================================

  private loadThreadFromSqlite(
    db: Database,
    rawThreadId: string,
  ): { root: BoardMessageItem; replies: BoardMessageItem[] } {
    const idStr = validateThreadId(rawThreadId);
    let rootRow: RawBoardRow | null = null;

    if (RE_NUMERIC_ID.test(idStr)) {
      rootRow = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE id = ? AND deleted = 0`,
        )
        .get(Number(idStr)) as RawBoardRow | null;
    } else {
      rootRow = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE event_id = ? AND deleted = 0`,
        )
        .get(idStr) as RawBoardRow | null;

      if (!rootRow && idStr.startsWith("key:")) {
        const bareKey = idStr.slice(4);
        rootRow = db
          .query(
            `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                    from_key, no_sync, text_lower, deleted, created_at, replies, at, data
             FROM board_messages
             WHERE (from_key = ? OR from_key = ?) AND deleted = 0`,
          )
          .get(idStr, bareKey) as RawBoardRow | null;
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
        .get(rootRow.re) as RawBoardRow | null;
      if (parentRow) {
        rootRow = parentRow;
      }
    }

    const root = rowToBoardMessageItem(rootRow);
    const replyRows = db
      .query(
        `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                from_key, no_sync, text_lower, deleted, created_at, replies, at, data
         FROM board_messages
         WHERE re = ? AND deleted = 0
         ORDER BY created_at ASC, id ASC
         LIMIT 24`,
      )
      .all(root.numericId) as RawBoardRow[];

    return {
      root,
      replies: replyRows.map(rowToBoardMessageItem),
    };
  }

  private async probeLocalLlmModels(
    endpointUrl: string,
    timeoutMs = this.probeTimeoutMs,
  ): Promise<ProbeCacheEntry> {
    const now = Date.now();
    if (this.probeCache) {
      if (now - this.probeCache.checkedAt < this.probeTtlMs) {
        return this.probeCache;
      }
      if (!this.closed && !this.probeInFlight) {
        void this.runLocalLlmProbe(endpointUrl, timeoutMs);
      }
      return this.probeCache;
    }
    return this.runLocalLlmProbe(endpointUrl, timeoutMs);
  }

  private runLocalLlmProbe(
    endpointUrl: string,
    timeoutMs: number,
  ): Promise<ProbeCacheEntry> {
    if (this.probeInFlight) {
      return this.probeInFlight;
    }
    const now = Date.now();
    const modelsUrl = assertLoopbackUrl(
      endpointUrl.replace(/\/v1\/chat\/completions\/?$/, "/v1/models"),
      "localLlmModelsUrl",
    );

    const task = (async (): Promise<ProbeCacheEntry> => {
      try {
        const resp = await this.fetchImpl(modelsUrl, {
          method: "GET",
          signal: AbortSignal.timeout(Math.max(50, timeoutMs)),
        });
        if (resp.status !== 200) {
          const entry: ProbeCacheEntry = {
            checkedAt: Date.now(),
            ok: false,
            modelId: null,
            reason: `models probe HTTP ${resp.status}`,
          };
          this.probeCache = entry;
          return entry;
        }
        const data = (await resp.json().catch(() => null)) as {
          data?: Array<{ id?: string }>;
        } | null;
        const firstId =
          Array.isArray(data?.data) && typeof data.data[0]?.id === "string"
            ? data.data[0].id.trim()
            : null;
        const entry: ProbeCacheEntry = {
          checkedAt: Date.now(),
          ok: true,
          modelId: firstId || this.localLlmModel,
        };
        this.probeCache = entry;
        return entry;
      } catch (err) {
        const entry: ProbeCacheEntry = {
          checkedAt: now,
          ok: false,
          modelId: null,
          reason: stripEmDashes(err instanceof Error ? err.message : String(err)).slice(0, 140),
        };
        this.probeCache = entry;
        return entry;
      }
    })().finally(() => {
      if (this.probeInFlight === task) {
        this.probeInFlight = null;
      }
    });
    this.probeInFlight = task;
    return task;
  }

  async isLocalLlmReady(): Promise<boolean> {
    try {
      const probe = await this.probeLocalLlmModels(
        this.localLlmUrl,
        Math.min(this.probeTimeoutMs, 800),
      );
      return Boolean(probe.ok);
    } catch {
      return false;
    }
  }

  async synthesizeWithLocalLlm(
    req: SynthesizeBoardRequest,
  ): Promise<SynthesizeBoardResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("synthesizeWithLocalLlm requires threadId or channel");
    }
    const hasThread = typeof req.threadId === "string" && req.threadId.trim().length > 0;
    const hasChannel = typeof req.channel === "string" && req.channel.trim().length > 0;
    if (!hasThread && !hasChannel) {
      throw new BadRequestError("Either threadId or channel must be provided");
    }

    const endpointUrl = assertLoopbackUrl(this.localLlmUrl, "localLlmUrl");
    const db = this.requireBoardDb();
    const generatedAt = new Date().toISOString();

    let scope: "thread" | "channel";
    let target: string;
    let transcriptBlocks: string[] = [];
    let allMessages: BoardMessageItem[] = [];
    let threadCount = 0;
    let channelHint: string | undefined;

    if (hasThread) {
      scope = "thread";
      const { root, replies } = this.loadThreadFromSqlite(db, req.threadId!);
      target = root.id;
      channelHint = root.channel;
      threadCount = 1;
      allMessages = [root, ...replies];
      const rootSig = this.classifySignal(root);
      transcriptBlocks.push(
        `[ROOT #${root.numericId} | ${root.channel} | ${rootSig.signalKind} | by ${root.by} | ${root.createdAt}]\n${root.text}`,
      );
      for (const r of replies) {
        transcriptBlocks.push(`[REPLY #${r.numericId} | by ${r.by} | ${r.createdAt}]\n${r.text}`);
      }
    } else {
      scope = "channel";
      const cleanChannel = validateChannel(req.channel!);
      target = cleanChannel;
      channelHint = cleanChannel;

      const rootRows = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE deleted = 0 AND re IS NULL AND channel = ?
           ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
           LIMIT 120`,
        )
        .all(cleanChannel) as RawBoardRow[];

      const ranked = rootRows
        .map((row) => {
          const item = rowToBoardMessageItem(row);
          const signal = this.classifySignal(item);
          return { item, signal };
        })
        .filter((entry) => !entry.signal.isTelemetry)
        .sort((a, b) => {
          const sa =
            (a.item.isBlocked ? 500 : 0) +
            a.signal.weight * 3 +
            a.item.replies * 20;
          const sb =
            (b.item.isBlocked ? 500 : 0) +
            b.signal.weight * 3 +
            b.item.replies * 20;
          return sb - sa || b.item.lastAtMs - a.item.lastAtMs;
        })
        .slice(0, 12);

      const repliesByRoot = this.batchFetchReplies(
        db,
        ranked.map((r) => r.item.numericId),
      );
      threadCount = ranked.length;

      for (const { item, signal } of ranked) {
        allMessages.push(item);
        const reps = (repliesByRoot.get(item.numericId) || []).slice(0, 3);
        allMessages.push(...reps);
        const repLines = reps.map((r) => `  - ${r.by}: ${singleLineExcerpt(r.text, 180)}`);
        transcriptBlocks.push(
          `[THREAD #${item.numericId} | ${signal.signalKind}${item.isBlocked ? " | BLOCKED" : ""} | by ${item.by} | replies=${Math.max(item.replies, reps.length)}]\n${singleLineExcerpt(item.text, 360)}${repLines.length ? "\n" + repLines.join("\n") : ""}`,
        );
      }
    }

    const participantSet = new Set<string>();
    for (const msg of allMessages) {
      participantSet.add(msg.by);
    }
    const participants = Array.from(participantSet).slice(0, 12);
    const combinedText = allMessages.map((m) => m.text).join("\n");
    const mindLinks = await this.resolveMindLinks(combinedText, channelHint, 8);

    // Build deterministic fallback baseline
    const detDecisions: string[] = [];
    const detQuestions: string[] = [];
    const detActions: string[] = [];

    for (const msg of allMessages) {
      const sig = this.classifySignal(msg);
      if (sig.signalKind === "decision" || msg.isBlocked) {
        detDecisions.push(
          `#${msg.numericId} (${msg.by}): ${singleLineExcerpt(msg.task?.blocked?.reason || msg.title, 180)}`,
        );
      }
      if (msg.text.includes("?")) {
        const qLine = msg.text
          .split(/\r?\n/)
          .find((line) => line.includes("?"));
        if (qLine) {
          detQuestions.push(`${msg.by}: ${singleLineExcerpt(qLine, 180)}`);
        }
      }
      if (msg.isOpenTask || /\b(?:next|todo|ship|verify|fix|deploy)\b/i.test(msg.text)) {
        detActions.push(`#${msg.numericId} (${msg.by}): ${singleLineExcerpt(msg.title, 160)}`);
      }
    }

    const uniqueSlice = (arr: string[], max: number) =>
      Array.from(new Set(arr.map((s) => stripEmDashes(s)))).slice(0, max);

    const fallbackDecisions = uniqueSlice(detDecisions, 5);
    const fallbackQuestions = uniqueSlice(detQuestions, 5);
    const fallbackActions = uniqueSlice(detActions, 5);
    const fallbackSummary = stripEmDashes(
      allMessages.length === 0
        ? `No active signal threads found in ${target}.`
        : scope === "thread"
          ? `Thread #${target} in ${channelHint} involves ${participants.join(", ")} across ${allMessages.length} message(s). Root focus: ${singleLineExcerpt(allMessages[0].text, 240)}.${fallbackDecisions.length ? ` Active decision/blocker count: ${fallbackDecisions.length}.` : ""}`
          : `Channel ${target} has ${threadCount} high-signal thread(s) across ${participants.join(", ")}. Lead thread: ${singleLineExcerpt(allMessages[0].title, 160)}.${fallbackDecisions.length ? ` Decisions/blockers flagged: ${fallbackDecisions.length}.` : ""}`,
    );

    const buildDeterministic = (fallbackReason: string): SynthesizeBoardResponse => ({
      ok: true,
      scope,
      target,
      engine: "deterministic",
      model: "deterministic-board-synth",
      summary: fallbackSummary,
      decisions: fallbackDecisions,
      openQuestions: fallbackQuestions,
      nextActions: fallbackActions,
      participants,
      mindLinks,
      threadCount,
      messageCount: allMessages.length,
      fallbackReason: stripEmDashes(fallbackReason),
      generatedAt,
    });

    if (allMessages.length === 0) {
      return buildDeterministic("no signal messages to synthesize");
    }

    // Probe /v1/models first (cached 60s, 1200ms timeout)
    const probe = await this.probeLocalLlmModels(endpointUrl);
    if (!probe.ok) {
      return buildDeterministic(probe.reason || "Local LLM probe failed");
    }

    const systemPrompt = stripEmDashes(
      "You are the Kizuki Mind OS synthesis engine analyzing Agent Board discussions. " +
        "Respond in crisp plain markdown with zero em-dashes using these exact headings:\n" +
        "## Summary\n(2-3 concrete sentences)\n" +
        "## Decisions\n- bullet items\n" +
        "## Open Questions\n- bullet items\n" +
        "## Next Actions\n- bullet items",
    );
    const userPrompt = stripEmDashes(
      `Scope: ${scope} (${target})\nParticipants: ${participants.join(", ")}\n\nTranscript:\n${transcriptBlocks.join("\n\n").slice(0, 7000)}`,
    );
    const promptForCoherence = `${systemPrompt}\n\n${userPrompt}`;
    const targetModel = this.localLlmModel || probe.modelId || DEFAULT_LLM_MODEL;

    try {
      // CRITICAL: top_p: 0.95, temperature: 0.2, max_tokens: 900. NEVER pass enable_thinking: false.
      const payload = {
        model: targetModel,
        top_p: 0.95,
        temperature: 0.2,
        max_tokens: 900,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      };

      const resp = await this.fetchImpl(endpointUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(this.synthTimeoutMs),
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        return buildDeterministic(`Local LLM HTTP ${resp.status}`);
      }

      const json = (await resp.json().catch(() => null)) as {
        model?: string;
        choices?: Array<{ message?: { content?: string | null } }>;
      } | null;

      const rawContent =
        typeof json?.choices?.[0]?.message?.content === "string"
          ? json.choices[0].message.content
          : "";
      const cleaned = stripEmDashes(stripThinkBlocks(rawContent)).trim();

      const coherence = isCoherentLlmAnswer(cleaned, promptForCoherence);
      if (!coherence.ok) {
        return buildDeterministic(coherence.reason || "coherence check failed");
      }

      // Extract structured sections while falling back gracefully if model returned freeform prose
      const parsedDecisions = parseBulletSection(cleaned, /decisions/i);
      const parsedQuestions = parseBulletSection(cleaned, /open questions|questions/i);
      const parsedActions = parseBulletSection(cleaned, /next actions|actions/i);

      let summaryText = cleaned;
      const summaryMatch = cleaned.match(
        /##\s*Summary\s*\n+([\s\S]*?)(?=\n##\s+|$)/i,
      );
      if (summaryMatch && summaryMatch[1].trim()) {
        summaryText = cleanText(summaryMatch[1].trim(), 900);
      } else {
        summaryText = cleanText(cleaned, 900);
      }

      return {
        ok: true,
        scope,
        target,
        engine: "local-llm",
        model: stripEmDashes(json?.model || targetModel),
        summary: summaryText,
        decisions: parsedDecisions.length > 0 ? parsedDecisions : fallbackDecisions,
        openQuestions: parsedQuestions.length > 0 ? parsedQuestions : fallbackQuestions,
        nextActions: parsedActions.length > 0 ? parsedActions : fallbackActions,
        participants,
        mindLinks,
        threadCount,
        messageCount: allMessages.length,
        generatedAt,
      };
    } catch (err) {
      const msg = stripEmDashes(err instanceof Error ? err.message : String(err)).slice(0, 140);
      return buildDeterministic(msg || "Local LLM synthesis failed");
    }
  }

  // ============================================================================
  // 9. searchForOmni(q, limit = 8) and getAskContext(query)
  // ============================================================================

  searchForOmni(q: string, limit = 8): BoardOmniHit[] {
    const cleanQ = String(q ?? "").trim();
    if (cleanQ.length < 2) return [];
    const cap = clamp(Number(limit) || 8, 1, 40);

    const db = this.tryGetBoardDb();
    if (!db) return [];

    const qLower = cleanQ.toLowerCase();
    const rawTerms = tokenizeNormalized(cleanQ)
      .filter((t) => t.length >= 2)
      .slice(0, 5);
    const searchTerms = Array.from(new Set([qLower, ...rawTerms])).slice(0, 6);

    const likeClauses = searchTerms
      .map(() => "(text_lower LIKE ? ESCAPE '\\' OR channel LIKE ? ESCAPE '\\')")
      .join(" OR ");
    const params: string[] = [];
    for (const term of searchTerms) {
      const p = `%${escapeLikeParam(term)}%`;
      params.push(p, p);
    }

    let rows: RawBoardRow[];
    try {
      rows = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE deleted = 0 AND (${likeClauses})
           ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
           LIMIT 80`,
        )
        .all(...params) as RawBoardRow[];
    } catch {
      return [];
    }

    if (rows.length === 0) return [];

    const rootMap = new Map<number, BoardMessageItem>();
    const missingRootIds: number[] = [];

    for (const row of rows) {
      const item = rowToBoardMessageItem(row);
      if (row.re === null || row.re === undefined) {
        rootMap.set(row.id, item);
      } else if (!rootMap.has(row.re)) {
        missingRootIds.push(row.re);
      }
    }

    const uniqueMissing = Array.from(new Set(missingRootIds)).filter((id) => !rootMap.has(id));
    if (uniqueMissing.length > 0) {
      try {
        const ph = uniqueMissing.map(() => "?").join(", ");
        const parentRows = db
          .query(
            `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                    from_key, no_sync, text_lower, deleted, created_at, replies, at, data
             FROM board_messages
             WHERE deleted = 0 AND id IN (${ph})`,
          )
          .all(...uniqueMissing) as RawBoardRow[];
        for (const pRow of parentRows) {
          rootMap.set(pRow.id, rowToBoardMessageItem(pRow));
        }
      } catch {
        // fail-soft
      }
    }

    const scored: Array<{ hit: BoardOmniHit; score: number; lastAtMs: number }> = [];
    for (const root of rootMap.values()) {
      const signal = this.classifySignal(root);
      const hay = `${root.channel} ${root.title} ${root.text}`.toLowerCase();
      let matchScore = 0;
      if (hay.includes(qLower)) matchScore += 90;
      for (const t of rawTerms) {
        if (hay.includes(t)) matchScore += 22;
      }
      if (matchScore === 0) matchScore = 10; // matched in reply
      const totalScore =
        matchScore +
        signal.weight +
        (root.isBlocked ? 35 : 0) +
        Math.min(24, root.replies * 6);

      scored.push({
        score: totalScore,
        lastAtMs: root.lastAtMs,
        hit: {
          id: root.id,
          numericId: root.numericId,
          channel: root.channel,
          title: stripEmDashes(root.title),
          snippet: singleLineExcerpt(root.text, 160),
          by: root.by,
          brand: root.brand,
          signalKind: signal.signalKind,
          weight: signal.weight,
          replies: root.replies,
          isBlocked: root.isBlocked,
          lastAt: root.lastAt,
          view: "board",
          target: root.id,
        },
      });
    }

    return scored
      .sort((a, b) => b.score - a.score || b.lastAtMs - a.lastAtMs)
      .slice(0, cap)
      .map((s) => s.hit);
  }

  getAskContext(query: string, opts?: BoardAskContextOptions): BoardAskContext {
    const db = this.tryGetBoardDb();
    if (!db) {
      return { lines: [], citations: [], matchedThreads: 0, blockedCount: 0 };
    }

    // Count blocked roots via bounded SQLite scan
    let blockedCount = 0;
    const blockedHits: BoardOmniHit[] = [];
    try {
      const recentBlockedCandidates = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE deleted = 0 AND re IS NULL
             AND (data LIKE '%"blocked"%' OR data LIKE '%"pause"%' OR data LIKE '%"escalation"%')
           ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
           LIMIT 80`,
        )
        .all() as RawBoardRow[];

      for (const row of recentBlockedCandidates) {
        const item = rowToBoardMessageItem(row);
        if (!item.isBlocked) continue;
        blockedCount++;
        if (blockedHits.length < 4) {
          const sig = this.classifySignal(item);
          blockedHits.push({
            id: item.id,
            numericId: item.numericId,
            channel: item.channel,
            title: stripEmDashes(item.title),
            snippet: singleLineExcerpt(item.text, 160),
            by: item.by,
            brand: item.brand,
            signalKind: sig.signalKind,
            weight: sig.weight,
            replies: item.replies,
            isBlocked: true,
            lastAt: item.lastAt,
            view: "board",
            target: item.id,
          });
        }
      }
    } catch {
      return { lines: [], citations: [], matchedThreads: 0, blockedCount: 0 };
    }

    const cleanQuery = String(query ?? "").trim();
    const keywords = tokenizeNormalized(cleanQuery)
      .filter((t) => t.length >= 3 && !ENTITY_STOPWORDS.has(t))
      .slice(0, 6);

    const searchQ = keywords.length > 0 ? keywords.join(" ") : cleanQuery;
    const matched = searchQ.length >= 2 ? this.searchForOmni(searchQ, 8) : [];

    // Include blocked threads if query asks about blockers/decisions/board status
    const asksBlockers = /\b(?:block|blocked|blocker|decision|pause|paused|escalat|board|status|stuck)\b/i.test(
      cleanQuery,
    );
    const mergedMap = new Map<string, BoardOmniHit>();
    const focusedLineById = new Map<string, string>();

    // 1. Optional focused thread from board context (highest priority)
    const rawThreadId = typeof opts?.threadId === "string" ? opts.threadId.trim() : "";
    if (rawThreadId) {
      try {
        const focused = this.loadThreadFromSqlite(db, rawThreadId);
        const root = focused.root;
        const sig = this.classifySignal(root);
        const replySummary =
          focused.replies.length > 0
            ? ` | Recent replies: ${focused.replies
                .slice(-3)
                .map((r) => `${r.by}: ${singleLineExcerpt(r.text, 120)}`)
                .join("; ")}`
            : "";
        const hit: BoardOmniHit = {
          id: root.id,
          numericId: root.numericId,
          channel: root.channel,
          title: stripEmDashes(root.title),
          snippet: singleLineExcerpt(root.text, 240),
          by: root.by,
          brand: root.brand,
          signalKind: sig.signalKind,
          weight: sig.weight,
          replies: Math.max(root.replies, focused.replies.length),
          isBlocked: root.isBlocked,
          lastAt: root.lastAt,
          view: "board",
          target: root.id,
        };
        mergedMap.set(hit.id, hit);
        focusedLineById.set(
          hit.id,
          stripEmDashes(
            `[Board #${hit.numericId} | ${hit.channel} | FOCUSED THREAD | ${hit.signalKind}${hit.isBlocked ? " | BLOCKED" : ""} | by ${hit.by} | replies=${hit.replies}] ${hit.title}: ${hit.snippet}${replySummary}`,
          ),
        );
      } catch {
        // Fail-soft if focused threadId is invalid or missing
      }
    }

    // 2. Optional scoped channel from board context
    const rawChannel = typeof opts?.channel === "string" ? opts.channel.trim() : "";
    let scopedChannel: string | null = null;
    if (rawChannel) {
      try {
        scopedChannel = validateChannel(rawChannel);
      } catch {
        scopedChannel = null;
      }
    }

    if (scopedChannel) {
      // Prioritize query hits already in the scoped channel
      for (const hit of matched) {
        if (hit.channel !== scopedChannel) continue;
        if (!mergedMap.has(hit.id)) {
          mergedMap.set(hit.id, hit);
        }
      }
      // Pull top recent non-telemetry signal threads in the scoped channel
      try {
        const channelRows = db
          .query(
            `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                    from_key, no_sync, text_lower, deleted, created_at, replies, at, data
             FROM board_messages
             WHERE deleted = 0 AND re IS NULL AND channel = ?
             ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, COALESCE(at, id) DESC, id DESC
             LIMIT 20`,
          )
          .all(scopedChannel) as RawBoardRow[];

        let addedFromChannel = 0;
        for (const row of channelRows) {
          if (addedFromChannel >= 4) break;
          const item = rowToBoardMessageItem(row);
          if (mergedMap.has(item.id)) continue;
          const sig = this.classifySignal(item);
          if (sig.isTelemetry) continue;
          mergedMap.set(item.id, {
            id: item.id,
            numericId: item.numericId,
            channel: item.channel,
            title: stripEmDashes(item.title),
            snippet: singleLineExcerpt(item.text, 160),
            by: item.by,
            brand: item.brand,
            signalKind: sig.signalKind,
            weight: sig.weight,
            replies: item.replies,
            isBlocked: item.isBlocked,
            lastAt: item.lastAt,
            view: "board",
            target: item.id,
          });
          addedFromChannel++;
        }
      } catch {
        // Fail-soft on scoped channel query error
      }
    }

    for (const hit of matched) {
      if (hit.signalKind === "telemetry" && mergedMap.size >= 3) continue;
      if (!mergedMap.has(hit.id)) {
        mergedMap.set(hit.id, hit);
      }
    }
    if (asksBlockers) {
      for (const bHit of blockedHits) {
        if (!mergedMap.has(bHit.id)) {
          mergedMap.set(bHit.id, bHit);
        }
      }
    }

    const finalHits = Array.from(mergedMap.values()).slice(0, 8);
    const lines = finalHits.map(
      (h) =>
        focusedLineById.get(h.id) ??
        stripEmDashes(
          `[Board #${h.numericId} | ${h.channel} | ${h.signalKind}${h.isBlocked ? " | BLOCKED" : ""} | by ${h.by} | replies=${h.replies}] ${h.title}: ${h.snippet}`,
        ),
    );
    const citations: BoardAskCitation[] = finalHits.map((h) => ({
      id: h.id,
      channel: h.channel,
      title: h.title,
      by: h.by,
      signalKind: h.signalKind,
      lastAt: h.lastAt,
    }));

    return {
      lines,
      citations,
      matchedThreads: finalHits.length,
      blockedCount,
    };
  }
}
