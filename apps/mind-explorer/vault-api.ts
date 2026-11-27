import { Database } from "bun:sqlite";
import { appendFile, mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { HotSnapshot } from "./hot-snapshot.ts";
import {
  createPersonalIndexWorkerClient,
  type PersonalIndexWorkerClient,
} from "./personal-index.worker.ts";
import {
  appendOwnerObservation,
  batchCountSqliteClaimsForPeople,
  buildEmptySynthesizedWorldModel,
  buildWorldModelSynthesisPrompt,
  computePersonProfileVisuals,
  createCanonicalCardMatcher,
  DEFAULT_LIFEOS_PEOPLE_DIR,
  DEFAULT_LIFEOS_RELATIONSHIPS_DIR,
  fuseWorldModels,
  isValidPersonSlug,
  loadCanonicalPersonCards,
  normalizeSlug,
  parseFrontmatter,
  parsePersonCardMarkdown,
  querySqlitePersonIntelligence,
  VALID_OWNER_NOTE_KINDS,
  writeWorldModelPersonCard,
  type CanonicalPersonCard,
  type OwnerNoteKind,
  type PersonProfileVisuals,
  type PersonWorldModel,
  type ProfileTier,
  type RelationshipTier,
  type SqlitePersonClaim,
  type SqlitePersonIntel,
} from "./people-intel.ts";

export type {
  CanonicalPersonCard,
  OwnerNoteKind,
  PersonProfileVisuals,
  PersonWorldModel,
  ProfileTier,
  RelationshipTier,
  SqlitePersonClaim,
};

export const DEFAULT_VAULT_PATH =
  process.env.KIZUKI_VAULT || process.env.KIZUKI_VAULT_PATH || join(homedir(), "Kizuki");
export const DEFAULT_DB_PATH = process.env.KIZUKI_DB_PATH || join(DEFAULT_VAULT_PATH, ".kizuki", "kizuki.db");
export const DEFAULT_KIZUKI_BIN = process.env.KIZUKI_BIN || join(homedir(), ".local", "bin", "kizuki");
export const DEFAULT_BRIDGE_METER_PATH =
  process.env.KIZUKI_BRIDGE_METER_PATH ||
  join(DEFAULT_VAULT_PATH, ".kizuki", "bridge-meter.json");
export const DEFAULT_ANTIGRAVITY_JSONL_PATH =
  process.env.KIZUKI_ANTIGRAVITY_JSONL_PATH ||
  join(DEFAULT_VAULT_PATH, ".kizuki", "evidence.jsonl");
export const DEFAULT_BRIDGES_DIR =
  process.env.KIZUKI_BRIDGES_DIR || join(DEFAULT_VAULT_PATH, ".kizuki", "bridges");
export const DEFAULT_LLM_ENDPOINT =
  process.env.KIZUKI_LLM_ENDPOINT || "http://127.0.0.1:8003/v1/chat/completions";
export const DEFAULT_LLM_MODEL = process.env.KIZUKI_LLM_MODEL || "local-model";
export const DEFAULT_FALLBACK_LLM_ENDPOINT =
  process.env.KIZUKI_FALLBACK_LLM_ENDPOINT || "http://127.0.0.1:8788/v1/chat/completions";
export const DEFAULT_FALLBACK_LLM_MODEL =
  process.env.KIZUKI_FALLBACK_LLM_MODEL || "fallback-model";
export const DEFAULT_FALLBACK_LLM_TOKEN_PATH =
  process.env.KIZUKI_FALLBACK_LLM_TOKEN_PATH ||
  join(DEFAULT_VAULT_PATH, ".kizuki", "bridge.token");

export interface VaultApiConfig {
  vaultPath?: string;
  dbPath?: string;
  kizukiBin?: string;
  bridgeMeterPath?: string;
  antigravityJsonlPath?: string;
  bridgesDir?: string;
  llmEndpoint?: string;
  llmModel?: string;
  fallbackLlmEndpoint?: string | null;
  fallbackLlmModel?: string;
  fallbackLlmTokenPath?: string;
  actionsPath?: string;
  lifeosPeopleDir?: string | null;
  relationshipsDir?: string | null;
  snapshotCheckIntervalMs?: number;
  disablePersonalWorker?: boolean;
}

export interface ConnectorStat {
  id: string;
  count: number;
  latest: string | null;
}

export interface OverviewResponse {
  vault: {
    events_total: number;
    events_24h: number;
    claims_live: number;
    claims_24h: number;
    world_typed: number;
    consolidation_complete: number;
    consolidation_pending: number;
    identity_links: number;
    forecasts: number;
    docs_total: number;
    connectors: ConnectorStat[];
  };
  memt: {
    mode: string;
    verified: number;
    total: number;
  };
  bridge: {
    inkling_calls: number;
    inkling_tokens: number;
  };
  daemon: {
    version: string;
    active: boolean;
  };
  latest_brief: {
    name: string | null;
    bytes: number;
    sections: string[];
  };
}

export interface GraphNode {
  id: string;
  label: string;
  kind: string;
  group: string;
  degree: number;
  confidence: number;
  consolidated: boolean;
  summary: string;
  claim_count: number;
  updated_at: string | null;
  source_kind: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  predicate: string;
  weight: number;
}

export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    total_nodes: number;
    total_edges: number;
    consolidated_count: number;
    memt_count: number;
  };
}

export interface NodeClaimDetail {
  claim_id: string;
  predicate: string;
  text: string;
  confidence: number;
  created_at: string;
  authority: string;
}

export interface NodeNeighbor {
  id: string;
  label: string;
  kind: string;
  predicate: string;
}

export interface MemtExperience {
  id: string;
  domain: string;
  scope_key?: string;
  sensitivity?: string;
  condition: string;
  recommendation: string;
  verification?: string;
  outcome: string;
  citations?: string[];
  confidence: number;
  use_count?: number;
  internalized_in_snapshot?: string | null;
  has_embedding?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface RelatedDocRef {
  path: string;
  title: string;
  category: string;
}

export interface NodeDetailResponse {
  id: string;
  label: string;
  kind: string;
  consolidated: boolean;
  summary: string;
  confidence: number;
  updated_at: string | null;
  claims: NodeClaimDetail[];
  neighbors: NodeNeighbor[];
  related_docs: RelatedDocRef[];
  memt_experience?: MemtExperience;
}

export interface SearchResponse {
  query: string;
  ms: number;
  memt_hits: Array<{
    id: string;
    domain: string;
    condition: string;
    recommendation: string;
    verification?: string;
    outcome: string;
    confidence: number;
    score?: number;
  }>;
  world_hits: Array<{
    id: string;
    label: string;
    kind: string;
    status: string;
    summary: string;
    updated_at: string | null;
  }>;
  claim_hits: Array<{
    claim_id: string;
    kind: string;
    target: string | null;
    predicate: string | null;
    text: string;
    confidence: number;
    created_at: string;
  }>;
  event_hits: Array<{
    event_id: string;
    connector_id: string;
    kind: string;
    occurred_at: string;
    snippet: string;
  }>;
}

export interface AtlasResponse {
  status: string;
  panels: unknown[];
  consolidated_highlights: Array<{
    id: string;
    label: string;
    kind: string;
    summary: string;
    completed_at: string | null;
    claim_count: number;
  }>;
  error?: string;
}

export interface MemtResponse {
  status: Record<string, unknown>;
  experiences: MemtExperience[];
}

export interface BriefResponse {
  latest: {
    name: string | null;
    markdown: string;
    updated_at: string | null;
  };
  recent: Array<{
    name: string;
    bytes: number;
  }>;
}

export interface InteractHistoryTurn {
  role: "user" | "assistant";
  content: string;
}

export interface InteractRequest {
  mode: "ask" | "tell" | "memt" | "reflex";
  input: string;
  domain?: string;
  condition?: string;
  recommendation?: string;
  verification?: string;
  nodeId?: string;
  contextDocPath?: string;
  history?: InteractHistoryTurn[];
  dryRun?: boolean;
}

export interface DocCategorySummary {
  key: string;
  label: string;
  count: number;
  dir: string;
}

export interface DocListItem {
  path: string;
  title: string;
  category: string;
  updated_at: string;
  size_bytes: number;
  excerpt: string;
}

export interface DocsListResponse {
  total: number;
  categories: DocCategorySummary[];
  items: DocListItem[];
  offset: number;
  limit: number;
}

export interface DocReadResponse {
  ok: true;
  path: string;
  title: string;
  category: string;
  updated_at: string;
  size_bytes: number;
  editable: boolean;
  content: string;
  related_docs: RelatedDocRef[];
}

export interface DocSaveRequest {
  path: string;
  content: string;
  dryRun?: boolean;
}

export interface DocSaveResponse {
  ok: true;
  path: string;
  size_bytes: number;
  updated_at: string;
  dryRun?: boolean;
}

export interface StreamItem {
  id: string;
  connector: string;
  connector_label: string;
  kind: string;
  observed_at: string;
  title: string;
  preview: string;
  full_text: string;
  source_record_id: string | null;
  doc_path?: string | null;
}

export interface StreamResponse {
  total: number;
  connectors: Array<{ id: string; label: string; count: number }>;
  items: StreamItem[];
}

export interface PulseResponse {
  overview: OverviewResponse;
  docs_summary: {
    total: number;
    categories: DocCategorySummary[];
  };
  activity_14d: Array<{ day: string; events: number; claims: number }>;
  recent_events: Array<{
    id: string;
    connector: string;
    connector_label: string;
    kind: string;
    observed_at: string;
    title: string;
    preview: string;
  }>;
  recent_docs: Array<{
    path: string;
    title: string;
    category: string;
    updated_at: string;
    size_bytes: number;
    preview: string;
  }>;
  owner_anchors: {
    path: "owner-anchors.md";
    content: string;
    updated_at: string;
  };
  digest_highlight: {
    name: string;
    updated_at: string;
    content: string;
  };
  top_memt: MemtExperience[];
  connectors_status: Array<{
    id: string;
    label: string;
    status: "active" | "ready" | "needs_oauth";
    events: number;
    latest: string | null;
    command?: string;
    source_kind?: "native" | "bridge" | "hybrid";
  }>;
}

interface BridgeSourceSpec {
  id: string;
  label: string;
  mode: "jsonl" | "markdown_dir" | "sessions_dir";
  subDir?: string;
  defaultKind: string;
  sqlAliases: string[];
  suppressOptionalIds?: string[];
}

interface BridgeSourceSnapshot {
  spec: BridgeSourceSpec;
  count: number;
  latest: string | null;
  items: StreamItem[];
}

export type OwnerActionTag = "Family" | "Work" | "Reply" | "Personal";

export interface OwnerAction {
  id: string;
  title: string;
  detail: string;
  tag: OwnerActionTag;
  done: boolean;
  source: string;
  created_at: string;
}

export interface ActionMutationRequest {
  op: "add" | "toggle" | "delete";
  id?: string;
  title?: string;
  detail?: string;
  tag?: OwnerActionTag | string;
  source?: string;
}

export interface TodayScheduleItem {
  id: string;
  title: string;
  calendar: string;
  start: string;
  end: string | null;
  is_now: boolean;
  is_today: boolean;
  is_tomorrow: boolean;
  countdown: string;
  participants: string[];
  meet_url: string | null;
  dial_in: string | null;
  notes: string;
  body: string;
  raw_text: string;
}

export type InboxChannel = "whatsapp" | "imessage" | "gmail" | "telegram";

export interface TodayInboxItem {
  id: string;
  channel: InboxChannel;
  channel_label: string;
  thread_key: string;
  sender: string;
  thread_title: string;
  preview: string;
  full_text: string;
  occurred_at: string;
  is_noise: boolean;
  message_count: number;
}

export interface PersonNextMeeting {
  title: string;
  start_iso: string;
  countdown: string;
  meet_url: string | null;
}

export interface PeopleRadarItem {
  key: string;
  name: string;
  initials: string;
  channels: string[];
  last_seen: string | null;
  last_seen_iso: string | null;
  last_seen_label: string;
  last_snippet: string;
  preview: string;
  message_count: number;
  next_meeting: PersonNextMeeting | null;
}

export interface WhoopSummary {
  date: string | null;
  age_days: number | null;
  is_stale: boolean;
  recovery_pct: number | null;
  recovery_zone: string | null;
  hrv_ms: number | null;
  rhr_bpm: number | null;
  sleep_hours: number | null;
  summary: string;
}

export interface TodayWorkstream {
  name: string;
  domain: string;
  state: string;
  context: string;
  next_move: string;
}

export interface TodayResponse {
  generated_at: string;
  stale_ms?: number;
  summary: {
    events_total: number;
    docs_total: number;
    people_total: number;
    atlas_panels: number;
    active_pipelines: number;
    total_pipelines: number;
    claims_live: number;
    memt_verified: number;
    open_actions: number;
    priority_inbox_count: number;
  };
  schedule: TodayScheduleItem[];
  actions: OwnerAction[];
  inbox: TodayInboxItem[];
  inbox_counts: {
    priority: number;
    all: number;
    whatsapp: number;
    imessage: number;
    gmail: number;
    telegram: number;
  };
  people_radar: PeopleRadarItem[];
  whoop: WhoopSummary;
  workstreams: TodayWorkstream[];
  owner_anchors: {
    path: string;
    content: string;
    updated_at: string;
  };
}

export interface PersonDirectoryItem {
  key: string;
  name: string;
  initials: string;
  channels: string[];
  message_count: number;
  claim_count: number;
  meeting_count: number;
  last_seen: string | null;
  last_seen_iso: string | null;
  last_seen_label: string;
  first_seen: string | null;
  last_snippet: string;
  preview: string;
  next_meeting: PersonNextMeeting | null;
  profile_tier: ProfileTier;
  relationship_tier: RelationshipTier;
  relationship_state: string;
  trajectory: string;
  role: string;
  org: string;
  has_leverage_map: boolean;
}

export interface PeopleListResponse {
  total: number;
  profiled_count: number;
  core_count: number;
  channel: string;
  query: string;
  channels: Array<{ id: string; label: string; count: number }>;
  items: PersonDirectoryItem[];
}

export interface PersonDossierMeeting {
  id: string;
  title: string;
  calendar: string;
  start: string;
  end: string | null;
  countdown: string;
  is_upcoming: boolean;
  participants: string[];
  meet_url: string | null;
  dial_in: string | null;
  notes: string;
  body: string;
  raw_text: string;
}

export interface PersonDossierCollaborator {
  name: string;
  slug: string;
  key: string | null;
  shared_events: number;
  note?: string;
}

export interface PersonDossierQueryOptions {
  key: string;
  limit?: number;
  offset?: number;
  channel?: string;
  q?: string;
}

export interface PersonMessageRecord {
  id: string;
  channel: string;
  sender: string;
  direction: string;
  is_outbound: boolean;
  occurred_at: string;
  text: string;
}

export interface PersonDossierResponse {
  ok: true;
  person: {
    key: string;
    name: string;
    initials: string;
    channels: string[];
    message_count: number;
    claim_count: number;
    meeting_count: number;
    last_seen: string | null;
    last_seen_iso: string | null;
    last_seen_label: string;
    first_seen: string | null;
    history_span_label: string;
    preview: string;
    next_meeting: PersonNextMeeting | null;
    profile_tier: ProfileTier;
    relationship_tier: RelationshipTier;
    relationship_state: string;
    role: string;
    org: string;
    handles: PersonWorldModel["handles"];
    aliases: string[];
  };
  world_model: PersonWorldModel;
  profile_visuals: PersonProfileVisuals;
  timeline_total: number;
  timeline_offset: number;
  timeline_has_more: boolean;
  timeline: Array<{
    id: string;
    channel: string;
    sender: string;
    direction: string;
    occurred_at: string;
    text: string;
  }>;
  sqlite_claims_total: number;
  sqlite_claims: SqlitePersonClaim[];
  meetings: PersonDossierMeeting[];
  past_meetings: PersonDossierMeeting[];
  collaborators: PersonDossierCollaborator[];
  related_docs: RelatedDocRef[];
}

export interface PersonSynthesizeRequest {
  key: string;
  focus?: string;
}

export interface PersonSynthesizeResponse {
  ok: true;
  engine: "Local LLM" | "Fallback LLM";
  model: string;
  latency_ms: number;
  card_path: string;
  dossier: PersonDossierResponse;
}

export interface PersonNoteRequest {
  key: string;
  kind: OwnerNoteKind | string;
  text: string;
}

export interface PersonNoteResponse {
  ok: true;
  card_path: string;
  note_line: string;
  dossier: PersonDossierResponse;
}

export interface OmniSearchResponse {
  query: string;
  ms: number;
  total: number;
  groups: {
    calendar: Array<{
      id: string;
      title: string;
      calendar: string;
      start: string;
      end: string | null;
      participants: string[];
      preview: string;
    }>;
    inbox: Array<{
      id: string;
      channel: InboxChannel;
      channel_label: string;
      thread_key: string;
      sender: string;
      thread_title: string;
      preview: string;
      occurred_at: string;
      is_noise: boolean;
    }>;
    docs: Array<{
      path: string;
      title: string;
      category: string;
      updated_at: string;
      excerpt: string;
    }>;
    people: PersonDirectoryItem[];
    memt: Array<{
      id: string;
      domain: string;
      condition: string;
      recommendation: string;
      outcome: string;
      confidence: number;
    }>;
    nodes: Array<{
      id: string;
      label: string;
      kind: string;
      summary: string;
      updated_at: string | null;
    }>;
  };
}

export interface DraftRequest {
  kind: "reply" | "meeting_prep" | "context_brief";
  title: string;
  context_text: string;
  thread_key?: string;
  instructions?: string;
}

export interface DraftResponse {
  ok: true;
  local_only: true;
  kind: "reply" | "meeting_prep" | "context_brief";
  title: string;
  synthesized: boolean;
  engine: "Local LLM" | "Fallback LLM" | "Local Template Fallback";
  model?: string;
  draft: string;
  fallback_reason?: string;
  usage?: Record<string, unknown> | null;
}

interface ParsedPersonalMessage {
  id: string;
  channel: InboxChannel;
  channel_label: string;
  thread_key: string;
  sender: string;
  thread_title: string;
  preview: string;
  full_text: string;
  occurred_at: string;
  is_noise: boolean;
}

interface ParsedCalendarEvent {
  id: string;
  title: string;
  calendar: string;
  start: string;
  startMs: number;
  end: string | null;
  endMs: number | null;
  participants: string[];
  meet_url: string | null;
  dial_in: string | null;
  notes: string;
  raw_text: string;
}

interface PersonIndexRecord {
  key: string;
  name: string;
  initials: string;
  channels: Set<string>;
  message_count: number;
  past_message_count: number;
  claim_count: number;
  last_seen: string | null;
  last_seen_iso: string | null;
  last_seen_label: string;
  first_seen: string | null;
  last_snippet: string;
  preview: string;
  last_message_iso: string | null;
  last_message_snippet: string;
  last_past_meeting_iso: string | null;
  last_past_meeting_snippet: string;
  next_meeting: PersonNextMeeting | null;
  is_group: boolean;
  timeline: Array<{
    id: string;
    channel: string;
    sender: string;
    occurred_at: string;
    text: string;
  }>;
  meetings: ParsedCalendarEvent[];
  aliases: Set<string>;
  raw_aliases: Set<string>;
  canonical_card: CanonicalPersonCard | null;
  profile_tier: ProfileTier;
  relationship_tier: RelationshipTier;
  relationship_state: string;
  trajectory: string;
  role: string;
  org: string;
  has_leverage_map: boolean;
}

interface PersonalIndexSnapshot {
  builtAt: number;
  messages: ParsedPersonalMessage[];
  inboxThreads: TodayInboxItem[];
  calendar: ParsedCalendarEvent[];
  whoop: WhoopSummary;
  peopleList: PersonIndexRecord[];
  peopleByKey: Map<string, PersonIndexRecord>;
  cardMergeMap: Map<string, string>;
}

interface IndexedDoc {
  path: string;
  fullPath: string;
  name: string;
  title: string;
  category: string;
  mtimeMs: number;
  size: number;
  excerpt?: string;
  headLoaded?: boolean;
}

interface DocIndexSnapshot {
  entries: IndexedDoc[];
  byPath: Map<string, IndexedDoc>;
  categories: DocCategorySummary[];
  builtAt: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const CONNECTOR_LABELS: Record<string, string> = {
  "kizuki.claude-code-sessions": "Claude Code Sessions",
  "kizuki.codex-sessions": "Codex Sessions",
  "kizuki.import-legacy-wiki": "Legacy Wiki Import",
  "kizuki.markdown-folder": "Markdown Vault Notes",
  "kizuki.import-legacy-events": "Legacy Event Stream",
  "antigravity-neon": "Antigravity Neon",
  telegram: "Telegram",
  "kizuki.telegram": "Telegram",
  whatsapp: "WhatsApp",
  "kizuki.whatsapp": "WhatsApp",
  gmail: "Gmail",
  "kizuki.gmail": "Gmail",
  "kizuki.imap": "Gmail / IMAP",
  "kizuki.google-calendar": "Google Calendar",
  "x-bookmarks": "X Bookmarks",
  "kizuki.x-api": "X (Twitter)",
  "kizuki.x": "X (Twitter)",
  whoop: "Whoop",
  "kizuki.whoop": "Whoop",
  "mac-imessage": "iMessage (Mac)",
  "kizuki.imessage": "iMessage (Mac)",
  "mac-calendar": "Calendar (Mac)",
  "mac-notes": "Apple Notes (Mac)",
  "kizuki.apple-notes": "Apple Notes (Mac)",
  "mac-obsidian": "Obsidian (Mac)",
  "kizuki.obsidian": "Obsidian (Mac)",
  "mac-claude-sessions": "Claude Sessions (Mac)",
  "mac-codex-sessions": "Codex Sessions (Mac)",
  "wispr-flow": "Wispr Flow",
  "kizuki.wispr-flow": "Wispr Flow",
  "kizuki.beeper": "Beeper",
  "kizuki.ics": "ICS Calendar Feed",
};

const PERSONAL_BRIDGE_SPECS: BridgeSourceSpec[] = [
  {
    id: "telegram",
    label: "Telegram",
    mode: "jsonl",
    subDir: "telegram",
    defaultKind: "message",
    sqlAliases: ["telegram", "kizuki.telegram"],
    suppressOptionalIds: ["kizuki.telegram"],
  },
  {
    id: "whatsapp",
    label: "WhatsApp",
    mode: "jsonl",
    subDir: "whatsapp",
    defaultKind: "message",
    sqlAliases: ["whatsapp", "kizuki.whatsapp"],
  },
  {
    id: "gmail",
    label: "Gmail",
    mode: "jsonl",
    subDir: "gmail",
    defaultKind: "email",
    sqlAliases: ["gmail", "kizuki.gmail", "kizuki.imap"],
    suppressOptionalIds: ["kizuki.gmail"],
  },
  {
    id: "x-bookmarks",
    label: "X Bookmarks",
    mode: "jsonl",
    subDir: "x-bookmarks",
    defaultKind: "bookmark",
    sqlAliases: ["x-bookmarks", "kizuki.x-api", "kizuki.x"],
    suppressOptionalIds: ["kizuki.x-api"],
  },
  {
    id: "whoop",
    label: "Whoop",
    mode: "jsonl",
    subDir: "whoop",
    defaultKind: "health_metric",
    sqlAliases: ["whoop", "kizuki.whoop"],
  },
  {
    id: "mac-imessage",
    label: "iMessage (Mac)",
    mode: "jsonl",
    subDir: "mac-imessage",
    defaultKind: "message",
    sqlAliases: ["mac-imessage", "kizuki.imessage"],
  },
  {
    id: "mac-calendar",
    label: "Calendar (Mac)",
    mode: "jsonl",
    subDir: "mac-calendar",
    defaultKind: "calendar_event",
    sqlAliases: ["mac-calendar", "kizuki.ics"],
    suppressOptionalIds: ["kizuki.ics"],
  },
  {
    id: "mac-notes",
    label: "Apple Notes (Mac)",
    mode: "markdown_dir",
    subDir: "mac-notes",
    defaultKind: "note",
    sqlAliases: ["mac-notes", "kizuki.apple-notes"],
  },
  {
    id: "mac-obsidian",
    label: "Obsidian (Mac)",
    mode: "markdown_dir",
    subDir: "mac-obsidian",
    defaultKind: "note",
    sqlAliases: ["mac-obsidian", "kizuki.obsidian"],
  },
  {
    id: "mac-claude-sessions",
    label: "Claude Sessions (Mac)",
    mode: "sessions_dir",
    subDir: "mac-claude-sessions",
    defaultKind: "session_summary",
    sqlAliases: ["mac-claude-sessions"],
  },
  {
    id: "mac-codex-sessions",
    label: "Codex Sessions (Mac)",
    mode: "sessions_dir",
    subDir: "mac-codex-sessions",
    defaultKind: "session_summary",
    sqlAliases: ["mac-codex-sessions"],
  },
  {
    id: "antigravity-neon",
    label: "Antigravity Neon",
    mode: "jsonl",
    defaultKind: "session_summary",
    sqlAliases: ["antigravity-neon"],
  },
  {
    id: "wispr-flow",
    label: "Wispr Flow",
    mode: "jsonl",
    subDir: "wispr-flow",
    defaultKind: "voice_dictation",
    sqlAliases: ["wispr-flow", "kizuki.wispr-flow"],
  },
];

const DOC_CATEGORY_DEFS: Array<{ key: string; label: string; dir: string }> = [
  { key: "owner", label: "Owner & Canon", dir: "." },
  { key: "dashboards", label: "Dashboards", dir: "dashboards" },
  { key: "world", label: "World Model", dir: "auto/world" },
  { key: "entities", label: "Entities", dir: "auto/entities" },
  { key: "facts", label: "Facts", dir: "auto/facts" },
  { key: "notes", label: "Vault Notes", dir: "auto/kizuki.markdown-folder" },
  { key: "obsidian", label: "Obsidian (Mac)", dir: "obsidian" },
  { key: "apple-notes", label: "Apple Notes (Mac)", dir: "apple-notes" },
  { key: "wispr-flow", label: "Wispr Meetings", dir: "wispr-flow" },
  { key: "claude", label: "Claude Sessions", dir: "auto/kizuki.claude-code-sessions" },
  { key: "codex", label: "Codex Sessions", dir: "auto/kizuki.codex-sessions" },
  { key: "sources", label: "Sources & Captures", dir: "auto/sources" },
  { key: "archive", label: "Archive", dir: "archive" },
];

const OPTIONAL_CONNECTOR_CATALOG: Array<{
  id: string;
  label: string;
  status: "ready" | "needs_oauth";
  command: string;
}> = [
  {
    id: "kizuki.telegram",
    label: "Telegram",
    status: "needs_oauth",
    command: "kizuki connect telegram --vault <vault> --sensitivity private",
  },
  {
    id: "kizuki.gmail",
    label: "Gmail",
    status: "needs_oauth",
    command: "kizuki connect gmail --fields text,subjects,headers,labels,attachments --new-source --no-browser",
  },
  {
    id: "kizuki.google-calendar",
    label: "Google Calendar",
    status: "needs_oauth",
    command: "kizuki connect google-calendar --calendar primary --fields summary,description,location,attendees --new-source --no-browser",
  },
  {
    id: "kizuki.x-api",
    label: "X (Twitter)",
    status: "needs_oauth",
    command: "kizuki connect x-api --fields relationships,links,media --history-start 2026-01-01T00:00:00Z --new-source --no-browser",
  },
  {
    id: "kizuki.beeper",
    label: "Beeper",
    status: "ready",
    command: "kizuki connect beeper --token-ref env:BEEPER_TOKEN --endpoint http://127.0.0.1:23373 --sensitivity private",
  },
  {
    id: "kizuki.ics",
    label: "ICS Calendar Feed",
    status: "ready",
    command: "kizuki connect ics --url https://HOST/PATH.ics --sensitivity personal",
  },
];

const SECRET_PATH_RE =
  /(^|\/)(\.env(\.|$)|\.kizuki(\/|$)|\.git(\/|$)|\.ssh(\/|$)|\.gnupg(\/|$)|credentials?(\.|\/|$)|secrets?(\.|\/|$)|id_rsa|id_ed25519|.*\.pem$|.*\.key$|.*\.p12$|.*\.pfx$|.*token.*\.json$)/i;

function classifyDocCategory(relPath: string): string {
  const p = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (p.startsWith("obsidian/")) return "obsidian";
  if (p.startsWith("apple-notes/")) return "apple-notes";
  if (p.startsWith("wispr-flow/")) return "wispr-flow";
  if (
    p === "owner-anchors.md" ||
    p === "owner-notes.md" ||
    p === "CANON.md" ||
    p === "SCHEMA.md" ||
    p.startsWith("owner-notes/")
  ) {
    return "owner";
  }
  if (p.startsWith("dashboards/")) return "dashboards";
  if (p.startsWith("auto/world/") || p.startsWith("world/")) return "world";
  if (p.startsWith("auto/entities/") || p.startsWith("entities/")) return "entities";
  if (p.startsWith("auto/facts/") || p.startsWith("facts/")) return "facts";
  if (p.startsWith("auto/kizuki.markdown-folder/")) return "notes";
  if (p.startsWith("auto/kizuki.claude-code-sessions/")) return "claude";
  if (p.startsWith("auto/kizuki.codex-sessions/")) return "codex";
  if (
    p.startsWith("auto/sources/") ||
    p.startsWith("sources/") ||
    p.startsWith("auto/captures/") ||
    p.startsWith("auto/kizuki.import-legacy-events/") ||
    p.startsWith("events/")
  ) {
    return "sources";
  }
  if (p.startsWith("archive/")) return "archive";
  return "notes";
}

const OAUTH_SENSITIVE_QUERY_RE =
  /(?:oauth2?\/authorize|[?&](?:code|client_id|state|access_token|refresh_token|id_token|code_challenge)=)/i;

export function scrubOAuthUrls(text: string): string {
  if (!text) return "";
  let out = String(text);
  // Scrub full http(s) URLs that contain oauth/authorize or sensitive OAuth query parameters
  out = out.replace(/https?:\/\/[^\s<>"'`)\]]+/gi, (url) => {
    if (!OAUTH_SENSITIVE_QUERY_RE.test(url)) return url;
    const qIdx = url.indexOf("?");
    const hashIdx = url.indexOf("#");
    const cutIdx =
      qIdx !== -1 && hashIdx !== -1
        ? Math.min(qIdx, hashIdx)
        : qIdx !== -1
          ? qIdx
          : hashIdx;
    if (cutIdx !== -1) {
      return `${url.slice(0, cutIdx)}?[redacted-oauth-query]`;
    }
    return url;
  });
  // Scrub bare oauth/authorize?query or standalone query params in titles/snippets
  out = out.replace(/(oauth2?\/authorize)\?[^\s<>"'`)\]]+/gi, "$1?[redacted-oauth-query]");
  out = out.replace(
    /([?&])(?:code|client_id|state|access_token|refresh_token|id_token|code_challenge)=[^\s&<>"'`)\]]+/gi,
    "$1[redacted-oauth-query]"
  );
  // Collapse duplicate redaction markers
  out = out.replace(/(?:\?\[redacted-oauth-query\](?:&\[redacted-oauth-query\])*)/g, "?[redacted-oauth-query]");
  return out;
}

const LOW_SIGNAL_DOC_PATH_RE =
  /(?:oauth[-_]authorize|last[-_]login[-_]|auto__kizuki\.markdown-folder__|capture[-_]from[-_]kizuki\.markdown-folder)/i;

const LOW_SIGNAL_DOC_TITLE_RE =
  /(?:oauth2?\/authorize|oauth[-_\s]+authorize|^last\s+login\s*:|^capture\s+from\s+kizuki\.markdown-folder\s+at\s+)/i;

function isLowSignalDocPath(relPath: string, name: string): boolean {
  return LOW_SIGNAL_DOC_PATH_RE.test(`${relPath} ${name}`);
}

function isLowSignalDoc(doc: { path: string; name: string; title?: string; excerpt?: string }): boolean {
  if (isLowSignalDocPath(doc.path, doc.name)) return true;
  if (doc.title && LOW_SIGNAL_DOC_TITLE_RE.test(doc.title.trim())) return true;
  if (doc.excerpt && /^(?:last\s+login\s*:|https?:\/\/\S*oauth\/authorize)/i.test(doc.excerpt.trim())) return true;
  return false;
}

function slugToTitle(fileName: string): string {
  const stem = fileName.replace(/\.md$/i, "");
  if (/oauth[-_]authorize/i.test(stem)) {
    const base = stem
      .replace(/^\d+[-_]+/, "")
      .replace(/oauth[-_]authorize[\s\S]*$/i, "oauth/authorize?[redacted-oauth-query]")
      .replace(/^https[-_]+/i, "https://")
      .replace(/[-_]+/g, " ")
      .trim();
    return scrubOAuthUrls(base || "OAuth Authorize Link [redacted-oauth-query]");
  }
  const cleaned = stem
    .replace(/^[0-9a-f]{12,64}[-_]?/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  if (!cleaned) return stem;
  return scrubOAuthUrls(cleaned.replace(/\b\w/g, (c) => c.toUpperCase()));
}

const GENERIC_DOC_TITLES = new Set([
  "",
  "knowledge record",
  "untitled",
  "note",
  "notes",
  "document",
  "record",
  "unnamed",
]);

const WORLD_METADATA_LINE_RE = /^\((?:positive|negative|neutral|unknown)\s*;/i;
const WORLD_KIND_LINE_RE = /^world\.kind\s*:/i;
const WORLD_RECORD_REF_RE = /^record\s+[0-9a-f]{16,64}$/i;

const PRIORITY_TITLE_PREDICATE_RE =
  /^(?:situation\.label|concept\.label|situation\.objective|decision\.[a-z_]+|skill\.has|person\.name|identity\.display_name|project\.name|event\.summary|fact\.statement)\s*:\s*(.+)$/i;

const SECONDARY_TITLE_PREDICATE_RE =
  /^(?:concept\.definition|situation\.commitment|situation\.change|situation\.blocker|project\.status|outcome\.[a-z_]+|preference\.[a-z_]+|tool\.[a-z_]+|employment\.[a-z_]+|[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\s*:\s*(.+)$/i;

function isGenericDocTitle(raw: string | null | undefined): boolean {
  if (!raw) return true;
  const cleaned = raw
    .trim()
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .trim();
  if (!cleaned) return true;
  if (GENERIC_DOC_TITLES.has(cleaned.toLowerCase())) return true;
  if (isLikelyHexHash(cleaned)) return true;
  if (/^[0-9a-f]{12,64}$/i.test(cleaned)) return true;
  return false;
}

function cleanDerivedTitle(raw: string, maxLen = 68): string {
  let s = stripEmDashes(raw)
    .replace(/\s*\((?:positive|negative|neutral|unknown)\s*;[^)]*\)?\s*$/i, "")
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/^["'`\u201c\u201d\u2018\u2019]+|["'`\u201c\u201d\u2018\u2019]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[:;,.]+$/, "")
    .trim();

  if (!s) return "";
  if (/^[a-z]/.test(s) && !/^[a-z0-9_-]+\.[a-z0-9_-]+/i.test(s) && !s.startsWith("http")) {
    s = s.charAt(0).toUpperCase() + s.slice(1);
  }
  if (s.length <= maxLen) return s;
  const sliced = s.slice(0, maxLen - 3);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(maxLen * 0.55) ? sliced.slice(0, lastSpace) : sliced;
  return cut.replace(/[,;:\-]+$/, "").trimEnd() + "...";
}

function isUsableDerivedTitleValue(val: string): boolean {
  const cleaned = cleanDerivedTitle(val, 68);
  if (cleaned.length < 3) return false;
  if (isGenericDocTitle(cleaned)) return false;
  if (WORLD_RECORD_REF_RE.test(cleaned)) return false;
  if (/^world\/[a-z_]+$/i.test(cleaned)) return false;
  return true;
}

export function parseDocHead(rawHead: string, fallbackName: string): { title: string; excerpt: string } {
  const normalized = scrubOAuthUrls(stripEmDashes(rawHead));
  let title = "";
  let bodyStart = 0;

  if (normalized.startsWith("---\n") || normalized.startsWith("---\r\n")) {
    const endIdx = normalized.indexOf("\n---", 3);
    const fm = endIdx !== -1 ? normalized.slice(4, endIdx) : normalized.slice(4);
    const titleMatch = fm.match(/^title:\s*(.+?)\s*$/m);
    if (titleMatch && titleMatch[1]) {
      const candidate = scrubOAuthUrls(
        titleMatch[1]
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim()
      );
      if (!isGenericDocTitle(candidate)) {
        title = cleanDerivedTitle(candidate, 68);
      }
    }
    // If closing --- is beyond the head slice, do not parse raw YAML frontmatter lines as body text
    bodyStart = endIdx !== -1 ? endIdx + 4 : normalized.length;
  }

  const body = normalized.slice(bodyStart);
  const lines = body.split(/\r?\n/);
  const previewParts: string[] = [];

  let headingTitle = "";
  let priorityPredTitle = "";
  let secondaryPredTitle = "";
  let fallbackBodyTitle = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "---") continue;
    if (WORLD_METADATA_LINE_RE.test(line)) continue;
    if (WORLD_KIND_LINE_RE.test(line)) continue;

    if (line.startsWith("#")) {
      const h = line.replace(/^#+\s*/, "").trim();
      if (!headingTitle && isUsableDerivedTitleValue(h)) {
        headingTitle = cleanDerivedTitle(h, 68);
      }
      continue;
    }

    const prioMatch = line.match(PRIORITY_TITLE_PREDICATE_RE);
    if (prioMatch && prioMatch[1]) {
      const val = prioMatch[1].trim();
      if (!priorityPredTitle && isUsableDerivedTitleValue(val)) {
        priorityPredTitle = cleanDerivedTitle(val, 68);
      }
      if (previewParts.join(" ").length < 220 && !WORLD_RECORD_REF_RE.test(val)) {
        previewParts.push(cleanDerivedTitle(val, 160));
      }
      continue;
    }

    const secMatch = line.match(SECONDARY_TITLE_PREDICATE_RE);
    if (secMatch && secMatch[1]) {
      const val = secMatch[1].trim();
      if (!secondaryPredTitle && isUsableDerivedTitleValue(val)) {
        secondaryPredTitle = cleanDerivedTitle(val, 68);
      }
      if (previewParts.join(" ").length < 220 && !WORLD_RECORD_REF_RE.test(val)) {
        previewParts.push(cleanDerivedTitle(val, 160));
      }
      continue;
    }

    const cleanedLine = line.replace(/^>+\s*/, "").replace(/^[-*]\s+/, "").trim();
    if (!fallbackBodyTitle && isUsableDerivedTitleValue(cleanedLine)) {
      fallbackBodyTitle = cleanDerivedTitle(cleanedLine, 68);
    }

    if (previewParts.join(" ").length < 220 && cleanedLine) {
      previewParts.push(cleanedLine);
    }
  }

  const derivedTitle =
    title ||
    priorityPredTitle ||
    headingTitle ||
    secondaryPredTitle ||
    fallbackBodyTitle ||
    cleanDerivedTitle(slugToTitle(fallbackName), 68);

  const safeTitle = scrubOAuthUrls(
    cleanDerivedTitle(derivedTitle || slugToTitle(fallbackName), 68) || slugToTitle(fallbackName).slice(0, 68)
  );
  return {
    title: safeTitle,
    excerpt: scrubOAuthUrls(cleanText(previewParts.join(" "), 220)),
  };
}

function isEditableVaultDocPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  if (p === "owner-anchors.md" || p === "owner-notes.md") return true;
  if (/^owner-notes\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,120}\.md$/.test(p)) return true;
  return /^world\/people\/[a-z0-9][a-z0-9_-]{0,96}\.md$/.test(p);
}

function deriveEventTitle(text: string | null | undefined, kind: string, connectorId: string): string {
  if (text) {
    const lines = stripEmDashes(text).split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line === "```" || line.startsWith("```") || line === "{" || line === "[" || line === "---") continue;
      const cleaned = line.replace(/^#+\s*/, "").replace(/^[-*]\s+/, "").trim();
      if (cleaned.length >= 4) {
        return cleanText(cleaned, 96);
      }
    }
  }
  return `${connectorLabel(connectorId)} (${kind})`;
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under",
  "when", "where", "what", "which", "while", "only", "must", "should", "never",
  "always", "after", "before", "about", "using", "used", "uses", "have", "been",
  "were", "will", "your", "their", "them", "than", "then", "also", "more", "some",
  "such", "each", "both", "single", "concept", "world", "evidence", "labeled",
  "occurrence", "reported", "explicit", "inferred", "asserted", "defined", "support",
]);

function stripEmDashes(text: string): string {
  return text.replace(/\u2014/g, " - ").replace(/\u2013/g, "-");
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/\u00a0/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;|&#x27;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code >= 32 && code <= 126 ? String.fromCharCode(code) : " ";
    });
}

export function cleanDisplayText(raw: string): string {
  if (!raw) return "";
  let s = stripEmDashes(String(raw)).replace(/\r\n?/g, "\n");

  // Strip MIME part/multipart markers (<#part ...>, <#/part>, <#multipart ...>, <#/multipart>) and raw MIME header lines
  s = s.replace(/<(?:#\/?|\/#)(?:part|multipart)[^>]*>/gi, "");
  s = s.replace(
    /^(?:Content-Type|Content-Transfer-Encoding|Content-Disposition|MIME-Version|Message-ID|X-[A-Za-z0-9-]+):\s*.*$/gim,
    ""
  );

  // Strip style/script blocks and inline HTML tags while preserving line breaks
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, "\n");
  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^>]*)?\s*\/?>/g, "");

