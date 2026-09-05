import {
  sourceErasureReport,
  eraseSourcePayload,
  maintainSourceSqlite,
  type SourceErasureReport,
} from "./source-erasure";
import {
  bindSourceStoreId,
  sourceStoreStatuses,
  sourceStoresPending,
  eraseOwnedSourceStores,
  type OwnedSourceRetrievalInventory,
  type SourceStoreStatus,
} from "./source-stores";
import type { Database } from "bun:sqlite";
import type { CaptureEventInput, SensitivityHint } from "../contracts/event";
import { raiseSensitivity } from "../contracts/event";
import type { RetrievalPort } from "../contracts/retrieval";
import { sha256Hex } from "../util/hash";
import { isUlid, ulid } from "../util/ulid";
import { isRfc3339 } from "../util/time";
import { isPlainObject } from "../util/validate";
import { getConnectorSensitivity } from "../sensitivity/store";
import { getConnection } from "./connections";
import { tableExists } from "./schema";

export const SOURCE_PURPOSES = [
  "capture",
  "recall",
  "session",
  "correction",
  "audit",
  "derive",
  "extract",
  "export",
] as const;
export type SourcePurpose = (typeof SOURCE_PURPOSES)[number];
export const SOURCE_FIELDS = [
  "text",
  "subjects",
  "attachments",
  "metadata",
] as const;
export interface SourceGrantPolicy {
  purposes: SourcePurpose[];
  allowed_fields: (typeof SOURCE_FIELDS)[number][];
  retention: "persistent_owned_until_revoked";
  egress: "local_only";
  sensitivity_floor: SensitivityHint;
}
export interface SourceGrant {
  source_key: string;
  connector_id: string;
  revision: number;
  status: "active" | "denied" | "purged";
  policy: SourceGrantPolicy;
  policy_digest: string;
  updated_at: string;
  revoke_operation: string | null;
  purge_receipt_id: string | null;
  erasure: SourceErasureReport | null;
  retention_effects: {
    joint_derived_records: "whole_record_erasure";
    disposable_retrieval: "whole_generation_erasure";
  };
  owned_retrieval: SourceStoreStatus[];
  purge_blockers: (
    | "retrieval_pending"
    | "claim_payload_retained"
    | "identity_payload_retained"
    | "canon_rewrite_pending"
    | "owned_payload_maintenance_pending"
    | "owned_retrieval_pending"
    | "writer_busy"
  )[];
}
export interface SourceGrantRequest {
  source_key: string;
  expected_revision: number;
  operation_id: string;
}
export interface SourceGrantReceipt {
  operation_id: string;
  source_key: string;
  action: "grant" | "revoke" | "purge_complete";
  prior_revision: number;
  revision: number;
  status: SourceGrant["status"];
  at: string;
  policy_digest: string;
}
interface GrantRow extends Omit<
  SourceGrant,
  | "policy"
  | "purge_blockers"
  | "owned_retrieval"
  | "retention_effects"
  | "erasure"
