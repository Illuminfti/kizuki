import { Database, constants as SQLITE_CONSTANTS } from "bun:sqlite";
import { lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { Connector } from "../contracts/connector";
import { CONNECTOR_OPERATION_DEADLINE_MS } from "../contracts/connector";
import { DeadlineError, withDeadline } from "../util/deadline";
import { sha256Hex } from "../util/hash";
import { isRfc3339 } from "../util/time";
import { isUlid, ulid } from "../util/ulid";
import type { ConnectionStateStore } from "./connection-state";
import { acquireConnectionStateLease, type ConnectionStateLease } from "./connection-state-lock";
import { disconnect, DisconnectError, getConnection, LedgerError, type Connection } from "./connections";

export interface ConnectionDisconnectReceipt {
  sequence: number;
  receipt_id: string;
  operation_id: string;
  connector_id: string;
  source_key: string;
  connected_at: string;
  enrollment_digest: string;
  disconnected_at: string;
  phase: "started" | "revoked" | "revoke_failed";
  at: string;
  diagnostic: "provider_revoke_failed" | null;
}
export interface ConnectionDisconnectOutcome {
  status: "completed" | "provider_pending";
  operation_id: string;
  connector_id: string;
  source_key: string;
  disconnected_at: string;
  diagnostic: "provider_revoke_failed" | "provider_revoke_pending" | "disconnect_audit_unavailable" | null;
}
export interface ConnectionDisconnectIo { db: Database; store: ConnectionStateStore; }

const nativeQuery = Database.prototype.query;
const nativeFileControl = Database.prototype.fileControl;
const nativeInTransaction = Object.getOwnPropertyDescriptor(Database.prototype, "inTransaction")!.get!;

function acquireDisconnectLease(io: ConnectionDisconnectIo): ConnectionStateLease {
  if (nativeInTransaction.call(io.db)) throw new LedgerError("disconnect_requires_top_level_transaction");
  const control = dirname(io.store.directory), lease = acquireConnectionStateLease(control);
  try {
    const mainFile = () => (nativeQuery.call(io.db, "PRAGMA database_list").all() as { name: string; file: string }[]).find(row => row.name === "main")?.file;
    const file = mainFile();
    if (!file || dirname(realpathSync(file)) !== realpathSync(control)) throw new LedgerError("disconnect_database_mismatch");
    const original = lstatSync(file);
    const assertCurrent = () => {
      lease.assertCurrent();
      try {
        const current = lstatSync(file), moved = new Int32Array([-1]);
        if (mainFile() !== file || !current.isFile() || current.nlink !== 1 || current.uid !== process.geteuid?.() ||
            current.dev !== original.dev || current.ino !== original.ino ||
            nativeFileControl.call(io.db, "main", SQLITE_CONSTANTS.SQLITE_FCNTL_HAS_MOVED, moved) !== 0 || moved[0] !== 0) {
          throw new LedgerError("disconnect_database_mismatch");
        }
      } catch { throw new LedgerError("disconnect_database_mismatch"); }
    };
    assertCurrent();
    return { assertCurrent, release: () => lease.release() };
  } catch (error) {
    lease.release();
    throw error instanceof LedgerError ? error : new LedgerError("disconnect_database_mismatch");
  }
}

function binding(connection: Connection): string {
  return sha256Hex(JSON.stringify([connection.connector_id, connection.source_key, connection.connected_at,
    connection.implementation_version, connection.config.schema, connection.config.state_ref_index, connection.secret_refs]));
}

function outcome(receipt: ConnectionDisconnectReceipt, diagnostic: ConnectionDisconnectOutcome["diagnostic"] = receipt.diagnostic): ConnectionDisconnectOutcome {
  return { status: receipt.phase === "revoked" ? "completed" : "provider_pending", operation_id: receipt.operation_id,
    connector_id: receipt.connector_id, source_key: receipt.source_key, disconnected_at: receipt.disconnected_at, diagnostic };
}

function validRow(row: ConnectionDisconnectReceipt): void {
  if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || !isUlid(row.receipt_id) || !isUlid(row.operation_id) ||
      !isUlid(row.source_key) || !isRfc3339(row.connected_at) || !isRfc3339(row.disconnected_at) || !isRfc3339(row.at) ||
      !/^[a-f0-9]{64}$/.test(row.enrollment_digest) || !["started", "revoked", "revoke_failed"].includes(row.phase) ||
      row.diagnostic !== (row.phase === "revoke_failed" ? "provider_revoke_failed" : null)) throw new LedgerError("disconnect_receipt_invalid");
}

