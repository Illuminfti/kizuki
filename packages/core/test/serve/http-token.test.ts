import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { sameToken, startServeHttp } from "../../src/serve/http";
import { initVault } from "../../src/vault/init";

const dirs: string[] = [];
afterEach(() => { for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("serve token comparison", () => {
  test("matches only the exact token, whatever the length or shared prefix", () => {
    const minted = "fixture-token-0123456789abcdef";
    expect(sameToken(minted, minted)).toBe(true);
    expect(sameToken(minted.slice(0, -1) + "0", minted)).toBe(false);
    expect(sameToken(minted.slice(0, 8), minted)).toBe(false);
    expect(sameToken(minted + "x", minted)).toBe(false);
    expect(sameToken("", minted)).toBe(false);
    expect(sameToken(minted, "")).toBe(false);
  });

  test("the standing endpoint serves the exact token and refuses near misses", async () => {
    const directory = mkdtempSync(join(tmpdir(), "kizuki-http-token-"));
    dirs.push(directory);
    const vault = join(directory, "vault");
    initVault(vault);
    const db = openLedger(join(vault, ".kizuki", "kizuki.db"));
    const token = "fixture-token-0123456789abcdef";
    const handle = startServeHttp({ db, vaultPath: vault, host: "127.0.0.1", token });
    try {
      const status = async (bearer: string) => (await fetch(`${handle.url}/v1/mcp/system_health`, {
        method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: "{}",
      })).status;
      expect(await status(token)).toBe(200);
      for (const wrong of [token.slice(0, -1) + "0", token.slice(0, 10), token + "0", "x"]) expect(await status(wrong)).toBe(401);
    } finally { await handle.stop(); db.close(); }
  });
});
