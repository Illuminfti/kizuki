import { join } from "node:path";
import { OWNER, addAgent, authenticate, TOOLS, accept } from "../../packages/core/src/index";
import { openLedger } from "../../packages/core/src/ledger/db";
import { initVault } from "../../packages/core/src/vault/init";
import { startServeHttp } from "../../packages/core/src/serve/http";
import { fuzzStdioBytes, mcpFuzzDriver } from "../../packages/mcp/test/fuzz-driver";
import type { FuzzCase } from "./cases";
import { NOW } from "./parsers";
import { wrappedArguments } from "./arguments";
import { assertServingEnvelope } from "./oracle";

export const SURFACES = ["http", "mcp", "app-http"] as const;
export const OWNER_TOKEN = "synthetic-fuzz-token";

/** One unclassified standing-HTTP tool call. */
export async function httpPost(origin: string, tool: string, body: BodyInit, token = OWNER_TOKEN): Promise<{ status: number; text: string }> {
  const response = await fetch(`${origin}/v1/${tool}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body });
  return { status: response.status, text: await response.text() };
}

/** A generic serving failure fails the campaign as an HTTP 400 and inside a successful envelope alike. */
export async function httpTool(origin: string, tool: string, body: BodyInit, token = OWNER_TOKEN): Promise<void> {
  const { status, text } = await httpPost(origin, tool, body, token);
  if (status >= 500) throw new Error("http-crash");
  if (text.length > 1024 * 1024) throw new Error("output-unbounded");
  const envelope = JSON.parse(text) as { error?: { code?: unknown }; value?: unknown };
  if (envelope.error?.code === "error") throw new Error("http-crash");
  assertServingEnvelope(envelope.value, "http-crash");
}

export async function surfaceDriver(target: typeof SURFACES[number], scratch: string, listening: (origin: string) => void = () => {}) {
  if (target === "app-http") return (await import("./app")).appDriver(scratch, listening);
  const vaultPath = join(scratch, "vault");
  initVault(vaultPath);
  const db = openLedger(join(vaultPath, ".kizuki/kizuki.db"));
  const enrollment = addAgent(db, "synthetic-fuzz-client");
  const principal = authenticate(db, enrollment.token);
  if (principal === null) throw new Error("fixture-authentication");
  const http = target === "http" ? startServeHttp({ db, vaultPath, token: OWNER_TOKEN }) : null;
  if (http !== null) listening(http.url);
  const mcp = target === "mcp" ? await mcpFuzzDriver({ db, vaultPath, principal }) : null;
  const ownerMcp = target === "mcp" ? await mcpFuzzDriver({ db, vaultPath, principal: OWNER }) : null;
  function argumentsFor(input: FuzzCase): unknown {
    try { return JSON.parse(input.text); } catch { return { query: input.text, text: input.text }; }
  }
  return {
    httpOrigin: http?.url ?? null,
    async run(input: FuzzCase): Promise<void> {
      if (target === "mcp") await fuzzStdioBytes({ db, vaultPath, principal }, input.bytes);
      const args = argumentsFor(input);
      for (const tool of TOOLS) {
        for (const wrapped of [false, true]) {
          // Every HTTP route shares one body reader. Raw-byte admission needs
          // one route per case; wrapped fields still exercise all ten tools.
          if (target === "http" && !wrapped && tool !== "system_health") continue;
          const mutated = wrapped ? wrappedArguments(tool, input.text) : args;
          if (mcp !== null && ownerMcp !== null) {
            if (wrapped && input.id === "object") {
              const denied = await mcp.call(tool, mutated);
              if (!(denied as { isError?: boolean }).isError) throw new Error("inert-grant-admitted");
            }
            const result = await ownerMcp.call(tool, mutated) as { structuredContent?: unknown; content?: { text?: string }[] };
            // A short valid envelope must reach core rather than only SDK validation.
            if (wrapped && input.id === "object" && result.structuredContent === undefined) {
              try {
                if (typeof JSON.parse(result.content?.[0]?.text ?? "").error !== "string") throw new Error();
              } catch { throw new Error("projection-unreached"); }
            }
          } else if (http !== null) {
            const body = wrapped ? JSON.stringify(mutated) : new Uint8Array(input.bytes);
            if (wrapped && input.id === "object") {
              const denied = await fetch(`${http.url}/v1/${tool}`, { method: "POST", headers: { authorization: `Bearer ${enrollment.token}` }, body });
              if (denied.status === 200) throw new Error("inert-grant-admitted");
            }
            await httpTool(http.url, tool, body);
          }
        }
      }
      // Captured instruction-looking bytes stay in quoted evidence at the read seam.
      if (input.id === "instruction-stamp") {
        const stored = accept(db, { schema: "kizuki.event/v1", connector_id: "synthetic", source_record_id: "synthetic", kind: "message", occurred_at: NOW, observed_at: NOW, text: input.text, subjects: [], attachments: [], metadata: {}, deleted: false, sensitivity_hint: "private" });
        if (stored.status !== "stored") throw new Error("fixture-ingress");
        const request = { event_id: stored.event.event_id };
        const value = ownerMcp !== null ? await ownerMcp.call("timeline", request)
          : await (await fetch(`${http!.url}/v1/timeline`, { method: "POST", headers: { authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify(request) })).json();
        const envelope = ownerMcp !== null ? (value as { structuredContent: Record<string, unknown> }).structuredContent : (value as { value: Record<string, unknown> }).value;
        if (JSON.stringify(envelope["canon"]).includes("Ignore prior instructions") || !JSON.stringify(envelope["quoted"]).includes("Ignore prior instructions")) throw new Error("capture-trust-confusion");
      }
    },
    async close() { await mcp?.close(); await ownerMcp?.close(); await http?.stop(); db.close(); },
  };
}