  // Decode HTML entities and scrub sensitive OAuth query params
  s = decodeHtmlEntities(s);
  s = scrubOAuthUrls(s);

  // Strip [REDACTED_LONG_TOKEN] URLs/lines and collapse tracking URL walls
  s = s.replace(/<?https?:\/\/[^\s<>]*\[REDACTED_LONG_TOKEN\][^\s<>]*>?/gi, "");
  s = s.replace(/\[REDACTED_LONG_TOKEN\]/gi, "");
  s = s.replace(
    /<?https?:\/\/(?:www\.google\.com\/url\?|click\.|links\.|track\.|email\.|mandrillapp\.com|sendgrid\.net|list-manage\.com|substack\.com\/redirect|t\.co\/)[^\s<>]{40,}>?/gi,
    ""
  );
  // Collapse remaining massive tracking URLs with utm/tracking params
  s = s.replace(/<?https?:\/\/[^\s<>]{120,}>?/gi, (m) =>
    /(?:utm_|mc_eid|mkt_tok|trk|redirect|token|sig=|click)/i.test(m) ? "" : m
  );

  const lines = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .filter((line) => {
      const t = line.trim();
      if (!t) return true;
      if (/^<?\s*>$/.test(t)) return false;
      return true;
    });

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanEmailDisplayBody(raw: string): string {
  if (!raw) return "";
  let s = stripEmDashes(String(raw)).replace(/\r\n?/g, "\n");
  // Strip leading Email (INBOX/Sent) and From/To/Cc/Date/Subject header block lines
  const lines = s.split("\n");
  let startIdx = 0;
  while (startIdx < lines.length && startIdx < 16) {
    const trimmed = lines[startIdx].trim();
    if (
      !trimmed ||
      /^#?\s*Email\s*\([^)]+\)\s*:/i.test(trimmed) ||
      /^(?:From|To|Cc|Bcc|Date|Subject|Reply-To|Message-ID|Folder):\s*/i.test(trimmed)
    ) {
      startIdx++;
      continue;
    }
    break;
  }
  const stripped = lines.slice(startIdx).join("\n");
  return cleanDisplayText(stripped);
}

export function parseCalendarBody(
  raw: string,
  eventTitle?: string
): { meet_url: string | null; dial_in: string | null; notes: string; location: string | null } {
  const src = stripEmDashes(String(raw || "")).replace(/\r\n?/g, "\n");

  // 1. Extract structured meet_url (Google Meet, Zoom, Teams, Calendly Meet, Webex, Whereby)
  const meetPatterns = [
    /https?:\/\/meet\.google\.com\/[a-z0-9-]+(?:\?[^\s<>"')]+)?/i,
    /https?:\/\/[a-z0-9.-]*zoom\.us\/(?:j|my|wc)\/[^\s<>"')]+/i,
    /https?:\/\/teams\.(?:microsoft|live)\.com\/l\/meetup-join\/[^\s<>"')]+/i,
    /https?:\/\/calendly\.com\/events\/[^\s<>"')]+\/google_meet/i,
    /https?:\/\/(?:[a-z0-9-]+\.)?(?:webex\.com|whereby\.com)\/[^\s<>"')]+/i,
  ];
  let meet_url: string | null = null;
  for (const re of meetPatterns) {
    const m = src.match(re);
    if (m && m[0]) {
      meet_url = scrubOAuthUrls(m[0].replace(/[.,;)>]+$/, ""));
      break;
    }
  }

  // 2. Extract structured dial_in (phone + PIN if present)
  let dial_in: string | null = null;
  const dialMatch =
    src.match(/(?:Or\s+dial|Dial(?:-in)?)\s*:\s*([^\n]+)/i) ||
    src.match(/(\([A-Z]{2}\)\s*\+[\d\s()-]{6,}(?:\s*PIN:\s*[\d\s#]+)?)/i);
  if (dialMatch && dialMatch[1]) {
    dial_in = cleanDisplayText(dialMatch[1]).replace(/\s+/g, " ").trim() || null;
  }

  // 3. Extract meaningful location (ignoring Meet placeholder text)
  let location: string | null = null;
  const locMatch = src.match(/^Location:\s*(.+)$/im);
  if (locMatch && locMatch[1]) {
    const cand = cleanDisplayText(locMatch[1]).trim();
    if (cand && !/google meet|instructions in description|web conference/i.test(cand)) {
      location = cand;
    }
  }

  // 4. Strip Google Meet ASCII divider block (-::~:~:: ... ::~:~::-) and Meet boilerplate lines
  let body = src
    .replace(/-::~:~:[\s\S]*?(?::-::~:~::-|::~:~::-|$)/gi, "\n")
    .replace(/^[^\n]*-::~:~:[^\n]*$/gim, "")
    .replace(/^Join with Google Meet:.*$/gim, "")
    .replace(/^Or dial:.*$/gim, "")
    .replace(/^More phone numbers:.*$/gim, "")
    .replace(/^Learn more about Meet at:.*$/gim, "")
    .replace(/^Please do not edit this section\.?.*$/gim, "");

  // 5. Strip redundant structured header lines
  body = body.replace(
    /^(?:Calendar|Start|End|Recurring|Recurrence|Participants|Attendees|Location|Organizer|Status):\s*.*$/gim,
    ""
  );

  // 6. Clean HTML/MIME/entities/tokens
  body = cleanDisplayText(body);

  // 7. Strip leading/duplicate title lines
  const normTitle = (eventTitle || "").toLowerCase().replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  const keptLines: string[] = [];
  for (let i = 0; i < body.split("\n").length; i++) {
    const line = body.split("\n")[i];
    const trimmed = line.trim();
    const normLine = trimmed.toLowerCase().replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
    if (i === 0 && trimmed.startsWith("#")) continue;
    if (normTitle && normLine === normTitle) continue;
    keptLines.push(line);
  }

  const notes = keptLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { meet_url, dial_in, notes, location };
}

const COMMERCIAL_PROMO_SENDER_RE =
  /(?:^|[\s<"'(@.-])(?:hello@|news@|newsletter@|marketing@|noreply@|no-reply@|donotreply|info@|digest@|updates@|notifications?@|store@|shop@|promo@|offers@|deals@|team@|support@|billing@|receipts@|mail@|mailer-daemon|merlin|houseofspoils|house\s+of\s+spoils|agents\s+unleashed|luma-mail\.com|substack|beehiiv|mailchimp|klaviyo|sendgrid|shopify|amazon|deliveroo|uber|kidoriman|linkedin\.com|medium\.com|trends\.vc|m\.redstone\.finance|vercel\.com|linear\.app|github\.com|revolut\.com)/i;

const COMMERCIAL_PROMO_CONTENT_RE =
  /(?:available\s+now|from\s+just\s+[£$]\d|annual\s+pass|unsubscribe|view\s+(?:this\s+email\s+)?in\s+(?:your\s+)?browser|manage\s+(?:your\s+email\s+)?preferences|limited\s+time|shop\s+now|claim\s+your|save\s+up\s+to|\d+\s*%\s*off|pre-?order|gift\s+christmas|november['’]s\s+most\s+wanted|someone\s+at\s+.+\s+you\s+may\s+know|report\s+#\d+|tokenized\s+stocks\s+digest|new\s+project\s+available\s+to\s+import|pr\s+run\s+failed|run\s+failed:|linear\s+checks\s+failed|weekly\s+digest|you\s+are\s+receiving\s+.*\s+notification\s+emails)/i;

export function isNoiseMessage(opts: {
  channel: string;
  sender?: string;
  from?: string;
  threadTitle?: string;
  subject?: string;
  body?: string;
  channelKey?: string;
}): boolean {
  const ch = (opts.channel || "").toLowerCase();
  const senderHay = `${opts.from || ""} ${opts.sender || ""}`.toLowerCase();
  const subjectHay = `${opts.subject || ""} ${opts.threadTitle || ""}`.toLowerCase();
  const bodySlice = (opts.body || "").slice(0, 2000).toLowerCase();

  if (ch === "gmail" || ch === "email") {
    if (COMMERCIAL_PROMO_SENDER_RE.test(senderHay)) return true;
    if (COMMERCIAL_PROMO_SENDER_RE.test(subjectHay)) return true;
    if (COMMERCIAL_PROMO_CONTENT_RE.test(subjectHay)) return true;
    if (COMMERCIAL_PROMO_CONTENT_RE.test(bodySlice)) return true;
    return false;
  }

  if (ch === "whatsapp") {
    const hay = `${opts.channelKey || ""} ${opts.threadTitle || ""}`.toLowerCase();
    return /(?:digital-assets-web3-global-house-of-block|crypto\s*signals|airdrop|broadcast|promo|newsletter|announcements?)/i.test(
      hay
    );
  }

  if (ch === "imessage") {
    const s = (opts.sender || opts.threadTitle || "").trim();
    if (/^\d{4,6}$/.test(s)) return true;
    if (
      /^(verify|auth|otp|apple|google|amazon|uber|dpd|evri|royalmail|hmrc|barclays|hsbc|monzo|revolut|amex|paypal|stripe|twilio)$/i.test(
        s
      )
    ) {
      return true;
    }
    if (
      /\b(verification code|one-time passcode|security code|use code \d{4,8}|your otp|do not share this code|reply stop to)\b/i.test(
        bodySlice
      )
    ) {
      return true;
    }
    return false;
  }

  return false;
}

function cleanText(text: string | null | undefined, maxLen = 600): string {
  if (!text) return "";
  const normalized = stripEmDashes(String(text)).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen - 3).trimEnd() + "...";
}

function isLikelyHexHash(s: string): boolean {
  const t = s.trim();
  return /^[0-9a-f]{24,64}$/i.test(t);
}

function extractLabelFromSummary(summary: string | null | undefined, fallbackId: string): string {
  if (summary) {
    const clean = stripEmDashes(summary).replace(/\s+/g, " ").trim();
    const quoted = clean.match(/labeled\s+["\u201c]([^"\u201d]{2,72})["\u201d]/i)
      || clean.match(/concept\s+["\u201c]([^"\u201d]{2,72})["\u201d]/i)
      || clean.match(/["\u201c]([^"\u201d]{3,64})["\u201d]/);
    if (quoted && quoted[1] && !isLikelyHexHash(quoted[1])) {
      return cleanText(quoted[1], 72);
    }
    const firstSentence = clean.split(/[.!?]/)[0] || clean;
    if (firstSentence.length >= 4) {
      return cleanText(firstSentence, 64);
    }
  }
  return `Concept ${fallbackId.slice(0, 8)}`;
}

function connectorLabel(connectorId: string): string {
  if (CONNECTOR_LABELS[connectorId]) return CONNECTOR_LABELS[connectorId];
  const short = connectorId.replace(/^kizuki\./, "").replace(/[-_.]+/g, " ");
  return short.replace(/\b\w/g, (c) => c.toUpperCase());
}

function normalizeKind(worldKind: string | null | undefined, fallbackKind = "concept"): string {
  if (!worldKind) return fallbackKind;
  const lower = worldKind.toLowerCase();
  if (lower.includes("situation")) return "situation";
  if (lower.includes("concept")) return "concept";
  if (lower.includes("person") || lower.includes("identity")) return "person";
  if (lower.includes("artifact")) return "artifact";
  if (lower.includes("project")) return "project";
  return fallbackKind;
}

function tokenizeKeywords(text: string): Set<string> {
  const out = new Set<string>();
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g);
  if (!matches) return out;
  for (const w of matches) {
    if (!STOPWORDS.has(w) && !isLikelyHexHash(w)) {
      out.add(w);
    }
  }
  return out;
}

function extractSections(markdown: string): string[] {
  const sections: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = line.match(/^##+\s+(.+?)\s*$/);
    if (m && m[1]) {
      sections.push(stripEmDashes(m[1].trim()));
    }
  }
  return sections;
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

export function isCoherentLlmAnswer(answer: string, prompt: string): { ok: boolean; reason?: string } {
  const text = answer.trim();
  if (text.length < 16) {
    return { ok: false, reason: "Response too short" };
  }
  if (text.includes("\uFFFD")) {
    return { ok: false, reason: "Corrupted unicode replacement characters" };
  }

  // Detect mixed-script logit corruption when the prompt is Latin/ASCII
  const promptLatinOnly = !/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\uAC00-\uD7AF\u0900-\u097F]/.test(prompt);
  if (promptLatinOnly) {
    const foreignMatches = text.match(/[\u0400-\u04FF\u0600-\u06FF\u4E00-\u9FFF\uAC00-\uD7AF\u0900-\u097F]/g);
    if (foreignMatches && foreignMatches.length >= 2) {
      return { ok: false, reason: "Mixed-script token corruption detected" };
    }
  }

  // Strip fenced code blocks and markdown table separator lines before checking punctuation/word salad
  const prose = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\|?[\s:|-]+\|?$/gm, " ");

  // Classic corrupted token patterns observed on FP8 batch sampling (e.g. "##,", "\,", repeated "(." or "(\n")
  if (/(?:##\s*,|\\,|\\n\s*\\n|\(\.\s*\(|`\s*\.\s*\()/.test(prose)) {
    return { ok: false, reason: "Corrupted punctuation sequence detected" };
  }

  const tokens = prose.split(/\s+/).filter(Boolean);
  if (tokens.length >= 12) {
    const wordTokens = tokens.filter((t) => /[a-zA-Z0-9]{2,}/.test(t));
    if (wordTokens.length / tokens.length < 0.45) {
      return { ok: false, reason: "Excessive non-word token density" };
    }

    // Check sliding window of 24 words for degenerate repetition
    const normWords = wordTokens.map((t) => t.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")).filter((w) => w.length >= 3);
    if (normWords.length >= 20) {
      for (let i = 0; i <= normWords.length - 20; i += 5) {
        const win = normWords.slice(i, i + 20);
        const freq = new Map<string, number>();
        for (const w of win) freq.set(w, (freq.get(w) || 0) + 1);
        const maxCount = Math.max(...freq.values());
        if (maxCount >= 8) {
          return { ok: false, reason: "Degenerate token repetition detected" };
        }
      }
    }
  }

  // Check runaway backslash / punctuation ratio
  const alphaCount = (prose.match(/[a-zA-Z0-9]/g) || []).length;
  const weirdPunctCount = (prose.match(/[\\{}\[\]<>^~]/g) || []).length;
  if (alphaCount > 20 && weirdPunctCount / alphaCount > 0.25) {
    return { ok: false, reason: "Abnormal symbol-to-text ratio" };
  }

  return { ok: true };
}

function escapeMdCell(text: string, maxLen = 140): string {
  return cleanText(text, maxLen).replace(/\|/g, "/").replace(/\r?\n/g, " ");
}

function formatCleanFallbackReason(rawReason: string): string {
  const r = stripEmDashes(String(rawReason || "")).toLowerCase();
  if (!r) return "synthesis engine unavailable";
  if (r.includes("socket") || r.includes("econnrefused") || r.includes("fetch") || r.includes("network") || r.includes("reset")) {
    return "engine socket temporarily unavailable";
  }
  if (r.includes("timeout") || r.includes("aborted")) {
    return "engine request timed out";
  }
  if (r.includes("coherence")) {
    return "engine output did not pass grounding check";
  }
  if (r.includes("http 5") || r.includes("http 4")) {
    return "engine returned an upstream error";
  }
  return "live synthesis unavailable";
}

function cleanCitationLabel(domain: string, condition: string): string {
  const cleanedCond = stripEmDashes(String(condition || ""))
    .replace(/\s+recovery:[a-z0-9_-]+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const full = domain ? `${domain}: ${cleanedCond}` : cleanedCond;
  if (full.length <= 96) return full;
  const cut = full.slice(0, 96);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 56 ? cut.slice(0, lastSpace) : cut).trim();
}

function buildStructuredVaultFallback(opts: {
  question: string;
  overview: OverviewResponse | null;
  today?: TodayResponse | null;
  antigravityCount: number;
  citations: Array<{ id: string; label: string; kind: string }>;
  evidenceRows: Array<{ source: string; label: string; detail: string }>;
  reason: string;
}): string {
  const sections: string[] = [];
  sections.push(`## Vault Evidence Summary`);
  sections.push(
    `Direct grounded vault evidence for: **${escapeMdCell(opts.question, 160)}** (${opts.citations.length} citations).`
  );

  if (opts.today) {
    const openActions = opts.today.actions.filter((a) => !a.done);
    const upcoming = opts.today.schedule.slice(0, 6);
    if (openActions.length > 0) {
      sections.push(`### Open Personal Actions`);
      sections.push(`| Action | Category | Source |`);
      sections.push(`| --- | --- | --- |`);
      for (const a of openActions.slice(0, 6)) {
        sections.push(`| ${escapeMdCell(a.title, 72)} | ${escapeMdCell(a.tag, 20)} | ${escapeMdCell(a.source, 32)} |`);
      }
    }
    if (upcoming.length > 0) {
      sections.push(`### Upcoming Schedule`);
      sections.push(`| Event | When | Calendar |`);
      sections.push(`| --- | --- | --- |`);
      for (const ev of upcoming.slice(0, 6)) {
        sections.push(`| ${escapeMdCell(ev.title, 64)} | ${escapeMdCell(ev.countdown, 24)} | ${escapeMdCell(ev.calendar, 32)} |`);
      }
    }
  }

  if (opts.overview) {
    const v = opts.overview.vault;
    const pipelines = [
      ...v.connectors.map((c) => ({
        label: connectorLabel(c.id),
        id: c.id,
        count: c.count,
        latest: c.latest || "unknown",
      })),
      ...(opts.antigravityCount > 0
        ? [{ label: "Antigravity Neon", id: "antigravity-neon", count: opts.antigravityCount, latest: "live" }]
        : []),
    ].sort((a, b) => b.count - a.count);
    const totalEvents = Math.max(v.events_total, pipelines.reduce((s, p) => s + p.count, 0));

    sections.push(`### Top Active Kizuki Data Pipelines`);
    sections.push(`| Pipeline | Events | Share | Latest |`);
    sections.push(`| --- | ---: | ---: | --- |`);
    for (const p of pipelines.slice(0, 5)) {
      const share = totalEvents > 0 ? `${((p.count / totalEvents) * 100).toFixed(1)}%` : "0.0%";
      sections.push(
        `| ${escapeMdCell(p.label, 40)} | ${p.count.toLocaleString("en-US")} | ${share} | ${escapeMdCell(p.latest, 24)} |`
      );
    }

    sections.push(`### Key Vault Metrics`);
    sections.push(`| Metric | Value |`);
    sections.push(`| --- | ---: |`);
    sections.push(`| Events Total | ${v.events_total.toLocaleString("en-US")} (+${v.events_24h.toLocaleString("en-US")} in 24h) |`);
    sections.push(`| Markdown Docs Total | ${v.docs_total.toLocaleString("en-US")} |`);
    sections.push(`| Live Claims | ${v.claims_live.toLocaleString("en-US")} (${v.world_typed.toLocaleString("en-US")} world-typed) |`);
    sections.push(`| World Consolidation | ${v.consolidation_complete.toLocaleString("en-US")} complete / ${v.consolidation_pending.toLocaleString("en-US")} pending |`);
    sections.push(`| MemT Experiences | ${opts.overview.memt.verified}/${opts.overview.memt.total} verified (${opts.overview.memt.mode}) |`);
  }

  if (opts.evidenceRows.length > 0) {
    sections.push(`### Grounded Vault Matches`);
    sections.push(`| Source | Record | Evidence |`);
    sections.push(`| --- | --- | --- |`);
    for (const row of opts.evidenceRows.slice(0, 8)) {
      sections.push(
        `| ${escapeMdCell(row.source, 20)} | ${escapeMdCell(row.label, 52)} | ${escapeMdCell(row.detail, 140)} |`
      );
    }
  }

  sections.push(`*Live synthesis temporarily unavailable (${formatCleanFallbackReason(opts.reason)}); showing direct personal context and vault matches.*`);
  return stripEmDashes(sections.join("\n"));
}

const VAULT_METRICS_QUERY_RE =
  /\b(metric|metrics|pipeline|pipelines|connector|connectors|status|overview|priorit|summary|vault|count|counts|total|active|memt|consolidat|ingest|event|events|claim|claims|doc|docs|health|brief|digest|table|compar|top\s+\d+)\b/i;

function isSafeBriefFilename(name: string): boolean {
  return /^(brief-\d{4}-\d{2}-\d{2}\.md|executive-digest-latest\.md)$/.test(name);
}

async function execCommand(
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill();
    } catch {
      // ignore kill error
    }
  }, timeoutMs);

  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return {
      ok: !timedOut && exitCode === 0,
      stdout,
      stderr: timedOut ? `Command timed out after ${timeoutMs}ms` : stderr,
      exitCode: timedOut ? 124 : exitCode,
    };
  } finally {
    clearTimeout(timer);
  }
}

export class KizukiVaultApi {
  readonly vaultPath: string;
  readonly dbPath: string;
  readonly kizukiBin: string;
  readonly bridgeMeterPath: string;
  readonly antigravityJsonlPath: string;
  readonly bridgesDir: string;
  readonly llmEndpoint: string;
  readonly llmModel: string;
  readonly fallbackLlmEndpoint: string | null;
  readonly fallbackLlmModel: string;
  readonly fallbackLlmTokenPath: string;
  readonly actionsPath: string;
  readonly lifeosPeopleDir: string | null;
  readonly relationshipsDir: string | null;

  private db: Database;
  private versionCache: CacheEntry<string> | null = null;
  private daemonActiveCache: CacheEntry<boolean> | null = null;
  private connectorsCache: CacheEntry<ConnectorStat[]> | null = null;
  private overviewCache: CacheEntry<OverviewResponse> | null = null;
  private memtStatusCache: CacheEntry<Record<string, unknown>> | null = null;
  private memtListCache: CacheEntry<MemtExperience[]> | null = null;
  private graphCache: CacheEntry<{ key: string; data: GraphResponse }> | null = null;
  private docIndexCache: CacheEntry<DocIndexSnapshot> | null = null;
  private docIndexInFlight: Promise<DocIndexSnapshot> | null = null;
  private antigravityCache: CacheEntry<StreamItem[]> | null = null;
  private personalIndexWorker: PersonalIndexWorkerClient;
  private personalIndexSnapshot: HotSnapshot<PersonalIndexSnapshot>;
  private atlasSnapshot: HotSnapshot<AtlasResponse>;
  private bridgesSnapshot: HotSnapshot<BridgeSourceSnapshot[]>;
  private pulseSnapshot: HotSnapshot<PulseResponse>;
  private dossierIntelCache = new Map<
    string,
    CacheEntry<{
      related_docs: RelatedDocRef[];
      sqliteIntel: SqlitePersonIntel;
      worldModel: PersonWorldModel;
      profile_visuals: PersonProfileVisuals;
      collaborators: PersonDossierCollaborator[];
      allMeetings: PersonDossierMeeting[];
      pastMeetings: PersonDossierMeeting[];
      resolvedChannels: string[];
      effectiveClaimCount: number;
    }>
  >();
  private todayMemo = new Map<string, TodayResponse>();
  private actionsCache: { mtimeMs: number; size: number; actions: OwnerAction[] } | null = null;
  private actionsVersion = 0;
  private fallbackTokenCache: CacheEntry<string | null> | null = null;

  constructor(config: VaultApiConfig = {}) {
    this.vaultPath = config.vaultPath || DEFAULT_VAULT_PATH;
    this.dbPath = config.dbPath || join(this.vaultPath, ".kizuki", "kizuki.db");
    this.kizukiBin = config.kizukiBin || DEFAULT_KIZUKI_BIN;
    this.bridgeMeterPath = config.bridgeMeterPath || DEFAULT_BRIDGE_METER_PATH;
    this.antigravityJsonlPath = config.antigravityJsonlPath || DEFAULT_ANTIGRAVITY_JSONL_PATH;
    this.bridgesDir = config.bridgesDir || DEFAULT_BRIDGES_DIR;
    this.llmEndpoint = config.llmEndpoint || DEFAULT_LLM_ENDPOINT;
    this.llmModel = config.llmModel || DEFAULT_LLM_MODEL;
    this.fallbackLlmEndpoint =
      config.fallbackLlmEndpoint !== undefined
        ? config.fallbackLlmEndpoint
        : config.llmEndpoint !== undefined
          ? null
          : DEFAULT_FALLBACK_LLM_ENDPOINT;
    this.fallbackLlmModel = config.fallbackLlmModel || DEFAULT_FALLBACK_LLM_MODEL;
    this.fallbackLlmTokenPath = config.fallbackLlmTokenPath || DEFAULT_FALLBACK_LLM_TOKEN_PATH;
    this.actionsPath = config.actionsPath || join(this.vaultPath, "owner-actions.json");
    this.lifeosPeopleDir =
      config.lifeosPeopleDir !== undefined
        ? config.lifeosPeopleDir
        : this.vaultPath === DEFAULT_VAULT_PATH
          ? DEFAULT_LIFEOS_PEOPLE_DIR
          : null;
    this.relationshipsDir =
      config.relationshipsDir !== undefined
        ? config.relationshipsDir
        : this.vaultPath === DEFAULT_VAULT_PATH
          ? DEFAULT_LIFEOS_RELATIONSHIPS_DIR
          : null;

    // Strictly readonly SQLite handle, zero secret files touched.
    this.db = new Database(this.dbPath, { readonly: true });
    try {
      this.db.exec("PRAGMA busy_timeout = 3000;");
    } catch {
      // ignore on readonly
    }

    const checkIntervalMs = config.snapshotCheckIntervalMs ?? 5_000;

    this.personalIndexWorker = createPersonalIndexWorkerClient(
      {
        vaultPath: this.vaultPath,
        dbPath: this.dbPath,
        bridgesDir: this.bridgesDir,
        lifeosPeopleDir: this.lifeosPeopleDir,
        relationshipsDir: this.relationshipsDir,
      },
      { disableWorker: Boolean(config.disablePersonalWorker) }
    );

    this.personalIndexSnapshot = new HotSnapshot<PersonalIndexSnapshot>({
      name: "personal-index",
      checkIntervalMs,
      fingerprint: () => this.computePersonalIndexFingerprint(),
      build: () => this.personalIndexWorker.build() as Promise<PersonalIndexSnapshot>,
    });

    this.atlasSnapshot = new HotSnapshot<AtlasResponse>({
      name: "atlas",
      checkIntervalMs: 60_000,
      maxAgeMs: 60_000,
      build: () => this.buildAtlas(),
    });

    this.bridgesSnapshot = new HotSnapshot<BridgeSourceSnapshot[]>({
      name: "bridges",
      checkIntervalMs: 15_000,
      fingerprint: () => this.computeBridgesFingerprint(),
      build: () => this.buildBridgeSnapshots(),
    });

    this.pulseSnapshot = new HotSnapshot<PulseResponse>({
      name: "pulse",
      checkIntervalMs: 15_000,
      fingerprint: () => this.computePulseFingerprint(),
      build: () => this.buildPulse(),
    });
  }

  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.personalIndexSnapshot.dispose();
    this.atlasSnapshot.dispose();
    this.bridgesSnapshot.dispose();
    this.pulseSnapshot.dispose();
    this.personalIndexWorker.dispose();
    try {
      this.db.close();
    } catch {
      // ignore
    }
  }

  async synthesizeText(opts: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    promptForCoherence: string;
    primaryMaxTokens?: number;
    fallbackMaxTokens?: number;
  }): Promise<{ ok: true; engine: string; model: string; content: string } | { ok: false; reason: string }> {
    const res = await this.synthesizeWithDualEngine(opts);
    if (!res.ok) {
      return { ok: false, reason: res.reason };
    }
    return {
      ok: true,
      engine: res.engine,
      model: res.model,
      content: res.content,
    };
  }

  invalidateCaches(): void {
    this.connectorsCache = null;
    this.overviewCache = null;
    this.memtStatusCache = null;
    this.memtListCache = null;
    this.graphCache = null;
    this.docIndexCache = null;
    this.antigravityCache = null;
    this.dossierIntelCache.clear();
    // Never drop live hot snapshots or todayMemo (memo keys automatically track snapshot versions);
    // schedule non-blocking background refresh instead.
    this.personalIndexSnapshot.markDirty();
    this.atlasSnapshot.markDirty();
    this.bridgesSnapshot.markDirty();
    this.pulseSnapshot.markDirty();
  }

  private async readFallbackLlmToken(): Promise<string | null> {
    const now = Date.now();
    if (this.fallbackTokenCache && this.fallbackTokenCache.expiresAt > now) {
      return this.fallbackTokenCache.value;
    }
    try {
      const raw = await readFile(this.fallbackLlmTokenPath, "utf8");
      const trimmed = raw.trim();
      const val = trimmed.length > 0 ? trimmed : null;
      this.fallbackTokenCache = { value: val, expiresAt: now + 60_000 };
      return val;
    } catch {
      this.fallbackTokenCache = { value: null, expiresAt: now + 15_000 };
      return null;
    }
  }

  private sanitizeLlmError(err: unknown, secretToken?: string | null): string {
    let msg = err instanceof Error ? err.message : String(err);
    if (secretToken && secretToken.length > 4) {
      msg = msg.split(secretToken).join("[REDACTED]");
    }
    return stripEmDashes(msg).slice(0, 220);
  }

  private async synthesizeWithDualEngine(opts: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    promptForCoherence: string;
    primaryMaxTokens?: number;
    primaryTemperature?: number;
    fallbackMaxTokens?: number;
    fallbackTemperature?: number;
  }): Promise<
    | {
        ok: true;
        engine: "Local LLM" | "Fallback LLM";
        model: string;
        content: string;
        usage: Record<string, unknown> | null;
      }
    | {
        ok: false;
        reason: string;
      }
  > {
    const primaryMax = opts.primaryMaxTokens ?? 2048;
    const primaryTemp = opts.primaryTemperature ?? 0.3;
    const fallbackMax = opts.fallbackMaxTokens ?? 1800;
    const fallbackTemp = opts.fallbackTemperature ?? 0.25;

    // Engine 1: Primary Local LLM (:8003)
    // Passing top_p routes interactive requests cleanly and avoids batch token-sampling drift.
    // Never pass chat_template_kwargs: { enable_thinking: false }, and NEVER return raw reasoning_content.
    const callPrimary = async (maxTokens: number, reasoningEffort?: "low" | "medium") => {
      const payload: Record<string, unknown> = {
        model: this.llmModel,
        max_tokens: maxTokens,
        temperature: primaryTemp,
        top_p: 0.95,
        messages: opts.messages,
      };
      if (reasoningEffort) {
        payload.reasoning_effort = reasoningEffort;
      }
      const resp = await fetch(this.llmEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        throw new Error(`Primary LLM HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as {
        choices?: Array<{
          message?: { content?: string | null; reasoning_content?: string | null };
          finish_reason?: string;
        }>;
        usage?: Record<string, unknown>;
      };
      const rawContent = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
      return {
        content: stripEmDashes(stripThinkBlocks(rawContent)),
        usage: data.usage || null,
      };
    };

    let primaryReason = "";
    try {
      // Fast pre-flight /health check when targeting default Colab G4 tunnel (:8003) with fallback enabled,
      // so a hung SSH forward fails over to MiniMax-M2.7 in <1.2s instead of stalling for 30s.
      if (this.fallbackLlmEndpoint && this.llmEndpoint === DEFAULT_LLM_ENDPOINT) {
        const healthUrl = this.llmEndpoint.replace(/\/v1\/chat\/completions\/?$/, "/health");
        const hResp = await fetch(healthUrl, { signal: AbortSignal.timeout(1200) });
        if (!hResp.ok) {
          throw new Error(`Primary LLM health HTTP ${hResp.status}`);
        }
      }
      let primaryRes = await callPrimary(primaryMax, "low");
      let check = isCoherentLlmAnswer(primaryRes.content, opts.promptForCoherence);
      if (!check.ok) {
        primaryRes = await callPrimary(Math.max(3072, primaryMax));
        check = isCoherentLlmAnswer(primaryRes.content, opts.promptForCoherence);
      }
      if (check.ok) {
        return {
          ok: true,
          engine: "Local LLM",
          model: this.llmModel,
          content: primaryRes.content,
          usage: primaryRes.usage,
        };
      }
      primaryReason = `Coherence guard rejected LLM output: ${check.reason || "incoherent"}`;
    } catch (err) {
      primaryReason = this.sanitizeLlmError(err);
    }

    // Engine 2: Local MiniMax-M2.7 bridge (:8788) failover
    if (this.fallbackLlmEndpoint) {
      let token: string | null = null;
      try {
        token = await this.readFallbackLlmToken();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (token) {
          headers["Authorization"] = `Bearer ${token}`;
        }
        const payload = {
          model: this.fallbackLlmModel,
          max_tokens: fallbackMax,
          temperature: fallbackTemp,
          messages: opts.messages,
        };
        const resp = await fetch(this.fallbackLlmEndpoint, {
          method: "POST",
          headers,
          signal: AbortSignal.timeout(90_000),
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          throw new Error(`Fallback LLM HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as {
          model?: string;
          choices?: Array<{
            message?: { content?: string | null; reasoning_content?: string | null };
            finish_reason?: string;
          }>;
          usage?: Record<string, unknown>;
        };
        const rawContent = typeof data.choices?.[0]?.message?.content === "string" ? data.choices[0].message.content : "";
        const cleaned = stripEmDashes(stripThinkBlocks(rawContent));
        const check = isCoherentLlmAnswer(cleaned, opts.promptForCoherence);
        if (check.ok) {
          return {
            ok: true,
            engine: "Fallback LLM",
            model: data.model || this.fallbackLlmModel,
            content: cleaned,
            usage: data.usage || null,
          };
        }
        return {
          ok: false,
          reason: `Primary (${primaryReason}); Fallback coherence guard rejected output: ${check.reason || "incoherent"}`,
        };
      } catch (err) {
        const fbReason = this.sanitizeLlmError(err, token);
        return {
          ok: false,
          reason: `Primary (${primaryReason}); Fallback (${fbReason})`,
        };
      }
    }

    return { ok: false, reason: primaryReason || "No synthesis engine available" };
  }

  private getConnectorStats(): ConnectorStat[] {
    const now = Date.now();
    if (this.connectorsCache && this.connectorsCache.expiresAt > now) {
      return this.connectorsCache.value;
    }
    const rows = this.db
      .query(
        `SELECT connector_id AS id, COUNT(*) AS count, MAX(occurred_at) AS latest
         FROM events
         WHERE deleted = 0
         GROUP BY connector_id
         ORDER BY count DESC`
      )
      .all() as ConnectorStat[];
    const clean = rows.map((c) => ({
      id: c.id,
      count: Number(c.count || 0),
      latest: c.latest || null,
    }));
    this.connectorsCache = { value: clean, expiresAt: now + 10_000 };
    return clean;
  }

  async getVersion(): Promise<string> {
    const now = Date.now();
    if (this.versionCache && this.versionCache.expiresAt > now) {
      return this.versionCache.value;
    }
    const res = await execCommand([this.kizukiBin, "version", "--vault", this.vaultPath], 3000);
    const raw = res.stdout.trim() || "unknown";
    const version = raw.split(/\s+/)[0] || "unknown";
    this.versionCache = { value: version, expiresAt: now + 60_000 };
    return version;
  }

  async isDaemonActive(): Promise<boolean> {
    const now = Date.now();
    if (this.daemonActiveCache && this.daemonActiveCache.expiresAt > now) {
      return this.daemonActiveCache.value;
    }
    const res = await execCommand(
      ["systemctl", "--user", "list-units", "--state=active", "kizuki@*.service", "--no-legend"],
      2500
    );
    const active = res.ok && res.stdout.trim().length > 0;
    this.daemonActiveCache = { value: active, expiresAt: now + 15_000 };
    return active;
  }

  async getHealth(): Promise<{ ok: true; ts: string; vault_ok: boolean; version: string }> {
    let vaultOk = false;
    try {
      const row = this.db.query("SELECT 1 AS ok").get() as { ok: number } | null;
      vaultOk = row?.ok === 1;
    } catch {
      vaultOk = false;
    }
    const version = await this.getVersion();
    return {
      ok: true,
      ts: new Date().toISOString(),
      vault_ok: vaultOk,
      version,
    };
  }

  private async getMemtStatusRaw(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.memtStatusCache && this.memtStatusCache.expiresAt > now) {
      return this.memtStatusCache.value;
    }
    const res = await execCommand(
      [this.kizukiBin, "memt", "status", "--vault", this.vaultPath, "--json"],
      5000
    );
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as { data?: Record<string, unknown> };
        const data = parsed.data || {};
        this.memtStatusCache = { value: data, expiresAt: now + 10_000 };
        return data;
      } catch {
        // fallback below
      }
    }
    return {
      mode: "unavailable",
      experiences: { total: 0, verified: 0 },
    };
  }

  async getMemtExperiences(limit = 50): Promise<MemtExperience[]> {
    const now = Date.now();
    if (this.memtListCache && this.memtListCache.expiresAt > now) {
      return this.memtListCache.value.slice(0, limit);
    }
    const res = await execCommand(
      [
        this.kizukiBin,
        "memt",
        "experience",
        "list",
        "--vault",
        this.vaultPath,
        "--limit",
        String(Math.max(limit, 50)),
        "--json",
      ],
      6000
    );
    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as {
          data?: { experiences?: MemtExperience[] };
        };
        const list = parsed.data?.experiences || [];
        this.memtListCache = { value: list, expiresAt: now + 15_000 };
        return list.slice(0, limit);
      } catch {
        // fallback below
      }
    }
    return [];
  }

  async getMemt(): Promise<MemtResponse> {
    const [status, experiences] = await Promise.all([
      this.getMemtStatusRaw(),
      this.getMemtExperiences(50),
    ]);
    return { status, experiences };
  }

  private async getBridgeStats(): Promise<{ inkling_calls: number; inkling_tokens: number }> {
    try {
      const raw = await readFile(this.bridgeMeterPath, "utf8");
      const parsed = JSON.parse(raw) as {
        inkling_ok?: number;
        inkling_tokens?: number;
      };
      if (typeof parsed.inkling_ok === "number" || typeof parsed.inkling_tokens === "number") {
        return {
          inkling_calls: Number(parsed.inkling_ok || 0),
          inkling_tokens: Number(parsed.inkling_tokens || 0),
        };
      }
    } catch {
      // Fallback to world_consolidation token accounting
    }
    try {
      const row = this.db
        .query(
          `SELECT COUNT(*) AS calls,
                  COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens
           FROM world_consolidation
           WHERE status = 'complete'`
        )
        .get() as { calls: number; tokens: number } | null;
      return {
        inkling_calls: row?.calls || 0,
        inkling_tokens: row?.tokens || 0,
      };
    } catch {
      return { inkling_calls: 0, inkling_tokens: 0 };
    }
  }

  private computeUnifiedEventsTotal(sqlStats: ConnectorStat[], bridges: BridgeSourceSnapshot[]): number {
    const sqlById = new Map(sqlStats.map((c) => [c.id, Number(c.count || 0)]));
    const sqlTotal = sqlStats.reduce((sum, r) => sum + Number(r.count || 0), 0);
    let extraBridgeTotal = 0;
    for (const snap of bridges) {
      if (snap.count <= 0) continue;
      const sqlAliasSum = snap.spec.sqlAliases.reduce((sum, a) => sum + (sqlById.get(a) || 0), 0);
      extraBridgeTotal += Math.max(0, snap.count - sqlAliasSum);
    }
    return sqlTotal + extraBridgeTotal;
  }

  async getOverview(): Promise<OverviewResponse> {
    const now = Date.now();
    if (this.overviewCache && this.overviewCache.expiresAt > now) {
      return this.overviewCache.value;
    }

    // Launch async CLI and file reads in parallel with synchronous SQLite queries
    const asyncPartsPromise = Promise.all([
      this.getMemtStatusRaw(),
      this.getBridgeStats(),
      this.getVersion(),
      this.isDaemonActive(),
      this.getBrief(),
      this.getDocIndex(),
      this.getBridgeSnapshots(),
    ]);

    const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

    const connectorRows = this.getConnectorStats();

    const events24hRow = this.db
      .query(`SELECT COUNT(*) AS c FROM events WHERE deleted = 0 AND occurred_at >= ?`)
      .get(cutoff24h) as { c: number } | null;

    const claimBreakdown = this.db
      .query(
        `SELECT is_world_typed, COUNT(*) AS c
         FROM claims
         WHERE status = 'live'
         GROUP BY is_world_typed`
      )
      .all() as Array<{ is_world_typed: number; c: number }>;

    let claimsLive = 0;
    let worldTyped = 0;
    for (const r of claimBreakdown) {
      claimsLive += Number(r.c || 0);
      if (r.is_world_typed === 1) worldTyped += Number(r.c || 0);
    }

    const claims24hRow = this.db
      .query(`SELECT COUNT(*) AS c FROM claims WHERE status = 'live' AND created_at >= ?`)
      .get(cutoff24h) as { c: number } | null;

    const wcRows = this.db
      .query(`SELECT status, COUNT(*) AS c FROM world_consolidation GROUP BY status`)
      .all() as Array<{ status: string; c: number }>;

    let consolidationComplete = 0;
    let consolidationPending = 0;
    for (const r of wcRows) {
      if (r.status === "complete") consolidationComplete = Number(r.c || 0);
      else if (r.status === "pending") consolidationPending = Number(r.c || 0);
    }

    const countsRow = this.db
      .query(
        `SELECT
           (SELECT COUNT(*) FROM identity_links) AS identity_links,
           (SELECT COUNT(*) FROM world_forecasts) AS forecasts`
      )
      .get() as { identity_links: number; forecasts: number } | null;

    const [memtStatus, bridge, version, active, brief, docIndex, bridges] = await asyncPartsPromise;
    const eventsTotal = this.computeUnifiedEventsTotal(connectorRows, bridges);

    const memtExp = (memtStatus.experiences as { verified?: number; total?: number } | undefined) || {};
    const briefBytes = brief.latest.name ? Buffer.byteLength(brief.latest.markdown, "utf8") : 0;

    const overview: OverviewResponse = {
      vault: {
        events_total: eventsTotal,
        events_24h: Number(events24hRow?.c || 0),
        claims_live: claimsLive,
        claims_24h: Number(claims24hRow?.c || 0),
        world_typed: worldTyped,
        consolidation_complete: consolidationComplete,
        consolidation_pending: consolidationPending,
        identity_links: Number(countsRow?.identity_links || 0),
        forecasts: Number(countsRow?.forecasts || 0),
        docs_total: docIndex.entries.length,
        connectors: connectorRows.map((c) => ({
          id: c.id,
          count: Number(c.count || 0),
          latest: c.latest || null,
        })),
      },
      memt: {
        mode: String(memtStatus.mode || "local-hybrid"),
        verified: Number(memtExp.verified || 0),
        total: Number(memtExp.total || 0),
      },
      bridge,
      daemon: {
        version,
        active,
      },
      latest_brief: {
        name: brief.latest.name,
        bytes: briefBytes,
        sections: extractSections(brief.latest.markdown),
      },
    };

    this.overviewCache = { value: overview, expiresAt: now + 5_000 };
    return overview;
  }

  private async buildFullGraph(limit: number): Promise<GraphResponse> {
    const clampedLimit = Math.max(20, Math.min(400, limit));
    const nodeMap = new Map<string, GraphNode>();
    const edgeMap = new Map<string, GraphEdge>();
    const subjectToNodeId = new Map<string, string>();
    const nodeKeywords = new Map<string, Set<string>>();
    const sourceKeyToNodes = new Map<string, string[]>();

    const addEdge = (source: string, target: string, predicate: string, weight = 1) => {
      if (source === target) return;
      if (!nodeMap.has(source) || !nodeMap.has(target)) return;
      const key = `${source}|${target}|${predicate}`;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.weight += weight;
      } else {
        edgeMap.set(key, { source, target, predicate, weight });
      }
    };

    // Start MemT CLI fetch in parallel with SQLite reads
    const memtPromise = this.getMemtExperiences(50);

    // 1. Enrolled connector hub nodes from live events
    const connectorRows = this.getConnectorStats();

    for (const c of connectorRows) {
      const id = `connector:${c.id}`;
      nodeMap.set(id, {
        id,
        label: connectorLabel(c.id),
        kind: "connector",
        group: "connector",
        degree: 0,
        confidence: 1,
        consolidated: true,
        summary: `${Number(c.count).toLocaleString("en-US")} ingested events from ${c.id}.`,
        claim_count: Number(c.count || 0),
        updated_at: c.latest || null,
        source_kind: "connector",
      });
    }

    // 2. Live verified MemT experiences (cached 15s)
    const memtExperiences = await memtPromise;
    const domainGroups = new Map<string, string[]>();
    for (const exp of memtExperiences) {
      if (nodeMap.size >= clampedLimit) break;
      const shortCond = cleanText(exp.condition, 52);
      const label = `${exp.domain}: ${shortCond}`;
      const summary = cleanText(
        `${exp.condition} | Action: ${exp.recommendation}${exp.verification ? ` | Verified: ${exp.verification}` : ""}`,
        520
      );
      nodeMap.set(exp.id, {
        id: exp.id,
        label,
        kind: "memt",
        group: exp.domain || "memt",
        degree: 0,
        confidence: Number(exp.confidence ?? 0.9),
        consolidated: exp.outcome === "verified",
        summary,
        claim_count: Math.max(1, (exp.citations?.length || 0) + 1),
        updated_at: exp.updated_at || exp.created_at || null,
        source_kind: "memt",
      });
      nodeKeywords.set(exp.id, tokenizeKeywords(`${exp.domain} ${exp.condition} ${exp.recommendation}`));
      const arr = domainGroups.get(exp.domain || "general") || [];
      arr.push(exp.id);
      domainGroups.set(exp.domain || "general", arr);
    }

    // 3. Completed world_consolidation objects joined with claim_v2_semantics + claims + connections
    const wcRows = this.db
      .query(
        `SELECT wc.handle_id,
                wc.kind,
                wc.summary,
                COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                         THEN json_extract(s.payload, '$.object.value') END) AS sem_label,
                MAX(CASE WHEN c.target IS NOT NULL AND length(trim(c.target)) > 1
                         THEN c.target END) AS claim_target,
                MAX(CASE WHEN c.subject IS NOT NULL AND length(trim(c.subject)) > 1
                         THEN c.subject END) AS claim_subject,
                COUNT(DISTINCT wcb.claim_id) AS claim_count,
                AVG(COALESCE(c.confidence, 0.7)) AS avg_conf,
                GROUP_CONCAT(DISTINCT s.subject_id) AS subject_ids,
                GROUP_CONCAT(DISTINCT conn.connector_id) AS connector_ids,
                GROUP_CONCAT(DISTINCT wcb.source_key) AS source_keys
         FROM world_consolidation wc
         LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
         LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
         LEFT JOIN claims c ON c.claim_id = wcb.claim_id
         LEFT JOIN connections conn ON conn.source_key = wcb.source_key
         WHERE wc.status = 'complete'
         GROUP BY wc.handle_id
         ORDER BY claim_count DESC, updated_at DESC`
      )
      .all() as Array<{
        handle_id: string;
        kind: string;
        summary: string | null;
        updated_at: string | null;
        sem_label: string | null;
        claim_target: string | null;
        claim_subject: string | null;
        claim_count: number;
        avg_conf: number | null;
        subject_ids: string | null;
        connector_ids: string | null;
        source_keys: string | null;
      }>;

    const usedNormalizedLabels = new Set<string>();
    const wcConnectors = new Map<string, string[]>();

    // Reserve some slots for non-consolidated situations/concepts if limit is small
    const maxWcNodes = Math.max(20, clampedLimit - nodeMap.size - Math.min(35, Math.floor(clampedLimit * 0.25)));
    let wcAdded = 0;

    for (const r of wcRows) {
      if (nodeMap.size >= clampedLimit || wcAdded >= maxWcNodes) break;
      let label =
        (r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanText(r.sem_label, 72) : "") ||
        (r.claim_subject && !isLikelyHexHash(r.claim_subject) ? cleanText(r.claim_subject, 72) : "") ||
        (r.claim_target && !isLikelyHexHash(r.claim_target) ? cleanText(r.claim_target, 72) : "") ||
        extractLabelFromSummary(r.summary, r.handle_id);

      const kind = normalizeKind(r.kind, "concept");
      const summary = cleanText(r.summary || `${label} (${kind})`, 520);

      nodeMap.set(r.handle_id, {
        id: r.handle_id,
        label,
        kind,
        group: `world_${kind}`,
        degree: 0,
        confidence: Number((r.avg_conf ?? 0.78).toFixed(2)),
        consolidated: true,
        summary,
        claim_count: Math.max(1, Number(r.claim_count || 1)),
        updated_at: r.updated_at || null,
        source_kind: "world_consolidation",
      });
      wcAdded++;
      usedNormalizedLabels.add(label.toLowerCase());
      nodeKeywords.set(r.handle_id, tokenizeKeywords(`${label} ${summary}`));

      if (r.subject_ids) {
        for (const sid of r.subject_ids.split(",")) {
          if (sid) subjectToNodeId.set(sid, r.handle_id);
        }
      }
      if (r.connector_ids) {
        wcConnectors.set(
          r.handle_id,
          r.connector_ids.split(",").filter(Boolean)
        );
      }
      if (r.source_keys) {
        for (const sk of r.source_keys.split(",").filter(Boolean)) {
          const list = sourceKeyToNodes.get(sk) || [];
          list.push(r.handle_id);
          sourceKeyToNodes.set(sk, list);
        }
      }
    }

    // 4. Fill remaining slots with top live labeled claim_v2_semantics subjects (situations, concepts, people)
    const remainingSlots = clampedLimit - nodeMap.size;
    const semConnectors = new Map<string, string[]>();

    if (remainingSlots > 0) {
      const semRows = this.db
        .query(
          `SELECT s.subject_id,
                  MAX(CASE WHEN s.predicate IN ('situation.label','concept.label','identity.display_name','artifact.label')
                           THEN json_extract(s.payload, '$.object.value') END) AS label,
                  MAX(CASE WHEN s.predicate = 'world.kind'
                           THEN json_extract(s.payload, '$.object.ref.id') END) AS world_kind,
                  MAX(CASE WHEN s.predicate IN ('concept.definition','situation.objective','situation.blocker','situation.commitment','situation.change','project.status')
                           THEN json_extract(s.payload, '$.object.value') END) AS detail_text,
                  COUNT(*) AS claim_count,
                  AVG(c.confidence) AS avg_conf,
                  MAX(c.created_at) AS updated_at,
                  GROUP_CONCAT(DISTINCT conn.connector_id) AS connector_ids,
                  GROUP_CONCAT(DISTINCT sup.source_key) AS source_keys
           FROM claim_v2_semantics s
           JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
           LEFT JOIN claim_v2_support sup ON sup.claim_id = s.claim_id
           LEFT JOIN connections conn ON conn.source_key = sup.source_key
           WHERE s.subject_id IS NOT NULL
             AND s.predicate IN (
               'world.kind','situation.label','concept.label','identity.display_name','artifact.label',
               'concept.definition','situation.objective','situation.blocker','situation.commitment',
               'situation.change','project.status'
             )
           GROUP BY s.subject_id
           HAVING label IS NOT NULL AND length(trim(label)) > 1
           ORDER BY claim_count DESC, updated_at DESC
           LIMIT ?`
        )
        .all(Math.max(remainingSlots * 4, 240)) as Array<{
          subject_id: string;
          label: string;
          world_kind: string | null;
          detail_text: string | null;
          claim_count: number;
          avg_conf: number | null;
          updated_at: string | null;
          connector_ids: string | null;
          source_keys: string | null;
        }>;

      for (const r of semRows) {
        if (nodeMap.size >= clampedLimit) break;
        if (subjectToNodeId.has(r.subject_id)) continue;
        if (isLikelyHexHash(r.label)) continue;

        const cleanLabel = cleanText(r.label, 72);
        const norm = cleanLabel.toLowerCase();
        if (usedNormalizedLabels.has(norm)) continue;

        const kind = normalizeKind(r.world_kind, "situation");
        // Skip noisy raw artifact file versions unless space permits
        if (kind === "artifact" && nodeMap.size > clampedLimit - 10) continue;

        usedNormalizedLabels.add(norm);
        subjectToNodeId.set(r.subject_id, r.subject_id);
        const summary = cleanText(r.detail_text || `${cleanLabel} (${kind})`, 460);

        nodeMap.set(r.subject_id, {
          id: r.subject_id,
          label: cleanLabel,
          kind,
          group: `sem_${kind}`,
          degree: 0,
          confidence: Number((r.avg_conf ?? 0.55).toFixed(2)),
          consolidated: false,
          summary,
          claim_count: Number(r.claim_count || 1),
          updated_at: r.updated_at || null,
          source_kind: "claim_v2_semantics",
        });
        nodeKeywords.set(r.subject_id, tokenizeKeywords(`${cleanLabel} ${summary}`));

        if (r.connector_ids) {
          semConnectors.set(
            r.subject_id,
            r.connector_ids.split(",").filter(Boolean)
          );
        }
        if (r.source_keys) {
          for (const sk of r.source_keys.split(",").filter(Boolean)) {
            const list = sourceKeyToNodes.get(sk) || [];
            list.push(r.subject_id);
            sourceKeyToNodes.set(sk, list);
          }
        }
      }
    }

    // 5. Build REAL edges
    // 5a. Direct claim_v2_semantics object.ref.id links
    const relRows = this.db
      .query(
        `SELECT s.subject_id,
                s.predicate,
                json_extract(s.payload, '$.object.ref.id') AS target_id
         FROM claim_v2_semantics s
         JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
         WHERE s.object_kind = 'subject'
           AND json_extract(s.payload, '$.object.ref.id') IS NOT NULL
         LIMIT 2000`
      )
      .all() as Array<{ subject_id: string; predicate: string; target_id: string }>;

    for (const rel of relRows) {
      const src = subjectToNodeId.get(rel.subject_id);
      const dst = subjectToNodeId.get(rel.target_id);
      if (src && dst && src !== dst) {
        addEdge(src, dst, rel.predicate || "relates_to", 2);
      }
    }

    // 5b. Connector provenance edges
    for (const [nodeId, connectors] of wcConnectors.entries()) {
      for (const cid of connectors) {
        addEdge(nodeId, `connector:${cid}`, "ingested_from", 1);
      }
    }
    for (const [nodeId, connectors] of semConnectors.entries()) {
      for (const cid of connectors) {
        addEdge(nodeId, `connector:${cid}`, "ingested_from", 1);
      }
    }

    // 5c. MemT domain cluster edges + keyword bridge to world nodes + connector tie-in
    for (const [domain, ids] of domainGroups.entries()) {
      for (let i = 1; i < ids.length; i++) {
        addEdge(ids[0], ids[i], `domain:${domain}`, 2);
      }
      const primaryConnector =
        domain.includes("codex")
          ? "connector:kizuki.codex-sessions"
          : "connector:kizuki.claude-code-sessions";
      if (nodeMap.has(primaryConnector) && ids[0]) {
        addEdge(ids[0], primaryConnector, "verified_from", 1);
      }
    }

    // 5d. Semantic keyword overlap bridges (connect MemT <-> world nodes, and sparse world <-> world nodes)
    const worldIds = Array.from(nodeMap.values())
      .filter((n) => n.kind !== "connector" && n.kind !== "memt")
      .map((n) => n.id);

    for (const exp of memtExperiences) {
      if (!nodeMap.has(exp.id)) continue;
      const kwA = nodeKeywords.get(exp.id);
      if (!kwA || kwA.size === 0) continue;
      const scored: Array<{ id: string; overlap: number }> = [];
      for (const wid of worldIds) {
        const kwB = nodeKeywords.get(wid);
        if (!kwB) continue;
        let overlap = 0;
        for (const k of kwA) {
          if (kwB.has(k)) overlap++;
        }
        if (overlap >= 2) scored.push({ id: wid, overlap });
      }
      scored.sort((a, b) => b.overlap - a.overlap);
      for (const match of scored.slice(0, 3)) {
        addEdge(exp.id, match.id, "informs", match.overlap);
      }
    }

    // Connect world nodes that share at least 2 domain keywords (capped to top 2 per node for readability)
    for (let i = 0; i < worldIds.length; i++) {
      const idA = worldIds[i];
      const kwA = nodeKeywords.get(idA);
      if (!kwA || kwA.size < 2) continue;
      const best: Array<{ id: string; overlap: number }> = [];
      for (let j = i + 1; j < worldIds.length; j++) {
        const idB = worldIds[j];
        const kwB = nodeKeywords.get(idB);
        if (!kwB) continue;
        let overlap = 0;
        for (const k of kwA) {
          if (kwB.has(k)) overlap++;
        }
        if (overlap >= 2) best.push({ id: idB, overlap });
      }
      best.sort((a, b) => b.overlap - a.overlap);
      for (const m of best.slice(0, 2)) {
        addEdge(idA, m.id, "related_topic", m.overlap);
      }
    }

    // Also link connector hubs lightly if nodes share connectors (already done via ingested_from),
    // and ensure any isolated non-connector node with 0 edges connects to its primary source connector or nearest sibling
    const degreeCount = new Map<string, number>();
    for (const e of edgeMap.values()) {
      degreeCount.set(e.source, (degreeCount.get(e.source) || 0) + 1);
      degreeCount.set(e.target, (degreeCount.get(e.target) || 0) + 1);
    }

    // Co-sourced fallback for any zero-degree node
    for (const [, list] of sourceKeyToNodes.entries()) {
      if (list.length < 2) continue;
      const anchor = list[0];
      for (let i = 1; i < Math.min(list.length, 6); i++) {
        if ((degreeCount.get(list[i]) || 0) === 0) {
          addEdge(anchor, list[i], "co_sourced", 1);
          degreeCount.set(anchor, (degreeCount.get(anchor) || 0) + 1);
          degreeCount.set(list[i], (degreeCount.get(list[i]) || 0) + 1);
        }
      }
    }

    // Recompute final exact degrees
    const finalDegree = new Map<string, number>();
    const edges = Array.from(edgeMap.values());
    for (const e of edges) {
      finalDegree.set(e.source, (finalDegree.get(e.source) || 0) + 1);
      finalDegree.set(e.target, (finalDegree.get(e.target) || 0) + 1);
    }

    let consolidatedCount = 0;
    let memtCount = 0;
    const nodes = Array.from(nodeMap.values()).map((n) => {
      const deg = finalDegree.get(n.id) || 0;
      if (n.consolidated && n.source_kind === "world_consolidation") consolidatedCount++;
      if (n.kind === "memt") memtCount++;
      return { ...n, degree: deg };
    });

    return {
      nodes,
      edges,
      stats: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        consolidated_count: consolidatedCount,
        memt_count: memtCount,
      },
    };
  }

  async getGraph(opts: { limit?: number; kind?: string; q?: string } = {}): Promise<GraphResponse> {
    const limit = Math.max(20, Math.min(400, Number(opts.limit || 180) || 180));
    const kind = (opts.kind || "all").trim().toLowerCase();
    const q = (opts.q || "").trim().toLowerCase();

    const cacheKey = `limit=${limit}`;
    const now = Date.now();
    let baseGraph: GraphResponse;
    if (this.graphCache && this.graphCache.expiresAt > now && this.graphCache.value.key === cacheKey) {
      baseGraph = this.graphCache.value.data;
    } else {
      baseGraph = await this.buildFullGraph(limit);
      this.graphCache = { value: { key: cacheKey, data: baseGraph }, expiresAt: now + 5_000 };
    }

    if ((kind === "all" || kind === "") && !q) {
      return baseGraph;
    }

    const filteredNodes = baseGraph.nodes.filter((n) => {
      if (kind && kind !== "all") {
        if (kind === "consolidated") {
          if (!n.consolidated || n.source_kind !== "world_consolidation") return false;
        } else if (n.kind.toLowerCase() !== kind) {
          return false;
        }
      }
      if (q) {
        const hay = `${n.label} ${n.summary} ${n.group} ${n.kind} ${n.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const keepIds = new Set(filteredNodes.map((n) => n.id));
    const filteredEdges = baseGraph.edges.filter((e) => keepIds.has(e.source) && keepIds.has(e.target));

    const deg = new Map<string, number>();
    for (const e of filteredEdges) {
      deg.set(e.source, (deg.get(e.source) || 0) + 1);
      deg.set(e.target, (deg.get(e.target) || 0) + 1);
    }

    let consolidatedCount = 0;
    let memtCount = 0;
    const nodesWithDeg = filteredNodes.map((n) => {
      if (n.consolidated && n.source_kind === "world_consolidation") consolidatedCount++;
      if (n.kind === "memt") memtCount++;
      return { ...n, degree: deg.get(n.id) || 0 };
    });

    return {
      nodes: nodesWithDeg,
      edges: filteredEdges,
      stats: {
        total_nodes: nodesWithDeg.length,
        total_edges: filteredEdges.length,
        consolidated_count: consolidatedCount,
        memt_count: memtCount,
      },
    };
  }

  private async getGraphNeighborsForNode(id: string): Promise<NodeNeighbor[]> {
    try {
      const graph = this.graphCache ? this.graphCache.value.data : await this.getGraph({ limit: 180 });
      const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
      const neighbors: NodeNeighbor[] = [];
      const seen = new Set<string>();
      for (const e of graph.edges) {
        const otherId = e.source === id ? e.target : e.target === id ? e.source : null;
        if (!otherId || seen.has(otherId)) continue;
        const other = nodeById.get(otherId);
        if (!other) continue;
        seen.add(otherId);
        neighbors.push({
          id: other.id,
          label: other.label,
          kind: other.kind,
          predicate: e.predicate,
        });
      }
      return neighbors.slice(0, 24);
    } catch {
      return [];
    }
  }

  async getNodeDetail(id: string): Promise<NodeDetailResponse | null> {
    const cleanId = id.trim();
    if (!cleanId) return null;

    // Case 1: MemT experience node
    if (cleanId.startsWith("exp_")) {
      const experiences = await this.getMemtExperiences(100);
      const exp = experiences.find((e) => e.id === cleanId);
      if (!exp) return null;
      const neighbors = await this.getGraphNeighborsForNode(cleanId);
      const claims: NodeClaimDetail[] = [
        {
          claim_id: `${exp.id}:condition`,
          predicate: "memt.condition",
          text: cleanText(exp.condition, 500),
          confidence: Number(exp.confidence ?? 0.9),
          created_at: exp.created_at || new Date().toISOString(),
          authority: "memt_verified",
        },
        {
          claim_id: `${exp.id}:recommendation`,
          predicate: "memt.recommendation",
          text: cleanText(exp.recommendation, 700),
          confidence: Number(exp.confidence ?? 0.9),
          created_at: exp.updated_at || exp.created_at || new Date().toISOString(),
          authority: "memt_verified",
        },
      ];
      if (exp.verification) {
        claims.push({
          claim_id: `${exp.id}:verification`,
          predicate: "memt.verification",
          text: cleanText(exp.verification, 500),
          confidence: Number(exp.confidence ?? 0.9),
          created_at: exp.updated_at || exp.created_at || new Date().toISOString(),
          authority: "memt_verified",
        });
      }
      const relatedDocs = await this.findRelatedDocs(`${exp.domain} ${exp.condition} ${exp.recommendation}`, undefined, 6);
      return {
        id: exp.id,
        label: `${exp.domain}: ${cleanText(exp.condition, 64)}`,
        kind: "memt",
        consolidated: exp.outcome === "verified",
        summary: cleanText(exp.recommendation, 800),
        confidence: Number(exp.confidence ?? 0.9),
        updated_at: exp.updated_at || exp.created_at || null,
        claims,
        neighbors,
        related_docs: relatedDocs,
        memt_experience: exp,
      };
    }

    // Case 2: Connector hub node
    if (cleanId.startsWith("connector:")) {
      const connectorId = cleanId.slice("connector:".length);
      const row = this.db
        .query(
          `SELECT connector_id, COUNT(*) AS count, MAX(occurred_at) AS latest
           FROM events
           WHERE deleted = 0 AND connector_id = ?
           GROUP BY connector_id`
        )
        .get(connectorId) as { connector_id: string; count: number; latest: string | null } | null;

      if (!row) return null;

      const recentEvents = this.db
        .query(
          `SELECT event_id, kind, occurred_at, substr(text, 1, 260) AS snippet
           FROM events
           WHERE deleted = 0 AND connector_id = ?
           ORDER BY occurred_at DESC
           LIMIT 12`
        )
        .all(connectorId) as Array<{
          event_id: string;
          kind: string;
          occurred_at: string;
          snippet: string;
        }>;

      const [neighbors, relatedDocs] = await Promise.all([
        this.getGraphNeighborsForNode(cleanId),
        this.findRelatedDocs(`${connectorId} ${connectorLabel(connectorId)}`, undefined, 6),
      ]);
      return {
        id: cleanId,
        label: connectorLabel(connectorId),
        kind: "connector",
        consolidated: true,
        summary: `Enrolled connector ${connectorId} with ${Number(row.count).toLocaleString("en-US")} non-deleted events. Latest capture: ${row.latest || "unknown"}.`,
        confidence: 1,
        updated_at: row.latest || null,
        claims: recentEvents.map((e) => ({
          claim_id: e.event_id,
          predicate: `event.${e.kind}`,
          text: cleanText(e.snippet, 300),
          confidence: 1,
          created_at: e.occurred_at,
          authority: "connector_evidence",
        })),
        neighbors,
        related_docs: relatedDocs,
      };
    }

    // Case 3: world_consolidation handle_id
    const wc = this.db
      .query(
        `SELECT basis_digest, handle_id, kind, status, summary, created_at, completed_at
         FROM world_consolidation
         WHERE handle_id = ?
         ORDER BY CASE WHEN status = 'complete' THEN 0 ELSE 1 END, COALESCE(completed_at, created_at) DESC
         LIMIT 1`
      )
      .get(cleanId) as {
        basis_digest: string;
        handle_id: string;
        kind: string;
        status: string;
        summary: string | null;
        created_at: string;
        completed_at: string | null;
      } | null;

    if (wc) {
      const claimRows = this.db
        .query(
          `SELECT c.claim_id,
                  COALESCE(s.predicate, c.predicate, c.kind) AS predicate,
                  COALESCE(json_extract(s.payload, '$.object.value'), json_extract(s.payload, '$.object.ref.id'), c.body) AS text_val,
                  c.confidence,
                  c.created_at,
                  c.authority,
                  c.target,
                  c.subject
           FROM world_consolidation_basis wcb
           JOIN claims c ON c.claim_id = wcb.claim_id
           LEFT JOIN claim_v2_semantics s ON s.claim_id = c.claim_id
           WHERE wcb.basis_digest = ?
           ORDER BY c.created_at DESC
           LIMIT 40`
        )
        .all(wc.basis_digest) as Array<{
          claim_id: string;
          predicate: string;
          text_val: string | null;
          confidence: number;
          created_at: string;
          authority: string;
          target: string | null;
          subject: string | null;
        }>;

      let label = "";
      for (const c of claimRows) {
        if (
          ["concept.label", "situation.label", "identity.display_name", "artifact.label"].includes(c.predicate) &&
          c.text_val &&
          !isLikelyHexHash(c.text_val)
        ) {
          label = cleanText(c.text_val, 80);
          break;
        }
      }
      if (!label) {
        label = extractLabelFromSummary(wc.summary, wc.handle_id);
      }

      const avgConf =
        claimRows.length > 0
          ? claimRows.reduce((s, r) => s + Number(r.confidence || 0.7), 0) / claimRows.length
          : 0.78;

      const [neighbors, relatedDocs] = await Promise.all([
        this.getGraphNeighborsForNode(wc.handle_id),
        this.findRelatedDocs(`${label} ${wc.handle_id} ${wc.summary || ""}`, undefined, 6),
      ]);
      return {
        id: wc.handle_id,
        label,
        kind: normalizeKind(wc.kind, "concept"),
        consolidated: wc.status === "complete",
        summary: cleanText(wc.summary || `${label} (${wc.kind})`, 1200),
        confidence: Number(avgConf.toFixed(2)),
        updated_at: wc.completed_at || wc.created_at,
        claims: claimRows.map((c) => ({
          claim_id: c.claim_id,
          predicate: c.predicate || "claim",
          text: cleanText(c.text_val, 420),
          confidence: Number(c.confidence ?? 0.5),
          created_at: c.created_at,
          authority: c.authority || "model_inference",
        })),
        neighbors,
        related_docs: relatedDocs,
      };
    }

    // Case 4: claim_v2_semantics subject_id
    const semClaims = this.db
      .query(
        `SELECT c.claim_id,
                s.predicate,
                COALESCE(json_extract(s.payload, '$.object.value'), json_extract(s.payload, '$.object.ref.id'), c.body) AS text_val,
                c.confidence,
                c.created_at,
                c.authority
         FROM claim_v2_semantics s
         JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
         WHERE s.subject_id = ?
         ORDER BY c.created_at DESC
         LIMIT 40`
      )
      .all(cleanId) as Array<{
        claim_id: string;
        predicate: string;
        text_val: string | null;
        confidence: number;
        created_at: string;
        authority: string;
      }>;

    if (semClaims.length > 0) {
      let label = "";
      let worldKind = "";
      let summary = "";
      for (const c of semClaims) {
        if (!label && ["situation.label", "concept.label", "identity.display_name", "artifact.label"].includes(c.predicate) && c.text_val) {
          label = cleanText(c.text_val, 80);
        }
        if (!worldKind && c.predicate === "world.kind" && c.text_val) {
          worldKind = c.text_val;
        }
        if (!summary && ["concept.definition", "situation.objective", "situation.blocker", "situation.commitment"].includes(c.predicate) && c.text_val) {
          summary = cleanText(c.text_val, 600);
        }
      }
      if (!label) label = `Entity ${cleanId.slice(0, 8)}`;
      if (!summary) summary = cleanText(semClaims[0].text_val || label, 500);
      const avgConf = semClaims.reduce((s, r) => s + Number(r.confidence || 0.5), 0) / semClaims.length;
      const [neighbors, relatedDocs] = await Promise.all([
        this.getGraphNeighborsForNode(cleanId),
        this.findRelatedDocs(`${label} ${cleanId} ${summary}`, undefined, 6),
      ]);

      return {
        id: cleanId,
        label,
        kind: normalizeKind(worldKind, "situation"),
        consolidated: false,
        summary,
        confidence: Number(avgConf.toFixed(2)),
        updated_at: semClaims[0].created_at || null,
        claims: semClaims.map((c) => ({
          claim_id: c.claim_id,
          predicate: c.predicate || "claim",
          text: cleanText(c.text_val, 420),
          confidence: Number(c.confidence ?? 0.5),
          created_at: c.created_at,
          authority: c.authority || "model_inference",
        })),
        neighbors,
        related_docs: relatedDocs,
      };
    }

    return null;
  }

  async search(rawQuery: string): Promise<SearchResponse> {
    const t0 = performance.now();
    const query = rawQuery.trim();
    if (!query) {
      return {
        query: "",
        ms: 0,
        memt_hits: [],
        world_hits: [],
        claim_hits: [],
        event_hits: [],
      };
    }

    const like = `%${query}%`;

    const memtPromise = execCommand(
      [
        this.kizukiBin,
        "memt",
        "experience",
        "search",
        query,
        "--vault",
        this.vaultPath,
        "--limit",
        "8",
        "--json",
      ],
      5000
    ).then((res) => {
      if (!res.ok) return [];
      try {
        const parsed = JSON.parse(res.stdout) as {
          data?: { hits?: Array<{ experience: MemtExperience; score?: number }> };
        };
        return (parsed.data?.hits || []).map((h) => ({
          id: h.experience.id,
          domain: h.experience.domain,
          condition: cleanText(h.experience.condition, 240),
          recommendation: cleanText(h.experience.recommendation, 360),
          verification: h.experience.verification ? cleanText(h.experience.verification, 200) : undefined,
          outcome: h.experience.outcome,
          confidence: Number(h.experience.confidence ?? 0.9),
          score: h.score,
        }));
      } catch {
        return [];
      }
    });

    // World consolidation hits (matching summary or basis label)
    const worldRows = this.db
      .query(
        `SELECT wc.handle_id,
                wc.kind,
                wc.status,
                wc.summary,
                COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                         THEN json_extract(s.payload, '$.object.value') END) AS sem_label
         FROM world_consolidation wc
         LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
         LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
         GROUP BY wc.basis_digest
         HAVING wc.summary LIKE ? OR sem_label LIKE ?
         ORDER BY CASE WHEN wc.status = 'complete' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT 15`
      )
      .all(like, like) as Array<{
        handle_id: string;
        kind: string;
        status: string;
        summary: string | null;
        updated_at: string | null;
        sem_label: string | null;
      }>;

    const world_hits = worldRows.map((r) => ({
      id: r.handle_id,
      label:
        (r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanText(r.sem_label, 72) : "") ||
        extractLabelFromSummary(r.summary, r.handle_id),
      kind: normalizeKind(r.kind, "concept"),
      status: r.status,
      summary: cleanText(r.summary, 360),
      updated_at: r.updated_at || null,
    }));

    // Live claims hits (bounded fast scan via indexed created_at/status)
    const claimRows = this.db
      .query(
        `SELECT c.claim_id,
                c.kind,
                c.target,
                COALESCE(s.predicate, c.predicate) AS predicate,
                COALESCE(json_extract(s.payload, '$.object.value'), c.body) AS body_val,
                c.confidence,
                c.created_at
         FROM claims c
         LEFT JOIN claim_v2_semantics s ON s.claim_id = c.claim_id
         WHERE c.status = 'live'
           AND (c.body LIKE ? OR c.target LIKE ? OR c.subject LIKE ? OR s.payload LIKE ?)
         ORDER BY c.created_at DESC
         LIMIT 15`
      )
      .all(like, like, like, like) as Array<{
        claim_id: string;
        kind: string;
        target: string | null;
        predicate: string | null;
        body_val: string | null;
        confidence: number;
        created_at: string;
      }>;

    const claim_hits = claimRows.map((r) => ({
      claim_id: r.claim_id,
      kind: r.kind,
      target: r.target,
      predicate: r.predicate,
      text: cleanText(r.body_val, 300),
      confidence: Number(r.confidence ?? 0.5),
      created_at: r.created_at,
    }));

    // Events hits: bounded scan of recent 5000 events via events_occurred_idx (<25ms)
    const eventRows = this.db
      .query(
        `SELECT event_id, connector_id, kind, occurred_at, substr(text, 1, 320) AS snippet
         FROM (
           SELECT event_id, connector_id, kind, occurred_at, text
           FROM events
           WHERE deleted = 0
           ORDER BY occurred_at DESC
           LIMIT 5000
         )
         WHERE text LIKE ?
         LIMIT 15`
      )
      .all(like) as Array<{
        event_id: string;
        connector_id: string;
        kind: string;
        occurred_at: string;
        snippet: string;
      }>;

    const event_hits = eventRows.map((r) => ({
      event_id: r.event_id,
      connector_id: r.connector_id,
      kind: r.kind,
      occurred_at: r.occurred_at,
      snippet: cleanText(r.snippet, 280),
    }));

    const memt_hits = await memtPromise;
    const ms = Math.round((performance.now() - t0) * 10) / 10;

    return {
      query,
      ms,
      memt_hits,
      world_hits,
      claim_hits,
      event_hits,
    };
  }

  private hydrateAtlasPanelEntries(panelKey: string): Array<Record<string, unknown>> {
    const querySemantics = (predicates: string[], limit = 10) => {
      const placeholders = predicates.map(() => "?").join(",");
      return this.db
        .query(
          `SELECT s.subject_id,
                  s.predicate,
                  json_extract(s.payload, '$.object.value') AS val,
                  (SELECT json_extract(s2.payload, '$.object.value')
                   FROM claim_v2_semantics s2
                   WHERE s2.subject_id = s.subject_id
                     AND s2.predicate IN ('situation.label','concept.label','identity.display_name','artifact.label')
                   LIMIT 1) AS subject_label,
                  c.confidence,
                  c.created_at
           FROM claim_v2_semantics s
           JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
           WHERE s.predicate IN (${placeholders})
             AND json_extract(s.payload, '$.object.value') IS NOT NULL
             AND length(trim(json_extract(s.payload, '$.object.value'))) > 2
           ORDER BY c.created_at DESC
           LIMIT ?`
        )
        .all(...predicates, limit * 3) as Array<{
          subject_id: string;
          predicate: string;
          val: string;
          subject_label: string | null;
          confidence: number;
          created_at: string;
        }>;
    };

    if (panelKey === "resume") {
      const rows = querySemantics(["situation.objective", "project.status"], 12);
      const seen = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const text = cleanText(r.val, 260);
        const dedup = text.toLowerCase().slice(0, 64);
        if (!text || seen.has(dedup)) continue;
        seen.add(dedup);
        const title = r.subject_label && !isLikelyHexHash(r.subject_label)
          ? cleanText(r.subject_label, 84)
          : cleanText(text, 76);
        items.push({
          id: r.subject_id,
          title,
          summary: text,
          kind: "situation",
          predicate: r.predicate,
          confidence: Number((r.confidence ?? 0.7).toFixed(2)),
          updated_at: r.created_at,
          source: "vault-live",
        });
        if (items.length >= 10) break;
      }
      return items;
    }

    if (panelKey === "changed") {
      const rows = querySemantics(["situation.change", "outcome.reached", "decision.decided"], 12);
      const seen = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const text = cleanText(r.val, 260);
        const dedup = text.toLowerCase().slice(0, 64);
        if (!text || seen.has(dedup)) continue;
        seen.add(dedup);
        const title = r.subject_label && !isLikelyHexHash(r.subject_label)
          ? cleanText(r.subject_label, 84)
          : cleanText(text, 76);
        items.push({
          id: r.subject_id,
          title,
          summary: text,
          kind: "change",
          predicate: r.predicate,
          confidence: Number((r.confidence ?? 0.7).toFixed(2)),
          updated_at: r.created_at,
          source: "vault-live",
        });
        if (items.length >= 10) break;
      }
      return items;
    }

    if (panelKey === "people") {
      const rows = this.db
        .query(
          `SELECT s.subject_id,
                  json_extract(s.payload, '$.object.value') AS display_name,
                  MAX(CASE WHEN s2.predicate IN ('employment.role','employment.works_at','situation.participant')
                           THEN json_extract(s2.payload, '$.object.value') END) AS role_hint,
                  COUNT(DISTINCT s.claim_id) AS mentions,
                  MAX(c.created_at) AS updated_at,
                  AVG(c.confidence) AS avg_conf
           FROM claim_v2_semantics s
           JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
           LEFT JOIN claim_v2_semantics s2 ON s2.subject_id = s.subject_id
           WHERE s.predicate = 'identity.display_name'
             AND json_extract(s.payload, '$.object.value') IS NOT NULL
             AND length(trim(json_extract(s.payload, '$.object.value'))) > 1
           GROUP BY lower(trim(json_extract(s.payload, '$.object.value')))
           ORDER BY updated_at DESC, mentions DESC
           LIMIT 14`
        )
        .all() as Array<{
          subject_id: string;
          display_name: string;
          role_hint: string | null;
          mentions: number;
          updated_at: string;
          avg_conf: number | null;
        }>;

      return rows
        .filter((r) => r.display_name && !isLikelyHexHash(r.display_name))
        .slice(0, 12)
        .map((r) => ({
          id: r.subject_id,
          title: cleanText(r.display_name, 72),
          summary: r.role_hint
            ? cleanText(`${r.role_hint} (${r.mentions} live identity mentions)`, 220)
            : `Tracked identity across ${r.mentions} live vault claim${r.mentions === 1 ? "" : "s"}.`,
          kind: "person",
          predicate: "identity.display_name",
          mentions: Number(r.mentions || 1),
          confidence: Number((r.avg_conf ?? 0.72).toFixed(2)),
          updated_at: r.updated_at,
          source: "vault-live",
        }));
    }

    if (panelKey === "commitments") {
      const rows = querySemantics(["situation.commitment", "decision.decided"], 12);
      const seen = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const text = cleanText(r.val, 260);
        const dedup = text.toLowerCase().slice(0, 64);
        if (!text || seen.has(dedup)) continue;
        seen.add(dedup);
        const title = r.subject_label && !isLikelyHexHash(r.subject_label)
          ? cleanText(r.subject_label, 84)
          : cleanText(text, 76);
        items.push({
          id: r.subject_id,
          title,
          summary: text,
          kind: "commitment",
          predicate: r.predicate,
          confidence: Number((r.confidence ?? 0.75).toFixed(2)),
          updated_at: r.created_at,
          source: "vault-live",
        });
        if (items.length >= 10) break;
      }
      return items;
    }

    if (panelKey === "questions") {
      const rows = querySemantics(["situation.blocker", "concept.distinguished_from"], 12);
      const seen = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const text = cleanText(r.val, 260);
        const dedup = text.toLowerCase().slice(0, 64);
        if (!text || seen.has(dedup)) continue;
        seen.add(dedup);
        const title = r.subject_label && !isLikelyHexHash(r.subject_label)
          ? cleanText(r.subject_label, 84)
          : cleanText(text, 76);
        items.push({
          id: r.subject_id,
          title,
          summary: text,
          kind: "blocker",
          predicate: r.predicate,
          confidence: Number((r.confidence ?? 0.68).toFixed(2)),
          updated_at: r.created_at,
          source: "vault-live",
        });
        if (items.length >= 10) break;
      }
      return items;
    }

    if (panelKey === "corrections") {
      const rows = querySemantics(["decision.decided", "preference.prefers", "outcome.observation"], 12);
      const seen = new Set<string>();
      const items: Array<Record<string, unknown>> = [];
      for (const r of rows) {
        const text = cleanText(r.val, 260);
        const dedup = text.toLowerCase().slice(0, 64);
        if (!text || seen.has(dedup)) continue;
        seen.add(dedup);
        const title = r.subject_label && !isLikelyHexHash(r.subject_label)
          ? cleanText(r.subject_label, 84)
          : cleanText(text, 76);
        items.push({
          id: r.subject_id,
          title,
          summary: text,
          kind: "correction",
          predicate: r.predicate,
          confidence: Number((r.confidence ?? 0.78).toFixed(2)),
          updated_at: r.created_at,
          source: "vault-live",
        });
        if (items.length >= 10) break;
      }
      if (items.length > 0) return items;
    }

    // stale or unknown panel fallback
    const pendingRows = this.db
      .query(
        `SELECT handle_id, kind, summary, created_at
         FROM world_consolidation
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 10`
      )
      .all() as Array<{ handle_id: string; kind: string; summary: string | null; created_at: string }>;

    if (pendingRows.length > 0) {
      return pendingRows.map((r) => ({
        id: r.handle_id,
        title: extractLabelFromSummary(r.summary, r.handle_id),
        summary: cleanText(r.summary || `Pending world consolidation (${r.kind}) awaiting synthesis.`, 240),
        kind: normalizeKind(r.kind, "concept"),
        predicate: "world.pending_consolidation",
        confidence: 0.5,
        updated_at: r.created_at,
        source: "vault-live",
      }));
    }

    const recentCompleted = this.db
      .query(
        `SELECT handle_id, kind, summary, COALESCE(completed_at, created_at) AS ts
         FROM world_consolidation
         WHERE status = 'complete'
         ORDER BY ts DESC
         LIMIT 8`
      )
      .all() as Array<{ handle_id: string; kind: string; summary: string | null; ts: string }>;

    return recentCompleted.map((r) => ({
      id: r.handle_id,
      title: extractLabelFromSummary(r.summary, r.handle_id),
      summary: cleanText(r.summary || `Consolidated world item (${r.kind}).`, 240),
      kind: normalizeKind(r.kind, "concept"),
      predicate: "world.consolidated",
      confidence: 0.78,
      updated_at: r.ts,
      source: "vault-live",
    }));
  }

  private normalizeNativeAtlasEntry(entry: Record<string, unknown>): Record<string, unknown> {
    const rawTitle = typeof entry.title === "string" ? entry.title.trim() : "";
    const relations = Array.isArray(entry.relations) ? (entry.relations as Array<Record<string, unknown>>) : [];
    let derivedSummary = typeof entry.summary === "string" ? cleanText(entry.summary, 280) : "";
    let derivedPredicate = typeof entry.predicate === "string" ? entry.predicate : "";

    if (!derivedSummary && relations.length > 0) {
      const firstRel = relations[0];
      derivedPredicate = typeof firstRel.predicate === "string" ? firstRel.predicate : derivedPredicate;
      const obj = firstRel.object as { value?: unknown } | undefined;
      if (obj && typeof obj.value === "string") {
        derivedSummary = cleanText(obj.value, 280);
      }
    }

    const title =
      rawTitle && rawTitle.toLowerCase() !== "untitled"
        ? cleanText(rawTitle, 84)
        : derivedSummary
          ? cleanText(derivedSummary, 76)
          : "Vault World Item";

    const ref = entry.ref as { token?: string } | undefined;
    return {
      ...entry,
      id: typeof entry.id === "string" ? entry.id : ref?.token || undefined,
      title,
      summary: derivedSummary || title,
      predicate: derivedPredicate || (typeof entry.operation === "string" ? entry.operation : "world.relation"),
      source: typeof entry.source === "string" ? entry.source : "kizuki-atlas",
    };
  }

  async getAtlas(): Promise<AtlasResponse> {
    return this.atlasSnapshot.get();
  }

  private async buildAtlas(): Promise<AtlasResponse> {
    const highlightsRows = this.db
      .query(
        `SELECT wc.handle_id,
                wc.kind,
                wc.summary,
                wc.completed_at,
                MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                         THEN json_extract(s.payload, '$.object.value') END) AS sem_label,
                COUNT(DISTINCT wcb.claim_id) AS claim_count
         FROM world_consolidation wc
         LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
         LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
         WHERE wc.status = 'complete'
         GROUP BY wc.handle_id
         ORDER BY claim_count DESC, wc.completed_at DESC
         LIMIT 12`
      )
      .all() as Array<{
        handle_id: string;
        kind: string;
        summary: string | null;
        completed_at: string | null;
        sem_label: string | null;
        claim_count: number;
      }>;

    const consolidated_highlights = highlightsRows.map((r) => ({
      id: r.handle_id,
      label:
        (r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanText(r.sem_label, 72) : "") ||
        extractLabelFromSummary(r.summary, r.handle_id),
      kind: normalizeKind(r.kind, "concept"),
      summary: cleanText(r.summary, 420),
      completed_at: r.completed_at || null,
      claim_count: Number(r.claim_count || 1),
    }));

    const res = await execCommand(
      [this.kizukiBin, "world", "--operation", "atlas", "--vault", this.vaultPath, "--json"],
      8000
    );

    let cliStatus = "ok";
    let cliError: string | undefined;
    let rawPanels: Array<Record<string, unknown>> = [];

    if (res.ok) {
      try {
        const parsed = JSON.parse(res.stdout) as {
          status?: string;
          data?: {
            panels?: Array<Record<string, unknown>>;
            data?: {
              result?: {
                status?: string;
                data?: {
                  panels?: Array<Record<string, unknown>>;
                };
              };
            };
          };
          panels?: Array<Record<string, unknown>>;
        };
        rawPanels =
          parsed.data?.data?.result?.data?.panels ||
          parsed.data?.panels ||
          parsed.panels ||
          [];
        cliStatus = parsed.status || "ok";
      } catch (err) {
        cliStatus = "degraded";
        cliError = `Failed to parse atlas output: ${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      cliStatus = "degraded";
      cliError = cleanText(res.stderr || `kizuki world atlas exited with code ${res.exitCode}`, 240);
    }

    const canonicalOrder: Array<{ panel: string; title: string }> = [
      { panel: "resume", title: "Resume my work" },
      { panel: "changed", title: "What changed" },
      { panel: "people", title: "People" },
      { panel: "commitments", title: "Commitments" },
      { panel: "questions", title: "Questions & Blockers" },
      { panel: "stale", title: "Stale evidence" },
    ];

    const panelByKey = new Map<string, Record<string, unknown>>();
    for (const p of rawPanels) {
      const key = String(p.panel || "");
      if (key) panelByKey.set(key, p);
    }

    const hydratedPanels: Array<Record<string, unknown>> = [];
    for (const def of canonicalOrder) {
      const existing = panelByKey.get(def.panel);
      const rawEntries = Array.isArray(existing?.entries)
        ? (existing.entries as Array<Record<string, unknown>>)
        : [];

      if (rawEntries.length > 0) {
        hydratedPanels.push({
          ...existing,
          panel: def.panel,
          title: typeof existing?.title === "string" ? stripEmDashes(existing.title) : def.title,
          source: "kizuki-atlas",
          hydrated: false,
          entries: rawEntries.map((e) => this.normalizeNativeAtlasEntry(e)),
        });
      } else {
        let liveEntries: Array<Record<string, unknown>> = [];
        try {
          liveEntries = this.hydrateAtlasPanelEntries(def.panel);
        } catch {
          liveEntries = [];
        }
        hydratedPanels.push({
          ...(existing || {}),
          panel: def.panel,
          title: typeof existing?.title === "string" ? stripEmDashes(existing.title) : def.title,
          status: liveEntries.length > 0 ? "hydrated" : String(existing?.status || "empty"),
          source: "vault-live",
          hydrated: true,
          entries: liveEntries,
        });
      }
      panelByKey.delete(def.panel);
    }

    // Preserve and hydrate any extra CLI panels (e.g. corrections) so zero panels are ever empty
    for (const extra of panelByKey.values()) {
      const extraKey = String(extra.panel || "other");
      const rawEntries = Array.isArray(extra.entries)
        ? (extra.entries as Array<Record<string, unknown>>)
        : [];
      if (rawEntries.length > 0) {
        hydratedPanels.push({
          ...extra,
          source: "kizuki-atlas",
          hydrated: false,
          entries: rawEntries.map((e) => this.normalizeNativeAtlasEntry(e)),
        });
      } else {
        let liveEntries: Array<Record<string, unknown>> = [];
        try {
          liveEntries = this.hydrateAtlasPanelEntries(extraKey);
        } catch {
          liveEntries = [];
        }
        hydratedPanels.push({
          ...extra,
          status: liveEntries.length > 0 ? "hydrated" : String(extra.status || "empty"),
          source: "vault-live",
          hydrated: true,
          entries: liveEntries,
        });
      }
    }

    const result: AtlasResponse = {
      status: cliStatus,
      panels: hydratedPanels,
      consolidated_highlights,
      ...(cliError ? { error: cliError } : {}),
    };

    return result;
  }

  async getBrief(requestedName?: string): Promise<BriefResponse> {
    const dashDir = join(this.vaultPath, "dashboards");
    let entries: string[] = [];
    try {
      entries = await readdir(dashDir);
    } catch {
      return {
        latest: { name: null, markdown: "", updated_at: null },
        recent: [],
      };
    }

    const candidates = entries.filter((f) => isSafeBriefFilename(f));
    const withStats = await Promise.all(
      candidates.map(async (name) => {
        try {
          const st = await stat(join(dashDir, name));
          return { name, bytes: st.size, mtimeMs: st.mtimeMs, mtimeIso: st.mtime.toISOString() };
        } catch {
          return null;
        }
      })
    );

    const valid = withStats
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => {
        // Prefer lexicographically newest brief-YYYY-MM-DD.md, or newest mtime for executive-digest-latest.md
        if (a.name.startsWith("brief-") && b.name.startsWith("brief-")) {
          return b.name.localeCompare(a.name);
        }
        return b.mtimeMs - a.mtimeMs;
      });

    if (valid.length === 0) {
      return {
        latest: { name: null, markdown: "", updated_at: null },
        recent: [],
      };
    }

    let chosen = valid[0];
    if (requestedName && isSafeBriefFilename(basename(requestedName))) {
      const found = valid.find((v) => v.name === basename(requestedName));
      if (found) chosen = found;
    }

    let markdown = "";
    try {
      markdown = await readFile(join(dashDir, chosen.name), "utf8");
    } catch {
      markdown = "";
    }

    return {
      latest: {
        name: chosen.name,
        markdown,
        updated_at: chosen.mtimeIso,
      },
      recent: valid.slice(0, 20).map((v) => ({
        name: v.name,
        bytes: v.bytes,
      })),
    };
  }

  async interact(
    req: InteractRequest,
    extraContext?: {
      lines?: string[];
      citations?: Array<{ id: string; label: string; kind?: string }>;
    }
  ): Promise<Record<string, unknown>> {
    const mode = req.mode;
    const input = (req.input || "").trim();
    const dryRun = Boolean(req.dryRun);

    if (mode === "ask") {
      if (!input) {
        throw new BadRequestError("input is required for ask mode");
      }

      const wantsVaultSummary = VAULT_METRICS_QUERY_RE.test(input);

      const [searchRes, pinnedNode, contextDoc, matchedDocs, maybeOverview, maybeAgEntries, todayLive] = await Promise.all([
        this.search(input),
        req.nodeId ? this.getNodeDetail(req.nodeId) : Promise.resolve(null),
        req.contextDocPath
          ? this.readDoc(req.contextDocPath).catch((err) => {
              if (err instanceof ForbiddenError || err instanceof BadRequestError) {
                throw err;
              }
              return null;
            })
          : Promise.resolve(null),
        this.listDocs({ category: "all", q: input, limit: 4, offset: 0, sort: "recent" }).catch(() => null),
        wantsVaultSummary ? this.getOverview().catch(() => null) : Promise.resolve(null),
        wantsVaultSummary ? this.getAntigravityEntries().catch(() => []) : Promise.resolve([]),
        this.getToday({ includeNoise: false }).catch(() => null),
      ]);

      const personalContextLines: string[] = [];
      const evidenceLines: string[] = [];
      const evidenceRows: Array<{ source: string; label: string; detail: string }> = [];
      const citations: Array<{ id: string; label: string; kind: string }> = [];

      if (todayLive) {
        const nowDate = new Date();
        const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        const utcStamp = `${weekdays[nowDate.getUTCDay()]} ${months[nowDate.getUTCMonth()]} ${nowDate.getUTCDate()}, ${nowDate.getUTCFullYear()} ${nowDate.toISOString().slice(11, 16)} UTC`;

        personalContextLines.push(`Current date/time: ${utcStamp}`);
        personalContextLines.push(
          `Summary: events_total=${todayLive.summary.events_total.toLocaleString("en-US")}, docs_total=${todayLive.summary.docs_total.toLocaleString("en-US")}, people_total=${todayLive.summary.people_total}, open_actions=${todayLive.summary.open_actions}, priority_inbox=${todayLive.summary.priority_inbox_count}`
        );

        const upcoming = todayLive.schedule.slice(0, 6);
        if (upcoming.length > 0) {
          personalContextLines.push("Next upcoming Calendar events:");
          for (const ev of upcoming) {
            const partsStr = ev.participants.length > 0 ? ` | participants: ${ev.participants.slice(0, 4).join(", ")}` : "";
            const meetStr = ev.meet_url ? ` | meet: ${ev.meet_url}` : "";
            personalContextLines.push(
              `  - ${ev.start.slice(0, 16).replace("T", " ")} UTC (${ev.countdown}): ${ev.title} [${ev.calendar}]${partsStr}${meetStr}`
            );
          }
        } else {
          personalContextLines.push("Next upcoming Calendar events: none scheduled in the next 7 days.");
        }

        const openActions = todayLive.actions.filter((a) => !a.done);
        if (openActions.length > 0) {
          personalContextLines.push("Open Personal Actions:");
          for (const act of openActions) {
            personalContextLines.push(
              `  - [${act.tag}] ${act.title} (source=${act.source})${act.detail ? `: ${cleanText(act.detail, 140)}` : ""}`
            );
          }
        } else {
          personalContextLines.push("Open Personal Actions: none open.");
        }

        const topInbox = todayLive.inbox.slice(0, 6);
        if (topInbox.length > 0) {
          personalContextLines.push("Top Human Priority Inbox threads:");
          const nowMs = Date.now();
          for (const msg of topInbox) {
            const age = this.formatRelativeAge(msg.occurred_at, nowMs);
            personalContextLines.push(
              `  - [${msg.channel_label} | ${age}] ${msg.sender} (${msg.thread_title}): ${cleanText(msg.preview, 150)}`
            );
          }
        }

        if (todayLive.workstreams.length > 0) {
          personalContextLines.push("Active Workstreams:");
          for (const ws of todayLive.workstreams.slice(0, 6)) {
            personalContextLines.push(
              `  - ${ws.name} (${ws.domain}, ${ws.state}): ${cleanText(ws.context, 130)} | next: ${cleanText(ws.next_move, 100)}`
            );
          }
        }

        if (todayLive.owner_anchors.content) {
          const anchorBullets = todayLive.owner_anchors.content
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith("- "))
            .slice(0, 6);
          if (anchorBullets.length > 0) {
            personalContextLines.push("Owner Anchors summary:");
            for (const b of anchorBullets) {
              personalContextLines.push(`  ${cleanText(b, 160)}`);
            }
          }
        }

        const w = todayLive.whoop;
        const staleTag = w.is_stale
          ? w.age_days !== null
            ? `STALE (${w.age_days} days old, last synced ${w.date || "unknown"})`
            : "STALE (no recent sync)"
          : `fresh (${w.date || "today"})`;
        personalContextLines.push(`Whoop status: ${w.summary} [${staleTag}]`);

        citations.push({ id: "today:live", label: "Today Live Personal Context", kind: "today" });
      }

      let vaultOverview = maybeOverview;
      let agEntries = maybeAgEntries;

      if (
        !vaultOverview &&
        !contextDoc &&
        !pinnedNode &&
        searchRes.memt_hits.length === 0 &&
        searchRes.world_hits.length === 0 &&
        searchRes.claim_hits.length === 0
      ) {
        [vaultOverview, agEntries] = await Promise.all([
          this.getOverview().catch(() => null),
          this.getAntigravityEntries().catch(() => []),
        ]);
      }

      if (vaultOverview) {
        const v = vaultOverview.vault;
        const m = vaultOverview.memt;
        const agCount = agEntries.length;
        const pipelines = [
          ...v.connectors.map((c) => ({
            id: c.id,
            label: connectorLabel(c.id),
            count: c.count,
            latest: c.latest || "unknown",
          })),
          ...(agCount > 0
            ? [
                {
                  id: "antigravity-neon",
                  label: "Antigravity Neon",
                  count: agCount,
                  latest: agEntries[0]?.observed_at || "live",
                },
              ]
            : []),
        ].sort((a, b) => b.count - a.count);

        const totalPipelineEvents = pipelines.reduce((sum, p) => sum + p.count, 0);
        citations.push({ id: "vault:overview", label: "Live Vault Telemetry & Pipelines", kind: "vault" });
        evidenceLines.push(
          `[LIVE VAULT METRICS SUMMARY]: events_total=${v.events_total}, events_24h=${v.events_24h}, docs_total=${v.docs_total}, claims_live=${v.claims_live}, claims_24h=${v.claims_24h}, world_typed=${v.world_typed}, consolidation_complete=${v.consolidation_complete}, consolidation_pending=${v.consolidation_pending}, identity_links=${v.identity_links}, forecasts=${v.forecasts}, memt_verified=${m.verified}/${m.total} (mode=${m.mode}), daemon_version=${vaultOverview.daemon.version}, daemon_active=${vaultOverview.daemon.active}`
        );
        if (pipelines.length > 0) {
          evidenceLines.push(`[ACTIVE KIZUKI DATA PIPELINES (CONNECTORS ranked by volume)]:`);
          for (const p of pipelines.slice(0, 6)) {
            const share = totalPipelineEvents > 0 ? ((p.count / totalPipelineEvents) * 100).toFixed(1) : "0.0";
            evidenceLines.push(
              `  - ${p.label} (${p.id}): ${p.count.toLocaleString("en-US")} events (${share}% share), latest=${p.latest}`
            );
          }
        }
      }

      if (contextDoc) {
        citations.push({ id: contextDoc.path, label: contextDoc.title, kind: "doc" });
        const docBody = stripEmDashes(contextDoc.content).slice(0, 6000);
        evidenceLines.push(
          `[OPEN VAULT DOC ${contextDoc.path} | ${contextDoc.title} (${contextDoc.category})]:\n${docBody}`
        );
        evidenceRows.push({ source: "Open Doc", label: contextDoc.title, detail: cleanText(docBody, 160) });
      }

      if (pinnedNode) {
        citations.push({ id: pinnedNode.id, label: pinnedNode.label, kind: pinnedNode.kind });
        evidenceLines.push(
          `[PINNED NODE ${pinnedNode.id} | ${pinnedNode.label} (${pinnedNode.kind})]: ${pinnedNode.summary}`
        );
        evidenceRows.push({ source: pinnedNode.kind, label: pinnedNode.label, detail: pinnedNode.summary });
        for (const c of pinnedNode.claims.slice(0, 5)) {
          evidenceLines.push(`  - (${c.predicate}) ${c.text}`);
        }
      }

      const memtCap = contextDoc ? 3 : 5;
      const worldCap = contextDoc ? 3 : 6;
      const claimCap = contextDoc ? 3 : 6;

      for (const m of searchRes.memt_hits.slice(0, memtCap)) {
        const label = cleanCitationLabel(m.domain, m.condition);
        citations.push({ id: m.id, label, kind: "memt" });
        evidenceLines.push(
          `[MEMT ${m.id} | domain=${m.domain} | outcome=${m.outcome}]: Condition: ${m.condition} | Recommendation: ${m.recommendation}`
        );
        evidenceRows.push({ source: "MemT", label, detail: m.recommendation });
      }

      for (const w of searchRes.world_hits.slice(0, worldCap)) {
        citations.push({ id: w.id, label: w.label, kind: w.kind });
        evidenceLines.push(`[WORLD ${w.id} | ${w.label} (${w.kind})]: ${w.summary}`);
        evidenceRows.push({ source: `World (${w.kind})`, label: w.label, detail: w.summary });
      }

      for (const c of searchRes.claim_hits.slice(0, claimCap)) {
        const label = c.target || c.predicate || c.kind;
        citations.push({ id: c.claim_id, label, kind: "claim" });
        evidenceLines.push(`[CLAIM ${c.claim_id} | ${c.predicate || c.kind}]: ${c.text}`);
        evidenceRows.push({ source: "Claim", label, detail: c.text });
      }

      if (!contextDoc && matchedDocs && matchedDocs.items.length > 0) {
        for (const d of matchedDocs.items.slice(0, 3)) {
          citations.push({ id: d.path, label: d.title, kind: "doc" });
          evidenceLines.push(`[VAULT DOC ${d.path} | ${d.title} (${d.category})]: ${d.excerpt || d.title}`);
          evidenceRows.push({ source: "Vault Doc", label: d.title, detail: d.excerpt || d.path });
        }
      }

      const extraLines: string[] = Array.isArray(extraContext?.lines)
        ? extraContext.lines
            .map((line) => stripEmDashes(String(line ?? "")).trim())
            .filter((line) => line.length > 0)
        : [];

      if (Array.isArray(extraContext?.citations) && extraContext.citations.length > 0) {
        const seenCitationKeys = new Set(citations.map((c) => `${c.kind}:${c.id}`));
        for (const rawCit of extraContext.citations) {
          if (!rawCit || typeof rawCit !== "object") continue;
          const id = String(rawCit.id ?? "").trim();
          const label = stripEmDashes(String(rawCit.label ?? "")).trim();
          if (!id || !label) continue;
          const kind = String(rawCit.kind ?? "board").trim() || "board";
          const dedupeKey = `${kind}:${id}`;
          if (seenCitationKeys.has(dedupeKey)) continue;
          seenCitationKeys.add(dedupeKey);
          citations.push({ id, label, kind });
        }
      }

      const evidenceSummary = {
        personal_context_included: Boolean(todayLive),
        vault_metrics: vaultOverview
          ? {
              events_total: vaultOverview.vault.events_total,
              events_24h: vaultOverview.vault.events_24h,
              docs_total: vaultOverview.vault.docs_total,
              claims_live: vaultOverview.vault.claims_live,
              consolidation_complete: vaultOverview.vault.consolidation_complete,
              consolidation_pending: vaultOverview.vault.consolidation_pending,
              memt_verified: vaultOverview.memt.verified,
              memt_total: vaultOverview.memt.total,
              connectors: vaultOverview.vault.connectors,
            }
          : null,
        context_doc: contextDoc ? { path: contextDoc.path, title: contextDoc.title, category: contextDoc.category } : null,
        pinned_node: pinnedNode ? { id: pinnedNode.id, label: pinnedNode.label, kind: pinnedNode.kind } : null,
        memt_hits: searchRes.memt_hits.slice(0, 5),
        world_hits: searchRes.world_hits.slice(0, 6),
        claim_hits: searchRes.claim_hits.slice(0, 6),
        event_hits: searchRes.event_hits.slice(0, 4),
      };

      const sanitizedHistory: Array<{ role: "user" | "assistant"; content: string }> = Array.isArray(req.history)
        ? req.history
            .filter(
              (turn): turn is InteractHistoryTurn =>
                Boolean(turn) &&
                (turn.role === "user" || turn.role === "assistant") &&
                typeof turn.content === "string" &&
                turn.content.trim().length > 0
            )
            .slice(-6)
            .map((turn) => ({
              role: turn.role,
              content: stripEmDashes(turn.content.trim()).slice(0, 2000),
            }))
        : [];

      if (dryRun) {
        return {
          ok: true,
          mode: "ask",
          dryRun: true,
          synthesized: false,
          answer: null,
          citations,
          history_turns: sanitizedHistory.length,
          evidence: evidenceSummary,
        };
      }

      if (
        evidenceLines.length === 0 &&
        personalContextLines.length === 0 &&
        extraLines.length === 0 &&
        sanitizedHistory.length === 0
      ) {
        return {
          ok: true,
          mode: "ask",
          synthesized: false,
          answer: "No matching consolidated world concepts, claims, docs, or MemT experiences were found in the vault for this query.",
          citations: [],
          evidence: evidenceSummary,
        };
      }

      const systemPrompt = [
        "You are Kizuki Personal Mind OS's strictly grounded personal & vault analyst.",
        "Answer in crisp, coherent English using GitHub-Flavored Markdown:",
        "- Ground every claim, schedule item, action, message, and metric in BOTH [TODAY LIVE PERSONAL CONTEXT] and [KIZUKI VAULT / MEMT EVIDENCE] (plus any open document or conversation history).",
        "- For personal planning, priorities, meetings, replies, or daily status questions, lead directly with the user's real upcoming schedule, open personal actions, and human priority inbox from [TODAY LIVE PERSONAL CONTEXT].",
        "- Be honest about stale metrics (for example, note if Whoop data is stale with its sync date).",
        "- Use concise headings (`##` / `###`), tight bullet lists, and compact GFM tables with at most 4 concise columns (<= 4 columns so tables never overflow narrow drawers).",
        "- Cite specific node/doc/schedule titles inline in brackets like `[Title]` or `[path/to/doc.md]`.",
        "- Explicitly state any gaps in evidence rather than inventing facts.",
        "- NEVER use em-dashes anywhere in your response.",
      ].join("\n");

      const promptSections: string[] = [`Question: ${stripEmDashes(input)}`];
      if (personalContextLines.length > 0) {
        promptSections.push(`[TODAY LIVE PERSONAL CONTEXT]\n${personalContextLines.join("\n")}`);
      }
      if (evidenceLines.length > 0) {
        promptSections.push(`[KIZUKI VAULT / MEMT EVIDENCE]\n${evidenceLines.join("\n")}`);
      } else {
        promptSections.push(
          "[KIZUKI VAULT / MEMT EVIDENCE]\n(none matched directly; rely on [TODAY LIVE PERSONAL CONTEXT] and prior turns, and state any gaps.)"
        );
      }
      if (extraLines.length > 0) {
        promptSections.push(`[AGENT BOARD LIVE CONTEXT]\n${extraLines.join("\n")}`);
      }

      const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
        { role: "system", content: systemPrompt },
        ...sanitizedHistory,
        {
          role: "user",
          content: promptSections.join("\n\n"),
        },
      ];

      const synth = await this.synthesizeWithDualEngine({
        messages,
        promptForCoherence: input,
        primaryMaxTokens: 2048,
        primaryTemperature: 0.3,
        fallbackMaxTokens: 1800,
        fallbackTemperature: 0.25,
      });

      if (synth.ok) {
        return {
          ok: true,
          mode: "ask",
          synthesized: true,
          engine: synth.engine,
          model: synth.model,
          answer: synth.content,
          citations,
          evidence: evidenceSummary,
          usage: synth.usage,
        };
      }

      return {
        ok: true,
        mode: "ask",
        synthesized: false,
        engine: "Vault Fallback",
        fallback_reason: synth.reason,
        answer: buildStructuredVaultFallback({
          question: input,
          overview: vaultOverview,
          today: todayLive,
          antigravityCount: agEntries.length,
          citations,
          evidenceRows,
          reason: synth.reason,
        }),
        citations,
        evidence: evidenceSummary,
      };
    }

    if (mode === "tell") {
      if (!input) {
        throw new BadRequestError("input is required for tell mode");
      }
      if (input.length > 4000) {
        throw new BadRequestError("input must be at most 4000 characters");
      }

      const isClaimUlid = Boolean(req.nodeId && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(req.nodeId));
      if (dryRun) {
        return {
          ok: true,
          mode: "tell",
          dryRun: true,
          action: isClaimUlid ? "kizuki_tell_claim" : "owner_note_and_memt_anchor",
          receipt: null,
          summary: isClaimUlid
            ? `Would run kizuki tell against claim ${req.nodeId} with statement.`
            : `Would persist owner note to owner-notes.md and record a verified MemT owner-anchor experience.`,
        };
      }

      if (isClaimUlid && req.nodeId) {
        const tellRes = await execCommand(
          [
            this.kizukiBin,
            "tell",
            input,
            "--claim",
            req.nodeId,
            "--vault",
            this.vaultPath,
            "--json",
          ],
          10_000
        );
        if (tellRes.ok) {
          this.invalidateCaches();
          let parsed: unknown = tellRes.stdout.trim();
          try {
            parsed = JSON.parse(tellRes.stdout);
          } catch {
            // keep text
          }
          return {
            ok: true,
            mode: "tell",
            action: "kizuki_tell_claim",
            receipt: parsed,
            summary: `Updated claim ${req.nodeId} via kizuki tell.`,
          };
        }
      }

      // Persist structured owner note + verified MemT owner-anchor so it is immediately searchable
      const ts = new Date().toISOString();
      const notePath = join(this.vaultPath, "owner-notes.md");
      const targetTag = req.nodeId ? ` [node:${req.nodeId}]` : "";
      const noteEntry = `\n## ${ts}${targetTag}\n- ${stripEmDashes(input)}\n`;
      await appendFile(notePath, noteEntry, { encoding: "utf8", mode: 0o600 });

      const condText = cleanText(
        req.condition ||
          (req.nodeId ? `Owner note anchored to ${req.nodeId}` : `Owner anchor recorded at ${ts.slice(0, 10)}`),
        220
      );
      const memtRes = await execCommand(
        [
          this.kizukiBin,
          "memt",
          "experience",
          "add",
          "--vault",
          this.vaultPath,
          "--domain",
          req.domain?.trim() || "owner-anchor",
          "--sensitivity",
          "work",
          "--outcome",
          "verified",
          "--confidence",
          "0.92",
          "--condition",
          condText,
          "--recommendation",
          stripEmDashes(input),
          "--verification",
          cleanText(req.verification || `Recorded in owner-notes.md at ${ts}`, 220),
          "--json",
        ],
        8000
      );

      let memtReceipt: unknown = null;
      if (memtRes.ok) {
        try {
          memtReceipt = JSON.parse(memtRes.stdout);
        } catch {
          memtReceipt = memtRes.stdout.trim();
        }
      }

      this.invalidateCaches();
      return {
        ok: true,
        mode: "tell",
        action: "owner_note_and_memt_anchor",
        receipt: {
          owner_notes_path: notePath,
          recorded_at: ts,
          memt: memtReceipt,
        },
        summary: `Persisted owner note to owner-notes.md and recorded verified MemT owner-anchor.`,
      };
    }

    if (mode === "memt") {
      const domain = (req.domain || "general").trim() || "general";
      const condition = (req.condition || input).trim();
      const recommendation = (req.recommendation || input).trim();
      const verification = (req.verification || "Recorded via Kizuki Mind Explorer").trim();

      if (!condition || !recommendation) {
        throw new BadRequestError("condition and recommendation (or input) are required for memt mode");
      }

      if (dryRun) {
        return {
          ok: true,
          mode: "memt",
          dryRun: true,
          action: "memt_experience_add",
          draft: {
            domain,
            sensitivity: "work",
            outcome: "verified",
            confidence: 0.92,
            condition,
            recommendation,
            verification,
          },
        };
      }

      const res = await execCommand(
        [
          this.kizukiBin,
          "memt",
          "experience",
          "add",
          "--vault",
          this.vaultPath,
          "--domain",
          domain,
          "--sensitivity",
          "work",
          "--outcome",
          "verified",
          "--confidence",
          "0.92",
          "--condition",
          stripEmDashes(condition),
          "--recommendation",
          stripEmDashes(recommendation),
          "--verification",
          stripEmDashes(verification),
          "--json",
        ],
        8000
      );

      if (!res.ok) {
        throw new Error(cleanText(res.stderr || res.stdout || "kizuki memt experience add failed", 300));
      }

      this.invalidateCaches();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(res.stdout) as Record<string, unknown>;
      } catch {
        parsed = { raw: res.stdout.trim() };
      }
      return {
        ok: true,
        mode: "memt",
        action: "memt_experience_add",
        receipt: parsed,
        summary: `Added verified MemT experience in domain "${domain}".`,
      };
    }

    if (mode === "reflex") {
      if (!input) {
        throw new BadRequestError("input is required for reflex mode");
      }

      const rawStatements = input
        .split(/\r?\n|;+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, 5);

      const assumptions = rawStatements.map((statement, idx) => ({
        id: `a${idx + 1}`,
        statement: stripEmDashes(statement).slice(0, 400),
        importance: "normal" as const,
      }));

      const searchHits = await this.search(rawStatements[0]);
      let eventIds = searchHits.event_hits.map((e) => e.event_id).slice(0, 8);
      if (eventIds.length === 0) {
        const fallbackEvents = this.db
          .query(`SELECT event_id FROM events WHERE deleted = 0 ORDER BY occurred_at DESC LIMIT 5`)
          .all() as Array<{ event_id: string }>;
        eventIds = fallbackEvents.map((e) => e.event_id);
      }

      const requestPayload = {
        assumptions,
        event_ids: eventIds,
      };

      if (dryRun) {
        return {
          ok: true,
          mode: "reflex",
          dryRun: true,
          request_preview: requestPayload,
        };
      }

      const tmpDir = "/tmp/kizuki-mind-explorer-reflex";
      await mkdir(tmpDir, { recursive: true, mode: 0o700 });
      const tmpPath = join(tmpDir, `reflex-${randomUUID()}.json`);
      try {
        await writeFile(tmpPath, JSON.stringify(requestPayload), { encoding: "utf8", mode: 0o600 });
        const res = await execCommand(
          [
            this.kizukiBin,
            "reflex",
            "--request",
            tmpPath,
            "--format",
            "json",
            "--vault",
            this.vaultPath,
          ],
          20_000
        );

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(res.stdout) as Record<string, unknown>;
        } catch {
          parsed = { raw: cleanText(res.stdout || res.stderr, 800), exitCode: res.exitCode };
        }

        const hasReflexEnvelope = Boolean(parsed && parsed.schema === "kizuki.reflex/v1");
        return {
          ok: res.ok || hasReflexEnvelope,
          mode: "reflex",
          reflex_status: parsed?.status || (res.ok ? "ok" : "error"),
          result: parsed,
          event_ids_checked: eventIds,
        };
      } finally {
        await unlink(tmpPath).catch(() => {});
      }
    }

