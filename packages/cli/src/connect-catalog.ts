import { REGISTRY } from "@kizuki/connectors";
import { inspectSourceGrant, getCheckpoint, getConnectorSensitivity } from "@kizuki/core";
import { listEnrollableConnectorIds, listHostConnections } from "./connections";
import { withVault } from "./context";
import { clean, jsonEnvelope, table } from "./output";
import type { CliIo } from "./commands";
import { INVOCATION } from "./runtime";

const TITLES: Record<string, string> = {
  "kizuki.beeper": "Beeper Desktop",
  "kizuki.markdown-folder": "Markdown folder",
  "kizuki.import-chatgpt": "ChatGPT export",
  "kizuki.import-claude": "Claude export",
  "kizuki.import-whatsapp": "WhatsApp export",
  "kizuki.import-pocket": "Pocket export",
  "kizuki.import-omnivore": "Omnivore export",
  "kizuki.import-legacy-wiki": "Markdown wiki migration",
  "kizuki.import-legacy-events": "Event history migration",
  "kizuki.screenpipe": "Screenpipe",
  "kizuki.ics": "Calendar (ICS)",
  "kizuki.imap": "Email (IMAP)",
  "kizuki.telegram": "Telegram sign-in",
};

export function printConnectorCatalog(io: CliIo, json: boolean): number {
  const enrollable = new Set(listEnrollableConnectorIds());
  const sources = Object.keys(REGISTRY).sort().map((id) => ({
    id,
    name: TITLES[id] ?? id,
    mode: id === "kizuki.beeper" ? "local app" : id.includes("import-") ? "export import" :
      enrollable.has(id) ? "local source" : "account sign-in",
    available: enrollable.has(id),
    detail: enrollable.has(id) ? "ready to connect" : "not yet available from this CLI",
  }));
  if (json) {
    io.out(jsonEnvelope("connect", "ok", { sources }));
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
  return withVault(io, async (ctx) => {
    const connections = listHostConnections(ctx.db, ctx.store, undefined, { includeDisconnected: true }).map((host) => {
      const row = host.connection;
      const checkpoint = getCheckpoint(ctx.db, row.connector_id, row.source_key);
      const grant = inspectSourceGrant(ctx.db, row.source_key);
      const policy = getConnectorSensitivity(ctx.db, row.connector_id, row.source_key);
      return {
        connector_id: row.connector_id,
        source_key: row.source_key,
        state: row.disconnected_at !== null ? "disconnected" : host.state === null ? "needs attention" : "enrolled",
        consent: grant?.status ?? "required",
        revision: grant?.revision ?? 0,
        purge_blockers: grant?.purge_blockers ?? [],
        sensitivity: policy?.default_sensitivity ?? "not recorded",
        last_run: checkpoint?.last_run_at ?? null,
        stored: checkpoint?.last_result.stored ?? 0,
        errors: checkpoint?.last_result.errors.length ?? 0,
      };
    });
    if (json) io.out(jsonEnvelope("connect", "ok", { connections }));
    else if (connections.length === 0) {
      io.out("No sources connected yet.");
      io.out(`Choose a source: ${INVOCATION} connect`);
    } else {
      for (const line of table([
        ["Connector", "Source", "State", "Consent", "Privacy", "Last run", "Stored", "Errors"],
        ...connections.map((row) => [clean(row.connector_id), row.source_key, row.state, row.consent, row.sensitivity,
          row.last_run === null ? "not synced yet" : clean(row.last_run), `${row.stored}`, `${row.errors}`]),
      ])) io.out(line);
      io.out(`Refresh: ${INVOCATION} sync`);
    }
    return 0;
  }, { retrieval: "none" });
}
