# Goal plan: Kizuki on a Box behind Tailscale

Status: PLAN (branch `agent/deploy-box-tailscale-20260903`, written
2026-09-03 against `main` at `f152d91`). Nothing in this document is a claim
that any of it is built. Each milestone names a proof script whose exit code
is the finish line. A milestone is done when its proof exits 0 on the exact
head under review, and not before.

Binding context: `docs/CURRENT.md`, `docs/decision-log.md`, RFC 0002. This
plan adds a deployment target. It changes no contract, no invariant and no
policy. Where it touches the CLI (M4, M5) it implements accepted design that
RFC 0002 already names (§12 model configuration, §8.4 `kizuki agent add`).

## 0. Goal

A person who is not the owner runs one command on a fresh Ubuntu VM from
the Box sandbox platform, and within five minutes has a Kizuki that:

1. runs the always-on loop as the container's main process;
2. is reachable only over their tailnet, never over the VM's public IP;
3. syncs a connected source, answers `query` and MCP reads, and takes
   `tell` and `undo`;
4. writes canon with receipts once a model endpoint is configured, and says
   `canon writing: off` in `doctor` until then;
5. loses nothing across container restart, VM stop and VM start;
6. can be torn down with `docker compose down -v`, leaving a readable
   Markdown vault in the export the owner pulled.

Every one of those six sentences is asserted by a script below. There is no
"looks right" step.

## 1. Facts this plan rests on (verified 2026-09-03)

| Fact | Where |
| --- | --- |
| `kizuki serve` binds loopback only and refuses any other host. | `packages/core/src/serve/http.ts` `startServeHttp` |
| The standing endpoint serves `GET /health` unauthenticated and `POST /v1/mcp/<tool>` behind a bearer token minted at start, written 0600, rotated on restart. Agent tokens from `agents` also authenticate. | same file, `principalFor` |
| Inside a container there is no systemd. `KIZUKI_SUPERVISOR=none` forces the "loop runs only while you run it" path. | `packages/core/src/serve/supervisor.ts` `detectSupervisorKind` |
| The serve loop takes `RailHooks { sync, claims, model_ref }`. The CLI `serve` verb passes none, so canon writing is unreachable from the CLI today. | `packages/core/src/serve/rails.ts`, `packages/cli/src/commands/serve.ts` |
| RFC 0002 §12 specifies `[ports] llm = "kizuki.llm.openai-compatible"` plus `[ports.llm] base_url, model, secret_ref`. Nothing reads it yet. | `rfcs/0002-autonomous-canon.md` §12.1 |
| `@kizuki/llm` registers `kizuki.llm.none` and `kizuki.llm.openai-compatible`; a loopback fake endpoint exists for tests. | `packages/llm/src/index.ts`, `packages/llm/test/fake-endpoint.ts` |
| Core has `addAgent`, `setGrant`, `revokeAgent`, `rotateToken`. No CLI verb exposes them. `kizuki-mcp --token-env VAR` exists. | `packages/core/src/agents/identity.ts`, `packages/mcp/src/bin.ts` |
| `import` fails on Windows with `EPERM fsync` because directories are opened for fsync. Out of scope here; Linux is the target. | `packages/core/src/ledger/connection-state-files.ts` `fsyncDirectory` |
| The stranger-proof spec already treats `docker` as its preferred isolation backend. | `docs/wave1/specs/stranger-proof.md` §2.2 |
| `scripts/verify-network.ts` scans `packages/` only; `scripts/verify.sh` scans every tracked file and reachable commit message for the identifier denylist. | `scripts/` |
| CI pins bun 1.3.10 and requires every action to be SHA-pinned. | `.github/workflows/ci.yml`, `scripts/verify-workflows.ts` |
| Box gives a full Ubuntu VM with Docker, Bun, SSH, snapshots, disk-level forking and a dedicated public IP, billed per second, EU regions. | box.ascii.dev, fetched 2026-09-03 |

## 2. Shape