    throw new BadRequestError(`Unsupported interact mode: ${String(mode)}`);
  }

  private async buildDocIndex(): Promise<DocIndexSnapshot> {
    const roots: Array<{ root: string; prefix: string; forcedCategory: string | null }> = [
      { root: resolve(this.vaultPath), prefix: "", forcedCategory: null },
      { root: resolve(join(this.bridgesDir, "mac-obsidian")), prefix: "obsidian/", forcedCategory: "obsidian" },
      { root: resolve(join(this.bridgesDir, "mac-notes")), prefix: "apple-notes/", forcedCategory: "apple-notes" },
      { root: resolve(join(this.bridgesDir, "wispr-flow", "meetings")), prefix: "wispr-flow/", forcedCategory: "wispr-flow" },
    ];

    const discovered: Array<{ fullPath: string; root: string; prefix: string; forcedCategory: string | null }> = [];

    const walkRoot = async (spec: { root: string; prefix: string; forcedCategory: string | null }): Promise<void> => {
      const rootReal = await realpath(spec.root).catch(() => null);
      if (!rootReal) return;

      const walk = async (dir: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        const subdirs: string[] = [];
        for (const e of entries) {
          if (
            e.name === ".kizuki" ||
            e.name === ".git" ||
            e.name === ".obsidian" ||
            e.name === ".trash" ||
            e.name.startsWith(".env")
          ) {
            continue;
          }
          const full = join(dir, e.name);
          if (e.isDirectory()) {
            subdirs.push(full);
          } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
            discovered.push({
              fullPath: full,
              root: rootReal,
              prefix: spec.prefix,
              forcedCategory: spec.forcedCategory,
            });
          }
        }
        if (subdirs.length > 0) {
          await Promise.all(subdirs.map(walk));
        }
      };

      await walk(rootReal);
    };

    await Promise.all(roots.map(walkRoot));

    const prevByPath = this.docIndexCache?.value.byPath;
    const entries: IndexedDoc[] = [];
    const byPath = new Map<string, IndexedDoc>();
    const counts = new Map<string, number>();

    const BATCH = 256;
    for (let i = 0; i < discovered.length; i += BATCH) {
      const slice = discovered.slice(i, i + BATCH);
      const results = await Promise.all(
        slice.map(async (itemSpec) => {
          try {
            const st = await stat(itemSpec.fullPath);
            if (!st.isFile()) return null;
            const relFromRoot = relative(itemSpec.root, itemSpec.fullPath).replace(/\\/g, "/");
            if (!relFromRoot || relFromRoot.startsWith("..") || SECRET_PATH_RE.test(relFromRoot)) {
              return null;
            }
            const virtualPath = `${itemSpec.prefix}${relFromRoot}`;
            if (SECRET_PATH_RE.test(virtualPath)) return null;
            const prev = prevByPath?.get(virtualPath);
            const name = basename(relFromRoot);
            const category = itemSpec.forcedCategory || classifyDocCategory(virtualPath);
            const unchanged =
              prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size && prev.fullPath === itemSpec.fullPath;
            const item: IndexedDoc = unchanged
              ? prev
              : {
                  path: virtualPath,
                  fullPath: itemSpec.fullPath,
                  name,
                  title: slugToTitle(name),
                  category,
                  mtimeMs: st.mtimeMs,
                  size: st.size,
                };
            return item;
          } catch {
            return null;
          }
        })
      );

      for (const item of results) {
        if (!item) continue;
        if (byPath.has(item.path)) continue;
        entries.push(item);
        byPath.set(item.path, item);
        counts.set(item.category, (counts.get(item.category) || 0) + 1);
      }
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const categories: DocCategorySummary[] = DOC_CATEGORY_DEFS.map((def) => ({
      key: def.key,
      label: def.label,
      count: counts.get(def.key) || 0,
      dir: def.dir,
    }));

    return {
      entries,
      byPath,
      categories,
      builtAt: Date.now(),
    };
  }

  private async getDocIndex(): Promise<DocIndexSnapshot> {
    const now = Date.now();
    if (this.docIndexCache && this.docIndexCache.expiresAt > now) {
      return this.docIndexCache.value;
    }
    if (this.docIndexInFlight) {
      return this.docIndexInFlight;
    }
    this.docIndexInFlight = this.buildDocIndex()
      .then((snap) => {
        this.docIndexCache = { value: snap, expiresAt: Date.now() + 60_000 };
        return snap;
      })
      .finally(() => {
        this.docIndexInFlight = null;
      });
    return this.docIndexInFlight;
  }

  private async hydrateDocHeads(docs: IndexedDoc[]): Promise<void> {
    const missing = docs.filter((d) => !d.headLoaded);
    if (missing.length === 0) return;

    const BATCH = 64;
    for (let i = 0; i < missing.length; i += BATCH) {
      const slice = missing.slice(i, i + BATCH);
      await Promise.all(
        slice.map(async (doc) => {
          try {
            const raw = await Bun.file(doc.fullPath).slice(0, 3072).text();
            const parsed = parseDocHead(raw, doc.name);
            doc.title = parsed.title;
            doc.excerpt = parsed.excerpt;
            doc.headLoaded = true;
          } catch {
            doc.headLoaded = true;
            doc.excerpt = doc.excerpt || "";
          }
        })
      );
    }
  }

  private async findRelatedDocs(
    queryText: string,
    excludePath?: string,
    limit = 6,
    excludeTitle?: string
  ): Promise<RelatedDocRef[]> {
    const tokens = Array.from(tokenizeKeywords(queryText)).slice(0, 12);
    if (tokens.length === 0) return [];
    const index = await this.getDocIndex();

    const scored: Array<{ doc: IndexedDoc; score: number }> = [];
    const preferredCats = new Set(["owner", "dashboards", "world", "entities", "notes", "obsidian", "apple-notes", "wispr-flow"]);
    const normExcludeTitle = (excludeTitle || "").trim().toLowerCase();

    for (const doc of index.entries) {
      if (excludePath && doc.path === excludePath) continue;
      if (normExcludeTitle && doc.title.trim().toLowerCase() === normExcludeTitle) continue;
      if (isLowSignalDoc(doc)) continue;
      const hay = `${doc.path} ${doc.title}`.toLowerCase();
      let score = 0;
      for (const tok of tokens) {
        if (hay.includes(tok)) {
          score += doc.title.toLowerCase().includes(tok) ? 3 : 2;
        }
      }
      if (score > 0) {
        if (preferredCats.has(doc.category)) score += 1;
        scored.push({ doc, score });
      }
    }

    scored.sort((a, b) => b.score - a.score || b.doc.mtimeMs - a.doc.mtimeMs);
    const candidatePool = scored.slice(0, Math.max(limit * 3, 18)).map((s) => s.doc);
    await this.hydrateDocHeads(candidatePool);

    const seenTitles = new Set<string>(normExcludeTitle ? [normExcludeTitle] : []);
    const cleanTop = candidatePool
      .filter((d) => {
        if (isLowSignalDoc(d)) return false;
        const t = scrubOAuthUrls(d.title).trim().toLowerCase();
        if (t && seenTitles.has(t)) return false;
        if (t) seenTitles.add(t);
        return true;
      })
      .slice(0, limit);
    return cleanTop.map((d) => ({
      path: d.path,
      title: scrubOAuthUrls(d.title),
      category: d.category,
    }));
  }

  private async validateVaultDocPath(
    rawPath: string,
    opts: { mustExist?: boolean } = {}
  ): Promise<{ relPath: string; fullPath: string }> {
    const input = (rawPath || "").trim();
    if (!input) {
      throw new BadRequestError("path parameter is required");
    }
    if (input.includes("\0") || input.includes("\\") || input.startsWith("/") || input.startsWith("~")) {
      throw new ForbiddenError("Forbidden vault path");
    }
    const normalized = input.replace(/\/+/g, "/").replace(/^\.\//, "");
    const segments = normalized.split("/");
    if (segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new ForbiddenError("Path traversal is forbidden");
    }
    if (SECRET_PATH_RE.test(normalized)) {
      throw new ForbiddenError("Access to protected or secret paths is forbidden");
    }
    if (!normalized.toLowerCase().endsWith(".md")) {
      throw new ForbiddenError("Only .md vault documents are accessible");
    }

    let baseRoot: string;
    let subRel: string;
    if (normalized.startsWith("obsidian/")) {
      baseRoot = resolve(join(this.bridgesDir, "mac-obsidian"));
      subRel = normalized.slice("obsidian/".length);
    } else if (normalized.startsWith("apple-notes/")) {
      baseRoot = resolve(join(this.bridgesDir, "mac-notes"));
      subRel = normalized.slice("apple-notes/".length);
    } else if (normalized.startsWith("wispr-flow/")) {
      baseRoot = resolve(join(this.bridgesDir, "wispr-flow", "meetings"));
      subRel = normalized.slice("wispr-flow/".length);
    } else {
      baseRoot = resolve(this.vaultPath);
      subRel = normalized;
    }

    if (!subRel || SECRET_PATH_RE.test(subRel)) {
      throw new ForbiddenError("Access to protected or secret paths is forbidden");
    }

    const allowedRoot = await realpath(baseRoot).catch(() => baseRoot);
    const candidate = resolve(allowedRoot, subRel);
    if (candidate !== allowedRoot && !candidate.startsWith(allowedRoot + sep)) {
      throw new ForbiddenError("Resolved path escapes allowed document root");
    }

    if (opts.mustExist) {
      let realCandidate: string;
      try {
        realCandidate = await realpath(candidate);
      } catch {
        throw new NotFoundError(`Document not found: ${normalized}`);
      }
      if (realCandidate !== allowedRoot && !realCandidate.startsWith(allowedRoot + sep)) {
        throw new ForbiddenError("Symlink escapes allowed document root");
      }
      return { relPath: normalized, fullPath: realCandidate };
    }

    return { relPath: normalized, fullPath: candidate };
  }

  async listDocs(opts: {
    category?: string;
    q?: string;
    limit?: number;
    offset?: number;
    sort?: string;
  } = {}): Promise<DocsListResponse> {
    const category = (opts.category || "all").trim().toLowerCase();
    const q = (opts.q || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(200, Number(opts.limit || 60) || 60));
    const offset = Math.max(0, Number(opts.offset || 0) || 0);
    const sort = (opts.sort || "recent").trim().toLowerCase() === "name" ? "name" : "recent";

    const index = await this.getDocIndex();

    let pool =
      category && category !== "all"
        ? index.entries.filter((d) => d.category === category)
        : index.entries;

    if (q) {
      const matched: IndexedDoc[] = [];
      const unmatched: IndexedDoc[] = [];
      for (const d of pool) {
        const hay = `${d.path} ${d.name} ${d.title} ${d.excerpt || ""}`.toLowerCase();
        if (hay.includes(q)) {
          matched.push(d);
        } else {
          unmatched.push(d);
        }
      }

      // If path/title match count is small, also inspect file heads of top recent unmatched candidates
      if (matched.length < Math.min(limit, 30) && unmatched.length > 0) {
        const probeLimit = category !== "all" ? Math.min(unmatched.length, 300) : Math.min(unmatched.length, 200);
        const probes = unmatched.slice(0, probeLimit);
        await this.hydrateDocHeads(probes);
        for (const d of probes) {
          const hay = `${d.title} ${d.excerpt || ""}`.toLowerCase();
          if (hay.includes(q)) {
            matched.push(d);
          }
        }
      }
      pool = matched;
    }

    let sorted: IndexedDoc[];
    if (sort === "name") {
      sorted = [...pool].sort((a, b) => a.path.localeCompare(b.path));
    } else if (!q) {
      // Curated default Recent first: down-rank noisy OAuth URL dumps, Last login terminal pastes, and raw markdown-folder captures
      const primary: IndexedDoc[] = [];
      const demoted: IndexedDoc[] = [];
      for (const d of pool) {
        if (isLowSignalDoc(d)) {
          demoted.push(d);
        } else {
          primary.push(d);
        }
      }
      sorted = [...primary, ...demoted];
    } else {
      sorted = pool; // index.entries is already sorted by mtimeMs DESC
    }

    const total = sorted.length;
    let page: IndexedDoc[];
    if (sort === "recent" && !q) {
      // Hydrate a small lookahead window so any doc whose hydrated head is low-signal also demotes cleanly
      const windowSlice = sorted.slice(offset, offset + limit + 32);
      await this.hydrateDocHeads(windowSlice);
      const cleanWin: IndexedDoc[] = [];
      const lowWin: IndexedDoc[] = [];
      for (const d of windowSlice) {
        if (isLowSignalDoc(d)) lowWin.push(d);
        else cleanWin.push(d);
      }
      page = [...cleanWin, ...lowWin].slice(0, limit);
    } else {
      page = sorted.slice(offset, offset + limit);
      await this.hydrateDocHeads(page);
    }

    return {
      total,
      categories: index.categories,
      items: page.map((d) => ({
        path: d.path,
        title: scrubOAuthUrls(d.title),
        category: d.category,
        updated_at: new Date(d.mtimeMs).toISOString(),
        size_bytes: d.size,
        excerpt: scrubOAuthUrls(d.excerpt || ""),
      })),
      offset,
      limit,
    };
  }

  async readDoc(rawPath: string): Promise<DocReadResponse> {
    const { relPath, fullPath } = await this.validateVaultDocPath(rawPath, { mustExist: true });
    let st;
    try {
      st = await stat(fullPath);
    } catch {
      throw new NotFoundError(`Document not found: ${relPath}`);
    }
    if (!st.isFile()) {
      throw new ForbiddenError("Target path is not a regular file");
    }

    const rawContent = await readFile(fullPath, "utf8");
    const content = scrubOAuthUrls(rawContent);
    const parsedHead = parseDocHead(content.slice(0, 4096), basename(relPath));
    const category = classifyDocCategory(relPath);
    const editable = isEditableVaultDocPath(relPath);
    const related_docs = await this.findRelatedDocs(
      `${parsedHead.title} ${relPath} ${content.slice(0, 600)}`,
      relPath,
      6,
      parsedHead.title
    );

    return {
      ok: true,
      path: relPath,
      title: scrubOAuthUrls(parsedHead.title),
      category,
      updated_at: st.mtime.toISOString(),
      size_bytes: st.size,
      editable,
      content,
      related_docs,
    };
  }

  async saveDoc(req: DocSaveRequest): Promise<DocSaveResponse> {
    if (!req || typeof req.path !== "string") {
      throw new BadRequestError("path is required");
    }
    if (typeof req.content !== "string") {
      throw new BadRequestError("content must be a string");
    }
    const byteLen = Buffer.byteLength(req.content, "utf8");
    if (byteLen > 500_000) {
      throw new BadRequestError("content exceeds 500KB limit");
    }

    const { relPath, fullPath } = await this.validateVaultDocPath(req.path, { mustExist: false });
    if (!isEditableVaultDocPath(relPath)) {
      throw new ForbiddenError(
        "Write restricted to owner-anchors.md, owner-notes.md, owner-notes/<safe-slug>.md, or world/people/<safe-slug>.md"
      );
    }

    if (req.dryRun) {
      return {
        ok: true,
        dryRun: true,
        path: relPath,
        size_bytes: byteLen,
        updated_at: new Date().toISOString(),
      };
    }

    const dir = dirname(fullPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = join(dir, `.${basename(fullPath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmpPath, req.content, { encoding: "utf8", mode: 0o600 });
      await rename(tmpPath, fullPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }

    this.docIndexCache = null;
    this.pulseSnapshot.markDirty();
    this.overviewCache = null;

    const st = await stat(fullPath);
    return {
      ok: true,
      path: relPath,
      size_bytes: st.size,
      updated_at: st.mtime.toISOString(),
    };
  }

  private normalizeBridgeTimestamp(raw: unknown, fallbackIso: string): string {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const ms = raw > 1e12 ? raw : raw * 1000;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    if (typeof raw === "string" && raw.trim()) {
      const s = raw.trim();
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s;
      const parsed = Date.parse(s);
      if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
    }
    return fallbackIso;
  }

  private async getWisprMeetingDocMap(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const meetingsDir = join(this.bridgesDir, "wispr-flow", "meetings");
    let entries;
    try {
      entries = await readdir(meetingsDir, { withFileTypes: true });
    } catch {
      return map;
    }
    await Promise.all(
      entries.map(async (e) => {
        if (!e.isFile() || !e.name.toLowerCase().endsWith(".md")) return;
        const full = join(meetingsDir, e.name);
        try {
          const head = await Bun.file(full).slice(0, 1024).text();
          const idMatch = head.match(/^meeting_id:\s*["']?([^"'\r\n]+)["']?/m);
          if (idMatch && idMatch[1]) {
            map.set(idMatch[1].trim(), `wispr-flow/${e.name}`);
          }
        } catch {
          // ignore unreadable meeting file
        }
      })
    );
    return map;
  }

  private parseJsonlRecord(
    obj: Record<string, unknown>,
    spec: BridgeSourceSpec,
    fallbackIso: string,
    lineIndex: number,
    wisprMeetingDocs?: Map<string, string>
  ): StreamItem {
    const kind = String(obj.kind || obj.type || spec.defaultKind);
    const subject = typeof obj.subject === "string" ? obj.subject.trim() : "";
    const explicitTitle = typeof obj.title === "string" ? obj.title.trim() : "";
    const rawBody =
      obj.text ??
      obj.body ??
      obj.content ??
      obj.markdown ??
      obj.summary ??
      obj.snippet ??
      obj.message ??
      "";
    let combinedText = typeof rawBody === "string" ? rawBody : rawBody ? JSON.stringify(rawBody) : "";
    const heading = explicitTitle || subject;
    if (heading && !combinedText.toLowerCase().includes(heading.toLowerCase().slice(0, 32))) {
      combinedText = combinedText ? `${heading}\n${combinedText}` : heading;
    }
    const fullText = stripEmDashes(combinedText).slice(0, 6000);
    const rawTs =
      spec.id === "wispr-flow"
        ? obj.occurred_at ?? obj.observed_at ?? obj.timestamp ?? obj.created_at ?? obj.date ?? obj.sent_at
        : obj.observed_at ?? obj.occurred_at ?? obj.timestamp ?? obj.created_at ?? obj.date ?? obj.sent_at;
    const ts = this.normalizeBridgeTimestamp(rawTs, fallbackIso);
    const rawId = obj.id ?? obj.event_id ?? obj.source_record_id ?? obj.uid ?? obj.message_id;
    const id = rawId !== undefined && rawId !== null && String(rawId).trim()
      ? String(rawId).trim()
      : `${spec.id}:${lineIndex}`;
    const rawSourceRecordId =
      obj.source_record_id ?? obj.board_scope ?? obj.thread_id ?? obj.chat_id ?? obj.channel ?? obj.source;
    const sourceRecordId =
      rawSourceRecordId !== undefined && rawSourceRecordId !== null && String(rawSourceRecordId).trim()
        ? String(rawSourceRecordId).trim()
        : spec.id;
    const title = heading
      ? cleanText(heading, 96)
      : deriveEventTitle(fullText, kind, spec.id);

    let docPath: string | null = null;
    if (
      spec.id === "wispr-flow" &&
      wisprMeetingDocs &&
      (kind === "meeting_note" || kind === "meeting_transcript")
    ) {
      let meetingId = typeof obj.meeting_id === "string" ? obj.meeting_id.trim() : "";
      if (!meetingId) {
        const m = id.match(/^wispr:(?:meeting|transcript):([a-zA-Z0-9-]+)$/);
        if (m) meetingId = m[1];
      }
      if (meetingId) {
        docPath = wisprMeetingDocs.get(meetingId) ?? null;
      }
    }

    return {
      id,
      connector: spec.id,
      connector_label: spec.label,
      kind,
      observed_at: ts,
      title,
      preview: cleanText(fullText || title, 240),
      full_text: fullText,
      source_record_id: sourceRecordId,
      ...(docPath ? { doc_path: docPath } : {}),
    };
  }

  private async readJsonlBridge(
    filePath: string,
    spec: BridgeSourceSpec,
    maxItems = 600
  ): Promise<BridgeSourceSnapshot> {
    if (SECRET_PATH_RE.test(filePath)) {
      return { spec, count: 0, latest: null, items: [] };
    }
    let st;
    try {
      st = await stat(filePath);
    } catch {
      return { spec, count: 0, latest: null, items: [] };
    }
    if (!st.isFile() || st.size === 0) {
      return { spec, count: 0, latest: null, items: [] };
    }

    const wisprMeetingDocs = spec.id === "wispr-flow" ? await this.getWisprMeetingDocMap() : undefined;
    const fallbackIso = st.mtime.toISOString();
    const MAX_FULL_READ_BYTES = 16 * 1024 * 1024;
    const TAIL_SLICE_BYTES = 4 * 1024 * 1024;

    try {
      if (st.size <= MAX_FULL_READ_BYTES) {
        const raw = await readFile(filePath, "utf8");
        const items: StreamItem[] = [];
        let validCount = 0;
        let latest: string | null = null;
        const lines = raw.split(/\r?\n/);
        for (let idx = 0; idx < lines.length; idx++) {
          const trimmed = lines[idx].trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
            validCount++;
            const item = this.parseJsonlRecord(
              parsed as Record<string, unknown>,
              spec,
              fallbackIso,
              idx,
              wisprMeetingDocs
            );
            if (!latest || item.observed_at.localeCompare(latest) > 0) {
              latest = item.observed_at;
            }
            items.push(item);
          } catch {
            // skip malformed jsonl line
          }
        }
        items.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
        const nowIso = new Date().toISOString();
        const safeLatest =
          latest && latest.localeCompare(nowIso) <= 0
            ? latest
            : validCount > 0
              ? fallbackIso
              : null;
        return {
          spec,
          count: validCount,
          latest: safeLatest,
          items: items.slice(0, maxItems),
        };
      }

      // Large JSONL (>16MB): count lines cleanly via stream and parse the tail window
      const file = Bun.file(filePath);
      let lineCount = 0;
      const reader = file.stream().getReader();
      let lastByte = 10;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          for (let i = 0; i < value.length; i++) {
            if (value[i] === 10) lineCount++;
          }
          lastByte = value[value.length - 1];
        }
      }
      if (lastByte !== 10) lineCount++;

      const tailRaw = await file.slice(Math.max(0, st.size - TAIL_SLICE_BYTES), st.size).text();
      const firstNl = tailRaw.indexOf("\n");
      const tailBody = firstNl !== -1 ? tailRaw.slice(firstNl + 1) : tailRaw;
      const items: StreamItem[] = [];
      let latest: string | null = null;
      const tailLines = tailBody.split(/\r?\n/);
      for (let idx = 0; idx < tailLines.length; idx++) {
        const trimmed = tailLines[idx].trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
          const item = this.parseJsonlRecord(
            parsed as Record<string, unknown>,
            spec,
            fallbackIso,
            idx,
            wisprMeetingDocs
          );
          if (!latest || item.observed_at.localeCompare(latest) > 0) {
            latest = item.observed_at;
          }
          items.push(item);
        } catch {
          // skip malformed jsonl line
        }
      }
      items.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
      const nowIso = new Date().toISOString();
      const safeLatest =
        latest && latest.localeCompare(nowIso) <= 0
          ? latest
          : lineCount > 0
            ? fallbackIso
            : null;
      return {
        spec,
        count: lineCount,
        latest: safeLatest,
        items: items.slice(0, maxItems),
      };
    } catch {
      return { spec, count: 0, latest: null, items: [] };
    }
  }

  private async collectBridgeFiles(
    dirPath: string,
    extensions: Set<string>
  ): Promise<Array<{ fullPath: string; relPath: string; mtimeMs: number }>> {
    const out: Array<{ fullPath: string; relPath: string; mtimeMs: number }> = [];
    const walk = async (curDir: string, relPrefix: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(curDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (SECRET_PATH_RE.test(rel)) continue;
        const full = join(curDir, entry.name);
        if (entry.isDirectory()) {
          await walk(full, rel);
        } else if (entry.isFile()) {
          const dotIdx = entry.name.lastIndexOf(".");
          const ext = dotIdx !== -1 ? entry.name.slice(dotIdx).toLowerCase() : "";
          if (!extensions.has(ext)) continue;
          try {
            const st = await stat(full);
            out.push({ fullPath: full, relPath: rel, mtimeMs: st.mtimeMs });
          } catch {
            // ignore vanished file
          }
        }
      }
    };
    await walk(dirPath, "");
    return out;
  }

  private async scanMarkdownDirBridge(
    dirPath: string,
    spec: BridgeSourceSpec,
    loadItems = false,
    maxItems = 120
  ): Promise<BridgeSourceSnapshot> {
    const files = await this.collectBridgeFiles(dirPath, new Set([".md"]));
    if (files.length === 0) {
      return { spec, count: 0, latest: null, items: [] };
    }
    let maxMtime = 0;
    for (const f of files) {
      if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
    }
    const latest = maxMtime > 0 ? new Date(maxMtime).toISOString() : null;
    if (!loadItems) {
      return { spec, count: files.length, latest, items: [] };
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const items: StreamItem[] = [];
    for (const f of files.slice(0, maxItems)) {
      try {
        const raw = await readFile(f.fullPath, "utf8");
        const head = parseDocHead(raw.slice(0, 4096), basename(f.relPath));
        const fullText = stripEmDashes(raw).slice(0, 6000);
        items.push({
          id: `${spec.id}:${f.relPath}`,
          connector: spec.id,
          connector_label: spec.label,
          kind: spec.defaultKind,
          observed_at: new Date(f.mtimeMs).toISOString(),
          title: head.title || slugToTitle(basename(f.relPath)),
          preview: cleanText(head.excerpt || fullText, 240),
          full_text: fullText,
          source_record_id: f.relPath,
        });
      } catch {
        // skip unreadable file
      }
    }
    return { spec, count: files.length, latest, items };
  }

  private async scanSessionsDirBridge(
    dirPath: string,
    spec: BridgeSourceSpec,
    loadItems = false,
    maxItems = 200
  ): Promise<BridgeSourceSnapshot> {
    const eventsPath = join(dirPath, "events.jsonl");
    const jsonlSnap = await this.readJsonlBridge(eventsPath, spec, maxItems);
    if (jsonlSnap.count > 0) {
      return jsonlSnap;
    }

    const files = await this.collectBridgeFiles(dirPath, new Set([".jsonl", ".json", ".md"]));
    if (files.length === 0) {
      return { spec, count: 0, latest: null, items: [] };
    }
    let maxMtime = 0;
    for (const f of files) {
      if (f.mtimeMs > maxMtime) maxMtime = f.mtimeMs;
    }
    const latest = maxMtime > 0 ? new Date(maxMtime).toISOString() : null;
    if (!loadItems) {
      return { spec, count: files.length, latest, items: [] };
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const items: StreamItem[] = [];
    for (const f of files.slice(0, maxItems)) {
      try {
        const raw = await readFile(f.fullPath, "utf8");
        const fullText = stripEmDashes(raw).slice(0, 6000);
        const title = f.relPath.endsWith(".md")
          ? parseDocHead(raw.slice(0, 4096), basename(f.relPath)).title
          : slugToTitle(basename(f.relPath).replace(/\.(jsonl|json)$/i, ""));
        items.push({
          id: `${spec.id}:${f.relPath}`,
          connector: spec.id,
          connector_label: spec.label,
          kind: spec.defaultKind,
          observed_at: new Date(f.mtimeMs).toISOString(),
          title: cleanText(title, 96) || `${spec.label} (${basename(f.relPath)})`,
          preview: cleanText(fullText, 240),
          full_text: fullText,
          source_record_id: f.relPath,
        });
      } catch {
        // skip unreadable file
      }
    }
    return { spec, count: files.length, latest, items };
  }

  private async computeBridgesFingerprint(): Promise<string> {
    const paths = PERSONAL_BRIDGE_SPECS.map((spec) => {
      if (spec.id === "antigravity-neon") return this.antigravityJsonlPath;
      const subDir = spec.subDir || spec.id;
      const dirPath = join(this.bridgesDir, subDir);
      return spec.mode === "jsonl" ? join(dirPath, "events.jsonl") : dirPath;
    });
    const parts = await Promise.all(
      paths.map(async (p) => {
        try {
          const st = await stat(p);
          return `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          return "0:0";
        }
      })
    );
    return parts.join("|");
  }

  private async computePulseFingerprint(): Promise<string> {
    const fileParts = await Promise.all(
      [
        join(this.vaultPath, "owner-anchors.md"),
        join(this.vaultPath, "dashboards", "executive-digest-latest.md"),
        join(this.vaultPath, "dashboards"),
      ].map(async (p) => {
        try {
          const st = await stat(p);
          return `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          return "0:0";
        }
      })
    );
    let evFp = "0:0";
    let clFp = "0:0";
    try {
      const ev = this.db
        .query(`SELECT COALESCE(MAX(rowid), 0) AS m, COUNT(*) AS c FROM events`)
        .get() as { m: number; c: number } | null;
      if (ev) evFp = `${ev.m}:${ev.c}`;
    } catch {
      evFp = "no-ev";
    }
    try {
      const cl = this.db
        .query(`SELECT COALESCE(MAX(rowid), 0) AS m, COUNT(*) AS c FROM claims`)
        .get() as { m: number; c: number } | null;
      if (cl) clFp = `${cl.m}:${cl.c}`;
    } catch {
      clFp = "no-cl";
    }
    return `${fileParts.join("|")}|${evFp}|${clFp}|b${this.bridgesSnapshot.version}`;
  }

  private async getBridgeSnapshots(): Promise<BridgeSourceSnapshot[]> {
    return this.bridgesSnapshot.get();
  }

  private async buildBridgeSnapshots(): Promise<BridgeSourceSnapshot[]> {
    const snapshots = await Promise.all(
      PERSONAL_BRIDGE_SPECS.map(async (spec): Promise<BridgeSourceSnapshot> => {
        if (spec.id === "antigravity-neon") {
          return this.readJsonlBridge(this.antigravityJsonlPath, spec, 3000);
        }
        const subDir = spec.subDir || spec.id;
        const dirPath = join(this.bridgesDir, subDir);
        if (spec.mode === "jsonl") {
          return this.readJsonlBridge(join(dirPath, "events.jsonl"), spec, 600);
        }
        if (spec.mode === "markdown_dir") {
          return this.scanMarkdownDirBridge(dirPath, spec, false);
        }
        return this.scanSessionsDirBridge(dirPath, spec, false);
      })
    );

    return snapshots;
  }

  private async getAntigravityEntries(): Promise<StreamItem[]> {
    const now = Date.now();
    if (this.antigravityCache && this.antigravityCache.expiresAt > now) {
      return this.antigravityCache.value;
    }

    const snaps = await this.getBridgeSnapshots();
    const ag = snaps.find((s) => s.spec.id === "antigravity-neon");
    const items = ag ? ag.items : [];
    this.antigravityCache = { value: items, expiresAt: now + 15_000 };
    return items;
  }

  private dedupeStreamItems(primary: StreamItem[], secondary: StreamItem[]): StreamItem[] {
    const genericSourceIds = new Set<string>(PERSONAL_BRIDGE_SPECS.flatMap((s) => [s.id, ...s.sqlAliases]));
    const isSpecificSourceId = (sid: string | null | undefined): sid is string => {
      if (!sid) return false;
      const trimmed = sid.trim();
      return trimmed.length >= 4 && !genericSourceIds.has(trimmed);
    };

    const seenIds = new Set<string>();
    const seenSourceIds = new Set<string>();
    const out: StreamItem[] = [];

    const tryPush = (item: StreamItem): void => {
      if (seenIds.has(item.id) || seenSourceIds.has(item.id)) return;
      if (isSpecificSourceId(item.source_record_id)) {
        if (seenIds.has(item.source_record_id) || seenSourceIds.has(item.source_record_id)) return;
        seenSourceIds.add(item.source_record_id);
      }
      seenIds.add(item.id);
      out.push(item);
    };

    for (const item of primary) tryPush(item);
    for (const item of secondary) tryPush(item);
    out.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
    return out;
  }

  async getStream(opts: {
    connector?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<StreamResponse> {
    const connector = (opts.connector || "all").trim();
    const q = (opts.q || "").trim();
    const limit = Math.max(1, Math.min(100, Number(opts.limit || 40) || 40));
    const offset = Math.max(0, Number(opts.offset || 0) || 0);

    const bridges = await this.getBridgeSnapshots();
    const sqlStats = this.getConnectorStats();
    const sqlById = new Map(sqlStats.map((c) => [c.id, Number(c.count || 0)]));

    const connectors: Array<{ id: string; label: string; count: number }> = sqlStats.map((c) => ({
      id: c.id,
      label: connectorLabel(c.id),
      count: Number(c.count || 0),
    }));
    const connectorIdxById = new Map(connectors.map((c, idx) => [c.id, idx]));

    for (const snap of bridges) {
      if (snap.count <= 0) continue;
      const matchedAlias = snap.spec.sqlAliases.find((alias) => connectorIdxById.has(alias));
      if (matchedAlias !== undefined) {
        const idx = connectorIdxById.get(matchedAlias)!;
        connectors[idx].count = Math.max(connectors[idx].count, snap.count);
      } else {
        connectorIdxById.set(snap.spec.id, connectors.length);
        connectors.push({
          id: snap.spec.id,
          label: snap.spec.label,
          count: snap.count,
        });
      }
    }

    const wisprMeetingDocs = await this.getWisprMeetingDocMap();
    const mapEventRow = (r: {
      event_id: string;
      connector_id: string;
      kind: string;
      observed_at: string;
      source_record_id: string | null;
      text_val: string | null;
    }): StreamItem => {
      const fullText = stripEmDashes(r.text_val || "").slice(0, 6000);
      let docPath: string | null = null;
      if (
        (r.connector_id === "wispr-flow" || r.connector_id === "kizuki.wispr-flow") &&
        (r.kind === "meeting_note" || r.kind === "meeting_transcript") &&
        r.source_record_id
      ) {
        const m = r.source_record_id.match(/^wispr:(?:meeting|transcript):([a-zA-Z0-9-]+)$/);
        if (m) docPath = wisprMeetingDocs.get(m[1]) ?? null;
      }
      return {
        id: r.event_id,
        connector: r.connector_id,
        connector_label: connectorLabel(r.connector_id),
        kind: r.kind,
        observed_at: r.observed_at,
        title: deriveEventTitle(fullText, r.kind, r.connector_id),
        preview: cleanText(fullText, 240),
        full_text: fullText,
        source_record_id: r.source_record_id || null,
        ...(docPath ? { doc_path: docPath } : {}),
      };
    };

    const matchesQuery = (item: StreamItem, qLower: string): boolean =>
      item.title.toLowerCase().includes(qLower) ||
      item.full_text.toLowerCase().includes(qLower) ||
      item.id.toLowerCase().includes(qLower) ||
      (item.source_record_id ? item.source_record_id.toLowerCase().includes(qLower) : false);

    // Case 1: Specific connector matching a personal-life bridge (merges SQLite + bridge JSONL/dir, deduplicated by ID)
    const matchedBridge =
      connector && connector !== "all"
        ? bridges.find((b) => b.spec.id === connector || b.spec.sqlAliases.includes(connector))
        : undefined;

    if (matchedBridge) {
      const aliases = Array.from(new Set([connector, matchedBridge.spec.id, ...matchedBridge.spec.sqlAliases]));
      const placeholders = aliases.map(() => "?").join(", ");
      const sqlAliasTotal = aliases.reduce((sum, a) => sum + (sqlById.get(a) || 0), 0);

      let bridgeItems = matchedBridge.items;
      if (bridgeItems.length === 0 && matchedBridge.count > 0) {
        const subDir = matchedBridge.spec.subDir || matchedBridge.spec.id;
        const dirPath = join(this.bridgesDir, subDir);
        if (matchedBridge.spec.mode === "markdown_dir") {
          const loaded = await this.scanMarkdownDirBridge(dirPath, matchedBridge.spec, true, Math.max(offset + limit + 40, 120));
          bridgeItems = loaded.items;
        } else if (matchedBridge.spec.mode === "sessions_dir") {
          const loaded = await this.scanSessionsDirBridge(dirPath, matchedBridge.spec, true, Math.max(offset + limit + 40, 200));
          bridgeItems = loaded.items;
        }
      }

      if (!q) {
        const fetchDepth = Math.min(offset + limit + 40, 1000);
        const sqlRows =
          sqlAliasTotal > 0
            ? (this.db
                .query(
                  `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 6000) AS text_val
                   FROM events
                   WHERE deleted = 0 AND connector_id IN (${placeholders})
                   ORDER BY observed_at DESC
                   LIMIT ?`
                )
                .all(...aliases, fetchDepth) as Array<{
                event_id: string;
                connector_id: string;
                kind: string;
                observed_at: string;
                source_record_id: string | null;
                text_val: string | null;
              }>)
            : [];

        const sqlMapped = sqlRows.map(mapEventRow);
        const merged = this.dedupeStreamItems(sqlMapped, bridgeItems);
        const total =
          sqlAliasTotal === 0
            ? matchedBridge.count
            : matchedBridge.count === 0
              ? sqlAliasTotal
              : sqlAliasTotal <= fetchDepth && matchedBridge.count <= bridgeItems.length
                ? merged.length
                : Math.max(sqlAliasTotal, matchedBridge.count, merged.length);

        return {
          total,
          connectors,
          items: merged.slice(offset, offset + limit),
        };
      }

      const like = `%${q}%`;
      const qLower = q.toLowerCase();
      const sqlRows =
        sqlAliasTotal > 0
          ? (this.db
              .query(
                `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 6000) AS text_val
                 FROM (
                   SELECT event_id, connector_id, kind, observed_at, source_record_id, text
                   FROM events
                   WHERE deleted = 0 AND connector_id IN (${placeholders})
                   ORDER BY observed_at DESC
                   LIMIT 15000
                 )
                 WHERE text LIKE ? OR source_record_id LIKE ?
                 LIMIT 300`
              )
              .all(...aliases, like, like) as Array<{
              event_id: string;
              connector_id: string;
              kind: string;
              observed_at: string;
              source_record_id: string | null;
              text_val: string | null;
            }>)
          : [];
      const bridgeMatches = bridgeItems.filter((item) => matchesQuery(item, qLower));
      const merged = this.dedupeStreamItems(sqlRows.map(mapEventRow), bridgeMatches);
      return {
        total: merged.length,
        connectors,
        items: merged.slice(offset, offset + limit),
      };
    }

    // Case 2: Specific SQLite-only connector
    if (connector && connector !== "all") {
      if (!q) {
        const statRow = sqlStats.find((c) => c.id === connector);
        const total = statRow ? Number(statRow.count) : 0;
        const rows = this.db
          .query(
            `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 6000) AS text_val
             FROM events
             WHERE deleted = 0 AND connector_id = ?
             ORDER BY observed_at DESC
             LIMIT ? OFFSET ?`
          )
          .all(connector, limit, offset) as Array<{
            event_id: string;
            connector_id: string;
            kind: string;
            observed_at: string;
            source_record_id: string | null;
            text_val: string | null;
          }>;
        return {
          total,
          connectors,
          items: rows.map(mapEventRow),
        };
      }

      const like = `%${q}%`;
      const rows = this.db
        .query(
          `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 6000) AS text_val
           FROM (
             SELECT event_id, connector_id, kind, observed_at, source_record_id, text
             FROM events
             WHERE deleted = 0 AND connector_id = ?
             ORDER BY observed_at DESC
             LIMIT 15000
           )
           WHERE text LIKE ? OR source_record_id LIKE ?
           LIMIT 300`
        )
        .all(connector, like, like) as Array<{
          event_id: string;
          connector_id: string;
          kind: string;
          observed_at: string;
          source_record_id: string | null;
          text_val: string | null;
        }>;
      const mapped = rows.map(mapEventRow);
      return {
        total: mapped.length,
        connectors,
        items: mapped.slice(offset, offset + limit),
      };
    }

    // Case 3: connector === "all" (SQLite events + all active JSONL bridges, deduplicated by ID)
    const allBridgeItems: StreamItem[] = [];
    const nowStreamIso = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    for (const snap of bridges) {
      if (snap.count <= 0) continue;
      if (snap.items.length > 0) {
        if (snap.spec.id === "mac-calendar") {
          allBridgeItems.push(...snap.items.filter((item) => item.observed_at.localeCompare(nowStreamIso) <= 0));
        } else {
          allBridgeItems.push(...snap.items);
        }
      }
    }

    if (!q) {
      const total = this.computeUnifiedEventsTotal(sqlStats, bridges);
      const fetchDepth = Math.min(offset + limit + 40, 1000);
      const sqlRows = this.db
        .query(
          `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 6000) AS text_val
           FROM events
           WHERE deleted = 0
           ORDER BY observed_at DESC
           LIMIT ?`
        )
        .all(fetchDepth) as Array<{
          event_id: string;
          connector_id: string;
          kind: string;
          observed_at: string;
          source_record_id: string | null;
          text_val: string | null;
        }>;

      allBridgeItems.sort((a, b) => b.observed_at.localeCompare(a.observed_at));
      const merged = this.dedupeStreamItems(sqlRows.map(mapEventRow), allBridgeItems.slice(0, fetchDepth));
      return {
        total,
        connectors,
        items: merged.slice(offset, offset + limit),
      };
    }

    const like = `%${q}%`;
    const qLower = q.toLowerCase();
    const sqlRows = this.db
      .query(
        `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 6000) AS text_val
         FROM (
           SELECT event_id, connector_id, kind, observed_at, source_record_id, text
           FROM events
           WHERE deleted = 0
           ORDER BY observed_at DESC
           LIMIT 12000
         )
         WHERE text LIKE ? OR source_record_id LIKE ?
         LIMIT 200`
      )
      .all(like, like) as Array<{
        event_id: string;
        connector_id: string;
        kind: string;
        observed_at: string;
        source_record_id: string | null;
        text_val: string | null;
      }>;

    const bridgeMatches = allBridgeItems.filter((item) => matchesQuery(item, qLower)).slice(0, 150);
    const merged = this.dedupeStreamItems(sqlRows.map(mapEventRow), bridgeMatches);
    return {
      total: merged.length,
      connectors,
      items: merged.slice(offset, offset + limit),
    };
  }

  async getPulse(): Promise<PulseResponse> {
    const [pulse, overview] = await Promise.all([this.pulseSnapshot.get(), this.getOverview()]);
    return { ...pulse, overview };
  }

  private async buildPulse(): Promise<PulseResponse> {
    const [overview, docIndex, topMemtAll, bridges, digestBrief] = await Promise.all([
      this.getOverview(),
      this.getDocIndex(),
      this.getMemtExperiences(24),
      this.getBridgeSnapshots(),
      this.getBrief("executive-digest-latest.md"),
    ]);

    // 14-day UTC histogram (events + claims)
    const days: string[] = [];
    const todayUtc = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate() - i));
      days.push(d.toISOString().slice(0, 10));
    }
    const startDate = days[0];

    const eventDayRows = this.db
      .query(
        `SELECT substr(observed_at, 1, 10) AS day, COUNT(*) AS cnt
         FROM events
         WHERE deleted = 0 AND observed_at >= ?
         GROUP BY day`
      )
      .all(startDate) as Array<{ day: string; cnt: number }>;

    const claimDayRows = this.db
      .query(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS cnt
         FROM claims
         WHERE status = 'live' AND created_at >= ?
         GROUP BY day`
      )
      .all(startDate) as Array<{ day: string; cnt: number }>;

    const eventsByDay = new Map(eventDayRows.map((r) => [r.day, Number(r.cnt || 0)]));
    const claimsByDay = new Map(claimDayRows.map((r) => [r.day, Number(r.cnt || 0)]));
    const activity_14d = days.map((day) => ({
      day,
      events: eventsByDay.get(day) || 0,
      claims: claimsByDay.get(day) || 0,
    }));

    // Latest 12 real events (SQLite + newest staged personal-life bridge items, deduplicated)
    const recentEventRows = this.db
      .query(
        `SELECT event_id, connector_id, kind, observed_at, source_record_id, substr(text, 1, 400) AS text_val
         FROM events
         WHERE deleted = 0
         ORDER BY observed_at DESC
         LIMIT 12`
      )
      .all() as Array<{
        event_id: string;
        connector_id: string;
        kind: string;
        observed_at: string;
        source_record_id: string | null;
        text_val: string | null;
      }>;

    const sqlRecentItems: StreamItem[] = recentEventRows.map((r) => {
      const fullText = stripEmDashes(r.text_val || "");
      return {
        id: r.event_id,
        connector: r.connector_id,
        connector_label: connectorLabel(r.connector_id),
        kind: r.kind,
        observed_at: r.observed_at,
        title: deriveEventTitle(fullText, r.kind, r.connector_id),
        preview: cleanText(fullText, 220),
        full_text: fullText,
        source_record_id: r.source_record_id || null,
      };
    });
    const bridgeRecentItems: StreamItem[] = [];
    const nowRecentIso = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    for (const snap of bridges) {
      if (snap.items.length > 0) {
        const pastOrNow = snap.items.filter((item) => item.observed_at.localeCompare(nowRecentIso) <= 0);
        bridgeRecentItems.push(...pastOrNow.slice(0, 6));
      }
    }
    const recent_events = this.dedupeStreamItems(sqlRecentItems, bridgeRecentItems)
      .slice(0, 12)
      .map((item) => ({
        id: item.id,
        connector: item.connector,
        connector_label: item.connector_label,
        kind: item.kind,
        observed_at: item.observed_at,
        title: item.title,
        preview: cleanText(item.preview, 220),
      }));

    // Curated, deduplicated, diverse 12 recent docs across dashboards, owner, entities, world, and notes
    const latestDigestDoc = docIndex.byPath.get("dashboards/executive-digest-latest.md");
    const isDuplicateDatedDigest = (d: IndexedDoc): boolean => {
      if (!latestDigestDoc) return false;
      if (!/^dashboards\/executive-digest-\d{4}-\d{2}-\d{2}\.md$/i.test(d.path)) return false;
      return d.size === latestDigestDoc.size || d.title === latestDigestDoc.title;
    };

    const pulseCategoryQuotas: Array<{ category: string; quota: number; scan: number }> = [
      { category: "dashboards", quota: 2, scan: 8 },
      { category: "owner", quota: 2, scan: 6 },
      { category: "entities", quota: 2, scan: 8 },
      { category: "world", quota: 2, scan: 16 },
      { category: "notes", quota: 2, scan: 8 },
      { category: "obsidian", quota: 1, scan: 8 },
      { category: "apple-notes", quota: 1, scan: 8 },
    ];
    const pulseAllowedCats = new Set(pulseCategoryQuotas.map((q) => q.category));

    const bucketCandidates = new Map<string, IndexedDoc[]>();
    const toHydrate: IndexedDoc[] = [];
    for (const q of pulseCategoryQuotas) {
      const list = docIndex.entries
        .filter((d) => d.category === q.category && !isDuplicateDatedDigest(d))
        .slice(0, q.scan);
      bucketCandidates.set(q.category, list);
      toHydrate.push(...list);
    }
    await this.hydrateDocHeads(toHydrate);

    const selectedDocs: IndexedDoc[] = [];
    const selectedPaths = new Set<string>();
    const seenTitleKeys = new Set<string>();

    const tryTakeDoc = (d: IndexedDoc): boolean => {
      if (selectedPaths.has(d.path)) return false;
      if (isDuplicateDatedDigest(d)) return false;
      if (isGenericDocTitle(d.title)) return false;
      if (isLowSignalDoc(d)) return false;
      const titleKey = d.title.toLowerCase().trim();
      if (seenTitleKeys.has(titleKey)) return false;
      selectedPaths.add(d.path);
      seenTitleKeys.add(titleKey);
      selectedDocs.push(d);
      return true;
    };

    for (const q of pulseCategoryQuotas) {
      let taken = 0;
      for (const d of bucketCandidates.get(q.category) || []) {
        if (taken >= q.quota) break;
        if (tryTakeDoc(d)) taken++;
      }
    }

    if (selectedDocs.length < 12) {
      const overflowPool = docIndex.entries
        .filter((d) => pulseAllowedCats.has(d.category) && !selectedPaths.has(d.path) && !isDuplicateDatedDigest(d))
        .slice(0, 36);
      await this.hydrateDocHeads(overflowPool);
      for (const d of overflowPool) {
        if (selectedDocs.length >= 12) break;
        tryTakeDoc(d);
      }
    }

    selectedDocs.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const recent_docs = selectedDocs.slice(0, 12).map((d) => ({
      path: d.path,
      title: scrubOAuthUrls(d.title),
      category: d.category,
      updated_at: new Date(d.mtimeMs).toISOString(),
      size_bytes: d.size,
      preview: scrubOAuthUrls(d.excerpt || ""),
    }));

    // owner-anchors.md
    let ownerAnchorsContent = "";
    let ownerAnchorsUpdatedAt = new Date().toISOString();
    try {
      const anchorsPath = join(this.vaultPath, "owner-anchors.md");
      const [content, st] = await Promise.all([readFile(anchorsPath, "utf8"), stat(anchorsPath)]);
      ownerAnchorsContent = stripEmDashes(content);
      ownerAnchorsUpdatedAt = st.mtime.toISOString();
    } catch {
      ownerAnchorsContent = "";
    }

    // digest highlight (prefer executive-digest-latest.md)
    const digest_highlight = {
      name: digestBrief.latest.name || "brief-latest.md",
      updated_at: digestBrief.latest.updated_at || new Date().toISOString(),
      content: stripEmDashes(digestBrief.latest.markdown),
    };

    // top 6 verified MemT recipes
    const verifiedMemt = topMemtAll.filter((e) => e.outcome === "verified");
    const top_memt = (verifiedMemt.length >= 6 ? verifiedMemt : topMemtAll).slice(0, 6);

    // connectors_status: active native SQLite connectors + active personal-life bridges + remaining optional connectors
    const activeEntries: PulseResponse["connectors_status"] = [];
    const activeIndexById = new Map<string, number>();
    const satisfiedOptionalIds = new Set<string>();

    const maxIso = (a: string | null, b: string | null): string | null => {
      if (!a) return b;
      if (!b) return a;
      return a.localeCompare(b) >= 0 ? a : b;
    };

    for (const c of overview.vault.connectors) {
      activeIndexById.set(c.id, activeEntries.length);
      satisfiedOptionalIds.add(c.id);
      activeEntries.push({
        id: c.id,
        label: connectorLabel(c.id),
        status: "active",
        events: c.count,
        latest: c.latest,
        source_kind: "native",
      });
    }

    for (const snap of bridges) {
      if (snap.count <= 0) continue;
      satisfiedOptionalIds.add(snap.spec.id);
      for (const alias of snap.spec.sqlAliases) satisfiedOptionalIds.add(alias);
      for (const sup of snap.spec.suppressOptionalIds || []) satisfiedOptionalIds.add(sup);

      const matchedAlias = snap.spec.sqlAliases.find((alias) => activeIndexById.has(alias));
      if (matchedAlias !== undefined) {
        const idx = activeIndexById.get(matchedAlias)!;
        const existing = activeEntries[idx];
        existing.events = Math.max(existing.events, snap.count);
        existing.latest = maxIso(existing.latest, snap.latest);
        existing.source_kind = "hybrid";
      } else {
        activeIndexById.set(snap.spec.id, activeEntries.length);
        activeEntries.push({
          id: snap.spec.id,
          label: snap.spec.label,
          status: "active",
          events: snap.count,
          latest: snap.latest,
          source_kind: "bridge",
        });
      }
    }

    activeEntries.sort((a, b) => b.events - a.events);

    const connectors_status: PulseResponse["connectors_status"] = [...activeEntries];
    for (const opt of OPTIONAL_CONNECTOR_CATALOG) {
      if (satisfiedOptionalIds.has(opt.id)) continue;
      connectors_status.push({
        id: opt.id,
        label: opt.label,
        status: opt.status,
        events: 0,
        latest: null,
        command: opt.command,
      });
    }

    const pulse: PulseResponse = {
      overview,
      docs_summary: {
        total: docIndex.entries.length,
        categories: docIndex.categories,
      },
      activity_14d,
      recent_events,
      recent_docs,
      owner_anchors: {
        path: "owner-anchors.md",
        content: ownerAnchorsContent,
        updated_at: ownerAnchorsUpdatedAt,
      },
      digest_highlight,
      top_memt,
      connectors_status,
    };

    return pulse;
  }

  // =========================================================================
  // Personal Mind OS: Actions, Unified Personal Index, Today, People,
  // Omni-Search, and Local-Only Dual-Engine Drafts
  // =========================================================================

  private normalizeActionTag(raw: unknown): OwnerActionTag {
    const s = String(raw || "").trim().toLowerCase();
    if (s === "family") return "Family";
    if (s === "work") return "Work";
    if (s === "reply") return "Reply";
    return "Personal";
  }

  private async writeActionsAtomic(actions: OwnerAction[]): Promise<void> {
    const dir = dirname(this.actionsPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmpPath = join(dir, `.${basename(this.actionsPath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(tmpPath, JSON.stringify(actions, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(tmpPath, this.actionsPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      throw err;
    }
  }

  private async buildInitialSeedActions(): Promise<OwnerAction[]> {
    const nowIso = new Date().toISOString();
    let nextMeetingTitle = "upcoming calendar sync";
    let nextMeetingDetail = "Review participants, agenda, and open action items before the call.";
    try {
      const calEvents = await this.loadCalendarEvents();
      const nowMs = Date.now();
      const upcoming = calEvents.find(
        (e) =>
          e.startMs >= nowMs - 30 * 60_000 &&
          !/school run|pick up|birthday/i.test(e.title)
      );
      if (upcoming) {
        nextMeetingTitle = upcoming.title;
        nextMeetingDetail = `Scheduled ${upcoming.start.slice(0, 16).replace("T", " ")} UTC (${upcoming.calendar})${upcoming.participants.length > 0 ? ` with ${upcoming.participants.slice(0, 3).join(", ")}` : ""}.`;
      }
    } catch {
      // keep default seed text
    }

    return [
      {
        id: "act_review_open_loops",
        title: "Review open vault action items and priorities",
        detail: "Audit active vault tasks and confirm next deadlines for the week.",
        tag: "Work",
        done: false,
        source: "vault-open-loop",
        created_at: nowIso,
      },
      {
        id: "act_prep_next_meeting",
        title: cleanText(`Prep for ${nextMeetingTitle}`, 96),
        detail: cleanText(nextMeetingDetail, 240),
        tag: "Work",
        done: false,
        source: "mac-calendar",
        created_at: nowIso,
      },
    ];
  }

  private async loadOrSeedActions(): Promise<OwnerAction[]> {
    try {
      const st = await stat(this.actionsPath);
      if (
        this.actionsCache &&
        this.actionsCache.mtimeMs === st.mtimeMs &&
        this.actionsCache.size === st.size
      ) {
        return this.actionsCache.actions;
      }
      const raw = await readFile(this.actionsPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" && Array.isArray((parsed as { actions?: unknown }).actions)
          ? (parsed as { actions: unknown[] }).actions
          : null;
      if (arr) {
        const normalized = arr
          .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
          .map((item, idx) => ({
            id: typeof item.id === "string" && item.id.trim() ? item.id.trim() : `act_${idx + 1}`,
            title: cleanText(String(item.title || "Untitled action"), 160),
            detail: cleanText(String(item.detail || ""), 400),
            tag: this.normalizeActionTag(item.tag),
            done: Boolean(item.done),
            source: cleanText(String(item.source || "manual"), 80),
            created_at: typeof item.created_at === "string" && item.created_at ? item.created_at : new Date().toISOString(),
          }));
        this.actionsCache = { mtimeMs: st.mtimeMs, size: st.size, actions: normalized };
        return normalized;
      }
    } catch (err: unknown) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "ENOENT") {
        // Corrupt file fallback: re-seed cleanly
      }
    }
    const seeded = await this.buildInitialSeedActions();
    await this.writeActionsAtomic(seeded);
    try {
      const st = await stat(this.actionsPath);
      this.actionsCache = { mtimeMs: st.mtimeMs, size: st.size, actions: seeded };
    } catch {
      this.actionsCache = null;
    }
    return seeded;
  }

  async getActions(): Promise<{ ok: true; actions: OwnerAction[] }> {
    const actions = await this.loadOrSeedActions();
    return { ok: true, actions };
  }

  async mutateActions(req: ActionMutationRequest): Promise<{ ok: true; actions: OwnerAction[] }> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Request body must be a JSON object");
    }
    const op = req.op;
    const actions = await this.loadOrSeedActions();

    const commitActions = async (updated: OwnerAction[]): Promise<{ ok: true; actions: OwnerAction[] }> => {
      await this.writeActionsAtomic(updated);
      try {
        const st = await stat(this.actionsPath);
        this.actionsCache = { mtimeMs: st.mtimeMs, size: st.size, actions: updated };
      } catch {
        this.actionsCache = null;
      }
      this.actionsVersion += 1;
      this.todayMemo.clear();
      return { ok: true, actions: updated };
    };

    if (op === "add") {
      const title = cleanText(String(req.title || ""), 160);
      if (!title) {
        throw new BadRequestError("title is required for add operation");
      }
      const next: OwnerAction = {
        id: `act_${randomUUID().slice(0, 8)}`,
        title,
        detail: cleanText(String(req.detail || ""), 400),
        tag: this.normalizeActionTag(req.tag),
        done: false,
        source: cleanText(String(req.source || "manual"), 80) || "manual",
        created_at: new Date().toISOString(),
      };
      return commitActions([next, ...actions]);
    }

    if (op === "toggle") {
      const id = String(req.id || "").trim();
      if (!id) throw new BadRequestError("id is required for toggle operation");
      const target = actions.find((a) => a.id === id);
      if (!target) throw new NotFoundError(`Action not found: ${id}`);
      const updated = actions.map((a) => (a.id === id ? { ...a, done: !a.done } : a));
      return commitActions(updated);
    }

    if (op === "delete") {
      const id = String(req.id || "").trim();
      if (!id) throw new BadRequestError("id is required for delete operation");
      const exists = actions.some((a) => a.id === id);
      if (!exists) throw new NotFoundError(`Action not found: ${id}`);
      const updated = actions.filter((a) => a.id !== id);
      return commitActions(updated);
    }

    throw new BadRequestError(`Unsupported actions op: ${String(op)}`);
  }

  private formatRelativeAge(iso: string | null | undefined, nowMs = Date.now()): string {
    if (!iso) return "No recent msg";
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return "No recent msg";
    const diffMs = Math.max(0, nowMs - ms);
    const mins = Math.floor(diffMs / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(days / 365)}y ago`;
  }

  private async readJsonlObjects(filePath: string): Promise<Array<Record<string, unknown>>> {
    if (SECRET_PATH_RE.test(filePath)) return [];
    try {
      const raw = await readFile(filePath, "utf8");
      const out: Array<Record<string, unknown>> = [];
      const lines = raw.split(/\r?\n/);
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t) as unknown;
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            out.push(obj as Record<string, unknown>);
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

  private async loadCalendarEvents(): Promise<ParsedCalendarEvent[]> {
    const filePath = join(this.bridgesDir, "mac-calendar", "events.jsonl");
    const rows = await this.readJsonlObjects(filePath);
    const out: ParsedCalendarEvent[] = [];
    const fallbackIso = new Date().toISOString();

    for (let idx = 0; idx < rows.length; idx++) {
      const obj = rows[idx];
      const rawText = stripEmDashes(String(obj.text || ""));
      const firstLine = rawText.split(/\r?\n/)[0] || "";
      const derivedTitle =
        (typeof obj.title === "string" && obj.title.trim()) ||
        firstLine.replace(/^#+\s*/, "").trim() ||
        "Calendar Event";
      const cleanTitle = cleanText(cleanDisplayText(derivedTitle), 110) || "Calendar Event";
      const start = this.normalizeBridgeTimestamp(obj.occurred_at ?? obj.start, fallbackIso);
      const startMs = Date.parse(start);
      if (Number.isNaN(startMs)) continue;
      const endRaw = obj.end_at ?? obj.end;
      const end = endRaw ? this.normalizeBridgeTimestamp(endRaw, start) : null;
      const endMs = end ? Date.parse(end) : null;
      const partStr = typeof obj.participants === "string" ? obj.participants : "";
      const participants = Array.from(
        new Set(
          partStr
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0)
        )
      );
      const parsedBody = parseCalendarBody(rawText, cleanTitle);
      const cleanNotes = parsedBody.notes.slice(0, 4000);
      out.push({
        id: String(obj.id || `maccal:${idx}`),
        title: cleanTitle,
        calendar: cleanText(String(obj.calendar || "Calendar"), 80),
        start,
        startMs,
        end,
        endMs: endMs !== null && !Number.isNaN(endMs) ? endMs : null,
        participants,
        meet_url: parsedBody.meet_url,
        dial_in: parsedBody.dial_in,
        notes: cleanNotes,
        raw_text: cleanNotes,
      });
    }

    out.sort((a, b) => a.startMs - b.startMs);
    return out;
  }

  private async loadWhoopSummary(): Promise<WhoopSummary> {
    const filePath = join(this.bridgesDir, "whoop", "events.jsonl");
    const rows = await this.readJsonlObjects(filePath);
    if (rows.length === 0) {
      return {
        date: null,
        age_days: null,
        is_stale: true,
        recovery_pct: null,
        recovery_zone: null,
        hrv_ms: null,
        rhr_bpm: null,
        sleep_hours: null,
        summary: "No Whoop biometric records synced yet.",
      };
    }

    let latest = rows[0];
    let latestKey = String(latest.day || latest.occurred_at || "");
    for (const r of rows) {
      const k = String(r.day || r.occurred_at || "");
      if (k.localeCompare(latestKey) >= 0) {
        latest = r;
        latestKey = k;
      }
    }

    const numOrNull = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string" && v.trim() !== "") {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
      return null;
    };

    const date =
      typeof latest.day === "string" && latest.day
        ? latest.day
        : typeof latest.occurred_at === "string" && latest.occurred_at
          ? latest.occurred_at.slice(0, 10)
          : null;
    const parsedDateMs = date ? Date.parse(`${date}T00:00:00Z`) : NaN;
    const ageDays = Number.isFinite(parsedDateMs)
      ? Math.max(0, Math.floor((Date.now() - parsedDateMs) / 86400_000))
      : null;
    const isStale = ageDays === null ? true : ageDays > 2;
    const recoveryPct = numOrNull(latest.recovery_score ?? latest.recovery_pct);
    const recoveryZone = typeof latest.zone === "string" && latest.zone ? latest.zone.toUpperCase() : null;
    const hrvMs = numOrNull(latest.hrv_ms);
    const rhrBpm = numOrNull(latest.rhr_bpm);
    const sleepHours = numOrNull(latest.sleep_hours);

    const parts: string[] = [];
    if (recoveryPct !== null) {
      parts.push(`Recovery ${recoveryPct}%${recoveryZone ? ` (${recoveryZone})` : ""}`);
    }
    if (hrvMs !== null) parts.push(`HRV ${hrvMs} ms`);
    if (rhrBpm !== null) parts.push(`RHR ${rhrBpm} bpm`);
    if (sleepHours !== null) parts.push(`Sleep ${sleepHours}h`);

    const summary =
      parts.length > 0
        ? parts.join(" | ")
        : cleanText(String(latest.text || "Whoop telemetry synced."), 180);

    return {
      date,
      age_days: ageDays,
      is_stale: isStale,
      recovery_pct: recoveryPct,
      recovery_zone: recoveryZone,
      hrv_ms: hrvMs,
      rhr_bpm: rhrBpm,
      sleep_hours: sleepHours,
      summary: stripEmDashes(summary),
    };
  }

  private computeInitials(name: string): string {
    const cleaned = stripEmDashes(String(name || ""))
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .trim();
    if (!cleaned) return "?";
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return `${Array.from(parts[0])[0] || ""}${Array.from(parts[1])[0] || ""}`.toUpperCase();
    }
    return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
  }

  private isGroupChatName(name: string): boolean {
    const n = String(name || "").trim();
    if (!n) return false;
    if (/(?:[^/]+\/){2,}/.test(n)) return true;
    return /\b(circle|team chat|group|community|traders|elites|district|channel|announcements?|network spotlight|builders|tar heels|classic|validators?|watcher[\s._-]*guru|just\s+in:|lookonchain|whale[\s._-]*alert|coindesk|cointelegraph|decrypt|the\s+block|news[\s._-]*bot|alerts?|year\s+\d+\b)\b/i.test(
      n
    );
  }

  private isNoisyGroupSnippet(snippet: string): boolean {
    return /^\[(?:NEAR Classic|Network Spotlight|Lit Builders|Sui Traders|Grind District)[^\]]*\]|\$Shade|Grind District|announcement post for more details/i.test(
      String(snippet || "")
    );
  }

  private normalizePersonKey(raw: string): string {
    const trimmed = stripEmDashes(raw).trim().toLowerCase();
    if (/^\+?\d{7,15}$/.test(trimmed)) {
      return trimmed.startsWith("+") ? trimmed : `+${trimmed}`;
    }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      return trimmed;
    }
    const slug = trimmed
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    return slug || "contact";
  }

  private isSelfIdentity(nameOrAddr: string): boolean {
    const lower = nameOrAddr.trim().toLowerCase();
    if (!lower) return true;
    const ownerName = (process.env.KIZUKI_OWNER_NAME || "").trim().toLowerCase();
    const ownerEmails = (process.env.KIZUKI_OWNER_EMAILS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    return (
      lower === "owner" ||
      lower === "you" ||
      lower === "me" ||
      lower === "self" ||
      (ownerName.length > 0 && lower === ownerName) ||
      ownerEmails.some((em) => lower.includes(em)) ||
      lower.includes("unknownorganizer@calendar.google.com")
    );
  }

  private parseEmailAddressField(raw: string): { name: string; email: string } {
    const s = stripEmDashes(raw || "").trim();
    const m = s.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
    if (m) {
      const email = m[2].trim().toLowerCase();
      const name = m[1].trim() || email;
      return { name, email };
    }
    if (s.includes("@")) {
      const email = s.replace(/[<>]/g, "").trim().toLowerCase();
      const local = email.split("@")[0].replace(/[._-]+/g, " ");
      const nice = local.replace(/\b\w/g, (c) => c.toUpperCase());
      return { name: nice || email, email };
    }
    return { name: s || "Unknown", email: "" };
  }

  private isNoisyTelegramChannel(
    channel: string,
    threadTitle: string,
    sender: string,
    body = ""
  ): boolean {
    const hay = `${channel} ${threadTitle} ${sender}`.toLowerCase();
    if (
      /(?:^|[:_\s-])(sui-traders|lookonchain|dexscreener|cryptonear|soylana|all-street-bets|shitzu|lonkonnear|monad-cucks|sui-to-5|devnet-debauchery|solana-uk|stuk-members-lounge|ai-psychosis|theemptyboxclub|spidersjournal|jollycrates|tattothetoo|watcherguru|watcher\s+guru|whale[\s_-]*alert|coindesk|cointelegraph|decrypt|the\s+block|news[\s_-]*bot|just\s+in:|pump|airdrop|signals|alerts|whale|scanner|sniper|degen|traders|memecoin|broadcast|announcements?|botfather|cryptonews|coinmarketcap|coingecko)(?:$|[:_\s-])/i.test(
        hay
      )
    ) {
      return true;
    }
    const chSlug = channel.replace(/^telegram:/i, "").trim().toLowerCase();
    const senderLower = sender.trim().toLowerCase();
    const titleLower = threadTitle.trim().toLowerCase();
    if (chSlug.endsWith("bot") || titleLower.endsWith("bot") || senderLower.endsWith("bot")) {
      return true;
    }
    if (
      senderLower === "group help" ||
      senderLower === "rose" ||
      senderLower === "missrose" ||
      senderLower === "combot" ||
      senderLower === "shieldy" ||
      senderLower === "safeguard" ||
      senderLower === "group butler" ||
      /\b(?:group\s*help|miss\s*rose|combot|shieldy|safeguard|group\s*butler|captcha\s*bot)\b/i.test(
        `${senderLower} ${titleLower}`
      )
    ) {
      return true;
    }
    const bodySlice = String(body || "").slice(0, 1200);
    if (
      bodySlice &&
      /(?:\bpress\s+the\s+button\b|\bverify\s+(?:you\s+are\s+human|within|below|now)\b|\bwithin\s+\d+\s+minutes?\s+to\s+(?:be\s+able\s+to\s+)?(?:write|chat|send|post|speak)\b|\bwelcome\s+[^\n]{1,64}\s+to\s+|\bimportant\s+security\s+update\b|\bofficial\s+contract\s*:)/i.test(
        bodySlice
      )
    ) {
      return true;
    }
    return false;
  }

  private isNoisyWhatsAppChannel(channel: string, threadTitle: string): boolean {
    return isNoiseMessage({ channel: "whatsapp", channelKey: channel, threadTitle });
  }

  private isNoisyIMessage(sender: string, body: string): boolean {
    return isNoiseMessage({ channel: "imessage", sender, threadTitle: sender, body });
  }

  private isNoisyGmail(fromAddr: string, subject: string, body: string): boolean {
    return isNoiseMessage({ channel: "gmail", from: fromAddr, sender: fromAddr, subject, body });
  }

  private toPersonDirectoryItem(p: PersonIndexRecord): PersonDirectoryItem {
    return {
      key: p.key,
      name: p.name,
      initials: p.initials,
      channels: Array.from(p.channels).filter((ch) => ch !== "calendar" || p.meetings.length > 0).sort(),
      message_count: p.message_count,
      claim_count: p.claim_count,
      meeting_count: p.meetings.length,
      last_seen: p.last_seen_iso,
      last_seen_iso: p.last_seen_iso,
      last_seen_label: p.last_seen_label,
      first_seen: p.first_seen,
      last_snippet: p.last_snippet,
      preview: p.preview,
      next_meeting: p.next_meeting,
      profile_tier: p.profile_tier,
      relationship_tier: p.relationship_tier,
      relationship_state: p.relationship_state,
      trajectory: p.trajectory,
      role: p.role,
      org: p.org,
      has_leverage_map: p.has_leverage_map,
    };
  }

  private scorePersonSearchMatch(p: PersonIndexRecord, qLower: string): number {
    const qSlug = normalizeSlug(qLower);
    const nameLower = p.name.toLowerCase();
    const keyLower = p.key.toLowerCase();

    // Escape regex special characters for word-boundary matching
    const esc = qLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordBoundaryRe = new RegExp(`(?:^|[\\s\\-_./(@])${esc}`, "i");

    // 1. Exact match on name, key, or non-email alias
    if (nameLower === qLower || keyLower === qLower || (qSlug && keyLower === qSlug)) {
      return 1200;
    }
    for (const rawAl of p.raw_aliases) {
      const alLower = rawAl.toLowerCase();
      if (alLower === qLower || alLower === `@${qLower}`) return 1100;
    }

    // 2. Word-boundary prefix match on name, key, or non-email alias
    if (wordBoundaryRe.test(nameLower) || wordBoundaryRe.test(keyLower)) {
      return 700;
    }
    for (const rawAl of p.raw_aliases) {
      if (rawAl.includes("@")) continue;
      if (wordBoundaryRe.test(rawAl)) return 600;
    }

    // 3. Substring match on name or key (excluding pure email keys)
    if (nameLower.includes(qLower) || (!keyLower.includes("@") && keyLower.includes(qLower))) {
      return 320;
    }
    for (const rawAl of p.raw_aliases) {
      if (rawAl.includes("@")) continue;
      if (rawAl.toLowerCase().includes(qLower)) return 260;
    }

    // 4. Match in email local part (before @), never inflated by domain substrings like custOMERemail
    for (const rawAl of [...p.raw_aliases, p.key]) {
      if (!rawAl.includes("@")) continue;
      const [localPart] = rawAl.toLowerCase().split("@");
      if (localPart && wordBoundaryRe.test(localPart)) return 220;
      if (localPart && localPart.includes(qLower)) return 140;
    }

    // 5. Role, org, or canonical_read word-boundary match
    const metaHay = `${p.role} ${p.org} ${p.canonical_card?.world_model.canonical_read || ""}`.toLowerCase();
    if (metaHay && wordBoundaryRe.test(metaHay)) return 120;
    if (metaHay && metaHay.includes(qLower)) return 80;

    // 6. Preview or channel match (weakest)
    if (p.preview.toLowerCase().includes(qLower)) return 30;
    for (const ch of p.channels) {
      if (ch.toLowerCase().includes(qLower)) return 15;
    }

    return 0;
  }

  private formatHistorySpanLabel(firstSeen: string | null, lastSeen: string | null): string {
    const y1 = firstSeen ? firstSeen.slice(0, 4) : "";
    const y2 = lastSeen ? lastSeen.slice(0, 4) : "";
    if (y1 && y2) return y1 === y2 ? y1 : `${y1} - ${y2}`;
    if (y1) return `Since ${y1}`;
    if (y2) return y2;
    return "Profiled";
  }

  private async buildPersonalIndex(): Promise<PersonalIndexSnapshot> {
    const [waRows, tgRows, imsgRows, gmailRows, calendar, whoop, loadedCards] = await Promise.all([
      this.readJsonlObjects(join(this.bridgesDir, "whatsapp", "events.jsonl")),
      this.readJsonlObjects(join(this.bridgesDir, "telegram", "events.jsonl")),
      this.readJsonlObjects(join(this.bridgesDir, "mac-imessage", "events.jsonl")),
      this.readJsonlObjects(join(this.bridgesDir, "gmail", "events.jsonl")),
      this.loadCalendarEvents(),
      this.loadWhoopSummary(),
      loadCanonicalPersonCards({
        vaultPath: this.vaultPath,
        lifeosPeopleDir: this.lifeosPeopleDir,
        relationshipsDir: this.relationshipsDir,
      }),
    ]);

    const nowMs = Date.now();
    const fallbackIso = new Date(nowMs).toISOString();
    const messages: ParsedPersonalMessage[] = [];
    const cardMatcher = createCanonicalCardMatcher(loadedCards.cards);

    // Pre-scan Telegram channel volume + unique sender cardinality to detect public mega-groups automatically
    const tgChannelSenders = new Map<string, Set<string>>();
    const tgChannelCounts = new Map<string, number>();
    for (const obj of tgRows) {
      const ch = String(obj.channel || "").toLowerCase();
      if (!ch) continue;
      tgChannelCounts.set(ch, (tgChannelCounts.get(ch) || 0) + 1);
      const rawText = String(obj.text || "");
      const m = rawText.match(/^\[Telegram\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:/);
      if (m && m[2]) {
        const set = tgChannelSenders.get(ch) || new Set<string>();
        if (set.size < 25) set.add(m[2].trim().toLowerCase());
        tgChannelSenders.set(ch, set);
      }
    }

    // 1. Parse WhatsApp
    for (let idx = 0; idx < waRows.length; idx++) {
      const obj = waRows[idx];
      const occurredAt = this.normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
      const rawText = stripEmDashes(String(obj.text || ""));
      const m = rawText.match(/^\[WhatsApp\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:\s*([\s\S]*)$/);
      const threadTitle = cleanText(m?.[1] || String(obj.channel || "WhatsApp").replace(/^whatsapp:/i, ""), 72);
      const sender = cleanText(m?.[2] || threadTitle, 64);
      const body = cleanDisplayText((m?.[3] ?? rawText).trim());
      const channelKey = String(obj.channel || `whatsapp:${this.normalizePersonKey(threadTitle)}`).toLowerCase();
      const isNoise = this.isNoisyWhatsAppChannel(channelKey, threadTitle);
      messages.push({
        id: String(obj.id || `wa:${idx}`),
        channel: "whatsapp",
        channel_label: "WhatsApp",
        thread_key: channelKey,
        sender,
        thread_title: threadTitle,
        preview: cleanText(body || rawText, 180),
        full_text: (body || cleanDisplayText(rawText)).slice(0, 4000),
        occurred_at: occurredAt,
        is_noise: isNoise,
      });
    }

    // 2. Parse Telegram
    for (let idx = 0; idx < tgRows.length; idx++) {
      const obj = tgRows[idx];
      const occurredAt = this.normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
      const rawText = stripEmDashes(String(obj.text || ""));
      const m = rawText.match(/^\[Telegram\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:\s*([\s\S]*)$/);
      const threadTitle = cleanText(m?.[1] || String(obj.channel || "Telegram").replace(/^telegram:/i, ""), 72);
      const sender = cleanText(m?.[2] || threadTitle, 64);
      const body = cleanDisplayText((m?.[3] ?? rawText).trim());
      const channelKey = String(obj.channel || `telegram:${this.normalizePersonKey(threadTitle)}`).toLowerCase();
      const senderCardinality = tgChannelSenders.get(channelKey)?.size || 0;
      const channelTotal = tgChannelCounts.get(channelKey) || 0;
      const isMegaGroup = channelTotal >= 120 && senderCardinality >= 8;
      const isNoise = isMegaGroup || this.isNoisyTelegramChannel(channelKey, threadTitle, sender, body);
      messages.push({
        id: String(obj.id || `tg:${idx}`),
        channel: "telegram",
        channel_label: "Telegram",
        thread_key: channelKey,
        sender,
        thread_title: threadTitle,
        preview: cleanText(body || rawText, 180),
        full_text: (body || cleanDisplayText(rawText)).slice(0, 4000),
        occurred_at: occurredAt,
        is_noise: isNoise,
      });
    }

    // 3. Parse iMessage
    for (let idx = 0; idx < imsgRows.length; idx++) {
      const obj = imsgRows[idx];
      const occurredAt = this.normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
      const rawText = stripEmDashes(String(obj.text || ""));
      const lines = rawText.split(/\r?\n/);
      const rawBody = (lines[0]?.startsWith("[iMessage") ? lines.slice(1).join("\n") : rawText).trim();
      const body = cleanDisplayText(rawBody);
      const chat = cleanText(String(obj.chat || obj.sender || "iMessage"), 64);
      const direction = String(obj.direction || "inbound").toLowerCase();
      const sender = direction === "outbound" ? "You" : cleanText(String(obj.sender || chat), 64);
      const threadKey = `imessage:${chat.toLowerCase()}`;
      const isNoise = this.isNoisyIMessage(chat, body);
      messages.push({
        id: String(obj.id || `imsg:${idx}`),
        channel: "imessage",
        channel_label: "iMessage",
        thread_key: threadKey,
        sender,
        thread_title: chat,
        preview: cleanText(body || rawBody, 180),
        full_text: (body || cleanDisplayText(rawText)).slice(0, 4000),
        occurred_at: occurredAt,
        is_noise: isNoise,
      });
    }

    // 4. Parse Gmail
    for (let idx = 0; idx < gmailRows.length; idx++) {
      const obj = gmailRows[idx];
      const occurredAt = this.normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
      const fromRaw = String(obj.from_addr || "");
      const toRaw = String(obj.to_addr || "");
      const folder = String(obj.folder || "INBOX");
      const subject = cleanText(cleanDisplayText(String(obj.subject_line || obj.subject || "(No subject)")), 110);
      const rawText = stripEmDashes(String(obj.text || ""));
      const parsedFrom = this.parseEmailAddressField(fromRaw);
      const parsedTo = this.parseEmailAddressField(toRaw);
      const isSent = folder.toLowerCase() === "sent" || this.isSelfIdentity(parsedFrom.email || parsedFrom.name);
      const counterpart = isSent ? parsedTo : parsedFrom;
      const normSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/gi, "").trim().toLowerCase().slice(0, 64);
      const threadKey = `gmail:${counterpart.email || this.normalizePersonKey(counterpart.name)}:${this.normalizePersonKey(normSubj)}`;
      const cleanBody = cleanEmailDisplayBody(rawText);
      const isNoise = this.isNoisyGmail(isSent ? toRaw : fromRaw, subject, `${rawText}\n${cleanBody}`);
      messages.push({
        id: String(obj.id || `gmail:${idx}`),
        channel: "gmail",
        channel_label: "Gmail",
        thread_key: threadKey,
        sender: isSent ? `You -> ${counterpart.name}` : parsedFrom.name,
        thread_title: subject,
        preview: cleanText(cleanBody || subject, 180),
        full_text: (cleanBody || subject).slice(0, 4000),
        occurred_at: occurredAt,
        is_noise: isNoise,
      });
    }

    // Sort all messages newest-first
    messages.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

    // Build deduplicated inboxThreads (newest per thread_key + message_count)
    const threadMap = new Map<string, { latest: ParsedPersonalMessage; count: number }>();
    for (const msg of messages) {
      const existing = threadMap.get(msg.thread_key);
      if (!existing) {
        threadMap.set(msg.thread_key, { latest: msg, count: 1 });
      } else {
        existing.count++;
      }
    }

    const inboxThreads: TodayInboxItem[] = Array.from(threadMap.values())
      .map(({ latest, count }) => ({
        id: latest.id,
        channel: latest.channel,
        channel_label: latest.channel_label,
        thread_key: latest.thread_key,
        sender: latest.sender,
        thread_title: latest.thread_title,
        preview: latest.preview,
        full_text: latest.full_text,
        occurred_at: latest.occurred_at,
        is_noise: latest.is_noise,
        message_count: count,
      }))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

    // Build unified cross-channel People & Thread directory fused with canonical LifeOS + world/people cards
    // Strictly isolate past interactions (<= now) from future calendar invites (> now).
    const peopleByKey = new Map<string, PersonIndexRecord>();
    const aliasToKey = new Map<string, string>();
    const timelineIdsByPerson = new Map<string, Set<string>>();

    const attachCanonicalCard = (rec: PersonIndexRecord, card: CanonicalPersonCard): void => {
      rec.canonical_card = card;
      rec.name = card.canonical_name;
      rec.initials = this.computeInitials(card.canonical_name);
      rec.is_group = false;
      rec.profile_tier = card.profile_tier;
      rec.relationship_tier = card.world_model.relationship_tier;
      rec.relationship_state = card.world_model.relationship_state;
      rec.trajectory = card.world_model.velocity?.trajectory || rec.trajectory;
      rec.role = card.world_model.role;
      rec.org = card.world_model.org;
      rec.has_leverage_map =
        card.world_model.our_leverage.length > 0 || card.world_model.their_leverage.length > 0;
      rec.aliases.add(card.slug);
      aliasToKey.set(card.slug, rec.key);
      for (const mSlug of card.merged_from) {
        rec.aliases.add(mSlug);
        aliasToKey.set(mSlug, rec.key);
      }
      rec.raw_aliases.add(card.canonical_name);
      if (card.display_name) rec.raw_aliases.add(card.display_name);
      for (const al of card.world_model.aliases) {
        rec.raw_aliases.add(al);
        const nk = this.normalizePersonKey(al);
        if (nk && nk.length >= 2) rec.aliases.add(nk);
      }
      for (const em of card.match_tokens.emails) {
        rec.raw_aliases.add(em);
        rec.aliases.add(em);
        aliasToKey.set(em, rec.key);
      }
      for (const h of card.match_tokens.handles) {
        rec.raw_aliases.add(h);
        rec.aliases.add(h);
      }
    };

    const upsertPerson = (opts: {
      rawKey: string;
      displayName: string;
      email?: string;
      channel: string;
      occurredAt: string;
      snippet: string;
      isMessage: boolean;
      isGroup?: boolean;
      extraAliases?: string[];
      timelineItem?: { id: string; channel: string; sender: string; occurred_at: string; text: string };
      meeting?: ParsedCalendarEvent;
    }): void => {
      const cleanName = cleanText(opts.displayName, 64);
      if (!cleanName || this.isSelfIdentity(cleanName) || this.isSelfIdentity(opts.rawKey)) return;

      const occMs = Date.parse(opts.occurredAt);
      const isPast = !Number.isNaN(occMs) && occMs <= nowMs;

      const matchedCard = opts.isGroup
        ? null
        : cardMatcher.match({
            rawKey: opts.rawKey,
            displayName: cleanName,
            email: opts.email,
            extraAliases: opts.extraAliases,
          });

      const candidateKey = this.normalizePersonKey(opts.rawKey);
      let resolvedKey = matchedCard
        ? matchedCard.slug
        : aliasToKey.get(candidateKey) || aliasToKey.get(this.normalizePersonKey(cleanName)) || candidateKey;

      if (!matchedCard && opts.extraAliases) {
        for (const al of opts.extraAliases) {
          const nk = this.normalizePersonKey(al);
          if (aliasToKey.has(nk)) {
            resolvedKey = aliasToKey.get(nk)!;
            break;
          }
        }
      }

      let rec = peopleByKey.get(resolvedKey);
      if (!rec) {
        const initName = matchedCard ? matchedCard.canonical_name : cleanName;
        rec = {
          key: resolvedKey,
          name: initName,
          initials: this.computeInitials(initName),
          channels: new Set<string>(),
          message_count: 0,
          past_message_count: 0,
          claim_count: 0,
          last_seen: null,
          last_seen_iso: null,
          last_seen_label: "No recent msg",
          first_seen: null,
          last_snippet: "",
          preview: "",
          last_message_iso: null,
          last_message_snippet: "",
          last_past_meeting_iso: null,
          last_past_meeting_snippet: "",
          next_meeting: null,
          is_group: matchedCard ? false : Boolean(opts.isGroup),
          timeline: [],
          meetings: [],
          aliases: new Set<string>([resolvedKey, candidateKey, this.normalizePersonKey(cleanName)]),
          raw_aliases: new Set<string>([cleanName, ...(opts.email ? [opts.email] : [])]),
          canonical_card: null,
          profile_tier: "live",
          relationship_tier: "Ambient",
          relationship_state: "active",
          trajectory: "",
          role: "",
          org: "",
          has_leverage_map: false,
        };
        if (matchedCard) attachCanonicalCard(rec, matchedCard);
        peopleByKey.set(resolvedKey, rec);
      } else {
        if (matchedCard && !rec.canonical_card) {
          attachCanonicalCard(rec, matchedCard);
        } else if (!rec.canonical_card) {
          // Upgrade email/phone display name to human display name if available
          if ((rec.name.includes("@") || /^\+?\d+$/.test(rec.name)) && !cleanName.includes("@") && !/^\+?\d+$/.test(cleanName)) {
            rec.name = cleanName;
            rec.initials = this.computeInitials(cleanName);
          }
          if (opts.isGroup === false) {
            rec.is_group = false;
          }
        }
      }

      // Strictly track last_seen / first_seen from past interactions (ts <= now) ONLY
      if (isPast) {
        if (!rec.last_seen_iso || opts.occurredAt.localeCompare(rec.last_seen_iso) > 0) {
          rec.last_seen_iso = opts.occurredAt;
          rec.last_seen = opts.occurredAt;
        }
        if (!rec.first_seen || opts.occurredAt.localeCompare(rec.first_seen) < 0) {
          rec.first_seen = opts.occurredAt;
        }
        if (opts.isMessage) {
          rec.past_message_count++;
          if (!rec.last_message_iso || opts.occurredAt.localeCompare(rec.last_message_iso) > 0) {
            rec.last_message_iso = opts.occurredAt;
            if (opts.snippet && (!this.isNoisyGroupSnippet(opts.snippet) || !rec.last_message_snippet)) {
              rec.last_message_snippet = cleanText(opts.snippet, 180);
            }
          } else if (
            opts.snippet &&
            this.isNoisyGroupSnippet(rec.last_message_snippet) &&
            !this.isNoisyGroupSnippet(opts.snippet)
          ) {
            rec.last_message_snippet = cleanText(opts.snippet, 180);
          }
        } else if (opts.meeting) {
          if (!rec.last_past_meeting_iso || opts.occurredAt.localeCompare(rec.last_past_meeting_iso) > 0) {
            rec.last_past_meeting_iso = opts.occurredAt;
            if (opts.snippet) rec.last_past_meeting_snippet = cleanText(opts.snippet, 180);
          }
        }
      }

      rec.channels.add(opts.channel);
      rec.message_count++;
      rec.raw_aliases.add(cleanName);
      if (opts.email) rec.raw_aliases.add(opts.email);
      aliasToKey.set(resolvedKey, resolvedKey);
      // Do not bind single generic first-name aliases to non-canonical records that could collide
      if (!candidateKey.includes("@") || opts.email) {
        aliasToKey.set(candidateKey, resolvedKey);
      }
      if (!matchedCard) {
        aliasToKey.set(this.normalizePersonKey(cleanName), resolvedKey);
      }
      if (opts.extraAliases) {
        for (const al of opts.extraAliases) {
          if (al) rec.raw_aliases.add(al);
          const nk = this.normalizePersonKey(al);
          if (nk && nk.length >= 2) {
            rec.aliases.add(nk);
            if (!matchedCard) {
              aliasToKey.set(nk, resolvedKey);
            }
          }
        }
      }

      // Preserve up to 1,500 historical messages per person (deduplicated by message ID)
      if (opts.timelineItem && isPast && rec.timeline.length < 1500) {
        let seenIds = timelineIdsByPerson.get(resolvedKey);
        if (!seenIds) {
          seenIds = new Set<string>();
          timelineIdsByPerson.set(resolvedKey, seenIds);
        }
        if (!seenIds.has(opts.timelineItem.id)) {
          seenIds.add(opts.timelineItem.id);
          rec.timeline.push(opts.timelineItem);
        }
      }
      if (opts.meeting && !rec.meetings.some((m) => m.id === opts.meeting!.id)) {
        rec.meetings.push(opts.meeting);
      }
    };

    // Index non-noise messages into People directory
    for (const msg of messages) {
      if (msg.is_noise) continue;

      if (msg.channel === "whatsapp" || msg.channel === "telegram") {
        const isDirect =
          msg.thread_title.toLowerCase() === msg.sender.toLowerCase() ||
          this.isSelfIdentity(msg.sender);

        // Index the thread/contact
        upsertPerson({
          rawKey: isDirect ? msg.thread_title : msg.thread_key,
          displayName: msg.thread_title,
          channel: msg.channel,
          occurredAt: msg.occurred_at,
          snippet: msg.preview,
          isMessage: true,
          isGroup: !isDirect,
          extraAliases: [msg.thread_key, msg.thread_title],
          timelineItem: {
            id: msg.id,
            channel: msg.channel,
            sender: msg.sender,
            occurred_at: msg.occurred_at,
            text: msg.full_text.slice(0, 1200),
          },
        });

        // Also index distinct human sender in group chats
        if (!isDirect && !this.isSelfIdentity(msg.sender) && !/^\d{10,}$/.test(msg.sender)) {
          upsertPerson({
            rawKey: msg.sender,
            displayName: msg.sender,
            channel: msg.channel,
            occurredAt: msg.occurred_at,
            snippet: `[${msg.thread_title}] ${msg.preview}`,
            isMessage: true,
            isGroup: false,
            timelineItem: {
              id: msg.id,
              channel: msg.channel,
              sender: msg.sender,
              occurred_at: msg.occurred_at,
              text: `[${msg.thread_title}] ${msg.full_text.slice(0, 1200)}`,
            },
          });
        }
      } else if (msg.channel === "imessage") {
        upsertPerson({
          rawKey: msg.thread_title,
          displayName: msg.thread_title,
          channel: "imessage",
          occurredAt: msg.occurred_at,
          snippet: msg.preview,
          isMessage: true,
          isGroup: false,
          timelineItem: {
            id: msg.id,
            channel: "imessage",
            sender: msg.sender,
            occurred_at: msg.occurred_at,
            text: msg.full_text.slice(0, 1200),
          },
        });
      } else if (msg.channel === "gmail") {
        // Extract counterpart email & name from thread_key / sender
        const parts = msg.thread_key.split(":");
        const emailPart = parts[1] || "";
        const displayName = msg.sender.startsWith("You -> ") ? msg.sender.slice(7) : msg.sender;
        const emailLocal = emailPart.includes("@") ? emailPart.split("@")[0].replace(/[._-]+/g, " ") : "";
        upsertPerson({
          rawKey: emailPart || displayName,
          displayName: displayName || emailPart,
          email: emailPart.includes("@") ? emailPart : undefined,
          channel: "gmail",
          occurredAt: msg.occurred_at,
          snippet: `${msg.thread_title}: ${msg.preview}`,
          isMessage: true,
          isGroup: false,
          extraAliases: [emailPart, displayName, emailLocal].filter(Boolean),
          timelineItem: {
            id: msg.id,
            channel: "gmail",
            sender: msg.sender,
            occurred_at: msg.occurred_at,
            text: `${msg.thread_title}\n${msg.full_text.slice(0, 1200)}`,
          },
        });
      }
    }

    // Index Calendar participants & attach meetings to matching people
    for (const ev of calendar) {
      for (const participant of ev.participants) {
        if (this.isSelfIdentity(participant)) continue;
        const parsed = this.parseEmailAddressField(participant);
        if (!parsed.name || this.isSelfIdentity(parsed.name)) continue;
        const localName = parsed.email.includes("@") ? parsed.email.split("@")[0].replace(/[._-]+/g, " ") : parsed.name;
        upsertPerson({
          rawKey: parsed.email || parsed.name,
          displayName: parsed.name,
          email: parsed.email || undefined,
          channel: "calendar",
          occurredAt: ev.start,
          snippet: `Meeting: ${ev.title} (${ev.start.slice(0, 16).replace("T", " ")} UTC)`,
          isMessage: false,
          isGroup: false,
          extraAliases: [parsed.email, localName].filter(Boolean),
          meeting: ev,
        });
      }
    }

    // Fuse ALL canonical LifeOS / world/people cards into peopleByKey (even if no recent bridge messages exist)
    for (const card of loadedCards.cards) {
      let rec = peopleByKey.get(card.slug);
      if (!rec) {
        rec = {
          key: card.slug,
          name: card.canonical_name,
          initials: this.computeInitials(card.canonical_name),
          channels: new Set<string>(),
          message_count: 0,
          past_message_count: 0,
          claim_count: 0,
          last_seen: null,
          last_seen_iso: null,
          last_seen_label: "No recent msg",
          first_seen: null,
          last_snippet: "",
          preview: "",
          last_message_iso: null,
          last_message_snippet: "",
          last_past_meeting_iso: null,
          last_past_meeting_snippet: "",
          next_meeting: null,
          is_group: false,
          timeline: [],
          meetings: [],
          aliases: new Set<string>([card.slug]),
          raw_aliases: new Set<string>([card.canonical_name]),
          canonical_card: null,
          profile_tier: card.profile_tier,
          relationship_tier: card.world_model.relationship_tier,
          relationship_state: card.world_model.relationship_state,
          trajectory: card.world_model.velocity?.trajectory || "",
          role: card.world_model.role,
          org: card.world_model.org,
          has_leverage_map:
            card.world_model.our_leverage.length > 0 || card.world_model.their_leverage.length > 0,
        };
        attachCanonicalCard(rec, card);
        peopleByKey.set(card.slug, rec);
      } else if (!rec.canonical_card) {
        attachCanonicalCard(rec, card);
      }
    }

    // Batch count SQLite claims across all people in one fast single-pass scan
    const claimCounts = batchCountSqliteClaimsForPeople(
      this.db,
      Array.from(peopleByKey.values()).map((r) => ({
        key: r.key,
        name: r.name,
        aliases: Array.from(r.raw_aliases),
      }))
    );

    // Finalize claim counts, tiers, next_meeting, preview, last_snippet, and last_seen_label for every person
    for (const rec of peopleByKey.values()) {
      rec.claim_count = claimCounts.get(rec.key) || 0;

      if (!rec.canonical_card) {
        rec.profile_tier = rec.claim_count >= 5 ? "claims" : "live";
        if (rec.past_message_count >= 25 || rec.claim_count >= 25) {
          rec.relationship_tier = "Active";
        } else if (rec.past_message_count >= 5 || rec.claim_count >= 5) {
          rec.relationship_tier = "Warm";
        } else {
          rec.relationship_tier = "Ambient";
        }
        rec.relationship_state = rec.past_message_count > 0 ? "active" : "ambient";
      }
      if (!rec.trajectory && rec.past_message_count >= 5) {
        rec.trajectory = "ACTIVE";
      }

      const upcoming = rec.meetings
        .filter((m) => (m.endMs !== null && m.endMs > nowMs) || m.startMs > nowMs)
        .sort((a, b) => a.startMs - b.startMs);
      if (upcoming.length > 0) {
        const nextEv = upcoming[0];
        const timing = this.formatCountdown(nextEv.startMs, nextEv.endMs, nowMs);
        rec.next_meeting = {
          title: nextEv.title,
          start_iso: nextEv.start,
          countdown: timing.countdown,
          meet_url: nextEv.meet_url,
        };
      }

      // Compute preview strictly from latest PAST message first, falling back to canonical read, past meeting, or next meeting
      const cardSummary =
        rec.canonical_card?.world_model.canonical_read ||
        rec.canonical_card?.world_model.role ||
        rec.canonical_card?.world_model.current_read_bullets[0] ||
        "";
      const resolvedPreview =
        rec.last_message_snippet ||
        rec.last_past_meeting_snippet ||
        cardSummary ||
        (rec.next_meeting ? `Upcoming: ${rec.next_meeting.title} (${rec.next_meeting.countdown})` : "");
      rec.preview = cleanText(resolvedPreview, 180);
      rec.last_snippet = rec.preview;

      if (rec.last_seen_iso) {
        rec.last_seen_label = this.formatRelativeAge(rec.last_seen_iso, nowMs);
      } else if (rec.next_meeting) {
        rec.last_seen_label = "Upcoming";
      } else {
        rec.last_seen_label = "No recent msg";
      }
    }

    // Smart World-Model People Ranking:
    // Tier 3: Active profiled people (v2/lifeos) or high-signal active contacts (>=5 past msgs) WITH past interaction (last_seen_iso != null)
    // Tier 2: Other live contacts with past interactions (<5 msgs, unprofiled)
    // Tier 1: Profiled LifeOS/v2 people without recent bridge messages (browseable & searchable, ranked by tier + claims)
    // Tier 0: Unprofiled future-only calendar invitees
    const relTierRank: Record<RelationshipTier, number> = { Family: 5, Core: 4, Active: 3, Warm: 2, Ambient: 1 };
    const profTierRank: Record<ProfileTier, number> = { v2: 4, lifeos: 3, claims: 2, live: 1 };
    const DAY_MS = 86400_000;

    const rankTier = (r: PersonIndexRecord): number => {
      const isProfiled = r.profile_tier === "v2" || r.profile_tier === "lifeos";
      const isGenericInbox = /^(hello|info|support|noreply|admin|team|notifications?)\b/i.test(r.name);
      if (r.last_seen_iso !== null) {
        if (isProfiled) return 3;
        if (!isGenericInbox && r.past_message_count >= 5) return 3;
        return 2;
      }
      if (isProfiled) return 1;
      return 0;
    };

    const activeScore = (r: PersonIndexRecord): number => {
      const baseMs = Date.parse(r.last_message_iso || r.last_seen_iso || "") || 0;
      const ageDays = Math.max(0, (nowMs - baseMs) / DAY_MS);
      // Bounded recency score (0..60 points, decays smoothly over weeks)
      const recencyPts = 60 / (1 + ageDays / 14);
      const profilePts =
        r.profile_tier === "v2" ? 45 : r.profile_tier === "lifeos" ? 28 : r.profile_tier === "claims" ? 8 : 0;
      const tierPts =
        r.relationship_tier === "Family"
          ? 36
          : r.relationship_tier === "Core"
            ? 32
            : r.relationship_tier === "Active"
              ? 14
              : r.relationship_tier === "Warm"
                ? 6
                : 0;
      const volumePts =
        Math.min(Math.log2(r.past_message_count + 1) * 4.5, 24) +
        Math.min(Math.log2(r.claim_count + 1) * 3.2, 22) +
        Math.min(Math.max(0, r.channels.size - 1), 3) * 5;
      return recencyPts + profilePts + tierPts + volumePts;
    };

    const peopleList = Array.from(peopleByKey.values()).sort((a, b) => {
      const aT = rankTier(a);
      const bT = rankTier(b);
      if (aT !== bT) return bT - aT;

      if (aT === 3) {
        const diff = activeScore(b) - activeScore(a);
        if (Math.abs(diff) > 0.01) return diff;
        return b.claim_count - a.claim_count || b.past_message_count - a.past_message_count;
      }

      if (aT === 2) {
        return (b.last_seen_iso || "").localeCompare(a.last_seen_iso || "") || b.message_count - a.message_count;
      }

      if (aT === 1) {
        const ptDiff = profTierRank[b.profile_tier] - profTierRank[a.profile_tier];
        if (ptDiff !== 0) return ptDiff;
        const rtDiff = relTierRank[b.relationship_tier] - relTierRank[a.relationship_tier];
        if (rtDiff !== 0) return rtDiff;
        if (b.claim_count !== a.claim_count) return b.claim_count - a.claim_count;
        return a.name.localeCompare(b.name);
      }

      const aNext = a.next_meeting?.start_iso || "9999-99-99";
      const bNext = b.next_meeting?.start_iso || "9999-99-99";
      return aNext.localeCompare(bNext) || b.message_count - a.message_count;
    });

    return {
      builtAt: Date.now(),
      messages,
      inboxThreads,
      calendar,
      whoop,
      peopleList,
      peopleByKey,
      cardMergeMap: loadedCards.mergeMap,
    };
  }

  private async computePersonalIndexFingerprint(): Promise<string> {
    const paths = [
      join(this.bridgesDir, "whatsapp", "events.jsonl"),
      join(this.bridgesDir, "telegram", "events.jsonl"),
      join(this.bridgesDir, "mac-imessage", "events.jsonl"),
      join(this.bridgesDir, "gmail", "events.jsonl"),
      join(this.bridgesDir, "mac-calendar", "events.jsonl"),
      join(this.bridgesDir, "whoop", "events.jsonl"),
      join(this.vaultPath, "world", "people"),
      ...(this.lifeosPeopleDir ? [this.lifeosPeopleDir] : []),
      ...(this.relationshipsDir ? [this.relationshipsDir] : []),
    ];

    const statParts = await Promise.all(
      paths.map(async (p) => {
        try {
          const st = await stat(p);
          return `${st.size}:${Math.trunc(st.mtimeMs)}`;
        } catch {
          return "0:0";
        }
      })
    );

    let claimsFp = "0:0";
    try {
      const row = this.db
        .query(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid, COUNT(*) AS cnt FROM claims`)
        .get() as { max_rowid: number; cnt: number } | null;
      if (row) {
        claimsFp = `${row.max_rowid}:${row.cnt}`;
      }
    } catch {
      claimsFp = "no-claims";
    }

    return `${statParts.join("|")}|${claimsFp}`;
  }

  private async getPersonalIndex(): Promise<PersonalIndexSnapshot> {
    return this.personalIndexSnapshot.get();
  }

  private formatCountdown(startMs: number, endMs: number | null, nowMs: number): {
    is_now: boolean;
    is_today: boolean;
    is_tomorrow: boolean;
    countdown: string;
  } {
    const nowDate = new Date(nowMs);
    const startDate = new Date(startMs);
    const todayStr = nowDate.toISOString().slice(0, 10);
    const tomorrowStr = new Date(nowMs + 86400_000).toISOString().slice(0, 10);
    const startDayStr = startDate.toISOString().slice(0, 10);

    const is_today = startDayStr === todayStr;
    const is_tomorrow = startDayStr === tomorrowStr;
    const effectiveEnd = endMs && endMs > startMs ? endMs : startMs + 3600_000;
    const is_now = startMs <= nowMs && nowMs <= effectiveEnd;

    if (is_now) {
      return { is_now: true, is_today, is_tomorrow, countdown: "now" };
    }

    const diffMs = startMs - nowMs;
    const hhmm = startDate.toISOString().slice(11, 16);

    if (diffMs < 0) {
      const agoMins = Math.max(1, Math.round(-diffMs / 60_000));
      if (agoMins < 60) return { is_now: false, is_today, is_tomorrow, countdown: `${agoMins}m ago` };
      const h = Math.floor(agoMins / 60);
      const m = agoMins % 60;
      return { is_now: false, is_today, is_tomorrow, countdown: m > 0 ? `${h}h ${m}m ago` : `${h}h ago` };
    }

    const mins = Math.max(1, Math.round(diffMs / 60_000));
    if (mins < 60) {
      return { is_now: false, is_today, is_tomorrow, countdown: `in ${mins}m` };
    }
    if (is_today) {
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return { is_now: false, is_today, is_tomorrow, countdown: m > 0 ? `in ${h}h ${m}m` : `in ${h}h` };
    }
    if (is_tomorrow) {
      return { is_now: false, is_today, is_tomorrow, countdown: `Tomorrow ${hhmm}` };
    }
    const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const wd = weekdays[startDate.getUTCDay()];
    return { is_now: false, is_today, is_tomorrow, countdown: `${wd} ${hhmm}` };
  }

  private buildWorkstreamsFromAnchors(
    anchorsContent: string,
    schedule: TodayScheduleItem[],
    inbox: TodayInboxItem[],
    actions: OwnerAction[],
    overview: OverviewResponse
  ): TodayWorkstream[] {
    const workstreams: TodayWorkstream[] = [];
    const lines = anchorsContent.split(/\r?\n/);
    for (const rawLine of lines) {
      const m = rawLine.trim().match(/^-\s+\*\*([^*]+)\*\*:\s*(.+)$/);
      if (!m) continue;
      const name = cleanText(m[1], 64);
      const desc = cleanText(m[2], 220);
      const lower = name.toLowerCase();

      let domain = "Product";
      let state = "Active";
      let context = desc;
      let nextMove = "Review latest updates and ship next milestone.";

      if (lower.includes("kizuki")) {
        domain = "Personal OS";
        state = `${overview.vault.consolidation_complete.toLocaleString("en-US")} consolidated / ${overview.memt.verified} MemT`;
        context = `${desc} Vault holds ${overview.vault.docs_total.toLocaleString("en-US")} docs and ${overview.vault.claims_live.toLocaleString("en-US")} live claims.`;
        nextMove = "Keep dual-engine synthesis live and monitor personal bridge ingestion.";
      } else if (lower.includes("trading") || lower.includes("market")) {
        domain = "Trading";
        state = "Active";
        nextMove = "Check live execution metrics and open strategy decisions.";
      } else if (lower.includes("agent")) {
        domain = "Agent Ops";
        state = "Ambient";
        nextMove = "Coordinate cross-harness handoffs and close open loops.";
      } else if (lower.includes("inkling") || lower.includes("local-llm") || lower.includes("gpu")) {
        domain = "Local GPU";
        state = "Dual-Engine Ready";
        nextMove = "Keep local inference tunnel warm with automatic fallback.";
      }

      // Enrich with matching upcoming calendar event if any
      const calMatch = schedule.find((s) => `${s.title} ${s.calendar}`.toLowerCase().includes(lower));
      if (calMatch) {
        nextMove = `Next meeting: ${calMatch.title} (${calMatch.countdown}).`;
      }

      workstreams.push({ name, domain, state, context, next_move: nextMove });
    }

    // Add Family & Life Ops workstream grounded strictly in genuine human/family threads (never commercial promos)
    const openFamily = actions.filter((a) => !a.done && (a.tag === "Family" || a.tag === "Reply"));
    const familyCal = schedule.find((s) => /school|family|pick up|birthday/i.test(s.title));
    const isGenuineFamilyThread = (i: TodayInboxItem): boolean => {
      if (i.is_noise) return false;
      if (isNoiseMessage({ channel: i.channel, sender: i.sender, threadTitle: i.thread_title, subject: i.thread_title, body: i.preview })) {
        return false;
      }
      const hay = `${i.thread_title} ${i.sender} ${i.preview}`.toLowerCase();
      if (/(?:merlin|house of spoils|annual pass|unsubscribe|shop now|limited time|from just [£$])/i.test(hay)) {
        return false;
      }
      return /\b(family|household|mom|mum|dad|school|kids)\b/i.test(hay);
    };
    const familyCandidates = inbox.filter(isGenuineFamilyThread);
    // Prefer direct WhatsApp / iMessage family chats before email
    const recentFamilyMsg =
      familyCandidates.find((i) => i.channel === "whatsapp" || i.channel === "imessage") ||
      familyCandidates[0];
    workstreams.push({
      name: "Family & Personal",
      domain: "Life Ops",
      state: `${openFamily.length} open item${openFamily.length === 1 ? "" : "s"}`,
      context: recentFamilyMsg
        ? cleanText(`Latest thread: ${recentFamilyMsg.thread_title} (${recentFamilyMsg.sender}): ${recentFamilyMsg.preview}`, 220)
        : "Family schedule, school runs, and personal follow-ups.",
      next_move: openFamily[0]
        ? openFamily[0].title
        : familyCal
          ? `${familyCal.title} (${familyCal.countdown})`
          : "All family items clear.",
    });

    return workstreams;
  }

  async getToday(opts: { includeNoise?: boolean } = {}): Promise<TodayResponse> {
    const includeNoise = Boolean(opts.includeNoise);
    const minuteBucket = Math.floor(Date.now() / 60_000);

    // Fast path: when core hot snapshots are already warm, check memo BEFORE any async work.
    if (
      this.personalIndexSnapshot.hasValue() &&
      this.pulseSnapshot.hasValue() &&
      this.bridgesSnapshot.hasValue() &&
      this.actionsCache !== null
    ) {
      const fastKey = `${this.personalIndexSnapshot.version}:${this.pulseSnapshot.version}:${this.bridgesSnapshot.version}:${this.atlasSnapshot.version}:${this.actionsVersion}:${minuteBucket}:${includeNoise ? 1 : 0}`;
      const fastHit = this.todayMemo.get(fastKey);
      if (fastHit) {
        return {
          ...fastHit,
          stale_ms: this.personalIndexSnapshot.staleMs(),
        };
      }
    }

    const [pulse, personal, actionsRes, bridges, atlas] = await Promise.all([
      this.getPulse(),
      this.getPersonalIndex(),
      this.getActions(),
      this.getBridgeSnapshots(),
      this.getAtlas().catch(() => null),
    ]);

    const memoKey = `${this.personalIndexSnapshot.version}:${this.pulseSnapshot.version}:${this.bridgesSnapshot.version}:${this.atlasSnapshot.version}:${this.actionsVersion}:${minuteBucket}:${includeNoise ? 1 : 0}`;
    const memoHit = this.todayMemo.get(memoKey);
    if (memoHit) {
      return {
        ...memoHit,
        stale_ms: this.personalIndexSnapshot.staleMs(),
      };
    }

    const nowMs = Date.now();
    const minWindow = nowMs - 2 * 3600_000;
    const maxWindow = nowMs + 7 * 86400_000;

    // Schedule: last 2h through next 7 days, deduplicated
    const seenCal = new Set<string>();
    const schedule: TodayScheduleItem[] = [];
    for (const ev of personal.calendar) {
      const endsInside = ev.endMs !== null && ev.endMs >= minWindow && ev.startMs <= maxWindow;
      const startsInside = ev.startMs >= minWindow && ev.startMs <= maxWindow;
      if (!startsInside && !endsInside) continue;
      const dedupKey = `${ev.title.toLowerCase()}|${ev.start}`;
      if (seenCal.has(ev.id) || seenCal.has(dedupKey)) continue;
      seenCal.add(ev.id);
      seenCal.add(dedupKey);
      const timing = this.formatCountdown(ev.startMs, ev.endMs, nowMs);
      schedule.push({
        id: ev.id,
        title: ev.title,
        calendar: ev.calendar,
        start: ev.start,
        end: ev.end,
        is_now: timing.is_now,
        is_today: timing.is_today,
        is_tomorrow: timing.is_tomorrow,
        countdown: timing.countdown,
        participants: ev.participants,
        meet_url: ev.meet_url,
        dial_in: ev.dial_in,
        notes: ev.notes,
        body: ev.notes,
        raw_text: ev.notes,
      });
    }

    const allThreads = personal.inboxThreads.map((t) => {
      if (
        !t.is_noise &&
        t.channel === "telegram" &&
        this.isNoisyTelegramChannel(
          t.thread_key,
          t.thread_title,
          t.sender,
          `${t.preview || ""} ${t.full_text || ""}`
        )
      ) {
        return { ...t, is_noise: true };
      }
      return t;
    });
    const priorityThreads = allThreads.filter((t) => !t.is_noise);
    const visibleThreads = includeNoise ? allThreads : priorityThreads;

    const inbox_counts = {
      priority: priorityThreads.length,
      all: allThreads.length,
      whatsapp: visibleThreads.filter((t) => t.channel === "whatsapp").length,
      imessage: visibleThreads.filter((t) => t.channel === "imessage").length,
      gmail: visibleThreads.filter((t) => t.channel === "gmail").length,
      telegram: visibleThreads.filter((t) => t.channel === "telegram").length,
    };

    const inbox = visibleThreads.slice(0, 60);

    // Top 8 active 1:1 human contacts for people_radar (strictly past interactions, never group chats)
    const individualPeople = personal.peopleList.filter(
      (p) => !p.is_group && !this.isGroupChatName(p.name)
    );
    const people_radar: PeopleRadarItem[] = individualPeople
      .filter((p) => p.last_seen_iso !== null)
      .slice(0, 8)
      .map((p) => ({
        key: p.key,
        name: p.name,
        initials: p.initials,
        channels: Array.from(p.channels).filter((ch) => ch !== "calendar" || p.meetings.length > 0).sort(),
        last_seen: p.last_seen_iso,
        last_seen_iso: p.last_seen_iso,
        last_seen_label: p.last_seen_label,
        last_snippet: p.last_snippet,
        preview: p.preview,
        message_count: p.message_count,
        next_meeting: p.next_meeting,
      }));

    // Unified events total matching /api/overview, /api/pulse, and /api/stream (composed from hot snapshots only)
    const sqlStats = pulse.overview.vault.connectors;
    const eventsTotal = this.computeUnifiedEventsTotal(sqlStats, bridges);
    const activePipelines = pulse.connectors_status.filter((c) => c.status === "active").length;
    const openActions = actionsRes.actions.filter((a) => !a.done).length;
    const atlasPanelsCount = atlas && Array.isArray(atlas.panels) && atlas.panels.length > 0 ? atlas.panels.length : 6;

    const workstreams = this.buildWorkstreamsFromAnchors(
      pulse.owner_anchors.content,
      schedule,
      priorityThreads,
      actionsRes.actions,
      pulse.overview
    );

    const payload: TodayResponse = {
      generated_at: new Date().toISOString(),
      stale_ms: this.personalIndexSnapshot.staleMs(),
      summary: {
        events_total: eventsTotal,
        docs_total: pulse.docs_summary.total,
        people_total: individualPeople.length,
        atlas_panels: atlasPanelsCount,
        active_pipelines: activePipelines,
        total_pipelines: pulse.connectors_status.length,
        claims_live: pulse.overview.vault.claims_live,
        memt_verified: pulse.overview.memt.verified,
        open_actions: openActions,
        priority_inbox_count: inbox_counts.priority,
      },
      schedule,
      actions: actionsRes.actions,
      inbox,
      inbox_counts,
      people_radar,
      whoop: personal.whoop,
      workstreams,
      owner_anchors: {
        path: pulse.owner_anchors.path,
        content: pulse.owner_anchors.content,
        updated_at: pulse.owner_anchors.updated_at,
      },
    };

    if (this.todayMemo.size > 12) {
      this.todayMemo.clear();
    }
    this.todayMemo.set(memoKey, payload);
    return payload;
  }

  async listPeople(opts: { q?: string; channel?: string; filter?: string; limit?: number } = {}): Promise<PeopleListResponse> {
    const q = (opts.q || "").trim().toLowerCase();
    const channel = (opts.filter || opts.channel || "all").trim().toLowerCase();
    const limit = Math.max(1, Math.min(300, Number(opts.limit || 60) || 60));

    const personal = await this.getPersonalIndex();
    const humanPeople = personal.peopleList.filter(
      (p) => !p.is_group && !this.isGroupChatName(p.name)
    );
    const channelDefs = [
      { id: "whatsapp", label: "WhatsApp" },
      { id: "telegram", label: "Telegram" },
      { id: "imessage", label: "iMessage" },
      { id: "gmail", label: "Gmail" },
      { id: "calendar", label: "Calendar" },
    ];
    const channels = channelDefs.map((d) => ({
      id: d.id,
      label: d.label,
      count: humanPeople.filter((p) => p.channels.has(d.id) && (d.id !== "calendar" || p.meetings.length > 0)).length,
    }));

    const profiled_count = humanPeople.filter(
      (p) => p.profile_tier === "v2" || p.profile_tier === "lifeos"
    ).length;
    const core_count = humanPeople.filter(
      (p) => p.relationship_tier === "Core" || p.relationship_tier === "Family"
    ).length;

    const channelFiltered = humanPeople.filter((p) => {
      if (!channel || channel === "all") return true;
      if (channel === "profiled") return p.profile_tier === "v2" || p.profile_tier === "lifeos";
      if (channel === "core") return p.relationship_tier === "Core" || p.relationship_tier === "Family";
      if (channel === "calendar") return p.channels.has("calendar") && p.meetings.length > 0;
      return p.channels.has(channel);
    });

    let ordered: PersonIndexRecord[];
    if (q) {
      const scored: Array<{ rec: PersonIndexRecord; score: number; idx: number }> = [];
      for (let i = 0; i < channelFiltered.length; i++) {
        const rec = channelFiltered[i];
        const score = this.scorePersonSearchMatch(rec, q);
        if (score > 0) {
          scored.push({ rec, score, idx: i });
        }
      }
      scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
      ordered = scored.map((s) => s.rec);
    } else {
      ordered = channelFiltered;
    }

    const items: PersonDirectoryItem[] = ordered.slice(0, limit).map((p) => this.toPersonDirectoryItem(p));

    return {
      total: ordered.length,
      profiled_count,
      core_count,
      channel,
      query: q,
      channels,
      items,
    };
  }

  private resolvePersonRecord(personal: PersonalIndexSnapshot, rawKey: string): PersonIndexRecord | null {
    const key = (rawKey || "").trim();
    if (!key) return null;
    const lowerKey = key.toLowerCase();
    const normKey = this.normalizePersonKey(key);
    const mergedTarget = personal.cardMergeMap.get(normKey) || personal.cardMergeMap.get(lowerKey);

    let rec =
      (mergedTarget ? personal.peopleByKey.get(mergedTarget) : undefined) ||
      personal.peopleByKey.get(lowerKey) ||
      personal.peopleByKey.get(normKey);
    if (!rec) {
      rec = personal.peopleList.find(
        (p) =>
          p.key.toLowerCase() === lowerKey ||
          p.name.toLowerCase() === lowerKey ||
          p.aliases.has(normKey) ||
          Array.from(p.raw_aliases).some((a) => a.toLowerCase() === lowerKey)
      );
    }
    return rec || null;
  }

  /**
   * Read-only helper (Contract C3): returns full past personal message history for a person key
   * beyond the 80-item dossier timeline page (for 52-week relationship ledger and drift analysis).
   */
  async getPersonMessages(key: string): Promise<PersonMessageRecord[]> {
    const personal = await this.getPersonalIndex();
    const rec = this.resolvePersonRecord(personal, key);
    if (!rec) return [];
    const nowMs = Date.now();
    return rec.timeline
      .filter((t) => {
        const ms = Date.parse(t.occurred_at);
        return !Number.isNaN(ms) && ms <= nowMs;
      })
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .map((t) => {
        const isOutbound = this.isSelfIdentity(t.sender) || t.sender.startsWith("You -> ");
        return {
          id: t.id,
          channel: t.channel,
          sender: t.sender,
          direction: isOutbound ? "You" : t.sender,
          is_outbound: isOutbound,
          occurred_at: t.occurred_at,
          text: t.text,
        };
      });
  }

  async getPersonDossier(rawKeyOrOpts: string | PersonDossierQueryOptions): Promise<PersonDossierResponse> {
    const opts: PersonDossierQueryOptions =
      typeof rawKeyOrOpts === "string" ? { key: rawKeyOrOpts } : rawKeyOrOpts || { key: "" };
    const key = (opts.key || "").trim();
    if (!key) {
      throw new BadRequestError("key query parameter is required");
    }
    const limit = Math.max(1, Math.min(500, Number(opts.limit ?? 80) || 80));
    const offset = Math.max(0, Number(opts.offset ?? 0) || 0);
    const channelFilter = (opts.channel || "all").trim().toLowerCase();
    const textFilter = (opts.q || "").trim().toLowerCase();

    const personal = await this.getPersonalIndex();
    const rec = this.resolvePersonRecord(personal, key);
    if (!rec) {
      throw new NotFoundError(`Person not found: ${key}`);
    }

    const nowMs = Date.now();

    // 30s per-person dossier cache (caches related_docs, sqliteIntel, collaborators, meetings, worldModel, and profile_visuals)
    const cachedEntry = this.dossierIntelCache.get(rec.key);
    let bundle = cachedEntry && cachedEntry.expiresAt > nowMs ? cachedEntry.value : null;

    if (!bundle) {
      const related_docs = await this.findRelatedDocs(
        `${rec.name} ${rec.key} ${rec.role} ${rec.org} ${rec.preview}`,
        rec.canonical_card?.source_path || undefined,
        8
      );

      // Live Kizuki SQLite Claims & Backtrack evidence (aligned with /api/people batch counter)
      const sqliteIntel = querySqlitePersonIntelligence(
        this.db,
        rec.name,
        Array.from(rec.raw_aliases),
        80
      );

      const mapMeeting = (m: ParsedCalendarEvent, isUpcoming: boolean): PersonDossierMeeting => {
        const timing = this.formatCountdown(m.startMs, m.endMs, nowMs);
        return {
          id: m.id,
          title: m.title,
          calendar: m.calendar,
          start: m.start,
          end: m.end,
          countdown: timing.countdown,
          is_upcoming: isUpcoming,
          participants: m.participants,
          meet_url: m.meet_url,
          dial_in: m.dial_in,
          notes: m.notes,
          body: m.notes,
          raw_text: m.notes,
        };
      };

      const upcomingMeetings = rec.meetings
        .filter((m) => (m.endMs !== null && m.endMs >= nowMs) || m.startMs >= nowMs - 30 * 60_000)
        .sort((a, b) => a.startMs - b.startMs)
        .slice(0, 25)
        .map((m) => mapMeeting(m, true));

      const pastMeetings = rec.meetings
        .filter((m) => !((m.endMs !== null && m.endMs >= nowMs) || m.startMs >= nowMs - 30 * 60_000))
        .sort((a, b) => b.startMs - a.startMs)
        .slice(0, 25)
        .map((m) => mapMeeting(m, false));

      const allMeetings = [...upcomingMeetings, ...pastMeetings];
      const resolvedChannels = Array.from(rec.channels)
        .filter((ch) => ch !== "calendar" || allMeetings.length > 0)
        .sort();

      // Fuse collaborators from canonical dyads + shared calendar meetings, resolving clickable directory keys
      const collabMap = new Map<string, PersonDossierCollaborator>();
      const upsertCollab = (entry: { name: string; slug: string; shared_events: number; note?: string }) => {
        const mappedSlug = personal.cardMergeMap.get(entry.slug) || entry.slug;
        if (!mappedSlug || mappedSlug === rec.key) return;
        const targetRec = this.resolvePersonRecord(personal, mappedSlug) || this.resolvePersonRecord(personal, entry.name);
        const dedupKey = targetRec?.key || mappedSlug;
        if (dedupKey === rec.key) return;
        const prev = collabMap.get(dedupKey);
        if (!prev) {
          collabMap.set(dedupKey, {
            name: targetRec?.name || entry.name,
            slug: mappedSlug,
            key: targetRec?.key || null,
            shared_events: entry.shared_events,
            note: entry.note,
          });
        } else {
          prev.shared_events = Math.max(prev.shared_events, entry.shared_events);
          if (!prev.note && entry.note) prev.note = entry.note;
        }
      };

      if (rec.canonical_card) {
        for (const c of rec.canonical_card.world_model.collaborators) {
          upsertCollab(c);
        }
      }

      // Add shared calendar meeting co-attendees
      const coAttendeeCounts = new Map<string, { name: string; count: number }>();
      for (const m of rec.meetings) {
        for (const part of m.participants) {
          if (this.isSelfIdentity(part)) continue;
          const parsed = this.parseEmailAddressField(part);
          const peer = this.resolvePersonRecord(personal, parsed.email || parsed.name);
          if (!peer || peer.key === rec.key) continue;
          const cur = coAttendeeCounts.get(peer.key);
          if (cur) cur.count++;
          else coAttendeeCounts.set(peer.key, { name: peer.name, count: 1 });
        }
      }
      for (const [peerKey, info] of coAttendeeCounts.entries()) {
        upsertCollab({
          name: info.name,
          slug: peerKey,
          shared_events: info.count,
          note: "Shared calendar meetings",
        });
      }

      const collaborators = Array.from(collabMap.values())
        .sort((a, b) => b.shared_events - a.shared_events || a.name.localeCompare(b.name))
        .slice(0, 24);

      const worldModel: PersonWorldModel = rec.canonical_card
        ? {
            ...rec.canonical_card.world_model,
            collaborators: collaborators.map((c) => ({
              name: c.name,
              slug: c.slug,
              shared_events: c.shared_events,
              note: c.note,
            })),
          }
        : buildEmptySynthesizedWorldModel({
            name: rec.name,
            channels: resolvedChannels,
            aliases: Array.from(rec.raw_aliases),
            claimCount: sqliteIntel.total_claims,
            messageCount: rec.message_count,
            meetingCount: allMeetings.length,
            preview: rec.preview,
            firstSeen: rec.first_seen,
            lastSeen: rec.last_seen_iso,
          });

      const effectiveClaimCount = sqliteIntel.total_claims;
      // Keep cached directory record aligned with live SQLite query count
      rec.claim_count = effectiveClaimCount;

      const fullPastTimeline = rec.timeline
        .filter((t) => {
          const ms = Date.parse(t.occurred_at);
          return !Number.isNaN(ms) && ms <= nowMs;
        })
        .map((t) => ({
          channel: t.channel,
          sender: t.sender,
          direction: this.isSelfIdentity(t.sender) || t.sender.startsWith("You -> ") ? "You" : t.sender,
          occurred_at: t.occurred_at,
          text: t.text,
        }));

      const profile_visuals = computePersonProfileVisuals({
        key: rec.key,
        name: rec.name,
        initials: rec.initials,
        role: rec.role,
        org: rec.org,
        relationshipTier: rec.relationship_tier,
        relationshipState: rec.relationship_state,
        worldModel,
        timeline: fullPastTimeline,
        meetings: rec.meetings.map((m) => ({
          title: m.title,
          start: m.start,
          is_upcoming: (m.endMs !== null && m.endMs >= nowMs) || m.startMs >= nowMs - 30 * 60_000,
        })),
        collaborators,
        messageCount: rec.message_count,
        claimCount: effectiveClaimCount,
        meetingCount: allMeetings.length,
        aliases: Array.from(new Set([...worldModel.aliases, ...Array.from(rec.raw_aliases)])),
        nowMs,
      });

      bundle = {
        related_docs,
        sqliteIntel,
        worldModel,
        profile_visuals,
        collaborators,
        allMeetings,
        pastMeetings,
        resolvedChannels,
        effectiveClaimCount,
      };
      this.dossierIntelCache.set(rec.key, { value: bundle, expiresAt: Date.now() + 30_000 });
    }

    // Full multi-year past timeline with channel filter + text search + pagination
    const allPastTimeline = [...rec.timeline]
      .filter((t) => {
        const ms = Date.parse(t.occurred_at);
        if (Number.isNaN(ms) || ms > nowMs) return false;
        if (channelFilter && channelFilter !== "all" && t.channel.toLowerCase() !== channelFilter) {
          return false;
        }
        if (textFilter) {
          const hay = `${t.sender} ${t.channel} ${t.text}`.toLowerCase();
          if (!hay.includes(textFilter)) return false;
        }
        return true;
      })
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

    const timelineTotal = allPastTimeline.length;
    const timelineSlice = allPastTimeline.slice(offset, offset + limit);
    const timelineHasMore = offset + timelineSlice.length < timelineTotal;

    return {
      ok: true,
      person: {
        key: rec.key,
        name: rec.name,
        initials: rec.initials,
        channels: bundle.resolvedChannels,
        message_count: rec.message_count,
        claim_count: bundle.effectiveClaimCount,
        meeting_count: bundle.allMeetings.length,
        last_seen: rec.last_seen_iso,
        last_seen_iso: rec.last_seen_iso,
        last_seen_label: rec.last_seen_label,
        first_seen: rec.first_seen,
        history_span_label: this.formatHistorySpanLabel(rec.first_seen, rec.last_seen_iso),
        preview: rec.preview,
        next_meeting: rec.next_meeting,
        profile_tier: rec.profile_tier,
        relationship_tier: rec.relationship_tier,
        relationship_state: rec.relationship_state,
        role: rec.role,
        org: rec.org,
        handles: bundle.worldModel.handles,
        aliases: Array.from(new Set([...bundle.worldModel.aliases, ...Array.from(rec.raw_aliases)])).slice(0, 20),
      },
      world_model: bundle.worldModel,
      profile_visuals: bundle.profile_visuals,
      timeline_total: timelineTotal,
      timeline_offset: offset,
      timeline_has_more: timelineHasMore,
      timeline: timelineSlice.map((t) => ({
        ...t,
        direction: this.isSelfIdentity(t.sender) || t.sender.startsWith("You -> ") ? "You" : t.sender,
      })),
      sqlite_claims_total: bundle.sqliteIntel.total_claims,
      sqlite_claims: bundle.sqliteIntel.claims,
      meetings: bundle.allMeetings,
      past_meetings: bundle.pastMeetings,
      collaborators: bundle.collaborators,
      related_docs: bundle.related_docs,
    };
  }

  private applyUpdatedWorldCardToCache(
    rec: PersonIndexRecord,
    slug: string,
    cardPath: string,
    content: string
  ): void {
    const { frontmatter } = parseFrontmatter(content);
    const parsedV2 = parsePersonCardMarkdown(content, frontmatter, {
      slug,
      sourcePath: cardPath,
      isWorldV2: true,
    });
    const prevWm = rec.canonical_card?.world_model || null;
    const fusedWm = prevWm ? fuseWorldModels(prevWm, parsedV2, true) : parsedV2;
    const prevCard = rec.canonical_card;
    rec.canonical_card = {
      slug,
      canonical_name: prevCard?.canonical_name || rec.name,
      display_name: prevCard?.display_name || frontmatter.display_name || rec.name,
      is_self: false,
      profile_tier: "v2",
      source_path: cardPath,
      tags: Array.from(new Set([...(prevCard?.tags || []), ...frontmatter.tags])),
      merged_from: prevCard?.merged_from || [],
      world_model: fusedWm,
      match_tokens: prevCard?.match_tokens || {
        exact_slugs: new Set([slug]),
        full_names: new Set(),
        first_names_only: new Set(),
        emails: new Set(),
        handles: new Set(),
        surnames: new Set(),
      },
    };
    rec.profile_tier = "v2";
    rec.relationship_tier = fusedWm.relationship_tier;
    rec.relationship_state = fusedWm.relationship_state;
    if (fusedWm.role) rec.role = fusedWm.role;
    if (fusedWm.org) rec.org = fusedWm.org;
    rec.has_leverage_map = fusedWm.our_leverage.length > 0 || fusedWm.their_leverage.length > 0;

    this.dossierIntelCache.delete(rec.key);
    this.dossierIntelCache.delete(slug);
    this.docIndexCache = null;
    this.todayMemo.clear();
    this.personalIndexSnapshot.markDirty();
  }

  async synthesizePersonWorldModel(req: PersonSynthesizeRequest): Promise<PersonSynthesizeResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Request body must be a JSON object");
    }
    const rawKey = String(req.key || "").trim();
    if (!rawKey) {
      throw new BadRequestError("key is required");
    }
    const focus = typeof req.focus === "string" ? stripEmDashes(req.focus).trim().slice(0, 600) : "";

    const t0 = performance.now();
    const personal = await this.getPersonalIndex();
    const rec = this.resolvePersonRecord(personal, rawKey);
    if (!rec) {
      throw new NotFoundError(`Person not found: ${rawKey}`);
    }

    const slug = normalizeSlug(rec.canonical_card?.slug || rec.key);
    if (!isValidPersonSlug(slug)) {
      throw new BadRequestError(`Cannot synthesize world-model card for invalid slug: ${rec.key}`);
    }

    // Gather up to 32 high-signal historical + recent messages spanning earliest to newest
    const nowMs = Date.now();
    const allPastChrono = [...rec.timeline]
      .filter((t) => {
        const ms = Date.parse(t.occurred_at);
        return !Number.isNaN(ms) && ms <= nowMs;
      })
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

    const highSignalPool = allPastChrono.filter((m) => m.text.trim().length >= 16);
    const pastChrono = highSignalPool.length >= 16 ? highSignalPool : allPastChrono;

    let sampledMessages: typeof pastChrono = [];
    if (pastChrono.length <= 32) {
      sampledMessages = pastChrono;
    } else {
      const earliest = pastChrono.slice(0, 8);
      const latest = pastChrono.slice(-16);
      const midPool = pastChrono.slice(8, -16);
      const middle: typeof pastChrono = [];
      const midTarget = 8;
      for (let i = 0; i < midTarget && midPool.length > 0; i++) {
        const idx = Math.floor((i * midPool.length) / midTarget);
        middle.push(midPool[idx]);
      }
      const seenIds = new Set<string>();
      for (const m of [...earliest, ...middle, ...latest]) {
        if (!seenIds.has(m.id)) {
          seenIds.add(m.id);
          sampledMessages.push(m);
        }
      }
    }

    const sqliteIntel = querySqlitePersonIntelligence(
      this.db,
      rec.name,
      Array.from(rec.raw_aliases),
      20
    );

    const existingCardMd = rec.canonical_card?.world_model.full_markdown || "";
    const existingOwnerNotes = rec.canonical_card?.world_model.owner_notes || [];

    const { systemPrompt, userPrompt } = buildWorldModelSynthesisPrompt({
      slug,
      name: rec.name,
      existingCardMd,
      existingOwnerNotes,
      messages: sampledMessages,
      claims: sqliteIntel.claims,
      meetings: rec.meetings
        .slice(-12)
        .map((m) => ({ title: m.title, start: m.start, notes: m.notes })),
      collaborators: rec.canonical_card?.world_model.collaborators || [],
      handles: rec.canonical_card?.world_model.handles || {},
      aliases: Array.from(rec.raw_aliases),
      focus: focus || undefined,
    });

    const synth = await this.synthesizeWithDualEngine({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      promptForCoherence: `Synthesize person-card-v2 world model dossier for ${rec.name}`,
      primaryMaxTokens: 2400,
      primaryTemperature: 0.25,
      fallbackMaxTokens: 2400,
      fallbackTemperature: 0.25,
    });

    if (!synth.ok) {
      throw new ServiceUnavailableError(`World-model synthesis unavailable: ${synth.reason}`);
    }

    const cleanedContent = stripEmDashes(synth.content).trim();
    if (!cleanedContent || (!cleanedContent.includes("## ") && !cleanedContent.includes("# "))) {
      throw new ServiceUnavailableError("Synthesis engine returned unstructured markdown");
    }

    const written = await writeWorldModelPersonCard(this.vaultPath, slug, cleanedContent);
    this.applyUpdatedWorldCardToCache(rec, slug, written.card_path, written.content);
    const dossier = await this.getPersonDossier({ key: slug });
    const latency_ms = Math.round(performance.now() - t0);

    return {
      ok: true,
      engine: synth.engine,
      model: synth.model,
      latency_ms,
      card_path: written.card_path,
      dossier,
    };
  }

  async addPersonObservation(req: PersonNoteRequest): Promise<PersonNoteResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Request body must be a JSON object");
    }
    const rawKey = String(req.key || "").trim();
    if (!rawKey) {
      throw new BadRequestError("key is required");
    }
    const rawKind = String(req.kind || "insight").trim().toLowerCase() as OwnerNoteKind;
    if (!VALID_OWNER_NOTE_KINDS.has(rawKind)) {
      throw new BadRequestError(
        `kind must be one of: ${Array.from(VALID_OWNER_NOTE_KINDS).join(", ")}`
      );
    }
    const text = stripEmDashes(String(req.text || "")).trim();
    if (!text) {
      throw new BadRequestError("text is required");
    }
    if (text.length > 2000) {
      throw new BadRequestError("text exceeds 2000 character limit");
    }

    const personal = await this.getPersonalIndex();
    const rec = this.resolvePersonRecord(personal, rawKey);
    if (!rec) {
      throw new NotFoundError(`Person not found: ${rawKey}`);
    }

    const slug = normalizeSlug(rec.canonical_card?.slug || rec.key);
    if (!isValidPersonSlug(slug)) {
      throw new BadRequestError(`Cannot store owner note for invalid slug: ${rec.key}`);
    }

    const existingCardMd = rec.canonical_card?.world_model.full_markdown || null;
    const result = await appendOwnerObservation(this.vaultPath, slug, rec.name, existingCardMd, {
      kind: rawKind,
      text,
    });

    this.applyUpdatedWorldCardToCache(rec, slug, result.card_path, result.content);
    const dossier = await this.getPersonDossier({ key: slug });

    return {
      ok: true,
      card_path: result.card_path,
      note_line: result.note_line,
      dossier,
    };
  }

  async omniSearch(rawQuery: string, rawLimit = 8): Promise<OmniSearchResponse> {
    const t0 = performance.now();
    const query = (rawQuery || "").trim();
    const limit = Math.max(1, Math.min(30, Number(rawLimit || 8) || 8));

    if (!query) {
      return {
        query: "",
        ms: 0,
        total: 0,
        groups: {
          calendar: [],
          inbox: [],
          docs: [],
          people: [],
          memt: [],
          nodes: [],
        },
      };
    }

    const qLower = query.toLowerCase();
    const like = `%${query}%`;

    const [personal, docsRes, memtAll] = await Promise.all([
      this.getPersonalIndex(),
      this.listDocs({ category: "all", q: query, limit, offset: 0, sort: "recent" }),
      this.getMemtExperiences(100),
    ]);

    // 1. Calendar matches
    const calendarMatches = personal.calendar
      .filter((ev) =>
        `${ev.title} ${ev.calendar} ${ev.participants.join(" ")} ${ev.raw_text}`.toLowerCase().includes(qLower)
      )
      .sort((a, b) => b.startMs - a.startMs)
      .slice(0, limit)
      .map((ev) => ({
        id: ev.id,
        title: ev.title,
        calendar: ev.calendar,
        start: ev.start,
        end: ev.end,
        participants: ev.participants,
        preview: cleanText(ev.raw_text, 180),
      }));

    // 2. Inbox matches (prioritize non-noise threads, then matching individual messages)
    const inboxMatches: OmniSearchResponse["groups"]["inbox"] = [];
    const seenInboxIds = new Set<string>();
    const inboxSorted = [...personal.messages].sort((a, b) => {
      if (a.is_noise !== b.is_noise) return a.is_noise ? 1 : -1;
      return b.occurred_at.localeCompare(a.occurred_at);
    });
    for (const msg of inboxSorted) {
      if (inboxMatches.length >= limit) break;
      const hay = `${msg.thread_title} ${msg.sender} ${msg.preview} ${msg.full_text}`.toLowerCase();
      if (!hay.includes(qLower)) continue;
      if (seenInboxIds.has(msg.id)) continue;
      seenInboxIds.add(msg.id);
      inboxMatches.push({
        id: msg.id,
        channel: msg.channel,
        channel_label: msg.channel_label,
        thread_key: msg.thread_key,
        sender: msg.sender,
        thread_title: msg.thread_title,
        preview: msg.preview,
        occurred_at: msg.occurred_at,
        is_noise: msg.is_noise,
      });
    }

    // 3. Docs matches (across Vault + Obsidian + Apple Notes)
    const docMatches = docsRes.items.slice(0, limit).map((d) => ({
      path: d.path,
      title: d.title,
      category: d.category,
      updated_at: d.updated_at,
      excerpt: d.excerpt,
    }));

    // 4. People matches (relevance-scored so name/alias matches outrank email substrings)
    const peopleScored = personal.peopleList
      .filter((p) => !p.is_group && !this.isGroupChatName(p.name))
      .map((p, idx) => ({ p, score: this.scorePersonSearchMatch(p, qLower), idx }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.idx - b.idx);

    const peopleMatches: PersonDirectoryItem[] = peopleScored
      .slice(0, limit)
      .map((x) => this.toPersonDirectoryItem(x.p));

    // 5. MemT matches (in-memory over cached experiences -> <1ms)
    const memtMatches = memtAll
      .filter((m) => `${m.domain} ${m.condition} ${m.recommendation} ${m.verification || ""}`.toLowerCase().includes(qLower))
      .slice(0, limit)
      .map((m) => ({
        id: m.id,
        domain: m.domain,
        condition: cleanText(m.condition, 200),
        recommendation: cleanText(m.recommendation, 260),
        outcome: m.outcome,
        confidence: Number(m.confidence ?? 0.9),
      }));

    // 6. Consolidated World / Semantic / Graph node matches (fast bounded SQLite + cached graph)
    const worldRows = this.db
      .query(
        `SELECT wc.handle_id,
                wc.kind,
                wc.summary,
                COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                         THEN json_extract(s.payload, '$.object.value') END) AS sem_label
         FROM world_consolidation wc
         LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
         LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
         GROUP BY wc.basis_digest
         HAVING wc.summary LIKE ? OR sem_label LIKE ?
         ORDER BY CASE WHEN wc.status = 'complete' THEN 0 ELSE 1 END, updated_at DESC
         LIMIT ?`
      )
      .all(like, like, limit) as Array<{
        handle_id: string;
        kind: string;
        summary: string | null;
        updated_at: string | null;
        sem_label: string | null;
      }>;

    const nodeMatches: OmniSearchResponse["groups"]["nodes"] = [];
    const seenNodeIds = new Set<string>();

    for (const r of worldRows) {
      if (seenNodeIds.has(r.handle_id)) continue;
      seenNodeIds.add(r.handle_id);
      nodeMatches.push({
        id: r.handle_id,
        label:
          (r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanText(r.sem_label, 72) : "") ||
          extractLabelFromSummary(r.summary, r.handle_id),
        kind: normalizeKind(r.kind, "concept"),
        summary: cleanText(r.summary, 260),
        updated_at: r.updated_at || null,
      });
    }

    if (nodeMatches.length < limit) {
      const semRows = this.db
        .query(
          `SELECT s.subject_id,
                  MAX(CASE WHEN s.predicate IN ('situation.label','concept.label','identity.display_name','artifact.label')
                           THEN json_extract(s.payload, '$.object.value') END) AS label,
                  MAX(CASE WHEN s.predicate = 'world.kind'
                           THEN json_extract(s.payload, '$.object.ref.id') END) AS world_kind,
                  MAX(CASE WHEN s.predicate IN ('concept.definition','situation.objective','situation.blocker','situation.commitment','situation.change','project.status')
                           THEN json_extract(s.payload, '$.object.value') END) AS detail_text,
                  MAX(c.created_at) AS updated_at
           FROM claim_v2_semantics s
           JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
           WHERE s.subject_id IS NOT NULL
             AND s.payload LIKE ?
           GROUP BY s.subject_id
           ORDER BY updated_at DESC
           LIMIT ?`
        )
        .all(like, limit * 2) as Array<{
          subject_id: string;
          label: string | null;
          world_kind: string | null;
          detail_text: string | null;
          updated_at: string | null;
        }>;

      for (const r of semRows) {
        if (nodeMatches.length >= limit) break;
        if (seenNodeIds.has(r.subject_id)) continue;
        const label =
          (r.label && !isLikelyHexHash(r.label) ? cleanText(r.label, 72) : "") ||
          (r.detail_text ? cleanText(r.detail_text, 64) : "");
        if (!label) continue;
        seenNodeIds.add(r.subject_id);
        nodeMatches.push({
          id: r.subject_id,
          label,
          kind: normalizeKind(r.world_kind, "situation"),
          summary: cleanText(r.detail_text || label, 260),
          updated_at: r.updated_at || null,
        });
      }
    }

    if (nodeMatches.length < limit && this.graphCache) {
      for (const n of this.graphCache.value.data.nodes) {
        if (nodeMatches.length >= limit) break;
        if (seenNodeIds.has(n.id)) continue;
        if (n.kind === "memt") continue;
        const hay = `${n.label} ${n.summary} ${n.kind} ${n.id}`.toLowerCase();
        if (!hay.includes(qLower)) continue;
        seenNodeIds.add(n.id);
        nodeMatches.push({
          id: n.id,
          label: n.label,
          kind: n.kind,
          summary: cleanText(n.summary, 260),
          updated_at: n.updated_at,
        });
      }
    }

    const total =
      calendarMatches.length +
      inboxMatches.length +
      docMatches.length +
      peopleMatches.length +
      memtMatches.length +
      nodeMatches.length;

    const ms = Math.round((performance.now() - t0) * 10) / 10;

    return {
      query,
      ms,
      total,
      groups: {
        calendar: calendarMatches,
        inbox: inboxMatches,
        docs: docMatches,
        people: peopleMatches,
        memt: memtMatches,
        nodes: nodeMatches,
      },
    };
  }

  async generateLocalDraft(req: DraftRequest): Promise<DraftResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Request body must be a JSON object");
    }
    const kind = req.kind;
    if (kind !== "reply" && kind !== "meeting_prep" && kind !== "context_brief") {
      throw new BadRequestError("kind must be one of: reply, meeting_prep, context_brief");
    }
    const title = cleanText(String(req.title || ""), 160);
    const contextText = stripEmDashes(String(req.context_text || "")).trim().slice(0, 6000);
    if (!title && !contextText) {
      throw new BadRequestError("title or context_text is required");
    }
    const instructions = stripEmDashes(String(req.instructions || "")).trim().slice(0, 800);

    // Optionally enrich with recent thread context + related vault docs (read-only, local-only)
    const extraContextParts: string[] = [];
    if (req.thread_key) {
      const personal = await this.getPersonalIndex();
      const threadMsgs = personal.messages
        .filter((m) => m.thread_key === req.thread_key)
        .slice(0, 8)
        .reverse();
      if (threadMsgs.length > 0) {
        extraContextParts.push(
          "Recent thread history:\n" +
            threadMsgs
              .map((m) => `- [${m.occurred_at.slice(0, 16).replace("T", " ")} | ${m.sender}]: ${cleanText(m.full_text, 280)}`)
              .join("\n")
        );
      }
    }

    const relatedDocs = await this.findRelatedDocs(`${title} ${contextText.slice(0, 300)}`, undefined, 3).catch(() => []);
    if (relatedDocs.length > 0) {
      extraContextParts.push(
        "Related vault docs:\n" + relatedDocs.map((d) => `- [${d.path}] ${d.title} (${d.category})`).join("\n")
      );
    }

    let systemPrompt = "";
    if (kind === "reply") {
      systemPrompt = [
        "You are Kizuki's local-only Personal Mind OS drafting assistant.",
        "Write a crisp, natural, ready-to-copy reply draft based strictly on the provided context.",
        "- Keep it concise, direct, human, and grounded only in the given facts.",
        "- Never invent dates, commitments, or numbers not present in the context.",
        "- NEVER use em-dashes anywhere.",
        "- Output clean Markdown with a short heading and the ready-to-send reply text.",
      ].join("\n");
    } else if (kind === "meeting_prep") {
      systemPrompt = [
        "You are Kizuki's local-only Personal Mind OS meeting prep analyst.",
        "Generate a sharp, scannable GitHub-Flavored Markdown meeting prep brief with:",
        "- `## Meeting Prep` heading and 1-sentence objective",
        "- A compact GFM Markdown table (`| Topic / Participant | Key Context | Suggested Move |`)",
        "- 3 concise talking points or decisions to resolve.",
        "- Ground ONLY in the provided context; never invent facts; NEVER use em-dashes.",
      ].join("\n");
    } else {
      systemPrompt = [
        "You are Kizuki's local-only Personal Mind OS context brief analyst.",
        "Generate a dense, executive GitHub-Flavored Markdown Context Brief with:",
        "- `## Context Brief` heading and bottom-line summary",
        "- A compact GFM Markdown table summarizing key facts, status, and open loops",
        "- Clear next actions.",
        "- Ground ONLY in the provided context; never invent facts; NEVER use em-dashes.",
      ].join("\n");
    }

    const userContent = [
      `Draft Kind: ${kind}`,
      `Title: ${title || "(untitled)"}`,
      instructions ? `Instructions: ${instructions}` : "",
      `Primary Context:\n${contextText || "(none provided)"}`,
      ...extraContextParts,
    ]
      .filter(Boolean)
      .join("\n\n");

    const synth = await this.synthesizeWithDualEngine({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      promptForCoherence: `${title} ${contextText.slice(0, 200)}`,
      primaryMaxTokens: 1600,
      primaryTemperature: 0.3,
      fallbackMaxTokens: 1800,
      fallbackTemperature: 0.25,
    });

    if (synth.ok) {
      return {
        ok: true,
        local_only: true,
        kind,
        title: title || kind,
        synthesized: true,
        engine: synth.engine,
        model: synth.model,
        draft: stripEmDashes(synth.content),
        usage: synth.usage,
      };
    }

    // Structured local-only fallback if both LLM endpoints fail
    const fallbackLines: string[] = [];
    if (kind === "reply") {
      fallbackLines.push(`## Local Reply Draft: ${escapeMdCell(title || "Message", 90)}`);
      fallbackLines.push("");
      fallbackLines.push(`Thanks for the note. Following up on **${escapeMdCell(title || "this", 80)}**:`);
      fallbackLines.push("");
      fallbackLines.push(`> Context: ${escapeMdCell(contextText || "See thread above.", 220)}`);
      fallbackLines.push("");
      fallbackLines.push("Let me confirm details on my side and get back to you shortly.");
    } else {
      fallbackLines.push(`## ${kind === "meeting_prep" ? "Meeting Prep" : "Context Brief"}: ${escapeMdCell(title || "Overview", 90)}`);
      fallbackLines.push("");
      fallbackLines.push("| Dimension | Grounded Summary |");
      fallbackLines.push("| --- | --- |");
      fallbackLines.push(`| Subject | ${escapeMdCell(title || kind, 120)} |`);
      fallbackLines.push(`| Key Context | ${escapeMdCell(contextText || "No additional context supplied.", 180)} |`);
      if (relatedDocs.length > 0) {
        fallbackLines.push(`| Related Docs | ${relatedDocs.map((d) => escapeMdCell(d.title, 40)).join("; ")} |`);
      }
      fallbackLines.push(`| Next Action | Confirm key decision points and follow up directly. |`);
    }
    fallbackLines.push("");
    fallbackLines.push(`*Local template fallback (${escapeMdCell(synth.reason, 100)}). Local-only draft; nothing was sent.*`);

    return {
      ok: true,
      local_only: true,
      kind,
      title: title || kind,
      synthesized: false,
      engine: "Local Template Fallback",
      draft: stripEmDashes(fallbackLines.join("\n")),
      fallback_reason: synth.reason,
    };
  }
}

export class BadRequestError extends Error {
  status = 400;
  constructor(message: string) {
    super(message);
    this.name = "BadRequestError";
  }
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends Error {
  status = 404;
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ServiceUnavailableError extends Error {
  status = 503;
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}
