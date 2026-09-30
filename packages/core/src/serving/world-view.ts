import { resolvePrincipal, toolAllowed } from "../agents";
import { tableExists } from "../ledger/schema";
import { WorldProjectionBudgetError } from "../world/projection";
import type { discoverWorld } from "../world/projection";
import type { WorldDescribe } from "../world/ops/describe";
import type { ConceptCard } from "../contracts/concept-card";
import type { SituationCard } from "../contracts/situation-card";
import { hasWorldKeys, parseWorldKnownAt, parseWorldRef, parseWorldValid } from "../world/ops/parse";
import { activeWorldOps, findWorldOp } from "../world/ops/registry";
import { WorldViewError, worldOpKeys } from "../world/ops/types";
import type {
  ViewToken,
  WorldKnownAt,
  WorldObjectRef,
  WorldOp,
  WorldOpOutcome,
  WorldOpRegistry,
  WorldSnapshotRef,
  WorldUnavailableReason,
  WorldValidQuery,
  WorldViewResult,
} from "../world/ops/types";
import {
  issueWorldRef,
  worldNamespace,
  type WireRef,
} from "../world/references";
import { openView, settleView } from "../world/views/session";
import type { ViewSession } from "../world/views/session";
import type { ShareData } from "../world/views/resume";
import { isPlainObject } from "../util/validate";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import type { RedactionCounts } from "./redact";
import { clampWorldData } from "./world-clamp";
import { ServeError } from "./types";
import type { ServeContext } from "./types";

export { WorldViewError } from "../world/ops/types";
export { isWorldWireToken } from "../world/ops/parse";
export type {
  ViewToken,
  WorldKnownAt,
  WorldObjectRef,
  WorldSnapshotRef,
  WorldValidQuery,
};

/** The typed request of the shipped operations; the reader itself takes `unknown` and the registry decides. */
export type WorldReadInput =
  | {
      readonly operation: "find_concepts" | "find_situations";
      readonly label: string;
      /** The `cursor` of the previous page; absent for the first page. */
      readonly cursor?: string;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
      /** The view a previous complete read issued, to be told whether anything visible moved. */
      readonly priorView?: ViewToken;
    }
  | {
      readonly operation: "situation";
      readonly situation: WorldObjectRef;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
      readonly priorView?: ViewToken;
    }
  | {
      readonly operation: "concept";
      readonly concept: WorldObjectRef;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
      readonly priorView?: ViewToken;
    }
  | { readonly operation: "describe" }
  | {
      readonly operation: "share";
      readonly of:
        | { readonly operation: "concept"; readonly concept: WorldObjectRef }
        | { readonly operation: "situation"; readonly situation: WorldObjectRef };
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
    }
  | {
      readonly operation: "resume";
      readonly handle: string;
      readonly valid: WorldValidQuery;
      readonly knownAt: WorldKnownAt;
      readonly priorView?: ViewToken;
    };

/** The bodies the shipped operations return; each operation's `dataSchemas` say which one it is. */
export type WorldData =
  | ConceptCard
  | SituationCard
  | ReturnType<typeof discoverWorld>
  | WorldDescribe
  | ShareData;
export type WorldReadResult =
  | { readonly status: "not_found" }
  | {
      readonly schema: "kizuki.world-view/v1";
      readonly operation: string;
      readonly result: WorldViewResult<WorldData>;
    };
/**
 * What a read that names no earlier read can answer. A baseline (`priorView`)
 * or a handle is the only way to be told `unchanged` or `new_view_required`, so
 * a caller that sends neither is never handed a result without a body.
 */
export type WorldFreshInput = {
  readonly operation: string;
  readonly priorView?: undefined;
  readonly handle?: undefined;
};
/** A record of unknown keys may carry a baseline at run time, so only an object of known keys is fresh. */
type KnownKeys<Input> = string extends keyof Input ? never : Input;
export type WorldFreshReadResult =
  | { readonly status: "not_found" }
  | {
      readonly schema: "kizuki.world-view/v1";
      readonly operation: string;
      readonly result: Exclude<WorldViewResult<WorldData>, { readonly status: "unchanged" | "new_view_required" }>;
    };
