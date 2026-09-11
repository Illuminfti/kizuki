import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LOCKFILE_REL = "bun.lock";
export const SUPPORTED_LOCKFILE_VERSION = 1;

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

export function inspectLockfileDependencies(text: string): {
  names: string[];
  denied: string[];
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
  for (const [alias, entry] of Object.entries(packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length === 0) {
      fail(`bun.lock packages[${alias}] is not a resolved identity`);
    }
    const identity = entry[0];
    if (identity.includes("@workspace:")) continue;
    const name = resolvedPackageName(identity);
    names.push(name);
    if (deniedDependencyName(name)) denied.push(`${alias} -> ${identity}`);
  }
  return { names, denied };
}

export function verifyLockfileDependencies(root: string): string[] {
  const path = join(root, LOCKFILE_REL);
  if (!existsSync(path) || !lstatSync(path).isFile()) fail("missing bun.lock");
  const report = inspectLockfileDependencies(readFileSync(path, "utf8"));
  if (report.denied.length > 0) {
    fail(`denied lockfile dependencies:\n${report.denied.join("\n")}`);
  }
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
