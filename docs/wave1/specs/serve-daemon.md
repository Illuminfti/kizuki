# Lane: serve-daemon — `kizuki serve`: loopback daemon with a receipted scheduler, sync loops, the daily brief, notifiers and the standing MCP endpoint

Packages: `packages/core` (NEW directory `src/serve/`, one additive export in
`src/staging/producers.ts`, one NEW function in `src/ingest/run.ts` if it is
not already on your branch, exports in `src/index.ts`, the public-surface
test), `packages/mcp` (NEW `src/http.ts`, one additive edit to its
`AGENTS.md`), `packages/cli` (NEW `commands/serve.ts`, NEW `serve-config.ts`,
additions to `commands/doctor.ts` and `context.ts`), `scripts/network-allowlist.txt`
(entries only), README. Read CONVENTIONS.md first, then `docs/architecture.md`
(invariants 2, 3, 5, 6, 7, 8, 9, 10; the "Storage" list naming `schedules`
and `run receipts`; the "Proactive (`kizuki serve`)" section), `rfcs/0000-constraints.md`
§2, §3, §8, `rfcs/0001-deep-model-arbitration.md` (taint separation; no new
canon write path), `AGENTS.md`, `packages/core/AGENTS.md`,
`packages/cli/AGENTS.md`, `packages/mcp/AGENTS.md` (NEW in serving-mcp),
`.agents/skills/reliability-engineering/SKILL.md`,
`concurrency-race-analysis`, `observability-debuggability`,
`sqlite-data-modeling`, `threat-modeling`, `security-privacy-review`,
`dependency-evaluation`. The fuller design is `workspace/kizuki-plan/ARCHITECTURE.md`
§0 (invariant 9: "a rail without a fresh receipt is reported down, even if a
port is open"), §1 (processes: "the daemon owns it; loopback-only";
`schedules`, `run_receipts` table groups), §8.2 ("standing loopback HTTP
under `kizuki serve` with per-agent tokens"), §9 (proactive rails: the design
section this lane implements), §10, §12 (lessons-as-tests: scheduled-write-to-canon
impossible, receipt-staleness detection), plus `ROADMAP.md` "Wave 4 —
proactive rails" (exit proof: seven days of receipts, brief each morning,
kill-and-restart resumes cleanly). Then read every file this lane composes:
`packages/core/src/ingest/run.ts`, `ledger/connections.ts`, `ledger/ledger.ts`
(`readSince`, `LedgerCursor`), `ledger/schema.ts` (`tableExists`),
`staging/proposals.ts`, `staging/producers.ts` (the `blockquote` helper),
`staging/promote.ts` (`pageRelPath`; what `claim` vs `edit` need),
`vault/init.ts` (`dashboards/` exists in every vault), `vault/doctor.ts`,
`agents/identity.ts` (`authenticate`), `agents/audit.ts`, `query/timeline.ts`,
`search/indexer.ts` (`indexEvent`), `util/ulid.ts`, `util/time.ts`,
`contracts/connector.ts` (`SecretResolver`, `HealthReport`),
`contracts/secret-ref.ts`, `packages/core/test/ingest.test.ts` (the
`FixtureConnector` shape), `packages/core/test/staging/invariants.test.ts`
(the source-scanning test shape §14 copies), `scripts/verify-network.ts`.

Reconciled against `main` at `76930db` (2026-09-02; `bun test` = 515 pass /
41 files; bun 1.3.14 locally, CI pins 1.3.10). Every symbol below is either
grepped on that revision or marked NEW with its location. ARCHITECTURE.md
§11 sketches a `packages/daemon/`; the owner's brief places the daemon in
`packages/core/src/serve` — this spec follows the brief.

## Already on main (compose, do not rebuild)

- Ingest: `runBackfill` / `runSync` (one batch per call; the checkpoint only
  advances when `errors.length === 0`), `runBatch`, `RunResult`,
  `saveCheckpoint` / `getCheckpoint` keyed `(connector_id, source_key)`,
  `listConnections(db)` (active rows), `Connection`.
- Agents: `authenticate(db, token) → Principal | null` (constant-time, null
  for revoked/malformed), `OWNER`, `initAgents`, `recordAudit`.
- Staging: `fileProposal` (idempotent by `(kind, target, body_hash)`;
  `duplicate` and `suppressed` outcomes), `listProposals`, `initStaging`,
  `PROPOSAL_KINDS`; `producers.ts` has a private `blockquote(text)` that
  prefixes every line (§7 exports it).
- Promote: `pageRelPath` maps target `dashboards/brief/2026-09-02` to
  `dashboards/brief/2026-09-02.md`; `claim` mints a page, `edit` replaces
  the body of an existing page and unions `sources`; both are owner-only.
- Ledger reads: `readSince(db, cursor, limit)` pages by
  `(accepted_at, event_id)`; `count`; `timeline(db, opts)`.
- Derived: `indexEvent`, `initSearch`, `initGraph`, `rebuildDerived`.
- `doctorVault(vaultPath)`, `readHolds(db)`, `tableExists`.
- `SecretResolver`, `isSecretRef` / `parseSecretRef` (`env:` | `file:`),
  `HealthReport`, `isRfc3339`, `ulid`, `PAGE_TYPES` (includes `rollup`).
- `scripts/verify-network.ts`: AST scan of every tracked file under
  `packages/` (tests included) for `fetch`, `Bun.serve`, `Bun.connect`,
  `WebSocket`, node network modules. No allowlist on main (§13).
- Runtime facts verified on this box (bun 1.3.14, 2026-09-02):
  `Bun.serve({ hostname: "127.0.0.1", port })` binds IPv4 loopback only (a
  fetch to `[::1]` is refused); `maxRequestBodySize` yields 413;
  `server.stop(true)` closes; a second bind on the same port throws
  `EADDRINUSE`; `server.fetch(request)` invokes the handler without a
  socket; the socket returned by `Bun.connect` has `upgradeTLS`
  (STARTTLS); `new Bun.CryptoHasher("sha256", key)` is HMAC;
  `process.on("SIGTERM")` handlers fire; `process.kill(pid, 0)` throws
  `ESRCH` for a dead pid; `openSync(path, "wx")` throws `EEXIST`;
  `Bun.TOML.parse` exists; `Date` local getters honor `TZ`.
- `@modelcontextprotocol/sdk@1.30.0` (the pin serving-mcp chose):
  `dist/esm/server/webStandardStreamableHttp.js` imports only
  `../shared/mediaType.js`, `./sseKeepAlive.js` and `../types.js` (verified
  by unpacking the tarball 2026-09-02) — no express, hono or jose. Its
  `WebStandardStreamableHTTPServerTransport` takes
  `{ sessionIdGenerator: undefined, enableJsonResponse: true }` for a
  stateless JSON request/response mode and exposes
  `handleRequest(request: Request): Promise<Response>`; in JSON mode the
  promise resolves once every response is ready, so the transport can be
  closed after the `Response` is returned.

## Depends on (NEW on sibling branches; verify each on the branch you start from)

- **cli-verbs**: `packages/cli/src/{main,args,config,context,output}.ts`,
  `commands/index.ts` (`Command`, `CliIo`, `COMMANDS`), `withVault`,
  `openVaultDb`, `assertVault`, `commands/doctor.ts` and its `--json`
  document, `connections.ts` (`listHostConnections`).
- **serving-mcp**: `packages/core/src/serving/` (`ServeContext`, the eight
  `serve*` functions), `packages/mcp` (`createServer(ctx)`, the
  `AGENTS.md` rule "no transport other than stdio" that §9 amends).
- **cli-wave2**: `RunHooks` on `runBatch`/`runBackfill`/`runSync`
  (`{ onStored?(event) }`), `readDerivedMeta`, `connectorFor(ctx,
connection)`, `hostSecretResolver(ctx)`, `ensureDerived(ctx)`,
  `openVaultDb` calling `initAgents`/`initGraph`, the `Context` shape,
  doctor's extra lines.
- **ci-hardening**: `scripts/network-allowlist.txt` (`<path>:<reason>`),
  `parseAllowlist` / `applyAllowlist` with stale detection. §13 lists the
  entries and the one rule relaxation this lane needs.
- **connector-telegram §7**: `runToCompletion(db, connector, connector_id,
source_key, mode, { maxBatches, hooks })` in `packages/core/src/ingest/run.ts`.
  If it is absent on your branch, add it with exactly that signature and
  the four tests that spec names; whichever lane lands second reuses it.

## Objective

Program-first stays true: nothing here is needed to capture, review, query
or serve. `kizuki serve` adds the always-on part (§9): a loopback-only
daemon that runs jobs from a `schedules` table, writes a `run_receipts` row
for every run, syncs every active connection on its own cadence honoring
checkpoints, files a daily brief as a proposal (never canon), pushes
count-only digests through owner-configured notifiers that point back at
`kizuki review`, and exposes the MCP tools over a standing loopback HTTP
endpoint authenticated by per-agent tokens. `kizuki doctor` judges every
rail by its receipts, so a daemon that holds a port but does no work is
reported down (invariant 9). Kill it at any point and restart: checkpoints,
receipts and the lock file make resumption boring.

## 0. Layout (all NEW unless noted)

