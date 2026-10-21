import type { CanonChunkV2, QuotedChunkV2 } from "../../contracts/scoped-tools";
import type { ScopedRef } from "../../contracts/scoped-refs";
import { blockquote, oneLine, type Redactor } from "../redact";

export function canonBlockV2(chunk: CanonChunkV2, redactor: Redactor): string {
  const stamps = `s=${chunk.sensitivity} taint=${chunk.taint} auth=${chunk.authority ?? "none"}`;
  return redactor.format(chunk.excerpt, excerpt => `- [page-ref:${chunk.page.token}] ${stamps} :: ${oneLine(chunk.title)}\n${blockquote(excerpt)}\n`);
}
export function quotedBlockV2(chunk: QuotedChunkV2, redactor: Redactor): string {
  return redactor.format(chunk.text, text => `- [event-version-ref:${chunk.eventVersion.token}] tainted ::\n${blockquote(text)}\n`);
}
/** Claim bodies are quoted source-backed prose. Structured raw subject/object
 * identifiers and legacy conflict keys never become generated packet labels. */
export function claimBlockV2(claim: ScopedRef<"claim">, body: string, redactor: Redactor): string {
  return redactor.format(body, text => `- [claim-ref:${claim.token}] quoted claim\n${blockquote(text)}\n`);
}
