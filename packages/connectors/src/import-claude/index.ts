import { isPlainObject } from "@kizuki/core";
import type {
  AttachmentRef,
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { isoToRfc3339, requireKnownKeys, requirePathConfig } from "../util";
import type { ImportParseResult, ImportRecordError } from "../import-report";
import { parseBoundedJsonArray } from "../import-json";
import {
  readSnapshotExport,
  snapshotBatch,
  snapshotHealth,
} from "../import-snapshot";
import type { SnapshotParse } from "../import-snapshot";
import {
  encodeSourceRecordId,
  fallbackSourcePart,
} from "../source-id";

export const CLAUDE_IMPORT_CONNECTOR_ID = "kizuki.import-claude" as const;

export interface ClaudeImportConfig {
  path: string;
}

const CONFIG_KEYS = ["path"];

export const CLAUDE_FIXTURE_EXPORT = [
  {
    uuid: "fixture-conversation-1",
    name: "Local memory",
    created_at: "2026-01-01T09:00:00Z",
    chat_messages: [
      {
        uuid: "human-1",
        sender: "human",
        text: "Where should the data live?",
        created_at: "2026-01-01T09:00:01Z",
      },
      {
        uuid: "assistant-1",
        sender: "assistant",
        text: "On the owner's disk.",
        created_at: "2026-01-01T09:00:02Z",
      },
    ],
  },
] as const;

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
  version: "0.2.0",
  kinds: ["message"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: true,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
  auth_modes: ["none"],
};

const SNAPSHOT: SnapshotParse = {
  connectorId: CLAUDE_IMPORT_CONNECTOR_ID,
  kind: "message",
  parse: parseClaudeExport,
};

const SUPPORTED_SENDERS = new Set(["human", "assistant"]);

export class ClaudeImportConnector implements Connector {
  readonly path: string;

  constructor(config: ClaudeImportConfig) {
    this.path = requirePathConfig(config, CLAUDE_IMPORT_CONNECTOR_ID);
    requireKnownKeys(config, CLAUDE_IMPORT_CONNECTOR_ID, CONFIG_KEYS);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  health() {
    return snapshotHealth(this.path, SNAPSHOT);
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    const observedAt = new Date().toISOString();
    const read = await readSnapshotExport(this.path, observedAt, SNAPSHOT);
    return snapshotBatch(read, cursor, observedAt, SNAPSHOT);
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    return {
      subject_id,
      source_record_ids: [],
      unreachable_source_record_ids: [],
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return parseClaudeExport(
      JSON.stringify(CLAUDE_FIXTURE_EXPORT),
      "2026-01-01T00:00:00.000Z",
    ).events;
  }
}

export function createClaudeImportConnector(
  config: ClaudeImportConfig,
): ClaudeImportConnector {
  return new ClaudeImportConnector(config);
}

export function parseClaudeExport(
  source: string,
  observedAt: string,
): ImportParseResult {
  const conversations = parseBoundedJsonArray(
    source,
    CLAUDE_IMPORT_CONNECTOR_ID,
  );
  const errors: ImportRecordError[] = [];
  const events: CaptureEventInput[] = [];
  const seen = new Map<string, string>();

  conversations.forEach((rawConversation, conversationIndex) => {
    if (!isPlainObject(rawConversation)) {
      errors.push({
        location: `conversations[${conversationIndex}]`,
        code: "not_object",
        reason: "conversation is not an object",
      });
      return;
    }
    const title =
      typeof rawConversation["name"] === "string"
        ? rawConversation["name"]
        : "";
    const conversationId =
      nonEmptyString(rawConversation["uuid"]) ??
      fallbackSourcePart("conversation", [
        title,
        String(rawConversation["created_at"] ?? ""),
        messageFingerprint(rawConversation["chat_messages"]),
      ]);
    if (nonEmptyString(rawConversation["uuid"]) === undefined) {
      errors.push({
        location: `conversations[${conversationIndex}]`,
        code: "missing_id",
        reason: "conversation uuid is missing; used a content fallback",
      });
    }
    const messages = rawConversation["chat_messages"];
    if (messages === undefined) {
      errors.push({
        location: conversationId,
        code: "missing_messages",
        reason: "conversation has no chat_messages array",
      });
      return;
    }
    if (!Array.isArray(messages)) {
      errors.push({
        location: conversationId,
        code: "malformed_messages",
        reason: "chat_messages is not an array",
      });
      return;
    }

    messages.forEach((rawMessage, messageIndex) => {
      const location = `${conversationId}[${messageIndex}]`;
      if (!isPlainObject(rawMessage)) {
        errors.push({
          location,
          code: "not_object",
          reason: "message is not an object",
        });
        return;
      }
      const sender = rawMessage["sender"];
      if (typeof sender !== "string" || !SUPPORTED_SENDERS.has(sender)) {
        errors.push({
          location,
          code: "unsupported_sender",
          reason: "message sender is not human or assistant",
        });
        return;
      }
      const extracted = extractClaudeContent(rawMessage, location);
      if (extracted.error !== undefined) {
        errors.push(extracted.error);
        return;
      }
      if (extracted.unsupported.length > 0) {
        errors.push({
          location,
          code: "unsupported_part",
          reason: `unsupported content blocks: ${extracted.unsupported.join(",")}`,
        });
      }
      if (
        extracted.text.trim().length === 0 &&
        extracted.attachments.length === 0
      ) {
        errors.push({
          location,
          code: "empty_content",
          reason: "message has no text or attachments",
        });
        return;
      }

      let occurredAt: string;
      try {
        occurredAt = isoToRfc3339(rawMessage["created_at"], location);
      } catch {
        errors.push({
          location,
          code: "invalid_timestamp",
          reason: "message created_at is missing or invalid",
        });
        return;
      }

      const messageId =
        nonEmptyString(rawMessage["uuid"]) ??
        fallbackSourcePart("message", [
          conversationId,
          sender,
          extracted.text,
          occurredAt,
        ]);
      if (nonEmptyString(rawMessage["uuid"]) === undefined) {
        errors.push({
          location,
          code: "missing_id",
          reason: "message uuid is missing; used a content fallback",
        });
      }
      const sourceRecordId = encodeSourceRecordId([conversationId, messageId]);
      const fingerprint = `${occurredAt}\n${extracted.text}\n${extracted.attachments
        .map((attachment) => attachment.attachment_id)
        .join(",")}`;
      const prior = seen.get(sourceRecordId);
      if (prior !== undefined) {
        errors.push({
          location: sourceRecordId,
          code: prior === fingerprint ? "duplicate_id" : "conflicting_id",
          reason:
            prior === fingerprint
              ? "export repeats the same source_record_id"
              : "export reuses a source_record_id for different content",
        });
        return;
      }
      seen.set(sourceRecordId, fingerprint);

      const handle = sender === "human" ? "self" : "assistant";
      events.push({
        schema: "kizuki.event/v1",
        connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
        source_record_id: sourceRecordId,
        kind: "message",
        occurred_at: occurredAt,
        observed_at: observedAt,
        text: extracted.text,
        subjects: [{ subject_id: `claude:${handle}`, role: "from" }],
        deleted: false,
        attachments: extracted.attachments,
        metadata: {
          handle,
          namespace: "claude",
          conversation_title: title,
          unsupported_parts: extracted.unsupported,
          export: "claude-conversations.json",
        },
      });
    });
  });

  return { events, errors };
}

interface ExtractedContent {
  text: string;
  attachments: AttachmentRef[];
  unsupported: string[];
  error?: ImportRecordError;
}

function extractClaudeContent(
  rawMessage: Record<string, unknown>,
  location: string,
): ExtractedContent {
  const attachments: AttachmentRef[] = [];
  const unsupported: string[] = [];
  const lines: string[] = [];

  if (typeof rawMessage["text"] === "string" && rawMessage["text"].length > 0) {
    lines.push(rawMessage["text"]);
  }

  const blocks = rawMessage["content"];
  if (blocks !== undefined && !Array.isArray(blocks)) {
    return {
      text: "",
      attachments: [],
      unsupported: [],
      error: {
        location,
        code: "malformed_content",
        reason: "content is not an array",
      },
    };
  }
  if (Array.isArray(blocks)) {
    blocks.forEach((block, index) => {
      if (!isPlainObject(block)) {
        unsupported.push("non_object_block");
        return;
      }
      const type =
        typeof block["type"] === "string" ? block["type"] : "unknown";
      if (type === "text" && typeof block["text"] === "string") {
        if (typeof rawMessage["text"] === "string" && block["text"] === rawMessage["text"]) {
          return;
        }
        lines.push(block["text"]);
        return;
      }
      if (type === "image" || type === "document") {
        const id =
          nonEmptyString(block["id"]) ??
          nonEmptyString(
            isPlainObject(block["source"])
              ? block["source"]["media_type"]
              : undefined,
          ) ??
          `${type}:${index}`;
        attachments.push({
          attachment_id: id,
          media_type: type === "image" ? "image/*" : "application/octet-stream",
        });
        return;
      }
      if (type === "tool_use" || type === "tool_result" || type === "thinking") {
        unsupported.push(type);
        return;
      }
      if (type !== "text") unsupported.push(type);
    });
  }

  const listed = rawMessage["attachments"];
  if (listed !== undefined && !Array.isArray(listed)) {
    unsupported.push("malformed_attachments");
  } else if (Array.isArray(listed)) {
    listed.forEach((attachment, index) => {
      if (!isPlainObject(attachment)) {
        unsupported.push("non_object_attachment");
        return;
      }
      const name =
        nonEmptyString(attachment["file_name"]) ??
        nonEmptyString(attachment["filename"]) ??
        `attachment:${index}`;
      attachments.push({
        attachment_id: name,
        media_type:
          typeof attachment["file_type"] === "string"
            ? attachment["file_type"]
            : "application/octet-stream",
        filename: name,
        ...(typeof attachment["file_size"] === "number"
          ? { byte_size: attachment["file_size"] }
          : {}),
      });
    });
  }

  return { text: lines.join("\n"), attachments, unsupported };
}

function messageFingerprint(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((message) => {
      if (!isPlainObject(message)) return "";
      return [
        typeof message["uuid"] === "string" ? message["uuid"] : "",
        typeof message["text"] === "string" ? message["text"] : "",
        typeof message["created_at"] === "string" ? message["created_at"] : "",
      ].join("\n");
    })
    .join("\n---\n");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
