import { isPlainObject } from "./db";
import {
  buildCommitRid,
  buildQueryRid,
  MEMT_DEFAULT_CHUNK_TOKENS,
  MemTClientError,
  parseMemTCapabilities,
  parseMemTControlResponse,
  parseMemTGenerateResponse,
  parseMemTIdentity,
  validateGenerateRequest,
  validateLeaseTtl,
} from "./protocol";
import type {
  MemTCapabilities,
  MemTControlAction,
  MemTControlRequest,
  MemTControlResponse,
  MemTErrorStage,
  MemTGenerateRequest,
  MemTGenerateResponse,
  MemTIdentity,
  MemTSessionInspect,
  MemTTransactionReceipt,
} from "./protocol";

export interface MemTClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly probeTimeoutMs?: number;
  readonly fetch?: typeof fetch;
}

export interface MemTRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MemTSessionCreateOptions {
  readonly session?: string;
  readonly memoryRead?: boolean;
  readonly source?: string;
  readonly sourceLease?: string;
  readonly retainKv?: boolean;
  readonly leaseTtlSeconds?: number;
  readonly acquireLease?: boolean;
}

export interface MemTConversationTurn {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface MemTQueryOptions {
  readonly maxNewTokens?: number;
  readonly temperature?: number;
  readonly topP?: number;
  readonly stop?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MemTQueryResult {
  readonly text: string;
  readonly rid: string;
  readonly epoch: string;
  readonly metaInfo?: Readonly<Record<string, unknown>>;
}

export interface MemTCommitOptions {
  readonly chunkTokens?: number;
  readonly tokenCounter?: (text: string) => number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface MemTCommitResult {
  readonly session: string;
  readonly epoch: string;
  readonly transactions: readonly string[];
  readonly chunksCommitted: number;
  readonly tokensCommitted: number;
}

export interface MemTSnapshotTarget {
  readonly path?: string;
  readonly name?: string;
}

export interface MemTSnapshotExportResult {
  readonly session: string;
  readonly epoch: string;
  readonly snapshotPath?: string;
  readonly snapshotName?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface MemTSnapshotImportResult {
  readonly session: string;
  readonly epoch: string;
  readonly snapshotPath?: string;
  readonly snapshotName?: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface MemTSessionStatus {
  readonly session: string;
  readonly epoch: string;
  readonly lease: string | null;
  readonly memoryRead: boolean;
  readonly retainKv: boolean;
  readonly closed: boolean;
  readonly pendingUncertainTransaction: {
    readonly transaction: string;
    readonly stage: MemTErrorStage;
  } | null;
  readonly serverState?: MemTSessionInspect;
}

export interface MemTRecoveryReport {
  readonly status:
    | "clean"
    | "epoch_changed"
    | "reconciled_committed"
    | "aborted_open_transaction"
    | "reconciled_aborted";
  readonly epochChanged: boolean;
  readonly previousEpoch: string;
  readonly currentEpoch: string;
  readonly transaction?: string;
  readonly transactionState?: string;
  readonly safeToRetry: boolean;
  readonly receipt?: MemTTransactionReceipt;
}

export function estimateMemTTokens(text: string): number {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes === 0) return 0;
  return Math.max(1, Math.ceil(bytes / 3.5));
}

export function chunkTextByTokens(
  text: string,
  maxTokens: number,
  tokenCounter: (value: string) => number = estimateMemTTokens,
): string[] {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new RangeError("maxTokens must be a positive integer");
  }
  if (text.length === 0) return [];
  if (tokenCounter(text) <= maxTokens) return [text];

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let low = 1;
    let high = text.length - cursor;
    let best = 1;

    let step = Math.min(high, maxTokens * 4);
    while (
      step < high &&
      tokenCounter(text.slice(cursor, cursor + step)) <= maxTokens
    ) {
      low = step;
      best = step;
      step = Math.min(high, step * 2);
    }
    high = step;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const candidate = text.slice(cursor, cursor + mid);
      if (tokenCounter(candidate) <= maxTokens) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    let end = cursor + best;
    if (end < text.length) {
      const prevCode = text.charCodeAt(end - 1);
      if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
        end -= 1;
      }
    }

