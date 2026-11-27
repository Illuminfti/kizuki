import { join, resolve, sep } from "node:path";
import { stat } from "node:fs/promises";
import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "./contracts.ts";
import { AssetStore, finalizeResponse } from "./http-wire.ts";
import {
  BadRequestError,
  ForbiddenError,
  KizukiVaultApi,
  NotFoundError,
  ServiceUnavailableError,
  type ActionMutationRequest,
  type DocSaveRequest,
  type DraftRequest,
  type InteractRequest,
  type PersonNoteRequest,
  type PersonSynthesizeRequest,
  type VaultApiConfig,
} from "./vault-api.ts";
import { KizukiReplayApi, type ReplayDayResponse } from "./replay-api.ts";
import {
  KizukiCodexApi,
  type CodexItem,
  type CodexPromoteRequest,
  type CodexSynthesizeMode,
  type CodexUpsertRequest,
} from "./codex-api.ts";
import {
  KizukiTasteApi,
  type SubmitAnswerRequest,
  type UpsertRuleRequest,
} from "./taste-api.ts";
import { KizukiTasteGardenerApi } from "./gardener-api.ts";
import {
  KizukiAgentBoardApi,
  SecretDetectedError,
  type AgentBoardConfig,
  type PostMessageRequest,
  type ReplyToThreadRequest,
} from "./agent-board-api.ts";
import {
  KizukiBoardMindBridge,
  type BoardMindBridgeConfig,
  type BoardOmniHit,
  type DispatchMindItemRequest,
  type EntityThreadKind,
  type MindLink,
  type PromoteThreadToCodexRequest,
  type SignalKind,
} from "./board-mind-bridge.ts";

export const DEFAULT_PORT = Number(process.env.KIZUKI_PORT || process.env.PORT || 8797);
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PUBLIC_DIR = resolve(process.env.KIZUKI_EXPLORER_PUBLIC || join(import.meta.dir, "public"));
const MAX_REPLAY_IMPORT_BYTES = 30 * 1024 * 1024;

function stripEmDashes(input: string): string {
  return input.replace(/\s*\u2014\s*/g, " - ").replace(/\u2014/g, "-");
}

function isValidReplayDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function formatTimeShort(iso: string): string {
  const m = /T(\d{2}:\d{2})/.exec(iso || "");
  return m ? m[1] : "";
}

function pluralizeCount(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural || `${singular}s`)}`;
}

function buildDeterministicReplayStory(dayPacket: ReplayDayResponse): string {
  const s = dayPacket.summary;
  const lines: string[] = [
    "## Day at a Glance",
    `- **Date**: ${dayPacket.day} (${dayPacket.weekday})`,
    `- **Headline**: ${s.headline || "Recorded activity day"}`,
    `- **Primary Location**: ${s.primary_location || "Not recorded"}`,
    `- **Activity Totals**: ${pluralizeCount(s.total_events, "event")}, ${pluralizeCount(s.work_sessions, "work session")}, ${pluralizeCount(s.meetings_count, "meeting")}, ${pluralizeCount(s.messages_count, "message")}, ${pluralizeCount(s.docs_count, "doc")}, ${pluralizeCount(s.photo_count, "photo")}, ${pluralizeCount(s.claims_count, "claim")}.`,
    "",
    "## Where You Were",
  ];

  if (dayPacket.places.length > 0) {
    for (const p of dayPacket.places.slice(0, 12)) {
      const hhmm = formatTimeShort(p.time);
      const coords = p.lat !== null && p.lng !== null ? ` (${p.lat.toFixed(4)}, ${p.lng.toFixed(4)})` : "";
      const photos = p.photo_count > 0 ? ` [${p.photo_count} photos]` : "";
      const detail = p.detail ? `: ${p.detail}` : "";
      lines.push(`- ${hhmm ? `${hhmm} ` : ""}**${p.label}**${coords}${photos}${detail}`);
    }
  } else {
    lines.push("- No location telemetry recorded for this day.");
  }

  lines.push("", "## What You Worked On & Shipped");
  if (dayPacket.work.length > 0 || dayPacket.docs.length > 0) {
    for (const w of dayPacket.work.slice(0, 10)) {
      const hhmm = formatTimeShort(w.time);
      lines.push(
        `- ${hhmm ? `${hhmm} ` : ""}[${w.source} / ${w.project}] (${w.count} ${w.count === 1 ? "turn" : "turns"}): ${w.summary || w.title}`
      );
    }
    for (const d of dayPacket.docs.slice(0, 8)) {
      lines.push(`- Doc [${d.category}]: **${d.title}** (\`${d.path}\`)`);
    }
  } else {
    lines.push("- No coding sessions or vault document updates recorded for this day.");
  }

  lines.push("", "## People & Conversations");
  if (dayPacket.people.length > 0 || dayPacket.meetings.length > 0) {
    for (const m of dayPacket.meetings.slice(0, 8)) {
      const hhmm = formatTimeShort(m.time);
      const loc = m.location ? ` @ ${m.location}` : "";
      const who = m.participants.length > 0 ? ` (${m.participants.slice(0, 4).join(", ")})` : "";
      lines.push(`- Meeting ${hhmm ? `${hhmm} ` : ""}**${m.title}**${loc}${who}`);
    }
    for (const p of dayPacket.people.slice(0, 10)) {
      lines.push(`- **${p.name}** (${p.channels.join("/")}, ${p.count}x): ${p.latest_snippet}`);
    }
  } else {
    lines.push("- No direct conversations or calendar meetings recorded for this day.");
  }

  lines.push("", "## Body & Rhythm");
  if (dayPacket.whoop) {
    lines.push(`- ${dayPacket.whoop.summary}`);
  } else {
    lines.push("- No Whoop biometric telemetry recorded for this day.");
  }

  lines.push("", "## Open Threads Carried Forward");
  if (dayPacket.claims.length > 0) {
    for (const c of dayPacket.claims.slice(0, 10)) {
      lines.push(`- [${c.kind}] ${c.text}`);
    }
  } else {
    const navParts: string[] = [];
    if (dayPacket.prev_active_day) navParts.push(`previous active day ${dayPacket.prev_active_day}`);
    if (dayPacket.next_active_day) navParts.push(`next active day ${dayPacket.next_active_day}`);
    const navSuffix = navParts.length > 0 ? ` (${navParts.join(", ")})` : "";
    lines.push(`- No explicit Kizuki claims captured on this date${navSuffix}.`);
  }

  return stripEmDashes(lines.join("\n")).trim();
}

const ALLOWED_CODEX_SYNTH_MODES = new Set<CodexSynthesizeMode>(["sharpen", "next_moves", "challenge"]);
const ALLOWED_BOARD_SIGNAL_KINDS = new Set<SignalKind>([
  "telemetry",
  "decision",
  "debate",
  "rsi",
  "taste",
  "debrief",
  "work",
]);

function parseOptionalBoolParam(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  return undefined;
}

