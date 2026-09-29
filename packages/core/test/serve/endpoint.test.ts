import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openLedger } from "../../src/ledger/db";
import { initVault } from "../../src/vault/init";
import { readServeProcessMarker, runServeDaemon } from "../../src/serve/daemon";
import { clearServeEndpoint, readServeEndpoint, writeServeEndpoint } from "../../src/serve/endpoint";
import { SERVE_ENDPOINT_PATH } from "../../src/serve/types";

setDefaultTimeout(30_000);

const fixtures: { vault: string; db: Database }[] = [];
function fixture() {
  const vault = mkdtempSync(join(tmpdir(), "kizuki-endpoint-"));
  initVault(vault);
  const db = openLedger(join(vault, ".kizuki/kizuki.db"));
  fixtures.push({ vault, db });
  return { vault, db };
}
afterEach(() => {
  for (const { vault, db } of fixtures.splice(0)) {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  }
});

const INSTANCE = "11111111-1111-4111-8111-111111111111";
const marker = (over: Partial<{ pid: number; instance_id: string }> = {}) => ({
  pid: process.pid,
  boot_id: "boot",
  instance_id: INSTANCE,
  ...over,
});

test("an endpoint is served only while its own daemon instance is alive", () => {
  const f = fixture();
  writeServeEndpoint(f.vault, { host: "127.0.0.1", port: 4242, instance_id: INSTANCE });
  expect(readServeEndpoint(f.vault, marker())).toEqual({ host: "127.0.0.1", port: 4242, url: "http://127.0.0.1:4242" });
  expect(readServeEndpoint(f.vault, null)).toBeNull();
  expect(readServeEndpoint(f.vault, marker({ instance_id: "22222222-2222-4222-8222-222222222222" }))).toBeNull();
  expect(readServeEndpoint(f.vault, marker({ pid: 2 ** 22 - 1 }))).toBeNull();
  clearServeEndpoint(f.vault);
  expect(readServeEndpoint(f.vault, marker())).toBeNull();
});

test("an IPv6 loopback endpoint is a bracketed origin", () => {
  const f = fixture();
  writeServeEndpoint(f.vault, { host: "::1", port: 9, instance_id: INSTANCE });
  expect(readServeEndpoint(f.vault, marker())?.url).toBe("http://[::1]:9");
});

test.each([
  ["a non-loopback host", { schema: "kizuki.serve-endpoint/v1", host: "192.0.2.1", port: 80, instance_id: INSTANCE }],
  ["a port out of range", { schema: "kizuki.serve-endpoint/v1", host: "127.0.0.1", port: 70_000, instance_id: INSTANCE }],
  ["an unknown schema", { schema: "other", host: "127.0.0.1", port: 80, instance_id: INSTANCE }],
  ["an extra field", { schema: "kizuki.serve-endpoint/v1", host: "127.0.0.1", port: 80, instance_id: INSTANCE, token: "x" }],
])("%s is not an endpoint", (_label, value) => {
  const f = fixture();
  writeFileSync(join(f.vault, SERVE_ENDPOINT_PATH), JSON.stringify(value));
  expect(readServeEndpoint(f.vault, marker())).toBeNull();
});

test("a malformed or oversized file is not an endpoint", () => {
  const f = fixture();
  for (const text of ["", "not json", "[]", "x".repeat(4_096)]) {
    writeFileSync(join(f.vault, SERVE_ENDPOINT_PATH), text);
    expect(readServeEndpoint(f.vault, marker())).toBeNull();
  }
});

test("the daemon announces its loopback port for its lifetime and holds no credential in it", async () => {
  const f = fixture();
  f.db.query("UPDATE schedules SET enabled=0 WHERE rail <> 'sync'").run();
  let announced: ReturnType<typeof readServeEndpoint> = null;
  let raw = "";
  await runServeDaemon(f.db, f.vault, {
    once: true,
    rails: ["sync"],
    acquireRuntime: async () => ({
      hooks: {
        sync: async () => {
          announced = readServeEndpoint(f.vault, readServeProcessMarker(f.vault));
          raw = readFileSync(join(f.vault, SERVE_ENDPOINT_PATH), "utf8");
          return { events_synced: 0, events_stored: 0, events_duplicate: 0, events_self_skipped: 0, errors: [] };
        },
      },
      close: async () => {},
    }),
  });
  expect(announced).not.toBeNull();
  const token = readFileSync(join(f.vault, ".kizuki/serve.token"), "utf8").trim();
  expect(raw).not.toContain(token);
  expect(existsSync(join(f.vault, SERVE_ENDPOINT_PATH))).toBe(false);
});
