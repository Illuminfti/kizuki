import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  KizukiError,
  createClaudeImportConnector,
  parseClaudeExport,
} from "../src";
import { encodeSourceRecordId } from "../src/source-id";

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
    const result = parseClaudeExport(JSON.stringify(INLINE_EXPORT), OBSERVED_AT);

    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.source_record_id)).toEqual([
      encodeSourceRecordId(["conversation-42", "message-2"]),
      encodeSourceRecordId(["conversation-42", "message-1"]),
    ]);
    expect(result.events.map((event) => event.subjects[0]?.subject_id)).toEqual([
      "claude:assistant",
      "claude:self",
    ]);
    expect(result.events.map((event) => event.text)).toEqual([
      "An answer",
      "A question",
    ]);
    expect(result.events.map((event) => event.occurred_at)).toEqual([
      "2026-03-01T13:00:02.000Z",
      "2026-03-01T13:00:01.000Z",
    ]);
    expect(
      result.events.every((event) => event.observed_at === OBSERVED_AT),
    ).toBe(true);
    expect(
      result.events.every(
        (event) => event.connector_id === CLAUDE_IMPORT_CONNECTOR_ID,
      ),
    ).toBe(true);
    expect(result.events.map((event) => event.metadata["handle"])).toEqual([
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

  test("uses one explicit malformed-record policy", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        "nope",
        { name: "Missing uuid", chat_messages: [] },
        {
          uuid: "c1",
          chat_messages: [
            "skip-me",
            {
              uuid: "m1",
              sender: "tool",
              text: "ignored",
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              uuid: "m2",
              sender: "human",
              text: "   ",
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toEqual([]);
    expect(result.errors.map((error) => error.code).sort()).toEqual([
      "empty_content",
      "missing_id",
      "not_object",
      "not_object",
      "unsupported_sender",
    ]);
  });

  test("collision-proof ids distinguish slash-containing pairs", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "a/b",
          chat_messages: [
            {
              uuid: "c",
              sender: "human",
              text: "one",
              created_at: "2026-01-01T00:00:00Z",
            },
          ],
        },
        {
          uuid: "a",
          chat_messages: [
            {
              uuid: "b/c",
              sender: "human",
              text: "two",
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.errors).toEqual([]);
    expect(result.events[0]?.source_record_id).not.toBe(
      result.events[1]?.source_record_id,
    );
  });

  test("accounts for attachments and unsupported blocks", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          chat_messages: [
            {
              uuid: "m1",
              sender: "human",
              text: "look",
              created_at: "2026-01-01T00:00:00Z",
              content: [
                { type: "text", text: "look" },
                { type: "tool_use", name: "search" },
              ],
              attachments: [
                { file_name: "note.pdf", file_size: 4, file_type: "application/pdf" },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.attachments).toEqual([
      {
        attachment_id: "note.pdf",
        media_type: "application/pdf",
        filename: "note.pdf",
        byte_size: 4,
      },
    ]);
    expect(result.errors.map((error) => error.code)).toEqual([
      "unsupported_part",
    ]);
  });

  test("fallback ids are stable under reordering", () => {
    const message = {
      sender: "human",
      text: "hello",
      created_at: "2026-01-01T00:00:00Z",
    };
    const first = parseClaudeExport(
      JSON.stringify([{ name: "A", chat_messages: [message] }]),
      OBSERVED_AT,
    );
    const second = parseClaudeExport(
      JSON.stringify([{ name: "A", chat_messages: [message] }]),
      OBSERVED_AT,
    );
    expect(first.events[0]?.source_record_id).toBe(
      second.events[0]?.source_record_id,
    );
    expect(first.errors.some((error) => error.code === "missing_id")).toBe(true);
  });
});

describe("ClaudeImportConnector", () => {
  test("health probes the export and refuses a non-array", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, '{"uuid":"x"}\n');
      const report = await createClaudeImportConnector({ path: file }).health();
      expect(report.state).toBe("misconfigured");
      expect(report.detail ?? "").not.toContain(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sync tombstones a message removed from a later export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, JSON.stringify(INLINE_EXPORT));
      const connector = createClaudeImportConnector({ path: file });
      const first = await connector.backfill(null);
      expect(first.events).toHaveLength(2);

      await writeFile(
        file,
        JSON.stringify([
          {
            uuid: "conversation-42",
            chat_messages: [INLINE_EXPORT[0]?.chat_messages[1]],
          },
        ]),
      );
      const second = await connector.sync(first.cursor);
      expect(
        second.events
          .filter((event) => event.deleted)
          .map((event) => event.source_record_id),
      ).toEqual([encodeSourceRecordId(["conversation-42", "message-2"])]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
