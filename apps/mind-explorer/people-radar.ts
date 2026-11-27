// People Radar & Local Prep Pack Engine (Contract C3)
// Deterministic, background-refreshed relationship radar and local-only prep packs.
// Strictly read-only: no outbound messaging or external transport.

import type {
  OpenLoopItem,
  PeopleRadarEntry,
  PeopleRadarResponse,
  RelationshipLedger,
  WarmIntroEntry,
} from "./contracts.ts";
import {
  buildRelationshipLedger,
  DEFAULT_LIFEOS_RELATIONSHIPS_DIR,
  isGroupOrBotContact,
  isOutboundMessage,
  loadRelationshipDyads,
  normalizeSlug,
  stripEmDashesIntel,
  trimWordBoundary,
  type LedgerMeetingInput,
  type LedgerMessageInput,
  type RelationshipDyad,
  type RelationshipTier,
} from "./people-intel.ts";
import type { KizukiVaultApi } from "./vault-api.ts";
import type { KizukiBoardMindBridge } from "./board-mind-bridge.ts";

export interface RadarPersonRecord {
  key: string;
  name: string;
  tier: RelationshipTier | string;
  profile_tier?: string;
  relationship_state?: string;
  role?: string;
  org?: string;
  email?: string;
  channels: string[];
  is_group?: boolean;
  tags?: string[];
  topics?: string[];
  collaborator_keys?: string[];
  messages: LedgerMessageInput[];
  meetings: Array<LedgerMeetingInput & { id?: string; participants?: string[] }>;
}

export interface PersonPrepPack {
  ok: true;
  local_only: true;
  generated_at: string;
  person: {
    key: string;
    name: string;
    tier: string;
    role: string;
    org: string;
    channels: string[];
  };
  ledger: RelationshipLedger;
  last_exchanges: Array<{
    channel: string;
    sender: string;
    direction: "in" | "out";
    occurred_at: string;
    text: string;
  }>;
  open_loops: {
    inbound_asks: OpenLoopItem[];
    owner_promises: OpenLoopItem[];
    card_loops: Array<{ loop: string; state: string; next_evidence: string }>;
  };
  commitments: string[];
  shared_board_threads: Array<{
    id: string;
    channel: string;
    title: string;
    summary: string;
    author: string;
    created_at: string;
  }>;
  recent_claims: Array<{
    id: string;
    kind: string;
    text: string;
    created_at: string;
    confidence: number;
  }>;
  upcoming_meetings: Array<{
    title: string;
    start: string;
    countdown: string;
  }>;
  openers: string[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "aol.com",
  "msn.com",
]);

const GENERIC_ORGS = new Set([
  "",
  "none",
  "unknown",
  "n/a",
  "na",
  "personal",
  "independent",
  "self",
  "self-employed",
  "freelance",
  "family",
]);

const HIGH_SIGNAL_TOPICS: Array<{ token: string; label: string; re: RegExp }> = [
  { token: "protocol", label: "Protocol engineering", re: /\bprotocol\b/i },
  { token: "distributed", label: "Distributed systems", re: /\bdistributed\s+systems?\b|\bconsensus\b/i },
  { token: "security", label: "Security & cryptography", re: /\bsecurity\b|\bcrypto(?:graphy)?\b|\bencryption\b/i },
  { token: "mpc", label: "MPC cryptography", re: /\bmpc\b|\b2pc\b|\bthreshold\s+sign/i },
  { token: "zk", label: "Zero-knowledge", re: /\bzero[- ]knowledge\b|\bzkp\b|\bzk[- ]?snark/i },
  { token: "agents", label: "AI agents", re: /\bai\s+agents?\b|\bagentic\b|\bautonomous\s+agent/i },
  { token: "fundraising", label: "Fundraising & VC", re: /\bfundrais|\bseed\s+round\b|\bventure\s+capital\b|\binvestor\b/i },
  { token: "validators", label: "Validator infra", re: /\bvalidator\b|\bstaking\b|\bnode\s+operator\b/i },
  { token: "legal", label: "Legal & compliance", re: /\blegal\b|\bcounsel\b|\bregulatory\b|\bcompliance\b/i },
];

