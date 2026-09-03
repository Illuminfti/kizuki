"""Minimal, generation-bound harness identity materialization.

This module is deliberately local and inert. It copies a reviewed identity
artifact set into a fresh attempt home, then issues a short-lived controller
MAC over the evidence required to admit that identity to a protocol phase.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
from dataclasses import dataclass, replace
from pathlib import Path, PurePosixPath
from typing import MutableSet, Tuple


class IdentityError(RuntimeError):
    pass


_ADAPTERS = frozenset(("codex", "claude", "cursor", "grok"))
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_AUTH_STATES = frozenset(("READY", "FAILED", "UNKNOWN"))
_ROUTE_STATES = frozenset(("READY", "FAILED", "UNKNOWN", "QUOTA_BLOCKED"))
_TOTAL_LIMIT = 16 * 1024 * 1024
_MAX_BINDING_SECONDS = 600


def _digest(value: str, label: str) -> str:
    if not isinstance(value, str) or not _HEX64.fullmatch(value):
        raise IdentityError(f"invalid {label}")
    return value


def _relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise IdentityError("invalid artifact path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise IdentityError("artifact path must be a normalized relative path")
    if len(path.parts) > 8 or len(value.encode("utf-8")) > 240:
        raise IdentityError("artifact path exceeds bound")
    return path


def _owned_private_directory(path: Path, label: str) -> None:
    if path.is_symlink():
        raise IdentityError(f"{label} may not be a symlink")
    try:
        info = os.lstat(path)
    except OSError as exc:
        raise IdentityError(f"{label} is unavailable") from exc
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
        raise IdentityError(f"{label} must be an owned mode-0700 directory")


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")


def _disjoint(left: Path, right: Path) -> None:
    try:
        lhs, rhs = left.resolve(strict=False), right.resolve(strict=False)
    except OSError as exc:
        raise IdentityError("identity path cannot be safely resolved") from exc
    if lhs == rhs or lhs in rhs.parents or rhs in lhs.parents:
        raise IdentityError("vault generation and attempt destination must be disjoint")


@dataclass(frozen=True)
class Artifact:
    path: str
    sha256: str
    max_bytes: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", _relative(self.path).as_posix())
        _digest(self.sha256, "artifact digest")
        if isinstance(self.max_bytes, bool) or not isinstance(self.max_bytes, int) or not 1 <= self.max_bytes <= 4 * 1024 * 1024:
            raise IdentityError("invalid artifact byte bound")


@dataclass(frozen=True)
class AttestedArtifact:
    path: str
    sha256: str
    bytes: int

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", _relative(self.path).as_posix())
        _digest(self.sha256, "attested artifact digest")
        if isinstance(self.bytes, bool) or not isinstance(self.bytes, int) or self.bytes < 0:
            raise IdentityError("invalid attested artifact size")


@dataclass(frozen=True)
class IdentityManifest:
    principal_id: str
    authority_domain: str
    adapter: str
    generation: int
    account_binding_sha256: str
    executable_sha256: str
    network_profile_sha256: str
    artifacts: Tuple[Artifact, ...]

    def __post_init__(self) -> None:
        if not isinstance(self.principal_id, str) or not _ID.fullmatch(self.principal_id): raise IdentityError("invalid principal id")
        if not isinstance(self.authority_domain, str) or not _ID.fullmatch(self.authority_domain): raise IdentityError("invalid authority domain")
        if self.adapter not in _ADAPTERS: raise IdentityError("unknown adapter")
        if isinstance(self.generation, bool) or not isinstance(self.generation, int) or self.generation < 1: raise IdentityError("invalid identity generation")
        for value, label in ((self.account_binding_sha256, "account binding"), (self.executable_sha256, "executable digest"), (self.network_profile_sha256, "network profile digest")):
            _digest(value, label)
        if not isinstance(self.artifacts, tuple) or not 1 <= len(self.artifacts) <= 16 or any(not isinstance(item, Artifact) for item in self.artifacts): raise IdentityError("one to 16 identity artifacts required")
        paths = [item.path for item in self.artifacts]
        if len(paths) != len(set(paths)) or sum(item.max_bytes for item in self.artifacts) > _TOTAL_LIMIT: raise IdentityError("invalid identity artifact inventory")


@dataclass(frozen=True)
class IdentityReceipt:
    principal_id: str
    authority_domain: str
    adapter: str
    generation: int
    account_binding_sha256: str
    executable_sha256: str
    network_profile_sha256: str
    checked_at: float
    expires_at: float
    auth_status: str
    route_status: str

    def __post_init__(self) -> None:
        if not isinstance(self.principal_id, str) or not _ID.fullmatch(self.principal_id): raise IdentityError("invalid receipt principal")
        if not isinstance(self.authority_domain, str) or not _ID.fullmatch(self.authority_domain): raise IdentityError("invalid receipt authority domain")
        if self.adapter not in _ADAPTERS or isinstance(self.generation, bool) or not isinstance(self.generation, int) or self.generation < 1: raise IdentityError("invalid receipt identity")
        for value, label in ((self.account_binding_sha256, "receipt account binding"), (self.executable_sha256, "receipt executable"), (self.network_profile_sha256, "receipt network profile")):
            _digest(value, label)
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in (self.checked_at, self.expires_at)) or self.expires_at <= self.checked_at: raise IdentityError("invalid receipt lifetime")
        if self.auth_status not in _AUTH_STATES or self.route_status not in _ROUTE_STATES: raise IdentityError("invalid receipt readiness")
        if self.route_status == "READY" and self.auth_status != "READY": raise IdentityError("route readiness requires authentication")


@dataclass(frozen=True)
class MaterializedIdentity:
    principal_id: str
    authority_domain: str
    adapter: str
    generation: int
    manifest_sha256: str
    artifacts: Tuple[AttestedArtifact, ...]
    total_bytes: int
    attestation_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.principal_id, str) or not _ID.fullmatch(self.principal_id): raise IdentityError("invalid materialized principal")
        if not isinstance(self.authority_domain, str) or not _ID.fullmatch(self.authority_domain): raise IdentityError("invalid materialized authority domain")
        if self.adapter not in _ADAPTERS or isinstance(self.generation, bool) or not isinstance(self.generation, int) or self.generation < 1: raise IdentityError("invalid materialized identity")
        _digest(self.manifest_sha256, "materialized manifest digest")
        if not isinstance(self.artifacts, tuple) or not self.artifacts or any(not isinstance(item, AttestedArtifact) for item in self.artifacts): raise IdentityError("invalid materialized artifact inventory")
        paths = [item.path for item in self.artifacts]
        if paths != sorted(paths) or len(paths) != len(set(paths)): raise IdentityError("materialized inventory must be sorted and unique")
        if isinstance(self.total_bytes, bool) or not isinstance(self.total_bytes, int) or self.total_bytes != sum(item.bytes for item in self.artifacts) or self.total_bytes > _TOTAL_LIMIT: raise IdentityError("invalid materialized byte total")
        _digest(self.attestation_sha256, "materialized identity attestation")

    @property
    def files(self) -> Tuple[str, ...]:
        return tuple(item.path for item in self.artifacts)


@dataclass(frozen=True)
class AuthorityBinding:
    principal_id: str
    authority_domain: str
    adapter: str
    generation: int
    account_binding_sha256: str
    executable_sha256: str
    network_profile_sha256: str
    manifest_sha256: str
    receipt_sha256: str
    operation_sha256: str
    checked_at: float
    expires_at: float
    binding_id: str
    signature_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.principal_id, str) or not _ID.fullmatch(self.principal_id): raise IdentityError("invalid authority principal")
        if not isinstance(self.authority_domain, str) or not _ID.fullmatch(self.authority_domain): raise IdentityError("invalid authority domain")
        if self.adapter not in _ADAPTERS or isinstance(self.generation, bool) or not isinstance(self.generation, int) or self.generation < 1: raise IdentityError("invalid authority identity")
        for value, label in ((self.account_binding_sha256, "authority account binding"), (self.executable_sha256, "authority executable"), (self.network_profile_sha256, "authority network profile"), (self.manifest_sha256, "authority manifest"), (self.receipt_sha256, "authority receipt"), (self.operation_sha256, "authority operation"), (self.binding_id, "authority binding id"), (self.signature_sha256, "authority signature")):
            _digest(value, label)
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in (self.checked_at, self.expires_at)) or not self.checked_at < self.expires_at <= self.checked_at + _MAX_BINDING_SECONDS: raise IdentityError("authority binding must be short lived")


def _manifest_hash(manifest: IdentityManifest) -> str:
    value = {"principal_id": manifest.principal_id, "authority_domain": manifest.authority_domain, "adapter": manifest.adapter, "generation": manifest.generation, "account_binding_sha256": manifest.account_binding_sha256, "executable_sha256": manifest.executable_sha256, "network_profile_sha256": manifest.network_profile_sha256, "artifacts": [(item.path, item.sha256, item.max_bytes) for item in manifest.artifacts]}
    return hashlib.sha256(_canonical(value)).hexdigest()


def _receipt_hash(receipt: IdentityReceipt) -> str:
    value = {"principal_id": receipt.principal_id, "authority_domain": receipt.authority_domain, "adapter": receipt.adapter, "generation": receipt.generation, "account_binding_sha256": receipt.account_binding_sha256, "executable_sha256": receipt.executable_sha256, "network_profile_sha256": receipt.network_profile_sha256, "checked_at": receipt.checked_at, "expires_at": receipt.expires_at, "auth_status": receipt.auth_status, "route_status": receipt.route_status}
    return hashlib.sha256(_canonical(value)).hexdigest()


def _binding_payload(binding: AuthorityBinding) -> bytes:
    return _canonical({name: getattr(binding, name) for name in ("principal_id", "authority_domain", "adapter", "generation", "account_binding_sha256", "executable_sha256", "network_profile_sha256", "manifest_sha256", "receipt_sha256", "operation_sha256", "checked_at", "expires_at", "binding_id")})


def _materialized_payload(receipt: MaterializedIdentity) -> bytes:
    return _canonical({"principal_id": receipt.principal_id, "authority_domain": receipt.authority_domain,
                       "adapter": receipt.adapter, "generation": receipt.generation,
                       "manifest_sha256": receipt.manifest_sha256,
                       "artifacts": [(item.path, item.sha256, item.bytes) for item in receipt.artifacts],
                       "total_bytes": receipt.total_bytes})


def _hmac_key(key: bytes) -> bytes:
    if not isinstance(key, bytes) or len(key) < 32: raise IdentityError("controller HMAC key must be at least 32 bytes")
    return key


def _read_artifact(generation_root: Path, artifact: Artifact) -> bytes:
    current = generation_root
    for part in PurePosixPath(artifact.path).parts[:-1]:
        current = current / part; _owned_private_directory(current, "identity artifact directory")
    path = generation_root.joinpath(*PurePosixPath(artifact.path).parts)
    try: fd = os.open(path, os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc: raise IdentityError("identity artifact cannot be opened safely") from exc
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600: raise IdentityError("identity artifact must be an owned mode-0600 file")
        if info.st_size > artifact.max_bytes: raise IdentityError("identity artifact exceeds bound")
        data = bytearray()
        while len(data) <= artifact.max_bytes:
            chunk = os.read(fd, min(65536, artifact.max_bytes + 1 - len(data)))
            if not chunk: break
            data.extend(chunk)
        value = bytes(data)
        if len(value) > artifact.max_bytes: raise IdentityError("identity artifact exceeds bound")
        if hashlib.sha256(value).hexdigest() != artifact.sha256: raise IdentityError("identity artifact digest changed")
        return value
    finally: os.close(fd)


def materialize_attempt_home(manifest: IdentityManifest, vault_root: str | Path, destination: str | Path,
                             controller_hmac_key: bytes) -> MaterializedIdentity:
    if not isinstance(manifest, IdentityManifest): raise IdentityError("IdentityManifest required")
    _hmac_key(controller_hmac_key)
    vault, destination = Path(vault_root), Path(destination)
    if not vault.is_absolute() or not destination.is_absolute(): raise IdentityError("identity paths must be absolute")
    _owned_private_directory(vault, "identity vault")
    principal_root = vault / manifest.principal_id; generation_root = principal_root / f"generation-{manifest.generation}"
    _owned_private_directory(principal_root, "principal vault"); _owned_private_directory(generation_root, "identity generation")
    _disjoint(generation_root, destination)
    if destination.is_symlink() or destination.exists(): raise IdentityError("attempt home must be fresh")
    _owned_private_directory(destination.parent, "attempt parent")
    verified = [(artifact, _read_artifact(generation_root, artifact)) for artifact in manifest.artifacts]
    total = sum(len(data) for _, data in verified)
    if total > _TOTAL_LIMIT: raise IdentityError("identity material exceeds total bound")
    try:
        os.mkdir(destination, 0o700); os.chmod(destination, 0o700)
        for artifact, data in verified:
            current = destination
            for part in PurePosixPath(artifact.path).parts[:-1]:
                current = current / part
                if not current.exists(): os.mkdir(current, 0o700)
                _owned_private_directory(current, "attempt identity directory")
            target = destination.joinpath(*PurePosixPath(artifact.path).parts)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600)
            try:
                offset = 0
                while offset < len(data): offset += os.write(fd, data[offset:])
                os.fsync(fd); os.fchmod(fd, 0o600)
            finally: os.close(fd)
        directory_fd = os.open(destination, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
    except OSError as exc:
        raise IdentityError("attempt identity materialization failed") from exc
    inventory = tuple(sorted((AttestedArtifact(item.path, hashlib.sha256(data).hexdigest(), len(data)) for item, data in verified), key=lambda item: item.path))
    unsigned = MaterializedIdentity(manifest.principal_id, manifest.authority_domain, manifest.adapter,
                                    manifest.generation, _manifest_hash(manifest), inventory, total, "0" * 64)
    signature = hmac.new(controller_hmac_key, b"kizuki-materialized-identity-v1\0" + _materialized_payload(unsigned), hashlib.sha256).hexdigest()
    return replace(unsigned, attestation_sha256=signature)


def verify_materialized_identity(receipt: MaterializedIdentity, controller_hmac_key: bytes) -> None:
    """Fail closed on fabricated or altered materialization receipts."""
    _hmac_key(controller_hmac_key)
    if not isinstance(receipt, MaterializedIdentity):
        raise IdentityError("MaterializedIdentity receipt required")
    expected = hmac.new(controller_hmac_key, b"kizuki-materialized-identity-v1\0" + _materialized_payload(receipt), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(receipt.attestation_sha256, expected):
        raise IdentityError("materialized identity attestation failed")


def receipt_is_current(manifest: IdentityManifest, receipt: IdentityReceipt, now: float) -> bool:
    if not isinstance(manifest, IdentityManifest) or not isinstance(receipt, IdentityReceipt) or isinstance(now, bool) or not isinstance(now, (int, float)): return False
    return (receipt.principal_id == manifest.principal_id and receipt.authority_domain == manifest.authority_domain and receipt.adapter == manifest.adapter and receipt.generation == manifest.generation and receipt.account_binding_sha256 == manifest.account_binding_sha256 and receipt.executable_sha256 == manifest.executable_sha256 and receipt.network_profile_sha256 == manifest.network_profile_sha256 and receipt.checked_at <= now < receipt.expires_at and receipt.auth_status == "READY" and receipt.route_status == "READY")


def validated_authority_binding(manifest: IdentityManifest, receipt: IdentityReceipt, now: float, controller_hmac_key: bytes, operation_sha256: str) -> AuthorityBinding:
    _hmac_key(controller_hmac_key); _digest(operation_sha256, "operation digest")
    if not receipt_is_current(manifest, receipt, now): raise IdentityError("identity receipt is not current for this manifest")
    checked_at, expires_at = float(now), min(float(receipt.expires_at), float(now) + _MAX_BINDING_SECONDS)
    manifest_hash, receipt_hash = _manifest_hash(manifest), _receipt_hash(receipt)
    seed = _canonical([manifest_hash, receipt_hash, operation_sha256, checked_at, expires_at])
    binding_id = hmac.new(controller_hmac_key, b"kizuki-authority-id\0" + seed, hashlib.sha256).hexdigest()
    unsigned = AuthorityBinding(manifest.principal_id, manifest.authority_domain, manifest.adapter, manifest.generation, manifest.account_binding_sha256, manifest.executable_sha256, manifest.network_profile_sha256, manifest_hash, receipt_hash, operation_sha256, checked_at, expires_at, binding_id, "0" * 64)
    signature = hmac.new(controller_hmac_key, b"kizuki-authority-v1\0" + _binding_payload(unsigned), hashlib.sha256).hexdigest()
    return replace(unsigned, signature_sha256=signature)


def verify_authority_binding(binding: AuthorityBinding, manifest: IdentityManifest, receipt: IdentityReceipt, now: float, controller_hmac_key: bytes, operation_sha256: str, consumed_binding_ids: MutableSet[str]) -> None:
    """Fail closed, consume-on-success verification for a protocol transition.

    ``consumed_binding_ids`` must be backed by the protocol's durable atomic
    transaction. A transient set is intentionally not sufficient in production.
    """
    _hmac_key(controller_hmac_key); _digest(operation_sha256, "operation digest")
    if not isinstance(binding, AuthorityBinding) or not isinstance(consumed_binding_ids, MutableSet): raise IdentityError("authority verifier requires a durable consumed-id set")
    if binding.binding_id in consumed_binding_ids: raise IdentityError("authority binding was already consumed")
    if binding.operation_sha256 != operation_sha256 or not receipt_is_current(manifest, receipt, now): raise IdentityError("authority binding context is not current")
    if not binding.checked_at <= now < binding.expires_at or binding.manifest_sha256 != _manifest_hash(manifest) or binding.receipt_sha256 != _receipt_hash(receipt): raise IdentityError("authority binding is expired or does not match evidence")
    for name in ("principal_id", "authority_domain", "adapter", "generation", "account_binding_sha256", "executable_sha256", "network_profile_sha256"):
        if getattr(binding, name) != getattr(manifest, name): raise IdentityError("authority binding does not match manifest")
    expected_id = hmac.new(controller_hmac_key, b"kizuki-authority-id\0" + _canonical([binding.manifest_sha256, binding.receipt_sha256, binding.operation_sha256, binding.checked_at, binding.expires_at]), hashlib.sha256).hexdigest()
    expected_signature = hmac.new(controller_hmac_key, b"kizuki-authority-v1\0" + _binding_payload(binding), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(binding.binding_id, expected_id) or not hmac.compare_digest(binding.signature_sha256, expected_signature): raise IdentityError("authority binding authentication failed")
    consumed_binding_ids.add(binding.binding_id)
