# ADR-002: Fenced multi-harness execution protocol

**Status:** Proposed for independent security, scheduler, and GitHub-evidence
review. Nothing in this document enables execution by itself.

## Decision

Phase 2 is a protocol upgrade, not an unlock of the bootstrap state names. The
Gauntlet will run one trusted scheduler around four untrusted worker harnesses:
Codex, Claude Code, Cursor, and Grok Build. Workers receive one immutable job,
one isolated checkout, and no controller, GitHub, or merge authority. The
scheduler alone validates process and repository evidence and commits an atomic
phase result to the append-only ledger.

The localhost observer remains GET-only. A separate, default-dry-run GitHub
bridge collects and publishes sanitized evidence. The controller owns the
global merge fence; GitHub is the external evidence source, not a mutex.

This design binds Kizuki decisions C2 and C5:

- each delivery lane has one owned workspace and independent `spec`,
  `regression`, and `independent` review lenses;
- a delegated maintainer may merge only an exact reviewed head with the
  required green checks and a custom merge subject;
- Grokbot observes receipts and blockers but has no scheduling, credential,
  repository-write, GitHub-write, or merge route.

## Trust boundaries

| Component | May read | May write | Must never receive |
| --- | --- | --- | --- |
| controller/scheduler | typed state, sanitized receipts, registered attempt metadata | event ledger and SQLite projection | model auth, worker prompts in observer data |
| sandbox runner | one job specification and one isolated attempt tree | attempt tree and private raw evidence directory | controller state, host home, GitHub token, another attempt, common Git dir |
| harness | bounded prompt, attempt tree, its own least-privilege vendor session, vendor-only egress | attempt tree and fresh per-attempt home | another identity, merge credential, controller DB/socket, host home, arbitrary network |
| GitHub bridge | typed local receipt, exact GitHub PR/check/review state | no mutation by default; idempotent evidence comment only under explicit operator grant | raw prompt/log, model credentials, private paths, lease/fence tokens |
| observer/Grokbot | allowlisted DTO fields and receipt hashes | nothing | principals, tokens, prompts, logs, commands, paths, credentials |

Harness output is testimony, never authority. A PASS exists only after the
trusted scheduler verifies the relevant process, repository, command, and
remote evidence and emits the phase result atomically with its state change.

## Principal and role model

The configured principal is an operator-attested authority domain bound to an
adapter identity receipt. It is never supplied by model output. Changing a
display holder, process ID, or run ID does not create a new principal.

Roles are:

- `BUILDER`: produces a commit or patch from the exact registered base.
- `VERIFIER`: runs required tests against the exact submitted subject SHA.
- `SPEC_REVIEWER`: checks the implementation against its issue/spec.
- `REGRESSION_REVIEWER`: checks architecture, safety, and regressions.
- `INDEPENDENT_REVIEWER`: supplies the third Kizuki C2 review lens.
- `INTEGRATOR`: collects fresh remote evidence and requests the one exact-head
  merge under delegated-maintainer authority.
- `POST_MERGE_VERIFIER`: verifies a fresh clean checkout of the resulting main
  SHA. It may share the verifier authority domain, but remains distinct from
  builder, all reviewers, and integrator.

For a task attempt, the builder, verifier, each reviewer, and integrator must be
distinct configured principals. One principal may not satisfy two required
review lenses. Adapter aliases that resolve to the same authority domain or
identity receipt do not count as independent. A normal attempt therefore needs
at least six independently attested authority domains. The four harness products
must all participate across the campaign, but product count is not authority
cardinality; a product may have more than one separately configured identity.

## Task protocol

Stable states distinguish an unowned completed phase from an actively leased
phase:

