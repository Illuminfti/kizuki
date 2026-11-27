import { appendFile, chmod, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DecisionStampRequest,
  DecisionStampResponse,
  DecisionVerdict,
  PendingDecisionGate,
} from "./contracts.ts";
import {
  BadRequestError,
  KizukiAgentBoardApi,
  SecretDetectedError,
  stripEmDashes,
  type BoardBlockersResponse,
} from "./agent-board-api.ts";
import type { KizukiBoardMindBridge } from "./board-mind-bridge.ts";

export { BadRequestError, SecretDetectedError };

const DEFAULT_VAULT_ROOT =
  process.env.KIZUKI_VAULT || process.env.KIZUKI_VAULT_PATH || join(homedir(), "Kizuki");

export const DEFAULT_DECISION_LEDGER_PATH =
  process.env.KIZUKI_DECISION_LEDGER_PATH ||
  join(DEFAULT_VAULT_ROOT, "auto", "mind-os", "decision-ledger.jsonl");

export const DEFAULT_TODAY_TRIAGE_PATH =
  process.env.KIZUKI_TODAY_TRIAGE_PATH ||
  join(DEFAULT_VAULT_ROOT, "auto", "mind-os", "today-triage.jsonl");

export const DEFAULT_UNDO_WINDOW_MS = 30_000;

const VALID_VERDICTS = new Set<DecisionVerdict>(["approve", "revise", "defer"]);
const VALID_TRIAGE_ACTIONS = new Set<TodayTriageAction>(["snooze", "dismiss", "restore"]);
const IDEMPOTENCY_KEY_RE = /^[a-zA-Z0-9._:/-]{1,160}$/;
const MAX_NOTE_CHARS = 4_000;

const VERDICT_DEFAULT_NOTE: Record<DecisionVerdict, string> = {
  approve: "Approved to proceed.",
  revise: "Needs revision before proceeding.",
  defer: "Deferred to next cycle.",
};

export type TodayTriageAction = "snooze" | "dismiss" | "restore";

export interface DecisionLedgerEntry {
  type: "stamp" | "retract";
  threadId: string;
  verdict: DecisionVerdict;
  note?: string;
  idempotencyKey: string;
  replyId: string | null;
  stampedAt: string;
  undoExpiresAt?: string;
}

export interface TodayTriageRequest {
  id: string;
  action: TodayTriageAction;
  hours?: number;
}

export interface TodayTriageRecord {
  id: string;
  action: TodayTriageAction;
  at: string;
  snoozeUntil?: string;
  dismissedAt?: string;
  restoredAt?: string;
}

export interface TodayTriageResponse {
  ok: true;
  id: string;
  action: TodayTriageAction;
  at: string;
  snoozeUntil?: string;
  dismissedAt?: string;
  restoredAt?: string;
}

export interface DecisionLedgerConfig {
  agentBoardApi: Pick<KizukiAgentBoardApi, "replyToThread" | "getBlockers">;
  boardBridge?: Pick<KizukiBoardMindBridge, "getTodayBoardPulse"> | null;
  ledgerPath?: string;
  triagePath?: string;
  undoWindowMs?: number;
  nowFn?: () => number;
}

export interface ExtendedDecisionStampRequest extends DecisionStampRequest {
  resumePaused?: boolean;
}

export interface DecisionUndoRequest {
  threadId: string | number;
  idempotencyKey?: string;
  note?: string;
}

