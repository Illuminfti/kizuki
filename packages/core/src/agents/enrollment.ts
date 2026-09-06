import { Database, constants } from "bun:sqlite";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { recordLifecycle } from "./audit";
import { openCredentialDirectory, type CredentialDirectory, type CredentialFileIdentity, type CredentialFileInspection } from "./credential-file";
import { AGENT_NAME, authenticate, generateAgentToken, getAgent, hashAgentToken, principalForAgentId, revokeAgentInTransaction, validateAgentGrant, writeAgentGrant } from "./identity";
import { sha256 } from "./hash";
import { TOOLS, type Grant, type Principal } from "./types";
import { ulid } from "../util/ulid";
import { LEDGER_SCHEMA_VERSION, openLedger } from "../ledger/db";
import { tableExists } from "../ledger/schema";

const SCHEMA = "kizuki.agent-enrollment/v1" as const;
const ENVELOPE_SCHEMA = "kizuki.agent-credential/v1";
const OPERATION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,63}$/;
const AGENT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const GENERATION = /^[0-9a-f]{32}$/;
const TOKEN = /^kzk_[0-9A-HJKMNP-TV-Z]{52}$/;
const MAX_GRANT_BYTES = 32 * 1024;
const SIDECARS = ["kizuki.db-wal", "kizuki.db-shm", "kizuki.db-journal"] as const;
const SQLITE_FILENAMES: ReadonlySet<string> = new Set(["kizuki.db", ...SIDECARS]);

export interface AgentEnrollmentRequest {
  operation_id: string;
  name: string;
  grant: Grant;
  token_ref: string;
}
export interface AgentEnrollmentResult {
  schema: typeof SCHEMA;
  /** Null only for revocation of an identity created by the legacy API. */
  operation_id: string | null;
  agent_id: string | null;
  name: string;
  status: "preview" | "completed" | "cancelled" | "pending";
  authority: "none" | "active" | "revoked" | "quarantined" | "unavailable";
  /** Name-only revocation cannot observe the credential path and returns unknown. */
  credential: "absent" | "ready" | "incomplete" | "conflict" | "stale" | "unknown";
  grant: Grant | null;
  grant_epoch: number | null;
  replayed: boolean;
}
export type AgentEnrollmentErrorCode =
  | "invalid_request" | "invalid_grant" | "vault_unavailable" | "unsupported_platform"
  | "credential_unsafe" | "credential_conflict" | "operation_conflict" | "name_conflict"
  | "migration_required" | "enrollment_busy" | "recovery_required" | "enrollment_unavailable";
export class AgentEnrollmentError extends Error {
  constructor(readonly code: AgentEnrollmentErrorCode) { super(code); }
}
interface EnrollmentRow {
  operation_id: string; request_digest: string; destination_digest: string; agent_id: string; name: string;
  grant_json: string; state: "reserved" | "file_bound" | "completed" | "cancelled";
  parent_dev: string; parent_ino: string; generation: string | null; token_hash: string | null;
  credential_digest: string | null; credential_size: number | null; file_dev: string | null; file_ino: string | null;
}
interface RequestShape { request: AgentEnrollmentRequest; parent: string; filename: string; destinationDigest: string; requestDigest: string; }
interface Delivery { row: EnrollmentRow; held: CredentialFileInspection; bytes: Uint8Array; }
type CredentialState = AgentEnrollmentResult["credential"];

