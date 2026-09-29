import type { ClaimsOp } from "@kizuki/core/world";

export const PING_SCHEMA = "kizuki.test-ping/v1";

/** An operation that exists only inside a test: one file, no edit to any adapter. */
export const pingOp: ClaimsOp<{ text: string }> = {
  source: "claims",
  name: "ping",
  keys: { required: ["text"], optional: [] },
  dataSchemas: [PING_SCHEMA],
  parse: (input) =>
    typeof input["text"] === "string" && input["text"].length <= 40
      ? { text: input["text"] }
      : null,
  run: (frame, query) => ({
    status: "data",
    data: { schema: PING_SCHEMA, echo: query.text, inTransaction: frame.ctx.db.inTransaction },
    gaps: null,
  }),
};

export const PING_INPUT = {
  operation: "ping",
  text: "hello",
  valid: { kind: "all" },
  knownAt: { kind: "current" },
} as const;
