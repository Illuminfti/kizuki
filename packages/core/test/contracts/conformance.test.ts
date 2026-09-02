import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  runRetrievalConformance,
} from "../../src/contracts/conformance/retrieval";
import type {
  RetrievalConformanceHarness,
} from "../../src/contracts/conformance/retrieval";
import {
  PortError,
} from "../../src/contracts/ports";
import type {
  PortContext,
  PortDescriptor,
} from "../../src/contracts/ports";
import { PortRegistry } from "../../src/contracts/registry";
import {
  requireRetrievalCapability,
} from "../../src/contracts/retrieval";
import type {
  RetrievalPort,
  RetrievalQuery,
  RetrievalResult,
} from "../../src/contracts/retrieval";
import {
  RETRIEVAL_FIXTURES,
  temporaryPortContext,
} from "./fixtures";
import {
  DIRECT_RETRIEVAL_DESCRIPTOR,
  ReferenceRetrievalPort,
} from "./reference-retrieval";

const ALTERNATE_DESCRIPTOR = {
  ...DIRECT_RETRIEVAL_DESCRIPTOR,
  id: "test.kizuki.retrieval.alternate",
} as const satisfies PortDescriptor;

function harness(
  descriptor: PortDescriptor,
  factory: (ctx: PortContext) => RetrievalPort,
): RetrievalConformanceHarness {
  return {
    descriptor,
    create: async (ctx) => factory(ctx),
    destroy: async (port) => port.close(),
    fixtures: RETRIEVAL_FIXTURES,
  };
}

describe("port conformance", () => {
  test("every registered port passes its contract conformance suite", async () => {
    const registry = new PortRegistry();
    registry.registerPort(
      DIRECT_RETRIEVAL_DESCRIPTOR,
      (ctx) => new ReferenceRetrievalPort(ctx),
    );
    registry.registerPort(
      ALTERNATE_DESCRIPTOR,
      (ctx) => new ReferenceRetrievalPort(ctx, ALTERNATE_DESCRIPTOR),
    );

    const descriptors = registry.listPorts("retrieval");
    expect(descriptors.map(({ id }) => id)).toEqual([
      DIRECT_RETRIEVAL_DESCRIPTOR.id,
      ALTERNATE_DESCRIPTOR.id,
    ].sort());

    for (const descriptor of descriptors) {
      const registration = registry.resolvePort<RetrievalPort>(
        "retrieval",
        descriptor.id,
      );
      const report = await runRetrievalConformance(
        harness(registration.d, registration.factory),
      );
      expect(report.failures).toEqual([]);
      expect(report.pass).toBe(true);
      expect(report.families).toEqual({
        identity: "pass",
        isolation: "pass",
        idempotence: "pass",
        failure_shape: "pass",
        restart: "pass",
        deletion: "pass",
      });
    }
  });

  test("a port that writes outside its data dir fails isolation", async () => {
    class EscapingPort extends ReferenceRetrievalPort {
      constructor(ctx: PortContext) {
        super(ctx);
        writeFileSync(join(ctx.vault_path, "escaped.txt"), "outside\n");
      }
    }

    const report = await runRetrievalConformance(
      harness(
        DIRECT_RETRIEVAL_DESCRIPTOR,
        (ctx) => new EscapingPort(ctx),
      ),
    );

    expect(report.pass).toBe(false);
    expect(report.families.isolation).toBe("fail");
    expect(report.failures).toContainEqual(
      expect.stringContaining("isolation"),
    );
  });

  test("a port that returns empty instead of throwing fails failure_shape", async () => {
    class EmptyOnFailurePort extends ReferenceRetrievalPort {
      override async search(query: RetrievalQuery): Promise<RetrievalResult> {
        if (query.limit > 100) {
          return {
            hits: [],
            degraded: [],
            timings_ms: {},
            space: null,
          };
        }
        return super.search(query);
      }
    }

    const report = await runRetrievalConformance(
      harness(
        DIRECT_RETRIEVAL_DESCRIPTOR,
        (ctx) => new EmptyOnFailurePort(ctx),
      ),
    );

    expect(report.pass).toBe(false);
    expect(report.families.failure_shape).toBe("fail");
    expect(report.failures).toContainEqual(
      expect.stringContaining("failure_shape"),
    );
  });

  test("a major contract mismatch is refused at bind time", () => {
    const registry = new PortRegistry();
    const incompatible = {
      ...DIRECT_RETRIEVAL_DESCRIPTOR,
      id: "test.kizuki.retrieval.incompatible",
      contract: "kizuki.retrieval/v2",
    } satisfies PortDescriptor;
    let factoryCalls = 0;
    registry.registerPort(incompatible, (ctx) => {
      factoryCalls += 1;
      return new ReferenceRetrievalPort(ctx, incompatible);
    });
    const temporary = temporaryPortContext(incompatible);

    try {
      expect(() =>
        registry.bindFromConfig<RetrievalPort>(
          "retrieval",
          { retrieval: incompatible.id },
          temporary.ctx,
        ),
      ).toThrow(PortError);
      try {
        registry.bindFromConfig<RetrievalPort>(
          "retrieval",
          { retrieval: incompatible.id },
          temporary.ctx,
        );
      } catch (error) {
        expect(error).toBeInstanceOf(PortError);
        expect((error as PortError).code).toBe("contract_mismatch");
      }
      expect(factoryCalls).toBe(0);
    } finally {
      temporary.cleanup();
    }
  });

  test("an undeclared optional capability throws not_supported", () => {
    expect(() =>
      requireRetrievalCapability(DIRECT_RETRIEVAL_DESCRIPTOR, "vector"),
    ).toThrow(PortError);
    try {
      requireRetrievalCapability(DIRECT_RETRIEVAL_DESCRIPTOR, "vector");
    } catch (error) {
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe("not_supported");
      expect((error as PortError).retryable).toBe(false);
    }
  });
});
