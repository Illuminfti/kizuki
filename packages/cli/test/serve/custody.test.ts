import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHelpers } from "../helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

describe("installed service custody boundary", () => {
  for (const mode of ["--service-custody", "--custody-broker-launch", "--custody-broker-child"]) {
    test(`${mode} refuses an ordinary process before opening runtime state`, () => {
      const setup = tempVault(), control = join(setup.vault, ".kizuki");
      const inventory = () => readdirSync(control).sort().map(name => {
        const path = join(control, name), stat = statSync(path);
        return { name, mode: stat.mode, size: stat.size, mtime: stat.mtimeMs,
          bytes: stat.isFile() ? readFileSync(path).toString("base64") : null };
      });
      const before = inventory();
      const result = runCli({ ...setup.env, INVOCATION_ID: "1".repeat(32), MAINPID: String(process.pid) },
        "serve", "--vault", setup.vault, mode, "synthetic-vault");
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("service_custody_unavailable");
      expect(result.stdout).toBe("");
      expect(inventory()).toEqual(before);
    });
  }

  test("private launch modes cannot combine with public operations", () => {
    const setup = tempVault();
    for (const extra of [["--once"], ["status"], ["--custody-broker-child", "synthetic-vault"]]) {
      const result = runCli(setup.env, "serve", "--vault", setup.vault,
        "--service-custody", "synthetic-vault", ...extra);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("service_custody_unavailable");
    }
    const help = runCli(setup.env, "help", "serve");
    expect(help.stdout).not.toContain("custody");
  });
});
