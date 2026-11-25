import type { Database } from "bun:sqlite";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
  defaultMemtRegistryPath,
  isMemtSensitivity,
  isPlainObject,
  normalizeSourceRefVariants,
  openMemtRegistryDb,
  withinSensitivityCeiling,
} from "./db";
import type { MemtSensitivity } from "./db";
import { MEMT_SNAPSHOT_FORMAT } from "./protocol";

export const MAX_SAFETENSORS_HEADER_BYTES = 16 * 1024 * 1024;

export type MemtSnapshotTaintState = "clean" | "stale" | "purged_invalidated";

export interface MemtTensorSpec {
  readonly name: string;
  readonly layer: number;
  readonly dtype: "F32";
  readonly shape: readonly [1, number, number, number];
  readonly data_offsets: readonly [number, number];
  readonly byteLength: number;
}

export type MemTSnapshotValidationResult =
  | {
      readonly ok: true;
      readonly format: typeof MEMT_SNAPSHOT_FORMAT;
      readonly identity: string;
      readonly headerBytes: number;
      readonly layers: readonly MemtTensorSpec[];
      readonly metadata: Readonly<Record<string, string>>;
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
    };

export type MemTCustodyErrorCode =
  | "not_found"
  | "purged_invalidated"
  | "stale"
  | "sensitivity_exceeded"
  | "identity_mismatch"
  | "invalid_snapshot_file";

export class MemTCustodyError extends Error {
  readonly code: MemTCustodyErrorCode;
  readonly partitionKey: string;

  constructor(
    code: MemTCustodyErrorCode,
    partitionKey: string,
    message: string,
  ) {
    super(message);
    this.name = "MemTCustodyError";
    this.code = code;
    this.partitionKey = partitionKey;
  }
}

export interface MemtSnapshotRecord {
  readonly partition_key: string;
  readonly sensitivity_ceiling: MemtSensitivity;
  readonly source_ids: readonly string[];
  readonly snapshot_name: string;
  readonly identity_sha256: string;
  readonly event_watermark: string;
  readonly taint_state: MemtSnapshotTaintState;
  readonly updated_at: string;
}

export interface RegisterSnapshotInput {
  readonly partition_key: string;
  readonly sensitivity_ceiling: MemtSensitivity;
  readonly source_ids: readonly string[];
  readonly snapshot_name: string;
  readonly identity_sha256: string;
  readonly event_watermark: string;
  readonly taint_state?: MemtSnapshotTaintState;
  readonly updated_at?: string;
}

export interface AssertLoadableOptions {
  readonly requiredSensitivityCeiling?: MemtSensitivity;
  readonly expectedIdentitySha256?: string;
  readonly filePath?: string;
  readonly allowStale?: boolean;
}

export interface InvalidateSnapshotsResult {
  readonly invalidatedPartitions: readonly string[];
  readonly checkedSources: number;
}

