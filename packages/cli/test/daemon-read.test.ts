import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readBootId, startServeHttp } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);

test("an offline health check uses the ledger and leaves the retrieval store unopened", () => {
  const f = h.tempVault();
  writeFileSync(join(f.vault, ".kizuki/serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n');
  const read = h.runCli(f.env, "serve", "health", "--json");
  expect(read.exitCode, read.stderr).toBe(0);
  expect(JSON.parse(read.stdout).data.data.events).toBe(0);
  expect(existsSync(join(f.vault, ".kizuki/retrieval/kizuki.retrieval.embedded-pg/store"))).toBe(false);
  expect(h.runCli(f.env, "serve", "health", "--once").exitCode).toBe(2);
});

test("daemon reads bypass ambient proxies and refuse stale or unsafe credentials without replay", async () => {
  const f = h.tempVault();
  const control = join(f.vault, ".kizuki");
  const db = openLedger(join(control, "kizuki.db"));
  const server = startServeHttp({ db, vaultPath: f.vault });
  try {
    const marker = { pid: process.pid, boot_id: readBootId(), instance_id: crypto.randomUUID() };
    writeFileSync(join(control, "serve.pid"), JSON.stringify(marker), { mode: 0o600 });
    writeFileSync(join(control, "serve.endpoint"), JSON.stringify({
      schema: "kizuki.serve-endpoint/v1", host: server.host, port: server.port, instance_id: marker.instance_id,
    }), { mode: 0o600 });
    const env = { ...f.env, http_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", no_proxy: "", NO_PROXY: "" };
    const call = (...args: string[]) => h.runCliAsync(env, ...args, "--json");
    const ok = await call("serve", "health");
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).data.tool).toBe("system_health");

    writeFileSync(server.tokenPath, `kzs_${randomBytes(32).toString("base64url")}`, { mode: 0o600 });
    for (const args of [["query", "needle"], ["world", "--operation", "find_concepts"], ["memt", "recall", "needle"], ["serve", "health"]]) {
      const denied = await call(...args);
      expect(denied.exitCode, args.join(" ")).toBe(1);
      expect(denied.stdout).toBe("");
      expect(denied.stderr).toContain("authorization refused");
    }
    chmodSync(server.tokenPath, 0o644);
    expect((await call("serve", "health")).exitCode).toBe(1);
    unlinkSync(server.tokenPath);
    symlinkSync(join(control, "vault-id"), server.tokenPath);
    const unsafe = await call("serve", "health");
    expect(unsafe.exitCode).toBe(1);
    expect(unsafe.stderr).not.toContain(readFileSync(join(control, "vault-id"), "utf8").trim());
  } finally { await server.stop(); db.close(); }
}, 30_000);
