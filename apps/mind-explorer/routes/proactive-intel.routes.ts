// Dynamic route module for Proactive Daily Briefing, Meeting Preps & Open-Commitment Radar (Lane H4)
// Strictly local-only: copyable drafts & 0600 local state ledger; zero outbound sends.

import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import { PeopleRadarService } from "../people-radar.ts";
import {
  ProactiveBadRequestError,
  ProactiveIntelEngine,
  type MutateCommitmentRequest,
  type ProactiveIntelEngineOptions,
} from "../proactive-intel.ts";

export interface ProactiveIntelRouteOptions {
  statePath?: string;
  ttlMs?: number;
  nowFn?: () => number;
  peopleRadar?: ProactiveIntelEngineOptions["peopleRadar"];
  disableBackgroundRefresh?: boolean;
}

async function parseJsonObject(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new ProactiveBadRequestError("Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProactiveBadRequestError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function createProactiveIntelRoutesWithOptions(
  ctx: RouteModuleContext,
  opts: ProactiveIntelRouteOptions = {},
): RouteModuleHandler {
  const radar =
    opts.peopleRadar !== undefined
      ? opts.peopleRadar
      : new PeopleRadarService({
          api: ctx.api,
          boardBridge: ctx.boardBridge,
        });

  if (
    !opts.disableBackgroundRefresh &&
    process.env.NODE_ENV !== "test" &&
    radar &&
    typeof (radar as PeopleRadarService).startBackgroundRefresh === "function"
  ) {
    (radar as PeopleRadarService).startBackgroundRefresh(90_000);
  }

  const engine = new ProactiveIntelEngine({
    api: ctx.api,
    agentBoardApi: ctx.agentBoardApi,
    boardBridge: ctx.boardBridge,
    peopleRadar: radar,
    statePath: opts.statePath,
    ttlMs: opts.ttlMs,
    nowFn: opts.nowFn,
  });

  if (!opts.disableBackgroundRefresh && process.env.NODE_ENV !== "test") {
    engine.startBackgroundRefresh(30_000);
  }

  return {
    match(req: Request, url: URL): boolean {
      if (req.method === "GET") {
        return url.pathname === "/api/intel/briefing" || url.pathname === "/api/intel/meeting-prep";
      }
      if (req.method === "POST") {
        return url.pathname === "/api/intel/commitment";
      }
      return false;
    },

    async handle(req: Request, url: URL): Promise<Response> {
      try {
        if (req.method === "GET" && url.pathname === "/api/intel/briefing") {
          const forceRefresh = url.searchParams.get("refresh") === "1";
          const payload = await engine.getBriefing({ refresh: forceRefresh });
          return ctx.json(payload, 200);
        }

        if (req.method === "GET" && url.pathname === "/api/intel/meeting-prep") {
          const id = (url.searchParams.get("id") || "").trim();
          if (!id) {
            return ctx.json({ ok: false, error: "id query parameter is required" }, 400);
          }
          const detail = await engine.generateMeetingPrepMarkdown(id);
          if (!detail) {
            return ctx.json({ ok: false, error: `Meeting prep not found: ${id}` }, 404);
          }
          return ctx.json(detail, 200);
        }

        if (req.method === "POST" && url.pathname === "/api/intel/commitment") {
          const body = await parseJsonObject(req);
          const result = await engine.mutateCommitment(body as unknown as MutateCommitmentRequest);
          return ctx.json(result, 200);
        }

        return ctx.json({ ok: false, error: "Not Found" }, 404);
      } catch (err) {
        if (err instanceof ProactiveBadRequestError) {
          return ctx.json({ ok: false, error: err.message }, 400);
        }
        const message = err instanceof Error ? err.message : String(err);
        return ctx.json({ ok: false, error: message }, 500);
      }
    },
  };
}

const createProactiveIntelRoutes: RouteModuleFactory = (ctx) =>
  createProactiveIntelRoutesWithOptions(ctx);

export default createProactiveIntelRoutes;
