import { afterEach, describe, expect, test } from "bun:test";
import { PortError } from "@kizuki/core";
import { LlmRejection } from "../src/errors";
import { OpenAiCompatibleLlm } from "../src/llm-port";
import { MODEL_PRODUCER, ModelProducer } from "../src/producer";
import { EXTRACT_BATCH, EXTRACT_INPUT_CHARS } from "../src/prompt";
import { estimateTokens, requestTokens } from "../src/spend";
import { chatCompletion, startFakeEndpoint } from "./fake-endpoint";
import type { FakeEndpoint } from "./fake-endpoint";
import {
  claimsPayload,
  event,
  modelProducerFor,
  ok,
  portContext,
  produceInput,
  replyingLlm,
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

/** What the producer reserved for the first call a harness recorded. */
function reservedFor(harness: ProducerHarness): number {
  const messages = harness.llm.calls[0]?.messages ?? [];
  return requestTokens(...messages.map((message) => message.content));
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

  test("an input budget is reserved in the unit the charge uses", async () => {
    const input = produceInput([event("ev-1", "hi")]);
    const spender = producer([claimsPayload()]);
    await spender.port.produce(input);
    const reserved = reservedFor(spender);
    expect(reserved).toBeGreaterThan(0);
    // A budget one token under what the call is expected to cost does not
    // start it: the gate is checked before anything reaches the wire.
    const refused = producer([claimsPayload()]);
    expect(
      await refused.port.produce({
        ...input,
        budget: { ...input.budget, max_input_tokens: reserved - 1 },
      }),
    ).toMatchObject({ status: "rejected", reason: "budget_exhausted" });
    expect(refused.llm.calls).toHaveLength(0);
    // Regression: the reservation counted characters while the charge counted
    // the endpoint's tokens, so a budget four times the call's real cost was
    // refused for a call it could comfortably have paid for.
    const paid = producer([claimsPayload()], {
      input_tokens: reserved,
      output_tokens: 5,
      attempts: 1,
    });
    expect(
      await paid.port.produce({
        ...input,
        budget: { ...input.budget, max_input_tokens: reserved },
      }),
    ).toMatchObject({ status: "ok" });
    expect(paid.llm.calls).toHaveLength(1);
  });

  test("a prompt outside Latin script is reserved above its bytes", () => {
    // A byte-fallback tokenizer emits a token per UTF-8 byte it has no piece
    // for, so a character count under-reserves for these two by three and
    // four times over.
    for (const text of ["\u4eac".repeat(1_000), "\u{1f600}".repeat(1_000)]) {
      expect(requestTokens(text)).toBeGreaterThan(estimateTokens(text.length));
    }
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
    const reserved = reservedFor(probe);
    expect(reserved).toBeGreaterThan(0);
    const built = producer([claimsPayload()]);
    await built.port.produce({
      ...input,
      budget: {
        ...input.budget,
        max_calls: 8,
        max_input_tokens: reserved * 2 + 1,
      },
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
    expect(result.stopped).toEqual({
      status: "rejected",
      reason: "schema_invalid",
    });
  });

  test("a stop after the first call is on the result, not only in a log", async () => {
    const events = Array.from({ length: EXTRACT_BATCH + 1 }, (_, index) =>
      event(`ev-${index}`, "short"),
    );
    const built = producer([
      claimsPayload({}, ["ev-0"]),
      new PortError("unavailable", "connection refused", true),
    ]);
    const result = ok(await built.port.produce(produceInput(events)));
    // Regression: an outage part way through a run came back as `ok`, the
    // shape reserved for "nothing durable here", and survived only as a line
    // on stderr - so a loop could not count it, doctor could not degrade the
    // rail, and a caller could not tell a truncated run from a complete one.
    expect(result.stopped).toEqual({
      status: "unavailable",
      reason: "connection refused",
    });
    expect(result.covered_event_ids).toEqual(
      events.slice(0, EXTRACT_BATCH).map((item) => item.event_id),
    );
  });

  test("a stopped run returns no claim resting on an unread record", async () => {
    const events = [
      event("ev-short", "short"),
      event("ev-long", "z".repeat(EXTRACT_INPUT_CHARS + 100)),
    ];
    const built = producer([
      claimsPayload({}, ["ev-short"]),
      claimsPayload({}, ["ev-long"]),
      new PortError("unavailable", "connection refused", true),
    ]);
    const result = ok(await built.port.produce(produceInput(events)));
    // Regression: a claim from the first half of a split record shipped while
    // the record stayed uncovered, so a writer could turn evidence the run
    // never finished sending into canon, and the next pass would re-read the
    // record and produce the same claim again.
    expect(result.covered_event_ids).toEqual(["ev-short"]);
    expect(result.claims.map((claim) => claim.event_ids)).toEqual([
      ["ev-short"],
    ]);
  });

  test("a full batch's honest answer is not cut off at the output limit", async () => {
    const events = Array.from({ length: EXTRACT_BATCH }, (_, index) =>
      event(`ev-${index}`, "short"),
    );
    // One full-size draft per record: what this reader accepts at its own
    // ceilings, which is the largest honest answer a full batch can have.
    const reply = JSON.stringify({
      claims: events.map((item) => ({
        kind: "claim",
        subject: "person:ada",
        predicate: "employment.works_at",
        object: "acme",
        polarity: "positive",
        body: "s".repeat(1_200),
        valid_from: null,
        valid_to: null,
        confidence: 0.6,
        sensitivity: "personal",
        event_ids: [item.event_id],
      })),
    });
    const built = portContext(MODEL_PRODUCER);
    cleanups.push(built.cleanup);
    const port = new ModelProducer(
      built.ctx,
      replyingLlm((request) => {
        // The endpoint honours what it was granted: a longer answer stops at
        // the limit, which this package refuses as a malformed answer.
        if (estimateTokens(reply.length) > request.max_output_tokens) {
          throw new LlmRejection(
            "schema_invalid",
            "the endpoint stopped before it finished a usable answer",
          );
        }
        return reply;
      }),
    );
    // Regression: a fixed 2048-token ceiling was smaller than an honest answer
    // for a full batch, so the reply was cut off, refused as malformed, and
    // the same batch was refused the same way on every later pass.
    const result = ok(await port.produce(produceInput(events)));
    expect(result.claims).toHaveLength(EXTRACT_BATCH);
    expect(result.covered_event_ids).toHaveLength(EXTRACT_BATCH);
  });

  test("a batch this reader refuses is put back split in two", async () => {
    const events = Array.from({ length: EXTRACT_BATCH }, (_, index) =>
      event(`ev-${index}`, "short"),
    );
    const built = portContext(MODEL_PRODUCER);
    cleanups.push(built.cleanup);
    const llm = replyingLlm((request) => {
      const blocks =
        (request.messages[1]?.content.split("<<<KZ-QUOTE").length ?? 1) - 1;
      // An endpoint whose answer for a full batch this reader will not take,
      // and whose answer for a smaller one it will.
      return blocks > EXTRACT_BATCH / 2
        ? '{"claims":[],"surprise":1}'
        : '{"claims":[]}';
    });
    const port = new ModelProducer(built.ctx, llm);
    const result = ok(await port.produce(produceInput(events)));
    // Regression: a refused batch stopped the run for good, so the same batch
    // was refused the same way on every later pass and no record behind it
    // was ever extracted.
    expect(result.stopped).toBeNull();
    expect(result.covered_event_ids).toEqual(
      events.map((item) => item.event_id),
    );
    expect(llm.calls).toHaveLength(3);
  });

  test("splitting a batch gives up rather than halving forever", async () => {
    const events = Array.from({ length: EXTRACT_BATCH }, (_, index) =>
      event(`ev-${index}`, "short"),
    );
    const built = portContext(MODEL_PRODUCER);
    cleanups.push(built.cleanup);
    const llm = replyingLlm(() => '{"claims":[],"surprise":1}');
    const port = new ModelProducer(built.ctx, llm);
    expect(await port.produce(produceInput(events, { max_calls: 64 }))).toMatchObject({
      status: "rejected",
      reason: "schema_invalid",
    });
    // A run that keeps splitting spends a paid call on every half, so the
    // retries are counted and the run stops rather than paying its way down
    // to single records.
    expect(llm.calls.length).toBeLessThanOrEqual(6);
  });

  test("a run that worked through every record stopped at nothing", async () => {
    const built = producer(['{"claims":[]}']);
    const result = ok(
      await built.port.produce(produceInput([event("ev-1", "short")])),
    );
    expect(result.stopped).toBeNull();
  });

  test("an event the call had no room for is carried, not dropped", async () => {
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
    expect(built.llm.calls).toHaveLength(2);
    expect(result.covered_event_ids).toEqual(["ev-big", "ev-empty"]);
  });

  test("escaping cannot make coverage skip a record", async () => {
    const heavy = "<".repeat(EXTRACT_INPUT_CHARS / 4);
    const events = Array.from({ length: 9 }, (_, index) =>
      event(`ev-${index}`, heavy),
    );
    const built = producer(['{"claims":[]}']);
    const result = ok(
      await built.port.produce(
        produceInput(events, { max_calls: 32, max_input_tokens: 5_000_000 }),
      ),
    );
    // Regression: batches were budgeted on the raw text while the prompt spent
    // its budget on the escaped text, so a call quietly dropped the tail of
    // its batch and the run moved on - ev-8 came back covered while ev-5 to
    // ev-7 had never been sent, and a caller checkpointing on the last
    // covered id would have skipped them for good.
    expect(result.covered_event_ids).toEqual(
      events.map((item) => item.event_id),
    );
  });

  test("an oversized record is covered only once all of it was sent", async () => {
    const long = "z".repeat(EXTRACT_INPUT_CHARS * 2 + 100);
    const events = [event("ev-long", long), event("ev-next", "short")];
    const stopped = producer(['{"claims":[]}']);
    // Regression: an event longer than one call was clipped to the budget and
    // still reported covered, so a caller checkpointed past evidence the
    // model never saw. One call cannot carry it, so it covers nothing.
    expect(
      await stopped.port.produce(
        produceInput(events, { max_calls: 1, max_input_tokens: 5_000_000 }),
      ),
    ).toMatchObject({ status: "rejected", reason: "budget_exhausted" });

    const whole = producer(['{"claims":[]}']);
    const result = ok(
      await whole.port.produce(
        produceInput(events, { max_calls: 8, max_input_tokens: 5_000_000 }),
      ),
    );
    expect(result.covered_event_ids).toEqual(["ev-long", "ev-next"]);
    expect(result.truncated_event_ids).toEqual([]);
    const sent = whole.llm.calls
      .map((call) => call.messages[1]?.content ?? "")
      .join("");
    expect(sent.split("z").length - 1).toBe(long.length);
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