function cleanText(input: unknown, maxLen = 280): string {
  const s = stripEmDashes(String(input ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3)).trimEnd()}...`;
}

function normalizeThreadId(raw: string | number | undefined | null): string {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new BadRequestError("Invalid threadId: expected a positive numeric or string id");
    }
    return String(Math.trunc(raw));
  }
  const clean = String(raw ?? "").trim().replace(/^#+/, "");
  if (!clean || clean.length > 180) {
    throw new BadRequestError("Invalid threadId: must be a non-empty thread id");
  }
  if (/[\x00-\x1f\x7f/\\\s]/.test(clean) || clean.startsWith("-")) {
    throw new BadRequestError("Invalid threadId: contains illegal characters");
  }
  return clean;
}

function normalizeVerdict(raw: unknown): DecisionVerdict {
  const low = String(raw ?? "").trim().toLowerCase() as DecisionVerdict;
  if (!VALID_VERDICTS.has(low)) {
    throw new BadRequestError(
      'Invalid verdict: expected one of "approve", "revise", or "defer"',
    );
  }
  return low;
}

function normalizeOptionalIdempotencyKey(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const clean = String(raw).replace(/\0/g, "").trim();
  if (!IDEMPOTENCY_KEY_RE.test(clean) || clean.startsWith("-")) {
    throw new BadRequestError("Invalid idempotencyKey format");
  }
  return clean;
}

function normalizeOptionalNote(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw !== "string") {
    throw new BadRequestError("note must be a string");
  }
  const clean = stripEmDashes(raw.replace(/\0/g, "")).trim();
  if (clean.length > MAX_NOTE_CHARS) {
    throw new BadRequestError(`note exceeds maximum length of ${MAX_NOTE_CHARS} characters`);
  }
  return clean;
}

export function formatOwnerVerdictReply(verdict: DecisionVerdict, note?: string): string {
  const tag = verdict.toUpperCase();
  const prefix = `[OWNER VERDICT: ${tag}]`;
  const cleanNote = normalizeOptionalNote(note);
  if (!cleanNote) {
    return `${prefix} ${VERDICT_DEFAULT_NOTE[verdict]}`;
  }
  if (cleanNote.toUpperCase().startsWith(prefix)) {
    return cleanNote;
  }
  return `${prefix} ${cleanNote}`;
}

export function stripVerdictPrefix(verdict: DecisionVerdict, note?: string): string {
  const cleanNote = normalizeOptionalNote(note);
  if (!cleanNote) return "";
  const prefix = `[OWNER VERDICT: ${verdict.toUpperCase()}]`;
  if (cleanNote.toUpperCase().startsWith(prefix)) {
    return cleanNote.slice(prefix.length).trim();
  }
  return cleanNote;
}

export function formatOwnerRetractionReply(verdict: DecisionVerdict, note?: string): string {
  const cleanNote = normalizeOptionalNote(note);
  const base = `[OWNER VERDICT RETRACTED] Retracting previous ${verdict.toUpperCase()} verdict.`;
  return cleanNote ? `${base} ${cleanNote}` : base;
}

async function appendJsonlSecure(filePath: string, record: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(filePath, line, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

function readJsonlRecords<T>(filePath: string): T[] {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as T;
      if (parsed && typeof parsed === "object") {
        out.push(parsed);
      }
    } catch {
      // Ignore partial or malformed trailing line safely.
    }
  }
  return out;
}

function extractRecommendationFromText(text: string): string | undefined {
  const clean = stripEmDashes(text || "");
  const m = /(?:^|\n)\s*Recommendation\s*:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i.exec(clean);
  if (m && m[1]) {
    return cleanText(m[1], 360);
  }
  return undefined;
}

function deriveGateTitle(rawTitle: unknown, rawText: unknown, threadId: string): string {
  const titleStr = cleanText(rawTitle, 140);
  if (titleStr) return titleStr;
  const textStr = stripEmDashes(String(rawText ?? "")).trim();
  if (!textStr) return `Decision #${threadId}`;
  const firstLine = textStr.split(/\r?\n/)[0] || textStr;
  return cleanText(firstLine, 140);
}

function parseTimestampMs(raw: unknown, fallbackMs: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw > 1e12 ? raw : raw * 1000;
  }
  if (typeof raw === "string" && raw.trim()) {
    const ms = Date.parse(raw.trim());
    if (Number.isFinite(ms)) return ms;
  }
  return fallbackMs;
}

export class DecisionLedger {
  readonly ledgerPath: string;
  readonly triagePath: string;
  private readonly agentBoardApi: Pick<KizukiAgentBoardApi, "replyToThread" | "getBlockers">;
  private readonly boardBridge: Pick<KizukiBoardMindBridge, "getTodayBoardPulse"> | null;
  private readonly undoWindowMs: number;
  private readonly nowFn: () => number;

