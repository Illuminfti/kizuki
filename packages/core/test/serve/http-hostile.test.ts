import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initVault } from "../../src/vault/init";
import { openLedger } from "../../src/ledger/db";
import { startServeHttp } from "../../src/serve/http";

async function withHttp(run: (post: (body: string | Uint8Array) => Promise<Response>) => Promise<void>): Promise<void> {
  const vaultPath = mkdtempSync(join(tmpdir(), "kizuki-http-hostile-"));
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki/kizuki.db"));
  const server = startServeHttp({ db, vaultPath, token: "synthetic-http-token" });
  try {
    await run((body) => fetch(`${server.url}/v1/system_health`, {
      method: "POST", headers: { authorization: "Bearer synthetic-http-token" }, body: typeof body === "string" ? body : new Uint8Array(body),
    }));
  } finally {
    await server.stop();
    db.close();
    rmSync(vaultPath, { recursive: true, force: true });
  }
}

test("HTTP rejects non-object JSON instead of executing an empty call", async () => {
  await withHttp(async (post) => {
    for (const body of ['null', '[]', 'true', '0', '"text"', '{"args":null}', '{"args":[]}', '{"args":3}']) {
      const response = await post(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "config_invalid" } });
    }
    expect((await post('{}')).status).toBe(200);
    expect((await post('{"args":{}}')).status).toBe(200);
  });
});

test("HTTP refuses oversized JSON before dispatch", async () => {
  await withHttp(async (post) => {
    const response = await post(JSON.stringify({ padding: "x".repeat(128 * 1024) }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });
});

test("HTTP refuses malformed UTF-8 instead of replacement decoding", async () => {
  await withHttp(async (post) => {
    const response = await post(Buffer.concat([Buffer.from('{"padding":"'), Buffer.from([0xc0, 0xaf]), Buffer.from('"}') ]));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "config_invalid" } });
  });
});

test("HTTP bounds chunked bodies without a content-length header", async () => {
  const vaultPath = mkdtempSync(join(tmpdir(), "kizuki-http-chunks-"));
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki/kizuki.db"));
  const server = startServeHttp({ db, vaultPath, token: "synthetic-http-token" });
  try {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"padding":"'));
        for (let chunk = 0; chunk < 33; chunk += 1) controller.enqueue(Buffer.alloc(4096, 0x78));
        controller.enqueue(Buffer.from('"}')); controller.close();
      },
    });
    const response = await fetch(`${server.url}/v1/system_health`, {
      method: "POST", headers: { authorization: "Bearer synthetic-http-token" }, body,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ ok: false });
  } finally { await server.stop(); db.close(); rmSync(vaultPath, { recursive: true, force: true }); }
});

test("HTTP refuses deep JSON but ignores structural punctuation inside strings", async () => {
  await withHttp(async post => {
    expect((await post('{"padding":' + '['.repeat(65) + '0' + ']'.repeat(65) + '}')).status).toBe(400);
    expect((await post(JSON.stringify({ padding: '[{"brackets":"\\"}]'.repeat(100) }))).status).toBe(200);
  });
});
