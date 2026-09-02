import { SENSITIVITY_ORDER } from "../agents";
import type { Grant, Sensitivity } from "../agents";
import { getClaim, insertClaim, listClaims } from "../claims/store";
import type { Claim, ClaimPolarity } from "../contracts/proposal";
import { accept } from "../ledger/ledger";
import { identifier, text } from "./arguments";
import { auditArguments, claimsIo, gateAsync, principalName } from "./gate";
import type { Served } from "./gate";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

const MAX_STATEMENT_CHARS = 2_000;
const CLAIM_KEY = /^[0-9a-f]{64}$/;
/** The owner's own words enter the ledger on an internal connector. */
export const CORRECTION_CONNECTOR = "kizuki.owner";
export const CORRECTION_KIND = "correction";

export interface CorrectTarget {
  claim_id?: string;
  claim_key?: string;
  subject?: string;
}

export interface CorrectArgs {
  /** The owner's sentence, stored verbatim and never read as instruction. */
  statement: string;
  target?: CorrectTarget;
}

export interface CorrectData {
  /** The statement's ledger event; null when nothing was recorded. */
  event_id: string | null;
  /** The correction claim; null when the target was ambiguous. */
  claim_id: string | null;
  superseded: { claim_id: string; claim_key: string }[];
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

/** Live, keyed claims grouped by the key a correction supersedes. */
function groupByKey(claims: Claim[]): Map<string, Claim[]> {
  const groups = new Map<string, Claim[]>();
  for (const claim of claims) {
    const key = claim.claim_key;
    if (key === null) continue;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [claim]);
    else bucket.push(claim);
  }
  return groups;
}

/**
 * Resolution is exact or it does not happen. A model would be needed to read
 * an implicit target out of the sentence, and none is bound here, so an
 * unnamed target fails closed instead of guessing which claim to retire.
 */
function resolve(ctx: ServeContext, target: CorrectTarget | undefined): Claim[] {
  if (target === undefined) {
    throw refuse("target", "name a claim, a claim key or a subject");
  }
  const named = [target.claim_id, target.claim_key, target.subject].filter(
    (value) => value !== undefined,
  );
  if (named.length !== 1) {
    throw refuse("target", "name exactly one of claim_id, claim_key, subject");
  }

  if (target.claim_id !== undefined) {
    const claim = getClaim(
      ctx.db,
      identifier("target.claim_id", target.claim_id),
    );
    if (claim === null || claim.status !== "live") {
      throw refuse("target.claim_id", "names no live claim");
    }
    if (claim.claim_key === null) {
      throw refuse(
        "target.claim_id",
        "names a claim with no predicate to correct",
      );
    }
    return [claim];
  }

  if (target.claim_key !== undefined) {
    if (!CLAIM_KEY.test(target.claim_key)) {
      throw refuse("target.claim_key", "must be a claim key");
    }
    const claims = listClaims(ctx.db, {
      claim_key: target.claim_key,
      status: "live",
    });
    if (claims.length === 0) {
      throw refuse("target.claim_key", "names no live claim");
    }
    return claims;
  }

  const subject = identifier("target.subject", target.subject);
  const claims = listClaims(ctx.db, { status: "live" }).filter(
    (claim) => claim.subject === subject && claim.claim_key !== null,
  );
  if (claims.length === 0) {
    throw refuse("target.subject", "names no live keyed claim");
  }
  return claims;
}

/** A correction may not reach further than the reader could read. */
function readable(grant: Grant, claims: Claim[]): void {
  for (const claim of claims) {
    if (
      SENSITIVITY_ORDER[claim.sensitivity] > SENSITIVITY_ORDER[grant.ceiling]
    ) {
      throw new ServeError("above_ceiling", "the target is above the ceiling");
    }
    if (
      claim.subject !== null &&
      grant.subjects !== null &&
      !grant.subjects.includes(claim.subject)
    ) {
      throw new ServeError(
        "subject_out_of_scope",
        "the target is outside the grant",
      );
    }
  }
}

