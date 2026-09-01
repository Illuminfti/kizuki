import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accept, initVault, openLedger } from "@kizuki/core";
import type { CaptureEventInput } from "@kizuki/core";
import {
  fileProposal,
  initStaging,
  listProposals,
  proposalsForEvent,
} from "@kizuki/core/staging";
import { stripAnsi } from "../src/ansi";
import { editInEditor, loadItems, pickEditor, runReview } from "../src/app";
import { parseKeys } from "../src/keys";
import type { Key } from "../src/keys";
import type { Terminal } from "../src/terminal";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function fakeEditor(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-editor-"));
  temporary.push(dir);
  const file = join(dir, "editor.sh");
  writeFileSync(file, `#!/bin/sh\n${script}\n`, "utf8");
  chmodSync(file, 0o755);
  return file;
}

function fixtureEvent(text: string, record: string): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: record,
    kind: "message",
    occurred_at: "2026-09-01T09:00:00.000Z",
    observed_at: "2026-09-01T09:00:00.000Z",
    text,
    subjects: [{ subject_id: "person:ada", role: "from", display_name: "Ada" }],
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

function vaultWithQueue(): { db: Database; vault: string } {
  const root = mkdtempSync(join(tmpdir(), "kizuki-tui-"));
  temporary.push(root);
  const vault = join(root, "vault");
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  initStaging(db);
  for (const [text, record] of [
    ["the kettle is on", "rec-1"],
    ["rain on the roof", "rec-2"],
  ] as const) {
    const result = accept(db, fixtureEvent(text, record));
    if (result.status !== "stored")
      throw new Error(`fixture not stored: ${JSON.stringify(result)}`);
    for (const input of proposalsForEvent(result.event))
      fileProposal(db, input);
  }
  return { db, vault };
}

class FakeTerminal implements Terminal {
  readonly isTTY: boolean;
  frames: string[][] = [];
  entered = 0;
  left = 0;
  private keyHandler: ((keys: Key[]) => void) | null = null;

  constructor(isTTY = true) {
    this.isTTY = isTTY;
  }

  size(): { cols: number; rows: number } {
    return { cols: 120, rows: 36 };
  }

  draw(frame: string[]): void {
    this.frames.push(frame);
  }

  onKeys(handler: (keys: Key[]) => void): () => void {
    this.keyHandler = handler;
    return () => {
      this.keyHandler = null;
    };
  }

  onResize(): () => void {
    return () => {};
  }

  enter(): void {
    this.entered += 1;
  }

  leave(): void {
    this.left += 1;
  }

  suspend<T>(fn: () => T): T {
    this.leave();
    try {
      return fn();
    } finally {
      this.enter();
    }
  }

  type(text: string): void {
    this.keyHandler?.(parseKeys(text));
  }
}

describe("runReview", () => {
  test("refuses to run without a terminal", async () => {
    const { db, vault } = vaultWithQueue();
    await expect(
      runReview({ db, vaultPath: vault, terminal: new FakeTerminal(false) }),
    ).rejects.toThrow("--list");
    db.close();
  });

  test("promotes, rejects and quits through the key protocol, writing canon and receipts", async () => {
    const { db, vault } = vaultWithQueue();
    const terminal = new FakeTerminal();
    const done = runReview({
      db,
      vaultPath: vault,
      terminal,
      env: { NO_COLOR: "1" },
    });
    const before = listProposals(db, { status: "pending" });
    expect(before).toHaveLength(3);

    terminal.type("p2");
    terminal.type("r");
    terminal.type("not canon\r");
    terminal.type("q");
    const summary = await done;

    expect(summary).toEqual({ promoted: 1, rejected: 1 });
    expect(terminal.entered).toBe(1);
    expect(terminal.left).toBe(1);
    expect(listProposals(db, { status: "pending" })).toHaveLength(1);
    expect(listProposals(db, { status: "promoted" })).toHaveLength(1);
    expect(listProposals(db, { status: "rejected" })).toHaveLength(1);
    expect(
      existsSync(join(vault, ".kizuki", "receipts", "promotions.jsonl")),
    ).toBe(true);
    const frames = terminal.frames.map((f) => f.map(stripAnsi).join("\n"));
    expect(frames.some((f) => f.includes("promoted → "))).toBe(true);
    expect(frames.at(-1)).toContain("rejected (not canon)");
    db.close();
  });

  test("edit opens the editor and the saved body is what gets promoted", async () => {
    const { db, vault } = vaultWithQueue();
    const terminal = new FakeTerminal();
    const done = runReview({
      db,
      vaultPath: vault,
      terminal,
      editor: fakeEditor('printf "edited by owner" > "$1"'),
      env: { NO_COLOR: "1" },
    });
    terminal.type("e");
    terminal.type("3");
    terminal.type("q");
    await done;
    const promoted = listProposals(db, { status: "promoted" });
    expect(promoted).toHaveLength(1);
    const receipts = readFileSync(
      join(vault, ".kizuki", "receipts", "promotions.jsonl"),
      "utf8",
    );
    const pagePath = JSON.parse(receipts.trim().split("\n")[0] ?? "{}")
      .page_path as string;
    const page = readFileSync(join(vault, pagePath), "utf8");
    expect(page).toContain("edited by owner");
    expect(page).toContain('sensitivity: "private"');
    expect(terminal.entered).toBe(2);
    db.close();
  });

  test("batch promotion needs the flag and the typed confirmation", async () => {
    const { db, vault } = vaultWithQueue();
    const terminal = new FakeTerminal();
    const done = runReview({
      db,
      vaultPath: vault,
      terminal,
      batch: true,
      env: { NO_COLOR: "1" },
    });
    terminal.type("a1yes\r");
    terminal.type("q");
    const summary = await done;
    expect(summary.promoted).toBe(3);
    expect(listProposals(db, { status: "pending" })).toHaveLength(0);
    db.close();
  });
});

describe("loadItems", () => {
  test("resolves existing target pages so edits can show a diff", () => {
    const { db, vault } = vaultWithQueue();
    const items = loadItems(db, vault);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.targetPath === null)).toBe(true);
    db.close();
  });
});

describe("editor", () => {
  test("pickEditor prefers VISUAL, then EDITOR, then a known binary", () => {
    expect(pickEditor({ VISUAL: "code -w", EDITOR: "vim" })).toBe("code -w");
    expect(pickEditor({ EDITOR: "nano" })).toBe("nano");
    const fallback = pickEditor({});
    expect(fallback === null || ["vim", "nano", "vi"].includes(fallback)).toBe(
      true,
    );
  });

  test("editInEditor returns the saved file and cleans up", () => {
    const result = editInEditor(
      fakeEditor('printf "changed" > "$1"'),
      "original",
      "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    );
    expect(result).toBe("changed");
  });

  test("a failing editor is reported, not swallowed", () => {
    expect(() => editInEditor(fakeEditor("exit 3"), "x", "id")).toThrow(
      "exited with 3",
    );
  });
});
