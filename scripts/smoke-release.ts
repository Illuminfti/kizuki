import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyChecksumManifest } from "./release-artifacts";

import { selectedReleaseTarget } from "./release-targets";
import { parseBuildInfo } from "./stranger-proof";
const target = selectedReleaseTarget();

const root = resolve(import.meta.dir, "..");
const version = (await Bun.file(resolve(root, "packages/cli/package.json")).json() as {
  version: string;
}).version;
const release = resolve(root, "dist", `kizuki-${version}`, target.target);
const cli = join(release, "kizuki");
const mcp = join(release, "kizuki-mcp");

for (const required of [cli, mcp, join(release, "SHA256SUMS"), join(release, "README.txt"), join(release, "BUILD.json")]) {
  if (!existsSync(required)) throw new Error(`release artifact is missing: ${required}`);
}

const build = parseBuildInfo(join(release, "BUILD.json"));
if (build.target !== target.target || build.bun_version !== Bun.version) throw new Error("artifact target or Bun version mismatch");
verifyChecksumManifest(release, ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"]);

function run(command: string, args: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync([command, ...args], { env, stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error("compiled command failed");
  }
  return `${result.stdout}${result.stderr}`;
}

async function mcpSession(env: Record<string, string>, args: string[], requests: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn([mcp, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const request of requests) child.stdin.write(`${request}\n`);
  child.stdin.end();
  const output = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const timeout = new Promise<never>((_, reject) => setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP smoke timed out")); }, 15_000));
  const code = await Promise.race([child.exited, timeout]);
  const [stdout, diagnostics] = await Promise.all([output, stderr]);
  if (diagnostics.length > 16_384) throw new Error("MCP smoke diagnostics overflow");
  return { code, output: stdout };
}

const rootTemp = mkdtempSync(join(tmpdir(), "kizuki-release-smoke-"));
try {
  const vault = join(rootTemp, "vault");
  const notes = join(rootTemp, "notes");
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: join(rootTemp, "home"),
    XDG_CONFIG_HOME: join(rootTemp, "config"),
    KIZUKI_CONFIG: join(rootTemp, "config.toml"),
    KIZUKI_SUPERVISOR: "none",
  };
  mkdirSync(notes, { recursive: true });
  writeFileSync(join(notes, "note.md"), "Ada met Grace at the library.\n", "utf8");

  if (!run(cli, ["version"], env).includes(version)) throw new Error("wrong CLI version");
  if (!run(cli, ["--help"], env).includes("usage: kizuki")) throw new Error("CLI help missing");
  const catalog = JSON.parse(run(cli, ["connect", "--json"], env)) as {
    data: { sources: { id: string; available: boolean }[] };
  };
  if (!catalog.data.sources.some((source) => source.id === "kizuki.beeper" && source.available)) {
    throw new Error("Beeper is missing from the compiled connection catalog");
  }
  run(cli, ["init", vault, "--no-service"], env);
  const policy = join(rootTemp, "source-policy.json");
  writeFileSync(policy, JSON.stringify({ purposes: ["capture", "recall", "session", "derive", "extract", "export"],
    allowed_fields: ["text", "subjects", "attachments", "metadata"], retention: "persistent_owned_until_revoked",
    egress: "local_only", sensitivity_floor: "private" }), { mode: 0o600 });
  run(cli, ["import", "markdown-folder", "--source", notes, "--vault", vault,
    "--policy", policy, "--expected-revision", "0", "--operation-id", "release-smoke-consent"], env);
  const query = run(cli, ["query", "Ada", "--vault", vault], env);
  if (!query.includes("Ada")) {
    throw new Error(`imported note was not queryable: ${query}`);
  }
  const context = run(cli, ["context", "--query", "Ada", "--vault", vault], env);
  if (!context.includes("Ada")) throw new Error("imported note is missing from compiled context");
  run(cli, ["serve", "--once", "--no-http", "--vault", vault], env);

  const grant = join(rootTemp, "agent-grant.json");
  const credential = join(rootTemp, "agent-credential");
  writeFileSync(grant, JSON.stringify({ ceiling: "private", types: null, subjects: null, since: null, until: null,
    tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false }), { mode: 0o600 });
  const agentArgs = ["agent", "add", "reader-private", "--grant", grant, "--token-ref", `file:${credential}`,
    "--operation-id", "releaseagent01", "--vault", vault, "--json"];
  const added = run(cli, agentArgs, env);
  const replayed = run(cli, agentArgs, env);
  const envelope = JSON.parse(readFileSync(credential, "utf8")) as { token: string };
  if (typeof envelope.token !== "string" || added.includes(envelope.token) || replayed.includes(envelope.token)) throw new Error("agent credential leaked");
  const agentRequests = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-smoke","version":"0"}}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"Ada"}}}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"correct","arguments":{}}}',
  ];
  const agentSession = await mcpSession(env, ["--vault", vault, "--token-ref", `file:${credential}`], agentRequests);
  if (agentSession.code !== 0 || !agentSession.output.includes("Ada") || !agentSession.output.includes("tool_not_granted") || agentSession.output.includes(envelope.token)) throw new Error("agent MCP authorization smoke failed");
  const revoked = run(cli, ["agent", "revoke", "reader-private", "--vault", vault, "--json"], env);
  if (revoked.includes(envelope.token)) throw new Error("agent revocation leaked credential");
  const rejected = await mcpSession(env, ["--vault", vault, "--token-ref", `file:${credential}`], [agentRequests[0]!]);
  if (rejected.code === 0 || rejected.output.includes(envelope.token)) throw new Error("revoked credential reconnected");

  const session = Bun.spawn([mcp, "--vault", vault, "--owner"], {
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  session.stdin.write(
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-smoke","version":"0"}}}\n',
  );
  session.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  session.stdin.end();
  const output = await new Response(session.stdout).text();
  const stderr = await new Response(session.stderr).text();
  if ((await session.exited) !== 0) throw new Error(`MCP smoke failed: ${stderr}`);
  if (!output.includes('"tools"')) throw new Error("MCP tools/list did not respond");

  verifyChecksumManifest(release, ["kizuki", "kizuki-mcp", "README.txt", "BUILD.json"]);
  process.stdout.write(`release smoke passed: ${release}\n`);
} finally {
  rmSync(rootTemp, { force: true, recursive: true });
}
