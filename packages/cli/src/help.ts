import type { Command, CommandHelpSchema } from "./commands/index";
import { UsageError } from "./args";
import { RETIRED_OWNER_GATE_VERBS } from "./retired";
import { INVOCATION, IS_COMPILED } from "./runtime";
import { jsonEnvelope } from "./output";
export { INVOCATION } from "./runtime";

export type HelpTopic = Pick<Command, "name" | "usage" | "summary" | "schema">;

const GROUPS: readonly { title: string; names: readonly string[] }[] = [
  { title: "Start", names: ["app", "init", "import", "doctor"] },
  { title: "Recall", names: ["query", "context"] },
  { title: "Sources", names: ["connect", "backfill", "sync"] },
  { title: "Correct", names: ["tell", "undo", "audit"] },
  { title: "Run", names: ["serve", "models", "agent"] },
  { title: "Custody", names: ["purge", "export", "restore", "rebuild", "recover"] },
  { title: "Meta", names: ["version"] },
];

const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  app: [`${INVOCATION} app`],
  init: [`${INVOCATION} init ./vault`],
  import: [`${INVOCATION} import markdown-folder --source ./notes --policy POLICY.json --expected-revision 0 --operation-id first-import`],
  query: [
    `${INVOCATION} query acme`,
    `${INVOCATION} query acme --scope canon`,
    `${INVOCATION} query acme --degraded`,
  ],
  context: [
    `${INVOCATION} context --purpose session --query "acme"`,
    `${INVOCATION} context --purpose recall --query "acme" --budget 1200`,
    `${INVOCATION} context --since 2020-01-01T00:00:00.000Z --until 2030-01-01T00:00:00.000Z --query "Atlas"`,
    `${INVOCATION} context --json`,
  ],
  doctor: [`${INVOCATION} doctor`, `${INVOCATION} doctor --json`],
  connect: [
    `${INVOCATION} connect`,
    `${INVOCATION} connect beeper --token-ref env:BEEPER_TOKEN`,
    `${INVOCATION} connect imap`,
    `${INVOCATION} connect markdown-folder --source ./notes`,
    `${INVOCATION} connect status --json`,
    `${INVOCATION} connect grant --source KEY --policy POLICY.json --expected-revision 0 --operation-id first-grant`,
    `${INVOCATION} connect revoke --source KEY --expected-revision 1 --operation-id revoke-1`,
  ],
  backfill: [`${INVOCATION} backfill markdown-folder`],
  sync: [`${INVOCATION} sync`, `${INVOCATION} sync markdown-folder`],
  tell: [
    `${INVOCATION} tell "the name is Ada" --claim CLAIM_ID`,
    `${INVOCATION} tell "the name is Ada" --claim CLAIM_ID --dry-run`,
  ],
  undo: [`${INVOCATION} undo RECEIPT_ID`],
  audit: [`${INVOCATION} audit --list`, `${INVOCATION} audit --json`],
  serve: [
    `${INVOCATION} serve --once --no-http`,
    `${INVOCATION} serve status`,
  ],
  models: [
    `${INVOCATION} models list`,
    `${INVOCATION} models list --catalog`,
    `${INVOCATION} models pull kizuki-fixture-embed`,
    `${INVOCATION} models pull --from ./model.gguf`,
    `${INVOCATION} models remove model.gguf`,
  ],
  agent: [
    `${INVOCATION} agent add assistant --grant GRANT.json --token-ref file:/absolute/private/credential --operation-id assistant-setup-1 --dry-run`,
    `${INVOCATION} agent add assistant --grant GRANT.json --token-ref file:/absolute/private/credential --operation-id assistant-setup-1`,
    `${INVOCATION} agent revoke assistant`,
  ],
  purge: [
    `${INVOCATION} purge --event EVENT_ID --reason "owner request"`,
    `${INVOCATION} purge --verify RECEIPT_ID`,
  ],
  export: [`${INVOCATION} export --out ./export`],
  restore: [
    `${INVOCATION} restore --from ./export --verify`,
    `${INVOCATION} restore --from ./export --into ./restored`,
  ],
  rebuild: [`${INVOCATION} rebuild`, `${INVOCATION} rebuild --prune-old`],
  recover: [`${INVOCATION} recover`],
  version: [`${INVOCATION} version`],
};