```
packages/core/src/serve/
  index.ts        barrel (§12)
  errors.ts       ServeDaemonError
  schema.ts       initServe(db): schedules, run_receipts
  schedule.ts     spec grammar, parseSchedule, nextRun, staleAfterMs, TimeZone seams
  receipts.ts     startRun, finishRun, markInterrupted, latestReceipt, listReceipts, pruneReceipts
  lock.ts         acquireLock, readLock, lockAlive, releaseLock
  config.ts       ServeConfig, DEFAULT_SERVE_CONFIG, parseServeConfig (pure)
  jobs.ts         JOB_IDS, job classification, timeouts, reconcileSchedules
  sync.ts         runSyncJob
  brief.ts        collectBrief, renderBrief, fileBrief, BriefNarrator
  sweep.ts        runDoctorSweep (the in-daemon doctor job)
  health.ts       serveStatus (what `doctor` and `serve status` print)
  http.ts         startLoopbackServer (Bun.serve on 127.0.0.1; bearer auth)   [allowlisted]
  daemon.ts       Daemon: start/tick/stop, serial executor, signals; runOnce, runJob
  notify/
    types.ts      Notification, Notifier, NotifierConfig, NotificationKind
    render.ts     notification text from counts and ids (never captured text)
    telegram.ts   Telegram Bot API over fetch                                 [allowlisted]
    webhook.ts    owner URL over fetch, HMAC signature                        [allowlisted]
    smtp.ts       minimal SMTP client over Bun.connect (TLS / STARTTLS)      [allowlisted]
    dispatch.ts   fan-out, event filter, per-notifier receipts, dedupe
packages/core/src/staging/producers.ts   export blockquote (rename to blockquoteCapture)
packages/core/src/ingest/run.ts          runToCompletion (only if absent; see Depends on)
packages/mcp/src/http.ts                 createHttpHandler (per-request server + transport)
packages/mcp/AGENTS.md                   amended rule (§9.2)
packages/cli/src/serve-config.ts         readServeConfig: TOML file → parseServeConfig
packages/cli/src/commands/serve.ts       the verb (§11)
packages/cli/src/commands/doctor.ts      rail + daemon lines (§11.3)
packages/cli/src/context.ts              PRAGMA busy_timeout (§11.4)
```

Every file under ~400 lines. No `any`, no `as unknown as`, no new runtime
dependency anywhere (`bun.lock` unchanged; §13).

## 1. Configuration — `<vault>/.kizuki/serve.toml`

Per-vault, because the daemon, its lock, its schedules and its receipts are
per-vault (one `kizuki.db` per vault). The file is optional: absent means
`DEFAULT_SERVE_CONFIG` (sync every 15 minutes, brief daily at 07:00 local,
doctor sweep hourly, port 7411, no notifiers). It lives under `.kizuki/`,
which every vault's `.gitignore` already excludes and `exportVault` skips.
`readServeConfig` (CLI, §11) refuses a file whose mode grants group/other
bits (`(mode & 0o077) !== 0` → `error: serve.toml must be mode 0600`) —
it names secret refs and a chat id.

```toml
[serve]
port = 7411                 # loopback MCP endpoint; 1024..65535
tick_seconds = 5            # scheduler wake-up; 1..60
heartbeat_seconds = 30      # liveness receipt cadence; 5..300
shutdown_grace_seconds = 30 # wait for the running job on SIGTERM; 0..600

[schedules]
sync = "every 15m"          # applied to every active connection
brief = "daily 07:00"       # local time of the daemon process
doctor = "every 1h"

[[notifiers]]
name = "phone"              # [a-z0-9][a-z0-9-]{0,31}, unique
kind = "telegram"
token_ref = "env:KIZUKI_NOTIFY_TELEGRAM_TOKEN"   # secret_ref only
chat_id = "123456789"       # digits with optional leading '-'
events = ["brief", "doctor", "sync_error"]      # subset; default all three

[[notifiers]]
name = "mail"
kind = "smtp"
host = "smtp.example.invalid"
port = 465
security = "tls"            # tls (implicit, default for 465) | starttls | none
username = "ada@example.invalid"                 # optional; AUTH PLAIN when present
password_ref = "env:KIZUKI_NOTIFY_SMTP_PASSWORD" # required when username is set
from = "kizuki@example.invalid"
to = ["ada@example.invalid"]                     # 1..8 addresses

[[notifiers]]
name = "hook"
kind = "webhook"
url = "https://hooks.example.invalid/kizuki"     # https, or http to a loopback host
secret_ref = "env:KIZUKI_NOTIFY_WEBHOOK_SECRET"  # optional; HMAC-SHA256 header
```

```ts
// packages/core/src/serve/config.ts
export type NotificationKind = "brief" | "doctor" | "sync_error";
export const NOTIFICATION_KINDS: readonly NotificationKind[];

export interface TelegramNotifierConfig {
  name: string;
  kind: "telegram";
  token_ref: string; // isSecretRef
  chat_id: string; // /^-?\d{1,20}$/
  events: NotificationKind[];
}
export interface SmtpNotifierConfig {
  name: string;
  kind: "smtp";
  host: string; // /^[A-Za-z0-9.-]{1,253}$/
  port: number; // 1..65535
  security: "tls" | "starttls" | "none"; // "none" only when host is 127.0.0.1 | ::1 | localhost
  username: string | null;
  password_ref: string | null; // isSecretRef; required iff username !== null
  from: string; // addr-spec: /^[^\s@<>]+@[^\s@<>]+$/, ≤ 254 chars
  to: string[]; // 1..8, same rule
  events: NotificationKind[];
}
export interface WebhookNotifierConfig {
  name: string;
  kind: "webhook";
  url: string; // parsed with new URL; https:, or http: when hostname is loopback
  secret_ref: string | null;
  events: NotificationKind[];
}
export type NotifierConfig =
  TelegramNotifierConfig | SmtpNotifierConfig | WebhookNotifierConfig;

export interface ServeConfig {
  port: number;
  tick_seconds: number;
  heartbeat_seconds: number;
  shutdown_grace_seconds: number;
  schedules: { sync: string; brief: string; doctor: string }; // validated by parseSchedule
  notifiers: NotifierConfig[];
}
export const DEFAULT_SERVE_CONFIG: ServeConfig;
export function parseServeConfig(raw: unknown): ServeConfig;
```

`parseServeConfig` is pure and fails closed: `raw` must be a plain object;
unknown keys at any level → `ServeDaemonError("config", "<path>: unknown key")`;
every notifier must have a unique `name`; a `*_ref` that is not `isSecretRef`
→ `config` error naming the key (never the value); `security = "none"`
outside loopback → error; `http:` webhook outside loopback → error;
`events` entries must be in `NOTIFICATION_KINDS`, no duplicates; numbers
must be integers in the ranges above. Defaults fill missing sections. The
TOML parse itself (`Bun.TOML.parse`) happens in the CLI (§11) — core never
reads config files; it validates objects.

```ts
// packages/core/src/serve/errors.ts
export type ServeDaemonErrorCode =
  | "config"
  | "locked" // another daemon holds the lock
  | "port_in_use"
  | "unknown_job"
  | "in_flight"
  | "timeout"
  | "notifier"
  | "connector"
  | "vault"
  | "narrator";
export class ServeDaemonError extends Error {
  override name = "ServeDaemonError";
  readonly code: ServeDaemonErrorCode;
  constructor(
    code: ServeDaemonErrorCode,
    message: string,
    opts?: { cause?: unknown },
  );
}
```

Messages are stable and contain no secret, no captured text and no
filesystem path except in `config` errors, which name the TOML key path
(`notifiers[1].token_ref`), never a value.

## 2. Schema — `initServe(db)` (idempotent, the `initAgents` pattern; no ledger migration)

```sql
CREATE TABLE IF NOT EXISTS schedules (
  job         TEXT PRIMARY KEY,   -- §5 job ids
  spec        TEXT NOT NULL,      -- §3 grammar, validated before insert
  enabled     INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,      -- RFC3339 (UTC, .sssZ)
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS run_receipts (
  receipt_id  TEXT PRIMARY KEY,   -- ULID
  job         TEXT NOT NULL,
  run_id      TEXT NOT NULL,      -- daemon boot id (ULID) or 'cli' for serve --once / serve run
  started_at  TEXT NOT NULL,
  finished_at TEXT,               -- NULL while running
  status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'error', 'skipped', 'interrupted')),
  summary     TEXT NOT NULL,      -- JSON object: counts, booleans, short ids, RFC3339 strings only (§4)
  error       TEXT                -- ServeDaemonErrorCode | 'connector_errors' | 'runner' | NULL; never a message
) STRICT;

CREATE INDEX IF NOT EXISTS run_receipts_by_job ON run_receipts(job, started_at);
CREATE INDEX IF NOT EXISTS run_receipts_by_run ON run_receipts(run_id, status);
```

`schedules` is derived from config + connections (§5.4) and rebuilt at every
start; deleting it loses nothing but `next_run_at`. `run_receipts` is
operational history: a row is inserted at start and updated exactly once at
finish (or once more to `interrupted` by a later boot); it is never edited
otherwise and never exported (`exportVault` is untouched). Both tables are
created only by `initServe`; `openVaultDb` (CLI) calls it after `initAgents`
so `doctor` can read receipts without the daemon ever having run.

## 3. Schedule grammar — `schedule.ts`

```
spec     := "every " duration | "daily " HH ":" MM | "cron " field{5}
duration := integer (1..) followed by "s" | "m" | "h"        e.g. every 15m
HH:MM    := 00..23 ":" 00..59                                 e.g. daily 07:00
field    := "*" | list ; list := item ("," item)* ; item := number | number "-" number | (number | "*" | range) "/" step
             minute 0-59, hour 0-23, day-of-month 1-31, month 1-12, day-of-week 0-6 (0 = Sunday); no names
```

