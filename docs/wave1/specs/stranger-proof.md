> **VOID as written, 2026-09-02.** The proof path treats `review` / `promote`
> as the owner gate. Reissue against `rfcs/0002-autonomous-canon.md`.

# Lane: stranger-proof — the Wave 5 exit proof as code: fresh-machine run, recorded demo, GO/NO-GO

## Decision-log deltas (2026-09-02)

VOID as written per `docs/CURRENT.md`; RFC 0002 §18 lanes replace this spec.
The proof itself is not cancelled: C1 keeps the stranger proof and the estate
cutover as the 1.0 finish line, and RFC 0002 §1.3 restates it. What is void is
the path the proof drives.

Superseded sentences, and the semantics an implementer must follow instead:

- §1, "drives `init → import → review --list → promote → query`", and the
  step list `review-list`, `promote-refused`, `promote`, `promote-private`.
  `review` / `promote` / `reject` are leftover implemented verbs, not the
  owner path (D10). The stranger loop is `init → connect → capture → the loop
  writes canon → query → tell → audit → undo`, with the accepted verb set
  `audit`, `tell`, `undo`, `context`, `timeline`, `rebuild`, `models`,
  `serve` (RFC 0002 §2.5).
- §1, "Nothing here writes canon (invariant 3: `promote` is invoked by the
  script exactly as the owner would type it)". Invariant 3 is replaced
  (RFC 0002 §2.1). The proof must show canon being written autonomously, and
  must show the receipt and the undo that make that safe (D9).
- §1, "Recording the TUI (`kizuki review` needs a TTY)". The TUI is the audit
  and undo surface; what the recording shows is a receipt list, a diff, and
  `u` to undo (D10, RFC 0002 §7.3).
- Any GO gate that asserts a zero-model end-to-end run through canon. The
  model-free floor covers capture, ledger, search, timeline, context, audit
  and undo; canon writing requires a configured model, and the gate must
  assert `doctor` says so when none is present (D12).
- `init` in the proof now installs the daemon, so the fresh-machine script
  must account for a user service being created and must still pass with the
  daemon stopped (D15, RFC 0002 §2.1).

What survives: scripts-only scope with zero new runtime dependencies; the
fresh-machine sandbox with no network and no bun; the recorded demo; the
`GO`/`NO-GO` script printing every 1.0 gate with its evidence; the
under-15-minutes bar for a non-author with zero help; and the rule that the
release is never green-over-red.

Scope: `scripts/` only, plus `docs/`, one job appended to
`.github/workflows/ci.yml`, four root `package.json` scripts and one README
subsection. NEW files: `scripts/stranger-proof.sh`, `scripts/stranger/loop.sh`,
`scripts/stranger/mcp-client.ts`, `scripts/stranger/record.ts`,
`scripts/stranger/image.txt`, `scripts/go-no-go.ts`, their tests,
`docs/stranger-proof.md`, `docs/demo/stranger-loop.cast`. No package under
`packages/` is touched; `@kizuki/core` stays dependency-free; zero new
runtime dependencies anywhere.

