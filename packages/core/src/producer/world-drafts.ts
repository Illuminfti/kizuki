import { isGroundedIdentity, type WorldAdmission, type WorldGrounding } from "../contracts/world-admission";
import { CLAIM_V2_SCHEMA, rawSubjectRefKey, validateClaimV2Semantic, type ClaimV2Assertion, type ClaimV2Object, type RawSubjectRef } from "../contracts/claim-v2";
import type { AuthorityTier, FrontmatterValue } from "../contracts/proposal";
import {
  MAX_V2_ANCHORS,
  MAX_V2_ANCHORS_PER_ITEM,
  isUtf16TextBoundary,
  type DroppedDraftV2,
  type ExtractResponseV2,
  type ProduceInputV2,
  type RichClaimDraft,
  type TextAnchor,
} from "../contracts/producer-v2";
import { mintOccurrenceId, type OccurrenceEventIdentity } from "../claims/occurrences";
import type { InsertClaimInput } from "../claims/store";
import { scrubText } from "./scrub";
import { guardClaim, literalGrounded, normalizedInstructionSpans } from "./world-guards";

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
  readonly world_admission: WorldAdmission;
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
  readonly supplied_refs: ReadonlyMap<string, RawSubjectRef>;
  /** Request-local catalog issued by Core, never copied from model output. */
  readonly grounding?: ReadonlyMap<string, WorldGrounding>;
  readonly witness_event_ids?: ReadonlySet<string>;
  /** Exact pre-scrub event windows selected and sent by the host for this response. */
  readonly sent_evidence_windows?: readonly SentEvidenceWindow[];
  readonly model_ref: string | null;
  /**
   * The host's last word on a resolved assertion, asked once per claim in
   * response order. A refusal drops the claim like any other invalid one, so
   * a draft the writer would refuse cannot wedge the decision it belongs to.
   */
  readonly admits?: (semantic: ClaimV2Assertion) => boolean;
}

