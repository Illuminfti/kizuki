import { request as httpRequest } from "node:http";
import type {
  IncomingMessage,
  RequestOptions,
} from "node:http";
import { isAbsolute } from "node:path";
import { isPlainObject } from "../util/validate";
import { isSecretRef } from "./secret-ref";
import {
  isPortErrorCode,
  isPortKind,
  PortError,
  validatePortDescriptor,
} from "./ports";
import type {
  PortContext,
  PortDescriptor,
  PortErrorCode,
  PortKind,
} from "./ports";
import {
  validateAbsenceProof,
  validateGraphResult,
  validateRetrievalMutationReport,
  validateRetrievalQuery,
  validateRetrievalResult,
} from "./retrieval";
import type {
  EntityRef,
  GraphQueryOptions,
  RetrievalDoc,
  RetrievalPort,
} from "./retrieval";

export type RemoteEndpoint =
  | {
      readonly transport: "unix";
      readonly socket_path: string;
    }
  | {
      readonly transport: "tcp";
      readonly host: string;
      readonly port: number;
    };

export interface RemotePortOptions {
  readonly endpoint: RemoteEndpoint;
  readonly kind: PortKind;
  readonly contract: string;
  readonly adapter_id?: string;
  readonly secret_ref: string;
  readonly handshake_timeout_ms?: number;
  readonly default_timeout_ms?: number;
  readonly response_max_bytes?: number;
}

type WirePrimitive = null | boolean | number | string;
type WireValue =
  | WirePrimitive
  | WireValue[]
  | { [key: string]: WireValue };

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000;
const DEFAULT_METHOD_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_TIMEOUT_MS = 300_000;
const MAX_WIRE_DEPTH = 64;
const MAX_WIRE_NODES = 250_000;
const FLOAT32_TAG = "Float32Array";
const METHOD = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

function configError(message: string): never {
  throw new PortError("config_invalid", message, false);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  max: number,
  field: string,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > max
  ) {
    configError(`${field} must be a bounded positive integer`);
  }
  return resolved;
}

function contractPath(contract: string): string {
  return contract.split("/").map(encodeURIComponent).join("/");
}

export function remoteDescribePath(contract: string): string {
  return `/v1/${contractPath(contract)}/describe`;
}

export function remoteMethodPrefix(contract: string): string {
  return `/v1/${contractPath(contract)}/`;
}

export function remoteMethodPath(
  contract: string,
  method: string,
): string {
  if (!METHOD.test(method)) configError("remote method name is invalid");
  return `${remoteMethodPrefix(contract)}${encodeURIComponent(method)}`;
}

function validateEndpoint(endpoint: RemoteEndpoint): void {
  if (!isPlainObject(endpoint)) configError("remote endpoint is invalid");
  if (endpoint.transport === "unix") {
    if (
      typeof endpoint.socket_path !== "string" ||
      endpoint.socket_path.length === 0 ||
      !isAbsolute(endpoint.socket_path)
    ) {
      configError("remote unix socket path must be absolute");
    }
    return;
  }
  if (endpoint.transport === "tcp") {
    if (endpoint.host !== "127.0.0.1" && endpoint.host !== "::1") {
      configError("remote TCP endpoint must be loopback");
    }
    if (
      !Number.isSafeInteger(endpoint.port) ||
      endpoint.port < 1 ||
      endpoint.port > 65_535
    ) {
      configError("remote TCP port is invalid");
    }
    return;
  }
  configError("remote endpoint transport is invalid");
}

function encodeFloat32(value: Float32Array): WireValue {
  const bytes = new Uint8Array(value.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index += 1) {
    view.setFloat32(index * 4, value[index]!, true);
  }
  return {
    $type: FLOAT32_TAG,
    base64: Buffer.from(bytes).toString("base64"),
  };
}

