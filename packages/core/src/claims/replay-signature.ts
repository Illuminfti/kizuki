import { canonicalJson } from "../util/hash";
import { isPlainObject } from "../util/validate";

/** Exact identity of one normalized claim/v2 input prepared for durable replay. */
export function worldClaimReplaySignature(input: unknown): string {
  const normalized = isPlainObject(input) && input.world_admission !== undefined
    ? {
        ...input,
        body: "",
        frontmatter: {},
        subject: null,
        predicate: null,
        object: null,
        subjects: [],
      }
    : input;
  return canonicalJson(["kizuki.claim-replay/v2", normalized]);
}
