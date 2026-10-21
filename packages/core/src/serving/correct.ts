import { sha256Hex } from "../util/hash";
import { extendOwnedCanonIo, snapshotCanonIo, withCanonMutationAsync } from "../canon/io";
import { VaultMutationError } from "../vault/mutation-scope";
import {
  sourcePolicyEpoch,
  sourceEventsAllowed,
  requireSourceEvents,
} from "../ledger/source-grants";
import { claimReader } from "./claims";
import type { Sensitivity } from "../agents";
import {
  claimsConflict,
  resolveConflict,
  type ConflictClaim,
} from "../claims/conflict";
import { insertClaim, getClaim, listClaims } from "../claims/store";
import type { RawSubjectRef } from "../contracts/claim-v2";
import type { AuthorityTier, Claim } from "../contracts/proposal";
import { recordNativeCorrection } from "../correction/evidence";
import { text } from "./arguments";
import { auditArguments, claimsIo, gateAsync, principalName } from "./gate";
import type { Served } from "./gate";
import { pageSnapshot, pendingCanonRewrite, rewriteCanon } from "./rewrite";
import { worldCanonPath, worldClaimHandle } from "../canon/world-materialization";
import type { RewrittenPage, CanonRewrite } from "./rewrite";
import type { CanonRecoveryPending } from "../correction/types";
import { claimVisibleTo, groupByKey, readable, resolve } from "./target";
import type { CorrectTarget } from "./target";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";
import { resolveWorldClaim, worldNamespace } from "../world/references";
import { readableWorldNode } from "../world/endpoint-access";
import { isWorldWireToken, readWorldView, WorldViewError } from "./world-view";
import type { WorldReadResult } from "./world-view";
import { correctWithinMutation } from "../correction/correct";
import { CorrectError } from "../correction/errors";
import type { CorrectionMode, WorldCorrection } from "../correction/types";
import { parseIntent } from "./correct-args";
import type { CorrectionIntent, CorrectObject, CorrectRefresh, CorrectionChange } from "./correct-args";
import { readClaimV2Semantic } from "../claims/claim-v2-commit";
import { getCanonReceipt } from "../canon/receipts";
import { denyClassesOf, resolvePrincipal } from "../agents";
import type { VaultMutationScope } from "../vault/mutation-scope";
import type { CorrectIo } from "../correction/types";

const MAX_STATEMENT_CHARS = 2_000;
const MAX_OBJECT_CHARS = 1_024;
/** The owner's own words enter the ledger on an internal connector. */
const CORRECTION_CONNECTOR = "kizuki.owner";
const CORRECTION_KIND = "correction";

export type { CorrectTarget };

export interface CorrectArgs {
  /** The owner's sentence, stored verbatim and never read as instruction. */
  statement: string;
  target?: CorrectTarget;
  /**
   * The value the claim should carry instead. Without it the correction is a
   * denial of the recorded reading and nothing is asserted in its place:
   * reading a replacement out of the sentence needs a model, and none is
   * bound here (RFC 0002 §6.3 step 2).
   */
  object?: string | CorrectObject;
  /** Resolve and report, write nothing (RFC 0002 §6.2). */
  dry_run?: boolean;
  /** What to do to a typed world claim. Absent, its object is replaced. Only a `world_claim` target takes it. */
  mode?: CorrectionMode;
  /** The perspective a `reclassify_mode` correction gives the claim. */
  perspective_mode?: "suggested" | "hypothetical" | "questioned";
  /** A concept or situation read to run after the correction commits. */
  refresh_world?: CorrectRefresh;
}

export interface CorrectData {
  recovery_pending?: CanonRecoveryPending[];
  /** The committed canon receipt; null does not rule out a pending publication. */
  receipt_id: string | null;
  /** The statement's ledger event; null when nothing was recorded. */
  event_id: string | null;
  /** The correction claim; null when the target was ambiguous or a rehearsal. */
  claim_id: string | null;
  superseded: { claim_id: string; claim_key: string }[];
  /** The pages the correction rewrote, with the bytes before and after. */
  rewritten: RewrittenPage[];
  /** Groups that also matched and were deliberately left alone. */
  ambiguous: { claim_key: string; claim_ids: string[] }[];
  answer: string;
  /** The mode a typed world correction applied. Absent for a legacy claim. */
  mode?: CorrectionMode;
  /**
   * The world read asked for with `refresh_world`, taken after the commit; null
   * when none was asked for or nothing was written. A refresh that could not be
   * taken is an unavailable view: the correction it follows still stands.
   */
  refreshedWorld?: WorldReadResult | null;
}