> {
  policy: string;
}
export class SourceGrantError extends Error {
  override name = "SourceGrantError";
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new SourceGrantError(code);
}
function label(value: unknown): SensitivityHint {
  if (value !== "public" && value !== "personal" && value !== "private")
    fail("invalid_source_policy");
  return value;
}
function choices<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (
    !Array.isArray(value) ||
    value.length > allowed.length ||
    !value.every(
      (item) => typeof item === "string" && allowed.includes(item as T),
    )
  )
    fail("invalid_source_policy");
  if (new Set(value).size !== value.length) fail("invalid_source_policy");
  return [...value].sort() as T[];
}
function policyOf(value: unknown): SourceGrantPolicy {
  if (
    !isPlainObject(value) ||
    Object.keys(value).sort().join(",") !==
      "allowed_fields,egress,purposes,retention,sensitivity_floor"
  )
    fail("invalid_source_policy");
  if (value.retention !== "persistent_owned_until_revoked")
    fail("unsupported_retention");
  if (value.egress !== "local_only") fail("unsupported_egress");
  return {
    purposes: choices(value.purposes, SOURCE_PURPOSES),
    allowed_fields: choices(value.allowed_fields, SOURCE_FIELDS),
    retention: value.retention,
    egress: value.egress,
    sensitivity_floor: label(value.sensitivity_floor),
  };
}
function requestOf(request: SourceGrantRequest): void {
  if (
    !isUlid(request.source_key) ||
    !Number.isSafeInteger(request.expected_revision) ||
    request.expected_revision < 0 ||
    request.expected_revision > Number.MAX_SAFE_INTEGER - 2 ||
    typeof request.operation_id !== "string" ||
    request.operation_id.startsWith("complete:") ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request.operation_id)
  )
    fail("invalid_source_request");
}
export function sourcePolicyEpoch(db: Database): number {
  if (!tableExists(db, "source_grant_receipts")) return 0;
  return db
    .query<{ n: number }, []>(
      "SELECT coalesce(max(sequence),0) AS n FROM source_grant_receipts",
    )
    .get()!.n;
}
export function inspectSourceGrant(
  db: Database,
  sourceKey: string,
): SourceGrant | null {
  if (!tableExists(db, "source_grants")) return null;
  const row = db
    .query<GrantRow, [string]>("SELECT * FROM source_grants WHERE source_key=?")
    .get(sourceKey);
  if (row === null) return null;
  if (
    !isUlid(row.source_key) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !isRfc3339(row.updated_at)
  )
    fail("source_policy_corrupt");
  if (
    (row.status === "active" &&
      (row.revoke_operation !== null || row.purge_receipt_id !== null)) ||
    (row.status !== "active" &&
      (row.revoke_operation === null ||
        row.purge_receipt_id === null ||
        !isUlid(row.purge_receipt_id)))
  )
    fail("source_policy_corrupt");
  const policy = policyOf(JSON.parse(row.policy));
  if (
    sha256Hex(JSON.stringify(policy)) !== row.policy_digest ||
    !["active", "denied", "purged"].includes(row.status)
  )
    fail("source_policy_corrupt");
  return {
    ...row,
    policy,
    erasure: sourceErasureReport(db, row.source_key),
    retention_effects: {
      joint_derived_records: "whole_record_erasure",
      disposable_retrieval: "whole_generation_erasure",
    },
    owned_retrieval: sourceStoreStatuses(db, row.source_key),
    purge_blockers:
      row.status !== "active" ? sourcePurgeBlockers(db, row.source_key) : [],
  };
}
function replay(
  db: Database,
  operation: string,
  digest: string,
  expected: {
    action: "grant" | "revoke";
    source_key: string;
    prior_revision: number;
    policy_digest?: string;
  },
): SourceGrantReceipt | null {
  const row = db
    .query<{ request_digest: string; receipt: string }, [string]>(
      "SELECT request_digest,receipt FROM source_grant_receipts WHERE operation_id=?",
    )
    .get(operation);
  if (row === null) return null;
  if (row.request_digest !== digest) fail("operation_conflict");
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.receipt);
  } catch {
    fail("source_receipt_corrupt");
  }
  if (
    !isPlainObject(parsed) ||
    Object.keys(parsed).sort().join(",") !==
      "action,at,operation_id,policy_digest,prior_revision,revision,source_key,status" ||
    parsed.operation_id !== operation ||
    parsed.action !== expected.action ||
    parsed.source_key !== expected.source_key ||
    parsed.prior_revision !== expected.prior_revision ||
    parsed.revision !== expected.prior_revision + 1 ||
    parsed.status !== (expected.action === "grant" ? "active" : "denied") ||
    typeof parsed.at !== "string" ||
    !isRfc3339(parsed.at) ||
    typeof parsed.policy_digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(parsed.policy_digest) ||
    (expected.policy_digest !== undefined &&
      parsed.policy_digest !== expected.policy_digest)
  )
    fail("source_receipt_corrupt");
  return parsed as unknown as SourceGrantReceipt;
}
function record(
  db: Database,
  digest: string,
  receipt: SourceGrantReceipt,
): SourceGrantReceipt {
  db.query(
    "INSERT INTO source_grant_receipts(operation_id,request_digest,receipt) VALUES (?,?,?)",
  ).run(receipt.operation_id, digest, JSON.stringify(receipt));
  return receipt;
}
/** Owner-side trusted core administration, like enrollment; never an agent tool. */
export function setSourceGrant(
  db: Database,
  request: SourceGrantRequest & { policy: unknown },
): SourceGrantReceipt {
  requestOf(request);
  const policy = policyOf(request.policy);
  const digest = sha256Hex(
    JSON.stringify([
      "grant",
      request.source_key,
      request.expected_revision,
      policy,
    ]),
  );
  return db
    .transaction(() => {
      const prior = replay(db, request.operation_id, digest, {
        action: "grant",
        source_key: request.source_key,
        prior_revision: request.expected_revision,
        policy_digest: sha256Hex(JSON.stringify(policy)),
      });
      if (prior !== null) return prior;
      const connection = db
        .query<{ connector_id: string }, [string]>(
          "SELECT connector_id FROM connections WHERE source_key=?",
        )
        .get(request.source_key);
      if (
        connection === null ||
        getConnection(db, connection.connector_id, request.source_key) === null
      )
        fail("source_not_enrolled");
      const current = inspectSourceGrant(db, request.source_key);
      if ((current?.revision ?? 0) !== request.expected_revision)
        fail("source_revision_conflict");
      if (current?.status === "denied") fail("source_purge_pending");
      const at = new Date().toISOString();
      const revision = request.expected_revision + 1;
      const policyDigest = sha256Hex(JSON.stringify(policy));
      db.query(
        `INSERT INTO source_grants VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_key) DO UPDATE SET revision=excluded.revision,status=excluded.status,policy=excluded.policy,policy_digest=excluded.policy_digest,updated_at=excluded.updated_at,revoke_operation=NULL,purge_receipt_id=NULL`,
      ).run(
        request.source_key,
        connection.connector_id,
        revision,
        "active",
        JSON.stringify(policy),
        policyDigest,
        at,
        null,
        null,
      );
      return record(db, digest, {
        operation_id: request.operation_id,
        source_key: request.source_key,
        action: "grant",
        prior_revision: request.expected_revision,
        revision,
        status: "active",
        at,
        policy_digest: policyDigest,
      });
    })
    .immediate();
}
/** Commit denial independently of purge or canon lock acquisition. */
export function revokeSourceGrant(
  db: Database,
  request: SourceGrantRequest,
): SourceGrantReceipt {
  requestOf(request);
  const digest = sha256Hex(
    JSON.stringify(["revoke", request.source_key, request.expected_revision]),
  );
  return db
    .transaction(() => {
      const prior = replay(db, request.operation_id, digest, {
        action: "revoke",
        source_key: request.source_key,
        prior_revision: request.expected_revision,
      });
      if (prior !== null) return prior;
      const current = inspectSourceGrant(db, request.source_key);
      if (current === null || current.revision !== request.expected_revision)
        fail("source_revision_conflict");
      if (current.status !== "active") fail("source_not_active");
      const at = new Date().toISOString();
      const revision = current.revision + 1;
      db.query(
        "UPDATE source_grants SET status='denied',revision=?,updated_at=?,revoke_operation=?,purge_receipt_id=? WHERE source_key=?",
      ).run(revision, at, request.operation_id, ulid(), request.source_key);
      return record(db, digest, {
        operation_id: request.operation_id,
        source_key: request.source_key,
        action: "revoke",
        prior_revision: current.revision,
        revision,
        status: "denied",
        at,
        policy_digest: current.policy_digest,
      });
    })
    .immediate();
}
/** Retry native purge using the receipt ID reserved durably before the first attempt. */
export async function resumeSourceRevocation(
  db: Database,
  vaultPath: string,
  operationId: string,
  options: {
    retrieval?: RetrievalPort;
    ownedRetrieval?: OwnedSourceRetrievalInventory;
  } = {},
): Promise<SourceGrant> {
  if (options.retrieval !== undefined && !isLocalSourcePort(options.retrieval))
    fail("source_egress_denied");
  const row = db
    .query<{ source_key: string }, [string]>(
      "SELECT source_key FROM source_grants WHERE revoke_operation=?",
    )
    .get(operationId);
  if (row === null) fail("revocation_not_found");
  let grant = inspectSourceGrant(db, row.source_key)!;
  if (grant.status === "purged" && grant.purge_blockers.length === 0)
    return grant;
  if (
    (grant.status !== "denied" && grant.status !== "purged") ||
    grant.purge_receipt_id === null
  )
    fail("source_not_denied");
  const { runPurge, resumePurge, PurgeError, underPurgeFence } =
    await import("./purge");
  db.exec("PRAGMA secure_delete=ON");
  const receiptId = grant.purge_receipt_id;
  const exists =
    db.query("SELECT 1 FROM event_purges WHERE receipt_id=?").get(receiptId) !==
    null;
  try {
    if (!exists) {
      let first = true;
      await runPurge(
        db,
        vaultPath,
        { source_key: grant.source_key },
        "source authorization revoked",
        {
          ...options,
          allow_empty: true,
          ids: () => {
            if (first) {
              first = false;
              return receiptId;
            }
            return ulid();
          },
        },
      );
    }
    await underPurgeFence(vaultPath, options, async () => {
      eraseSourcePayload(db, vaultPath, grant.source_key);
      await eraseOwnedSourceStores(
        db,
        grant.source_key,
        options.ownedRetrieval,
      );
      maintainSourceSqlite(db, grant.source_key);
    });
    const verified = await resumePurge(db, vaultPath, receiptId, options);
    if (!verified.ok) return inspectSourceGrant(db, row.source_key)!;
  } catch (error) {
    if (error instanceof PurgeError && error.code === "canon_changed")
      return {
        ...inspectSourceGrant(db, row.source_key)!,
        purge_blockers: [
          ...inspectSourceGrant(db, row.source_key)!.purge_blockers,
          "writer_busy",
        ],
      };
    throw error;
  }
  return db
    .transaction(() => {
      grant = inspectSourceGrant(db, row.source_key)!;
      if (grant.status === "purged") return grant;
      const remaining = db
        .query(
          "SELECT 1 FROM events e JOIN source_event_bindings b ON b.event_id=e.event_id WHERE b.source_key=? LIMIT 1",
        )
        .get(grant.source_key);
      if (
        grant.status !== "denied" ||
        grant.revoke_operation !== operationId ||
        remaining !== null
      )
        fail("source_purge_pending");
      if (sourcePurgeBlockers(db, grant.source_key).length > 0) return grant;
      const at = new Date().toISOString();
      db.query(
        "UPDATE source_grants SET status='purged',revision=revision+1,updated_at=? WHERE source_key=?",
      ).run(at, grant.source_key);
      record(db, sha256Hex(JSON.stringify(["purge_complete", operationId])), {
        operation_id: `complete:${sha256Hex(operationId)}`,
        source_key: grant.source_key,
        action: "purge_complete",
        prior_revision: grant.revision,
        revision: grant.revision + 1,
        status: "purged",
        at,
        policy_digest: grant.policy_digest,
      });
      return inspectSourceGrant(db, grant.source_key)!;
    })
    .immediate();
}

