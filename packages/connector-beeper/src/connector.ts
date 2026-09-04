import { HealthReport, KizukiError, freezeManifest, isPlainObject } from "@kizuki/core";
import type { AttachmentRef, CaptureEventInput, Connector, Cursor, Manifest, SecretResolver, SyncBatch } from "@kizuki/core";
import { BEEPER_CURSOR_SCHEMA, encodeBeeperCursor, parseBeeperCursor } from "./cursor";

export const BEEPER_CONNECTOR_ID = "kizuki.beeper" as const;
const DEFAULT_BASE_URL = "http://127.0.0.1:23373";
const PAGE_LIMIT = 20;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_ATTACHMENTS = 100;
const MAX_ATTACHMENT_ID_BYTES = 2 * 1024;
const MAX_FILENAME_BYTES = 512;
const MAX_MEDIA_TYPE_BYTES = 256;

export interface BeeperConnectorConfig { base_url?: string; token_secret_ref: string; }
export type BeeperFetch = (input: URL, init: RequestInit) => Promise<Response>;
export interface BeeperConnectorDeps { fetch: BeeperFetch; now: () => Date; }

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1", connector_id: BEEPER_CONNECTOR_ID, version: "0.1.0",
  contract_minor: 1, implementation: "@kizuki/connector-beeper", allowed_egress: ["127.0.0.1"],
  cursor_schema: BEEPER_CURSOR_SCHEMA, kinds: ["message"],
  capabilities: { backfill: true, sync: true, tombstones: true, purge: false, fixture: true },
  required_secrets: [], emits_sensitivity_hint: true,
  default_sensitivity: "private", sensitivity_floor: "personal", auth_modes: ["secret_ref"],
});

interface Config { baseUrl: URL; tokenRef: string; }
interface Message { id: string; accountID: string; chatID: string; senderID?: string; sortKey: string; timestamp: string; text?: string; attachments: Attachment[]; isDeleted?: boolean; editedTimestamp?: string; }
interface Attachment { id?: string; fileName?: string; fileSize?: number; mimeType?: string; type: "unknown" | "img" | "video" | "audio"; }
interface Page { items: Message[]; hasMore: boolean; oldestCursor?: string; newestCursor?: string; }

export class BeeperConnector implements Connector {
  readonly #config: Config;
  readonly #deps: BeeperConnectorDeps;
  readonly #manifest: Manifest;
  #token: string | null = null;
  #revoked = false;
  #lastSuccessAt: string | undefined;

