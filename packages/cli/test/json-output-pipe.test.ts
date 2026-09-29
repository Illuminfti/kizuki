import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempDir, tempVault } = createHelpers();
afterEach(cleanup);

const MAIN = join(import.meta.dir, "../src/main.ts");

/** Three captured notes whose full text is far larger than a 64 KiB pipe buffer. */
function bigVault() {
  const setup = tempVault();
  for (const name of ["one", "two", "three"]) {
    writeFileSync(join(setup.notes, `${name}.md`), `zqxbig ${name} ${"filler word ".repeat(9000)}\n`);
  }
  const imported = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(imported.exitCode).toBe(0);
  return setup;
}

function childEnv(overrides: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

describe("machine output on a pipe", () => {
  test("a --json document larger than the pipe buffer arrives whole and matches the file", async () => {
    const setup = bigVault();
    const env = childEnv(setup.env);
    const args = ["query", "zqxbig", "--scope", "ledger", "--limit", "10", "--full-text", "--json"];

    const target = join(tempDir(), "redirected.json");
    const redirected = Bun.spawnSync([process.execPath, MAIN, ...args], { env, stdout: Bun.file(target), stderr: "pipe" });
    expect(redirected.exitCode).toBe(0);
    const fileBytes = readFileSync(target);
    expect(fileBytes.length).toBeGreaterThan(200_000);

    // A shell pipeline gives the child a kernel pipe on stdout, as `| jq` or a hook does.
    // The reader is slow on purpose so the writer meets a full pipe.
    const piped = Bun.spawn(
      ["sh", "-c", '"$0" "$@" | (sleep 1; cat)', process.execPath, MAIN, ...args],
      { env, stdout: "pipe", stderr: "pipe" },
    );
    const pipedBytes = Buffer.from(await new Response(piped.stdout).arrayBuffer());
    expect(await piped.exited).toBe(0);

    expect(pipedBytes.length).toBe(fileBytes.length);
    const parsed = JSON.parse(pipedBytes.toString("utf8")) as { data: { hits: unknown[] } };
    expect(parsed.data.hits).toHaveLength(3);
  });

  test("a reader that closes early ends the command quietly", () => {
    const setup = bigVault();
    const result = Bun.spawnSync(
      ["sh", "-c", '"$0" "$@" | head -c 100 >/dev/null;', process.execPath, MAIN, "query", "zqxbig", "--scope", "ledger", "--full-text", "--json"],
      { env: childEnv(setup.env), stdout: "pipe", stderr: "pipe" },
    );
    expect(result.stderr.toString()).not.toContain("EPIPE");
  });
});
