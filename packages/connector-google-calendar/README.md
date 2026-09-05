# Google Calendar provider component

This module captures revisions from one explicitly selected Google calendar through the read-only Calendar API. It uses the native Connector, OAuth PKCE/session, protected opaque state, and capture ledger interfaces. It does not create an application registration or grant access to an account. CLI enrollment and configured registry composition are separate integration work.

## Trusted host composition

Use `createGoogleCalendarConnector(config, deps)`. Supply an operator-configured Google desktop client, the canonical calendar ID, explicit persisted fields, a protected connection `secret_ref`, and native `createStatePersister` as `deps.persist`. Missing configuration refuses before provider transport. Runtime capabilities are supplied separately from serializable configuration. OIDC `sub` binds the account; mutable email/display text does not establish identity. Literal `primary` is refused: the caller must supply the actual calendar ID, rather than guessing it from an email address. Calendar discovery is not implemented.

OAuth requests only `openid`, `email`, and `https://www.googleapis.com/auth/calendar.events.readonly`. `signIn` uses the existing system-browser PKCE interface. No send, modify, calendar creation, or event deletion scope is requested. This package does not launch a browser itself. Replacement enrollment must supply `expected_account` and runtime `previousState`; account, calendar, and selected fields must match, and the pending witness, cancellation anchors, and cooldown are retained. The host must preserve the connection checkpoint with that exact protected state through the existing enrollment/CAS boundary. It must not silently replace a different account or narrow/widen stored fields.

Selected persisted fields are `summary`, `description`, `location`, `attendees`, and `attachments`; an explicit empty array requests metadata-only capture. API partial-response projection omits unselected content. Minimal provider IDs, status, etag, revision time, schedule, and recurrence metadata are always acquired and persisted to identify the revision. A host source grant therefore needs metadata, plus text/subjects/attachments where selected. Attendee email/display are recorded only when selected. Attachments contain metadata only, never downloaded bytes or provider URLs; unknown sizes remain absent. Attendees are capped at 64 and `attendees_omitted` is reported.

Before resolving protected state or constructing an acquiring connector, the native host must perform source capture admission. Core `runToCompletion` also checks the enrolled source grant before invoking capture. Provider OAuth permission and source consent are distinct. `revoke()` stops this local connector instance; it does not revoke a Google account token. Native source revocation denies capture independently and owns subsequent local physical erasure. This component does not perform provider-side purge or remote OAuth revocation.

## Revision and time semantics

The event's stable source ID encodes account `sub`, canonical calendar ID, and provider event ID. A recurring instance ID is not collapsed into a series ID or `iCalUID`. Captures use `kind: calendar_event`. Live `occurred_at` is the actual provider `updated` revision timestamp, not the scheduled meeting start. Missing live revision time refuses capture. The original schedule is typed metadata: all-day `date` values remain date-only; date-times retain their offset/time zone; end is exclusive; recurrence rules, recurring-event ID, and original start are preserved. Recurrences are not expanded. No local mtime, inferred midnight, or fabricated time zone substitutes for meaningful dates.

Only explicit `status: cancelled` creates a tombstone. Cancelled records without provider `updated` use a first-observed timestamp persisted before publication, with `provider_deleted_at: null` and an explicit observation-time label. Repeated cancellation rescans reuse the anchor. An explicit intervening live observation clears it, so a later cancellation can be a new observation. Missing records never imply deletion.

## Bounded synchronization and recovery

Requests use `singleEvents=false`, `showDeleted=true`, invariant field selection, and a provider page/sync token. A method returns at most 20 events and makes at most 25 GET requests within 45 seconds, with each request and state write bounded by five seconds or remaining time. JSON responses are streamed and capped at 2 MiB. Cursors are limited to the core 8 KiB bound. The pending page fingerprints and cancellation anchors are limited to 128 KiB inside the native 1 MiB protected state bound. The initial scan and cancellation-anchor set each cap at 1,000 records; capacity refusal retains the checkpoint and reports the specific unresolved coverage limit.

A page plan records its input, request and next cursors, observation time, and normalized event fingerprints before any event is returned. It contains no event bodies. Crash/reopen refetches that exact page: unchanged revisions retry safely; different content, versions, or pagination refuse with `snapshot_gap_unresolved` and the prior checkpoint. This is an honest unresolved snapshot gap, not a claim of a historical provider snapshot. Empty intermediate pages are drained internally; a final empty provider page can advance a genuine sync token.

HTTP 410 initiates a bounded rescan and reports `history_gap_absence_unreconciled` persistently. Existing evidence is retained; the rescan cannot prove revisions lost during expiry. A 410 while replaying an interrupted witnessed page refuses instead of replacing the witness. HTTP 429 and documented rate-limit 403 responses persist a bounded cooldown; reopening does not bypass it. HTTP and OAuth errors omit provider text, URLs, tokens, and source content.

A timed-out external state write has unknown commit status. The connector returns a bounded timeout, fences reconnect while the write remains outstanding, and requires reloading durable state after settlement. A callback from an earlier OAuth generation cannot write into a newer account or token generation. This does not claim cancellation of an external write already in custody.

## Qualification

Tests use synthetic transport, PKCE callbacks, protected state files, and isolated SQLite databases. They exercise the real `runToCompletion` and `createStatePersister` path, checkpoint interruption before and after event acceptance, mutable-page refusal, cancellation replay, source grant denial, and native connector conformance. No test contacts a Google account, opens a real browser, registers an application, or grants credentials. Live account enrollment, CLI composition, packaging, and full integration remain separate gates.

Primary documentation checked 2026-09-05:

- [Events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list): paging, sync tokens, query restrictions, read-only scope.
- [Event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events): revision time, cancellation guarantees, schedule and recurrence fields.
- [Synchronization](https://developers.google.com/workspace/calendar/api/guides/sync): expired sync tokens and full rescan.
- [Authorization](https://developers.google.com/workspace/calendar/api/auth): scope boundaries.
- [Errors](https://developers.google.com/workspace/calendar/api/guides/errors): rate-limit and expiry handling.
