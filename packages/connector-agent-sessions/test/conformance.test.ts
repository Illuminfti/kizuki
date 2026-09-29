import { expect, test } from "bun:test";
import path from "node:path";
import { defaultConnectorRegistry } from "../../connectors/src/registry";
import { runConformance } from "../../connectors/src/testkit";
import { AGENT_SESSIONS_CURSOR_SCHEMA } from "../src";
import type { SessionFlavor } from "../src";
import { writeFixtureTree } from "../src/testing";
import { connectorFor, tempRoot } from "./helpers";

const IDS: Record<SessionFlavor, string> = {
  "claude-code": "kizuki.claude-code-sessions",
  codex: "kizuki.codex-sessions",
};

for (const flavor of ["claude-code", "codex"] as const) {
  test(`${IDS[flavor]} passes the shared conformance suite`, async () => {
    const root = await tempRoot();
    await writeFixtureTree(root, flavor);
    const connector = defaultConnectorRegistry.seal(connectorFor(flavor, { path: root }));
    const missing = defaultConnectorRegistry.seal(connectorFor(flavor, { path: path.join(root, "absent") }));

    expect(await runConformance(connector, { unavailable: { connector: missing } })).toEqual({
      pass: true,
      failures: [],
    });
  });

  test(`${IDS[flavor]} declares the connector manifest the design specifies`, async () => {
    const root = await tempRoot();
    const manifest = defaultConnectorRegistry.get(IDS[flavor], { path: root }).manifest();

    expect(manifest).toMatchObject({
      schema: "kizuki.connector/v1",
      connector_id: IDS[flavor],
      kinds: ["message"],
      capabilities: { backfill: true, sync: true, tombstones: false, purge: false, fixture: true },
      required_secrets: [],
      allowed_egress: [],
      auth_modes: ["none"],
      cursor_schema: AGENT_SESSIONS_CURSOR_SCHEMA,
      default_sensitivity: "private",
      sensitivity_floor: "personal",
    });
  });

  test(`${IDS[flavor]} refuses a source that is not a readable directory`, async () => {
    const root = await tempRoot();
    const connector = connectorFor(flavor, { path: path.join(root, "absent") });

    await expect(connector.connect(async () => "")).rejects.toMatchObject({ code: "misconfigured" });
    await expect(connector.backfill(null)).rejects.toMatchObject({ code: "unavailable" });
    expect((await connector.health()).state).toBe("misconfigured");
  });

  test(`${IDS[flavor]} rejects unknown configuration keys`, () => {
    expect(() => connectorFor(flavor, { path: "/x", include_tool_results: true } as never)).toThrow(/unknown key/);
    expect(() => connectorFor(flavor, { path: "" })).toThrow(/config.path/);
    expect(() => connectorFor(flavor, { path: "/x", exclude_cwd: ["relative/dir"] })).toThrow(/exclude_cwd/);
  });
}

test("source-side purge is not supported and a revoked connector refuses work", async () => {
  const root = await tempRoot();
  await writeFixtureTree(root, "codex");
  const connector = connectorFor("codex", { path: root });

  await expect(connector.purgeSource("project:abc")).rejects.toMatchObject({ code: "not_supported" });
  await connector.revoke();
  await expect(connector.sync(null)).rejects.toMatchObject({ code: "unavailable" });
  expect((await connector.health()).state).toBe("disabled");
});
