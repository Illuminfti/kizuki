import type { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  ConnectionStateWriter,
  Connector,
  SignInIo,
} from "../contracts/connector";
import { ulid } from "../util/ulid";
import { isRfc3339 } from "../util/time";
import { LedgerError, getConnection, type Connection } from "./connections";

export const CONNECTION_CONFIG_SCHEMA = "kizuki.connection-config/v1" as const;
export const NULL_CONNECTION_CONFIG =
  '{"schema":"kizuki.connection-config/v1","state_ref_index":null}' as const;
export const STATE_CONNECTION_CONFIG =
  '{"schema":"kizuki.connection-config/v1","state_ref_index":0}' as const;
export const MAX_CONNECTION_STATE_BYTES = 1024 * 1024;

export interface ConnectionStateReader {
  /** Trusted-host-only resolver; it never appears in exports or connector data. */
  read(connection: Connection): Uint8Array | null;
}

interface PendingState {
  readonly sourceKey: string;
  readonly ref: string;
  readonly finalPath: string;
  temporaryPath: string | null;
  written: boolean;
  completed: boolean;
}

interface SwapJournal {
  schema: "kizuki.connection-state-swap/v1";
  connector_id: string;
  source_key: string;
  connected_at: string;
  final_name: string;
  backup_name: string | null;
}

interface ConnectedAtRow {
  connected_at: string;
}

/** The row a staged swap must still find when it commits. */
interface ConnectionExpectation {
  connected_at: string;
  disconnected_at: string | null;
}

/** The caller's snapshot is behind the row: re-read it and try again. */
export const STALE_CONNECTION_SNAPSHOT = "connection does not match persisted state";
/** Another writer committed while these bytes were being staged. */
export const CONCURRENT_CONNECTION_CHANGE =
  "connection changed while its state was being replaced";

type ChunkWriter = (
  fd: number,
  bytes: Uint8Array,
  offset: number,
  length: number,
) => number;

const writeChunk: ChunkWriter = (fd, bytes, offset, length) =>
  writeSync(fd, bytes, offset, length);

function isCoreUlid(value: string): boolean {
  return /^[0-9A-HJKMNPQRSTVWXYZ]{26}$/.test(value);
}

function stateRefFor(sourceKey: string): string {
  return `file:connections/${sourceKey}.state`;
}

function connectionStatePath(directory: string, ref: string): string {
  if (!ref.startsWith("file:connections/") || !ref.endsWith(".state")) {
    throw new LedgerError("connection state ref is invalid");
  }
  const path = resolve(dirname(directory), ref.slice("file:".length));
  if (dirname(path) !== resolve(directory) || relative(directory, path).startsWith("..")) {
    throw new LedgerError("connection state ref escapes the store");
  }
  return path;
}

/** Internal test seam; this module is not re-exported from the public package. */
export function writeAll(
  fd: number,
  bytes: Uint8Array,
  writer: ChunkWriter = writeChunk,
): void {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writer(fd, bytes, offset, bytes.byteLength - offset);
    if (written <= 0) {
      throw new LedgerError("connection state write made no progress");
    }
    offset += written;
  }
}

