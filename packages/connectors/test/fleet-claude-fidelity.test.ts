import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  createClaudeImportConnector,
  parseClaudeExport,
} from "../src";
import { encodeSourceRecordId } from "../src/source-id";

const OBSERVED_AT = "2026-06-15T18:00:00.000Z";

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