    if (end < text.length) {
      const floor = cursor + Math.max(1, Math.floor((end - cursor) * 0.75));
      const slice = text.slice(floor, end);
      const paraIdx = slice.lastIndexOf("\n\n");
      const lineIdx = slice.lastIndexOf("\n");
      const spaceIdx = slice.lastIndexOf(" ");
      if (paraIdx >= 0) {
        end = floor + paraIdx + 2;
      } else if (lineIdx >= 0) {
        end = floor + lineIdx + 1;
      } else if (spaceIdx >= 0) {
        end = floor + spaceIdx + 1;
      }
    }

    if (end <= cursor) {
      const code = text.charCodeAt(cursor);
      end = cursor + (code >= 0xd800 && code <= 0xdbff ? 2 : 1);
    }

    const chunk = text.slice(cursor, end);
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    cursor = end;
  }

  return chunks;
}

function normalizeBaseUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new MemTClientError(`Invalid MemT server URL: ${rawUrl}`, {
      code: "invalid_config",
      stage: "transport",
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MemTClientError(
      `MemT server URL must use http or https (got ${parsed.protocol})`,
      { code: "invalid_config", stage: "transport" },
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

function combineSignals(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`MemT request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort(external?.reason ?? new Error("MemT request aborted"));
  };
  if (external !== undefined) {
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      if (external !== undefined) {
        external.removeEventListener("abort", onExternalAbort);
      }
    },
  };
}

function extractErrorDetails(body: unknown): {
  message?: string;
  code?: string;
  epoch?: string;
  answer?: string;
} {
  if (!isPlainObject(body)) return {};
  const errObj = isPlainObject(body["error"]) ? body["error"] : body;
  const message =
    typeof errObj["message"] === "string"
      ? errObj["message"]
      : typeof body["detail"] === "string"
        ? body["detail"]
        : typeof body["error"] === "string"
          ? body["error"]
          : undefined;
  const code =
    typeof errObj["code"] === "string"
      ? errObj["code"]
      : typeof body["code"] === "string"
        ? body["code"]
        : undefined;
  const epochRaw = errObj["epoch"] ?? body["epoch"] ?? body["memt_epoch"];
  const epoch =
    typeof epochRaw === "string"
      ? epochRaw
      : typeof epochRaw === "number"
        ? String(epochRaw)
        : undefined;
  const answer =
    typeof body["text"] === "string"
      ? body["text"]
      : typeof body["answer"] === "string"
        ? body["answer"]
        : undefined;
  return {
    ...(message !== undefined ? { message } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
    ...(answer !== undefined ? { answer } : {}),
  };
}

function mapActionToStage(action: MemTControlAction): MemTErrorStage {
  switch (action) {
    case "begin":
      return "begin";
    case "publish":
      return "publish";
    case "abort":
      return "abort";
    case "export":
      return "export";
    case "import":
      return "import";
    default:
      return "control";
  }
}

export class MemTClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private trackedEpoch: string | null = null;

  constructor(options: MemTClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey =
      typeof options.apiKey === "string" && options.apiKey.length > 0
        ? options.apiKey
        : undefined;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 1_500;
    this.fetchImpl = options.fetch ?? fetch;
  }

  get epoch(): string | null {
    return this.trackedEpoch;
  }

  setEpoch(epoch: string): void {
    this.trackedEpoch = epoch;
  }

  async getIdentity(options: MemTRequestOptions = {}): Promise<MemTIdentity> {
    const raw = await this.requestJson("GET", "/memt/identity", undefined, {
      stage: "identity",
      timeoutMs: options.timeoutMs ?? this.probeTimeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      uncertainOnTransportFailure: false,
    });
    return parseMemTIdentity(raw);
  }

  async getCapabilities(
    options: MemTRequestOptions = {},
  ): Promise<MemTCapabilities> {
    const raw = await this.requestJson("GET", "/memt/capabilities", undefined, {
      stage: "capabilities",
      timeoutMs: options.timeoutMs ?? this.probeTimeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      uncertainOnTransportFailure: false,
    });
    const caps = parseMemTCapabilities(raw);
    this.trackedEpoch = caps.epoch;
    return caps;
  }

  async control(
    request: MemTControlRequest,
    options: MemTRequestOptions = {},
  ): Promise<MemTControlResponse> {
    const stage = mapActionToStage(request.action);
    if (
      (request.action === "acquire" ||
        request.action === "renew" ||
        request.action === "create") &&
      request.ttl !== undefined
    ) {
      validateLeaseTtl(request.ttl, stage);
    }

    const expectedEpoch = request.epoch ?? this.trackedEpoch ?? undefined;
    const payload: Record<string, unknown> = {
      ...request,
      ...(expectedEpoch !== undefined ? { epoch: expectedEpoch } : {}),
    };
    const transaction =
      "transaction" in request ? request.transaction : undefined;
    const session = "session" in request ? request.session : undefined;
    const uncertainOnTransportFailure = request.action === "publish";

    const raw = await this.requestJson("POST", "/memt/control", payload, {
      stage,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      uncertainOnTransportFailure,
      ...(transaction !== undefined ? { transaction } : {}),
      ...(expectedEpoch !== undefined ? { expectedEpoch } : {}),
    });

    const parsed = parseMemTControlResponse(request.action, raw, session);
    if (parsed.epoch !== undefined) {
      if (
        expectedEpoch !== undefined &&
        parsed.epoch !== expectedEpoch &&
        request.action !== "create" &&
        request.action !== "inspect"
      ) {
        throw new MemTClientError(
          `MemT server epoch changed from '${expectedEpoch}' to '${parsed.epoch}' during '${request.action}'`,
          {
            code: "epoch_mismatch",
            stage,
            uncertain: uncertainOnTransportFailure,
            epoch: parsed.epoch,
            expectedEpoch,
            ...(transaction !== undefined ? { transaction } : {}),
          },
        );
      }
      this.trackedEpoch = parsed.epoch;
    }

    if (!parsed.ok) {
      throw new MemTClientError(
        `MemT control action '${request.action}' returned ok=false`,
        {
          code: "control_rejected",
          stage,
          uncertain: false,
          ...(parsed.epoch !== undefined ? { epoch: parsed.epoch } : {}),
          ...(transaction !== undefined ? { transaction } : {}),
        },
      );
    }

    return parsed;
  }

  async generate(
    request: MemTGenerateRequest,
    options: MemTRequestOptions = {},
  ): Promise<MemTGenerateResponse> {
    const parsedRid = validateGenerateRequest(request);
    const stage: "query" | "commit" = parsedRid.mode;
    const uncertainOnTransportFailure = stage === "commit";

    const raw = await this.requestJson("POST", "/generate", request, {
      stage,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      uncertainOnTransportFailure,
      ...(request.memt_transaction !== undefined
        ? { transaction: request.memt_transaction }
        : {}),
      expectedEpoch: request.memt_epoch,
    });

    const parsed = parseMemTGenerateResponse(raw, stage);
    if (parsed.memt_epoch !== undefined) {
      if (parsed.memt_epoch !== request.memt_epoch) {
        throw new MemTClientError(
          `MemT server epoch changed from '${request.memt_epoch}' to '${parsed.memt_epoch}' during ${stage}`,
          {
            code: "epoch_mismatch",
            stage,
            uncertain: uncertainOnTransportFailure,
            epoch: parsed.memt_epoch,
            expectedEpoch: request.memt_epoch,
            ...(request.memt_transaction !== undefined
              ? { transaction: request.memt_transaction }
              : {}),
            ...(parsed.text.length > 0 ? { answer: parsed.text } : {}),
          },
        );
      }
      this.trackedEpoch = parsed.memt_epoch;
    }

    return parsed;
  }

  async createSession(
    options: MemTSessionCreateOptions = {},
  ): Promise<MemTSession> {
    const capabilities = await this.getCapabilities();
    const identity = await this.getIdentity().catch(() => null);
    const ttl = validateLeaseTtl(options.leaseTtlSeconds ?? 300, "control");

    const createReq: MemTControlRequest = {
      action: "create",
      epoch: capabilities.epoch,
      memory_read: options.memoryRead ?? true,
      retain_kv: options.retainKv ?? false,
      ...(options.session !== undefined ? { session: options.session } : {}),
      ...(options.source !== undefined ? { source: options.source } : {}),
      ...(options.sourceLease !== undefined
        ? { source_lease: options.sourceLease }
        : {}),
      ttl,
    };

    const created = await this.control(createReq);
    const sessionId = created.session ?? options.session;
    if (sessionId === undefined || sessionId.length === 0) {
      throw new MemTClientError(
        "MemT server did not return a session id on create",
        { code: "protocol_error", stage: "control" },
      );
    }

    let lease: string | null = created.lease ?? null;
    if (lease === null && (options.acquireLease ?? true)) {
      const acquired = await this.control({
        action: "acquire",
        session: sessionId,
        ttl,
        epoch: created.epoch ?? capabilities.epoch,
      });
      lease = acquired.lease ?? null;
    }

    return new MemTSession({
      client: this,
      sessionId,
      epoch: created.epoch ?? capabilities.epoch,
      capabilities,
      identity,
      lease,
      leaseTtlSeconds: ttl,
      memoryRead: created.memory_read ?? options.memoryRead ?? true,
      retainKv: created.retain_kv ?? options.retainKv ?? false,
    });
  }

  private async requestJson(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    meta: {
      stage: MemTErrorStage;
      timeoutMs: number;
      signal?: AbortSignal;
      uncertainOnTransportFailure: boolean;
      transaction?: string;
      expectedEpoch?: string;
    },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (method === "POST") {
      headers["content-type"] = "application/json";
    }
    if (this.apiKey !== undefined) {
      headers["authorization"] = `Bearer ${this.apiKey}`;
    }

    const { signal, cleanup } = combineSignals(meta.timeoutMs, meta.signal);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal,
      });
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message.toLowerCase().includes("timed out"));
      throw new MemTClientError(
        isAbort
          ? `MemT ${meta.stage} request timed out after ${meta.timeoutMs}ms`
          : `MemT ${meta.stage} transport failed`,
        {
          code: isAbort ? "timeout" : "network_error",
          stage: meta.stage,
          uncertain: meta.uncertainOnTransportFailure,
          ...(meta.transaction !== undefined
            ? { transaction: meta.transaction }
            : {}),
          ...(meta.expectedEpoch !== undefined
            ? { expectedEpoch: meta.expectedEpoch }
            : {}),
          cause: error,
        },
      );
    } finally {
      cleanup();
    }

    let rawText = "";
    try {
      rawText = await response.text();
    } catch (error) {
      throw new MemTClientError(
        `Failed to read MemT ${meta.stage} response body`,
        {
          status: response.status,
          code: "read_error",
          stage: meta.stage,
          uncertain: meta.uncertainOnTransportFailure,
          ...(meta.transaction !== undefined
            ? { transaction: meta.transaction }
            : {}),
          cause: error,
        },
      );
    }

    let parsed: unknown;
    if (rawText.length > 0) {
      try {
        parsed = JSON.parse(rawText);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const details = extractErrorDetails(parsed);
      const isConflict = response.status === 409;
      const isEpochMismatch =
        details.code === "epoch_mismatch" ||
        response.status === 412 ||
        (details.epoch !== undefined &&
          meta.expectedEpoch !== undefined &&
          details.epoch !== meta.expectedEpoch);
      const code = isEpochMismatch
        ? "epoch_mismatch"
        : isConflict
          ? (details.code ?? "lease_conflict")
          : (details.code ?? `http_${response.status}`);
      const uncertain =
        meta.uncertainOnTransportFailure && response.status >= 500;
      throw new MemTClientError(
        details.message ??
          `MemT ${meta.stage} failed with HTTP ${response.status}`,
        {
          status: response.status,
          code,
          stage: meta.stage,
          uncertain,
          ...(meta.transaction !== undefined
            ? { transaction: meta.transaction }
            : {}),
          ...(details.answer !== undefined ? { answer: details.answer } : {}),
          ...(details.epoch !== undefined ? { epoch: details.epoch } : {}),
          ...(meta.expectedEpoch !== undefined
            ? { expectedEpoch: meta.expectedEpoch }
            : {}),
        },
      );
    }

    if (parsed === undefined) {
      throw new MemTClientError(
        `MemT ${meta.stage} returned invalid JSON (HTTP ${response.status})`,
        {
          status: response.status,
          code: "invalid_json",
          stage: meta.stage,
          uncertain: meta.uncertainOnTransportFailure,
          ...(meta.transaction !== undefined
            ? { transaction: meta.transaction }
            : {}),
        },
      );
    }

    return parsed;
  }
}

interface MemTSessionInit {
  readonly client: MemTClient;
  readonly sessionId: string;
  readonly epoch: string;
  readonly capabilities: MemTCapabilities;
  readonly identity: MemTIdentity | null;
  readonly lease: string | null;
  readonly leaseTtlSeconds: number;
  readonly memoryRead: boolean;
  readonly retainKv: boolean;
}

export class MemTSession {
  private readonly client: MemTClient;
  private _sessionId: string;
  private _epoch: string;
  private _capabilities: MemTCapabilities;
  private _identity: MemTIdentity | null;
  private _lease: string | null;
  private readonly leaseTtlSeconds: number;
  private _memoryRead: boolean;
  private _retainKv: boolean;
  private _closed = false;
  private pendingUncertain: {
    readonly transaction: string;
    readonly stage: MemTErrorStage;
  } | null = null;

  constructor(init: MemTSessionInit) {
    this.client = init.client;
    this._sessionId = init.sessionId;
    this._epoch = init.epoch;
    this._capabilities = init.capabilities;
    this._identity = init.identity;
    this._lease = init.lease;
    this.leaseTtlSeconds = init.leaseTtlSeconds;
    this._memoryRead = init.memoryRead;
    this._retainKv = init.retainKv;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get epoch(): string {
    return this._epoch;
  }

  get lease(): string | null {
    return this._lease;
  }

  get capabilities(): MemTCapabilities {
    return this._capabilities;
  }

  get identity(): MemTIdentity | null {
    return this._identity;
  }

  get memoryRead(): boolean {
    return this._memoryRead;
  }

  get retainKv(): boolean {
    return this._retainKv;
  }

  get isClosed(): boolean {
    return this._closed;
  }

  get hasUncertainTransaction(): boolean {
    return this.pendingUncertain !== null;
  }

  private assertOpen(stage: MemTErrorStage): void {
    if (this._closed) {
      throw new MemTClientError("MemT session is closed", {
        code: "session_closed",
        stage,
      });
    }
  }

  private assertNoUncertainWrite(stage: MemTErrorStage): void {
    if (this.pendingUncertain !== null) {
      throw new MemTClientError(
        `Session has an unresolved uncertain transaction '${this.pendingUncertain.transaction}' (stage: ${this.pendingUncertain.stage}); call recover() before writing again`,
        {
          code: "uncertain_transaction_pending",
          stage,
          uncertain: true,
          transaction: this.pendingUncertain.transaction,
          epoch: this._epoch,
        },
      );
    }
  }

  async acquireLease(
    ttlSeconds: number = this.leaseTtlSeconds,
  ): Promise<string> {
    this.assertOpen("control");
    const ttl = validateLeaseTtl(ttlSeconds, "control");
    const res = await this.client.control({
      action: "acquire",
      session: this._sessionId,
      ttl,
      epoch: this._epoch,
    });
    if (res.lease === undefined || res.lease.length === 0) {
      throw new MemTClientError("MemT server did not return a lease token", {
        code: "protocol_error",
        stage: "control",
      });
    }
    this._lease = res.lease;
    return res.lease;
  }

  async renewLease(
    ttlSeconds: number = this.leaseTtlSeconds,
  ): Promise<string> {
    this.assertOpen("control");
    const ttl = validateLeaseTtl(ttlSeconds, "control");
    if (this._lease === null) {
      return this.acquireLease(ttl);
    }
    const res = await this.client.control({
      action: "renew",
      session: this._sessionId,
      lease: this._lease,
      ttl,
      epoch: this._epoch,
    });
    if (res.lease !== undefined && res.lease.length > 0) {
      this._lease = res.lease;
    }
    return this._lease;
  }

  async releaseLease(): Promise<void> {
    if (this._lease === null) return;
    const activeLease = this._lease;
    this._lease = null;
    await this.client.control({
      action: "release",
      session: this._sessionId,
      lease: activeLease,
      epoch: this._epoch,
    });
  }

  private async ensureLease(): Promise<string> {
    if (this._lease !== null) return this._lease;
    return this.acquireLease(this.leaseTtlSeconds);
  }

  async setMemoryRead(enabled: boolean): Promise<boolean> {
    this.assertOpen("control");
    const res = await this.client.control({
      action: "memory_read",
      session: this._sessionId,
      ...(this._lease !== null ? { lease: this._lease } : {}),
      memory_read: enabled,
      epoch: this._epoch,
    });
    this._memoryRead = res.memory_read ?? enabled;
    return this._memoryRead;
  }

  async query(
    prompt: string,
    options: MemTQueryOptions = {},
  ): Promise<MemTQueryResult> {
    this.assertOpen("query");
    const maxNewTokens = options.maxNewTokens ?? 512;
    const rid = buildQueryRid(this._sessionId);
    const req: MemTGenerateRequest = {
      rid,
      text: prompt,
      memt_epoch: this._epoch,
      ...(this._lease !== null ? { memt_lease: this._lease } : {}),
      sampling_params: {
        max_new_tokens: maxNewTokens,
        n: 1,
        ignore_eos: false,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
        ...(options.topP !== undefined ? { top_p: options.topP } : {}),
        ...(options.stop !== undefined ? { stop: options.stop } : {}),
      },
      stream: false,
    };

    const res = await this.client.generate(req, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });

    return {
      text: res.text,
      rid: res.rid ?? rid,
      epoch: res.memt_epoch ?? this._epoch,
      ...(res.meta_info !== undefined ? { metaInfo: res.meta_info } : {}),
    };
  }

  async commitTurns(
    turns: readonly MemTConversationTurn[],
    options: MemTCommitOptions = {},
  ): Promise<MemTCommitResult> {
    this.assertOpen("commit");
    this.assertNoUncertainWrite("commit");
    if (turns.length === 0) {
      return {
        session: this._sessionId,
        epoch: this._epoch,
        transactions: [],
        chunksCommitted: 0,
        tokensCommitted: 0,
      };
    }
    const serialized = turns
      .map((turn) => `[${turn.role}]\n${turn.content.trim()}`)
      .join("\n\n");
    return this.ingestDocument(serialized, options);
  }

  async ingestDocument(
    text: string,
    options: MemTCommitOptions = {},
  ): Promise<MemTCommitResult> {
    this.assertOpen("commit");
    this.assertNoUncertainWrite("commit");

    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return {
        session: this._sessionId,
        epoch: this._epoch,
        transactions: [],
        chunksCommitted: 0,
        tokensCommitted: 0,
      };
    }

    const tokenCounter = options.tokenCounter ?? estimateMemTTokens;
    const chunkSize = Math.min(
      options.chunkTokens ??
        this._capabilities.chunk_tokens ??
        MEMT_DEFAULT_CHUNK_TOKENS,
      this._capabilities.max_commit_tokens,
    );
    const chunks = chunkTextByTokens(trimmed, chunkSize, tokenCounter);
    const lease = await this.ensureLease();

    const batches: string[][] = [];
    let currentBatch: string[] = [];
    let currentBatchTokens = 0;

    for (const chunk of chunks) {
      const tokens = Math.max(1, tokenCounter(chunk));
      if (
        currentBatch.length > 0 &&
        currentBatchTokens + tokens > this._capabilities.max_commit_tokens
      ) {
        batches.push(currentBatch);
        currentBatch = [];
        currentBatchTokens = 0;
      }
      currentBatch.push(chunk);
      currentBatchTokens += tokens;
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    const transactions: string[] = [];
    let chunksCommitted = 0;
    let tokensCommitted = 0;

    for (const batch of batches) {
      const beginRes = await this.client.control(
        {
          action: "begin",
          session: this._sessionId,
          lease,
          epoch: this._epoch,
        },
        {
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
      const transaction = beginRes.transaction;
      if (transaction === undefined || transaction.length === 0) {
        throw new MemTClientError(
          "MemT server did not return a transaction id on begin",
          { code: "protocol_error", stage: "begin" },
        );
      }

      try {
        for (const chunk of batch) {
          const tokenCount = Math.max(1, tokenCounter(chunk));
          const rid = buildCommitRid(this._sessionId, tokenCount);
          await this.client.generate(
            {
              rid,
              text: chunk,
              memt_epoch: this._epoch,
              memt_lease: lease,
              memt_transaction: transaction,
              sampling_params: {
                max_new_tokens: 0,
                n: 1,
                ignore_eos: false,
              },
              stream: false,
            },
            {
              ...(options.timeoutMs !== undefined
                ? { timeoutMs: options.timeoutMs }
                : {}),
              ...(options.signal !== undefined ? { signal: options.signal } : {}),
            },
          );
          chunksCommitted += 1;
          tokensCommitted += tokenCount;
        }

        await this.client.control(
          {
            action: "publish",
            session: this._sessionId,
            lease,
            transaction,
            epoch: this._epoch,
          },
          {
            ...(options.timeoutMs !== undefined
              ? { timeoutMs: options.timeoutMs }
              : {}),
            ...(options.signal !== undefined ? { signal: options.signal } : {}),
          },
        );
        transactions.push(transaction);
      } catch (error) {
        if (error instanceof MemTClientError && error.uncertain) {
          this.pendingUncertain = {
            transaction,
            stage: error.stage,
          };
          throw error;
        }
        try {
          await this.client.control({
            action: "abort",
            session: this._sessionId,
            lease,
            transaction,
            epoch: this._epoch,
          });
        } catch {
          // Preserve original error if abort fails.
        }
        throw error;
      }
    }

    return {
      session: this._sessionId,
      epoch: this._epoch,
      transactions,
      chunksCommitted,
      tokensCommitted,
    };
  }

  async saveSnapshot(
    target: string | MemTSnapshotTarget,
  ): Promise<MemTSnapshotExportResult> {
    this.assertOpen("export");
    this.assertNoUncertainWrite("export");
    const lease = await this.ensureLease();
    const spec: MemTSnapshotTarget =
      typeof target === "string" ? { path: target } : target;
    const res = await this.client.control({
      action: "export",
      session: this._sessionId,
      lease,
      epoch: this._epoch,
      ...(spec.path !== undefined ? { path: spec.path } : {}),
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    });
    return {
      session: this._sessionId,
      epoch: res.epoch ?? this._epoch,
      ...(res.snapshot_path !== undefined
        ? { snapshotPath: res.snapshot_path }
        : {}),
      ...(res.snapshot_name !== undefined
        ? { snapshotName: res.snapshot_name }
        : {}),
      raw: res.raw,
    };
  }

  async loadSnapshot(
    source: string | MemTSnapshotTarget,
  ): Promise<MemTSnapshotImportResult> {
    this.assertOpen("import");
    this.assertNoUncertainWrite("import");
    const lease = await this.ensureLease();
    const spec: MemTSnapshotTarget =
      typeof source === "string" ? { path: source } : source;
    const res = await this.client.control({
      action: "import",
      session: this._sessionId,
      lease,
      epoch: this._epoch,
      ...(spec.path !== undefined ? { path: spec.path } : {}),
      ...(spec.name !== undefined ? { name: spec.name } : {}),
    });
    return {
      session: this._sessionId,
      epoch: res.epoch ?? this._epoch,
      ...(res.snapshot_path !== undefined
        ? { snapshotPath: res.snapshot_path }
        : {}),
      ...(res.snapshot_name !== undefined
        ? { snapshotName: res.snapshot_name }
        : {}),
      raw: res.raw,
    };
  }

  async status(): Promise<MemTSessionStatus> {
    let serverState: MemTSessionInspect | undefined;
    if (!this._closed) {
      const res = await this.client.control({
        action: "inspect",
        session: this._sessionId,
        ...(this._lease !== null ? { lease: this._lease } : {}),
        epoch: this._epoch,
      });
      serverState = res.state;
    }
    return {
      session: this._sessionId,
      epoch: this._epoch,
      lease: this._lease,
      memoryRead: this._memoryRead,
      retainKv: this._retainKv,
      closed: this._closed,
      pendingUncertainTransaction: this.pendingUncertain,
      ...(serverState !== undefined ? { serverState } : {}),
    };
  }

  async recover(): Promise<MemTRecoveryReport> {
    const previousEpoch = this._epoch;
    const freshCaps = await this.client.getCapabilities();
    this._capabilities = freshCaps;

    if (freshCaps.epoch !== previousEpoch) {
      const uncertainTx = this.pendingUncertain?.transaction;
      this._epoch = freshCaps.epoch;
      this._lease = null;
      this.pendingUncertain = null;
      return {
        status: "epoch_changed",
        epochChanged: true,
        previousEpoch,
        currentEpoch: freshCaps.epoch,
        ...(uncertainTx !== undefined ? { transaction: uncertainTx } : {}),
        transactionState: "lost_after_restart",
        safeToRetry: false,
      };
    }

    const inspectRes = await this.client.control({
      action: "inspect",
      session: this._sessionId,
      ...(this._lease !== null ? { lease: this._lease } : {}),
      epoch: this._epoch,
    });
    const state = inspectRes.state;
    const targetTx =
      this.pendingUncertain?.transaction ??
      state?.active_transaction ??
      undefined;

    if (targetTx === undefined) {
      this.pendingUncertain = null;
      return {
        status: "clean",
        epochChanged: false,
        previousEpoch,
        currentEpoch: this._epoch,
        safeToRetry: true,
      };
    }

    const receipt =
      state?.transactions[targetTx] ??
      (state?.last_transaction?.transaction === targetTx
        ? state.last_transaction
        : undefined);

    if (
      receipt !== undefined &&
      (receipt.state === "published" || receipt.state === "committed")
    ) {
      this.pendingUncertain = null;
      return {
        status: "reconciled_committed",
        epochChanged: false,
        previousEpoch,
        currentEpoch: this._epoch,
        transaction: targetTx,
        transactionState: receipt.state,
        safeToRetry: false,
        receipt,
      };
    }

    if (receipt?.state === "open" || state?.active_transaction === targetTx) {
      const lease = await this.ensureLease();
      await this.client.control({
        action: "abort",
        session: this._sessionId,
        lease,
        transaction: targetTx,
        epoch: this._epoch,
      });
      this.pendingUncertain = null;
      return {
        status: "aborted_open_transaction",
        epochChanged: false,
        previousEpoch,
        currentEpoch: this._epoch,
        transaction: targetTx,
        transactionState: "aborted",
        safeToRetry: true,
        ...(receipt !== undefined ? { receipt } : {}),
      };
    }

    this.pendingUncertain = null;
    return {
      status: "reconciled_aborted",
      epochChanged: false,
      previousEpoch,
      currentEpoch: this._epoch,
      transaction: targetTx,
      transactionState: receipt?.state ?? "aborted",
      safeToRetry: true,
      ...(receipt !== undefined ? { receipt } : {}),
    };
  }

  async reset(
    options: { readonly memoryRead?: boolean; readonly retainKv?: boolean } = {},
  ): Promise<void> {
    if (!this._closed) {
      try {
        await this.client.control({
          action: "close",
          session: this._sessionId,
          ...(this._lease !== null ? { lease: this._lease } : {}),
          epoch: this._epoch,
        });
      } catch {
        // Ignore close errors if server restarted or session already expired.
      }
    }

    const freshCaps = await this.client.getCapabilities();
    const memoryRead = options.memoryRead ?? this._memoryRead;
    const retainKv = options.retainKv ?? this._retainKv;
    const created = await this.client.control({
      action: "create",
      memory_read: memoryRead,
      retain_kv: retainKv,
      ttl: this.leaseTtlSeconds,
      epoch: freshCaps.epoch,
    });
    const newSessionId = created.session;
    if (newSessionId === undefined || newSessionId.length === 0) {
      throw new MemTClientError(
        "MemT server did not return a session id on reset",
        { code: "protocol_error", stage: "control" },
      );
    }
    let lease: string | null = created.lease ?? null;
    if (lease === null) {
      const acquired = await this.client.control({
        action: "acquire",
        session: newSessionId,
        ttl: this.leaseTtlSeconds,
        epoch: created.epoch ?? freshCaps.epoch,
      });
      lease = acquired.lease ?? null;
    }

    this._sessionId = newSessionId;
    this._epoch = created.epoch ?? freshCaps.epoch;
    this._capabilities = freshCaps;
    this._lease = lease;
    this._memoryRead = created.memory_read ?? memoryRead;
    this._retainKv = created.retain_kv ?? retainKv;
    this.pendingUncertain = null;
    this._closed = false;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    const activeLease = this._lease;
    this._lease = null;
    try {
      if (activeLease !== null) {
        await this.client.control({
          action: "release",
          session: this._sessionId,
          lease: activeLease,
          epoch: this._epoch,
        });
      }
    } catch {
      // Best-effort release before close.
    }
    try {
      await this.client.control({
        action: "close",
        session: this._sessionId,
        epoch: this._epoch,
      });
    } catch {
      // Best-effort close.
    }
  }
}
