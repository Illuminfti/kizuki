# Lane: harness-integration — session hook, MCP registration, agent recipe, parity shadow harness, doctor freshness

Packages: `packages/cli` (NEW `src/invocation.ts`, `src/bounded-process.ts`,
`src/query-input.ts`, `src/parity/{config,receipts,compare,run}.ts`,
`src/commands/hook.ts`, `src/commands/parity.ts`; additive edits to
`src/commands/context.ts`, `src/commands/agent.ts`, `src/commands/doctor.ts`,
`src/commands/index.ts`, `packages/cli/AGENTS.md`, `test/`), NEW
`docs/integrations.md`, one paragraph in `README.md`. Zero runtime
dependencies; `@kizuki/core` is not touched.

Read CONVENTIONS.md first, then `AGENTS.md`, `packages/cli/AGENTS.md`,
`.agents/skills/cli-terminal-ux/SKILL.md`,
`.agents/skills/mcp-tool-design/SKILL.md`,
`.agents/skills/observability-debuggability/SKILL.md`,
`.agents/skills/security-privacy-review/SKILL.md`,
`.agents/skills/documentation-accuracy/SKILL.md`, `docs/architecture.md`
(invariants 5, 6, 7, 8, 9, 10; "Serving — agents as first-class citizens";
"CLI: `context --budget <n>` — bounded context packets for harness hooks
without MCP overhead"), the fuller design in
`workspace/kizuki-plan/ARCHITECTURE.md` §0 invariant 9 (a rail without a
fresh receipt is reported down), §1 (`<vault>/.kizuki/receipts/` JSONL
append logs), §8.1 (agent identity and grants; every agent call audited),
§8.2 (stdio per-harness MCP), §8.3 (the ~450-token brief consumable by any
harness's hook, "fail-closed to empty"), §11 (verb set), §12 (lessons as
tests: receipt-staleness detection). Then read the code you compose:

- `packages/core/src/index.ts` (the only core API you may call) and
  `packages/core/src/agents/` (`OWNER`, `getAgent`, `Agent`, `Principal`).
- `packages/core/src/staging/promote.ts` lines 320–330 and 373–380 — the
  JSONL receipt pattern (`mkdirSync` + `appendFileSync` one line;
  `readReceiptsLog`) this lane mirrors for parity receipts.
- `packages/core/src/export.ts` — `exportVault` skips `.kizuki/` entirely;
  parity receipts and `parity.toml` are operational state and are never
  exported.
- `packages/core/src/agents/audit.ts` — `shapeArguments` hashes free text;
  the parity receipt's default treatment of the query follows it.
- `packages/tui/src/ansi.ts` (`sanitize`, `truncate`) and
  `packages/tui/src/diff.ts` (`diffLines`, `DiffLine`) — reused, not
  re-implemented. `@kizuki/tui` is a workspace dependency of the CLI after
  cli-verbs.
- `packages/cli/src/main.ts` and `test/e2e.test.ts` on main (the pre-alpha
  single file; cli-verbs replaces it) so you recognise what the merged tree
  changed.
- The merged CLI layout from cli-verbs (`args.ts`, `config.ts`,
  `context.ts`, `output.ts`, `commands/index.ts`, `test/helpers.ts`) and
  the verbs and plumbing from cli-wave2 (`commands/context.ts`,
  `commands/agent.ts`, `commands/mcp.ts`, `commands/doctor.ts`,
  `derived.ts` → `ensureDerived`, the `Context` shape of its §1.1).
- `packages/core/src/serving/` from serving-mcp (`serveContextPacket`,
  `ServeContext`, `Envelope`, `ContextPacketData`, `Denied`, `ServeError`).

Reconciled against `main` at `76930db` (2026-09-02; `bun test` = 515 pass /
41 files; bun 1.3.14 locally, CI pins 1.3.10). Nothing from cli-verbs,
serving-mcp or cli-wave2 is on main yet; every symbol from them is marked
NEW below with its lane and intended location. Verify each on the branch
you start from before composing.

Depends on: **cli-verbs** (command modules, `parseArguments`, config and
vault resolution, `doctor`, `test/helpers.ts`), **serving-mcp**
(`serveContextPacket` and the envelope), **cli-wave2** (`context`, `agent`,
`mcp` verbs, `ensureDerived`, the `Context` shape, doctor additions). All
three must be merged before this lane starts.

## Already on main (compose; do not rebuild)

- `OWNER` principal, `getAgent(db, name)`, `Agent.revoked_at`; `ulid()`;
  `isRfc3339`.
- `.kizuki/receipts/` as the receipt directory (`RECEIPTS_PATH =
".kizuki/receipts/promotions.jsonl"`), created lazily with `mkdirSync
{ recursive: true }`; one JSON object per line appended with
  `appendFileSync`.
- `initVault` writes `.kizuki/.gitignore` = `*\n!.gitignore\n`, so
  everything this lane writes under `.kizuki/` is ignored by Git.
- `sanitize` (drops every control character except newline, strips
  CSI/OSC), `truncate`, `diffLines` in `@kizuki/tui`.
- `scripts/verify-network.ts` scans every tracked `packages/**/*.ts`;
  `Bun.spawn`/`Bun.which`/`Bun.CryptoHasher`/`Bun.stdin` are not network
  surface. `bun run verify` enforces the identifier denylist on tracked text
  and reachable commit messages; this spec and its commits name no product,
  person, host or upstream.
- `packages/core/test/staging/invariants.test.ts` scans every
  `packages/*/src`: nothing in this lane may be named `promote(` or carry
  `invokedBy`.

Verified 2026-09-02 on bun 1.3.14 (record in the commit body when the
implementation relies on them):

- Run from source, `Bun.main` is the absolute path of the entry file and
  `process.execPath` is the bun binary. In a `bun build --compile`
  executable, `Bun.main` is `/$bunfs/root/<outfile name>` and
  `process.execPath` is the executable's absolute path.
- `Bun.spawn([..], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env })`
  delivers written stdin bytes and the given env to `/bin/sh -c CMD`; a
  child killed with `proc.kill("SIGKILL")` reports `exitCode 137`,
  `signalCode "SIGKILL"`, `killed true`.

## Changed from the brief (decisions this spec makes)

- The session hook is its own verb, `kizuki hook`, rather than an alias of
  `context`: it has a different contract (query from stdin or a JSON field,
  a wall-clock bound, and it never exits non-zero after argument parsing).
  It composes `context` by spawning it — a synchronous SQLite engine cannot
  be interrupted by a timer in the same thread, so bounding it honestly
  means bounding a process.
- `context` gains one additive flag, `--query-stdin`, so neither the hook
  nor a shell pipeline has to put the owner's prompt on `argv` (visible in
  `/proc/<pid>/cmdline` to every user on a shared machine).
- The parity harness compares against the **owner-configured** previous
  system only. Kizuki never suggests, templates or discovers a command;
  the query reaches the command on stdin and in `KIZUKI_PARITY_QUERY`,
  never by substitution into the command string.
