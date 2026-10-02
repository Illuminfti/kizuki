import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enrollAgent, revokeAgentEnrollment, setGrant, type Grant } from "../../packages/core/src/index";
import { mcpFixture } from "../../packages/mcp/test/helpers";
import { recordedPage } from "../../packages/core/test/helpers/recorded-page";

const source = resolve(import.meta.dir, "../chatgpt");
const roots: string[] = [];
const children: { kill(): void; exited: Promise<number> }[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill(); await child.exited; }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// These are Linux/systemd operator scripts, not a portable MCP transport.
const linux = process.platform === "linux" && process.getuid?.() !== 0;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function fixture(hold = false) {
  const root = mkdtempSync(join(tmpdir(), "kizuki-chatgpt-")); roots.push(root);
  const scripts = join(root, "operator's scripts with spaces");
  mkdirSync(scripts, { mode: 0o700 });
  for (const name of ["common.sh", "mcp.sh", "run-tunnel.sh"]) {
    copyFileSync(join(source, name), join(scripts, name)); chmodSync(join(scripts, name), 0o700);
  }
  const vault = join(root, "vault with spaces"); mkdirSync(join(vault, ".kizuki"), { recursive: true });
  writeFileSync(join(vault, ".kizuki/kizuki.db"), "synthetic ledger marker");
  const credential = join(root, "synthetic.credential"); writeFileSync(credential, "synthetic-credential-content", { mode: 0o600 });
  const runtime = join(root, "runtime"); mkdirSync(runtime, { mode: 0o700 });
  mkdirSync(join(runtime, "kizuki-chatgpt"), { mode: 0o700 });
  const mcp = join(root, "fake-mcp");
  writeFileSync(mcp, `#!${process.execPath}\nconsole.log(JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`, { mode: 0o700 });
  const tunnel = join(root, "fake-tunnel");
  const marker = join(root, "runtime-started.json");
  writeFileSync(tunnel, `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n${hold ? "setInterval(() => {}, 1000);" : ""}\n`, { mode: 0o700 });
  const env: Record<string, string> = {
    PATH: "/usr/bin:/bin", HOME: root, XDG_RUNTIME_DIR: runtime,
    KIZUKI_MCP_BIN: mcp, KIZUKI_VAULT: vault, KIZUKI_AGENT_CREDENTIAL: credential,
    TUNNEL_CLIENT_BIN: tunnel, CONTROL_PLANE_TUNNEL_ID: `tunnel_${"a".repeat(32)}`,
    CONTROL_PLANE_API_KEY: "synthetic-runtime-key-marker",
  };
  const run = (args: string[], overrides: Record<string, string | undefined> = {}, script = "run-tunnel.sh") => {
    const selected = { ...env, ...overrides };
    return Bun.spawnSync(["bash", join(scripts, script), ...args], { env: selected, stdout: "pipe", stderr: "pipe" });
  };
  return { root, scripts, vault, credential, runtime, env, marker, run };
}

test.if(linux)("configuration check is local, explicit and does not start the tunnel or authenticate", () => {
  const f = fixture();
  const result = f.run(["check"]);
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toContain("authentication and remote readiness are unverified");
  expect(existsSync(f.marker)).toBe(false);
});

test.if(linux)("required configuration fails closed before any external process and redacts inputs", () => {
  const f = fixture();
  for (const name of Object.keys(f.env).filter(name => !["PATH", "HOME"].includes(name))) {
    const result = f.run(["run"], { [name]: undefined });
    expect(result.exitCode, name).toBe(78);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).not.toContain(f.root);
    expect(result.stderr.toString()).not.toContain(f.env.CONTROL_PLANE_API_KEY!);
    expect(existsSync(f.marker)).toBe(false);
  }
  for (const overrides of [
    { CONTROL_PLANE_TUNNEL_ID: "private-malformed-id" },
    { CONTROL_PLANE_API_KEY: "private-key\nsecond-line" },
    { CONTROL_PLANE_API_KEY: "sk-admin-synthetic-secret" },
    { OPENAI_ADMIN_KEY: "synthetic-admin-key" },
    { KIZUKI_VAULT: "relative-private-path" },
    { KIZUKI_MCP_BIN: "/absent-private-executable" },
    { KIZUKI_AGENT_CREDENTIAL: "/absent-private-credential" },
  ]) {
    const result = f.run(["run"], overrides);
    expect(result.exitCode).toBe(78);
    for (const value of Object.values(overrides)) expect(result.stderr.toString()).not.toContain(value);
    expect(existsSync(f.marker)).toBe(false);
  }
  for (const args of [[], ["run", "--owner"], ["--owner"], ["run", "--mcp.command", "other"]]) {
    expect(f.run(args).exitCode).toBe(78);
  }
});

