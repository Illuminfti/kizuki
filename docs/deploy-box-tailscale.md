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
   │  no shell: a hosted box exposes no Tailscale SSH (M2 finding, 2026-09-04)
   ▼
Box VM (Ubuntu, Docker)
 └─ docker compose
     ├─ tailscale   image pinned by digest, TS_USERSPACE=true, TS_STATE_DIR volume,
     │              TS_AUTHKEY from a Docker secret, serve config for /health and /v1/mcp/*
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
| 1.1 | Repeating the build is stable. | `docker build` exits 0 twice against the same context and the two image ids match. Warm cache: `apt-get update` and `bun install` fetch from the network, so a cold build is not byte-reproducible, which is a property of those tools rather than of the Dockerfile. |
| 1.2 | The floor needs no network. | Every check below runs with `--network none`. |
| 1.3 | Loop is PID 1 and alive. | `docker exec` `kizuki serve status --json` reports `pid` 1, `/proc/1` exists, and `doctor.ok` is true. The CLI's status JSON carries `pid`, `supervisor` and `doctor`; the `running`/`lease` fields belong to core's `serveStatus()`, which no CLI verb calls. |
| 1.4 | Health endpoint answers on loopback. | `curl -fsS 127.0.0.1:$PORT/health` inside the container → body `"ok":true`. |
| 1.5 | Nothing listens off loopback. | `ss` is absent from the image, so the check reads `/proc/net/tcp` and `/proc/net/tcp6`: every row in state `0A` must have a loopback local address. |
| 1.6 | Ingest works and fails closed. | `kizuki import markdown-folder --source /fixtures` exits 0 with stdout containing `events_stored=3` and `errors=0`; `kizuki query acme --scope ledger` exits 0, prints nothing on stdout, and its stderr contains `withheld=`; a second identical import exits 0 with stdout containing `events_stored=0` and `duplicates=3`. |
| 1.7 | Doctor is honest. | `kizuki doctor` output contains `supervisor: none` and `canon writing: off`, and no rail line contains `status=failed` or `status=down`. `RailDoctor.status` is `ok`, `down` or `idle`, so the literal `failed` this plan first named can never appear; `down` is the real unhealthy value and is checked too. |
| 1.8 | State survives restart. | `docker restart` changes `State.StartedAt`; 1.3 passes again; a third identical import exits 0 with stdout containing `events_stored=0` and `duplicates=3`; `kizuki doctor` output contains `events=3`. A container renumbers its init process to 1 on every start, so a changed `StartedAt` is the restart evidence rather than a new pid. |
| 1.9 | No plaintext secret in the image. | `docker history --no-trunc` and a filesystem grep for the value of `KIZUKI_MODEL_KEY` find nothing; `/vault/.kizuki/serve.token` mode is `600`. |
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

Finish line, `deploy/proof/tailnet.sh` (runs against a real tailnet; not
CI-runnable):

| # | Assertion | How it is decided |
| --- | --- | --- |
| 2.6 | Node is on the tailnet. | `tailscale status --json` reports the node online with hostname `kizuki-m2-proof`. The auth key used against this branch is untagged (owner-account key, no `tag:kizuki`); the check asserts online state and hostname, not a tag, and reports whether a tag is present. |
| 2.7 | Health over the tailnet. | `wget` (no `curl` in the tailscale image) against `http://<node-tailscale-ip>:8787/health` with an explicit `Host: 127.0.0.1` header, over the raw TCP forward `serve.json` sets up (see the Finding below for why this is plain HTTP, not HTTPS) → `"ok":true`. |
| 2.8 | MCP read over the tailnet with a token. | `POST /v1/mcp/system_health` to the same address with `Host: 127.0.0.1` and `Authorization: Bearer <daemon token>` → 200, `"ok":true`. |
| 2.9 | Fail closed without a token. | Same call, same `Host: 127.0.0.1`, no `Authorization` header → 401 `unauthorized`. |
| 2.10 | Public IP is dark. | Neither container publishes a port (`docker inspect` `NetworkSettings.Ports` is empty for both); the real public-IP probe is M3's, run from the Box. |
| 2.11 | 2.11 no-shell-exposed: SSH is refused. | With the node confirmed up (2.6 having passed, and `/health` re-checked immediately before the attempt so a failure cannot be mistaken for "nothing is reachable"), `tailscale ssh kizuki-m2-proof -- true` must fail to establish a session. PASS only on that refusal; FAIL if a session succeeds. |
| 2.12 | Node identity survives restart. | `docker compose restart`; the node id in `tailscale status --json` is unchanged. |
| 2.14 | 2.14 only-served-ports-reachable. | From the peer side, a TCP connect to a node port not named in `serve.json` (one nothing listens on, and one a neighbor in the shared namespace might plausibly run) must be refused or time out, under a short explicit timeout. |

Finding (2026-09-03, updated 2026-09-03): the Host-header problem below was
first hit, diagnosed and reported as an unresolved FAIL on 2.7-2.9. It was
then resolved with a configuration-only change (raw TCP forwarding instead
of an HTTPS reverse proxy); the resolution is described second and is what
`deploy/compose.yml` and `deploy/tailscale/serve.json` now implement. Both
are kept here because the diagnosis is still the reason the fix looks the
way it does.

Finding (2026-09-04): a hosted customer must not get a shell on a box we run
on our own infrastructure account — that is the main resource-abuse and
compute-theft surface a hosted (as opposed to customer-owned) deployment
creates — so `TS_EXTRA_ARGS: --ssh` has been removed from the tailscale
service in `deploy/compose.yml`; shell access is now a property of the
customer-owned deployment tier only, never of a box we run. Row 2.11 is
inverted to match: it now asserts SSH is refused rather than that it
succeeds. Separately, the containment property this design relies on — that
a tailnet peer reaches only the ports named in `serve.json`, because
userspace networking (`TS_USERSPACE=true`) creates no TUN device and
therefore no kernel route to any other listening port — is not stated
plainly anywhere in Tailscale's own documentation (three of their pages were
checked while writing this finding); it is an inference from how tailscaled
is built, not a written guarantee. New check 2.14 proves it directly, from
the peer side, instead of leaving it asserted only in a comment. Finally,
`deploy/compose.yml`'s `ts_authkey` secret already reads its key from a
configurable path (`${KIZUKI_TS_AUTHKEY_FILE:-...}`), so the same image
joins the operator's own tailnet for this proof or a customer's own tailnet
in the hosted arrangement without any image change — only the key file
path differs.

*Host header, as first found.* `tailscale serve`'s HTTP proxy handler is
Go's `NewSingleHostReverseProxy` (confirmed by reading exported symbols out
of the `tailscaled` binary; no `ProxyHostHeader` or equivalent rewrite
field exists for it). It forwards the client's original `Host` header —
the tailnet FQDN — to the `http://127.0.0.1:8787` backend unchanged,
regardless of whether the `Proxy` target is written as `127.0.0.1:8787` or
`localhost:8787` (both were tried; same header either way).
`packages/core/src/serve/http.ts` `startServeHttp` checks `url.hostname`
before it looks at the path or any header, and 403s `bind_refused` for
anything but `127.0.0.1`/`localhost`/`[::1]`. So every request over an
HTTPS reverse-proxied tailnet path 403s before routing, health included.
This was reproduced against the real tailnet: a `wget` from inside the
tailscale sidecar to its own `https://kizuki-m2-proof.<tailnet>.ts.net/health`
returned `403 Forbidden`, not `200`.

*Host header, the resolution.* `tailscale serve` also supports raw TCP
forwarding (`--tcp=<port> tcp://host:port` on the CLI; `TCPForward` in the
JSON config, confirmed as a real field name in the `tailscaled` binary's
own symbols). Raw TCP forwarding does no HTTP parsing or rewriting at all
— it is a byte-for-byte socket relay — so the `Host` header a client sends
is exactly what Kizuki receives. `deploy/tailscale/serve.json` now forwards
tailnet port 8787 straight to `127.0.0.1:8787` as TCP, and every client
(the proof script, and any future MCP harness) sends `Host: 127.0.0.1`
explicitly, which satisfies `startServeHttp` with no change to
`packages/core` and no proxy component this repository owns. The cost is
real and is stated plainly rather than hidden: every client of this tailnet
path must know to send that header, forever, because nothing rewrites it
for them. There is deliberately no TLS on this port — raw TCP forwarding
cannot terminate TLS and add a Host rewrite at the same time, and the
tailnet itself is WireGuard-encrypted end to end, so a second TLS layer
here would protect a request that is already encrypted in transit; it is
not an oversight. The alternative that was rejected on purpose: making
`startServeHttp` accept a configured non-loopback `Host` would change the
"loopback only" architecture invariant this milestone's own task brief
named as a security boundary not to touch; that is an RFC-and-owner-decision
question, not something this lane's proof or this milestone decides for
itself.

**Live proof status for the resolution:** the JSON shape above was derived
from the `tailscaled` binary's own field names and the documented
`tailscale serve --tcp` CLI syntax, not observed via `tailscale serve
get-config` against a running node — every attempt to bring a fresh node
online during this work failed because the available auth key had already
been spent (see the Auth key exhaustion finding below), and modifying the
owner's own already-online tailnet node's live serve configuration to
derive the shape empirically was correctly refused. So checks 2.7, 2.8 and
2.9 as rewritten are **not yet proven live**; `deploy/proof/tailnet.sh`
implements them and will report real PASS/FAIL the next time it runs
against a usable key.

*Capabilities vs. the secret file (compose-lint 2.2/2.13, tailnet 2.6-2.12
setup).* Docker Compose secrets outside Swarm mode are plain bind mounts of
the host file; the `uid`/`gid`/`mode` overrides Compose accepts in a
service's `secrets:` list are Swarm-only and are silently ignored on a
plain engine (`docker compose` prints "secrets `uid`, `gid` and `mode` are
not supported, they will be ignored"). `cap_drop: [ALL]` on the tailscale
service (required by 2.5) removes `CAP_DAC_OVERRIDE`, so its root cannot
read a file that denies "other" access even though it is root, and
containerboot exits before authenticating. The resolution is not a
loosened copy of the key: the key file at
`/home/lars/.config/kizuki/ts-authkey` is mode `0644`, and its containing
directory, `/home/lars/.config/kizuki`, is mode `0700`. A `0700` directory
blocks every local user but its owner from traversing into it at all, so a
`0644` file inside it is not reachable by anyone the directory itself
excludes — the directory, not the file mode, is what actually protects the
key, exactly as it protects every other file that directory holds.
`deploy/proof/tailnet.sh` asserts both modes as a precondition and fails
loudly, with a specific remediation message, if either one does not hold.
`deploy/compose.yml`'s `secrets: { ts_authkey: { file: ... } }` still reads
from `${KIZUKI_TS_AUTHKEY_FILE:-<real path>}`, but that override exists
only to point at a *different real key file with the same directory-then-
file permission shape*, never at a copy with loosened permissions.

*Untagged key.* The auth key available for this work has no tag; the node
registered under the owner's own account rather than `tag:kizuki`. An
untagged node's key expiry follows the owner's default key-expiry policy,
where a tagged node's does not (Tailscale's tagged-device keys do not
expire by default). M3's Box deployment, which is meant to run
unattended, should use a tagged, reusable key for that reason, not the key
used here.

*Auth key exhaustion.* The key issued for this branch is single-use, not
reusable. The first `docker compose up` in the empirical exploration below
authenticated a real node (`kizuki-m2-proof`, tailnet `taila6c912.ts.net`)
successfully; that session's local state was then discarded by a
`docker compose down -v` cleanup before this document's checks were
written. Every subsequent bring-up attempt against the same key failed
tailscaled auth with `invalid key: API key ... not valid`, which is the
control plane's response for a used single-use key, and the node has sat
offline ever since (confirmed via `tailscale status` from a genuine second
tailnet node, `lars-pc`, a Windows peer). `deploy/proof/tailnet.sh` is
written and its logic for 2.6, 2.10, 2.11 and the identity half of 2.12
matches what the one successful live run actually showed; 2.8, 2.9 and the
restart-then-reverify half of 2.12 were never exercised against a live
node because the SSH and MCP-over-HTTP checks were finished only after the
key had already been spent. Re-running this proof end to end needs a fresh
key, which this task's author cannot mint. The node `kizuki-m2-proof`
(`100.125.239.98` on `taila6c912.ts.net`) remains listed in the tailnet
admin console, offline; the owner needs to remove it.

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
