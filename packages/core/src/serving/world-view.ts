import { compareRfc3339 } from "../agents/time";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import { ServeError } from "./types";
import type { Envelope, ServeContext } from "./types";

const WIRE_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export class WorldViewError extends Error {
  override name = "WorldViewError";
  readonly code = "invalid_input" as const;

  constructor() {
    super("invalid world-view input");
  }
}

export type WorldObjectRef = {
  readonly kind: "object";
  readonly token: string;
};

export type WorldSnapshotRef = {
  readonly kind: "snapshot";
  readonly token: string;
};

export type WorldValidQuery =
  | { readonly kind: "all" }
  | { readonly kind: "at"; readonly at: string }
  | { readonly kind: "overlap"; readonly from: string; readonly until: string }
  | { readonly kind: "unknown_only" };

export type WorldKnownAt =
  | { readonly kind: "current" }
  | { readonly kind: "time"; readonly at: string }
  | { readonly kind: "snapshot"; readonly ref: WorldSnapshotRef };

export type WorldReadInput =
  | {
      readonly operation: "situation";
      readonly situation: WorldObjectRef;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
    }
  | {
      readonly operation: "concept";
      readonly concept: WorldObjectRef;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
    };

export type WorldReadResult = {
  readonly status: "not_found";
};

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isWorldWireToken(value: string): boolean {
  if (!WIRE_TOKEN.test(value)) return false;
  try {
    return Buffer.from(value, "base64url").byteLength === 32;
  } catch {
    return false;
  }
}

function parseRef(
  value: unknown,
  kind: "object" | "snapshot",
): WorldObjectRef | WorldSnapshotRef | null {
  if (!isPlainObject(value) || !exact(value, ["kind", "token"])) return null;
  if (value.kind !== kind || typeof value.token !== "string" || !isWorldWireToken(value.token)) {
    return null;
  }
  return { kind, token: value.token };
}

function parseValid(value: unknown): WorldValidQuery | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "all") return exact(value, ["kind"]) ? { kind: "all" } : null;
  if (value.kind === "unknown_only") {
    return exact(value, ["kind"]) ? { kind: "unknown_only" } : null;
  }
  if (value.kind === "at") {
    if (!exact(value, ["kind", "at"]) || !isRfc3339(value.at)) return null;
    return { kind: "at", at: value.at };
  }
  if (value.kind === "overlap") {
    if (!exact(value, ["kind", "from", "until"]) || !isRfc3339(value.from) || !isRfc3339(value.until)) {
      return null;
    }
    if (compareRfc3339(value.from, "from", value.until, "until") >= 0) return null;
    return { kind: "overlap", from: value.from, until: value.until };
  }
  return null;
}

function parseKnownAt(value: unknown): WorldKnownAt | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "current") return exact(value, ["kind"]) ? { kind: "current" } : null;
  if (value.kind === "time") {
    if (!exact(value, ["kind", "at"]) || !isRfc3339(value.at)) return null;
    return { kind: "time", at: value.at };
  }
  if (value.kind === "snapshot") {
    if (!exact(value, ["kind", "ref"])) return null;
    const ref = parseRef(value.ref, "snapshot");
    if (ref === null || ref.kind !== "snapshot") return null;
    return { kind: "snapshot", ref };
  }
  return null;
}

/**
 * Owner world lookup for the D22 concept and situation operations.
 * There is no world projection on this revision, so a valid exact lookup is
 * `not_found` for absent, erased, or inaccessible anchors. MCP and HTTP
 * `world_view` dispatch through `serveWorldView`.
 */
export function readWorldView(_ctx: ServeContext, input: unknown): WorldReadResult {
  if (!isPlainObject(input)) throw new WorldViewError();
  const operation = input.operation;
  if (operation !== "situation" && operation !== "concept") throw new WorldViewError();
  const expected =
    operation === "situation"
      ? (["operation", "situation", "valid", "knownAt"] as const)
      : (["operation", "concept", "valid", "knownAt"] as const);
  if (!exact(input, expected)) throw new WorldViewError();
  const anchor = parseRef(operation === "situation" ? input.situation : input.concept, "object");
  if (anchor === null || anchor.kind !== "object") throw new WorldViewError();
  if (parseValid(input.valid) === null || parseKnownAt(input.knownAt) === null) {
    throw new WorldViewError();
  }
  return { status: "not_found" };
}

export function serveWorldView(
  ctx: ServeContext,
  args: Record<string, unknown>,
): Envelope<WorldReadResult> {
  return gate(ctx, "world_view", auditArguments(args), ({ ctx: live }): Served<WorldReadResult> => {
    try {
      return {
        canon: [],
        quoted: [],
        withheld: [],
        data: readWorldView(live, args),
      };
    } catch (error) {
      if (error instanceof WorldViewError) {
        throw new ServeError("invalid_arguments", "invalid arguments: world_view");
      }
      throw error;
    }
  });
}
