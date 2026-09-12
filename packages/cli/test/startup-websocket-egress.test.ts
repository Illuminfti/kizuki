import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHelpers } from "./helpers";

const helpers = createHelpers();
afterEach(helpers.cleanup);

const PRELOAD = resolve(import.meta.dir, "fixtures/deny-websocket-preload.ts");
const WIDGET = resolve(import.meta.dir, "fixtures/startup-with-websocket.ts");
const MAIN = resolve(import.meta.dir, "../src/main.ts");

function attemptsOf(log: string): string[] {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function run(args: string[], preload: string): {
  exitCode: number;
  stdout: string;
  stderr: string;
  attempts: string[];
} {
  const env = helpers.isolatedEnv();
  const log = join(helpers.tempDir(), "websocket.log");
  const result = Bun.spawnSync([process.execPath, "--preload", preload, MAIN, ...args], {
    env: { ...process.env, ...env, KIZUKI_WEBSOCKET_LOG: log },
    timeout: 30_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    attempts: attemptsOf(log),
  };
}

test("CLI --help and version make no WebSocket during startup", () => {
  for (const args of [["--help"], ["version"]] as const) {
    const result = run([...args], PRELOAD);
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    expect(result.attempts).toEqual([]);
  }
});

test("an imported dependency that catches WebSocket still fails the egress proof", () => {
  const result = run(["version"], WIDGET);
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.attempts).toEqual(["ws://example.invalid"]);
});
