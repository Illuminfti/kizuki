import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { SENSITIVITY_ORDER } from "../../src/agents/types";
import {
  MAX_RETRIEVAL_LIMIT,
  RETRIEVAL_CONTRACT,
  requireRetrievalCapability,
  validateRetrievalQuery,
} from "../../src/contracts/retrieval";
import type {
  AbsenceProof,
  GraphResult,
  RetrievalDoc,
  RetrievalMutationReport,
  RetrievalPort,
  RetrievalQuery,
  RetrievalResult,
} from "../../src/contracts/retrieval";
import type {
  PortContext,
  PortDescriptor,
  PortHealth,
} from "../../src/contracts/ports";

export const DIRECT_RETRIEVAL_DESCRIPTOR = {
  id: "test.kizuki.retrieval.direct",
  kind: "retrieval",
  contract: RETRIEVAL_CONTRACT,
  contract_minor: 0,
  supports: ["lexical"],
  requires_lease: false,
  optional_package: null,
} as const satisfies PortDescriptor;

interface PersistedState {
  docs: RetrievalDoc[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function containsEveryToken(doc: RetrievalDoc, text: string): boolean {
  const haystack = `${doc.title}\n${doc.text}`.toLocaleLowerCase("en-US");
  return text
    .toLocaleLowerCase("en-US")
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export class ReferenceRetrievalPort implements RetrievalPort {
  readonly descriptor: PortDescriptor;
  protected readonly ctx: PortContext;
  protected readonly docs = new Map<string, RetrievalDoc>();
  private readonly statePath: string;

  constructor(
    ctx: PortContext,
    descriptor: PortDescriptor = DIRECT_RETRIEVAL_DESCRIPTOR,
  ) {
    this.ctx = ctx;
    this.descriptor = descriptor;
    this.statePath = join(ctx.data_dir, "reference-retrieval.json");
    mkdirSync(ctx.data_dir, { recursive: true });
    if (existsSync(this.statePath)) {
      const state = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
      for (const doc of state.docs) this.docs.set(doc.doc_id, doc);
    }
  }

  async upsert(
    docs: readonly RetrievalDoc[],
  ): Promise<RetrievalMutationReport> {
    for (const doc of docs) this.docs.set(doc.doc_id, structuredClone(doc));
    this.persist();
    return { processed: docs.length };
  }

  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    validateRetrievalQuery(query);
    if (query.mode === "vector") {
      requireRetrievalCapability(this.descriptor, "vector");
    }

    const degraded =
      query.mode === "hybrid" &&
      !this.descriptor.supports.includes("vector")
        ? ["vector-skipped"]
        : [];
    const hits = [...this.docs.values()]
      .filter((doc) => doc.sensitivity !== null)
      .filter(
        (doc) =>
          SENSITIVITY_ORDER[doc.sensitivity!] <=
          SENSITIVITY_ORDER[query.ceiling],
      )
      .filter(
        (doc) =>
          query.scope.kinds === undefined ||
          query.scope.kinds.includes(doc.kind),
      )
      .filter(
        (doc) =>
          query.scope.subjects === undefined ||
          query.scope.subjects.some((subject) =>
            doc.subjects.includes(subject),
          ),
      )
      .filter(
        (doc) =>
          query.scope.since === undefined ||
          (doc.occurred_at !== null &&
            doc.occurred_at >= query.scope.since),
      )
      .filter(
        (doc) =>
          query.scope.until === undefined ||
          (doc.occurred_at !== null &&
            doc.occurred_at < query.scope.until),
      )
      .filter((doc) => containsEveryToken(doc, query.text))
      .sort((left, right) => compareText(left.doc_id, right.doc_id))
      .slice(0, query.limit)
      .map((doc) => ({
        doc_id: doc.doc_id,
        score: 1,
        snippet: doc.text,
        kind: doc.kind,
        sensitivity: doc.sensitivity!,
        taint: doc.taint,
        authority: doc.authority,
      }));

    return {
      hits,
      degraded,
      timings_ms: { lexical: 0 },
      space: null,
    };
  }

  async remove(ids: readonly string[]): Promise<RetrievalMutationReport> {
    for (const id of ids) this.docs.delete(id);
    this.persist();
    return { processed: ids.length };
  }

  async verifyAbsent(ids: readonly string[]): Promise<AbsenceProof> {
    return {
      checked: ids.length,
      found: ids.filter((id) => this.docs.has(id)),
      store: this.descriptor.id,
      method: `lookup-limit-${MAX_RETRIEVAL_LIMIT}`,
      at: this.ctx.clock(),
    };
  }

  async neighbors(): Promise<GraphResult> {
    requireRetrievalCapability(this.descriptor, "graph");
    return { entity: "", edges: [], truncated: false };
  }

  async health(): Promise<PortHealth> {
    return { status: "ready", detail: { documents: this.docs.size } };
  }

  async close(): Promise<void> {}

  protected persist(): void {
    const temporary = `${this.statePath}.tmp`;
    const state: PersistedState = {
      docs: [...this.docs.values()].sort((left, right) =>
        compareText(left.doc_id, right.doc_id),
      ),
    };
    writeFileSync(temporary, `${JSON.stringify(state)}\n`);
    renameSync(temporary, this.statePath);
  }
}
