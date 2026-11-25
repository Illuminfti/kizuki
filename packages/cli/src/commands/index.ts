// Compiled workers enter the same executable. Load the private worker bootstrap before command dispatch.
import "@kizuki/retrieval-pg/worker-entry";

export interface CliIo {
  env: Record<string, string | undefined>;
  vaultOverride: string | null;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stderrIsTTY: boolean;
  out(line: string): void;
  err(line: string): void;
  prompt(question: string, opts?: { secret?: boolean }): Promise<string>;
  /** Piped standard input, at most `maxBytes`; empty on a terminal. Absent in fixtures with no input. */
  readStdin?(maxBytes: number): Promise<string>;
}

export interface CommandHelpSchema {
  options: readonly string[];
  flags: readonly string[];
  defaults?: Readonly<Record<string, string>>;
  bounds?: Readonly<Record<string, string>>;
  irreversible?: boolean;
}

export interface Command {
  name: string;
  usage: string;
  summary: string;
  schema?: CommandHelpSchema;
  run(io: CliIo, args: string[]): Promise<number>;
}

function lazyCommand(
  meta: Omit<Command, "run">,
  load: () => Promise<Command>,
): Command {
  let loaded: Promise<Command> | undefined;
  return {
    ...meta,
    async run(io: CliIo, args: string[]): Promise<number> {
      const command = await (loaded ??= load());
      return command.run(io, args);
    },
  };
}

const appCommand: Command = lazyCommand(
  {
    name: "app",
    usage: "app [--no-open] [--no-service]",
    summary: "open the private local app without starting another writer",
    schema: {
      options: [],
      flags: ["--no-open", "--no-service"],
    },
  },
  () => import("./app").then((mod) => mod.appCommand),
);

const agentCommand: Command = lazyCommand(
  {
    name: "agent",
    usage: "agent add NAME --grant FILE --token-ref file:/absolute/path --operation-id ID [--dry-run] [--json] | agent grant NAME --grant FILE --operation-id ID [--json] | agent list [--json] | agent revoke NAME [--json]",
    summary: "connect a scoped agent, list agents, amend a grant in place, or revoke access",
    schema: {
      options: ["--grant", "--token-ref", "--operation-id"],
      flags: ["--dry-run", "--json"],
    },
  },
  () => import("./agent").then((mod) => mod.agentCommand),
);

const initCommand: Command = lazyCommand(
  {
    name: "init",
    usage: "init <path> [--default | --no-default] [--no-service] [--adopt] [--dry-run]",
    summary: "create a vault and install the local serve loop",
    schema: {
      options: [],
      flags: ["--default", "--no-default", "--no-service", "--adopt", "--dry-run"],
    },
  },
  () => import("./init").then((mod) => mod.initCommand),
);

const connectCommand: Command = lazyCommand(
  {
    name: "connect",
    usage: "connect [--list|status] [--json]\n       kizuki connect status --source KEY [--json]\n       kizuki connect grant --source KEY --policy FILE --expected-revision N --operation-id ID [--json]\n       kizuki connect revoke --source KEY --expected-revision N --operation-id ID [--json]\n       kizuki connect resume-revocation --source KEY --operation-id ID [--json]\n       kizuki connect <connector> --source PATH [--sensitivity public|personal|private]\n       kizuki connect claude-code-sessions|codex-sessions --source PATH [--exclude-cwd DIR ...] [--include-headless true|false]\n       kizuki connect ics --url https://HOST/PATH.ics [--sensitivity public|personal|private] [--json]\n       kizuki connect beeper --token-ref env:VAR|file:/absolute/path [--endpoint http://127.0.0.1:23373] [--sensitivity public|personal|private] [--json]\n       kizuki connect imap [--source KEY] [--sensitivity public|personal|private]\n       kizuki connect google-calendar --calendar CANONICAL_ID --fields summary,description,location,attendees,attachments|none [--source KEY | --new-source] [--no-browser] [--json]\n       kizuki connect recover-x-api --source KEY --fields relationships,links,media|none --history-start RFC3339 [--no-browser] [--json]\n       kizuki connect x-api --fields relationships,links,media|none --history-start RFC3339 [--source KEY | --new-source] [--no-browser] [--json]\n       kizuki connect gmail --fields text,subjects,headers,labels,attachments [--source KEY | --new-source] [--no-browser] [--json]\n       kizuki connect telegram [--source KEY] [--sensitivity public|personal|private] [--json]",
    summary: "enroll a supported source and check consent or sync status",
    schema: {
      options: [
        "--source",
        "--sensitivity",
        "--endpoint",
        "--token-ref",
        "--fields",
        "--calendar",
        "--history-start",
        "--url",
        "--exclude-cwd",
        "--include-headless",
      ],
      flags: ["--list", "--json", "--new-source", "--no-browser"],
    },
  },
  () => import("./connect").then((mod) => mod.connectCommand),
);

