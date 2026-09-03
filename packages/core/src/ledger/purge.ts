import type { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { applyPurgeRewrite } from "../canon/apply";
import type { CanonIo } from "../canon";
import { getClaim, listClaims, markClaimsAfterPurge } from "../claims/store";
import { PortError } from "../contracts/ports";
import type { Claim } from "../contracts/proposal";
import type { AbsenceProof, RetrievalPort } from "../contracts/retrieval";
import { initGraph } from "../graph/schema";
import { FTS5_RETRIEVAL_ID, createFts5RetrievalPort } from "../retrieval";
import { removeDoc } from "../search/indexer";
import { initSearch } from "../search/schema";
import { withdrawForTombstone } from "../staging/producers";
import { ulid } from "../util/ulid";
import { listCanonPagesReport } from "../vault/pages";
import { initPurgeOps, PURGE_SLA_SECONDS } from "./purge-schema";
import { tableExists } from "./schema";

export { PURGE_SLA_SECONDS, PURGE_SCHEMA_VERSION, applyPurgeV5 } from "./purge-schema";

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

export interface PurgeOutcome {
  receipts: PurgeReceipt[];
  withdrawn_proposals: string[];
  canon_holds: { page_path: string; proposal_id: string }[];
  purge_ops: PurgeOp[];
  rewritten: PurgeRewriteRef[];
}

export interface PurgeFilter {
  event_id?: string;
  connector_id?: string;
  subject_handle?: string;
  source_record_id?: string;
}

export interface PurgePhaseOptions {
  include_aliases?: boolean;
  now?: () => string;
  ids?: () => string;
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

function nowIso(now?: () => string): string {
  return now?.() ?? new Date().toISOString();
}

function mint(ids?: () => string): string {
  return ids?.() ?? ulid();
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
    throw new Error("purgeEvents requires a non-empty filter");
  }
  return { where: conditions.join(" AND "), bindings };
}

function pageSources(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((source) => typeof source === "string")) {
    throw new Error("canon page sources must be a string array");
  }
  return raw;
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
): RetrievalPort | null {
  if (provided !== undefined) return provided;
  if (vaultPath === ":memory:" || vaultPath.length === 0) return null;
  try {
    return createVaultFts5Port(vaultPath, clock);
  } catch {
    return null;
  }
}

/**
 * Phase 1 — one SQLite transaction (RFC 0002 §13.1). Holds land before
 * derived stores are touched. Retrieval stores are recorded as pending
 * `purge_ops` and reconciled outside this transaction.
 */
