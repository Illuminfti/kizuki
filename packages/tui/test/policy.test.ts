import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve(import.meta.dir, "../src");

function sources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(SRC)) {
    if (!name.endsWith(".ts")) continue;
    out.set(name, readFileSync(resolve(SRC, name), "utf8"));
  }
  return out;
}

describe("packages/tui/AGENTS.md is executable", () => {
  test("source contains no accept/reject/promote/merge/batch write path", () => {
    const files = sources();
    expect(files.size).toBeGreaterThan(0);
    const banned =
      /\b(ownerPromote|writePage|applyCanonWrite|applyRevertWrite|batch-confirm|batchPromote|promoteProposal|rejectProposal)\b|type: "(promote|reject|merge|batch)"/;
    for (const [name, text] of files) {
      expect({ name, hit: text.match(banned) }).toEqual({ name, hit: null });
    }
  });

  test("the reducer effect union is undo, open, filter, page, and quit", () => {
    const model = sources().get("model.ts") ?? "";
    expect(model).toContain('type: "undo"');
    expect(model).toContain("afterHash");
    expect(model).toContain("pagePath");
    expect(model).toContain('type: "open"');
    expect(model).toContain('type: "filter"');
    expect(model).toContain('type: "page"');
    expect(model).toContain('type: "quit"');
    expect(model).toContain("The only write effect");
    expect(model).toContain("core receipt reverser");
  });

  test("app.ts undoes only through undoReceipt and binds the displayed hash", () => {
    const app = sources().get("app.ts") ?? "";
    expect(app).toContain("undoReceipt");
    expect(app).toContain("effect.afterHash");
    expect(app).toContain("page hash no longer matches the screen");
    expect(app).not.toContain("writePage");
    expect(app).toContain("listCanonPagesReport");
    expect(app).toContain("PAGE_SIZE + 1");
  });

  test("terminal restores prior raw mode and guards fatal events", () => {
    const terminal = sources().get("terminal.ts") ?? "";
    expect(terminal).toContain("priorRaw");
    expect(terminal).toContain("isRaw");
    expect(terminal).toContain("SIGINT");
    expect(terminal).toContain("SIGTERM");
    expect(terminal).toContain("uncaughtException");
    expect(terminal).toContain("onClose");
    expect(terminal).toContain("closeHandler");
    expect(terminal).not.toMatch(/setRawMode\?\.\(false\)/);
  });

  test("captured text is sanitized before styling and lines are hard-capped", () => {
    const ansi = sources().get("ansi.ts") ?? "";
    expect(ansi).toContain("STRING_SEQ_PATTERN");
    expect(ansi).toContain("truncate(stripAnsi(text), width, \"\")");
    const view = sources().get("view.ts") ?? "";
    expect(view).toContain("sanitize(");
    expect(view).toContain("boundedDiff");
    expect(view.toLowerCase()).not.toContain("nothing here is undoable");
  });
});
