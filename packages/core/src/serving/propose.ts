import type { Grant } from "../agents";
import { isRegisteredPredicate } from "../claims/predicates";
import { insertClaim } from "../claims/store";
import type { ClaimPolarity, FrontmatterValue } from "../contracts/proposal";
import { isPlainObject } from "../util/validate";
import { PAGE_TYPES } from "../vault/schema";
import { enumOf, identifier, idList, text } from "./arguments";
import { auditArguments, claimsIo, gateAsync } from "./gate";
import type { Served } from "./gate";
import { eventDecision, readEventFacts } from "./ledger";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

/** `purge_review` is filed by purge itself, never by a producer. */
export const PROPOSE_KINDS = [
  "entity",
  "claim",
  "edit",
  "merge",
  "deletion",
] as const;

/**
 * The writer sets these. `taint` in particular is the label that decides
 * whether the body may leave a blockquote, so a producer that could set it
 * would be labelling its own untrusted text as produced prose.
 */
const RESERVED_KEYS = ["id", "status", "sensitivity", "sources", "taint"];
const FRONTMATTER_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_BODY_CHARS = 65_536;
const MAX_TARGET_CHARS = 256;
const MAX_PROVENANCE = 64;
const MAX_SUBJECTS = 16;
const MAX_OBJECT_CHARS = 1_024;
export const CLAIM_POLARITIES = ["positive", "negative"] as const;
const MAX_FRONTMATTER_KEYS = 32;
const MAX_FRONTMATTER_STRING = 4_096;
const MAX_FRONTMATTER_ITEMS = 32;
/**
 * The per-value bounds multiply: 32 keys of 32 entries of 4 096 characters
 * is a 4 MB row a single call could file. The whole bag is bounded too.
 */
const MAX_FRONTMATTER_CHARS = 16_384;

export interface ProposeArgs {
  kind: (typeof PROPOSE_KINDS)[number];
  target?: string | null;
  body: string;
  /** An array value is `string[]`: the vault writes no other array. */
  frontmatter?: Record<string, string | number | boolean | string[]>;
  subjects?: string[];
  /** The claim's own subject; defaults to the first of `subjects`. */
  subject?: string;
  /** A registered predicate. With a subject it forms the conflict key. */
  predicate?: string;
  object?: string;
  polarity?: ClaimPolarity;
  provenance: string[];
  confidence?: number;
}

export interface ProposeData {
  /**
   * `stored` is live, `duplicate` is an idempotent refile, `skipped` lost to
   * a claim of higher authority, `contested` sits beside one of equal
   * standing. None of them waits for a person.
   */
  outcome: "stored" | "duplicate" | "skipped" | "contested";
  claim_id: string;
  /** Claims this one retired, by id. Empty for every other outcome. */
  superseded: string[];
}

function refuse(field: string, rule: string): ServeError {
  return new ServeError(
    "invalid_arguments",
    `invalid arguments: ${field}: ${rule}`,
  );
}

function confidenceOf(value: unknown): number {
  if (value === undefined) return 0.5;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw refuse("confidence", "must be a number between 0 and 1");
  }
  return value;
}

interface CharBudget {
  spent: number;
}

function frontmatterString(value: string, budget: CharBudget): void {
  const length = Array.from(value).length;
  if (length > MAX_FRONTMATTER_STRING) {
    throw refuse("frontmatter", "a string value is too long");
  }
  budget.spent += length;
  if (budget.spent > MAX_FRONTMATTER_CHARS) {
    throw refuse("frontmatter", "is too large");
  }
}

/**
 * The vault serializer writes string arrays only, so a numeric or boolean
 * entry could never reach canon. Refusing it here beats filing a proposal
 * that the writer would later choke on.
 */
function frontmatterValue(value: unknown, budget: CharBudget): FrontmatterValue {
  if (Array.isArray(value)) {
    if (value.length > MAX_FRONTMATTER_ITEMS) {
      throw refuse("frontmatter", "an array value holds too many entries");
    }
    const entries: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw refuse("frontmatter", "an array value must hold only strings");
      }
      frontmatterString(entry, budget);
      entries.push(entry);
    }
    return entries;
  }
  if (typeof value === "string") {
    frontmatterString(value, budget);
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw refuse("frontmatter", "a number value must be finite");
    }
    return value;
  }
  if (typeof value !== "boolean") {
    throw refuse(
      "frontmatter",
      "a value must be a string, number, boolean or string array",
    );
  }
  return value;
}

function validateFrontmatter(
  grant: Grant,
  frontmatter: unknown,
): Record<string, FrontmatterValue> {
  // A string, a number or an array all answer `Object.keys` without
  // complaint, and the store would write the result verbatim: every later
  // reader of the table then fails on a value that is not an object.
  if (!isPlainObject(frontmatter)) {
    throw refuse("frontmatter", "must be an object");
  }
  const keys = Object.keys(frontmatter);
  if (keys.length > MAX_FRONTMATTER_KEYS) {
    throw refuse(
      "frontmatter",
      `must hold at most ${MAX_FRONTMATTER_KEYS} keys`,
    );
  }
  const shaped: Record<string, FrontmatterValue> = {};
  const budget: CharBudget = { spent: 0 };
  for (const key of keys) {
    if (!FRONTMATTER_KEY.test(key)) {
      throw refuse("frontmatter", "a key is not usable");
    }
    // The writer sets these; refusing now beats a proposal that can never land.
    if (RESERVED_KEYS.includes(key)) {
      throw refuse(
        "frontmatter",
        "a key is set by the writer, not by a producer",
      );
    }
    budget.spent += key.length;
    shaped[key] = frontmatterValue(frontmatter[key], budget);
  }

  const type = shaped["type"];
  if (type !== undefined) {
    const pageType = enumOf("frontmatter.type", type, PAGE_TYPES);
    if (grant.types !== null && !grant.types.includes(pageType)) {
      throw new ServeError(
        "type_out_of_scope",
        "frontmatter.type outside the grant",
      );
    }
  }
  return shaped;
}