function refuse(field: string, rule: string): ServeError {
  return new ServeError(
    "invalid_arguments",
    `invalid arguments: ${field}: ${rule}`,
  );
}

/** Public DenyReason has no below_authority; held is the existing policy refusal. */
function refuseAuthority(): ServeError {
  return new ServeError(
    "held",
    "correction is below the live claim's authority",
  );
}

/**
 * RFC 0002 §6.3 step 1: `sha256(statement ‖ 0 ‖ target_json)`. Hashing the
 * statement alone would collapse two corrections of different claims that
 * happen to be worded the same into one record, losing which claim each was
 * aimed at. Keys are written in a fixed order so the same target always
 * serializes the same way.
 */
function recordId(statement: string, target: CorrectTarget): string {
  const canonical = JSON.stringify({
    claim_id: target.claim_id ?? null,
    claim_key: target.claim_key ?? null,
    subject: target.subject ?? null,
  });
  return new Bun.CryptoHasher("sha256")
    .update(statement)
    .update("\0")
    .update(canonical)
    .digest("hex");
}

function exactWorldClaimTarget(target: CorrectTarget): { readonly kind: "claim"; readonly token: string } {
  const world = Object.getOwnPropertyDescriptor(target, "world_claim")?.value;
  const kind =
    typeof world === "object" && world !== null
      ? Object.getOwnPropertyDescriptor(world, "kind")?.value
      : undefined;
  const token =
    typeof world === "object" && world !== null
      ? Object.getOwnPropertyDescriptor(world, "token")?.value
      : undefined;
  if (
    Object.getPrototypeOf(target) !== Object.prototype ||
    Object.keys(target).length !== 1 ||
    !Object.hasOwn(target, "world_claim") ||
    typeof world !== "object" ||
    world === null ||
    Array.isArray(world) ||
    Object.getPrototypeOf(world) !== Object.prototype ||
    Object.keys(world).length !== 2 ||
    !Object.hasOwn(world, "kind") ||
    !Object.hasOwn(world, "token") ||
    kind !== "claim" ||
    typeof token !== "string" ||
    !isWorldWireToken(token)
  ) {
    throw refuse("target", "names no live claim");
  }
  return Object.freeze({ kind: "claim" as const, token });
}

function resolvedWorldTarget(
  ctx: ServeContext,
  token: string,
  object: CorrectObject | undefined,
): { ctx: ServeContext; target: CorrectTarget & { claim_id: string }; node: RawSubjectRef | null } {
  const principal = resolvePrincipal(ctx.db, ctx.principal);
  if (principal === null) throw new ServeError("unknown_agent", "unknown agent");
  const current = Object.freeze({ ...ctx, principal });
  const namespace = worldNamespace(current.db, current.principal);
  const claimId = resolveWorldClaim(current.db, namespace, token);
  if (claimId === null) throw refuse("target", "names no live claim");
  // The object token is looked up in the same namespace and must still be readable now.
  const node = object?.kind === "node" ? readableWorldNode(current, namespace, object.ref.token) : null;
  if (object?.kind === "node" && node === null) throw refuse("object", "names no node you can read");
  return { ctx: current, target: { claim_id: claimId }, node };
}

/**
 * World cards name neutral typed parents.  Their correction must therefore
 * enter the typed correction writer, which creates the native owner evidence
 * and preserves the support journal; the legacy writer cannot infer a
 * predicate from the intentionally blank parent row.
 */
function isWorldClaimTarget(
  ctx: ServeContext,
  target: CorrectTarget | undefined,
): target is CorrectTarget & { claim_id: string } {
  return target?.claim_id !== undefined && readClaimV2Semantic(ctx.db, target.claim_id) !== null;
}

