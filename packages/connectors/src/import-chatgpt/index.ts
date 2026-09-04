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
import type { ImportParseResult, ImportRecordError } from "../import-report";
import { runSnapshot, snapshotHealth } from "../import-snapshot";
import type { SnapshotParse } from "../import-snapshot";
import {
  nonEmptyString,
  parseJsonArray,
  requireKnownKeys,
  requirePathConfig,
  unixSecondsToIso,
} from "../util";
import {
  encodeSourceRecordId,
  fallbackSourcePart,
} from "../source-id";

export const CHATGPT_IMPORT_CONNECTOR_ID = "kizuki.import-chatgpt" as const;

export interface ChatGptImportConfig {
  path: string;
}

const CONFIG_KEYS = ["path"];

export const CHATGPT_FIXTURE_EXPORT = [
  {
    id: "fixture-conversation-1",
    title: "A small question",
    create_time: 1_767_225_600,
    mapping: {
      root: { parent: null, children: ["user-1"] },
      "user-1": {
        message: {
          author: { role: "user" },
          content: { parts: ["What is local-first?"] },
          create_time: 1_767_225_601,
        },
        parent: "root",
        children: ["assistant-1"],
      },
      "assistant-1": {
        message: {
          author: { role: "assistant" },
          content: { parts: ["Data stays under", "your control."] },
          create_time: 1_767_225_602,
        },
        parent: "user-1",
        children: [],
      },
    },
  },
  {
    conversation_id: "fixture-conversation-2",
    title: "Follow-up",
    create_time: 1_767_312_000,
    mapping: {
      "user-2": {
        message: {
          author: { role: "user" },
          content: { parts: ["Keep it deterministic."] },
          create_time: 1_767_312_001,
        },
        parent: null,
        children: [],
      },
    },
  },
] as const;

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
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
  connectorId: CHATGPT_IMPORT_CONNECTOR_ID,
  kind: "message",
  parse: parseChatGptExport,
};

const SUPPORTED_ROLES = new Set(["user", "assistant", "system", "tool"]);

export class ChatGptImportConnector implements Connector {
  readonly path: string;

  constructor(config: ChatGptImportConfig) {
    this.path = requirePathConfig(config, CHATGPT_IMPORT_CONNECTOR_ID);
    requireKnownKeys(config, CHATGPT_IMPORT_CONNECTOR_ID, CONFIG_KEYS);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  health() {
    return snapshotHealth(this.path, SNAPSHOT);
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(cursor: Cursor | null): Promise<SyncBatch> {
    return runSnapshot(this.path, cursor, SNAPSHOT);
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
    return parseChatGptExport(JSON.stringify(CHATGPT_FIXTURE_EXPORT), "2026-01-01T00:00:00.000Z")
      .events;
  }
}

export function createChatGptImportConnector(
  config: ChatGptImportConfig,
): ChatGptImportConnector {
  return new ChatGptImportConnector(config);
}

export function parseChatGptExport(
  source: string,
  observedAt: string,
): ImportParseResult {
  const conversations = parseJsonArray(source, CHATGPT_IMPORT_CONNECTOR_ID);
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
    const titled =
      typeof rawConversation["title"] === "string"
        ? rawConversation["title"]
        : "";
    const rawId =
      nonEmptyString(rawConversation["id"]) ??
      nonEmptyString(rawConversation["conversation_id"]);
    const conversationId =
      rawId ??
      fallbackSourcePart("conversation", [
        titled,
        String(rawConversation["create_time"] ?? ""),
        mappingFingerprint(rawConversation["mapping"]),
      ]);
    if (rawId === undefined) {
      errors.push({
        location: `conversations[${conversationIndex}]`,
        code: "missing_id",
        reason: "conversation id is missing; used a content fallback",
      });
    }
    const mapping = rawConversation["mapping"];
    if (!isPlainObject(mapping)) {
      errors.push({
        location: conversationId,
        code: "missing_mapping",
        reason: "conversation has no mapping object",
      });
      return;
    }

    const nodes = Object.entries(mapping).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const [rawNodeId, rawNode] of nodes) {
      if (!isPlainObject(rawNode)) {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "not_object",
          reason: "node is not an object",
        });
        continue;
      }
      const message = rawNode["message"];
      if (message === null || message === undefined) continue;
      if (!isPlainObject(message)) {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "malformed_message",
          reason: "node message is not an object",
        });
        continue;
      }
      if (!isPlainObject(message["author"])) {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "malformed_author",
          reason: "message author is missing",
        });
        continue;
      }
      const role = message["author"]["role"];
      if (typeof role !== "string" || !SUPPORTED_ROLES.has(role)) {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "unsupported_role",
          reason: "message role is not user, assistant, system, or tool",
        });
        continue;
      }
      const extracted = extractContent(
        message["content"],
        `${conversationId}/${rawNodeId || "node"}`,
      );
      if (extracted.error !== undefined) {
        errors.push(extracted.error);
        continue;
      }
      if (extracted.unsupported.length > 0) {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "unsupported_part",
          reason: `unsupported content parts: ${extracted.unsupported.join(",")}`,
        });
      }
      if (
        extracted.text.trim().length === 0 &&
        extracted.attachments.length === 0
      ) {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "empty_content",
          reason: "message has no text or attachments",
        });
        continue;
      }

      let occurredAt: string;
      try {
        occurredAt = unixSecondsToIso(
          message["create_time"],
          `${conversationId} node`,
        );
      } catch {
        errors.push({
          location: `${conversationId}/${rawNodeId || "node"}`,
          code: "invalid_timestamp",
          reason: "message create_time is missing or invalid",
        });
        continue;
      }

      const nodeId =
        rawNodeId.length > 0
          ? rawNodeId
          : fallbackSourcePart("node", [
              conversationId,
              role,
              extracted.text,
              occurredAt,
              typeof rawNode["parent"] === "string" ? rawNode["parent"] : "",
            ]);
      if (rawNodeId.length === 0) {
        errors.push({
          location: `${conversationId}/node`,
          code: "missing_id",
          reason: "node id is missing; used a content fallback",
        });
      }
      const sourceRecordId = encodeSourceRecordId([conversationId, nodeId]);
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
        continue;
      }
      seen.set(sourceRecordId, fingerprint);

      const handle =
        role === "user" ? "self" : role === "assistant" ? "assistant" : role;
      events.push({
        schema: "kizuki.event/v1",
        connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
        source_record_id: sourceRecordId,
        kind: "message",
        occurred_at: occurredAt,
        observed_at: observedAt,
        text: extracted.text,
        subjects: [{ subject_id: `chatgpt:${handle}`, role: "from" }],
        deleted: false,
        attachments: extracted.attachments,
        metadata: {
          handle,
          namespace: "chatgpt",
          conversation_title: titled,
          unsupported_parts: extracted.unsupported,
          export: "chatgpt-conversations.json",
        },
      });
    }
  });

  return { events, errors };
}

