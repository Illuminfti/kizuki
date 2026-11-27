import type {
  NextMove,
  NextMoveEvidence,
  NextMoveVerb,
  NextMovesResponse,
  PendingDecisionGate,
  PeopleRadarEntry,
} from "./contracts.ts";
import { stripEmDashes } from "./agent-board-api.ts";
import type {
  OwnerAction,
  PersonDirectoryItem,
  TodayInboxItem,
  TodayResponse,
  TodayScheduleItem,
} from "./vault-api.ts";

export interface BuildNextMovesContext {
  nowMs?: number;
  today?: Partial<TodayResponse> | null;
  pendingDecisions?: PendingDecisionGate[];
  people?: PersonDirectoryItem[];
  driftAlerts?: PeopleRadarEntry[];
  hiddenMoveIds?: Set<string> | ReadonlySet<string>;
  maxMoves?: number;
}

const BOT_OR_GROUP_NOISE_PATTERNS: RegExp[] = [
  /\bgroup\s+help\b/i,
  /\bcaptcha\b/i,
  /\bpress\s+the\s+button\b/i,
  /\bverify\s+(?:you\s+are\s+human|within|now|below)\b/i,
  /\bfactorydao\b/i,
  /\bnft\s+wg\b/i,
  /\bwatcher\s+guru\b/i,
  /\bmissrose\b/i,
  /\bcombot\b/i,
  /\bshieldy\b/i,
  /\bgroup\s+butler\b/i,
  /\bwelcome\s+to\s+the\s+group\b/i,
  /\bjoined\s+the\s+group\b/i,
  /\bwithin\s+\d+\s+minutes?\b/i,
  /\bno-?reply\b/i,
  /\bmailer-daemon\b/i,
  /\bunsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bnotifications?@\b/i,
  /\bautomated\s+(?:message|alert|notification)\b/i,
  /\btrading\s+signals?\b/i,
  /\bairdrop\b/i,
  /\bpromo(?:tion)?\b/i,
  /(?:^|[\s_\-[\]()])bot(?:$|[\s_\-[\]().,:])/i,
];

const GROUP_TITLE_PATTERNS: RegExp[] = [
  /\b(?:wg|dao|working\s+group|announcements?|broadcast|channel|community|alerts?|signals?|news\s+feed|updates)\b/i,
  /\bgroup\s+help\b/i,
  /\bgroup\s+chat\b/i,
];

const OUTBOUND_SENDER_PATTERNS: RegExp[] = [
  /^you$/i,
  /^you\s*->/i,
  /^me$/i,
  /^self$/i,
  /^owner$/i,
];

const ASK_SIGNAL_RE =
  /\?|\b(can you|could you|would you|will you|please|let me know|lmk|thoughts|what do you think|are you|do you|did you|have you|confirm|approve|send over|hop on|call me|free today|free tomorrow|rsvp|urgent|asap|waiting on|need your|check this|quick question|when can|should we)\b/i;

function cleanLine(input: unknown, maxLen = 200): string {
  const s = stripEmDashes(String(input ?? ""))
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, Math.max(0, maxLen - 3));
  const sp = cut.lastIndexOf(" ");
  const out = sp > maxLen * 0.55 ? cut.slice(0, sp) : cut;
  return `${out.replace(/[,;:.\s-]+$/, "")}...`;
}

export function formatAgeCompact(ageHours: number): string {
  const h = Math.max(0, Number(ageHours) || 0);
  if (h < 1) {
    const mins = Math.max(1, Math.round(h * 60));
    return `${mins}m`;
  }
  if (h < 48) {
    const whole = Math.floor(h);
    const mins = Math.round((h - whole) * 60);
    if (whole >= 10 || mins === 0) return `${whole}h`;
    return `${whole}h ${mins}m`;
  }
  const days = Math.floor(h / 24);
  const remH = Math.round(h - days * 24);
  return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
}

