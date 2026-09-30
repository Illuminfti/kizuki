import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../util/hash";
import type { ViewToken, WorldOpData, WorldRecord, WorldViewResult } from "../ops/types";
import type { WorldNamespace } from "../references";
import { projectionBytes, wireRefs } from "./bytes";
import { viewPartitionOf } from "./partitions";
import { fingerprintOf, issueView, lookupView } from "./store";
import type { StoredView } from "./store";

/** What a view-issuing read carries from the moment it is admitted to the moment it answers. */
export interface ViewSession {
  readonly ns: WorldNamespace;
  /** Null when the principal holds no partition: the read is served with view `not_issued`. */
  readonly partition: number | null;
  /** Binds a token to the exact request it was issued for, `priorView` excluded. */
  readonly digest: string;
  /** The view the caller named as its baseline, if it named one. */
  readonly prior: ViewToken | null;
  readonly baseline: StoredView | null;
  /** A prior view was named and cannot be used, for any reason at all. */
  readonly stale: boolean;
  readonly now: string;
}

/** The digest of a request: every key it carries except the baseline it names. */
function requestDigest(input: WorldRecord): string {
  const { priorView: _named, ...rest } = input;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

/**
 * Admit a read that may issue a view. A prior view that is unknown, expired,
 * evicted, erased, another principal's, from another grant or for another
 * request is not looked into further: it is stale, and every cause is the same.
 */
export function openView(db: Database, ns: WorldNamespace, input: WorldRecord, prior: ViewToken | null): ViewSession {
  const now = new Date().toISOString();
  const partition = viewPartitionOf(db, ns.principalId);
  const digest = requestDigest(input);
  const baseline =
    prior === null || partition === null ? null : lookupView(db, partition, ns.id, digest, prior.token, now);
  return { ns, partition, digest, prior, baseline, stale: prior !== null && baseline === null, now };
}

function sameBytes(baseline: StoredView, bytes: Uint8Array): boolean {
  return baseline.fingerprint === fingerprintOf(bytes) && Buffer.compare(baseline.projection, bytes) === 0;
}

/** Only a failure of the store itself degrades a read to `not_issued`; anything else is a defect and surfaces. */
function isStoreFailure(error: unknown): boolean {
  return error instanceof Error && error.name === "SQLiteError";
}

/**
 * The state of a complete answer. `unchanged` needs the whole freshly built
 * projection to equal the retained baseline byte for byte; anything else is
 * `current`, with a new token when the principal has room and `not_issued`
 * when it does not or when the store cannot take one.
 */
export function settleView<T extends WorldOpData>(
  db: Database,
  session: ViewSession,
  operation: string,
  data: T,
): WorldViewResult<T> {
  const bytes = projectionBytes(operation, data);
  const { baseline, partition, prior } = session;
  if (baseline !== null && prior !== null && sameBytes(baseline, bytes)) {
    return { status: "unchanged", view: prior, validUntil: baseline.validUntil };
  }
  if (partition !== null) {
    try {
      // A nested transaction is a savepoint: a refused insert leaves no half-issued token.
      const issued = db.transaction(() =>
        issueView(db, partition, session.ns, session.digest, bytes, wireRefs(data), session.now),
      )();
      if (issued !== null)
        return { status: "current", view: { kind: "view", token: issued.token }, data, validUntil: issued.validUntil };
    } catch (error) {
      if (!isStoreFailure(error)) throw error;
    }
  }
  return { status: "current", view: { status: "not_issued" }, data };
}
