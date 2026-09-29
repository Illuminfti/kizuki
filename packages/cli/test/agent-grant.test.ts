import { afterEach, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openLedger } from "@kizuki/core/testing";
import type { Grant } from "@kizuki/core";
import { createHelpers, type CliResult } from "./helpers";
import { openMcpSession, type McpReply } from "./mcp-stdio-session";

// These tests spawn real CLI and MCP processes; bound them for a loaded host.
setDefaultTimeout(60_000);

const { cleanup, runCli, tempDir, tempVault } = createHelpers();
const sessions: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) await session.close(); cleanup(); });

const READER: Grant = { ceiling: "personal", types: null, subjects: null, since: null, until: null,
  tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false };
const WIDER: Grant = { ...READER, tools: ["search", "world_view"], relay_owner_corrections: true };
const WORLD_CALL = { operation: "find_concepts", label: "", valid: { kind: "all" }, knownAt: { kind: "current" } };

function setup() {
  const state = tempVault();
  const credentials = join(state.vault, ".kizuki", "agent-credentials");
  mkdirSync(credentials, { mode: 0o700 });
  const write = (name: string, grant: unknown) => {
    const path = join(state.root, name); writeFileSync(path, JSON.stringify(grant), { mode: 0o600 }); return path;
  };
  const tokenPath = join(credentials, "helper.credential");
  const cli = (...args: string[]) => runCli(state.env, "--vault", state.vault, ...args);
  const enrolled = cli("agent", "add", "helper", "--grant", write("reader.json", READER), "--token-ref", `file:${tokenPath}`,
    "--operation-id", "helper-setup-1", "--json");
  expect(enrolled.exitCode).toBe(0);
  return { ...state, tokenPath, write, cli };
}

function json(output: CliResult, code = 0) {
  expect(output.exitCode, output.stderr).toBe(code);
  return JSON.parse(output.stdout) as { status: string; data: any; error?: { code: string } };
}

test("agent list shows every agent with its grant summary and never a credential", () => {
  const f = setup();
  const token = (JSON.parse(readFileSync(f.tokenPath, "utf8")) as { token: string }).token;
  const listed = json(f.cli("agent", "list", "--json"));
  expect(listed.data.agents).toHaveLength(1);
  expect(listed.data.agents[0]).toMatchObject({ name: "helper", state: "active", grant_epoch: 1, grant: READER });
  expect(JSON.stringify(listed)).not.toContain("token");
  const text = f.cli("agent", "list");
  expect(text.exitCode).toBe(0);
  expect(text.stdout).toContain("helper");
  expect(text.stdout).toContain("tools=search");
  expect(text.stdout).toContain("relay=off");
  for (const output of [text.stdout + text.stderr, JSON.stringify(listed)]) {
    expect(output.includes(token)).toBe(false);
    expect(/kzk_[0-9A-HJKMNP-TV-Z]{52}/.test(output)).toBe(false);
    expect(output.includes(f.tokenPath)).toBe(false);
  }
  expect(f.cli("agent", "revoke", "helper").exitCode).toBe(0);
  expect(json(f.cli("agent", "list", "--json")).data.agents[0].state).toBe("revoked");
});

test("agent list on an empty vault says so, and list takes no name or option", () => {
  const f = tempVault();
  const run = (...args: string[]) => runCli(f.env, "--vault", f.vault, ...args);
  expect(run("agent", "list").stdout).toContain("No agents are enrolled.");
  expect(run("agent", "list", "helper").exitCode).toBe(2);
  expect(run("agent", "list", "--grant", "x").exitCode).toBe(2);
});

