import { isPlainObject } from "../util/validate";

export const SCOPED_REF_KINDS = ["object", "claim", "admission", "event_version", "principal", "page", "source", "receipt", "raw_subject", "captured_subject", "claim_group", "observation"] as const;
export type ScopedRefKind = typeof SCOPED_REF_KINDS[number];
export type ScopedRef<K extends ScopedRefKind = ScopedRefKind> = { readonly kind: K; readonly token: string };
export type PageRef = ScopedRef<"page">;
export type SourceRef = ScopedRef<"source">;
export type ReceiptRef = ScopedRef<"receipt">;
export type RawSubjectWireRef = ScopedRef<"raw_subject">;
export type CapturedSubjectRef = ScopedRef<"captured_subject">;
export type ClaimGroupRef = ScopedRef<"claim_group">;
export type ObservationRef = ScopedRef<"observation">;
/** Closed canonical base64url tokens. A valid but wrong kind is a resolver miss. */
export function parseScopedRef(value: unknown): ScopedRef | null {
  if (!isPlainObject(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "kind") || !Object.hasOwn(value, "token") ||
    !SCOPED_REF_KINDS.includes(value.kind as ScopedRefKind) || typeof value.token !== "string" || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value.token)) return null;
  return { kind: value.kind as ScopedRefKind, token: value.token };
}