```
tailnet peer (laptop, harness)
   │  https://kizuki-<node>.<tailnet>.ts.net  (tailscale serve → 127.0.0.1:PORT)
   │  tailscale ssh kizuki -- kizuki-mcp --vault /vault --token-env KIZUKI_AGENT_TOKEN
   ▼
Box VM (Ubuntu, Docker)
 └─ docker compose
     ├─ tailscale   image pinned by digest, TS_USERSPACE=true, TS_STATE_DIR volume,
     │              TS_AUTHKEY from a Docker secret, --ssh, serve config for /health and /v1/mcp/*
     └─ kizuki      network_mode: service:tailscale, KIZUKI_SUPERVISOR=none,
                    PID 1 = `kizuki serve`, /vault volume, no capabilities, read-only rootfs
```

Two containers share one network namespace, so Kizuki keeps its loopback
rule untouched and the tailscale container is the only thing that can see
the port. Userspace networking needs no `NET_ADMIN` and no `/dev/net/tun`,
which matters on a VM whose Docker daemon we do not configure. Outbound
from Kizuki to a tailnet-hosted model endpoint goes through tailscaled's
SOCKS5 proxy; that is the one place the userspace choice costs something
and M4's proof covers it.

Pledge honesty: tailscaled is network egress from the VM to Tailscale's
control plane and relays. It is outside Kizuki's process and outside the
`packages/` scan, so it does not change the zero phone-home claim about
Kizuki. The deploy guide (M6) says this in one sentence rather than letting
the reader assume the container inherits the pledge.

## 3. Milestones and finish lines

Each proof lives under `deploy/proof/` and is a bash script that prints one
`PASS <check>` or `FAIL <check> <reason>` line per assertion and exits
non-zero on the first failure. Proofs that need a real tailnet or a real
Box run outside CI; their receipts (command, exact head, transcript) go in
the pull request body, and the "CI-runnable" column says which is which.

### M1 Container floor

Files: `deploy/Dockerfile`, `deploy/entrypoint.sh`, `deploy/compose.yml`,
`deploy/proof/container.sh`, `deploy/fixtures/notes/*.md` (synthetic).

Dockerfile: `oven/bun:1.3.10` pinned by digest, `bun install
--frozen-lockfile`, non-root user, `/vault` volume, `ENTRYPOINT
["/entrypoint.sh"]`. Entrypoint: `KIZUKI_SUPERVISOR=none`, `kizuki init
/vault` when `/vault/.kizuki` is absent, then `exec kizuki serve --vault
/vault`.

Finish line, `deploy/proof/container.sh` (CI-runnable, Linux only):

| # | Assertion | How it is decided |
| --- | --- | --- |
| 1.1 | Image builds reproducibly. | `docker build` exits 0 twice; the two image ids match. |
| 1.2 | The floor needs no network. | Every check below runs with `--network none`. |
| 1.3 | Loop is PID 1 and alive. | `docker exec` `kizuki serve status --json` → `running: true`, `lease: "held"`. |
| 1.4 | Health endpoint answers on loopback. | `curl -fsS 127.0.0.1:$PORT/health` inside the container → body `"ok":true`. |
| 1.5 | Nothing listens off loopback. | `ss -ltn` inside the container shows no `0.0.0.0` or `[::]` listener. |
| 1.6 | Ingest works and fails closed. | `kizuki import markdown-folder --source /fixtures` exits 0 with stdout containing `events_stored=3` and `errors=0`; `kizuki query acme --scope ledger` exits 0, prints nothing on stdout, and its stderr contains `withheld=`; a second identical import exits 0 with stdout containing `events_stored=0` and `duplicates=3`. |
| 1.7 | Doctor is honest. | `kizuki doctor` output contains `supervisor: none` and `canon writing: off`; no rail line contains `status=failed`. |
| 1.8 | State survives restart. | `docker restart`; 1.3 passes again; a third identical import exits 0 with stdout containing `events_stored=0` and `duplicates=3`; `kizuki doctor` output contains `events=3`. |
| 1.9 | No plaintext secret in the image. | `docker history --no-trunc` and a filesystem grep for the value of `KIZUKI_MODEL_KEY` find nothing; `/vault/.kizuki/serve-token` mode is `0600`. |
| 1.10 | Root filesystem is read-only. | `docker inspect` shows `ReadonlyRootfs: true`; `touch /usr/bin/x` inside fails. |
| 1.11 | Export is a readable exit. | `kizuki export --out /vault/export` exits 0, `/vault/export/ledger/events.jsonl` exists, and it contains the string `acme`. |

