import { isRfc3339 } from "../util/time";
import { isUlid } from "../util/ulid";
import { cloneExactJson, isPlainObject, utf8ByteLength } from "../util/validate";
import type { Sensitivity } from "../agents/types";
import type { ModelUsage, ProduceResult, ProducerDiagnostic } from "./producer";
/** Closed provider contract. Durable claim/v2 is deliberately separate. */

export const PRODUCER_V2_CONTRACT = "kizuki.producer/v2" as const;

export const EXTRACT_RESPONSE_V2_SCHEMA = "kizuki.producer-response/v2" as const;

export const MAX_V2_RESPONSE_BYTES = 256 * 1024;

export const MAX_V2_MENTIONS = 64;

export const MAX_V2_CLAIMS = 128;

export const MAX_V2_ANCHORS = 256;

export const MAX_V2_REFERENCES = 1024;

export const MAX_V2_ANCHORS_PER_ITEM = 8;

export const MAX_V2_LABEL_BYTES = 512;

export const MAX_V2_LITERAL_CHARS = 400;

export const MAX_V2_BODY_CHARS = 1200;

export const MAX_V2_EVENTS = 8;

export const MAX_V2_QUOTED_UTF16 = 24000;

export const MAX_V2_TRUSTED_REFS = 256;

export interface TextAnchor {
  readonly event_id: string;
  readonly start_utf16: number;
  readonly end_utf16: number;
}

export type DraftRef = {
  readonly kind: "supplied";
  readonly id: string;
} | {
  readonly kind: "mention";
  readonly id: string;
};

export interface VocabularyRef {
  readonly kind: "vocabulary";
  readonly id: string;
}

export interface MentionDraft {
  readonly id: string;
  readonly label: string;
  readonly anchor: TextAnchor;
  readonly candidate_refs: readonly DraftRef[];
}

export type ClaimObjectDraft = {
  readonly kind: "literal";
  readonly value: string;
} | {
  readonly kind: "subject";
  readonly ref: DraftRef;
} | {
  readonly kind: "vocabulary";
  readonly ref: VocabularyRef;
};

export interface AttributedPerspectiveDraft {
  readonly holder: DraftRef | null;
  readonly speaker: DraftRef | null;
  readonly addressee: DraftRef | null;
  readonly mode: "asserted" | "quoted" | "reported" | "hypothetical" | "suggested" | "questioned" | "uncertain";
  readonly interpretation: "explicit" | "inferred";
  readonly anchors: readonly TextAnchor[];
}

export interface RichClaimDraft {
  readonly id: string;
  readonly subject: DraftRef;
  readonly predicate: string;
  readonly object: ClaimObjectDraft;
  readonly perspective: AttributedPerspectiveDraft;
  readonly context: readonly DraftRef[];
  readonly polarity: "positive" | "negative";
  readonly body: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly temporal_basis: "explicit" | "observed" | "unknown";
  readonly confidence: number;
  readonly sensitivity: Sensitivity;
  readonly anchors: readonly TextAnchor[];
}

export interface ExtractResponseV2 {
  readonly schema: typeof EXTRACT_RESPONSE_V2_SCHEMA;
  readonly mentions: readonly MentionDraft[];
  readonly claims: readonly RichClaimDraft[];
}

export interface ProducerV2SuppliedRef {
  readonly id: string;
  /** Trusted anchors which make this supplied ref eligible in this request. */
  readonly anchors: readonly TextAnchor[];
}

export interface ProducerV2PredicateSpec {
  readonly id: string;
  readonly object_kinds: readonly ClaimObjectDraft["kind"][];
}

export interface ProducerV2ParseInput {
  readonly events: readonly {
    readonly event_id: string;
    readonly text: string;
  }[];
  readonly supplied_refs: readonly ProducerV2SuppliedRef[];
  readonly vocabulary_refs: readonly string[];
  readonly predicates: readonly ProducerV2PredicateSpec[];
}

export type DroppedDraftV2 = {
  readonly reason: "unknown_predicate";
  readonly id: string;
};

export type ParseExtractResponseV2Result = {
  readonly ok: true;
  readonly response: ExtractResponseV2;
  readonly dropped: readonly DroppedDraftV2[];
} | {
  readonly ok: false;
  readonly detail: string;
};

export const PRODUCER_V2_UNAVAILABLE_REASONS = [
  "unavailable", "timeout", "network", "credentials", "http"
] as const;

export type ProducerV2UnavailableReason = (typeof PRODUCER_V2_UNAVAILABLE_REASONS)[number];

