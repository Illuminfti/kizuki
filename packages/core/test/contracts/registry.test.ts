import { describe, expect, test } from "bun:test";
import { PortError } from "../../src/contracts/ports";
import type { PortDescriptor } from "../../src/contracts/ports";
import { PortRegistry } from "../../src/contracts/registry";
import {
  DIRECT_RETRIEVAL_DESCRIPTOR,
  ReferenceRetrievalPort,
} from "./reference-retrieval";
import { temporaryPortContext } from "./fixtures";

describe("port registry", () => {
  test("registration is immutable and listing is deterministic", () => {
    const registry = new PortRegistry();
    const later = {
      ...DIRECT_RETRIEVAL_DESCRIPTOR,
      id: "test.kizuki.retrieval.zeta",
      supports: ["lexical"],
    } satisfies PortDescriptor;
    const earlier = {
      ...DIRECT_RETRIEVAL_DESCRIPTOR,
      id: "test.kizuki.retrieval.alpha",
      supports: ["lexical"],
    } satisfies PortDescriptor;
    registry.registerPort(later, (ctx) => new ReferenceRetrievalPort(ctx, later));
    registry.registerPort(
      earlier,
      (ctx) => new ReferenceRetrievalPort(ctx, earlier),
    );

    later.supports.push("vector");

    expect(registry.listPorts("retrieval").map((entry) => entry.id)).toEqual([
      earlier.id,
      later.id,
    ]);
    expect(
      registry.resolvePort("retrieval", later.id).d.supports,
    ).toEqual(["lexical"]);
    expect(
      Object.isFrozen(registry.resolvePort("retrieval", later.id).d),
    ).toBe(true);
  });

  test("a duplicate id cannot silently replace its factory", () => {
    const registry = new PortRegistry();
    registry.registerPort(
      DIRECT_RETRIEVAL_DESCRIPTOR,
      (ctx) => new ReferenceRetrievalPort(ctx),
    );

    expect(() =>
      registry.registerPort(
        DIRECT_RETRIEVAL_DESCRIPTOR,
        (ctx) => new ReferenceRetrievalPort(ctx),
      ),
    ).toThrow(PortError);
  });

  test("an unregistered configured id is a hard startup failure", () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    try {
      expect(() =>
        registry.bindFromConfig(
          "retrieval",
          { retrieval: "test.kizuki.retrieval.missing" },
          temporary.ctx,
        ),
      ).toThrow(PortError);
      try {
        registry.bindFromConfig(
          "retrieval",
          { retrieval: "test.kizuki.retrieval.missing" },
          temporary.ctx,
        );
      } catch (error) {
        expect((error as PortError).code).toBe("unavailable");
        expect((error as PortError).retryable).toBe(false);
      }
    } finally {
      temporary.cleanup();
    }
  });

  test("missing and plural selections fail instead of guessing", () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    try {
      expect(() =>
        registry.bindFromConfig("retrieval", {}, temporary.ctx),
      ).toThrow(PortError);
      expect(() =>
        registry.bindFromConfig(
          "retrieval",
          { retrieval: [DIRECT_RETRIEVAL_DESCRIPTOR.id] },
          temporary.ctx,
        ),
      ).toThrow(PortError);
    } finally {
      temporary.cleanup();
    }
  });
});
