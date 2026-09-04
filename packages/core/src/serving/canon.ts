import { sourceEventsAllowed, sourceSensitivity } from "../ledger/source-grants";
import { authorize, sensitivity } from "../agents";
import type { DenyReason, Grant, Sensitivity, Servable } from "../agents";
import type { AuthorityTier } from "../contracts/proposal";
import { canonAuthorities } from "../canon/authority";
import { readHolds } from "../ledger/purge";
import { isLiveCanonPage, listCanonPagesReport, stringArray } from "../vault/pages";
import type { CanonPage, SkippedPage } from "../vault/pages";
import { PAGE_TAINTS } from "../vault/schema";
import type { PageTaint } from "../vault/schema";
import type { CanonChunk, ServeContext } from "./types";

export interface CanonIndex {
  sourceContext: ServeContext;
  pages: CanonPage[];
  byId: Map<string, CanonPage>;
  /** Vault-relative path with forward slashes, as the walk produced it. */
  byPath: Map<string, CanonPage>;
  holds: Set<string>;
  /** Hash-bound effective authority of the current page bytes. */
  authority: Map<string, AuthorityTier>;
}

export { sensitivity as asSensitivity };

/** A frontmatter value only when it is a string; every other shape is absent. */
export function stringField(page: CanonPage, key: string): string | null {
  const value = page.data[key];
  return typeof value === "string" ? value : null;
}

/** RFC 0002 §10.5: a page carries `clean` produced prose or `quoted` capture. */
export function asTaint(value: unknown): PageTaint | null {
  return typeof value === "string" &&
    (PAGE_TAINTS as readonly string[]).includes(value)
    ? (value as PageTaint)
    : null;
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
 * read, parsed, or uniquely identified makes the whole read refuse: serving
 * a silently short list would under-report canon without anyone noticing.
 * Schema-invalid and oversized files are withheld and reported by doctor.
 */
export function loadCanon(ctx: ServeContext): CanonIndex {
  const report = listCanonPagesReport(ctx.vaultPath);
  const fatal = report.skipped.filter(
    (skipped) => skipped.code !== "invalid" && skipped.code !== "oversize",
  );
  if (fatal.length > 0) {
    throw new CanonUnreadableError(fatal);
  }
  const byId = new Map<string, CanonPage>();
  const byPath = new Map<string, CanonPage>();
  for (const page of report.pages) {
    byId.set(page.id, page);
    byPath.set(page.relPath, page);
  }
  return {
    sourceContext: ctx,
    pages: report.pages,
    byId,
    byPath,
    holds: new Set(readHolds(ctx.db).map((hold) => hold.page_path)),
    authority: canonAuthorities(ctx.db, report.pages),
  };
}

/** A retracted page is absent, not a policy denial: `draft` and `archived` never count. */
export function eligible(page: CanonPage): boolean {
  return isLiveCanonPage(page);
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
  | { allow: true; sensitivity: Sensitivity; taint: PageTaint }
  | { allow: false; reason: DenyReason } {
  // Both labels are read first so the served chunk carries narrowed types
  // instead of casts. A page missing either is withheld from everyone, the
  // owner included: an unstamped page may be verbatim capture, and serving
  // it as canon would hand a reader capture dressed as produced prose.
  const sourceCtx = index.sourceContext;
  if (!sourceEventsAllowed(sourceCtx.db, stringArray(page.data["sources"]), { owner: sourceCtx.principal.kind === "owner", purpose: sourceCtx.sourcePurpose ?? "recall" })) return { allow: false, reason: "held" };
  const original = sensitivity(page.data["sensitivity"]);
  const label = original === null ? null : sourceSensitivity(sourceCtx.db, stringArray(page.data["sources"]), original);
  if (label === null) return { allow: false, reason: "missing_sensitivity" };
  const taint = asTaint(page.data["taint"]);
  if (taint === null) return { allow: false, reason: "missing_taint" };
  const decision = authorize(grant, { ...pageServable(index, page), sensitivity: label });
  return decision.allow
    ? { allow: true, sensitivity: label, taint }
    : { allow: false, reason: decision.reason };
}

export function canonChunk(
  index: CanonIndex,
  page: CanonPage,
  decision: { sensitivity: Sensitivity; taint: PageTaint },
  excerpt: string,
  truncated: boolean,
): CanonChunk {
  return {
    page_id: page.id,
    path: page.relPath,
    title: stringField(page, "title") ?? "",
    type: stringField(page, "type") ?? "",
    sensitivity: decision.sensitivity,
    taint: decision.taint,
    authority: index.authority.get(page.relPath) ?? null,
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