```text
DISCOVERED
  -> READY                         controller admission
READY
  -> LEASED                        BUILDER claim; attempt += 1
LEASED
  -> RUNNING                       builder start
RUNNING
  -> SUBMITTED                     atomic SUBMISSION PASS
SUBMITTED
  -> VERIFYING                     VERIFIER claim
VERIFYING
  -> VERIFIED                      atomic VERIFICATION PASS
  -> CHANGES_REQUESTED             atomic VERIFICATION FAIL
VERIFIED
  -> REVIEWING                     next required reviewer claim
REVIEWING
  -> VERIFIED                      one review PASS; more lenses required
  -> REVIEWED                      final required review PASS
  -> CHANGES_REQUESTED             atomic review FAIL
REVIEWED
  -> INTEGRATING                   INTEGRATOR claim + global merge claim
INTEGRATING
  -> MERGE_AUTHORIZED              atomic PRE_MERGE PASS
  -> CHANGES_REQUESTED             only when GitHub proves no merge occurred
MERGE_AUTHORIZED
  -> MERGED                        exact GitHub merge confirmed
  -> MERGE_RECOVERING              external outcome uncertain
MERGED
  -> POST_MERGE_VERIFYING           POST_MERGE_VERIFIER claim
POST_MERGE_VERIFYING
  -> POST_MERGE_VERIFIED            atomic exact-main verification PASS
  -> POST_MERGE_FAILED              post-mutation failure; pause campaign
POST_MERGE_FAILED
  -> REMEDIATING                    transfer held claim to linked remedy task
REMEDIATING
  -> REMEDIATED                     linked repair chain finalized
  -> REVERTED                       linked revert chain finalized
  -> POST_MERGE_FAILED              child failure; fence remains held
POST_MERGE_VERIFIED
  -> DONE                           controller-only full-chain finalization
CHANGES_REQUESTED
  -> READY                          controller; next builder claim is new attempt
```

Generic state mutation may perform only explicit administrative failure,
supersession, or recovery edges. It must reject all success edges and `DONE`.
Every result edge emits one schema-versioned event that both inserts its typed
receipt and changes task state in the same ledger append and projection
transaction.

The scheduler-facing interface is deliberately narrow:

```text
claim_phase(task, role, principal, expected_version, ttl) -> LeaseGrant
start_build(LeaseGrant, expected_version)
commit_phase(LeaseGrant, expected_version, PhaseResult)
reject_phase(LeaseGrant, expected_version, PhaseResult)
authorize_merge(LeaseGrant, expected_version, FreshGitHubEvidence) -> MergeGrant
confirm_merge(MergeGrant, expected_version, FreshGitHubEvidence)
recover_task(task, expected_version, RecoveryEvidence)
recover_merge(task, expected_version, FreshGitHubEvidence)
finalize_task(task, expected_version, FreshGitHubEvidence)
transfer_remediation(task, linked_task, kind, expected_version, RecoveryEvidence)
finalize_remediation(task, linked_task, expected_version, RemediationEvidence)
```

Workers never call this interface. Lease resources are scheduler-derived:

```text
task:<task-id>:<attempt>:builder
task:<task-id>:<attempt>:verifier
task:<task-id>:<attempt>:spec-reviewer
task:<task-id>:<attempt>:regression-reviewer
task:<task-id>:<attempt>:independent-reviewer
task:<task-id>:<attempt>:integrator
task:<task-id>:<attempt>:post-merge-verifier
merge/global
```

Every lease/result must match task, attempt, role, principal, run ID, epoch,
monotonic fence token, expected row version, and subject SHA. A failure receipt
ends that phase for the attempt. Returning to the builder starts a new attempt;
old receipts remain evidence and never authorize the new attempt.

## Schema and ledger migration

The v1 ledger is retained byte-for-byte. Projection schema v2 adds typed task
protocol data; it does not rewrite old events. A versioned replay function
understands both event families. Legacy `receipt.recorded` entries replay as
historical `SUBMISSION` evidence with `authoritative = 0` and can satisfy no v2
gate.

Conceptual v2 additions:

```sql
tasks += subject_sha, merge_sha, active_role, recovery_from

phase_leases(
  resource PRIMARY KEY, task_id, attempt, role, run_id, principal_id,
  token, expires_at, heartbeat_at, epoch
)

phase_receipts(
  id PRIMARY KEY, task_id, attempt, phase, role, principal_id, verdict,
  subject_sha, base_sha, result_sha, evidence_sha256, github_evidence_id,
  lease_resource, lease_token, merge_fence_token, epoch, authoritative,
  created_at,
  UNIQUE(task_id, attempt, phase, role)
)

merge_claims(
  resource PRIMARY KEY CHECK(resource = 'merge/global'), token, task_id,
  attempt, subject_sha, base_sha, pr_number, merge_operation_id,
  grant_generation, status, epoch, linked_remediation_task_id, updated_at
)

merge_operations(
  merge_operation_id PRIMARY KEY, task_id, attempt, grant_generation,
  parent_merge_operation_id, request_state, grant_sha256, request_sha256,
  response_sha256, epoch, updated_at
)
```