- Parity receipts hash the query and store no output text by default (the
  `agent_audit` precedent); `keep_text = true` opts a vault into storing the
  query and a bounded diff excerpt.
- `doctor` treats a configured shadow period without a fresh receipt as a
  failure (invariant 9). The owner declares the period with `parity set`
  and ends it with `parity unset`; silence in between is reported down.

## Objective

A stranger with any agent harness can, without reading source: inject a
bounded Kizuki brief into a session through a shell hook that can neither
hang nor fail the session; register the stdio MCP server in any generic MCP
client from a copy-paste snippet whose paths are right; mint a scoped agent
identity from a recipe; run a shadow period in which the same questions go
to Kizuki and to the system it replaces, with append-only receipts that
show drift over time; and see in `kizuki doctor` whether that shadow period
is alive. Every documented command runs; no harness, vendor, person or host
is named anywhere.

## 1. Shared plumbing (all NEW, `packages/cli/src/`)

### 1.1 `invocation.ts` — how to run this same kizuki again

```ts
export interface Invocation {
  command: string; // absolute path of the executable to spawn
  args: string[]; // arguments that precede the verb ([] for a compiled binary)
  compiled: boolean;
}
export const COMPILED_MAIN_PREFIX = "/$bunfs/" as const;
export function invocationOf(
  main: string = Bun.main,
  execPath: string = process.execPath,
): Invocation;
// main.startsWith(COMPILED_MAIN_PREFIX) → { command: execPath, args: [], compiled: true }
// otherwise                               → { command: execPath, args: [main], compiled: false }
```

Pure; used by `hook` (self-spawn, §2) and `agent snippet` (§4). Windows is a
non-goal (ci-hardening ships no Windows target); do not add a second prefix
you cannot verify.

### 1.2 `bounded-process.ts` — one way to run a child with limits

```ts
export interface BoundedRunOptions {
  stdin: Uint8Array | null; // null → stdin "ignore"
  env: Record<string, string | undefined>;
  cwd: string;
  timeoutMs: number; // wall clock from spawn; SIGKILL on expiry
  maxStdoutBytes: number; // bytes kept; the stream is drained past the cap and discarded
  maxStderrBytes?: number; // default 4096; kept text is sanitize()d
}
export interface BoundedRunResult {
  stdout: Uint8Array; // ≤ maxStdoutBytes
  stderr: string; // sanitized, ≤ maxStderrBytes code points
  exit_code: number | null; // null when killed by a signal
  signal: string | null;
  timed_out: boolean;
  truncated: boolean; // stdout exceeded maxStdoutBytes
  duration_ms: number;
}
export async function runBounded(
  argv: string[],
  opts: BoundedRunOptions,
): Promise<BoundedRunResult>;
```

Rules: `Bun.spawn(argv, { stdin, stdout: "pipe", stderr: "pipe", env, cwd })`
(an argv array, never a shell string — the shell, when wanted, is an
explicit argv element, §5.4); write the whole stdin then end it, ignoring
`EPIPE` (a child that exits before reading is not an error of ours); drain
stdout and stderr concurrently and keep draining after either cap so the
child never blocks on a full pipe; the timeout is our own `setTimeout` that
sets `timed_out = true` and calls `proc.kill("SIGKILL")`, cleared in
`finally` (do not rely on Bun's `timeout` option: it cannot tell us whether
the kill was ours). `duration_ms` is measured with `performance.now()`.
Nothing is logged; the caller decides what to show.

### 1.3 `query-input.ts` — bounded, sanitized query intake

```ts
export const MAX_QUERY_STDIN_BYTES = 65_536 as const;
export const MAX_QUERY_CHARS = 512 as const; // serving-mcp §1.5: `query` ≤ 512 chars
export async function readStdinBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; overflow: boolean }>;
// reads until EOF or maxBytes; on overflow stops reading, cancels the reader, returns what was read with overflow: true
export function cleanQuery(text: string): string | null;
// sanitize (@kizuki/tui) → whitespace collapsed to single spaces → trim → Array.from(...).slice(0, MAX_QUERY_CHARS).join("") → null when empty
export function queryFromJson(
  text: string,
  field: string,
): { query: string | null; problem: string | null };
// field: /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, ≤ 8 segments (else TypeError);
// JSON.parse failure → { null, "stdin is not JSON" }; path walks plain objects only; a missing or
// non-string leaf → { null, "field <f> is not a string" }; a string leaf → cleanQuery
```

Decoding is `new TextDecoder("utf-8")` (non-fatal: a harness that pipes a
stray byte still gets a brief). Both `hook` and `context --query-stdin` use
this module; neither reads more than `MAX_QUERY_STDIN_BYTES`.

## 2. `kizuki hook` — the session hook (`commands/hook.ts`, NEW)

```
kizuki hook [--budget N] [--query Q | --query-stdin | --query-json FIELD]
            [--subject S]... [--include canon,graph,timeline]
            [--timeout-ms N] [--max-bytes N]
```

Contract: after argument parsing succeeds, `hook` exits 0 in every case.
Fail closed on data (nothing is served that `context` would not serve),
fail open on the session (an empty brief and one stderr line, never a
non-zero exit, never a hang). A hook's non-zero exit or a stall is what
breaks a harness session; a missing brief is not.

