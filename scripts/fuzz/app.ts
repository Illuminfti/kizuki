import { join } from "node:path";
import { createAppHost } from "../../packages/cli/src/app/host";
import type { AppRoute } from "../../packages/cli/src/app/protocol";
import { initVault } from "../../packages/core/src/vault/init";
import { startServeHttp } from "../../packages/core/src/serve/http";
import type { FuzzCase } from "./cases";

const ROUTES = ["status", "catalog", "initialize", "service_status", "install_service", "sources", "enroll", "consent", "capture", "query", "activity", "undo", "operation", "revoke", "resume_revocation", "model_status", "model_save", "model_test", "source_model_consent", "run_pass", "agents", "agent_enroll", "agent_revoke", "correction_targets", "correction_preview", "correct", "world_view"] as const satisfies readonly AppRoute[];
// A new protocol route must acquire a driver entry before this file typechecks.
const complete: Exclude<AppRoute, typeof ROUTES[number]> extends never ? true : never = true;
void complete;

export async function appDriver(scratch: string) {
  const vaultPath = join(scratch, "vault");
  initVault(vaultPath);
  const host = createAppHost({
    env: { HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data") },
    vaultOverride: vaultPath, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out() {}, err() {}, prompt: async () => { throw new Error("unexpected-prompt"); },
  }, { supervisor: () => { throw new Error("supervisor-unavailable"); } }, { noService: true });
  const http = startServeHttp({ mode: "app", assets: {}, handle: host.handle });
  return {
    httpOrigin: http.url,
    async run(input: FuzzCase) {
      for (const route of ROUTES) {
        for (const authorized of [false, true]) {
          const response = await fetch(`${http.url}/app/v1/${route}`, {
            method: "POST", headers: { origin: http.url, "content-type": "application/json", authorization: `Bearer ${authorized ? http.token : "synthetic-invalid-token"}` },
            body: new Uint8Array(input.bytes),
          });
          if (!authorized && response.status !== 401) throw new Error("inert-grant-admitted");
          if (response.status >= 500) throw new Error("http-crash");
          if ((await response.text()).length > 1024 * 1024) throw new Error("output-unbounded");
        }
      }
    },
    async close() { await http.stop(); await host.close(); },
  };
}
