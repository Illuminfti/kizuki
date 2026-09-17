export async function mcpSession(mcp: string, env: Record<string, string>, args: string[], requests: string[]): Promise<{ code: number; output: string; diagnostics: string }> {
  const child = Bun.spawn([mcp, ...args], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  for (const request of requests) child.stdin.write(`${request}\n`);
  child.stdin.end();
  const output = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("MCP smoke timed out")); }, 15_000); });
    const [code, stdout, diagnostics] = await Promise.race([
      Promise.all([child.exited, output, stderr]),
      timeout,
    ]);
    if (Buffer.byteLength(diagnostics, "utf8") > 16_384) throw new Error("MCP smoke diagnostics overflow");
    return { code, output: stdout, diagnostics };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}
