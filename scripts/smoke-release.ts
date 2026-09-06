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
function runJson(command: string, args: string[], env: Record<string, string>): { stdout: string; stderr: string } {
  const result = Bun.spawnSync([command, ...args], { env, stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error("compiled JSON command failed");
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

async function mcpSession(env: Record<string, string>, args: string[], requests: string[]): Promise<{ code: number; output: string; diagnostics: string }> {
  const child = Bun.spawn([mcp, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const request of requests) child.stdin.write(`${request}\n`);
  child.stdin.end();
  const output = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP smoke timed out")); }, 15_000); });
    const code = await Promise.race([child.exited, timeout]);
    const [stdout, diagnostics] = await Promise.all([output, stderr]);
    if (diagnostics.length > 16_384) throw new Error("MCP smoke diagnostics overflow");
    return { code, output: stdout, diagnostics };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
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
  const added = runJson(cli, agentArgs, env);
  const replayed = runJson(cli, agentArgs, env);
  const envelope = JSON.parse(readFileSync(credential, "utf8")) as { token: string };
  const first = JSON.parse(added.stdout) as { status?: string; authority?: string; credential?: string; agent_id?: string | null; replayed?: boolean };
  const retry = JSON.parse(replayed.stdout) as { status?: string; authority?: string; credential?: string; agent_id?: string | null; replayed?: boolean };
  if (typeof envelope.token !== "string" || first.status !== "completed" || first.authority !== "active" || first.credential !== "ready" ||
      retry.status !== "completed" || retry.authority !== "active" || retry.credential !== "ready" || retry.replayed !== true ||
      first.agent_id === null || first.agent_id === undefined || first.agent_id !== retry.agent_id || `${added.stdout}${added.stderr}${replayed.stdout}${replayed.stderr}`.includes(envelope.token) ||
      `${added.stdout}${added.stderr}${replayed.stdout}${replayed.stderr}`.includes(credential)) throw new Error("agent enrollment smoke failed");
  const agentRequests = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-smoke","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"Ada","scope":"all"}}}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_page","arguments":{"path":"missing.md"}}}',
  ];
  const agentSession = await mcpSession(env, ["--vault", vault, "--token-ref", `file:${credential}`], agentRequests);
  const responses = agentSession.output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { id?: number; result?: unknown });
  if (agentSession.code !== 0 || !responses.some(response => response.id === 2 && JSON.stringify(response.result).includes("Ada")) ||
      !responses.some(response => response.id === 3 && JSON.stringify(response.result).includes("tool_not_granted")) ||
      `${agentSession.output}${agentSession.diagnostics}`.includes(envelope.token)) throw new Error("agent MCP authorization smoke failed");
  const secondSession = await mcpSession(env, ["--vault", vault, "--token-ref", `file:${credential}`], agentRequests.slice(0, 3));
  if (secondSession.code !== 0 || !secondSession.output.includes("Ada") || `${secondSession.output}${secondSession.diagnostics}`.includes(envelope.token)) throw new Error("second agent MCP session failed");
  const revoked = runJson(cli, ["agent", "revoke", "reader-private", "--vault", vault, "--json"], env);
  if (`${revoked.stdout}${revoked.stderr}`.includes(envelope.token) || `${revoked.stdout}${revoked.stderr}`.includes(credential)) throw new Error("agent revocation leaked credential");
  const rejected = await mcpSession(env, ["--vault", vault, "--token-ref", `file:${credential}`], [agentRequests[0]!]);
  if (rejected.code === 0 || `${rejected.output}${rejected.diagnostics}`.includes(envelope.token)) throw new Error("revoked credential reconnected");

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
