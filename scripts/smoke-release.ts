import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { verifyChecksumManifest } from "./release-artifacts";

const root = resolve(import.meta.dir, "..");
const version = (await Bun.file(resolve(root, "packages/cli/package.json")).json() as {
  version: string;
}).version;
const release = resolve(root, "dist", `kizuki-${version}`, "bun-linux-x64-baseline");
const cli = join(release, "kizuki");
const mcp = join(release, "kizuki-mcp");

for (const required of [cli, mcp, join(release, "SHA256SUMS"), join(release, "README.txt"), join(release, "BUILD.json")]) {
  if (!existsSync(required)) throw new Error(`release artifact is missing: ${required}`);
}

function run(command: string, args: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync([command, ...args], { env, stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited ${result.exitCode}: ${result.stderr}`);
  }
  return `${result.stdout}${result.stderr}`;
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
  run(cli, ["import", "markdown-folder", "--source", notes, "--vault", vault], env);
  const query = run(cli, ["query", "Ada", "--vault", vault], env);
  if (!query.includes("Ada")) {
    throw new Error(`imported note was not queryable: ${query}`);
  }
  const context = run(cli, ["context", "--query", "Ada", "--vault", vault], env);
  if (!context.includes("Ada")) throw new Error("imported note is missing from compiled context");
  run(cli, ["serve", "--once", "--no-http", "--vault", vault], env);

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
