import {rawSubjectRefKey } from "../contracts/claim-v2";
import type {
  ClaimV2Object,
  ClaimMeaning,
  ClaimV2Perspective,
  ClaimV2Semantic,
  RawSubjectRef,
} from "../contracts/claim-v2";
import type { TextAnchor } from "../contracts/producer-v2";
import { canonicalJson } from "../util/hash";
import { utf8ByteLength } from "../util/validate";
import { hashBody } from "./hash";

/**
 * RFC 0003 keeps three domain-separated identities distinct. This module owns
 * the first two; the durable-decision digest belongs to the producer lane.
 *
 * Both are canonical length-delimited SHA-256 tuples: every part is prefixed
 * with its UTF-8 byte length, so no choice of separator inside a value can
 * forge a different tuple with the same encoding. Hashing goes through
 * `hashBody` so v1 and v2 share one hash convention.
 */
const SEMANTIC_DOMAIN = "kizuki.claim/v2#semantic";
const SUPPORT_DOMAIN = "kizuki.claim/v2#support";

function tuple(domain: string, parts: readonly string[]): string {
  let encoded = `${utf8ByteLength(domain)}:${domain}`;
  for (const part of parts) {
    encoded += `${utf8ByteLength(part)}:${part}`;
  }
  return hashBody(encoded);
}

/** Present/absent is its own field so `null` cannot be spelled by a value. */
function optional(value: string | null): readonly string[] {
  return value === null ? ["0", ""] : ["1", value];
}

function refParts(value: RawSubjectRef): readonly string[] {
  return value.kind==="supplied" && "namespace" in value ? ["supplied/namespaced",value.namespace.connector_id,value.namespace.source_key,value.id] : [value.kind, value.id];
}

function optionalRefParts(value: RawSubjectRef | null): readonly string[] {
  return value === null ? ["0", "", ""] : ["1", ...refParts(value)];
}

function refKey(value: RawSubjectRef): string {
  return rawSubjectRefKey(value);
}

function objectParts(value: ClaimV2Object): readonly string[] {
  if (value.kind === "literal") return ["literal", value.value, ""];
  if (value.kind === "subject")
    return ["subject", ...refParts(value.ref)];
  return ["vocabulary", value.ref.kind, value.ref.id];
}

/**
 * Perspective identity is the roles and how the claim was held and read.
 * Its anchors are evidence, not identity: they belong to the support key, so
 * the same claim seen at a different offset corroborates instead of forking.
 */
function perspectiveParts(value: Omit<ClaimV2Perspective, "anchors">): readonly string[] {
  return [
    ...optionalRefParts(value.holder),
    ...optionalRefParts(value.speaker),
    ...optionalRefParts(value.addressee),
    value.mode,
    value.interpretation,
  ];
}

/** Context is a set: sort so array order cannot change identity. */
function contextParts(context: readonly RawSubjectRef[]): readonly string[] {
  const sorted = [...context].sort((left, right) => {
    const a = refKey(left),
      b = refKey(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return [String(sorted.length), ...sorted.flatMap(refParts)];
}

/**
 * RFC 0003 identity 1. Covers schema, record discriminator, raw endpoints,
 * predicate, typed object, polarity, perspective, sorted context, the original
 * valid interval and the temporal basis. Body, display alias, model score and
 * caller-supplied authority are excluded: they are presentation, evidence
 * quality or a caller assertion, never what the claim means. Only the named
 * fields are read, so an extra property on the input cannot perturb the key.
 */
export function semanticKey(semantic: ClaimV2Semantic | ClaimMeaning): string {
  if (semantic.discriminator === "identity_control") {
    return tuple(SEMANTIC_DOMAIN, [
      semantic.schema,
      "identity_control",
      canonicalJson(semantic.change),
      semantic.expected_component_digest,
      semantic.policy_version,
    ]);
  }
  return tuple(SEMANTIC_DOMAIN, [
    "kizuki.claim/v2",
    "assertion",
    ...refParts(semantic.subject),
    semantic.predicate,
    ...objectParts(semantic.object),
    semantic.polarity,
    ...perspectiveParts(semantic.perspective),
    ...contextParts(semantic.context),
    ...optional(semantic.valid_from),
    ...optional(semantic.valid_to),
    semantic.temporal_basis,
  ]);
}

export interface ClaimV2SupportEventRef {
  readonly event_id: string;
  readonly event_content_hash: string;
}

export interface ClaimV2SupportKeyInput {
  readonly support_origin?: "source" | "native_owner";
  readonly semantic_key: string;
  readonly source_key: string;
  readonly grant_revision: number;
  readonly events: readonly ClaimV2SupportEventRef[];
  readonly anchors: readonly TextAnchor[];
}

function anchorOrder(left: TextAnchor, right: TextAnchor): number {
  if (left.event_id !== right.event_id)
    return left.event_id < right.event_id ? -1 : 1;
  if (left.start_utf16 !== right.start_utf16)
    return left.start_utf16 - right.start_utf16;
  return left.end_utf16 - right.end_utf16;
}

/**
 * RFC 0003 identity 2: the semantic identity plus sorted exact anchors and the
 * verified event and source identities. Duplicate support therefore collides on
 * the primary key and adds neither a row nor another confidence observation.
 */
export function supportKey(input: ClaimV2SupportKeyInput): string {
  const events = [...input.events].sort((left, right) =>
    left.event_id < right.event_id
      ? -1
      : left.event_id > right.event_id
        ? 1
        : 0,
  );
  const anchors = [...input.anchors].sort(anchorOrder);
  return tuple(input.support_origin === "native_owner" ? "kizuki.claim/v2#native-support" : SUPPORT_DOMAIN, [
    input.semantic_key,
    input.source_key,
    String(input.grant_revision),
    String(events.length),
    ...events.flatMap((event) => [event.event_id, event.event_content_hash]),
    String(anchors.length),
    ...anchors.flatMap((anchor) => [
      anchor.event_id,
      String(anchor.start_utf16),
      String(anchor.end_utf16),
    ]),
  ]);
}
