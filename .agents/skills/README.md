# Kizuki agent skill catalog

Skills are task-specific playbooks. Keep standing repository policy in `AGENTS.md`; use these files only when the task calls for their deeper workflow. Canonical skills live here. Harness-specific adapters delegate here instead of copying policy.

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
| `threat-modeling` | Mapping assets, trust boundaries, abuse cases, mitigations, and security tests |
| `property-fuzz-testing` | Exploring large parser, state-machine, serialization, and hostile-input spaces |
| `concurrency-race-analysis` | Reasoning about interleavings, stale state, duplicate work, locks, SQLite, or filesystem races |
| `backup-restore` | Building or verifying backup and clean-target restore |
| `cli-terminal-ux` | Designing safe, composable, polished CLI and terminal interactions |
| `observability-debuggability` | Adding privacy-safe local diagnostics, health, receipts, and failure visibility |
| `documentation-accuracy` | Proving documentation and claims against the exact revision |
| `mcp-tool-design` | Designing agent/MCP tools, schemas, authorization, errors, and bounded context |
| `incident-root-cause` | Investigating defects or incidents into reproducible causes and durable prevention |
| `repository-archaeology` | Recovering intent and constraints from unfamiliar code, history, tests, and RFCs |

## Composition

Use the smallest set that covers the task. `orient-repository` normally comes first. Useful combinations:

- new durable subsystem: `architecture-design` + `api-contract-design` + `sqlite-data-modeling` + `threat-modeling` + `test-strategy`;
- schema evolution: `migration-work` + `sqlite-data-modeling` + `reliability-engineering` + `backup-restore`;
- performance bug: `diagnose-failure` + `performance-engineering` + `property-fuzz-testing` where the input space matters;
- concurrency-sensitive state: `concurrency-race-analysis` + `reliability-engineering` + `test-strategy`;
- MCP serving: `mcp-tool-design` + `threat-modeling` + `api-contract-design` + `security-privacy-review`;
- unfamiliar legacy path: `repository-archaeology` before `refactor-safely`;
- incident: `incident-root-cause` + `diagnose-failure` + the relevant domain skill;
- CLI feature: `cli-terminal-ux` + `api-contract-design` + `test-strategy`;
- release candidate: `review-change` + `security-privacy-review` + `documentation-accuracy` + `release-readiness`.

Do not load every skill by default. Deep playbooks are useful because they are invoked for the right job, not because they occupy permanent prompt context.
