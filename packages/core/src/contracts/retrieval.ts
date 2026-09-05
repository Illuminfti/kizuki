import {
  SENSITIVITY_ORDER,
  isSensitivity,
} from "../agents/types";
import type { Sensitivity } from "../agents/types";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import {
  PortError,
  requirePortCapability,
} from "./ports";
import type {
  Port,
  PortDescriptor,
} from "./ports";

export const RETRIEVAL_CONTRACT = "kizuki.retrieval/v1" as const;
export const RETRIEVAL_CONTRACT_MINOR = 0;
export const MAX_RETRIEVAL_LIMIT = 100;
export const RETRIEVAL_CAPABILITIES = [
  "lexical",
  "vector",
  "hybrid",
  "graph",
] as const;
export type RetrievalCapability =
  (typeof RETRIEVAL_CAPABILITIES)[number];

export const RETRIEVAL_DOC_KINDS = [
  "page",
  "event",
  "claim",
] as const;
export type RetrievalDocKind = (typeof RETRIEVAL_DOC_KINDS)[number];

export type RetrievalAuthority =
  | "owner_correction"
  | "owner_authored"
  | "connector_evidence"
  | "model_inference";

export interface RetrievalDoc {
  readonly doc_id: string;
  readonly kind: RetrievalDocKind;
  readonly title: string;
  readonly text: string;
  /** Null is outside the sensitivity lattice and must never be served. */
  readonly sensitivity: Sensitivity | null;
  readonly taint: "clean" | "quoted";
  readonly authority: RetrievalAuthority;
  readonly subjects: readonly string[];
  readonly provenance: readonly string[];
  readonly occurred_at: string | null;
  /** Null means the authoritative source does not establish an update instant. */
  readonly updated_at: string | null;
}

export interface RetrievalScope {
  readonly kinds?: readonly RetrievalDocKind[];
  readonly subjects?: readonly string[];
  readonly since?: string;
  readonly until?: string;
}

export interface RetrievalQuery {
  readonly text: string;
  readonly mode: "lexical" | "vector" | "hybrid";
  readonly scope: RetrievalScope;
  readonly ceiling: Sensitivity;
  readonly limit: number;
  readonly deadline_ms: number;
}

export interface RetrievalHit {
  readonly doc_id: string;
  readonly score: number;
  readonly snippet: string;
  readonly kind: RetrievalDocKind;
  readonly sensitivity: Sensitivity;
  readonly taint: "clean" | "quoted";
  readonly authority: RetrievalAuthority;
}

export interface RetrievalResult {
  readonly hits: RetrievalHit[];
  readonly degraded: string[];
  readonly timings_ms: Record<string, number>;
  readonly space: string | null;
}

export interface RetrievalMutationReport {
  /** Inputs processed, including already-current idempotent inputs. */
  readonly processed: number;
}

export interface AbsenceProof {
  readonly checked: number;
  readonly found: string[];
  readonly store: string;
  readonly method: string;
  readonly at: string;
}

export interface EntityRef {
  readonly entity_id: string;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly type: string;
  readonly weight: number;
  readonly provenance: readonly string[];
}

export interface GraphResult {
  readonly entity: string;
  readonly edges: GraphEdge[];
  readonly truncated: boolean;
}

export interface GraphQueryOptions {
  readonly hops: number;
  readonly limit: number;
  readonly ceiling: Sensitivity;
}

export interface RetrievalPort extends Port {
  /** Stage all documents before atomically replacing the active index. */
  rebuildFromDocuments?(docs: AsyncIterable<RetrievalDoc> | Iterable<RetrievalDoc>): Promise<void>;
  upsert(docs: readonly RetrievalDoc[]): Promise<RetrievalMutationReport>;
  search(query: RetrievalQuery): Promise<RetrievalResult>;
  remove(ids: readonly string[]): Promise<RetrievalMutationReport>;
  verifyAbsent(ids: readonly string[]): Promise<AbsenceProof>;
  neighbors(
    entity: EntityRef,
    options: GraphQueryOptions,
  ): Promise<GraphResult>;
}

function invalid(field: string): never {
  throw new PortError(
    "config_invalid",
    `retrieval ${field} is invalid`,
    false,
  );
}

function validStrings(
  value: unknown,
  opts: { nonEmpty?: boolean; max?: number } = {},
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= (opts.max ?? 1_000) &&
    (opts.nonEmpty !== true || value.length > 0) &&
    value.every(
      (item) =>
        typeof item === "string" &&
        item.length > 0 &&
        item.length <= 4_096,
    )
  );
}

