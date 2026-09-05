# WHOOP provider component

`@kizuki/connector-whoop` implements bounded read-only WHOOP v2 capture using
protected OAuth state supplied by a trusted host. This is a synthetic-tested
provider component. It is not registered in the CLI, does not implement native
interactive enrollment, and has no real-account or copied-artifact qualification.
No provider application or account was created to build it.

## Access and custody

The host supplies `WhoopConfig` with a protected `secret_ref`, operator client ID
and secret, explicit `selection`, and optionally the already-bound account ID.
`WhoopDeps.persist` is mandatory: use Core's connection-state persister, never a
second token file. The existing Core `OAuthSession` performs refresh and writes
rotated credentials before use. Tokens do not enter events, metadata, cursors,
health reports, or diagnostics. Provider profile responses establish the numeric
account ID; name and email are discarded.

Selections specify one or more of `cycle`, `recovery`, `sleep`, `workout`, an
explicit RFC3339 `history_start`, and one or both fields `metrics`, `activity`.
Authorization requires `offline`, `read:profile`, and only the corresponding
resource read scopes (`read:cycles` for cycle). Selection must match the protected
state; reconnect cannot silently broaden it. Record identity and provider revision
timestamps are always included. This is separate from native source-purpose,
field, retention and egress consent: future host composition must invoke Core
admission before protected-state access, factory construction or transport and
must grant the actual event fields (`text`, `subjects`, `metadata`) explicitly.
This package does not invent source grants.

The OAuth envelope contains tokens and a bounded private capture checkpoint:
fixed history range, source IDs and event hashes, with no health metric bodies.
It is credential-sensitive state, not an exportable public checkpoint. The trusted
host owns its lifecycle, revision CAS, recovery and cleanup. A pending host write
with unknown outcome fences reconnect until that write settles; after failure the
connector requires durable reload. Old refresh generations cannot write a newer
session. Cross-process token rotation relies on the host's existing state CAS;
this component does not create an independent cross-process OAuth lock.

## Enrollment gate

Current official WHOOP OAuth documentation requires a registered redirect and
specifies an eight-character state. Core's supported browser flow uses its
existing stronger state and PKCE, with a dynamic loopback callback. Provider
compatibility has not been established. This component therefore advertises only
`secret_ref`, not `oauth` or `sign_in`. It does not ask an owner to paste tokens or
weaken Core's CSRF protection. A reviewed compatible native enrollment and an
operator-registered application remain implementation/qualification gates.
Protected-state synthetic fixtures are not a substitute for them.

## Capture and time semantics

The component emits private `health` evidence linked to the provider account and
resource ID. Cycle and recovery identities use the cycle ID; sleep and workout
use their v2 UUIDs. Integer IDs outside JavaScript's exact safe range are refused.
Account, identity and timestamp mismatches refuse the whole batch.

`occurred_at` is the actual provider `updated_at` revision time. Provider
`created_at` is retained separately. Activity `start`, nullable `end` and time-zone
offset are included only when selected. They are never substituted for revision
time. Recovery has no activity start/end in its collection response; its activity
validity is explicitly `null`. Selecting recovery does not implicitly fetch sleep
or invent a recovery date from the cycle number.

Metric projection copies only known typed numeric/boolean fields and supported
nested score summaries. Zero, explicit null, and absent keys remain distinct.
`PENDING_SCORE`/`UNSCORABLE` are retained and do not become zero scores. Unselected
metric bodies and unknown provider fields are omitted. Text labels the data as
reported measurements. No medical advice, health conclusion, derived diagnosis,
readiness recommendation, or beneficial outcome is inferred.

## History, edits and gaps

WHOOP collections are ordered by activity time, not modification time. Every
capture operation scans the selected range with a fixed end time for its current
plan. There is no `updated_at` high-water mark. Once a plan is acknowledged, a new
bounded rescan can discover edits to old activities anywhere in the selected
history. Unchanged completed scans return the same cursor and no new events.

The operation materializes at most 1000 records across selected resources, using
pages of at most 25. It refuses over-cap history before emitting any of that
plan. There is no silent truncation; reducing the selected history requires an
explicit host decision, not an automatic cursor advance. Repeated whole-range
scans trade provider requests for a simple bounded observation contract.

Before returning a batch of at most 25 records, its entire observed plan and
issued boundary are durable. An unchanged retry reuses the exact observation;
a changed observation returns `unavailable` with `snapshot_gap_unresolved` and
keeps the caller's original checkpoint. It does not re-mine a partial batch or
skip untouched records. Malformed cursors are rejected before transport.

Provider pagination is not a transactional snapshot. The witness verifies the
observed plan and retries; it cannot prove discovery of a provider record omitted
by a non-atomic listing. All successful batches retain `non_atomic_listing` and
`polling_deletions_unavailable` coverage details, and health remains degraded.
The component has no webhook receiver. Collection disappearance or HTTP 404
never produces a tombstone. Deletions and older records outside the selected
range remain unqualified; the manifest declares no tombstone capability.

## Bounds and authorization revocation

An operation has a 45-second wall bound, 48 HTTP requests, five seconds per HTTP
request or persistence wait, two MiB per response, 384 KiB protected state, and
an eight KiB cursor. No automatic HTTP retry or redirect is followed. HTTP 429
persists a cooldown from Retry-After or WHOOP reset headers before returning;
restart respects it. This per-source mechanism is not an application-wide quota
reservation system. Operator limits and concurrent applications still apply.

`revoke()` explicitly calls WHOOP's fixed authorization-revocation endpoint. It
clears the local session only after provider success, is terminal/idempotent,
and excludes concurrent capture. Failure is reported; source consent denial must
remain independently enforceable by Core even when WHOOP is unavailable.
`close()` stops only the local object, with no provider request. Neither operation
erases remote health records. `purgeSource()` is unsupported. Local owned-data
purge remains a Core/host responsibility, with all its existing proof gates.

## Evidence and official references

Synthetic component tests exercise typed metrics, pagination, older edits,
unchanged replay, changed retry refusal, actual temporary ledger acceptance and
restart, process exit after a durable witness, scope/account refusal, response
bounds, cooldown, delayed refresh/persistence, explicit revoke and shared
connector conformance. No test contacts WHOOP or a real account.

Official sources checked 2026-09-05:

- [WHOOP v2 API and schema](https://developer.whoop.com/api/)
- [Official OpenAPI document](https://api.prod.whoop.com/developer/doc/openapi.json)
- [OAuth](https://developer.whoop.com/docs/developing/oauth/)
- [Pagination](https://developer.whoop.com/docs/developing/pagination/)
- [Rate limits](https://developer.whoop.com/docs/developing/rate-limiting/)
- [Webhooks](https://developer.whoop.com/docs/developing/webhooks/)
