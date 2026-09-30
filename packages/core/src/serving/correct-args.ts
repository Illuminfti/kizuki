import { CORRECTION_MODES, RECLASSIFIED_MODES, type ReclassifiedMode } from "../correction/types";
import { isPlainObject } from "../util/validate";
import { text } from "./arguments";
import { ServeError } from "./types";
import { isWorldWireToken } from "./world-view";

/** The object a typed correction asserts, as a caller names it: a node by the opaque token it holds. */
export type CorrectObject =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "vocabulary"; readonly id: string }
  | { readonly kind: "node"; readonly ref: { readonly kind: "object"; readonly token: string } };

/** The card to read again once the correction has committed: a concept or a situation, by the object token the caller holds. */
export interface CorrectRefresh {
  readonly operation: "concept" | "situation";
  readonly concept?: { readonly kind: "object"; readonly token: string };
  readonly situation?: { readonly kind: "object"; readonly token: string };
}

export const MAX_OBJECT_LITERAL_CHARS = 400;
const MAX_VOCABULARY_ID_CHARS = 128;
const MAX_LEGACY_OBJECT_CHARS = 1_024;

function refuse(field: string, rule: string): ServeError {
  return new ServeError("invalid_arguments", `invalid arguments: ${field}: ${rule}`);
}

function exactly(field: string, value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isPlainObject(value)) throw refuse(field, "must be an object");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
    throw refuse(field, `must hold exactly ${keys.join(", ")}`);
  }
  return value;
}

/** A replacement object. A bare string is the legacy spelling of a literal. */
export function parseObject(value: unknown): CorrectObject {
  if (typeof value === "string") {
    return { kind: "literal", value: text("object", value, MAX_LEGACY_OBJECT_CHARS) };
  }
  if (!isPlainObject(value)) throw refuse("object", "must be a string or an object");
  switch (value["kind"]) {
    case "literal": {
      const literal = exactly("object", value, ["kind", "value"]);
      return { kind: "literal", value: text("object.value", literal["value"], MAX_OBJECT_LITERAL_CHARS) };
    }
    case "vocabulary": {
      const vocabulary = exactly("object", value, ["kind", "id"]);
      return { kind: "vocabulary", id: text("object.id", vocabulary["id"], MAX_VOCABULARY_ID_CHARS) };
    }
    case "node": {
      const node = exactly("object", value, ["kind", "ref"]);
      const ref = exactly("object.ref", node["ref"], ["kind", "token"]);
      if (ref["kind"] !== "object" || typeof ref["token"] !== "string" || !isWorldWireToken(ref["token"])) {
        throw refuse("object.ref", "must be an object token");
      }
      return { kind: "node", ref: { kind: "object", token: ref["token"] } };
    }
    default:
      throw refuse("object", "kind must be literal, vocabulary or node");
  }
}

function parseRefresh(value: unknown): Readonly<Record<string, unknown>> {
  if (!isPlainObject(value)) throw refuse("refresh_world", "must be an object");
  const operation = value["operation"];
  if (operation !== "concept" && operation !== "situation") throw refuse("refresh_world", "operation must be concept or situation");
  const named = exactly("refresh_world", value, ["operation", operation]);
  const ref = exactly(`refresh_world.${operation}`, named[operation], ["kind", "token"]);
  if (ref["kind"] !== "object" || typeof ref["token"] !== "string" || !isWorldWireToken(ref["token"])) {
    throw refuse(`refresh_world.${operation}`, "must be an object token");
  }
  // The read is the one `world_view` takes, over everything currently known, so the two cannot drift apart.
  return { operation, [operation]: { kind: "object", token: ref["token"] }, valid: { kind: "all" }, knownAt: { kind: "current" } };
}

/** What a typed correction asks of its claim. A typed claim named with no mode replaces its object. */
export type CorrectionChange =
  | { readonly mode: "replace_object"; readonly object: CorrectObject | undefined }
  | { readonly mode: "retract" }
  | { readonly mode: "reclassify_mode"; readonly to: ReclassifiedMode };

export interface CorrectionIntent {
  readonly change: CorrectionChange;
  /** The complete `world_view` input to read after the commit. */
  readonly refresh: Readonly<Record<string, unknown>> | undefined;
}

/**
 * The parts of a correction that only a typed world claim understands, held to
 * their closed shapes. Which modes take which arguments is decided here, once,
 * so no adapter repeats it.
 */
export function parseIntent(args: {
  readonly mode?: unknown;
  readonly perspective_mode?: unknown;
  readonly object?: unknown;
  readonly refresh_world?: unknown;
}): CorrectionIntent {
  const mode = args.mode ?? "replace_object";
  if (!(CORRECTION_MODES as readonly unknown[]).includes(mode)) {
    throw refuse("mode", `must be one of ${CORRECTION_MODES.join(", ")}`);
  }
  const to = args.perspective_mode;
  if (mode !== "reclassify_mode" && to !== undefined) throw refuse("perspective_mode", "is only for mode reclassify_mode");
  if (mode !== "replace_object" && args.object !== undefined) throw refuse("object", "is only for mode replace_object");
  let change: CorrectionChange;
  if (mode === "retract") change = { mode };
  else if (mode === "reclassify_mode") {
    if (!(RECLASSIFIED_MODES as readonly unknown[]).includes(to)) {
      throw refuse("perspective_mode", `must be one of ${RECLASSIFIED_MODES.join(", ")}`);
    }
    change = { mode, to: to as ReclassifiedMode };
  } else change = { mode: "replace_object", object: args.object === undefined ? undefined : parseObject(args.object) };
  return { change, refresh: args.refresh_world === undefined ? undefined : parseRefresh(args.refresh_world) };
}