export type ProduceResultV2 = {
  readonly status: "ok";
  readonly response: ExtractResponseV2;
  readonly usage: ModelUsage;
  readonly dropped?: readonly DroppedDraftV2[];
} | {
  readonly status: "unavailable";
  readonly reason: ProducerV2UnavailableReason;
  readonly usage: ModelUsage;
  readonly diagnostic?: ProducerDiagnostic;
} | Extract<ProduceResult, {
  status: "rejected";
}>;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESPONSE_KEYS = ["schema", "mentions", "claims"] as const;
const MENTION_KEYS = ["id", "label", "anchor", "candidate_refs"] as const;
const CLAIM_KEYS = [
  "id", "subject", "predicate", "object", "perspective", "context", "polarity", "body", "valid_from", "valid_to", "temporal_basis", "confidence", "sensitivity", "anchors"
] as const;
const ANCHOR_KEYS = ["event_id", "start_utf16", "end_utf16"] as const;
const REF_KEYS = ["kind", "id"] as const;
const OBJECT_KEYS: Record<ClaimObjectDraft["kind"], readonly string[]> = {
  literal: ["kind", "value"], subject: ["kind", "ref"], vocabulary: ["kind", "ref"],
};
const PERSPECTIVE_KEYS = [
  "holder", "speaker", "addressee", "mode", "interpretation", "anchors"
] as const;
const MODES = new Set<AttributedPerspectiveDraft["mode"]>([
  "asserted", "quoted", "reported", "hypothetical", "suggested", "questioned", "uncertain"
]);
const SENSITIVITIES = new Set<Sensitivity>(["public", "personal", "private"]);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key));
}

function isToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

function fail(detail: string): ParseExtractResponseV2Result {
  return { ok: false, detail };
}

function anchorKey(anchor: TextAnchor): string {
  return `${anchor.event_id}\u0000${anchor.start_utf16}\u0000${anchor.end_utf16}`;
}

function isBoundary(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) {
    return true;
  }
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

function readAnchor(value: unknown, events: ReadonlyMap<string, string>, path: string): TextAnchor | string {
  if (!isPlainObject(value) || !exactKeys(value, ANCHOR_KEYS)) {
    return `${path} must be an exact anchor`;
  }
  const eventId = value.event_id, start = value.start_utf16, end = value.end_utf16;
  if (!isUlid(eventId) ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end)) {
    return `${path} is invalid`;
  }
  const text = events.get(eventId);
  if (text === undefined || start < 0 || end <= start || end > text.length || !isBoundary(text, start) || !isBoundary(text, end)) {
    return `${path} is outside quoted text`;
  }
  return { event_id: eventId, start_utf16: start, end_utf16: end };
}

function readAnchors(value: unknown, events: ReadonlyMap<string, string>, path: string, min: number): readonly TextAnchor[] | string {
  if (!Array.isArray(value) || value.length < min || value.length > MAX_V2_ANCHORS_PER_ITEM) {
    return `${path} is not a bounded anchor list`;
  }
  const anchors: TextAnchor[] = [];
  for (const [index, raw] of value.entries()) {
    const anchor = readAnchor(raw, events, `${path}[${index}]`);
    if (typeof anchor === "string") {
      return anchor;
    }
    anchors.push(anchor);
  }
  if (new Set(anchors.map(anchorKey)).size !== anchors.length) {
    return `${path} has duplicate anchors`;
  }
  return anchors;
}

function readRef(value: unknown, supplied: ReadonlyMap<string, readonly TextAnchor[]>, mentions: ReadonlyMap<string, MentionDraft>, path: string): DraftRef | string {
  if (!isPlainObject(value) || !exactKeys(value, REF_KEYS) || !isToken(value.id)) {
    return `${path} is not an exact reference`;
  }
  if (value.kind === "supplied" && supplied.has(value.id)) {
    return { kind: "supplied", id: value.id };
  }
  if (value.kind === "mention" && mentions.has(value.id)) {
    return { kind: "mention", id: value.id };
  }
  return `${path} names an unknown reference`;
}

function refAnchors(ref: DraftRef, supplied: ReadonlyMap<string, readonly TextAnchor[]>, mentions: ReadonlyMap<string, MentionDraft>): readonly TextAnchor[] {
  return ref.kind === "supplied" ? supplied.get(ref.id)! : [mentions.get(ref.id)!.anchor];
}

