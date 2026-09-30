import { expect, test } from "bun:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { compactToolSchema } from "../src/compact-schema";

test("compact listings preserve accepted and refused values", () => {
  const schema = z.toJSONSchema(z.strictObject({
    tag: z.literal("captured"),
    tainted: z.literal(true),
    sensitivity: z.enum(["public", "personal", "private"]),
    values: z.record(z.string(), z.unknown()),
    chunks: z.array(z.strictObject({ text: z.string().max(8) })).max(2),
    result: z.union([
      z.strictObject({ status: z.literal("current"), count: z.int().min(0) }),
      z.strictObject({ status: z.literal("unavailable") }),
    ]),
  }), { target: "draft-7" });
  const provider = new AjvJsonSchemaValidator();
  const before = provider.getValidator(schema);
  const after = provider.getValidator(compactToolSchema(schema));
  const valid = {
    tag: "captured", tainted: true, sensitivity: "public", values: { extra: null },
    chunks: [{ text: "example" }], result: { status: "current", count: 1 },
  };
  const cases: [unknown, boolean][] = [
    [valid, true],
    [{ ...valid, result: { status: "unavailable" } }, true],
    [{ ...valid, tainted: false }, false],
    [{ ...valid, sensitivity: "unknown" }, false],
    [{ ...valid, chunks: [{ text: "too much text" }] }, false],
    [{ ...valid, result: { status: "current", count: -1 } }, false],
    [{ ...valid, result: { status: "unavailable", count: 1 } }, false],
    [{ ...valid, extra: "unlisted" }, false],
    [{}, false], [null, false],
  ];
  for (const [value, accepted] of cases) {
    expect(before(value).valid).toBe(accepted);
    expect(after(value).valid).toBe(accepted);
  }
});

test("listing compaction preserves literal defaults and examples", () => {
  const example = { type: "string", const: "example", items: {}, required: [] };
  const schema = { type: "object", properties: { value: { default: example, examples: [example] } } };
  expect(compactToolSchema(schema)).toEqual(schema);
});
