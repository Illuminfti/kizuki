import type { ViewGap } from "../../contracts/concept-card";
import type { ServeContext } from "../../serving/types";
import type { WorldNamespace } from "../references";

/** Raised by any operation's parse or run; the gate audits it as invalid_arguments. */
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

/** RFC 0004 `ViewToken`: a random opaque wire value that carries no readable metadata. */
export type ViewToken = { readonly kind: "view"; readonly token: string };

/** The complete RFC 0004 result union. Declared here so later work extends the runtime one state at a time. */
export type ViewResult<T> =
  | {
      readonly status: "current";
      readonly view: ViewToken;
      readonly data: T;
      readonly validUntil: string;
    }
  | {
      readonly status: "current";
      readonly view: { readonly status: "not_issued" };
      readonly data: T;
    }
  | {
      readonly status: "unchanged";
      readonly view: ViewToken;
      readonly validUntil: string;
    }
  | {
      readonly status: "incomplete";
      readonly data: T;
      readonly reasons: readonly ViewGap[];
    }
  | { readonly status: "new_view_required" }
  | {
      readonly status: "unavailable";
      readonly reason: "model" | "storage" | "history" | "budget";
    }
  | { readonly status: "denied" };

/** The reasons an operation can report unavailable today. */
export type WorldUnavailableReason = "history" | "storage" | "budget";

/** Every result body names its schema; which schemas exist is the registry's business. */
export type WorldOpData = {
  readonly schema: string;
  readonly [key: string]: unknown;
};

/** The subset of `ViewResult` the reader produces: every state but `denied`, which a missing grant reports as a refusal. */
export type WorldViewResult<T = WorldOpData> = Exclude<ViewResult<T>,
  { readonly status: "denied" } | { readonly status: "unavailable" }
> | { readonly status: "unavailable"; readonly reason: WorldUnavailableReason };
// A runtime state that is not an RFC state fails to compile here.
export const worldViewResultIsViewResult = <T>(
  result: WorldViewResult<T>,
): ViewResult<T> => result;

export type WorldRecord = Readonly<Record<string, unknown>>;

/** Keys beyond `operation`, `valid` and `knownAt`, which the reader owns. */
export interface WorldOpKeys {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

/** What an operation that reads claims runs against: the live principal and its authorization namespace. */
export interface WorldFrame {
  readonly ctx: ServeContext;
  readonly ns: WorldNamespace;
  /** The operations the reader dispatches over; `share` and `resume` look their target up here. */
  readonly registry: WorldOpRegistry;
}

export interface WorldWhen {
  readonly valid: WorldValidQuery;
  readonly knownAt: WorldKnownAt;
}

export type WorldOpOutcome =
  | { readonly status: "not_found" }
  /** The read this one resumes is gone or was never readable: the caller must read afresh. */
  | { readonly status: "new_view_required" }
  | {
      readonly status: "data";
      readonly data: WorldOpData;
      /** Null when the answer is complete; otherwise why it is not. */
      readonly gaps: readonly ViewGap[] | null;
    }
  | {
      readonly status: "unavailable";
      readonly reason: WorldUnavailableReason;
    };

interface WorldOpBase {
  /** The `operation` value. */
  readonly name: string;
  /** Schema ids of the bodies `run` can return; every adapter states a grammar for each. */
  readonly dataSchemas: readonly [string, ...string[]];
}

/**
 * An operation that reads claims. The reader parses `valid` and `knownAt`,
 * refuses a time cutoff it cannot serve, opens the one immediate transaction
 * and issues the namespace; the operation adds only its own keys.
 */
export interface ClaimsOp<Query = unknown> extends WorldOpBase {
  readonly source: "claims";
  readonly keys: WorldOpKeys;
  /**
   * Set when a complete answer may be pinned as a view: the reader accepts the
   * optional key `priorView`, issues a token for a principal with a reserved
   * partition and answers `unchanged` when nothing visible moved.
   */
  readonly views?: true;
  /**
   * Set when the operation is a read of one object, which `share` can hand to
   * another principal. Reads the object a semantic handle names for the
   * frame's principal; `not_found` when that principal may read none of it,
   * whatever the reason.
   */
  readonly readObject?: (frame: WorldFrame, handle: string, when: WorldWhen) => WorldOpOutcome;
  /** Closed parse of the operation's own keys; null refuses the input. */
  parse(input: WorldRecord): Query | null;
  run(frame: WorldFrame, query: Query, when: WorldWhen): WorldOpOutcome;
}

/**
 * An operation derived from the build alone. Its own keys are none: it takes
 * `operation` and the optional common keys, touches no storage and cannot vary
 * with vault contents. A catalogue has no valid-time axis, so a well-formed
 * `valid` is accepted and changes nothing; a `knownAt` other than current is
 * `unavailable` with reason `history`, as for every other operation.
 */
export interface BuildOp extends WorldOpBase {
  readonly source: "build";
  run(registry: WorldOpRegistry): WorldOpOutcome;
}

export type WorldOp = ClaimsOp | BuildOp;
export type WorldOpRegistry = readonly WorldOp[];

/** The whole key contract of an operation as the reader enforces it, common keys included. */
export function worldOpKeys(op: WorldOp): WorldOpKeys {
  return op.source === "build"
    ? { required: ["operation"], optional: ["valid", "knownAt"] }
    : {
        required: ["operation", ...op.keys.required, "valid", "knownAt"],
        optional: op.views === true ? [...op.keys.optional, "priorView"] : op.keys.optional,
      };
}

/** Every key an operation accepts, `operation` first. */
export function worldOpInputKeys(op: WorldOp): readonly string[] {
  const { required, optional } = worldOpKeys(op);
  return [...required, ...optional];
}
