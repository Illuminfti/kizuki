import { beforeEach, describe, expect, test } from "bun:test";
import {
  applyItems,
  batchEligible,
  currentItem,
  cursorRow,
  resumeAfterEdit,
} from "../src/model";
import {
  VIEWPORT,
  chars,
  item,
  named,
  press,
  resetCounter,
  state,
} from "./helpers";

beforeEach(resetCounter);

describe("arrangement", () => {
  test("groups by kind with canon-changing kinds first and headers counted in rows", () => {
    const s = state([
      item({ kind: "entity", target: "person:ada" }),
      item({ kind: "purge_review", target: "page-1" }),
      item({ kind: "claim" }),
      item({ kind: "edit", target: "page-2" }),
    ]);
    expect(s.groups.map((g) => [g.kind, g.count])).toEqual([
      ["purge_review", 1],
      ["edit", 1],
      ["claim", 1],
      ["entity", 1],
    ]);
    expect(s.items.map((i) => i.proposal.kind)).toEqual([
      "purge_review",
      "edit",
      "claim",
      "entity",
    ]);
    expect(cursorRow(s)).toBe(1);
    expect(cursorRow({ ...s, cursor: 3 })).toBe(7);
  });

  test("within a kind, items sort by subject then creation time", () => {
    const s = state([
      item({ kind: "entity", subjects: ["person:zed"], target: "person:zed" }),
      item({ kind: "entity", subjects: ["person:ada"], target: "person:ada" }),
    ]);
    expect(s.items.map((i) => i.subject)).toEqual(["person:ada", "person:zed"]);
  });
});

describe("navigation", () => {
  test("j/k move and clamp; g/G jump", () => {
    const s = state([item(), item(), item()]);
    expect(press(s, chars("jj")).state.cursor).toBe(2);
    expect(press(s, chars("jjjj")).state.cursor).toBe(2);
    expect(press(s, chars("k")).state.cursor).toBe(0);
    expect(press(s, chars("G")).state.cursor).toBe(2);
    expect(press(s, chars("Gg")).state.cursor).toBe(0);
    expect(
      press(s, [named("down"), named("down"), named("up")]).state.cursor,
    ).toBe(1);
  });

  test("the list scrolls so the cursor stays visible", () => {
    const s = state(Array.from({ length: 30 }, () => item()));
    const viewport = { listRows: 5, detailRows: 5 };
    const down = press(s, chars("j".repeat(12)), viewport).state;
    const row = cursorRow(down);
    expect(row).toBeGreaterThanOrEqual(down.listScroll);
    expect(row).toBeLessThan(down.listScroll + 5);
    const back = press(down, chars("g"), viewport).state;
    expect(back.listScroll).toBe(0);
  });

  test("tab moves focus to the detail pane where j/k scroll instead of moving", () => {
    const s = state([item(), item()]);
    const r = press(s, [named("tab"), ...chars("jjk")]).state;
    expect(r.focus).toBe("detail");
    expect(r.cursor).toBe(0);
    expect(r.detailScroll).toBe(1);
  });

  test("moving the cursor resets the detail scroll", () => {
    const s = state([item(), item()]);
    const r = press(s, [
      named("tab"),
      ...chars("jj"),
      named("tab"),
      ...chars("j"),
    ]).state;
    expect(r.detailScroll).toBe(0);
    expect(r.cursor).toBe(1);
  });
});

describe("promote", () => {
  test("p asks for a label; a digit chooses it and emits the promote effect", () => {
    const s = state([item(), item()]);
    const asked = press(s, chars("p")).state;
    expect(asked.mode).toMatchObject({
      name: "sensitivity",
      action: "promote",
      keep: null,
    });
    const { state: after, effects } = press(asked, chars("2"));
    expect(after.mode).toEqual({ name: "list" });
    expect(effects).toEqual([
      {
        type: "promote",
        id: s.items[0]?.proposal.proposal_id ?? "",
        sensitivity: "personal",
        editBody: null,
      },
    ]);
  });

  test("enter keeps the existing label for kinds that rewrite a page, and does nothing for new pages", () => {
    const edit = item(
      { kind: "edit", target: "page-1" },
      {
        targetPath: "facts/page-1.md",
        currentBody: "old",
        currentLabel: "private",
      },
    );
    const s = state([edit, item()]);
    const kept = press(s, [...chars("p"), named("enter")]);
    expect(kept.effects).toEqual([
      {
        type: "promote",
        id: edit.proposal.proposal_id,
        sensitivity: "private",
        editBody: null,
      },
    ]);
    const fresh = press(s, [...chars("jp"), named("enter")]);
    expect(fresh.effects).toEqual([]);
    expect(fresh.state.mode.name).toBe("sensitivity");
  });

  test("escape cancels the label prompt", () => {
    const s = state([item()]);
    const r = press(s, [...chars("p"), named("escape")]);
    expect(r.state.mode).toEqual({ name: "list" });
    expect(r.effects).toEqual([]);
  });

  test("an empty queue explains itself instead of prompting", () => {
    const r = press(state([]), chars("p"));
    expect(r.state.mode).toEqual({ name: "list" });
    expect(r.state.notice?.tone).toBe("warn");
  });

  test("e emits the edit effect and the edited body flows into the label prompt", () => {
    const s = state([item()]);
    const id = s.items[0]?.proposal.proposal_id ?? "";
    const r = press(s, chars("e"));
    expect(r.effects).toEqual([{ type: "edit", id }]);
    const resumed = resumeAfterEdit(r.state, id, "edited body");
    const done = press(resumed, chars("3"));
    expect(done.effects).toEqual([
      { type: "promote", id, sensitivity: "private", editBody: "edited body" },
    ]);
  });
});

