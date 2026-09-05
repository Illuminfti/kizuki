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

  test("an unregistered configured id is a hard startup failure", async () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    try {
      await expect(
        registry.bindFromConfig(
          "retrieval",
          { retrieval: "test.kizuki.retrieval.missing" },
          temporary.ctx,
        ),
      ).rejects.toThrow(PortError);
      try {
        await registry.bindFromConfig(
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

  test("missing and plural selections fail instead of guessing", async () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    try {
      await expect(
        registry.bindFromConfig("retrieval", {}, temporary.ctx),
      ).rejects.toThrow(PortError);
      await expect(
        registry.bindFromConfig(
          "retrieval",
          { retrieval: [DIRECT_RETRIEVAL_DESCRIPTOR.id] },
          temporary.ctx,
        ),
      ).rejects.toThrow(PortError);
    } finally {
      temporary.cleanup();
    }
  });
});

describe("asynchronous port startup", () => {
  test("binding resolves only after the factory finishes opening", async () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    let finish!: () => void;
    const opening = new Promise<void>((resolve) => { finish = resolve; });
    let ready = false;
    registry.registerPort(DIRECT_RETRIEVAL_DESCRIPTOR, async (ctx) => {
      await opening;
      ready = true;
      return new ReferenceRetrievalPort(ctx);
    });
    try {
      const pending = registry.bindFromConfig("retrieval", {
        retrieval: DIRECT_RETRIEVAL_DESCRIPTOR.id,
      }, temporary.ctx);
      expect(ready).toBe(false);
      finish();
      const { port } = await pending;
      expect(ready).toBe(true);
      await (port as ReferenceRetrievalPort).close();
    } finally {
      temporary.cleanup();
    }
  });

  test("an asynchronous factory rejection is a startup failure", async () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    const failure = new PortError("unavailable", "engine cannot open", true);
    registry.registerPort(DIRECT_RETRIEVAL_DESCRIPTOR, async () => { throw failure; });
    try {
      await expect(registry.bindFromConfig("retrieval", {
        retrieval: DIRECT_RETRIEVAL_DESCRIPTOR.id,
      }, temporary.ctx)).rejects.toBe(failure);
    } finally {
      temporary.cleanup();
    }
  });

  test("plural binding validates all contexts before opening any port", async () => {
    const registry = new PortRegistry();
    const temporary = temporaryPortContext(DIRECT_RETRIEVAL_DESCRIPTOR);
    const other = { ...DIRECT_RETRIEVAL_DESCRIPTOR, id: "test.kizuki.retrieval.other" };
    let opened = 0;
    for (const descriptor of [DIRECT_RETRIEVAL_DESCRIPTOR, other]) {
      registry.registerPort(descriptor, async (ctx) => {
        opened += 1;
        return new ReferenceRetrievalPort(ctx, descriptor);
      });
    }
    try {
      await expect(registry.bindManyFromConfig("retrieval", {
        retrieval: [DIRECT_RETRIEVAL_DESCRIPTOR.id, other.id],
      }, () => temporary.ctx)).rejects.toThrow("isolated registry path");
      expect(opened).toBe(0);
    } finally {
      temporary.cleanup();
    }
  });

  test("plural startup rolls back in reverse order and reports cleanup failures", async () => {
    const registry = new PortRegistry();
    const descriptors = ["first", "second", "third"].map((name) => ({
      ...DIRECT_RETRIEVAL_DESCRIPTOR, id: `test.kizuki.retrieval.${name}`,
    }));
    const contexts = descriptors.map((descriptor) => temporaryPortContext(descriptor));
    const closed: string[] = [];
    const openFailure = new PortError("unavailable", "third cannot open", true);
    const closeFailure = new Error("second cannot close");
    descriptors.forEach((descriptor, index) => {
      registry.registerPort(descriptor, async (ctx) => {
        if (index === 2) throw openFailure;
        const port = new ReferenceRetrievalPort(ctx, descriptor);
        port.close = async () => {
          closed.push(descriptor.id);
          if (index === 1) throw closeFailure;
        };
        return port;
      });
    });
    try {
      const pending = registry.bindManyFromConfig("retrieval", {
        retrieval: descriptors.map(({ id }) => id),
      }, (id) => contexts[descriptors.findIndex((entry) => entry.id === id)]!.ctx);
      await expect(pending).rejects.toBeInstanceOf(AggregateError);
      try {
        await pending;
      } catch (error) {
        expect((error as AggregateError).errors).toEqual([openFailure, closeFailure]);
      }
      expect(closed).toEqual([descriptors[1]!.id, descriptors[0]!.id]);
    } finally {
      contexts.forEach((context) => context.cleanup());
    }
  });
});