export interface SourceAdmission {
  source_key: string;
  expected_revision: number;
}
export function authorizeSourceCapture(
  db: Database,
  event: CaptureEventInput,
  admission: SourceAdmission,
): CaptureEventInput {
  const grant = inspectSourceGrant(db, admission.source_key);
  if (
    grant === null ||
    grant.status !== "active" ||
    grant.revision !== admission.expected_revision ||
    grant.connector_id !== event.connector_id ||
    !grant.policy.purposes.includes("capture")
  )
    fail("source_capture_denied");
  const connection = getConnection(db, grant.connector_id, grant.source_key);
  if (connection === null || connection.disconnected_at !== null)
    fail("source_capture_denied");
  const populated = [
    event.text.length > 0 && "text",
    event.subjects.length > 0 && "subjects",
    event.attachments.length > 0 && "attachments",
    Object.keys(event.metadata).length > 0 && "metadata",
  ].filter(Boolean);
  if (
    populated.some(
      (field) =>
        !grant.policy.allowed_fields.includes(
          field as (typeof SOURCE_FIELDS)[number],
        ),
    )
  )
    fail("source_field_denied");
  return {
    ...event,
    sensitivity_hint: raiseSensitivity(
      raiseSensitivity(
        event.sensitivity_hint ?? "private",
        grant.policy.sensitivity_floor,
      ),
      getConnectorSensitivity(db, grant.connector_id, grant.source_key)
        ?.floor ?? "private",
    ),
  };
}
export function bindSourceEvent(
  db: Database,
  eventId: string,
  source: SourceAdmission,
  existing = false,
): void {
  const prior = db
    .query<{ source_key: string }, [string]>(
      "SELECT source_key FROM source_event_bindings WHERE event_id=?",
    )
    .get(eventId);
  if (prior !== null) {
    if (prior.source_key !== source.source_key) fail("source_binding_conflict");
    return;
  }
  if (existing) fail("source_binding_conflict");
  const grant = inspectSourceGrant(db, source.source_key)!;
  db.query("INSERT INTO source_event_bindings VALUES (?,?,?,?)").run(
    eventId,
    source.source_key,
    source.expected_revision,
    grant.policy_digest,
  );
}

