# Lane: ci-hardening — stranger-loop script, compiled binary, CI matrix, build-time app credentials

## Decision-log deltas (2026-09-02)

- The dependency on the verb set "`init import review --list --json promote
  query doctor export version`" is superseded. `review` / `promote` /
  `reject` are leftover implemented verbs, not the product gate (D9, D10),
  and the accepted set adds `audit`, `tell`, `undo`, `context`, `timeline`,
  `rebuild`, `models` and `serve` (RFC 0002 §2.5).
- The quickstart fixture steps that extract a `proposal_id` and run
  `promote "$ID" --sensitivity personal` are superseded twice over: by the
  receipted writer (D9) and by auto-labeled sensitivity, which is never
  supplied on the command line (D11, RFC 0002 §8). The fixture must drive the
  loop and assert a receipt, a diff and an undo.
- The zero-model claim the compile smoke asserts must be scoped: capture,
  ledger, search, timeline, context, audit and undo run with no model; canon
  writing requires one and `doctor` reports it as off when missing (D12).
- The denylist gate is unchanged and binding: it scans every tracked file and
  every reachable commit message. The retrieval engine's name may appear only
  in `README.md` and `docs/upstream-policy.md`, with the exact spelling and
  canonical URL the validator enforces (RFC 0002 §9.1, §18.4).

Scope: `scripts/` (extend `verify.sh` and `verify-network.ts`; NEW
`build.ts`, `quickstart.sh`, `network-allowlist.txt`), `.github/workflows/ci.yml`
(extend the existing `test` job; add jobs), root `package.json` scripts, NEW
`.bun-version`, NEW `packages/core/src/app-credentials.ts` (+ export + surface
test), two small `packages/cli` touches (doctor line, runtime opt-out), one
test extension in `packages/core/test/vault.test.ts`, README "Build a binary".
Read CONVENTIONS.md first, then in this order: `scripts/verify.sh`,
`scripts/verify-network.ts` + `scripts/verify-network.test.ts`,
`scripts/verify-policy.test.sh`, `.github/workflows/ci.yml`,
`packages/core/src/index.ts` + `packages/core/test/index.test.ts` (the public
surface is pinned by an exact sorted list — you will extend it),
`packages/core/test/vault.test.ts`, `packages/core/test/staging/invariants.test.ts`
(the source-scanning test shape you will copy for §3), and after cli-verbs
lands, `packages/cli/src/commands/` for the exact verb output you assert in §5.
Design source: `workspace/kizuki-plan/ARCHITECTURE.md` §1 (distribution =
`bun build --compile` single binary), §3.1 ("Sign-in, not setup": project-owned
app credentials are compiled in), §10 (gitignore-matches-doctrine test,
gitleaks in CI), §12 (CI list: typecheck, Linux/macOS matrix, gitleaks,
denylist, zero-phone-home assertion, compile smoke on all targets, fresh-clone
quickstart). `docs/architecture.md` invariants 6, 8, 10.

Depends on **cli-verbs** (verbs `init import review --list --json promote query
doctor export version`, `--json` rows, `KIZUKI_CONFIG`, version read from
`packages/cli/package.json`). Zero new runtime dependencies. The only third
party code this lane adds runs inside GitHub Actions (`actions/checkout`,
`oven-sh/setup-bun`, `actions/upload-artifact`, `gitleaks/gitleaks-action`).

## Already on main (do not redo; build on it)

- `scripts/verify.sh` = the full gate: `bun install --frozen-lockfile`,
  `bun run typecheck`, `bun test`, `bash scripts/verify-policy.test.sh`,
  `bun run scripts/verify-network.ts`, phone-home dependency grep over every
  tracked `package.json` (`dependency_re`), forbidden-identifier grep over
  tracked text, tracked paths and every reachable commit message (the regex
  stays split-quoted in the script; never spell it out anywhere), and the
  attribution spelling validator (`verify-attribution.ts`). `bun run verify`
  is wired. AGENTS.md already names `bun run verify` as the repository gate.
- `scripts/verify-network.ts` = an AST scanner (TypeScript compiler API, a
  devDependency) over every tracked `packages/**/*.{ts,tsx,js,jsx,mjs,cjs}`:
  static/dynamic imports, `require`, `process.getBuiltinModule` of the node
  network modules plus `axios`/`undici`; calls and constructions of `fetch`,
  `XMLHttpRequest`, `WebSocket`, `EventSource`, `Bun.serve`, `Bun.connect`,
  `Deno.*`, including bracket and `globalThis`/`window`/`self` forms. Unit
  tests in `scripts/verify-network.test.ts` (part of `bun test`; `tsconfig`
  includes `scripts/**/*.ts`, so scripts are typechecked).
- `.github/workflows/ci.yml`: one `test` job on `ubuntu-latest`, bun pinned
  inline to `1.3.10`, `bun run verify`, exact-head `git diff --check`.
- `packages/cli/package.json` already has `"bin": { "kizuki": "src/main.ts" }`.
  `.gitignore` already ignores `dist/`, `.env*`, `.kizuki/`.
- init-clobber refusal: `packages/core/test/vault.test.ts` "creates the canon
  layout and preserves every existing doctrine file" covers `CANON.md`,
  `SCHEMA.md`, `.gitignore`, `.kizuki/.gitignore`.
- Half of gitignore-matches-doctrine: "self-ignores the database directory in
  Git" (`git check-ignore .kizuki/x` → 0). The other half is §8.
- Verified 2026-09-02 on this tree: `bun install --frozen-lockfile`,
  `bun run typecheck`, `bun test` (515 pass / 41 files) and
  `scripts/verify-network.ts` are green under both bun 1.3.10 and 1.3.14;
  `bun build --compile packages/cli/src/main.ts` produces a working ~95 MB
  binary in 0.3 s (init/ingest/proposals ran against it); `--define` accepts a
  JSON object value at 1.3.10; `--no-compile-autoload-dotenv` exists at
  1.3.10; the compiled runtime's crash handler prints a report URL and asks
  the user to file an issue — it does not upload on its own.

## Dropped from the original spec (superseded by main)

- `scripts/check-no-network.sh` (grep). Superseded by the AST scanner. The
  stable entry point for other lanes is now `bun run verify:network` (§4);
  sibling specs that name `check-no-network.sh` mean that command, and
  `scripts/network-allowlist.txt` keeps the name and `path:reason` format they
  cite.
- The two "existing greps" the old spec asked the `gates` job to run are the
  `verify.sh` asserts above; no separate job. The dependency regex extension
  survives (§4).
- `no-network-in-source` as a separate bun test: `verify-network.test.ts`
  exists; §4 adds the tree-level assertion to it.
- `init-clobber-refusal`: done on main.

## Objective

Make CI the thing that proves the product: every gate in ARCHITECTURE.md §12
runs on every PR, on Linux and macOS; the product ships as one compiled
binary that a fresh machine can build and drive through the stranger loop
from a script with no network at all; and the project-owned app credentials
that the connector lanes need are compiled in at build time through one door,
with placeholders that refuse honestly.

## 1. Version pin — `.bun-version` (NEW)

One file at the repo root containing `1.3.10` and a trailing newline (the
version main's CI already proves). `ci.yml` reads it (`bun-version-file`);
`quickstart.sh` prints `bun=<running> pinned=<file>` and warns (does not fail)
when they differ. Bumping the pin is a one-line change to this file only.

## 2. `scripts/build.ts` (NEW) — the compiled binary

Invocation (call the script directly; `bun run <script> --target …` is eaten by
bun's own flag parser on 1.3.14 — observed):

```
bun scripts/build.ts                       # host target → dist/kizuki
bun scripts/build.ts --target bun-linux-x64 [--target …]   # → dist/kizuki-<target> each
bun scripts/build.ts --all-targets         # the four targets below
bun scripts/build.ts … --out-dir DIR       # default dist
```

Root `package.json` scripts (add): `"build": "bun scripts/build.ts"`,
`"build:all": "bun scripts/build.ts --all-targets"`,
`"quickstart": "bash scripts/quickstart.sh"`,
`"verify:network": "bun scripts/verify-network.ts"`.

```ts
export const COMPILE_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
] as const;
export type CompileTarget = (typeof COMPILE_TARGETS)[number];