- Arguments: at most one of `--query`, `--query-stdin`, `--query-json`
  (else usage, exit 2). `--budget` integer 50..2000, default 450 (the
  serving bounds; a value outside them would be `invalid_arguments` at
  serve time, so it is refused here where the owner sees it on the first
  run). `--include` a non-empty comma list ⊆ `canon,graph,timeline`.
  `--subject` values must match `/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/`
  (serving-mcp's `ID`), ≤ 16 of them. `--timeout-ms` integer 100..60000,
  default 5000. `--max-bytes` integer 1024..1048576, default 65536. Any
  violation → usage on stderr, exit 2. `--query-stdin`/`--query-json` when
  `stdin.isTTY` → usage, exit 2 (`hook reads a piped query; it is not
interactive`).
- Query: `--query Q` → `cleanQuery(Q)`; `--query-stdin` →
  `readStdinBounded(Bun.stdin.stream(), MAX_QUERY_STDIN_BYTES)` then
  `cleanQuery` (overflow is fine: the first 64 KiB are enough for 512
  chars); `--query-json FIELD` → `queryFromJson` (overflow means the
  document is incomplete → no query, note `hook: stdin exceeded 65536
bytes; no query`). A `problem` from `queryFromJson` is one stderr line
  `hook: <problem>; no query`. Without a query source, no query.
- Vault: resolve exactly as every verb does (cli-verbs §2 `resolveVault` →
  `assertVault`, NEW) but inside `try`; a throw → stderr `hook: <message>;
empty context`, exit 0, nothing on stdout. The database is not opened by
  the hook process.
- Child: `inv = invocationOf()`; argv = `[inv.command, ...inv.args,
"context", "--vault", vaultPath, "--budget", String(budget),
...subjects.flatMap(s => ["--subject", s]), ...(include ? ["--include",
include] : []), ...(query !== null ? ["--query-stdin"] : [])]`;
  `runBounded(argv, { stdin: query === null ? null : utf8(query), env:
process.env, cwd: process.cwd(), timeoutMs, maxStdoutBytes: maxBytes })`.
  The query travels on the child's stdin only; `--query` is never placed
  on the child's argv.
- Result: `exit_code === 0 && !timed_out` → write `stdout` bytes as-is
  (already `packet_md`, produced by the serving engine; when `truncated`,
  append `\n… (context truncated at <max-bytes> bytes)\n` so the harness
  sees the cut). Otherwise stdout stays empty and stderr gets one line:
  `hook: context timed out after <n> ms; empty context (hint: kizuki
rebuild builds derived layers ahead of time)` or `hook: context failed
(exit <code>); empty context`. In every case the child's `stderr`
  (already sanitized and capped by `runBounded`) is forwarded to stderr
  line by line prefixed `hook: ` — cli-wave2's `derived layers built
(first run)` note and `denied=` footer arrive this way. An `EPIPE` on our
  own stdout is ignored (the harness closed early). Exit 0.
- Nothing is written to disk by the hook itself; the child's
  `context_packet` call is audited by the gate under `owner`
  (`kizuki agent audit owner` lists hook calls).

### 2.1 `context --query-stdin` (additive edit to cli-wave2's `commands/context.ts`, NEW)

`--query-stdin` (flag) is mutually exclusive with `--query` (usage, exit 2)
and refused when `stdin.isTTY` (usage, exit 2). It reads with
`readStdinBounded` + `cleanQuery`; an empty result means no query. Nothing
else about `context` changes: `--json` still prints the envelope, the
human form still prints `packet_md` only, configuration errors still exit

1. Document the flag in the verb's usage line.

## 3. Registration snippets — `kizuki agent snippet` (additive subverb in cli-wave2's `commands/agent.ts`, NEW)

```
kizuki agent snippet <name> --token-env VAR [--command PATH] [--json]
kizuki agent snippet --owner [--command PATH] [--json]
```

- `<name>` and `--owner` are mutually exclusive; exactly one is required
  (usage, exit 2). `--token-env` is required with `<name>`, refused with
  `--owner`, and must match `/^[A-Z_][A-Z0-9_]*$/` (usage, exit 2).
  `getAgent(db, name)` null → `error: agent <name> does not exist`, exit 1;
  `revoked_at !== null` → `error: agent <name> is revoked`, exit 1.
- The snippet, as most generic stdio MCP clients read it (an `mcpServers`
  map; the key is always `kizuki`):

```json
{
  "mcpServers": {
    "kizuki": {
      "command": "/abs/path/to/kizuki",
      "args": [
        "mcp",
        "--agent",
        "ada",
        "--token",
        "env:KIZUKI_TOKEN_ADA",
        "--vault",
        "/abs/vault"
      ],
      "env": { "KIZUKI_TOKEN_ADA": "" }
    }
  }
}
```

`command`/leading `args` come from `invocationOf()` (`--command PATH`
replaces `command` and empties the leading args, for an installed binary
at another path); run from source the snippet is `"command": "<bun>",
"args": ["<abs main.ts>", "mcp", ...]`. `--vault` is always explicit and
absolute: an MCP client launches the server from an unknown working
directory with its own environment, and config-file resolution would pick a
vault silently. `--owner` → `args: ["mcp", "--owner", "--vault", ...]` and
no `env` key. The token value never appears: `env` carries the variable
name with an empty value (an empty value fails closed in `mcp`:
cli-wave2 §6 rejects it before any server starts).

- Human form: the object pretty-printed (two-space indent, trailing
  newline) on stdout, plus one stderr line for the agent form: `fill
KIZUKI_TOKEN_ADA with the token printed by: kizuki agent add ada (or:
kizuki agent rotate ada)`. `--json`: the same object on one line, no note.
  Asserted: stdout never contains `kzk_`.

## 4. Parity shadow harness (`src/parity/`, NEW; `commands/parity.ts`, NEW)

The owner keeps the previous system running for a while and asks both the
same questions. Kizuki's side is the same packet the hook produces; the
previous side is whatever command the owner configures. Each question
leaves one append-only receipt; `parity log` renders them; `doctor` reports
whether receipts are still arriving.

### 4.1 Configuration — `<vault>/.kizuki/parity.toml` (`parity/config.ts`)

Per vault, under `.kizuki/` (gitignored by `initVault`), mode 0600, written
atomically (`parity.toml.tmp` 0600 → `renameSync`). Flat keys only, parsed
with `Bun.TOML.parse` (present on the pinned Bun 1.3.x; cli-verbs relies on
it too), serialized by a short writer (`key = <JSON.stringify(string)> |
true | false | <integer or decimal>`, keys in the order below). Not in the
global `config.toml` (cli-verbs refuses unknown keys there; the shadow
period is per vault).

```toml
command = "old-brain ask \"$KIZUKI_PARITY_QUERY\""   # required; run as /bin/sh -c; the query is on stdin and in KIZUKI_PARITY_QUERY
max_age_hours = 24          # doctor reports the period down when the newest receipt for this command is older; 1..720
budget = 450                # Kizuki packet budget in tokens; 50..2000
include = "canon,graph,timeline"   # packet sections, comma list, non-empty subset
timeout_ms = 60000          # per command run; 1000..600000
max_output_bytes = 1048576  # command stdout kept for comparison; 4096..16777216
match_threshold = 0.5       # word_jaccard at or above this is a "match"; 0..1
keep_text = false           # store the query text and a bounded diff excerpt in receipts
```

```ts
export const PARITY_CONFIG_PATH = ".kizuki/parity.toml" as const;
export const PACKET_SECTIONS = ["canon", "graph", "timeline"] as const;
export type PacketSection = (typeof PACKET_SECTIONS)[number];
export interface ParityConfig {
  command: string; // 1..4096 chars, no U+0000
  max_age_hours: number;
  budget: number;
  include: PacketSection[]; // in PACKET_SECTIONS order, deduplicated
  timeout_ms: number;
  max_output_bytes: number;
  match_threshold: number;
  keep_text: boolean;
}
export const PARITY_CONFIG_DEFAULTS: Omit<ParityConfig, "command">;
export type ParityErrorCode =
  | "malformed_config"
  | "unknown_key"
  | "bad_value"
  | "unconfigured"
  | "no_shell"
  | "bad_queries"
  | "malformed_receipt";
export class ParityError extends Error {
  override name = "ParityError";
  readonly code: ParityErrorCode;
  constructor(code: ParityErrorCode, message: string);
}
export function parseParityConfig(text: string): ParityConfig; // the single validation path
export function serializeParityConfig(config: ParityConfig): string; // parse(serialize(c)) deep-equals c
export function readParityConfig(vaultPath: string): ParityConfig | null; // null = file absent = unconfigured
export function writeParityConfig(
  vaultPath: string,
  config: ParityConfig,
): string; // returns the absolute path
export function removeParityConfig(vaultPath: string): boolean; // true when a file was removed
export function commandFingerprint(command: string): string; // sha256 hex of the UTF-8 command
export function shortFingerprint(sha256: string): string; // first 12 hex chars; what doctor and log print
```

Validation: `malformed_config` on TOML parse failure; `unknown_key` for any
key outside the eight above or any `[table]` (honest over lossy: never
rewrite a file you do not fully understand); `bad_value` for a wrong type,
a value outside its range, an `include` entry outside `PACKET_SECTIONS`, or
an empty `command`. Messages name the key, never the command's content.
The command may carry a token the owner chose to put there: it lives in
the 0600 file, `parity show` prints it (sanitized) because the owner wrote
it, and nothing else ever prints it — receipts, `log` and `doctor` carry
only the fingerprint.

### 4.2 Receipts — `<vault>/.kizuki/receipts/parity.jsonl` (`parity/receipts.ts`)

```ts
export const PARITY_RECEIPTS_PATH = ".kizuki/receipts/parity.jsonl" as const;
export const PARITY_RECEIPT_SCHEMA = "kizuki.parity-receipt/v1" as const;
export type ParityVerdict =
  | "match" // word_jaccard ≥ match_threshold
  | "drift" // both sides produced text; overlap below the threshold
  | "previous_failed" // the command exited non-zero or timed out; no comparison
  | "kizuki_empty" // Kizuki packed nothing while the previous system answered
  | "both_empty"; // neither side produced text
export interface ParitySide {
  sha256: string; // of the raw bytes
  bytes: number;
  lines: number; // after normalizeForCompare
}
export interface ParityDiff {
  same: number;
  added: number; // lines only in the previous system's output
  removed: number; // lines only in Kizuki's output
  line_similarity: number; // 2*same/(kizuki.lines+previous.lines); 1 when both are empty
  word_jaccard: number; // |A∩B|/|A∪B| over lowercased /[\p{L}\p{N}]{3,}/u tokens; 1 when both empty
  excerpt?: string[]; // keep_text only; "+ <line>" / "- <line>" bounded by diffExcerpt
}
export interface ParityReceipt {
  schema: typeof PARITY_RECEIPT_SCHEMA;
  receipt_id: string; // ULID
  at: string; // RFC3339
  query: { sha256: string; len: number; text?: string }; // text only with keep_text
  budget_tokens: number;
  include: PacketSection[];
  command_sha256: string; // commandFingerprint of the command that ran
  kizuki: ParitySide & {
    tokens_estimate: number;
    sections: { canon: number; graph: number; timeline: number };
    denied: { reason: string; count: number }[]; // the envelope's Denied[] (counts only, never ids)
    duration_ms: number;
  };
  previous: ParitySide & {
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    truncated: boolean;
    duration_ms: number;
  };
  diff: ParityDiff;
  verdict: ParityVerdict;
}
export function appendParityReceipt(
  vaultPath: string,
  receipt: ParityReceipt,
): void;
// mkdirSync(dirname, { recursive: true }); appendFileSync(path, JSON.stringify(receipt) + "\n", { mode: 0o600 })
export function readParityReceipts(vaultPath: string): ParityReceipt[];
// [] when absent; oldest first; a line that is not a JSON object with schema === PARITY_RECEIPT_SCHEMA
// → ParityError("malformed_receipt", `line <n>`) (the line's content is never included in the message)
export interface ParityFreshness {
  configured: boolean;
  command_sha256: string | null;
  runs: number; // receipts whose command_sha256 equals the configured fingerprint
  drift: number; // of those, verdict === "drift"
  failed: number; // of those, verdict === "previous_failed"
  last_run: string | null; // newest `at` among those
  age_hours: number | null; // (now − last_run) in hours, one decimal
  max_age_hours: number | null;
  stale: boolean; // configured && (last_run === null || age_hours > max_age_hours)
}
export function parityFreshness(
  vaultPath: string,
  config: ParityConfig | null,
  now?: string,
): ParityFreshness;
```

Receipts are append-only; `parity unset` leaves them in place (history of
a finished shadow period). Counting is per command fingerprint so an
ad-hoc `run --command` never makes a configured period look alive.

### 4.3 Comparison — `parity/compare.ts` (pure)

```ts
export const PACKET_HEADER =
  /^# kizuki context \(principal: [^)]*, at: [^)]*\)$/;
export function normalizeForCompare(text: string): string[];
// sanitize (@kizuki/tui) → "\r\n" → "\n" → split → trimEnd each line → drop lines matching PACKET_HEADER
// (the only volatile line of a packet; applied to both sides so a previous system that is itself
// `kizuki context` compares equal) → collapse runs of blank lines to one → drop leading/trailing blanks
export function compareOutputs(
  kizuki: string,
  previous: string,
): Omit<ParityDiff, "excerpt"> & { lines: DiffLine[] };
// diffLines(kizukiLines.join("\n"), previousLines.join("\n")) from @kizuki/tui; counts by op
export function wordSet(lines: string[]): Set<string>; // lowercased tokens matching /[\p{L}\p{N}]{3,}/gu
export function verdictOf(
  kizukiLines: number,
  previous: { exit_code: number | null; timed_out: boolean },
  previousLines: number,
  wordJaccard: number,
  threshold: number,
): ParityVerdict;
// previous.timed_out || previous.exit_code !== 0 → "previous_failed"; both line counts 0 → "both_empty";
// kizukiLines === 0 → "kizuki_empty"; wordJaccard ≥ threshold → "match"; else "drift"
export function diffExcerpt(
  lines: DiffLine[],
  maxLines = 200,
  maxBytes = 16_384,
): string[];
// "+ " / "- " entries only (no "same"), in order; stops at either cap and appends "… <n> more lines"
```

`diffLines` already degrades to del-all/add-all above its LCS budget, so a
multi-megabyte previous output cannot stall a run.

### 4.4 Running one comparison — `parity/run.ts`

```ts
export interface ParityRunInput {
  db: Database; // ledger + staging + search + graph + agents initialized (openVaultDb from cli-verbs)
  vaultPath: string;
  config: ParityConfig;
  query: string; // already cleanQuery()'d, 1..512 chars
  env: Record<string, string | undefined>;
  cwd: string;
  shell?: string; // default Bun.which("sh"); null → ParityError("no_shell")
  now?: () => string; // default () => new Date().toISOString()
}
export interface ParityRunOutcome {
  receipt: ParityReceipt;
  previous_stderr: string; // sanitized, ≤ 4096 chars; shown by the CLI on previous_failed, never stored
}
export async function runParity(
  input: ParityRunInput,
): Promise<ParityRunOutcome>;
```

1. Kizuki side: `serveContextPacket({ db, vaultPath, principal: OWNER },
{ query, budget_tokens: config.budget, include: config.include })` (NEW,
   serving-mcp §1.5) — the exact call `kizuki context` makes, audited under
   `owner` like any owner read. `data.packet_md` is the text; `sections`,
   `tokens_estimate` and the envelope's `denied` go into the receipt. A
   `ServeError` (the gate refusing before serving; cannot happen for the
   owner with a bounded query, but the type says it can) → text `""`,
   `denied: [{ reason: error.code, count: 1 }]`, `sections` zeros. Any
   other throw propagates (a bug, not a parity outcome).
2. Previous side: `runBounded([shell, "-c", config.command], { stdin:
utf8(query + "\n"), env: { ...env, KIZUKI_PARITY_QUERY: query,
KIZUKI_PARITY_BUDGET: String(config.budget) }, cwd, timeoutMs:
config.timeout_ms, maxStdoutBytes: config.max_output_bytes })`. The
   command string is passed to the shell verbatim; the query is never
   interpolated into it. The previous system's output is attacker-controlled
   in the same sense captured text is (it likely quotes captured data):
   it is hashed, counted and diffed, `sanitize`d before any terminal, and
   stored only as a bounded excerpt when `keep_text` is on.
3. `normalizeForCompare` both sides → `compareOutputs` → `wordSet` jaccard
   → `verdictOf` → receipt (`query.sha256` = sha256 of the UTF-8 query via
   `Bun.CryptoHasher`; `query.text` and `diff.excerpt` only when
   `config.keep_text`) → `appendParityReceipt` → return.

### 4.5 Verbs

```
kizuki parity set --command CMD [--max-age-hours N] [--budget N] [--include a,b]
                  [--timeout-ms N] [--max-output-bytes N] [--match-threshold F]
                  [--keep-text | --no-keep-text]
kizuki parity show [--json]
kizuki parity unset
kizuki parity run (--query Q | --queries PATH | --query-stdin)
                  [--command CMD] [--timeout-ms N] [--budget N] [--json]
kizuki parity log [--limit N] [--json]
```

- `set`: start from the existing config (or `PARITY_CONFIG_DEFAULTS`),
  overlay the flags, validate through `parseParityConfig(serialize(...))`
  (one validation path), write. `--command` is required only when no
  config exists yet. Prints `command: <sanitize(command)>` then `parity
command=<short fingerprint> max_age_hours=<n> budget=<n>
include=<a,b,c> timeout_ms=<n> max_output_bytes=<n> match_threshold=<f>
keep_text=<bool>`. When the resulting fingerprint has no receipt yet, one
  stderr note: `note: no receipt for this command yet; doctor reports the
shadow period down until: kizuki parity run --queries PATH`. Flag
  values that fail validation surface as `error: parity bad_value: <key>
...`, exit 1 (like the llm-producer lane's `LlmError` convention); a
  malformed flag syntax (non-integer where an integer is required) goes
  through the same validator and message.
- `show`: `readParityConfig` null → `parity unconfigured` exit 0; else the
  two lines of `set`; `--json` → `{ ...config, command_sha256 }` on one
  line (the command itself included: the owner wrote it and is reading it
  on their own terminal).
- `unset`: `removeParityConfig`; prints `parity unconfigured` whether or not
  a file existed. Receipts stay.
- `run`: queries from exactly one source (else usage, exit 2). `--queries
PATH`: UTF-8 file, one query per line, `#` comments and blank lines
  ignored, ≤ 200 queries (else `bad_queries`), each `cleanQuery`'d (an
  empty result after cleaning is `bad_queries` naming the line number).
  `--query-stdin`: the same line grammar from stdin (refused when
  `stdin.isTTY`, exit 2). Config: `readParityConfig` overlaid with
  `--command`/`--timeout-ms`/`--budget` when given; no config and no
  `--command` → `error: parity unconfigured: run kizuki parity set
--command CMD` exit 1. Then `ensureDerived(ctx)` once (NEW, cli-wave2
  §1.2), then `runParity` per query in order. Per query one stdout line:
  `<receipt_id> verdict=<v> jaccard=<0.00> lines=+<added>/-<removed>
kizuki=<bytes>B previous=<bytes>B exit=<code|killed> <duration_ms>ms`
  (`--json`: the receipt on one line instead). On `previous_failed`, stderr
  gets `previous system stderr: <first 400 chars>` when non-empty. Summary
  on stderr: `parity runs=<n> match=<m> drift=<d> previous_failed=<f>
empty=<e>`. Exit 1 when any verdict is `previous_failed` (the comparison
  could not be made; the owner must fix the command) or on `no_shell`;
  drift is a finding, not a failure — exit 0.
