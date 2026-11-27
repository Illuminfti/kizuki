import { Database } from "bun:sqlite";
import { open, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  buildStrongPersonSearchTerms,
  createCanonicalCardMatcher,
  loadCanonicalPersonCards,
  type CanonicalPersonCard,
  type ProfileTier,
  type RelationshipTier,
} from "./people-intel.ts";

export type WorkerInboxChannel = "whatsapp" | "imessage" | "gmail" | "telegram";

export interface WorkerParsedPersonalMessage {
  id: string;
  channel: WorkerInboxChannel;
  channel_label: string;
  thread_key: string;
  sender: string;
  thread_title: string;
  preview: string;
  full_text: string;
  occurred_at: string;
  is_noise: boolean;
}

export interface WorkerTodayInboxItem {
  id: string;
  channel: WorkerInboxChannel;
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

export interface WorkerParsedCalendarEvent {
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

export interface WorkerPersonNextMeeting {
  title: string;
  start_iso: string;
  countdown: string;
  meet_url: string | null;
}

export interface WorkerWhoopSummary {
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

export interface WorkerPersonIndexRecord {
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
  next_meeting: WorkerPersonNextMeeting | null;
  is_group: boolean;
  timeline: Array<{
    id: string;
    channel: string;
    sender: string;
    occurred_at: string;
    text: string;
  }>;
  meetings: WorkerParsedCalendarEvent[];
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

export interface WorkerPersonalIndexSnapshot {
  builtAt: number;
  messages: WorkerParsedPersonalMessage[];
  inboxThreads: WorkerTodayInboxItem[];
  calendar: WorkerParsedCalendarEvent[];
  whoop: WorkerWhoopSummary;
  peopleList: WorkerPersonIndexRecord[];
  peopleByKey: Map<string, WorkerPersonIndexRecord>;
  cardMergeMap: Map<string, string>;
}

export interface PersonalIndexWorkerConfig {
  vaultPath: string;
  dbPath: string;
  bridgesDir: string;
  lifeosPeopleDir: string | null;
  relationshipsDir: string | null;
}

const SECRET_PATH_RE =
  /(^|\/)(\.env(\..*)?|\.git-credentials|agent-credentials|credentials\.json|secrets?|id_rsa|id_ed25519|.*\.pem|.*\.key|.*\.p12|.*\.pfx|.*\.db(-wal|-shm)?)$/i;

const GENERIC_CLAIM_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "you",
  "owner",
  "boss",
  "wife",
  "mother",
  "father",
  "sister",
  "brother",
  "contact",
  "unknown",
  "person",
  "user",
  "team",
  "chat",
  "group",
  "death",
  "cat",
  "alex",
  "sam",
  "max",
  "ben",
  "dan",
  "tom",
  "tim",
  "jon",
  "joe",
  "jay",
  "ash",
  "ali",
  "eli",
  "ian",
  "leo",
  "kai",
  "ray",
  "rob",
  "ron",
  "roy",
  "guy",
  "van",
  "der",
  "not",
  "new",
  "one",
  "two",
]);

const FICTIONAL_NOISE_RE =
  /professor david sterling|david sterling|autonovel|oral-history novel|the economist.*london school of economics|dr\.\s*sarah chen|fiction-judging/i;

const COMMERCIAL_PROMO_SENDER_RE =
  /(?:^|[\s<"'(@.-])(?:hello@|news@|newsletter@|marketing@|noreply@|no-reply@|donotreply|info@|digest@|updates@|notifications?@|store@|shop@|promo@|offers@|deals@|team@|support@|billing@|receipts@|mail@|mailer-daemon|merlin|houseofspoils|house\s+of\s+spoils|agents\s+unleashed|luma-mail\.com|substack|beehiiv|mailchimp|klaviyo|sendgrid|shopify|amazon|deliveroo|uber|kidoriman|linkedin\.com|medium\.com|trends\.vc|m\.redstone\.finance|vercel\.com|linear\.app|github\.com|revolut\.com)/i;

const COMMERCIAL_PROMO_CONTENT_RE =
  /(?:available\s+now|from\s+just\s+[£$]\d|annual\s+pass|unsubscribe|view\s+(?:this\s+email\s+)?in\s+(?:your\s+)?browser|manage\s+(?:your\s+email\s+)?preferences|limited\s+time|shop\s+now|claim\s+your|save\s+up\s+to|\d+\s*%\s*off|pre-?order|gift\s+christmas|november['’]s\s+most\s+wanted|someone\s+at\s+.+\s+you\s+may\s+know|report\s+#\d+|tokenized\s+stocks\s+digest|new\s+project\s+available\s+to\s+import|pr\s+run\s+failed|run\s+failed:|linear\s+checks\s+failed|weekly\s+digest|you\s+are\s+receiving\s+.*\s+notification\s+emails)/i;

function stripEmDashes(text: string): string {
  return text.replace(/\u2014/g, " - ").replace(/\u2013/g, "-");
}

function scrubOAuthUrls(text: string): string {
  return text
    .replace(/([?&](?:code|token|access_token|refresh_token|id_token|state|auth|key|sig|signature|secret)=)[^&\s#]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{16,}/gi, "$1[REDACTED]");
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

function cleanDisplayText(raw: string): string {
  if (!raw) return "";
  let s = stripEmDashes(String(raw)).replace(/\r\n?/g, "\n");
  s = s.replace(/<(?:#\/?|\/#)(?:part|multipart)[^>]*>/gi, "");
  s = s.replace(
    /^(?:Content-Type|Content-Transfer-Encoding|Content-Disposition|MIME-Version|Message-ID|X-[A-Za-z0-9-]+):\s*.*$/gim,
    ""
  );
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(?:p|div|li|tr|h[1-6]|blockquote)>/gi, "\n");
  s = s.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s+[^>]*)?\s*\/?>/g, "");
  s = decodeHtmlEntities(s);
  s = scrubOAuthUrls(s);
  s = s.replace(/<?https?:\/\/[^\s<>]*\[REDACTED_LONG_TOKEN\][^\s<>]*>?/gi, "");
  s = s.replace(/\[REDACTED_LONG_TOKEN\]/gi, "");
  s = s.replace(
    /<?https?:\/\/(?:www\.google\.com\/url\?|click\.|links\.|track\.|email\.|mandrillapp\.com|sendgrid\.net|list-manage\.com|substack\.com\/redirect|t\.co\/)[^\s<>]{40,}>?/gi,
    ""
  );
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

function cleanEmailDisplayBody(raw: string): string {
  if (!raw) return "";
  const s = stripEmDashes(String(raw)).replace(/\r\n?/g, "\n");
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
  return cleanDisplayText(lines.slice(startIdx).join("\n"));
}

function parseCalendarBody(
  raw: string,
  eventTitle?: string
): { meet_url: string | null; dial_in: string | null; notes: string; location: string | null } {
  const src = stripEmDashes(String(raw || "")).replace(/\r\n?/g, "\n");

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

  let dial_in: string | null = null;
  const dialMatch =
    src.match(/(?:Or\s+dial|Dial(?:-in)?)\s*:\s*([^\n]+)/i) ||
    src.match(/(\([A-Z]{2}\)\s*\+[\d\s()-]{6,}(?:\s*PIN:\s*[\d\s#]+)?)/i);
  if (dialMatch && dialMatch[1]) {
    dial_in = cleanDisplayText(dialMatch[1]).replace(/\s+/g, " ").trim() || null;
  }

  let location: string | null = null;
  const locMatch = src.match(/^Location:\s*(.+)$/im);
  if (locMatch && locMatch[1]) {
    const cand = cleanDisplayText(locMatch[1]).trim();
    if (cand && !/google meet|instructions in description|web conference/i.test(cand)) {
      location = cand;
    }
  }

  let body = src
    .replace(/-::~:~:[\s\S]*?(?::-::~:~::-|::~:~::-|$)/gi, "\n")
    .replace(/^[^\n]*-::~:~:[^\n]*$/gim, "")
    .replace(/^Join with Google Meet:.*$/gim, "")
    .replace(/^Or dial:.*$/gim, "")
    .replace(/^More phone numbers:.*$/gim, "")
    .replace(/^Learn more about Meet at:.*$/gim, "")
    .replace(/^Please do not edit this section\.?.*$/gim, "");

  body = body.replace(
    /^(?:Calendar|Start|End|Recurring|Recurrence|Participants|Attendees|Location|Organizer|Status):\s*.*$/gim,
    ""
  );

  body = cleanDisplayText(body);

  const normTitle = (eventTitle || "").toLowerCase().replace(/^#+\s*/, "").replace(/\s+/g, " ").trim();
  const bodyLines = body.split("\n");
  const keptLines: string[] = [];
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
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

function isNoiseMessage(opts: {
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

function normalizeBridgeTimestamp(raw: unknown, fallbackIso: string): string {
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

function normalizePersonKey(raw: string): string {
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

function isSelfIdentity(nameOrAddr: string): boolean {
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

function parseEmailAddressField(raw: string): { name: string; email: string } {
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

function computeInitials(name: string): string {
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

function isNoisyGroupSnippet(snippet: string): boolean {
  return /^\[(?:NEAR Classic|Network Spotlight|Lit Builders|Sui Traders|Grind District)[^\]]*\]|\$Shade|Grind District|announcement post for more details/i.test(
    String(snippet || "")
  );
}

function isNoisyTelegramChannel(channel: string, threadTitle: string, sender: string): boolean {
  const hay = `${channel} ${threadTitle} ${sender}`.toLowerCase();
  if (
    /(?:^|[:_\s-])(sui-traders|lookonchain|dexscreener|cryptonear|soylana|all-street-bets|shitzu|lonkonnear|monad-cucks|sui-to-5|devnet-debauchery|solana-uk|stuk-members-lounge|ai-psychosis|theemptyboxclub|spidersjournal|jollycrates|tattothetoo|watcherguru|watcher\s+guru|whale[\s_-]*alert|coindesk|cointelegraph|decrypt|the\s+block|news[\s_-]*bot|just\s+in:|pump|airdrop|signals|alerts|whale|scanner|sniper|degen|traders|memecoin|broadcast|announcements?|botfather|cryptonews|coinmarketcap|coingecko)(?:$|[:_\s-])/i.test(
      hay
    )
  ) {
    return true;
  }
  const chSlug = channel.replace(/^telegram:/i, "").trim().toLowerCase();
  if (chSlug.endsWith("bot") || threadTitle.toLowerCase().endsWith("bot") || sender.toLowerCase().endsWith("bot")) {
    return true;
  }
  return false;
}

function formatRelativeAge(iso: string | null | undefined, nowMs = Date.now()): string {
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

function formatCountdown(startMs: number, endMs: number | null, nowMs: number): {
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

interface IncrementalJsonlState {
  ino: number;
  size: number;
  mtimeMs: number;
  committedByteOffset: number;
  committedCount: number;
}

interface IncrementalParsedCache<T> extends IncrementalJsonlState {
  committedItems: T[];
  pendingItem: T | null;
}

interface TelegramIncrementalCache extends IncrementalParsedCache<WorkerParsedPersonalMessage> {
  channelCounts: Map<string, number>;
  channelSenders: Map<string, Set<string>>;
  megaGroups: Set<string>;
}

interface WhoopIncrementalCache extends IncrementalJsonlState {
  latestRow: Record<string, unknown> | null;
  latestKey: string;
}

async function readTailBytes(filePath: string, offset: number, length: number): Promise<Buffer> {
  if (length <= 0) return Buffer.alloc(0);
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.allocUnsafe(length);
    let totalRead = 0;
    while (totalRead < length) {
      const { bytesRead } = await fh.read(buf, totalRead, length - totalRead, offset + totalRead);
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return totalRead === length ? buf : buf.subarray(0, totalRead);
  } finally {
    await fh.close();
  }
}

interface JsonlDeltaResult {
  reset: boolean;
  unchanged: boolean;
  ino: number;
  size: number;
  mtimeMs: number;
  committedByteOffset: number;
  committedDelta: Array<Record<string, unknown>>;
  pendingRow: Record<string, unknown> | null;
}

async function readJsonlIncrementalDelta(
  filePath: string,
  prev: IncrementalJsonlState | null
): Promise<JsonlDeltaResult | null> {
  if (SECRET_PATH_RE.test(filePath)) return null;
  let st;
  try {
    st = await stat(filePath);
  } catch {
    return null;
  }

  const ino = Number(st.ino || 0);
  const size = Number(st.size || 0);
  const mtimeMs = Number(st.mtimeMs || 0);

  if (prev && prev.ino === ino && prev.size === size && prev.mtimeMs === mtimeMs) {
    return {
      reset: false,
      unchanged: true,
      ino,
      size,
      mtimeMs,
      committedByteOffset: prev.committedByteOffset,
      committedDelta: [],
      pendingRow: null,
    };
  }

  const reset = !prev || prev.ino !== ino || size < prev.committedByteOffset;
  const startOffset = reset ? 0 : prev.committedByteOffset;
  const bytesToRead = size - startOffset;

  if (bytesToRead <= 0) {
    return {
      reset,
      unchanged: false,
      ino,
      size,
      mtimeMs,
      committedByteOffset: startOffset,
      committedDelta: [],
      pendingRow: null,
    };
  }

  const buf = await readTailBytes(filePath, startOffset, bytesToRead);
  const lastNewlineIdx = buf.lastIndexOf(0x0a); // '\n'

  let committedBuf: Buffer;
  let trailingBuf: Buffer;
  let nextCommittedOffset: number;

  if (lastNewlineIdx >= 0) {
    committedBuf = buf.subarray(0, lastNewlineIdx + 1);
    trailingBuf = buf.subarray(lastNewlineIdx + 1);
    nextCommittedOffset = startOffset + lastNewlineIdx + 1;
  } else {
    committedBuf = Buffer.alloc(0);
    trailingBuf = buf;
    nextCommittedOffset = startOffset;
  }

  const committedDelta: Array<Record<string, unknown>> = [];
  if (committedBuf.length > 0) {
    const text = committedBuf.toString("utf8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          committedDelta.push(obj as Record<string, unknown>);
        }
      } catch {
        // skip malformed line
      }
    }
  }

  let pendingRow: Record<string, unknown> | null = null;
  if (trailingBuf.length > 0) {
    const t = trailingBuf.toString("utf8").trim();
    if (t) {
      try {
        const obj = JSON.parse(t) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          pendingRow = obj as Record<string, unknown>;
        }
      } catch {
        // partial trailing line not yet complete
      }
    }
  }

  return {
    reset,
    unchanged: false,
    ino,
    size,
    mtimeMs,
    committedByteOffset: nextCommittedOffset,
    committedDelta,
    pendingRow,
  };
}

function yieldMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function parseWhatsAppRow(obj: Record<string, unknown>, idx: number, fallbackIso: string): WorkerParsedPersonalMessage {
  const occurredAt = normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
  const rawText = stripEmDashes(String(obj.text || ""));
  const m = rawText.match(/^\[WhatsApp\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:\s*([\s\S]*)$/);
  const threadTitle = cleanText(m?.[1] || String(obj.channel || "WhatsApp").replace(/^whatsapp:/i, ""), 72);
  const sender = cleanText(m?.[2] || threadTitle, 64);
  const body = cleanDisplayText((m?.[3] ?? rawText).trim());
  const channelKey = String(obj.channel || `whatsapp:${normalizePersonKey(threadTitle)}`).toLowerCase();
  const isNoise = isNoiseMessage({ channel: "whatsapp", channelKey, threadTitle });
  return {
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
  };
}

function parseIMessageRow(obj: Record<string, unknown>, idx: number, fallbackIso: string): WorkerParsedPersonalMessage {
  const occurredAt = normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
  const rawText = stripEmDashes(String(obj.text || ""));
  const lines = rawText.split(/\r?\n/);
  const rawBody = (lines[0]?.startsWith("[iMessage") ? lines.slice(1).join("\n") : rawText).trim();
  const body = cleanDisplayText(rawBody);
  const chat = cleanText(String(obj.chat || obj.sender || "iMessage"), 64);
  const direction = String(obj.direction || "inbound").toLowerCase();
  const sender = direction === "outbound" ? "You" : cleanText(String(obj.sender || chat), 64);
  const threadKey = `imessage:${chat.toLowerCase()}`;
  const isNoise = isNoiseMessage({ channel: "imessage", sender: chat, threadTitle: chat, body });
  return {
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
  };
}

function parseGmailRow(obj: Record<string, unknown>, idx: number, fallbackIso: string): WorkerParsedPersonalMessage {
  const occurredAt = normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
  const fromRaw = String(obj.from_addr || "");
  const toRaw = String(obj.to_addr || "");
  const folder = String(obj.folder || "INBOX");
  const subject = cleanText(cleanDisplayText(String(obj.subject_line || obj.subject || "(No subject)")), 110);
  const rawText = stripEmDashes(String(obj.text || ""));
  const parsedFrom = parseEmailAddressField(fromRaw);
  const parsedTo = parseEmailAddressField(toRaw);
  const isSent = folder.toLowerCase() === "sent" || isSelfIdentity(parsedFrom.email || parsedFrom.name);
  const counterpart = isSent ? parsedTo : parsedFrom;
  const normSubj = subject.replace(/^(re|fwd|fw)\s*:\s*/gi, "").trim().toLowerCase().slice(0, 64);
  const threadKey = `gmail:${counterpart.email || normalizePersonKey(counterpart.name)}:${normalizePersonKey(normSubj)}`;
  const cleanBody = cleanEmailDisplayBody(rawText);
  const noiseTarget = isSent ? toRaw : fromRaw;
  const isNoise = isNoiseMessage({
    channel: "gmail",
    from: noiseTarget,
    sender: noiseTarget,
    subject,
    body: `${rawText}\n${cleanBody}`,
  });
  return {
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
  };
}

function parseCalendarRow(obj: Record<string, unknown>, idx: number, fallbackIso: string): WorkerParsedCalendarEvent | null {
  const rawText = stripEmDashes(String(obj.text || ""));
  const firstLine = rawText.split(/\r?\n/)[0] || "";
  const derivedTitle =
    (typeof obj.title === "string" && obj.title.trim()) ||
    firstLine.replace(/^#+\s*/, "").trim() ||
    "Calendar Event";
  const cleanTitle = cleanText(cleanDisplayText(derivedTitle), 110) || "Calendar Event";
  const start = normalizeBridgeTimestamp(obj.occurred_at ?? obj.start, fallbackIso);
  const startMs = Date.parse(start);
  if (Number.isNaN(startMs)) return null;
  const endRaw = obj.end_at ?? obj.end;
  const end = endRaw ? normalizeBridgeTimestamp(endRaw, start) : null;
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
  return {
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
  };
}

function buildWhoopSummaryFromRow(latest: Record<string, unknown> | null): WorkerWhoopSummary {
  if (!latest) {
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

function compilePersonTermsForWorker(personName: string, aliases: string[]): {
  singleWords: Set<string>;
  phrases: string[];
} {
  const singleWords = new Set<string>();
  const phrases: string[] = [];
  const seenPhrases = new Set<string>();
  const terms = buildStrongPersonSearchTerms(personName, aliases);

  for (const term of terms) {
    const lower = term.toLowerCase();
    if (lower.includes(" ") || lower.includes("@") || lower.includes("-")) {
      if (!seenPhrases.has(lower)) {
        seenPhrases.add(lower);
        phrases.push(lower);
      }
    } else if (lower.length >= 4 && !GENERIC_CLAIM_STOPWORDS.has(lower)) {
      singleWords.add(lower);
    }
  }

  return { singleWords, phrases };
}

/**
 * Stateful incremental builder used inside the Bun Worker (and as an async
 * chunked fallback if Worker instantiation fails in edge test environments).
 */
export class PersonalIndexBuilder {
  private readonly config: PersonalIndexWorkerConfig;
  private readonly chunkedYield: boolean;
  private db: Database | null = null;

  private waCache: IncrementalParsedCache<WorkerParsedPersonalMessage> | null = null;
  private tgCache: TelegramIncrementalCache | null = null;
  private imsgCache: IncrementalParsedCache<WorkerParsedPersonalMessage> | null = null;
  private gmailCache: IncrementalParsedCache<WorkerParsedPersonalMessage> | null = null;
  private calCache: IncrementalParsedCache<WorkerParsedCalendarEvent> | null = null;
  private whoopCache: WhoopIncrementalCache | null = null;

  private cachedClaimsFingerprint: string | null = null;
  private cachedPeopleKeyHash: string | null = null;
  private cachedClaimCounts: Map<string, number> | null = null;

  constructor(config: PersonalIndexWorkerConfig, opts: { chunkedYield?: boolean } = {}) {
    this.config = config;
    this.chunkedYield = Boolean(opts.chunkedYield);
  }

  private getDb(): Database | null {
    if (this.db) return this.db;
    try {
      const db = new Database(this.config.dbPath, { readonly: true });
      try {
        db.exec("PRAGMA busy_timeout = 3000;");
      } catch {
        // ignore on readonly
      }
      this.db = db;
      return db;
    } catch {
      return null;
    }
  }

  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore
      }
      this.db = null;
    }
  }

  private async loadIncrementalChannel(
    filePath: string,
    prev: IncrementalParsedCache<WorkerParsedPersonalMessage> | null,
    parseRow: (obj: Record<string, unknown>, idx: number, fallbackIso: string) => WorkerParsedPersonalMessage,
    fallbackIso: string
  ): Promise<IncrementalParsedCache<WorkerParsedPersonalMessage> | null> {
    const delta = await readJsonlIncrementalDelta(filePath, prev);
    if (!delta) return null;
    if (delta.unchanged && prev) return prev;

    const committedItems = delta.reset || !prev ? [] : prev.committedItems;
    let count = delta.reset || !prev ? 0 : prev.committedCount;

    for (let i = 0; i < delta.committedDelta.length; i++) {
      committedItems.push(parseRow(delta.committedDelta[i], count, fallbackIso));
      count += 1;
      if (this.chunkedYield && i > 0 && i % 1500 === 0) {
        await yieldMacrotask();
      }
    }

    const pendingItem = delta.pendingRow ? parseRow(delta.pendingRow, count, fallbackIso) : null;

    return {
      ino: delta.ino,
      size: delta.size,
      mtimeMs: delta.mtimeMs,
      committedByteOffset: delta.committedByteOffset,
      committedCount: count,
      committedItems,
      pendingItem,
    };
  }

  private async loadIncrementalTelegram(
    filePath: string,
    prev: TelegramIncrementalCache | null,
    fallbackIso: string
  ): Promise<TelegramIncrementalCache | null> {
    const delta = await readJsonlIncrementalDelta(filePath, prev);
    if (!delta) return null;
    if (delta.unchanged && prev) return prev;

    const committedItems = delta.reset || !prev ? [] : prev.committedItems;
    let count = delta.reset || !prev ? 0 : prev.committedCount;
    const channelCounts = delta.reset || !prev ? new Map<string, number>() : prev.channelCounts;
    const channelSenders = delta.reset || !prev ? new Map<string, Set<string>>() : prev.channelSenders;
    const megaGroups = delta.reset || !prev ? new Set<string>() : prev.megaGroups;

    const newlyCrossedMega = new Set<string>();

    // First pass over delta to update channel stats
    for (let i = 0; i < delta.committedDelta.length; i++) {
      const obj = delta.committedDelta[i];
      const ch = String(obj.channel || "").toLowerCase();
      if (!ch) continue;
      const nextCount = (channelCounts.get(ch) || 0) + 1;
      channelCounts.set(ch, nextCount);
      const rawText = String(obj.text || "");
      const m = rawText.match(/^\[Telegram\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:/);
      if (m && m[2]) {
        let set = channelSenders.get(ch);
        if (!set) {
          set = new Set<string>();
          channelSenders.set(ch, set);
        }
        if (set.size < 25) set.add(m[2].trim().toLowerCase());
      }
      if (!megaGroups.has(ch) && nextCount >= 120 && (channelSenders.get(ch)?.size || 0) >= 8) {
        megaGroups.add(ch);
        newlyCrossedMega.add(ch);
      }
    }

    // Retroactively mark existing items if any channel just crossed mega-group threshold
    if (newlyCrossedMega.size > 0 && committedItems.length > 0) {
      for (let i = 0; i < committedItems.length; i++) {
        const item = committedItems[i];
        if (!item.is_noise && newlyCrossedMega.has(item.thread_key)) {
          item.is_noise = true;
        }
      }
    }

    const parseTg = (obj: Record<string, unknown>, idx: number): WorkerParsedPersonalMessage => {
      const occurredAt = normalizeBridgeTimestamp(obj.occurred_at ?? obj.timestamp, fallbackIso);
      const rawText = stripEmDashes(String(obj.text || ""));
      const m = rawText.match(/^\[Telegram\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:\s*([\s\S]*)$/);
      const threadTitle = cleanText(m?.[1] || String(obj.channel || "Telegram").replace(/^telegram:/i, ""), 72);
      const sender = cleanText(m?.[2] || threadTitle, 64);
      const body = cleanDisplayText((m?.[3] ?? rawText).trim());
      const channelKey = String(obj.channel || `telegram:${normalizePersonKey(threadTitle)}`).toLowerCase();
      const isMegaGroup = megaGroups.has(channelKey);
      const isNoise = isMegaGroup || isNoisyTelegramChannel(channelKey, threadTitle, sender);
      return {
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
      };
    };

    for (let i = 0; i < delta.committedDelta.length; i++) {
      committedItems.push(parseTg(delta.committedDelta[i], count));
      count += 1;
      if (this.chunkedYield && i > 0 && i % 1500 === 0) {
        await yieldMacrotask();
      }
    }

    const pendingItem = delta.pendingRow ? parseTg(delta.pendingRow, count) : null;

    return {
      ino: delta.ino,
      size: delta.size,
      mtimeMs: delta.mtimeMs,
      committedByteOffset: delta.committedByteOffset,
      committedCount: count,
      committedItems,
      pendingItem,
      channelCounts,
      channelSenders,
      megaGroups,
    };
  }

  private async loadIncrementalCalendar(
    filePath: string,
    prev: IncrementalParsedCache<WorkerParsedCalendarEvent> | null,
    fallbackIso: string
  ): Promise<IncrementalParsedCache<WorkerParsedCalendarEvent> | null> {
    const delta = await readJsonlIncrementalDelta(filePath, prev);
    if (!delta) return null;
    if (delta.unchanged && prev) return prev;

    const committedItems = delta.reset || !prev ? [] : prev.committedItems;
    let count = delta.reset || !prev ? 0 : prev.committedCount;

    for (let i = 0; i < delta.committedDelta.length; i++) {
      const parsed = parseCalendarRow(delta.committedDelta[i], count, fallbackIso);
      if (parsed) committedItems.push(parsed);
      count += 1;
      if (this.chunkedYield && i > 0 && i % 1500 === 0) {
        await yieldMacrotask();
      }
    }

    const pendingItem = delta.pendingRow ? parseCalendarRow(delta.pendingRow, count, fallbackIso) : null;

    return {
      ino: delta.ino,
      size: delta.size,
      mtimeMs: delta.mtimeMs,
      committedByteOffset: delta.committedByteOffset,
      committedCount: count,
      committedItems,
      pendingItem,
    };
  }

  private async loadIncrementalWhoop(
    filePath: string,
    prev: WhoopIncrementalCache | null
  ): Promise<WhoopIncrementalCache | null> {
    const delta = await readJsonlIncrementalDelta(filePath, prev);
    if (!delta) return null;
    if (delta.unchanged && prev) return prev;

    let latestRow = delta.reset || !prev ? null : prev.latestRow;
    let latestKey = delta.reset || !prev ? "" : prev.latestKey;
    let count = delta.reset || !prev ? 0 : prev.committedCount;

    for (let i = 0; i < delta.committedDelta.length; i++) {
      const r = delta.committedDelta[i];
      const k = String(r.day || r.occurred_at || "");
      if (!latestRow || k.localeCompare(latestKey) >= 0) {
        latestRow = r;
        latestKey = k;
      }
      count += 1;
    }

    if (delta.pendingRow) {
      const k = String(delta.pendingRow.day || delta.pendingRow.occurred_at || "");
      if (!latestRow || k.localeCompare(latestKey) >= 0) {
        latestRow = delta.pendingRow;
        latestKey = k;
      }
    }

    return {
      ino: delta.ino,
      size: delta.size,
      mtimeMs: delta.mtimeMs,
      committedByteOffset: delta.committedByteOffset,
      committedCount: count,
      latestRow,
      latestKey,
    };
  }

  private async countSqliteClaimsStreaming(
    people: Array<{ key: string; name: string; aliases: string[] }>
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (people.length === 0) return counts;

    const db = this.getDb();
    if (!db) return counts;

    let claimsFp = "0:0";
    try {
      const fpRow = db
        .query(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid, COUNT(*) AS cnt FROM claims`)
        .get() as { max_rowid: number; cnt: number } | null;
      if (fpRow) {
        claimsFp = `${fpRow.max_rowid}:${fpRow.cnt}`;
      }
    } catch {
      return counts;
    }

    // Build stable people signature hash for claims count memoization
    const sigParts: string[] = new Array(people.length);
    for (let i = 0; i < people.length; i++) {
      const p = people[i];
      sigParts[i] = `${p.key}|${p.name}|${p.aliases.slice().sort().join(",")}`;
    }
    sigParts.sort();
    const peopleHash = String(Bun.hash(sigParts.join("\n")));

    if (
      this.cachedClaimCounts &&
      this.cachedClaimsFingerprint === claimsFp &&
      this.cachedPeopleKeyHash === peopleHash
    ) {
      return this.cachedClaimCounts;
    }

    const tokenToKeys = new Map<string, string[]>();
    const anchorToPhrases = new Map<string, Array<{ key: string; phrase: string }>>();
    const unanchoredPhrases: Array<{ key: string; phrase: string }> = [];
    const wordTokenRe = /[a-z0-9_]{4,}/g;

    for (const p of people) {
      counts.set(p.key, 0);
      const compiled = compilePersonTermsForWorker(p.name, p.aliases);
      for (const lower of compiled.singleWords) {
        const arr = tokenToKeys.get(lower) || [];
        if (!arr.includes(p.key)) arr.push(p.key);
        tokenToKeys.set(lower, arr);
      }
      for (const lower of compiled.phrases) {
        const words = (lower.match(wordTokenRe) || []).filter((w) => !GENERIC_CLAIM_STOPWORDS.has(w));
        if (words.length === 0) {
          unanchoredPhrases.push({ key: p.key, phrase: lower });
          continue;
        }
        words.sort((a, b) => b.length - a.length);
        const anchor = words[0];
        const list = anchorToPhrases.get(anchor) || [];
        if (!list.some((x) => x.key === p.key && x.phrase === lower)) {
          list.push({ key: p.key, phrase: lower });
          anchorToPhrases.set(anchor, list);
        }
      }
    }

    try {
      const stmt = db.query(
        `SELECT coalesce(target, '') AS target, coalesce(body, '') AS body
         FROM claims
         WHERE status != 'retracted'`
      );

      let scanned = 0;
      for (const row of stmt.iterate() as IterableIterator<{ target: string; body: string }>) {
        scanned += 1;
        if (this.chunkedYield && scanned % 2500 === 0) {
          await yieldMacrotask();
        }
        const lower = `${row.target} ${row.body}`.toLowerCase();
        if (lower.length < 4) continue;

        let matchedKeys: Set<string> | null = null;
        wordTokenRe.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = wordTokenRe.exec(lower)) !== null) {
          const tok = m[0];
          const hitKeys = tokenToKeys.get(tok);
          if (hitKeys) {
            if (!matchedKeys) matchedKeys = new Set<string>();
            for (let j = 0; j < hitKeys.length; j++) matchedKeys.add(hitKeys[j]);
          }
          const phraseHits = anchorToPhrases.get(tok);
          if (phraseHits) {
            for (let j = 0; j < phraseHits.length; j++) {
              const entry = phraseHits[j];
              if (matchedKeys?.has(entry.key)) continue;
              if (lower.includes(entry.phrase)) {
                if (!matchedKeys) matchedKeys = new Set<string>();
                matchedKeys.add(entry.key);
              }
            }
          }
        }

        if (unanchoredPhrases.length > 0) {
          for (let j = 0; j < unanchoredPhrases.length; j++) {
            const entry = unanchoredPhrases[j];
            if (matchedKeys?.has(entry.key)) continue;
            if (lower.includes(entry.phrase)) {
              if (!matchedKeys) matchedKeys = new Set<string>();
              matchedKeys.add(entry.key);
            }
          }
        }

        if (!matchedKeys) continue;
        if (FICTIONAL_NOISE_RE.test(lower)) continue;

        for (const k of matchedKeys) {
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    } catch {
      // ignore DB errors in isolated tests without claims table
    }

    this.cachedClaimsFingerprint = claimsFp;
    this.cachedPeopleKeyHash = peopleHash;
    this.cachedClaimCounts = counts;
    return counts;
  }

  async build(): Promise<WorkerPersonalIndexSnapshot> {
    const nowMs = Date.now();
    const fallbackIso = new Date(nowMs).toISOString();

    const [waCache, tgCache, imsgCache, gmailCache, calCache, whoopCache, loadedCards] = await Promise.all([
      this.loadIncrementalChannel(
        join(this.config.bridgesDir, "whatsapp", "events.jsonl"),
        this.waCache,
        parseWhatsAppRow,
        fallbackIso
      ),
      this.loadIncrementalTelegram(
        join(this.config.bridgesDir, "telegram", "events.jsonl"),
        this.tgCache,
        fallbackIso
      ),
      this.loadIncrementalChannel(
        join(this.config.bridgesDir, "mac-imessage", "events.jsonl"),
        this.imsgCache,
        parseIMessageRow,
        fallbackIso
      ),
      this.loadIncrementalChannel(
        join(this.config.bridgesDir, "gmail", "events.jsonl"),
        this.gmailCache,
        parseGmailRow,
        fallbackIso
      ),
      this.loadIncrementalCalendar(
        join(this.config.bridgesDir, "mac-calendar", "events.jsonl"),
        this.calCache,
        fallbackIso
      ),
      this.loadIncrementalWhoop(
        join(this.config.bridgesDir, "whoop", "events.jsonl"),
        this.whoopCache
      ),
      loadCanonicalPersonCards({
        vaultPath: this.config.vaultPath,
        lifeosPeopleDir: this.config.lifeosPeopleDir,
        relationshipsDir: this.config.relationshipsDir,
      }),
    ]);

    this.waCache = waCache;
    this.tgCache = tgCache;
    this.imsgCache = imsgCache;
    this.gmailCache = gmailCache;
    this.calCache = calCache;
    this.whoopCache = whoopCache;

    const messages: WorkerParsedPersonalMessage[] = [];
    const appendCached = (c: IncrementalParsedCache<WorkerParsedPersonalMessage> | null) => {
      if (!c) return;
      for (let i = 0; i < c.committedItems.length; i++) messages.push(c.committedItems[i]);
      if (c.pendingItem) messages.push(c.pendingItem);
    };
    appendCached(waCache);
    appendCached(tgCache);
    appendCached(imsgCache);
    appendCached(gmailCache);

    messages.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));

    const calendar: WorkerParsedCalendarEvent[] = [];
    if (calCache) {
      for (let i = 0; i < calCache.committedItems.length; i++) calendar.push(calCache.committedItems[i]);
      if (calCache.pendingItem) calendar.push(calCache.pendingItem);
      calendar.sort((a, b) => a.startMs - b.startMs);
    }

    const whoop = buildWhoopSummaryFromRow(whoopCache?.latestRow ?? null);
    const cardMatcher = createCanonicalCardMatcher(loadedCards.cards);

    // Deduplicated inboxThreads (newest per thread_key + message_count)
    const threadMap = new Map<string, { latest: WorkerParsedPersonalMessage; count: number }>();
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const existing = threadMap.get(msg.thread_key);
      if (!existing) {
        threadMap.set(msg.thread_key, { latest: msg, count: 1 });
      } else {
        existing.count += 1;
      }
    }

    const inboxThreads: WorkerTodayInboxItem[] = Array.from(threadMap.values())
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

    const peopleByKey = new Map<string, WorkerPersonIndexRecord>();
    const aliasToKey = new Map<string, string>();
    const timelineIdsByPerson = new Map<string, Set<string>>();

    const attachCanonicalCard = (rec: WorkerPersonIndexRecord, card: CanonicalPersonCard): void => {
      rec.canonical_card = card;
      rec.name = card.canonical_name;
      rec.initials = computeInitials(card.canonical_name);
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
        const nk = normalizePersonKey(al);
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
      meeting?: WorkerParsedCalendarEvent;
    }): void => {
      const cleanName = cleanText(opts.displayName, 64);
      if (!cleanName || isSelfIdentity(cleanName) || isSelfIdentity(opts.rawKey)) return;

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

      const candidateKey = normalizePersonKey(opts.rawKey);
      let resolvedKey = matchedCard
        ? matchedCard.slug
        : aliasToKey.get(candidateKey) || aliasToKey.get(normalizePersonKey(cleanName)) || candidateKey;

      if (!matchedCard && opts.extraAliases) {
        for (const al of opts.extraAliases) {
          const nk = normalizePersonKey(al);
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
          initials: computeInitials(initName),
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
          aliases: new Set<string>([resolvedKey, candidateKey, normalizePersonKey(cleanName)]),
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
          if (
            (rec.name.includes("@") || /^\+?\d+$/.test(rec.name)) &&
            !cleanName.includes("@") &&
            !/^\+?\d+$/.test(cleanName)
          ) {
            rec.name = cleanName;
            rec.initials = computeInitials(cleanName);
          }
          if (opts.isGroup === false) {
            rec.is_group = false;
          }
        }
      }

      if (isPast) {
        if (!rec.last_seen_iso || opts.occurredAt.localeCompare(rec.last_seen_iso) > 0) {
          rec.last_seen_iso = opts.occurredAt;
          rec.last_seen = opts.occurredAt;
        }
        if (!rec.first_seen || opts.occurredAt.localeCompare(rec.first_seen) < 0) {
          rec.first_seen = opts.occurredAt;
        }
        if (opts.isMessage) {
          rec.past_message_count += 1;
          if (!rec.last_message_iso || opts.occurredAt.localeCompare(rec.last_message_iso) > 0) {
            rec.last_message_iso = opts.occurredAt;
            if (opts.snippet && (!isNoisyGroupSnippet(opts.snippet) || !rec.last_message_snippet)) {
              rec.last_message_snippet = cleanText(opts.snippet, 180);
            }
          } else if (
            opts.snippet &&
            isNoisyGroupSnippet(rec.last_message_snippet) &&
            !isNoisyGroupSnippet(opts.snippet)
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
      rec.message_count += 1;
      rec.raw_aliases.add(cleanName);
      if (opts.email) rec.raw_aliases.add(opts.email);
      aliasToKey.set(resolvedKey, resolvedKey);
      if (!candidateKey.includes("@") || opts.email) {
        aliasToKey.set(candidateKey, resolvedKey);
      }
      if (!matchedCard) {
        aliasToKey.set(normalizePersonKey(cleanName), resolvedKey);
      }
      if (opts.extraAliases) {
        for (const al of opts.extraAliases) {
          if (al) rec.raw_aliases.add(al);
          const nk = normalizePersonKey(al);
          if (nk && nk.length >= 2) {
            rec.aliases.add(nk);
            if (!matchedCard) {
              aliasToKey.set(nk, resolvedKey);
            }
          }
        }
      }

      // Preserve generous multi-year message history per person (for 52-week ledger + full dossier)
      if (opts.timelineItem && isPast && rec.timeline.length < 5000) {
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

    for (let i = 0; i < messages.length; i++) {
      if (this.chunkedYield && i > 0 && i % 3000 === 0) {
        await yieldMacrotask();
      }
      const msg = messages[i];
      if (msg.is_noise) continue;

      if (msg.channel === "whatsapp" || msg.channel === "telegram") {
        const isDirect =
          msg.thread_title.toLowerCase() === msg.sender.toLowerCase() ||
          isSelfIdentity(msg.sender);

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

        if (!isDirect && !isSelfIdentity(msg.sender) && !/^\d{10,}$/.test(msg.sender)) {
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

    for (const ev of calendar) {
      for (const participant of ev.participants) {
        if (isSelfIdentity(participant)) continue;
        const parsed = parseEmailAddressField(participant);
        if (!parsed.name || isSelfIdentity(parsed.name)) continue;
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

    for (const card of loadedCards.cards) {
      let rec = peopleByKey.get(card.slug);
      if (!rec) {
        rec = {
          key: card.slug,
          name: card.canonical_name,
          initials: computeInitials(card.canonical_name),
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

    const claimCounts = await this.countSqliteClaimsStreaming(
      Array.from(peopleByKey.values()).map((r) => ({
        key: r.key,
        name: r.name,
        aliases: Array.from(r.raw_aliases),
      }))
    );

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
        const timing = formatCountdown(nextEv.startMs, nextEv.endMs, nowMs);
        rec.next_meeting = {
          title: nextEv.title,
          start_iso: nextEv.start,
          countdown: timing.countdown,
          meet_url: nextEv.meet_url,
        };
      }

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
        rec.last_seen_label = formatRelativeAge(rec.last_seen_iso, nowMs);
      } else if (rec.next_meeting) {
        rec.last_seen_label = "Upcoming";
      } else {
        rec.last_seen_label = "No recent msg";
      }
    }

    const relTierRank: Record<RelationshipTier, number> = { Family: 5, Core: 4, Active: 3, Warm: 2, Ambient: 1 };
    const profTierRank: Record<ProfileTier, number> = { v2: 4, lifeos: 3, claims: 2, live: 1 };
    const DAY_MS = 86400_000;

    const rankTier = (r: WorkerPersonIndexRecord): number => {
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

    const activeScore = (r: WorkerPersonIndexRecord): number => {
      const baseMs = Date.parse(r.last_message_iso || r.last_seen_iso || "") || 0;
      const ageDays = Math.max(0, (nowMs - baseMs) / DAY_MS);
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
}

export interface PersonalIndexWorkerClient {
  build: () => Promise<WorkerPersonalIndexSnapshot>;
  dispose: () => void;
  isUsingWorker: () => boolean;
}

type WorkerInboundMessage =
  | { type: "build"; id: number; config: PersonalIndexWorkerConfig }
  | { type: "dispose" };

type WorkerOutboundMessage =
  | { type: "result"; id: number; snapshot: WorkerPersonalIndexSnapshot }
  | { type: "error"; id: number; error: string };

/**
 * Main-thread client that delegates builds to a dedicated Bun Worker
 * and safely falls back to chunked async execution if Worker instantiation fails.
 */
export function createPersonalIndexWorkerClient(
  config: PersonalIndexWorkerConfig,
  opts: { disableWorker?: boolean } = {}
): PersonalIndexWorkerClient {
  let worker: Worker | null = null;
  let workerFailed = Boolean(opts.disableWorker);
  let fallbackBuilder: PersonalIndexBuilder | null = null;
  let disposed = false;
  let reqId = 0;

  const pending = new Map<
    number,
    {
      resolve: (snap: WorkerPersonalIndexSnapshot) => void;
      reject: (err: Error) => void;
    }
  >();

  const runFallback = async (): Promise<WorkerPersonalIndexSnapshot> => {
    if (!fallbackBuilder) {
      fallbackBuilder = new PersonalIndexBuilder(config, { chunkedYield: true });
    }
    return fallbackBuilder.build();
  };

  const failWorkerAndFallback = () => {
    workerFailed = true;
    if (worker) {
      try {
        worker.terminate();
      } catch {
        // ignore
      }
      worker = null;
    }
    for (const [id, entry] of pending.entries()) {
      pending.delete(id);
      void runFallback().then(entry.resolve, entry.reject);
    }
  };

  const ensureWorker = (): Worker | null => {
    if (disposed || workerFailed) return null;
    if (worker) return worker;
    try {
      const w = new Worker(new URL("./personal-index.worker.ts", import.meta.url).href, {
        type: "module",
      });
      if (typeof (w as unknown as { unref?: () => void }).unref === "function") {
        (w as unknown as { unref: () => void }).unref();
      }
      w.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
        const msg = event.data;
        if (!msg || typeof msg !== "object") return;
        const entry = pending.get(msg.id);
        if (!entry) return;
        pending.delete(msg.id);
        if (msg.type === "result") {
          entry.resolve(msg.snapshot);
        } else {
          entry.reject(new Error(msg.error || "Personal index worker build failed"));
        }
      };
      w.onerror = () => {
        failWorkerAndFallback();
      };
      worker = w;
      return w;
    } catch {
      workerFailed = true;
      return null;
    }
  };

  return {
    async build(): Promise<WorkerPersonalIndexSnapshot> {
      if (disposed) {
        throw new Error("PersonalIndexWorkerClient is disposed");
      }
      const w = ensureWorker();
      if (!w) {
        return runFallback();
      }
      const id = ++reqId;
      return new Promise<WorkerPersonalIndexSnapshot>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          const payload: WorkerInboundMessage = { type: "build", id, config };
          w.postMessage(payload);
        } catch {
          pending.delete(id);
          failWorkerAndFallback();
          void runFallback().then(resolve, reject);
        }
      });
    },
    dispose(): void {
      disposed = true;
      for (const [, entry] of pending) {
        entry.reject(new Error("PersonalIndexWorkerClient disposed"));
      }
      pending.clear();
      if (worker) {
        try {
          const payload: WorkerInboundMessage = { type: "dispose" };
          worker.postMessage(payload);
        } catch {
          // ignore
        }
        try {
          worker.terminate();
        } catch {
          // ignore
        }
        worker = null;
      }
      if (fallbackBuilder) {
        fallbackBuilder.close();
        fallbackBuilder = null;
      }
    },
    isUsingWorker(): boolean {
      return !workerFailed && worker !== null;
    },
  };
}

// Worker thread entrypoint (only active inside a Bun Worker, never on the main thread).
if (typeof Bun !== "undefined" && !Bun.isMainThread) {
  let builder: PersonalIndexBuilder | null = null;
  let lastConfigKey = "";

  const workerScope = self as unknown as {
    onmessage: ((event: MessageEvent<WorkerInboundMessage>) => void) | null;
    postMessage: (msg: WorkerOutboundMessage) => void;
  };

  workerScope.onmessage = async (event: MessageEvent<WorkerInboundMessage>) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "dispose") {
      if (builder) {
        builder.close();
        builder = null;
      }
      return;
    }

    if (msg.type === "build") {
      try {
        const cfgKey = JSON.stringify(msg.config);
        if (!builder || cfgKey !== lastConfigKey) {
          if (builder) builder.close();
          builder = new PersonalIndexBuilder(msg.config, { chunkedYield: false });
          lastConfigKey = cfgKey;
        }
        const snapshot = await builder.build();
        workerScope.postMessage({ type: "result", id: msg.id, snapshot });
      } catch (err) {
        workerScope.postMessage({
          type: "error",
          id: msg.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}
