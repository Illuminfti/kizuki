import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LOCKFILE_REL = "bun.lock";
export const POLICY_REL = join("scripts", "dependency-policy.json");
export const SUPPORTED_LOCKFILE_VERSION = 1;
export const POLICY_SCHEMA = "kizuki.dependency-policy/v1";
export const FORBIDDEN_CAPABILITIES = [
  "telemetry",
  "crash-reporting",
  "automatic-update-checks",
] as const;

/** Same families as `phone_home_dependency_pattern` in verify.sh. */
export const PHONE_HOME_DEPENDENCY_PATTERN =
  '"(posthog|@sentry|sentry|@amplitude|mixpanel|segment|@datadog|newrelic|@newrelic|bugsnag|@bugsnag|rollbar|analytics-node|@vercel/analytics|@opentelemetry|telemetry)';

export class DependencyPolicyError extends Error {
  override readonly name = "DependencyPolicyError";
  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new DependencyPolicyError(message);
}

export function deniedDependencyName(name: string): boolean {
  return new RegExp(PHONE_HOME_DEPENDENCY_PATTERN).test(`"${name}"`);
}

export function resolvedPackageName(identity: string): string {
  const at = identity.lastIndexOf("@");
  if (at <= 0) return identity;
  return identity.slice(0, at);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function packageIntegrity(entry: unknown[]): string | undefined {
  const last = entry[3];
  return typeof last === "string" && last.length > 0 ? last : undefined;
}

export interface LockfilePackage {
  alias: string;
  identity: string;
  name: string;
  integrity: string | undefined;
}

export function inspectLockfileDependencies(text: string): {
  names: string[];
  denied: string[];
  packages: LockfilePackage[];
} {
  let parsed: unknown;
  try {
    parsed = Bun.JSON5.parse(text);
  } catch {
    fail("bun.lock is not valid JSON5");
  }
  if (!isPlainObject(parsed)) fail("bun.lock root must be an object");
  if (parsed["lockfileVersion"] !== SUPPORTED_LOCKFILE_VERSION) {
    fail(`unsupported bun.lock lockfileVersion ${String(parsed["lockfileVersion"])}`);
  }
  const packages = parsed["packages"];
  if (!isPlainObject(packages)) fail("bun.lock packages must be an object");
  const names: string[] = [];
  const denied: string[] = [];
  const resolved: LockfilePackage[] = [];
  for (const [alias, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length === 0) {
      fail(`bun.lock packages[${alias}] is not a resolved identity`);
    }
    const identity = entry[0];
    if (identity.includes("@workspace:")) continue;
    const name = resolvedPackageName(identity);
    names.push(name);
    const row = { alias, identity, name, integrity: packageIntegrity(entry) };
    resolved.push(row);
    if (deniedDependencyName(name)) denied.push(`${alias} -> ${identity}`);
  }
  return { names, denied, packages: resolved };
}

interface PolicyPackage {
  integrity: string;
  capabilities: string[];
}

export interface DependencyPolicy {
  schema: string;
  forbidden_capabilities: string[];
  packages: Record<string, PolicyPackage>;
}

export function inspectDependencyPolicy(text: string): DependencyPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    fail("dependency policy is not valid JSON");
  }
  if (!isPlainObject(parsed)) fail("dependency policy root must be an object");
  if (parsed["schema"] !== POLICY_SCHEMA) {
    fail(`unsupported dependency policy schema ${String(parsed["schema"])}`);
  }
  const forbidden = parsed["forbidden_capabilities"];
  if (!Array.isArray(forbidden) || !forbidden.every((item) => typeof item === "string")) {
    fail("dependency policy forbidden_capabilities must be a string array");
  }
  const packages = parsed["packages"];
  if (!isPlainObject(packages)) fail("dependency policy packages must be an object");
  const classified: Record<string, PolicyPackage> = {};
  for (const [identity, entry] of Object.entries(packages)) {
    if (!isPlainObject(entry) || typeof entry["integrity"] !== "string" || entry["integrity"].length === 0) {
      fail(`dependency policy packages[${identity}] is missing integrity`);
    }
    const capabilities = entry["capabilities"];
    if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === "string")) {
      fail(`dependency policy packages[${identity}] capabilities must be a string array`);
    }
    classified[identity] = { integrity: entry["integrity"], capabilities };
  }
  return {
    schema: POLICY_SCHEMA,
    forbidden_capabilities: forbidden,
    packages: classified,
  };
}

export function capabilityPolicyErrors(
  report: { packages: LockfilePackage[] },
  policy: DependencyPolicy,
): string[] {
  const forbidden = new Set([...FORBIDDEN_CAPABILITIES, ...policy.forbidden_capabilities]);
  const errors: string[] = [];
  for (const row of report.packages) {
    const entry = policy.packages[row.identity];
    if (entry === undefined) {
      errors.push(`unclassified ${row.alias} -> ${row.identity}`);
      continue;
    }
    if (row.integrity === undefined || row.integrity !== entry.integrity) {
      errors.push(`integrity mismatch ${row.alias} -> ${row.identity}`);
    }
    for (const capability of entry.capabilities) {
      if (forbidden.has(capability)) {
        errors.push(`forbidden capability ${capability} on ${row.alias} -> ${row.identity}`);
      }
    }
  }
  return errors;
}

export function verifyLockfileDependencies(root: string): string[] {
  const path = join(root, LOCKFILE_REL);
  if (!existsSync(path) || !lstatSync(path).isFile()) fail("missing bun.lock");
  const report = inspectLockfileDependencies(readFileSync(path, "utf8"));
  if (report.denied.length > 0) {
    fail(`denied lockfile dependencies:\n${report.denied.join("\n")}`);
  }
  const policyPath = join(root, POLICY_REL);
  if (!existsSync(policyPath) || !lstatSync(policyPath).isFile()) fail("missing scripts/dependency-policy.json");
  const errors = capabilityPolicyErrors(report, inspectDependencyPolicy(readFileSync(policyPath, "utf8")));
  if (errors.length > 0) fail(`dependency capability policy:\n${errors.join("\n")}`);
  return report.names;
}

function main(): void {
  try {
    const names = verifyLockfileDependencies(resolve(process.argv[2] ?? process.cwd()));
    console.log(`lockfile dependency policy passed (${names.length} resolved packages)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "lockfile dependency policy failed";
    console.error(`verification failed: ${message}`);
    process.exitCode = error instanceof DependencyPolicyError ? 1 : 2;
  }
}

if (import.meta.main) main();
