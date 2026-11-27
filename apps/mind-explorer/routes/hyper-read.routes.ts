import type {
  RouteModuleContext,
  RouteModuleFactory,
  RouteModuleHandler,
} from "../contracts.ts";
import {
  HotReadCacheEngine,
  isTestRuntime,
  type HotReadCacheConfig,
} from "../hot-read-cache.ts";
import {
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
  type PersonNoteRequest,
  type PersonSynthesizeRequest,
} from "../vault-api.ts";

declare global {
  var __kizukiHotCacheInvalidate: ((scope?: string) => void) | undefined;
  var __kizukiHotReadEngine: HotReadCacheEngine | undefined;
}

export interface HyperReadRouteOptions
  extends Omit<HotReadCacheConfig, "api"> {}

function handleRouteError(ctx: RouteModuleContext, err: unknown): Response {
  if (err instanceof BadRequestError) {
    return ctx.json({ error: err.message }, 400);
  }
  if (err instanceof ForbiddenError) {
    return ctx.json({ error: err.message }, 403);
  }
  if (err instanceof NotFoundError) {
    return ctx.json({ error: err.message }, 404);
  }
  if (err instanceof ServiceUnavailableError) {
    return ctx.json({ error: err.message }, 503);
  }
  const message = err instanceof Error ? err.message : String(err);
  return ctx.json({ error: message }, 500);
}

export function createHyperReadRoutesWithOptions(
  ctx: RouteModuleContext,
  opts: HyperReadRouteOptions = {},
): RouteModuleHandler & { engine: HotReadCacheEngine } {
  const testRun = opts.isTestRun ?? isTestRuntime();
  const engine = new HotReadCacheEngine({
    api: ctx.api,
    isTestRun: testRun,
    enableBootPrewarm: opts.enableBootPrewarm ?? !testRun,
    statThrottleMs: opts.statThrottleMs,
    prewarmDelayMs: opts.prewarmDelayMs,
    prewarmSpacingMs: opts.prewarmSpacingMs,
    nowFn: opts.nowFn,
  });

  // Expose invalidation hook for write routes and live SSE bus
  globalThis.__kizukiHotCacheInvalidate = (scope?: string) => {
    engine.invalidate(scope);
  };
  globalThis.__kizukiHotReadEngine = engine;

  return {
    engine,
    overrides: [
      "/api/stream",
      "/api/search",
      "/api/node/:id",
      "/api/people/dossier",
      "/api/people/note",
      "/api/people/synthesize",
      "/api/overview",
      "/api/graph",
    ],

    match(req: Request, url: URL): boolean {
      const { pathname } = url;
      if (req.method === "GET") {
        return (
          pathname === "/api/stream" ||
          pathname === "/api/search" ||
          pathname.startsWith("/api/node/") ||
          pathname === "/api/people/dossier" ||
          pathname === "/api/overview" ||
          pathname === "/api/graph"
        );
      }
      if (req.method === "POST") {
        return (
          pathname === "/api/people/note" ||
          pathname === "/api/people/synthesize"
        );
      }
      return false;
    },

    async handle(req: Request, url: URL): Promise<Response> {
      const { pathname } = url;

      try {
        if (req.method === "GET" && pathname === "/api/stream") {
          const connector =
            url.searchParams.get("connector") ||
            url.searchParams.get("source") ||
            "all";
          const source = url.searchParams.get("source") || "";
          const kind = url.searchParams.get("kind") || "";
          const q = url.searchParams.get("q") || "";
          const limitParam = url.searchParams.get("limit");
          const offsetParam = url.searchParams.get("offset");
          const data = await engine.getStream({
            connector,
            source,
            kind,
            q,
            limit: limitParam ? Number(limitParam) : 40,
            offset: offsetParam ? Number(offsetParam) : 0,
          });
          return ctx.json(data);
        }

        if (req.method === "GET" && pathname === "/api/search") {
          const q = url.searchParams.get("q") || "";
          const limitParam = url.searchParams.get("limit");
          const limitOverride =
            limitParam && Number.isFinite(Number(limitParam)) && Number(limitParam) > 0
              ? Number(limitParam)
              : undefined;
          const data = await engine.search(q, limitOverride);
          return ctx.json(data);
        }

        if (req.method === "GET" && pathname.startsWith("/api/node/")) {
          const rawId = pathname.slice("/api/node/".length);
          let id: string;
          try {
            id = decodeURIComponent(rawId);
          } catch {
            return ctx.json({ error: "Invalid node ID encoding" }, 400);
          }
          if (!id) {
            return ctx.json({ error: "Node ID is required" }, 400);
          }
          const detail = await engine.getNodeDetail(id);
          if (!detail) {
            return ctx.json({ error: "Node not found", id }, 404);
          }
          return ctx.json(detail);
        }

        if (req.method === "GET" && pathname === "/api/people/dossier") {
          const key = url.searchParams.get("key") || "";
          const limitParam = url.searchParams.get("limit");
          const offsetParam = url.searchParams.get("offset");
          const channel = url.searchParams.get("channel") || "all";
          const q = url.searchParams.get("q") || "";
          const data = await engine.getPersonDossier({
            key,
            limit: limitParam ? Number(limitParam) : 80,
            offset: offsetParam ? Number(offsetParam) : 0,
            channel,
            q,
          });
          return ctx.json(data);
        }

        if (req.method === "POST" && pathname === "/api/people/note") {
          let body: PersonNoteRequest;
          try {
            body = (await req.json()) as PersonNoteRequest;
          } catch {
            return ctx.json({ error: "Request body must be valid JSON" }, 400);
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return ctx.json({ error: "Request body must be a JSON object" }, 400);
          }
          const result = await ctx.api.addPersonObservation(body);
          engine.invalidatePerson(typeof body.key === "string" ? body.key : undefined);
          return ctx.json(result);
        }

        if (req.method === "POST" && pathname === "/api/people/synthesize") {
          let body: PersonSynthesizeRequest;
          try {
            body = (await req.json()) as PersonSynthesizeRequest;
          } catch {
            return ctx.json({ error: "Request body must be valid JSON" }, 400);
          }
          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return ctx.json({ error: "Request body must be a JSON object" }, 400);
          }
          const result = await ctx.api.synthesizePersonWorldModel(body);
          engine.invalidatePerson(typeof body.key === "string" ? body.key : undefined);
          return ctx.json(result);
        }

        if (req.method === "GET" && pathname === "/api/overview") {
          return ctx.json(await engine.getOverview());
        }

        if (req.method === "GET" && pathname === "/api/graph") {
          const limitParam = url.searchParams.get("limit");
          const limit = limitParam ? Number(limitParam) : 180;
          const kind = url.searchParams.get("kind") || "all";
          const q = url.searchParams.get("q") || "";
          return ctx.json(await engine.getGraph({ limit, kind, q }));
        }

        return ctx.json({ error: "API route not found", path: pathname }, 404);
      } catch (err) {
        return handleRouteError(ctx, err);
      }
    },
  };
}

const createHyperReadRoutes: RouteModuleFactory = (ctx) =>
  createHyperReadRoutesWithOptions(ctx);

export default createHyperReadRoutes;
