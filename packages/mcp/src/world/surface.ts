import { z } from "zod";
import { REDACTED } from "../redaction";
import type { McpWorldOp } from "./ops/types";
import { WORLD_KNOWN_AT, WORLD_VALID, worldGaps, worldRef, worldTextEvidence } from "./ops/shared";

const quotedEvidence = z.strictObject({
  evidence: worldTextEvidence, text: z.string().max(4000), tainted: z.literal(true),
  integrity: z.string().regex(/^[0-9a-f]{64}$/), slice_integrity: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.number().int().nonnegative(), returned: z.number().int().nonnegative().max(2000),
  total: z.number().int().nonnegative(), truncated: z.boolean(),
});

function names(values: readonly string[], what: string): [string, ...string[]] {
  const [first, ...rest] = values;
  if (first === undefined) throw new Error(`world_view has no ${what}`);
  return [first, ...rest];
}

/** The flat `world_view` input, the answer grammar and the tool description, all generated from the fragments. */
export function buildWorldSurface(ops: readonly McpWorldOp[]) {
  const operations = names(ops.map((op) => op.name), "operation");
  if (new Set(operations).size !== operations.length)
    throw new Error("world_view lists an operation twice");

  const fields: Record<string, z.ZodType> = {};
  for (const op of ops)
    for (const [key, schema] of Object.entries(op.fields)) {
      if (["operation", "valid", "knownAt"].includes(key) || (fields[key] !== undefined && fields[key] !== schema))
        throw new Error(`world_view field "${key}" is declared more than once`);
      if (!schema.safeParse(undefined).success)
        throw new Error(`world_view field "${key}" must be optional or defaulted: the engine, not the SDK, judges which fields an operation takes`);
      fields[key] = schema;
    }

  // One object, not a union of objects: the SDK advertises only an object shape,
  // and a union reaches `tools/list` as an empty schema a client cannot call.
  const input = z.strictObject({
    operation: z.enum(operations),
    ...fields,
    valid: WORLD_VALID.default({ kind: "all" }),
    knownAt: WORLD_KNOWN_AT.default({ kind: "current" }),
  });

  const bodies = ops.flatMap((op) =>
    Object.entries(op.data).map(([id, shape]) => z.strictObject({ schema: z.literal(id), ...shape })),
  );
  const schemaIds = names(ops.flatMap((op) => Object.keys(op.data)), "result schema");
  if (new Set(schemaIds).size !== schemaIds.length)
    throw new Error("two world_view operations claim one result schema");
  const [firstBody, ...otherBodies] = bodies;
  const data = z.discriminatedUnion("schema", [firstBody!, ...otherBodies]);

  const envelope = {
    schema: z.literal("kizuki.envelope/v2"),
    tool: z.literal("world_view"),
    principal: worldRef("principal"),
    at: z.string(),
    canon: z.array(z.never()).max(0),
    quoted: z.array(quotedEvidence).max(1),
    redacted: REDACTED.optional(),
    data: z.union([
      z.strictObject({ status: z.literal("not_found") }),
      z.strictObject({
        schema: z.literal("kizuki.world-view/v1"),
        operation: z.enum(operations),
        result: z.union([
          z.strictObject({ status: z.literal("current"), view: z.strictObject({ status: z.literal("not_issued") }), data }),
          z.strictObject({ status: z.literal("incomplete"), data, reasons: z.array(worldGaps).max(5) }),
          z.strictObject({ status: z.literal("unavailable"), reason: z.enum(["storage", "history", "budget"]) }),
        ]),
      }),
    ]),
  };

  // The card grammar is named by `schema` and left to its own contract, so
  // the listing stays small; the server holds every answer to `envelope`.
  const listed = {
    ...envelope,
    data: z.union([
      z.strictObject({ status: z.literal("not_found") }),
      z.strictObject({
        schema: z.literal("kizuki.world-view/v1"),
        operation: z.enum(operations),
        result: z.strictObject({
          status: z.enum(["current", "incomplete", "unavailable"]),
          view: z.strictObject({ status: z.literal("not_issued") }).optional(),
          data: z.looseObject({ schema: z.enum(schemaIds) }).optional(),
          reasons: z.array(worldGaps).max(5).optional(),
          reason: z.enum(["storage", "history", "budget"]).optional(),
        }),
      }),
    ]),
  };

  const description = [
    ...ops.map((op) => op.summary),
    'valid defaults to {kind:"all"} and knownAt to {kind:"current"} where an operation takes them.',
    "Valid lookups that are absent, erased, or inaccessible return not_found.",
  ].join(" ");

  // What the SDK fills in for an omitted field; the server withholds it from an operation that takes no such key.
  const defaults: Readonly<Record<string, unknown>> = input.parse({ operation: operations[0] });

  return { input, envelope, answer: z.strictObject(envelope), listed, description, defaults };
}
