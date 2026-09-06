import { stageSourceErasureIntent, readSourceErasureIntent, appendSourceErasureReceipt, type SourceErasureIntent } from "./source-erasure-intent";
import { serializePage } from "../vault/frontmatter";
import { hashBytes, ABSENT_PAGE_HASH } from "../vault/write";
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
import { refreshDerivedPage, removeDerivedPage } from "../derived";
import type { VaultPage } from "../vault/frontmatter";
import type { CanonPage } from "../vault/pages";
import { PAGE_TYPES, validatePage } from "../vault/schema";
import { grantCanonWrite, isWriter, writePage } from "../vault/write";
import type { Writer } from "../vault/write";
import { assertPageRelPath, assertReceiptPaths, assertStoredPageRelPath } from "./paths";
import { cloneExactJson } from "../util/validate";
import type { TargetDecision } from "./arbiter";
import type { BudgetTracker } from "./budget";
import { CanonWriteError } from "./errors";
import type { CanonReceipt, PageAction, RetrievalOpRef } from "./receipts";
import { initCanon } from "./schema";
import { snapshotCanonIo } from "./io";
import {
  appendReceiptLine,
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

function assertBatch(claims: readonly Claim[]): Claim {
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
    if (claim.producer !== primary.producer || claim.model_ref !== primary.model_ref) {
      throw new CanonWriteError("batch_mismatch", "one write, one producer and model reference");
    }
    if (claim.target !== primary.target && (claim.subject === null || claim.subject !== primary.subject)) {
      throw new CanonWriteError("batch_mismatch", "every claim in a write shares the target or the subject");
    }
    if (claim.kind !== primary.kind) {
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

function persistedClaims(io: CanonIo, claims: readonly Claim[]): Claim[] {
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
    if (stored.receipt_id !== null) {
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

function recordRow(
  io: CanonIo,
  receipt: CanonReceipt,
  primary: Claim,
  claims: readonly Claim[],
  pageId: string,
  subjectKey: string | null,
): void {
  const ids = claims.map((claim) => claim.claim_id);
  const placeholders = ids.map(() => "?").join(", ");
  io.db.transaction((): void => {
    insertReceiptRow(io.db, receipt, primary.kind);
    io.db
      .query(`UPDATE claims SET receipt_id = ? WHERE claim_id IN (${placeholders})`)
      .run(receipt.receipt_id, ...ids);
    if (tableExists(io.db, "claim_supersessions")) {
      io.db
        .query(`UPDATE claim_supersessions SET receipt_id = ? WHERE winner IN (${placeholders})`)
        .run(receipt.receipt_id, ...ids);
    }
    const bind = io.db.query(
      "INSERT OR IGNORE INTO claim_bindings (claim_key, page_id, bound_at) VALUES (?, ?, ?)",
    );
    for (const claim of claims) {
      if (claim.claim_key !== null) bind.run(claim.claim_key, pageId, receipt.at);
    }
    upsertPageIndex(io.db, {
      page_id: pageId,
      rel_path: receipt.page_path,
      subject_key: subjectKey,
      last_receipt: receipt.receipt_id,
      last_hash: receipt.after_hash,
    });
    if (tableExists(io.db, "proposals")) {
      io.db
        .query(`UPDATE proposals SET status = 'promoted' WHERE proposal_id IN (${placeholders})`)
        .run(...ids);
    }
  })();
}

/**
 * The single writer (RFC 0002 §4.5). Order of effects is file → JSONL
 * receipt → database row, so a crash leaves an orphan that `doctor` reports
 * rather than a silent loss. Before/after hashes describe bytes on disk.
 */
export function applyCanonWrite(
  io: CanonIo,
  claim: Claim | readonly Claim[],
  decision: TargetDecision,
  opts: ApplyCanonWriteOptions,
): CanonReceipt {
  io = snapshotCanonIo(io);
  claim = snapshotByteInput(claim);
  decision = snapshotByteInput(decision);
  opts = Object.freeze({ writer: opts.writer, budget: opts.budget });
  if (!isWriter(opts.writer)) {
    throw new CanonWriteError("writer_invalid", "writer must be loop, correction, revert or import");
  }
  if (opts.writer === "loop" && io.db.inTransaction) {
    throw new Error("loop byte admission requires a top-level transaction");
  }
  const supplied: Claim[] = Array.isArray(claim) ? [...(claim as readonly Claim[])] : [claim as Claim];
  assertBatch(supplied);
  const target = targetOf(decision);
  const claims = persistedClaims(io, supplied);
  const primary = assertBatch(claims);
  // Historical rows remain readable, but only the dedicated purge pipeline can rewrite holds.
  if (primary.kind === "purge_review") {
    throw new CanonWriteError("claim_kind_retired", "purge_review cannot authorize an ordinary canon write");
  }

  const existing = readPage(io, target.rel_path);
  const pageId = target.page_id ?? mintId(io);
  const receiptId = mintId(io);
  opts.budget.chargeWrite({ receipt_id: receiptId, page_path: target.rel_path, before_hash: existing?.hash ?? null });
  initCanon(io.db);
  const provenance = union(claims.map((item) => item.provenance));
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
    existing === null
      ? prepareCreate(claims, pageId, provenance, decision.action === "conflict")
      : prepareRevision(io, claims, primary, existing, decision, provenance);
  const invalid = validatePage(prepared.page.data);
  if (invalid.length > 0) {
    throw new CanonWriteError("frontmatter_invalid", invalid[0] ?? "invalid page");
  }
  requireSourceEvents(io.db, Array.isArray(prepared.page.data["sources"]) ? prepared.page.data["sources"].filter((id): id is string => typeof id === "string") : [], { owner: true, purpose: "derive" });
  if (prepared.page.data["sensitivity"] === "public" || prepared.page.data["sensitivity"] === "personal" || prepared.page.data["sensitivity"] === "private") prepared.page.data["sensitivity"] = sourceSensitivity(io.db, provenance, prepared.page.data["sensitivity"]);
  const superseded = supersededRefs(io, decision);
  const retrievalOps: RetrievalOpRef[] =
    io.retrieval_store === undefined
      ? []
      : [{ store: io.retrieval_store, op: "upsert", doc: `page:${pageId}` }];

  const cap = grantCanonWrite(opts.writer, receiptId, io.vault_path);
  const path = join(io.vault_path, target.rel_path);
  const expectedAfter = hashBytes(Buffer.from(serializePage(prepared.page)));
  const admit = (): void => {
    persistedClaims(io, claims);
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
    if (!sourceDeletion) requireExternalEvents(io.db, union([provenance, existingSources(prepared.page)]));
  };
  if (opts.writer === "loop") {
    commitMachineByteIntent(io.db, { receipt_id: receiptId, before_hash: existing?.hash ?? null, after_hash: expectedAfter }, admit);
  } else {
    io.db.transaction(admit).immediate();
  }
  const outcome =
    existing === null
      ? writePage(cap, path, prepared.page)
      : writePage(cap, path, prepared.page, { revision: true, expected_hash: existing.hash });
  if (outcome.after_hash !== expectedAfter) throw new CanonWriteError("decision_stale", "canon postimage changed after byte admission");

  const receipt: CanonReceipt = {
    receipt_id: receiptId,
    kind: "write",
    claim_ids: claims.map((item) => item.claim_id),
    page_path: target.rel_path,
    page_action: prepared.action,
    before_hash: existing?.hash ?? null,
    after_hash: outcome.after_hash,
    archive_path: outcome.archive_path,
    writer: opts.writer,
    producer: primary.producer,
    model_ref: primary.model_ref,
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
  };

  appendReceiptLine(io, receipt);
  const priorSubject = existing?.page.data["x-subject-id"];
  recordRow(
    io,
    receipt,
    primary,
    claims,
    pageId,
    primary.subject ?? (typeof priorSubject === "string" ? priorSubject : null),
  );
  refreshDerivedPage(
    io.db,
    canonPageFromWrite(io.vault_path, target.rel_path, pageId, prepared.page, outcome.after_hash),
    io.vault_path,
  );
  return receipt;
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

interface RevertWriteInput {
  receipt_id: string;
  rel_path: string;
  expected_hash: string | null;
  page: VaultPage | null;
}

interface RevertWriteOutcome {
  archive_path: string | null;
  after_hash: string;
}

/**
 * The only revert byte path. Mints a `writer: "revert"` capability and
 * calls `writePage` in this same function so the capability scan still
 * holds. `page === null` deletes (undo of a create).
 */
export function applyRevertWrite(
  io: CanonIo,
  input: RevertWriteInput,
): RevertWriteOutcome {
  io = snapshotCanonIo(io);
  input = snapshotByteInput(input);
  assertPageRelPath(input.rel_path);
  if (input.page !== null) requireSourceEvents(io.db, existingSources(input.page), { owner: true, purpose: "derive" });
  const cap = grantCanonWrite("revert", input.receipt_id, io.vault_path);
  const path = join(io.vault_path, input.rel_path);
  if (input.page === null) {
    if (input.expected_hash === null) {
      throw new CanonWriteError("page_missing", `page ${input.rel_path} is already gone`);
    }
    const existing = readPage(io, input.rel_path);
    const outcome = writePage(cap, path, { data: {}, body: "" }, {
      delete: true,
      expected_hash: input.expected_hash,
    });
    if (existing !== null && typeof existing.page.data["id"] === "string") {
      removeDerivedPage(io.db, existing.page.data["id"], io.vault_path);
    }
    return outcome;
  }
  const outcome =
    input.expected_hash === null
      ? writePage(cap, path, input.page)
      : writePage(cap, path, input.page, {
          revision: true,
          expected_hash: input.expected_hash,
        });
  // Undo refreshes derived rows only after its receipt is durable.
  return outcome;
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
  io: CanonIo,
  input: PurgeRewriteInput,
): CanonReceipt {
  io = snapshotCanonIo(io);
  input = snapshotByteInput(input);
  if (input.source_erasure === undefined) assertPageRelPath(input.rel_path);
  else assertStoredPageRelPath(input.rel_path);
  if (io.db.inTransaction) throw new Error("loop byte admission requires a top-level transaction");
  initCanon(io.db);
  const existing = readPage(io, input.rel_path);
  if (existing === null) {
    throw new CanonWriteError("page_missing", `page ${input.rel_path} is gone`);
  }

  if (input.source_erasure !== undefined) {
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
  let authority = new CanonAuthorityResolver(io.db, [input.rel_path]).resolve(
    input.rel_path,
    existing.hash,
  );
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
  }
  const prior = existingSources(existing.page);
  const remainingSources = prior.filter(
    (source) => !input.purged_event_ids.includes(source),
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

  if (input.source_erasure !== undefined) return applySourcePurgeWrite(io,
    {...input,source_erasure:input.source_erasure},
    {existing,data,body,nothingRemains,action,authority,sensitivity,taint});
  const receiptId = mintId(io);
  const cap = grantCanonWrite("loop", receiptId, io.vault_path);
  const path = join(io.vault_path, input.rel_path);
  const next = { data, body: body.length === 0 ? "\n" : body };
  const expectedAfter = hashBytes(Buffer.from(serializePage(next)));
  commitMachineByteIntent(io.db, { receipt_id: receiptId, before_hash: existing.hash, after_hash: expectedAfter }, () => {
    requireSourceEvents(io.db, existingSources(next), { owner: true, purpose: "derive" });
  });
  const outcome = writePage(
    cap,
    path,
    next,
    {
      revision: true,
      expected_hash: existing.hash,
    },
  );
  if (outcome.after_hash !== expectedAfter) throw new CanonWriteError("decision_stale", "purge postimage changed after byte admission");

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
    after_hash: outcome.after_hash,
    archive_path: outcome.archive_path,
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

  appendReceiptLine(io, receipt);
  const retainedSubject = data["x-subject-id"];
  io.db.transaction((): void => {
    insertReceiptRow(io.db, receipt, "purge_review");
    if (tableExists(io.db, "canon_holds")) {
      io.db
        .query("DELETE FROM canon_holds WHERE page_path = ?")
        .run(input.rel_path);
    }
    if (pageId !== null && !input.rel_path.startsWith("archive/")) {
      upsertPageIndex(io.db, {
          page_id: pageId,
          rel_path: input.rel_path,
          subject_key: typeof retainedSubject === "string" ? retainedSubject : null,
          last_receipt: receipt.receipt_id,
          last_hash: receipt.after_hash,
        });
    }
  })();
  if (pageId !== null && !input.rel_path.startsWith("archive/")) {
    if (nothingRemains) {
      removeDerivedPage(io.db, pageId, io.vault_path);
    } else {
      refreshDerivedPage(
        io.db,
        canonPageFromWrite(
          io.vault_path,
          input.rel_path,
          pageId,
          {
            data,
            body: body.length === 0 ? "\n" : body,
          },
          outcome.after_hash,
        ),
        io.vault_path,
      );
    }
  }
  return receipt;
}

function finishSourceErasure(io: CanonIo, intent: SourceErasureIntent, page: VaultPage | null): void {
    const receipt = intent.receipt;
    const stream = appendSourceErasureReceipt(io, receipt);
    try {
        io.db.transaction(() => {
            stream.verifyBinding();
            insertReceiptRow(io.db, receipt, "purge_review");
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
export function recoverSourceErasureIntents(io: CanonIo, source: string): boolean {
    io = snapshotCanonIo(io);
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
            finishSourceErasure(io, intent, current?.page ?? null);
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
function applySourcePurgeWrite(io: CanonIo, input: SourcePurgeInput, prepared: SourcePurgePrepared): CanonReceipt {
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
    const cap = grantCanonWrite("loop", intent.receipt.receipt_id, io.vault_path);
    const outcome = writePage(cap, join(io.vault_path, input.rel_path), next ?? { data, body: "\n" }, {
        revision: true, expected_hash: existing.hash, erase_prior: true, delete: nothingRemains,
    });
    if (outcome.after_hash !== intent.receipt.after_hash)
        throw new CanonWriteError("decision_stale", "source erasure postimage changed");
    finishSourceErasure(io, intent, next);
    return intent.receipt;
}
