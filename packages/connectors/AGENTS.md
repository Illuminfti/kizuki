# Connector package instructions

These rules apply under `packages/connectors` in addition to the root
`AGENTS.md`.

## Responsibility

This package adapts owner-authorized sources to the frozen Kizuki ingress. A
connector normalizes evidence; it does not decide canon, resolve identity
silently, or smuggle provider-specific state into core contracts.

Read the connector types, registry, shared conformance suite, ledger adapter,
and a similar in-tree connector before editing.

## Contract discipline

- A registry entry is a product claim. Add it only with a working implementation
  and passing conformance tests.
- Declare authentication honestly. Implement interactive sign-in only when the
  provider offers a sanctioned flow compatible with Kizuki's custody model.
- Never ask an end user to paste hidden project credentials that should belong
  to an operator or application. Never embed private credentials.
- Store credentials only through supported secret references and owner-private
  files. Persisted connector state must be safe by representation.
- Network calls must be explicit, attributable to the configured connector,
  bounded by timeouts and pagination, and absent from fixture/conformance paths.
- Preserve stable provider record identity, original occurrence time,
  observation time, participants or subjects, deletion state, attachments,
  metadata, and provenance.
- Backfill and incremental sync must be resumable and idempotent. Advance a
  checkpoint only after the corresponding evidence is durable.
- Provider deletion must emit a tombstone when the sanctioned API exposes it.
  State honest limitations when it does not.
- `revoke` ends future access. `purgeSource` returns a precise plan and must not
  claim that remote data was deleted unless it was.
- Archives and export files are hostile input. Defend against traversal,
  symlinks, decompression bombs, malformed encodings, duplicate IDs, and
  unbounded allocation.
- Do not call an export importer, unofficial scraper, or partial-history API a
  live personal-history connector.

## Provider research

Authentication, scopes, quotas, retention, approval, billing, and deletion
semantics are time-sensitive. Use current official provider documentation and
record the date, required operator setup, end-user steps, token custody,
backfill limits, incremental behavior, deletion behavior, approval or billing
gates, and honest fallback.

## Required tests

Run the shared conformance suite plus provider-specific tests. Include
synthetic fixtures for exact manifest behavior, missing credentials,
idempotent double backfill, checkpoint resume after failure, tombstones,
revoke, purge planning, pagination bounds, malformed input, and redaction. Then
run typecheck and the full repository gate.