export type WorldViewEnvelope<Read extends WorldReadResult = WorldReadResult> = {
  readonly schema: "kizuki.envelope/v2";
  readonly tool: "world_view";
  readonly principal: WireRef<"principal">;
  readonly at: string;
  readonly canon: readonly [];
  readonly quoted: readonly [];
  /** Credential-shaped spans replaced in this response, per kind. Never the values. */
  readonly redacted?: RedactionCounts;
  readonly data: Read;
};

const MAX_RESPONSE_BYTES = 256 * 1024;
const ALL_VALID: WorldValidQuery = { kind: "all" };
const CURRENT: WorldKnownAt = { kind: "current" };

function answer(
  operation: string,
  result: WorldViewResult<WorldData>,
): WorldReadResult {
  return { schema: "kizuki.world-view/v1", operation, result };
}

function unavailable(
  operation: string,
  reason: WorldUnavailableReason,
): WorldReadResult {
  return answer(operation, { status: "unavailable", reason });
}

/**
 * Maps what an operation found to the result the reader serves; a body over the
 * response bound is never partly served. A read that may issue a view carries
 * its session, and a complete answer takes the state that session decides.
 */
function present(op: WorldOp, outcome: WorldOpOutcome, view: ViewSession | null, db: ServeContext["db"]): WorldReadResult {
  if (outcome.status === "not_found") return { status: "not_found" };
  if (outcome.status === "unavailable")
    return unavailable(op.name, outcome.reason);
  if (outcome.status === "new_view_required")
    return answer(op.name, { status: "new_view_required" });
  const { gaps } = outcome;
  if (Buffer.byteLength(JSON.stringify(outcome.data), "utf8") > MAX_RESPONSE_BYTES)
    throw new WorldProjectionBudgetError();
  // Every adapter states a grammar per declared schema; a body outside them is a defect, never served.
  if (!op.dataSchemas.includes(outcome.data.schema))
    throw new ServeError("error", "serving failed");
  // The registry is open and `WorldData` names the shipped bodies; the check above ties `data` to a declared schema.
  const data = outcome.data as WorldData;
  if (gaps !== null) return answer(op.name, { status: "incomplete", data, reasons: gaps });
  return answer(
    op.name,
    view === null ? { status: "current", view: { status: "not_issued" }, data } : settleView(db, view, op.name, data),
  );
}

/**
 * Fresh model-free projection through the registered operation the input
 * names. References carry lookup identity, never authority.
 */
