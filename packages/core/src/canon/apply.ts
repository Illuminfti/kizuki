import { completedEventPurgeProofs } from "../ledger/purge";
import { sha256Hex } from "../util/hash";
import { selectWorldMaterialization, worldClaimHandle, worldCanonPath, assertWorldBasis } from "./world-materialization";
import { eraseWorldReceipt, isWorldCanonReceipt, type RetainedWorldCanonReceipt, type WorldCanonBasis } from "./world-receipt";
import { isErasedReceipt, rowToReceiptRecord, type CanonReceiptRow, latestReceiptForPage } from "./receipts";
import { stageSourceErasureIntent, readSourceErasureIntent, appendSourceErasureReceipt, isLiveSourceSurvivorPath, isLiveSourceSurvivorReceipt, type SourceErasureIntent } from "./source-erasure-intent";
import {
  getSourceSurvivorLineage,
  insertSourceSurvivorLineage,
} from "../ledger/canon-source-survivor-lineage";
import { parseFrontmatter, serializePage } from "../vault/frontmatter";
import { commitWorldCanonErasure, commitCanonWrite } from "./recovery";
import { worldErasureFinalReceipt, assertCanonAdmission, canonPageRecoveryPending, decodeCanonImage, readCanonWriteIntent, recoveryFailure, type WorldCanonErasureIntent, type CanonWriteIntent } from "./write-intent";
import { archiveRelPath, hashBytes, ABSENT_PAGE_HASH } from "../vault/write";
import { requireSourceEvents, sourceSensitivity } from "../ledger/source-grants";
import { commitMachineByteIntent, requireExternalEvents } from "../ledger/event-origin";
import { requireSourceTombstoneProposal, requiresSourceTombstoneBinding, SourceTombstoneError } from "./source-tombstone";
import { subjectPageType } from "../vault/subject-type";
import { CanonAuthorityResolver } from "./authority";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Sensitivity } from "../agents/types";
import { SENSITIVITY_ORDER } from "../agents/types";
import { getClaim } from "../claims/store";
import type {
  AuthorityTier,
  Claim,
  ClaimTaint,
  FrontmatterValue,
} from "../contracts/proposal";
import { AUTHORITY_TIERS } from "../contracts/proposal";
import { tableExists } from "../ledger/schema";
import { eventIdFromReference } from "../retrieval/ids";
import { refreshDerivedPage, removeDerivedPage } from "../derived";
import type { VaultPage } from "../vault/frontmatter";
import type { CanonPage } from "../vault/pages";
import { PAGE_TYPES, validatePage } from "../vault/schema";
import { grantCanonWrite, isWriter, writePage } from "../vault/write";
import type { Writer } from "../vault/write";
import { assertPageRelPath, assertReceiptPaths, assertStoredPageRelPath } from "./paths";
import { cloneExactJson } from "../util/validate";
import type { TargetDecision } from "./arbiter";
import { chargeCanonWrite, type BudgetTracker } from "./budget";
import { CanonWriteError } from "./errors";
import { getCanonReceipt, type CanonReceipt, type PageAction, type RetrievalOpRef } from "./receipts";
import { initCanon } from "./schema";
import { readOwnedCanonPage, requireCanonFiles, snapshotCanonIo, withCanonMutationSync } from "./io";
import { assertVaultMutationScope, VaultMutationError, type VaultMutationScope } from "../vault/mutation-scope";
import {
  CanonPageUnreadable,
  insertReceiptRow,
  mintId,
  nowOf,
  readPage,
  upsertPageIndex,
} from "./store";
import type { CanonIo, ExistingPage } from "./store";

export interface ApplyCanonWriteOptions {
  writer: Writer;
  budget: BudgetTracker;
}

/** Set by the writer; a producer that supplies one is refused (§4.4). */
const RESERVED_KEYS = ["id", "status", "sensitivity", "sources", "taint"] as const;
const MAX_CLAIMS_PER_WRITE = 64;
const MAX_PAGE_CLAIMS = 256;

interface Prepared {
  page: VaultPage;
  action: PageAction;
  taint: ClaimTaint;
  sensitivity: Sensitivity;
}

function isSensitivity(value: unknown): value is Sensitivity {
  return typeof value === "string" && value in SENSITIVITY_ORDER;
}

function strictest(values: readonly Sensitivity[]): Sensitivity {
  let strictestSoFar: Sensitivity = "public";
  for (const value of values) {
    if (SENSITIVITY_ORDER[value] > SENSITIVITY_ORDER[strictestSoFar]) strictestSoFar = value;
  }
  return strictestSoFar;
}

function lowestAuthority(claims: readonly Claim[]): AuthorityTier {
  let lowest: AuthorityTier = "owner_correction";
  for (const claim of claims) {
    if (AUTHORITY_TIERS[claim.authority] < AUTHORITY_TIERS[lowest]) lowest = claim.authority;
  }
  return lowest;
}

function meanConfidence(claims: readonly Claim[]): number {
  const total = claims.reduce((sum, claim) => sum + claim.confidence, 0);
  return Math.round((total / claims.length) * 1e4) / 1e4;
}

