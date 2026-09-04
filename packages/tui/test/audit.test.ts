import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyItems, initialState, reduce } from "../src/model";
import type { Effect } from "../src/model";
import { render } from "../src/view";
import { paint, sanitize, stringWidth } from "../src/ansi";
import { chars, item, named, press, resetCounter, state, VIEWPORT } from "./helpers";

const SOURCE_ROOT = resolve(import.meta.dir, "../src");

function effectTypes(effects: Effect[]): string[] {
  return effects.map((effect) => effect.type);
}

function source(name: string): string {
  return readFileSync(resolve(SOURCE_ROOT, name), "utf8");
}

beforeEach(() => {
  resetCounter();
});

describe("audit reducer", () => {
  test("the reducer emits only undo, open, filter, page, and quit", () => {
    const start = state([
      item({ page_path: "people/grace.md" }),
      item({ page_path: "people/linus.md", writer: "correction" }),
    ]);
    const allowed = new Set(["undo", "open", "filter", "page", "quit"]);
    const collected: string[] = [];

    const sequences: ReturnType<typeof chars>[] = [
      chars("q"),
      [named("ctrl-c")],
      chars("o"),
      [named("enter")],
      [...chars("/grace"), named("enter")],
      [...chars("/"), named("escape")],
      [...chars("u"), ...chars("yes"), named("enter")],
      chars("pema"),
      chars("jkJK"),
    ];
    for (const keys of sequences) {
      const result = press(start, keys);
      collected.push(...effectTypes(result.effects));
    }
    expect(collected.length).toBeGreaterThan(0);
    expect(collected.every((type) => allowed.has(type))).toBe(true);
    expect(collected.every((type) => type !== "page")).toBe(true);
    expect(new Set(collected)).toEqual(new Set(["undo", "open", "filter", "quit"]));
  });

  test("u with a typed yes confirmation emits undo bound to receipt id, path, and after-hash", () => {
    const start = state([item(), item()]);
    const selected = start.items[0];
    if (selected === undefined) throw new Error("expected a selected receipt");
    const result = press(start, [...chars("u"), ...chars("yes"), named("enter")]);
    expect(result.effects).toEqual([
      {
        type: "undo",
        receiptId: selected.receipt.receipt_id,
        afterHash: selected.receipt.after_hash,
        pagePath: selected.receipt.page_path,
      },
    ]);
    expect(result.state.mode.name).toBe("list");
  });

  test("u cancelled or confirmed without yes writes nothing", () => {
    const start = state([item()]);
    const cancelled = press(start, [...chars("u"), named("escape")]);
    expect(cancelled.effects).toEqual([]);
    const refused = press(start, [...chars("u"), ...chars("no"), named("enter")]);
    expect(refused.effects).toEqual([]);
    expect(refused.state.notice?.text).toContain("type yes");
  });

  test("o and enter emit open; q emits quit; slash emits filter", () => {
    const start = state([item({ page_path: "people/grace.md" })]);
    expect(press(start, chars("o")).effects).toEqual([
      { type: "open", path: "people/grace.md" },
    ]);
    expect(press(start, [named("enter")]).effects).toEqual([
      { type: "open", path: "people/grace.md" },
    ]);
    expect(press(start, chars("q")).effects).toEqual([{ type: "quit" }]);
    const filtered = press(start, [...chars("/grace"), named("enter")]);
    expect(filtered.effects).toEqual([{ type: "filter", text: "grace" }]);
    expect(filtered.state.filter).toBe("grace");
  });

  test("legacy approval keys do not emit a write", () => {
    const start = state([item()]);
    const result = press(start, chars("pema"));
    expect(result.effects).toEqual([]);
    expect(result.state.mode.name).toBe("list");
  });

  test("already reverted receipts refuse undo from the list", () => {
    const start = state([item({ reverted_by: "01LATER" })]);
    const result = press(start, chars("u"));
    expect(result.effects).toEqual([]);
    expect(result.state.notice?.text).toContain("already reverted");
  });

  test("no reducer path invokes a canon writer or approval action", () => {
    const model = source("model.ts");
    const app = source("app.ts");
    expect(model).not.toMatch(/\b(promote|reject|ownerPromote|writePage|applyCanonWrite)\b/);
    expect(model).not.toMatch(/\bapplyRevertWrite\b/);
    expect(app).toMatch(/\bundoReceipt\b/);
    expect(app).toMatch(/keyQueue/);
    expect(app).not.toMatch(/\b(ownerPromote|writePage|applyCanonWrite|applyRevertWrite)\b/);
    expect(model).toMatch(/type Effect/);
    expect(model).toMatch(/type: "undo"/);
    expect(model).toMatch(/type: "open"/);
    expect(model).toMatch(/type: "filter"/);
    expect(model).toMatch(/type: "quit"/);
    expect(model).toMatch(/type: "page"/);
    expect(model).toMatch(/afterHash/);
    expect(model).not.toMatch(/type: "(promote|reject|merge|batch)"/);
    expect(app).not.toMatch(/type: "(promote|reject|merge|batch)"/);
    expect(app).not.toMatch(/\b(batchPromote|ownerPromote)\b/);
  });

  test("control sequences in captured text are stripped before rendering", () => {
    const hostile = item(
      {},
      {
        title: "Grace \u001b[31mred\u001b[0m",
        currentBody: "quoted \u001b]0;title\u0007 capture\n",
      },
    );
    const start = state([hostile]);
    const frame = render(start, {
      cols: 100,
      rows: 24,
      paint: paint(false),
    });
    const joined = frame.join("\n");
    expect(joined).not.toContain("\u001b");
    expect(joined).not.toContain("\u0007");
    expect(sanitize(hostile.title)).not.toContain("\u001b");
    expect(joined).toContain("kizuki audit");
    expect(joined).not.toContain("kizuki review");
    expect(joined.toLowerCase()).not.toContain("promote");
    expect(joined.toLowerCase()).not.toContain("nothing here is undoable");
    const eventId = hostile.receipt.provenance[0];
    if (eventId === undefined) throw new Error("expected provenance");
    expect(joined).toContain(eventId);
    expect(joined).toContain("authority");
    expect(joined).toContain("connector_evidence");
  });

  test("help and empty-list paths stay on the four effects", () => {
    const empty = press(state([]), chars("uopq?"));
    expect(effectTypes(empty.effects).every((type) => type === "quit" || type === "open")).toBe(
      true,
    );
    const helped = reduce(state([item()]), { name: "char", ch: "?" }, VIEWPORT);
    expect(helped.effects).toEqual([]);
    expect(helped.state.mode.name).toBe("help");
    const closed = reduce(helped.state, { name: "char", ch: "x" }, VIEWPORT);
    expect(closed.state.mode.name).toBe("list");
    const helpFrame = render(helped.state, { cols: 100, rows: 24, paint: paint(false) }).join("\n");
    expect(helpFrame.toLowerCase()).not.toContain("nothing here is undoable");
    expect(helpFrame).toContain("undo the selected write");
    expect(helpFrame).toContain("receipted and undoable");
  });

  test("filter matches metadata only and never scans page bodies", () => {
    const start = state([
      item(
        { page_path: "people/grace.md" },
        { title: "Grace", currentBody: "secret-body-token lives only in the page" },
      ),
    ]);
    const missed = press(start, [...chars("/secret-body-token"), named("enter")]);
    expect(missed.state.items).toHaveLength(0);
    const hit = press(start, [...chars("/grace.md"), named("enter")]);
    expect(hit.state.items).toHaveLength(1);
  });

  test("applyItems cancels confirm when the bound receipt drifts", () => {
    const start = state([item({ after_hash: "a".repeat(64) })]);
    const confirming = press(start, chars("u"));
    expect(confirming.state.mode.name).toBe("confirm");
    const selected = confirming.state.items[0];
    if (selected === undefined) throw new Error("expected a selected receipt");
    const drifted = applyItems(confirming.state, [
      {
        ...selected,
        receipt: { ...selected.receipt, after_hash: "b".repeat(64) },
      },
    ]);
    expect(drifted.mode.name).toBe("list");
    expect(drifted.notice?.text).toContain("selection changed");
    expect(press(drifted, [...chars("yes"), named("enter")]).effects).toEqual([]);
  });

  test("] and [ emit page effects and never claim a silent complete set", () => {
    const paged = initialState({
      vaultName: "vault",
      today: "2026-09-02",
      items: [item()],
      pageOffset: 0,
      pageSize: 200,
      pageTruncated: true,
    });
    expect(press(paged, chars("]")).effects).toEqual([{ type: "page", offset: 200 }]);
    const later = { ...paged, pageOffset: 200, pageTruncated: false };
    expect(press(later, chars("[")).effects).toEqual([{ type: "page", offset: 0 }]);
    const frame = render(paged, { cols: 120, rows: 24, paint: paint(false) }).join("\n");
    expect(frame).toMatch(/\+/);
    expect(frame).not.toContain("5000");
  });

  test("every rendered line is hard-capped to the terminal width", () => {
    const start = state([
      item(
        { page_path: "people/very-long-path-that-should-not-overflow-the-row.md" },
        { title: "x".repeat(400), currentBody: "y".repeat(400) },
      ),
    ]);
    const frame = render(start, { cols: 50, rows: 16, paint: paint(false) });
    expect(frame).toHaveLength(16);
    for (const line of frame) {
      expect(stringWidth(line)).toBe(50);
      expect(line).not.toContain("\x1b");
    }
  });

  test("a loadError blocks undo from the list", () => {
    const start = state([item({}, { loadError: "unreadable page: duplicate id" })]);
    const result = press(start, chars("u"));
    expect(result.effects).toEqual([]);
    expect(result.state.notice?.text).toContain("cannot undo");
  });
});
