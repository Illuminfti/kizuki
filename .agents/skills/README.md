# Kizuki agent skill catalog

Skills are task-specific playbooks. Keep standing repository policy in
`AGENTS.md`; use these files only when the task calls for their deeper workflow.
Canonical skills live here. Harness-specific adapters should delegate here
instead of copying policy.

## Operating skills

| Skill | Use when |
| --- | --- |
| `orient-repository` | Starting non-trivial work, recovering a handoff, or checking collision risk |
| `implement-change` | Building or repairing a bounded behavior |
| `diagnose-failure` | A failure cause is uncertain or a previous fix did not hold |
| `review-change` | Reviewing an exact branch or pull-request head |
| `connector-work` | Researching, implementing, or reviewing a provider connector or importer |
| `security-privacy-review` | Crossing data, auth, filesystem, network, serving, import, or export boundaries |
| `write-rfc` | Changing architecture, authority, durable state, or a binding contract |
| `handoff-work` | Stopping, transferring, or preserving a lane |

## Engineering craft skills

| Skill | Use when |
| --- | --- |
| `architecture-design` | Designing or reviewing a subsystem or cross-package architecture |
| `api-contract-design` | Adding or changing a TypeScript, CLI, connector, MCP, or serialized contract |
| `test-strategy` | Designing coverage or strengthening weak behavioral proof |
| `refactor-safely` | Simplifying or modularizing without changing observable behavior |
| `migration-work` | Transforming durable state, formats, dependencies, or many callers |
| `performance-engineering` | Improving latency, throughput, memory, I/O, startup, indexing, or scale |
| `reliability-engineering` | Designing retries, recovery, restart safety, liveness, or degraded operation |
| `sqlite-data-modeling` | Designing durable or derived SQLite schemas, indexes, and queries |
| `dependency-evaluation` | Adding, upgrading, replacing, or removing a dependency |
| `release-readiness` | Deciding whether an exact candidate is genuinely ready to ship |

## Composition

Use the smallest set that covers the task. `orient-repository` normally comes
first. Examples:

- new durable subsystem: `architecture-design` + `api-contract-design` +
  `sqlite-data-modeling` + `test-strategy`;
- schema evolution: `migration-work` + `sqlite-data-modeling` +
  `reliability-engineering`;
- performance bug: `diagnose-failure` + `performance-engineering` +
  `test-strategy`;
- risky cleanup: `refactor-safely` + `test-strategy` + `review-change`;
- new package: `dependency-evaluation` before `implement-change`;
- release candidate: `review-change` + `security-privacy-review` +
  `release-readiness`.

Do not load every skill by default. Deep playbooks are useful because they are
invoked for the right job, not because they occupy permanent prompt context.
