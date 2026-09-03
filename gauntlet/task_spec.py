"""Immutable, authenticated task specifications for one Gauntlet attempt.

The envelope deliberately carries only bounded controller-selected values.  It
is not a command channel: executable arguments, filesystem locations, process
identifiers, lease tokens, patches, and credentials have no representation in
the schema.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import stat
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Tuple
from urllib.parse import urlsplit


class TaskSpecError(RuntimeError):
    """A task specification is malformed, stale, or unauthenticated."""


_DOMAIN = "kizuki-gauntlet.task-spec.v2"
_SCHEMA_VERSION = 2
_MAX_ENVELOPE_BYTES = 64 * 1024
_MAX_SPEC_BODY_BYTES = 64 * 1024
_MAX_INSTRUCTION_BYTES = 1024 * 1024
_MAX_SPEC_TTL_SECONDS = 3900
_MAX_CLOCK_SKEW_SECONDS = 30
_TASK_SPEC_NAME = "task-spec.json"
_HEX40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_OPAQUE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_POLICY_ID = re.compile(r"[a-z0-9][a-z0-9._-]{0,79}\Z")
_REPOSITORY = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\Z"
)
_ADAPTERS = frozenset(("codex", "claude", "cursor", "grok"))
_ROLES = frozenset((
    "builder", "verifier", "spec-reviewer", "regression-reviewer",
    "independent-reviewer", "integrator", "post-merge-verifier",
))
# Networked profiles remain deliberately unrepresentable until the CONNECT
# relay has its own accepted gate.  Adding a profile is therefore a code review,
# not a free-form specification change.
_NETWORK_PROFILES = frozenset(("offline",))


def _canonical(value: object) -> bytes:
    try:
        rendered = json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise TaskSpecError("task specification is not canonical JSON") from exc
    return rendered.encode("ascii")


def _positive_integer(value: object, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise TaskSpecError(f"invalid {label}")
    return value


def _clock_sample(clock: Callable[[], int] | None) -> int:
    current = int(time.time()) if clock is None else clock()
    if isinstance(current, bool) or not isinstance(current, int) or current < 0:
        raise TaskSpecError("task specification clock returned an invalid time")
    return current


def _opaque(value: object, label: str) -> str:
    if not isinstance(value, str) or not _OPAQUE_ID.fullmatch(value):
        raise TaskSpecError(f"invalid {label}")
    return value


def _policy(value: object, label: str) -> str:
    if not isinstance(value, str) or not _POLICY_ID.fullmatch(value):
        raise TaskSpecError(f"invalid {label}")
    return value


def _digest(value: object, length: int, label: str) -> str:
    expression = _HEX40 if length == 40 else _HEX64
    if not isinstance(value, str) or not expression.fullmatch(value):
        raise TaskSpecError(f"invalid {label}")
    return value


def _branch(value: object) -> str:
    if (not isinstance(value, str) or not 1 <= len(value.encode("utf-8")) <= 120
            or value.startswith(("-", ".", "/")) or value.endswith(("/", "."))
            or ".." in value or "//" in value or "@{" in value
            or value.endswith(".lock") or "\\" in value
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)
            or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/" for character in value)):
        raise TaskSpecError("invalid expected branch")
    return value


def _prefixes(values: object, label: str) -> Tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise TaskSpecError(f"invalid {label}")
    try:
        candidates = tuple(values)  # type: ignore[arg-type]
    except TypeError as exc:
        raise TaskSpecError(f"invalid {label}") from exc
    if not candidates or len(candidates) > 64:
        raise TaskSpecError(f"invalid {label}")
    normalized = []
    for value in candidates:
        if (not isinstance(value, str) or not value or "\x00" in value or "\\" in value
                or len(value.encode("utf-8")) > 240):
            raise TaskSpecError(f"invalid {label}")
        path = PurePosixPath(value)
        if (path.is_absolute() or len(path.parts) > 16
                or any(part in ("", ".", "..") or part.casefold() == ".git"
                       for part in path.parts)
                or path.as_posix() != value.rstrip("/")):
            raise TaskSpecError(f"invalid {label}")
        normalized.append(path.as_posix())
    if len(set(normalized)) != len(normalized):
        raise TaskSpecError(f"duplicate {label}")
    return tuple(sorted(normalized))


def _issue_url(value: object, repository: str) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 300 or not value.isascii():
        raise TaskSpecError("invalid issue URL")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise TaskSpecError("invalid issue URL") from exc
    expected_prefix = f"/{repository}/issues/"
    if (parsed.scheme != "https" or parsed.hostname != "github.com"
            or parsed.username is not None or parsed.password is not None
            or port is not None or parsed.query or parsed.fragment
            or not parsed.path.startswith(expected_prefix)):
        raise TaskSpecError("invalid issue URL")
    issue_number = parsed.path[len(expected_prefix):]
    if not issue_number.isdigit() or issue_number.startswith("0") or "/" in issue_number:
        raise TaskSpecError("invalid issue URL")
    return value


@dataclass(frozen=True)
class ResourceBudgets:
    wall_seconds: int
    cpu_seconds: int
    memory_bytes: int
    process_limit: int
    output_bytes: int

    def __post_init__(self) -> None:
        _positive_integer(self.wall_seconds, "wall budget", 3600)
        _positive_integer(self.cpu_seconds, "CPU budget", 3600)
        if self.cpu_seconds > self.wall_seconds:
            raise TaskSpecError("CPU budget exceeds wall budget")
        _positive_integer(self.memory_bytes, "memory budget", 64 * 1024 * 1024 * 1024)
        _positive_integer(self.process_limit, "process budget", 512)
        _positive_integer(self.output_bytes, "output budget", 64 * 1024 * 1024)


@dataclass(frozen=True)
class TaskSpec:
    campaign_id: str
    task_id: str
    task_attempt: int
    phase_attempt_id: str
    controller_epoch: int
    repository: str
    base_sha: str
    subject_sha: str
    expected_branch: str
    issue_url: str
    instruction_sha256: str
    instruction_bytes: int
    allowed_prefixes: Tuple[str, ...]
    forbidden_prefixes: Tuple[str, ...]
    adapter: str
    principal_id: str
    role: str
    verification_policy: str
    budgets: ResourceBudgets
    network_profile: str
    issued_at: int
    expires_at: int
    receipt_schema: str

    def __post_init__(self) -> None:
        _opaque(self.campaign_id, "campaign id")
        _opaque(self.task_id, "task id")
        _positive_integer(self.task_attempt, "task attempt", 2**31 - 1)
        _digest(self.phase_attempt_id, 64, "phase attempt id")
        _positive_integer(self.controller_epoch, "controller epoch", 2**63 - 1)
        if not isinstance(self.repository, str) or not _REPOSITORY.fullmatch(self.repository):
            raise TaskSpecError("invalid repository")
        _digest(self.base_sha, 40, "base SHA")
        _digest(self.subject_sha, 40, "subject SHA")
        _branch(self.expected_branch)
        _issue_url(self.issue_url, self.repository)
        _digest(self.instruction_sha256, 64, "instruction SHA-256")
        _positive_integer(
            self.instruction_bytes, "instruction byte length", _MAX_INSTRUCTION_BYTES,
        )
        allowed = _prefixes(self.allowed_prefixes, "allowed prefixes")
        forbidden = _prefixes(self.forbidden_prefixes, "forbidden prefixes")
        if set(allowed) & set(forbidden):
            raise TaskSpecError("path prefixes conflict")
        if not isinstance(self.adapter, str) or self.adapter not in _ADAPTERS:
            raise TaskSpecError("invalid adapter")
        _opaque(self.principal_id, "principal id")
        if not isinstance(self.role, str) or self.role not in _ROLES:
            raise TaskSpecError("invalid role")
        _policy(self.verification_policy, "verification policy")
        if not isinstance(self.budgets, ResourceBudgets):
            raise TaskSpecError("ResourceBudgets required")
        if (not isinstance(self.network_profile, str)
                or self.network_profile not in _NETWORK_PROFILES):
            raise TaskSpecError("network profile is not enabled")
        _positive_integer(self.issued_at, "issuance time", 2**63 - 1)
        _positive_integer(self.expires_at, "expiry", 2**63 - 1)
        lifetime = self.expires_at - self.issued_at
        if (lifetime <= 0 or lifetime > _MAX_SPEC_TTL_SECONDS
                or lifetime > self.budgets.wall_seconds + 300):
            raise TaskSpecError("task specification lifetime exceeds its bound")
        _policy(self.receipt_schema, "receipt schema")
        object.__setattr__(self, "allowed_prefixes", allowed)
        object.__setattr__(self, "forbidden_prefixes", forbidden)


@dataclass(frozen=True)
class SignedTaskSpec:
    spec: TaskSpec
    task_spec_sha256: str
    signing_key_id: str
    signature_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.spec, TaskSpec):
            raise TaskSpecError("TaskSpec required")
        _digest(self.task_spec_sha256, 64, "task specification digest")
        _opaque(self.signing_key_id, "signing key id")
        _digest(self.signature_sha256, 64, "task specification signature")


def _budgets_payload(budgets: ResourceBudgets) -> dict[str, int]:
    return {
        "cpu_seconds": budgets.cpu_seconds,
        "memory_bytes": budgets.memory_bytes,
        "output_bytes": budgets.output_bytes,
        "process_limit": budgets.process_limit,
        "wall_seconds": budgets.wall_seconds,
    }


def _spec_payload(spec: TaskSpec) -> dict[str, object]:
    return {
        "adapter": spec.adapter,
        "allowed_prefixes": list(spec.allowed_prefixes),
        "base_sha": spec.base_sha,
        "budgets": _budgets_payload(spec.budgets),
        "campaign_id": spec.campaign_id,
        "controller_epoch": spec.controller_epoch,
        "expected_branch": spec.expected_branch,
        "expires_at": spec.expires_at,
        "forbidden_prefixes": list(spec.forbidden_prefixes),
        "issued_at": spec.issued_at,
        "issue_url": spec.issue_url,
        "instruction_bytes": spec.instruction_bytes,
        "instruction_sha256": spec.instruction_sha256,
        "network_profile": spec.network_profile,
        "principal_id": spec.principal_id,
        "receipt_schema": spec.receipt_schema,
        "repository": spec.repository,
        "role": spec.role,
        "schema_version": _SCHEMA_VERSION,
        "task_attempt": spec.task_attempt,
        "phase_attempt_id": spec.phase_attempt_id,
        "task_id": spec.task_id,
        "subject_sha": spec.subject_sha,
        "verification_policy": spec.verification_policy,
    }


def _canonical_spec_bytes(spec: TaskSpec) -> bytes:
    encoded = _canonical(_spec_payload(spec))
    if len(encoded) > _MAX_SPEC_BODY_BYTES:
        raise TaskSpecError("task specification body exceeds its size bound")
    return encoded


def _validate_key(controller_hmac_key: object) -> bytes:
    if (not isinstance(controller_hmac_key, bytes)
            or not 32 <= len(controller_hmac_key) <= 4096):
        raise TaskSpecError("controller HMAC key must contain 32 to 4096 bytes")
    return controller_hmac_key


def _signature_input(spec_sha256: str, signing_key_id: str) -> bytes:
    return _canonical({
        "domain": _DOMAIN,
        "signing_key_id": signing_key_id,
        "task_spec_sha256": spec_sha256,
    })


def sign_task_spec(
    spec: TaskSpec, signing_key_id: str, controller_hmac_key: bytes,
) -> SignedTaskSpec:
    """Authenticate one immutable body; no mutable consumption occurs here."""
    if not isinstance(spec, TaskSpec):
        raise TaskSpecError("TaskSpec required")
    key_id = _opaque(signing_key_id, "signing key id")
    key = _validate_key(controller_hmac_key)
    digest = hashlib.sha256(_canonical_spec_bytes(spec)).hexdigest()
    signature = hmac.new(key, _signature_input(digest, key_id), hashlib.sha256).hexdigest()
    result = SignedTaskSpec(spec, digest, key_id, signature)
    canonical_envelope_bytes(result)
    return result


def verify_task_spec(
    envelope: SignedTaskSpec, controller_hmac_key: bytes, *, now: int | None = None,
    expected_phase_attempt_id: str | None = None,
    expected_subject_sha: str | None = None,
    expected_instruction_sha256: str | None = None,
    expected_instruction_bytes: int | None = None,
) -> SignedTaskSpec:
    """Verify body digest, key binding, MAC, and currentness without side effects."""
    if not isinstance(envelope, SignedTaskSpec):
        raise TaskSpecError("SignedTaskSpec required")
    # Bound the complete transport envelope before cryptographic work so an
    # oversized forged object cannot reach a filesystem materialization path.
    canonical_envelope_bytes(envelope)
    key = _validate_key(controller_hmac_key)
    current = int(time.time()) if now is None else now
    if isinstance(current, bool) or not isinstance(current, int) or current < 0:
        raise TaskSpecError("invalid verification time")
    digest = hashlib.sha256(_canonical_spec_bytes(envelope.spec)).hexdigest()
    if not hmac.compare_digest(digest, envelope.task_spec_sha256):
        raise TaskSpecError("task specification digest mismatch")
    expected = hmac.new(
        key, _signature_input(digest, envelope.signing_key_id), hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(expected, envelope.signature_sha256):
        raise TaskSpecError("task specification authentication failed")
    if current + _MAX_CLOCK_SKEW_SECONDS < envelope.spec.issued_at:
        raise TaskSpecError("task specification issuance is in the future")
    if current >= envelope.spec.expires_at:
        raise TaskSpecError("task specification expired")
    if expected_phase_attempt_id is not None:
        _digest(expected_phase_attempt_id, 64, "expected phase attempt id")
        if not hmac.compare_digest(
            expected_phase_attempt_id, envelope.spec.phase_attempt_id
        ):
            raise TaskSpecError("task specification phase attempt binding is stale")
    if expected_subject_sha is not None:
        _digest(expected_subject_sha, 40, "expected subject SHA")
        if not hmac.compare_digest(expected_subject_sha, envelope.spec.subject_sha):
            raise TaskSpecError("task specification subject binding is stale")
    instruction_context = (
        expected_instruction_sha256 is not None,
        expected_instruction_bytes is not None,
    )
    if instruction_context[0] != instruction_context[1]:
        raise TaskSpecError("expected instruction context is incomplete")
    if instruction_context[0]:
        instruction_sha256 = _digest(
            expected_instruction_sha256, 64, "expected instruction SHA-256",
        )
        instruction_bytes = _positive_integer(
            expected_instruction_bytes,
            "expected instruction byte length",
            _MAX_INSTRUCTION_BYTES,
        )
        if (not hmac.compare_digest(
                instruction_sha256, envelope.spec.instruction_sha256
            ) or instruction_bytes != envelope.spec.instruction_bytes):
            raise TaskSpecError("task specification instruction binding is stale")
    return envelope


def _envelope_payload(envelope: SignedTaskSpec) -> dict[str, object]:
    return {
        "kind": _DOMAIN,
        "signature_sha256": envelope.signature_sha256,
        "signing_key_id": envelope.signing_key_id,
        "spec": _spec_payload(envelope.spec),
        "task_spec_sha256": envelope.task_spec_sha256,
    }


def canonical_envelope_bytes(envelope: SignedTaskSpec) -> bytes:
    if not isinstance(envelope, SignedTaskSpec):
        raise TaskSpecError("SignedTaskSpec required")
    _canonical_spec_bytes(envelope.spec)
    encoded = _canonical(_envelope_payload(envelope))
    # Materialized records append exactly one newline; include it in the
    # transport limit so every accepted canonical envelope is readable later.
    if len(encoded) + 1 > _MAX_ENVELOPE_BYTES:
        raise TaskSpecError("signed task specification exceeds its size bound")
    return encoded


def _private_directory(path: Path, label: str) -> os.stat_result:
    if not path.is_absolute():
        raise TaskSpecError(f"{label} must be absolute")
    try:
        resolved = path.resolve(strict=True)
        info = os.lstat(path)
    except OSError as exc:
        raise TaskSpecError(f"{label} is unavailable") from exc
    if (resolved != path or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700):
        raise TaskSpecError(f"{label} must be an owned canonical mode-0700 directory")
    return info


def _open_private_directory(path: Path, label: str) -> tuple[int, os.stat_result]:
    before = _private_directory(path, label)
    flags = (
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise TaskSpecError(f"{label} cannot be opened safely") from exc
    opened = os.fstat(descriptor)
    if ((opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)
            or not stat.S_ISDIR(opened.st_mode) or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700):
        os.close(descriptor)
        raise TaskSpecError(f"{label} changed while opening")
    return descriptor, opened


def _recheck_directory_mapping(
    path: Path, descriptor: int, expected: os.stat_result, label: str,
) -> None:
    try:
        named = os.lstat(path)
        opened = os.fstat(descriptor)
    except OSError as exc:
        raise TaskSpecError(f"{label} mapping cannot be rechecked") from exc
    identity = (expected.st_dev, expected.st_ino)
    if ((named.st_dev, named.st_ino) != identity
            or (opened.st_dev, opened.st_ino) != identity
            or not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
            or named.st_uid != os.geteuid() or stat.S_IMODE(named.st_mode) != 0o700):
        raise TaskSpecError(f"{label} mapping changed")


def _open_private_child_directory(
    parent_fd: int, name: str, label: str,
) -> tuple[int, os.stat_result]:
    try:
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        descriptor = os.open(
            name,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
    except OSError as exc:
        raise TaskSpecError(f"{label} is unavailable") from exc
    try:
        opened = os.fstat(descriptor)
        if (not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
                or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino)
                or opened.st_uid != os.geteuid()
                or stat.S_IMODE(opened.st_mode) != 0o700):
            raise TaskSpecError(
                f"{label} must be an owned mode-0700 directory"
            )
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor, opened


def _recheck_private_child_directory(
    parent_fd: int, name: str, descriptor: int,
    expected: os.stat_result, label: str,
) -> None:
    try:
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        opened = os.fstat(descriptor)
    except OSError as exc:
        raise TaskSpecError(f"{label} mapping cannot be rechecked") from exc
    identity = (expected.st_dev, expected.st_ino)
    if ((named.st_dev, named.st_ino) != identity
            or (opened.st_dev, opened.st_ino) != identity
            or not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
            or opened.st_uid != os.geteuid()
            or stat.S_IMODE(opened.st_mode) != 0o700):
        raise TaskSpecError(f"{label} mapping changed")


def _private_file_identity(info: os.stat_result, expected_size: int) -> bool:
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_uid == os.geteuid()
        and stat.S_IMODE(info.st_mode) == 0o600
        and info.st_nlink == 1
        and info.st_size == expected_size
    )


def _named_file(parent_fd: int, name: str) -> os.stat_result:
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError as exc:
        raise TaskSpecError("task specification name cannot be verified") from exc


def materialize_task_spec(
    envelope: SignedTaskSpec, attempts_root: str | os.PathLike[str],
    controller_hmac_key: bytes, *,
    expected_task_spec_sha256: str,
    expected_phase_attempt_id: str,
    expected_subject_sha: str,
    expected_instruction_sha256: str,
    expected_instruction_bytes: int,
    clock: Callable[[], int] | None = None,
) -> str:
    """Create ``<attempts_root>/<signed-attempt>/task-spec.json`` once."""
    expected_digest = _digest(
        expected_task_spec_sha256, 64, "expected task specification digest",
    )
    verified = verify_task_spec(
        envelope, controller_hmac_key, now=_clock_sample(clock),
        expected_phase_attempt_id=expected_phase_attempt_id,
        expected_subject_sha=expected_subject_sha,
        expected_instruction_sha256=expected_instruction_sha256,
        expected_instruction_bytes=expected_instruction_bytes,
    )
    if not hmac.compare_digest(verified.task_spec_sha256, expected_digest):
        raise TaskSpecError("task specification expected digest is stale")
    # Bound and render before opening either configured directory.  A malformed
    # or oversized envelope must never consume the single-use destination.
    encoded = canonical_envelope_bytes(verified) + b"\n"
    root = Path(attempts_root)
    root_fd, root_info = _open_private_directory(root, "attempts root")
    attempt_fd = -1
    fd = -1
    created_identity: tuple[int, int] | None = None
    try:
        attempt_fd, attempt_info = _open_private_child_directory(
            root_fd, verified.spec.phase_attempt_id, "attempt directory",
        )
        flags = (
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            fd = os.open(_TASK_SPEC_NAME, flags, 0o600, dir_fd=attempt_fd)
        except FileExistsError as exc:
            raise TaskSpecError("task specification destination already exists") from exc
        except OSError as exc:
            raise TaskSpecError("task specification destination cannot be created safely") from exc
        opened = os.fstat(fd)
        created_identity = (opened.st_dev, opened.st_ino)
        offset = 0
        while offset < len(encoded):
            written = os.write(fd, encoded[offset:])
            if written <= 0:
                raise TaskSpecError("task specification write did not progress")
            offset += written
        os.fchmod(fd, 0o600)
        os.fsync(fd)
        opened = os.fstat(fd)
        named = _named_file(attempt_fd, _TASK_SPEC_NAME)
        if (not _private_file_identity(opened, len(encoded))
                or not _private_file_identity(named, len(encoded))
                or (opened.st_dev, opened.st_ino) != created_identity
                or (named.st_dev, named.st_ino) != created_identity):
            raise TaskSpecError("task specification name/inode changed")
        os.fsync(attempt_fd)
        # Keep the file descriptor open through both sync operations and
        # recheck the name afterwards; a durable replacement is not ours.
        opened_after = os.fstat(fd)
        named_after = _named_file(attempt_fd, _TASK_SPEC_NAME)
        if (not _private_file_identity(opened_after, len(encoded))
                or not _private_file_identity(named_after, len(encoded))
                or (opened_after.st_dev, opened_after.st_ino) != created_identity
                or (named_after.st_dev, named_after.st_ino) != created_identity):
            raise TaskSpecError("task specification final name/inode changed")
        _recheck_private_child_directory(
            root_fd, verified.spec.phase_attempt_id, attempt_fd, attempt_info,
            "attempt directory",
        )
        _recheck_directory_mapping(root, root_fd, root_info, "attempts root")

        # Currentness and every durable context binding are sampled again only
        # after both durability barriers and the first complete identity pass.
        final_verified = verify_task_spec(
            envelope, controller_hmac_key, now=_clock_sample(clock),
            expected_phase_attempt_id=expected_phase_attempt_id,
            expected_subject_sha=expected_subject_sha,
            expected_instruction_sha256=expected_instruction_sha256,
            expected_instruction_bytes=expected_instruction_bytes,
        )
        if (not hmac.compare_digest(final_verified.task_spec_sha256, expected_digest)
                or not hmac.compare_digest(
                    final_verified.task_spec_sha256, verified.task_spec_sha256,
                )):
            raise TaskSpecError("task specification identity changed before admission")

        # The clock is an injectable controller boundary and can run arbitrary
        # test code.  Recheck every canonical name/inode after it; nothing below
        # this block reads caller-controlled storage.
        opened_final = os.fstat(fd)
        named_final = _named_file(attempt_fd, _TASK_SPEC_NAME)
        if (not _private_file_identity(opened_final, len(encoded))
                or not _private_file_identity(named_final, len(encoded))
                or (opened_final.st_dev, opened_final.st_ino) != created_identity
                or (named_final.st_dev, named_final.st_ino) != created_identity):
            raise TaskSpecError("task specification final name/inode changed")
        _recheck_private_child_directory(
            root_fd, verified.spec.phase_attempt_id, attempt_fd, attempt_info,
            "attempt directory",
        )
        _recheck_directory_mapping(root, root_fd, root_info, "attempts root")
    finally:
        if fd >= 0:
            os.close(fd)
        if attempt_fd >= 0:
            os.close(attempt_fd)
        os.close(root_fd)
    return verified.task_spec_sha256


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise TaskSpecError("task specification contains a duplicate JSON key")
        result[key] = value
    return result


def _exact_mapping(value: object, names: set[str], label: str) -> Mapping[str, object]:
    if not isinstance(value, dict) or set(value) != names:
        raise TaskSpecError(f"{label} fields are not recognized")
    return value


def _decode_envelope(raw: bytes) -> SignedTaskSpec:
    if not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise TaskSpecError("task specification file is not one canonical record")
    encoded = raw[:-1]
    try:
        value = json.loads(
            encoded.decode("ascii"), object_pairs_hook=_unique_object,
            parse_constant=lambda token: (_ for _ in ()).throw(
                TaskSpecError(f"non-finite JSON value {token} is forbidden")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise TaskSpecError("task specification JSON is malformed") from exc
    envelope = _exact_mapping(value, {
        "kind", "signature_sha256", "signing_key_id", "spec", "task_spec_sha256",
    }, "task specification envelope")
    if envelope["kind"] != _DOMAIN:
        raise TaskSpecError("task specification kind is not supported")
    body = _exact_mapping(envelope["spec"], {
        "adapter", "allowed_prefixes", "base_sha", "budgets", "campaign_id",
        "controller_epoch", "expected_branch", "expires_at", "forbidden_prefixes",
        "instruction_bytes", "instruction_sha256", "issued_at", "issue_url",
        "network_profile", "phase_attempt_id", "principal_id", "receipt_schema",
        "repository", "role", "schema_version", "subject_sha", "task_attempt",
        "task_id", "verification_policy",
    }, "task specification")
    if body["schema_version"] != _SCHEMA_VERSION:
        raise TaskSpecError("task specification schema version is not supported")
    budget_values = _exact_mapping(body["budgets"], {
        "cpu_seconds", "memory_bytes", "output_bytes", "process_limit", "wall_seconds",
    }, "resource budget")
    budgets = ResourceBudgets(
        wall_seconds=budget_values["wall_seconds"],  # type: ignore[arg-type]
        cpu_seconds=budget_values["cpu_seconds"],  # type: ignore[arg-type]
        memory_bytes=budget_values["memory_bytes"],  # type: ignore[arg-type]
        process_limit=budget_values["process_limit"],  # type: ignore[arg-type]
        output_bytes=budget_values["output_bytes"],  # type: ignore[arg-type]
    )
    spec = TaskSpec(
        campaign_id=body["campaign_id"],  # type: ignore[arg-type]
        task_id=body["task_id"],  # type: ignore[arg-type]
        task_attempt=body["task_attempt"],  # type: ignore[arg-type]
        phase_attempt_id=body["phase_attempt_id"],  # type: ignore[arg-type]
        controller_epoch=body["controller_epoch"],  # type: ignore[arg-type]
        repository=body["repository"],  # type: ignore[arg-type]
        base_sha=body["base_sha"],  # type: ignore[arg-type]
        subject_sha=body["subject_sha"],  # type: ignore[arg-type]
        expected_branch=body["expected_branch"],  # type: ignore[arg-type]
        issue_url=body["issue_url"],  # type: ignore[arg-type]
        instruction_sha256=body["instruction_sha256"],  # type: ignore[arg-type]
        instruction_bytes=body["instruction_bytes"],  # type: ignore[arg-type]
        allowed_prefixes=body["allowed_prefixes"],  # type: ignore[arg-type]
        forbidden_prefixes=body["forbidden_prefixes"],  # type: ignore[arg-type]
        adapter=body["adapter"],  # type: ignore[arg-type]
        principal_id=body["principal_id"],  # type: ignore[arg-type]
        role=body["role"],  # type: ignore[arg-type]
        verification_policy=body["verification_policy"],  # type: ignore[arg-type]
        budgets=budgets,
        network_profile=body["network_profile"],  # type: ignore[arg-type]
        issued_at=body["issued_at"],  # type: ignore[arg-type]
        expires_at=body["expires_at"],  # type: ignore[arg-type]
        receipt_schema=body["receipt_schema"],  # type: ignore[arg-type]
    )
    result = SignedTaskSpec(
        spec=spec,
        task_spec_sha256=envelope["task_spec_sha256"],  # type: ignore[arg-type]
        signing_key_id=envelope["signing_key_id"],  # type: ignore[arg-type]
        signature_sha256=envelope["signature_sha256"],  # type: ignore[arg-type]
    )
    if encoded != canonical_envelope_bytes(result):
        raise TaskSpecError("task specification file is not canonical")
    return result


def read_task_spec(
    attempts_root: str | os.PathLike[str], controller_hmac_key: bytes, *,
    expected_task_spec_sha256: str,
    expected_phase_attempt_id: str,
    expected_subject_sha: str,
    expected_instruction_sha256: str,
    expected_instruction_bytes: int,
    now: int | None = None,
) -> SignedTaskSpec:
    """Read the fixed file under the exact durable/signed attempt directory."""
    _digest(expected_task_spec_sha256, 64, "expected task specification digest")
    _digest(expected_phase_attempt_id, 64, "expected phase attempt id")
    _digest(expected_subject_sha, 40, "expected subject SHA")
    _digest(expected_instruction_sha256, 64, "expected instruction SHA-256")
    _positive_integer(
        expected_instruction_bytes,
        "expected instruction byte length",
        _MAX_INSTRUCTION_BYTES,
    )
    root = Path(attempts_root)
    root_fd, root_info = _open_private_directory(root, "attempts root")
    attempt_fd = -1
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = -1
    try:
        attempt_fd, attempt_info = _open_private_child_directory(
            root_fd, expected_phase_attempt_id, "attempt directory",
        )
        before = _named_file(attempt_fd, _TASK_SPEC_NAME)
        try:
            fd = os.open(_TASK_SPEC_NAME, flags, dir_fd=attempt_fd)
        except OSError as exc:
            raise TaskSpecError("task specification cannot be opened safely") from exc
        opened = os.fstat(fd)
        if (not 1 <= opened.st_size <= _MAX_ENVELOPE_BYTES
                or not _private_file_identity(opened, opened.st_size)
                or not _private_file_identity(before, opened.st_size)
                or (opened.st_dev, opened.st_ino) != (before.st_dev, before.st_ino)):
            raise TaskSpecError(
                "task specification must be a single-link owned mode-0600 regular file"
            )
        if not 1 <= opened.st_size <= _MAX_ENVELOPE_BYTES:
            raise TaskSpecError("task specification file exceeds its bound")
        chunks = []
        remaining = opened.st_size
        while remaining:
            block = os.read(fd, min(65536, remaining))
            if not block:
                raise TaskSpecError("task specification file changed while reading")
            chunks.append(block)
            remaining -= len(block)
        if os.read(fd, 1):
            raise TaskSpecError("task specification file changed while reading")
        raw = b"".join(chunks)
        envelope = verify_task_spec(
            _decode_envelope(raw), controller_hmac_key, now=now,
            expected_phase_attempt_id=expected_phase_attempt_id,
            expected_subject_sha=expected_subject_sha,
            expected_instruction_sha256=expected_instruction_sha256,
            expected_instruction_bytes=expected_instruction_bytes,
        )
        if not hmac.compare_digest(
            envelope.task_spec_sha256, expected_task_spec_sha256
        ):
            raise TaskSpecError("task specification expected digest is stale")
        opened_after = os.fstat(fd)
        named_after = _named_file(attempt_fd, _TASK_SPEC_NAME)
        stable_fields = (
            "st_dev", "st_ino", "st_uid", "st_mode", "st_nlink", "st_size",
            "st_mtime_ns", "st_ctime_ns",
        )
        if (any(getattr(opened_after, name) != getattr(opened, name)
                for name in stable_fields)
                or any(getattr(named_after, name) != getattr(opened, name)
                       for name in stable_fields)
                or not _private_file_identity(opened_after, len(raw))
                or not _private_file_identity(named_after, len(raw))):
            raise TaskSpecError("task specification name/inode changed during read")
        _recheck_private_child_directory(
            root_fd, expected_phase_attempt_id, attempt_fd, attempt_info,
            "attempt directory",
        )
        _recheck_directory_mapping(root, root_fd, root_info, "attempts root")
        return envelope
    finally:
        if fd >= 0:
            os.close(fd)
        if attempt_fd >= 0:
            os.close(attempt_fd)
        os.close(root_fd)


# Explicit verb aliases make the storage contract easy to discover without
# adding a second implementation.
write_task_spec = materialize_task_spec
