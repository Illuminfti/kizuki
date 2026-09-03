"""Bounded concurrent output capture into one append-only evidence object.

The evidence linearization unit is one generation-bound framed file.  It holds a
canonical header, bounded typed stdout/stderr frames, and one canonical terminal
trailer.  The writer is fsynced, closed mode 0600, reopened read-only via
a pinned directory descriptor, parsed, and hashed before a receipt is returned.

This seam reports only evidence and stop-callback facts.  It never claims that a
process or cgroup stopped.  Its stable-read protocol detects mutations that
intersect authentication.  The final proof checks the closed evidence object, then the
attempt lock and namespace.  It assumes the same-UID controller does not mutate
each resource after its respective final fingerprint, including the narrow
interval before the caller observes the return.  It cannot protect against
later mutation by a compromised same-UID controller.  ``observed``
metrics cover the exact bounded prefix admitted under the observed-byte cap;
bytes discarded during bounded post-stop draining are not counted or hashed.
The stop callback must be idempotent.  A callback timeout records only that its
bounded observation deadline elapsed; the daemon callback may still be running.
Attempt IDs are single-use, and any prior, partial, malformed, or crashed object
consumes them.  ``raw_directory`` is a controller-provided per-attempt resource;
the pump holds a nonblocking exclusive lock on its pinned directory descriptor,
so another active pump cannot mutate that namespace.  Separate attempt
directories remain fully concurrent.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import re
import secrets
import selectors
import stat
import struct
import threading
import time
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Callable, Optional


__all__ = ("EvidencePumpError", "EvidenceReceipt", "pump_evidence")


_READ_SIZE = 64 * 1024
_FRAME_DATA_MAX = 64 * 1024
_FRAME_HEADER = struct.Struct(">cI")
_MAGIC = b"KIZUKI_EVIDENCE_FRAMED_V3\n"
_SCHEMA = "kizuki.evidence.framed"
_VERSION = 3
_MAX_RETAINED_BYTES = 64 * 1024 * 1024
_MAX_OBSERVED_BYTES = 1024 * 1024 * 1024
_MAX_TIMEOUT_SECONDS = 60 * 60
_MAX_DRAIN_TIMEOUT_SECONDS = 30
_MAX_STOP_CALLBACK_SECONDS = 10
_CANCEL_POLL_SECONDS = 0.01
_FALLBACK_STOP_CALLBACK_SECONDS = 0.1
_MAX_MARKER_BYTES = 4096
_MAX_DATA_FRAMES = (_MAX_RETAINED_BYTES + _FRAME_DATA_MAX - 1) // _FRAME_DATA_MAX + 2
_MAX_OBJECT_BYTES = (
    len(_MAGIC)
    + (2 * (_FRAME_HEADER.size + _MAX_MARKER_BYTES))
    + _MAX_RETAINED_BYTES
    + (_MAX_DATA_FRAMES * _FRAME_HEADER.size)
)
_MAX_ATTEMPT_ENTRIES = 8
_MAX_DIRECTORY_ENTRIES = 32
_EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
_HEX_64 = re.compile(r"[0-9a-f]{64}\Z")
_HEX_32 = re.compile(r"[0-9a-f]{32}\Z")
_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_NONBLOCK = getattr(os, "O_NONBLOCK", 0)


class EvidencePumpError(RuntimeError):
    """Evidence capture failed without returning a success-like receipt."""

    def __init__(self, message: str, *, receipt: Optional["EvidenceReceipt"] = None):
        super().__init__(message)
        self.receipt = receipt


@dataclass(frozen=True, slots=True)
class EvidenceReceipt:
    """Immutable, content-free evidence and callback metrics."""

    attempt_id: Optional[str]
    generation: Optional[str]
    evidence_sha256: Optional[str]
    evidence_bytes: int
    stdout_observed_sha256: str
    stderr_observed_sha256: str
    stdout_retained_sha256: str
    stderr_retained_sha256: str
    stdout_observed_bytes: int
    stderr_observed_bytes: int
    stdout_retained_bytes: int
    stderr_retained_bytes: int
    overflowed: bool
    stdout_eof: bool
    stderr_eof: bool
    timed_out: bool
    cancelled: bool
    drain_limit_reached: bool
    capture_started: bool
    recovered_residue: bool
    stop_callback_requested: bool
    stop_callback_completed: bool
    stop_callback_failed: bool
    stop_callback_timed_out: bool
    raw_evidence_committed: bool
    raw_evidence_quarantined: bool
    recovery_required: bool

    def __post_init__(self) -> None:
        if self.attempt_id is not None and (
            not isinstance(self.attempt_id, str)
            or _HEX_64.fullmatch(self.attempt_id) is None
        ):
            raise EvidencePumpError("invalid receipt attempt_id")
        if self.generation is not None and (
            not isinstance(self.generation, str)
            or _HEX_32.fullmatch(self.generation) is None
        ):
            raise EvidencePumpError("invalid receipt generation")
        if self.evidence_sha256 is not None and (
            not isinstance(self.evidence_sha256, str)
            or _HEX_64.fullmatch(self.evidence_sha256) is None
        ):
            raise EvidencePumpError("invalid evidence object digest")
        if (
            isinstance(self.evidence_bytes, bool)
            or not isinstance(self.evidence_bytes, int)
            or self.evidence_bytes < 0
            or self.evidence_bytes > _MAX_OBJECT_BYTES
        ):
            raise EvidencePumpError("invalid evidence object byte count")
        for digest in (
            self.stdout_observed_sha256,
            self.stderr_observed_sha256,
            self.stdout_retained_sha256,
            self.stderr_retained_sha256,
        ):
            if not isinstance(digest, str) or _HEX_64.fullmatch(digest) is None:
                raise EvidencePumpError("invalid stream digest")
        counts = (
            self.stdout_observed_bytes,
            self.stderr_observed_bytes,
            self.stdout_retained_bytes,
            self.stderr_retained_bytes,
        )
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in counts):
            raise EvidencePumpError("invalid stream byte count")
        if (
            self.stdout_observed_bytes + self.stderr_observed_bytes
            > _MAX_OBSERVED_BYTES
        ):
            raise EvidencePumpError("observed byte count exceeds global bound")
        if (
            self.stdout_retained_bytes + self.stderr_retained_bytes
            > _MAX_RETAINED_BYTES
        ):
            raise EvidencePumpError("retained byte count exceeds global bound")
        if (
            self.stdout_retained_bytes > self.stdout_observed_bytes
            or self.stderr_retained_bytes > self.stderr_observed_bytes
        ):
            raise EvidencePumpError("retained byte count exceeds observed bytes")
        for stream in ("stdout", "stderr"):
            if (
                getattr(self, f"{stream}_retained_bytes")
                == getattr(self, f"{stream}_observed_bytes")
                and getattr(self, f"{stream}_retained_sha256")
                != getattr(self, f"{stream}_observed_sha256")
            ):
                raise EvidencePumpError("fully retained observed digest is inconsistent")
        expected_overflow = (
            self.stdout_retained_bytes < self.stdout_observed_bytes
            or self.stderr_retained_bytes < self.stderr_observed_bytes
        )
        if self.overflowed != expected_overflow:
            raise EvidencePumpError("overflow metric does not match retained evidence")
        booleans = (
            self.overflowed,
            self.stdout_eof,
            self.stderr_eof,
            self.timed_out,
            self.cancelled,
            self.drain_limit_reached,
            self.capture_started,
            self.recovered_residue,
            self.stop_callback_requested,
            self.stop_callback_completed,
            self.stop_callback_failed,
            self.stop_callback_timed_out,
            self.raw_evidence_committed,
            self.raw_evidence_quarantined,
            self.recovery_required,
        )
        if any(not isinstance(value, bool) for value in booleans):
            raise EvidencePumpError("invalid evidence metric")
        outcomes = sum(
            (
                self.stop_callback_completed,
                self.stop_callback_failed,
                self.stop_callback_timed_out,
            )
        )
        if self.stop_callback_requested != (outcomes == 1):
            raise EvidencePumpError("invalid stop callback outcome")
        if self.raw_evidence_committed and self.raw_evidence_quarantined:
            raise EvidencePumpError("evidence cannot be committed and quarantined")
        attempt_bound = self.attempt_id is not None
        if attempt_bound != (self.generation is not None):
            raise EvidencePumpError("attempt and generation bindings must be paired")
        object_bound = self.evidence_sha256 is not None
        if object_bound != (self.evidence_bytes > 0):
            raise EvidencePumpError("evidence digest and byte count must be paired")
        if object_bound and not attempt_bound:
            raise EvidencePumpError("evidence object lacks attempt generation binding")
        publication = self.raw_evidence_committed or self.raw_evidence_quarantined
        unpublished_capture = self.capture_started and not publication
        if publication != object_bound:
            raise EvidencePumpError("publication and authenticated object binding differ")
        if self.capture_started and not attempt_bound:
            raise EvidencePumpError("started capture lacks attempt generation binding")
        if self.recovered_residue and attempt_bound:
            raise EvidencePumpError("pre-reservation residue receipt claims a generation")
        if publication and not self.capture_started:
            raise EvidencePumpError("published evidence requires started capture")
        if unpublished_capture and (
            self.stdout_retained_bytes
            or self.stderr_retained_bytes
            or self.stdout_retained_sha256 != _EMPTY_SHA256
            or self.stderr_retained_sha256 != _EMPTY_SHA256
        ):
            raise EvidencePumpError("unauthenticated capture cannot claim retained evidence")
        if self.raw_evidence_committed and (
            not self.stdout_eof
            or not self.stderr_eof
            or self.timed_out
            or self.cancelled
            or self.drain_limit_reached
        ):
            raise EvidencePumpError("incomplete evidence cannot be committed")
        if self.raw_evidence_quarantined and not self.recovery_required:
            raise EvidencePumpError("quarantined evidence requires recovery")
        if self.raw_evidence_quarantined and not self.stop_callback_requested:
            raise EvidencePumpError("quarantined evidence lacks a stop request")
        if self.raw_evidence_committed and (
            self.stop_callback_requested != self.overflowed
            or (
                self.stop_callback_requested
                and not self.stop_callback_completed
            )
        ):
            raise EvidencePumpError("committed evidence has an impossible stop outcome")
        if (
            self.stop_callback_requested or self.recovered_residue
        ) and not self.recovery_required:
            raise EvidencePumpError("stop or residue requires recovery")
        if self.recovered_residue and (
            self.capture_started or not self.stop_callback_requested
        ):
            raise EvidencePumpError("residue recovery cannot resume capture")
        if (
            self.timed_out
            or self.cancelled
            or self.drain_limit_reached
        ) and not self.stop_callback_requested:
            raise EvidencePumpError("capture interruption lacks a stop request")
        if (
            self.capture_started
            and not publication
            and (not self.recovery_required or not self.stop_callback_requested)
        ):
            raise EvidencePumpError("unauthenticated capture requires stop and recovery")
        expected_recovery = (
            self.stop_callback_requested
            or self.recovered_residue
            or self.raw_evidence_quarantined
            or unpublished_capture
        )
        if self.recovery_required != expected_recovery:
            raise EvidencePumpError("recovery status does not match evidence state")
        if not self.capture_started:
            if (
                any(counts)
                or self.stdout_observed_sha256 != _EMPTY_SHA256
                or self.stderr_observed_sha256 != _EMPTY_SHA256
                or self.stdout_retained_sha256 != _EMPTY_SHA256
                or self.stderr_retained_sha256 != _EMPTY_SHA256
                or self.stdout_eof
                or self.stderr_eof
                or self.timed_out
                or self.cancelled
                or self.drain_limit_reached
                or self.raw_evidence_committed
                or self.raw_evidence_quarantined
            ):
                raise EvidencePumpError("zero-capture receipt contains evidence")


@dataclass(frozen=True, slots=True)
class _StopStatus:
    requested: bool
    completed: bool
    failed: bool
    timed_out: bool
    error: Optional[BaseException]


class _StopController:
    """Run one required-idempotent callback without blocking pipe draining."""

    def __init__(self, callback: Callable[[], None], timeout_seconds: float):
        self._callback = callback
        self._timeout_seconds = timeout_seconds
        self._lock = threading.Lock()
        self._requested = False
        self._finished = False
        self._deadline: Optional[float] = None
        self._completed_at: Optional[float] = None
        self._error: Optional[BaseException] = None
        self._thread: Optional[threading.Thread] = None

    def request(self) -> None:
        with self._lock:
            if self._requested:
                return
            self._requested = True
            self._deadline = time.monotonic() + self._timeout_seconds
            thread = threading.Thread(
                target=self._run,
                name="kizuki-evidence-stop-request",
                daemon=True,
            )
            self._thread = thread
            try:
                thread.start()
            except BaseException as exc:
                self._error = exc
                self._finished = True
                self._completed_at = time.monotonic()
                self._thread = None

    def _run(self) -> None:
        error: Optional[BaseException] = None
        try:
            self._callback()
        except BaseException as exc:
            error = exc
        completed_at = time.monotonic()
        with self._lock:
            self._error = error
            self._completed_at = completed_at
            self._finished = True

    def status(self, *, wait: bool) -> _StopStatus:
        with self._lock:
            if not self._requested:
                return _StopStatus(False, False, False, False, None)
            thread = self._thread
            deadline = self._deadline
        assert deadline is not None
        if wait and thread is not None:
            thread.join(max(0.0, deadline - time.monotonic()))
        with self._lock:
            finished = self._finished
            completed_at = self._completed_at
            error = self._error
        timed_out = not finished or (completed_at is not None and completed_at > deadline)
        if timed_out:
            return _StopStatus(True, False, False, True, error)
        if error is not None:
            return _StopStatus(True, False, True, False, error)
        return _StopStatus(True, True, False, False, None)


@dataclass(frozen=True, slots=True)
class _Metric:
    digest: str
    size: int


@dataclass(frozen=True, slots=True)
class _Directory:
    fd: int
    path: Path
    device: int
    inode: int
    uid: int


@dataclass(frozen=True, slots=True)
class _Lock:
    fd: int
    name: str
    device: int
    inode: int
    created: bool


@dataclass(frozen=True, slots=True)
class _ParsedEvidence:
    attempt_id: str
    generation: str
    state: str
    header: dict[str, object]
    trailer: dict[str, object]
    stdout_retained: _Metric
    stderr_retained: _Metric
    object_sha256: str
    object_bytes: int
    object_fingerprint: Optional[tuple[int, ...]] = None


def _bounded_integer(value: object, *, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise EvidencePumpError(f"{label} must be an integer")
    if value < minimum or value > maximum:
        raise EvidencePumpError(f"{label} is outside the allowed bound")
    return value


def _bounded_seconds(value: object, *, label: str, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise EvidencePumpError(f"{label} must be a number")
    result = float(value)
    if not math.isfinite(result) or result <= 0 or result > maximum:
        raise EvidencePumpError(f"{label} is outside the allowed bound")
    return result


def _validated_attempt_id(value: object) -> str:
    if not isinstance(value, str) or _HEX_64.fullmatch(value) is None:
        raise EvidencePumpError("attempt_id must be 64 lowercase hexadecimal characters")
    return value


def _validated_generation(value: object) -> str:
    if not isinstance(value, str) or _HEX_32.fullmatch(value) is None:
        raise EvidencePumpError("generation must be 32 lowercase hexadecimal characters")
    return value


def _input_fingerprint(info: os.stat_result) -> tuple[int, int, int]:
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))


def _admit_input_fd(value: object, label: str) -> tuple[int, tuple[int, int, int]]:
    """Pin and identify the kernel stream before any artifact reservation."""

    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise EvidencePumpError(f"{label} must be a file descriptor")
    duplicate = -1
    try:
        before = os.fstat(value)
        if not (stat.S_ISFIFO(before.st_mode) or stat.S_ISSOCK(before.st_mode)):
            raise EvidencePumpError(f"{label} must be a pipe or socket")
        duplicate = os.dup(value)
        after = os.fstat(value)
        held = os.fstat(duplicate)
    except OSError as exc:
        if duplicate >= 0:
            os.close(duplicate)
        raise EvidencePumpError(f"{label} is not open") from exc
    except BaseException:
        if duplicate >= 0:
            os.close(duplicate)
        raise
    fingerprints = {
        _input_fingerprint(before),
        _input_fingerprint(after),
        _input_fingerprint(held),
    }
    if (
        len(fingerprints) != 1
        or not (stat.S_ISFIFO(after.st_mode) or stat.S_ISSOCK(after.st_mode))
        or not (stat.S_ISFIFO(held.st_mode) or stat.S_ISSOCK(held.st_mode))
    ):
        os.close(duplicate)
        raise EvidencePumpError(f"{label} changed during admission")
    return duplicate, _input_fingerprint(held)


def _open_owned_directory(raw_directory: object) -> _Directory:
    try:
        raw_path = Path(os.fspath(raw_directory))
    except (TypeError, ValueError) as exc:
        raise EvidencePumpError("raw_directory must be path-like") from exc
    absolute = Path(os.path.abspath(raw_path))
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | _CLOEXEC)
    try:
        for part in absolute.parts[1:]:
            if part in ("", ".", ".."):
                raise EvidencePumpError("raw_directory contains unsafe component")
            next_fd = os.open(
                part,
                os.O_RDONLY | os.O_DIRECTORY | _NOFOLLOW | _CLOEXEC,
                dir_fd=current,
            )
            os.close(current)
            current = next_fd
        info = os.fstat(current)
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise EvidencePumpError("raw_directory must be controller-owned mode 0700")
        path_info = os.lstat(absolute)
        if stat.S_ISLNK(path_info.st_mode) or (
            path_info.st_dev,
            path_info.st_ino,
        ) != (info.st_dev, info.st_ino):
            raise EvidencePumpError("raw_directory pathname does not match pinned directory")
        try:
            fcntl.flock(current, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise EvidencePumpError("raw_directory is already active") from exc
        result = _Directory(current, absolute, info.st_dev, info.st_ino, info.st_uid)
        current = -1
        return result
    except EvidencePumpError:
        raise
    except OSError as exc:
        raise EvidencePumpError("cannot open raw_directory without following links") from exc
    finally:
        if current >= 0:
            os.close(current)


def _verify_directory(directory: _Directory) -> None:
    fd_info = os.fstat(directory.fd)
    try:
        path_info = os.lstat(directory.path)
    except OSError as exc:
        raise EvidencePumpError("raw_directory pathname disappeared") from exc
    expected = (directory.device, directory.inode, directory.uid, 0o700)
    fd_actual = (
        fd_info.st_dev,
        fd_info.st_ino,
        fd_info.st_uid,
        stat.S_IMODE(fd_info.st_mode),
    )
    path_actual = (
        path_info.st_dev,
        path_info.st_ino,
        path_info.st_uid,
        stat.S_IMODE(path_info.st_mode),
    )
    if (
        not stat.S_ISDIR(fd_info.st_mode)
        or stat.S_ISLNK(path_info.st_mode)
        or fd_actual != expected
        or path_actual != expected
    ):
        raise EvidencePumpError("raw_directory identity or permissions changed")


def _exact_regular(
    info: os.stat_result,
    *,
    uid: int,
    modes: tuple[int, ...],
    maximum_size: int,
) -> None:
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != uid
        or stat.S_IMODE(info.st_mode) not in modes
        or info.st_nlink != 1
        or info.st_size < 0
        or info.st_size > maximum_size
    ):
        raise EvidencePumpError("evidence object metadata is invalid")


def _open_attempt_lock(directory: _Directory, attempt_id: str) -> _Lock:
    name = f"{attempt_id}.controller.lock"
    flags = os.O_RDONLY | _NOFOLLOW | _CLOEXEC | _NONBLOCK
    fd = -1
    created = False
    try:
        try:
            fd = os.open(
                name,
                flags | os.O_CREAT | os.O_EXCL,
                0o400,
                dir_fd=directory.fd,
            )
            created = True
        except FileExistsError:
            fd = os.open(name, flags, dir_fd=directory.fd)
        info = os.fstat(fd)
        _exact_regular(info, uid=directory.uid, modes=(0o400,), maximum_size=0)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise EvidencePumpError("attempt lock is held") from exc
        if created:
            os.fchmod(fd, 0o400)
            os.fsync(fd)
            os.fsync(directory.fd)
            info = os.fstat(fd)
            _exact_regular(info, uid=directory.uid, modes=(0o400,), maximum_size=0)
        named = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
        if (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
            raise EvidencePumpError("attempt lock pathname changed")
        return _Lock(fd, name, info.st_dev, info.st_ino, created)
    except EvidencePumpError:
        if fd >= 0:
            os.close(fd)
        raise
    except OSError as exc:
        if fd >= 0:
            os.close(fd)
        raise EvidencePumpError("cannot reserve attempt lock") from exc


def _verify_lock(directory: _Directory, lock: _Lock) -> None:
    info = os.fstat(lock.fd)
    _exact_regular(info, uid=directory.uid, modes=(0o400,), maximum_size=0)
    try:
        named = os.stat(lock.name, dir_fd=directory.fd, follow_symlinks=False)
    except OSError as exc:
        raise EvidencePumpError("attempt lock pathname disappeared") from exc
    if (
        (info.st_dev, info.st_ino) != (lock.device, lock.inode)
        or (named.st_dev, named.st_ino) != (lock.device, lock.inode)
    ):
        raise EvidencePumpError("attempt lock identity changed")


def _canonical_json(value: dict[str, object]) -> bytes:
    try:
        raw = json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii") + b"\n"
    except (TypeError, ValueError) as exc:
        raise EvidencePumpError("marker payload is not canonicalizable") from exc
    if len(raw) > _MAX_MARKER_BYTES:
        raise EvidencePumpError("marker payload exceeds bound")
    return raw


def _unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise EvidencePumpError("marker contains duplicate keys")
        result[key] = value
    return result


def _parse_canonical_json(raw: bytes) -> dict[str, object]:
    if not raw or len(raw) > _MAX_MARKER_BYTES or not raw.endswith(b"\n"):
        raise EvidencePumpError("marker encoding is invalid")
    try:
        value = json.loads(
            raw.decode("ascii"),
            object_pairs_hook=_unique_object,
            parse_constant=lambda token: (_ for _ in ()).throw(
                EvidencePumpError(f"invalid JSON constant: {token}")
            ),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, EvidencePumpError) as exc:
        if isinstance(exc, EvidencePumpError):
            raise
        raise EvidencePumpError("marker JSON is invalid") from exc
    if not isinstance(value, dict) or _canonical_json(value) != raw:
        raise EvidencePumpError("marker JSON is not canonical")
    return value


def _header_payload(
    attempt_id: str,
    generation: str,
    retained_byte_cap: int,
    observed_byte_cap: int,
) -> dict[str, object]:
    return {
        "attempt_id": attempt_id,
        "generation": generation,
        "observed_byte_cap": observed_byte_cap,
        "retained_byte_cap": retained_byte_cap,
        "schema": _SCHEMA,
        "version": _VERSION,
    }


def _validate_header(value: dict[str, object]) -> None:
    expected = {
        "attempt_id",
        "generation",
        "observed_byte_cap",
        "retained_byte_cap",
        "schema",
        "version",
    }
    if set(value) != expected:
        raise EvidencePumpError("evidence header schema is invalid")
    _validated_attempt_id(value.get("attempt_id"))
    _validated_generation(value.get("generation"))
    retained = _bounded_integer(
        value.get("retained_byte_cap"),
        label="retained_byte_cap",
        minimum=0,
        maximum=_MAX_RETAINED_BYTES,
    )
    observed = _bounded_integer(
        value.get("observed_byte_cap"),
        label="observed_byte_cap",
        minimum=1,
        maximum=_MAX_OBSERVED_BYTES,
    )
    if observed < retained:
        raise EvidencePumpError("header observed cap does not cover retained cap")
    version = value.get("version")
    if (
        value.get("schema") != _SCHEMA
        or isinstance(version, bool)
        or not isinstance(version, int)
        or version != _VERSION
    ):
        raise EvidencePumpError("evidence header version is invalid")


_TRAILER_KEYS = {
    "attempt_id",
    "cancelled",
    "drain_limit_reached",
    "generation",
    "overflowed",
    "recovery_required",
    "state",
    "stderr_eof",
    "stderr_observed_bytes",
    "stderr_observed_sha256",
    "stderr_retained_bytes",
    "stderr_retained_sha256",
    "stdout_eof",
    "stdout_observed_bytes",
    "stdout_observed_sha256",
    "stdout_retained_bytes",
    "stdout_retained_sha256",
    "stop_callback_completed",
    "stop_callback_failed",
    "stop_callback_requested",
    "stop_callback_timed_out",
    "timed_out",
    "version",
}


def _validate_trailer(
    value: dict[str, object],
    header: dict[str, object],
    retained: dict[str, _Metric],
) -> None:
    if set(value) != _TRAILER_KEYS:
        raise EvidencePumpError("evidence trailer schema is invalid")
    state = value.get("state")
    if (
        value.get("attempt_id") != header["attempt_id"]
        or value.get("generation") != header["generation"]
        or isinstance(value.get("version"), bool)
        or not isinstance(value.get("version"), int)
        or value.get("version") != _VERSION
        or not isinstance(state, str)
        or state not in {"COMMITTED", "QUARANTINED"}
    ):
        raise EvidencePumpError("evidence trailer binding is invalid")
    boolean_names = {
        "cancelled",
        "drain_limit_reached",
        "overflowed",
        "recovery_required",
        "stderr_eof",
        "stdout_eof",
        "stop_callback_completed",
        "stop_callback_failed",
        "stop_callback_requested",
        "stop_callback_timed_out",
        "timed_out",
    }
    if any(not isinstance(value.get(name), bool) for name in boolean_names):
        raise EvidencePumpError("evidence trailer boolean is invalid")
    observed_total = 0
    retained_total = 0
    for stream in ("stdout", "stderr"):
        observed_count = value.get(f"{stream}_observed_bytes")
        retained_count = value.get(f"{stream}_retained_bytes")
        observed_digest = value.get(f"{stream}_observed_sha256")
        retained_digest = value.get(f"{stream}_retained_sha256")
        if (
            isinstance(observed_count, bool)
            or not isinstance(observed_count, int)
            or observed_count < 0
            or isinstance(retained_count, bool)
            or not isinstance(retained_count, int)
            or retained_count < 0
            or retained_count > observed_count
            or not isinstance(observed_digest, str)
            or _HEX_64.fullmatch(observed_digest) is None
            or not isinstance(retained_digest, str)
            or _HEX_64.fullmatch(retained_digest) is None
            or retained_count != retained[stream].size
            or retained_digest != retained[stream].digest
        ):
            raise EvidencePumpError("evidence trailer stream metric is invalid")
        if observed_count == retained_count and observed_digest != retained_digest:
            raise EvidencePumpError("fully retained observed digest is inconsistent")
        observed_total += observed_count
        retained_total += retained_count
    if observed_total > header["observed_byte_cap"]:
        raise EvidencePumpError("observed evidence exceeds header cap")
    if retained_total > header["retained_byte_cap"]:
        raise EvidencePumpError("retained evidence exceeds header cap")
    expected_overflow = any(
        value[f"{stream}_retained_bytes"] < value[f"{stream}_observed_bytes"]
        for stream in ("stdout", "stderr")
    )
    if value["overflowed"] != expected_overflow:
        raise EvidencePumpError("trailer overflow metric is invalid")
    if expected_overflow and retained_total != header["retained_byte_cap"]:
        raise EvidencePumpError("overflowed evidence did not fill its retained cap")
    stop_outcomes = sum(
        bool(value[name])
        for name in (
            "stop_callback_completed",
            "stop_callback_failed",
            "stop_callback_timed_out",
        )
    )
    if bool(value["stop_callback_requested"]) != (stop_outcomes == 1):
        raise EvidencePumpError("trailer stop callback outcome is invalid")
    if value["state"] == "QUARANTINED" and not value["stop_callback_requested"]:
        raise EvidencePumpError("quarantined evidence lacks a stop request")
    if value["state"] == "COMMITTED" and (
        value["stop_callback_requested"] != value["overflowed"]
        or (
            value["stop_callback_requested"]
            and not value["stop_callback_completed"]
        )
    ):
        raise EvidencePumpError("committed evidence has an impossible stop outcome")
    expected_recovery = bool(value["stop_callback_requested"]) or (
        value["state"] == "QUARANTINED"
    )
    if value["recovery_required"] != expected_recovery:
        raise EvidencePumpError("trailer recovery status is invalid")
    if value["state"] == "COMMITTED" and (
        not value["stdout_eof"]
        or not value["stderr_eof"]
        or value["timed_out"]
        or value["cancelled"]
        or value["drain_limit_reached"]
    ):
        raise EvidencePumpError("incomplete object cannot be COMMITTED")


def _encode_frame(kind: bytes, payload: bytes) -> bytes:
    if kind not in {b"H", b"O", b"E", b"T"}:
        raise EvidencePumpError("unknown evidence frame type")
    maximum = _MAX_MARKER_BYTES if kind in {b"H", b"T"} else _FRAME_DATA_MAX
    if not payload or len(payload) > maximum:
        raise EvidencePumpError("evidence frame payload is outside bound")
    return _FRAME_HEADER.pack(kind, len(payload)) + payload


def _parse_evidence_object(
    raw: bytes,
    *,
    expected_attempt_id: Optional[str] = None,
    expected_generation: Optional[str] = None,
) -> _ParsedEvidence:
    """Parse and recompute one exact framed evidence object."""

    if not isinstance(raw, bytes) or len(raw) > _MAX_OBJECT_BYTES:
        raise EvidencePumpError("evidence object is outside size bound")
    if not raw.startswith(_MAGIC):
        raise EvidencePumpError("evidence object magic is invalid")
    offset = len(_MAGIC)
    header: Optional[dict[str, object]] = None
    trailer: Optional[dict[str, object]] = None
    hashes = {"stdout": hashlib.sha256(), "stderr": hashlib.sha256()}
    counts = {"stdout": 0, "stderr": 0}
    data_frames = 0
    frame_index = 0
    residual_tail: Optional[str] = None
    while offset < len(raw):
        if len(raw) - offset < _FRAME_HEADER.size:
            raise EvidencePumpError("evidence frame header is truncated")
        kind, length = _FRAME_HEADER.unpack_from(raw, offset)
        offset += _FRAME_HEADER.size
        maximum = _MAX_MARKER_BYTES if kind in {b"H", b"T"} else _FRAME_DATA_MAX
        if kind not in {b"H", b"O", b"E", b"T"} or length < 1 or length > maximum:
            raise EvidencePumpError("evidence frame header is invalid")
        end = offset + length
        if end > len(raw):
            raise EvidencePumpError("evidence frame payload is truncated")
        payload = raw[offset:end]
        offset = end
        if frame_index == 0 and kind != b"H":
            raise EvidencePumpError("evidence header is not first frame")
        if kind == b"H":
            if frame_index != 0 or header is not None:
                raise EvidencePumpError("evidence contains duplicate header")
            header = _parse_canonical_json(payload)
            _validate_header(header)
        elif kind in {b"O", b"E"}:
            if header is None or trailer is not None:
                raise EvidencePumpError("data frame is outside evidence body")
            stream = "stdout" if kind == b"O" else "stderr"
            if residual_tail == "stderr" or (
                residual_tail == "stdout"
                and (stream != "stderr" or length == _FRAME_DATA_MAX)
            ):
                raise EvidencePumpError("evidence data framing is not canonical")
            if length < _FRAME_DATA_MAX:
                residual_tail = stream
            data_frames += 1
            if data_frames > _MAX_DATA_FRAMES:
                raise EvidencePumpError("evidence data frame count exceeds bound")
            counts[stream] += len(payload)
            if counts["stdout"] + counts["stderr"] > _MAX_RETAINED_BYTES:
                raise EvidencePumpError("evidence frame bytes exceed bound")
            hashes[stream].update(payload)
        else:
            if header is None or trailer is not None or offset != len(raw):
                raise EvidencePumpError("evidence trailer is not final frame")
            trailer = _parse_canonical_json(payload)
        frame_index += 1
    if header is None or trailer is None:
        raise EvidencePumpError("evidence object is missing terminal frame")
    retained = {
        stream: _Metric(hashes[stream].hexdigest(), counts[stream])
        for stream in ("stdout", "stderr")
    }
    _validate_trailer(trailer, header, retained)
    attempt_id = str(header["attempt_id"])
    generation = str(header["generation"])
    if expected_attempt_id is not None and attempt_id != expected_attempt_id:
        raise EvidencePumpError("evidence object attempt binding changed")
    if expected_generation is not None and generation != expected_generation:
        raise EvidencePumpError("evidence object generation binding changed")
    return _ParsedEvidence(
        attempt_id=attempt_id,
        generation=generation,
        state=str(trailer["state"]),
        header=header,
        trailer=trailer,
        stdout_retained=retained["stdout"],
        stderr_retained=retained["stderr"],
        object_sha256=hashlib.sha256(raw).hexdigest(),
        object_bytes=len(raw),
    )


def _write_all(fd: int, raw: bytes) -> None:
    offset = 0
    while offset < len(raw):
        written = os.write(fd, raw[offset:])
        if written <= 0:
            raise EvidencePumpError("short evidence write")
        offset += written


def _metadata_fingerprint(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_uid,
        stat.S_IMODE(info.st_mode),
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def _pread_exact(fd: int, size: int) -> bytes:
    output = bytearray()
    offset = 0
    while offset < size:
        chunk = os.pread(fd, min(_READ_SIZE, size - offset), offset)
        if not chunk:
            raise EvidencePumpError("evidence object truncated during authentication")
        output.extend(chunk)
        offset += len(chunk)
    if os.pread(fd, 1, size):
        raise EvidencePumpError("evidence object grew during authentication")
    return bytes(output)


def _stable_read_regular(
    directory: _Directory,
    name: str,
    *,
    maximum_size: int,
    expected_mode: int = 0o400,
    expected_identity: Optional[tuple[int, int]] = None,
) -> tuple[bytes, tuple[int, ...]]:
    try:
        named_before = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
        _exact_regular(
            named_before,
            uid=directory.uid,
            modes=(expected_mode,),
            maximum_size=maximum_size,
        )
        fd = os.open(
            name,
            os.O_RDONLY | _NOFOLLOW | _CLOEXEC | _NONBLOCK,
            dir_fd=directory.fd,
        )
    except (EvidencePumpError, OSError) as exc:
        if isinstance(exc, EvidencePumpError):
            raise
        raise EvidencePumpError("cannot open immutable evidence object") from exc
    try:
        before = os.fstat(fd)
        _exact_regular(
            before,
            uid=directory.uid,
            modes=(expected_mode,),
            maximum_size=maximum_size,
        )
        identity = (before.st_dev, before.st_ino)
        if identity != (named_before.st_dev, named_before.st_ino):
            raise EvidencePumpError("evidence object changed while opening")
        if expected_identity is not None and identity != expected_identity:
            raise EvidencePumpError("evidence object is not controller reservation")
        first = _pread_exact(fd, before.st_size)
        middle = os.fstat(fd)
        second = _pread_exact(fd, before.st_size)
        after_read = os.fstat(fd)
        named_after = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
        final = os.fstat(fd)
        fingerprints = {
            _metadata_fingerprint(named_before),
            _metadata_fingerprint(before),
            _metadata_fingerprint(middle),
            _metadata_fingerprint(after_read),
            _metadata_fingerprint(named_after),
            _metadata_fingerprint(final),
        }
        if (
            len(fingerprints) != 1
            or first != second
            or hashlib.sha256(first).digest() != hashlib.sha256(second).digest()
        ):
            raise EvidencePumpError("evidence object changed during authentication")
        return second, _metadata_fingerprint(final)
    except OSError as exc:
        raise EvidencePumpError("cannot authenticate immutable evidence object") from exc
    finally:
        os.close(fd)


def _authenticate_evidence(
    directory: _Directory,
    lock: _Lock,
    name: str,
    *,
    expected_attempt_id: str,
    expected_generation: str,
    expected_identity: Optional[tuple[int, int]] = None,
) -> _ParsedEvidence:
    _verify_directory(directory)
    _verify_lock(directory, lock)
    raw, fingerprint = _stable_read_regular(
        directory,
        name,
        maximum_size=_MAX_OBJECT_BYTES,
        expected_mode=0o600,
        expected_identity=expected_identity,
    )
    parsed = _parse_evidence_object(
        raw,
        expected_attempt_id=expected_attempt_id,
        expected_generation=expected_generation,
    )
    return replace(parsed, object_fingerprint=fingerprint)


def _verify_final_publication_state(
    directory: _Directory,
    lock: _Lock,
    *,
    attempt_id: str,
    evidence_name: str,
    evidence_identity: tuple[int, int],
    evidence_fingerprint: Optional[tuple[int, ...]],
    directory_fingerprint: tuple[int, ...],
    lock_fingerprint: tuple[int, ...],
) -> None:
    """Reject namespace changes that began before object authentication ended."""

    _verify_directory(directory)
    _verify_lock(directory, lock)
    if set(_attempt_names(directory, attempt_id)) != {lock.name, evidence_name}:
        raise EvidencePumpError("attempt namespace changed during authentication")
    current_lock = os.fstat(lock.fd)
    if _metadata_fingerprint(current_lock) != lock_fingerprint:
        raise EvidencePumpError("attempt lock metadata changed")
    try:
        current_evidence = os.stat(
            evidence_name, dir_fd=directory.fd, follow_symlinks=False
        )
    except OSError as exc:
        raise EvidencePumpError("evidence object pathname disappeared") from exc
    _exact_regular(
        current_evidence,
        uid=directory.uid,
        modes=(0o600,),
        maximum_size=_MAX_OBJECT_BYTES,
    )
    if (
        evidence_fingerprint is None
        or (current_evidence.st_dev, current_evidence.st_ino) != evidence_identity
        or _metadata_fingerprint(current_evidence) != evidence_fingerprint
    ):
        raise EvidencePumpError("evidence object changed after stable read")
    # The closed evidence object is the sole evidence linearization object.  Its
    # final fingerprint check must precede the last namespace proof: a new or
    # replaced attempt entry during that check changes the pinned directory's
    # metadata and is therefore rejected below.  Mutations after this final
    # namespace check are beyond the trusted-controller boundary documented at
    # module level.
    _verify_directory(directory)
    _verify_lock(directory, lock)
    if set(_attempt_names(directory, attempt_id)) != {lock.name, evidence_name}:
        raise EvidencePumpError("attempt namespace changed after object authentication")
    current_lock = os.fstat(lock.fd)
    if _metadata_fingerprint(current_lock) != lock_fingerprint:
        raise EvidencePumpError("attempt lock metadata changed")
    current_directory = os.fstat(directory.fd)
    if _metadata_fingerprint(current_directory) != directory_fingerprint:
        raise EvidencePumpError("attempt namespace metadata changed")


def _write_sealed_marker(directory: _Directory, name: str, raw: bytes) -> None:
    fd = -1
    try:
        fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | _NOFOLLOW | _CLOEXEC,
            0o600,
            dir_fd=directory.fd,
        )
        _write_all(fd, raw)
        os.fsync(fd)
        os.fchmod(fd, 0o400)
        os.fsync(fd)
    except FileExistsError as exc:
        raise EvidencePumpError("append-only marker already exists") from exc
    except OSError as exc:
        raise EvidencePumpError("cannot persist evidence marker") from exc
    finally:
        if fd >= 0:
            os.close(fd)
    os.fsync(directory.fd)


def _tombstone_payload(attempt_id: str, token: str, reason: str) -> bytes:
    return _canonical_json(
        {
            "attempt_id": attempt_id,
            "reason": reason,
            "state": "TOMBSTONE",
            "tombstone_id": token,
            "version": _VERSION,
        }
    )


def _validate_tombstone(
    value: dict[str, object], attempt_id: str, token: str
) -> None:
    if set(value) != {
        "attempt_id",
        "reason",
        "state",
        "tombstone_id",
        "version",
    }:
        raise EvidencePumpError("TOMBSTONE schema is invalid")
    reason = value.get("reason")
    if (
        value.get("attempt_id") != attempt_id
        or not isinstance(reason, str)
        or reason not in {"RESIDUE_DETECTED", "PUBLICATION_FAILED"}
        or value.get("state") != "TOMBSTONE"
        or value.get("tombstone_id") != token
        or isinstance(value.get("version"), bool)
        or not isinstance(value.get("version"), int)
        or value.get("version") != _VERSION
    ):
        raise EvidencePumpError("TOMBSTONE values are invalid")


class _EvidenceWriter:
    def __init__(
        self,
        directory: _Directory,
        attempt_id: str,
        generation: str,
        retained_cap: int,
        observed_cap: int,
    ):
        self.directory = directory
        self.attempt_id = attempt_id
        self.generation = generation
        self.name = f"{attempt_id}.{generation}.evidence"
        self.fd = -1
        self.device = -1
        self.inode = -1
        self.broken = False
        self.buffers = {"stdout": bytearray(), "stderr": bytearray()}
        self.hashes = {"stdout": hashlib.sha256(), "stderr": hashlib.sha256()}
        self.counts = {"stdout": 0, "stderr": 0}
        self.frame_count = 0
        try:
            self.fd = os.open(
                self.name,
                os.O_WRONLY
                | os.O_APPEND
                | os.O_CREAT
                | os.O_EXCL
                | _NOFOLLOW
                | _CLOEXEC,
                0o600,
                dir_fd=directory.fd,
            )
            os.fchmod(self.fd, 0o600)
            info = os.fstat(self.fd)
            _exact_regular(info, uid=directory.uid, modes=(0o600,), maximum_size=0)
            named = os.stat(self.name, dir_fd=directory.fd, follow_symlinks=False)
            if (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
                raise EvidencePumpError("evidence reservation pathname changed")
            self.device, self.inode = info.st_dev, info.st_ino
            header = _canonical_json(
                _header_payload(attempt_id, generation, retained_cap, observed_cap)
            )
            _write_all(self.fd, _MAGIC + _encode_frame(b"H", header))
            os.fsync(self.fd)
            os.fsync(directory.fd)
        except BaseException:
            self.seal_partial()
            raise

    @property
    def retained_total(self) -> int:
        return self.counts["stdout"] + self.counts["stderr"]

    def retained_metrics(self) -> dict[str, _Metric]:
        return {
            stream: _Metric(self.hashes[stream].hexdigest(), self.counts[stream])
            for stream in ("stdout", "stderr")
        }

    def _write_frame(self, kind: bytes, payload: bytes) -> None:
        if self.broken or self.fd < 0:
            raise EvidencePumpError("evidence writer is not publishable")
        try:
            _write_all(self.fd, _encode_frame(kind, payload))
        except BaseException:
            self.broken = True
            raise

    def append(self, stream: str, payload: bytes) -> None:
        if stream not in {"stdout", "stderr"} or not payload:
            raise EvidencePumpError("invalid retained evidence append")
        self.hashes[stream].update(payload)
        self.counts[stream] += len(payload)
        buffer = self.buffers[stream]
        buffer.extend(payload)
        kind = b"O" if stream == "stdout" else b"E"
        while len(buffer) >= _FRAME_DATA_MAX:
            frame = bytes(buffer[:_FRAME_DATA_MAX])
            del buffer[:_FRAME_DATA_MAX]
            self._write_frame(kind, frame)
            self.frame_count += 1
            if self.frame_count > _MAX_DATA_FRAMES:
                self.broken = True
                raise EvidencePumpError("evidence frame count exceeds bound")

    def finish(self, trailer: dict[str, object]) -> None:
        if self.broken or self.fd < 0:
            raise EvidencePumpError("partial evidence object cannot be published")
        try:
            for stream, kind in (("stdout", b"O"), ("stderr", b"E")):
                buffer = self.buffers[stream]
                if buffer:
                    self._write_frame(kind, bytes(buffer))
                    self.frame_count += 1
                    buffer.clear()
            if self.frame_count > _MAX_DATA_FRAMES:
                raise EvidencePumpError("evidence frame count exceeds bound")
            self._write_frame(b"T", _canonical_json(trailer))
            os.fsync(self.fd)
            os.fchmod(self.fd, 0o600)
            os.fsync(self.fd)
        except BaseException:
            self.broken = True
            raise
        finally:
            if self.fd >= 0:
                os.close(self.fd)
                self.fd = -1
        os.fsync(self.directory.fd)

    def seal_partial(self) -> None:
        if self.fd < 0:
            return
        try:
            try:
                os.fsync(self.fd)
                os.fchmod(self.fd, 0o600)
                os.fsync(self.fd)
            except OSError:
                pass
        finally:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = -1
        try:
            os.fsync(self.directory.fd)
        except OSError:
            pass


def _attempt_names(
    directory: _Directory,
    attempt_id: str,
    *,
    reserve_entries: int = 0,
) -> tuple[str, ...]:
    if reserve_entries < 0 or reserve_entries > _MAX_DIRECTORY_ENTRIES:
        raise EvidencePumpError("invalid directory entry reservation")
    prefix = f"{attempt_id}."
    names: list[str] = []
    scanned = 0
    try:
        with os.scandir(directory.fd) as entries:
            for entry in entries:
                scanned += 1
                if scanned + reserve_entries > _MAX_DIRECTORY_ENTRIES:
                    raise EvidencePumpError("raw_directory exceeds total entry bound")
                if entry.name.startswith(prefix):
                    names.append(entry.name)
                    if len(names) > _MAX_ATTEMPT_ENTRIES:
                        raise EvidencePumpError("attempt state exceeds entry bound")
    except OSError as exc:
        raise EvidencePumpError("cannot enumerate attempt state") from exc
    return tuple(sorted(names))


def _classify_name(attempt_id: str, name: str) -> tuple[str, Optional[str]]:
    escaped = re.escape(attempt_id)
    patterns = (
        ("lock", rf"{escaped}\.controller\.lock\Z"),
        ("evidence", rf"{escaped}\.([0-9a-f]{{32}})\.evidence\Z"),
        ("tombstone", rf"{escaped}\.([0-9a-f]{{32}})\.TOMBSTONE\Z"),
    )
    for kind, pattern in patterns:
        match = re.fullmatch(pattern, name)
        if match is not None:
            return kind, match.group(1) if match.lastindex else None
    raise EvidencePumpError("attempt residue has unknown name")


def _validate_existing_state(
    directory: _Directory,
    attempt_id: str,
    lock: _Lock,
    names: tuple[str, ...],
) -> None:
    valid: list[tuple[str, str, Optional[str], int]] = []
    invalid = False
    for name in names:
        try:
            kind, token = _classify_name(attempt_id, name)
            info = os.stat(name, dir_fd=directory.fd, follow_symlinks=False)
            if kind == "lock":
                _exact_regular(info, uid=directory.uid, modes=(0o400,), maximum_size=0)
                if (info.st_dev, info.st_ino) != (lock.device, lock.inode):
                    raise EvidencePumpError("residue lock is not held lock")
            elif kind == "evidence":
                _exact_regular(
                    info,
                    uid=directory.uid,
                    modes=(0o600,),
                    maximum_size=_MAX_OBJECT_BYTES,
                )
            else:
                _exact_regular(
                    info,
                    uid=directory.uid,
                    modes=(0o400,),
                    maximum_size=_MAX_MARKER_BYTES,
                )
            valid.append((name, kind, token, stat.S_IMODE(info.st_mode)))
        except (EvidencePumpError, OSError):
            invalid = True
    for name, kind, token, mode in valid:
        try:
            if kind == "evidence" and mode == 0o600:
                assert token is not None
                _authenticate_evidence(
                    directory,
                    lock,
                    name,
                    expected_attempt_id=attempt_id,
                    expected_generation=token,
                )
            elif kind == "tombstone":
                assert token is not None
                value = _parse_canonical_json(
                    _stable_read_regular(
                        directory, name, maximum_size=_MAX_MARKER_BYTES
                    )[0]
                )
                _validate_tombstone(value, attempt_id, token)
        except (EvidencePumpError, OSError):
            invalid = True
    if invalid:
        raise EvidencePumpError("attempt residue failed exact validation")


def _append_tombstone(
    directory: _Directory,
    attempt_id: str,
    lock: _Lock,
    reason: str,
) -> bool:
    try:
        _verify_directory(directory)
        _verify_lock(directory, lock)
        for name in _attempt_names(directory, attempt_id):
            try:
                kind, token = _classify_name(attempt_id, name)
            except EvidencePumpError:
                continue
            if kind != "tombstone":
                continue
            assert token is not None
            try:
                value = _parse_canonical_json(
                    _stable_read_regular(
                        directory, name, maximum_size=_MAX_MARKER_BYTES
                    )[0]
                )
                _validate_tombstone(value, attempt_id, token)
                return True
            except EvidencePumpError:
                continue
        # A new marker is an additional durable namespace entry.  Re-scan at
        # the write boundary so this helper cannot cross the directory cap.
        _attempt_names(directory, attempt_id, reserve_entries=1)
        token = _validated_generation(secrets.token_hex(16))
        name = f"{attempt_id}.{token}.TOMBSTONE"
        raw = _tombstone_payload(attempt_id, token, reason)
        _write_sealed_marker(directory, name, raw)
        persisted = _stable_read_regular(
            directory, name, maximum_size=_MAX_MARKER_BYTES
        )[0]
        _validate_tombstone(_parse_canonical_json(persisted), attempt_id, token)
        return True
    except BaseException:
        return False


def _receipt(
    *,
    attempt_id: Optional[str],
    generation: Optional[str],
    evidence_sha256: Optional[str],
    evidence_bytes: int,
    observed_hashes: dict[str, "hashlib._Hash"],
    observed_counts: dict[str, int],
    retained_metrics: dict[str, _Metric],
    eof: dict[str, bool],
    timed_out: bool,
    cancelled: bool,
    drain_limit_reached: bool,
    capture_started: bool,
    recovered_residue: bool,
    stop_status: _StopStatus,
    committed: bool,
    quarantined: bool,
    recovery_required: bool,
) -> EvidenceReceipt:
    overflowed = any(
        retained_metrics[stream].size < observed_counts[stream]
        for stream in ("stdout", "stderr")
    )
    return EvidenceReceipt(
        attempt_id=attempt_id,
        generation=generation,
        evidence_sha256=evidence_sha256,
        evidence_bytes=evidence_bytes,
        stdout_observed_sha256=observed_hashes["stdout"].hexdigest(),
        stderr_observed_sha256=observed_hashes["stderr"].hexdigest(),
        stdout_retained_sha256=retained_metrics["stdout"].digest,
        stderr_retained_sha256=retained_metrics["stderr"].digest,
        stdout_observed_bytes=observed_counts["stdout"],
        stderr_observed_bytes=observed_counts["stderr"],
        stdout_retained_bytes=retained_metrics["stdout"].size,
        stderr_retained_bytes=retained_metrics["stderr"].size,
        overflowed=overflowed,
        stdout_eof=eof["stdout"],
        stderr_eof=eof["stderr"],
        timed_out=timed_out,
        cancelled=cancelled,
        drain_limit_reached=drain_limit_reached,
        capture_started=capture_started,
        recovered_residue=recovered_residue,
        stop_callback_requested=stop_status.requested,
        stop_callback_completed=stop_status.completed,
        stop_callback_failed=stop_status.failed,
        stop_callback_timed_out=stop_status.timed_out,
        raw_evidence_committed=committed,
        raw_evidence_quarantined=quarantined,
        recovery_required=recovery_required,
    )


def _zero_receipt(
    *,
    attempt_id: Optional[str],
    generation: Optional[str],
    stop_status: _StopStatus,
    recovered_residue: bool,
) -> EvidenceReceipt:
    return _receipt(
        attempt_id=attempt_id,
        generation=generation,
        evidence_sha256=None,
        evidence_bytes=0,
        observed_hashes={"stdout": hashlib.sha256(), "stderr": hashlib.sha256()},
        observed_counts={"stdout": 0, "stderr": 0},
        retained_metrics={
            "stdout": _Metric(_EMPTY_SHA256, 0),
            "stderr": _Metric(_EMPTY_SHA256, 0),
        },
        eof={"stdout": False, "stderr": False},
        timed_out=False,
        cancelled=False,
        drain_limit_reached=False,
        capture_started=False,
        recovered_residue=recovered_residue,
        stop_status=stop_status,
        committed=False,
        quarantined=False,
        recovery_required=True,
    )


def _trailer_payload(
    attempt_id: str,
    generation: str,
    *,
    state: str,
    observed_hashes: dict[str, "hashlib._Hash"],
    observed_counts: dict[str, int],
    retained_metrics: dict[str, _Metric],
    eof: dict[str, bool],
    timed_out: bool,
    cancelled: bool,
    drain_limit_reached: bool,
    stop_status: _StopStatus,
) -> dict[str, object]:
    recovery_required = stop_status.requested or state == "QUARANTINED"
    value: dict[str, object] = {
        "attempt_id": attempt_id,
        "cancelled": cancelled,
        "drain_limit_reached": drain_limit_reached,
        "generation": generation,
        "overflowed": any(
            retained_metrics[stream].size < observed_counts[stream]
            for stream in ("stdout", "stderr")
        ),
        "recovery_required": recovery_required,
        "state": state,
        "stderr_eof": eof["stderr"],
        "stderr_observed_bytes": observed_counts["stderr"],
        "stderr_observed_sha256": observed_hashes["stderr"].hexdigest(),
        "stderr_retained_bytes": retained_metrics["stderr"].size,
        "stderr_retained_sha256": retained_metrics["stderr"].digest,
        "stdout_eof": eof["stdout"],
        "stdout_observed_bytes": observed_counts["stdout"],
        "stdout_observed_sha256": observed_hashes["stdout"].hexdigest(),
        "stdout_retained_bytes": retained_metrics["stdout"].size,
        "stdout_retained_sha256": retained_metrics["stdout"].digest,
        "stop_callback_completed": stop_status.completed,
        "stop_callback_failed": stop_status.failed,
        "stop_callback_requested": stop_status.requested,
        "stop_callback_timed_out": stop_status.timed_out,
        "timed_out": timed_out,
        "version": _VERSION,
    }
    if set(value) != _TRAILER_KEYS:
        raise EvidencePumpError("internal trailer schema mismatch")
    return value


def _receipt_from_parsed(parsed: _ParsedEvidence) -> EvidenceReceipt:
    # Authenticated receipt bindings come only from the exact framed object
    # parser; caller-supplied attempt or generation values never reach them.
    trailer = parsed.trailer
    observed_hashes = {
        "stdout": _FixedHash(str(trailer["stdout_observed_sha256"])),
        "stderr": _FixedHash(str(trailer["stderr_observed_sha256"])),
    }
    stop_status = _StopStatus(
        requested=bool(trailer["stop_callback_requested"]),
        completed=bool(trailer["stop_callback_completed"]),
        failed=bool(trailer["stop_callback_failed"]),
        timed_out=bool(trailer["stop_callback_timed_out"]),
        error=None,
    )
    return _receipt(
        attempt_id=parsed.attempt_id,
        generation=parsed.generation,
        evidence_sha256=parsed.object_sha256,
        evidence_bytes=parsed.object_bytes,
        observed_hashes=observed_hashes,
        observed_counts={
            "stdout": int(trailer["stdout_observed_bytes"]),
            "stderr": int(trailer["stderr_observed_bytes"]),
        },
        retained_metrics={
            "stdout": parsed.stdout_retained,
            "stderr": parsed.stderr_retained,
        },
        eof={
            "stdout": bool(trailer["stdout_eof"]),
            "stderr": bool(trailer["stderr_eof"]),
        },
        timed_out=bool(trailer["timed_out"]),
        cancelled=bool(trailer["cancelled"]),
        drain_limit_reached=bool(trailer["drain_limit_reached"]),
        capture_started=True,
        recovered_residue=False,
        stop_status=stop_status,
        committed=parsed.state == "COMMITTED",
        quarantined=parsed.state == "QUARANTINED",
        recovery_required=bool(trailer["recovery_required"]),
    )


class _FixedHash:
    def __init__(self, digest: str):
        self._digest = digest

    def hexdigest(self) -> str:
        return self._digest


def _capture(
    stdout_fd: int,
    stderr_fd: int,
    writer: _EvidenceWriter,
    *,
    retained_cap: int,
    observed_cap: int,
    timeout_seconds: float,
    drain_timeout_seconds: float,
    stop: _StopController,
    cancel_event: Optional[threading.Event],
) -> tuple[
    dict[str, "hashlib._Hash"],
    dict[str, int],
    dict[str, bool],
    bool,
    bool,
    bool,
    Optional[BaseException],
]:
    observed_hashes = {"stdout": hashlib.sha256(), "stderr": hashlib.sha256()}
    observed_counts = {"stdout": 0, "stderr": 0}
    eof = {"stdout": False, "stderr": False}
    observed_total = 0
    timed_out = False
    cancelled = False
    drain_limit_reached = False
    failure: Optional[BaseException] = None
    inputs: dict[str, int] = {}
    selector: Optional[selectors.BaseSelector] = None
    started_at = time.monotonic()
    drain_deadline: Optional[float] = None

    def request_stop() -> None:
        nonlocal drain_deadline
        stop.request()
        if drain_deadline is None:
            drain_deadline = time.monotonic() + drain_timeout_seconds

    try:
        inputs["stdout"] = os.dup(stdout_fd)
        inputs["stderr"] = os.dup(stderr_fd)
        for fd in inputs.values():
            os.set_blocking(fd, False)
        selector = selectors.DefaultSelector()
        for stream, fd in inputs.items():
            selector.register(fd, selectors.EVENT_READ, stream)
        while not (eof["stdout"] and eof["stderr"]):
            now = time.monotonic()
            if not timed_out and now - started_at >= timeout_seconds:
                timed_out = True
                request_stop()
            if (
                not cancelled
                and cancel_event is not None
                and threading.Event.is_set(cancel_event)
            ):
                cancelled = True
                request_stop()
            if drain_deadline is not None and now >= drain_deadline:
                drain_limit_reached = True
                break
            if drain_deadline is not None:
                wait = min(0.05, drain_deadline - now)
            else:
                wait = min(0.05, timeout_seconds - (now - started_at))
            if cancel_event is not None:
                wait = min(wait, _CANCEL_POLL_SECONDS)
            if wait <= 0:
                continue
            events = selector.select(wait)
            for key, _ in events:
                stream = key.data
                try:
                    chunk = os.read(key.fd, _READ_SIZE)
                except BlockingIOError:
                    continue
                if not chunk:
                    eof[stream] = True
                    selector.unregister(key.fd)
                    continue
                observed_room = observed_cap - observed_total
                observed_chunk = chunk[: max(0, observed_room)]
                if observed_chunk:
                    observed_hashes[stream].update(observed_chunk)
                    observed_counts[stream] += len(observed_chunk)
                    observed_total += len(observed_chunk)
                if len(observed_chunk) < len(chunk):
                    drain_limit_reached = True
                    request_stop()
                retained_room = retained_cap - writer.retained_total
                retained_chunk = observed_chunk[: max(0, retained_room)]
                if retained_chunk:
                    writer.append(stream, retained_chunk)
                if len(retained_chunk) < len(observed_chunk):
                    request_stop()
    except BaseException as exc:
        failure = exc
        request_stop()
    finally:
        if selector is not None:
            try:
                selector.close()
            except BaseException as exc:
                if failure is None:
                    failure = exc
                    request_stop()
        for fd in inputs.values():
            try:
                os.close(fd)
            except OSError:
                pass
    return (
        observed_hashes,
        observed_counts,
        eof,
        timed_out,
        cancelled,
        drain_limit_reached,
        failure,
    )


def _run_reserved_capture(
    stdout_fd: int,
    stderr_fd: int,
    *,
    directory: _Directory,
    lock: _Lock,
    writer: _EvidenceWriter,
    attempt_id: str,
    generation: str,
    retained_cap: int,
    observed_cap: int,
    timeout_seconds: float,
    drain_timeout_seconds: float,
    stop: _StopController,
    cancel_event: Optional[threading.Event],
) -> EvidenceReceipt:
    """Capture, publish, and authenticate or return one recovery-bound error."""

    observed_hashes = {"stdout": hashlib.sha256(), "stderr": hashlib.sha256()}
    observed_counts = {"stdout": 0, "stderr": 0}
    eof = {"stdout": False, "stderr": False}
    timed_out = False
    cancelled = False
    drain_limit_reached = False
    failure: Optional[BaseException] = None
    try:
        (
            observed_hashes,
            observed_counts,
            eof,
            timed_out,
            cancelled,
            drain_limit_reached,
            capture_failure,
        ) = _capture(
            stdout_fd,
            stderr_fd,
            writer,
            retained_cap=retained_cap,
            observed_cap=observed_cap,
            timeout_seconds=timeout_seconds,
            drain_timeout_seconds=drain_timeout_seconds,
            stop=stop,
            cancel_event=cancel_event,
        )
        status = stop.status(wait=True)
        callback_failure = status.failed or status.timed_out
        state = (
            "COMMITTED"
            if eof["stdout"]
            and eof["stderr"]
            and not timed_out
            and not cancelled
            and not drain_limit_reached
            and capture_failure is None
            and not callback_failure
            else "QUARANTINED"
        )
        retained_metrics = writer.retained_metrics()
        trailer = _trailer_payload(
            attempt_id,
            generation,
            state=state,
            observed_hashes=observed_hashes,
            observed_counts=observed_counts,
            retained_metrics=retained_metrics,
            eof=eof,
            timed_out=timed_out,
            cancelled=cancelled,
            drain_limit_reached=drain_limit_reached,
            stop_status=status,
        )
        if writer.broken:
            raise EvidencePumpError("evidence frame stream is partial")
        writer.finish(trailer)
        if set(_attempt_names(directory, attempt_id)) != {lock.name, writer.name}:
            raise EvidencePumpError("unexpected attempt state before authentication")
        directory_fingerprint = _metadata_fingerprint(os.fstat(directory.fd))
        lock_fingerprint = _metadata_fingerprint(os.fstat(lock.fd))
        parsed = _authenticate_evidence(
            directory,
            lock,
            writer.name,
            expected_attempt_id=attempt_id,
            expected_generation=generation,
            expected_identity=(writer.device, writer.inode),
        )
        if parsed.trailer != trailer or parsed.state != state:
            raise EvidencePumpError("authenticated trailer diverges from capture")
        if parsed.header != _header_payload(
            attempt_id, generation, retained_cap, observed_cap
        ):
            raise EvidencePumpError("authenticated header diverges from capture")
        _verify_final_publication_state(
            directory,
            lock,
            attempt_id=attempt_id,
            evidence_name=writer.name,
            evidence_identity=(writer.device, writer.inode),
            evidence_fingerprint=parsed.object_fingerprint,
            directory_fingerprint=directory_fingerprint,
            lock_fingerprint=lock_fingerprint,
        )
        receipt = _receipt_from_parsed(parsed)
        if capture_failure is not None:
            raise EvidencePumpError(
                "evidence capture failed", receipt=receipt
            ) from capture_failure
        if status.failed:
            raise EvidencePumpError("stop callback failed", receipt=receipt)
        if status.timed_out:
            raise EvidencePumpError("stop callback timed out", receipt=receipt)
        return receipt
    except EvidencePumpError as exc:
        if exc.receipt is not None:
            raise
        failure = exc
    except BaseException as exc:
        failure = exc

    try:
        stop.request()
    except BaseException:
        pass
    try:
        writer.seal_partial()
    except BaseException:
        pass
    try:
        _append_tombstone(directory, attempt_id, lock, "PUBLICATION_FAILED")
    except BaseException:
        pass
    try:
        status = stop.status(wait=True)
    except BaseException as exc:
        status = _StopStatus(True, False, True, False, exc)
    empty_metrics = {
        "stdout": _Metric(_EMPTY_SHA256, 0),
        "stderr": _Metric(_EMPTY_SHA256, 0),
    }
    receipt = _receipt(
        attempt_id=attempt_id,
        generation=generation,
        evidence_sha256=None,
        evidence_bytes=0,
        observed_hashes=observed_hashes,
        observed_counts=observed_counts,
        retained_metrics=empty_metrics,
        eof=eof,
        timed_out=timed_out,
        cancelled=cancelled,
        drain_limit_reached=drain_limit_reached,
        capture_started=True,
        recovered_residue=False,
        stop_status=status,
        committed=False,
        quarantined=False,
        recovery_required=True,
    )
    raise EvidencePumpError(
        "evidence object processing failed", receipt=receipt
    ) from failure


def pump_evidence(
    stdout_fd: int,
    stderr_fd: int,
    *,
    raw_directory: Path,
    attempt_id: str,
    retained_byte_cap: int,
    observed_byte_cap: int,
    timeout_seconds: float,
    drain_timeout_seconds: float,
    stop_callback_timeout_seconds: float,
    stop_callback: Callable[[], None],
    cancel_event: Optional[threading.Event] = None,
) -> EvidenceReceipt:
    """Capture one trusted, controller-derived, single-use attempt."""

    if not callable(stop_callback):
        raise EvidencePumpError("stop_callback must be callable")
    try:
        stop_timeout = _bounded_seconds(
            stop_callback_timeout_seconds,
            label="stop_callback_timeout_seconds",
            maximum=_MAX_STOP_CALLBACK_SECONDS,
        )
    except EvidencePumpError as exc:
        fallback = _StopController(stop_callback, _FALLBACK_STOP_CALLBACK_SECONDS)
        fallback.request()
        receipt = _zero_receipt(
            attempt_id=None,
            generation=None,
            stop_status=fallback.status(wait=True),
            recovered_residue=False,
        )
        raise EvidencePumpError(str(exc), receipt=receipt) from exc

    stop = _StopController(stop_callback, stop_timeout)
    directory: Optional[_Directory] = None
    lock: Optional[_Lock] = None
    writer: Optional[_EvidenceWriter] = None
    stdout = -1
    stderr = -1
    try:
        try:
            attempt = _validated_attempt_id(attempt_id)
            stdout, stdout_identity = _admit_input_fd(stdout_fd, "stdout_fd")
            stderr, stderr_identity = _admit_input_fd(stderr_fd, "stderr_fd")
            if stdout_identity == stderr_identity:
                raise EvidencePumpError("stdout_fd and stderr_fd must be distinct streams")
            retained_cap = _bounded_integer(
                retained_byte_cap,
                label="retained_byte_cap",
                minimum=0,
                maximum=_MAX_RETAINED_BYTES,
            )
            observed_cap = _bounded_integer(
                observed_byte_cap,
                label="observed_byte_cap",
                minimum=1,
                maximum=_MAX_OBSERVED_BYTES,
            )
            if observed_cap < retained_cap:
                raise EvidencePumpError("observed_byte_cap must cover retained_byte_cap")
            run_timeout = _bounded_seconds(
                timeout_seconds,
                label="timeout_seconds",
                maximum=_MAX_TIMEOUT_SECONDS,
            )
            drain_timeout = _bounded_seconds(
                drain_timeout_seconds,
                label="drain_timeout_seconds",
                maximum=_MAX_DRAIN_TIMEOUT_SECONDS,
            )
            if cancel_event is not None and type(cancel_event) is not threading.Event:
                raise EvidencePumpError("cancel_event must be an exact threading.Event")
            directory = _open_owned_directory(raw_directory)
            # Bound the entire controller-provided namespace before creating an
            # attempt artifact; nonmatching names must not make discovery unbounded.
            _attempt_names(directory, attempt, reserve_entries=3)
            lock = _open_attempt_lock(directory, attempt)
            names = _attempt_names(directory, attempt)
        except BaseException as exc:
            stop.request()
            status = stop.status(wait=True)
            recovered = lock is not None
            if directory is not None and "attempt" in locals():
                try:
                    recovered = recovered or bool(_attempt_names(directory, attempt))
                except EvidencePumpError:
                    recovered = True
            receipt = _zero_receipt(
                attempt_id=None,
                generation=None,
                stop_status=status,
                recovered_residue=recovered,
            )
            if isinstance(exc, EvidencePumpError):
                raise EvidencePumpError(str(exc), receipt=receipt) from exc
            raise EvidencePumpError("evidence preflight failed", receipt=receipt) from exc

        assert directory is not None and lock is not None
        residue = (not lock.created) or any(name != lock.name for name in names)
        if residue:
            stop.request()
            try:
                _validate_existing_state(directory, attempt, lock, names)
            except BaseException:
                pass
            _append_tombstone(directory, attempt, lock, "RESIDUE_DETECTED")
            status = stop.status(wait=True)
            receipt = _zero_receipt(
                attempt_id=None,
                generation=None,
                stop_status=status,
                recovered_residue=True,
            )
            raise EvidencePumpError(
                "single-use attempt already has evidence residue", receipt=receipt
            )

        generation: Optional[str] = None
        try:
            generation = _validated_generation(secrets.token_hex(16))
            _verify_directory(directory)
            _verify_lock(directory, lock)
            writer = _EvidenceWriter(
                directory,
                attempt,
                generation,
                retained_cap,
                observed_cap,
            )
            if set(_attempt_names(directory, attempt)) != {lock.name, writer.name}:
                raise EvidencePumpError("unexpected state after evidence reservation")
        except BaseException as exc:
            stop.request()
            if writer is not None:
                writer.seal_partial()
            _append_tombstone(directory, attempt, lock, "PUBLICATION_FAILED")
            status = stop.status(wait=True)
            receipt = _zero_receipt(
                attempt_id=attempt if generation is not None else None,
                generation=generation,
                stop_status=status,
                recovered_residue=False,
            )
            raise EvidencePumpError("evidence reservation failed", receipt=receipt) from exc

        assert generation is not None
        return _run_reserved_capture(
            stdout,
            stderr,
            directory=directory,
            lock=lock,
            writer=writer,
            attempt_id=attempt,
            generation=generation,
            retained_cap=retained_cap,
            observed_cap=observed_cap,
            timeout_seconds=run_timeout,
            drain_timeout_seconds=drain_timeout,
            stop=stop,
            cancel_event=cancel_event,
        )
    finally:
        for admitted_fd in (stdout, stderr):
            if admitted_fd >= 0:
                try:
                    os.close(admitted_fd)
                except OSError:
                    pass
        if writer is not None:
            writer.seal_partial()
        if lock is not None:
            try:
                os.close(lock.fd)
            except OSError:
                pass
        if directory is not None:
            try:
                os.close(directory.fd)
            except OSError:
                pass