The three review receipts use distinct roles and therefore distinct unique
keys. All free-form diagnostics stay in mode-0600 raw evidence files outside
the worktree. Authorization consumes only bounded enums, validated identifiers,
exact SHAs, integer references, and SHA-256 digests.

Opening an old store must remain safe. Projection metadata has an explicit
`schema_version` and migration state. Absence of metadata is accepted as v1
only when every v1 table has the exact known layout and the ledger contains no
v2 event. A committed v2 projection deliberately changes the legacy receipt
layout with a defaulted version/authority column, causing the old binary's
exact-schema check to refuse it. The new binary can open and replay either
known layout; it never guesses an unknown or partially edited schema.

Deployment first stops the controller, snapshots the event ledger plus the
SQLite database/WAL/SHM together, and runs a no-write full replay/migration
preflight against a copy. The live migration then uses this crash-safe order:

1. Under the exclusive writer lock, one transactional SQLite DDL commit creates
   v2 tables/columns and records `schema_version=2, state=PREPARED`. No v1 data
   is destroyed. A crash before this commit leaves an ordinary v1 store.
2. Append and fsync one `schema.v2` ledger event containing the exact v1
   inventory digest and deterministic disposition plan. If the DDL exists but
   this event does not, the new binary resumes at this step; the old binary is
   already locked out by the receipt-layout change.
3. In one projection transaction, replay/apply `schema.v2`, materialize legacy
   receipts as non-authoritative, apply the dispositions, and set
   `schema_version=2, state=COMMITTED`. A crash after ledger fsync but before
   this commit is healed by normal ledger-tail replay. Reapplying the event is
   idempotent and verifies the same inventory digest.
4. Full replay into an empty v2 projection must exactly match the migrated
   projection before the controller can claim an epoch.

The disposition plan retires every v1 lease and marks every nonterminal
campaign recovery-required. `LEASED`, `RUNNING`, and ordinary recovery states
return to `READY` with their prior state recorded and require a new builder
attempt. Legacy `SUBMITTED` or verification/review states are represented as
`CHANGES_REQUESTED -> READY`, making a new attempt mandatory; no legacy receipt
can cross that boundary. Any legacy integration, merge, or post-merge state is
not reset: it retains a global recovery hold and pauses for explicit remote
reconciliation. Every crash point—before DDL, after DDL, after ledger fsync, and
before projection commit—is exercised repeatedly against a copied real v1
store before live migration. Rollback after PREPARED restores the complete
pre-migration snapshot and exact old binary; mixing old code with v2 state is
forbidden.

## Attempt workspace

Linked Git worktrees are not used for untrusted workers because their `.git`
file exposes the writable common repository metadata. Each attempt instead gets
an isolated clone whose object store and metadata are owned by that attempt.
The trusted runner derives a bounded binary diff from the exact registered
base/head using fixed Git arguments and verifies ancestry, paths, byte limits,
file modes, symlinks, and a no-submodule policy. The controller consumes only
that validated diff: it never imports worker refs, objects, configuration,
hooks, alternates, attributes, or transport settings. It applies the diff to a
fresh controller-owned integration checkout with hooks, external diff, ambient
Git configuration, filters, and network disabled, then commits the resulting
tree under trusted controller configuration. It never asks a worker to push.

An immutable task specification binds:

- campaign ID, task ID, attempt, controller epoch, and task-spec SHA-256;
- repository identity, exact base SHA, expected branch, and issue/spec URL;
- allowed and forbidden path prefixes;
- fixed harness adapter/principal/role;
- required verification commands selected from a named command policy;
- wall, CPU, memory, process, and output budgets;
- network profile and expiry;
- expected receipt schema.

The specification contains no token or secret. It is written once with mode
0600 and is hash-checked before launch and before result admission.

## Process containment

There is no direct-exec fallback. The trusted runner launches one transient
systemd user service (`Type=exec`, `KillMode=control-group`) that launches one
bubblewrap namespace. Unit names are derived from validated opaque IDs; callers
cannot supply unit syntax. Every unit must install
`BindsTo=kizuki-gauntlet.service`, `After=kizuki-gauntlet.service`, a bounded
`TimeoutStopSec`, and `SendSIGKILL=yes`; launch fails if the binding cannot be
installed or the controller unit is not active.

