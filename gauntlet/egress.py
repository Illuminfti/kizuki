"""Fail-closed primitives for the future attempt-bound egress proxy.

This module performs no I/O at import time, opens no listener, and is not wired
to the controller.  It validates the only request form the reviewed CONNECT
proxy may accept and resolves a complete, public-only address set for pinning.
"""

from __future__ import annotations

import hashlib
import hmac
import ipaddress
import json
import re
import socket
from dataclasses import asdict, dataclass, fields, replace
from itertools import islice
from typing import Callable, Iterable, Mapping, Tuple


class EgressError(RuntimeError):
    pass


_PROFILE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_HEADER = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_ADAPTERS = frozenset(("codex", "claude", "cursor", "grok"))
EGRESS_POLICY_SCHEMA = "kizuki-gauntlet-egress-policy-v1"


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError) as exc:
        raise EgressError("egress policy is not canonicalizable") from exc


def _key(value: bytes) -> bytes:
    if not isinstance(value, bytes) or len(value) < 32:
        raise EgressError("egress-policy HMAC key must be at least 32 bytes")
    return value


def _identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise EgressError(f"invalid {label}")
    return value


def _digest(value: str, label: str) -> str:
    if not isinstance(value, str) or not _HEX64.fullmatch(value):
        raise EgressError(f"invalid {label}")
    return value