function nextReceipt(previous: ConnectionDisconnectReceipt | undefined, row: ConnectionDisconnectReceipt): void {
  validRow(row);
  if (previous === undefined) {
    if (row.phase !== "started" || row.receipt_id !== row.operation_id) throw new LedgerError("disconnect_receipt_invalid");
    return;
  }
  if (row.sequence <= previous.sequence || previous.phase === "revoked" ||
      (row.phase !== "started" && previous.phase !== "started") ||
      ["operation_id", "connector_id", "source_key", "connected_at", "enrollment_digest", "disconnected_at"].some(key =>
        row[key as keyof ConnectionDisconnectReceipt] !== previous[key as keyof ConnectionDisconnectReceipt])) throw new LedgerError("disconnect_receipt_invalid");
}

/** Validate portable history in operation order with constant working memory. */
export function assertConnectionDisconnectReceipts(db: Database): void {
  if (db.query("SELECT 1 FROM connection_disconnect_receipts r LEFT JOIN connections c ON c.source_key=r.source_key AND c.connector_id=r.connector_id WHERE c.source_key IS NULL LIMIT 1").get() !== null) {
    throw new LedgerError("disconnect_receipt_invalid");
  }
  let previous: ConnectionDisconnectReceipt | undefined;
  for (const row of db.query<ConnectionDisconnectReceipt, []>("SELECT * FROM connection_disconnect_receipts ORDER BY operation_id,sequence").iterate()) {
    nextReceipt(previous?.operation_id === row.operation_id ? previous : undefined, row);
    previous = row;
  }
}

export function inspectConnectionDisconnect(db: Database, operationId: string): ConnectionDisconnectOutcome | null {
  const last = latest(db, operationId);
  return last === null ? null : outcome(last);
}

function latest(db: Database, operationId: string): ConnectionDisconnectReceipt | null {
  if (!isUlid(operationId)) throw new LedgerError("disconnect_operation_invalid");
  let last: ConnectionDisconnectReceipt | undefined;
  for (const row of db.query<ConnectionDisconnectReceipt, [string]>("SELECT * FROM connection_disconnect_receipts WHERE operation_id=? ORDER BY sequence").iterate(operationId)) {
    nextReceipt(last, row); last = row;
  }
  return last ?? null;
}

