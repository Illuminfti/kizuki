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
import {
  compareStrings,
  normalizedDate,
  parseJsonArray,
  pathHealth,
  readUtf8,
  requirePathConfig,
} from "../util";

export const CHATGPT_IMPORT_CONNECTOR_ID = "kizuki.import-chatgpt" as const;

export interface ChatGptImportConfig {
  path: string;
}

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

export class ChatGptImportConnector implements Connector {
  readonly path: string;

  constructor(config: ChatGptImportConfig) {
    this.path = requirePathConfig(config, CHATGPT_IMPORT_CONNECTOR_ID);
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  health() {
    return pathHealth(this.path, "file");
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(_cursor: Cursor | null): Promise<SyncBatch> {
    const source = await readUtf8(this.path, CHATGPT_IMPORT_CONNECTOR_ID);
    return { events: parseChatGptExport(source), cursor: null };
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
    return parseChatGptExport(JSON.stringify(CHATGPT_FIXTURE_EXPORT));
  }
}

export function createChatGptImportConnector(
  config: ChatGptImportConfig,
): ChatGptImportConnector {
  return new ChatGptImportConnector(config);
}

export function parseChatGptExport(
  source: string,
  observedAt = new Date().toISOString(),
): CaptureEventInput[] {
  const conversations = parseJsonArray(source, CHATGPT_IMPORT_CONNECTOR_ID);
  const observed = normalizedDate(
    observedAt,
    new Date().toISOString(),
    "date",
  );
  const events: CaptureEventInput[] = [];

  conversations.forEach((rawConversation, conversationIndex) => {
    if (!isPlainObject(rawConversation)) return;
    const rawId =
      nonEmptyString(rawConversation["id"]) ??
      nonEmptyString(rawConversation["conversation_id"]);
    const conversationId = rawId ?? String(conversationIndex);
    const title =
      typeof rawConversation["title"] === "string"
        ? rawConversation["title"]
        : "";
    const conversationTime = normalizedDate(
      rawConversation["create_time"],
      observed,
      "seconds",
    );
    const mapping = rawConversation["mapping"];
    if (!isPlainObject(mapping)) return;

    const nodes = Object.entries(mapping).sort(([a], [b]) =>
      compareStrings(a, b),
    );
    for (const [nodeId, rawNode] of nodes) {
      if (!isPlainObject(rawNode) || !isPlainObject(rawNode["message"])) {
        continue;
      }
      const message = rawNode["message"];
      if (
        !isPlainObject(message["author"]) ||
        !isPlainObject(message["content"])
      ) {
        continue;
      }
      const role = message["author"]["role"];
      if (role !== "user" && role !== "assistant") continue;
      const parts = message["content"]["parts"];
      if (!Array.isArray(parts)) continue;
      const text = parts
        .filter((part): part is string => typeof part === "string")
        .join("\n");
      if (text.trim().length === 0) continue;

      const handle = role === "user" ? "self" : "assistant";
      events.push({
        schema: "kizuki.event/v1",
        connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
        source_record_id: `${conversationId}/${nodeId}`,
        kind: "message",
        occurred_at: normalizedDate(
          message["create_time"],
          conversationTime,
          "seconds",
        ),
        observed_at: observed,
        text,
        subjects: [
          {
            subject_id: `chatgpt:${handle}`,
            role: "from",
          },
        ],
        deleted: false,
        attachments: [],
        metadata: {
          handle,
          namespace: "chatgpt",
          conversation_title: title,
        },
      });
    }
  });

  return events;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
