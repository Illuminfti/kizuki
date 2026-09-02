import { lstat, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HealthReport } from "@kizuki/core";
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
import { readBoundedUtf8 } from "../read";
import {
  FIXTURE_OBSERVED_AT,
  MAX_EXPORT_BYTES,
  compareStrings,
  errorMessage,
  requireKnownKeys,
  requirePathConfig,
  safeFilename,
} from "../util";
import { isDateOrder, resolveTimezone } from "./dates";
import type { DateOrder } from "./dates";
import { fsMediaLookup, mapMediaLookup } from "./media";
import { WHATSAPP_IMPORT_CONNECTOR_ID, parseWhatsAppExport } from "./map";

export { WHATSAPP_IMPORT_CONNECTOR_ID, parseWhatsAppExport } from "./map";
export type { WhatsAppParseOptions } from "./map";
export { detectMedia, fsMediaLookup, mapMediaLookup } from "./media";
export type { MediaLookup, MediaRef } from "./media";
export { MESSAGE_START, splitWhatsAppMessages } from "./grammar";
export type { ParsedWhatsAppMessage } from "./grammar";
export { detectDateOrder, localToUtc, resolveTimezone } from "./dates";
export type { DateOrder, RawDate, RawTime } from "./dates";

export interface WhatsAppImportConfig {
  /** The unzipped export directory (exactly one .txt inside) or the chat .txt. */
  path: string;
  /** Overrides detection when the export's dates stay ambiguous. */
  date_order?: DateOrder;
  /** IANA zone or fixed offset; defaults to the host's zone. */
  timezone?: string;
  /** The sender display name that is the owner. */
  self?: string;
  /** Chat display name; defaults to the one in the file name. */
  chat?: string;
}

const CONFIG_KEYS = ["path", "date_order", "timezone", "self", "chat"];

export const WHATSAPP_FIXTURE_TIMEZONE = "+00:00";

const FIXTURE_CHAT_FILE = "WhatsApp Chat with Acme Planning.txt";

const FIXTURE_CHAT = `${[
  "1/4/26, 9:15 AM - Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.",
  "1/4/26, 9:15 AM - Ada: Morning all. Planning for the acme launch starts today.",
  "1/4/26, 9:16 AM - Grace: Morning! Two things:",
  "- venue",
  "- budget",
  "1/4/26, 9:16 AM - Linus: ok",
  "1/4/26, 9:16 AM - Linus: ok",
  "1/4/26, 9:20 AM - Ada: IMG-20260104-WA0001.jpg (file attached)",
  "1/4/26, 9:21 AM - Grace: <Media omitted>",
  "1/13/26, 6:05\u202FPM - Linus: Venue booked for the 20th. Café Kōan, 18:00.",
  "2/1/26, 12:00 AM - Ada: Reminder: budget review at noon.",
].join("\n")}\n`;

export const WHATSAPP_FIXTURE_FILES: Readonly<Record<string, string>> =
  Object.freeze({
    [FIXTURE_CHAT_FILE]: FIXTURE_CHAT,
    "IMG-20260104-WA0001.jpg": "fixture-bytes-not-an-image",
  });

const MANIFEST: Manifest = {
  schema: "kizuki.connector/v1",
  connector_id: WHATSAPP_IMPORT_CONNECTOR_ID,
  version: "0.1.0",
  kinds: ["message"],
  capabilities: {
    backfill: true,
    sync: true,
    // An export is a snapshot: a record missing from the next one may have
    // been deleted, or the export may simply be shorter. Never inferred.
    tombstones: false,
    purge: true,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  auth_modes: ["none"],
};

function misconfigured(detail: string): KizukiError {
  return new KizukiError(
    "misconfigured",
    `${WHATSAPP_IMPORT_CONNECTOR_ID}: ${detail}`,
  );
}

/**
 * A directory that cannot be listed is a configuration problem like any other
 * unreadable path, so it leaves as a refusal callers can discriminate on
 * rather than as whatever the filesystem threw.
 */
async function readEntries(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    throw misconfigured(`cannot read ${path}: ${errorMessage(error)}`);
  }
}

interface ResolvedExport {
  txt: string;
  mediaDir: string;
}

/**
 * An export is either the unzipped folder or the chat file inside it. Neither
 * a symlink nor a zip is followed: the owner unzips, and the importer reads
 * exactly what it was pointed at.
 */
export async function resolveExport(path: string): Promise<ResolvedExport> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    throw misconfigured(`cannot access ${path}: ${errorMessage(error)}`);
  }
  if (path.toLowerCase().endsWith(".zip")) {
    throw misconfigured(`unzip the export first: ${path}`);
  }
  if (info.isFile()) {
    if (!path.toLowerCase().endsWith(".txt")) {
      throw misconfigured(`not a .txt chat export: ${path}`);
    }
    return { txt: path, mediaDir: dirname(path) };
  }
  if (!info.isDirectory()) {
    throw misconfigured(`not a chat export directory or file: ${path}`);
  }
  const entries = await readEntries(path);
  // The chat file's name becomes the chat's display name, and an export
  // directory is attacker-controlled: a name a terminal would act on is not a
  // candidate, so no such name can be adopted as a subject's.
  const texts = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".txt") &&
        safeFilename(entry.name) !== null,
    )
    .map((entry) => entry.name)
    .sort(compareStrings);
  const only = texts[0];
  if (only === undefined) {
    throw misconfigured(`no .txt chat export in ${path}`);
  }
  if (texts.length > 1) {
    throw misconfigured(
      `several .txt files in ${path}; pass the chat file path`,
    );
  }
  return { txt: join(path, only), mediaDir: path };
}