export interface SentEvidenceWindow extends TextAnchor {
  readonly text: string;
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

function sentEvidenceWindows(
  context: WorldDraftContext,
  eventById: ReadonlyMap<string, WorldDraftEvent>,
): readonly SentEvidenceWindow[] {
  const raw = context.sent_evidence_windows;
  if (raw === undefined || raw.length === 0) return [];
  const seen = new Set<string>(), windows: SentEvidenceWindow[] = [];
  for (const window of raw) {
    const event = eventById.get(window.event_id);
    if (event === undefined || seen.has(window.event_id) || !Number.isSafeInteger(window.start_utf16) ||
        !Number.isSafeInteger(window.end_utf16) || window.start_utf16 < 0 || window.end_utf16 <= window.start_utf16 ||
        window.end_utf16 > event.text.length || !isUtf16TextBoundary(event.text, window.start_utf16) ||
        !isUtf16TextBoundary(event.text, window.end_utf16) || event.text.slice(window.start_utf16, window.end_utf16) !== window.text ||
        scrubText(window.text).redactions.length > 0) return [];
    seen.add(window.event_id);
    windows.push(window);
  }
  return windows;
}

function within(anchor: TextAnchor, window: SentEvidenceWindow): boolean {
  return anchor.event_id === window.event_id && anchor.start_utf16 >= window.start_utf16 && anchor.end_utf16 <= window.end_utf16;
}

/**
 * Adds only the host's exact sent context to an already-grounded attributed
 * literal, including a holder-attributed suggestion. This runs after guardClaim,
 * so it can explain a role witness but never rescue a bad fact or restore a
 * downgraded interpretation.
 */
function addSentAttributionContext(
  guarded: ClaimV2Assertion,
  original: ClaimV2Assertion,
  windows: () => readonly SentEvidenceWindow[],
  eventById: ReadonlyMap<string, WorldDraftEvent>,
): ClaimV2Assertion | null {
  const attributed = ["reported", "quoted"].includes(guarded.perspective.mode) ||
    (guarded.perspective.mode === "suggested" && guarded.perspective.holder !== null);
  if (guarded.object.kind !== "literal" || !attributed ||
      [original.perspective.holder, original.perspective.speaker, original.perspective.addressee].every(role => role === null) ||
      original.perspective.anchors.length === 0) return guarded;
  const literal = guarded.object.value;
  const eligible = windows().filter(window => {
    const facts = original.anchors.filter(anchor => within(anchor, window));
    const roles = original.perspective.anchors;
    const event = eventById.get(window.event_id);
    return event !== undefined && roles.length > 0 && roles.every(anchor => within(anchor, window)) && literalGrounded(literal,
      facts.map(anchor => event.text.slice(anchor.start_utf16, anchor.end_utf16)));
  });
  if (eligible.length !== 1) return guarded;
  const window = eligible[0]!, anchor = { event_id: window.event_id, start_utf16: window.start_utf16, end_utf16: window.end_utf16 };
  const anchors = [...new Map([...guarded.perspective.anchors, anchor].map(item => [anchorKey(item), item])).values()];
  if (anchors.length > MAX_V2_ANCHORS_PER_ITEM) return null;
  return anchors.length === guarded.perspective.anchors.length
    ? guarded
    : { ...guarded, perspective: { ...guarded.perspective, anchors } };
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
  let normalizedWindows: readonly SentEvidenceWindow[] | undefined;
  const windows = () => normalizedWindows ??= sentEvidenceWindows(context, eventById);

  const supplied = new Map(input.supplied_refs.map(ref => [ref.id, ref.anchors]));
  if (supplied.size !== input.supplied_refs.length || context.supplied_refs.size !== supplied.size) fail("supplied handle set differs from quoted input");
  for (const [handle, raw] of context.supplied_refs) {
    const anchors = supplied.get(handle);
    if (anchors === undefined || (!context.grounding?.has(handle) && (raw.kind !== "supplied" || !("namespace" in raw) || raw.namespace === null))) fail("supplied handle is not a qualified trusted raw subject");
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
  let identity = false;
  let usedGrounding = new Map<string, WorldGrounding>();
  const resolve = (ref: { readonly kind: "mention" | "supplied"; readonly id: string }, claimAnchors: ReadonlySet<string>): RawSubjectRef => {
    if (ref.kind === "supplied") {
      const raw = context.supplied_refs.get(ref.id);
      const anchors = supplied.get(ref.id);
      if (raw === undefined || anchors === undefined || raw.kind !== "supplied" || !("namespace" in raw) || context.grounding?.has(ref.id)) fail("supplied reference is unsupported by claim evidence");
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
    // Response-local nominations carry no authority: never follow their chains
    // or change the occurrence selected by this mention's own evidence.
    // Other nominations still take the strict host-grounding path.
    if (identity && mention.candidate_refs.some(candidate => candidate.kind !== "mention")) {
      const candidate = mention.candidate_refs.length === 1 && mention.candidate_refs[0]!.kind === "supplied"
        ? context.grounding?.get(mention.candidate_refs[0]!.id) : undefined;
      if (!candidate) fail("identity candidate is not a host-issued endpoint");
      usedGrounding.set(rawSubjectRefKey(candidate.endpoint), candidate);
      return candidate.endpoint;
    }
    return { kind: "occurrence", id: mintOccurrenceId(event, event.source_key, mention.anchor) };
  };

  const instructionSpanCache = new Map<string, string[]>();
  const instructionSpansOf = (eventId: string): string[] => {
    let spans = instructionSpanCache.get(eventId);
    if (spans === undefined) instructionSpanCache.set(eventId, spans = normalizedInstructionSpans(eventById.get(eventId)!.text));
    return spans;
  };
  const dropped: DroppedDraftV2[] = [];
  let preparedAnchors = 0;
  const drafts = response.claims.flatMap(claim => {
    identity = ["concept.same_as", "concept.distinguished_from"].includes(claim.predicate);
    usedGrounding = new Map();
    const anchors = completeAnchors(claim);
    if (context.witness_event_ids && anchors.some(a => !context.witness_event_ids!.has(a.event_id))) {
      dropped.push({ reason: "invalid_claim", id: claim.id }); return [];
    }
    const anchorKeys = new Set(anchors.map(anchorKey));
    if (anchors.length === 0 || !anchors.every(anchor => eventById.has(anchor.event_id))) fail("claim has an out-of-source anchor");
    // World support comes from one source. A claim citing records of two
    // sources can never be admitted; journaling it would wedge the batch.
    if (new Set(anchors.map(anchor => eventById.get(anchor.event_id)!.source_key)).size !== 1) return [];
    const resolved: ClaimV2Assertion = {
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
    if (!validateClaimV2Semantic(resolved).ok) {
      dropped.push({ reason: "invalid_claim", id: claim.id });
      return [];
    }
    // The model's literal is checked against the exact text it cited, so what
    // it wrote about the record cannot outrank what the record says.
    const guarded = guardClaim(resolved, claim.body, {
      spans: anchors.map(anchor => eventById.get(anchor.event_id)!.text.slice(anchor.start_utf16, anchor.end_utf16)),
      instructionSpans: [...new Set(anchors.map(anchor => anchor.event_id))].flatMap(instructionSpansOf),
    });
    const semantic = guarded === null ? null : addSentAttributionContext(guarded, resolved, windows, eventById);
    if (semantic === null || !validateClaimV2Semantic(semantic).ok) {
      dropped.push({ reason: "invalid_claim", id: claim.id });
      return [];
    }
    if ((usedGrounding.size > 0 || (identity && (context.grounding?.size ?? 0) > 0)) && (usedGrounding.size !== 2 || !isGroundedIdentity(semantic))) {
      dropped.push({ reason: "invalid_claim", id: claim.id }); return [];
    }
    const semanticAnchors = semantic.anchors.length + semantic.perspective.anchors.length;
    if (preparedAnchors + semanticAnchors > MAX_V2_ANCHORS) {
      dropped.push({ reason: "invalid_claim", id: claim.id });
      return [];
    }
    if (context.admits?.(resolved) === false) {
      dropped.push({ reason: "invalid_claim", id: claim.id });
      return [];
    }
    preparedAnchors += semanticAnchors;
    const provenance = [...new Set(anchors.map(anchor => anchor.event_id))].sort();
    const admission: WorldAdmission = {
      ...(usedGrounding.size === 0 ? { schema: "kizuki.world-admission/v1" as const }
        : { schema: "kizuki.world-admission/v2" as const, grounding: [...usedGrounding.values()].sort((a, b) => rawSubjectRefKey(a.endpoint) < rawSubjectRefKey(b.endpoint) ? -1 : 1) }),
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
