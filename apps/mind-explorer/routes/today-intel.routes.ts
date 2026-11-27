import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  PeopleRadarEntry,
  RouteModuleContext,
  RouteModuleFactory,
  RouteModuleHandler,
} from "../contracts.ts";
import {
  BadRequestError,
  DecisionLedger,
  SecretDetectedError,
  type DecisionUndoRequest,
  type ExtendedDecisionStampRequest,
  type TodayTriageRequest,
} from "../decision-ledger.ts";
import { buildNextMoves } from "../today-intel.ts";
import type { PersonDirectoryItem, TodayResponse } from "../vault-api.ts";

export interface TodayIntelRouteOptions {
  ledgerPath?: string;
  triagePath?: string;
  undoWindowMs?: number;
  nowFn?: () => number;
  loadDriftAlerts?: () => Promise<PeopleRadarEntry[]>;
}

async function parseJsonObject(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new BadRequestError("Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BadRequestError("Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

interface PeopleRadarServiceLike {
  getRadar: () => Promise<{ drifting?: PeopleRadarEntry[] }>;
  startBackgroundRefresh?: (intervalMs?: number) => void;
}

function createC3DriftLoader(ctx: RouteModuleContext): () => Promise<PeopleRadarEntry[]> {
  let servicePromise: Promise<PeopleRadarServiceLike | null> | null = null;

  const getService = (): Promise<PeopleRadarServiceLike | null> => {
    if (servicePromise) return servicePromise;
    servicePromise = (async () => {
      try {
        const radarPath = join(import.meta.dir, "..", "people-radar.ts");
        if (!existsSync(radarPath)) return null;
        const mod = (await import(radarPath)) as {
          PeopleRadarService?: new (opts: {
            api: RouteModuleContext["api"];
            boardBridge?: RouteModuleContext["boardBridge"];
          }) => PeopleRadarServiceLike;
        };
        if (typeof mod.PeopleRadarService !== "function") return null;
        const svc = new mod.PeopleRadarService({
          api: ctx.api,
          boardBridge: ctx.boardBridge,
        });
        if (typeof svc.startBackgroundRefresh === "function") {
          svc.startBackgroundRefresh(90_000);
        }
        return svc;
      } catch {
        return null;
      }
    })();
    return servicePromise;
  };

  return async (): Promise<PeopleRadarEntry[]> => {
    try {
      const svc = await getService();
      if (!svc) return [];
      // Race against a 250ms budget so cold radar warmup never stalls Today Next-Moves.
      const res = await Promise.race([
        svc.getRadar(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      return Array.isArray(res?.drifting) ? res.drifting : [];
    } catch {
      return [];
    }
  };
}

export function createTodayIntelRoutesWithOptions(
  ctx: RouteModuleContext,
  opts: TodayIntelRouteOptions = {},
): RouteModuleHandler {
  const ledger = new DecisionLedger({
    agentBoardApi: ctx.agentBoardApi,
    boardBridge: ctx.boardBridge,
    ledgerPath: opts.ledgerPath,
    triagePath: opts.triagePath,
    undoWindowMs: opts.undoWindowMs,
    nowFn: opts.nowFn,
  });

  const loadDriftAlerts =
    opts.loadDriftAlerts || createC3DriftLoader(ctx);

  const routes = new Set([
    "/api/decisions/pending",
    "/api/decisions/stamp",
    "/api/decisions/undo",
    "/api/today/next-moves",
    "/api/today/triage",
  ]);

  return {
    match(req: Request, url: URL): boolean {
      if (!routes.has(url.pathname)) return false;
      if (url.pathname === "/api/decisions/pending" || url.pathname === "/api/today/next-moves") {
        return req.method === "GET";
      }
      return req.method === "POST";
    },

    async handle(req: Request, url: URL): Promise<Response> {
      try {
        if (req.method === "GET" && url.pathname === "/api/decisions/pending") {
          const gates = await ledger.getPendingDecisions();
          const openCount = gates.filter((g) => !g.stamped).length;
          const stampedCount = gates.length - openCount;
          return ctx.json({
            ok: true,
            generated_at: new Date((opts.nowFn || Date.now)()).toISOString(),
            pending: gates,
            gates,
            decisions: gates,
            counts: {
              total: gates.length,
              open: openCount,
              stamped: stampedCount,
            },
          });
        }

        if (req.method === "POST" && url.pathname === "/api/decisions/stamp") {
          const body = await parseJsonObject(req);
          const result = await ledger.stampDecision(
            body as unknown as ExtendedDecisionStampRequest,
          );
          return ctx.json(result, 200);
        }

        if (req.method === "POST" && url.pathname === "/api/decisions/undo") {
          const body = await parseJsonObject(req);
          const result = await ledger.undoDecision(
            body as unknown as DecisionUndoRequest,
          );
          return ctx.json(result, 200);
        }

        if (req.method === "GET" && url.pathname === "/api/today/next-moves") {
          const limitRaw = url.searchParams.get("limit");
          const maxMoves = limitRaw ? Math.max(1, Math.min(20, Number(limitRaw) || 5)) : 5;

          const [today, pendingDecisions, peopleRes, driftAlerts] = await Promise.all([
            ctx.api.getToday({ includeNoise: false }).catch((): Partial<TodayResponse> | null => null),
            ledger.getPendingDecisions().catch(() => []),
            ctx.api
              .listPeople({ limit: 300 })
              .then((r) => (Array.isArray(r?.items) ? r.items : []))
              .catch((): PersonDirectoryItem[] => []),
            loadDriftAlerts().catch((): PeopleRadarEntry[] => []),
          ]);

          const nowMs = (opts.nowFn || Date.now)();
          const hiddenMoveIds = ledger.getHiddenMoveIds(nowMs);
          const payload = buildNextMoves({
            nowMs,
            today,
            pendingDecisions,
            people: peopleRes,
            driftAlerts,
            hiddenMoveIds,
            maxMoves,
          });
          return ctx.json(payload, 200);
        }

        if (req.method === "POST" && url.pathname === "/api/today/triage") {
          const body = await parseJsonObject(req);
          const result = await ledger.recordTriage(body as unknown as TodayTriageRequest);
          return ctx.json(result, 200);
        }

        return ctx.json({ ok: false, error: "Route not handled" }, 404);
      } catch (err) {
        if (err instanceof SecretDetectedError) {
          const rule = err.findings?.[0]?.ruleId || null;
          return ctx.json(
            {
              ok: false,
              error: "secret_detected",
              message: err.message,
              rule,
              findings: err.findings,
            },
            422,
          );
        }
        if (err instanceof BadRequestError) {
          return ctx.json({ ok: false, error: err.message }, 400);
        }
        const message = err instanceof Error ? err.message : String(err);
        return ctx.json({ ok: false, error: message }, 500);
      }
    },
  };
}

const createTodayIntelRoutes: RouteModuleFactory = (ctx) =>
  createTodayIntelRoutesWithOptions(ctx);

export default createTodayIntelRoutes;