/**
 * The chat name as the export names it. Only the English file-name prefix is
 * recognized; any other locale keeps the stem, which stays readable and can be
 * overridden with `chat`.
 */
export function chatNameFromFile(txtPath: string): string {
  const stem = basename(txtPath).replace(/\.txt$/i, "");
  const prefix = "WhatsApp Chat with ";
  if (stem.startsWith(prefix)) return stem.slice(prefix.length);
  // The iOS export names every chat file `_chat.txt`; the folder carries it.
  if (stem === "_chat") return basename(dirname(txtPath));
  return stem;
}

export class WhatsAppImportConnector implements Connector {
  readonly path: string;
  private readonly dateOrder: DateOrder | undefined;
  private readonly timezone: string;
  private readonly self: string | undefined;
  private readonly chat: string | undefined;

  constructor(config: WhatsAppImportConfig) {
    this.path = requirePathConfig(config, WHATSAPP_IMPORT_CONNECTOR_ID);
    requireKnownKeys(config, WHATSAPP_IMPORT_CONNECTOR_ID, CONFIG_KEYS);
    if (config.date_order !== undefined && !isDateOrder(config.date_order)) {
      throw misconfigured("date_order must be dmy, mdy or ymd");
    }
    this.dateOrder = config.date_order;
    this.timezone = resolveTimezone(config.timezone);
    for (const [key, value] of [
      ["self", config.self],
      ["chat", config.chat],
    ] as const) {
      if (
        value !== undefined &&
        (typeof value !== "string" || value.length === 0)
      ) {
        throw misconfigured(`${key} must be a non-empty string`);
      }
    }
    this.self = config.self;
    this.chat = config.chat;
  }

  manifest(): Manifest {
    return MANIFEST;
  }

  async health(): Promise<HealthReport> {
    const checked_at = new Date().toISOString();
    try {
      await resolveExport(this.path);
      return new HealthReport({ state: "ok", checked_at });
    } catch (error) {
      return new HealthReport({
        state: "misconfigured",
        checked_at,
        detail: errorMessage(error),
      });
    }
  }

  async connect(_resolve: SecretResolver): Promise<void> {}

  async backfill(_cursor: Cursor | null): Promise<SyncBatch> {
    return { events: await this.read(), cursor: null };
  }

  /** An export is exhausted in one batch, so sync is backfill. */
  sync(cursor: Cursor | null): Promise<SyncBatch> {
    return this.backfill(cursor);
  }

  async revoke(): Promise<void> {}

  async purgeSource(subject_id: string): Promise<PurgePlan> {
    const events = await this.read();
    const unreachable = events
      .filter((event) =>
        event.subjects.some((subject) => subject.subject_id === subject_id),
      )
      .map((event) => event.source_record_id)
      .sort(compareStrings);
    return {
      subject_id,
      // The export file is the owner's and is never modified by a purge.
      source_record_ids: [],
      unreachable_source_record_ids: unreachable,
    };
  }

  async fixture(): Promise<CaptureEventInput[]> {
    return parseWhatsAppExport(FIXTURE_CHAT, {
      timezone: WHATSAPP_FIXTURE_TIMEZONE,
      chat: "Acme Planning",
      observed_at: FIXTURE_OBSERVED_AT,
      media: mapMediaLookup(WHATSAPP_FIXTURE_FILES),
    });
  }

  private async read(): Promise<CaptureEventInput[]> {
    const resolved = await resolveExport(this.path);
    const text = await readBoundedUtf8(
      resolved.txt,
      WHATSAPP_IMPORT_CONNECTOR_ID,
      MAX_EXPORT_BYTES,
      // The chat file inside an export is named after the chat, so a refusal
      // names what the owner configured instead of who they were talking to.
      resolved.txt === this.path
        ? this.path
        : `the chat file in ${this.path}`,
    );
    return parseWhatsAppExport(text, {
      ...(this.dateOrder !== undefined ? { date_order: this.dateOrder } : {}),
      timezone: this.timezone,
      ...(this.self !== undefined ? { self: this.self } : {}),
      chat: this.chat ?? chatNameFromFile(resolved.txt),
      observed_at: new Date().toISOString(),
      media: fsMediaLookup(resolved.mediaDir),
    });
  }
}

export function createWhatsAppImportConnector(
  config: WhatsAppImportConfig,
): WhatsAppImportConnector {
  return new WhatsAppImportConnector(config);
}
