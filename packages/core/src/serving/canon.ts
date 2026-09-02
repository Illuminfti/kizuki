import { SENSITIVITY_ORDER, authorize } from "../agents";
import type { DenyReason, Grant, Sensitivity, Servable } from "../agents";
import { readHolds } from "../ledger/purge";
import { listCanonPagesReport, stringArray } from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import type { CanonChunk, ServeContext } from "./types";

export interface CanonIndex {
  pages: CanonPage[];
  byId: Map<string, CanonPage>;
  /** Vault-relative path with forward slashes, as the walk produced it. */
  byPath: Map<string, CanonPage>;
  /** Lower-cased title, for resolving wikilink text. */
  byTitle: Map<string, CanonPage[]>;
  holds: Set<string>;
}

export function asSensitivity(value: unknown): Sensitivity | null {
  return typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SENSITIVITY_ORDER, value)
    ? (value as Sensitivity)
    : null;
}

function stringField(page: CanonPage, key: string): string | null {
  const value = page.data[key];
  return typeof value === "string" ? value : null;
}

/**
 * The vault walk reports what it could not use instead of throwing, so the
 * refusal carries that report: the caller-facing message names nothing, and
 * the owner's own tooling reads the paths and reasons off the cause.
 */
export class CanonUnreadableError extends Error {
  override name = "CanonUnreadableError";
  readonly skipped: SkippedPage[];

  constructor(skipped: SkippedPage[]) {
    super(`canon is not fully readable: ${skipped.length} page(s)`);
    this.skipped = skipped;
  }
}

/**
 * One vault walk and one hold read per served call. A page that cannot be
 * parsed makes the whole read refuse: serving a silently short list would
 * under-report canon without anyone noticing.
 */
export function loadCanon(ctx: ServeContext): CanonIndex {
  const report = listCanonPagesReport(ctx.vaultPath);
  if (report.skipped.length > 0) {
    throw new CanonUnreadableError(report.skipped);
  }
  const byId = new Map<string, CanonPage>();
  const byPath = new Map<string, CanonPage>();
  const byTitle = new Map<string, CanonPage[]>();
  for (const page of report.pages) {
    byId.set(page.id, page);
    byPath.set(page.relPath, page);
    const title = (stringField(page, "title") ?? "").toLowerCase();
    const bucket = byTitle.get(title);
    if (bucket === undefined) byTitle.set(title, [page]);
    else bucket.push(page);
  }
  return {
    pages: report.pages,
    byId,
    byPath,
    byTitle,
    holds: new Set(readHolds(ctx.db).map((hold) => hold.page_path)),
  };
}

/** A retracted page is absent, not a policy denial: `draft` and `archived` never count. */
export function eligible(page: CanonPage): boolean {
  return page.data["status"] === "active";
}

export function pageServable(index: CanonIndex, page: CanonPage): Servable {
  const type = stringField(page, "type");
  return {
    id: page.id,
    sensitivity: stringField(page, "sensitivity"),
    ...(type === null ? {} : { type }),
    subjects: stringArray(page.data["subjects"]),
    held: index.holds.has(page.relPath),
  };
}

export function pageDecision(
  index: CanonIndex,
  grant: Grant,
  page: CanonPage,
):
  | { allow: true; sensitivity: Sensitivity }
  | { allow: false; reason: DenyReason } {
  // The label is read first so the served chunk carries a narrowed type
  // instead of a cast: an unlabeled page is withheld from everyone, the
  // owner included.
  const label = asSensitivity(page.data["sensitivity"]);
  if (label === null) return { allow: false, reason: "missing_sensitivity" };
  const decision = authorize(grant, pageServable(index, page));
  return decision.allow
    ? { allow: true, sensitivity: label }
    : { allow: false, reason: decision.reason };
}

/**
 * Wikilink text names a page by id, by path, or by title, in that order. The
 * packet's related section and the graph tool must resolve a link the same
 * way, so the precedence lives with the index it reads.
 */
export function resolveLink(
  index: CanonIndex,
  target: string,
): CanonPage | undefined {
  return (
    index.byId.get(target) ??
    index.byPath.get(`${target}.md`) ??
    index.byTitle.get(target.toLowerCase())?.[0]
  );
}

export function canonChunk(
  page: CanonPage,
  sensitivity: Sensitivity,
  excerpt: string,
  truncated: boolean,
): CanonChunk {
  return {
    page_id: page.id,
    path: page.relPath,
    title: stringField(page, "title") ?? "",
    type: stringField(page, "type") ?? "",
    sensitivity,
    subjects: stringArray(page.data["subjects"]),
    sources: stringArray(page.data["sources"]),
    excerpt,
    truncated,
  };
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Code-point safe, so a surrogate pair at the boundary is never split. */
export function excerptOf(
  body: string,
  maxChars: number,
): { excerpt: string; truncated: boolean } {
  const points = Array.from(body);
  if (points.length <= maxChars) return { excerpt: body, truncated: false };
  return { excerpt: points.slice(0, maxChars).join(""), truncated: true };
}