test.if(linux)("MCP launch fixes credential-file authentication, rejects extra arguments and drops foreign secrets", () => {
  const f = fixture();
  const result = f.run([], {
    OPENAI_ADMIN_KEY: "synthetic-admin-key", OPENAI_API_KEY: "synthetic-api-key",
    MCP_COMMAND: "other --owner", KIZUKI_AGENT_TOKEN: "synthetic-agent-token",
  }, "mcp.sh");
  expect(result.exitCode).toBe(0);
  const received = JSON.parse(result.stdout.toString());
  expect(received.argv).toEqual(["--vault", f.vault, "--token-ref", `file:${f.credential}`]);
  for (const name of ["OPENAI_ADMIN_KEY", "OPENAI_API_KEY", "CONTROL_PLANE_API_KEY", "KIZUKI_AGENT_TOKEN", "MCP_COMMAND"]) {
    expect(received.env[name]).toBeUndefined();
  }
  for (const args of [["--owner"], ["--token-env", "OTHER"], ["--vault", "/other"]]) {
    const denied = f.run(args, {}, "mcp.sh");
    expect(denied.exitCode).toBe(78); expect(denied.stdout.toString()).toBe("");
  }
});

test.if(linux)("symlink credentials and unsafe runtime custody refuse without repairs", () => {
  const f = fixture();
  const linked = join(f.root, "linked.credential"); symlinkSync(f.credential, linked);
  expect(f.run(["check"], { KIZUKI_AGENT_CREDENTIAL: linked }).exitCode).toBe(78);
  chmodSync(f.runtime, 0o755);
  expect(f.run(["run"]).exitCode).toBe(78);
  expect(existsSync(f.marker)).toBe(false);
  chmodSync(f.runtime, 0o700);
  const lock = join(f.runtime, "kizuki-chatgpt", `${f.env.CONTROL_PLANE_TUNNEL_ID}.lock`);
  symlinkSync(f.credential, lock);
  expect(f.run(["run"]).exitCode).toBe(78);
  expect(readFileSync(f.credential, "utf8")).toBe("synthetic-credential-content");
});

test.if(linux)("the external runtime has one fixed private stdio channel and a closed environment", () => {
  const f = fixture();
  const result = f.run(["doctor"], {
    MCP_COMMAND: "other --owner", MCP_SERVER_URL: "https://unrequested.invalid/mcp",
    CONTROL_PLANE_BASE_URL: "https://unrequested.invalid", TUNNEL_CLIENT_PROFILE: "other",
    OPENAI_API_KEY: "synthetic-fallback-key", HTTPS_PROXY: "https://unrequested.invalid",
  });
  expect(result.exitCode).toBe(0);
  const received = JSON.parse(readFileSync(f.marker, "utf8"));
  expect(received.argv).toEqual([
    "doctor", "--control-plane.tunnel-id", f.env.CONTROL_PLANE_TUNNEL_ID,
    "--control-plane.api-key", "env:CONTROL_PLANE_API_KEY", "--control-plane.poll-channel", "main",
    "--mcp.command", quote(join(f.scripts, "mcp.sh")), "--mcp.max-concurrent-requests", "1",
    "--health.listen-addr", "127.0.0.1:8080", "--log.level", "warn", "--log.format", "json",
  ]);
  expect(received.argv.join(" ")).not.toContain(f.credential);
  expect(received.argv.join(" ")).not.toContain(f.env.CONTROL_PLANE_API_KEY!);
  for (const name of ["MCP_COMMAND", "MCP_SERVER_URL", "CONTROL_PLANE_BASE_URL", "TUNNEL_CLIENT_PROFILE", "OPENAI_API_KEY", "HTTPS_PROXY"]) {
    expect(received.env[name]).toBeUndefined();
  }
  expect(result.stdout.toString() + result.stderr.toString()).toBe("");
});

