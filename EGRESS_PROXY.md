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

The canonical HMAC-SHA256 policy covers its schema and issuer key ID; campaign,
task, attempt, controller epoch, adapter, principal, authority domain, and
identity generation; the complete network-profile digest; issuance, expiry,
and nonce; and every hostname and limit. Verification requires exactly the one
pinned key named by the policy and an exact `EgressAttemptBinding`. A policy is
valid for at most two hours and is rejected before its issue time and at its
expiry.

`gauntlet.egress_proxy` exposes one directly injected session operation:

```python
handle_connect_session(
    client,
    policy,
    verification_keys,
    binding,
    budget,
    *,
    policy_now,
    resolver,
    dialer,
    cancel_event,
    monotonic=time.monotonic,
    event_sink=None,
) -> ConnectSessionResult
```

The caller must retain one `AttemptEgressBudget` for the entire attempt.
Creating a new budget per connection would defeat aggregate connection and byte
limits and is forbidden for any future integration.

The injected client and upstream objects implement the socket operations used
by `select`, `recv`, `send`, `setblocking`, `shutdown`, and `close`. The
resolver is called as
`resolver(host, 443, timeout_seconds, cancel_event)` and returns
`getaddrinfo`-shaped entries. The dialer is called as
`dialer(chosen_address, timeout_seconds, cancel_event)` and returns a connected
stream whose `getpeername()` exactly matches the chosen address. Neither
dependency has a default implementation.

## Admission sequence

The handler authenticates and binds the policy before reading a request, then
claims the attempt-wide connection budget. It accepts only strict HTTP/1.1
`CONNECT exact-host:443` with a matching Host header and no credential-bearing
proxy headers. The exact hostname must appear in the signed, sorted allowlist.

Resolution is consumed with a 33-entry ceiling. Empty, excessive, mixed, or
non-global answer sets fail as a unit. Address family, stream protocol, port,
and IPv6 flow/scope metadata are checked and canonicalized. The handler chooses
one member of that validated set, gives only that address to the dialer, and
rechecks the connected peer before returning HTTP 200.

Before any client byte reaches the upstream, a bounded TLS ClientHello is
parsed. The first handshake must contain one clear-text SNI exactly equal to
the normalized CONNECT hostname. Missing or duplicate SNI, ECH, non-TLS,
compression, malformed lengths, excess bytes, stalls, and oversized prefaces
close both streams without forwarding the preface.

The nonblocking relay applies shared connection, client-to-upstream,
upstream-to-client, total-byte, idle, and wall limits. It checks cancellation
at most every 50 milliseconds and propagates each clean EOF with a write
half-close. The handler creates no worker thread, task, subprocess, or other
descendant; its `finally` block closes both injected streams.

The optional event sink receives one fixed-shape event. It contains only a
domain-separated SHA-256 hostname hash, fixed outcome/schema strings, a boolean
decision, and bounded byte counters. It contains no raw hostname, address,
header, credential, payload, exception, or model output.

## Non-enablement dependencies

This library is not sufficient to enable egress. A later, separately reviewed
change must supply all of the following:

- controller-owned policy issuance, key rotation, durable nonce/replay rules,
  and exactly one shared budget per attempt;
- a production resolver and dialer that enforce the supplied deadlines and
  cancellation internally; this synchronous seam rejects late returns but
  cannot preempt a dependency that ignores its timeout;
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