describe("merge", () => {
  test("m needs an existing page", () => {
    const r = press(state([item()]), chars("m"));
    expect(r.effects).toEqual([]);
    expect(r.state.notice?.text).toContain("no existing page");
  });

  test("m on a proposal whose target exists asks for a label then merges", () => {
    const existing = item(
      { kind: "claim", target: "notes:today" },
      {
        targetPath: "notes/today.md",
        currentBody: "old",
        currentLabel: "personal",
      },
    );
    const r = press(state([existing]), [...chars("m"), named("enter")]);
    expect(r.effects).toEqual([
      {
        type: "merge",
        id: existing.proposal.proposal_id,
        sensitivity: "personal",
      },
    ]);
  });
});

describe("reject", () => {
  test("requires a typed reason", () => {
    const s = state([item()]);
    const id = s.items[0]?.proposal.proposal_id ?? "";
    const empty = press(s, [...chars("r"), named("enter")]);
    expect(empty.effects).toEqual([]);
    expect(empty.state.mode.name).toBe("reason");
    const typed = press(s, [...chars("rnot canon"), named("enter")]);
    expect(typed.effects).toEqual([
      { type: "reject", id, reason: "not canon" },
    ]);
    expect(typed.state.mode).toEqual({ name: "list" });
  });

  test("backspace edits the reason and escape abandons it", () => {
    const s = state([item()]);
    const r = press(s, [...chars("rab"), named("backspace")]);
    expect(r.state.mode).toMatchObject({ name: "reason", text: "a" });
    expect(press(r.state, [named("escape")]).state.mode).toEqual({
      name: "list",
    });
  });
});

describe("batch", () => {
  test("is refused when the flag is off", () => {
    const r = press(state([item()]), chars("a"));
    expect(r.state.notice?.text).toContain("--batch");
    expect(r.effects).toEqual([]);
  });

  test("only deterministic new-page proposals are eligible", () => {
    const s = state(
      [
        item({ kind: "entity", target: "person:ada" }),
        item({ kind: "claim", producer: "llm" }),
        item(
          { kind: "edit", target: "p" },
          { targetPath: "p.md", currentBody: "x", currentLabel: "public" },
        ),
        item({ kind: "claim" }),
      ],
      true,
    );
    expect(batchEligible(s).map((i) => i.proposal.kind)).toEqual([
      "claim",
      "entity",
    ]);
  });

  test("needs the flag, a label, and a typed yes", () => {
    const s = state([item(), item({ producer: "llm" })], true);
    const eligible = batchEligible(s).map((i) => i.proposal.proposal_id);
    const wrong = press(s, [...chars("a1no"), named("enter")]);
    expect(wrong.effects).toEqual([]);
    expect(wrong.state.mode.name).toBe("batch-confirm");
    expect(wrong.state.notice?.text).toContain("yes");
    const right = press(s, [...chars("a1yes"), named("enter")]);
    expect(right.effects).toEqual([
      { type: "batch", ids: eligible, sensitivity: "public" },
    ]);
    expect(right.state.mode).toEqual({ name: "list" });
  });
});

describe("filter, help, quit", () => {
  test("filter narrows the queue and escape clears it", () => {
    const s = state([
      item({ frontmatter: { type: "source", title: "Kettle on" } }),
      item({ frontmatter: { type: "source", title: "Rain" } }),
    ]);
    const narrowed = press(s, [...chars("/kettle"), named("enter")]).state;
    expect(narrowed.items).toHaveLength(1);
    expect(narrowed.filter).toBe("kettle");
    const cleared = press(narrowed, [...chars("/"), named("escape")]).state;
    expect(cleared.items).toHaveLength(2);
    expect(cleared.filter).toBe("");
  });

  test("? opens help and any key closes it; q and ctrl-c quit", () => {
    const s = state([item()]);
    const help = press(s, chars("?")).state;
    expect(help.mode).toEqual({ name: "help" });
    expect(press(help, chars("x")).state.mode).toEqual({ name: "list" });
    expect(press(s, chars("q")).effects).toEqual([{ type: "quit" }]);
    expect(press(s, [named("ctrl-c")]).effects).toEqual([{ type: "quit" }]);
  });
});

describe("applyItems", () => {
  test("keeps the cursor on the same proposal when the list changes", () => {
    const a = item();
    const b = item();
    const c = item();
    const s = press(state([a, b, c]), chars("j")).state;
    const next = applyItems(s, [c, b]);
    expect(currentItem(next)?.proposal.proposal_id).toBe(
      b.proposal.proposal_id,
    );
  });

  test("falls to the next item when the current one is gone", () => {
    const a = item();
    const b = item();
    const c = item();
    const s = press(state([a, b, c]), chars("j")).state;
    const next = applyItems(s, [a, c]);
    expect(next.cursor).toBe(1);
    expect(currentItem(next)?.proposal.proposal_id).toBe(
      c.proposal.proposal_id,
    );
    expect(applyItems(next, []).cursor).toBe(0);
  });

  test("keeps the active filter", () => {
    const s = press(
      state([
        item({ frontmatter: { type: "source", title: "Kettle" } }),
        item(),
      ]),
      [...chars("/kettle"), named("enter")],
    ).state;
    const next = applyItems(s, [
      item({ frontmatter: { type: "source", title: "Kettle again" } }),
      item(),
    ]);
    expect(next.items).toHaveLength(1);
  });
});

test("viewport constant is sane for the helpers", () => {
  expect(VIEWPORT.listRows).toBeGreaterThan(0);
});