export interface BuildInfo {
  schema: "kizuki.build-info/v1";
  version: string; // packages/cli/package.json "version"
  bun: string; // Bun.version of the builder
  commit: string | null; // git rev-parse HEAD, null outside a checkout
  built_at: string; // RFC3339
  targets: string[]; // "host" or the explicit targets
  embedded: Record<AppCredentialGroup, boolean>; // booleans only, never values
}

/** Pure: the exact argv passed to `bun build`, unit-testable without compiling. */
export function buildArgs(
  entry: string,
  outfile: string,
  target: CompileTarget | null,
  credentials: Partial<Record<AppCredentialName, string>>,
): string[];

/** Reads KIZUKI_<NAME> for every APP_CREDENTIAL_NAME; fails closed (throws) on a
 *  set-but-empty variable and on a partially set group. */
export function collectBuildCredentials(
  env: Record<string, string | undefined>,
): {
  credentials: Partial<Record<AppCredentialName, string>>;
  embedded: Record<AppCredentialGroup, boolean>;
};

export async function build(opts: {
  targets: CompileTarget[] | "host";
  outDir: string;
  env: Record<string, string | undefined>;
  bun?: string; // defaults to process.execPath
}): Promise<BuildInfo>;
```

`buildArgs` returns exactly:
`["build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", ...(target ? [`--target=${target}`] : []), ...(Object.keys(credentials).length ? ["--define", `KIZUKI_BUILD_CREDENTIALS=${JSON.stringify(credentials)}`] : []), entry, "--outfile", outfile]`
with `entry = packages/cli/src/main.ts`. Why the two `--no-compile-autoload-*`
flags: a compiled bun executable otherwise reads `.env` and `bunfig.toml` from
whatever directory it is started in — silent configuration from an untrusted
cwd (a stranger's `.env` could inject `KIZUKI_*`). `build()` spawns with
`Bun.spawnSync` (argv array, no shell — the JSON needs no quoting), fails on a
non-zero exit with bun's stderr, then writes `<outDir>/build-info.json`
(pretty JSON + newline). Nothing this script prints or writes ever contains a
credential value; on success it prints one line per target
`built <outfile> target=<t>` and one line
`embedded telegram=<bool> google=<bool> x=<bool> whoop=<bool>`. Cross-target
builds download that target's bun runtime from bun's GitHub releases (the only
network use, CI-only by practice; the host build needs none).

Requires `packages/cli/package.json` to carry `"version"` — cli-verbs adds
`"version": "0.1.0"` (the literal main prints today) and reads it for
`kizuki version`. `build()` throws `packages/cli/package.json has no version`
when it is absent; do not fall back to a literal.

## 3. `packages/core/src/app-credentials.ts` (NEW) — one door for compiled-in credentials

The owner decided: project-owned app credentials come from
`KIZUKI_TELEGRAM_API_ID`, `KIZUKI_TELEGRAM_API_HASH`, `KIZUKI_GOOGLE_CLIENT_ID`,
`KIZUKI_GOOGLE_CLIENT_SECRET`, `KIZUKI_X_CLIENT_ID`, `KIZUKI_WHOOP_CLIENT_ID`,
`KIZUKI_WHOOP_CLIENT_SECRET` at build time, with placeholders in source that
make sign-in refuse with an exact message. Connector lanes (telegram, google,
x, whoop) consume this module; they do not read env or defines themselves.

```ts
export const APP_CREDENTIAL_NAMES = [
  "TELEGRAM_API_ID",
  "TELEGRAM_API_HASH",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "X_CLIENT_ID",
  "WHOOP_CLIENT_ID",
  "WHOOP_CLIENT_SECRET",
] as const;
export type AppCredentialName = (typeof APP_CREDENTIAL_NAMES)[number];
export const APP_CREDENTIAL_GROUPS = {
  telegram: ["TELEGRAM_API_ID", "TELEGRAM_API_HASH"],
  google: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  x: ["X_CLIENT_ID"],
  whoop: ["WHOOP_CLIENT_ID", "WHOOP_CLIENT_SECRET"],
} as const satisfies Record<string, readonly AppCredentialName[]>;
export type AppCredentialGroup = keyof typeof APP_CREDENTIAL_GROUPS;
export type AppCredentialSource = "build" | "env" | "placeholder";
export interface AppCredential {
  name: AppCredentialName;
  value: string;
  source: AppCredentialSource;
}
export interface AppCredentialSet {
  group: AppCredentialGroup;
  source: AppCredentialSource; // "placeholder" unless EVERY member resolved
  values: Partial<Record<AppCredentialName, string>>; // {} when placeholder (fail closed)
}
export function appCredential(
  name: AppCredentialName,
  env?: Record<string, string | undefined>,
): AppCredential;
export function appCredentialGroup(
  group: AppCredentialGroup,
  env?: Record<string, string | undefined>,
): AppCredentialSet;
export function appCredentialSources(
  env?: Record<string, string | undefined>,
): Record<AppCredentialGroup, AppCredentialSource>;
export function appCredentialRefusal(group: AppCredentialGroup): string;
```

Resolution per name: the build-time define wins, else `env["KIZUKI_<NAME>"]`
when non-empty (developers running from source), else `""` with source
`placeholder`. The define is read through exactly this pattern, in this file
only:

```ts
declare const KIZUKI_BUILD_CREDENTIALS: Record<string, string> | undefined;
const built: Record<string, string> =
  typeof KIZUKI_BUILD_CREDENTIALS === "object" &&
  KIZUKI_BUILD_CREDENTIALS !== null
    ? KIZUKI_BUILD_CREDENTIALS
    : {};