/**
 * The claim's subject is the first half of its conflict key, so a scoped
 * grant has to bound it exactly as it bounds `subjects`.
 */
function subjectOf(
  grant: Grant,
  requestedSubject: string | undefined,
  subjects: string[] | undefined,
): string | undefined {
  if (requestedSubject === undefined) return subjects?.[0];
  const subject = identifier("subject", requestedSubject);
  if (grant.subjects !== null && !grant.subjects.includes(subject)) {
    throw new ServeError("subject_out_of_scope", "subject outside the grant");
  }
  return subject;
}

/**
 * A predicate outside the registry would reach the claim store as an
 * engine failure; refusing it here keeps it a caller error. Without a
 * subject there is no conflict key, so a claim that asks for one and gets
 * none would be filed as something it is not.
 */
function predicateOf(
  requested: string | undefined,
  subject: string | undefined,
): string | undefined {
  if (requested === undefined) return undefined;
  const predicate = identifier("predicate", requested);
  if (!isRegisteredPredicate(predicate)) {
    throw refuse("predicate", "must be a registered predicate");
  }
  if (subject === undefined) {
    throw refuse("predicate", "needs a subject to key the claim");
  }
  return predicate;
}

/**
 * An agent cannot cite what it cannot read: every provenance id has to be a
 * live event this principal is allowed to quote, so a proposal can never
 * launder a withheld record into the claim store. The offending id stays out
 * of the message and reaches the owner through the audit row instead.
 */
function validateProvenance(ctx: ServeContext, provenance: string[]): void {
  const facts = readEventFacts(ctx.db, provenance);
  for (const id of provenance) {
    const event = facts.get(id);
    if (event === undefined) {
      throw refuse(
        "provenance",
        "must name live events this principal can read",
      );
    }
    const decision = eventDecision(ctx.principal.grant, event);
    if (!decision.allow) {
      throw new ServeError(decision.reason, "provenance outside the grant");
    }
  }
}

export async function servePropose(
  ctx: ServeContext,
  args: ProposeArgs,
): Promise<Envelope<ProposeData>> {
  return gateAsync(
    ctx,
    "propose",
    auditArguments(args),
    async ({ ctx }): Promise<Served<ProposeData>> => {
    const principal = ctx.principal;
    // A proposal has to carry a distinct identity in `producer`: agents
    // propose claims, and the owner speaks as the owner elsewhere.
    if (principal.kind === "owner") {
      throw new ServeError(
        "tool_not_granted",
        "propose requires an agent principal",
      );
    }
    const grant = principal.grant;

    const kind = enumOf("kind", args.kind, PROPOSE_KINDS);
    const body = text("body", args.body, MAX_BODY_CHARS);
    const target =
      args.target === undefined || args.target === null
        ? null
        : text("target", args.target, MAX_TARGET_CHARS);
    const provenance = idList("provenance", args.provenance, MAX_PROVENANCE);
    if (provenance.length === 0) {
      throw refuse("provenance", "must name at least one event");
    }
    const frontmatter = validateFrontmatter(
      grant,
      args.frontmatter === undefined ? {} : args.frontmatter,
    );
    const requested =
      args.subjects === undefined
        ? undefined
        : idList("subjects", args.subjects, MAX_SUBJECTS);
    if (
      grant.subjects !== null &&
      (requested === undefined || requested.length === 0)
    ) {
      throw new ServeError(
        "subject_out_of_scope",
        "subjects are required by the grant",
      );
    }
    for (const subject of requested ?? []) {
      if (grant.subjects !== null && !grant.subjects.includes(subject)) {
        throw new ServeError(
          "subject_out_of_scope",
          "subjects outside the grant",
        );
      }
    }
    const confidence = confidenceOf(args.confidence);
    const subject = subjectOf(grant, args.subject, requested);
    const predicate = predicateOf(args.predicate, subject);

    validateProvenance(ctx, provenance);

    const filed = await insertClaim(
      claimsIo(ctx),
      {
        kind,
        target,
        body,
        frontmatter,
        provenance,
        subjects: requested ?? [],
        producer: `agent:${principal.agent.name}`,
        confidence,
        intent: "propose",
        // An agent's body is derived from captured records and is never
        // trusted as produced prose: the writer has to keep it quoted.
        taint: "quoted",
        ...(subject === undefined ? {} : { subject }),
        ...(predicate === undefined ? {} : { predicate }),
        ...(args.object === undefined
          ? {}
          : { object: text("object", args.object, MAX_OBJECT_CHARS) }),
        ...(args.polarity === undefined
          ? {}
          : {
              polarity: enumOf("polarity", args.polarity, CLAIM_POLARITIES),
            }),
      },
    );

    const claim =
      filed.outcome === "contested" ? filed.incoming : filed.claim;
    const data: ProposeData = {
      outcome: filed.outcome,
      claim_id: claim.claim_id,
      superseded:
        filed.outcome === "stored"
          ? filed.superseded.map((entry) => entry.claim_id)
          : [],
    };
    return {
      canon: [],
      quoted: [],
      withheld: [],
      data,
      audit_ids: { claim_ids: [claim.claim_id] },
    };
  },
  );
}
