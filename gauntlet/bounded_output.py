"""Authenticated private byte capture for a future supervised runner.

This module never starts or signals a process directly. On capture failure it
can request runner-owned whole-cgroup termination through a callback; stopping
the cgroup and proving it exited remain runner responsibilities. Raw bytes are
written only to fresh private files. The sanitized receipt is returned in
memory and is deliberately not persisted here. This reference primitive
remains unwired from the controller and runner. Trusted issuance from a
validated TaskSpec and durable one-use grant consumption remain integration
gates outside this module.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field, replace
import errno
import hashlib
import hmac
import json
import math
import os
import re
import selectors
import stat
import time
from typing import Callable, Mapping, Protocol, cast


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_GRANT_SCHEMA = "kizuki-gauntlet-output-capture-grant-v1"
_GRANT_DOMAIN = b"kizuki-gauntlet/output-capture-grant/v1\0"
_GRANT_DIGEST_DOMAIN = b"kizuki-gauntlet/output-capture-grant-digest/v1\0"
_LAYOUT_DIGEST_DOMAIN = b"kizuki-gauntlet/output-layout-digest/v1\0"
_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
_MAX_TIMEOUT_MS = 60 * 60 * 1000
_READ_SIZE = 64 * 1024
_MAX_SELECT_SECONDS = 0.05


class OutputCaptureError(RuntimeError):
    """Sanitized typed failure; raw bytes and private paths are never retained."""

    def __init__(self, reason_code: str, receipt: "OutputCaptureReceipt | None" = None):
        self.reason_code = reason_code
        self.receipt = receipt
        super().__init__(f"bounded output capture failed: {reason_code}")

    def __repr__(self) -> str:
        return f"OutputCaptureError(reason_code={self.reason_code!r})"


class _CaptureFailure(Exception):
    def __init__(self, reason_code: str, bytes_written: int = 0):
        self.reason_code = reason_code
        self.bytes_written = bytes_written


class _Digest(Protocol):
    def update(self, data: bytes) -> None: ...

    def hexdigest(self) -> str: ...


def _canonical(value: object) -> bytes:
    try:
        encoded = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError):
        raise _CaptureFailure("OUTPUT_GRANT_INVALID") from None
    return encoded.encode("ascii")


def _is_id(value: object) -> bool:
    return type(value) is str and _ID.fullmatch(value) is not None


def _is_digest(value: object) -> bool:
    return type(value) is str and _HEX64.fullmatch(value) is not None


def _is_canonical_absolute_path(path: object) -> bool:
    if type(path) is not str or not path.startswith("/") or len(path) > 4096:
        return False
    if path == "/" or "\0" in path:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/")[1:])


def _validated_key(key: object) -> bytes:
    if type(key) is not bytes or len(key) < 32:
        raise _CaptureFailure("OUTPUT_GRANT_KEY_INVALID")
    return key


@dataclass(frozen=True, slots=True)
class BoundedOutputSpec:
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    task_spec_sha256: str
    attempt_root: str
    worktree: str
    raw_directory: str
    stdout_max_bytes: int
    stderr_max_bytes: int
    combined_max_bytes: int
    wall_timeout_ms: int
    idle_timeout_ms: int

    def __post_init__(self) -> None:
        if not _is_id(self.campaign_id) or not _is_id(self.task_id):
            raise OutputCaptureError("INVALID_CAPTURE_IDENTITY")
        if any(
            type(value) is not int or not 1 <= value <= (2**63 - 1)
            for value in (self.attempt, self.controller_epoch)
        ):
            raise OutputCaptureError("INVALID_CAPTURE_FENCE")
        if not _is_digest(self.task_spec_sha256):
            raise OutputCaptureError("INVALID_TASK_SPEC_DIGEST")
        paths = (self.attempt_root, self.worktree, self.raw_directory)
        if not all(_is_canonical_absolute_path(path) for path in paths):
            raise OutputCaptureError("INVALID_OUTPUT_PATH")
        if self.worktree != self.attempt_root + "/work":
            raise OutputCaptureError("INVALID_OUTPUT_LAYOUT")
        if self.raw_directory != self.attempt_root + "/raw":
            raise OutputCaptureError("INVALID_OUTPUT_LAYOUT")
        byte_budgets = (
            self.stdout_max_bytes,
            self.stderr_max_bytes,
            self.combined_max_bytes,
        )
        if any(
            type(value) is not int or not 1 <= value <= _MAX_OUTPUT_BYTES
            for value in byte_budgets
        ):
            raise OutputCaptureError("INVALID_OUTPUT_BYTE_BUDGET")
        if any(
            type(value) is not int or not 1 <= value <= _MAX_TIMEOUT_MS
            for value in (self.wall_timeout_ms, self.idle_timeout_ms)
        ):
            raise OutputCaptureError("INVALID_OUTPUT_TIME_BUDGET")


@dataclass(frozen=True, slots=True)
class DirectoryIdentity:
    path: str
    device: int
    inode: int
    owner_uid: int
    mode: int

    def __post_init__(self) -> None:
        if not _is_canonical_absolute_path(self.path):
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        if any(
            type(value) is not int or value < lower
            for value, lower in (
                (self.device, 0),
                (self.inode, 1),
                (self.owner_uid, 0),
            )
        ):
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        if type(self.mode) is not int or self.mode != 0o700:
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")


@dataclass(frozen=True, slots=True)
class OutputCaptureGrant:
    schema: str
    grant_id: str
    issuer_key_id: str
    spec: BoundedOutputSpec
    attempt_root_identity: DirectoryIdentity
    worktree_identity: DirectoryIdentity
    raw_directory_identity: DirectoryIdentity
    grant_hmac_sha256: str

    def __post_init__(self) -> None:
        if type(self.schema) is not str or self.schema != _GRANT_SCHEMA:
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        if not _is_id(self.grant_id) or not _is_id(self.issuer_key_id):
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        if type(self.spec) is not BoundedOutputSpec:
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        identities = (
            self.attempt_root_identity,
            self.worktree_identity,
            self.raw_directory_identity,
        )
        if any(type(identity) is not DirectoryIdentity for identity in identities):
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        if tuple(identity.path for identity in identities) != (
            self.spec.attempt_root,
            self.spec.worktree,
            self.spec.raw_directory,
        ):
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")
        inode_keys = {(identity.device, identity.inode) for identity in identities}
        if len(inode_keys) != 3 or not _is_digest(self.grant_hmac_sha256):
            raise OutputCaptureError("OUTPUT_GRANT_INVALID")

    def unsigned_mapping(self) -> dict[str, object]:
        value = asdict(self)
        value.pop("grant_hmac_sha256")
        return value

    def verify(
        self,
        expected_spec: BoundedOutputSpec,
        verification_keys: Mapping[str, bytes],
    ) -> None:
        if type(expected_spec) is not BoundedOutputSpec:
            raise _CaptureFailure("BOUNDED_OUTPUT_SPEC_REQUIRED")
        if not isinstance(verification_keys, Mapping):
            raise _CaptureFailure("OUTPUT_GRANT_KEY_INVALID")
        try:
            trusted_keys = dict(verification_keys)
        except Exception:
            raise _CaptureFailure("OUTPUT_GRANT_KEY_INVALID") from None
        if set(trusted_keys) != {self.issuer_key_id}:
            raise _CaptureFailure("OUTPUT_GRANT_KEY_INVALID")
        try:
            key = _validated_key(trusted_keys[self.issuer_key_id])
        except (KeyError, TypeError):
            raise _CaptureFailure("OUTPUT_GRANT_KEY_INVALID") from None
        expected_hmac = hmac.new(
            key,
            _GRANT_DOMAIN + _canonical(self.unsigned_mapping()),
            hashlib.sha256,
        ).hexdigest()
        if not hmac.compare_digest(self.grant_hmac_sha256, expected_hmac):
            raise _CaptureFailure("OUTPUT_GRANT_AUTHENTICATION_FAILED")
        if self.spec != expected_spec:
            raise _CaptureFailure("OUTPUT_GRANT_MISMATCH")

    @property
    def sha256(self) -> str:
        return hashlib.sha256(
            _GRANT_DIGEST_DOMAIN + _canonical(asdict(self))
        ).hexdigest()

    @property
    def layout_sha256(self) -> str:
        layout = {
            "attempt_root": asdict(self.attempt_root_identity),
            "worktree": asdict(self.worktree_identity),
            "raw_directory": asdict(self.raw_directory_identity),
        }
        return hashlib.sha256(_LAYOUT_DIGEST_DOMAIN + _canonical(layout)).hexdigest()


@dataclass(frozen=True, slots=True)
class OutputCaptureReceipt:
    schema: str
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    task_spec_sha256: str
    grant_id: str
    grant_sha256: str
    layout_sha256: str
    outcome: str
    reason_code: str
    stdout_bytes: int
    stderr_bytes: int
    combined_bytes: int
    stdout_sha256: str
    stderr_sha256: str


def _close_safely(descriptor: int) -> None:
    try:
        os.close(descriptor)
    except OSError:
        pass


def _private_directory_info(descriptor: int) -> os.stat_result:
    try:
        info = os.fstat(descriptor)
    except OSError:
        raise _CaptureFailure("OUTPUT_DIRECTORY_UNAVAILABLE") from None
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        raise _CaptureFailure("OUTPUT_PATH_UNSAFE")
    return info


def _open_private_directory(path: str) -> tuple[int, os.stat_result]:
    """Open every absolute path component with O_NOFOLLOW and pin the leaf."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open("/", flags)
        for component in path.split("/")[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            _close_safely(descriptor)
            descriptor = child
        info = _private_directory_info(descriptor)
    except _CaptureFailure:
        if descriptor >= 0:
            _close_safely(descriptor)
        raise
    except OSError as exc:
        if descriptor >= 0:
            _close_safely(descriptor)
        reason = (
            "OUTPUT_PATH_UNSAFE"
            if exc.errno in (errno.ELOOP, errno.ENOTDIR)
            else "OUTPUT_DIRECTORY_UNAVAILABLE"
        )
        raise _CaptureFailure(reason) from None
    return descriptor, info


def _open_private_child(
    parent_fd: int,
    name: str,
) -> tuple[int, os.stat_result]:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(name, flags, dir_fd=parent_fd)
        info = _private_directory_info(descriptor)
    except _CaptureFailure:
        if descriptor >= 0:
            _close_safely(descriptor)
        raise
    except OSError as exc:
        if descriptor >= 0:
            _close_safely(descriptor)
        reason = (
            "OUTPUT_PATH_UNSAFE"
            if exc.errno in (errno.ELOOP, errno.ENOTDIR)
            else "OUTPUT_DIRECTORY_UNAVAILABLE"
        )
        raise _CaptureFailure(reason) from None
    return descriptor, info


def _identity(path: str, info: os.stat_result) -> DirectoryIdentity:
    return DirectoryIdentity(
        path=path,
        device=info.st_dev,
        inode=info.st_ino,
        owner_uid=info.st_uid,
        mode=stat.S_IMODE(info.st_mode),
    )


@dataclass
class _OpenedLayout:
    attempt_root_fd: int
    worktree_fd: int
    raw_directory_fd: int
    attempt_root_info: os.stat_result
    worktree_info: os.stat_result
    raw_directory_info: os.stat_result

    def close(self) -> None:
        for descriptor in (
            self.raw_directory_fd,
            self.worktree_fd,
            self.attempt_root_fd,
        ):
            _close_safely(descriptor)


def _open_attempt_layout(spec: BoundedOutputSpec) -> _OpenedLayout:
    attempt_fd = worktree_fd = raw_fd = -1
    try:
        attempt_fd, attempt_info = _open_private_directory(spec.attempt_root)
        worktree_fd, worktree_info = _open_private_child(attempt_fd, "work")
        raw_fd, raw_info = _open_private_child(attempt_fd, "raw")
        inode_keys = {
            (attempt_info.st_dev, attempt_info.st_ino),
            (worktree_info.st_dev, worktree_info.st_ino),
            (raw_info.st_dev, raw_info.st_ino),
        }
        if len(inode_keys) != 3:
            raise _CaptureFailure("OUTPUT_PATH_UNSAFE")
        return _OpenedLayout(
            attempt_fd,
            worktree_fd,
            raw_fd,
            attempt_info,
            worktree_info,
            raw_info,
        )
    except Exception:
        for descriptor in (raw_fd, worktree_fd, attempt_fd):
            if descriptor >= 0:
                _close_safely(descriptor)
        raise


def _layout_identities(
    spec: BoundedOutputSpec,
    layout: _OpenedLayout,
) -> tuple[DirectoryIdentity, DirectoryIdentity, DirectoryIdentity]:
    return (
        _identity(spec.attempt_root, layout.attempt_root_info),
        _identity(spec.worktree, layout.worktree_info),
        _identity(spec.raw_directory, layout.raw_directory_info),
    )


def mint_output_capture_grant(
    spec: BoundedOutputSpec,
    *,
    issuer_key_id: str,
    grant_id: str,
    signing_key: bytes,
) -> OutputCaptureGrant:
    """Authenticate a validated snapshot; trusted-store issuance is external.

    This helper neither proves TaskSpec authorization nor consumes ``grant_id``.
    Integration must mint only from a validated TaskSpec and durably enforce
    one-use issuance/consumption in the protocol store.
    """
    if type(spec) is not BoundedOutputSpec:
        raise OutputCaptureError("BOUNDED_OUTPUT_SPEC_REQUIRED")
    if not _is_id(issuer_key_id) or not _is_id(grant_id):
        raise OutputCaptureError("OUTPUT_GRANT_INVALID")
    try:
        key = _validated_key(signing_key)
        layout = _open_attempt_layout(spec)
        try:
            attempt_identity, worktree_identity, raw_identity = _layout_identities(
                spec, layout
            )
        finally:
            layout.close()
        provisional = OutputCaptureGrant(
            schema=_GRANT_SCHEMA,
            grant_id=grant_id,
            issuer_key_id=issuer_key_id,
            spec=spec,
            attempt_root_identity=attempt_identity,
            worktree_identity=worktree_identity,
            raw_directory_identity=raw_identity,
            grant_hmac_sha256="0" * 64,
        )
        authentication = hmac.new(
            key,
            _GRANT_DOMAIN + _canonical(provisional.unsigned_mapping()),
            hashlib.sha256,
        ).hexdigest()
        return replace(provisional, grant_hmac_sha256=authentication)
    except _CaptureFailure as exc:
        raise OutputCaptureError(exc.reason_code) from None


def _stable_directory_matches(info: os.stat_result, expected: DirectoryIdentity) -> bool:
    return (
        stat.S_ISDIR(info.st_mode)
        and info.st_uid == expected.owner_uid == os.geteuid()
        and stat.S_IMODE(info.st_mode) == expected.mode == 0o700
        and (info.st_dev, info.st_ino) == (expected.device, expected.inode)
    )


def _path_is_current(path: str, expected: DirectoryIdentity) -> bool:
    descriptor = -1
    try:
        descriptor, info = _open_private_directory(path)
        return _stable_directory_matches(info, expected)
    except _CaptureFailure:
        return False
    finally:
        if descriptor >= 0:
            _close_safely(descriptor)


def _entry_is_current(
    parent_fd: int,
    name: str,
    child_fd: int,
    expected: DirectoryIdentity,
) -> bool:
    try:
        by_descriptor = os.fstat(child_fd)
        by_name = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except OSError:
        return False
    return (
        _stable_directory_matches(by_descriptor, expected)
        and _stable_directory_matches(by_name, expected)
    )


def _layout_matches_grant(layout: _OpenedLayout, grant: OutputCaptureGrant) -> bool:
    return all(
        _stable_directory_matches(info, expected)
        for info, expected in (
            (layout.attempt_root_info, grant.attempt_root_identity),
            (layout.worktree_info, grant.worktree_identity),
            (layout.raw_directory_info, grant.raw_directory_identity),
        )
    )


def _layout_is_current(layout: _OpenedLayout, grant: OutputCaptureGrant) -> bool:
    return (
        _entry_is_current(
            layout.attempt_root_fd,
            "work",
            layout.worktree_fd,
            grant.worktree_identity,
        )
        and _entry_is_current(
            layout.attempt_root_fd,
            "raw",
            layout.raw_directory_fd,
            grant.raw_directory_identity,
        )
        and _path_is_current(grant.spec.attempt_root, grant.attempt_root_identity)
        and _path_is_current(grant.spec.worktree, grant.worktree_identity)
        and _path_is_current(grant.spec.raw_directory, grant.raw_directory_identity)
    )


def _create_private_file(
    directory_fd: int,
    name: str,
) -> tuple[int, os.stat_result]:
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC | os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(name, flags, 0o600, dir_fd=directory_fd)
        os.fchmod(descriptor, 0o600)
        info = os.fstat(descriptor)
    except OSError as exc:
        if descriptor >= 0:
            _close_safely(descriptor)
        reason = (
            "OUTPUT_PATH_UNSAFE"
            if exc.errno in (errno.EEXIST, errno.ELOOP, errno.EISDIR, errno.ENOTDIR)
            else "OUTPUT_STORAGE_ERROR"
        )
        raise _CaptureFailure(reason) from None
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_nlink != 1
    ):
        _close_safely(descriptor)
        raise _CaptureFailure("OUTPUT_PATH_UNSAFE")
    return descriptor, info


