import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { KizukiError } from "../errors";
import { errorMessage } from "../util";

/**
 * An owner-written mapping file decides what a migration means. It is read
 * synchronously in the connector constructor, before any source file is
 * touched, so a typo is a refusal rather than a half-finished import.
 */

const MAX_MAPPING_BYTES = 1024 * 1024;

/** The sibling name a directory source is expected to carry. */
export const MAPPING_FILE_NAME = "kizuki-mapping.json";

export interface LoadedMapping {
  raw: unknown;
  /**
   * sha256 over canonical JSON, so reformatting the file does not re-emit an
   * estate, but changing one mapped value does.
   */
  hash: string;
  source: "file" | "inline";
}

export function defaultMappingPath(
  sourcePath: string,
  kind: "directory" | "file",
): string {
  return kind === "directory"
    ? join(sourcePath, MAPPING_FILE_NAME)
    : `${sourcePath}.${MAPPING_FILE_NAME}`;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort())
      sorted[key] = sortDeep(source[key]);
    return sorted;
  }
  return value;
}

export function mappingHash(raw: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(sortDeep(raw)) ?? "null")
    .digest("hex");
}

function readMappingFile(path: string, connectorId: string): unknown {
  if (!existsSync(path)) {
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: mapping file not found: ${path}; see docs/legacy-import.md`,
    );
  }
  let source: string;
  try {
    if (statSync(path).size > MAX_MAPPING_BYTES) {
      throw new KizukiError(
        "misconfigured",
        `${connectorId}: mapping file exceeds ${MAX_MAPPING_BYTES} bytes: ${path}`,
      );
    }
    source = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof KizukiError) throw error;
    throw new KizukiError(
      "misconfigured",
      `${connectorId}: cannot read mapping file ${path}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new KizukiError(
      "parse_error",
      `${connectorId}: mapping file is not valid JSON: ${path}`,
      { cause: error },
    );
  }
}

export function loadMapping(
  mapping: string | object | undefined,
  fallbackPath: string,
  connectorId: string,
): LoadedMapping {
  if (typeof mapping === "object" && mapping !== null) {
    return { raw: mapping, hash: mappingHash(mapping), source: "inline" };
  }
  const path = typeof mapping === "string" ? mapping : fallbackPath;
  const raw = readMappingFile(path, connectorId);
  return { raw, hash: mappingHash(raw), source: "file" };
}
