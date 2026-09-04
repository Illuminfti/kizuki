import { RETRIEVAL_DOC_KINDS } from "../contracts/retrieval";
import type { RetrievalDocKind } from "../contracts/retrieval";

const PREFIXES = {
  page: "page:",
  event: "event:",
  claim: "claim:",
} as const satisfies Record<RetrievalDocKind, `${RetrievalDocKind}:`>;

export function retrievalDocId(
  kind: RetrievalDocKind,
  rawId: string,
): string {
  const prefix = PREFIXES[kind];
  return rawId.startsWith(prefix) ? rawId : `${prefix}${rawId}`;
}

export function retrievalDocKind(docId: string): RetrievalDocKind | null {
  for (const kind of RETRIEVAL_DOC_KINDS) {
    if (docId.startsWith(PREFIXES[kind])) return kind;
  }
  return null;
}

/** Strip a known kind prefix. Unknown ids are returned unchanged. */
export function bareRetrievalId(docId: string): string {
  const kind = retrievalDocKind(docId);
  return kind === null ? docId : docId.slice(PREFIXES[kind].length);
}

export function isNamespacedRetrievalId(
  docId: string,
  kind: RetrievalDocKind,
): boolean {
  return docId.startsWith(PREFIXES[kind]) && docId.length > PREFIXES[kind].length;
}
