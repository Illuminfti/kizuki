import {
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
import {
  isoToRfc3339,
  nonEmptyString,
  parseJsonArray,
  requireKnownKeys,
  requirePathConfig,
} from "../util";
import type { ImportParseResult, ImportRecordError } from "../import-report";
import { notSupported } from "../errors";
import {
  IMPORT_SNAPSHOT_CURSOR_SCHEMA,
  runSnapshot,
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

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
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
  ...policyForConnector(CLAUDE_IMPORT_CONNECTOR_ID),
  auth_modes: ["none"],
});

const SNAPSHOT: SnapshotParse = {
  connectorId: CLAUDE_IMPORT_CONNECTOR_ID,
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
    return runSnapshot(this.path, cursor, SNAPSHOT);
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(_subject_id: string): Promise<PurgePlan> {
    return notSupported(CLAUDE_IMPORT_CONNECTOR_ID, "purge");
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
  const conversations = parseJsonArray(source, CLAUDE_IMPORT_CONNECTOR_ID);
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
      if (
        extracted.text.trim().length === 0 &&
        extracted.attachments.length === 0 &&
        extracted.extracts.length === 0
      ) {
        pushUnsupported(errors, location, extracted.unsupported);
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
        pushUnsupported(errors, location, extracted.unsupported);
        errors.push({
          location,
          code: "invalid_timestamp",
          reason: "message created_at is missing or invalid",
        });
        return;
      }

      const sourceText = joinedClaudeText(extracted.text, extracted.extracts);
      const messageId =
        nonEmptyString(rawMessage["uuid"]) ??
        fallbackSourcePart("message", [
          conversationId,
          sender,
          sourceText,
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
      const fingerprint = JSON.stringify({
        attachments: extracted.attachments,
        occurred_at: occurredAt,
        text: sourceText,
        unsupported: extracted.unsupported,
      });
      const prior = seen.get(sourceRecordId);
      if (prior !== undefined) {
        pushUnsupported(errors, location, extracted.unsupported);
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

      const fitted = fitClaudeDraft(
        {
          location,
          sourceRecordId,
          title,
          sender,
          occurredAt,
          nativeText: extracted.text,
          extracts: extracted.extracts,
          attachments: extracted.attachments,
          unsupported: extracted.unsupported,
        },
        observedAt,
      );
      errors.push(...fitted.errors);
      if (fitted.event !== undefined) events.push(fitted.event);
    });
  });

  return { events, errors };
}

const OVERSIZED_EXTRACTED_CONTENT = "oversized_extracted_content";
const OVERSIZED_ATTACHMENTS = "oversized_attachments";

interface ClaudeDraft {
  location: string;
  sourceRecordId: string;
  title: string;
  sender: string;
  occurredAt: string;
  nativeText: string;
  extracts: string[];
  attachments: AttachmentRef[];
  unsupported: string[];
}

interface ExtractedContent {
  text: string;
  extracts: string[];
  attachments: AttachmentRef[];
  unsupported: string[];
  error?: ImportRecordError;
}

function joinedClaudeText(nativeText: string, extracts: readonly string[]): string {
  return nativeText.length === 0
    ? extracts.join("\n")
    : [nativeText, ...extracts].join("\n");
}

function pushUnsupported(
  errors: ImportRecordError[],
  location: string,
  flags: readonly string[],
): void {
  if (flags.length === 0) return;
  errors.push({
    location,
    code: "unsupported_part",
    reason: `unsupported content blocks: ${flags.join(",")}`,
  });
}

function claudeCaptureEvent(input: {
  sourceRecordId: string;
  occurredAt: string;
  observedAt: string;
  text: string;
  handle: string;
  title: string;
  attachments: readonly AttachmentRef[];
  unsupported: readonly string[];
}): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
    source_record_id: input.sourceRecordId,
    kind: "message",
    occurred_at: input.occurredAt,
    observed_at: input.observedAt,
    text: input.text,
    subjects: [{ subject_id: `claude:${input.handle}`, role: "from" }],
    deleted: false,
    attachments: [...input.attachments],
    metadata: {
      handle: input.handle,
      namespace: "claude",
      conversation_title: input.title,
      unsupported_parts: [...input.unsupported],
      export: "claude-conversations.json",
    },
  };
}

