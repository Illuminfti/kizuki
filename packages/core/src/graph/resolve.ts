import type { CanonPage } from "../vault/pages";
import { isLiveCanonPage } from "../vault/pages";

export interface LinkIndex {
  byId: Map<string, string>;
  byPath: Map<string, string>;
  byTitle: Map<string, string[]>;
}

export function linkIndexFromPages(pages: readonly CanonPage[]): LinkIndex {
  const byId = new Map<string, string>();
  const byPath = new Map<string, string>();
  const byTitle = new Map<string, string[]>();
  for (const page of pages) {
    if (!isLiveCanonPage(page)) continue;
    byId.set(page.id, page.id);
    byPath.set(page.relPath, page.id);
    const stem = page.relPath.replace(/\.md$/i, "");
    byPath.set(stem, page.id);
    const base = page.relPath.split("/").pop();
    if (base !== undefined) {
      byPath.set(base, page.id);
      byPath.set(base.replace(/\.md$/i, ""), page.id);
    }
    const title = typeof page.data["title"] === "string"
      ? page.data["title"].toLowerCase()
      : "";
    if (title.length === 0) continue;
    const bucket = byTitle.get(title);
    if (bucket === undefined) byTitle.set(title, [page.id]);
    else bucket.push(page.id);
  }
  return { byId, byPath, byTitle };
}

/**
 * Resolve wikilink text to a unique page id: id, then path, then unique title.
 * Ambiguous or missing targets stay unresolved.
 */
export function resolveWikilink(
  index: LinkIndex,
  target: string,
): string | null {
  const trimmed = target.trim();
  if (trimmed.length === 0) return null;
  const byId = index.byId.get(trimmed);
  if (byId !== undefined) return byId;
  const byPath =
    index.byPath.get(trimmed) ??
    index.byPath.get(`${trimmed}.md`);
  if (byPath !== undefined) return byPath;
  const titles = index.byTitle.get(trimmed.toLowerCase());
  if (titles !== undefined && titles.length === 1) {
    return titles[0] ?? null;
  }
  return null;
}
