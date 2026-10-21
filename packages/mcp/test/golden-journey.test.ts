import { test } from "bun:test";
import { runGoldenJourney } from "./helpers/golden-journey";

/** Scripted model output proves integration only; default producer flags remain unchanged. */
test.each(["kizuki.envelope/v2", "kizuki.envelope/v1"] as const)("GOLDEN common journey: capture, shared evidence, lag and narrowed authority (%s owner)", async contract => {
  await runGoldenJourney(contract);
}, 120_000);