function hasGrounding(refs: readonly DraftRef[], anchors: readonly TextAnchor[], supplied: ReadonlyMap<string, readonly TextAnchor[]>, mentions: ReadonlyMap<string, MentionDraft>): boolean {
  const cited = new Set(anchors.map(anchorKey));
  return refs.every(ref => refAnchors(ref, supplied, mentions).some(anchor => cited.has(anchorKey(anchor))));
}
/** Parses provider JSON before any identity, storage, metrics, or error write. */
export function parseExtractResponseV2(text: string, input: ProducerV2ParseInput): ParseExtractResponseV2Result {
  if (typeof text !== "string" || text.length > MAX_V2_RESPONSE_BYTES || utf8ByteLength(text) > MAX_V2_RESPONSE_BYTES) {
    return fail("response exceeds the size cap");
  }
  try {
    const errors: string[] = [];
    const snapshot = cloneExactJson(input, "producer input", {
      maxDepth: 8, maxKeysPerObject: 5,
      maxArrayLength: MAX_V2_TRUSTED_REFS, maxStringBytes: MAX_V2_QUOTED_UTF16 * 4,
      maxKeyBytes: 64, maxTotalBytes: 1024 * 1024
    }, errors);
    if (!isPlainObject(snapshot) || !exactKeys(snapshot, ["events", "supplied_refs", "vocabulary_refs", "predicates"])) {
      return fail("trusted parser input is invalid");
    }
    return parseResponse(text, snapshot as unknown as ProducerV2ParseInput);
  }
  catch {
    return fail("trusted parser input is invalid");
  }
}

