import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withVaultMutationAsync } from "../../core/src/vault/mutation-scope";
import { openLedger } from "@kizuki/core/testing";
import { seedUnkeyed } from "./fixtures/unkeyed-claim";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const h = createHelpers();
afterEach(h.cleanup);
const mainPath = resolve(import.meta.dir, "../src/main.ts");

interface Running {
  stderr: () => string;
  result: Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Streams stderr so the test can release the writer only after the command reported waiting. */
function start(env: Record<string, string | undefined>, ...args: string[]): Running {
  const spawnEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !["KIZUKI_CONFIG", "KIZUKI_VAULT", "XDG_CONFIG_HOME"].includes(key)) spawnEnv[key] = value;
  }
  for (const [key, value] of Object.entries(env)) if (value !== undefined) spawnEnv[key] = value;
  const child = Bun.spawn([process.execPath, mainPath, ...args], { env: spawnEnv, stdout: "pipe", stderr: "pipe" });
  let seen = "";
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stderr) seen += decoder.decode(chunk);
  })();
  return {
    stderr: () => seen,
    result: (async () => {
      const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited, drained]);
      return { exitCode, stdout, stderr: seen };
    })(),
  };
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Holds the canon writer until the command has said it is waiting, plus a beat, then lets go. */
async function holdWriterWhile(vault: string, running: Running, holdMs: number): Promise<number> {
  const started = Date.now();
  await withVaultMutationAsync({ vault_path: vault }, async () => {
    await until(() => running.stderr().includes("waiting up to"), "the command to report a busy writer");
    await Bun.sleep(holdMs);
  });
  return Date.now() - started;
}

function claimStatus(vault: string, claimId: string): string | undefined {
  const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
  try {
    return db.query<{ status: string }, [string]>("SELECT status FROM claims WHERE claim_id=?").get(claimId)?.status;
  } finally {
    db.close();
  }
}

describe("tell and undo wait for a busy canon writer", () => {
  test("a correction issued while the writer is held for 2 seconds lands and names the holder", async () => {
    const setup = h.tempVault();
    const { claimId, pagePath } = await seedUnkeyed(setup.vault);
    const running = start(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId);
    const held = await holdWriterWhile(setup.vault, running, 2_000);
    expect(held).toBeGreaterThanOrEqual(2_000);
    const result = await running.result;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(`canon writer is busy (held by process ${process.pid}); waiting up to 30s`);
    expect(result.stdout).toContain("Superseded 1 claim.");
    expect(readFileSync(join(setup.vault, pagePath), "utf8")).toContain("The compiler ships weekly.");
    expect(claimStatus(setup.vault, claimId)).toBe("superseded");
  });

  test("undo waits the same way", async () => {
    const setup = h.tempVault();
    const { claimId, pagePath } = await seedUnkeyed(setup.vault);
    const before = readFileSync(join(setup.vault, pagePath), "utf8");
    const told = h.runCli(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId, "--json");
    const receiptId = JSON.parse(told.stdout).data.receipt_id as string;
    const running = start(setup.env, "undo", receiptId);
    await holdWriterWhile(setup.vault, running, 1_500);
    const result = await running.result;
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain(`held by process ${process.pid}`);
    expect(readFileSync(join(setup.vault, pagePath), "utf8")).toBe(before);
    expect(claimStatus(setup.vault, claimId)).toBe("live");
  });

  test("the wait is bounded: a writer held past --wait is refused and the claim is untouched", async () => {
    const setup = h.tempVault();
    const { claimId } = await seedUnkeyed(setup.vault);
    const running = start(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId, "--wait", "1");
    await holdWriterWhile(setup.vault, running, 2_500);
    const result = await running.result;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("canon writer is still busy after 1s");
    expect(result.stderr).toContain(`held by process ${process.pid}`);
    expect(claimStatus(setup.vault, claimId)).toBe("live");
  });

  test("--wait 0 refuses at once and rejects a malformed value", async () => {
    const setup = h.tempVault();
    const { claimId } = await seedUnkeyed(setup.vault);
    let result: Awaited<Running["result"]> | undefined;
    await withVaultMutationAsync({ vault_path: setup.vault }, async () => {
      result = await start(setup.env, "tell", "The compiler ships weekly.", "--claim", claimId, "--wait", "0").result;
    });
    expect(result?.exitCode).toBe(1);
    expect(result?.stderr).toContain("writer_busy");
    expect(result?.stderr).not.toContain("waiting up to");
    const bad = h.runCli(setup.env, "tell", "x", "--claim", claimId, "--wait", "soon");
    expect(bad.exitCode).toBe(2);
  });
});
