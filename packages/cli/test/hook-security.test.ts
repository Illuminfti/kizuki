import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { accept, readBootId } from "@kizuki/core";
import { openLedger } from "@kizuki/core/testing";
import { MAX_HOOK_OUTPUT_BYTES, runSessionStart } from "../src/hook/session-start";
import { cliArgs } from "../src/runtime";
import { createHelpers } from "./helpers";

setDefaultTimeout(120_000);
const { cleanup, isolatedEnv, tempDir, tempVault, runCli } = createHelpers();
afterEach(cleanup);
const main = resolve(import.meta.dir, "../src/main.ts");
const password = "synthetic" + "Password7XYZ";
const credential = ["ghp", "B".repeat(36)].join("_");
const secretNote = `Atlas note. DB_PASSWORD=${password} GITHUB_TOKEN=${credential}`;
const controls = "\x1b]0;title\x07\x1b[2J\x1b]52;c;QUJD\x07\x9b2J\x9d52;c;QUJD\x9c\x1c\x1d\x1e";

function seeded(text = secretNote) {
  const f = tempVault();
  const db = openLedger(join(f.vault, ".kizuki", "kizuki.db"));
  try {
    const at = new Date().toISOString();
    expect(accept(db, { schema: "kizuki.event/v1", connector_id: "fixture", source_record_id: "note",
      kind: "note", occurred_at: at, observed_at: at, text, subjects: [], attachments: [], metadata: {},
      sensitivity_hint: "personal", deleted: false }).status).toBe("stored");
  } finally { db.close(); }
  return f;
}

function enroll(f: ReturnType<typeof seeded>) {
  const grant = join(f.root, "grant.json");
  writeFileSync(grant, JSON.stringify({ ceiling: "personal", types: null, subjects: null, since: null, until: null,
    tools: ["context_packet"], rate_limit_per_minute: 60, relay_owner_corrections: false }));
  const ref = `file:${join(f.root, "helper.credential")}`;
  const enrolled = runCli(f.env, "--vault", f.vault, "agent", "add", "helper", "--grant", grant,
    "--token-ref", ref, "--operation-id", "hook-security-enroll", "--json");
  expect(enrolled.exitCode, enrolled.stderr).toBe(0);
  return { token: (JSON.parse(readFileSync(ref.slice(5), "utf8")) as { token: string }).token, ref };
}

async function hook(env: Record<string, string | undefined>, args: readonly string[], cwd?: string, launcher = false) {
  const argv = ["hook", "session-start",
    ...(args.includes("--harness") ? [] : ["--harness", "generic"]),
    ...(args.includes("--timeout-ms") ? [] : ["--timeout-ms", "60000"]), ...args];
  const child = Bun.spawn(launcher ? cliArgs(argv) : [process.execPath, main, ...argv], {
    env: { ...process.env, ...env }, ...(cwd === undefined ? {} : { cwd }), stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { code, stdout, stderr };
}

function daemon(vault: string, respond: () => Response) {
  let requests = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return respond(); } });
  const instance = "11111111-1111-4111-8111-111111111111";
  const state = join(vault, ".kizuki");
  writeFileSync(join(state, "serve.pid"), JSON.stringify({ pid: process.pid, boot_id: readBootId(), instance_id: instance }), { mode: 0o600 });
  writeFileSync(join(state, "serve.endpoint"), JSON.stringify({ schema: "kizuki.serve-endpoint/v1", host: "127.0.0.1", port: server.port, instance_id: instance }), { mode: 0o600 });
  writeFileSync(join(state, "serve.token"), "synthetic-owner-token\n", { mode: 0o600 });
  chmodSync(join(state, "serve.token"), 0o600);
  return { count: () => requests, stop: () => server.stop(true) };
}
const packet = (text: string) => Response.json({ ok: true, value: { data: {
  packet_md: `KIZUKI CONTEXT v1\n> ${text}\n`, sections: { timeline: 1 }, retrieval_degraded: [],
} } });