export function readWorldView<Input extends WorldFreshInput>(ctx: ServeContext, input: KnownKeys<Input>, registry?: WorldOpRegistry): WorldFreshReadResult;
export function readWorldView(ctx: ServeContext, input: unknown, registry?: WorldOpRegistry): WorldReadResult;
export function readWorldView(
  ctx: ServeContext,
  input: unknown,
  registry: WorldOpRegistry = activeWorldOps(),
): WorldReadResult {
  const principal = resolvePrincipal(ctx.db, ctx.principal);
  if (principal === null)
    throw new ServeError("unknown_agent", "unknown agent");
  if (!toolAllowed(principal.grant, "world_view"))
    throw new ServeError("tool_not_granted", "tool not granted");
  ctx = { ...ctx, principal, sourcePurpose: "recall" };
  if (!isPlainObject(input)) throw new WorldViewError();
  const op = findWorldOp(registry, input.operation);
  if (op === undefined) throw new WorldViewError();
  const { required, optional } = worldOpKeys(op);
  if (!hasWorldKeys(input, required, optional)) throw new WorldViewError();
  try {
    if (op.source === "build") {
      const valid = Object.hasOwn(input, "valid") ? parseWorldValid(input.valid) : ALL_VALID,
        knownAt = Object.hasOwn(input, "knownAt") ? parseWorldKnownAt(input.knownAt) : CURRENT;
      if (valid === null || knownAt === null) throw new WorldViewError();
      if (knownAt.kind !== "current") return unavailable(op.name, "history");
      return present(op, op.run(registry), null, ctx.db);
    }
    const query = op.parse(input),
      valid = parseWorldValid(input.valid),
      knownAt = parseWorldKnownAt(input.knownAt),
      prior = op.views === true && Object.hasOwn(input, "priorView") ? parseWorldRef(input.priorView, "view") : null;
    if (query === null || valid === null || knownAt === null || (Object.hasOwn(input, "priorView") && prior === null))
      throw new WorldViewError();
    if (knownAt.kind !== "current") return unavailable(op.name, "history");
    if (!tableExists(ctx.db, "world_authorization_namespaces"))
      return unavailable(op.name, "storage");
    // A nested transaction is a savepoint: failed/budgeted projections issue no refs.
    return ctx.db
      .transaction(() => {
        // Admission can precede a grant amendment. Read authority and evidence
        // from the same snapshot, including discovery without an issued ref.
        const current = resolvePrincipal(ctx.db, ctx.principal);
        if (current === null) throw new ServeError("unknown_agent", "unknown agent");
        if (!toolAllowed(current.grant, "world_view")) throw new ServeError("tool_not_granted", "tool not granted");
        const live = { ...ctx, principal: current };
        const ns = worldNamespace(ctx.db, current);
        // The baseline is judged before any projection work, so an unusable one costs the same for every cause.
        const view = op.views === true ? openView(ctx.db, ns, input, prior) : null;
        if (view?.stale === true) return answer(op.name, { status: "new_view_required" });
        return present(op, op.run({ ctx: live, ns, registry }, query, { valid, knownAt }), view, ctx.db);
      })
      .immediate();
  } catch (error) {
    if (error instanceof WorldProjectionBudgetError)
      return unavailable(op.name, "budget");
    throw error;
  }
}

export function serveWorldView<Args extends WorldFreshInput>(
  ctx: ServeContext,
  args: KnownKeys<Args>,
  registry?: WorldOpRegistry,
): WorldViewEnvelope<WorldFreshReadResult>;
export function serveWorldView(
  ctx: ServeContext,
  args: Record<string, unknown>,
  registry?: WorldOpRegistry,
): WorldViewEnvelope;
export function serveWorldView(
  ctx: ServeContext,
  args: Record<string, unknown>,
  registry: WorldOpRegistry = activeWorldOps(),
): WorldViewEnvelope {
  // The gate is not wrapped in a transaction: a refusal rolls back everything
  // inside one, and the audit row and rate reservation of a denied call must
  // outlive the refusal. The projection opens its own transaction, so a failed
  // projection still issues no references.
  let wirePrincipal: WireRef<"principal"> | undefined;
  const envelope = gate(
    ctx,
    "world_view",
    auditArguments(args),
    ({ ctx: live }): Served<WorldReadResult> => {
      try {
        return ctx.db.transaction(() => {
          const data = readWorldView(live, args, registry);
          const principal = resolvePrincipal(ctx.db, live.principal);
          if (principal === null) throw new ServeError("unknown_agent", "unknown agent");
          const ns = worldNamespace(ctx.db, principal);
          wirePrincipal = issueWorldRef(ctx.db, ns, "principal", ns.principalId);
          return { canon: [], quoted: [], withheld: [], data };
        }).immediate();
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
  if (wirePrincipal === undefined) throw new ServeError("error", "serving failed");
  return {
    schema: "kizuki.envelope/v2", tool: "world_view", principal: wirePrincipal,
    at: envelope.at, canon: [], quoted: [],
    ...(envelope.redacted === undefined ? {} : { redacted: envelope.redacted }),
    data: clampWorldData(envelope.data!),
  };
}