```

(`typeof` on an undeclared identifier is safe; without `--define` the source
runs unchanged and everything is a placeholder. Verified at 1.3.10/1.3.14.)
A group's `source` is `build` only when every member came from the define,
`env` when every member resolved and at least one came from env, otherwise
`placeholder` with `values: {}` — a half-configured group is a placeholder.
`appCredentialRefusal("telegram")` returns exactly:

```
telegram: app credentials are not compiled into this build (KIZUKI_TELEGRAM_API_ID, KIZUKI_TELEGRAM_API_HASH); sign-in is refused. Set them when building (bun run build) or export them when running from source. See README: Build a binary.
```

(same shape for the other groups, variables in `APP_CREDENTIAL_GROUPS`
order). Export all of the above from `packages/core/src/index.ts` and add the
six runtime names (`APP_CREDENTIAL_GROUPS`, `APP_CREDENTIAL_NAMES`,
`appCredential`, `appCredentialGroup`, `appCredentialRefusal`,
`appCredentialSources`) to the sorted list in `packages/core/test/index.test.ts`.
Nothing in this module logs, throws with, or serializes a value.

## 4. Network gate: allowlist + tree assertion + dependency regex

`scripts/network-allowlist.txt` (NEW): one entry per line `<tracked path>:<reason>`;
`#` comments and blank lines ignored. Ships with comments only. Every entry
must be a tracked file under `packages/<pkg>/src/` with a non-empty reason;
an entry whose file produces zero findings is **stale** and fails the gate
(the list cannot rot into a fake exception). The OAuth helper and connector
`client.ts` files of later lanes are the intended entries (invariant 6:
user-configured connectors and the configured model endpoint only).

