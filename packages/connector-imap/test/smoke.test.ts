import { expect, test } from "bun:test";
import { validateEventInput } from "@kizuki/core";
import { createImapConnector } from "../src/connector";
import { DEFAULT_MAX_MESSAGE_BYTES, serializeImapState } from "../src/state";

const VARIABLES = [
  "KIZUKI_IMAP_SMOKE_HOST",
  "KIZUKI_IMAP_SMOKE_PORT",
  "KIZUKI_IMAP_SMOKE_USERNAME",
  "KIZUKI_IMAP_SMOKE_PASSWORD",
] as const;

const values = VARIABLES.map((name) => Bun.env[name]);
const configured = values.every(
  (value) => typeof value === "string" && value.length > 0,
);

const smoke = configured ? test : test.skip;

smoke(
  `signs in against a real server (set ${VARIABLES.join(", ")} to run)`,
  async () => {
    const [host = "", port = "", username = "", password = ""] = values;
    const state = serializeImapState({
      schema: "kizuki.imap-state/v1",
      host,
      port: Number(port),
      username,
      password,
      folders: ["INBOX"],
      max_message_bytes: DEFAULT_MAX_MESSAGE_BYTES,
    });
    const connector = createImapConnector({
      secret_ref: "file:connections/smoke.state",
    });
    await connector.connect(async () => new TextDecoder().decode(state));

    const report = await connector.health();
    expect(report.state).toBe("ok");

    const batch = await connector.backfill(null);
    expect(batch.cursor).not.toBeNull();
    for (const event of batch.events) {
      expect(validateEventInput(event).ok).toBe(true);
    }
  },
  60_000,
);