  private cachedLedgerSig = "";
  private cachedLedgerEntries: DecisionLedgerEntry[] = [];
  private cachedTriageSig = "";
  private cachedTriageRecords: TodayTriageRecord[] = [];

  constructor(cfg: DecisionLedgerConfig) {
    this.agentBoardApi = cfg.agentBoardApi;
    this.boardBridge = cfg.boardBridge ?? null;
    this.ledgerPath = cfg.ledgerPath || DEFAULT_DECISION_LEDGER_PATH;
    this.triagePath = cfg.triagePath || DEFAULT_TODAY_TRIAGE_PATH;
    this.undoWindowMs =
      typeof cfg.undoWindowMs === "number" && Number.isFinite(cfg.undoWindowMs) && cfg.undoWindowMs > 0
        ? cfg.undoWindowMs
        : DEFAULT_UNDO_WINDOW_MS;
    this.nowFn = cfg.nowFn || (() => Date.now());
  }

  private getFileSig(filePath: string): string {
    if (!existsSync(filePath)) return "missing";
    try {
      const st = statSync(filePath);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return "missing";
    }
  }

  readLedgerEntries(): DecisionLedgerEntry[] {
    const sig = this.getFileSig(this.ledgerPath);
    if (sig === this.cachedLedgerSig) {
      return this.cachedLedgerEntries;
    }
    const entries = readJsonlRecords<DecisionLedgerEntry>(this.ledgerPath);
    this.cachedLedgerSig = sig;
    this.cachedLedgerEntries = entries;
    return entries;
  }

  readTriageRecords(): TodayTriageRecord[] {
    const sig = this.getFileSig(this.triagePath);
    if (sig === this.cachedTriageSig) {
      return this.cachedTriageRecords;
    }
    const records = readJsonlRecords<TodayTriageRecord>(this.triagePath);
    this.cachedTriageSig = sig;
    this.cachedTriageRecords = records;
    return records;
  }