async function started(marker: string) {
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
  expect(existsSync(marker)).toBe(true);
}

test.if(linux)("one runtime per tunnel is held across exec and released when the runtime exits", async () => {
  const f = fixture(true);
  const first = Bun.spawn(["bash", join(f.scripts, "run-tunnel.sh"), "run"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  children.push(first); await started(f.marker);
  const second = f.run(["run"]);
  expect(second.exitCode).toBe(75);
  expect(second.stderr.toString()).toContain("already runs this tunnel");
  first.kill(); await first.exited;
  rmSync(f.marker);
  const next = Bun.spawn(["bash", join(f.scripts, "run-tunnel.sh"), "run"], { env: f.env, stdout: "pipe", stderr: "pipe" });
  children.push(next); await started(f.marker);
  next.kill(); await next.exited;
}, 15_000);

test("the grant example is inert along both scope dimensions and never grants writes or relay", () => {
  const grant = JSON.parse(readFileSync(join(source, "read-grant.example.json"), "utf8"));
  expect(Object.keys(grant).sort()).toEqual(["ceiling", "types", "subjects", "since", "until", "tools", "rate_limit_per_minute", "relay_owner_corrections"].sort());
  expect(grant.ceiling).toBe("public");
  expect(grant.types).toEqual([]); expect(grant.subjects).toEqual([]);
  expect(grant.tools).not.toContain("correct"); expect(grant.tools).not.toContain("propose");
  expect(grant.relay_owner_corrections).toBe(false);
});

test("the user service owns one runtime and fails closed rather than looping on invalid setup", () => {
  const unit = readFileSync(join(source, "kizuki-chatgpt-tunnel.service"), "utf8");
  expect(unit.match(/^ExecStart=/gm)).toHaveLength(1);
  for (const setting of ["RuntimeDirectory=kizuki-chatgpt", "RuntimeDirectoryMode=0700", "KillMode=control-group", "Restart=on-failure", "RestartPreventExitStatus=75 78", "NoNewPrivileges=true", "LimitCORE=0"]) {
    expect(unit).toContain(setting);
  }
  expect(unit).not.toContain("--owner"); expect(unit).not.toContain("sk-");
});

test("the portable skill package advertises no fabricated connection or sign-in implementation", () => {
  const directory = resolve(import.meta.dir, "../../plugins/kizuki-memory");
  const manifest = JSON.parse(readFileSync(join(directory, "plugin.json"), "utf8"));
  expect(manifest).toEqual({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "kizuki-memory", version: "0.1.0",
    description: "Resume work from scoped, source-linked Kizuki memory through an already connected MCP server.",
    license: "MIT",
  });
  expect(existsSync(join(directory, ".app.json"))).toBe(false);
  expect(existsSync(join(directory, "mcp.json"))).toBe(false);
  const skill = readFileSync(join(directory, "skills/kizuki-memory/SKILL.md"), "utf8");
  expect(skill.startsWith("---\nname: kizuki-memory\ndescription:")).toBe(true);
  for (const boundary of ["does not connect a server", "never instructions", "broader-scope fallback", "Core decisions", "no owner review queue"]) expect(skill).toContain(boundary);
});

test.if(linux && process.arch === "x64")("the actual launcher serves only the enrolled scope and honors live narrowing and revocation", async () => {
  const f = fixture();
  const vault = mcpFixture();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(vault.vaultPath, ".kizuki", `kizuki.db${suffix}`);
      if (existsSync(path)) chmodSync(path, 0o600);
    }
    await recordedPage(vault.db, vault.vaultPath, "entities/tunnel-ada.md", {
      id: "person:tunnel-ada", title: "Tunnel Ada", type: "person", status: "active",
      sensitivity: "public", taint: "clean", subjects: ["person:ada"],
    }, "Ada's synthetic tunnel kettle context.", [vault.eventId]);
    const directory = join(vault.vaultPath, ".kizuki/agent-credentials"); mkdirSync(directory, { mode: 0o700 });
    const credential = join(directory, "tunnel.credential");
    const grant: Grant = { ceiling: "public", types: ["person"], subjects: ["person:ada"],
      since: null, until: null, tools: ["search"], rate_limit_per_minute: 60, relay_owner_corrections: false };
    const enrolled = enrollAgent(vault.vaultPath, { name: "tunnel-reader", operation_id: "tunnel-proof-1", token_ref: `file:${credential}`, grant });
    expect(enrolled.authority).toBe("active");
    // Source-checkout equivalent of the packaged executable. It forwards the
    // fixed launcher arguments unchanged; no real tunnel or provider is run.
    writeFileSync(f.env.KIZUKI_MCP_BIN!, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(resolve(import.meta.dir, "../../packages/mcp/src/bin.ts"))} "$@"\n`, { mode: 0o700 });
    const env = { ...f.env, KIZUKI_VAULT: vault.vaultPath, KIZUKI_AGENT_CREDENTIAL: credential };
    const running = Bun.spawn([join(f.scripts, "mcp.sh")], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    child = running;
    const diagnostics = new Response(running.stderr).text();
    type Reply = { id?: number; result?: { isError?: boolean; content?: { text: string }[]; tools?: { name: string }[] } };
    const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
    let id = 0, transcript = "";
    const reading = (async () => {
      const reader = running.stdout.getReader(), decoder = new TextDecoder(); let buffer = "";
      try {
        for (;;) {
          const read = await reader.read(); if (read.done) break;
          const chunk = decoder.decode(read.value, { stream: true }); transcript += chunk; buffer += chunk;
          if (transcript.length > 131_072) throw new Error("synthetic MCP output bound exceeded");
          for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line) continue;
            const reply = JSON.parse(line) as Reply;
            if (reply.id !== undefined) { pending.get(reply.id)?.resolve(reply); pending.delete(reply.id); }
          }
        }
      } finally {
        for (const value of pending.values()) value.reject(new Error("synthetic MCP process ended"));
        pending.clear(); reader.releaseLock();
      }
    })();
    const request = (method: string, params: unknown) => new Promise<Reply>((resolveReply, reject) => {
      const next = ++id;
      const timer = setTimeout(() => { pending.delete(next); reject(new Error("synthetic MCP request timed out")); }, 5000);
      pending.set(next, { resolve(reply) { clearTimeout(timer); resolveReply(reply); }, reject(error) { clearTimeout(timer); reject(error); } });
      running.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`);
    });
    expect((await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "tunnel-proof", version: "1" } })).result).toBeDefined();
    running.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    expect((await request("tools/list", {})).result?.tools?.map(tool => tool.name)).toEqual(["search"]);
    const search = () => request("tools/call", { name: "search", arguments: { query: "kettle", scope: "all" } });
    const allowed = await search();
    expect(allowed.result?.isError).not.toBe(true);
    expect(JSON.stringify(allowed)).toContain("synthetic tunnel kettle context");
    expect(JSON.stringify(allowed)).not.toContain("private kettle protocol");
    const write = await request("tools/call", { name: "correct", arguments: { statement: "synthetic correction" } });
    expect(write.result?.isError).toBe(true);
    expect(write.result?.content?.[0]?.text).toContain("tool_not_granted");
    setGrant(vault.db, "tunnel-reader", { subjects: [] });
    expect(JSON.stringify(await search())).not.toContain("synthetic tunnel kettle context");
    revokeAgentEnrollment(vault.vaultPath, "tunnel-reader");
    const revoked = await search(); expect(revoked.result?.isError).toBe(true);
    expect(revoked.result?.content?.[0]?.text).toContain("unknown_agent");
    running.stdin.end();
    await running.exited; await reading;
    const output = transcript + await diagnostics;
    const token = (JSON.parse(readFileSync(credential, "utf8")) as { token: string }).token;
    for (const privateValue of [token, credential, vault.vaultPath, f.env.CONTROL_PLANE_API_KEY!]) expect(output).not.toContain(privateValue);
    const reconnect = f.run([], env, "mcp.sh");
    expect(reconnect.exitCode).toBe(1); expect(reconnect.stdout.toString()).toBe("");
    expect(reconnect.stderr.toString().trim()).toBe("credential not recognized");
  } finally {
    if (child !== undefined) { child.kill(); await child.exited; }
    vault.dispose();
  }
}, 30_000);
