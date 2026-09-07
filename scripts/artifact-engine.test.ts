import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectEngineProcess, parseDoctorObservation, parseMcpObservation } from "./artifact-engine";

const runtime = { schema: "kizuki.sqlite-runtime/v1" as const, bun_version: "1.3.14", sqlite_version: "3.53.0", sqlite_source_id: "synthetic engine identity" };
const digest = "a".repeat(64);
const doctor = (ok: boolean) => ({ schema: "kizuki.cli.doctor/v1", status: ok ? "ok" : "error", data: { ok, runtime }, degraded: [], warnings: [] });
const envelope = { schema: "kizuki.envelope/v1", tool: "system_health", principal: "owner", at: "2026-09-06T00:00:00.000Z", canon: [], quoted: [], denied: [], data: { runtime } };
const health = () => ({ content: [{ type: "text", text: JSON.stringify(envelope) }], structuredContent: envelope });

test("doctor engine collection preserves either successful or unhealthy status", () => {
  for (const ok of [true, false]) {
    expect(parseDoctorObservation(JSON.stringify(doctor(ok)), ok ? 0 : 1, digest)).toEqual({
      executable_sha256: digest, runtime, exit_code: ok ? 0 : 1, doctor_status: ok ? "ok" : "error",
    });
  }
});

test("doctor rejects incomplete, contradictory or unrelated responses", () => {
  for (const value of [null, {}, { ...doctor(true), status: "degraded" }, { ...doctor(true), data: {} },
    { ...doctor(true), data: { ok: false, runtime } }, { ...doctor(true), error: { message: "synthetic" } },
    { ...doctor(true), warnings: "synthetic" }, { ...doctor(true), schema: "kizuki.cli.query/v1" }]) {
    expect(() => parseDoctorObservation(JSON.stringify(value), 0, digest)).toThrow("engine-response-invalid");
  }
  expect(() => parseDoctorObservation(JSON.stringify(doctor(true)), 1, digest)).toThrow("engine-response-invalid");
  expect(() => parseDoctorObservation(JSON.stringify(doctor(false)), 2, digest)).toThrow("engine-response-invalid");
  expect(() => parseDoctorObservation(JSON.stringify(doctor(true)) + "{}", 0, digest)).toThrow();
  expect(() => parseDoctorObservation('{"schema":"wrong","schema":"kizuki.cli.doctor/v1"}', 0, digest)).toThrow();
});

test("MCP keeps only the matching runtime fragment from agreeing health projections", () => {
  expect(parseMcpObservation(health(), digest)).toEqual({ executable_sha256: digest, runtime, exit_code: 0, mcp_is_error: false });
  expect(parseMcpObservation({ ...health(), isError: false }, digest).runtime).toEqual(runtime);
  expect(parseMcpObservation({ content: health().content }, digest).runtime).toEqual(runtime);
});

test("MCP rejects errors, extra results and disagreeing projections", () => {
  for (const value of [null, {}, { ...health(), isError: true }, { ...health(), content: [] },
    { ...health(), content: [...health().content, ...health().content] },
    { ...health(), structuredContent: { ...envelope, data: { runtime: { ...runtime, bun_version: "other" } } } },
    { ...health(), content: [{ type: "text", text: JSON.stringify({ ...envelope, tool: "search" }) }] },
    { ...health(), content: [{ type: "text", text: JSON.stringify({ ...envelope, principal: "agent" }) }] }]) {
    expect(() => parseMcpObservation(value, digest)).toThrow("engine-response-invalid");
  }
});

async function fixtureProcess(source: string, mcp = false) {
  const dir = mkdtempSync(join(tmpdir(), "kizuki-engine-process-test-"));
  try {
    const script = join(dir, "child.ts");
    writeFileSync(script, source, { mode: 0o600 });
    return await collectEngineProcess(process.execPath, [script], dir, { PATH: process.env.PATH ?? "/usr/bin:/bin" }, mcp);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("diagnostic subprocess collects bounded stdout and reaps its real exit", async () => {
  const result = await fixtureProcess('process.stdout.write("synthetic diagnostic"); process.stderr.write("synthetic log"); process.exitCode=1;');
  expect(result).toEqual({ stdout: "synthetic diagnostic", exit_code: 1 });
});

test("both diagnostic streams enforce their byte cap during reading", async () => {
  for (const stream of ["stdout", "stderr"]) {
    await expect(fixtureProcess(`process.${stream}.write("x".repeat(16385)); setInterval(()=>{},1000);`)).rejects.toThrow("engine-output-limit");
  }
});

test("MCP collector completes initialize before requesting health and closes stdin", async () => {
  const source = `
    let seen = 0, input = "";
    process.stdin.on("data", chunk => {
      input += chunk.toString();
      while (input.includes("\\n")) {
        const end = input.indexOf("\\n"), row = JSON.parse(input.slice(0,end)); input = input.slice(end+1);
        seen++;
        if (seen === 1 && row.method === "initialize") process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{protocolVersion:"2025-06-18",capabilities:{},serverInfo:{name:"synthetic",version:"0"}}})+"\\n");
        else if (seen === 2 && row.method === "notifications/initialized") {}
        else if (seen === 3 && row.method === "tools/call" && row.params.name === "system_health" && Object.keys(row.params.arguments).length === 0) process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:2,result:${JSON.stringify(health())}})+"\\n");
        else process.exitCode = 2;
      }
    });
    process.stdin.on("end",()=>{if(seen!==3)process.exitCode=2;});`;
  const result = await fixtureProcess(source, true);
  expect(result.exit_code).toBe(0);
  expect(result.stdout.trim().split("\n")).toHaveLength(2);
});

test("MCP collector refuses unexpected response IDs and incomplete shutdown", async () => {
  await expect(fixtureProcess('process.stdout.write(\'{"jsonrpc":"2.0","id":8,"result":{}}\\n\');', true)).rejects.toThrow("engine-response-invalid");
  await expect(fixtureProcess('process.exitCode=0;', true)).rejects.toThrow("engine-response-invalid");
});

test("a diagnostic child deadline kills and reaps a stalled process", async () => {
  await expect(fixtureProcess('setInterval(()=>{},1000);')).rejects.toThrow("engine-timeout");
}, 35_000);
