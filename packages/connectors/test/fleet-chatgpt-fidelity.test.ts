import { describe, expect, test } from "bun:test";
import { validateEventInput, type CaptureEventInput } from "@kizuki/core";
import {
  CHATGPT_IMPORT_CONNECTOR_ID,
  parseChatGptExport,
} from "../src";

const OBSERVED_AT = "2026-06-01T15:00:00.000Z";

/** Core stamps identity and origin; connector ingress must not. */
const CORE_STAMPS = [
  "event_id",
  "content_hash",
  "content_hash_version",
  "text_hash",
  "origin",
  "origin_binding_version",
  "origin_binding_kind",
  "origin_binding",
] as const;

const BRANCHED_EXPORT = [
  {
    id: "thread-alpha",
    title: "Branching thread",
    create_time: 1_704_067_200,
    current_node: "reply-west",
    mapping: {
      root: { parent: null, children: ["prompt"] },
      prompt: {
        message: {
          author: { role: "user" },
          content: { parts: ["Choose a path"] },
          create_time: 1_704_067_200,
        },
        parent: "root",
        children: ["reply-east", "reply-west"],
      },
      "reply-east": {
        message: {
          author: { role: "assistant" },
          content: { parts: ["East branch"] },
          create_time: 1_704_067_260,
        },
        parent: "prompt",
        children: [],
      },
      "reply-west": {
        message: {
          author: { role: "assistant" },
          content: { parts: ["West branch"] },
          create_time: 1_704_067_320,
        },
        parent: "prompt",
        children: [],
      },
    },
  },
  {
    conversation_id: "thread-beta",
    title: "Second thread",
    create_time: 1_704_153_600,
    mapping: {
      prompt: {
        message: {
          author: { role: "user" },
          content: { parts: ["A later question"] },
          create_time: 1_704_153_600,
        },
        parent: null,
        children: [],
      },
    },
  },
];

const MACHINE_ORIGIN_EXPORT = [
  {
    id: "machine-thread",
    title: "Machine origin",
    mapping: {
      "system-1": {
        message: {
          author: { role: "system" },
          content: { parts: ["You are a helpful assistant."] },
          create_time: 1_704_067_200,
        },
      },
      "tool-1": {
        message: {
          author: { role: "tool" },
          content: { parts: ["lookup result"] },
          create_time: 1_704_067_260,
        },
      },
      "developer-1": {
        message: {
          author: { role: "developer" },
          content: { parts: ["should not import"] },
          create_time: 1_704_067_320,
        },
      },
      "hidden-1": {
        message: {
          author: { role: "assistant" },
          content: { content_type: "execution_output" },
          create_time: 1_704_067_380,
        },
      },
    },
  },
];

function chatgptMessage(fields: {
  source_record_id: string;
  occurred_at: string;
  text: string;
  handle: "self" | "assistant" | "system" | "tool";
  conversation_title: string;
}): CaptureEventInput {
  return {
    schema: "kizuki.event/v1",
    connector_id: CHATGPT_IMPORT_CONNECTOR_ID,
    source_record_id: fields.source_record_id,
    kind: "message",
    occurred_at: fields.occurred_at,
    observed_at: OBSERVED_AT,
    text: fields.text,
    subjects: [{ subject_id: `chatgpt:${fields.handle}`, role: "from" }],
    deleted: false,
    attachments: [],
    metadata: {
      handle: fields.handle,
      namespace: "chatgpt",
      conversation_title: fields.conversation_title,
      unsupported_parts: [],
      export: "chatgpt-conversations.json",
    },
  };
}

const EXPECTED_BRANCHED_EVENTS: CaptureEventInput[] = [
  chatgptMessage({
    source_record_id: "v1:2:11:thread-beta:6:prompt",
    occurred_at: "2024-01-02T00:00:00.000Z",
    text: "A later question",
    handle: "self",
    conversation_title: "Second thread",
  }),
  chatgptMessage({
    source_record_id: "v1:2:12:thread-alpha:10:reply-east",
    occurred_at: "2024-01-01T00:01:00.000Z",
    text: "East branch",
    handle: "assistant",
    conversation_title: "Branching thread",
  }),
  chatgptMessage({
    source_record_id: "v1:2:12:thread-alpha:10:reply-west",
    occurred_at: "2024-01-01T00:02:00.000Z",
    text: "West branch",
    handle: "assistant",
    conversation_title: "Branching thread",
  }),
  chatgptMessage({
    source_record_id: "v1:2:12:thread-alpha:6:prompt",
    occurred_at: "2024-01-01T00:00:00.000Z",
    text: "Choose a path",
    handle: "self",
    conversation_title: "Branching thread",
  }),
];

const EXPECTED_MACHINE_EVENTS: CaptureEventInput[] = [
  chatgptMessage({
    source_record_id: "v1:2:15:machine-thread:8:system-1",
    occurred_at: "2024-01-01T00:00:00.000Z",
    text: "You are a helpful assistant.",
    handle: "system",
    conversation_title: "Machine origin",
  }),
  chatgptMessage({
    source_record_id: "v1:2:15:machine-thread:6:tool-1",
    occurred_at: "2024-01-01T00:01:00.000Z",
    text: "lookup result",
    handle: "tool",
    conversation_title: "Machine origin",
  }),
];

const EXPECTED_MACHINE_ERRORS = [
  {
    location: "machine-thread/developer-1",
    code: "unsupported_role",
    reason: "message role is not user, assistant, system, or tool",
  },
  {
    location: "machine-thread/hidden-1",
    code: "unsupported_part",
    reason: "unsupported content parts: execution_output",
  },
  {
    location: "machine-thread/hidden-1",
    code: "empty_content",
    reason: "message has no text or attachments",
  },
];

function byRecordId(
  events: readonly CaptureEventInput[],
): CaptureEventInput[] {
  return [...events].sort((left, right) =>
    left.source_record_id < right.source_record_id
      ? -1
      : left.source_record_id > right.source_record_id
        ? 1
        : 0,
  );
}

function byLocationCode<T extends { location: string; code: string }>(
  errors: readonly T[],
): T[] {
  return [...errors].sort((left, right) => {
    const leftKey = `${left.location}\0${left.code}`;
    const rightKey = `${right.location}\0${right.code}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function assertIngressOnly(event: CaptureEventInput): void {
  expect(validateEventInput(event).ok).toBe(true);
  for (const key of CORE_STAMPS) {
    expect(key in event).toBe(false);
  }
}

describe("ChatGPT export fidelity", () => {
  test("a branched export freezes distinct conversation, message, branch, role, and timestamp events on repeat parse", () => {
    const first = parseChatGptExport(
      JSON.stringify(BRANCHED_EXPORT),
      OBSERVED_AT,
    );
    expect(first.errors).toEqual([]);
    expect(byRecordId(first.events)).toEqual(byRecordId(EXPECTED_BRANCHED_EVENTS));
    for (const event of first.events) assertIngressOnly(event);

    const repeated = parseChatGptExport(
      JSON.stringify(BRANCHED_EXPORT),
      OBSERVED_AT,
    );
    expect(repeated).toEqual(first);
  });

  test("supported machine-origin roles import; unsupported machine records are reported without events", () => {
    const result = parseChatGptExport(
      JSON.stringify(MACHINE_ORIGIN_EXPORT),
      OBSERVED_AT,
    );
    expect(byRecordId(result.events)).toEqual(byRecordId(EXPECTED_MACHINE_EVENTS));
    expect(byLocationCode(result.errors)).toEqual(
      byLocationCode(EXPECTED_MACHINE_ERRORS),
    );
    for (const event of result.events) assertIngressOnly(event);
  });
});