Extend `scripts/verify-network.ts` (keep `scanSourceText` and `NetworkFinding`
unchanged):

```ts
export interface AllowlistEntry {
  path: string;
  reason: string;
  line: number;
}
export function parseAllowlist(text: string): AllowlistEntry[]; // throws on a line without ':', an empty path/reason, or a duplicate path
export interface TreeScan {
  findings: NetworkFinding[]; // in files NOT allowlisted
  allowlisted: { entry: AllowlistEntry; findings: NetworkFinding[] }[];
  stale: AllowlistEntry[]; // allowlisted but untracked, outside packages/*/src, or zero findings
}
export function applyAllowlist(
  findings: NetworkFinding[],
  entries: AllowlistEntry[],
  trackedFiles: string[],
): TreeScan; // pure
export async function scanTrackedSources(opts?: {
  allowlistPath?: string;
}): Promise<TreeScan>;
```

`main()` fails (exit 1) on any `findings` or `stale`, printing each as
`file:line:col: reason` / `stale allowlist entry: <path> (<why>)`; on success
prints `allowlisted: <path> (<n> findings): <reason>` per entry and finally
`network source verification passed (<n> allowlisted files)`.
`verify.sh` keeps calling `bun run scripts/verify-network.ts` — no change
there beyond §4's regex.