Read CONVENTIONS.md first, then `AGENTS.md` (root), `docs/architecture.md`
(invariants 3, 5, 6, 8, 10; "Serving"), `rfcs/0001-deep-model-arbitration.md`
("Taint separation"), the fuller design in
`workspace/kizuki-plan/ARCHITECTURE.md` §1 (distribution = one compiled
binary), §8.1–§8.3 (agents, MCP, CLI query surface), §11 (verb set), §12
("fresh-clone quickstart script"; "Releases: tag-triggered GO/NO-GO script
only; never manual, never green-over-red") and
`workspace/kizuki-plan/ROADMAP.md` "Wave 5" (exit proof: demo loop recorded
end-to-end; a non-author on a fresh machine reaches promoted canon and an
agent query in ≤ 15 minutes with zero help). Then the skills
`.agents/skills/release-readiness/SKILL.md`,
`.agents/skills/cli-terminal-ux/SKILL.md`,
`.agents/skills/dependency-evaluation/SKILL.md`,
`.agents/skills/security-privacy-review/SKILL.md`. Then the code you drive:
`scripts/verify.sh`, `scripts/verify-network.ts`, `.github/workflows/ci.yml`,
`packages/core/src/index.ts`, `packages/core/src/agents/` (`TOOLS`, `OWNER`,
token shape in `identity.ts`), `packages/connectors/src/markdown-folder/index.ts`
(what `import` produces), `packages/core/src/vault/init.ts` (what `init`
creates), and on the branch you start from: the cli-verbs command modules,
cli-wave2's `agent`/`mcp` verbs, serving-mcp's envelope and `packages/mcp`,
ci-hardening's `scripts/build.ts` and `scripts/quickstart.sh`, and the
packaging-release artifact layout (§1 below states the contract this lane
consumes; verify it against that lane's spec before writing a line).

Reconciled against `main` at `76930db` (2026-09-01; 515 tests / 41 files;
bun 1.3.14 locally, CI pins 1.3.10). Verified on this box on 2026-09-02:

- `bun build --compile packages/cli/src/main.ts` (with
  `--no-compile-autoload-dotenv --no-compile-autoload-bunfig`) produces a
  ~95 MB self-contained binary; copied into a
  `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`
  container started with `--network none --read-only --tmpfs /tmp
--cap-drop ALL --security-opt no-new-privileges --user <uid>:<gid>` and a
  fresh `HOME` under the bind mount, it installs into `$HOME/.local/bin`,
  runs `version`, `init`, ingest and `doctor` in under two seconds. The
  image ships `bash 5.2`, GNU `tar`, `gzip`, `sha256sum`, `sed`, `grep`,
  `timeout`, `date` — everything §3 uses.
- Inside that container (and inside `bwrap --unshare-net`) `/proc/net/route`
  has no rows and `bash -c 'exec 3<>/dev/tcp/192.0.2.1/9'` fails at once
  with `Network is unreachable`; on the host the same probe hangs until
  `timeout` kills it (exit 124). `/sys/class/net` is NOT a usable observable
  under bwrap (it shows the host's sysfs) — §3 step `isolation` uses the
  route table and the probe only.
- `unshare -rn` is refused here (`kernel.apparmor_restrict_unprivileged_userns=1`;
  `unshare: write failed /proc/self/uid_map: Operation not permitted`);
  `bwrap` (bubblewrap) and `docker` both work. GitHub's `ubuntu-latest`
  runners have docker; macOS runners have neither docker nor user
  namespaces, so the CI job in §7 is Linux-only.
- `asciinema` is not an npm package (E404) and is not installed here;
  util-linux `script` output is not portable. §5 writes asciicast v2 with
  its own ~40-line serializer; playback needs any asciicast player, never a
  build dependency.

Depends on **packaging-release** (the release artifact, §1), **cli-wave2**
(`agent add`, `agent audit`, `mcp --agent … --token env:VAR`, `query`
served through the gate), **serving-mcp** (`packages/mcp`, the envelope,
the eight tool names), **ci-hardening** (`scripts/build.ts` `build()` for the
test fixture, `scripts/quickstart.sh` for one GO gate, `.bun-version`, the
`app_credentials` doctor line, SHA-pinned actions in `ci.yml`) and
**cli-verbs** (`init import review --list --json promote query doctor export
version`, config under `$HOME/.config/kizuki/config.toml`). None of their
symbols is on main today; every one is marked NEW below.

## Objective

Turn the Wave 5 exit criterion into three commands anyone can run and one
artifact anyone can watch:

1. `bash scripts/stranger-proof.sh --artifact <release tarball>` — a
   fresh-machine run: a network-isolated sandbox that holds nothing but the
   release artifact and a stand-in MCP client, installs the binary the way a
   stranger would, then drives `init → import → review --list → promote →
query → agent add → mcp` (a real `tools/call` over stdio) plus the
   grant-ceiling check, and asserts the whole thing took under 15 minutes of
   wall clock. Last line `STRANGER_PROOF_OK …` or a `FAIL <step>: …`.
2. `bun scripts/stranger/record.ts …` — records that run as an asciicast v2
   file checked in at `docs/demo/stranger-loop.cast`, redacted, checkable.
3. `bun scripts/go-no-go.ts …` — prints every 1.0 gate as `PASS`/`FAIL` with
   a receipt and a single verdict line; exit 0 only on `GO`. This is the
   script the tag-triggered release workflow (packaging-release) calls;
   nothing in it is a guess or a badge.

Every assertion is on observable output of the public CLI seam; nothing
here opens the database, reads the vault or imports product code (the
sandbox has no bun at all). Nothing here writes canon (invariant 3: `promote`
is invoked by the script exactly as the owner would type it), nothing phones
home (the sandbox has no route), and nothing prints a secret (the one token
`agent add` mints is redacted before it reaches a transcript).

## Non-goals

The release workflow YAML, GitHub Releases, Homebrew tap, npm publish and
`install.sh` (packaging-release). `SECURITY.md` (security-docs; §6 gates on
its presence and nothing more). Recording the TUI (`kizuki review` needs a
PTY; the proof and the demo use the documented non-interactive path).
Windows. macOS sandboxing (no isolation backend exists there; macOS hosts
use docker). Any new connector, verb, table or core API. Benchmarks beyond
the 15-minute bound. Measuring a human: the bound is asserted on the
machine loop; the human-paced claim is documented, not automated.

## Runtime dependencies

None. External tools, all optional and all detected at run time: `docker`
(preferred backend; the only one that gives a fresh filesystem), `unshare`
(util-linux), `bwrap` (bubblewrap). The sandbox side uses bash ≥ 4 and
coreutils only. The compiled MCP client is built with the pinned bun and
copied in; it is test tooling, not product.

## 1. The release artifact this lane consumes (packaging-release, NEW)

The proof takes one path, `--artifact PATH`, and requires:

- `PATH` is a `.tar.gz`. Extracted, it contains an executable named
  `kizuki` (at the top level or under `bin/`; the first match of
  `find . -type f -name kizuki -perm -u+x` wins). Other files (`LICENSE`,
  `README.md`, …) are ignored.
- A file `SHA256SUMS` next to it (same directory) with one
  `<64 hex>  <basename>` line per tarball. The line for `PATH`'s basename
  must exist and match; anything else is `FAIL install: sha256 mismatch`.
- `kizuki version` printed by the extracted binary equals the `version`
  field of `packages/cli/package.json` when a checkout is present
  (cli-verbs reads it from there; never a literal).

Discovery when `--artifact` is absent: exactly one file matching
`dist/release/kizuki-*-linux-<arch>.tar.gz` (`<arch>` from §2.2), else exit
1 with `stranger-proof: no release artifact; pass --artifact PATH or run:
bun run package`. `bun run package` is packaging-release's script; if that
lane names it differently, change this one string and the CI step in §7 and
say so in the handoff (open question in the result).

Tests never depend on packaging-release: `scripts/stranger/test-helpers.ts`
builds a fixture artifact from `build({ targets: "host", outDir, env: {} })`
(`scripts/build.ts`, ci-hardening, NEW) and writes the tarball plus
`SHA256SUMS` itself. That is a fixture of the contract above, not a second
packager; it lives under `scripts/stranger/` and is imported by tests only.

## 2. `scripts/stranger-proof.sh` (NEW) — host orchestration

bash, `set -euo pipefail`; needs bash ≥ 3.2 (macOS), coreutils, `tar`,
`gzip`, `grep`, `sed`, `bun` on PATH (to compile the client), `git`
optional. Never `set -x`. Header comment states what the script proves and
what it does not (see `docs/stranger-proof.md`).

```
bash scripts/stranger-proof.sh [--artifact PATH] [--isolate auto|docker|unshare|bwrap|skip]
                               [--work DIR] [--report DIR] [--pace SECONDS] [--keep] [--budget SECONDS]
```

- `--isolate` default `auto`: try `docker`, then `unshare`, then `bwrap`;
  the first available backend wins. A backend is available when:
  `docker` → `docker info` exits 0 in ≤ 20 s; `unshare` →
  `unshare -rn true` exits 0; `bwrap` → `bwrap --unshare-net --ro-bind / /
--dev /dev --proc /proc true` exits 0. `auto` with nothing available exits
  3: `network-isolation: no backend available (docker, unshare -rn, bwrap
all unavailable); pass --isolate skip to run the loop without a proof`.
  A named backend that is unavailable exits 3 with
  `network-isolation: <backend> is unavailable (<one-line reason>)` — for
  `unshare` on this box the reason is the `uid_map` line from `unshare`.
  `skip` runs the loop on the host with a fresh environment and no network
  isolation; it is never chosen implicitly.
- `--work DIR` default `mktemp -d`; removed on exit unless `--keep` (path
  printed). `--report DIR` default `dist/stranger-proof` (gitignored via
  `dist/`), holds `transcript.txt` (everything the loop printed, already
  redacted) and `summary.json` (§2.4). `--pace` default `0`; the recorder
  passes `0.6` so the cast reads at a human pace. `--budget` default `900`.

### 2.1 Phases

0. Preflight: resolve the artifact (§1); compute its sha256 in-process
   (`sha256sum` or `shasum -a 256`, whichever exists); print
   `artifact=<path> sha256=<hex>`; print `bun=<bun --version>
pinned=<.bun-version>` (warn on mismatch, never fail); print
   `commit=<git rev-parse HEAD>` or `commit=none`.
1. Lay out `$WORK`: `artifact/` (the tarball and a one-line `SHA256SUMS`
   copied from the original, filtered to that basename), `bin/`, `home/`,
   `tmp/`, `loop.sh` (a copy of `scripts/stranger/loop.sh`).
2. Compile the client: `bun build --compile --no-compile-autoload-dotenv
--no-compile-autoload-bunfig [--target bun-linux-<arch>]
scripts/stranger/mcp-client.ts --outfile "$WORK/bin/stranger-mcp-client"`.
   The `--target` flag is passed only when the host is not Linux (docker on
   macOS runs a Linux container; cross-compiling downloads that target's
   runtime — the only network use of this script, host-side, before the
   sandbox exists).
3. Run the loop inside the chosen backend (§2.2). The loop's stdout is
   teed to the terminal and to `$REPORT/transcript.txt`; its stderr is
   forwarded to stderr and appended to the transcript.
4. Summary (§2.3) and `summary.json` (§2.4). Exit 0 on success, 1 when the
   loop failed or the artifact was refused, 2 on usage, 3 on isolation.

### 2.2 Backends

`<arch>` is `x64` for `uname -m` in `x86_64|amd64`, `arm64` for
`aarch64|arm64`, else exit 1 `unsupported architecture`. The loop always
runs with an explicit, minimal environment — a stranger's real config is
never touched and nothing inherited is needed:

```
HOME=<work>/home TMPDIR=<work>/tmp PATH=/usr/local/bin:/usr/bin:/bin
LANG=C.UTF-8 TERM=dumb NO_COLOR=1 STRANGER_MCP_CLIENT=<work>/bin/stranger-mcp-client
STRANGER_PACE=<pace> STRANGER_BUDGET=<budget> STRANGER_MODE=<mode>
```

(`KIZUKI_CONFIG` and `XDG_CONFIG_HOME` are deliberately unset: the stranger
path is `$HOME/.config/kizuki/config.toml`, cli-verbs' default.)

- `docker`: `<work>` is mounted at `/stranger`, so every path above uses
  the `/stranger` prefix. Image: the single line of
  `scripts/stranger/image.txt` (NEW; ships as
  `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171`,
  the multi-arch index digest, pulled 2026-09-02; bumping it is a one-line
  change with the date in the commit body). Command:
  `docker run --rm --init --network none --platform linux/<amd64|arm64>
--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges
--user "$(id -u):$(id -g)" -e … -v "<work>:/stranger" -w /stranger <image>
bash /stranger/loop.sh /stranger`. `fresh_filesystem=true`. The pull, when
  needed, happens on the host before the container exists.
- `unshare`: `unshare -rn env -i <env> bash "<work>/loop.sh" "<work>"`.
  `fresh_filesystem=false` (host filesystem, fresh HOME/PATH/env, no
  network).
- `bwrap`: `bwrap --unshare-net --unshare-pid --die-with-parent --ro-bind / /
--dev /dev --proc /proc --tmpfs /tmp --bind "<work>" "<work>" env -i <env>
bash "<work>/loop.sh" "<work>"` (the `--bind` after `--tmpfs` matters when
  `<work>` is under `/tmp`; verified). `fresh_filesystem=false`.
- `skip`: `env -i <env> bash "<work>/loop.sh" "<work>"`.
  `fresh_filesystem=false`; the loop's `isolation` step reports what it
  saw instead of asserting.

### 2.3 Summary — the last lines, in this order

```
artifact=<path> sha256=<hex> version=<v>
network-isolation: <docker|unshare|bwrap> routes=0 probe=unreachable
fresh_filesystem=<true|false>
commands=<n> elapsed=<s>s budget=<budget>s
STRANGER_PROOF_OK mode=<docker|unshare|bwrap> elapsed=<s>s
```

With `--isolate skip` the second line is `network-isolation: none (skipped)`
and the last line is `STRANGER_LOOP_OK mode=skip elapsed=<s>s (not a proof:
no network isolation)`, still exit 0 — the GO gate (§6) accepts only
`STRANGER_PROOF_OK`. On a loop failure the last line is the loop's
`FAIL <step>: <detail>` followed by `STRANGER_PROOF_FAILED mode=<m>`, exit 1.

### 2.4 `summary.json`

```json
{
  "schema": "kizuki.stranger-proof/v1",
  "mode": "docker",
  "fresh_filesystem": true,
  "artifact": { "path": "…", "sha256": "…" },
  "version": "0.1.0",
  "commands": 16,
  "elapsed_seconds": 3,
  "budget_seconds": 900,
  "steps": [{ "id": "install", "ok": true, "seconds": 0 }],
  "ok": true
}
```

Written by the host from the loop's machine-readable trailer lines
(`step <id> ok|fail <seconds>` and `commands=<n>`, which the loop prints
to stdout and the host parses with `grep`/`sed`; no JSON tooling). Paths
inside are the sandbox's (`/stranger/…` or the redacted form of §3.0);
never the host's temp path; never a token.

## 3. `scripts/stranger/loop.sh` (NEW) — the loop, as the stranger runs it

bash, `set -euo pipefail`, runs INSIDE the sandbox with `$1` = the work
root (`WORK`). Uses only bash builtins, coreutils, `tar`, `gzip`, `grep`,
`sed`, `timeout` (optional, see step `isolation`) and `$STRANGER_MCP_CLIENT`.
No bun, no jq, no python. Under ~300 lines; one function per step.

### 3.0 Conventions

- `run <step> <cmd…>`: prints `$ <cmd…>` (the exact argv the stranger
  types, `kizuki` by name), runs it with stdout and stderr captured
  separately, prints the redacted stdout, and stores both in `OUT`/`ERR`
  plus the exit code in `RC` for the step's assertions. Every `kizuki`
  invocation increments `COMMANDS`. `sleep "$STRANGER_PACE"` before each
  command when the pace is non-zero.
- `redact`: `sed -E 's/kzk_[0-9A-HJKMNP-TV-Z]{52}/kzk_<redacted>/g;
s#'"$WORK"'#/stranger#g'`. Applied to every byte the loop echoes and to the
  captured `ERR` before it is ever printed. The token is held only in the
  shell variable `TOKEN` and exported to the one client invocation that
  needs it.
- `ok <step> [detail]` prints `ok <step> <detail>` and a trailer line
  `step <step> ok <seconds>`; `fail <step> <detail>` prints
  `FAIL <step>: <detail>`, then the captured stdout and stderr indented by
  two spaces (redacted), then `step <step> fail <seconds>`, and exits 1.
- Phrases: `alpha.md` = `The quartz-heron phrase belongs to the promoted
page.`, `beta.md` = `The velvet-comet phrase belongs to the private page.`,
  `gamma.md` = `A copper-lantern phrase stays pending.` Written by the loop
  under `$HOME/notes/` — the stranger's own files. Names in any fixture text
  are `ada`, `grace`, `acme` only.
- The stopwatch: `START=$(date +%s)` is the first statement; every step's
  seconds are measured; `elapsed` is the last step.

### 3.1 Steps, in order (ids are the words after `ok`/`FAIL`)

1. `install` — `sha256sum -c` (or `shasum -a 256 -c`) against
   `artifact/SHA256SUMS` in `artifact/`; `tar -xzf` into `$WORK/extract`;
   locate `kizuki` (§1); `mkdir -p "$HOME/.local/bin"`, copy it there,
   `export PATH="$HOME/.local/bin:$PATH"`. Assert `command -v kizuki` is
   under `$HOME/.local/bin`. Detail: `installed=$HOME/.local/bin/kizuki`.
   A tarball without an executable `kizuki` → `FAIL install: no kizuki
executable in artifact`; a checksum failure → `FAIL install: sha256
mismatch for <basename>`.
2. `isolation` — `ROUTES=$(awk 'NR>1' /proc/net/route | wc -l)` (Linux;
   on a non-Linux host in `skip` mode print `routes=n/a`). Probe:
   `timeout 5 bash -c 'exec 3<>/dev/tcp/192.0.2.1/9'` (TEST-NET-1, never
   routable, so an unisolated run leaks nothing real): `unreachable` when it
   exits non-zero within the timeout with output matching
   `Network is unreachable`; `timeout` when it exits 124; `connected`
   otherwise; `skipped (no timeout(1))` when `timeout` is absent. When
   `STRANGER_MODE` is not `skip`: assert `ROUTES = 0` and probe
   `unreachable`, else `FAIL isolation: routes=<n> probe=<r>`. In `skip`
   mode the step always passes and reports. Prints
   `network-isolation: <mode> routes=<n> probe=<r>` (the host copies this
   line into the summary).
3. `version` — `kizuki version`; when `$WORK/expected-version` exists (the
   host writes it from `packages/cli/package.json` when a checkout is
   present) assert equality.
4. `init` — `kizuki init "$HOME/vault"`: exit 0; `$HOME/vault/CANON.md`
   and `$HOME/.config/kizuki/config.toml` exist (cli-verbs writes
   `default_vault`; no `--vault` flag is used anywhere after this).
5. `import` — write the three notes; `kizuki import markdown-folder
--source "$HOME/notes"`: stdout contains `events_stored=3`.
6. `query-withheld` — `kizuki query quartz-heron`: exit 0 and stdout does
   NOT contain `quartz-heron` (unlabeled capture is never served —
   invariant 8 in the stranger's hands; stderr carries cli-verbs' `withheld=`
   or cli-wave2's `denied=` footer, not asserted).
7. `review-list` — `kizuki review --list --json`: exactly three lines;
   the line containing `quartz-heron` yields
   `ALPHA_ID=$(printf '%s\n' "$line" | sed -n 's/.*"proposal_id":"\(01[0-9A-HJKMNPQRSTVWXYZ]\{24\}\)".*/\1/p')`
   (key-addressed: the same line carries event ULIDs under `provenance`);
   likewise `BETA_ID` for `velvet-comet`. Both non-empty.
8. `promote-refused` — `kizuki promote "$ALPHA_ID"` (no sensitivity): exit
   non-zero; no `$HOME/vault/captures/` directory.
9. `promote` — `kizuki promote "$ALPHA_ID" --sensitivity personal`: a
   `page_path=` line whose file exists and contains
   `sensitivity: "personal"`.
10. `query-served` — `kizuki query quartz-heron`: exit 0, stdout contains
    `quartz-heron` (assert the phrase, never the line prefix; cli-verbs
    prints `page …`, cli-wave2 prints `canon …`).
11. `agent-add` — `kizuki agent add ada` (cli-wave2 §7, NEW): stdout has
    `agent=ada agent_id=<ulid>` and one `token=kzk_…` line;
    `TOKEN=$(printf '%s\n' "$OUT" | grep -oE '^token=kzk_[0-9A-HJKMNP-TV-Z]{52}$' | cut -c7-)`
    non-empty. The echoed stdout shows `token=kzk_<redacted>`. Assert the
    literal token appears nowhere in the redacted `OUT`.
12. `mcp-list` — `KIZUKI_TOKEN_ADA="$TOKEN" "$STRANGER_MCP_CLIENT" --list --
kizuki mcp --agent ada --token env:KIZUKI_TOKEN_ADA` (cli-wave2 §6,
    NEW): exit 0; stdout (one JSON line) contains all eight names
    `search get_page query_entities timeline context_packet graph_neighbors
system_health propose` as `"name":"<n>"`. The printed command line is
    exactly what a harness config would run; the token travels only in the
    environment.
13. `mcp-search` — same prefix, `--call search '{"query":"quartz-heron"}'`:
    exit 0; stdout contains `"schema":"kizuki.envelope/v1"`,
    `"principal":"ada"` and `quartz-heron` (serving-mcp §1.5: the canon
    chunk's `excerpt` is the search snippet). Assert `"tainted"` is absent
    (a canon page is not quoted capture) — the taint marker belongs to
    ledger scope, which the agent did not ask for.
14. `promote-private` — `kizuki promote "$BETA_ID" --sensitivity private`:
    `page_path=` line; file contains `sensitivity: "private"`.
15. `mcp-ceiling` — `--call search '{"query":"velvet-comet"}'` as `ada`
    (default grant, ceiling `personal`): exit 0; stdout does NOT contain
    `velvet-comet`, contains `"canon":[]` and
    `"reason":"above_ceiling"` — the Wave 2 grant-ceiling proof, re-run by
    the stranger against a release binary (invariant 8; §8.1 "enforcement
    below the prompt layer").
16. `agent-audit` — `kizuki agent audit ada` (cli-wave2 §7): exit 0; at
    least two lines contain `search`; stdout does not contain
    `quartz-heron` or `velvet-comet` (query shapes are hashed by core).
17. `doctor` — `kizuki doctor`: exit 0; one line matches
    `^app_credentials telegram=(build|env|placeholder) google=… x=… whoop=…$`
    (ci-hardening §7; a release build shows `build`, the test fixture shows
    `placeholder`; the loop asserts the line, never a value).
18. `export` — `kizuki export --out "$HOME/kizuki-export"`:
    `manifest.json` exists and `grep -rF quartz-heron "$HOME/kizuki-export/vault"`
    hits.
19. `elapsed` — `ELAPSED=$(( $(date +%s) - START ))`; print
    `commands=$COMMANDS elapsed=${ELAPSED}s budget=${STRANGER_BUDGET}s`;
    `FAIL elapsed: <n>s is not under the <budget>s budget` when
    `ELAPSED >= STRANGER_BUDGET`. Then `STRANGER_LOOP_DONE`.

Nothing is run through a TTY; `review` is only ever called with `--list`.
The loop never reads `$WORK/../`, never touches a path outside `$WORK` and
`$HOME`, never prints an environment variable, and never uses `--vault`
after `init` — that is the point: the default path works.

## 4. `scripts/stranger/mcp-client.ts` (NEW) — the tiny stdio MCP client

Zero dependencies; newline-delimited JSON-RPC 2.0 over the child's
stdin/stdout, exactly the framing the official SDK's stdio transport uses
(serving-mcp §2.2) and the framing the serving-mcp acceptance already
drives with `printf`. It stands in for "the stranger's harness". It is
compiled into the sandbox (§2.1) and also runs as
`bun scripts/stranger/mcp-client.ts …` on a dev box.

```
stranger-mcp-client [--timeout-ms N] --list -- <command> [args…]
stranger-mcp-client [--timeout-ms N] --call <tool> <json-object> -- <command> [args…]
```

```ts
export const CLIENT_NAME = "kizuki-stranger-client" as const;
export const CLIENT_VERSION = "0.1.0" as const;
export const PROTOCOL_VERSION = "2025-06-18" as const;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class UsageError extends Error {}
export type ClientRequest =
  | { kind: "list" }
  | { kind: "call"; tool: string; args: Record<string, unknown> };
export interface ClientOptions {
  command: string[]; // argv after `--`; never contains a token by construction (there is no token flag)
  timeoutMs: number; // default 30000; integer 100..600000
  env?: Record<string, string | undefined>; // default process.env, passed through to the child
}
export function parseArgs(argv: string[]): {
  request: ClientRequest;
  options: ClientOptions;
};
// `--call` args must parse as a JSON object (not array/null); `--` required; unknown flag → UsageError

export class FrameBuffer {
  /** Appends bytes; returns every complete line (without the newline). A line longer than
   *  MAX_FRAME_BYTES throws; the buffer never grows past it. */
  push(chunk: Uint8Array): string[];
}

export type ClientOutcome =
  | { status: "ok"; result: unknown } // tools/list result, or the tool result (structuredContent when present, else content[0].text parsed as JSON)
  | { status: "tool_error"; error: unknown } // result.isError === true: the parsed content[0].text
  | { status: "protocol_error"; message: string }; // child exit, non-JSON line, JSON-RPC error object, timeout
export async function runClient(
  request: ClientRequest,
  options: ClientOptions,
): Promise<ClientOutcome>;
```

`runClient`: `Bun.spawn(options.command, { stdin: "pipe", stdout: "pipe",
stderr: "inherit", env })`; write `initialize` (`id: 1`, `protocolVersion`,
`capabilities: {}`, `clientInfo: { name, version }`), await the `id: 1`
response, write `notifications/initialized`, then `tools/list` (`id: 2`)
or `tools/call` (`id: 2`, `{ name, arguments }`); await `id: 2`; close
stdin; wait for the child (kill it after the timeout). Lines whose `id`
does not match a pending request (server notifications) are ignored. A
JSON-RPC `error` object on a pending id → `protocol_error` with
`code`+`message` (the SDK's `InvalidParams` for a schema rejection lands
here, distinct from the engine's `isError` results). Every timer is
cleared; the child never outlives the client.

`main()`: outcome `ok` → `JSON.stringify(result)` + `\n` on stdout, exit 0;
`tool_error` → `JSON.stringify(error)` on stdout, exit 1; `protocol_error`
→ `stranger-mcp-client: <message>` on stderr, exit 3; `UsageError` → usage
on stderr, exit 2. Nothing else ever goes to stdout.

## 5. The recorded demo — `scripts/stranger/record.ts`, `docs/demo/stranger-loop.cast`, `docs/stranger-proof.md`

```
bun scripts/stranger/record.ts --artifact PATH [--isolate MODE] [--out docs/demo/stranger-loop.cast] [--width 100] [--height 32]
bun scripts/stranger/record.ts --check docs/demo/stranger-loop.cast
```

```ts
export interface CastHeader {
  version: 2;
  width: number;
  height: number;
  timestamp: number; // unix seconds
  title: string; // `kizuki <version> stranger loop mode=<mode>`
  env: { TERM: "xterm-256color"; SHELL: "/bin/bash" };
}
export type CastEvent = [number, "o", string]; // seconds since start, output, text
export class CastError extends Error {}
export function redact(text: string, workDir: string | null): string;
// kzk_ tokens → kzk_<redacted>; workDir → /stranger; lone "\n" → "\r\n" (terminal players need the CR)
export function serializeCast(header: CastHeader, events: CastEvent[]): string; // header line + one JSON array per event
export function parseCast(text: string): {
  header: CastHeader;
  events: CastEvent[];
}; // CastError on any malformed line
export interface CastCheck {
  ok: boolean;
  problems: string[];
  version: string | null; // from the title
  mode: string | null; // from the title
  steps: number; // count of `ok <step>` lines in the joined output
  duration: number; // last event time
}
export function checkCast(
  text: string,
  expectedVersion: string,
  opts?: { requireIsolation?: boolean },
): CastCheck;
export async function record(opts: {
  proofArgs: string[]; // passed verbatim to scripts/stranger-proof.sh, plus --pace 0.6 and --report <tmp>
  out: string;
  width: number;
  height: number;
}): Promise<CastCheck>;
```

`record()` spawns `bash scripts/stranger-proof.sh <proofArgs> --pace 0.6`
with stdout and stderr piped, timestamps every chunk relative to the spawn
(`performance.now()`), redacts each chunk (the host work dir is known from
the proof's own `--work` argument, which `record()` sets to a temp dir), and
writes the cast only when the proof exited 0; then runs `checkCast` on the
written file and prints its verdict line. The proof's exit code is the
recorder's. `--check` reads the file, takes the expected version from
`packages/cli/package.json`, prints `cast ok version=<v> mode=<m>
steps=<n> duration=<s>s` (exit 0) or one `cast problem: …` line per
problem (exit 1).

`checkCast` problems: header not version 2; title not matching
`^kizuki (\S+) stranger loop mode=(\S+)$`; version ≠ expected; output
missing `STRANGER_PROOF_OK` (or `STRANGER_LOOP_OK` when
`requireIsolation` is false); fewer than 19 `ok <step>` lines or any
`FAIL`; any match of `kzk_[0-9A-HJKMNP-TV-Z]{52}`; any `/tmp/`,
`/private/var/`, `/Users/` or `/home/` substring (the only home in a cast
is `/stranger/home`); with `requireIsolation` (the GO gate): `mode` ∉
`{docker, unshare, bwrap}`.

`docs/demo/stranger-loop.cast` is recorded once by this lane with
`--isolate docker` on this box and committed. It is text (JSON lines), so
`scripts/verify.sh`'s denylist greps it like any tracked file; it contains
synthetic phrases, `/stranger/…` paths and redacted tokens only. It is
re-recorded whenever the loop, the CLI's output or the version changes;
`record.test.ts` (below) fails `bun test` when the tracked cast's version
falls behind the package version, and the GO gate `demo` fails when it was
recorded without isolation.

`docs/stranger-proof.md` (NEW, the only prose this lane adds): what the
proof proves (the Wave 5 criterion in this repo's words: a non-author on a
fresh machine reaches promoted canon and an agent query in under 15 minutes
with nothing but the release artifact and the README); the three backends
and what "fresh" means for each (`fresh_filesystem`); the 19 steps and the
one assertion each makes; how to read the summary and `summary.json`; how
to play (`asciinema play docs/demo/stranger-loop.cast` or any asciicast v2
player) and re-record the demo; how `go-no-go` composes the gates; the
honest limits: the bound is asserted on the machine loop (seconds), the
human-paced claim is "N commands, all in the README"; the TUI is not
recorded. No person, host, harness or vendor names.

## 6. `scripts/go-no-go.ts` (NEW) — every 1.0 gate, PASS/FAIL, one verdict

```
bun scripts/go-no-go.ts [--artifact PATH] [--tag vX.Y.Z] [--isolate auto|docker|unshare|bwrap] [--gate ID]… [--list] [--json]
```

```ts
export interface GateContext {
  repoRoot: string;
  artifact: string | null; // --artifact, else §1 discovery, else null
  tag: string | null;
  isolate: string; // default "auto"
  env: Record<string, string | undefined>;
  log(line: string): void; // progress to stderr
  cache: Map<string, unknown>; // resolveArtifact memo
}
export interface GateResult {
  status: "PASS" | "FAIL";
  detail: string;
} // detail: one line, no secrets, no captured text
export interface Gate {
  id: string;
  summary: string;
  run(ctx: GateContext): Promise<GateResult>;
}
export interface GateReport extends GateResult {
  id: string;
  summary: string;
  seconds: number;
}
export interface Verdict {
  schema: "kizuki.go-no-go/v1";
  head: string | null; // git rev-parse HEAD
  at: string; // RFC3339
  gates: GateReport[];
  verdict: "GO" | "NO-GO";
}
export const GATES: readonly Gate[]; // the nine below, this order
export function parseArgs(argv: string[]): {
  gates: string[] | null;
  list: boolean;
  json: boolean;
  artifact: string | null;
  tag: string | null;
  isolate: string;
}; // UsageError on unknown flag/gate id
export async function resolveArtifact(
  ctx: GateContext,
): Promise<{ path: string; sha256: string; binary: string; version: string }>; // §1 rules; sha via Bun.CryptoHasher; tar via Bun.spawnSync(["tar","-xzf",…]); memoized
export async function runGates(
  gates: readonly Gate[],
  ctx: GateContext,
): Promise<Verdict>; // sequential; a gate that throws is FAIL with the error message
export function formatVerdict(verdict: Verdict): string; // the human block below
export function missingVerbs(helpText: string, readme: string): string[]; // pure (gate `readme`)
export function tagMatches(tag: string, version: string): boolean; // pure: tag === `v${version}`
export function verifySha256Sums(
  sumsText: string,
  basename: string,
  sha256: string,
): "ok" | "missing" | "mismatch"; // pure
```

Gates (id — command it runs — PASS condition — detail):

1. `tree` — `git status --porcelain` — empty — `head=<sha12>`; FAIL lists
   the first five paths.
2. `verify` — `bash scripts/verify.sh` — exit 0 — `<seconds>s`; FAIL: the
   last 20 output lines, on stderr, and `see output above` as detail.
   (`verify.sh` runs `bun test`, which runs `go-no-go.test.ts` against fake
   gates only — no recursion.)
3. `artifact` — `resolveArtifact` — SHA256SUMS `ok`, extracted `kizuki
version` equals `packages/cli/package.json` — `<basename> version=<v>
sha256=<12 hex>`; FAIL names the rule that failed (no artifact / missing
   sums line / mismatch / no executable / version `<got>` ≠ `<want>`).
4. `quickstart` — `bash scripts/quickstart.sh --binary <extracted kizuki>
--isolate auto` (ci-hardening §5, NEW) — last line starts with
   `QUICKSTART_OK` — that line plus the `network-isolation:` line before it.
5. `stranger-proof` — `bash scripts/stranger-proof.sh --artifact <path>
--isolate <ctx.isolate>` — last line starts with `STRANGER_PROOF_OK` — that
   line (`STRANGER_LOOP_OK` is a FAIL: `not isolated`).
6. `demo` — `checkCast(readFile("docs/demo/stranger-loop.cast"), version,
{ requireIsolation: true })` — `ok` — `version=<v> mode=<m> steps=<n>`;
   FAIL joins the problems.
7. `readme` — `<extracted kizuki> help`, verbs = every line matching
   `^  ([a-z]+)\b` (the cli-verbs help layout); each must appear in
   `README.md` as `` `<verb>` `` or `kizuki <verb>` followed by a non-letter
   — `verbs=<n>`; FAIL `not documented: a b c`.
8. `security` — `SECURITY.md` exists and is non-empty (security-docs lane)
   — `bytes=<n>`; FAIL `SECURITY.md missing` (a 1.0 gate that is honestly
   red until that lane lands; the acceptance below selects gates for that
   reason).
9. `tag` — only when `--tag` is given, else `PASS` with detail `not
requested` — `tagMatches(tag, version)` — `tag=<t> version=<v>`.

Human output, one line per gate then the verdict:

```
gate tree            PASS  head=76930dbcebbd
gate verify          PASS  142s
gate artifact        FAIL  no release artifact under dist/release; pass --artifact PATH
…
verdict NO-GO failed=1 of 9
```

(`verdict GO gates=9` on success.) `--json` prints the `Verdict` document
instead. `--list` prints `<id>  <summary>` per gate, exit 0. Exit code: 0
iff `GO`; 1 on `NO-GO`; 2 on usage. Gates run in order and all of them run
(no short-circuit) so the report is complete; `--gate` selects a subset in
`GATES` order.

## 7. CI, scripts, README

`.github/workflows/ci.yml` (ci-hardening owns the file; append one job,
same pinning rule — every action by full SHA with the tag in a comment):

```yaml
  stranger-proof:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@<sha> # v4
      - uses: oven-sh/setup-bun@<sha> # v2
        with: { bun-version-file: .bun-version }
      - run: bun install --frozen-lockfile
      - run: bun run package            # packaging-release (NEW): writes dist/release/
      - run: bash scripts/stranger-proof.sh --isolate docker
      - uses: actions/upload-artifact@<sha> # v4
        if: always()
        with: { name: stranger-proof-${{ github.sha }}, path: dist/stranger-proof/, retention-days: 7 }
```

Linux only (docker is on the Ubuntu runners; macOS runners have no
isolation backend). If `docker` ever disappears from the runner image the
fix is `--isolate unshare` with the `sysctl` line ci-hardening documents —
never `skip`.

Root `package.json` scripts (add): `"stranger-proof": "bash scripts/stranger-proof.sh"`,
`"go-no-go": "bun scripts/go-no-go.ts"`, `"demo:record": "bun scripts/stranger/record.ts"`,
`"demo:check": "bun scripts/stranger/record.ts --check docs/demo/stranger-loop.cast"`.

`README.md`: one subsection "Prove it on a fresh machine" under "Try it"
(cli-verbs owns "Try it"; add after ci-hardening's "Build a binary"): the
three commands (`bun run stranger-proof --artifact …`, `bun run demo:check`,
`bun run go-no-go --artifact …`), what `STRANGER_PROOF_OK mode=docker
elapsed=<s>s` means (network-isolated container, nothing but the release
tarball, every step listed in `docs/stranger-proof.md`), a link to the
cast, and the sentence that the loop is N commands (N = the `commands=`
value of the committed cast, kept in sync by hand — the `readme` gate does
not check it; say so). No harness, vendor or person names; no claim about
timing beyond the asserted bound.

## Tests

All under `bun test` (the `tsconfig` already includes `scripts/**/*.ts`;
`scripts/verify-network.test.ts` proves discovery works there). Every test
uses `mkdtempSync` and synthetic fixtures; nothing reads outside the
worktree except the optional docker socket, gated by `test.skipIf`.

- `scripts/stranger/test-helpers.ts`: `buildFixtureArtifact(dir)` →
  `{ tarball, sums, version }` via `build()` from `scripts/build.ts`
  (ci-hardening) + `tar -czf` + `Bun.CryptoHasher("sha256")`; `dockerAvailable()`,
  `unshareAvailable()`, `bwrapAvailable()` (each a short `Bun.spawnSync`).
- `scripts/stranger/mcp-client.test.ts` (≥ 10): `parseArgs` — `--list`,
  `--call` with an object, missing `--` / array args / unknown flag →
  `UsageError`, `--timeout-ms` bounds; `FrameBuffer` — split across
  chunks, CRLF tolerated, oversize line throws; `runClient` against
  `[process.execPath, "packages/mcp/src/bin.ts", "--vault", vault, "--owner"]`
  (serving-mcp §2.2, NEW) on an `initVault` temp vault: `--list` → exactly
  `TOOLS` names; `--call search {"query":"kettle"}` → `ok` with
  `result.schema === "kizuki.envelope/v1"`; `--call search {"limit":51}` →
  `tool_error` carrying `error: "invalid_arguments"`; `--call nope {}` →
  `protocol_error` (the SDK rejects an unknown tool before the engine);
  `bash -c 'exit 0'` → `protocol_error` mentioning the exit; `bash -c 'echo
notjson; sleep 1'` → `protocol_error`; `bash -c 'sleep 30'` with
  `timeoutMs: 500` → `protocol_error` within 2 s and the child is gone;
  `env` passthrough — a child `bash -c 'echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{},\"serverInfo\":{\"name\":\"x\",\"version\":\"0\"}}}"; …'`
  style fixture that echoes `$KIZUKI_TOKEN_ADA` into its `tools/list`
  result proves the variable reached the child and that `options.command`
  never carried it.
- `scripts/stranger/record.test.ts` (≥ 8): `serializeCast`/`parseCast`
  round trip; `parseCast` rejects a non-JSON line, a version-1 header, an
  event that is not `[number, "o", string]`; `redact` replaces a token, the
  work dir and converts newlines; `checkCast` passes a synthetic good cast
  and reports each problem class (token, `/tmp/`, wrong version, `skip`
  mode under `requireIsolation`, missing `STRANGER_PROOF_OK`, a `FAIL`
  line); the tracked `docs/demo/stranger-loop.cast` passes `checkCast`
  against the current `packages/cli/package.json` version (this is the
  test that fails on a version bump without re-recording).
- `scripts/stranger/stranger-proof.test.ts` (≥ 7; `beforeAll` builds the
  fixture artifact once): `--isolate skip --work <tmp> --report <tmp>/r` →
  exit 0, last line `STRANGER_LOOP_OK mode=skip …`, the 19 step ids in
  order as `ok <id>`, `commands=` ≥ 14, `summary.json` parses with
  `schema`, `ok: true`, `elapsed_seconds < 900`; the transcript contains no
  `kzk_[0-9A-HJKMNP-TV-Z]{52}` and not the temp path (it shows
  `/stranger`); a `SHA256SUMS` with a flipped digit → exit 1, `FAIL install:
sha256 mismatch`; a tarball holding only `LICENSE` → exit 1, `FAIL install:
no kizuki executable in artifact`; no artifact and no `dist/release/` →
  exit 1 with the §1 message; `--isolate unshare` when
  `!unshareAvailable()` → exit 3, stderr `network-isolation: unshare is
unavailable`; `--isolate skip` transcript shows `$ kizuki mcp --agent ada
--token env:KIZUKI_TOKEN_ADA` (the token in env, never on argv);
  `test.skipIf(!dockerAvailable())`: `--isolate docker` → exit 0,
  `STRANGER_PROOF_OK mode=docker`, `fresh_filesystem=true`,
  `network-isolation: docker routes=0 probe=unreachable`;
  `test.skipIf(!bwrapAvailable())`: `--isolate bwrap` → `STRANGER_PROOF_OK
mode=bwrap`.
- `scripts/go-no-go.test.ts` (≥ 8): `runGates` with fake gates (two PASS
  → `GO`, one FAIL → `NO-GO`, a throwing gate → `FAIL` with the message,
  order preserved, `seconds` present); `formatVerdict` lines match
  `^gate \S+\s+(PASS|FAIL)\s+` and the verdict line; `parseArgs` — `--list`,
  `--gate` repeatable, unknown gate id → `UsageError`, `--json`; `GATES`
  ids are exactly `tree verify artifact quickstart stranger-proof demo
readme security tag` in that order; `missingVerbs` — a verb only in a code
  span, only as `kizuki <verb>`, and one absent; `tagMatches`;
  `verifySha256Sums` — ok, missing, mismatch, tolerates `*` binary marker;
  the process seam: `bun scripts/go-no-go.ts --list` exit 0 with nine
  lines; `--gate tag --tag v0.0.0` → `FAIL` and exit 1; `--gate tag` alone
  → `PASS  not requested`, exit 0.

## Acceptance

```
bun run typecheck && bun test                                        # green; ≥ 33 new tests under scripts/
bun run verify                                                       # exit 0 (the cast is scanned by the denylist like any tracked text)
bun run package                                                      # packaging-release's script (NEW); writes dist/release/kizuki-<v>-linux-x64.tar.gz + SHA256SUMS
A=$(ls dist/release/kizuki-*-linux-x64.tar.gz)
bash scripts/stranger-proof.sh --artifact "$A" --isolate docker      # 19 "ok <step>" lines; last line "STRANGER_PROOF_OK mode=docker elapsed=<s>s"; the line before: "commands=<n> elapsed=<s>s budget=900s"
grep -c 'kzk_[0-9A-HJKMNP-TV-Z]\{52\}' dist/stranger-proof/transcript.txt   # 0
grep -c '/tmp/' dist/stranger-proof/transcript.txt                   # 0
grep -o '"ok": *true' dist/stranger-proof/summary.json | wc -l       # 1 (and every "id" of the 19 steps present)
bash scripts/stranger-proof.sh --artifact "$A" --isolate unshare; echo $?   # on this box: stderr "network-isolation: unshare is unavailable (…uid_map…)"; prints 3. On a box with user namespaces: STRANGER_PROOF_OK mode=unshare
bash scripts/stranger-proof.sh --artifact "$A" --isolate bwrap        # STRANGER_PROOF_OK mode=bwrap …; fresh_filesystem=false
bash scripts/stranger-proof.sh --artifact "$A" --isolate skip         # STRANGER_LOOP_OK mode=skip … (not a proof: no network isolation); exit 0
bash scripts/stranger-proof.sh --isolate skip; echo $?               # with no dist/release: "stranger-proof: no release artifact; pass --artifact PATH or run: bun run package"; prints 1
V=$(mktemp -d)/vault && bun packages/cli/src/main.ts init "$V" --no-default >/dev/null && \
  bun scripts/stranger/mcp-client.ts --list -- bun packages/cli/src/main.ts mcp --owner --vault "$V" | grep -o '"name":"[a-z_]*"' | sort -u | wc -l   # 8
bun scripts/stranger/mcp-client.ts --call search '{"limit":51}' -- bun packages/cli/src/main.ts mcp --owner --vault "$V"; echo $?   # stdout {"error":"invalid_arguments",…}; prints 1
bun scripts/stranger/mcp-client.ts --list -- bash -c 'exit 0'; echo $?   # stderr "stranger-mcp-client: …"; prints 3
bun scripts/stranger/record.ts --artifact "$A" --isolate docker --out docs/demo/stranger-loop.cast   # "cast ok version=<v> mode=docker steps=19 duration=<s>s"
bun run demo:check                                                   # same line, exit 0
head -1 docs/demo/stranger-loop.cast                                 # {"version":2,…,"title":"kizuki <v> stranger loop mode=docker",…}
grep -c 'kzk_[0-9A-HJKMNP-TV-Z]\{52\}' docs/demo/stranger-loop.cast  # 0
grep -cE '/tmp/|/home/|/Users/' docs/demo/stranger-loop.cast | grep -v stranger   # no output (only /stranger/home appears)
bun scripts/go-no-go.ts --list                                       # nine lines: tree verify artifact quickstart stranger-proof demo readme security tag
bun scripts/go-no-go.ts --artifact "$A" --isolate docker --gate artifact --gate stranger-proof --gate demo --gate readme --gate tree   # five PASS lines; "verdict GO gates=5"; exit 0
bun scripts/go-no-go.ts --artifact "$A" --isolate docker; echo $?    # all nine gates printed; "verdict NO-GO failed=1 of 9" with "gate security FAIL SECURITY.md missing" until security-docs lands, then GO; exit 1 / 0 accordingly
bun scripts/go-no-go.ts --gate tag --tag v9.9.9; echo $?            # "gate tag FAIL tag=v9.9.9 version=<v>"; prints 1
bun scripts/go-no-go.ts --artifact "$A" --json --gate artifact | head -c 40   # {"schema":"kizuki.go-no-go/v1","head":…
grep -c 'stranger-proof' .github/workflows/ci.yml                    # ≥ 2 (job id and the run line)
git ls-files scripts/stranger docs/demo docs/stranger-proof.md scripts/go-no-go.ts scripts/go-no-go.test.ts scripts/stranger-proof.sh | wc -l   # 12
git status --porcelain                                               # empty (dist/ is ignored)
```
