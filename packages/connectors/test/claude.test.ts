import { describe, expect, test } from "bun:test";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  KizukiError,
  parseClaudeExport,
} from "../src";

const OBSERVED_AT = "2026-04-01T12:00:00.000Z";

const INLINE_EXPORT = [
  {
    uuid: "conversation-42",
    name: "Inline fixture",
    created_at: "2026-03-01T08:00:00-05:00",
    chat_messages: [
      {
        uuid: "message-2",
        sender: "assistant",
        text: "An answer",
        created_at: "2026-03-01T08:00:02-05:00",
      },
      {
        uuid: "message-1",
        sender: "human",
        text: "A question",
        created_at: "2026-03-01T08:00:01-05:00",
      },
    ],
  },
];

describe("parseClaudeExport", () => {
  test("parses messages in deterministic export order", () => {
    const events = parseClaudeExport(JSON.stringify(INLINE_EXPORT), OBSERVED_AT);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.source_record_id)).toEqual([
      "conversation-42/message-2",
      "conversation-42/message-1",
    ]);
    expect(events.map((event) => event.subjects[0]?.subject_id)).toEqual([
      "claude:assistant",
      "claude:self",
    ]);
    expect(events.map((event) => event.text)).toEqual([
      "An answer",
      "A question",
    ]);
    expect(events.map((event) => event.occurred_at)).toEqual([
      "2026-03-01T13:00:02.000Z",
      "2026-03-01T13:00:01.000Z",
    ]);
    expect(events.every((event) => event.observed_at === OBSERVED_AT)).toBe(
      true,
    );
    expect(events.every((event) => event.connector_id === CLAUDE_IMPORT_CONNECTOR_ID)).toBe(
      true,
    );
    expect(events.map((event) => event.metadata["handle"])).toEqual([
      "assistant",
      "self",
    ]);
  });

  test("wraps malformed JSON in a parse_error", () => {
    try {
      parseClaudeExport("{not json", OBSERVED_AT);
      throw new Error("expected parseClaudeExport to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(KizukiError);
      if (!(error instanceof KizukiError)) return;
      expect(error.code).toBe("parse_error");
    }
  });
});
