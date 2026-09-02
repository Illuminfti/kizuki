export {
  EVENT_SCHEMA,
  SENSITIVITY_HINTS,
  SUBJECT_ROLES,
  validateEventInput,
} from "./contracts/event";
export type {
  AttachmentRef,
  CaptureEvent,
  CaptureEventInput,
  SensitivityHint,
  SubjectRef,
  SubjectRole,
} from "./contracts/event";

export {
  PROPOSAL_KINDS,
  PROPOSAL_SCHEMA,
  PROPOSAL_STATUSES,
  isProducer,
  validateProposal,
} from "./contracts/proposal";
export type {
  Producer,
  Proposal,
  ProposalKind,
  ProposalStatus,
} from "./contracts/proposal";

export {
  AUTH_MODES,
  CONNECTOR_SCHEMA,
  HEALTH_STATES,
  HealthReport,
  isAuthMode,
  isHealthState,
} from "./contracts/connector";
export type {
  AuthMode,
  Connector,
  Cursor,
  HealthReportInit,
  HealthState,
  Manifest,
  ManifestCapabilities,
  PurgePlan,
  SecretResolver,
  SignInIo,
  SignInDisplay,
  ConnectionStateWriter,
  SyncBatch,
} from "./contracts/connector";

export { doctorVault } from "./vault/doctor";
export type { DoctorPageResult, DoctorVaultResult } from "./vault/doctor";
export { parseFrontmatter, serializePage } from "./vault/frontmatter";
export type { VaultPage } from "./vault/frontmatter";
export { initVault } from "./vault/init";
export type { InitVaultResult } from "./vault/init";
export {
  PAGE_SENSITIVITIES,
  PAGE_STATUSES,
  PAGE_TYPES,
  validatePage,
} from "./vault/schema";
export type { PageSensitivity, PageStatus, PageType } from "./vault/schema";
export { writePage } from "./vault/write";
export type { WritePageOptions } from "./vault/write";
export { findPageById, listCanonPages, listCanonPagesReport } from "./vault/pages";
export type { CanonPage, CanonPageReport, SkippedPage } from "./vault/pages";
export { readDerivedMeta } from "./derived-meta";
export type { DerivedLayer, DerivedMeta } from "./derived-meta";

export { canonicalSerialize, computeContentHash } from "./util/hash";
export { isRfc3339 } from "./util/time";
export { ulid } from "./util/ulid";
export { isNonEmptyString, isPlainObject } from "./util/validate";
export type { ValidationResult } from "./util/validate";

export { openLedger } from "./ledger/db";
export { readCheckpoint, writeCheckpoint } from "./ledger/checkpoints";
export { accept, count, readSince, replay } from "./ledger/ledger";
export type {
  AcceptDependencies,
  AcceptResult,
  LedgerCursor,
  ReplayFilter,
} from "./ledger/ledger";
export { isHeld, purgeEvents, readHolds } from "./ledger/purge";
export type {
  CanonHold,
  PurgeFilter,
  PurgeOutcome,
  PurgeReceipt,
} from "./ledger/purge";
export {
  LedgerError,
  disconnect,
  getCheckpoint,
  getConnection,
  listCheckpoints,
  listConnections,
  saveCheckpoint,
} from "./ledger/connections";
export type { Checkpoint, Connection, ConnectionConfig } from "./ledger/connections";
export {
  ConnectionStateStore,
  enrollConnection,
  CONNECTION_CONFIG_SCHEMA,
  MAX_CONNECTION_STATE_BYTES,
} from "./ledger/connection-state";
export type { ConnectionStateReader } from "./ledger/connection-state";
export { isSecretRef, parseSecretRef } from "./contracts/secret-ref";
export type { SecretRef, SecretRefScheme } from "./contracts/secret-ref";
export type { RunResult } from "./ingest/run";
export { runBackfill, runBatch, runSync } from "./ingest/run";
export { exportVault } from "./export";
export type { ExportManifest, ExportManifestEntry } from "./export";

export {
  indexEvent,
  indexPage,
  initSearch,
  rebuildSearch,
  removeDoc,
  search,
  toFtsQuery,
} from "./search";
export type {
  DocScope,
  SearchHit,
  SearchOptions,
  SearchRebuildResult,
} from "./search";

export { initGraph, neighbors, rebuildGraph } from "./graph";
export type {
  GraphEdge,
  GraphEdgeKind,
  GraphRebuildResult,
  NeighborOptions,
  NeighborResult,
} from "./graph";

export { timeline } from "./query";
export type { TimelineEntry, TimelineOptions } from "./query";

export { rebuildDerived } from "./derived";
export type { DerivedRebuildResult } from "./derived";

export {
  DEFAULT_GRANT,
  OWNER,
  SENSITIVITY_ORDER,
  TOOLS,
  addAgent,
  authenticate,
  authorize,
  checkRate,
  filterServable,
  getAgent,
  initAgents,
  listAudit,
  listAgents,
  recordAudit,
  revokeAgent,
  rotateToken,
  setGrant,
  shapeArguments,
  toolAllowed,
} from "./agents";
export type {
  Agent,
  AuditDenial,
  AuditItem,
  AuditRow,
  DenyReason,
  Grant,
  Principal,
  Sensitivity,
  Servable,
  Tool,
} from "./agents";
