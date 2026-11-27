import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import {
  SemanticMemoryEngine,
  isSemanticKind,
  isTestEnvironment,
  type SemanticKind,
} from "../semantic-memory.ts";

function parseKindsParam(raw: string | null): SemanticKind[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const parsed = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is SemanticKind => isSemanticKind(s));
  return parsed.length > 0 ? Array.from(new Set(parsed)) : undefined;
}

export function buildSemanticMemoryRouteHandler(
  ctx: Pick<RouteModuleContext, "json">,
  engine: SemanticMemoryEngine,
): RouteModuleHandler {
  return {
    match(req: Request, url: URL): boolean {
      if (req.method !== "GET") return false;
      const { pathname } = url;
      return (
        pathname === "/api/semantic/recall" ||
        pathname === "/api/semantic/related" ||
        pathname === "/api/semantic/stats"
      );
    },

    async handle(_req: Request, url: URL): Promise<Response> {
      const { pathname } = url;

      if (pathname === "/api/semantic/stats") {
        return ctx.json(engine.getStats());
      }

      if (pathname === "/api/semantic/recall") {
        const q = url.searchParams.get("q") || "";
        const limitRaw = Number(url.searchParams.get("limit") || 12);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;
        const kinds = parseKindsParam(url.searchParams.get("kinds"));

        if (!engine.isReady() && !engine.isSyncing() && !isTestEnvironment()) {
          engine.syncInBackground();
        }

        const result = await engine.recall(q, { limit, kinds });
        return ctx.json(result);
      }

      if (pathname === "/api/semantic/related") {
        const id = url.searchParams.get("id") || "";
        const kind = url.searchParams.get("kind") || undefined;
        const limitRaw = Number(url.searchParams.get("limit") || 8);
        const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(30, Math.floor(limitRaw))) : 8;

        if (!id.trim()) {
          return ctx.json(
            {
              source_id: "",
              source_kind: kind || "",
              elapsed_ms: 0,
              related: [],
            },
            400,
          );
        }

        if (!engine.isReady() && !engine.isSyncing() && !isTestEnvironment()) {
          engine.syncInBackground();
        }

        const result = engine.related(id, kind, limit);
        return ctx.json(result);
      }

      return ctx.json({ ok: false, error: "Not found" }, 404);
    },
  };
}

const createSemanticMemoryRoutes: RouteModuleFactory = (
  ctx: RouteModuleContext,
): RouteModuleHandler => {
  const testRun = isTestEnvironment();
  const engine = new SemanticMemoryEngine({
    api: ctx.api,
    codexApi: ctx.codexApi,
    tasteApi: ctx.tasteApi,
    agentBoardApi: ctx.agentBoardApi,
    boardBridge: ctx.boardBridge,
    autoLoadDiskCache: !testRun,
  });

  // Expose singleton in-process for Lane H3 (ask-stream.ts) and other modules (0 HTTP overhead)
  globalThis.__kizukiSemanticMemory = engine;

  // Warm 4s after boot in production with an unref'd timer; skip auto-warm in test runs
  if (!testRun) {
    const bootTimer = setTimeout(() => {
      engine.syncInBackground();
    }, 4000);
    if (typeof (bootTimer as unknown as { unref?: () => void }).unref === "function") {
      (bootTimer as unknown as { unref: () => void }).unref();
    }
  }

  return buildSemanticMemoryRouteHandler(ctx, engine);
};

export default createSemanticMemoryRoutes;
