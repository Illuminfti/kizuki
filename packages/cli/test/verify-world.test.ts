import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "./helpers";
import { cardFixture } from "../../core/test/world/card-fixture";
import { tempVault } from "../../core/test/helpers/vault";
import { sha256Hex } from "../../core/src/util/hash";

test("verify world is a read-only CLI process with explicit copy, honest failures and JSON", async () => {
  const h = createHelpers(), f = await cardFixture(), copy = tempVault("cli-world-probe-");
  const snapshot = () => readdirSync(copy.path, { recursive: true }).sort().map((name) => {
    const file = join(copy.path, String(name)), stat = lstatSync(file);
    return [name, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs, stat.isFile() ? sha256Hex(readFileSync(file)) : null];
  });
  try {
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const file = join(copy.path, ".kizuki/kizuki.db");
    copyFileSync(join(f.ctx.vaultPath, ".kizuki/kizuki.db"), file); chmodSync(file, 0o600);
    const before = snapshot(), env = h.isolatedEnv({ KIZUKI_VAULT: f.ctx.vaultPath });
    expect(h.runCli(env, "verify", "world").exitCode).toBe(2);
    const text = h.runCli(env, "verify", "world", "--vault", copy.path);
    expect(text.exitCode, text.stderr).toBe(0);
    expect(text.stdout).toContain("PASS world_provenance");
    const json = h.runCli(env, "--vault", copy.path, "verify", "world", "--json");
    expect(json.exitCode, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).data.ok).toBe(true);
    expect(snapshot()).toEqual(before);
    f.db.query("UPDATE events SET text='PRIVATE-CHANGED-RECORD' WHERE event_id=?").run(f.definition.event.event_id);
    f.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    copyFileSync(join(f.ctx.vaultPath, ".kizuki/kizuki.db"), file);
    const failed = h.runCli(env, "verify", "world", "--vault", copy.path);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("FAIL world_provenance");
    expect(failed.stdout + failed.stderr).not.toContain("PRIVATE-CHANGED-RECORD");
  } finally { h.cleanup(); f.dispose(); copy.dispose(); }
}, 30_000);
