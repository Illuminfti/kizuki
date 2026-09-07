import { lstatSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ExportManifest } from "./export";
import { getConnection } from "./ledger/connections";
import { STATE_CONNECTION_CONFIG } from "./ledger/connection-state";
import { sourceJournalNames } from "./ledger/connection-state-files";
import { inspectSourceGrant } from "./ledger/source-grants";
import { sha256Hex } from "./util/hash";
import { isUlid } from "./util/ulid";
import { isRfc3339 } from "./util/time";
import { openCanonFiles, type CanonFileSnapshot } from "./vault/canon-files";

export const PORTABLE_LOCAL_STREAM = "connections/portable-local.v1.jsonl";
const MAX_ROWS = 1024, MAX_BYTES = 1_048_576, MAX_PATH_BYTES = 4096, MAX_IDS = 64;
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
export interface PortableLocalAdapter {
  /** Trusted host's closed inventory of connectors with path-only local state. */
  readonly connector_ids: readonly string[];
  decode(connectorId: string, bytes: Uint8Array): { readonly path: string };
  encode(connectorId: string, config: { readonly path: string }): Uint8Array;
}
export interface PortableLocalRecord {
  readonly connector_id: string;
  readonly source_key: string;
  readonly path: string;
  readonly was_connected: boolean;
}
function fail(): never { throw new Error("portable_local_invalid"); }
function own(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  if (Reflect.ownKeys(value).length !== keys.length) fail();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
function connectorId(id: unknown): string {
  if (typeof id !== "string" || !/^[a-z][a-z0-9.-]{0,127}$/.test(id)) fail();
  return id;
}
function config(value: unknown): { readonly path: string } {
  const { path } = own(value, ["path"]);
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") ||
      Buffer.byteLength(path) > MAX_PATH_BYTES || resolve(path) !== path || Buffer.from(path).toString("utf8") !== path) fail();
  return Object.freeze({ path });
}
export function capturePortableAdapter(value: PortableLocalAdapter | undefined): PortableLocalAdapter | undefined {
  if (value === undefined) return undefined;
  const row = own(value, ["connector_ids", "decode", "encode"]);
  if (!Array.isArray(row.connector_ids) || row.connector_ids.length > MAX_IDS ||
      typeof row.decode !== "function" || typeof row.encode !== "function") fail();
  const ids: string[] = [];
  if (Reflect.ownKeys(row.connector_ids).length !== row.connector_ids.length + 1) fail();
  for (let i = 0; i < row.connector_ids.length; i++) {
    const d = Object.getOwnPropertyDescriptor(row.connector_ids, String(i));
    if (d === undefined || !Object.hasOwn(d, "value")) fail();
    const id = connectorId(d.value); if (ids.includes(id)) fail(); ids.push(id);
  }
  return Object.freeze({ connector_ids: Object.freeze(ids), decode: row.decode.bind(value), encode: row.encode.bind(value) });
}
function parseLines(bytes: Uint8Array, count: number, canonical = false): Record<string, unknown>[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_ROWS || bytes.byteLength > MAX_BYTES) fail();
  const text = UTF8.decode(bytes);
  if (text !== "" && !text.endsWith("\n")) fail();
  const lines = text === "" ? [] : text.slice(0, -1).split("\n");
  if (lines.length !== count) fail();
  return lines.map(line => {
    let row: unknown;
    try { row = JSON.parse(line); } catch { fail(); }
    // The versioned local stream has one canonical encoding, including unique
    // keys. Existing ledger streams retain their historical JSON semantics.
    if (canonical && JSON.stringify(row) !== line) fail();
    if (typeof row !== "object" || row === null || Array.isArray(row)) fail();
    return row as Record<string, unknown>;
  });
}

function checkSnapshots(files: ReturnType<typeof openCanonFiles>, snapshots: readonly CanonFileSnapshot[]): void {
  for (const expected of snapshots) {
    const current = files.readPrivate(expected.path);
    if (current === null) fail();
    try { if (!Buffer.from(current.bytes).equals(Buffer.from(expected.bytes))) fail(); }
    finally { current.close(); }
  }
}