const localPorts = new WeakSet<object>();
/** Trusted host composition capability, not an event/config assertion or agent API. */
export function bindLocalSourcePort<T extends object>(
  port: T,
  options?: { store_id: string },
): T {
  if (options !== undefined) bindSourceStoreId(port, options.store_id);
  localPorts.add(port);
  return port;
}
export function isLocalSourcePort(port: object | undefined): boolean {
  return port !== undefined && localPorts.has(port);
}
export interface SourceReadScope {
  owner: boolean;
  purpose?: SourcePurpose;
  port?: object;
  model?: boolean;
}
export function sourceEventsAllowed(
  db: Database,
  ids: readonly string[],
  scope: SourceReadScope,
): boolean {
  if (sourcePolicyEpoch(db) === 0) return true;
  if (scope.port !== undefined && !isLocalSourcePort(scope.port)) return false;
  for (const id of ids) {
    const row = db
      .query<
        {
          source_key: string | null;
          text: string;
          subjects: string;
          attachments: string;
          metadata: string;
        },
        [string]
      >(
        "SELECT e.text,e.subjects,e.attachments,e.metadata,b.source_key FROM events e LEFT JOIN source_event_bindings b ON b.event_id=e.event_id WHERE e.event_id=?",
      )
      .get(id);
    if (row === null) return false;
    if (row.source_key === null) {
      const native = db
        .query(
          "SELECT 1 FROM native_owner_evidence WHERE event_id=? AND origin='correction'",
        )
        .get(id);
      if (native !== null && !scope.model && scope.port === undefined) continue;
      if (!scope.owner || scope.model || scope.port !== undefined) return false;
      continue;
    }
    const grant = inspectSourceGrant(db, row.source_key);
    if (
      grant === null ||
      grant.status !== "active" ||
      !grant.policy.purposes.includes(scope.purpose ?? "recall")
    )
      return false;
    if (
      (row.text.length > 0 && !grant.policy.allowed_fields.includes("text")) ||
      (["subjects", "attachments", "metadata"] as const).some(
        (field) =>
          Object.keys(JSON.parse(row[field]) as object).length > 0 &&
          !grant.policy.allowed_fields.includes(field),
      )
    )
      return false;
  }
  return true;
}
export function requireSourceEvents(
  db: Database,
  ids: readonly string[],
  scope: SourceReadScope,
): void {
  if (!sourceEventsAllowed(db, ids, scope)) fail("source_access_denied");
}