function writeDurableFile(path: string, bytes: Uint8Array): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "wx", 0o600);
    writeAll(fd, bytes);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      closeSync(fd);
      fd = undefined;
    }
    rmSync(path, { force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function nextConnectedAt(
  db: Database,
  connectorId: string,
  sourceKey: string,
): string {
  const previous = db
    .query<ConnectedAtRow, [string, string]>(
      "SELECT connected_at FROM connections WHERE connector_id = ? AND source_key = ?",
    )
    .get(connectorId, sourceKey);
  const previousMillis = previous === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.connected_at);
  if (previous !== null && !Number.isFinite(previousMillis)) {
    throw new LedgerError("stored connection timestamp is invalid");
  }
  const millis = Math.max(Date.now(), previousMillis + 1);
  const connectedAt = new Date(millis).toISOString();
  if (!isRfc3339(connectedAt)) {
    throw new LedgerError("core generated an invalid connection timestamp");
  }
  return connectedAt;
}

/**
 * Core-owned opaque-state store. Connector code gets only a one-shot writer;
 * it never receives a filesystem path or a durable row handle.
 */
export class ConnectionStateStore implements ConnectionStateReader {
  readonly directory: string;
  private readonly minted = new Set<string>();
  private readonly handles = new WeakSet<PendingState>();

  constructor(controlDirectory: string) {
    this.directory = join(controlDirectory, "connections");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }

  private beginFor(
    sourceKey: string,
  ): { pending: PendingState; writer: ConnectionStateWriter } {
    if (!isCoreUlid(sourceKey)) {
      throw new LedgerError("core generated an invalid source key");
    }
    if (this.minted.has(sourceKey)) {
      throw new LedgerError("connection state enrollment is already active");
    }
    const ref = stateRefFor(sourceKey);
    const pending: PendingState = {
      sourceKey,
      ref,
      finalPath: connectionStatePath(this.directory, ref),
      temporaryPath: null,
      written: false,
      completed: false,
    };
    this.minted.add(sourceKey);
    this.handles.add(pending);
    return {
      pending,
      writer: {
        write: async (state: Uint8Array): Promise<void> => {
          if (
            pending.completed ||
            !this.handles.has(pending) ||
            !this.minted.has(pending.sourceKey)
          ) {
            throw new LedgerError("connection state writer is no longer active");
          }
          if (pending.written) {
            throw new LedgerError("connection state may only be written once");
          }
          if (!(state instanceof Uint8Array)) {
            throw new LedgerError("connection state must be bytes");
          }
          if (state.byteLength > MAX_CONNECTION_STATE_BYTES) {
            throw new LedgerError("connection state exceeds maximum size");
          }
          const temporary = `${pending.finalPath}.${ulid()}.tmp`;
          try {
            writeDurableFile(temporary, state);
            pending.temporaryPath = temporary;
            pending.written = true;
          } catch (error) {
            rmSync(temporary, { force: true });
            throw error;
          }
        },
      },
    };
  }

  begin(): { pending: PendingState; writer: ConnectionStateWriter } {
    return this.beginFor(ulid());
  }

  discard(pending: PendingState): void {
    if (!this.handles.has(pending)) return;
    const hadTemporary = pending.temporaryPath !== null;
    if (pending.temporaryPath !== null) {
      rmSync(pending.temporaryPath, { force: true });
      pending.temporaryPath = null;
    }
    pending.completed = true;
    this.minted.delete(pending.sourceKey);
    if (hadTemporary) fsyncDirectory(this.directory);
  }

  /** Repairs an interrupted state swap before the next trusted enrollment. */
  recover(db: Database): void {
    for (const name of readdirSync(this.directory)) {
      if (!name.endsWith(".journal")) continue;
      const journalPath = join(this.directory, name);
      let journal: SwapJournal;
      try {
        journal = JSON.parse(readFileSync(journalPath, "utf8")) as SwapJournal;
      } catch {
        throw new LedgerError("connection state swap journal is unreadable");
      }
      if (
        journal.schema !== "kizuki.connection-state-swap/v1" ||
        typeof journal.connector_id !== "string" ||
        journal.connector_id.length === 0 ||
        !isCoreUlid(journal.source_key) ||
        !isRfc3339(journal.connected_at) ||
        journal.final_name !== `${journal.source_key}.state` ||
        (journal.backup_name !== null &&
          (basename(journal.backup_name) !== journal.backup_name ||
            !journal.backup_name.startsWith(`${journal.final_name}.`) ||
            !journal.backup_name.endsWith(".rollback")))
      ) {
        throw new LedgerError("connection state swap journal is invalid");
      }
      const finalPath = join(this.directory, journal.final_name);
      const backupPath = journal.backup_name === null
        ? null
        : join(this.directory, journal.backup_name);
      const row = db
        .query<ConnectedAtRow, [string, string]>(
          "SELECT connected_at FROM connections WHERE connector_id = ? AND source_key = ?",
        )
        .get(journal.connector_id, journal.source_key);
      if (row?.connected_at === journal.connected_at) {
        if (!existsSync(finalPath)) {
          throw new LedgerError("committed connection state is missing");
        }
        if (backupPath !== null) rmSync(backupPath, { force: true });
      } else if (backupPath !== null && existsSync(backupPath)) {
        rmSync(finalPath, { force: true });
        renameSync(backupPath, finalPath);
      } else if (backupPath !== null) {
        if (!existsSync(finalPath)) {
          throw new LedgerError("connection state and rollback are both missing");
        }
        // The journal was durable before the first rename. The original final
        // file is therefore still authoritative when its planned backup does
        // not exist and the database row was not committed.
      } else {
        rmSync(finalPath, { force: true });
      }
      rmSync(journalPath, { force: true });
      fsyncDirectory(this.directory);
    }
  }

  /**
   * `expect` is the row the caller validated before it staged bytes. Committing
   * against it is what keeps a disconnect or a competing rewrite that landed
   * during the staging window from being silently undone.
   */
  save(
    db: Database,
    connectorId: string,
    pending: PendingState,
    expect?: ConnectionExpectation,
  ): Connection {
    if (
      !this.handles.has(pending) ||
      !this.minted.has(pending.sourceKey) ||
      pending.completed
    ) {
      throw new LedgerError("connection state handle was not minted by this store");
    }
    const existing = existsSync(pending.finalPath);
    if (existing && !pending.written) {
      throw new LedgerError("existing connection state cannot be cleared implicitly");
    }
    const refs = pending.written ? [pending.ref] : [];
    const config = pending.written ? STATE_CONNECTION_CONFIG : NULL_CONNECTION_CONFIG;
    const connectedAt = nextConnectedAt(db, connectorId, pending.sourceKey);
    const backupPath = existing
      ? `${pending.finalPath}.${ulid()}.rollback`
      : null;
    const journalPath = pending.written
      ? `${pending.finalPath}.${ulid()}.journal`
      : null;
    let swapped = false;
    let committed = false;
    try {
      if (journalPath !== null) {
        const journal: SwapJournal = {
          schema: "kizuki.connection-state-swap/v1",
          connector_id: connectorId,
          source_key: pending.sourceKey,
          connected_at: connectedAt,
          final_name: basename(pending.finalPath),
          backup_name: backupPath === null ? null : basename(backupPath),
        };
        writeDurableFile(
          journalPath,
          new TextEncoder().encode(JSON.stringify(journal)),
        );
        fsyncDirectory(this.directory);
        if (backupPath !== null) renameSync(pending.finalPath, backupPath);
        if (pending.temporaryPath === null) {
          throw new LedgerError("connection state staging is missing");
        }
        renameSync(pending.temporaryPath, pending.finalPath);
        pending.temporaryPath = null;
        swapped = true;
        fsyncDirectory(this.directory);
      }
      db.transaction(() => {
        if (expect === undefined) {
          db.query(
            `INSERT INTO connections
               (connector_id, source_key, config, secret_refs, connected_at, disconnected_at)
             VALUES (?, ?, ?, ?, ?, NULL)
             ON CONFLICT (connector_id, source_key) DO UPDATE SET
               config = excluded.config, secret_refs = excluded.secret_refs,
               connected_at = excluded.connected_at, disconnected_at = NULL`,
          ).run(
            connectorId,
            pending.sourceKey,
            config,
            JSON.stringify(refs),
            connectedAt,
          );
          return;
        }
        const result = db
          .query(
            `UPDATE connections
                SET config = ?, secret_refs = ?, connected_at = ?, disconnected_at = NULL
              WHERE connector_id = ? AND source_key = ?
                AND connected_at = ? AND disconnected_at IS ?`,
          )
          .run(
            config,
            JSON.stringify(refs),
            connectedAt,
            connectorId,
            pending.sourceKey,
            expect.connected_at,
            expect.disconnected_at,
          );
        if (result.changes !== 1) {
          throw new LedgerError(CONCURRENT_CONNECTION_CHANGE);
        }
      }).immediate();
      committed = true;
      if (backupPath !== null) rmSync(backupPath, { force: true });
      if (journalPath !== null) rmSync(journalPath, { force: true });
      if (journalPath !== null || backupPath !== null) {
        fsyncDirectory(this.directory);
      }
    } catch (error) {
      if (!committed) {
        if (swapped) {
          rmSync(pending.finalPath, { force: true });
          if (backupPath !== null && existsSync(backupPath)) {
            renameSync(backupPath, pending.finalPath);
          }
        } else if (backupPath !== null && existsSync(backupPath)) {
          renameSync(backupPath, pending.finalPath);
        }
        if (pending.temporaryPath !== null) {
          rmSync(pending.temporaryPath, { force: true });
          pending.temporaryPath = null;
        }
        if (journalPath !== null) rmSync(journalPath, { force: true });
        fsyncDirectory(this.directory);
      }
      throw error;
    }
    pending.completed = true;
    this.minted.delete(pending.sourceKey);
    const connection = getConnection(db, connectorId, pending.sourceKey);
    if (connection === null) {
      throw new LedgerError("saved connection was not found");
    }
    return connection;
  }

  read(connection: Connection): Uint8Array | null {
    if (connection.secret_refs.length === 0) return null;
    if (connection.config.state_ref_index !== 0) {
      throw new LedgerError("connection config does not permit state resolution");
    }
    if (connection.secret_refs.length !== 1) {
      throw new LedgerError("connection has invalid state references");
    }
    const ref = connection.secret_refs[0];
    if (ref === undefined) {
      throw new LedgerError("connection has no state reference");
    }
    const path = connectionStatePath(this.directory, ref);
    if (!existsSync(path)) {
      throw new LedgerError("connection state is missing");
    }
    return new Uint8Array(readFileSync(path));
  }

  /**
   * The one staging path for replacing the state of an existing source: it
   * validates the caller's connection against the persisted row, stages new
   * bytes in a 0600 sibling, and swaps only once `update` has written.
   */
  private async swap(
    db: Database,
    connection: Connection,
    update: (writer: ConnectionStateWriter) => Promise<void>,
    options: { missingStateMessage: string; refuseDisconnected: boolean },
  ): Promise<Connection> {
    this.recover(db);
    const persisted = getConnection(
      db,
      connection.connector_id,
      connection.source_key,
    );
    if (persisted === null) {
      throw new LedgerError("connection is not persisted for state replacement");
    }
    if (
      persisted.connected_at !== connection.connected_at ||
      persisted.disconnected_at !== connection.disconnected_at ||
      persisted.config.state_ref_index !== connection.config.state_ref_index ||
      persisted.secret_refs.length !== connection.secret_refs.length ||
      persisted.secret_refs.some((ref, index) => ref !== connection.secret_refs[index])
    ) {
      throw new LedgerError(STALE_CONNECTION_SNAPSHOT);
    }
    if (
      persisted.config.state_ref_index !== 0 ||
      persisted.secret_refs[0] !== stateRefFor(persisted.source_key)
    ) {
      throw new LedgerError("connection is not eligible for state replacement");
    }
    // save() clears disconnected_at, so an automatic path that accepted a
    // withdrawn grant would let a background refresh undo an owner's
    // disconnect. Only an interactive re-sign-in may reconnect a source.
    if (options.refuseDisconnected && persisted.disconnected_at !== null) {
      throw new LedgerError("connection is disconnected");
    }
    this.read(persisted);
    const pending = this.beginFor(persisted.source_key);
    try {
      await update(pending.writer);
      if (!pending.pending.written) {
        throw new LedgerError(options.missingStateMessage);
      }
      return this.save(db, persisted.connector_id, pending.pending, {
        connected_at: persisted.connected_at,
        disconnected_at: persisted.disconnected_at,
      });
    } catch (error) {
      this.discard(pending.pending);
      throw error;
    }
  }

  /**
   * Re-authentication keeps the core source identity. New opaque bytes are
   * staged in a 0600 sibling then atomically renamed only after sign-in
   * succeeds, so a connector never observes or chooses the durable pathname.
   */
  async replace(
    db: Database,
    connection: Connection,
    connector: Connector,
    io: SignInIo,
  ): Promise<Connection> {
    const signIn = connector.signIn;
    if (typeof signIn !== "function") {
      throw new LedgerError("connector does not implement interactive sign-in");
    }
    return this.swap(
      db,
      connection,
      async (writer) => {
        await signIn.call(connector, io, writer);
      },
      {
        missingStateMessage:
          "replacement sign-in did not provide connection state",
        // A re-sign-in is the owner reconnecting a source on purpose.
        refuseDisconnected: false,
      },
    );
  }

  /**
   * Non-interactive state replacement for the same source: token refresh and
   * refresh-token rotation. The connection must already hold state and must
   * still be connected, and `update` gets a one-shot writer scoped to it.
   * `save` advances
   * `connected_at` on every rewrite, so from here on that column means
   * "state last written at", not "signed in at".
   */
  async rewrite(
    db: Database,
    connection: Connection,
    update: (writer: ConnectionStateWriter) => Promise<void>,
  ): Promise<Connection> {
    return this.swap(db, connection, update, {
      missingStateMessage: "state rewrite did not provide connection state",
      refuseDisconnected: true,
    });
  }
}

/** Runs an interactive sign-in and persists only host-minted opaque state. */
export async function enrollConnection(
  db: Database,
  store: ConnectionStateStore,
  connector: Connector,
  io: SignInIo,
): Promise<Connection> {
  if (typeof connector.signIn !== "function") {
    throw new LedgerError("connector does not implement interactive sign-in");
  }
  store.recover(db);
  const pending = store.begin();
  try {
    await connector.signIn(io, pending.writer);
    return store.save(db, connector.manifest().connector_id, pending.pending);
  } catch (error) {
    store.discard(pending.pending);
    throw error;
  }
}