const MEMORY_LAYER_KEY_PATTERN = /^memory\.([0-9]+)$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function validateParsedHeaderObject(
  headerObj: unknown,
  headerBytes: number,
  totalFileBytes: bigint,
): MemTSnapshotValidationResult {
  const errors: string[] = [];
  if (!isPlainObject(headerObj)) {
    return {
      ok: false,
      errors: ["safetensors header must be a JSON object"],
    };
  }

  const rawMeta = headerObj["__metadata__"];
  const metadata: Record<string, string> = {};
  if (!isPlainObject(rawMeta)) {
    errors.push("missing '__metadata__' object in safetensors header");
  } else {
    for (const [k, v] of Object.entries(rawMeta)) {
      if (typeof v === "string") {
        metadata[k] = v;
      } else {
        errors.push(`__metadata__.${k} must be a string`);
      }
    }
    if (metadata["format"] !== MEMT_SNAPSHOT_FORMAT) {
      errors.push(
        `unsupported snapshot format '${String(metadata["format"] ?? "")}' (expected '${MEMT_SNAPSHOT_FORMAT}')`,
      );
    }
    if (
      metadata["identity"] === undefined ||
      metadata["identity"].trim().length === 0
    ) {
      errors.push("missing or empty '__metadata__.identity'");
    }
  }

  const layers: MemtTensorSpec[] = [];
  const dataSectionBytes = totalFileBytes - 8n - BigInt(headerBytes);

  for (const [key, entry] of Object.entries(headerObj)) {
    if (key === "__metadata__") continue;

    if (key.startsWith("memory.layers.")) {
      errors.push(
        `legacy incompatible tensor key '${key}': memory.layers.* format is rejected by ${MEMT_SNAPSHOT_FORMAT}`,
      );
      continue;
    }

    const match = MEMORY_LAYER_KEY_PATTERN.exec(key);
    if (match === null) {
      errors.push(
        `unexpected tensor key '${key}': expected 'memory.<layer>' format`,
      );
      continue;
    }

    const layerIndex = Number(match[1]);
    if (!Number.isSafeInteger(layerIndex) || layerIndex < 0) {
      errors.push(`invalid layer index in tensor key '${key}'`);
      continue;
    }

    if (!isPlainObject(entry)) {
      errors.push(`tensor '${key}' entry must be an object`);
      continue;
    }

    const dtype = entry["dtype"];
    if (dtype !== "F32") {
      errors.push(
        `tensor '${key}' has unsupported dtype '${String(dtype)}' (expected 'F32')`,
      );
    }

    const shape = entry["shape"];
    let validShape: readonly [1, number, number, number] | null = null;
    if (!Array.isArray(shape) || shape.length !== 4) {
      errors.push(
        `tensor '${key}' must have 4D positive integer shape [1, heads, K, V]`,
      );
    } else {
      const s0: unknown = shape[0];
      const s1: unknown = shape[1];
      const s2: unknown = shape[2];
      const s3: unknown = shape[3];
      if (
        typeof s0 !== "number" ||
        typeof s1 !== "number" ||
        typeof s2 !== "number" ||
        typeof s3 !== "number" ||
        !Number.isSafeInteger(s0) ||
        !Number.isSafeInteger(s1) ||
        !Number.isSafeInteger(s2) ||
        !Number.isSafeInteger(s3) ||
        s0 <= 0 ||
        s1 <= 0 ||
        s2 <= 0 ||
        s3 <= 0
      ) {
        errors.push(
          `tensor '${key}' must have 4D positive integer shape [1, heads, K, V]`,
        );
      } else if (s0 !== 1) {
        errors.push(`tensor '${key}' shape[0] must be 1 (got ${String(s0)})`);
      } else {
        validShape = [1, s1, s2, s3];
      }
    }

    const offsets = entry["data_offsets"];
    let validOffsets: readonly [number, number] | null = null;
    if (!Array.isArray(offsets) || offsets.length !== 2) {
      errors.push(`tensor '${key}' has invalid data_offsets`);
    } else {
      const o0: unknown = offsets[0];
      const o1: unknown = offsets[1];
      if (
        typeof o0 !== "number" ||
        typeof o1 !== "number" ||
        !Number.isSafeInteger(o0) ||
        !Number.isSafeInteger(o1) ||
        o0 < 0 ||
        o1 < o0
      ) {
        errors.push(`tensor '${key}' has invalid data_offsets`);
      } else {
        validOffsets = [o0, o1];
        if (BigInt(o1) > dataSectionBytes) {
          errors.push(
            `tensor '${key}' data_offsets end (${o1}) exceeds file payload size (${dataSectionBytes.toString()})`,
          );
        }
      }
    }

    if (dtype === "F32" && validShape !== null && validOffsets !== null) {
      const expectedBytes =
        BigInt(validShape[0]) *
        BigInt(validShape[1]) *
        BigInt(validShape[2]) *
        BigInt(validShape[3]) *
        4n;
      const actualBytes = BigInt(validOffsets[1] - validOffsets[0]);
      if (actualBytes !== expectedBytes) {
        errors.push(
          `tensor '${key}' byte length ${actualBytes.toString()} does not match F32 shape [${validShape.join(", ")}] (expected ${expectedBytes.toString()})`,
        );
      } else {
        layers.push(
          Object.freeze({
            name: key,
            layer: layerIndex,
            dtype: "F32",
            shape: validShape,
            data_offsets: validOffsets,
            byteLength: Number(actualBytes),
          }),
        );
      }
    }
  }

  if (layers.length === 0 && errors.length === 0) {
    errors.push("snapshot contains no 'memory.<layer>' tensors");
  }

  if (errors.length > 0) {
    return { ok: false, errors: Object.freeze(errors) };
  }

  layers.sort((a, b) => a.layer - b.layer);

  return {
    ok: true,
    format: MEMT_SNAPSHOT_FORMAT,
    identity: metadata["identity"]!.trim(),
    headerBytes,
    layers: Object.freeze(layers),
    metadata: Object.freeze(metadata),
  };
}

