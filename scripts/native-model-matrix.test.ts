import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_PHASE_IDS, modelPhasePassed, runNativeModelMatrix, startNativeModelEndpoint, type NativeModelEvidence, type NativeModelPhase } from "./native-model-matrix";
import { syntheticModelReply } from "./native-model-endpoint";

const base: NativeModelEvidence = { unit: "kizuki@synthetic.service", instance_id: "synthetic-instance", pid: 123, started_at: "2026-09-07T00:00:00.000Z", receipt_run_id: "synthetic-run", receipt_status: "ok", model_calls: 1, model_unavailable: 0,
  claims_extracted: 1, canon_writes: 1, endpoint_requests: 1, unexpected_requests: 0, credential_present: true, model_configured: true,
  source_event_present: true, query_preserved: true, weights_unchanged: true, config_unchanged: true, configuration_unavailable: false, daemon_active: true, model_ref_sha256: "a".repeat(64), model_claims: 1, model_canon_receipts: 1, model_output_readable: true, recovery: null };
test("model qualification refuses absent receipts, detached daemon, wrong calls and invisible mutation", () => {
  expect(modelPhasePassed("model-configured", base)).toBe(true);
  for (const change of [{ receipt_run_id: "" }, { daemon_active: false }, { endpoint_requests: 0 }, { model_calls: 0 }, { unexpected_requests: 1 }, { weights_unchanged: false }, { config_unchanged: false }, { source_event_present: false }, { query_preserved: false }, { claims_extracted: 0 }])
    expect(modelPhasePassed("model-configured", { ...base, ...change })).toBe(false);
  expect(modelPhasePassed("model-unavailable", base)).toBe(false);
  expect(modelPhasePassed("model-credential-loss", base)).toBe(false);
  expect(modelPhasePassed("model-dependency-offline", base)).toBe(false);
});
test("negative model phases refuse any model authority or readable model output", () => {
  for (const id of ["model-absent", "model-credential-loss"] as const) {
    const negative = { ...base, credential_present: false, model_configured: id !== "model-absent", model_calls: 0, endpoint_requests: 0,
      configuration_unavailable: id === "model-credential-loss", claims_extracted: 0, canon_writes: 0, model_claims: 0, model_canon_receipts: 0,
      model_output_readable: false, model_ref_sha256: null };
    expect(modelPhasePassed(id, negative)).toBe(true);
    for (const changed of [{ model_claims: 1 }, { model_canon_receipts: 1 }, { model_output_readable: true }])
      expect(modelPhasePassed(id, { ...negative, ...changed })).toBe(false);
  }
});
test("offline recovery requires the restored dependency and a distinct installed receipt", () => {
  const recovery = { stop_confirmed: true, receipt_trigger: "scheduled", receipt_due_at: "2026-09-07T00:00:00.000Z", scheduling_override: { rail: "sync" as const, old: "2026-09-07T00:15:00.000Z", next: "2026-09-07T00:00:00.000Z", reason: "synthetic-due-time-for-recovery" as const }, trigger: "service-restart" as const, unit: base.unit, pid: 456, instance_id: "recovered-instance", started_at: "2026-09-07T00:00:01.000Z",
    receipt_run_id: "recovered-run", receipt_status: "ok", model_calls: 1, model_unavailable: 0, claims_extracted: 1, canon_writes: 1,
    endpoint_requests: 1, unexpected_requests: 0, model_claims: 1, model_canon_receipts: 1, model_output_readable: true,
    source_event_present: true, query_preserved: true, daemon_active: true, config_unchanged: true, credential_unchanged: true, endpoint_unchanged: true };
  const offline = { ...base, receipt_status: "degraded", model_unavailable: 1, claims_extracted: 0, canon_writes: 2, endpoint_requests: 0,
    model_claims: 0, model_canon_receipts: 0, model_output_readable: false, recovery };
  expect(modelPhasePassed("model-dependency-offline", offline)).toBe(true);
  expect(modelPhasePassed("model-dependency-offline", { ...offline, recovery: null })).toBe(false);
  for (const changed of [{ instance_id: base.instance_id }, { receipt_run_id: base.receipt_run_id }, { unit: "foreign-unit" }, { endpoint_unchanged: false },
    { credential_unchanged: false }, { stop_confirmed: false }, { receipt_trigger: "manual" }, { receipt_due_at: null }, { model_output_readable: false }, { query_preserved: false }, { daemon_active: false }, { endpoint_requests: 0 }, { model_claims: 0 }])
    expect(modelPhasePassed("model-dependency-offline", { ...offline, recovery: { ...recovery, ...changed } })).toBe(false);
});
test("scripted model response preserves request record binding and refuses another model", () => {
  const request = { model: "native-lifecycle-synthetic", messages: [{ content: "system" }, { content: 'record event-1 from source\n{"subject":"person:ada"}' }] };
  expect(JSON.stringify(syntheticModelReply(request))).toContain('event-1');
  expect(() => syntheticModelReply({ ...request, model: "foreign-model" })).toThrow("request_shape");
  expect(() => syntheticModelReply({ ...request, tools: [] })).toThrow("request_shape");
  expect(() => syntheticModelReply({ ...request, messages: [{}, { content: "unbound" }] })).toThrow("request_binding");
});
test("owned endpoint stays alive across blocking parent work, counts refusals and stops", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "native-model-endpoint-"));
  const endpoint = await startNativeModelEndpoint(workspace, "unavailable");
  try {
    const answer = await fetch(endpoint.endpoint + "/chat/completions", { method: "POST", headers: { authorization: "Bearer " + endpoint.key }, body: "{}" });
    expect(answer.status).toBe(503); expect(endpoint.observation()).toEqual({ requests: 1, unexpected: 0 });
    const denied = await fetch(endpoint.endpoint + "/other", { method: "POST", body: "{}" });
    expect(denied.status).toBe(403); expect(endpoint.observation()).toEqual({ requests: 1, unexpected: 1 });
    expect(readFileSync(join(workspace, "observation.json"), "utf8")).not.toContain(endpoint.key);
  } finally { await endpoint.stop(); await endpoint.stop(); rmSync(workspace, { recursive: true }); }
});

