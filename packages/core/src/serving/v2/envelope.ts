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
>(ctx: ServeContext, tool: K, at: string, canon: C, quoted: Q, data: T): EnvelopeV2<T, K, C, Q> {
  try {
    return ctx.db
      .transaction((): EnvelopeV2<T, K, C, Q> => {
        const principal = resolvePrincipal(ctx.db, ctx.principal);
        if (principal === null) throw new ServeError("unknown_agent", "unknown agent");
        const ns = worldNamespace(ctx.db, principal);
        return {
          schema: ENVELOPE_V2_SCHEMA,
          tool,
          principal: issueWorldRef(ctx.db, ns, "principal", ns.principalId),
          at,
          canon,
          quoted,
          data,
        };
      })
      .immediate();
  } catch (error) {
    if (error instanceof ServeError || !isLedgerBusy(error)) throw error;
    throw ledgerBusyServeError(error);
  }
}
