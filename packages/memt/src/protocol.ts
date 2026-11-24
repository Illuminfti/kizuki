import { randomBytes } from "node:crypto";
import { isPlainObject } from "./db";

export const MEMT_PROTOCOL_VERSION = "memt-http-v1" as const;
export const MEMT_SNAPSHOT_FORMAT = "memt-memory-v1" as const;
export const MEMT_DEFAULT_CHUNK_TOKENS = 2048;
export const MEMT_LEASE_MIN_TTL_S = 1;
export const MEMT_LEASE_MAX_TTL_S = 3600;

export const MEMT_MODEL_FAMILIES = [
  "memt-nano",
  "memt-flash",
  "memt-pro",
] as const;
export type MemTModelFamily = (typeof MEMT_MODEL_FAMILIES)[number];

export const MEMT_COMMIT_CHUNK_POLICIES = [
  "atomic",
  "global",
  "tail",
] as const;
export type MemTCommitChunkPolicy = (typeof MEMT_COMMIT_CHUNK_POLICIES)[number];

export const MEMT_CONTROL_ACTIONS = [
  "create",
  "acquire",
  "renew",
  "release",
  "begin",
  "publish",
  "abort",
  "export",
  "import",
  "memory_read",
  "inspect",
  "close",
] as const;
export type MemTControlAction = (typeof MEMT_CONTROL_ACTIONS)[number];

export type MemTErrorStage =
  | "identity"
  | "capabilities"
  | "control"
  | "query"
  | "commit"
  | "begin"
  | "publish"
  | "abort"
  | "export"
  | "import"
  | "recover"
  | "transport";

export interface MemTClientErrorOptions {
  readonly status?: number;
  readonly code?: string;
  readonly uncertain?: boolean;
  readonly stage: MemTErrorStage;
  readonly transaction?: string;
  readonly answer?: string;
  readonly epoch?: string;
  readonly expectedEpoch?: string;
  readonly cause?: unknown;
}

export class MemTClientError extends Error {
  readonly status: number | undefined;
  readonly code: string;
  readonly uncertain: boolean;
  readonly stage: MemTErrorStage;
  readonly transaction: string | undefined;
  readonly answer: string | undefined;
  readonly epoch: string | undefined;
  readonly expectedEpoch: string | undefined;

  constructor(message: string, options: MemTClientErrorOptions) {
    super(
      message,
      options.cause !== undefined ? { cause: options.cause } : undefined,
    );
    this.name = "MemTClientError";
    this.status = options.status;
    this.code = options.code ?? "memt_error";
    this.uncertain = options.uncertain ?? false;
    this.stage = options.stage;
    this.transaction = options.transaction;
    this.answer = options.answer;
    this.epoch = options.epoch;
    this.expectedEpoch = options.expectedEpoch;
  }
}

export interface MemTIdentity {
  readonly model: MemTModelFamily;
  readonly config_sha256: string;
  readonly checkpoint_id: string;
  readonly sglang_version: string;
  readonly memt_runtime: Readonly<Record<string, unknown>>;
}

