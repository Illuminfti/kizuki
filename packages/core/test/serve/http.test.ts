import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { startServeHttp } from "../../src/serve/http";
import { ServeDaemonError } from "../../src/serve/types";

const dirs: string[] = [];

afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("serve http", () => {
  test("refuses a non-loopback host", () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-http-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    expect(() =>
      startServeHttp({ db, vaultPath: vault, host: "0.0.0.0" }),
    ).toThrow(ServeDaemonError);
    db.close();
  });

  test("the standing endpoint requires a bearer token and stays on loopback", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-http-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const handle = startServeHttp({
      db,
      vaultPath: vault,
      host: "127.0.0.1",
      token: "test-token-not-a-secret-fixture",
    });
    expect(handle.host).toBe("127.0.0.1");
    const denied = await fetch(`${handle.url}/v1/mcp/system_health`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(denied.status).toBe(401);
    const health = await fetch(`${handle.url}/health`);
    expect(health.status).toBe(200);
    const allowed = await fetch(`${handle.url}/v1/mcp/system_health`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-not-a-secret-fixture",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(allowed.status).toBe(200);
    const body = (await allowed.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    const stored = readFileSync(handle.tokenPath, "utf8");
    expect(stored).toContain("test-token-not-a-secret-fixture");

    const refused = await fetch(`${handle.url}/v1/search`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-token-not-a-secret-fixture",
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: "" }),
    });
    expect(refused.status).toBe(400);
    const refusal = (await refused.json()) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(refusal.ok).toBe(false);
    expect(refusal.error.code).toBe("invalid_arguments");
    expect(refusal.error.message).toContain("query");

    await handle.stop();
    db.close();
  });
});

test("HTTP startup failure releases PID and writer lease for immediate restart", async () => {
  const { runServeDaemon, readServePid } = await import("../../src/serve/daemon");
  const directory = mkdtempSync(join(tmpdir(), "kizuki-http-startup-")); dirs.push(directory);
  initVault(directory); const db = openLedger(join(directory, ".kizuki/kizuki.db"));
  const occupied = startServeHttp({ db, vaultPath: directory, host: "127.0.0.1", port: 0 });
  try {
    await expect(runServeDaemon(db, directory, { once: true, rails: [], port: occupied.port })).rejects.toThrow();
    expect(readServePid(directory)).toBeNull();
    expect(db.query("SELECT * FROM leases").all()).toHaveLength(0);
    await expect(runServeDaemon(db, directory, { once: true, rails: [], http: false })).resolves.toMatchObject({ receipts: 0 });
  } finally { await occupied.stop(); db.close(); }
});
