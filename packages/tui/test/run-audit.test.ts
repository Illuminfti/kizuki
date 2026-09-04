import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault, openLedger } from "@kizuki/core";
import { loadItems, runAudit } from "../src/app";
import type { CloseReason, Terminal } from "../src/terminal";
import type { Key } from "../src/keys";

const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeTerminal(): {
  terminal: Terminal;
  frames: string[][];
  entered: boolean;
  push(keys: Key[]): void;
  close(): void;
  failDraw(): void;
  fatal(reason: CloseReason, error?: unknown): void;
} {
  let keyHandler: ((keys: Key[]) => void) | null = null;
  let closeHandler: ((reason: CloseReason, error?: unknown) => void) | null = null;
  let explode = false;
  const frames: string[][] = [];
  const api = {
    frames,
    entered: false,
    push(keys: Key[]) {
      keyHandler?.(keys);
    },
    close() {
      closeHandler?.("end");
    },
    failDraw() {
      explode = true;
    },
    fatal(reason: CloseReason, error?: unknown) {
      closeHandler?.(reason, error);
    },
    terminal: {
      isTTY: true,
      size: () => ({ cols: 100, rows: 24 }),
      draw(frame: string[]) {
        if (explode) throw new Error("draw failed");
        frames.push(frame);
      },
      onKeys(handler: (keys: Key[]) => void) {
        keyHandler = handler;
        return () => {
          keyHandler = null;
        };
      },
      onResize() {
        return () => {};
      },
      onClose(handler: (reason: CloseReason, error?: unknown) => void) {
        closeHandler = handler;
        return () => {
          closeHandler = null;
        };
      },
      enter() {
        api.entered = true;
      },
      leave() {
        api.entered = false;
      },
      suspend<T>(fn: () => T): T {
        api.entered = false;
        try {
          return fn();
        } finally {
          api.entered = true;
        }
      },
    } satisfies Terminal,
  };
  return api;
}

describe("runAudit", () => {
  test("resolves and leaves the terminal when stdin closes", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-run-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const fake = fakeTerminal();
    const done = runAudit({ db, vaultPath: vault, terminal: fake.terminal });
    expect(fake.entered).toBe(true);
    fake.close();
    await expect(done).resolves.toEqual({ undone: 0 });
    expect(fake.entered).toBe(false);
    db.close();
  });

  test("a draw exception restores the terminal and rejects", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-draw-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const fake = fakeTerminal();
    const done = runAudit({ db, vaultPath: vault, terminal: fake.terminal });
    fake.failDraw();
    fake.push([{ name: "char", ch: "j" }]);
    await expect(done).rejects.toThrow("draw failed");
    expect(fake.entered).toBe(false);
    db.close();
  });

  test("q quits through the same cleanup path", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-quit-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const fake = fakeTerminal();
    const done = runAudit({ db, vaultPath: vault, terminal: fake.terminal });
    fake.push([{ name: "char", ch: "q" }]);
    await expect(done).resolves.toEqual({ undone: 0 });
    expect(fake.entered).toBe(false);
    db.close();
  });

  test("a fatal signal restores the terminal and resolves the session", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-signal-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const fake = fakeTerminal();
    const done = runAudit({ db, vaultPath: vault, terminal: fake.terminal });
    fake.fatal("SIGTERM");
    await expect(done).resolves.toEqual({ undone: 0 });
    expect(fake.entered).toBe(false);
    db.close();
  });

  test("an uncaught exception restores the terminal and rejects the session", async () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-crash-"));
    temporary.push(vault);
    initVault(vault);
    const db = openLedger(":memory:");
    const fake = fakeTerminal();
    const done = runAudit({ db, vaultPath: vault, terminal: fake.terminal });
    fake.fatal("uncaughtException", new Error("boom"));
    await expect(done).rejects.toThrow("boom");
    expect(fake.entered).toBe(false);
    db.close();
  });
});

describe("vault health", () => {
  test("duplicate live canon pages surface as a persistent health error", () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-dup-"));
    temporary.push(vault);
    initVault(vault);
    mkdirSync(join(vault, "people"), { recursive: true });
    writeFileSync(
      join(vault, "people/one.md"),
      [
        "---",
        "id: person:grace",
        "title: Grace",
        "type: person",
        "status: active",
        "sensitivity: personal",
        "taint: clean",
        "---",
        "One\n",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(vault, "people/two.md"),
      [
        "---",
        "id: person:grace",
        "title: Grace two",
        "type: person",
        "status: active",
        "sensitivity: personal",
        "taint: clean",
        "---",
        "Two\n",
      ].join("\n"),
      "utf8",
    );
    const db = openLedger(":memory:");
    const loaded = loadItems(db, vault);
    expect(loaded.health?.tone).toBe("error");
    expect(loaded.health?.text).toContain("duplicate");
    expect(loaded.health?.text).toContain("kizuki doctor");
    db.close();
  });

  test("an unreadable vault path becomes health text instead of aborting load", () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-unreadable-"));
    temporary.push(vault);
    initVault(vault);
    const blocked = join(vault, "not-a-directory");
    writeFileSync(blocked, "not a vault\n", "utf8");
    const db = openLedger(":memory:");
    const loaded = loadItems(db, blocked);
    expect(loaded.items).toEqual([]);
    expect(loaded.health?.tone).toBe("error");
    expect(loaded.health?.text).toContain("unusable");
    expect(loaded.health?.text).toContain("kizuki doctor");
    db.close();
  });

  test("archive revisions with the same id are not live canon", () => {
    const vault = mkdtempSync(join(tmpdir(), "kizuki-audit-archive-"));
    temporary.push(vault);
    initVault(vault);
    mkdirSync(join(vault, "people"), { recursive: true });
    mkdirSync(join(vault, "archive", "people"), { recursive: true });
    writeFileSync(
      join(vault, "people/grace.md"),
      [
        "---",
        "id: person:grace",
        "title: Grace",
        "type: person",
        "status: active",
        "sensitivity: personal",
        "taint: clean",
        "---",
        "live\n",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(vault, "archive/people/grace.md"),
      "---\nid: person:grace\ntype: person\n---\narchive\n",
      "utf8",
    );
    const db = openLedger(":memory:");
    const loaded = loadItems(db, vault);
    expect(loaded.health).toBeNull();
    db.close();
  });
});