Finding (2026-09-03): row 1.6 above originally read "`kizuki query acme --json`
returns ≥ 1 hit", written before this milestone was implemented. It was
wrong. `packages/core/src/search/indexer.ts`'s `eventDocument` labels a
ledger event's search sensitivity only from the connector's
`sensitivity_hint`; `connector_sensitivity` (the per-connection floor set by
`applyConnectionSensitivity`) is not consulted at index time. The
`markdown-folder` connector's manifest sets `emits_sensitivity_hint: false`
and never sets a hint on the events it emits, so every note this connector
imports is indexed as `unlabeled`, and `ceilingSql` (`packages/core/src/
query/sql.ts`) excludes anything without a recognized sensitivity from every
`query` result regardless of the file's own frontmatter. On the zero-model
floor this is not a defect to route around here: there is exactly one
receipted writer for canon, and no CLI verb or container script may write
canon or rebuild the derived search index outside it. So on M1, imported
notes are real, queryable-by-nothing evidence in the ledger, and a `query`
hit becomes observable only once M4 wires a model and a receipted write
actually lands (see M4 check 4.3). This is a candidate issue for a future
lane, not something this milestone fixes.

### M2 Tailnet access

Files: `deploy/compose.yml` (tailscale service), `deploy/tailscale/serve.json`,
`deploy/proof/tailnet.sh`, `deploy/proof/compose-lint.sh`.

Finish line, `deploy/proof/compose-lint.sh` (CI-runnable):

| # | Assertion | How it is decided |
| --- | --- | --- |
| 2.1 | Images are pinned. | Every `image:` in `compose.yml` carries `@sha256:`. |
| 2.2 | No key in the tree. | `TS_AUTHKEY` appears only as a Docker secret reference; `git grep -E 'tskey-'` finds nothing. |
| 2.3 | State persists. | A named volume is mounted at `TS_STATE_DIR`. |
| 2.4 | Kizuki has no network of its own. | The kizuki service has `network_mode: service:tailscale` and no `ports:`. |
| 2.5 | Capabilities are empty. | `cap_drop: [ALL]` on both services; no `cap_add`, no `devices`. |

Finish line, `deploy/proof/tailnet.sh` (runs from a second tailnet node;
receipts in the PR):

| # | Assertion | How it is decided |
| --- | --- | --- |
| 2.6 | Node is on the tailnet with the tag. | `tailscale status --json` on the peer lists the node online with `tag:kizuki`. |
| 2.7 | Health over the tailnet. | `curl -fsS https://<node>.<tailnet>.ts.net/health` → `"ok":true`. |
| 2.8 | MCP read over the tailnet with a token. | `POST /v1/mcp/system_health` with `Authorization: Bearer` → 200, `"ok":true`. |
| 2.9 | Fail closed without a token. | Same call with no header → 401 `unauthorized`. |
| 2.10 | Public IP is dark. | `curl --max-time 5 http://<public-ip>:$PORT/health` from outside the tailnet is not 200. |
| 2.11 | stdio MCP over Tailscale SSH. | `tailscale ssh kizuki -- kizuki-mcp --vault /vault --owner` answers `initialize` and `tools/list`; the list contains `propose` and `correct`. |
| 2.12 | Node identity survives restart. | `docker compose restart`; the node id in `tailscale status --json` is unchanged. |

