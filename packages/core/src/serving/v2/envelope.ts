import type { WorldEvidenceSource } from "../../world/ops/evidence-types";
import { projectCanonChunk, projectQuotedChunk } from "./chunks";
import { projectToolData } from "./tool-data";
import { loadCanon } from "../canon";
import { resolvePrincipal } from "../../agents";
import type { Tool } from "../../agents";
import { isLedgerBusy } from "../../ledger/busy";
import { issueWorldRef, worldNamespace } from "../../world/references";
import { ledgerBusyServeError } from "../gate";
import { ENVELOPE_V2_SCHEMA, ServeError } from "../types";
import type { CanonChunk, EnvelopeV2, QuotedChunk, ServeContext } from "../types";

/**
 * Builds the scoped envelope field by field. Nothing is stripped from a v1
 * envelope: what is not named here cannot reach the wire, so a field a later
 * change adds to v1 stays off v2 until someone decides it belongs.
 */
export function sealEnvelope<
  T,
  K extends Tool = Tool,
  C extends readonly CanonChunk[] = readonly CanonChunk[],
  Q extends readonly QuotedChunk[] = readonly QuotedChunk[],
>(ctx: ServeContext, tool: K, at: string, canon: C, quoted: Q, data: T, message?: "dry_run"): EnvelopeV2<unknown, K, readonly import("../../contracts/scoped-tools").CanonChunkV2[], readonly (import("../../contracts/scoped-tools").QuotedChunkV2 | import("../../world/ops/evidence-types").WorldQuotedEvidence)[]> {
  try {
    return ctx.db
      .transaction((): EnvelopeV2<unknown, K, readonly import("../../contracts/scoped-tools").CanonChunkV2[], readonly (import("../../contracts/scoped-tools").QuotedChunkV2 | import("../../world/ops/evidence-types").WorldQuotedEvidence)[]> => {
        const principal = resolvePrincipal(ctx.db, ctx.principal);
        if (principal === null) throw new ServeError("unknown_agent", "unknown agent");
        const ns = worldNamespace(ctx.db, principal);
        const index = canon.length === 0 ? undefined : loadCanon({ ...ctx, principal });
        return {
          schema: ENVELOPE_V2_SCHEMA,
          tool,
          principal: issueWorldRef(ctx.db, ns, "principal", ns.principalId),
          at,
          canon: canon.map(chunk => projectCanonChunk({ ctx: { ...ctx, principal }, ns }, chunk, index)),
          quoted: quoted.map(chunk => {
            // world_view already has a closed evidence expansion contract.
            // Preserve it rather than dropping its bounded span metadata.
            if (tool === "world_view") {
              const source = chunk as WorldEvidenceSource;
              return { evidence: source.evidence, text: source.text, tainted: true,
                integrity: source.integrity, slice_integrity: source.slice_integrity,
                offset: source.offset, returned: source.returned, total: source.total,
                truncated: source.truncated === true };
            }
            return projectQuotedChunk({ ctx: { ...ctx, principal }, ns }, chunk);
          }),
          data: projectToolData({ ctx: { ...ctx, principal }, ns }, tool, data, message),
        };
      })
      .immediate();
  } catch (error) {
    if (error instanceof ServeError || !isLedgerBusy(error)) throw error;
    throw ledgerBusyServeError(error);
  }
}
