// Dynamic route module for Live Auto-Ontology Engine & Semantic Answerability Studio
// Registers /api/ontology/{status,compile,search,term,path,check-answerable,certify,export}

import type { RouteModuleContext, RouteModuleFactory, RouteModuleHandler } from "../contracts.ts";
import {
  KizukiOntologyEngine,
  type CertifyTermInput,
  type ExternalCodexSeed,
  type ExternalTasteSeed,
  type OntologyEngineOptions,
} from "../ontology-engine.ts";

export interface OntologyRouteOptions extends OntologyEngineOptions {}

const ONTOLOGY_PATHS = new Set<string>([
  "/api/ontology/status",
  "/api/ontology/compile",
  "/api/ontology/search",
  "/api/ontology/term",
  "/api/ontology/path",
  "/api/ontology/check-answerable",
  "/api/ontology/certify",
  "/api/ontology/export",
]);

function parseOptionalBool(raw: string | null): boolean | undefined {
  if (raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "no") return false;
  return undefined;
}

export function createOntologyRoutesWithOptions(
  ctx: RouteModuleContext,
  opts: OntologyRouteOptions = {}
): RouteModuleHandler {
  const engine = new KizukiOntologyEngine({
    vaultPath: ctx.api?.vaultPath,
    getCodexItems(): ExternalCodexSeed[] {
      try {
        const res = ctx.codexApi?.getCodex?.({});
        if (!res || !Array.isArray(res.items)) return [];
        return res.items.map((it) => ({
          id: it.id,
          title: it.title,
          section: it.section,
          domain: it.domain,
          summary: it.summary,
          thesis: it.thesis,
          tags: it.tags,
          linked_people: it.linked_people,
        }));
      } catch {
        return [];
      }
    },
    getTasteDomains(): ExternalTasteSeed[] {
      try {
        const state = ctx.tasteApi?.getTasteState?.({});
        if (!state || !Array.isArray(state.domains)) return [];
        const rulesByDomain = new Map<string, Array<{ id: string; title: string; summary?: string }>>();
        for (const r of state.rules || []) {
          const list = rulesByDomain.get(r.domain) || [];
          list.push({ id: r.id, title: r.title, summary: r.summary });
          rulesByDomain.set(r.domain, list);
        }
        return state.domains.map((d) => ({
          id: d.id,
          name: d.label || d.id,
          description: d.description,
          rule_count: d.rule_count,
          rules: rulesByDomain.get(d.id) || [],
        }));
      } catch {
        return [];
      }
    },
    ...opts,
  });

  const g = globalThis as unknown as Record<string, unknown>;
  g.__kizukiOntologyEngine = engine;

  return {
    match(_req: Request, url: URL): boolean {
      return ONTOLOGY_PATHS.has(url.pathname);
    },

    async handle(req: Request, url: URL): Promise<Response> {
      const { pathname, searchParams } = url;
      try {
        if (req.method === "GET" && pathname === "/api/ontology/status") {
          return ctx.json(engine.getStatus(), 200);
        }

        if (req.method === "POST" && pathname === "/api/ontology/compile") {
          return ctx.json(engine.compile(), 200);
        }

        if (req.method === "GET" && pathname === "/api/ontology/search") {
          const q = searchParams.get("q") || "";
          const family = searchParams.get("family") || undefined;
          const kind = searchParams.get("kind") || undefined;
          const certified = parseOptionalBool(searchParams.get("certified"));
          const limitRaw = searchParams.get("limit");
          const limit = limitRaw ? Number(limitRaw) : undefined;
          return ctx.json(
            engine.searchTerms({
              q,
              family,
              kind,
              certified,
              limit: Number.isFinite(limit) ? limit : undefined,
            }),
            200
          );
        }

        if (req.method === "GET" && pathname === "/api/ontology/term") {
          const id = (searchParams.get("id") || "").trim();
          if (!id) {
            return ctx.json({ ok: false, error: "Query parameter 'id' is required" }, 400);
          }
          const detail = engine.getTermDetail(id);
          if (!detail) {
            return ctx.json({ ok: false, error: `Term not found: ${id}` }, 404);
          }
          return ctx.json({ ok: true, ...detail }, 200);
        }

        if (req.method === "GET" && pathname === "/api/ontology/path") {
          const from = (searchParams.get("from") || "").trim();
          const to = (searchParams.get("to") || "").trim();
          if (!from || !to) {
            return ctx.json({ ok: false, error: "Query parameters 'from' and 'to' are required" }, 400);
          }
          const maxHopsRaw = Number(searchParams.get("maxHops") || 5);
          const maxHops = Number.isFinite(maxHopsRaw) ? Math.max(1, Math.min(8, maxHopsRaw)) : 5;
          return ctx.json({ ok: true, ...engine.findJoinPath(from, to, maxHops) }, 200);
        }

        if (req.method === "POST" && pathname === "/api/ontology/check-answerable") {
          let body: { question?: string };
          try {
            body = (await req.json()) as { question?: string };
          } catch {
            return ctx.json({ ok: false, error: "Request body must be valid JSON" }, 400);
          }
          const question = typeof body?.question === "string" ? body.question.trim() : "";
          if (!question) {
            return ctx.json({ ok: false, error: "Field 'question' is required" }, 400);
          }
          return ctx.json({ ok: true, ...engine.checkAnswerable(question) }, 200);
        }

        if (req.method === "POST" && pathname === "/api/ontology/certify") {
          let body: CertifyTermInput;
          try {
            body = (await req.json()) as CertifyTermInput;
          } catch {
            return ctx.json({ ok: false, error: "Request body must be valid JSON" }, 400);
          }
          if (!body || typeof body.id !== "string" || !body.id.trim()) {
            return ctx.json({ ok: false, error: "Field 'id' is required" }, 400);
          }
          try {
            return ctx.json(engine.certifyTerm(body), 200);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return ctx.json({ ok: false, error: msg }, msg.includes("not found") ? 404 : 400);
          }
        }

        if (req.method === "GET" && pathname === "/api/ontology/export") {
          const fmtRaw = (searchParams.get("format") || "ossie-yaml").trim().toLowerCase();
          if (fmtRaw !== "ossie-yaml" && fmtRaw !== "json") {
            return ctx.json(
              { ok: false, error: "Invalid format. Expected 'ossie-yaml' or 'json'" },
              400
            );
          }
          const exported = engine.exportOntology(fmtRaw);
          const headers: Record<string, string> = {
            "Content-Type": exported.contentType,
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
          };
          if (searchParams.get("download") === "1") {
            headers["Content-Disposition"] = `attachment; filename="${exported.filename}"`;
          }
          return new Response(exported.body, { status: 200, headers });
        }

        return ctx.json({ ok: false, error: "Method not allowed" }, 405);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return ctx.json({ ok: false, error: message }, 500);
      }
    },
  };
}

const createOntologyRoutes: RouteModuleFactory = (ctx) =>
  createOntologyRoutesWithOptions(ctx);

export default createOntologyRoutes;
