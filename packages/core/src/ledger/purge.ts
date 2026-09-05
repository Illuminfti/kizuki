import { tryWriteFlock } from "../serve/flock";
import { settleWriteReservations } from "../serve/budget-ledger";
import { purgeExtractInputs } from "../serve/extract";
import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyPurgeRewrite } from "../canon/apply";
import type { CanonIo } from "../canon";
import { CanonWriteError } from "../canon/errors";
import { getClaim, listClaims, markClaimsAfterPurge } from "../claims/store";
import { PortError } from "../contracts/ports";
import type { Claim } from "../contracts/proposal";
import type { AbsenceProof, RetrievalPort } from "../contracts/retrieval";
import {
  FTS5_RETRIEVAL_ID,
  FTS5_RETRIEVAL_STORE_REL,
  createFts5RetrievalPort,
} from "../retrieval";
import { removeDoc } from "../search/indexer";
import { withdrawForTombstone } from "../staging/producers";
import { sha256Hex } from "../util/hash";
import { ulid } from "../util/ulid";
import { parseFrontmatter } from "../vault/frontmatter";
import { listCanonPagesReport } from "../vault/pages";
import type { CanonPage } from "../vault/pages";
import { initPurgeOps, PURGE_SLA_SECONDS } from "./purge-schema";
import { tableExists } from "./schema";

export { PURGE_SLA_SECONDS, PURGE_SCHEMA_VERSION, applyPurgeV5 } from "./purge-schema";

export const PURGE_REASON_MAX_BYTES = 240;
export const PURGE_PREVIEW_ID_LIMIT = 32;
export const PURGE_CONNECTOR_ID_MAX = 128;

export const PURGE_ERROR_CODES = [
  "empty_filter",
  "invalid_reason",
  "invalid_filter",
  "no_match",
  "delete_mismatch",
  "absence_failed",
  "canon_changed",
] as const;
export type PurgeErrorCode = (typeof PURGE_ERROR_CODES)[number];

const CONTROL_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/** Test-only seam for the snapshot/lock window. Not a product option. */
let afterCanonSnapshot: (() => void) | undefined;

export function setAfterCanonSnapshot(hook?: () => void): void {
  afterCanonSnapshot = hook;
}

export class PurgeError extends Error {
  readonly code: PurgeErrorCode;
  readonly filter: PurgeFilter | undefined;

  constructor(code: PurgeErrorCode, message: string, filter?: PurgeFilter) {
    super(message);
    this.name = "PurgeError";
    this.code = code;
    this.filter = filter;
  }
}

export interface PurgeReceipt {
  receipt_id: string;
  event_id: string;
  connector_id: string;
  reason: string;
  purged_at: string;
}

export interface CanonHold {
  page_path: string;
  proposal_id: string;
  reason: string;
  held_at: string;
}

export interface PurgeOp {
  op_id: string;
  receipt_id: string;
  store: string;
  ids: string[];
  state: "pending" | "done";
  proof: AbsenceProof | null;
  created_at: string;
  done_at: string | null;
}

export interface PurgeRewriteRef {
  page_path: string;
  receipt_id: string;
}

export type PurgeStorePresence = "configured" | "not_configured" | "unavailable";

export interface PurgeOutcome {
  receipts: PurgeReceipt[];
  withdrawn_proposals: string[];
  canon_holds: { page_path: string; proposal_id: string }[];
  purge_ops: PurgeOp[];
  rewritten: PurgeRewriteRef[];
  uncertain_pages: string[];
}

export interface PurgeFilter {
  event_id?: string;
  connector_id?: string;
  subject_handle?: string;
  source_record_id?: string;
}

export interface PurgePreview {
  filter: PurgeFilter;
  reason: string;
  event_count: number;
  event_ids: string[];
  connector_ids: string[];
  affected_pages: string[];
  uncertain_pages: string[];
  search: "configured" | "not_configured";
  graph: "configured" | "not_configured";
  retrieval: PurgeStorePresence;
}

export interface PurgePhaseOptions {
  include_aliases?: boolean;
  now?: () => string;
  ids?: () => string;
  allow_empty?: boolean;
  /** When set, phase 1 records a purge_op for this store. `null` skips it. */
  retrieval_store?: string | null;
}

export interface PurgeRunOptions extends PurgePhaseOptions {
  retrieval?: RetrievalPort;
}

export interface PurgeVerifyReport {
  receipt_id: string;
  proofs: AbsenceProof[];
  pages_rewritten: number;
  hold_lifted: boolean;
  ok: boolean;
}

