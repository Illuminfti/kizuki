import type { Database } from "bun:sqlite";
import type { Sensitivity } from "../agents/types";
import type { RetrievalDoc, RetrievalPort, RetrievalQuery } from "../contracts/retrieval";
import type {
  AuthorityTier,
  CanonicalProducer,
  Claim,
  ClaimKind,
  ClaimPolarity,
  ClaimStatus,
  ClaimTaint,
  FrontmatterValue,
  Producer,
} from "../contracts/proposal";
import { AUTHORITY_TIERS, CLAIM_SCHEMA, canonicalizeProducer, isClaimKind, isProducer } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { isRfc3339 } from "../util/time";
import { ulid } from "../util/ulid";
import {
  authorityFor,
  type EventFacts,
} from "./authority";
import {
  claimsConflict,
  resolveConflict,
  type ConflictClaim,
  type ConflictRule,
} from "./conflict";
import {
  CLAIM_DEDUP_MIN,
  FIXTURE_EMBEDDING_SPACE,
  retrievalDedupMode,
  retrievalIsDegraded,
  scoreClaimPair,
  type DedupMode,
} from "./dedup";
import { ClaimError } from "./errors";
import { claimKey, hashBody, normalizeObject, objectsMatch } from "./hash";
import { isRegisteredPredicate } from "./predicates";
import { initClaims } from "./schema";

/** One sweep never walks the whole backlog: the next pass takes the rest. */
export const RETRIEVAL_SWEEP_LIMIT = 32;

export interface ClaimsIo {
  readonly db: Database;
  readonly retrieval?: RetrievalPort;
  readonly now?: () => string;
}

export interface InsertClaimInput {
  kind: ClaimKind;
  target?: string | null;
  subject?: string | null;
  predicate?: string | null;
  object?: string | null;
  polarity?: ClaimPolarity;
  body: string;
  frontmatter?: Record<string, FrontmatterValue>;
  provenance: string[];
  subjects?: string[];
  producer: Producer;
  model_ref?: string | null;
  confidence: number;
  sensitivity?: Sensitivity;
  taint?: ClaimTaint;
  valid_from?: string;
  valid_to?: string | null;
  claim_id?: string;
  intent?: "propose" | "correct";
  /** RFC 0002 §6.4: caps the tier a relayed correction is filed at. */
  relay_ceiling?: AuthorityTier;
  events?: EventFacts[];
}

export type InsertClaimResult =
  | {
      outcome: "stored";
      claim: Claim;
      dedup: DedupMode;
      superseded: { claim_id: string; rule: ConflictRule }[];
    }
  | {
      outcome: "duplicate";
      claim: Claim;
      dedup: DedupMode;
    }
  | {
      outcome: "skipped";
      reason: "below_authority";
      claim: Claim;
      dedup: DedupMode;
    }
  | {
      outcome: "contested";
      incoming: Claim;
      live: Claim;
      dedup: DedupMode;
    };

interface ClaimRow {
  claim_id: string;
  kind: string;
  target: string | null;
  body: string;
  frontmatter: string;
  provenance: string;
  subjects: string;
  producer: string;
  confidence: number;
  status: string;
  created_at: string;
  body_hash: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  polarity: string;
  claim_key: string | null;
  authority: string;
  sensitivity: string | null;
  taint: string;
  model_ref: string | null;
  valid_from: string;
  valid_to: string | null;
  asserted_at: string;
  retracted_at: string | null;
  superseded_by: string | null;
  receipt_id: string | null;
  corroboration: number;
  last_confirmed_at: string | null;
}

function nowOf(io: ClaimsIo): string {
  return io.now?.() ?? new Date().toISOString();
}

function parseJsonObject(raw: string): Record<string, FrontmatterValue> {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ClaimError("schema_invalid", "frontmatter: stored value is not an object");
  }
  return parsed as Record<string, FrontmatterValue>;
}

function parseStringArray(raw: string, field: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new ClaimError("schema_invalid", `${field}: stored value is not a string array`);
  }
  return parsed;
}

