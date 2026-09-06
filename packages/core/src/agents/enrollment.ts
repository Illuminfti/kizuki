import { Database, type Database as DatabaseType } from "bun:sqlite";
import { lstatSync } from "node:fs";
import { dirname, basename, isAbsolute, relative, resolve } from "node:path";
import { recordLifecycle } from "./audit";
import { openCredentialDirectory, type CredentialDirectory, type CredentialFileIdentity, type CredentialFileInspection } from "./credential-file";
import {
  AGENT_NAME,
  authenticate,
  generateAgentToken,
  getAgent,
  hashAgentToken,
  principalForAgentId,
  revokeAgentInTransaction,
  validateAgentGrant,
  writeAgentGrant,
} from "./identity";
import { sha256 } from "./hash";
import type { Grant, Principal } from "./types";
import { ulid } from "../util/ulid";
import { openLedger, LEDGER_SCHEMA_VERSION } from "../ledger/db";
import { tableExists } from "../ledger/schema";

const SCHEMA = "kizuki.agent-enrollment/v1" as const;
const ENVELOPE_SCHEMA = "kizuki.agent-credential/v1";
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/;
const GENERATION = /^[0-9a-f]{32}$/;
const TOKEN = /^kzk_[0-9A-HJKMNP-TV-Z]{52}$/;
const MAX_GRANT_BYTES = 32 * 1024;
const MAX_REF_BYTES = 4096;

export interface AgentEnrollmentRequest {
  operation_id: string;
  name: string;
  grant: Grant;
  token_ref: string;
}

export interface AgentEnrollmentResult {
  schema: typeof SCHEMA;
  operation_id: string | null;
  agent_id: string | null;
  name: string;
  status: "preview" | "completed" | "cancelled" | "pending";
  authority: "none" | "active" | "revoked" | "quarantined" | "unavailable";
  credential: "absent" | "ready" | "incomplete" | "conflict" | "stale";
  grant: Grant | null;
  grant_epoch: number | null;
  replayed: boolean;
}

export type AgentEnrollmentErrorCode =
  | "invalid_request" | "invalid_grant" | "vault_unavailable" | "unsupported_platform"
  | "credential_unsafe" | "credential_conflict" | "operation_conflict" | "name_conflict"
  | "migration_required" | "enrollment_busy" | "recovery_required" | "enrollment_unavailable";

export class AgentEnrollmentError extends Error {
  constructor(readonly code: AgentEnrollmentErrorCode) {
    super(code);
  }
}

interface EnrollmentRow {
  operation_id: string; request_digest: string; destination_digest: string; agent_id: string; name: string;
  grant_json: string; state: "reserved" | "file_bound" | "completed" | "cancelled";
  parent_dev: string; parent_ino: string; generation: string | null; token_hash: string | null;
  credential_digest: string | null; credential_size: number | null; file_dev: string | null; file_ino: string | null;
}

interface RequestShape { request: AgentEnrollmentRequest; parent: string; filename: string; destinationDigest: string; requestDigest: string; }
interface ReservedEnrollment { row: EnrollmentRow; inserted: boolean; }

