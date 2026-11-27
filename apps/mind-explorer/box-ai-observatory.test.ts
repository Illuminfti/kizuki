import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const CSS_PATH = join(ROOT, "public/ext/96-box-ai-observatory.css");
const JS_PATH = join(ROOT, "public/ext/96-box-ai-observatory.js");

const cssSource = readFileSync(CSS_PATH, "utf8");
const jsSource = readFileSync(JS_PATH, "utf8");
const cssBytes = Buffer.byteLength(cssSource, "utf8");
const jsBytes = Buffer.byteLength(jsSource, "utf8");

describe("Lane W2: Always-On Live AI Header Pill & Box AI Neural Observatory (Alt+I)", () => {
  test("strict file size budgets (CSS <= 5,500 B, JS <= 20,480 B)", () => {
    expect(cssBytes).toBeGreaterThan(500);
    expect(cssBytes).toBeLessThanOrEqual(5632);
    expect(cssBytes).toBeLessThanOrEqual(5500);

    expect(jsBytes).toBeGreaterThan(1500);
    expect(jsBytes).toBeLessThanOrEqual(20480);
  });

  test("static invariants: zero em-dashes, zero !important, zero literal font-size, zero will-change, zero shadowBlur, zero ctx.filter", () => {
    expect(cssSource.includes("\u2014")).toBe(false);
    expect(jsSource.includes("\u2014")).toBe(false);

    expect(cssSource).not.toMatch(/!important/i);
    expect(cssSource).not.toMatch(/\bwill-change\s*:/i);

    const fontSizes = Array.from(cssSource.matchAll(/font-size\s*:\s*([^;}\n]+)/gi)).map((m) => m[1].trim());
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const val of fontSizes) {
      expect(val.startsWith("var(--t-")).toBe(true);
    }

    expect(jsSource).not.toMatch(/\bshadowBlur\b/);
    expect(jsSource).not.toMatch(/\bctx\.filter\b/);
  });

  test("syntax check passes via node --check", () => {
    const proc = Bun.spawnSync(["node", "--check", JS_PATH], { cwd: ROOT });
    expect(proc.exitCode).toBe(0);
  });

  test("always-on pill mounts, live API endpoints, SSE stream, and Observatory visual primitives are present", () => {
    expect(jsSource).toContain("/api/box/ai-live");
    expect(jsSource).toContain("/api/box/ai-live/stream");
    expect(jsSource).toContain("addEventListener('snapshot'");
    expect(jsSource).toContain("addEventListener('update'");
    expect(jsSource).toContain(".os-rail-controls");
    expect(jsSource).toContain(".mobile-topbar-right");
    expect(jsSource).toContain("window.KizukiBoxAi");
    expect(jsSource).toContain("Box AI Neural Observatory");
    expect(jsSource).toContain("SHARED BRAINS & REPOS");
    expect(jsSource).toContain("Alt+I");
    expect(jsSource).toContain("KeyI");
    expect(jsSource).toContain("visibilitychange");
    expect(jsSource).toContain("drawSocket");
    expect(jsSource).toContain("buildConduitPoints");
  });

  test("CSS covers detail=off 0px CLS guardrail, prefers-reduced-motion, and mobile 390px responsiveness", () => {
    expect(cssSource).toContain("@layer overrides");
    expect(cssSource).toContain('html[data-detail="off"]');
    expect(cssSource).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
    expect(cssSource).toMatch(/@media\s*\(max-width:\s*960px\)/);
    expect(cssSource).toContain(".bai-pill");
    expect(cssSource).toContain(".bai-mob");
    expect(cssSource).toContain(".bai-bd");
  });

  test("strictly lazy-DOM guarantee: modal DOM is built only on open(), never in boot()", () => {
    const buildIdx = jsSource.indexOf("function buildModalDom()");
    const openIdx = jsSource.indexOf("function open(");
    const bootIdx = jsSource.indexOf("function boot()");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(openIdx).toBeGreaterThan(buildIdx);
    expect(bootIdx).toBeGreaterThan(openIdx);

    const bootBody = jsSource.slice(bootIdx);
    expect(bootBody).not.toContain("buildModalDom()");
    expect(bootBody).toMatch(/get\('ai'\)\s*===\s*'live'/);
  });

  test("window.KizukiBoxAi contract: defensive snapshot normalization, filter switching, node selection", () => {
    const api = require(JS_PATH);
    expect(typeof api.open).toBe("function");
    expect(typeof api.close).toBe("function");
    expect(typeof api.toggle).toBe("function");
    expect(typeof api.isOpen).toBe("function");
    expect(typeof api.setFilter).toBe("function");
    expect(typeof api.selectNode).toBe("function");
    expect(typeof api.refresh).toBe("function");
    expect(typeof api.applySnapshot).toBe("function");
    expect(typeof api.getState).toBe("function");
    expect(api.isOpen()).toBe(false);

    // Defensive parsing with em-dash stripping and partial fields
    api.applySnapshot({
      ts: "2026-11-27T12:00:00Z",
      summary: {
        total_live: 4,
        building: 1,
        designing: 1,
        predicting: 1,
        orchestrating: 1,
        total_cpu_pct: 84.2,
        total_ram_mb: 2048,
        host_load: [1.34, 1.12, 0.98],
      },
      agents: [
        {
          id: "a1",
          name: "Codex \u2014 Builder",
          runtime: "codex",
          category: "building",
          state: "active",
          pid: 4210,
          cpu_pct: 52.5,
          ram_mb: 640,
          uptime_s: 3720,
          repo: "kizuki-mind-explorer",
          current_action: "Edit \u2014 96-box-ai-observatory.js",
          active_tool: "Edit",
          recent_actions: ["Read tokens.css", "Write 96-box-ai-observatory.css"],
        },
        {
          id: "a2",
          name: "Neon Visual",
          runtime: "antigravity",
          category: "designing",
          state: "active",
          pid: 4211,
          cpu_pct: 18.0,
          ram_mb: 512,
          uptime_s: 600,
          repo: "kizuki-mind-explorer",
          current_action: "Render optical bus",
          active_tool: "Canvas2D",
        },
      ],
      resources: [
        { id: "r1", label: "Kizuki Vault", kind: "brain", metric: "13.2k", active_count: 2 },
      ],
      edges: [
        { id: "e1", from: "a1", to: "r1", category: "building", label: "Edit", weight: 1.2, cpu_pct: 52.5, active: true },
      ],
    });

    const snap = api.getState();
    expect(snap.data.summary.total_live).toBe(4);
    expect(snap.data.agents.length).toBe(2);
    expect(snap.data.agents[0].name).not.toContain("\u2014");
    expect(snap.data.agents[0].current_action).not.toContain("\u2014");
    expect(api.setFilter("building")).toBe("building");
    expect(api.setFilter("invalid-cat")).toBe("all");
    expect(api.selectNode("a1")).toBe("a1");
    expect(api.getState().selectedId).toBe("a1");
    api.selectNode(null);
  });
});
