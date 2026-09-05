import type { Database } from "bun:sqlite";
import {
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  closeSync,
} from "node:fs";
import { basename, join } from "node:path";
import type {
  ConnectionStateWriter,
  Connector,
  SignInIo,
} from "../contracts/connector";
import { sha256Hex } from "../util/hash";
import { ulid } from "../util/ulid";
import {
  MAX_CONNECTION_STATE_BYTES,
  assertRegularStateFile,
  clearSwapDebris,
  connectionStatePath,
  fsyncDirectory,
  isCoreUlid,
  journalSourceKey,
  sourceJournalNames,
  restoreStateFile,
  stateRefFor,
  swapStateFile,
  sweepAbandonedStaging,
  writeDurableFile,
} from "./connection-state-files";
import {
  quarantineJournal,
  repairSwap,
  type SwapJournal,
} from "./connection-state-journal";
import {
  commitConnectionRow,
  nextConnectedAt,
  writeLocked,
  type ConnectionExpectation,
} from "./connection-state-rows";
import { LedgerError, getConnection, type Connection } from "./connections";
import { runGuardedSignIn } from "./sign-in-guard";

export { writeAll } from "./connection-state-files";
export { MAX_CONNECTION_STATE_BYTES };

export const CONNECTION_CONFIG_SCHEMA = "kizuki.connection-config/v1" as const;
export const NULL_CONNECTION_CONFIG =
  '{"schema":"kizuki.connection-config/v1","state_ref_index":null}' as const;
export const STATE_CONNECTION_CONFIG =
  '{"schema":"kizuki.connection-config/v1","state_ref_index":0}' as const;

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
  digest: string | null;
  byteLength: number;
}

