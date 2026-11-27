import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HotSnapshot } from "./hot-snapshot.ts";

export interface ReplayApiConfig {
  db: Database;
  vaultPath: string;
  bridgesDir: string;
  antigravityJsonlPath?: string;
  lifeOsRoot?: string;
  snapshotCheckIntervalMs?: number;
}

export interface ReplayCoord {
  lat: number;
  lng: number;
  label: string;
}

export interface ReplayIndexDay {
  day: string;
  total_events: number;
  work_count: number;
  comms_count: number;
  meetings_count: number;
  docs_count: number;
  photo_count: number;
  places: string[];
  primary_place: string | null;
  coords: ReplayCoord[];
  whoop_recovery: number | null;
  whoop_zone: string | null;
  whoop_sleep: number | null;
  headline: string;
  intensity: 0 | 1 | 2 | 3 | 4;
}

export interface ReplayTrip {
  id: string;
  title: string;
  start_day: string;
  end_day: string;
  days_count: number;
  primary_place: string;
  lat: number;
  lng: number;
  photo_count: number;
  highlights: string[];
}

export interface ReplayTopPlace {
  label: string;
  visits: number;
  last_day: string;
  lat: number | null;
  lng: number | null;
  photo_count: number;
}

export interface ReplayMapPoint {
  day: string;
  lat: number;
  lng: number;
  label: string;
  source: string;
  photo_count: number;
}

export interface ReplayIndexResponse {
  available_years: number[];
  selected_year: number;
  stats: {
    total_days_with_activity: number;
    total_gps_days: number;
    total_places: number;
    total_trips: number;
    total_events: number;
    date_min: string | null;
    date_max: string | null;
    has_google_maps_import: boolean;
  };
  days: ReplayIndexDay[];
  trips: ReplayTrip[];
  top_places: ReplayTopPlace[];
  map_points: ReplayMapPoint[];
}

export interface ReplayPlaceItem {
  time: string;
  end_time: string | null;
  label: string;
  address: string | null;
  lat: number | null;
  lng: number | null;
  photo_count: number;
  source: string;
  detail: string | null;
}

export interface ReplayWhoopDay {
  recovery_pct: number | null;
  zone: string | null;
  hrv_ms: number | null;
  rhr_bpm: number | null;
  sleep_hours: number | null;
  summary: string;
}

export interface ReplayWorkItem {
  time: string;
  source: string;
  project: string;
  title: string;
  summary: string;
  count: number;
}

export interface ReplayMeetingItem {
  time: string;
  end_time: string | null;
  title: string;
  location: string | null;
  participants: string[];
  calendar: string | null;
  source?: string | null;
  doc_path?: string | null;
  wispr_doc_path?: string | null;
}

export interface ReplayPersonItem {
  name: string;
  key: string;
  channels: string[];
  count: number;
  latest_snippet: string;
}

export interface ReplayCommItem {
  time: string;
  channel: "whatsapp" | "telegram" | "imessage" | "gmail";
  sender: string;
  thread_title: string;
  snippet: string;
}

export interface ReplayDocItem {
  path: string;
  title: string;
  category: string;
  time: string;
}

export interface ReplayClaimItem {
  time: string;
  kind: string;
  target: string | null;
  text: string;
}

export interface ReplayTimelineItem {
  time: string;
  hhmm: string;
  kind: "place" | "meeting" | "work" | "comms" | "doc" | "health";
  title: string;
  detail: string;
  meta: string | null;
  lat?: number | null;
  lng?: number | null;
}

export interface ReplayDayResponse {
  day: string;
  weekday: string;
  prev_active_day: string | null;
  next_active_day: string | null;
  summary: {
    headline: string;
    primary_location: string | null;
    total_events: number;
    work_sessions: number;
    messages_count: number;
    meetings_count: number;
    docs_count: number;
    photo_count: number;
    claims_count: number;
  };
  places: ReplayPlaceItem[];
  whoop: ReplayWhoopDay | null;
  work: ReplayWorkItem[];
  meetings: ReplayMeetingItem[];
  people: ReplayPersonItem[];
  comms: ReplayCommItem[];
  docs: ReplayDocItem[];
  claims: ReplayClaimItem[];
  timeline: ReplayTimelineItem[];
  story_md: string | null;
}

export interface GoogleMapsImportResult {
  ok: true;
  imported_count: number;
  unique_days: number;
  format: "semanticSegments" | "timelineObjects" | "records";
}

interface InternalLocationRecord {
  id: string;
  day: string;
  start_iso: string;
  end_iso: string | null;
  label: string;
  address: string | null;
  detail: string | null;
  lat: number | null;
  lng: number | null;
  photo_count: number;
  source: string;
  is_flight_destination?: boolean;
}

interface InternalCommRecord {
  day: string;
  time: string;
  channel: "whatsapp" | "telegram" | "imessage" | "gmail";
  sender: string;
  thread_title: string;
  person_name: string;
  person_key: string;
  snippet: string;
}

interface InternalMeetingRecord {
  day: string;
  time: string;
  end_time: string | null;
  title: string;
  location: string | null;
  participants: string[];
  calendar: string | null;
}

interface InternalWisprMeetingRecord {
  day: string;
  time: string;
  end_time: string | null;
  title: string;
  participants: string[];
  doc_path: string;
  filename: string;
}

interface InternalAntigravityRecord {
  day: string;
  time: string;
  conv_id: string;
  role: string;
  text: string;
}

interface ReplayCacheSnapshot {
  builtAt: number;
  hasGoogleMapsImport: boolean;
  activeDaysSortedAsc: string[];
  sqlCountsByDay: Map<string, { work: number; docs: number; legacy: number; total: number }>;
  locationsByDay: Map<string, InternalLocationRecord[]>;
  whoopByDay: Map<string, ReplayWhoopDay>;
  commsByDay: Map<string, InternalCommRecord[]>;
  meetingsByDay: Map<string, InternalMeetingRecord[]>;
  wisprMeetingsByDay: Map<string, InternalWisprMeetingRecord[]>;
  antigravityByDay: Map<string, InternalAntigravityRecord[]>;
  briefsByDay: Map<string, { path: string; title: string; time: string }>;
  allDays: Map<string, ReplayIndexDay>;
  allTrips: ReplayTrip[];
  allMapPoints: ReplayMapPoint[];
  availableYears: number[];
}

const CACHE_TTL_MS = 30_000;
const HOME_LAT = 51.4015;
const HOME_LNG = -0.0757;
const AWAY_THRESHOLD_KM = 30;
const DEFAULT_ANTIGRAVITY_PATH = process.env.KIZUKI_ANTIGRAVITY_JSONL_PATH || "";

interface KnownPlaceEntry {
  patterns: RegExp[];
  lat: number;
  lng: number;
  label: string;
}

