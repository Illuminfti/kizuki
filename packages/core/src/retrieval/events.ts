import type { CaptureEvent } from "../contracts/event";
import { validateRetrievalDoc } from "../contracts/retrieval";
import type { RetrievalDoc, RetrievalPort } from "../contracts/retrieval";
import { retrievalDocId } from "./ids";

function eventSensitivity(event: CaptureEvent): RetrievalDoc["sensitivity"] {
  const hint = event.sensitivity_hint;
  return hint === "public" || hint === "personal" || hint === "private" ? hint : null;
}

/** Ledger event as a v1 retrieval document. Tombstones are not documents. */
export function eventRetrievalDoc(event: CaptureEvent): RetrievalDoc {
  return validateRetrievalDoc({
    doc_id: retrievalDocId("event", event.event_id),
    kind: "event",
    title: event.connector_id,
    text: event.text,
    sensitivity: eventSensitivity(event),
    taint: "quoted",
    authority: "connector_evidence",
    subjects: event.subjects.map(({ subject_id }) => subject_id),
    provenance: [event.event_id],
    occurred_at: event.occurred_at,
    updated_at: event.observed_at,
  });
}

/** Publish or withdraw one ledger event through the bound retrieval port. */
export async function publishLedgerEvent(
  port: RetrievalPort,
  event: CaptureEvent,
): Promise<void> {
  const docId = retrievalDocId("event", event.event_id);
  if (event.deleted) {
    await port.remove([docId]);
    return;
  }
  await port.upsert([eventRetrievalDoc(event)]);
}