function union(lists: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const item of list) {
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * Claim prose is joined on one line when every body is a single line, and as
 * paragraphs otherwise, so a page's body stays readable Markdown either way.
 */
function composeBody(claims: readonly Claim[]): string {
  const bodies = claims.map((claim) => claim.body.trim()).filter((body) => body.length > 0);
  const separator = bodies.some((body) => body.includes("\n")) ? "\n\n" : " ";
  return `${bodies.join(separator)}\n`;
}

function assertBatch(claims: readonly Claim[], typed = false): Claim {
  const primary = claims[0];
  if (primary === undefined) {
    throw new CanonWriteError("nothing_to_write", "a canon write needs at least one claim");
  }
  if (claims.length > MAX_CLAIMS_PER_WRITE) {
    throw new CanonWriteError(
      "batch_too_large",
      `a canon write takes at most ${MAX_CLAIMS_PER_WRITE} claims`,
    );
  }
  for (const claim of claims) {
    if (!typed && (claim.producer !== primary.producer || claim.model_ref !== primary.model_ref)) {
      throw new CanonWriteError("batch_mismatch", "one write, one producer and model reference");
    }
    if (!typed && claim.target !== primary.target && (claim.subject === null || claim.subject !== primary.subject)) {
      throw new CanonWriteError("batch_mismatch", "every claim in a write shares the target or the subject");
    }
    if (!typed && claim.kind !== primary.kind) {
      throw new CanonWriteError("batch_mismatch", "every claim in a write shares one kind");
    }
    for (const reserved of RESERVED_KEYS) {
      if (reserved in claim.frontmatter) {
        throw new CanonWriteError(
          "frontmatter_reserved",
          `frontmatter: ${reserved} is set by the writer, not by the producer`,
        );
      }
    }
  }
  return primary;
}

function mergedFrontmatter(claims: readonly Claim[]): Record<string, FrontmatterValue> {
  const merged: Record<string, FrontmatterValue> = {};
  for (const claim of claims) {
    for (const key of Object.keys(claim.frontmatter)) {
      const value = claim.frontmatter[key] as FrontmatterValue;
      if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) {
        throw new CanonWriteError("frontmatter_conflict", `frontmatter: ${key} differs across the write`);
      }
      merged[key] = value;
    }
  }
  return merged;
}

function assertPageType(data: Record<string, unknown>): void {
  const raw = data["type"];
  if (typeof raw !== "string" || !(PAGE_TYPES as readonly string[]).includes(raw)) {
    throw new CanonWriteError(
      "page_type_invalid",
      `frontmatter.type: must be one of ${PAGE_TYPES.join(" | ")}`,
    );
  }
}

function existingSources(page: VaultPage): string[] {
  const raw = page.data["sources"];
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) {
    throw new CanonWriteError("decision_stale", "existing page sources must be a string array");
  }
  return raw;
}

/** Ignore lifecycle updates while binding every producer-supplied field to storage. */
function claimContent(claim: Claim): Omit<Claim,
  "status" | "receipt_id" | "superseded_by" | "retracted_at" | "valid_to" |
  "corroboration" | "last_confirmed_at"> {
  const { status, receipt_id, superseded_by, retracted_at, valid_to,
    corroboration, last_confirmed_at, ...content } = claim;
  return content;
}

function persistedClaims(io: CanonIo, claims: readonly Claim[], allowWritten = false): Claim[] {
  return claims.map((claim) => {
    const stored = getClaim(io.db, claim.claim_id);
    if (stored === null) {
      throw new CanonWriteError("claim_unknown", `claim ${claim.claim_id} is not in the claims table`);
    }
    if (!isDeepStrictEqual(claimContent(stored), claimContent(claim))) {
      throw new CanonWriteError("claim_mismatch", `claim ${claim.claim_id} differs from its stored row`);
    }
    if (stored.status !== "live") {
      throw new CanonWriteError("claim_not_live", `claim ${claim.claim_id} is ${stored.status}`);
    }
    if (!allowWritten && stored.receipt_id !== null) {
      throw new CanonWriteError("decision_stale", `claim ${claim.claim_id} was already written`);
    }
    return stored;
  });
}

function assertProvenance(io: CanonIo, provenance: readonly string[]): void {
  requireSourceEvents(io.db, provenance, { owner: true, purpose: "derive" });
  if (provenance.length === 0 || !tableExists(io.db, "events")) {
    throw new CanonWriteError("provenance_unresolved", "a canon write needs provenance that resolves");
  }
  const placeholders = provenance.map(() => "?").join(", ");
  const row = io.db
    .query<{ n: number }, string[]>(
      `SELECT count(*) AS n FROM events WHERE event_id IN (${placeholders})`,
    )
    .get(...provenance);
  if (row === null || row.n !== provenance.length) {
    throw new CanonWriteError(
      "provenance_unresolved",
      "provenance: one or more event_ids do not resolve in the ledger",
    );
  }
}

/** Live create-kind claims already materialized on this page, oldest first. */
function liveClaimsOnPage(io: CanonIo, relPath: string, exclude: ReadonlySet<string>): Claim[] {
  const ids = io.db
    .query<{ claim_id: string }, [string, number]>(
      `SELECT c.claim_id AS claim_id
         FROM claims c JOIN canon_receipts r ON r.receipt_id = c.receipt_id
        WHERE r.page_path = ? AND c.status = 'live' AND c.kind IN ('entity', 'claim')
        ORDER BY c.created_at, c.claim_id LIMIT ?`,
    )
    .all(relPath, MAX_PAGE_CLAIMS);
  const claims: Claim[] = [];
  for (const { claim_id } of ids) {
    if (exclude.has(claim_id)) continue;
    const claim = getClaim(io.db, claim_id);
    if (claim !== null) claims.push(claim);
  }
  return claims;
}

function targetOf(decision: TargetDecision): { rel_path: string; page_id: string | null } {
  const target = ((): { rel_path: string; page_id: string | null } => {
    switch (decision.action) {
      case "create":
        return { rel_path: decision.rel_path, page_id: null };
      case "edit":
      case "supersede":
        return { rel_path: decision.rel_path, page_id: decision.page_id };
      case "conflict":
        return { rel_path: decision.chosen.rel_path, page_id: decision.chosen.page_id };
      case "skip":
        throw new CanonWriteError("nothing_to_write", `decision skipped: ${decision.reason}`);
    }
  })();
  assertPageRelPath(target.rel_path);
  if (target.page_id !== null && target.page_id.length === 0) {
    throw new CanonWriteError("decision_stale", "decision names an empty page id");
  }
  return target;
}

function prepareCreate(
  claims: readonly Claim[],
  pageId: string,
  provenance: readonly string[],
  ambiguous: boolean,
): Prepared {
  const extra = mergedFrontmatter(claims);
  const sensitivity = strictest(claims.map((claim) => claim.sensitivity));
  const taint: ClaimTaint = claims.some((claim) => claim.taint === "quoted") ? "quoted" : "clean";
  const subject = claims[0]?.subject ?? null;
  const data: Record<string, unknown> = {
    id: pageId,
    type: extra["type"] ?? (subject === null ? undefined : subjectPageType(subject)),
    ...(extra["title"] === undefined && subject !== null
      ? { title: subject.slice(subject.indexOf(":") + 1) } : {}),
    status: "active",
    sensitivity,
    taint,
    sources: [...provenance],
  };
  assertPageType(data);
  for (const key of Object.keys(extra).sort()) {
    if (key === "type") continue;
    data[key] = extra[key];
  }
  if (subject !== null && !("x-subject-id" in extra)) data["x-subject-id"] = subject;
  if (ambiguous) data["x-ambiguous"] = true;
  return { page: { data, body: composeBody(claims) }, action: "create", taint, sensitivity };
}

