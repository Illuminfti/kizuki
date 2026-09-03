"""Inert, private byte capture for a future supervised harness process.

This module consumes already-open output pipes. It never starts, signals, or
otherwise controls a process and is not wired to the controller service. Raw
bytes are written only to fresh private files; the returned receipt is an
in-memory, sanitized summary and is deliberately not persisted here.
"""
from __future__ import annotations

from dataclasses import dataclass
import errno
import hashlib
import math
import os
import re
import selectors
import stat
import time
from typing import Callable, Mapping, Protocol, cast


_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
_MAX_SECONDS = 60 * 60
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


@dataclass(frozen=True)
class BoundedOutputSpec:
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    task_spec_sha256: str
    raw_directory: str
    stdout_max_bytes: int
    stderr_max_bytes: int
    combined_max_bytes: int
    wall_seconds: float
    idle_seconds: float

    def __post_init__(self) -> None:
        for identity in (self.campaign_id, self.task_id):
            if type(identity) is not str or not _ID.fullmatch(identity):
                raise OutputCaptureError("INVALID_CAPTURE_IDENTITY")
        if any(
            type(value) is not int or not 1 <= value <= (2**63 - 1)
            for value in (self.attempt, self.controller_epoch)
        ):
            raise OutputCaptureError("INVALID_CAPTURE_FENCE")
        if type(self.task_spec_sha256) is not str or not _HEX64.fullmatch(
            self.task_spec_sha256
        ):
            raise OutputCaptureError("INVALID_TASK_SPEC_DIGEST")
        if not _is_canonical_absolute_path(self.raw_directory):
            raise OutputCaptureError("INVALID_OUTPUT_PATH")
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
        for seconds in (self.wall_seconds, self.idle_seconds):
            valid_integer = type(seconds) is int and 0 < seconds <= _MAX_SECONDS
            valid_float = (
                type(seconds) is float
                and math.isfinite(seconds)
                and 0 < seconds <= _MAX_SECONDS
            )
            if not (valid_integer or valid_float):
                raise OutputCaptureError("INVALID_OUTPUT_TIME_BUDGET")


@dataclass(frozen=True)
class OutputCaptureReceipt:
    schema: str
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    task_spec_sha256: str
    outcome: str
    reason_code: str
    stdout_bytes: int
    stderr_bytes: int
    combined_bytes: int
    stdout_sha256: str
    stderr_sha256: str


def _is_canonical_absolute_path(path: object) -> bool:
    if type(path) is not str or not path.startswith("/") or len(path) > 4096:
        return False
    if path == "/" or "\0" in path:
        return False
    return all(part not in ("", ".", "..") for part in path.split("/")[1:])


def _close_safely(descriptor: int) -> None:
    try:
        os.close(descriptor)
    except OSError:
        pass


def _stream_fd(stream: object) -> int:
    try:
        value = stream if type(stream) is int else stream.fileno()  # type: ignore[attr-defined]
    except Exception:
        raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None
    if type(value) is not int or value < 0:
        raise _CaptureFailure("OUTPUT_STREAM_INVALID")
    return value


def _open_private_directory(path: str) -> tuple[int, os.stat_result]:
    """Open every absolute path component with O_NOFOLLOW and pin the leaf."""
    flags = (
        os.O_RDONLY
        | os.O_DIRECTORY
        | os.O_CLOEXEC
        | os.O_NOFOLLOW
    )
    descriptor = -1
    try:
        descriptor = os.open("/", flags)
        for component in path.split("/")[1:]:
            child = os.open(component, flags, dir_fd=descriptor)
            _close_safely(descriptor)
            descriptor = child
        info = os.fstat(descriptor)
    except OSError as exc:
        if descriptor >= 0:
            _close_safely(descriptor)
        reason = (
            "OUTPUT_PATH_UNSAFE"
            if exc.errno in (errno.ELOOP, errno.ENOTDIR)
            else "OUTPUT_DIRECTORY_UNAVAILABLE"
        )
        raise _CaptureFailure(reason) from None
    if (
        not stat.S_ISDIR(info.st_mode)
        or info.st_uid != os.geteuid()
        or stat.S_IMODE(info.st_mode) != 0o700
    ):
        _close_safely(descriptor)
        raise _CaptureFailure("OUTPUT_PATH_UNSAFE")
    return descriptor, info


