import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAppHost } from "../../packages/cli/src/app/host";
import type { AppOperation, AppRoute } from "../../packages/cli/src/app/protocol";
import { OWNER_AGENT_GRANT, accept, addAgent, authenticate, initAgents, realSupervisorHost } from "../../packages/core/src/index";
import { openLedger } from "../../packages/core/src/ledger/db";
import { servePropose } from "../../packages/core/src/serving/propose";
import { startServeHttp } from "../../packages/core/src/serve/http";
import type { FuzzCase } from "./cases";
import { NOW } from "./parsers";
import { APP_WITNESSES, appEnvelopes, appSlots, confuse, withValue } from "./app-arguments";
import type { AppWorld, Envelope } from "./app-arguments";

/** Fields mutated per case, round robin; the CI budget of corpus plus seeded cases reaches every field. */
export const SLOTS_PER_CASE = 6;
export const APP_SLOTS = appSlots();

// Refusals of hostile input that a healthy synthetic fixture can give, beyond the
// `invalid_request` any route may answer. Anything else, `unavailable` included, is an internal failure.
const REFUSALS: Partial<Record<AppRoute, readonly string[]>> = {
  enroll: ["misconfigured"],
  consent: ["source_revision_conflict", "source_not_enrolled"],
  revoke: ["source_revision_conflict", "source_not_enrolled"],
  model_save: ["revision_conflict", "configuration_invalid", "credential_invalid"],
  model_test: ["revision_conflict", "model_test_failed"],
  source_model_consent: ["revision_conflict", "source_revision_conflict", "source_not_active", "model_unconfigured"],
  agent_enroll: ["invalid_grant", "name_conflict", "operation_conflict"],
  agent_revoke: ["name_conflict"],
};
// A success on any other route may change a revision a later envelope must quote.
const READ_ONLY = new Set<AppRoute>(["status", "catalog", "service_status", "sources", "query", "activity", "operation", "model_status", "agents", "correction_targets", "correction_preview", "world_view"]);

interface Outcome { code: string; data?: Record<string, unknown> }