/** Current source floor applies to old projections as well as newly captured rows. */
export function sourceSensitivity(
  db: Database,
  ids: readonly string[],
  current: SensitivityHint,
): SensitivityHint {
  let floor = current;
  if (sourcePolicyEpoch(db) === 0) return floor;
  for (const id of ids) {
    const row = db
      .query<{ source_key: string }, [string]>(
        "SELECT source_key FROM source_event_bindings WHERE event_id=?",
      )
      .get(id);
    if (row !== null)
      floor = raiseSensitivity(
        floor,
        inspectSourceGrant(db, row.source_key)?.policy.sensitivity_floor ??
          "private",
      );
  }
  return floor;
}

/** Native purge has not yet erased retained inference payload; never call that complete. */
function sourcePurgeBlockers(
  db: Database,
  sourceKey: string,
): SourceGrant["purge_blockers"] {
  const blockers: SourceGrant["purge_blockers"] = [];
  if (sourceStoresPending(db, sourceKey))
    blockers.push("owned_retrieval_pending");
  if (
    db
      .query("SELECT 1 FROM source_event_bindings WHERE source_key=? LIMIT 1")
      .get(sourceKey) !== null &&
    db
      .query(
        "SELECT 1 FROM source_store_inventory WHERE source_key=? AND payload_complete=1",
      )
      .get(sourceKey) === null
  )
    blockers.push("owned_payload_maintenance_pending");
  const sourceClaims =
    "SELECT c.claim_id FROM claims c JOIN json_each(c.provenance) p JOIN source_event_bindings b ON b.event_id=p.value WHERE b.source_key=?";
  if (
    db
      .query(
        `SELECT 1 FROM retrieval_ops WHERE state='pending' AND doc_id IN (${sourceClaims}) LIMIT 1`,
      )
      .get(sourceKey) !== null
  )
    blockers.push("retrieval_pending");
  if (
    db
      .query(
        `SELECT 1 FROM claims WHERE claim_id IN (${sourceClaims}) AND (length(body)>0 OR object IS NOT NULL OR target IS NOT NULL OR subject IS NOT NULL OR predicate IS NOT NULL OR model_ref IS NOT NULL OR subjects!='[]' OR frontmatter!='{}' OR producer NOT IN ('deterministic','model','llm','owner')) LIMIT 1`,
      )
      .get(sourceKey) !== null
  )
    blockers.push("claim_payload_retained");
  if (
    db
      .query(
        `SELECT 1 FROM identity_links l JOIN json_each(l.evidence) e
    WHERE replace(e.value,'event:','') IN (SELECT event_id FROM source_event_bindings WHERE source_key=?)
       OR replace(e.value,'claim:','') IN (${sourceClaims}) LIMIT 1`,
      )
      .get(sourceKey, sourceKey) !== null
  )
    blockers.push("identity_payload_retained");
  if (
    db
      .query(
        "SELECT 1 FROM canon_holds WHERE proposal_id=(SELECT purge_receipt_id FROM source_grants WHERE source_key=?) LIMIT 1",
      )
      .get(sourceKey) !== null
  )
    blockers.push("canon_rewrite_pending");
  return blockers;
}

/** Timeout poisons only this host-bound port instance; a fresh composition must requalify locality. */
export function invalidateLocalSourcePort(port: object): void {
  localPorts.delete(port);
}
