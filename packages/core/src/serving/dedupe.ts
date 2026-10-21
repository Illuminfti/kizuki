import { eventIdFromReference } from "../retrieval/ids";
import { stringArray } from "../vault/pages";
import type { CanonPage } from "../vault/pages";

/**
 * A capture already cited by a selected page is redundant. A newer revision
 * of the same source record is different evidence and must remain visible
 * until the receipted writer updates the page.
 */
export function eventsCitedByPages(
  pages: readonly CanonPage[],
  candidates: readonly string[],
): Set<string> {
  const cited = new Set(pages.flatMap(page => stringArray(page.data["sources"]).map(eventIdFromReference)));
  return new Set(candidates.filter(id => cited.has(id)));
}
