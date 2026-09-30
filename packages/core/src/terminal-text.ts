/** Shared terminal sanitizer for serving, hooks and the audit UI. */
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

