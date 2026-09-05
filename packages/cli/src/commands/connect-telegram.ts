import { applyConnectionSensitivity, inspectSourceGrant } from "@kizuki/core";
import type { Connection, Manifest, Sensitivity } from "@kizuki/core";
import type { Database } from "bun:sqlite";
import { TelegramConnector, TelegramConnectorError, assertSameTelegramIdentity, assertTelegramRetryAllowed, PLACEHOLDER_CREDENTIALS_MESSAGE } from "@kizuki/connector-telegram";
import { UsageError } from "../args";
import { ConnectionError, enrollSignedInConnection, listHostConnections } from "../connections";
import { consentHint } from "../source-consent";
import { withVault } from "../context";
import { clean, jsonEnvelope } from "../output";
import type { CliIo } from "./index";

export interface TelegramEnrollmentOptions { source?: string | undefined; sensitivity?: Sensitivity | undefined; json: boolean; }
const ID = "kizuki.telegram";

/** All answers are secret, including phone and one-time code; provider text is not output. */
export function telegramSignInIo(io: CliIo) {
  return {
    prompt: (question: string) => io.prompt(clean(question).slice(0, 512), { secret: true }),
    notify: (text: string) => {
      // The connector emits this closed vocabulary; never forward account/provider text.
      if (/^(that (?:password|code) was not accepted, try again|nothing was entered, try again|Telegram asked us to wait [0-9]+s)$/.test(text)) io.err(text);
    },
    openUrl: async () => { throw new ConnectionError("Telegram sign-in does not open a browser"); },
  };
}
export function telegramFailure(error: unknown): Error {
  if (error instanceof TelegramConnectorError) {
    if (error.code === "placeholder_credentials") return new ConnectionError(PLACEHOLDER_CREDENTIALS_MESSAGE);
    if (error.code === "flood_wait" && Number.isSafeInteger(error.retry_after) && error.retry_after! > 0) return new ConnectionError(`Telegram asked you to wait ${error.retry_after}s before retrying.`);
    const notices: Partial<Record<typeof error.code, string>> = {
      invalid_phone: "Telegram needs an international-format phone number.",
      sign_in_aborted: "Telegram sign-in was cancelled or repeatedly refused; no session was enrolled.",
      identity_mismatch: "Telegram account identity differs from this source; its history and session were preserved.",
      corrupt_state: "Telegram connection state is unreadable. Restore its protected state before re-signing in.",
      unauthenticated: "Telegram authorization was refused. Check the existing account and sign in again.",
      state_persistence_failed: "Telegram cooldown could not be saved. Stop this source and repair protected connection state before retrying.",
    };
    return new ConnectionError(notices[error.code] ?? "Telegram sign-in failed. Check connectivity and retry without changing the selected source.");
  }
  return new ConnectionError("Telegram sign-in did not complete; existing source state was preserved.");
}

export async function runTelegramConnect(
  io: CliIo,
  options: TelegramEnrollmentOptions,
  checkSensitivity: (db: Database, manifest: Manifest, requested: Sensitivity | undefined, connection?: Connection) => void,
  create: () => TelegramConnector = () => new TelegramConnector({}),
): Promise<number> {
  if (!io.stdinIsTTY || !io.stderrIsTTY) throw new UsageError("connect telegram [--source KEY] [--json] (interactive terminal required)");
  const connector = create();
  return withVault(io, async ctx => {
    const existing = listHostConnections(ctx.db, ctx.store, ID, { includeDisconnected: true });
    if (existing.some(item => item.state === null)) throw new ConnectionError("Telegram has missing or unreadable protected state. Restore it before enrolling another source.");
    const selected = options.source === undefined ? existing.length === 1 ? existing[0] : undefined : existing.find(item => item.connection.source_key === options.source);
    if (options.source !== undefined && selected === undefined) throw new ConnectionError("No Telegram connection matches this source key.");
    if (options.source === undefined && existing.length > 1) throw new ConnectionError("Several Telegram connections exist. Select one with --source KEY.");
    checkSensitivity(ctx.db, connector.manifest(), options.sensitivity, selected?.connection);
    let connection: Connection;
    try {
      if (selected !== undefined) {
        const state = ctx.store.read(selected.connection);
        if (state === null) throw new ConnectionError("Telegram state is missing");
        assertTelegramRetryAllowed(state);
      }
      io.err(`Telegram will sign in to read your accessible chats and history. Protected session state is stored under ${clean(ctx.vaultPath)}. Kizuki does not send messages or delete Telegram copies. Press Ctrl-C to cancel.`);
      connection = await enrollSignedInConnection(ctx.db, ctx.store, connector, telegramSignInIo(io), options.source, assertSameTelegramIdentity);
    } catch (error) { throw telegramFailure(error); }
    finally { await connector.close(); }
    applyConnectionSensitivity(ctx.db, connection, connector.manifest(), options.sensitivity);
    if (options.json) io.out(jsonEnvelope("connect", "ok", { connector_id: ID, source_key: connection.source_key, state: "enrolled", capture_started: false, consent: inspectSourceGrant(ctx.db, connection.source_key)?.status ?? "required", next: inspectSourceGrant(ctx.db, connection.source_key)?.status === "active" ? `kizuki backfill telegram --source ${connection.source_key}` : consentHint(ctx.db, connection.source_key) }));
    else {
      io.out(`connected ${ID} source=${connection.source_key}`);
      io.out("No history was captured during enrollment. Telegram source deletion detection is unsupported.");
      if (inspectSourceGrant(ctx.db, connection.source_key)?.status !== "active") io.out(consentHint(ctx.db, connection.source_key));
      else io.out(`next: kizuki backfill telegram --source ${connection.source_key}`);
    }
    return 0;
  }, { retrieval: "none" });
}
