import { afterEach, describe, expect, test } from "bun:test";
import { AGENT_REVOKE_SCHEMA } from "../src/option-schema";
import { createHelpers } from "./helpers";

const { cleanup, isolatedEnv, runCli } = createHelpers();
afterEach(cleanup);

describe("agent revoke help", () => {
  test("help and parser share the revoke schema without enrollment", () => {
    const env = isolatedEnv();
    for (const args of [
      ["agent", "revoke", "--help"],
      ["agent", "revoke", "--help", "--json"],
      ["help", "agent", "revoke", "--json"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("agent revoke NAME [--json]");
      expect(result.stdout).not.toContain("--grant");
      expect(result.stdout).not.toContain("--token-ref");
      expect(result.stdout).not.toContain("--operation-id");
      expect(result.stdout).not.toContain("--dry-run");
    }

    const json = runCli(env, "agent", "revoke", "--help", "--json");
    const body = JSON.parse(json.stdout) as {
      schema: string;
      status: string;
      data: { name: string; usage: string; options: string[]; flags: string[] };
    };
    expect(body.schema).toBe("kizuki.cli.help/v1");
    expect(body.status).toBe("ok");
    expect(body.data.name).toBe("agent revoke");
    expect(body.data.usage).toBe("agent revoke NAME [--json]");
    expect(body.data.options).toEqual([...AGENT_REVOKE_SCHEMA.options]);
    expect(body.data.flags).toEqual([...AGENT_REVOKE_SCHEMA.flags]);
  });

  test("revoke parser rejects add-only options before resolving a vault", () => {
    const env = isolatedEnv();
    for (const args of [
      ["agent", "revoke", "assistant", "--grant", "GRANT.json"],
      ["agent", "revoke", "assistant", "--token-ref", "file:/tmp/credential"],
      ["agent", "revoke", "assistant", "--operation-id", "op-1"],
      ["agent", "revoke", "assistant", "--dry-run"],
    ] as const) {
      const result = runCli(env, ...args);
      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("invalid_request:");
      expect(result.stderr).toContain("usage: agent");
      expect(result.stderr).not.toContain("vault_unavailable");
    }
  });
});
