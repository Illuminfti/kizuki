import type { Tool } from "../agents";
import { ENVELOPE_SCHEMA, ENVELOPE_V2_SCHEMA, ServeError } from "./types";
import type { ServeContext, ResponseContract } from "./types";
import { refuseCall } from "./gate";

/** The one key an adapter uses to choose the serving contract (RFC 0004, exact adapter selector). */
export const RESPONSE_CONTRACT_KEY = "response_contract";

export type { ResponseContract } from "./types";

/** Same words for every cause, so a refusal reveals nothing about vault state. */
export function unsupportedContract(): ServeError {
  return new ServeError(
    "unsupported_contract",
    "requested contract unavailable",
  );
}

/**
 * The contract a call is served under, or null when it cannot be served. A
 * selector rides beside the arguments and never inside them, so an argument
 * bag that carries the key is a nested or conflicting selector and is
 * refused. `system_health` has no v2 form, and `world_view` has no v1 form.
 */
export function chooseContract(
  tool: Tool,
  requested: unknown,
  args: object,
): ResponseContract | null {
  if (Object.hasOwn(args, RESPONSE_CONTRACT_KEY)) return null;
  const nested = Object.getOwnPropertyDescriptor(args, "args")?.value;
  if (nested !== null && typeof nested === "object" && Object.hasOwn(nested, RESPONSE_CONTRACT_KEY)) return null;
  const contract =
    requested === undefined
      ? tool === "world_view"
        ? ENVELOPE_V2_SCHEMA
        : ENVELOPE_SCHEMA
      : requested;
  if (contract !== ENVELOPE_SCHEMA && contract !== ENVELOPE_V2_SCHEMA)
    return null;
  if (tool === "system_health" && contract === ENVELOPE_V2_SCHEMA) return null;
  if (tool === "world_view" && contract === ENVELOPE_SCHEMA) return null;
  return contract;
}

/** Transport negotiation precedes the selected tool parser and uses Core's audited refusal. */
export function negotiateServeContract(ctx: ServeContext, tool: Tool, args: Record<string, unknown>, requested: unknown): ResponseContract {
  const contract = chooseContract(tool, requested, args);
  return contract ?? refuseCall(ctx, tool, args, unsupportedContract());
}
