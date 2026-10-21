import type { Sensitivity } from "../agents";
import type { AuthorityTier } from "./proposal";
import type { KnownTime } from "./durable-observation";
import type { Relation } from "./world-card-kit";
import type { WorldReadResult } from "../serving/world-view";
import type { ScopedRef, PageRef, SourceRef, RawSubjectWireRef, ClaimGroupRef, ReceiptRef } from "./scoped-refs";

export interface CanonChunkV2 {
  readonly page: PageRef;
  readonly title: string;
  readonly type: string;
  readonly sensitivity: Sensitivity;
  readonly taint: "clean" | "quoted";
  readonly authority: AuthorityTier | null;
  readonly subjects: readonly RawSubjectWireRef[];
  readonly sources: readonly ScopedRef<"event_version">[];
  readonly excerpt: string;
  readonly truncated: boolean;
}
export interface QuotedChunkV2 {
  readonly eventVersion: ScopedRef<"event_version">;
  readonly source: SourceRef;
  readonly kind: string;
  readonly occurred: KnownTime;
  readonly sensitivity: Sensitivity;
  readonly subjects: readonly RawSubjectWireRef[];
  readonly text: string;
  readonly tainted: true;
}
export type ReadGap = "retrieval_unavailable" | "coverage" | "budget";
export type GraphAnchorV2 = RawSubjectWireRef | PageRef | ScopedRef<"event_version">;
export type GraphEdgeV2 =
  | { readonly kind: "wikilink"; readonly from: PageRef; readonly to: PageRef | { readonly kind: "unresolved"; readonly text: string; readonly quoted: true } }
  | { readonly kind: "subject"; readonly from: PageRef; readonly to: RawSubjectWireRef }
  | { readonly kind: "source"; readonly from: PageRef; readonly to: ScopedRef<"event_version"> };
export type GraphDataV2 = { readonly anchor: GraphAnchorV2; readonly edges: readonly GraphEdgeV2[]; readonly truncated: boolean };
export type ProposeDataV2 = { readonly outcome: "stored" | "duplicate" | "skipped" | "contested"; readonly claim: ScopedRef<"claim">; readonly superseded: readonly ScopedRef<"claim">[] };
export type CorrectDataV2 = {
  readonly receipt: ReceiptRef | null;
  readonly eventVersion: ScopedRef<"event_version"> | null;
  readonly claim: ScopedRef<"claim"> | null;
  readonly superseded: readonly ScopedRef<"claim">[];
  readonly rewritten: readonly { readonly page: PageRef; readonly diff: { readonly status: "unavailable" } }[];
  readonly ambiguous: readonly { readonly candidate: ClaimGroupRef; readonly claims: readonly ScopedRef<"claim">[] }[];
  readonly message: "correction_recorded" | "ambiguous" | "dry_run" | "no_change";
  readonly refreshedWorld: WorldReadResult | null;
};
export type ScopedMutationObject = Relation["object"];
export const WRITER_REFUSAL_V2 = Object.freeze({ ok: false as const, error: Object.freeze({ code: "unavailable" as const, message: "writer unavailable" as const, retryable: true as const }) });
export type WriterRefusalV2 = typeof WRITER_REFUSAL_V2;