def _positive(value: int, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise EgressError(f"invalid {label}")
    return value


def _host(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 253:
        raise EgressError("invalid hostname")
    try:
        value.encode("ascii")
    except UnicodeEncodeError as exc:
        raise EgressError("hostname must be ASCII") from exc
    value = value.lower()
    if value.endswith(".") or "*" in value or value == "localhost":
        raise EgressError("hostname must be exact")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        pass
    else:
        raise EgressError("literal addresses are forbidden")
    labels = value.split(".")
    if len(labels) < 2 or any(not _LABEL.fullmatch(label) for label in labels):
        raise EgressError("invalid or overly broad hostname")
    return value


def _network_values(
    *, profile_id: str, hosts: Tuple[str, ...], max_connections: int,
    max_client_bytes: int, max_upstream_bytes: int, max_total_bytes: int,
    resolver_timeout_seconds: int, idle_seconds: int, wall_seconds: int,
    max_connect_bytes: int, max_client_hello_bytes: int,
) -> dict:
    if not isinstance(profile_id, str) or not _PROFILE.fullmatch(profile_id):
        raise EgressError("invalid profile id")
    if not isinstance(hosts, tuple) or not 1 <= len(hosts) <= 64:
        raise EgressError("one to 64 exact hosts required")
    normalized = tuple(_host(host) for host in hosts)
    if normalized != tuple(sorted(set(normalized))):
        raise EgressError("hosts must be normalized, sorted, and unique")
    _positive(max_connections, "connection limit", 64)
    _positive(max_client_bytes, "client byte limit", 1_000_000_000)
    _positive(max_upstream_bytes, "upstream byte limit", 1_000_000_000)
    _positive(max_total_bytes, "total byte limit", 2_000_000_000)
    _positive(resolver_timeout_seconds, "resolver timeout", 30)
    _positive(idle_seconds, "idle timeout", 300)
    _positive(wall_seconds, "wall timeout", 3600)
    _positive(max_connect_bytes, "CONNECT byte limit", 65_536)
    _positive(max_client_hello_bytes, "ClientHello byte limit", 262_144)
    if resolver_timeout_seconds > wall_seconds or idle_seconds > wall_seconds:
        raise EgressError("phase timeout exceeds wall limit")
    return {
        "profile_id": profile_id,
        "hosts": normalized,
        "max_connections": max_connections,
        "max_client_bytes": max_client_bytes,
        "max_upstream_bytes": max_upstream_bytes,
        "max_total_bytes": max_total_bytes,
        "resolver_timeout_seconds": resolver_timeout_seconds,
        "idle_seconds": idle_seconds,
        "wall_seconds": wall_seconds,
        "max_connect_bytes": max_connect_bytes,
        "max_client_hello_bytes": max_client_hello_bytes,
    }


def network_profile_sha256(**values) -> str:
    """Digest the complete network authority surface, not an arbitrary label."""
    material = _network_values(**values)
    return hashlib.sha256(
        b"kizuki-egress-network-profile-v1\0" + _canonical(material)
    ).hexdigest()


@dataclass(frozen=True)
class EgressAttemptBinding:
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    adapter: str
    principal_id: str
    authority_domain: str
    identity_generation: int
    network_profile_sha256: str

    def __post_init__(self) -> None:
        for value, label in (
            (self.campaign_id, "campaign id"),
            (self.task_id, "task id"),
            (self.principal_id, "principal id"),
            (self.authority_domain, "authority domain"),
        ):
            _identifier(value, label)
        _positive(self.attempt, "attempt", 2**63 - 1)
        _positive(self.controller_epoch, "controller epoch", 2**63 - 1)
        _positive(self.identity_generation, "identity generation", 2**63 - 1)
        if self.adapter not in _ADAPTERS:
            raise EgressError("invalid adapter")
        _digest(self.network_profile_sha256, "network-profile digest")


@dataclass(frozen=True)
class EgressPolicy:
    schema: str
    issuer_key_id: str
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    adapter: str
    principal_id: str
    authority_domain: str
    identity_generation: int
    profile_id: str
    hosts: Tuple[str, ...]
    max_connections: int
    max_client_bytes: int
    max_upstream_bytes: int
    max_total_bytes: int
    resolver_timeout_seconds: int
    idle_seconds: int
    wall_seconds: int
    max_connect_bytes: int
    max_client_hello_bytes: int
    network_profile_sha256: str
    issued_at: int
    expires_at: int
    nonce: str
    policy_sha256: str
    signature_sha256: str

    def __post_init__(self) -> None:
        if self.schema != EGRESS_POLICY_SCHEMA:
            raise EgressError("unknown egress-policy schema")
        for value, label in (
            (self.issuer_key_id, "issuer key id"),
            (self.campaign_id, "campaign id"),
            (self.task_id, "task id"),
            (self.principal_id, "principal id"),
            (self.authority_domain, "authority domain"),
        ):
            _identifier(value, label)
        _positive(self.attempt, "attempt", 2**63 - 1)
        _positive(self.controller_epoch, "controller epoch", 2**63 - 1)
        _positive(self.identity_generation, "identity generation", 2**63 - 1)
        if self.adapter not in _ADAPTERS:
            raise EgressError("invalid adapter")
        network = _network_values(
            profile_id=self.profile_id, hosts=self.hosts,
            max_connections=self.max_connections,
            max_client_bytes=self.max_client_bytes,
            max_upstream_bytes=self.max_upstream_bytes,
            max_total_bytes=self.max_total_bytes,
            resolver_timeout_seconds=self.resolver_timeout_seconds,
            idle_seconds=self.idle_seconds, wall_seconds=self.wall_seconds,
            max_connect_bytes=self.max_connect_bytes,
            max_client_hello_bytes=self.max_client_hello_bytes,
        )
        object.__setattr__(self, "hosts", network["hosts"])
        expected_profile = network_profile_sha256(**network)
        if self.network_profile_sha256 != expected_profile:
            raise EgressError("network-profile digest mismatch")
        if (
            isinstance(self.issued_at, bool)
            or isinstance(self.expires_at, bool)
            or not isinstance(self.issued_at, int)
            or not isinstance(self.expires_at, int)
            or self.issued_at < 0
            or not self.issued_at < self.expires_at <= self.issued_at + 7200
        ):
            raise EgressError("invalid egress-policy lifetime")
        _digest(self.nonce, "policy nonce")
        _digest(self.policy_sha256, "policy digest")
        _digest(self.signature_sha256, "policy signature")

    def permits(self, host: str, port: int = 443) -> bool:
        if port != 443:
            return False
        try:
            normalized = _host(host)
        except EgressError:
            return False
        return normalized in self.hosts


_UNSIGNED_POLICY_FIELDS = tuple(
    item.name for item in fields(EgressPolicy)
    if item.name not in {"policy_sha256", "signature_sha256"}
)


def _unsigned_policy(policy: EgressPolicy) -> dict:
    material = asdict(policy)
    return {name: material[name] for name in _UNSIGNED_POLICY_FIELDS}


def sign_egress_policy(*, signing_key: bytes, **values) -> EgressPolicy:
    key = _key(signing_key)
    if set(values) != set(_UNSIGNED_POLICY_FIELDS):
        raise EgressError("egress-policy fields are not exactly allowlisted")
    provisional = EgressPolicy(
        **values, policy_sha256="0" * 64, signature_sha256="0" * 64,
    )
    digest = hashlib.sha256(_canonical(_unsigned_policy(provisional))).hexdigest()
    with_digest = replace(provisional, policy_sha256=digest)
    signature = hmac.new(
        key,
        b"kizuki-egress-policy-v1\0" + _canonical({
            **_unsigned_policy(with_digest), "policy_sha256": digest,
        }),
        hashlib.sha256,
    ).hexdigest()
    return replace(with_digest, signature_sha256=signature)


def verify_egress_policy(
    policy: EgressPolicy,
    verification_keys: Mapping[str, bytes],
    binding: EgressAttemptBinding,
    *,
    now: int,
) -> EgressPolicy:
    if not isinstance(policy, EgressPolicy) or not isinstance(binding, EgressAttemptBinding):
        raise EgressError("egress policy and attempt binding required")
    if isinstance(now, bool) or not isinstance(now, int) or not policy.issued_at <= now < policy.expires_at:
        raise EgressError("egress policy is not current")
    if not isinstance(verification_keys, Mapping) or set(verification_keys) != {policy.issuer_key_id}:
        raise EgressError("exactly one pinned egress-policy key is required")
    key = _key(verification_keys[policy.issuer_key_id])
    digest = hashlib.sha256(_canonical(_unsigned_policy(policy))).hexdigest()
    if not hmac.compare_digest(policy.policy_sha256, digest):
        raise EgressError("egress-policy digest mismatch")
    signature = hmac.new(
        key,
        b"kizuki-egress-policy-v1\0" + _canonical({
            **_unsigned_policy(policy), "policy_sha256": policy.policy_sha256,
        }),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(policy.signature_sha256, signature):
        raise EgressError("egress-policy authentication failed")
    expected = (
        policy.campaign_id, policy.task_id, policy.attempt,
        policy.controller_epoch, policy.adapter, policy.principal_id,
        policy.authority_domain, policy.identity_generation,
        policy.network_profile_sha256,
    )
    actual = (
        binding.campaign_id, binding.task_id, binding.attempt,
        binding.controller_epoch, binding.adapter, binding.principal_id,
        binding.authority_domain, binding.identity_generation,
        binding.network_profile_sha256,
    )
    if actual != expected:
        raise EgressError("egress policy does not match attempt identity")
    return policy


@dataclass(frozen=True)
class ConnectRequest:
    host: str
    port: int


def parse_connect_request(data: bytes, limit: int = 8192) -> ConnectRequest:
    """Parse the complete HTTP proxy prelude without retaining header values."""
    if not isinstance(data, bytes) or not data or len(data) > limit:
        raise EgressError("CONNECT request size invalid")
    if not data.endswith(b"\r\n\r\n") or b"\x00" in data:
        raise EgressError("incomplete or malformed CONNECT request")
    try:
        text = data.decode("ascii")
    except UnicodeDecodeError as exc:
        raise EgressError("CONNECT request must be ASCII") from exc
    lines = text[:-4].split("\r\n")
    if not lines or len(lines) > 33:
        raise EgressError("invalid header count")
    parts = lines[0].split(" ")
    if len(parts) != 3 or parts[0] != "CONNECT" or parts[2] != "HTTP/1.1":
        raise EgressError("only HTTP/1.1 CONNECT is allowed")
    target = parts[1]
    if target.count(":") != 1:
        raise EgressError("CONNECT target must be host:443")
    raw_host, raw_port = target.rsplit(":", 1)
    if raw_port != "443":
        raise EgressError("only destination port 443 is allowed")
    host = _host(raw_host)
    seen = set()
    header_host = None
    for line in lines[1:]:
        if not line or ":" not in line:
            raise EgressError("malformed CONNECT header")
        name, value = line.split(":", 1)
        if not _HEADER.fullmatch(name):
            raise EgressError("malformed header name")
        lowered = name.lower()
        if lowered in seen:
            raise EgressError("duplicate CONNECT header")
        seen.add(lowered)
        value = value.strip()
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise EgressError("malformed header value")
        if lowered in {"proxy-authorization", "authorization", "cookie"}:
            raise EgressError("credentials are forbidden in proxy headers")
        if lowered == "host":
            header_host = value.lower()
    if header_host is None:
        raise EgressError("Host header is required")
    if header_host != f"{host}:443":
        raise EgressError("Host header does not match CONNECT target")
    return ConnectRequest(host=host, port=443)


Address = Tuple[int, int, int, str, tuple]


def resolve_public_addresses(
    host: str,
    *,
    resolver: Callable[..., Iterable[Address]],
) -> Tuple[Address, ...]:
    """Resolve once and return a deduplicated all-global address set to pin.

    A mixed public/private answer is rejected in full.  The caller must connect
    only to a returned sockaddr and must not resolve again for that tunnel.
    """
    normalized = _host(host)
    try:
        iterator = iter(resolver(
            normalized, 443, 0, socket.SOCK_STREAM, socket.IPPROTO_TCP,
        ))
        try:
            raw = list(islice(iterator, 33))
        finally:
            close = getattr(iterator, "close", None)
            if callable(close):
                close()
    except (OSError, TypeError, ValueError) as exc:
        raise EgressError("resolution failed") from exc
    if not raw or len(raw) > 32:
        raise EgressError("empty or excessive resolution result")
    result = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, tuple) or len(entry) != 5:
            raise EgressError("malformed resolution result")
        family, socktype, protocol, canonname, sockaddr = entry
        if (
            family not in (socket.AF_INET, socket.AF_INET6)
            or socktype != socket.SOCK_STREAM
            or protocol != socket.IPPROTO_TCP
            or not isinstance(canonname, str)
        ):
            raise EgressError("unsupported resolution result")
        expected_length = 2 if family == socket.AF_INET else 4
        if (
            not isinstance(sockaddr, tuple)
            or len(sockaddr) != expected_length
            or not isinstance(sockaddr[0], str)
            or "%" in sockaddr[0]
            or isinstance(sockaddr[1], bool)
            or sockaddr[1] != 443
        ):
            raise EgressError("resolved destination port mismatch")
        if family == socket.AF_INET6 and (
            isinstance(sockaddr[2], bool)
            or isinstance(sockaddr[3], bool)
            or sockaddr[2:] != (0, 0)
        ):
            raise EgressError("resolved IPv6 metadata is forbidden")
        try:
            address = ipaddress.ip_address(sockaddr[0])
        except ValueError as exc:
            raise EgressError("invalid resolved address") from exc
        if (
            (family == socket.AF_INET and address.version != 4)
            or (family == socket.AF_INET6 and address.version != 6)
        ):
            raise EgressError("resolved address family mismatch")
        if (
            not address.is_global
            or address.is_private
            or address.is_loopback
            or address.is_link_local
            or address.is_multicast
            or address.is_reserved
            or address.is_unspecified
        ):
            raise EgressError("non-global destination is forbidden")
        key = (family, str(address), 443)
        if key in seen:
            continue
        seen.add(key)
        canonical_sockaddr = (
            (address.compressed, 443)
            if family == socket.AF_INET
            else (address.compressed, 443, 0, 0)
        )
        result.append((family, socktype, protocol, "", canonical_sockaddr))
    if not result:
        raise EgressError("no public destination")
    return tuple(result)