```ts
export type ScheduleSpec =
  | { kind: "every"; seconds: number }
  | {
      kind: "cron";
      minute: Set<number>;
      hour: Set<number>;
      dom: Set<number>;
      month: Set<number>;
      dow: Set<number>;
      source: string;
    };
export function parseSchedule(text: string): ScheduleSpec; // RangeError with the offending field on any violation; "daily HH:MM" parses as cron "MM HH * * *"
export interface TimeZone {
  parts(date: Date): {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    weekday: number;
  }; // month 1-12, weekday 0-6
}
export function localZone(): TimeZone; // Date local getters (honors TZ)
export function utcZone(): TimeZone; // Date UTC getters (tests)
export function nextRun(spec: ScheduleSpec, after: Date, zone: TimeZone): Date;
export function staleAfterMs(
  spec: ScheduleSpec,
  last: Date,
  zone: TimeZone,
): number;
```

- `every`: `after + seconds`. `cron`: iterate minute boundaries starting at
  the first whole minute strictly after `after`; the first candidate whose
  `zone.parts` matches every field wins; day-of-month and day-of-week
  combine with OR when both are restricted (Vixie cron semantics); give up
  after 366 days with `RangeError("schedule never fires within a year")`.
  Pure, bounded, deterministic.
- `staleAfterMs(spec, last)`: `every` → `2 * seconds * 1000 + 60_000`;
  `cron` → `2 * (nextRun(nextRun(last)) - nextRun(last)) + 60_000` (twice
  the gap between the two fires after `last`, plus a minute of grace).
  `doctor` calls a rail stale when `now - last.started_at > staleAfterMs`.

## 4. Receipts — `receipts.ts`

```ts
export type RunStatus = "running" | "ok" | "error" | "skipped" | "interrupted";
export type ReceiptSummary = Record<string, number | boolean | string>;
export interface RunReceipt {
  receipt_id: string;
  job: string;
  run_id: string;
  started_at: string;
  finished_at: string | null;
  status: RunStatus;
  summary: ReceiptSummary;
  error: string | null;
}
export function startRun(
  db: Database,
  job: string,
  runId: string,
  now?: Date,
): RunReceipt;
export function finishRun(
  db: Database,
  receiptId: string,
  outcome: {
    status: "ok" | "error" | "skipped";
    summary?: ReceiptSummary;
    error?: string;
  },
  now?: Date,
): RunReceipt; // refuses (Error) when the row is not 'running'
export function markInterrupted(
  db: Database,
  currentRunId: string,
  now?: Date,
): string[]; // every 'running' row with run_id !== currentRunId → 'interrupted'; returns job ids
export function latestReceipt(db: Database, job: string): RunReceipt | null; // ORDER BY started_at DESC, receipt_id DESC LIMIT 1
export function listReceipts(
  db: Database,
  opts?: { job?: string; since?: string; limit?: number },
): RunReceipt[]; // newest first; limit default 100, max 10 000
export function pruneReceipts(db: Database, now?: Date): number;
// deletes: heartbeat rows older than 60 min; every other job's rows older than 30 days;
// never the newest row of any job; returns rows deleted
```

Summary discipline (validated in `startRun`/`finishRun`, `TypeError` on
violation): keys `/^[a-z][a-z0-9_]{0,31}$/`; values are finite numbers,
booleans, or strings that are either `isRfc3339` or match
`/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/`. That admits counts, job ids, ULIDs,
connector ids and timestamps, and excludes paths, messages, tokens and
captured text by construction. `error` is a category (§1's codes plus
`connector_errors` and `runner`); the human message goes to the daemon's
stderr line (§10.5), never into SQLite — cli-verbs' test that the raw
`kizuki.db` never contains a source path must stay green with the daemon
running.

## 5. Jobs — `jobs.ts`

```ts
export const FIXED_JOBS = ["heartbeat", "brief", "doctor"] as const;
export type JobKind = "heartbeat" | "sync" | "brief" | "doctor" | "notify";
export function jobKind(job: string): JobKind | null;
// "heartbeat" | "brief" | "doctor" | /^sync:[A-Za-z0-9._-]+:[0-9A-HJKMNPQRSTVWXYZ]{26}$/ | /^notify:[a-z0-9-]+:(brief|doctor|sync_error)$/
export function syncJobId(
  connection: Pick<Connection, "connector_id" | "source_key">,
): string; // `sync:${connector_id}:${source_key}`
export const JOB_TIMEOUT_MS: Record<Exclude<JobKind, "notify">, number>; // heartbeat 10 s, sync 30 min, brief 5 min, doctor 5 min
export interface ScheduleRow {
  job: string;
  spec: string;
  enabled: boolean;
  next_run_at: string;
  updated_at: string;
}
export function listSchedules(db: Database): ScheduleRow[]; // ORDER BY job
export function reconcileSchedules(
  db: Database,
  config: ServeConfig,
  connections: Connection[],
  now: Date,
  zone: TimeZone,
): { created: string[]; disabled: string[]; respecced: string[] };
export function dueJobs(db: Database, now: Date): string[]; // enabled AND next_run_at <= now, ordered: heartbeat, sync:* (by job), brief, doctor
export function advance(
  db: Database,
  job: string,
  now: Date,
  zone: TimeZone,
): string; // next_run_at = nextRun(spec, now); returns it
```

- `reconcileSchedules` (at start and on every heartbeat): upsert
  `heartbeat` (`every ${heartbeat_seconds}s`), `brief`, `doctor` from
  config; one `sync:<id>:<key>` per active connection with
  `config.schedules.sync`; rows for connections that are no longer active →
  `enabled = 0`; rows whose `spec` differs from config → replaced and
  `next_run_at` recomputed. A newly created row gets `next_run_at = now`
  (first run at the next tick — same-day value), except `brief`, which gets
  `nextRun(spec, now)` unless no `ok` brief receipt exists at all, in which
  case `now` (the first brief lands minutes after the first `serve`, ROADMAP
  Wave 4 "brief lands each morning" starts with one that lands today).
  `notify:*` receipts have no schedule rows (they are triggered, §8).
- `dueJobs` order is fixed so a tick is deterministic.

## 6. Sync — `sync.ts`

```ts
export type ConnectorFactory = (connection: Connection) => Promise<Connector>;
export interface SyncOutcome {
  result: RunResult;
  batches: number;
  skipped: boolean;
}
export async function runSyncJob(
  db: Database,
  connection: Connection,
  connectors: ConnectorFactory,
  hooks: RunHooks | undefined,
): Promise<SyncOutcome>;
```

- `connector = await connectors(connection)` (the CLI passes
  `(c) => connectorFor(ctx, c)` from cli-wave2 §2; core cannot build
  connectors). A factory throw → `ServeDaemonError("connector")`.
- `manifest().capabilities.sync === false` → `{ skipped: true }`, receipt
  `skipped` with `summary.reason = "no_sync"` (import-only connectors never
  count as stale rails: their schedule row is disabled by
  `reconcileSchedules` after the first skip).
- Otherwise `runToCompletion(db, connector, connection.connector_id,
connection.source_key, "sync", { hooks, maxBatches: 10_000 })`. Every batch
  commits its checkpoint before the next call (runner semantics on main),
  so a kill mid-sync resumes from the last durable cursor. The hooks the
  CLI passes are cli-wave2's `indexEventsHook` (`onStored → indexEvent`),
  which keeps FTS fresh without a rebuild.
- Receipt: `summary = { stored, duplicates, errors: result.errors.length,
proposals_created, withdrawn, retractions_filed, batches }`; `status = "ok"`
  when `errors === 0`, else `"error"` with `error = "connector_errors"` and
  each error string on stderr (§10.5) — the checkpoint did not advance, so
  the next slot retries.

## 7. Daily brief — `brief.ts`

The brief is a `kizuki.proposal/v1` filed into staging by the deterministic
floor; it reaches canon only if the owner promotes it (invariant 3, RFC 0000
§2). Zero LLM required; a narrator is strictly additive.

```ts
export interface BriefWindow {
  since: string;
  until: string;
  truncated_since: boolean;
}
export interface BriefHighlight {
  event_id: string;
  occurred_at: string;
  connector_id: string;
  kind: string;
  subjects: string[];
  sensitivity: string;
  preview: string; // ≤ 160 code points, whitespace collapsed
}
export interface BriefSkeleton {
  date: string; // YYYY-MM-DD of `until` in `zone`
  window: BriefWindow;
  capture: {
    connector_id: string;
    kind: string;
    events: number;
    tombstones: number;
  }[]; // sorted
  capture_truncated: boolean; // more than MAX_BRIEF_EVENTS rows in the window
  rails: {
    job: string;
    status: RunStatus;
    started_at: string;
    summary: ReceiptSummary;
  }[]; // latest receipt per non-heartbeat job inside the window
  review: { pending: number; by_kind: Record<string, number> };
  highlights: BriefHighlight[]; // ≤ 20, newest occurred_at first, live records only
}
export const MAX_BRIEF_EVENTS = 50_000;
export function briefWindow(db: Database, now: Date): BriefWindow;
// since = summary.until of the latest 'ok' brief receipt when it is within 7 days of now, else now − 24 h;
// a since older than 7 days is clamped to now − 7 d with truncated_since = true. until = now.
export function collectBrief(
  db: Database,
  window: BriefWindow,
  now: Date,
  zone: TimeZone,
): BriefSkeleton;
// events by accepted_at via readSince({ accepted_at: since, event_id: "" }, 500) until accepted_at >= until or
// MAX_BRIEF_EVENTS; highlights exclude tombstones and records that later gained a tombstone (same
// (connector_id, source_record_id) with deleted = 1 — the serving-mcp liveEventIds rule, applied here with one query);
// review counts via listProposals(status: "pending", limit: 100000) grouped by kind.
export type BriefNarrator = (skeleton: BriefSkeleton) => Promise<string>;
export function renderBrief(
  skeleton: BriefSkeleton,
  narrative: string | null,
): string;
export interface FiledBrief {
  outcome: "stored" | "duplicate" | "suppressed" | "no_events";
  proposal_id: string | null;
  kind: "claim" | "edit";
  narrative: "none" | "ok" | "skipped";
}
export async function fileBrief(
  db: Database,
  vaultPath: string,
  now: Date,
  zone: TimeZone,
  narrator?: BriefNarrator,
): Promise<FiledBrief>;
```