The transient service enforces a bounded runtime, CPU quota, memory maximum,
task maximum, stop timeout, SIGKILL fallback, no new privileges, private tmp,
strict system protection, and `PrivateNetwork=yes`. Systemd owns the network
namespace and brings up its loopback device. Bubblewrap unshares user, PID,
IPC, UTS, and cgroup namespaces individually but deliberately does not unshare
networking again. It uses a new session, an empty environment, tmpfs `/tmp`,
read-only system libraries and a hash-pinned complete harness release tree, one
writable `/work`, and one fresh mode-0700 per-attempt `/job-home`. Neither host
`/home`, controller state, GitHub credentials, other workspaces, nor a common
Git directory is mounted.

Each adapter has fixed arguments owned by controller code:

```text
codex exec --json --ephemeral --ignore-user-config --ignore-rules
  -C /work -s workspace-write -a never -

claude --print --output-format stream-json --no-session-persistence
  --safe-mode --restricted --permission-mode dontAsk
  --permission-prompts none --strict-mcp-config

cursor-agent --print --output-format stream-json
  --sandbox disabled --trust --workspace /work

grok --single <prompt> --output-format streaming-json --cwd /work
  --permission-mode dontAsk --disable-web-search --no-subagents
```

Cursor's native sandbox is deliberately disabled only inside the proven outer
containment because AppArmor makes it unusable on this VPS. Claude tools are an
explicit minimal set proven by a compatibility test. No guessed Grok sandbox
profile is passed.

Cancellation stops the transient unit and verifies that its entire control
group exited. `BindsTo` stops it immediately when the controller service dies;
on controller startup, enumeration and forced stopping of every attempt unit
whose epoch/token is no longer current remains defense in depth. Raw
stdout/stderr are bounded and stored mode 0600 outside the worktree. Public
receipts contain hashes, sizes, exit/timeout status, unit identity digest,
resource outcome, exact base/head, diff digest, and executable/argv/bwrap
digests—never prompt text, auth data, logs, or paths.

## Network and identity containment

The safe default is no network. `--share-net`, host networking, and a broad
HTTP proxy are forbidden. Real model execution may be enabled only after a
separate egress component passes review and integration tests.

The egress design is a CONNECT-only allowlisting proxy outside the sandbox,
addressed through a mounted Unix socket. A tiny fixed relay inside the systemd-
owned private network namespace binds only `127.0.0.1` and exposes that socket
as HTTP proxy transport. Bubblewrap inherits that namespace and must not
unshare networking again. The exact systemd/bubblewrap/relay topology must pass
a real-VPS loopback and fail-closed integration test before a vendor profile is
enabled. The relay itself runs in a second, smaller bubblewrap filesystem
namespace inside the same controller-bound transient unit. It receives only a
hash-pinned trusted relay release, its exact Unix proxy socket bind, read-only
system libraries, `/proc`, `/dev`, and tmpfs; it receives no `/work`,
`/job-home`, `/home`, controller state, generic host `/run`, identity root, or
other socket. The enclosing unit additionally uses `ProtectHome=tmpfs`, strict
system protection, no capabilities/new privileges, an address-family allowlist,
and the same bounded cgroup/process-tree controls. A compromised relay therefore
cannot escape into ambient user state. The outer proxy:

- accepts only syntactically valid `CONNECT host:443` requests;
- matches a versioned per-adapter enumerated-host allowlist; public-suffix or
  broad wildcard rules are forbidden;
- resolves and dials itself, rejects literal/private/link-local/loopback IPs,
  pins all resolved addresses for the connection, and rechecks redirect-free
  connection metadata;
- has byte, connection, idle, and wall limits tied to the attempt;
- cannot reach the controller observer, Unix control socket, host services, or
  GitHub;
- logs only time, adapter profile, allowlist decision, bounded hostname hash,
  byte counts, and outcome;
- transports end-to-end vendor TLS and never terminates or inspects credentials.

Every principal has an exclusive, dedicated, revocable, least-privilege vendor
identity generation outside all ordinary user homes. Identity bootstrap is a
separate operator action and reviews an adapter-specific minimum artifact
allowlist. At launch, the broker materializes only those minimum session
artifacts into a fresh per-attempt writable `/job-home`; it never copies a full
existing home. One principal may have only one active attempt, preventing
concurrent session rotation races. Dedicated roots and attempt homes are
mutually inaccessible. All per-attempt session changes are discarded after the
unit exits; a filename allowlist is never treated as identity proof. If a vendor
requires token rotation, the route becomes stale and a separate trusted broker
must validate issuer/client and the immutable configured account binding,
atomically create a new identity generation, and re-attest account, route,
executable, and network-profile hashes. Any mismatch or unverifiable refresh is
quarantined and requires operator rebootstrap. No task may reuse the prior
principal or route receipt after any proposed session write-back.

