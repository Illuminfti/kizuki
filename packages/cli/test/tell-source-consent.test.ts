import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { applyCanonWrite, createBudgetTracker, getClaim, resolveTarget } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers } from "./helpers";

// These tests spawn real CLI processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const h = createHelpers();
afterEach(h.cleanup);

const base = {
  purposes: ["capture", "recall", "session", "derive"],
  allowed_fields: ["text", "subjects", "attachments", "metadata"],
  retention: "persistent_owned_until_revoked",
  egress: "local_only",
  sensitivity_floor: "private",
};

/** A source imported under a grant that lacks `correction`, the state the docs example used to produce. */
function importedWithoutCorrection() {
  const f = h.tempVault();
  const file = join(f.root, "policy.json");
  writeFileSync(file, JSON.stringify(base), { mode: 0o600 });
  const imported = h.runCli(f.env, "import", "markdown-folder", "--source", f.notes, "--policy", file, "--expected-revision", "0", "--operation-id", "import-grant");
  expect(imported.exitCode, imported.stderr).toBe(0);
  const doctor = JSON.parse(h.runCli(f.env, "doctor", "--json").stdout).data;
  const key = doctor.corrections_refused[0].source_key as string;
  const claimId = doctor.live_claims[0].claim_id as string;
  return { ...f, file, key, claimId };
}

describe("correction consent", () => {
  test("doctor and tell honor withdrawn derive consent on a managed claim", () => {
    const f = importedWithoutCorrection();
    writeFileSync(f.file, JSON.stringify({ ...base, purposes: [...base.purposes, "correction", "audit"] }));
    expect(h.runCli(f.env, "connect", "grant", "--source", f.key, "--policy", f.file, "--expected-revision", "1", "--operation-id", "allow-correction").exitCode).toBe(0);
    const db = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
    let pagePath: string;
    try {
      const claim = getClaim(db, f.claimId);
      if (claim === null) throw new Error("synthetic claim is missing");
      const io = { db, vault_path: f.vault };
      pagePath = applyCanonWrite(io, claim, resolveTarget(io, claim), {
        writer: "loop", budget: createBudgetTracker({ canon_writes_per_run: 1 }),
      }).page_path;
    } finally { db.close(); }
    const corrected = h.runCli(f.env, "tell", "That reading is wrong.", "--claim", f.claimId, "--json");
    expect(corrected.exitCode, corrected.stderr).toBe(0);
    const result = JSON.parse(corrected.stdout).data;
    expect(result.rewritten.map((page: { page_path: string }) => page.page_path)).toEqual([pagePath]);
    const liveId = result.claim_ids[0];
    const before = readFileSync(join(f.vault, pagePath), "utf8");
    writeFileSync(f.file, JSON.stringify({ ...base, purposes: ["capture", "recall", "session", "correction", "audit"] }));
    expect(h.runCli(f.env, "connect", "grant", "--source", f.key, "--policy", f.file, "--expected-revision", "2", "--operation-id", "withdraw-derive").exitCode).toBe(0);
    const doctor = h.runCli(f.env, "doctor");
    expect(doctor.stdout).toContain(`source=${f.key} corrections: refused (grant lacks derive)`);
    expect(doctor.stdout.split("\n").find(line => line.startsWith("next:"))).not.toContain("kizuki tell");
    const report = JSON.parse(h.runCli(f.env, "doctor", "--json").stdout).data;
    expect(report.live_claims.every((claim: { correctable: boolean }) => !claim.correctable)).toBe(true);
    const told = h.runCli(f.env, "tell", "The reading has changed again.", "--claim", liveId);
    expect(told.exitCode).toBe(1);
    expect(told.stderr).toContain(`source ${f.key} does not permit derive`);
    expect(told.stderr).toContain(`kizuki connect grant --source ${f.key} --policy POLICY.json --expected-revision 3 --operation-id OPERATION`);
    expect(readFileSync(join(f.vault, pagePath), "utf8")).toBe(before);
  });

  test("a refused tell names the missing purpose and the exact grant command", () => {
    const f = importedWithoutCorrection();
    const told = h.runCli(f.env, "tell", "That reading is wrong.", "--claim", f.claimId);
    expect(told.exitCode).toBe(1);
    expect(told.stdout).toBe("");
    expect(told.stderr).toContain("source_access_denied");
    expect(told.stderr).toContain(`source ${f.key} does not permit correction`);
    expect(told.stderr).toContain(`kizuki connect grant --source ${f.key} --policy POLICY.json --expected-revision 1 --operation-id OPERATION`);
    const rehearsal = h.runCli(f.env, "tell", "That reading is wrong.", "--claim", f.claimId, "--dry-run");
    expect(rehearsal.exitCode).toBe(1);
    expect(rehearsal.stderr).toContain(`kizuki connect grant --source ${f.key}`);
  });

  test("doctor prints the refusal per source and does not suggest tell", () => {
    const f = importedWithoutCorrection();
    const human = h.runCli(f.env, "doctor");
    expect(human.stdout).toContain(`source=${f.key} corrections: refused (grant lacks correction)`);
    const next = human.stdout.split("\n").filter((line) => line.startsWith("next:"));
    expect(next).toHaveLength(1);
    expect(next[0]).not.toContain("kizuki tell");
    expect(next[0]).toContain(`kizuki connect grant --source ${f.key}`);
    expect(next[0]).toContain("--expected-revision 1");
    const json = JSON.parse(h.runCli(f.env, "doctor", "--json").stdout).data;
    expect(json.corrections_refused).toEqual([{ source_key: f.key, revision: 1 }]);
    expect(json.live_claims.every((claim: { correctable: boolean }) => !claim.correctable)).toBe(true);
  });

  test("following the message lets tell succeed and doctor suggests tell again", () => {
    const f = importedWithoutCorrection();
    writeFileSync(f.file, JSON.stringify({ ...base, purposes: [...base.purposes, "correction", "audit"] }));
    const granted = h.runCli(f.env, "connect", "grant", "--source", f.key, "--policy", f.file, "--expected-revision", "1", "--operation-id", "add-correction");
    expect(granted.exitCode, granted.stderr).toBe(0);
    const human = h.runCli(f.env, "doctor");
    expect(human.stdout).not.toContain("corrections: refused");
    expect(human.stdout).toContain(`next: kizuki tell "<statement>" --claim ${f.claimId}`);
    const told = h.runCli(f.env, "tell", "That reading is wrong.", "--claim", f.claimId);
    expect(told.stderr).toBe("");
    expect(told.exitCode).toBe(0);
    expect(told.stdout).toContain("Superseded 1 claim.");
  });

  test("the documented example policies carry correction and audit", () => {
    const root = resolve(import.meta.dir, "../../..");
    const policies = (path: string): { purposes: string[] }[] =>
      [...readFileSync(join(root, path), "utf8").matchAll(/```json\n([\s\S]*?)```|(\{"purposes"[^\n]*\})/g)]
        .map((match) => JSON.parse((match[1] ?? match[2])!) as { purposes?: string[] })
        .filter((policy): policy is { purposes: string[] } => Array.isArray(policy.purposes));
    for (const path of ["docs/cli.md", "docs/connect.md", "README.md"]) {
      const found = policies(path);
      expect(found.length, path).toBeGreaterThan(0);
      for (const policy of found) {
        expect(policy.purposes, path).toContain("correction");
        expect(policy.purposes, path).toContain("audit");
      }
    }
  });
});
