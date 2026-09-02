import { isAbsolute, join, normalize, resolve } from "node:path";
import { isPlainObject } from "../util/validate";
import {
  assertPortContract,
  PortError,
  validatePortDescriptor,
} from "./ports";
import type {
  PortContext,
  PortDescriptor,
  PortFactory,
  PortKind,
} from "./ports";

export type PortSelection = string | readonly string[];
export type PortsConfig = Readonly<
  Partial<Record<PortKind, PortSelection>>
>;

export interface PortRegistration<T> {
  readonly d: PortDescriptor;
  readonly factory: PortFactory<T>;
}

interface StoredRegistration {
  readonly d: PortDescriptor;
  readonly factory: PortFactory<unknown>;
}

function key(kind: PortKind, id: string): string {
  return `${kind}\u0000${id}`;
}

function validateContext(
  kind: PortKind,
  id: string,
  context: PortContext,
): PortContext {
  if (
    typeof context.vault_path !== "string" ||
    context.vault_path.length === 0 ||
    !isAbsolute(context.vault_path)
  ) {
    throw new PortError(
      "config_invalid",
      "port context vault_path must be absolute",
      false,
    );
  }
  if (
    typeof context.data_dir !== "string" ||
    context.data_dir.length === 0 ||
    !isAbsolute(context.data_dir)
  ) {
    throw new PortError(
      "config_invalid",
      "port context data_dir must be absolute",
      false,
    );
  }

  const expected = normalize(
    join(resolve(context.vault_path), ".kizuki", kind, id),
  );
  if (normalize(resolve(context.data_dir)) !== expected) {
    throw new PortError(
      "config_invalid",
      `port ${id} data_dir does not match its isolated registry path`,
      false,
    );
  }
  if (
    !isPlainObject(context.config) ||
    typeof context.secrets !== "function" ||
    typeof context.clock !== "function" ||
    typeof context.logger !== "function"
  ) {
    throw new PortError("config_invalid", "port context is invalid", false);
  }

  return Object.freeze({
    vault_path: resolve(context.vault_path),
    data_dir: expected,
    config: Object.freeze({ ...context.config }),
    secrets: context.secrets,
    clock: context.clock,
    logger: context.logger,
  });
}

export class PortRegistry {
  private readonly registrations = new Map<string, StoredRegistration>();

  registerPort<T>(
    descriptor: PortDescriptor,
    factory: PortFactory<T>,
  ): void {
    const validated = validatePortDescriptor(descriptor);
    if (typeof factory !== "function") {
      throw new PortError(
        "config_invalid",
        "port factory must be a function",
        false,
      );
    }
    const registrationKey = key(validated.kind, validated.id);
    if (this.registrations.has(registrationKey)) {
      throw new PortError(
        "config_invalid",
        `port ${validated.id} is already registered`,
        false,
      );
    }
    this.registrations.set(registrationKey, {
      d: validated,
      factory: factory as PortFactory<unknown>,
    });
  }

  resolvePort<T>(kind: PortKind, id: string): PortRegistration<T> {
    const registration = this.registrations.get(key(kind, id));
    if (registration === undefined) {
      throw new PortError(
        "unavailable",
        `configured ${kind} port is not registered`,
        false,
      );
    }
    return registration as PortRegistration<T>;
  }

  listPorts(kind: PortKind): PortDescriptor[] {
    return [...this.registrations.values()]
      .map(({ d }) => d)
      .filter((descriptor) => descriptor.kind === kind)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  bindFromConfig<T>(
    kind: PortKind,
    config: PortsConfig,
    context: PortContext,
  ): { port: T; d: PortDescriptor } {
    const selected = config[kind];
    if (typeof selected !== "string" || selected.length === 0) {
      throw new PortError(
        "config_invalid",
        `ports.${kind} must select exactly one registered id`,
        false,
      );
    }

    const registration = this.resolvePort<T>(kind, selected);
    assertPortContract(registration.d, kind);
    const validatedContext = validateContext(kind, selected, context);
    return {
      port: registration.factory(validatedContext),
      d: registration.d,
    };
  }

  bindManyFromConfig<T>(
    kind: PortKind,
    config: PortsConfig,
    contextFor: (id: string) => PortContext,
  ): { port: T; d: PortDescriptor }[] {
    const selected = config[kind];
    if (!Array.isArray(selected)) {
      throw new PortError(
        "config_invalid",
        `ports.${kind} must be a list of registered ids`,
        false,
      );
    }
    if (
      !selected.every(
        (id) => typeof id === "string" && id.length > 0,
      ) ||
      new Set(selected).size !== selected.length
    ) {
      throw new PortError(
        "config_invalid",
        `ports.${kind} contains an invalid or duplicate id`,
        false,
      );
    }

    return selected.map((id) => {
      const registration = this.resolvePort<T>(kind, id);
      assertPortContract(registration.d, kind);
      return {
        port: registration.factory(
          validateContext(kind, id, contextFor(id)),
        ),
        d: registration.d,
      };
    });
  }
}

const defaultRegistry = new PortRegistry();

export function registerPort<T>(
  descriptor: PortDescriptor,
  factory: PortFactory<T>,
): void {
  defaultRegistry.registerPort(descriptor, factory);
}

export function resolvePort<T>(
  kind: PortKind,
  id: string,
): PortRegistration<T> {
  return defaultRegistry.resolvePort(kind, id);
}

export function listPorts(kind: PortKind): PortDescriptor[] {
  return defaultRegistry.listPorts(kind);
}

export function bindFromConfig<T>(
  kind: PortKind,
  config: PortsConfig,
  context: PortContext,
): { port: T; d: PortDescriptor } {
  return defaultRegistry.bindFromConfig(kind, config, context);
}

export function bindManyFromConfig<T>(
  kind: PortKind,
  config: PortsConfig,
  contextFor: (id: string) => PortContext,
): { port: T; d: PortDescriptor }[] {
  return defaultRegistry.bindManyFromConfig(kind, config, contextFor);
}