/** The correction a caller asked for, with a node token replaced by the endpoint it names for them. */
function worldCorrection(change: CorrectionChange, statement: string, node: RawSubjectRef | null): WorldCorrection {
  if (change.mode !== "replace_object") return change;
  const object = change.object;
  // The statement is the default object, so naming it changes nothing and must not make a new record.
  if (object === undefined || (object.kind === "literal" && object.value === statement)) return { mode: "replace_object" };
  if (object.kind === "literal") return { mode: "replace_object", object };
  if (object.kind === "vocabulary") {
    return { mode: "replace_object", object: { kind: "vocabulary", ref: { kind: "vocabulary", id: object.id } } };
  }
  return { mode: "replace_object", object: { kind: "subject", ref: node! } };
}

/** A typed correction's refusals, worded as the serving layer words every argument refusal. */
function servableRefusal(error: unknown): unknown {
  if (!(error instanceof CorrectError)) return error;
  switch (error.code) {
    case "below_authority":
      return refuseAuthority();
    case "tool_not_granted":
      return new ServeError("tool_not_granted", "tool not granted");
    case "unsupported_assertion":
      return refuse("target", `unsupported_assertion: ${error.detail.split(":", 1)[0]}`);
    case "correction_refused":
      return refuse("correction", error.detail);
    case "statement_invalid":
      return refuse("statement", error.detail);
    case "claim_unknown":
    case "claim_not_live":
    case "target_required":
      return refuse("target", "names no live claim");
    default:
      return error;
  }
}

async function correctWorldClaim(
  scope: VaultMutationScope,
  io: CorrectIo,
  ctx: ServeContext,
  args: CorrectArgs,
  token: string,
  intent: CorrectionIntent,
): Promise<Served<CorrectData>> {
  const resolved = ctx.db
    .transaction(() => resolvedWorldTarget(ctx, token, intent.change.mode === "replace_object" ? intent.change.object : undefined))
    .immediate();
  ctx = resolved.ctx;
  const target = resolved.target;
  if (!isWorldClaimTarget(ctx, target))
    throw refuse("target", "names no live claim");
  const claim = getClaim(ctx.db, target.claim_id);
  if (claim === null || claim.status !== "live")
    throw refuse("target", "names no live claim");
  // A typed correction is filed at the owner's authority; a grant that cannot relay the owner cannot file one.
  if (ctx.principal.kind !== "owner" && !ctx.principal.grant.relay_owner_corrections)
    throw new ServeError("held", "correction relay is not granted");
  const reader = claimReader(ctx.db, ctx.principal.grant, {
    owner: ctx.principal.kind === "owner",
    purpose: "correction",
  });
  if (!reader.canRead(claim))
    throw new ServeError("held", "source authorization does not permit this correction");
  const owned = extendOwnedCanonIo(scope, io, {
      producer:
        ctx.principal.kind === "owner"
          ? "owner"
          : `agent:${ctx.principal.agent.name}`,
      relay_owner_corrections:
        ctx.principal.kind === "owner" || ctx.principal.grant.relay_owner_corrections,
      grant: ctx.principal.grant,
    });
  const handle = worldClaimHandle(ctx.db, claim.claim_id);
  const pagePath = handle === null ? null : worldCanonPath(handle);
  const beforeReadable = pagePath !== null && pageSnapshot(owned, ctx, pagePath).readable;
  const result = await correctWithinMutation(
    scope,
    owned,
    {
      statement: args.statement,
      target,
      world: worldCorrection(intent.change, args.statement, resolved.node),
      ...(args.dry_run === true ? { dry_run: true } : {}),
    },
  ).catch((error: unknown) => {
    throw servableRefusal(error);
  });
  const disclosePage = beforeReadable && pagePath !== null && pageSnapshot(owned, ctx, pagePath).readable;
  return {
    canon: [],
    quoted: [],
    withheld:
      result.recovery_pending === undefined
        ? []
        : [{ id: "tool:correct", reason: "error" as const }],
    data: {
      ...(result.recovery_pending === undefined
        ? {}
        : { recovery_pending: ctx.principal.kind === "owner" || disclosePage ? result.recovery_pending : [] }),
      mode: intent.change.mode,
      receipt_id: disclosePage ? result.receipt_id : null,
      event_id: result.event_id,
      claim_id: result.claim_ids[0] ?? null,
      superseded: result.superseded.map(({ claim_id, claim_key }) => ({
        claim_id,
        claim_key,
      })),
      rewritten: result.rewritten.flatMap((rewrite) => {
        if (!disclosePage || rewrite.page_path !== pagePath) return [];
        if (rewrite.receipt_id === null) return [];
        const receipt = getCanonReceipt(ctx.db, rewrite.receipt_id);
        if (receipt === null) return [];
        return [{
          page_path: rewrite.page_path,
          page_action: receipt.page_action,
          before_hash: rewrite.before_hash,
          after_hash: rewrite.after_hash,
          receipt_id: rewrite.receipt_id,
          diff: rewrite.diff,
        }];
      }),
      ambiguous: result.ambiguous.map(({ claim_key, claim_ids }) => ({
        claim_key,
        claim_ids,
      })),
      answer: disclosePage ? result.answer : args.dry_run === true ? "Correction preview complete." : "Recorded the correction.",
      refreshedWorld: null,
    },
    audit_ids: {
      claim_ids: [
        ...result.claim_ids,
        ...result.superseded.map(({ claim_id }) => claim_id),
      ],
    },
  };
}

