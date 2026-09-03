"""Injected, inert CONNECT-session handling for the future egress proxy.

This module opens no listener and has no resolver or dialer defaults.  A caller
must directly provide every stream and external boundary; deployed controller
and CLI code do not import it.
"""

from __future__ import annotations

import hashlib
import ipaddress
import select
import socket
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping, Protocol

from gauntlet.egress import (
    _host,
    Address,
    EgressAttemptBinding,
    EgressError,
    EgressPolicy,
    parse_connect_request,
    resolve_public_addresses,
    verify_egress_policy,
)


_DENIED = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
_BAD_GATEWAY = b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
_ESTABLISHED = b"HTTP/1.1 200 Connection Established\r\n\r\n"
_CANCEL_POLL_SECONDS = 0.05
_CONTROL_WRITE_SECONDS = 0.25
_RELAY_BUFFER_BYTES = 65_536
_ENCRYPTED_HELLO_EXTENSIONS = frozenset((0xFE0D, 0xFFCE))
_EVENT_SCHEMA = "kizuki-gauntlet-egress-terminal-event-v2"
_ALLOWLIST_NOT_EVALUATED = "NOT_EVALUATED"
_ALLOWLIST_DENIED = "DENIED"
_ALLOWLIST_ALLOWED = "ALLOWED"


class ConnectedStream(Protocol):
    def fileno(self) -> int: ...
    def recv(self, size: int) -> bytes: ...
    def send(self, data: bytes | bytearray) -> int: ...
    def setblocking(self, flag: bool) -> None: ...
    def shutdown(self, how: int) -> None: ...
    def close(self) -> None: ...
    def getpeername(self) -> tuple: ...


class CancellationSignal(Protocol):
    def is_set(self) -> bool: ...


@dataclass(frozen=True)
class ConnectSessionResult:
    outcome: str
    allowlist_decision: str
    hostname_sha256: str | None
    client_to_upstream_bytes: int
    upstream_to_client_bytes: int
    total_bytes: int

    @property
    def admitted(self) -> bool:
        """Whether the requested hostname passed the signed exact allowlist."""
        return self.allowlist_decision == _ALLOWLIST_ALLOWED


def _emit_result(
    event_sink,
    result: ConnectSessionResult,
    binding: EgressAttemptBinding,
    timestamp: int,
) -> ConnectSessionResult:
    try:
        event_sink({
            "schema": _EVENT_SCHEMA,
            "timestamp_unix_seconds": timestamp,
            "adapter": binding.adapter,
            "profile_id": binding.profile_id,
            "outcome": result.outcome,
            "allowlist_decision": result.allowlist_decision,
            "hostname_sha256": result.hostname_sha256,
            "client_to_upstream_bytes": result.client_to_upstream_bytes,
            "upstream_to_client_bytes": result.upstream_to_client_bytes,
            "total_bytes": result.total_bytes,
        })
    except (OSError, TypeError, ValueError):
        raise EgressError("terminal event sink failed") from None
    return result


class AttemptEgressBudget:
    """Thread-safe attempt-wide connection and byte accounting."""

    def __init__(self, policy: EgressPolicy):
        if not isinstance(policy, EgressPolicy):
            raise EgressError("EgressPolicy required")
        self.policy_sha256 = policy.policy_sha256
        self.connections = 0
        self.client_bytes = 0
        self.upstream_bytes = 0
        self._lock = threading.Lock()

    def claim(self, policy: EgressPolicy) -> None:
        with self._lock:
            if policy.policy_sha256 != self.policy_sha256:
                raise EgressError("attempt budget belongs to another policy")
            if self.connections >= policy.max_connections:
                raise EgressError("attempt connection limit reached")
            self.connections += 1

    def reserve(self, policy: EgressPolicy, direction: str, amount: int) -> None:
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
            raise EgressError("invalid egress byte count")
        with self._lock:
            if policy.policy_sha256 != self.policy_sha256:
                raise EgressError("attempt budget belongs to another policy")
            client = self.client_bytes + (amount if direction == "client" else 0)
            upstream = self.upstream_bytes + (amount if direction == "upstream" else 0)
            if direction not in {"client", "upstream"}:
                raise EgressError("invalid egress byte direction")
            if (
                client > policy.max_client_bytes
                or upstream > policy.max_upstream_bytes
                or client + upstream > policy.max_total_bytes
            ):
                raise EgressError("attempt egress byte limit reached")
            self.client_bytes = client
            self.upstream_bytes = upstream


