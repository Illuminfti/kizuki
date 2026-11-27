import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OmniIndexSearch } from "./contracts.ts";
import {
  KizukiAgentBoardApi,
  stripEmDashes,
} from "./agent-board-api.ts";
import {
  KizukiBoardMindBridge,
  type BoardOmniHit,
} from "./board-mind-bridge.ts";
import {
  KizukiCodexApi,
  type CodexOmniHit,
} from "./codex-api.ts";
import { loadCanonicalPersonCards } from "./people-intel.ts";
import { KizukiTasteApi } from "./taste-api.ts";
import type {
  KizukiVaultApi,
  OmniSearchResponse,
  PersonDirectoryItem,
} from "./vault-api.ts";

export interface OmniTasteHit {
  id: string;
  domain: string;
  polarity: "prefer" | "avoid" | "neutral";
  rule: string;
  reason: string;
  kind: "rule" | "vault_doc";
}

export interface OmniIndexResponse extends OmniSearchResponse {
  codex: CodexOmniHit[];
  board: BoardOmniHit[];
  taste?: OmniTasteHit[];
  groups: OmniSearchResponse["groups"] & {
    codex: CodexOmniHit[];
    board: BoardOmniHit[];
    taste?: OmniTasteHit[];
  };
}

export interface OmniIndexConfig {
  api: KizukiVaultApi;
  codexApi: KizukiCodexApi;
  tasteApi: KizukiTasteApi;
  agentBoardApi: KizukiAgentBoardApi;
  boardBridge: KizukiBoardMindBridge;
  refreshIntervalMs?: number;
  idleStopMs?: number;
}

type CorpusKind =
  | "calendar"
  | "inbox"
  | "docs"
  | "people"
  | "memt"
  | "nodes"
  | "codex"
  | "board"
  | "taste";

interface IndexedEntry {
  docId: number;
  corpus: CorpusKind;
  dedupeKey: string;
  titleLower: string;
  aliasesLower: string[];
  searchText: string;
  basePriority: number;
  sortKey: number;
  payload: unknown;
}

interface InvertedCorpusIndex {
  docs: IndexedEntry[];
  vocab: string[];
  postings: Map<string, Uint32Array>;
}

interface OmniSnapshot {
  builtAt: number;
  boardDataVersion: number;
  index: InvertedCorpusIndex;
  byCorpus: Record<CorpusKind, IndexedEntry[]>;
}

const DEFAULT_REFRESH_INTERVAL_MS = 45_000;
const DEFAULT_IDLE_STOP_MS = 60_000;
const MAX_PREFIX_EXPANSIONS = 160;

function cleanText(raw: unknown, maxLen = 220): string {
  const s = stripEmDashes(String(raw ?? ""))
    .replace(/\r\n?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  const slice = s.slice(0, Math.max(1, maxLen - 3));
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(maxLen * 0.55) ? slice.slice(0, lastSpace) : slice;
  return `${cut.replace(/[,;:.\-/\s]+$/, "")}...`;
}

function tokenizeForIndex(text: string): string[] {
  const lower = stripEmDashes(String(text ?? "")).toLowerCase();
  const out = new Set<string>();
  let start = -1;
  for (let i = 0; i <= lower.length; i += 1) {
    const ch = i < lower.length ? lower.charCodeAt(i) : 32;
    const isAlnum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57);
    if (isAlnum) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      const len = i - start;
      if (len >= 2) {
        const tok = lower.slice(start, Math.min(i, start + 36));
        out.add(tok);
      }
      start = -1;
    }
  }
  return Array.from(out);
}

