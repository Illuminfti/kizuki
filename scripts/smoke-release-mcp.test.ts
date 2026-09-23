import { expect, test, setDefaultTimeout } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpSession } from "./smoke-release-mcp";

// These tests spawn real processes; bound them for a loaded host.
setDefaultTimeout(30_000);

const env = { PATH: process.env.PATH ?? "" };

test("MCP smoke collects both pipes and preserves the exit code", async () => {
  const result = await mcpSession(process.execPath, env, ["-e", `
    const input = await Bun.stdin.text();
    process.stdout.write(input);
    process.stderr.write("diagnostic");
    process.exitCode = 7;
  `], ["request-one", "request-two"]);
  expect(result).toEqual({ code: 7, output: "request-one\nrequest-two\n", diagnostics: "diagnostic" });
});

test("MCP smoke refuses diagnostics overflow", async () => {
  await expect(mcpSession(process.execPath, env, ["-e", `
    await Bun.stdin.text();
    process.stderr.write("x".repeat(16_385));
  `], [])).rejects.toThrow("MCP smoke diagnostics overflow");
});

test("MCP smoke diagnostics limit counts UTF-8 bytes", async () => {
  const diagnostics = "é".repeat(8_192);
  const result = await mcpSession(process.execPath, env, ["-e", `
    await Bun.stdin.text();
    process.stderr.write(${JSON.stringify(diagnostics)});
  `], []);
  expect(result.diagnostics).toBe(diagnostics);
  await expect(mcpSession(process.execPath, env, ["-e", `
    await Bun.stdin.text();
    process.stderr.write(${JSON.stringify(diagnostics + "x")});
  `], [])).rejects.toThrow("MCP smoke diagnostics overflow");
});

for (const pipe of ["stdout", "stderr"] as const) {
  test(`MCP smoke deadline includes ${pipe} retained after parent exit`, async () => {
    const root = mkdtempSync(join(tmpdir(), "kizuki-smoke-pipe-"));
    const pidFile = join(root, "descendant.pid");
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      // The direct child exits; a test-owned descendant keeps exactly one pipe open.
      const session = mcpSession(process.execPath, env, ["-e", `
        const { writeFileSync } = await import("node:fs");
        const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], {
          stdin: "ignore", stdout: ${JSON.stringify(pipe === "stdout" ? "inherit" : "ignore")},
          stderr: ${JSON.stringify(pipe === "stderr" ? "inherit" : "ignore")}
        });
        writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        child.unref();
        process.exit(0);
      `], []);
      const bounded = Promise.race([session, new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error("test watchdog: session did not time out")), 20_000);
      })]);
      await expect(bounded).rejects.toThrow("MCP smoke timed out");
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      try {
        process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  }, 25_000);
}