/** Immutable expected bytes and fresh native reads bind inputs through publication. */
export function readPortableBackup(root: string, manifest: ExportManifest, adapter?: PortableLocalAdapter) {
  const entry = manifest.files[PORTABLE_LOCAL_STREAM];
  if (entry === undefined) {
    // Historical loose .state files are ignored. A v1 stream may never float
    // outside the manifest that defines its source/consent snapshot.
    try { lstatSync(join(root, PORTABLE_LOCAL_STREAM)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    fail();
  }
  if (manifest.schema !== "kizuki.backup/v3") fail();
  const parent = openCanonFiles(dirname(root));
  let files: ReturnType<typeof openCanonFiles>;
  try { files = openCanonFiles(root); } catch (error) { parent.close(); throw error; }
  const snapshots: CanonFileSnapshot[] = [];
  const check = (): void => {
    parent.assertPrivateDirectory(basename(root)); files.assertPrivateDirectory("connections");
    checkSnapshots(files, snapshots);
  };
  const close = (): void => { try { files.close(); } finally { parent.close(); } };
  try {
    check();
    const heldManifest = files.readPrivate("manifest.json"); if (heldManifest === null) fail(); snapshots.push(heldManifest);
    if (JSON.stringify(JSON.parse(UTF8.decode(heldManifest.bytes))) !== JSON.stringify(manifest)) fail();
    const read = (path: string): Record<string, unknown>[] => {
      const e = manifest.files[path];
      if (e === undefined || e.mode !== 0o600 || !Number.isSafeInteger(e.size) || e.size < 0 || e.size > MAX_BYTES ||
          !Number.isSafeInteger(e.count) || e.count < 0 || e.count > MAX_ROWS) fail();
      const snapshot = files.readPrivate(path); if (snapshot === null) fail(); snapshots.push(snapshot);
      const bytes = snapshot.bytes;
      if (bytes.byteLength !== e.size || sha256Hex(bytes) !== e.sha256) fail();
      return parseLines(bytes, e.count, path === PORTABLE_LOCAL_STREAM);
    };
    const raw = read(PORTABLE_LOCAL_STREAM), connections = read("connections.jsonl"), grants = read("ledger/source_grants.jsonl");
    const bySource = new Map<string, Record<string, unknown>>();
    for (const row of connections) {
      if (typeof row.source_key !== "string" || !isUlid(row.source_key) || bySource.has(row.source_key)) fail();
      connectorId(row.connector_id);
      if (row.disconnected_at !== null && !isRfc3339(row.disconnected_at)) fail();
      bySource.set(row.source_key, row);
    }
    const seen = new Set<string>();
    const records = raw.map(value => {
      const row = own(value, ["connector_id", "source_key", "path", "was_connected"]);
      const id = connectorId(row.connector_id);
      if (adapter !== undefined && !adapter.connector_ids.includes(id)) fail();
      if (typeof row.source_key !== "string" || !isUlid(row.source_key) || seen.has(row.source_key) || typeof row.was_connected !== "boolean") fail();
      const original = bySource.get(row.source_key);
      if (original === undefined || original.connector_id !== id || row.was_connected !== (original.disconnected_at === null) ||
          JSON.stringify(original.config) !== '{"schema":"kizuki.connection-config/v1","state_ref_index":null}' ||
          !Array.isArray(original.secret_refs) || original.secret_refs.length !== 0) fail();
      seen.add(row.source_key);
      return Object.freeze({ connector_id: id, source_key: row.source_key, ...config({ path: row.path }), was_connected: row.was_connected });
    });
    check();
    return { records: Object.freeze(records), connections, grants, check, close };
  } catch (error) { close(); throw error; }
}

export function capturePortableLocal(db: Database, vault: string, adapter?: PortableLocalAdapter) {
  if (adapter === undefined) return undefined;
  const files = openCanonFiles(vault), snapshots: CanonFileSnapshot[] = [];
  const records: PortableLocalRecord[] = [];
  const check = (): void => {
    if (snapshots.length > 0) { files.assertPrivateDirectory(".kizuki"); files.assertPrivateDirectory(".kizuki/connections"); }
    checkSnapshots(files, snapshots);
  };
  try {
    let bytesTotal = 0;
    const rows = db.query<{ connector_id: string; source_key: string }, []>("SELECT connector_id,source_key FROM connections ORDER BY connector_id,source_key LIMIT 1025").all();
    if (rows.length > MAX_ROWS) fail();
    for (const row of rows) {
      if (!adapter.connector_ids.includes(row.connector_id)) continue;
      // Local paths are private source configuration, not credential-free public
      // metadata. Missing/purged grants retain only the existing inert history.
      const grant = inspectSourceGrant(db, row.source_key);
      if (grant?.status !== "active" || grant.connector_id !== row.connector_id || !grant.policy.purposes.includes("export")) continue;
      const connection = getConnection(db, row.connector_id, row.source_key); if (connection === null) fail();
      if (connection.config.state_ref_index === null && connection.disconnected_at !== null) continue;
      if (connection.config.state_ref_index !== 0 || connection.secret_refs.length !== 1 ||
          connection.secret_refs[0] !== `file:connections/${connection.source_key}.state`) fail();
      files.assertPrivateDirectory(".kizuki"); files.assertPrivateDirectory(".kizuki/connections");
      if (sourceJournalNames(join(vault, ".kizuki/connections"), row.source_key).length > 0) fail();
      const snapshot = files.readPrivate(`.kizuki/connections/${row.source_key}.state`);
      if (snapshot === null) fail(); snapshots.push(snapshot);
      const bytes = snapshot.bytes; bytesTotal += bytes.byteLength; if (bytesTotal > MAX_BYTES) fail();
      const decoded = config(adapter.decode(row.connector_id, bytes));
      records.push(Object.freeze({ ...row, ...decoded, was_connected: connection.disconnected_at === null }));
      check();
    }
    if (Buffer.byteLength(records.map(row => JSON.stringify(row) + "\n").join("")) > MAX_BYTES) fail();
    check(); return { records: Object.freeze(records), check, close: () => files.close() };
  } catch (error) { files.close(); throw error; }
}

export function restorePortableLocal(db: Database, staging: string, records: readonly PortableLocalRecord[], adapter?: PortableLocalAdapter) {
  if (adapter === undefined || records.length === 0) return undefined;
  const files = openCanonFiles(staging), snapshots: CanonFileSnapshot[] = [];
  const check = (): void => {
    files.assertPrivateDirectory(".kizuki"); files.assertPrivateDirectory(".kizuki/connections");
    checkSnapshots(files, snapshots);
  };
  try {
    files.assertPrivateDirectory(".kizuki"); files.ensureDirectory(".kizuki/connections"); files.assertPrivateDirectory(".kizuki/connections");
    let restored = 0;
    db.transaction(() => {
      for (const row of records) {
        const bytes = adapter.encode(row.connector_id, config({ path: row.path }));
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES || config(adapter.decode(row.connector_id, bytes)).path !== row.path) fail();
        snapshots.push(files.create(`.kizuki/connections/${row.source_key}.state`, bytes));
        const grant = inspectSourceGrant(db, row.source_key);
        const active = row.was_connected && grant?.status === "active" && grant.connector_id === row.connector_id && grant.policy.purposes.includes("capture");
        const result = db.query("UPDATE connections SET config=?,secret_refs=?,disconnected_at=CASE WHEN ? THEN NULL ELSE disconnected_at END WHERE connector_id=? AND source_key=?")
          .run(STATE_CONNECTION_CONFIG, JSON.stringify([`file:connections/${row.source_key}.state`]), active ? 1 : 0, row.connector_id, row.source_key);
        if (result.changes !== 1) fail(); restored++;
      }
    }).immediate();
    check(); return { count: restored, check, close: () => files.close() };
  } catch (error) { files.close(); throw error; }
}
