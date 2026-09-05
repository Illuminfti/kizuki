import { afterEach, expect, test } from "bun:test";
import { writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

// Temporary diagnostics for the CI-only native erasure failure; remove after repair.
const h = createHelpers({ preload: join(import.meta.dir, "owned-retrieval-diagnostics-preload.ts") });
afterEach(h.cleanup);
const policy = { purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };
function enrolled() {
  const f = h.tempVault();
  const result = h.runCli(f.env, "connect", "markdown-folder", "--source", f.notes);
  expect(result.exitCode).toBe(0);
  const key = result.stdout.match(/source=([0-9A-HJKMNPQRSTVWXYZ]{26})/)![1]!;
  const file = join(f.root, "policy.json");
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  return { ...f, key, file };
}
function command(f: ReturnType<typeof enrolled>, action: string, ...args: string[]) {
  return h.runCli(f.env, "connect", action, "--source", f.key, ...args, "--json");
}

test("owner grants explicit policy, retries original intent across processes, and revokes before resuming", () => {
  const f = enrolled();
  const before = command(f, "status");
  expect(before.exitCode).toBe(0);
  expect(JSON.parse(before.stdout).data.grant).toBeNull();
  const denied = h.runCli(f.env, "backfill", "markdown-folder");
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("source_capture_denied");
  const args = ["--policy", f.file, "--expected-revision", "0", "--operation-id", "owner-grant-1"];
  const granted = command(f, "grant", ...args);
  expect(granted.exitCode).toBe(0);
  expect(JSON.parse(granted.stdout).data.receipt.revision).toBe(1);
  expect(JSON.parse(command(f, "grant", ...args).stdout).data.receipt).toEqual(JSON.parse(granted.stdout).data.receipt);
  writeFileSync(f.file, JSON.stringify({ ...policy, purposes: [...policy.purposes, "export"] }));
  expect(command(f, "grant", ...args).stderr).toContain("operation_conflict");
  expect(command(f, "grant", "--policy", f.file, "--expected-revision", "0", "--operation-id", "stale-grant").stderr).toContain("revision_conflict");
  expect(h.runCli(f.env, "backfill", "markdown-folder").exitCode).toBe(0);
  expect(h.runCli(f.env, "query", "acme").stdout).toContain("ada met grace");
  expect(h.runCli(f.env, "export", "--out", join(f.root, "denied-export")).stderr).toContain("source_export_denied");
  expect(command(f, "grant", "--policy", f.file, "--expected-revision", "1", "--operation-id", "export-grant").exitCode).toBe(0);
  expect(h.runCli(f.env, "export", "--out", join(f.root, "allowed-export")).exitCode).toBe(0);
  const revoked = command(f, "revoke", "--expected-revision", "2", "--operation-id", "owner-revoke");
  expect(revoked.exitCode).toBe(0);
  expect(JSON.parse(revoked.stdout).data.purge).toBe("pending");
  expect(h.runCli(f.env, "query", "acme").stdout).not.toContain("ada met grace");
  expect(h.runCli(f.env, "backfill", "markdown-folder").exitCode).toBe(1);
  expect(command(f, "resume-revocation", "--operation-id", "wrong-operation").exitCode).not.toBe(0);
  const resumed = command(f, "resume-revocation", "--operation-id", "owner-revoke");
  expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).data.purge).toBe("complete");
  expect(JSON.parse(resumed.stdout).data.grant.purge_blockers).toEqual([]);
  expect(command(f, "resume-revocation", "--operation-id", "owner-revoke").exitCode).toBe(0);
  expect(h.runCli(f.env, "export", "--out", join(f.root, "purged-export")).exitCode).toBe(0);
}, 15_000);

test("import can receive explicit consent before content capture", () => {
  const f = h.tempVault();
  const denied = h.runCli(f.env, "import", "markdown-folder", "--source", f.notes);
  expect(denied.exitCode).toBe(1);
  expect(denied.stderr).toContain("connect grant --source");
  const file = join(f.root, "policy.json");
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  const result = h.runCli(f.env, "import", "markdown-folder", "--source", f.notes, "--policy", file, "--expected-revision", "0", "--operation-id", "import-grant");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("events_stored=3");
});

test("policy input refuses symlinks, oversized files, unknown secrets and incomplete arguments", () => {
  const f = enrolled();
  const link = join(f.root, "link.json"); symlinkSync(f.file, link);
  const grant = (file: string) => command(f, "grant", "--policy", file, "--expected-revision", "0", "--operation-id", "input-grant");
  expect(grant(link).stderr).toContain("source_policy_file_unsafe");
  writeFileSync(f.file, "x".repeat(16_385));
  expect(grant(f.file).stderr).toContain("source_policy_file_unsafe");
  writeFileSync(f.file, JSON.stringify({ ...policy, secret: "synthetic-secret-never-print" }));
  const secret = grant(f.file);
  expect(secret.exitCode).not.toBe(0);
  expect(secret.stderr).not.toContain("synthetic-secret-never-print");
  expect(command(f, "grant", "--policy", f.file).exitCode).toBe(2);
  expect(JSON.parse(command(f, "status").stdout).data.grant).toBeNull();
});

