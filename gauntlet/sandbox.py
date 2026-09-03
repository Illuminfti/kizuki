"""Inert construction of the offline worker containment topology.

This module deliberately returns immutable argv/property records only.  It
does not create directories, start a transient unit, or execute bubblewrap.
The eventual runner must separately prove these commands on the VPS before it
may be wired to any scheduler path.
"""
from __future__ import annotations

import hashlib
import math
import os
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Tuple

from gauntlet.identity import (
    IdentityError,
    MaterializedIdentity,
    materialized_identity_destination_sha256,
    verify_materialized_identity,
)


class SandboxError(RuntimeError):
    pass


_HEX = frozenset("0123456789abcdef")
_ID_SAFE = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
_SYSTEM_RO_BINDS = (("/usr", "/usr"), ("/bin", "/bin"), ("/lib", "/lib"), ("/lib64", "/lib64"))
_ADAPTER_PROFILES = {
    "codex": ("/opt/harness/bin/codex", "exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "-C", "/work", "-s", "workspace-write", "-a", "never", "-"),
    "claude": ("/opt/harness/bin/claude", "--print", "--output-format", "stream-json", "--no-session-persistence", "--safe-mode", "--restricted", "--permission-mode", "dontAsk", "--permission-prompts", "none", "--strict-mcp-config"),
    "cursor": ("/opt/harness/bin/cursor-agent", "--print", "--output-format", "stream-json", "--sandbox", "disabled", "--trust", "--workspace", "/work"),
    "grok": ("/opt/harness/bin/grok", "--single", "-", "--output-format", "streaming-json", "--cwd", "/work", "--permission-mode", "dontAsk", "--disable-web-search", "--no-subagents"),
}


def _sha256(value: str, name: str) -> None:
    if not isinstance(value, str) or len(value) != 64 or any(char not in _HEX for char in value):
        raise SandboxError(f"{name} must be a lowercase SHA-256")


def _opaque_id(value: str, name: str) -> None:
    if not isinstance(value, str) or not value or len(value) > 80 or any(char not in _ID_SAFE for char in value):
        raise SandboxError(f"unsafe {name}")


def _absolute_directory(value: str, name: str, *, must_exist: bool = True, private: bool = False) -> Path:
    if not isinstance(value, str) or not os.path.isabs(value):
        raise SandboxError(f"{name} must be absolute")
    path = Path(value)
    if path.is_symlink():
        raise SandboxError(f"{name} must not be a symlink")
    resolved = path.resolve(strict=False)
    if must_exist:
        try:
            st = os.lstat(resolved)
        except OSError as exc:
            raise SandboxError(f"{name} is unavailable") from exc
        if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
            raise SandboxError(f"{name} must be a directory")
        if st.st_uid != os.geteuid():
            raise SandboxError(f"{name} must be owned by the controller user")
        if private and stat.S_IMODE(st.st_mode) != 0o700:
            raise SandboxError(f"{name} must be mode 0700")
        if not private and st.st_mode & 0o022:
            raise SandboxError(f"{name} must not be group or world writable")
    return resolved


def _under(child: Path, parent: Path, name: str) -> None:
    if child == parent or parent not in child.parents:
        raise SandboxError(f"{name} escapes attempt root")


def full_release_tree_hash(release_tree: str | Path, max_bytes: int = 256 * 1024 * 1024) -> str:
    """Hash every path kind, mode and byte in a complete release tree.

    Symlinks, device files, Git metadata, and group/world-writable content are
    rejected rather than interpreted.  A release therefore cannot change what
    executes through a hidden link, attribute, or shared mutable file.
    """
    root = _absolute_directory(os.fspath(release_tree), "release_tree")
    if max_bytes < 1:
        raise SandboxError("invalid release hash budget")
    digest = hashlib.sha256()
    consumed = 0
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        entries = sorted(directories + files)
        for entry in entries:
            path = current_path / entry
            relative = path.relative_to(root)
            if any(part == ".git" for part in relative.parts):
                raise SandboxError("release tree must not contain Git metadata")
            try:
                info = os.lstat(path)
            except OSError as exc:
                raise SandboxError("release tree changed while hashing") from exc
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise SandboxError("release tree contains an unsafe path kind")
            if info.st_mode & 0o022:
                raise SandboxError("release tree contains mutable content")
            encoded = os.fsencode(relative.as_posix())
            kind = b"D" if stat.S_ISDIR(info.st_mode) else b"F"
            digest.update(kind + b"\0" + encoded + b"\0" + oct(stat.S_IMODE(info.st_mode)).encode() + b"\0")
            if stat.S_ISREG(info.st_mode):
                flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
                try:
                    fd = os.open(path, flags)
                    try:
                        opened = os.fstat(fd)
                        if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                            raise SandboxError("release tree changed while hashing")
                        while True:
                            block = os.read(fd, 65536)
                            if not block:
                                break
                            consumed += len(block)
                            if consumed > max_bytes:
                                raise SandboxError("release tree exceeds hash budget")
                            digest.update(block)
                    finally:
                        os.close(fd)
                except OSError as exc:
                    raise SandboxError("release tree changed while hashing") from exc
    return digest.hexdigest()


@dataclass(frozen=True)
class SandboxSpec:
    campaign_id: str
    task_id: str
    attempt: int
    controller_epoch: int
    lease_token: int
    controller_unit: str
    release_tree: str
    release_sha256: str
    attempt_root: str
    worktree: str
    job_home: str
    raw_evidence: str
    identity_principal_id: str
    identity_authority_domain: str
    identity_generation: int
    identity_manifest_sha256: str
    identity_expires_at: float
    phase_attempt_id: str
    task_spec_sha256: str
    adapter: str
    wall_seconds: int
    cpu_quota_percent: int
    memory_bytes: int
    tasks_max: int
    output_bytes: int
    network_profile: str = "offline"

    def __post_init__(self) -> None:
        _opaque_id(self.campaign_id, "campaign_id")
        _opaque_id(self.task_id, "task_id")
        _opaque_id(self.identity_principal_id, "identity principal")
        _opaque_id(self.identity_authority_domain, "identity authority domain")
        if not isinstance(self.identity_generation, int) or isinstance(self.identity_generation, bool) or self.identity_generation < 1:
            raise SandboxError("invalid identity generation")
        _sha256(self.identity_manifest_sha256, "identity_manifest_sha256")
        _sha256(self.phase_attempt_id, "phase_attempt_id")
        _sha256(self.task_spec_sha256, "task_spec_sha256")
        if (isinstance(self.identity_expires_at, bool)
                or not isinstance(self.identity_expires_at, (int, float))
                or not math.isfinite(self.identity_expires_at)
                or self.identity_expires_at <= 0):
            raise SandboxError("invalid identity expiry")
        if not all(isinstance(value, int) and value > 0 for value in (self.attempt, self.controller_epoch, self.lease_token)):
            raise SandboxError("invalid attempt fence")
        if self.controller_unit != "kizuki-gauntlet.service":
            raise SandboxError("controller unit must be the canonical service")
        _sha256(self.release_sha256, "release_sha256")
        release = _absolute_directory(self.release_tree, "release_tree")
        if full_release_tree_hash(release) != self.release_sha256:
            raise SandboxError("release tree identity does not match")
        root = _absolute_directory(self.attempt_root, "attempt_root", private=True)
        work = _absolute_directory(self.worktree, "worktree", private=True)
        raw = _absolute_directory(self.raw_evidence, "raw_evidence", private=True)
        home = _absolute_directory(self.job_home, "job_home", must_exist=False)
        for path, name in ((work, "worktree"), (raw, "raw_evidence"), (home, "job_home")):
            _under(path, root, name)
            if path.parent != root:
                raise SandboxError(f"{name} must be a direct attempt child")
        if work.name != "work" or raw.name != "raw" or home.name != "job-home":
            raise SandboxError("attempt layout has unexpected path names")
        if home.exists() and (home.is_symlink() or not home.is_dir()):
            raise SandboxError("job_home must be an absent path or directory")
        git = work / ".git"
        if not git.is_dir() or git.is_symlink():
            raise SandboxError("worktree must be an isolated clone with a Git directory")
        if self.network_profile != "offline":
            raise SandboxError("networked sandbox profiles are not implemented")
        if self.adapter not in _ADAPTER_PROFILES:
            raise SandboxError("adapter must select a controller-owned profile")
        executable = release / "bin" / Path(_ADAPTER_PROFILES[self.adapter][0]).name
        if not executable.is_file() or executable.is_symlink() or not os.access(executable, os.X_OK):
            raise SandboxError("adapter executable is not in the release tree")
        if any(not isinstance(value, int) or value < 1 for value in (self.wall_seconds, self.cpu_quota_percent, self.memory_bytes, self.tasks_max, self.output_bytes)):
            raise SandboxError("invalid resource budget")
        if self.wall_seconds > 3600 or self.cpu_quota_percent > 1000 or self.tasks_max > 512 or self.output_bytes > 64 * 1024 * 1024:
            raise SandboxError("resource budget exceeds policy")
        object.__setattr__(self, "release_tree", str(release))
        object.__setattr__(self, "attempt_root", str(root))
        object.__setattr__(self, "worktree", str(work))
        object.__setattr__(self, "raw_evidence", str(raw))
        object.__setattr__(self, "job_home", str(home))


@dataclass(frozen=True)
class OfflineLaunch:
    unit_name: str
    systemd_argv: Tuple[str, ...]
    harness_bwrap_argv: Tuple[str, ...]
    relay_bwrap_argv: Tuple[str, ...] | None
    release_sha256: str


def _bwrap_prefix() -> Tuple[str, ...]:
    argv = ["/usr/bin/bwrap", "--die-with-parent", "--new-session", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp"]
    for source, target in _SYSTEM_RO_BINDS:
        argv.extend(("--ro-bind", source, target))
    return tuple(argv)


def _prepared_job_home(spec: SandboxSpec, receipt: MaterializedIdentity,
                       controller_hmac_key: bytes) -> Path:
    """Validate a freshly materialized credential home without changing it.

    Identity materialization has already enforced freshness and its manifest
    digest; containment independently rejects any mutable or linked content.
    """
    if not isinstance(receipt, MaterializedIdentity):
        raise SandboxError("MaterializedIdentity receipt required")
    try:
        verify_materialized_identity(receipt, controller_hmac_key, now=time.time())
    except IdentityError as exc:
        raise SandboxError("materialized identity receipt authentication failed") from exc
    if (receipt.principal_id != spec.identity_principal_id
            or receipt.authority_domain != spec.identity_authority_domain
            or receipt.generation != spec.identity_generation
            or receipt.adapter != spec.adapter
            or receipt.manifest_sha256 != spec.identity_manifest_sha256
            or receipt.campaign_id != spec.campaign_id
            or receipt.task_id != spec.task_id
            or receipt.task_attempt != spec.attempt
            or receipt.phase_attempt_id != spec.phase_attempt_id
            or receipt.controller_epoch != spec.controller_epoch
            or receipt.task_spec_sha256 != spec.task_spec_sha256
            or receipt.expires_at != spec.identity_expires_at
            or receipt.destination_sha256
            != materialized_identity_destination_sha256(spec.job_home)):
        raise SandboxError("identity receipt does not match sandbox specification")
    prepared = _absolute_directory(spec.job_home, "prepared_job_home", private=True)
    if prepared != Path(spec.job_home) or prepared.parent != Path(spec.attempt_root):
        raise SandboxError("prepared job_home does not match preflight specification")
    expected_files = {artifact.path: artifact for artifact in receipt.artifacts}
    expected_dirs = {""}
    for artifact in receipt.artifacts:
        parts = Path(artifact.path).parts[:-1]
        for index in range(1, len(parts) + 1):
            expected_dirs.add("/".join(parts[:index]))
    actual_files: dict[str, tuple[os.stat_result, Path]] = {}
    actual_dirs = {""}
    try:
        for current, directories, files in os.walk(prepared, topdown=True, followlinks=False):
            current_path = Path(current)
            for name in directories + files:
                path = current_path / name
                relative = path.relative_to(prepared).as_posix()
                info = os.lstat(path)
                if stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid():
                    raise SandboxError("prepared job_home contains unsafe identity content")
                if stat.S_ISDIR(info.st_mode):
                    if stat.S_IMODE(info.st_mode) != 0o700:
                        raise SandboxError("prepared identity directories must be mode 0700")
                    actual_dirs.add(relative)
                elif stat.S_ISREG(info.st_mode):
                    if stat.S_IMODE(info.st_mode) != 0o600:
                        raise SandboxError("prepared identity files must be mode 0600")
                    actual_files[relative] = (info, path)
                else:
                    raise SandboxError("prepared job_home contains unsafe identity content")
    except OSError as exc:
        raise SandboxError("prepared job_home is unreadable") from exc
    if set(actual_files) != set(expected_files) or actual_dirs != expected_dirs:
        raise SandboxError("prepared job_home does not exactly match materialized inventory")
    total = 0
    for relative, artifact in expected_files.items():
        info, path = actual_files[relative]
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            fd = os.open(path, flags)
        except OSError as exc:
            raise SandboxError("prepared job_home changed while validating") from exc
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise SandboxError("prepared job_home changed while validating")
            digest = hashlib.sha256()
            size = 0
            while True:
                data = os.read(fd, 65536)
                if not data:
                    break
                size += len(data)
                digest.update(data)
            if size != artifact.bytes or digest.hexdigest() != artifact.sha256:
                raise SandboxError("prepared identity artifact digest changed")
            total += size
        finally:
            os.close(fd)
    if total != receipt.total_bytes:
        raise SandboxError("prepared identity total changed")
    return prepared


def build_offline_launch(spec: SandboxSpec, materialized_identity: MaterializedIdentity,
                         controller_hmac_key: bytes) -> OfflineLaunch:
    """Build, but never execute, the exact offline transient-unit topology."""
    if not isinstance(spec, SandboxSpec):
        raise SandboxError("SandboxSpec required")
    prepared_home = _prepared_job_home(spec, materialized_identity, controller_hmac_key)
    # Recheck mutable filesystem identity at the launch boundary.
    if full_release_tree_hash(spec.release_tree) != spec.release_sha256:
        raise SandboxError("release tree identity changed")
    identity = f"{spec.campaign_id}\0{spec.task_id}\0{spec.attempt}\0{spec.controller_epoch}\0{spec.lease_token}".encode()
    unit_name = "kizuki-gauntlet-attempt-" + hashlib.sha256(identity).hexdigest()[:24] + ".service"
    harness = _bwrap_prefix() + (
        "--ro-bind", spec.release_tree, "/opt/harness",
        "--bind", spec.worktree, "/work",
        "--bind", str(prepared_home), "/job-home",
        "--chdir", "/work", "--clearenv",
        "--setenv", "HOME", "/job-home",
        "--setenv", "PATH", "/opt/harness/bin:/usr/bin:/bin",
        "--", *_ADAPTER_PROFILES[spec.adapter],
    )
    properties = (
        "Type=exec", "KillMode=control-group", f"BindsTo={spec.controller_unit}", f"After={spec.controller_unit}",
        f"RuntimeMaxSec={spec.wall_seconds}", f"CPUQuota={spec.cpu_quota_percent}%", f"MemoryMax={spec.memory_bytes}",
        f"TasksMax={spec.tasks_max}", "TimeoutStartSec=30s", "TimeoutStopSec=20s", "SendSIGKILL=yes", "NoNewPrivileges=yes",
        "PrivateTmp=yes", "PrivateNetwork=yes", "ProtectSystem=strict", "ProtectHome=read-only",
        "AmbientCapabilities=", "RestrictSUIDSGID=yes", "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
        f"BindReadOnlyPaths={spec.release_tree}", f"ReadWritePaths={spec.attempt_root}",
    )
    systemd = ("/usr/bin/systemd-run", "--user", "--wait", "--pipe", "--service-type=exec", f"--unit={unit_name}", "--collect") + tuple(f"--property={value}" for value in properties) + ("--", *harness)
    return OfflineLaunch(unit_name, systemd, harness, None, spec.release_sha256)
