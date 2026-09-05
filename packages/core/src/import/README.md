# Estate slice dry-run

`kizuki import estate-slice --source slice.json --authorization authorization.json --dry-run --json`

This reads two bounded local regular files and prints a content-free mapping/loss
report. It does not open a vault, enroll a connector, fetch attachments, invoke a
model, write records, or implement production authorization/revocation. Omitting
`--dry-run` is an error. Exit 0 means a compatible **plan**, 1 means blocked, and
2 means invalid CLI usage or an unreadable/unsafe file. Core validation failures
exit 1. JSON reports go to stdout; fixed validation diagnostics go to stderr.

`EstateSlice`, `EstateRecord` and `EstateAuthorization` in
`../contracts/estate-import.ts` define the exact JSON shapes. Every key is
required. Unknown keys are refused; use explicit null for unknown times/state
and empty arrays for absent relationships. The source limit is 1 MiB, with at
most 32 sources and 256 records total. Authorization is limited to 64 KiB.
Record text is limited to 64 KiB. IDs are opaque, bounded and case-sensitive.

Authorization binds SHA-256 of the **exact source file bytes**, the exact source
ID set and each source's consent generation. `purpose` is `estate-import`.
Only `retention: persistent_owned_copy` and `egress: local_only` are compatible.
LifeOS `derived_until_revoked`, `session_only` and `no_source_copy` do not imply
permission for that persistent copy. This file is a supplied planning
declaration; possession of it proves no owner identity or current durable grant.
Its revoked flag can block a plan, but cannot revoke existing records.
Disconnect remains stop-sync, distinct from an explicit native purge request.
External backups are outside a native purge proof.

A record requires allowed fields `text`, `times`, `authority`, `provenance`.
Nonempty subject, alias, relationship and attachment groups, and nonnull
state/value, require their respective allowances too. Source sensitivity and
floor combine monotonically. Provenance SHA-256 must match the exact record
text. Event occurrence and observation times must be known RFC3339 strings;
export time and filesystem mtime never substitute. Historical claim times are
preserved only as foreign source metadata and explicitly reported as such.

This version blocks foreign owner/model authority, native correction or
supersession, aliases, attachment byte transfer, and product/client-owned domain
state. It does not silently downgrade these into completed semantic imports.
One blocker blocks the entire plan. Compatible event templates are internal;
tests use existing native `accept` and purge APIs in isolated synthetic vaults.
The only public operation is `planEstateImport(sourceJson, authorizationJson)`.
It returns digests, positional mappings, fixed loss codes and limitations, never
source IDs, raw evidence, attachment names, or credential fields. Plan hashes
bind the input bytes and authorization, so formatting changes require replanning.
