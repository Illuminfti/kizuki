import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  KizukiError,
  createChatGptImportConnector,
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

  test("Claude sync rejects a ChatGPT snapshot cursor without changing its own resume state", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-foreign-"));
    try {
      const chatgptFile = path.join(root, "chatgpt.json");
      const claudeFile = path.join(root, "claude.json");
      await writeFile(
        chatgptFile,
        JSON.stringify([
          {
            id: "conversation-foreign",
            mapping: {
              n: {
                message: {
                  author: { role: "user" },
                  content: { parts: ["foreign-cursor-fixture"] },
                  create_time: 1_700_000_000,
                },
              },
            },
          },
        ]),
      );
      await writeFile(claudeFile, JSON.stringify(INLINE_EXPORT));
      const chatgptCursor = (
        await createChatGptImportConnector({ path: chatgptFile }).backfill(null)
      ).cursor;
      expect(typeof chatgptCursor).toBe("string");
      const claude = createClaudeImportConnector({ path: claudeFile });
      const own = await claude.backfill(null);
      expect(own.events.length).toBeGreaterThan(0);
      try {
        await claude.sync(chatgptCursor);
        throw new Error("expected Claude sync to reject a ChatGPT cursor");
      } catch (error) {
        expect(error).toBeInstanceOf(KizukiError);
        if (!(error instanceof KizukiError)) return;
        expect(error.code).toBe("parse_error");
        expect(error.message).toContain("snapshot cursor does not match this source");
        expect(error.message).not.toContain(chatgptFile);
        expect(error.message).not.toContain(claudeFile);
        expect(error.message).not.toContain("foreign-cursor-fixture");
      }
      const resume = await claude.sync(own.cursor);
      expect(resume.events).toEqual([]);
      expect(resume.cursor).toBe(own.cursor);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an export that drops uuids does not tombstone the prior records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, JSON.stringify(INLINE_EXPORT));
      const connector = createClaudeImportConnector({ path: file });
      const first = await connector.backfill(null);
      const priorIds = first.events.map((event) => event.source_record_id);

      await writeFile(
        file,
        JSON.stringify([
          {
            name: "Inline fixture",
            created_at: "2026-03-01T08:00:00-05:00",
            chat_messages: INLINE_EXPORT[0]?.chat_messages.map((message) => ({
              sender: message?.sender,
              text: message?.text,
              created_at: message?.created_at,
            })),
          },
        ]),
      );
      const second = await connector.sync(first.cursor);
      expect(second.events.some((event) => event.deleted)).toBe(false);
      const cursor = JSON.parse(second.cursor ?? "{}") as {
        records: Array<[string, string]>;
      };
      expect(priorIds.every((id) => cursor.records.some(([kept]) => kept === id))).toBe(
        true,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("export fidelity", () => {
  test("a sender is the author; text that quotes another voice stays with its sender", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          name: "Quoting",
          chat_messages: [
            {
              uuid: "m1",
              sender: "human",
              text: "Assistant: you said \"On the owner's disk.\" Why?",
              created_at: "2026-01-01T00:00:01Z",
            },
            {
              uuid: "m2",
              sender: "assistant",
              text: "Human: you asked where. Because it stays yours.",
              created_at: "2026-01-01T00:00:02Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.errors).toEqual([]);
    expect(
      result.events.map((event) => [
        event.metadata["handle"],
        event.subjects.map((subject) => `${subject.subject_id}:${subject.role}`),
        event.text,
      ]),
    ).toEqual([
      ["self", ["claude:self:from"], "Assistant: you said \"On the owner's disk.\" Why?"],
      [
        "assistant",
        ["claude:assistant:from"],
        "Human: you asked where. Because it stays yours.",
      ],
    ]);
    for (const event of result.events) {
      expect(event.sensitivity_hint).toBeUndefined();
    }
  });

  test("a content block repeating the message text is not stored twice", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          chat_messages: [
            {
              uuid: "m1",
              sender: "assistant",
              text: "Answer",
              created_at: "2026-01-01T00:00:01Z",
              content: [
                { type: "text", text: "Answer" },
                { type: "text", text: "Footnote" },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.errors).toEqual([]);
    expect(result.events[0]?.text).toBe("Answer\nFootnote");
  });

  test("a sender outside human or assistant is reported and not stored", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          chat_messages: [
            {
              uuid: "m1",
              sender: "system",
              text: "hidden",
              created_at: "2026-01-01T00:00:01Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ location: "c1[0]", code: "unsupported_sender" }),
    ]);
  });

  test("the same uuid repeated with different text is a conflict, not a version", () => {
    const message = (text: string) => ({
      uuid: "m1",
      sender: "human",
      text,
      created_at: "2026-01-01T00:00:01Z",
    });
    const result = parseClaudeExport(
      JSON.stringify([{ uuid: "c1", chat_messages: [message("one"), message("two")] }]),
      OBSERVED_AT,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("one");
    expect(result.errors).toEqual([
      expect.objectContaining({
        location: encodeSourceRecordId(["c1", "m1"]),
        code: "conflicting_id",
      }),
    ]);
  });

  test("nesting past the JSON depth bound is refused before any message is read", () => {
    const deep = "[".repeat(70) + "]".repeat(70);
    let thrown: unknown;
    try {
      parseClaudeExport(deep, OBSERVED_AT);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(KizukiError);
    expect((thrown as KizukiError).code).toBe("parse_error");
  });
});
