import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const CSS_PATH = join(ROOT, "public/ext/95-a11y-focus.css");
const JS_PATH = join(ROOT, "public/ext/95-a11y-focus.js");

const css = readFileSync(CSS_PATH, "utf8");
const js = readFileSync(JS_PATH, "utf8");

describe("Lane U4: Radix-Grade Focus & A11y Studio Layer", () => {
  test("size budgets: JS <= 8,704 B and CSS <= 3,584 B", () => {
    const jsBytes = statSync(JS_PATH).size;
    const cssBytes = statSync(CSS_PATH).size;
    expect(jsBytes).toBeGreaterThan(500);
    expect(jsBytes).toBeLessThanOrEqual(8704);
    expect(cssBytes).toBeGreaterThan(300);
    expect(cssBytes).toBeLessThanOrEqual(3584);
  });

  test("CSS static invariants: zero !important, zero literal font-size, zero will-change, zero em-dashes", () => {
    expect(css).not.toMatch(/!important/i);
    expect(css).not.toMatch(/will-change\s*:/i);
    expect(css).not.toContain("\u2014");

    // Every font-size declaration must reference a var(--t-*) design token.
    const fontSizeMatches = [...css.matchAll(/font-size\s*:\s*([^;]+);/gi)];
    for (const m of fontSizeMatches) {
      expect(m[1].trim()).toMatch(/^var\(--t-[a-z0-9-]+\)$/i);
    }

    // Must style skip link and keyboard-only anodized focus-visible ring.
    expect(css).toContain("#kizuki-skip-link");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("2px solid var(--accent)");
    expect(css).toContain("outline-offset: 2px");
  });

  test("JS static invariants: valid syntax via node --check, zero em-dashes, skip link & roving focus", () => {
    expect(js).not.toContain("\u2014");
    expect(js).toContain("kizuki-skip-link");
    expect(js).toContain(".os-nav-list");
    expect(js).toContain(".today-tabs");
    expect(js).toContain(".pb-tabs");
    expect(js).toContain("ArrowLeft");
    expect(js).toContain("ArrowRight");
    expect(js).toContain("ArrowUp");
    expect(js).toContain("ArrowDown");

    const check = Bun.spawnSync(["node", "--check", JS_PATH]);
    expect(check.exitCode).toBe(0);
  });
});
