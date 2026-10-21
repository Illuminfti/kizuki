import { expect, test } from "bun:test";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { compactToolSchema } from "../src/compact-schema";

test("compact listings preserve accepted and refused values", () => {
  const schema: Record<string, unknown> = z.toJSONSchema(z.strictObject({
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

test("object constraints still exclude null and arrays after compaction", () => {
  const provider = new AjvJsonSchemaValidator();
  for (const metadata of [{ type: "object", const: null }, { type: "object", enum: [{}, [], null] }]) {
    const schema: Record<string, unknown> = z.toJSONSchema(z.unknown().meta(metadata), { target: "draft-7" });
    const before = provider.getValidator(schema);
    const after = provider.getValidator(compactToolSchema(schema));
    for (const value of [null, [], {}]) expect(after(value).valid).toBe(before(value).valid);
    expect(after(null).valid).toBe(false);
    expect(after([]).valid).toBe(false);
  }
});

test("repeated typed reference definitions are shared without changing recursive validation or literal examples", () => {
  const ref = z.strictObject({ kind: z.enum(["page", "source", "claim"]), token: z.string().regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/) });
  const schema: Record<string, unknown> = z.toJSONSchema(z.strictObject({ first: ref, second: z.array(ref).max(4), third: z.union([ref, z.null()]) }), { target: "draft-7" });
  const compact = compactToolSchema(schema), provider = new AjvJsonSchemaValidator();
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(schema).length);
  expect(compact).toHaveProperty("definitions");
  const before = provider.getValidator(schema), after = provider.getValidator(compact);
  const valid = { kind: "page", token: "A".repeat(43) };
  for (const first of [valid, { ...valid, token: "invalid" }, { ...valid, extra: true }, { kind: "event", token: valid.token }, null])
    for (const third of [valid, null, {}, []]) {
      const input = { first, second: [valid], third };
      expect(after(input).valid).toBe(before(input).valid);
    }
});


test("output schema namespace compaction preserves the exact enum including newline refusal", () => {
  const values = ["concept-card", "situation-card", "procedure-card", "framework-card", "artifact-version", "observation", "prediction", "forecast-score"].map(name => `kizuki.${name}/v1`);
  const schema = { type: "string", enum: values };
  const compact = compactToolSchema(schema, { omitDefaults: true });
  expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(schema).length);
  expect(compactToolSchema(schema)).toEqual({ enum: values });
  const provider = new AjvJsonSchemaValidator(), before = provider.getValidator(schema), after = provider.getValidator(compact);
  for (const value of [...values, ...values.map(value => value + "\n"), ...values.map(value => value.replace("kizuki.", "kizukiX")), "kizuki.unknown/v1", {}, null, 1]) expect(after(value).valid).toBe(before(value).valid);
});


test("namespace factoring retains existing patterns and contradictory type constraints", () => {
  const values = Array.from({length: 8}, (_, i) => `kizuki.item-${i}/v1`), provider = new AjvJsonSchemaValidator();
  for (const constraint of [{type:"string",pattern:"item-0"}, {type:"object"}, {type:["string","null"]}]) {
    const schema = {...constraint, enum:values}, before=provider.getValidator(schema), after=provider.getValidator(compactToolSchema(schema,{omitDefaults:true}));
    for(const value of [...values, null, {}, 0]) expect(after(value).valid).toBe(before(value).valid);
  }
});