def _host_digest(host: str) -> str:
    return hashlib.sha256(b"kizuki-egress-host-v1\0" + host.encode("ascii")).hexdigest()


def _trusted_timestamp(trusted_time: Callable[[], int]) -> int:
    try:
        timestamp = trusted_time()
    except (OSError, TypeError, ValueError):
        raise EgressError("trusted timestamp unavailable") from None
    if (
        isinstance(timestamp, bool)
        or not isinstance(timestamp, int)
        or not 0 <= timestamp < 2**63
    ):
        raise EgressError("trusted timestamp is invalid")
    return timestamp


class _TerminalBoundary(EgressError):
    def __init__(self, outcome: str):
        super().__init__(outcome)
        self.outcome = outcome


def _wait_readable(stream, timeout: float) -> bool:
    readable, _, _ = select.select((stream,), (), (), max(0.0, timeout))
    return bool(readable)


def _wait_writable(stream, timeout: float) -> bool:
    _, writable, _ = select.select((), (stream,), (), max(0.0, timeout))
    return bool(writable)


def _read_connect(
    stream,
    *,
    maximum: int,
    idle_seconds: int,
    wall_deadline: float,
    monotonic: Callable[[], float],
    cancel_event,
    boundary_check: Callable[[], None],
) -> bytes:
    data = bytearray()
    idle_deadline = monotonic() + idle_seconds
    while b"\r\n\r\n" not in data:
        boundary_check()
        if cancel_event.is_set():
            raise EgressError("session cancelled")
        now = monotonic()
        deadline = min(idle_deadline, wall_deadline)
        if now >= deadline:
            raise EgressError("CONNECT prelude timed out")
        if not _wait_readable(stream, min(deadline - now, _CANCEL_POLL_SECONDS)):
            continue
        boundary_check()
        chunk = stream.recv(min(4096, maximum + 1 - len(data)))
        boundary_check()
        if not chunk:
            raise EgressError("CONNECT stream closed")
        data.extend(chunk)
        idle_deadline = monotonic() + idle_seconds
        if len(data) > maximum:
            raise EgressError("CONNECT request size invalid")
    marker = data.find(b"\r\n\r\n") + 4
    if marker != len(data):
        raise EgressError("CONNECT request contains premature tunnel bytes")
    return bytes(data)


def _read_exact(
    stream,
    size: int,
    *,
    idle_seconds: int,
    wall_deadline: float,
    monotonic: Callable[[], float],
    cancel_event,
    boundary_check: Callable[[], None],
) -> bytes:
    data = bytearray()
    idle_deadline = monotonic() + idle_seconds
    while len(data) < size:
        boundary_check()
        if cancel_event.is_set():
            raise EgressError("session cancelled")
        now = monotonic()
        deadline = min(idle_deadline, wall_deadline)
        if now >= deadline:
            raise EgressError("TLS preface timed out")
        if not _wait_readable(stream, min(deadline - now, _CANCEL_POLL_SECONDS)):
            continue
        boundary_check()
        chunk = stream.recv(size - len(data))
        boundary_check()
        if not chunk:
            raise EgressError("TLS preface closed")
        data.extend(chunk)
        idle_deadline = monotonic() + idle_seconds
    return bytes(data)