function fail(code: AgentEnrollmentErrorCode): never { throw new AgentEnrollmentError(code); }
function digest(value: string): string { return sha256(value); }
function digestBytes(value: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function canonical(value: unknown): string { return JSON.stringify(value); }
function identitiesEqual(left: CredentialFileIdentity, dev: string | null, ino: string | null): boolean { return left.dev === dev && left.ino === ino; }

function normalizedGrant(value: unknown): Grant {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_grant");
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  const expected = ["ceiling", "rate_limit_per_minute", "relay_owner_corrections", "since", "subjects", "tools", "types", "until"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail("invalid_grant");
  if (Buffer.byteLength(canonical(input)) > MAX_GRANT_BYTES) fail("invalid_grant");
  try {
    const grant = validateAgentGrant(input as unknown as Grant);
    const sorted = (items: readonly string[] | null) => items === null ? null : [...new Set(items)].sort();
    return validateAgentGrant({ ...grant, types: sorted(grant.types), subjects: sorted(grant.subjects), tools: sorted(grant.tools) as Grant["tools"] });
  } catch { fail("invalid_grant"); }
}

function parseRequest(request: AgentEnrollmentRequest): RequestShape {
  if (request === null || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length !== 4 || Object.keys(request).some((key) => !["operation_id", "name", "grant", "token_ref"].includes(key)) || typeof request.operation_id !== "string" || typeof request.name !== "string" || !OPERATION_ID.test(request.operation_id) || !AGENT_NAME.test(request.name) || request.name === "owner") fail("invalid_request");
  if (typeof request.token_ref !== "string" || !request.token_ref.startsWith("file:")) fail("invalid_request");
  const raw = request.token_ref.slice(5);
  if (Buffer.byteLength(raw) > MAX_REF_BYTES || !isAbsolute(raw) || resolve(raw) !== raw || raw.split("/").length > 257) fail("invalid_request");
  const parent = dirname(raw), filename = basename(raw);
  if (filename === "." || filename === ".." || filename.length === 0) fail("invalid_request");
  const grant = normalizedGrant(request.grant);
  const normalized: AgentEnrollmentRequest = { operation_id: request.operation_id, name: request.name, grant, token_ref: `file:${raw}` };
  return { request: normalized, parent, filename, destinationDigest: digest(normalized.token_ref), requestDigest: digest(canonical({ schema: SCHEMA, ...normalized })) };
}

function vaultDatabase(vaultPath: string): string {
  const root = resolve(vaultPath), control = `${root}/.kizuki`, path = `${control}/kizuki.db`;
  try {
    const uid = process.getuid?.();
    let cursor = root;
    for (;;) {
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && !(stat.mode & 0o1000))) fail("vault_unavailable");
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    const controlStat = lstatSync(control), dbStat = lstatSync(path);
    if (!controlStat.isDirectory() || !dbStat.isFile() || controlStat.isSymbolicLink() || dbStat.isSymbolicLink() || dbStat.nlink !== 1) fail("vault_unavailable");
    if ((controlStat.mode & 0o077) !== 0 || (dbStat.mode & 0o077) !== 0) fail("vault_unavailable");
    if (uid !== undefined && (controlStat.uid !== uid || dbStat.uid !== uid)) fail("vault_unavailable");
    return path;
  } catch (error) { if (error instanceof AgentEnrollmentError) throw error; fail("vault_unavailable"); }
}
function assertDestinationOutsideExportedVault(vaultPath: string, absoluteDestination: string): void {
  const rel = relative(resolve(vaultPath), absoluteDestination);
  if (rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) && rel.split("/")[0] !== ".kizuki") fail("credential_unsafe");
}

function readRow(db: DatabaseType, operationId: string): EnrollmentRow | null {
  return db.query<EnrollmentRow, [string]>("SELECT * FROM agent_enrollments WHERE operation_id = ?").get(operationId);
}

function readByName(db: DatabaseType, name: string): EnrollmentRow | null {
  return db.query<EnrollmentRow, [string]>("SELECT * FROM agent_enrollments WHERE name = ? AND state != 'cancelled'").get(name);
}

function currentGrant(db: DatabaseType, agentId: string): { grant: Grant | null; epoch: number | null; authority: AgentEnrollmentResult["authority"] } {
  const agent = db.query<{ revoked_at: string | null; quarantined_at: string | null }, [string]>("SELECT revoked_at, quarantined_at FROM agents WHERE agent_id = ?").get(agentId);
  if (agent === null) return { grant: null, epoch: null, authority: "unavailable" };
  if (agent.revoked_at !== null) return { grant: null, epoch: null, authority: "revoked" };
  if (agent.quarantined_at !== null) return { grant: null, epoch: null, authority: "quarantined" };
  const principal = principalForAgentId(db, agentId);
  if (principal === null || principal.kind !== "agent") return { grant: null, epoch: null, authority: "quarantined" };
  return { authority: "active", epoch: principal.grant_epoch, grant: principal.grant };
}

function result(row: EnrollmentRow, db: DatabaseType, credential: AgentEnrollmentResult["credential"], replayed: boolean): AgentEnrollmentResult {
  if (row.state === "cancelled") return { schema: SCHEMA, operation_id: row.operation_id, agent_id: row.agent_id, name: row.name, status: "cancelled", authority: "none", credential, grant: null, grant_epoch: null, replayed };
  if (row.state !== "completed") return { schema: SCHEMA, operation_id: row.operation_id, agent_id: row.agent_id, name: row.name, status: "pending", authority: "none", credential, grant: null, grant_epoch: null, replayed };
  const current = currentGrant(db, row.agent_id);
  return { schema: SCHEMA, operation_id: row.operation_id, agent_id: row.agent_id, name: row.name, status: "completed", authority: current.authority, credential, grant: current.grant, grant_epoch: current.epoch, replayed };
}

