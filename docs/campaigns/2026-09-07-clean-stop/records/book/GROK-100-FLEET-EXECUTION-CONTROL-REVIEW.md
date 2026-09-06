# Grok 4.6 100-worker fleet: execution-control owner review

Review date: 6 September 2026. Deadline supplied to the operator:
7 September 2026 at 08:24:59 UTC.

## Decision

**CONDITIONAL GO for 100 independently contained headless Grok 4.6 workers.**
Do not represent one workflow with `agent_budget = 100` as 100 simultaneous
agents. Do not launch the fleet until the 16-worker concurrent canary, exact
nonempty tool allowlist check, resource projection, and controller receipt
checks below pass.

The installed CLI canary reported by the operator is useful positive evidence:
CLI `1.0.13` build `5e9a585`, `apiKeySource: oauth`, requested model
`grok-4.6`, observed usage model `grok-4.6-build`, one completed turn, and a
successful result in 1,695 ms. It does not yet qualify a 100-worker launch or
the worker permission boundary.

The practical topology is one controller, 100 containers, one Grok headless
process per container, and one immutable assignment per process. Static review
workers share a read-only source snapshot. Writers receive unique writable
clones or worktrees. Compiler and integration work is admitted through a
separate four-slot controller queue. All containers belong to one aggregate
host cgroup so 100 individually reasonable limits cannot collectively exhaust
the host.

## Material findings and launch blockers

### 1. A workflow budget is a call count, not simultaneous capacity

The official reference source calls `agent_budget` an absolute cumulative cap
on logical child calls. A `parallel()` panel spends the full panel before it
launches, and wider panels queue behind a separate per-run cap
(`04-slash-commands.md:293-303`). The current reference implementation defaults
that cap to 32 and clamps it to the machine's available parallelism
(`host_service.rs:21-47`). This host has 12 CPUs, so one run would admit at most
12 live children under that implementation. A session permits at most four
active workflow runs (`manager.rs:19-20,128-135`), and children also acquire a
process-tree sampling semaphore before each model request
(`subagent/mod.rs:306-308`; `sampler_turn.rs:1658-1667,2160-2167`).

These are current-reference facts, not proof about the older installed build.
That version gap makes workflows a worse control surface for this deadline.
The independent-process topology gives each requested worker an unambiguous OS
identity and lets the outer controller establish the fleet-wide cap.

### 2. The installed tool clamp must be observed, not inferred from flags

The operator's installed-binary canary found that `--tools ''` advertises the
default set of 25 tools, including `spawn_subagent`; an empty value is not an
empty allowlist. It also found `spawn_subagent` still advertised with
`--no-subagents`. Therefore neither spelling is an acceptable fleet boundary.

Every worker must receive a **nonempty** allowlist of canonical tool IDs. The
controller must parse the worker's structured `system/init` event and reject
the worker before assignment unless the observed tool set equals the expected
set. Reject supersets as well as missing tools. The current source says the
session `--tools` and `--disallowed-tools` restrictions are intended to be a
final clamp that follows child definitions (`config.rs:771-778,1331-1355`), but
the installed init event is the evidence that matters.

Use separate allowlists:

- Static reviewers: native file read, list, and search tools only.
- Writers: native read, search, and edit tools; no shell and no subagent tool.
- Test/integration workers: native read/search plus the shell tool, restricted
  to four admitted containers and a disposable source copy.
- No worker receives workflow, subagent, MCP discovery, web fetch/search,
  browser, deployment, messaging, or secret-store tools unless its assignment
  explicitly requires one and the launch manifest records it.

Do not use a skill's `allowed-tools` field as enforcement. The reference code
parses and stores that field, while skill invocation only injects the skill
body as model instructions (`08-skills.md:99-114`;
`skills/skill.rs:39-63`). Put the hard tool set in the agent definition and the
session CLI clamp, then verify the init event.

### 3. General-purpose children are overprivileged by default

Subagents are enabled by default, and `general-purpose` has full capabilities
(`16-subagents.md:3-5,56-66`). Subagents inherit all connected parent MCP
servers unless `mcpInheritance` changes that default
(`16-subagents.md:190-214`). Their isolation default is `none`, while worktree
isolation is explicit (`16-subagents.md:126-137,226-234`).

Fleet workers should not be orchestrators. Remove the subagent and workflow
tools through the observed allowlist. If a task genuinely uses an in-process
child, define a project agent with an explicit `tools` list,
`disallowedTools`, `maxTurns`, `discoverSkills: false`, `inheritSkills: false`,
`injectDefaultTools: false`, and `mcpInheritance: none`; use a unique worktree
for edits. Agent definitions support these fields and apply the session tool
clamp afterward (`xai-grok-agent/src/config.rs:697-778`).

Workflow children do not accept an independent cwd: the workflow host submits
`cwd: None` and inherits the run's directory (`host_service.rs:538-558`). Do
not assign mutually untrusted writable tasks to one workflow directory.

### 4. Containment must be outside the model permission policy