def _client_hello_sni(handshake: bytes) -> str:
    if len(handshake) < 4 or handshake[0] != 1:
        raise EgressError("first TLS handshake is not ClientHello")
    declared = int.from_bytes(handshake[1:4], "big")
    if declared != len(handshake) - 4:
        raise EgressError("malformed ClientHello length")
    body = handshake[4:]
    if len(body) < 38 or body[:2] not in {b"\x03\x01", b"\x03\x02", b"\x03\x03"}:
        raise EgressError("malformed ClientHello")
    position = 34
    session_id_length = body[position]
    position += 1
    if session_id_length > 32 or position + session_id_length + 2 > len(body):
        raise EgressError("malformed ClientHello session id")
    position += session_id_length
    cipher_length = int.from_bytes(body[position:position + 2], "big")
    position += 2
    if cipher_length < 2 or cipher_length % 2 or position + cipher_length + 1 > len(body):
        raise EgressError("malformed ClientHello cipher suites")
    position += cipher_length
    compression_length = body[position]
    position += 1
    if compression_length < 1 or position + compression_length + 2 > len(body):
        raise EgressError("malformed ClientHello compression methods")
    if body[position:position + compression_length] != b"\x00":
        raise EgressError("TLS compression is forbidden")
    position += compression_length
    extensions_length = int.from_bytes(body[position:position + 2], "big")
    position += 2
    if extensions_length != len(body) - position:
        raise EgressError("malformed ClientHello extensions")
    end = position + extensions_length
    seen = set()
    sni = None
    while position < end:
        if position + 4 > end:
            raise EgressError("malformed ClientHello extension")
        extension_type = int.from_bytes(body[position:position + 2], "big")
        extension_length = int.from_bytes(body[position + 2:position + 4], "big")
        position += 4
        if extension_type in seen or position + extension_length > end:
            raise EgressError("malformed or duplicate ClientHello extension")
        seen.add(extension_type)
        extension = body[position:position + extension_length]
        position += extension_length
        if extension_type in _ENCRYPTED_HELLO_EXTENSIONS:
            raise EgressError("encrypted ClientHello is forbidden")
        if extension_type != 0:
            continue
        if len(extension) < 5:
            raise EgressError("malformed SNI extension")
        names_length = int.from_bytes(extension[:2], "big")
        if names_length != len(extension) - 2:
            raise EgressError("malformed SNI name list")
        name_type = extension[2]
        name_length = int.from_bytes(extension[3:5], "big")
        if name_type != 0 or name_length == 0 or name_length != len(extension) - 5:
            raise EgressError("malformed SNI hostname")
        try:
            sni = _host(extension[5:].decode("ascii"))
        except UnicodeDecodeError as exc:
            raise EgressError("SNI hostname must be ASCII") from exc
        except EgressError as exc:
            raise EgressError("invalid SNI hostname") from exc
    if position != end or sni is None:
        raise EgressError("ClientHello SNI is required")
    return sni


def _read_client_hello(
    stream,
    *,
    expected_host: str,
    maximum: int,
    idle_seconds: int,
    wall_deadline: float,
    monotonic: Callable[[], float],
    cancel_event,
    boundary_check: Callable[[], None],
) -> bytes:
    raw = bytearray()
    handshake = bytearray()
    expected_handshake_size = None
    while expected_handshake_size is None or len(handshake) < expected_handshake_size:
        header = _read_exact(
            stream, 5, idle_seconds=idle_seconds, wall_deadline=wall_deadline,
            monotonic=monotonic, cancel_event=cancel_event,
            boundary_check=boundary_check,
        )
        record_length = int.from_bytes(header[3:5], "big")
        if (
            header[0] != 22
            or header[1] != 3
            or header[2] > 3
            or record_length == 0
            or len(raw) + 5 + record_length > maximum
        ):
            raise EgressError("invalid or excessive TLS ClientHello record")
        payload = _read_exact(
            stream, record_length, idle_seconds=idle_seconds,
            wall_deadline=wall_deadline, monotonic=monotonic,
            cancel_event=cancel_event, boundary_check=boundary_check,
        )
        raw.extend(header)
        raw.extend(payload)
        handshake.extend(payload)
        if handshake and handshake[0] != 1:
            raise EgressError("first TLS handshake is not ClientHello")
        if len(handshake) >= 4 and expected_handshake_size is None:
            expected_handshake_size = 4 + int.from_bytes(handshake[1:4], "big")
            if expected_handshake_size > maximum - 5:
                raise EgressError("TLS ClientHello is excessive")
        if expected_handshake_size is not None and len(handshake) > expected_handshake_size:
            raise EgressError("unexpected data follows ClientHello")
    if _client_hello_sni(bytes(handshake)) != expected_host:
        raise EgressError("ClientHello SNI does not match CONNECT host")
    return bytes(raw)