function envelope(agentId: string, operationId: string, generation: string, token: string): Uint8Array {
  return Buffer.from(`${canonical({ schema: ENVELOPE_SCHEMA, agent_id: agentId, operation_id: operationId, generation, token })}\n`);
}

function parseEnvelope(bytes: Uint8Array): { agent_id: string; operation_id: string; generation: string; token: string } | null {
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (!text.endsWith("\n") || Buffer.from(text, "utf8").compare(Buffer.from(bytes)) !== 0) return null;
    const value = JSON.parse(text) as Record<string, unknown>;
    if (canonical(value) + "\n" !== text || Object.keys(value).sort().join(",") !== "agent_id,generation,operation_id,schema,token" || value.schema !== ENVELOPE_SCHEMA || typeof value.agent_id !== "string" || typeof value.operation_id !== "string" || typeof value.generation !== "string" || typeof value.token !== "string" || !GENERATION.test(value.generation) || !TOKEN.test(value.token)) return null;
    return value as { agent_id: string; operation_id: string; generation: string; token: string };
  } catch { return null; }
}

function credentialFor(row: EnrollmentRow, db: DatabaseType, parent: string, filename: string): AgentEnrollmentResult["credential"] {
  let directory;
  try { directory = openCredentialDirectory(parent); } catch { return "conflict"; }
  try {
    const handle = directory.inspect(filename);
    if (handle === null) return "absent";
    try {
      if (row.file_dev === null || row.file_ino === null || !identitiesEqual(handle.identity, row.file_dev, row.file_ino)) return "conflict";
      if (row.credential_digest === null || row.credential_size === null || handle.bytes.byteLength !== row.credential_size || digestBytes(handle.bytes) !== row.credential_digest) return "conflict";
      const parsed = parseEnvelope(handle.bytes);
      if (parsed === null || parsed.agent_id !== row.agent_id || parsed.operation_id !== row.operation_id || parsed.generation !== row.generation || hashAgentToken(parsed.token) !== row.token_hash) return "stale";
      const current = db.query<{ token_hash: string }, [string]>("SELECT token_hash FROM agents WHERE agent_id = ? AND revoked_at IS NULL AND quarantined_at IS NULL").get(row.agent_id);
      return current?.token_hash === hashAgentToken(parsed.token) ? "ready" : "stale";
    } finally { handle.close(); }
  } catch { return "conflict"; } finally { directory.close(); }
}