const backfillCommand: Command = lazyCommand(
  {
    name: "backfill",
    usage: "backfill <connector> [--source PATH|KEY]",
    summary: "drain a historical sweep until the selected connection is exhausted",
    schema: {
      options: ["--source"],
      flags: [],
    },
  },
  () => import("./backfill").then((mod) => mod.backfillCommand),
);

const syncCommand: Command = lazyCommand(
  {
    name: "sync",
    usage: "sync [connector] [--source PATH|KEY] [--confirm-withdrawals N] | sync --once",
    summary: "refresh selected sources until each connector reports exhaustion",
    schema: {
      options: ["--source", "--confirm-withdrawals"],
      flags: ["--once"],
    },
  },
  () => import("./sync").then((mod) => mod.syncCommand),
);

const importCommand: Command = lazyCommand(
  {
    name: "import",
    usage: "import <connector> --source PATH [--policy FILE --expected-revision N --operation-id ID] | import estate-slice --source FILE --authorization FILE --dry-run [--json]",
    summary: "import a file source, or dry-run an estate slice without writing records",
    schema: {
      options: ["--source", "--authorization", "--policy", "--expected-revision", "--operation-id"],
      flags: ["--dry-run", "--json"],
    },
  },
  () => import("./import").then((mod) => mod.importCommand),
);

const modelsCommand: Command = lazyCommand(
  {
    name: "models",
    usage: "models <list [--catalog] | pull <CATALOG_ID | --from PATH|URL [--sha256 HEX] [--bytes N]> | remove NAME>",
    summary: "list, install, or remove local GGUF files in the vault models directory",
    schema: {
      options: ["--from", "--sha256", "--bytes"],
      flags: ["--catalog"],
    },
  },
  () => import("./models").then((mod) => mod.modelsCommand),
);

const auditCommand: Command = lazyCommand(
  {
    name: "audit",
    usage: "audit [--since TIME] [--page PATH] [--writer NAME] [--contested] [--ambiguous] [--reverted] [--limit 1..5000] [--offset N] [--list] [--json]",
    summary: "see what changed, inspect its sources, and undo a write",
    schema: {
      options: ["--since", "--page", "--writer", "--limit", "--offset"],
      flags: ["--contested", "--ambiguous", "--reverted", "--json", "--list"],
      defaults: { "--limit": "5000", "--offset": "0" },
      bounds: { "--since": "TIME", "--limit": "1..5000", "--offset": "N" },
    },
  },
  () => import("./audit").then((mod) => mod.auditCommand),
);

const tellCommand: Command = lazyCommand(
  {
    name: "tell",
    usage: 'tell "<statement>" [--claim CLAIM_ID|--world-claim TOKEN] [--mode replace_object|retract|reclassify_mode|merge_identity|separate_identity] [--object TEXT|--object-ref TOKEN|--object-vocabulary ID] [--perspective-mode suggested|hypothetical|questioned] [--refresh-concept-ref TOKEN] [--since TIME] [--until TIME] [--dry-run] [--response-contract kizuki.envelope/v1|kizuki.envelope/v2] [--json] [--verbose]',
    summary: "correct a claim; rewrite affected canon in the same pass",
    schema: {
      options: [
        "--claim",
        "--world-claim",
        "--claim-group-ref",
        "--subject-ref",
        "--since",
        "--until",
        "--mode",
        "--object",
        "--object-ref",
        "--object-vocabulary",
        "--perspective-mode",
        "--refresh-concept-ref",
        "--response-contract",
      ],
      flags: ["--dry-run", "--json", "--verbose"],
      bounds: {
        "--response-contract": "kizuki.envelope/v1|kizuki.envelope/v2",
        "--since": "TIME",
        "--until": "TIME",
        "--mode": "replace_object|retract|reclassify_mode|merge_identity|separate_identity",
        "--object": "up to 400 characters",
        "--object-ref": "32-byte base64url object token",
        "--object-vocabulary": "a registered vocabulary value",
        "--perspective-mode": "suggested|hypothetical|questioned",
        "--refresh-concept-ref": "32-byte base64url object token",
      },
    },
  },
  () => import("./tell").then((mod) => mod.tellCommand),
);

