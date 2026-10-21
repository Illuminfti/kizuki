import { expect, test } from "bun:test";
import { assertServingEnvelope } from "./oracle";

test("owner and scoped storage failure representations fail the campaign", () => {
  expect(() => assertServingEnvelope({ denied: [{ reason: "error", count: 1 }] }, "http-crash")).toThrow("http-crash");
  expect(() => assertServingEnvelope({ denied: [], data: { retrieval_degraded: ["context-unavailable"] } }, "mcp-crash")).toThrow("mcp-crash");
  expect(() => assertServingEnvelope({ schema: "kizuki.envelope/v2", tool: "context_packet", data: {
    schema: "kizuki.context-packet/v2", result: { status: "incomplete", reasons: ["storage"], data: { coverage: { status: "partial", gaps: ["coverage"] } } },
  } }, "mcp-crash")).toThrow("mcp-crash");
});

test("policy denials, ordinary coverage and captured storage words are not failures", () => {
  for (const value of [
    undefined, null, "context-unavailable", "storage", [], { denied: "error" },
    { schema: "kizuki.envelope/v2", tool: "context_packet", data: { schema: "kizuki.context-packet/v2", result: { status: "incomplete", reasons: ["coverage"], data: { coverage: { status: "partial", gaps: ["coverage"] } } } } },
    { schema: "kizuki.envelope/v2", tool: "context_packet", data: { schema: "kizuki.context-packet/v2", result: { status: "current", reasons: ["storage"] } } },
    { schema: "kizuki.envelope/v2", tool: "world_view", data: { schema: "kizuki.context-packet/v2", result: { status: "incomplete", reasons: ["storage"] } } },
    { schema: "kizuki.envelope/v2", tool: "context_packet", data: { schema: "foreign", result: { status: "incomplete", reasons: ["storage"] } } },
    { schema: "foreign", tool: "context_packet", data: { schema: "kizuki.context-packet/v2", result: { status: "incomplete", reasons: ["storage"] } } },
    { schema: "kizuki.envelope/v2", tool: "context_packet", quoted: [{ text: "storage", reasons: ["storage"], result: { status: "incomplete", reasons: ["storage"] } }], data: null },
    { schema: "kizuki.envelope/v2", tool: "context_packet", data: { schema: "kizuki.context-packet/v2", result: { status: "incomplete", reasons: ["coverage"], data: { packetMd: "storage", reasons: ["storage"] } } } },
    { denied: [{ reason: "scope", count: 2 }, null], data: { retrieval_degraded: ["retrieval-unavailable"] } },
    { denied: [], quoted: [{ text: "context-unavailable" }, { reason: "error" }], canon: [{ text: "error" }], data: null },
    { schema: "kizuki.envelope/v2", tool: "context_packet", quoted: [{ data: { result: { data: { retrievalDegraded: ["context-unavailable"] } } } }], data: null },
  ]) expect(() => assertServingEnvelope(value, "http-crash")).not.toThrow();
});