def _file_is_current(
    directory_fd: int,
    name: str,
    descriptor: int,
    expected: os.stat_result,
    expected_size: int,
) -> bool:
    try:
        by_descriptor = os.fstat(descriptor)
        by_name = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except OSError:
        return False
    return (
        stat.S_ISREG(by_descriptor.st_mode)
        and by_descriptor.st_uid == os.geteuid()
        and stat.S_IMODE(by_descriptor.st_mode) == 0o600
        and by_descriptor.st_nlink == 1
        and by_descriptor.st_size == expected_size
        and (by_descriptor.st_dev, by_descriptor.st_ino)
        == (expected.st_dev, expected.st_ino)
        == (by_name.st_dev, by_name.st_ino)
    )


def _stream_fd(stream: object) -> int:
    try:
        value = stream if type(stream) is int else stream.fileno()  # type: ignore[attr-defined]
    except Exception:
        raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None
    if type(value) is not int or value < 0:
        raise _CaptureFailure("OUTPUT_STREAM_INVALID")
    return value


def _clock_sample(clock: Callable[[], object], previous: float | None = None) -> float:
    try:
        value = clock()
    except Exception:
        raise _CaptureFailure("CLOCK_ERROR") from None
    if type(value) not in (int, float):
        raise _CaptureFailure("CLOCK_ERROR")
    try:
        result = float(cast(int | float, value))
    except Exception:
        raise _CaptureFailure("CLOCK_ERROR") from None
    if not math.isfinite(result) or (previous is not None and result < previous):
        raise _CaptureFailure("CLOCK_ERROR")
    return result