function groupMindLinksToEntities(mindLinks: MindLink[]) {
  const people: Array<{ key: string; id: string; name: string; snippet: string }> = [];
  const vaultDocs: Array<{ path: string; id: string; title: string; snippet: string }> = [];
  const codexEntries: Array<{ id: string; title: string; summary: string }> = [];
  const tasteRules: Array<{ id: string; domain: string; title: string; summary: string }> = [];
  const replayDays: Array<{ day: string; id: string; title: string; summary: string }> = [];
  const commits: Array<{ sha: string; shortSha: string; id: string; message: string }> = [];

  for (const link of mindLinks) {
    if (link.kind === "person") {
      people.push({ key: link.target, id: link.id, name: link.label, snippet: link.excerpt });
    } else if (link.kind === "vault") {
      vaultDocs.push({ path: link.target, id: link.id, title: link.label, snippet: link.excerpt });
    } else if (link.kind === "codex") {
      codexEntries.push({ id: link.target, title: link.label, summary: link.excerpt });
    } else if (link.kind === "taste") {
      tasteRules.push({ id: link.id, domain: link.target, title: link.label, summary: link.excerpt });
    } else if (link.kind === "replay") {
      replayDays.push({ day: link.target, id: link.id, title: link.label, summary: link.excerpt });
    } else if (link.kind === "commit") {
      commits.push({
        sha: link.target,
        shortSha: link.target.slice(0, 7),
        id: link.id,
        message: link.excerpt,
      });
    }
  }

  return { people, vaultDocs, codexEntries, tasteRules, replayDays, commits };
}

function buildDeterministicCodexBrief(item: CodexItem, mode: CodexSynthesizeMode): string {
  const people = item.linked_people.length > 0 ? item.linked_people.join(", ") : "solo execution";
  const thesis = item.thesis || item.summary || item.title;
  const antiPattern = item.anti_pattern || "Vague scope without a concrete verification artifact or deadline.";
  const nextMove = item.next_move || `Ship a concrete verifiable artifact for ${item.title} and test with ${people}.`;

  if (mode === "next_moves") {
    return stripEmDashes(
      [
        `### Next Moves: ${item.title}`,
        `- **Move 1 (Highest Leverage)**: ${nextMove}`,
        `- **Move 2 (Stakeholder Sync)**: Align with ${people} in ${item.domain} around one concrete deliverable.`,
        `- **Move 3 (Proof Gate)**: Define a falsifiable pass/fail metric before investing another week.`,
      ].join("\n")
    );
  }

  if (mode === "challenge") {
    return stripEmDashes(
      [
        `### Challenge: ${item.title}`,
        `- **Counter-Thesis**: ${thesis} may consume high-leverage attention without compounding distribution in ${item.domain}.`,
        `- **Hidden Risk**: ${antiPattern}`,
        `- **Kill / Prove Test**: Run a 72-hour empirical check on "${nextMove}" and cut if signal is flat.`,
      ].join("\n")
    );
  }

  return stripEmDashes(
    [
      `### Sharpened Thesis: ${item.title}`,
      `- **Core Thesis**: ${thesis}`,
      `- **Anti-Pattern to Avoid**: ${antiPattern}`,
      `- **Single Next Decision**: ${nextMove}`,
    ].join("\n")
  );
}

const JSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

function jsonResponse(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders ? { ...JSON_HEADERS, ...extraHeaders } : JSON_HEADERS,
  });
}

function extractHostname(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return "";
  if (trimmed.startsWith("[")) {
    const closeIdx = trimmed.indexOf("]");
    return closeIdx !== -1 ? trimmed.slice(0, closeIdx + 1) : trimmed;
  }
  const firstColon = trimmed.indexOf(":");
  const lastColon = trimmed.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    return trimmed.slice(0, firstColon);
  }
  return trimmed;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}

function parseAllowedOrigins(): { origins: Set<string>; hostnames: Set<string> } {
  const origins = new Set<string>();
  const hostnames = new Set<string>();
  const raw = process.env.KIZUKI_ALLOWED_ORIGINS || "";
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      const parsed = new URL(trimmed);
      origins.add(parsed.origin.toLowerCase());
      hostnames.add(extractHostname(parsed.host));
    } catch {
      // Ignore malformed KIZUKI_ALLOWED_ORIGINS entry
    }
  }
  return { origins, hostnames };
}

export function enforceMutationOriginGuard(
  req: Request,
  url: URL,
  configuredHost?: string,
): Response | null {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return null;
  }
  if (method === "OPTIONS") {
    return jsonResponse({ error: "Cross-origin preflight rejected" }, 403);
  }

  const { origins: allowedOrigins, hostnames: allowedOriginHostnames } = parseAllowedOrigins();

  // a. Trusted Host check (DNS rebinding guard)
  const rawHost =
    req.headers.get("x-forwarded-host") || req.headers.get("host") || url.host || "";
  const effectiveHost = rawHost.split(",")[0].trim();
  const hostname = extractHostname(effectiveHost);
  const configuredHostname = configuredHost ? extractHostname(configuredHost) : "";
  const isTailscaleHost = hostname.endsWith(".ts.net") && hostname.length > ".ts.net".length;
  const isConfiguredMatch =
    Boolean(configuredHostname) &&
    (hostname === configuredHostname ||
      hostname.replace(/^\[|\]$/g, "") === configuredHostname.replace(/^\[|\]$/g, ""));

  if (
    !hostname ||
    (!isLoopbackHostname(hostname) &&
      !isConfiguredMatch &&
      !isTailscaleHost &&
      !allowedOriginHostnames.has(hostname))
  ) {
    return jsonResponse({ error: "Untrusted Host header rejected" }, 403);
  }

  // b. Sec-Fetch-Site check
  const secFetchSite = req.headers.get("sec-fetch-site");
  if (secFetchSite !== null) {
    const site = secFetchSite.trim().toLowerCase();
    if (site !== "same-origin" && site !== "none") {
      return jsonResponse({ error: "Cross-site mutation rejected" }, 403);
    }
  }

  // c. Origin check
  const originHeader = req.headers.get("origin");
  if (originHeader !== null) {
    const originTrimmed = originHeader.trim();
    if (!originTrimmed || originTrimmed.toLowerCase() === "null") {
      return jsonResponse({ error: "Cross-origin mutation rejected" }, 403);
    }
    let originUrl: URL;
    try {
      originUrl = new URL(originTrimmed);
    } catch {
      return jsonResponse({ error: "Cross-origin mutation rejected" }, 403);
    }
    if (
      originUrl.host.toLowerCase() !== effectiveHost.toLowerCase() &&
      !allowedOrigins.has(originUrl.origin.toLowerCase())
    ) {
      return jsonResponse({ error: "Cross-origin mutation rejected" }, 403);
    }
  } else {
    // d. Referer check (defense-in-depth when Origin is absent)
    const refererHeader = req.headers.get("referer");
    if (refererHeader !== null && refererHeader.trim() !== "") {
      let refererUrl: URL;
      try {
        refererUrl = new URL(refererHeader.trim());
      } catch {
        return jsonResponse({ error: "Cross-origin referer rejected" }, 403);
      }
      if (
        refererUrl.host.toLowerCase() !== effectiveHost.toLowerCase() &&
        !allowedOrigins.has(refererUrl.origin.toLowerCase())
      ) {
        return jsonResponse({ error: "Cross-origin referer rejected" }, 403);
      }
    }
  }

  // e. Non-CORS-simple credential / Content-Type check
  const rawContentType = req.headers.get("content-type") || "";
  const mediaType = rawContentType.split(";")[0].trim().toLowerCase();
  if (
    mediaType === "text/plain" ||
    mediaType === "application/x-www-form-urlencoded" ||
    mediaType === "multipart/form-data"
  ) {
    return jsonResponse(
      { error: "Unsupported Content-Type for mutation; use application/json" },
      415,
    );
  }

  const hasCustomHeader = Boolean(
    (req.headers.get("x-kizuki-request") || "").trim() ||
      (req.headers.get("x-requested-with") || "").trim(),
  );
  if (mediaType !== "application/json" && !hasCustomHeader) {
    return jsonResponse(
      { error: "Mutation requires application/json Content-Type or X-Kizuki-Request header" },
      403,
    );
  }

  return null;
}