export function purgeEvents(
  db: Database,
  vaultPath: string,
  filter: PurgeFilter,
  reason: string,
  options: PurgePhaseOptions = {},
): PurgeOutcome {
  initPurgeOps(db);
  const includeAliases = options.include_aliases === true;
  const { where, bindings } = selector(db, filter, includeAliases);

  return db.transaction((): PurgeOutcome => {
    const report = listCanonPagesReport(vaultPath);
    if (report.skipped.length > 0) {
      const relPaths = report.skipped.map(({ relPath }) => relPath).join(", ");
      throw new Error(`purge refused: cannot read canon page(s) ${relPaths}`);
    }

    const candidates = db
      .query<PurgeCandidate, string[]>(
        `SELECT events.event_id, events.connector_id
           FROM events
          WHERE ${where}
          ORDER BY events.accepted_at, events.event_id`,
      )
      .all(...bindings);
    if (candidates.length === 0) {
      return emptyOutcome();
    }

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

    const affectedPages = report.pages.filter((page) => {
      const provenance = pageSources(page.data["sources"]);
      return provenance.some((source) =>
        candidates.some((candidate) => candidate.event_id === source),
      );
    });

    const batchReceipt = mint(options.ids);
    const holds: { page_path: string; proposal_id: string }[] = [];
    for (const page of affectedPages) {
      db.query(
        `INSERT OR IGNORE INTO canon_holds
           (page_path, proposal_id, reason, held_at)
         VALUES (?, ?, ?, ?)`,
      ).run(page.relPath, batchReceipt, reason, purgedAt);
      holds.push({ page_path: page.relPath, proposal_id: batchReceipt });
    }

    const recordedReason =
      includeAliases && filter.subject_handle !== undefined
        ? `${reason} (aliases: ${aliasSet(db, filter.subject_handle).join(", ")})`
        : reason;

    for (const candidate of candidates) {
      const receipt: PurgeReceipt = {
        receipt_id: receipts.length === 0 ? batchReceipt : mint(options.ids),
        event_id: candidate.event_id,
        connector_id: candidate.connector_id,
        reason: recordedReason,
        purged_at: purgedAt,
      };
      insertReceipt.run(
        receipt.receipt_id,
        receipt.event_id,
        receipt.connector_id,
        receipt.reason,
        receipt.purged_at,
      );
      deleteEvent.run(candidate.event_id);
      receipts.push(receipt);
    }

    const purgedIds = candidates.map(({ event_id }) => event_id);
    initSearch(db);
    initGraph(db);
    const removeGraphEdges = db.query<never, [string, string]>(
      "DELETE FROM graph_edges WHERE src = ? OR dst = ?",
    );
    for (const eventId of purgedIds) {
      removeDoc(db, "ledger", eventId);
      removeGraphEdges.run(eventId, eventId);
    }

    markClaimsAfterPurge(db, purgedAt);

    const withdrawn = new Set<string>();
    if (tableExists(db, "proposals")) {
      for (const eventId of purgedIds) {
        for (const proposalId of withdrawForTombstone(db, eventId)) {
          withdrawn.add(proposalId);
        }
      }
    }

    const citing = claimsCiting(db, purgedIds);
    const pageIds = affectedPages
      .map((page) => page.id)
      .filter((id) => id.length > 0);
    const claimIds = citing.map((claim) => claim.claim_id);
    const ids = retrievalIds(purgedIds, pageIds, claimIds);
    const op: PurgeOp = {
      op_id: mint(options.ids),
      receipt_id: batchReceipt,
      store: FTS5_RETRIEVAL_ID,
      ids,
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

    return {
      receipts,
      withdrawn_proposals: [...withdrawn].sort(),
      canon_holds: holds,
      purge_ops: [op],
      rewritten: [],
    };
  }).immediate();
}

async function reconcileOps(
  db: Database,
  receiptId: string,
  port: RetrievalPort | null,
  clock: () => string,
): Promise<PurgeOp[]> {
  const ops = listOps(db, receiptId).filter((op) => op.state === "pending");
  if (port === null) return ops;
  for (const op of ops) {
    try {
      await port.remove(op.ids);
      const proof = await port.verifyAbsent(op.ids);
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

function rewriteHolds(
  db: Database,
  vaultPath: string,
  purgedIds: readonly string[],
  options: PurgeRunOptions,
): PurgeRewriteRef[] {
  const rewritten: PurgeRewriteRef[] = [];
  const holds = readHolds(db);
  if (holds.length === 0) return rewritten;
  const citing = claimsCiting(db, purgedIds);
  const io: CanonIo = {
    db,
    vault_path: vaultPath,
    retrieval_store: FTS5_RETRIEVAL_ID,
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.ids !== undefined ? { ids: options.ids } : {}),
    ...(options.retrieval !== undefined ? { retrieval: options.retrieval } : {}),
  };
  for (const hold of holds) {
    const pageClaims = citing.filter((claim) => {
      if (claim.target !== null && hold.page_path.startsWith(claim.target)) {
        return true;
      }
      return claim.provenance.some((id) => purgedIds.includes(id));
    });
    const purgedClaims = pageClaims.filter((claim) => {
      const stored = getClaim(db, claim.claim_id);
      return stored?.status === "purged";
    });
    const receipt = applyPurgeRewrite(io, {
      rel_path: hold.page_path,
      purged_event_ids: purgedIds,
      purged_claim_ids: purgedClaims.map((claim) => claim.claim_id),
      purged_claim_bodies: purgedClaims.map((claim) => claim.body),
    });
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
  const phase1 = purgeEvents(db, vaultPath, filter, reason, options);
  if (phase1.receipts.length === 0) return phase1;
  const clock = options.now ?? (() => new Date().toISOString());
  const port = bindRetrieval(vaultPath, options.retrieval, clock);
  const receiptId = phase1.receipts[0]?.receipt_id;
  if (receiptId !== undefined) {
    phase1.purge_ops = await reconcileOps(db, receiptId, port, clock);
  }
  phase1.rewritten = rewriteHolds(
    db,
    vaultPath,
    phase1.receipts.map((receipt) => receipt.event_id),
    options,
  );
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
  const port = bindRetrieval(vaultPath, options.retrieval, clock);
  const ops = listOps(db, receiptId);
  const proofs: AbsenceProof[] = [];
  let ok = true;
  for (const op of ops) {
    if (port === null) {
      ok = false;
      continue;
    }
    const proof = await port.verifyAbsent(op.ids);
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