@dataclass
class _CaptureControl:
    request_whole_cgroup_termination: Callable[[str], object] | None
    cancelled: Callable[[], object] | None
    failure_reason: str | None = None
    termination_requested: bool = False

    def check_cancelled(self) -> None:
        if self.cancelled is None:
            return
        try:
            result = self.cancelled()
        except Exception:
            raise _CaptureFailure("CANCELLATION_CHECK_ERROR") from None
        if type(result) is not bool:
            raise _CaptureFailure("CANCELLATION_CHECK_ERROR")
        if result:
            raise _CaptureFailure("CANCELLED")

    def fail(self, reason_code: str) -> None:
        if self.failure_reason is not None:
            return
        self.failure_reason = reason_code
        if self.termination_requested:
            return
        self.termination_requested = True
        if self.request_whole_cgroup_termination is None:
            return
        try:
            self.request_whole_cgroup_termination(reason_code)
        except Exception:
            # Runner diagnostics may contain private data.
            pass


@dataclass
class _StreamState:
    name: str
    max_bytes: int
    source_fd: int = -1
    read_fd: int = -1
    original_blocking: bool | None = None
    output_fd: int = -1
    output_identity: os.stat_result | None = None
    count: int = 0
    digest: _Digest = field(default_factory=hashlib.sha256)

    @property
    def filename(self) -> str:
        return self.name + ".bin"


