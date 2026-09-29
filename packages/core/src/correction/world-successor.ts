import type { Database } from "bun:sqlite";
import {
  CLAIM_V2_SCHEMA,
  rawSubjectNamespace,
  rawSubjectRefKey,
  type ClaimMeaning,
  type ClaimV2Assertion,
  type ClaimV2Object,
  type RawSubjectRef,
} from "../contracts/claim-v2";
import { assertionEndpoints } from "../world/allocation";
import { worldAssertionViolation } from "../world/registry-check";
import { CorrectError } from "./errors";
import type { WorldCorrection } from "./types";

/** The owner's statement is the claim's rendering and its evidence, so it must fit both. */
const STATEMENT_MAX_CHARS = 400;
const STATEMENT_MAX_BYTES = 1200;
/** Anchors play no part in the registry check, so a draft is checked before its event exists. */
const NO_EVENT = "0".repeat(26);

function refused(detail: string): CorrectError {
  return new CorrectError("correction_refused", detail);
}

/**
 * The claim a correction files, from the claim it replaces: the same subject,
 * predicate, context and roles, changed in exactly the one way its mode names,
 * valid from the moment of the correction and anchored on the owner's own
 * statement. The old claim's perspective and context are kept; only a mode
 * that says otherwise changes them.
 */
export function worldSuccessor(
  prior: ClaimMeaning,
  world: WorldCorrection,
  statement: string,
  eventId: string,
  at: string,
): ClaimV2Assertion {
  if (world.mode === "retract" && prior.polarity === "negative") {
    throw refused("retract: the claim already denies its object");
  }
  if (world.mode === "reclassify_mode" && prior.perspective.mode === world.to) {
    throw refused(`reclassify_mode: the claim is already ${world.to}`);
  }
  const anchor = { event_id: eventId, start_utf16: 0, end_utf16: statement.length };
  const roles = prior.perspective;
  const named = roles.holder !== null || roles.speaker !== null || roles.addressee !== null;
  const object: ClaimV2Object =
    world.mode === "replace_object" ? (world.object ?? { kind: "literal", value: statement }) : prior.object;
  return {
    schema: CLAIM_V2_SCHEMA,
    discriminator: "assertion",
    subject: prior.subject,
    predicate: prior.predicate,
    object,
    perspective: {
      ...roles,
      mode: world.mode === "reclassify_mode" ? world.to : roles.mode,
      interpretation: "explicit",
      anchors: named ? [anchor] : [],
    },
    context: prior.context,
    polarity: world.mode === "retract" ? "negative" : prior.polarity,
    valid_from: at,
    valid_to: null,
    temporal_basis: "observed",
    anchors: [anchor],
  };
}

/** Endpoints other than the subject, in the canonical order the native evidence records them. */
export function extraEndpoints(assertion: ClaimV2Assertion | ClaimMeaning): RawSubjectRef[] {
  const subject = rawSubjectRefKey(assertion.subject);
  return assertionEndpoints(assertion)
    .filter((ref) => rawSubjectRefKey(ref) !== subject)
    .sort((left, right) => {
      const a = rawSubjectRefKey(left),
        b = rawSubjectRefKey(right);
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

/** What a reader is told about a claim: its predicate, and its object with the ways it is held. */
export function describeAssertion(assertion: ClaimV2Assertion | ClaimMeaning): {
  readonly label: string;
  readonly value: string;
} {
  const object = assertion.object;
  const text = object.kind === "literal" ? object.value : object.kind === "vocabulary" ? object.ref.id : "a linked item";
  const denied = assertion.polarity === "negative" ? `not ${text}` : text;
  const mode = assertion.perspective.mode;
  return { label: assertion.predicate, value: mode === "asserted" ? denied : `${denied} (${mode})` };
}

function knownEndpoint(db: Database, ref: RawSubjectRef): boolean {
  return (
    db
      .query("SELECT 1 FROM semantic_bindings WHERE raw_kind=? AND raw_namespace=? AND raw_id=?")
      .get(ref.kind, rawSubjectNamespace(ref), ref.id) !== null
  );
}

export interface WorldPlan {
  readonly world: WorldCorrection;
  readonly prior: ClaimMeaning;
  /** The endpoints beyond the subject that the native evidence attests. */
  readonly endpoints: readonly RawSubjectRef[];
  build(eventId: string): ClaimV2Assertion;
}

/**
 * Everything that can be refused about a typed correction, decided before the
 * owner's statement is recorded: its size, the claim it would file, the
 * vocabulary row that claim must satisfy, and that every endpoint it names is
 * one the world already holds. A refusal leaves no native evidence behind.
 */
export function planWorldCorrection(
  db: Database,
  prior: ClaimMeaning,
  world: WorldCorrection,
  statement: string,
  at: string,
): WorldPlan {
  if (statement.length > STATEMENT_MAX_CHARS || Buffer.byteLength(statement, "utf8") > STATEMENT_MAX_BYTES) {
    throw new CorrectError(
      "statement_invalid",
      `a typed correction must fit ${STATEMENT_MAX_CHARS} characters and ${STATEMENT_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const build = (eventId: string) => worldSuccessor(prior, world, statement, eventId, at);
  const draft = build(NO_EVENT);
  if (draft.object.kind === "literal" && (draft.object.value.length === 0 || draft.object.value.length > STATEMENT_MAX_CHARS)) {
    throw refused(`object: a literal must hold 1 to ${STATEMENT_MAX_CHARS} characters`);
  }
  const violation = worldAssertionViolation(db, draft);
  if (violation !== null) throw refused(`${violation.code}: ${violation.detail}`);
  const held = new Set(assertionEndpoints(prior).map(rawSubjectRefKey));
  const endpoints = extraEndpoints(draft);
  for (const ref of endpoints) {
    if (!held.has(rawSubjectRefKey(ref)) && !knownEndpoint(db, ref)) throw refused("object: names no known node");
  }
  return { world, prior, endpoints, build };
}