function cleanStr(raw: unknown, maxLen = 220): string {
  const s = stripEmDashesIntel(String(raw ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  return maxLen > 0 ? trimWordBoundary(s, maxLen) : s;
}

function tierWeight(tier: string, profileTier?: string): number {
  const t = String(tier || "").toLowerCase();
  if (t === "family") return 5.0;
  if (t === "core") return 4.0;
  if (profileTier === "v2" || profileTier === "lifeos" || t === "active") return 2.5;
  if (t === "warm") return 1.5;
  return 1.0;
}

function displayTierLabel(tier: string, profileTier?: string): string {
  const t = String(tier || "").trim();
  if (t === "Family" || t === "Core") return t;
  if (profileTier === "v2" || profileTier === "lifeos") return "Profiled";
  return t || "Ambient";
}

function formatWaitBrief(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatCountdownBrief(diffMs: number): string {
  if (diffMs <= 0) return "now";
  const mins = Math.max(1, Math.round(diffMs / 60_000));
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `in ${hrs}h ${rem}m` : `in ${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `in ${days}d ${remHrs}h` : `in ${days}d`;
}

function normalizeOrgKey(rawOrg?: string): string {
  const cleaned = cleanStr(rawOrg || "", 80)
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|co|labs?)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!cleaned || GENERIC_ORGS.has(cleaned) || cleaned.length < 3) return "";
  return cleaned;
}

function extractEmailDomain(email?: string): string {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0 || at >= raw.length - 1) return "";
  const domain = raw.slice(at + 1).replace(/[^a-z0-9.-]/g, "");
  if (!domain || !domain.includes(".") || GENERIC_EMAIL_DOMAINS.has(domain)) return "";
  return domain;
}

function extractTopicTokens(rec: RadarPersonRecord): Map<string, string> {
  const out = new Map<string, string>();
  const hay = [
    rec.role || "",
    rec.org || "",
    ...(rec.tags || []),
    ...(rec.topics || []),
  ].join(" ");
  for (const t of HIGH_SIGNAL_TOPICS) {
    if (t.re.test(hay)) {
      out.set(t.token, t.label);
    }
  }
  for (const rawTopic of rec.topics || []) {
    const slug = normalizeSlug(rawTopic);
    if (slug && slug.length >= 3 && !out.has(slug)) {
      out.set(slug, cleanStr(rawTopic, 40));
    }
  }
  return out;
}

function makePairKey(a: string, b: string): string {
  const ka = normalizeSlug(a);
  const kb = normalizeSlug(b);
  return ka < kb ? `${ka}::${kb}` : `${kb}::${ka}`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function computePeopleRadarFromRecords(
  records: RadarPersonRecord[],
  dyads: RelationshipDyad[] = [],
  nowMs: number = Date.now()
): PeopleRadarResponse {
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const owed_replies: PeopleRadarEntry[] = [];
  const drifting: PeopleRadarEntry[] = [];
  const upcoming_touch: PeopleRadarEntry[] = [];

  // Build existing dyad lookup set so warm_intros never recommends already-linked pairs
  const existingPairs = new Set<string>();
  for (const d of dyads) {
    if (d.slugA && d.slugB) {
      existingPairs.add(makePairKey(d.slugA, d.slugB));
    }
  }

  interface StrongProfile {
    rec: RadarPersonRecord;
    ledger: RelationshipLedger;
    total52w: number;
    orgKey: string;
    orgLabel: string;
    domain: string;
    topics: Map<string, string>;
    meetingKeys: Map<string, string>;
  }
  const strongContacts: StrongProfile[] = [];

  for (const rec of records) {
    if (!rec || !rec.key || !rec.name) continue;
    const latestText = rec.messages.length > 0 ? rec.messages[rec.messages.length - 1]?.text || "" : "";
    if (rec.is_group || isGroupOrBotContact(rec.name, rec.key, latestText)) continue;

    for (const colKey of rec.collaborator_keys || []) {
      if (colKey && colKey !== rec.key) {
        existingPairs.add(makePairKey(rec.key, colKey));
      }
    }

    const ledger = buildRelationshipLedger(rec.messages, rec.meetings, safeNowMs, {
      name: rec.name,
      tier: (rec.tier as RelationshipTier) || "Ambient",
      relationshipState: rec.relationship_state,
    });

    const tierStr = displayTierLabel(rec.tier, rec.profile_tier);
    const weight = tierWeight(rec.tier, rec.profile_tier);
    const channels = Array.from(new Set((rec.channels || []).map((c) => String(c).toLowerCase()))).sort();

    // 1. Owed Replies: 1:1 human where latest direct message is inbound with no later outbound
    if (ledger.last_inbound_unanswered) {
      let latestInbound: LedgerMessageInput | null = null;
      let latestInboundMs = -Infinity;
      for (const m of rec.messages) {
        if (!m || m.is_group || isOutboundMessage(m)) continue;
        const ms = Date.parse(m.occurred_at);
        if (!Number.isFinite(ms) || ms > safeNowMs) continue;
        if (isGroupOrBotContact(m.sender || "", "", m.text || "")) continue;
        if (ms > latestInboundMs) {
          latestInboundMs = ms;
          latestInbound = m;
        }
      }

      if (latestInbound && latestInboundMs > 0) {
        const ageHours = round1(Math.max(0.1, (safeNowMs - latestInboundMs) / HOUR_MS));
        const maxAgeHours = tierStr === "Family" || tierStr === "Core" ? 120 * 24 : 60 * 24;
        if (ageHours <= maxAgeHours) {
          const effectiveHours = Math.min(ageHours, 14 * 24) + Math.max(0, Math.log2(1 + Math.max(0, ageHours - 14 * 24)) * 4);
          const hasAsk = ledger.open_loops.some((l) => l.kind === "inbound_ask");
          const score = round2(weight * Math.max(0.5, effectiveHours) * (hasAsk ? 1.35 : 1.0));
          const chName = cleanStr(latestInbound.channel || "direct", 24);
          const snippet = cleanStr(latestInbound.text || "", 110);
          const evidence: string[] = [
            `Last inbound on ${chName} ${formatWaitBrief(ageHours)} ago${snippet ? `: "${snippet}"` : ""}`,
          ];
          if (hasAsk) {
            evidence.push("Inbound question or direct ask detected with no reply since");
          } else {
            evidence.push(`No outbound reply since (${tierStr} tier)`);
          }
          owed_replies.push({
            key: rec.key,
            name: cleanStr(rec.name, 80),
            tier: tierStr,
            score,
            reason: hasAsk
              ? `Unanswered ask waiting ${formatWaitBrief(ageHours)} on ${chName}`
              : `Reply owed (${formatWaitBrief(ageHours)} waiting on ${chName})`,
            evidence,
            channels,
            ageHours,
            drift_z: ledger.drift_z,
          });
        }
      }
    }

    // 2. Drifting: Family or Core contacts with drift_z > 2.0
    const isCoreOrFamily = rec.tier === "Family" || rec.tier === "Core";
    const total52w = ledger.weeks.reduce((sum, w) => sum + w.in + w.out + w.meetings, 0);
    if (isCoreOrFamily && ledger.drift_z > 2.0) {
      const score = round2(weight * ledger.drift_z * (1 + Math.log2(1 + total52w) * 0.25));
      const evidence: string[] = [
        `Current gap ${ledger.current_gap_days}d vs ${ledger.median_gap_days}d median cadence (drift z ${ledger.drift_z})`,
      ];
      if (total52w > 0) {
        evidence.push(`${total52w} interactions logged over the past 52 weeks`);
      }
      if (ledger.open_loops.length > 0) {
        evidence.push(`${ledger.open_loops.length} open loop${ledger.open_loops.length === 1 ? "" : "s"} unresolved`);
      }
      drifting.push({
        key: rec.key,
        name: cleanStr(rec.name, 80),
        tier: tierStr,
        score,
        reason: `${ledger.current_gap_days}d silent vs ${ledger.median_gap_days}d normal cadence (z ${ledger.drift_z})`,
        evidence,
        channels,
        ageHours: round1(ledger.current_gap_days * 24),
        drift_z: ledger.drift_z,
      });
    }

    // 3. Upcoming Touch: calendar meeting within next 48 hours
    let soonestMeeting: { title: string; startMs: number } | null = null;
    for (const m of rec.meetings || []) {
      if (!m || !m.start) continue;
      const ms = Date.parse(m.start);
      if (!Number.isFinite(ms)) continue;
      if (ms >= safeNowMs - 30 * 60_000 && ms <= safeNowMs + 48 * HOUR_MS) {
        if (!soonestMeeting || ms < soonestMeeting.startMs) {
          soonestMeeting = { title: cleanStr(m.title || "Upcoming meeting", 90), startMs: ms };
        }
      }
    }
    if (soonestMeeting) {
      const diffMs = soonestMeeting.startMs - safeNowMs;
      const hoursUntil = round1(Math.max(0, diffMs / HOUR_MS));
      const score = round2(weight * (100 / Math.max(1, hoursUntil + 1)));
      const countdown = formatCountdownBrief(diffMs);
      const evidence: string[] = [
        `Calendar: "${soonestMeeting.title}" (${countdown})`,
      ];
      if (ledger.open_loops.length > 0) {
        evidence.push(`${ledger.open_loops.length} open loop${ledger.open_loops.length === 1 ? "" : "s"} to close before meeting`);
      } else if (ledger.current_gap_days > 0) {
        evidence.push(`Last direct touch ${ledger.current_gap_days}d ago`);
      }
      upcoming_touch.push({
        key: rec.key,
        name: cleanStr(rec.name, 80),
        tier: tierStr,
        score,
        reason: `Meeting "${soonestMeeting.title}" ${countdown}`,
        evidence,
        channels,
        ageHours: hoursUntil,
        drift_z: ledger.drift_z,
      });
    }

    // Collect strong contacts for warm intro candidate matching
    const isStrong =
      isCoreOrFamily ||
      rec.tier === "Active" ||
      rec.profile_tier === "v2" ||
      rec.profile_tier === "lifeos" ||
      total52w >= 6;
    if (isStrong) {
      const meetingKeys = new Map<string, string>();
      for (const m of rec.meetings || []) {
        if (!m || !m.start) continue;
        const mKey = m.id
          ? `id:${m.id}`
          : `${normalizeSlug(m.title || "meeting")}@${String(m.start).slice(0, 16)}`;
        meetingKeys.set(mKey, cleanStr(m.title || "Shared meeting", 70));
      }
      strongContacts.push({
        rec,
        ledger,
        total52w,
        orgKey: normalizeOrgKey(rec.org),
        orgLabel: cleanStr(rec.org || "", 60),
        domain: extractEmailDomain(rec.email),
        topics: extractTopicTokens(rec),
        meetingKeys,
      });
    }
  }

  // 4. Warm Intros: pairs of strong contacts sharing org/domain/topic or co-attended meeting with no existing dyad
  const warm_intros: WarmIntroEntry[] = [];
  const capStrong = strongContacts
    .sort((a, b) => tierWeight(b.rec.tier, b.rec.profile_tier) - tierWeight(a.rec.tier, a.rec.profile_tier) || b.total52w - a.total52w)
    .slice(0, 65);

  const seenIntroPairs = new Set<string>();
  for (let i = 0; i < capStrong.length; i++) {
    for (let j = i + 1; j < capStrong.length; j++) {
      const a = capStrong[i];
      const b = capStrong[j];
      const pairKey = makePairKey(a.rec.key, b.rec.key);
      if (existingPairs.has(pairKey) || seenIntroPairs.has(pairKey)) continue;

      const evidence: string[] = [];
      let score = 0;
      let sharedSignal = "";

      if (a.orgKey && b.orgKey && a.orgKey === b.orgKey) {
        score += 12;
        sharedSignal = `Shared organization: ${a.orgLabel || b.orgLabel}`;
        evidence.push(`Both linked to organization "${a.orgLabel || b.orgLabel}" with no recorded dyad`);
      }

      if (a.domain && b.domain && a.domain === b.domain) {
        score += 10;
        if (!sharedSignal) sharedSignal = `Shared work domain: ${a.domain}`;
        evidence.push(`Both share work domain ${a.domain}`);
      }

      const sharedMeetings: string[] = [];
      for (const [mk, title] of a.meetingKeys.entries()) {
        if (b.meetingKeys.has(mk)) {
          sharedMeetings.push(title);
        }
      }
      if (sharedMeetings.length > 0) {
        score += 11 + Math.min(6, sharedMeetings.length * 2);
        if (!sharedSignal) sharedSignal = `Co-attended ${sharedMeetings.length} meeting${sharedMeetings.length === 1 ? "" : "s"}`;
        evidence.push(`Co-attended "${sharedMeetings[0]}"${sharedMeetings.length > 1 ? ` (+${sharedMeetings.length - 1} more)` : ""}`);
      }

      const sharedTopics: string[] = [];
      for (const [tok, label] of a.topics.entries()) {
        if (b.topics.has(tok)) {
          sharedTopics.push(label);
        }
      }
      if (sharedTopics.length > 0) {
        score += 5 + Math.min(8, sharedTopics.length * 3);
        if (!sharedSignal) sharedSignal = `Shared focus: ${sharedTopics.slice(0, 2).join(", ")}`;
        evidence.push(`Shared topic overlap: ${sharedTopics.slice(0, 3).join(", ")}`);
      }

      if (score >= 8 && evidence.length > 0) {
        seenIntroPairs.add(pairKey);
        const pairWeight = (tierWeight(a.rec.tier, a.rec.profile_tier) + tierWeight(b.rec.tier, b.rec.profile_tier)) / 2;
        warm_intros.push({
          personA: { key: a.rec.key, name: cleanStr(a.rec.name, 70) },
          personB: { key: b.rec.key, name: cleanStr(b.rec.name, 70) },
          sharedSignal: cleanStr(sharedSignal, 90),
          evidence,
          score: round2(score * (0.7 + pairWeight * 0.15)),
        });
      }
    }
  }

  owed_replies.sort((a, b) => b.score - a.score || (b.ageHours || 0) - (a.ageHours || 0));
  drifting.sort((a, b) => b.score - a.score || (b.drift_z || 0) - (a.drift_z || 0));
  upcoming_touch.sort((a, b) => (a.ageHours ?? 999) - (b.ageHours ?? 999) || b.score - a.score);
  warm_intros.sort((a, b) => b.score - a.score || a.personA.name.localeCompare(b.personA.name));

  return {
    generated_at: new Date(safeNowMs).toISOString(),
    owed_replies: owed_replies.slice(0, 25),
    drifting: drifting.slice(0, 20),
    upcoming_touch: upcoming_touch.slice(0, 15),
    warm_intros: warm_intros.slice(0, 12),
  };
}

export function buildTailoredOpeners(opts: {
  name: string;
  ledger: RelationshipLedger;
  lastExchanges: PersonPrepPack["last_exchanges"];
  upcomingMeetings: PersonPrepPack["upcoming_meetings"];
  recentClaims: PersonPrepPack["recent_claims"];
  sharedThreads: PersonPrepPack["shared_board_threads"];
  org?: string;
}): string[] {
  const firstName = cleanStr(opts.name, 60).split(/\s+/)[0] || "there";
  const openers: string[] = [];

  const firstAsk = opts.ledger.open_loops.find((l) => l.kind === "inbound_ask");
  const firstPromise = opts.ledger.open_loops.find((l) => l.kind === "owner_promise");

  if (firstAsk) {
    openers.push(
      `Hey ${firstName}, circling back on your note ("${trimWordBoundary(firstAsk.excerpt, 72)}") so this does not hang open.`
    );
  } else if (firstPromise) {
    openers.push(
      `Hey ${firstName}, following through on what I promised earlier ("${trimWordBoundary(firstPromise.excerpt, 72)}").`
    );
  }

  if (opts.upcomingMeetings.length > 0) {
    const mtg = opts.upcomingMeetings[0];
    openers.push(
      `Looking forward to "${trimWordBoundary(mtg.title, 60)}" (${mtg.countdown}); anything specific you want locked before we start?`
    );
  }

  if (opts.ledger.drift_z > 2 && opts.ledger.median_gap_days > 0) {
    openers.push(
      `Hey ${firstName}, realized it has been ${opts.ledger.current_gap_days}d since we last synced. What is top of mind on your side this week?`
    );
  }

  if (opts.sharedThreads.length > 0 && openers.length < 3) {
    openers.push(
      `Quick pulse check on ${trimWordBoundary(opts.sharedThreads[0].title, 64)}: happy to share the latest context whenever useful.`
    );
  }

  if (opts.recentClaims.length > 0 && openers.length < 3) {
    openers.push(
      `Been tracking the latest on "${trimWordBoundary(opts.recentClaims[0].text, 72)}" and wanted to get your read.`
    );
  }

  if (opts.lastExchanges.length > 0 && openers.length < 3) {
    const last = opts.lastExchanges[opts.lastExchanges.length - 1];
    openers.push(
      `Picking up from our last ${last.channel} exchange: how did things land on your end?`
    );
  }

  const fallbacks = [
    `Hey ${firstName}, quick check-in to see how things are moving${opts.org ? ` at ${cleanStr(opts.org, 40)}` : ""} this week.`,
    `Anything I can unblock or connect you with over the next few days?`,
    `Worth grabbing 15 minutes soon to compare notes on what is next?`,
  ];
  for (const fb of fallbacks) {
    if (openers.length >= 3) break;
    openers.push(fb);
  }

  return openers.slice(0, 3).map((s) => stripEmDashesIntel(s));
}

export interface PeopleRadarServiceOptions {
  api: KizukiVaultApi;
  boardBridge?: KizukiBoardMindBridge | null;
  relationshipsDir?: string;
  ttlMs?: number;
  nowFn?: () => number;
  loadRecordsOverride?: () => Promise<{ records: RadarPersonRecord[]; dyads: RelationshipDyad[] }>;
}

interface InternalPersonalIndexLike {
  peopleList?: Array<{
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
      tags?: string[];
      world_model?: {
        handles?: { email?: string };
        collaborators?: Array<{ slug: string; name: string }>;
        current_read_bullets?: string[];
      };
    } | null;
  }>;
  cardMergeMap?: Map<string, string>;
}

export class PeopleRadarService {
  private readonly api: KizukiVaultApi;
  private readonly boardBridge: KizukiBoardMindBridge | null;
  private readonly relationshipsDir: string;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private readonly loadRecordsOverride?: () => Promise<{ records: RadarPersonRecord[]; dyads: RelationshipDyad[] }>;

  private cachedSnapshot: { value: PeopleRadarResponse; builtAt: number } | null = null;
  private inFlight: Promise<PeopleRadarResponse> | null = null;
  private cachedDyads: { value: RelationshipDyad[]; loadedAt: number } | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: PeopleRadarServiceOptions) {
    this.api = opts.api;
    this.boardBridge = opts.boardBridge ?? null;
    this.relationshipsDir = opts.relationshipsDir ?? DEFAULT_LIFEOS_RELATIONSHIPS_DIR;
    this.ttlMs = Math.max(5_000, opts.ttlMs ?? 45_000);
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.loadRecordsOverride = opts.loadRecordsOverride;
  }

  startBackgroundRefresh(intervalMs = 60_000): void {
    if (this.refreshTimer) return;
    // Schedule an initial non-blocking warmup tick
    queueMicrotask(() => {
      void this.refresh().catch(() => {});
    });
    this.refreshTimer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, Math.max(15_000, intervalMs));
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
    this.cachedSnapshot = null;
  }

  private async loadDyads(mergeMap?: Map<string, string>): Promise<RelationshipDyad[]> {
    const now = this.nowFn();
    if (this.cachedDyads && now - this.cachedDyads.loadedAt < 300_000) {
      return this.cachedDyads.value;
    }
    const dyads = await loadRelationshipDyads(this.relationshipsDir, mergeMap || new Map()).catch(() => []);
    this.cachedDyads = { value: dyads, loadedAt: now };
    return dyads;
  }

  private async loadRecordsFromVault(): Promise<{ records: RadarPersonRecord[]; dyads: RelationshipDyad[] }> {
    if (this.loadRecordsOverride) {
      return this.loadRecordsOverride();
    }

    // Fast path: read the already-indexed PersonalIndexSnapshot from KizukiVaultApi
    const apiAny = this.api as unknown as {
      getPersonalIndex?: () => Promise<InternalPersonalIndexLike>;
      getPersonMessages?: (key: string) => Promise<LedgerMessageInput[]>;
    };

    if (typeof apiAny.getPersonalIndex === "function") {
      const personal = await apiAny.getPersonalIndex();
      const dyads = await this.loadDyads(personal.cardMergeMap);
      const list = Array.isArray(personal.peopleList) ? personal.peopleList : [];
      const records: RadarPersonRecord[] = [];
      for (const p of list) {
        if (!p || p.is_group) continue;
        const channels = Array.isArray(p.channels) ? p.channels : Array.from(p.channels || []);
        const wm = p.canonical_card?.world_model;
        records.push({
          key: p.key,
          name: p.name,
          tier: p.relationship_tier || "Ambient",
          profile_tier: p.profile_tier,
          relationship_state: p.relationship_state,
          role: p.role,
          org: p.org,
          email: wm?.handles?.email,
          channels,
          is_group: Boolean(p.is_group),
          tags: p.canonical_card?.tags || [],
          topics: (wm?.current_read_bullets || []).slice(0, 6),
          collaborator_keys: (wm?.collaborators || []).map((c) => c.slug).filter(Boolean),
          messages: (p.timeline || []).map((t) => ({
            channel: t.channel,
            sender: t.sender,
            occurred_at: t.occurred_at,
            text: t.text,
          })),
          meetings: (p.meetings || []).map((m) => ({
            id: m.id,
            title: m.title,
            start: m.start,
            participants: m.participants,
          })),
        });
      }
      return { records, dyads };
    }

    // Fallback path: use public listPeople + getPersonDossier for limited mock APIs
    const listed = await this.api.listPeople({ limit: 80 });
    const dyads = await this.loadDyads();
    const records: RadarPersonRecord[] = [];
    for (const item of listed.items || []) {
      try {
        const dossier = await this.api.getPersonDossier({ key: item.key, limit: 120 });
        const extraMsgs =
          typeof apiAny.getPersonMessages === "function"
            ? await apiAny.getPersonMessages(item.key).catch(() => null)
            : null;
        records.push({
          key: dossier.person.key,
          name: dossier.person.name,
          tier: dossier.person.relationship_tier || "Ambient",
          profile_tier: dossier.person.profile_tier,
          relationship_state: dossier.person.relationship_state,
          role: dossier.person.role,
          org: dossier.person.org,
          email: dossier.person.handles?.email,
          channels: dossier.person.channels || [],
          collaborator_keys: (dossier.collaborators || []).map((c) => c.key || c.slug).filter(Boolean),
          messages:
            extraMsgs && extraMsgs.length > 0
              ? extraMsgs
              : (dossier.timeline || []).map((t) => ({
                  channel: t.channel,
                  sender: t.sender,
                  direction: t.direction,
                  occurred_at: t.occurred_at,
                  text: t.text,
                })),
          meetings: (dossier.meetings || []).map((m) => ({
            id: m.id,
            title: m.title,
            start: m.start,
            is_upcoming: m.is_upcoming,
            participants: m.participants,
          })),
        });
      } catch {
        // Skip unreadable individual dossier
      }
    }
    return { records, dyads };
  }

  async refresh(): Promise<PeopleRadarResponse> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const { records, dyads } = await this.loadRecordsFromVault();
      const snap = computePeopleRadarFromRecords(records, dyads, this.nowFn());
      this.cachedSnapshot = { value: snap, builtAt: this.nowFn() };
      return snap;
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async getRadar(opts: { refresh?: boolean } = {}): Promise<PeopleRadarResponse> {
    const now = this.nowFn();
    if (this.cachedSnapshot && !opts.refresh) {
      const age = now - this.cachedSnapshot.builtAt;
      if (age > this.ttlMs && !this.inFlight) {
        // Stale-while-revalidate: answer immediately from memory and refresh in background
        void this.refresh().catch(() => {});
      }
      return this.cachedSnapshot.value;
    }
    return this.refresh();
  }

  async getPrepPack(rawKey: string): Promise<PersonPrepPack> {
    const key = String(rawKey || "").trim();
    const nowMs = this.nowFn();
    const dossier = await this.api.getPersonDossier({ key, limit: 200 });
    const person = dossier.person;
    const wm = dossier.world_model;

    const apiAny = this.api as unknown as {
      getPersonMessages?: (k: string) => Promise<LedgerMessageInput[]>;
    };
    const fullMsgs: LedgerMessageInput[] =
      typeof apiAny.getPersonMessages === "function"
        ? await apiAny.getPersonMessages(person.key).catch(() => [])
        : [];

    const timelineMessages: LedgerMessageInput[] =
      fullMsgs.length > 0
        ? fullMsgs
        : (dossier.timeline || []).map((t) => ({
            channel: t.channel,
            sender: t.sender,
            direction: t.direction,
            occurred_at: t.occurred_at,
            text: t.text,
          }));

    const meetingsInput: LedgerMeetingInput[] = (dossier.meetings || []).map((m) => ({
      title: m.title,
      start: m.start,
      is_upcoming: m.is_upcoming,
    }));

    const ledger: RelationshipLedger =
      dossier.profile_visuals?.ledger && dossier.profile_visuals.ledger.weeks?.length === 52
        ? dossier.profile_visuals.ledger
        : buildRelationshipLedger(timelineMessages, meetingsInput, nowMs, {
            name: person.name,
            tier: person.relationship_tier,
            relationshipState: person.relationship_state,
          });

    // Last 3 direct exchanges (chronological order for readability)
    const sortedPast = [...timelineMessages]
      .filter((m) => {
        const ms = Date.parse(m.occurred_at);
        return Number.isFinite(ms) && ms <= nowMs;
      })
      .sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));

    const last_exchanges: PersonPrepPack["last_exchanges"] = sortedPast.slice(-3).map((m) => ({
      channel: cleanStr(m.channel || "direct", 24),
      sender: cleanStr(m.sender || (isOutboundMessage(m) ? "You" : person.name), 60),
      direction: isOutboundMessage(m) ? "out" : "in",
      occurred_at: m.occurred_at,
      text: cleanStr(m.text || "", 260),
    }));

    const inbound_asks = ledger.open_loops.filter((l) => l.kind === "inbound_ask");
    const owner_promises = ledger.open_loops.filter((l) => l.kind === "owner_promise");
    const card_loops = (wm?.open_loops || []).slice(0, 6).map((l) => ({
      loop: cleanStr(l.loop, 180),
      state: cleanStr(l.state || "open", 40),
      next_evidence: cleanStr(l.next_evidence || "", 140),
    }));

    // Active commitments from promises + card loops + owner notes
    const commitmentsSet = new Set<string>();
    const commitments: string[] = [];
    const pushCommit = (val: string) => {
      const c = cleanStr(val, 180);
      if (!c) return;
      const norm = c.toLowerCase();
      if (commitmentsSet.has(norm)) return;
      commitmentsSet.add(norm);
      commitments.push(c);
    };
    for (const p of owner_promises) {
      pushCommit(`Follow through (${p.channel}, ${formatWaitBrief(p.ageHours)} ago): ${p.excerpt}`);
    }
    for (const cl of card_loops) {
      if (!/closed|done|resolved/i.test(cl.state)) {
        pushCommit(`${cl.loop}${cl.state ? ` [${cl.state}]` : ""}`);
      }
    }
    for (const note of wm?.owner_notes || []) {
      if (note.kind === "open_loop" || /\b(commit|promise|follow up|deliver)\b/i.test(note.text)) {
        pushCommit(note.text);
      }
    }

    // Shared Agent Board threads (fail-safe)
    let shared_board_threads: PersonPrepPack["shared_board_threads"] = [];
    if (this.boardBridge && typeof this.boardBridge.getEntityThreads === "function") {
      try {
        const res = await this.boardBridge.getEntityThreads("person", person.key, 6);
        const threads = Array.isArray(res?.threads) ? res.threads : [];
        shared_board_threads = threads.slice(0, 6).map((t) => ({
          id: String(t.id ?? t.thread_id ?? ""),
          channel: cleanStr(t.channel || "board", 40),
          title: cleanStr(t.title || t.preview || "Board thread", 110),
          summary: cleanStr(t.summary || t.body || t.preview || "", 180),
          author: cleanStr(t.author || "agent", 50),
          created_at: String(t.created_at || t.updated_at || ""),
        }));
      } catch {
        shared_board_threads = [];
      }
    }

    // Live claims added since last past meeting (or latest 6 claims)
    const pastMeetings = (dossier.past_meetings || []).filter((m) => Number.isFinite(Date.parse(m.start)));
    const lastMeetingMs =
      pastMeetings.length > 0
        ? Math.max(...pastMeetings.map((m) => Date.parse(m.start)))
        : 0;
    const allClaims = Array.isArray(dossier.sqlite_claims) ? dossier.sqlite_claims : [];
    const claimsSinceMeeting =
      lastMeetingMs > 0
        ? allClaims.filter((c) => {
            const ms = Date.parse(c.created_at);
            return Number.isFinite(ms) && ms >= lastMeetingMs;
          })
        : [];
    const selectedClaims = (claimsSinceMeeting.length > 0 ? claimsSinceMeeting : allClaims).slice(0, 6);
    const recent_claims: PersonPrepPack["recent_claims"] = selectedClaims.map((c) => ({
      id: String(c.id || ""),
      kind: cleanStr(c.kind || "claim", 40),
      text: cleanStr(c.text || "", 200),
      created_at: String(c.created_at || ""),
      confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 0.7,
    }));

    const upcoming_meetings: PersonPrepPack["upcoming_meetings"] = (dossier.meetings || [])
      .filter((m) => m.is_upcoming)
      .slice(0, 4)
      .map((m) => ({
        title: cleanStr(m.title, 100),
        start: m.start,
        countdown: cleanStr(m.countdown || formatCountdownBrief(Date.parse(m.start) - nowMs), 40),
      }));

    const openers = buildTailoredOpeners({
      name: person.name,
      ledger,
      lastExchanges: last_exchanges,
      upcomingMeetings: upcoming_meetings,
      recentClaims: recent_claims,
      sharedThreads: shared_board_threads,
      org: person.org,
    });

    return {
      ok: true,
      local_only: true,
      generated_at: new Date(nowMs).toISOString(),
      person: {
        key: person.key,
        name: cleanStr(person.name, 80),
        tier: displayTierLabel(person.relationship_tier, person.profile_tier),
        role: cleanStr(person.role || wm?.role || "", 80),
        org: cleanStr(person.org || wm?.org || "", 80),
        channels: person.channels || [],
      },
      ledger,
      last_exchanges,
      open_loops: {
        inbound_asks,
        owner_promises,
        card_loops,
      },
      commitments: commitments.slice(0, 8),
      shared_board_threads,
      recent_claims,
      upcoming_meetings,
      openers,
    };
  }
}