`renderBrief` output (Markdown; every captured string goes through
`blockquoteCapture`, which producers.ts already uses so a `---` or heading
inside captured text stays inert; control characters other than `\n` are
stripped from previews):

```
Window: <since> to <until>. (Earlier history was truncated to seven days.)   ← second sentence only when truncated_since

## Capture
| connector | kind | events | tombstones |
| --- | --- | --- | --- |
| kizuki.markdown-folder | file | 12 | 1 |
(counts truncated at 50000 events)                                            ← only when capture_truncated

## Rails
- sync:kizuki.markdown-folder:01ARZ… ok at 2026-09-02T06:15:03.000Z stored=12 errors=0
- doctor ok at 2026-09-02T06:00:00.000Z problems=0

## Review queue
pending=7 (claim=4, entity=3). Run: kizuki review

## Highlights (captured text, quoted)
- 2026-09-01T18:02:11Z kizuki.markdown-folder file (personal)
  > first line of the preview…

## Narrative (model)                                                          ← only with a narrator
> model text, blockquoted line by line
```

`fileBrief`:

1. `skeleton = collectBrief(...)`; when `highlights.length === 0` →
   `{ outcome: "no_events", proposal_id: null, kind: "claim", narrative: "none" }`
   and nothing is filed: a proposal must carry provenance (invariant 6 of
   RFC 0000) and a brief with no events has none. The receipt says
   `skipped` / `no_events`.
2. `narrative = narrator ? await narrator(skeleton) : null`; a narrator
   throw or a result longer than 8 000 code points → `narrative: "skipped"`,
   the deterministic brief is filed anyway (RFC 0000 §4: graceful
   degradation), and the daemon logs the error category `narrator`.
3. `target = "dashboards/brief/<date>"`; `existing = existsSync(join(vaultPath, "dashboards", "brief", "<date>.md"))`
   (the exact path `pageRelPath` derives; `readExisting` in promote will
   find the same file). `kind = existing ? "edit" : "claim"` — promoting a
   `claim` onto an existing page is refused by core, so a second brief for
   the same date is filed as an `edit` the owner can accept or reject.
4. `fileProposal(db, { kind, target, body: renderBrief(...), frontmatter:
{ type: "rollup", title: "Daily brief <date>", "x-brief-since": since,
"x-brief-until": until, "x-brief-producer": narrative ? "llm" : "deterministic" },
provenance: highlights.map(h => h.event_id), subjects: [], producer:
narrative === null ? "deterministic" : "llm", confidence: 1 })`.
   `duplicate` (identical body refiled, e.g. `serve run brief` twice in a
   quiet hour) and `suppressed` (the owner rejected this exact brief) are
   returned, not thrown.

The receipt summary: `{ outcome, kind, proposal_id?, since, until,
events: Σ capture.events, highlights: n, pending, narrative }`. The owner
finds the brief at the top of `kizuki review` (kind `claim`/`edit`, title
`Daily brief <date>`); the notifier digest (§8) tells them it exists.

## 8. Notifiers — `notify/`

Notifiers are outbound-only channels owned by the owner (§9); each is a
user-configured egress (invariant 6) and never a surface an agent can reach.
A notification carries counts, job ids and a proposal id — never captured
text, page titles, paths, health `detail` strings or error messages.

```ts
// notify/types.ts
export interface Notification {
  schema: "kizuki.notification/v1";
  kind: NotificationKind;
  at: string; // RFC3339
  title: string; // ≤ 120 chars, composed by render.ts
  lines: string[]; // ≤ 20 lines, ≤ 200 chars each, composed by render.ts
  digest: string; // sha256 hex of kind + lines; the dedupe key
}
export interface Notifier {
  readonly name: string;
  readonly kind: NotifierConfig["kind"];
  send(notification: Notification, resolve: SecretResolver): Promise<void>; // throws ServeDaemonError("notifier")
}
export function createNotifier(
  config: NotifierConfig,
  deps?: NotifierDeps,
): Notifier;
export interface NotifierDeps {
  fetch?: typeof fetch;
  connect?: typeof Bun.connect;
  now?: () => Date;
} // test seams
```

```ts
// notify/render.ts
export function briefNotification(
  filed: FiledBrief,
  skeleton: BriefSkeleton,
  at: string,
): Notification;
// title "Kizuki daily brief <date>"; lines: "events=<n> highlights=<n> pending=<n>", "proposal=<id> (<claim|edit>)",
// "review: kizuki review"
export function doctorNotification(
  sweep: SweepResult,
  at: string,
): Notification;
// title "Kizuki doctor: <k> problem(s)"; one line per problem id (§9 problem grammar), then "check: kizuki doctor"
export function syncErrorNotification(
  job: string,
  receipt: RunReceipt,
  at: string,
): Notification;
// title "Kizuki sync error"; lines "job=<job>", "errors=<n> stored=<n>", "retry: kizuki sync"
```

- `telegram.ts`: `fetch(\`https://api.telegram.org/bot${token}/sendMessage\`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id, text: \`${title}\n${lines.join("\n")}\`, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000), redirect: "error" })`.
Plain text, no `parse_mode`. Status ≠ 200 → `ServeDaemonError("notifier",
  "telegram: http <status>")`; a thrown fetch → `"telegram: transport"`.
  The token appears only in the URL string inside this function; the error
  never carries the URL. Response bodies are ignored.
- `webhook.ts`: `body = JSON.stringify(notification)`; headers
  `content-type: application/json`, `user-agent: kizuki-serve`, and when
  `secret_ref` is set `x-kizuki-signature: sha256=<hex HMAC-SHA256(secret, body)>`
  (`new Bun.CryptoHasher("sha256", secret)`); `redirect: "error"`, timeout
  15 s; 2xx → ok, else `"webhook: http <status>"`. The URL is validated at
  config time; the notifier does not re-resolve it.
- `smtp.ts`: RFC 5321 minimum over `Bun.connect({ hostname, port, tls:
security === "tls", socket })` with a line reader (CRLF; a line over 4 096
  bytes or a reply without a 3-digit code → `"smtp: protocol"`; multi-line
  replies `250-…` collected until `250 `). Sequence: greeting 220 → `EHLO
kizuki.invalid` 250 → (`security = "starttls"`: `STARTTLS` 220 →
  `socket.upgradeTLS({ tls: { serverName: host }, socket })` → `EHLO` again)
  → (`username`: `AUTH PLAIN <base64(\0user\0pass)>` 235) → `MAIL FROM:<from>`
  250 → `RCPT TO:<to>` 250 each → `DATA` 354 → headers
  `From`, `To`, `Subject: <title>`, `Date` (RFC 5322 from `now`),
  `Message-ID: <<ulid>@kizuki.invalid>`, `MIME-Version: 1.0`,
  `Content-Type: text/plain; charset=utf-8`,
  `Content-Transfer-Encoding: 8bit`, blank line, lines with dot-stuffing,
  `\r\n.\r\n` 250 → `QUIT`. Any 4xx/5xx → `"smtp: <code>"`; socket error or
  30 s without a reply → `"smtp: transport"`. The password is resolved
  immediately before `AUTH` and dropped after; it is never part of an
  error, a receipt or a log line. `security = "none"` is accepted only
  because `parseServeConfig` already limited it to loopback hosts (tests).
- `dispatch.ts`:

```ts
export async function dispatch(
  db: Database,
  notifiers: Notifier[],
  notification: Notification,
  resolve: SecretResolver,
  runId: string,
  now: Date,
): Promise<{ sent: string[]; skipped: string[]; failed: string[] }>;
```

For every notifier whose `events` includes `notification.kind`: job id
`notify:<name>:<kind>`; when `latestReceipt(db, job)` is `ok` and its
`summary.digest === notification.digest` → `skipped` (no receipt written:
a repeated doctor report is not news, and a flapping rail must not spam);
else `startRun` → `send` → `finishRun({ status: "ok", summary: { digest,
lines: n } })` or `finishRun({ status: "error", error: "notifier" })` and
the message on stderr. Notifier failures never fail the job that raised
the notification. Sends run sequentially (one SMTP session at a time).

## 9. Standing loopback MCP endpoint

### 9.1 Core: `serve/http.ts` (the only `Bun.serve` in `packages/core/src/serve`)

