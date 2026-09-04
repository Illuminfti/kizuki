import {
  PORT_CONTRACTS,
  PortError,
  PortRegistry,
  assertPortContract,
  freezeManifest,
  validatePortDescriptor,
} from "@kizuki/core";
import type { Connector, PortDescriptor } from "@kizuki/core";
import {
  ICS_CONNECTOR_ID,
  ICS_CURSOR_SCHEMA,
  createIcsConnector,
} from "@kizuki/connector-ics";
import type { IcsConnectorConfig } from "@kizuki/connector-ics";
import {
  IMAP_CONNECTOR_ID,
  IMAP_CURSOR_SCHEMA,
  createImapConnector,
} from "@kizuki/connector-imap";
import type { ImapConnectorConfig } from "@kizuki/connector-imap";
import {
  SCREENPIPE_CONNECTOR_ID,
  SCREENPIPE_CURSOR_SCHEMA,
  createScreenpipeConnector,
} from "@kizuki/connector-screenpipe";
import type { ScreenpipeConfig } from "@kizuki/connector-screenpipe";
import {
  TELEGRAM_CONNECTOR_ID,
  TELEGRAM_CURSOR_SCHEMA,
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
  LEGACY_EVENTS_CURSOR_SCHEMA,
  createLegacyEventsConnector,
} from "./import-legacy-events";
import type { LegacyEventsConfig } from "./import-legacy-events";
import {
  LEGACY_WIKI_CONNECTOR_ID,
  LEGACY_WIKI_CURSOR_SCHEMA,
  createLegacyWikiConnector,
} from "./import-legacy-wiki";
import type { LegacyWikiConfig } from "./import-legacy-wiki";
import {
  MARKDOWN_CURSOR_SCHEMA,
  MARKDOWN_FOLDER_CONNECTOR_ID,
  createMarkdownFolderConnector,
} from "./markdown-folder";
import type { MarkdownFolderConfig } from "./markdown-folder";
import { IMPORT_SNAPSHOT_CURSOR_SCHEMA } from "./import-snapshot";
import { KizukiError } from "./errors";
import type { Manifest } from "@kizuki/core";

export type ConnectorFactory = (config?: unknown) => Connector;

export interface ManifestOverlay {
  contract_minor: number;
  implementation: string;
  allowed_egress: readonly string[];
  cursor_schema: string | null;
  default_sensitivity?: Manifest["default_sensitivity"];
  sensitivity_floor?: Manifest["sensitivity_floor"];
}

const DEFAULT_TIMEOUTS = Object.freeze({
  health: 10_000,
  connect: 30_000,
  backfill: 60_000,
  sync: 60_000,
  revoke: 30_000,
  purgeSource: 30_000,
  signIn: 120_000,
  fixture: 10_000,
});

function portId(connectorId: string): string {
  return connectorId.replace(/^kizuki\./, "kizuki.connector.");
}

export class ConnectorRegistry {
  readonly #ports = new PortRegistry();
  readonly #factories = new Map<string, ConnectorFactory>();
  readonly #overlays = new Map<string, ManifestOverlay>();
  readonly #portIds = new Map<string, string>();

  register(
    connectorId: string,
    descriptor: PortDescriptor,
    factory: ConnectorFactory,
    overlay: ManifestOverlay,
  ): void {
    if (typeof connectorId !== "string" || connectorId.length === 0) {
      throw new PortError("config_invalid", "connector id is invalid", false);
    }
    if (this.#factories.has(connectorId)) {
      throw new PortError(
        "config_invalid",
        `connector ${connectorId} is already registered`,
        false,
      );
    }
    const validated = validatePortDescriptor(descriptor);
    assertPortContract(validated, "connector");
    this.#ports.registerPort(validated, (ctx) => factory(ctx.config));
    this.#factories.set(connectorId, factory);
    this.#overlays.set(connectorId, Object.freeze({ ...overlay }));
    this.#portIds.set(connectorId, validated.id);
  }

