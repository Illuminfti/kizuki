import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

const helpers = createHelpers();
afterEach(() => helpers.cleanup());

for (const port of ["123abc", "1.5", "1e3", "0x10", " 80", "80 ", "+80", "-1", "", "65536", "9007199254740993"]) {
  test(`serve refuses an invalid port ${JSON.stringify(port)}`, () => {
    const f = helpers.tempVault();
    const result = helpers.runCli(f.env, "serve", "--once", "--no-http", `--port=${port}`, "--vault", f.vault);
    expect(result.exitCode, result.stderr).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: kizuki serve");
    expect(existsSync(join(f.vault, ".kizuki/serve.pid"))).toBe(false);
  });
}

for (const port of ["0", "1", "65535"]) {
  test(`serve accepts decimal port boundary ${port} with HTTP disabled`, () => {
    const f = helpers.tempVault();
    const result = helpers.runCli(f.env, "serve", "--once", "--no-http", "--json", "--port", port, "--vault", f.vault);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).data.http).toBeNull();
  });
}

test("serve port zero binds an ephemeral loopback port", () => {
  const f = helpers.tempVault();
  const result = helpers.runCli(f.env, "serve", "--once", "--json", "--port", "0", "--vault", f.vault);
  expect(result.exitCode, result.stderr).toBe(0);
  const http = JSON.parse(result.stdout).data.http;
  expect(http.host).toBe("127.0.0.1");
  expect(http.port).toBeGreaterThan(0);
  expect(http.port).toBeLessThanOrEqual(65535);
});