- `log`: `readParityReceipts`, newest first, `--limit` integer 1..1000
  default 20 (else usage, exit 2). Lines: `<at> <receipt_id> <verdict>
jaccard=<0.00> sim=<0.00> +<added>/-<removed> cmd=<short fingerprint>`.
  `--json`: receipts verbatim, one per line (with `query.text` and
  `diff.excerpt` when they were stored). A `malformed_receipt` → `error:
parity malformed_receipt: line <n>` exit 1.

### 4.6 `doctor` (additive edit to cli-wave2's `commands/doctor.ts`, NEW)

One line placed after cli-wave2's `connection_state_pending=` line:

- unconfigured: `parity unconfigured`
- configured: `parity command=<short fingerprint> last_run=<ts|never>
age_hours=<n|-> runs=<n> drift=<n> max_age_hours=<n> stale=<true|false>`
- a `ParityError` from `readParityConfig` or `readParityReceipts`: `parity
problem: <code>` — counts as a problem, exit 1.

When `stale` is true, also one line among the `problem` lines and exit 1
(invariant 9; ARCHITECTURE.md §12 "receipt-staleness detection"):
`problem parity: no receipt for the configured command; run: kizuki parity
run --queries PATH` when `last_run` is null, else `problem parity: newest
receipt is <age_hours>h old (max <max_age_hours>h); run: kizuki parity
run --queries PATH`. `--json` gains `parity: null | { command_sha256,
last_run, age_hours, runs, drift, failed, max_age_hours, stale }` and a
stale period sets `ok: false`. The command text never appears in doctor
output. Nothing here changes when `parity.toml` is absent, so
ci-hardening's quickstart (`doctor` exit 0 on a fresh vault) is unaffected.

