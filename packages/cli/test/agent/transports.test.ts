import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServeHttp } from "@kizuki/core";
import type { ServeHttpHandle } from "@kizuki/core";
import { createHelpers } from "../helpers";
import { onlyTokenLine, openVaultDb } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();

const MCP_BIN = join(import.meta.dir, "..", "..", "..", "mcp", "src", "bin.ts");

let handle: ServeHttpHandle | null = null;
afterEach(async () => {
  if (handle !== null) await handle.stop();
  handle = null;
  cleanup();
});

interface StdioRun {
  code: number;
  stdout: string;
  stderr: string;
}

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"kettle"}}}',
  "",
].join("\n");

async function runStdio(
  vaultPath: string,
  token: string,
): Promise<StdioRun> {
  const child = Bun.spawn(
    [process.execPath, MCP_BIN, "--vault", vaultPath, "--token-env", "KIZUKI_AGENT_TOKEN"],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, KIZUKI_AGENT_TOKEN: token },
    },
  );
  child.stdin.write(HANDSHAKE);
  child.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

async function callHttpSearch(
  url: string,
  token: string,
): Promise<Response> {
  return fetch(`${url}/v1/mcp/search`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query: "kettle" }),
  });
}

describe("5.4 a minted token works over both transports", () => {
  test("stdio tools/call and the HTTP search route both answer", async () => {
    const setup = tempVault();
    const added = runCli(setup.env, "agent", "add", "ada");
    expect(added.exitCode).toBe(0);
    const token = onlyTokenLine(added.stdout);

    const stdio = await runStdio(setup.vault, token);
    expect(stdio.code).toBe(0);
    const lines = stdio.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id?: number; result?: unknown; error?: unknown });
    const called = lines.find((line) => line.id === 2);
    expect(called?.error).toBeUndefined();
    expect(called?.result).toBeDefined();

    const db = openVaultDb(setup.vault);
    handle = startServeHttp({ db, vaultPath: setup.vault, host: "127.0.0.1" });
    const httpResponse = await callHttpSearch(handle.url, token);
    expect(httpResponse.status).toBe(200);
    const httpBody = (await httpResponse.json()) as { ok: boolean };
    expect(httpBody.ok).toBe(true);

    await handle.stop();
    handle = null;
    db.close();
  });
});

describe("5.5 revoke closes both transports", () => {
  test("a revoked token is refused by stdio and by HTTP", async () => {
    const setup = tempVault();
    const added = runCli(setup.env, "agent", "add", "ada");
    expect(added.exitCode).toBe(0);
    const token = onlyTokenLine(added.stdout);

    const db = openVaultDb(setup.vault);
    handle = startServeHttp({ db, vaultPath: setup.vault, host: "127.0.0.1" });
    const before = await callHttpSearch(handle.url, token);
    expect(before.status).toBe(200);

    const revoked = runCli(setup.env, "agent", "revoke", "ada");
    expect(revoked.exitCode).toBe(0);

    const afterHttp = await callHttpSearch(handle.url, token);
    expect(afterHttp.status).toBe(401);
    const afterBody = (await afterHttp.json()) as {
      ok: boolean;
      error: { code: string };
    };
    expect(afterBody.ok).toBe(false);
    expect(afterBody.error.code).toBe("unauthorized");

    await handle.stop();
    handle = null;
    db.close();

    const stdio = await runStdio(setup.vault, token);
    expect(stdio.code).not.toBe(0);
    expect(stdio.stderr).toContain("not recognized");
  });
});
