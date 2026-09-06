import { invalidateLocalSourcePort } from "./source-grants";
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
import { collectLegacyPurgeSubjects, parseLegacyIdentityEvidence, resolveLegacyIdentityRef, scanLegacyIdentityRows } from "../claims/identity";
import { PortError } from "../contracts/ports";
import type { Claim } from "../contracts/proposal";
import type { AbsenceProof, ProvenanceAbsenceProof, RetrievalPort } from "../contracts/retrieval";
import { requireProvenanceErasure, validateAbsenceProof, validateProvenanceAbsenceProof, validateRetrievalMutationReport } from "../contracts/retrieval";
import { isPlainObject } from "../util/validate";
import { markDerivedHeld, readDerivedHolds } from "../derived-holds";
import { removeHeldPageEdges } from "../graph/graph";
import {
  FTS5_RETRIEVAL_ID,
  FTS5_RETRIEVAL_STORE_REL,
  createFts5RetrievalPort,
} from "../retrieval";
import { eventIdFromReference } from "../retrieval/ids";
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
  "identity_unsupported",
] as const;
export type PurgeErrorCode = (typeof PURGE_ERROR_CODES)[number];

const CONTROL_CHARS = /[\u0000-\u0008\u000A-\u001F\u007F]/;

/** Test-only seam for the snapshot/lock window. Not a product option. */
let afterCanonSnapshot: (() => void) | undefined;
let recoveryHook: ((stage: "phase-one-committed" | "discovery-held") => void) | undefined;

/** Fixed-code crash-state fixture seam; never grants writer ownership. */
export function setPurgeRecoveryHook(hook?: typeof recoveryHook): void { recoveryHook = hook; }

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
  proof: PurgeProof | null;
  created_at: string;
  done_at: string | null;
}

export interface PurgeProof extends AbsenceProof {
  schema: "kizuki.purge-proof/v1";
  provenance: ProvenanceAbsenceProof;
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
  source_key?: string;
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
  proofs: PurgeProof[];
  pages_rewritten: number;
  hold_lifted: boolean;
  ok: boolean;
}

