import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { serializePage } from "@kizuki/core";
import { mcpFixture } from "./helpers";
import type { McpFixture } from "./helpers";

const BIN = join(import.meta.dir, "..", "src", "bin.ts");

let fixture: McpFixture | null = null;

afterEach(() => {
  fixture?.dispose();
  fixture = null;
});

function live(): McpFixture {
  fixture = mcpFixture();
  return fixture;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  args: string[],
  input: string | null,
  env: Record<string, string> = {},
): Promise<Run> {
  const child = Bun.spawn([process.execPath, BIN, ...args], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  if (input !== null) child.stdin.write(input);
  child.stdin.end();
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, stdout, stderr };
}

const HANDSHAKE = [
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}',
  '{"jsonrpc":"2.0","method":"notifications/initialized"}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
  "",
].join("\n");

describe("the stdio process entry", () => {
  test("an owner session answers a handshake and exits cleanly", async () => {
    const running = live();
    const result = await run(
      ["--vault", running.vaultPath, "--owner"],
      HANDSHAKE,
    );
    expect(result.code).toBe(0);

    const lines = result.stdout.trim().split("\n");
    const parsed = lines.map(
      (line) =>
        JSON.parse(line) as {
          jsonrpc: string;
          id?: number;
          result?: { tools?: { name: string }[] };
        },
    );
    expect(parsed.every((message) => message.jsonrpc === "2.0")).toBe(true);

    const listed = parsed.find((message) => message.id === 2);
    // Spelled out rather than read from the engine's own constant: this is
    // the one assertion that would notice the surface changing under it.
    expect(listed?.result?.tools?.map((tool) => tool.name)).toEqual([
      "search",
      "get_page",
      "query_entities",
      "timeline",
      "context_packet",
      "graph_neighbors",
      "system_health",
      "propose",
      "correct",
    ]);
    expect(result.stderr.trim()).toBe(
      "kizuki-mcp ready principal=owner tools=9",
    );
  });

  test("a request answered as the pipe closes is answered in full", async () => {
    const running = live();
    // Big enough that the answer cannot leave the pipe in one turn: a
    // shutdown that does not wait for the write loses the tail of it.
    writeFileSync(
      join(running.vaultPath, "facts", "long.md"),
      serializePage({
        data: {
          id: "fact:long",
          title: "A long kettle note",
          type: "fact",
          status: "active",
          sensitivity: "public",
        },
        body: "the kettle is on. ".repeat(6_000),
      }),
      "utf8",
    );
    const work = [
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}',
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_page","arguments":{"id":"fact:long"}}}',
      "",
    ].join("\n");

    // Written and closed in the same turn, which is what a harness does.
    // Repeated because a shutdown that races the answer loses it only
    // sometimes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await run(
        ["--vault", running.vaultPath, "--owner"],
        work,
      );
      expect(result.code).toBe(0);
      const answers = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
      const answered = answers.find((message) => message.id === 2);
      const payload = answered?.result as
        | { structuredContent?: { canon?: { excerpt?: string }[] } }
        | undefined;
      expect(payload?.structuredContent?.canon?.[0]?.excerpt?.length).toBe(
        65_536,
      );
    }
  });

  test("an unset token variable refuses without starting the server", async () => {
    const running = live();
    const result = await run(
      ["--vault", running.vaultPath, "--token-env", "KIZUKI_TEST_MISSING"],
      null,
    );
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("token variable is not set");
    expect(result.stdout).toBe("");
  });

  test("a revoked token is refused and never echoed", async () => {
    const running = live();
    const token = running.tokens["gone"] as string;
    const result = await run(
      ["--vault", running.vaultPath, "--token-env", "KIZUKI_TEST_TOKEN"],
      null,
      { KIZUKI_TEST_TOKEN: token },
    );
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("token not recognized");
    expect(result.stderr).not.toContain(token);
    expect(result.stderr).not.toContain("kzk_");
  });

  test("a live token starts a session for its agent", async () => {
    const running = live();
    const result = await run(
      ["--vault", running.vaultPath, "--token-env", "KIZUKI_TEST_TOKEN"],
      HANDSHAKE,
      { KIZUKI_TEST_TOKEN: running.tokens["reader-private"] as string },
    );
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe(
      "kizuki-mcp ready principal=reader-private tools=9",
    );
  });

  test("an uninitialized vault and a missing selector both refuse", async () => {
    const missing = await run(
      ["--vault", "/nonexistent-kizuki", "--owner"],
      null,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr.trim()).toBe("vault is not initialized");

    const noArgs = await run([], null);
    expect(noArgs.code).toBe(2);
    expect(noArgs.stderr.startsWith("usage:")).toBe(true);

    const running = live();
    const both = await run(
      ["--vault", running.vaultPath, "--owner", "--token-env", "KIZUKI_X"],
      null,
    );
    expect(both.code).toBe(2);
    expect(both.stderr.startsWith("usage:")).toBe(true);
  });
});