  constructor(config: BeeperConnectorConfig, deps: Partial<BeeperConnectorDeps> = {}) {
    this.#config = parseConfig(config);
    this.#manifest = freezeManifest({ ...MANIFEST, required_secrets: [this.#config.tokenRef] });
    this.#deps = { fetch: deps.fetch ?? ((input, init) => fetch(input, init)), now: deps.now ?? (() => new Date()) };
  }
  manifest(): Manifest { return this.#manifest; }
  async connect(resolve: SecretResolver): Promise<void> {
    this.#assertActive();
    let token: string;
    try { token = await resolve(this.#config.tokenRef); } catch { throw unavailable("connection token could not be resolved"); }
    if (token.length === 0 || new TextEncoder().encode(token).byteLength > 16 * 1024) throw unavailable("connection token is invalid");
    this.#token = token;
  }
  async health(): Promise<HealthReport> {
    const checked_at = this.#deps.now().toISOString();
    if (this.#revoked) return new HealthReport({ state: "disabled", checked_at, detail: "access was revoked" });
    if (this.#token === null) return new HealthReport({ state: "unauthenticated", checked_at, detail: "connect() has not been called" });
    try {
      const response = await this.#request("/v1/info");
      if (response.status === 401 || response.status === 403) return this.#health("unauthenticated", checked_at, "Beeper token was rejected");
      if (response.redirected || !response.ok) return this.#health("unreachable", checked_at, "Beeper Desktop did not accept the health probe");
      const payload = await boundedText(response);
      let parsed: unknown;
      try { parsed = JSON.parse(payload); } catch { return this.#health("misconfigured", checked_at, "Beeper Desktop returned an invalid health response"); }
      return isInfoResponse(parsed)
        ? this.#health("ok", checked_at)
        : this.#health("misconfigured", checked_at, "Beeper Desktop returned an invalid health response");
    } catch { return this.#health("unreachable", checked_at, "Beeper Desktop could not be reached"); }
  }
  backfill(cursor: Cursor | null): Promise<SyncBatch> { return this.#advance(cursor); }
  sync(cursor: Cursor | null): Promise<SyncBatch> { return this.#advance(cursor); }
  async revoke(): Promise<void> { this.#revoked = true; this.#token = null; }
  async purgeSource(_subject_id: string): Promise<never> {
    this.#assertActive();
    throw new KizukiError("not_supported", "kizuki.beeper: source-side deletion is not supported by this read-only connector");
  }
  async fixture(): Promise<CaptureEventInput[]> {
    return [mapMessage({ id: "message-1", accountID: "account-1", chatID: "chat-1", senderID: "user-1", sortKey: "1", timestamp: "2026-01-02T03:04:05.000Z", text: "Synthetic Beeper message", attachments: [] }, "2026-01-02T03:04:06.000Z")];
  }
  async #advance(cursor: Cursor | null): Promise<SyncBatch> {
    this.#assertConnected();
    const prior = cursor === null ? null : parseBeeperCursor(cursor).cursor;
    let page: Page;
    try { page = await this.#read(prior); } catch (error) {
      if (error instanceof KizukiError && error.code !== "unreachable") throw error;
      return { events: [], cursor, status: "unavailable", detail: "Beeper Desktop could not be reached" };
    }
    const observed = this.#deps.now().toISOString();
    const events = page.items.map((item) => mapMessage(item, observed));
    const next = page.hasMore ? page.oldestCursor : undefined;
    if (page.hasMore && (next === undefined || next === prior)) throw new KizukiError("parse_error", "kizuki.beeper: invalid pagination cursor");
    this.#lastSuccessAt = observed;
    return { events, cursor: next === undefined ? null : encodeBeeperCursor(next) };
  }
  async #read(cursor: string | null): Promise<Page> {
    const url = new URL("/v1/messages/search", this.#config.baseUrl);
    url.searchParams.set("limit", String(PAGE_LIMIT));
    url.searchParams.set("direction", "before");
    if (cursor !== null) url.searchParams.set("cursor", cursor);
    let response: Response;
    try { response = await this.#request(url); }
    catch { throw unavailable("Beeper Desktop could not be reached"); }
    if (response.redirected || !response.ok) throw unavailable(response.status === 401 || response.status === 403 ? "Beeper token was rejected" : "Beeper Desktop request failed");
    return parsePage(await boundedText(response));
  }
  async #request(path: string | URL): Promise<Response> {
    const url = typeof path === "string" ? new URL(path, this.#config.baseUrl) : path;
    return this.#deps.fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.#token!}` },
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }
  #health(state: "ok" | "misconfigured" | "unauthenticated" | "unreachable", checked_at: string, detail?: string): HealthReport {
    return new HealthReport({ state, checked_at, ...(detail === undefined ? {} : { detail }), ...(this.#lastSuccessAt === undefined ? {} : { last_success_at: this.#lastSuccessAt }) });
  }
  #assertActive(): void { if (this.#revoked) throw new KizukiError("unavailable", "kizuki.beeper: access was revoked"); }
  #assertConnected(): void { this.#assertActive(); if (this.#token === null) throw unavailable("connect() has not been called"); }
}

export function createBeeperConnector(config: BeeperConnectorConfig, deps?: Partial<BeeperConnectorDeps>): BeeperConnector { return new BeeperConnector(config, deps); }

function parseConfig(raw: unknown): Config {
  if (!isPlainObject(raw) || !Object.keys(raw).every((key) => key === "base_url" || key === "token_secret_ref") || typeof raw.token_secret_ref !== "string" || raw.token_secret_ref.length === 0) throw new KizukiError("misconfigured", "kizuki.beeper: token_secret_ref is required");
  const base = raw.base_url ?? DEFAULT_BASE_URL;
  if (typeof base !== "string") throw new KizukiError("misconfigured", "kizuki.beeper: base_url is invalid");
  let url: URL;
  try { url = new URL(base); } catch { throw new KizukiError("misconfigured", "kizuki.beeper: base_url is invalid"); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new KizukiError("misconfigured", "kizuki.beeper: base_url must be an explicit http://127.0.0.1 loopback origin");
  return { baseUrl: url, tokenRef: raw.token_secret_ref };
}

async function boundedText(response: Response): Promise<string> {
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new KizukiError("parse_error", "kizuki.beeper: response is too large");
  const reader = response.body?.getReader(); if (reader === undefined) throw new KizukiError("parse_error", "kizuki.beeper: response body is missing");
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new KizukiError("parse_error", "kizuki.beeper: response is too large"); } chunks.push(part.value); }
  const joined = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; } return new TextDecoder().decode(joined);
}

function parsePage(text: string): Page {
  let raw: unknown; try { raw = JSON.parse(text); } catch { throw new KizukiError("parse_error", "kizuki.beeper: malformed response"); }
  if (!isPlainObject(raw) || !Array.isArray(raw.items) || typeof raw.hasMore !== "boolean" || raw.items.length > PAGE_LIMIT) throw new KizukiError("parse_error", "kizuki.beeper: malformed response");
  const items = raw.items.map(parseMessage);
  if (raw.hasMore && items.length === 0) throw new KizukiError("parse_error", "kizuki.beeper: empty page claims more history");
  const oldestCursor = optionalCursor(raw.oldestCursor); const newestCursor = optionalCursor(raw.newestCursor);
  if (raw.hasMore && oldestCursor === undefined) throw new KizukiError("parse_error", "kizuki.beeper: malformed pagination response");
  return { items, hasMore: raw.hasMore, ...(oldestCursor === undefined ? {} : { oldestCursor }), ...(newestCursor === undefined ? {} : { newestCursor }) };
}
function optionalCursor(value: unknown): string | undefined { if (value === undefined || value === null) return undefined; if (typeof value !== "string" || value.length === 0 || new TextEncoder().encode(value).byteLength > 8 * 1024) throw new KizukiError("parse_error", "kizuki.beeper: malformed pagination response"); return value; }
function parseMessage(raw: unknown): Message {
  if (!isPlainObject(raw)) throw malformedMessage();
  const identifiers = ["id", "accountID", "chatID", "sortKey", "timestamp"] as const;
  if (!identifiers.every((key) => typeof raw[key] === "string" && raw[key].length > 0) || (raw.senderID !== undefined && typeof raw.senderID !== "string") || (raw.text !== undefined && typeof raw.text !== "string") || Number.isNaN(Date.parse(raw.timestamp as string)) || (raw.isDeleted !== undefined && typeof raw.isDeleted !== "boolean") || (raw.editedTimestamp !== undefined && typeof raw.editedTimestamp !== "string")) throw malformedMessage();
  return { id: raw.id as string, accountID: raw.accountID as string, chatID: raw.chatID as string, ...(typeof raw.senderID === "string" ? { senderID: raw.senderID } : {}), sortKey: raw.sortKey as string, timestamp: new Date(raw.timestamp as string).toISOString(), ...(typeof raw.text === "string" ? { text: raw.text } : {}), attachments: parseAttachments(raw.attachments), ...(raw.isDeleted === true ? { isDeleted: true } : {}), ...(raw.editedTimestamp === undefined ? {} : { editedTimestamp: raw.editedTimestamp as string }) };
}
function malformedMessage(): KizukiError { return new KizukiError("parse_error", "kizuki.beeper: malformed message"); }
function parseAttachments(raw: unknown): Attachment[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_ATTACHMENTS) throw malformedMessage();
  return raw.map((value) => {
    if (!isPlainObject(value) || !isAttachmentType(value.type) || !optionalNonEmptyText(value.id, MAX_ATTACHMENT_ID_BYTES) || !optionalText(value.fileName, MAX_FILENAME_BYTES) || !optionalNonEmptyText(value.mimeType, MAX_MEDIA_TYPE_BYTES) || !optionalSize(value.fileSize)) throw malformedMessage();
    return {
      type: value.type,
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
      ...(typeof value.fileSize === "number" ? { fileSize: value.fileSize } : {}),
      ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
    };
  });
}
function isAttachmentType(value: unknown): value is Attachment["type"] { return value === "unknown" || value === "img" || value === "video" || value === "audio"; }
function optionalText(value: unknown, maximum: number): boolean { return value === undefined || (typeof value === "string" && new TextEncoder().encode(value).byteLength <= maximum); }
function optionalNonEmptyText(value: unknown, maximum: number): boolean { return value === undefined || (typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).byteLength <= maximum); }
function optionalSize(value: unknown): boolean { return value === undefined || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0); }
function isInfoResponse(value: unknown): boolean {
  return isPlainObject(value) && isPlainObject(value.app) && isPlainObject(value.server)
    && typeof value.app.name === "string" && value.app.name.length > 0
    && typeof value.app.version === "string" && value.app.version.length > 0
    && typeof value.server.status === "string";
}
function mapMessage(message: Message, observed_at: string): CaptureEventInput {
  const deleted = message.isDeleted === true;
  const accountChat = JSON.stringify([message.accountID, message.chatID]);
  return { schema: "kizuki.event/v1", connector_id: BEEPER_CONNECTOR_ID, source_record_id: JSON.stringify([message.accountID, message.chatID, message.id]), kind: "message", occurred_at: message.timestamp, observed_at, text: deleted ? "" : (message.text ?? ""), subjects: [ ...(message.senderID === undefined ? [] : [{ subject_id: `beeper:sender:${JSON.stringify([message.accountID, message.senderID])}`, role: "from" as const }]), { subject_id: `beeper:chat:${accountChat}`, role: "about" } ], sensitivity_hint: "private", deleted, attachments: deleted ? [] : attachmentRefs(message), metadata: { source_kind: "beeper", account_id: message.accountID, chat_id: message.chatID, message_id: message.id, sender_id: message.senderID ?? null, sort_key: message.sortKey, edited_timestamp: message.editedTimestamp ?? null } };
}
function attachmentRefs(message: Message): AttachmentRef[] {
  return message.attachments.map((attachment, index) => ({
    attachment_id: attachment.id ?? `beeper:attachment:${JSON.stringify([message.accountID, message.chatID, message.id, index])}`,
    media_type: attachment.mimeType ?? "application/octet-stream",
    ...(attachment.fileName === undefined ? {} : { filename: attachment.fileName }),
    ...(attachment.fileSize === undefined ? {} : { byte_size: attachment.fileSize }),
  }));
}
function unavailable(detail: string): KizukiError { return new KizukiError("unreachable", `kizuki.beeper: ${detail}`); }