A model-controlled harness can read its own materialized vendor session. This
is an explicit residual risk: isolation limits the credential to a dedicated,
revocable identity with no GitHub, maintainer, host, control-plane, or other
vendor authority. A credential broker/protocol that keeps the secret outside
the harness would be required to make a stronger claim. Existing user homes or
auth/config directories are never mounted or copied wholesale. Bootstrap
produces only a non-secret version/executable/auth/route receipt. That receipt
is current only while its executable hash, identity generation, network-profile
hash, and TTL remain current.

No worker starts until the VPS integration gate proves: systemd limits apply;
bubblewrap fails closed; `/work` is the only writable repository; host home,
controller state, common Git metadata, and other identities are unreadable;
network is absent in the default profile; vendor profile reaches only its
allowlisted endpoint set; cancellation kills grandchildren; logs stay bounded;
controller death immediately stops the unit; systemd supplies usable private
loopback while bubblewrap cannot escape it; and a harmless authenticated call
succeeds from that dedicated identity. The relay test also proves it cannot
read host home, controller state, any identity, attempt workspace, or an
unlisted host socket.

## GitHub evidence bridge

`kizuki-gauntlet-github-bridge` is a separate entry point and process. Its
default is `--dry-run`; dry-run performs zero HTTP mutations and emits the
canonical body/digest it would use. The controller/observer/adapters contain no
GitHub client or token.

`collect` fetches the PR immediately and emits one canonical receipt containing
only repository slug, PR number, exact head/base SHA, draft/mergeable state,
required check names/conclusions/URLs, structured review references, observed
time, and its SHA-256. Admission requires:

- expected head equals the freshly observed PR head;
- base is `main`, with freshly observed remote base SHA;
- the PR is not draft;
- every explicitly required check is completed `SUCCESS` on that head;
- optional conclusions are accepted only by explicit policy allowlist;
- three structured review receipts for `spec`, `regression`, and `independent`
  use distinct non-author principals and the same exact head;
- fields are bounded and sanitized; raw text, logs, paths, prompts, tokens, and
  credentials are rejected.

Branch-protection/ruleset API visibility is currently unavailable for this
private repository plan. A local required-check policy is necessary but not
sufficient: phase-2 merge enablement also requires a current, out-of-band,
authenticated proof that direct writers are excluded and the expected checks
are enforced on `main`. If that proof is absent, stale, or ambiguous, no merge
route exists. The bridge never infers protection from visible checks.

Publication uses deterministic markers. An immutable evidence comment is keyed
by the hash of campaign, ledger tip, and receipt hash. Matching marker/body is a
no-op; collisions or duplicate markers fail closed. Before the first POST, the
controller acquires a durable local publication operation/fence keyed by
repository, issue, and immutable idempotency key. Its state is persisted as
`INTENT -> SENT -> CONFIRMED|UNCERTAIN`, with expected body digest, publisher,
and recovered comment ID. Only one process may hold it. After POST—or after any
lost response—the bridge paginates and re-lists comments before confirmation;
zero matches remain uncertain, one exact publisher/body match is adopted, and
multiple/foreign/colliding matches create an incident and fail closed. GitHub
is not treated as the mutex, and a `SENT` operation is never blindly re-POSTed.

One mutable status comment is keyed by campaign and clearly says
`NOT AUTHORIZATION`. It names the immutable receipts it summarizes. Its
configured publisher login and canonical comment ID are persisted at creation.
A later PATCH is allowed only when both ID and freshly observed author match
that binding. Foreign markers, missing authors, changed authors, more than one
matching marker, or a marker whose body does not match its stored digest fail
closed. Publication operations serialize status creation and updates as well.
Pagination is mandatory before every mutation.

The bridge never decides or retries a merge. After the controller holds
`merge/global`, it refetches head/base/check/review evidence. The controller
requires `PR.baseRefOid` to equal a freshly read `refs/heads/main`, records
`PRE_MERGE`, creates a stable `merge_operation_id`, and mints generation 1 of a
one-shot exact-head `MergeGrant`. Re-adoption may increment its generation but
can never change the stable operation ID. The signed/canonical grant binds
repository, PR, head SHA, base SHA, merge strategy, custom-subject digest,
authority issuer/reference, configured C5 delegate identity, expiry, controller
epoch, merge-fence token, operation ID, grant generation, and
`max_requests = 1`.