export interface PurgeHealthFailure {
  kind: "purge_op_stale" | "hold_stale";
  id: string;
  age_s: number;
}

export interface PurgeHealth {
  ok: boolean;
  failures: PurgeHealthFailure[];
}

interface PurgeCandidate {
  event_id: string;
  connector_id: string;
}

interface PageFingerprint {
  relPath: string;
  hash: string;
  page: CanonPage | null;
  sources: string[] | null;
}

interface RetrievalBinding {
  status: PurgeStorePresence;
  port: RetrievalPort | null;
}

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function mint(ids?: () => string): string {
  return ids?.() ?? ulid();
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function describeFilter(filter: PurgeFilter): string {
  const parts: string[] = [];
  if (filter.event_id !== undefined) parts.push(`event_id=${filter.event_id}`);
  if (filter.connector_id !== undefined) {
    parts.push(`connector_id=${filter.connector_id}`);
  }
  if (filter.subject_handle !== undefined) {
    parts.push(`subject_handle=${filter.subject_handle}`);
  }
  if (filter.source_record_id !== undefined) {
    parts.push(`source_record_id=${filter.source_record_id}`);
  }
  return parts.join(" ");
}

export function normalizePurgeReason(reason: string): string {
  if (typeof reason !== "string") {
    throw new PurgeError("invalid_reason", "purge reason must be a string");
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new PurgeError("invalid_reason", "purge reason must be non-empty");
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new PurgeError(
      "invalid_reason",
      "purge reason must not contain control characters",
    );
  }
  if (utf8Bytes(trimmed) > PURGE_REASON_MAX_BYTES) {
    throw new PurgeError(
      "invalid_reason",
      `purge reason must be at most ${PURGE_REASON_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return trimmed;
}

export function listHistoricalConnectorIds(db: Database): string[] {
  const ids = new Set<string>();
  if (tableExists(db, "events")) {
    for (const row of db
      .query<{ connector_id: string }, []>(
        "SELECT DISTINCT connector_id FROM events ORDER BY connector_id",
      )
      .all()) {
      ids.add(row.connector_id);
    }
  }
  if (tableExists(db, "event_purges")) {
    for (const row of db
      .query<{ connector_id: string }, []>(
        "SELECT DISTINCT connector_id FROM event_purges ORDER BY connector_id",
      )
      .all()) {
      ids.add(row.connector_id);
    }
  }
  return [...ids].sort();
}

export function resolvePurgeConnectorId(db: Database, input: string): string {
  if (typeof input !== "string") {
    throw new PurgeError("invalid_filter", "purge connector id must be a string");
  }
  const trimmed = input.trim();
  if (trimmed.length === 0 || utf8Bytes(trimmed) > PURGE_CONNECTOR_ID_MAX) {
    throw new PurgeError(
      "invalid_filter",
      "purge connector id is empty or too long",
    );
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new PurgeError(
      "invalid_filter",
      "purge connector id must not contain control characters",
    );
  }
  const known = new Set(listHistoricalConnectorIds(db));
  if (known.has(trimmed)) return trimmed;
  const prefixed = trimmed.includes(".") ? trimmed : `kizuki.${trimmed}`;
  if (known.has(prefixed)) return prefixed;
  return prefixed;
}

function parseJsonStrings(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function parseProof(raw: string | null): AbsenceProof | null {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as AbsenceProof;
  } catch {
    return null;
  }
}

function emptyOutcome(): PurgeOutcome {
  return {
    receipts: [],
    withdrawn_proposals: [],
    canon_holds: [],
    purge_ops: [],
    rewritten: [],
    uncertain_pages: [],
  };
}

function aliasSet(db: Database, ref: string): string[] {
  if (!tableExists(db, "identity_links")) return [ref];
  const rows = db
    .query<{ subject_a: string; subject_b: string }, [string, string]>(
      `SELECT subject_a, subject_b FROM identity_links
        WHERE subject_a = ? OR subject_b = ?`,
    )
    .all(ref, ref);
  const aliases = new Set<string>([ref]);
  for (const row of rows) {
    aliases.add(row.subject_a);
    aliases.add(row.subject_b);
  }
  return [...aliases];
}

function selector(
  db: Database,
  filter: PurgeFilter,
  includeAliases: boolean,
): { where: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (filter.event_id !== undefined) {
    conditions.push("events.event_id = ?");
    bindings.push(filter.event_id);
  }
  if (filter.connector_id !== undefined) {
    conditions.push("events.connector_id = ?");
    bindings.push(filter.connector_id);
  }
  if (filter.source_record_id !== undefined) {
    conditions.push("events.source_record_id = ?");
    bindings.push(filter.source_record_id);
  }
  if (filter.subject_handle !== undefined) {
    const refs =
      includeAliases === true
        ? aliasSet(db, filter.subject_handle)
        : [filter.subject_handle];
    const subjectClause = refs
      .map(
        () => `
      EXISTS (
        SELECT 1
          FROM json_each(events.subjects) AS subject
         WHERE json_extract(subject.value, '$.subject_id') = ?
      )`,
      )
      .join(" OR ");
    conditions.push(`(${subjectClause})`);
    bindings.push(...refs);
  }
  if (conditions.length === 0) {
    throw new PurgeError(
      "empty_filter",
      "purgeEvents requires a non-empty filter",
      filter,
    );
  }
  return { where: conditions.join(" AND "), bindings };
}

function pageSources(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((source) => typeof source === "string")) {
    return null;
  }
  return raw;
}

function fileHash(path: string): string {
  return sha256Hex(readFileSync(path));
}

function retrievalDataDir(vaultPath: string): string | null {
  if (vaultPath === ":memory:" || vaultPath.length === 0) return null;
  return join(resolve(vaultPath), ".kizuki", "retrieval", FTS5_RETRIEVAL_ID);
}

function retrievalPresence(vaultPath: string): Exclude<PurgeStorePresence, "unavailable"> {
  const dir = retrievalDataDir(vaultPath);
  if (dir === null) return "not_configured";
  return existsSync(join(dir, FTS5_RETRIEVAL_STORE_REL))
    ? "configured"
    : "not_configured";
}

function collectCanonSnapshot(vaultPath: string): PageFingerprint[] {
  if (vaultPath === ":memory:" || vaultPath.length === 0) return [];
  const report = listCanonPagesReport(vaultPath);
  const rows: PageFingerprint[] = [];
  for (const page of report.pages) {
    rows.push({
      relPath: page.relPath,
      hash: fileHash(page.path),
      page,
      sources: pageSources(page.data["sources"]),
    });
  }
  for (const skipped of report.skipped) {
    rows.push({
      relPath: skipped.relPath,
      hash: fileHash(join(vaultPath, skipped.relPath)),
      page: null,
      sources: null,
    });
  }
  return rows;
}

function matchPages(
  snapshot: readonly PageFingerprint[],
  purgedIds: ReadonlySet<string>,
): { affected: CanonPage[]; uncertain: string[] } {
  const affected: CanonPage[] = [];
  const uncertain: string[] = [];
  for (const row of snapshot) {
    if (row.page === null || row.sources === null) {
      uncertain.push(row.relPath);
      continue;
    }
    if (row.sources.some((source) => purgedIds.has(source))) {
      affected.push(row.page);
    }
  }
  return { affected, uncertain };
}

function assertSnapshotStillHolds(
  vaultPath: string,
  snapshot: readonly PageFingerprint[],
  holdPaths: ReadonlySet<string>,
): void {
  if (vaultPath === ":memory:" || vaultPath.length === 0) return;
  for (const row of snapshot) {
    if (!holdPaths.has(row.relPath)) continue;
    const path = row.page?.path ?? join(vaultPath, row.relPath);
    if (fileHash(path) !== row.hash) {
      throw new PurgeError(
        "canon_changed",
        `purge refused: canon page changed during purge (${row.relPath})`,
      );
    }
  }
}

function loadCandidates(
  db: Database,
  filter: PurgeFilter,
  includeAliases: boolean,
): PurgeCandidate[] {
  const { where, bindings } = selector(db, filter, includeAliases);
  return db
    .query<PurgeCandidate, string[]>(
      `SELECT events.event_id, events.connector_id
         FROM events
        WHERE ${where}
        ORDER BY events.accepted_at, events.event_id`,
    )
    .all(...bindings);
}

function boundIds(ids: readonly string[]): string[] {
  return ids.slice(0, PURGE_PREVIEW_ID_LIMIT);
}

function storePresence(db: Database, table: string): "configured" | "not_configured" {
  return tableExists(db, table) ? "configured" : "not_configured";
}

export function previewPurge(
  db: Database,
  vaultPath: string,
  filter: PurgeFilter,
  reason: string,
  options: PurgePhaseOptions = {},
): PurgePreview {
  const normalized = normalizePurgeReason(reason);
  const includeAliases = options.include_aliases === true;
  const candidates = loadCandidates(db, filter, includeAliases);
  const connectors = [...new Set(candidates.map((row) => row.connector_id))].sort();
  const matched =
    candidates.length === 0
      ? { affected: [] as CanonPage[], uncertain: [] as string[] }
      : matchPages(
          collectCanonSnapshot(vaultPath),
          new Set(candidates.map((row) => row.event_id)),
        );
  return {
    filter,
    reason: normalized,
    event_count: candidates.length,
    event_ids: boundIds(candidates.map((row) => row.event_id)),
    connector_ids: connectors,
    affected_pages: matched.affected.map((page) => page.relPath),
    uncertain_pages: matched.uncertain,
    search: storePresence(db, "search_docs"),
    graph: storePresence(db, "graph_edges"),
    retrieval: retrievalPresence(vaultPath),
  };
}

function retrievalIds(
  purgedIds: readonly string[],
  pageIds: readonly string[],
  claimIds: readonly string[],
): string[] {
  return [
    ...purgedIds.map((id) => `event:${id}`),
    ...pageIds.map((id) => `page:${id}`),
    ...claimIds.map((id) => `claim:${id}`),
  ];
}

function claimsCiting(
  db: Database,
  eventIds: readonly string[],
): Claim[] {
  if (!tableExists(db, "claims") || eventIds.length === 0) return [];
  const wanted = new Set(eventIds);
  return [
    ...listClaims(db, { status: "live", limit: 10_000 }),
    ...listClaims(db, { status: "provenance_reduced", limit: 10_000 }),
    ...listClaims(db, { status: "purged", limit: 10_000 }),
  ].filter((claim) => claim.provenance.some((id) => wanted.has(id)));
}

function rowToOp(row: {
  op_id: string;
  receipt_id: string;
  store: string;
  ids: string;
  state: string;
  proof: string | null;
  created_at: string;
  done_at: string | null;
}): PurgeOp {
  return {
    op_id: row.op_id,
    receipt_id: row.receipt_id,
    store: row.store,
    ids: parseJsonStrings(row.ids),
    state: row.state === "done" ? "done" : "pending",
    proof: parseProof(row.proof),
    created_at: row.created_at,
    done_at: row.done_at,
  };
}

function listOps(db: Database, receiptId?: string): PurgeOp[] {
  if (!tableExists(db, "purge_ops")) return [];
  if (receiptId === undefined) {
    return db
      .query<
        {
          op_id: string;
          receipt_id: string;
          store: string;
          ids: string;
          state: string;
          proof: string | null;
          created_at: string;
          done_at: string | null;
        },
        []
      >(
        `SELECT op_id, receipt_id, store, ids, state, proof, created_at, done_at
           FROM purge_ops
          ORDER BY created_at, op_id`,
      )
      .all()
      .map(rowToOp);
  }
  return db
    .query<
      {
        op_id: string;
        receipt_id: string;
        store: string;
        ids: string;
        state: string;
        proof: string | null;
        created_at: string;
        done_at: string | null;
      },
      [string]
    >(
      `SELECT op_id, receipt_id, store, ids, state, proof, created_at, done_at
         FROM purge_ops
        WHERE receipt_id = ?
        ORDER BY created_at, op_id`,
    )
    .all(receiptId)
    .map(rowToOp);
}

export function readHolds(db: Database): CanonHold[] {
  if (!tableExists(db, "canon_holds")) return [];
  return db
    .query<CanonHold, []>(
      `SELECT page_path, proposal_id, reason, held_at
         FROM canon_holds
        ORDER BY page_path, proposal_id`,
    )
    .all();
}

export function isHeld(db: Database, page_path: string): boolean {
  if (!tableExists(db, "canon_holds")) return false;
  return (
    db
      .query<{ held: number }, [string]>(
        "SELECT 1 AS held FROM canon_holds WHERE page_path = ? LIMIT 1",
      )
      .get(page_path) !== null
  );
}

function ageSeconds(from: string, to: string): number {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.floor((end - start) / 1000);
}

export function inspectPurgeHealth(
  db: Database,
  now: string = new Date().toISOString(),
): PurgeHealth {
  const failures: PurgeHealthFailure[] = [];
  for (const op of listOps(db)) {
    if (op.state !== "pending") continue;
    const age = ageSeconds(op.created_at, now);
    if (age > PURGE_SLA_SECONDS) {
      failures.push({ kind: "purge_op_stale", id: op.op_id, age_s: age });
    }
  }
  for (const hold of readHolds(db)) {
    const age = ageSeconds(hold.held_at, now);
    if (age > PURGE_SLA_SECONDS) {
      failures.push({
        kind: "hold_stale",
        id: `${hold.page_path}:${hold.proposal_id}`,
        age_s: age,
      });
    }
  }
  return { ok: failures.length === 0, failures };
}

export function createVaultFts5Port(
  vaultPath: string,
  clock: () => string = () => new Date().toISOString(),
): RetrievalPort {
  const vault = resolve(vaultPath);
  return createFts5RetrievalPort({
    vault_path: vault,
    data_dir: join(vault, ".kizuki", "retrieval", FTS5_RETRIEVAL_ID),
    config: Object.freeze({}),
    secrets: async () => {
      throw new PortError("unavailable", "purge does not resolve secrets", false);
    },
    clock,
    logger: () => {},
  });
}

function bindRetrieval(
  vaultPath: string,
  provided: RetrievalPort | undefined,
  clock: () => string,
): RetrievalBinding {
  if (provided !== undefined) return { status: "configured", port: provided };
  if (retrievalPresence(vaultPath) === "not_configured") {
    return { status: "not_configured", port: null };
  }
  try {
    return { status: "configured", port: createVaultFts5Port(vaultPath, clock) };
  } catch {
    return { status: "unavailable", port: null };
  }
}

function resolveRetrievalStore(
  vaultPath: string,
  options: PurgePhaseOptions,
): string | null {
  if (options.retrieval_store !== undefined) return options.retrieval_store;
  return retrievalPresence(vaultPath) === "configured" ? FTS5_RETRIEVAL_ID : null;
}

function assertDeleted(changes: number, eventId: string): void {
  if (changes !== 1) {
    throw new PurgeError(
      "delete_mismatch",
      `purge deleted ${changes} rows for ${eventId}; expected 1`,
    );
  }
}

function assertAbsent(db: Database, eventIds: readonly string[]): void {
  if (eventIds.length === 0) return;
  const leftover = db
    .query<{ event_id: string }, string[]>(
      `SELECT event_id FROM events
        WHERE event_id IN (${eventIds.map(() => "?").join(", ")})
        ORDER BY event_id`,
    )
    .all(...eventIds);
  if (leftover.length > 0) {
    throw new PurgeError(
      "absence_failed",
      `purge receipt claimed deletion but ${leftover.length} event(s) remain`,
    );
  }
}

/**
 * Phase 1 — short SQLite transaction (RFC 0002 §13.1). Canon is scanned
 * before the write lock. Holds land before derived stores are touched.
 * Retrieval ops are recorded only for a store that already exists.
 */
export function purgeEvents(
  db: Database,
  vaultPath: string,
  filter: PurgeFilter,
  reason: string,
  options: PurgePhaseOptions = {},
): PurgeOutcome {
  const lock = tryWriteFlock(vaultPath);
  if (lock === null) throw new PurgeError("canon_changed", "canon writer is busy; retry purge", filter);
  try {
    if (tableExists(db, "canon_write_reservations")) settleWriteReservations(db, vaultPath);
    return purgeEventsLocked(db, vaultPath, filter, reason, options);
  } finally { lock.release(); }
}

function purgeEventsLocked(
  db: Database,
  vaultPath: string,
  filter: PurgeFilter,
  reason: string,
  options: PurgePhaseOptions = {},
): PurgeOutcome {
  initPurgeOps(db);
  const recordedReason = normalizePurgeReason(reason);
  const includeAliases = options.include_aliases === true;
  const existing = loadCandidates(db, filter, includeAliases);
  if (existing.length === 0) {
    if (options.allow_empty === true) return emptyOutcome();
    throw new PurgeError(
      "no_match",
      `purge matched no events for ${describeFilter(filter)}`,
      filter,
    );
  }
  const snapshot = collectCanonSnapshot(vaultPath);
  afterCanonSnapshot?.();
  const retrievalStore = resolveRetrievalStore(vaultPath, options);

  const outcome = db.transaction((): PurgeOutcome => {
    const candidates = loadCandidates(db, filter, includeAliases);
    if (candidates.length === 0) {
      if (options.allow_empty === true) return emptyOutcome();
      throw new PurgeError(
        "no_match",
        `purge matched no events for ${describeFilter(filter)}`,
        filter,
      );
    }

    const purgedIds = new Set(candidates.map((row) => row.event_id));
    purgeExtractInputs(db, purgedIds);
    const { matched, holdPaths } = holdPathsFor(snapshot, purgedIds);
    assertSnapshotStillHolds(vaultPath, snapshot, holdPaths);

    const purgedAt = nowIso(options.now);
    const receipts: PurgeReceipt[] = [];
    const insertReceipt = db.query<
      never,
      [string, string, string, string, string]
    >(
      `INSERT INTO event_purges
         (receipt_id, event_id, connector_id, reason, purged_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const deleteEvent = db.query<never, [string]>(
      "DELETE FROM events WHERE event_id = ?",
    );

    const batchReceipt = mint(options.ids);
    const holds: { page_path: string; proposal_id: string }[] = [];
    const holdReason =
      includeAliases && filter.subject_handle !== undefined
        ? `${recordedReason} (aliases: ${aliasSet(db, filter.subject_handle).join(", ")})`
        : recordedReason;

    for (const relPath of holdPaths) {
      insertHold(db, relPath, batchReceipt, holdReason, purgedAt);
      holds.push({ page_path: relPath, proposal_id: batchReceipt });
    }
    holds.sort((left, right) =>
      left.page_path < right.page_path ? -1 : left.page_path > right.page_path ? 1 : 0,
    );

    for (const candidate of candidates) {
      const receipt: PurgeReceipt = {
        receipt_id: receipts.length === 0 ? batchReceipt : mint(options.ids),
        event_id: candidate.event_id,
        connector_id: candidate.connector_id,
        reason: holdReason,
        purged_at: purgedAt,
      };
      insertReceipt.run(
        receipt.receipt_id,
        receipt.event_id,
        receipt.connector_id,
        receipt.reason,
        receipt.purged_at,
      );
      const deleted = deleteEvent.run(candidate.event_id);
      assertDeleted(deleted.changes, candidate.event_id);
      receipts.push(receipt);
    }

    const eventIds = candidates.map(({ event_id }) => event_id);
    if (tableExists(db, "search_docs")) {
      for (const eventId of eventIds) {
        removeDoc(db, "ledger", eventId);
      }
    }
    if (tableExists(db, "graph_edges")) {
      const removeGraphEdges = db.query<never, [string, string]>(
        "DELETE FROM graph_edges WHERE src = ? OR dst = ?",
      );
      for (const eventId of eventIds) {
        removeGraphEdges.run(eventId, eventId);
      }
    }

    markClaimsAfterPurge(db, purgedAt);

    const withdrawn = new Set<string>();
    if (tableExists(db, "proposals")) {
      for (const eventId of eventIds) {
        for (const proposalId of withdrawForTombstone(db, eventId)) {
          withdrawn.add(proposalId);
        }
      }
    }

    const citing = claimsCiting(db, eventIds);
    const pageIds = matched.affected
      .map((page) => page.id)
      .filter((id) => id.length > 0);
    const claimIds = citing.map((claim) => claim.claim_id);
    const ops: PurgeOp[] = [];
    if (retrievalStore !== null) {
      const op: PurgeOp = {
        op_id: mint(options.ids),
        receipt_id: batchReceipt,
        store: retrievalStore,
        ids: retrievalIds(eventIds, pageIds, claimIds),
        state: "pending",
        proof: null,
        created_at: purgedAt,
        done_at: null,
      };
      db.query(
        `INSERT INTO purge_ops
           (op_id, receipt_id, store, ids, state, proof, created_at, done_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)`,
      ).run(op.op_id, op.receipt_id, op.store, JSON.stringify(op.ids), op.state, op.created_at);
      ops.push(op);
    }

    return {
      receipts,
      withdrawn_proposals: [...withdrawn].sort(),
      canon_holds: holds,
      purge_ops: ops,
      rewritten: [],
      uncertain_pages: matched.uncertain,
    };
  }).immediate();

  assertAbsent(
    db,
    outcome.receipts.map((receipt) => receipt.event_id),
  );
  catchUpHolds(db, vaultPath, outcome);
  return outcome;
}

async function reconcileOps(
  db: Database,
  receiptId: string,
  binding: RetrievalBinding,
  clock: () => string,
): Promise<PurgeOp[]> {
  const ops = listOps(db, receiptId).filter((op) => op.state === "pending");
  if (binding.port === null) return ops;
  for (const op of ops) {
    try {
      await binding.port.remove(op.ids);
      const proof = await binding.port.verifyAbsent(op.ids);
      if (proof.found.length === 0) {
        const doneAt = clock();
        db.query(
          `UPDATE purge_ops
              SET state = 'done', proof = ?, done_at = ?
            WHERE op_id = ?`,
        ).run(JSON.stringify(proof), doneAt, op.op_id);
        op.state = "done";
        op.proof = proof;
        op.done_at = doneAt;
      }
    } catch {
      // Stay pending; purge-sweep / --verify retry. RFC §13.1.
    }
  }
  return listOps(db, receiptId);
}

function readHoldSources(vaultPath: string, relPath: string): string[] | null {
  const path = join(vaultPath, relPath);
  if (!existsSync(path)) return null;
  try {
    return pageSources(parseFrontmatter(readFileSync(path, "utf8")).data["sources"]);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function matchablePagePaths(vaultPath: string): Set<string> {
  return new Set(
    collectCanonSnapshot(vaultPath)
      .filter((row) => row.page !== null && row.sources !== null)
      .map((row) => row.relPath),
  );
}

function purgedCitations(db: Database, sources: readonly string[]): string[] {
  if (!tableExists(db, "event_purges") || sources.length === 0) return [];
  return db
    .query<{ event_id: string }, string[]>(
      `SELECT event_id FROM event_purges
        WHERE event_id IN (${sources.map(() => "?").join(", ")})
        ORDER BY event_id`,
    )
    .all(...sources)
    .map((row) => row.event_id);
}

function liftHold(db: Database, pagePath: string): void {
  if (!tableExists(db, "canon_holds")) return;
  db.query("DELETE FROM canon_holds WHERE page_path = ?").run(pagePath);
}

function insertHold(
  db: Database,
  pagePath: string,
  proposalId: string,
  reason: string,
  heldAt: string,
): void {
  db.query(
    `INSERT OR IGNORE INTO canon_holds
       (page_path, proposal_id, reason, held_at)
     VALUES (?, ?, ?, ?)`,
  ).run(pagePath, proposalId, reason, heldAt);
}

function holdPathsFor(
  snapshot: readonly PageFingerprint[],
  purgedIds: ReadonlySet<string>,
): { matched: { affected: CanonPage[]; uncertain: string[] }; holdPaths: Set<string> } {
  const matched = matchPages(snapshot, purgedIds);
  return {
    matched,
    holdPaths: new Set([
      ...matched.affected.map((page) => page.relPath),
      ...matched.uncertain,
    ]),
  };
}

/** After the write lock drops, hold pages the pre-lock snapshot missed. */
function catchUpHolds(
  db: Database,
  vaultPath: string,
  outcome: PurgeOutcome,
): void {
  const eventIds = outcome.receipts.map((receipt) => receipt.event_id);
  const batch = outcome.receipts[0];
  if (eventIds.length === 0 || batch === undefined) return;
  const { matched, holdPaths } = holdPathsFor(
    collectCanonSnapshot(vaultPath),
    new Set(eventIds),
  );
  const already = new Set(outcome.canon_holds.map((hold) => hold.page_path));
  for (const relPath of holdPaths) {
    insertHold(db, relPath, batch.receipt_id, batch.reason, batch.purged_at);
    if (!already.has(relPath)) {
      outcome.canon_holds.push({ page_path: relPath, proposal_id: batch.receipt_id });
      already.add(relPath);
    }
  }
  outcome.canon_holds.sort((left, right) =>
    left.page_path < right.page_path ? -1 : left.page_path > right.page_path ? 1 : 0,
  );
  outcome.uncertain_pages = [...new Set([...outcome.uncertain_pages, ...matched.uncertain])].sort();
  const latePages = matched.affected
    .filter((page) => page.id.length > 0)
    .map((page) => `page:${page.id}`);
  for (const op of outcome.purge_ops) {
    if (op.state !== "pending") continue;
    const extra = latePages.filter((id) => !op.ids.includes(id));
    if (extra.length === 0) continue;
    op.ids = [...op.ids, ...extra];
    db.query("UPDATE purge_ops SET ids = ? WHERE op_id = ?").run(
      JSON.stringify(op.ids),
      op.op_id,
    );
  }
}

function rewriteHolds(
  db: Database,
  vaultPath: string,
  options: PurgeRunOptions,
): PurgeRewriteRef[] {
  const rewritten: PurgeRewriteRef[] = [];
  const holds = readHolds(db);
  if (holds.length === 0) return rewritten;
  const matchable = matchablePagePaths(vaultPath);
  const io: CanonIo = {
    db,
    vault_path: vaultPath,
    retrieval_store: FTS5_RETRIEVAL_ID,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ids !== undefined ? { ids: options.ids } : {}),
    ...(options.retrieval !== undefined ? { retrieval: options.retrieval } : {}),
  };
  for (const hold of holds) {
    const sources = readHoldSources(vaultPath, hold.page_path);
    if (sources === null) continue;
    const toRemove = purgedCitations(db, sources);
    if (toRemove.length === 0) {
      if (matchable.has(hold.page_path)) liftHold(db, hold.page_path);
      continue;
    }
    const purged = new Set(toRemove);
    const matchingClaims = claimsCiting(db, toRemove).filter((claim) => {
      if (claim.target !== null && hold.page_path.startsWith(claim.target)) {
        return true;
      }
      return claim.provenance.some((id) => purged.has(id));
    });
    const purgedClaims = matchingClaims.filter((claim) => {
      const stored = getClaim(db, claim.claim_id);
      return stored?.status === "purged";
    });
    let receipt;
    try {
      receipt = applyPurgeRewrite(io, {
        rel_path: hold.page_path,
        purged_event_ids: toRemove,
        purged_claim_ids: purgedClaims.map((claim) => claim.claim_id),
        purged_claim_bodies: purgedClaims.map((claim) => claim.body),
      });
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      if (error instanceof CanonWriteError && error.code === "decision_stale") {
        continue;
      }
      throw error;
    }
    rewritten.push({ page_path: hold.page_path, receipt_id: receipt.receipt_id });
  }
  return rewritten;
}

/** Phases 1–3 in one pass: hold, reconcile stores, rewrite canon. */
export async function runPurge(
  db: Database,
  vaultPath: string,
  filter: PurgeFilter,
  reason: string,
  options: PurgeRunOptions = {},
): Promise<PurgeOutcome> {
  const clock = options.now ?? (() => new Date().toISOString());
  const binding = bindRetrieval(vaultPath, options.retrieval, clock);
  const retrievalStore =
    binding.status === "not_configured" ? null : FTS5_RETRIEVAL_ID;
  const phase1 = purgeEvents(db, vaultPath, filter, reason, {
    ...options,
    retrieval_store: retrievalStore,
  });
  if (phase1.receipts.length === 0) return phase1;
  const receiptId = phase1.receipts[0]?.receipt_id;
  if (receiptId !== undefined) {
    phase1.purge_ops = await reconcileOps(db, receiptId, binding, clock);
  }
  phase1.rewritten = rewriteHolds(db, vaultPath, options);
  return phase1;
}

export async function verifyPurge(
  db: Database,
  vaultPath: string,
  receiptId: string,
  options: { retrieval?: RetrievalPort; now?: () => string } = {},
): Promise<PurgeVerifyReport> {
  initPurgeOps(db);
  const clock = options.now ?? (() => new Date().toISOString());
  const binding = bindRetrieval(vaultPath, options.retrieval, clock);
  const ops = listOps(db, receiptId);
  const proofs: AbsenceProof[] = [];
  let ok = true;
  for (const op of ops) {
    if (binding.port === null) {
      ok = false;
      continue;
    }
    const proof = await binding.port.verifyAbsent(op.ids);
    proofs.push(proof);
    if (proof.found.length > 0) ok = false;
    if (proof.found.length === 0 && op.state !== "done") {
      db.query(
        `UPDATE purge_ops
            SET state = 'done', proof = ?, done_at = ?
          WHERE op_id = ?`,
      ).run(JSON.stringify(proof), clock(), op.op_id);
    }
  }
  const holds = readHolds(db).filter((hold) => hold.proposal_id === receiptId);
  const pagesRewritten = db
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM canon_receipts
        WHERE receipt_kind = 'purge_rewrite'
          AND EXISTS (
            SELECT 1 FROM json_each(canon_receipts.provenance) AS p
             WHERE p.value IN (
               SELECT event_id FROM event_purges WHERE receipt_id = ?
             )
          )`,
    )
    .get(receiptId)?.n ?? 0;
  const holdLifted = holds.length === 0;
  if (!holdLifted) ok = false;
  return {
    receipt_id: receiptId,
    proofs,
    pages_rewritten: pagesRewritten,
    hold_lifted: holdLifted,
    ok,
  };
}