const undoCommand: Command = lazyCommand(
  {
    name: "undo",
    usage: "undo <receipt_id> [--cascade]",
    summary: "restore prior canon bytes from a write receipt",
    schema: {
      options: [],
      flags: ["--cascade"],
    },
  },
  () => import("./undo").then((mod) => mod.undoCommand),
);

const queryCommand: Command = lazyCommand(
  {
    name: "query",
    usage: "query <text> [--scope canon|ledger|all] [--limit 1..50] [--response-contract kizuki.envelope/v1|kizuki.envelope/v2] [--json] [--degraded] [--full-text]",
    summary: "search current authorized evidence through configured retrieval and the lexical floor",
    schema: {
      options: ["--scope", "--limit", "--response-contract"],
      flags: ["--json", "--degraded", "--full-text"],
      defaults: { "--scope": "all", "--limit": "20" },
      bounds: {
        "--scope": "canon|ledger|all",
        "--limit": "1..50",
        "--response-contract": "kizuki.envelope/v1|kizuki.envelope/v2",
      },
    },
  },
  () => import("./query").then((mod) => mod.queryCommand),
);

const contextCommand: Command = lazyCommand(
  {
    name: "context",
    usage: "context [--purpose session|recall|correction|audit] [--budget N] [--query TEXT] [--since RFC3339] [--until RFC3339] [--task-event ID] [--task-integrity SHA256] [--response-contract kizuki.envelope/v1|kizuki.envelope/v2] [--json]",
    summary: "give your agent relevant context, with sources and a token budget",
    schema: {
      options: [
        "--purpose",
        "--budget",
        "--query",
        "--since",
        "--until",
        "--task-event",
        "--task-event-version",
        "--task-integrity",
        "--response-contract",
      ],
      flags: ["--json"],
      defaults: { "--purpose": "session" },
      bounds: {
        "--purpose": "session|recall|correction|audit",
        "--budget": "50..2000",
        "--since": "RFC3339",
        "--until": "RFC3339",
        "--task-event": "identifier",
        "--task-integrity": "sha256",
        "--response-contract": "kizuki.envelope/v1|kizuki.envelope/v2",
      },
    },
  },
  () => import("./context").then((mod) => mod.contextCommand),
);

const hookCommand: Command = lazyCommand(
  {
    name: "hook",
    usage: "hook session-start --harness claude-code|codex|generic [--budget N] [--timeout-ms MS] [--token-ref env:VAR|file:/absolute/path | --owner] [--direct] [--verbose]",
    summary: "inject a bounded Kizuki context block at a harness session start",
    schema: {
      options: ["--harness", "--budget", "--timeout-ms", "--token-ref"],
      flags: ["--owner", "--direct", "--verbose"],
      defaults: { "--budget": "450", "--timeout-ms": "2500" },
      bounds: {
        "--harness": "claude-code|codex|generic",
        "--budget": "50..2000",
        "--timeout-ms": "100..60000",
        "--token-ref": "env:VAR|file:/absolute/path",
      },
    },
  },
  () => import("./hook").then((mod) => mod.hookCommand),
);