export function encodeRemoteValue(value: unknown): WireValue {
  const ancestors = new Set<object>();
  let nodes = 0;

  const encode = (input: unknown, depth: number): WireValue => {
    nodes += 1;
    if (nodes > MAX_WIRE_NODES || depth > MAX_WIRE_DEPTH) {
      configError("remote value exceeds structural limits");
    }
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) {
        configError("remote value contains a non-finite number");
      }
      return input;
    }
    if (input instanceof Float32Array) return encodeFloat32(input);
    if (Array.isArray(input)) {
      if (ancestors.has(input)) configError("remote value contains a cycle");
      ancestors.add(input);
      const encoded = input.map((item) => encode(item, depth + 1));
      ancestors.delete(input);
      return encoded;
    }
    if (isPlainObject(input)) {
      if (ancestors.has(input)) configError("remote value contains a cycle");
      ancestors.add(input);
      const encoded = Object.fromEntries(
        Object.entries(input).map(([key, item]) => [
          key,
          encode(item, depth + 1),
        ]),
      ) as { [key: string]: WireValue };
      ancestors.delete(input);
      return encoded;
    }
    configError("remote value is not a contract JSON type");
  };

  return encode(value, 0);
}

function decodeFloat32(value: Record<string, unknown>): Float32Array {
  if (
    Object.keys(value).sort().join(",") !== "$type,base64" ||
    value["$type"] !== FLOAT32_TAG ||
    typeof value["base64"] !== "string"
  ) {
    configError("remote Float32Array frame is invalid");
  }
  const encoded = value["base64"] as string;
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.byteLength % 4 !== 0
  ) {
    configError("remote Float32Array byte length is invalid");
  }
  const result = new Float32Array(bytes.byteLength / 4);
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  for (let index = 0; index < result.length; index += 1) {
    result[index] = view.getFloat32(index * 4, true);
  }
  return result;
}

export function decodeRemoteValue(value: unknown): unknown {
  let nodes = 0;
  const decode = (input: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_WIRE_NODES || depth > MAX_WIRE_DEPTH) {
      configError("remote response exceeds structural limits");
    }
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean" ||
      (typeof input === "number" && Number.isFinite(input))
    ) {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map((item) => decode(item, depth + 1));
    }
    if (isPlainObject(input)) {
      if (input["$type"] === FLOAT32_TAG) return decodeFloat32(input);
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [
          key,
          decode(item, depth + 1),
        ]),
      );
    }
    configError("remote response is not a contract JSON type");
  };
  return decode(value, 0);
}

function sanitizedRemoteMessage(
  code: PortErrorCode,
  value: unknown,
): string {
  if (typeof value !== "string") return `remote port reported ${code}`;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length === 0
    ? `remote port reported ${code}`
    : clean.slice(0, 512);
}

