import { expect, test } from "bun:test";
import { createWorldRegistry } from "../../core/src/contracts/world-kinds";
import { WORLD_REGISTRY, WORLD_VOCABULARY_MODULES, withWorldRegistry } from "../../core/src/contracts/world-vocabulary";
import { runGoldenJourney } from "./helpers/golden-journey";

/** Candidate-registry integration only; activation still requires real held-out qualification. */
test.each(["kizuki.envelope/v2", "kizuki.envelope/v1"] as const)("GOLDEN candidate journey: shared evidence, tentative Decision correction, independent Procedure Outcome and erasure (%s owner)", async contract => {
  const before = JSON.stringify(WORLD_REGISTRY.offered);
  const candidate = createWorldRegistry(WORLD_VOCABULARY_MODULES.map(module => module.kind && ["procedure", "decision"].includes(module.kind.id)
    ? { ...module, kind: { ...module.kind, offeredToProducer: true } }
    : module.kind === null && module.predicates[0]?.predicate === "situation.has_commitment" ? { ...module, offeredToProducer: true } : module));
  await withWorldRegistry(candidate, () => runGoldenJourney(contract, true));
  expect(JSON.stringify(WORLD_REGISTRY.offered)).toBe(before);
}, 120_000);