## 5. Registry, AGENTS.md, README

- `commands/index.ts`: `hook` registered directly after `context`; `parity`
  directly after `mcp`. `help` derives from the registry (cli-verbs), so
  both appear without a hand-written list.
- `packages/cli/AGENTS.md`, under "Rules", two bullets: "The parity
  command is owner-configured. Never template, suggest or discover it; the
  query reaches it on stdin and in the environment only." and "`hook` may
  not exit non-zero or block after its arguments parse; a missing brief is
  the correct failure mode for a session hook."
- `README.md`, inside "Try it": one paragraph "Connecting a harness" — the
  hook one-liner (`kizuki hook --budget 450 --query-stdin`), the snippet
  verb (`kizuki agent snippet ada --token-env KIZUKI_TOKEN_ADA`), the
  parity trio (`parity set`, `parity run --queries`, `parity log`), and a
  link to `docs/integrations.md`. Claim nothing else; no product names.

## 6. `docs/integrations.md` (NEW)

Written for a stranger who has just run the README loop. Sections, in this
order, each with copy-pasteable fences and no names of harnesses, vendors,
people or hosts:

1. **What a harness sees.** The envelope split: `canon` (owner-reviewed
   prose) versus `quoted` (captured text, `tainted: true`, to be treated as
   data and never as instructions); provenance markers `[page:<id>]` and
   `(ev:<event_id> ...)` in packets; the sensitivity lattice with an
   explicit bottom (unlabeled is never served, the owner included); every
   call audited (`kizuki agent audit <name>`, `kizuki agent audit owner`).
