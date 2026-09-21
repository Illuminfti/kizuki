import { resolvePrincipal, toolAllowed } from "../agents";
import type {
  ConceptCard,
  ConceptCoverage,
  ViewGap,
} from "../contracts/concept-card";
import type { SituationCard } from "../contracts/situation-card";
import { tableExists } from "../ledger/schema";
import {
  projectWorldCard,
  discoverWorld,
  WorldProjectionBudgetError,
} from "../world/projection";
import {
  issueWorldRef,
  resolveWorldObject,
  worldNamespace,
  type WireRef,
} from "../world/references";
import { compareRfc3339 } from "../agents/time";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import { ServeError } from "./types";
import type { ServeContext } from "./types";

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
      readonly operation: "find_concepts" | "find_situations";
      readonly label: string;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
    }
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

export type WorldData =
  | ConceptCard
  | SituationCard
  | ReturnType<typeof discoverWorld>;
export type WorldReadResult =
  | { readonly status: "not_found" }
  | {
      readonly schema: "kizuki.world-view/v1";
      readonly operation: WorldReadInput["operation"];
      readonly result:
        | {
            readonly status: "current";
            readonly view: { readonly status: "not_issued" };
            readonly data: WorldData;
          }
        | {
            readonly status: "incomplete";
            readonly data: WorldData;
            readonly reasons: readonly ViewGap[];
          }
        | {
            readonly status: "unavailable";
            readonly reason: "history" | "storage" | "budget";
          };
    };
export type WorldViewEnvelope = {
  readonly schema: "kizuki.envelope/v2";
  readonly tool: "world_view";
  readonly principal: WireRef<"principal">;
  readonly at: string;
  readonly canon: readonly [];
  readonly quoted: readonly [];
  readonly data: WorldReadResult;
};

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

export function isWorldWireToken(value: string): boolean {
  if (!WIRE_TOKEN.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength === 32 && bytes.toString("base64url") === value;
  } catch {
    return false;
  }
}

function parseRef(
  value: unknown,
  kind: "object" | "snapshot",
): WorldObjectRef | WorldSnapshotRef | null {
  if (!isPlainObject(value) || !exact(value, ["kind", "token"])) return null;
  if (
    value.kind !== kind ||
    typeof value.token !== "string" ||
    !isWorldWireToken(value.token)
  ) {
    return null;
  }
  return { kind, token: value.token };
}

function parseValid(value: unknown): WorldValidQuery | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "all")
    return exact(value, ["kind"]) ? { kind: "all" } : null;
  if (value.kind === "unknown_only") {
    return exact(value, ["kind"]) ? { kind: "unknown_only" } : null;
  }
  if (value.kind === "at") {
    if (!exact(value, ["kind", "at"]) || !isRfc3339(value.at)) return null;
    return { kind: "at", at: value.at };
  }
  if (value.kind === "overlap") {
    if (
      !exact(value, ["kind", "from", "until"]) ||
      !isRfc3339(value.from) ||
      !isRfc3339(value.until)
    ) {
      return null;
    }
    if (compareRfc3339(value.from, "from", value.until, "until") >= 0)
      return null;
    return { kind: "overlap", from: value.from, until: value.until };
  }
  return null;
}

function parseKnownAt(value: unknown): WorldKnownAt | null {
  if (!isPlainObject(value) || typeof value.kind !== "string") return null;
  if (value.kind === "current")
    return exact(value, ["kind"]) ? { kind: "current" } : null;
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

/** Fresh model-free projection. References carry lookup identity, never authority. */
export function readWorldView(
  ctx: ServeContext,
  input: unknown,
): WorldReadResult {
  const principal = resolvePrincipal(ctx.db, ctx.principal);
  if (principal === null)
    throw new ServeError("unknown_agent", "unknown agent");
  if (!toolAllowed(principal.grant, "world_view"))
    throw new ServeError("tool_not_granted", "tool not granted");
  ctx = { ...ctx, principal, sourcePurpose: "recall" };
  if (!isPlainObject(input)) throw new WorldViewError();
  const operation = input.operation;
  if (
    operation !== "situation" &&
    operation !== "concept" &&
    operation !== "find_concepts" &&
    operation !== "find_situations"
  )
    throw new WorldViewError();
  const discovery =
    operation === "find_concepts" || operation === "find_situations";
  const expected = discovery
    ? ["operation", "label", "valid", "knownAt"]
    : ["operation", operation, "valid", "knownAt"];
  if (!exact(input, expected)) throw new WorldViewError();
  const anchor = discovery ? null : parseRef(input[operation], "object");
  if (
    discovery
      ? typeof input.label !== "string" || input.label.length > 200
      : anchor === null
  )
    throw new WorldViewError();
  const valid = parseValid(input.valid),
    knownAt = parseKnownAt(input.knownAt);
  if (valid === null || knownAt === null) throw new WorldViewError();
  const unavailable = (
    reason: "history" | "storage" | "budget",
  ): WorldReadResult => ({
    schema: "kizuki.world-view/v1",
    operation,
    result: { status: "unavailable", reason },
  });
  if (knownAt.kind !== "current") return unavailable("history");
  if (!tableExists(ctx.db, "world_authorization_namespaces"))
    return unavailable("storage");
  const project = (): WorldReadResult => {
    const ns = worldNamespace(ctx.db, principal);
    const kind =
      operation === "concept" || operation === "find_concepts"
        ? "concept"
        : "situation";
    const handle =
      anchor === null ? null : resolveWorldObject(ctx.db, ns, anchor.token);
    if (!discovery && handle === null) return { status: "not_found" };
    const data = discovery
      ? discoverWorld(ctx, ns, kind, input.label as string, valid)
      : projectWorldCard(ctx, ns, handle!, kind, valid);
    if (data === null) return { status: "not_found" };
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > 256 * 1024)
      throw new WorldProjectionBudgetError();
    return {
      schema: "kizuki.world-view/v1",
      operation,
      result:
        data.coverage.status === "partial"
          ? { status: "incomplete", data, reasons: data.coverage.gaps }
          : { status: "current", view: { status: "not_issued" }, data },
    };
  };
  // A nested transaction is a savepoint: failed/budgeted projections issue no refs.
  try {
    return ctx.db.transaction(project).immediate();
  } catch (error) {
    if (error instanceof WorldProjectionBudgetError)
      return unavailable("budget");
    throw error;
  }
}

export function serveWorldView(
  ctx: ServeContext,
  args: Record<string, unknown>,
): WorldViewEnvelope {
  return ctx.db
    .transaction((): WorldViewEnvelope => {
      const envelope = gate(
        ctx,
        "world_view",
        auditArguments(args),
        ({ ctx: live }): Served<WorldReadResult> => {
          try {
            return {
              canon: [],
              quoted: [],
              withheld: [],
              data: readWorldView(live, args),
            };
          } catch (error) {
            if (error instanceof WorldViewError)
              throw new ServeError(
                "invalid_arguments",
                "invalid arguments: world_view",
              );
            throw error;
          }
        },
      );
      const principal = resolvePrincipal(ctx.db, ctx.principal);
      if (principal === null)
        throw new ServeError("unknown_agent", "unknown agent");
      const ns = worldNamespace(ctx.db, principal);
      return {
        schema: "kizuki.envelope/v2",
        tool: "world_view",
        principal: issueWorldRef(ctx.db, ns, "principal", ns.principalId),
        at: envelope.at,
        canon: [],
        quoted: [],
        data: envelope.data!,
      };
    })
    .immediate();
}
