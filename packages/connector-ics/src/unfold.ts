import { KizukiError } from "@kizuki/core";

export const MAX_ICS_CHARS = 8 * 1024 * 1024;
export const MAX_CONTENT_LINES = 50_000;

/**
 * RFC 5545 line unfolding. Both bounds are hard: a calendar is a file the
 * owner points at, and a hostile one must cost a fixed amount of work.
 */
export function unfold(text: string): string[] {
  if (text.length > MAX_ICS_CHARS) {
    throw new KizukiError(
      "parse_error",
      "kizuki.ics: calendar text is too long",
    );
  }
  const stripped = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines: string[] = [];
  for (const raw of stripped.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (lines.length === 0) continue;
      lines[lines.length - 1] += line.slice(1);
      continue;
    }
    if (line.length === 0) continue;
    if (lines.length >= MAX_CONTENT_LINES) {
      throw new KizukiError(
        "parse_error",
        "kizuki.ics: calendar has too many content lines",
      );
    }
    lines.push(line);
  }
  return lines;
}
