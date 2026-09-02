import type { Grant } from "../agents";
import { fileProposal } from "../staging/proposals";
import type { FrontmatterValue } from "../staging/proposals";
import { PAGE_TYPES } from "../vault/schema";
import { enumOf, idList, text } from "./arguments";
import { auditArguments, gate } from "./gate";
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

const RESERVED_KEYS = ["id", "status", "sensitivity", "sources"];
const FRONTMATTER_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_BODY_CHARS = 65_536;
const MAX_TARGET_CHARS = 256;
const MAX_PROVENANCE = 64;
const MAX_SUBJECTS = 16;
const MAX_FRONTMATTER_KEYS = 32;
const MAX_FRONTMATTER_STRING = 4_096;

export interface ProposeArgs {
  kind: (typeof PROPOSE_KINDS)[number];
  target?: string | null;
  body: string;
  /** An array value is `string[]`: the vault writes no other array. */
  frontmatter?: Record<string, string | number | boolean | string[]>;
  subjects?: string[];
  provenance: string[];
  confidence?: number;
}

export type ProposeData =
  | { outcome: "stored" | "duplicate"; proposal_id: string }
  | { outcome: "suppressed" };

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

function frontmatterString(value: string): void {
  if (Array.from(value).length > MAX_FRONTMATTER_STRING) {
    throw refuse("frontmatter", "a string value is too long");
  }
}

/**
 * The vault serializer writes string arrays only, so a numeric or boolean
 * entry could never reach canon. Refusing it here beats filing a proposal
 * that the writer would later choke on.
 */
function frontmatterValue(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== "string") {
        throw refuse("frontmatter", "an array value must hold only strings");
      }
      frontmatterString(entry);
    }
    return;
  }
  if (typeof value === "string") {
    frontmatterString(value);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw refuse("frontmatter", "a number value must be finite");
    }
    return;
  }
  if (typeof value !== "boolean") {
    throw refuse(
      "frontmatter",
      "a value must be a string, number, boolean or string array",
    );
  }
}

function validateFrontmatter(
  grant: Grant,
  frontmatter: Record<string, FrontmatterValue>,
): Record<string, FrontmatterValue> {
  const keys = Object.keys(frontmatter);
  if (keys.length > MAX_FRONTMATTER_KEYS) {
    throw refuse(
      "frontmatter",
      `must hold at most ${MAX_FRONTMATTER_KEYS} keys`,
    );
  }
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
    frontmatterValue(frontmatter[key]);
  }

  const type = frontmatter["type"];
  if (type !== undefined) {
    const pageType = enumOf("frontmatter.type", type, PAGE_TYPES);
    if (grant.types !== null && !grant.types.includes(pageType)) {
      throw new ServeError(
        "type_out_of_scope",
        "frontmatter.type outside the grant",
      );
    }
  }
  return frontmatter;
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

export function servePropose(
  ctx: ServeContext,
  args: ProposeArgs,
): Envelope<ProposeData> {
  return gate(ctx, "propose", auditArguments(args), ({ ctx }): Served<ProposeData> => {
    const principal = ctx.principal;
    // A proposal has to carry a distinct identity in `producer`: the owner
    // reviews and promotes, agents propose.
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
    const frontmatter = validateFrontmatter(grant, args.frontmatter ?? {});
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

    validateProvenance(ctx, provenance);

    const filed = fileProposal(ctx.db, {
      kind,
      target,
      body,
      frontmatter,
      provenance,
      subjects: requested ?? [],
      producer: `agent:${principal.agent.name}`,
      confidence,
    });

    if (filed.outcome === "suppressed") {
      return {
        canon: [],
        quoted: [],
        withheld: [],
        data: { outcome: "suppressed" },
      };
    }
    return {
      canon: [],
      quoted: [],
      withheld: [],
      data: {
        outcome: filed.outcome,
        proposal_id: filed.proposal.proposal_id,
      },
      audit_ids: { proposal_ids: [filed.proposal.proposal_id] },
    };
  });
}