test("missing hook identity injects nothing, even with an available daemon", async () => {
  const f = seeded();
  const server = daemon(f.vault, () => packet(secretNote));
  try {
    expect(await hook(f.env, ["--vault", f.vault])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(server.count()).toBe(0);
  } finally { server.stop(); }
});

test("explicit owner output is scrubbed on both direct and daemon reads", async () => {
  const f = seeded();
  const direct = await hook(f.env, ["--owner", "--direct", "--vault", f.vault]);
  expect(direct.code).toBe(0);
  expect(direct.stdout).toContain("Atlas note");
  expect(direct.stdout).not.toContain(password);
  expect(direct.stdout).not.toContain(credential);
  const fallback = await hook(f.env, ["--owner", "--vault", f.vault]);
  expect(fallback.stdout).toContain("Atlas note");
  expect(fallback.stdout).not.toContain(password);
  expect(fallback.stdout).not.toContain(credential);
  const server = daemon(f.vault, () => packet(secretNote));
  try {
    const served = await hook(f.env, ["--owner", "--vault", f.vault]);
    expect(served.stdout).toContain("[redacted:");
    expect(served.stdout).not.toContain(password);
    expect(served.stdout).not.toContain(credential);
    expect(server.count()).toBe(1);
  } finally { server.stop(); }
});

test.each([
  { args: ["--vault"] },
  { args: ["--vault", "/nonexistent/a", "--vault", "/nonexistent/b"] },
  { args: ["--vault="] },
])(
  "vault argument errors are silent and successful: %j", async ({ args }) => {
    const env = isolatedEnv();
    expect(await hook(env, args)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await hook(env, [...args, "--verbose"])).toEqual({ code: 0, stdout: "", stderr: "hook: nothing injected (usage)\n" });
  },
);

test("a missing vault value before the hook is silent even when followed by another option", () => {
  const env = isolatedEnv();
  const args = ["--vault", "--vault", "/nonexistent/vault", "hook", "session-start", "--harness", "generic"];
  expect(runCli(env, ...args)).toEqual({ exitCode: 0, stdout: "", stderr: "" });
  expect(runCli(env, ...args, "--verbose")).toEqual({
    exitCode: 0, stdout: "", stderr: "hook: nothing injected (usage)\n",
  });
});

test("generic context drops terminal sequences and record separator controls", async () => {
  const f = seeded(`Atlas note ${controls} end`);
  const run = await hook(f.env, ["--owner", "--vault", f.vault]);
  expect(run.stdout).toContain("Atlas note");
  expect(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(run.stdout)).toBe(false);
  expect(run.stdout).not.toContain("QUJD");
});

test("the loopback bearer bypasses configured proxies and still serves context", async () => {
  const f = seeded();
  const seen: string[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    seen.push(req.headers.get("authorization") ?? "no bearer");
    return new Response("no route", { status: 502 });
  } });
  const server = daemon(f.vault, () => packet("Atlas note"));
  try {
    const via = `http://127.0.0.1:${proxy.port}`;
    const run = await hook({ ...f.env, HTTP_PROXY: via, http_proxy: via, HTTPS_PROXY: via, https_proxy: via, ALL_PROXY: via, all_proxy: via, NO_PROXY: "", no_proxy: "" }, ["--owner", "--vault", f.vault]);
    expect(seen).toEqual([]);
    expect(server.count()).toBe(1);
    expect(run.stdout).toContain("Atlas note");
  } finally { server.stop(); proxy.stop(true); }
});

test("the documented source launcher ignores project preload and dotenv", async () => {
  const f = seeded("Atlas note");
  const cwd = tempDir();
  writeFileSync(join(cwd, "preload.ts"), 'import { writeFileSync } from "node:fs"; writeFileSync(new URL("./marker", import.meta.url), "ran");');
  writeFileSync(join(cwd, "bunfig.toml"), 'preload = ["./preload.ts"]\n');
  const { token } = enroll(f);
  writeFileSync(join(cwd, ".env"), `HOOK_PROJECT_TOKEN=${token}\n`);
  const run = await hook(f.env, ["--vault", f.vault, "--token-ref", "env:HOOK_PROJECT_TOKEN"], cwd, true);
  expect(existsSync(join(cwd, "marker"))).toBe(false);
  expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
  const fallback = await hook(f.env, ["--owner", "--vault", f.vault], cwd, true);
  expect(fallback.stdout).toContain("Atlas note");
  expect(existsSync(join(cwd, "marker"))).toBe(false);
});

