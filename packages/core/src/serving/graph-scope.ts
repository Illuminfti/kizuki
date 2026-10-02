import { denyClassesOf, type Grant } from "../agents";
import type { GraphServingScope } from "../graph/graph";
import { eligible, pageDecision, type CanonIndex } from "./canon";
import type { ServeContext } from "./types";

/** The v1 graph port cannot apply class denial before its bounded walk. */
export function requiresClassScopedGraph(ctx: ServeContext): boolean {
  return ctx.principal.kind !== "owner" && denyClassesOf(ctx.principal.grant).length > 0;
}

/** Admit page identities once, before selecting any bounded graph frontier. */
export function graphServingScope(index: CanonIndex, grant: Grant): GraphServingScope {
  const readablePageIds: string[] = [];
  const excludedPageIds: string[] = [];
  for (const page of index.pages) {
    if (eligible(page) && pageDecision(index, grant, page).allow) readablePageIds.push(page.id);
    else excludedPageIds.push(page.id);
  }
  const ctx = index.sourceContext;
  return {
    readablePageIds, excludedPageIds,
    source: {
      owner: ctx.principal.kind === "owner",
      purpose: ctx.sourcePurpose ?? "recall",
      deny_classes: denyClassesOf(grant),
    },
  };
}