export interface MemTCapabilities {
  readonly protocol: typeof MEMT_PROTOCOL_VERSION;
  readonly epoch: string;
  readonly snapshot_format: typeof MEMT_SNAPSHOT_FORMAT;
  readonly chunk_tokens: number;
  readonly max_prefill_tokens: number;
  readonly commit_chunk_policy: MemTCommitChunkPolicy;
  readonly max_commit_tokens: number;
  readonly streaming: boolean;
  readonly retain_kv: boolean;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface MemTControlCreateRequest {
  readonly action: "create";
  readonly session?: string;
  readonly memory_read?: boolean;
  readonly source?: string;
  readonly source_lease?: string;
  readonly retain_kv?: boolean;
  readonly ttl?: number;
  readonly epoch?: string;
}

export interface MemTControlLeaseRequest {
  readonly action: "acquire" | "renew" | "release";
  readonly session: string;
  readonly lease?: string;
  readonly ttl?: number;
  readonly epoch?: string;
}

export interface MemTControlTransactionRequest {
  readonly action: "begin" | "publish" | "abort";
  readonly session: string;
  readonly lease: string;
  readonly transaction?: string;
  readonly epoch?: string;
}

export interface MemTControlSnapshotRequest {
  readonly action: "export" | "import";
  readonly session: string;
  readonly lease: string;
  readonly path?: string;
  readonly name?: string;
  readonly epoch?: string;
}

export interface MemTControlMemoryReadRequest {
  readonly action: "memory_read";
  readonly session: string;
  readonly lease?: string;
  readonly memory_read: boolean;
  readonly epoch?: string;
}

export interface MemTControlInspectRequest {
  readonly action: "inspect";
  readonly session: string;
  readonly lease?: string;
  readonly epoch?: string;
}

export interface MemTControlCloseRequest {
  readonly action: "close";
  readonly session: string;
  readonly lease?: string;
  readonly epoch?: string;
}

export type MemTControlRequest =
  | MemTControlCreateRequest
  | MemTControlLeaseRequest
  | MemTControlTransactionRequest
  | MemTControlSnapshotRequest
  | MemTControlMemoryReadRequest
  | MemTControlInspectRequest
  | MemTControlCloseRequest;

export type MemTTransactionState =
  | "open"
  | "committed"
  | "published"
  | "aborted"
  | "unknown";

export interface MemTTransactionReceipt {
  readonly transaction: string;
  readonly state: MemTTransactionState;
  readonly committed_tokens?: number;
  readonly committed_chunks?: number;
  readonly updated_at?: string;
}

export interface MemTSessionInspect {
  readonly session: string;
  readonly epoch: string;
  readonly memory_read: boolean;
  readonly retain_kv: boolean;
  readonly lease: string | null;
  readonly lease_expires_at: string | null;
  readonly active_transaction: string | null;
  readonly committed_tokens: number;
  readonly transactions: Readonly<Record<string, MemTTransactionReceipt>>;
  readonly last_transaction: MemTTransactionReceipt | null;
}

export interface MemTControlResponse {
  readonly ok: boolean;
  readonly action: MemTControlAction;
  readonly session?: string;
  readonly epoch?: string;
  readonly lease?: string;
  readonly lease_expires_at?: string;
  readonly transaction?: string;
  readonly memory_read?: boolean;
  readonly retain_kv?: boolean;
  readonly snapshot_path?: string;
  readonly snapshot_name?: string;
  readonly committed_tokens?: number;
  readonly state?: MemTSessionInspect;
  readonly receipt?: MemTTransactionReceipt;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface MemTSamplingParams {
  readonly max_new_tokens: number;
  readonly n: 1;
  readonly ignore_eos: false;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly stop?: readonly string[];
}

export interface MemTGenerateRequest {
  readonly rid: string;
  readonly text?: string;
  readonly input_ids?: readonly number[];
  readonly memt_epoch: string;
  readonly memt_lease?: string;
  readonly memt_transaction?: string;
  readonly sampling_params: MemTSamplingParams;
  readonly stream?: false;
}

export interface MemTGenerateResponse {
  readonly text: string;
  readonly rid?: string;
  readonly memt_epoch?: string;
  readonly meta_info?: Readonly<Record<string, unknown>>;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ParsedMemTRid {
  readonly session: string;
  readonly mode: "query" | "commit";
  readonly tokenCount?: number;
  readonly nonce: string;
}

const RID_TOKEN_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;

function assertRidSegment(
  value: string,
  label: string,
  stage: MemTErrorStage,
): void {
  if (!RID_TOKEN_PATTERN.test(value) || value.includes("|")) {
    throw new MemTClientError(
      `Invalid MemT ${label} for RID construction: must be non-empty without '|' or whitespace`,
      { code: "invalid_rid_segment", stage },
    );
  }
}

export function generateMemTNonce(): string {
  return randomBytes(8).toString("hex");
}

export function buildQueryRid(
  session: string,
  nonce: string = generateMemTNonce(),
): string {
  assertRidSegment(session, "session", "query");
  assertRidSegment(nonce, "nonce", "query");
  return `memt|${session}|query|${nonce}`;
}

export function buildCommitRid(
  session: string,
  tokenCount: number,
  nonce: string = generateMemTNonce(),
): string {
  assertRidSegment(session, "session", "commit");
  assertRidSegment(nonce, "nonce", "commit");
  if (!Number.isSafeInteger(tokenCount) || tokenCount <= 0) {
    throw new MemTClientError(
      `Invalid MemT commit token_count (${String(tokenCount)}): must be a positive integer`,
      { code: "invalid_commit_tokens", stage: "commit" },
    );
  }
  return `memt|${session}|commit:${tokenCount}|${nonce}`;
}

export function parseMemTRid(rid: string): ParsedMemTRid | null {
  const parts = rid.split("|");
  if (parts.length !== 4 || parts[0] !== "memt") return null;
  const session = parts[1];
  const op = parts[2];
  const nonce = parts[3];
  if (
    session === undefined ||
    op === undefined ||
    nonce === undefined ||
    !RID_TOKEN_PATTERN.test(session) ||
    !RID_TOKEN_PATTERN.test(nonce)
  ) {
    return null;
  }
  if (op === "query") {
    return { session, mode: "query", nonce };
  }
  if (op.startsWith("commit:")) {
    const rawCount = op.slice("commit:".length);
    if (!/^[1-9][0-9]*$/.test(rawCount)) return null;
    const tokenCount = Number(rawCount);
    if (!Number.isSafeInteger(tokenCount) || tokenCount <= 0) return null;
    return { session, mode: "commit", tokenCount, nonce };
  }
  return null;
}

export function validateLeaseTtl(
  ttl: number,
  stage: MemTErrorStage = "control",
): number {
  if (
    typeof ttl !== "number" ||
    !Number.isSafeInteger(ttl) ||
    ttl < MEMT_LEASE_MIN_TTL_S ||
    ttl > MEMT_LEASE_MAX_TTL_S
  ) {
    throw new MemTClientError(
      `Lease TTL must be an integer between ${MEMT_LEASE_MIN_TTL_S} and ${MEMT_LEASE_MAX_TTL_S} seconds`,
      { code: "invalid_lease_ttl", stage },
    );
  }
  return ttl;
}

export function normalizeMemTModel(raw: unknown): MemTModelFamily | null {
  if (typeof raw !== "string") return null;
  const lower = raw.trim().toLowerCase();
  if (
    lower === "memt-nano" ||
    lower.includes("memt-1.0-nano") ||
    lower.endsWith("/memt-nano")
  ) {
    return "memt-nano";
  }
  if (
    lower === "memt-flash" ||
    lower.includes("memt-1.0-flash") ||
    lower.endsWith("/memt-flash")
  ) {
    return "memt-flash";
  }
  if (
    lower === "memt-pro" ||
    lower.includes("memt-1.0-pro") ||
    lower.endsWith("/memt-pro")
  ) {
    return "memt-pro";
  }
  return null;
}

function readNonEmptyString(
  obj: Record<string, unknown>,
  key: string,
  stage: MemTErrorStage,
): string {
  const value = obj[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MemTClientError(`Missing or invalid '${key}' in MemT response`, {
      code: "protocol_error",
      stage,
    });
  }
  return value.trim();
}

function readEpochString(
  value: unknown,
  stage: MemTErrorStage,
  required: boolean,
): string | undefined {
  if (value === undefined || value === null) {
    if (required) {
      throw new MemTClientError("Missing 'epoch' in MemT response", {
        code: "protocol_error",
        stage,
      });
    }
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  throw new MemTClientError("Invalid 'epoch' in MemT response", {
    code: "protocol_error",
    stage,
  });
}

function readPositiveInt(
  obj: Record<string, unknown>,
  key: string,
  stage: MemTErrorStage,
  fallback?: number,
): number {
  const value = obj[key];
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new MemTClientError(
      `Invalid positive integer '${key}' in MemT response`,
      { code: "protocol_error", stage },
    );
  }
  return value;
}

export function parseMemTIdentity(raw: unknown): MemTIdentity {
  if (!isPlainObject(raw)) {
    throw new MemTClientError("GET /memt/identity returned non-object JSON", {
      code: "protocol_error",
      stage: "identity",
    });
  }
  const model = normalizeMemTModel(raw["model"]);
  if (model === null) {
    throw new MemTClientError(
      `Unsupported MemT model identity '${String(raw["model"])}' (expected memt-nano | memt-flash | memt-pro)`,
      { code: "protocol_error", stage: "identity" },
    );
  }
  const config_sha256 = readNonEmptyString(raw, "config_sha256", "identity");
  const checkpoint_id = readNonEmptyString(raw, "checkpoint_id", "identity");
  const sglang_version = readNonEmptyString(raw, "sglang_version", "identity");
  const runtimeRaw = raw["memt_runtime"];
  if (!isPlainObject(runtimeRaw)) {
    throw new MemTClientError(
      "Missing or invalid 'memt_runtime' in /memt/identity",
      { code: "protocol_error", stage: "identity" },
    );
  }
  return Object.freeze({
    model,
    config_sha256,
    checkpoint_id,
    sglang_version,
    memt_runtime: Object.freeze({ ...runtimeRaw }),
  });
}

export function parseMemTCapabilities(raw: unknown): MemTCapabilities {
  if (!isPlainObject(raw)) {
    throw new MemTClientError(
      "GET /memt/capabilities returned non-object JSON",
      { code: "protocol_error", stage: "capabilities" },
    );
  }
  const protocol = raw["protocol"];
  if (protocol !== MEMT_PROTOCOL_VERSION) {
    throw new MemTClientError(
      `Unsupported MemT protocol '${String(protocol)}' (expected '${MEMT_PROTOCOL_VERSION}')`,
      { code: "protocol_mismatch", stage: "capabilities" },
    );
  }
  const epoch = readEpochString(raw["epoch"], "capabilities", true)!;
  const snapshotFormat = raw["snapshot_format"];
  if (snapshotFormat !== MEMT_SNAPSHOT_FORMAT) {
    throw new MemTClientError(
      `Unsupported MemT snapshot format '${String(snapshotFormat)}' (expected '${MEMT_SNAPSHOT_FORMAT}')`,
      { code: "protocol_mismatch", stage: "capabilities" },
    );
  }
  const chunk_tokens = readPositiveInt(
    raw,
    "chunk_tokens",
    "capabilities",
    MEMT_DEFAULT_CHUNK_TOKENS,
  );
  const max_prefill_tokens = readPositiveInt(
    raw,
    "max_prefill_tokens",
    "capabilities",
  );
  const policy = raw["commit_chunk_policy"];
  if (
    typeof policy !== "string" ||
    !(MEMT_COMMIT_CHUNK_POLICIES as readonly string[]).includes(policy)
  ) {
    throw new MemTClientError(
      `Unsupported commit_chunk_policy '${String(policy)}'`,
      { code: "protocol_error", stage: "capabilities" },
    );
  }
  const max_commit_tokens = readPositiveInt(
    raw,
    "max_commit_tokens",
    "capabilities",
  );
  const streamingRaw = raw["streaming"] ?? raw["supports_streaming"] ?? false;
  const retainKvRaw = raw["retain_kv"] ?? raw["supports_retain_kv"] ?? false;
  if (typeof streamingRaw !== "boolean" || typeof retainKvRaw !== "boolean") {
    throw new MemTClientError(
      "Invalid boolean capability flags in /memt/capabilities",
      { code: "protocol_error", stage: "capabilities" },
    );
  }
  return Object.freeze({
    protocol: MEMT_PROTOCOL_VERSION,
    epoch,
    snapshot_format: MEMT_SNAPSHOT_FORMAT,
    chunk_tokens,
    max_prefill_tokens,
    commit_chunk_policy: policy as MemTCommitChunkPolicy,
    max_commit_tokens,
    streaming: streamingRaw,
    retain_kv: retainKvRaw,
    raw: Object.freeze({ ...raw }),
  });
}

function parseTransactionReceipt(raw: unknown): MemTTransactionReceipt | null {
  if (!isPlainObject(raw)) return null;
  const tx = raw["transaction"];
  const state = raw["state"];
  if (typeof tx !== "string" || tx.length === 0) return null;
  const normalizedState: MemTTransactionState =
    state === "open" ||
    state === "committed" ||
    state === "published" ||
    state === "aborted"
      ? state
      : "unknown";
  return Object.freeze({
    transaction: tx,
    state: normalizedState,
    ...(typeof raw["committed_tokens"] === "number"
      ? { committed_tokens: raw["committed_tokens"] }
      : {}),
    ...(typeof raw["committed_chunks"] === "number"
      ? { committed_chunks: raw["committed_chunks"] }
      : {}),
    ...(typeof raw["updated_at"] === "string"
      ? { updated_at: raw["updated_at"] }
      : {}),
  });
}

function parseSessionInspect(
  raw: Record<string, unknown>,
  fallbackSession: string | undefined,
  fallbackEpoch: string | undefined,
): MemTSessionInspect {
  const session =
    typeof raw["session"] === "string" && raw["session"].length > 0
      ? raw["session"]
      : (fallbackSession ?? "");
  const epoch =
    readEpochString(raw["epoch"], "control", false) ?? fallbackEpoch ?? "";
  const transactions: Record<string, MemTTransactionReceipt> = {};
  if (isPlainObject(raw["transactions"])) {
    for (const [key, entry] of Object.entries(raw["transactions"])) {
      const parsed = parseTransactionReceipt(
        isPlainObject(entry) ? { transaction: key, ...entry } : entry,
      );
      if (parsed !== null) {
        transactions[parsed.transaction] = parsed;
      }
    }
  } else if (Array.isArray(raw["transactions"])) {
    for (const entry of raw["transactions"]) {
      const parsed = parseTransactionReceipt(entry);
      if (parsed !== null) {
        transactions[parsed.transaction] = parsed;
      }
    }
  }
  const lastTx = parseTransactionReceipt(raw["last_transaction"]);
  if (lastTx !== null && transactions[lastTx.transaction] === undefined) {
    transactions[lastTx.transaction] = lastTx;
  }
  return Object.freeze({
    session,
    epoch,
    memory_read: Boolean(raw["memory_read"]),
    retain_kv: Boolean(raw["retain_kv"]),
    lease: typeof raw["lease"] === "string" ? raw["lease"] : null,
    lease_expires_at:
      typeof raw["lease_expires_at"] === "string"
        ? raw["lease_expires_at"]
        : null,
    active_transaction:
      typeof raw["active_transaction"] === "string"
        ? raw["active_transaction"]
        : null,
    committed_tokens:
      typeof raw["committed_tokens"] === "number" &&
      Number.isFinite(raw["committed_tokens"])
        ? raw["committed_tokens"]
        : 0,
    transactions: Object.freeze(transactions),
    last_transaction: lastTx,
  });
}

export function parseMemTControlResponse(
  action: MemTControlAction,
  raw: unknown,
  fallbackSession?: string,
): MemTControlResponse {
  if (!isPlainObject(raw)) {
    throw new MemTClientError(
      `POST /memt/control (${action}) returned non-object JSON`,
      { code: "protocol_error", stage: "control" },
    );
  }
  const ok = raw["ok"] === undefined ? true : Boolean(raw["ok"]);
  const epoch = readEpochString(raw["epoch"], "control", false);
  const session =
    typeof raw["session"] === "string" && raw["session"].length > 0
      ? raw["session"]
      : fallbackSession;
  const lease = typeof raw["lease"] === "string" ? raw["lease"] : undefined;
  const leaseExpiresAt =
    typeof raw["lease_expires_at"] === "string"
      ? raw["lease_expires_at"]
      : undefined;
  const transaction =
    typeof raw["transaction"] === "string" ? raw["transaction"] : undefined;
  const memoryRead =
    typeof raw["memory_read"] === "boolean" ? raw["memory_read"] : undefined;
  const retainKv =
    typeof raw["retain_kv"] === "boolean" ? raw["retain_kv"] : undefined;
  const snapshotPath =
    typeof raw["snapshot_path"] === "string"
      ? raw["snapshot_path"]
      : typeof raw["path"] === "string"
        ? raw["path"]
        : undefined;
  const snapshotName =
    typeof raw["snapshot_name"] === "string"
      ? raw["snapshot_name"]
      : typeof raw["name"] === "string"
        ? raw["name"]
        : undefined;
  const committedTokens =
    typeof raw["committed_tokens"] === "number" &&
    Number.isFinite(raw["committed_tokens"])
      ? raw["committed_tokens"]
      : undefined;
  const receipt = parseTransactionReceipt(raw["receipt"]) ?? undefined;
  const stateSource = isPlainObject(raw["state"])
    ? raw["state"]
    : action === "inspect"
      ? raw
      : undefined;
  const state =
    stateSource !== undefined
      ? parseSessionInspect(stateSource, session, epoch)
      : undefined;

  return Object.freeze({
    ok,
    action,
    ...(session !== undefined ? { session } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
    ...(lease !== undefined ? { lease } : {}),
    ...(leaseExpiresAt !== undefined ? { lease_expires_at: leaseExpiresAt } : {}),
    ...(transaction !== undefined ? { transaction } : {}),
    ...(memoryRead !== undefined ? { memory_read: memoryRead } : {}),
    ...(retainKv !== undefined ? { retain_kv: retainKv } : {}),
    ...(snapshotPath !== undefined ? { snapshot_path: snapshotPath } : {}),
    ...(snapshotName !== undefined ? { snapshot_name: snapshotName } : {}),
    ...(committedTokens !== undefined ? { committed_tokens: committedTokens } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    raw: Object.freeze({ ...raw }),
  });
}

export function validateGenerateRequest(req: MemTGenerateRequest): ParsedMemTRid {
  const parsedRid = parseMemTRid(req.rid);
  const stage: MemTErrorStage = parsedRid?.mode === "commit" ? "commit" : "query";
  if (parsedRid === null) {
    throw new MemTClientError(
      `Invalid MemT generate RID '${req.rid}': expected memt|<session>|query|<nonce> or memt|<session>|commit:<tokens>|<nonce>`,
      { code: "invalid_rid", stage },
    );
  }
  if (typeof req.memt_epoch !== "string" || req.memt_epoch.trim().length === 0) {
    throw new MemTClientError("memt_epoch is required on POST /generate", {
      code: "missing_epoch",
      stage,
    });
  }
  if (req.text === undefined && req.input_ids === undefined) {
    throw new MemTClientError("POST /generate requires 'text' or 'input_ids'", {
      code: "invalid_request",
      stage,
    });
  }
  const sp = req.sampling_params;
  if (sp.n !== 1) {
    throw new MemTClientError("sampling_params.n must be 1 for MemT requests", {
      code: "invalid_sampling_params",
      stage,
    });
  }
  if (sp.ignore_eos !== false) {
    throw new MemTClientError(
      "sampling_params.ignore_eos must be false for MemT requests",
      { code: "invalid_sampling_params", stage },
    );
  }
  if (parsedRid.mode === "commit") {
    if (sp.max_new_tokens !== 0) {
      throw new MemTClientError(
        "sampling_params.max_new_tokens must be 0 for MemT commit requests",
        { code: "invalid_sampling_params", stage: "commit" },
      );
    }
    if (typeof req.memt_lease !== "string" || req.memt_lease.length === 0) {
      throw new MemTClientError("memt_lease is required for MemT commit requests", {
        code: "missing_lease",
        stage: "commit",
      });
    }
    if (
      typeof req.memt_transaction !== "string" ||
      req.memt_transaction.length === 0
    ) {
      throw new MemTClientError(
        "memt_transaction is required for MemT commit requests",
        { code: "missing_transaction", stage: "commit" },
      );
    }
  } else {
    if (
      typeof sp.max_new_tokens !== "number" ||
      !Number.isSafeInteger(sp.max_new_tokens) ||
      sp.max_new_tokens <= 0
    ) {
      throw new MemTClientError(
        "sampling_params.max_new_tokens must be an explicit positive integer for MemT query requests",
        { code: "invalid_sampling_params", stage: "query" },
      );
    }
  }
  return parsedRid;
}

export function parseMemTGenerateResponse(
  raw: unknown,
  stage: "query" | "commit",
): MemTGenerateResponse {
  if (!isPlainObject(raw)) {
    throw new MemTClientError("POST /generate returned non-object JSON", {
      code: "protocol_error",
      stage,
    });
  }
  const text = typeof raw["text"] === "string" ? raw["text"] : "";
  const rid = typeof raw["rid"] === "string" ? raw["rid"] : undefined;
  const memtEpoch = readEpochString(raw["memt_epoch"] ?? raw["epoch"], stage, false);
  const metaInfo = isPlainObject(raw["meta_info"])
    ? Object.freeze({ ...raw["meta_info"] })
    : undefined;
  return Object.freeze({
    text,
    ...(rid !== undefined ? { rid } : {}),
    ...(memtEpoch !== undefined ? { memt_epoch: memtEpoch } : {}),
    ...(metaInfo !== undefined ? { meta_info: metaInfo } : {}),
    raw: Object.freeze({ ...raw }),
  });
}
