import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir);
const CSS_PATH = resolve(ROOT, "public/ext/92-studio-motion.css");
const JS_PATH = resolve(ROOT, "public/ext/92-studio-motion.js");

const cssText = readFileSync(CSS_PATH, "utf8");
const jsText = readFileSync(JS_PATH, "utf8");

// Load UMD module cleanly in Bun
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StudioMotion = require(JS_PATH) as {
  version: number;
  syncSegmented: (target?: unknown, opts?: Record<string, unknown>) => number;
  pulseThemeMorph: (doc?: unknown, win?: unknown) => boolean;
  clearPointerEffects: () => void;
  flushPointerFrame: (sample: { x: number; y: number; target: unknown }, doc?: unknown, win?: unknown) => void;
  computeFlipTransform: (
    prev: { x: number; y: number; w: number; h: number } | null,
    next: { x: number; y: number; w: number; h: number },
  ) => { invert: string; target: string };
  computeTilt: (x: number, y: number, rect: { left: number; top: number; width: number; height: number }) => { rx: number; ry: number };
  computeMagnetic: (x: number, y: number, rect: { left: number; top: number; width: number; height: number }) => { tx: number; ty: number };
};

interface MockRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

class MockElement {
  nodeType = 1;
  tagName: string;
  id = "";
  attrs = new Map<string, string>();
  classes = new Set<string>();
  styles = new Map<string, string>();
  children: MockElement[] = [];
  parentElement: MockElement | null = null;
  clientLeft = 0;
  clientTop = 0;
  scrollLeft = 0;
  scrollTop = 0;
  rect: MockRect;

  constructor(tag: string, rect: Partial<MockRect> = {}) {
    this.tagName = tag.toUpperCase();
    const left = rect.left ?? 0;
    const top = rect.top ?? 0;
    const width = rect.width ?? 100;
    const height = rect.height ?? 32;
    this.rect = { left, top, width, height, right: left + width, bottom: top + height };
  }

  get firstChild() {
    return this.children[0] ?? null;
  }

  get offsetWidth() {
    return this.rect.width;
  }

  get className() {
    return Array.from(this.classes).join(" ");
  }

  set className(val: string) {
    this.classes = new Set(val.split(/\s+/).filter(Boolean));
  }

  classList = {
    add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
    remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
    contains: (name: string) => this.classes.has(name),
  };

