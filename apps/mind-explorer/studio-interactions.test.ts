import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = import.meta.dir;
const JS_PATH = join(ROOT, "public/ext/93-sonner-floating-dnd.js");
const CSS_PATH = join(ROOT, "public/ext/93-sonner-floating-dnd.css");

const jsText = readFileSync(JS_PATH, "utf8");
const cssText = readFileSync(CSS_PATH, "utf8");

function loadSfdInVm() {
  const sandbox: Record<string, unknown> = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Map,
    Set,
    Array,
    Number,
    String,
    Boolean,
    Object,
    encodeURIComponent,
    module: { exports: {} },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(jsText, sandbox, { filename: JS_PATH });
  return (sandbox.module as { exports: Record<string, unknown> }).exports;
}

describe("Lane U2: Sonner Toast Deck, Floating UI Popovers, Accessible DnD & Biometric ECG", () => {
  test("1. strict byte budgets (JS <= 14,848 B and <= 14,500 B; CSS <= 5,632 B and <= 5,500 B)", () => {
    const jsBytes = statSync(JS_PATH).size;
    const cssBytes = statSync(CSS_PATH).size;
    expect(jsBytes).toBeGreaterThan(2000);
    expect(jsBytes).toBeLessThanOrEqual(14848);
    expect(jsBytes).toBeLessThanOrEqual(14500);
    expect(cssBytes).toBeGreaterThan(500);
    expect(cssBytes).toBeLessThanOrEqual(5632);
    expect(cssBytes).toBeLessThanOrEqual(5500);
  });

  test("2. static craft invariants (0 em-dashes, 0 !important, 0 literal font-size, 0 will-change)", () => {
    expect(jsText.includes("\u2014")).toBe(false);
    expect(cssText.includes("\u2014")).toBe(false);

    expect(cssText).not.toMatch(/!important/i);
    expect(cssText).not.toMatch(/\bwill-change\s*:/i);

    const fontSizeMatches = Array.from(cssText.matchAll(/font-size\s*:\s*([^;}]+)[;}]/gi));
    expect(fontSizeMatches.length).toBeGreaterThan(0);
    for (const m of fontSizeMatches) {
      expect(m[1].trim()).toMatch(/^var\(--t-[a-z0-9-]+\)$/);
    }

    expect(cssText).toContain('html[data-detail="off"]');
    expect(cssText).toContain("prefers-reduced-motion: reduce");
    expect(cssText).toContain("calc(100vw - 24px)");
  });

  test("3. Floating UI collision-clamp geometry math flips and clamps within 12px margin", () => {
    const api = loadSfdInVm() as {
      computePopoverPosition: (
        anchor: { top: number; bottom: number; left: number; right?: number; width: number },
        pop: { width: number; height: number },
        vp: { width: number; height: number },
        opts?: { margin?: number; gap?: number; prefer?: string }
      ) => { left: number; top: number; width: number; height: number; placement: string; arrowX: number };
    };

    // Standard placement below anchor
    const below = api.computePopoverPosition(
      { top: 100, bottom: 132, left: 400, width: 120 },
      { width: 312, height: 140 },
      { width: 1440, height: 900 }
    );
    expect(below.placement).toBe("bottom");
    expect(below.top).toBe(140);
    expect(below.left).toBe(304);
    expect(below.left).toBeGreaterThanOrEqual(12);
    expect(below.left + below.width).toBeLessThanOrEqual(1440 - 12);

    // Auto-flip above when anchor is near bottom edge
    const flipped = api.computePopoverPosition(
      { top: 820, bottom: 852, left: 600, width: 100 },
      { width: 312, height: 160 },
      { width: 1440, height: 900 }
    );
    expect(flipped.placement).toBe("top");
    expect(flipped.top).toBe(820 - 8 - 160);
    expect(flipped.top).toBeGreaterThanOrEqual(12);

    // Clamp left edge when anchor is at x=0
    const leftClamped = api.computePopoverPosition(
      { top: 200, bottom: 224, left: 0, width: 32 },
      { width: 312, height: 120 },
      { width: 1440, height: 900 }
    );
    expect(leftClamped.left).toBe(12);
    expect(leftClamped.arrowX).toBeGreaterThanOrEqual(14);

    // Clamp right edge when anchor is near right boundary
    const rightClamped = api.computePopoverPosition(
      { top: 200, bottom: 224, left: 1400, width: 36 },
      { width: 312, height: 120 },
      { width: 1440, height: 900 }
    );
    expect(rightClamped.left + rightClamped.width).toBeLessThanOrEqual(1440 - 12);
    expect(rightClamped.left).toBe(1440 - 12 - 312);

    // Mobile 390px viewport clamps width cleanly with 0px overflow
    const mobile = api.computePopoverPosition(
      { top: 120, bottom: 150, left: 320, width: 60 },
      { width: 420, height: 150 },
      { width: 390, height: 844 }
    );
    expect(mobile.width).toBeLessThanOrEqual(390 - 24);
    expect(mobile.left).toBeGreaterThanOrEqual(12);
    expect(mobile.left + mobile.width).toBeLessThanOrEqual(390 - 12);
  });

  test("4. Sonner toast stack cap (<= 3), dismiss, hover pause/resume, and 12s live-delta debounce", () => {
    const api = loadSfdInVm() as {
      createToastDeck: (opts?: {
        now?: () => number;
        setTimeout?: (fn: () => void, ms: number) => number;
        clearTimeout?: (id: number) => void;
      }) => {
        push: (spec: Record<string, unknown>) => string | null;
        dismiss: (id: string) => boolean;
        clear: () => void;
        pause: () => void;
        resume: () => void;
        onLiveDelta: (detail: { scopes?: string[] }) => string | null;
        getItems: () => Array<{ id: string; idx: number; title: string; detail: string; tone: string; actionLabel: string }>;
      };
    };

    let fakeNow = 1000;
    let nextTimerId = 1;
    const timers = new Map<number, { fn: () => void; fireAt: number }>();
    const deck = api.createToastDeck({
      now: () => fakeNow,
      setTimeout: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, fireAt: fakeNow + ms });
        return id;
      },
      clearTimeout: (id) => {
        timers.delete(id);
      },
    });

    const id1 = deck.push({ title: "First", tone: "info", durationMs: 4000 });
    const id2 = deck.push({ title: "Second", tone: "ok", durationMs: 4000 });
    const id3 = deck.push({ title: "Third", tone: "warn", actionLabel: "Undo", durationMs: 4000 });
    const id4 = deck.push({ title: "Fourth", tone: "accent", durationMs: 4000 });

    // Strictly capped at 3 visible cards, newest at idx 0
    const items = deck.getItems();
    expect(items.length).toBe(3);
    expect(items.map((x) => x.id)).toEqual([id4!, id3!, id2!]);
    expect(items.map((x) => x.idx)).toEqual([0, 1, 2]);
    expect(deck.dismiss(id1!)).toBe(false);

    // Pause prevents auto-dismiss; resume reschedules remaining ms
    fakeNow += 2000;
    deck.pause();
    expect(timers.size).toBe(0);
    deck.resume();
    expect(timers.size).toBe(3);

    // Manual dismiss removes target & re-indexes
    expect(deck.dismiss(id3!)).toBe(true);
    const afterDismiss = deck.getItems();
    expect(afterDismiss.map((x) => x.id)).toEqual([id4!, id2!]);
    expect(afterDismiss.map((x) => x.idx)).toEqual([0, 1]);

    // Live-delta debounce >= 12s
    deck.clear();
    fakeNow = 20000;
    const d1 = deck.onLiveDelta({ scopes: ["board", "today"] });
    expect(d1).toBeTruthy();
    fakeNow = 25000; // only 5s later -> suppressed
    expect(deck.onLiveDelta({ scopes: ["today"] })).toBeNull();
    fakeNow = 32000; // 12s later -> allowed
    const d2 = deck.onLiveDelta({ scopes: ["people"] });
    expect(d2).toBeTruthy();
  });

  test("5. Accessible DnD order persistence helpers and honest Biometric ECG telemetry states", () => {
    const api = loadSfdInVm() as {
      reorderList: (ids: string[], from: number, to: number) => string[];
      applySavedOrder: (ids: string[], saved: string[]) => string[];
      buildEcgState: (
        whoop: Record<string, unknown> | null,
        nowMs?: number
      ) => { status: string; tone: string; path: string; summary: string; rows: Array<[string, string]> };
    };

    expect(api.reorderList(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(api.applySavedOrder(["a", "b", "c", "d"], ["c", "a"])).toEqual(["c", "a", "b", "d"]);

    // Offline Whoop never fabricates recovery numbers
    const offline = api.buildEcgState(null);
    expect(offline.status).toBe("offline");
    expect(offline.tone).toBe("stale");
    expect(offline.summary).toContain("offline");
    expect(offline.rows.some((r) => r[0] === "Recovery")).toBe(false);

    // Stale Whoop is explicitly marked stale
    const stale = api.buildEcgState({ recovery_pct: 82, hrv_ms: 68, is_stale: true, date_label: "Nov 10" });
    expect(stale.status).toBe("stale");
    expect(stale.tone).toBe("stale");
    expect(stale.summary).toContain("stale");

    // Live Whoop shows live ECG path & green/amber/red tone
    const liveGreen = api.buildEcgState({ recovery_pct: 78, hrv_ms: 84, sleep_hours: 7.6, is_stale: false, date_label: "Today" });
    expect(liveGreen.status).toBe("live");
    expect(liveGreen.tone).toBe("green");
    expect(liveGreen.path).toContain("L19 2");
  });
});
