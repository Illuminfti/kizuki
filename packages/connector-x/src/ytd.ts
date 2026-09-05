import { isPlainObject } from "@kizuki/core";
import { archiveError } from "./errors";

export const MAX_JSON_DEPTH = 64;
export const MAX_YTD_BYTES = 16 * 1024 * 1024;
const WRAPPER = /^\uFEFF?\s*window\.YTD\.([A-Za-z0-9_]+)\.part([0-9]+)\s*=\s*([\s\S]*?)\s*;?\s*$/u;

export function jsonDepth(source: string): number {
  let depth = 0;
  let maximum = 0;
  let inString = false;
  let escape = false;
  for (const char of source) {
    if (inString) {
      if (escape) escape = false;
      else if (char === "\\") escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") {
      depth += 1;
      maximum = Math.max(maximum, depth);
    } else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth < 0) return MAX_JSON_DEPTH + 1;
    }
  }
  return inString || depth !== 0 ? MAX_JSON_DEPTH + 1 : maximum;
}

export function parseYtd(
  source: string,
  expectedDataset: "account" | "tweets",
  expectedPart: number,
): unknown[] {
  if (Buffer.byteLength(source, "utf8") > MAX_YTD_BYTES) {
    throw archiveError("parse_error", `${expectedDataset} part ${expectedPart} exceeds ${MAX_YTD_BYTES} bytes`);
  }
  const match = WRAPPER.exec(source);
  if (
    match === null || match[1] !== expectedDataset ||
    Number(match[2]) !== expectedPart
  ) {
    throw archiveError(
      "parse_error",
      `${expectedDataset} part ${expectedPart} has an invalid archive wrapper`,
    );
  }
  const json = match[3] ?? "";
  if (jsonDepth(json) > MAX_JSON_DEPTH) {
    throw archiveError("parse_error", `${expectedDataset} part ${expectedPart} exceeds JSON depth ${MAX_JSON_DEPTH}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (error) {
    throw archiveError("parse_error", `${expectedDataset} part ${expectedPart} contains malformed JSON`, error);
  }
  if (!Array.isArray(parsed)) {
    throw archiveError("parse_error", `${expectedDataset} part ${expectedPart} must contain an array`);
  }
  return parsed;
}

export function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw archiveError("parse_error", `${field} must be an object`);
  }
  return value;
}
