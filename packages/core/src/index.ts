export {
  EVENT_SCHEMA,
  SENSITIVITY_HINTS,
  SUBJECT_ROLES,
  raiseSensitivity,
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
  ENTITY_PAGE_TYPES,
  PAGE_CANDIDATE_KEY,
  PAGE_CANDIDATE_SCHEMA,
  targetProblem,
  validatePageCandidate,
} from "./contracts/page-candidate";
export type { PageCandidate as StagedPageCandidate } from "./contracts/page-candidate";

export {
  AUTHORITY_TIERS,
  CLAIM_KINDS,
  CLAIM_SCHEMA,
  CLAIM_STATUSES,
  PROPOSAL_KINDS,
  PROPOSAL_SCHEMA,
  PROPOSAL_STATUSES,
  canonicalizeProducer,
  isAuthorityTier,
  isClaimKind,
  isClaimStatus,
  isProducer,
  validateClaim,
  validateProposal,
} from "./contracts/proposal";
export type {
  AuthorityTier,
  CanonicalProducer,
  Claim,
  ClaimKind,
  ClaimPolarity,
  ClaimStatus,
  ClaimTaint,
  Producer,
  Proposal,
  ProposalKind,
  ProposalStatus,
} from "./contracts/proposal";

export {
  CLAIM_DEDUP_MIN,
  CLAIMS_SCHEMA_VERSION,
  CONFLICT_MARGIN,
  ClaimError,
  FIXTURE_EMBEDDING_SPACE,
  PREDICATE_REGISTRY,
  SINGLE_SOURCE_CAP,
  applyClaimsV3,
  authorityFor,
  claimKey,
  claimsConflict,
  getClaim,
  getPredicate,
  hashBody as hashClaimBody,
  initClaims,
  insertClaim,
  isRegisteredPredicate,
  isSingleValuedPredicate,
  listClaims,
  listSupersessions,
  markClaimReverted,
  markClaimsPurged,
  reinstateClaim,
  resupersedeClaim,
  supersessionsForReceipt,
  normalizeObject,
  predicateIds,
  resolveConflict,
  scoreClaimPair,
  validityOverlaps,
} from "./claims";
export type {
  AuthorityAssignment,
  AuthorityDraft,
  ClaimsIo,
  ConflictClaim,
  ConflictRule,
  DedupMode,
  EventFacts,
  InsertClaimInput,
  InsertClaimResult,
  PredicateCardinality,
  PredicateSpec,
  Resolution,
} from "./claims";

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

export {
  PORT_CONTRACTS,
  PORT_ERROR_CODES,
  PORT_KINDS,
  PortError,
  assertPortContract,
  isPortErrorCode,
  isPortKind,
  requirePortCapability,
  validatePortDescriptor,
} from "./contracts/ports";
export type {
  Port,
  PortContext,
  PortDescriptor,
  PortErrorCode,
  PortFactory,
  PortHealth,
  PortKind,
  PortLogLine,
} from "./contracts/ports";
export {
  PortRegistry,
  bindFromConfig,
  bindManyFromConfig,
  listPorts,
  registerPort,
  resolvePort,
} from "./contracts/registry";
export type {
  PortRegistration,
  PortSelection,
  PortsConfig,
} from "./contracts/registry";
export {
  MAX_RETRIEVAL_LIMIT,
  RETRIEVAL_CAPABILITIES,
  RETRIEVAL_CONTRACT,
  RETRIEVAL_CONTRACT_MINOR,
  RETRIEVAL_DOC_KINDS,
  requireRetrievalCapability,
  validateAbsenceProof,
  validateGraphResult,
  validateRetrievalDoc,
  validateRetrievalMutationReport,
  validateRetrievalQuery,
  validateRetrievalResult,
} from "./contracts/retrieval";
export type {
  AbsenceProof,
  EntityRef,
  GraphEdge as RetrievalGraphEdge,
  GraphQueryOptions,
  GraphResult,
  RetrievalAuthority,
  RetrievalCapability,
  RetrievalDoc,
  RetrievalDocKind,
  RetrievalHit,
  RetrievalMutationReport,
  RetrievalPort,
  RetrievalQuery,
  RetrievalResult,
  RetrievalScope,
} from "./contracts/retrieval";
export {
  FTS5_RETRIEVAL_DESCRIPTOR,
  FTS5_RETRIEVAL_ID,
  Fts5RetrievalPort,
  createFts5RetrievalPort,
  registerFts5RetrievalPort,
} from "./retrieval";
export {
  EMBEDDING_CAPABILITIES,
  EMBEDDING_CONTRACT,
  EMBEDDING_CONTRACT_MINOR,
} from "./contracts/embedding";
export type {
  Chunk,
  EmbeddingCapability,
  EmbeddingPort,
  EmbeddingSpace,
} from "./contracts/embedding";
export {
  LLM_CAPABILITIES,
  LLM_CONTRACT,
  LLM_CONTRACT_MINOR,
} from "./contracts/llm";
export type {
  LlmCapability,
  LlmMessage,
  LlmPort,
  LlmRequest,
  LlmResponse,
  LlmUsage,
} from "./contracts/llm";
export {
  PRODUCER_CAPABILITIES,
  PRODUCER_CONTRACT,
  PRODUCER_CONTRACT_MINOR,
  PRODUCER_REJECT_REASONS,
} from "./contracts/producer";
export type {
  ClaimDraft,
  ClaimDraftKind,
  ClaimSummary,
  ExtractResponse,
  ModelUsage,
  ProduceInput,
  ProduceResult,
  ProducerCapability,
  ProducerPort,
  QuotedEvent,
  RejectReason,
} from "./contracts/producer";
export {
  NOTIFIER_CAPABILITIES,
  NOTIFIER_CONTRACT,
  NOTIFIER_CONTRACT_MINOR,
} from "./contracts/notifier";
export type {
  Notification,
  NotificationReceipt,
  NotifierCapability,
  NotifierPort,
} from "./contracts/notifier";
export {
  CANON_STORE_CONTRACT,
  JOURNAL_STORE_CONTRACT,
  LEDGER_STORE_CONTRACT,
  STORAGE_CAPABILITIES,
  STORAGE_CONTRACT_MINOR,
} from "./contracts/storage";
export type {
  CanonStoreEntry,
  CanonStorePort,
  CanonStoreWrite,
  CanonStoreWriteResult,
  JournalRecord,
  JournalStorePort,
  LedgerAppendResult,
  LedgerStorePort,
  StorageCapability,
  StoragePort,
  StoreAbsenceProof,
  StoreMutationReport,
} from "./contracts/storage";
export {
  SURFACE_CAPABILITIES,
  SURFACE_CONTRACT,
  SURFACE_CONTRACT_MINOR,
} from "./contracts/surface";
export type {
  SurfaceCapability,
  SurfacePort,
  SurfacePrincipal,
  SurfaceRequest,
  SurfaceResponse,
} from "./contracts/surface";
export {
  RemotePortClient,
  connectRemotePort,
  createRemoteRetrievalPort,
  decodeRemoteValue,
  encodeRemoteValue,
  remoteDescribePath,
  remoteMethodPath,
  remoteMethodPrefix,
} from "./contracts/remote";
export type {
  RemoteEndpoint,
  RemotePortOptions,
} from "./contracts/remote";
export {
  CONFORMANCE_FAMILIES,
  conformanceContext,
  runContractConformance,
  runDrivenConformance,
  runEmbeddingConformance,
  runLlmConformance,
  runNotifierConformance,
  runProducerConformance,
  runRetrievalConformance,
  runStorageConformance,
  runSurfaceConformance,
} from "./contracts/conformance";
export type {
  ConformanceContext,
  ConformanceDeletionProof,
  ConformanceDriver,
  ConformanceFamily,
  ConformanceFamilyStatus,
  ConformanceFixtures,
  ConformanceHarness,
  ConformanceReport,
  ContractConformanceDefinition,
  DrivenConformanceHarness,
  EmbeddingConformanceHarness,
  LlmConformanceHarness,
  NotifierConformanceHarness,
  ProducerConformanceHarness,
  RetrievalConformanceFixtures,
  RetrievalConformanceHarness,
  StorageConformanceHarness,
  SurfaceConformanceHarness,
} from "./contracts/conformance";
export { KizukiError } from "./contracts/errors";
export type { KizukiErrorCode } from "./contracts/errors";

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
export type {
  PageSensitivity,
  PageStatus,
  PageTaint,
  PageType,
} from "./vault/schema";
export { WRITERS, isWriter } from "./vault/write";
export type { CanonWriteCapability, Writer } from "./vault/write";

