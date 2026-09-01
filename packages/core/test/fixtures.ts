import type { CaptureEventInput } from "../src/contracts/event";

export function validEvent(): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: "fixture",
    source_record_id: "rec-1",
    kind: "message",
    occurred_at: "2026-02-28T10:30:00Z",
    observed_at: "2026-03-01T00:00:00+05:30",
    text: "the kettle is on",
    subjects: [{ subject_id: "person:ada", role: "from", display_name: "Ada" }],
    sensitivity_hint: "personal",
    deleted: false,
    attachments: [
      { attachment_id: "att-1", media_type: "image/png", byte_size: 12 },
    ],
    metadata: { thread: "t-9", unread: true },
  };
}

/** Same event as a mutable bag, for building reject cases. */
export function rawEvent(): Record<string, unknown> {
  return validEvent() as unknown as Record<string, unknown>;
}
