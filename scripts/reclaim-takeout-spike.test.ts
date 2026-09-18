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

  test("rejects lossy UTF-8 input rather than minting a colliding receipt", () => {
    // Both lone surrogates encode as the same UTF-8 replacement character.
    const sources = ["\ud800", "\ud801"].map((value) =>
      JSON.stringify([activity]).replace("gardening", value));
    expect(Buffer.from(sources[0]!, "utf8")).toEqual(Buffer.from(sources[1]!, "utf8"));
    for (const source of sources) {
      expect(() => distillTakeoutActivity(source)).toThrow("Takeout activity must be lossless UTF-8");
    }
    const title = "Searched for gardening 🌱";
    expect(distillTakeoutActivity(JSON.stringify([{ ...activity, title }])).activities[0]?.title)
      .toBe(title);
  });

  test("requires decoded titles and products to survive UTF-8 encoding", () => {
    for (const row of [
      { ...activity, title: "Searched for \ud800" },
      { ...activity, products: ["Search \udc00"] },
    ]) {
      // JSON.stringify escapes these code units, so the source itself is valid UTF-8.
      const source = JSON.stringify([row]);
      expect(Buffer.from(source, "utf8").toString("utf8")).toBe(source);
      expect(() => distillTakeoutActivity(source)).toThrow("unsupported fields");
    }
    const row = { ...activity, title: "Garden 🌱", products: ["Search 🌱"] };
    expect(distillTakeoutActivity(JSON.stringify([row])).activities[0]).toMatchObject({
      title: row.title, products: row.products,
    });
  });

  test("accepts original UTF-8 bytes and hashes only the selected view", () => {
    const source = JSON.stringify([{ ...activity, title: "Gardening 🌱" }]);
    const bytes = Buffer.from(source);
    const padded = Buffer.concat([Buffer.from("prefix"), bytes, Buffer.from("suffix")]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 6, bytes.length);
    expect(distillTakeoutActivity(view)).toEqual(distillTakeoutActivity(source));
    expect(distillTakeoutActivity(bytes)).toEqual(distillTakeoutActivity(source));
    expect(() => distillTakeoutActivity(new Uint8Array(1_048_577))).toThrow("byte limit");
  });

  test("refuses malformed UTF-8 bytes before replacement can alter evidence", () => {
    for (const invalid of [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]]) {
      const source = Buffer.concat([
        Buffer.from('[{"title":"'), Buffer.from(invalid),
        Buffer.from('\",\"time\":\"2026-09-01T12:00:00Z\",\"products\":[\"Search\"]}]'),
      ]);
      expect(() => distillTakeoutActivity(source)).toThrow("Takeout activity must be lossless UTF-8");
    }
    expect(distillTakeoutActivity(Buffer.from(JSON.stringify([
      { ...activity, title: "Literal replacement character: �" },
    ]))).activities[0]?.title).toBe("Literal replacement character: �");
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
