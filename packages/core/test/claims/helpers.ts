import { Database } from "bun:sqlite";
import type { Sensitivity } from "../../src/agents/types";
import type { EventFacts } from "../../src/claims/authority";
import type { InsertClaimInput } from "../../src/claims/store";
import { accept } from "../../src/ledger/ledger";
import { recordNativeCorrection } from "../../src/correction/evidence";
import { sha256Hex } from "../../src/util/hash";
import { openLedger } from "../../src/ledger/db";
import { validEvent } from "../fixtures";
import type {
  AbsenceProof,
  RetrievalDoc,
  RetrievalMutationReport,
  RetrievalPort,
  RetrievalQuery,
  RetrievalResult,
} from "../../src/contracts/retrieval";
import type {
  PortDescriptor,
  PortHealth,
} from "../../src/contracts/ports";
import { RETRIEVAL_CONTRACT } from "../../src/contracts/retrieval";
import {
  CLAIM_DEDUP_MIN,
  FIXTURE_EMBEDDING_SPACE,
  scoreClaimPair,
} from "../../src/claims/dedup";

export const FIXED_NOW = "2026-09-02T12:00:00.000Z";

export function claimsDb(): Database {
  return openLedger(":memory:");
}

/** Positive authority fixture uses native recording, never a captured label. */
export function nativeOwnerEvent(db: Database, body: string): string {
  const request = sha256Hex(`fixture-native:${crypto.randomUUID()}`);
  return recordNativeCorrection(db, { ...validEvent(), connector_id: "kizuki.owner",
    source_record_id: request, kind: "correction", text: body, metadata: {} }, request).event_id;
}

export function putEvent(
  db: Database,
  overrides: {
    event_id?: string;
    source_record_id?: string;
    connector_id?: string;
    text?: string;
  } = {},
): string {
  const accepted = accept(
    db,
    {
      ...validEvent(),
      connector_id: overrides.connector_id ?? "fixture",
      source_record_id: overrides.source_record_id ?? `rec-${crypto.randomUUID()}`,
      text: overrides.text ?? "Grace runs partnerships at Acme.",
    },
    overrides.event_id === undefined
      ? {}
      : { generateId: () => overrides.event_id as string },
  );
  if (accepted.status !== "stored") {
    throw new Error(`failed to store event: ${JSON.stringify(accepted)}`);
  }
  return accepted.event.event_id;
}

export function eventFacts(
  eventId: string,
  overrides: Partial<EventFacts> = {},
): EventFacts {
  return {
    event_id: eventId,
    connector_id: "fixture",
    taint: "untrusted",
    text: "Grace runs partnerships at Acme.",
    ...overrides,
  };
}

export function corroboratedFacts(
  first: string,
  second: string,
): EventFacts[] {
  return [
    eventFacts(first, { connector_id: "fixture" }),
    eventFacts(second, { connector_id: "other-fixture" }),
  ];
}

export function claimInput(
  eventId: string,
  overrides: Partial<InsertClaimInput> = {},
): InsertClaimInput {
  return {
    kind: "claim",
    subject: "person:grace",
    predicate: "employment.works_at",
    object: "acme",
    polarity: "positive",
    body: "Grace runs partnerships at Acme.",
    provenance: [eventId],
    subjects: ["person:grace"],
    producer: "deterministic",
    confidence: 0.8,
    sensitivity: "personal" as Sensitivity,
    taint: "clean",
    events: [eventFacts(eventId)],
    ...overrides,
  };
}

export class FixtureVectorPort implements RetrievalPort {
  readonly descriptor: PortDescriptor;
  readonly docs = new Map<string, RetrievalDoc>();
  private readonly healthStatus: PortHealth["status"];

  constructor(
    opts: { vector?: boolean; health?: PortHealth["status"] } = {},
  ) {
    this.descriptor = {
      id: "test.kizuki.retrieval.fixture",
      kind: "retrieval",
      contract: RETRIEVAL_CONTRACT,
      contract_minor: 0,
      supports: opts.vector === false ? ["lexical"] : ["lexical", "vector"],
      requires_lease: false,
      optional_package: null,
    };
    this.healthStatus = opts.health ?? "ready";
  }

  async upsert(docs: readonly RetrievalDoc[]): Promise<RetrievalMutationReport> {
    for (const doc of docs) this.docs.set(doc.doc_id, structuredClone(doc));
    return { processed: docs.length };
  }

  async search(query: RetrievalQuery): Promise<RetrievalResult> {
    const hits = [...this.docs.values()]
      .filter((doc) => doc.kind === "claim")
      .map((doc) => ({
        doc_id: doc.doc_id,
        score: scoreClaimPair(query.text, doc.text, FIXTURE_EMBEDDING_SPACE),
        snippet: doc.text,
        kind: doc.kind,
        sensitivity: doc.sensitivity ?? "private",
        taint: doc.taint,
        authority: doc.authority,
      }))
      .filter((hit) => hit.score >= CLAIM_DEDUP_MIN)
      .slice(0, query.limit);
    return {
      hits,
      degraded: this.descriptor.supports.includes("vector") ? [] : ["vector"],
      timings_ms: { vector: 0 },
      space: FIXTURE_EMBEDDING_SPACE,
    };
  }

  async remove(ids: readonly string[]): Promise<RetrievalMutationReport> {
    for (const id of ids) this.docs.delete(id);
    return { processed: ids.length };
  }

  async verifyAbsent(ids: readonly string[]): Promise<AbsenceProof> {
    return {
      checked: ids.length,
      found: ids.filter((id) => this.docs.has(id)),
      store: this.descriptor.id,
      method: "map-lookup",
      at: FIXED_NOW,
    };
  }

  async neighbors(): Promise<never> {
    throw new Error("graph is out of scope for claims-core");
  }

  async health(): Promise<PortHealth> {
    if (this.healthStatus === "ready") {
      return { status: "ready", detail: { documents: this.docs.size } };
    }
    if (this.healthStatus === "degraded") {
      return {
        status: "degraded",
        degraded: ["vector"],
        detail: {},
      };
    }
    return { status: "unavailable", reason: "fixture retrieval off" };
  }

  async close(): Promise<void> {}
}
