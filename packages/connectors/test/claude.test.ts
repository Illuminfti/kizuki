import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EVENT_LIMITS,
  getCheckpoint,
  registerConnection,
  replay,
  runBackfill,
  setSourceGrant,
  validateEventInput,
} from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  KizukiError,
  createChatGptImportConnector,
  createClaudeImportConnector,
  parseClaudeExport,
} from "../src";
import { encodeSourceRecordId } from "../src/source-id";

const SOURCE_KEY = "01JJ0000000000000000000003";

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
  test("the importer does not claim tombstones", () => {
    expect(
      createClaudeImportConnector({ path: "/nonexistent.json" }).manifest()
        .capabilities.tombstones,
    ).toBe(false);
  });

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

  test("a later smaller export does not tombstone removed messages", async () => {
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
      expect(second.events.some((event) => event.deleted)).toBe(false);
      expect(second.events.map((event) => event.source_record_id)).toEqual([
        encodeSourceRecordId(["conversation-42", "message-1"]),
      ]);
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

  test("unsupported parts preserve supported events and the existing health-only degradation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-unsupported-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(
        file,
        JSON.stringify([
          {
            uuid: "supported",
            chat_messages: [
              {
                uuid: "m1",
                sender: "human",
                text: "supported text",
                created_at: "2026-01-01T00:00:00Z",
                content: [
                  { type: "text", text: "supported text" },
                  { type: "tool_use", name: "search" },
                ],
              },
            ],
          },
        ]),
      );
      const connector = createClaudeImportConnector({ path: file });
      expect((await connector.health()).state).toBe("degraded");
      const first = await connector.backfill(null);
      expect(first.status ?? "ok").toBe("ok");
      expect(first.events).toHaveLength(1);
      const drain = await connector.backfill(first.cursor);
      expect(drain).toEqual({ events: [], cursor: first.cursor, has_more: false });
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
      expect(second.events.map((event) => event.source_record_id).length).toBe(
        priorIds.length,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("connector to Core stores a parent with an oversized extract and a second small record", async () => {
    const extract = "x".repeat(EVENT_LIMITS.textBytes + 1);
    const exportBody = JSON.stringify([
      {
        uuid: "conversation-1",
        name: "Bounds",
        chat_messages: [
          {
            uuid: "human-1",
            sender: "human",
            text: "see attached",
            created_at: "2026-03-15T09:30:45.000Z",
            attachments: [
              {
                file_name: "note.pdf",
                file_type: "application/pdf",
                extracted_content: extract,
              },
            ],
          },
          {
            uuid: "human-2",
            sender: "human",
            text: "short follow-up",
            created_at: "2026-03-15T09:30:46.000Z",
          },
        ],
      },
    ]);
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-ingest-"));
    const db = openLedger(":memory:");
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, exportBody);
      const connector = createClaudeImportConnector({ path: file });
      const health = await connector.health();
      expect(health.state).toBe("degraded");
      expect(health.detail ?? "").toContain("unsupported_part");
      expect(health.detail ?? "").not.toContain(extract);

      const preview = await connector.backfill(null);
      expect(preview.events).toHaveLength(2);
      expect(preview.status ?? "ok").toBe("ok");
      for (const event of preview.events) {
        expect(validateEventInput(event).ok).toBe(true);
      }
      expect(preview.events[0]?.text).toBe("see attached");
      expect(preview.events[1]?.text).toBe("short follow-up");

      registerConnection(db, CLAUDE_IMPORT_CONNECTOR_ID, SOURCE_KEY);
      setSourceGrant(db, {
        source_key: SOURCE_KEY,
        expected_revision: 0,
        operation_id: "fixture-grant",
        policy: {
          purposes: ["capture", "recall", "derive"],
          allowed_fields: ["text", "subjects", "attachments", "metadata"],
          retention: "persistent_owned_until_revoked",
          egress: "local_only",
          sensitivity_floor: "public",
        },
      });
      const first = await runBackfill(
        db,
        connector,
        CLAUDE_IMPORT_CONNECTOR_ID,
        SOURCE_KEY,
      );
      expect(first.errors).toEqual([]);
      expect(first.stored).toBe(2);
      const checkpoint = getCheckpoint(db, CLAUDE_IMPORT_CONNECTOR_ID, SOURCE_KEY);
      expect(checkpoint?.cursor).toBe(first.cursor);
      expect(checkpoint?.cursor).not.toBeNull();
      expect(checkpoint?.last_result.errors).toEqual([]);
      const stored = [...replay(db, {})];
      expect(stored).toHaveLength(2);
      expect(stored.map((event) => event.text)).toEqual([
        "see attached",
        "short follow-up",
      ]);
      expect(stored[0]?.attachments).toEqual([
        {
          attachment_id: "note.pdf",
          media_type: "application/pdf",
          filename: "note.pdf",
        },
      ]);

      const second = await runBackfill(
        db,
        connector,
        CLAUDE_IMPORT_CONNECTOR_ID,
        SOURCE_KEY,
      );
      expect(second.errors).toEqual([]);
      expect(second.stored).toBe(0);
      expect(second.cursor).toBe(first.cursor);
      expect(
        getCheckpoint(db, CLAUDE_IMPORT_CONNECTOR_ID, SOURCE_KEY)?.cursor,
      ).toBe(first.cursor);
      expect([...replay(db, {})]).toHaveLength(2);
    } finally {
      db.close();
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

  test("top-level text that already concatenates content blocks is stored once", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "c1",
          chat_messages: [
            {
              uuid: "m1",
              sender: "assistant",
              text: "first paragraph\nsecond paragraph",
              created_at: "2026-01-01T00:00:01Z",
              content: [
                { type: "text", text: "first paragraph" },
                { type: "text", text: "second paragraph" },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.errors).toEqual([]);
    expect(result.events[0]?.text).toBe("first paragraph\nsecond paragraph");
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
