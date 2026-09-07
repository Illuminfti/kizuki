import { CanonWriteError } from "./errors";

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_SEGMENTS = 8;
const MAX_SEGMENT_LENGTH = 64;

/**
 * A decision is caller-built, so the writer re-validates the path it names:
 * vault-relative, Markdown, the same segment rules as `pageRelPath`, and
 * never the archive directory or a doctrine file.
 */
export function assertPageRelPath(relPath: string): void {
  if (typeof relPath !== "string") throw new CanonWriteError("target_invalid", "page path must be text");
  const segments = relPath.split("/");
  const last = segments.at(-1);
  if (
    segments.length > MAX_SEGMENTS ||
    last === undefined ||
    !last.endsWith(".md") ||
    last.length <= 3 ||
    segments[0] === "archive" ||
    (segments.length === 1 && (last === "CANON.md" || last === "SCHEMA.md"))
  ) {
    throw new CanonWriteError("target_invalid", "decision names an unusable page path");
  }
  for (const [index, segment] of segments.entries()) {
    const limit = index === segments.length - 1 ? MAX_SEGMENT_LENGTH + 3 : MAX_SEGMENT_LENGTH;
    if (segment.length > limit || !PATH_SEGMENT.test(segment)) {
      throw new CanonWriteError("target_invalid", "decision names an unusable page path");
    }
  }
}

/** Modern encoded names and historical .prev names both live directly here. */
export function assertArchiveRelPath(path: string): void {
  if (typeof path !== "string" || !/^archive\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(path)) {
    throw new CanonWriteError("target_invalid", "receipt names an unusable archive path");
  }
}

/** Stored history is readable by contained paths; writes still require their own authority. */
export function assertStoredPageRelPath(path: string): void {
  if (typeof path === "string" && path.startsWith("archive/")) assertArchiveRelPath(path);
  else assertPageRelPath(path);
}

/** Erased and archived receipts remain history; only ordinary paths can be undone. */
export function assertReceiptPaths(receipt: { page_path: string; archive_path: string | null }): void {
  if (typeof receipt.page_path !== "string" || (receipt.archive_path !== null && typeof receipt.archive_path !== "string")) {
    throw new CanonWriteError("target_invalid", "receipt paths must be text or null archive");
  }
  if (receipt.page_path === "") {
    if (receipt.archive_path !== null) {
      throw new CanonWriteError("target_invalid", "erased receipt cannot name archive bytes");
    }
    return;
  }
  assertStoredPageRelPath(receipt.page_path);
  if (receipt.archive_path !== null) assertArchiveRelPath(receipt.archive_path);
}