test("agent grant amends in place, is idempotent on the operation id and audits the change", () => {
  const f = setup();
  const file = f.write("wider.json", WIDER);
  const first = json(f.cli("agent", "grant", "helper", "--grant", file, "--operation-id", "helper-grant-1", "--json"));
  expect(first.data).toMatchObject({ name: "helper", grant_epoch: 2, replayed: false, grant: WIDER });
  const again = json(f.cli("agent", "grant", "helper", "--grant", file, "--operation-id", "helper-grant-1", "--json"));
  expect(again.data).toMatchObject({ grant_epoch: 2, replayed: true });
  const other = json(f.cli("agent", "grant", "helper", "--grant", f.write("other.json", { ...WIDER, rate_limit_per_minute: 5 }),
    "--operation-id", "helper-grant-1", "--json"), 1);
  expect(other.error?.code).toBe("operation_conflict");
  const text = f.cli("agent", "grant", "helper", "--grant", file, "--operation-id", "helper-grant-2");
  expect(text.stdout).toContain("grant epoch 3");
  expect(JSON.stringify(first) + text.stdout).not.toContain("kzk_");
  const db = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
  try {
    expect(db.query<{ n: number }, []>("SELECT count(*) AS n FROM agent_audit WHERE tool = 'agent.grant'").get()?.n).toBe(2);
  } finally { db.close(true); }
  expect(json(f.cli("agent", "list", "--json")).data.agents[0]).toMatchObject({ grant_epoch: 3, grant: WIDER });
});

test("agent grant fails closed on an unknown agent, a revoked agent, a bad grant and missing options", () => {
  const f = setup();
  const file = f.write("wider.json", WIDER);
  const grant = (name: string, path: string, id: string) => f.cli("agent", "grant", name, "--grant", path, "--operation-id", id, "--json");
  expect(json(grant("nobody", file, "helper-grant-1"), 1).error?.code).toBe("unknown_agent");
  expect(json(grant("helper", f.write("bad.json", { ...WIDER, tools: ["not_a_tool"] }), "helper-grant-1"), 2).error?.code).toBe("invalid_grant");
  expect(json(grant("helper", f.write("partial.json", { ceiling: "public" }), "helper-grant-1"), 2).error?.code).toBe("invalid_grant");
  expect(json(grant("helper", join(f.root, "absent.json"), "helper-grant-1"), 2).error?.code).toBe("invalid_grant");
  expect(json(f.cli("agent", "grant", "helper", "--grant", file, "--json"), 2).error?.code).toBe("invalid_request");
  expect(json(f.cli("agent", "grant", "helper", "--operation-id", "helper-grant-1", "--json"), 2).error?.code).toBe("invalid_request");
  expect(json(grant("helper", file, "short"), 2).error?.code).toBe("invalid_request");
  expect(json(f.cli("agent", "list", "--json")).data.agents[0]).toMatchObject({ grant_epoch: 1, grant: READER });
  expect(f.cli("agent", "revoke", "helper").exitCode).toBe(0);
  expect(json(grant("helper", file, "helper-grant-2"), 1).error?.code).toBe("unknown_agent");
});

test("agent grant and list have their own help", () => {
  const f = tempVault();
  for (const verb of ["grant", "list"]) {
    const help = runCli(f.env, "agent", verb, "--help");
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(`agent ${verb}`);
  }
  expect(runCli(f.env, "agent", "grant", "--help").stdout).toContain("--operation-id");
});

test("a running MCP client is denied world_view, then served it after the owner amends its grant", async () => {
  const f = setup();
  const session = openMcpSession(f.vault, `file:${f.tokenPath}`, tempDir("kizuki-grant-home-"));
  sessions.push(session);
  await session.initialize();
  const denied = (reply: McpReply) => reply.result?.isError === true && JSON.parse(reply.result.content?.[0]?.text ?? "null").error === "tool_not_granted";
  expect(denied(await session.call("world_view", WORLD_CALL))).toBe(true);
  expect((await session.call("search", { query: "anything", scope: "canon" })).result?.isError).not.toBe(true);
  const amended = json(f.cli("agent", "grant", "helper", "--grant", f.write("wider.json", WIDER), "--operation-id", "helper-grant-1", "--json"));
  expect(amended.data.grant_epoch).toBe(2);
  // Same process, same credential file: only the stored grant changed.
  const served = await session.call("world_view", WORLD_CALL);
  expect(served.result?.isError ?? false).toBe(false);
  expect(JSON.stringify(served.result?.structuredContent)).toContain("kizuki.envelope/v2");
});
