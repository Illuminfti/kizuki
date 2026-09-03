"""Fail-closed primitives for the future attempt-bound egress proxy.

This module performs no I/O at import time, opens no listener, and is not wired
to the controller.  It validates the only request form the reviewed CONNECT
proxy may accept and resolves a complete, public-only address set for pinning.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from dataclasses import dataclass
from typing import Callable, Iterable, Tuple


class EgressError(RuntimeError):
    pass


_PROFILE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}\Z")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
_HEADER = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}\Z")


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


@dataclass(frozen=True)
class EgressPolicy:
    profile_id: str
    hosts: Tuple[str, ...]
    max_connections: int
    max_bytes: int
    idle_seconds: int
    wall_seconds: int

    def __post_init__(self) -> None:
        if not isinstance(self.profile_id, str) or not _PROFILE.fullmatch(self.profile_id):
            raise EgressError("invalid profile id")
        if not isinstance(self.hosts, tuple) or not 1 <= len(self.hosts) <= 64:
            raise EgressError("one to 64 exact hosts required")
        normalized = tuple(_host(host) for host in self.hosts)
        if len(set(normalized)) != len(normalized):
            raise EgressError("duplicate host")
        object.__setattr__(self, "hosts", normalized)
        limits = (self.max_connections, self.max_bytes, self.idle_seconds, self.wall_seconds)
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 1 for value in limits):
            raise EgressError("positive integer limits required")
        if self.max_connections > 64 or self.max_bytes > 1_000_000_000:
            raise EgressError("egress limits too broad")
        if self.idle_seconds > 300 or self.wall_seconds > 3600:
            raise EgressError("time limits too broad")

    def permits(self, host: str) -> bool:
        try:
            normalized = _host(host)
        except EgressError:
            return False
        return normalized in self.hosts


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
    if header_host is not None and header_host != f"{host}:443":
        raise EgressError("Host header does not match CONNECT target")
    return ConnectRequest(host=host, port=443)


Address = Tuple[int, int, int, str, tuple]


def resolve_public_addresses(
    host: str,
    *,
    resolver: Callable[..., Iterable[Address]] = socket.getaddrinfo,
) -> Tuple[Address, ...]:
    """Resolve once and return a deduplicated all-global address set to pin.

    A mixed public/private answer is rejected in full.  The caller must connect
    only to a returned sockaddr and must not resolve again for that tunnel.
    """
    normalized = _host(host)
    try:
        raw = list(resolver(normalized, 443, 0, socket.SOCK_STREAM, socket.IPPROTO_TCP))
    except (OSError, socket.gaierror) as exc:
        raise EgressError("resolution failed") from exc
    if not raw or len(raw) > 32:
        raise EgressError("empty or excessive resolution result")
    result = []
    seen = set()
    for entry in raw:
        if not isinstance(entry, tuple) or len(entry) != 5:
            raise EgressError("malformed resolution result")
        family, socktype, protocol, canonname, sockaddr = entry
        if family not in (socket.AF_INET, socket.AF_INET6) or socktype != socket.SOCK_STREAM:
            raise EgressError("unsupported resolution result")
        if not isinstance(sockaddr, tuple) or len(sockaddr) < 2 or sockaddr[1] != 443:
            raise EgressError("resolved destination port mismatch")
        try:
            address = ipaddress.ip_address(sockaddr[0])
        except ValueError as exc:
            raise EgressError("invalid resolved address") from exc
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
        result.append((family, socktype, protocol, canonname, sockaddr))
    if not result:
        raise EgressError("no public destination")
    return tuple(result)
