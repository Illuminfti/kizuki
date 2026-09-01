import { beforeEach, describe, expect, test } from "bun:test";
import { paint, stringWidth, stripAnsi } from "../src/ansi";
import { layout, render, viewportFor } from "../src/view";
import { chars, item, named, press, resetCounter, state } from "./helpers";

beforeEach(resetCounter);

const plain = paint(false);
const color = paint(true);

function frame(
  s: ReturnType<typeof state>,
  cols: number,
  rows: number,
  p = plain,
): string[] {
  return render(s, { cols, rows, paint: p });
}

function widthsOk(lines: string[], cols: number, rows: number): void {
  expect(lines).toHaveLength(rows);
  for (const line of lines) expect(stringWidth(line)).toBe(cols);
}

describe("geometry", () => {
  test("every frame is exactly rows × cols at wide, narrow and tiny sizes", () => {
    const s = state([item(), item({ kind: "entity", target: "person:ada" })]);
    widthsOk(frame(s, 120, 30), 120, 30);
    widthsOk(frame(s, 80, 24), 80, 24);
    widthsOk(frame(s, 40, 8), 40, 8);
    widthsOk(frame(s, 200, 50, color).map(stripAnsi), 200, 50);
  });

  test("too-small terminals get a single explanation line", () => {
    const lines = frame(state([item()]), 30, 5);
    expect(lines[0]).toContain("needs at least");
    widthsOk(lines, 30, 5);
  });

  test("layout splits panes only on wide terminals", () => {
    expect(layout(80, 24).split).toBe(false);
    expect(layout(120, 30)).toMatchObject({
      split: true,
      listWidth: 50,
      detailWidth: 69,
      bodyRows: 26,
    });
    expect(viewportFor(120, 30)).toEqual({ listRows: 26, detailRows: 26 });
  });
});

describe("content", () => {
  test("header carries the vault, date, pending count and kind counts", () => {
    const s = state([item(), item({ kind: "entity", target: "person:ada" })]);
    const header = frame(s, 120, 30)[0] ?? "";
    expect(header).toContain("kizuki review");
    expect(header).toContain("vault");
    expect(header).toContain("2026-09-01");
    expect(header).toContain("2 pending");
    expect(header).toContain("1 capture, 1 entity");
  });

  test("the list shows group headers, badges and a cursor marker; the detail shows the title", () => {
    const s = state([
      item({ frontmatter: { type: "source", title: "Kettle on" } }),
      item({
        kind: "entity",
        target: "person:ada",
        frontmatter: { type: "person", title: "Ada" },
      }),
    ]);
    const lines = frame(s, 120, 30);
    const body = lines.slice(2, -2).join("\n");
    expect(body).toContain("CAPTURE · 1");
    expect(body).toContain("ENTITY · 1");
    expect(body).toContain("▸ CAP Kettle on");
    expect(body).toContain("  ENT Ada");
    expect(body).toContain("new page captures/");
    const moved = press(s, chars("j")).state;
    expect(frame(moved, 120, 30).slice(2, -2).join("\n")).toContain(
      "▸ ENT Ada",
    );
  });

  test("the cursor row is drawn inverse when colors are on", () => {
    const lines = frame(state([item()]), 120, 30, color);
    expect(
      lines
        .slice(2, -2)
        .some((l) => l.includes("\x1b[7m") && stripAnsi(l).includes("▸")),
    ).toBe(true);
  });

  test("edit proposals render as a diff against the current page", () => {
    const edit = item(
      { kind: "edit", target: "page-1", body: "new line" },
      {
        targetPath: "facts/page-1.md",
        currentBody: "old line",
        currentLabel: "personal",
      },
    );
    const detail = frame(state([edit]), 120, 30)
      .slice(2, -2)
      .join("\n");
    expect(detail).toContain("- old line");
    expect(detail).toContain("+ new line");
    expect(detail).toContain("page facts/page-1.md");
    expect(detail).toContain("sensitivity personal");
  });

  test("deletion shows what will be archived", () => {
    const del = item(
      { kind: "deletion", target: "page-1" },
      {
        targetPath: "facts/page-1.md",
        currentBody: "doomed",
        currentLabel: "public",
      },
    );
    const detail = frame(state([del]), 120, 30)
      .slice(2, -2)
      .join("\n");
    expect(detail).toContain("page will be archived");
    expect(detail).toContain("doomed");
  });

  test("captured text cannot inject escape sequences into the frame", () => {
    const hostile = item({
      body: "hello\x1b[2J\x1b]0;pwned\x07 world",
      frontmatter: { type: "source", title: "x\x1b[31m" },
    });
    const lines = frame(state([hostile]), 120, 30, color);
    for (const line of lines) {
      expect(line).not.toContain("\x1b[2J");
      expect(line).not.toContain("pwned");
    }
  });

  test("narrow terminals show one pane and name it on the rule", () => {
    const s = state([item()]);
    const list = frame(s, 80, 24);
    expect(list[1]).toContain("list");
    expect(list.slice(2, -2).join("\n")).toContain("▸ CAP");
    const detail = frame(press(s, [named("tab")]).state, 80, 24);
    expect(detail[1]).toContain("detail");
    expect(detail.slice(2, -2).join("\n")).toContain("new page captures/");
  });
});

describe("footer and notice", () => {
  test("each mode explains its keys", () => {
    const s = state([item()], true);
    const last = (lines: string[]): string => lines[lines.length - 1] ?? "";
    expect(last(frame(s, 120, 30))).toContain("a batch(1)");
    expect(last(frame(press(s, chars("p")).state, 120, 30))).toContain(
      "1 public  2 personal  3 private",
    );
    expect(last(frame(press(s, chars("r")).state, 120, 30))).toContain(
      "reject reason:",
    );
    expect(last(frame(press(s, chars("/ab")).state, 120, 30))).toContain(
      "filter: ab",
    );
    expect(last(frame(press(s, chars("a2")).state, 120, 30))).toContain(
      "type yes",
    );
    expect(last(frame(press(s, chars("?")).state, 120, 30))).toContain(
      "closes help",
    );
  });

  test("help replaces the detail pane", () => {
    const lines = frame(press(state([item()]), chars("?")).state, 120, 30);
    expect(lines.slice(2, -2).join("\n")).toContain("edit in $EDITOR");
  });

  test("the notice line shows the last outcome", () => {
    const s = {
      ...state([item()]),
      notice: {
        text: "promoted → captures/x.md (personal)",
        tone: "ok" as const,
      },
    };
    const lines = frame(s, 120, 30);
    expect(lines[lines.length - 2]).toContain("promoted → captures/x.md");
  });

  test("an empty queue says so", () => {
    expect(frame(state([]), 120, 30).slice(2, -2).join("\n")).toContain(
      "queue is empty",
    );
  });
});
