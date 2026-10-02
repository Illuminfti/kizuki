import { inspectSourceCoverage } from "@kizuki/core/world";
import { sourceCoverageLines } from "./source-coverage";
import { xApiClient } from "./x-api";
import { appCredentials } from "@kizuki/connector-telegram";
import { REGISTRY } from "@kizuki/connectors";
import { inspectSourceGrant, getCheckpoint, getConnectorSensitivity } from "@kizuki/core";
import { listEnrollableConnectorIds, listHostConnections } from "./connections";
import { withReadVault } from "./context";
import { clean, jsonEnvelope, table } from "./output";
import type { CliIo } from "./commands";
import { INVOCATION } from "./runtime";
import { egressDestination, egressRetention, egressView } from "./egress-view";

const TITLES: Record<string, string> = {
  "kizuki.beeper": "Beeper Desktop",
  "kizuki.markdown-folder": "Markdown folder",
  "kizuki.import-chatgpt": "ChatGPT export",
  "kizuki.import-claude": "Claude export",
  "kizuki.import-whatsapp": "WhatsApp export",
  "kizuki.import-pocket": "Pocket export",
  "kizuki.import-omnivore": "Omnivore export",
  "kizuki.import-x-archive": "X archive export",
  "kizuki.import-legacy-wiki": "Markdown wiki migration",
  "kizuki.import-beacon": "Beacon agent-run import",
  "kizuki.import-legacy-events": "Event history migration",
  "kizuki.screenpipe": "Screenpipe",
  "kizuki.claude-code-sessions": "Claude Code sessions",
  "kizuki.codex-sessions": "Codex sessions",
  "kizuki.ics": "Calendar (ICS)",
  "kizuki.x": "X own-post browser sign-in",
  "kizuki.gmail": "Gmail read-only browser sign-in",
  "kizuki.google-calendar": "Google Calendar read-only browser sign-in",
  "kizuki.imap": "Email (IMAP)",
  "kizuki.telegram": "Telegram sign-in",
};

export interface NotEnrollableSource {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
}

/**
 * Components this CLI deliberately does not enroll. An entry is an honest
 * absence, not a capability: it never enters the connector registry, never
 * becomes resolvable by `connect <connector>`, and carries no setup path. Each
 * reason is stated verbatim in the "Not enrollable from this CLI" section of
 * docs/connect.md, which packages/cli/test/connect-catalog.test.ts asserts.
 */
export const NOT_ENROLLABLE: readonly NotEnrollableSource[] = Object.freeze([
  Object.freeze({
    id: "kizuki.whoop",
    name: "WHOOP",
    reason: "WHOOP's documented eight-character OAuth state and registered redirect are unqualified against Core's PKCE and dynamic loopback callback, and local desktop custody of the server-side Client Secret WHOOP documents is not sanctioned here.",
  }),
]);

