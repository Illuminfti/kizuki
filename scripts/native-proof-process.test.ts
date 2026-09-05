import { expect, test } from "bun:test";
import { openNativeMcp, runNativeCommand } from "./native-proof-process";
const options = { cwd: import.meta.dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } };
const code = (value: string) => [process.execPath, "-e", value];

test("bounded native command preserves observed exit and both output digests", async () => {
  const result = await runNativeCommand(code('process.stdout.write("ok"); process.stderr.write("refusal"); process.exitCode=1'), options);
  expect(result.stdout).toBe("ok"); expect(result.stderr).toBe("refusal");
  expect(result.observation).toMatchObject({ exit_code: 1, fault: null, stdout_bytes: 2, stderr_bytes: 7 });
});
test.each(["stdout", "stderr"] as const)("native %s overflow kills and drains before returning", async stream => {
  const result = await runNativeCommand(code(`for (;;) process.${stream}.write("x".repeat(65536))`), options);
  expect(result.observation.fault).toBe(`${stream}-overflow`);
});
test("native deadline cannot count as an expected refusal", async () => {
  const result = await runNativeCommand(code('setInterval(()=>{},1000)'), { ...options, timeout_ms: 30 });
  expect(result.observation.fault).toBe("deadline");
});
const server = `let n=0; for await (const line of console) { if (!line.trim()) continue; const r=JSON.parse(line); if(r.id) console.log(JSON.stringify({jsonrpc:"2.0",id:r.id,result:{ordinal:++n}})); }`;
test("persistent MCP preserves ordered requests across unrelated commands and closes once", async () => {
  const session = await openNativeMcp(code(server), options);
  expect(await session.call("search", {})).toEqual({ ordinal: 2 });
  await runNativeCommand(code('console.log("unrelated command")'), options);
  expect(await session.call("context_packet", {})).toEqual({ ordinal: 3 });
  expect(session.requests.map(row => row.request_id)).toEqual([1, 2, 3]);
  const closed = await session.close(); expect(closed).toMatchObject({ exit_code: 0, fault: null });
  expect(await session.close()).toEqual(closed);
  await expect(session.call("search", {})).rejects.toThrow();
});
test.each([
  'process.exit(0)',
  'console.log("bad-json");setInterval(()=>{},1000)',
  'console.log(JSON.stringify({jsonrpc:"2.0",id:19,result:{}}));setInterval(()=>{},1000)',
  'process.stderr.write("x".repeat(70000));setInterval(()=>{},1000)',
  'setInterval(()=>{},1000)',
])("MCP EOF, malformed response, wrong request, overflow and deadline fail closed %#", async fixture => {
  await expect(openNativeMcp(code(fixture), { ...options, timeout_ms: 100 })).rejects.toThrow();
});