function normalizeLookup(raw: unknown): string {
  return stripEmDashes(String(raw ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isOutboundSender(sender: string): boolean {
  const s = stripEmDashes(sender || "").trim();
  if (!s) return false;
  for (let i = 0; i < OUTBOUND_SENDER_PATTERNS.length; i += 1) {
    if (OUTBOUND_SENDER_PATTERNS[i].test(s)) return true;
  }
  return false;
}

export function isBotOrGroupNoiseThread(
  item: Pick<
    TodayInboxItem,
    "channel" | "thread_key" | "sender" | "thread_title" | "preview" | "full_text" | "is_noise"
  > & { is_group?: boolean },
): boolean {
  if (item.is_noise) return true;
  if (item.is_group === true) return true;

  const keyLow = String(item.thread_key || "").toLowerCase();
  if (
    keyLow.includes("@g.us") ||
    keyLow.includes(":group:") ||
    keyLow.includes("group_") ||
    keyLow.includes("channel:") ||
    keyLow.includes("bot:")
  ) {
    return true;
  }

  const sender = stripEmDashes(item.sender || "").trim();
  const title = stripEmDashes(item.thread_title || "").trim();
  const body = stripEmDashes(`${item.preview || ""} ${item.full_text || ""}`).trim();
  const combined = `${sender} ${title} ${body}`;

  for (let i = 0; i < BOT_OR_GROUP_NOISE_PATTERNS.length; i += 1) {
    if (BOT_OR_GROUP_NOISE_PATTERNS[i].test(combined)) {
      return true;
    }
  }

  // Telegram / WhatsApp group header pattern: "Group Help · NFT WG" or group title != sender
  if (
    (item.channel === "telegram" || item.channel === "whatsapp") &&
    title.includes("\u00b7")
  ) {
    const parts = title.split("\u00b7").map((p) => p.trim());
    if (parts.length >= 2) {
      for (const p of parts) {
        if (GROUP_TITLE_PATTERNS.some((re) => re.test(p))) return true;
      }
      // In Telegram bridges, "Sender · Group Name" indicates a multi-person group chat
      if (item.channel === "telegram") return true;
    }
  }

  if (GROUP_TITLE_PATTERNS.some((re) => re.test(title) || re.test(sender))) {
    return true;
  }

  // If WhatsApp or Telegram thread title differs significantly from sender and is not a phone number,
  // it is typically a group chat rather than a 1:1 DM.
  if (
    (item.channel === "telegram" || item.channel === "whatsapp") &&
    sender &&
    title &&
    !/^[+\d\s()-]{6,}$/.test(title) &&
    !/^[+\d\s()-]{6,}$/.test(sender)
  ) {
    const ns = normalizeLookup(sender);
    const nt = normalizeLookup(title);
    if (ns && nt && ns !== nt && !nt.includes(ns) && !ns.includes(nt)) {
      return true;
    }
  }

  return false;
}

function buildPeopleLookup(people: PersonDirectoryItem[]): Map<string, PersonDirectoryItem> {
  const map = new Map<string, PersonDirectoryItem>();
  for (let i = 0; i < people.length; i += 1) {
    const p = people[i];
    if (!p) continue;
    const keys = [
      p.key,
      normalizeLookup(p.key),
      normalizeLookup(p.name),
    ];
    for (const k of keys) {
      if (k && !map.has(k)) {
        map.set(k, p);
      }
    }
    const firstToken = normalizeLookup(p.name).split(" ")[0];
    if (firstToken && firstToken.length >= 4 && !map.has(`first:${firstToken}`)) {
      map.set(`first:${firstToken}`, p);
    }
  }
  return map;
}

function matchPersonForInbox(
  item: TodayInboxItem,
  peopleLookup: Map<string, PersonDirectoryItem>,
): PersonDirectoryItem | null {
  const candidates = [
    normalizeLookup(item.sender),
    normalizeLookup(item.thread_title),
  ];
  for (const c of candidates) {
    if (!c) continue;
    const exact = peopleLookup.get(c);
    if (exact) return exact;
  }
  for (const c of candidates) {
    if (!c) continue;
    const first = c.split(" ")[0];
    if (first && first.length >= 4) {
      const m = peopleLookup.get(`first:${first}`);
      if (m) return m;
    }
  }
  return null;
}

function resolveTierWeight(person: PersonDirectoryItem | null): {
  weight: number;
  label: string;
} {
  if (!person) return { weight: 1.0, label: "1:1" };
  const tier = String(person.relationship_tier || "").trim();
  if (tier === "Family") return { weight: 3.0, label: "Family" };
  if (tier === "Core") return { weight: 2.3, label: "Core" };
  if (
    person.profile_tier === "v2" ||
    person.profile_tier === "lifeos" ||
    tier === "Active"
  ) {
    return { weight: 1.5, label: "Profiled" };
  }
  return { weight: 1.0, label: "1:1" };
}

function scoreDecisionGate(gate: PendingDecisionGate): NextMove | null {
  if (gate.stamped) return null;
  const ageHours = Math.max(0, (Number(gate.ageMs) || 0) / 3_600_000);
  const blockedCount = Math.max(1, Number(gate.blockedCount) || 1);
  const hasRec = Boolean(gate.recommendation && gate.recommendation.trim());
  const chLow = String(gate.channel || "").toLowerCase();
  const isDecisionChannel =
    chLow.includes("decision") || chLow.includes("escalation") || chLow.includes("approval");

  const score = Math.round(
    (85 +
      Math.min(75, ageHours * 2.2) +
      Math.min(35, blockedCount * 8) +
      (hasRec ? 12 : 0) +
      (isDecisionChannel ? 10 : 0)) *
      10,
  ) / 10;

  const ageStr = formatAgeCompact(ageHours);
  const blockedPhrase =
    blockedCount > 1 ? ` blocking ${blockedCount} downstream items` : "";
  const recPhrase = hasRec
    ? " Agent recommendation ready for 1-key stamp."
    : " Waiting on your owner verdict.";

  const whyNow = cleanLine(
    `Blocked ${ageStr} in #${gate.channel}${blockedPhrase}.${recPhrase}`,
    220,
  );

  const evidence: NextMoveEvidence[] = [
    { label: `#${gate.threadId} in #${gate.channel}`, kind: "board", ref: gate.threadId },
    { label: `waiting ${ageStr}`, kind: "board", ref: gate.threadId },
  ];
  if (gate.author) {
    evidence.push({ label: `by ${cleanLine(gate.author, 32)}`, kind: "board", ref: gate.threadId });
  }
  if (blockedCount > 1) {
    evidence.push({ label: `${blockedCount} blocked`, kind: "board", ref: gate.threadId });
  }

  const verbs: NextMoveVerb[] = ["approve", "revise", "defer", "snooze", "dismiss"];

  return {
    id: `decision:${gate.threadId}`,
    kind: "decision",
    title: cleanLine(gate.title || `Decision #${gate.threadId}`, 130),
    why_now: whyNow,
    evidence,
    score,
    verbs,
    target: {
      threadId: gate.threadId,
      channel: gate.channel,
    },
    ageHours: Math.round(ageHours * 10) / 10,
    ...(hasRec ? { recommendation: cleanLine(gate.recommendation, 260) } : {}),
  };
}

function scoreReplyOwedThread(
  item: TodayInboxItem,
  nowMs: number,
  peopleLookup: Map<string, PersonDirectoryItem>,
): NextMove | null {
  if (isBotOrGroupNoiseThread(item)) return null;
  if (isOutboundSender(item.sender)) return null;

  const occurredMs = Date.parse(item.occurred_at || "");
  if (!Number.isFinite(occurredMs)) return null;
  const ageHours = Math.max(0.05, (nowMs - occurredMs) / 3_600_000);

  // Skip ancient inbox threads (>14 days) so Today stays sharp and actionable
  if (ageHours > 24 * 14) return null;

  const person = matchPersonForInbox(item, peopleLookup);
  const { weight: tierWeight, label: tierLabel } = resolveTierWeight(person);
  const contentSample = `${item.preview || ""} ${item.full_text || ""}`;
  const hasAsk = ASK_SIGNAL_RE.test(contentSample);
  const askMultiplier = hasAsk ? 1.45 : 1.0;

  // Age rises sharply over the first 48h, then saturates gracefully
  const cappedHours = Math.min(96, ageHours);
  const ageFactor = Math.min(36, 4 + Math.sqrt(cappedHours) * 4.8);
  const score = Math.round((28 + Math.min(105, ageFactor * tierWeight * askMultiplier)) * 10) / 10;

  const displayName = cleanLine(person?.name || item.sender || item.thread_title || "Contact", 60);
  const channelLabel = cleanLine(item.channel_label || item.channel || "Message", 24);
  const ageStr = formatAgeCompact(ageHours);
  const snippet = cleanLine(item.preview || item.thread_title || "", 120);

  const whyNow = hasAsk
    ? cleanLine(
        `${tierLabel} contact ${displayName} asked on ${channelLabel} ${ageStr} ago with no reply yet.`,
        210,
      )
    : cleanLine(
        `${tierLabel} contact ${displayName} messaged on ${channelLabel} ${ageStr} ago and awaits your reply.`,
        210,
      );

  const evidence: NextMoveEvidence[] = [
    { label: channelLabel, kind: "message", ref: item.thread_key },
    { label: `${tierLabel} contact`, kind: "person", ref: person?.key || displayName },
    { label: `${ageStr} waiting`, kind: "message", ref: item.thread_key },
  ];
  if (hasAsk) {
    evidence.push({ label: "unanswered ask", kind: "message", ref: item.thread_key });
  }
  if (snippet) {
    evidence.push({ label: `"${cleanLine(snippet, 64)}"`, kind: "message", ref: item.thread_key });
  }

  const title =
    item.channel === "gmail" && item.thread_title && item.thread_title !== "(No subject)"
      ? cleanLine(`Reply to ${displayName}: ${item.thread_title}`, 130)
      : cleanLine(`Reply to ${displayName} (${channelLabel})`, 130);

  const verbs: NextMoveVerb[] = ["draft_reply", "make_action", "snooze", "dismiss"];

  return {
    id: `reply:${item.thread_key || item.id}`,
    kind: "reply_owed",
    title,
    why_now: whyNow,
    evidence,
    score,
    verbs,
    target: {
      personKey: person?.key,
      threadId: item.thread_key || item.id,
      channel: item.channel,
    },
    ageHours: Math.round(ageHours * 10) / 10,
  };
}

function scoreMeetingPrep(ev: TodayScheduleItem, nowMs: number): NextMove | null {
  const startMs = Date.parse(ev.start || "");
  if (!Number.isFinite(startMs)) return null;
  const diffMin = (startMs - nowMs) / 60_000;
  // Starting within 90 minutes (or just started within last 10m)
  if (diffMin < -10 || diffMin > 90) return null;

  const existingNotes = stripEmDashes(ev.notes || ev.body || "").trim();
  const hasPrep =
    existingNotes.length >= 60 &&
    /\b(prep|agenda|talking points|goals|context|brief)\b/i.test(existingNotes);
  if (hasPrep) return null;

  const minsUntil = Math.max(0, Math.round(diffMin));
  const score = Math.round((92 + Math.max(0, (90 - minsUntil) * 0.55)) * 10) / 10;

  const participants = Array.isArray(ev.participants)
    ? ev.participants.map((p) => cleanLine(p, 40)).filter(Boolean)
    : [];
  const withPhrase =
    participants.length > 0 ? ` with ${participants.slice(0, 3).join(", ")}` : "";
  const timingPhrase = minsUntil <= 1 ? "Starting now" : `Starts in ${minsUntil}m`;

  const whyNow = cleanLine(
    `${timingPhrase}${withPhrase} and has no prep brief attached yet.`,
    210,
  );

  const evidence: NextMoveEvidence[] = [
    { label: cleanLine(ev.calendar || "Calendar", 32), kind: "meeting", ref: ev.id },
    { label: minsUntil <= 1 ? "starting now" : `in ${minsUntil}m`, kind: "meeting", ref: ev.id },
  ];
  if (participants.length > 0) {
    evidence.push({
      label: `${participants.length} participant${participants.length === 1 ? "" : "s"}`,
      kind: "meeting",
      ref: ev.id,
    });
  }

  const verbs: NextMoveVerb[] = ["prep", "make_action", "snooze", "dismiss"];

  return {
    id: `meeting:${ev.id}`,
    kind: "meeting_prep",
    title: cleanLine(`Prep: ${ev.title || "Upcoming meeting"}`, 130),
    why_now: whyNow,
    evidence,
    score,
    verbs,
    target: {
      meetingId: ev.id,
    },
    ageHours: Math.round((minsUntil / 60) * 100) / 100,
  };
}

function scoreDegradedPipelines(today: Partial<TodayResponse> | null | undefined): NextMove | null {
  const summary = today?.summary;
  if (!summary) return null;
  const active = Number(summary.active_pipelines);
  const total = Number(summary.total_pipelines);
  if (!Number.isFinite(active) || !Number.isFinite(total) || total <= 0 || active >= total) {
    return null;
  }
  const degraded = total - active;
  const score = Math.round((62 + Math.min(30, degraded * 9)) * 10) / 10;
  const whyNow = cleanLine(
    `${degraded} of ${total} Mind OS ingestion pipelines are degraded or offline (${active}/${total} active).`,
    210,
  );

  const verbs: NextMoveVerb[] = ["make_action", "snooze", "dismiss"];

  return {
    id: `pipeline:degraded:${active}-of-${total}`,
    kind: "pipeline_alert",
    title: `${degraded} pipeline${degraded === 1 ? "" : "s"} degraded (${active}/${total} active)`,
    why_now: whyNow,
    evidence: [
      { label: `${active}/${total} active`, kind: "pipeline" },
      { label: `${degraded} degraded`, kind: "pipeline" },
    ],
    score,
    verbs,
  };
}

function scoreDueAction(action: OwnerAction, nowMs: number): NextMove | null {
  if (!action || action.done) return null;
  const createdMs = Date.parse(action.created_at || "");
  const ageHours = Number.isFinite(createdMs)
    ? Math.max(0.1, (nowMs - createdMs) / 3_600_000)
    : 1;
  const tagBonus = action.tag === "Family" || action.tag === "Reply" ? 10 : 0;
  const score = Math.round((52 + Math.min(28, ageHours * 0.6) + tagBonus) * 10) / 10;

  const ageStr = formatAgeCompact(ageHours);
  const detailText = cleanLine(action.detail || "", 95);
  const whyNow = detailText
    ? cleanLine(`Open ${action.tag || "Work"} action (${ageStr} old): ${detailText}`, 210)
    : cleanLine(`Open ${action.tag || "Work"} action captured ${ageStr} ago awaiting execution.`, 210);

  const verbs: NextMoveVerb[] = ["prep", "snooze", "dismiss"];

  return {
    id: `action:${action.id}`,
    kind: "action_due",
    title: cleanLine(action.title || "Open action", 130),
    why_now: whyNow,
    evidence: [
      { label: cleanLine(action.tag || "Work", 24), kind: "action", ref: action.id },
      { label: `open ${ageStr}`, kind: "action", ref: action.id },
    ],
    score,
    verbs,
    target: {
      actionId: action.id,
    },
    ageHours: Math.round(ageHours * 10) / 10,
  };
}

function scoreDriftAlert(entry: PeopleRadarEntry): NextMove | null {
  if (!entry || !entry.key || !entry.name) return null;
  const driftZ = Number(entry.drift_z ?? 2.0);
  const tierBonus = entry.tier === "Family" ? 14 : entry.tier === "Core" ? 8 : 0;
  const score = Math.round((56 + Math.min(32, Math.max(0, driftZ) * 9) + tierBonus) * 10) / 10;

  const reason = cleanLine(
    entry.reason || `cadence gap drift z=${driftZ.toFixed(1)}`,
    140,
  );
  const whyNow = cleanLine(
    `${entry.tier || "Core"} contact ${entry.name} is drifting: ${reason}.`,
    210,
  );

  const evidence: NextMoveEvidence[] = [
    { label: `${entry.tier || "Core"} contact`, kind: "person", ref: entry.key },
    { label: `drift z=${driftZ.toFixed(1)}`, kind: "person", ref: entry.key },
  ];
  for (const evLine of Array.isArray(entry.evidence) ? entry.evidence.slice(0, 2) : []) {
    const cleanEv = cleanLine(evLine, 70);
    if (cleanEv) evidence.push({ label: cleanEv, kind: "person", ref: entry.key });
  }

  const verbs: NextMoveVerb[] = ["draft_reply", "prep", "snooze", "dismiss"];

  return {
    id: `drift:${entry.key}`,
    kind: "drift_alert",
    title: cleanLine(`Reconnect with ${entry.name}`, 130),
    why_now: whyNow,
    evidence,
    score,
    verbs,
    target: {
      personKey: entry.key,
    },
    ...(entry.ageHours !== undefined ? { ageHours: entry.ageHours } : {}),
  };
}

function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : pluralForm || `${singular}s`}`;
}

function buildLede(moves: NextMove[], counts: NextMovesResponse["counts"]): string {
  if (moves.length === 0) {
    return "All owner decision gates, 1:1 replies, and 90m meeting preps are clear.\nPress A to capture a new action or inspect the Today triage queue.";
  }
  const top = moves[0];
  const line1 = cleanLine(`Top move: ${top.title}. ${top.why_now}`, 220);

  const parts: string[] = [];
  if (counts.decisions > 0) parts.push(plural(counts.decisions, "decision gate"));
  if (counts.replies_owed > 0) parts.push(plural(counts.replies_owed, "human reply owed", "human replies owed"));
  if (counts.meetings_soon > 0) parts.push(plural(counts.meetings_soon, "meeting in 90m", "meetings in 90m"));
  if (counts.drifting > 0) parts.push(plural(counts.drifting, "drifting contact"));
  if (counts.pipelines_degraded > 0) parts.push(plural(counts.pipelines_degraded, "degraded pipeline"));
  if (counts.actions_due > 0) parts.push(plural(counts.actions_due, "open action"));

  const line2 =
    parts.length > 0
      ? cleanLine(`Queue: ${parts.join(", ")}.`, 200)
      : "Press 1-5 to focus a move and act with a single key.";

  return stripEmDashes(`${line1}\n${line2}`);
}

export function buildNextMoves(ctx: BuildNextMovesContext): NextMovesResponse {
  const nowMs = ctx.nowMs ?? Date.now();
  const maxMoves = Math.max(1, Math.min(20, Number(ctx.maxMoves ?? 5) || 5));
  const hidden = ctx.hiddenMoveIds ?? new Set<string>();
  const peopleLookup = buildPeopleLookup(Array.isArray(ctx.people) ? ctx.people : []);

  const candidates: NextMove[] = [];
  const seenIds = new Set<string>();

  const pushCandidate = (move: NextMove | null): void => {
    if (!move) return;
    if (hidden.has(move.id)) return;
    if (seenIds.has(move.id)) return;
    seenIds.add(move.id);
    candidates.push(move);
  };

  // 1. Owner decision gates
  for (const gate of Array.isArray(ctx.pendingDecisions) ? ctx.pendingDecisions : []) {
    pushCandidate(scoreDecisionGate(gate));
  }

  // 2. 1:1 human reply-owed threads
  for (const item of Array.isArray(ctx.today?.inbox) ? ctx.today!.inbox! : []) {
    pushCandidate(scoreReplyOwedThread(item, nowMs, peopleLookup));
  }

  // 3. Meetings starting within 90m with no prep
  for (const ev of Array.isArray(ctx.today?.schedule) ? ctx.today!.schedule! : []) {
    pushCandidate(scoreMeetingPrep(ev, nowMs));
  }

  // 4. Degraded pipelines
  pushCandidate(scoreDegradedPipelines(ctx.today));

  // 5. Open / due actions
  for (const act of Array.isArray(ctx.today?.actions) ? ctx.today!.actions! : []) {
    pushCandidate(scoreDueAction(act, nowMs));
  }

  // 6. Optional C3 relationship drift alerts
  for (const drift of Array.isArray(ctx.driftAlerts) ? ctx.driftAlerts : []) {
    pushCandidate(scoreDriftAlert(drift));
  }

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ageA = a.ageHours ?? 0;
    const ageB = b.ageHours ?? 0;
    if (ageB !== ageA) return ageB - ageA;
    return a.id.localeCompare(b.id);
  });

  const counts: NextMovesResponse["counts"] = {
    decisions: 0,
    replies_owed: 0,
    meetings_soon: 0,
    drifting: 0,
    pipelines_degraded: 0,
    actions_due: 0,
  };

  for (let i = 0; i < candidates.length; i += 1) {
    const kind = candidates[i].kind;
    if (kind === "decision") counts.decisions += 1;
    else if (kind === "reply_owed") counts.replies_owed += 1;
    else if (kind === "meeting_prep") counts.meetings_soon += 1;
    else if (kind === "drift_alert") counts.drifting += 1;
    else if (kind === "pipeline_alert") counts.pipelines_degraded += 1;
    else if (kind === "action_due") counts.actions_due += 1;
  }

  const moves = candidates.slice(0, maxMoves);

  return {
    generated_at: new Date(nowMs).toISOString(),
    moves,
    counts,
    lede: buildLede(moves, counts),
  };
}