export function validateRetrievalDoc(value: unknown): RetrievalDoc {
  if (!isPlainObject(value)) invalid("document");
  if (
    typeof value["kind"] !== "string" ||
    !(RETRIEVAL_DOC_KINDS as readonly string[]).includes(value["kind"])
  ) {
    invalid("document.kind");
  }
  if (
    typeof value["doc_id"] !== "string" ||
    value["doc_id"].length === 0 ||
    value["doc_id"].length > 1_024 ||
    !value["doc_id"].startsWith(`${value["kind"]}:`) ||
    value["doc_id"].length <= value["kind"].length + 1
  ) {
    invalid("document.doc_id");
  }
  for (const field of ["title", "text"] as const) {
    if (typeof value[field] !== "string") {
      invalid(`document.${field}`);
    }
  }
  if (
    value["sensitivity"] !== null &&
    (typeof value["sensitivity"] !== "string" ||
      !(value["sensitivity"] in SENSITIVITY_ORDER))
  ) {
    invalid("document.sensitivity");
  }
  if (value["taint"] !== "clean" && value["taint"] !== "quoted") {
    invalid("document.taint");
  }
  if (
    value["authority"] !== "owner_correction" &&
    value["authority"] !== "owner_authored" &&
    value["authority"] !== "connector_evidence" &&
    value["authority"] !== "model_inference"
  ) {
    invalid("document.authority");
  }
  if (!validStrings(value["subjects"], { max: 1_000 })) {
    invalid("document.subjects");
  }
  if (!validStrings(value["provenance"], { max: 10_000 })) {
    invalid("document.provenance");
  }
  if (
    value["occurred_at"] !== null &&
    !isRfc3339(value["occurred_at"])
  ) {
    invalid("document.occurred_at");
  }
  if (value["updated_at"] !== null && !isRfc3339(value["updated_at"])) {
    invalid("document.updated_at");
  }
  return value as unknown as RetrievalDoc;
}

export function validateRetrievalQuery(value: unknown): RetrievalQuery {
  if (!isPlainObject(value)) invalid("query");
  if (
    typeof value["text"] !== "string" ||
    value["text"].length > 32_000
  ) {
    invalid("query.text");
  }
  if (
    value["mode"] !== "lexical" &&
    value["mode"] !== "vector" &&
    value["mode"] !== "hybrid"
  ) {
    invalid("query.mode");
  }
  if (!isPlainObject(value["scope"])) invalid("query.scope");
  const scope = value["scope"] as Record<string, unknown>;
  if (
    scope["kinds"] !== undefined &&
    (!Array.isArray(scope["kinds"]) ||
      scope["kinds"].length > 3 ||
      !scope["kinds"].every(
        (kind) =>
          typeof kind === "string" &&
          (RETRIEVAL_DOC_KINDS as readonly string[]).includes(kind),
      ))
  ) {
    invalid("query.scope.kinds");
  }
  if (
    scope["subjects"] !== undefined &&
    !validStrings(scope["subjects"], { max: 1_000 })
  ) {
    invalid("query.scope.subjects");
  }
  if (scope["since"] !== undefined && !isRfc3339(scope["since"])) {
    invalid("query.scope.since");
  }
  if (scope["until"] !== undefined && !isRfc3339(scope["until"])) {
    invalid("query.scope.until");
  }
  if (!isSensitivity(value["ceiling"])) {
    invalid("query.ceiling");
  }
  if (
    typeof value["limit"] !== "number" ||
    !Number.isSafeInteger(value["limit"]) ||
    value["limit"] < 1 ||
    value["limit"] > MAX_RETRIEVAL_LIMIT
  ) {
    invalid("query.limit");
  }
  if (
    typeof value["deadline_ms"] !== "number" ||
    !Number.isSafeInteger(value["deadline_ms"]) ||
    value["deadline_ms"] < 1 ||
    value["deadline_ms"] > 300_000
  ) {
    invalid("query.deadline_ms");
  }
  return value as unknown as RetrievalQuery;
}

export function validateRetrievalMutationReport(
  value: unknown,
): RetrievalMutationReport {
  if (
    !isPlainObject(value) ||
    typeof value["processed"] !== "number" ||
    !Number.isSafeInteger(value["processed"]) ||
    value["processed"] < 0
  ) {
    invalid("mutation report");
  }
  return { processed: value["processed"] as number };
}

