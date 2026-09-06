# Grok fleet wave controller owner review at `80280b`

Review date: 6 September 2026.

Reviewed file: `grok_fleet_wave.py`, SHA-256
`80280b0413b60f3f509409dd470b66fcebbfe38ace93f3db771ae6d7942ac8aa`.
The file was uncommitted in the shared book workspace. This review is pinned to
that byte identity because another owner may repair the controller afterward.

## Decision

**BLOCK scaling beyond the current, separately observed first wave.** The
controller correctly rejected P003 attempt 1 when the installed CLI exposed a
21-tool superset, and P003 attempt 2 positively demonstrated the intended exact
six-tool surface after adding the explicit deny complement. That is meaningful
evidence for the installed CLI. It does not close the launch, deadline,
capacity, provenance, and parser defects below.

Do not stop the already running bounded workers solely because of this review.
They have a read-only `/repo`, isolated `/work`, a read-only pinned image root,
dropped capabilities, `no-new-privileges`, individual CPU/memory/pid limits,
no active MCP servers or hooks, an exact six-tool init, and the expected skills.
Retain their receipts and treat their output as unreviewed preparation. Apply
the repairs before a new wave or any 100-parallel claim.

## Findings

### 1. BLOCKER: init rejection happens after assignment execution begins

The process receives the real assignment when `Popen` starts it
(`grok_fleet_wave.py:161-170`). The controller reads and validates init later in
the monitor loop (`:172-188`). P003 attempt 1 proves the consequence: before the
controller stopped the invalid 21-tool session, its output already contained an
assistant turn and five `read_file`/`list_dir` calls against the assignment.
`admitted: false` is therefore controller bookkeeping, not a pre-execution
security boundary.

For the current headless design, freeze the successful P003 attempt 2 preflight
as a certificate over the exact binary, image, config, model, positive tool
list, deny complement, permission mode, and command shape. Refuse any launch on
certificate drift. Keep validating each init, but describe it as runtime drift
detection. A true pre-prompt gate would require a two-stage protocol such as
ACP, which is outside this bounded repair.

### 2. P1: workers have no runtime or fleet deadline

After launch the loop waits until every Docker client exits (`:172-201`). There
is no per-worker timeout, global deadline, TERM/KILL escalation, or cancellation
cleanup. A stuck process can pass the supplied 7 September 08:24:59 UTC deadline
and live indefinitely.

Record monotonic start time per attempt. At 40 minutes, or at the earlier global
UTC deadline, stop the exact owned container with a bounded wait, kill it if it
does not drain, and write `INTERRUPTED` plus the controller reason. A timeout is
never `completed_unreviewed` and cannot silently reuse the same attempt.

### 3. P1: launch-all-before-monitor defeats bounded admission

The controller completes the entire packet launch loop before it examines any
worker output (`:151-172`). With 100 IDs, a bad auth state, tool surface, model,
or provider response can be replicated 100 times before the first rejection or
pressure signal is processed.

Interleave launch and monitoring in bounded batches. Default to at most 16
workers in a wave. Accept a value above 16, capped at 100, only with an explicit
controller capacity certificate. Stop admission on the first certificate/init
drift or host/provider pressure; let already safe work drain.

### 4. P1: individual limits do not enforce aggregate capacity or disk bounds

Each container gets 1 GiB, one CPU, and 128 pids (`:115-127`), but the
controller has no aggregate reservation. At 100 workers the configured memory
sum is about 100 GiB. The host report available to the operator showed about
109 GiB available, leaving too little margin for the host and control plane.
P003 attempt 2 used about 44.75 MiB and 50 pids at one observation, which is a
useful canary and not a peak projection.

The one 35 GiB disk check occurs before launch (`:147-149`). Stdout, stderr,
`/work/out`, and Grok state remain unbounded; attempt 2 stdout had already grown
to roughly 799 KiB during this review.

Before each admission, read real host memory, disk, inode, and pid pressure.
Preserve at least 20 GiB available memory, cap modeled fleet memory at 80 GiB,
and continuously preserve the 35 GiB disk floor. Enforce positive byte limits
for stdout, stderr, output, and state and interrupt a worker that crosses them.
The controller must account across the wave rather than multiply an unchecked
per-container maximum.