/**
 * Native text and exact attachment identities stay. extracted_content is
 * omitted only when this event would miss frozen validateEventInput limits.
 */
function fitClaudeDraft(
  draft: ClaudeDraft,
  observedAt: string,
): { event?: CaptureEventInput; errors: ImportRecordError[] } {
  const handle = draft.sender === "human" ? "self" : "assistant";
  const unsupported = [...draft.unsupported];
  const build = (
    text: string,
    attachments: readonly AttachmentRef[],
  ): CaptureEventInput =>
    claudeCaptureEvent({
      sourceRecordId: draft.sourceRecordId,
      occurredAt: draft.occurredAt,
      observedAt,
      text,
      handle,
      title: draft.title,
      attachments,
      unsupported,
    });
  const oversizedRecord: ImportRecordError = {
    location: draft.location,
    code: "oversized_record",
    reason: "message exceeds frozen ingress limits without extracted content",
  };
  const errors: ImportRecordError[] = [];

  if (!validateEventInput(build(draft.nativeText, [])).ok) {
    pushUnsupported(errors, draft.location, unsupported);
    errors.push(oversizedRecord);
    return { errors };
  }

  const attachments: AttachmentRef[] = [];
  for (const attachment of draft.attachments) {
    if (
      validateEventInput(build(draft.nativeText, [...attachments, attachment]))
        .ok
    ) {
      attachments.push(attachment);
    } else if (!unsupported.includes(OVERSIZED_ATTACHMENTS)) {
      unsupported.push(OVERSIZED_ATTACHMENTS);
    }
  }

  let text = draft.nativeText;
  for (const extract of draft.extracts) {
    const nextText = joinedClaudeText(text, [extract]);
    if (validateEventInput(build(nextText, attachments)).ok) {
      text = nextText;
    } else if (!unsupported.includes(OVERSIZED_EXTRACTED_CONTENT)) {
      unsupported.push(OVERSIZED_EXTRACTED_CONTENT);
    }
  }

  const event = build(text, attachments);
  const body = event.text.trim().length > 0 || event.attachments.length > 0;
  pushUnsupported(errors, draft.location, unsupported);
  if (!body || !validateEventInput(event).ok) {
    errors.push(
      body
        ? oversizedRecord
        : {
            location: draft.location,
            code: "empty_content",
            reason: "message has no text or attachments",
          },
    );
    return { errors };
  }
  return { event, errors };
}