  style = new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "setProperty") {
          return (k: string, v: string) => this.styles.set(k, String(v));
        }
        if (prop === "getPropertyValue") {
          return (k: string) => this.styles.get(k) ?? "";
        }
        return this.styles.get(String(prop)) ?? "";
      },
      set: (_t, prop, value) => {
        this.styles.set(String(prop), String(value));
        return true;
      },
    },
  ) as Record<string, string> & {
    setProperty: (k: string, v: string) => void;
    getPropertyValue: (k: string) => string;
  };

  setAttribute(k: string, v: string) {
    if (k === "id") this.id = String(v);
    this.attrs.set(k, String(v));
  }

  getAttribute(k: string): string | null {
    if (k === "id") return this.id || null;
    return this.attrs.has(k) ? this.attrs.get(k)! : null;
  }

  removeAttribute(k: string) {
    this.attrs.delete(k);
  }

  appendChild(child: MockElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  insertBefore(child: MockElement, ref: MockElement | null) {
    child.parentElement = this;
    if (!ref) {
      this.children.push(child);
      return child;
    }
    const idx = this.children.indexOf(ref);
    if (idx === -1) this.children.push(child);
    else this.children.splice(idx, 0, child);
    return child;
  }

  getBoundingClientRect(): MockRect {
    return this.rect;
  }

  matches(selector: string): boolean {
    const parts = selector.split(",").map((s) => s.trim()).filter(Boolean);
    return parts.some((part) => {
      if (part.startsWith(".")) return this.classes.has(part.slice(1));
      if (part.startsWith("#")) return this.id === part.slice(1);
      const attrMatch = /^\[([a-zA-Z0-9_-]+)(?:="([^"]*)")?\]$/.exec(part);
      if (attrMatch) {
        const key = attrMatch[1];
        const expected = attrMatch[2];
        const actual = this.getAttribute(key);
        return expected === undefined ? actual !== null : actual === expected;
      }
      return this.tagName.toLowerCase() === part.toLowerCase();
    });
  }

  closest(selector: string): MockElement | null {
    let cur: MockElement | null = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector: string): MockElement[] {
    const out: MockElement[] = [];
    const walk = (node: MockElement) => {
      for (const c of node.children) {
        if (c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
}

function makeMockEnv(opts: { detail?: "on" | "off"; reduced?: boolean; hover?: boolean } = {}) {
  const html = new MockElement("html");
  html.setAttribute("data-detail", opts.detail ?? "on");
  html.setAttribute("data-theme", "dark");
  const body = new MockElement("body");
  html.appendChild(body);

  const doc = {
    hidden: false,
    documentElement: html,
    body,
    createElement: (tag: string) => new MockElement(tag),
    querySelectorAll: (sel: string) => body.querySelectorAll(sel),
  };

  const win = {
    matchMedia: (q: string) => ({
      matches:
        q.includes("prefers-reduced-motion")
          ? Boolean(opts.reduced)
          : q.includes("hover: hover")
            ? opts.hover !== false
            : false,
    }),
  };

  return { doc, win, html, body };
}

describe("Lane U1 Studio Motion budgets & static invariants", () => {
  test("file size budgets hold (CSS <= 5,500 B / 5,632 B, JS <= 12,000 B / 12,288 B)", () => {
    const cssBytes = statSync(CSS_PATH).size;
    const jsBytes = statSync(JS_PATH).size;
    expect(cssBytes).toBeGreaterThan(500);
    expect(cssBytes).toBeLessThanOrEqual(5500);
    expect(cssBytes).toBeLessThanOrEqual(5632);
    expect(jsBytes).toBeGreaterThan(1000);
    expect(jsBytes).toBeLessThanOrEqual(12000);
    expect(jsBytes).toBeLessThanOrEqual(12288);
  });

  test("zero literal em-dashes in CSS and JS", () => {
    expect(cssText.includes("\u2014")).toBe(false);
    expect(jsText.includes("\u2014")).toBe(false);
  });

  test("CSS enforces 0 !important, 0 literal font-size, 0 will-change", () => {
    expect(cssText).not.toMatch(/!important/i);
    expect(cssText).not.toMatch(/\bwill-change\s*:/i);
    const fontSizeDecls = cssText.match(/font-size\s*:\s*[^;]+/gi) ?? [];
    for (const decl of fontSizeDecls) {
      expect(decl).toMatch(/var\(--t-/);
    }
  });

  test("CSS includes @layer overrides, ?detail=off, prefers-reduced-motion, and @media (hover: hover)", () => {
    expect(cssText).toContain("@layer overrides");
    expect(cssText).toContain('html[data-detail="off"]');
    expect(cssText).toContain("@media (prefers-reduced-motion: reduce)");
    expect(cssText).toContain("@media (hover: hover)");
    expect(cssText).toContain("cubic-bezier(0.22, 1.28, 0.36, 1)");
    expect(cssText).toContain("--sm-mx");
    expect(cssText).toContain("--sm-my");
    expect(cssText).toContain("--sm-active");
  });

  test("node --check passes on public/ext/92-studio-motion.js", () => {
    const res = spawnSync("node", ["--check", JS_PATH], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stderr).toBe("");
  });
});

describe("Lane U1 Studio Motion runtime & physics logic", () => {
  test("exposes window.KizukiStudioMotion contract { syncSegmented, version: 1 }", () => {
    expect(StudioMotion.version).toBe(1);
    expect(typeof StudioMotion.syncSegmented).toBe("function");
  });

  test("computeFlipTransform produces exact compositor translate3d + scaleX", () => {
    const prev = { x: 4, y: 2, w: 60, h: 24 };
    const next = { x: 68, y: 2, w: 120, h: 24 };
    const res = StudioMotion.computeFlipTransform(prev, next);
    expect(res.invert).toBe("translate3d(4px, 2px, 0) scaleX(0.5)");
    expect(res.target).toBe("translate3d(68px, 2px, 0) scaleX(1)");
  });

  test("computeTilt clamps strictly within <= 2.2deg", () => {
    const rect = { left: 100, top: 100, width: 200, height: 100 };
    const corner = StudioMotion.computeTilt(400, 300, rect);
    expect(Math.abs(corner.rx)).toBeLessThanOrEqual(2.2);
    expect(Math.abs(corner.ry)).toBeLessThanOrEqual(2.2);
    const center = StudioMotion.computeTilt(200, 150, rect);
    expect(center.rx).toBe(0);
    expect(center.ry).toBe(0);
  });

  test("computeMagnetic clamps strictly within <= 3.2px", () => {
    const rect = { left: 50, top: 50, width: 120, height: 32 };
    const far = StudioMotion.computeMagnetic(500, -100, rect);
    expect(Math.abs(far.tx)).toBeLessThanOrEqual(3.2);
    expect(Math.abs(far.ty)).toBeLessThanOrEqual(3.2);
    const center = StudioMotion.computeMagnetic(110, 66, rect);
    expect(center.tx).toBe(0);
    expect(center.ty).toBe(0);
  });

  test("FLIP segmented thumb tracks active tab, animates on switch, snaps when detail=off or reduced-motion, and skips .os-nav", () => {
    const { doc, win, body } = makeMockEnv({ detail: "on", reduced: false });

    const bar = new MockElement("div", { left: 20, top: 10, width: 220, height: 30 });
    bar.classList.add("pb-tabs");
    bar.setAttribute("role", "tablist");

    const t1 = new MockElement("button", { left: 24, top: 13, width: 80, height: 24 });
    t1.classList.add("pb-tab", "is-active");
    t1.setAttribute("role", "tab");
    t1.setAttribute("aria-selected", "true");

    const t2 = new MockElement("button", { left: 110, top: 13, width: 100, height: 24 });
    t2.classList.add("pb-tab");
    t2.setAttribute("role", "tab");
    t2.setAttribute("aria-selected", "false");

    bar.appendChild(t1);
    bar.appendChild(t2);
    body.appendChild(bar);

    // Vertical sidebar nav must NOT receive a segmented thumb
    const nav = new MockElement("nav", { left: 0, top: 0, width: 220, height: 400 });
    nav.classList.add("os-nav");
    nav.setAttribute("role", "tablist");
    const n1 = new MockElement("button", { left: 8, top: 10, width: 200, height: 32 });
    n1.classList.add("is-active");
    nav.appendChild(n1);
    body.appendChild(nav);

    const synced = StudioMotion.syncSegmented(body, { doc, win });
    expect(synced).toBe(1);
    expect(nav.children.some((c) => c.classList.contains("sm-seg-thumb"))).toBe(false);

    const thumb = bar.children.find((c) => c.classList.contains("sm-seg-thumb"))!;
    expect(thumb).toBeDefined();
    expect(thumb.style.width).toBe("80px");
    expect(thumb.style.transform).toBe("translate3d(4px, 3px, 0) scaleX(1)");

    // Switch active tab -> spring FLIP transition
    t1.classList.remove("is-active");
    t1.setAttribute("aria-selected", "false");
    t2.classList.add("is-active");
    t2.setAttribute("aria-selected", "true");

    StudioMotion.syncSegmented(bar, { doc, win });
    expect(thumb.style.width).toBe("100px");
    expect(thumb.style.transform).toBe("translate3d(90px, 3px, 0) scaleX(1)");
    expect(thumb.style.transition).toContain("cubic-bezier(0.22, 1.28, 0.36, 1)");

    // Switch back under detail=off -> instant snap (transition: none)
    doc.documentElement.setAttribute("data-detail", "off");
    t2.classList.remove("is-active");
    t1.classList.add("is-active");
    StudioMotion.syncSegmented(bar, { doc, win });
    expect(thumb.style.transition).toBe("none");
    expect(thumb.style.transform).toBe("translate3d(4px, 3px, 0) scaleX(1)");

    // Switch under prefers-reduced-motion -> instant snap (transition: none)
    doc.documentElement.setAttribute("data-detail", "on");
    const reducedWin = makeMockEnv({ reduced: true }).win;
    t1.classList.remove("is-active");
    t2.classList.add("is-active");
    StudioMotion.syncSegmented(bar, { doc, win: reducedWin });
    expect(thumb.style.transition).toBe("none");
  });

  test("shared-border specular rim lights hovered + adjacent sibling tile, applies 3D tilt and magnetic pull, and clears under detail=off", () => {
    const { doc, win, body } = makeMockEnv({ detail: "on", reduced: false, hover: true });
    const grid = new MockElement("div", { left: 0, top: 0, width: 420, height: 200 });

    const tileA = new MockElement("article", { left: 0, top: 0, width: 200, height: 120 });
    tileA.classList.add("ust-tile", "sm-tilt-card");

    const tileB = new MockElement("article", { left: 204, top: 0, width: 200, height: 120 });
    tileB.classList.add("ust-tile");

    const btn = new MockElement("button", { left: 100, top: 70, width: 90, height: 28 });
    btn.classList.add("tr-detent-btn");
    tileA.appendChild(btn);

    grid.appendChild(tileA);
    grid.appendChild(tileB);
    body.appendChild(grid);

    // Pointer near right border of tileA (x=185, y=82) inside magnetic CTA
    StudioMotion.flushPointerFrame({ x: 185, y: 82, target: btn }, doc, win);

    expect(tileA.getAttribute("data-sm-lit")).toBe("1");
    expect(tileA.style.getPropertyValue("--sm-mx")).toBe("185px");
    expect(tileA.style.getPropertyValue("--sm-active")).toBe("1");

    // Adjacent tileB catches the shared-border specular beam with negative relative x (-19px)
    expect(tileB.getAttribute("data-sm-lit")).toBe("1");
    expect(tileB.style.getPropertyValue("--sm-mx")).toBe("-19px");
    expect(Number(tileB.style.getPropertyValue("--sm-active"))).toBeGreaterThan(0.2);

    // 3D tilt applied within <= 2.2deg
    expect(tileA.getAttribute("data-sm-tilt")).toBe("1");
    expect(Math.abs(parseFloat(tileA.style.getPropertyValue("--sm-ry")))).toBeLessThanOrEqual(2.2);

    // Magnetic pull applied within <= 3.2px
    expect(btn.getAttribute("data-sm-mag")).toBe("1");
    expect(Math.abs(parseFloat(btn.style.getPropertyValue("--sm-tx")))).toBeLessThanOrEqual(3.2);

    // Turning detail=off clears all active specular, tilt, and magnetic state
    doc.documentElement.setAttribute("data-detail", "off");
    StudioMotion.flushPointerFrame({ x: 185, y: 82, target: btn }, doc, win);
    expect(tileA.getAttribute("data-sm-lit")).toBeNull();
    expect(tileB.getAttribute("data-sm-lit")).toBeNull();
    expect(tileA.getAttribute("data-sm-tilt")).toBeNull();
    expect(btn.getAttribute("data-sm-mag")).toBeNull();
    expect(btn.style.getPropertyValue("--sm-tx")).toBe("0px");
  });

  test("morphing theme switch pulses #btn-theme-toggle and respects detail=off", () => {
    const { doc, win, body } = makeMockEnv({ detail: "on", reduced: false });
    const themeBtn = new MockElement("button", { left: 0, top: 0, width: 28, height: 28 });
    themeBtn.setAttribute("id", "btn-theme-toggle");
    body.appendChild(themeBtn);

    expect(StudioMotion.pulseThemeMorph(doc, win)).toBe(true);
    expect(themeBtn.classList.contains("is-sm-morphing")).toBe(true);

    doc.documentElement.setAttribute("data-detail", "off");
    expect(StudioMotion.pulseThemeMorph(doc, win)).toBe(false);
  });
});
