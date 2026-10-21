import { expect, test } from "bun:test";
import { OWNER } from "@kizuki/core";
import { serveWorldView } from "@kizuki/core/world";
import { WORLD_VERIFICATION_OPERATIONS, verificationInputs, verificationScene, type VerificationOperation } from "../../core/test/helpers/world-verification";
import { startLoopback } from "../../core/test/helpers/world-kit/loopback";
import { stdioClient } from "../../mcp/test/helpers/two-clients";
import { envelopeOf } from "../../mcp/test/client";
import { createAppHost } from "../src/app/host";
import { createHelpers } from "./helpers";

/** Exclude only validated, freshly issued capabilities and their expiry instants. */
function meaning(value: any): any {
  if (Array.isArray(value)) return value.map(meaning);
  if (value === null || typeof value !== "object") return value;
  const result = { ...value };
  if (result.kind === "snapshot") {
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    result.token = "<issued snapshot>";
  }
  if (result.view?.kind === "view") {
    expect(result.view.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    result.view = { kind: "view", token: "<issued view>" };
  }
  if (typeof result.validUntil === "string") {
    expect(Date.parse(result.validUntil)).toBeGreaterThan(Date.now());
    expect(Date.parse(result.validUntil) - Date.now()).toBeLessThanOrEqual(15 * 60_000);
    result.validUntil = "<view expiry>";
  }
  if (result.schema === "kizuki.resume-handle/v1") {
    expect(result.handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    result.handle = "<issued handle>"; result.expiresAt = "<handle expiry>";
  }
  return Object.fromEntries(Object.entries(result).map(([key, item]) => [key, meaning(item)]));
}

function cliArgs(name: VerificationOperation, input: Record<string, any>): string[] {
  switch (name) {
    case "concept": case "situation": case "question": case "person": case "procedure": case "skill": case "framework": return ["--ref", input[name].token];
    case "atlas": return ["--panel", input.panel];
    case "slice": return ["--task", input.task, "--budget-tokens", String(input.budgetTokens), "--kinds", input.kinds.join(",")];
    case "forecast": return ["--ref", input.commitment.token];
    case "forecast_scores": return [];
    case "artifact_version": return ["--ref", input.artifact.token];
    case "history": return ["--ref", input.concept.token];
    case "find_concepts": case "find_situations": case "find_questions": case "find_people": case "find_procedures": case "find_artifacts": return ["--label", input.label];
    case "share": return ["--of-operation", input.of.operation, "--ref", input.of.concept.token];
    case "diff": return ["--of-operation", input.of.operation, "--ref", input.of.concept.token, "--prior-view", input.priorView.token];
    case "resume": return ["--resume", input.handle];
    case "evidence": return ["--admission", input.evidence.admission.token, "--event-version", input.evidence.eventVersion.token,
      "--start-utf16", String(input.evidence.span.startUtf16), "--end-utf16", String(input.evidence.span.endUtf16)];
    case "outcome": return ["--subject", input.subject];
    case "describe": case "frontier": case "attention": return [];
  }
}

const TEXT: Record<VerificationOperation, readonly string[]> = {
  find_concepts: ["Bayesian updating"], find_situations: ["Launch plan"],
  concept: ["Bayesian updating", "Revise beliefs using evidence", "Coverage:"],
  situation: ["Launch plan", "Coverage:"], describe: ["find_concepts", "frontier"],
  evidence: ["Captured evidence (untrusted):", "Integrity:"], history: ["Retained Concept history", "Snapshot:"],
  share: ["Resume handle:"], resume: ["Bayesian updating", "Coverage:"],
  question: ["When should I update a belief?", "Status: open; understanding: unknown", "Coverage:"],
  find_questions: ["When should I update a belief?"], frontier: ["Coverage:"],
  person: ["Ada", "Person:", "Reviewer", "holder=unattributed speaker=unattributed mode=asserted", "Coverage:"],
  find_people: ["Ada"], find_procedures: ["procedure:verify"],
  procedure: ["procedure:verify", "execution authority: none", "Quoted step", "Coverage:"],
  skill: ["skill:inspection", "Independent mastery: unknown", "Coverage:"],
  framework: ["framework:quality", "Nested component", "Coverage:"],
  outcome: ["Outcome evidence", "agent_reported", "independent: false", "Coverage:"],
  attention: ["Coverage:"],
  atlas: ["Atlas", "People", "Coverage:"],
  slice: ["Task: Resume the launch", "Coverage:"],
  find_artifacts: ["Artifact"], artifact_version: ["Artifact", "text/markdown", "Coverage:"],
  diff: ["Unchanged since the prior view."],
  forecast: ["Uncalibrated, no model", "commitment_met_by_due", "resolved_met"],
  forecast_scores: ["Resolved 20", "Brier 0.25", "does not establish usefulness"],
};

test("every world operation agrees through Core, CLI text and JSON, stdio MCP, HTTP and App", async () => {
  const scene = await verificationScene(), h = createHelpers(), env = h.isolatedEnv();
  let mcp: Awaited<ReturnType<typeof stdioClient>> | undefined;
  let http: Awaited<ReturnType<typeof startLoopback>> | undefined;
  const host = createAppHost({ env, vaultOverride: scene.vaultPath, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out: () => {}, err: () => {}, prompt: async () => "" });
  try {
    const initialized = h.runCli(env, "init", scene.vaultPath, "--no-service", "--no-default");
    expect(initialized.exitCode, initialized.stderr).toBe(0);
    const ctx = { ...scene.reader, principal: OWNER };
    const discover = (operation: string, label: string) => {
      const result: any = serveWorldView(ctx, { operation, label, valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
      return result.result.data.matches[0].ref;
    };
    const ownerScene = { ...scene, reader: ctx, refs: { concept: discover("find_concepts", "Bayesian updating"), situation: discover("find_situations", "Launch") } };
    const inputs = verificationInputs(ownerScene);
    mcp = await stdioClient(scene.vaultPath, ["--owner"], {});
    http = await startLoopback(scene.db, scene.vaultPath);
    for (const name of WORLD_VERIFICATION_OPERATIONS) {
      const input = inputs[name];
      if (name === "diff") {
        const baseline = serveWorldView(ctx, { ...(input.of as Record<string, unknown>), valid: { kind: "all" }, knownAt: { kind: "current" } }).data;
        if (!("result" in baseline) || baseline.result.status !== "current" || !("kind" in baseline.result.view)) throw Error("fresh parity baseline required");
        input.priorView = baseline.result.view;
      }
      const expected = serveWorldView(ctx, input);
      expect(expected.data, name).toHaveProperty("result");
      const remote = envelopeOf(await mcp.call("world_view", input));
      expect(meaning(remote.data), `${name}: MCP`).toEqual(meaning(expected.data));
      expect(remote.quoted, `${name}: MCP evidence`).toEqual(expected.quoted);
      const reply = await http.post("world_view", input);
      expect(reply.status, name).toBe(200);
      expect(meaning((reply.body as any).value.data), `${name}: HTTP`).toEqual(meaning(expected.data));
      const app: any = await (await host.handle(new Request("http://127.0.0.1/app/v1/world_view", { method: "POST", body: JSON.stringify(input) }))).json();
      expect(app.ok, name).toBe(true);
      // Evidence returns its complete envelope so captured text keeps its quote channel.
      if (name === "evidence") {
        expect(meaning(app.data.data), `${name}: App`).toEqual(meaning(expected.data));
        expect(app.data.quoted, name).toEqual(expected.quoted);
      } else expect(meaning(app.data), `${name}: App`).toEqual(meaning(expected.data));
      // Opaque base64url tokens may start with `--`; the documented inline
      // value grammar keeps them from being mistaken for another option.
      const options = cliArgs(name, input), inline: string[] = [];
      for (let i = 0; i < options.length; i += 2) inline.push(`${options[i]}=${options[i + 1]}`);
      const args = ["--vault", scene.vaultPath, "world", "--operation", name, ...inline];
      const json = h.runCli(env, ...args, "--json");
      expect(json.exitCode, `${name}: ${json.stderr}`).toBe(0);
      const envelope = JSON.parse(json.stdout).data;
      expect(meaning(envelope.data), `${name}: CLI JSON`).toEqual(meaning(expected.data));
      expect(envelope.quoted, name).toEqual(expected.quoted);
      const text = h.runCli(env, ...args);
      expect(text.exitCode, `${name}: ${text.stderr}`).toBe(0);
      for (const fragment of TEXT[name]) expect(text.stdout, name).toContain(fragment);
      expect(text.stderr, name).toBe("");
    }
  } finally { await http?.stop(); await mcp?.close(); await host.close(); scene.dispose(); h.cleanup(); }
}, 120_000);