Grok's sandbox is off by default. Built-in `workspace` can read the whole host;
built-in `strict` can still write the current working directory
(`18-sandbox.md:24-46`). Built-in-profile application failure warns and can
continue without enforcement; an explicitly requested custom profile fails
closed (`18-sandbox.md:171-176,215-224`). On Linux, deny globs cover only files
that exist at launch, so exact secret paths are required for a durable deny
(`18-sandbox.md:143-160`). `restrict_network` blocks child-process networking,
but not the in-process LLM, web-search, or fetch clients
(`18-sandbox.md:224-229`). Hooks also fail open on crash or timeout
(`22-permissions-and-safety.md:425-429`).

Use the container and aggregate cgroup as the primary boundary:

- Pin the image by digest; read-only root filesystem; drop all capabilities;
  `no-new-privileges`; bounded pids, memory, CPU, tmpfs, files, and log bytes.
- Mount only the task manifest, source snapshot, private state directory, and
  private result directory. Never mount the host home, SSH agent, Docker or
  Podman socket, Git credentials, cloud credentials, or shared writable cache.
- Static review mounts source read-only. Each writer gets one unique writable
  copy. Dependency caches may be shared read-only after their digest is pinned.
- Keep long-lived OAuth material in the root-owned auth bridge. A worker must
  not receive a readable host credential file. If the installed CLI temporarily
  requires a file, provide a worker-private short-lived copy and record its
  lifetime; this is weaker and needs a direct deny plus an environment policy.
- Filter command environments with `inherit = "core"`, default secret-name
  excludes enabled, and an `include_only` list. The documented default inherits
  everything and excludes nothing (`18-sandbox.md:233-248`).
- Remove in-process web/MCP tools from the tool allowlist. Child network denial
  does not constrain those tools.

Run noninteractive static workers in `dontAsk` with native read tools. Run the
few shell or edit workers with `--always-approve` only inside the container
boundary and with explicit deny rules. The installed CLI accepts
`--always-approve` and `--permission-mode`; it does not accept the newer
`--approval-mode` spelling. Auto mode is unsuitable for unattended work because
a call that would prompt fails in a noninteractive session
(`22-permissions-and-safety.md:98-103`).

### 5. One hundred process-local limits do not make a fleet limit

The controller owns admission. Per-container `--cpus 1` and memory limits are
insufficient because their totals can still consume all host resources. Place
every worker under one cgroup with aggregate CPU, memory, pids, and I/O limits.
Reserve capacity for the controller, auth bridge, storage, and operator access.
Derive the numeric aggregate memory limit from the 16-worker canary's p95 RSS
and observed host baseline rather than multiplying a guessed allowance.

The 16-worker canary must record peak and p95 RSS, CPU time, open descriptors,
process/thread count, output and state-directory growth, prompt latency, token
usage, authentication refresh behavior, and 429/5xx rates. Admit 100 only when
the p95 projection plus the reserved host margin fits. Stop new admission on
memory, disk, inode, pid, auth, or provider-rate pressure. Let in-flight
read-only work drain unless the hard cgroup limit or credential boundary is at
risk.

Compilation is a separate scarce resource. Only four containers may receive a
shell/compiler assignment concurrently. Other writers return a patch and
declared checks; a clean verifier container performs the build. This preserves
100 live model workers without allowing 100 local builds to contend for 12 CPUs.

### 6. “100 simultaneous” needs an observable definition

The controller may claim **100 overlapping worker lifetimes** when 100 distinct
container IDs and CLI process IDs are concurrently live and each has emitted a
valid init event. It may claim **100 prompts submitted concurrently** only when
a barrier releases 100 admitted workers and their structured request intervals
overlap. It must not claim 100 provider-side inference jobs; that requires
provider telemetry the local CLI does not expose.

Release workers from one controller barrier. Compute maximum overlap from
controller monotonic timestamps, retain the 100 init events, and record the
minimum and maximum dispatch skew. A process count alone does not prove 100
model requests.

## Ready-to-use launch policy

Before any worker starts, the controller validates one immutable manifest:

1. Exactly 100 unique task IDs, worker IDs, output directories, and idempotency
   keys exist. Every writable path has one owner. Static-review source is a
   clean, immutable commit and tree.
2. Image digest, CLI version/build, requested model, prompt digest, source
   commit/tree, tool allowlist, permission mode, sandbox/config hashes, limits,
   timeout, and result schema are pinned.
3. The single-worker installed canary is retained. The 16-worker concurrent
   canary and resource projection pass. Authentication has enough remaining
   life for the deadline or the root-owned bridge has a tested refresh path.
4. The controller creates launch receipts before barrier release. It accepts a
   worker only after the init event reports the expected cwd, permission mode,
   exact tool set, OAuth source, and requested Grok 4.6 family.
5. A monotonic wall-clock deadline sends TERM, waits a bounded drain interval,
   then sends KILL. Each timeout becomes `INTERRUPTED`, never success. Output,
   stderr, state, and artifact bytes are bounded independently.
6. Controller cancellation stops admission first. It never relaunches an
   uncertain writable attempt under the same idempotency key.

The exact installed command must be generated from the retained `1.0.13
--help` output. Its required shape is:

