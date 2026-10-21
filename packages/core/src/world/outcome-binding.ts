import { rawSubjectRefKey, type RawSubjectRef } from "../contracts/claim-v2";
import { parseOutcomeEvidence, type OutcomeEvidence } from "../contracts/outcome-card";
import { sha256Hex } from "../util/hash";
import { isPlainObject } from "../util/validate";

/** Source namespace is part of identity: equal bytes from other sources do not match. */
export function outcomeArtifactBinding(ref: RawSubjectRef): string {
  return sha256Hex(rawSubjectRefKey(ref));
}
export type OutcomeArtifactBinding = { readonly kind: "artifact_binding"; readonly digest: string };
export type StoredOutcomeEvidence = Omit<OutcomeEvidence, "artifactVersion"> & {
  readonly artifactVersion: string | OutcomeArtifactBinding;
};
/** The wire parser rejects the internal tag; only serving's checked normalization emits it. */
export function parseStoredOutcomeEvidence(predicate: string, input: unknown): StoredOutcomeEvidence | null {
  const legacy = parseOutcomeEvidence(predicate, input);
  if (legacy !== null) return legacy;
  if (typeof input !== "string" || input.length > 1024) return null;
  let value: unknown; try { value = JSON.parse(input); } catch { return null; }
  if (!isPlainObject(value) || !isPlainObject(value.artifactVersion)) return null;
  const binding = value.artifactVersion;
  if (Object.keys(binding).length !== 2 || binding.kind !== "artifact_binding" ||
      typeof binding.digest !== "string" || !/^[0-9a-f]{64}$/.test(binding.digest)) return null;
  const checked = parseOutcomeEvidence(predicate, JSON.stringify({ ...value, artifactVersion: "bound" }));
  return checked === null ? null : { ...checked, artifactVersion: { kind: "artifact_binding", digest: binding.digest } };
}