function reserve(db: DatabaseType, shape: RequestShape, parent: CredentialFileIdentity): ReservedEnrollment {
  return db.transaction(() => {
    const existing = readRow(db, shape.request.operation_id);
    if (existing !== null) {
      if (existing.request_digest !== shape.requestDigest || existing.destination_digest !== shape.destinationDigest || existing.parent_dev !== parent.dev || existing.parent_ino !== parent.ino) fail("operation_conflict");
      return { row: existing, inserted: false };
    }
    const agentId = ulid();
    if (readByName(db, shape.request.name) !== null || getAgent(db, shape.request.name) !== null || db.query<{ agent_id: string }, [string]>("SELECT agent_id FROM agents WHERE agent_id = ?").get(agentId) !== null) fail("name_conflict");
    const collision = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM agent_enrollments WHERE destination_digest = ? AND state != 'cancelled'").get(shape.destinationDigest);
    if ((collision?.n ?? 0) !== 0) fail("credential_conflict");
    const now = new Date().toISOString();
    db.query<never, [string, string, string, string, string, string, string, string, string, string]>(`INSERT INTO agent_enrollments (operation_id, request_digest, destination_digest, agent_id, name, grant_json, state, parent_dev, parent_ino, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?)`)
      .run(shape.request.operation_id, shape.requestDigest, shape.destinationDigest, agentId, shape.request.name, canonical(shape.request.grant), parent.dev, parent.ino, now, now);
    const row = readRow(db, shape.request.operation_id);
    if (row === null) fail("enrollment_unavailable");
    return { row, inserted: true };
  }).immediate();
}
function bind(db: DatabaseType, row: EnrollmentRow, parent: CredentialFileIdentity, identity: CredentialFileIdentity, bytes: Uint8Array, token: string, generation: string): EnrollmentRow {
  const work = () => {
    const current = readRow(db, row.operation_id);
    if (current === null || (current.state !== "reserved" && current.state !== "file_bound") || current.parent_dev !== parent.dev || current.parent_ino !== parent.ino) fail("operation_conflict");
    const conflict = db.query<{ n: number }, [string, string, string]>("SELECT count(*) AS n FROM agents WHERE name = ? OR agent_id = ? OR token_hash = ?").get(current.name, current.agent_id, hashAgentToken(token));
    if ((conflict?.n ?? 0) !== 0) fail("name_conflict");
    db.query<never, [string, string, string, number, string, string, string, string]>(`UPDATE agent_enrollments SET state = 'file_bound', generation = ?, token_hash = ?, credential_digest = ?, credential_size = ?, file_dev = ?, file_ino = ?, updated_at = ? WHERE operation_id = ? AND state IN ('reserved', 'file_bound')`)
      .run(generation, hashAgentToken(token), digestBytes(bytes), bytes.byteLength, identity.dev, identity.ino, new Date().toISOString(), row.operation_id);
    const bound = readRow(db, row.operation_id);
    if (bound === null) fail("enrollment_unavailable");
    return bound;
  };
  return db.inTransaction ? work() : db.transaction(work).immediate();
}

function createAndBind(db: DatabaseType, shape: RequestShape, parent: CredentialDirectory, row: EnrollmentRow): { bound: EnrollmentRow; held: CredentialFileInspection; bytes: Uint8Array } {
  let held: CredentialFileInspection | null = null;
  try {
    return db.transaction(() => {
      const current = readRow(db, row.operation_id);
      if (current === null || current.state !== "reserved" || current.parent_dev !== parent.identity.dev || current.parent_ino !== parent.identity.ino) fail("recovery_required");
      held = parent.create(shape.filename);
      const generation = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
      const token = generateAgentToken(), bytes = envelope(current.agent_id, current.operation_id, generation, token);
      const bound = bind(db, current, parent.identity, held.identity, bytes, token, generation);
      return { bound, held, bytes };
    }).exclusive();
  } catch (error) { (held as CredentialFileInspection | null)?.close(); throw error; }
}

function activate(db: DatabaseType, row: EnrollmentRow, directory: CredentialDirectory, held: CredentialFileInspection, bytes: Uint8Array): EnrollmentRow {
  return db.transaction(() => {
    const current = readRow(db, row.operation_id);
    if (current === null || current.state !== "file_bound" || current.generation !== row.generation || current.token_hash === null) fail("operation_conflict");
    const grant = normalizedGrant(JSON.parse(current.grant_json));
    directory.writeComplete(held, bytes);
    const now = new Date().toISOString();
    db.query<never, [string, string, string, string]>("INSERT INTO agents (agent_id, name, token_hash, created_at) VALUES (?, ?, ?, ?)").run(current.agent_id, current.name, current.token_hash, now);
    writeAgentGrant(db, current.agent_id, grant, now, 1);
    recordLifecycle(db, current.agent_id, "agent.create", { after: grant }, now);
    db.query<never, [string, string, string]>("UPDATE agent_enrollments SET state = 'completed', completed_at = ?, updated_at = ? WHERE operation_id = ? AND state = 'file_bound'").run(now, now, current.operation_id);
    const done = readRow(db, current.operation_id);
    if (done === null) fail("enrollment_unavailable");
    return done;
  }).immediate();
}

function cleanupAfterConfirmedActivationRollback(db: DatabaseType, directory: CredentialDirectory, held: CredentialFileInspection, row: EnrollmentRow): void {
  try {
    db.transaction(() => {
      const current = readRow(db, row.operation_id);
      if (current === null || current.state !== "file_bound" || current.generation !== row.generation || !identitiesEqual(held.identity, current.file_dev, current.file_ino)) return;
      directory.removeCreated(held);
    }).immediate();
  } catch {
    // A busy or changed row leaves the held artifact inert.  Never race an activation.
  }
}