  get(id: string, config?: unknown): Connector {
    const factory = this.#factories.get(id);
    const overlay = this.#overlays.get(id);
    if (factory === undefined || overlay === undefined) {
      throw new KizukiError("unknown_connector", `unknown connector: ${id}`);
    }
    return sealConnector(factory(config), overlay);
  }

  /** Apply the registered overlay to a connector the host already constructed. */
  seal(connector: Connector): Connector {
    const id = connector.manifest().connector_id;
    const overlay = this.#overlays.get(id);
    if (overlay === undefined) {
      throw new KizukiError("unknown_connector", `unknown connector: ${id}`);
    }
    return sealConnector(connector, overlay);
  }

  list(): readonly PortDescriptor[] {
    return Object.freeze(this.#ports.listPorts("connector"));
  }

  ids(): readonly string[] {
    return Object.freeze([...this.#factories.keys()].sort());
  }

  asFactories(): Readonly<Record<string, ConnectorFactory>> {
    return Object.freeze(Object.fromEntries(this.#factories));
  }
}

export function sealConnector(
  connector: Connector,
  overlay: ManifestOverlay,
): Connector {
  const raw = connector.manifest();
  const {
    default_sensitivity: rawDefault,
    sensitivity_floor: rawFloor,
    ...rest
  } = raw;
  const merged: Manifest = {
    ...rest,
    contract_minor: rest.contract_minor ?? overlay.contract_minor,
    implementation: rest.implementation ?? overlay.implementation,
    allowed_egress: rest.allowed_egress ?? overlay.allowed_egress,
    cursor_schema:
      rest.cursor_schema !== undefined
        ? rest.cursor_schema
        : overlay.cursor_schema,
  };
  const default_sensitivity = rawDefault ?? overlay.default_sensitivity;
  if (default_sensitivity !== undefined) {
    merged.default_sensitivity = default_sensitivity;
  }
  const sensitivity_floor = rawFloor ?? overlay.sensitivity_floor;
  if (sensitivity_floor !== undefined) {
    merged.sensitivity_floor = sensitivity_floor;
  }
  const manifest = freezeManifest(merged);
  return {
    manifest: () => manifest,
    health: () => connector.health(),
    connect: (resolve) => connector.connect(resolve),
    backfill: (cursor) => connector.backfill(cursor),
    sync: (cursor) => connector.sync(cursor),
    revoke: () => connector.revoke(),
    ...(typeof connector.signIn === "function"
      ? {
          signIn: (io, state) => connector.signIn!(io, state),
        }
      : {}),
    purgeSource: (subjectId) => connector.purgeSource(subjectId),
    fixture: () => connector.fixture(),
  };
}

function describe(
  connectorId: string,
  supports: readonly string[],
  optionalPackage: string | null,
): PortDescriptor {
  return validatePortDescriptor({
    id: portId(connectorId),
    kind: "connector",
    contract: PORT_CONTRACTS.connector,
    contract_minor: 1,
    supports,
    requires_lease: false,
    optional_package: optionalPackage,
    method_timeouts_ms: DEFAULT_TIMEOUTS,
  });
}

const IN_TREE = "@kizuki/connectors";

export const defaultConnectorRegistry = new ConnectorRegistry();

function enroll(
  connectorId: string,
  supports: readonly string[],
  optionalPackage: string | null,
  factory: ConnectorFactory,
  overlay: ManifestOverlay,
): void {
  defaultConnectorRegistry.register(
    connectorId,
    describe(connectorId, supports, optionalPackage),
    factory,
    overlay,
  );
}

const LOCAL: ManifestOverlay = {
  contract_minor: 1,
  implementation: IN_TREE,
  allowed_egress: [],
  cursor_schema: null,
};

enroll(
  SCREENPIPE_CONNECTOR_ID,
  ["backfill", "sync", "fixture"],
  "@kizuki/connector-screenpipe",
  (config) => createScreenpipeConnector(config as ScreenpipeConfig),
  {
    contract_minor: 1,
    implementation: "@kizuki/connector-screenpipe",
    allowed_egress: [],
    cursor_schema: SCREENPIPE_CURSOR_SCHEMA,
    default_sensitivity: "private",
    sensitivity_floor: "private",
  },
);
enroll(
  TELEGRAM_CONNECTOR_ID,
  ["backfill", "sync", "purge", "fixture", "sign_in"],
  "@kizuki/connector-telegram",
  (config) => createTelegramConnector(config as TelegramConnectorConfig),
  {
    contract_minor: 1,
    implementation: "@kizuki/connector-telegram",
    allowed_egress: ["telegram.org"],
    cursor_schema: TELEGRAM_CURSOR_SCHEMA,
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  },
);
enroll(
  MARKDOWN_FOLDER_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "fixture"],
  IN_TREE,
  (config) => createMarkdownFolderConnector(config as MarkdownFolderConfig),
  { ...LOCAL, cursor_schema: MARKDOWN_CURSOR_SCHEMA },
);
enroll(
  CHATGPT_IMPORT_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "fixture"],
  IN_TREE,
  (config) => createChatGptImportConnector(config as ChatGptImportConfig),
  { ...LOCAL, cursor_schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA },
);
enroll(
  CLAUDE_IMPORT_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "fixture"],
  IN_TREE,
  (config) => createClaudeImportConnector(config as ClaudeImportConfig),
  { ...LOCAL, cursor_schema: IMPORT_SNAPSHOT_CURSOR_SCHEMA },
);
enroll(
  IMAP_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "purge", "fixture", "sign_in"],
  "@kizuki/connector-imap",
  (config) => createImapConnector(config as ImapConnectorConfig),
  {
    contract_minor: 1,
    implementation: "@kizuki/connector-imap",
    allowed_egress: [],
    cursor_schema: IMAP_CURSOR_SCHEMA,
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  },
);
enroll(
  ICS_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "fixture", "sign_in"],
  "@kizuki/connector-ics",
  (config) => createIcsConnector(config as IcsConnectorConfig),
  {
    contract_minor: 1,
    implementation: "@kizuki/connector-ics",
    allowed_egress: [],
    cursor_schema: ICS_CURSOR_SCHEMA,
    default_sensitivity: "private",
    sensitivity_floor: "personal",
  },
);
enroll(
  WHATSAPP_IMPORT_CONNECTOR_ID,
  ["backfill", "sync", "purge", "fixture"],
  IN_TREE,
  (config) => createWhatsAppImportConnector(config as WhatsAppImportConfig),
  LOCAL,
);
enroll(
  POCKET_IMPORT_CONNECTOR_ID,
  ["backfill", "sync", "purge", "fixture"],
  IN_TREE,
  (config) => createPocketImportConnector(config as PocketImportConfig),
  LOCAL,
);
enroll(
  OMNIVORE_IMPORT_CONNECTOR_ID,
  ["backfill", "sync", "purge", "fixture"],
  IN_TREE,
  (config) => createOmnivoreImportConnector(config as OmnivoreImportConfig),
  LOCAL,
);
enroll(
  LEGACY_WIKI_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "fixture"],
  IN_TREE,
  (config) => createLegacyWikiConnector(config as LegacyWikiConfig),
  { ...LOCAL, cursor_schema: LEGACY_WIKI_CURSOR_SCHEMA },
);
enroll(
  LEGACY_EVENTS_CONNECTOR_ID,
  ["backfill", "sync", "tombstones", "fixture"],
  IN_TREE,
  (config) => createLegacyEventsConnector(config as LegacyEventsConfig),
  { ...LOCAL, cursor_schema: LEGACY_EVENTS_CURSOR_SCHEMA },
);

export const REGISTRY = defaultConnectorRegistry.asFactories();
export type ConnectorId = keyof typeof REGISTRY;

export function listConnectorDescriptors(): readonly PortDescriptor[] {
  return defaultConnectorRegistry.list();
}

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
  return defaultConnectorRegistry.get(id, config);
}