const KNOWN_PLACES: KnownPlaceEntry[] = [
  { patterns: [/\bolympia\b/i, /\bhammersmith\s*rd\b/i, /\bw14\s*8ux\b/i], lat: 51.4962, lng: -0.2115, label: "Olympia, London" },
  { patterns: [/\bmiami\s+mia\b/i, /\bmiami\s+international\b/i, /\bflight\s+to\s+miami\b/i, /\bmiami\b/i], lat: 25.7959, lng: -80.287, label: "Miami" },
  { patterns: [/\blondon\s+lhr\b/i, /\bheathrow\b/i, /\blhr\b/i], lat: 51.47, lng: -0.4543, label: "Heathrow Airport" },
  { patterns: [/\bgatwick\b/i, /\blgw\b/i], lat: 51.1537, lng: -0.1821, label: "Gatwick Airport" },
  { patterns: [/\bstansted\b/i], lat: 51.886, lng: 0.2389, label: "Stansted Airport" },
  { patterns: [/\blondon\s+city\s+airport\b/i], lat: 51.5048, lng: 0.0495, label: "London City Airport" },
  { patterns: [/\bbignor\s+roman\s+villa\b/i, /\bbignor\b/i], lat: 50.9255, lng: -0.6012, label: "Bignor Roman Villa" },
  { patterns: [/\besplanade\s+hotel\b/i, /\bfistral\s+beach\b/i, /\bnewquay\b/i, /\btr7\s*1ps\b/i], lat: 50.4123, lng: -5.1031, label: "Esplanade Hotel, Newquay" },
  { patterns: [/\broyal\s+russell\b/i], lat: 51.3578, lng: -0.0586, label: "Royal Russell School" },
  { patterns: [/\bdaiu\s+croydon\b/i, /\bdaiu\b.*\bcroydon\b/i, /\b20\s+high\s+street\s+cr0\b/i], lat: 51.3728, lng: -0.1003, label: "Daiu Croydon" },
  { patterns: [/\blondon\s+bridge\b/i], lat: 51.5045, lng: -0.0865, label: "London Bridge" },
  { patterns: [/\bgrangewood\s+park\b/i], lat: 51.407, lng: -0.0825, label: "Grangewood Park" },
  { patterns: [/\bsouth\s+norwood\s+leisure\b/i, /\bsouth\s+norwood\b/i], lat: 51.3991, lng: -0.0748, label: "South Norwood Leisure Centre" },
  { patterns: [/\bselhurst\s+park\b/i, /\bselhurst\b/i], lat: 51.3983, lng: -0.0855, label: "Selhurst Park" },
  { patterns: [/\bst\.?\s*paul'?s\s+cathedral\b/i], lat: 51.5138, lng: -0.0984, label: "St Paul's Cathedral" },
  { patterns: [/\bsomerset\s+house\b/i], lat: 51.511, lng: -0.1171, label: "Somerset House" },
  { patterns: [/\bhello\s+josephine\b/i, /\bhisar\s+meze\b/i, /\bbeckenham\b/i], lat: 51.4082, lng: -0.0268, label: "Beckenham" },
  { patterns: [/\bclerkenwell\b/i, /\bold\s+sessions\s+house\b/i, /\bknotel\b/i], lat: 51.5229, lng: -0.1053, label: "Clerkenwell, London" },
  { patterns: [/\bshoreditch\b/i, /\bcecconi'?s\b/i, /\bredchurch\s+st\b/i], lat: 51.5245, lng: -0.0754, label: "Shoreditch, London" },
  { patterns: [/\bpenge\b/i, /\bse20\b/i], lat: 51.4136, lng: -0.0512, label: "Penge" },
  { patterns: [/\bsouth\s+croydon\b/i], lat: 51.3641, lng: -0.1056, label: "South Croydon" },
  { patterns: [/\bcroydon\b/i, /\bcr0\b/i], lat: 51.3762, lng: -0.0982, label: "Croydon" },
  { patterns: [/\bstreatham\b/i], lat: 51.4279, lng: -0.1235, label: "Streatham" },
  { patterns: [/\bbarcelona\b/i, /\bcarrer\s+de\s+pallars\b/i, /\bkalamata\b.*\bbarcelona\b/i, /\bsant\s+mart[ií]\b/i], lat: 41.4018, lng: 2.1995, label: "Barcelona" },
  { patterns: [/\bgarmisch\b/i, /\bpartenkirchen\b/i], lat: 47.491, lng: 11.0788, label: "Garmisch-Partenkirchen" },
  { patterns: [/\bgrainau\b/i, /\behrwald\b/i, /\bzugspitze\b/i], lat: 47.4213, lng: 10.985, label: "Grainau & Ehrwald" },
  { patterns: [/\bashton\s+court\b/i, /\bbristol\b/i], lat: 51.4419, lng: -2.6404, label: "Bristol" },
  { patterns: [/\bweymouth\b/i], lat: 50.6089, lng: -2.4539, label: "Weymouth" },
  { patterns: [/\bcanary\s+wharf\b/i], lat: 51.5054, lng: -0.0235, label: "Canary Wharf" },
  { patterns: [/\bsoho\b/i], lat: 51.5136, lng: -0.1365, label: "Soho, London" },
  { patterns: [/\bmayfair\b/i], lat: 51.5095, lng: -0.1476, label: "Mayfair, London" },
  { patterns: [/\bking'?s\s+cross\b/i, /\bst\.?\s*pancras\b/i], lat: 51.5319, lng: -0.1263, label: "King's Cross, London" },
  { patterns: [/\bwestminster\b/i, /\bwaterloo\b/i], lat: 51.5033, lng: -0.1195, label: "Central London" },
  { patterns: [/\belm\s+park\s+ave\b/i, /\bn15\s*6uy\b/i], lat: 51.5798, lng: -0.0888, label: "North London (N15)" },
  { patterns: [/\bparis\b/i, /\bgare\s+du\s+nord\b/i, /\beurostar\b/i], lat: 48.8566, lng: 2.3522, label: "Paris" },
  { patterns: [/\bamsterdam\b/i, /\bschiphol\b/i], lat: 52.3676, lng: 4.9041, label: "Amsterdam" },
  { patterns: [/\blisbon\b/i], lat: 38.7223, lng: -9.1393, label: "Lisbon" },
  { patterns: [/\bdubai\b/i, /\bdxb\b/i], lat: 25.2048, lng: 55.2708, label: "Dubai" },
  { patterns: [/\bnew\s+york\b/i, /\bmanhattan\b/i, /\bjfk\b/i], lat: 40.7128, lng: -74.006, label: "New York" },
  { patterns: [/\bsan\s+francisco\b/i, /\bsfo\b/i], lat: 37.7749, lng: -122.4194, label: "San Francisco" },
  { patterns: [/\bsingapore\b/i, /\bchangi\b/i], lat: 1.3521, lng: 103.8198, label: "Singapore" },
  { patterns: [/\btokyo\b/i, /\bhaneda\b/i, /\bnarita\b/i], lat: 35.6762, lng: 139.6503, label: "Tokyo" },
  { patterns: [/\bbrighton\b/i], lat: 50.8225, lng: -0.1372, label: "Brighton" },
  { patterns: [/\boxford\b/i], lat: 51.752, lng: -1.2577, label: "Oxford" },
  { patterns: [/\bcambridge\b/i], lat: 52.2053, lng: 0.1218, label: "Cambridge" },
  { patterns: [/\bmanchester\b/i], lat: 53.4808, lng: -2.2426, label: "Manchester" },
  { patterns: [/\bedinburgh\b/i], lat: 55.9533, lng: -3.1883, label: "Edinburgh" },
  { patterns: [/\bcornwall\b/i], lat: 50.4123, lng: -5.1031, label: "Cornwall" },
  { patterns: [/\blondon\b.*\b(?:uk|united\s+kingdom|ec\d|wc\d|w\d|sw\d|se\d|e\d|n\d|nw\d)\b/i, /\bcentral\s+london\b/i], lat: 51.5074, lng: -0.1278, label: "London" },
];

const NOISY_TELEGRAM_RE =
  /(?:^|[:_\s-])(sui-traders|lookonchain|dexscreener|cryptonear|soylana|all-street-bets|shitzu|lonkonnear|monad-cucks|sui-to-5|devnet-debauchery|solana-uk|stuk-members-lounge|ai-psychosis|theemptyboxclub|spidersjournal|jollycrates|tattothetoo|pump|airdrop|signals|alerts|whale|scanner|sniper|degen|traders|memecoin|broadcast|announcements?|botfather|cryptonews|coinmarketcap|coingecko)(?:$|[:_\s-])/i;

const VIRTUAL_LOC_RE =
  /(?:google\s*meet|zoom\.us|teams\.microsoft|microsoft\s*teams|https?:\/\/|streamyard|facetime|webex|discord|whereby|calendly|v\.?c\.?\s*camera)/i;

const NON_PLACE_LABEL_RE =
  /(?:thanks\s+for\s+joining|builder\s+zone|not\s+your\s+keys|sync\s+daily|weekly\s+sync|standup|check-in|invitation|zoom\.us|meet\.google|teams\.microsoft|https?:\/\/|order\s+with\s+uber|uber\s+eats|deliveroo\s+(?:order|receipt)|your\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday).*(?:order|trip))/i;

const NON_PLACE_PREFIX_RE = /^(?:thanks\s+|re:\s*|fwd:\s*|fw:\s*|join\s+)/i;

const REAL_VENUE_OR_CITY_RE =
  /(?:\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|lane|ln\.?|drive|dr\.?|square|sq\.?|place|pl\.?|park|garden|gardens|house|hotel|villa|beach|airport|station|terminal|bridge|cathedral|school|college|university|hospital|clinic|centre|center|pool|club|bar|cafe|restaurant|kitchen|bistro|pub|hall|theatre|theater|museum|gallery|stadium|arena|wharf|quay|pier|market|plaza|tower|building|court|grn|green|close|way|terrace|crescent|london|uk|united\s+kingdom|england|spain|germany|france|usa|miami|barcelona|paris|tokyo|dubai|new\s+york|san\s+francisco|singapore|amsterdam|lisbon|croydon|beckenham|newquay|bristol|oxford|cambridge|brighton|manchester|edinburgh)\b|\b[A-Z]{1,2}\d{1,2}[A-Z]?\s*\d[A-Z]{2}\b)/i;

const GMAIL_PROMO_RE =
  /(?:grocery\s+deals|buy\s+one\s+get\s+one|get\s+up\s+to\s+[£$€]\d+\s+off|delicious\s+deals|all\s+the\s+trusted\s+picks|more\s+mikos|where\s+to\s+next|missed\s+it\s+live|unsubscribe|promo|discount|flash\s+sale|limited\s+time)/i;

const GMAIL_RECEIPT_RE =
  /(?:uber\s+receipts|your\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday).*(?:order|trip)\s+with\s+uber|deliveroo\s+(?:order|receipt)|trainline|eurostar|boarding\s+pass|flight\s+confirmation|e-ticket|booking\s+confirmation|hotel\s+confirmation|airbnb\s+reservation|reservation\s+(?:confirmed|at)|thanks\s+for\s+joining|you'?re\s+going|check-in\s+for|your\s+order\s+from)/i;

const BOILERPLATE_WORK_RE =
  /(?:^Analyze\s+this\s+conversation\s+and\s+determine:|StructuredOutput\b.*(?:denied|refusing|blocked)|structured[\s-]+output\b.*(?:denied|refusing|blocked)|(?:the\s+)?tool\s+call\s+was\s+denied|classifier(?:'s)?\s+(?:output\s+tool|result).*denied|here\s+is\s+the\s+classification\s+(?:as|in)\s+(?:plain\s+)?(?:text|json)|classification\s+is\s+not\s+recorded|classification\s+isn't\s+recorded|can't\s+(?:return|record|deliver)\s+the\s+(?:JSON\s+result|classification|result\s+through\s+it)|could\s+not\s+record\s+the\s+(?:classifier\s+)?result|`?should_continue`?\s*(?:[:=]|is)\s*`?(?:true|false)`?|Still\s+denied\.\s+I\s+won't\s+try\s+to\s+get\s+around\s+the\s+permission\s+block|The\s+following\s+is\s+the\s+Codex\s+agent\s+history\s+(?:whose\s+request\s+action\s+you\s+are\s+assessing|added\s+since\s+your\s+last\s+approval\s+assessment))/i;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function stripEmDashes(input: string): string {
  return input
    .replace(/\s*\u2014\s*/g, " - ")
    .replace(/\u2013/g, "-")
    .replace(/\u00a0/g, " ");
}

function cleanText(raw: unknown, maxLen = 240): string {
  if (typeof raw !== "string") return "";
  const s = stripEmDashes(raw)
    .replace(/\r\n/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 3)).trimEnd() + "...";
}

export function cleanPlaceLabel(
  raw: unknown,
  maxLen = 80,
  opts?: { hasCoords?: boolean }
): string {
  let s = cleanText(raw, 180);
  if (!s) return "";
  // Preserve synthetic coordinate / activity / waypoint labels
  if (/^(?:GPS|Google Maps|Visited Place|Activity|Arrived|Path|Waypoint)\s*\(/i.test(s)) {
    return cleanText(s, maxLen);
  }
  // Reject non-place strings (meeting/email subjects, virtual links, promos, delivery orders)
  if (NON_PLACE_LABEL_RE.test(s) || NON_PLACE_PREFIX_RE.test(s) || VIRTUAL_LOC_RE.test(s)) {
    return "";
  }
  // Strip verbose parentheticals like "(coach from Royal Russell)" or full street addresses in parens,
  // while keeping short UK district/postcode tags like "(N15)" or "(SW1)".
  const stripped = s
    .replace(/\s*\(([^)]*)\)/g, (full, inner: string) => {
      const t = inner.trim();
      if (/^[A-Z]{1,2}\d{1,2}[A-Z]?$/.test(t)) return ` (${t})`;
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,-]+$/, "")
    .trim();
  if (stripped.length >= 3) {
    s = stripped;
  }
  if (NON_PLACE_LABEL_RE.test(s) || NON_PLACE_PREFIX_RE.test(s) || VIRTUAL_LOC_RE.test(s)) {
    return "";
  }
  // Reject long un-geocoded strings (>40 chars) that lack a real venue/city pattern
  if (!opts?.hasCoords && s.length > 40 && !geocodeKnownPlace(s) && !REAL_VENUE_OR_CITY_RE.test(s)) {
    return "";
  }
  return cleanText(s, maxLen);
}

function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + delta));
  return dt.toISOString().slice(0, 10);
}

function diffDays(dayA: string, dayB: string): number {
  const [y1, m1, d1] = dayA.split("-").map(Number);
  const [y2, m2, d2] = dayB.split("-").map(Number);
  const t1 = Date.UTC(y1, m1 - 1, d1);
  const t2 = Date.UTC(y2, m2 - 1, d2);
  return Math.round((t2 - t1) / 86_400_000);
}

function getWeekday(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return WEEKDAYS[dt.getUTCDay()] || "Unknown";
}

function formatHumanDate(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const wd = getWeekday(day);
  const mon = MONTHS[(m || 1) - 1] || "Unknown";
  return `${wd}, ${mon} ${d}, ${y}`;
}

function extractHhmm(iso: string): string {
  const m = iso.match(/T(\d{2}:\d{2})/);
  return m ? m[1] : "00:00";
}

function normalizeIso(raw: unknown, fallbackDay?: string): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1e12 ? raw : raw * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    return null;
  }
  if (typeof raw !== "string") {
    return fallbackDay ? `${fallbackDay}T09:00:00Z` : null;
  }
  const s = raw.trim();
  if (!s) return fallbackDay ? `${fallbackDay}T09:00:00Z` : null;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  const parsed = Date.parse(s);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return fallbackDay ? `${fallbackDay}T09:00:00Z` : null;
}

function validCoord(lat: unknown, lng: unknown): { lat: number; lng: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat === -180 || lng === -180) return null;
  if (Math.abs(lat) < 0.0001 && Math.abs(lng) < 0.0001) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return {
    lat: Math.round(lat * 1_000_000) / 1_000_000,
    lng: Math.round(lng * 1_000_000) / 1_000_000,
  };
}

export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function geocodeKnownPlace(text: string): { lat: number; lng: number; label: string } | null {
  const cleaned = cleanText(text, 300);
  if (!cleaned) return null;
  for (const entry of KNOWN_PLACES) {
    for (const pat of entry.patterns) {
      if (pat.test(cleaned)) {
        return { lat: entry.lat, lng: entry.lng, label: entry.label };
      }
    }
  }
  return null;
}

function slugify(input: string): string {
  const s = stripEmDashes(input)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "item";
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
    lower === "unknown" ||
    (ownerName.length > 0 && lower === ownerName) ||
    ownerEmails.some((em) => lower.includes(em)) ||
    lower.includes("unknownorganizer@calendar.google.com")
  );
}

function parseEmailAddress(raw: string): { name: string; email: string } {
  const s = cleanText(raw, 160);
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

function readJsonlSync(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: Array<Record<string, unknown>> = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") {
        out.push(parsed as Record<string, unknown>);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

function writeAtomicPrivate(filePath: string, content: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // ignore chmod failures on pre-existing dirs
  }
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, filePath);
}

function parseLatLngValue(raw: unknown): { lat: number; lng: number } | null {
  if (!raw) return null;
  if (typeof raw === "string") {
    const cleaned = raw.replace(/^geo:/i, "").replace(/°/g, "").trim();
    const parts = cleaned.split(/[,\s]+/).filter(Boolean);
    if (parts.length >= 2) {
      const la = Number(parts[0]);
      const lo = Number(parts[1]);
      return validCoord(la, lo);
    }
    return null;
  }
  if (typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.latLng === "string" || typeof obj.latLng === "object") {
      return parseLatLngValue(obj.latLng);
    }
    if (typeof obj.latitude === "number" && typeof obj.longitude === "number") {
      return validCoord(obj.latitude, obj.longitude);
    }
    if (typeof obj.lat === "number" && typeof obj.lng === "number") {
      return validCoord(obj.lat, obj.lng);
    }
    if (typeof obj.latitudeE7 === "number" && typeof obj.longitudeE7 === "number") {
      return validCoord(obj.latitudeE7 / 1e7, obj.longitudeE7 / 1e7);
    }
  }
  return null;
}

function inferProjectName(text: string, metadata: Record<string, unknown>, connectorId: string): string {
  const cwd = typeof metadata.cwd === "string" ? metadata.cwd : "";
  if (cwd) {
    const seg = cwd.split("/").filter(Boolean).pop();
    if (seg && seg !== "ubuntu" && seg !== "home") return cleanText(seg, 48);
  }
  const srcFile = typeof metadata.source_file === "string" ? metadata.source_file : "";
  const lower = `${text.slice(0, 500)} ${srcFile}`.toLowerCase();
  if (/\bkizuki\b/.test(lower)) return "Kizuki";
  if (/\bprotocol\b|\bcrypto\b/.test(lower)) return "Protocol";
  if (/\bmarket\s*mak|\btrading\b/.test(lower)) return "Trading";
  if (/\bworkspace\b|\bdaemon\b/.test(lower)) return "Workspace";
  if (/\bantigravity\b|\bneon\b/.test(lower)) return "Antigravity Neon";
  if (connectorId.includes("codex")) return "Codex Session";
  if (connectorId.includes("claude")) return "Claude Code";
  return "Engineering";
}

