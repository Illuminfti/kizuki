// Dynamic route module for Real-Time Live SSE Push Bus (Lane H5)
// Streams text/event-stream deltas with zero idle CPU when no clients are connected.

import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import { LiveEventBus } from "../live-bus.ts";

const createLiveBusRoutes: RouteModuleFactory = (ctx: RouteModuleContext): RouteModuleHandler => {
  const bus = new LiveEventBus({
    vaultApi: ctx.api,
    agentBoardApi: ctx.agentBoardApi,
  });

  const g = globalThis as unknown as Record<string, unknown>;
  g.__kizukiLiveBus = bus;
  g.__kizukiBroadcast = (scope: string | string[], meta?: Record<string, unknown>) =>
    bus.broadcast(scope, meta);

  return {
    match(req: Request, url: URL): boolean {
      if (req.method !== "GET") return false;
      return url.pathname === "/api/live/events" || url.pathname === "/api/live/status";
    },

    handle(req: Request, url: URL): Response {
      if (url.pathname === "/api/live/events") {
        return bus.connect(req.signal);
      }

      if (url.pathname === "/api/live/status") {
        return ctx.json(bus.getStatus(), 200);
      }

      return ctx.json({ error: "Not Found" }, 404);
    },
  };
};

export default createLiveBusRoutes;
