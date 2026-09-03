import { afterEach, describe, expect, test } from "bun:test";
import { authenticate } from "@kizuki/core";
import { createHelpers } from "../helpers";
import { onlyTokenLine, openVaultDb } from "./helpers";

const { cleanup, runCli, tempVault } = createHelpers();
afterEach(cleanup);

const TOKEN_SHAPE = /^kzk_[0-9A-HJKMNP-TV-Z]{52}$/;

describe("kizuki agent add / list / revoke / rotate", () => {
  test("5.1 add prints the token on stdout exactly once, never on stderr or in audit", () => {
    const setup = tempVault();
    const added = runCli(setup.env, "agent", "add", "ada");
    expect(added.exitCode).toBe(0);

    const token = onlyTokenLine(added.stdout);
    expect(token).toMatch(TOKEN_SHAPE);
    expect(added.stderr).not.toContain(token);

    const audited = runCli(setup.env, "audit", "--json");
    expect(audited.exitCode).toBe(0);
    expect(audited.stdout).not.toContain(token);
    expect(audited.stderr).not.toContain(token);

    const listed = runCli(setup.env, "agent", "list", "--json");
    expect(listed.stdout).not.toContain(token);
    expect(listed.stderr).not.toContain(token);
  });

  test("5.2 the default grant ceiling is personal", () => {
    const setup = tempVault();
    expect(runCli(setup.env, "agent", "add", "ada").exitCode).toBe(0);

    const listed = runCli(setup.env, "agent", "list", "--json");
    expect(listed.exitCode).toBe(0);
    const rows = listed.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const ada = rows.find((row) => row.name === "ada");
    expect(ada).toMatchObject({ ceiling: "personal", revoked_at: null });
    expect(typeof ada?.agent_id).toBe("string");
    expect(typeof ada?.tools).toBe("number");
  });

  test("--owner-agent grants a private ceiling", () => {
    const setup = tempVault();
    const added = runCli(setup.env, "agent", "add", "grace", "--owner-agent", "--json");
    expect(added.exitCode).toBe(0);
    const line = onlyTokenLine(added.stdout);
    const parsed = JSON.parse(line) as {
      name: string;
      agent_id: string;
      token: string;
      ceiling: string;
    };
    expect(parsed.name).toBe("grace");
    expect(parsed.ceiling).toBe("private");
    expect(parsed.token).toMatch(TOKEN_SHAPE);

    const listed = runCli(setup.env, "agent", "list", "--json");
    expect(listed.stdout).toContain('"ceiling":"private"');
  });

  test("5.6 a duplicate name refuses and mints no new token", () => {
    const setup = tempVault();
    const first = runCli(setup.env, "agent", "add", "ada");
    expect(first.exitCode).toBe(0);
    const token = onlyTokenLine(first.stdout);

    const second = runCli(setup.env, "agent", "add", "ada");
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toContain("already exists");
    expect(second.stdout).toBe("");

    const listed = runCli(setup.env, "agent", "list", "--json");
    const rows = listed.stdout
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.filter((row) => row.name === "ada")).toHaveLength(1);

    const db = openVaultDb(setup.vault);
    try {
      expect(authenticate(db, token)?.kind).toBe("agent");
    } finally {
      db.close();
    }
  });

  test("revoke closes the door and rotate mints a fresh token", () => {
    const setup = tempVault();
    const added = runCli(setup.env, "agent", "add", "ada");
    const originalToken = onlyTokenLine(added.stdout);

    const rotated = runCli(setup.env, "agent", "rotate", "ada");
    expect(rotated.exitCode).toBe(0);
    const rotatedToken = onlyTokenLine(rotated.stdout);
    expect(rotatedToken).not.toBe(originalToken);

    const dbAfterRotate = openVaultDb(setup.vault);
    try {
      expect(authenticate(dbAfterRotate, originalToken)).toBeNull();
      expect(authenticate(dbAfterRotate, rotatedToken)?.kind).toBe("agent");
    } finally {
      dbAfterRotate.close();
    }

    const revoked = runCli(setup.env, "agent", "revoke", "ada");
    expect(revoked.exitCode).toBe(0);
    expect(revoked.stdout).toContain("ada");

    const dbAfterRevoke = openVaultDb(setup.vault);
    try {
      expect(authenticate(dbAfterRevoke, rotatedToken)).toBeNull();
    } finally {
      dbAfterRevoke.close();
    }

    const listed = runCli(setup.env, "agent", "list", "--json");
    expect(listed.stdout).toMatch(/"revoked_at":"[^"]+"/);
  });

  test("revoke and rotate refuse an unknown agent name", () => {
    const setup = tempVault();
    const revoked = runCli(setup.env, "agent", "revoke", "nobody");
    expect(revoked.exitCode).not.toBe(0);
    expect(revoked.stderr).toContain("does not exist");

    const rotated = runCli(setup.env, "agent", "rotate", "nobody");
    expect(rotated.exitCode).not.toBe(0);
    expect(rotated.stderr).toContain("does not exist");
  });

  test("agent add without a name is a usage error", () => {
    const setup = tempVault();
    const result = runCli(setup.env, "agent", "add");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage: kizuki agent");
  });
});