function openForPreview(vaultPath: string): DatabaseType {
  const path = vaultDatabase(vaultPath);
  try { return new Database(path, { readonly: true }); } catch { fail("vault_unavailable"); }
}

export function previewAgentEnrollment(vaultPath: string, request: AgentEnrollmentRequest): AgentEnrollmentResult {
  const shape = parseRequest(request); const db = openForPreview(vaultPath);
  try {
    if (!tableExists(db, "schema_version") || !tableExists(db, "agent_enrollments") || (db.query<{ version: number }, []>("SELECT version FROM schema_version").get()?.version ?? 0) !== LEDGER_SCHEMA_VERSION) fail("migration_required");
    assertDestinationOutsideExportedVault(vaultPath, shape.request.token_ref.slice(5));
    let directory: CredentialDirectory;
    try { directory = openCredentialDirectory(shape.parent); } catch (error) { if (error instanceof Error && error.message.includes("unsupported")) fail("unsupported_platform"); fail("credential_unsafe"); }
    try {
      const existing = readRow(db, shape.request.operation_id);
      if (existing !== null && (existing.request_digest !== shape.requestDigest || existing.destination_digest !== shape.destinationDigest || existing.parent_dev !== directory.identity.dev || existing.parent_ino !== directory.identity.ino)) fail("operation_conflict");
      if (existing === null && (readByName(db, shape.request.name) !== null || getAgent(db, shape.request.name) !== null)) fail("name_conflict");
      const held = directory.inspect(shape.filename);
      if (held !== null) { held.close(); if (existing === null) fail("credential_conflict"); }
      return existing === null
        ? { schema: SCHEMA, operation_id: shape.request.operation_id, agent_id: null, name: shape.request.name, status: "preview", authority: "none", credential: "absent", grant: shape.request.grant, grant_epoch: null, replayed: false }
        : result(existing, db, credentialFor(existing, db, shape.parent, shape.filename), true);
    } finally { directory.close(); }
  } finally { db.close(); }
}

export function enrollAgent(vaultPath: string, request: AgentEnrollmentRequest): AgentEnrollmentResult {
  const shape = parseRequest(request); assertDestinationOutsideExportedVault(vaultPath, shape.request.token_ref.slice(5));
  const dbPath = vaultDatabase(vaultPath);
  let db: DatabaseType | undefined;
  let directory: CredentialDirectory | undefined;
  try {
    try { directory = openCredentialDirectory(shape.parent); } catch (error) { if (error instanceof Error && error.message.includes("unsupported")) fail("unsupported_platform"); fail("credential_unsafe"); }
    if (directory === undefined) fail("credential_unsafe");
    db = openLedger(dbPath);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
    const journal = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode;
    const synchronous = db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous;
    if (journal !== "wal" || synchronous === undefined || synchronous < 2) fail("enrollment_unavailable");
    const prior = readRow(db, shape.request.operation_id);
    const preexisting = directory.inspect(shape.filename);
    if (preexisting !== null) { preexisting.close(); if (prior === null) fail("credential_conflict"); }
    const reservation = reserve(db, shape, directory.identity); const row = reservation.row;
    if (row.state === "cancelled") return result(row, db, credentialFor(row, db, shape.parent, shape.filename), true);
    if (row.state === "completed") return result(row, db, credentialFor(row, db, shape.parent, shape.filename), true);
    let held: CredentialFileInspection | null;
    try { held = directory.inspect(shape.filename); } catch { fail("credential_unsafe"); }
    if (row.state === "reserved" || held === null) {
      held?.close();
      let created: { bound: EnrollmentRow; held: CredentialFileInspection; bytes: Uint8Array };
      try { created = createAndBind(db, shape, directory, row); }
      catch (error) {
        if (error instanceof Error && error.message.includes("conflict")) fail("credential_conflict");
        throw error;
      }
      held = created.held;
      let durable = false;
      try {
        const completed = activate(db, created.bound, directory, held, created.bytes);
        durable = true;
        return result(completed, db, "ready", !reservation.inserted);
      } catch (error) {
        if (durable) {
          // SQLite reports a COMMIT exception after the outcome may already be
          // durable. Re-read before any cleanup or retry classification.
          // A commit exception has no trustworthy connection-local outcome.
          // Reopen before the authoritative operation observation or cleanup.
          db.close(); db = openLedger(dbPath);
          const observed = readRow(db, created.bound.operation_id);
          if (observed?.state === "completed") return result(observed, db, "ready", true);
          cleanupAfterConfirmedActivationRollback(db, directory, held, created.bound);
        }
        throw error;
      } finally { held.close(); }
    }
    try {
      if (!identitiesEqual(held.identity, row.file_dev, row.file_ino)) fail("recovery_required");
      const expected = row.credential_digest === null ? "" : row.credential_digest;
      if (row.credential_size === null || held.bytes.byteLength !== row.credential_size || digestBytes(held.bytes) !== expected) fail("recovery_required");
      const decoded = parseEnvelope(held.bytes);
      if (decoded === null || decoded.agent_id !== row.agent_id || decoded.operation_id !== row.operation_id || decoded.generation !== row.generation || hashAgentToken(decoded.token) !== row.token_hash) fail("recovery_required");
      const completed = activate(db, row, directory, held, held.bytes);
      return result(completed, db, "ready", true);
    } finally { held.close(); }
  } catch (error) {
    if (error instanceof AgentEnrollmentError) throw error;
    if (error instanceof Error && /busy|locked/i.test(error.message)) fail("enrollment_busy");
    fail("enrollment_unavailable");
  } finally { directory?.close(); db?.close(); }
  throw new AgentEnrollmentError("enrollment_unavailable");
}