const worldCommand: Command = lazyCommand(
  {
    name: "world",
    usage: "world --operation find_concepts [--label TEXT] [--cursor TOKEN] [--prior-view TOKEN] [--json] | world --operation find_situations [--label TEXT] [--cursor TOKEN] [--prior-view TOKEN] [--json] | world --operation concept --ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation situation --ref TOKEN [--card kizuki.situation-card/v2] [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation describe [--json] | world --operation evidence --admission TOKEN --event-version TOKEN --start-utf16 N --end-utf16 N [--json] | world --operation observation --admission TOKEN | --observation TOKEN [--json] | world --operation history --ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--json] | world --operation share --of-operation concept|situation|question|person|procedure|skill|framework|artifact_version --ref TOKEN [--json] | world --operation resume --resume HANDLE [--prior-view TOKEN] [--json] | world --operation question --ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation find_questions [--label TEXT] [--about TOKEN] [--cursor TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--json] | world --operation frontier [--label TEXT] [--about TOKEN] [--cursor TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--json] | world --operation person --ref TOKEN [--prior-view TOKEN] [--share] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation find_people [--label TEXT] [--cursor TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--json] | world --operation procedure --ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation find_procedures [--label TEXT] [--about TOKEN] [--cursor TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--json] | world --operation skill --ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation framework --ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation artifact_version --ref TOKEN [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--prior-view TOKEN] [--share] [--json] | world --operation find_artifacts [--label TEXT] [--cursor TOKEN] [--prior-view TOKEN] [--json] | world --operation outcome --subject SUBJECT [--json] | world --operation diff --of-operation OBJECT_OPERATION --ref TOKEN --prior-view TOKEN [--card CARD_SCHEMA] [--known-at TIME | --snapshot TOKEN] [--valid-at TIME] [--json] | world --operation slice --task TEXT --budget-tokens N [--kinds concept,situation] [--prior-view TOKEN] [--valid-at TIME] [--json] | world --operation attention [--json] | world --operation forecast --ref TOKEN [--known-at TIME] [--json] | world --operation forecast_scores [--known-at TIME] [--json] | world --operation atlas [--panel home|resume|changed|people|questions|commitments|stale|corrections] [--focus-operation KIND --ref TOKEN --baseline-view TOKEN] [--json]",
    summary: "discover and read admitted Concepts and Situations in your current scope",
    schema: {
      options: [
        "--operation",
        "--prior-view",
        "--label",
        "--cursor",
        "--ref",
        "--known-at",
        "--snapshot",
        "--valid-at",
        "--card",
        "--admission",
        "--event-version",
        "--start-utf16",
        "--end-utf16",
        "--observation",
        "--of-operation",
        "--resume",
        "--about",
        "--subject",
        "--task",
        "--budget-tokens",
        "--kinds",
        "--panel",
        "--focus-operation",
        "--baseline-view",
      ],
      flags: ["--json", "--share"],
      bounds: {
        "--label": "up to 200 characters",
        "--cursor": "32-byte base64url token from the previous page",
        "--known-at": "RFC3339 recorded-time cutoff",
        "--snapshot": "32-byte base64url snapshot token",
        "--valid-at": "RFC3339 effective time",
        "--ref": "43 character object token",
        "--card": "kizuki.situation-card/v2 for a situation baseline",
        "--admission": "32-byte base64url admission token",
        "--event-version": "32-byte base64url event-version token",
        "--start-utf16": "nonnegative safe integer",
        "--end-utf16": "safe integer greater than start",
        "--observation": "32-byte base64url observation token",
        "--of-operation": "registered object operation",
        "--resume": "32-byte base64url resume handle",
        "--about": "32-byte base64url object token",
        "--subject": "outcome subject, at most 256 characters",
        "--task": "at most 512 UTF-8 bytes",
        "--budget-tokens": "50 to 2000",
        "--kinds": "1 to 16 distinct kind ids, comma separated",
        "--panel": "home, resume, changed, people, questions, commitments, stale, corrections",
        "--focus-operation": "concept, situation, person, question, procedure, skill, framework, artifact_version",
        "--baseline-view": "43 character retained view token",
        "--operation": "find_concepts|find_situations|concept|situation|describe|evidence|observation|history|share|resume|question|find_questions|frontier|person|find_people|procedure|find_procedures|skill|framework|artifact_version|find_artifacts|outcome|diff|slice|attention|forecast|forecast_scores|atlas",
        "--prior-view": "32-byte base64url view token",
      },
    },
  },
  () => import("./world").then((mod) => mod.worldCommand),
);

