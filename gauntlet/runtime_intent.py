"""Private crash journal for one not-yet-projected semantic ledger event.

This module owns no protocol policy and no SQLite state.  It gives the durable
store a narrow filesystem seam: publish one exact event intent before touching
the append-only ledger, finish only a verified partial append, and retain the
intent until the trusted caller attests that the projection contains that
exact event.
"""
from __future__ import annotations

import base64
import binascii
import ctypes
import errno
import fcntl
import hashlib
import json
import math
import os
import stat
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


__all__ = (
    "IntentClearReceipt",
    "LedgerRecoveryReceipt",
    "PrefixProjectionProof",
    "ProjectionEventProof",
    "RuntimeIntent",
    "RuntimeIntentError",
    "RuntimeIntentJournal",
    "StagingDiscardReceipt",
)


_DOMAIN = "kizuki-gauntlet.runtime-intent.v1"
_VERSION = 1
_VACANT_STAGING_RECORD = (
    b'{"domain":"kizuki-gauntlet.runtime-intent-slot.v1",'
    b'"state":"VACANT","version":1}\n'
)
_ACTIVE_NAME = ".runtime-intent"
_STAGING_NAME = ".runtime-intent.staging"
_RETIRED_NAME = ".runtime-intent.retired"
_LEDGER_NAME = "events.jsonl"
_GENESIS = "0" * 64
_MAX_EVENT_LINE_BYTES = 1024 * 1024
_MAX_INTENT_BYTES = 2 * 1024 * 1024
_MAX_LEDGER_BYTES = 64 * 1024 * 1024
_MAX_LEDGER_EVENTS = 65_536
_MAX_JSON_DEPTH = 32
_MAX_EPOCH = (1 << 63) - 1
_CRASH_HOOK: Optional[Callable[[str], None]] = None


class RuntimeIntentError(RuntimeError):
    """The runtime intent or its filesystem boundary is not safely usable."""


@dataclass(frozen=True)
class RuntimeIntent:
    """An immutable, fully validated intent returned to the durable store."""

    event_line: bytes
    event_line_sha256: str
    event_hash: str
    event_sequence: int
    ledger_prefix_bytes: int
    ledger_prefix_sha256: str
    ledger_prefix_tip_hash: str
    ledger_prefix_event_count: int
    projection_sha256: str
    epoch: int
    record_sha256: str


@dataclass(frozen=True)
class LedgerRecoveryReceipt:
    """Content-free evidence that the exact intended event is durable."""

    intent_sha256: str
    event_line_sha256: str
    event_hash: str
    event_sequence: int
    ledger_bytes: int
    ledger_sha256: str
    ledger_tip_hash: str
    ledger_event_count: int
    appended_bytes: int
    already_complete: bool


@dataclass(frozen=True)
class ProjectionEventProof:
    """Trusted caller's bounded proof of the exact projected event."""

    event_line_sha256: str
    event_hash: str
    event_sequence: int
    epoch: int
    prior_projection_sha256: str
    projection_sha256: str


@dataclass(frozen=True)
class IntentClearReceipt:
    """Content-free evidence that an applied intent was cleared durably."""

    intent_sha256: str
    event_line_sha256: str
    event_hash: str
    event_sequence: int
    epoch: int
    projection_sha256: str
    already_absent: bool


@dataclass(frozen=True)
class PrefixProjectionProof:
    """Trusted caller's proof that no semantic append/projection occurred."""

    ledger_prefix_bytes: int
    ledger_prefix_sha256: str
    ledger_prefix_tip_hash: str
    ledger_prefix_event_count: int
    projection_sha256: str
    epoch: int


@dataclass(frozen=True)
class StagingDiscardReceipt:
    """Content-free evidence for explicit staging-residue disposition."""

    staging_sha256: Optional[str]
    staging_bytes: int
    ledger_prefix_sha256: str
    projection_sha256: str
    epoch: int
    already_absent: bool


@dataclass(frozen=True)
class _FileIdentity:
    device: int
    inode: int
    size: int
    mtime_ns: int
    ctime_ns: int


@dataclass(frozen=True)
class _IntentSlot:
    name: str
    label: str
    raw: Optional[bytes]
    identity: Optional[_FileIdentity]
    intent: Optional[RuntimeIntent]


@dataclass(frozen=True)
class _IntentSlots:
    active: _IntentSlot
    staging: _IntentSlot
    retired: _IntentSlot


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _same_file(left: _FileIdentity, right: _FileIdentity) -> bool:
    return (
        left.device, left.inode, left.size,
    ) == (
        right.device, right.inode, right.size,
    )


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError, UnicodeEncodeError) as exc:
        raise RuntimeIntentError("runtime intent is not canonical JSON") from exc


def _duplicate_rejector(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise RuntimeIntentError("runtime intent JSON contains a duplicate key")
        result[key] = value
    return result


def _reject_constant(_value: str) -> object:
    raise RuntimeIntentError("runtime intent JSON contains a non-finite number")


def _finite_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise RuntimeIntentError("runtime intent JSON contains a non-finite number")
    return parsed


def _check_depth(value: object, label: str) -> None:
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if depth > _MAX_JSON_DEPTH:
            raise RuntimeIntentError(f"{label} exceeds JSON depth bound")
        if isinstance(item, dict):
            pending.extend((nested, depth + 1) for nested in item.values())
        elif isinstance(item, list):
            pending.extend((nested, depth + 1) for nested in item)


def _strict_json(raw: bytes, *, label: str, maximum: int) -> object:
    if len(raw) > maximum:
        raise RuntimeIntentError(f"{label} exceeds byte bound")
    try:
        value = json.loads(
            raw.decode("ascii"), object_pairs_hook=_duplicate_rejector,
            parse_constant=_reject_constant, parse_float=_finite_float,
        )
    except RuntimeIntentError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError) as exc:
        raise RuntimeIntentError(f"{label} is malformed") from exc
    _check_depth(value, label)
    if _canonical(value) != raw:
        raise RuntimeIntentError(f"{label} is not canonical JSON")
    return value


def _hex_digest(value: object, label: str) -> str:
    if (not isinstance(value, str) or len(value) != 64
            or any(character not in "0123456789abcdef" for character in value)):
        raise RuntimeIntentError(f"invalid {label}")
    return value


def _bounded_integer(
    value: object, label: str, *, minimum: int = 0, maximum: int,
) -> int:
    if (isinstance(value, bool) or not isinstance(value, int)
            or not minimum <= value <= maximum):
        raise RuntimeIntentError(f"invalid {label}")
    return value


def _parse_event_line(line: bytes) -> dict[str, object]:
    if not isinstance(line, bytes):
        raise RuntimeIntentError("event line must be immutable bytes")
    if not line or len(line) > _MAX_EVENT_LINE_BYTES:
        raise RuntimeIntentError("event line exceeds byte bound")
    if not line.endswith(b"\n") or b"\n" in line[:-1]:
        raise RuntimeIntentError("event line must be one complete JSONL record")
    event = _strict_json(
        line[:-1], label="event line", maximum=_MAX_EVENT_LINE_BYTES - 1,
    )
    if not isinstance(event, dict) or set(event) != {
        "created_at", "hash", "payload", "prev", "type",
    }:
        raise RuntimeIntentError("event line envelope is not recognized")
    previous = _hex_digest(event["prev"], "event previous digest")
    event_hash = _hex_digest(event["hash"], "event digest")
    event_type = event["type"]
    created_at = event["created_at"]
    if (not isinstance(event_type, str) or not 1 <= len(event_type) <= 128
            or not event_type.isascii()
            or any(character not in "abcdefghijklmnopqrstuvwxyz0123456789._-"
                   for character in event_type)
            or not isinstance(event["payload"], dict)
            or isinstance(created_at, bool)
            or not isinstance(created_at, (int, float))
            or not math.isfinite(created_at) or created_at < 0):
        raise RuntimeIntentError("event line fields are not recognized")
    expected_hash = _sha256(_canonical({
        "created_at": created_at,
        "payload": event["payload"],
        "prev": previous,
        "type": event_type,
    }))
    if event_hash != expected_hash:
        raise RuntimeIntentError("event line digest is invalid")
    return event


