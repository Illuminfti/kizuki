import type { CommandHelpSchema } from "./commands/index";
import type { HelpTopic } from "./help";

export const CONNECT_GRANT_SCHEMA = {
  options: ["--source", "--policy", "--expected-revision", "--operation-id"],
  flags: ["--json"],
  bounds: {
    "--source": "KEY",
    "--policy": "FILE",
    "--expected-revision": "N",
    "--operation-id": "ID",
  },
} as const satisfies CommandHelpSchema;

export const CONNECT_REVOKE_SCHEMA = {
  options: ["--source", "--expected-revision", "--operation-id"],
  flags: ["--json"],
  bounds: {
    "--source": "KEY",
    "--expected-revision": "N",
    "--operation-id": "ID",
  },
} as const satisfies CommandHelpSchema;

export const CONNECT_RESUME_SCHEMA = {
  options: ["--source", "--operation-id"],
  flags: ["--json"],
  bounds: {
    "--source": "KEY",
    "--operation-id": "ID",
  },
  irreversible: true,
} as const satisfies CommandHelpSchema;

const CONNECT_CONSENT_STATUS_SCHEMA = {
  options: ["--source"],
  flags: ["--json"],
} as const satisfies CommandHelpSchema;

type ConnectConsentAction = "grant" | "revoke" | "resume-revocation";

export function connectConsentSchema(action: string | undefined): CommandHelpSchema | undefined {
  if (action === "grant") return CONNECT_GRANT_SCHEMA;
  if (action === "revoke") return CONNECT_REVOKE_SCHEMA;
  if (action === "resume-revocation") return CONNECT_RESUME_SCHEMA;
  if (action === "status") return CONNECT_CONSENT_STATUS_SCHEMA;
  return undefined;
}

function consentHelpCommand(
  action: ConnectConsentAction,
  usage: string,
  summary: string,
  schema: CommandHelpSchema,
): HelpTopic {
  return {
    name: `connect ${action}`,
    usage,
    summary,
    schema,
  };
}

const CONNECT_CONSENT_HELP: Readonly<Record<ConnectConsentAction, HelpTopic>> = {
  grant: consentHelpCommand(
    "grant",
    "connect grant --source KEY --policy FILE --expected-revision N --operation-id ID [--json]",
    "authorize one enrolled source with an explicit owner policy",
    CONNECT_GRANT_SCHEMA,
  ),
  revoke: consentHelpCommand(
    "revoke",
    "connect revoke --source KEY --expected-revision N --operation-id ID [--json]",
    "deny one source grant; physical purge stays a separate resume",
    CONNECT_REVOKE_SCHEMA,
  ),
  "resume-revocation": consentHelpCommand(
    "resume-revocation",
    "connect resume-revocation --source KEY --operation-id ID [--json]",
    "resume physical purge for a denied source and its revoke operation",
    CONNECT_RESUME_SCHEMA,
  ),
};

export function lookupCommandHelp(
  verb: string,
  rest: readonly string[],
): HelpTopic | undefined {
  if (verb !== "connect" || rest.length !== 1) return undefined;
  const action = rest[0];
  if (action !== "grant" && action !== "revoke" && action !== "resume-revocation") {
    return undefined;
  }
  return CONNECT_CONSENT_HELP[action];
}