export {
  BudgetExhausted,
  CANON_SCHEMA_VERSION,
  CANON_WRITE_BUDGETS,
  CanonWriteError,
  UndoError,
  PAGE_ACTIONS,
  RECEIPTS_PATH,
  RECEIPT_KINDS,
  applyCanonV4,
  applyCanonWrite,
  chooseCandidate,
  createBudgetTracker,
  getCanonReceipt,
  initCanon,
  latestReceiptForPage,
  laterReceiptsForPage,
  listAuditReceipts,
  listCanonReceipts,
  ownerEdited,
  pageRelPath,
  parseReceiptLine,
  readReceiptsLog,
  rebuildPageIndex,
  receiptsForClaim,
  resolveTarget,
  undoReceipt,
} from "./canon";
export type {
  ApplyCanonWriteOptions,
  AuditListOptions,
  AuditReceipt,
  BudgetLimits,
  BudgetTracker,
  BudgetUsage,
  CanonIo,
  CanonReceipt,
  CanonWriteBudget,
  CanonWriteErrorCode,
  EditReason,
  ListCanonReceiptsOptions,
  PageAction,
  PageCandidate,
  PageIndexEntry,
  ReceiptKind,
  RetrievalOpRef,
  TargetDecision,
  UndoErrorCode,
  UndoReceiptOptions,
} from "./canon";
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
export type { RunResult, RunToCompletionOptions } from "./ingest/run";
export {
  DEFAULT_MAX_BATCHES,
  runBackfill,
  runBatch,
  runSync,
  runToCompletion,
} from "./ingest/run";
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

export { diffLines } from "./util/diff";
export type { DiffLine } from "./util/diff";

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

export {
  CanonUnreadableError,
  ENTITY_TYPES,
  ENVELOPE_SCHEMA,
  ServeError,
  gate,
  serveContextPacket,
  serveCorrect,
  serveEntities,
  serveGetPage,
  serveGraph,
  serveHealth,
  servePropose,
  serveSearch,
  serveTimeline,
} from "./serving";
export type {
  CanonChunk,
  ContextPacketArgs,
  ContextPacketData,
  CorrectArgs,
  CorrectData,
  CorrectTarget,
  Denied,
  EntitiesArgs,
  Envelope,
  GetPageArgs,
  GraphArgs,
  GraphData,
  HealthData,
  ProposeArgs,
  ProposeData,
  QuotedChunk,
  RewrittenPage,
  SearchArgs,
  ServeContext,
  Served,
  TimelineArgs,
} from "./serving";
