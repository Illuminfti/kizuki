import { denyClassesOf, type Grant } from "../agents";
import type { GraphServingScope } from "../graph/graph";
import type { Database } from "bun:sqlite";
import { eligible, pageDecision, type CanonIndex } from "./canon";
import type { ServeContext } from "./types";
import type { CanonPage } from "../vault/pages";

type Decision = ReturnType<typeof pageDecision>;

/** The v1 graph port cannot apply class denial before its bounded walk. */
export function requiresClassScopedGraph(ctx: ServeContext): boolean {
  return ctx.principal.kind !== "owner" && denyClassesOf(ctx.principal.grant).length > 0;
}

/** Admit page identities once, before selecting any bounded graph frontier. */
export function graphServingScope(index: CanonIndex, grant: Grant, decide: (page: CanonPage) => Decision = page => pageDecision(index, grant, page)): GraphServingScope {
  const readablePageIds: string[] = [];
  const excludedPageIds: string[] = [];
  for (const page of index.pages) {
    if (eligible(page) && decide(page).allow) readablePageIds.push(page.id);
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

/** Commits by this connection or any other, and schema changes, all move it. */
function databaseStamp(db: Database): string | null {
  if (db.inTransaction) return null;
  const row = db.query<{ changes: number; version: number; schema: number }, []>(
    "SELECT total_changes() AS changes, (SELECT data_version FROM pragma_data_version) AS version, (SELECT schema_version FROM pragma_schema_version) AS schema",
  ).get()!;
  return `${row.changes}:${row.version}:${row.schema}`;
}

interface Taken { readonly decision: Decision; readonly id: string; readonly path: string; readonly relPath: string; readonly contentHash: string; readonly body: string; readonly data: string }

/**
 * Page decisions taken within one call, for one index and grant, so a later
 * pass over a reloaded index of the same call need not decide every page again.
 * A decision is handed on only when the database has not changed since before
 * the first one was taken, and the reloaded page has the bytes, frontmatter and
 * index admission (generation, hold, durable denial) the decided page had then.
 * Otherwise the later pass decides the page itself. Nothing outlives the call.
 */
export class CallDecisions {
  private readonly stamp: string | null;
  private readonly taken = new Map<string, Taken>();

  constructor(private readonly index: CanonIndex, private readonly grant: Grant) {
    this.stamp = databaseStamp(index.sourceContext.db);
  }

  decide(page: CanonPage): Decision {
    const known = this.taken.get(page.id);
    if (known !== undefined) return known.decision;
    const decision = pageDecision(this.index, this.grant, page);
    this.taken.set(page.id, { decision, id: page.id, path: page.path, relPath: page.relPath, contentHash: page.contentHash, body: page.body, data: JSON.stringify(page.data) });
    return decision;
  }

  /** The graph scope of `live`, reusing decisions where provably the same. */
  graphScope(live: CanonIndex, grant: Grant): GraphServingScope {
    const reuse = this.over(live, grant);
    if (reuse === undefined) return graphServingScope(live, grant);
    const scope = graphServingScope(live, grant, reuse);
    // A commit during the pass would leave reused decisions older than fresh ones.
    return this.unchanged(live) ? scope : graphServingScope(live, grant);
  }

  private unchanged(live: CanonIndex): boolean {
    return this.stamp !== null && databaseStamp(live.sourceContext.db) === this.stamp;
  }

  private over(live: CanonIndex, grant: Grant): ((page: CanonPage) => Decision) | undefined {
    const decideLive = (page: CanonPage): Decision => pageDecision(live, grant, page);
    const prior = this.index;
    if (grant !== this.grant || live.sourceContext !== prior.sourceContext ||
      live.generation !== prior.generation || !this.unchanged(live)) return undefined;
    return page => {
      const known = this.taken.get(page.id);
      if (known === undefined || known.path !== page.path || known.relPath !== page.relPath || known.contentHash !== page.contentHash ||
        known.body !== page.body || known.data !== JSON.stringify(page.data) ||
        prior.holds.has(page.relPath) !== live.holds.has(page.relPath) ||
        prior.deniedPaths.has(page.relPath) !== live.deniedPaths.has(page.relPath)) return decideLive(page);
      return known.decision;
    };
  }
}
