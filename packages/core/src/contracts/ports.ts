import type { SecretResolver } from "./connector";
import { isPlainObject } from "../util/validate";

export const PORT_KINDS = [
  "retrieval",
  "embedding",
  "llm",
  "producer",
  "connector",
  "notifier",
  "ledger-store",
  "canon-store",
  "journal-store",
  "surface",
] as const;
export type PortKind = (typeof PORT_KINDS)[number];

export const PORT_CONTRACTS = Object.freeze({
  retrieval: "kizuki.retrieval/v1",
  embedding: "kizuki.embedding/v1",
  llm: "kizuki.llm/v1",
  producer: "kizuki.producer/v1",
  connector: "kizuki.connector/v1",
  notifier: "kizuki.notifier/v1",
  "ledger-store": "kizuki.ledger-store/v1",
  "canon-store": "kizuki.canon-store/v1",
  "journal-store": "kizuki.journal-store/v1",
  surface: "kizuki.surface/v1",
} as const satisfies Readonly<Record<PortKind, string>>);

export const PORT_ERROR_CODES = [
  "unavailable",
  "contract_mismatch",
  "config_invalid",
  "lease_required",
  "budget_exhausted",
  "not_supported",
  "space_mismatch",
  "timeout",
] as const;
export type PortErrorCode = (typeof PORT_ERROR_CODES)[number];

export interface PortDescriptor {
  readonly id: string;
  readonly kind: PortKind;
  readonly contract: string;
  readonly contract_minor: number;
  readonly supports: readonly string[];
  readonly requires_lease: boolean;
  readonly optional_package: string | null;
  /**
   * Additive descriptor metadata used by the loopback adapter. A missing
   * method uses the adapter's bounded default.
   */
  readonly method_timeouts_ms?: Readonly<Record<string, number>>;
}

export interface PortLogLine {
  readonly level: "debug" | "info" | "warn" | "error";
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PortContext {
  readonly vault_path: string;
  /** The port's only writable area. */
  readonly data_dir: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secrets: SecretResolver;
  readonly clock: () => string;
  /** A trusted host binds this callback to stderr, never stdout. */
  readonly logger: (line: PortLogLine) => void;
}

export type PortHealth =
  | { status: "ready"; detail: Record<string, unknown> }
  | {
      status: "degraded";
      degraded: string[];
      detail: Record<string, unknown>;
    }
  | { status: "unavailable"; reason: string };

export interface Port {
  readonly descriptor: PortDescriptor;
  health(): Promise<PortHealth>;
  close(): Promise<void>;
}

export type PortFactory<T> = (ctx: PortContext) => T;

export class PortError extends Error {
  override readonly name = "PortError";

  constructor(
    readonly code: PortErrorCode,
    message: string,
    readonly retryable: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const REVERSE_DNS_ID =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?){2,}$/;
const CONTRACT = /^[a-z0-9]+(?:[.-][a-z0-9]+)*\/v[1-9][0-9]*$/;
const MAX_SUPPORTS = 64;
const MAX_TIMEOUT_MS = 300_000;

function invalidDescriptor(field: string): never {
  throw new PortError(
    "config_invalid",
    `port descriptor ${field} is invalid`,
    false,
  );
}

export function isPortKind(value: unknown): value is PortKind {
  return (
    typeof value === "string" &&
    (PORT_KINDS as readonly string[]).includes(value)
  );
}

export function isPortErrorCode(value: unknown): value is PortErrorCode {
  return (
    typeof value === "string" &&
    (PORT_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Validates descriptors received from registrations and remote handshakes.
 * The returned copy is deeply frozen at every mutable descriptor field.
 */
export function validatePortDescriptor(value: unknown): PortDescriptor {
  if (!isPlainObject(value)) invalidDescriptor("value");
  if (
    typeof value["id"] !== "string" ||
    !REVERSE_DNS_ID.test(value["id"])
  ) {
    invalidDescriptor("id");
  }
  if (!isPortKind(value["kind"])) invalidDescriptor("kind");
  if (
    typeof value["contract"] !== "string" ||
    !CONTRACT.test(value["contract"])
  ) {
    invalidDescriptor("contract");
  }

  const kind = value["kind"] as PortKind;
  const contract = value["contract"] as string;
  const family = PORT_CONTRACTS[kind].replace(/[0-9]+$/, "");
  if (!contract.startsWith(family)) invalidDescriptor("contract");

  if (
    typeof value["contract_minor"] !== "number" ||
    !Number.isSafeInteger(value["contract_minor"]) ||
    value["contract_minor"] < 0
  ) {
    invalidDescriptor("contract_minor");
  }
  if (
    !Array.isArray(value["supports"]) ||
    value["supports"].length > MAX_SUPPORTS ||
    !value["supports"].every(
      (capability) =>
        typeof capability === "string" &&
        capability.length > 0 &&
        capability.length <= 128,
    ) ||
    new Set(value["supports"]).size !== value["supports"].length
  ) {
    invalidDescriptor("supports");
  }
  if (typeof value["requires_lease"] !== "boolean") {
    invalidDescriptor("requires_lease");
  }
  if (
    value["optional_package"] !== null &&
    (typeof value["optional_package"] !== "string" ||
      value["optional_package"].length === 0)
  ) {
    invalidDescriptor("optional_package");
  }

  let methodTimeouts: Readonly<Record<string, number>> | undefined;
  const rawTimeouts = value["method_timeouts_ms"];
  if (rawTimeouts !== undefined) {
    if (!isPlainObject(rawTimeouts)) {
      invalidDescriptor("method_timeouts_ms");
    }
    const entries = Object.entries(rawTimeouts);
    if (
      entries.length > 128 ||
      entries.some(
        ([method, timeout]) =>
          method.length === 0 ||
          method.length > 128 ||
          typeof timeout !== "number" ||
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > MAX_TIMEOUT_MS,
      )
    ) {
      invalidDescriptor("method_timeouts_ms");
    }
    methodTimeouts = Object.freeze(Object.fromEntries(entries)) as Readonly<
      Record<string, number>
    >;
  }

  return Object.freeze({
    id: value["id"] as string,
    kind,
    contract,
    contract_minor: value["contract_minor"] as number,
    supports: Object.freeze([...(value["supports"] as string[])]),
    requires_lease: value["requires_lease"] as boolean,
    optional_package: value["optional_package"] as string | null,
    ...(methodTimeouts === undefined
      ? {}
      : { method_timeouts_ms: methodTimeouts }),
  });
}

/** Enforces the compiled major before a factory can perform I/O. */
export function assertPortContract(
  descriptor: PortDescriptor,
  kind: PortKind,
): void {
  if (
    descriptor.kind !== kind ||
    descriptor.contract !== PORT_CONTRACTS[kind]
  ) {
    throw new PortError(
      "contract_mismatch",
      `port ${descriptor.id} does not implement ${PORT_CONTRACTS[kind]}`,
      false,
    );
  }
}

export function requirePortCapability(
  descriptor: PortDescriptor,
  capability: string,
): void {
  if (!descriptor.supports.includes(capability)) {
    throw new PortError(
      "not_supported",
      `port ${descriptor.id} does not declare capability ${capability}`,
      false,
    );
  }
}
