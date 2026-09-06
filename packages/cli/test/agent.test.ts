import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { rotateToken, setGrant, type AgentEnrollmentResult, type Grant } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { createHelpers, type CliResult } from "./helpers";

const { cleanup, isolatedEnv, runCli, tempDir, tempVault } = createHelpers();
afterEach(cleanup);
const GRANT: Grant = { ceiling: "personal", types: null, subjects: ["person:ada"], since: null, until: null,
  tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false };

// Static host eligibility only: an implementation exception must never skip a test.
const probe = tempDir();
const qualified = process.platform === "linux" && process.arch === "x64" && (() => {
  const uid = process.geteuid?.();
  if (uid === undefined) return false;
  for (let path = probe;; path = dirname(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) ||
      ((stat.mode & 0o022) !== 0 && (stat.uid !== 0 || (stat.mode & 0o1000) === 0))) return false;
    if (path === dirname(path)) return true;
  }
})();

function fingerprint(root: string): unknown {
  if (!existsSync(root)) return null;
  return readdirSync(root).sort().map(name => {
    const path = join(root, name), stat = lstatSync(path);
    return [name, stat.mode, stat.uid, stat.nlink, stat.isDirectory() ? fingerprint(path)
      : new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex")];
  });
}

function fixture() {
  const state = tempVault(), grantPath = join(state.root, "grant.json"), credentialDir = join(state.vault, ".kizuki", "agent-credentials");
  mkdirSync(credentialDir, { mode: 0o700 });
  const tokenPath = join(credentialDir, "agent.credential");
  writeFileSync(grantPath, JSON.stringify(GRANT), { mode: 0o600 });
  const args = ["--vault", state.vault, "agent", "add", "helper", "--grant", grantPath,
    "--token-ref", `file:${tokenPath}`, "--operation-id", "helper-setup-1", "--json"];
  return { ...state, grantPath, tokenPath, args };
}

function result(output: CliResult, code = 0): AgentEnrollmentResult {
  expect(output.exitCode, "agent command exit").toBe(code);
  const parsed = JSON.parse(output.stdout);
  expect(parsed.status).toBe(code === 0 ? "ok" : "error");
  return parsed.data as AgentEnrollmentResult;
}

function redacted(output: CliResult, forbidden: string[]): void {
  const text = output.stdout + output.stderr;
  expect(forbidden.some(value => text.includes(value)), "output must omit private paths, input and credentials").toBe(false);
  expect(/kzk_[0-9A-HJKMNP-TV-Z]{52}/.test(text), "output must omit bearer tokens").toBe(false);
}

test.if(process.env.GITHUB_ACTIONS === "true" && process.platform === "linux" && process.arch === "x64")("agent process proof requires qualified CI custody", () => {
  expect(qualified).toBe(true);
});

test("agent rejects missing, ambiguous and unsupported arguments without initializing a vault", () => {
  const env = isolatedEnv(), root = tempDir(), before = fingerprint(root);
  for (const args of [[], ["add"], ["add", "helper"], ["list"], ["revoke", "helper", "extra"],
    ["revoke", "helper", "--grant", "private-marker"], ["add", "helper", "--owner"], ["revoke", "helper", "--json", "--json"]]) {
    const output = runCli(env, "--vault", join(root, "absent"), "agent", ...args, "--json");
    expect(output.exitCode).toBe(2);
    expect(JSON.parse(output.stdout).error.code).toBe("invalid_request");
    redacted(output, [root, "private-marker"]);
  }
  expect(fingerprint(root)).toEqual(before);
});

test("grant input is bounded, closed and redacted before any enrollment", () => {
  const root = tempDir(), env = isolatedEnv(), grant = join(root, "sensitive-grant.json");
  const args = ["--vault", join(root, "absent"), "agent", "add", "helper", "--grant", grant,
    "--token-ref", `file:${join(root, "credential")}`, "--operation-id", "helper-setup-1", "--json"];
  for (const content of ["private-payload-invalid-json", "x".repeat(32769), "", Buffer.from([0xff])]) {
    writeFileSync(grant, content);
    const output = runCli(env, ...args);
    expect(output.exitCode).toBe(2);
    expect(JSON.parse(output.stdout).error.code).toBe("invalid_grant");
    redacted(output, [root, "private-payload-invalid-json"]);
  }
  const link = join(root, "grant-link"); symlinkSync(grant, link);
  args[args.indexOf(grant)] = link;
  expect(runCli(env, ...args).exitCode).toBe(2);
  expect(existsSync(join(root, "credential"))).toBe(false);
  expect(existsSync(join(root, "absent"))).toBe(false);
});

test.if(qualified)("preview validates real custody and conflicts without changing vault or config bytes", () => {
  const f = fixture(), before = fingerprint(f.root);
  const preview = result(runCli(f.env, ...f.args, "--dry-run"));
  expect(preview.status).toBe("preview");
  expect(preview.authority).toBe("none");
  expect(fingerprint(f.root)).toEqual(before);
  writeFileSync(f.tokenPath, "unrelated-secret-marker", { mode: 0o600 });
  const conflictBefore = fingerprint(f.root), refused = runCli(f.env, ...f.args, "--dry-run");
  expect(refused.exitCode).toBe(1);
  expect(JSON.parse(refused.stdout).error.code).toBe("credential_conflict");
  expect(fingerprint(f.root)).toEqual(conflictBefore);
  redacted(refused, [f.root, "unrelated-secret-marker"]);
});

test.if(qualified)("old-ledger preview reports migration required with no file or schema mutation", () => {
  const f = fixture();
  const db = new Database(join(f.vault, ".kizuki", "kizuki.db"));
  // The normal migration suite proves the real old DDL; this checks CLI dispatch
  // and full file footprint when the version guard requests a migration.
  db.run("UPDATE schema_version SET version=16"); db.run("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
  const before = fingerprint(f.root), output = runCli(f.env, ...f.args, "--dry-run");
  expect(output.exitCode).toBe(1);
  expect(JSON.parse(output.stdout).error.code).toBe("migration_required");
  expect(fingerprint(f.root)).toEqual(before);
});

test.if(qualified)("public add retries preserve current grants, refuse rotated credentials, and revoke idempotently", () => {
  const f = fixture(), firstOutput = runCli(f.env, ...f.args), first = result(firstOutput);
  expect(first.status).toBe("completed"); expect(first.credential).toBe("ready");
  expect(first.grant).toEqual(GRANT); expect(first.grant_epoch).toBe(1);
  const envelope = JSON.parse(readFileSync(f.tokenPath, "utf8"));
  const credentialBytes = readFileSync(f.tokenPath), token = envelope.token as string;
  expect(lstatSync(f.tokenPath).mode & 0o777).toBe(0o600);
  redacted(firstOutput, [f.root, token]);
  const retry = result(runCli(f.env, ...f.args));
  expect(retry.agent_id).toBe(first.agent_id); expect(retry.replayed).toBe(true);
  expect(readFileSync(f.tokenPath).equals(credentialBytes)).toBe(true);
  let db = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
  setGrant(db, "helper", { subjects: [], tools: [] }); db.close();
  const narrowed = result(runCli(f.env, ...f.args));
  expect(narrowed.grant?.subjects).toEqual([]); expect(narrowed.grant?.tools).toEqual([]);
  expect(narrowed.grant_epoch).toBe(2);
  db = openLedger(join(f.vault, ".kizuki", "kizuki.db")); rotateToken(db, "helper"); db.close();
  const staleOutput = runCli(f.env, ...f.args), stale = result(staleOutput, 1);
  expect(stale.credential).toBe("stale"); expect(stale.authority).toBe("active");
  redacted(staleOutput, [f.root, token]);
  const revoke = () => runCli(f.env, "--vault", f.vault, "agent", "revoke", "helper", "--json");
  const revoked = result(revoke()), again = result(revoke());
  expect(revoked.authority).toBe("revoked"); expect(again.grant_epoch).toBe(revoked.grant_epoch);
  expect(result(runCli(f.env, ...f.args), 1).authority).toBe("revoked");
  expect(readFileSync(f.tokenPath).equals(credentialBytes)).toBe(true);
});

test.if(qualified)("agent refuses owner defaults, missing grant fields and vault-content credential destinations", () => {
  const f = fixture();
  for (const grant of [{}, { ...GRANT, hidden: "private-marker" }, { ...GRANT, tools: ["owner"] }]) {
    writeFileSync(f.grantPath, JSON.stringify(grant));
    const output = runCli(f.env, ...f.args);
    expect(output.exitCode).toBe(2); redacted(output, [f.root, "private-marker"]);
  }
  writeFileSync(f.grantPath, JSON.stringify(GRANT));
  const ordinary = join(f.vault, "..notes"); mkdirSync(ordinary, { mode: 0o700 }); chmodSync(ordinary, 0o700);
  const args = [...f.args]; args[args.indexOf(`file:${f.tokenPath}`)] = `file:${join(ordinary, "credential")}`;
  const before = fingerprint(f.root), denied = runCli(f.env, ...args);
  expect(denied.exitCode).toBe(1);
  expect(fingerprint(f.root)).toEqual(before);
});