### 5. P1: one malformed init can crash the whole controller

The monitor opens a concurrently written file, reads one line, and calls
`json.loads` and `set(init["tools"])` without error isolation (`:174-180`).
Invalid UTF-8, malformed JSON, a non-object value, an unhashable tool member, or
a truncated writer followed by exit can throw out of the fleet loop. Already
started containers then lose supervision.

Give every worker a bounded init deadline. Validate UTF-8, JSON, object shape,
and field types inside a per-worker exception boundary. Reject that worker with
the parse reason and continue supervising the rest. EOF without one complete
init is a failed attempt.

### 6. P1: operational safety checks disappear under `python -O`

Existing snapshot identity, duplicate/unknown packet selection, required skill,
MCP, and hook checks use `assert` (`:33-36,143-160`). Python removes these checks
under optimization. They are launch invariants and must use explicit exceptions
or per-worker rejection paths.

### 7. P1: the writable mount includes the assignment and its policy

The whole generated workspace is mounted read/write (`:120`). The six-tool
worker can therefore alter `packet.json`, `prompt.txt`, `AGENTS.md`, `ROLE.md`,
its copied skills, and `RESULT.template.md`, despite `/work/out` being its only
declared write path. The controller records no post-run hashes that would expose
this drift.

Mount `/work` read-only and overlay only `/work/out` with a nested writable bind
mount. Hash the prompt, packet, role, instructions, template, and selected
skills before launch; require the same immutable-input certificate when
reconciling output.

### 8. P1: source and packet base identities are not fully bound

Snapshot reuse checks only `base_sha` inside an ordinary writable identity JSON
file (`:32-46`). It does not rehash the retained archive or extracted contents.
The path uses only the first 12 unvalidated characters of the base. Selection
does not require each packet's `base_sha` to equal the roster's base
(`:143-149`), yet the worker receipt later records the packet value. A malformed
roster can therefore pair source A with a receipt claiming source B.

Require a canonical 40-hex base, require every selected packet base to equal the
roster base, validate packet/skill IDs as single safe path components, and use a
fresh unique snapshot or reverify its archive and content manifest before every
wave. Bind those hashes into the launch receipt.

### 9. P2: retries do not have unique runtime or receipt identity

The suffix changes the host worker directory but not `task_id`, container name,
or receipt fields (`:50-54,115-127,164-168`). The actual `P003` and
`P003-attempt2` directories both identify the task as `P003` and container as
`kizuki-grok-p003`. This is ambiguous after interruption and prevents concurrent
reconciliation of a stale attempt.

Record a validated attempt number, unique `worker_key`, and idempotency key.
Include the attempt in the Docker name and every controller event. Refuse a new
attempt while a prior exact-owned container is live or its outcome is
unreconciled.

### 10. P2: init equality omits binding metadata and accepts malformed sets

The gate checks subtype, model, OAuth source, and set equality for tools
(`:174-183`). It does not require `type: system`, `cwd: /work`, the expected
permission mode, a unique nonempty session ID, empty MCP list, or the exact
expected skill set. Set comparison also ignores duplicate tools.

Validate the complete typed init contract. Compare a duplicate-free list of
canonical tool strings to the manifest, with ordering normalized by the
controller. Require exact skills, including `handoff-work`, and require the
runtime metadata above. P003 attempt 2 is the positive fixture: OAuth,
`grok-4.6`, `/work`, `bypassPermissions`, no MCP, the five expected skills, and
exactly `run_terminal_command`, `read_file`, `search_replace`, `list_dir`,
`grep`, and `write`.

### 11. P2: the standard OAuth mount needs practical tool-level defense

The official CLI needs its private read-only OAuth file mounted at
`/grokstate/auth.json` (`:123-127`). The container and prompt minimize exposure,
but the agent shares the process namespace and has read and terminal tools. The
prompt prohibition at `:85-86` is useful policy, not enforcement.