/**
 * The read a caller asked to have taken after its correction committed. The
 * correction is already durable, so a read that cannot be taken is reported as
 * an unavailable view and never as a failed correction.
 */
function refreshedWorld(ctx: ServeContext, refresh: NonNullable<CorrectionIntent["refresh"]>): WorldReadResult {
  try {
    return readWorldView(ctx, refresh);
  } catch {
    return {
      schema: "kizuki.world-view/v1",
      operation: refresh["operation"] as "concept" | "situation",
      result: { status: "unavailable", reason: "storage" },
    };
  }
}

/** Refuses a malformed refresh, or one this principal may not read, before the correction writes anything. */
function checkRefresh(ctx: ServeContext, refresh: NonNullable<CorrectionIntent["refresh"]>): void {
  try {
    readWorldView(ctx, refresh);
  } catch (error) {
    if (error instanceof WorldViewError) throw refuse("refresh_world", "must be a valid concept or situation read");
    throw error;
  }
}

function recordStatement(
  ctx: ServeContext,
  statement: string,
  sourceRecordId: string,
  subject: string,
  at: string,
  requestDigest: string,
): string {
  return recordNativeCorrection(ctx.db, {
    schema: "kizuki.event/v1", connector_id: CORRECTION_CONNECTOR,
    source_record_id: sourceRecordId, kind: CORRECTION_KIND,
    occurred_at: at, observed_at: at, text: statement, subjects: [],
    sensitivity_hint: "private", deleted: false, attachments: [], metadata: {},
  }, requestDigest).event_id;
}

function ambiguousAnswer(groups: Map<string, Claim[]>): CorrectData {
  return {
    receipt_id: null,
    event_id: null,
    claim_id: null,
    superseded: [],
    rewritten: [],
    ambiguous: [...groups.entries()].map(([claim_key, claims]) => ({
      claim_key,
      claim_ids: claims.map((claim) => claim.claim_id),
    })),
    answer:
      `Nothing was corrected: ${groups.size} claim groups match that ` +
      "subject. Name one with claim_id or claim_key.",
  };
}

/** RFC 0002 §6.4: a grant may relay without speaking at the owner's tier. */
function relayCeiling(ctx: ServeContext): AuthorityTier | undefined {
  if (ctx.principal.kind === "owner") return undefined;
  return ctx.principal.grant.relay_owner_corrections
    ? undefined
    : "owner_authored";
}

/**
 * Refuse before native owner evidence when this relay cannot beat a live
 * rival. Uses the same filed tier and conflict comparator as insertClaim.
 */
