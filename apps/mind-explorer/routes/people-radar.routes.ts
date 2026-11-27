// Dynamic route module for People Radar & Local Prep Pack (Contract C3, S0-a)
// Read-only endpoints; zero outbound transport.

import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import { PeopleRadarService } from "../people-radar.ts";

const createPeopleRadarRoutes: RouteModuleFactory = (ctx: RouteModuleContext): RouteModuleHandler => {
  const service = new PeopleRadarService({
    api: ctx.api,
    boardBridge: ctx.boardBridge,
  });

  // Trigger non-blocking background warmup when running live server
  if (process.env.NODE_ENV !== "test") {
    service.startBackgroundRefresh(60_000);
  }

  return {
    match(req: Request, url: URL): boolean {
      if (req.method !== "GET") return false;
      return url.pathname === "/api/people/radar" || url.pathname === "/api/people/prep";
    },

    async handle(_req: Request, url: URL): Promise<Response> {
      if (url.pathname === "/api/people/radar") {
        const forceRefresh = url.searchParams.get("refresh") === "1";
        const payload = await service.getRadar({ refresh: forceRefresh });
        return ctx.json(payload, 200);
      }

      if (url.pathname === "/api/people/prep") {
        const key = (url.searchParams.get("key") || "").trim();
        if (!key) {
          return ctx.json({ error: "key query parameter is required" }, 400);
        }
        try {
          const pack = await service.getPrepPack(key);
          return ctx.json(pack, 200);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const status = /not found/i.test(msg) ? 404 : /required|invalid/i.test(msg) ? 400 : 500;
          return ctx.json({ error: msg }, status);
        }
      }

      return ctx.json({ error: "Not Found" }, 404);
    },
  };
};

export default createPeopleRadarRoutes;
