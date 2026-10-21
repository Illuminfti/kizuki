import { resolve } from "node:path";
import { verifyWorldRegistry } from "./world-verify/registry";

/** Synthetic offline gate. Real model qualification and the read-only vault probe are separate checks. */
export async function worldVerify(args: readonly string[]): Promise<number> {
  if (args.some(arg => !["--registry-only", "--inject-leak"].includes(arg)) || new Set(args).size !== args.length || args.length > 1) {
    console.error("usage: bun run verify:world [--registry-only | --inject-leak]");
    return 2;
  }
  try {
    const registry = verifyWorldRegistry();
    console.log(`PASS world registry: ${registry.operations} operations, ${registry.executable}/${registry.total} executable oracle units`);
    if (args.includes("--registry-only")) return 0;
    const inject = args.includes("--inject-leak");
    const child = Bun.spawn([process.execPath, "test", "--timeout", "120000", ...(inject
      ? ["packages/core/test/world/verification-matrix.test.ts", "--test-name-pattern", "verification self-test"]
      : registry.tests)], { cwd: resolve(import.meta.dir, ".."), stdin: "ignore", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, KIZUKI_VERIFY_INJECT_LEAK: inject ? "1" : "0" } });
    const stop = () => child.kill("SIGTERM");
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
    let code: number;
    try { code = await child.exited; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
    console.log(`${code === 0 ? "PASS" : "FAIL"} world verification${inject ? " (injected leak)" : ""}`);
    return code === 0 ? 0 : 1;
  } catch (error) {
    console.error(`FAIL world verification: ${error instanceof Error ? error.message : "unknown failure"}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await worldVerify(process.argv.slice(2));