const memtCommand: Command = lazyCommand(
  {
    name: "memt",
    usage: "memt <status|recall|experience|sync|snapshot|deploy-check> [options] [--json]",
    summary: "inspect, query, record experiences, sync, and verify snapshots in the MemT-1.0 native memory layer",
    schema: {
      options: [
        "--domain",
        "--scope-key",
        "--partition",
        "--ceiling",
        "--sensitivity",
        "--limit",
        "--condition",
        "--recommendation",
        "--verification",
        "--outcome",
        "--confidence",
        "--min-confidence",
        "--citation",
        "--taint",
        "--out",
        "--name",
        "--url",
        "--model",
      ],
      flags: [
        "--json",
        "--dry-run",
        "--uninternalized",
        "--no-synthesis",
        "--include-canon-summaries",
        "--require-online",
      ],
      defaults: {
        "--ceiling": "private",
        "--sensitivity": "work",
        "--limit": "10",
        "--outcome": "observed",
      },
      bounds: {
        "--ceiling": "public|work|personal|private",
        "--sensitivity": "public|work|personal|private",
        "--limit": "1..100",
        "--outcome": "verified|observed|failed|superseded",
        "--confidence": "0..1",
        "--min-confidence": "0..1",
        "--taint": "clean|stale|purged_invalidated",
        "--model": "memt-nano|memt-flash|memt-pro",
      },
    },
  },
  () => import("./memt").then((mod) => mod.memtCommand),
);

const attentionCommand: Command = lazyCommand(
  {
    name: "attention",
    usage: "attention [--json] | attention dismiss CUE [--json] | attention snooze CUE --until TIME [--json]",
    summary: "read goal-aware cues or dismiss and snooze attention without changing facts",
    schema: {
      options: ["--until"],
      flags: ["--json"],
      bounds: { "--until": "RFC3339 time within the next year" },
    },
  },
  () => import("./attention").then((mod) => mod.attentionCommand),
);

const verifyCommand: Command = lazyCommand(
  {
    name: "verify",
    usage: "verify world --vault /absolute/offline-copy [--json]",
    summary: "audit world state in an offline vault copy without writing to it",
    schema: {
      options: [],
      flags: ["--json"],
    },
  },
  () => import("./verify").then((mod) => mod.verifyCommand),
);

const doctorCommand: Command = lazyCommand(
  {
    name: "doctor",
    usage: "doctor [--json] [--integrity]",
    summary: "verify vault identity, receipts, indexes, rails, and connection health",
    schema: {
      options: [],
      flags: ["--json", "--integrity"],
    },
  },
  () => import("./doctor").then((mod) => mod.doctorCommand),
);

const serveCommand: Command = lazyCommand(
  {
    name: "serve",
    usage: "serve [--once] [--no-http] [--port N] [--json] [--install] [--uninstall] | serve status [--json] | serve health [--json] | serve stop | serve run <rail> [--json] | serve run sync --canon-only [--json] | serve retry-skipped [--json] | serve replay-empty --plan FILE --plan-sha256 SHA256 [--json] | serve backfill-source --plan FILE --plan-sha256 SHA256 [--json]",
    summary: "run the always-on loop, or install it as a user service",
    schema: {
      options: ["--port", "--crash-after", "--plan", "--plan-sha256"],
      flags: ["--once", "--no-http", "--json", "--install", "--uninstall", "--canon-only"],
    },
  },
  () => import("./serve").then((mod) => mod.serveCommand),
);

const purgeCommand: Command = lazyCommand(
  {
    name: "purge",
    usage: "purge (--event ID | --connector ID [--record ID | --subject ID [--source KEY] [--include-aliases]] | --verify RECEIPT [--repair]) [--reason TEXT] [--dry-run] [--confirm] [--allow-empty] [--json] | purge --suppressions [--json] | purge --lift-suppression RECEIPT [--json]",
    summary: "physically delete matching events, hold affected pages, and prove absence",
    schema: {
      options: [
        "--event",
        "--subject",
        "--source",
        "--connector",
        "--record",
        "--reason",
        "--verify",
        "--lift-suppression",
      ],
      flags: [
        "--include-aliases",
        "--json",
        "--dry-run",
        "--confirm",
        "--allow-empty",
        "--suppressions",
        "--repair",
      ],
      irreversible: true,
    },
  },
  () => import("./purge").then((mod) => mod.purgeCommand),
);

const backupCommand: Command = lazyCommand(
  {
    name: "backup",
    usage: "backup --out DIR [--wait SECONDS]",
    summary: "snapshot a live vault into an empty directory that only restore reads",
    schema: {
      options: ["--out", "--wait"],
      flags: [],
    },
  },
  () => import("./backup").then((mod) => mod.backupCommand),
);

const exportCommand: Command = lazyCommand(
  {
    name: "export",
    usage: "export --out DIR",
    summary: "dump vault files and ledger tables into an empty directory",
    schema: {
      options: ["--out"],
      flags: [],
    },
  },
  () => import("./export").then((mod) => mod.exportCommand),
);

