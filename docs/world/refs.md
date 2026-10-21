# Scoped typed references

This implementation is authorized by the owner's 2026-10-21 request to complete
all features and the wider roadmap. That instruction selects the typed-reference
stage of RFC 0004. It does not assert that the earlier draft PD-REFS was accepted
or rewrite the historical decision log. Production activation is a separate
integration gate.

## Compatibility and public contract

The selector remains `kizuki.envelope/v2`; the tool set still has ten tools.
Owner v1 retains its existing argument and response contract. V2 read and mutation
arguments are closed objects with typed references. Canon and quoted chunks,
graph results, proposal/correction results, and context packets contain scoped
identifiers instead of generated page paths, event/source IDs, claim keys, or
receipt IDs. Literal captured text remains quoted text even when it resembles
an identifier. Existing source-field policy and redaction apply below adapters.

`system_health` remains owner-only. Unknown selectors and scoped requests for v1
retain the fixed contract refusal. Invalid reference syntax is invalid input;
well-formed references that are absent, erased, unauthorized, of an ineligible
kind, or from another principal namespace are uniformly unavailable. MCP
validates the same closed reference grammar and leaves kind eligibility to Core.

V2 mutation inputs resolve current authority before preparation and again inside
the existing claim transaction. Typed claims use their semantic subject and
endpoint authority. Exact correction retry reaches the canonical replay path
before the positive-authority fence. An explicit multi-valued replacement retires
its selected target through the existing supersession journal; other objects stay
live, and receipt undo restores the predecessor.

Pre-mutation writer contention and pending erasure share this exact payload:

```json
{"ok":false,"error":{"code":"unavailable","message":"writer unavailable","retryable":true}}
```

The refusal includes no intent detail or extra diagnostic. HTTP uses status 503;
MCP and CLI keep their existing transport framing. Reads retain their references
while erasure recovery is pending. Ordinary correction capture checks the same
shared fence inside its native event transaction after exact replay. Wider
positive-authority mutation coverage belongs to the shared fence integration.

## Storage and lifetimes

Migration `typed_refs` follows the actual FCST migration. The earlier `refs` slot
continues to own known-time receipt references. The new migration copies the
closed parent table under the migration transaction, preserving issued legacy
world tokens and namespace rows, then checks all foreign keys before commit.

Mappings are caches over retained identities and never grant authority. Every
resolution checks the current principal and current evidence policy.

| Reference | Lifetime |
| --- | --- |
| Page | Exact page identity, locator, byte hash, and required source events; changed bytes or lost evidence invalidate it. |
| Source | Enrolled source or one unbound capture; revoke and erasure invalidate it. |
| Receipt | Retained receipted write and readable evidence; erased receipt is unavailable. |
| Raw subject | Immutable qualified semantic reference with exact retained source/event memberships; one membership can disappear while another keeps it usable. |
| Captured subject | Exact event and captured subject membership; loss of that event invalidates it. |
| Claim group | Two to sixteen exact authorized claim identities; losing a member invalidates the group. |
| Observation | Existing complete support admission and every required event; any missing required event invalidates the entire observation. |

Equal raw IDs from different sources remain separate before filtering and limits.
Purge removes affected mappings. Derived rebuild and restore clear reference caches
while preserving retained authority records. Diagnostic unissued references remain
private to their synchronous diagnostic frame and cannot resolve as issued tokens.

## Observations

`world_view` operation `observation` accepts an AdmissionRef or ObservationRef,
plus the common valid/known-time selector. Core, CLI, MCP, HTTP, and the App use
the same reader. The CLI accepts `--admission TOKEN` or `--observation TOKEN`.
The App exposes admission details beside relation assessments and keeps evidence
one step away through the existing evidence operation.

An Observation is a normalized immutable child of a checked complete support
admission. Its alias is an opaque ULID, never an event ID. The existing admission
owns it through a cascading support key. It contains validated captured spans
and explicit captured sender/recipient fields; it introduces no inferred holder,
confidence, or second admission writer. Publication rechecks every required event
and source field.

Historical backfill uses the admission's actual recorded time and sequence.
Support without retained recorded history receives no invented Observation.
Correction does not relabel an old Observation. Source revocation, purge,
transaction rollback, export, restore, and derived rebuild follow the same retained
evidence chain.

## Verification

Focused executable controls are in `test/contracts/scoped-refs.test.ts`,
`test/world/scoped-ref-lifetimes.test.ts`, `test/world/scoped-ref-migration.test.ts`,
`test/world/observations.test.ts`, `test/serving/scoped-tools.test.ts`, and
`test/serving/world-correct-scope.test.ts` under Core. Ordinary correction fencing
and targeted replacement/undo are covered in the correction and serving suites.
MCP's scoped-reference and output-scanner suites use real stdio and HTTP clients,
scan all ten tools for raw generated identities, and compare reference refusals. CLI and App tests
cover the shipped consumers. The common operation matrix includes Observation
for noninterference, purge, and consumer parity. Exact-head integration receipts
must accompany the release handoff; this document alone is not a release receipt.