2. **Session hook.** A shell hook:

```sh
#!/bin/sh
# Print a bounded brief for the session. Never blocks, never fails the session.
exec kizuki hook --budget 450 --query-stdin
```

the JSON-payload variant (`--query-json prompt`), `--subject` for a
person-centred brief, `--timeout-ms`, what the stderr lines mean, and
the two honest limitations: the canon section matches pages containing
every query term (`toFtsQuery` on main joins terms; keep hook queries to
a few keywords or a subject), and the first call on a fresh vault builds
derived layers (`kizuki rebuild` ahead of time avoids a timeout). State
that `kizuki context` is the same packet with strict exit codes for
scripts. 3. **MCP over stdio.** `kizuki agent snippet ...` output explained key by
key; the equivalent command line `kizuki mcp --agent ada --token
env:KIZUKI_TOKEN_ADA --vault /abs/vault`; the owner form `--owner`; the
eight tool names in `TOOLS` order and that `propose` is the only write;
why the token is an environment reference (argv is visible to other
processes); that the standing loopback endpoint under `kizuki serve` is
not built. 4. **Recipe: one agent per harness.** `kizuki agent add ada --ceiling
personal --tools search,get_page,context_packet,propose` → export the
token → `kizuki agent snippet ada --token-env KIZUKI_TOKEN_ADA` → paste
→ `kizuki agent audit ada` after the first session; `kizuki agent grant`
to narrow, `kizuki agent rotate`/`revoke` to end. Grant fields in one
table (ceiling, types, subjects, since/until, tools, rate), with the note
from serving-mcp that a `types`-scoped grant restricts ledger events by
kind and a time-bounded grant sees no canon (recorded there as an open
question). 5. **Shadow period with the previous system.** `parity set --command
'old-brain ask "$KIZUKI_PARITY_QUERY"' --max-age-hours 24` (a synthetic
command name; the doc says so), a queries file, `parity run --queries`,
reading `parity log`, the verdict table (§4.2), what is and is not stored
by default and how `--keep-text` changes it, and that `doctor` reports
the period down when receipts stop — end it with `parity unset`. 6. **Deferred.** A standing HTTP endpoint, harness-specific adapters,
scheduled parity runs (the daemon lane reads `parity.toml` and calls the
same `runParity`), semantic similarity in parity (lexical overlap only).

A test (§7 `docs.test.ts`) keeps every `kizuki <verb> [<subverb>]` in the
document's code fences pointing at a registered verb and, for `agent` and
`parity`, a documented subverb — invariant 10 for documentation.

## 7. Tests (`packages/cli/test/`)

Extend cli-verbs' `helpers.ts` with `runCli(env, args, { stdin?: string })`
(`Bun.spawnSync` with `stdin: Buffer` when given). Every test uses a
`mkdtempSync` vault and a temp `KIZUKI_CONFIG`; nothing reads outside the
worktree except `/bin/sh`, `cat`, `sleep`, `head`, `yes` (POSIX tools
present on both CI runners).

- `invocation.test.ts`: from source → `{ command: process.execPath, args:
[Bun.main], compiled: false }`; `invocationOf("/$bunfs/root/kizuki",
"/opt/kizuki")` → `{ command: "/opt/kizuki", args: [], compiled: true }`;
  one real compile: write a probe that imports `src/invocation.ts` by
  absolute path and prints `JSON.stringify(invocationOf())`, `bun build
--compile` it into a temp dir with `Bun.spawnSync`, run it, assert
  `compiled: true` and `command` equals the probe binary path; temp dir
  removed after.
- `bounded-process.test.ts`: `sh -c 'cat'` echoes stdin; `sh -c 'exit 3'`
  → `exit_code 3`; `sh -c 'sleep 5'` with `timeoutMs: 300` → `timed_out
true`, `signal "SIGKILL"`, `duration_ms < 2000`; `sh -c 'yes | head -c
300000'` with `maxStdoutBytes: 1024` → `stdout.length === 1024`,
  `truncated true`, exit 0 (the child was fully drained); stderr containing
  `\x1b[2J` comes back stripped and capped at `maxStderrBytes`; a child
  that closes stdin immediately (`sh -c 'exec 0<&-; exit 0'`) does not
  throw.
- `query-input.test.ts`: `cleanQuery` strips control sequences, collapses
  whitespace, caps at 512 code points without splitting a surrogate pair,
  returns null for whitespace; `readStdinBounded` stops at the cap with
  `overflow: true`; `queryFromJson` on `{"a":{"b":"kettle"}}` with `a.b`,
  non-string leaf, missing key, invalid JSON, a field with 9 segments
  (TypeError), and a path that would walk into an array (no query).
- `hook.test.ts` (subprocess seam): init → import → promote (personal) →
  `hook --query-stdin` with stdin `kettle` prints a packet whose first line
  matches `PACKET_HEADER` and contains `[page:`; `--query-json prompt` with
  `{"prompt":"kettle"}` does the same; `--query kettle` does the same and
  the child's argv never carried the query (assert by pointing
  `--query` at a phrase and checking `/proc/self` is not needed: spawn
  `hook` with `--query` and a fake `context`? No — assert structurally:
  `hook.ts` builds argv through one function `childArgv(...)` exported for
  the test, and the test asserts the returned array never contains the
  query and contains `--query-stdin`); no query source → a packet with the
  header only or timeline lines, exit 0; `--vault /nonexistent` → empty
  stdout, stderr `hook: ... empty context`, exit 0; `--budget 10`,
  `--budget x`, `--include nope`, `--subject 'bad id'`, `--query` together
  with `--query-stdin`, `--timeout-ms 50` → exit 2 each; stdin over 64 KiB
  of JSON → empty query note, exit 0; `--max-bytes 1024` on a packet larger
  than that → output ends with the truncation line, exit 0; the child's
  first-run note arrives on stderr prefixed `hook: `; `agent audit owner`
  afterwards lists a `context_packet` row.
