# Gmail connector — implementation candidate

This package implements bounded Gmail capture through the existing connector and OAuth interfaces. It is **not accepted for enrollment or release**. No registered Google application, real account, CLI enrollment, source-grant composition, or live-account qualification is included. Missing application configuration or the trusted state persister refuses access.

Gmail live messages are mutable. Before a batch leaves the connector, its existing ID-only pending plan durably records up to 20 normalized-event fingerprints, including provider version and the fixed observation time. A retry must reproduce those fingerprints. Changed content/version or a formerly live message returning 404 yields `snapshot_gap_unresolved`, zero events, and no checkpoint advance. There is no automatic history skip or reset to hide that gap. The native disk-ledger fixtures cover interruption both before acceptance and after acceptance but before checkpoint persistence: unchanged retries deduplicate; changed retries preserve every previously accepted row.

## Host composition

Use `createGmailConnector(config, deps)`. The trusted host supplies application credentials, a connection `secret_ref`, explicit persisted fields (`text`, `subjects`, `headers`, `labels`, `attachments`), and the existing `createStatePersister` capability in `deps.persist`. Replacement enrollment must supply `expected_account` from the existing authorized connection. The registry descriptor identifies the implementation; its unbound factory refuses capture. Runtime capabilities are never hidden in serializable configuration.

The replay witness is bounded to the current batch; the immutable plan ID excludes that witness so a later-batch state write cannot invalidate its own retry cursor. Stale/skipped offsets refuse. A failed state-write response fences the instance until the trusted host reconnects and reloads durable state, because a response failure cannot prove whether the write committed. Old candidate pending plans lacking the witness field refuse without being overwritten or adopted; states with no pending plan remain readable. This is connector-owned opaque-state validation, not a core OAuth/event schema change.

The package reuses core PKCE browser sign-in, OAuthSession refresh, private opaque state custody, and the existing event/connector contracts. No new store or core schema is introduced. Account identity is OIDC `sub`; source-record identity is the unambiguous encoding of account plus immutable Gmail message ID. Email addresses and thread IDs do not identify accounts or records. No message grants owner authority.

## Bounds and coverage

Capture uses sequential fixed-host HTTPS GETs: at most 20 messages, 25 requests, 45 seconds per capture method, 5 seconds or the remaining budget per request, and 2 MiB streamed JSON per response. Initial backfill stops after 1000 records and reports partial coverage when more pages exist. History pages contain at most 20 history records and 1000 changes; oversized input refuses the whole batch. Cursor bytes stay within core's 8 KiB limit. The existing 1 MiB opaque connection state contains OAuth state and a pending plan capped at 128 KiB, with IDs, hashes, cursors, and observation time, never mail payloads.

History IDs remain decimal strings. Only explicit `messagesDeleted` becomes a tombstone. Trash, label removal, missing GET responses, and snapshot absence never imply deletion. History expiry starts a bounded rescan with a persistent gap warning; old missed deletions remain unreconciled. Missing message coverage remains explicit. Live occurrence time comes only from valid provider `internalDate`; missing dates refuse. Tombstone timestamps mean **deletion observed**, with `provider_deleted_at: null`.

Text support is bounded UTF-8/ASCII text/plain. HTML, unsupported charsets, excessive bodies, and attachment bodies are unsupported. MIME inspection is bounded to eight nested levels and 128 parts and reports that projection limit. Attachments are references/metadata only; no attachment-download endpoint is called. Provider `fields` projection omits body data when text is not selected. Structural/header envelope fields needed for parsing may still be received and discarded; requesting text can incidentally receive inline attachment data inside a bounded provider response. Persisted-field selection is not a claim of narrower Google authorization or zero incidental provider collection.

429 and recognized 403 quota failures return rate-limited unavailability without checkpoint advance. Other provider failures are content-free; 401 gets at most one refresh/retry. There is no internal sleep/retry loop. Local `revoke()` terminally stops this instance and discards late results; it does not delete Gmail messages or revoke Google's whole application grant. Remote purge planning is unsupported (`purge: false`). Durable Kizuki source authorization, disconnect, owned-data purge, and host retry scheduling remain core/CLI responsibilities and need integration qualification before enrollment ships.

## Provider evidence

Checked 2026-09-05 using official documentation only; all tests use synthetic transports and records.

- [Installed-application OAuth](https://developers.google.com/identity/protocols/oauth2/native-app): system browser, loopback redirect, PKCE and registered desktop application required. No project/application registration was performed here.
- [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes): this implementation requests only `openid`, `email`, and `gmail.readonly`. Gmail read-only access is a restricted scope; production verification/operator setup remains required. No send, modify, Calendar, or full-mail scope is requested.
- [OIDC identity](https://developers.google.com/identity/openid-connect/openid-connect): stable `sub` is used instead of mutable email.
- [Synchronization](https://developers.google.com/workspace/gmail/api/guides/sync) and [history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list): history expiry requires resynchronization and does not provide a complete deletion audit.
- [Message resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages) and [message GET](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/get): immutable message IDs, internal date, structured MIME, partial projection, and metadata headers.
- [Error handling](https://developers.google.com/workspace/gmail/api/guides/handle-errors): quota/permission distinctions and retry behavior.

No complete mailbox-history guarantee is made. A user-authorized provider export remains a separate fallback when API history or application approval is unavailable; this package does not implement a Google export importer.