Known risk: `startServeHttp` rejects requests whose URL hostname is not
loopback. `tailscale serve` proxies to `127.0.0.1:PORT`; whether the
forwarded `Host` header satisfies that check is decided by 2.7, not by
reading docs. If it fails, the fix is a one-line proxy header rule in
`serve.json`, never a relaxation of the loopback rule in core.

### M3 Box golden snapshot and one-command setup

Files: `deploy/box/bootstrap.sh`, `deploy/box/README.md`,
`deploy/proof/box.sh`.

`bootstrap.sh` on a fresh Box VM: install nothing global beyond what the
image ships (Docker is present), clone the pinned tag or copy the compose
bundle, create the `TS_AUTHKEY` secret from an argument that is never
echoed, `docker compose up -d`, wait for 1.4. Then `box stop` and snapshot.

Finish line, `deploy/proof/box.sh` (runs from the owner's machine with the
`box` CLI; receipts in the PR):

| # | Assertion | How it is decided |
| --- | --- | --- |
| 3.1 | One command, five minutes. | Wall clock from `box new --from <snapshot>` to 2.7 passing is ≤ 300 s, measured by the script. |
| 3.2 | Stop and start keep the vault. | `box stop`, `box start`; 1.6 passes without re-import. |
| 3.3 | Fork is a fresh identity. | A forked box comes up as a different tailnet node id and its `/vault/.kizuki/vault-id` differs. |
| 3.4 | Stranger proof runs against it. | `scripts/stranger-proof.sh` (when it lands from its own lane) exits 0 with the box as target; until then this row is marked BLOCKED, not PASS. |

### M4 Canon writing from configuration

Files: `packages/core/src/serve/config.ts` (read `[ports]` and
`[ports.llm]` from `<vault>/.kizuki/serve.toml` per RFC 0002 §12.1),
`packages/cli/src/commands/serve.ts` (resolve the `llm` port, build
`RailHooks` with `model_ref` and `claims`), `packages/cli/src/commands/doctor.ts`
(the on/off line already exists), tests under `packages/cli/test/serve/`.

This is the lane that turns the box from a search index into the product
the README describes. It is core plus CLI, owned separately from M1 to M3,
and lands as its own pull request. It touches no contract: `kizuki.llm/v1`
and `RailHooks` already exist.

Finish line, `bun test packages/cli/test/serve/model-wiring.test.ts`
(CI-runnable), with the loopback fake endpoint from `packages/llm/test`:

| # | Assertion | How it is decided |
| --- | --- | --- |
| 4.1 | Off by default. | Fresh vault, no `[ports]`: `serve --once` writes 0 canon receipts; `doctor` prints `canon writing: off (no model configured …)`. |
| 4.2 | On when configured. | `[ports] llm = "kizuki.llm.openai-compatible"` pointing at the fake: `doctor` prints `canon writing: on (kizuki.llm.openai-compatible:<model>@127.0.0.1)`. |
| 4.3 | A write is receipted and attributed. | After import plus `serve --once`, `audit --json` has ≥ 1 receipt with `writer` = the loop writer and `model_ref` equal to 4.2's string. |
| 4.4 | The write is reversible. | `undo <receipt>` exits 0 and the page bytes equal the receipt's `before` hash. |
| 4.5 | Plaintext key fails closed. | `secret_ref = "sk-literal"` makes `serve` exit non-zero with `config_invalid` before any rail runs. |
| 4.6 | Budget holds. | `[budget] canon_writes_per_run = 1` with two extractable fixtures yields exactly 1 receipt and a `budget_exhausted` run receipt. |
| 4.7 | Model down is not empty. | Fake endpoint returning 503: run receipt records `unavailable`; the checkpoint does not advance (RFC 0002 §1.1 E11). |
| 4.8 | Container path. | `deploy/proof/container.sh --with-model` starts the fake endpoint inside the container and 4.2 to 4.4 pass there; with `--network none` still on. |

### M5 `kizuki agent add`