def _write_control(
    stream,
    data: bytes,
    *,
    idle_seconds: int,
    wall_deadline: float,
    monotonic: Callable[[], float],
    cancel_event,
    boundary_check: Callable[[], None],
) -> None:
    position = 0
    idle_deadline = monotonic() + idle_seconds
    while position < len(data):
        boundary_check()
        if cancel_event.is_set():
            raise EgressError("session cancelled")
        now = monotonic()
        deadline = min(idle_deadline, wall_deadline)
        if now >= deadline:
            raise EgressError("proxy response timed out")
        if not _wait_writable(stream, min(deadline - now, _CANCEL_POLL_SECONDS)):
            continue
        boundary_check()
        sent = stream.send(data[position:])
        boundary_check()
        if sent <= 0:
            raise EgressError("proxy response closed")
        position += sent
        idle_deadline = monotonic() + idle_seconds


def _shutdown_write(stream) -> bool:
    try:
        stream.shutdown(socket.SHUT_WR)
    except (OSError, ValueError):
        return False
    return True


def _relay(
    client,
    upstream,
    initial_client: bytes,
    policy: EgressPolicy,
    budget: AttemptEgressBudget,
    *,
    started: float,
    monotonic: Callable[[], float],
    cancel_event,
    boundary_check: Callable[[], None],
) -> tuple[str, int, int]:
    def boundary_outcome() -> str | None:
        try:
            boundary_check()
        except _TerminalBoundary as boundary:
            return boundary.outcome
        return None

    stopped = boundary_outcome()
    if stopped is not None:
        return stopped, 0, 0
    try:
        budget.reserve(policy, "client", len(initial_client))
    except EgressError:
        return "BYTE_LIMIT", 0, 0
    client_bytes = 0
    upstream_bytes = 0
    to_upstream = bytearray(initial_client)
    to_client = bytearray()
    client_read_open = True
    upstream_read_open = True
    upstream_write_open = True
    client_write_open = True
    last_activity = monotonic()
    try:
        client.setblocking(False)
        upstream.setblocking(False)
    except (OSError, ValueError):
        return "IO_ERROR", client_bytes, upstream_bytes

    while True:
        stopped = boundary_outcome()
        if stopped is not None:
            return stopped, client_bytes, upstream_bytes
        if cancel_event.is_set():
            return "CANCELLED", client_bytes, upstream_bytes
        now = monotonic()
        if now >= started + policy.wall_seconds:
            return "WALL_TIMEOUT", client_bytes, upstream_bytes
        if now >= last_activity + policy.idle_seconds:
            return "IDLE_TIMEOUT", client_bytes, upstream_bytes
        if not client_read_open and not upstream_read_open and not to_upstream and not to_client:
            return "COMPLETED", client_bytes, upstream_bytes

        if not client_read_open and not to_upstream and upstream_write_open:
            if not _shutdown_write(upstream):
                return "IO_ERROR", client_bytes, upstream_bytes
            upstream_write_open = False
        if not upstream_read_open and not to_client and client_write_open:
            if not _shutdown_write(client):
                return "IO_ERROR", client_bytes, upstream_bytes
            client_write_open = False

        readers = []
        if client_read_open and len(to_upstream) < _RELAY_BUFFER_BYTES:
            readers.append(client)
        if upstream_read_open and len(to_client) < _RELAY_BUFFER_BYTES:
            readers.append(upstream)
        writers = []
        if to_upstream and upstream_write_open:
            writers.append(upstream)
        if to_client and client_write_open:
            writers.append(client)
        deadline = min(
            started + policy.wall_seconds,
            last_activity + policy.idle_seconds,
            now + _CANCEL_POLL_SECONDS,
        )
        try:
            readable, writable, _ = select.select(readers, writers, (), max(0.0, deadline - now))
        except (OSError, ValueError):
            return "IO_ERROR", client_bytes, upstream_bytes

        for destination in writable:
            stopped = boundary_outcome()
            if stopped is not None:
                return stopped, client_bytes, upstream_bytes
            buffer = to_upstream if destination is upstream else to_client
            try:
                sent = destination.send(buffer)
            except (BlockingIOError, InterruptedError):
                continue
            except (OSError, ValueError):
                return "IO_ERROR", client_bytes, upstream_bytes
            if sent <= 0:
                return "IO_ERROR", client_bytes, upstream_bytes
            del buffer[:sent]
            if destination is upstream:
                client_bytes += sent
            else:
                upstream_bytes += sent
            last_activity = monotonic()
            stopped = boundary_outcome()
            if stopped is not None:
                return stopped, client_bytes, upstream_bytes

        for source in readable:
            stopped = boundary_outcome()
            if stopped is not None:
                return stopped, client_bytes, upstream_bytes
            try:
                chunk = source.recv(_RELAY_BUFFER_BYTES)
            except (BlockingIOError, InterruptedError):
                continue
            except (OSError, ValueError):
                return "IO_ERROR", client_bytes, upstream_bytes
            stopped = boundary_outcome()
            if stopped is not None:
                return stopped, client_bytes, upstream_bytes
            if not chunk:
                if source is client:
                    client_read_open = False
                else:
                    upstream_read_open = False
                continue
            direction = "client" if source is client else "upstream"
            try:
                budget.reserve(policy, direction, len(chunk))
            except EgressError:
                return "BYTE_LIMIT", client_bytes, upstream_bytes
            if source is client:
                to_upstream.extend(chunk)
            else:
                to_client.extend(chunk)
            last_activity = monotonic()