test("fallback passes only allowed environment and the selected credential", async () => {
  const f = seeded();
  const { token } = enroll(f);
  const env = { ...f.env, HOOK_SELECTED_TOKEN: token, HOOK_UNRELATED_SECRET: "unrelated", BUN_OPTIONS: "--preload ./project.ts", NODE_OPTIONS: "--trace-warnings", HTTP_PROXY: "http://127.0.0.1:1" };
  const original = Bun.spawn;
  let childEnv: Record<string, string | undefined> | undefined;
  const witness = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    childEnv = (args[1] as { env?: Record<string, string | undefined> })?.env;
    return original(...args);
  }) as typeof Bun.spawn);
  try {
    const result = await runSessionStart({ env, vaultOverride: f.vault, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
      out() {}, err() {}, prompt: async () => "" }, {
      harness: "generic", budget: 450, timeoutMs: 60_000, tokenRef: "env:HOOK_SELECTED_TOKEN", direct: false,
    });
    expect("output" in result).toBe(true);
    if ("output" in result) {
      expect(result.output).not.toContain(password);
      expect(result.output).not.toContain(credential);
      expect(result.output).toContain("[redacted:");
    }
    expect(childEnv?.KIZUKI_HOOK_TOKEN).toBe(token);
    expect(childEnv?.HOOK_UNRELATED_SECRET).toBeUndefined();
    expect(childEnv?.NODE_OPTIONS).toBeUndefined();
    expect(childEnv?.BUN_OPTIONS).toBeUndefined();
    expect(childEnv?.HOOK_SELECTED_TOKEN).toBeUndefined();
    expect(childEnv?.HTTP_PROXY).toBeUndefined();
  } finally { witness.mockRestore(); }
});

test("oversized output is refused by byte size for every harness", async () => {
  const f = seeded();
  const server = daemon(f.vault, () => packet("界".repeat(24_000)));
  try {
    for (const harness of ["generic", "codex", "claude-code"]) {
      const run = await hook(f.env, ["--owner", "--vault", f.vault, "--harness", harness]);
      expect(run).toEqual({ code: 0, stdout: "", stderr: "" });
    }
  } finally { server.stop(); }
});

test("a timed-out daemon body is diagnosed as timeout", async () => {
  const f = seeded();
  const server = daemon(f.vault, () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('{"ok":true,'));
  } })));
  try {
    const run = await hook(f.env, ["--owner", "--vault", f.vault, "--timeout-ms", "300", "--verbose"]);
    expect(run).toEqual({ code: 0, stdout: "", stderr: "hook: nothing injected (timeout)\n" });
  } finally { server.stop(); }
});


test("the byte cap includes the final newline and harness JSON framing", async () => {
  const f = tempVault();
  const prefix = "KIZUKI CONTEXT v1\n> ";
  const text = "x".repeat(MAX_HOOK_OUTPUT_BYTES - Buffer.byteLength(prefix) - 2);
  const server = daemon(f.vault, () => packet(text));
  try {
    const plain = await hook(f.env, ["--owner", "--vault", f.vault]);
    expect(plain.code).toBe(0);
    expect(Buffer.byteLength(plain.stdout)).toBe(MAX_HOOK_OUTPUT_BYTES);
    const json = await hook(f.env, ["--owner", "--vault", f.vault, "--harness", "codex", "--verbose"]);
    expect(json).toEqual({ code: 0, stdout: "", stderr: "hook: nothing injected (oversized)\n" });
  } finally { server.stop(); }
});

test("a daemon redirect does not send the bearer to a second endpoint", async () => {
  const f = tempVault();
  let forwarded = 0;
  const destination = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    forwarded++;
    return packet("redirected context");
  } });
  const server = daemon(f.vault, () => new Response(null, {
    status: 307, headers: { location: `http://127.0.0.1:${destination.port}/v1/context_packet` },
  }));
  try {
    const run = await hook(f.env, ["--owner", "--vault", f.vault, "--verbose"]);
    expect(run).toEqual({ code: 0, stdout: "", stderr: "hook: nothing injected (denied)\n" });
    expect(forwarded).toBe(0);
    expect(server.count()).toBe(1);
  } finally { server.stop(); destination.stop(true); }
});