`scripts/verify-network.test.ts` gains: `parseAllowlist` accepts/rejects per
the rules above; `applyAllowlist` separates findings, marks stale entries;
and a tree test — `await scanTrackedSources()` on this repo has
`findings: []` and `stale: []` — so a stray `fetch` fails `bun test`, not only
`bun run verify`.

`scripts/verify.sh` `dependency_re`: extend the alternation with
`@datadog|newrelic|@newrelic|bugsnag|@bugsnag|rollbar|analytics-node|@vercel/analytics|@opentelemetry|telemetry`
(keep the leading `"` anchor). `scripts/verify-policy.test.sh` gains one
case: a fixture `packages/x/package.json` containing
`"@datadog/browser-rum"` makes `assert_no_match "phone-home dependency" …`
fail, and a fixture without it passes.

## 5. `scripts/quickstart.sh` (NEW) — the stranger loop

bash, `set -euo pipefail`, no `jq`/`python`/`unzip`; needs bash ≥ 3.2 (macOS),
coreutils, `grep`, `sed`, `bun` on PATH, `git` optional. Header comment states
what the script proves. Grammar:

```
bash scripts/quickstart.sh [--isolate auto|require|skip] [--binary PATH] [--keep]
```

- `--isolate` (default `auto`): `auto` uses `unshare -rn` when
  `command -v unshare && unshare -rn true` succeeds, else skips;
  `require` fails with
  `network-isolation: required but unshare -rn is unavailable` (exit 1);
  `skip` never isolates. Whatever happened is stated at the end — never a
  silent skip.
- `--binary PATH`: skip phases 1–2 and drive the given binary.
- `--keep`: do not delete the work directory (path printed).

Phases:

0. Preflight: `WORK=$(mktemp -d)`; `trap` cleanup on EXIT unless `--keep`;
   print `bun=<bun --version> pinned=<cat .bun-version>` (warn on mismatch);
   print `commit=<git rev-parse HEAD>` or `commit=none`.
1. `bun install --frozen-lockfile` (the one step that may use the network).
2. `bun scripts/build.ts --out-dir "$WORK/dist"` → `BIN=$WORK/dist/kizuki`.
3. Isolation decision as above. Isolated mode re-execs the inner phase as
   `unshare -rn env -i PATH="$PATH" HOME="$WORK/home" TMPDIR="$WORK/tmp" LANG=C.UTF-8 TERM=dumb NO_COLOR=1 KIZUKI_CONFIG="$WORK/config.toml" XDG_CONFIG_HOME="$WORK/xdg" bash "$0" --inner "$WORK" "$BIN" </dev/null`
   (`env -i` proves no inherited variable is needed either; the same
   explicit environment is used when not isolated). `HOME`, `KIZUKI_CONFIG`
   and `XDG_CONFIG_HOME` all point into `$WORK`, so a stranger's real config
   is never touched.