function recordStatement(
  ctx: ServeContext,
  statement: string,
  subject: string | null,
  at: string,
): string {
  const sourceRecordId = new Bun.CryptoHasher("sha256")
    .update(statement)
    .update("\0")
    .update(subject ?? "")
    .digest("hex");
  // A repeat of the same sentence about the same subject is the same
  // evidence (RFC 0002 §6.3): the ledger keeps one row for it, and the
  // accepted instant would otherwise make every repeat a new record.
  const existing = ctx.db
    .query<{ event_id: string }, [string, string]>(
      `SELECT event_id FROM events
         WHERE connector_id = ? AND source_record_id = ?
         ORDER BY accepted_at LIMIT 1`,
    )
    .get(CORRECTION_CONNECTOR, sourceRecordId);
  if (existing !== null) return existing.event_id;

  const stored = accept(ctx.db, {
    schema: "kizuki.event/v1",
    connector_id: CORRECTION_CONNECTOR,
    source_record_id: sourceRecordId,
    kind: CORRECTION_KIND,
    occurred_at: at,
    observed_at: at,
    text: statement,
    subjects: subject === null ? [] : [{ subject_id: subject, role: "about" }],
    sensitivity_hint: "private",
    deleted: false,
    attachments: [],
    metadata: {},
  });
  if (stored.status === "stored") return stored.event.event_id;
  throw new ServeError("error", "serving failed", {
    cause: stored.status === "error" ? stored.error : "duplicate statement",
  });
}

function opposite(polarity: ClaimPolarity): ClaimPolarity {
  return polarity === "positive" ? "negative" : "positive";
}

function ambiguousAnswer(groups: Map<string, Claim[]>): CorrectData {
  return {
    event_id: null,
    claim_id: null,
    superseded: [],
    ambiguous: [...groups.entries()].map(([claim_key, claims]) => ({
      claim_key,
      claim_ids: claims.map((claim) => claim.claim_id),
    })),
    answer:
      `Nothing was corrected: ${groups.size} claim groups match that ` +
      "subject. Name one with claim_id or claim_key.",
  };
}

/**
 * The owner's correction, and the only write that outranks everything else
 * in the store. It supersedes the contradicted claims and answers with what
 * it retired. Rewriting the canon pages bound to those claims belongs to the
 * receipted writer, which no revision of this tree binds yet; no page is
 * bound to a claim here, so nothing is silently left half-done.
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
      const candidates = resolve(ctx, args.target);
      readable(grant, candidates);

      const groups = groupByKey(candidates);
      if (groups.size > 1) {
        return {
          canon: [],
          quoted: [],
          withheld: [],
          data: ambiguousAnswer(groups),
        };
      }

      const [entry] = [...groups.entries()];
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

      const eventId = recordStatement(ctx, statement, subject, at);
      const sensitivity: Sensitivity = first.sensitivity;
      const filed = await insertClaim(
        claimsIo(ctx),
        {
          kind: "claim",
          body: statement,
          provenance: [eventId],
          subjects: [subject],
          subject,
          predicate,
          // The owner says the recorded reading is wrong; the object it
          // should carry instead needs a model this path does not bind.
          polarity: opposite(first.polarity),
          producer:
            ctx.principal.kind === "owner"
              ? "owner"
              : `agent:${ctx.principal.agent.name}`,
          confidence: 1,
          intent: "correct",
          taint: "clean",
          sensitivity,
        },
      );

      const claim = filed.outcome === "contested" ? filed.incoming : filed.claim;
      const superseded =
        filed.outcome === "stored"
          ? filed.superseded.map((retired) => ({
              claim_id: retired.claim_id,
              claim_key: claimKeyValue,
            }))
          : [];
      const answer =
        filed.outcome === "duplicate"
          ? "That correction was already recorded; nothing changed."
          : superseded.length === 0
            ? "Recorded the correction. Nothing live contradicted it."
            : `Recorded the correction and retired ${superseded.length} ` +
              `claim(s) about ${subject}.`;

      return {
        canon: [],
        quoted: [],
        withheld: [],
        data: {
          event_id: eventId,
          claim_id: claim.claim_id,
          superseded,
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
