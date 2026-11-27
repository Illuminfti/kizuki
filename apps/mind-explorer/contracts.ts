// Frozen Wave 0 Contracts (C1-C6) for Kizuki Mind OS 10-Area Hill-Climb
// Shared types only; zero runtime side effects.

import type { KizukiVaultApi } from "./vault-api.ts";
import type { KizukiReplayApi } from "./replay-api.ts";
import type { KizukiCodexApi } from "./codex-api.ts";
import type { KizukiTasteApi } from "./taste-api.ts";
import type { KizukiTasteGardenerApi } from "./gardener-api.ts";
import type { KizukiAgentBoardApi } from "./agent-board-api.ts";
import type { KizukiBoardMindBridge } from "./board-mind-bridge.ts";

// S0-a: Dynamic route module contract
export interface RouteModuleContext {
  api: KizukiVaultApi;
  replayApi: KizukiReplayApi;
  codexApi: KizukiCodexApi;
  tasteApi: KizukiTasteApi;
  gardenerApi: KizukiTasteGardenerApi;
  agentBoardApi: KizukiAgentBoardApi;
  boardBridge: KizukiBoardMindBridge;
  json: (body: unknown, status?: number, extraHeaders?: Record<string, string>) => Response;
}

export interface RouteModuleHandler {
  match: (req: Request, url: URL) => boolean;
  handle: (req: Request, url: URL) => Promise<Response> | Response;
  overrides?: string[];
}

export type RouteModuleFactory = (ctx: RouteModuleContext) => RouteModuleHandler;

// C1: Durable Decision Stamp & Pending Gates
export type DecisionVerdict = "approve" | "revise" | "defer";

export interface DecisionStampRequest {
  threadId: string | number;
  verdict: DecisionVerdict;
  note?: string;
  idempotencyKey?: string;
  retract?: boolean;
}

export interface DecisionStampResponse {
  ok: boolean;
  threadId: string;
  verdict: DecisionVerdict;
  idempotencyKey: string;
  deduplicated: boolean;
  retracted?: boolean;
  replyId?: number | string | null;
  stampedAt: string;
  undoExpiresAt?: string;
  error?: string;
}

export interface PendingDecisionGate {
  threadId: string;
  channel: string;
  author: string;
  title: string;
  summary: string;
  recommendation?: string;
  ageMs: number;
  blockedCount: number;
  stamped?: {
    verdict: DecisionVerdict;
    stampedAt: string;
    note?: string;
  } | null;
}

// C2: Today Next-Move Radar
export type NextMoveKind =
  | "decision"
  | "reply_owed"
  | "meeting_prep"
  | "drift_alert"
  | "pipeline_alert"
  | "action_due";

export type NextMoveVerb =
  | "approve"
  | "revise"
  | "defer"
  | "draft_reply"
  | "prep"
  | "snooze"
  | "dismiss"
  | "make_action";

export interface NextMoveEvidence {
  label: string;
  kind: "board" | "message" | "meeting" | "person" | "pipeline" | "action" | "vault";
  ref?: string;
}

export interface NextMove {
  id: string;
  kind: NextMoveKind;
  title: string;
  why_now: string;
  evidence: NextMoveEvidence[];
  score: number;
  verbs: NextMoveVerb[];
  target?: {
    threadId?: string;
    personKey?: string;
    meetingId?: string;
    channel?: string;
    actionId?: string;
  };
  ageHours?: number;
  recommendation?: string;
}

export interface NextMovesResponse {
  generated_at: string;
  moves: NextMove[];
  counts: {
    decisions: number;
    replies_owed: number;
    meetings_soon: number;
    drifting: number;
    pipelines_degraded: number;
    actions_due: number;
  };
  lede: string;
}

// C3: 52-Week People Relationship Ledger & People Radar
export interface RelationshipLedgerWeek {
  weekStart: string;
  in: number;
  out: number;
  meetings: number;
  channels: string[];
}

export interface OpenLoopItem {
  kind: "inbound_ask" | "owner_promise";
  channel: string;
  date: string;
  ageHours: number;
  excerpt: string;
}

export interface RelationshipLedger {
  weeks: RelationshipLedgerWeek[];
  median_gap_days: number;
  current_gap_days: number;
  drift_z: number;
  reciprocity_52w: number;
  initiation_ratio: number;
  streak_weeks: number;
  last_inbound_unanswered: boolean;
  open_loops: OpenLoopItem[];
  next_touch: string;
  summary_sentence: string;
}

export interface PeopleRadarEntry {
  key: string;
  name: string;
  tier: string;
  score: number;
  reason: string;
  evidence: string[];
  channels: string[];
  ageHours?: number;
  drift_z?: number;
}

export interface WarmIntroEntry {
  personA: { key: string; name: string };
  personB: { key: string; name: string };
  sharedSignal: string;
  evidence: string[];
  score: number;
}

export interface PeopleRadarResponse {
  generated_at: string;
  owed_replies: PeopleRadarEntry[];
  drifting: PeopleRadarEntry[];
  upcoming_touch: PeopleRadarEntry[];
  warm_intros: WarmIntroEntry[];
}

// C4: Omni Inverted Index Search Contract
export interface OmniIndexSearch {
  search: (query: string, limit?: number) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

// C5: ETag + If-None-Match 304 on JSON while keeping Cache-Control: no-store
// Enforced in http-wire.ts finalize(req, res).

// C6: Shared Design Token CSS custom properties in public/tokens.css
// --t-xs (11px), --t-sm (12px), --t-base (13px), --t-md (15px),
// --t-lg (18px), --t-xl (24px), --t-2xl (32px), --t-display (44px)
