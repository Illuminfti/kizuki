import { describe, expect, test } from "bun:test";
import { distillTakeoutActivity } from "./reclaim-takeout-spike";

const activity = { title: "Searched for gardening", time: "2026-09-01T12:00:00Z", products: ["Search"] };

describe("post-1.0 Takeout activity spike", () => {
  test("projects selected evidence and a content-bound receipt without interpreting behavior", () => {
    const source = JSON.stringify([{ ...activity, locationInfos: [{ secret: "omitted" }] }]);
    const result = distillTakeoutActivity(source);
    expect(result.activities).toEqual([{
      record_index: 0,
      title: activity.title,
      occurred_at: activity.time,
      products: ["Search"],
    }]);
    expect(result.receipt.input_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.receipt.records).toBe(1);
    expect(result.receipt.input_bytes).toBe(Buffer.byteLength(source));
    expect(JSON.stringify(result)).not.toContain("omitted");
    expect(distillTakeoutActivity(source)).toEqual(result);
    expect(distillTakeoutActivity(JSON.stringify([activity])).receipt.input_sha256)
      .not.toBe(result.receipt.input_sha256);
  });

  test("preserves duplicate positions rather than inventing vendor identities", () => {
    expect(distillTakeoutActivity(JSON.stringify([activity, activity])).activities
      .map((row) => row.record_index)).toEqual([0, 1]);
  });

  test("accepts empty exports distinctly from parse failure", () => {
    expect(distillTakeoutActivity("[]").receipt.records).toBe(0);
    for (const source of ["", "{", "null", "{}", '[{"title":"private text"}]']) {
      expect(() => distillTakeoutActivity(source)).toThrow("Takeout activity");
      try { distillTakeoutActivity(source); } catch (error) {
        expect(String(error)).not.toContain("private text");
      }
    }
  });

  test("refuses oversized input, too many records, and malformed selected fields", () => {
    expect(() => distillTakeoutActivity(" ".repeat(1_048_577))).toThrow("byte limit");
    expect(() => distillTakeoutActivity(JSON.stringify(Array(10_001).fill(activity))))
      .toThrow("record limit");
    for (const row of [
      null, [], { ...activity, title: "" }, { ...activity, title: "x".repeat(8193) },
      { ...activity, time: "yesterday" }, { ...activity, time: "2026-02-30T00:00:00Z" },
      { ...activity, products: "Search" }, { ...activity, products: [null] },
      { ...activity, products: Array(33).fill("Search") },
    ]) {
      expect(() => distillTakeoutActivity(JSON.stringify([row]))).toThrow("Takeout activity");
    }
  });
});