def _close(stream) -> None:
    try:
        stream.close()
    except (OSError, ValueError):
        pass


def _best_effort_response(
    stream,
    data: bytes,
    monotonic: Callable[[], float],
) -> None:
    try:
        stream.setblocking(False)
        deadline = monotonic() + _CONTROL_WRITE_SECONDS
        position = 0
        while position < len(data):
            now = monotonic()
            if now >= deadline:
                return
            if not _wait_writable(stream, min(deadline - now, _CANCEL_POLL_SECONDS)):
                continue
            sent = stream.send(data[position:])
            if sent <= 0:
                return
            position += sent
    except (OSError, TypeError, ValueError):
        return


def _deny(stream, monotonic: Callable[[], float]) -> None:
    _best_effort_response(stream, _DENIED, monotonic)


def _bad_gateway(stream, monotonic: Callable[[], float]) -> None:
    _best_effort_response(stream, _BAD_GATEWAY, monotonic)


def _peer_key(sockaddr) -> tuple:
    if not isinstance(sockaddr, tuple) or len(sockaddr) not in (2, 4):
        raise EgressError("malformed peer address")
    try:
        address = ipaddress.ip_address(sockaddr[0])
    except (TypeError, ValueError) as exc:
        raise EgressError("malformed peer address") from exc
    if sockaddr[1] != 443:
        raise EgressError("peer port changed")
    if address.version == 4:
        if len(sockaddr) != 2:
            raise EgressError("peer family changed")
        return (4, address.compressed, 443)
    if len(sockaddr) != 4 or sockaddr[2:] != (0, 0):
        raise EgressError("peer IPv6 metadata changed")
    return (6, address.compressed, 443, 0, 0)


