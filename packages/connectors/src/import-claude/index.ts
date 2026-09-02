import { isPlainObject } from "@kizuki/core";
import type {
  CaptureEventInput,
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import { KizukiError } from "../errors";
import {
  normalizedDate,
  parseJsonArray,
  pathHealth,
  readUtf8,
  requirePathConfig,
} from "../util";

export const CLAUDE_IMPORT_CONNECTOR_ID = "kizuki.import-claude" as const;

export interface ClaudeImportConfig {
  path: string;
}

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
  version: "0.1.0",
  kinds: ["message"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: false,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: false,
  auth_modes: ["none"],
};

export class ClaudeImportConnector implements Connector {
  readonly path: string;

  constructor(config: ClaudeImportConfig) {
    this.path = requirePathConfig(config, CLAUDE_IMPORT_CONNECTOR_ID);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  health() {
    return pathHealth(this.path, "file");
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(_cursor: Cursor | null): Promise<SyncBatch> {
    const source = await readUtf8(this.path, CLAUDE_IMPORT_CONNECTOR_ID);
    return { events: parseClaudeExport(source), cursor: null };
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
    return parseClaudeExport(JSON.stringify(CLAUDE_FIXTURE_EXPORT));
  }
}

export function createClaudeImportConnector(
  config: ClaudeImportConfig,
): ClaudeImportConnector {
  return new ClaudeImportConnector(config);
}

export function parseClaudeExport(
  source: string,
  observedAt = new Date().toISOString(),
): CaptureEventInput[] {
  const conversations = parseJsonArray(source, CLAUDE_IMPORT_CONNECTOR_ID);
  const observed = normalizedDate(
    observedAt,
    new Date().toISOString(),
    "date",
  );
  const events: CaptureEventInput[] = [];

  conversations.forEach((rawConversation) => {
    if (!isPlainObject(rawConversation)) return;
    const conversationId = rawConversation["uuid"];
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new KizukiError(
        "parse_error",
        `${CLAUDE_IMPORT_CONNECTOR_ID}: conversation uuid is required`,
      );
    }
    const title =
      typeof rawConversation["name"] === "string"
        ? rawConversation["name"]
        : "";
    const conversationTime = normalizedDate(
      rawConversation["created_at"],
      observed,
      "date",
    );
    const messages = rawConversation["chat_messages"];
    if (!Array.isArray(messages)) return;

    for (const rawMessage of messages) {
      if (!isPlainObject(rawMessage)) continue;
      const messageId = rawMessage["uuid"];
      if (typeof messageId !== "string" || messageId.length === 0) {
        throw new KizukiError(
          "parse_error",
          `${CLAUDE_IMPORT_CONNECTOR_ID}: message uuid is required`,
        );
      }
      const sender = rawMessage["sender"];
      if (sender !== "human" && sender !== "assistant") continue;
      const text = rawMessage["text"];
      if (typeof text !== "string" || text.trim().length === 0) continue;

      const handle = sender === "human" ? "self" : "assistant";
      events.push({
        schema: "kizuki.event/v1",
        connector_id: CLAUDE_IMPORT_CONNECTOR_ID,
        source_record_id: `${conversationId}/${messageId}`,
        kind: "message",
        occurred_at: normalizedDate(
          rawMessage["created_at"],
          conversationTime,
          "date",
        ),
        observed_at: observed,
        text,
        subjects: [
          {
            subject_id: `claude:${handle}`,
            role: "from",
          },
        ],
        deleted: false,
        attachments: [],
        metadata: {
          handle,
          namespace: "claude",
          conversation_title: title,
        },
      });
    }
  });

  return events;
}
