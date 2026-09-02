import type { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  ConnectionStateWriter,
  Connector,
  SignInIo,
} from "../contracts/connector";
import { ulid } from "../util/ulid";
import {
  clearSwapDebris,
  connectionStatePath,
  fsyncDirectory,
  isCoreUlid,
  restoreStateFile,
  stateRefFor,
  swapStateFile,
  sweepAbandonedStaging,
  writeDurableFile,
} from "./connection-state-files";
import { repairSwap, type SwapJournal } from "./connection-state-journal";
import {
  commitConnectionRow,
  nextConnectedAt,
  writeLocked,
  type ConnectionExpectation,
} from "./connection-state-rows";
import { LedgerError, getConnection, type Connection } from "./connections";

export { writeAll } from "./connection-state-files";

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

/** The caller offered a row the store has already moved past. */
const STALE_CONNECTION_SNAPSHOT = "connection does not match persisted state";

/**
 * Core-owned opaque-state store. Connector code gets only a one-shot writer;
 * it never receives a filesystem path or a durable row handle.
 */
export class ConnectionStateStore implements ConnectionStateReader {
  readonly directory: string;
  private readonly minted = new Set<string>();
  private readonly handles = new WeakSet<PendingState>();
  /** Staging paths this store is still writing, so recovery leaves them alone. */
  private readonly staging = new Set<string>();

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
            this.staging.add(temporary);
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
      this.staging.delete(pending.temporaryPath);
      rmSync(pending.temporaryPath, { force: true });
      pending.temporaryPath = null;
    }
    pending.completed = true;
    this.minted.delete(pending.sourceKey);
    if (hadTemporary) fsyncDirectory(this.directory);
  }

  /** Repairs an interrupted state swap before the next trusted enrollment. */
  recover(db: Database): void {
    const journals = readdirSync(this.directory).filter((name) =>
      name.endsWith(".journal"),
    );
    if (journals.length > 0) {
      // A journal is only crash debris once no writer is standing over it, and
      // the write lock is what tells the two apart across processes.
      writeLocked(db, () => {
        for (const name of journals) repairSwap(db, this.directory, name);
      });
    }
    sweepAbandonedStaging(this.directory, this.staging);
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
    let backupPath: string | null = null;
    let journalPath: string | null = null;
    let swapped = false;
    let committed = false;
    try {
      writeLocked(db, () => {
        const existing = existsSync(pending.finalPath);
        if (existing && !pending.written) {
          throw new LedgerError(
            "existing connection state cannot be cleared implicitly",
          );
        }
        const connectedAt = nextConnectedAt(db, connectorId, pending.sourceKey);
        backupPath = existing ? `${pending.finalPath}.${ulid()}.rollback` : null;
        const staging = pending.temporaryPath;
        if (pending.written) {
          if (staging === null) {
            throw new LedgerError("connection state staging is missing");
          }
          journalPath = `${pending.finalPath}.${ulid()}.journal`;
          const journal: SwapJournal = {
            schema: "kizuki.connection-state-swap/v1",
            connector_id: connectorId,
            source_key: pending.sourceKey,
            connected_at: connectedAt,
            final_name: basename(pending.finalPath),
            backup_name: backupPath === null ? null : basename(backupPath),
          };
          swapStateFile(this.directory, {
            finalPath: pending.finalPath,
            stagingPath: staging,
            backupPath,
            journalPath,
            journalBytes: new TextEncoder().encode(JSON.stringify(journal)),
          });
          this.staging.delete(staging);
          pending.temporaryPath = null;
          swapped = true;
        }
        commitConnectionRow(db, {
          connectorId,
          sourceKey: pending.sourceKey,
          config: pending.written
            ? STATE_CONNECTION_CONFIG
            : NULL_CONNECTION_CONFIG,
          secretRefs: pending.written ? [pending.ref] : [],
          connectedAt,
          expect,
        });
      });
      committed = true;
      clearSwapDebris(this.directory, { backupPath, journalPath });
    } catch (error) {
      if (!committed) {
        const staging = pending.temporaryPath;
        if (staging !== null) {
          this.staging.delete(staging);
          pending.temporaryPath = null;
        }
        restoreStateFile(this.directory, {
          finalPath: pending.finalPath,
          stagingPath: staging,
          backupPath,
          journalPath,
          swapped,
        });
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
