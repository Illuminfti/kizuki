import type { CaptureEvent } from "../contracts/event";
import {
  WORLD_VOCABULARY,
} from "../contracts/world-vocabulary";
import {
  PRODUCER_V2_CONTRACT,
  type ProduceInputV2,
  type ProducerV2SuppliedRef,
  type ProducerV2Port,
} from "../contracts/producer-v2";
import {
  validateClaimV2Semantic,
  type ClaimV2Assertion,
} from "../contracts/claim-v2";
import type { ProducerPort } from "../contracts/producer";
import type { WorldDraftInsert } from "../producer/world-drafts";
import { canonicalJson } from "../util/hash";
import { isPlainObject } from "../util/validate";
import { isUlid } from "../util/ulid";

export type ExtractionProducerPort = ProducerPort | ProducerV2Port;

export function isProducerV2(producer: ExtractionProducerPort): producer is ProducerV2Port {
  return producer.descriptor.contract === PRODUCER_V2_CONTRACT;
}

const objectKinds = (objects: readonly string[]): ProduceInputV2["predicates"][number]["object_kinds"] => {
  const mapped = objects.map(object => object === "literal" ? "literal" : object === "vocabulary" ? "vocabulary" : "subject");
  return [...new Set(mapped)].sort() as ProduceInputV2["predicates"][number]["object_kinds"];
};

const WORLD_PREDICATES: ProduceInputV2["predicates"] = WORLD_VOCABULARY.map(spec => ({
  id: spec.predicate,
  object_kinds: objectKinds(spec.objects),
}));
const WORLD_VOCABULARY_REFS = [...new Set(WORLD_VOCABULARY.flatMap(spec => spec.vocabulary_values ?? []))].sort();

/** Closed producer-v2 input. Only the host's qualified mapper supplies handles. */
export function worldProduceInput(events: readonly CaptureEvent[], suppliedRefs: readonly ProducerV2SuppliedRef[] = []): ProduceInputV2 {
  return {
    events: events.map(event => ({ event_id: event.event_id, text: event.text })),
    supplied_refs: suppliedRefs,
    vocabulary_refs: WORLD_VOCABULARY_REFS,
    predicates: WORLD_PREDICATES,
    budget: { max_calls: 1, max_input_tokens: 8_000, max_output_tokens: 2_000 },
  };
}

const DRAFT_KEYS = [
  "body", "confidence", "frontmatter", "kind", "model_ref", "producer",
  "provenance", "semantic", "sensitivity", "world_admission",
] as const;
const ADMISSION_KEYS = ["authority", "confidence", "epistemicKind", "rendering", "schema", "semantic"] as const;
const RENDERING_KEYS = ["body", "frontmatter"] as const;

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function completeEventIds(semantic: ClaimV2Assertion): string[] {
  return [...new Set([...semantic.anchors, ...semantic.perspective.anchors].map(anchor => anchor.event_id))].sort();
}

function parseDraft(value: unknown, modelRef: string | null): WorldDraftInsert | null {
  if (!isPlainObject(value) || !exact(value, DRAFT_KEYS) || value.kind !== "claim" ||
      value.producer !== "model" || value.model_ref !== modelRef || typeof value.body !== "string" ||
      !isPlainObject(value.frontmatter) || Object.keys(value.frontmatter).length !== 0 ||
      !Array.isArray(value.provenance) || value.provenance.length === 0 || value.provenance.length > 256 ||
      !value.provenance.every(isUlid) || new Set(value.provenance).size !== value.provenance.length ||
      canonicalJson(value.provenance) !== canonicalJson([...value.provenance].sort()) ||
      typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
      (value.sensitivity !== "public" && value.sensitivity !== "personal" && value.sensitivity !== "private")) {
    return null;
  }
  const parsedSemantic = validateClaimV2Semantic(value.semantic);
  if (!parsedSemantic.ok || parsedSemantic.value.discriminator !== "assertion") return null;
  const semantic = parsedSemantic.value;
  if (canonicalJson(value.provenance) !== canonicalJson(completeEventIds(semantic))) return null;
  const admission = value.world_admission;
  if (!isPlainObject(admission) || !exact(admission, ADMISSION_KEYS) ||
      admission.schema !== "kizuki.world-admission/v1" || admission.authority !== "model_inference" ||
      admission.epistemicKind !== "model_inference" || admission.confidence !== value.confidence ||
      canonicalJson(admission.semantic) !== canonicalJson(semantic) || !isPlainObject(admission.rendering) ||
      !exact(admission.rendering, RENDERING_KEYS) || admission.rendering.body !== value.body ||
      !isPlainObject(admission.rendering.frontmatter) || Object.keys(admission.rendering.frontmatter).length !== 0) {
    return null;
  }
  return {
    kind: "claim",
    body: value.body,
    frontmatter: {},
    provenance: [...value.provenance],
    producer: "model",
    model_ref: modelRef,
    confidence: value.confidence,
    sensitivity: value.sensitivity,
    semantic,
    world_admission: {
      schema: "kizuki.world-admission/v1",
      semantic,
      rendering: { body: value.body, frontmatter: {} },
      authority: "model_inference",
      confidence: value.confidence,
      epistemicKind: "model_inference",
    },
  };
}

/** Parses only the declared atomic-v2 filing shape; no parser fallback is allowed. */
export function parseDurableWorldDrafts(raw: string, modelRef: string | null): readonly WorldDraftInsert[] {
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch { throw new Error("durable extraction batch is corrupt"); }
  if (!Array.isArray(decoded) || decoded.length > 128) throw new Error("durable extraction batch is corrupt");
  const drafts = decoded.map(value => parseDraft(value, modelRef));
  if (drafts.some(draft => draft === null)) throw new Error("durable extraction batch is corrupt");
  const normalized = drafts as WorldDraftInsert[];
  if (raw !== canonicalJson(normalized)) throw new Error("durable extraction batch is corrupt");
  return normalized;
}

export function serializeDurableWorldDrafts(drafts: readonly WorldDraftInsert[], modelRef: string | null): string {
  const raw = canonicalJson(drafts);
  parseDurableWorldDrafts(raw, modelRef);
  return raw;
}
