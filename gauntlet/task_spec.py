"""Canonical, authenticated specifications for one inert harness launch.

Task specifications carry authority context but no credential.  The signed
wire format is versioned independently from all other controller MAC domains.
The only filesystem operations here are a write-once private specification
file and its exact-byte authenticated reload; this module never launches a
process, accesses a repository, or performs network I/O.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
import hashlib
import hmac
import json
import os
import re
import stat
from pathlib import PurePosixPath
from pathlib import Path
from typing import Mapping, Sequence, Tuple
from urllib.parse import urlsplit


class TaskSpecError(RuntimeError):
    pass


TASK_SPEC_SCHEMA = "kizuki-gauntlet-task-spec-v2"
TASK_SPEC_MAC_DOMAIN = b"kizuki-gauntlet-task-spec-hmac-v2\0"
SUPPORTED_RECEIPT_SCHEMAS = frozenset({"kizuki-gauntlet-phase-result-v2"})
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
_HEX40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_SPEC_SECONDS = 7200
_MAX_MEMORY_BYTES = 64 * 1024 * 1024 * 1024
_MAX_TASK_SPEC_BYTES = 64 * 1024


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
        or not 1 <= len(value.encode("utf-8")) <= 200
        or value in {"@", "HEAD"}
        or value.startswith("-")
        or value.endswith(("/", "."))
        or ".." in value
        or "//" in value
        or "@{" in value
        or any(
            ord(char) < 32
            or ord(char) == 127
            or char in " ~^:?*[\\"
            for char in value
        )
    ):
        raise TaskSpecError("invalid expected branch")
    parts = value.split("/")
    if any(
        not part
        or part.startswith(".")
        or part.endswith((".", ".lock"))
        for part in parts
    ):
        raise TaskSpecError("invalid expected branch")
    return value


def _issue_spec_url(value: str, repository: str) -> str:
    if not isinstance(value, str) or len(value.encode("utf-8")) > 512:
        raise TaskSpecError("invalid issue/spec URL")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise TaskSpecError("invalid issue/spec URL") from exc
    if (
        parsed.scheme != "https"
        or parsed.netloc != "github.com"
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or not re.fullmatch(
            rf"/{re.escape(repository)}/issues/[1-9][0-9]*", parsed.path,
        )
        or (parsed.fragment and not re.fullmatch(r"issuecomment-[1-9][0-9]*", parsed.fragment))
        or parsed.geturl() != value
    ):
        raise TaskSpecError("invalid issue/spec URL")
    return value


def _path_prefix(value: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value in {".", ".."}
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


def _path_has_prefix(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def path_policy_allows(path: str, spec: "TaskSpec") -> bool:
    """Apply component-aware policy; a forbidden prefix always wins."""
    if not isinstance(spec, TaskSpec):
        raise TaskSpecError("TaskSpec required")
    normalized = _path_prefix(path)
    if any(_path_has_prefix(normalized, prefix) for prefix in spec.forbidden_paths):
        return False
    return any(_path_has_prefix(normalized, prefix) for prefix in spec.allowed_paths)


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


def verification_policy_sha256(
    name: str, commands: Mapping[str, Sequence[str]],
) -> str:
    """Digest a bounded named registry of controller-owned verification argv."""
    _identifier(name, "verification policy", lower=True)
    if not isinstance(commands, Mapping) or not 1 <= len(commands) <= 32:
        raise TaskSpecError("verification policy must contain one to 32 commands")
    material: dict[str, list[str]] = {}
    for command_id, argv in commands.items():
        _identifier(command_id, "verification command", lower=True)
        if (
            not isinstance(argv, (tuple, list))
            or not 1 <= len(argv) <= 64
            or any(
                not isinstance(value, str)
                or not value
                or len(value.encode("utf-8")) > 4096
                or "\x00" in value
                or any(ord(char) < 32 and char != "\t" for char in value)
                for value in argv
            )
        ):
            raise TaskSpecError("invalid verification-command argv")
        material[command_id] = list(argv)
    encoded = _canonical({"name": name, "commands": material})
    if len(encoded) > 32 * 1024:
        raise TaskSpecError("verification policy exceeds bound")
    return hashlib.sha256(encoded).hexdigest()


@dataclass(frozen=True)
class TaskSpec:
    schema: str
    issuer_key_id: str
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    expected_task_version: int
    repository: str
    base_sha: str
    expected_branch: str
    issue_spec_url: str
    allowed_paths: Tuple[str, ...]
    forbidden_paths: Tuple[str, ...]
    adapter: str
    principal_id: str
    authority_domain: str
    identity_generation: int
    role: str
    command_policy: str
    command_policy_sha256: str
    verification_policy: str
    verification_policy_sha256: str
    required_verification_commands: Tuple[str, ...]
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
            (self.principal_id, "principal id"),
            (self.authority_domain, "authority domain"),
        ):
            _identifier(value, label)
        for value, label in (
            (self.attempt, "attempt"),
            (self.controller_epoch, "controller epoch"),
            (self.expected_task_version, "expected task version"),
            (self.identity_generation, "identity generation"),
        ):
            _positive(value, label, 2**63 - 1)
        if not isinstance(self.repository, str) or not _REPOSITORY.fullmatch(self.repository):
            raise TaskSpecError("invalid repository identity")
        _digest(self.base_sha, "base SHA", _HEX40)
        _branch(self.expected_branch)
        _issue_spec_url(self.issue_spec_url, self.repository)
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
        _identifier(self.verification_policy, "verification policy", lower=True)
        _digest(self.verification_policy_sha256, "verification-policy digest")
        if (
            not isinstance(self.required_verification_commands, tuple)
            or not 1 <= len(self.required_verification_commands) <= 32
            or self.required_verification_commands
            != tuple(sorted(set(self.required_verification_commands)))
        ):
            raise TaskSpecError("verification commands must be sorted and unique")
        for command_id in self.required_verification_commands:
            _identifier(command_id, "verification command", lower=True)
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
        if self.expected_receipt_schema not in SUPPORTED_RECEIPT_SCHEMAS:
            raise TaskSpecError("unsupported expected receipt schema")
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
        key, TASK_SPEC_MAC_DOMAIN + _signature_payload(with_digest), hashlib.sha256,
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
        key, TASK_SPEC_MAC_DOMAIN + _signature_payload(spec), hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(spec.signature_sha256, signature):
        raise TaskSpecError("task-spec authentication failed")
    return spec


def canonical_task_spec_bytes(spec: TaskSpec) -> bytes:
    """Return the one accepted on-disk encoding for a signed TaskSpec."""
    if not isinstance(spec, TaskSpec):
        raise TaskSpecError("TaskSpec required")
    encoded = _canonical(asdict(spec)) + b"\n"
    if len(encoded) > _MAX_TASK_SPEC_BYTES:
        raise TaskSpecError("task specification exceeds file bound")
    return encoded


def _private_file_parent(path: str | os.PathLike[str]) -> tuple[Path, str, int]:
    try:
        target = Path(path)
    except TypeError as exc:
        raise TaskSpecError("task-spec path is invalid") from exc
    if not target.is_absolute() or target.name in ("", ".", ".."):
        raise TaskSpecError("task-spec path must be absolute")
    try:
        resolved_parent = target.parent.resolve(strict=True)
        parent_info = os.lstat(target.parent)
    except OSError as exc:
        raise TaskSpecError("task-spec parent is unavailable") from exc
    if (
        resolved_parent != target.parent
        or stat.S_ISLNK(parent_info.st_mode)
        or not stat.S_ISDIR(parent_info.st_mode)
        or parent_info.st_uid != os.geteuid()
        or parent_info.st_mode & 0o022
    ):
        raise TaskSpecError("task-spec parent is not private controller storage")
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_DIRECTORY", 0)
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        directory_fd = os.open(resolved_parent, flags)
    except OSError as exc:
        raise TaskSpecError("task-spec parent cannot be opened safely") from exc
    opened = os.fstat(directory_fd)
    if (opened.st_dev, opened.st_ino) != (parent_info.st_dev, parent_info.st_ino):
        os.close(directory_fd)
        raise TaskSpecError("task-spec parent changed while opening")
    return resolved_parent, target.name, directory_fd


def write_task_spec(
    path: str | os.PathLike[str],
    spec: TaskSpec,
    verification_keys: Mapping[str, bytes],
    *,
    now: int,
) -> None:
    """Authenticate then create one canonical mode-0600 TaskSpec."""
    verify_task_spec(spec, verification_keys, now=now)
    payload = canonical_task_spec_bytes(spec)
    _, name, directory_fd = _private_file_parent(path)
    file_fd: int | None = None
    created = False
    try:
        flags = (
            os.O_WRONLY
            | os.O_CREAT
            | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NOFOLLOW", 0)
        )
        file_fd = os.open(name, flags, 0o600, dir_fd=directory_fd)
        created = True
        os.fchmod(file_fd, 0o600)
        written = 0
        while written < len(payload):
            count = os.write(file_fd, payload[written:])
            if count < 1:
                raise TaskSpecError("task-spec write made no progress")
            written += count
        os.fsync(file_fd)
        info = os.fstat(file_fd)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_uid != os.geteuid()
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_nlink != 1
            or info.st_size != len(payload)
        ):
            raise TaskSpecError("task-spec file was not created privately")
        os.fsync(directory_fd)
    except TaskSpecError:
        if created:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
        raise
    except OSError as exc:
        if created:
            try:
                os.unlink(name, dir_fd=directory_fd)
            except OSError:
                pass
        raise TaskSpecError("task-spec file cannot be created safely") from exc
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(directory_fd)


def _reject_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise TaskSpecError("task-spec JSON contains a duplicate key")
        result[key] = value
    return result


def read_task_spec(
    path: str | os.PathLike[str],
    verification_keys: Mapping[str, bytes],
    *,
    now: int,
    expected_task_spec_sha256: str | None = None,
) -> TaskSpec:
    """Reload only the exact canonical private encoding and authenticate it."""
    _, name, directory_fd = _private_file_parent(path)
    file_fd: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        file_fd = os.open(name, flags, dir_fd=directory_fd)
        before = os.fstat(file_fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_uid != os.geteuid()
            or stat.S_IMODE(before.st_mode) != 0o600
        ):
            raise TaskSpecError("task-spec file must be controller-owned mode 0600")
        if before.st_nlink != 1:
            raise TaskSpecError("task-spec file must not be a hardlink")
        if not 1 <= before.st_size <= _MAX_TASK_SPEC_BYTES:
            raise TaskSpecError("task-spec file exceeds bound")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(file_fd, min(65536, remaining))
            if not chunk:
                raise TaskSpecError("task-spec file changed while reading")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(file_fd, 1):
            raise TaskSpecError("task-spec file changed while reading")
        after = os.fstat(file_fd)
        if (
            (before.st_dev, before.st_ino, before.st_size)
            != (after.st_dev, after.st_ino, after.st_size)
            or before.st_mtime_ns != after.st_mtime_ns
            or before.st_ctime_ns != after.st_ctime_ns
        ):
            raise TaskSpecError("task-spec file changed while reading")
        payload = b"".join(chunks)
    except TaskSpecError:
        raise
    except OSError as exc:
        raise TaskSpecError("task-spec file cannot be opened safely") from exc
    finally:
        if file_fd is not None:
            os.close(file_fd)
        os.close(directory_fd)

    try:
        decoded = payload.decode("ascii")
        material = json.loads(decoded, object_pairs_hook=_reject_duplicate_keys)
    except TaskSpecError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise TaskSpecError("task-spec file is not canonical JSON") from exc
    if not isinstance(material, dict):
        raise TaskSpecError("task-spec JSON must be an object")
    expected_fields = {field.name for field in fields(TaskSpec)}
    if set(material) != expected_fields:
        raise TaskSpecError("task-spec fields are not exactly allowlisted")
    for field_name in ("allowed_paths", "forbidden_paths", "required_verification_commands"):
        if not isinstance(material[field_name], list):
            raise TaskSpecError("task-spec sequence field is invalid")
        material[field_name] = tuple(material[field_name])
    try:
        spec = TaskSpec(**material)
    except TypeError as exc:
        raise TaskSpecError("task-spec fields are invalid") from exc
    if payload != canonical_task_spec_bytes(spec):
        raise TaskSpecError("task-spec file is not the exact canonical encoding")
    verify_task_spec(spec, verification_keys, now=now)
    if expected_task_spec_sha256 is not None:
        _digest(expected_task_spec_sha256, "expected task-spec digest")
        if not hmac.compare_digest(spec.task_spec_sha256, expected_task_spec_sha256):
            raise TaskSpecError("task specification does not match expected digest")
    return spec
