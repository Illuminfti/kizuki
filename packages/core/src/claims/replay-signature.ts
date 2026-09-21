import { canonicalJson } from "../util/hash";

/** Exact identity of one normalized claim/v2 input prepared for durable replay. */
export function worldClaimReplaySignature(input: unknown): string {
  return canonicalJson(["kizuki.claim-replay/v2", input]);
}