function extractClaudeContent(
  rawMessage: Record<string, unknown>,
  location: string,
): ExtractedContent {
  const attachments: AttachmentRef[] = [];
  const unsupported: string[] = [];
  const byId = new Map<string, AttachmentRef>();
  let unnamedDocuments = 0;
  let unnamedImages = 0;
  const textBlocks: string[] = [];

  const remember = (candidate: AttachmentRef): void => {
    let id = candidate.attachment_id;
    const existing = byId.get(id);
    if (existing !== undefined) {
      if (
        existing.media_type === candidate.media_type &&
        existing.filename === candidate.filename &&
        existing.byte_size === candidate.byte_size
      ) {
        return;
      }
      let suffix = 1;
      while (byId.has(`${candidate.attachment_id}:${suffix}`)) suffix += 1;
      id = `${candidate.attachment_id}:${suffix}`;
    }
    const stored =
      id === candidate.attachment_id
        ? candidate
        : { ...candidate, attachment_id: id };
    byId.set(id, stored);
    attachments.push(stored);
  };

  const blocks = rawMessage["content"];
  if (blocks !== undefined && !Array.isArray(blocks)) {
    return {
      text: "",
      extracts: [],
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
    blocks.forEach((block) => {
      if (!isPlainObject(block)) {
        unsupported.push("non_object_block");
        return;
      }
      const type =
        typeof block["type"] === "string" ? block["type"] : "unknown";
      if (type === "text") {
        if (typeof block["text"] === "string") {
          textBlocks.push(block["text"]);
          return;
        }
        unsupported.push("malformed_text");
        return;
      }
      if (type === "image" || type === "document") {
        const source = isPlainObject(block["source"])
          ? block["source"]
          : undefined;
        const named =
          nonEmptyString(block["id"]) ??
          nonEmptyString(block["file_id"]) ??
          nonEmptyString(block["file_name"]) ??
          nonEmptyString(block["filename"]);
        const filename =
          nonEmptyString(block["file_name"]) ??
          nonEmptyString(block["filename"]);
        remember({
          attachment_id:
            named ??
            `${type}:${type === "image" ? unnamedImages++ : unnamedDocuments++}`,
          media_type:
            nonEmptyString(
              source !== undefined ? source["media_type"] : undefined,
            ) ??
            nonEmptyString(block["media_type"]) ??
            (type === "image" ? "image/*" : "application/octet-stream"),
          ...(filename !== undefined ? { filename } : {}),
        });
        return;
      }
      if (type === "tool_use" || type === "tool_result" || type === "thinking") {
        unsupported.push(type);
        return;
      }
      unsupported.push(type);
    });
  }

  const topLevel =
    typeof rawMessage["text"] === "string" ? rawMessage["text"] : "";
  const text = claudeMessageText(topLevel, textBlocks);
  const extracts: string[] = [];

  const appendExtracted = (value: unknown): void => {
    if (typeof value !== "string" || value.trim().length === 0) return;
    const parts = text.length > 0 ? [text, ...extracts] : extracts;
    if (value === parts.join("\n") || parts.includes(value)) return;
    extracts.push(value);
  };

  const readListed = (
    listed: unknown,
    kind: "attachments" | "files",
  ): void => {
    if (listed === undefined) return;
    if (!Array.isArray(listed)) {
      unsupported.push(
        kind === "attachments" ? "malformed_attachments" : "malformed_files",
      );
      return;
    }
    listed.forEach((item, index) => {
      if (!isPlainObject(item)) {
        unsupported.push(
          kind === "attachments"
            ? "non_object_attachment"
            : "non_object_file",
        );
        return;
      }
      const name =
        nonEmptyString(item["file_name"]) ??
        nonEmptyString(item["filename"]) ??
        `${kind === "files" ? "file" : "attachment"}:${index}`;
      const byteSize =
        typeof item["file_size"] === "number" &&
        Number.isSafeInteger(item["file_size"]) &&
        item["file_size"] >= 0
          ? item["file_size"]
          : undefined;
      remember({
        attachment_id: name,
        media_type:
          nonEmptyString(item["file_type"]) ?? "application/octet-stream",
        filename: name,
        ...(byteSize !== undefined ? { byte_size: byteSize } : {}),
      });
      appendExtracted(item["extracted_content"]);
    });
  };

  readListed(rawMessage["attachments"], "attachments");
  readListed(rawMessage["files"], "files");

  return { text, extracts, attachments, unsupported };
}

/** `text` is the message; content blocks that restate a prefix of it are not stored twice. */
function claudeMessageText(topLevel: string, blockTexts: string[]): string {
  if (blockTexts.length === 0) return topLevel;
  const joined = blockTexts.join("\n");
  if (topLevel.length === 0 || topLevel === joined) return joined;
  let prefix = "";
  for (const block of blockTexts) {
    prefix = prefix.length === 0 ? block : `${prefix}\n${block}`;
    if (prefix === topLevel) return joined;
  }
  return `${topLevel}\n${joined}`;
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