- `context.test.ts` (extend cli-wave2's): `context --query-stdin` with
  piped `kettle` prints the packet; with `--query` too → exit 2; from a TTY
  cannot be tested in a subprocess — assert the in-process guard by calling
  the command with a `Context` whose `stdin.isTTY` is true → exit 2.
- `agent-snippet.test.ts`: `agent add ada` then `agent snippet ada
--token-env KIZUKI_TOKEN_ADA` → stdout parses as JSON with
  `mcpServers.kizuki.command === process.execPath`, `args` beginning with
  the absolute `main.ts` path then `mcp --agent ada --token
env:KIZUKI_TOKEN_ADA --vault <abs>`, `env.KIZUKI_TOKEN_ADA === ""`; no
  `kzk_` anywhere in stdout or stderr; the stderr note names `agent add
ada`; `--json` is one line; `--command /opt/kizuki` → `command` replaced
  and no leading `main.ts`; `--owner` → `--owner` in args and no `env`;
  unknown agent → exit 1; revoked agent → exit 1; `--token-env lower` →
  exit 2; both `<name>` and `--owner` → exit 2.
- `parity-config.test.ts`: round-trip `parse(serialize(c))`; defaults
  applied; each range bound (`max_age_hours 0`, `721`, `budget 49`, `2001`,
  `timeout_ms 999`, `max_output_bytes 4095`, `match_threshold 1.5`) →
  `bad_value` naming the key; unknown key and `[table]` → `unknown_key`;
  `include = "canon,nope"` → `bad_value`; `include = "timeline,canon"` →
  `["canon","timeline"]`; empty command → `bad_value`; a command
  containing `sk-not-a-real-key` never appears in any thrown message;
  `writeParityConfig` leaves a 0600 file and no `.tmp`; `readParityConfig`
  null when absent; `removeParityConfig` true then false.
- `parity-compare.test.ts`: `normalizeForCompare` drops the header line,
  CRLF, trailing spaces, blank runs, control sequences; identical packets
  differing only in `at` → `same === lines`, `word_jaccard 1`; disjoint
  texts → `0`; `verdictOf` truth table (every `ParityVerdict` reached);
  `diffExcerpt` caps at 200 lines and 16 KiB with the trailing `… <n> more
lines`; a 5 000 × 5 000 line pair finishes (the LCS budget fallback).
- `parity-receipts.test.ts`: append creates `receipts/parity.jsonl` 0600
  with one line; read returns it; a corrupted line → `malformed_receipt`
  with the line number and without the line's content; `parityFreshness`:
  unconfigured → `configured false`; configured with no receipt →
  `stale true`, `last_run null`; a receipt with `at` 25 h ago and
  `max_age_hours 24` → `stale true`, `age_hours 25.0`; 1 h ago → false;
  receipts under another fingerprint are not counted.
- `parity-run.test.ts` (in-process, `runParity` with a temp vault, `db`
  from `openVaultDb`, the promoted `kettle` page): command `cat` → verdict
  `drift` (the query alone against a packet), `previous.exit_code 0`,
  `query.sha256` = sha256 of `kettle`, no `text`, no `excerpt`; command
  `exit 3` → `previous_failed`, `exit_code 3`; command `sleep 5` with
  `timeout_ms 1000` → `previous_failed`, `timed_out true`, run time
  `< 3000 ms`; command `yes | head -c 2000000` with `max_output_bytes
4096` → `truncated true`, a verdict, `previous.bytes === 4096`; command
  `printf '%s' "$KIZUKI_PARITY_QUERY"` → the env variable carried the
  query; `keep_text: true` → `query.text === "kettle"` and an `excerpt`
  array; the raw `parity.jsonl` bytes never contain `kettle` when
  `keep_text` is false; `shell: null` → `ParityError("no_shell")`; the
  previous system's stderr with `\x1b[2J` comes back stripped in
  `previous_stderr` and is absent from the receipt; an `agent_audit` row
  for `owner`/`context_packet` exists after the run.
- `parity-cli.test.ts` (subprocess seam): `set` without `--command` on an
  empty vault → exit 1 `bad_value: command`; `set --command cat
--max-age-hours 1` → the two lines and the stderr note; `parity.toml`
  mode 0600; `show` matches; `show --json` parses; `run --query kettle` →
  one line `verdict=drift`, exit 0; `run --query kettle --command 'exit
3'` → `previous_failed`, exit 1; `run --queries` with a file of three
  lines (one `#` comment) → two receipts; a file of 201 queries → exit 1
  `bad_queries`; `run --query-stdin` with piped lines; `log` newest first
  and `--limit 1` → one line; `log --json` lines parse with
  `schema === "kizuki.parity-receipt/v1"`; `unset` twice → `parity
unconfigured` both times; receipts survive `unset`; every output line is
  free of `\x1b` when the command prints `\x1b[2J`.
- `doctor.test.ts` (extend): fresh vault → `parity unconfigured`, exit 0;
  after `set` with no run → `stale=true`, `problem parity: no receipt`,
  exit 1; after one `run` → `stale=false`, exit 0; a receipt rewritten with
  `at` 25 h ago (edit the JSONL in the test) → `stale=true` with `newest
receipt is 25.0h old`, exit 1; `unset` → `parity unconfigured`, exit 0;
  a corrupted `parity.toml` → `parity problem: malformed_config`, exit 1;
  `--json` carries the `parity` object and `ok: false` when stale; the
  command text never appears in doctor's stdout.
- `help.test.ts` (extend): the registry contains `hook` immediately after
  `context` and `parity` immediately after `mcp`; `help hook` and `help
parity` print their usage.
- `docs.test.ts`: read `docs/integrations.md` (relative to
  `import.meta.dir`); for every line inside a code fence matching
  `/^\$?\s*kizuki\s+([a-z-]+)(?:\s+([a-z-]+))?/`, the verb is in `COMMANDS`
  and, when the verb is `agent` or `parity`, the second token is one of
  that verb's subverbs (`add list grant revoke rotate audit snippet` /
  `set show unset run log`); the file contains the strings `tainted`,
  `never as instructions` and `kizuki agent snippet`.

## Non-goals

Scheduling parity runs or the hook (the daemon lane; it calls `runParity`
and reads `parity.toml`); a standing HTTP/loopback MCP endpoint;
harness-specific plugin packages or adapters; keyword extraction or any
change to `toFtsQuery`/`serveContextPacket` (the AND semantics are
documented, not worked around); retained-prefix packet deltas (§8.3);
semantic or embedding-based parity scoring; storing the previous system's
output verbatim; rotating or compacting `parity.jsonl`; exporting parity
receipts or `parity.toml` (`.kizuki/` is operational state); Windows;
changes to `packages/core`, `packages/mcp`, `packages/tui`,
`packages/connectors`; any new SQLite table or migration; any change to
`kizuki.event/v1`, `kizuki.proposal/v1` or the envelope.

## Runtime dependencies