function prepareRevision(
  io: CanonIo,
  claims: readonly Claim[],
  primary: Claim,
  existing: ExistingPage,
  decision: TargetDecision,
  provenance: readonly string[],
): Prepared {
  const extra = mergedFrontmatter(claims);
  const data: Record<string, unknown> = { ...existing.page.data };
  for (const key of Object.keys(extra).sort()) {
    if (key === "type") continue;
    data[key] = extra[key];
  }
  assertPageType(data);

  const priorSensitivity = existing.page.data["sensitivity"];
  const sensitivity = strictest([
    ...claims.map((claim) => claim.sensitivity),
    ...(isSensitivity(priorSensitivity) ? [priorSensitivity] : []),
  ]);
  const priorTaint: ClaimTaint = existing.page.data["taint"] === "quoted" ? "quoted" : "clean";
  const incomingTaint: ClaimTaint = claims.some((claim) => claim.taint === "quoted") ? "quoted" : "clean";
  const prior = existingSources(existing.page);

  let body: string;
  let taint: ClaimTaint = incomingTaint;
  const sources: string[] = union([prior, provenance]);
  let action: PageAction = "edit";

  switch (primary.kind) {
    case "edit":
      body = composeBody(claims);
      break;
    case "merge":
      body = `${existing.page.body.trimEnd()}\n\n${composeBody(claims)}`;
      taint = priorTaint === "quoted" ? "quoted" : incomingTaint;
      break;
    case "deletion":
      body = existing.page.body;
      taint = priorTaint;
      data["status"] = "archived";
      action = "archive";
      break;
    case "purge_review":
      throw new CanonWriteError("claim_kind_retired", "purge_review cannot authorize an ordinary canon write");
    default: {
      const exclude = new Set<string>([
        ...claims.map((claim) => claim.claim_id),
        ...(decision.action === "supersede" ? decision.superseded : []),
      ]);
      const retained = liveClaimsOnPage(io, existing.relPath, exclude);
      body = composeBody([...retained, ...claims]);
      taint = [...retained, ...claims].some((claim) => claim.taint === "quoted") ? "quoted" : "clean";
      break;
    }
  }

  data["sensitivity"] = sensitivity;
  data["taint"] = taint;
  data["sources"] = sources;
  if (
    decision.action === "supersede" ||
    claims.some((claim) => claim.authority === "owner_correction")
  ) {
    delete data["x-contested"];
  }
  if (decision.action === "conflict") data["x-ambiguous"] = true;
  return { page: { data, body }, action, taint, sensitivity };
}

function supersededRefs(io: CanonIo, decision: TargetDecision): CanonReceipt["superseded"] {
  if (decision.action !== "supersede") return [];
  return decision.superseded.map((claimId) => {
    const loser = getClaim(io.db, claimId);
    if (loser === null || loser.claim_key === null) {
      throw new CanonWriteError("decision_stale", `superseded claim ${claimId} has no conflict key`);
    }
    return { claim_id: claimId, claim_key: loser.claim_key };
  });
}

/** The single writer journals intent before bytes and completes one exact receipt. */
export function applyCanonWrite(
  io: CanonIo,
  claim: Claim | readonly Claim[],
  decision: TargetDecision,
  opts: ApplyCanonWriteOptions,
): CanonReceipt {
  if (io.db.inTransaction) recoveryFailure("nested_transaction");
  io = snapshotCanonIo(io);
  try {
    return withCanonMutationSync(io, (scope, owned) => applyCanonWriteOwned(scope, owned, claim, decision, opts));
  } catch (error) {
    if (error instanceof VaultMutationError && error.code === "writer_busy") {
      throw new CanonWriteError("writer_busy", "canon writer is busy; retry the write");
    }
    throw error;
  }
}

