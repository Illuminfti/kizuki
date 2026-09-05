import {
  HealthReport,
  KizukiError,
  freezeManifest,
  isPlainObject,
} from "@kizuki/core";
import type {
  Connector,
  Cursor,
  Manifest,
  PurgePlan,
  SecretResolver,
  SyncBatch,
} from "@kizuki/core";
import {
  assertMediaStable,
  assertSnapshotStable,
  coverageDetail,
  readTweetPart,
  scanArchive,
} from "./archive";
import type { XArchiveSnapshot } from "./archive";
import {
  X_ARCHIVE_CURSOR_SCHEMA,
  encodeCursor,
  parseCursor,
} from "./cursor";
import type { XArchiveCursor } from "./cursor";
import { archiveError, errorDetail } from "./errors";
import { fixtureEvents } from "./fixture";
import { mapPost } from "./map";
import type { MappedPost } from "./map";

export const X_ARCHIVE_CONNECTOR_ID = "kizuki.import-x-archive" as const;
export const BATCH_LIMIT = 500;
export const MAX_BATCH_BYTES = 3 * 1024 * 1024;

export interface XArchiveConnectorConfig {
  path: string;
}

export interface XArchiveConnectorDeps {
  now?: () => Date;
}

const MANIFEST: Manifest = freezeManifest({
  schema: "kizuki.connector/v1",
  connector_id: X_ARCHIVE_CONNECTOR_ID,
  version: "0.1.0",
  contract_minor: 1,
  implementation: "@kizuki/connector-x",
  allowed_egress: [],
  cursor_schema: X_ARCHIVE_CURSOR_SCHEMA,
  kinds: ["post"],
  capabilities: {
    backfill: true,
    sync: true,
    tombstones: false,
    purge: false,
    fixture: true,
  },
  required_secrets: [],
  emits_sensitivity_hint: true,
  default_sensitivity: "personal",
  sensitivity_floor: "personal",
  auth_modes: ["none"],
});

function configPath(config: XArchiveConnectorConfig): string {
  if (!isPlainObject(config) || typeof config["path"] !== "string" ||
    config["path"].length === 0 || Buffer.byteLength(config["path"], "utf8") > 4096 ||
    config["path"].includes("\0")) {
    throw archiveError("misconfigured", "path must name an unzipped X archive directory");
  }
  return config["path"];
}

function positionFor(snapshot: XArchiveSnapshot, cursor: XArchiveCursor | null): {
  part: number | null;
  record: number | null;
  seen: number;
} {
  if (cursor === null || cursor.snapshot_sha256 !== snapshot.sha256) {
    return snapshot.parts.length === 0
      ? { part: null, record: null, seen: 0 }
      : { part: 0, record: 0, seen: 0 };
  }
  if (cursor.next_part === null) {
    if (cursor.seen_records !== snapshot.total_posts) {
      throw archiveError("parse_error", "terminal cursor does not match this archive snapshot");
    }
    return { part: null, record: null, seen: cursor.seen_records };
  }
  const descriptor = snapshot.parts[cursor.next_part];
  if (descriptor === undefined || cursor.next_record === null || cursor.next_record > descriptor.records) {
    throw archiveError("parse_error", "cursor points outside this archive snapshot");
  }
  const expected = snapshot.parts.slice(0, cursor.next_part)
    .reduce((sum, part) => sum + part.records, 0) + cursor.next_record;
  if (expected !== cursor.seen_records) {
    throw archiveError("parse_error", "cursor record count does not match this archive snapshot");
  }
  return { part: cursor.next_part, record: cursor.next_record, seen: cursor.seen_records };
}

export class XArchiveConnector implements Connector {
  readonly #path: string;
  readonly #now: () => Date;
  #snapshot: XArchiveSnapshot | null = null;
  #partCache: { snapshot: string; ordinal: number; records: unknown[] } | null = null;
  #observedAt: string | null = null;
  #lastSuccessAt: string | undefined;

  constructor(config: XArchiveConnectorConfig, deps: XArchiveConnectorDeps = {}) {
    this.#path = configPath(config);
    this.#now = deps.now ?? (() => new Date());
  }

  manifest(): Manifest { return MANIFEST; }

  async connect(_resolve: SecretResolver): Promise<void> {
    this.#snapshot = await scanArchive(this.#path);
    this.#partCache = null;
    this.#observedAt = this.#now().toISOString();
  }

