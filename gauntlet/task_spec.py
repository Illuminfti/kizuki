"""Canonical, authenticated specifications for one inert harness launch.

Task specifications carry authority context but no credential.  This module
only validates and authenticates immutable data; it performs no filesystem,
process, network, controller, or repository operation.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
import hashlib
import hmac
import json
import re
from pathlib import PurePosixPath
from typing import Mapping, Sequence, Tuple


class TaskSpecError(RuntimeError):
    pass


TASK_SPEC_SCHEMA = "kizuki-gauntlet-task-spec-v1"
_ADAPTERS = frozenset(("codex", "claude", "cursor", "grok"))
_ROLES = frozenset({
    "BUILDER", "VERIFIER", "SPEC_REVIEWER", "REGRESSION_REVIEWER",
    "INDEPENDENT_REVIEWER", "INTEGRATOR", "POST_MERGE_VERIFIER",
})
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_LOWER_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,79}\Z")
_REPOSITORY = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\Z"
)
_BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\Z")
_HEX40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_SPEC_SECONDS = 7200
_MAX_MEMORY_BYTES = 64 * 1024 * 1024 * 1024


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError) as exc:
        raise TaskSpecError("task specification is not canonicalizable") from exc


def _key(value: bytes) -> bytes:
    if not isinstance(value, bytes) or len(value) < 32:
        raise TaskSpecError("task-spec HMAC key must be at least 32 bytes")
    return value


def _positive(value: int, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise TaskSpecError(f"invalid {label}")
    return value


def _digest(value: str, label: str, pattern: re.Pattern[str] = _HEX64) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise TaskSpecError(f"invalid {label}")
    return value


def _identifier(value: str, label: str, *, lower: bool = False) -> str:
    pattern = _LOWER_ID if lower else _ID
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise TaskSpecError(f"invalid {label}")
    return value


def _branch(value: str) -> str:
    if (
        not isinstance(value, str)
        or not _BRANCH.fullmatch(value)
        or value.endswith(("/", ".", ".lock"))
        or ".." in value
        or "//" in value
        or "@{" in value
        or any(part in ("", ".", "..") for part in value.split("/"))
    ):
        raise TaskSpecError("invalid expected branch")
    return value


def _path_prefix(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or "\x00" in value
        or "\\" in value
        or any(ord(char) < 32 or ord(char) == 127 for char in value)
    ):
        raise TaskSpecError("invalid path-policy prefix")
    path = PurePosixPath(value)
    if (
        path.is_absolute()
        or path.as_posix() != value
        or any(part in ("", ".", "..") for part in path.parts)
    ):
        raise TaskSpecError("path-policy prefix must be normalized and relative")
    if len(path.parts) > 16 or len(value.encode("utf-8")) > 240:
        raise TaskSpecError("path-policy prefix exceeds bound")
    return path.as_posix()


def _path_policy(values: Tuple[str, ...], label: str) -> Tuple[str, ...]:
    if not isinstance(values, tuple) or not 1 <= len(values) <= 64:
        raise TaskSpecError(f"{label} must contain one to 64 prefixes")
    normalized = tuple(_path_prefix(value) for value in values)
    if normalized != tuple(sorted(set(normalized))):
        raise TaskSpecError(f"{label} must be sorted and unique")
    return normalized


def command_policy_sha256(name: str, argv: Sequence[str]) -> str:
    """Return the canonical digest of one named controller-owned argv."""
    _identifier(name, "command policy", lower=True)
    if (
        not isinstance(argv, (tuple, list))
        or not argv
        or len(argv) > 64
        or any(not isinstance(value, str) or not value or "\x00" in value for value in argv)
    ):
        raise TaskSpecError("invalid command-policy argv")
    return hashlib.sha256(_canonical({"name": name, "argv": list(argv)})).hexdigest()


@dataclass(frozen=True)
class TaskSpec:
    schema: str
    issuer_key_id: str
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    expected_task_version: int
    lease_token: int
    lease_run_id: str
    repository: str
    base_sha: str
    expected_branch: str
    allowed_paths: Tuple[str, ...]
    forbidden_paths: Tuple[str, ...]
    adapter: str
    principal_id: str
    authority_domain: str
    identity_generation: int
    role: str
    command_policy: str
    command_policy_sha256: str
    wall_seconds: int
    cpu_seconds: int
    cpu_quota_percent: int
    memory_bytes: int
    process_max: int
    output_bytes: int
    network_profile: str
    network_profile_sha256: str
    issued_at: int
    expires_at: int
    expected_receipt_schema: str
    nonce: str
    task_spec_sha256: str
    signature_sha256: str

    def __post_init__(self) -> None:
        if self.schema != TASK_SPEC_SCHEMA:
            raise TaskSpecError("unknown task-spec schema")
        for value, label in (
            (self.issuer_key_id, "issuer key id"),
            (self.campaign_id, "campaign id"),
            (self.task_id, "task id"),
            (self.lease_run_id, "lease run id"),
            (self.principal_id, "principal id"),
            (self.authority_domain, "authority domain"),
        ):
            _identifier(value, label)
        for value, label in (
            (self.attempt, "attempt"),
            (self.controller_epoch, "controller epoch"),
            (self.expected_task_version, "expected task version"),
            (self.lease_token, "lease token"),
            (self.identity_generation, "identity generation"),
        ):
            _positive(value, label, 2**63 - 1)
        if not isinstance(self.repository, str) or not _REPOSITORY.fullmatch(self.repository):
            raise TaskSpecError("invalid repository identity")
        _digest(self.base_sha, "base SHA", _HEX40)
        _branch(self.expected_branch)
        allowed_paths = _path_policy(self.allowed_paths, "allowed path policy")
        forbidden_paths = _path_policy(self.forbidden_paths, "forbidden path policy")
        if set(allowed_paths) & set(forbidden_paths):
            raise TaskSpecError("path-policy prefixes may not be both allowed and forbidden")
        if self.adapter not in _ADAPTERS:
            raise TaskSpecError("unknown adapter")
        if self.role not in _ROLES:
            raise TaskSpecError("unknown role")
        _identifier(self.command_policy, "command policy", lower=True)
        _digest(self.command_policy_sha256, "command-policy digest")
        _positive(self.wall_seconds, "wall budget", 3600)
        _positive(self.cpu_seconds, "CPU budget", 36_000)
        _positive(self.cpu_quota_percent, "CPU quota", 1000)
        _positive(self.memory_bytes, "memory budget", _MAX_MEMORY_BYTES)
        _positive(self.process_max, "process budget", 512)
        _positive(self.output_bytes, "output budget", 64 * 1024 * 1024)
        _identifier(self.network_profile, "network profile", lower=True)
        _digest(self.network_profile_sha256, "network-profile digest")
        if (
            isinstance(self.issued_at, bool)
            or isinstance(self.expires_at, bool)
            or not isinstance(self.issued_at, int)
            or not isinstance(self.expires_at, int)
            or self.issued_at < 0
            or not self.issued_at < self.expires_at <= self.issued_at + _MAX_SPEC_SECONDS
        ):
            raise TaskSpecError("invalid task-spec lifetime")
        _identifier(self.expected_receipt_schema, "expected receipt schema", lower=True)
        _digest(self.nonce, "task-spec nonce")
        _digest(self.task_spec_sha256, "task-spec digest")
        _digest(self.signature_sha256, "task-spec signature")


_UNSIGNED_FIELDS = tuple(
    field.name for field in fields(TaskSpec)
    if field.name not in {"task_spec_sha256", "signature_sha256"}
)


def _unsigned_mapping(spec: TaskSpec) -> dict:
    material = asdict(spec)
    return {name: material[name] for name in _UNSIGNED_FIELDS}


def _signature_payload(spec: TaskSpec) -> bytes:
    return _canonical({**_unsigned_mapping(spec), "task_spec_sha256": spec.task_spec_sha256})


def sign_task_spec(*, signing_key: bytes, **values) -> TaskSpec:
    """Validate and sign exactly one allowlisted task-spec field set."""
    key = _key(signing_key)
    if set(values) != set(_UNSIGNED_FIELDS):
        raise TaskSpecError("task-spec fields are not exactly allowlisted")
    provisional = TaskSpec(
        **values, task_spec_sha256="0" * 64, signature_sha256="0" * 64,
    )
    digest = hashlib.sha256(_canonical(_unsigned_mapping(provisional))).hexdigest()
    with_digest = replace(provisional, task_spec_sha256=digest)
    signature = hmac.new(
        key, b"kizuki-task-spec-v1\0" + _signature_payload(with_digest), hashlib.sha256,
    ).hexdigest()
    return replace(with_digest, signature_sha256=signature)


def verify_task_spec(
    spec: TaskSpec, verification_keys: Mapping[str, bytes], *, now: int,
) -> TaskSpec:
    """Authenticate a current task specification and return the same object."""
    if not isinstance(spec, TaskSpec):
        raise TaskSpecError("TaskSpec required")
    if isinstance(now, bool) or not isinstance(now, int):
        raise TaskSpecError("verification time must be an integer")
    if not spec.issued_at <= now < spec.expires_at:
        raise TaskSpecError("task specification is not current")
    if not isinstance(verification_keys, Mapping) or set(verification_keys) != {spec.issuer_key_id}:
        raise TaskSpecError("exactly one pinned task-spec key is required")
    key = _key(verification_keys[spec.issuer_key_id])
    digest = hashlib.sha256(_canonical(_unsigned_mapping(spec))).hexdigest()
    if not hmac.compare_digest(spec.task_spec_sha256, digest):
        raise TaskSpecError("task-spec digest mismatch")
    signature = hmac.new(
        key, b"kizuki-task-spec-v1\0" + _signature_payload(spec), hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(spec.signature_sha256, signature):
        raise TaskSpecError("task-spec authentication failed")
    return spec
