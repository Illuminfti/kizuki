import { CSI } from "./ansi";
import { parseKeys } from "./keys";
import type { Key } from "./keys";

export interface Terminal {
  readonly isTTY: boolean;
  size(): { cols: number; rows: number };
  /** Paints one full frame; the frame must be exactly `rows` lines. */
  draw(frame: string[]): void;
  onKeys(handler: (keys: Key[]) => void): () => void;
  onResize(handler: () => void): () => void;
  enter(): void;
  leave(): void;
  /** Leaves the screen, runs `fn` (an editor, typically), then re-enters. */
  suspend<T>(fn: () => T): T;
}

type RawInput = NodeJS.ReadStream & { setRawMode?: (raw: boolean) => unknown };

const ENTER = `${CSI}?1049h${CSI}?25l${CSI}2J${CSI}H`;
const LEAVE = `${CSI}?25h${CSI}?1049l`;
const SYNC_START = `${CSI}?2026h`;
const SYNC_END = `${CSI}?2026l`;

export function createTerminal(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
): Terminal {
  const input = stdin as RawInput;
  const isTTY = Boolean(
    stdin.isTTY && stdout.isTTY && typeof input.setRawMode === "function",
  );
  let entered = false;

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
      const listener = (chunk: Uint8Array | string): void =>
        handler(parseKeys(chunk));
      stdin.on("data", listener);
      return () => {
        stdin.off("data", listener);
      };
    },
    onResize(handler) {
      stdout.on("resize", handler);
      return () => {
        stdout.off("resize", handler);
      };
    },
    enter() {
      if (entered) return;
      entered = true;
      input.setRawMode?.(true);
      stdin.resume();
      stdout.write(ENTER);
    },
    leave() {
      if (!entered) return;
      entered = false;
      stdout.write(LEAVE);
      input.setRawMode?.(false);
      stdin.pause();
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
