import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openOwnedDirectory } from "@kizuki/core";
import { WriterLease } from "../src/lease";

test("maintenance preserves legacy live and fresh guards without changing diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "maintenance-lease-"));
  mkdirSync(join(root, "lease/held"), { recursive: true });
  writeFileSync(join(root, "lease/writer.lock"), "");
  writeFileSync(join(root, "lease/receipts.jsonl"), "UNCHANGED_DIAGNOSTIC\n");
  const cap = openOwnedDirectory(root);
  const now = Date.now(); const at = (ms: number) => new Date(ms).toISOString();
  const lease = new WriterLease(root, { clock: () => at(now) });
  const holderPath = join(root, "lease/held/holder.json");
  const holder = { pid: process.pid, holder_id: "synthetic", acquired_at: at(now - 60_000), heartbeat_at: at(now - 60_000) };
  try {
    writeFileSync(holderPath, JSON.stringify(holder));
    expect(() => lease.acquireMaintenance(cap)).toThrow("live legacy owner");
    const fresh = { ...holder, ownership_token: "00000000-0000-4000-8000-000000000001", heartbeat_at: at(now) };
    writeFileSync(holderPath, JSON.stringify(fresh));
    expect(() => lease.acquireMaintenance(cap)).toThrow("heartbeat is still fresh");
    const stale = JSON.stringify({ ...fresh, heartbeat_at: at(now - 60_000) }); writeFileSync(holderPath, stale);
    const release = lease.acquireMaintenance(cap);
    expect(() => new WriterLease(root).acquireMaintenance(cap)).toThrow("writer lease is held");
    release(); release();
    expect(readFileSync(holderPath, "utf8")).toBe(stale);
    expect(readFileSync(join(root, "lease/receipts.jsonl"), "utf8")).toBe("UNCHANGED_DIAGNOSTIC\n");
    writeFileSync(holderPath, "PRIVATE_MALFORMED_SYNTHETIC");
    expect(() => lease.acquireMaintenance(cap)).toThrow("writer maintenance ownership could not be verified");
  } finally { cap.close(); rmSync(root, { recursive: true, force: true }); }
});