None. `@kizuki/core` stays dependency-free; `packages/cli` gains no package.
`Bun.spawn` (argv arrays only), `Bun.which`, `Bun.stdin`, `Bun.TOML.parse`,
`Bun.CryptoHasher`, `node:fs`, `node:path` are the whole surface. No
`fetch`, sockets or network modules anywhere (`scripts/verify-network.ts`
scans every tracked source file inside `bun run verify`). The only
processes spawned are this same kizuki (`hook`) and the owner-configured
shell command (`parity run`).

## Acceptance

```
bun run typecheck && bun test                                          # green; ≥ 60 new tests in packages/cli/test
bun run verify                                                         # exit 0 (frozen install, typecheck, tests, policy tests, network scan, denylist on tracked text and reachable commit messages)
bun run scripts/verify-network.ts                                      # passes; this lane adds no allowlist entry
bun packages/cli/src/main.ts help | grep -cE '^  (hook|parity)\b'      # 2
bun packages/cli/src/main.ts help | grep -E '^  [a-z]+' | awk '{print $1}' | tr '\n' ' ' | grep -c 'context hook '   # 1 (hook directly after context)
bun packages/cli/src/main.ts help | grep -E '^  [a-z]+' | awk '{print $1}' | tr '\n' ' ' | grep -c 'mcp parity '     # 1 (parity directly after mcp)
T=$(mktemp -d); export KIZUKI_CONFIG=$T/config.toml; KZ="bun $PWD/packages/cli/src/main.ts"
$KZ init $T/vault >/dev/null
mkdir $T/notes && printf 'ada met grace at the acme library to plan the kettle project.\n' > $T/notes/a.md
$KZ import markdown-folder --source $T/notes | grep -c 'events_stored=1'                       # 1
ID=$($KZ review --list --json | head -1 | sed -n 's/.*"proposal_id":"\(01[0-9A-HJKMNPQRSTVWXYZ]\{24\}\)".*/\1/p')
$KZ promote "$ID" --sensitivity personal | grep -c '^page_path='                                # 1
printf 'kettle' | $KZ hook --query-stdin | head -1                                             # # kizuki context (principal: owner, at: <RFC3339>)
printf 'kettle' | $KZ hook --query-stdin | grep -c '\[page:'                                   # 1
printf '{"prompt":"kettle","other":1}' | $KZ hook --query-json prompt | grep -c '\[page:'      # 1
$KZ hook --vault /nonexistent/vault </dev/null | wc -c; echo "${PIPESTATUS[0]}"                 # 0 then 0; stderr "hook: ...; empty context"
$KZ hook --budget 10 </dev/null; echo $?                                                        # usage on stderr; 2
$KZ hook --query kettle --query-stdin </dev/null; echo $?                                       # usage on stderr; 2
printf 'kettle' | $KZ context --query-stdin | grep -c '\[page:'                                # 1 (the additive flag on context)
$KZ agent add ada | grep -c '^token=kzk_'                                                       # 1
$KZ agent snippet ada --token-env KIZUKI_TOKEN_ADA --json | bun -e 'const s = JSON.parse(await Bun.stdin.text()).mcpServers.kizuki; console.log(s.command === process.execPath && s.args.slice(1).join(" ").startsWith("mcp --agent ada --token env:KIZUKI_TOKEN_ADA --vault /") && s.env.KIZUKI_TOKEN_ADA === "")'   # true
$KZ agent snippet ada --token-env KIZUKI_TOKEN_ADA 2>&1 | grep -c kzk_                          # 0
$KZ agent snippet --owner --command /opt/kizuki | grep -c '"command": "/opt/kizuki"'             # 1
$KZ agent snippet grace --token-env KIZUKI_TOKEN_GRACE; echo $?                                  # error: agent grace does not exist; 1
$KZ doctor | grep '^parity '                                                                    # parity unconfigured
$KZ parity set --command "$KZ context --query-stdin --vault $T/vault" --max-age-hours 1        # command: … then parity command=<12 hex> max_age_hours=1 budget=450 include=canon,graph,timeline timeout_ms=60000 max_output_bytes=1048576 match_threshold=0.5 keep_text=false; stderr note about the first run
ls -l $T/vault/.kizuki/parity.toml | cut -c1-10                                                 # -rw-------
$KZ doctor | grep '^parity '                                                                    # parity command=<12 hex> last_run=never age_hours=- runs=0 drift=0 max_age_hours=1 stale=true
$KZ doctor >/dev/null; echo $?                                                                  # 1 (problem parity: no receipt for the configured command; …)
$KZ parity run --query kettle                                                                   # <ULID> verdict=match jaccard=1.00 lines=+0/-0 kizuki=<n>B previous=<n>B exit=0 <ms>ms
$KZ doctor | grep '^parity '                                                                    # … last_run=<ts> age_hours=0.0 runs=1 drift=0 max_age_hours=1 stale=false
$KZ doctor >/dev/null; echo $?                                                                  # 0
$KZ parity run --query kettle --command cat                                                     # <ULID> verdict=drift jaccard=0.<nn> … exit=0 …
$KZ parity run --query kettle --command 'exit 3'; echo $?                                       # <ULID> verdict=previous_failed … exit=3 …; 1
$KZ parity run --query kettle --command 'sleep 5' --timeout-ms 1000; echo $?                    # <ULID> verdict=previous_failed … exit=killed … (about 1000ms); 1
$KZ parity run --query kettle --command 'printf "\033[2J%s" "$KIZUKI_PARITY_QUERY"' | grep -c $'\x1b'   # 0 (nothing from the previous system reaches the terminal unsanitized)
$KZ parity log | wc -l                                                                          # 5
$KZ parity log --limit 1 | grep -c 'verdict\|drift\|match\|previous_failed'                    # 1
$KZ parity log --json | head -1 | grep -c '"schema":"kizuki.parity-receipt/v1"'                 # 1
$KZ parity log --json | grep -c '"text"'                                                        # 0 (keep_text is off)
grep -c kettle $T/vault/.kizuki/receipts/parity.jsonl                                           # 0
ls -l $T/vault/.kizuki/receipts/parity.jsonl | cut -c1-10                                       # -rw-------
$KZ parity set --keep-text >/dev/null && $KZ parity run --query kettle >/dev/null && $KZ parity log --json | head -1 | grep -c '"text":"kettle"'   # 1
$KZ doctor | grep -c 'context --query-stdin'                                                   # 0 (the command text never reaches doctor output)
$KZ parity unset && $KZ doctor | grep '^parity '                                                # parity unconfigured; then "parity unconfigured"
$KZ doctor >/dev/null; echo $?                                                                  # 0
$KZ agent audit owner | grep -c context_packet                                                  # ≥ 5 (hook runs and parity runs are audited owner reads)
grep -c '^kizuki \|^\$ kizuki \|^exec kizuki ' docs/integrations.md                             # ≥ 10; docs.test.ts proves every one is a registered verb
git diff --stat main..HEAD -- packages/core | cat                                                # empty (core untouched)
git diff --stat main..HEAD -- '*package.json' bun.lock | cat                                     # empty (no dependency change)
git status --porcelain                                                                          # empty
```
