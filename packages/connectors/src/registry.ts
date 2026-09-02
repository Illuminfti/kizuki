import type { Connector } from "@kizuki/core";
import {
  SCREENPIPE_CONNECTOR_ID,
  createScreenpipeConnector,
} from "@kizuki/connector-screenpipe";
import type { ScreenpipeConfig } from "@kizuki/connector-screenpipe";
import {
  CHATGPT_IMPORT_CONNECTOR_ID,
  createChatGptImportConnector,
} from "./import-chatgpt";
import type { ChatGptImportConfig } from "./import-chatgpt";
import {
  CLAUDE_IMPORT_CONNECTOR_ID,
  createClaudeImportConnector,
} from "./import-claude";
import type { ClaudeImportConfig } from "./import-claude";
import {
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createMarkdownFolderConnector,
} from "./markdown-folder";
import type { MarkdownFolderConfig } from "./markdown-folder";
import { KizukiError } from "./errors";

export const REGISTRY = Object.freeze({
  [SCREENPIPE_CONNECTOR_ID]: createScreenpipeConnector,
  [MARKDOWN_FOLDER_CONNECTOR_ID]: createMarkdownFolderConnector,
  [CHATGPT_IMPORT_CONNECTOR_ID]: createChatGptImportConnector,
  [CLAUDE_IMPORT_CONNECTOR_ID]: createClaudeImportConnector,
});

export type ConnectorId = keyof typeof REGISTRY;

export function getConnector(
  id: typeof SCREENPIPE_CONNECTOR_ID,
  config: ScreenpipeConfig,
): Connector;
export function getConnector(
  id: typeof MARKDOWN_FOLDER_CONNECTOR_ID,
  config: MarkdownFolderConfig,
): Connector;
export function getConnector(
  id: typeof CHATGPT_IMPORT_CONNECTOR_ID,
  config: ChatGptImportConfig,
): Connector;
export function getConnector(
  id: typeof CLAUDE_IMPORT_CONNECTOR_ID,
  config: ClaudeImportConfig,
): Connector;
export function getConnector(id: string, config?: unknown): Connector;
export function getConnector(id: string, config?: unknown): Connector {
  switch (id) {
    case SCREENPIPE_CONNECTOR_ID:
      return createScreenpipeConnector(config as ScreenpipeConfig);
    case MARKDOWN_FOLDER_CONNECTOR_ID:
      return createMarkdownFolderConnector(config as MarkdownFolderConfig);
    case CHATGPT_IMPORT_CONNECTOR_ID:
      return createChatGptImportConnector(config as ChatGptImportConfig);
    case CLAUDE_IMPORT_CONNECTOR_ID:
      return createClaudeImportConnector(config as ClaudeImportConfig);
    default:
      throw new KizukiError(
        "unknown_connector",
        `unknown connector: ${id}`,
      );
  }
}