interface ExtractedContent {
  text: string;
  attachments: AttachmentRef[];
  unsupported: string[];
  error?: ImportRecordError;
}

function extractContent(content: unknown, location: string): ExtractedContent {
  if (content === undefined || content === null) {
    return {
      text: "",
      attachments: [],
      unsupported: [],
      error: {
        location,
        code: "missing_content",
        reason: "message content is missing",
      },
    };
  }
  if (typeof content === "string") {
    return { text: content, attachments: [], unsupported: [] };
  }
  if (!isPlainObject(content)) {
    return {
      text: "",
      attachments: [],
      unsupported: [],
      error: {
        location,
        code: "malformed_content",
        reason: "message content is not an object or string",
      },
    };
  }
  const parts = Array.isArray(content["parts"])
    ? content["parts"]
    : content["text"] !== undefined
      ? [content["text"]]
      : undefined;
  if (parts === undefined) {
    const contentType =
      typeof content["content_type"] === "string"
        ? content["content_type"]
        : "unknown";
    if (contentType !== "text") {
      return {
        text: "",
        attachments: [],
        unsupported: [contentType],
      };
    }
    return {
      text: "",
      attachments: [],
      unsupported: [],
      error: {
        location,
        code: "malformed_content",
        reason: "text content has no parts",
      },
    };
  }
  const lines: string[] = [];
  const attachments: AttachmentRef[] = [];
  const unsupported: string[] = [];
  parts.forEach((part, index) => {
    if (typeof part === "string") {
      lines.push(part);
      return;
    }
    if (!isPlainObject(part)) {
      unsupported.push("non_object_part");
      return;
    }
    const type =
      typeof part["content_type"] === "string"
        ? part["content_type"]
        : typeof part["type"] === "string"
          ? part["type"]
          : "unknown";
    if (
      type === "image_asset_pointer" ||
      type === "image" ||
      type === "file" ||
      type === "audio"
    ) {
      const pointer =
        nonEmptyString(part["asset_pointer"]) ??
        nonEmptyString(part["filename"]) ??
        `${type}:${index}`;
      attachments.push({
        attachment_id: pointer,
        media_type:
          type === "image" || type === "image_asset_pointer"
            ? "image/*"
            : type === "audio"
              ? "audio/*"
              : "application/octet-stream",
        ...(typeof part["filename"] === "string"
          ? { filename: part["filename"] }
          : {}),
        ...(typeof part["size_bytes"] === "number"
          ? { byte_size: part["size_bytes"] }
          : {}),
      });
      if (typeof part["text"] === "string" && part["text"].length > 0) {
        lines.push(part["text"]);
      }
      return;
    }
    if (type === "text" || typeof part["text"] === "string") {
      if (typeof part["text"] === "string") lines.push(part["text"]);
      return;
    }
    unsupported.push(type);
  });
  return { text: lines.join("\n"), attachments, unsupported };
}

function mappingFingerprint(mapping: unknown): string {
  if (!isPlainObject(mapping)) return "";
  return Object.keys(mapping).sort().join(",");
}
