import { describe, expect, test } from "bun:test";
import { LlmRejection, rejectionOf } from "../src/errors";
import { readChatAnswer } from "../src/response";
import { chatCompletion } from "./fake-endpoint";

function refuses(body: unknown): string | null {
  try {
    readChatAnswer(body);
  } catch (error) {
    expect(error).toBeInstanceOf(LlmRejection);
    return rejectionOf(error);
  }
  throw new Error("the answer was accepted");
}

describe("provider answers", () => {
  test("reads content, model and usage from a well-formed answer", () => {
    expect(readChatAnswer(chatCompletion("{}", "wire-model"))).toEqual({
      text: "{}",
      model: "wire-model",
      input_tokens: 11,
      output_tokens: 7,
    });
  });

  test("a tool call is refused as tool_call_in_response", () => {
    // Extraction offers no tools, so a tool call is an answer to a request
    // nobody made. It used to be read past and the content used anyway.
    const body = chatCompletion("{}") as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["tool_calls"] = [
      { id: "call-1", function: { name: "rm" } },
    ];
    expect(refuses(body)).toBe("tool_call_in_response");
  });

  test("a function call is refused as tool_call_in_response", () => {
    const body = chatCompletion("{}") as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["function_call"] = { name: "rm", arguments: "{}" };
    expect(refuses(body)).toBe("tool_call_in_response");
  });

  test("a content part that is not text is refused", () => {
    const body = chatCompletion("{}") as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["content"] = [
      { type: "image_url", text: "{}" },
    ];
    expect(refuses(body)).toBe("tool_call_in_response");
  });

  test("text content parts are joined", () => {
    const body = chatCompletion("{}") as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["content"] = [
      { type: "text", text: '{"cla' },
      { type: "text", text: 'ims":[]}' },
    ];
    expect(readChatAnswer(body).text).toBe('{"claims":[]}');
  });

  test("a field the endpoint added of its own is read past, not refused", () => {
    // Regression: every key outside a closed set was a rejection, so the
    // ordinary output of real OpenAI-compatible servers - timings, log
    // probabilities, a cache counter, a vendor block, a reasoning trace -
    // turned a working endpoint into one paid rejection per pass forever.
    const shapes: Record<string, (body: Record<string, unknown>) => void> = {
      timings: (body) => {
        body["timings"] = { predicted_ms: 12 };
      },
      prompt_logprobs: (body) => {
        body["prompt_logprobs"] = null;
      },
      vendor_block: (body) => {
        body["x_vendor"] = { id: "abc" };
      },
      usage_extension: (body) => {
        (body["usage"] as Record<string, unknown>)["prompt_cache_hit_tokens"] = 4;
      },
      choice_extension: (body) => {
        (body["choices"] as Record<string, unknown>[])[0]!["stop_reason"] = null;
      },
      reasoning: (body) => {
        (
          (body["choices"] as { message: Record<string, unknown> }[])[0]!
            .message
        )["reasoning_content"] = "the model thinking out loud";
      },
      annotations: (body) => {
        (
          (body["choices"] as { message: Record<string, unknown> }[])[0]!
            .message
        )["annotations"] = [];
      },
    };
    for (const [name, mutate] of Object.entries(shapes)) {
      const body = chatCompletion('{"claims":[]}') as Record<string, unknown>;
      mutate(body);
      expect([name, readChatAnswer(body).text]).toEqual([
        name,
        '{"claims":[]}',
      ]);
    }
  });

  test("a stop that means the answer is finished is accepted", () => {
    for (const finish of ["stop", "eos", "end_turn", null, undefined]) {
      const body = chatCompletion('{"claims":[]}') as {
        choices: Record<string, unknown>[];
      };
      if (finish === undefined) {
        delete body.choices[0]!["finish_reason"];
      } else {
        body.choices[0]!["finish_reason"] = finish;
      }
      expect(readChatAnswer(body).text).toBe('{"claims":[]}');
    }
  });

  test("a malformed value on a key that is read is schema_invalid", () => {
    // Regression: a negative count and a model that is not a string were
    // quietly turned into null, after which the port invented an estimate and
    // substituted its own configured model into the answer.
    const model = chatCompletion("{}") as Record<string, unknown>;
    model["model"] = 42;
    expect(refuses(model)).toBe("schema_invalid");

    const negative = chatCompletion("{}") as {
      usage: Record<string, unknown>;
    };
    negative.usage["prompt_tokens"] = -1;
    expect(refuses(negative)).toBe("schema_invalid");

    const fractional = chatCompletion("{}") as {
      usage: Record<string, unknown>;
    };
    fractional.usage["completion_tokens"] = 1.5;
    expect(refuses(fractional)).toBe("schema_invalid");
  });

  test("a tool field is still refused wherever it appears", () => {
    const choice = chatCompletion("{}") as {
      choices: Record<string, unknown>[];
    };
    choice.choices[0]!["tool_calls"] = [{ id: "c" }];
    expect(refuses(choice)).toBe("tool_call_in_response");

    const top = chatCompletion("{}") as Record<string, unknown>;
    top["function_call"] = { name: "rm" };
    expect(refuses(top)).toBe("tool_call_in_response");
  });

  test("more or fewer than one choice is schema_invalid", () => {
    expect(refuses({ choices: [] })).toBe("schema_invalid");
    expect(
      refuses({
        choices: [
          { message: { role: "assistant", content: "a" } },
          { message: { role: "assistant", content: "b" } },
        ],
      }),
    ).toBe("schema_invalid");
  });

  test("a non-assistant role or missing content is schema_invalid", () => {
    expect(
      refuses({ choices: [{ message: { role: "user", content: "a" } }] }),
    ).toBe("schema_invalid");
    expect(
      refuses({ choices: [{ message: { role: "assistant", content: null } }] }),
    ).toBe("schema_invalid");
  });

  test("an answer that was cut off is not an answer", () => {
    // Regression: finish_reason was allowlisted and then never read, so a
    // truncated reply whose JSON happened to parse advanced a checkpoint over
    // records the model never finished looking at.
    const body = chatCompletion('{"claims":[]}') as {
      choices: Record<string, unknown>[];
    };
    body.choices[0]!["finish_reason"] = "length";
    expect(refuses(body)).toBe("schema_invalid");
  });

  test("a refusal is not an empty extraction", () => {
    const body = chatCompletion('{"claims":[]}') as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["refusal"] = "I cannot help with that.";
    expect(refuses(body)).toBe("schema_invalid");
  });

  test("a stop that is not a completion is refused for what it is", () => {
    const filtered = chatCompletion('{"claims":[]}') as {
      choices: Record<string, unknown>[];
    };
    filtered.choices[0]!["finish_reason"] = "content_filter";
    expect(refuses(filtered)).toBe("schema_invalid");

    const called = chatCompletion('{"claims":[]}') as {
      choices: Record<string, unknown>[];
    };
    called.choices[0]!["finish_reason"] = "tool_calls";
    expect(refuses(called)).toBe("tool_call_in_response");
  });

  test("a finished answer with no refusal is read", () => {
    const body = chatCompletion('{"claims":[]}') as {
      choices: { message: Record<string, unknown> }[];
    };
    body.choices[0]!.message["refusal"] = null;
    expect(readChatAnswer(body).text).toBe('{"claims":[]}');
  });

  test("usage is absent rather than invented when the endpoint omits it", () => {
    const answer = readChatAnswer({
      choices: [{ message: { role: "assistant", content: "{}" } }],
    });
    expect(answer.input_tokens).toBeNull();
    expect(answer.output_tokens).toBeNull();
  });
});
