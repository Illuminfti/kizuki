---
name: security-privacy-review
description: Audit a Kizuki change for secret exposure, personal-data leakage, prompt injection, authorization bypass, unsafe storage, purge failure, network egress, and denial-of-service risk. Use for core, connector, serving, import, export, filesystem, auth, logging, or release changes.
---

# Security and privacy review

## Trust boundaries

Map owner input, captured evidence, archives, filenames, provider responses,
model output, agent arguments, local files, SQLite, canon, logs, terminal
rendering, and network endpoints. Mark which values are hostile, sensitive, or
authoritative.

## Checks

- Identity, grant, sensitivity, scope, rate, and tool authorization fail closed.
- Captured content is never interpreted as repository or runtime instruction.
- Secrets are never stored in SQLite, canon, logs, errors, fixtures, snapshots,
  command history, URLs, or audit arguments.
- Paths resist traversal, symlink escape, unsafe permissions, partial writes,
  and replacement races.
- SQLite changes are transactional and recover after interruption.
- Purge reaches evidence and every provenance-derived artifact, while receipts
  contain no deleted private content.
- Export and backup exclude credentials and support verified clean restore.
- Network calls are explicit, allowlisted by product contract, bounded, and
  absent from deterministic tests.
- Parsers bound size, depth, count, decompression, pagination, recursion, and
  allocation.
- Errors and telemetry do not leak private text. Kizuki has no silent
  telemetry.
- Terminal and Markdown surfaces neutralize control sequences and unsafe
  rendering.
- Public claims match the exact implementation and limitations.

## Adversarial tests

Add or run tests for missing labels, unknown agents, expired or stale grants,
cross-scope access, malformed and oversized input, duplicate/replayed records,
path traversal, symlinks, interrupted writes, failed transactions, redaction,
forbidden egress, purge cascades, and denied operations.

## Output

Report threat, exploit path, impact, existing control, evidence, gap, and
required fix. Separate confirmed findings from hardening suggestions.