export async function appDriver(scratch: string, listening: (origin: string) => void = () => {}) {
  const vaultPath = join(scratch, "vault"), notes = join(scratch, "notes");
  mkdirSync(notes, { mode: 0o700 });
  writeFileSync(join(notes, "synthetic.md"), "# Synthetic note\n\nSynthetic memory text.\n");
  // A supervisor of kind none never reaches a real service manager.
  const host = createAppHost({
    env: { HOME: scratch, XDG_CONFIG_HOME: join(scratch, "config"), XDG_DATA_HOME: join(scratch, "data"), KIZUKI_SUPERVISOR: "none" },
    vaultOverride: vaultPath, stdinIsTTY: false, stdoutIsTTY: false, stderrIsTTY: false,
    out() {}, err() {}, prompt: async () => { throw new Error("unexpected-prompt"); },
  }, { supervisor: () => realSupervisorHost("none", scratch, []) }, { noService: true });
  const http = startServeHttp({ mode: "app", assets: {}, handle: host.handle });
  listening(http.url);
  let sequence = 0, cursor = 0, served = 0;
  let source = "", claim = "", applied = "";
  let revisions: { source: number; model: string } | null = null;

  async function post(route: string, body: BodyInit, authorized = true) {
    const response = await fetch(`${http.url}/app/v1/${route}`, {
      method: "POST", headers: { origin: http.url, "content-type": "application/json", authorization: `Bearer ${authorized ? http.token : "synthetic-invalid-token"}` }, body,
    });
    const text = await response.text();
    if (response.status >= 500) throw new Error("app-crash");
    if (text.length > 1024 * 1024) throw new Error("output-unbounded");
    return { status: response.status, envelope: JSON.parse(text) as { ok?: unknown; error?: { code?: unknown }; data?: Record<string, unknown> } };
  }
  function refusal(route: AppRoute, code: unknown): string {
    if (typeof code === "string" && (code === "invalid_request" || REFUSALS[route]?.includes(code))) return code;
    throw new Error("app-crash");
  }
  /** An accepted operation is not a finished case: its recorded outcome is classified like an immediate answer. */
  async function send(route: AppRoute, body: BodyInit): Promise<Outcome> {
    const { status, envelope } = await post(route, body);
    if (envelope.ok === false) return { code: refusal(route, envelope.error?.code) };
    if (status !== 200 || envelope.ok !== true || envelope.data === undefined) throw new Error("app-crash");
    if (!READ_ONLY.has(route)) revisions = null;
    const id = envelope.data["operation_id"];
    if (typeof id !== "string") return { code: "succeeded", data: envelope.data };
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const job = (await post("operation", JSON.stringify({ id }))).envelope.data as unknown as AppOperation | undefined;
      if (job?.state === "succeeded") return { code: "succeeded", data: job.result ?? {} };
      if (job?.state === "failed") return { code: refusal(route, job.error?.code) };
      if (job?.state !== "running") throw new Error("app-crash");
      await Bun.sleep(5);
    }
    throw new Error("app-crash");
  }
  async function unauthorized(route: AppRoute, body: BodyInit): Promise<void> {
    const { status, envelope } = await post(route, body, false);
    if (status !== 401 || envelope.error?.code !== "unauthorized") throw new Error("inert-grant-admitted");
  }
  async function read(route: AppRoute): Promise<Record<string, unknown>> {
    const { code, data } = await send(route, "{}");
    if (code !== "succeeded" || data === undefined) throw new Error("app-crash");
    return data;
  }
  /** Revisions are read through the app itself and kept until something that could change them succeeds. */
  async function world(): Promise<AppWorld & { applied: string }> {
    if (revisions === null) {
      const sources = (await read("sources"))["sources"] as { source_key: string; revision: number }[];
      revisions = { source: sources.find(item => item.source_key === source)?.revision ?? 0, model: String((await read("model_status"))["revision"]) };
    }
    return { source, sourceRevision: revisions.source, modelRevision: revisions.model, claim, applied, operation: () => `synthetic-${++sequence}` };
  }
  /** Two live claims: previews name one and the correction witness applies the other. */
  async function seedClaims(): Promise<string[]> {
    const db = openLedger(join(vaultPath, ".kizuki/kizuki.db"));
    try {
      initAgents(db);
      const proposer = addAgent(db, "synthetic-proposer", { ...OWNER_AGENT_GRANT, tools: [...OWNER_AGENT_GRANT.tools] });
      const principal = authenticate(db, proposer.token);
      if (principal === null) throw new Error("fixture-authentication");
      const ids: string[] = [];
      for (const name of ["preview", "applied"]) {
        const stored = accept(db, { schema: "kizuki.event/v1", connector_id: "synthetic", source_record_id: `synthetic-${name}`, kind: "message", occurred_at: NOW, observed_at: NOW,
          text: `Synthetic ${name} evidence.`, subjects: [{ subject_id: `person:${name}`, role: "about" }], attachments: [], metadata: {}, deleted: false, sensitivity_hint: "private" });
        if (stored.status !== "stored") throw new Error("fixture-ingress");
        const proposed = await servePropose({ db, vaultPath, principal }, { kind: "claim", target: "facts:employment.works_at", body: `Synthetic ${name} fact.`,
          subjects: [`person:${name}`], subject: `person:${name}`, predicate: "employment.works_at", object: "Acme", provenance: [stored.event.event_id] });
        if (proposed.data === undefined) throw new Error("fixture-claim");
        ids.push(proposed.data.claim_id);
      }
      return ids;
    } finally { db.close(); }
  }
  async function witnesses(): Promise<Record<string, string[]>> {
    const proved: Record<string, string[]> = {};
    for (const witness of APP_WITNESSES) {
      const { route, control, accepted, broken } = witness(await world());
      // Refusals change nothing, so they go first, while the control's revisions are current.
      const refused: string[] = [];
      for (const item of broken) {
        refused.push((await send(route, JSON.stringify(withValue(control, item.at, item.value)))).code);
        if (refused.at(-1) !== item.refused) throw new Error("projection-unreached");
      }
      const code = (await send(route, JSON.stringify(control))).code;
      if (code !== accepted) throw new Error("projection-unreached");
      (proved[route] ??= []).push(code, ...refused);
    }
    return proved;
  }

  async function close(): Promise<void> { await http.stop(); await host.close(); }
  const routes = Object.keys(appEnvelopes({ source: "", sourceRevision: 0, modelRevision: "", claim: "", operation: () => "" })) as AppRoute[];
  try {
    if ((await send("initialize", JSON.stringify({ no_service: true }))).code !== "succeeded") throw new Error("fixture-init");
    const enrolled = await send("enroll", JSON.stringify({ provider: "markdown", path: notes }));
    if (enrolled.code !== "succeeded" || typeof enrolled.data?.["source_key"] !== "string") throw new Error("fixture-enroll");
    source = enrolled.data["source_key"];
    const claims = await seedClaims();
    claim = claims[0]!; applied = claims[1]!;
  } catch (error) { await close(); throw error; }

  return {
    httpOrigin: http.url,
    request: (route: AppRoute, args: Envelope) => send(route, JSON.stringify(args)),
    async run(input: FuzzCase) {
      // Raw bytes meet every route's body reader and top-level parser. The bearer check does not
      // depend on the route, so one route per case, and every route for the object case, refuses them unauthenticated.
      const bytes = new Uint8Array(input.bytes);
      for (const [at, route] of routes.entries()) {
        if (input.id === "object" || at === served % routes.length) await unauthorized(route, bytes);
        await send(route, bytes);
      }
      served++;
      // Wrapped: one field of a valid envelope holds the hostile text, or another JSON type.
      for (let at = 0; at < SLOTS_PER_CASE; at++) {
        const slot = APP_SLOTS[(cursor + at) % APP_SLOTS.length]!;
        const base = appEnvelopes(await world())[slot.route][slot.base]!;
        await send(slot.route, JSON.stringify(withValue(base, slot.path, confuse(input.text, cursor + at))));
      }
      cursor += SLOTS_PER_CASE;
      return input.id === "object" ? witnesses() : undefined;
    },
    close,
  };
}