/** Internal nested entry: the enclosing operation owns files through receipt completion. */
export function applyCanonWriteOwned(
  scope: VaultMutationScope,
  io: CanonIo,
  claim: Claim | readonly Claim[],
  decision: TargetDecision,
  opts: ApplyCanonWriteOptions,
): CanonReceipt {
  if (io.db.inTransaction) recoveryFailure("nested_transaction");
  io = snapshotCanonIo(io);
  requireCanonFiles(scope, io);
  claim = snapshotByteInput(claim);
  decision = snapshotByteInput(decision);
  opts = Object.freeze({ writer: opts.writer, budget: opts.budget });
  if (!isWriter(opts.writer)) {
    throw new CanonWriteError("writer_invalid", "writer must be loop, correction, revert or import");
  }
  if (readCanonWriteIntent(io.db) !== null) recoveryFailure("recovery_pending");
  const supplied: Claim[] = Array.isArray(claim) ? [...(claim as readonly Claim[])] : [claim as Claim];
  const target = targetOf(decision);
  if (canonPageRecoveryPending(io.db, target.rel_path)) recoveryFailure("projection_pending");
  const typedFlags = supplied.map(item => io.db.query<{is_world_typed:number},[string]>("SELECT is_world_typed FROM claims WHERE claim_id=?").get(item.claim_id)?.is_world_typed === 1);
  const typed = typedFlags.some(Boolean);
  if (typed && !typedFlags.every(Boolean)) throw new CanonWriteError("batch_mismatch", "typed and legacy claims require separate writes");
  assertBatch(supplied, typed);
  const persisted = persistedClaims(io, supplied, typed);
  const primary = assertBatch(persisted, typed);
  let claims: readonly Claim[] = persisted;
  const handle = typed ? worldClaimHandle(io.db, primary.claim_id) : null;
  const materialization = handle === null ? null : selectWorldMaterialization(io.db, handle);
  if (typed) {
    if (handle === null || materialization === null || target.rel_path !== worldCanonPath(handle) || persisted.some(item => worldClaimHandle(io.db,item.claim_id) !== handle || !materialization.basis.some(basis => basis.claim_id === item.claim_id))) throw new CanonWriteError("decision_stale", "typed canon requires its exact admitted world handle");
    claims = materialization.claims;
  }
  // Historical rows remain readable, but only the dedicated purge pipeline can rewrite holds.
  if (primary.kind === "purge_review") {
    throw new CanonWriteError("claim_kind_retired", "purge_review cannot authorize an ordinary canon write");
  }

  const existing = readPage(io, target.rel_path);
  const pageId = target.page_id ?? mintId(io);
  const receiptId = mintId(io);
  initCanon(io.db);
  const ownedClaims=typed?claims.filter(item=>item.receipt_id===null):persisted;
  const outputProvenance = union(claims.map((item) => item.provenance));
  const provenance = typed ? union([outputProvenance, ...(existing === null ? [] : [existingSources(existing.page)])]) : outputProvenance;
  let worldBasis: WorldCanonBasis | null = null;
  if (typed && materialization !== null) {
    const previous = existing === null ? null : latestReceiptForPage(io.db,target.rel_path);
    if (existing !== null && (previous === null || !isWorldCanonReceipt(previous) || previous.after_hash !== existing.hash)) throw new CanonWriteError("decision_stale", "typed canon predecessor is not recorded");
    worldBasis = {schema:"kizuki.world-canon-basis/v1",before:previous !== null && isWorldCanonReceipt(previous) ? previous.basis.after : null,after:materialization.basis};
    assertWorldBasis(io.db,worldBasis.before,true);assertWorldBasis(io.db,worldBasis.after);
  }
  assertProvenance(io, provenance);

  if (decision.action === "create" && existing !== null) {
    throw new CanonWriteError("page_exists", `page ${target.rel_path} already exists`);
  }
  if (decision.action !== "create") {
    if (existing === null) {
      throw new CanonWriteError("page_missing", `page ${target.rel_path} is gone`);
    }
    if (existing.page.data["id"] !== target.page_id) {
      throw new CanonWriteError("decision_stale", `page ${target.rel_path} changed identity`);
    }
  }

  const prepared =
    typed && materialization !== null
      ? {...prepareCreate(materialization.claims.map(item => ({...item,frontmatter:{type:materialization.pageType,title:materialization.title}})), pageId, outputProvenance, false), action: existing === null ? "create" as const : "edit" as const}
      : existing === null
      ? prepareCreate(claims, pageId, provenance, decision.action === "conflict")
      : prepareRevision(io, claims, primary, existing, decision, provenance);
  const invalid = validatePage(prepared.page.data);
  if (invalid.length > 0) {
    throw new CanonWriteError("frontmatter_invalid", invalid[0] ?? "invalid page");
  }
  requireSourceEvents(io.db, Array.isArray(prepared.page.data["sources"]) ? prepared.page.data["sources"].filter((id): id is string => typeof id === "string") : [], { owner: true, purpose: "derive" });
  prepared.sensitivity = sourceSensitivity(io.db, provenance, prepared.sensitivity);
  prepared.page.data["sensitivity"] = prepared.sensitivity;
  const superseded = typed ? io.db.query<{claim_id:string;claim_key:string},[string]>("SELECT s.loser AS claim_id,m.semantic_key AS claim_key FROM claim_supersessions s JOIN claim_v2_semantics m ON m.claim_id=s.loser WHERE s.winner IN (SELECT value FROM json_each(?)) ORDER BY s.loser").all(JSON.stringify(ownedClaims.map(item=>item.claim_id))) : supersededRefs(io, decision);
  const retrievalOps: RetrievalOpRef[] =
    io.retrieval_store === undefined
      ? []
      : [{ store: io.retrieval_store, op: "upsert", doc: `page:${pageId}` }];

  const expectedAfter = hashBytes(Buffer.from(serializePage(prepared.page)));
  const admit = (): void => {
    persistedClaims(io, persisted, typed);
    if (worldBasis !== null) { assertWorldBasis(io.db,worldBasis.before,true);assertWorldBasis(io.db,worldBasis.after); }
    assertProvenance(io, provenance);
    requireSourceEvents(io.db, existingSources(prepared.page), { owner: true, purpose: "derive" });
    if (sourceSensitivity(io.db, provenance, prepared.sensitivity) !== prepared.page.data["sensitivity"]) {
      throw new CanonWriteError("decision_stale", "source sensitivity changed before byte admission");
    }
    const sourceDeletion = claims.some((item) => requiresSourceTombstoneBinding(io.db, item));
    if (sourceDeletion) {
      for (const item of claims) requireSourceTombstoneProposal(io.db, item, io);
      if (existing === null || prepared.action !== "archive" ||
          primary.target !== target.rel_path.replace(/\.md$/, "") ||
          prepared.page.body !== existing.page.body ||
          primary.frontmatter["x-page-id"] !== pageId || primary.frontmatter["x-page-hash"] !== existing.hash) {
        throw new SourceTombstoneError("source_tombstone_stale");
      }
    }
    if (!sourceDeletion && !typed) requireExternalEvents(io.db, union([provenance, existingSources(prepared.page)]));
    if (existing !== null && new CanonAuthorityResolver(io.db, [target.rel_path]).basis(target.rel_path, existing.hash) === null) recoveryFailure("historical_orphan");
  };
  const receipt: CanonReceipt = {
    receipt_id: receiptId,
    kind: "write",
    claim_ids: ownedClaims.map((item) => item.claim_id),
    page_path: target.rel_path,
    page_action: prepared.action,
    before_hash: existing?.hash ?? null,
    after_hash: expectedAfter,
    archive_path: existing === null ? null : archiveRelPath(target.rel_path, receiptId),
    writer: opts.writer,
    producer: typed ? "deterministic" : primary.producer,
    model_ref: typed ? null : primary.model_ref,
    authority: lowestAuthority(claims),
    confidence: meanConfidence(claims),
    sensitivity: prepared.sensitivity,
    taint: prepared.taint,
    provenance,
    superseded,
    candidates: decision.action === "conflict" ? decision.candidates : [],
    retrieval_ops: retrievalOps,
    reverts: null,
    reverted_by: null,
    at: nowOf(io),
    ...(worldBasis === null ? {} : {schema:"kizuki.canon-receipt/v2",state:"retained",own_id_origin:"core",basis:worldBasis}),
  };

  const priorSubject = existing?.page.data["x-subject-id"];
  return commitCanonWrite(scope, io, {
    receipt, before: existing === null ? null : Buffer.from(existing.content), after: Buffer.from(serializePage(prepared.page)),
    completion: { mode: "write", claim_kind: primary.kind, page_id: pageId,
      subject_key: primary.subject ?? (typeof priorSubject === "string" ? priorSubject : null), original_receipt_id: null },
  }, admit, () => chargeCanonWrite(io, opts.budget, {
    receipt_id: receiptId, page_path: target.rel_path, before_hash: existing?.hash ?? null, at: receipt.at,
  }));
}