```ts
export type LoopbackRequestHandler = (
  request: Request,
  principal: Principal,
) => Promise<Response>;
export interface LoopbackServer {
  port: number;
  url: string;
  requests(): number;
  stop(): Promise<void>;
}
export function startLoopbackServer(opts: {
  db: Database;
  port: number;
  handle: LoopbackRequestHandler;
  maxBodyBytes?: number; // default 1 MiB
}): LoopbackServer;
```

- `Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 30,
maxRequestBodySize, fetch })`; `EADDRINUSE` → `ServeDaemonError("port_in_use",
"port <n> is in use")`. IPv4 loopback only — `localhost` is never used as a
  bind name (it may resolve to `::1`), and no `unix` socket in 1.0.
- Request policy, in order: any `Origin` header → 403 (browsers send it;
  harnesses do not; this closes DNS-rebinding by construction); path not
  `/mcp` → 404; method not `POST` → 405 with `Allow: POST` (no SSE `GET`
  stream and no `DELETE` session in 1.0 — stateless JSON mode only);
  `Authorization` not `Bearer <token>` or `authenticate(db, token) === null`
  → 401 with `WWW-Authenticate: Bearer` and an empty body — one identical
  response for missing, malformed, unknown and revoked tokens (no oracle);
  otherwise `handle(request, principal)`. Every response carries
  `Cache-Control: no-store`. The server logs nothing per request; the
  serving gate already audits every tool call under the agent's id, and
  `requests()` feeds the heartbeat summary (`http_requests`).
- There is no owner path over HTTP: `OWNER` has no token by design; the
  owner's harness uses `kizuki mcp --owner` over stdio (cli-wave2 §6).
- Bearer tokens travel in cleartext on the loopback interface; that is the
  host-trust stance in `docs/architecture.md` ("Security"). State it in
  the README (§11.5).

### 9.2 `packages/mcp/src/http.ts`

```ts
export function createHttpHandler(opts: {
  db: Database;
  vaultPath: string;
}): LoopbackRequestHandler;
```

Per request: `ctx = { db, vaultPath, principal }`; `server =
createServer(ctx)` (serving-mcp §2.1); `transport = new
WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,
enableJsonResponse: true })` imported from
`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`; `await
server.connect(transport)`; `response = await transport.handleRequest(request)`;
`finally { await transport.close() }` (JSON mode resolves only once every
response is ready, verified above). A fresh server per request costs eight
`registerTool` calls and keeps the principal bound for exactly one request
— tokens are checked on every call, so a revoked agent loses access at its
next request, not at its next session.

`packages/mcp/AGENTS.md` (serving-mcp) says "no transport other than stdio;
no SDK entry point beyond the four listed". Amend both sentences: the
allowed entry points become five (`server/webStandardStreamableHttp.js`
added, product code only) and the transports become "stdio (`kizuki mcp`)
and the web-standard Streamable HTTP transport in stateless JSON mode,
mounted only by `kizuki serve` on 127.0.0.1". The serving-mcp acceptance
grep `sdk/server/webStandard` → no output is superseded; the replacement is
in this lane's Acceptance (`express`, `sse`, `streamableHttp.js` and
`server/auth` stay forbidden — `streamableHttp.js` is the one that imports
`@hono/node-server`).

## 10. The daemon — `daemon.ts`, `lock.ts`, `sweep.ts`, `health.ts`

### 10.1 Lock file — `<vault>/.kizuki/serve.lock`

```ts
export interface LockInfo {
  schema: "kizuki.serve-lock/v1";
  pid: number;
  boot_id: string;
  port: number | null;
  started_at: string;
}
export function readLock(controlDir: string): LockInfo | null; // null when absent; ServeDaemonError("locked", "lock file is unreadable") when present but not this schema
export function lockAlive(info: LockInfo): boolean; // process.kill(pid, 0): true; ESRCH → false; EPERM → true (a process exists that we may not signal)
export interface LockHandle {
  path: string;
  info: LockInfo;
  update(patch: Partial<Pick<LockInfo, "port">>): void;
  release(): void;
}
export function acquireLock(
  controlDir: string,
  info: Omit<LockInfo, "schema">,
): LockHandle;
// openSync(path, "wx", 0o600) + write + fsync. On EEXIST: readLock → lockAlive → throw
// ServeDaemonError("locked", `serve is already running (pid ${pid})`); dead → rmSync and retry once
// (a second EEXIST means another starter won the race → the same "locked" error).
// update(): write a sibling `.tmp` (0600) and renameSync over the lock. release(): remove only when the
// file still carries our boot_id (never delete a successor's lock).
```

### 10.2 `Daemon`

```ts
export interface DaemonDeps {
  db: Database; // ledger + staging + search + graph + agents + serve schemas initialized; PRAGMA busy_timeout set (§11.4)
  vaultPath: string;
  config: ServeConfig;
  connectors: ConnectorFactory;
  resolveSecret: SecretResolver; // the CLI's hostSecretResolver; core never resolves refs itself
  hooks?: RunHooks; // cli-wave2's indexEventsHook
  http?: LoopbackRequestHandler | null; // null = no endpoint (serve --no-http, and every test that does not need one)
  narrator?: BriefNarrator;
  now?: () => Date;
  zone?: TimeZone;
  log: (line: string) => void; // stderr in the CLI
  signals?: boolean; // default true; tests pass false
}
export interface DaemonInfo {
  boot_id: string;
  pid: number;
  port: number | null;
  started_at: string;
  interrupted: string[];
  schedules: number;
}
export interface TickResult {
  ran: { job: string; receipt: RunReceipt }[];
  skipped: { job: string; reason: "in_flight" }[];
  notified: number;
}
export class Daemon {
  constructor(deps: DaemonDeps);
  start(): Promise<DaemonInfo>; // idempotent-refusing: a second start() throws
  tick(now?: Date): Promise<TickResult>; // runs every due job serially, in dueJobs order
  runJob(job: string, now?: Date): Promise<RunReceipt>; // ignores the schedule; refuses unknown ids and in-flight jobs
  stop(): Promise<void>; // resolves when the HTTP server is closed, the running job settled or the grace period elapsed, and the lock is released
  info(): DaemonInfo | null;
}
export async function runOnce(deps: DaemonDeps): Promise<TickResult>; // start (no HTTP, no signals) → tick → stop; run_id "cli"
export async function runJobNow(
  deps: DaemonDeps,
  job: string,
): Promise<RunReceipt>; // start (no HTTP, no signals, no lock wait: uses run_id "cli" and refuses when a daemon lock is alive? No — see below) → runJob → stop
```

`runJobNow` and `runOnce` acquire the lock like the daemon does: two
schedulers on one vault would double-run jobs and race on checkpoints, so
`serve run`/`serve --once` while the daemon is alive is refused with the
`locked` message and the hint `stop the daemon or let it run the job`.

Start sequence:

1. `initServe(db)`; `boot_id = ulid()`; `acquireLock`.
2. `interrupted = markInterrupted(db, boot_id)`; for every interrupted job
   that still has an enabled schedule row, `next_run_at = now` (catch-up
   once; a brief killed mid-write is filed at the next tick).
3. `reconcileSchedules(db, config, listConnections(db), now, zone)`.
4. When `deps.http` is set: `startLoopbackServer({ db, port: config.port,
handle })`; `lock.update({ port })`. A `port_in_use` error releases the
   lock and propagates — the daemon does not start on a different port,
   because the harness config points at this one.
5. `signals` → `process.once("SIGTERM"|"SIGINT", () => void this.stop())`.
6. Log `serve started boot_id=<id> pid=<pid> port=<port|none> schedules=<n> interrupted=<k>`
   and arm the first tick with `setTimeout(tick_seconds * 1000)`; every tick
   re-arms itself (`setTimeout`, never `setInterval`: a slow tick must not
   pile up).

Tick:

1. `for job of dueJobs(db, now)`: `advance(db, job, now, zone)` FIRST (a
   job that crashes the process cannot tight-loop on restart), then if the
   job is in `inFlight` → `skipped` receipt `{ reason: "in_flight" }` and
   continue; else `startRun`, run the job's function with
   `Promise.race([run, timeout(JOB_TIMEOUT_MS[kind])])`; on settle
   `finishRun(ok|error)`; on timeout `finishRun({ status: "error", error:
"timeout" })` and leave the job in `inFlight` until the promise settles
   (its late outcome is logged, not recorded — the receipt is final).
2. Jobs run one at a time in `dueJobs` order: SQLite has one writer, the
   receipts stay readable, and a slow sync merely delays the brief.
3. After a `brief` with `outcome ∈ {stored}` → `dispatch(briefNotification)`;
   after a `sync:*` with `status = "error"` → `dispatch(syncErrorNotification)`
   (dedupe by digest keeps a persistently failing connector at one message
   until its counts change); after `doctor` with problems → `dispatch(doctorNotification)`.
4. The heartbeat job: `pruneReceipts`, `reconcileSchedules`, summary
   `{ schedules, http_requests, in_flight: inFlight.size }`.

Stop: cancel the pending tick timer; `http.stop()`; await the running job
up to `shutdown_grace_seconds` (its receipt stays `running` when the grace
elapses; the next boot marks it `interrupted` and catches up); `lock.release()`;
log `serve stopped boot_id=<id>`. The CLI closes the database.

### 10.3 In-daemon doctor sweep — `sweep.ts`

```ts
export interface SweepResult {
  problems: string[];
  summary: ReceiptSummary;
}
export async function runDoctorSweep(
  db: Database,
  vaultPath: string,
  connectors: ConnectorFactory,
  controlDir: string,
  now: Date,
  zone: TimeZone,
): Promise<SweepResult>;
```

