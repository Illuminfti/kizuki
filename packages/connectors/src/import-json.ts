import { KizukiError } from "./errors";
import { MAX_RECORDS } from "./util";

/** Nesting a hostile export can use to blow the stack during JSON.parse. */
export const MAX_JSON_DEPTH = 64;

/**
 * Walks the bytes for structural nesting without building a graph. Strings
 * are skipped so a payload full of braces cannot fake depth.
 */
export function jsonNestingDepth(source: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      if (depth > max) max = depth;
      continue;
    }
    if (char === "}" || char === "]") {
      if (depth > 0) depth -= 1;
    }
  }
  return max;
}

export function parseBoundedJsonArray(
  source: string,
  label: string,
  maxRecords = MAX_RECORDS,
): unknown[] {
  if (jsonNestingDepth(source) > MAX_JSON_DEPTH) {
    throw new KizukiError(
      "parse_error",
      `${label}: JSON nesting exceeds ${MAX_JSON_DEPTH}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new KizukiError("parse_error", `${label}: malformed JSON`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new KizukiError("parse_error", `${label}: expected a JSON array`);
  }
  if (parsed.length > maxRecords) {
    throw new KizukiError(
      "parse_error",
      `${label}: export holds more than ${maxRecords} records`,
    );
  }
  return parsed;
}
