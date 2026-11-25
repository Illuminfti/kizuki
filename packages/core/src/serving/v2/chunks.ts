import type { CanonChunkV2, QuotedChunkV2 } from "../../contracts/scoped-tools";
import { eventIdFromReference } from "../../retrieval/ids";
import { issueEventVersionRef } from "../../world/ref-kinds/evidence";
import { issuePageRef } from "../../world/ref-kinds/page";
import { eventRawSubjectRefs, prepareEventRawSubjects } from "../../world/ref-kinds/raw-subject";
import { issueSourceRef } from "../../world/ref-kinds/source";
import { missingReference, type RefScope } from "../../world/ref-kinds/common";
import { loadCanon, type CanonIndex } from "../canon";
import type { CanonChunk, QuotedChunk } from "../types";

/**
 * Issue, ahead of projecting these chunks in this transaction, the event and
 * source references they will name and then every subject, in one membership
 * pass per source. The projection issues each again and finds it issued, so it
 * writes nothing in between and its subject answers stay valid. A reference
 * that cannot be issued here fails the projection exactly as before.
 */
export function prepareChunkReferences(scope: RefScope, canon: readonly CanonChunk[], quoted: readonly QuotedChunk[]): void {
  if (canon.length === 0 && quoted.length === 0) return;
  const issuedEvents = new Set<string>();
  const issuedSources = new Set<string>();
  const rawSubjectInputs: { eventId: string; ids: readonly string[] }[] = [];
  for (const chunk of canon) {
    const seenChunkSources = new Set<string>();
    for (const rawSource of chunk.sources) {
      const id = eventIdFromReference(rawSource);
      if (!issuedEvents.has(id)) {
        issuedEvents.add(id);
        issueEventVersionRef(scope, id);
      }
      if (!seenChunkSources.has(id)) {
        seenChunkSources.add(id);
        rawSubjectInputs.push({ eventId: id, ids: chunk.subjects });
      }
    }
  }
  for (const chunk of quoted) {
    if (!issuedEvents.has(chunk.event_id)) {
      issuedEvents.add(chunk.event_id);
      issueEventVersionRef(scope, chunk.event_id);
    }
    if (!issuedSources.has(chunk.event_id)) {
      issuedSources.add(chunk.event_id);
      issueSourceRef(scope, chunk.event_id);
    }
    rawSubjectInputs.push({ eventId: chunk.event_id, ids: chunk.subjects });
  }
  prepareEventRawSubjects(scope, rawSubjectInputs);
}
/** Construct each nested DTO from named fields. No legacy identity or label
 * attachment can be inherited by adding a field to a v1 chunk. */
export function projectCanonChunk(scope: RefScope, chunk: CanonChunk, index: CanonIndex = loadCanon(scope.ctx)): CanonChunkV2 {
  const page = issuePageRef(scope, chunk.page_id, index);
  if (page === null) throw missingReference();
  const sourceIds = chunk.sources.map(eventIdFromReference);
  const sources = sourceIds.map(id => {
    const source = issueEventVersionRef(scope, id);
    if (source === null) throw missingReference();
    return source;
  });
  const subjects = new Map<string, ReturnType<typeof eventRawSubjectRefs>[number]>();
  const seenSources = new Set<string>();
  for (const id of sourceIds) {
    if (seenSources.has(id)) continue;
    seenSources.add(id);
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
