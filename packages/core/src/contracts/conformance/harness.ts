import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  PortError,
  validatePortDescriptor,
} from "../ports";
import type {
  Port,
  PortContext,
  PortDescriptor,
  PortKind,
} from "../ports";

export const CONFORMANCE_FAMILIES = [
  "identity",
  "isolation",
  "idempotence",
  "failure_shape",
  "restart",
  "deletion",
] as const;
export type ConformanceFamily =
  (typeof CONFORMANCE_FAMILIES)[number];
export type ConformanceFamilyStatus = "pass" | "fail";

export interface ConformanceFixtures {
  readonly name?: string;
}

export interface ConformanceHarness<
  T extends Port,
  F extends ConformanceFixtures = ConformanceFixtures,
> {
  readonly descriptor: PortDescriptor;
  create(ctx: PortContext): Promise<T>;
  destroy(port: T): Promise<void>;
  readonly fixtures: F;
  /** Capability ids intentionally absent from descriptor.supports. */
  readonly skip?: readonly string[];
}

export interface ConformanceReport {
  readonly pass: boolean;
  readonly failures: string[];
  readonly families: Record<
    ConformanceFamily,
    ConformanceFamilyStatus
  >;
}

export interface ConformanceDeletionProof {
  readonly found: readonly string[];
}

export interface ConformanceDriver<
  T extends Port,
  F extends ConformanceFixtures,
> {
  apply(port: T, fixtures: F): Promise<unknown>;
  observe(port: T, fixtures: F): Promise<unknown>;
  induceFailure(port: T, fixtures: F): Promise<unknown>;
  remove(port: T, fixtures: F): Promise<unknown>;
  verifyAbsent(
    port: T,
    fixtures: F,
  ): Promise<ConformanceDeletionProof>;
}

export interface ContractConformanceDefinition {
  readonly kind: PortKind;
  readonly contract: string;
  readonly capabilities: readonly string[];
}

export interface ConformanceContext {
  readonly root: string;
  readonly ctx: PortContext;
  cleanup(): void;
}

const FIXED_CLOCK = "2026-01-01T00:00:00.000Z";
const SNAPSHOT_MAX_FILES = 10_000;
const SNAPSHOT_MAX_FILE_BYTES = 1_000_000;

