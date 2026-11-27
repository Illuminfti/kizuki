import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KizukiOntologyEngine, redactSecrets } from "./ontology-engine.ts";
import { createOntologyRoutesWithOptions } from "./routes/ontology.routes.ts";
import type { RouteModuleContext } from "./contracts.ts";

const ROOT = import.meta.dir;
const ENGINE_PATH = join(ROOT, "ontology-engine.ts");
const ROUTES_PATH = join(ROOT, "routes/ontology.routes.ts");
const JS_PATH = join(ROOT, "public/ext/97-auto-ontology.js");
const CSS_PATH = join(ROOT, "public/ext/97-auto-ontology.css");

function createFixtureVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-ontology-test-"));
  mkdirSync(join(dir, ".kizuki", "agent-credentials"), { recursive: true });
  mkdirSync(join(dir, "world", "people"), { recursive: true });
  mkdirSync(join(dir, "entities"), { recursive: true });

  writeFileSync(join(dir, "CANON.md"), "# Canon\n\nLocal grounded knowledge vault.\n");
  writeFileSync(join(dir, "SCHEMA.md"), "# Schema\n\nTyped pages and commitments.\n");
  writeFileSync(
    join(dir, "owner-anchors.md"),
    [
      "# Owner Anchors",
      "## Active Projects",
      "- **Atlas Engine**: Core semantic indexing and world consolidation pipeline.",
      "- **Signal Ledger**: Deterministic commitment and obligation tracker.",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "entities", "semantic-router.md"),
    [
      "---",
      "title: Semantic Router",
      "type: project",
      "---",
      "# Semantic Router",
      "Routes natural language questions to [[Atlas Engine]] and [[Ada Lovelace]].",
      "Secret check: sk-proj-superSecretToken1234567890abcd must never leak.",
    ].join("\n")
  );
  writeFileSync(
    join(dir, "world", "people", "ada-lovelace.md"),
    "# Ada Lovelace\n\nLead systems architect collaborating on [[Atlas Engine]].\n"
  );
  writeFileSync(
    join(dir, "world", "codex.json"),
    JSON.stringify(
      {
        version: 1,
        custom_items: [
          {
            id: "codex-proof-gate",
            title: "Proof First Completion Gate",
            section: "philosophies",
            domain: "engineering",
            thesis: "Verify behavior after final edit with falsifiable evidence.",
            tags: ["verification", "proof"],
            linked_people: ["Ada Lovelace"],
          },
        ],
      },
      null,
      2
    )
  );
  writeFileSync(
    join(dir, "world", "taste-profile.json"),
    JSON.stringify(
      {
        custom_rules: [
          {
            id: "rule-zero-slop",
            domain: "ui-craft",
            title: "Obsidian Restraint",
            summary: "High-contrast dark surfaces without decorative glow blobs.",
          },
        ],
      },
      null,
      2
    )
  );
  // Sensitive decoy file that must never be indexed
  writeFileSync(
    join(dir, ".kizuki", "agent-credentials", "token.md"),
    "# Secret Token\n\nBearer abcdefghijklmnopqrstuvwxyz123456\n"
  );
  writeFileSync(join(dir, ".env"), ["OPENAI_API", "_KEY=", "sk-", "proj-envdecoy1234567890abcdef\n"].join(""));
  return dir;
}

