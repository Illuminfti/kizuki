// Dynamic route module for Live Box AI Telemetry & Process-to-Brain Topology Engine (Lane W1)
// Serves cached <5ms live OS telemetry snapshots and zero-idle-CPU SSE streams.

import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import {
  BoxAiRadarEngine,
  isBoxAiCategory,
  type BoxAiCategory,
  type BoxAiRadarEngineOptions,
} from "../box-ai-radar.ts";

export interface BoxAiRadarRouteOptions extends BoxAiRadarEngineOptions {}

function parseCategoryParam(raw: string | null): {
  valid: boolean;
  category: BoxAiCategory | null;
} {
  if (!raw) return { valid: true, category: null };
  const clean = raw.trim().toLowerCase();
  if (!clean || clean === "all") return { valid: true, category: null };
  if (isBoxAiCategory(clean)) return { valid: true, category: clean };
  return { valid: false, category: null };
}

export function createBoxAiRadarRoutesWithOptions(
  ctx: RouteModuleContext,
  opts: BoxAiRadarRouteOptions = {},
): RouteModuleHandler {
  const engine = new BoxAiRadarEngine({
    agentBoardApi: ctx.agentBoardApi,
    ...opts,
  });

  const g = globalThis as unknown as Record<string, unknown>;
  g.__kizukiBoxAiRadar = engine;

  return {
    match(req: Request, url: URL): boolean {
      if (req.method !== "GET") return false;
      return url.pathname === "/api/box/ai-live" || url.pathname === "/api/box/ai-live/stream";
    },

    async handle(req: Request, url: URL): Promise<Response> {
      try {
        const parsedCategory = parseCategoryParam(url.searchParams.get("category"));
        if (!parsedCategory.valid) {
          return ctx.json(
            {
              ok: false,
              error: "Invalid category. Expected one of: building, designing, predicting, orchestrating",
            },
            400,
          );
        }

        if (url.pathname === "/api/box/ai-live") {
          const refresh = url.searchParams.get("refresh") === "1";
          const snapshot = await engine.getSnapshot({
            refresh,
            category: parsedCategory.category,
          });
          return ctx.json(snapshot, 200);
        }

        if (url.pathname === "/api/box/ai-live/stream") {
          return engine.connectStream(req.signal, parsedCategory.category);
        }

        return ctx.json({ ok: false, error: "Not Found" }, 404);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ctx.json({ ok: false, error: message }, 500);
      }
    },
  };
}

const createBoxAiRadarRoutes: RouteModuleFactory = (ctx) =>
  createBoxAiRadarRoutesWithOptions(ctx);

export default createBoxAiRadarRoutes;