Problem ids (stable strings, no paths, no messages): `rail_stale:<job>`
(from `serveStatus`, excluding `doctor` itself), `rail_error:<job>` (latest
receipt `error`), `interrupted:<job>` (latest receipt interrupted and not
yet rerun), `vault_invalid_pages:<n>` (`doctorVault(...).counts.invalid > 0`),
`connection_health:<connector_id>:<source_key>:<state>` (`health()` through
the factory, any state ≠ `ok`; a factory throw → `:unavailable`),
`connection_state_pending:<k>` (cli-wave2 §8's count of `*.journal|*.tmp|*.rollback`
under `.kizuki/connections/`). Summary `{ problems: n, invalid_pages, connections, stale_rails }`.
Receipt status is `ok` even with problems (the sweep worked); the problems
reach the owner through the notification and `doctor`.

### 10.4 `serveStatus` — `health.ts` (used by `doctor`, `serve status`, the sweep)

```ts
export type RailState =
  "ok" | "stale" | "error" | "never" | "disabled" | "down" | "interrupted";
export interface RailStatus {
  job: string;
  spec: string;
  enabled: boolean;
  state: RailState;
  last: RunReceipt | null;
  next_run_at: string;
  stale_after_seconds: number;
}
export interface DaemonState {
  state: "running" | "stopped" | "stale-lock";
  pid: number | null;
  port: number | null;
  boot_id: string | null;
  started_at: string | null;
}
export interface ServeStatus {
  daemon: DaemonState;
  heartbeat: RailStatus | null;
  rails: RailStatus[];
  problems: string[];
  ok: boolean;
}
export function serveStatus(
  db: Database,
  controlDir: string,
  now?: Date,
  zone?: TimeZone,
): ServeStatus;
```

Rules (invariant 9, exactly):

- `daemon.state`: no lock → `stopped`; lock + `lockAlive` → `running`;
  lock + dead → `stale-lock`.
- A rail's `state`, in order: `disabled` when `enabled = 0`; `never` when
  no receipt; `interrupted` when the latest receipt is interrupted;
  `error` when the latest receipt is `error`; then freshness: `now -
last.started_at > staleAfterMs(spec, last)` → `stale` when the daemon is
  `running`, `down` otherwise; else `ok`. `skipped` counts as a run (a
  `no_sync` connection is disabled by reconcile anyway).
- `heartbeat` is judged the same way; a `running` daemon with a stale
  heartbeat is the masked-timer case: `problems` gains `daemon_heartbeat_stale`.
- `problems`: `daemon_stale_lock`, `daemon_heartbeat_stale`, `rail_stale:<job>`,
  `rail_error:<job>`, `interrupted:<job>` — only while the daemon is
  `running` do `rail_stale` entries count (a stopped daemon's rails are
  `down`, reported, not failures: program-first means the daemon is
  optional). `ok = problems.length === 0`.

### 10.5 Log lines

