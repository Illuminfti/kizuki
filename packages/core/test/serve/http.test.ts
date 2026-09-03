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
    await handle.stop();
    db.close();
  });
});
