import { afterEach, describe, expect, test } from "bun:test";
import { OWNER, revokeAgent } from "@kizuki/core";
import { ownerPrincipal, principalFromToken } from "../src/principal";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

let fixture: McpFixture | null = null;

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

describe("principal resolution", () => {
  test("a live token resolves to its agent", () => {
    const running = live();
    const principal = principalFromToken(
      running.db,
      running.tokens["reader-private"] as string,
    );
    expect(principal?.kind).toBe("agent");
    expect(principal?.kind === "agent" ? principal.agent.name : "").toBe(
      "reader-private",
    );
    expect(principal?.grant.ceiling).toBe("private");
  });

  test("a revoked, malformed or unknown token resolves to nothing", () => {
    const running = live();
    expect(
      principalFromToken(running.db, running.tokens["gone"] as string),
    ).toBeNull();
    expect(principalFromToken(running.db, "not-a-token")).toBeNull();
    expect(principalFromToken(running.db, `kzk_${"A".repeat(52)}`)).toBeNull();
  });

  test("a token revoked after issue stops resolving", () => {
    const running = live();
    const token = running.tokens["reader-personal"] as string;
    expect(principalFromToken(running.db, token)).not.toBeNull();
    revokeAgent(running.db, "reader-personal");
    expect(principalFromToken(running.db, token)).toBeNull();
  });

  test("the owner principal is the core owner", () => {
    expect(ownerPrincipal()).toEqual(OWNER);
  });
});
