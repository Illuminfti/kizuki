import { describe, expect, test } from "bun:test";
import {
  CHATGPT_IMPORT_CONNECTOR_ID,
  KizukiError,
  parseChatGptExport,
} from "../src";

const OBSERVED_AT = "2026-04-01T12:00:00.000Z";

const INLINE_EXPORT = [
  {
    id: "conversation-42",
    title: "Inline fixture",
    create_time: 1_700_000_000,
    mapping: {
      "message-b": {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Line one", "Line two"] },
          create_time: 1_700_000_002,
        },
        parent: "message-a",
        children: [],
      },
      root: { parent: null, children: ["message-a"] },
      "message-a": {
        message: {
          author: { role: "user" },
          content: { parts: ["A question"] },
          create_time: 1_700_000_001,
        },
        parent: "root",
        children: ["message-b"],
      },
    },
  },
];

describe("parseChatGptExport", () => {
  test("parses messages in deterministic node order", () => {
    const events = parseChatGptExport(
      JSON.stringify(INLINE_EXPORT),
      OBSERVED_AT,
    );

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.source_record_id)).toEqual([
      "conversation-42/message-a",
      "conversation-42/message-b",
    ]);
    expect(events.map((event) => event.subjects[0]?.subject_id)).toEqual([
      "chatgpt:self",
      "chatgpt:assistant",
    ]);
    expect(events.map((event) => event.text)).toEqual([
      "A question",
      "Line one\nLine two",
    ]);
    expect(events.map((event) => event.occurred_at)).toEqual([
      "2023-11-14T22:13:21.000Z",
      "2023-11-14T22:13:22.000Z",
    ]);
    expect(events.every((event) => event.observed_at === OBSERVED_AT)).toBe(
      true,
    );
    expect(events.every((event) => event.connector_id === CHATGPT_IMPORT_CONNECTOR_ID)).toBe(
      true,
    );
    expect(events.map((event) => event.metadata["handle"])).toEqual([
      "self",
      "assistant",
    ]);
  });

  test("wraps malformed JSON in a parse_error", () => {
    try {
      parseChatGptExport("{not json", OBSERVED_AT);
      throw new Error("expected parseChatGptExport to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(KizukiError);
      if (!(error instanceof KizukiError)) return;
      expect(error.code).toBe("parse_error");
    }
  });
});
