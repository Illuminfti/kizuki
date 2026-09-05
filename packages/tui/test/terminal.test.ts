import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import { CSI } from "../src/ansi";
import { createTerminal } from "../src/terminal";
import type { SignalHost } from "../src/terminal";

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  setRawMode(raw: boolean): boolean {
    this.isRaw = raw;
    return raw;
  }
  resume(): this {
    return this;
  }
  pause(): this {
    return this;
  }
}

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns = 80;
  rows = 24;
  writes: string[] = [];
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
}

function signalBus(): SignalHost & {
  emit(event: string, ...args: unknown[]): void;
  count(event: string): number;
} {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on(event, listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off(event, listener) {
      listeners.get(event)?.delete(listener);
    },
    emit(event, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    count(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}

describe("createTerminal", () => {
  test("restores the prior raw-mode state instead of forcing raw off", () => {
    const stdin = new FakeStdin();
    stdin.isRaw = true;
    const stdout = new FakeStdout();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals: null },
    );
    terminal.enter();
    expect(stdin.isRaw).toBe(true);
    terminal.leave();
    expect(stdin.isRaw).toBe(true);

    stdin.isRaw = false;
    terminal.enter();
    expect(stdin.isRaw).toBe(true);
    terminal.leave();
    expect(stdin.isRaw).toBe(false);
  });

  test("leave is idempotent and restores after a signal", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const signals = signalBus();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals },
    );
    terminal.enter();
    expect(signals.count("SIGINT")).toBe(1);
    expect(signals.count("uncaughtException")).toBe(1);
    signals.emit("SIGTERM");
    expect(stdin.isRaw).toBe(false);
    expect(stdout.writes.some((chunk) => chunk.includes(`${CSI}?1049l`))).toBe(true);
    terminal.leave();
    expect(signals.count("SIGTERM")).toBe(0);
  });

  test("a fatal signal restores the TTY and closes the session", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const signals = signalBus();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals },
    );
    const reasons: string[] = [];
    terminal.onClose((reason) => {
      reasons.push(reason);
    });
    terminal.enter();
    signals.emit("SIGTERM");
    expect(stdin.isRaw).toBe(false);
    expect(reasons).toEqual(["SIGTERM"]);
    expect(signals.count("SIGTERM")).toBe(0);
  });

  test("an uncaught exception restores the TTY and closes as a crash", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const signals = signalBus();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals },
    );
    const seen: { reason: string; error: unknown }[] = [];
    terminal.onClose((reason, error) => {
      seen.push({ reason, error });
    });
    terminal.enter();
    const boom = new Error("boom");
    signals.emit("uncaughtException", boom);
    expect(stdin.isRaw).toBe(false);
    expect(seen).toEqual([{ reason: "uncaughtException", error: boom }]);
  });

  test("onClose fires for end, close, and error", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals: null },
    );
    const reasons: string[] = [];
    const stop = terminal.onClose((reason) => {
      reasons.push(reason);
    });
    stdin.emit("end");
    stdin.emit("close");
    stdin.emit("error", new Error("pipe"));
    expect(reasons).toEqual(["end", "close", "error"]);
    stop();
    stdin.emit("end");
    expect(reasons).toEqual(["end", "close", "error"]);
  });

  test("onKeys decodes a split UTF-8 character through the session stream", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals: null },
    );
    const seen: string[] = [];
    terminal.onKeys((keys) => {
      for (const key of keys) {
        if (key.name === "char") seen.push(key.ch);
      }
    });
    const encoded = new TextEncoder().encode("気");
    stdin.emit("data", encoded.slice(0, 1));
    expect(seen).toEqual([]);
    stdin.emit("data", encoded.slice(1));
    expect(seen).toEqual(["気"]);
  });

  test("enables bracketed paste and never turns pasted shortcuts into key events", () => {
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const terminal = createTerminal(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { signals: null },
    );
    const seen: import("../src/keys").Key[] = [];
    terminal.onKeys((keys) => seen.push(...keys));
    terminal.enter();
    stdin.emit("data", "\x1b[200~uq\x1b[201~");
    terminal.leave();
    expect(seen).toEqual([{ name: "paste", text: "uq" }]);
    expect(stdout.writes.join("")).toContain(`${CSI}?2004h`);
    expect(stdout.writes.join("")).toContain(`${CSI}?2004l`);
  });
});