export function revokeAgentEnrollment(vaultPath: string, name: string): AgentEnrollmentResult {
  if (!AGENT_NAME.test(name) || name === "owner") fail("invalid_request");
  const db = openLedger(vaultDatabase(vaultPath));
  try {
    const row = db.transaction(() => {
      const currentAgent = getAgent(db, name);
      if (currentAgent !== null) {
        revokeAgentInTransaction(db, name);
        const completed = db.query<EnrollmentRow, [string]>("SELECT * FROM agent_enrollments WHERE agent_id = ? AND state = 'completed' ORDER BY completed_at DESC LIMIT 1").get(currentAgent.agent_id);
        return completed;
      }
      const found = db.query<EnrollmentRow, [string]>("SELECT * FROM agent_enrollments WHERE name = ? AND state IN ('reserved', 'file_bound') ORDER BY created_at DESC LIMIT 1").get(name);
      if (found === null) fail("name_conflict");
      const now = new Date().toISOString();
      db.query<never, [string, string, string]>("UPDATE agent_enrollments SET state = 'cancelled', cancelled_at = ?, updated_at = ? WHERE operation_id = ?").run(now, now, found.operation_id);
      return readRow(db, found.operation_id);
    }).immediate();
    if (row === null) return { schema: SCHEMA, operation_id: null, agent_id: getAgent(db, name)?.agent_id ?? null, name, status: "cancelled", authority: "none", credential: "absent", grant: null, grant_epoch: null, replayed: true };
    return result(row, db, "incomplete", true);
  } finally { db.close(); }
}

export function authenticateAgentCredential(db: DatabaseType, tokenRef: string): Principal | null {
  try {
    if (typeof tokenRef !== "string" || !tokenRef.startsWith("file:")) return null;
    const raw = tokenRef.slice(5); if (!isAbsolute(raw) || resolve(raw) !== raw) return null;
    const directory = openCredentialDirectory(dirname(raw));
    try {
      const handle = directory.inspect(basename(raw)); if (handle === null) return null;
      try {
        const decoded = parseEnvelope(handle.bytes); if (decoded === null) return null;
        const row = readRow(db, decoded.operation_id);
        if (row === null || row.state !== "completed" || row.destination_digest !== digest(`file:${raw}`) || row.agent_id !== decoded.agent_id || row.generation !== decoded.generation || row.token_hash !== hashAgentToken(decoded.token) || row.credential_digest !== digestBytes(handle.bytes) || row.credential_size !== handle.bytes.byteLength || !identitiesEqual(directory.identity, row.parent_dev, row.parent_ino) || !identitiesEqual(handle.identity, row.file_dev, row.file_ino)) return null;
        return authenticate(db, decoded.token);
      } finally { handle.close(); }
    } finally { directory.close(); }
  } catch { return null; }
}