def _prepare_streams(states: tuple[_StreamState, _StreamState]) -> None:
    source_identities: list[tuple[int, int]] = []
    for state in states:
        try:
            state.read_fd = os.dup(state.source_fd)
            info = os.fstat(state.read_fd)
            if not (stat.S_ISFIFO(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
                raise _CaptureFailure("OUTPUT_STREAM_INVALID")
            state.original_blocking = os.get_blocking(state.read_fd)
            source_identities.append((info.st_dev, info.st_ino))
        except _CaptureFailure:
            raise
        except Exception:
            raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None
    if source_identities[0] == source_identities[1]:
        raise _CaptureFailure("OUTPUT_STREAM_INVALID")
    for state in states:
        try:
            os.set_blocking(state.read_fd, False)
        except Exception:
            raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None


def _release_stream(state: _StreamState) -> None:
    if state.read_fd < 0:
        return
    descriptor = state.read_fd
    original_blocking = state.original_blocking
    state.read_fd = -1
    state.original_blocking = None
    restore_failed = False
    if original_blocking is not None:
        try:
            os.set_blocking(descriptor, original_blocking)
        except Exception:
            restore_failed = True
    _close_safely(descriptor)
    if restore_failed:
        raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None


def _write_all(
    descriptor: int,
    data: bytes,
    write_fn: Callable[[int, bytes], object],
    checkpoint: Callable[[], float],
) -> float:
    offset = 0
    checked_at = 0.0
    while offset < len(data):
        try:
            written = write_fn(descriptor, data[offset:])
        except Exception:
            raise _CaptureFailure("OUTPUT_STORAGE_ERROR", offset) from None
        if type(written) is not int or not 1 <= written <= len(data) - offset:
            raise _CaptureFailure("OUTPUT_STORAGE_ERROR", offset)
        offset += written
        try:
            checked_at = checkpoint()
        except _CaptureFailure as exc:
            raise _CaptureFailure(exc.reason_code, offset) from None
        except Exception:
            raise _CaptureFailure("OUTPUT_CAPTURE_INTERNAL_ERROR", offset) from None
    return checked_at


def _make_receipt(
    spec: BoundedOutputSpec,
    grant: OutputCaptureGrant,
    states: tuple[_StreamState, _StreamState],
    failure_reason: str | None,
) -> OutputCaptureReceipt:
    stdout, stderr = states
    return OutputCaptureReceipt(
        schema="kizuki-gauntlet-output-capture-v2",
        campaign_id=spec.campaign_id,
        task_id=spec.task_id,
        attempt=spec.attempt,
        controller_epoch=spec.controller_epoch,
        task_spec_sha256=spec.task_spec_sha256,
        grant_id=grant.grant_id,
        grant_sha256=grant.sha256,
        layout_sha256=grant.layout_sha256,
        outcome="FAILED" if failure_reason is not None else "CAPTURED",
        reason_code="OK" if failure_reason is None else failure_reason,
        stdout_bytes=stdout.count,
        stderr_bytes=stderr.count,
        combined_bytes=stdout.count + stderr.count,
        stdout_sha256=stdout.digest.hexdigest(),
        stderr_sha256=stderr.digest.hexdigest(),
    )


def capture_bounded_output(
    spec: BoundedOutputSpec,
    stdout: object,
    stderr: object,
    *,
    grant: OutputCaptureGrant | None = None,
    verification_keys: Mapping[str, bytes] | None = None,
    request_termination: Callable[[str], object] | None = None,
    cancelled: Callable[[], object] | None = None,
    clock: Callable[[], object] | None = None,
    write_fn: Callable[[int, bytes], object] | None = None,
) -> OutputCaptureReceipt:
    """Drain authenticated attempt output into fresh, pinned private files.

    The caller retains its source descriptors. ``request_termination`` must be
    a nonblocking runner callback that stops and verifies the attempt's whole
    cgroup. ``verification_keys`` must be a controller-owned trust anchor, not
    data derived from the grant or task. Python cannot preempt a kernel-blocked
    write or ``fsync``; the future systemd unit deadline is therefore the
    ultimate stuck-I/O bound.
    """
    for value, reason in (
        (request_termination, "INVALID_TERMINATION_CALLBACK"),
        (cancelled, "INVALID_CANCELLATION_CALLBACK"),
        (clock, "INVALID_CLOCK_CALLBACK"),
        (write_fn, "INVALID_WRITE_CALLBACK"),
    ):
        if value is not None and not callable(value):
            raise OutputCaptureError(reason)
    control = _CaptureControl(request_termination, cancelled)
    monotonic = time.monotonic if clock is None else clock
    writer = os.write if write_fn is None else write_fn

    try:
        started_at = _clock_sample(monotonic)
        if type(spec) is not BoundedOutputSpec:
            raise _CaptureFailure("BOUNDED_OUTPUT_SPEC_REQUIRED")
        if type(grant) is not OutputCaptureGrant or verification_keys is None:
            raise _CaptureFailure("OUTPUT_GRANT_REQUIRED")
        grant.verify(spec, verification_keys)
        layout = _open_attempt_layout(spec)
        if not _layout_matches_grant(layout, grant):
            layout.close()
            raise _CaptureFailure("OUTPUT_LAYOUT_MISMATCH")
    except _CaptureFailure as exc:
        control.fail(exc.reason_code)
        raise OutputCaptureError(exc.reason_code) from None
    except Exception:
        control.fail("OUTPUT_GRANT_INVALID")
        raise OutputCaptureError("OUTPUT_GRANT_INVALID") from None

    wall_deadline = started_at + spec.wall_timeout_ms / 1000.0
    previous_clock = started_at
    last_activity = started_at
    states = (
        _StreamState("stdout", spec.stdout_max_bytes),
        _StreamState("stderr", spec.stderr_max_bytes),
    )
    selector: selectors.BaseSelector | None = None

    def checkpoint(idle_since: float | None = None) -> float:
        nonlocal previous_clock
        control.check_cancelled()
        checked_at = _clock_sample(monotonic, previous_clock)
        previous_clock = checked_at
        if checked_at >= wall_deadline:
            raise _CaptureFailure("WALL_TIMEOUT")
        if (
            idle_since is not None
            and checked_at >= idle_since + spec.idle_timeout_ms / 1000.0
        ):
            raise _CaptureFailure("IDLE_TIMEOUT")
        return checked_at

    try:
        states[0].source_fd = _stream_fd(stdout)
        states[1].source_fd = _stream_fd(stderr)
        if states[0].source_fd == states[1].source_fd:
            raise _CaptureFailure("OUTPUT_STREAM_INVALID")
        _prepare_streams(states)
        checkpoint(last_activity)

        for state in states:
            state.output_fd, state.output_identity = _create_private_file(
                layout.raw_directory_fd,
                state.filename,
            )

        selector = selectors.DefaultSelector()
        for state in states:
            try:
                selector.register(state.read_fd, selectors.EVENT_READ, state)
            except Exception:
                raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None

        while selector.get_map() and control.failure_reason is None:
            now = checkpoint(last_activity)
            wait_seconds = min(
                wall_deadline - now,
                last_activity + spec.idle_timeout_ms / 1000.0 - now,
                _MAX_SELECT_SECONDS,
            )
            try:
                ready = selector.select(wait_seconds)
            except Exception:
                raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None
            now = checkpoint(last_activity)

            for key, _ in ready:
                state = key.data
                if type(state) is not _StreamState:
                    raise _CaptureFailure("OUTPUT_STREAM_ERROR")
                try:
                    block = os.read(key.fd, _READ_SIZE)
                except BlockingIOError:
                    continue
                except Exception:
                    raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None
                if not block:
                    try:
                        selector.unregister(key.fd)
                        _release_stream(state)
                    except Exception:
                        raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None
                    continue

                stream_remaining = state.max_bytes - state.count
                combined_count = states[0].count + states[1].count
                combined_remaining = spec.combined_max_bytes - combined_count
                accepted = min(len(block), stream_remaining, combined_remaining)
                if accepted:
                    prefix = block[:accepted]
                    try:
                        activity_at = _write_all(
                            state.output_fd,
                            prefix,
                            writer,
                            checkpoint,
                        )
                    except _CaptureFailure as exc:
                        if exc.bytes_written:
                            stored = prefix[: exc.bytes_written]
                            state.digest.update(stored)
                            state.count += exc.bytes_written
                        raise
                    state.digest.update(prefix)
                    state.count += accepted
                    last_activity = activity_at
                if accepted != len(block):
                    reason = (
                        state.name.upper() + "_LIMIT_EXCEEDED"
                        if stream_remaining <= combined_remaining
                        else "COMBINED_LIMIT_EXCEEDED"
                    )
                    raise _CaptureFailure(reason)
    except _CaptureFailure as exc:
        control.fail(exc.reason_code)
    except Exception:
        control.fail("OUTPUT_CAPTURE_INTERNAL_ERROR")
    finally:
        if selector is not None:
            try:
                selector.close()
            except Exception:
                control.fail("OUTPUT_STREAM_ERROR")

        for state in states:
            if state.output_fd < 0:
                continue
            try:
                os.fsync(state.output_fd)
            except Exception:
                control.fail("OUTPUT_STORAGE_ERROR")
        try:
            os.fsync(layout.raw_directory_fd)
        except Exception:
            control.fail("OUTPUT_STORAGE_ERROR")

        for state in states:
            if state.output_fd < 0:
                continue
            if state.output_identity is None or not _file_is_current(
                layout.raw_directory_fd,
                state.filename,
                state.output_fd,
                state.output_identity,
                state.count,
            ):
                control.fail("OUTPUT_PATH_CHANGED")
        if not _layout_is_current(layout, grant):
            control.fail("OUTPUT_PATH_CHANGED")
        try:
            checkpoint()
        except _CaptureFailure as exc:
            control.fail(exc.reason_code)
        except Exception:
            control.fail("OUTPUT_CAPTURE_INTERNAL_ERROR")

        for state in states:
            try:
                _release_stream(state)
            except _CaptureFailure as exc:
                control.fail(exc.reason_code)
            if state.output_fd >= 0:
                _close_safely(state.output_fd)
                state.output_fd = -1
        layout.close()

    receipt = _make_receipt(spec, grant, states, control.failure_reason)
    if control.failure_reason is not None:
        raise OutputCaptureError(control.failure_reason, receipt) from None
    return receipt
