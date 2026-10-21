import type { GraphAnchorV2, GraphDataV2, GraphEdgeV2 } from "../../contracts/scoped-tools";
import { wikilinks } from "../../graph/graph";
import { linkIndexFromPages, resolveWikilink } from "../../graph/resolve";
import { eventIdFromReference } from "../../retrieval/ids";
import { stringArray } from "../../vault/pages";
import { referenceScope } from "../../world/ref-kinds/common";
import { issueEventVersionRef } from "../../world/ref-kinds/evidence";
import { issuePageRef } from "../../world/ref-kinds/page";
import { eventRawSubjectRefs } from "../../world/ref-kinds/raw-subject";
import { eligible, loadCanon, pageDecision } from "../canon";
import type { Served } from "../gate";
import type { GraphData } from "../graph";
import { oneLine, redactorOf } from "../redact";
import type { ServeContext } from "../types";

/** Live authorized canon supplies the same source/subject/wikilink facts as the
 * disposable graph index. Resolving links against this permitted index makes
 * an absent target and a denied target the same quoted source literal. */
export function readScopedGraph(ctx: ServeContext, anchor: GraphAnchorV2, depth: 1 | 2, kinds?: readonly string[]): Served<GraphData> {
  return ctx.db.transaction(() => {
    const scope = referenceScope(ctx), index = loadCanon(ctx);
    const pages = index.pages.filter(page => eligible(page) && pageDecision(index, ctx.principal.grant, page).allow);
    const links = linkIndexFromPages(pages), pageRefs = new Map(pages.flatMap(page => {
      const ref = issuePageRef(scope, page.id, index); return ref === null ? [] : [[page.id, ref] as const];
    }));
    const edges: { edge: GraphEdgeV2; pageId: string; eventId?: string }[] = [];
    for (const page of pages) {
      const from = pageRefs.get(page.id); if (from === undefined) continue;
      if (kinds === undefined || kinds.includes("wikilink")) for (const text of wikilinks(page.body)) {
        const resolved = resolveWikilink(links, text), target = resolved === null ? undefined : pageRefs.get(resolved);
        edges.push({ pageId: page.id, edge: { kind: "wikilink", from, to: target ?? { kind: "unresolved", text: oneLine(redactorOf(ctx).text(text)).slice(0, 1024), quoted: true } } });
      }
      for (const id of stringArray(page.data.sources).map(eventIdFromReference)) {
        const source = issueEventVersionRef(scope, id);
        if (source !== null && (kinds === undefined || kinds.includes("source"))) edges.push({ pageId: page.id, eventId: id, edge: { kind: "source", from, to: source } });
        if (kinds === undefined || kinds.includes("subject")) for (const subject of eventRawSubjectRefs(scope, id, stringArray(page.data.subjects)))
          edges.push({ pageId: page.id, eventId: id, edge: { kind: "subject", from, to: subject } });
      }
    }
    const key = (ref: { kind: string; token: string }) => `${ref.kind}:${ref.token}`;
    let frontier = new Set([key(anchor)]);
    const seen = new Set<string>(), selected: typeof edges = [];
    for (let hop = 0; hop < depth && frontier.size > 0; hop++) {
      const next = new Set<string>();
      for (const item of edges) {
        const { edge } = item, to = edge.to.kind === "unresolved" ? null : key(edge.to), from = key(edge.from);
        if (!frontier.has(from) && (to === null || !frontier.has(to))) continue;
        const identity = JSON.stringify(edge); if (seen.has(identity)) continue;
        seen.add(identity); selected.push(item); next.add(from); if (to !== null) next.add(to);
        if (selected.length === 101) break;
      }
      if (selected.length === 101) break;
      frontier = next;
    }
    const kept = selected.slice(0, 100), usedPages = new Set(kept.map(item => item.pageId));
    for (const [id, ref] of pageRefs) if (key(ref) === key(anchor)) usedPages.add(id);
    const events = [...new Set(kept.flatMap(item => item.eventId === undefined ? [] : [item.eventId]))];
    const scoped: GraphDataV2 = { anchor, edges: kept.map(item => item.edge), truncated: selected.length > 100 };
    return { canon: [], quoted: [], withheld: [], data: { id: "", edges: [], truncated: scoped.truncated, scoped },
      authorization: { pages: [...usedPages].map(id => ({ id, hash: index.byId.get(id)!.contentHash })), events: events.map(id => ({ id })) } };
  }).immediate();
}