function rowToClaim(row: ClaimRow): Claim {
  return {
    schema: CLAIM_SCHEMA,
    claim_id: row.claim_id,
    kind: row.kind as ClaimKind,
    target: row.target,
    body: row.body,
    frontmatter: parseJsonObject(row.frontmatter),
    provenance: parseStringArray(row.provenance, "provenance"),
    subjects: parseStringArray(row.subjects, "subjects"),
    producer: row.producer as CanonicalProducer,
    confidence: row.confidence,
    status: row.status as ClaimStatus,
    created_at: row.created_at,
    body_hash: row.body_hash,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    polarity: row.polarity as ClaimPolarity,
    claim_key: row.claim_key,
    authority: row.authority as AuthorityTier,
    sensitivity: (row.sensitivity ?? "private") as Sensitivity,
    taint: row.taint as ClaimTaint,
    model_ref: row.model_ref,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    asserted_at: row.asserted_at,
    retracted_at: row.retracted_at,
    superseded_by: row.superseded_by,
    receipt_id: row.receipt_id,
    corroboration: row.corroboration,
    last_confirmed_at: row.last_confirmed_at,
  };
}

function toConflict(claim: Claim, purged = false): ConflictClaim {
  return {
    claim_id: claim.claim_id,
    claim_key: claim.claim_key,
    polarity: claim.polarity,
    object: claim.object,
    predicate: claim.predicate,
    authority: claim.authority,
    confidence: claim.confidence,
    valid_from: claim.valid_from,
    valid_to: claim.valid_to,
    status: claim.status,
    provenance: claim.provenance,
    purged,
  };
}

function minTimestamp(left: string | null, right: string): string {
  if (left === null || left === "") return right;
  return left < right ? left : right;
}

function assertInput(input: InsertClaimInput): void {
  if (!isClaimKind(input.kind)) {
    throw new ClaimError("schema_invalid", "kind is not a claim kind");
  }
  if (typeof input.body !== "string") {
    throw new ClaimError("schema_invalid", "body must be a string");
  }
  if (!Array.isArray(input.provenance) || input.provenance.length === 0) {
    throw new ClaimError("schema_invalid", "provenance must name at least one event_id");
  }
  if (!input.provenance.every((id) => typeof id === "string" && id.length > 0)) {
    throw new ClaimError("schema_invalid", "provenance entries must be non-empty strings");
  }
  if (!isProducer(input.producer)) {
    throw new ClaimError("schema_invalid", "producer is invalid");
  }
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  ) {
    throw new ClaimError("schema_invalid", "confidence must be in [0, 1]");
  }
  if (input.predicate !== undefined && input.predicate !== null) {
    if (!isRegisteredPredicate(input.predicate)) {
      throw new ClaimError(
        "unknown_predicate",
        `predicate ${input.predicate} is not in the registry`,
      );
    }
  }
  if (input.valid_from !== undefined && !isRfc3339(input.valid_from)) {
    throw new ClaimError("schema_invalid", "valid_from must be RFC3339");
  }
  if (
    input.valid_to !== undefined &&
    input.valid_to !== null &&
    !isRfc3339(input.valid_to)
  ) {
    throw new ClaimError("schema_invalid", "valid_to must be RFC3339 or null");
  }
}

