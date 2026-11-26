import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readBootId, startServeHttp } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { storedEvent } from "../../core/test/search/helpers";
import { refreshDerived } from "../src/derived";
import { liveReadDaemon } from "../src/commands/daemon-read";
import { createHelpers } from "./helpers";

const h = createHelpers();
afterEach(h.cleanup);

function publishEndpoint(control: string, server: { host: string; port: number }): void {
  const marker = { pid: process.pid, boot_id: readBootId(), instance_id: crypto.randomUUID() };
  writeFileSync(join(control, "serve.pid"), JSON.stringify(marker), { mode: 0o600 });
  writeFileSync(join(control, "serve.endpoint"), JSON.stringify({
    schema: "kizuki.serve-endpoint/v1", host: server.host, port: server.port, instance_id: marker.instance_id,
  }), { mode: 0o600 });
}

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
    publishEndpoint(control, server);
    const env = { ...f.env, http_proxy: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", no_proxy: "", NO_PROXY: "" };
    const call = (...args: string[]) => h.runCliAsync(env, ...args, "--json");
    const ok = await call("serve", "health");
    expect(ok.exitCode, ok.stderr).toBe(0);
    expect(JSON.parse(ok.stdout).data.tool).toBe("system_health");

    const reader = liveReadDaemon({ env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false,
      stderrIsTTY: false, out() {}, err() {}, prompt: async () => "" })!;
    const saved = { no_proxy: process.env.no_proxy, NO_PROXY: process.env.NO_PROXY };
    try {
      delete process.env.no_proxy;
      process.env.NO_PROXY = "example.invalid";
      expect((await reader.health()).tool).toBe("system_health");
      expect(process.env.no_proxy).toBeUndefined();
      expect(process.env.NO_PROXY).toBe("example.invalid");
    } finally {
      for (const name of ["no_proxy", "NO_PROXY"] as const) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    }

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

test("proxied full-text search preserves complete ledger hits beyond eight MiB", async () => {
  const { vault, env } = h.tempVault();
  const control = join(vault, ".kizuki");
  const db = openLedger(join(control, "kizuki.db"));
  const server = startServeHttp({ db, vaultPath: vault });
  try {
    const text = "saffron ".padEnd(960_000, ".") + " end";
    for (let i = 0; i < 9; i++) storedEvent(db, `full-text-${i}`, { text });
    refreshDerived(db, vault);
    publishEndpoint(control, server);
    const result = await h.runCliAsync(env, "query", "saffron", "--scope", "ledger", "--full-text", "--limit", "9", "--json");
    expect(result.exitCode, result.stderr).toBe(0);
    const hits: { snippet: string }[] = JSON.parse(result.stdout).data.hits;
    expect(hits).toHaveLength(9);
    expect(hits.every(hit => hit.snippet === text)).toBe(true);
  } finally { await server.stop(); db.close(); }
}, 30_000);
