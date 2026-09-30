import { expect, test } from "bun:test";
import { KizukiError, validateEventInput } from "@kizuki/core";
import { event } from "../src/events";

const NOW = "2026-01-15T12:00:00.000Z";
function record() {
  return { id: "synthetic", status: "confirmed", updated: NOW,
    start: { date: "2026-01-15" }, end: { date: "2026-01-16" } };
}

test("invalid all-day provider dates refuse with the connector error instead of RangeError", () => {
  for (const field of ["start", "end", "originalStartTime"] as const) {
    for (const date of ["2026-99-99", "2026-00-01", "2026-01-00", "2026-02-29"]) {
      expect(() => event("synthetic", "synthetic", { ...record(), [field]: { date } }, NOW, [], NOW)).toThrow(KizukiError);
    }
  }
});

test("valid leap-day provider dates still produce ingress evidence", () => {
  const result = event("synthetic", "synthetic", { ...record(), start: { date: "2028-02-29" }, end: { date: "2028-03-01" } }, NOW, [], NOW);
  expect(validateEventInput(result).ok).toBe(true);
  expect(result.metadata["schedule"]).toMatchObject({ start: { date: "2028-02-29" }, end: { date: "2028-03-01" } });
});