def _create_private_file(directory_fd: int, name: str) -> tuple[int, os.stat_result]:
    flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | os.O_CLOEXEC
        | os.O_NOFOLLOW
    )
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


def _directory_is_current(path: str, expected: os.stat_result) -> bool:
    descriptor = -1
    try:
        descriptor, current = _open_private_directory(path)
        return (current.st_dev, current.st_ino) == (expected.st_dev, expected.st_ino)
    except _CaptureFailure:
        return False
    finally:
        if descriptor >= 0:
            _close_safely(descriptor)


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
    if not math.isfinite(result):
        raise _CaptureFailure("CLOCK_ERROR")
    if previous is not None and result < previous:
        raise _CaptureFailure("CLOCK_ERROR")
    return result


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
    counts: Mapping[str, int],
    hashes: Mapping[str, _Digest],
    failure_reason: str | None,
) -> OutputCaptureReceipt:
    return OutputCaptureReceipt(
        schema="kizuki-gauntlet-output-capture-v1",
        campaign_id=spec.campaign_id,
        task_id=spec.task_id,
        attempt=spec.attempt,
        controller_epoch=spec.controller_epoch,
        task_spec_sha256=spec.task_spec_sha256,
        outcome="FAILED" if failure_reason is not None else "CAPTURED",
        reason_code="OK" if failure_reason is None else failure_reason,
        stdout_bytes=counts["stdout"],
        stderr_bytes=counts["stderr"],
        combined_bytes=counts["stdout"] + counts["stderr"],
        stdout_sha256=hashes["stdout"].hexdigest(),
        stderr_sha256=hashes["stderr"].hexdigest(),
    )