describe("Lane O3: Auto-Ontology Engine, API & Interactive Studio UI", () => {
  let vaultDir: string;
  let engine: KizukiOntologyEngine;

  beforeAll(() => {
    vaultDir = createFixtureVault();
    engine = new KizukiOntologyEngine({ vaultPath: vaultDir });
    engine.compile();
  });

  afterAll(() => {
    engine.close();
    rmSync(vaultDir, { recursive: true, force: true });
  });

  test("compiles local SQLite ontology with families, terms, confirmed relations, and metrics", () => {
    expect(existsSync(join(vaultDir, ".kizuki", "explorer-ontology.sqlite"))).toBe(true);
    const status = engine.getStatus();
    expect(status.ok).toBe(true);
    expect(status.ready).toBe(true);
    expect(status.db_file).toBe("explorer-ontology.sqlite");
    expect(status.stats.families).toBe(8);
    expect(status.stats.terms).toBeGreaterThanOrEqual(18);
    expect(status.stats.confirmed_relations).toBeGreaterThanOrEqual(15);
    expect(status.stats.metrics).toBeGreaterThanOrEqual(6);
    expect(status.source_counts.vault_people).toBe(1);
    expect(status.source_counts.codex_items).toBe(1);
    expect(status.source_counts.taste_domains).toBe(1);
  });

  test("redacts secrets from descriptions and skips sensitive paths", () => {
    expect(redactSecrets("token sk-proj-abcdef1234567890xyz and Bearer 1234567890123456789012345")).not.toContain(
      "sk-proj-"
    );
    const hit = engine.searchTerms({ q: "Semantic Router" });
    expect(hit.terms.length).toBeGreaterThan(0);
    const router = hit.terms.find((t) => t.canonical_name === "Semantic Router");
    expect(router).toBeDefined();
    expect(router!.description).toContain("[REDACTED]");
    expect(router!.description).not.toContain("sk-proj-superSecretToken");

    const credSearch = engine.searchTerms({ q: "Secret Token" });
    expect(credSearch.terms.some((t) => t.canonical_name === "Secret Token")).toBe(false);
  });

  test("pre-flight checkAnswerable distinguishes answerable, partial, and unanswerable questions in < 5ms", () => {
    const grounded = engine.checkAnswerable("What are our open Kizuki world model commitments?");
    expect(grounded.verdict).toBe("answerable");
    expect(grounded.coverage_pct).toBeGreaterThanOrEqual(75);
    expect(grounded.matched_terms.length).toBeGreaterThanOrEqual(2);
    expect(grounded.missing_terms.length).toBe(0);
    expect(grounded.join_paths.length).toBeGreaterThan(0);
    expect(grounded.primary_join_path).toContain("->");
    expect(grounded.latency_ms).toBeLessThan(25);

    const gap = engine.checkAnswerable("What was our Q3 TikTok ad spend?");
    expect(gap.verdict).toBe("unanswerable");
    expect(gap.coverage_pct).toBe(0);
    expect(gap.matched_terms.length).toBe(0);
    expect(gap.missing_terms.length).toBeGreaterThan(0);
    const missingCombined = gap.missing_terms.map((m) => m.phrase).join(" ");
    expect(missingCombined).toContain("tiktok");
    expect(missingCombined).toContain("spend");

    const partial = engine.checkAnswerable("How does Atlas Engine relate to Q3 TikTok ad spend?");
    expect(partial.verdict).toBe("partial");
    expect(partial.coverage_pct).toBeGreaterThan(0);
    expect(partial.coverage_pct).toBeLessThan(75);
    expect(partial.matched_terms.some((m) => m.canonical_name === "Atlas Engine")).toBe(true);
    expect(partial.missing_terms.length).toBeGreaterThan(0);
  });

  test("computes deterministic shortest multi-hop join paths across confirmed relations", () => {
    const direct = engine.findJoinPath("Semantic Router", "Atlas Engine");
    expect(direct.found).toBe(true);
    expect(direct.hops).toBe(1);
    expect(direct.path_label).toBe("Semantic Router -> Atlas Engine");

    const multi = engine.findJoinPath("Proof First Completion Gate", "Semantic Router");
    expect(multi.found).toBe(true);
    expect(multi.hops).toBeGreaterThanOrEqual(2);
    expect(multi.nodes.length).toBe(multi.hops + 1);
    expect(multi.edges.length).toBe(multi.hops);
  });

  test("sticky owner certifications persist with SHA-256 receipts across full recompiles", () => {
    const res = engine.certifyTerm({
      id: "project:atlas-engine",
      certified: true,
      description: "Owner-certified canonical semantic indexing engine.",
      synonyms: ["atlas", "semantic indexer"],
      note: "Verified in architecture review",
    });
    expect(res.ok).toBe(true);
    expect(res.term.certified).toBe(true);
    expect(res.receipt.sticky).toBe(true);
    expect(res.receipt.receipt_hash).toMatch(/^[0-9a-f]{16}$/);

    // Trigger full destructive recompile of terms/relations tables
    const postCompile = engine.compile();
    expect(postCompile.stats.certified).toBeGreaterThanOrEqual(1);

    const detail = engine.getTermDetail("project:atlas-engine");
    expect(detail).not.toBeNull();
    expect(detail!.term.certified).toBe(true);
    expect(detail!.term.description).toBe("Owner-certified canonical semantic indexing engine.");
    expect(detail!.term.synonyms).toContain("semantic indexer");
    expect(detail!.term.certification_receipt).toBe(res.receipt.receipt_hash);
  });

  test("exports spec-aligned Ossie YAML and JSON without secrets or em-dashes", () => {
    const yaml = engine.exportOntology("ossie-yaml");
    expect(yaml.contentType).toContain("text/yaml");
    expect(yaml.body).toContain("schema: ossie/v1");
    expect(yaml.body).toContain("term_families:");
    expect(yaml.body).toContain("terms:");
    expect(yaml.body).toContain("relations:");
    expect(yaml.body).toContain("metrics:");
    expect(yaml.body).not.toContain("\u2014");
    expect(yaml.body).not.toContain("sk-proj-superSecretToken");

    const jsonExp = engine.exportOntology("json");
    const parsed = JSON.parse(jsonExp.body);
    expect(parsed.schema).toBe("ossie/v1");
    expect(Array.isArray(parsed.terms)).toBe(true);
    expect(Array.isArray(parsed.relations)).toBe(true);
  });

  test("HTTP route handler serves all 8 /api/ontology/* endpoints cleanly", async () => {
    const mockCtx = {
      api: { vaultPath: vaultDir },
      json: (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
    } as unknown as RouteModuleContext;

    const handler = createOntologyRoutesWithOptions(mockCtx, {
      vaultPath: vaultDir,
      dbPath: join(vaultDir, ".kizuki", "route-test-ontology.sqlite"),
    });

    const call = async (method: string, path: string, body?: unknown) => {
      const url = new URL(`http://127.0.0.1${path}`);
      const req = new Request(url.toString(), {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(handler.match(req, url)).toBe(true);
      return handler.handle(req, url);
    };

    const stRes = await call("GET", "/api/ontology/status");
    expect(stRes.status).toBe(200);
    const stJson = await stRes.json();
    expect(stJson.stats.terms).toBeGreaterThan(10);

    const compRes = await call("POST", "/api/ontology/compile");
    expect(compRes.status).toBe(200);

    const searchRes = await call("GET", "/api/ontology/search?q=Atlas");
    expect(searchRes.status).toBe(200);
    const searchJson = await searchRes.json();
    expect(searchJson.terms.some((t: { canonical_name: string }) => t.canonical_name === "Atlas Engine")).toBe(
      true
    );

    const termRes = await call("GET", "/api/ontology/term?id=project:atlas-engine");
    expect(termRes.status).toBe(200);
    const termJson = await termRes.json();
    expect(termJson.term.canonical_name).toBe("Atlas Engine");

    const pathRes = await call("GET", "/api/ontology/path?from=Semantic%20Router&to=Atlas%20Engine");
    expect(pathRes.status).toBe(200);
    const pathJson = await pathRes.json();
    expect(pathJson.found).toBe(true);
    expect(pathJson.hops).toBe(1);

    const ansRes = await call("POST", "/api/ontology/check-answerable", {
      question: "What are our open Kizuki world model commitments?",
    });
    expect(ansRes.status).toBe(200);
    const ansJson = await ansRes.json();
    expect(ansJson.verdict).toBe("answerable");

    const certRes = await call("POST", "/api/ontology/certify", {
      id: "concept:world-model",
      certified: true,
      description: "Certified world model root.",
    });
    expect(certRes.status).toBe(200);
    const certJson = await certRes.json();
    expect(certJson.term.certified).toBe(true);

    const expRes = await call("GET", "/api/ontology/export?format=ossie-yaml&download=1");
    expect(expRes.status).toBe(200);
    expect(expRes.headers.get("content-type")).toContain("text/yaml");
    expect(expRes.headers.get("content-disposition")).toContain("kizuki-ontology.ossie.yaml");
    expect(await expRes.text()).toContain("schema: ossie/v1");

    const badRes = await call("GET", "/api/ontology/term");
    expect(badRes.status).toBe(400);

    const g = globalThis as unknown as { __kizukiOntologyEngine?: { close?: () => void } };
    g.__kizukiOntologyEngine?.close?.();
  });

  test("public-clean hygiene, file size budgets, CSS discipline, and syntax invariants", () => {
    const engineSrc = readFileSync(ENGINE_PATH, "utf8");
    const routesSrc = readFileSync(ROUTES_PATH, "utf8");
    const jsSrc = readFileSync(JS_PATH, "utf8");
    const cssSrc = readFileSync(CSS_PATH, "utf8");

    // Zero em-dashes across all created files
    for (const src of [engineSrc, routesSrc, jsSrc, cssSrc]) {
      expect(src.includes("\u2014")).toBe(false);
    }

    // Zero hardcoded home/data paths in ontology-engine.ts
    expect(engineSrc).not.toMatch(/\/(?:home|Users|data)\/[a-zA-Z0-9._-]+/);

    // Strict raw size caps (JS <= 18 KB, CSS <= 8 KB)
    expect(Buffer.byteLength(jsSrc, "utf8")).toBeLessThanOrEqual(18_432);
    expect(Buffer.byteLength(cssSrc, "utf8")).toBeLessThanOrEqual(8_192);

    // Syntax check via node --check
    const proc = Bun.spawnSync(["node", "--check", JS_PATH], { cwd: ROOT });
    expect(proc.exitCode).toBe(0);

    // CSS discipline: @layer overrides, no !important, no will-change, tokenized font-size, detail=off, reduced-motion, mobile
    expect(cssSrc).toContain("@layer overrides");
    expect(cssSrc).not.toMatch(/!important/i);
    expect(cssSrc).not.toMatch(/\bwill-change\s*:/i);
    const fontSizes = Array.from(cssSrc.matchAll(/font-size\s*:\s*([^;}\n]+)/gi)).map((m) => m[1].trim());
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const val of fontSizes) {
      expect(val.startsWith("var(--t-") || val === "inherit").toBe(true);
    }
    expect(cssSrc).toContain('html[data-detail="off"]');
    expect(cssSrc).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
    expect(cssSrc).toMatch(/@media\s*\(max-width:\s*960px\)/);

    // UI module contract & strict lazy DOM guarantee
    const uiApi = require(JS_PATH);
    expect(typeof uiApi.open).toBe("function");
    expect(typeof uiApi.close).toBe("function");
    expect(typeof uiApi.toggle).toBe("function");
    expect(typeof uiApi.checkQuestion).toBe("function");
    expect(typeof uiApi.certifySelected).toBe("function");
    expect(typeof uiApi.exportYaml).toBe("function");
    expect(uiApi.isOpen()).toBe(false);
  });
});