export function printRootHelp(
  write: (line: string) => void,
  commands: readonly Command[],
): void {
  const byName = new Map(commands.map((command) => [command.name, command]));
  const width = Math.max(...commands.map((command) => command.name.length));

  write(
    "Kizuki — local-first LifeOS. Your context, ready when you need it.",
  );
  write("");
  write("usage: kizuki <verb> [options]");
  write("");
  write(IS_COMPILED ? "Run:" : "Invoke from this checkout:");
  write(`  ${INVOCATION} <verb> [options]`);
  write("");
  write("Global options");
  write("  --vault <path|name>   vault path or a name from config");
  write("");

  const listed = new Set<string>();
  for (const group of GROUPS) {
    write(group.title);
    for (const name of group.names) {
      const command = byName.get(name);
      if (command === undefined) continue;
      listed.add(name);
      write(`  ${command.name.padEnd(width)}  ${command.summary}`);
    }
    write("");
  }

  for (const command of commands) {
    if (listed.has(command.name)) continue;
    write(`  ${command.name.padEnd(width)}  ${command.summary}`);
  }

  write("Examples");
  write(`  ${INVOCATION} app`);
  write(`  ${INVOCATION} init ./vault`);
  write(`  ${INVOCATION} import markdown-folder --source ./notes --policy POLICY.json --expected-revision 0 --operation-id first-import`);
  write(`  ${INVOCATION} query acme`);
  write(`  ${INVOCATION} context --purpose session --query "acme"`);
  write(`  ${INVOCATION} doctor`);
  write("");
  write("Give your agent a focused context packet, with sources, using context.");
  write("Capture and recall work without a model. Automatic canon writing needs one.");
  write("The app needs a graphical desktop and a default web browser.");
  write("Linux uses /usr/bin/xdg-open; macOS uses /usr/bin/open.");
  write("Use connect to enroll local files, exports, Beeper messaging, IMAP, Telegram, Gmail, and Google Calendar.");
  write("Other account connectors are not enrollable here. None of these sign-in paths are live-account qualified.");
  write(
    `${RETIRED_OWNER_GATE_VERBS.join(", ")} are retired. Use audit, undo, and tell.`,
  );
  write(IS_COMPILED ? "Setup guide: README.txt beside these executables." : "Docs: README.md · docs/cli.md · docs/architecture.md");
}

const EXIT_CODES = [
  { code: 0, meaning: "ok" },
  { code: 1, meaning: "runtime error" },
  { code: 2, meaning: "usage error" },
] as const;

function schemaOf(command: HelpTopic): CommandHelpSchema {
  return command.schema ?? { options: [], flags: [] };
}

export function commandHelpData(command: HelpTopic): {
  name: string;
  usage: string;
  summary: string;
  options: readonly string[];
  flags: readonly string[];
  defaults: Readonly<Record<string, string>>;
  bounds: Readonly<Record<string, string>>;
  irreversible: boolean;
  examples: readonly string[];
  exit_codes: readonly { code: number; meaning: string }[];
} {
  const schema = schemaOf(command);
  return {
    name: command.name,
    usage: command.usage,
    summary: command.summary,
    options: schema.options,
    flags: schema.flags,
    defaults: schema.defaults ?? {},
    bounds: schema.bounds ?? {},
    irreversible: schema.irreversible === true,
    examples: EXAMPLES[command.name] ?? [],
    exit_codes: EXIT_CODES,
  };
}

export function printCommandHelp(
  write: (line: string) => void,
  command: HelpTopic,
  options: { json?: boolean } = {},
): void {
  if (options.json === true) {
    write(jsonEnvelope("help", "ok", commandHelpData(command)));
    return;
  }
  write(`usage: kizuki ${command.usage}`);
  write("");
  write(command.summary);
  const schema = schemaOf(command);
  if (schema.options.length > 0) {
    write("");
    write("Options");
    for (const name of schema.options) {
      const parts = [name];
      const bounds = schema.bounds?.[name];
      const fallback = schema.defaults?.[name];
      if (bounds !== undefined) parts.push(bounds);
      if (fallback !== undefined) parts.push(`default ${fallback}`);
      write(`  ${parts.join("  ")}`);
    }
  }
  if (schema.flags.length > 0) {
    write("");
    write("Flags");
    for (const name of schema.flags) write(`  ${name}`);
  }
  if (schema.irreversible === true) {
    write("");
    write("Irreversible");
    write("  Physical event deletion cannot be undone. Canon rewrites stay reversible by receipt.");
  }
  write("");
  write("Exit codes");
  for (const item of EXIT_CODES) write(`  ${item.code}  ${item.meaning}`);
  const examples = EXAMPLES[command.name];
  if (examples === undefined || examples.length === 0) return;
  write("");
  write("Examples");
  for (const example of examples) write(`  ${example}`);
}

export function usageLines(command: Command, error: UsageError): string[] {
  const lines: string[] = [];
  const message = error.message;
  lines.push(`error: ${message.length > 0 && message !== command.usage ? message : "invalid arguments"}`);
  lines.push(`usage: kizuki ${command.usage}`);
  lines.push(`Try \`${INVOCATION} help ${command.name}\` for flags and examples.`);
  return lines;
}
