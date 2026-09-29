import { resolvePrincipal, toolAllowed } from "../agents";
import { tableExists } from "../ledger/schema";
import { WorldProjectionBudgetError } from "../world/projection";
import type { discoverWorld } from "../world/projection";
import type { WorldDescribe } from "../world/ops/describe";
import type { ConceptCard } from "../contracts/concept-card";
import type { SituationCard } from "../contracts/situation-card";
import { hasWorldKeys, parseWorldKnownAt, parseWorldValid } from "../world/ops/parse";
import { activeWorldOps, findWorldOp } from "../world/ops/registry";
import { WorldViewError, worldOpKeys } from "../world/ops/types";
import type {
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
import { worldNamespace } from "../world/references";
import { isPlainObject } from "../util/validate";
import { auditArguments, gate } from "./gate";
import type { Served } from "./gate";
import { clampWorldData } from "./world-clamp";
import { ServeError } from "./types";
import type { EnvelopeV2, ServeContext } from "./types";
import { sealEnvelope } from "./v2/envelope";

export { WorldViewError } from "../world/ops/types";
export { isWorldWireToken } from "../world/ops/parse";
export type {
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
    }
  | { readonly operation: "describe" };

/** The bodies the shipped operations return; each operation's `dataSchemas` say which one it is. */
export type WorldData =
  | ConceptCard
  | SituationCard
  | ReturnType<typeof discoverWorld>
  | WorldDescribe;
export type WorldReadResult =
  | { readonly status: "not_found" }
  | {
      readonly schema: "kizuki.world-view/v1";
      readonly operation: string;
      readonly result: WorldViewResult<WorldData>;
    };
export type WorldViewEnvelope = EnvelopeV2<WorldReadResult, "world_view", readonly [], readonly []>;

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

/** Maps what an operation found to the result the reader serves; a body over the response bound is never partly served. */
function present(op: WorldOp, outcome: WorldOpOutcome): WorldReadResult {
  if (outcome.status === "not_found") return { status: "not_found" };
  if (outcome.status === "unavailable")
    return unavailable(op.name, outcome.reason);
  const { gaps } = outcome;
  if (Buffer.byteLength(JSON.stringify(outcome.data), "utf8") > MAX_RESPONSE_BYTES)
    throw new WorldProjectionBudgetError();
  // Every adapter states a grammar per declared schema; a body outside them is a defect, never served.
  if (!op.dataSchemas.includes(outcome.data.schema))
    throw new ServeError("error", "serving failed");
  // The registry is open and `WorldData` names the shipped bodies; the check above ties `data` to a declared schema.
  const data = outcome.data as WorldData;
  return answer(
    op.name,
    gaps === null
      ? { status: "current", view: { status: "not_issued" }, data }
      : { status: "incomplete", data, reasons: gaps },
  );
}

/**
 * Fresh model-free projection through the registered operation the input
 * names. References carry lookup identity, never authority.
 */
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
      return present(op, op.run(registry));
    }
    const query = op.parse(input),
      valid = parseWorldValid(input.valid),
      knownAt = parseWorldKnownAt(input.knownAt);
    if (query === null || valid === null || knownAt === null)
      throw new WorldViewError();
    if (knownAt.kind !== "current") return unavailable(op.name, "history");
    if (!tableExists(ctx.db, "world_authorization_namespaces"))
      return unavailable(op.name, "storage");
    // A nested transaction is a savepoint: failed/budgeted projections issue no refs.
    return ctx.db
      .transaction(() =>
        present(
          op,
          op.run({ ctx, ns: worldNamespace(ctx.db, principal) }, query, {
            valid,
            knownAt,
          }),
        ),
      )
      .immediate();
  } catch (error) {
    if (error instanceof WorldProjectionBudgetError)
      return unavailable(op.name, "budget");
    throw error;
  }
}

export function serveWorldView(
  ctx: ServeContext,
  args: Record<string, unknown>,
  registry: WorldOpRegistry = activeWorldOps(),
): WorldViewEnvelope {
  // The gate is not wrapped in a transaction: a refusal rolls back everything
  // inside one, and the audit row and rate reservation of a denied call must
  // outlive the refusal. The projection opens its own transaction, so a failed
  // projection still issues no references.
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
          data: readWorldView(live, args, registry),
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
  return sealEnvelope(ctx, "world_view", envelope.at, [] as const, [] as const, clampWorldData(envelope.data!));
}
