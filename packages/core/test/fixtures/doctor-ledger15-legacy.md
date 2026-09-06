# Historical ledger15 doctor fixture

`doctor-ledger15-legacy.sql` is a complete SQLite dump produced on 6 September
2026 from unmodified Kizuki commit
`5c50bdc8bf14915ffa3c4e1a011ecc8af45d20a9`, tree
`bbab8207eaa92f8a2f1f72a0fed4c7e5f0fd8fd4`, running its pinned Bun 1.3.10
(`30e609e08073cf7114bfb278506962a5b19d0677`). Public `openLedger`,
`registerConnection`, `setSourceGrant`, `sourceCaptureAdmission` and `accept`
created one neutral consented event with empty subjects, attachments and
metadata. The connection has no state reference. No agent, grant or credential
was created.

The old writer's actual schema and timestamps were preserved. There was no
version downgrade or rewriting of database rows. The old events table has no
hash-version column; current migration preserves its v1 content hash.

## Verification

The 15,560-byte SQL has SHA-256
`1d93c78885930f42bb01c579f4a6d272c5998ffd4b11bd4afe95318b90e8a2ed`.
Python SQLite 3.45.1 `iterdump()` and replay preserved all 97 schema objects
and 14 rows across 37 tables. Original and replay passed integrity and foreign-key
checks. Tests execute this unchanged fixture, migrate it through current Core,
and check the real authoritative read and doctor diagnostic.

This is synthetic compatibility evidence. The fixture's connector is deliberately
unconfigured; a healthy ledger diagnostic does not imply overall connector or
service health.
