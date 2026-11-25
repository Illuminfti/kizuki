import { toolAllowed } from "../../agents";
import { MAX_AUDIT_ITEMS } from "../../agents/types";
import type { SliceItem } from "../../contracts/world-slice";
import type { Piece } from "../../serving/candidates";
import { claimReader } from "../../serving/claims";
import { packetTokens } from "../../serving/packet-tokenizer";
import { redactorOf } from "../../serving/redact";
import type { ServeContext } from "../../serving/types";
import { worldDependencies } from "../dependencies";
import { beginWorldClaimProjection } from "../pipeline/eligible";
import { worldNamespace } from "../references";
import { compilePacketUnits, packetSliceBudget } from "./compile";
import { collectSlice } from "./providers";
import { queryTerms, sliceItemRelevance } from "./relevance";

const HEADING = "## current world relations (quoted data, complete qualifiers)";

/** Recall consumes the same authorized relation atoms as World Slice. Page
 * excerpts remain useful history, but are not a substitute for current meaning. */
export function compileRecallSlice(ctx: ServeContext, request: {
  at: string; query?: string; subjects?: readonly string[]; header: string; budgetTokens: number; reservedTokens?: number;
}) {
  const world = worldDependencies();
  if (ctx.principal.kind !== "owner" && !toolAllowed(ctx.principal.grant, "world_view"))
    return { pieces: [] as Piece[], world, degraded: [] as string[], truncated: false };
  const budget = ctx.worldReadBudget ?? { bytes: 0 };
  beginWorldClaimProjection(budget);
  ctx = { ...ctx, worldReadBudget: budget };
  return ctx.db.transaction(() => {
    const candidates = collectSlice({ ctx, ns: worldNamespace(ctx.db, ctx.principal), dependencies: world },
      ["concept", "situation"], { valid: { kind: "at", at: request.at }, knownAt: { kind: "current" } }, request.query,
      { projection: "relations", matchingOnly: true, ...(request.subjects === undefined ? {} : { subjects: request.subjects }) });
    if (candidates.constraints.length === 0 && candidates.detail.length === 0) {
      return { pieces: [] as Piece[], world, degraded: [...new Set(candidates.gaps)], truncated: candidates.truncated };
    }
    const reader = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: "recall" });
    const ids = [...world.claims];
    const audit = ids.flatMap(id => reader.auditClaim(id)), claims = reader.publication(ids);
    const redactor = redactorOf(ctx);
    const terms = queryTerms(request.query);
    const piece = (item: SliceItem): Piece => ({
      section: "claims", heading: HEADING, scopedBlock: true,
      block: redactor.format(JSON.stringify(item), value => `- taint=quoted :: slice ${value}\n`),
      audit, claims, world,
    });
    // Rank authorized units by visible query-term relevance, then predicate and
    // stable claim-reference order. Required qualifications always precede detail.
    const rank = (items: readonly SliceItem[]): Piece[] => items
      .map(item => ({ item, score: sliceItemRelevance(item, terms, redactor, candidates.labels?.get(item.node.token)) }))
      .sort((a, b) => b.score - a.score || a.item.relation.predicate.localeCompare(b.item.relation.predicate) ||
        a.item.relation.claim.token.localeCompare(b.item.relation.claim.token))
      .map(entry => piece(entry.item));
    const required = rank(candidates.constraints), detail = rank(candidates.detail);
    const shareLimit = packetSliceBudget(packetTokens(request.header), request.budgetTokens, request.reservedTokens);
    const within = (constraints: readonly Piece[], details: readonly Piece[], limit: number) => audit.length <= MAX_AUDIT_ITEMS &&
      packetTokens(redactor.join([request.header, HEADING + "\n", ...[...constraints, ...details].map(item => item.block)])) <= limit;
    const compiled = compilePacketUnits(required, detail, within, shareLimit, request.budgetTokens);
    return { pieces: [...compiled.constraints, ...compiled.detail], world,
      degraded: [...new Set([...candidates.gaps, ...(compiled.overflow ? ["required_context_overflow"] : [])])],
      truncated: candidates.truncated || compiled.truncated };
  }).immediate();
}