test("an empty enrolled source can complete revocation idempotently", () => {
  const f = enrolled();
  expect(command(f, "grant", "--policy", f.file, "--expected-revision", "0", "--operation-id", "empty-grant").exitCode).toBe(0);
  expect(command(f, "revoke", "--expected-revision", "1", "--operation-id", "empty-revoke").exitCode).toBe(0);
  const result = command(f, "resume-revocation", "--operation-id", "empty-revoke");
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(JSON.parse(result.stdout).data.purge).toBe("complete");
  expect(command(f, "resume-revocation", "--operation-id", "empty-revoke").exitCode).toBe(0);
});

test("a busy local retrieval writer cannot prevent grant inspection or immediate denial", async () => {
  const { openConfiguredRetrieval } = await import("../src/retrieval-runtime");
  const f = enrolled();
  writeFileSync(join(f.vault, ".kizuki", "serve.toml"), '[ports]\nretrieval="kizuki.retrieval.embedded-pg"\n');
  const held = await openConfiguredRetrieval(f.vault);
  try {
    expect(command(f, "grant", "--policy", f.file, "--expected-revision", "0", "--operation-id", "busy-grant").exitCode).toBe(0);
    expect(command(f, "status").exitCode).toBe(0);
    expect(h.runCli(f.env, "connect", "status", "--json").exitCode).toBe(0);
    expect(command(f, "revoke", "--expected-revision", "1", "--operation-id", "busy-revoke").exitCode).toBe(0);
    const pending = command(f, "resume-revocation", "--operation-id", "busy-revoke");
    expect(pending.exitCode).toBe(1);
    expect(JSON.parse(pending.stdout).data.purge).toBe("pending");
    expect(JSON.parse(pending.stdout).data.grant.owned_retrieval).toContainEqual({ store_id: "local:kizuki.retrieval.embedded-pg", status: "pending" });
    expect(JSON.parse(command(f, "status").stdout).data.grant.status).toBe("denied");
    expect((await held!.health()).status).toBe("ready");
  } finally { await held?.close(); }
  const resumed = command(f, "resume-revocation", "--operation-id", "busy-revoke");
  expect(resumed.exitCode, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).data.purge).toBe("complete");
}, 30_000);

test("populated fields outside the explicit policy refuse capture without publishing evidence", () => {
  const f = enrolled();
  writeFileSync(f.file, JSON.stringify({ ...policy, allowed_fields: ["subjects", "attachments", "metadata"] }));
  // Core owns exact policy admissibility and record-field enforcement.
  const grant = command(f, "grant", "--policy", f.file, "--expected-revision", "0", "--operation-id", "field-grant");
  expect(grant.exitCode).toBe(0);
  const captured = h.runCli(f.env, "backfill", "markdown-folder");
  expect(captured.exitCode).toBe(1);
  expect(captured.stdout).toContain("events_stored=0");
  expect(h.runCli(f.env, "query", "acme").stdout).not.toContain("ada met grace");
});


test("owner consent refuses mutable policy files and directory paths before committing a grant", () => {
  const f = enrolled();
  const grant = () => command(f, "grant", "--policy", f.file, "--expected-revision", "0", "--operation-id", "custody-grant");
  for (const mode of [0o666, 0o620, 0o602]) {
    chmodSync(f.file, mode);
    const refused = grant();
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain("source_policy_file_unsafe");
    expect(JSON.parse(command(f, "status").stdout).data.grant).toBeNull();
  }
  chmodSync(f.file, 0o644);
  try {
    for (const mode of [0o777, 0o770, 0o707]) {
      chmodSync(f.root, mode);
      expect(grant().stderr).toContain("source_policy_file_unsafe");
    }
  } finally { chmodSync(f.root, 0o700); }
  // The private fixture is beneath the normal root-owned sticky /tmp directory.
  expect(grant().exitCode).toBe(0);
});


test("POSIX custody metadata distinguishes owner policy, trusted root sticky paths and untrusted UIDs", async () => {
  const { policyDirectoryCustody, policyFileCustody } = await import("../src/source-consent");
  // Synthetic stat coverage is explicit; it does not assert host filesystem custody.
  const directory = (uid: number, mode: number, real = true) => ({ uid, mode, isDirectory: () => real });
  expect(policyDirectoryCustody(directory(0, 0o1777), 1000)).toBe(true);
  expect(policyDirectoryCustody(directory(0, 0o755), 1000)).toBe(true);
  expect(policyDirectoryCustody(directory(1000, 0o700), 1000)).toBe(true);
  for (const uid of [1001, 65534]) {
    expect(policyDirectoryCustody(directory(uid, 0o700), 1000)).toBe(false);
    expect(policyDirectoryCustody(directory(uid, 0o1777), 1000)).toBe(false);
    expect(policyFileCustody({ uid, mode: 0o600 }, 1000)).toBe(false);
  }
  expect(policyDirectoryCustody(directory(1000, 0o1777), 1000)).toBe(false);
  expect(policyDirectoryCustody(directory(0, 0o777), 1000)).toBe(false);
  expect(policyDirectoryCustody(directory(1000, 0o700, false), 1000)).toBe(false);
  for (const mode of [0o600, 0o644]) expect(policyFileCustody({ uid: 1000, mode }, 1000)).toBe(true);
  for (const mode of [0o666, 0o620, 0o602]) expect(policyFileCustody({ uid: 1000, mode }, 1000)).toBe(false);
  expect(policyFileCustody({ uid: 0, mode: 0o600 }, 1000)).toBe(false);
});
