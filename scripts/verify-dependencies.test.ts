import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DependencyPolicyError,
  inspectLockfileDependencies,
  verifyLockfileDependencies,
} from "./verify-dependencies";

const dirs: string[] = [];
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function lockfile(packages: string, version = 1): string {
  return `{
  "lockfileVersion": ${version},
  "workspaces": { "": { "name": "fixture", "dependencies": {} } },
  "packages": {
${packages}
  },
}
`;
}

function tree(contents: string) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-deps-"));
  dirs.push(root);
  mkdirSync(join(root, "packages"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{"name":"fixture","private":true}\n');
  writeFileSync(join(root, "bun.lock"), contents);
  return root;
}

test("permitted and workspace packages pass", () => {
  const root = tree(
    lockfile(`
    "typescript": ["typescript@5.9.0", "", {}, "sha512-abc="],
    "@kizuki/core": ["@kizuki/core@workspace:packages/core"],
`),
  );
  expect(verifyLockfileDependencies(root)).toEqual(["typescript"]);
});

test("a denied package only in the resolved transitive set fails", () => {
  const root = tree(
    lockfile(`
    "typescript": ["typescript@5.9.0", "", {}, "sha512-abc="],
    "@sentry/node": ["@sentry/node@7.120.0", "", {}, "sha512-abc="],
`),
  );
  expect(() => verifyLockfileDependencies(root)).toThrow(DependencyPolicyError);
  try {
    verifyLockfileDependencies(root);
  } catch (error) {
    expect((error as Error).message).toContain("@sentry/node");
  }
});

test("an alias whose resolved identity is denied fails", () => {
  const report = inspectLockfileDependencies(
    lockfile(`
    "harmless": ["@sentry/node@7.120.0", "", {}, "sha512-abc="],
`),
  );
  expect(report.denied).toEqual(["harmless -> @sentry/node@7.120.0"]);
});

test("malformed lockfiles and unsupported versions fail", () => {
  expect(() => inspectLockfileDependencies("{")).toThrow(/not valid JSON5/);
  expect(() => inspectLockfileDependencies('{"lockfileVersion":1,"packages":[]}\n')).toThrow(
    /packages must be an object/,
  );
  expect(() => inspectLockfileDependencies(lockfile(`"typescript": ["typescript@5.9.0"]`, 2))).toThrow(
    /unsupported bun.lock lockfileVersion 2/,
  );
});

test("a missing bun.lock fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "kizuki-deps-missing-"));
  dirs.push(root);
  expect(() => verifyLockfileDependencies(root)).toThrow(/missing bun.lock/);
});

test("the live bun.lock has no denied resolved packages", () => {
  const names = verifyLockfileDependencies(process.cwd());
  expect(names.length).toBeGreaterThan(0);
});
