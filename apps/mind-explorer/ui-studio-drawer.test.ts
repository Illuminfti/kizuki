import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const CSS_PATH = join(ROOT, "public/ext/94-ui-studio-drawer.css");
const JS_PATH = join(ROOT, "public/ext/94-ui-studio-drawer.js");

const cssSource = readFileSync(CSS_PATH, "utf8");
const jsSource = readFileSync(JS_PATH, "utf8");
const cssBytes = Buffer.byteLength(cssSource, "utf8");
const jsBytes = Buffer.byteLength(jsSource, "utf8");

describe("Lane U3: Kizuki UI/UX Studio Drawer & Embla Momentum Rails", () => {
  test("strict file size budgets (CSS <= 5,500 B / 5,632 B, JS <= 14,500 B / 14,848 B)", () => {
    expect(cssBytes).toBeGreaterThan(500);
    expect(cssBytes).toBeLessThanOrEqual(5632);
    expect(cssBytes).toBeLessThanOrEqual(5500);

    expect(jsBytes).toBeGreaterThan(1000);
    expect(jsBytes).toBeLessThanOrEqual(14848);
    expect(jsBytes).toBeLessThanOrEqual(14500);
  });

  test("static invariants: zero em-dashes, zero !important, zero literal font-size, zero will-change", () => {
    expect(cssSource.includes("\u2014")).toBe(false);
    expect(jsSource.includes("\u2014")).toBe(false);

    expect(cssSource).not.toMatch(/!important/i);
    expect(cssSource).not.toMatch(/\bwill-change\s*:/i);

    const fontSizes = Array.from(cssSource.matchAll(/font-size\s*:\s*([^;}\n]+)/gi)).map((m) => m[1].trim());
    expect(fontSizes.length).toBeGreaterThan(0);
    for (const val of fontSizes) {
      expect(val.startsWith("var(--t-")).toBe(true);
    }
  });

  test("syntax check passes via node --check", () => {
    const proc = Bun.spawnSync(["node", "--check", JS_PATH], { cwd: ROOT });
    expect(proc.exitCode).toBe(0);
  });

  test("all 12 live studio primitive tiles and header toggles are present", () => {
    const expectedTiles: Array<[string, string]> = [
      ["01", "Solar Chronometer"],
      ["02", "Spring Segmented"],
      ["03", "Theme Detent"],
      ["04", "Sonner Stack"],
      ["05", "Neural Radar"],
      ["06", "Detent Stamp"],
      ["07", "Elastic Vernier"],
      ["08", "Biometric ECG"],
      ["09", "Cover Flow"],
      ["10", "Magnetic CTA"],
      ["11", "Step Track"],
      ["12", "Live Wire & Perf"],
    ];

    for (const [idx, title] of expectedTiles) {
      expect(jsSource).toContain("'" + idx + "', '" + title + "'");
    }

    expect(jsSource).toContain("Kizuki UI/UX Studio");
    expect(jsSource).toContain("12 live primitives");
    expect(jsSource).toContain("Dark / Light");
    expect(jsSource).toContain("Detail On / Off");
    expect(jsSource).toContain("Reduced Motion Preview");
    expect(jsSource).toContain("window.KizukiUIStudio");
    expect(jsSource).toContain("/api/semantic/stats");
    expect(jsSource).toContain("/api/live/status");
    expect(jsSource).toContain("KizukiHyperCache");
    expect(jsSource).toContain("KizukiToast");
  });

  test("CSS defines responsive 4x3 desktop and 2x6 mobile grid plus reduced-motion & detail-off guardrails", () => {
    expect(cssSource).toMatch(/grid-template-columns\s*:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    expect(cssSource).toMatch(/grid-template-columns\s*:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
    expect(cssSource).toContain('html[data-detail="off"]');
    expect(cssSource).toMatch(/prefers-reduced-motion\s*:\s*reduce/);
    expect(cssSource).toContain('data-rm-preview="1"');
    expect(cssSource).toContain('html[data-theme="light"]');
  });

  test("strictly lazy-DOM guarantee: zero modal DOM built until open() is called", () => {
    const buildFnIndex = jsSource.indexOf("function buildModalDom()");
    const openFnIndex = jsSource.indexOf("function open()");
    const bootFnIndex = jsSource.indexOf("function boot()");
    expect(buildFnIndex).toBeGreaterThan(-1);
    expect(openFnIndex).toBeGreaterThan(buildFnIndex);
    expect(bootFnIndex).toBeGreaterThan(openFnIndex);

    const bootBody = jsSource.slice(bootFnIndex);
    expect(bootBody).not.toContain("buildModalDom()");
    expect(bootBody).toMatch(/get\('studio'\)\s*===\s*'1'/);

    const api = require(JS_PATH);
    expect(typeof api.open).toBe("function");
    expect(typeof api.close).toBe("function");
    expect(typeof api.toggle).toBe("function");
    expect(typeof api.enhanceRails).toBe("function");
    expect(api.isOpen()).toBe(false);
    expect(api.getTileIds()).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
  });

  test("Embla-style momentum carousel covers required card rails and guards against zero-overflow bloat", () => {
    expect(jsSource).toContain(".pr-lanes");
    expect(jsSource).toContain(".taste-deck-strip");
    expect(jsSource).toContain(".pb-prep-cards");
    expect(jsSource).toMatch(/scrollWidth\s*<=\s*rail\.clientWidth\s*\+\s*8/);
    expect(jsSource).toContain("ku-rail-dots");
    expect(cssSource).toContain(".ku-rail-dots");
    expect(cssSource).toMatch(/max-width\s*:\s*100%/);
  });
});