function parseResponse(text: string, input: ProducerV2ParseInput): ParseExtractResponseV2Result {
  const events = new Map<string, string>();
  if (!Array.isArray(input.events) ||
    input.events.length > MAX_V2_EVENTS ||
    !Array.isArray(input.supplied_refs) ||
    input.supplied_refs.length > MAX_V2_TRUSTED_REFS ||
    !Array.isArray(input.vocabulary_refs) ||
    input.vocabulary_refs.length > MAX_V2_TRUSTED_REFS ||
    !Array.isArray(input.predicates) ||
    input.predicates.length > MAX_V2_TRUSTED_REFS) {
    return fail("trusted parser input is invalid");
  }
  let quotedUtf16 = 0;
  for (const event of input.events) {
    if (!isPlainObject(event) ||
      !exactKeys(event, ["event_id", "text"]) ||
      !isUlid(event.event_id) ||
      typeof event.text !== "string" ||
      events.has(event.event_id)) {
      return fail("trusted event input is invalid");
    }
    quotedUtf16 += event.text.length;
    if (quotedUtf16 > MAX_V2_QUOTED_UTF16) {
      return fail("trusted event input is invalid");
    }
    events.set(event.event_id, event.text);
  }
  const supplied = new Map<string, readonly TextAnchor[]>();
  for (const item of input.supplied_refs) {
    if (!isPlainObject(item) || !exactKeys(item, ["id", "anchors"]) || !isToken(item.id) || supplied.has(item.id)) {
      return fail("trusted supplied references are invalid");
    }
    const anchors = readAnchors(item.anchors, events, "trusted supplied anchors", 1);
    if (typeof anchors === "string") {
      return fail("trusted supplied references are invalid");
    }
    supplied.set(item.id, anchors);
  }
  const vocabulary = new Set(input.vocabulary_refs);
  if ([...vocabulary].some(id => !isToken(id)) || vocabulary.size !== input.vocabulary_refs.length) {
    return fail("trusted vocabulary input is invalid");
  }
  const predicates = new Map<string, ProducerV2PredicateSpec>();
  for (const spec of input.predicates)
    if (!isPlainObject(spec) ||
      !exactKeys(spec, ["id", "object_kinds"]) ||
      !isToken(spec.id) ||
      predicates.has(spec.id) ||
      !Array.isArray(spec.object_kinds) ||
      spec.object_kinds.length === 0 ||
      spec.object_kinds.length > 3 ||
      new Set(spec.object_kinds).size !== spec.object_kinds.length ||
      spec.object_kinds.some((kind: unknown) => typeof kind !== "string" ||
      !Object.hasOwn(OBJECT_KEYS, kind))) {
      return fail("trusted predicate input is invalid");
    }
    else {
      predicates.set(spec.id, { id: spec.id, object_kinds: spec.object_kinds as ClaimObjectDraft["kind"][] });
    }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  }
  catch {
    return fail("response is not JSON");
  }
  if (!isPlainObject(parsed) ||
    !exactKeys(parsed, RESPONSE_KEYS) ||
    parsed.schema !== EXTRACT_RESPONSE_V2_SCHEMA ||
    !Array.isArray(parsed.mentions) ||
    !Array.isArray(parsed.claims)) {
    return fail("response has an invalid schema");
  }
  if (parsed.mentions.length > MAX_V2_MENTIONS || parsed.claims.length > MAX_V2_CLAIMS) {
    return fail("response exceeds item caps");
  }
  const mentions = new Map<string, MentionDraft>();
  const mentionInputs: {
    readonly raw: Record<string, unknown>;
    readonly anchor: TextAnchor;
  }[] = [];
  let anchorsUsed = 0;
  let referencesUsed = 0;
  for (const [index, raw] of parsed.mentions.entries()) {
    if (!isPlainObject(raw) ||
      !exactKeys(raw, MENTION_KEYS) ||
      !isToken(raw.id) ||
      mentions.has(raw.id) ||
      typeof raw.label !== "string" ||
      raw.label.length === 0 ||
      utf8ByteLength(raw.label) > MAX_V2_LABEL_BYTES ||
      !Array.isArray(raw.candidate_refs) ||
      raw.candidate_refs.length > 4) {
      return fail(`mentions[${index}] is invalid`);
    }
    const anchor = readAnchor(raw.anchor, events, `mentions[${index}].anchor`);
    if (typeof anchor === "string") {
      return fail(anchor);
    }
    mentions.set(raw.id, {
      id: raw.id, label: raw.label, anchor, candidate_refs: []
    });
    mentionInputs.push({ raw, anchor });
    anchorsUsed += 1;
  }
  for (const [index, entry] of mentionInputs.entries()) {
    const candidates: DraftRef[] = [];
    for (const candidate of entry.raw.candidate_refs as unknown[]) {
      const ref = readRef(candidate, supplied, mentions, `mentions[${index}].candidate_refs`);
      if (typeof ref === "string") {
        return fail(`mentions[${index}].candidate_refs is invalid`);
      }
      candidates.push(ref);
    }
    if (new Set(candidates.map(ref => `${ref.kind}:${ref.id}`)).size !== candidates.length) {
      return fail(`mentions[${index}].candidate_refs has duplicates`);
    }
    referencesUsed += candidates.length;
    mentions.set(entry.raw.id as string, {
      id: entry.raw.id as string, label: entry.raw.label as string, anchor: entry.anchor, candidate_refs: candidates
    });
  }
  const claims: RichClaimDraft[] = [];
  const dropped: DroppedDraftV2[] = [];
  const ids = new Set<string>();
  for (const [index, raw] of parsed.claims.entries()) {
    if (!isPlainObject(raw) || !exactKeys(raw, CLAIM_KEYS) || !isToken(raw.id)) {
      return fail(`claims[${index}] is invalid`);
    }
    if (ids.has(raw.id)) {
      return fail(`claims[${index}] has a duplicate local id`);
    }
    ids.add(raw.id);
    const subject = readRef(raw.subject, supplied, mentions, `claims[${index}].subject`);
    if (typeof subject === "string") {
      return fail(subject);
    }
    const confidence = raw.confidence;
    if (!isToken(raw.predicate) ||
      !isPlainObject(raw.object) ||
      typeof raw.body !== "string" ||
      raw.body.length === 0 ||
      raw.body.length > MAX_V2_BODY_CHARS ||
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1 ||
      !SENSITIVITIES.has(raw.sensitivity as Sensitivity) ||
      (raw.polarity !== "positive" &&
      raw.polarity !== "negative") ||
      (raw.temporal_basis !== "explicit" &&
      raw.temporal_basis !== "observed" &&
      raw.temporal_basis !== "unknown") ||
      (raw.valid_from !== null &&
      !isRfc3339(raw.valid_from)) ||
      (raw.valid_to !== null &&
      !isRfc3339(raw.valid_to))) {
      return fail(`claims[${index}] is invalid`);
    }
    if ((raw.temporal_basis === "explicit" &&
      raw.valid_from === null) ||
      (raw.temporal_basis === "unknown" &&
      (raw.valid_from !== null ||
      raw.valid_to !== null)) ||
      (raw.valid_from !== null &&
      raw.valid_to !== null &&
      Date.parse(raw.valid_to) <= Date.parse(raw.valid_from))) {
      return fail(`claims[${index}] has an invalid interval`);
    }
    const anchors = readAnchors(raw.anchors, events, `claims[${index}].anchors`, 1);
    if (typeof anchors === "string") {
      return fail(anchors);
    }
    anchorsUsed += anchors.length;
    if (anchorsUsed > MAX_V2_ANCHORS || !hasGrounding([subject], anchors, supplied, mentions)) {
      return fail(`claims[${index}] has ungrounded endpoints`);
    }
    let object: ClaimObjectDraft;
    if (raw.object.kind === "literal" &&
      exactKeys(raw.object, OBJECT_KEYS.literal) &&
      typeof raw.object.value === "string" &&
      raw.object.value.length > 0 &&
      raw.object.value.length <= MAX_V2_LITERAL_CHARS) {
      object = { kind: "literal", value: raw.object.value };
    }
    else if (raw.object.kind === "subject" && exactKeys(raw.object, OBJECT_KEYS.subject)) {
      const ref = readRef(raw.object.ref, supplied, mentions, `claims[${index}].object`);
      if (typeof ref === "string" || !hasGrounding([ref], anchors, supplied, mentions)) {
        return fail(`claims[${index}].object is invalid`);
      }
      object = { kind: "subject", ref };
    }
    else if (raw.object.kind === "vocabulary" &&
      exactKeys(raw.object, OBJECT_KEYS.vocabulary) &&
      isPlainObject(raw.object.ref) &&
      exactKeys(raw.object.ref, REF_KEYS) &&
      raw.object.ref.kind === "vocabulary" &&
      isToken(raw.object.ref.id) &&
      vocabulary.has(raw.object.ref.id)) {
      object = { kind: "vocabulary", ref: { kind: "vocabulary", id: raw.object.ref.id } };
    }
    else {
      return fail(`claims[${index}].object is invalid`);
    }
    if (!isPlainObject(raw.perspective) ||
      !exactKeys(raw.perspective, PERSPECTIVE_KEYS) ||
      !MODES.has(raw.perspective.mode as AttributedPerspectiveDraft["mode"]) ||
      (raw.perspective.interpretation !== "explicit" &&
      raw.perspective.interpretation !== "inferred")) {
      return fail(`claims[${index}].perspective is invalid`);
    }
    const perspectiveAnchors = readAnchors(raw.perspective.anchors, events, `claims[${index}].perspective.anchors`, 0);
    if (typeof perspectiveAnchors === "string") {
      return fail(perspectiveAnchors);
    }
    anchorsUsed += perspectiveAnchors.length;
    if (anchorsUsed > MAX_V2_ANCHORS) {
      return fail("response exceeds anchor cap");
    }
    const roles: (DraftRef | null)[] = [];
    for (const role of [raw.perspective.holder, raw.perspective.speaker, raw.perspective.addressee]) {
      if (role === null) {
        roles.push(null);
        continue;
      }
      const ref = readRef(role, supplied, mentions, `claims[${index}].perspective`);
      if (typeof ref === "string" || perspectiveAnchors.length === 0 || !hasGrounding([ref], perspectiveAnchors, supplied, mentions)) {
        return fail(`claims[${index}].perspective.anchors is insufficient`);
      }
      roles.push(ref);
    }
    if (!Array.isArray(raw.context) || raw.context.length > 8) {
      return fail(`claims[${index}].context is invalid`);
    }
    const context: DraftRef[] = [];
    for (const value of raw.context) {
      const ref = readRef(value, supplied, mentions, `claims[${index}].context`);
      if (typeof ref === "string" || !hasGrounding([ref], anchors, supplied, mentions)) {
        return fail(`claims[${index}].context is ungrounded`);
      }
      context.push(ref);
    }
    if (new Set(context.map(ref => `${ref.kind}:${ref.id}`)).size !== context.length) {
      return fail(`claims[${index}].context has duplicates`);
    }
    referencesUsed += 1 + (object.kind === "literal" ? 0 : 1) +
      roles.filter(role => role !== null).length + context.length;
    if (referencesUsed > MAX_V2_REFERENCES) {
      return fail("response exceeds reference cap");
    }
    const spec = predicates.get(raw.predicate);
    if (spec === undefined) {
      dropped.push({ reason: "unknown_predicate", id: raw.id });
      continue;
    }
    if (!spec.object_kinds.includes(object.kind)) {
      return fail(`claims[${index}].object is not permitted by its predicate`);
    }
    claims.push({
      id: raw.id, subject, predicate: raw.predicate, object, perspective: {
        holder: roles[0]!, speaker: roles[1]!, addressee: roles[2]!, mode: raw.perspective.mode as AttributedPerspectiveDraft["mode"], interpretation: raw.perspective.interpretation, anchors: perspectiveAnchors
      }, context, polarity: raw.polarity, body: raw.body, valid_from: raw.valid_from, valid_to: raw.valid_to, temporal_basis: raw.temporal_basis, confidence, sensitivity: raw.sensitivity as Sensitivity, anchors
    });
  }
  return { ok: true, response: { schema: EXTRACT_RESPONSE_V2_SCHEMA, mentions: [...mentions.values()], claims }, dropped };
}