export function conformanceContext(
  descriptor: PortDescriptor,
): ConformanceContext {
  const root = mkdtempSync(join(tmpdir(), "kizuki-conformance-"));
  const vaultPath = join(root, "vault");
  const dataDir = join(
    vaultPath,
    ".kizuki",
    descriptor.kind,
    descriptor.id,
  );
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    root,
    ctx: {
      vault_path: vaultPath,
      data_dir: dataDir,
      config: Object.freeze({}),
      secrets: async () => {
        throw new PortError(
          "unavailable",
          "conformance secret is unavailable",
          false,
        );
      },
      clock: () => FIXED_CLOCK,
      logger: () => {},
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function stable(value: unknown): string {
  const seen = new Set<object>();
  const normalize = (input: unknown): unknown => {
    if (input instanceof Float32Array) return [...input];
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      if (seen.has(input)) {
        throw new PortError(
          "config_invalid",
          "conformance observation contains a cycle",
          false,
        );
      }
      seen.add(input);
      const result = Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
      seen.delete(input);
      return result;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function snapshotOutside(root: string, dataDir: string): string {
  const absoluteRoot = resolve(root);
  const absoluteData = resolve(dataDir);
  const entries: [string, string][] = [];

  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const absolute = resolve(path);
      if (
        absolute === absoluteData ||
        relative(absoluteData, absolute).split(/[\\/]/)[0] !== ".."
      ) {
        continue;
      }
      if (
        !isAbsolute(absolute) ||
        relative(absoluteRoot, absolute).startsWith("..")
      ) {
        throw new PortError(
          "config_invalid",
          "conformance snapshot escaped its temporary root",
          false,
        );
      }
      const stat = lstatSync(path);
      const rel = relative(absoluteRoot, path);
      if (stat.isDirectory()) {
        entries.push([`${rel}/`, "directory"]);
        walk(path);
      } else if (stat.isSymbolicLink()) {
        entries.push([rel, `symlink:${readlinkSync(path)}`]);
      } else if (stat.isFile()) {
        if (stat.size > SNAPSHOT_MAX_FILE_BYTES) {
          throw new PortError(
            "config_invalid",
            "conformance snapshot file is too large",
            false,
          );
        }
        entries.push([
          rel,
          `file:${readFileSync(path).toString("base64")}`,
        ]);
      } else {
        entries.push([rel, "other"]);
      }
      if (entries.length > SNAPSHOT_MAX_FILES) {
        throw new PortError(
          "config_invalid",
          "conformance snapshot contains too many paths",
          false,
        );
      }
    }
  };

  walk(root);
  return JSON.stringify(entries);
}

function message(error: unknown): string {
  if (error instanceof PortError) return `${error.name}:${error.code}`;
  if (error instanceof Error) return error.name;
  return "unknown error";
}

async function withPort<T extends Port, R>(
  harness: ConformanceHarness<T, ConformanceFixtures>,
  run: (
    port: T,
    temporary: ConformanceContext,
  ) => Promise<R>,
): Promise<R> {
  const temporary = conformanceContext(harness.descriptor);
  let port: T | undefined;
  try {
    port = await harness.create(temporary.ctx);
    return await run(port, temporary);
  } finally {
    if (port !== undefined) await harness.destroy(port);
    temporary.cleanup();
  }
}

export async function runContractConformance<
  T extends Port,
  F extends ConformanceFixtures,
>(
  harness: ConformanceHarness<T, F>,
  definition: ContractConformanceDefinition,
  driver: ConformanceDriver<T, F>,
): Promise<ConformanceReport> {
  const failures: string[] = [];
  const families = Object.fromEntries(
    CONFORMANCE_FAMILIES.map((family) => [family, "pass"]),
  ) as Record<ConformanceFamily, ConformanceFamilyStatus>;

  const check = async (
    family: ConformanceFamily,
    operation: () => Promise<void>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      families[family] = "fail";
      failures.push(`${family}: ${message(error)}`);
    }
  };

  await check("identity", async () => {
    const expected = validatePortDescriptor(harness.descriptor);
    if (
      expected.kind !== definition.kind ||
      expected.contract !== definition.contract
    ) {
      throw new PortError(
        "contract_mismatch",
        "conformance descriptor does not match its contract",
        false,
      );
    }
    if (
      expected.supports.some(
        (capability) => !definition.capabilities.includes(capability),
      )
    ) {
      throw new PortError(
        "not_supported",
        "descriptor declares an unknown capability",
        false,
      );
    }
    if (
      harness.skip?.some(
        (capability) =>
          !definition.capabilities.includes(capability) ||
          expected.supports.includes(capability),
      )
    ) {
      throw new PortError(
        "config_invalid",
        "conformance skip must name an absent declared capability",
        false,
      );
    }

    const descriptors: string[] = [];
    for (let iteration = 0; iteration < 2; iteration += 1) {
      await withPort(
        harness as ConformanceHarness<T, ConformanceFixtures>,
        async (port) => {
          descriptors.push(stable(validatePortDescriptor(port.descriptor)));
        },
      );
    }
    if (
      descriptors.length !== 2 ||
      descriptors[0] !== descriptors[1] ||
      descriptors[0] !== stable(expected)
    ) {
      throw new PortError(
        "contract_mismatch",
        "port descriptor is not stable across instantiations",
        false,
      );
    }
  });

  await check("isolation", async () => {
    const temporary = conformanceContext(harness.descriptor);
    const before = snapshotOutside(temporary.root, temporary.ctx.data_dir);
    let port: T | undefined;
    try {
      port = await harness.create(temporary.ctx);
      await driver.apply(port, harness.fixtures);
      await port.health();
      const after = snapshotOutside(
        temporary.root,
        temporary.ctx.data_dir,
      );
      if (before !== after) {
        throw new PortError(
          "config_invalid",
          "port wrote outside ctx.data_dir",
          false,
        );
      }
    } finally {
      if (port !== undefined) await harness.destroy(port);
      temporary.cleanup();
    }
  });

  await check("idempotence", async () => {
    await withPort(
      harness as ConformanceHarness<T, ConformanceFixtures>,
      async (port) => {
        const firstReport = await driver.apply(port, harness.fixtures);
        const firstState = await driver.observe(port, harness.fixtures);
        const secondReport = await driver.apply(port, harness.fixtures);
        const secondState = await driver.observe(port, harness.fixtures);
        if (
          stable(firstReport) !== stable(secondReport) ||
          stable(firstState) !== stable(secondState)
        ) {
          throw new PortError(
            "config_invalid",
            "repeated input changed report or state",
            false,
          );
        }
      },
    );
  });

  await check("failure_shape", async () => {
    await withPort(
      harness as ConformanceHarness<T, ConformanceFixtures>,
      async (port) => {
        try {
          await driver.induceFailure(port, harness.fixtures);
        } catch (error) {
          if (error instanceof PortError) return;
          throw new PortError(
            "config_invalid",
            "induced failure did not throw PortError",
            false,
          );
        }
        throw new PortError(
          "config_invalid",
          "induced failure returned a value",
          false,
        );
      },
    );
  });

  await check("restart", async () => {
    const temporary = conformanceContext(harness.descriptor);
    let first: T | undefined;
    let second: T | undefined;
    try {
      first = await harness.create(temporary.ctx);
      await driver.apply(first, harness.fixtures);
      const before = await driver.observe(first, harness.fixtures);
      await harness.destroy(first);
      first = undefined;
      second = await harness.create(temporary.ctx);
      const after = await driver.observe(second, harness.fixtures);
      if (stable(before) !== stable(after)) {
        throw new PortError(
          "unavailable",
          "state did not survive a clean restart",
          false,
        );
      }
    } finally {
      if (first !== undefined) await harness.destroy(first);
      if (second !== undefined) await harness.destroy(second);
      temporary.cleanup();
    }
  });

  await check("deletion", async () => {
    await withPort(
      harness as ConformanceHarness<T, ConformanceFixtures>,
      async (port) => {
        await driver.apply(port, harness.fixtures);
        await driver.remove(port, harness.fixtures);
        const proof = await driver.verifyAbsent(port, harness.fixtures);
        if (!Array.isArray(proof.found) || proof.found.length !== 0) {
          throw new PortError(
            "unavailable",
            "deletion did not produce an absence proof",
            false,
          );
        }
      },
    );
  });

  return {
    pass: failures.length === 0,
    failures,
    families,
  };
}
