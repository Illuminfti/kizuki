import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseFrontmatter } from "@kizuki/core";
import {
  defaultChatCompletion,
  startFakeEndpoint,
} from "../../llm/test/fake-endpoint";
import type { FakeEndpoint } from "../../llm/test/fake-endpoint";
import { createHelpers } from "./helpers";
import type { CliResult } from "./helpers";

/**
 * The end-to-end proof for #430 and #431: a markdown-folder import is the
 * only path that used to mint no canon at all (#431, empty subjects) and
 * would have minted a `person` page for every file once subjects existed
 * (#430, the hardcoded type). Both defects had to land together — fixing
 * only #431 would have made every imported note a person page, which is
 * worse than the prior silence. This proves the pair from the public CLI
 * seam a real user drives, not from the producer's own unit tests.
 */

const { cleanup, runCli, tempVault } = createHelpers();

const CLI_MAIN = resolve(import.meta.dir, "../src/main.ts");

/**
 * `serve --once` with a live model must be spawned with `Bun.spawn`, not
 * `Bun.spawnSync`: the latter blocks this test file's event loop, which the
 * in-process fake endpoint's `Bun.serve` handler needs in order to answer
 * the child's request (see packages/cli/test/serve/model-wiring.test.ts for
 * the empirical writeup of that deadlock).
 */
async function runCliLive(
  env: Record<string, string | undefined>,
  ...args: string[]
): Promise<CliResult> {
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "KIZUKI_CONFIG" &&
      key !== "KIZUKI_VAULT" &&
      key !== "XDG_CONFIG_HOME"
    ) {
      spawnEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) spawnEnv[key] = value;
  }
  const proc = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    env: spawnEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

let endpoint: FakeEndpoint | null = null;

afterEach(() => {
  endpoint?.stop();
  endpoint = null;
  cleanup();
});

const MODEL_KEY_ENV = "KIZUKI_TEST_MODEL_KEY";
const MODEL_KEY_VALUE = "not-a-real-key";

interface AuditRow {
  receipt_id: string;
  writer: string;
  page_path: string;
}

interface Envelope<T> {
  data: T;
}

function data<T>(stdout: string): T {
  return (JSON.parse(stdout) as Envelope<T>).data;
}

function auditRows(env: Record<string, string | undefined>): AuditRow[] {
  const listed = runCli(env, "audit", "--json");
  expect(listed.exitCode).toBe(0);
  return data<{ receipts: AuditRow[] }>(listed.stdout).receipts;
}

describe("a markdown-folder import reaches canon typed correctly", () => {
  // Spawns a real CLI process against a live loopback endpoint (see
  // runCliLive above); the default 5s bun test timeout is occasionally too
  // tight for that process-spawn overhead alone, independent of this test's
  // own assertions.
  test("mints an entity page for the file, not typed person", async () => {
    const setup = tempVault();
    writeFileSync(
      join(setup.notes, "field-log.md"),
      "Observed the kettle at noon.\n",
    );

    const imported = runCli(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
    );
    expect(imported.exitCode).toBe(0);

    // The model producer runs and returns no claims of its own: this proves
    // the deterministic entity proposal from ingest reaches canon on the
    // strength of the write pass alone, not anything the model contributed.
    endpoint = startFakeEndpoint(() =>
      defaultChatCompletion(JSON.stringify({ claims: [] })),
    );
    writeFileSync(
      join(setup.vault, ".kizuki", "serve.toml"),
      [
        "[ports.llm]",
        'id = "kizuki.llm.openai-compatible"',
        `base_url = ${JSON.stringify(endpoint.base_url)}`,
        'model = "test-model"',
        `secret_ref = "env:${MODEL_KEY_ENV}"`,
        "max_retries = 0",
        "",
      ].join("\n"),
    );
    const env = { ...setup.env, [MODEL_KEY_ENV]: MODEL_KEY_VALUE };

    const once = await runCliLive(env, "serve", "--once", "--no-http", "--json");
    expect(once.exitCode).toBe(0);

    // The connector's subject id is a sha256 digest of the file's relative
    // path (#431's resolution against main's independent documentSubject),
    // so the entity page it mints is keyed by that digest, not the filename.
    const digest = new Bun.CryptoHasher("sha256")
      .update("field-log.md")
      .digest("hex");
    const rows = auditRows(env);
    const entityWrite = rows.find((row) =>
      row.page_path.includes(digest),
    );
    expect(entityWrite).toBeDefined();
    if (entityWrite === undefined) return;

    const pagePath = join(setup.vault, entityWrite.page_path);
    expect(existsSync(pagePath)).toBe(true);
    const page = parseFrontmatter(readFileSync(pagePath, "utf8"));

    // #431: the file itself is a subject, stable and derived from its own
    // relative path rather than a lossy slug (a sha256 digest under
    // markdown-folder:, not the path itself — see #431's resolution against
    // main's independent documentSubject).
    expect(page.data["x-subject-id"]).toMatch(/^markdown-folder:[a-f0-9]{64}$/);
    // #430: an unrecognized subject namespace never mints a person page.
    // This is the one subject the file carries, so the deterministic capture
    // note that shares it binds onto the same page in this pass and its own
    // "source" frontmatter type is what the finished page carries — a
    // pre-existing merge behavior of the receipted writer (canon/apply.ts
    // prepareRevision), not something either fix in this lane touches. What
    // both fixes guarantee, and what this asserts, is that the type is never
    // the wrong-but-plausible "person" a hardcoded default would have forced.
    expect(page.data["type"]).not.toBe("person");
  }, 20_000);
});
