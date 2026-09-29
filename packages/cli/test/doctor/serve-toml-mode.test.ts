import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

test("doctor names the fix when serve.toml is group-writable", () => {
  const { env, vault } = tempVault();
  const serveToml = join(vault, ".kizuki", "serve.toml");
  writeFileSync(serveToml, "[budget]\ncanon_writes_per_run = 4\n");

  chmodSync(serveToml, 0o664);
  const loose = runCli(env, "doctor");
  expect(loose.exitCode).toBe(1);
  expect(loose.stdout).toContain("model configuration inspection unavailable");
  expect(loose.stdout).toContain("mode 664");
  expect(loose.stdout).toContain(`Run: chmod 600 ${serveToml}`);

  chmodSync(serveToml, 0o600);
  const tight = runCli(env, "doctor");
  expect(tight.stdout).not.toContain("model configuration inspection unavailable");
  expect(tight.stdout).not.toContain("chmod 600");
});