export function validateMemTSnapshotBytes(
  bytes: Uint8Array,
  totalFileSize: number = bytes.byteLength,
): MemTSnapshotValidationResult {
  if (bytes.byteLength < 8 || totalFileSize < 8) {
    return {
      ok: false,
      errors: ["safetensors file is smaller than 8-byte header length prefix"],
    };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const headerLen = view.getBigUint64(0, true);
  if (headerLen === 0n) {
    return { ok: false, errors: ["safetensors header length is 0"] };
  }
  if (headerLen > BigInt(MAX_SAFETENSORS_HEADER_BYTES)) {
    return {
      ok: false,
      errors: [
        `safetensors header length ${headerLen.toString()} exceeds safety limit of ${MAX_SAFETENSORS_HEADER_BYTES} bytes`,
      ],
    };
  }
  const headerBytes = Number(headerLen);
  if (
    8 + headerBytes > bytes.byteLength ||
    8n + headerLen > BigInt(totalFileSize)
  ) {
    return {
      ok: false,
      errors: [
        `safetensors header truncated: requires ${8 + headerBytes} bytes, got ${bytes.byteLength}`,
      ],
    };
  }

  let headerText: string;
  try {
    headerText = UTF8_DECODER.decode(bytes.subarray(8, 8 + headerBytes));
  } catch {
    return {
      ok: false,
      errors: ["safetensors header is not valid UTF-8"],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(headerText);
  } catch {
    return {
      ok: false,
      errors: ["safetensors header is not valid JSON"],
    };
  }

  return validateParsedHeaderObject(parsed, headerBytes, BigInt(totalFileSize));
}

export function validateMemTSnapshotFile(
  filePath: string,
): MemTSnapshotValidationResult {
  let fd: number;
  try {
    fd = openSync(filePath, "r");
  } catch (error) {
    return {
      ok: false,
      errors: [
        `cannot open snapshot file '${filePath}': ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }

  try {
    const stat = fstatSync(fd);
    const totalSize = BigInt(stat.size);
    if (totalSize < 8n) {
      return {
        ok: false,
        errors: ["safetensors file is smaller than 8-byte header length prefix"],
      };
    }

    const lenBuf = new Uint8Array(8);
    const lenRead = readSync(fd, lenBuf, 0, 8, 0);
    if (lenRead !== 8) {
      return {
        ok: false,
        errors: ["failed to read 8-byte safetensors header length prefix"],
      };
    }

    const headerLen = new DataView(
      lenBuf.buffer,
      lenBuf.byteOffset,
      8,
    ).getBigUint64(0, true);
    if (headerLen === 0n) {
      return { ok: false, errors: ["safetensors header length is 0"] };
    }
    if (headerLen > BigInt(MAX_SAFETENSORS_HEADER_BYTES)) {
      return {
        ok: false,
        errors: [
          `safetensors header length ${headerLen.toString()} exceeds safety limit of ${MAX_SAFETENSORS_HEADER_BYTES} bytes`,
        ],
      };
    }
    if (8n + headerLen > totalSize) {
      return {
        ok: false,
        errors: [
          `safetensors header length ${headerLen.toString()} exceeds file size ${totalSize.toString()}`,
        ],
      };
    }

    const headerBytes = Number(headerLen);
    const headerBuf = new Uint8Array(headerBytes);
    let offset = 0;
    while (offset < headerBytes) {
      const n = readSync(
        fd,
        headerBuf,
        offset,
        headerBytes - offset,
        8 + offset,
      );
      if (n <= 0) {
        return {
          ok: false,
          errors: ["unexpected EOF while reading safetensors header"],
        };
      }
      offset += n;
    }

    let headerText: string;
    try {
      headerText = UTF8_DECODER.decode(headerBuf);
    } catch {
      return {
        ok: false,
        errors: ["safetensors header is not valid UTF-8"],
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(headerText);
    } catch {
      return {
        ok: false,
        errors: ["safetensors header is not valid JSON"],
      };
    }

    return validateParsedHeaderObject(parsed, headerBytes, totalSize);
  } finally {
    closeSync(fd);
  }
}

export interface BuildMinimalSafetensorsOptions {
  readonly identity: string;
  readonly format?: string;
  readonly layers?: readonly {
    readonly name?: string;
    readonly layer: number;
    readonly dtype?: string;
    readonly shape: readonly number[];
  }[];
  readonly extraMetadata?: Readonly<Record<string, string>>;
}

export function buildMinimalSafetensorsBuffer(
  options: BuildMinimalSafetensorsOptions,
): Uint8Array {
  const layerSpecs = options.layers ?? [
    { layer: 0, shape: [1, 2, 4, 4], dtype: "F32" },
    { layer: 1, shape: [1, 2, 4, 4], dtype: "F32" },
  ];

  const header: Record<string, unknown> = {
    __metadata__: {
      format: options.format ?? MEMT_SNAPSHOT_FORMAT,
      identity: options.identity,
      ...(options.extraMetadata ?? {}),
    },
  };

  let dataCursor = 0;
  for (const spec of layerSpecs) {
    const key = spec.name ?? `memory.${spec.layer}`;
    const dtype = spec.dtype ?? "F32";
    const elemBytes =
      dtype === "F32" ? 4 : dtype === "F16" || dtype === "BF16" ? 2 : 4;
    const elems = spec.shape.reduce((acc, dim) => acc * Math.max(1, dim), 1);
    const byteLen = elems * elemBytes;
    header[key] = {
      dtype,
      shape: [...spec.shape],
      data_offsets: [dataCursor, dataCursor + byteLen],
    };
    dataCursor += byteLen;
  }

  const headerEncoded = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + headerEncoded.byteLength + dataCursor);
  new DataView(out.buffer).setBigUint64(0, BigInt(headerEncoded.byteLength), true);
  out.set(headerEncoded, 8);
  return out;
}

interface SnapshotRow {
  partition_key: string;
  sensitivity_ceiling: string;
  source_ids_json: string;
  snapshot_name: string;
  identity_sha256: string;
  event_watermark: string;
  taint_state: string;
  updated_at: string;
}

function rowToSnapshotRecord(row: SnapshotRow): MemtSnapshotRecord {
  let parsedSources: string[] = [];
  try {
    const raw: unknown = JSON.parse(row.source_ids_json);
    if (Array.isArray(raw)) {
      parsedSources = raw.filter((v): v is string => typeof v === "string");
    }
  } catch {
    parsedSources = [];
  }
  return Object.freeze({
    partition_key: row.partition_key,
    sensitivity_ceiling: isMemtSensitivity(row.sensitivity_ceiling)
      ? row.sensitivity_ceiling
      : "private",
    source_ids: Object.freeze(parsedSources),
    snapshot_name: row.snapshot_name,
    identity_sha256: row.identity_sha256,
    event_watermark: row.event_watermark,
    taint_state: row.taint_state as MemtSnapshotTaintState,
    updated_at: row.updated_at,
  });
}

export interface SnapshotCustodyRegistryOptions {
  readonly db?: Database;
  readonly dbPath?: string;
  readonly vaultPath?: string;
}

export class SnapshotCustodyRegistry {
  private readonly db: Database;
  private readonly ownsDb: boolean;

  constructor(options: SnapshotCustodyRegistryOptions) {
    if (options.db !== undefined) {
      this.db = options.db;
      this.ownsDb = false;
    } else {
      const dbPath =
        options.dbPath ??
        (options.vaultPath !== undefined
          ? defaultMemtRegistryPath(options.vaultPath)
          : ":memory:");
      this.db = openMemtRegistryDb(dbPath);
      this.ownsDb = true;
    }
  }

  registerSnapshot(input: RegisterSnapshotInput): MemtSnapshotRecord {
    if (input.partition_key.trim().length === 0) {
      throw new Error("partition_key must be non-empty");
    }
    if (!isMemtSensitivity(input.sensitivity_ceiling)) {
      throw new Error(
        `invalid sensitivity_ceiling: ${String(input.sensitivity_ceiling)}`,
      );
    }
    if (input.snapshot_name.trim().length === 0) {
      throw new Error("snapshot_name must be non-empty");
    }
    if (input.identity_sha256.trim().length === 0) {
      throw new Error("identity_sha256 must be non-empty");
    }

    const dedupedSources = [
      ...new Set(
        input.source_ids.map((s) => s.trim()).filter((s) => s.length > 0),
      ),
    ];
    const taintState: MemtSnapshotTaintState = input.taint_state ?? "clean";
    const updatedAt = input.updated_at ?? new Date().toISOString();
    const sourcesJson = JSON.stringify(dedupedSources);

    const tx = this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO memt_snapshots (
            partition_key, sensitivity_ceiling, source_ids_json, snapshot_name,
            identity_sha256, event_watermark, taint_state, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(partition_key) DO UPDATE SET
            sensitivity_ceiling = excluded.sensitivity_ceiling,
            source_ids_json = excluded.source_ids_json,
            snapshot_name = excluded.snapshot_name,
            identity_sha256 = excluded.identity_sha256,
            event_watermark = excluded.event_watermark,
            taint_state = excluded.taint_state,
            updated_at = excluded.updated_at`,
        )
        .run(
          input.partition_key,
          input.sensitivity_ceiling,
          sourcesJson,
          input.snapshot_name,
          input.identity_sha256,
          input.event_watermark,
          taintState,
          updatedAt,
        );

      this.db
        .query("DELETE FROM memt_snapshot_sources WHERE partition_key = ?")
        .run(input.partition_key);

      const insertSource = this.db.query(
        "INSERT OR IGNORE INTO memt_snapshot_sources (partition_key, source_id) VALUES (?, ?)",
      );
      for (const sourceId of dedupedSources) {
        for (const variant of normalizeSourceRefVariants(sourceId)) {
          insertSource.run(input.partition_key, variant);
        }
      }
    });
    tx();

    return {
      partition_key: input.partition_key,
      sensitivity_ceiling: input.sensitivity_ceiling,
      source_ids: Object.freeze(dedupedSources),
      snapshot_name: input.snapshot_name,
      identity_sha256: input.identity_sha256,
      event_watermark: input.event_watermark,
      taint_state: taintState,
      updated_at: updatedAt,
    };
  }

  getSnapshot(partitionKey: string): MemtSnapshotRecord | null {
    const row = this.db
      .query<SnapshotRow, [string]>(
        "SELECT * FROM memt_snapshots WHERE partition_key = ?",
      )
      .get(partitionKey);
    return row === null ? null : rowToSnapshotRecord(row);
  }

  getSnapshotByName(snapshotName: string): MemtSnapshotRecord | null {
    const row = this.db
      .query<SnapshotRow, [string]>(
        "SELECT * FROM memt_snapshots WHERE snapshot_name = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(snapshotName);
    return row === null ? null : rowToSnapshotRecord(row);
  }

  listSnapshots(
    filter: { readonly taintState?: MemtSnapshotTaintState } = {},
  ): MemtSnapshotRecord[] {
    const rows =
      filter.taintState !== undefined
        ? this.db
            .query<SnapshotRow, [string]>(
              "SELECT * FROM memt_snapshots WHERE taint_state = ? ORDER BY updated_at DESC",
            )
            .all(filter.taintState)
        : this.db
            .query<SnapshotRow, []>(
              "SELECT * FROM memt_snapshots ORDER BY updated_at DESC",
            )
            .all();
    return rows.map(rowToSnapshotRecord);
  }

  markStale(
    partitionKey: string,
    now: string = new Date().toISOString(),
  ): boolean {
    const res = this.db
      .query(
        `UPDATE memt_snapshots
         SET taint_state = CASE WHEN taint_state = 'purged_invalidated' THEN 'purged_invalidated' ELSE 'stale' END,
             updated_at = ?
         WHERE partition_key = ?`,
      )
      .run(now, partitionKey);
    return res.changes > 0;
  }

  invalidateForPurgedSources(
    sourceIds: readonly string[],
    now: string = new Date().toISOString(),
  ): InvalidateSnapshotsResult {
    const normalized = new Set<string>();
    for (const id of sourceIds) {
      for (const variant of normalizeSourceRefVariants(id)) {
        normalized.add(variant);
      }
    }
    if (normalized.size === 0) {
      return { invalidatedPartitions: [], checkedSources: 0 };
    }

    const targets = [...normalized];
    const invalidated = new Set<string>();

    const tx = this.db.transaction(() => {
      const chunkSize = 200;
      for (let i = 0; i < targets.length; i += chunkSize) {
        const slice = targets.slice(i, i + chunkSize);
        const placeholders = slice.map(() => "?").join(", ");
        const matched = this.db
          .query<{ partition_key: string }, string[]>(
            `SELECT DISTINCT partition_key FROM memt_snapshot_sources WHERE source_id IN (${placeholders})`,
          )
          .all(...slice);
        for (const row of matched) {
          invalidated.add(row.partition_key);
        }
      }

      if (invalidated.size > 0) {
        const update = this.db.query(
          "UPDATE memt_snapshots SET taint_state = 'purged_invalidated', updated_at = ? WHERE partition_key = ?",
        );
        for (const partitionKey of invalidated) {
          update.run(now, partitionKey);
        }
      }
    });
    tx();

    return {
      invalidatedPartitions: [...invalidated].sort(),
      checkedSources: sourceIds.length,
    };
  }

  assertLoadable(
    partitionKey: string,
    options: AssertLoadableOptions = {},
  ): MemtSnapshotRecord {
    const record = this.getSnapshot(partitionKey);
    if (record === null) {
      throw new MemTCustodyError(
        "not_found",
        partitionKey,
        `MemT snapshot partition '${partitionKey}' is not registered`,
      );
    }
    if (record.taint_state === "purged_invalidated") {
      throw new MemTCustodyError(
        "purged_invalidated",
        partitionKey,
        `MemT snapshot partition '${partitionKey}' was invalidated by a source purge and cannot be loaded until rebuilt cleanly`,
      );
    }
    if (record.taint_state === "stale" && options.allowStale !== true) {
      throw new MemTCustodyError(
        "stale",
        partitionKey,
        `MemT snapshot partition '${partitionKey}' is marked stale`,
      );
    }
    if (
      options.requiredSensitivityCeiling !== undefined &&
      !withinSensitivityCeiling(
        record.sensitivity_ceiling,
        options.requiredSensitivityCeiling,
      )
    ) {
      throw new MemTCustodyError(
        "sensitivity_exceeded",
        partitionKey,
        `MemT snapshot partition '${partitionKey}' ceiling '${record.sensitivity_ceiling}' exceeds caller ceiling '${options.requiredSensitivityCeiling}'`,
      );
    }
    if (
      options.expectedIdentitySha256 !== undefined &&
      record.identity_sha256 !== options.expectedIdentitySha256
    ) {
      throw new MemTCustodyError(
        "identity_mismatch",
        partitionKey,
        `MemT snapshot partition '${partitionKey}' identity '${record.identity_sha256}' does not match server identity '${options.expectedIdentitySha256}'`,
      );
    }
    if (options.filePath !== undefined) {
      const validation = validateMemTSnapshotFile(options.filePath);
      if (!validation.ok) {
        throw new MemTCustodyError(
          "invalid_snapshot_file",
          partitionKey,
          `MemT snapshot file '${options.filePath}' failed memt-memory-v1 validation: ${validation.errors.join("; ")}`,
        );
      }
    }
    return record;
  }

  deleteSnapshot(partitionKey: string): boolean {
    const res = this.db
      .query("DELETE FROM memt_snapshots WHERE partition_key = ?")
      .run(partitionKey);
    return res.changes > 0;
  }

  countSnapshots(): {
    total: number;
    clean: number;
    stale: number;
    purgedInvalidated: number;
  } {
    const rows = this.db
      .query<{ taint_state: string; count: number }, []>(
        "SELECT taint_state, COUNT(*) AS count FROM memt_snapshots GROUP BY taint_state",
      )
      .all();
    let clean = 0;
    let stale = 0;
    let purgedInvalidated = 0;
    for (const row of rows) {
      if (row.taint_state === "clean") clean = row.count;
      else if (row.taint_state === "stale") stale = row.count;
      else if (row.taint_state === "purged_invalidated") {
        purgedInvalidated = row.count;
      }
    }
    return {
      total: clean + stale + purgedInvalidated,
      clean,
      stale,
      purgedInvalidated,
    };
  }

  close(): void {
    if (this.ownsDb) {
      this.db.close();
    }
  }
}
