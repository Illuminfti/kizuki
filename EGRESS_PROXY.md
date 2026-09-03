# Inert attempt-bound egress seam

Evidence date: 2026-09-03.

This checkout contains a standalone policy validator and CONNECT-session
handler for synthetic review. It is deliberately not imported by the
controller, CLI, executor, configuration, or systemd units. It opens no
listener, performs no resolution by default, and cannot enable network access.

## Public seam

`gauntlet.egress` exposes these policy operations:

```python
network_profile_sha256(**network_limits) -> str
sign_egress_policy(*, signing_key: bytes, **policy_fields) -> EgressPolicy
verify_egress_policy(
    policy: EgressPolicy,
    verification_keys: Mapping[str, bytes],
    binding: EgressAttemptBinding,
    *,
    now: int,
) -> EgressPolicy
```

The version-2 canonical HMAC-SHA256 policy covers its schema and issuer key ID;
campaign, task, attempt, controller epoch, adapter, profile, principal,
authority domain, and identity generation; the complete network-profile
digest; issuance, expiry, and nonce; and every hostname and limit. Verification
requires exactly the one pinned key named by the policy and an exact live
`EgressAttemptBinding`. A policy is valid for at most two hours and is rejected
before its issue time and at its expiry.

The signed network profile includes a connection-establishment timeout. Its
invariants are:

```text
1 <= resolver_timeout_seconds <= connect_timeout_seconds <= 30
connect_timeout_seconds <= wall_seconds
```

`gauntlet.egress_proxy` exposes one directly injected session operation:

```python
handle_connect_session(
    client,
    policy,
    verification_keys,
    binding,
    budget,
    *,
    trusted_time,
    resolver,
    dialer,
    cancel_event,
    event_sink,
    monotonic=time.monotonic,
) -> ConnectSessionResult
```

`trusted_time` is a required injected callable returning a trusted integer Unix
timestamp. It supplies admission, absolute-expiry checks, and the terminal
event timestamp. `event_sink` is also required. It is invoked exactly once for
every handled terminal result after stream cleanup; a sink `OSError`,
`TypeError`, or `ValueError` becomes the fixed `terminal event sink failed`
error without retaining exception text.

The injected client and upstream objects implement the socket operations used
by `select`, `recv`, `send`, `setblocking`, `shutdown`, and `close`. The
resolver is called as
`resolver(host, 443, timeout_seconds, cancel_event)` and returns
`getaddrinfo`-shaped entries. The dialer is called as
`dialer(chosen_address, timeout_seconds, cancel_event)` and returns a connected
stream whose `getpeername()` exactly matches the chosen address. Neither
dependency has a default implementation.

## Admission and deadline sequence

The handler authenticates and binds the policy before reading a request, then
claims the attempt-wide connection budget. It accepts only strict HTTP/1.1
`CONNECT exact-host:443` with a matching Host header and no credential-bearing
proxy headers. The normalized hostname must appear exactly in the signed,
sorted allowlist.

The connection deadline starts immediately after policy admission and covers
the CONNECT prelude, resolution, dial, peer recheck, and the pre-200 boundary.
It is the minimum of the signed connection timeout, session wall deadline, and
the policy-expiry deadline translated to monotonic time. The trusted wall clock
is also rechecked, so neither wall-clock rollback nor a forward jump extends
authority. Cancellation, policy expiry, wall expiry, and connection expiry are
checked before and after resolver and dialer calls. Resolver and dialer timeout
arguments are clamped to every remaining deadline; a callback returning at a
deadline is late, its stream is closed, and HTTP 200 is never sent.

Resolution is consumed with a 33-entry ceiling. Empty, excessive, mixed, or
non-global answer sets fail as a unit. Address family, stream protocol, port,
and IPv6 flow/scope metadata are checked and canonicalized. The handler chooses
one member of that validated set, gives only that address to the dialer, and
rechecks the connected peer before returning HTTP 200. A production resolver
and dialer must enforce the supplied timeout and cancellation internally; this
synchronous seam rejects late returns but cannot preempt a dependency that
ignores its inputs.

