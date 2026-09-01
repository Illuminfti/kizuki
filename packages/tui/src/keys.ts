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

export type Key = { name: "char"; ch: string } | { name: KeyName };

const SEQUENCES: Record<string, KeyName> = {
  "[A": "up",
  "[B": "down",
  "[C": "right",
  "[D": "left",
  "[H": "home",
  "[F": "end",
  "[1~": "home",
  "[4~": "end",
  "[5~": "pageup",
  "[6~": "pagedown",
  OA: "up",
  OB: "down",
  OC: "right",
  OD: "left",
  OH: "home",
  OF: "end",
};

const decoder = new TextDecoder("utf-8", { fatal: false });

/**
 * Splits one stdin chunk into key events. A chunk can carry several keys
 * (a fast typist, a paste) and an escape sequence can arrive whole, so the
 * parser walks the text and consumes the longest known sequence at each ESC.
 */
export function parseKeys(chunk: Uint8Array | string): Key[] {
  const text = typeof chunk === "string" ? chunk : decoder.decode(chunk);
  const keys: Key[] = [];
  const chars = [...text];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] ?? "";
    if (ch === "\x1b") {
      const rest = chars.slice(i + 1, i + 5).join("");
      const match = Object.keys(SEQUENCES)
        .filter((seq) => rest.startsWith(seq))
        .sort((a, b) => b.length - a.length)[0];
      if (match !== undefined) {
        keys.push({ name: SEQUENCES[match] ?? "unknown" });
        i += 1 + match.length;
        continue;
      }
      if (rest.startsWith("[")) {
        // Unknown CSI: consume through the final byte so it cannot leak as text.
        let j = i + 2;
        while (j < chars.length) {
          const cp = chars[j]?.codePointAt(0) ?? 0;
          j += 1;
          if (cp >= 0x40 && cp <= 0x7e) break;
        }
        keys.push({ name: "unknown" });
        i = j;
        continue;
      }
      keys.push({ name: "escape" });
      i += 1;
      continue;
    }
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\r" || ch === "\n") keys.push({ name: "enter" });
    else if (cp === 0x7f || cp === 0x08) keys.push({ name: "backspace" });
    else if (ch === "\t") keys.push({ name: "tab" });
    else if (cp === 0x03) keys.push({ name: "ctrl-c" });
    else if (cp === 0x04) keys.push({ name: "ctrl-d" });
    else if (cp === 0x0c) keys.push({ name: "ctrl-l" });
    else if (cp < 0x20) keys.push({ name: "unknown" });
    else keys.push({ name: "char", ch });
    i += 1;
  }
  return keys;
}
