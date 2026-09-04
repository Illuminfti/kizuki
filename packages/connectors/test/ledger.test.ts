import { expect, test } from "bun:test";
import { InMemoryLedger } from "../src/testkit";
import { CHATGPT_IMPORT_CONNECTOR_ID } from "../src";

function sampleEvent(text: string) {
  return {
    schema: "kizuki.event/v1" as const,
    connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
    source_record_id: "v1:1:4:node",
    kind: "message",
    occurred_at: "2026-01-01T00:00:00.000Z",
    observed_at: "2026-01-01T00:00:00.000Z",
    text,
    subjects: [{ subject_id: "chatgpt:self", role: "from" as const }],
    deleted: false,
    attachments: [],
    metadata: {},
  };
}

test("stored events are frozen copies of the core ledger row", () => {
  const ledger = new InMemoryLedger();
  const stored = ledger.accept(sampleEvent("hello"));
  expect(stored.status).toBe("stored");
  if (stored.status !== "stored") return;
  expect(Object.isFrozen(stored.event)).toBe(true);
  try {
    (stored.event as { text: string }).text = "mutated";
  } catch {
    // freeze may throw in strict mode
  }
  expect(ledger.events()[0]?.text).toBe("hello");
  const again = ledger.accept(sampleEvent("hello"));
  expect(again.status).toBe("duplicate");
});