function append(db: Database, receipt: Omit<ConnectionDisconnectReceipt, "sequence">): ConnectionDisconnectReceipt {
  const { receipt_id, operation_id, connector_id, source_key, connected_at, enrollment_digest, disconnected_at, phase, at, diagnostic } = receipt;
  const result = db.query("INSERT INTO connection_disconnect_receipts (receipt_id,operation_id,connector_id,source_key,connected_at,enrollment_digest,disconnected_at,phase,at,diagnostic) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(receipt_id, operation_id, connector_id, source_key, connected_at, enrollment_digest, disconnected_at, phase, at, diagnostic);
  if (result.changes !== 1) throw new LedgerError("disconnect_audit_unavailable");
  const recorded = db.query<ConnectionDisconnectReceipt, [string]>("SELECT * FROM connection_disconnect_receipts WHERE receipt_id=?").get(receipt_id);
  if (recorded === null || recorded.sequence !== Number(result.lastInsertRowid) ||
      Object.entries(receipt).some(([key, value]) => key !== "sequence" && recorded[key as keyof ConnectionDisconnectReceipt] !== value)) {
    throw new LedgerError("disconnect_audit_unavailable");
  }
  validRow(recorded);
  return recorded;
}

function requireBinding(io: ConnectionDisconnectIo, connector: Connector, expected: Connection): Connection {
  const current = getConnection(io.db, expected.connector_id, expected.source_key);
  if (current === null) throw new DisconnectError("unknown_connection");
  if (connector.manifest().connector_id !== current.connector_id || binding(current) !== binding(expected)) throw new LedgerError("disconnect_enrollment_changed");
  return current;
}

async function revoke(io: ConnectionDisconnectIo, connector: Connector, receipt: ConnectionDisconnectReceipt, lease: ConnectionStateLease): Promise<ConnectionDisconnectOutcome> {
  const work = (async () => {
    try { lease.assertCurrent(); } catch { return outcome(receipt, "disconnect_audit_unavailable"); }
    let phase: ConnectionDisconnectReceipt["phase"] = "revoked";
    try { await connector.revoke(); } catch { phase = "revoke_failed"; }
    try {
      lease.assertCurrent();
      const recorded = append(io.db, { ...receipt, receipt_id: ulid(), phase, at: new Date().toISOString(),
        diagnostic: phase === "revoke_failed" ? "provider_revoke_failed" : null });
      return outcome(recorded);
    } catch { return outcome(receipt, "disconnect_audit_unavailable"); }
  })().finally(() => lease.release());
  try { return await withDeadline(work, CONNECTOR_OPERATION_DEADLINE_MS, "provider_revoke_pending"); }
  catch (error) {
    if (!(error instanceof DeadlineError)) throw error;
    // The operation owns the lease until actual settlement, even after timeout.
    return outcome(receipt, "provider_revoke_pending");
  }
}

/** Trusted host seam: the connector was loaded from the supplied enrollment. */
export async function disconnectConnection(io: ConnectionDisconnectIo, connector: Connector, expected: Connection): Promise<ConnectionDisconnectOutcome> {
  const lease = acquireDisconnectLease(io);
  let receipt: ConnectionDisconnectReceipt;
  try {
    receipt = io.db.transaction(() => {
      lease.assertCurrent();
      const current = requireBinding(io, connector, expected);
      lease.assertCurrent();
      const transition = disconnect(io.db, current.connector_id, current.source_key);
      const operation_id = ulid();
      return append(io.db, { receipt_id: operation_id, operation_id, ...transition, connected_at: current.connected_at,
        enrollment_digest: binding(current), phase: "started", at: transition.disconnected_at, diagnostic: null });
    }).immediate();
  } catch (error) { lease.release(); throw error; }
  return revoke(io, connector, receipt, lease);
}

/** Explicit retry never reconnects, changes consent, or rewrites the timestamp. */
export async function resumeConnectionDisconnect(io: ConnectionDisconnectIo, connector: Connector, operationId: string): Promise<ConnectionDisconnectOutcome> {
  const lease = acquireDisconnectLease(io);
  let receipt: ConnectionDisconnectReceipt;
  try {
    receipt = io.db.transaction(() => {
      lease.assertCurrent();
      const previous = latest(io.db, operationId);
      if (previous === null) throw new LedgerError("disconnect_operation_unknown");
      if (previous.phase === "revoked") throw new LedgerError("disconnect_already_completed");
      const current = getConnection(io.db, previous.connector_id, previous.source_key);
      if (current === null || current.disconnected_at !== previous.disconnected_at || binding(current) !== previous.enrollment_digest ||
          connector.manifest().connector_id !== previous.connector_id) throw new LedgerError("disconnect_enrollment_changed");
      lease.assertCurrent();
      return append(io.db, { ...previous, receipt_id: ulid(), phase: "started", at: new Date().toISOString(), diagnostic: null });
    }).immediate();
  } catch (error) { lease.release(); throw error; }
  return revoke(io, connector, receipt, lease);
}
