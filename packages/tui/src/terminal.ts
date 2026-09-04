import { CSI } from "./ansi";
import { createKeyStream } from "./keys";
import type { Key } from "./keys";

export interface Terminal {
  readonly isTTY: boolean;
  size(): { cols: number; rows: number };
  /** Paints one full frame; the frame must be exactly `rows` lines. */
  draw(frame: string[]): void;
  onKeys(handler: (keys: Key[]) => void): () => void;
  onResize(handler: () => void): () => void;
  /** stdin ended, closed, or errored — same cleanup path as quit. */
  onClose(handler: (reason: "end" | "close" | "error") => void): () => void;
  enter(): void;
  leave(): void;
  /** Leaves the screen, runs `fn` (an editor, typically), then re-enters. */
  suspend<T>(fn: () => T): T;
}

export interface SignalHost {
  on(event: string, listener: (...args: unknown[]) => void): void;
  off(event: string, listener: (...args: unknown[]) => void): void;
}

export interface TerminalOptions {
  /** Defaults to `process`. Pass `null` to skip process-wide guards (tests). */
  signals?: SignalHost | null;
}

type RawInput = NodeJS.ReadStream & {
  setRawMode?: (raw: boolean) => unknown;
  isRaw?: boolean;
};

const ENTER = `${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H`;
const LEAVE = `${CSI}?25h${CSI}?1049l`;
const SYNC_START = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

const FATAL_EVENTS = [
  "SIGINT",
  "SIGTERM",
  "SIGHUP",
  "uncaughtException",
  "unhandledRejection",
] as const;

export function createTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  opts: TerminalOptions = {},
): Terminal {
  const input = stdin as RawInput;
  const isTTY = Boolean(
    stdin.isTTY && stdout.isTTY && typeof input.setRawMode === "function",
  );
  let entered = false;
  let priorRaw: boolean | null = null;
  const signalHost: SignalHost | null =
    opts.signals === undefined ? (process as unknown as SignalHost) : opts.signals;
  let uninstallSignals: (() => void) | null = null;

  const restore = (): void => {
    if (!entered) return;
    entered = false;
    try {
      stdout.write(LEAVE);
    } catch {
      // The stream may already be gone; still restore raw mode.
    }
    if (typeof input.setRawMode === "function" && priorRaw !== null) {
      try {
        input.setRawMode(priorRaw);
      } catch {
        // Capability disappeared after entry; the prior state is lost.
      }
    }
    priorRaw = null;
    try {
      stdin.pause();
    } catch {
      // ignore
    }
    uninstallSignals?.();
    uninstallSignals = null;
  };

  const installSignals = (): void => {
    if (signalHost === null) return;
    const host = signalHost;
    const handler = (): void => {
      restore();
    };
    for (const event of FATAL_EVENTS) host.on(event, handler);
    uninstallSignals = () => {
      for (const event of FATAL_EVENTS) host.off(event, handler);
    };
  };

  return {
    isTTY,
    size() {
      const cols = stdout.columns > 0 ? stdout.columns : 80;
      const rows = stdout.rows > 0 ? stdout.rows : 24;
      return { cols, rows };
    },
    draw(frame) {
      const body = frame.map((line) => `${line}${CSI}K`).join("\r\n");
      stdout.write(`${SYNC_START}${CSI}H${body}${SYNC_END}`);
    },
    onKeys(handler) {
      const stream = createKeyStream();
      const listener = (chunk: Uint8Array | string): void => {
        const keys = stream.push(chunk);
        if (keys.length > 0) handler(keys);
      };
      stdin.on("data", listener);
      return () => {
        stdin.off("data", listener);
        stream.end();
      };
    },
    onResize(handler) {
      stdout.on("resize", handler);
      return () => {
        stdout.off("resize", handler);
      };
    },
    onClose(handler) {
      const onEnd = (): void => handler("end");
      const onClosed = (): void => handler("close");
      const onError = (): void => handler("error");
      stdin.on("end", onEnd);
      stdin.on("close", onClosed);
      stdin.on("error", onError);
      return () => {
        stdin.off("end", onEnd);
        stdin.off("close", onClosed);
        stdin.off("error", onError);
      };
    },
    enter() {
      if (entered) return;
      entered = true;
      priorRaw = typeof input.isRaw === "boolean" ? input.isRaw : false;
      input.setRawMode?.(true);
      stdin.resume();
      stdout.write(ENTER);
      installSignals();
    },
    leave() {
      restore();
    },
    suspend(fn) {
      this.leave();
      try {
        return fn();
      } finally {
        this.enter();
      }
    },
  };
}