const restoreCommand: Command = lazyCommand(
  {
    name: "restore",
    usage: "restore --from DIR [--into DIR] [--verify]",
    summary: "verify an export or snapshot and restore it into an empty directory",
    schema: {
      options: ["--from", "--into"],
      flags: ["--verify"],
    },
  },
  () => import("./restore").then((mod) => mod.restoreCommand),
);

const rebuildCommand: Command = lazyCommand(
  {
    name: "rebuild",
    usage: "rebuild [--layer all|search|graph|world] [--port ID] [--prune-old] [--confirm] [--max-records N] [--max-entries N] [--max-source-bytes N] [--json]",
    summary: "rebuild configured retrieval and the lexical floor, reset derived world tables, or prune inactive retrieval stores",
    schema: {
      options: ["--layer", "--port", "--max-records", "--max-entries", "--max-source-bytes"],
      flags: ["--json", "--prune-old", "--confirm"],
      defaults: {
        "--layer": "all",
        "--max-records": "1000000",
        "--max-entries": "200000",
        "--max-source-bytes": "67108864",
      },
      bounds: {
        "--layer": "all|search|graph|world",
        "--max-records": "N",
        "--max-entries": "N",
        "--max-source-bytes": "N",
      },
    },
  },
  () => import("./rebuild").then((mod) => mod.rebuildCommand),
);

const recoverCommand: Command = lazyCommand(
  {
    name: "recover",
    usage: "recover [--resolve-stale-hold [--dry-run | --apply]] [--json]",
    summary: "resume interrupted memory writes, purges and their retrieval updates",
    schema: {
      options: [],
      flags: ["--json", "--resolve-stale-hold", "--abort-unapplied-hold", "--dry-run", "--apply"],
    },
  },
  () => import("./recover").then((mod) => mod.recoverCommand),
);

const reflexCommand: Command = lazyCommand(
  {
    name: "reflex",
    usage: "reflex --request FILE [--format json|html] [--allow-model]",
    summary: "check plan assumptions against authorized memory; never an execution permit",
    schema: {
      options: ["--request", "--format"],
      flags: ["--allow-model"],
      defaults: { "--format": "json" },
      bounds: {
        "--request": "regular JSON file, at most 16384 bytes",
        "--format": "json|html",
      },
    },
  },
  () => import("./reflex").then((mod) => mod.reflexCommand),
);

const versionCommand: Command = lazyCommand(
  {
    name: "version",
    usage: "version",
    summary: "print the CLI version with its source revision and build time",
    schema: {
      options: [],
      flags: [],
    },
  },
  () => import("./version").then((mod) => mod.versionCommand),
);

const parityCommand: Command = lazyCommand(
  {
    name: "parity",
    usage: "parity run --queries FILE [--k 1..20] [--timeout-ms N] [--min-overlap 0..1] [--json] --estate-cmd [--] ARGV...",
    summary: "compare Kizuki context with an existing memory stack and record only hashed, bounded diffs",
    schema: {
      options: ["--queries", "--k", "--timeout-ms", "--min-overlap", "--estate-cmd"],
      flags: ["--json"],
      defaults: { "--k": "5", "--timeout-ms": "10000", "--min-overlap": "0.5" },
      bounds: {
        "--queries": "FILE, one query per line, at most 200",
        "--k": "1..20",
        "--timeout-ms": "100..120000 per side per query",
        "--min-overlap": "0..1",
        "--estate-cmd": "ARGV..., last option; {query} is replaced, else the query is the last argument",
      },
    },
  },
  () => import("./parity").then((mod) => mod.parityCommand),
);

export const COMMANDS: readonly Command[] = [
  appCommand,
  agentCommand,
  initCommand,
  connectCommand,
  backfillCommand,
  syncCommand,
  importCommand,
  modelsCommand,
  auditCommand,
  tellCommand,
  undoCommand,
  queryCommand,
  contextCommand,
  hookCommand,
  worldCommand,
  memtCommand,
  attentionCommand,
  verifyCommand,
  doctorCommand,
  serveCommand,
  purgeCommand,
  backupCommand,
  exportCommand,
  restoreCommand,
  rebuildCommand,
  recoverCommand,
  reflexCommand,
  versionCommand,
  parityCommand,
];
