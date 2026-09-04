import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHATGPT_IMPORT_CONNECTOR_ID,
  KizukiError,
  createChatGptImportConnector,
  parseChatGptExport,
} from "../src";
import { encodeSourceRecordId } from "../src/source-id";

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
    const result = parseChatGptExport(
      JSON.stringify(INLINE_EXPORT),
      OBSERVED_AT,
    );

    expect(result.errors).toEqual([]);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.source_record_id)).toEqual([
      encodeSourceRecordId(["conversation-42", "message-a"]),
      encodeSourceRecordId(["conversation-42", "message-b"]),
    ]);
    expect(result.events.map((event) => event.subjects[0]?.subject_id)).toEqual([
      "chatgpt:self",
      "chatgpt:assistant",
    ]);
    expect(result.events.map((event) => event.text)).toEqual([
      "A question",
      "Line one\nLine two",
    ]);
    expect(result.events.map((event) => event.occurred_at)).toEqual([
      "2023-11-14T22:13:21.000Z",
      "2023-11-14T22:13:22.000Z",
    ]);
    expect(
      result.events.every((event) => event.observed_at === OBSERVED_AT),
    ).toBe(true);
    expect(
      result.events.every(
        (event) => event.connector_id === CHATGPT_IMPORT_CONNECTOR_ID,
      ),
    ).toBe(true);
    expect(result.events.map((event) => event.metadata["handle"])).toEqual([
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

  test("reports malformed conversations and nodes instead of skipping them", () => {
    const result = parseChatGptExport(
      JSON.stringify([
        "not-an-object",
        {
          id: "c1",
          mapping: {
            root: { message: null, children: [] },
            bad: { message: "string" },
            empty: {
              message: {
                author: { role: "user" },
                content: { parts: ["   "] },
                create_time: 1_700_000_000,
              },
            },
          },
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toEqual([]);
    expect(result.errors.map((error) => error.code).sort()).toEqual([
      "empty_content",
      "malformed_message",
      "not_object",
    ]);
  });

  test("accounts for image parts and unsupported content instead of dropping them", () => {
    const result = parseChatGptExport(
      JSON.stringify([
        {
          id: "c1",
          mapping: {
            n1: {
              message: {
                author: { role: "user" },
                content: {
                  parts: [
                    "see this",
                    {
                      content_type: "image_asset_pointer",
                      asset_pointer: "file-service://img-1",
                      size_bytes: 12,
                    },
                    { content_type: "tether_browsing_display" },
                  ],
                },
                create_time: 1_700_000_000,
              },
            },
          },
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.text).toBe("see this");
    expect(result.events[0]?.attachments).toEqual([
      {
        attachment_id: "file-service://img-1",
        media_type: "image/*",
        byte_size: 12,
      },
    ]);
    expect(result.errors.map((error) => error.code)).toEqual([
      "unsupported_part",
    ]);
    expect(result.events[0]?.metadata["unsupported_parts"]).toEqual([
      "tether_browsing_display",
    ]);
  });

  test("slash-containing conversation and node ids do not collide", () => {
    const result = parseChatGptExport(
      JSON.stringify([
        {
          id: "a/b",
          mapping: {
            c: {
              message: {
                author: { role: "user" },
                content: { parts: ["one"] },
                create_time: 1_700_000_000,
              },
            },
          },
        },
        {
          id: "a",
          mapping: {
            "b/c": {
              message: {
                author: { role: "user" },
                content: { parts: ["two"] },
                create_time: 1_700_000_001,
              },
            },
          },
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.errors).toEqual([]);
    expect(result.events.map((event) => event.source_record_id)).toEqual([
      encodeSourceRecordId(["a/b", "c"]),
      encodeSourceRecordId(["a", "b/c"]),
    ]);
    expect(result.events[0]?.source_record_id).not.toBe(
      result.events[1]?.source_record_id,
    );
  });

  test("fallback ids stay stable when the export is reordered", () => {
    const node = {
      message: {
        author: { role: "user" },
        content: { parts: ["stable"] },
        create_time: 1_700_000_000,
      },
    };
    const first = parseChatGptExport(
      JSON.stringify([
        { title: "Untitled", mapping: { n: node } },
        { id: "kept", mapping: { n: node } },
      ]),
      OBSERVED_AT,
    );
    const second = parseChatGptExport(
      JSON.stringify([
        { id: "kept", mapping: { n: node } },
        { title: "Untitled", mapping: { n: node } },
      ]),
      OBSERVED_AT,
    );
    expect(first.events.map((event) => event.source_record_id).sort()).toEqual(
      second.events.map((event) => event.source_record_id).sort(),
    );
  });

  test("duplicate and conflicting node ids are reported, not collapsed", () => {
    const message = (text: string) => ({
      message: {
        author: { role: "user" },
        content: { parts: [text] },
        create_time: 1_700_000_000,
      },
    });
    const exact = parseChatGptExport(
      JSON.stringify([
        { id: "c1", mapping: { n: message("same") } },
        { id: "c1", mapping: { n: message("same") } },
      ]),
      OBSERVED_AT,
    );
    expect(exact.events).toHaveLength(1);
    expect(exact.errors.map((error) => error.code)).toEqual(["duplicate_id"]);

    const conflict = parseChatGptExport(
      JSON.stringify([
        { id: "c1", mapping: { n: message("left") } },
        { id: "c1", mapping: { n: message("right") } },
      ]),
      OBSERVED_AT,
    );
    expect(conflict.events).toHaveLength(1);
    expect(conflict.errors.map((error) => error.code)).toEqual([
      "conflicting_id",
    ]);
  });

  test("missing source timestamps are errors, not import time", () => {
    const result = parseChatGptExport(
      JSON.stringify([
        {
          id: "c1",
          mapping: {
            n: {
              message: {
                author: { role: "user" },
                content: { parts: ["no time"] },
              },
            },
          },
        },
      ]),
      OBSERVED_AT,
    );
    expect(result.events).toEqual([]);
    expect(result.errors.map((error) => error.code)).toEqual([
      "invalid_timestamp",
    ]);
  });
});

describe("ChatGptImportConnector", () => {
  test("health probes the export and refuses a malformed file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-chatgpt-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, "{}\n");
      const report = await createChatGptImportConnector({ path: file }).health();
      expect(report.state).toBe("misconfigured");
      expect(report.detail ?? "").not.toContain(file);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sync tombstones a conversation removed from a later export", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-chatgpt-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, JSON.stringify(INLINE_EXPORT));
      const connector = createChatGptImportConnector({ path: file });
      const first = await connector.backfill(null);
      expect(first.events).toHaveLength(2);
      expect(first.cursor).not.toBeNull();

      await writeFile(
        file,
        JSON.stringify([
          {
            id: "conversation-42",
            mapping: {
              "message-a": INLINE_EXPORT[0]?.mapping["message-a"],
            },
          },
        ]),
      );
      const second = await connector.sync(first.cursor);
      expect(second.events.some((event) => event.deleted)).toBe(true);
      expect(
        second.events
          .filter((event) => event.deleted)
          .map((event) => event.source_record_id),
      ).toEqual([encodeSourceRecordId(["conversation-42", "message-b"])]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("an unchanged export is a no-op on the next backfill", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "kizuki-chatgpt-"));
    try {
      const file = path.join(root, "conversations.json");
      await writeFile(file, JSON.stringify(INLINE_EXPORT));
      const connector = createChatGptImportConnector({ path: file });
      const first = await connector.backfill(null);
      const second = await connector.backfill(first.cursor);
      expect(second.events).toEqual([]);
      expect(second.cursor).toBe(first.cursor);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