async function readResponse(
  response: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  const contentLength = Number(response.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PortError(
      "unavailable",
      "remote response exceeds its size limit",
      false,
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response) {
    const bytes =
      typeof chunk === "string" ? Buffer.from(chunk) : new Uint8Array(chunk);
    total += bytes.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new PortError(
        "unavailable",
        "remote response exceeds its size limit",
        false,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class RemotePortClient {
  private readonly handshakeTimeout: number;
  private readonly defaultTimeout: number;
  private readonly responseMaxBytes: number;
  private remoteDescriptor: PortDescriptor | null = null;
  private adapterDescriptor: PortDescriptor | null = null;
  private closed = false;

  constructor(
    private readonly context: PortContext,
    readonly options: RemotePortOptions,
  ) {
    validateEndpoint(options.endpoint);
    if (!isPortKind(options.kind)) configError("remote kind is invalid");
    if (options.contract.length === 0) {
      configError("remote contract is invalid");
    }
    if (!isSecretRef(options.secret_ref)) {
      configError("remote secret_ref must use a supported reference");
    }
    this.handshakeTimeout = boundedInteger(
      options.handshake_timeout_ms,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "remote handshake_timeout_ms",
    );
    this.defaultTimeout = boundedInteger(
      options.default_timeout_ms,
      DEFAULT_METHOD_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "remote default_timeout_ms",
    );
    this.responseMaxBytes = boundedInteger(
      options.response_max_bytes,
      DEFAULT_RESPONSE_MAX_BYTES,
      MAX_RESPONSE_BYTES,
      "remote response_max_bytes",
    );
  }

  get descriptor(): PortDescriptor {
    if (this.adapterDescriptor === null) {
      throw new PortError(
        "unavailable",
        "remote port handshake has not completed",
        true,
      );
    }
    return this.adapterDescriptor;
  }

  get describedRemote(): PortDescriptor {
    if (this.remoteDescriptor === null) {
      throw new PortError(
        "unavailable",
        "remote port handshake has not completed",
        true,
      );
    }
    return this.remoteDescriptor;
  }

  async connect(): Promise<this> {
    if (this.closed) {
      throw new PortError(
        "unavailable",
        "remote port client is closed",
        false,
      );
    }
    if (this.remoteDescriptor !== null) return this;

    const raw = await this.call(
      "GET",
      remoteDescribePath(this.options.contract),
      undefined,
      this.handshakeTimeout,
    );
    const descriptor = validatePortDescriptor(raw);
    if (
      descriptor.kind !== this.options.kind ||
      descriptor.contract !== this.options.contract
    ) {
      throw new PortError(
        "contract_mismatch",
        `remote port does not implement ${this.options.contract}`,
        false,
      );
    }

    const adapterId =
      this.options.adapter_id ?? `kizuki.${this.options.kind}.remote`;
    this.remoteDescriptor = descriptor;
    this.adapterDescriptor = validatePortDescriptor({
      ...descriptor,
      id: adapterId,
      optional_package: null,
    });
    return this;
  }

  async invoke<T>(
    method: string,
    args: readonly unknown[],
  ): Promise<T> {
    if (this.remoteDescriptor === null) await this.connect();
    if (this.closed) {
      throw new PortError(
        "unavailable",
        "remote port client is closed",
        false,
      );
    }
    const timeout =
      this.remoteDescriptor?.method_timeouts_ms?.[method] ??
      this.defaultTimeout;
    return (await this.call(
      "POST",
      remoteMethodPath(this.options.contract, method),
      { args },
      timeout,
    )) as T;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async token(): Promise<string> {
    let token: string;
    try {
      token = await this.context.secrets(this.options.secret_ref);
    } catch (cause) {
      throw new PortError(
        "unavailable",
        "remote bearer secret is unavailable",
        false,
        { cause },
      );
    }
    if (
      token.length === 0 ||
      token.length > 4_096 ||
      /[\u0000-\u0020\u007f]/.test(token)
    ) {
      configError("resolved remote bearer secret is invalid");
    }
    return token;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<unknown> {
    const token = await this.token();
    const encodedBody =
      body === undefined
        ? undefined
        : JSON.stringify(encodeRemoteValue(body));
    if (
      encodedBody !== undefined &&
      Buffer.byteLength(encodedBody) > this.responseMaxBytes
    ) {
      configError("remote request exceeds its size limit");
    }
    const raw = await this.request(
      method,
      path,
      encodedBody,
      token,
      timeoutMs,
    );
    if (raw.status === 401) {
      throw new PortError(
        "unavailable",
        "remote port authentication failed",
        false,
      );
    }

    let decoded: unknown;
    try {
      decoded = decodeRemoteValue(JSON.parse(raw.body) as unknown);
    } catch (cause) {
      if (cause instanceof PortError) throw cause;
      throw new PortError(
        "unavailable",
        "remote port returned malformed JSON",
        true,
        { cause },
      );
    }
    if (!isPlainObject(decoded) || typeof decoded["ok"] !== "boolean") {
      throw new PortError(
        "unavailable",
        "remote port returned an invalid envelope",
        true,
      );
    }
    if (decoded["ok"] === true && "value" in decoded) {
      if (raw.status < 200 || raw.status >= 300) {
        throw new PortError(
          "unavailable",
          "remote port returned a success body with an error status",
          true,
        );
      }
      return decoded["value"];
    }
    const error = decoded["error"];
    if (
      decoded["ok"] !== false ||
      !isPlainObject(error) ||
      !isPortErrorCode(error["code"]) ||
      typeof error["retryable"] !== "boolean"
    ) {
      throw new PortError(
        "unavailable",
        "remote port returned an invalid error envelope",
        true,
      );
    }
    throw new PortError(
      error["code"],
      sanitizedRemoteMessage(error["code"], error["message"]),
      error["retryable"],
    );
  }

  private request(
    method: "GET" | "POST",
    path: string,
    body: string | undefined,
    token: string,
    timeoutMs: number,
  ): Promise<RawResponse> {
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      let timedOut = false;
      const finish = (
        outcome:
          | { ok: true; response: RawResponse }
          | { ok: false; error: PortError },
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (outcome.ok) resolvePromise(outcome.response);
        else rejectPromise(outcome.error);
      };

      const headers: Record<string, string | number> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      if (body !== undefined) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(body);
      }
      const requestOptions: RequestOptions =
        this.options.endpoint.transport === "unix"
          ? {
              socketPath: this.options.endpoint.socket_path,
              path,
              method,
              headers,
            }
          : {
              hostname: this.options.endpoint.host,
              port: this.options.endpoint.port,
              path,
              method,
              headers,
            };

      const request = httpRequest(requestOptions, (response) => {
        void readResponse(response, this.responseMaxBytes).then(
          (responseBody) =>
            finish({
              ok: true,
              response: {
                status: response.statusCode ?? 0,
                body: responseBody,
              },
            }),
          (cause) =>
            finish({
              ok: false,
              error:
                cause instanceof PortError
                  ? cause
                  : new PortError(
                      "unavailable",
                      "remote response could not be read",
                      true,
                      { cause },
                    ),
            }),
        );
      });
      const timer = setTimeout(() => {
        timedOut = true;
        request.destroy();
      }, timeoutMs);
      request.on("error", (cause) => {
        finish({
          ok: false,
          error: timedOut
            ? new PortError(
                "timeout",
                "remote port deadline exceeded",
                true,
                { cause },
              )
            : new PortError(
                "unavailable",
                "remote port is unavailable",
                true,
                { cause },
              ),
        });
      });
      if (body !== undefined) request.write(body);
      request.end();
    });
  }
}

export async function connectRemotePort(
  context: PortContext,
  options: RemotePortOptions,
): Promise<RemotePortClient> {
  return new RemotePortClient(context, options).connect();
}

function validIds(ids: readonly string[]): void {
  if (
    !Array.isArray(ids) ||
    ids.length > 10_000 ||
    !ids.every(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 1_024,
    )
  ) {
    configError("remote retrieval ids are invalid");
  }
}

export async function createRemoteRetrievalPort(
  context: PortContext,
  options: RemotePortOptions,
): Promise<RetrievalPort> {
  if (
    options.kind !== "retrieval" ||
    options.contract !== "kizuki.retrieval/v1"
  ) {
    throw new PortError(
      "contract_mismatch",
      "remote retrieval adapter requires kizuki.retrieval/v1",
      false,
    );
  }
  const client = await connectRemotePort(context, options);
  return {
    descriptor: client.descriptor,
    upsert: async (docs: readonly RetrievalDoc[]) => {
      const value = await client.invoke("upsert", [docs]);
      return validateRetrievalMutationReport(value);
    },
    search: async (query) => {
      validateRetrievalQuery(query);
      const value = await client.invoke("search", [query]);
      return validateRetrievalResult(value, query.limit);
    },
    remove: async (ids) => {
      validIds(ids);
      const value = await client.invoke("remove", [ids]);
      return validateRetrievalMutationReport(value);
    },
    verifyAbsent: async (ids) => {
      validIds(ids);
      const value = await client.invoke("verifyAbsent", [ids]);
      return validateAbsenceProof(value, ids);
    },
    neighbors: async (
      entity: EntityRef,
      graphOptions: GraphQueryOptions,
    ) => {
      const value = await client.invoke("neighbors", [
        entity,
        graphOptions,
      ]);
      return validateGraphResult(value);
    },
    health: async () => {
      const value = await client.invoke("health", []);
      if (
        !isPlainObject(value) ||
        (value["status"] !== "ready" &&
          value["status"] !== "degraded" &&
          value["status"] !== "unavailable")
      ) {
        throw new PortError(
          "unavailable",
          "remote port returned invalid health",
          true,
        );
      }
      return value as unknown as Awaited<
        ReturnType<RetrievalPort["health"]>
      >;
    },
    close: async () => client.close(),
  };
}
