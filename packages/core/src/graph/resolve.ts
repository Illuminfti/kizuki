import type { CanonPage } from "../vault/pages";
import { isLiveCanonPage } from "../vault/pages";

export interface LinkIndex {
  byId: Map<string, string>;
  byPath: Map<string, string[]>;
  byTitle: Map<string, string[]>;
}

function addKey(index: Map<string, string[]>, key: string, id: string): void {
  const bucket = index.get(key);
  if (bucket === undefined) index.set(key, [id]);
  else if (!bucket.includes(id)) bucket.push(id);
}

function unique(ids: readonly string[] | undefined): string | null {
  return ids !== undefined && ids.length === 1 ? (ids[0] ?? null) : null;
}

export function linkIndexFromPages(pages: readonly CanonPage[]): LinkIndex {
  const byId = new Map<string, string>();
  const byPath = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  for (const page of pages) {
    if (!isLiveCanonPage(page)) continue;
    byId.set(page.id, page.id);
    addKey(byPath, page.relPath, page.id);
    const stem = page.relPath.replace(/\.md$/i, "");
    addKey(byPath, stem, page.id);
    const base = page.relPath.split("/").pop();
    if (base !== undefined) {
      addKey(byPath, base, page.id);
      addKey(byPath, base.replace(/\.md$/i, ""), page.id);
    }
    const title = typeof page.data["title"] === "string"
      ? page.data["title"].toLowerCase()
      : "";
    if (title.length === 0) continue;
    addKey(byTitle, title, page.id);
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
    unique(index.byPath.get(trimmed)) ??
    unique(index.byPath.get(`${trimmed}.md`));
  if (byPath !== null) return byPath;
  return unique(index.byTitle.get(trimmed.toLowerCase()));
}
