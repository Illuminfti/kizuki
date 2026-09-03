import type { Connector } from "@kizuki/core";
import {
  ICS_CONNECTOR_ID,
  createIcsConnector,
} from "@kizuki/connector-ics";
import type { IcsConnectorConfig } from "@kizuki/connector-ics";
import {
  IMAP_CONNECTOR_ID,
  createImapConnector,
} from "@kizuki/connector-imap";
import type { ImapConnectorConfig } from "@kizuki/connector-imap";
import {
  SCREENPIPE_CONNECTOR_ID,
  createScreenpipeConnector,
} from "@kizuki/connector-screenpipe";
import type { ScreenpipeConfig } from "@kizuki/connector-screenpipe";
import {
  TELEGRAM_CONNECTOR_ID,
  createTelegramConnector,
} from "@kizuki/connector-telegram";
import type { TelegramConnectorConfig } from "@kizuki/connector-telegram";
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
  WHATSAPP_IMPORT_CONNECTOR_ID,
  createWhatsAppImportConnector,
} from "./import-whatsapp";
import type { WhatsAppImportConfig } from "./import-whatsapp";
import {
  POCKET_IMPORT_CONNECTOR_ID,
  createPocketImportConnector,
} from "./import-pocket";
import type { PocketImportConfig } from "./import-pocket";
import {
  OMNIVORE_IMPORT_CONNECTOR_ID,
  createOmnivoreImportConnector,
} from "./import-omnivore";
import type { OmnivoreImportConfig } from "./import-omnivore";
import {
  LEGACY_EVENTS_CONNECTOR_ID,
  createLegacyEventsConnector,
} from "./import-legacy-events";
import type { LegacyEventsConfig } from "./import-legacy-events";
import {
  LEGACY_WIKI_CONNECTOR_ID,
  createLegacyWikiConnector,
} from "./import-legacy-wiki";
import type { LegacyWikiConfig } from "./import-legacy-wiki";
import {
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createMarkdownFolderConnector,
} from "./markdown-folder";
import type { MarkdownFolderConfig } from "./markdown-folder";
import { KizukiError } from "./errors";

export const REGISTRY = Object.freeze({
  [SCREENPIPE_CONNECTOR_ID]: createScreenpipeConnector,
  [TELEGRAM_CONNECTOR_ID]: createTelegramConnector,
  [MARKDOWN_FOLDER_CONNECTOR_ID]: createMarkdownFolderConnector,
  [CHATGPT_IMPORT_CONNECTOR_ID]: createChatGptImportConnector,
  [CLAUDE_IMPORT_CONNECTOR_ID]: createClaudeImportConnector,
  [IMAP_CONNECTOR_ID]: createImapConnector,
  [ICS_CONNECTOR_ID]: createIcsConnector,
  [WHATSAPP_IMPORT_CONNECTOR_ID]: createWhatsAppImportConnector,
  [POCKET_IMPORT_CONNECTOR_ID]: createPocketImportConnector,
  [OMNIVORE_IMPORT_CONNECTOR_ID]: createOmnivoreImportConnector,
  [LEGACY_WIKI_CONNECTOR_ID]: createLegacyWikiConnector,
  [LEGACY_EVENTS_CONNECTOR_ID]: createLegacyEventsConnector,
});

export type ConnectorId = keyof typeof REGISTRY;

export function getConnector(
  id: typeof SCREENPIPE_CONNECTOR_ID,
  config: ScreenpipeConfig,
): Connector;
export function getConnector(
  id: typeof TELEGRAM_CONNECTOR_ID,
  config: TelegramConnectorConfig,
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
export function getConnector(
  id: typeof IMAP_CONNECTOR_ID,
  config: ImapConnectorConfig,
): Connector;
export function getConnector(
  id: typeof ICS_CONNECTOR_ID,
  config: IcsConnectorConfig,
): Connector;
export function getConnector(
  id: typeof WHATSAPP_IMPORT_CONNECTOR_ID,
  config: WhatsAppImportConfig,
): Connector;
export function getConnector(
  id: typeof POCKET_IMPORT_CONNECTOR_ID,
  config: PocketImportConfig,
): Connector;
export function getConnector(
  id: typeof OMNIVORE_IMPORT_CONNECTOR_ID,
  config: OmnivoreImportConfig,
): Connector;
export function getConnector(
  id: typeof LEGACY_WIKI_CONNECTOR_ID,
  config: LegacyWikiConfig,
): Connector;
export function getConnector(
  id: typeof LEGACY_EVENTS_CONNECTOR_ID,
  config: LegacyEventsConfig,
): Connector;
export function getConnector(id: string, config?: unknown): Connector;
export function getConnector(id: string, config?: unknown): Connector {
  switch (id) {
    case SCREENPIPE_CONNECTOR_ID:
      return createScreenpipeConnector(config as ScreenpipeConfig);
    case TELEGRAM_CONNECTOR_ID:
      return createTelegramConnector(config as TelegramConnectorConfig);
    case MARKDOWN_FOLDER_CONNECTOR_ID:
      return createMarkdownFolderConnector(config as MarkdownFolderConfig);
    case CHATGPT_IMPORT_CONNECTOR_ID:
      return createChatGptImportConnector(config as ChatGptImportConfig);
    case CLAUDE_IMPORT_CONNECTOR_ID:
      return createClaudeImportConnector(config as ClaudeImportConfig);
    case IMAP_CONNECTOR_ID:
      return createImapConnector(config as ImapConnectorConfig);
    case ICS_CONNECTOR_ID:
      return createIcsConnector(config as IcsConnectorConfig);
    case WHATSAPP_IMPORT_CONNECTOR_ID:
      return createWhatsAppImportConnector(config as WhatsAppImportConfig);
    case POCKET_IMPORT_CONNECTOR_ID:
      return createPocketImportConnector(config as PocketImportConfig);
    case OMNIVORE_IMPORT_CONNECTOR_ID:
      return createOmnivoreImportConnector(config as OmnivoreImportConfig);
    case LEGACY_WIKI_CONNECTOR_ID:
      return createLegacyWikiConnector(config as LegacyWikiConfig);
    case LEGACY_EVENTS_CONNECTOR_ID:
      return createLegacyEventsConnector(config as LegacyEventsConfig);
    default:
      throw new KizukiError(
        "unknown_connector",
        `unknown connector: ${id}`,
      );
  }
}