def handle_connect_session(
    client: ConnectedStream,
    policy: EgressPolicy,
    verification_keys: Mapping[str, bytes],
    binding: EgressAttemptBinding,
    budget: AttemptEgressBudget,
    *,
    trusted_time: Callable[[], int],
    resolver: Callable[[str, int, float, CancellationSignal], Iterable[Address]],
    dialer: Callable[[Address, float, CancellationSignal], ConnectedStream],
    cancel_event: CancellationSignal,
    event_sink: Callable[[Mapping[str, object]], None],
    monotonic: Callable[[], float] = time.monotonic,
) -> ConnectSessionResult:
    """Handle one directly injected stream; no listener or network defaults exist."""
    host: str | None = None
    upstream: ConnectedStream | None = None
    allowlist_decision = _ALLOWLIST_NOT_EVALUATED
    last_timestamp: int | None = None

    if not callable(event_sink):
        raise EgressError("terminal event sink is required")

    def sample_trusted_time() -> int:
        nonlocal last_timestamp
        last_timestamp = _trusted_timestamp(trusted_time)
        return last_timestamp

    def terminal(
        outcome: str,
        client_bytes: int = 0,
        upstream_bytes: int = 0,
    ) -> ConnectSessionResult:
        hostname_sha256 = _host_digest(host) if host is not None else None
        return ConnectSessionResult(
            outcome=outcome,
            allowlist_decision=allowlist_decision,
            hostname_sha256=hostname_sha256,
            client_to_upstream_bytes=client_bytes,
            upstream_to_client_bytes=upstream_bytes,
            total_bytes=client_bytes + upstream_bytes,
        )

    def remaining_external_time(
        *,
        connect_deadline: float,
        policy_expiry_deadline: float,
        wall_deadline: float,
        phase_limit: float | None = None,
    ) -> float:
        if cancel_event.is_set():
            raise _TerminalBoundary("CANCELLED")
        timestamp = sample_trusted_time()
        if timestamp >= policy.expires_at:
            raise _TerminalBoundary("POLICY_EXPIRED")
        now = monotonic()
        if now >= policy_expiry_deadline:
            raise _TerminalBoundary("POLICY_EXPIRED")
        if now >= wall_deadline:
            raise _TerminalBoundary("WALL_TIMEOUT")
        if now >= connect_deadline:
            raise _TerminalBoundary("CONNECT_TIMEOUT")
        remaining = min(
            wall_deadline - now,
            connect_deadline - now,
            policy_expiry_deadline - now,
            float(policy.expires_at - timestamp),
        )
        if phase_limit is not None:
            remaining = min(remaining, phase_limit)
        if remaining <= 0:
            raise _TerminalBoundary("CONNECT_TIMEOUT")
        return remaining

    def boundary_after_external_error(
        *,
        connect_deadline: float,
        policy_expiry_deadline: float,
        wall_deadline: float,
    ) -> str | None:
        try:
            remaining_external_time(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
        except _TerminalBoundary as boundary:
            return boundary.outcome
        return None

    def run_session() -> ConnectSessionResult:
        nonlocal allowlist_decision, host, upstream
        admission_timestamp = sample_trusted_time()
        if cancel_event.is_set():
            return terminal("CANCELLED")
        try:
            verify_egress_policy(
                policy, verification_keys, binding, now=admission_timestamp,
            )
            budget.claim(policy)
        except EgressError:
            if cancel_event.is_set():
                return terminal("CANCELLED")
            _deny(client, monotonic)
            return terminal("DENIED_POLICY")
        started = monotonic()
        wall_deadline = started + policy.wall_seconds
        policy_expiry_deadline = started + (
            policy.expires_at - admission_timestamp
        )
        connect_deadline = min(
            started + policy.connect_timeout_seconds,
            wall_deadline,
            policy_expiry_deadline,
        )

        def check_session_boundary() -> None:
            if cancel_event.is_set():
                raise _TerminalBoundary("CANCELLED")
            if sample_trusted_time() >= policy.expires_at:
                raise _TerminalBoundary("POLICY_EXPIRED")
            now = monotonic()
            if now >= policy_expiry_deadline:
                raise _TerminalBoundary("POLICY_EXPIRED")
            if now >= wall_deadline:
                raise _TerminalBoundary("WALL_TIMEOUT")

        def check_connect_boundary() -> None:
            check_session_boundary()
            if monotonic() >= connect_deadline:
                raise _TerminalBoundary("CONNECT_TIMEOUT")

        try:
            prelude = _read_connect(
                client,
                maximum=policy.max_connect_bytes,
                idle_seconds=policy.idle_seconds,
                wall_deadline=wall_deadline,
                monotonic=monotonic,
                cancel_event=cancel_event,
                boundary_check=check_connect_boundary,
            )
            request = parse_connect_request(prelude, policy.max_connect_bytes)
            host = request.host
        except _TerminalBoundary as boundary:
            if boundary.outcome != "CANCELLED":
                _deny(client, monotonic)
            return terminal(boundary.outcome)
        except EgressError:
            if cancel_event.is_set():
                return terminal("CANCELLED")
            _deny(client, monotonic)
            return terminal("DENIED_REQUEST")
        if not policy.permits(request.host, request.port):
            allowlist_decision = _ALLOWLIST_DENIED
            _deny(client, monotonic)
            return terminal("DENIED_HOST")
        allowlist_decision = _ALLOWLIST_ALLOWED

        resolution_started = monotonic()
        try:
            resolution_timeout = remaining_external_time(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
                phase_limit=float(policy.resolver_timeout_seconds),
            )
            resolution_deadline = resolution_started + resolution_timeout
            addresses = resolve_public_addresses(
                host,
                resolver=lambda resolved_host, port, *_args: resolver(
                    resolved_host, port, resolution_timeout, cancel_event,
                ),
            )
            remaining_external_time(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
            if monotonic() >= resolution_deadline:
                raise TimeoutError("resolver exceeded deadline")
        except _TerminalBoundary as boundary:
            if boundary.outcome != "CANCELLED":
                _bad_gateway(client, monotonic)
            return terminal(boundary.outcome)
        except (EgressError, OSError, TimeoutError, TypeError, ValueError):
            deadline_outcome = boundary_after_external_error(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
            if deadline_outcome != "CANCELLED":
                _bad_gateway(client, monotonic)
            return terminal(deadline_outcome or "DENIED_RESOLUTION")

        chosen = addresses[0]
        try:
            dial_timeout = remaining_external_time(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
            upstream = dialer(chosen, dial_timeout, cancel_event)
            remaining_external_time(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
            if _peer_key(upstream.getpeername()) != _peer_key(chosen[4]):
                raise EgressError("dialed peer differs from pinned destination")
            remaining_external_time(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
        except _TerminalBoundary as boundary:
            if boundary.outcome != "CANCELLED":
                _bad_gateway(client, monotonic)
            return terminal(boundary.outcome)
        except (EgressError, OSError, TimeoutError, TypeError, ValueError, AttributeError):
            deadline_outcome = boundary_after_external_error(
                connect_deadline=connect_deadline,
                policy_expiry_deadline=policy_expiry_deadline,
                wall_deadline=wall_deadline,
            )
            if deadline_outcome != "CANCELLED":
                _bad_gateway(client, monotonic)
            return terminal(deadline_outcome or "DENIED_PEER")

        try:
            _write_control(
                client, _ESTABLISHED, idle_seconds=policy.idle_seconds,
                wall_deadline=wall_deadline,
                monotonic=monotonic, cancel_event=cancel_event,
                boundary_check=check_connect_boundary,
            )
            hello = _read_client_hello(
                client, expected_host=host,
                maximum=policy.max_client_hello_bytes,
                idle_seconds=policy.idle_seconds,
                wall_deadline=wall_deadline,
                monotonic=monotonic, cancel_event=cancel_event,
                boundary_check=check_session_boundary,
            )
            outcome, client_bytes, upstream_bytes = _relay(
                client, upstream, hello, policy, budget, started=started,
                monotonic=monotonic, cancel_event=cancel_event,
                boundary_check=check_session_boundary,
            )
        except _TerminalBoundary as boundary:
            return terminal(boundary.outcome)
        except EgressError:
            if cancel_event.is_set():
                return terminal("CANCELLED")
            return terminal("DENIED_TLS")
        return terminal(outcome, client_bytes, upstream_bytes)

    result: ConnectSessionResult | None = None
    try:
        result = run_session()
    except (OSError, ValueError):
        result = terminal("IO_ERROR")
    finally:
        if upstream is not None:
            _close(upstream)
        _close(client)
    if result is None:
        raise EgressError("CONNECT session ended without a terminal result")
    try:
        sample_trusted_time()
    except EgressError:
        if last_timestamp is None:
            raise
    assert last_timestamp is not None
    return _emit_result(event_sink, result, binding, last_timestamp)
