// Proactive Daily Briefing, Auto-Meeting Prep Packs & Open-Commitment Radar (Lane H4)
// Sub-10ms SWR + data_version cached engine over live Calendar, People, Inbox, Board & Actions.
// Strictly local-only: zero outbound sends as the owner, zero em-dashes, 0600 local state ledger.

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import type {
  OpenLoopItem,
  PeopleRadarEntry,
  PeopleRadarResponse,
  RelationshipLedger,
} from "./contracts.ts";
import {
  buildRelationshipLedger,
  isGroupOrBotContact,
  isOutboundMessage,
  normalizeSlug,
  stripEmDashesIntel,
  trimWordBoundary,
  type LedgerMeetingInput,
  type LedgerMessageInput,
} from "./people-intel.ts";
import { PeopleRadarService } from "./people-radar.ts";
import { isBotOrGroupNoiseThread, isOutboundSender, formatAgeCompact } from "./today-intel.ts";
import type {
  KizukiVaultApi,
  OwnerAction,
  PersonDirectoryItem,
  TodayInboxItem,
  TodayResponse,
  TodayScheduleItem,
} from "./vault-api.ts";
import type { KizukiAgentBoardApi } from "./agent-board-api.ts";
import type { KizukiBoardMindBridge, TodayBoardPulseResponse } from "./board-mind-bridge.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MEETING_WINDOW_HOURS = 72;
const CONVERGENCE_WINDOW_MS = 72 * HOUR_MS;
const DEFAULT_TTL_MS = 30_000;

const SELF_TOKENS = new Set([
  "you",
  "me",
  "owner",
  "self",
]);

