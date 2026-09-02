import { afterEach, describe, expect, test } from "bun:test";
import { OpenAiCompatibleLlm } from "../src/llm-port";
import { MODEL_PRODUCER, ModelProducer } from "../src/producer";
import { EXTRACT_BATCH, EXTRACT_INPUT_CHARS } from "../src/prompt";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import {
  claimsPayload,
  event,
  modelProducerFor,
  ok,
  portContext,
  produceInput,
} from "./helpers";
import type { ProducerHarness } from "./helpers";

const cleanups: (() => void)[] = [];
let endpoint: FakeEndpoint | undefined;

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  await endpoint?.stop();
  endpoint = undefined;
});

function producer(
  script: (string | Error)[],
  usage?: { input_tokens: number; output_tokens: number; attempts: number },
): ProducerHarness {
  const built = modelProducerFor(script, usage);
  cleanups.push(built.cleanup);
  return built;
}

describe("budgets", () => {
  test("a spent call budget keeps what earlier batches produced", async () => {
    const events = Array.from({ length: EXTRACT_BATCH * 2 }, (_, index) =>
      event(`ev-${index}`, "short"),
    );
    const built = producer([claimsPayload({}, ["ev-0"])]);
    const result = ok(
      await built.port.produce(produceInput(events, { max_calls: 1 })),
    );
    // Regression: the paid-for claim from the first batch was discarded and
    // the caller was handed a rejection carrying the spend but not the work.
    expect(result.claims).toHaveLength(1);
    expect(result.covered_event_ids).toEqual(
      events.slice(0, EXTRACT_BATCH).map((item) => item.event_id),
    );
    expect(built.llm.calls).toHaveLength(1);
  });

  test("the call budget is the allowance the port is given", async () => {
    const built = producer([claimsPayload()]);
    await built.port.produce(
      produceInput([event("ev-1", "hi")], { max_calls: 3 }),
    );
    expect(built.llm.calls[0]?.max_attempts).toBe(3);
  });

  test("an input budget is reserved at one character per token", async () => {
    const input = produceInput([event("ev-1", "hi")]);
    const spender = producer([claimsPayload()]);
    await spender.port.produce(input);
    const sent =
      spender.llm.calls[0]?.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      ) ?? 0;
    expect(sent).toBeGreaterThan(0);
    // Regression: the gate reserved four characters per token, so a call much
    // larger than the budget was started and only priced afterwards.
    const built = producer([claimsPayload()]);
    const result = await built.port.produce({
      ...input,
      budget: { ...input.budget, max_input_tokens: sent - 1 },
    });
    expect(result).toMatchObject({
      status: "rejected",
      reason: "budget_exhausted",
    });
    expect(built.llm.calls).toHaveLength(0);
  });

  test("an endpoint that charges past the budget never answers ok", async () => {
    const built = producer([claimsPayload()], {
      input_tokens: 10_000,
      output_tokens: 5,
      attempts: 1,
    });
    const result = await built.port.produce(
      produceInput([event("ev-1", "hi")], { max_input_tokens: 5_000 }),
    );
    expect(result).toMatchObject({
      status: "rejected",
      reason: "budget_exhausted",
    });
    if (result.status !== "rejected") throw new Error("not rejected");
    expect(result.usage.input_tokens).toBe(10_000);
  });

  test("a retry is a request the call budget already paid for", async () => {
    endpoint = startFakeEndpoint((count) =>
      count === 0
        ? { status: 503, headers: { "retry-after": "0" } }
        : { body: chatCompletion('{"claims":[]}') },
    );
    const built = portContext(MODEL_PRODUCER, {
      base_url: `${endpoint.url}/v1`,
      model: "m",
    });
    cleanups.push(built.cleanup);
    const port = new ModelProducer(
      built.ctx,
      new OpenAiCompatibleLlm(built.ctx),
    );
    const result = await port.produce(
      produceInput([event("ev-1", "hi")], { max_calls: 1 }),
    );
    // Regression: max_calls counted completions while the port retried
    // underneath it, so one allowed call could put three requests on the wire.
    expect(endpoint.requests).toHaveLength(1);
    expect(result.status).toBe("unavailable");
  });

  test("a failed call is charged every request it put on the wire", async () => {
    const refused = chatCompletion('{"claims":[]}') as {
      choices: { message: Record<string, unknown> }[];
    };
    refused.choices[0]!.message["tool_calls"] = [{ id: "c", function: {} }];
    endpoint = startFakeEndpoint((count) =>
      count < 2
        ? { status: 503, headers: { "retry-after": "0" } }
        : { body: refused },
    );
    const built = portContext(MODEL_PRODUCER, {
      base_url: `${endpoint.url}/v1`,
      model: "m",
    });
    cleanups.push(built.cleanup);
    const port = new ModelProducer(
      built.ctx,
      new OpenAiCompatibleLlm(built.ctx),
    );
    const result = await port.produce(produceInput([event("ev-1", "hi")]));
    // Regression: the failure path charged exactly one call however many
    // requests the port had already made, and threw away the tokens the
    // endpoint had reported, so a receipt under-reported what a run spent.
    expect(endpoint.requests).toHaveLength(3);
    expect(result).toMatchObject({
      status: "rejected",
      reason: "tool_call_in_response",
    });
    if (result.status !== "rejected") throw new Error("not rejected");
    expect(result.usage.calls).toBe(3);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
  });

  test("an outage reports what the run had already spent", async () => {
    endpoint = startFakeEndpoint(() => ({
      status: 503,
      headers: { "retry-after": "0" },
    }));
    const built = portContext(MODEL_PRODUCER, {
      base_url: `${endpoint.url}/v1`,
      model: "m",
    });
    cleanups.push(built.cleanup);
    const port = new ModelProducer(
      built.ctx,
      new OpenAiCompatibleLlm(built.ctx),
    );
    const result = await port.produce(produceInput([event("ev-1", "hi")]));
    // Regression: three requests were served and the result carried no usage
    // at all, so the run receipt showed an outage that had cost nothing.
    expect(endpoint.requests).toHaveLength(3);
    if (result.status !== "unavailable") throw new Error("expected an outage");
    expect(result.usage?.calls).toBe(3);
    expect(result.usage?.input_tokens).toBeGreaterThan(0);
  });

  test("the input budget bounds the requests one call may make", async () => {
    const input = produceInput([event("ev-1", "hi")]);
    const probe = producer([claimsPayload()]);
    await probe.port.produce(input);
    const sent =
      probe.llm.calls[0]?.messages.reduce(
        (total, message) => total + message.content.length,
        0,
      ) ?? 0;
    expect(sent).toBeGreaterThan(0);
    const built = producer([claimsPayload()]);
    await built.port.produce({
      ...input,
      budget: { ...input.budget, max_calls: 8, max_input_tokens: sent * 2 + 1 },
    });
    // Regression: the allowance handed to the port was the remaining call
    // budget alone, so a call could retry the same prompt until the input
    // budget it was reserved against had been overrun several times.
    expect(built.llm.calls[0]?.max_attempts).toBe(2);
  });

  test("a batch that fails keeps what earlier batches produced", async () => {
    const events = Array.from({ length: EXTRACT_BATCH + 1 }, (_, index) =>
      event(`ev-${index}`, "short"),
    );
    const built = producer([
      claimsPayload({}, ["ev-0"]),
      '{"claims":[],"surprise":1}',
    ]);
    const result = ok(await built.port.produce(produceInput(events)));
    // Regression: a rejection in the second batch threw away the first
    // batch's claim while still charging for both calls.
    expect(result.claims).toHaveLength(1);
    expect(result.covered_event_ids).toEqual(
      events.slice(0, EXTRACT_BATCH).map((item) => item.event_id),
    );
    expect(built.logs.map((line) => line.message)).toEqual([
      "the run stopped before the last batch",
    ]);
  });

  test("an event the prompt had no room for is not covered", async () => {
    const built = producer(['{"claims":[]}']);
    const result = ok(
      await built.port.produce(
        produceInput([
          event("ev-big", "x".repeat(EXTRACT_INPUT_CHARS)),
          event("ev-empty", ""),
        ]),
      ),
    );
    // Regression: an event dropped for lack of room left no trace, so the
    // caller advanced over a record the model never saw.
    expect(result.covered_event_ids).toEqual(["ev-big"]);
  });

  test("an input budget smaller than the first call spends nothing", async () => {
    const built = producer([claimsPayload()]);
    const result = await built.port.produce(
      produceInput([event("ev-1", "hi")], { max_input_tokens: 1 }),
    );
    expect(result).toEqual({
      status: "rejected",
      reason: "budget_exhausted",
      usage: { calls: 0, input_tokens: 0, output_tokens: 0 },
    });
    expect(built.llm.calls).toHaveLength(0);
  });

  test("the output budget caps what one call may ask for", async () => {
    const built = producer(['{"claims":[]}']);
    await built.port.produce(
      produceInput([event("ev-1", "hi")], { max_output_tokens: 16 }),
    );
    expect(built.llm.calls[0]?.max_output_tokens).toBe(16);
  });
});