function assertSufficientAuthority(
  ctx: ServeContext,
  group: Claim[],
  claimKey: string,
  predicate: string,
  replacement: string | undefined,
  at: string,
): void {
  const rivals = listClaims(ctx.db, {
    claim_key: claimKey,
    status: "live",
    filter: (claim) => sourceEventsAllowed(ctx.db, claim.provenance, {
      owner: ctx.principal.kind === "owner",
      purpose: "correction",
      deny_classes: denyClassesOf(ctx.principal.grant),
    }),
  });
  const live = rivals.length > 0 ? rivals : group;
  const incoming: ConflictClaim = {
    claim_id: "",
    claim_key: claimKey,
    polarity: replacement === undefined ? "negative" : "positive",
    object: replacement ?? null,
    predicate,
    authority: relayCeiling(ctx) ?? "owner_correction",
    confidence: 1,
    valid_from: at,
    valid_to: null,
    status: "live",
    provenance: [...new Set(live.flatMap((claim) => claim.provenance))],
  };
  for (const rival of live) {
    if (!claimsConflict(incoming, rival)) continue;
    if (resolveConflict(incoming, rival).action === "skip") {
      throw refuseAuthority();
    }
  }
}

function sentence(
  superseded: number,
  subject: string,
  rewrite: CanonRewrite,
): string {
  const retired =
    superseded === 0
      ? "Recorded the correction. Nothing live contradicted it."
      : `Recorded the correction and retired ${superseded} claim(s) about ${subject}.`;
  const page = rewrite.rewritten[0];
  const written =
    rewrite.recovery_pending !== undefined
      ? " Canon completion is unconfirmed; recovery is pending. Run kizuki recover --json before another change."
      : page === undefined
      ? rewrite.failed
        ? " No page was rewritten: the canon writer refused this pass."
        : ""
      : ` Rewrote ${page.page_path}. Undo with kizuki undo ${page.receipt_id}.`;
  const left =
    rewrite.unreached.length === 0
      ? ""
      : ` Still to correct: ${rewrite.unreached.join(", ")}.`;
  return `${retired}${written}${left}`;
}

/** One read of caller data, so validation and use see the same value even from a getter. */
function snapshot<T>(field: string, value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw refuse(field, "must be plain data");
  }
}

/**
 * The owner's correction, and the only write that outranks everything else in
 * the store. It supersedes the contradicted claims and rewrites the canon
 * bound to them in the same pass, answering with what it retired and what it
 * wrote (RFC 0002 §6.3).
 */