export interface PurgeHealthFailure {
  kind: "purge_op_stale" | "hold_stale" | "batch_discovery_stale";
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
  owned?: boolean;
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
  if (filter.source_key !== undefined) parts.push(`source_key=${filter.source_key}`);
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

function parseProof(raw: string | null): PurgeProof | null {
  if (raw === null || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as PurgeProof;
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

function assertAliasExpansionUnavailable(filter: PurgeFilter, includeAliases: boolean): void {
  if (includeAliases && filter.subject_handle !== undefined) {
    throw new PurgeError(
      "identity_unsupported",
      "identity authority unavailable",
      filter,
    );
  }
}

function selector(
  db: Database,
  filter: PurgeFilter,
  includeAliases: boolean,
): { where: string; bindings: string[] } {
  const conditions: string[] = [];
  const bindings: string[] = [];
  if (filter.source_key !== undefined) {
    conditions.push("EXISTS (SELECT 1 FROM source_event_bindings b WHERE b.event_id=events.event_id AND b.source_key=?)");
    bindings.push(filter.source_key);
  }
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
    const refs = [filter.subject_handle];
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
  return raw.map(eventIdFromReference);
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
  assertAliasExpansionUnavailable(filter, includeAliases);
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
  // Exhaust the existing streamed predicate; a browsing limit is not a purge
  // boundary. Historical statuses may still have a pending derived removal.
  return listClaims(db, {
    limit: -1,
    filter: (claim) => claim.provenance.some((id) => wanted.has(id)),
  });
}

/** Remove every local projection supported by erased evidence before rewriting. */
function removeDerivedForPurge(
  db: Database,
  eventIds: readonly string[],
  pageIds: readonly string[],
  pages: readonly CanonPage[],
): string[] {
  const events = JSON.stringify(eventIds);
  const documents = JSON.stringify(retrievalIds(eventIds, pageIds, []));
  const removed = new Set<string>();
  // Inspect both copies so an interrupted prior projection cannot hide a row.
  for (const table of ["search_documents", "search_docs"] as const) {
    if (!tableExists(db, table)) continue;
    const rows = db.query<{ doc_id: string }, [string, string]>(
      `SELECT doc_id FROM ${table}
        WHERE doc_id IN (SELECT value FROM json_each(?))
           OR (scope='canon' AND path IN (SELECT page_path FROM canon_holds))
           OR EXISTS (
             SELECT 1 FROM json_each(${table}.provenance) AS p
             JOIN json_each(?) AS e
               ON p.value = e.value OR p.value = 'event:' || e.value
           )`,
    ).all(documents, events);
    for (const row of rows) removed.add(row.doc_id);
  }
  for (const table of ["search_documents", "search_docs"] as const) {
    if (!tableExists(db, table)) continue;
    const remove = db.query<never, [string]>(`DELETE FROM ${table} WHERE doc_id = ?`);
    for (const id of removed) remove.run(id);
  }
  if (tableExists(db, "graph_edges")) {
    db.query<never, [string, string, string]>(
      `WITH erased(id) AS (SELECT value FROM json_each(?))
       DELETE FROM graph_edges
        WHERE src IN (SELECT id FROM erased UNION ALL SELECT 'event:' || id FROM erased)
           OR dst IN (SELECT id FROM erased UNION ALL SELECT 'event:' || id FROM erased)
           OR src IN (SELECT value FROM json_each(?))
           OR dst IN (SELECT value FROM json_each(?))
           OR EXISTS (
             SELECT 1 FROM json_each(graph_edges.provenance) AS p
             JOIN erased AS e ON p.value = e.id OR p.value = 'event:' || e.id
           )`,
    ).run(events, JSON.stringify(pageIds), JSON.stringify(pageIds));
    removeHeldPageEdges(db, pages);
  }
  markDerivedHeld(db, "search", readDerivedHolds(db).paths.size);
  return [...removed];
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
  if (tableExists(db, "purge_batches")) {
    for (const batch of db.query<{ batch_id: string; created_at: string }, []>(
      "SELECT batch_id,created_at FROM purge_batches WHERE state!='ready'",
    ).all()) {
      const age = ageSeconds(batch.created_at, now);
      if (age > PURGE_SLA_SECONDS) failures.push({ kind: "batch_discovery_stale", id: batch.batch_id, age_s: age });
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
    return { status: "configured", port: createVaultFts5Port(vaultPath, clock), owned: true };
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

function eraseLegacyIdentityLinks(
  db: Database,
  eventIds: ReadonlySet<string>,
  claimIds: ReadonlySet<string>,
  subjectRefs: ReadonlySet<string>,
): void {
  if (!tableExists(db, "identity_links")) return;
  let rows;
  try { rows = scanLegacyIdentityRows(db); } catch { throw new PurgeError("absence_failed", "identity link verification exceeded its bounded limit"); }
  const remove = db.query<never, [string, string]>(
    "DELETE FROM identity_links WHERE subject_a = ? AND subject_b = ?",
  );
  for (const row of rows) {
    const endpointErased = subjectRefs.has(row.subject_a) || subjectRefs.has(row.subject_b);
    const parsed = parseLegacyIdentityEvidence(row.evidence);
    const supportErased = parsed.ok && parsed.refs.some((ref) => resolveLegacyIdentityRef(db, ref, eventIds, claimIds) === "erased");
    if (endpointErased || supportErased) remove.run(row.subject_a, row.subject_b);
  }
}

function assertLegacyIdentityAbsent(
  db: Database,
  eventIds: ReadonlySet<string>,
  claimIds: ReadonlySet<string>,
  subjectRefs: ReadonlySet<string>,
): void {
  if (!tableExists(db, "identity_links")) return;
  let rows;
  try { rows = scanLegacyIdentityRows(db); } catch { throw new PurgeError("absence_failed", "identity link verification exceeded its bounded limit"); }
  for (const row of rows) {
    if (subjectRefs.has(row.subject_a) || subjectRefs.has(row.subject_b)) {
      throw new PurgeError("absence_failed", "purge retained an erased identity endpoint");
    }
    const parsed = parseLegacyIdentityEvidence(row.evidence);
    if (!parsed.ok) {
      throw new PurgeError("absence_failed", "identity link evidence is malformed or unresolved");
    }
    if (parsed.refs.some((ref) => resolveLegacyIdentityRef(db, ref, eventIds, claimIds) !== "current")) {
      throw new PurgeError("absence_failed", "purge retained erased identity support");
    }
  }
}

function legacyIdentityAbsenceProvable(db: Database): boolean {
  return !tableExists(db, "identity_links") || db.query("SELECT 1 FROM identity_links LIMIT 1").get() === null;
}

interface PurgeBatch { batch_id: string; state: "discovering" | "ready" | "legacy_unresolved"; created_at: string }

function readBatch(db: Database, receiptId: string): PurgeBatch | null {
  return db.query<PurgeBatch, [string, string]>(
    `SELECT batch_id,state,created_at FROM purge_batches
      WHERE batch_id=(SELECT batch_id FROM purge_batch_receipts WHERE receipt_id=?) OR batch_id=? LIMIT 1`,
  ).get(receiptId, receiptId);
}

/** Pending store work and discovery/holds share one canonical recovery entry. */
export function listPurgeRecoveryReceipts(db: Database): string[] {
  const receipts = new Set<string>();
  if (tableExists(db, "purge_batches")) {
    for (const row of db.query<{ batch_id: string }, []>(
      "SELECT batch_id FROM purge_batches WHERE state!='ready'",
    ).all()) receipts.add(row.batch_id);
  }
  for (const op of listOps(db)) {
    if (op.state === "pending") receipts.add(readBatch(db, op.receipt_id)?.batch_id ?? op.receipt_id);
  }
  for (const hold of readHolds(db)) receipts.add(readBatch(db, hold.proposal_id)?.batch_id ?? hold.proposal_id);
  return [...receipts].sort();
}

function batchEventIds(db: Database, batchId: string): string[] {
  return db.query<{ event_id: string }, [string, string]>(
    `SELECT DISTINCT event_id FROM (
       SELECT e.event_id FROM purge_batch_receipts m JOIN event_purges e USING(receipt_id) WHERE m.batch_id=?
       UNION SELECT b.event_id FROM source_event_bindings b JOIN source_grants g USING(source_key) WHERE g.purge_receipt_id=?
     ) ORDER BY event_id`,
  ).all(batchId, batchId).map(row => row.event_id);
}

function ensureSourceBatch(db: Database, receiptId: string): void {
  if (readBatch(db, receiptId) !== null) return;
  db.query(`INSERT INTO purge_batches(batch_id,state,created_at)
              SELECT purge_receipt_id,'discovering',updated_at FROM source_grants
               WHERE purge_receipt_id=? AND status IN ('denied','purged')`).run(receiptId);
}

function recognizedPurgeReceipt(db: Database, receiptId: string): boolean {
  return readBatch(db, receiptId)?.state === "ready";
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
  assertAliasExpansionUnavailable(filter, includeAliases);
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
    let subjectRefs: Set<string>;
    try { subjectRefs = collectLegacyPurgeSubjects(db, purgedIds); } catch { throw new PurgeError("absence_failed", "purge subject snapshot is malformed or exceeds its bound"); }
    const purgedAt = nowIso(options.now);
    const batchReceipt = mint(options.ids);
    db.query("INSERT INTO purge_batches VALUES(?,'discovering',?)").run(batchReceipt, purgedAt);
    markDerivedHeld(db, "search", 1);
    markDerivedHeld(db, "graph", 1);
    purgeExtractInputs(db, purgedIds, { receipt_id: batchReceipt, created_at: purgedAt });
    const { matched, holdPaths } = holdPathsFor(snapshot, purgedIds);
    assertSnapshotStillHolds(vaultPath, snapshot, holdPaths);

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

    const holds: { page_path: string; proposal_id: string }[] = [];
    const holdReason = recordedReason;

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
      db.query("INSERT INTO purge_batch_receipts VALUES(?,?)").run(receipt.receipt_id, batchReceipt);
      const deleted = deleteEvent.run(candidate.event_id);
      assertDeleted(deleted.changes, candidate.event_id);
      receipts.push(receipt);
    }

    const eventIds = candidates.map(({ event_id }) => event_id);
    const pageIds = matched.affected
      .map((page) => page.id)
      .filter((id) => id.length > 0);
    const derivedDocIds = removeDerivedForPurge(db, eventIds, pageIds, snapshot.flatMap(row => row.page === null ? [] : [row.page]));

    const citing = claimsCiting(db, eventIds);
    const claimIds = [...new Set(citing.map((claim) => claim.claim_id))].sort();
    eraseLegacyIdentityLinks(
      db,
      purgedIds,
      new Set(claimIds),
      subjectRefs,
    );
    markClaimsAfterPurge(db, purgedAt);
    assertLegacyIdentityAbsent(
      db,
      purgedIds,
      new Set(claimIds),
      subjectRefs,
    );

    const withdrawn = new Set<string>();
    if (tableExists(db, "proposals")) {
      for (const eventId of eventIds) {
        for (const proposalId of withdrawForTombstone(db, eventId)) {
          withdrawn.add(proposalId);
        }
      }
    }

    const retrievalClaimIds = citing.map((claim) => claim.claim_id);
    const ops: PurgeOp[] = [];
    if (retrievalStore !== null) {
      const op: PurgeOp = {
        op_id: mint(options.ids),
        receipt_id: batchReceipt,
        store: retrievalStore,
        ids: [...new Set([...retrievalIds(eventIds, pageIds, retrievalClaimIds), ...derivedDocIds])],
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
  recoveryHook?.("phase-one-committed");
  const batchId = outcome.receipts[0]?.receipt_id;
  if (batchId !== undefined) {
    const discovered = catchUpHolds(db, vaultPath, batchId);
    outcome.canon_holds = discovered.holds;
    outcome.uncertain_pages = discovered.uncertain;
    outcome.purge_ops = listOps(db, batchId);
  }
  return outcome;
}

function ownedErasureProof(db:Database, receiptId:string, op:PurgeOp, at:string):PurgeProof|null {
  if(!tableExists(db,"source_retrieval_stores")) return null;
  const proved=db.query("SELECT 1 FROM source_grants g JOIN source_retrieval_stores s ON s.source_key=g.source_key WHERE g.purge_receipt_id=? AND s.store_id=? AND s.status IN ('maintained','absent')").get(receiptId,`local:${op.store}`);
  return proved===null ? null : {
    schema: "kizuki.purge-proof/v1", checked:op.ids.length,found:[],store:op.store,method:"owned-generation-erasure",at,
    provenance: { scope: "event-provenance/v1", checked: batchEventIds(db, receiptId).length, found: [], store: op.store, method: "owned-generation-erasure", at },
  };
}

function checkedPurgeProof(value: unknown, op: PurgeOp, eventIds: readonly string[]): PurgeProof {
  const proof = validateAbsenceProof(value, op.ids);
  if (!isPlainObject(value) || value["schema"] !== "kizuki.purge-proof/v1") {
    throw new PurgeError("absence_failed", "purge proof has no versioned provenance scope");
  }
  const provenance = validateProvenanceAbsenceProof(value["provenance"], eventIds);
  if (proof.store !== op.store || provenance.store !== op.store) {
    throw new PurgeError("absence_failed", "purge proof names a different store");
  }
  return { ...proof, schema: "kizuki.purge-proof/v1", provenance };
}

function requirePurgeStore(port: RetrievalPort, op: PurgeOp): void {
  if (port.descriptor.id !== op.store) {
    throw new PurgeError("absence_failed", "purge retrieval binding names a different store");
  }
}

function* proofChunks(ids: readonly string[]): Generator<string[]> {
  for (let offset = 0; offset < ids.length; offset += 500) yield ids.slice(offset, offset + 500);
}

async function proveOperation(
  port: RetrievalPort, op: PurgeOp, eventIds: readonly string[], clock: () => string, remove: boolean,
): Promise<PurgeProof> {
  requirePurgeStore(port, op);
  requireProvenanceErasure(port);
  if (remove) {
    for (const ids of proofChunks(op.ids)) {
      if (validateRetrievalMutationReport(await port.remove(ids)).processed !== ids.length) throw new PurgeError("absence_failed", "purge removal count is incomplete");
    }
    for (const ids of proofChunks(eventIds)) {
      if (validateRetrievalMutationReport(await port.removeByProvenance(ids)).processed !== ids.length) throw new PurgeError("absence_failed", "purge provenance removal count is incomplete");
    }
  }
  const found: string[] = [];
  const provenanceFound: string[] = [];
  for (const ids of proofChunks(op.ids)) {
    const proof = validateAbsenceProof(await port.verifyAbsent(ids), ids);
    if (proof.store !== op.store) throw new PurgeError("absence_failed", "purge proof names a different store");
    found.push(...proof.found);
  }
  for (const ids of proofChunks(eventIds)) {
    const proof = validateProvenanceAbsenceProof(await port.verifyProvenanceAbsent(ids), ids);
    if (proof.store !== op.store) throw new PurgeError("absence_failed", "purge provenance proof names a different store");
    provenanceFound.push(...proof.found);
  }
  const at = clock();
  return checkedPurgeProof({
    schema: "kizuki.purge-proof/v1", checked: op.ids.length, found, store: op.store, method: "bounded-exact-documents", at,
    provenance: { scope: "event-provenance/v1", checked: eventIds.length, found: provenanceFound, store: op.store, method: "bounded-event-provenance", at },
  }, op, eventIds);
}

function proofIsEmpty(proof: PurgeProof): boolean {
  return proof.found.length === 0 && proof.provenance.found.length === 0;
}

async function reconcileOps(
  db: Database,
  receiptId: string,
  binding: RetrievalBinding,
  clock: () => string,
): Promise<PurgeOp[]> {
  const ops = listOps(db, receiptId).filter((op) => op.state === "pending");
  if (binding.port === null) return ops;
  const eventIds = batchEventIds(db, receiptId);
  for (const op of ops) {
    try {
      const proof = await proveOperation(binding.port, op, eventIds, clock, true);
      if (proofIsEmpty(proof)) {
        const doneAt = clock();
        const completed = db.query(
          `UPDATE purge_ops
              SET state = 'done', proof = ?, done_at = ?
            WHERE op_id = ? AND ids = ?`,
        ).run(JSON.stringify(proof), doneAt, op.op_id, JSON.stringify(op.ids));
        if (completed.changes !== 1) throw new PurgeError("absence_failed", "purge closure changed during reconciliation");
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

/** Under the writer fence, atomically extend holds and the persisted store closure. */
function catchUpHolds(db: Database, vaultPath: string, batchId: string): {
  holds: { page_path: string; proposal_id: string }[];
  uncertain: string[];
} {
  const batch = readBatch(db, batchId);
  if (batch === null || batch.state === "legacy_unresolved") throw new PurgeError("absence_failed", "purge batch membership is unresolved");
  const eventIds = batchEventIds(db, batchId);
  const snapshot = collectCanonSnapshot(vaultPath);
  const { matched, holdPaths } = holdPathsFor(snapshot, new Set(eventIds));
  return db.transaction(() => {
    assertSnapshotStillHolds(vaultPath, snapshot, holdPaths);
    const priorHolds = new Set(readHolds(db).filter(hold => hold.proposal_id === batchId).map(hold => hold.page_path));
    let expanded = false;
    for (const relPath of holdPaths) {
      insertHold(db, relPath, batchId, "purge recovery", batch.created_at);
      if (!priorHolds.has(relPath)) expanded = true;
    }
    recoveryHook?.("discovery-held");
    const latePages = matched.affected.filter(page => page.id.length > 0).map(page => `page:${page.id}`);
    const derivedDocIds = removeDerivedForPurge(
      db, eventIds, matched.affected.map(page => page.id),
      snapshot.flatMap(row => row.page === null ? [] : [row.page]),
    );
    for (const op of listOps(db, batchId)) {
      const known = new Set(op.ids);
      const extra = [...new Set([...latePages, ...derivedDocIds])].filter(id => !known.has(id));
      if (extra.length === 0 && !expanded) continue;
      db.query("UPDATE purge_ops SET ids=?,state='pending',proof=NULL,done_at=NULL WHERE op_id=?").run(JSON.stringify([...op.ids, ...extra]), op.op_id);
    }
    db.query("UPDATE purge_batches SET state='ready' WHERE batch_id=?").run(batchId);
    return {
      holds: readHolds(db).filter(hold => hold.proposal_id === batchId).map(hold => ({ page_path: hold.page_path, proposal_id: batchId })),
      uncertain: matched.uncertain,
    };
  }).immediate();
}

function rewriteHolds(
  db: Database,
  vaultPath: string,
  options: PurgeRunOptions,
): PurgeRewriteRef[] {
  const rewritten: PurgeRewriteRef[] = [];
  const holds = readHolds(db);
  const unprovedReceipts = new Set(holds.filter(hold => readBatch(db, hold.proposal_id)?.state !== "ready").map(hold => hold.proposal_id));
  for (const op of listOps(db)) {
    try {
      if (op.state !== "done" || !proofIsEmpty(checkedPurgeProof(op.proof, op, batchEventIds(db, op.receipt_id)))) unprovedReceipts.add(op.receipt_id);
    } catch { unprovedReceipts.add(op.receipt_id); }
  }
  const unprovedPages = new Set(holds.filter(hold => unprovedReceipts.has(hold.proposal_id)).map(hold => hold.page_path));
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
    // A held page cannot be republished until the complete store closure has
    // an exact, validated absence proof. Legacy malformed receipts stay held.
    if (unprovedPages.has(hold.page_path)) continue;
    const sources = readHoldSources(vaultPath, hold.page_path);
    if (sources === null) continue;
    const toRemove = purgedCitations(db, sources);
    if (toRemove.length === 0) {
      if (matchable.has(hold.page_path)) liftHold(db, hold.page_path);
      continue;
    }
    // Removing only the citation would discard the authorization link while
    // retaining mixed or unmatched prose. Keep the hold until source erasure
    // can prove that every retained payload is independent of the denied source.
    if (tableExists(db, "source_event_bindings") && toRemove.some(id =>
      db.query("SELECT 1 FROM source_event_bindings b JOIN source_grants g ON g.source_key=b.source_key WHERE b.event_id=? AND g.status!='active'").get(id) !== null,
    )) continue;
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
  return underPurgeFence(vaultPath, options, async () => {
    if (tableExists(db, "canon_write_reservations")) settleWriteReservations(db, vaultPath);
  const clock = options.now ?? (() => new Date().toISOString());
  const binding = bindRetrieval(vaultPath, options.retrieval, clock);
  try {
  const retrievalStore =
    binding.status === "not_configured" ? null : binding.port?.descriptor.id ?? FTS5_RETRIEVAL_ID;
  const phase1 = purgeEventsLocked(db, vaultPath, filter, reason, {
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
  } finally { if (binding.owned) await binding.port?.close(); }
  }, filter);
}

export async function verifyPurge(
  db: Database,
  vaultPath: string,
  receiptId: string,
  options: { retrieval?: RetrievalPort; now?: () => string } = {},
): Promise<PurgeVerifyReport> {
  initPurgeOps(db);
  const clock = options.now ?? (() => new Date().toISOString());
  const batch = readBatch(db, receiptId);
  if (batch === null || batch.state !== "ready") {
    return { receipt_id: receiptId, proofs: [], pages_rewritten: 0, hold_lifted: false, ok: false };
  }
  const batchId = batch.batch_id;
  const eventIds = batchEventIds(db, batchId);
  const binding = bindRetrieval(vaultPath, options.retrieval, clock);
  let closePending = binding.owned;
  try {
  const ops = listOps(db, batchId);
  const proofs: PurgeProof[] = [];
  let ok = true;
  for (const op of ops) {
    try {
      const owned = ownedErasureProof(db, batchId, op, clock());
      if (owned === null) {
        if (binding.port === null) throw new PurgeError("absence_failed", "purge retrieval store is unavailable");
        requirePurgeStore(binding.port, op);
      }
      const proof = checkedPurgeProof(owned ?? await proveOperation(binding.port!, op, eventIds, clock, false), op, eventIds);
      proofs.push(proof);
      if (!proofIsEmpty(proof)) throw new PurgeError("absence_failed", "purge retrieval documents remain");
      const completed = db.query(
        `UPDATE purge_ops
            SET state = 'done', proof = ?, done_at = ?
          WHERE op_id = ? AND ids = ?`,
      ).run(JSON.stringify(proof), clock(), op.op_id, JSON.stringify(op.ids));
      if (completed.changes !== 1) throw new PurgeError("absence_failed", "purge closure changed during verification");
    } catch {
      ok = false;
      db.query("UPDATE purge_ops SET state='pending', proof=NULL, done_at=NULL WHERE op_id=?").run(op.op_id);
    }
  }
  const pagesRewritten = db
    .query<{ n: number }, [string]>(
      `SELECT count(*) AS n FROM canon_receipts
        WHERE receipt_kind = 'purge_rewrite'
          AND EXISTS (
            SELECT 1 FROM json_each(canon_receipts.provenance) AS p
             WHERE p.value IN (
               SELECT e.event_id FROM event_purges e JOIN purge_batch_receipts m USING(receipt_id) WHERE m.batch_id = ?
             )
          )`,
    )
    .get(batchId)?.n ?? 0;
  if (closePending) {
    closePending = false;
    await binding.port?.close();
  }
  // Recheck after every external verification and owned close have settled. No erased subject
  // dictionary is retained, so legacy identity absence requires an empty table.
  const holdLifted = !readHolds(db).some(hold => hold.proposal_id === batchId);
  const finalOps = listOps(db, batchId);
  if (!holdLifted || !recognizedPurgeReceipt(db, receiptId) || !legacyIdentityAbsenceProvable(db) ||
      JSON.stringify(batchEventIds(db, batchId)) !== JSON.stringify(eventIds) ||
      finalOps.length !== ops.length || finalOps.some(op => {
        const proved = ops.find(prior => prior.op_id === op.op_id);
        return op.state !== "done" || proved === undefined || JSON.stringify(proved.ids) !== JSON.stringify(op.ids);
      })) ok = false;
  return {
    receipt_id: receiptId,
    proofs,
    pages_rewritten: pagesRewritten,
    hold_lifted: holdLifted,
    ok,
  };
  } finally { if (closePending) await binding.port?.close(); }
}

/** Resume existing persisted purge work without creating another deletion path. */
export async function resumePurge(db: Database, vaultPath: string, receiptId: string, options: PurgeRunOptions = {}): Promise<PurgeVerifyReport> {
  return underPurgeFence(vaultPath, options, async () => {
  const clock = options.now ?? (() => new Date().toISOString());
  ensureSourceBatch(db, receiptId);
  const batch = readBatch(db, receiptId);
  if (batch === null || batch.state === "legacy_unresolved") {
    return { receipt_id: receiptId, proofs: [], pages_rewritten: 0, hold_lifted: false, ok: false };
  }
  catchUpHolds(db, vaultPath, batch.batch_id);
  const binding = bindRetrieval(vaultPath, options.retrieval, clock);
  try {
    await reconcileOps(db, batch.batch_id, binding, clock);
    // Revalidate old done rows before a resumed rewrite can lift their holds.
    await verifyPurge(db, vaultPath, receiptId, {...options,...(binding.port === null ? {} : {retrieval:binding.port})});
    rewriteHolds(db, vaultPath, options);
    return await verifyPurge(db, vaultPath, receiptId, {...options,...(binding.port === null ? {} : {retrieval:binding.port})});
  } finally { if (binding.owned) await binding.port?.close(); }
  });
}

/** A timeout bounds the caller, not ownership of an unsettled external operation. */
export async function underPurgeFence<T>(vaultPath: string, options: PurgeRunOptions, work: () => Promise<T>, filter?: PurgeFilter): Promise<T> {
  const lock = tryWriteFlock(vaultPath);
  if (lock === null) throw new PurgeError("canon_changed", "canon writer is busy; retry purge", filter);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = work().finally(() => { lock.release(); if (timer !== undefined) clearTimeout(timer); });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (options.retrieval !== undefined) invalidateLocalSourcePort(options.retrieval);
      reject(new PurgeError("absence_failed", "purge timed out; writer remains fenced until settlement", filter));
    }, 30_000);
  });
  return Promise.race([operation, timeout]);
}
