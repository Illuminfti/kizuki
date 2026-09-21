import type { CaptureEvent } from "../contracts/event";
import { rawSubjectRefKey, type QualifiedSuppliedRef } from "../contracts/claim-v2";
import { MAX_V2_QUOTED_UTF16, MAX_V2_TRUSTED_REFS, type ProducerV2SuppliedRef, type TextAnchor } from "../contracts/producer-v2";

const word = /[\p{L}\p{N}_]/u;

/** One exact, whole occurrence. Ambiguous or normalized names confer nothing. */
function uniqueSpan(text: string, token: string): { start: number; end: number } | null {
  if (!token || token.trim() !== token) return null;
  const start = text.indexOf(token);
  if (start < 0 || text.indexOf(token, start + 1) >= 0) return null;
  const end = start + token.length;
  const before = Array.from(text.slice(Math.max(0, start - 2), start)).at(-1) ?? "";
  const after = Array.from(text.slice(end, end + 2))[0] ?? "";
  const first = Array.from(token.slice(0, 2))[0]!, last = Array.from(token.slice(-2)).at(-1)!;
  if ((word.test(first) && word.test(before)) || (word.test(last) && word.test(after))) return null;
  return { start, end };
}

/**
 * Identity comes only from an immutable event's structured subject tuple and its
 * source namespace. Text supplies the citation, never an identity merge. Handles
 * are local ordinals in this request; no durable subject identifier leaves Core.
 */
export function worldSuppliedReferences(
  events: readonly Pick<CaptureEvent, "event_id" | "connector_id" | "text" | "subjects">[],
  sourceKey: (eventId: string) => string | null,
): { input: readonly ProducerV2SuppliedRef[]; refs: ReadonlyMap<string, QualifiedSuppliedRef> } {
  const qualified = new Map<string, { ref: QualifiedSuppliedRef; anchors: TextAnchor[] }>();
  for (const event of events) {
    // The producer planner refuses this event. Do not scan its subject tuples.
    if (event.text.length > MAX_V2_QUOTED_UTF16) continue;
    const source_key = sourceKey(event.event_id);
    if (source_key === null) continue;
    const tokens = new Map<string, Set<string>>();
    const subjects = new Map<string, Set<string>>();
    for (const subject of event.subjects) {
      const candidates = subjects.get(subject.subject_id) ?? new Set<string>();
      candidates.add(subject.subject_id);
      if (subject.display_name) candidates.add(subject.display_name);
      subjects.set(subject.subject_id, candidates);
      for (const token of candidates) {
        const owners = tokens.get(token) ?? new Set<string>();
        owners.add(subject.subject_id); tokens.set(token, owners);
      }
    }
    for (const id of [...subjects.keys()].sort()) {
      const candidates = [id, ...[...subjects.get(id)!].filter(token => token !== id).sort()];
      const span = candidates.flatMap(token => {
        const match = tokens.get(token)?.size === 1 ? uniqueSpan(event.text, token) : null;
        return match === null ? [] : [match];
      })[0];
      if (span === undefined) continue;
      const ref: QualifiedSuppliedRef = { kind: "supplied", id, namespace: { connector_id: event.connector_id, source_key } };
      const key = rawSubjectRefKey(ref), existing = qualified.get(key);
      const anchor = { event_id: event.event_id, start_utf16: span.start, end_utf16: span.end };
      if (existing) {
        // At most one witness per event and eight quoted events per request.
        if (existing.anchors.length < 8) existing.anchors.push(anchor);
      } else if (qualified.size < MAX_V2_TRUSTED_REFS) qualified.set(key, { ref, anchors: [anchor] });
    }
  }
  const refs = new Map<string, QualifiedSuppliedRef>();
  const input = [...qualified.values()].map((value, index) => {
    const id = `s${index}`;
    refs.set(id, value.ref);
    return { id, anchors: value.anchors };
  });
  return { input, refs };
}