async function serveStatic(req: Request, url: URL, assetStore: AssetStore): Promise<Response> {
  const virtualRes = await assetStore.serveVirtualBundle(req, url);
  if (virtualRes) return virtualRes;

  let decoded: string;
  try {
    decoded = decodeURIComponent(url.pathname);
  } catch {
    return jsonResponse({ error: "Invalid URL encoding" }, 400);
  }

  const rel = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const resolvedBase = assetStore.publicDir;
  const candidate = resolve(resolvedBase, rel);

  if (candidate !== resolvedBase && !candidate.startsWith(resolvedBase + sep)) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }

  let target = candidate;
  try {
    const st = await stat(target);
    if (st.isDirectory()) {
      target = join(target, "index.html");
      await stat(target);
    }
  } catch {
    // SPA fallback to index.html for non-asset routes
    if (!rel.includes(".")) {
      const indexPath = join(resolvedBase, "index.html");
      try {
        await stat(indexPath);
        target = indexPath;
      } catch {
        return new Response("Not Found", {
          status: 404,
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
    } else {
      return new Response("Not Found", {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  }

  if (target.endsWith("index.html")) {
    return assetStore.serveIndexHtml(req, url, target);
  }

  const entry = await assetStore.getFileEntry(target);
  if (!entry) {
    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return assetStore.serveEntry(req, url, entry);
}

export interface ExplorerServerOptions {
  port?: number;
  hostname?: string;
  publicDir?: string;
  vaultConfig?: VaultApiConfig;
  agentBoardConfig?: Partial<AgentBoardConfig>;
  boardBridgeConfig?: Partial<
    Omit<BoardMindBridgeConfig, "agentBoardApi" | "vaultApi" | "codexApi" | "tasteApi">
  >;
}

export function createExplorerApp(opts: ExplorerServerOptions = {}) {
  const api = new KizukiVaultApi(opts.vaultConfig);
  const replayApi = new KizukiReplayApi({
    db: api.getDb(),
    vaultPath: api.vaultPath,
    bridgesDir: api.bridgesDir,
    antigravityJsonlPath: api.antigravityJsonlPath,
  });
  const codexApi = new KizukiCodexApi({
    vaultPath: api.vaultPath,
    bridgesDir: api.bridgesDir,
    db: api.getDb(),
  });
  const tasteApi = new KizukiTasteApi({ vaultPath: api.vaultPath });
  const gardenerApi = new KizukiTasteGardenerApi({ vaultPath: api.vaultPath });
  const agentBoardApi = new KizukiAgentBoardApi(opts.agentBoardConfig);
  const boardBridge = new KizukiBoardMindBridge({
    ...(opts.boardBridgeConfig || {}),
    agentBoardApi,
    vaultApi: api,
    codexApi,
    tasteApi,
  });
  const publicDir = resolve(opts.publicDir || DEFAULT_PUBLIC_DIR);
  const assetStore = new AssetStore(publicDir);

  // S0-a: Dynamic route module registry (routes/*.routes.ts consulted before built-ins)
  const routeCtx: RouteModuleContext = {
    api,
    replayApi,
    codexApi,
    tasteApi,
    gardenerApi,
    agentBoardApi,
    boardBridge,
    json: jsonResponse,
  };
  const routeModules: RouteModuleHandler[] = [];
  try {
    const glob = new Bun.Glob("routes/*.routes.ts");
    const routeFiles = Array.from(glob.scanSync({ cwd: import.meta.dir })).sort();
    for (const relPath of routeFiles) {
      try {
        const mod = require(join(import.meta.dir, relPath)) as { default?: RouteModuleFactory };
        if (typeof mod?.default === "function") {
          const handler = mod.default(routeCtx);
          if (handler && typeof handler.match === "function" && typeof handler.handle === "function") {
            routeModules.push(handler);
          }
        }
      } catch (err) {
        console.warn(`[kizuki-mind-explorer] failed loading route module ${relPath}:`, err);
      }
    }
  } catch {
    // routes/ directory absent
  }

  const configuredHost = opts.hostname || DEFAULT_HOST;

  async function rawFetchHandler(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    const originGuardResponse = enforceMutationOriginGuard(req, url, configuredHost);
    if (originGuardResponse) {
      return originGuardResponse;
    }

    try {
      for (let i = 0; i < routeModules.length; i += 1) {
        const mod = routeModules[i];
        if (mod.match(req, url)) {
          return await mod.handle(req, url);
        }
      }

      if (req.method === "GET" && pathname === "/api/health") {
        return jsonResponse(await api.getHealth());
      }

      if (req.method === "GET" && pathname === "/api/overview") {
        return jsonResponse(await api.getOverview());
      }

      if (req.method === "GET" && pathname === "/api/pulse") {
        return jsonResponse(await api.getPulse());
      }

      if (req.method === "GET" && pathname === "/api/today") {
        const inc = (url.searchParams.get("includeNoise") || "").trim().toLowerCase();
        const includeNoise = inc === "true" || inc === "1" || inc === "yes";
        return jsonResponse(await api.getToday({ includeNoise }));
      }

      if (req.method === "GET" && pathname === "/api/actions") {
        return jsonResponse(await api.getActions());
      }

      if (req.method === "POST" && pathname === "/api/actions") {
        let body: ActionMutationRequest;
        try {
          body = (await req.json()) as ActionMutationRequest;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object") {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        return jsonResponse(await api.mutateActions(body));
      }

      if (req.method === "GET" && pathname === "/api/people") {
        const q = url.searchParams.get("q") || "";
        const filter = url.searchParams.get("filter") || "";
        const channel = url.searchParams.get("channel") || "all";
        const limitParam = url.searchParams.get("limit");
        return jsonResponse(
          await api.listPeople({
            q,
            filter: filter || undefined,
            channel,
            limit: limitParam ? Number(limitParam) : 60,
          })
        );
      }

      if (req.method === "GET" && pathname === "/api/people/dossier") {
        const key = url.searchParams.get("key") || "";
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        const channel = url.searchParams.get("channel") || "all";
        const q = url.searchParams.get("q") || "";
        return jsonResponse(
          await api.getPersonDossier({
            key,
            limit: limitParam ? Number(limitParam) : 80,
            offset: offsetParam ? Number(offsetParam) : 0,
            channel,
            q,
          })
        );
      }

      if (req.method === "POST" && pathname === "/api/people/synthesize") {
        let body: PersonSynthesizeRequest;
        try {
          body = (await req.json()) as PersonSynthesizeRequest;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object") {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        return jsonResponse(await api.synthesizePersonWorldModel(body));
      }

      if (req.method === "POST" && pathname === "/api/people/note") {
        let body: PersonNoteRequest;
        try {
          body = (await req.json()) as PersonNoteRequest;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object") {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        return jsonResponse(await api.addPersonObservation(body));
      }

      if (req.method === "GET" && (pathname === "/api/omni-search" || pathname === "/api/omni")) {
        const q = url.searchParams.get("q") || "";
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 8;
        const safeLimit = Math.max(1, Math.min(30, Number(limit || 8) || 8));
        const base = await api.omniSearch(q, safeLimit);
        const trimmedQ = q.trim();
        const codexHits = trimmedQ ? codexApi.searchForOmni(trimmedQ, safeLimit) : [];
        let boardHits: BoardOmniHit[] = [];
        if (trimmedQ) {
          try {
            boardHits = boardBridge.searchForOmni(trimmedQ, safeLimit);
          } catch {
            boardHits = [];
          }
        }
        return jsonResponse({
          ...base,
          total: base.total + codexHits.length + boardHits.length,
          codex: codexHits,
          board: boardHits,
          groups: {
            ...base.groups,
            codex: codexHits,
            board: boardHits,
          },
        });
      }

      if (req.method === "GET" && pathname === "/api/codex") {
        const inc = (url.searchParams.get("includeArchived") || "").trim().toLowerCase();
        const includeArchived = inc === "true" || inc === "1" || inc === "yes";
        return jsonResponse(
          codexApi.getCodex({
            section: url.searchParams.get("section") || undefined,
            q: url.searchParams.get("q") || undefined,
            stage: url.searchParams.get("stage") || undefined,
            tag: url.searchParams.get("tag") || undefined,
            domain: url.searchParams.get("domain") || undefined,
            includeArchived,
          })
        );
      }

      if (req.method === "POST" && pathname === "/api/codex/item") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        try {
          if (body.action === "delete" && typeof body.id === "string" && body.id.trim()) {
            return jsonResponse(codexApi.deleteItem(body.id));
          }
          return jsonResponse(codexApi.upsertItem(body as CodexUpsertRequest));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: message }, 400);
        }
      }

      if (req.method === "DELETE" && pathname === "/api/codex/item") {
        const id = (url.searchParams.get("id") || "").trim();
        if (!id) {
          return jsonResponse({ error: "id query parameter is required" }, 400);
        }
        try {
          return jsonResponse(codexApi.deleteItem(id));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: message }, 400);
        }
      }

      if (req.method === "POST" && pathname === "/api/codex/promote") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) {
          return jsonResponse({ error: "id is required" }, 400);
        }
        if (!codexApi.getItem(id)) {
          return jsonResponse({ error: `Codex item not found: ${id}` }, 404);
        }
        const promoteReq: CodexPromoteRequest = {
          id,
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(typeof body.detail === "string" ? { detail: body.detail } : {}),
          ...(typeof body.tag === "string" ? { tag: body.tag } : {}),
          ...(body.createNote !== undefined ? { createNote: Boolean(body.createNote) } : {}),
        };
        try {
          return jsonResponse(codexApi.promoteToAction(promoteReq));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: message }, 400);
        }
      }

      if (req.method === "POST" && pathname === "/api/codex/synthesize") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const id = typeof body.id === "string" ? body.id.trim() : "";
        if (!id) {
          return jsonResponse({ error: "id is required" }, 400);
        }
        const rawMode = typeof body.mode === "string" && body.mode.trim() ? body.mode.trim() : "sharpen";
        if (!ALLOWED_CODEX_SYNTH_MODES.has(rawMode as CodexSynthesizeMode)) {
          return jsonResponse({ error: "mode must be one of: sharpen, next_moves, challenge" }, 400);
        }
        const mode = rawMode as CodexSynthesizeMode;
        const item = codexApi.getItem(id);
        if (!item) {
          return jsonResponse({ error: `Codex item not found: ${id}` }, 404);
        }

        const t0 = performance.now();
        const p = codexApi.buildSynthesizePrompt(item, mode);
        const synth = await api.synthesizeText({
          messages: [
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ],
          promptForCoherence: p.promptForCoherence,
          primaryMaxTokens: 1600,
          fallbackMaxTokens: 1600,
        });

        let briefMd: string;
        let engine: string;
        if (synth.ok && synth.content.trim().length > 0) {
          briefMd = stripEmDashes(synth.content).trim();
          engine = synth.engine;
        } else {
          briefMd = buildDeterministicCodexBrief(item, mode);
          engine = "Deterministic";
        }

        const updatedItem = codexApi.saveAiBrief(id, briefMd, engine);
        const latency_ms = Math.round(performance.now() - t0);
        return jsonResponse({
          ok: true,
          engine,
          latency_ms,
          brief_md: briefMd,
          item: updatedItem,
        });
      }

      if (req.method === "GET" && pathname === "/api/taste") {
        const domain = url.searchParams.get("domain") || undefined;
        return jsonResponse(tasteApi.getTasteState({ domain }));
      }

      if (req.method === "POST" && pathname === "/api/taste/answer") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const answerReq: SubmitAnswerRequest = {
          question_id: typeof body.question_id === "string" ? body.question_id : "",
          chosen_key: typeof body.chosen_key === "string" ? body.chosen_key : "",
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        };
        return jsonResponse(tasteApi.submitAnswer(answerReq));
      }

      if (req.method === "POST" && pathname === "/api/taste/skip") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const questionId = typeof body.question_id === "string" ? body.question_id : "";
        return jsonResponse(tasteApi.skipQuestion(questionId));
      }

      if (req.method === "POST" && pathname === "/api/taste/undo") {
        return jsonResponse(tasteApi.undoLastAnswer());
      }

      if (req.method === "POST" && pathname === "/api/taste/rule") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        if (body.action === "delete") {
          const id = typeof body.id === "string" ? body.id : "";
          return jsonResponse(tasteApi.deleteRule(id));
        }
        return jsonResponse(tasteApi.upsertRule(body as unknown as UpsertRuleRequest));
      }

      if (req.method === "POST" && pathname === "/api/taste/generate") {
        let domain: string | undefined;
        const rawText = (await req.text()).trim();
        if (rawText.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawText);
          } catch {
            return jsonResponse({ error: "Request body must be valid JSON" }, 400);
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return jsonResponse({ error: "Request body must be a JSON object" }, 400);
          }
          const body = parsed as Record<string, unknown>;
          if (body.domain !== undefined && body.domain !== null) {
            if (typeof body.domain !== "string") {
              return jsonResponse({ error: "domain must be a string" }, 400);
            }
            const trimmedDomain = body.domain.trim();
            if (trimmedDomain && trimmedDomain !== "all") {
              domain = trimmedDomain;
            }
          }
        }

        const t0 = performance.now();
        const p = tasteApi.buildGenerateQuestionsPrompt(domain);
        const synth = await api.synthesizeText({
          messages: [
            { role: "system", content: p.system },
            { role: "user", content: p.user },
          ],
          promptForCoherence: p.promptForCoherence,
          primaryMaxTokens: 2400,
          fallbackMaxTokens: 2400,
        });
        const latency_ms = Math.round(performance.now() - t0);

        if (!synth.ok || !synth.content.trim()) {
          const reason = !synth.ok ? synth.reason : "Empty synthesis output";
          return jsonResponse(
            {
              ok: false,
              error: `Adaptive question synthesis failed: ${stripEmDashes(reason)}`,
              latency_ms,
            },
            503
          );
        }

        const res = tasteApi.ingestGeneratedQuestions(synth.content, domain);
        if (res.count === 0) {
          return jsonResponse(
            {
              ok: false,
              error:
                res.skipped_duplicates > 0
                  ? `Synthesis produced only duplicate questions (${res.skipped_duplicates} skipped)`
                  : "Synthesis output did not contain any valid taste calibration questions",
              engine: synth.engine,
              latency_ms,
              added_count: 0,
              skipped_duplicates: res.skipped_duplicates,
              state: res.state,
            },
            503
          );
        }

        return jsonResponse({
          ok: true,
          engine: synth.engine,
          latency_ms,
          added_count: res.count,
          added: res.added,
          state: res.state,
        });
      }

      if (req.method === "GET" && pathname === "/api/taste/gardeners") {
        return jsonResponse(gardenerApi.getState());
      }

      if (req.method === "POST" && pathname === "/api/taste/gardeners/run") {
        let body: { gardener_id?: unknown; domain?: unknown; all?: unknown } = {};
        const rawText = (await req.text()).trim();
        if (rawText) {
          try {
            const parsed = JSON.parse(rawText);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              return jsonResponse({ error: "Request body must be a JSON object" }, 400);
            }
            body = parsed as { gardener_id?: unknown; domain?: unknown; all?: unknown };
          } catch {
            return jsonResponse({ error: "Request body must be valid JSON" }, 400);
          }
        }
        const runAllFlag = Boolean(body.all) || (!body.gardener_id && !body.domain);
        const gardenerId = typeof body.gardener_id === "string" && body.gardener_id.trim() ? body.gardener_id.trim() : undefined;
        const domain = typeof body.domain === "string" && body.domain.trim() ? body.domain.trim() : undefined;

        if (runAllFlag) {
          void gardenerApi.runAll({ concurrency: 2, tasteApi }).catch(() => {});
          return jsonResponse({
            ok: true,
            started: true,
            mode: "all",
            state: gardenerApi.getState(),
          });
        }

        const result = await gardenerApi.runGardener({
          gardenerId,
          domain,
          tasteApi,
        });
        return jsonResponse({
          ok: true,
          started: false,
          mode: domain ? "domain" : "gardener",
          cultivated: result,
          state: gardenerApi.getState(),
        });
      }

      if (req.method === "GET" && pathname === "/api/agent-board/health") {
        const [health, synthReady] = await Promise.all([
          agentBoardApi.getHealth(),
          boardBridge.isLocalLlmReady(),
        ]);
        return jsonResponse({ ...health, synthReady });
      }

      if (req.method === "GET" && pathname === "/api/agent-board/mission") {
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam !== null && limitParam.trim() !== "" ? Number(limitParam) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
        const channel = url.searchParams.get("channel")?.trim() || undefined;
        const rawSignalKind = (url.searchParams.get("signalKind") || "").trim().toLowerCase();
        let signalKind: SignalKind | undefined;
        if (rawSignalKind) {
          if (!ALLOWED_BOARD_SIGNAL_KINDS.has(rawSignalKind as SignalKind)) {
            return jsonResponse(
              {
                error:
                  "signalKind must be one of: telemetry, decision, debate, rsi, taste, debrief, work",
              },
              400
            );
          }
          signalKind = rawSignalKind as SignalKind;
        }
        const includeTelemetry = parseOptionalBoolParam(url.searchParams.get("includeTelemetry"));
        const sinceHoursParam = url.searchParams.get("sinceHours");
        const parsedSinceHours =
          sinceHoursParam !== null && sinceHoursParam.trim() !== "" ? Number(sinceHoursParam) : undefined;
        const sinceHours =
          parsedSinceHours !== undefined && Number.isFinite(parsedSinceHours) ? parsedSinceHours : undefined;
        const q = url.searchParams.get("q") || undefined;
        return jsonResponse(
          await boardBridge.getMissionFeed({
            limit,
            channel,
            signalKind,
            includeTelemetry,
            sinceHours,
            q,
          })
        );
      }

      if (req.method === "GET" && pathname === "/api/agent-board/context") {
        const threadIdParam = (url.searchParams.get("threadId") || "").trim();
        const channelParam = (url.searchParams.get("channel") || "").trim();
        if (!threadIdParam && !channelParam) {
          return jsonResponse(
            { error: "Either threadId or channel query parameter is required" },
            400
          );
        }

        if (threadIdParam) {
          const thread = await agentBoardApi.getThread(threadIdParam);
          const root = thread.root;
          const replies = thread.replies || [];
          const resolvedChannel = root.channel;
          const signal = boardBridge.classifySignal(root);
          const combinedText = [root.text, ...replies.map((r) => r.text)].join("\n");
          const mindLinks = await boardBridge.resolveMindLinks(combinedText, resolvedChannel, 12);

          const relatedMap = new Map<
            string,
            {
              id: string;
              threadId: string;
              numericId: number;
              channel: string;
              title: string;
              preview: string;
              snippet: string;
              by: string;
              replies: number;
              lastAt: string;
              sharedEntities: string[];
            }
          >();

          const entityLinks = mindLinks
            .filter(
              (link): link is MindLink & { kind: EntityThreadKind } =>
                link.kind === "person" ||
                link.kind === "codex" ||
                link.kind === "taste" ||
                link.kind === "vault"
            )
            .slice(0, 4);

          for (const link of entityLinks) {
            try {
              const res = await boardBridge.getEntityThreads(link.kind, link.id, 4);
              for (const match of res.threads) {
                if (match.root.id === root.id) continue;
                const existing = relatedMap.get(match.root.id);
                if (existing) {
                  if (!existing.sharedEntities.includes(link.label)) {
                    existing.sharedEntities.push(link.label);
                  }
                } else {
                  const preview = stripEmDashes(match.root.text.replace(/\s+/g, " ")).slice(0, 180);
                  relatedMap.set(match.root.id, {
                    id: match.root.id,
                    threadId: match.root.id,
                    numericId: match.root.numericId,
                    channel: match.root.channel,
                    title: match.root.title,
                    preview,
                    snippet: preview,
                    by: match.root.by,
                    replies: match.root.replies,
                    lastAt: match.root.lastAt,
                    sharedEntities: [link.label],
                  });
                }
              }
            } catch {
              // Fail-soft on related thread lookup
            }
          }

          if (relatedMap.size < 4 && root.title.trim().length >= 2) {
            try {
              const omniHits = boardBridge.searchForOmni(root.title, 6);
              for (const hit of omniHits) {
                if (hit.id === root.id || relatedMap.has(hit.id)) continue;
                relatedMap.set(hit.id, {
                  id: hit.id,
                  threadId: hit.id,
                  numericId: hit.numericId,
                  channel: hit.channel,
                  title: hit.title,
                  preview: hit.snippet,
                  snippet: hit.snippet,
                  by: hit.by,
                  replies: hit.replies,
                  lastAt: hit.lastAt,
                  sharedEntities: [],
                });
              }
            } catch {
              // Fail-soft
            }
          }

          const relatedThreads = Array.from(relatedMap.values()).slice(0, 6);
          return jsonResponse({
            ok: true,
            threadId: root.id,
            channel: resolvedChannel,
            signal,
            mindLinks,
            entities: groupMindLinksToEntities(mindLinks),
            relatedThreads,
          });
        }

        const roomRes = agentBoardApi.getRoomThreads({
          channel: channelParam,
          limit: 20,
          signalOnly: true,
        });
        const threads = (roomRes.threads || []).filter((t) => !boardBridge.classifySignal(t).isTelemetry);
        const signal =
          threads.length > 0
            ? boardBridge.classifySignal(threads[0])
            : {
                isTelemetry: false,
                signalKind: "work" as SignalKind,
                weight: 0,
                reason: "channel overview",
              };
        const combinedText = threads
          .slice(0, 12)
          .map((t) => `${t.title}\n${t.text}`)
          .join("\n");
        const mindLinks = combinedText.trim()
          ? await boardBridge.resolveMindLinks(combinedText, roomRes.channel, 12)
          : [];
        const relatedThreads = threads.slice(0, 6).map((t) => {
          const preview = stripEmDashes(t.text.replace(/\s+/g, " ")).slice(0, 180);
          return {
            id: t.id,
            threadId: t.id,
            numericId: t.numericId,
            channel: t.channel,
            title: t.title,
            preview,
            snippet: preview,
            by: t.by,
            replies: t.replies,
            lastAt: t.lastAt,
            sharedEntities: [] as string[],
          };
        });
        return jsonResponse({
          ok: true,
          threadId: null,
          channel: roomRes.channel,
          signal,
          mindLinks,
          entities: groupMindLinksToEntities(mindLinks),
          relatedThreads,
        });
      }

      if (req.method === "GET" && pathname === "/api/agent-board/entity-threads") {
        const kind = (url.searchParams.get("kind") || "").trim() as EntityThreadKind;
        const key = (url.searchParams.get("key") || "").trim();
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam !== null && limitParam.trim() !== "" ? Number(limitParam) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
        return jsonResponse(await boardBridge.getEntityThreads(kind, key, limit));
      }

      if (req.method === "GET" && pathname === "/api/agent-board/today-pulse") {
        try {
          const pulse = await boardBridge.getTodayBoardPulse();
          return jsonResponse({
            ...pulse,
            blocked: pulse.blockedCount,
          });
        } catch {
          return jsonResponse({
            available: false,
            openDecisions: 0,
            blockedCount: 0,
            blocked: 0,
            activeAgents: [],
            topThreads: [],
            generatedAt: new Date().toISOString(),
          });
        }
      }

      if (req.method === "POST" && pathname === "/api/agent-board/synthesize") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const threadId =
          typeof body.threadId === "number"
            ? String(body.threadId)
            : typeof body.threadId === "string" && body.threadId.trim()
              ? body.threadId.trim()
              : undefined;
        const channel =
          typeof body.channel === "string" && body.channel.trim() ? body.channel.trim() : undefined;
        return jsonResponse(
          await boardBridge.synthesizeWithLocalLlm({
            ...(threadId !== undefined ? { threadId } : {}),
            ...(channel !== undefined ? { channel } : {}),
          })
        );
      }

      if (req.method === "POST" && pathname === "/api/agent-board/promote") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const threadId =
          typeof body.threadId === "number"
            ? String(body.threadId)
            : typeof body.threadId === "string"
              ? body.threadId
              : "";
        const note =
          typeof body.note === "string"
            ? body.note
            : typeof body.summary === "string"
              ? body.summary
              : typeof body.directive === "string"
                ? body.directive
                : undefined;
        const promoteReq: PromoteThreadToCodexRequest = {
          threadId,
          section: (typeof body.section === "string" ? body.section : "") as PromoteThreadToCodexRequest["section"],
          ...(typeof body.title === "string" ? { title: body.title } : {}),
          ...(note !== undefined ? { note } : {}),
        };
        return jsonResponse(await boardBridge.promoteThreadToCodex(promoteReq));
      }

      if (req.method === "POST" && pathname === "/api/agent-board/dispatch") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const targetAgent =
          typeof body.targetAgent === "string"
            ? body.targetAgent
            : typeof body.agent === "string"
              ? body.agent
              : undefined;
        const dispatchReq: DispatchMindItemRequest = {
          channel: typeof body.channel === "string" ? body.channel : "",
          text: typeof body.text === "string" ? body.text : "",
          ...(targetAgent !== undefined ? { targetAgent } : {}),
          sourceKind: typeof body.sourceKind === "string" ? body.sourceKind : "",
          sourceId: typeof body.sourceId === "string" ? body.sourceId : "",
          sourceLabel: typeof body.sourceLabel === "string" ? body.sourceLabel : "",
          ...(typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
        };
        return jsonResponse(await boardBridge.dispatchMindItemToBoard(dispatchReq));
      }

      if (req.method === "GET" && pathname === "/api/agent-board/rooms") {
        const group = url.searchParams.get("group") || undefined;
        const q = url.searchParams.get("q") || undefined;
        const rawSort = (url.searchParams.get("sort") || "").trim().toLowerCase();
        const sort: "recent" | "volume" | "alpha" | undefined =
          rawSort === "recent" || rawSort === "volume" || rawSort === "alpha"
            ? rawSort
            : undefined;
        return jsonResponse(agentBoardApi.listRooms({ group, q, sort }));
      }

      if (req.method === "GET" && pathname === "/api/agent-board/threads") {
        const channel = url.searchParams.get("channel") || "";
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam !== null && limitParam.trim() !== "" ? Number(limitParam) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
        const rawState = (url.searchParams.get("state") || "").trim().toLowerCase();
        const state: "all" | "open" | "blocked" | undefined =
          rawState === "all" || rawState === "open" || rawState === "blocked"
            ? rawState
            : undefined;
        const q = url.searchParams.get("q") || undefined;
        const signalOnly = parseOptionalBoolParam(url.searchParams.get("signalOnly"));
        return jsonResponse(agentBoardApi.getRoomThreads({ channel, limit, state, q, signalOnly }));
      }

      const boardRoomThreadsMatch =
        req.method === "GET" ? /^\/api\/agent-board\/rooms\/(.+)\/threads$/.exec(pathname) : null;
      if (boardRoomThreadsMatch) {
        let channel: string;
        try {
          channel = decodeURIComponent(boardRoomThreadsMatch[1]);
        } catch {
          return jsonResponse({ error: "Invalid channel encoding" }, 400);
        }
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam !== null && limitParam.trim() !== "" ? Number(limitParam) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
        const rawState = (url.searchParams.get("state") || "").trim().toLowerCase();
        const state: "all" | "open" | "blocked" | undefined =
          rawState === "all" || rawState === "open" || rawState === "blocked"
            ? rawState
            : undefined;
        const q = url.searchParams.get("q") || undefined;
        const signalOnly = parseOptionalBoolParam(url.searchParams.get("signalOnly"));
        return jsonResponse(agentBoardApi.getRoomThreads({ channel, limit, state, q, signalOnly }));
      }

      const boardThreadMatch =
        req.method === "GET" ? /^\/api\/agent-board\/threads\/([^/]+)$/.exec(pathname) : null;
      if (boardThreadMatch) {
        let threadId: string;
        try {
          threadId = decodeURIComponent(boardThreadMatch[1]);
        } catch {
          return jsonResponse({ error: "Invalid threadId encoding" }, 400);
        }
        return jsonResponse(await agentBoardApi.getThread(threadId));
      }

      if (req.method === "GET" && pathname === "/api/agent-board/feed") {
        const limitParam = url.searchParams.get("limit");
        const parsedLimit = limitParam !== null && limitParam.trim() !== "" ? Number(limitParam) : undefined;
        const limit = parsedLimit !== undefined && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
        const channel = url.searchParams.get("channel") || undefined;
        const author = url.searchParams.get("author") || undefined;
        const q = url.searchParams.get("q") || undefined;
        const signalOnly = parseOptionalBoolParam(url.searchParams.get("signalOnly"));
        return jsonResponse(agentBoardApi.getFeed({ limit, channel, author, q, signalOnly }));
      }

      if (req.method === "GET" && pathname === "/api/agent-board/agents") {
        return jsonResponse(await agentBoardApi.getAgents());
      }

      if (req.method === "GET" && pathname === "/api/agent-board/blockers") {
        return jsonResponse(await agentBoardApi.getBlockers());
      }

      if (req.method === "GET" && pathname === "/api/agent-board/stream") {
        const sseHeaders = {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-store",
          Connection: "keep-alive",
        };
        try {
          const upstream = await fetch(agentBoardApi.getCockpitStreamUrl(), {
            headers: { Accept: "text/event-stream" },
            signal: req.signal,
          });
          if (upstream.ok && upstream.body) {
            return new Response(upstream.body, {
              status: 200,
              headers: sseHeaders,
            });
          }
        } catch {
          // Fallback to single offline frame when cockpit SSE is unreachable
        }
        return new Response("event: offline\ndata: {}\n\n", {
          status: 200,
          headers: sseHeaders,
        });
      }

      if (req.method === "POST" && pathname === "/api/agent-board/post") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const postReq: PostMessageRequest = {
          channel: typeof body.channel === "string" ? body.channel : "",
          text: typeof body.text === "string" ? body.text : "",
          ...(body.labels !== undefined ? { labels: body.labels as Record<string, string> } : {}),
          ...(typeof body.idempotencyKey === "string" ? { idempotencyKey: body.idempotencyKey } : {}),
        };
        return jsonResponse(await agentBoardApi.postMessage(postReq));
      }

      if (req.method === "POST" && pathname === "/api/agent-board/reply") {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const threadId =
          typeof body.threadId === "number"
            ? String(body.threadId)
            : typeof body.threadId === "string"
              ? body.threadId
              : "";
        const replyReq: ReplyToThreadRequest = {
          threadId,
          text: typeof body.text === "string" ? body.text : "",
          ...(body.resumePaused !== undefined ? { resumePaused: Boolean(body.resumePaused) } : {}),
        };
        return jsonResponse(await agentBoardApi.replyToThread(replyReq));
      }

      if (req.method === "POST" && pathname === "/api/draft") {
        let body: DraftRequest;
        try {
          body = (await req.json()) as DraftRequest;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object") {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        return jsonResponse(await api.generateLocalDraft(body));
      }

      if (req.method === "GET" && pathname === "/api/docs") {
        const category = url.searchParams.get("category") || "all";
        const q = url.searchParams.get("q") || "";
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        const sort = url.searchParams.get("sort") || "recent";
        return jsonResponse(
          await api.listDocs({
            category,
            q,
            limit: limitParam ? Number(limitParam) : 60,
            offset: offsetParam ? Number(offsetParam) : 0,
            sort,
          })
        );
      }

      if (req.method === "GET" && pathname === "/api/docs/read") {
        const docPath = url.searchParams.get("path") || "";
        return jsonResponse(await api.readDoc(docPath));
      }

      if (req.method === "POST" && pathname === "/api/docs/save") {
        let body: DocSaveRequest;
        try {
          body = (await req.json()) as DocSaveRequest;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object") {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        return jsonResponse(await api.saveDoc(body));
      }

      if (req.method === "GET" && pathname === "/api/stream") {
        const connector = url.searchParams.get("connector") || "all";
        const q = url.searchParams.get("q") || "";
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        return jsonResponse(
          await api.getStream({
            connector,
            q,
            limit: limitParam ? Number(limitParam) : 40,
            offset: offsetParam ? Number(offsetParam) : 0,
          })
        );
      }

      if (req.method === "GET" && pathname === "/api/graph") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 180;
        const kind = url.searchParams.get("kind") || "all";
        const q = url.searchParams.get("q") || "";
        return jsonResponse(await api.getGraph({ limit, kind, q }));
      }

      if (req.method === "GET" && pathname.startsWith("/api/node/")) {
        const rawId = pathname.slice("/api/node/".length);
        let id: string;
        try {
          id = decodeURIComponent(rawId);
        } catch {
          return jsonResponse({ error: "Invalid node ID encoding" }, 400);
        }
        if (!id) {
          return jsonResponse({ error: "Node ID is required" }, 400);
        }
        const detail = await api.getNodeDetail(id);
        if (!detail) {
          return jsonResponse({ error: "Node not found", id }, 404);
        }
        return jsonResponse(detail);
      }

      if (req.method === "GET" && pathname === "/api/search") {
        const q = url.searchParams.get("q") || "";
        return jsonResponse(await api.search(q));
      }

      if (req.method === "GET" && pathname === "/api/atlas") {
        return jsonResponse(await api.getAtlas());
      }

      if (req.method === "GET" && pathname === "/api/memt") {
        return jsonResponse(await api.getMemt());
      }

      if (req.method === "GET" && pathname === "/api/brief") {
        const name = url.searchParams.get("name") || undefined;
        return jsonResponse(await api.getBrief(name));
      }

      if (req.method === "POST" && (pathname === "/api/interact" || pathname === "/api/ask")) {
        let rawBody: Record<string, unknown>;
        try {
          rawBody = (await req.json()) as Record<string, unknown>;
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }
        const body: InteractRequest =
          pathname === "/api/ask"
            ? {
                ...(rawBody as unknown as InteractRequest),
                mode: "ask",
                input:
                  typeof rawBody.input === "string" && rawBody.input.trim()
                    ? rawBody.input
                    : typeof rawBody.query === "string" && rawBody.query.trim()
                      ? rawBody.query
                      : typeof rawBody.question === "string"
                        ? rawBody.question
                        : "",
              }
            : (rawBody as unknown as InteractRequest);

        let extraContext:
          | {
              lines?: string[];
              citations?: Array<{ id: string; label: string; kind?: string }>;
            }
          | undefined;
        if (body.mode === "ask" && typeof body.input === "string" && body.input.trim()) {
          try {
            const boardChannel =
              typeof rawBody.boardChannel === "string" && rawBody.boardChannel.trim()
                ? rawBody.boardChannel.trim()
                : undefined;
            const boardThreadId =
              typeof rawBody.boardThreadId === "string" && rawBody.boardThreadId.trim()
                ? rawBody.boardThreadId.trim()
                : typeof rawBody.boardThreadId === "number" &&
                    Number.isFinite(rawBody.boardThreadId)
                  ? String(rawBody.boardThreadId)
                  : undefined;
            const boardCtx = boardBridge.getAskContext(body.input, {
              channel: boardChannel,
              threadId: boardThreadId,
            });
            if (boardCtx.lines.length > 0 || boardCtx.citations.length > 0) {
              extraContext = {
                lines: boardCtx.lines,
                citations: boardCtx.citations.map((c) => ({
                  id: `board:${c.id}`,
                  label: `#${c.id} (${c.channel}) ${c.title}`,
                  kind: "board",
                })),
              };
            }
          } catch {
            // Fail-soft: ask proceeds even if Agent Board context is unavailable
          }
        }
        const result = await api.interact(body, extraContext);
        return jsonResponse(result);
      }

      if (req.method === "GET" && pathname === "/api/replay/index") {
        const yearParam = url.searchParams.get("year");
        const monthsParam = url.searchParams.get("months");
        let year: number | undefined;
        let months: number | undefined;

        if (yearParam !== null && yearParam.trim() !== "") {
          if (!/^\d{4}$/.test(yearParam.trim())) {
            return jsonResponse({ error: "year must be a 4-digit integer" }, 400);
          }
          year = Number(yearParam.trim());
        }
        if (monthsParam !== null && monthsParam.trim() !== "") {
          const parsedMonths = Number(monthsParam.trim());
          if (!Number.isInteger(parsedMonths) || parsedMonths <= 0) {
            return jsonResponse({ error: "months must be a positive integer" }, 400);
          }
          months = parsedMonths;
        }

        const indexOpts: { year?: number; months?: number } = {};
        if (year !== undefined) indexOpts.year = year;
        if (months !== undefined) indexOpts.months = months;
        return jsonResponse(replayApi.getReplayIndex(indexOpts));
      }

      if (req.method === "GET" && pathname === "/api/replay/day") {
        const day = (url.searchParams.get("day") || "").trim();
        if (!day || !isValidReplayDay(day)) {
          return jsonResponse({ error: "day query parameter is required and must be YYYY-MM-DD" }, 400);
        }
        return jsonResponse(replayApi.getReplayDay(day));
      }

      if (req.method === "POST" && pathname === "/api/replay/story") {
        let body: { day?: unknown; force?: unknown };
        try {
          body = (await req.json()) as { day?: unknown; force?: unknown };
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }

        const day = typeof body.day === "string" ? body.day.trim() : "";
        if (!day || !isValidReplayDay(day)) {
          return jsonResponse({ error: "day is required and must be YYYY-MM-DD" }, 400);
        }
        const force = Boolean(body.force);

        const dayPacket = replayApi.getReplayDay(day);
        if (dayPacket.story_md && !force) {
          return jsonResponse({
            ok: true,
            cached: true,
            engine: "Cached",
            latency_ms: 0,
            story_md: dayPacket.story_md,
            day: dayPacket,
          });
        }

        const t0 = performance.now();
        const userPrompt = replayApi.buildReplayDayStoryPrompt(dayPacket);
        const systemPrompt =
          "You are Kizuki Replay, a factual personal life-replay biographer. Ground every statement strictly in the telemetry provided. Output crisp GFM markdown with the exact six requested headings. Never use em-dashes.";

        const synth = await api.synthesizeText({
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          promptForCoherence: `What happened on ${dayPacket.day} (${dayPacket.weekday}) ${dayPacket.summary.primary_location || ""}`,
          primaryMaxTokens: 2400,
          fallbackMaxTokens: 2400,
        });

        let storyMd: string;
        let engine: string;
        if (
          synth.ok &&
          synth.content.trim().length > 0 &&
          (synth.content.includes("## ") || synth.content.includes("# "))
        ) {
          storyMd = stripEmDashes(synth.content).trim();
          engine = synth.engine;
        } else {
          storyMd = buildDeterministicReplayStory(dayPacket);
          engine = "Deterministic";
        }

        await Promise.resolve(replayApi.saveReplayDayStory(day, storyMd));
        const refreshedDay = replayApi.getReplayDay(day);
        const latency_ms = Math.round(performance.now() - t0);

        return jsonResponse({
          ok: true,
          cached: false,
          engine,
          latency_ms,
          story_md: refreshedDay.story_md || storyMd,
          day: refreshedDay,
        });
      }

      if (req.method === "POST" && pathname === "/api/replay/import-location") {
        const contentLengthHeader = req.headers.get("content-length");
        if (contentLengthHeader !== null) {
          const declaredBytes = Number(contentLengthHeader);
          if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REPLAY_IMPORT_BYTES) {
            return jsonResponse(
              { error: `Payload too large (max ${MAX_REPLAY_IMPORT_BYTES} bytes)` },
              413
            );
          }
        }

        let rawBuffer: ArrayBuffer;
        try {
          rawBuffer = await req.arrayBuffer();
        } catch {
          return jsonResponse({ error: "Failed to read request body" }, 400);
        }
        if (rawBuffer.byteLength > MAX_REPLAY_IMPORT_BYTES) {
          return jsonResponse(
            { error: `Payload too large (max ${MAX_REPLAY_IMPORT_BYTES} bytes)` },
            413
          );
        }

        let parsed: unknown;
        try {
          const text = new TextDecoder("utf-8").decode(rawBuffer);
          parsed = JSON.parse(text);
        } catch {
          return jsonResponse({ error: "Request body must be valid JSON" }, 400);
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return jsonResponse({ error: "Request body must be a JSON object" }, 400);
        }

        try {
          const result = replayApi.importGoogleMapsTimeline(parsed);
          return jsonResponse({ ...result, ok: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return jsonResponse({ error: message }, 400);
        }
      }

      if (pathname.startsWith("/api/")) {
        return jsonResponse({ error: "API route not found", path: pathname }, 404);
      }

      if (req.method === "GET" || req.method === "HEAD") {
        return await serveStatic(req, url, assetStore);
      }

      return jsonResponse({ error: "Method not allowed" }, 405);
    } catch (err) {
      if (err instanceof SecretDetectedError) {
        const rule =
          (err as { rule?: string | null }).rule ||
          err.findings?.[0]?.ruleId ||
          null;
        return jsonResponse(
          { ok: false, error: "secret_detected", message: err.message, rule },
          422,
        );
      }
      if (err instanceof BadRequestError) {
        return jsonResponse({ error: err.message }, 400);
      }
      if (err instanceof ForbiddenError) {
        return jsonResponse({ error: err.message }, 403);
      }
      if (err instanceof NotFoundError) {
        return jsonResponse({ error: err.message }, 404);
      }
      if (err instanceof ServiceUnavailableError) {
        return jsonResponse({ error: err.message }, 503);
      }
      const message = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: message }, 500);
    }
  }

  async function fetchHandler(req: Request): Promise<Response> {
    const res = await rawFetchHandler(req);
    return finalizeResponse(req, res);
  }

  return {
    api,
    replayApi,
    codexApi,
    tasteApi,
    gardenerApi,
    agentBoardApi,
    boardBridge,
    close() {
      const g = globalThis as unknown as {
        __kizukiOntologyEngine?: { close?: () => void };
      };
      if (typeof g.__kizukiOntologyEngine?.close === "function") {
        try {
          g.__kizukiOntologyEngine.close();
        } catch {
          // ignore
        }
      }
      if (typeof boardBridge.close === "function") {
        try {
          boardBridge.close();
        } catch {
          // ignore
        }
      }
      if (typeof agentBoardApi.close === "function") {
        try {
          agentBoardApi.close();
        } catch {
          // ignore
        }
      }
      api.close();
    },
    fetch: fetchHandler,
    start(overridePort?: number) {
      const server = Bun.serve({
        hostname: opts.hostname || DEFAULT_HOST,
        port: overridePort ?? opts.port ?? DEFAULT_PORT,
        maxRequestBodySize: 32 * 1024 * 1024,
        fetch: fetchHandler,
      });
      return server;
    },
  };
}

if (import.meta.main) {
  const app = createExplorerApp({
    hostname: process.env.KIZUKI_HOST || DEFAULT_HOST,
    port: DEFAULT_PORT,
    publicDir: DEFAULT_PUBLIC_DIR,
  });
  const server = app.start();
  console.log(`Kizuki Mind Explorer listening on http://${server.hostname}:${server.port}`);
}