export interface StateRecoveryReport {
  repaired: number;
  unresolved: string[];
  quarantined: string[];
  swept: boolean;
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
      digest: null,
      byteLength: 0,
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
            pending.digest = sha256Hex(state);
            pending.byteLength = state.byteLength;
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
  recover(db: Database): StateRecoveryReport {
    const report: StateRecoveryReport = {
      repaired: 0,
      unresolved: [],
      quarantined: [],
      swept: false,
    };
    writeLocked(db, () => {
      const journals = readdirSync(this.directory).filter((name) =>
        name.endsWith(".journal"),
      );
      for (const name of journals) {
        try {
          repairSwap(db, this.directory, name);
          report.repaired += 1;
        } catch {
          if (journalSourceKey(name) !== null) {
            report.unresolved.push(name);
            continue;
          }
          try {
            report.quarantined.push(quarantineJournal(this.directory, name));
          } catch {
            report.quarantined.push(name);
          }
        }
      }
      sweepAbandonedStaging(this.directory, this.staging);
      report.swept = true;
    });
    return report;
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
    implementationVersion = "",
    verifyNew?: (candidate: Uint8Array, existing: readonly { connection: Connection; state: Uint8Array }[]) => void,
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
    let rolledBack = false;
    const undoSwap = (): void => {
      // Set first: a rollback that fails part way through must not be run
      // again outside the lock, where it could take away bytes a recovery in
      // another process had already restored.
      rolledBack = true;
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
    };
    try {
      writeLocked(db, () => {
        if (verifyNew !== undefined) {
          if (expect !== undefined || existsSync(pending.finalPath) || getConnection(db, connectorId, pending.sourceKey) !== null) {
            throw new LedgerError("new enrollment verification cannot replace a source");
          }
          const staging = pending.temporaryPath;
          if (!pending.written || staging === null) throw new LedgerError("new enrollment state is missing");
          const candidate = this.readStatePath(staging);
          if (candidate.byteLength !== pending.byteLength || sha256Hex(candidate) !== pending.digest) {
            throw new LedgerError("new enrollment staged digest mismatch");
          }
          // Limit at the SQL boundary; never authorize from a truncated scan.
          const rows = db.query<{ source_key: string }, [string]>(
            "SELECT source_key FROM connections WHERE connector_id = ? ORDER BY source_key LIMIT 33",
          ).all(connectorId);
          if (rows.length >= 32) throw new LedgerError("new enrollment identity scan exceeds bounds");
          let totalBytes = candidate.byteLength;
          const existingStates = rows.map(row => {
            const connection = getConnection(db, connectorId, row.source_key);
            if (connection === null) throw new LedgerError("new enrollment identity is unavailable");
            const state = this.read(connection);
            if (state === null) throw new LedgerError("new enrollment identity is unavailable");
            totalBytes += state.byteLength;
            if (totalBytes > 8 * 1024 * 1024) throw new LedgerError("new enrollment identity scan exceeds bounds");
            return { connection, state };
          });
          // Trusted synchronous host policy, with the same lock that publishes
          // the file and row. No provider call or asynchronous work belongs here.
          const result: unknown = verifyNew(candidate, existingStates);
          if (result !== undefined) {
            if (result instanceof Promise) void result.catch(() => {});
            throw new LedgerError("new enrollment verifier must complete synchronously");
          }
          const verified = this.readStatePath(staging);
          if (verified.byteLength !== pending.byteLength || sha256Hex(verified) !== pending.digest) {
            throw new LedgerError("new enrollment staged digest mismatch");
          }
        }
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
          if (pending.digest === null) {
            throw new LedgerError("connection state digest is missing");
          }
          const journal: SwapJournal = {
            schema: "kizuki.connection-state-swap/v1",
            connector_id: connectorId,
            source_key: pending.sourceKey,
            connected_at: connectedAt,
            final_name: basename(pending.finalPath),
            backup_name: backupPath === null ? null : basename(backupPath),
            final_sha256: pending.digest,
            final_bytes: pending.byteLength,
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
          implementationVersion,
          expect,
        });
      }, undoSwap);
    } catch (error) {
      // Reached without the locked rollback only when the transaction never
      // opened, or when the commit itself failed after the files had moved.
      // A swap that landed belongs to recovery from here: its journal is on
      // disk and the next recover() undoes it under the lock. The staged
      // bytes of a swap that never started are still this call's to remove.
      if (!rolledBack && !swapped) undoSwap();
      throw error;
    }
    clearSwapDebris(this.directory, { backupPath, journalPath });
    pending.completed = true;
    this.minted.delete(pending.sourceKey);
    const connection = getConnection(db, connectorId, pending.sourceKey);
    if (connection === null) {
      throw new LedgerError("saved connection was not found");
    }
    return connection;
  }

  private readStatePath(path: string): Uint8Array {
    const stats = assertRegularStateFile(path, this.directory);
    if (stats.size > MAX_CONNECTION_STATE_BYTES) throw new LedgerError("connection state exceeds maximum size");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const bytes = new Uint8Array(stats.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const read = readSync(fd, bytes, offset, bytes.byteLength - offset, offset);
        if (read <= 0) throw new LedgerError("connection state read made no progress");
        offset += read;
      }
      return bytes;
    } finally { closeSync(fd); }
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
    if (sourceJournalNames(this.directory, connection.source_key).length > 0) {
      throw new LedgerError("connection state journal is unresolved");
    }
    const path = connectionStatePath(this.directory, ref);
    return this.readStatePath(path);
  }

  /**
   * The one staging path for replacing the state of an existing source: it
   * validates the caller's connection against the persisted row, stages new
   * bytes in a 0600 sibling, and swaps only once `update` has written.
   */
  private async swap(
    db: Database,
    connection: Connection,
    update: (writer: ConnectionStateWriter, previous: Uint8Array) => Promise<void>,
    options: {
      missingStateMessage: string;
      refuseDisconnected: boolean;
      implementationVersion: string;
      verifyReplacement?: (previous: Uint8Array, candidate: Uint8Array) => void;
    },
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
    const previous = this.read(persisted);
    if (previous === null) throw new LedgerError("connection state is missing");
    const pending = this.beginFor(persisted.source_key);
    try {
      await update(pending.writer, previous);
      if (!pending.pending.written) {
        throw new LedgerError(options.missingStateMessage);
      }
      if (options.verifyReplacement !== undefined) {
        const path = pending.pending.temporaryPath;
        if (path === null) throw new LedgerError(options.missingStateMessage);
        options.verifyReplacement(previous, this.readStatePath(path));
      }
      return this.save(
        db,
        persisted.connector_id,
        pending.pending,
        {
          connected_at: persisted.connected_at,
          disconnected_at: persisted.disconnected_at,
        },
        options.implementationVersion,
      );
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
    verifyReplacement?: (previous: Uint8Array, candidate: Uint8Array) => void,
  ): Promise<Connection> {
    if (connector.manifest().connector_id !== connection.connector_id) {
      throw new LedgerError("replacement connector does not match the connection");
    }
    return this.swap(
      db,
      connection,
      async (writer, previous) => {
        await runGuardedSignIn(connector, io, writer, { mode: "replace", previous_state: previous });
      },
      {
        missingStateMessage:
          "replacement sign-in did not provide connection state",
        // A re-sign-in is the owner reconnecting a source on purpose.
        refuseDisconnected: false,
        implementationVersion: connector.manifest().version,
        ...(verifyReplacement === undefined ? {} : { verifyReplacement }),
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
    return this.swap(db, connection, writer => update(writer), {
      missingStateMessage: "state rewrite did not provide connection state",
      refuseDisconnected: true,
      implementationVersion: connection.implementation_version,
    });
  }
}
