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
  CONNECTOR_SCHEMA,
  HEALTH_STATES,
  HealthReport,
  isHealthState,
} from "./contracts/connector";
export type {
  Connector,
  Cursor,
  HealthReportInit,
  HealthState,
  Manifest,
  ManifestCapabilities,
  PurgePlan,
  SecretResolver,
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

export { canonicalSerialize, computeContentHash } from "./util/hash";
export { isRfc3339 } from "./util/time";
export { ulid } from "./util/ulid";
export { isNonEmptyString, isPlainObject } from "./util/validate";
export type { ValidationResult } from "./util/validate";

export { openLedger } from "./ledger/db";
export { accept, count, readSince, replay } from "./ledger/ledger";
export type {
  AcceptDependencies,
  AcceptResult,
  LedgerCursor,
  ReplayFilter,
} from "./ledger/ledger";
export { purgeEvents } from "./ledger/purge";
export type { PurgeFilter, PurgeReceipt } from "./ledger/purge";

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