4. Inner loop (every step prints `ok <step>` or `FAIL <step>: <detail>` with
   the captured stdout/stderr, exit 1). Notes are generated inline:
   `alpha.md` = `The quartz-heron phrase belongs to the promoted page.`,
   `beta.md` = `A basalt-otter phrase.`, `gamma.md` = `A copper-lantern phrase.`
   1. `"$BIN" version` equals the `version` in `packages/cli/package.json`
      (extract with `sed`; skip when no checkout).
   2. `"$BIN" init "$WORK/vault"` → exit 0, `$WORK/vault/CANON.md` and
      `$WORK/config.toml` exist (cli-verbs writes `default_vault`).
   3. `"$BIN" import markdown-folder --source "$WORK/notes"` → stdout
      contains `events_stored=3`.
   4. `"$BIN" query quartz-heron` before any promotion → exit 0 and stdout
      does NOT contain `quartz-heron` (unlabeled capture is never served —
      invariant 8 in the stranger's own hands; cli-verbs explains on stderr
      with `withheld=1 (no sensitivity label)`, which the script does not
      assert).
   5. `"$BIN" review --list --json` → exactly one line contains
      `quartz-heron`; that line is one `StagedProposal` (cli-verbs), so
      `ID=$(printf '%s\n' "$line" | sed -n 's/.*"proposal_id":"\(01[0-9A-HJKMNPQRSTVWXYZ]\{24\}\)".*/\1/p')`
      — key-addressed, because `provenance` on the same line also carries
      ULIDs (event ids); assert `ID` is non-empty.
   6. `"$BIN" promote "$ID"` (no sensitivity) → non-zero exit, no
      `$WORK/vault/captures/` directory yet; then
      `"$BIN" promote "$ID" --sensitivity personal` → `page_path=` line, the
      file exists and contains `sensitivity: "personal"`.
   7. `"$BIN" query quartz-heron` → exit 0, stdout contains `quartz-heron`
      (cli-verbs prints `page <doc_id> <path> <sensitivity> <snippet>`; assert
      the phrase, not the prefix — a later serving lane renames it and must
      keep this script green).
   8. `"$BIN" doctor` → exit 0; stdout contains a line matching
      `^app_credentials telegram=placeholder google=placeholder x=placeholder whoop=placeholder$`
      (§7; the build in phase 2 never embeds — `env -i` and no `KIZUKI_*`).
   9. `"$BIN" export --out "$WORK/export"` → `$WORK/export/manifest.json`
      exists and `grep -rF quartz-heron "$WORK/export/vault"` hits.
      Nothing is run through a TTY; `review` is only ever called with `--list`.
5. Summary, last three lines, in this order:
   `binary=<path> size=<bytes>`,
   `network-isolation: unshare -rn` or `network-isolation: skipped (<reason>)`,
   `QUICKSTART_OK elapsed=<seconds>s`.

## 6. `.github/workflows/ci.yml` — extend

Keep the job id `test` (status-check names stay valid), matrix it, add three
jobs, add concurrency. Pin every action to a full commit SHA with the tag in
a trailing comment (record the check date in the commit body).

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest] }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha> # v4
        with: { fetch-depth: 0 }      # verify.sh scans every reachable commit message
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - run: bun run verify
      - name: exact-head diff integrity
        run: |
          git fetch --no-tags origin main
          git diff --check FETCH_HEAD...HEAD
  compile:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - run: bun install --frozen-lockfile
      - run: bun scripts/build.ts --all-targets
      - name: smoke the host binary
        run: |
          expected="$(bun -e 'console.log((await Bun.file("packages/cli/package.json").json()).version)')"
          actual="$(dist/kizuki-bun-linux-x64 version)"
          test "$actual" = "$expected"
          dist/kizuki-bun-linux-x64 help >/dev/null
          bun -e 'const i = await Bun.file("dist/build-info.json").json(); if (Object.values(i.embedded).some(Boolean)) { console.error("credentials embedded in a CI build"); process.exit(1); }'
      - uses: actions/upload-artifact@<sha> # v4
        with: { name: kizuki-${{ github.sha }}, path: dist/, retention-days: 3 }
  quickstart:
    strategy:
      fail-fast: false
      matrix: { os: [ubuntu-latest, macos-latest] }
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - run: bash scripts/quickstart.sh --isolate ${{ runner.os == 'Linux' && 'require' || 'skip' }}
  gitleaks:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha> # v4
        with: { fetch-depth: 0 }
      - uses: gitleaks/gitleaks-action@<sha> # v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_ENABLE_COMMENTS: "false"