function resolveProvenance(db: Database, ids: readonly string[]): void {
  if (!tableExists(db, "events")) {
    throw new ClaimError("provenance_unresolved", "events table is missing");
  }
  const placeholders = ids.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT count(*) AS n FROM events WHERE event_id IN (${placeholders})`,
    )
    .get(...ids);
  if (row === null || row.n !== ids.length) {
    throw new ClaimError(
      "provenance_unresolved",
      "one or more event_ids do not resolve in the ledger",
    );
  }
}

function eventTaint(
  connectorId: string,
  metadataRaw: string,
): EventFacts["taint"] {
  if (connectorId === "kizuki.owner") return "owner";
  try {
    const parsed: unknown = JSON.parse(metadataRaw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as { taint?: unknown }).taint === "owner"
    ) {
      return "owner";
    }
  } catch {
    // Stored metadata is attacker-controlled; treat parse failure as untrusted.
  }
  return "untrusted";
}

function loadEventFacts(db: Database, ids: readonly string[]): EventFacts[] {
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .query<
      { event_id: string; connector_id: string; text: string; metadata: string },
      string[]
    >(
      `SELECT event_id, connector_id, text, metadata FROM events WHERE event_id IN (${placeholders})`,
    )
    .all(...ids)
    .map((row) => ({
      event_id: row.event_id,
      connector_id: row.connector_id,
      text: row.text,
      taint: eventTaint(row.connector_id, row.metadata),
    }));
}

function insertRow(db: Database, claim: Claim): void {
  db.query(
    `INSERT INTO claims
       (claim_id, kind, target, body, frontmatter, provenance, subjects,
        producer, confidence, status, created_at, body_hash,
        subject, predicate, object, polarity, claim_key, authority,
        sensitivity, taint, model_ref, valid_from, valid_to, asserted_at,
        retracted_at, superseded_by, receipt_id, corroboration, last_confirmed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    claim.claim_id,
    claim.kind,
    claim.target,
    claim.body,
    JSON.stringify(claim.frontmatter),
    JSON.stringify(claim.provenance),
    JSON.stringify(claim.subjects),
    claim.producer,
    claim.confidence,
    claim.status,
    claim.created_at,
    claim.body_hash,
    claim.subject,
    claim.predicate,
    claim.object,
    claim.polarity,
    claim.claim_key,
    claim.authority,
    claim.sensitivity,
    claim.taint,
    claim.model_ref,
    claim.valid_from,
    claim.valid_to,
    claim.asserted_at,
    claim.retracted_at,
    claim.superseded_by,
    claim.receipt_id,
    claim.corroboration,
    claim.last_confirmed_at,
  );
}

function higherAuthority(left: AuthorityTier, right: AuthorityTier): AuthorityTier {
  return AUTHORITY_TIERS[left] >= AUTHORITY_TIERS[right] ? left : right;
}

function persistClaim(db: Database, claim: Claim): void {
  db.query(
    `UPDATE claims SET
       confidence = ?, status = ?, retracted_at = ?, superseded_by = ?,
       valid_to = ?, corroboration = ?, last_confirmed_at = ?,
       authority = ?, frontmatter = ?
     WHERE claim_id = ?`,
  ).run(
    claim.confidence,
    claim.status,
    claim.retracted_at,
    claim.superseded_by,
    claim.valid_to,
    claim.corroboration,
    claim.last_confirmed_at,
    claim.authority,
    JSON.stringify(claim.frontmatter),
    claim.claim_id,
  );
}

