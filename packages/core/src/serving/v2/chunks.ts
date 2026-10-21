import type { CanonChunkV2, QuotedChunkV2 } from "../../contracts/scoped-tools";
import { eventIdFromReference } from "../../retrieval/ids";
import { issueEventVersionRef } from "../../world/ref-kinds/evidence";
import { issuePageRef } from "../../world/ref-kinds/page";
import { eventRawSubjectRefs } from "../../world/ref-kinds/raw-subject";
import { issueSourceRef } from "../../world/ref-kinds/source";
import { missingReference, type RefScope } from "../../world/ref-kinds/common";
import { loadCanon, type CanonIndex } from "../canon";
import type { CanonChunk, QuotedChunk } from "../types";

/** Construct each nested DTO from named fields. No legacy identity or label
 * attachment can be inherited by adding a field to a v1 chunk. */
export function projectCanonChunk(scope: RefScope, chunk: CanonChunk, index: CanonIndex = loadCanon(scope.ctx)): CanonChunkV2 {
  const page = issuePageRef(scope, chunk.page_id, index);
  if (page === null) throw missingReference();
  const sources = chunk.sources.map(eventIdFromReference).map(id => {
    const source = issueEventVersionRef(scope, id);
    if (source === null) throw missingReference();
    return source;
  });
  const subjects = new Map<string, ReturnType<typeof eventRawSubjectRefs>[number]>();
  for (const id of chunk.sources.map(eventIdFromReference)) {
    for (const subject of eventRawSubjectRefs(scope, id, chunk.subjects)) subjects.set(subject.token, subject);
  }
  return { page, title: chunk.title, type: chunk.type, sensitivity: chunk.sensitivity, taint: chunk.taint,
    authority: chunk.authority, subjects: [...subjects.values()].sort((a, b) => a.token.localeCompare(b.token)), sources,
    excerpt: chunk.excerpt, truncated: chunk.truncated };
}
export function projectQuotedChunk(scope: RefScope, chunk: QuotedChunk): QuotedChunkV2 {
  const eventVersion = issueEventVersionRef(scope, chunk.event_id), source = issueSourceRef(scope, chunk.event_id);
  if (eventVersion === null || source === null) throw missingReference();
  return { eventVersion, source, kind: chunk.kind, occurred: { kind: "known", from: chunk.occurred_at, until: null },
    sensitivity: chunk.sensitivity, subjects: eventRawSubjectRefs(scope, chunk.event_id, chunk.subjects), text: chunk.text, tainted: true };
}