function lowerBound(arr: string[], target: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

function buildInvertedIndex(docs: IndexedEntry[]): InvertedCorpusIndex {
  const rawPostings = new Map<string, number[]>();
  for (let i = 0; i < docs.length; i += 1) {
    const doc = docs[i];
    doc.docId = i;
    const tokens = tokenizeForIndex(doc.searchText);
    for (let j = 0; j < tokens.length; j += 1) {
      const tok = tokens[j];
      let list = rawPostings.get(tok);
      if (!list) {
        list = [];
        rawPostings.set(tok, list);
      }
      list.push(i);
    }
  }

  const vocab = Array.from(rawPostings.keys()).sort();
  const postings = new Map<string, Uint32Array>();
  for (let i = 0; i < vocab.length; i += 1) {
    const key = vocab[i];
    const ids = rawPostings.get(key)!;
    postings.set(key, Uint32Array.from(ids));
  }
  return { docs, vocab, postings };
}

function isLikelyHexHash(s: string): boolean {
  const trimmed = String(s || "").trim();
  return /^[0-9a-f]{16,}$/i.test(trimmed);
}

function normalizeNodeKind(raw: unknown, fallback = "concept"): string {
  const s = String(raw || "").trim().toLowerCase();
  if (!s) return fallback;
  return s.replace(/^world\./, "");
}

function parseTimestampMs(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

async function readJsonlTail(filePath: string, maxLines = 2500): Promise<Record<string, unknown>[]> {
  if (!existsSync(filePath)) return [];
  try {
    const raw = await readFile(filePath, "utf8");
    if (!raw) return [];
    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, lines.length - maxLines);
    const out: Record<string, unknown>[] = [];
    for (let i = startIdx; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>);
        }
      } catch {
        // skip malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

export class OmniIndex implements OmniIndexSearch {
  private readonly api: KizukiVaultApi;
  private readonly codexApi: KizukiCodexApi;
  private readonly tasteApi: KizukiTasteApi;
  private readonly agentBoardApi: KizukiAgentBoardApi;
  private readonly boardBridge: KizukiBoardMindBridge;
  private readonly refreshIntervalMs: number;
  private readonly idleStopMs: number;

  private snapshot: OmniSnapshot | null = null;
  private buildInFlight: Promise<OmniSnapshot> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastQueryAt = 0;
  private closed = false;

  constructor(cfg: OmniIndexConfig) {
    this.api = cfg.api;
    this.codexApi = cfg.codexApi;
    this.tasteApi = cfg.tasteApi;
    this.agentBoardApi = cfg.agentBoardApi;
    this.boardBridge = cfg.boardBridge;
    this.refreshIntervalMs = Math.max(
      2_000,
      cfg.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    );
    this.idleStopMs = Math.max(
      this.refreshIntervalMs,
      cfg.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
    );
  }

  isReady(): boolean {
    return this.snapshot !== null;
  }

  getStats(): {
    ready: boolean;
    builtAt: number;
    totalDocs: number;
    vocabSize: number;
    boardDataVersion: number;
    counts: Record<CorpusKind, number>;
  } {
    const emptyCounts: Record<CorpusKind, number> = {
      calendar: 0,
      inbox: 0,
      docs: 0,
      people: 0,
      memt: 0,
      nodes: 0,
      codex: 0,
      board: 0,
      taste: 0,
    };
    if (!this.snapshot) {
      return {
        ready: false,
        builtAt: 0,
        totalDocs: 0,
        vocabSize: 0,
        boardDataVersion: 0,
        counts: emptyCounts,
      };
    }
    for (const k of Object.keys(emptyCounts) as CorpusKind[]) {
      emptyCounts[k] = this.snapshot.byCorpus[k].length;
    }
    return {
      ready: true,
      builtAt: this.snapshot.builtAt,
      totalDocs: this.snapshot.index.docs.length,
      vocabSize: this.snapshot.index.vocab.length,
      boardDataVersion: this.snapshot.boardDataVersion,
      counts: emptyCounts,
    };
  }

  warmInBackground(): void {
    if (this.closed || this.buildInFlight) return;
    void this.rebuild().catch(() => {
      // fail-soft background build
    });
  }

  private ensurePeriodicRefresh(): void {
    if (this.closed || this.refreshTimer !== null) return;
    const timer = setInterval(() => {
      if (this.closed) {
        this.stopPeriodicRefresh();
        return;
      }
      if (Date.now() - this.lastQueryAt >= this.idleStopMs) {
        this.stopPeriodicRefresh();
        return;
      }
      if (!this.buildInFlight) {
        void this.rebuild().catch(() => {
          // ignore background refresh errors
        });
      }
    }, this.refreshIntervalMs);
    if (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
      (timer as unknown as { unref: () => void }).unref();
    }
    this.refreshTimer = timer;
  }

  private stopPeriodicRefresh(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  close(): void {
    this.closed = true;
    this.stopPeriodicRefresh();
    this.snapshot = null;
    this.buildInFlight = null;
  }

  private readBoardDataVersion(): number {
    try {
      return this.agentBoardApi.getDataVersion();
    } catch {
      return 0;
    }
  }

  private buildBoardEntries(): { dataVersion: number; entries: IndexedEntry[] } {
    const entries: IndexedEntry[] = [];
    let dataVersion = 0;
    try {
      const db = this.agentBoardApi.getDb();
      dataVersion = this.readBoardDataVersion();
      const rootRows = db
        .query(
          `SELECT id, event_id, channel, re, by_actor, by_principal, by_profile,
                  from_key, no_sync, text_lower, deleted, created_at, replies, at, data
           FROM board_messages
           WHERE deleted = 0 AND re IS NULL
           ORDER BY CASE WHEN at >= 1000000000000 THEN at ELSE created_at END DESC, id DESC
           LIMIT 1200`,
        )
        .all() as Array<{
        id: number;
        event_id: string;
        channel: string;
        re: number | null;
        by_actor: string;
        by_principal: string;
        by_profile: string | null;
        created_at: number;
        replies: number;
        at: number | null;
        text_lower: string;
        data: string;
      }>;

      // Batch fetch latest reply snippets per root to preserve reply-match recall
      const replySnippets = new Map<number, string[]>();
      if (rootRows.length > 0) {
        const replyRows = db
          .query(
            `SELECT re, text_lower
             FROM board_messages
             WHERE deleted = 0 AND re IS NOT NULL
             ORDER BY id DESC
             LIMIT 2500`,
          )
          .all() as Array<{ re: number; text_lower: string }>;
        for (const rr of replyRows) {
          let list = replySnippets.get(rr.re);
          if (!list) {
            list = [];
            replySnippets.set(rr.re, list);
          }
          if (list.length < 4) {
            list.push(String(rr.text_lower || "").slice(0, 220));
          }
        }
      }

      for (const row of rootRows) {
        let parsed: Record<string, unknown> = {};
        try {
          const obj = JSON.parse(row.data);
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            parsed = obj as Record<string, unknown>;
          }
        } catch {
          parsed = {};
        }

        const rawText = typeof parsed.text === "string" ? parsed.text : row.text_lower;
        const cleanBody = stripEmDashes(rawText)
          .replace(
            /@\[(?:local|tailscale):user:[^+\]]+(?:\+([^\]]+))?\]/g,
            (_m, slug?: string) => (slug ? `@${slug}` : "@owner"),
          );
        const firstLine =
          cleanBody
            .split(/\r?\n/)
            .map((l) => l.trim())
            .find(Boolean) || "";
        const title = cleanText(firstLine || `Thread #${row.id}`, 140);
        const snippet = cleanText(cleanBody, 160);
        const labels =
          parsed.labels && typeof parsed.labels === "object" && !Array.isArray(parsed.labels)
            ? (parsed.labels as Record<string, string>)
            : {};
        const taskObj =
          parsed.task && typeof parsed.task === "object" && !Array.isArray(parsed.task)
            ? (parsed.task as Record<string, unknown>)
            : null;
        const taskState =
          typeof taskObj?.state === "string"
            ? taskObj.state
            : typeof labels["board.task"] === "string"
              ? labels["board.task"]
              : null;
        const isFinished =
          taskState !== null &&
          ["completed", "failed", "canceled", "cancelled"].includes(taskState);
        const isPaused = !isFinished && Boolean(labels.pause);
        const isBlocked =
          !isFinished &&
          (taskState === "blocked" || isPaused || Boolean(labels.escalation));

        const signal = this.boardBridge.classifySignal({
          text: cleanBody,
          channel: row.channel,
          labels,
          replies: Number(row.replies) || 0,
          isBlocked,
          isPaused,
          taskState,
        });

        const byProfile =
          row.by_profile ||
          (row.by_actor.includes("+") ? row.by_actor.split("+").slice(1).join("+") : row.by_actor);
        const rawAt = row.at != null ? Number(row.at) : NaN;
        const createdAtMs = Number(row.created_at) || 0;
        const lastAtMs = Number.isFinite(rawAt) && rawAt >= 1e12 ? rawAt : createdAtMs;
        const lastAt = lastAtMs > 0 ? new Date(lastAtMs).toISOString() : new Date(0).toISOString();

        const brand = byProfile.toLowerCase().includes("claude")
          ? "claude"
          : byProfile.toLowerCase().includes("codex")
            ? "codex"
            : byProfile.toLowerCase().includes("design") ||
                byProfile.toLowerCase().includes("dreamer") ||
                byProfile.toLowerCase().includes("neon")
              ? "designer"
              : byProfile.toLowerCase().includes("orchestrator") ||
                  byProfile.toLowerCase().includes("brain") ||
                  byProfile.toLowerCase().includes("board-keeper")
                ? "brain"
                : "worker";

        const hit: BoardOmniHit = {
          id: String(row.id),
          numericId: row.id,
          channel: row.channel,
          title,
          snippet,
          by: byProfile,
          brand,
          signalKind: signal.signalKind,
          weight: signal.weight,
          replies: Number(row.replies) || 0,
          isBlocked,
          lastAt,
          view: "board",
          target: String(row.id),
        };

        const repText = (replySnippets.get(row.id) || []).join(" ");
        const searchText = `${row.id} ${row.channel} ${title} ${cleanBody.slice(0, 600)} ${byProfile} ${repText}`.toLowerCase();

        entries.push({
          docId: 0,
          corpus: "board",
          dedupeKey: String(row.id),
          titleLower: title.toLowerCase(),
          aliasesLower: [String(row.id), row.channel.toLowerCase(), byProfile.toLowerCase()],
          searchText,
          basePriority:
            signal.weight + (isBlocked ? 35 : 0) + Math.min(24, (Number(row.replies) || 0) * 6),
          sortKey: lastAtMs,
          payload: hit,
        });
      }
    } catch {
      // fail-soft if board DB is unavailable
    }
    return { dataVersion, entries };
  }

  private async loadCalendarEntries(): Promise<IndexedEntry[]> {
    const entries: IndexedEntry[] = [];
    const seen = new Set<string>();

    const pushEvent = (ev: {
      id: string;
      title: string;
      calendar: string;
      start: string;
      end: string | null;
      participants: string[];
      preview: string;
      rawSearch?: string;
    }) => {
      if (!ev.id || seen.has(ev.id)) return;
      seen.add(ev.id);
      const startMs = parseTimestampMs(ev.start);
      const titleClean = cleanText(ev.title, 140);
      const payload = {
        id: ev.id,
        title: titleClean,
        calendar: cleanText(ev.calendar || "Calendar", 64),
        start: ev.start,
        end: ev.end,
        participants: ev.participants.slice(0, 12),
        preview: cleanText(ev.preview, 180),
      };
      entries.push({
        docId: 0,
        corpus: "calendar",
        dedupeKey: ev.id,
        titleLower: titleClean.toLowerCase(),
        aliasesLower: ev.participants.map((p) => p.toLowerCase()),
        searchText: `${titleClean} ${payload.calendar} ${payload.participants.join(" ")} ${ev.rawSearch || payload.preview}`.toLowerCase(),
        basePriority: 50,
        sortKey: startMs,
        payload,
      });
    };

    // 1. Read calendar bridge JSONL directly if available (covers full history, not just today)
    const bridgesDir = this.api.bridgesDir;
    const calPaths = [
      join(bridgesDir, "mac-calendar", "events.jsonl"),
      join(bridgesDir, "calendar", "events.jsonl"),
    ];
    for (const calPath of calPaths) {
      const rows = await readJsonlTail(calPath, 1000);
      for (let i = 0; i < rows.length; i += 1) {
        const obj = rows[i];
        const rawText = stripEmDashes(String(obj.text || obj.description || obj.summary || ""));
        const title = String(obj.title || obj.summary || "").trim() ||
          (rawText.split(/\r?\n/)[0] || "Calendar Event").replace(/^\[Calendar[^\]]*\]:?\s*/i, "");
        const start = String(obj.start || obj.start_time || obj.occurred_at || obj.timestamp || "");
        const end = obj.end || obj.end_time ? String(obj.end || obj.end_time) : null;
        const calendar = String(obj.calendar || obj.calendar_name || obj.channel || "Calendar").replace(/^calendar:/i, "");
        const participants = Array.isArray(obj.participants)
          ? obj.participants.map(String)
          : Array.isArray(obj.attendees)
            ? obj.attendees.map(String)
            : [];
        const id = String(obj.id || `cal:${i}:${title.slice(0, 24)}`);
        pushEvent({
          id,
          title,
          calendar,
          start,
          end,
          participants,
          preview: rawText || title,
          rawSearch: rawText,
        });
      }
    }

    // 2. Also include upcoming schedule from api.getToday() if available
    try {
      const today = await this.api.getToday({ includeNoise: true });
      for (const s of today.schedule || []) {
        pushEvent({
          id: s.id,
          title: s.title,
          calendar: s.calendar,
          start: s.start,
          end: s.end,
          participants: Array.isArray(s.participants) ? s.participants : [],
          preview: `${s.title} ${s.calendar} ${(s.participants || []).join(" ")}`,
        });
      }
    } catch {
      // fail-soft
    }

    return entries;
  }

  private async loadInboxEntries(): Promise<IndexedEntry[]> {
    const entries: IndexedEntry[] = [];
    const seen = new Set<string>();

    const pushInbox = (m: {
      id: string;
      channel: "whatsapp" | "telegram" | "imessage" | "gmail";
      channel_label: string;
      thread_key: string;
      sender: string;
      thread_title: string;
      preview: string;
      occurred_at: string;
      is_noise: boolean;
      extraSearch?: string;
    }) => {
      if (!m.id || seen.has(m.id)) return;
      seen.add(m.id);
      const ts = parseTimestampMs(m.occurred_at);
      const payload = {
        id: m.id,
        channel: m.channel,
        channel_label: m.channel_label,
        thread_key: m.thread_key,
        sender: cleanText(m.sender, 72),
        thread_title: cleanText(m.thread_title, 120),
        preview: cleanText(m.preview, 180),
        occurred_at: m.occurred_at,
        is_noise: Boolean(m.is_noise),
      };
      entries.push({
        docId: 0,
        corpus: "inbox",
        dedupeKey: m.id,
        titleLower: payload.thread_title.toLowerCase(),
        aliasesLower: [payload.sender.toLowerCase()],
        searchText: `${payload.thread_title} ${payload.sender} ${payload.preview} ${m.extraSearch || ""}`.toLowerCase(),
        basePriority: payload.is_noise ? 20 : 80,
        sortKey: ts,
        payload,
      });
    };

    // 1. Today's curated priority + all inbox threads
    try {
      const today = await this.api.getToday({ includeNoise: true });
      for (const item of today.inbox || []) {
        pushInbox({
          id: item.id,
          channel: item.channel,
          channel_label: item.channel_label,
          thread_key: item.thread_key,
          sender: item.sender,
          thread_title: item.thread_title,
          preview: item.preview,
          occurred_at: item.occurred_at,
          is_noise: item.is_noise,
        });
      }
    } catch {
      // fail-soft
    }

    // 2. Recent deduplicated thread heads from bridge JSONLs (keeps RAM tiny while covering inbox search)
    const bridgesDir = this.api.bridgesDir;
    const bridgeSpecs: Array<{
      channel: "whatsapp" | "telegram" | "imessage" | "gmail";
      label: string;
      relPath: string;
    }> = [
      { channel: "whatsapp", label: "WhatsApp", relPath: join("whatsapp", "events.jsonl") },
      { channel: "telegram", label: "Telegram", relPath: join("telegram", "events.jsonl") },
      { channel: "imessage", label: "iMessage", relPath: join("mac-imessage", "events.jsonl") },
      { channel: "gmail", label: "Gmail", relPath: join("gmail", "events.jsonl") },
    ];

    for (const spec of bridgeSpecs) {
      const rows = await readJsonlTail(join(bridgesDir, spec.relPath), 1200);
      const seenThreads = new Set<string>();
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const obj = rows[i];
        const rawText = stripEmDashes(String(obj.text || ""));
        const occurredAt = String(obj.occurred_at || obj.timestamp || "");
        let threadTitle = "";
        let sender = "";
        let threadKey = "";
        let preview = rawText;

        if (spec.channel === "whatsapp" || spec.channel === "telegram") {
          const tag = spec.channel === "whatsapp" ? "WhatsApp" : "Telegram";
          const m = rawText.match(new RegExp(`^\\[${tag}\\s*\\|\\s*([^|\\]]+?)\\s*\\|\\s*([^\\]]+?)\\]:\\s*([\\s\\S]*)$`));
          threadTitle = cleanText(m?.[1] || String(obj.channel || tag).replace(/^(?:whatsapp|telegram):/i, ""), 72);
          sender = cleanText(m?.[2] || threadTitle, 64);
          preview = cleanText((m?.[3] ?? rawText).trim(), 180);
          threadKey = String(obj.channel || `${spec.channel}:${threadTitle.toLowerCase()}`).toLowerCase();
        } else if (spec.channel === "imessage") {
          const chat = cleanText(String(obj.chat || obj.sender || "iMessage"), 64);
          threadTitle = chat;
          sender = String(obj.direction || "").toLowerCase() === "outbound" ? "You" : cleanText(String(obj.sender || chat), 64);
          threadKey = `imessage:${chat.toLowerCase()}`;
          preview = cleanText(rawText.replace(/^\[iMessage[^\n]*\n?/, ""), 180);
        } else {
          const subject = cleanText(String(obj.subject_line || obj.subject || "(No subject)"), 110);
          const fromRaw = String(obj.from_addr || "");
          threadTitle = subject;
          sender = cleanText(fromRaw.replace(/<[^>]+>/g, "").trim() || fromRaw || "Gmail", 64);
          threadKey = `gmail:${sender.toLowerCase()}:${subject.toLowerCase().slice(0, 48)}`;
          preview = cleanText(rawText, 180);
        }

        if (seenThreads.has(threadKey)) continue;
        seenThreads.add(threadKey);

        pushInbox({
          id: String(obj.id || `${spec.channel}:${i}`),
          channel: spec.channel,
          channel_label: spec.label,
          thread_key: threadKey,
          sender,
          thread_title: threadTitle,
          preview,
          occurred_at: occurredAt,
          is_noise: false,
          extraSearch: rawText.slice(0, 320),
        });
      }
    }

    return entries;
  }

  private loadWorldNodeEntries(): IndexedEntry[] {
    const entries: IndexedEntry[] = [];
    const seen = new Set<string>();
    try {
      const db = this.api.getDb();

      // 1. Consolidated world nodes (single bounded scan off the request path)
      try {
        const worldRows = db
          .query(
            `SELECT wc.handle_id,
                    wc.kind,
                    wc.summary,
                    wc.status,
                    COALESCE(wc.completed_at, wc.created_at) AS updated_at,
                    MAX(CASE WHEN s.predicate IN ('concept.label','situation.label','identity.display_name','artifact.label')
                             THEN json_extract(s.payload, '$.object.value') END) AS sem_label
             FROM world_consolidation wc
             LEFT JOIN world_consolidation_basis wcb ON wcb.basis_digest = wc.basis_digest
             LEFT JOIN claim_v2_semantics s ON s.claim_id = wcb.claim_id
             GROUP BY wc.basis_digest
             ORDER BY CASE WHEN wc.status = 'complete' THEN 0 ELSE 1 END, updated_at DESC
             LIMIT 10000`,
          )
          .all() as Array<{
          handle_id: string;
          kind: string;
          summary: string | null;
          status: string | null;
          updated_at: string | null;
          sem_label: string | null;
        }>;

        for (const r of worldRows) {
          if (!r.handle_id || seen.has(r.handle_id)) continue;
          seen.add(r.handle_id);
          const rawSummary = cleanText(r.summary || "", 260);
          const semLabel =
            r.sem_label && !isLikelyHexHash(r.sem_label) ? cleanText(r.sem_label, 72) : "";
          const label = semLabel || cleanText(rawSummary.split(/[.!?]/)[0] || r.handle_id, 72);
          const kind = normalizeNodeKind(r.kind, "concept");
          const payload = {
            id: r.handle_id,
            label,
            kind,
            summary: rawSummary,
            updated_at: r.updated_at || null,
          };
          entries.push({
            docId: 0,
            corpus: "nodes",
            dedupeKey: r.handle_id,
            titleLower: label.toLowerCase(),
            aliasesLower: [r.handle_id.toLowerCase(), kind],
            searchText: `${label} ${rawSummary} ${kind} ${r.handle_id}`.toLowerCase(),
            basePriority: r.status === "complete" ? 90 : 60,
            sortKey: parseTimestampMs(r.updated_at),
            payload,
          });
        }
      } catch {
        // table may not exist in lightweight fixture DBs
      }

      // 2. Semantic labeled subjects
      try {
        const semRows = db
          .query(
            `SELECT s.subject_id,
                    MAX(CASE WHEN s.predicate IN ('situation.label','concept.label','identity.display_name','artifact.label')
                             THEN json_extract(s.payload, '$.object.value') END) AS label,
                    MAX(CASE WHEN s.predicate = 'world.kind'
                             THEN json_extract(s.payload, '$.object.ref.id') END) AS world_kind,
                    MAX(CASE WHEN s.predicate IN ('concept.definition','situation.objective','situation.blocker','situation.commitment','situation.change','project.status')
                             THEN json_extract(s.payload, '$.object.value') END) AS detail_text,
                    SUBSTR(GROUP_CONCAT(DISTINCT COALESCE(json_extract(s.payload, '$.object.value'), json_extract(s.payload, '$.object.ref.id'), '')), 1, 800) AS all_vals,
                    MAX(json_extract(s.payload, '$.schema')) AS schema_name,
                    MAX(c.created_at) AS updated_at
             FROM claim_v2_semantics s
             JOIN claims c ON c.claim_id = s.claim_id AND c.status = 'live'
             WHERE s.subject_id IS NOT NULL
             GROUP BY s.subject_id
             HAVING label IS NOT NULL OR detail_text IS NOT NULL
             ORDER BY updated_at DESC
             LIMIT 15000`,
          )
          .all() as Array<{
          subject_id: string;
          label: string | null;
          world_kind: string | null;
          detail_text: string | null;
          all_vals: string | null;
          schema_name: string | null;
          updated_at: string | null;
        }>;

        let semIdx = 0;
        for (const r of semRows) {
          if (!r.subject_id || seen.has(r.subject_id)) continue;
          const label =
            (r.label && !isLikelyHexHash(r.label) ? cleanText(r.label, 72) : "") ||
            (r.detail_text ? cleanText(r.detail_text, 64) : "");
          if (!label) continue;
          seen.add(r.subject_id);
          semIdx += 1;
          const kind = normalizeNodeKind(r.world_kind, "situation");
          const summary = cleanText(r.detail_text || label, 260);
          const payload = {
            id: r.subject_id,
            label,
            kind,
            summary,
            updated_at: r.updated_at || null,
          };
          // Include schema token only on the newest 30 semantic subjects so generic schema queries
          // (like "kizuki") resolve in <1ms without exploding posting list size to 5,000+ entries.
          const schemaHint = semIdx <= 30 && r.schema_name ? r.schema_name : "";
          entries.push({
            docId: 0,
            corpus: "nodes",
            dedupeKey: r.subject_id,
            titleLower: label.toLowerCase(),
            aliasesLower: [r.subject_id.toLowerCase(), kind],
            searchText: `${label} ${summary} ${r.all_vals || ""} ${schemaHint} ${kind} ${r.subject_id}`.toLowerCase(),
            basePriority: 55,
            sortKey: parseTimestampMs(r.updated_at),
            payload,
          });
        }
      } catch {
        // table may not exist in lightweight fixture DBs
      }
    } catch {
      // fail-soft
    }
    return entries;
  }

  async rebuild(): Promise<OmniSnapshot> {
    if (this.buildInFlight) {
      return this.buildInFlight;
    }

    const task = (async (): Promise<OmniSnapshot> => {
      const [
        peopleRes,
        canonicalCardsRes,
        docsRes,
        memtAll,
        calendarEntries,
        inboxEntries,
        codexRes,
        tasteRes,
      ] = await Promise.all([
        this.api.listPeople({ limit: 300 }).catch(() => null),
        loadCanonicalPersonCards({
          vaultPath: this.api.vaultPath,
          lifeosPeopleDir: this.api.lifeosPeopleDir,
          relationshipsDir: this.api.relationshipsDir,
        }).catch(() => null),
        this.api.listDocs({ category: "all", limit: 1500, sort: "recent" }).catch(() => null),
        this.api.getMemtExperiences(150).catch(() => []),
        this.loadCalendarEntries(),
        this.loadInboxEntries(),
        Promise.resolve()
          .then(() => this.codexApi.getCodex({ includeArchived: false }))
          .catch(() => null),
        Promise.resolve()
          .then(() => this.tasteApi.getTasteState())
          .catch(() => null),
      ]);

      const byCorpus: Record<CorpusKind, IndexedEntry[]> = {
        calendar: calendarEntries,
        inbox: inboxEntries,
        docs: [],
        people: [],
        memt: [],
        nodes: this.loadWorldNodeEntries(),
        codex: [],
        board: [],
        taste: [],
      };

      // People & aliases
      const aliasesBySlug = new Map<string, string[]>();
      if (canonicalCardsRes?.cards) {
        for (const card of canonicalCardsRes.cards) {
          const aliases = [
            card.canonical_name,
            card.display_name,
            card.slug,
            ...(card.world_model.aliases || []),
            card.world_model.handles?.x || "",
            card.world_model.handles?.github || "",
            card.world_model.handles?.telegram || "",
            card.world_model.org || "",
            card.world_model.role || "",
          ]
            .map((s) => cleanText(s, 80).toLowerCase())
            .filter(Boolean);
          aliasesBySlug.set(card.slug.toLowerCase(), Array.from(new Set(aliases)));
        }
      }

      const seenPeople = new Set<string>();
      if (peopleRes?.items) {
        for (const p of peopleRes.items) {
          const slug = String(p.key || "").trim();
          if (!slug || seenPeople.has(slug.toLowerCase())) continue;
          seenPeople.add(slug.toLowerCase());
          const extraAliases = aliasesBySlug.get(slug.toLowerCase()) || [];
          const nameLower = cleanText(p.name || slug, 80).toLowerCase();
          const aliasesLower = Array.from(
            new Set([slug.toLowerCase(), ...extraAliases]),
          );
          const tierBoost =
            p.relationship_tier === "Family"
              ? 100
              : p.relationship_tier === "Core"
                ? 90
                : p.profile_tier === "v2" || p.profile_tier === "lifeos"
                  ? 75
                  : 50;
          byCorpus.people.push({
            docId: 0,
            corpus: "people",
            dedupeKey: slug.toLowerCase(),
            titleLower: nameLower,
            aliasesLower,
            searchText: `${nameLower} ${aliasesLower.join(" ")} ${p.role || ""} ${p.org || ""} ${p.preview || ""}`.toLowerCase(),
            basePriority: tierBoost,
            sortKey: parseTimestampMs(p.last_seen_iso || p.last_seen),
            payload: p as PersonDirectoryItem,
          });
        }
      }

      // Include canonical cards not yet present in listPeople (e.g. cold or zero-bridge cards)
      if (canonicalCardsRes?.cards) {
        for (const card of canonicalCardsRes.cards) {
          const slugLow = card.slug.toLowerCase();
          if (seenPeople.has(slugLow)) continue;
          seenPeople.add(slugLow);
          const name = cleanText(card.display_name || card.canonical_name || card.slug, 80);
          const aliasesLower = aliasesBySlug.get(slugLow) || [slugLow];
          const item: PersonDirectoryItem = {
            key: card.slug,
            name,
            initials: name
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((w) => w[0]?.toUpperCase() || "")
              .join("") || "?",
            channels: [],
            channel_counts: {},
            message_count: 0,
            meeting_count: 0,
            last_seen: null,
            last_seen_iso: null,
            last_seen_label: "",
            last_snippet: cleanText(card.world_model.canonical_read || "", 160),
            preview: cleanText(card.world_model.canonical_read || "", 160),
            next_meeting: null,
            role: card.world_model.role || null,
            org: card.world_model.org || null,
            relationship_tier: card.world_model.relationship_tier,
            profile_tier: "v2",
            has_card: true,
            card_path: card.card_path,
            confidence: card.world_model.confidence ?? 0.8,
            trend: "steady",
            recency_days: null,
          };
          byCorpus.people.push({
            docId: 0,
            corpus: "people",
            dedupeKey: slugLow,
            titleLower: name.toLowerCase(),
            aliasesLower,
            searchText: `${name} ${aliasesLower.join(" ")} ${card.world_model.canonical_read || ""}`.toLowerCase(),
            basePriority: 85,
            sortKey: 0,
            payload: item,
          });
        }
      }

      // Docs
      if (docsRes?.items) {
        for (const d of docsRes.items) {
          const title = cleanText(d.title || d.path, 140);
          const excerpt = cleanText(d.excerpt || "", 200);
          const payload = {
            path: d.path,
            title,
            category: d.category,
            updated_at: d.updated_at,
            excerpt,
          };
          byCorpus.docs.push({
            docId: 0,
            corpus: "docs",
            dedupeKey: d.path,
            titleLower: title.toLowerCase(),
            aliasesLower: [d.path.toLowerCase(), String(d.category || "").toLowerCase()],
            searchText: `${title} ${d.path} ${d.category || ""} ${excerpt}`.toLowerCase(),
            basePriority: 65,
            sortKey: parseTimestampMs(d.updated_at),
            payload,
          });
        }
      }

      // MemT experiences
      for (const m of memtAll || []) {
        const condition = cleanText(m.condition, 200);
        const recommendation = cleanText(m.recommendation, 260);
        const payload = {
          id: m.id,
          domain: m.domain,
          condition,
          recommendation,
          outcome: m.outcome,
          confidence: Number(m.confidence ?? 0.9),
        };
        byCorpus.memt.push({
          docId: 0,
          corpus: "memt",
          dedupeKey: m.id,
          titleLower: condition.toLowerCase(),
          aliasesLower: [String(m.domain || "").toLowerCase(), m.id.toLowerCase()],
          searchText: `${m.domain} ${condition} ${recommendation} ${m.verification || ""}`.toLowerCase(),
          basePriority: 70 + Math.round(payload.confidence * 20),
          sortKey: parseTimestampMs(m.updated_at || m.created_at),
          payload,
        });
      }

      // Codex items
      if (codexRes?.items) {
        for (const item of codexRes.items) {
          const hit: CodexOmniHit = {
            id: item.id,
            section: item.section,
            title: cleanText(item.title || item.id, 140),
            subtitle: cleanText(item.subtitle || item.summary || "", 160),
            domain: item.domain,
            ...(item.stage ? { stage: item.stage } : {}),
            url_view: "codex",
          };
          byCorpus.codex.push({
            docId: 0,
            corpus: "codex",
            dedupeKey: item.id,
            titleLower: hit.title.toLowerCase(),
            aliasesLower: [item.id.toLowerCase(), ...(item.tags || []).map((t) => t.toLowerCase())],
            searchText: `${hit.title} ${hit.subtitle} ${item.summary || ""} ${item.domain || ""} ${(item.tags || []).join(" ")} ${item.id}`.toLowerCase(),
            basePriority: 75 + (item.pinned ? 15 : 0) + Math.round((item.leverage_score || 0) / 10),
            sortKey: parseTimestampMs(item.updated_at),
            payload: hit,
          });
        }
      }

      // Taste rules & vault docs
      if (tasteRes) {
        const allRules = [
          ...(tasteRes.rules?.prefer || []),
          ...(tasteRes.rules?.avoid || []),
        ];
        for (const r of allRules) {
          const hit: OmniTasteHit = {
            id: r.id,
            domain: r.domain,
            polarity: r.polarity,
            rule: cleanText(r.rule, 160),
            reason: cleanText(r.reason || "", 180),
            kind: "rule",
          };
          byCorpus.taste.push({
            docId: 0,
            corpus: "taste",
            dedupeKey: r.id,
            titleLower: hit.rule.toLowerCase(),
            aliasesLower: [r.domain.toLowerCase(), r.polarity],
            searchText: `${hit.rule} ${hit.reason} ${r.domain} ${r.polarity} ${r.id}`.toLowerCase(),
            basePriority: 72,
            sortKey: parseTimestampMs(r.created_at),
            payload: hit,
          });
        }
        for (const doc of tasteRes.vault_docs || []) {
          const hit: OmniTasteHit = {
            id: doc.id,
            domain: doc.domain,
            polarity: doc.polarity,
            rule: cleanText(doc.title || doc.id, 140),
            reason: cleanText(doc.summary || `${doc.brand} (${doc.domain})`, 180),
            kind: "vault_doc",
          };
          byCorpus.taste.push({
            docId: 0,
            corpus: "taste",
            dedupeKey: doc.id,
            titleLower: hit.rule.toLowerCase(),
            aliasesLower: [doc.brand.toLowerCase(), doc.domain.toLowerCase()],
            searchText: `${hit.rule} ${doc.brand} ${doc.domain} ${hit.reason}`.toLowerCase(),
            basePriority: 68,
            sortKey: parseTimestampMs(doc.updated_at),
            payload: hit,
          });
        }
      }

      // Board thread heads
      const boardData = this.buildBoardEntries();
      byCorpus.board = boardData.entries;

      const allDocs: IndexedEntry[] = [
        ...byCorpus.calendar,
        ...byCorpus.inbox,
        ...byCorpus.docs,
        ...byCorpus.people,
        ...byCorpus.memt,
        ...byCorpus.nodes,
        ...byCorpus.codex,
        ...byCorpus.board,
        ...byCorpus.taste,
      ];

      const snap: OmniSnapshot = {
        builtAt: Date.now(),
        boardDataVersion: boardData.dataVersion,
        index: buildInvertedIndex(allDocs),
        byCorpus,
      };
      if (!this.closed) {
        this.snapshot = snap;
      }
      return snap;
    })().finally(() => {
      if (this.buildInFlight === task) {
        this.buildInFlight = null;
      }
    });

    this.buildInFlight = task;
    return task;
  }

  search(rawQuery: string, rawLimit = 8): OmniIndexResponse {
    const t0 = performance.now();
    const query = (rawQuery || "").trim();
    const limit = Math.max(1, Math.min(30, Number(rawLimit || 8) || 8));

    if (!query) {
      return {
        query: "",
        ms: 0,
        total: 0,
        codex: [],
        board: [],
        taste: [],
        groups: {
          calendar: [],
          inbox: [],
          docs: [],
          people: [],
          memt: [],
          nodes: [],
          codex: [],
          board: [],
          taste: [],
        },
      };
    }

    this.lastQueryAt = Date.now();
    this.ensurePeriodicRefresh();

    const snap = this.snapshot;
    if (!snap) {
      this.warmInBackground();
      return {
        query,
        ms: Math.round((performance.now() - t0) * 10) / 10,
        total: 0,
        codex: [],
        board: [],
        taste: [],
        groups: {
          calendar: [],
          inbox: [],
          docs: [],
          people: [],
          memt: [],
          nodes: [],
          codex: [],
          board: [],
          taste: [],
        },
      };
    }

    // Trigger background refresh if snapshot aged out
    if (Date.now() - snap.builtAt >= this.refreshIntervalMs && !this.buildInFlight) {
      this.warmInBackground();
    }

    const qLower = query.toLowerCase();
    const qTokens = tokenizeForIndex(qLower);
    const { docs, vocab, postings } = snap.index;

    // Score matching documents via O(log V) sorted-vocab prefix lookup with bounded per-term cap
    const scores = new Map<number, number>();
    const tokenHits = new Map<number, number>();
    const maxDocsPerPosting = qTokens.length === 1 ? Math.max(limit * 16, 128) : 600;

    for (let t = 0; t < qTokens.length; t += 1) {
      const qt = qTokens[t];
      const startIdx = lowerBound(vocab, qt);
      let expanded = 0;
      const seenForToken = new Set<number>();

      for (let vi = startIdx; vi < vocab.length && expanded < MAX_PREFIX_EXPANSIONS; vi += 1) {
        const term = vocab[vi];
        if (!term.startsWith(qt)) break;
        expanded += 1;
        const isExact = term.length === qt.length;
        const weight = isExact ? 42 : 24;
        const list = postings.get(term);
        if (!list) continue;
        const scanLen = Math.min(list.length, maxDocsPerPosting);
        for (let pi = 0; pi < scanLen; pi += 1) {
          const docId = list[pi];
          const prev = scores.get(docId) || 0;
          if (!seenForToken.has(docId)) {
            seenForToken.add(docId);
            scores.set(docId, prev + weight);
            tokenHits.set(docId, (tokenHits.get(docId) || 0) + 1);
          } else if (isExact) {
            scores.set(docId, prev + 12);
          }
        }
        if (seenForToken.size >= maxDocsPerPosting * 2) break;
      }
    }

    // Bucket scored docs by corpus and add exact/prefix title & phrase boosts
    const buckets: Record<CorpusKind, Array<{ entry: IndexedEntry; score: number }>> = {
      calendar: [],
      inbox: [],
      docs: [],
      people: [],
      memt: [],
      nodes: [],
      codex: [],
      board: [],
      taste: [],
    };
    const seenDocIds = new Set<number>();

    for (const [docId, baseTokenScore] of scores.entries()) {
      const entry = docs[docId];
      if (!entry) continue;
      seenDocIds.add(docId);
      let score = baseTokenScore + entry.basePriority * 0.4;
      const hitCount = tokenHits.get(docId) || 0;
      if (qTokens.length > 1 && hitCount === qTokens.length) {
        score += 45;
      }
      if (entry.titleLower === qLower) {
        score += 140;
      } else if (entry.titleLower.startsWith(qLower)) {
        score += 95;
      } else if (entry.titleLower.includes(qLower)) {
        score += 65;
      } else if (entry.aliasesLower.some((a) => a === qLower)) {
        score += 120;
      } else if (entry.aliasesLower.some((a) => a.startsWith(qLower))) {
        score += 80;
      } else if (entry.searchText.includes(qLower)) {
        score += 35;
      }
      buckets[entry.corpus].push({ entry, score });
    }

    // Fast bounded substring fallback for corpora under limit (handles mid-word substrings)
    if (qLower.length >= 3) {
      const corpora: CorpusKind[] = [
        "calendar",
        "inbox",
        "docs",
        "people",
        "memt",
        "nodes",
        "codex",
        "board",
        "taste",
      ];
      for (const corpus of corpora) {
        if (buckets[corpus].length >= limit) continue;
        const list = snap.byCorpus[corpus];
        for (let i = 0; i < list.length; i += 1) {
          const entry = list[i];
          if (seenDocIds.has(entry.docId)) continue;
          if (!entry.searchText.includes(qLower)) continue;
          seenDocIds.add(entry.docId);
          let score = 28 + entry.basePriority * 0.4;
          if (entry.titleLower.includes(qLower)) score += 45;
          buckets[corpus].push({ entry, score });
          if (buckets[corpus].length >= limit * 2) break;
        }
      }
    }

    const pickTop = <T>(corpus: CorpusKind): T[] => {
      const arr = buckets[corpus];
      if (arr.length === 0) return [];
      arr.sort((a, b) => b.score - a.score || b.entry.sortKey - a.entry.sortKey);
      const out: T[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < arr.length && out.length < limit; i += 1) {
        const entry = arr[i].entry;
        if (seen.has(entry.dedupeKey)) continue;
        seen.add(entry.dedupeKey);
        out.push(entry.payload as T);
      }
      return out;
    };

    const calendar = pickTop<OmniSearchResponse["groups"]["calendar"][number]>("calendar");
    const inbox = pickTop<OmniSearchResponse["groups"]["inbox"][number]>("inbox");
    const docHits = pickTop<OmniSearchResponse["groups"]["docs"][number]>("docs");
    const people = pickTop<PersonDirectoryItem>("people");
    const memt = pickTop<OmniSearchResponse["groups"]["memt"][number]>("memt");
    const nodes = pickTop<OmniSearchResponse["groups"]["nodes"][number]>("nodes");
    const codex = pickTop<CodexOmniHit>("codex");
    const taste = pickTop<OmniTasteHit>("taste");

    // Keep serving warm board hits in <1ms; trigger background refresh on live server if local.db changed.
    const board: BoardOmniHit[] = pickTop<BoardOmniHit>("board");
    const liveBoardVersion = this.readBoardDataVersion();
    const isTestEnv =
      process.env.NODE_ENV === "test" ||
      process.env.BUN_ENV === "test" ||
      (typeof Bun !== "undefined" && /\.test\.ts$/.test(String(Bun.main || "")));
    if (!isTestEnv && liveBoardVersion !== snap.boardDataVersion && !this.buildInFlight && Date.now() - snap.builtAt >= 5_000) {
      this.warmInBackground();
    }

    const total =
      calendar.length +
      inbox.length +
      docHits.length +
      people.length +
      memt.length +
      nodes.length +
      codex.length +
      board.length +
      taste.length;

    const ms = Math.round((performance.now() - t0) * 10) / 10;

    return {
      query,
      ms,
      total,
      codex,
      board,
      taste,
      groups: {
        calendar,
        inbox,
        docs: docHits,
        people,
        memt,
        nodes,
        codex,
        board,
        taste,
      },
    };
  }
}