```

Notes: no secrets are configured for these jobs, so `compile` always
produces placeholder binaries and asserts it; a release workflow that embeds
credentials is a non-goal here. If `unshare -rn` is refused on the Ubuntu
runner, the documented fix is a preceding step
`sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` — do not
downgrade `require` to `auto`. `gitleaks-action` needs no license for a
user-owned repository; add `.gitleaks.toml` only if a false positive appears
(none expected: fixtures are synthetic). A macOS-only failure in the matrix is
fixed in the test or script, never by dropping macOS.

## 7. CLI touches (`packages/cli`)

- `doctor` (cli-verbs `commands/doctor.ts`) prints, directly after its
  `vault=<abs>` line and before `events=`, one line
  `app_credentials telegram=<s> google=<s> x=<s> whoop=<s>` where `<s>` is the
  `AppCredentialSource` from `appCredentialSources()`. With `--json`
  (cli-verbs prints ONE document) the document gains the key
  `app_credentials: { telegram, google, x, whoop }` with the same strings.
  Never a value; never affects the exit code or `ok`. This is the
  human-visible receipt that a given binary can or cannot sign in.
- `packages/cli/src/main.ts`, first statement after imports:
  `process.env["DO_NOT_TRACK"] ??= "1";` with a one-line comment: the
  runtime's documented opt-out for any reporting it may add; today its crash
  handler only prints a URL (verified), the guard costs nothing.
- `packages/cli/package.json`: `"version"` present (§2).

## 8. Lessons-as-tests (ARCHITECTURE.md §12)

- gitignore-matches-doctrine, second half: extend "self-ignores the database
  directory in Git" in `packages/core/test/vault.test.ts` — after `initVault`
  in a `git init` repo, `writePage(join(vault, "entities", "ada.md"), …)` and
  assert `git check-ignore entities/ada.md` exits 1 and
  `git status --porcelain` lists `entities/` (or the file) and nothing under
  `.kizuki/`.
- One door for compiled-in credentials: `packages/core/test/app-credentials.test.ts`
  scans every `packages/*/src/**/*.ts` (same walker as
  `staging/invariants.test.ts`) and asserts the identifier
  `KIZUKI_BUILD_CREDENTIALS` appears in `core/src/app-credentials.ts` only.

## 9. README

Add a "Build a binary" subsection under "Try it" (cli-verbs owns "Try it"):
`bun run build` → `dist/kizuki`; `bun scripts/build.ts --all-targets`; the
seven `KIZUKI_*` build variables, that unset means placeholder and
`kizuki doctor` shows which; `bun run quickstart` and what its last lines
mean. Update the "Zero phone-home" pledge with one sentence: the compiled
binary makes no update check and the quickstart drives it inside a network
namespace on Linux (`network-isolation: unshare -rn`). Replace "Nothing here
is installable yet." with "No packaged releases yet; build a single-file
binary from source (below)." Claim nothing else.

## Tests

Must exist and pass under `bun test`:

- `scripts/build.test.ts` (NEW): `buildArgs` yields the exact argv above with
  and without target/credentials; `collectBuildCredentials` — nothing set →
  all placeholders; a complete group → embedded true; set-but-empty variable
  → throws naming the variable; partial group → throws naming the missing
  variable; the returned object never contains a value for an unset name.
  One real build: `build({ targets: "host", outDir: <tmp>, env: {} })` →
  binary runs `version` = package version; `build-info.json` parses, schema
  `kizuki.build-info/v1`, every `embedded` false; temp dir removed after.
- `packages/core/test/app-credentials.test.ts` (NEW): placeholder when
  nothing is set; `env` source; empty env value = placeholder; partial group
  = placeholder with `values: {}`; refusal text exact for `telegram` and `x`;
  build source — write a fixture entry in a temp dir that imports
  `packages/core/src/app-credentials.ts` by absolute path and prints
  `JSON.stringify(appCredentialGroup("telegram"))`, run
  `bun build --define KIZUKI_BUILD_CREDENTIALS=<json> <entry> --outfile <tmp>/out.js`
  via `Bun.spawnSync`, execute with `process.execPath`, assert
  `source: "build"` and the values; the same fixture with env set and no
  define → `env`; with both → `build` wins; the one-door scan (§8).
- `scripts/verify-network.test.ts` (extend): §4 cases plus the tree test.
- `packages/core/test/index.test.ts`: sorted list extended (§3).
- `packages/core/test/vault.test.ts`: §8 extension.
- `packages/cli/test/doctor.test.ts` (cli-verbs; extend): `doctor` prints
  the `app_credentials` line and `doctor --json` carries `app_credentials`
  with all four `placeholder` when the spawned env has no `KIZUKI_*`
  variables (cli-verbs' `runCli(env, …)` helper takes the env explicitly);
  with `KIZUKI_X_CLIENT_ID=synthetic` in that env, `x=env` and the string
  `synthetic` appears nowhere in stdout or stderr. `version` equals the
  package version (add the case to `help.test.ts` if cli-verbs has none).
- `scripts/verify-policy.test.sh`: the dependency-regex case (§4).

## Non-goals

Tag-triggered release workflow (GO/NO-GO), GitHub Releases, Homebrew tap,
npm publish, install script, Windows target, code signing/notarization,
SECURITY.md, `kizuki serve`, any connector sign-in (their lanes consume §3),
Docker images, benchmarks, coverage tooling. No new runtime dependency
anywhere; `@kizuki/core` stays dependency-free (`app-credentials.ts` uses
nothing but the language).

## Acceptance

```
cat .bun-version                                    # 1.3.10
bun run typecheck && bun test                       # green; ≥ 530 tests (515 on main today)
bun run verify                                      # exit 0 (full gate incl. new policy case)
bun run verify:network                              # "network source verification passed (0 allowlisted files)"
printf '%s\n' 'packages/core/src/index.ts:not really' > /tmp/al.txt && bun -e 'const m = await import("./scripts/verify-network.ts"); const s = await m.scanTrackedSources({ allowlistPath: "/tmp/al.txt" }); process.exit(s.stale.length === 1 ? 0 : 1)'   # exit 0 (stale entry detected)
bun run build && dist/kizuki version                # equals "version" in packages/cli/package.json
cat dist/build-info.json                            # schema kizuki.build-info/v1; embedded all false
strings dist/kizuki | grep -c 'KIZUKI_BUILD_CREDENTIALS='   # 0 (nothing defined in a plain build)
KIZUKI_TELEGRAM_API_ID=1 bun scripts/build.ts --out-dir /tmp/kz-partial; echo $?   # non-zero; message names KIZUKI_TELEGRAM_API_HASH
export KIZUKI_CONFIG=/tmp/kz-acc/config.toml; mkdir -p /tmp/kz-acc   # keep the developer's real config out of every line below
KIZUKI_TELEGRAM_API_ID=1 KIZUKI_TELEGRAM_API_HASH=h bun scripts/build.ts --out-dir /tmp/kz-tg   # prints "embedded telegram=true google=false x=false whoop=false"
/tmp/kz-tg/kizuki init /tmp/kz-acc/v >/dev/null && /tmp/kz-tg/kizuki doctor --vault /tmp/kz-acc/v | grep '^app_credentials telegram=build google=placeholder x=placeholder whoop=placeholder$'
strings /tmp/kz-tg/kizuki | grep -c '"TELEGRAM_API_HASH":"h"'   # 1 (embedding is real; such a binary is never committed or uploaded)
dist/kizuki doctor --vault /tmp/kz-acc/v | grep '^app_credentials telegram=placeholder google=placeholder x=placeholder whoop=placeholder$'
KIZUKI_X_CLIENT_ID=synthetic dist/kizuki doctor --vault /tmp/kz-acc/v | grep -c 'x=env'   # 1; and `… | grep -c synthetic` prints 0
bash scripts/quickstart.sh                          # last line QUICKSTART_OK …; line before names the isolation mode
bash scripts/quickstart.sh --isolate require        # exit 0 on a Linux box with user namespaces; on this dev box (no userns) exit 1 with the exact "required but unshare -rn is unavailable" line
bash scripts/quickstart.sh --binary dist/kizuki --isolate skip   # QUICKSTART_OK without rebuilding
python3 -c 'import yaml; yaml.safe_load(open(".github/workflows/ci.yml"))' 2>/dev/null || bun -e 'console.log(Bun.YAML ? "yaml ok" : "no parser: read ci.yml by hand")'
grep -c 'uses: .*@[0-9a-f]\{40\}' .github/workflows/ci.yml   # ≥ 9 (every action SHA-pinned)
git status --porcelain                              # empty (dist/, /tmp outputs untracked or ignored)
```
