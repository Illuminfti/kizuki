import { readClaimV2Semantic } from "../../claims/claim-v2-commit";
import { referenceScope } from "../../world/ref-kinds/common";
import { issueClaimRef, readableClaim } from "../../world/ref-kinds/claim";
import { issueWorldRef } from "../../world/references";
import { loadCanon } from "../canon";
import type { Piece } from "../candidates";
import { redactorOf } from "../redact";
import type { ServeContext } from "../types";
import { projectCanonChunk, projectQuotedChunk } from "./chunks";
import { canonBlockV2, quotedBlockV2, claimBlockV2 } from "./packet-render";

export function packetPrincipal(ctx: ServeContext): string {
  return ctx.db.transaction(() => {
    const scope = referenceScope(ctx);
    return issueWorldRef(ctx.db, scope.ns, "principal", scope.ns.principalId).token;
  }).immediate();
}
/** Render from authorized structured pieces before packing or hashing. Literal
 * evidence stays quoted. A v1 generated line is never scrubbed by regex. */
export function scopePacketPieces(ctx: ServeContext, pieces: readonly Piece[]): Piece[] {
  return ctx.db.transaction(() => {
    const scope = referenceScope(ctx), redactor = redactorOf(ctx);
    const index = pieces.some(piece => piece.canon !== undefined) ? loadCanon(ctx) : undefined;
    return pieces.flatMap(piece => {
      if (piece.canon !== undefined) {
        const scopedCanon = projectCanonChunk(scope, piece.canon, index);
        return [{ ...piece, scopedCanon, block: canonBlockV2(scopedCanon, redactor) }];
      }
      if (piece.quoted !== undefined) return [{ ...piece, block: quotedBlockV2(projectQuotedChunk(scope, piece.quoted), redactor) }];
      if (piece.placeholder === true) return [piece];
      const claims = piece.claims ?? [];
      if (claims.length === 0) return [];
      const lines: string[] = [];
      for (const stamp of claims) {
        const claim = readableClaim(scope, stamp.id), ref = issueClaimRef(scope, stamp.id);
        if (claim === null || ref === null) return [];
        const semantic = readClaimV2Semantic(ctx.db, claim.claim_id);
        const qualifier = semantic?.discriminator === "assertion" ? `mode=${semantic.perspective.mode} interpretation=${semantic.perspective.interpretation} polarity=${semantic.polarity}` : `polarity=${claim.polarity}`;
        const value = semantic?.discriminator === "assertion"
          ? semantic.object.kind === "literal" ? semantic.object.value : semantic.object.kind === "vocabulary" ? semantic.object.ref.id : "linked item"
          : claim.object ?? claim.body;
        lines.push(claimBlockV2(ref, `${claim.predicate ?? "claim"}: ${value}\n${qualifier}; authority=${claim.authority}; confidence=${claim.confidence}; status=${claim.status}`, redactor));
      }
      const label = piece.heading === "## counterevidence" ? "- These claims include a conflict or a validity gap.\n" : "";
      return [{ ...piece, block: label + lines.join("") }];
    });
  }).immediate();
}