Files: `packages/cli/src/commands/agent.ts`, tests under
`packages/cli/test/agent/`. Verbs: `agent add <name> [--owner-agent]`,
`agent list`, `agent revoke <name>`, `agent rotate <name>`. Composition
over `addAgent`, `setGrant`, `revokeAgent`, `rotateToken`; no new core
logic.

Finish line, `bun test packages/cli/test/agent` (CI-runnable):

| # | Assertion | How it is decided |
| --- | --- | --- |
| 5.1 | The token is shown once. | `agent add ada` prints the token on stdout exactly once; stderr, the audit table and `serve` logs never contain it. |
| 5.2 | Default is least privilege. | `agent list --json` shows `ceiling: "personal"` for `ada`. |
| 5.3 | Owner agent is private. | `agent add grace --owner-agent` shows `ceiling: "private"`; a `private` page is returned to `grace` and withheld from `ada`. |
| 5.4 | Token works over both transports. | `kizuki-mcp --token-env` with ada's token answers `search`; `POST /v1/mcp/search` with the same bearer → 200. |
| 5.5 | Revoke closes the door. | After `agent revoke ada`, both transports return `unauthorized` on the next call. |
| 5.6 | Duplicate name refuses. | Second `agent add ada` exits non-zero with a stable error and mints no token. |

### M6 Documentation and pledge honesty

Files: this document's status flipped to SHIPPED per milestone, a
"Deploy on a Box" section in `README.md` of at most one paragraph, and
`deploy/README.md` as the operator guide.

Finish line (CI-runnable): `bun run verify` green on the head; every
command example in `deploy/README.md` appears verbatim in a proof script;
the README paragraph contains the sentence that names tailscaled as
egress outside Kizuki.

## 4. Order and dependencies

```
M1 ──► M2 ──► M3
M4 (independent; core+cli; own PR)
M5 (independent; cli; own PR)
M3 row 3.4 waits on the stranger-proof lane.
M3 "value" (canon written on the box) waits on M4.
M6 last.
```

M1, M2 and M3 are one pull request from this branch. M4 and M5 are separate
branches and pull requests because they change the CLI's public seam and
need the two review axes on their own head.

## 5. Definition of done for the whole goal

All of the following on one exact head, listed in the pull request body
with the command and its exit code:

- `deploy/proof/container.sh` exit 0 in CI (Linux job).
- `deploy/proof/compose-lint.sh` exit 0 in CI.
- `deploy/proof/tailnet.sh` exit 0 from a second tailnet node, transcript attached.
- `deploy/proof/box.sh` exit 0 with the measured seconds for 3.1, transcript attached.
- `bun test packages/cli/test/serve/model-wiring.test.ts` and `bun test packages/cli/test/agent` exit 0 (after M4 and M5 merge, rerun on the merged head).
- `bun run verify` exit 0.
- No open P0 issue reproduces against the deploy path (issue #403 lane 2).

Anything short of that list is progress, not done.

## 6. Non-goals

- A multi-tenant hosted service. Canon is plaintext under a host-trust
  threat model and the ledger's encryption seam is reserved, not built.
  The shape here is "your box, our image." Changing that needs an RFC.
- Fixing the Windows `fsync` failure. It deserves its own issue and fix.
- Running screenpipe on the box. It reads the owner's desktop.
- TUN-mode tailscale, Funnel, or any public exposure.
- A compiled binary. The image runs from the tree with pinned bun; the
  packaging lane owns binaries.

## 7. Collision check (2026-09-03)

- Open PR #402 touches `.github/workflows/ci.yml` only. M1's CI job is a
  new job in the same file; rebase on whichever merges first.
- No open PR touches `packages/cli/src/commands/serve.ts`,
  `packages/core/src/serve/config.ts`, or `packages/cli/src/commands/agent.ts`.
- Issue #403 lanes 5 (distribution) and 6 (proof automation) are the
  umbrella. This plan should be recorded there as a sub-lane before M1's
  pull request opens.
- `packages/cli/AGENTS.md` and `packages/core/AGENTS.md` govern M4 and M5.
  M1 to M3 add no code under `packages/`.