  async health(): Promise<HealthReport> {
    const checkedAt = this.#now().toISOString();
    try {
      const snapshot = await scanArchive(this.#path);
      return new HealthReport({
        state: "ok",
        checked_at: checkedAt,
        detail: coverageDetail(snapshot.coverage),
        ...(this.#lastSuccessAt === undefined ? {} : { last_success_at: this.#lastSuccessAt }),
      });
    } catch (error) {
      const code = error instanceof KizukiError ? error.code : "unavailable";
      return new HealthReport({
        state: code === "unavailable" ? "unreachable" : "misconfigured",
        checked_at: checkedAt,
        detail: errorDetail(error),
      });
    }
  }

  async backfill(cursorValue: Cursor | null): Promise<SyncBatch> {
    const cursor = cursorValue === null ? null : parseCursor(cursorValue);
    let snapshot = this.#snapshot;
    if (snapshot === null || cursor === null || cursor.next_part === null) {
      snapshot = await scanArchive(this.#path);
      this.#snapshot = snapshot;
      this.#partCache = null;
      this.#observedAt = this.#now().toISOString();
    } else {
      try {
        await assertSnapshotStable(snapshot);
      } catch (error) {
        if (!(error instanceof KizukiError) || error.code !== "unavailable") throw error;
        snapshot = await scanArchive(this.#path);
        this.#snapshot = snapshot;
        this.#partCache = null;
        this.#observedAt = this.#now().toISOString();
      }
    }
    if (cursor !== null && cursor.account_id !== snapshot.identity.account_id) {
      throw archiveError("misconfigured", "archive account differs from the existing cursor; enroll it as a separate source");
    }
    const start = positionFor(snapshot, cursor);
    if (start.part === null || start.record === null) {
      await assertSnapshotStable(snapshot);
      return { events: [], cursor: encodeCursor({
        schema: X_ARCHIVE_CURSOR_SCHEMA,
        account_id: snapshot.identity.account_id,
        snapshot_sha256: snapshot.sha256,
        next_part: null,
        next_record: null,
        seen_records: snapshot.total_posts,
      }) };
    }

    let partOrdinal = start.part;
    let recordIndex = start.record;
    let seen = start.seen;
    let mapped: MappedPost[] = [];
    let batchBytes = 2;
    const observedAt = this.#observedAt ?? this.#now().toISOString();
    this.#observedAt = observedAt;
    while (partOrdinal < snapshot.parts.length && mapped.length === 0) {
      let records: unknown[];
      if (this.#partCache?.snapshot === snapshot.sha256 && this.#partCache.ordinal === partOrdinal) {
        records = this.#partCache.records;
      } else {
        records = await readTweetPart(snapshot, partOrdinal);
        this.#partCache = { snapshot: snapshot.sha256, ordinal: partOrdinal, records };
      }
      while (recordIndex < records.length && mapped.length < BATCH_LIMIT) {
        const next = mapPost(
          records[recordIndex],
          snapshot.parts[partOrdinal]?.part ?? partOrdinal,
          recordIndex,
          snapshot.identity,
          snapshot.media,
          observedAt,
        );
        const eventBytes = Buffer.byteLength(JSON.stringify(next.event), "utf8");
        const candidateBytes = batchBytes + eventBytes + (mapped.length === 0 ? 0 : 1);
        if (candidateBytes > MAX_BATCH_BYTES) {
          if (mapped.length === 0) {
            throw archiveError("parse_error", "one post exceeds the connector batch byte limit");
          }
          break;
        }
        mapped.push(next);
        batchBytes = candidateBytes;
        recordIndex += 1;
        seen += 1;
      }
      if (mapped.length === 0 && recordIndex >= records.length) {
        partOrdinal += 1;
        recordIndex = 0;
      }
    }
    if (mapped.length > 0) {
      const lastPartRecords = snapshot.parts[partOrdinal]?.records ?? 0;
      if (recordIndex >= lastPartRecords) {
        partOrdinal += 1;
        recordIndex = 0;
      }
    }
    await assertMediaStable(mapped.flatMap((item) => [...item.media]));
    await assertSnapshotStable(snapshot);
    const exhausted = partOrdinal >= snapshot.parts.length;
    const nextCursor: XArchiveCursor = {
      schema: X_ARCHIVE_CURSOR_SCHEMA,
      account_id: snapshot.identity.account_id,
      snapshot_sha256: snapshot.sha256,
      next_part: exhausted ? null : partOrdinal,
      next_record: exhausted ? null : recordIndex,
      seen_records: seen,
    };
    this.#lastSuccessAt = this.#now().toISOString();
    return { events: mapped.map((item) => item.event), cursor: encodeCursor(nextCursor) };
  }

  sync(cursor: Cursor | null): Promise<SyncBatch> { return this.backfill(cursor); }

  async revoke(): Promise<void> {
    this.#snapshot = null;
    this.#partCache = null;
    this.#observedAt = null;
  }

  async purgeSource(_subjectId: string): Promise<PurgePlan> {
    throw archiveError("not_supported", "source purge is unavailable for local X archives");
  }

  async fixture() { return fixtureEvents(); }
}

export function createXArchiveConnector(
  config: XArchiveConnectorConfig,
  deps: XArchiveConnectorDeps = {},
): XArchiveConnector {
  return new XArchiveConnector(config, deps);
}

export type XArchiveImportConfig = XArchiveConnectorConfig;