Keep the standard official auth arrangement for this authorized bounded work.
Add installed-CLI permission denies for `Read(/grokstate/**)` and
`Edit(/grokstate/**)` and verify they remain active under always-approve without
reading the token. Preserve the prompt prohibition, read-only auth mount,
non-root uid, minimal filesystem, and absence of other host credentials. This
is defense in depth; do not describe it as airtight isolation against a
deliberately adversarial worker with arbitrary terminal execution.

### 12. P2: terminal receipts lack runtime and result provenance

The launch receipt records the requested model, image, expected tools, and
skills (`:164-168`). It omits binary hash/build, config and command hashes,
prompt/packet/role/skill hashes, attempt identity, limits, and the expected
session. On exit it records only code and whether `result.json` exists
(`:189-197`). It neither parses nor binds that result to task/base/status and
deliverable hashes. `--rm` also discards Docker state before the controller can
distinguish OOM from a controller stop when both surface as code 137.

Pin and record the mounted Grok binary hash and observed version/build, image,
config, complete command policy, immutable inputs, limits, attempt, and init.
Parse `result.json` as a bounded object and require its task/base/status and
in-scope artifact hashes. Preserve `completed_unreviewed` as a non-acceptance
state. Retain or capture the exact Docker terminal reason before removing the
container, then remove only the controller-owned name.

## Positive evidence retained

- P003 attempt 1 was rejected with `admitted: false`, exit 137, and no result;
  its logs were preserved. The repeated-stop loop present in the earlier runner
  was fixed before this pinned review.
- P003 attempt 2's init exactly matched the intended six-tool set only after
  combining a nonempty `--tools` value with the explicit full
  `--disallowed-tools` complement. This installed version does not implement the
  positive allowlist as a standalone final clamp.
- `inspect --json` reported Grok 1.0.13, project trust, no MCP servers, no hooks,
  disabled external compatibility surfaces, and the five expected active
  skills. The runtime init reported OAuth, `grok-4.6`, `/work`, and
  `bypassPermissions`.
- The exact source base was supplied as
  `32713ad98899a8d1e8ac21a2ebbe3170f6af51a0`; `/repo` is a read-only Git archive
  with no Git metadata or runtime data.

The evidence inspected was limited to `stdout.ndjson`,
`controller-receipt.json`, and `inspect.json` for P003 attempts. No auth file,
worker state, token, model call, configuration, running container, or global
service was read or changed by this review.

## Repair acceptance cases

The repair should include deterministic tests for these behaviors:

1. Duplicate/unknown IDs, non-40-hex or mismatched bases, unsafe ID/skill path
   components, stale snapshot hashes, extra skills/MCP/hooks, and missing
   certificate all fail before process launch even under `python -O` semantics.
2. Partial, invalid UTF-8, malformed JSON, scalar JSON, missing/wrong fields,
   duplicate/non-string/extra tools, wrong cwd/mode/model/auth, duplicate session
   ID, and init timeout reject only that worker while a peer completes.
3. Default wave 17 rejects without a valid capacity certificate; certificate
   expiry or host values below the 20 GiB memory or 35 GiB disk floor stop new
   admission without killing safe in-flight work.
4. Per-worker 40-minute and global UTC deadlines stop then kill, write one
   terminal interruption receipt, and leave no controller-owned container.
5. `/work` policy/input files are read-only while `/work/out` is writable; input
   hashes remain stable and an out-of-scope result path is rejected.
6. Attempt IDs produce distinct work directories, Docker names, session
   identities, receipts, and idempotency keys; a live or uncertain predecessor
   blocks reuse.
7. Result absence, oversize, invalid JSON, task/base mismatch, unlisted or
   digest-mismatched artifact, nonzero exit, OOM, and controller stop cannot
   become `completed_unreviewed`. A valid result can reach only that unaccepted
   state until independent review.
8. Binary/config/command/tool-deny drift from the P003 attempt 2 certificate
   blocks launch. The installed CLI's exact six-tool init is the positive
   compatibility fixture.

Independent review must rerun these tests against the repaired byte identity
and perform one no-op control canary before any larger wave. A green unit suite
does not retroactively qualify the currently running outputs or establish 100
simultaneous provider-side inference.
