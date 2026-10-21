import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../util/validate";

export const DEFAULT_LIVE_PAGE_CEILING = 20_000;
export const LIVE_PAGE_CEILING_BOUNDS = { min: 100, max: 250_000 } as const;
const MIN_WALK_FILES = 40_000;
const MIN_WALK_BYTES = 64 * 1_048_576;
const WALK_BYTES_PER_FILE = 4_096;
const CONFIG_BYTES = 65_536;
export const CANON_SCAN_FILE_BOUNDS = { min: 100, max: 1_000_000 } as const;
export const CANON_SCAN_BYTE_BOUNDS = { min: 65_536, max: 1_073_741_824 } as const;

/** Writer capacity and independent resource budgets for complete reads. */
export interface CanonLimits {
  readonly live_pages: number;
  /** Includes archived pages and invalid candidates; never a writer ceiling. */
  readonly walk_files: number;
  readonly walk_bytes: number;
}

export function canonLimitsFor(livePages: number): CanonLimits {
  const walkFiles = Math.max(MIN_WALK_FILES, livePages * 2);
  return {
    live_pages: livePages,
    walk_files: walkFiles,
    walk_bytes: Math.min(CANON_SCAN_BYTE_BOUNDS.max, Math.max(MIN_WALK_BYTES, walkFiles * WALK_BYTES_PER_FILE)),
  };
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
    ? value : fallback;
}

/** Bounded local configuration, with the same default-on-invalid convention as serve config. */
export function loadCanonLimits(vaultPath: string): CanonLimits {
  const path = join(vaultPath, ".kizuki", "serve.toml");
  try {
    if (!existsSync(path) || statSync(path).size > CONFIG_BYTES) return canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING);
    const parsed: unknown = Bun.TOML.parse(readFileSync(path, "utf8"));
    const table = isPlainObject(parsed) && isPlainObject(parsed["canon"]) ? parsed["canon"] : {};
    const defaults = canonLimitsFor(integer(table["max_live_pages"], DEFAULT_LIVE_PAGE_CEILING, LIVE_PAGE_CEILING_BOUNDS.min, LIVE_PAGE_CEILING_BOUNDS.max));
    return {
      live_pages: defaults.live_pages,
      walk_files: integer(table["max_scan_files"], defaults.walk_files, CANON_SCAN_FILE_BOUNDS.min, CANON_SCAN_FILE_BOUNDS.max),
      walk_bytes: integer(table["max_scan_bytes"], defaults.walk_bytes, CANON_SCAN_BYTE_BOUNDS.min, CANON_SCAN_BYTE_BOUNDS.max),
    };
  } catch {
    return canonLimitsFor(DEFAULT_LIVE_PAGE_CEILING);
  }
}

export type CanonCapacityState = "ok" | "near" | "full" | "scan_limited";

export interface CanonCapacity {
  readonly state: CanonCapacityState;
  /** Valid pages that are not archived. Counts are lower bounds when scan_limited. */
  readonly live: number;
  readonly archived: number;
  readonly ceiling: number;
  readonly walk_files: number;
  readonly walk_bytes: number;
  readonly next: string | null;
}

export function canonCapacity(
  pages: readonly { readonly data: Record<string, unknown> }[],
  truncated: boolean,
  limits: CanonLimits,
  usage?: { readonly scanned_files: number; readonly scanned_bytes: number },
): CanonCapacity {
  let archived = 0;
  for (const page of pages) if (page.data["status"] === "archived") archived++;
  const live = pages.length - archived;
  const resourceFull = truncated || (usage !== undefined && (usage.scanned_files >= limits.walk_files || usage.scanned_bytes >= limits.walk_bytes));
  const state: CanonCapacityState = resourceFull ? "scan_limited"
    : live >= limits.live_pages ? "full" : live >= limits.live_pages * 0.8 ? "near" : "ok";
  const next = state === "scan_limited"
    ? "raise max_scan_files or max_scan_bytes under [canon] in .kizuki/serve.toml within available memory; retry the incomplete read"
    : limits.live_pages >= LIVE_PAGE_CEILING_BOUNDS.max
    ? `the ceiling is at its maximum of ${LIVE_PAGE_CEILING_BOUNDS.max}; purge sources you no longer need`
    : `raise max_live_pages under [canon] in .kizuki/serve.toml (now ${limits.live_pages}, at most ${LIVE_PAGE_CEILING_BOUNDS.max})`;
  return {
    state, live, archived, ceiling: limits.live_pages,
    walk_files: limits.walk_files, walk_bytes: limits.walk_bytes,
    next: state === "ok" ? null : next,
  };
}

/** Backups carry only validated canon resources, never runtime endpoints or secrets. */
export function validateCanonLimits(value: unknown): CanonLimits {
  if (!isPlainObject(value) || Object.keys(value).length !== 3 ||
      integer(value["live_pages"], -1, LIVE_PAGE_CEILING_BOUNDS.min, LIVE_PAGE_CEILING_BOUNDS.max) === -1 ||
      integer(value["walk_files"], -1, CANON_SCAN_FILE_BOUNDS.min, CANON_SCAN_FILE_BOUNDS.max) === -1 ||
      integer(value["walk_bytes"], -1, CANON_SCAN_BYTE_BOUNDS.min, CANON_SCAN_BYTE_BOUNDS.max) === -1) {
    throw new Error("backup canon limits are invalid");
  }
  return { live_pages: value["live_pages"] as number, walk_files: value["walk_files"] as number, walk_bytes: value["walk_bytes"] as number };
}
