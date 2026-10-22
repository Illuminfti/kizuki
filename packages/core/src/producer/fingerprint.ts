import { PREDICATE_REGISTRY } from "../claims/predicates";
import type { ProducerV2Port } from "../contracts/producer-v2";
import { activeWorldRegistry } from "../contracts/world-vocabulary";
import { canonicalJson, sha256Hex } from "../util/hash";
import { extractionV2SystemContent } from "./prompt-v2";

/** Bump for producer semantics outside the prompt/registry. This is identity,
 * not a claim that the producer has been independently qualified. */
const IMPLEMENTATION = "kizuki.producer.model.v2/quote-anchors-1";
const identities = new WeakMap<object, () => string | null>();

function fingerprint(): string {
  const registry = activeWorldRegistry();
  const predicates = registry.vocabulary.map(row => ({ id: row.predicate,
    object_kinds: [...new Set(row.objects.map(kind => kind === "literal" ? "literal" as const : kind === "vocabulary" ? "vocabulary" as const : "subject" as const))] }));
  // Cover the build-owned optional instructions as well as the ordinary prompt.
  // No event text, request-local identities, credentials or endpoint enter this hash.
  const input = { predicates, vocabulary_refs: registry.vocabulary.flatMap(row => row.vocabulary_values ?? []),
    supplied_refs: [{ id: `g${"0".repeat(64)}/0`, anchors: [] }] };
  return sha256Hex(canonicalJson({ implementation: IMPLEMENTATION, registry: { kinds: registry.kinds,
    vocabulary: registry.vocabulary, offered: registry.offered }, legacy: PREDICATE_REGISTRY,
    ordinary: extractionV2SystemContent({ ...input, supplied_refs: [] }),
    grounding: extractionV2SystemContent(input) }));
}

/** Internal factory registration. A property on an arbitrary port is not proof. */
export function registerModelProducerIdentity(port: ProducerV2Port, isClosed: () => boolean): void {
  const produce = port.produce;
  identities.set(port, () => !isClosed() && port.produce === produce ? fingerprint() : null);
  Object.freeze(port);
}

/** Internal observation wrapper carries the factory's live identity, not a copy. */
export function inheritModelProducerIdentity<T extends ProducerV2Port>(source: ProducerV2Port, target: T): T {
  const produce = target.produce;
  identities.set(target, () => target.produce === produce ? modelProducerFingerprint(source) : null);
  return Object.freeze(target);
}

/** Read-only public identity; null means this is not an intact built-in producer. */
export function modelProducerFingerprint(port: object): string | null {
  return identities.get(port)?.() ?? null;
}