`deps.log` receives one line per receipt and per lifecycle event:
`<RFC3339> <job> <status> <k=v ...>` where the `k=v` pairs are the
receipt summary; connector error strings and notifier failures are appended
on their own line `<RFC3339> <job> detail <message>` after `sanitize`-style
control stripping (copy the two-line `sanitize` loop from
`packages/tui/src/ansi.ts` into `serve/log.ts`? No — core must not depend on
tui; implement the control-character strip inline in `daemon.ts`, ten
lines, with a comment naming the tui function it mirrors). Never a token,
never a state file path, never captured text (connector messages may name
a source path; that is the owner's own stderr, not SQLite).

## 11. CLI — `packages/cli`

### 11.1 Grammar

```
kizuki serve [--once] [--port N] [--no-http] [--json]
kizuki serve status [--json]
kizuki serve stop [--timeout SECONDS]
kizuki serve run <job> [--json]
kizuki serve schedules [--json]
kizuki serve unit systemd|launchd
```

`serve` (no subverb) runs the daemon in the foreground until SIGTERM/SIGINT
(exit 0 after a clean stop). `--once`: `runOnce` — every due job once, then
exit 0 (exit 1 when any receipt is `error`); this is the cron-friendly mode
for owners who prefer their own timer. `--port` overrides `serve.port`;
`--no-http` disables the endpoint. `--json` prints one `DaemonInfo` line at
start (and, with `--once`, one `TickResult`). Human output: the start line,
then nothing on stdout — every receipt line goes to stderr (§10.5) so a
unit file's journal is the log.

`serve status`: `serveStatus`; prints

```
daemon <running pid=N port=P boot_id=… started_at=…|stopped|stale-lock pid=N>
heartbeat <state> last=<at|never> next=<at>
rail <job> spec="<spec>" <state> last=<at|never> next=<at>
problem <id>                              ← one per problem
```

exit 0 when `ok`, 1 otherwise (`stopped` with no problems is exit 0).
`--json` prints the `ServeStatus` document.

`serve stop [--timeout S]` (default 15): `readLock` → no lock → `serve is
not running`, exit 1; dead pid → remove the stale lock, print
`removed stale lock pid=N`, exit 0; alive → `process.kill(pid, "SIGTERM")`,
poll every 200 ms until the lock disappears or the timeout → exit 0 /
`serve did not stop within S s (pid N)` exit 1. Never SIGKILL.

`serve run <job>`: `runJobNow` (`sync:<connector_id>:<source_key>` accepts
the short connector form and resolves `<source_key>` through
`selectConnection` when the value is a path — cli-verbs §3). Prints the
receipt as `job=<job> status=<s> <k=v ...>`; `--json` the `RunReceipt`.
Exit 0 for `ok`/`skipped`, 1 for `error`, 2 for an unknown job id.

`serve schedules`: table `job spec enabled next_run_at`.

`serve unit systemd|launchd`: prints a unit/plist to stdout for the owner
to install (nothing is written; §9 "a generated unit is offered"). systemd:

```
[Unit]
Description=kizuki serve (<vault>)
After=network-online.target

[Service]
ExecStart=<exec> serve --vault <vault>
Restart=on-failure
RestartSec=5
# Secrets referenced by serve.toml (env:VAR) belong in a 0600 EnvironmentFile you create:
# EnvironmentFile=%h/.config/kizuki/serve.env
Environment=KIZUKI_CONFIG=<config path>

[Install]
WantedBy=default.target
```

where `<exec>` is `process.execPath` alone when running from a compiled
binary (`Bun.main === process.execPath`), else `process.execPath` + ` ` +
`process.argv[1]` (running from source). launchd: the equivalent plist
(`Label` `dev.kizuki.serve.<vault basename>`, `ProgramArguments`, `KeepAlive`
`{ SuccessfulExit: false }`, `RunAtLoad`, `EnvironmentVariables` with
`KIZUKI_CONFIG`, a comment about secrets). Paths are XML-escaped.

### 11.2 Composition (`commands/serve.ts`, `serve-config.ts`)

```ts
// serve-config.ts
export const SERVE_CONFIG_PATH = ".kizuki/serve.toml";
export function readServeConfig(vaultPath: string): ServeConfig; // absent → DEFAULT_SERVE_CONFIG; mode check; Bun.TOML.parse → parseServeConfig; ConfigError-style messages naming the file and key
```

`commands/serve.ts` builds `DaemonDeps` inside `withVault`: `connectors:
(c) => connectorFor(ctx, c)`, `resolveSecret: hostSecretResolver(ctx)`,
`hooks: indexEventsHook(ctx)`, `http: --no-http ? null : createHttpHandler({ db, vaultPath })`,
`log: io.err`, `zone: localZone()`. `ensureDerived(ctx)` runs before start
so the endpoint never serves an unbuilt index. No narrator is wired (§Open
questions). `packages/cli/package.json` already depends on `@kizuki/mcp`
after cli-wave2.

### 11.3 `doctor` additions (`commands/doctor.ts`)

After cli-wave2's `connection_state_pending=` line, print `serveStatus`:

```
serve daemon=<running pid=N port=P|stopped|stale-lock pid=N>
rail heartbeat <state> last=<at|never>
rail <job> spec="<spec>" <state> last=<at|never> next=<at>
problem serve: <id>                      ← one per ServeStatus.problems entry
```

`--json` gains `serve: ServeStatus`. Exit 1 when `serve.ok === false`
(stale lock; running daemon with a stale heartbeat or a stale/error rail).
A stopped daemon with `down` rails is informational (exit unaffected).

### 11.4 `context.ts`

`openVaultDb` executes `PRAGMA busy_timeout = 5000` right after `openLedger`
and calls `initServe(db)` after `initAgents(db)`. The daemon and the
owner's `kizuki review`/`promote`/`sync` share one WAL database; without a
busy timeout, the owner's promote would fail with `SQLITE_BUSY` the moment a
sync batch commits. `Daemon` asserts the pragma (`PRAGMA busy_timeout`
returns ≥ 1000) and throws `ServeDaemonError("config")` otherwise, so an
in-process caller cannot forget it.

### 11.5 README

Under "Try it": a "Keep it running (`kizuki serve`)" subsection — the
`serve.toml` example from §1 (secret refs only), `serve status`, `serve run
brief`, where the brief shows up (`kizuki review`), the MCP endpoint
registration snippet for a harness (`http://127.0.0.1:7411/mcp`, header
`Authorization: Bearer $KIZUKI_TOKEN_ADA`, "your MCP client", no harness
names), the sentence that notifications carry counts and ids only, and the
loopback/cleartext-token caveat. Update the zero-phone-home pledge to list
exactly which files may touch the network (the four allowlisted product
files) and why. Claim nothing that does not run; neutral names (`ada`,
`acme`).

## 12. Exports

`packages/core/src/serve/index.ts` re-exports: `DEFAULT_SERVE_CONFIG`,
`FIXED_JOBS`, `JOB_TIMEOUT_MS`, `MAX_BRIEF_EVENTS`, `NOTIFICATION_KINDS`,
`Daemon`, `ServeDaemonError`, `acquireLock`, `advance`, `briefWindow`,
`collectBrief`, `createNotifier`, `dispatch`, `dueJobs`, `fileBrief`,
`finishRun`, `initServe`, `jobKind`, `latestReceipt`, `listReceipts`,
`listSchedules`, `localZone`, `lockAlive`, `markInterrupted`, `nextRun`,
`parseSchedule`, `parseServeConfig`, `pruneReceipts`, `readLock`,
`reconcileSchedules`, `renderBrief`, `runDoctorSweep`, `runJobNow`,
`runOnce`, `runSyncJob`, `serveStatus`, `staleAfterMs`, `startLoopbackServer`,
`startRun`, `syncJobId`, `utcZone`, plus every interface/type above.
`packages/core/src/index.ts` re-exports all of it and `blockquoteCapture`
from staging is exported from `@kizuki/core/staging` (`staging/index.ts`).
Add the runtime names to the sorted list in
`packages/core/test/index.test.ts`. `packages/mcp/src/index.ts` adds
`createHttpHandler`.

## 13. Network allowlist and the zero-phone-home gate

`scripts/network-allowlist.txt` gains (ci-hardening format `<path>:<reason>`):

```
packages/core/src/serve/http.ts:standing loopback MCP endpoint: Bun.serve bound to 127.0.0.1 only; no outbound call (invariant 6)
packages/core/src/serve/notify/telegram.ts:owner-configured notifier egress: Telegram Bot API over fetch, count-only digests
packages/core/src/serve/notify/webhook.ts:owner-configured notifier egress: owner URL over fetch, count-only digests
packages/core/src/serve/notify/smtp.ts:owner-configured notifier egress: SMTP over Bun.connect with TLS/STARTTLS, count-only digests
packages/core/test/serve/fakes.ts:test double: Bun.serve/Bun.listen on 127.0.0.1 playing Telegram, a webhook receiver and an SMTP server
packages/core/test/serve/http.test.ts:test double: fetch against the loopback endpoint under test
packages/mcp/test/http.test.ts:test double: fetch against the loopback endpoint under test
packages/cli/test/serve.test.ts:test double: fetch against a spawned daemon on 127.0.0.1
```

ci-hardening §4 restricts entries to `packages/<pkg>/src/`. Relax that in
this lane (it is a one-line predicate in `applyAllowlist`): entries under
`packages/<pkg>/test/` are accepted when the reason starts with
`test double:`; the stale rule and the tracked-file rule stay. Every other
test in this lane uses `server.fetch(request)` (no socket), scripted
`NotifierDeps` or in-memory fakes. If oauth-core's tab-separated per-API
format is what landed instead, write the same eight entries in that format
(`Bun.serve` / `fetch` / `Bun.connect` per file) — the intent is identical.

`bun run verify` must pass end to end; the phone-home dependency grep is
unaffected because no package manifest changes.

## 14. Tests

Helpers `packages/core/test/serve/helpers.ts`: `serveDb()` (`openLedger(":memory:")`

- `initStaging` + `initSearch` + `initGraph` + `initAgents` + `initServe` +
  `PRAGMA busy_timeout = 5000`), `tempVault()` (the staging helper's shape),
  `fixedClock(start)` returning `{ now, advance(ms) }`, `FixtureConnector`
  (the `ingest.test.ts` shape, scripted batches), `scriptedNarrator`,
  `deps(overrides)` building `DaemonDeps` with `http: null`, `signals: false`,
  `zone: utcZone()`, `log` capturing lines. `fakes.ts` (allowlisted): a
  `Bun.serve` fake accepting `POST /bot<token>/sendMessage` and `POST /hook`
  recording bodies/headers, and a `Bun.listen` scripted SMTP server
  (`security: "none"`, `AUTH PLAIN` check, records the DATA payload).

`packages/core/test/serve/` (≥ 70 tests):

- `schedule.test.ts`: grammar accept/reject table (`every 0s`, `every 15x`,
  `daily 24:00`, `cron * * * *` (4 fields), `cron 60 * * * *`, names →
  `RangeError` naming the field); `nextRun` for `every`, `daily 07:00`
  across midnight and across a UTC-offset zone (`TZ=America/New_York` set
  in a spawned `bun -e` — Bun honors `TZ` at startup), `cron 0 9 * * 1-5`
  skipping a weekend, dom/dow OR semantics, the 366-day bound; `staleAfterMs`
  values (`every 15m` → 1 860 000; `daily` → 2 × 86 400 000 + 60 000).
- `receipts.test.ts`: start/finish round trip; `finishRun` twice refused;
  summary validator rejects a path, a message with spaces, a `kzk_` token,
  a 65-char string, accepts ULIDs and RFC3339; `markInterrupted` touches
  only foreign run ids; `latestReceipt` ordering; `pruneReceipts` keeps the
  newest per job and the 60-minute heartbeat window; `listReceipts` limit
  bound.
- `lock.test.ts`: acquire → EEXIST → alive → `locked`; dead pid → repaired
  and reacquired; `release` leaves a successor's lock alone; unreadable
  lock → `locked` error naming nothing but the code; mode 0600.
- `config.test.ts`: defaults; every rule in §1 (unknown key path in the
  message, duplicate names, plaintext `token = "123:abc"` refused because it
  is not a secret ref and the message does not echo it, `security = "none"`
  on a public host refused, `http:` webhook to `127.0.0.1` accepted and to
  `example.invalid` refused, `events` subset, ranges).
- `jobs.test.ts`: `jobKind` table; `reconcileSchedules` creates one
  `sync:*` per active connection, disables a disconnected one, respecs on
  config change, keeps `next_run_at` otherwise; first `brief` → `now` when
  no ok brief exists, `nextRun` afterwards; `dueJobs` order.
- `sync.test.ts`: three scripted batches drain through `runToCompletion`,
  receipt counts sum, checkpoint = last cursor, `onStored` hook fired per
  stored event (FTS row present without rebuild); a batch with an error →
  `status error`, `error = connector_errors`, checkpoint unchanged, the
  error text only in `log` lines and absent from `run_receipts` (raw SQL);
  `capabilities.sync = false` → `skipped` + schedule disabled on the next
  reconcile; factory throw → `connector`.
- `brief.test.ts`: window from the last ok brief; 24 h default; 7-day
  clamp with `truncated_since`; counts per connector/kind and tombstones;
  highlights exclude tombstoned records and cap at 20 newest; previews are
  blockquoted and control-stripped (an event text containing `\n---\nid: x`
  and `\x1b[2J` renders inert); `no_events` files nothing; `claim` when no
  page, `edit` when `dashboards/brief/<date>.md` exists (write it via
  `ownerPromote` of a first brief — the test promotes, not the daemon);
  duplicate on refile; suppressed after rejection; narrator text appended
  under `## Narrative (model)` with `producer: "llm"`; narrator throw →
  deterministic brief filed, `narrative: "skipped"`; 8 001-code-point
  narrative → skipped; `MAX_BRIEF_EVENTS` truncation flag; a brief promoted
  by the owner lands at `dashboards/brief/<date>.md` with `type: rollup`
  and `sources` = the highlight ids (end-to-end through core only).
- `notify/render.test.ts`: JSON of every notification for a fixture with a
  captured text sentinel, a vault path and a `kzk_` token in scope contains
  none of them; line and title bounds.
- `notify/telegram.test.ts` (fakes): request path holds the token and body
  the chat id + text; non-200 → `notifier` error whose message and
  `String(error)` exclude the token; transport failure → `telegram: transport`.
- `notify/webhook.test.ts` (fakes): signature verifies against the raw
  body; no header without a secret; redirect refused; 500 → error.
- `notify/smtp.test.ts` (fakes): full happy path recorded verbatim (EHLO,
  AUTH PLAIN base64 of `\0user\0pass`, MAIL FROM, RCPT TO ×2, DATA with
  dot-stuffed `..leading` line, QUIT); 535 on AUTH → `smtp: 535` and the
  password absent from the error; multi-line 250 greeting parsed; line
  overflow → `smtp: protocol`; no reply → `smtp: transport` (short timeout
  injected).
- `notify/dispatch.test.ts`: events filter; per-notifier receipts
  `notify:<name>:<kind>`; identical digest → skipped without a receipt;
  changed digest → sent; a throwing notifier yields `error` and the others
  still send; sequential order.
- `daemon.test.ts` (in-process, `http: null`, fixed clock): start writes
  the lock with `port: null` and a heartbeat receipt on the first tick;
  `tick` runs due jobs in order and advances `next_run_at` before running;
  a job whose promise never settles → `timeout` receipt, then `in_flight`
  skips until it settles; a `brief` stored → one `notify:*` receipt per
  subscribed fake notifier; a sync error → `sync_error` notification once
  until counts change; `stop` releases the lock and cancels the timer;
  restart with a `running` receipt left behind → `interrupted` + immediate
  catch-up run; `runOnce` uses `run_id = "cli"` and refuses while a live
  lock exists; `runJobNow("nope")` → `unknown_job`; a second `start()`
  throws; `busy_timeout` below 1000 → `config` error.
- `sweep.test.ts` / `health.test.ts`: the rail state table (each `RailState`
  reachable), `down` vs `stale` depending on the daemon state, heartbeat
  stale while running → `daemon_heartbeat_stale`, stale lock → `daemon_stale_lock`,
  a stopped daemon with `down` rails is `ok`; sweep problem ids for an
  invalid page, an interrupted job and a connection whose `health()` is
  `misconfigured`; sweep summary passes the validator.
- `http.test.ts` (allowlisted, real socket): binds 127.0.0.1 (fetch to
  `[::1]` refused); `GET /mcp` → 405; `/x` → 404; `Origin` → 403; no
  header / malformed / unknown / revoked → identical 401 bodies and
  headers; 1 MiB + 1 body → 413; `requests()` counts; `port_in_use` on a
  second bind; `stop()` refuses further connections.
- `invariants.test.ts` (extend `staging/invariants.test.ts` or add
  `serve/invariants.test.ts` with the same walker): no file under
  `packages/core/src/serve/` or `packages/mcp/src/` imports
  `vault/write`, `staging/promote` or `writePage`, and the only
  `writeFileSync`/`openSync(..., "w…")`/`renameSync` call sites under
  `serve/` are in `lock.ts` (the scheduled-write-to-canon-impossible lesson
  as a test, ARCHITECTURE §12); every `Bun.serve`/`fetch`/`Bun.connect`
  identifier under `packages/core/src/serve` is in the four allowlisted
  files.
- `redaction.test.ts`: run a full scripted day (sync with an error naming a
  path, brief with a sentinel in captured text, notifier failure with a
  token) and assert the raw `kizuki.db` bytes, every `RunReceipt` JSON and
  every `ServeDaemonError` message contain none of: the path, the sentinel,
  the token, `env:`/`file:` refs.

`packages/mcp/test/http.test.ts` (allowlisted; ≥ 8 tests): `tools/list`
over `POST /mcp` with a valid bearer returns the eight names; the
grant-ceiling proof over HTTP (a `personal` agent never receives a
`private` page; unlabeled absent for every principal); `propose` files a
proposal stamped `agent:<name>`; a revoked token gets 401 on its very next
request with no session teardown needed; `notifications/initialized` alone
→ 202; the response is `application/json` (no SSE); one audit row per tool
call; the error payload never contains `cause` or a path.

`packages/cli/test/serve.test.ts` (subprocess seam like `e2e.test.ts`;
`serve.toml` written 0600 with a fake webhook on 127.0.0.1): `serve --once`
on a vault with one markdown-folder connection → `sync:*`, `heartbeat`,
`brief`, `doctor` receipts, `events_stored`-equivalent counts in `serve
status --json`, the brief visible in `review --list --json` with title
`Daily brief <date>`; `serve run brief` twice → second is `duplicate`;
`serve` spawned in the background with `--port 0`-free fixed port from a
helper that picks a free port → `serve status` shows `running` and
`doctor` prints `serve daemon=running`; `tools/list` over HTTP with a token
from `agent add`; SIGTERM → exit 0, lock gone, `serve status` → `stopped`,
exit 0; kill -9 → `doctor` reports `stale-lock` exit 1, the next `serve
--once` repairs it and marks the interrupted job; a second `serve` while
the first runs → exit 1 `already running`; `serve stop` on a stopped daemon
→ exit 1; `serve unit systemd` output contains `ExecStart=` with the vault
path and no secret value; `serve.toml` with mode 0644 → exit 1 naming the
mode; a `[[notifiers]]` entry with a plaintext token → exit 1 naming
`notifiers[0].token_ref` and not the value; `help` lists `serve` (the
registry becomes twenty-one verbs: cli-wave2's twenty plus `serve`; extend
`help.test.ts`).

`packages/core/test/ingest.test.ts`: the four `runToCompletion` cases from
connector-telegram §7 if this lane adds the function.

## Non-goals

No embeddings refresh job (no embeddings on main), no rollups beyond the
brief, no web dashboard, no binding beyond 127.0.0.1, no TLS on the MCP
endpoint, no SSE streams / stateful MCP sessions / resumability / `DELETE`
(stateless JSON mode only), no owner principal over HTTP, no ntfy-specific
notifier (the webhook covers JSON receivers; ntfy's text body is an open
question), no inbound bot commands (notifiers are outbound-only), no SMTP
XOAUTH2/DKIM, no Windows support for the lock/signals path (documented as
unsupported; the CLI refuses `serve` on `win32` with one line), no `[llm]`
configuration or model endpoint (the `BriefNarrator` seam is the whole
contract; wiring it is the LLM producer lane's), no Composio / WhatsApp
Business (deferred by decision), no change to `kizuki.event/v1`,
`kizuki.proposal/v1`, `kizuki.connector/v1`, the ledger migrations or the
`connections` CHECK constraints, no per-connection sync cadence, no
`serve` subverbs beyond the six in §11.1.

Runtime dependencies: none added. `packages/mcp` uses one more entry point
of the SDK it already pins (`server/webStandardStreamableHttp.js`, whose
import graph is limited to the SDK's own `shared/` and `types` modules).
`bun.lock` is unchanged; `@kizuki/core` stays dependency-free.

## Acceptance

```
bun install --frozen-lockfile                                   # exit 0; bun.lock unchanged (git diff --stat -- bun.lock is empty)
bun run typecheck                                               # exit 0
bun test                                                        # green; ≥ 100 new tests across packages/core/test/serve, packages/mcp/test/http.test.ts, packages/cli/test/serve.test.ts
bun run verify                                                  # exit 0: full gate incl. network scan with the eight allowlisted entries, denylist on tracked text and commit messages
bun run scripts/verify-network.ts                               # "network source verification passed (8 allowlisted files)" (or the oauth-core wording with the same eight paths)
grep -c '' scripts/network-allowlist.txt | xargs test 8 -le      # at least the eight entries
grep -rn 'sdk/server/express\|sdk/server/sse\|sdk/server/streamableHttp\.js\|sdk/server/auth' packages/mcp/src   # no output
grep -rln 'webStandardStreamableHttp' packages/mcp/src          # exactly packages/mcp/src/http.ts
git diff --stat main..HEAD -- '*/package.json' bun.lock | cat    # empty
T=$(mktemp -d); export KIZUKI_CONFIG=$T/config.toml
bun packages/cli/src/main.ts init $T/vault                      # vault + default_vault
mkdir $T/notes && printf 'ada met grace at the acme library\n' > $T/notes/a.md
bun packages/cli/src/main.ts connect markdown-folder --source $T/notes            # connected … health=ok
bun packages/cli/src/main.ts serve status; echo $?              # daemon stopped; rail lines "never"; prints 0
bun packages/cli/src/main.ts serve --once; echo $?              # receipts for heartbeat, sync:kizuki.markdown-folder:<KEY>, brief, doctor on stderr; prints 0
bun packages/cli/src/main.ts serve status                       # daemon stopped; rail sync… down last=<at> (down: the daemon is not running); brief ok
bun packages/cli/src/main.ts review --list --json | grep -c '"Daily brief '     # 1
bun packages/cli/src/main.ts serve run brief                    # job=brief status=skipped outcome=duplicate … (identical body within the same window) or stored when new events arrived
bun packages/cli/src/main.ts doctor | grep -E '^serve daemon=stopped$'         # 1 line; exit code of doctor unaffected by a stopped daemon
bun packages/cli/src/main.ts agent add ada | sed -n 's/^token=//p' > $T/tok
(bun packages/cli/src/main.ts serve --port 7411 2>$T/serve.log &) ; sleep 2
bun packages/cli/src/main.ts serve status | head -1             # daemon running pid=… port=7411 …
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7411/mcp -H 'content-type: application/json' -d '{}'   # 401
curl -s -X POST http://127.0.0.1:7411/mcp -H "authorization: Bearer $(cat $T/tok)" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"acme","version":"0"}}}' | grep -c '"serverInfo"'   # 1
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:7411/mcp -H 'origin: http://evil.invalid' -H "authorization: Bearer $(cat $T/tok)" -d '{}'   # 403
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7411/mcp   # 405
bun packages/cli/src/main.ts serve --once; echo $?              # error: serve is already running (pid N); prints 1
bun packages/cli/src/main.ts serve stop; echo $?                # prints 0; lock file gone
test ! -e $T/vault/.kizuki/serve.lock && echo LOCK_RELEASED
grep -c ' brief ' $T/serve.log | xargs test 0 -le               # receipt lines went to stderr; stdout carried only the start line
bun packages/cli/src/main.ts serve unit systemd | grep -c '^ExecStart=.* serve --vault '   # 1
printf '[[notifiers]]\nname = "x"\nkind = "telegram"\ntoken_ref = "123:plaintext"\nchat_id = "1"\n' > $T/vault/.kizuki/serve.toml; chmod 600 $T/vault/.kizuki/serve.toml
bun packages/cli/src/main.ts serve --once 2>&1 | grep -c 'notifiers\[0\].token_ref'   # 1; and `… | grep -c plaintext` prints 0
rm $T/vault/.kizuki/serve.toml
strings $T/vault/.kizuki/kizuki.db | grep -c "$T/notes"           # 0 (no path in SQLite, receipts included)
git status --porcelain                                          # empty
```
