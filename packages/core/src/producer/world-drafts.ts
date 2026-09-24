import { CLAIM_V2_SCHEMA, rawSubjectRefKey, validateClaimV2Semantic, type ClaimV2Assertion, type ClaimV2Object, type RawSubjectRef, type QualifiedSuppliedRef } from "../contracts/claim-v2";
import type { AuthorityTier, FrontmatterValue } from "../contracts/proposal";
import {
  type DroppedDraftV2,
  type ExtractResponseV2,
  type ProduceInputV2,
  type RichClaimDraft,
  type TextAnchor,
} from "../contracts/producer-v2";
import { mintOccurrenceId, type OccurrenceEventIdentity } from "../claims/occurrences";
import type { InsertClaimInput } from "../claims/store";

/** The portion of the shared writer input produced by the model adapter. */
export interface WorldDraftInsert extends InsertClaimInput {
  readonly kind: "claim";
  readonly body: string;
  readonly frontmatter: Record<string, FrontmatterValue>;
  readonly provenance: string[];
  readonly producer: "model";
  readonly model_ref: string | null;
  readonly confidence: number;
  readonly sensitivity: RichClaimDraft["sensitivity"];
  readonly semantic: ClaimV2Assertion;
  readonly world_admission: {
    readonly schema: "kizuki.world-admission/v1";
    readonly semantic: ClaimV2Assertion;
    readonly rendering: { readonly body: string; readonly frontmatter: Record<string, FrontmatterValue> };
    /** Recomputed by the shared writer. */
    readonly authority: AuthorityTier;
    /** Recomputed and clamped by the shared writer. */
    readonly confidence: number;
    readonly epistemicKind: "model_inference";
  };
}

export interface WorldDraftEvent extends OccurrenceEventIdentity {
  readonly source_key: string | null;
  readonly text: string;
  /** Raw event subjects, supplied by the host after it has verified event identity. */
  readonly subjects: readonly RawSubjectRef[];
}

/** Writer inputs, and the parsed claims that resolution declined without failing the decision. */
export interface WorldDrafts {
  readonly drafts: readonly WorldDraftInsert[];
  readonly dropped: readonly DroppedDraftV2[];
}

export interface WorldDraftContext {
  /** Immutable event revisions selected by the host, keyed by event id. */
  readonly events: readonly WorldDraftEvent[];
  /** Host-created capability map; keys are request-local supplied handles only. */
  readonly supplied_refs: ReadonlyMap<string, QualifiedSuppliedRef>;
  readonly model_ref: string | null;
}

function anchorKey(anchor: TextAnchor): string {
  return `${anchor.event_id}\u0000${anchor.start_utf16}\u0000${anchor.end_utf16}`;
}

function fail(detail: string): never {
  throw new Error(`world draft rejected: ${detail}`);
}

function completeAnchors(claim: RichClaimDraft): readonly TextAnchor[] {
  const anchors = [...claim.anchors, ...claim.perspective.anchors];
  return [...new Map(anchors.map(anchor => [anchorKey(anchor), anchor])).values()];
}

/**
 * Converts a validated producer-v2 response into a writer input without making
 * identity or authority decisions. The writer must still revalidate all
 * occurrence proofs inside its transaction. A claim that parsed but does not
 * resolve to a canonical typed assertion is dropped as `invalid_claim`, like
 * any other invalid claim, so it cannot fail its siblings' decision.
 */
