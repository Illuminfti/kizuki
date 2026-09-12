import {
  EVENT_LIMITS,
  freezeManifest,
  isPlainObject,
  policyForConnector,
  validateEventInput,
} from "@kizuki/core";
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
import { notSupported } from "../errors";
import {
  IMPORT_SNAPSHOT_CURSOR_SCHEMA,
  runSnapshot,
  snapshotHealth,
} from "../import-snapshot";
import type { SnapshotParse } from "../import-snapshot";
import {
  mediaTypeFor,
  nonEmptyString,
  parseJsonArray,
  requireKnownKeys,
  requirePathConfig,
  safeFilename,
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

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
  version: "0.2.0",
  contract_minor: 1,
  implementation: "@kizuki/connectors",
  allowed_egress: [],
  cursor_schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA,
  kinds: ["message"],
  capabilities: {
    backfill: true,
    sync: true,
    // A shorter export is not a deletion, and the importer cannot tell the
    // difference, so it never claims one.
    tombstones: false,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
  ...policyForConnector(CHATGPT_IMPORT_CONNECTOR_ID),
  auth_modes: ["none"],
});

const SNAPSHOT: SnapshotParse = {
  connectorId: CHATGPT_IMPORT_CONNECTOR_ID,
  parse: parseChatGptExport,
};

const SUPPORTED_ROLES = new Set(["user", "assistant", "system", "tool"]);

/** Custom-instruction payloads. Keep them out of conversation evidence. */
const INSTRUCTION_CONTENT_TYPES = new Set([
  "user_editable_context",
  "model_editable_context",
]);

const TEXT_CONTENT_TYPES = new Set([
  "text",
  "multimodal_text",
  "code",
  "audio_transcription",
]);

const ATTACHMENT_TYPES = new Set([
  "image_asset_pointer",
  "image",
  "file",
  "audio",
  "audio_asset_pointer",
  "video_asset_pointer",
  "real_time_user_audio_video_asset_pointer",
]);

const FILE_SERVICE_PREFIX = "file-service://";

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

  async purgeSource(_subject_id: string): Promise<PurgePlan> {
    return notSupported(CHATGPT_IMPORT_CONNECTOR_ID, "purge");
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
        message,
        `${conversationId}/${rawNodeId || "node"}`,
      );
      if (extracted.error !== undefined) {
        errors.push(extracted.error);
        continue;
      }
      const location = `${conversationId}/${rawNodeId || "node"}`;
      const noPayload =
        extracted.text.trim().length === 0 &&
        extracted.attachments.length === 0;
      if (noPayload) {
        if (extracted.unsupported.length > 0) {
          errors.push({
            location,
            code: "unsupported_part",
            reason: `unsupported content parts: ${extracted.unsupported.join(",")}`,
          });
        }
        if (
          extracted.unsupported.length === 0 ||
          extracted.rejectedAttachment === true
        ) {
          errors.push({
            location,
            code: "empty_content",
            reason: "message has no text or attachments",
          });
        }
        continue;
      }
      const conversationTitle = metadataString(titled);
      const parent = nonEmptyString(rawNode["parent"]);
      const keptParent =
        parent === undefined ? undefined : metadataString(parent);
      const currentNode = nonEmptyString(rawConversation["current_node"]);
      const keptCurrent =
        currentNode === undefined ? undefined : metadataString(currentNode);
      const unsupportedParts = [
        ...extracted.unsupported,
        ...(conversationTitle === undefined
          ? ["oversize_conversation_title"]
          : []),
        ...(parent !== undefined && keptParent === undefined
          ? ["oversize_parent"]
          : []),
        ...(currentNode !== undefined && keptCurrent === undefined
          ? ["oversize_current_node"]
          : []),
      ].slice(0, EVENT_LIMITS.metadataArrayLength);
      if (unsupportedParts.length > 0) {
        errors.push({
          location,
          code: "unsupported_part",
          reason: `unsupported content parts: ${unsupportedParts.join(",")}`,
        });
      }

      let occurredAt: string;
      try {
        occurredAt = unixSecondsToIso(
          message["create_time"],
          `${conversationId} node`,
        );
      } catch {
        errors.push({
          location,
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
      const event: CaptureEventInput = {
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
          ...(conversationTitle !== undefined
            ? { conversation_title: conversationTitle }
            : {}),
          unsupported_parts: unsupportedParts,
          export: "chatgpt-conversations.json",
          ...(keptParent !== undefined ? { parent: keptParent } : {}),
          ...(keptCurrent !== undefined ? { current_node: keptCurrent } : {}),
        },
      };
      if (!validateEventInput(event).ok) {
        errors.push({
          location,
          code: "malformed_content",
          reason: "message cannot be represented as an event",
        });
        continue;
      }
      events.push(event);
    }
  });

  return { events, errors };
}