  getActiveVerdicts(): Map<string, DecisionLedgerEntry> {
    const entries = this.readLedgerEntries();
    const active = new Map<string, DecisionLedgerEntry>();
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (!entry || !entry.threadId) continue;
      if (entry.type === "retract") {
        active.delete(String(entry.threadId));
      } else if (entry.type === "stamp") {
        active.set(String(entry.threadId), entry);
      }
    }
    return active;
  }

  getActiveVerdict(threadId: string | number): DecisionLedgerEntry | null {
    const normId = normalizeThreadId(threadId);
    return this.getActiveVerdicts().get(normId) || null;
  }

  async stampDecision(req: ExtendedDecisionStampRequest): Promise<DecisionStampResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Decision stamp payload must be a JSON object");
    }

    const threadId = normalizeThreadId(req.threadId);
    if (req.retract === true) {
      return this.undoDecision({
        threadId,
        idempotencyKey: req.idempotencyKey,
        note: req.note,
      });
    }

    const verdict = normalizeVerdict(req.verdict);
    const explicitKey = normalizeOptionalIdempotencyKey(req.idempotencyKey);
    const idempotencyKey = explicitKey || `stamp:${threadId}:${verdict}`;
    const rawNote = normalizeOptionalNote(req.note);
    const storedNote = stripVerdictPrefix(verdict, rawNote);

    const entries = this.readLedgerEntries();
    const activeMap = this.getActiveVerdicts();
    const currentActive = activeMap.get(threadId) || null;

    // Deduplicate on explicit idempotencyKey (if already stamped and still active or same explicit key)
    if (explicitKey) {
      const matched = entries.find(
        (e) => e.type === "stamp" && e.idempotencyKey === explicitKey,
      );
      if (matched) {
        return {
          ok: true,
          threadId: matched.threadId,
          verdict: matched.verdict,
          idempotencyKey: matched.idempotencyKey,
          deduplicated: true,
          replyId: matched.replyId,
          stampedAt: matched.stampedAt,
          undoExpiresAt: matched.undoExpiresAt,
        };
      }
    }

    // Deduplicate on active (threadId, verdict) pair
    if (currentActive && currentActive.verdict === verdict) {
      return {
        ok: true,
        threadId: currentActive.threadId,
        verdict: currentActive.verdict,
        idempotencyKey: currentActive.idempotencyKey,
        deduplicated: true,
        replyId: currentActive.replyId,
        stampedAt: currentActive.stampedAt,
        undoExpiresAt: currentActive.undoExpiresAt,
      };
    }

    const replyText = formatOwnerVerdictReply(verdict, rawNote);

    // Post through Agent Board fail-closed gitleaks path FIRST.
    // If SecretDetectedError is thrown, NOTHING is written to board or ledger.
    const replyRes = await this.agentBoardApi.replyToThread({
      threadId,
      text: replyText,
      resumePaused: Boolean(req.resumePaused),
    });

    const nowMs = this.nowFn();
    const stampedAt = new Date(nowMs).toISOString();
    const undoExpiresAt = new Date(nowMs + this.undoWindowMs).toISOString();
    const replyId = replyRes?.id ? String(replyRes.id) : null;

    const record: DecisionLedgerEntry = {
      type: "stamp",
      threadId,
      verdict,
      ...(storedNote ? { note: storedNote } : {}),
      idempotencyKey,
      replyId,
      stampedAt,
      undoExpiresAt,
    };

    await appendJsonlSecure(this.ledgerPath, record);
    this.cachedLedgerSig = "";

    return {
      ok: true,
      threadId,
      verdict,
      idempotencyKey,
      deduplicated: false,
      replyId,
      stampedAt,
      undoExpiresAt,
    };
  }

  async undoDecision(req: DecisionUndoRequest): Promise<DecisionStampResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Undo request payload must be a JSON object");
    }

    const threadId = normalizeThreadId(req.threadId);
    const explicitKey = normalizeOptionalIdempotencyKey(req.idempotencyKey);
    const note = normalizeOptionalNote(req.note);
    const entries = this.readLedgerEntries();
    const active = this.getActiveVerdicts().get(threadId) || null;

    if (!active) {
      // Idempotent check: if the latest event for this thread was already a retraction, report deduplicated.
      let lastForThread: DecisionLedgerEntry | null = null;
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i].threadId === threadId) {
          lastForThread = entries[i];
          break;
        }
      }
      if (lastForThread && lastForThread.type === "retract") {
        return {
          ok: true,
          threadId,
          verdict: lastForThread.verdict,
          idempotencyKey: lastForThread.idempotencyKey,
          deduplicated: true,
          retracted: true,
          replyId: lastForThread.replyId,
          stampedAt: lastForThread.stampedAt,
        };
      }
      throw new BadRequestError(`No active decision verdict found to undo for thread #${threadId}`);
    }

    const nowMs = this.nowFn();
    const expiresMs = active.undoExpiresAt ? Date.parse(active.undoExpiresAt) : NaN;
    if (Number.isFinite(expiresMs) && nowMs > expiresMs) {
      throw new BadRequestError("Undo window expired (30s limit)");
    }

    const retractKey = explicitKey || `retract:${threadId}:${active.idempotencyKey}`;
    const retractText = formatOwnerRetractionReply(active.verdict, note);

    const replyRes = await this.agentBoardApi.replyToThread({
      threadId,
      text: retractText,
      resumePaused: false,
    });

    const retractedAt = new Date(nowMs).toISOString();
    const replyId = replyRes?.id ? String(replyRes.id) : null;

    const record: DecisionLedgerEntry = {
      type: "retract",
      threadId,
      verdict: active.verdict,
      ...(note ? { note } : {}),
      idempotencyKey: retractKey,
      replyId,
      stampedAt: retractedAt,
    };

    await appendJsonlSecure(this.ledgerPath, record);
    this.cachedLedgerSig = "";

    return {
      ok: true,
      threadId,
      verdict: active.verdict,
      idempotencyKey: retractKey,
      deduplicated: false,
      retracted: true,
      replyId,
      stampedAt: retractedAt,
    };
  }

  async getPendingDecisions(): Promise<PendingDecisionGate[]> {
    const nowMs = this.nowFn();
    const activeVerdicts = this.getActiveVerdicts();

    let blockers: BoardBlockersResponse | null = null;
    try {
      blockers = await this.agentBoardApi.getBlockers();
    } catch {
      blockers = null;
    }

    const seen = new Map<string, PendingDecisionGate>();

    const ingestRawGate = (
      raw: unknown,
      opts: { prioritySource: "escalation" | "orchestrator" | "paused" | "pulse"; blockedWeight?: number },
    ): void => {
      if (!raw || typeof raw !== "object") return;
      const obj = raw as Record<string, unknown>;
      const rawId = obj.threadId ?? obj.thread_id ?? obj.id ?? obj.numericId;
      if (rawId === undefined || rawId === null || String(rawId).trim() === "") return;
      const threadId = String(rawId).trim().replace(/^#+/, "");
      if (seen.has(threadId)) return;

      const channel = stripEmDashes(String(obj.channel || obj.room || "box")).replace(/^#+/, "").trim() || "box";
      const labels =
        obj.labels && typeof obj.labels === "object" && !Array.isArray(obj.labels)
          ? (obj.labels as Record<string, unknown>)
          : {};
      const labelKind = String(labels.kind || "").toLowerCase();
      const chLow = channel.toLowerCase();

      // For paused items, keep genuine decisions/owner-input gates and avoid flooding with stale routine RSI noise
      if (opts.prioritySource === "paused") {
        const isDecisionLike =
          chLow.includes("decision") ||
          chLow.includes("escalation") ||
          chLow.includes("approval") ||
          labelKind === "decision" ||
          labels.escalation === "owner" ||
          labels.escalation === "orchestrator" ||
          Boolean(obj.recommendation);
        if (!isDecisionLike) return;
      }

      const rawText = String(obj.text || obj.body || obj.summary || "");
      const title = deriveGateTitle(obj.title, rawText, threadId);
      const summary = cleanText(obj.summary || rawText || title, 280);
      const recommendation =
        typeof obj.recommendation === "string" && obj.recommendation.trim()
          ? cleanText(obj.recommendation, 360)
          : extractRecommendationFromText(rawText);

      const createdAtMs = parseTimestampMs(
        obj.created_at ?? obj.createdAt ?? obj.createdAtMs ?? obj.lastAt,
        nowMs,
      );
      const ageMs =
        typeof obj.ageMs === "number" && Number.isFinite(obj.ageMs)
          ? Math.max(0, obj.ageMs)
          : Math.max(0, nowMs - createdAtMs);

      const blockedCountRaw = Number(obj.blockedCount ?? obj.blocked_count ?? obj.dependents ?? 0);
      const blockedCount =
        Number.isFinite(blockedCountRaw) && blockedCountRaw > 0
          ? Math.trunc(blockedCountRaw)
          : opts.blockedWeight ?? 1;

      const author = cleanText(
        obj.author || obj.displayName || obj.by || "agent",
        64,
      );

      const ledgerStamp = activeVerdicts.get(threadId) || null;
      const stamped = ledgerStamp
        ? {
            verdict: ledgerStamp.verdict,
            stampedAt: ledgerStamp.stampedAt,
            ...(ledgerStamp.note ? { note: ledgerStamp.note } : {}),
          }
        : null;

      seen.set(threadId, {
        threadId,
        channel,
        author,
        title,
        summary,
        ...(recommendation ? { recommendation } : {}),
        ageMs,
        blockedCount,
        stamped,
      });
    };

    if (blockers) {
      for (const item of Array.isArray(blockers.escalations) ? blockers.escalations : []) {
        ingestRawGate(item, { prioritySource: "escalation", blockedWeight: 2 });
      }
      for (const item of Array.isArray(blockers.orchestratorQueue) ? blockers.orchestratorQueue : []) {
        ingestRawGate(item, { prioritySource: "orchestrator", blockedWeight: 1 });
      }
      for (const item of Array.isArray(blockers.paused) ? blockers.paused : []) {
        ingestRawGate(item, { prioritySource: "paused", blockedWeight: 1 });
      }
    }

    // Optional fallback from boardBridge.getTodayBoardPulse() when blockers list had no decision gates
    if (seen.size === 0 && this.boardBridge) {
      try {
        const pulse = await this.boardBridge.getTodayBoardPulse();
        for (const item of Array.isArray(pulse.topThreads) ? pulse.topThreads : []) {
          if (
            item.isBlocked ||
            item.isPaused ||
            item.signal?.signalKind === "decision" ||
            item.channel.includes("decision")
          ) {
            ingestRawGate(item, { prioritySource: "pulse", blockedWeight: 1 });
          }
        }
      } catch {
        // Fail-soft if board pulse is unavailable.
      }
    }

    // Sort open gates first by age descending, then stamped gates by stampedAt descending.
    const gates = Array.from(seen.values());
    gates.sort((a, b) => {
      const aStamped = a.stamped ? 1 : 0;
      const bStamped = b.stamped ? 1 : 0;
      if (aStamped !== bStamped) return aStamped - bStamped;
      return b.ageMs - a.ageMs || a.threadId.localeCompare(b.threadId);
    });
    return gates;
  }

  async recordTriage(req: TodayTriageRequest): Promise<TodayTriageResponse> {
    if (!req || typeof req !== "object") {
      throw new BadRequestError("Triage payload must be a JSON object");
    }
    const id = String(req.id ?? "").replace(/\0/g, "").trim();
    if (!id || id.length > 220) {
      throw new BadRequestError("Triage id must be a non-empty string (max 220 chars)");
    }
    const action = String(req.action ?? "").trim().toLowerCase() as TodayTriageAction;
    if (!VALID_TRIAGE_ACTIONS.has(action)) {
      throw new BadRequestError('Invalid triage action: expected "snooze", "dismiss", or "restore"');
    }

    const nowMs = this.nowFn();
    const at = new Date(nowMs).toISOString();
    const record: TodayTriageRecord = { id, action, at };

    if (action === "snooze") {
      const rawHours = req.hours === undefined ? 4 : Number(req.hours);
      if (!Number.isFinite(rawHours) || rawHours <= 0) {
        throw new BadRequestError("hours must be a positive number");
      }
      const clampedHours = Math.min(720, Math.max(0.0001, rawHours));
      record.snoozeUntil = new Date(nowMs + clampedHours * 3_600_000).toISOString();
    } else if (action === "dismiss") {
      record.dismissedAt = at;
    } else if (action === "restore") {
      record.restoredAt = at;
    }

    await appendJsonlSecure(this.triagePath, record);
    this.cachedTriageSig = "";

    return {
      ok: true,
      id: record.id,
      action: record.action,
      at: record.at,
      ...(record.snoozeUntil ? { snoozeUntil: record.snoozeUntil } : {}),
      ...(record.dismissedAt ? { dismissedAt: record.dismissedAt } : {}),
      ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}),
    };
  }

  getActiveTriageMap(nowMsOverride?: number): Map<string, TodayTriageRecord> {
    const nowMs = nowMsOverride ?? this.nowFn();
    const records = this.readTriageRecords();
    const latestById = new Map<string, TodayTriageRecord>();

    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i];
      if (!rec || !rec.id) continue;
      if (rec.action === "restore") {
        latestById.delete(rec.id);
      } else {
        latestById.set(rec.id, rec);
      }
    }

    const active = new Map<string, TodayTriageRecord>();
    for (const [id, rec] of latestById.entries()) {
      if (rec.action === "dismiss") {
        active.set(id, rec);
      } else if (rec.action === "snooze" && rec.snoozeUntil) {
        const untilMs = Date.parse(rec.snoozeUntil);
        if (Number.isFinite(untilMs) && untilMs > nowMs) {
          active.set(id, rec);
        }
      }
    }
    return active;
  }

  getHiddenMoveIds(nowMsOverride?: number): Set<string> {
    return new Set(this.getActiveTriageMap(nowMsOverride).keys());
  }

  isMoveHidden(id: string, nowMsOverride?: number): boolean {
    return this.getHiddenMoveIds(nowMsOverride).has(String(id ?? "").trim());
  }
}
