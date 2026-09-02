import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { reduce } from "../src/model";
import type { Effect } from "../src/model";
import { render } from "../src/view";
import { paint, sanitize } from "../src/ansi";
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
  test("the reducer emits only undo, open, filter, and quit", () => {
    const start = state([
      item({ page_path: "people/grace.md" }),
      item({ page_path: "people/linus.md", writer: "correction" }),
    ]);
    const allowed = new Set(["undo", "open", "filter", "quit"]);
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
    expect(new Set(collected)).toEqual(new Set(["undo", "open", "filter", "quit"]));
  });

  test("u with a typed yes confirmation emits undo for the selected receipt", () => {
    const start = state([item(), item()]);
    const selected = start.items[0];
    if (selected === undefined) throw new Error("expected a selected receipt");
    const result = press(start, [...chars("u"), ...chars("yes"), named("enter")]);
    expect(result.effects).toEqual([{ type: "undo", receiptId: selected.receipt.receipt_id }]);
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
  });

  test("control sequences in captured text are stripped before rendering", () => {
    const hostile = item(
      {},
      {
        title: "Grace \u001b[31mred\u001b[0m",
        currentBody: "quoted \u001b]0;title\u0007 capture\n",
        evidence: ["> \u001b[1minjection\u001b[0m"],
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
  });
});