export async function serveCorrect(
  ctx: ServeContext,
  args: CorrectArgs,
): Promise<Envelope<CorrectData>> {
  const { statement, target, object, dry_run, mode, perspective_mode, refresh_world } = args;
  const worldClaim =
    target !== undefined &&
    typeof target === "object" &&
    target !== null &&
    Object.hasOwn(target, "world_claim")
      ? exactWorldClaimTarget(target)
      : undefined;
  args = Object.freeze({ statement,
    ...(target === undefined
      ? {}
      : { target: Object.freeze({
        ...target,
        ...(worldClaim === undefined ? {} : { world_claim: worldClaim }),
      }) }),
    ...(object === undefined ? {} : { object: snapshot("object", object) }),
    ...(dry_run === undefined ? {} : { dry_run }),
    ...(mode === undefined ? {} : { mode }),
    ...(perspective_mode === undefined ? {} : { perspective_mode }),
    ...(refresh_world === undefined ? {} : { refresh_world: snapshot("refresh_world", refresh_world) }),
  });
  return gateAsync(
    ctx,
    "correct",
    auditArguments(args),
    async ({ ctx, at }): Promise<Served<CorrectData>> => {
      const io = snapshotCanonIo({
        db: ctx.db,
        vault_path: ctx.vaultPath,
        ...(ctx.retrieval === undefined ? {} : { retrieval: ctx.retrieval }),
      });
      ctx = Object.freeze({ ...ctx, db: io.db, vaultPath: io.vault_path });
      try {
        if (worldClaim !== undefined) {
          const intent = parseIntent(args);
          if (intent.refresh !== undefined) checkRefresh(ctx, intent.refresh);
          const served = await withCanonMutationAsync(io, (scope, owned) =>
            correctWorldClaim(scope, owned, ctx, args, worldClaim.token, intent),
          );
          // Taken after the writer is released: the correction is durable, whatever the read finds.
          if (intent.refresh !== undefined && served.data !== undefined && served.data.claim_id !== null) {
            served.data.refreshedWorld = refreshedWorld(ctx, intent.refresh);
          }
          return served;
        }
        if (args.mode !== undefined || args.perspective_mode !== undefined || args.refresh_world !== undefined || typeof args.object === "object")
          throw refuse("target", "mode, perspective_mode, refresh_world and a typed object need a world_claim target");
        return await withCanonMutationAsync(io, async (scope, canon) => {
      const grant = ctx.principal.grant;
      const statement = text("statement", args.statement, MAX_STATEMENT_CHARS);
      const replacement =
        args.object === undefined
          ? undefined
          : text("object", args.object, MAX_OBJECT_CHARS);
      // A filed native recording remains replayable after its target was retired.
      if (args.target !== undefined && args.dry_run !== true) {
        const recorded = ctx.db
          .query<
            { event_id: string; request_digest: string },
            [string, string]
          >(
            "SELECT e.event_id,n.request_digest FROM events e JOIN native_owner_evidence n ON n.event_id=e.event_id WHERE e.connector_id=? AND e.source_record_id=?",
          )
          .get(CORRECTION_CONNECTOR, recordId(statement, args.target));
        if (recorded !== null) {
          if (
            recorded.request_digest !==
            sha256Hex(
              JSON.stringify([statement, args.target, replacement ?? null]),
            )
          )
            throw refuse(
              "object",
              "conflicts with the recorded correction intent",
            );
          const filedRow = ctx.db
            .query<{ claim_id: string }, [string]>(
              "SELECT claim_id FROM claims WHERE EXISTS (SELECT 1 FROM json_each(claims.provenance) WHERE value=?) AND target LIKE 'correction:%' AND status != 'skipped' ORDER BY created_at LIMIT 1",
            )
            .get(recorded.event_id);
          const prior =
            filedRow === null ? null : getClaim(ctx.db, filedRow.claim_id);
          // A recording the caller could not have read is treated as absent and
          // falls through to resolve, so a replay is no tier oracle.
          if (prior !== null && claimVisibleTo(ctx, prior)) {
            requireSourceEvents(ctx.db, prior.provenance, {
              owner: ctx.principal.kind === "owner",
              purpose: "correction",
            });
            ctx.db
              .query(
                "UPDATE native_owner_evidence SET filing_state='filed' WHERE event_id=?",
              )
              .run(recorded.event_id);
            const pending = pendingCanonRewrite(ctx, prior);
            return {
              canon: [],
              quoted: [],
              withheld: pending !== undefined ? [{ id: 'tool:correct', reason: 'error' as const }] : [],
              data: {
                ...(pending === undefined ? {} : { recovery_pending: pending }),
                receipt_id: null,
                event_id: recorded.event_id,
                claim_id: prior.claim_id,
                superseded: [],
                rewritten: [],
                ambiguous: [],
                answer: pending !== undefined
                  ? "That correction is recorded; canon recovery remains pending. Run kizuki recover --json before another change."
                  : "That correction was already recorded; nothing changed.",
              },
            };
          }
        }
      }
      const resolved = resolve(ctx, args.target);
      const sourceReader = claimReader(ctx.db, grant, {
        owner: ctx.principal.kind === "owner",
        purpose: "correction",
      });
      if (
        sourcePolicyEpoch(ctx.db) > 0 &&
        resolved.claims.some((claim) => !sourceReader.canRead(claim))
      )
        throw new ServeError(
          "held",
          "source authorization does not permit this correction",
        );
      readable(ctx.db, grant, resolved.claims);

      const groups = groupByKey(resolved.claims);
      if (groups.size > 1) {
        return {
          canon: [],
          quoted: [],
          withheld: [],
          data: ambiguousAnswer(groups),
        };
      }

      const entry = [...groups.entries()][0];
      if (entry === undefined) {
        throw refuse("target", "names no live keyed claim");
      }
      const [claimKeyValue, group] = entry;
      const first = group[0] as Claim;
      const subject = first.subject;
      const predicate = first.predicate;
      if (subject === null || predicate === null) {
        throw refuse("target", "names a claim with no predicate to correct");
      }

      if (args.dry_run === true) {
        return {
          canon: [],
          quoted: [],
          withheld: [],
          data: {
            receipt_id: null,
            event_id: null,
            claim_id: null,
            superseded: group.map((claim) => ({
              claim_id: claim.claim_id,
              claim_key: claimKeyValue,
            })),
            rewritten: [],
            ambiguous: [],
            answer:
              `Nothing was written. This would retire ${group.length} ` +
              `claim(s) about ${subject}.`,
          },
        };
      }

      assertSufficientAuthority(
        ctx,
        group,
        claimKeyValue,
        predicate,
        replacement,
        at,
      );

      const targetEvidence = [
        ...new Set(group.flatMap((claim) => claim.provenance)),
      ].sort();
      requireSourceEvents(ctx.db, targetEvidence, {
        owner: ctx.principal.kind === "owner",
        purpose: "correction",
      });
      const eventId = recordStatement(
        ctx,
        statement,
        recordId(statement, resolved.target),
        subject,
        at,
        sha256Hex(
          JSON.stringify([statement, resolved.target, replacement ?? null]),
        ),
      );
      const sensitivity: Sensitivity = first.sensitivity;
      const ceiling = relayCeiling(ctx);
      const filed = await insertClaim(claimsIo(ctx), {
        kind: "claim",
        // The key the correction is about, so one wording aimed at two
        // different readings files as two claims rather than colliding on
        // the store's idempotency index.
        target: `correction:${claimKeyValue}`,
        body: statement,
        provenance: [...new Set([eventId, ...targetEvidence])],
        subjects: [subject],
        subject,
        predicate,
        // Named a replacement, the correction asserts it. Unnamed, it denies
        // the recorded reading and asserts nothing: deriving the polarity
        // from whatever is live would flip with the count of how many times
        // the owner has spoken rather than with what the owner said.
        ...(replacement === undefined
          ? { polarity: "negative" as const }
          : { polarity: "positive" as const, object: replacement }),
        producer:
          ctx.principal.kind === "owner"
            ? "owner"
            : `agent:${ctx.principal.agent.name}`,
        confidence: 1,
        intent: "correct",
        taint: "clean",
        sensitivity,
        ...(ceiling === undefined ? {} : { relay_ceiling: ceiling }),
      }).catch((error) => {
        ctx.db
          .query(
            "UPDATE native_owner_evidence SET filing_state='failed' WHERE event_id=?",
          )
          .run(eventId);
        throw error;
      });
      if (filed.outcome === "skipped") {
        ctx.db
          .query(
            "UPDATE native_owner_evidence SET filing_state='failed' WHERE event_id=?",
          )
          .run(eventId);
        throw refuseAuthority();
      }
      ctx.db
        .query(
          "UPDATE native_owner_evidence SET filing_state='filed' WHERE event_id=?",
        )
        .run(eventId);

      const claim =
        filed.outcome === "contested" ? filed.incoming : filed.claim;
      const superseded =
        filed.outcome === "stored"
          ? filed.superseded.map((retired) => ({
              claim_id: retired.claim_id,
              claim_key: claimKeyValue,
            }))
          : [];
      const rewrite: CanonRewrite =
        filed.outcome === "stored"
          ? rewriteCanon(scope, canon, ctx, claim, [claimKeyValue])
          : { receipt_id: null, rewritten: [], unreached: [], failed: false };

      const answer =
        filed.outcome === "duplicate"
          ? "That correction was already recorded; nothing changed."
          : sentence(superseded.length, subject, rewrite);

      return {
        canon: [],
        quoted: [],
        withheld: rewrite.failed || rewrite.recovery_pending !== undefined
          ? [{ id: `tool:correct`, reason: "error" }]
          : [],
        data: {
          ...(rewrite.recovery_pending === undefined ? {} : { recovery_pending: rewrite.recovery_pending }),
          receipt_id: rewrite.receipt_id,
          event_id: eventId,
          claim_id: claim.claim_id,
          superseded,
          rewritten: rewrite.rewritten,
          ambiguous: [],
          answer: `${answer} Relayed by ${principalName(ctx.principal)}.`,
        },
        audit_ids: {
          claim_ids: [
            claim.claim_id,
            ...superseded.map((retired) => retired.claim_id),
          ],
        },
      };
        });
      } catch (error) {
        if (error instanceof VaultMutationError && error.code === "writer_busy") {
          throw new ServeError("error", "canon writer is busy; retry correction", { retry_after_seconds: 1 });
        }
        throw error;
      }
    },
  );
}
