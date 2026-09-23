import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers, fixtureConsent } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const { cleanup, runCli, runCliAsync, tempVault } = createHelpers();
afterEach(cleanup);

const HOLDER = join(import.meta.dir, "../../core/test/ledger-busy-child.ts");

interface Holder {
  release(): Promise<void>;
}

/** A second process holding the ledger write lock, as a serve rail batch does. */
async function holdWriteLock(vault: string, holdMs: number): Promise<Holder> {
  const child = Bun.spawn(
    [
      process.execPath,
      HOLDER,
      join(vault, ".kizuki", "kizuki.db"),
      String(holdMs),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let buffered = "";
  while (!buffered.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("write-lock holder ended before it held");
    buffered += new TextDecoder().decode(chunk.value);
  }
  expect(buffered.split("\n")[0]).toBe("held");
  reader.releaseLock();
  return {
    async release() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await child.exited;
    },
  };
}

test("import and query both complete while another writer holds the ledger", async () => {
  const setup = tempVault();
  const holder = await holdWriteLock(setup.vault, 1_500);
  try {
    const [imported, queried] = await Promise.all([
      runCliAsync(
        setup.env,
        "import",
        "markdown-folder",
        "--source",
        setup.notes,
        ...fixtureConsent(setup.root),
      ),
      runCliAsync(setup.env, "query", "kernel", "--degraded"),
    ]);
    expect(imported.stderr).not.toContain("database is locked");
    expect(queried.stderr).not.toContain("database is locked");
    expect(imported.exitCode).toBe(0);
    expect(queried.exitCode).toBe(0);
  } finally {
    await holder.release();
  }
}, 60_000);

test("a serve pass, an import and a query share one vault without a lock error", async () => {
  const setup = tempVault();
  const enrolled = runCli(
    setup.env,
    "import",
    "markdown-folder",
    "--source",
    setup.notes,
    ...fixtureConsent(setup.root),
  );
  expect(enrolled.exitCode).toBe(0);
  const [served, synced, queried] = await Promise.all([
    runCliAsync(setup.env, "serve", "--once", "--no-http"),
    runCliAsync(setup.env, "sync", "markdown-folder", "--source", setup.notes),
    runCliAsync(setup.env, "query", "kernel", "--degraded"),
  ]);
  for (const result of [served, synced, queried]) {
    expect(result.stderr).not.toContain("database is locked");
  }
  expect(served.exitCode).toBe(0);
  expect(synced.exitCode).toBe(0);
  expect(queried.exitCode).toBe(0);
}, 120_000);

test("a writer that outlives every retry is reported as a held lease, not a locked database", async () => {
  const setup = tempVault();
  // The daemon publishes this marker; the refusal names the process it finds.
  writeFileSync(
    join(setup.vault, ".kizuki", "serve.pid"),
    `${JSON.stringify({ pid: process.pid, boot_id: "boot-fixture", instance_id: "instance-fixture" })}\n`,
    { mode: 0o600 },
  );
  const holder = await holdWriteLock(setup.vault, 120_000);
  try {
    const result = await runCliAsync(
      setup.env,
      "import",
      "markdown-folder",
      "--source",
      setup.notes,
      ...fixtureConsent(setup.root),
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("database is locked");
    expect(result.stderr).toContain("lease_held");
    expect(result.stderr).toContain(
      `the kizuki serve daemon (pid ${process.pid})`,
    );
    expect(result.stderr).toContain("resumes from the last checkpoint");
  } finally {
    await holder.release();
  }
}, 180_000);
