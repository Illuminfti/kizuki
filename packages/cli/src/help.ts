import type { Command } from "./commands/index";
import { UsageError } from "./args";
import { RETIRED_OWNER_GATE_VERBS } from "./retired";
import { INVOCATION, IS_COMPILED } from "./runtime";
export { INVOCATION } from "./runtime";

const GROUPS: readonly { title: string; names: readonly string[] }[] = [
  { title: "Start", names: ["init", "import", "doctor"] },
  { title: "Recall", names: ["query", "context"] },
  { title: "Sources", names: ["connect", "backfill", "sync"] },
  { title: "Correct", names: ["tell", "undo", "audit"] },
  { title: "Run", names: ["serve", "models"] },
  { title: "Custody", names: ["purge", "export", "restore"] },
  { title: "Meta", names: ["version"] },
];

const EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  init: [`${INVOCATION} init ./vault`],
  import: [`${INVOCATION} import markdown-folder --source ./notes`],
  query: [
    `${INVOCATION} query acme`,
    `${INVOCATION} query acme --scope canon`,
    `${INVOCATION} query acme --degraded`,
  ],
  context: [
    `${INVOCATION} context --purpose session --query "acme"`,
    `${INVOCATION} context --purpose recall --query "acme" --budget 1200`,
    `${INVOCATION} context --json`,
  ],
  doctor: [`${INVOCATION} doctor`, `${INVOCATION} doctor --json`],
  connect: [
    `${INVOCATION} connect`,
    `${INVOCATION} connect beeper --token-ref env:BEEPER_TOKEN`,
    `${INVOCATION} connect imap`,
    `${INVOCATION} connect markdown-folder --source ./notes`,
    `${INVOCATION} connect status --json`,
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
  models: [`${INVOCATION} models pull --from ./model.gguf`],
  purge: [
    `${INVOCATION} purge --event EVENT_ID --reason "owner request"`,
    `${INVOCATION} purge --verify RECEIPT_ID`,
  ],
  export: [`${INVOCATION} export --out ./export`],
  restore: [
    `${INVOCATION} restore --from ./export --verify`,
    `${INVOCATION} restore --from ./export --into ./restored`,
  ],
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
  write(`  ${INVOCATION} init ./vault`);
  write(`  ${INVOCATION} import markdown-folder --source ./notes`);
  write(`  ${INVOCATION} query acme`);
  write(`  ${INVOCATION} context --purpose session --query "acme"`);
  write(`  ${INVOCATION} doctor`);
  write("");
  write("Give your agent a focused context packet, with sources, using context.");
  write("Capture and recall work without a model. Automatic canon writing needs one.");
  write("Use connect to browse local files, exports, and Beeper messaging. Direct account sign-in is not available here.");
  write(
    `${RETIRED_OWNER_GATE_VERBS.join(", ")} are retired. Use audit, undo, and tell.`,
  );
  write("Docs: README.md · docs/cli.md · docs/architecture.md");
}

export function printCommandHelp(
  write: (line: string) => void,
  command: Command,
): void {
  write(`usage: kizuki ${command.usage}`);
  write("");
  write(command.summary);
  const examples = EXAMPLES[command.name];
  if (examples === undefined || examples.length === 0) return;
  write("");
  write("Examples");
  for (const example of examples) write(`  ${example}`);
}

export function usageLines(command: Command, error: UsageError): string[] {
  const lines: string[] = [];
  const message = error.message;
  if (
    message.length > 0 &&
    message !== command.usage &&
    message !== "wrong arity"
  ) {
    lines.push(`error: ${message}`);
  }
  lines.push(`usage: kizuki ${command.usage}`);
  lines.push(`Try \`${INVOCATION} help ${command.name}\` for flags and examples.`);
  return lines;
}
