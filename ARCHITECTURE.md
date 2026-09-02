# ADR-001: Probe-only controller before harness execution

**Decision:** Separate campaign coordination from harness execution. The first
Gauntlet release holds state, lease fencing, receipts, local inventory, and a
read-only observer only.

**Why:** A multi-harness loop has a large blast radius: hidden credentials,
concurrent worktree mutation, accidental remote operations, and false progress.
The controller must remain useful while all harnesses are unavailable or
untrusted. SQLite WAL provides concurrent readers; JSONL hash chaining gives a
portable recovery/audit source. SQLite is a projection, never the sole truth.

**Consequences:** This is not an autonomous worker launcher. Adapter `probe()`
is a bounded fixed-argv installation/version check with sanitized output. It is
not authentication proof or a route test. An operator may record the sanitized
result of a separately approved check, and that receipt counts only while its
exact version string matched the fixed live version probe at recording time and
its bounded TTL has not expired. The controller hashes the no-follow evidence
file and resolved executable rather than trusting caller-supplied digests. A
harness upgrade requires a newly recorded attestation. Without a fresh receipt
the adapter remains not ready. The controller hashes each receipted executable
before binding the observer and refreshes that cache outside request handling;
identity evidence older than one hour fails closed. Requests read only the
in-memory identity result and persisted receipt. The deployment paths are explicit:
Codex `/home/ubuntu/.local/bin/codex`, Claude `/home/ubuntu/.local/bin/claude`,
Cursor `/home/ubuntu/.local/bin/cursor-agent`, and Grok `/home/ubuntu/.grok/bin/grok`.
No adapter receives a token, prompt, worktree, or arbitrary child command.

Task submission is also a deliberate hard boundary. A worker lease can start
work, submit it, or receive changes; neither a worker nor the controller can
advance a submission into verification, review, integration, merge,
post-merge verification, or completion. Each submission receipt is stamped
with the exact attempt, phase, lease token, and controller epoch. The later
states remain vocabulary for the reviewed execution phase, not reachable
capability in this release.

The tree also contains unwired process supervision and worktree evidence types.
They are deliberately absent from every CLI/service path and are not a sandbox:
requested CPU/memory budgets are metadata, and networked execution is rejected.
Future work may connect them only after adding separately reviewed systemd or
bubblewrap isolation, dedicated minimal harness homes/configs, scheduler leases,
and adapter-specific fixed argument construction. That phase must add distinct
verifier, reviewer, and integrator roles; a global merge lease/fence; and
separate verification, merge, and post-merge receipts that are all bound to the
current attempt. It must preserve the fencing protocol, require per-run
enablement, and use external authorization for merges, releases, account
actions, or spend.