```text
<pinned grok binary> -p <immutable prompt>
  --permission-mode <dontAsk|bypassPermissions>
  --tools <NONEMPTY comma-separated canonical IDs>
  --disallowed-tools <subagent/workflow and any task-specific denies>
  --max-turns <positive bound>
  --output-format streaming-json
```

Use the installed flag spelling and reject unknown-option fallback. Parse the
first init event before trusting later output. Do not interpolate task text into
a shell command; pass it as an argument or file through an argv-safe launcher.

## Receipt schema and acceptance rule

The controller, not the worker, is the authority. It writes a launch envelope
before execution and a terminal envelope after reconciling container state,
structured output, filesystem artifacts, and Git identity. A worker's final
text is only evidence input.

```json
{
  "schema": "grok-fleet-receipt/v1",
  "fleet_id": "20260906-grok46-100-a",
  "task": {
    "task_id": "T-001",
    "worker_id": "W-001",
    "attempt": 1,
    "idempotency_key": "sha256:<fleet/task/input/attempt>",
    "objective_sha256": "sha256:...",
    "mode": "static-review",
    "write_owner": null
  },
  "source": {
    "repository": "owner/repo",
    "commit": "40-hex",
    "tree": "40-hex",
    "dirty": false,
    "assignment_paths": ["packages/core/**"]
  },
  "runtime": {
    "image_digest": "sha256:...",
    "cli_version": "1.0.13",
    "cli_build": "5e9a585",
    "model_requested": "grok-4.6",
    "model_observed": "grok-4.6-build",
    "api_key_source": "oauth",
    "permission_mode": "dontAsk",
    "tools_expected": ["<canonical-id>"],
    "tools_observed": ["<canonical-id>"],
    "config_sha256": "sha256:...",
    "skills": [{"name": "review", "sha256": "sha256:..."}]
  },
  "limits": {
    "max_turns": 8,
    "deadline_utc": "2026-09-07T08:24:59Z",
    "memory_bytes": 0,
    "cpu_quota": "measured-policy-id",
    "pids": 0,
    "output_bytes": 0
  },
  "observation": {
    "container_id": "...",
    "process_id": 0,
    "barrier_epoch": 1,
    "started_monotonic_ns": 0,
    "finished_monotonic_ns": 0,
    "exit_code": 0,
    "terminal_state": "SUCCEEDED",
    "turns": 1,
    "tokens": 0,
    "stdout_sha256": "sha256:...",
    "stderr_sha256": "sha256:..."
  },
  "result": {
    "output_schema_valid": true,
    "artifacts": [{"path": "result.json", "sha256": "sha256:...", "bytes": 0}],
    "candidate_commit": null,
    "candidate_tree": null,
    "checks": [{"argv_sha256": "sha256:...", "exit_code": 0, "log_sha256": "sha256:..."}],
    "findings": []
  },
  "acceptance": {
    "state": "PENDING_REVIEW",
    "reviewer_worker_id": null,
    "reviewed_candidate": null,
    "controller_signature": "sha256-or-signature-over-canonical-receipt"
  }
}
```

Replace zero limit placeholders with measured positive values before launch.
Canonicalize and hash the receipt before signing or appending it. Never allow a
worker to overwrite launch facts.

`SUCCEEDED` means the process produced a structurally valid result. It becomes
`ACCEPTED` only when all of these hold:

- Init identity and tool set matched the launch manifest exactly.
- The process exited cleanly before the deadline and produced one valid terminal
  result; no truncation, orphan process, OOM, auth fallback, or rate-limit
  exhaustion occurred.
- Every artifact exists within the worker's assigned result directory and its
  size and digest match. No unowned writable path changed.
- A writer returns an exact commit, tree, direct parent, clean status, and
  scope-conforming diff. Uncommitted output is not accepted.
- A distinct verifier worker checks the exact candidate in a fresh container
  and records command argv, exit code, and log digest. Self-review cannot fill
  `reviewer_worker_id`.
- The controller signs the reconciled receipt and appends it once. Duplicate or
  ambiguous attempts remain `INTERRUPTED` or `REJECTED`; they are not silently
  retried as the same attempt.

## Recovery limitations

Current-reference workflows persist same-process journals, but process-restart
interruptions are terminal and same-process resume is not exactly once
(`04-slash-commands.md:311-315`). The independent-process fleet should assume
the same conservative rule. Read-only tasks may retry under a new attempt and
idempotency key. Writable tasks require controller reconciliation of the old
container, output directory, Git state, and receipt before a new attempt.

This review authorizes no launch, configuration mutation, global setting,
credential operation, merge, or release claim. It defines the controls needed
for the already authorized fleet launch decision.

## Evidence boundary

The static source reviewed was the official `xai-org/grok-build` clone at
`TEMP/kizuki-grok-build-reference-20260906`, commit
`72a61251fcffb464bcc687aeb5a998e5a98ec0c9`, tree
`c890c4e12eacdf26fe646e522a12aa5af675726f`, clean at inspection. That source
is newer than the installed `1.0.13` binary. Source citations establish design
and known limits; only installed-binary canaries establish the actual launch
surface. The 16-worker receipt and exact installed allowlist receipt remain
required before this verdict can advance from CONDITIONAL GO.