interface ExtractedContent {
  text: string;
  attachments: AttachmentRef[];
  unsupported: string[];
  rejectedAttachment?: boolean;
  error?: ImportRecordError;
}

function extractContent(
  message: Record<string, unknown>,
  location: string,
): ExtractedContent {
  const content = message["content"];
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
    const extracted: ExtractedContent = {
      text: content,
      attachments: [],
      unsupported: [],
    };
    collectMetadataAttachments(message["metadata"], extracted);
    return extracted;
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
  const contentType =
    typeof content["content_type"] === "string"
      ? content["content_type"]
      : "unknown";
  if (INSTRUCTION_CONTENT_TYPES.has(contentType)) {
    return {
      text: "",
      attachments: [],
      unsupported: [unsupportedToken(contentType)],
    };
  }
  const rawParts = content["parts"];
  const usingPartsArray = Array.isArray(rawParts);
  const parts = usingPartsArray
    ? rawParts
    : content["text"] !== undefined
      ? [content["text"]]
      : undefined;
  if (parts === undefined) {
    if (TEXT_CONTENT_TYPES.has(contentType)) {
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
    const extracted: ExtractedContent = {
      text: "",
      attachments: [],
      unsupported: [unsupportedToken(contentType)],
    };
    collectMetadataAttachments(message["metadata"], extracted);
    return extracted;
  }
  const extracted: ExtractedContent = {
    text: "",
    attachments: [],
    unsupported: [],
  };
  const lines: string[] = [];
  parts.forEach((part, index) => {
    if (typeof part === "string") {
      lines.push(part);
      return;
    }
    if (!isPlainObject(part)) {
      extracted.unsupported.push("non_object_part");
      return;
    }
    const type =
      typeof part["content_type"] === "string"
        ? part["content_type"]
        : typeof part["type"] === "string"
          ? part["type"]
          : "unknown";
    if (INSTRUCTION_CONTENT_TYPES.has(type)) {
      extracted.unsupported.push(unsupportedToken(type));
      return;
    }
    const pointer = nonEmptyString(part["asset_pointer"]);
    if (
      ATTACHMENT_TYPES.has(type) ||
      (pointer !== undefined && !TEXT_CONTENT_TYPES.has(type))
    ) {
      const filename =
        typeof part["filename"] === "string" ? part["filename"] : undefined;
      const size = integerByteSize(part["size_bytes"] ?? part["size"]);
      const ref = makeAttachmentRef({
        id:
          pointer ??
          nonEmptyString(part["file_id"]) ??
          nonEmptyString(part["filename"]) ??
          `${type}:${index}`,
        mediaType: ATTACHMENT_TYPES.has(type)
          ? mediaTypeForPart(type)
          : undefined,
        filename,
        byteSize: size,
      });
      if (ref === undefined) {
        extracted.unsupported.push(unsupportedToken(type));
        extracted.rejectedAttachment = true;
      } else addAttachment(extracted, ref, unsupportedToken(type));
      if (typeof part["text"] === "string" && part["text"].length > 0) {
        lines.push(part["text"]);
      }
      return;
    }
    if (TEXT_CONTENT_TYPES.has(type)) {
      if (typeof part["text"] === "string") lines.push(part["text"]);
      return;
    }
    if (typeof part["text"] === "string") {
      if (part["text"].length > 0) lines.push(part["text"]);
      extracted.unsupported.push(unsupportedToken(type));
      return;
    }
    extracted.unsupported.push(unsupportedToken(type));
  });
  if (
    !usingPartsArray &&
    typeof content["content_type"] === "string" &&
    !TEXT_CONTENT_TYPES.has(content["content_type"])
  ) {
    extracted.unsupported.push(unsupportedToken(content["content_type"]));
  }
  extracted.text = lines.join("\n");
  collectMetadataAttachments(message["metadata"], extracted);
  return extracted;
}

function collectMetadataAttachments(
  metadata: unknown,
  extracted: ExtractedContent,
): void {
  if (metadata === undefined || metadata === null) return;
  if (!isPlainObject(metadata)) {
    extracted.unsupported.push("malformed_metadata");
    return;
  }
  if (metadata["attachments"] === undefined) return;
  const listed = metadata["attachments"];
  if (!Array.isArray(listed)) {
    extracted.unsupported.push("malformed_attachments");
    return;
  }
  listed.forEach((raw, index) => {
    if (!isPlainObject(raw)) {
      extracted.unsupported.push("non_object_attachment");
      return;
    }
    const ref = makeAttachmentRef({
      id:
        nonEmptyString(raw["id"]) ??
        nonEmptyString(raw["file_id"]) ??
        nonEmptyString(raw["name"]) ??
        nonEmptyString(raw["filename"]) ??
        `attachment:${index}`,
      mediaType:
        nonEmptyString(raw["mime_type"]) ??
        nonEmptyString(raw["mimeType"]) ??
        nonEmptyString(raw["file_type"]),
      filename:
        nonEmptyString(raw["name"]) ?? nonEmptyString(raw["filename"]),
      byteSize: integerByteSize(
        raw["size"] ?? raw["size_bytes"] ?? raw["file_size"],
      ),
    });
    if (ref === undefined) {
      extracted.unsupported.push("invalid_attachment");
      extracted.rejectedAttachment = true;
      return;
    }
    addAttachment(extracted, ref, "invalid_attachment");
  });
}

function fitsUtf8(value: string, maxBytes: number): boolean {
  return (
    value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function metadataString(value: string): string | undefined {
  return fitsUtf8(value, EVENT_LIMITS.metadataStringBytes) ? value : undefined;
}

function unsupportedToken(value: string): string {
  return metadataString(value) ?? "oversize_content_type";
}

function attachmentAdmitted(ref: AttachmentRef): boolean {
  return validateEventInput({
    schema: "kizuki.event/v1",
    connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
    source_record_id: "chatgpt-attachment",
    kind: "message",
    occurred_at: "2026-01-01T00:00:00.000Z",
    observed_at: "2026-01-01T00:00:00.000Z",
    text: "",
    subjects: [{ subject_id: "chatgpt:self", role: "from" }],
    deleted: false,
    attachments: [ref],
    metadata: {},
  }).ok;
}

function attachmentDedupeKey(id: string): string {
  return id.startsWith(FILE_SERVICE_PREFIX)
    ? id.slice(FILE_SERVICE_PREFIX.length)
    : id;
}

function makeAttachmentRef(input: {
  id: string;
  mediaType?: string | undefined;
  filename?: string | undefined;
  byteSize?: number | undefined;
}): AttachmentRef | undefined {
  if (input.id.length === 0 || !fitsUtf8(input.id, EVENT_LIMITS.attachmentIdBytes)) {
    return undefined;
  }
  const safeName =
    input.filename !== undefined ? safeFilename(input.filename) : null;
  const filenameCandidate =
    safeName !== null && fitsUtf8(safeName, EVENT_LIMITS.filenameBytes)
      ? safeName
      : undefined;
  const declared =
    input.mediaType !== undefined &&
    input.mediaType.length > 0 &&
    fitsUtf8(input.mediaType, EVENT_LIMITS.mediaTypeBytes)
      ? input.mediaType
      : undefined;
  const fallback =
    safeName !== null ? mediaTypeFor(safeName) : "application/octet-stream";
  const candidate = (
    filename: string | undefined,
    media_type: string,
  ): AttachmentRef => ({
    attachment_id: input.id,
    media_type,
    ...(filename !== undefined ? { filename } : {}),
    ...(input.byteSize !== undefined ? { byte_size: input.byteSize } : {}),
  });
  if (!attachmentAdmitted(candidate(undefined, fallback))) return undefined;
  const filename =
    filenameCandidate !== undefined &&
    attachmentAdmitted(candidate(filenameCandidate, fallback))
      ? filenameCandidate
      : undefined;
  const media_type =
    declared !== undefined && attachmentAdmitted(candidate(undefined, declared))
      ? declared
      : fallback;
  return candidate(filename, media_type);
}

function mergeAttachmentEvidence(
  target: AttachmentRef,
  incoming: AttachmentRef,
): void {
  if (target.filename === undefined && incoming.filename !== undefined) {
    target.filename = incoming.filename;
  }
  if (
    incoming.media_type !== "application/octet-stream" &&
    incoming.media_type !== target.media_type
  ) {
    target.media_type = incoming.media_type;
  }
  if (target.byte_size === undefined && incoming.byte_size !== undefined) {
    target.byte_size = incoming.byte_size;
  }
}

function addAttachment(
  extracted: ExtractedContent,
  ref: AttachmentRef,
  overflowToken: string,
): void {
  const key = attachmentDedupeKey(ref.attachment_id);
  const existing = extracted.attachments.find(
    (item) => attachmentDedupeKey(item.attachment_id) === key,
  );
  if (existing !== undefined) {
    mergeAttachmentEvidence(existing, ref);
    return;
  }
  if (extracted.attachments.length >= EVENT_LIMITS.attachmentCount) {
    extracted.unsupported.push(overflowToken);
    return;
  }
  extracted.attachments.push(ref);
}

function mediaTypeForPart(type: string): string {
  if (type === "image" || type === "image_asset_pointer") return "image/*";
  if (type === "audio" || type === "audio_asset_pointer") return "audio/*";
  if (
    type === "video_asset_pointer" ||
    type === "real_time_user_audio_video_asset_pointer"
  ) {
    return "video/*";
  }
  return "application/octet-stream";
}

function integerByteSize(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function mappingFingerprint(mapping: unknown): string {
  if (!isPlainObject(mapping)) return "";
  return Object.keys(mapping).sort().join(",");
}
