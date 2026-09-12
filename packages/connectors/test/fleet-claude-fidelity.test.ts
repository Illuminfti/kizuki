import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EVENT_LIMITS,
  MAX_SYNC_BATCH_BYTES,
  validateEventInput,
  type CaptureEventInput,
} from "@kizuki/core";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  createClaudeImportConnector,
  parseClaudeExport,
} from "../src";
import { encodeSourceRecordId } from "../src/source-id";

const OBSERVED_AT = "2026-06-15T18:00:00.000Z";

/** Core stamps identity and origin; connector ingress must not. */
const CORE_STAMPS = [
  "event_id",
  "content_hash",
  "content_hash_version",
  "text_hash",
  "origin",
  "origin_binding_version",
  "origin_binding_kind",
  "origin_binding",
] as const;

function assertIngressOnly(event: CaptureEventInput): void {
  expect(validateEventInput(event).ok).toBe(true);
  for (const key of CORE_STAMPS) {
    expect(key in event).toBe(false);
  }
}

describe("Claude export attribution fidelity", () => {
  test("message identity is the conversation and message uuids, not title text or time", () => {
    const message = {
      uuid: "message-1",
      sender: "human",
      text: "first wording",
      created_at: "2026-02-01T00:00:00.000Z",
    };
    const first = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          name: "Alpha",
          created_at: "2026-01-01T00:00:00.000Z",
          chat_messages: [message],
        },
      ]),
      OBSERVED_AT,
    );
    const renamed = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          name: "Beta",
          created_at: "2026-01-02T00:00:00.000Z",
          chat_messages: [
            {
              ...message,
              text: "second wording",
              created_at: "2026-02-02T00:00:00.000Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    const otherConversation = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-2",
          name: "Alpha",
          created_at: "2026-01-01T00:00:00.000Z",
          chat_messages: [message],
        },
      ]),
      OBSERVED_AT,
    );

    expect(first.errors).toEqual([]);
    expect(renamed.errors).toEqual([]);
    expect(otherConversation.errors).toEqual([]);
    expect(first.events[0]?.source_record_id).toBe(
      encodeSourceRecordId(["conversation-1", "message-1"]),
    );
    expect(renamed.events[0]?.source_record_id).toBe(
      first.events[0]?.source_record_id,
    );
    expect(otherConversation.events[0]?.source_record_id).toBe(
      encodeSourceRecordId(["conversation-2", "message-1"]),
    );
    expect(otherConversation.events[0]?.source_record_id).not.toBe(
      first.events[0]?.source_record_id,
    );
  });

  test("human and assistant senders keep role, handle, and conversation title", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          name: "Local memory",
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
          account: { uuid: "account-1" },
          chat_messages: [
            {
              uuid: "human-1",
              sender: "human",
              name: "not-a-quoted-author",
              text: "Where should the data live?",
              created_at: "2026-03-15T09:30:45.123Z",
              updated_at: "2026-03-15T09:31:00.000Z",
              files: [],
            },
            {
              uuid: "assistant-1",
              sender: "assistant",
              text: "On the owner's disk.",
              created_at: "2026-03-15T09:30:46.500Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );

    expect(result.errors).toEqual([]);
    for (const event of result.events) assertIngressOnly(event);
    expect(result.events).toEqual([
      {
        schema: "kizuki.event/v1",
        connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
        source_record_id: encodeSourceRecordId(["conversation-1", "human-1"]),
        kind: "message",
        occurred_at: "2026-03-15T09:30:45.123Z",
        observed_at: OBSERVED_AT,
        text: "Where should the data live?",
        subjects: [{ subject_id: "claude:self", role: "from" }],
        deleted: false,
        attachments: [],
        metadata: {
          handle: "self",
          namespace: "claude",
          conversation_title: "Local memory",
          unsupported_parts: [],
          export: "claude-conversations.json",
        },
      },
      {
        schema: "kizuki.event/v1",
        connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
        source_record_id: encodeSourceRecordId([
          "conversation-1",
          "assistant-1",
        ]),
        kind: "message",
        occurred_at: "2026-03-15T09:30:46.500Z",
        observed_at: OBSERVED_AT,
        text: "On the owner's disk.",
        subjects: [{ subject_id: "claude:assistant", role: "from" }],
        deleted: false,
        attachments: [],
        metadata: {
          handle: "assistant",
          namespace: "claude",
          conversation_title: "Local memory",
          unsupported_parts: [],
          export: "claude-conversations.json",
        },
      },
    ]);
  });

  test("occurred_at is the message created_at; missing or invalid stamps are refused", () => {
    const dated = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          name: "Thread",
          created_at: "2026-01-01T00:00:00.000Z",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "human",
              text: "dated",
              created_at: "2026-03-15T09:30:45.123Z",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(dated.errors).toEqual([]);
    expect(dated.events[0]?.occurred_at).toBe("2026-03-15T09:30:45.123Z");
    expect(dated.events[0]?.occurred_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(dated.events[0]?.occurred_at).not.toBe(OBSERVED_AT);
    expect(dated.events[0]?.observed_at).toBe(OBSERVED_AT);

    const missing = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            { uuid: "message-1", sender: "human", text: "no time" },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(missing.events).toEqual([]);
    expect(missing.errors.map((error) => error.code)).toEqual([
      "invalid_timestamp",
    ]);

    const invalid = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "human",
              text: "bad time",
              created_at: "not-a-date",
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(invalid.events).toEqual([]);
    expect(invalid.errors.map((error) => error.code)).toEqual([
      "invalid_timestamp",
    ]);
  });

  test("duplicate and conflicting message ids are reported, not collapsed", () => {
    const message = (text: string) => ({
      uuid: "message-1",
      sender: "human",
      text,
      created_at: "2026-02-01T00:00:00.000Z",
    });
    const exact = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [message("same"), message("same")],
        },
      ]),
      OBSERVED_AT,
    );
    expect(exact.events).toHaveLength(1);
    expect(exact.events[0]?.text).toBe("same");
    expect(exact.events[0]?.source_record_id).toBe(
      encodeSourceRecordId(["conversation-1", "message-1"]),
    );
    expect(exact.errors.map((error) => error.code)).toEqual(["duplicate_id"]);

    const conflict = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [message("left"), message("right")],
        },
      ]),
      OBSERVED_AT,
    );
    expect(conflict.events).toHaveLength(1);
    expect(conflict.events[0]?.text).toBe("left");
    expect(conflict.errors.map((error) => error.code)).toEqual([
      "conflicting_id",
    ]);
  });

  test("reordering conversations and messages keeps identities and follows export order", () => {
    const human = {
      uuid: "human-1",
      sender: "human",
      text: "question",
      created_at: "2026-03-15T09:30:45.000Z",
    };
    const assistant = {
      uuid: "assistant-1",
      sender: "assistant",
      text: "answer",
      created_at: "2026-03-15T09:30:46.000Z",
    };
    const later = {
      uuid: "human-2",
      sender: "human",
      text: "follow-up",
      created_at: "2026-03-16T09:00:00.000Z",
    };
    const forward = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-a",
          name: "First",
          chat_messages: [human, assistant],
        },
        { uuid: "conversation-b", name: "Second", chat_messages: [later] },
      ]),
      OBSERVED_AT,
    );
    const reversed = parseClaudeExport(
      JSON.stringify([
        { uuid: "conversation-b", name: "Second", chat_messages: [later] },
        {
          uuid: "conversation-a",
          name: "First",
          chat_messages: [assistant, human],
        },
      ]),
      OBSERVED_AT,
    );

    const idAHuman = encodeSourceRecordId(["conversation-a", "human-1"]);
    const idAAssistant = encodeSourceRecordId(["conversation-a", "assistant-1"]);
    const idBHuman = encodeSourceRecordId(["conversation-b", "human-2"]);

    expect(forward.errors).toEqual([]);
    expect(reversed.errors).toEqual([]);
    expect(forward.events.map((event) => event.source_record_id)).toEqual([
      idAHuman,
      idAAssistant,
      idBHuman,
    ]);
    expect(reversed.events.map((event) => event.source_record_id)).toEqual([
      idBHuman,
      idAAssistant,
      idAHuman,
    ]);
    expect(
      [...forward.events.map((event) => event.source_record_id)].sort(),
    ).toEqual(
      [...reversed.events.map((event) => event.source_record_id)].sort(),
    );
    expect(
      forward.events.find((event) => event.source_record_id === idAHuman),
    ).toEqual(
      reversed.events.find((event) => event.source_record_id === idAHuman),
    );
  });

  test("repeating an unchanged export is a no-op", async () => {
    const exportBody = JSON.stringify([
      {
        uuid: "conversation-1",
        name: "Local memory",
        created_at: "2026-01-01T09:00:00.000Z",
        chat_messages: [
          {
            uuid: "human-1",
            sender: "human",
            text: "Where should the data live?",
            created_at: "2026-01-01T09:00:01.000Z",
          },
          {
            uuid: "assistant-1",
            sender: "assistant",
            text: "On the owner's disk.",
            created_at: "2026-01-01T09:00:02.000Z",
          },
        ],
      },
    ]);
    const firstParse = parseClaudeExport(exportBody, OBSERVED_AT);
    const secondParse = parseClaudeExport(exportBody, OBSERVED_AT);
    expect(firstParse.errors).toEqual([]);
    expect(secondParse).toEqual(firstParse);

    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-claude-fidelity-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, exportBody);
      const connector = createClaudeImportConnector({ path: file });
      const first = await connector.backfill(null);
      expect(first.events).toHaveLength(2);
      const second = await connector.backfill(first.cursor);
      expect(second.events).toEqual([]);
      expect(second.cursor).toBe(first.cursor);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Claude export source fidelity", () => {
  test("duplicate conversations report; distinct message uuids under one conversation id are kept", () => {
    const stamped = (uuid: string, text: string) => ({
      uuid,
      sender: "human" as const,
      text,
      created_at: "2026-02-01T00:00:00.000Z",
    });
    const conversation = (messages: ReturnType<typeof stamped>[]) => ({
      uuid: "conversation-1",
      name: "Repeated",
      chat_messages: messages,
    });

    const exact = parseClaudeExport(
      JSON.stringify([
        conversation([stamped("message-1", "same")]),
        conversation([stamped("message-1", "same")]),
      ]),
      OBSERVED_AT,
    );
    expect(exact.events).toHaveLength(1);
    expect(exact.events[0]?.text).toBe("same");
    expect(exact.errors.map((error) => error.code)).toEqual(["duplicate_id"]);
    for (const event of exact.events) assertIngressOnly(event);

    const conflict = parseClaudeExport(
      JSON.stringify([
        conversation([stamped("message-1", "left")]),
        conversation([stamped("message-1", "right")]),
      ]),
      OBSERVED_AT,
    );
    expect(conflict.events).toHaveLength(1);
    expect(conflict.events[0]?.text).toBe("left");
    expect(conflict.errors.map((error) => error.code)).toEqual([
      "conflicting_id",
    ]);

    const merged = parseClaudeExport(
      JSON.stringify([
        conversation([stamped("message-1", "first")]),
        conversation([stamped("message-2", "second")]),
      ]),
      OBSERVED_AT,
    );
    expect(merged.errors).toEqual([]);
    expect(merged.events.map((event) => event.source_record_id)).toEqual([
      encodeSourceRecordId(["conversation-1", "message-1"]),
      encodeSourceRecordId(["conversation-1", "message-2"]),
    ]);
    expect(merged.events.map((event) => event.text)).toEqual([
      "first",
      "second",
    ]);
    for (const event of merged.events) assertIngressOnly(event);
  });

  test("multiple text blocks are stored once even when top-level text restates them", () => {
    const blocksOnly = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "assistant",
              created_at: "2026-03-15T09:30:46.000Z",
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
    expect(blocksOnly.errors).toEqual([]);
    expect(blocksOnly.events[0]?.text).toBe(
      "first paragraph\nsecond paragraph",
    );
    assertIngressOnly(blocksOnly.events[0]!);

    const derived = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "assistant",
              text: "first paragraph\nsecond paragraph",
              created_at: "2026-03-15T09:30:46.000Z",
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
    expect(derived.errors).toEqual([]);
    expect(derived.events[0]?.text).toBe("first paragraph\nsecond paragraph");
    assertIngressOnly(derived.events[0]!);

    const extra = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "assistant",
              text: "Answer",
              created_at: "2026-03-15T09:30:46.000Z",
              content: [{ type: "text", text: "Footnote" }],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(extra.errors).toEqual([]);
    expect(extra.events[0]?.text).toBe("Answer\nFootnote");
    assertIngressOnly(extra.events[0]!);
  });

  test("unknown and malformed blocks keep supported text and do not import their payloads", () => {
    const payload = "private scratch work";
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "assistant",
              text: "Visible answer",
              created_at: "2026-03-15T09:30:46.000Z",
              content: [
                { type: "thinking", thinking: payload },
                { type: "text", text: "Visible answer" },
                { type: "tool_use", name: "search", input: { q: payload } },
                { type: "tool_result", content: payload },
                { type: "synthetic_unknown", text: payload },
                { type: "text", text: 12 },
                "not-a-block",
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("Visible answer");
    expect(JSON.stringify(result.events[0])).not.toContain(payload);
    expect(result.events[0]?.metadata["unsupported_parts"]).toEqual([
      "thinking",
      "tool_use",
      "tool_result",
      "synthetic_unknown",
      "malformed_text",
      "non_object_block",
    ]);
    expect(result.errors.map((error) => error.code)).toEqual([
      "unsupported_part",
    ]);
    assertIngressOnly(result.events[0]!);
  });

  test("attachment descriptors stay source-linked and valid; bytes and invalid sizes are not ingested", () => {
    const inlineBytes = "AAAABASE64PAYLOAD";
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "human",
              text: "see attached",
              created_at: "2026-03-15T09:30:45.000Z",
              content: [
                { type: "text", text: "see attached" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: inlineBytes,
                  },
                },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: inlineBytes,
                  },
                },
                {
                  type: "document",
                  file_name: "brief.pdf",
                  source: { media_type: "application/pdf" },
                },
              ],
              attachments: [
                {
                  file_name: "note.pdf",
                  file_size: 4,
                  file_type: "application/pdf",
                  extracted_content: "extracted note body",
                },
                {
                  file_name: "note.pdf",
                  file_size: 8,
                  file_type: "application/pdf",
                },
                { file_name: "empty-type.bin", file_type: "", file_size: 1.5 },
                "not-an-attachment",
              ],
              files: [
                { file_name: "photo.png", file_type: "image/png" },
                { file_name: "note.pdf", file_size: 4, file_type: "application/pdf" },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );

    expect(result.events).toHaveLength(1);
    const event = result.events[0]!;
    expect(event.text).toBe("see attached\nextracted note body");
    expect(event.attachments).toEqual([
      { attachment_id: "image:0", media_type: "image/png" },
      { attachment_id: "image:1", media_type: "image/png" },
      {
        attachment_id: "brief.pdf",
        media_type: "application/pdf",
        filename: "brief.pdf",
      },
      {
        attachment_id: "note.pdf",
        media_type: "application/pdf",
        filename: "note.pdf",
        byte_size: 4,
      },
      {
        attachment_id: "note.pdf:1",
        media_type: "application/pdf",
        filename: "note.pdf",
        byte_size: 8,
      },
      {
        attachment_id: "empty-type.bin",
        media_type: "application/octet-stream",
        filename: "empty-type.bin",
      },
      {
        attachment_id: "photo.png",
        media_type: "image/png",
        filename: "photo.png",
      },
    ]);
    expect(event.metadata["unsupported_parts"]).toEqual([
      "non_object_attachment",
    ]);
    expect(JSON.stringify(event)).not.toContain(inlineBytes);
    expect(event.attachments.every((attachment) => !("data" in attachment))).toBe(
      true,
    );
    assertIngressOnly(event);
    expect(result.errors.map((error) => error.code)).toEqual([
      "unsupported_part",
    ]);
  });

  test("extracted attachment text is kept when the message has no other text", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "message-1",
              sender: "human",
              created_at: "2026-03-15T09:30:45.000Z",
              attachments: [
                {
                  file_name: "note.pdf",
                  file_type: "application/pdf",
                  extracted_content: "extracted note body",
                },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.errors).toEqual([]);
    expect(result.events[0]?.text).toBe("extracted note body");
    expect(result.events[0]?.attachments).toEqual([
      {
        attachment_id: "note.pdf",
        media_type: "application/pdf",
        filename: "note.pdf",
      },
    ]);
    assertIngressOnly(result.events[0]!);
  });

  test("an oversized extracted_content omits the extract and keeps the parent plus a later small message", () => {
    const extract = "x".repeat(EVENT_LIMITS.textBytes + 1);
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
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
      ]),
      OBSERVED_AT,
    );

    expect(result.events).toHaveLength(2);
    expect(result.events[0]?.text).toBe("see attached");
    expect(result.events[0]?.attachments).toEqual([
      {
        attachment_id: "note.pdf",
        media_type: "application/pdf",
        filename: "note.pdf",
      },
    ]);
    expect(result.events[0]?.metadata["unsupported_parts"]).toEqual([
      "oversized_extracted_content",
    ]);
    expect(result.events[1]?.text).toBe("short follow-up");
    expect(result.errors.map((error) => error.code)).toEqual(["unsupported_part"]);
    expect(JSON.stringify(result.events[0])).not.toContain(extract);
    for (const event of result.events) assertIngressOnly(event);
  });

  test("JSON-encoded extracted_content that fits textBytes but not eventBytes is omitted", () => {
    const extract = '"'.repeat(EVENT_LIMITS.textBytes - 32);
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "human-1",
              sender: "human",
              text: "see attached",
              created_at: "2026-03-15T09:30:45.000Z",
              files: [
                {
                  file_name: "quotes.txt",
                  file_type: "text/plain",
                  extracted_content: extract,
                },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("see attached");
    expect(result.events[0]?.metadata["unsupported_parts"]).toEqual([
      "oversized_extracted_content",
    ]);
    expect(result.errors.map((error) => error.code)).toEqual(["unsupported_part"]);
    assertIngressOnly(result.events[0]!);
  });

  test("attachment refs past the frozen count are omitted without dropping the message", () => {
    const listed = Array.from(
      { length: EVENT_LIMITS.attachmentCount + 1 },
      (_, index) => ({
        file_name: `file-${index}.txt`,
        file_type: "text/plain",
      }),
    );
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "human-1",
              sender: "human",
              text: "many files",
              created_at: "2026-03-15T09:30:45.000Z",
              attachments: listed,
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("many files");
    expect(result.events[0]?.attachments).toHaveLength(EVENT_LIMITS.attachmentCount);
    expect(result.events[0]?.metadata["unsupported_parts"]).toEqual([
      "oversized_attachments",
    ]);
    expect(result.errors.map((error) => error.code)).toEqual(["unsupported_part"]);
    assertIngressOnly(result.events[0]!);
  });

  test("an invalid attachment descriptor is omitted without dropping the message", () => {
    const invalidName = " note.pdf";
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
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
                  file_size: 4,
                },
                {
                  file_name: invalidName,
                  file_type: "application/pdf",
                },
              ],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("see attached");
    expect(result.events[0]?.attachments).toEqual([
      {
        attachment_id: "note.pdf",
        media_type: "application/pdf",
        filename: "note.pdf",
        byte_size: 4,
      },
    ]);
    expect(result.events[0]?.metadata["unsupported_parts"]).toEqual([
      "oversized_attachments",
    ]);
    expect(JSON.stringify(result.events[0])).not.toContain(invalidName);
    expect(result.errors.map((error) => error.code)).toEqual(["unsupported_part"]);
    assertIngressOnly(result.events[0]!);
  });

  test("extracted_content that fits each event is kept when the export exceeds one snapshot page", () => {
    const extract = "x".repeat(EVENT_LIMITS.textBytes - 1024);
    const natives = ["one", "two", "three", "four", "five"];
    const result = parseClaudeExport(
      JSON.stringify([
        {
          uuid: "conversation-1",
          chat_messages: natives.map((text, index) => ({
            uuid: `human-${index + 1}`,
            sender: "human",
            text,
            created_at: `2026-03-15T09:30:4${index}.000Z`,
            attachments: [
              {
                file_name: `note-${index + 1}.pdf`,
                file_type: "application/pdf",
                extracted_content: extract,
              },
            ],
          })),
        },
      ]),
      OBSERVED_AT,
    );

    // Parser fidelity only; Core ingest of a >4MiB snapshot page is shared pagination.
    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(5);
    expect(
      Buffer.byteLength(JSON.stringify(result.events), "utf8"),
    ).toBeGreaterThan(MAX_SYNC_BATCH_BYTES);
    for (const [index, event] of result.events.entries()) {
      expect(event.text).toBe(`${natives[index]}\n${extract}`);
      expect(event.attachments).toEqual([
        {
          attachment_id: `note-${index + 1}.pdf`,
          media_type: "application/pdf",
          filename: `note-${index + 1}.pdf`,
        },
      ]);
      expect(event.metadata["unsupported_parts"]).toEqual([]);
      assertIngressOnly(event);
    }
  });

  test("malformed records and unsupported senders are refused without substituting import time", () => {
    const result = parseClaudeExport(
      JSON.stringify([
        { uuid: "conversation-missing-messages", name: "Empty" },
        {
          uuid: "conversation-bad-messages",
          chat_messages: { uuid: "nope" },
        },
        {
          uuid: "conversation-1",
          chat_messages: [
            {
              uuid: "bad-content",
              sender: "human",
              text: "kept?",
              created_at: "2026-03-15T09:30:45.000Z",
              content: { type: "text", text: "kept?" },
            },
            {
              uuid: "user-role",
              sender: "user",
              text: "not a claude sender",
              created_at: "2026-03-15T09:30:46.000Z",
            },
            {
              uuid: "numeric-time",
              sender: "human",
              text: "dated",
              created_at: 1_700_000_000,
            },
            {
              uuid: "tool-only",
              sender: "assistant",
              created_at: "2026-03-15T09:30:47.000Z",
              content: [{ type: "tool_use", name: "search" }],
            },
          ],
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual([
      "missing_messages",
      "malformed_messages",
      "malformed_content",
      "unsupported_sender",
      "invalid_timestamp",
      "unsupported_part",
      "empty_content",
    ]);
    expect(result.errors.some((error) => error.reason.includes("import"))).toBe(
      false,
    );
  });

  test("a later snapshot emits only changed records and repeats remain a no-op", async () => {
    const firstBody = [
      {
        uuid: "conversation-1",
        name: "Local memory",
        chat_messages: [
          {
            uuid: "human-1",
            sender: "human",
            text: "Where should the data live?",
            created_at: "2026-01-01T09:00:01.000Z",
          },
        ],
      },
    ];
    const secondBody = [
      {
        uuid: "conversation-1",
        name: "Local memory",
        chat_messages: [
          firstBody[0]!.chat_messages[0],
          {
            uuid: "assistant-1",
            sender: "assistant",
            text: "On the owner's disk.",
            created_at: "2026-01-01T09:00:02.000Z",
            content: [
              { type: "text", text: "On the owner's disk." },
              { type: "thinking", thinking: "private scratch work" },
            ],
          },
        ],
      },
    ];
    const root = await mkdtemp(
      path.join(os.tmpdir(), "kizuki-claude-checkpoint-"),
    );
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, JSON.stringify(firstBody));
      const connector = createClaudeImportConnector({ path: file });
      const first = await connector.backfill(null);
      expect(first.status ?? "ok").toBe("ok");
      expect(first.events).toHaveLength(1);
      expect(first.cursor).not.toBeNull();
      const drain = await connector.backfill(first.cursor);
      expect(drain).toEqual({ events: [], cursor: first.cursor });

      await writeFile(file, JSON.stringify(secondBody));
      expect((await connector.health()).state).toBe("degraded");
      const updated = await connector.sync(first.cursor);
      expect(updated.status ?? "ok").toBe("ok");
      expect(updated.events).toHaveLength(1);
      expect(updated.events[0]?.source_record_id).toBe(
        encodeSourceRecordId(["conversation-1", "assistant-1"]),
      );
      expect(updated.events[0]?.text).toBe("On the owner's disk.");
      expect(JSON.stringify(updated.events[0])).not.toContain(
        "private scratch work",
      );
      expect(updated.cursor).not.toBe(first.cursor);
      assertIngressOnly(updated.events[0]!);

      const repeat = await connector.sync(updated.cursor);
      expect(repeat.events).toEqual([]);
      expect(repeat.cursor).toBe(updated.cursor);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