The deterministic maintainer adapter runs in a controller-bound killable unit.
It verifies its authenticated login is the configured delegate, then asks the
controller over its owned Unix socket for one final epoch/token/operation/
generation validation immediately before the HTTP request. It re-reads
`PR.baseRefOid == refs/heads/main`, persists operation state
`PREPARED -> SENT` before the call, and submits one conditional merge with
an HTTP body whose `sha`, merge method, custom title, and body are constructed
only from and exactly match the grant-bound head, strategy, subject/body
digests, and receipt reference. It then persists `CONFIRMED` or `UNCERTAIN` and
can never consume that operation generation again. An operation observed in
`SENT` or `UNCERTAIN` is queried, never reissued. GitHub must prove `mergedAt`,
merge commit, resulting `main`, and inclusion of the exact expected head. A
fresh clean checkout verifies that main SHA before finalization.

## Global merge fence and recovery

`merge/global` is not an expiring ordinary lease. GitHub cannot observe a local
fence token, so expiry cannot make an uncertain external mutation safe. The
claim remains held from integration through finalization, or until an explicit
proof shows no merge occurred. On restart or integrator loss it becomes
`RECOVERY_REQUIRED`; no other task may acquire it.

On controller death, `BindsTo` kills the merge-adapter unit. Before recovery,
the new controller kills any surviving old-epoch unit and revokes every old
grant by incrementing its grant generation. A `PREPARED` operation that never
reached `SENT` may be aborted only after fresh no-merge proof. A `SENT` or
`UNCERTAIN` operation is never given another request budget. Recovery receipt
chains follow the stable operation ID and explicit generation lineage; a new
epoch may re-adopt the claim with a new local fence token, so they do not
incorrectly require one unchanged token across controller epochs.

Recovery outcomes are exhaustive:

- PR unmerged and base unchanged: record a proven abort, invalidate pre-merge
  authority, release the fence, and request changes/new attempt.
- exact PR/head merged: record recovered merge evidence, re-adopt the fence in
  the new epoch, and continue at `MERGED`.
- remote state conflicts or remains ambiguous: retain the fence, pause the
  campaign, and record an incident. Never retry.
- recorded merge or post-merge verification interrupted: revalidate GitHub
  merge/main evidence, re-adopt the fence, and resume at `MERGED`.
- post-merge failure: enter `POST_MERGE_FAILED`, pause the campaign, and keep the
  confirmed parent operation and global fence. The controller may create
  exactly one linked repair or authorized revert task, then transfer—not
  release—the global claim to that child and move the parent to `REMEDIATING`.
  The consumed parent operation remains immutable. The child traverses the
  normal builder, verifier, three-reviewer, integrator, conditional merge, and
  post-merge verification chain. Its integration creates a new child
  `merge_operation_id`, linked to the failed parent operation, with a fresh
  one-request budget and exact-head/base evidence while retaining exclusive
  possession of the transferred global claim. An independently authorized
  revert follows the same chain; it is not a privileged shortcut.

  No unrelated task or integrator can acquire the claim. A linked child cannot
  use ordinary `finalize_task()` and therefore stops at
  `POST_MERGE_VERIFIED`. `finalize_remediation(parent, child, ...)` validates
  the parent is `REMEDIATING`, the child is `POST_MERGE_VERIFIED`, the
  transferred claim, parent/child operation linkage, both full receipt chains,
  and the exact resulting remote-main SHA. It then emits one schema-versioned
  event whose single projection transaction inserts the terminal `REMEDIATION`
  or `REVERT` receipt, moves the child to `DONE`, moves the parent to
  `REMEDIATED` or `REVERTED`, and releases `merge/global`. Replay applies those
  effects atomically as one event. Ordinary finalization explicitly rejects a
  task carrying a transferred remediation claim. The terminal receipt binds
  parent and child operation IDs, linked task, failed original merge SHA,
  resulting repair/revert SHA, and exact-SHA independent post-remediation
  verification. A failed child returns the parent to `POST_MERGE_FAILED` with
  the claim held for explicit operator disposition. The original merge never
  receives a false `POST_MERGE_VERIFIED` receipt.