function extractFirstMeaningfulLine(text: string, maxLen = 140): string {
  const lines = stripEmDashes(text)
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").replace(/^[-*]\s*/, "").replace(/\*\*/g, "").trim())
    .filter(
      (l) =>
        l.length > 4 &&
        !l.startsWith("---") &&
        !l.startsWith("{") &&
        !l.startsWith("[") &&
        !BOILERPLATE_WORK_RE.test(l)
    );
  if (lines.length === 0) {
    const fallback = cleanText(text, maxLen);
    return BOILERPLATE_WORK_RE.test(fallback) ? "" : fallback;
  }
  return cleanText(lines[0], maxLen);
}

function extractDocTitle(text: string, fallbackPath: string): string {
  const fmTitle = text.match(/^---\n[\s\S]*?^title:\s*["']?([^"'\n]+)["']?/m);
  if (fmTitle && fmTitle[1]) return cleanText(fmTitle[1], 100);
  const h1 = text.match(/^#\s+(.+)$/m);
  if (h1 && h1[1]) return cleanText(h1[1], 100);
  return cleanText(basename(fallbackPath).replace(/\.md$/i, ""), 100);
}

function normalizeMeetingTitleKey(title: string): string {
  return cleanText(title, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseWisprMeetingMarkdown(
  filePath: string,
  filename: string,
  todayIso: string
): InternalWisprMeetingRecord | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8").slice(0, 4096);
  } catch {
    return null;
  }

  let fmBlock = "";
  if (raw.startsWith("---\n") || raw.startsWith("---\r\n")) {
    const endIdx = raw.indexOf("\n---", 3);
    if (endIdx !== -1) {
      fmBlock = raw.slice(4, endIdx);
    }
  }

  const getFmField = (key: string): string => {
    const re = new RegExp(`^${key}:\\s*["']?([^"'\\r\\n]+)["']?`, "m");
    const m = fmBlock.match(re);
    return m && m[1] ? m[1].trim() : "";
  };

  const fnDayMatch = filename.match(/^(\d{4}-\d{2}-\d{2})-/);
  const fmDateRaw = getFmField("date");
  const fmOccurredRaw = getFmField("occurred_at");
  const fmEndedRaw = getFmField("ended_at");

  const occurredIso = normalizeIso(fmOccurredRaw) || normalizeIso(fmDateRaw);
  const endIso = normalizeIso(fmEndedRaw);

  let day = "";
  if (fnDayMatch && isValidDay(fnDayMatch[1])) {
    day = fnDayMatch[1];
  } else if (fmDateRaw && isValidDay(fmDateRaw.slice(0, 10))) {
    day = fmDateRaw.slice(0, 10);
  } else if (occurredIso && isValidDay(occurredIso.slice(0, 10))) {
    day = occurredIso.slice(0, 10);
  }

  if (!day || !isValidDay(day) || day > todayIso) return null;

  const participants: string[] = [];
  if (fmBlock) {
    let inParticipants = false;
    for (const line of fmBlock.split(/\r?\n/)) {
      if (/^participants:\s*$/.test(line)) {
        inParticipants = true;
        continue;
      }
      if (inParticipants) {
        const itemMatch = /^\s*-\s+["']?([^"'\r\n]+)["']?\s*$/.exec(line);
        if (itemMatch && itemMatch[1]) {
          const cleaned = cleanText(itemMatch[1], 80);
          if (cleaned && !isSelfIdentity(cleaned)) {
            participants.push(cleaned);
          }
        } else if (/^[a-zA-Z0-9_-]+:/.test(line)) {
          inParticipants = false;
        }
      } else {
        const inlineMatch = /^participants:\s*\[([^\]]+)\]\s*$/.exec(line);
        if (inlineMatch && inlineMatch[1]) {
          for (const part of inlineMatch[1].split(",")) {
            const cleaned = cleanText(part.replace(/^["'\s]+|["'\s]+$/g, ""), 80);
            if (cleaned && !isSelfIdentity(cleaned)) {
              participants.push(cleaned);
            }
          }
        }
      }
    }
  }

  const title = extractDocTitle(raw, filename);
  const time = occurredIso || `${day}T12:00:00Z`;

  return {
    day,
    time,
    end_time: endIso,
    title,
    participants: Array.from(new Set(participants)),
    doc_path: `wispr-flow/${filename}`,
    filename,
  };
}

function mergeDayMeetings(
  calendarMeetings: InternalMeetingRecord[],
  wisprMeetings: InternalWisprMeetingRecord[]
): ReplayMeetingItem[] {
  const merged: ReplayMeetingItem[] = calendarMeetings.map((m) => ({
    time: m.time,
    end_time: m.end_time,
    title: m.title,
    location: m.location,
    participants: [...m.participants],
    calendar: m.calendar,
  }));

  for (const wm of wisprMeetings) {
    const wmNorm = normalizeMeetingTitleKey(wm.title);
    const wmTimeMs = Date.parse(wm.time);
    let bestIdx = -1;
    let bestDeltaMs = Number.POSITIVE_INFINITY;

    for (let i = 0; i < merged.length; i++) {
      const cm = merged[i];
      if (cm.doc_path) continue;
      const cmNorm = normalizeMeetingTitleKey(cm.title);
      if (!wmNorm || !cmNorm) continue;
      const titleMatches =
        wmNorm === cmNorm ||
        (wmNorm.length >= 5 && cmNorm.includes(wmNorm)) ||
        (cmNorm.length >= 5 && wmNorm.includes(cmNorm));
      if (!titleMatches) continue;
      const cmTimeMs = Date.parse(cm.time);
      const deltaMs =
        Number.isFinite(wmTimeMs) && Number.isFinite(cmTimeMs) ? Math.abs(wmTimeMs - cmTimeMs) : 0;
      if (deltaMs < bestDeltaMs) {
        bestDeltaMs = deltaMs;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      const target = merged[bestIdx];
      target.doc_path = wm.doc_path;
      target.wispr_doc_path = wm.doc_path;
      target.source = "wispr-flow";
      const existingLower = new Set(target.participants.map((p) => p.toLowerCase()));
      for (const p of wm.participants) {
        if (!existingLower.has(p.toLowerCase())) {
          target.participants.push(p);
          existingLower.add(p.toLowerCase());
        }
      }
    } else {
      merged.push({
        time: wm.time,
        end_time: wm.end_time,
        title: wm.title,
        location: null,
        participants: [...wm.participants],
        calendar: "Wispr Flow",
        source: "wispr-flow",
        doc_path: wm.doc_path,
        wispr_doc_path: wm.doc_path,
      });
    }
  }

  return merged.sort((a, b) => a.time.localeCompare(b.time));
}

function isNearHome(lat: number, lng: number): boolean {
  return haversineKm(HOME_LAT, HOME_LNG, lat, lng) <= AWAY_THRESHOLD_KM;
}

function computeIntensity(day: {
  total_events: number;
  photo_count: number;
  meetings_count: number;
  places: string[];
}): 0 | 1 | 2 | 3 | 4 {
  const score =
    day.total_events +
    day.photo_count * 2 +
    day.meetings_count * 3 +
    (day.places.length > 0 ? 2 : 0);
  if (score <= 0) return 0;
  if (score <= 5) return 1;
  if (score <= 25) return 2;
  if (score <= 100) return 3;
  return 4;
}

export class KizukiReplayApi {
  readonly db: Database;
  readonly vaultPath: string;
  readonly bridgesDir: string;
  readonly antigravityJsonlPath: string;
  readonly lifeOsRoot: string;

  private snapshotStore: HotSnapshot<ReplayCacheSnapshot>;
  private indexResponseCache = new Map<string, { version: number; value: ReplayIndexResponse }>();
  private dayCache = new Map<string, { version: number; expiresAt: number; value: ReplayDayResponse }>();

  constructor(config: ReplayApiConfig) {
    this.db = config.db;
    this.vaultPath = config.vaultPath;
    this.bridgesDir = config.bridgesDir;
    this.antigravityJsonlPath =
      config.antigravityJsonlPath ||
      DEFAULT_ANTIGRAVITY_PATH ||
      join(config.vaultPath, ".kizuki", "evidence.jsonl");
    this.lifeOsRoot =
      config.lifeOsRoot ||
      process.env.KIZUKI_WORKSPACE_ROOT ||
      join(config.vaultPath, "workspace");
    this.snapshotStore = new HotSnapshot<ReplayCacheSnapshot>({
      name: "replay-index",
      checkIntervalMs: config.snapshotCheckIntervalMs ?? 5_000,
      fingerprint: () => this.computeFingerprint(),
      build: () => this.buildSnapshotSync(),
    });
  }

  clearCache(): void {
    this.snapshotStore.clear();
    this.indexResponseCache.clear();
    this.dayCache.clear();
  }

  markDirty(): void {
    this.snapshotStore.markDirty();
  }

  close(): void {
    this.snapshotStore.dispose();
  }

  dispose(): void {
    this.close();
  }

  private computeFingerprint(): string {
    const todayIso = new Date().toISOString().slice(0, 10);
    const statPart = (p: string): string => {
      try {
        const st = statSync(p);
        return `${st.size}:${Math.trunc(st.mtimeMs)}`;
      } catch {
        return "0:0";
      }
    };

    const parts: string[] = [
      todayIso,
      statPart(join(this.bridgesDir, "mac-locations", "events.jsonl")),
      statPart(join(this.bridgesDir, "google-maps-timeline", "events.jsonl")),
      statPart(join(this.bridgesDir, "whoop", "events.jsonl")),
      statPart(join(this.bridgesDir, "mac-calendar", "events.jsonl")),
      statPart(join(this.bridgesDir, "whatsapp", "events.jsonl")),
      statPart(join(this.bridgesDir, "telegram", "events.jsonl")),
      statPart(join(this.bridgesDir, "mac-imessage", "events.jsonl")),
      statPart(join(this.bridgesDir, "gmail", "events.jsonl")),
      statPart(join(this.bridgesDir, "antigravity", "events.jsonl")),
      statPart(join(this.vaultPath, "sources", "antigravity-sessions", "events.jsonl")),
      statPart(this.antigravityJsonlPath),
      statPart(join(this.vaultPath, "dashboards")),
      statPart(join(this.bridgesDir, "wispr-flow", "meetings")),
    ];

    try {
      const row = this.db
        .query(`SELECT COALESCE(MAX(rowid), 0) AS max_rowid, COUNT(*) AS cnt FROM events`)
        .get() as { max_rowid: number; cnt: number } | null;
      parts.push(row ? `${row.max_rowid}:${row.cnt}` : "0:0");
    } catch {
      parts.push("no-events");
    }

    return parts.join("|");
  }

  private getSnapshot(): ReplayCacheSnapshot {
    return this.snapshotStore.getSync(
      () => this.buildSnapshotSync(),
      () => this.computeFingerprint()
    );
  }

  private buildSnapshotSync(): ReplayCacheSnapshot {
    const now = Date.now();

    const todayIso = new Date().toISOString().slice(0, 10);
    const tomorrowIso = addDays(todayIso, 1);

    const sqlCountsByDay = new Map<string, { work: number; docs: number; legacy: number; total: number }>();
    try {
      const rows = this.db
        .query(
          `SELECT substr(occurred_at, 1, 10) AS day, connector_id, COUNT(*) AS cnt
           FROM events
           WHERE deleted = 0
             AND occurred_at >= '2015-01-01'
             AND occurred_at < ?
           GROUP BY day, connector_id`
        )
        .all(`${tomorrowIso}T00:00:00`) as Array<{ day: string; connector_id: string; cnt: number }>;

      for (const r of rows) {
        if (!r.day || !isValidDay(r.day) || r.day > todayIso) continue;
        const cur = sqlCountsByDay.get(r.day) || { work: 0, docs: 0, legacy: 0, total: 0 };
        const n = Number(r.cnt) || 0;
        if (r.connector_id === "kizuki.claude-code-sessions" || r.connector_id === "kizuki.codex-sessions") {
          cur.work += n;
          cur.total += n;
        } else if (r.connector_id === "kizuki.markdown-folder" || r.connector_id === "kizuki.import-legacy-wiki") {
          cur.docs += n;
          cur.total += n;
        } else {
          cur.legacy += n;
          cur.total += n;
        }
        sqlCountsByDay.set(r.day, cur);
      }
    } catch {
      // Allow empty/minimal test DBs without full events table
    }

    const locationsByDay = new Map<string, InternalLocationRecord[]>();
    const pushLoc = (rec: InternalLocationRecord) => {
      if (!isValidDay(rec.day) || rec.day > todayIso) return;
      const cleanedLabel = cleanPlaceLabel(rec.label, 120, {
        hasCoords: rec.lat !== null && rec.lng !== null,
      });
      if (!cleanedLabel) return;
      const arr = locationsByDay.get(rec.day) || [];
      arr.push({ ...rec, label: cleanedLabel });
      locationsByDay.set(rec.day, arr);
    };

    // 1. Mac Locations Bridge (Apple Photos Moments + GPS + Calendar physical places)
    const macLocPath = join(this.bridgesDir, "mac-locations", "events.jsonl");
    for (const obj of readJsonlSync(macLocPath)) {
      const day = typeof obj.day === "string" ? obj.day : "";
      if (!isValidDay(day) || day > todayIso) continue;
      const source = typeof obj.source === "string" ? obj.source : "apple-photos-moment";
      const startIso = normalizeIso(obj.start_iso, day) || `${day}T12:00:00Z`;
      const endIso = normalizeIso(obj.end_iso);
      const rawPlace = cleanText(obj.place, 140);
      const rawTitle = cleanText(obj.title, 140);
      const rawAddress = cleanText(obj.address, 200);
      const rawSub = cleanText(obj.subtitle, 120);
      let ll = validCoord(obj.lat, obj.lng);

      // Guard against VC room & non-place false positives even if older file exists
      if (
        source === "apple-calendar-place" &&
        (VIRTUAL_LOC_RE.test(`${rawPlace} ${rawAddress}`) ||
          (rawPlace && (NON_PLACE_LABEL_RE.test(rawPlace) || NON_PLACE_PREFIX_RE.test(rawPlace))))
      ) {
        continue;
      }

      const geoQuery = [rawPlace, rawAddress, rawTitle].filter(Boolean).join(" ");
      let geoHit: { lat: number; lng: number; label: string } | null = null;
      if (!ll && geoQuery) {
        geoHit = geocodeKnownPlace(geoQuery);
        if (geoHit) ll = { lat: geoHit.lat, lng: geoHit.lng };
      }

      const hasCoords = Boolean(ll);
      const label =
        cleanPlaceLabel(rawPlace, 120, { hasCoords }) ||
        cleanPlaceLabel(geoHit?.label, 120, { hasCoords }) ||
        cleanPlaceLabel(rawTitle, 120, { hasCoords }) ||
        (ll ? `GPS (${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)})` : "");
      if (!label) continue;
      const photoCount =
        typeof obj.photo_count === "number" && Number.isFinite(obj.photo_count) ? obj.photo_count : 0;

      pushLoc({
        id: cleanText(obj.id, 160) || `${source}:${day}:${label}`,
        day,
        start_iso: startIso,
        end_iso: endIso,
        label,
        address: rawAddress || null,
        detail: rawTitle && rawTitle !== label ? rawTitle : rawSub || null,
        lat: ll ? ll.lat : null,
        lng: ll ? ll.lng : null,
        photo_count: photoCount,
        source,
      });

      // If this is an outbound flight (e.g. "Flight to Miami (VS 5)" at "London LHR"),
      // also tag the destination city so multi-day trip detection links departure + return cleanly.
      if (source === "apple-calendar-place" && rawTitle) {
        const flightMatch = rawTitle.match(/\bflight\s+to\s+([A-Za-z][A-Za-z\s-]{2,30}?)(?:\s*\(|$)/i);
        if (flightMatch && flightMatch[1]) {
          const destGeo = geocodeKnownPlace(flightMatch[1]);
          if (destGeo && !isNearHome(destGeo.lat, destGeo.lng)) {
            pushLoc({
              id: `${cleanText(obj.id, 140)}:dest`,
              day,
              start_iso: endIso || startIso,
              end_iso: null,
              label: destGeo.label,
              address: null,
              detail: rawTitle,
              lat: destGeo.lat,
              lng: destGeo.lng,
              photo_count: 0,
              source: "apple-calendar-flight-dest",
              is_flight_destination: true,
            });
          }
        }
      }
    }

    // 2. Google Maps Timeline Bridge (if present)
    const gmapsPath = join(this.bridgesDir, "google-maps-timeline", "events.jsonl");
    const hasGoogleMapsImport = existsSync(gmapsPath) && statSync(gmapsPath).size > 0;
    if (hasGoogleMapsImport) {
      for (const obj of readJsonlSync(gmapsPath)) {
        const day = typeof obj.day === "string" ? obj.day : "";
        if (!isValidDay(day) || day > todayIso) continue;
        const startIso = normalizeIso(obj.start_iso ?? obj.occurred_at, day) || `${day}T12:00:00Z`;
        const endIso = normalizeIso(obj.end_iso);
        const ll = validCoord(obj.lat, obj.lng);
        const label =
          cleanPlaceLabel(obj.place ?? obj.label, 120) ||
          (ll ? `Google Maps (${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)})` : "Google Maps Place");
        pushLoc({
          id: cleanText(obj.id, 160) || `gmaps:${day}:${startIso}`,
          day,
          start_iso: startIso,
          end_iso: endIso,
          label,
          address: cleanText(obj.address, 200) || null,
          detail: cleanText(obj.detail ?? obj.activity_type, 120) || null,
          lat: ll ? ll.lat : null,
          lng: ll ? ll.lng : null,
          photo_count: 0,
          source: cleanText(obj.source, 64) || "google-maps-timeline",
        });
      }
    }

    // 3. Whoop Biometrics
    const whoopByDay = new Map<string, ReplayWhoopDay>();
    for (const obj of readJsonlSync(join(this.bridgesDir, "whoop", "events.jsonl"))) {
      const day = typeof obj.day === "string" ? obj.day : String(obj.occurred_at || "").slice(0, 10);
      if (!isValidDay(day) || day > todayIso) continue;
      const rec = typeof obj.recovery_score === "number" ? obj.recovery_score : null;
      const zone = typeof obj.zone === "string" ? cleanText(obj.zone, 24) : null;
      const hrv = typeof obj.hrv_ms === "number" ? Math.round(obj.hrv_ms * 10) / 10 : null;
      const rhr = typeof obj.rhr_bpm === "number" ? Math.round(obj.rhr_bpm) : null;
      const sleep = typeof obj.sleep_hours === "number" ? Math.round(obj.sleep_hours * 100) / 100 : null;
      const rawText = cleanText(obj.text, 280);
      const summaryParts: string[] = [];
      if (rec !== null) summaryParts.push(`Recovery ${rec}%${zone ? ` (${zone})` : ""}`);
      if (sleep !== null) summaryParts.push(`Sleep ${sleep}h`);
      if (hrv !== null) summaryParts.push(`HRV ${hrv}ms`);
      if (rhr !== null) summaryParts.push(`RHR ${rhr}bpm`);
      whoopByDay.set(day, {
        recovery_pct: rec,
        zone,
        hrv_ms: hrv,
        rhr_bpm: rhr,
        sleep_hours: sleep,
        summary: summaryParts.join(" | ") || rawText,
      });
    }

    // 4. Calendar Meetings (clamped strictly to past & today)
    const meetingsByDay = new Map<string, InternalMeetingRecord[]>();
    for (const obj of readJsonlSync(join(this.bridgesDir, "mac-calendar", "events.jsonl"))) {
      const occurredAt = normalizeIso(obj.occurred_at);
      if (!occurredAt) continue;
      const day = occurredAt.slice(0, 10);
      if (!isValidDay(day) || day > todayIso) continue;
      const rawText = String(obj.text || "");
      const titleMatch = rawText.match(/^#\s+(.+)$/m);
      const title = cleanText(titleMatch?.[1] || obj.title || "Calendar Event", 140);
      if (/^\s*cancell?ed\s*:/i.test(title)) continue;
      const endAt = normalizeIso(obj.end_at);
      const loc = cleanText(obj.location, 160) || null;
      const cal = cleanText(obj.calendar, 80) || null;
      const rawParts = typeof obj.participants === "string" ? obj.participants : "";
      const participants = rawParts
        .split(",")
        .map((p) => cleanText(p, 80))
        .filter((p) => p && !isSelfIdentity(p));

      const arr = meetingsByDay.get(day) || [];
      arr.push({
        day,
        time: occurredAt,
        end_time: endAt,
        title,
        location: loc,
        participants,
        calendar: cal,
      });
      meetingsByDay.set(day, arr);
    }

    // 5. Communications (WhatsApp, Telegram noise-filtered, iMessage, Gmail + Gmail Travel/Venue Receipts)
    const commsByDay = new Map<string, InternalCommRecord[]>();
    const pushComm = (item: InternalCommRecord) => {
      if (!isValidDay(item.day) || item.day > todayIso) return;
      const arr = commsByDay.get(item.day) || [];
      arr.push(item);
      commsByDay.set(item.day, arr);
    };

    // 5a. WhatsApp
    for (const obj of readJsonlSync(join(this.bridgesDir, "whatsapp", "events.jsonl"))) {
      const iso = normalizeIso(obj.occurred_at);
      if (!iso) continue;
      const day = iso.slice(0, 10);
      const rawText = stripEmDashes(String(obj.text || ""));
      const m = rawText.match(/^\[WhatsApp\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:\s*([\s\S]*)$/);
      const threadTitle = cleanText(m?.[1] || String(obj.channel || "WhatsApp").replace(/^whatsapp:/i, ""), 72);
      const sender = cleanText(m?.[2] || threadTitle, 64);
      const body = cleanText(m?.[3] ?? rawText, 180);
      if (!body) continue;
      const personName = isSelfIdentity(sender) ? threadTitle : sender;
      pushComm({
        day,
        time: iso,
        channel: "whatsapp",
        sender,
        thread_title: threadTitle,
        person_name: personName,
        person_key: slugify(personName),
        snippet: body,
      });
    }

    // 5b. Telegram (noise-filtered: skip crypto/trading mega-groups & bots)
    const tgRows = readJsonlSync(join(this.bridgesDir, "telegram", "events.jsonl"));
    const tgSendersByChannel = new Map<string, Set<string>>();
    for (const obj of tgRows) {
      const ch = String(obj.channel || "").toLowerCase();
      if (!ch) continue;
      const rawText = String(obj.text || "");
      const m = rawText.match(/^\[Telegram\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:/);
      if (m && m[2]) {
        const set = tgSendersByChannel.get(ch) || new Set<string>();
        if (set.size < 25) set.add(m[2].trim().toLowerCase());
        tgSendersByChannel.set(ch, set);
      }
    }
    for (const obj of tgRows) {
      const iso = normalizeIso(obj.occurred_at);
      if (!iso) continue;
      const day = iso.slice(0, 10);
      const ch = String(obj.channel || "").toLowerCase();
      const rawText = stripEmDashes(String(obj.text || ""));
      const m = rawText.match(/^\[Telegram\s*\|\s*([^|\]]+?)\s*\|\s*([^\]]+?)\]:\s*([\s\S]*)$/);
      const threadTitle = cleanText(m?.[1] || ch.replace(/^telegram:/i, ""), 72);
      const sender = cleanText(m?.[2] || threadTitle, 64);
      const body = cleanText(m?.[3] ?? rawText, 180);
      if (!body) continue;
      const hay = `${ch} ${threadTitle} ${sender}`.toLowerCase();
      if (
        NOISY_TELEGRAM_RE.test(hay) ||
        ch.replace(/^telegram:/i, "").endsWith("bot") ||
        sender.toLowerCase().endsWith("bot") ||
        (tgSendersByChannel.get(ch)?.size || 0) >= 20
      ) {
        continue;
      }
      const personName = isSelfIdentity(sender) ? threadTitle : sender;
      pushComm({
        day,
        time: iso,
        channel: "telegram",
        sender,
        thread_title: threadTitle,
        person_name: personName,
        person_key: slugify(personName),
        snippet: body,
      });
    }

    // 5c. iMessage
    for (const obj of readJsonlSync(join(this.bridgesDir, "mac-imessage", "events.jsonl"))) {
      const iso = normalizeIso(obj.occurred_at);
      if (!iso) continue;
      const day = iso.slice(0, 10);
      const rawText = stripEmDashes(String(obj.text || ""));
      const lines = rawText.split("\n");
      const body = cleanText(lines.length > 1 ? lines.slice(1).join(" ") : rawText, 180);
      if (!body) continue;
      const sender = cleanText(obj.sender, 64) || "iMessage";
      const chat = cleanText(obj.chat, 72) || sender;
      // Skip OTP / automated shortcodes
      if (/^(?:[A-Z0-9]{4,12}|noreply|verify|auth|apple)$/i.test(sender) && /\b(?:code|otp|verification)\b/i.test(body)) {
        continue;
      }
      const personName = isSelfIdentity(sender) ? chat : sender;
      pushComm({
        day,
        time: iso,
        channel: "imessage",
        sender,
        thread_title: chat,
        person_name: personName,
        person_key: slugify(personName),
        snippet: body,
      });
    }

    // 5d. Gmail (+ travel/venue receipt location extraction)
    for (const obj of readJsonlSync(join(this.bridgesDir, "gmail", "events.jsonl"))) {
      const iso = normalizeIso(obj.occurred_at);
      if (!iso) continue;
      const day = iso.slice(0, 10);
      const fromAddr = String(obj.from_addr || "");
      const toAddr = String(obj.to_addr || "");
      const subject = cleanText(obj.subject_line, 140) || "Email";
      const rawText = stripEmDashes(String(obj.text || ""));
      const fromParsed = parseEmailAddress(fromAddr);
      const toParsed = parseEmailAddress(toAddr);
      const counterparty = isSelfIdentity(fromParsed.email || fromParsed.name) ? toParsed : fromParsed;

      // Extract Gmail travel/venue receipts into location trail
      const hay = `${fromAddr} ${subject}`;
      if (GMAIL_RECEIPT_RE.test(hay) && !GMAIL_PROMO_RE.test(hay)) {
        const venueGeo = geocodeKnownPlace(`${subject} ${rawText.slice(0, 400)}`);
        const cleanedSubject = subject.replace(/^\[Personal\]\s*/i, "");
        const venueLabel = venueGeo
          ? cleanPlaceLabel(venueGeo.label, 90, { hasCoords: true })
          : cleanPlaceLabel(cleanedSubject, 90, { hasCoords: false });
        if (venueLabel) {
          pushLoc({
            id: `gmail-venue:${cleanText(obj.id, 80) || `${day}:${slugify(subject)}`}`,
            day,
            start_iso: iso,
            end_iso: null,
            label: venueLabel,
            address: null,
            detail: subject,
            lat: venueGeo ? venueGeo.lat : null,
            lng: venueGeo ? venueGeo.lng : null,
            photo_count: 0,
            source: "gmail-receipt",
          });
        }
      }

      // Filter obvious newsletter/promo spam from comms count
      const isAutomatedPromo =
        /(?:noreply|no-reply|newsletter|marketing|promotions|digest|notifications?@)/i.test(fromParsed.email) &&
        GMAIL_PROMO_RE.test(subject);
      if (isAutomatedPromo) continue;

      pushComm({
        day,
        time: iso,
        channel: "gmail",
        sender: fromParsed.name,
        thread_title: subject,
        person_name: counterparty.name,
        person_key: slugify(counterparty.email || counterparty.name),
        snippet: subject,
      });
    }

    // Same-day nearby photo GPS fallback for any Calendar / Gmail place still missing lat/lng
    for (const [, recs] of locationsByDay) {
      const photoCoord = recs.find(
        (r) =>
          (r.source === "apple-photos-moment" || r.source === "apple-photos-gps") &&
          r.lat !== null &&
          r.lng !== null
      );
      if (!photoCoord) continue;
      for (const r of recs) {
        if (r.lat === null || r.lng === null) {
          r.lat = photoCoord.lat;
          r.lng = photoCoord.lng;
        }
      }
    }

    // 6. Antigravity Neon sessions (check all 3 candidate paths)
    const antigravityByDay = new Map<string, InternalAntigravityRecord[]>();
    const agCandidates = [
      join(this.bridgesDir, "antigravity", "events.jsonl"),
      join(this.vaultPath, "sources", "antigravity-sessions", "events.jsonl"),
      this.antigravityJsonlPath,
    ];
    const seenAgIds = new Set<string>();
    for (const p of agCandidates) {
      if (!existsSync(p)) continue;
      for (const obj of readJsonlSync(p)) {
        const id = cleanText(obj.id, 120);
        if (id && seenAgIds.has(id)) continue;
        if (id) seenAgIds.add(id);
        const iso = normalizeIso(obj.occurred_at);
        if (!iso) continue;
        const day = iso.slice(0, 10);
        if (!isValidDay(day) || day > todayIso) continue;
        const text = cleanText(obj.text, 260);
        if (!text || BOILERPLATE_WORK_RE.test(text)) continue;
        const convMatch = id.match(/^antigravity:([^:]+)/);
        const convId = convMatch ? convMatch[1] : id || "neon";
        const role = /\bUSER\b|\bRequest\b/i.test(text.slice(0, 40)) ? "user" : "assistant";
        const arr = antigravityByDay.get(day) || [];
        arr.push({ day, time: iso, conv_id: convId, role, text });
        antigravityByDay.set(day, arr);
      }
    }

    // 7. Daily Briefs in Vault dashboards (and optional LifeOS daily/voice/backtrack notes)
    const briefsByDay = new Map<string, { path: string; title: string; time: string }>();
    const dashboardsDir = join(this.vaultPath, "dashboards");
    if (existsSync(dashboardsDir)) {
      try {
        for (const f of readdirSync(dashboardsDir)) {
          const m = f.match(/^brief-(\d{4}-\d{2}-\d{2})\.md$/);
          if (m && isValidDay(m[1]) && m[1] <= todayIso) {
            briefsByDay.set(m[1], {
              path: join("dashboards", f),
              title: `Daily Brief (${m[1]})`,
              time: `${m[1]}T07:00:00Z`,
            });
          }
        }
      } catch {
        // ignore
      }
    }

    // 7b. Wispr Flow Notetaker meeting transcripts
    const wisprMeetingsByDay = new Map<string, InternalWisprMeetingRecord[]>();
    const wisprMeetingsDir = join(this.bridgesDir, "wispr-flow", "meetings");
    if (existsSync(wisprMeetingsDir)) {
      try {
        for (const f of readdirSync(wisprMeetingsDir)) {
          if (!f.toLowerCase().endsWith(".md")) continue;
          const rec = parseWisprMeetingMarkdown(join(wisprMeetingsDir, f), f, todayIso);
          if (!rec) continue;
          const arr = wisprMeetingsByDay.get(rec.day) || [];
          arr.push(rec);
          wisprMeetingsByDay.set(rec.day, arr);
        }
      } catch {
        // ignore unreadable wispr meetings dir
      }
    }

    // Merge all active days across every source (strictly past & today: day <= todayIso)
    const daySet = new Set<string>();
    for (const d of sqlCountsByDay.keys()) daySet.add(d);
    for (const d of locationsByDay.keys()) daySet.add(d);
    for (const d of whoopByDay.keys()) daySet.add(d);
    for (const d of commsByDay.keys()) daySet.add(d);
    for (const d of meetingsByDay.keys()) daySet.add(d);
    for (const d of wisprMeetingsByDay.keys()) daySet.add(d);
    for (const d of antigravityByDay.keys()) daySet.add(d);
    for (const d of briefsByDay.keys()) daySet.add(d);

    const maxAllowedDay = todayIso;
    const activeDaysSortedAsc = Array.from(daySet)
      .filter((d) => d >= "2009-01-01" && d <= maxAllowedDay)
      .sort();

    const allDays = new Map<string, ReplayIndexDay>();
    const allMapPoints: ReplayMapPoint[] = [];
    const yearsSet = new Set<number>();

    for (const day of activeDaysSortedAsc) {
      const year = Number(day.slice(0, 4));
      if (Number.isFinite(year)) yearsSet.add(year);

      const sql = sqlCountsByDay.get(day) || { work: 0, docs: 0, legacy: 0, total: 0 };
      const locs = locationsByDay.get(day) || [];
      const whoop = whoopByDay.get(day) || null;
      const comms = commsByDay.get(day) || [];
      const calMeetings = meetingsByDay.get(day) || [];
      const wisprMeetings = wisprMeetingsByDay.get(day) || [];
      const meetings = mergeDayMeetings(calMeetings, wisprMeetings);
      const ag = antigravityByDay.get(day) || [];
      const brief = briefsByDay.get(day) || null;

      const workCount = sql.work + ag.length;
      const commsCount = comms.length;
      const meetingsCount = meetings.length;
      const docsCount = sql.docs + (brief ? 1 : 0) + wisprMeetings.length;

      let photoCount = 0;
      const placeLabels: string[] = [];
      const seenLabels = new Set<string>();
      const coords: ReplayCoord[] = [];
      const dayMapPoints: ReplayMapPoint[] = [];

      for (const loc of locs) {
        photoCount += loc.photo_count;
        const cleanLbl = cleanPlaceLabel(loc.label, 80, {
          hasCoords: loc.lat !== null && loc.lng !== null,
        });
        if (!cleanLbl) continue;
        if (!seenLabels.has(cleanLbl.toLowerCase())) {
          seenLabels.add(cleanLbl.toLowerCase());
          placeLabels.push(cleanLbl);
        }
        if (loc.lat !== null && loc.lng !== null && !loc.is_flight_destination) {
          // Deduplicate same-day pins within 200m (0.2 km) so the map never renders overlapping labels for the same spot
          const normLbl = cleanLbl.toLowerCase();
          const nearIdx = dayMapPoints.findIndex((existing) => {
            const distKm = haversineKm(existing.lat, existing.lng, loc.lat!, loc.lng!);
            if (distKm > 0.2) return false;
            const exNorm = existing.label.toLowerCase();
            return (
              exNorm === normLbl ||
              exNorm.includes(normLbl) ||
              normLbl.includes(exNorm) ||
              /^gps\s*\(/i.test(exNorm) ||
              /^gps\s*\(/i.test(normLbl) ||
              distKm <= 0.05
            );
          });
          if (nearIdx >= 0) {
            const ex = dayMapPoints[nearIdx];
            ex.photo_count = Math.max(ex.photo_count, loc.photo_count);
            if (/^gps\s*\(/i.test(ex.label) && !/^gps\s*\(/i.test(cleanLbl)) {
              ex.label = cleanLbl;
              coords[nearIdx].label = cleanLbl;
            }
          } else {
            coords.push({ lat: loc.lat, lng: loc.lng, label: cleanLbl });
            dayMapPoints.push({
              day,
              lat: loc.lat,
              lng: loc.lng,
              label: cleanLbl,
              source: loc.source,
              photo_count: loc.photo_count,
            });
          }
        }
      }
      for (const mp of dayMapPoints) allMapPoints.push(mp);

      // Pick primary_place: prefer specific non-Home away place, else first named place
      const primaryPlace = this.pickPrimaryPlace(locs);

      const totalEvents =
        workCount +
        commsCount +
        meetingsCount +
        docsCount +
        locs.filter((l) => !l.is_flight_destination).length +
        (whoop ? 1 : 0);

      const headline = this.buildDayHeadline({
        primaryPlace,
        meetings,
        workCount,
        commsCount,
        photoCount,
        whoop,
      });

      const intensity = computeIntensity({
        total_events: totalEvents,
        photo_count: photoCount,
        meetings_count: meetingsCount,
        places: placeLabels,
      });

      allDays.set(day, {
        day,
        total_events: totalEvents,
        work_count: workCount,
        comms_count: commsCount,
        meetings_count: meetingsCount,
        docs_count: docsCount,
        photo_count: photoCount,
        places: placeLabels,
        primary_place: primaryPlace,
        coords,
        whoop_recovery: whoop?.recovery_pct ?? null,
        whoop_zone: whoop?.zone ?? null,
        whoop_sleep: whoop?.sleep_hours ?? null,
        headline,
        intensity,
      });
    }

    const allTrips = this.detectTrips(activeDaysSortedAsc, locationsByDay);
    const availableYears = Array.from(yearsSet).sort((a, b) => b - a);

    const snapshot: ReplayCacheSnapshot = {
      builtAt: now,
      hasGoogleMapsImport,
      activeDaysSortedAsc,
      sqlCountsByDay,
      locationsByDay,
      whoopByDay,
      commsByDay,
      meetingsByDay,
      wisprMeetingsByDay,
      antigravityByDay,
      briefsByDay,
      allDays,
      allTrips,
      allMapPoints,
      availableYears,
    };
    return snapshot;
  }

  private pickPrimaryPlace(locs: InternalLocationRecord[]): string | null {
    if (locs.length === 0) return null;
    // Prefer away-from-home physical places with non-generic labels
    const nonDest = locs.filter((l) => !l.is_flight_destination);
    const basePool = nonDest.length > 0 ? nonDest : locs;
    const pool = basePool
      .map((l) => ({
        ...l,
        cleanedLabel: cleanPlaceLabel(l.label, 80, {
          hasCoords: l.lat !== null && l.lng !== null,
        }),
      }))
      .filter((l) => Boolean(l.cleanedLabel));
    if (pool.length === 0) return null;

    const awayNamed = pool.find(
      (l) =>
        l.lat !== null &&
        l.lng !== null &&
        !isNearHome(l.lat, l.lng) &&
        !/^(?:home|gps\s*\()/i.test(l.cleanedLabel)
    );
    if (awayNamed) return awayNamed.cleanedLabel;

    const nonHomeNamed = pool.find((l) => !/^(?:home|gps\s*\(|london$)/i.test(l.cleanedLabel));
    if (nonHomeNamed) return nonHomeNamed.cleanedLabel;

    const anyNamed = pool.find((l) => !/^gps\s*\(/i.test(l.cleanedLabel));
    return anyNamed ? anyNamed.cleanedLabel : pool[0].cleanedLabel;
  }

  private buildDayHeadline(opts: {
    primaryPlace: string | null;
    meetings: Array<{ title: string }>;
    workCount: number;
    commsCount: number;
    photoCount: number;
    whoop: ReplayWhoopDay | null;
  }): string {
    const parts: string[] = [];
    if (opts.primaryPlace && opts.primaryPlace.toLowerCase() !== "home") {
      parts.push(opts.primaryPlace);
    }
    if (opts.meetings.length > 0) {
      const topMeeting = cleanText(opts.meetings[0].title, 48);
      parts.push(opts.meetings.length === 1 ? topMeeting : `${topMeeting} +${opts.meetings.length - 1} mtgs`);
    }
    if (opts.workCount >= 10) {
      parts.push(`${opts.workCount} build events`);
    } else if (opts.photoCount >= 5) {
      parts.push(`${opts.photoCount} photos`);
    } else if (opts.commsCount >= 5) {
      parts.push(`${opts.commsCount} messages`);
    }
    if (parts.length === 0 && opts.primaryPlace) {
      parts.push(opts.primaryPlace);
    }
    if (parts.length === 0 && opts.whoop?.recovery_pct !== null && opts.whoop?.recovery_pct !== undefined) {
      parts.push(`Recovery ${opts.whoop.recovery_pct}%`);
    }
    return parts.join(" | ") || "Quiet day";
  }

  private detectTrips(
    activeDaysAsc: string[],
    locationsByDay: Map<string, InternalLocationRecord[]>
  ): ReplayTrip[] {
    interface AwayDayAnchor {
      day: string;
      lat: number;
      lng: number;
      place: string;
      photo_count: number;
      highlights: string[];
    }

    const awayDays: AwayDayAnchor[] = [];
    for (const day of activeDaysAsc) {
      const locs = locationsByDay.get(day) || [];
      const awayLocs = locs.filter(
        (l) => l.lat !== null && l.lng !== null && !isNearHome(l.lat, l.lng)
      );
      if (awayLocs.length === 0) continue;

      // Pick the farthest / most photo-rich away point as anchor
      awayLocs.sort((a, b) => {
        const scoreA = (a.photo_count || 0) * 3 + (a.is_flight_destination ? 1 : 5);
        const scoreB = (b.photo_count || 0) * 3 + (b.is_flight_destination ? 1 : 5);
        return scoreB - scoreA;
      });
      const anchor = awayLocs[0];
      const highlights: string[] = [];
      for (const l of awayLocs) {
        if (l.label && !highlights.includes(l.label)) highlights.push(l.label);
        if (l.detail && !highlights.includes(l.detail)) highlights.push(l.detail);
      }

      awayDays.push({
        day,
        lat: anchor.lat!,
        lng: anchor.lng!,
        place: anchor.label,
        photo_count: awayLocs.reduce((acc, l) => acc + l.photo_count, 0),
        highlights,
      });
    }

    if (awayDays.length === 0) return [];

    // Cluster away days into trips (gap <= 5 days AND distance <= 350km)
    const clusters: AwayDayAnchor[][] = [];
    for (const ad of awayDays) {
      const prevCluster = clusters[clusters.length - 1];
      if (!prevCluster) {
        clusters.push([ad]);
        continue;
      }
      const last = prevCluster[prevCluster.length - 1];
      const gap = diffDays(last.day, ad.day);
      const dist = haversineKm(last.lat, last.lng, ad.lat, ad.lng);
      if (gap <= 5 && dist <= 350) {
        prevCluster.push(ad);
      } else {
        clusters.push([ad]);
      }
    }

    const trips: ReplayTrip[] = [];
    for (const cluster of clusters) {
      const startDay = cluster[0].day;
      const endDay = cluster[cluster.length - 1].day;
      const daysCount = Math.max(1, diffDays(startDay, endDay) + 1);

      const placeFreq = new Map<string, { count: number; photos: number; lat: number; lng: number }>();
      const highlightSet = new Set<string>();
      let totalPhotos = 0;

      for (const item of cluster) {
        totalPhotos += item.photo_count;
        const key = item.place.toLowerCase();
        const prev = placeFreq.get(key);
        if (!prev) {
          placeFreq.set(key, { count: 1, photos: item.photo_count, lat: item.lat, lng: item.lng });
        } else {
          prev.count += 1;
          prev.photos += item.photo_count;
        }
        for (const h of item.highlights) {
          if (highlightSet.size < 6) highlightSet.add(h);
        }
      }

      const rankedPlaces = Array.from(placeFreq.entries())
        .map(([k, v]) => {
          const original = cluster.find((c) => c.place.toLowerCase() === k)?.place || k;
          return { name: original, ...v };
        })
        .sort((a, b) => b.photos - a.photos || b.count - a.count);

      const primary = rankedPlaces[0];
      const second = rankedPlaces[1];
      const primaryClean = cleanPlaceLabel(primary.name, 72);
      const secondClean = second ? cleanPlaceLabel(second.name, 72) : "";
      const title =
        secondClean && !primaryClean.toLowerCase().includes(secondClean.toLowerCase())
          ? `${primaryClean} & ${secondClean}`
          : primaryClean;

      trips.push({
        id: `trip:${startDay}:${slugify(primaryClean)}`,
        title,
        start_day: startDay,
        end_day: endDay,
        days_count: daysCount,
        primary_place: primaryClean,
        lat: primary.lat,
        lng: primary.lng,
        photo_count: totalPhotos,
        highlights: Array.from(highlightSet).map((h) => cleanPlaceLabel(h, 80)),
      });
    }

    return trips.sort((a, b) => (a.start_day < b.start_day ? 1 : a.start_day > b.start_day ? -1 : 0));
  }

  getReplayIndex(opts?: { year?: number; months?: number }): ReplayIndexResponse {
    const snap = this.getSnapshot();
    const snapVersion = this.snapshotStore.version;
    const todayIso = new Date().toISOString().slice(0, 10);
    const cacheKey = `${opts?.year ?? ""}|${opts?.months ?? ""}|${todayIso}`;
    const cached = this.indexResponseCache.get(cacheKey);
    if (cached && cached.version === snapVersion) {
      return cached.value;
    }

    const currentYear = new Date().getUTCFullYear();
    const defaultYear =
      snap.availableYears.find((y) => y <= currentYear) ?? snap.availableYears[0] ?? currentYear;
    const selectedYear =
      typeof opts?.year === "number" && Number.isFinite(opts.year) ? Math.trunc(opts.year) : defaultYear;

    let minDay = `${selectedYear}-01-01`;
    let maxDay = `${selectedYear}-12-31`;
    if (maxDay > todayIso) maxDay = todayIso;
    if (typeof opts?.months === "number" && Number.isFinite(opts.months) && opts.months > 0 && opts?.year === undefined) {
      const now = new Date();
      const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - Math.trunc(opts.months), now.getUTCDate()));
      minDay = start.toISOString().slice(0, 10);
      maxDay = todayIso;
    }

    const days: ReplayIndexDay[] = [];
    for (let i = snap.activeDaysSortedAsc.length - 1; i >= 0; i--) {
      const d = snap.activeDaysSortedAsc[i];
      if (d < minDay || d > maxDay) continue;
      const item = snap.allDays.get(d);
      if (item) days.push(item);
    }

    const mapPoints = snap.allMapPoints.filter((p) => p.day >= minDay && p.day <= maxDay);
    const trips = snap.allTrips.filter((t) => t.end_day >= minDay && t.start_day <= maxDay);

    // Compute top places within selected range
    const placeAgg = new Map<
      string,
      { label: string; days: Set<string>; last_day: string; lat: number | null; lng: number | null; photo_count: number }
    >();
    for (const d of days) {
      const locs = snap.locationsByDay.get(d.day) || [];
      for (const l of locs) {
        if (l.is_flight_destination) continue;
        const lbl = cleanPlaceLabel(l.label, 80);
        if (!lbl || /^gps\s*\(/i.test(lbl)) continue;
        const key = lbl.toLowerCase();
        const cur = placeAgg.get(key) || {
          label: lbl,
          days: new Set<string>(),
          last_day: d.day,
          lat: l.lat,
          lng: l.lng,
          photo_count: 0,
        };
        cur.days.add(d.day);
        if (d.day > cur.last_day) cur.last_day = d.day;
        if (cur.lat === null && l.lat !== null) {
          cur.lat = l.lat;
          cur.lng = l.lng;
        }
        cur.photo_count += l.photo_count;
        placeAgg.set(key, cur);
      }
    }

    const topPlaces: ReplayTopPlace[] = Array.from(placeAgg.values())
      .map((p) => ({
        label: p.label,
        visits: p.days.size,
        last_day: p.last_day,
        lat: p.lat,
        lng: p.lng,
        photo_count: p.photo_count,
      }))
      .sort((a, b) => b.visits - a.visits || b.photo_count - a.photo_count)
      .slice(0, 24);

    // Archive-wide stats
    const totalGpsDays = new Set(snap.allMapPoints.map((p) => p.day)).size;
    const allDistinctPlaces = new Set<string>();
    let totalEventsAll = 0;
    for (const dayItem of snap.allDays.values()) {
      totalEventsAll += dayItem.total_events;
      for (const pl of dayItem.places) allDistinctPlaces.add(pl.toLowerCase());
    }

    const response: ReplayIndexResponse = {
      available_years: snap.availableYears,
      selected_year: selectedYear,
      stats: {
        total_days_with_activity: snap.activeDaysSortedAsc.length,
        total_gps_days: totalGpsDays,
        total_places: allDistinctPlaces.size,
        total_trips: snap.allTrips.length,
        total_events: totalEventsAll,
        date_min: snap.activeDaysSortedAsc[0] ?? null,
        date_max: snap.activeDaysSortedAsc[snap.activeDaysSortedAsc.length - 1] ?? null,
        has_google_maps_import: snap.hasGoogleMapsImport,
      },
      days,
      trips,
      top_places: topPlaces,
      map_points: mapPoints,
    };

    if (this.indexResponseCache.size > 32) {
      this.indexResponseCache.clear();
    }
    this.indexResponseCache.set(cacheKey, { version: snapVersion, value: response });
    return response;
  }

  getReplayDay(day: string): ReplayDayResponse {
    if (!isValidDay(day)) {
      throw new Error(`Invalid day format: "${day}". Expected YYYY-MM-DD.`);
    }

    const snap = this.getSnapshot();
    const snapVersion = this.snapshotStore.version;
    const now = Date.now();
    const cached = this.dayCache.get(day);
    if (cached && cached.version === snapVersion && cached.expiresAt > now) {
      return cached.value;
    }

    const nextDay = addDays(day, 1);

    // Neighbor active days
    let prevActiveDay: string | null = null;
    let nextActiveDay: string | null = null;
    for (const d of snap.activeDaysSortedAsc) {
      if (d < day) prevActiveDay = d;
      else if (d > day) {
        nextActiveDay = d;
        break;
      }
    }

    // 1. Places (cleaned labels, deduplicating identical same-day spots within 200m)
    const rawLocs = (snap.locationsByDay.get(day) || []).filter((l) => !l.is_flight_destination);
    const places: ReplayPlaceItem[] = [];
    let photoCount = 0;
    for (const l of rawLocs) {
      photoCount += l.photo_count;
      const cleanLbl = cleanPlaceLabel(l.label, 80, {
        hasCoords: l.lat !== null && l.lng !== null,
      });
      if (!cleanLbl) continue;
      const normLbl = cleanLbl.toLowerCase();
      const dupIdx = places.findIndex((existing) => {
        if (existing.label.toLowerCase() !== normLbl) return false;
        if (existing.lat !== null && existing.lng !== null && l.lat !== null && l.lng !== null) {
          return haversineKm(existing.lat, existing.lng, l.lat, l.lng) <= 0.2;
        }
        return extractHhmm(existing.time) === extractHhmm(l.start_iso) || existing.source === l.source;
      });
      if (dupIdx >= 0) {
        places[dupIdx].photo_count = Math.max(places[dupIdx].photo_count, l.photo_count);
        if (!places[dupIdx].detail && l.detail) places[dupIdx].detail = l.detail;
        continue;
      }
      places.push({
        time: l.start_iso,
        end_time: l.end_iso,
        label: cleanLbl,
        address: l.address,
        lat: l.lat,
        lng: l.lng,
        photo_count: l.photo_count,
        source: l.source,
        detail: l.detail,
      });
    }
    places.sort((a, b) => a.time.localeCompare(b.time));

    // 2. Whoop
    const whoop = snap.whoopByDay.get(day) || null;

    // 3. Meetings (Calendar + Wispr Flow Notetaker transcripts)
    const wisprDayMeetings = snap.wisprMeetingsByDay.get(day) || [];
    const meetings: ReplayMeetingItem[] = mergeDayMeetings(
      snap.meetingsByDay.get(day) || [],
      wisprDayMeetings
    );

    // 4. Comms + People
    const rawComms = (snap.commsByDay.get(day) || []).sort((a, b) => a.time.localeCompare(b.time));
    const comms: ReplayCommItem[] = rawComms.map((c) => ({
      time: c.time,
      channel: c.channel,
      sender: c.sender,
      thread_title: c.thread_title,
      snippet: c.snippet,
    }));

    const peopleMap = new Map<
      string,
      { name: string; key: string; channels: Set<string>; count: number; latest_time: string; latest_snippet: string }
    >();
    for (const c of rawComms) {
      if (isSelfIdentity(c.person_name)) continue;
      const cur = peopleMap.get(c.person_key) || {
        name: c.person_name,
        key: c.person_key,
        channels: new Set<string>(),
        count: 0,
        latest_time: c.time,
        latest_snippet: c.snippet,
      };
      cur.channels.add(c.channel);
      cur.count += 1;
      if (c.time >= cur.latest_time) {
        cur.latest_time = c.time;
        cur.latest_snippet = c.snippet;
      }
      peopleMap.set(c.person_key, cur);
    }
    // Include meeting participants in people map too
    for (const m of meetings) {
      for (const p of m.participants) {
        const parsed = parseEmailAddress(p);
        if (isSelfIdentity(parsed.email || parsed.name)) continue;
        const key = slugify(parsed.email || parsed.name);
        const cur = peopleMap.get(key) || {
          name: parsed.name,
          key,
          channels: new Set<string>(),
          count: 0,
          latest_time: m.time,
          latest_snippet: `Meeting: ${m.title}`,
        };
        cur.channels.add("calendar");
        cur.count += 1;
        peopleMap.set(key, cur);
      }
    }
    const people: ReplayPersonItem[] = Array.from(peopleMap.values())
      .map((p) => ({
        name: p.name,
        key: p.key,
        channels: Array.from(p.channels).sort(),
        count: p.count,
        latest_snippet: p.latest_snippet,
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    // 5. Work & Docs from SQLite events on that exact day + Antigravity + Daily Brief
    const workSessions = new Map<
      string,
      { time: string; source: string; project: string; title: string; summary: string; count: number }
    >();
    const docs: ReplayDocItem[] = [];
    const seenDocPaths = new Set<string>();

    try {
      const dayEvents = this.db
        .query(
          `SELECT connector_id, source_record_id, kind, occurred_at, text, metadata
           FROM events
           WHERE deleted = 0
             AND occurred_at >= ?
             AND occurred_at < ?
           ORDER BY occurred_at ASC
           LIMIT 2500`
        )
        .all(`${day}T00:00:00`, `${nextDay}T00:00:00`) as Array<{
        connector_id: string;
        source_record_id: string;
        kind: string;
        occurred_at: string;
        text: string;
        metadata: string;
      }>;

      for (const ev of dayEvents) {
        let meta: Record<string, unknown> = {};
        try {
          meta = JSON.parse(ev.metadata || "{}") as Record<string, unknown>;
        } catch {
          meta = {};
        }

        if (ev.connector_id === "kizuki.claude-code-sessions" || ev.connector_id === "kizuki.codex-sessions") {
          const text = stripEmDashes(ev.text || "").trim();
          if (!text || BOILERPLATE_WORK_RE.test(text)) continue;

          const snippet = extractFirstMeaningfulLine(text, 160);
          if (!snippet || BOILERPLATE_WORK_RE.test(snippet)) continue;

          const sessionId =
            (typeof meta.session_id === "string" && meta.session_id) ||
            ev.source_record_id.split("/")[0] ||
            ev.source_record_id;
          const sourceLabel = ev.connector_id === "kizuki.claude-code-sessions" ? "claude-code" : "codex";
          const sKey = `${sourceLabel}:${sessionId}`;
          const existing = workSessions.get(sKey);
          if (!existing) {
            const project = inferProjectName(text, meta, ev.connector_id);
            workSessions.set(sKey, {
              time: ev.occurred_at,
              source: sourceLabel,
              project,
              title: cleanText(snippet, 90) || `${project} session`,
              summary: snippet,
              count: 1,
            });
          } else {
            existing.count += 1;
            if (existing.summary.length < 40 && snippet.length > existing.summary.length) {
              existing.summary = snippet;
            }
          }
        } else if (ev.connector_id === "kizuki.markdown-folder" || ev.connector_id === "kizuki.import-legacy-wiki") {
          const relPath =
            (typeof meta.relpath === "string" && meta.relpath) || ev.source_record_id;
          if (seenDocPaths.has(relPath)) continue;
          seenDocPaths.add(relPath);
          const title = extractDocTitle(ev.text || "", relPath);
          const category =
            ev.connector_id === "kizuki.import-legacy-wiki"
              ? "wiki"
              : /source:\s*apple-notes/i.test(ev.text || "")
                ? "apple-notes"
                : "obsidian";
          docs.push({
            path: relPath,
            title,
            category,
            time: ev.occurred_at,
          });
        }
      }
    } catch {
      // Allow minimal DBs in isolated unit tests
    }

    // Add Antigravity Neon sessions on this day
    const agDay = snap.antigravityByDay.get(day) || [];
    for (const item of agDay) {
      if (BOILERPLATE_WORK_RE.test(item.text)) continue;
      const sKey = `antigravity:${item.conv_id}`;
      const existing = workSessions.get(sKey);
      const snippet = extractFirstMeaningfulLine(item.text, 160);
      if (!snippet || BOILERPLATE_WORK_RE.test(snippet)) continue;
      if (!existing) {
        const project = inferProjectName(item.text, {}, "antigravity");
        workSessions.set(sKey, {
          time: item.time,
          source: "antigravity-neon",
          project,
          title: cleanText(snippet, 90) || "Antigravity Neon session",
          summary: snippet,
          count: 1,
        });
      } else {
        existing.count += 1;
      }
    }

    // Add Daily Brief doc if present
    const brief = snap.briefsByDay.get(day);
    if (brief && !seenDocPaths.has(brief.path)) {
      seenDocPaths.add(brief.path);
      docs.push({
        path: brief.path,
        title: brief.title,
        category: "daily-brief",
        time: brief.time,
      });
    }

    // Add Wispr Flow meeting transcripts for this day
    for (const wm of wisprDayMeetings) {
      if (seenDocPaths.has(wm.doc_path)) continue;
      seenDocPaths.add(wm.doc_path);
      docs.push({
        path: wm.doc_path,
        title: wm.title,
        category: "wispr-flow",
        time: wm.time,
      });
    }

    const work: ReplayWorkItem[] = Array.from(workSessions.values()).sort((a, b) =>
      a.time.localeCompare(b.time)
    );
    docs.sort((a, b) => a.time.localeCompare(b.time));

    // 6. Kizuki Claims created on this day
    const claims: ReplayClaimItem[] = [];
    try {
      const claimRows = this.db
        .query(
          `SELECT c.created_at, c.kind, c.target, c.body, s.predicate, s.payload
           FROM claims c
           LEFT JOIN claim_v2_semantics s ON c.claim_id = s.claim_id
           WHERE c.status = 'live'
             AND c.created_at >= ?
             AND c.created_at < ?
           ORDER BY c.created_at ASC
           LIMIT 200`
        )
        .all(`${day}T00:00:00`, `${nextDay}T00:00:00`) as Array<{
        created_at: string;
        kind: string;
        target: string | null;
        body: string;
        predicate: string | null;
        payload: string | null;
      }>;

      const seenClaimText = new Set<string>();
      for (const r of claimRows) {
        let text = cleanText(r.body, 220);
        if (!text && r.payload) {
          try {
            const p = JSON.parse(r.payload) as { object?: { value?: unknown; ref?: { id?: string } } };
            if (typeof p.object?.value === "string") {
              text = cleanText(p.object.value, 220);
            } else if (typeof p.object?.ref?.id === "string") {
              text = cleanText(p.object.ref.id, 120);
            }
          } catch {
            // ignore malformed payload
          }
        }
        if (!text || text === "Referenced in a captured source." || text === "world/situation") continue;
        const dedup = text.toLowerCase();
        if (seenClaimText.has(dedup)) continue;
        seenClaimText.add(dedup);
        claims.push({
          time: r.created_at,
          kind: cleanText(r.predicate || r.kind, 64) || "claim",
          target: r.target ? cleanText(r.target, 100) : null,
          text,
        });
        if (claims.length >= 40) break;
      }
    } catch {
      // Allow minimal DBs without claim_v2_semantics
    }

    // 7. Unified chronological 00:00 -> 23:59 storyboard timeline
    const timeline: ReplayTimelineItem[] = [];

    if (whoop) {
      timeline.push({
        time: `${day}T07:00:00Z`,
        hhmm: "07:00",
        kind: "health",
        title:
          whoop.recovery_pct !== null
            ? `Whoop Recovery ${whoop.recovery_pct}%${whoop.zone ? ` (${whoop.zone})` : ""}`
            : "Whoop Daily Check-in",
        detail: whoop.summary,
        meta: whoop.sleep_hours !== null ? `${whoop.sleep_hours}h sleep` : null,
      });
    }

    for (const p of places) {
      timeline.push({
        time: p.time,
        hhmm: extractHhmm(p.time),
        kind: "place",
        title: p.label,
        detail: p.detail || p.address || (p.photo_count > 0 ? `${p.photo_count} photos captured` : p.source),
        meta: p.photo_count > 0 ? `${p.photo_count} photos` : p.source,
        lat: p.lat,
        lng: p.lng,
      });
    }

    for (const m of meetings) {
      timeline.push({
        time: m.time,
        hhmm: extractHhmm(m.time),
        kind: "meeting",
        title: m.title,
        detail: m.location || (m.participants.length > 0 ? `With ${m.participants.slice(0, 3).join(", ")}` : "Calendar event"),
        meta: m.calendar,
      });
    }

    for (const w of work.slice(0, 20)) {
      timeline.push({
        time: w.time,
        hhmm: extractHhmm(w.time),
        kind: "work",
        title: `${w.project}: ${w.title}`,
        detail: w.summary,
        meta: `${w.source} (${w.count} msgs)`,
      });
    }

    // Group comms lightly so timeline stays vivid without flooding
    const commSample = comms.length <= 24 ? comms : comms.filter((_, idx) => idx % Math.ceil(comms.length / 24) === 0);
    for (const c of commSample) {
      timeline.push({
        time: c.time,
        hhmm: extractHhmm(c.time),
        kind: "comms",
        title: `${c.sender} (${c.channel})`,
        detail: c.snippet,
        meta: c.thread_title,
      });
    }

    for (const d of docs.slice(0, 12)) {
      timeline.push({
        time: d.time,
        hhmm: extractHhmm(d.time),
        kind: "doc",
        title: d.title,
        detail: d.path,
        meta: d.category,
      });
    }

    timeline.sort((a, b) => a.time.localeCompare(b.time));

    // 8. Cached AI story markdown if present
    const storyPath = join(this.vaultPath, "world", "replay", `${day}.md`);
    let storyMd: string | null = null;
    if (existsSync(storyPath)) {
      try {
        storyMd = stripEmDashes(readFileSync(storyPath, "utf8"));
      } catch {
        storyMd = null;
      }
    }

    const primaryLocation = this.pickPrimaryPlace(rawLocs);
    const totalEvents =
      places.length +
      meetings.length +
      work.reduce((acc, w) => acc + w.count, 0) +
      comms.length +
      docs.length +
      (whoop ? 1 : 0);

    const headline = this.buildDayHeadline({
      primaryPlace: primaryLocation,
      meetings,
      workCount: work.reduce((acc, w) => acc + w.count, 0),
      commsCount: comms.length,
      photoCount,
      whoop,
    });

    const result: ReplayDayResponse = {
      day,
      weekday: getWeekday(day),
      prev_active_day: prevActiveDay,
      next_active_day: nextActiveDay,
      summary: {
        headline,
        primary_location: primaryLocation,
        total_events: totalEvents,
        work_sessions: work.length,
        messages_count: comms.length,
        meetings_count: meetings.length,
        docs_count: docs.length,
        photo_count: photoCount,
        claims_count: claims.length,
      },
      places,
      whoop,
      work,
      meetings,
      people,
      comms,
      docs,
      claims,
      timeline,
      story_md: storyMd,
    };

    this.dayCache.set(day, { version: snapVersion, expiresAt: now + CACHE_TTL_MS, value: result });
    return result;
  }

  buildReplayDayStoryPrompt(dayPacket: ReplayDayResponse): string {
    const humanDate = formatHumanDate(dayPacket.day);
    const lines: string[] = [
      `Synthesize a grounded, vivid personal life replay narrative for: "What happened on ${humanDate}".`,
      `Rules:`,
      `- Ground every single statement strictly in the telemetry below. Never invent events, times, or conversations.`,
      `- Use ZERO em-dashes anywhere in your response. Use commas, colons, parentheses, or hyphens instead.`,
      `- Keep prose crisp, concrete, and high-signal (numbers, places, names, shipped artifacts).`,
      `- Output Markdown with these exact six headings:`,
      `## Day at a Glance`,
      `## Where You Were`,
      `## What You Worked On & Shipped`,
      `## People & Conversations`,
      `## Body & Rhythm`,
      `## Open Threads Carried Forward`,
      ``,
      `### Ground-Truth Telemetry (${dayPacket.day}, ${dayPacket.weekday})`,
      `Headline: ${dayPacket.summary.headline}`,
      `Primary Location: ${dayPacket.summary.primary_location || "Not recorded"}`,
      `Counts: ${dayPacket.summary.total_events} total events, ${dayPacket.summary.work_sessions} work sessions, ${dayPacket.summary.meetings_count} meetings, ${dayPacket.summary.messages_count} messages, ${dayPacket.summary.docs_count} docs, ${dayPacket.summary.photo_count} photos, ${dayPacket.summary.claims_count} claims.`,
    ];

    if (dayPacket.whoop) {
      lines.push(`Whoop Biometrics: ${dayPacket.whoop.summary}`);
    }

    if (dayPacket.places.length > 0) {
      lines.push(``, `#### Places`);
      for (const p of dayPacket.places.slice(0, 15)) {
        const ll = p.lat !== null && p.lng !== null ? ` (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})` : "";
        const ph = p.photo_count > 0 ? ` [${p.photo_count} photos]` : "";
        lines.push(`- ${extractHhmm(p.time)} ${p.label}${ll}${ph}${p.detail ? `: ${p.detail}` : ""}`);
      }
    }

    if (dayPacket.meetings.length > 0) {
      lines.push(``, `#### Meetings`);
      for (const m of dayPacket.meetings.slice(0, 12)) {
        lines.push(
          `- ${extractHhmm(m.time)} ${m.title}${m.location ? ` @ ${m.location}` : ""}${
            m.participants.length > 0 ? ` (${m.participants.slice(0, 4).join(", ")})` : ""
          }`
        );
      }
    }

    if (dayPacket.work.length > 0) {
      lines.push(``, `#### Work & Building`);
      for (const w of dayPacket.work.slice(0, 12)) {
        lines.push(`- ${extractHhmm(w.time)} [${w.source} / ${w.project}] (${w.count} msgs): ${w.summary}`);
      }
    }

    if (dayPacket.people.length > 0) {
      lines.push(``, `#### People Contacted`);
      for (const p of dayPacket.people.slice(0, 12)) {
        lines.push(`- ${p.name} (${p.channels.join("/")}, ${p.count}x): ${p.latest_snippet}`);
      }
    }

    if (dayPacket.docs.length > 0) {
      lines.push(``, `#### Docs Modified`);
      for (const d of dayPacket.docs.slice(0, 10)) {
        lines.push(`- [${d.category}] ${d.title} (${d.path})`);
      }
    }

    if (dayPacket.claims.length > 0) {
      lines.push(``, `#### Kizuki Claims Captured`);
      for (const c of dayPacket.claims.slice(0, 12)) {
        lines.push(`- [${c.kind}] ${c.text}`);
      }
    }

    return stripEmDashes(lines.join("\n"));
  }

  saveReplayDayStory(day: string, md: string): { ok: true; day: string; path: string; bytes: number } {
    if (!isValidDay(day)) {
      throw new Error(`Invalid day format: "${day}". Expected YYYY-MM-DD.`);
    }
    const cleanMd = stripEmDashes(String(md || "")).trim() + "\n";
    const outPath = join(this.vaultPath, "world", "replay", `${day}.md`);
    writeAtomicPrivate(outPath, cleanMd);
    this.dayCache.delete(day);
    return {
      ok: true,
      day,
      path: outPath,
      bytes: Buffer.byteLength(cleanMd, "utf8"),
    };
  }

  importGoogleMapsTimeline(payload: unknown): GoogleMapsImportResult {
    if (!payload || typeof payload !== "object") {
      throw new Error("Google Maps Timeline payload must be a JSON object.");
    }
    const obj = payload as Record<string, unknown>;
    const normalized: Array<{
      id: string;
      source: string;
      start_iso: string;
      end_iso: string | null;
      day: string;
      place: string | null;
      address: string | null;
      detail: string | null;
      lat: number;
      lng: number;
    }> = [];

    let format: "semanticSegments" | "timelineObjects" | "records";

    if (Array.isArray(obj.semanticSegments)) {
      format = "semanticSegments";
      const pathPointsByDay = new Map<string, Array<{ iso: string; lat: number; lng: number }>>();

      for (let i = 0; i < obj.semanticSegments.length; i++) {
        const seg = obj.semanticSegments[i] as Record<string, unknown>;
        if (!seg || typeof seg !== "object") continue;
        const startIso = normalizeIso(seg.startTime);
        const endIso = normalizeIso(seg.endTime);

        // Visit candidate
        const visit = seg.visit as Record<string, unknown> | undefined;
        if (visit && typeof visit === "object" && startIso) {
          const top = (visit.topCandidate || {}) as Record<string, unknown>;
          const ll = parseLatLngValue(top.placeLocation) || parseLatLngValue(visit.placeLocation);
          if (ll) {
            const day = startIso.slice(0, 10);
            const placeName =
              cleanText(top.semanticType, 80) ||
              cleanText(top.placeId, 80) ||
              `Visited Place (${ll.lat.toFixed(3)}, ${ll.lng.toFixed(3)})`;
            normalized.push({
              id: `gmaps:seg:visit:${day}:${startIso}:${i}`,
              source: "google-maps-visit",
              start_iso: startIso,
              end_iso: endIso,
              day,
              place: placeName,
              address: null,
              detail: cleanText(top.semanticType, 80) || null,
              lat: ll.lat,
              lng: ll.lng,
            });
          }
        }

        // Activity candidate
        const activity = seg.activity as Record<string, unknown> | undefined;
        if (activity && typeof activity === "object" && startIso) {
          const startLl = parseLatLngValue(activity.start);
          const endLl = parseLatLngValue(activity.end);
          const top = (activity.topCandidate || {}) as Record<string, unknown>;
          const actType = cleanText(top.type, 64) || "MOVE";
          if (startLl) {
            const day = startIso.slice(0, 10);
            normalized.push({
              id: `gmaps:seg:act:start:${day}:${startIso}:${i}`,
              source: "google-maps-activity",
              start_iso: startIso,
              end_iso: endIso,
              day,
              place: `Activity (${actType})`,
              address: null,
              detail: actType,
              lat: startLl.lat,
              lng: startLl.lng,
            });
          }
          if (endLl && endIso) {
            const day = endIso.slice(0, 10);
            normalized.push({
              id: `gmaps:seg:act:end:${day}:${endIso}:${i}`,
              source: "google-maps-activity",
              start_iso: endIso,
              end_iso: null,
              day,
              place: `Arrived (${actType})`,
              address: null,
              detail: actType,
              lat: endLl.lat,
              lng: endLl.lng,
            });
          }
        }

        // timelinePath waypoints
        if (Array.isArray(seg.timelinePath)) {
          for (const pt of seg.timelinePath) {
            if (!pt || typeof pt !== "object") continue;
            const ptObj = pt as Record<string, unknown>;
            const ptIso = normalizeIso(ptObj.time) || startIso;
            const ll = parseLatLngValue(ptObj.point);
            if (!ptIso || !ll) continue;
            const day = ptIso.slice(0, 10);
            const arr = pathPointsByDay.get(day) || [];
            arr.push({ iso: ptIso, lat: ll.lat, lng: ll.lng });
            pathPointsByDay.set(day, arr);
          }
        }
      }

      // Downsample timelinePath to max 12 waypoints/day
      for (const [day, pts] of pathPointsByDay) {
        pts.sort((a, b) => a.iso.localeCompare(b.iso));
        const step = Math.max(1, Math.ceil(pts.length / 12));
        for (let idx = 0; idx < pts.length; idx += step) {
          const p = pts[idx];
          normalized.push({
            id: `gmaps:seg:path:${day}:${p.iso}:${idx}`,
            source: "google-maps-path",
            start_iso: p.iso,
            end_iso: null,
            day,
            place: `Path (${p.lat.toFixed(3)}, ${p.lng.toFixed(3)})`,
            address: null,
            detail: "Timeline path waypoint",
            lat: p.lat,
            lng: p.lng,
          });
        }
      }
    } else if (Array.isArray(obj.timelineObjects)) {
      format = "timelineObjects";
      for (let i = 0; i < obj.timelineObjects.length; i++) {
        const item = obj.timelineObjects[i] as Record<string, unknown>;
        if (!item || typeof item !== "object") continue;

        const pv = item.placeVisit as Record<string, unknown> | undefined;
        if (pv && typeof pv === "object") {
          const loc = (pv.location || {}) as Record<string, unknown>;
          const dur = (pv.duration || {}) as Record<string, unknown>;
          const ll = parseLatLngValue(loc);
          const startIso = normalizeIso(dur.startTimestamp ?? dur.startTimestampMs);
          const endIso = normalizeIso(dur.endTimestamp ?? dur.endTimestampMs);
          if (ll && startIso) {
            const day = startIso.slice(0, 10);
            normalized.push({
              id: `gmaps:to:visit:${day}:${startIso}:${i}`,
              source: "google-maps-visit",
              start_iso: startIso,
              end_iso: endIso,
              day,
              place: cleanText(loc.name, 120) || cleanText(loc.address, 120) || "Visited Place",
              address: cleanText(loc.address, 200) || null,
              detail: null,
              lat: ll.lat,
              lng: ll.lng,
            });
          }
        }

        const act = item.activitySegment as Record<string, unknown> | undefined;
        if (act && typeof act === "object") {
          const dur = (act.duration || {}) as Record<string, unknown>;
          const startIso = normalizeIso(dur.startTimestamp ?? dur.startTimestampMs);
          const endIso = normalizeIso(dur.endTimestamp ?? dur.endTimestampMs);
          const actType = cleanText(act.activityType, 64) || "MOVE";
          const startLl = parseLatLngValue(act.startLocation);
          const endLl = parseLatLngValue(act.endLocation);
          if (startLl && startIso) {
            const day = startIso.slice(0, 10);
            normalized.push({
              id: `gmaps:to:act:start:${day}:${startIso}:${i}`,
              source: "google-maps-activity",
              start_iso: startIso,
              end_iso: endIso,
              day,
              place: `Activity (${actType})`,
              address: null,
              detail: actType,
              lat: startLl.lat,
              lng: startLl.lng,
            });
          }
          if (endLl && endIso) {
            const day = endIso.slice(0, 10);
            normalized.push({
              id: `gmaps:to:act:end:${day}:${endIso}:${i}`,
              source: "google-maps-activity",
              start_iso: endIso,
              end_iso: null,
              day,
              place: `Arrived (${actType})`,
              address: null,
              detail: actType,
              lat: endLl.lat,
              lng: endLl.lng,
            });
          }
        }
      }
    } else if (Array.isArray(obj.locations)) {
      format = "records";
      const byDay = new Map<string, Array<{ iso: string; lat: number; lng: number }>>();
      for (const raw of obj.locations) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const ll = parseLatLngValue(r);
        const iso = normalizeIso(r.timestamp ?? r.timestampMs);
        if (!ll || !iso) continue;
        const day = iso.slice(0, 10);
        if (!isValidDay(day)) continue;
        const arr = byDay.get(day) || [];
        arr.push({ iso, lat: ll.lat, lng: ll.lng });
        byDay.set(day, arr);
      }

      // Downsample evenly to max 12 waypoints per day
      for (const [day, pts] of byDay) {
        pts.sort((a, b) => a.iso.localeCompare(b.iso));
        const maxPerDay = 12;
        const step = pts.length <= maxPerDay ? 1 : pts.length / maxPerDay;
        const pickedCount = Math.min(maxPerDay, pts.length);
        for (let k = 0; k < pickedCount; k++) {
          const p = pts[Math.min(pts.length - 1, Math.floor(k * step))];
          normalized.push({
            id: `gmaps:rec:${day}:${p.iso}:${k}`,
            source: "google-maps-record",
            start_iso: p.iso,
            end_iso: null,
            day,
            place: `Waypoint (${p.lat.toFixed(3)}, ${p.lng.toFixed(3)})`,
            address: null,
            detail: "Google Takeout Records.json waypoint",
            lat: p.lat,
            lng: p.lng,
          });
        }
      }
    } else {
      throw new Error(
        "Unrecognized Google Maps Timeline JSON format. Expected semanticSegments, timelineObjects, or locations."
      );
    }

    // Deduplicate by id & sort chronologically
    const dedup = new Map<string, (typeof normalized)[number]>();
    for (const r of normalized) {
      if (!isValidDay(r.day)) continue;
      if (!dedup.has(r.id)) dedup.set(r.id, r);
    }
    const sorted = Array.from(dedup.values()).sort((a, b) =>
      a.start_iso.localeCompare(b.start_iso) || a.id.localeCompare(b.id)
    );

    const outPath = join(this.bridgesDir, "google-maps-timeline", "events.jsonl");
    const content = sorted.map((r) => JSON.stringify(r)).join("\n") + (sorted.length > 0 ? "\n" : "");
    writeAtomicPrivate(outPath, content);
    this.clearCache();

    const uniqueDays = new Set(sorted.map((r) => r.day)).size;
    return {
      ok: true,
      imported_count: sorted.length,
      unique_days: uniqueDays,
      format,
    };
  }
}