def _validate_ledger_prefix(
    data: bytes, *, expected_bytes: int, expected_sha256: str,
    expected_tip_hash: str, expected_event_count: int,
) -> None:
    if len(data) != expected_bytes or _sha256(data) != expected_sha256:
        raise RuntimeIntentError("ledger does not match the exact intent prefix")
    if len(data) > _MAX_LEDGER_BYTES:
        raise RuntimeIntentError("ledger exceeds total byte bound")
    if data and not data.endswith(b"\n"):
        raise RuntimeIntentError("ledger intent prefix is not event-aligned")
    lines = data.splitlines(keepends=True)
    if len(lines) != expected_event_count:
        raise RuntimeIntentError("ledger intent prefix event count is invalid")
    previous = _GENESIS
    for line in lines:
        event = _parse_event_line(line)
        if event["prev"] != previous:
            raise RuntimeIntentError("ledger intent prefix hash chain is discontinuous")
        previous = str(event["hash"])
    if previous != expected_tip_hash:
        raise RuntimeIntentError("ledger intent prefix tip is invalid")


def _intent_record(intent: RuntimeIntent) -> dict[str, object]:
    return {
        "domain": _DOMAIN,
        "epoch": intent.epoch,
        "event": {
            "hash": intent.event_hash,
            "line_base64": base64.b64encode(intent.event_line).decode("ascii"),
            "line_sha256": intent.event_line_sha256,
            "sequence": intent.event_sequence,
        },
        "ledger_prefix": {
            "bytes": intent.ledger_prefix_bytes,
            "event_count": intent.ledger_prefix_event_count,
            "sha256": intent.ledger_prefix_sha256,
            "tip_hash": intent.ledger_prefix_tip_hash,
        },
        "projection_sha256": intent.projection_sha256,
        "version": _VERSION,
    }


def _validate_intent_values(
    *, event_line: bytes, event_hash: object, event_sequence: object,
    ledger_prefix_bytes: object, ledger_prefix_sha256: object,
    ledger_prefix_tip_hash: object, ledger_prefix_event_count: object,
    projection_sha256: object, epoch: object,
) -> RuntimeIntent:
    event = _parse_event_line(event_line)
    checked_event_hash = _hex_digest(event_hash, "event digest")
    if checked_event_hash != event["hash"]:
        raise RuntimeIntentError("event digest does not match event line")
    sequence = _bounded_integer(
        event_sequence, "event sequence", minimum=1,
        maximum=_MAX_LEDGER_EVENTS,
    )
    prefix_bytes = _bounded_integer(
        ledger_prefix_bytes, "ledger prefix bytes", maximum=_MAX_LEDGER_BYTES,
    )
    prefix_count = _bounded_integer(
        ledger_prefix_event_count, "ledger prefix event count",
        maximum=_MAX_LEDGER_EVENTS - 1,
    )
    if sequence != prefix_count + 1:
        raise RuntimeIntentError("event sequence does not follow ledger prefix")
    if prefix_bytes + len(event_line) > _MAX_LEDGER_BYTES:
        raise RuntimeIntentError("event would exceed ledger byte bound")
    prefix_sha = _hex_digest(ledger_prefix_sha256, "ledger prefix digest")
    prefix_tip = _hex_digest(ledger_prefix_tip_hash, "ledger prefix tip")
    if event["prev"] != prefix_tip:
        raise RuntimeIntentError("event does not extend ledger prefix tip")
    projection_sha = _hex_digest(projection_sha256, "projection digest")
    checked_epoch = _bounded_integer(
        epoch, "controller epoch", minimum=1, maximum=_MAX_EPOCH,
    )
    if prefix_count == 0 and (
        prefix_bytes != 0 or prefix_sha != _sha256(b"") or prefix_tip != _GENESIS
    ):
        raise RuntimeIntentError("empty ledger prefix metadata is inconsistent")
    line_sha = _sha256(event_line)
    temporary = RuntimeIntent(
        event_line=event_line,
        event_line_sha256=line_sha,
        event_hash=checked_event_hash,
        event_sequence=sequence,
        ledger_prefix_bytes=prefix_bytes,
        ledger_prefix_sha256=prefix_sha,
        ledger_prefix_tip_hash=prefix_tip,
        ledger_prefix_event_count=prefix_count,
        projection_sha256=projection_sha,
        epoch=checked_epoch,
        record_sha256="",
    )
    encoded = _canonical(_intent_record(temporary)) + b"\n"
    if len(encoded) > _MAX_INTENT_BYTES:
        raise RuntimeIntentError("runtime intent exceeds byte bound")
    return RuntimeIntent(
        **{**temporary.__dict__, "record_sha256": _sha256(encoded)}
    )


def _parse_intent_record(raw: bytes) -> RuntimeIntent:
    if not raw or len(raw) > _MAX_INTENT_BYTES or not raw.endswith(b"\n"):
        raise RuntimeIntentError("runtime intent must be one bounded record")
    if b"\n" in raw[:-1]:
        raise RuntimeIntentError("runtime intent must be one bounded record")
    record = _strict_json(
        raw[:-1], label="runtime intent", maximum=_MAX_INTENT_BYTES - 1,
    )
    if not isinstance(record, dict) or set(record) != {
        "domain", "epoch", "event", "ledger_prefix", "projection_sha256",
        "version",
    }:
        raise RuntimeIntentError("runtime intent envelope is not recognized")
    if record["domain"] != _DOMAIN or record["version"] != _VERSION:
        raise RuntimeIntentError("runtime intent schema is not recognized")
    event = record["event"]
    prefix = record["ledger_prefix"]
    if (not isinstance(event, dict) or set(event) != {
            "hash", "line_base64", "line_sha256", "sequence",
        } or not isinstance(prefix, dict) or set(prefix) != {
            "bytes", "event_count", "sha256", "tip_hash",
        }):
        raise RuntimeIntentError("runtime intent fields are not recognized")
    encoded_line = event["line_base64"]
    if not isinstance(encoded_line, str) or not encoded_line.isascii():
        raise RuntimeIntentError("runtime intent event encoding is invalid")
    try:
        line = base64.b64decode(encoded_line.encode("ascii"), validate=True)
    except (ValueError, binascii.Error) as exc:
        raise RuntimeIntentError("runtime intent event encoding is invalid") from exc
    if base64.b64encode(line).decode("ascii") != encoded_line:
        raise RuntimeIntentError("runtime intent event encoding is not canonical")
    intent = _validate_intent_values(
        event_line=line,
        event_hash=event["hash"],
        event_sequence=event["sequence"],
        ledger_prefix_bytes=prefix["bytes"],
        ledger_prefix_sha256=prefix["sha256"],
        ledger_prefix_tip_hash=prefix["tip_hash"],
        ledger_prefix_event_count=prefix["event_count"],
        projection_sha256=record["projection_sha256"],
        epoch=record["epoch"],
    )
    if event["line_sha256"] != intent.event_line_sha256:
        raise RuntimeIntentError("runtime intent event line digest is invalid")
    if intent.record_sha256 != _sha256(raw):
        raise RuntimeIntentError("runtime intent record digest is invalid")
    return intent


def _revalidate_intent(intent: object) -> RuntimeIntent:
    if not isinstance(intent, RuntimeIntent):
        raise RuntimeIntentError("a validated runtime intent is required")
    try:
        raw = _canonical(_intent_record(intent)) + b"\n"
    except (AttributeError, TypeError) as exc:
        raise RuntimeIntentError("a validated runtime intent is required") from exc
    parsed = _parse_intent_record(raw)
    if parsed != intent:
        raise RuntimeIntentError("runtime intent fields are inconsistent")
    return parsed


