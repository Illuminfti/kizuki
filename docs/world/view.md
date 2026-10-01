# Views and portable resume

Implemented on this branch: complete world reads can issue a scoped view,
compare a retained baseline, and share an object read with another client.
All surfaces use `world_view`; MCP still has ten tools and exactly two
write tools, `propose` and `correct`. No model, network call or canon write
is needed for these reads.

## Coordinator decisions awaiting owner ratification

- **D-PART:** reserve the owner's partition at bootstrap and a principal's
  partition at agent enrollment or grant amendment. App enrollment uses the
  same activation function. Limit: 64 partitions per vault; existing
  reservations are never displaced. A principal without one still reads
  correctly with `view: {status: "not_issued"}`.
- **D-RESUME:** handles live for 24 hours, with at most 16 active per issuer.
  Any authenticated principal holding `world_view` redeems under its own
  grant. One grant-derived coverage bit reports clipping.

These are coordinator decisions, not a claim of historical owner ratification.
They do not alter the inert default agent grant.

## Conditional reads

`concept`, `situation`, `find_concepts`, `find_situations` and `resume` accept
`priorView: {kind: "view", token}`. A complete read by a reserved principal
returns `current`, a random 43-character token and `validUntil`. An unreserved
read has no lifetime. Incomplete reads have permitted partial data and reasons,
and issue no token.

Every conditional read recomputes the complete authorized projection. Sorted
canonical JSON and a SHA-256 fingerprint cover the operation and the whole
body, after serving redaction and string bounds. Comparison also requires byte equality. Equal complete bytes return
`unchanged`, the same token and lifetime, and no data. A changed complete body
returns `current` with a new token. Newly partial coverage returns `incomplete`,
never `unchanged`.

Unknown, expired, evicted, cross-principal, erased, narrowed-grant and
previous-service-generation baselines all return exactly
`{status: "new_view_required"}` as the result. No old data or diagnostic reason
is included. Authentication and tool denials retain the existing audited Core
refusal contract and happen before a baseline or resume lookup.

Tokens contain 32 random bytes, encoded as unpadded base64url; storage keeps
only their SHA-256 digests. TTL is fixed at 15 minutes, never renewed by a read.
Each principal has 16 slots and 4 MiB of retained projection bytes, with at most
256 KiB per token. Issuance expires that principal's old rows, then evicts
oldest-issued rows with ascending digest as the tie-break. Cache failures
roll back issuance and degrade to `not_issued` without losing the fresh body.
Hidden sources, claims and identity changes cannot alter another principal's
baseline comparison, reservation or eviction order.

The audited serving gate revalidates the projection's authorized support,
source coverage and current principal grant in the final output transaction.
Coverage includes authorized sources outside the card's support, their import
checkpoints and readable extraction backlog. Hidden checkpoints are filtered
before loading. An unrelated source revocation or purge leaves the answer,
errors and read work unchanged. Withdrawn or changed dependencies
discard the pending view and reproject once under current authority. A
conditional target denied by current source consent returns
`new_view_required`; a fresh read of that target remains `not_found`.
Baseline lookup also checks its retained support dependencies before returning
the stored projection. Withdrawn consent invalidates that baseline even when
independent support keeps every freshly projected byte identical; a later purge
of the withdrawn evidence cannot reveal its removal through the conditional read.

## Share and resume

Share one currently readable object:

```json
{"operation":"share","of":{"operation":"concept","concept":{"kind":"object","token":"OBJECT_TOKEN"}},"valid":{"kind":"all"},"knownAt":{"kind":"current"}}
```

`of` contains the object operation and its object field; it has no nested time
axis or baseline. A successful share returns `kizuki.resume-handle/v1` with
`handle` and `expiresAt`. An unreadable target is `not_found`; missing capacity
or an unavailable handle store is `unavailable/storage`.

Resume with `{operation: "resume", handle, valid: {kind: "all"},
knownAt: {kind: "current"}}`. The saved valid window is used. The result is a
fresh card with the redeemer's namespace references, never the issuer's refs
or retained payload. When the redeemer's grant omits any part of the issuer's
read scope at issuance, `coverage` is added to the card's gaps and result
reasons. It reveals no counts, labels or issuer identity. A wider or equal
grant adds no clipping gap. Unknown, expired, restored, unreadable-target and
revoked-issuer handles all return `new_view_required`.

Handle resolution always performs bounded lookup and authorization checks
before projecting a target. Unreadable and erased targets take the same path,
including the same returned-row and statement work counters.
The final output transaction checks handle existence, expiry, issuer activity
and target authorization again. Invalidation after projection discards its
pending token and returns the uniform `new_view_required` result.

A handle stores its digest, semantic target, object operation, valid window,
normalized issuer scope and scope digest, and an internal recorded-time marker.
It stores no card or captured text. Before retained history lands, resume reads
the current model; the marker is never disclosed and does not claim historical
repeatability. Time and snapshot queries still return `unavailable/history`.

## Surfaces

```sh
kizuki world --operation concept --ref OBJECT_TOKEN --json
kizuki world --operation concept --ref OBJECT_TOKEN --prior-view VIEW_TOKEN --json
kizuki world --operation concept --ref OBJECT_TOKEN --share --json
kizuki world --operation share --of-operation situation --ref OBJECT_TOKEN --json
kizuki world --resume RESUME_HANDLE --json
```

Text output explains unchanged and invalidated views, shows issued lifetimes,
and prints an explicitly requested resume handle. MCP advertises `priorView`,
`of` and `handle` and validates the complete response grammar. HTTP accepts the
same Core request. The App can check a retained card, share a resume handle and
paste a handle to resume; it retains data locally only after an `unchanged`
answer, and discards inaccessible data through its existing privacy fence.

## Storage, recovery and verification

The VIEW migration is allocated in `world/tables/versions.ts` after the
pre-existing purge and connector cursor migrations. All four tables are cache class:
`world_view_partitions`, `world_view_tokens`, `world_view_token_deps` and
`world_resume_handles`. They are not exported. Restore and world rebuild erase
tokens and handles and seed reservations from current principals. Service
startup invalidates view tokens; portable handles retain their own expiry.
Foreign keys and dependency-erasure triggers physically remove affected token
payloads, digests and dependency rows on purge. A removed semantic target also
removes its handles. Revoking an issuer removes its partition and both caches.

Dependency rows cover the full authorized claim, support and event closure
collected during projection, including discovery label evidence omitted from
the rendered body. Purging label evidence erases its retained projection even
when independently supported claims keep the semantic object alive.

Executable tests cover Core lifecycle and noninterference, enrollment including
the App path, migration, resource limits, rollback, restart, purge, restore,
rebuild and CLI/MCP/HTTP/App parity. The oracle registry promotes only the
assertions these tests exercise; broader history and domain assertions remain
deferred. Full repository verification belongs to integration CI. Wave-close
documentation must reconcile the earlier revision's `not_issued`-only summary
in `CURRENT.md` and capability reporting with this implementation.
