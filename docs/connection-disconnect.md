# Connection disconnect

The trusted host uses core `disconnectConnection({ db, store }, connector,
connection)` with a connector loaded from the selected enrollment. Core checks
the enrolled identity and holds the connection-state lease throughout provider
revocation. The database must be a real file in the same control directory as
the state store; core checks the retained file identity before provider access.
Unknown, changed and already-disconnected identities refuse before
the provider is called.

Local disconnect and a `started` receipt commit in one transaction before
`connector.revoke()`. Capture is denied immediately. The result distinguishes
`completed` from `provider_pending`; provider errors are recorded only as
`provider_revoke_failed`. A timeout retains the lease until the provider actually
settles. A missing completion audit leaves the original started receipt pending.
The host must not present local denial as completed provider revocation.

`inspectConnectionDisconnect(db, operation_id)` reads the durable status.
`resumeConnectionDisconnect({ db, store }, connector, operation_id)` explicitly
retries pending work against the original enrollment and disconnect timestamp.
It never reconnects a source or changes its consent. Completed operations refuse
another provider call. A process crash releases the kernel lease; the started
receipt remains available for this recovery path.

Provider revocation retains each connector's existing meaning. For example,
IMAP forgets its in-memory app password; provider-side password revocation remains
an owner action. The result records completion of the connector contract, not a
universal assertion that every provider credential has been destroyed.

The synchronous `disconnect(db, connector_id, source_key)` remains the local
state primitive. It returns the recorded timestamp and throws `DisconnectError`
with `unknown_connection`, `already_disconnected` or `connection_changed` when
no single active transition can be committed. Hosts needing provider revocation
and durable history use the asynchronous operation above. Source-consent
revocation and its subsequent purge remain separate operations.

Ledger schema 22 owns append-only `connection_disconnect_receipts`. Current v3
backups require `ledger/connection_disconnect_receipts.jsonl`, including an empty
stream when no disconnect has occurred. Export and restore preserve pending and
completed history. Genuine older schema-21 backups have no disconnect stream
and restore with empty disconnect history. Credentials and opaque state remain excluded from ordinary
backups, so restored pending history cannot authorize a provider retry against
an enrollment whose state binding changed.

## Verification

Run `bun test packages/core/test/connections-disconnect.test.ts
packages/core/test/connection-disconnect-lifecycle.test.ts
packages/core/test/connection-disconnect-schema.test.ts`. The tests exercise
typed refusals, timestamp preservation, lease exclusion, provider failure,
missing audit writes, a killed process, explicit recovery, migration and backup
preservation. Provider tests use synthetic connectors; real-account qualification
remains separate.
