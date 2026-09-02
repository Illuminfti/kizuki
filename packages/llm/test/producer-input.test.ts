import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import { MODEL_PRODUCER, ModelProducer, modelProducer } from "../src/producer";
import {
  claimsPayload,
  event,
  minorZeroLlm,
  modelProducerFor,
  ok,
  portContext,
  produceInput,
  scriptedLlm,
} from "./helpers";
import type { ProducerHarness } from "./helpers";

const knownClaim = {
  claim_id: "c1",
  subject: "person:ada",
  predicate: "employment.works_at",
  object: "acme",
  polarity: "positive" as const,
  confidence: 0.6,
};

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function producer(
  script: (string | Error)[],
  usage?: { input_tokens: number; output_tokens: number; attempts: number },
): ProducerHarness {
  const built = modelProducerFor(script, usage);
  cleanups.push(built.cleanup);
  return built;
}

describe("input validation", () => {
  test("a malformed input is a PortError, never a silent pass", async () => {
    const built = producer(['{"claims":[]}']);
    const input = produceInput([event("ev-1", "hi")]);
    await expect(
      built.port.produce({ ...input, events: [{} as never] }),
    ).rejects.toBeInstanceOf(PortError);
    await expect(
      built.port.produce({
        ...input,
        context: { ...input.context, predicates: [] },
      }),
    ).rejects.toBeInstanceOf(PortError);
    await expect(
      built.port.produce({
        ...input,
        budget: { ...input.budget, max_calls: -1 },
      }),
    ).rejects.toBeInstanceOf(PortError);
    expect(built.llm.calls).toHaveLength(0);
  });

  test("a malformed context element is a PortError, never a silent pass", async () => {
    const built = producer(['{"claims":[]}']);
    const input = produceInput([event("ev-1", "hi")]);
    // Regression: only the arrays were checked, so a bad element either
    // escaped as a raw TypeError or was sent to the model as `null`.
    const broken = [
      { subjects: [null as never] },
      { subjects: ["oops" as never] },
      { subjects: [{ subject_id: "", role: "about" } as never] },
      { known_claims: [null as never] },
      { known_claims: [42 as never] },
      { known_claims: [{ ...knownClaim, object: "o".repeat(401) } as never] },
      { predicates: ["p".repeat(101)] },
    ];
    for (const patch of broken) {
      await expect(
        built.port.produce({
          ...input,
          context: { ...input.context, ...patch },
        }),
      ).rejects.toBeInstanceOf(PortError);
    }
    expect(built.llm.calls).toHaveLength(0);
  });

  test("an event id that could reshape the prompt is refused", async () => {
    const built = producer(['{"claims":[]}']);
    const input = produceInput([event("ev-1", "hi")]);
    for (const id of ["ev>>>1", "ev\n1", "ev 1", "ev\u0000"]) {
      await expect(
        built.port.produce({ ...input, events: [event(id, "hi")] }),
      ).rejects.toBeInstanceOf(PortError);
    }
    expect(built.llm.calls).toHaveLength(0);
  });

  test("a model port that reports nonsense usage is charged the minimum", async () => {
    const built = producer([claimsPayload()], {
      input_tokens: Number.NaN,
      output_tokens: -5,
      attempts: 0,
    });
    const result = ok(
      await built.port.produce(produceInput([event("ev-1", "hi")])),
    );
    expect(result.usage).toEqual({
      calls: 1,
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  test("a permanent port failure is not reported as an outage", async () => {
    const built = producer([
      new PortError("config_invalid", "the request is malformed", false),
    ]);
    // Regression: every failure that was not a rejection came back as
    // `unavailable`, which tells the caller to hold its checkpoint and retry
    // the identical batch forever.
    await expect(
      built.port.produce(produceInput([event("ev-1", "hi")])),
    ).rejects.toBeInstanceOf(PortError);
  });

  test("a closed producer refuses to produce", async () => {
    const built = producer(['{"claims":[]}']);
    await built.port.close();
    await expect(
      built.port.produce(produceInput([event("ev-1", "hi")])),
    ).rejects.toBeInstanceOf(PortError);
  });

  test("a model port below the minor is used, charged one call, and declared", async () => {
    const context = portContext(MODEL_PRODUCER);
    cleanups.push(context.cleanup);
    const llm = minorZeroLlm(claimsPayload());
    const port = new ModelProducer(context.ctx, llm);
    // RFC 0002 §3.3: below the minor that added `attempts` the producer takes
    // the documented fallback rather than refusing the port or inventing a
    // count, and says through health that the rail is degraded.
    expect(await port.health()).toEqual({
      status: "degraded",
      degraded: [
        "the model port reports no attempts, so a retried call is charged as one request",
      ],
      detail: {
        llm: "kizuki.llm.minor-zero",
        model_ref: "kizuki.llm.minor-zero:m@127.0.0.1",
      },
    });
    const result = ok(
      await port.produce(produceInput([event("ev-1", "Ada joined acme.")])),
    );
    expect(result.claims).toHaveLength(1);
    expect(result.usage.calls).toBe(1);
  });

  test("health follows the model port it was given", async () => {
    const context = portContext(MODEL_PRODUCER);
    cleanups.push(context.cleanup);
    const factory = modelProducer(
      scriptedLlm([], { status: "unavailable", reason: "no endpoint" }),
    );
    const port = factory(context.ctx);
    expect(await port.health()).toEqual({
      status: "unavailable",
      reason: "llm port: no endpoint",
    });
  });
});
