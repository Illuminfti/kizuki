import { expect, test } from "bun:test";
import { assertServingEnvelope } from "./oracle";

test("both internal-failure representations fail the campaign", () => {
  expect(() => assertServingEnvelope({ denied: [{ reason: "error", count: 1 }] }, "http-crash")).toThrow("http-crash");
  expect(() => assertServingEnvelope({ denied: [], data: { retrieval_degraded: ["context-unavailable"] } }, "mcp-crash")).toThrow("mcp-crash");
});

test("policy denials, other degradations and captured words are not failures", () => {
  for (const value of [
    undefined, null, "context-unavailable", [], { denied: "error" },
    { denied: [{ reason: "scope", count: 2 }, null], data: { retrieval_degraded: ["retrieval-unavailable"] } },
    { denied: [], quoted: [{ text: "context-unavailable" }, { reason: "error" }], canon: [{ text: "error" }], data: null },
  ]) expect(() => assertServingEnvelope(value, "http-crash")).not.toThrow();
});
