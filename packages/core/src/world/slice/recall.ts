import { toolAllowed } from "../../agents";
import { MAX_AUDIT_ITEMS } from "../../agents/types";
import type { Piece } from "../../serving/candidates";
import { claimReader } from "../../serving/claims";
import { packetTokens } from "../../serving/packet-tokenizer";
import { redactorOf } from "../../serving/redact";
import type { ServeContext } from "../../serving/types";
import { worldDependencies } from "../dependencies";
import { beginWorldClaimProjection } from "../pipeline/eligible";
import { worldNamespace } from "../references";
import { compileUnits } from "./compile";
import { collectSlice } from "./providers";

const HEADING = "## current world relations (quoted data, complete qualifiers)";

/** Recall consumes the same authorized relation atoms as World Slice. Page
 * excerpts remain useful history, but are not a substitute for current meaning. */
export function compileRecallSlice(ctx: ServeContext, request: {
  at: string; query?: string; subjects?: readonly string[]; header: string; budgetTokens: number;
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
    const reader = claimReader(ctx.db, ctx.principal.grant, { owner: ctx.principal.kind === "owner", purpose: "recall" });
    const ids = [...world.claims];
    const audit = ids.flatMap(id => reader.auditClaim(id)), claims = reader.publication(ids);
    const redactor = redactorOf(ctx);
    const piece = (item: (typeof candidates.constraints)[number]): Piece => ({
      section: "claims", heading: HEADING, scopedBlock: true,
      block: redactor.format(JSON.stringify(item), value => `- taint=quoted :: slice ${value}\n`),
      audit, claims, world,
    });
    // Predicate order, then the reader's stable claim-reference order. Required
    // qualifications always precede optional detail; no unit is shortened.
    const order = (a: (typeof candidates.constraints)[number], b: (typeof candidates.constraints)[number]) =>
      a.relation.predicate.localeCompare(b.relation.predicate) || a.relation.claim.token.localeCompare(b.relation.claim.token);
    const required = [...candidates.constraints].sort(order).map(piece), detail = [...candidates.detail].sort(order).map(piece);
    const fits = (constraints: readonly Piece[], details: readonly Piece[]) => audit.length <= MAX_AUDIT_ITEMS &&
      packetTokens(redactor.join([request.header, HEADING + "\n", ...[...constraints, ...details].map(item => item.block)])) <= request.budgetTokens;
    let compiled = compileUnits(required, detail, fits);
    if (compiled.overflow) {
      const prefix: Piece[] = [];
      for (const item of required) {
        if (!fits([...prefix, item], [])) break;
        prefix.push(item);
      }
      compiled = { ...compileUnits(prefix, detail, fits), overflow: true, truncated: true };
    }
    return { pieces: [...compiled.constraints, ...compiled.detail], world,
      degraded: [...new Set([...candidates.gaps, ...(compiled.overflow ? ["required_context_overflow"] : [])])],
      truncated: candidates.truncated || compiled.truncated };
  }).immediate();
}
