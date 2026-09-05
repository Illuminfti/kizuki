import { expect, test } from "bun:test";
import { PortRegistry } from "../../src/contracts/registry";
import type { PortDescriptor } from "../../src/contracts/ports";
import { temporaryPortContext } from "./fixtures";

test("producer v2 requires explicit supported major and preserves registry identity", async () => {
  const registry = new PortRegistry();
  const descriptor: PortDescriptor = { id: "kizuki.producer.model.v2", kind: "producer", contract: "kizuki.producer/v2",
    contract_minor: 0, supports: ["model"], requires_lease: false, optional_package: null };
  let calls = 0;
  registry.registerPort(descriptor, () => { calls++; return { close: async () => {} }; });
  const temporary = temporaryPortContext(descriptor);
  try {
    await expect(registry.bindFromConfig("producer", { producer: descriptor.id }, temporary.ctx)).rejects.toMatchObject({ code: "contract_mismatch" });
    await expect(registry.bindFromConfig("producer", { producer: descriptor.id }, temporary.ctx, "kizuki.producer/v99")).rejects.toMatchObject({ code: "contract_mismatch" });
    await expect(registry.bindManyFromConfig("producer", { producer: [descriptor.id] }, () => temporary.ctx)).rejects.toMatchObject({ code: "contract_mismatch" });
    expect(calls).toBe(0);
    await registry.bindFromConfig("producer", { producer: descriptor.id }, temporary.ctx, "kizuki.producer/v2");
    await registry.bindManyFromConfig("producer", { producer: [descriptor.id] }, () => temporary.ctx, "kizuki.producer/v2");
    expect(calls).toBe(2);
    expect(() => registry.registerPort({ ...descriptor, contract: "kizuki.producer/v1" }, () => null)).toThrow("already registered");
  } finally { temporary.cleanup(); }
});

test("an arbitrary matching descriptor/expected contract never enables another family major", async () => {
  const registry = new PortRegistry();
  const descriptor: PortDescriptor = { id: "kizuki.retrieval.future", kind: "retrieval", contract: "kizuki.retrieval/v2",
    contract_minor: 0, supports: [], requires_lease: false, optional_package: null };
  let calls = 0;
  registry.registerPort(descriptor, () => { calls++; return {}; });
  const temporary = temporaryPortContext(descriptor);
  try {
    await expect(registry.bindFromConfig("retrieval", { retrieval: descriptor.id }, temporary.ctx, descriptor.contract)).rejects.toMatchObject({ code: "contract_mismatch" });
    expect(calls).toBe(0);
  } finally { temporary.cleanup(); }
});
