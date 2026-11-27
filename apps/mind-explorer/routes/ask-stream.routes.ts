import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import {
  QuickCaptureError,
  createAskStreamResponse,
  getRecentQuickCaptures,
  saveQuickCapture,
  type AskHistoryTurn,
  type AskStreamLlmOverride,
  type AskStreamRequest,
  type QuickCaptureRequest,
} from "../ask-stream.ts";

export interface AskStreamRouteOptions {
  llm?: AskStreamLlmOverride;
}

export function createAskStreamRoutesWithOptions(
  ctx: RouteModuleContext,
  opts?: AskStreamRouteOptions,
): RouteModuleHandler {
  return {
    overrides: ["/api/interact/stream", "/api/capture/quick", "/api/capture/recent"],

    match(req: Request, url: URL): boolean {
      if (req.method === "POST" && url.pathname === "/api/interact/stream") return true;
      if (req.method === "POST" && url.pathname === "/api/capture/quick") return true;
      if (req.method === "GET" && url.pathname === "/api/capture/recent") return true;
      return false;
    },

    async handle(req: Request, url: URL): Promise<Response> {
      if (req.method === "POST" && url.pathname === "/api/interact/stream") {
        let rawBody: Record<string, unknown>;
        try {
          rawBody = (await req.json()) as Record<string, unknown>;
        } catch {
          return ctx.json({ ok: false, error: "Request body must be valid JSON" }, 400);
        }
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return ctx.json({ ok: false, error: "Request body must be a JSON object" }, 400);
        }

        const input =
          typeof rawBody.input === "string" && rawBody.input.trim()
            ? rawBody.input.trim()
            : typeof rawBody.query === "string" && rawBody.query.trim()
              ? rawBody.query.trim()
              : typeof rawBody.question === "string" && rawBody.question.trim()
                ? rawBody.question.trim()
                : "";
        if (!input) {
          return ctx.json({ ok: false, error: "input is required" }, 400);
        }

        const history: AskHistoryTurn[] = [];
        if (Array.isArray(rawBody.history)) {
          for (const item of rawBody.history.slice(-12)) {
            if (!item || typeof item !== "object") continue;
            const rec = item as Record<string, unknown>;
            if ((rec.role === "user" || rec.role === "assistant") && typeof rec.content === "string") {
              history.push({ role: rec.role, content: rec.content });
            }
          }
        }

        const streamReq: AskStreamRequest = {
          input,
          history,
          contextView: typeof rawBody.contextView === "string" ? rawBody.contextView.trim() : undefined,
          boardChannel: typeof rawBody.boardChannel === "string" ? rawBody.boardChannel.trim() : undefined,
          boardThreadId:
            typeof rawBody.boardThreadId === "string" && rawBody.boardThreadId.trim()
              ? rawBody.boardThreadId.trim()
              : typeof rawBody.boardThreadId === "number" && Number.isFinite(rawBody.boardThreadId)
                ? String(rawBody.boardThreadId)
                : undefined,
          fastOnly: Boolean(rawBody.fastOnly),
        };

        return createAskStreamResponse(ctx, streamReq, {
          llm: opts?.llm,
          signal: req.signal,
        });
      }

      if (req.method === "POST" && url.pathname === "/api/capture/quick") {
        let rawBody: QuickCaptureRequest;
        try {
          rawBody = (await req.json()) as QuickCaptureRequest;
        } catch {
          return ctx.json({ ok: false, error: "Request body must be valid JSON" }, 400);
        }
        if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) {
          return ctx.json({ ok: false, error: "Request body must be a JSON object" }, 400);
        }

        try {
          const saved = await saveQuickCapture(ctx, rawBody);
          return ctx.json(saved, 200);
        } catch (err) {
          if (err instanceof QuickCaptureError) {
            return ctx.json({ ok: false, error: err.message }, err.status);
          }
          const msg = err instanceof Error ? err.message : "Failed to save quick capture";
          return ctx.json({ ok: false, error: msg }, 500);
        }
      }

      if (req.method === "GET" && url.pathname === "/api/capture/recent") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 12;
        const items = getRecentQuickCaptures(ctx.api.vaultPath, limit);
        return ctx.json({ ok: true, count: items.length, items }, 200);
      }

      return ctx.json({ ok: false, error: "Not Found" }, 404);
    },
  };
}

const createAskStreamRoutes: RouteModuleFactory = (ctx: RouteModuleContext): RouteModuleHandler =>
  createAskStreamRoutesWithOptions(ctx);

export default createAskStreamRoutes;