function canonPageFromWrite(
  vaultPath: string,
  relPath: string,
  pageId: string,
  page: VaultPage,
  contentHash: string,
): CanonPage {
  return {
    id: pageId,
    path: join(vaultPath, relPath),
    relPath,
    data: page.data,
    body: page.body,
    contentHash,
  };
}

function snapshotByteInput<T>(input: T): T {
  const errors: string[] = [];
  const snapshot = cloneExactJson(input, "canon byte input", {
    maxDepth: 32, maxKeysPerObject: 1024, maxArrayLength: 1_000_000,
    maxStringBytes: 16 * 1024 * 1024, maxKeyBytes: 1024, maxTotalBytes: 128 * 1024 * 1024,
  }, errors);
  if (snapshot === undefined) throw new CanonWriteError("target_invalid", "canon byte input must be stable JSON data");
  return snapshot as T;
}

export interface PurgeRewriteInput {
  rel_path: string;
  purged_event_ids: readonly string[];
  purged_claim_ids: readonly string[];
  purged_claim_bodies: readonly string[];
  /** Internal, hash-qualified native source erasure. Null deletes an entirely attributed page. */
  source_erasure?: {
    expected_hash: string;
    source_key: string;
    page: VaultPage | null;
    retained_claim_ids: readonly string[];
  };
}

function redactBody(body: string, fragments: readonly string[]): string {
  let next = body;
  for (const fragment of fragments) {
    const trimmed = fragment.trim();
    if (trimmed.length === 0) continue;
    next = next.split(trimmed).join("");
  }
  const cleaned = next
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length === 0 ? "" : `${cleaned}\n`;
}

/**
 * Same-pass purge rewrite (RFC 0002 §13.1 phase 3). Mints a loop capability
 * and calls `writePage` here so the capability scan still holds. There is no
 * owner review queue: the hold lifts when this receipt lands.
 */
