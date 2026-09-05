export type KeyName =
  | "enter"
  | "escape"
  | "backspace"
  | "tab"
  | "up"
  | "down"
  | "left"
  | "right"
  | "pageup"
  | "pagedown"
  | "home"
  | "end"
  | "ctrl-c"
  | "ctrl-d"
  | "ctrl-l"
  | "unknown";

export type Key =
  | { name: "char"; ch: string }
  | { name: "paste"; text: string }
  | { name: KeyName };

const SEQUENCES: Record<string, KeyName> = {
  "[A": "up", "[B": "down", "[C": "right", "[D": "left",
  "[H": "home", "[F": "end", "[1~": "home", "[4~": "end",
  "[5~": "pageup", "[6~": "pagedown", OA: "up", OB: "down",
  OC: "right", OD: "left", OH: "home", OF: "end",
};
const ESC = "\x1b";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_SEQUENCE_CHARS = 128;

function keyFor(ch: string): Key {
  const cp = ch.codePointAt(0) ?? 0;
  if (ch === "\r" || ch === "\n") return { name: "enter" };
  if (cp === 0x7f || cp === 0x08) return { name: "backspace" };
  if (ch === "\t") return { name: "tab" };
  if (cp === 0x03) return { name: "ctrl-c" };
  if (cp === 0x04) return { name: "ctrl-d" };
  if (cp === 0x0c) return { name: "ctrl-l" };
  return cp < 0x20 ? { name: "unknown" } : { name: "char", ch };
}

function suffixPrefixLength(text: string, marker: string): number {
  for (let length = Math.min(text.length, marker.length - 1); length > 0; length -= 1) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function consumeEscape(text: string): { key: Key | null; length: number; pending: boolean } {
  if (text === ESC) return { key: null, length: 0, pending: true };
  if (text.startsWith(PASTE_START)) return { key: null, length: PASTE_START.length, pending: false };
  if (PASTE_START.startsWith(text)) return { key: null, length: 0, pending: true };
  for (const [sequence, name] of Object.entries(SEQUENCES)) {
    const full = `${ESC}${sequence}`;
    if (text.startsWith(full)) return { key: { name }, length: full.length, pending: false };
    if (full.startsWith(text)) return { key: null, length: 0, pending: true };
  }
  if (text.startsWith(`${ESC}[`) || text.startsWith(`${ESC}O`)) {
    for (let index = 2; index < text.length; index += 1) {
      const cp = text.codePointAt(index) ?? 0;
      if (cp >= 0x40 && cp <= 0x7e) return { key: { name: "unknown" }, length: index + 1, pending: false };
    }
    return { key: null, length: 0, pending: true };
  }
  if (/^\x1b[\]PX^_]/.test(text)) {
    for (let index = 2; index < text.length; index += 1) {
      if (text[index] === "\x07") return { key: { name: "unknown" }, length: index + 1, pending: false };
      if (text[index] === ESC && text[index + 1] === "\\") {
        return { key: { name: "unknown" }, length: index + 2, pending: false };
      }
    }
    return { key: null, length: 0, pending: true };
  }
  const next = [...text.slice(ESC.length)][0];
  return { key: { name: "unknown" }, length: ESC.length + (next?.length ?? 0), pending: false };
}

/**
 * Stateful terminal decoder. Lone ESC is delayed until flush; split CSI/SS3
 * and bracketed-paste sequences cannot turn their later bytes into shortcuts.
 */
export function createKeyStream(): {
  push(chunk: Uint8Array | string): Key[];
  flush(): Key[];
  end(): Key[];
  needsFlush(): boolean;
} {
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let pending = "";
  let pasting = false;
  let pasted = "";

  const drain = (): Key[] => {
    const keys: Key[] = [];
    while (pending.length > 0) {
      if (pasting) {
        const end = pending.indexOf(PASTE_END);
        if (end === -1) {
          const keep = suffixPrefixLength(pending, PASTE_END);
          pasted += pending.slice(0, pending.length - keep);
          pending = pending.slice(pending.length - keep);
          break;
        }
        pasted += pending.slice(0, end);
        pending = pending.slice(end + PASTE_END.length);
        pasting = false;
        keys.push({ name: "paste", text: pasted });
        pasted = "";
        continue;
      }
      if (!pending.startsWith(ESC)) {
        const nextEsc = pending.indexOf(ESC);
        const plain = nextEsc === -1 ? pending : pending.slice(0, nextEsc);
        for (const ch of plain) keys.push(keyFor(ch));
        pending = nextEsc === -1 ? "" : pending.slice(nextEsc);
        continue;
      }
      const escaped = consumeEscape(pending);
      if (escaped.pending && pending.length <= MAX_SEQUENCE_CHARS) break;
      if (escaped.key !== null) keys.push(escaped.key);
      if (pending.startsWith(PASTE_START)) {
        pending = pending.slice(PASTE_START.length);
        pasting = true;
        pasted = "";
      } else {
        pending = pending.slice(escaped.pending ? pending.length : escaped.length);
      }
    }
    return keys;
  };

  const push = (chunk: Uint8Array | string): Key[] => {
    pending += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    return drain();
  };

  return {
    push,
    needsFlush: () => !pasting && pending === ESC,
    flush() {
      const rest = decoder.decode();
      if (rest.length > 0) pending += rest;
      if (pasting || pending !== ESC) return [];
      if (pending === ESC) {
        pending = "";
        return [{ name: "escape" }];
      }
      return [];
    },
    end() {
      const rest = decoder.decode();
      if (rest.length > 0) pending += rest;
      if (pasting) {
        pending = "";
        pasted = "";
        return [];
      }
      if (pending === ESC) return this.flush();
      pending = "";
      return [];
    },
  };
}

export function parseKeys(chunk: Uint8Array | string): Key[] {
  const stream = createKeyStream();
  return [...stream.push(chunk), ...stream.end()];
}