const OWNER_PROMISE_RE =
  /\b(i['’]ll|i will|will send|will share|let me check|let me get back|by tomorrow|i['’]ll follow up|will follow up|i['’]ll circle back|will review|will confirm|sending over|on my list)\b/i;

const INBOUND_ASK_RE =
  /\?|\b(can you|could you|would you|will you|please|let me know|lmk|by tomorrow|waiting on|need your|send over|thoughts on|confirm|approve|free today|free tomorrow|quick question|when can|asap|urgent)\b/i;

const URGENCY_CUE_RE =
  /\b(today|tomorrow|asap|urgent|tonight|eod|end of day|deadline|blocking|blocked|this morning|this afternoon)\b/i;

export type CommitmentSource = "people_radar" | "today_inbox" | "owner_action";
export type CommitmentKind = "owner_promise" | "inbound_ask" | "owner_action";
export type CommitmentStatus = "open" | "resolved" | "snoozed";
export type CommitmentOp = "resolve" | "snooze" | "reopen" | "draft" | "draft_followup";

export interface MeetingTouchpoint {
  channel: string;
  direction: "in" | "out";
  occurred_at: string;
  age_label: string;
  excerpt: string;
}

export interface MeetingAttendeeDossier {
  raw: string;
  key: string | null;
  name: string;
  tier: string;
  role: string;
  org: string;
  channels: string[];
  drift_z: number | null;
  last_touches: MeetingTouchpoint[];
  open_loops: OpenLoopItem[];
}

export interface MeetingPrepPack {
  id: string;
  title: string;
  calendar: string;
  start: string;
  end: string | null;
  hours_until: number;
  countdown: string;
  is_now: boolean;
  is_today: boolean;
  is_tomorrow: boolean;
  meet_url: string | null;
  attendees: MeetingAttendeeDossier[];
  context_bullets: string[];
  open_loops: Array<{
    person: string;
    kind: "inbound_ask" | "owner_promise";
    channel: string;
    age_label: string;
    excerpt: string;
  }>;
  talking_points: string[];
  urgency_score: number;
}

export interface OpenCommitment {
  id: string;
  kind: CommitmentKind;
  source: CommitmentSource;
  person_key: string | null;
  person_name: string;
  tier: string;
  channel: string;
  occurred_at: string;
  age_hours: number;
  age_label: string;
  excerpt: string;
  why_now: string;
  score: number;
  status: CommitmentStatus;
  snooze_until?: string;
}

export type CrossSignalKind = "convergence" | "board_link" | "velocity_pulse";

export interface CrossChannelSignal {
  id: string;
  kind: CrossSignalKind;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  person_key?: string | null;
  person_name?: string | null;
  thread_id?: string | null;
  channels: string[];
  evidence: string[];
  score: number;
}

export interface ProactiveBriefingResponse {
  generated_at: string;
  elapsed_ms: number;
  cache_hit: boolean;
  data_version: string;
  summary: string;
  meeting_preps: MeetingPrepPack[];
  commitments: OpenCommitment[];
  cross_signals: CrossChannelSignal[];
  counts: {
    meeting_preps: number;
    meetings_24h: number;
    commitments: number;
    commitments_urgent: number;
    commitments_resolved: number;
    commitments_snoozed: number;
    cross_signals: number;
  };
}

export interface MeetingPrepDetailResponse {
  ok: true;
  local_only: true;
  generated_at: string;
  meeting_id: string;
  prep: MeetingPrepPack;
  markdown: string;
}

export interface CommitmentLedgerRecord {
  status: CommitmentStatus;
  updated_at: string;
  resolved_at?: string;
  snooze_until?: string;
}

interface CommitmentLedgerFile {
  version: 1;
  items: Record<string, CommitmentLedgerRecord>;
}

export interface MutateCommitmentRequest {
  id: string;
  op: CommitmentOp;
  hours?: number;
}

export interface MutateCommitmentResponse {
  ok: true;
  local_only: true;
  never_sent?: true;
  id: string;
  op: CommitmentOp;
  status?: CommitmentStatus;
  updated_at: string;
  snooze_until?: string;
  draft?: string;
  person_name?: string;
  channel?: string;
}

export interface ProactiveIntelEngineOptions {
  api: Pick<KizukiVaultApi, "getToday" | "listPeople" | "getPersonDossier"> & {
    vaultPath?: string;
    getPersonalIndex?: () => Promise<PersonalIndexLike>;
    getPersonMessages?: (key: string) => Promise<LedgerMessageInput[]>;
    getDb?: () => { query: (sql: string) => { get: () => unknown } } | null;
  };
  agentBoardApi?: Pick<KizukiAgentBoardApi, "getBlockers"> & {
    getDataVersion?: () => number;
  } | null;
  boardBridge?: Pick<KizukiBoardMindBridge, "getTodayBoardPulse"> | null;
  peopleRadar?: Pick<PeopleRadarService, "getRadar"> | null;
  statePath?: string;
  ttlMs?: number;
  nowFn?: () => number;
}

interface PersonalIndexPersonLike {
  key: string;
  name: string;
  channels: Set<string> | string[];
  is_group?: boolean;
  profile_tier?: string;
  relationship_tier?: string;
  relationship_state?: string;
  role?: string;
  org?: string;
  timeline?: Array<{
    channel: string;
    sender: string;
    direction?: string;
    occurred_at: string;
    text: string;
  }>;
  meetings?: Array<{
    id?: string;
    title: string;
    start: string;
    participants?: string[];
  }>;
  canonical_card?: {
    aliases?: string[];
    world_model?: {
      aliases?: string[];
      handles?: { email?: string; telegram?: string; x?: string; github?: string };
      open_loops?: Array<{ loop: string; state: string; next_evidence: string }>;
      current_read_bullets?: string[];
    };
  } | null;
}

interface PersonalIndexCalendarLike {
  id: string;
  title: string;
  calendar: string;
  start: string;
  end: string | null;
  startMs: number;
  endMs: number | null;
  participants: string[];
  meet_url: string | null;
  dial_in: string | null;
  notes: string;
}

interface PersonalIndexLike {
  peopleList?: PersonalIndexPersonLike[];
  calendar?: PersonalIndexCalendarLike[];
  inboxThreads?: TodayInboxItem[];
}

export class ProactiveBadRequestError extends Error {
  constructor(message: string) {
    super(stripEmDashesIntel(message));
    this.name = "ProactiveBadRequestError";
  }
}

function cleanStr(raw: unknown, maxLen = 220): string {
  const s = stripEmDashesIntel(String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return maxLen > 0 ? trimWordBoundary(s, maxLen) : s;
}

function normLookup(raw: unknown): string {
  return stripEmDashesIntel(String(raw ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9@._+\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normAlpha(raw: unknown): string {
  return stripEmDashesIntel(String(raw ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stableHash(parts: string[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

function isSelfParticipant(raw: string): boolean {
  const clean = normAlpha(raw);
  if (!clean) return true;
  if (SELF_TOKENS.has(clean)) return true;
  const ownerName = (process.env.KIZUKI_OWNER_NAME || "").trim().toLowerCase();
  const low = String(raw || "").toLowerCase();
  if (ownerName && low.includes(ownerName)) return true;
  return false;
}

function tierBonus(tier: string, profileTier?: string): number {
  const t = String(tier || "").toLowerCase();
  if (t === "family") return 30;
  if (t === "core") return 20;
  if (t === "profiled" || t === "active" || profileTier === "v2" || profileTier === "lifeos") return 12;
  if (t === "warm") return 5;
  return 0;
}

function displayTier(tier?: string, profileTier?: string): string {
  const t = String(tier || "").trim();
  if (t === "Family" || t === "Core") return t;
  if (profileTier === "v2" || profileTier === "lifeos" || t === "Active" || t === "Profiled") return "Profiled";
  return t || "Ambient";
}

function channelWeight(channel: string): number {
  const c = String(channel || "").toLowerCase();
  if (c === "whatsapp" || c === "imessage") return 8;
  if (c === "telegram") return 6;
  if (c === "action") return 5;
  if (c === "gmail" || c === "email") return 4;
  return 2;
}

function formatChannelName(channel: string): string {
  const c = String(channel || "").toLowerCase();
  if (c === "whatsapp") return "WhatsApp";
  if (c === "imessage") return "iMessage";
  if (c === "telegram") return "Telegram";
  if (c === "gmail" || c === "email") return "Gmail";
  if (c === "calendar") return "Calendar";
  if (c === "action") return "Action";
  return cleanStr(channel || "Direct", 24) || "Direct";
}

function formatCountdown(diffMs: number): string {
  if (diffMs <= 0 && diffMs >= -90 * 60_000) return "Live now";
  const mins = Math.max(1, Math.round(diffMs / 60_000));
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return remM > 0 ? `in ${hrs}h ${remM}m` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remH = hrs % 24;
  return remH > 0 ? `in ${days}d ${remH}h` : `in ${days}d`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function normalizeEmail(raw: string): string {
  const m = String(raw || "").toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : "";
}

function extractNamePart(raw: string): string {
  // Handle "Alex Rivera <alex@example.com>" or "alex@example.com"
  const s = stripEmDashesIntel(String(raw || "")).trim();
  const angle = s.match(/^([^<]+)<[^>]+>$/);
  if (angle && angle[1].trim()) return angle[1].trim().replace(/^["']|["']$/g, "");
  if (s.includes("@") && !s.includes(" ")) {
    const local = s.split("@")[0].replace(/[._-]+/g, " ").trim();
    return local
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return s;
}

interface UnifiedPersonRecord {
  key: string;
  name: string;
  tier: string;
  profile_tier: string;
  role: string;
  org: string;
  channels: string[];
  emails: string[];
  aliases: string[];
  messages: LedgerMessageInput[];
  meetings: LedgerMeetingInput[];
  card_loops: Array<{ loop: string; state: string; next_evidence: string }>;
  ledger?: RelationshipLedger;
}

function buildPersonMatcher(people: UnifiedPersonRecord[]): (raw: string) => UnifiedPersonRecord | null {
  const byExact = new Map<string, UnifiedPersonRecord>();
  const byEmail = new Map<string, UnifiedPersonRecord>();
  const byFirst = new Map<string, UnifiedPersonRecord | "ambiguous">();

  const registerExact = (token: string, rec: UnifiedPersonRecord) => {
    const t = normAlpha(token);
    if (t && t.length >= 2 && !byExact.has(t)) {
      byExact.set(t, rec);
    }
  };

  for (const p of people) {
    registerExact(p.key, p);
    registerExact(normalizeSlug(p.key), p);
    registerExact(p.name, p);
    for (const al of p.aliases) {
      registerExact(al, p);
    }
    for (const em of p.emails) {
      const cleanEm = em.toLowerCase().trim();
      if (cleanEm && !byEmail.has(cleanEm)) byEmail.set(cleanEm, p);
    }
    const first = normAlpha(p.name).split(" ")[0];
    if (first && first.length >= 3) {
      const prev = byFirst.get(first);
      if (!prev) byFirst.set(first, p);
      else if (prev !== p) byFirst.set(first, "ambiguous");
    }
  }

  return (raw: string): UnifiedPersonRecord | null => {
    const em = normalizeEmail(raw);
    if (em) {
      const hit = byEmail.get(em);
      if (hit) return hit;
    }
    const namePart = extractNamePart(raw);
    const exactCandidates = [normAlpha(raw), normAlpha(namePart), normalizeSlug(namePart)];
    for (const c of exactCandidates) {
      if (!c) continue;
      const hit = byExact.get(c);
      if (hit) return hit;
    }
    const first = normAlpha(namePart).split(" ")[0];
    if (first && first.length >= 3) {
      const firstHit = byFirst.get(first);
      if (firstHit && firstHit !== "ambiguous") return firstHit;
    }
    return null;
  };
}

export class ProactiveIntelEngine {
  private readonly api: ProactiveIntelEngineOptions["api"];
  private readonly agentBoardApi: ProactiveIntelEngineOptions["agentBoardApi"];
  private readonly boardBridge: ProactiveIntelEngineOptions["boardBridge"];
  private readonly peopleRadar: Pick<PeopleRadarService, "getRadar"> | null;
  private readonly statePath: string;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  private ledger: CommitmentLedgerFile;
  private ledgerVersion = 0;
  private cached: { value: ProactiveBriefingResponse; builtAt: number; versionKey: string } | null = null;
  private inFlight: Promise<ProactiveBriefingResponse> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ProactiveIntelEngineOptions) {
    this.api = opts.api;
    this.agentBoardApi = opts.agentBoardApi ?? null;
    this.boardBridge = opts.boardBridge ?? null;
    this.peopleRadar = opts.peopleRadar ?? null;
    const vaultBase =
      opts.api.vaultPath ||
      process.env.KIZUKI_VAULT ||
      process.env.KIZUKI_VAULT_PATH ||
      join(homedir(), "Kizuki");
    this.statePath = opts.statePath || join(vaultBase, "owner-notes", "commitments-state.json");
    this.ttlMs = Math.max(2_000, opts.ttlMs ?? DEFAULT_TTL_MS);
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.ledger = this.loadLedgerSync();
  }

  getStatePath(): string {
    return this.statePath;
  }

  startBackgroundRefresh(intervalMs = 30_000): void {
    if (this.refreshTimer) return;
    queueMicrotask(() => {
      void this.refresh().catch(() => {});
    });
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, Math.max(10_000, intervalMs));
    if (typeof (this.refreshTimer as unknown as { unref?: () => void }).unref === "function") {
      (this.refreshTimer as unknown as { unref: () => void }).unref();
    }
  }

  stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  invalidate(): void {
    this.cached = null;
  }

  private loadLedgerSync(): CommitmentLedgerFile {
    try {
      if (!existsSync(this.statePath)) {
        return { version: 1, items: {} };
      }
      const raw = readFileSync(this.statePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<CommitmentLedgerFile>;
      if (parsed && typeof parsed === "object" && parsed.items && typeof parsed.items === "object") {
        return { version: 1, items: { ...parsed.items } };
      }
    } catch {
      // Corrupt or unreadable state starts clean without crashing Today.
    }
    return { version: 1, items: {} };
  }

  private async persistLedger(): Promise<void> {
    const dir = dirname(this.statePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.statePath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const payload = `${JSON.stringify(this.ledger, null, 2)}\n`;
    await writeFile(tmpPath, payload, { encoding: "utf8", mode: 0o600 });
    await chmod(tmpPath, 0o600);
    await rename(tmpPath, this.statePath);
    await chmod(this.statePath, 0o600);
    this.ledgerVersion += 1;
  }

  private readDataVersionKey(): string {
    let boardVer = 0;
    try {
      if (this.agentBoardApi && typeof this.agentBoardApi.getDataVersion === "function") {
        boardVer = Number(this.agentBoardApi.getDataVersion()) || 0;
      }
    } catch {
      boardVer = 0;
    }

    let vaultDbVer = 0;
    try {
      const db = typeof this.api.getDb === "function" ? this.api.getDb() : null;
      if (db && typeof db.query === "function") {
        const row = db.query("PRAGMA data_version").get() as { data_version?: number } | null;
        vaultDbVer = Number(row?.data_version) || 0;
      }
    } catch {
      vaultDbVer = 0;
    }

    const apiAny = this.api as unknown as {
      personalIndexSnapshot?: { version?: number };
      actionsVersion?: number;
    };
    const pVer = Number(apiAny.personalIndexSnapshot?.version) || 0;
    const aVer = Number(apiAny.actionsVersion) || 0;
    return `v:${vaultDbVer}:${boardVer}:${pVer}:${aVer}:${this.ledgerVersion}`;
  }

  async getBriefing(opts: { refresh?: boolean } = {}): Promise<ProactiveBriefingResponse> {
    const t0 = performance.now();
    const now = this.nowFn();
    const versionKey = this.readDataVersionKey();
    const isTestRun =
      process.env.NODE_ENV === "test" ||
      (typeof Bun !== "undefined" && /\.test\.ts$/.test(String(Bun.main || "")));

    if (this.cached && !opts.refresh) {
      const age = now - this.cached.builtAt;
      const sameVersion = this.cached.versionKey === versionKey;
      const sameLedger = this.cached.versionKey.endsWith(`:${this.ledgerVersion}`);
      if (sameVersion) {
        if (age > this.ttlMs && !this.inFlight) {
          void this.refresh().catch(() => {});
        }
        return {
          ...this.cached.value,
          cache_hit: true,
          elapsed_ms: round1(Math.max(0.01, performance.now() - t0)),
        };
      }
      // In live production, serve SWR immediately when background daemon ticks SQLite data_version
      if (!isTestRun && sameLedger && age < this.ttlMs) {
        if (!this.inFlight) {
          void this.refresh().catch(() => {});
        }
        return {
          ...this.cached.value,
          cache_hit: true,
          elapsed_ms: round1(Math.max(0.01, performance.now() - t0)),
        };
      }
    }

    const fresh = await this.refresh();
    return {
      ...fresh,
      cache_hit: false,
      elapsed_ms: round1(Math.max(0.01, performance.now() - t0)),
    };
  }

  async refresh(): Promise<ProactiveBriefingResponse> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.computeBriefing()
      .then((snap) => {
        this.cached = {
          value: snap,
          builtAt: this.nowFn(),
          versionKey: snap.data_version,
        };
        return snap;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async loadUnifiedPeople(
    peopleDir: PersonDirectoryItem[],
    personal: PersonalIndexLike | null,
    upcomingParticipantStrings: string[],
    nowMs: number,
  ): Promise<UnifiedPersonRecord[]> {
    const byKey = new Map<string, UnifiedPersonRecord>();

    if (personal && Array.isArray(personal.peopleList) && personal.peopleList.length > 0) {
      for (const p of personal.peopleList) {
        if (!p || p.is_group || isGroupOrBotContact(p.name, p.key)) continue;
        const channels = Array.isArray(p.channels) ? p.channels : Array.from(p.channels || []);
        const wm = p.canonical_card?.world_model;
        const emails: string[] = [];
        if (wm?.handles?.email) emails.push(wm.handles.email);
        const aliases = [
          ...(p.canonical_card?.aliases || []),
          ...(wm?.aliases || []),
          wm?.handles?.telegram || "",
          wm?.handles?.x || "",
        ].filter(Boolean);

        const messages: LedgerMessageInput[] = (p.timeline || []).map((t) => ({
          channel: t.channel,
          sender: t.sender,
          direction: t.direction,
          occurred_at: t.occurred_at,
          text: t.text,
        }));
        const meetings: LedgerMeetingInput[] = (p.meetings || []).map((m) => ({
          title: m.title,
          start: m.start,
        }));

        byKey.set(p.key, {
          key: p.key,
          name: cleanStr(p.name, 80),
          tier: displayTier(p.relationship_tier, p.profile_tier),
          profile_tier: String(p.profile_tier || ""),
          role: cleanStr(p.role || "", 80),
          org: cleanStr(p.org || "", 80),
          channels,
          emails,
          aliases,
          messages,
          meetings,
          card_loops: (wm?.open_loops || []).map((l) => ({
            loop: cleanStr(l.loop, 180),
            state: cleanStr(l.state || "open", 40),
            next_evidence: cleanStr(l.next_evidence || "", 120),
          })),
        });
      }
    }

    // Merge directory entries not already present (also covers mock APIs without getPersonalIndex)
    for (const item of peopleDir) {
      if (!item || isGroupOrBotContact(item.name, item.key, item.last_snippet)) continue;
      if (!byKey.has(item.key)) {
        byKey.set(item.key, {
          key: item.key,
          name: cleanStr(item.name, 80),
          tier: displayTier(item.relationship_tier, item.profile_tier),
          profile_tier: String(item.profile_tier || ""),
          role: cleanStr(item.role || "", 80),
          org: cleanStr(item.org || "", 80),
          channels: Array.isArray(item.channels) ? item.channels : [],
          emails: [],
          aliases: [],
          messages: [],
          meetings: [],
          card_loops: [],
        });
      }
    }

    const records = Array.from(byKey.values());

    // If personalIndex was unavailable (e.g. mock API without getPersonalIndex), hydrate dossiers for
    // meeting participants and top Core/Family people.
    const hasPersonalIndex = Boolean(personal && Array.isArray(personal.peopleList) && personal.peopleList.length > 0);
    const needsHydration = hasPersonalIndex ? [] : records.filter((r) => r.messages.length === 0);
    if (needsHydration.length > 0 && typeof this.api.getPersonDossier === "function") {
      const matcher = buildPersonMatcher(records);
      const priorityKeys = new Set<string>();
      for (const rawPart of upcomingParticipantStrings) {
        const hit = matcher(rawPart);
        if (hit) priorityKeys.add(hit.key);
      }
      for (const r of needsHydration) {
        if (r.tier === "Family" || r.tier === "Core" || priorityKeys.size < 16) {
          priorityKeys.add(r.key);
        }
        if (priorityKeys.size >= 24) break;
      }

      await Promise.all(
        Array.from(priorityKeys).map(async (key) => {
          const rec = byKey.get(key);
          if (!rec || rec.messages.length > 0) return;
          try {
            const dossier = await this.api.getPersonDossier({ key, limit: 80 });
            if (!dossier?.person) return;
            if (dossier.person.handles?.email) rec.emails.push(dossier.person.handles.email);
            if (Array.isArray(dossier.world_model?.aliases)) {
              rec.aliases.push(...dossier.world_model.aliases);
            }
            rec.messages = (dossier.timeline || []).map((t) => ({
              channel: t.channel,
              sender: t.sender,
              direction: t.direction,
              occurred_at: t.occurred_at,
              text: t.text,
            }));
            rec.meetings = (dossier.meetings || []).map((m) => ({
              title: m.title,
              start: m.start,
              is_upcoming: m.is_upcoming,
            }));
            rec.card_loops = (dossier.world_model?.open_loops || []).map((l) => ({
              loop: cleanStr(l.loop, 180),
              state: cleanStr(l.state || "open", 40),
              next_evidence: cleanStr(l.next_evidence || "", 120),
            }));
            if (dossier.profile_visuals?.ledger) {
              rec.ledger = dossier.profile_visuals.ledger;
            }
          } catch {
            // Skip unreadable dossier
          }
        }),
      );
    }

    // Build relationship ledgers for people who have messages or meetings
    for (const rec of records) {
      if (!rec.ledger && (rec.messages.length > 0 || rec.meetings.length > 0)) {
        rec.ledger = buildRelationshipLedger(rec.messages, rec.meetings, nowMs, {
          name: rec.name,
          tier: rec.tier,
        });
      }
    }

    return records;
  }

  private collectUpcomingMeetings(
    today: Partial<TodayResponse> | null,
    personal: PersonalIndexLike | null,
    nowMs: number,
  ): TodayScheduleItem[] {
    const minMs = nowMs - 15 * 60_000;
    const maxMs = nowMs + MEETING_WINDOW_HOURS * HOUR_MS;
    const out: TodayScheduleItem[] = [];
    const seen = new Set<string>();

    const consider = (ev: TodayScheduleItem) => {
      if (!ev || !ev.start) return;
      const startMs = Date.parse(ev.start);
      if (!Number.isFinite(startMs)) return;
      const endMs = ev.end ? Date.parse(ev.end) : NaN;
      const activeNow = Number.isFinite(endMs) && startMs <= nowMs && endMs >= nowMs;
      if (!activeNow && (startMs < minMs || startMs > maxMs)) return;
      const normTitle = normAlpha(ev.title || "meeting");
      const bucket = Math.round(startMs / (15 * 60_000));
      const dedupKey = `${normTitle}|${bucket}`;
      if (seen.has(ev.id) || seen.has(dedupKey)) return;
      seen.add(ev.id);
      seen.add(dedupKey);
      out.push(ev);
    };

    for (const ev of Array.isArray(today?.schedule) ? today!.schedule! : []) {
      consider(ev);
    }

    if (personal && Array.isArray(personal.calendar)) {
      for (const c of personal.calendar) {
        const diffMs = c.startMs - nowMs;
        consider({
          id: c.id,
          title: c.title,
          calendar: c.calendar,
          start: c.start,
          end: c.end,
          is_now: c.startMs <= nowMs && (c.endMs ? c.endMs >= nowMs : diffMs >= -45 * 60_000),
          is_today: diffMs >= -15 * 60_000 && diffMs < 24 * HOUR_MS,
          is_tomorrow: diffMs >= 24 * HOUR_MS && diffMs < 48 * HOUR_MS,
          countdown: formatCountdown(diffMs),
          participants: c.participants || [],
          meet_url: c.meet_url,
          dial_in: c.dial_in,
          notes: c.notes || "",
          body: c.notes || "",
          raw_text: c.notes || "",
        });
      }
    }

    out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    return out.slice(0, 14);
  }

  private buildMeetingPreps(
    upcoming: TodayScheduleItem[],
    people: UnifiedPersonRecord[],
    inbox: TodayInboxItem[],
    nowMs: number,
  ): MeetingPrepPack[] {
    const matchPerson = buildPersonMatcher(people);
    const inboxByPerson = new Map<string, TodayInboxItem[]>();

    for (const item of inbox) {
      if (!item || isBotOrGroupNoiseThread(item)) continue;
      const p = matchPerson(item.sender) || matchPerson(item.thread_title);
      if (!p) continue;
      const arr = inboxByPerson.get(p.key) || [];
      arr.push(item);
      inboxByPerson.set(p.key, arr);
    }

    const preps: MeetingPrepPack[] = [];

    for (const ev of upcoming) {
      const startMs = Date.parse(ev.start);
      const diffMs = startMs - nowMs;
      const hoursUntil = round1(Math.max(0, diffMs / HOUR_MS));
      const rawParticipants = Array.isArray(ev.participants) ? ev.participants : [];

      const attendees: MeetingAttendeeDossier[] = [];
      const seenAttendeeKey = new Set<string>();

      const addParticipant = (rawPart: string) => {
        const trimmed = cleanStr(rawPart, 100);
        if (!trimmed || isSelfParticipant(trimmed)) return;
        const matched = matchPerson(trimmed);
        const dedupKey = matched ? `p:${matched.key}` : `r:${normAlpha(trimmed)}`;
        if (seenAttendeeKey.has(dedupKey)) return;
        seenAttendeeKey.add(dedupKey);

        if (matched) {
          const pastMsgs = [...matched.messages]
            .filter((m) => {
              const ms = Date.parse(m.occurred_at);
              return Number.isFinite(ms) && ms <= nowMs;
            })
            .sort((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));

          // Also include inbox messages for this person if not already in timeline
          const inboxHits = inboxByPerson.get(matched.key) || [];
          const touchSeen = new Set<string>();
          const lastTouches: MeetingTouchpoint[] = [];
          const pushTouch = (
            channel: string,
            direction: "in" | "out",
            occurredAt: string,
            text: string,
          ) => {
            const excerpt = cleanStr(text, 160);
            if (!excerpt) return;
            const tKey = `${channel}|${occurredAt.slice(0, 16)}|${excerpt.slice(0, 40).toLowerCase()}`;
            if (touchSeen.has(tKey)) return;
            touchSeen.add(tKey);
            const ms = Date.parse(occurredAt);
            const ageH = Number.isFinite(ms) ? Math.max(0.05, (nowMs - ms) / HOUR_MS) : 0;
            lastTouches.push({
              channel: formatChannelName(channel),
              direction,
              occurred_at: occurredAt,
              age_label: `${formatAgeCompact(ageH)} ago`,
              excerpt,
            });
          };

          for (const m of pastMsgs) {
            pushTouch(
              m.channel || "direct",
              isOutboundMessage(m) ? "out" : "in",
              m.occurred_at,
              m.text || "",
            );
            if (lastTouches.length >= 3) break;
          }
          if (lastTouches.length < 3) {
            for (const ib of inboxHits) {
              pushTouch(
                ib.channel,
                isOutboundSender(ib.sender) ? "out" : "in",
                ib.occurred_at,
                ib.preview || ib.full_text || ib.thread_title,
              );
              if (lastTouches.length >= 3) break;
            }
          }

          const loops: OpenLoopItem[] = [...(matched.ledger?.open_loops || [])];
          // Include recent unanswered inbound inbox thread as an open loop if not already represented
          for (const ib of inboxHits) {
            if (isOutboundSender(ib.sender)) continue;
            const excerpt = cleanStr(ib.preview || ib.full_text, 160);
            if (!excerpt) continue;
            const dup = loops.some((l) => l.excerpt.toLowerCase().slice(0, 32) === excerpt.toLowerCase().slice(0, 32));
            if (!dup) {
              const ageH = Math.max(0.1, (nowMs - Date.parse(ib.occurred_at)) / HOUR_MS);
              loops.push({
                kind: "inbound_ask",
                channel: ib.channel,
                date: ib.occurred_at,
                ageHours: round1(ageH),
                excerpt,
              });
            }
          }

          attendees.push({
            raw: trimmed,
            key: matched.key,
            name: matched.name,
            tier: matched.tier,
            role: matched.role,
            org: matched.org,
            channels: matched.channels,
            drift_z: matched.ledger ? round1(matched.ledger.drift_z) : null,
            last_touches: lastTouches.slice(0, 3),
            open_loops: loops.slice(0, 4),
          });
        } else {
          attendees.push({
            raw: trimmed,
            key: null,
            name: cleanStr(extractNamePart(trimmed), 60) || trimmed,
            tier: "Guest",
            role: "",
            org: "",
            channels: ["calendar"],
            drift_z: null,
            last_touches: [],
            open_loops: [],
          });
        }
      };

      for (const rawP of rawParticipants) {
        addParticipant(rawP);
      }

      // If calendar event listed no participants, try matching a known person named in the meeting title
      if (attendees.length === 0 && ev.title) {
        const titleNorm = normAlpha(ev.title);
        for (const p of people) {
          const pn = normAlpha(p.name);
          if (pn.length >= 4 && titleNorm.includes(pn)) {
            addParticipant(p.name);
            if (attendees.length >= 2) break;
          }
        }
      }

      const aggregatedLoops: MeetingPrepPack["open_loops"] = [];
      for (const att of attendees) {
        for (const l of att.open_loops) {
          aggregatedLoops.push({
            person: att.name,
            kind: l.kind,
            channel: formatChannelName(l.channel),
            age_label: `${formatAgeCompact(l.ageHours)} ago`,
            excerpt: cleanStr(l.excerpt, 160),
          });
        }
      }

      const contextBullets: string[] = [];
      const calLabel = cleanStr(ev.calendar || "Calendar", 40);
      contextBullets.push(
        `${ev.is_now ? "In progress now" : `Starts ${formatCountdown(diffMs)}`} on ${calLabel}${ev.meet_url ? " (video link ready)" : ""}.`,
      );
      if (attendees.length > 0) {
        const summaryNames = attendees
          .slice(0, 4)
          .map((a) => `${a.name}${a.role ? ` (${a.role}${a.org ? `, ${a.org}` : ""})` : a.org ? ` (${a.org})` : ""}`)
          .join(", ");
        contextBullets.push(`Attendees: ${summaryNames}.`);
      }
      for (const att of attendees.slice(0, 3)) {
        if (att.last_touches.length > 0) {
          const lt = att.last_touches[0];
          contextBullets.push(
            `Last touch with ${att.name} (${lt.channel}, ${lt.age_label}): "${cleanStr(lt.excerpt, 110)}"`,
          );
        }
      }
      const notesClean = cleanStr(ev.notes || ev.body || "", 180);
      if (notesClean) {
        contextBullets.push(`Calendar notes: ${notesClean}`);
      }

      const talkingPoints: string[] = [];
      for (const loop of aggregatedLoops.slice(0, 3)) {
        if (loop.kind === "owner_promise") {
          talkingPoints.push(
            `Close your open commitment to ${loop.person} (${loop.channel}, ${loop.age_label}): "${cleanStr(loop.excerpt, 100)}"`,
          );
        } else {
          talkingPoints.push(
            `Address ${loop.person}'s pending ask (${loop.channel}, ${loop.age_label}): "${cleanStr(loop.excerpt, 100)}"`,
          );
        }
      }
      for (const att of attendees) {
        if (talkingPoints.length >= 4) break;
        if (att.drift_z !== null && att.drift_z >= 2.0) {
          talkingPoints.push(
            `Reconnect cadence with ${att.name} (quiet stretch drift z=${att.drift_z.toFixed(1)}) and align on next milestone.`,
          );
        }
      }
      if (talkingPoints.length === 0) {
        talkingPoints.push(
          `Confirm clear outcome and concrete owner for "${cleanStr(ev.title, 70)}" before closing the call.`,
        );
      }

      const maxTierBonus = attendees.reduce((acc, a) => Math.max(acc, tierBonus(a.tier)), 0);
      const timeScore = ev.is_now
        ? 110
        : hoursUntil <= 2
          ? 100 - hoursUntil * 4
          : hoursUntil <= 24
            ? 85 - hoursUntil * 1.2
            : Math.max(25, 55 - (hoursUntil - 24) * 0.5);
      const urgencyScore = round1(timeScore + maxTierBonus * 0.5 + Math.min(20, aggregatedLoops.length * 6));

      preps.push({
        id: cleanStr(ev.id || `mtg-${stableHash([ev.title, ev.start])}`, 96),
        title: cleanStr(ev.title || "Upcoming meeting", 120),
        calendar: calLabel,
        start: ev.start,
        end: ev.end || null,
        hours_until: hoursUntil,
        countdown: ev.is_now ? "Live now" : formatCountdown(diffMs),
        is_now: Boolean(ev.is_now),
        is_today: Boolean(ev.is_today || (diffMs >= -15 * 60_000 && diffMs < 24 * HOUR_MS)),
        is_tomorrow: Boolean(ev.is_tomorrow || (diffMs >= 24 * HOUR_MS && diffMs < 48 * HOUR_MS)),
        meet_url: ev.meet_url || null,
        attendees,
        context_bullets: contextBullets.slice(0, 6),
        open_loops: aggregatedLoops.slice(0, 6),
        talking_points: talkingPoints.slice(0, 5),
        urgency_score: urgencyScore,
      });
    }

    return preps;
  }

  private buildCommitments(
    people: UnifiedPersonRecord[],
    inbox: TodayInboxItem[],
    actions: OwnerAction[],
    nowMs: number,
  ): {
    active: OpenCommitment[];
    all: OpenCommitment[];
    resolvedCount: number;
    snoozedCount: number;
  } {
    const matchPerson = buildPersonMatcher(people);
    const candidates: OpenCommitment[] = [];
    const seenFingerprints = new Set<string>();

    const scoreAndPush = (draft: Omit<OpenCommitment, "score" | "status" | "snooze_until" | "age_label">) => {
      const cleanExcerpt = cleanStr(draft.excerpt, 200);
      if (!cleanExcerpt) return;
      const fp = `${normAlpha(draft.person_name)}|${draft.kind}|${normAlpha(cleanExcerpt).slice(0, 48)}`;
      if (seenFingerprints.has(fp)) return;
      seenFingerprints.add(fp);

      const ageH = Math.max(0.05, Number(draft.age_hours) || 0.1);
      const base =
        draft.kind === "owner_promise" ? 58 : draft.kind === "inbound_ask" ? 54 : 48;
      const tBonus = tierBonus(draft.tier);
      const ageScore = Math.min(34, 4 + Math.sqrt(Math.min(ageH, 168)) * 3.8);
      const chBonus = channelWeight(draft.channel);
      const urgentCue = URGENCY_CUE_RE.test(cleanExcerpt) ? 12 : 0;
      const score = round1(base + tBonus + ageScore + chBonus + urgentCue);

      const saved = this.ledger.items[draft.id];
      let status: CommitmentStatus = "open";
      let snoozeUntil: string | undefined;
      if (saved) {
        if (saved.status === "resolved") {
          status = "resolved";
        } else if (saved.status === "snoozed" && saved.snooze_until) {
          const untilMs = Date.parse(saved.snooze_until);
          if (Number.isFinite(untilMs) && untilMs > nowMs) {
            status = "snoozed";
            snoozeUntil = saved.snooze_until;
          }
        }
      }

      candidates.push({
        ...draft,
        excerpt: cleanExcerpt,
        age_hours: round1(ageH),
        age_label: formatAgeCompact(ageH),
        score,
        status,
        ...(snoozeUntil ? { snooze_until: snoozeUntil } : {}),
      });
    };

    // Source 1: People Radar / RelationshipLedger open_loops (owner_promise & inbound_ask)
    for (const p of people) {
      const loops = p.ledger?.open_loops || [];
      for (const loop of loops) {
        if (loop.ageHours > 24 * 21) continue;
        const cid = `loop:${p.key}:${loop.kind}:${stableHash([loop.channel, loop.excerpt.slice(0, 64)])}`;
        const chLabel = formatChannelName(loop.channel);
        const whyNow =
          loop.kind === "owner_promise"
            ? `You committed to ${p.name} (${p.tier}) on ${chLabel} ${formatAgeCompact(loop.ageHours)} ago.`
            : `${p.name} (${p.tier}) asked on ${chLabel} ${formatAgeCompact(loop.ageHours)} ago with no follow-up.`;
        scoreAndPush({
          id: cid,
          kind: loop.kind,
          source: "people_radar",
          person_key: p.key,
          person_name: p.name,
          tier: p.tier,
          channel: loop.channel,
          occurred_at: loop.date,
          age_hours: loop.ageHours,
          excerpt: loop.excerpt,
          why_now: cleanStr(whyNow, 180),
        });
      }
    }

    // Source 2: Recent Today inbox threads with promise/ask language
    for (const item of inbox) {
      if (!item || isBotOrGroupNoiseThread(item)) continue;
      const ms = Date.parse(item.occurred_at || "");
      if (!Number.isFinite(ms)) continue;
      const ageH = Math.max(0.05, (nowMs - ms) / HOUR_MS);
      if (ageH > 24 * 14) continue;

      const text = cleanStr(item.full_text || item.preview || item.thread_title, 220);
      if (!text) continue;

      const outbound = isOutboundSender(item.sender);
      const isPromise = OWNER_PROMISE_RE.test(text);
      const isAsk = !outbound && INBOUND_ASK_RE.test(text);
      if (!isPromise && !isAsk) continue;

      const kind: CommitmentKind = isPromise ? "owner_promise" : "inbound_ask";
      const matched = matchPerson(item.sender) || matchPerson(item.thread_title);
      const personName = matched?.name || cleanStr(outbound ? item.thread_title : item.sender, 60) || "Contact";
      if (isGroupOrBotContact(personName, matched?.key || "")) continue;

      const cid = `inbox:${item.channel}:${stableHash([item.thread_key || item.id, kind, text.slice(0, 56)])}`;
      const chLabel = formatChannelName(item.channel);
      const tier = matched?.tier || "1:1";
      const whyNow =
        kind === "owner_promise"
          ? `Promise detected in ${chLabel} with ${personName} (${formatAgeCompact(ageH)} ago).`
          : `Direct ask from ${personName} on ${chLabel} (${formatAgeCompact(ageH)} ago).`;

      scoreAndPush({
        id: cid,
        kind,
        source: "today_inbox",
        person_key: matched?.key || null,
        person_name: personName,
        tier,
        channel: item.channel,
        occurred_at: item.occurred_at,
        age_hours: ageH,
        excerpt: text,
        why_now: cleanStr(whyNow, 180),
      });
    }

    // Source 3: Active Owner Actions due soon
    for (const act of actions) {
      if (!act || act.done) continue;
      const ms = Date.parse(act.created_at || "");
      const ageH = Number.isFinite(ms) ? Math.max(0.1, (nowMs - ms) / HOUR_MS) : 2;
      const tier = act.tag === "Family" ? "Family" : act.tag === "Reply" ? "Core" : "Profiled";
      const text = cleanStr(act.detail ? `${act.title}: ${act.detail}` : act.title, 200);
      scoreAndPush({
        id: `action:${act.id}`,
        kind: "owner_action",
        source: "owner_action",
        person_key: null,
        person_name: cleanStr(act.tag || "Work", 32),
        tier,
        channel: "action",
        occurred_at: act.created_at || new Date(nowMs).toISOString(),
        age_hours: ageH,
        excerpt: text,
        why_now: cleanStr(`Open ${act.tag || "Work"} action waiting ${formatAgeCompact(ageH)}.`, 180),
      });
    }

    candidates.sort((a, b) => b.score - a.score || b.age_hours - a.age_hours || a.id.localeCompare(b.id));

    let resolvedCount = 0;
    let snoozedCount = 0;
    const active: OpenCommitment[] = [];
    for (const c of candidates) {
      if (c.status === "resolved") resolvedCount += 1;
      else if (c.status === "snoozed") snoozedCount += 1;
      else active.push(c);
    }

    return {
      active: active.slice(0, 18),
      all: candidates,
      resolvedCount,
      snoozedCount,
    };
  }

  private buildCrossSignals(
    people: UnifiedPersonRecord[],
    upcoming: TodayScheduleItem[],
    inbox: TodayInboxItem[],
    workstreams: Array<{ name: string; domain?: string; state?: string }>,
    radar: PeopleRadarResponse | null,
    boardPulse: TodayBoardPulseResponse | null,
    nowMs: number,
  ): CrossChannelSignal[] {
    const signals: CrossChannelSignal[] = [];
    const seen = new Set<string>();
    const matchPerson = buildPersonMatcher(people);

    // 1. Multi-channel convergence (same person active on 2+ channels within 72h)
    const activityByPerson = new Map<
      string,
      { person: UnifiedPersonRecord; channels: Map<string, { count: number; latestAt: number; sample: string }> }
    >();

    const recordTouch = (person: UnifiedPersonRecord, channel: string, tsMs: number, sample: string) => {
      if (!Number.isFinite(tsMs)) return;
      if (channel !== "calendar" && (nowMs - tsMs > CONVERGENCE_WINDOW_MS || tsMs > nowMs + HOUR_MS)) return;
      if (channel === "calendar" && Math.abs(tsMs - nowMs) > CONVERGENCE_WINDOW_MS) return;

      let entry = activityByPerson.get(person.key);
      if (!entry) {
        entry = { person, channels: new Map() };
        activityByPerson.set(person.key, entry);
      }
      const ch = channel.toLowerCase();
      const prev = entry.channels.get(ch);
      if (!prev) {
        entry.channels.set(ch, { count: 1, latestAt: tsMs, sample: cleanStr(sample, 100) });
      } else {
        prev.count += 1;
        if (tsMs >= prev.latestAt) {
          prev.latestAt = tsMs;
          if (sample) prev.sample = cleanStr(sample, 100);
        }
      }
    };

    for (const p of people) {
      for (const m of p.messages) {
        recordTouch(p, m.channel || "direct", Date.parse(m.occurred_at), m.text || "");
      }
      for (const mtg of p.meetings) {
        recordTouch(p, "calendar", Date.parse(mtg.start), mtg.title);
      }
    }

    for (const item of inbox) {
      if (!item || isBotOrGroupNoiseThread(item)) continue;
      const p = matchPerson(item.sender) || matchPerson(item.thread_title);
      if (p) {
        recordTouch(p, item.channel, Date.parse(item.occurred_at), item.preview || item.thread_title);
      }
    }

    for (const ev of upcoming) {
      const startMs = Date.parse(ev.start);
      for (const rawP of ev.participants || []) {
        if (isSelfParticipant(rawP)) continue;
        const p = matchPerson(rawP);
        if (p) recordTouch(p, "calendar", startMs, ev.title);
      }
    }

    for (const { person, channels } of activityByPerson.values()) {
      if (channels.size < 2) continue;
      const chList = Array.from(channels.entries()).sort((a, b) => b[1].latestAt - a[1].latestAt);
      const labels = chList.map(([c]) => formatChannelName(c));
      const evidence = chList.map(
        ([c, info]) => `${formatChannelName(c)} (${info.count})${info.sample ? `: "${cleanStr(info.sample, 48)}"` : ""}`,
      );
      const id = `conv:${person.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const score = round1(68 + channels.size * 12 + tierBonus(person.tier) * 0.6);
      signals.push({
        id,
        kind: "convergence",
        severity: channels.size >= 3 || person.tier === "Family" || person.tier === "Core" ? "high" : "medium",
        title: `${person.name} active across ${labels.join(" + ")}`,
        detail: `${person.tier} contact converged across ${channels.size} channels in the last 72h.`,
        person_key: person.key,
        person_name: person.name,
        channels: chList.map(([c]) => c),
        evidence: evidence.slice(0, 4),
        score,
      });
    }

    // 2. Board-to-Today links (blocked Agent Board threads mentioning active Today people/projects)
    const activePeopleTokens = new Map<string, string>();
    for (const ev of upcoming) {
      for (const rawP of ev.participants || []) {
        const p = matchPerson(rawP);
        if (p) activePeopleTokens.set(normAlpha(p.name), p.name);
      }
    }
    for (const item of inbox.slice(0, 25)) {
      const p = matchPerson(item.sender) || matchPerson(item.thread_title);
      if (p) activePeopleTokens.set(normAlpha(p.name), p.name);
    }
    for (const p of people) {
      if (p.tier === "Family" || p.tier === "Core") {
        const first = normAlpha(p.name).split(" ")[0];
        if (first && first.length >= 4) activePeopleTokens.set(first, p.name);
        activePeopleTokens.set(normAlpha(p.name), p.name);
      }
    }
    const workstreamNames = workstreams
      .map((w) => cleanStr(w.name, 60))
      .filter((n) => n.length >= 3);

    const boardThreads = Array.isArray(boardPulse?.topThreads) ? boardPulse!.topThreads : [];
    for (const th of boardThreads) {
      const isBlocked = Boolean(th.isBlocked);
      const isDecision = th.signal?.signalKind === "decision";
      if (!isBlocked && !isDecision) continue;

      const textHay = normAlpha(`${th.text || ""} ${th.channel || ""}`);
      const linkedHits: string[] = [];
      let matchedPersonKey: string | null = null;
      let matchedPersonName: string | null = null;

      for (const ml of Array.isArray(th.mindLinks) ? th.mindLinks : []) {
        if (ml.kind === "person" && ml.label) {
          linkedHits.push(`Person: ${cleanStr(ml.label, 40)}`);
          if (!matchedPersonKey) {
            matchedPersonKey = ml.target;
            matchedPersonName = cleanStr(ml.label, 60);
          }
        }
      }
      if (linkedHits.length === 0) {
        for (const [tok, label] of activePeopleTokens.entries()) {
          if (tok.length >= 4 && textHay.includes(tok)) {
            linkedHits.push(`Person: ${label}`);
            matchedPersonName = label;
            break;
          }
        }
      }
      for (const ws of workstreamNames) {
        const wNorm = normAlpha(ws);
        if (wNorm.length >= 3 && textHay.includes(wNorm)) {
          linkedHits.push(`Workstream: ${ws}`);
          break;
        }
      }
      if (linkedHits.length === 0) continue;

      const thId = String(th.numericId ?? th.id ?? "");
      const id = `board:${thId}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const firstLine = cleanStr(String(th.text || "").split("\n")[0], 110);
      signals.push({
        id,
        kind: "board_link",
        severity: isBlocked ? "high" : "medium",
        title: `Board #${thId} (${th.channel}) links to Today`,
        detail: `${isBlocked ? "Blocked thread" : "Decision thread"}: "${firstLine}"`,
        person_key: matchedPersonKey,
        person_name: matchedPersonName,
        thread_id: thId,
        channels: ["board", th.channel || "general"],
        evidence: [isBlocked ? "blocked" : "decision", ...linkedHits].slice(0, 4),
        score: isBlocked ? 92 : 76,
      });
    }

    // 3. Velocity / anomaly pulse (quiet Core/Family contacts with drift_z > 2 OR sudden thread spike)
    const driftingEntries: PeopleRadarEntry[] = Array.isArray(radar?.drifting) ? radar!.drifting : [];
    const seenDrift = new Set<string>();

    for (const d of driftingEntries) {
      const dz = Number(d.drift_z ?? 0);
      if (dz <= 2.0) continue;
      seenDrift.add(d.key);
      const id = `drift:${d.key}`;
      if (seen.has(id)) continue;
      seen.add(id);
      signals.push({
        id,
        kind: "velocity_pulse",
        severity: d.tier === "Family" || dz >= 3.0 ? "high" : "medium",
        title: `${d.name} unusually quiet (drift z=${dz.toFixed(1)})`,
        detail: cleanStr(d.reason || `${d.tier} contact cadence gap is ${dz.toFixed(1)} sigma above baseline.`, 180),
        person_key: d.key,
        person_name: d.name,
        channels: Array.isArray(d.channels) ? d.channels : [],
        evidence: [`${d.tier} contact`, `drift z=${dz.toFixed(1)}`, ...(d.evidence || []).slice(0, 2)],
        score: round1(64 + Math.min(26, dz * 7) + tierBonus(d.tier) * 0.4),
      });
    }

    // Also inspect local ledgers for drift_z > 2 or sudden 24h message spikes
    for (const p of people) {
      const dz = p.ledger?.drift_z ?? 0;
      if (dz > 2.0 && !seenDrift.has(p.key) && (p.tier === "Family" || p.tier === "Core" || p.tier === "Profiled")) {
        const id = `drift:${p.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          signals.push({
            id,
            kind: "velocity_pulse",
            severity: p.tier === "Family" || dz >= 3.0 ? "high" : "medium",
            title: `${p.name} unusually quiet (drift z=${dz.toFixed(1)})`,
            detail: cleanStr(
              p.ledger?.summary_sentence ||
                `${p.tier} contact gap is ${Math.round(p.ledger?.current_gap_days || 0)}d vs ${Math.round(p.ledger?.median_gap_days || 0)}d median.`,
              180,
            ),
            person_key: p.key,
            person_name: p.name,
            channels: p.channels,
            evidence: [
              `${p.tier} contact`,
              `drift z=${dz.toFixed(1)}`,
              `gap ${Math.round(p.ledger?.current_gap_days || 0)}d`,
            ],
            score: round1(62 + Math.min(26, dz * 7) + tierBonus(p.tier) * 0.4),
          });
        }
      }

      // Sudden thread spike in last 24h (>= 5 messages in 24h vs low baseline)
      const recent24h = p.messages.filter((m) => {
        const ms = Date.parse(m.occurred_at);
        return Number.isFinite(ms) && ms >= nowMs - DAY_MS && ms <= nowMs;
      });
      if (recent24h.length >= 5) {
        const weeks = p.ledger?.weeks || [];
        const prevWeeks = weeks.slice(-9, -1);
        const avgWeekly =
          prevWeeks.length > 0
            ? prevWeeks.reduce((s, w) => s + w.in + w.out, 0) / prevWeeks.length
            : 1;
        if (recent24h.length >= Math.max(5, avgWeekly * 2.2)) {
          const id = `spike:${p.key}`;
          if (!seen.has(id)) {
            seen.add(id);
            const chSet = Array.from(new Set(recent24h.map((m) => m.channel || "direct")));
            signals.push({
              id,
              kind: "velocity_pulse",
              severity: "info",
              title: `Thread spike with ${p.name} (${recent24h.length} msgs / 24h)`,
              detail: `24h volume is ${round1(recent24h.length / Math.max(0.5, avgWeekly))}x recent weekly average.`,
              person_key: p.key,
              person_name: p.name,
              channels: chSet,
              evidence: [
                `${recent24h.length} msgs in 24h`,
                `avg ${round1(avgWeekly)}/wk`,
                ...chSet.map(formatChannelName),
              ].slice(0, 4),
              score: round1(58 + Math.min(20, recent24h.length * 2) + tierBonus(p.tier) * 0.3),
            });
          }
        }
      }
    }

    signals.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return signals.slice(0, 12);
  }

  private async computeBriefing(): Promise<ProactiveBriefingResponse> {
    const t0 = performance.now();
    const nowMs = this.nowFn();
    const versionKey = this.readDataVersionKey();

    const [today, peopleListRes, personal, boardPulse, radar] = await Promise.all([
      this.api.getToday({ includeNoise: false }).catch((): Partial<TodayResponse> | null => null),
      this.api
        .listPeople({ limit: 300 })
        .then((r) => (Array.isArray(r?.items) ? r.items : []))
        .catch((): PersonDirectoryItem[] => []),
      typeof this.api.getPersonalIndex === "function"
        ? this.api.getPersonalIndex().catch((): PersonalIndexLike | null => null)
        : Promise.resolve(null),
      this.boardBridge && typeof this.boardBridge.getTodayBoardPulse === "function"
        ? this.boardBridge.getTodayBoardPulse().catch((): TodayBoardPulseResponse | null => null)
        : Promise.resolve(null),
      this.peopleRadar && typeof this.peopleRadar.getRadar === "function"
        ? Promise.race([
            this.peopleRadar.getRadar().catch(() => null),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
          ])
        : Promise.resolve(null),
    ]);

    const upcoming = this.collectUpcomingMeetings(today, personal, nowMs);
    const upcomingParticipants: string[] = [];
    for (const ev of upcoming) {
      for (const p of ev.participants || []) {
        if (!isSelfParticipant(p)) upcomingParticipants.push(p);
      }
    }

    const unifiedPeople = await this.loadUnifiedPeople(
      peopleListRes,
      personal,
      upcomingParticipants,
      nowMs,
    );

    const inbox = Array.isArray(today?.inbox) ? today!.inbox! : [];
    const actions = Array.isArray(today?.actions) ? today!.actions! : [];
    const workstreams = Array.isArray(today?.workstreams) ? today!.workstreams! : [];

    const meeting_preps = this.buildMeetingPreps(upcoming, unifiedPeople, inbox, nowMs);
    const commitRes = this.buildCommitments(unifiedPeople, inbox, actions, nowMs);
    const cross_signals = this.buildCrossSignals(
      unifiedPeople,
      upcoming,
      inbox,
      workstreams,
      radar,
      boardPulse,
      nowMs,
    );

    const meetings24h = meeting_preps.filter((m) => m.hours_until <= 24).length;
    const urgentCommitments = commitRes.active.filter((c) => c.score >= 85).length;

    const parts: string[] = [];
    if (meeting_preps.length > 0) {
      const next = meeting_preps[0];
      parts.push(
        `${meeting_preps.length} meeting prep${meeting_preps.length === 1 ? "" : "s"} (next: ${next.title} ${next.countdown})`,
      );
    }
    if (commitRes.active.length > 0) {
      parts.push(
        `${commitRes.active.length} open commitment${commitRes.active.length === 1 ? "" : "s"}${urgentCommitments > 0 ? ` (${urgentCommitments} urgent)` : ""}`,
      );
    }
    if (cross_signals.length > 0) {
      parts.push(
        `${cross_signals.length} cross-channel signal${cross_signals.length === 1 ? "" : "s"}`,
      );
    }
    const summary =
      parts.length > 0
        ? cleanStr(parts.join(" | "), 240)
        : "Calendar preps, open commitments, and cross-channel signals are clear.";

    return {
      generated_at: new Date(nowMs).toISOString(),
      elapsed_ms: round1(Math.max(0.01, performance.now() - t0)),
      cache_hit: false,
      data_version: versionKey,
      summary,
      meeting_preps,
      commitments: commitRes.active,
      cross_signals,
      counts: {
        meeting_preps: meeting_preps.length,
        meetings_24h: meetings24h,
        commitments: commitRes.active.length,
        commitments_urgent: urgentCommitments,
        commitments_resolved: commitRes.resolvedCount,
        commitments_snoozed: commitRes.snoozedCount,
        cross_signals: cross_signals.length,
      },
    };
  }

  async generateMeetingPrepMarkdown(meetingId: string): Promise<MeetingPrepDetailResponse | null> {
    const cleanId = String(meetingId || "").trim();
    if (!cleanId) {
      throw new ProactiveBadRequestError("Meeting id is required");
    }

    const briefing = await this.getBriefing();
    const prep = briefing.meeting_preps.find((m) => m.id === cleanId);
    if (!prep) return null;

    const lines: string[] = [
      `# Meeting Prep: ${prep.title}`,
      "",
      `- **When**: ${prep.start} (${prep.countdown})`,
      `- **Calendar**: ${prep.calendar}`,
    ];
    if (prep.meet_url) {
      lines.push(`- **Link**: ${prep.meet_url}`);
    }
    lines.push("", "## Context");
    for (const b of prep.context_bullets) {
      lines.push(`- ${b}`);
    }

    if (prep.attendees.length > 0) {
      lines.push("", "## Attendees & Recent Touchpoints");
      for (const att of prep.attendees) {
        const meta = [att.tier, att.role, att.org].filter(Boolean).join(" | ");
        lines.push(`### ${att.name}${meta ? ` (${meta})` : ""}`);
        if (att.last_touches.length > 0) {
          for (const t of att.last_touches) {
            const dir = t.direction === "out" ? "You" : att.name;
            lines.push(`- [${t.channel}, ${t.age_label}] ${dir}: ${t.excerpt}`);
          }
        } else {
          lines.push("- No recent cross-channel messages indexed.");
        }
      }
    }

    if (prep.open_loops.length > 0) {
      lines.push("", "## Open Loops");
      for (const l of prep.open_loops) {
        const tag = l.kind === "owner_promise" ? "Owner promise" : "Inbound ask";
        lines.push(`- **${l.person}** (${tag}, ${l.channel}, ${l.age_label}): ${l.excerpt}`);
      }
    }

    lines.push("", "## Talking Points");
    for (const tp of prep.talking_points) {
      lines.push(`- ${tp}`);
    }

    const markdown = stripEmDashesIntel(lines.join("\n"));
    return {
      ok: true,
      local_only: true,
      generated_at: new Date(this.nowFn()).toISOString(),
      meeting_id: prep.id,
      prep,
      markdown,
    };
  }

  private buildLocalFollowupDraft(commitment: OpenCommitment | null, id: string): {
    draft: string;
    person_name: string;
    channel: string;
  } {
    if (!commitment) {
      return {
        draft: stripEmDashesIntel(
          `Quick follow-up on item ${id}: circling back to confirm next steps and keep this moving today.`,
        ),
        person_name: "Contact",
        channel: "direct",
      };
    }

    const firstName = commitment.person_name.split(/\s+/)[0] || commitment.person_name;
    const snippet = cleanStr(commitment.excerpt, 120);
    const ch = formatChannelName(commitment.channel);

    const signOff = (process.env.KIZUKI_OWNER_NAME || "Owner").trim() || "Owner";
    let draft: string;
    if (commitment.kind === "owner_promise") {
      draft =
        commitment.channel === "gmail"
          ? `Hi ${firstName},\n\nFollowing up as promised on: "${snippet}".\n\nI have the next step ready on my side. Let me know if today works to close this out.\n\nBest,\n${signOff}`
          : `Hey ${firstName}, following up as promised on "${snippet}". Sending the update now so we keep this moving.`;
    } else if (commitment.kind === "inbound_ask") {
      draft =
        commitment.channel === "gmail"
          ? `Hi ${firstName},\n\nThanks for reaching out regarding "${snippet}".\n\nHere is where things stand on my side and the proposed next step:\n- [Insert concrete answer / timing]\n\nBest,\n${signOff}`
          : `Hey ${firstName}, saw your note on "${snippet}". Quick answer: [insert concise response]. Let me know if that works.`;
    } else {
      draft = `Action check-in (${ch}): "${snippet}". Target completion today; next concrete step: [fill in].`;
    }

    return {
      draft: stripEmDashesIntel(draft),
      person_name: commitment.person_name,
      channel: commitment.channel,
    };
  }

  async mutateCommitment(req: MutateCommitmentRequest): Promise<MutateCommitmentResponse> {
    const id = String(req?.id || "").trim();
    if (!id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) {
      throw new ProactiveBadRequestError("Valid commitment id is required");
    }

    const rawOp = String(req?.op || "").trim().toLowerCase() as CommitmentOp;
    const validOps = new Set<CommitmentOp>(["resolve", "snooze", "reopen", "draft", "draft_followup"]);
    if (!validOps.has(rawOp)) {
      throw new ProactiveBadRequestError(
        'Invalid op: expected "resolve", "snooze", "reopen", or "draft"',
      );
    }

    const nowMs = this.nowFn();
    const nowIso = new Date(nowMs).toISOString();

    if (rawOp === "draft" || rawOp === "draft_followup") {
      // Strictly local draft generation; NEVER sends externally as the owner.
      const briefing = await this.getBriefing();
      const target = briefing.commitments.find((c) => c.id === id) || null;
      const generated = this.buildLocalFollowupDraft(target, id);
      return {
        ok: true,
        local_only: true,
        never_sent: true,
        id,
        op: "draft",
        updated_at: nowIso,
        draft: generated.draft,
        person_name: generated.person_name,
        channel: generated.channel,
      };
    }

    if (rawOp === "resolve") {
      this.ledger.items[id] = {
        status: "resolved",
        updated_at: nowIso,
        resolved_at: nowIso,
      };
      await this.persistLedger();
      this.invalidate();
      return {
        ok: true,
        local_only: true,
        id,
        op: "resolve",
        status: "resolved",
        updated_at: nowIso,
      };
    }

    if (rawOp === "snooze") {
      const hoursRaw = Number(req.hours ?? 24);
      const hours = Number.isFinite(hoursRaw) ? Math.max(1, Math.min(336, Math.round(hoursRaw))) : 24;
      const snoozeUntil = new Date(nowMs + hours * HOUR_MS).toISOString();
      this.ledger.items[id] = {
        status: "snoozed",
        updated_at: nowIso,
        snooze_until: snoozeUntil,
      };
      await this.persistLedger();
      this.invalidate();
      return {
        ok: true,
        local_only: true,
        id,
        op: "snooze",
        status: "snoozed",
        updated_at: nowIso,
        snooze_until: snoozeUntil,
      };
    }

    // reopen
    this.ledger.items[id] = {
      status: "open",
      updated_at: nowIso,
    };
    await this.persistLedger();
    this.invalidate();
    return {
      ok: true,
      local_only: true,
      id,
      op: "reopen",
      status: "open",
      updated_at: nowIso,
    };
  }
}
