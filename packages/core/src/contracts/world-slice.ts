import { cardCodec, coverage, evidenceRef, exact, relation, wireRef, type Coverage, type EvidenceRef, type Relation, type WorldWireRef } from "./world-card-kit";
import { isPlainObject, utf8ByteLength } from "../util/validate";

export const WORLD_SLICE_SCHEMA = "kizuki.world-slice/v1" as const;
export interface SliceItem {
  readonly kind: string;
  readonly node: WorldWireRef<"object">;
  readonly relation: Relation;
  readonly evidence: readonly EvidenceRef[];
}
export type ProviderCoverage = { readonly kind: string; readonly status: "included" } |
  { readonly kind: string; readonly status: "unavailable"; readonly reason: "not_landed" | "extraction_off" };
export type WorldSlice = {
  readonly schema: typeof WORLD_SLICE_SCHEMA;
  readonly task: string;
  readonly budgetTokens: number;
  /** Exact tokens of this serialized body, including this field. */
  readonly tokens: number;
  readonly tokenizer: string;
  readonly constraints: readonly SliceItem[];
  readonly detail: readonly SliceItem[];
  readonly providers: readonly ProviderCoverage[];
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly coverage: Coverage;
};
const kind = (v: unknown): v is string => typeof v === "string" && /^[a-z][a-z0-9_]{0,47}$/.test(v);
const items = (v: unknown): boolean => Array.isArray(v) && v.length <= 128 && v.every(x =>
  isPlainObject(x) && exact(x, ["kind", "node", "relation", "evidence"]) && kind(x.kind) && wireRef(x.node, "object") &&
  relation(x.relation) && Array.isArray(x.evidence) && x.evidence.length <= 256 && x.evidence.every(evidenceRef));
export const validateWorldSlice = cardCodec<WorldSlice, "world-slice">({ schema: WORLD_SLICE_SCHEMA, label: "world-slice", fields: {
  task: v => typeof v === "string" && utf8ByteLength(v) <= 512,
  budgetTokens: v => Number.isSafeInteger(v) && Number(v) >= 50 && Number(v) <= 2000,
  tokens: v => Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= 2000,
  tokenizer: v => v === "js-tiktoken@1.0.21/cl100k_base", constraints: items, detail: items,
  providers: v => Array.isArray(v) && v.length <= 16 && v.every(x => isPlainObject(x) && kind(x.kind) &&
    (x.status === "included" ? exact(x, ["kind", "status"]) : x.status === "unavailable" &&
      exact(x, ["kind", "status", "reason"]) && (x.reason === "not_landed" || x.reason === "extraction_off"))),
  complete: v => typeof v === "boolean", truncated: v => typeof v === "boolean", coverage,
} });