export function applyPurgeRewrite(
  scope: VaultMutationScope,
  io: CanonIo,
  input: PurgeRewriteInput,
): CanonReceipt {
  io = snapshotCanonIo(io);
  const files = requireCanonFiles(scope, io);
  input = snapshotByteInput(input);
  if (input.source_erasure === undefined) assertPageRelPath(input.rel_path);
  else assertStoredPageRelPath(input.rel_path);
  if (io.db.inTransaction) throw new Error("loop byte admission requires a top-level transaction");
  initCanon(io.db);
  let existing: ExistingPage | null;
  try {
    existing = readPage(io, input.rel_path);
  } catch (error) {
    if (error instanceof CanonPageUnreadable) {
      throw new CanonWriteError("decision_stale", `page ${input.rel_path} is unreadable`);
    }
    throw error;
  }
  const typedErasure=applyWorldPurgeRewrite(scope,io,input,existing);
  if(typedErasure!==null)return typedErasure;
  if (existing === null) {
    throw new CanonWriteError("page_missing", `page ${input.rel_path} is gone`);
  }

  if (input.source_erasure !== undefined) {
    const owned = readOwnedCanonPage(io, input.rel_path);
    if (owned === null || owned.hash !== existing.hash) {
      throw new CanonWriteError("decision_stale", "source erasure preimage changed");
    }
    if (
      existing.hash !== input.source_erasure.expected_hash ||
      input.purged_event_ids.length === 0 ||
      input.purged_event_ids.some(
        (id) =>
          io.db
            .query(
              "SELECT 1 FROM source_event_bindings b JOIN source_grants g ON g.source_key=b.source_key WHERE b.event_id=? AND g.status!='active'",
            )
            .get(id) === null,
      )
    )
      throw new CanonWriteError(
        "decision_stale",
        "source erasure is not authorized for this revision",
      );
  }
  const resolver = new CanonAuthorityResolver(io.db, [input.rel_path]);
  let authority: AuthorityTier;
  if (
    input.source_erasure?.page !== undefined &&
    input.source_erasure.page !== null
  ) {
    const retained = input.source_erasure.retained_claim_ids.map((id) =>
      getClaim(io.db, id),
    );
    if (
      retained.length === 0 ||
      retained.some(
        (claim) =>
          claim === null || input.purged_claim_ids.includes(claim.claim_id),
      )
    )
      throw new CanonWriteError(
        "decision_stale",
        "retained source claims are unavailable",
      );
    if (
      isLiveSourceSurvivorPath(input.rel_path) &&
      resolver.basis(input.rel_path, existing.hash) === null
    ) {
      throw new CanonWriteError(
        "decision_stale",
        "source erasure origin has no positive basis",
      );
    }
    authority = retained.reduce(
      (tier, claim) =>
        AUTHORITY_TIERS[claim!.authority] < AUTHORITY_TIERS[tier]
          ? claim!.authority
          : tier,
      retained[0]!.authority,
    );
    requireSourceEvents(io.db, existingSources(input.source_erasure.page), {
      owner: true,
      purpose: "derive",
    });
  } else {
    authority = resolver.resolve(input.rel_path, existing.hash);
  }
  const prior = existingSources(existing.page);
  const purgedEvents = new Set(input.purged_event_ids.map(eventIdFromReference));
  const remainingSources = prior.filter(
    (source) => !purgedEvents.has(eventIdFromReference(source)),
  );
  const body =
    input.source_erasure === undefined
      ? redactBody(existing.page.body, input.purged_claim_bodies)
      : (input.source_erasure.page?.body ?? "");
  const nothingRemains =
    input.source_erasure === undefined
      ? remainingSources.length === 0 && body.trim().length === 0
      : input.source_erasure.page === null;
  const action: PageAction = nothingRemains ? "archive" : "edit";
  const data: Record<string, unknown> = {
    ...(input.source_erasure === undefined
      ? existing.page.data
      : (input.source_erasure.page?.data ?? existing.page.data)),
  };
  data["sources"] =
    input.source_erasure === undefined
      ? remainingSources
      : (input.source_erasure.page?.data["sources"] ?? []);
  if (nothingRemains) data["status"] = "archived";

  const priorSensitivity = existing.page.data["sensitivity"];
  const sensitivity = isSensitivity(priorSensitivity)
    ? priorSensitivity
    : "private";
  const taint: ClaimTaint =
    existing.page.data["taint"] === "quoted" ? "quoted" : "clean";
  data["sensitivity"] = sensitivity;
  data["taint"] = taint;

  if (input.source_erasure !== undefined) return applySourcePurgeWrite(scope, io,
    {...input,source_erasure:input.source_erasure},
    {existing,data,body,nothingRemains,action,authority,sensitivity,taint});
  if (canonPageRecoveryPending(io.db, input.rel_path)) recoveryFailure("projection_pending");
  const receiptId = mintId(io);
  const next = { data, body: body.length === 0 ? "\n" : body };
  const expectedAfter = hashBytes(Buffer.from(serializePage(next)));
  const pageIdRaw = existing.page.data["id"];
  const pageId =
    typeof pageIdRaw === "string" && pageIdRaw.length > 0 ? pageIdRaw : null;
  const retrievalOps: RetrievalOpRef[] =
    io.retrieval_store === undefined || pageId === null
      ? []
      : [{ store: io.retrieval_store, op: "remove", doc: `page:${pageId}` }];

  const receipt: CanonReceipt = {
    receipt_id: receiptId,
    kind: "purge_rewrite",
    claim_ids: [...input.purged_claim_ids],
    page_path: input.rel_path,
    page_action: action,
    before_hash: existing.hash,
    after_hash: expectedAfter,
    archive_path: archiveRelPath(input.rel_path, receiptId),
    writer: "loop",
    producer: "deterministic",
    model_ref: null,
    authority,
    confidence: 1,
    sensitivity,
    taint,
    provenance: [...input.purged_event_ids],
    superseded: [],
    candidates: [],
    retrieval_ops: retrievalOps,
    reverts: null,
    reverted_by: null,
    at: nowOf(io),
  };

  const retainedSubject = data["x-subject-id"];
  return commitCanonWrite(scope, io, {
    receipt, before: Buffer.from(existing.content), after: Buffer.from(serializePage(next)),
    completion: { mode: "purge", claim_kind: "purge_review", page_id: pageId,
      subject_key: typeof retainedSubject === "string" ? retainedSubject : null, original_receipt_id: null },
  }, () => requireSourceEvents(io.db, existingSources(next).map(eventIdFromReference), { owner: true, purpose: "derive" }));
}

/** Rebuild typed pages from independent admitted support; erase both receipt images on source loss. */
function applyWorldPurgeRewrite(scope:VaultMutationScope,io:CanonIo,input:PurgeRewriteInput,existing:ExistingPage|null):CanonReceipt|null {
  const rows=io.db.query<CanonReceiptRow,[string]>("SELECT * FROM canon_receipts WHERE page_path=? AND record_codec='kizuki.canon-receipt/v2' ORDER BY receipt_id LIMIT 8193").all(input.rel_path);
  if(rows.length===0)return null;
  if(rows.length>8192)throw new CanonWriteError("batch_too_large","typed canon history exceeds erasure bound");
  const records=rows.map(rowToReceiptRecord);
  if(records.some(record=>isErasedReceipt(record)||!isWorldCanonReceipt(record)))throw new CanonWriteError("decision_stale","typed canon history is not retained");
  const retained=records as RetainedWorldCanonReceipt[];
  const latest=latestReceiptForPage(io.db,input.rel_path);
  if(latest===null||!isWorldCanonReceipt(latest)||latest.after_hash!==(existing?.hash??ABSENT_PAGE_HASH))throw new CanonWriteError("decision_stale","typed canon preimage has no current receipt");
  const match=/^auto\/world\/([0-9a-f]{32})\.md$/.exec(input.rel_path);
  const proof=completedEventPurgeProofs(io.db,input.purged_event_ids.map(eventIdFromReference));
  if(match===null||proof===null||proof.length===0)throw new CanonWriteError("decision_stale","typed erasure requires completed event purge proofs");
  const purged=new Set(proof.map(item=>item.event_id));
  const affected=retained.filter(record=>record.provenance.some(id=>purged.has(eventIdFromReference(id))));
  if(affected.length===0)throw new CanonWriteError("decision_stale","typed erasure lacks attributed receipts");
  const materialization=existing===null?null:selectWorldMaterialization(io.db,match[1]!);
  const claims=materialization?.claims??[],sources=union(claims.map(claim=>claim.provenance));
  const pageId=existing?.page.data["id"]??null;
  if(existing!==null&&(typeof pageId!=="string"||pageId.length===0))throw new CanonWriteError("decision_stale","typed canon identity missing");
  const prepared=materialization===null?null:prepareCreate(claims.map(claim=>({...claim,frontmatter:{type:materialization.pageType,title:materialization.title}})),pageId as string,sources,false);
  if(prepared!==null) {
    prepared.sensitivity=sourceSensitivity(io.db,sources,prepared.sensitivity);
    prepared.page.data["sensitivity"]=prepared.sensitivity;
    requireSourceEvents(io.db,sources,{owner:true,purpose:"derive"});
  }
  const after=prepared===null?null:Buffer.from(serializePage(prepared.page));
  const at=nowOf(io),purgeReceiptId=proof[0]!.purge_receipt_id;
  const receipt:RetainedWorldCanonReceipt={
    schema:"kizuki.canon-receipt/v2",state:"retained",own_id_origin:"core",
    basis:{schema:"kizuki.world-canon-basis/v1",before:latest.basis.after,after:materialization?.basis??null},
    receipt_id:mintId(io),kind:"purge_rewrite",claim_ids:claims.map(claim=>claim.claim_id),page_path:input.rel_path,page_action:after===null?"archive":"edit",
    before_hash:existing?.hash??ABSENT_PAGE_HASH,after_hash:after===null?ABSENT_PAGE_HASH:hashBytes(after),archive_path:null,writer:"loop",producer:"deterministic",model_ref:null,
    authority:claims.length===0?"owner_correction":claims.reduce((tier,claim)=>AUTHORITY_TIERS[claim.authority]<AUTHORITY_TIERS[tier]?claim.authority:tier,claims[0]!.authority),
    confidence:claims.length===0?1:Math.min(...claims.map(claim=>claim.confidence)),sensitivity:prepared?.sensitivity??"private",taint:prepared?.taint??"clean",provenance:sources,
    superseded:[],candidates:[],retrieval_ops:[],reverts:null,reverted_by:null,at,
  };
  const archives=new Map<string,string>();
  for(const record of affected)if(record.archive_path!==null&&record.before_hash!==null) {
    const prior=archives.get(record.archive_path);if(prior!==undefined&&prior!==record.before_hash)throw new CanonWriteError("decision_stale","typed archive has conflicting receipts");
    archives.set(record.archive_path,record.before_hash);
  }
  return commitWorldCanonErasure(scope,io,{receipt,after,
    completion:{mode:"purge",claim_kind:"purge_review",page_id:typeof pageId==="string"?pageId:null,subject_key:null,original_receipt_id:null},
    erasure:{proofs:proof,redactions:affected.map(record=>eraseWorldReceipt(record.receipt_id,purgeReceiptId,at)),
      receipt_guards:affected.map(record=>({receipt_id:record.receipt_id,digest:sha256Hex(JSON.stringify(record))})),
      archives:[...archives].map(([path,hash])=>({path,hash})),final_receipt:worldErasureFinalReceipt(receipt,purgeReceiptId)},
  });
}

