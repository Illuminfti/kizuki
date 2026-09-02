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

  test("an unknown key anywhere in the answer is schema_invalid", () => {
    const top = chatCompletion("{}") as Record<string, unknown>;
    top["x_extra"] = 1;
    expect(refuses(top)).toBe("schema_invalid");

    const message = chatCompletion("{}") as {
      choices: { message: Record<string, unknown> }[];
    };
    message.choices[0]!.message["annotations"] = [];
    expect(refuses(message)).toBe("schema_invalid");
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