A new controller epoch marks every nonterminal campaign recovery-required and
admits no new build or merge claim until stale phase leases, attempt units, and
merge claims have explicit dispositions. Builder crashes return to `READY` as
a new attempt; verifier/reviewer crashes return to the last stable state on the
same attempt; integration crashes require merge recovery.

The fence serializes Gauntlet merges only. A current authenticated repository-
policy receipt proving exclusion of external direct writers is a hard merge-
enablement gate. Until GitHub makes that policy observable or an approved
out-of-band proof is recorded, the controller has no merge route. After
enablement, any unexpected remote-main advance is an incident and pauses
integration.

## Campaign completion gates

Generic campaign transitions cannot claim success.

- `QUIESCING -> VERIFYING`: no new claims, no live leases/attempt units, no
  unresolved merge claim, and every task is `DONE`, `SUPERSEDED`, `REMEDIATED`,
  or `REVERTED`. The latter two count only when their linked child task is
  `DONE` and the terminal parent/child receipt chain validates.
- `VERIFYING -> RC_READY`: an exact-main campaign verification receipt exists
  and no unresolved incident exists.
- `RC_READY -> VALIDATING`: explicit release-validation start.
- `VALIDATING -> RELEASED`: exact-SHA release receipt exists.
- direct `RC_READY -> RELEASED` is removed.

The 7-day daemon run and 14-day shadow estate remain qualification gates after
the concentrated 72–120 hour build campaign; agent concurrency cannot compress
elapsed-time evidence.

## Observer contract

All POST/PUT/PATCH/DELETE requests remain 405. Added DTO fields are restricted
to task active role/subject SHA/merge SHA, receipt role/verdict/subject/result
SHA, merge state (`FREE`, `HELD`, `RECOVERY_REQUIRED`) plus task/attempt, and
controller execution/recovery/heartbeat state. Principals, evidence bodies,
tokens, commands, worktree paths, identities, prompts, and logs never appear.

Scheduling and control are in-process or over an owned mode-0600 Unix socket,
not loopback HTTP. Grokbot may poll and summarize; it cannot approve, lease,
retry, publish, merge, or release.

## Enablement sequence

1. Approve this ADR independently on scheduler, containment, GitHub-evidence,
   and threat-model axes.
2. Implement schema-v2 replay and `TaskProtocol` test-first while keeping every
   execution and GitHub path unreachable.
3. Implement and prove offline systemd+bubblewrap execution with synthetic
   binaries and no network.
4. Implement the default-dry-run GitHub bridge and fixture tests.
5. Implement/review the Unix-socket egress proxy and dedicated identity
   bootstrap; perform harmless per-harness compatibility probes.
6. Run an end-to-end synthetic repository drill with at least six distinct
   principals while exercising all four harness products, crash injection,
   uncertain merge simulation, and observer secret corpus.
7. Back up live state, run no-write replay/migration preflight, deploy with
   execution disabled, and verify observer regression.
8. Enable one signed task specification at a time. No campaign-wide wildcard
   switch exists.

## Acceptance gates

- exhaustive state/role/transition matrix and atomic result crash injection;
- stale attempt/SHA/version/epoch/token/principal/role receipts all rejected;
- three distinct exact-head review lenses required;
- at least six independent authority domains satisfy one complete normal lane;
- process identity aliases cannot fake independence;
- concurrent phase and merge claims have exactly one winner;
- an uncertain merge is never attempted twice across crash windows;
- restart forces recovery and blocks new claims;
- legacy replay works but legacy receipts never authorize v2;
- campaign success is impossible with incomplete tasks, live units/leases,
  merge recovery, missing exact-SHA receipts, or unresolved incidents;
- adapter expiry, binary change, quota block, identity-generation change, or
  egress-policy change prevents assignment;
- real VPS containment proves resource limits, no ambient filesystem/network,
  process-tree cancellation on explicit stop and controller death, usable
  systemd-private loopback, bwrap inheritance without host-network escape, and
  bounded evidence;
- dry-run GitHub bridge performs zero mutations; publication is idempotent and
  sanitized; exact-head/base/check/review drift fails;
- observer remains GET-only and a secret corpus is absent from every response;
- one synthetic PR reaches `DONE` and RC gating with exact-SHA evidence from at
  least six distinct authority domains while all four harness products are
  exercised across the campaign.

Until all applicable gates pass, `Supervisor.run()` remains hard-disabled,
configuration rejects execution enablement, and the running observer continues
to report execution disabled.