function finishSourceErasure(scope: VaultMutationScope, io: CanonIo, intent: SourceErasureIntent, page: VaultPage | null): void {
    assertVaultMutationScope(scope, io);
    const receipt = intent.receipt;
    const lineage = intent.version === 2 ? intent.lineage : null;
    if (intent.version === 2 && isLiveSourceSurvivorReceipt(receipt) !== (lineage !== null)) {
        throw new Error("source erasure lineage invalid");
    }
    const stream = appendSourceErasureReceipt(scope, io, receipt);
    try {
        io.db.transaction(() => {
            stream.verifyBinding();
            const existingReceipt = getCanonReceipt(io.db, receipt.receipt_id);
            const existingLineage = getSourceSurvivorLineage(io.db, receipt.receipt_id);
            if (existingReceipt !== null && !isDeepStrictEqual(existingReceipt, receipt))
                throw new Error("source erasure receipt conflict");
            if (existingLineage !== null && lineage === null)
                throw new Error("source erasure lineage conflict");
            if (existingReceipt !== null && lineage !== null && existingLineage === null)
                throw new Error("source erasure lineage incomplete");
            if (existingReceipt === null && existingLineage !== null)
                throw new Error("source erasure lineage incomplete");
            if (existingReceipt === null) insertReceiptRow(io.db, receipt, "purge_review");
            if (lineage !== null) insertSourceSurvivorLineage(io.db, lineage);
            if (tableExists(io.db, "canon_holds"))
                io.db.query("DELETE FROM canon_holds WHERE page_path=?").run(receipt.page_path);
            if (intent.page_id !== null && !receipt.page_path.startsWith("archive/")) {
                if (page === null)
                    io.db.query("DELETE FROM page_index WHERE page_id=?").run(intent.page_id);
                else {
                    const subject = page.data["x-subject-id"];
                    upsertPageIndex(io.db, { page_id: intent.page_id, rel_path: receipt.page_path, subject_key: typeof subject === "string" ? subject : null, last_receipt: receipt.receipt_id, last_hash: receipt.after_hash });
                    if (typeof subject !== "string")
                        io.db.query("UPDATE page_index SET subject_key=NULL WHERE page_id=?").run(intent.page_id);
                }
            }
            io.db.query("DELETE FROM canon_source_erasure_intents WHERE page_path=?").run(receipt.page_path);
            stream.verifyBinding();
        }).immediate();
    } finally {
        stream.close();
    }
    if (intent.page_id !== null && !receipt.page_path.startsWith("archive/")) {
        if (page === null)
            removeDerivedPage(io.db, intent.page_id, io.vault_path);
        else
            refreshDerivedPage(io.db, canonPageFromWrite(io.vault_path, receipt.page_path, intent.page_id, page, receipt.after_hash), io.vault_path);
    }
}
/** Called only inside the source purge's existing native writer ownership. */
export function recoverSourceErasureIntents(scope: VaultMutationScope, io: CanonIo, source: string): boolean {
    io = snapshotCanonIo(io);
    requireCanonFiles(scope, io);
    initCanon(io.db);
    const rows = io.db.query<{
        page_path: string;
    }, [
        string
    ]>("SELECT page_path FROM canon_source_erasure_intents WHERE source_key=? LIMIT 10001").all(source);
    if (rows.length > 10000)
        return false;
    for (const row of rows) {
        try {
            assertStoredPageRelPath(row.page_path);
            const intent = readSourceErasureIntent(io.db, row.page_path)!;
            assertReceiptPaths(intent.receipt);
            if (intent.receipt.page_path !== row.page_path) return false;
            const current = readPage(io, row.page_path);
            const hash = current?.hash ?? ABSENT_PAGE_HASH;
            if (hash === intent.receipt.before_hash)
                continue;
            if (hash !== intent.receipt.after_hash)
                return false;
            if (intent.version === 1 && isLiveSourceSurvivorReceipt(intent.receipt))
                return false;
            if (intent.version === 2 && isLiveSourceSurvivorReceipt(intent.receipt) &&
                (intent.lineage === null || intent.lineage.after_hash !== hash ||
                 intent.lineage.child_receipt_id !== intent.receipt.receipt_id))
                return false;
            finishSourceErasure(scope, io, intent, current?.page ?? null);
        }
        catch {
            return false;
        }
    }
    return true;
}
interface SourcePurgeInput extends PurgeRewriteInput {
    source_erasure: NonNullable<PurgeRewriteInput["source_erasure"]>;
}
interface SourcePurgePrepared {
    existing: ExistingPage;
    data: Record<string, unknown>;
    body: string;
    nothingRemains: boolean;
    action: PageAction;
    authority: AuthorityTier;
    sensitivity: Sensitivity;
    taint: ClaimTaint;
}
function applySourcePurgeWrite(scope: VaultMutationScope, io: CanonIo, input: SourcePurgeInput, prepared: SourcePurgePrepared): CanonReceipt {
    const files = requireCanonFiles(scope, io);
    const { existing, data, body, nothingRemains, action, authority, sensitivity, taint } = prepared;
    const pageId = typeof existing.page.data["id"] === "string" ? existing.page.data["id"] : null;
    const next = nothingRemains ? null : { data, body: body.length === 0 ? "\n" : body };
    const receipt: CanonReceipt = {
        receipt_id: mintId(io), kind: "purge_rewrite",
        claim_ids: next === null ? [...input.purged_claim_ids] : [...input.source_erasure.retained_claim_ids],
        page_path: input.rel_path, page_action: action, before_hash: existing.hash,
        after_hash: next === null ? ABSENT_PAGE_HASH : hashBytes(Buffer.from(serializePage(next))),
        archive_path: null, writer: "loop", producer: "deterministic", model_ref: null,
        authority, confidence: 1, sensitivity, taint,
        provenance: next === null ? [...input.purged_event_ids] : existingSources(next),
        superseded: [], candidates: [], retrieval_ops: [], reverts: null, reverted_by: null, at: nowOf(io),
    };
    const intent = stageSourceErasureIntent(io, input.source_erasure.source_key, input.purged_event_ids, receipt, pageId);
    commitMachineByteIntent(io.db, intent.receipt, () => {
      if (input.purged_event_ids.some(id => io.db.query(
        "SELECT 1 FROM source_event_bindings b JOIN source_grants g ON g.source_key=b.source_key WHERE b.event_id=? AND g.status!='active'",
      ).get(id) === null)) throw new CanonWriteError("decision_stale", "source erasure admission changed");
      if (next !== null) requireSourceEvents(io.db, existingSources(next), { owner: true, purpose: "derive" });
    });
    const cap = grantCanonWrite("loop", intent.receipt.receipt_id, io.vault_path, files);
    const outcome = writePage(cap, join(io.vault_path, input.rel_path), next ?? { data, body: "\n" }, {
        revision: true, expected_hash: existing.hash, erase_prior: true, delete: nothingRemains,
    });
    if (outcome.after_hash !== intent.receipt.after_hash)
        throw new CanonWriteError("decision_stale", "source erasure postimage changed");
    finishSourceErasure(scope, io, intent, next);
    return intent.receipt;
}