def _validate_projection_proof(
    intent: RuntimeIntent, proof: object,
) -> ProjectionEventProof:
    if not isinstance(proof, ProjectionEventProof):
        raise RuntimeIntentError("an exact projection proof is required")
    line_sha = _hex_digest(proof.event_line_sha256, "projection proof event line")
    event_hash = _hex_digest(proof.event_hash, "projection proof event")
    sequence = _bounded_integer(
        proof.event_sequence, "projection proof event sequence", minimum=1,
        maximum=_MAX_LEDGER_EVENTS,
    )
    epoch = _bounded_integer(
        proof.epoch, "projection proof epoch", minimum=1, maximum=_MAX_EPOCH,
    )
    prior = _hex_digest(
        proof.prior_projection_sha256, "projection proof prior projection",
    )
    projection = _hex_digest(
        proof.projection_sha256, "projection proof projection",
    )
    if (
        line_sha != intent.event_line_sha256
        or event_hash != intent.event_hash
        or sequence != intent.event_sequence
        or epoch != intent.epoch
        or prior != intent.projection_sha256
    ):
        raise RuntimeIntentError("projection proof does not match runtime intent")
    if projection == prior:
        raise RuntimeIntentError("projection proof digest must change")
    return ProjectionEventProof(
        event_line_sha256=line_sha,
        event_hash=event_hash,
        event_sequence=sequence,
        epoch=epoch,
        prior_projection_sha256=prior,
        projection_sha256=projection,
    )


def _validate_prefix_proof(proof: object) -> PrefixProjectionProof:
    if not isinstance(proof, PrefixProjectionProof):
        raise RuntimeIntentError("an exact prefix and projection proof is required")
    prefix_bytes = _bounded_integer(
        proof.ledger_prefix_bytes, "proof ledger prefix bytes",
        maximum=_MAX_LEDGER_BYTES,
    )
    prefix_sha = _hex_digest(
        proof.ledger_prefix_sha256, "proof ledger prefix digest",
    )
    prefix_tip = _hex_digest(
        proof.ledger_prefix_tip_hash, "proof ledger prefix tip",
    )
    prefix_count = _bounded_integer(
        proof.ledger_prefix_event_count, "proof ledger prefix event count",
        maximum=_MAX_LEDGER_EVENTS,
    )
    projection_sha = _hex_digest(
        proof.projection_sha256, "proof projection digest",
    )
    epoch = _bounded_integer(
        proof.epoch, "proof controller epoch", minimum=1, maximum=_MAX_EPOCH,
    )
    if prefix_count == 0 and (
        prefix_bytes != 0 or prefix_sha != _sha256(b"") or prefix_tip != _GENESIS
    ):
        raise RuntimeIntentError("prefix and projection proof is inconsistent")
    return PrefixProjectionProof(
        ledger_prefix_bytes=prefix_bytes,
        ledger_prefix_sha256=prefix_sha,
        ledger_prefix_tip_hash=prefix_tip,
        ledger_prefix_event_count=prefix_count,
        projection_sha256=projection_sha,
        epoch=epoch,
    )


