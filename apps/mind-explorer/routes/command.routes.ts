import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import { COMMAND_VERB_REGISTRY, CommandPlaneEngine } from "../command-plane.ts";
import { CrossPollinator, LocalEmbedder } from "../cross-pollinate.ts";

const createCommandRoutes: RouteModuleFactory = (ctx: RouteModuleContext): RouteModuleHandler => {
  const sharedEmbedder = new LocalEmbedder();
  const crossPollinator = new CrossPollinator({
    codexApi: ctx.codexApi,
    tasteApi: ctx.tasteApi,
    gardenerApi: ctx.gardenerApi,
    embedder: sharedEmbedder,
  });
  crossPollinator.attachToApis();

  const commandEngine = new CommandPlaneEngine({
    api: ctx.api,
    codexApi: ctx.codexApi,
    tasteApi: ctx.tasteApi,
    gardenerApi: ctx.gardenerApi,
    agentBoardApi: ctx.agentBoardApi,
    boardBridge: ctx.boardBridge,
    embedder: sharedEmbedder,
  });

  // Expose live handles for internal coordination without disk persistence
  const g = globalThis as unknown as Record<string, unknown>;
  g.__kizukiCommandPlane = commandEngine;
  g.__kizukiCrossPollinator = crossPollinator;

  // Warm crosslinks lazily in background on boot (non-blocking, fail-soft)
  void crossPollinator.computeCrosslinks().catch(() => {});

  return {
    match(req: Request, url: URL): boolean {
      const { pathname } = url;
      if (req.method === "POST" && pathname === "/api/command/resolve") return true;
      if (req.method === "POST" && pathname === "/api/command/execute") return true;
      if (req.method === "GET" && pathname === "/api/command/verbs") return true;
      if (req.method === "GET" && pathname === "/api/crosslinks") return true;
      return false;
    },

    async handle(req: Request, url: URL): Promise<Response> {
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/api/command/verbs") {
        return ctx.json({
          ok: true,
          verbs: COMMAND_VERB_REGISTRY,
          embedder: sharedEmbedder.getStats(),
        });
      }

      if (req.method === "POST" && pathname === "/api/command/resolve") {
        let rawBody: Record<string, unknown>;
        try {
          rawBody = (await req.json()) as Record<string, unknown>;
        } catch {
          return ctx.json({ ok: false, error: "Request body must be valid JSON" }, 400);
        }
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return ctx.json({ ok: false, error: "Request body must be a JSON object" }, 400);
        }
        const q = typeof rawBody.q === "string" ? rawBody.q : "";
        const includeSemantic = rawBody.includeSemantic !== false;
        const limit =
          typeof rawBody.limit === "number" && Number.isFinite(rawBody.limit) ? rawBody.limit : 20;

        const result = await commandEngine.resolveCommand({ q, includeSemantic, limit });
        return ctx.json(result);
      }

      if (req.method === "POST" && pathname === "/api/command/execute") {
        let rawBody: Record<string, unknown>;
        try {
          rawBody = (await req.json()) as Record<string, unknown>;
        } catch {
          return ctx.json({ ok: false, error: "Request body must be valid JSON" }, 400);
        }
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return ctx.json({ ok: false, error: "Request body must be a JSON object" }, 400);
        }
        const q = typeof rawBody.q === "string" ? rawBody.q : "";
        const confirm = rawBody.confirm === true;
        const localOrigin = url.origin;

        const outcome = await commandEngine.executeCommand({ q, confirm, localOrigin });
        return ctx.json(outcome.body, outcome.status);
      }

      if (req.method === "GET" && pathname === "/api/crosslinks") {
        const rawKind = (url.searchParams.get("kind") || "all").trim().toLowerCase();
        const kind: "taste" | "codex" | "all" =
          rawKind === "taste" || rawKind === "codex" ? rawKind : "all";
        const force = url.searchParams.get("force") === "true" || url.searchParams.get("force") === "1";
        const includeProposals = url.searchParams.get("includeProposals") !== "false";

        const result = await crossPollinator.computeCrosslinks({
          force,
          kind,
          includeProposals,
        });
        return ctx.json(result);
      }

      return ctx.json({ ok: false, error: "Not found" }, 404);
    },
  };
};

export default createCommandRoutes;