function fail(code: AgentEnrollmentErrorCode): never { throw new AgentEnrollmentError(code); }
function safeError(error: unknown): never {
  if (error instanceof AgentEnrollmentError) throw error;
  if (error instanceof Error && /SQLITE_(BUSY|LOCKED)|database is (busy|locked)/i.test(error.message)) fail("enrollment_busy");
  fail("enrollment_unavailable");
}
function digestBytes(value: Uint8Array): string { return new Bun.CryptoHasher("sha256").update(value).digest("hex"); }
function sameIdentity(left: CredentialFileIdentity, right: CredentialFileIdentity): boolean { return left.dev === right.dev && left.ino === right.ino; }
function boundIdentity(left: CredentialFileIdentity, dev: string | null, ino: string | null): boolean { return left.dev === dev && left.ino === ino; }
function readOne<T>(db: Database, sql: string, ...bindings: (string | number | null)[]): T | null {
  // Bun's query cache does not own statements beyond its capacity. Explicit
  // statement lifetime is required before a close/reopen can release SQLite.
  using statement = db.prepare<T, (string | number | null)[]>(sql);
  return statement.get(...bindings);
}
function absolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && Buffer.byteLength(value) <= 4096 &&
    Buffer.from(value).toString() === value && !value.includes("\0") && isAbsolute(value) && resolve(value) === value && value.split("/").length <= 257;
}
function normalizedGrant(value: unknown): Grant {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) fail("invalid_grant");
    const input = value as Record<string, unknown>, keys = Object.keys(input).sort();
    const expected = ["ceiling", "rate_limit_per_minute", "relay_owner_corrections", "since", "subjects", "tools", "types", "until"];
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]) ||
      !Array.isArray(input.tools) || input.tools.length > TOOLS.length) fail("invalid_grant");
    // Validate bounded lists and strings before any serialization or copying.
    const grant = validateAgentGrant(input as unknown as Grant);
    const sorted = (items: readonly string[] | null) => items === null ? null : [...new Set(items)].sort();
    const normalized = { ...grant, types: sorted(grant.types), subjects: sorted(grant.subjects), tools: sorted(grant.tools) as Grant["tools"] };
    if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_GRANT_BYTES) fail("invalid_grant");
    return normalized;
  } catch { fail("invalid_grant"); }
}
function parseRequest(request: AgentEnrollmentRequest): RequestShape {
  try {
    if (request === null || typeof request !== "object" || Array.isArray(request) || Object.keys(request).length !== 4 ||
      Object.keys(request).some(key => !["operation_id", "name", "grant", "token_ref"].includes(key)) ||
      typeof request.operation_id !== "string" || !OPERATION_ID.test(request.operation_id) ||
      typeof request.name !== "string" || !AGENT_NAME.test(request.name) || request.name === "owner" ||
      typeof request.token_ref !== "string" || !request.token_ref.startsWith("file:")) fail("invalid_request");
    const raw = request.token_ref.slice(5);
    if (!absolutePath(raw) || basename(raw) === "/") fail("invalid_request");
    const normalized = { ...request, grant: normalizedGrant(request.grant) };
    return { request: normalized, parent: dirname(raw), filename: basename(raw), destinationDigest: sha256(normalized.token_ref),
      requestDigest: sha256(JSON.stringify({ schema: SCHEMA, operation_id: normalized.operation_id, name: normalized.name, grant: normalized.grant, token_ref: normalized.token_ref })) };
  } catch (error) { if (error instanceof AgentEnrollmentError) throw error; fail("invalid_request"); }
}
function credentialDirectory(path: string): CredentialDirectory {
  try { return openCredentialDirectory(path); }
  catch (error) {
    if (error instanceof Error && error.message === "credential_file_unsupported") fail("unsupported_platform");
    fail("credential_unsafe");
  }
}
function assertCredentialDestination(vaultPath: string, destination: string): void {
  if (typeof vaultPath !== "string" || vaultPath.length > 4096) fail("vault_unavailable");
  if (SQLITE_FILENAMES.has(basename(destination))) fail("credential_unsafe");
  const root = resolve(vaultPath), rel = relative(root, destination);
  const outside = rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  if (!outside && dirname(destination) !== `${root}/.kizuki/agent-credentials`) fail("credential_unsafe");
}

/** Hold one qualified control directory and the original ledger identity. */
function ledgerCustody(vaultPath: string) {
  if (typeof vaultPath !== "string" || vaultPath.length > 4096) fail("vault_unavailable");
  const root = resolve(vaultPath);
  if (!absolutePath(root)) fail("vault_unavailable");
  let directory: CredentialDirectory;
  try { directory = openCredentialDirectory(`${root}/.kizuki`); }
  catch (error) {
    if (error instanceof Error && error.message === "credential_file_unsupported") fail("unsupported_platform");
    fail("vault_unavailable");
  }
  try {
    const original = directory.inspectFileIdentity("kizuki.db");
    if (original === null) fail("vault_unavailable");
    const check = () => {
      try {
        const current = directory.inspectFileIdentity("kizuki.db");
        if (current === null || !sameIdentity(original, current)) fail("vault_unavailable");
        for (const sidecar of SIDECARS) directory.inspectFileIdentity(sidecar);
      } catch { fail("vault_unavailable"); }
    };
    check();
    return { path: `${root}/.kizuki/kizuki.db`, directory, check, close: () => directory.close() };
  } catch (error) { directory.close(); if (error instanceof AgentEnrollmentError) throw error; fail("vault_unavailable"); }
}