test("the full model matrix observes actual daemon child receipts without an OS service manager", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "native-model-matrix-")), home = join(workspace, "home"); mkdirSync(home);
  const cli = join(import.meta.dir, "../packages/cli/src/main.ts");
  const env = { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: join(home, "config"), KIZUKI_CONFIG: join(home, "config.toml"), KIZUKI_SUPERVISOR: "none" };
  const children = new Map<string, ReturnType<typeof Bun.spawn>>(); const phases: NativeModelPhase[] = [];
  const invoke = (args: string[]) => { const r = Bun.spawnSync([process.execPath, cli, ...args], { env, cwd: workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 30_000 }); if (r.exitCode !== 0) console.error(JSON.stringify({ argv: args.slice(0,2), exit: r.exitCode, stderr: r.stderr.toString() })); return { exit_code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() }; };
  const stop = async (vault: string) => {
    const child = children.get(vault); if (!child) return;
    invoke(["serve", "stop", "--vault", vault]);
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await child.exited; } finally { clearTimeout(timer); children.delete(vault); }
  };
  try {
    await runNativeModelMatrix({ executable: process.execPath, workspace: join(workspace, "cases"), env, invoke,
      activate: async (vault) => {
        const started_at = new Date().toISOString();
        const child = Bun.spawn([process.execPath, cli, "serve", "--no-http", "--vault", vault], { env, cwd: workspace, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); children.set(vault, child);
        const marker = join(vault, ".kizuki/serve.pid"), deadline = Date.now() + 5000;
        while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await Bun.sleep(20);
        expect(child.exitCode).toBeNull(); expect(existsSync(marker)).toBe(true);
        const identity = JSON.parse(readFileSync(marker, "utf8")); expect(identity.pid).toBe(child.pid);
        return { unit: "direct-child-model-fixture", pid: child.pid, instance_id: identity.instance_id, started_at };
      },
      stillActive: (vault, instance) => children.get(vault)?.pid === instance.pid && children.get(vault)?.exitCode === null,
      deactivate: stop,
      record: phase => { phases.push(phase); expect(phase).toMatchObject({ passed: true }); },
    });
    expect(phases.map(p => p.id)).toEqual([...MODEL_PHASE_IDS]);
  } finally {
    for (const vault of children.keys()) await stop(vault);
    rmSync(workspace, { recursive: true });
  }
}, 90_000);
