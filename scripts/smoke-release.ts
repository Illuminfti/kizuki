import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyPackageDirectory } from "./release-artifacts";
import { mcpSession } from "./smoke-release-mcp";

import { selectedReleaseTarget } from "./release-targets";
import { parseBuildInfo } from "./stranger-proof";
import {
  PACKAGED_CLI_COMMANDS,
  PACKAGED_POLICY_CREATE_COMMAND,
  PACKAGED_SOURCE_POLICY,
  isValidBuildTimestamp,
  packagedCommandLine,
} from "./build-release";
import { RAIL_IDS } from "../packages/core/src/serve/rail-registry";
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
verifyPackageDirectory(release, build);
const readme = readFileSync(join(release, "README.txt"), "utf8");
for (const argv of Object.values(PACKAGED_CLI_COMMANDS)) {
  if (!readme.includes(packagedCommandLine(argv))) throw new Error(`package README missing ${argv.join(" ")}`);
}
if (!readme.includes("./kizuki version") || !readme.includes(`  ${PACKAGED_POLICY_CREATE_COMMAND}`)) {
  throw new Error("package README missing runnable ./kizuki version or source policy setup command");
}

function run(command: string, args: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync([command, ...args], { env, stderr: "pipe", stdout: "pipe", timeout: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`compiled command failed (${args[0] ?? "kizuki"} exited ${result.exitCode})`);
  }
  return `${result.stdout}${result.stderr}`;
}
function runJson(command: string, args: string[], env: Record<string, string>): { stdout: string; stderr: string } {
  const result = Bun.spawnSync([command, ...args], { env, stderr: "pipe", stdout: "pipe", timeout: 30_000 });
  if (result.exitCode !== 0) {
    throw new Error(`compiled JSON command failed (${args[0] ?? "kizuki"} exited ${result.exitCode})`);
  }
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

interface DoctorRail {
  rail?: string;
  status?: string;
  last_result?: string | null;
  reason?: string | null;
  degraded_streak?: number;
}

interface DoctorJsonEnvelope {
  schema?: string;
  status?: string;
  degraded?: unknown[];
  warnings?: unknown[];
  data?: {
    ok?: boolean;
    problems?: unknown[];
    ledger?: { ok?: boolean };
    effective_config?: { model_ref?: string | null };
    connections?: { connector_id?: string; health?: string; problem?: string | null }[];
    memt?: { mode?: string; gpu_backend?: string; gpu_configured?: boolean; endpoint_host?: string | null };
    serve?: {
      ok?: boolean;
      failures?: unknown[];
      model?: { canon_writing?: string; model_ref?: string | null };
      stores?: { vector_layer?: { state?: string } };
      rails?: DoctorRail[];
    };
  };
}

function assertHealthyNoModelDoctor(
  raw: { stdout: string; stderr: string },
  label: string,
  options: { expectMarkdownConnection?: boolean; expectedRailState: "idle" | "ok" },
): void {
  if (raw.stderr !== "") throw new Error(`${label} doctor emitted unexpected stderr`);
  const doctor = JSON.parse(raw.stdout) as DoctorJsonEnvelope;
  if (
    doctor.schema !== "kizuki.cli.doctor/v1" ||
    doctor.status !== "ok" ||
    !Array.isArray(doctor.degraded) ||
    doctor.degraded.length !== 0 ||
    !Array.isArray(doctor.warnings) ||
    doctor.warnings.length !== 0 ||
    doctor.data?.ok !== true ||
    !Array.isArray(doctor.data.problems) ||
    doctor.data.problems.length !== 0 ||
    doctor.data.ledger?.ok !== true ||
    doctor.data.effective_config?.model_ref !== null ||
    doctor.data.serve?.ok !== true ||
    !Array.isArray(doctor.data.serve.failures) ||
    doctor.data.serve.failures.length !== 0 ||
    !Array.isArray(doctor.data.serve.rails) ||
    doctor.data.serve.model?.canon_writing !== "off" ||
    doctor.data.serve.model?.model_ref !== null ||
    doctor.data.serve.stores?.vector_layer?.state !== "off" ||
    doctor.data.memt?.mode !== "local-hybrid" ||
    doctor.data.memt?.gpu_backend !== "offline" ||
    doctor.data.memt?.gpu_configured !== false ||
    doctor.data.memt?.endpoint_host !== null
  ) {
    throw new Error(`${label} doctor did not report a clean healthy no-model vault with zero degraded flags`);
  }
  const expectedLastResult = options.expectedRailState === "idle" ? null : "ok";
  const railsById = new Map<string, DoctorRail>();
  for (const rail of doctor.data.serve.rails) {
    if (typeof rail.rail !== "string" || railsById.has(rail.rail)) {
      throw new Error(`${label} doctor reported malformed or duplicate rail entries`);
    }
    railsById.set(rail.rail, rail);
  }
  if (railsById.size !== RAIL_IDS.length) {
    throw new Error(`${label} doctor reported ${railsById.size} rails, expected ${RAIL_IDS.length}`);
  }
  for (const expectedRail of RAIL_IDS) {
    const rail = railsById.get(expectedRail);
    if (
      rail === undefined ||
      rail.status !== options.expectedRailState ||
      rail.last_result !== expectedLastResult ||
      rail.reason !== null ||
      rail.degraded_streak !== 0
    ) {
      throw new Error(
        `${label} doctor rail ${expectedRail} unhealthy: status=${String(rail?.status)} last_result=${String(rail?.last_result)} degraded_streak=${String(rail?.degraded_streak)}`,
      );
    }
  }
  if (options.expectMarkdownConnection) {
    const importedConnection = doctor.data.connections?.find(
      (connection) => connection.connector_id === "kizuki.markdown-folder",
    );
    if (importedConnection?.health !== "ok" || importedConnection.problem !== null) {
      throw new Error(`${label} doctor did not report a healthy markdown-folder connection`);
    }
  }
}

function assertCleanEnvelope(
  raw: { stdout: string; stderr: string },
  expectedSchema: string,
  label: string,
): { stdout: string; envelope: { schema?: string; status?: string; degraded?: unknown[]; warnings?: unknown[]; data?: unknown } } {
  if (raw.stderr !== "") throw new Error(`${label} emitted unexpected stderr`);
  const envelope = JSON.parse(raw.stdout) as { schema?: string; status?: string; degraded?: unknown[]; warnings?: unknown[]; data?: unknown };
  if (
    envelope.schema !== expectedSchema ||
    envelope.status !== "ok" ||
    !Array.isArray(envelope.degraded) ||
    envelope.degraded.length !== 0 ||
    !Array.isArray(envelope.warnings) ||
    envelope.warnings.length !== 0
  ) {
    throw new Error(`${label} reported degraded or warning state`);
  }
  return { stdout: raw.stdout, envelope };
}

function assertContextPacket(
  raw: { stdout: string; stderr: string },
  expectedText: string,
  label: string,
): void {
  const { envelope } = assertCleanEnvelope(raw, "kizuki.cli.context/v1", label);
  const packetMd = (envelope.data as { data?: { packet_md?: unknown } } | undefined)?.data?.packet_md;
  if (typeof packetMd !== "string" || !packetMd.includes(expectedText)) {
    throw new Error(`${label} packet_md is missing expected fixture text`);
  }
}

/**
 * A world_view envelope for an empty concept discovery: a no-model vault admits no Concepts. The
 * imported note is not consolidated either, so the read must say so (incomplete, with a
 * pending_consolidation gap) rather than claim the empty answer is complete.
 */
function requireConceptDiscovery(envelope: unknown, surface: string): void {
  const view = envelope as { schema?: string; tool?: string; data?: { schema?: string; operation?: string;
    result?: { status?: string; data?: { schema?: string; matches?: unknown; coverage?: { status?: string; gaps?: unknown } } } } };
  const data = view.data?.result?.data;
  if (view.schema !== "kizuki.envelope/v2" || view.tool !== "world_view" || view.data?.schema !== "kizuki.world-view/v1" ||
      view.data.operation !== "find_concepts" || view.data.result?.status !== "incomplete" ||
      data?.schema !== "kizuki.concept-matches/v1" || !Array.isArray(data.matches) ||
      data.coverage?.status !== "partial" || !Array.isArray(data.coverage.gaps) ||
      !data.coverage.gaps.includes("pending_consolidation")) {
    throw new Error(`${surface} world find_concepts smoke failed`);
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

  // The binary identifies its exact build: BUILD.json's revision, and a compiled-in build time.
  const versionLine = run(cli, ["version"], env).trim();
  const identity = versionLine.match(/^(\S+) source=([0-9a-f]{40}) built=(\S+)$/);
  if (
    identity === null ||
    identity[1] !== version ||
    identity[2] !== build.source_sha ||
    !isValidBuildTimestamp(identity[3]!)
  ) {
    throw new Error("CLI version does not identify the packaged build");
  }
  const help = run(cli, ["--help"], env);
  if (!help.includes("usage: kizuki")) throw new Error("CLI help missing");
  for (const argv of Object.values(PACKAGED_CLI_COMMANDS)) {
    const verb = argv[1];
    if (verb === undefined || !help.includes(verb)) throw new Error(`compiled help missing packaged verb ${verb}`);
  }
  const serveHelp = run(cli, ["help", "serve"], env);
  if (!serveHelp.includes("serve stop") || !serveHelp.includes("--install") || !serveHelp.includes("--uninstall")) {
    throw new Error("compiled serve help missing stop/install/uninstall");
  }
  const catalog = JSON.parse(run(cli, ["connect", "--json"], env)) as {
    data: { sources: { id: string; available: boolean }[] };
  };
  if (!catalog.data.sources.some((source) => source.id === "kizuki.beeper" && source.available)) {
    throw new Error("Beeper is missing from the compiled connection catalog");
  }
  run(cli, ["init", vault, "--no-service"], env);
  assertHealthyNoModelDoctor(runJson(cli, ["doctor", "--json", "--vault", vault], env), "fresh-init", {
    expectedRailState: "idle",
  });
  if (existsSync(join(vault, ".kizuki", "memt", "registry.sqlite"))) {
    throw new Error("fresh-init doctor created memt registry on untouched vault");
  }
  const policy = join(rootTemp, "source-policy.json");
  writeFileSync(policy, JSON.stringify(PACKAGED_SOURCE_POLICY), { mode: 0o600 });
  run(cli, ["import", "markdown-folder", "--source", notes, "--vault", vault,
    "--policy", policy, "--expected-revision", "0", "--operation-id", "release-smoke-consent"], env);
  const query = assertCleanEnvelope(
    runJson(cli, ["query", "Ada", "--json", "--vault", vault], env),
    "kizuki.cli.query/v1",
    "imported query",
  );
  if (!query.stdout.includes("Ada")) {
    throw new Error("imported note was not queryable");
  }
  assertHealthyNoModelDoctor(
    runJson(cli, ["doctor", "--json", "--vault", vault], env),
    "imported",
    { expectMarkdownConnection: true, expectedRailState: "idle" },
  );
  assertContextPacket(
    runJson(cli, ["context", "--query", "Ada", "--json", "--vault", vault], env),
    "Ada met Grace at the library.",
    "imported context",
  );
  const memtStatus = JSON.parse(runJson(cli, ["memt", "status", "--json", "--vault", vault], env).stdout) as {
    schema?: string;
    status?: string;
    data?: {
      subcommand?: string;
      mode?: string;
      gpu_backend?: string;
      experiences?: { total?: number; uninternalized?: number };
      snapshots?: { total?: number };
    };
  };
  if (
    memtStatus.schema !== "kizuki.cli.memt/v1" ||
    memtStatus.status !== "ok" ||
    memtStatus.data?.subcommand !== "status" ||
    memtStatus.data?.mode !== "local-hybrid" ||
    memtStatus.data?.gpu_backend !== "offline" ||
    memtStatus.data?.experiences?.total !== 0 ||
    memtStatus.data?.snapshots?.total !== 0 ||
    existsSync(join(vault, ".kizuki", "memt", "registry.sqlite"))
  ) {
    throw new Error("compiled memt status smoke failed");
  }
  const world = JSON.parse(runJson(cli, ["world", "--operation", "find_concepts", "--json", "--vault", vault], env).stdout) as
    { schema?: string; status?: string; data?: unknown };
  if (world.schema !== "kizuki.cli.world/v1" || world.status !== "ok") throw new Error("compiled world command smoke failed");
  requireConceptDiscovery(world.data, "compiled CLI");
  run(cli, ["serve", "--once", "--no-http", "--vault", vault], env);
  assertHealthyNoModelDoctor(
    runJson(cli, ["doctor", "--json", "--vault", vault], env),
    "post-serve-once",
    { expectMarkdownConnection: true, expectedRailState: "ok" },
  );
  const exported = join(rootTemp, "export");
  const restored = join(rootTemp, "restored");
  run(cli, ["export", "--out", exported, "--vault", vault], env);
  run(cli, ["restore", "--from", exported, "--verify"], env);
  run(cli, ["restore", "--from", exported, "--into", restored], env);
  assertHealthyNoModelDoctor(
    runJson(cli, ["doctor", "--json", "--vault", restored], env),
    "restored",
    { expectMarkdownConnection: true, expectedRailState: "idle" },
  );
  const restoredQuery = assertCleanEnvelope(
    runJson(cli, ["query", "Ada", "--json", "--vault", restored], env),
    "kizuki.cli.query/v1",
    "restored query",
  );
  if (!restoredQuery.stdout.includes("Ada")) throw new Error("restored vault was not queryable");
  assertContextPacket(
    runJson(cli, ["context", "--query", "Ada", "--json", "--vault", restored], env),
    "Ada met Grace at the library.",
    "restored context",
  );
  run(cli, ["serve", "--install", "--vault", vault], env);
  run(cli, ["serve", "--uninstall", "--vault", vault], env);
  if (!existsSync(join(vault, ".kizuki"))) throw new Error("uninstall removed the vault");
  const afterUninstall = assertCleanEnvelope(
    runJson(cli, ["query", "Ada", "--json", "--vault", vault], env),
    "kizuki.cli.query/v1",
    "post-uninstall query",
  );
  if (!afterUninstall.stdout.includes("Ada")) throw new Error("uninstall did not preserve queryable vault data");

  // Exercise the printed terminal quick-start sequence verbatim in a clean PATH=/usr/bin:/bin shell from the package folder.
  const quickstartRoot = join(rootTemp, "quickstart");
  const quickstartWorkspace = join(quickstartRoot, "workspace");
  const quickstartNotes = join(quickstartRoot, "notes");
  const quickstartPolicy = join(quickstartRoot, "policy.json");
  mkdirSync(quickstartRoot, { mode: 0o700 });
  mkdirSync(quickstartNotes, { mode: 0o700 });
  writeFileSync(join(quickstartNotes, "note.md"), "Acme release onboarding check.\n", "utf8");
  const quickstartEnv = {
    PATH: "/usr/bin:/bin",
    HOME: join(quickstartRoot, "home"),
    XDG_CONFIG_HOME: join(quickstartRoot, "xdg"),
    KIZUKI_CONFIG: join(quickstartRoot, "config.toml"),
    KIZUKI_SUPERVISOR: "none",
  };
  const substituteQuickstart = (line: string): string =>
    line
      .replaceAll("/absolute/workspace", quickstartWorkspace)
      .replaceAll("/absolute/notes", quickstartNotes)
      .replaceAll("/absolute/policy.json", quickstartPolicy);
  const quickstartScript = [
    "./kizuki version",
    PACKAGED_POLICY_CREATE_COMMAND,
    PACKAGED_CLI_COMMANDS.init.join(" "),
    PACKAGED_CLI_COMMANDS.import.join(" "),
    PACKAGED_CLI_COMMANDS.query.join(" "),
    PACKAGED_CLI_COMMANDS.doctor.join(" "),
  ]
    .map(substituteQuickstart)
    .join("\n");
  const quickstartRun = Bun.spawnSync(["/bin/sh", "-eu", "-c", quickstartScript], {
    cwd: release,
    env: quickstartEnv,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 60_000,
  });
  const quickstartStdout = quickstartRun.stdout.toString();
  const quickstartStderr = quickstartRun.stderr.toString();
  if (
    quickstartRun.exitCode !== 0 ||
    !quickstartStdout.includes(versionLine) ||
    !quickstartStdout.includes("Acme release onboarding check.")
  ) {
    throw new Error(
      `printed terminal quick-start sequence failed (exit ${quickstartRun.exitCode}): ${quickstartStderr}`,
    );
  }
  assertHealthyNoModelDoctor(
    runJson(cli, ["doctor", "--json", "--vault", quickstartWorkspace], quickstartEnv),
    "quickstart",
    { expectMarkdownConnection: true, expectedRailState: "idle" },
  );

  // Exercise the documented zero-friction local PATH symlink install in the temp HOME.
  const localBin = join(env.HOME, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  symlinkSync(cli, join(localBin, "kizuki"));
  symlinkSync(mcp, join(localBin, "kizuki-mcp"));
  const symlinkEnv = { ...env, PATH: `${localBin}:${env.PATH}` };
  if (run("kizuki", ["version"], symlinkEnv).trim() !== versionLine) {
    throw new Error("local PATH symlink kizuki version mismatch");
  }
  const symlinkMcp = await mcpSession("kizuki-mcp", symlinkEnv, ["--vault", vault, "--owner"], [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-smoke-symlink","version":"0"}}}',
  ]);
  if (symlinkMcp.code !== 0 || !symlinkMcp.output.includes('"protocolVersion"')) {
    throw new Error("local PATH symlink kizuki-mcp initialize failed");
  }

  const grant = join(rootTemp, "agent-grant.json");
  const credential = join(rootTemp, "agent-credential");
  writeFileSync(grant, JSON.stringify({ ceiling: "private", types: null, subjects: null, since: null, until: null,
    tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false }), { mode: 0o600 });
  const agentArgs = ["agent", "add", "reader-private", "--grant", grant, "--token-ref", `file:${credential}`,
    "--operation-id", "releaseagent01", "--vault", vault, "--json"];
  // Every host admitted by the closed release registry must support scoped agents.
  const added = runJson(cli, agentArgs, env);
  const replayed = runJson(cli, agentArgs, env);
  const envelope = JSON.parse(readFileSync(credential, "utf8")) as { token: string };
  type Enrollment = { schema?: string; status?: string; authority?: string; credential?: string; agent_id?: string | null; replayed?: boolean };
  const first = JSON.parse(added.stdout) as { schema?: string; status?: string; data?: Enrollment };
  const retry = JSON.parse(replayed.stdout) as { schema?: string; status?: string; data?: Enrollment };
  if (typeof envelope.token !== "string" || first.schema !== "kizuki.cli.agent/v1" || first.status !== "ok" || first.data?.schema !== "kizuki.agent-enrollment/v1" ||
      first.data.status !== "completed" || first.data.authority !== "active" || first.data.credential !== "ready" || retry.schema !== "kizuki.cli.agent/v1" || retry.status !== "ok" ||
      retry.data?.schema !== "kizuki.agent-enrollment/v1" || retry.data.status !== "completed" || retry.data.authority !== "active" || retry.data.credential !== "ready" || retry.data.replayed !== true ||
      first.data.agent_id === null || first.data.agent_id === undefined || first.data.agent_id !== retry.data.agent_id || `${added.stdout}${added.stderr}${replayed.stdout}${replayed.stderr}`.includes(envelope.token) ||
      `${added.stdout}${added.stderr}${replayed.stdout}${replayed.stderr}`.includes(credential)) throw new Error("agent enrollment smoke failed");
  const agentRequests = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-smoke","version":"0"}}}',
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}',
    '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search","arguments":{"query":"Ada","scope":"all"}}}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_page","arguments":{"path":"missing.md"}}}',
  ];
  const agentSession = await mcpSession(mcp, env, ["--vault", vault, "--token-ref", `file:${credential}`], agentRequests);
  const responses = agentSession.output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { id?: number; result?: unknown });
  if (agentSession.code !== 0 || !responses.some(response => response.id === 2 && JSON.stringify(response.result).includes("Ada")) ||
      !responses.some(response => response.id === 3 && JSON.stringify(response.result).includes("tool_not_granted")) ||
      `${agentSession.output}${agentSession.diagnostics}`.includes(envelope.token) || `${agentSession.output}${agentSession.diagnostics}`.includes(credential)) throw new Error("agent MCP authorization smoke failed");
  const secondSession = await mcpSession(mcp, env, ["--vault", vault, "--token-ref", `file:${credential}`], agentRequests.slice(0, 3));
  if (secondSession.code !== 0 || !secondSession.output.includes("Ada") || `${secondSession.output}${secondSession.diagnostics}`.includes(envelope.token) || `${secondSession.output}${secondSession.diagnostics}`.includes(credential)) throw new Error("second agent MCP session failed");
  const revoked = runJson(cli, ["agent", "revoke", "reader-private", "--vault", vault, "--json"], env);
  const revokedResult = JSON.parse(revoked.stdout) as { schema?: string; status?: string; data?: Enrollment };
  if (revokedResult.schema !== "kizuki.cli.agent/v1" || revokedResult.status !== "ok" || revokedResult.data?.authority !== "revoked" || `${revoked.stdout}${revoked.stderr}`.includes(envelope.token) || `${revoked.stdout}${revoked.stderr}`.includes(credential)) throw new Error("agent revocation smoke failed");
  const rejected = await mcpSession(mcp, env, ["--vault", vault, "--token-ref", `file:${credential}`], [agentRequests[0]!]);
  if (rejected.code === 0 || `${rejected.output}${rejected.diagnostics}`.includes(envelope.token) || `${rejected.output}${rejected.diagnostics}`.includes(credential)) throw new Error("revoked credential reconnected");

  const expectedMcpTools = [
    "search",
    "get_page",
    "query_entities",
    "timeline",
    "context_packet",
    "graph_neighbors",
    "system_health",
    "world_view",
    "propose",
    "correct",
    "memt_status",
    "memt_recall",
    "memt_experience",
    "memt_snapshot",
  ] as const;
  const ownerSession = await mcpSession(mcp, env, ["--vault", vault, "--owner"], [
    agentRequests[0]!,
    agentRequests[1]!,
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"world_view","arguments":{"operation":"find_concepts","label":"","valid":{"kind":"all"},"knownAt":{"kind":"current"}}}}',
    '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"memt_status","arguments":{}}}',
  ]);
  if (ownerSession.code !== 0) throw new Error("owner MCP smoke failed");
  if (!ownerSession.output.includes('"tools"')) throw new Error("MCP tools/list did not respond");
  const ownerResponses = ownerSession.output.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as {
    id?: number;
    result?: {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
      tools?: { name?: string }[];
    };
  });
  const listedTools = ownerResponses.find(response => response.id === 2)?.result?.tools?.map(tool => tool.name) ?? [];
  if (
    listedTools.length !== expectedMcpTools.length ||
    expectedMcpTools.some(name => !listedTools.includes(name))
  ) {
    throw new Error(`MCP tools/list mismatch: expected ${expectedMcpTools.length} tools, got ${listedTools.length} (${listedTools.join(", ")})`);
  }
  const worldResponse = ownerResponses.find(response => response.id === 3)?.result;
  if (worldResponse === undefined || worldResponse.isError === true) throw new Error("MCP world_view smoke failed");
  requireConceptDiscovery(worldResponse.structuredContent, "compiled MCP");
  const memtResponse = ownerResponses.find(response => response.id === 4)?.result;
  if (
    memtResponse === undefined ||
    memtResponse.isError === true ||
    memtResponse.structuredContent?.["schema"] !== "kizuki.memt-status/v1" ||
    memtResponse.structuredContent?.["mode"] !== "local-hybrid"
  ) {
    throw new Error("MCP memt_status smoke failed");
  }

  verifyPackageDirectory(release, build);
  process.stdout.write(`release smoke passed: ${release}\n`);
} finally {
  rmSync(rootTemp, { force: true, recursive: true });
}