def _rename_no_replace(directory_fd: int, source: str, destination: str) -> None:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = libc.renameat2
    except (AttributeError, OSError) as exc:
        raise RuntimeIntentError("atomic no-replace activation is unavailable") from exc
    renameat2.argtypes = (
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameat2.restype = ctypes.c_int
    result = renameat2(
        directory_fd, os.fsencode(source), directory_fd,
        os.fsencode(destination), 1,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        if error_number == errno.EEXIST:
            raise RuntimeIntentError("an active runtime intent already exists")
        raise RuntimeIntentError("runtime intent cannot be activated atomically") from OSError(
            error_number, os.strerror(error_number), destination,
        )


def _rename_exchange(directory_fd: int, left: str, right: str) -> None:
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        renameat2 = libc.renameat2
    except (AttributeError, OSError) as exc:
        raise RuntimeIntentError("atomic intent-slot exchange is unavailable") from exc
    renameat2.argtypes = (
        ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p,
        ctypes.c_uint,
    )
    renameat2.restype = ctypes.c_int
    result = renameat2(
        directory_fd, os.fsencode(left), directory_fd, os.fsencode(right), 2,
    )
    if result != 0:
        error_number = ctypes.get_errno()
        raise RuntimeIntentError("runtime intent slots cannot be exchanged atomically") from OSError(
            error_number, os.strerror(error_number), right,
        )


class RuntimeIntentJournal:
    """An anchored handle for one private runtime append intent."""

    def __init__(self, state_dir: str | os.PathLike[str]):
        supplied = Path(state_dir)
        if not supplied.is_absolute():
            raise RuntimeIntentError("state directory must be an absolute canonical path")
        try:
            canonical = supplied.resolve(strict=True)
            named = os.lstat(supplied)
        except OSError as exc:
            raise RuntimeIntentError("state directory is unavailable") from exc
        if canonical != supplied:
            raise RuntimeIntentError("state directory must be an absolute canonical path")
        if (not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
                or named.st_uid != os.geteuid()
                or stat.S_IMODE(named.st_mode) != 0o700):
            raise RuntimeIntentError(
                "state directory must be an owned real mode-0700 directory"
            )
        flags = (
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        )
        try:
            self._root_fd = os.open(supplied, flags)
        except OSError as exc:
            raise RuntimeIntentError("state directory cannot be anchored safely") from exc
        anchored = os.fstat(self._root_fd)
        if ((anchored.st_dev, anchored.st_ino) != (named.st_dev, named.st_ino)
                or not stat.S_ISDIR(anchored.st_mode)
                or anchored.st_uid != os.geteuid()
                or stat.S_IMODE(anchored.st_mode) != 0o700):
            os.close(self._root_fd)
            raise RuntimeIntentError("state directory changed while being anchored")
        self.root = canonical
        self._root_identity = (anchored.st_dev, anchored.st_ino)
        self._owner_pid = os.getpid()
        self._writer_lock_fd: Optional[int] = None
        self._controller_lock_fd: Optional[int] = None
        self._writer_lock_identity: Optional[_FileIdentity] = None
        self._controller_lock_identity: Optional[_FileIdentity] = None
        self._closed = False
        try:
            self._named_identity(_ACTIVE_NAME, required=False, label="runtime intent")
            self._named_identity(
                _STAGING_NAME, required=False, label="runtime intent staging file",
            )
            self._named_identity(
                _RETIRED_NAME, required=False, label="retired runtime intent",
            )
        except BaseException:
            os.close(self._root_fd)
            self._closed = True
            raise

    @classmethod
    def _from_locked_fds(
        cls, state_dir: str | os.PathLike[str], *, writer_lock_fd: int,
        controller_lock_fd: int,
    ) -> "RuntimeIntentJournal":
        """Create the internal mutation handle from already-held lock FDs."""
        handle = cls(state_dir)
        writer_copy: Optional[int] = None
        controller_copy: Optional[int] = None
        try:
            writer_copy, writer_identity = handle._admit_lock_fd(
                writer_lock_fd, ".writer.lock", "writer lock",
            )
            controller_copy, controller_identity = handle._admit_lock_fd(
                controller_lock_fd, ".controller.lock", "controller lock",
            )
            if (writer_identity.device, writer_identity.inode) == (
                controller_identity.device, controller_identity.inode
            ):
                raise RuntimeIntentError("writer and controller locks must be distinct")
            handle._writer_lock_fd = writer_copy
            handle._controller_lock_fd = controller_copy
            handle._writer_lock_identity = writer_identity
            handle._controller_lock_identity = controller_identity
            handle._require_mutation_authority()
            return handle
        except BaseException:
            if writer_copy is not None:
                os.close(writer_copy)
            if controller_copy is not None:
                os.close(controller_copy)
            handle._writer_lock_fd = None
            handle._controller_lock_fd = None
            handle.close()
            raise

    def __enter__(self) -> "RuntimeIntentJournal":
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        if self._writer_lock_fd is not None:
            os.close(self._writer_lock_fd)
            self._writer_lock_fd = None
        if self._controller_lock_fd is not None:
            os.close(self._controller_lock_fd)
            self._controller_lock_fd = None
        os.close(self._root_fd)
        self._closed = True

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    @staticmethod
    def _crash(stage: str) -> None:
        if _CRASH_HOOK is not None:
            _CRASH_HOOK(stage)

    def _crash_checked(self, stage: str) -> None:
        self._require_mutation_authority()
        try:
            self._crash(stage)
        finally:
            self._require_mutation_authority()

    def _write_authorized(self, fd: int, data: bytes) -> int:
        self._require_mutation_authority()
        try:
            return os.write(fd, data)
        finally:
            self._require_mutation_authority()

    def _fsync_authorized(self, fd: int) -> None:
        self._require_mutation_authority()
        try:
            os.fsync(fd)
        finally:
            self._require_mutation_authority()

    def _ftruncate_authorized(self, fd: int, length: int) -> None:
        self._require_mutation_authority()
        try:
            os.ftruncate(fd, length)
        finally:
            self._require_mutation_authority()

    def _fchmod_authorized(self, fd: int, mode: int) -> None:
        self._require_mutation_authority()
        try:
            os.fchmod(fd, mode)
        finally:
            self._require_mutation_authority()

    def _open_authorized(
        self, name: str, flags: int, mode: Optional[int] = None,
    ) -> int:
        self._require_mutation_authority()
        fd: Optional[int] = None
        try:
            if mode is None:
                fd = os.open(name, flags, dir_fd=self._root_fd)
            else:
                fd = os.open(name, flags, mode, dir_fd=self._root_fd)
            return fd
        finally:
            try:
                self._require_mutation_authority()
            except BaseException:
                if fd is not None:
                    os.close(fd)
                raise

    def _rename_no_replace_authorized(self, source: str, destination: str) -> None:
        self._require_mutation_authority()
        try:
            _rename_no_replace(self._root_fd, source, destination)
        finally:
            self._require_mutation_authority()

    def _rename_exchange_authorized(self, left: str, right: str) -> None:
        self._require_mutation_authority()
        try:
            _rename_exchange(self._root_fd, left, right)
        finally:
            self._require_mutation_authority()

    def _validate_root(self) -> None:
        if self._closed:
            raise RuntimeIntentError("runtime intent journal is closed")
        if os.getpid() != self._owner_pid:
            raise RuntimeIntentError("runtime intent journal belongs to another process")
        try:
            held = os.fstat(self._root_fd)
            named = os.lstat(self.root)
        except OSError as exc:
            raise RuntimeIntentError("state directory path is unavailable") from exc
        if (not stat.S_ISDIR(held.st_mode) or not stat.S_ISDIR(named.st_mode)
                or stat.S_ISLNK(named.st_mode)
                or held.st_uid != os.geteuid() or named.st_uid != os.geteuid()
                or stat.S_IMODE(held.st_mode) != 0o700
                or stat.S_IMODE(named.st_mode) != 0o700
                or (held.st_dev, held.st_ino) != self._root_identity
                or (named.st_dev, named.st_ino) != self._root_identity):
            raise RuntimeIntentError("state directory was replaced or is not private")

    @staticmethod
    def _fd_has_current_exclusive_flock(fd: int) -> bool:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            info_fd = os.open(f"/proc/self/fdinfo/{fd}", flags)
        except OSError as exc:
            raise RuntimeIntentError("lock ownership cannot be inspected") from exc
        try:
            raw = bytearray()
            while len(raw) <= 8192:
                chunk = os.read(info_fd, min(4096, 8193 - len(raw)))
                if not chunk:
                    break
                raw.extend(chunk)
            if len(raw) > 8192:
                raise RuntimeIntentError("lock ownership metadata exceeds byte bound")
        finally:
            os.close(info_fd)
        try:
            lines = bytes(raw).decode("ascii").splitlines()
        except UnicodeDecodeError as exc:
            raise RuntimeIntentError("lock ownership metadata is malformed") from exc
        matches = []
        for line in lines:
            if not line.startswith("lock:"):
                continue
            fields = line.split()
            matches.append(
                len(fields) >= 9
                and fields[2:5] == ["FLOCK", "ADVISORY", "WRITE"]
                and fields[5] == str(os.getpid())
            )
        return matches == [True]

    def _admit_lock_fd(
        self, fd: int, name: str, label: str,
    ) -> tuple[int, _FileIdentity]:
        self._validate_root()
        if isinstance(fd, bool) or not isinstance(fd, int) or fd < 0:
            raise RuntimeIntentError(f"{label} descriptor is invalid")
        try:
            held = self._private_identity(os.fstat(fd), label)
        except OSError as exc:
            raise RuntimeIntentError(f"{label} descriptor is invalid") from exc
        named = self._named_identity(name, required=True, label=label)
        assert named is not None
        if held != named:
            raise RuntimeIntentError(f"{label} descriptor is not the fixed lock file")
        if not self._fd_has_current_exclusive_flock(fd):
            raise RuntimeIntentError(f"{label} is not exclusively held by this process")
        try:
            copied = os.dup(fd)
        except OSError as exc:
            raise RuntimeIntentError(f"{label} descriptor cannot be retained") from exc
        try:
            if (self._private_identity(os.fstat(copied), label) != held
                    or not self._fd_has_current_exclusive_flock(copied)):
                raise RuntimeIntentError(f"{label} authority changed while retained")
            return copied, held
        except BaseException:
            os.close(copied)
            raise

    def _require_mutation_authority(self) -> None:
        self._validate_root()
        authority = (
            (self._writer_lock_fd, self._writer_lock_identity,
             ".writer.lock", "writer lock"),
            (self._controller_lock_fd, self._controller_lock_identity,
             ".controller.lock", "controller lock"),
        )
        for fd, expected, name, label in authority:
            if fd is None or expected is None:
                raise RuntimeIntentError(
                    "runtime intent mutation requires held controller and writer locks"
                )
            try:
                held = self._private_identity(os.fstat(fd), label)
            except OSError as exc:
                raise RuntimeIntentError(f"{label} authority is unavailable") from exc
            named = self._named_identity(name, required=True, label=label)
            if held != expected or named != expected:
                raise RuntimeIntentError(f"{label} authority changed or was replaced")
            if not self._fd_has_current_exclusive_flock(fd):
                raise RuntimeIntentError(f"{label} authority is no longer held")

    @staticmethod
    def _private_identity(info: os.stat_result, label: str) -> _FileIdentity:
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise RuntimeIntentError(f"{label} must be an owned regular file")
        if stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeIntentError(f"{label} must be mode-0600")
        if info.st_nlink != 1:
            raise RuntimeIntentError(f"{label} must be single-linked")
        return _FileIdentity(
            info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns,
            info.st_ctime_ns,
        )

    def _named_identity(
        self, name: str, *, required: bool, label: str,
    ) -> Optional[_FileIdentity]:
        self._validate_root()
        try:
            info = os.stat(name, dir_fd=self._root_fd, follow_symlinks=False)
        except FileNotFoundError:
            if required:
                raise RuntimeIntentError(f"{label} is required")
            return None
        except OSError as exc:
            raise RuntimeIntentError(f"{label} cannot be inspected safely") from exc
        return self._private_identity(info, label)

    def _read_named(
        self, name: str, *, required: bool, label: str, maximum: int,
    ) -> tuple[Optional[bytes], Optional[_FileIdentity]]:
        before = self._named_identity(name, required=required, label=label)
        if before is None:
            return None, None
        if before.size > maximum:
            raise RuntimeIntentError(f"{label} exceeds byte bound")
        flags = (
            os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NOATIME", 0)
        )
        try:
            fd = os.open(name, flags, dir_fd=self._root_fd)
        except OSError as exc:
            raise RuntimeIntentError(f"{label} cannot be opened safely") from exc
        try:
            opened = self._private_identity(os.fstat(fd), label)
            if opened != before:
                raise RuntimeIntentError(f"{label} changed while being opened")
            data = bytearray()
            offset = 0
            while offset < opened.size:
                chunk = os.pread(fd, min(1024 * 1024, opened.size - offset), offset)
                if not chunk:
                    raise RuntimeIntentError(f"{label} changed while being read")
                data.extend(chunk)
                offset += len(chunk)
            if os.pread(fd, 1, opened.size):
                raise RuntimeIntentError(f"{label} grew while being read")
            held_after = self._private_identity(os.fstat(fd), label)
            named_after = self._named_identity(name, required=True, label=label)
            if held_after != opened or named_after != opened:
                raise RuntimeIntentError(f"{label} changed while being read")
            return bytes(data), opened
        finally:
            os.close(fd)

    def _read_ledger(self) -> bytes:
        data, _ = self._read_named(
            _LEDGER_NAME, required=False, label="ledger",
            maximum=_MAX_LEDGER_BYTES,
        )
        return b"" if data is None else data

    def _assert_named_identity(
        self, name: str, expected: _FileIdentity, *, label: str,
    ) -> _FileIdentity:
        current = self._named_identity(name, required=True, label=label)
        assert current is not None
        if current != expected:
            raise RuntimeIntentError(f"{label} changed or was replaced")
        return current

    def _read_open_file(
        self, fd: int, expected: _FileIdentity, *, label: str, maximum: int,
    ) -> bytes:
        if expected.size > maximum:
            raise RuntimeIntentError(f"{label} exceeds byte bound")
        data = bytearray()
        offset = 0
        while offset < expected.size:
            chunk = os.pread(fd, min(1024 * 1024, expected.size - offset), offset)
            if not chunk:
                raise RuntimeIntentError(f"{label} changed while being read")
            data.extend(chunk)
            offset += len(chunk)
        if os.pread(fd, 1, expected.size):
            raise RuntimeIntentError(f"{label} grew while being read")
        if self._private_identity(os.fstat(fd), label) != expected:
            raise RuntimeIntentError(f"{label} changed while being read")
        return bytes(data)

    def _read_intent_slot(
        self, name: str, label: str, *, allow_vacant: bool,
    ) -> _IntentSlot:
        raw, identity = self._read_named(
            name, required=False, label=label, maximum=_MAX_INTENT_BYTES,
        )
        if raw is None:
            return _IntentSlot(name, label, None, None, None)
        if allow_vacant and raw == _VACANT_STAGING_RECORD:
            return _IntentSlot(name, label, raw, identity, None)
        try:
            intent = _parse_intent_record(raw)
        except RuntimeIntentError as exc:
            raise RuntimeIntentError(f"{label} is not a valid intent record") from exc
        return _IntentSlot(name, label, raw, identity, intent)

    def _assert_slot(self, slot: _IntentSlot) -> None:
        current = self._named_identity(
            slot.name, required=False, label=slot.label,
        )
        if current != slot.identity:
            raise RuntimeIntentError(f"{slot.label} changed or was replaced")

    def _read_slots(self) -> _IntentSlots:
        slots = _IntentSlots(
            active=self._read_intent_slot(
                _ACTIVE_NAME, "runtime intent", allow_vacant=False,
            ),
            staging=self._read_intent_slot(
                _STAGING_NAME, "runtime intent staging file", allow_vacant=True,
            ),
            retired=self._read_intent_slot(
                _RETIRED_NAME, "retired runtime intent", allow_vacant=False,
            ),
        )
        for slot in (slots.active, slots.staging, slots.retired):
            self._assert_slot(slot)
        intents = tuple(
            slot.intent for slot in (slots.active, slots.staging, slots.retired)
            if slot.intent is not None
        )
        sequences = [intent.event_sequence for intent in intents]
        if len(sequences) != len(set(sequences)):
            raise RuntimeIntentError("runtime intent slots have duplicate sequences")
        nonstaging = tuple(
            intent for intent in (slots.active.intent, slots.retired.intent)
            if intent is not None
        )
        if (slots.staging.intent is not None
                and (not nonstaging or slots.staging.intent.event_sequence
                     > max(intent.event_sequence for intent in nonstaging))):
            raise RuntimeIntentError(
                "runtime intent staging file requires explicit disposition"
            )
        return slots

    @staticmethod
    def _logical_active(slots: _IntentSlots) -> Optional[RuntimeIntent]:
        active = slots.active.intent
        retired = slots.retired.intent
        if active is None:
            return None
        if retired is None or active.event_sequence > retired.event_sequence:
            return active
        if active.event_sequence < retired.event_sequence:
            return None
        raise RuntimeIntentError("runtime intent retirement order is ambiguous")

    def inspect(self) -> Optional[RuntimeIntent]:
        """Read exactly one active intent without creating or healing files."""
        return self._logical_active(self._read_slots())

    def _prepare_authorized(
        self, *, event_line: bytes, event_hash: str, event_sequence: int,
        ledger_prefix_bytes: int, ledger_prefix_sha256: str,
        ledger_prefix_tip_hash: str, ledger_prefix_event_count: int,
        projection_sha256: str, epoch: int,
    ) -> RuntimeIntent:
        """Durably publish one exact intent before any ledger mutation."""
        slots = self._read_slots()
        if self._logical_active(slots) is not None:
            raise RuntimeIntentError("an active runtime intent already exists")
        intent = _validate_intent_values(
            event_line=event_line,
            event_hash=event_hash,
            event_sequence=event_sequence,
            ledger_prefix_bytes=ledger_prefix_bytes,
            ledger_prefix_sha256=ledger_prefix_sha256,
            ledger_prefix_tip_hash=ledger_prefix_tip_hash,
            ledger_prefix_event_count=ledger_prefix_event_count,
            projection_sha256=projection_sha256,
            epoch=epoch,
        )
        ledger = self._read_ledger()
        _validate_ledger_prefix(
            ledger,
            expected_bytes=intent.ledger_prefix_bytes,
            expected_sha256=intent.ledger_prefix_sha256,
            expected_tip_hash=intent.ledger_prefix_tip_hash,
            expected_event_count=intent.ledger_prefix_event_count,
        )
        stored = tuple(
            slot.intent for slot in (slots.active, slots.staging, slots.retired)
            if slot.intent is not None
        )
        if stored and intent.event_sequence <= max(
            item.event_sequence for item in stored
        ):
            raise RuntimeIntentError("new runtime intent sequence is not monotonic")
        raw = _canonical(_intent_record(intent)) + b"\n"
        if _sha256(raw) != intent.record_sha256:
            raise RuntimeIntentError("runtime intent serialization is unstable")
        flags = os.O_RDWR | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        fresh_staging = slots.staging.identity is None
        if fresh_staging:
            try:
                fd = self._open_authorized(
                    _STAGING_NAME, flags | os.O_CREAT | os.O_EXCL, 0o600,
                )
            except OSError as exc:
                raise RuntimeIntentError(
                    "runtime intent staging file cannot be created"
                ) from exc
        else:
            fd = self._open_authorized(_STAGING_NAME, flags)
        try:
            if fresh_staging:
                self._fchmod_authorized(fd, 0o600)
            else:
                opened = self._private_identity(
                    os.fstat(fd), "runtime intent staging file",
                )
                if opened != slots.staging.identity:
                    raise RuntimeIntentError(
                        "runtime intent staging file changed while being opened"
                    )
                self._assert_slot(slots.staging)
                self._ftruncate_authorized(fd, 0)
            boundary = max(1, len(raw) // 2)
            offset = 0
            while offset < boundary:
                written = self._write_authorized(fd, raw[offset:boundary])
                if written <= 0:
                    raise RuntimeIntentError("runtime intent staging write stalled")
                offset += written
            self._crash_checked("during_staging_write")
            while offset < len(raw):
                written = self._write_authorized(fd, raw[offset:])
                if written <= 0:
                    raise RuntimeIntentError("runtime intent staging write stalled")
                offset += written
            self._fsync_authorized(fd)
            self._crash_checked("after_staging_fsync")
            written_identity = self._private_identity(
                os.fstat(fd), "runtime intent staging file",
            )
            if written_identity.size != len(raw):
                raise RuntimeIntentError("runtime intent staging size is invalid")
            named_identity = self._named_identity(
                _STAGING_NAME, required=True, label="runtime intent staging file",
            )
            readback = bytearray()
            offset = 0
            while offset < len(raw):
                chunk = os.pread(fd, len(raw) - offset, offset)
                if not chunk:
                    raise RuntimeIntentError("runtime intent staging readback stalled")
                readback.extend(chunk)
                offset += len(chunk)
            if (bytes(readback) != raw or os.pread(fd, 1, len(raw))
                    or self._private_identity(
                        os.fstat(fd), "runtime intent staging file",
                    ) != written_identity
                    or named_identity != written_identity):
                raise RuntimeIntentError("runtime intent staging readback is unstable")
            if _parse_intent_record(bytes(readback)) != intent:
                raise RuntimeIntentError("runtime intent staging readback is invalid")
            self._crash_checked("after_staging_readback")
            self._assert_slot(slots.active)
            self._assert_named_identity(
                _STAGING_NAME, written_identity,
                label="runtime intent staging file",
            )
            if slots.active.identity is None:
                self._rename_no_replace_authorized(_STAGING_NAME, _ACTIVE_NAME)
            else:
                self._rename_exchange_authorized(_STAGING_NAME, _ACTIVE_NAME)
            self._crash_checked("after_activation")
            active = self._named_identity(
                _ACTIVE_NAME, required=True, label="runtime intent",
            )
            assert active is not None
            if not _same_file(active, written_identity):
                raise RuntimeIntentError("runtime intent changed during activation")
            staged_after = self._named_identity(
                _STAGING_NAME, required=False, label="runtime intent staging file",
            )
            if slots.active.identity is None:
                if staged_after is not None:
                    raise RuntimeIntentError(
                        "runtime intent staging name survived first activation"
                    )
            elif staged_after is None or not _same_file(
                staged_after, slots.active.identity,
            ):
                raise RuntimeIntentError("runtime intent slot exchange changed identity")
            self._fsync_authorized(self._root_fd)
            self._crash_checked("after_activation_dir_fsync")
        finally:
            os.close(fd)
        observed = self.inspect()
        if observed != intent:
            raise RuntimeIntentError("activated runtime intent is unstable")
        return intent

    def _recover_ledger_authorized(self) -> LedgerRecoveryReceipt:
        """Complete only the verified remainder of the active event append."""
        intent = self.inspect()
        if intent is None:
            raise RuntimeIntentError("an active runtime intent is required")
        before = self._named_identity(
            _LEDGER_NAME, required=False, label="ledger",
        )
        created = False
        flags = (
            os.O_RDWR | os.O_APPEND | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        if before is None:
            if intent.ledger_prefix_bytes != 0:
                raise RuntimeIntentError("ledger is missing its required intent prefix")
            try:
                fd = self._open_authorized(
                    _LEDGER_NAME, flags | os.O_CREAT | os.O_EXCL, 0o600,
                )
            except OSError as exc:
                raise RuntimeIntentError("ledger cannot be created safely") from exc
            created = True
        else:
            try:
                fd = self._open_authorized(_LEDGER_NAME, flags)
            except OSError as exc:
                raise RuntimeIntentError("ledger cannot be opened safely") from exc
        locked = False
        try:
            if created:
                self._fchmod_authorized(fd, 0o600)
                before = self._private_identity(os.fstat(fd), "ledger")
                if before.size != 0:
                    raise RuntimeIntentError("new ledger was not empty")
            assert before is not None
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise RuntimeIntentError("ledger is held by another writer") from exc
            locked = True
            opened = self._private_identity(os.fstat(fd), "ledger")
            if opened != before:
                raise RuntimeIntentError("ledger changed while being opened")
            self._assert_named_identity(_LEDGER_NAME, opened, label="ledger")
            current = self._read_open_file(
                fd, opened, label="ledger", maximum=_MAX_LEDGER_BYTES,
            )
            if len(current) < intent.ledger_prefix_bytes:
                raise RuntimeIntentError("ledger is shorter than the intent prefix")
            prefix = current[:intent.ledger_prefix_bytes]
            _validate_ledger_prefix(
                prefix,
                expected_bytes=intent.ledger_prefix_bytes,
                expected_sha256=intent.ledger_prefix_sha256,
                expected_tip_hash=intent.ledger_prefix_tip_hash,
                expected_event_count=intent.ledger_prefix_event_count,
            )
            tail = current[intent.ledger_prefix_bytes:]
            if len(tail) > len(intent.event_line):
                raise RuntimeIntentError("ledger contains bytes after the intended event")
            if not intent.event_line.startswith(tail):
                raise RuntimeIntentError("ledger contains a divergent intended-event tail")
            complete = tail == intent.event_line
            remainder = b"" if complete else intent.event_line[len(tail):]
            if len(current) + len(remainder) > _MAX_LEDGER_BYTES:
                raise RuntimeIntentError("ledger append exceeds total byte bound")
            if self.inspect() != intent:
                raise RuntimeIntentError("runtime intent changed before ledger append")
            self._assert_named_identity(_LEDGER_NAME, opened, label="ledger")
            if self._read_open_file(
                fd, opened, label="ledger", maximum=_MAX_LEDGER_BYTES,
            ) != current:
                raise RuntimeIntentError("ledger changed before intended-event append")
            self._crash_checked("before_ledger_append")
            if self.inspect() != intent:
                raise RuntimeIntentError("runtime intent changed before ledger append")
            self._assert_named_identity(_LEDGER_NAME, opened, label="ledger")
            if self._read_open_file(
                fd, opened, label="ledger", maximum=_MAX_LEDGER_BYTES,
            ) != current:
                raise RuntimeIntentError("ledger changed before intended-event append")
            if remainder:
                boundary = max(1, len(remainder) // 2)
                offset = 0
                while offset < boundary:
                    written = self._write_authorized(fd, remainder[offset:boundary])
                    if written <= 0:
                        raise RuntimeIntentError("ledger append stalled")
                    offset += written
                partial_data = current + remainder[:offset]
                partial_identity = self._private_identity(os.fstat(fd), "ledger")
                if (partial_identity.size != len(partial_data)
                        or self._read_open_file(
                            fd, partial_identity, label="ledger",
                            maximum=_MAX_LEDGER_BYTES,
                        ) != partial_data):
                    raise RuntimeIntentError("ledger changed during partial append")
                self._assert_named_identity(
                    _LEDGER_NAME, partial_identity, label="ledger",
                )
                self._crash_checked("during_ledger_append")
                if self.inspect() != intent:
                    raise RuntimeIntentError(
                        "runtime intent changed during ledger append"
                    )
                self._assert_named_identity(
                    _LEDGER_NAME, partial_identity, label="ledger",
                )
                if self._read_open_file(
                    fd, partial_identity, label="ledger",
                    maximum=_MAX_LEDGER_BYTES,
                ) != partial_data:
                    raise RuntimeIntentError("ledger changed during partial append")
                while offset < len(remainder):
                    written = self._write_authorized(fd, remainder[offset:])
                    if written <= 0:
                        raise RuntimeIntentError("ledger append stalled")
                    offset += written
            self._fsync_authorized(fd)
            self._crash_checked("after_ledger_fsync")
            expected_data = current + remainder
            completed = self._private_identity(os.fstat(fd), "ledger")
            if completed.size != len(expected_data):
                raise RuntimeIntentError("ledger changed during intended-event append")
            if self._read_open_file(
                fd, completed, label="ledger", maximum=_MAX_LEDGER_BYTES,
            ) != expected_data:
                raise RuntimeIntentError("ledger content changed during intended-event append")
            self._assert_named_identity(_LEDGER_NAME, completed, label="ledger")
            if expected_data != (
                prefix + intent.event_line
            ):
                raise RuntimeIntentError("ledger did not reach the exact intended event")
            self._fsync_authorized(self._root_fd)
            self._crash_checked("after_ledger_dir_fsync")
            if self.inspect() != intent:
                raise RuntimeIntentError("runtime intent changed after ledger append")
            self._assert_named_identity(_LEDGER_NAME, completed, label="ledger")
            if self._read_open_file(
                fd, completed, label="ledger", maximum=_MAX_LEDGER_BYTES,
            ) != expected_data:
                raise RuntimeIntentError("ledger changed after directory sync")
            return LedgerRecoveryReceipt(
                intent_sha256=intent.record_sha256,
                event_line_sha256=intent.event_line_sha256,
                event_hash=intent.event_hash,
                event_sequence=intent.event_sequence,
                ledger_bytes=len(expected_data),
                ledger_sha256=_sha256(expected_data),
                ledger_tip_hash=intent.event_hash,
                ledger_event_count=intent.event_sequence,
                appended_bytes=len(remainder),
                already_complete=complete,
            )
        finally:
            if locked:
                fcntl.flock(fd, fcntl.LOCK_UN)
            os.close(fd)
            if created:
                self._validate_root()

    def _require_completed_ledger(self, intent: RuntimeIntent) -> bytes:
        ledger = self._read_ledger()
        if len(ledger) < intent.ledger_prefix_bytes:
            raise RuntimeIntentError("ledger is shorter than the intent prefix")
        prefix = ledger[:intent.ledger_prefix_bytes]
        _validate_ledger_prefix(
            prefix,
            expected_bytes=intent.ledger_prefix_bytes,
            expected_sha256=intent.ledger_prefix_sha256,
            expected_tip_hash=intent.ledger_prefix_tip_hash,
            expected_event_count=intent.ledger_prefix_event_count,
        )
        if ledger[intent.ledger_prefix_bytes:] != intent.event_line:
            raise RuntimeIntentError("ledger does not contain the exact intended event")
        return ledger

    def _clear_authorized(
        self, intent: RuntimeIntent, proof: ProjectionEventProof,
    ) -> IntentClearReceipt:
        """Retire an intent only after exact ledger and projection proof."""
        expected = _revalidate_intent(intent)
        checked_proof = _validate_projection_proof(expected, proof)
        self._require_completed_ledger(expected)
        slots = self._read_slots()
        active = self._logical_active(slots)
        if active is None:
            if slots.retired.intent != expected:
                raise RuntimeIntentError(
                    "retired runtime intent does not match clear request"
                )
            self._fsync_authorized(self._root_fd)
            confirmed = self._read_slots()
            if (self._logical_active(confirmed) is not None
                    or confirmed.retired.intent != expected
                    or confirmed.retired.identity != slots.retired.identity):
                raise RuntimeIntentError(
                    "runtime intent retirement changed before durable receipt"
                )
            self._require_completed_ledger(expected)
            already_absent = True
        else:
            if active != expected or slots.active.identity is None:
                raise RuntimeIntentError(
                    "active runtime intent does not match clear request"
                )
            for slot in (slots.active, slots.staging, slots.retired):
                self._assert_slot(slot)
            self._crash_checked("before_intent_retirement")
            for slot in (slots.active, slots.staging, slots.retired):
                self._assert_slot(slot)
            if slots.retired.identity is None:
                self._rename_no_replace_authorized(
                    _ACTIVE_NAME, _RETIRED_NAME,
                )
            else:
                self._rename_exchange_authorized(
                    _ACTIVE_NAME, _RETIRED_NAME,
                )
            self._crash_checked("after_intent_retirement")
            retired = self._read_intent_slot(
                _RETIRED_NAME, "retired runtime intent", allow_vacant=False,
            )
            if (retired.intent != expected or retired.identity is None
                    or not _same_file(retired.identity, slots.active.identity)):
                raise RuntimeIntentError(
                    "runtime intent retirement changed expected identity"
                )
            active_after = self._read_intent_slot(
                _ACTIVE_NAME, "runtime intent", allow_vacant=False,
            )
            if slots.retired.identity is None:
                if active_after.identity is not None:
                    raise RuntimeIntentError(
                        "active runtime intent name survived retirement"
                    )
            elif (active_after.identity is None
                  or not _same_file(active_after.identity, slots.retired.identity)):
                raise RuntimeIntentError(
                    "runtime intent retirement slot exchange changed identity"
                )
            self._fsync_authorized(self._root_fd)
            self._crash_checked("after_retirement_dir_fsync")
            confirmed = self._read_slots()
            if (self._logical_active(confirmed) is not None
                    or confirmed.retired.intent != expected):
                raise RuntimeIntentError("runtime intent retirement is not durable")
            self._require_completed_ledger(expected)
            already_absent = False
        return IntentClearReceipt(
            intent_sha256=expected.record_sha256,
            event_line_sha256=expected.event_line_sha256,
            event_hash=expected.event_hash,
            event_sequence=expected.event_sequence,
            epoch=expected.epoch,
            projection_sha256=checked_proof.projection_sha256,
            already_absent=already_absent,
        )

    def _discard_staging_authorized(
        self, proof: PrefixProjectionProof,
    ) -> StagingDiscardReceipt:
        """Reset staging only while ledger/projection are at the exact prefix.

        The projection digest is an attestation by the trusted durable-store
        caller; this filesystem-only module independently verifies the ledger.
        """
        checked = _validate_prefix_proof(proof)
        active = self._read_intent_slot(
            _ACTIVE_NAME, "runtime intent", allow_vacant=False,
        )
        retired = self._read_intent_slot(
            _RETIRED_NAME, "retired runtime intent", allow_vacant=False,
        )
        if (active.intent is not None and retired.intent is not None
                and active.intent.event_sequence
                == retired.intent.event_sequence):
            raise RuntimeIntentError(
                "active and retired runtime intents have duplicate sequences"
            )
        ledger = self._read_ledger()
        _validate_ledger_prefix(
            ledger,
            expected_bytes=checked.ledger_prefix_bytes,
            expected_sha256=checked.ledger_prefix_sha256,
            expected_tip_hash=checked.ledger_prefix_tip_hash,
            expected_event_count=checked.ledger_prefix_event_count,
        )
        raw, identity = self._read_named(
            _STAGING_NAME, required=False,
            label="runtime intent staging file", maximum=_MAX_INTENT_BYTES,
        )
        staged: Optional[RuntimeIntent] = None
        vacant = raw == _VACANT_STAGING_RECORD
        if raw and not vacant:
            try:
                staged = _parse_intent_record(raw)
            except RuntimeIntentError:
                staged = None
        duplicate: Optional[_IntentSlot] = None
        if staged is not None:
            matching_sequence = tuple(
                slot for slot in (active, retired)
                if (slot.intent is not None and slot.intent.event_sequence
                    == staged.event_sequence)
            )
            if matching_sequence:
                duplicate = matching_sequence[0]
                if (len(matching_sequence) != 1
                        or duplicate.intent != staged
                        or duplicate.raw != raw):
                    raise RuntimeIntentError(
                        "runtime intent staging sequence duplicates a different "
                        "stable intent"
                    )
        logical_active = (
            active.intent is not None
            and (retired.intent is None or active.intent.event_sequence
                 > retired.intent.event_sequence)
        )
        if logical_active and duplicate is None:
            raise RuntimeIntentError("active runtime intent forbids staging discard")
        newest_stable = max(
            (
                item.event_sequence for item in (active.intent, retired.intent)
                if item is not None
            ),
            default=0,
        )
        unresolved = (
            duplicate is not None
            or (staged is None and raw is not None and not vacant)
        )
        if (staged is not None and duplicate is None
                and staged.event_sequence > newest_stable):
            unresolved = True
            if (
                staged.ledger_prefix_bytes != checked.ledger_prefix_bytes
                or staged.ledger_prefix_sha256 != checked.ledger_prefix_sha256
                or staged.ledger_prefix_tip_hash != checked.ledger_prefix_tip_hash
                or staged.ledger_prefix_event_count
                   != checked.ledger_prefix_event_count
                or staged.projection_sha256 != checked.projection_sha256
                or staged.epoch != checked.epoch
            ):
                raise RuntimeIntentError(
                    "staging intent does not match prefix and projection proof"
                )
        if not unresolved:
            self._fsync_authorized(self._root_fd)
            confirmed = self._read_slots()
            if (confirmed.active != active or confirmed.retired != retired
                    or confirmed.staging.raw != raw
                    or confirmed.staging.identity != identity):
                raise RuntimeIntentError(
                    "runtime intent slots changed before durable receipt"
                )
            current_ledger = self._read_ledger()
            _validate_ledger_prefix(
                current_ledger,
                expected_bytes=checked.ledger_prefix_bytes,
                expected_sha256=checked.ledger_prefix_sha256,
                expected_tip_hash=checked.ledger_prefix_tip_hash,
                expected_event_count=checked.ledger_prefix_event_count,
            )
            if self._read_slots() != confirmed:
                raise RuntimeIntentError(
                    "runtime intent slots changed before durable receipt"
                )
            return StagingDiscardReceipt(
                staging_sha256=None if raw is None else _sha256(raw),
                staging_bytes=0 if raw is None else len(raw),
                ledger_prefix_sha256=checked.ledger_prefix_sha256,
                projection_sha256=checked.projection_sha256,
                epoch=checked.epoch,
                already_absent=True,
            )
        assert identity is not None
        assert raw is not None
        self._crash_checked("before_staging_reset")
        self._assert_slot(active)
        self._assert_slot(retired)
        current_ledger = self._read_ledger()
        _validate_ledger_prefix(
            current_ledger,
            expected_bytes=checked.ledger_prefix_bytes,
            expected_sha256=checked.ledger_prefix_sha256,
            expected_tip_hash=checked.ledger_prefix_tip_hash,
            expected_event_count=checked.ledger_prefix_event_count,
        )
        self._assert_named_identity(
            _STAGING_NAME, identity, label="runtime intent staging file",
        )
        fd = self._open_authorized(
            _STAGING_NAME,
            os.O_RDWR | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0),
        )
        try:
            opened = self._private_identity(
                os.fstat(fd), "runtime intent staging file",
            )
            if opened != identity:
                raise RuntimeIntentError(
                    "runtime intent staging changed while being opened"
                )
            self._assert_named_identity(
                _STAGING_NAME, identity, label="runtime intent staging file",
            )
            self._ftruncate_authorized(fd, 0)
            boundary = max(1, len(_VACANT_STAGING_RECORD) // 2)
            offset = 0
            while offset < boundary:
                written = self._write_authorized(
                    fd, _VACANT_STAGING_RECORD[offset:boundary],
                )
                if written <= 0:
                    raise RuntimeIntentError("runtime intent staging reset stalled")
                offset += written
            self._crash_checked("during_staging_reset")
            while offset < len(_VACANT_STAGING_RECORD):
                written = self._write_authorized(
                    fd, _VACANT_STAGING_RECORD[offset:],
                )
                if written <= 0:
                    raise RuntimeIntentError("runtime intent staging reset stalled")
                offset += written
            self._fsync_authorized(fd)
            self._crash_checked("after_staging_reset")
            reset = self._private_identity(
                os.fstat(fd), "runtime intent staging file",
            )
            if (reset.size != len(_VACANT_STAGING_RECORD)
                    or self._read_open_file(
                        fd, reset, label="runtime intent staging file",
                        maximum=_MAX_INTENT_BYTES,
                    ) != _VACANT_STAGING_RECORD):
                raise RuntimeIntentError("runtime intent staging reset is invalid")
            self._assert_named_identity(
                _STAGING_NAME, reset, label="runtime intent staging file",
            )
        finally:
            os.close(fd)
        self._fsync_authorized(self._root_fd)
        self._crash_checked("after_staging_reset_dir_fsync")
        confirmed = self._read_slots()
        if (confirmed.staging.raw != _VACANT_STAGING_RECORD
                or confirmed.staging.identity is None
                or confirmed.active != active or confirmed.retired != retired):
            raise RuntimeIntentError("runtime intent staging reset is not durable")
        current_ledger = self._read_ledger()
        _validate_ledger_prefix(
            current_ledger,
            expected_bytes=checked.ledger_prefix_bytes,
            expected_sha256=checked.ledger_prefix_sha256,
            expected_tip_hash=checked.ledger_prefix_tip_hash,
            expected_event_count=checked.ledger_prefix_event_count,
        )
        if self._read_slots() != confirmed:
            raise RuntimeIntentError(
                "runtime intent slots changed before durable receipt"
            )
        return StagingDiscardReceipt(
            staging_sha256=_sha256(raw),
            staging_bytes=len(raw),
            ledger_prefix_sha256=checked.ledger_prefix_sha256,
            projection_sha256=checked.projection_sha256,
            epoch=checked.epoch,
            already_absent=False,
        )

    def prepare(
        self, *, event_line: bytes, event_hash: str, event_sequence: int,
        ledger_prefix_bytes: int, ledger_prefix_sha256: str,
        ledger_prefix_tip_hash: str, ledger_prefix_event_count: int,
        projection_sha256: str, epoch: int,
    ) -> RuntimeIntent:
        """Publish one exact intent under held controller/writer authority."""
        self._require_mutation_authority()
        try:
            return self._prepare_authorized(
                event_line=event_line,
                event_hash=event_hash,
                event_sequence=event_sequence,
                ledger_prefix_bytes=ledger_prefix_bytes,
                ledger_prefix_sha256=ledger_prefix_sha256,
                ledger_prefix_tip_hash=ledger_prefix_tip_hash,
                ledger_prefix_event_count=ledger_prefix_event_count,
                projection_sha256=projection_sha256,
                epoch=epoch,
            )
        finally:
            self._require_mutation_authority()

    def recover_ledger(self) -> LedgerRecoveryReceipt:
        """Complete the intended append under held controller/writer authority."""
        self._require_mutation_authority()
        try:
            return self._recover_ledger_authorized()
        finally:
            self._require_mutation_authority()

    def clear(
        self, intent: RuntimeIntent, proof: ProjectionEventProof,
    ) -> IntentClearReceipt:
        """Clear an applied intent under held controller/writer authority."""
        self._require_mutation_authority()
        try:
            return self._clear_authorized(intent, proof)
        finally:
            self._require_mutation_authority()

    def discard_staging(
        self, proof: PrefixProjectionProof,
    ) -> StagingDiscardReceipt:
        """Disposition staging under held controller/writer authority."""
        self._require_mutation_authority()
        try:
            return self._discard_staging_authorized(proof)
        finally:
            self._require_mutation_authority()
