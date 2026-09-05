import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";
const { cleanup, tempDir, isolatedEnv, runCli } = createHelpers();
afterEach(cleanup);
const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
function setup(revoked = false) {
  const dir = tempDir();
  const source = join(dir, "slice.json"); const authorization = join(dir, "authorization.json");
  const body = "Synthetic secret-shaped content remains source evidence.";
  const slice = JSON.stringify({ schema: "kizuki.estate-slice/v1", sources: [{ source_id: "private-source-id", consent_generation: 1, records: [{
    record_id: "private-record-id", domain: "memory", text: body, occurred_at: "2020-01-01T00:00:00Z", observed_at: "2020-01-02T00:00:00Z",
    valid_from: null, valid_to: null, asserted_at: null, authority: "connector_evidence", sensitivity: "private",
    subjects: [], aliases: [], correction_of: null, supersedes: [], attachments: [], provenance: { sha256: hash(body), line_start: 1, line_end: 1 }, state: null, value: null,
  }] }] });
  writeFileSync(source, slice);
  writeFileSync(authorization, JSON.stringify({ schema: "kizuki.estate-authorization/v1", source_sha256: hash(slice), source_ids: ["private-source-id"], generation: 1,
    revoked, purpose: "estate-import", retention: "persistent_owned_copy", egress: "local_only", sensitivity_floor: "private", allowed_fields: ["text", "times", "authority", "provenance"] }));
  return { dir, source, authorization, slice, env: isolatedEnv() };
}
test("public dry-run produces only a report and changes no input or vault", () => {
  const s = setup(); const before = readdirSync(s.dir);
  const args = ["import", "estate-slice", "--source", s.source, "--authorization", s.authorization, "--dry-run", "--json"];
  const result = runCli(s.env, ...args);
  expect(result.exitCode).toBe(0); expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).status).toBe("compatible");
  for (const forbidden of ["Synthetic", "private-source-id", "private-record-id", s.dir]) expect(result.stdout).not.toContain(forbidden);
  expect(runCli(s.env, ...args).stdout).toBe(result.stdout);
  expect(readFileSync(s.source, "utf8")).toBe(s.slice); expect(readdirSync(s.dir)).toEqual(before);
});
test("requires dry-run and reports blocked plans with nonzero exit", () => {
  const s = setup(true);
  const args = ["import", "estate-slice", "--source", s.source, "--authorization", s.authorization];
  expect(runCli(s.env, ...args).exitCode).toBe(2);
  const blocked = runCli(s.env, ...args, "--dry-run", "--json");
  expect(blocked.exitCode).toBe(1); expect(JSON.parse(blocked.stdout).status).toBe("blocked");
  expect(blocked.stderr).toBe("");
});
test("invalid files and symlinks fail without echoing paths or content", () => {
  const s = setup(); const link = join(s.dir, "link.json"); symlinkSync(s.source, link);
  const invoke = (path: string) => runCli(s.env, "import", "estate-slice", "--source", path, "--authorization", s.authorization, "--dry-run", "--json");
  for (const path of [link, join(s.dir, "missing-secret-path")]) {
    const result = invoke(path); expect(result.exitCode).not.toBe(0); expect(result.stderr).not.toContain(s.dir); expect(result.stdout).toBe("");
  }
  writeFileSync(s.source, '{"access_token":"synthetic-canary"}');
  const result = invoke(s.source); expect(result.stderr).not.toContain("synthetic-canary"); expect(result.stdout).toBe("");
});

test("byte binding rejects a BOM, invalid UTF-8 and oversized source", () => {
  const s = setup();
  const invoke = () => runCli(s.env, "import", "estate-slice", "--source", s.source, "--authorization", s.authorization, "--dry-run", "--json");
  for (const bytes of [Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(s.slice)]), Buffer.from([0xff]), Buffer.alloc(1_048_577, 0x20)]) {
    writeFileSync(s.source, bytes);
    const result = invoke();
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(s.dir);
  }
});