Before any client byte reaches the upstream, a bounded TLS ClientHello is
parsed. The first handshake must contain one clear-text ASCII SNI which, after
the same lowercase exact-host validation used by CONNECT, equals the CONNECT
hostname. Missing or duplicate SNI, ECH, non-TLS, compression, malformed
lengths, invalid host syntax, excess bytes, stalls, and oversized prefaces
close both streams without forwarding the preface.

The nonblocking relay applies client-to-upstream, upstream-to-client,
total-byte, idle, wall, absolute-policy-expiry, and cancellation limits. It
polls boundaries at most every 50 milliseconds and propagates each clean EOF
with a write half-close. Socket and control-path `OSError` and `ValueError`
after policy admission fail closed as `IO_ERROR`; their text is never stored.
Pre-200 denial responses are best effort, retain the underlying terminal
decision if their write fails, and have a hard-coded 250-millisecond write
ceiling. The handler creates no worker thread, task, subprocess, or descendant.

## Terminal evidence semantics

The required sink receives one fixed-shape
`kizuki-gauntlet-egress-terminal-event-v2` event. Adapter and profile come from
the live attempt binding, including when policy authentication fails. The event
contains only the trusted integer timestamp, a domain-separated SHA-256
hostname hash, fixed schema/outcome/admission strings, and bounded byte
counters. It contains no raw hostname, address, header, credential, payload,
exception, or model output.

The directional event counters record bytes actually written across the relay,
not merely bytes read into a pending buffer. Attempt-budget accounting reserves
accepted input earlier, so a failed write cannot restore or reuse that budget.

`allowlist_decision` is independent of terminal `outcome`:

- `NOT_EVALUATED`: no exact-host allowlist decision was reached;
- `DENIED`: the parsed exact host was absent from the signed allowlist;
- `ALLOWED`: the parsed exact host was present in the signed allowlist.

Thus an allowed request remains `ALLOWED` when its later outcome is
`BYTE_LIMIT`, `IDLE_TIMEOUT`, `POLICY_EXPIRED`, `CANCELLED`, or `IO_ERROR`.
`ConnectSessionResult.admitted` is true only for that last admission state. It
does not mean the tunnel completed or that application authority was proven.

## What SNI does not prove

Clear-text SNI is an unauthenticated routing hint. This seam does not terminate
TLS, validate a certificate, see encrypted HTTP authority, or prove that a
vendor application received the request. Shared IPs and certificates,
domain-fronting behavior, HTTP/2 connection coalescing, and other co-host
routing can expose applications beyond the visible SNI name even when DNS and
peer pinning are correct.

Consequently, outer containment must not enable this seam until independent
evidence proves endpoint exclusivity for each allowed host and a controller-
owned immutable adapter-to-profile-and-digest registry. The local adapter
spelling allowlist and SNI parser are not substitutes for either gate.

## Non-enablement dependencies

This library is not sufficient to enable egress. A later, separately reviewed
change must supply all of the following:

- controller-owned policy issuance, key rotation, and transactional durable
  consumption of every signed nonce;
- durable attempt-wide connection and directional/total byte accounting shared
  across sessions, processes, crashes, and restarts; `AttemptEgressBudget` is
  only caller-owned memory and recreating it bypasses aggregate limits;
- independently reviewed endpoint-exclusivity evidence and an immutable
  controller-owned adapter/profile/digest registry;
- production resolver, dialer, and audit sink implementations that enforce
  supplied deadlines, cancellation, and durable terminal-event recording;
- the reviewed Unix-socket listener, private-network relay, namespace and
  service containment, lifecycle ownership, and real-VPS escape tests;
- controller/executor/configuration wiring and a deliberately narrow enablement
  gate after all acceptance evidence exists.

`gauntlet/protocol.py` does not need a change for this inert slice because no
policy is stored in task state, accepted over a controller boundary, or used by
a state transition. Persisting or distributing this policy later would be a
protocol/schema change and requires its own migration and replay review.

## Verification

The tests use only Unix socket pairs and synthetic resolver/dialer functions.
They make no real network or model calls.

```sh
python3 -m unittest discover -s tests -p 'test_egress.py' -v
python3 -m unittest discover -s tests -p 'test_egress_proxy.py' -v
python3 -m unittest discover -s tests -v
```