def capture_bounded_output(
    spec: BoundedOutputSpec,
    stdout: object,
    stderr: object,
    *,
    terminate: Callable[[str], object] | None = None,
    cancelled: Callable[[], object] | None = None,
    clock: Callable[[], object] | None = None,
    write_fn: Callable[[int, bytes], object] | None = None,
) -> OutputCaptureReceipt:
    """Concurrently drain two output pipes into fresh, pinned private files.

    On any runtime failure the optional ``terminate`` callback is invoked once
    with a public reason code. Callback diagnostics are never propagated.
    """
    if type(spec) is not BoundedOutputSpec:
        raise OutputCaptureError("BOUNDED_OUTPUT_SPEC_REQUIRED")
    for value, reason in (
        (terminate, "INVALID_TERMINATION_CALLBACK"),
        (cancelled, "INVALID_CANCELLATION_CALLBACK"),
        (clock, "INVALID_CLOCK_CALLBACK"),
        (write_fn, "INVALID_WRITE_CALLBACK"),
    ):
        if value is not None and not callable(value):
            raise OutputCaptureError(reason)

    monotonic = time.monotonic if clock is None else clock
    writer = os.write if write_fn is None else write_fn
    hashes: dict[str, _Digest] = {
        "stdout": hashlib.sha256(),
        "stderr": hashlib.sha256(),
    }
    counts = {"stdout": 0, "stderr": 0}
    failure_reason: str | None = None
    termination_requested = False
    directory_fd = -1
    directory_identity: os.stat_result | None = None
    output_files = {"stdout": -1, "stderr": -1}
    output_identities: dict[str, os.stat_result] = {}
    source_duplicates: list[int] = []
    source_blocking: dict[int, bool] = {}
    selector: selectors.BaseSelector | None = None

    def request_termination(reason_code: str) -> None:
        nonlocal termination_requested
        if termination_requested:
            return
        termination_requested = True
        if terminate is None:
            return
        try:
            terminate(reason_code)
        except Exception:
            # External process diagnostics may contain private data.
            pass

    def fail(reason_code: str) -> None:
        nonlocal failure_reason
        if failure_reason is None:
            failure_reason = reason_code
            request_termination(reason_code)

    try:
        started_at = _clock_sample(monotonic)
        wall_deadline = started_at + spec.wall_seconds
        if not math.isfinite(wall_deadline):
            raise _CaptureFailure("CLOCK_ERROR")
        previous_clock = started_at
        last_activity = started_at

        def write_checkpoint() -> float:
            nonlocal previous_clock
            checked_at = _clock_sample(monotonic, previous_clock)
            previous_clock = checked_at
            if checked_at >= wall_deadline:
                raise _CaptureFailure("WALL_TIMEOUT")
            if cancelled is not None:
                try:
                    is_cancelled = cancelled()
                except Exception:
                    raise _CaptureFailure("CANCELLATION_CHECK_ERROR") from None
                if type(is_cancelled) is not bool:
                    raise _CaptureFailure("CANCELLATION_CHECK_ERROR")
                if is_cancelled:
                    raise _CaptureFailure("CANCELLED")
            return checked_at

        stdout_source = _stream_fd(stdout)
        stderr_source = _stream_fd(stderr)
        if stdout_source == stderr_source:
            raise _CaptureFailure("OUTPUT_STREAM_INVALID")

        source_identities: list[os.stat_result] = []
        for source in (stdout_source, stderr_source):
            try:
                duplicate = os.dup(source)
                source_duplicates.append(duplicate)
                info = os.fstat(duplicate)
                if not (stat.S_ISFIFO(info.st_mode) or stat.S_ISSOCK(info.st_mode)):
                    raise _CaptureFailure("OUTPUT_STREAM_INVALID")
                source_blocking[duplicate] = os.get_blocking(duplicate)
                source_identities.append(info)
            except _CaptureFailure:
                raise
            except Exception:
                raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None
        first_info, second_info = source_identities
        if (first_info.st_dev, first_info.st_ino) == (second_info.st_dev, second_info.st_ino):
            raise _CaptureFailure("OUTPUT_STREAM_INVALID")
        for duplicate in source_duplicates:
            try:
                os.set_blocking(duplicate, False)
            except Exception:
                raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None

        directory_fd, directory_identity = _open_private_directory(spec.raw_directory)
        for name in ("stdout", "stderr"):
            descriptor, identity = _create_private_file(directory_fd, name + ".bin")
            output_files[name] = descriptor
            output_identities[name] = identity

        selector = selectors.DefaultSelector()
        for descriptor, name in zip(source_duplicates, ("stdout", "stderr")):
            try:
                selector.register(descriptor, selectors.EVENT_READ, name)
            except Exception:
                raise _CaptureFailure("OUTPUT_STREAM_INVALID") from None

        while selector.get_map() and failure_reason is None:
            if cancelled is not None:
                try:
                    is_cancelled = cancelled()
                except Exception:
                    raise _CaptureFailure("CANCELLATION_CHECK_ERROR") from None
                if type(is_cancelled) is not bool:
                    raise _CaptureFailure("CANCELLATION_CHECK_ERROR")
                if is_cancelled:
                    raise _CaptureFailure("CANCELLED")

            now = _clock_sample(monotonic, previous_clock)
            previous_clock = now
            if now >= wall_deadline:
                raise _CaptureFailure("WALL_TIMEOUT")
            if now >= last_activity + spec.idle_seconds:
                raise _CaptureFailure("IDLE_TIMEOUT")
            wait_seconds = min(
                wall_deadline - now,
                last_activity + spec.idle_seconds - now,
                _MAX_SELECT_SECONDS,
            )
            try:
                ready = selector.select(wait_seconds)
            except Exception:
                raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None

            now = _clock_sample(monotonic, previous_clock)
            previous_clock = now
            if now >= wall_deadline:
                raise _CaptureFailure("WALL_TIMEOUT")
            if now >= last_activity + spec.idle_seconds:
                raise _CaptureFailure("IDLE_TIMEOUT")
            if cancelled is not None:
                try:
                    is_cancelled = cancelled()
                except Exception:
                    raise _CaptureFailure("CANCELLATION_CHECK_ERROR") from None
                if type(is_cancelled) is not bool:
                    raise _CaptureFailure("CANCELLATION_CHECK_ERROR")
                if is_cancelled:
                    raise _CaptureFailure("CANCELLED")

            for key, _ in ready:
                try:
                    block = os.read(key.fd, _READ_SIZE)
                except BlockingIOError:
                    continue
                except Exception:
                    raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None
                if not block:
                    try:
                        selector.unregister(key.fd)
                    except Exception:
                        raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None
                    try:
                        os.set_blocking(key.fd, source_blocking[key.fd])
                    except Exception:
                        raise _CaptureFailure("OUTPUT_STREAM_ERROR") from None
                    del source_blocking[key.fd]
                    _close_safely(key.fd)
                    source_duplicates.remove(key.fd)
                    continue

                stream = key.data
                stream_limit = (
                    spec.stdout_max_bytes if stream == "stdout" else spec.stderr_max_bytes
                )
                stream_remaining = stream_limit - counts[stream]
                combined_remaining = spec.combined_max_bytes - sum(counts.values())
                accepted = min(len(block), stream_remaining, combined_remaining)
                if accepted:
                    prefix = block[:accepted]
                    try:
                        activity_at = _write_all(
                            output_files[stream],
                            prefix,
                            writer,
                            write_checkpoint,
                        )
                    except _CaptureFailure as exc:
                        if exc.bytes_written:
                            stored = prefix[: exc.bytes_written]
                            hashes[stream].update(stored)
                            counts[stream] += exc.bytes_written
                        raise
                    hashes[stream].update(prefix)
                    counts[stream] += accepted
                    last_activity = activity_at
                if accepted != len(block):
                    reason = (
                        stream.upper() + "_LIMIT_EXCEEDED"
                        if stream_remaining <= combined_remaining
                        else "COMBINED_LIMIT_EXCEEDED"
                    )
                    raise _CaptureFailure(reason)
    except _CaptureFailure as exc:
        fail(exc.reason_code)
    except Exception:
        # Keep unexpected OS and selector diagnostics outside public surfaces.
        fail("OUTPUT_CAPTURE_INTERNAL_ERROR")
    finally:
        if selector is not None:
            try:
                selector.close()
            except Exception:
                fail("OUTPUT_STREAM_ERROR")

        if directory_fd >= 0:
            for name in ("stdout", "stderr"):
                descriptor = output_files[name]
                if descriptor < 0:
                    continue
                try:
                    os.fsync(descriptor)
                except OSError:
                    fail("OUTPUT_STORAGE_ERROR")
            try:
                os.fsync(directory_fd)
            except OSError:
                fail("OUTPUT_STORAGE_ERROR")
            for name in ("stdout", "stderr"):
                descriptor = output_files[name]
                if descriptor < 0:
                    continue
                expected = output_identities.get(name)
                if expected is None or not _file_is_current(
                    directory_fd,
                    name + ".bin",
                    descriptor,
                    expected,
                    counts[name],
                ):
                    fail("OUTPUT_PATH_CHANGED")
            if directory_identity is None or not _directory_is_current(
                spec.raw_directory, directory_identity
            ):
                fail("OUTPUT_PATH_CHANGED")

        for descriptor in source_duplicates:
            if descriptor in source_blocking:
                try:
                    os.set_blocking(descriptor, source_blocking[descriptor])
                except Exception:
                    fail("OUTPUT_STREAM_ERROR")
            _close_safely(descriptor)
        for descriptor in output_files.values():
            if descriptor >= 0:
                _close_safely(descriptor)
        if directory_fd >= 0:
            _close_safely(directory_fd)

    receipt = _make_receipt(spec, counts, hashes, failure_reason)
    if failure_reason is not None:
        raise OutputCaptureError(failure_reason, receipt) from None
    return receipt