/** A replay can mint a one-use writer only for the exact durable admission. */
export function publishOrdinaryCanonIntent(scope: VaultMutationScope, io: CanonIo, intent: CanonWriteIntent): void {
  const files = requireCanonFiles(scope, io);
  intent = snapshotByteInput(intent);
  if (!io.db.inTransaction || JSON.stringify(readCanonWriteIntent(io.db)) !== JSON.stringify(intent)) recoveryFailure("intent_invalid");
  assertCanonAdmission(io.db, intent);
  const before = decodeCanonImage(intent.before_base64), after = decodeCanonImage(intent.after_base64);
  if(intent.version===3) {
    publishWorldErasureImage(scope,io,intent,intent.receipt.page_path,intent.receipt.before_hash!,after);
    for(const archive of intent.erasure.archives)publishWorldErasureImage(scope,io,intent,archive.path,archive.hash,null);
    return;
  }
  const cap = grantCanonWrite(intent.receipt.writer, intent.receipt.receipt_id, io.vault_path, files);
  const path = join(io.vault_path, intent.receipt.page_path);
  const page = after === null ? { data: {}, body: "" } : parseFrontmatter(after.toString("utf8"));
  const outcome = after === null
    ? writePage(cap, path, page, { delete: true, expected_hash: hashBytes(before!), recovery: true })
    : before === null
      ? writePage(cap, path, page, { recovery: true })
      : writePage(cap, path, page, { revision: true, expected_hash: hashBytes(before), recovery: true });
  if (outcome.after_hash !== intent.receipt.after_hash || outcome.archive_path !== intent.receipt.archive_path) recoveryFailure("page_changed", intent.receipt.receipt_id);
}

function publishWorldErasureImage(scope:VaultMutationScope,io:CanonIo,intent:WorldCanonErasureIntent,path:string,beforeHash:string,after:Buffer|null):void {
  const files=requireCanonFiles(scope,io),current=files.read(path);
  let actualHash=ABSENT_PAGE_HASH;
  try{if(current!==null)actualHash=hashBytes(current.bytes);}finally{current?.close();}
  const afterHash=after===null?ABSENT_PAGE_HASH:hashBytes(after);
  if(actualHash===afterHash)return;
  if(actualHash!==beforeHash)recoveryFailure(path===intent.receipt.page_path?"page_changed":"archive_changed",intent.receipt.receipt_id);
  const cap=grantCanonWrite("loop",intent.receipt.receipt_id,io.vault_path,files);
  const page=after===null?{data:{},body:""}:parseFrontmatter(after.toString("utf8"));
  const outcome=writePage(cap,join(io.vault_path,path),page,{revision:true,expected_hash:actualHash,erase_prior:true,delete:after===null,recovery:true});
  if(outcome.after_hash!==afterHash||outcome.archive_path!==null)recoveryFailure("page_changed",intent.receipt.receipt_id);
}
