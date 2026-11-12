import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(120_000);

const h = createHelpers();
afterEach(h.cleanup);
const policy = { purposes: ["capture", "recall", "session", "derive"], allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked", egress: "local_only", sensitivity_floor: "private" };
const KEY = /source=([0-9A-HJKMNPQRSTVWXYZ]{26})/;

function connect(env: Record<string, string | undefined>, path: string): string {
  const result = h.runCli(env, "connect", "markdown-folder", "--source", path);
  expect(result.exitCode, result.stderr).toBe(0);
  return result.stdout.match(KEY)![1]!;
}

test("a purged source is paused quietly; a source never granted still asks for consent", () => {
  const f = h.tempVault();
  const file = join(f.root, "policy.json");
  writeFileSync(file, JSON.stringify(policy), { mode: 0o600 });
  const consent = (key: string, action: string, ...args: string[]) => {
    const result = h.runCli(f.env, "connect", action, "--source", key, ...args, "--json");
    expect(result.exitCode, result.stdout + result.stderr).toBe(0);
    return JSON.parse(result.stdout).data;
  };
  const purged = connect(f.env, f.notes);
  consent(purged, "grant", "--policy", file, "--expected-revision", "0", "--operation-id", "grant-purged");
  expect(h.runCli(f.env, "backfill", "markdown-folder", "--source", purged).exitCode).toBe(0);
  expect(consent(purged, "revoke", "--expected-revision", "1", "--operation-id", "revoke-purged").purge).toBe("pending");
  expect(consent(purged, "resume-revocation", "--operation-id", "revoke-purged").purge).toBe("complete");
  expect(consent(purged, "status").grant.status).toBe("purged");

  const kept = join(f.root, "kept");
  mkdirSync(kept);
  writeFileSync(join(kept, "kept.md"), "# Kept\n\nA note that stays.\n");
  const active = connect(f.env, kept);
  consent(active, "grant", "--policy", file, "--expected-revision", "0", "--operation-id", "grant-active");

  // Only the purged source: the sync pass has nothing to fail on.
  const clean = h.runCli(f.env, "serve", "run", "sync", "--json");
  expect(clean.exitCode, clean.stderr + clean.stdout).toBe(0);
  const receipt = JSON.parse(clean.stdout).data;
  expect(receipt.status).toBe("ok");
  expect(receipt.errors).toEqual([]);

  const doctor = h.runCli(f.env, "doctor");
  const line = doctor.stdout.split("\n").find(row => row.includes(`source=${purged}`))!;
  expect(line).toContain("state=paused");
  expect(line).toContain("health=disabled");
  expect(line).toContain(`consent purged; capture paused. To resume see: `);
  expect(line).toContain(`connect status --source ${purged}`);
  expect(doctor.stdout).toContain(`source=${active} `);

  // A source that never had consent is still the owner's to-do, reported as before.
  const fresh = join(f.root, "fresh");
  mkdirSync(fresh);
  writeFileSync(join(fresh, "fresh.md"), "# Fresh\n\nNot granted yet.\n");
  const ungranted = connect(f.env, fresh);
  const asked = JSON.parse(h.runCli(f.env, "serve", "run", "sync", "--json").stdout).data;
  expect(asked.status).toBe("degraded");
  // Receipts redact source keys; the one error is the ungranted source's.
  expect(ungranted).not.toBe(purged);
  expect(asked.errors).toHaveLength(1);
  expect(asked.errors[0]).toContain("consent-required:");
  expect(asked.errors[0]).toContain("--expected-revision 0");

  // Lookup by source still finds the paused source and says how to resume it.
  const explicit = h.runCli(f.env, "sync", "markdown-folder", "--source", purged);
  expect(explicit.exitCode).toBe(1);
  expect(explicit.stdout + explicit.stderr).toContain("source consent purged; capture paused");
  expect(explicit.stdout + explicit.stderr).toContain(`--expected-revision 3`);
});