function writeSupersession(
  db: Database,
  winner: string,
  loser: string,
  rule: ConflictRule,
  priorValidTo: string | null,
  at: string,
): void {
  db.query(
    `INSERT OR REPLACE INTO claim_supersessions
       (winner, loser, rule, prior_valid_to, receipt_id, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(winner, loser, rule, priorValidTo, winner, at);
}

function findExact(
  db: Database,
  kind: ClaimKind,
  target: string | null,
  bodyHash: string,
): Claim | null {
  const row = db
    .query<ClaimRow, [string, string, string]>(
      `SELECT * FROM claims
        WHERE kind = ? AND coalesce(target, '') = ? AND body_hash = ?`,
    )
    .get(kind, target ?? "", bodyHash);
  return row === null ? null : rowToClaim(row);
}

function liveByKey(db: Database, key: string): Claim[] {
  return db
    .query<ClaimRow, [string]>(
      `SELECT * FROM claims WHERE claim_key = ? AND status = 'live'`,
    )
    .all(key)
    .map(rowToClaim);
}

function structuralMatch(incoming: Claim, live: Claim): boolean {
  if (incoming.claim_key === null || incoming.claim_key !== live.claim_key) {
    return false;
  }
  if (incoming.polarity !== live.polarity) return false;
  if (!objectsMatch(incoming.object, live.object)) return false;
  return true;
}

function corroborate(db: Database, live: Claim, incoming: Claim, at: string): Claim {
  const next: Claim = {
    ...live,
    confidence: Math.max(live.confidence, incoming.confidence),
    corroboration: live.corroboration + 1,
    authority: higherAuthority(incoming.authority, live.authority),
    last_confirmed_at: at,
  };
  persistClaim(db, next);
  return getClaim(db, live.claim_id) ?? next;
}

function provenanceGone(db: Database, claim: Claim): boolean {
  if (!tableExists(db, "events") || claim.provenance.length === 0) return true;
  const placeholders = claim.provenance.map(() => "?").join(", ");
  const row = db
    .query<{ n: number }, string[]>(
      `SELECT count(*) AS n FROM events WHERE event_id IN (${placeholders})`,
    )
    .get(...claim.provenance);
  return row === null || row.n === 0;
}

async function nominateSemantic(
  io: ClaimsIo,
  incoming: Claim,
  mode: DedupMode,
): Promise<Claim[]> {
  if (mode !== "full" || io.retrieval === undefined) return [];
  if (await retrievalIsDegraded(io.retrieval)) return [];
  const query: RetrievalQuery = {
    text: incoming.body,
    mode: "vector",
    scope: {
      kinds: ["claim"],
      ...(incoming.subject !== null ? { subjects: [incoming.subject] } : {}),
    },
    ceiling: "private",
    limit: 20,
    deadline_ms: 5_000,
  };
  const result = await io.retrieval.search(query);
  const space = result.space ?? FIXTURE_EMBEDDING_SPACE;
  const nominated: Claim[] = [];
  for (const hit of result.hits) {
    if (hit.kind !== "claim") continue;
    if (hit.score < CLAIM_DEDUP_MIN) continue;
    const candidate = getClaim(io.db, hit.doc_id);
    if (candidate === null) continue;
    const pair = scoreClaimPair(incoming.body, candidate.body, space);
    if (pair < CLAIM_DEDUP_MIN) continue;
    nominated.push(candidate);
  }
  return nominated;
}

function retrievalDoc(claim: Claim): RetrievalDoc {
  return {
    doc_id: claim.claim_id,
    kind: "claim",
    title: claim.predicate ?? claim.kind,
    text: claim.body,
    sensitivity: claim.sensitivity,
    taint: claim.taint,
    authority: claim.authority,
    subjects: claim.subject !== null ? [claim.subject, ...claim.subjects] : claim.subjects,
    provenance: claim.provenance,
    occurred_at: claim.valid_from,
    updated_at: claim.asserted_at,
  };
}

/**
 * RFC 0002 §4.6. The operation is enqueued inside the transaction that makes
 * the claim durable, so a refresh that fails leaves a pending row the next
 * pass retries rather than an authoritative claim the index never learns
 * about. It cannot roll the claim back: canon and the ledger are the record,
 * and a derived index is disposable.
 */
function enqueueRetrieval(db: Database, io: ClaimsIo, claim: Claim, at: string): string | null {
  const store = io.retrieval?.descriptor.id;
  if (store === undefined || !tableExists(db, "retrieval_ops")) return null;
  const opId = ulid();
  db.query<never, [string, string, string, string]>(
    `INSERT INTO retrieval_ops (op_id, store, op, doc_id, state, created_at)
     VALUES (?, ?, 'upsert', ?, 'pending', ?)`,
  ).run(opId, store, claim.claim_id, at);
  return opId;
}

function finishOp(db: Database, opId: string, at: string): void {
  db.query<never, [string, string]>(
    "UPDATE retrieval_ops SET state = 'done', done_at = ? WHERE op_id = ?",
  ).run(at, opId);
}

/** Operations the refresh has not landed yet, oldest first. */
export function pendingRetrievalOps(
  db: Database,
  limit = RETRIEVAL_SWEEP_LIMIT,
): { op_id: string; doc_id: string }[] {
  if (!tableExists(db, "retrieval_ops")) return [];
  return db
    .query<{ op_id: string; doc_id: string }, [number]>(
      `SELECT op_id, doc_id FROM retrieval_ops
        WHERE state = 'pending' ORDER BY created_at, op_id LIMIT ?`,
    )
    .all(limit);
}

/**
 * Retries what the last pass could not land. Upsert is idempotent, so a
 * replay of an operation that in fact succeeded costs one write and changes
 * nothing; that is cheaper than a doc the index never learns about.
 */
export async function retryRetrievalOps(
  io: ClaimsIo,
  limit = RETRIEVAL_SWEEP_LIMIT,
): Promise<{ retried: number; pending: number }> {
  if (io.retrieval === undefined) {
    return { retried: 0, pending: pendingRetrievalOps(io.db, limit).length };
  }
  let retried = 0;
  for (const op of pendingRetrievalOps(io.db, limit)) {
    const claim = getClaim(io.db, op.doc_id);
    if (claim === null) {
      finishOp(io.db, op.op_id, nowOf(io));
      continue;
    }
    try {
      await io.retrieval.upsert([retrievalDoc(claim)]);
      finishOp(io.db, op.op_id, nowOf(io));
      retried += 1;
    } catch {
      // Still pending; the next pass tries again and doctor reports the age.
      break;
    }
  }
  return { retried, pending: pendingRetrievalOps(io.db, limit).length };
}

async function upsertRetrieval(
  io: ClaimsIo,
  claim: Claim,
  opId: string | null,
): Promise<void> {
  if (io.retrieval === undefined) return;
  try {
    await io.retrieval.upsert([retrievalDoc(claim)]);
    if (opId !== null) finishOp(io.db, opId, nowOf(io));
  } catch {
    // The claim stands and the operation stays pending: a degraded refresh
    // is not a failed write, and reporting it as one would make the caller
    // refile a claim the store already has.
  }
}

export function getClaim(db: Database, claimId: string): Claim | null {
  if (!tableExists(db, "claims")) return null;
  const row = db
    .query<ClaimRow, [string]>("SELECT * FROM claims WHERE claim_id = ?")
    .get(claimId);
  return row === null ? null : rowToClaim(row);
}

export function listClaims(
  db: Database,
  opts: {
    status?: ClaimStatus;
    claim_key?: string;
    /** Narrowed in SQL: filtering a default page in memory misses rows. */
    subject?: string;
    /** Only claims that carry a conflict key, which is what a correction retires. */
    keyed?: boolean;
    limit?: number;
  } = {},
): Claim[] {
  if (!tableExists(db, "claims")) return [];
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts.status !== undefined) {
    clauses.push("status = ?");
    params.push(opts.status);
  }
  if (opts.claim_key !== undefined) {
    clauses.push("claim_key = ?");
    params.push(opts.claim_key);
  }
  if (opts.subject !== undefined) {
    clauses.push("subject = ?");
    params.push(opts.subject);
  }
  if (opts.keyed === true) clauses.push("claim_key IS NOT NULL");
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  return db
    .query<ClaimRow, (string | number)[]>(
      `SELECT * FROM claims${where} ORDER BY created_at, claim_id LIMIT ?`,
    )
    .all(...params, limit)
    .map(rowToClaim);
}

export function listSupersessions(
  db: Database,
): { winner: string; loser: string; rule: string }[] {
  if (!tableExists(db, "claim_supersessions")) return [];
  return db
    .query<{ winner: string; loser: string; rule: string }, []>(
      "SELECT winner, loser, rule FROM claim_supersessions ORDER BY at, winner, loser",
    )
    .all();
}

export function supersessionsForReceipt(
  db: Database,
  receiptId: string,
): { winner: string; loser: string; prior_valid_to: string | null }[] {
  if (!tableExists(db, "claim_supersessions")) return [];
  return db
    .query<{ winner: string; loser: string; prior_valid_to: string | null }, [string]>(
      `SELECT winner, loser, prior_valid_to FROM claim_supersessions
        WHERE receipt_id = ? ORDER BY at, loser`,
    )
    .all(receiptId);
}

/** Undo of a write: the claim this receipt materialized is no longer live. */
export function markClaimReverted(db: Database, claimId: string, at: string): void {
  const claim = getClaim(db, claimId);
  if (claim === null) return;
  persistClaim(db, { ...claim, status: "reverted", retracted_at: at });
}

/** Undo of a write: a claim this receipt superseded is live again. */
export function reinstateClaim(
  db: Database,
  claimId: string,
  priorValidTo: string | null,
): void {
  const claim = getClaim(db, claimId);
  if (claim === null) return;
  persistClaim(db, {
    ...claim,
    status: "live",
    superseded_by: null,
    retracted_at: null,
    valid_to: priorValidTo,
  });
}

/** Undo of a revert: put a previously-reinstated loser back to superseded. */
export function resupersedeClaim(
  db: Database,
  claimId: string,
  winnerId: string,
  at: string,
  validTo: string | null,
): void {
  const claim = getClaim(db, claimId);
  if (claim === null) return;
  persistClaim(db, {
    ...claim,
    status: "superseded",
    superseded_by: winnerId,
    retracted_at: at,
    valid_to: validTo,
  });
}

/**
 * RFC 0002 §6.3 step 4: every remaining live claim in the winner's
 * `claim_key` group is superseded with R5, including those that would not
 * have conflicted under §5.2.
 */
export function supersedeLiveGroup(
  db: Database,
  winner: Claim,
  at: string,
): { claim_id: string; claim_key: string; rule: "R5" }[] {
  if (winner.claim_key === null) return [];
  const live = liveByKey(db, winner.claim_key).filter(
    (claim) => claim.claim_id !== winner.claim_id,
  );
  const out: { claim_id: string; claim_key: string; rule: "R5" }[] = [];
  for (const loser of live) {
    const prior = loser.valid_to;
    persistClaim(db, {
      ...loser,
      status: "superseded",
      superseded_by: winner.claim_id,
      retracted_at: at,
      valid_to: minTimestamp(loser.valid_to, winner.valid_from),
    });
    writeSupersession(db, winner.claim_id, loser.claim_id, "R5", prior, at);
    out.push({ claim_id: loser.claim_id, claim_key: loser.claim_key ?? winner.claim_key, rule: "R5" });
  }
  return out;
}

export function markClaimsPurged(db: Database): string[] {
  if (!tableExists(db, "claims")) return [];
  const live = listClaims(db, { status: "live" });
  const purged: string[] = [];
  const at = new Date().toISOString();
  for (const claim of live) {
    if (!provenanceGone(db, claim)) continue;
    const next: Claim = { ...claim, status: "purged", retracted_at: at };
    persistClaim(db, next);
    purged.push(claim.claim_id);
  }
  return purged;
}

export async function insertClaim(
  io: ClaimsIo,
  input: InsertClaimInput,
): Promise<InsertClaimResult> {
  assertInput(input);
  initClaims(io.db);
  resolveProvenance(io.db, input.provenance);

  const at = nowOf(io);
  const producer = canonicalizeProducer(input.producer);
  const subject = input.subject ?? input.subjects?.[0] ?? null;
  const predicate = input.predicate ?? null;
  const object = input.object ?? null;
  const polarity = input.polarity ?? "positive";
  const key =
    subject !== null && predicate !== null ? claimKey(subject, predicate) : null;
  const events = input.events ?? loadEventFacts(io.db, input.provenance);
  const hasCorroboration =
    key !== null &&
    liveByKey(io.db, key).some((live) =>
      live.provenance.some((id) => {
        const incomingConnectors = new Set(events.map((event) => event.connector_id));
        const liveFacts = loadEventFacts(io.db, live.provenance);
        return liveFacts.some((fact) => !incomingConnectors.has(fact.connector_id));
      }),
    );

  const assigned = authorityFor(
    {
      producer,
      taint: input.taint ?? "clean",
      body: input.body,
      provenance: input.provenance,
      confidence: input.confidence,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      claim_key: key,
    },
    events,
    {
      producer: input.producer,
      taint: input.taint ?? "clean",
      body: input.body,
      provenance: input.provenance,
      ...(input.intent === undefined ? {} : { intent: input.intent }),
      ...(input.relay_ceiling === undefined
        ? {}
        : { relayCeiling: input.relay_ceiling }),
      hasCorroboration,
    },
  );

  const frontmatter: Record<string, FrontmatterValue> = {
    ...(input.frontmatter ?? {}),
  };
  if (assigned.relayed_by !== null) {
    frontmatter["x-relayed-by"] = assigned.relayed_by;
  }

  const claim: Claim = {
    schema: CLAIM_SCHEMA,
    claim_id: input.claim_id ?? ulid(),
    kind: input.kind,
    target: input.target ?? null,
    subject,
    predicate,
    object,
    polarity,
    claim_key: key,
    body: input.body,
    frontmatter,
    provenance: [...input.provenance],
    subjects: [...(input.subjects ?? (subject !== null ? [subject] : []))],
    producer,
    model_ref: input.model_ref ?? null,
    authority: assigned.authority,
    confidence: assigned.confidence,
    sensitivity: input.sensitivity ?? "private",
    taint: input.taint ?? "clean",
    valid_from: input.valid_from ?? at,
    valid_to: input.valid_to ?? null,
    asserted_at: at,
    retracted_at: null,
    status: "live",
    superseded_by: null,
    receipt_id: null,
    body_hash: hashBody(input.body),
    created_at: at,
    corroboration: 1,
    last_confirmed_at: at,
  };

  let mode: DedupMode = retrievalDedupMode(io.retrieval);
  if (mode === "full" && (await retrievalIsDegraded(io.retrieval))) {
    mode = "structural-only";
  }
  const semanticNominees =
    mode === "full" ? await nominateSemantic(io, claim, mode) : [];

  let opId: string | null = null;
  const apply = io.db.transaction((): InsertClaimResult => {
    resolveProvenance(io.db, input.provenance);

    const exact = findExact(io.db, claim.kind, claim.target, claim.body_hash);
    if (exact !== null) {
      return { outcome: "duplicate", claim: exact, dedup: mode };
    }

    const structuralCandidates = [
      ...(claim.claim_key !== null ? liveByKey(io.db, claim.claim_key) : []),
      ...semanticNominees,
    ];
    const structural = structuralCandidates.find((live) =>
      structuralMatch(claim, live),
    );
    if (structural !== undefined && input.intent !== "correct") {
      return {
        outcome: "duplicate",
        claim: corroborate(io.db, structural, claim, at),
        dedup: mode,
      };
    }

    const conflicts = (claim.claim_key === null
      ? []
      : liveByKey(io.db, claim.claim_key)
    ).filter((live) =>
      claimsConflict(toConflict(claim), toConflict(live, provenanceGone(io.db, live))),
    );

    const superseded: { claim_id: string; rule: ConflictRule }[] = [];
    let incomingStatus: ClaimStatus = "live";
    let contestedAgainst: Claim | null = null;

    for (const live of conflicts) {
      const purged = provenanceGone(io.db, live);
      if (purged && live.status !== "purged") {
        persistClaim(io.db, { ...live, status: "purged", retracted_at: at });
      }
      const resolution = resolveConflict(
        toConflict(claim),
        toConflict(purged ? { ...live, status: "purged" } : live, purged),
      );
      if (resolution.action === "skip") {
        incomingStatus = "skipped";
        break;
      }
      if (resolution.action === "contested") {
        contestedAgainst = live;
        continue;
      }
      if (resolution.winner === "incoming") {
        const prior = live.valid_to;
        persistClaim(io.db, {
          ...live,
          status: "superseded",
          superseded_by: claim.claim_id,
          retracted_at: at,
          valid_to: minTimestamp(live.valid_to, claim.valid_from),
        });
        writeSupersession(io.db, claim.claim_id, live.claim_id, resolution.rule, prior, at);
        superseded.push({ claim_id: live.claim_id, rule: resolution.rule });
      } else {
        incomingStatus = "skipped";
        break;
      }
    }

    const stored: Claim = { ...claim, status: incomingStatus };
    insertRow(io.db, stored);
    if (incomingStatus !== "skipped") {
      opId = enqueueRetrieval(io.db, io, stored, at);
    }

    if (incomingStatus === "skipped") {
      return {
        outcome: "skipped",
        reason: "below_authority",
        claim: stored,
        dedup: mode,
      };
    }
    if (contestedAgainst !== null) {
      return {
        outcome: "contested",
        incoming: stored,
        live: contestedAgainst,
        dedup: mode,
      };
    }
    return { outcome: "stored", claim: stored, dedup: mode, superseded };
  });

  const result = apply();

  if (result.outcome === "stored" || result.outcome === "contested") {
    const stored = result.outcome === "stored" ? result.claim : result.incoming;
    await upsertRetrieval(io, stored, opId);
  }
  // A refile that deduped still drains what an earlier failure left behind.
  await retryRetrievalOps(io);

  return result;
}

export async function semanticDuplicates(
  io: ClaimsIo,
  incoming: Claim,
): Promise<Claim[]> {
  const mode = retrievalDedupMode(io.retrieval);
  const nominated = await nominateSemantic(io, incoming, mode);
  return nominated.filter((candidate) => {
    if (incoming.claim_key === null) return false;
    return candidate.claim_key === incoming.claim_key;
  });
}

export { normalizeObject };
