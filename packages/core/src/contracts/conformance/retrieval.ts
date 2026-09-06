import {
  RETRIEVAL_CAPABILITIES,
  RETRIEVAL_CONTRACT,
  PROVENANCE_ERASURE_CAPABILITY,
  requireProvenanceErasure,
  validateAbsenceProof,
  validateProvenanceAbsenceProof,
  validateRetrievalDoc,
} from "../retrieval";
import type {
  RetrievalDoc,
  RetrievalPort,
  RetrievalQuery,
} from "../retrieval";
import type { ConformanceHarness } from "./harness";
import {
  conformanceContext,
  runContractConformance,
} from "./harness";
import type {
  ConformanceFixtures,
  ConformanceReport,
} from "./harness";

export interface RetrievalConformanceFixtures
  extends ConformanceFixtures {
  readonly docs: readonly RetrievalDoc[];
  readonly query: RetrievalQuery;
  readonly expected_doc_ids: readonly string[];
  readonly delete_ids: readonly string[];
}

export type RetrievalConformanceHarness = ConformanceHarness<
  RetrievalPort,
  RetrievalConformanceFixtures
>;

export async function runRetrievalConformance(
  harness: RetrievalConformanceHarness,
): Promise<ConformanceReport> {
  const report = await runContractConformance(
    harness,
    {
      kind: "retrieval",
      contract: RETRIEVAL_CONTRACT,
      capabilities: RETRIEVAL_CAPABILITIES,
    },
    {
      apply: async (port, fixtures) =>
        port.upsert(fixtures.docs.map(validateRetrievalDoc)),
      // Timings are wall-clock noise, not state: two identical searches may
      // legitimately differ by a millisecond, so they are not part of what the
      // idempotence and restart families compare.
      observe: async (port, fixtures) => {
        const { timings_ms: _timings, ...semantic } = await port.search(
          fixtures.query,
        );
        return semantic;
      },
      induceFailure: async (port, fixtures) =>
        port.search({
          ...fixtures.query,
          limit: 101,
        }),
      remove: async (port, fixtures) => port.remove(fixtures.delete_ids),
      verifyAbsent: async (port, fixtures) =>
        port.verifyAbsent(fixtures.delete_ids),
    },
  );
  if (!report.pass) return report;

  const failures = [...report.failures];
  let port: RetrievalPort | undefined;
  const context = conformanceContext(harness.descriptor);
  try {
    port = await harness.create(context.ctx);
    await port.upsert(harness.fixtures.docs.map(validateRetrievalDoc));
    const result = await port.search(harness.fixtures.query);
    const ids = result.hits.map(({ doc_id }) => doc_id).sort();
    const expected = [...harness.fixtures.expected_doc_ids].sort();
    if (JSON.stringify(ids) !== JSON.stringify(expected)) {
      failures.push("retrieval: golden recall did not match");
    }
    if (
      result.hits.some(({ doc_id }) => {
        const doc = harness.fixtures.docs.find(
          (candidate) => candidate.doc_id === doc_id,
        );
        return doc?.sensitivity === null;
      })
    ) {
      failures.push("retrieval: an unlabeled document was served");
    }

    const narrow = await port.search({
      ...harness.fixtures.query,
      scope: { subjects: ["conformance:missing"] },
    });
    if (narrow.hits.length !== 0) {
      failures.push("retrieval: an empty scope widened");
    }

    if (port.descriptor.supports.includes(PROVENANCE_ERASURE_CAPABILITY)) {
      requireProvenanceErasure(port);
      const template = harness.fixtures.docs[0];
      if (template === undefined) throw new Error("provenance conformance needs a document fixture");
      const eventId = "conformance-erasure-event";
      const dependentIds = ["page:conformance-raw-support", "claim:conformance-prefixed-support"];
      const independentId = `page:${eventId}`;
      await port.upsert([
        { ...template, kind: "page", doc_id: dependentIds[0]!, provenance: [eventId] },
        { ...template, kind: "claim", doc_id: dependentIds[1]!, provenance: [`event:${eventId}`] },
        { ...template, kind: "page", doc_id: independentId, provenance: ["conformance-independent-event"] },
      ]);
      // Exact-ID v1 callers never request a provenance cascade implicitly.
      await port.remove([`event:${eventId}`]);
      const exact = validateAbsenceProof(await port.verifyAbsent([`event:${eventId}`]), [`event:${eventId}`]);
      const before = validateProvenanceAbsenceProof(await port.verifyProvenanceAbsent([eventId]), [eventId]);
      if (exact.found.length !== 0 || before.store !== port.descriptor.id || before.found.length !== 1) {
        failures.push("retrieval: exact identity and event provenance are not distinct proof scopes");
      }
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const removed = await port.removeByProvenance([eventId]);
        const proof = validateProvenanceAbsenceProof(await port.verifyProvenanceAbsent([eventId]), [eventId]);
        const docs = validateAbsenceProof(await port.verifyAbsent([...dependentIds, independentId]), [...dependentIds, independentId]);
        if (removed.processed !== 1 || proof.store !== port.descriptor.id || proof.found.length !== 0 ||
            docs.found.length !== 1 || docs.found[0] !== independentId) {
          failures.push("retrieval: provenance erasure did not remove every dependent document or preserve independent identity");
        }
      }
      await port.remove([...dependentIds, independentId]);
    }

    if (!port.descriptor.supports.includes("vector")) {
      const hybrid = await port.search({
        ...harness.fixtures.query,
        mode: "hybrid",
      });
      if (!hybrid.degraded.includes("vector-skipped")) {
        failures.push(
          "retrieval: hybrid fallback did not declare vector-skipped",
        );
      }
    }
  } catch (error) {
    failures.push(
      `retrieval: ${error instanceof Error ? error.name : "unknown error"}`,
    );
  } finally {
    if (port !== undefined) await harness.destroy(port);
    context.cleanup();
  }

  return {
    ...report,
    pass: failures.length === 0,
    failures,
  };
}
