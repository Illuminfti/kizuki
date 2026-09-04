/**
 * Terminal text primitives. Everything the audit screen prints passes
 * through here, so width math is done once and captured text (which is
 * attacker-controlled input, invariant 7) can never carry an escape sequence
 * into the owner's terminal.
 */

export const ESC = "\x1b";
export const CSI = `${ESC}[`;

const ST = "(?:\\x07|\\x1b\\\\|\\x9c)";
const CSI_PATTERN = /\x1b\[[0-9;:<=>?]*[ -/]*[@-~]|\x9b[0-9;:<=>?]*[ -/]*[@-~]/g;
const OSC_PATTERN = new RegExp(`\\x1b\\][\\s\\S]*?${ST}|\\x9d[\\s\\S]*?${ST}`, "g");
const STRING_SEQ_PATTERN = new RegExp(
  `\\x1b[PX^_][\\s\\S]*?(?:\\x1b\\\\|\\x9c)|\\x90[\\s\\S]*?(?:\\x1b\\\\|\\x9c)|\\x98[\\s\\S]*?(?:\\x1b\\\\|\\x9c)|\\x9e[\\s\\S]*?(?:\\x1b\\\\|\\x9c)|\\x9f[\\s\\S]*?(?:\\x1b\\\\|\\x9c)`,
  "g",
);
const OTHER_ESC_PATTERN = /\x1b./g;

export function stripAnsi(text: string): string {
  return text
    .replace(OSC_PATTERN, "")
    .replace(STRING_SEQ_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(OTHER_ESC_PATTERN, "");
}

/** Removes every control character except newline; ESC never survives. */
export function sanitize(text: string): string {
  let out = "";
  for (const ch of stripAnsi(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x0a) {
      out += ch;
    } else if (cp === 0x09) {
      out += "  ";
    } else if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) {
      // dropped
    } else {
      out += ch;
    }
  }
  return out;
}

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    cp === 0xfeff
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x20 || cp === 0x7f) return 0;
  if (isCombining(cp)) return 0;
  return isWide(cp) ? 2 : 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) width += charWidth(ch);
  return width;
}

/** Width-aware truncation for plain (ANSI-free) text. */
export function truncate(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (stringWidth(text) <= width) return text;
  const tailWidth = stringWidth(ellipsis);
  const budget = Math.max(0, width - tailWidth);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch);
    if (used + w > budget) break;
    out += ch;
    used += w;
  }
  return out + ellipsis;
}

/** Pads or hard-caps a line to exactly `width` columns. Overflow is truncated after stripping ANSI. */
export function padEnd(text: string, width: number): string {
  if (width <= 0) return "";
  const current = stringWidth(text);
  if (current > width) {
    return truncate(stripAnsi(text), width, "");
  }
  if (current === width) return text;
  return text + " ".repeat(width - current);
}

/** Word-wraps plain text to `width` columns; blank lines survive, long tokens hard-break. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim().length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    let lineWidth = 0;
    for (const word of paragraph.split(/\s+/).filter((t) => t.length > 0)) {
      const wordWidth = stringWidth(word);
      if (wordWidth > w) {
        if (line.length > 0) {
          out.push(line);
          line = "";
          lineWidth = 0;
        }
        let chunk = "";
        let chunkWidth = 0;
        for (const ch of word) {
          const cw = charWidth(ch);
          if (chunkWidth + cw > w) {
            out.push(chunk);
            chunk = "";
            chunkWidth = 0;
          }
          chunk += ch;
          chunkWidth += cw;
        }
        line = chunk;
        lineWidth = chunkWidth;
        continue;
      }
      const sep = line.length > 0 ? 1 : 0;
      if (lineWidth + sep + wordWidth > w) {
        out.push(line);
        line = word;
        lineWidth = wordWidth;
      } else {
        line = sep ? `${line} ${word}` : word;
        lineWidth += sep + wordWidth;
      }
    }
    out.push(line);
  }
  return out;
}

export function colorsEnabled(
  env: Record<string, string | undefined> = process.env,
  isTTY = true,
): boolean {
  if (!isTTY) return false;
  if (env["NO_COLOR"] !== undefined && env["NO_COLOR"] !== "") return false;
  if (env["TERM"] === "dumb") return false;
  return true;
}

export interface Paint {
  enabled: boolean;
  bold(s: string): string;
  dim(s: string): string;
  inverse(s: string): string;
  fg(color: number, s: string): string;
  fgBold(color: number, s: string): string;
}

const sgr = (codes: string, s: string): string => `${CSI}${codes}m${s}${CSI}0m`;

export function paint(enabled: boolean): Paint {
  if (!enabled) {
    const id = (s: string): string => s;
    return {
      enabled,
      bold: id,
      dim: id,
      inverse: id,
      fg: (_c, s) => s,
      fgBold: (_c, s) => s,
    };
  }
  return {
    enabled,
    bold: (s) => sgr("1", s),
    dim: (s) => sgr("2", s),
    inverse: (s) => sgr("7", s),
    fg: (c, s) => sgr(`38;5;${c}`, s),
    fgBold: (c, s) => sgr(`1;38;5;${c}`, s),
  };
}

/** 256-color indices chosen to read on both dark and light backgrounds. */
export const COLOR = {
  accent: 110,
  ok: 71,
  warn: 179,
  danger: 167,
  entity: 74,
  capture: 108,
  edit: 179,
  merge: 139,
  deletion: 167,
  purge: 203,
  rule: 240,
  meta: 245,
} as const;