/** One mutable connection; every uncertain transaction outcome replaces it. */
class EnrollmentLedger {
  readonly custody: ReturnType<typeof ledgerCustody>;
  #db: Database | undefined;
  constructor(vaultPath: string) {
    this.custody = ledgerCustody(vaultPath);
    try { this.reopen(); } catch (error) { this.custody.close(); throw error; }
  }
  get db(): Database { if (this.#db === undefined) fail("enrollment_unavailable"); return this.#db; }
  reopen(): void {
    try { this.#db?.close(true); } catch { fail("enrollment_unavailable"); }
    this.#db = undefined;
    this.custody.check();
    const db = openLedger(this.custody.path, { busyTimeoutMs: 5000 });
    try {
      this.custody.check();
      db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
      const journal = readOne<{ journal_mode: string }>(db, "PRAGMA journal_mode")?.journal_mode;
      const synchronous = readOne<{ synchronous: number }>(db, "PRAGMA synchronous")?.synchronous;
      if (journal !== "wal" || synchronous === undefined || synchronous < 2) fail("enrollment_unavailable");
      this.#db = db;
    } catch (error) { db.close(true); throw error; }
  }
  write<T>(work: (db: Database) => T): T {
    if (this.db.inTransaction) fail("enrollment_unavailable");
    return this.db.transaction(() => {
      this.custody.check();
      const output = work(this.db);
      this.custody.check();
      return output;
    }).immediate();
  }
  close(): void {
    const previous = this.#db; this.#db = undefined;
    try { previous?.close(true); } catch { fail("enrollment_unavailable"); } finally { this.custody.close(); }
  }
}
function readRow(db: Database, operationId: string): EnrollmentRow | null {
  return readOne<EnrollmentRow>(db, "SELECT * FROM agent_enrollments WHERE operation_id = ?", operationId);
}
function assertRequest(row: EnrollmentRow, shape: RequestShape, parent: CredentialFileIdentity): void {
  if (row.request_digest !== shape.requestDigest || row.destination_digest !== shape.destinationDigest || row.name !== shape.request.name ||
    row.parent_dev !== parent.dev || row.parent_ino !== parent.ino) fail("operation_conflict");
}
function currentGrant(db: Database, agentId: string) {
  const agent = readOne<{ revoked_at: string | null; quarantined_at: string | null; grant_epoch: number | null }>(db,
    "SELECT a.revoked_at, a.quarantined_at, g.grant_epoch FROM agents a LEFT JOIN agent_grants g ON g.agent_id=a.agent_id WHERE a.agent_id=?", agentId);
  const epoch = agent !== null && Number.isSafeInteger(agent.grant_epoch) ? agent.grant_epoch : null;
  const absent = (authority: AgentEnrollmentResult["authority"]) => ({ authority, epoch, grant: null });
  if (agent === null) return absent("unavailable");
  if (agent.revoked_at !== null) return absent("revoked");
  if (agent.quarantined_at !== null) return absent("quarantined");
  const principal = principalForAgentId(db, agentId);
  if (principal === null || principal.kind !== "agent") return absent("unavailable");
  return { authority: "active" as const, epoch: principal.grant_epoch, grant: principal.grant };
}
function result(row: EnrollmentRow, db: Database, credential: CredentialState, replayed: boolean): AgentEnrollmentResult {
  const common = { schema: SCHEMA, operation_id: row.operation_id, agent_id: row.agent_id, name: row.name, credential, replayed };
  if (row.state !== "completed") return { ...common, status: row.state === "cancelled" ? "cancelled" : "pending", authority: "none", grant: null, grant_epoch: null };
  const current = currentGrant(db, row.agent_id);
  return { ...common, status: "completed", authority: current.authority, grant: current.grant, grant_epoch: current.epoch };
}
function envelope(agentId: string, operationId: string, generation: string, token: string): Uint8Array {
  return Buffer.from(`${JSON.stringify({ schema: ENVELOPE_SCHEMA, agent_id: agentId, operation_id: operationId, generation, token })}\n`);
}
function parseEnvelope(bytes: Uint8Array): { agent_id: string; operation_id: string; generation: string; token: string } | null {
  try {
    if (bytes.byteLength > 1024) return null;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), value = JSON.parse(text) as Record<string, unknown>;
    if (JSON.stringify(value) + "\n" !== text || Object.keys(value).sort().join(",") !== "agent_id,generation,operation_id,schema,token" ||
      value.schema !== ENVELOPE_SCHEMA || typeof value.agent_id !== "string" || !AGENT_ID.test(value.agent_id) ||
      typeof value.operation_id !== "string" || !OPERATION_ID.test(value.operation_id) || typeof value.generation !== "string" ||
      !GENERATION.test(value.generation) || typeof value.token !== "string" || !TOKEN.test(value.token)) return null;
    return value as { agent_id: string; operation_id: string; generation: string; token: string };
  } catch { return null; }
}
function exactDelivery(row: EnrollmentRow, directory: CredentialDirectory, held: CredentialFileInspection, bytes: Uint8Array): boolean {
  const parsed = parseEnvelope(bytes);
  return parsed !== null && boundIdentity(directory.identity, row.parent_dev, row.parent_ino) &&
    boundIdentity(held.identity, row.file_dev, row.file_ino) && row.credential_size === bytes.byteLength && row.credential_digest === digestBytes(bytes) &&
    parsed.agent_id === row.agent_id && parsed.operation_id === row.operation_id && parsed.generation === row.generation && hashAgentToken(parsed.token) === row.token_hash;
}
function credentialFor(row: EnrollmentRow, db: Database, directory: CredentialDirectory, filename: string): CredentialState {
  try {
    const held = directory.inspect(filename);
    if (held === null) return "absent";
    try {
      if (row.file_dev === null || !boundIdentity(held.identity, row.file_dev, row.file_ino)) return "conflict";
      if (!exactDelivery(row, directory, held, held.bytes)) return row.state === "completed" ? "conflict" : "incomplete";
      if (row.state !== "completed") return row.state === "cancelled" ? "stale" : "incomplete";
      // Result inspection is pure, including immutable preview. Authentication
      // may persist quarantine and therefore belongs only at the auth seam.
      const principal = principalForAgentId(db, row.agent_id);
      const current = readOne<{ token_hash: string }>(db, "SELECT token_hash FROM agents WHERE agent_id=?", row.agent_id);
      return principal?.kind === "agent" && principal.agent.agent_id === row.agent_id && current?.token_hash === row.token_hash ? "ready" : "stale";
    } finally { held.close(); }
  } catch { return "conflict"; }
}
function checkNewRequest(db: Database, shape: RequestShape, directory: CredentialDirectory): void {
  if (readOne(db, "SELECT 1 FROM agent_enrollments WHERE name=? AND state!='cancelled'", shape.request.name) !== null || getAgent(db, shape.request.name) !== null) fail("name_conflict");
  if (readOne(db, "SELECT 1 FROM agent_enrollments WHERE destination_digest=? AND state!='cancelled'", shape.destinationDigest) !== null) fail("credential_conflict");
  let held: CredentialFileInspection | null;
  try { held = directory.inspect(shape.filename); } catch { fail("credential_conflict"); }
  if (held !== null) { held.close(); fail("credential_conflict"); }
}
function reserve(ledger: EnrollmentLedger, shape: RequestShape, directory: CredentialDirectory): { row: EnrollmentRow; replayed: boolean } {
  return ledger.write(db => {
    const existing = readRow(db, shape.request.operation_id);
    if (existing !== null) { assertRequest(existing, shape, directory.identity); return { row: existing, replayed: true }; }
    checkNewRequest(db, shape, directory);
    const agentId = ulid();
    if (readOne(db, "SELECT 1 FROM agents WHERE agent_id=?", agentId) !== null) fail("name_conflict");
    const at = new Date().toISOString();
    db.run(`INSERT INTO agent_enrollments (operation_id,request_digest,destination_digest,agent_id,name,grant_json,state,parent_dev,parent_ino,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'reserved',?,?,?,?)`, [shape.request.operation_id, shape.requestDigest, shape.destinationDigest, agentId, shape.request.name,
        JSON.stringify(shape.request.grant), directory.identity.dev, directory.identity.ino, at, at]);
    return { row: readRow(db, shape.request.operation_id)!, replayed: false };
  });
}
function bind(ledger: EnrollmentLedger, shape: RequestShape, directory: CredentialDirectory, row: EnrollmentRow, hold: (delivery: Delivery) => void): Delivery {
  return ledger.write(db => {
    const current = readRow(db, row.operation_id);
    if (current === null || !["reserved", "file_bound"].includes(current.state) || current.generation !== row.generation) fail("operation_conflict");
    assertRequest(current, shape, directory.identity);
    const existing = directory.inspect(shape.filename);
    if (existing !== null) { existing.close(); fail("recovery_required"); }
    const held = directory.create(shape.filename);
    // Retain the live creation even if an SQL statement or COMMIT throws.
    const delivery: Delivery = { row: current, held, bytes: new Uint8Array() }; hold(delivery);
    const token = generateAgentToken(), generation = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("hex");
    const bytes = envelope(current.agent_id, current.operation_id, generation, token);
    if (readOne(db, "SELECT 1 FROM agents WHERE name=? OR agent_id=? OR token_hash=?", current.name, current.agent_id, hashAgentToken(token)) !== null) fail("name_conflict");
    db.run(`UPDATE agent_enrollments SET state='file_bound',generation=?,token_hash=?,credential_digest=?,credential_size=?,file_dev=?,file_ino=?,updated_at=? WHERE operation_id=?`,
      [generation, hashAgentToken(token), digestBytes(bytes), bytes.byteLength, held.identity.dev, held.identity.ino, new Date().toISOString(), current.operation_id]);
    delivery.row = readRow(db, current.operation_id)!; delivery.bytes = bytes;
    return delivery;
  });
}
function activate(ledger: EnrollmentLedger, directory: CredentialDirectory, delivery: Delivery, publish: boolean): EnrollmentRow {
  return ledger.write(db => {
    const current = readRow(db, delivery.row.operation_id);
    if (current === null || current.state !== "file_bound" || current.generation !== delivery.row.generation || !exactDelivery(current, directory, delivery.held, delivery.bytes)) fail("operation_conflict");
    if (current.grant_json.length > MAX_GRANT_BYTES) fail("invalid_grant");
    const grant = normalizedGrant(JSON.parse(current.grant_json));
    if (publish) directory.writeComplete(delivery.held, delivery.bytes);
    else directory.syncAndVerify(delivery.held, delivery.bytes);
    const at = new Date().toISOString();
    db.run("INSERT INTO agents (agent_id,name,token_hash,created_at) VALUES (?,?,?,?)", [current.agent_id, current.name, current.token_hash, at]);
    writeAgentGrant(db, current.agent_id, grant, at, 1);
    recordLifecycle(db, current.agent_id, "agent.create", { after: grant }, at);
    db.run("UPDATE agent_enrollments SET state='completed',completed_at=?,updated_at=? WHERE operation_id=?", [at, at, current.operation_id]);
    return readRow(db, current.operation_id)!;
  });
}
function cleanupConfirmedRollback(ledger: EnrollmentLedger, directory: CredentialDirectory, filename: string, delivery: Delivery): void {
  try {
    ledger.write(db => {
      const current = readRow(db, delivery.row.operation_id);
      if (current === null || current.state !== "file_bound" || current.generation !== delivery.row.generation ||
        current.parent_dev !== directory.identity.dev || current.parent_ino !== directory.identity.ino ||
        !boundIdentity(delivery.held.identity, current.file_dev, current.file_ino)) return;
      // A live creation FD is necessary but not sufficient: preserve changed or
      // partial bytes. Only the exact complete envelope can be cleaned here.
      const observed = directory.inspect(filename);
      if (observed === null) return;
      try { if (!exactDelivery(current, directory, observed, observed.bytes)) return; }
      finally { observed.close(); }
      directory.removeCreated(delivery.held, delivery.bytes);
    });
  } catch { /* Uncertain lock, custody or bytes: retain the artifact. */ }
}
export function previewAgentEnrollment(vaultPath: string, request: AgentEnrollmentRequest): AgentEnrollmentResult {
  const shape = parseRequest(request); assertCredentialDestination(vaultPath, shape.request.token_ref.slice(5));
  const directory = credentialDirectory(shape.parent);
  let custody: ReturnType<typeof ledgerCustody> | undefined, db: Database | undefined;
  try {
    custody = ledgerCustody(vaultPath);
    const snapshot = () => {
      custody!.check();
      const observation = JSON.stringify({ parent: custody!.directory.observe(), database: custody!.directory.inspectFileIdentity("kizuki.db") });
      for (const sidecar of SIDECARS) if (custody!.directory.inspectFileIdentity(sidecar) !== null) fail("enrollment_busy");
      return observation;
    };
    const before = snapshot();
    // Normal SQLite readonly opens can create WAL/SHM. This no-sidecar preview
    // uses an optimistic immutable read, releasing a result only if the entire
    // main/parent observation is unchanged and no journal appeared. Never read
    // a main-only view while committed WAL frames exist.
    db = new Database(`${pathToFileURL(custody.path).href}?immutable=1&mode=ro`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI | constants.SQLITE_OPEN_NOFOLLOW);
    let output: AgentEnrollmentResult | undefined, error: unknown;
    try {
      if (!tableExists(db, "schema_version")) fail("vault_unavailable");
      using versionQuery = db.prepare<{ version: number }, []>("SELECT version FROM schema_version LIMIT 2");
      const versions = versionQuery.all();
      if (versions.length !== 1 || !Number.isSafeInteger(versions[0]!.version) || versions[0]!.version > LEDGER_SCHEMA_VERSION) fail("vault_unavailable");
      if (versions[0]!.version < LEDGER_SCHEMA_VERSION || !tableExists(db, "agent_enrollments")) fail("migration_required");
      const existing = readRow(db, shape.request.operation_id);
      if (existing === null) {
        checkNewRequest(db, shape, directory);
        output = { schema: SCHEMA, operation_id: shape.request.operation_id, agent_id: null, name: shape.request.name, status: "preview", authority: "none",
          credential: "absent", grant: shape.request.grant, grant_epoch: null, replayed: false };
      } else {
        assertRequest(existing, shape, directory.identity);
        output = result(existing, db, credentialFor(existing, db, directory, shape.filename), true);
      }
    } catch (caught) { error = caught; }
    db.close(true); db = undefined;
    if (snapshot() !== before) fail("enrollment_busy");
    if (error !== undefined) throw error;
    if (output === undefined) fail("enrollment_unavailable");
    return output;
  } catch (error) { return safeError(error); }
  finally { try { db?.close(true); } finally { custody?.close(); directory.close(); } }
}

export function enrollAgent(vaultPath: string, request: AgentEnrollmentRequest): AgentEnrollmentResult {
  const shape = parseRequest(request); assertCredentialDestination(vaultPath, shape.request.token_ref.slice(5));
  const directory = credentialDirectory(shape.parent);
  let ledger: EnrollmentLedger | undefined, created: Delivery | undefined, held: CredentialFileInspection | undefined;
  try {
    ledger = new EnrollmentLedger(vaultPath);
    let reservation: { row: EnrollmentRow; replayed: boolean };
    try { reservation = reserve(ledger, shape, directory); }
    catch (error) {
      ledger.reopen(); const observed = readRow(ledger.db, shape.request.operation_id);
      if (observed === null) throw error;
      assertRequest(observed, shape, directory.identity); reservation = { row: observed, replayed: true };
    }
    const { row, replayed } = reservation;
    if (row.state === "completed" || row.state === "cancelled") return result(row, ledger.db, credentialFor(row, ledger.db, directory, shape.filename), true);
    try { held = directory.inspect(shape.filename) ?? undefined; }
    catch { return result(row, ledger.db, "conflict", replayed); }
    if (held !== undefined && (row.state === "reserved" || !exactDelivery(row, directory, held, held.bytes))) {
      return result(row, ledger.db, row.state === "reserved" ? "conflict" : "incomplete", replayed);
    }
    let delivery: Delivery, publish = false;
    if (held === undefined) {
      try { delivery = bind(ledger, shape, directory, row, next => { created = next; held = next.held; }); }
      catch (error) {
        ledger.reopen(); const observed = readRow(ledger.db, shape.request.operation_id);
        if (created !== undefined && observed?.state === "file_bound" && exactDelivery(observed, directory, created.held, created.bytes)) delivery = { ...created, row: observed };
        else if (observed !== null) return result(observed, ledger.db, credentialFor(observed, ledger.db, directory, shape.filename), true);
        else throw error;
      }
      publish = true;
    } else delivery = { row, held, bytes: held.bytes };
    try {
      const completed = activate(ledger, directory, delivery, publish);
      return result(completed, ledger.db, credentialFor(completed, ledger.db, directory, shape.filename), replayed);
    } catch (error) {
      ledger.reopen();
      const observed = readRow(ledger.db, shape.request.operation_id);
      if (observed === null) throw error;
      assertRequest(observed, shape, directory.identity);
      if (observed.state === "completed" || observed.state === "cancelled") return result(observed, ledger.db, credentialFor(observed, ledger.db, directory, shape.filename), true);
      if (created !== undefined) cleanupConfirmedRollback(ledger, directory, shape.filename, created);
      const afterCleanup = readRow(ledger.db, shape.request.operation_id);
      if (afterCleanup === null) fail("enrollment_unavailable");
      return result(afterCleanup, ledger.db, credentialFor(afterCleanup, ledger.db, directory, shape.filename), true);
    }
  } catch (error) { return safeError(error); }
  finally { try { held?.close(); } finally { ledger?.close(); directory.close(); } }
}

export function revokeAgentEnrollment(vaultPath: string, name: string): AgentEnrollmentResult {
  if (typeof name !== "string" || !AGENT_NAME.test(name) || name === "owner") fail("invalid_request");
  let ledger: EnrollmentLedger | undefined;
  let target: { agentId: string; operationId: string | null } | undefined;
  function revokedResult(db: Database, agentId: string, replayed: boolean): AgentEnrollmentResult {
    const row = readOne<EnrollmentRow>(db, "SELECT * FROM agent_enrollments WHERE agent_id=? AND state='completed'", agentId);
    if (row !== null) return result(row, db, "unknown", replayed);
    const current = currentGrant(db, agentId);
    return { schema: SCHEMA, operation_id: null, agent_id: agentId, name, status: "completed", authority: current.authority,
      credential: "unknown", grant: current.grant, grant_epoch: current.epoch, replayed };
  }
  try {
    ledger = new EnrollmentLedger(vaultPath);
    try {
      return ledger.write(db => {
        const agent = getAgent(db, name);
        if (agent !== null) {
          target = { agentId: agent.agent_id, operationId: null };
          const replayed = agent.revoked_at !== null;
          revokeAgentInTransaction(db, name);
          return revokedResult(db, agent.agent_id, replayed);
        }
        const row = readOne<EnrollmentRow>(db, "SELECT * FROM agent_enrollments WHERE name=? ORDER BY (state='cancelled'),created_at DESC,operation_id DESC LIMIT 1", name);
        if (row === null || row.state === "completed") fail("name_conflict");
        target = { agentId: row.agent_id, operationId: row.operation_id };
        const replayed = row.state === "cancelled";
        if (!replayed) {
          const at = new Date().toISOString();
          db.run("UPDATE agent_enrollments SET state='cancelled',cancelled_at=?,updated_at=? WHERE operation_id=?", [at, at, row.operation_id]);
        }
        return result(readRow(db, row.operation_id)!, db, "unknown", replayed);
      });
    } catch (error) {
      ledger.reopen();
      // Reconcile the exact identity selected before the failed response. A
      // cancelled name may already belong to an unrelated new legacy agent.
      if (target?.operationId != null) {
        const cancelled = readRow(ledger.db, target.operationId);
        if (cancelled?.state === "cancelled" && cancelled.agent_id === target.agentId) return result(cancelled, ledger.db, "unknown", true);
      } else if (target !== undefined) {
        const state = currentGrant(ledger.db, target.agentId);
        if (state.authority === "revoked") return revokedResult(ledger.db, target.agentId, true);
      }
      throw error;
    }
  } catch (error) { return safeError(error); }
  finally { ledger?.close(); }
}
export function authenticateAgentCredential(db: Database, tokenRef: string): Principal | null {
  try {
    if (typeof tokenRef !== "string" || !tokenRef.startsWith("file:") || !absolutePath(tokenRef.slice(5))) return null;
    const raw = tokenRef.slice(5);
    if (SQLITE_FILENAMES.has(basename(raw))) return null;
    const directory = openCredentialDirectory(dirname(raw));
    try {
      const held = directory.inspect(basename(raw)); if (held === null) return null;
      try {
        const decoded = parseEnvelope(held.bytes); if (decoded === null) return null;
        const row = readRow(db, decoded.operation_id);
        if (row === null || row.state !== "completed" || row.destination_digest !== sha256(tokenRef) || !exactDelivery(row, directory, held, held.bytes)) return null;
        const principal = authenticate(db, decoded.token);
        return principal?.kind === "agent" && principal.agent.agent_id === row.agent_id ? principal : null;
      } finally { held.close(); }
    } finally { directory.close(); }
  } catch { return null; }
}
