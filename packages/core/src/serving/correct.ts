import { sha256Hex } from "../util/hash";
import {
  sourcePolicyEpoch,
  requireSourceEvents,
} from "../ledger/source-grants";
import { claimReader } from "./claims";
import type { Sensitivity } from "../agents";
import { insertClaim, getClaim } from "../claims/store";
import type { AuthorityTier, Claim } from "../contracts/proposal";
import { accept } from "../ledger/ledger";
import { text } from "./arguments";
import { auditArguments, claimsIo, gateAsync, principalName } from "./gate";
import type { Served } from "./gate";
import { rewriteCanon } from "./rewrite";
import type { RewrittenPage } from "./rewrite";
import { groupByKey, readable, resolve } from "./target";
import type { CorrectTarget } from "./target";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

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
  object?: string;
  /** Resolve and report, write nothing (RFC 0002 §6.2). */
  dry_run?: boolean;
}

export interface CorrectData {
  /** The receipt for the canon rewrite; null when no page moved. */
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
}

function refuse(field: string, rule: string): ServeError {
  return new ServeError(
    "invalid_arguments",
    `invalid arguments: ${field}: ${rule}`,
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

function recordStatement(
  ctx: ServeContext,
  statement: string,
  sourceRecordId: string,
  subject: string,
  at: string,
  requestDigest: string,
): string {
  return ctx.db
    .transaction(() => {
      // A replay of the same sentence at the same target is the same evidence
      // (RFC 0002 §6.3): the ledger keeps one row for it, and the accepted
      // instant would otherwise make every replay a new record.
      const existing = ctx.db
        .query<{ event_id: string }, [string, string]>(
          `SELECT event_id FROM events
         WHERE connector_id = ? AND source_record_id = ?
         ORDER BY accepted_at LIMIT 1`,
        )
        .get(CORRECTION_CONNECTOR, sourceRecordId);
      if (existing !== null) {
        const marker = ctx.db
          .query<{ request_digest: string }, [string]>(
            "SELECT request_digest FROM native_owner_evidence WHERE event_id=?",
          )
          .get(existing.event_id);
        if (marker === null || marker.request_digest !== requestDigest)
          throw new ServeError(
            "invalid_arguments",
            "correction recording conflicts with existing evidence",
          );
        return existing.event_id;
      }

      const stored = accept(ctx.db, {
        schema: "kizuki.event/v1",
        connector_id: CORRECTION_CONNECTOR,
        source_record_id: sourceRecordId,
        kind: CORRECTION_KIND,
        occurred_at: at,
        observed_at: at,
        text: statement,
        subjects: [],
        sensitivity_hint: "private",
        deleted: false,
        attachments: [],
        metadata: {},
      });
      if (stored.status === "stored") {
        ctx.db
          .query(
            "INSERT INTO native_owner_evidence VALUES (?, 'correction', ?, ?, 'recorded')",
          )
          .run(stored.event.event_id, requestDigest, at);
        return stored.event.event_id;
      }
      throw new ServeError("error", "serving failed", {
        cause: stored.status === "error" ? stored.error : "duplicate statement",
      });
    })
    .immediate();
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

function sentence(
  superseded: number,
  subject: string,
  rewrite: { rewritten: RewrittenPage[]; unreached: string[]; failed: boolean },
): string {
  const retired =
    superseded === 0
      ? "Recorded the correction. Nothing live contradicted it."
      : `Recorded the correction and retired ${superseded} claim(s) about ${subject}.`;
  const page = rewrite.rewritten[0];
  const written =
    page === undefined
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
  return gateAsync(
    ctx,
    "correct",
    auditArguments(args),
    async ({ ctx, at }): Promise<Served<CorrectData>> => {
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
              "SELECT claim_id FROM claims WHERE EXISTS (SELECT 1 FROM json_each(claims.provenance) WHERE value=?) AND target LIKE 'correction:%' ORDER BY created_at LIMIT 1",
            )
            .get(recorded.event_id);
          const prior =
            filedRow === null ? null : getClaim(ctx.db, filedRow.claim_id);
          if (prior !== null) {
            readable(grant, [prior]);
            requireSourceEvents(ctx.db, prior.provenance, {
              owner: ctx.principal.kind === "owner",
              purpose: "correction",
            });
            ctx.db
              .query(
                "UPDATE native_owner_evidence SET filing_state='filed' WHERE event_id=?",
              )
              .run(recorded.event_id);
            return {
              canon: [],
              quoted: [],
              withheld: [],
              data: {
                receipt_id: null,
                event_id: recorded.event_id,
                claim_id: prior.claim_id,
                superseded: [],
                rewritten: [],
                ambiguous: [],
                answer:
                  "That correction was already recorded; nothing changed.",
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
      readable(grant, resolved.claims);

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
      const rewrite =
        filed.outcome === "stored"
          ? rewriteCanon(ctx, claim, [claimKeyValue])
          : { receipt_id: null, rewritten: [], unreached: [], failed: false };

      const answer =
        filed.outcome === "duplicate"
          ? "That correction was already recorded; nothing changed."
          : sentence(superseded.length, subject, rewrite);

      return {
        canon: [],
        quoted: [],
        withheld: rewrite.failed
          ? [{ id: `tool:correct`, reason: "error" }]
          : [],
        data: {
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
    },
  );
}