export function validateRetrievalResult(
  value: unknown,
  limit: number,
): RetrievalResult {
  if (
    !isPlainObject(value) ||
    !Array.isArray(value["hits"]) ||
    value["hits"].length > limit ||
    !Array.isArray(value["degraded"]) ||
    value["degraded"].length > 100 ||
    !value["degraded"].every(
      (item) => typeof item === "string" && item.length <= 256,
    ) ||
    !isPlainObject(value["timings_ms"]) ||
    (value["space"] !== null && typeof value["space"] !== "string")
  ) {
    invalid("result");
  }
  const timings = value["timings_ms"] as Record<string, unknown>;
  if (
    Object.keys(timings).length > 100 ||
    Object.values(timings).some(
      (timing) =>
        typeof timing !== "number" ||
        !Number.isFinite(timing) ||
        timing < 0,
    )
  ) {
    invalid("result.timings_ms");
  }

  const hits = value["hits"].map((hit, index) => {
    if (
      !isPlainObject(hit) ||
      typeof hit["doc_id"] !== "string" ||
      hit["doc_id"].length === 0 ||
      typeof hit["score"] !== "number" ||
      !Number.isFinite(hit["score"]) ||
      typeof hit["snippet"] !== "string" ||
      typeof hit["kind"] !== "string" ||
      !(RETRIEVAL_DOC_KINDS as readonly string[]).includes(hit["kind"]) ||
      typeof hit["sensitivity"] !== "string" ||
      !(hit["sensitivity"] in SENSITIVITY_ORDER) ||
      (hit["taint"] !== "clean" && hit["taint"] !== "quoted") ||
      (hit["authority"] !== "owner_correction" &&
        hit["authority"] !== "owner_authored" &&
        hit["authority"] !== "connector_evidence" &&
        hit["authority"] !== "model_inference")
    ) {
      invalid(`result.hits[${index}]`);
    }
    return {
      doc_id: hit["doc_id"],
      score: hit["score"],
      snippet: hit["snippet"],
      kind: hit["kind"],
      sensitivity: hit["sensitivity"],
      taint: hit["taint"],
      authority: hit["authority"],
    } as RetrievalHit;
  });
  return {
    hits,
    degraded: [...(value["degraded"] as string[])],
    timings_ms: timings as Record<string, number>,
    space: value["space"] as string | null,
  };
}

export function validateAbsenceProof(
  value: unknown,
  requestedIds?: readonly string[],
): AbsenceProof {
  if (
    !isPlainObject(value) ||
    typeof value["checked"] !== "number" ||
    !Number.isSafeInteger(value["checked"]) ||
    value["checked"] < 0 ||
    !validStrings(value["found"], { max: 10_000 }) ||
    typeof value["store"] !== "string" ||
    value["store"].length === 0 ||
    typeof value["method"] !== "string" ||
    value["method"].length === 0 ||
    !isRfc3339(value["at"])
  ) {
    invalid("absence proof");
  }
  const found = value["found"] as string[];
  if (
    requestedIds !== undefined &&
    (value["checked"] !== requestedIds.length ||
      found.some((id) => !requestedIds.includes(id)))
  ) {
    invalid("absence proof scope");
  }
  return {
    checked: value["checked"] as number,
    found: [...found],
    store: value["store"] as string,
    method: value["method"] as string,
    at: value["at"] as string,
  };
}

export function validateGraphResult(value: unknown): GraphResult {
  if (
    !isPlainObject(value) ||
    typeof value["entity"] !== "string" ||
    !Array.isArray(value["edges"]) ||
    value["edges"].length > 10_000 ||
    typeof value["truncated"] !== "boolean"
  ) {
    invalid("graph result");
  }
  const edges = value["edges"].map((edge, index) => {
    if (
      !isPlainObject(edge) ||
      typeof edge["from"] !== "string" ||
      typeof edge["to"] !== "string" ||
      typeof edge["type"] !== "string" ||
      typeof edge["weight"] !== "number" ||
      !Number.isFinite(edge["weight"]) ||
      !validStrings(edge["provenance"], { max: 10_000 })
    ) {
      invalid(`graph result.edges[${index}]`);
    }
    return {
      from: edge["from"],
      to: edge["to"],
      type: edge["type"],
      weight: edge["weight"],
      provenance: [...(edge["provenance"] as string[])],
    } as GraphEdge;
  });
  return {
    entity: value["entity"] as string,
    edges,
    truncated: value["truncated"] as boolean,
  };
}

export function requireRetrievalCapability(
  descriptor: PortDescriptor,
  capability: RetrievalCapability,
): void {
  if (
    !(RETRIEVAL_CAPABILITIES as readonly string[]).includes(capability)
  ) {
    throw new PortError(
      "not_supported",
      `unknown retrieval capability ${capability}`,
      false,
    );
  }
  requirePortCapability(descriptor, capability);
}