export function prepareWorldDrafts(
  response: ExtractResponseV2,
  input: ProduceInputV2,
  context: WorldDraftContext,
): WorldDrafts {
  const eventById = new Map(context.events.map(event => [event.event_id, event]));
  if (eventById.size !== context.events.length || new Set(input.events.map(event => event.event_id)).size !== input.events.length) {
    fail("duplicate event identity");
  }
  for (const event of input.events) {
    const trusted = eventById.get(event.event_id);
    if (trusted === undefined || trusted.text !== event.text) fail("event is not an immutable quoted input");
  }
  if (eventById.size !== input.events.length) fail("untrusted event is outside quoted input");

  const supplied = new Map(input.supplied_refs.map(ref => [ref.id, ref.anchors]));
  if (supplied.size !== input.supplied_refs.length || context.supplied_refs.size !== supplied.size) fail("supplied handle set differs from quoted input");
  for (const [handle, raw] of context.supplied_refs) {
    const anchors = supplied.get(handle);
    if (anchors === undefined || raw.kind !== "supplied" || raw.namespace === undefined || raw.namespace === null) fail("supplied handle is not a qualified trusted raw subject");
    const cited = new Set(anchors.map(anchorKey));
    if (cited.size !== anchors.length) fail("supplied handle has duplicate anchors");
  }

  for (const mention of response.mentions) {
    const event = eventById.get(mention.anchor.event_id);
    if (event === undefined || mention.anchor.start_utf16 < 0 || mention.anchor.end_utf16 <= mention.anchor.start_utf16 || mention.anchor.end_utf16 > event.text.length) {
      fail("mention anchor is outside immutable event input");
    }
  }
  const mentions = new Map(response.mentions.map(mention => [mention.id, mention]));
  if (mentions.size !== response.mentions.length) fail("duplicate mention id");
  const resolve = (ref: { readonly kind: "mention" | "supplied"; readonly id: string }, claimAnchors: ReadonlySet<string>): RawSubjectRef => {
    if (ref.kind === "supplied") {
      const raw = context.supplied_refs.get(ref.id);
      const anchors = supplied.get(ref.id);
      if (raw === undefined || anchors === undefined) fail("supplied reference is unsupported by claim evidence");
      const cited = anchors.filter(anchor => claimAnchors.has(anchorKey(anchor)));
      if (cited.length === 0) fail("supplied reference is unsupported by claim evidence");
      if (!cited.some(anchor => {
        const event = eventById.get(anchor.event_id);
        return event !== undefined && event.connector_id === raw.namespace.connector_id && event.source_key === raw.namespace.source_key &&
          event.subjects.some(subject => subject.kind === "supplied" && subject.id === raw.id);
      })) {
        fail("supplied raw subject is absent from its cited event");
      }
      return raw;
    }
    const mention = mentions.get(ref.id);
    if (mention === undefined || !claimAnchors.has(anchorKey(mention.anchor))) fail("mention is unsupported by claim evidence");
    const event = eventById.get(mention.anchor.event_id);
    if (event === undefined) fail("mention anchor is outside immutable event input");
    return { kind: "occurrence", id: mintOccurrenceId(event, event.source_key, mention.anchor) };
  };

  const dropped: DroppedDraftV2[] = [];
  const drafts = response.claims.flatMap(claim => {
    const anchors = completeAnchors(claim);
    const anchorKeys = new Set(anchors.map(anchorKey));
    if (anchors.length === 0 || !anchors.every(anchor => eventById.has(anchor.event_id))) fail("claim has an out-of-source anchor");
    // World support comes from one source. A claim citing records of two
    // sources can never be admitted; journaling it would wedge the batch.
    if (new Set(anchors.map(anchor => eventById.get(anchor.event_id)!.source_key)).size !== 1) return [];
    const semantic: ClaimV2Assertion = {
      schema: CLAIM_V2_SCHEMA,
      discriminator: "assertion",
      subject: resolve(claim.subject, anchorKeys),
      predicate: claim.predicate,
      object: toObject(claim.object, resolve, anchorKeys),
      perspective: {
        holder: claim.perspective.holder === null ? null : resolve(claim.perspective.holder, anchorKeys),
        speaker: claim.perspective.speaker === null ? null : resolve(claim.perspective.speaker, anchorKeys),
        addressee: claim.perspective.addressee === null ? null : resolve(claim.perspective.addressee, anchorKeys),
        mode: claim.perspective.mode,
        interpretation: claim.perspective.interpretation,
        anchors: claim.perspective.anchors,
      },
      context: [...claim.context.map(ref => resolve(ref, anchorKeys))].sort((left, right) => {
        const a = rawSubjectRefKey(left), b = rawSubjectRefKey(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }),
      polarity: claim.polarity,
      valid_from: claim.valid_from,
      valid_to: claim.valid_to,
      temporal_basis: claim.temporal_basis,
      anchors: claim.anchors,
    };
    if (!validateClaimV2Semantic(semantic).ok) {
      dropped.push({ reason: "invalid_claim", id: claim.id });
      return [];
    }
    const provenance = [...new Set(anchors.map(anchor => anchor.event_id))].sort();
    const admission = {
      schema: "kizuki.world-admission/v1" as const,
      semantic,
      rendering: { body: claim.body, frontmatter: {} },
      authority: "model_inference" as AuthorityTier,
      confidence: claim.confidence,
      epistemicKind: "model_inference" as const,
    };
    return [{ kind: "claim" as const, body: claim.body, frontmatter: {}, provenance, producer: "model" as const, model_ref: context.model_ref,
      confidence: claim.confidence, sensitivity: claim.sensitivity, semantic, world_admission: admission }];
  });
  return { drafts, dropped };
}

function toObject(
  object: RichClaimDraft["object"],
  resolve: (ref: { readonly kind: "mention" | "supplied"; readonly id: string }, anchors: ReadonlySet<string>) => RawSubjectRef,
  anchors: ReadonlySet<string>,
): ClaimV2Object {
  if (object.kind === "literal") return object;
  if (object.kind === "vocabulary") return object;
  return { kind: "subject", ref: resolve(object.ref, anchors) };
}
