import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const h = createHelpers();
afterEach(h.cleanup);
const policy = { purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };

function disconnected() {
  const f = h.tempVault();
  const result = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(result.exitCode).toBe(0);
  const key = result.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const file = join(f.root, "policy.json");
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  const run = (action: string, ...args: string[]) => h.runCli(f.env, "connect", action, "--source", key, ...args, "--json");
  expect(run("grant", "--policy", file, "--expected-revision", "0", "--operation-id", "first-grant").exitCode).toBe(0);
  const db = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
  try { db.query("UPDATE connections SET disconnected_at='2026-02-01T00:00:00.000Z' WHERE source_key=?").run(key); }
  finally { db.close(); }
  return { ...f, key, file, run };
}

test("consent can be inspected, widened and revoked on a source that is no longer connected", () => {
  const f = disconnected();
  const status = f.run("status");
  expect(status.exitCode, status.stderr).toBe(0);
  expect(JSON.parse(status.stdout).data.grant.status).toBe("active");

  writeFileSync(f.file, JSON.stringify({ ...policy, purposes: [...policy.purposes, "export"] }));
  const widened = f.run("grant", "--policy", f.file, "--expected-revision", "1", "--operation-id", "widen-grant");
  expect(widened.exitCode, widened.stderr).toBe(0);
  expect(JSON.parse(widened.stdout).data.grant.policy.purposes).toContain("export");

  const revoked = f.run("revoke", "--expected-revision", "2", "--operation-id", "owner-revoke");
  expect(revoked.exitCode, revoked.stderr).toBe(0);
  expect(JSON.parse(revoked.stdout).data.purge).toBe("pending");
  const resumed = f.run("resume-revocation", "--operation-id", "owner-revoke");
  expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).data.purge).toBe("complete");
});

test("an unknown source is still refused, and an empty disconnected grant does not block the owner's backup", () => {
  const f = disconnected();
  const unknown = h.runCli(f.env, "connect", "status", "--source", "01ARZ3NDEKTSV4RRFFQ69G5FAV");
  expect(unknown.exitCode).toBe(1);
  expect(unknown.stderr).toContain("source_not_enrolled");
  const out = join(f.root, "backup");
  const exported = h.runCli(f.env, "export", "--out", out);
  expect(exported.exitCode, exported.stderr).toBe(0);
  expect(h.runCli(f.env, "restore", "--from", out, "--verify").exitCode).toBe(0);
});