export function printConnectorCatalog(io: CliIo, json: boolean): number {
  let xConfigured = false;
  try { xApiClient(io.env); xConfigured = true; } catch { /* New enrollment configuration only; existing v2 sources carry their own. */ }
  const enrollable = new Set(listEnrollableConnectorIds());
  const sources = Object.keys(REGISTRY).sort().map((id) => ({
    id,
    name: TITLES[id] ?? id,
    mode: id === "kizuki.x" ? "native account sign-in" : id === "kizuki.google-calendar" ? "native account sign-in" : id === "kizuki.telegram" || id === "kizuki.gmail" || id === "kizuki.imap" ? "native account sign-in" : id === "kizuki.beeper" ? "local app" : id === "kizuki.ics" ? "local file or https feed" : id.includes("import-") ? "export import" :
      enrollable.has(id) ? "local source" : "account sign-in",
    available: enrollable.has(id) && (id !== "kizuki.x" || xConfigured) && (id !== "kizuki.google-calendar" || /^[A-Za-z0-9._-]{1,512}$/.test(io.env.KIZUKI_GOOGLE_CALENDAR_CLIENT_ID ?? "")) && (id !== "kizuki.telegram" || appCredentials() !== null) && (id !== "kizuki.gmail" || /^[A-Za-z0-9._-]{1,512}$/.test(io.env.KIZUKI_GMAIL_CLIENT_ID ?? "")),
    cli_enrollable: enrollable.has(id),
    detail: id === "kizuki.x" ? "CLI wired; public native app, exact registered loopback callback, explicit fields/history start, usage credits and separate source consent required; --no-browser prints the sign-in address for a headless server; real-account qualification pending" : id === "kizuki.google-calendar" ? "CLI wired; operator desktop client, canonical calendar, explicit fields, browser sign-in (--no-browser prints the address for a headless server) and separate source consent required; real-account qualification pending" : id === "kizuki.gmail" ? "CLI wired; operator desktop-client configuration, explicit fields, browser sign-in (--no-browser prints the address for a headless server) and separate source consent required" : id === "kizuki.ics" ? "ready to connect; a local file with --source or an https feed with --url" : id === "kizuki.telegram" && appCredentials() === null ? "CLI wired; project app credentials missing" : ["kizuki.import-legacy-events", "kizuki.import-legacy-wiki"].includes(id) ? "local export and explicit mapping required; source consent required before capture" : enrollable.has(id) ? "ready to connect" : "not yet available from this CLI",
  }));
  if (json) {
    io.out(jsonEnvelope("connect", "ok", { sources, not_enrollable: NOT_ENROLLABLE }));
    return 0;
  }
  io.out("Kizuki Connect");
  io.out("Bring your sources into one private, searchable memory.");
  io.out("");
  for (const line of table([
    ["Source", "Connector", "How", "Status"],
    ...sources.map((source) => [source.name, source.id.replace(/^kizuki\./, ""), source.mode, source.detail]),
  ])) io.out(line);
  io.out("");
  io.out("Not enrollable from this CLI:");
  for (const entry of NOT_ENROLLABLE) {
    io.out(`  ${entry.name} (${entry.id})`);
    io.out(`  ${entry.reason}`);
  }
  io.out("");
  io.out(`Notes:     ${INVOCATION} import markdown-folder --source ./notes --policy POLICY.json --expected-revision 0 --operation-id first-import`);
  if (enrollable.has("kizuki.beeper")) {
    io.out(`Messages:  ${INVOCATION} connect beeper --token-ref env:BEEPER_TOKEN`);
    io.out("In Beeper Desktop, enable the Desktop API and create an approved connection token.");
    io.out("Beeper reads the messaging accounts you already linked there; local history may be incomplete.");
  }
  io.out(`Progress:  ${INVOCATION} connect status`);
  return 0;
}

export async function printConnectionStatus(io: CliIo, json: boolean): Promise<number> {
  return withReadVault(io, async (ctx) => {
    const coverage = new Map(inspectSourceCoverage(ctx.db).map(report => [report.source_key, report]));
    const connections = listHostConnections(ctx.db, ctx.store, undefined, { includeDisconnected: true }).map((host) => {
      const row = host.connection;
      const checkpoint = getCheckpoint(ctx.db, row.connector_id, row.source_key);
      const grant = inspectSourceGrant(ctx.db, row.source_key);
      const policy = getConnectorSensitivity(ctx.db, row.connector_id, row.source_key);
      return {
        coverage: coverage.get(row.source_key)!,
        connector_id: row.connector_id,
        source_key: row.source_key,
        state: row.disconnected_at !== null ? "disconnected" : host.state === null ? "needs attention" : "enrolled",
        consent: grant?.status ?? "required",
        egress: egressView(ctx.vaultPath, grant),
        revision: grant?.revision ?? 0,
        purge_blockers: grant?.purge_blockers ?? [],
        sensitivity: policy?.default_sensitivity ?? "not recorded",
        last_run: checkpoint?.last_run_at ?? null,
        stored: checkpoint?.last_result.stored ?? 0,
        errors: checkpoint?.last_result.errors.length ?? 0,
      };
    });
    ctx.assertCurrent();
    if (json) io.out(jsonEnvelope("connect", "ok", { connections }));
    else if (connections.length === 0) {
      io.out("No sources connected yet.");
      io.out(`Choose a source: ${INVOCATION} connect`);
    } else {
      for (const line of table([
        ["Connector", "Source", "State", "Consent", "Privacy", "Egress", "Retention", "Last run", "Stored", "Errors"],
        ...connections.map((row) => [clean(row.connector_id), row.source_key, row.state, row.consent, row.sensitivity, clean(egressDestination(row.egress)), clean(egressRetention(row.egress)),
          row.last_run === null ? "not synced yet" : clean(row.last_run), `${row.stored}`, `${row.errors}`]),
      ])) io.out(line);
      for (const row of connections) for (const line of sourceCoverageLines(row.coverage)) io.out(line);
      io.out(`Refresh: ${INVOCATION} sync`);
    }
    return 0;
  }, { retrieval: "none" });
}
