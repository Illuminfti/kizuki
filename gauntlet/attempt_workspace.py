"""Fresh per-attempt Git clones with no shared repository authority.

The controller supplies a signed task specification and a trusted repository
registry.  This module never accepts Git argv, a ref, a patch, or a destination
path from that specification.  It derives the sole checkout (`work`) and exact
commit from authenticated fields, suppresses ambient Git state, and returns
only bounded metadata and digests.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence, Tuple

from gauntlet.task_spec import SignedTaskSpec, TaskSpecError, verify_task_spec


class AttemptWorkspaceError(RuntimeError):
    """The trusted source or isolated attempt clone failed validation."""


_GIT = "/usr/bin/git"
_HEX40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_MAX_COMMAND_OUTPUT = 32 * 1024 * 1024
_MAX_FILES = 100_000
_MAX_TREE_BYTES = 1024 * 1024 * 1024
_COMMAND_TIMEOUT_SECONDS = 120
_GROUP_CLEANUP_SECONDS = 5
_MAX_SOURCE_CONFIG_BYTES = 1024 * 1024
_REAP_STARTED_ATTRIBUTE = "_gauntlet_reap_started"
_INTERRUPTED_REAP_RETURN_CODE = 255
_REPOSITORY = re.compile(r"[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\Z")
_BRANCH = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\Z")
_SAFE_CORE_CONFIG = {
    "core.repositoryformatversion": frozenset(("0",)),
    "core.filemode": frozenset(("true", "false")),
    "core.bare": frozenset(("false",)),
    "core.logallrefupdates": frozenset(("true", "false")),
    "core.ignorecase": frozenset(("true", "false")),
    "core.precomposeunicode": frozenset(("true", "false")),
}
_SAFE_SOURCE_CONFIG = re.compile(
    r"(?:remote\.[A-Za-z0-9._-]{1,80}\.(?:url|fetch)|"
    r"branch\.[A-Za-z0-9._/-]{1,120}\.(?:remote|merge))\Z"
)
_PROTECTED_GIT_CONFIG = (
    ("core.hooksPath", "/dev/null"),
    ("core.fsmonitor", "false"),
    ("core.alternateRefsCommand", "/bin/false"),
    ("uploadpack.packObjectsHook", "exec"),
    ("credential.helper", ""),
    ("core.askPass", "/bin/false"),
    ("core.sshCommand", "/bin/false"),
    ("core.gitProxy", "/bin/false"),
    ("diff.external", "/bin/false"),
)


@dataclass(frozen=True)
class AttemptWorkspaceReceipt:
    task_spec_sha256: str
    phase_attempt_id: str
    repository: str
    base_sha: str
    subject_sha: str
    expected_branch: str
    git_tree_sha: str
    inventory_sha256: str
    file_count: int
    total_bytes: int

    def __post_init__(self) -> None:
        strings = (
            self.task_spec_sha256, self.phase_attempt_id, self.repository,
            self.base_sha, self.subject_sha, self.expected_branch,
            self.git_tree_sha, self.inventory_sha256,
        )
        if any(not isinstance(value, str) for value in strings):
            raise AttemptWorkspaceError("workspace receipt contains an invalid string")
        if (not _HEX64.fullmatch(self.task_spec_sha256)
                or not _HEX64.fullmatch(self.phase_attempt_id)
                or not _HEX64.fullmatch(self.inventory_sha256)
                or not _HEX40.fullmatch(self.base_sha)
                or not _HEX40.fullmatch(self.subject_sha)
                or not _HEX40.fullmatch(self.git_tree_sha)):
            raise AttemptWorkspaceError("workspace receipt contains an invalid digest")
        if (not _REPOSITORY.fullmatch(self.repository)
                or self.repository.startswith((".", "-"))
                or "/." in self.repository or "/-" in self.repository):
            raise AttemptWorkspaceError("workspace receipt contains an invalid repository")
        if (not _BRANCH.fullmatch(self.expected_branch)
                or self.expected_branch.endswith((".", "/"))
                or ".." in self.expected_branch or "//" in self.expected_branch
                or "@{" in self.expected_branch
                or any(part.startswith(".") or part.endswith(".lock")
                       for part in self.expected_branch.split("/"))):
            raise AttemptWorkspaceError("workspace receipt contains an invalid branch")
        if (isinstance(self.file_count, bool) or not isinstance(self.file_count, int)
                or not 0 <= self.file_count <= _MAX_FILES
                or isinstance(self.total_bytes, bool) or not isinstance(self.total_bytes, int)
                or not 0 <= self.total_bytes <= _MAX_TREE_BYTES):
            raise AttemptWorkspaceError("workspace receipt exceeds its bounds")


@dataclass(frozen=True)
class _TreeEntry:
    path: str
    mode: str
    object_sha: str
    size: int


@dataclass(frozen=True)
class _PinnedConfigSnapshot:
    device: int
    inode: int
    owner: int
    mode: int
    links: int
    size: int
    modified_ns: int
    changed_ns: int
    sha256: str


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
        allow_nan=False,
    ).encode("ascii")


def _clock_sample(clock: Callable[[], int] | None) -> int:
    current = int(time.time()) if clock is None else clock()
    if isinstance(current, bool) or not isinstance(current, int) or current < 0:
        raise AttemptWorkspaceError("workspace clock returned an invalid time")
    return current


def _leader_exit_is_waitable(pid: int) -> bool:
    """Observe child exit without releasing its PID/process-group identity."""
    try:
        result = os.waitid(
            os.P_PID, pid,
            os.WEXITED | os.WNOHANG | os.WNOWAIT,
        )
    except ChildProcessError as exc:
        raise AttemptWorkspaceError(
            "Git process-group leader was reaped before cleanup"
        ) from exc
    except OSError as exc:
        raise AttemptWorkspaceError("Git process-group leader cannot be observed") from exc
    return result is not None


def _process_group_members(pgid: int, leader_pid: int) -> tuple[int, ...]:
    """Return Linux process-group members while an unreaped leader pins PGID."""
    members: list[int] = []
    try:
        entries = os.scandir("/proc")
    except OSError as exc:
        raise AttemptWorkspaceError("process inventory is unavailable") from exc
    with entries:
        for entry in entries:
            if not entry.name.isascii() or not entry.name.isdigit():
                continue
            pid = int(entry.name)
            if pid == leader_pid:
                continue
            try:
                with open(f"/proc/{entry.name}/stat", "rb", buffering=0) as handle:
                    raw = handle.read(4096)
            except (FileNotFoundError, ProcessLookupError):
                continue
            except OSError as exc:
                raise AttemptWorkspaceError("process inventory cannot be read") from exc
            closing = raw.rfind(b")")
            fields = raw[closing + 2:].split() if closing >= 0 else []
            if len(fields) < 3 or not fields[2].isdigit():
                raise AttemptWorkspaceError("process inventory is malformed")
            if int(fields[2]) == pgid:
                members.append(pid)
    return tuple(sorted(members))


def _signal_pinned_process_group(pgid: int, sent_signal: signal.Signals) -> None:
    try:
        os.killpg(pgid, sent_signal)
    except ProcessLookupError as exc:
        # The unreaped leader pins both PID and PGID.  Losing the group before
        # the consuming wait is therefore an invariant failure, not success.
        raise AttemptWorkspaceError("Git process group vanished before reap") from exc
    except PermissionError as exc:
        raise AttemptWorkspaceError("Git process group cannot be stopped") from exc


def _reap_process_group_leader(process: subprocess.Popen[bytes]) -> int:
    """Perform the sole consuming wait after the process group is proven empty."""
    pid = process.pid
    # Delay every catchable process signal until the consumed result has been
    # reflected into Popen.returncode.  This closes the ordinary SIGINT window
    # between the kernel reap and Python assignment.  The exception handler also
    # assigns a conservative non-success sentinel for an injected BaseException
    # whose wrapper consumed the wait result before raising; either path keeps
    # Popen.__del__ from issuing a later numeric waitpid against a reused PID.
    blocked = set(signal.valid_signals())
    blocked.discard(signal.SIGKILL)
    blocked.discard(signal.SIGSTOP)
    try:
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, blocked)
    except (OSError, ValueError) as exc:
        raise AttemptWorkspaceError("Git process reap signals cannot be masked") from exc
    setattr(process, _REAP_STARTED_ATTRIBUTE, True)
    try:
        try:
            result = os.waitid(os.P_PID, pid, os.WEXITED)
        except BaseException:
            # The wait wrapper may have consumed the child and then delivered
            # KeyboardInterrupt.  Never probe or signal the numeric identity
            # again; a non-None returncode makes Popen destruction inert.
            process.returncode = _INTERRUPTED_REAP_RETURN_CODE
            raise
        # From this instruction onward the kernel has consumed the zombie.
        # Install the sentinel before validation so every exceptional path is
        # also destructor-safe without another PID/PGID operation.
        process.returncode = _INTERRUPTED_REAP_RETURN_CODE
        if result is None or result.si_pid != pid:
            raise AttemptWorkspaceError("Git process-group reap result is invalid")
        if result.si_code == os.CLD_EXITED:
            return_code = result.si_status
        elif result.si_code in (os.CLD_KILLED, os.CLD_DUMPED):
            return_code = -result.si_status
        else:
            raise AttemptWorkspaceError("Git process-group exit state is invalid")
        process.returncode = return_code
        return return_code
    finally:
        signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def _finish_process_group(
    process: subprocess.Popen[bytes], *, force: bool, deadline: float,
) -> tuple[int, bool, bool]:
    """Stop descendants and only then reap the still-pinning group leader.

    No PID/PGID lookup or signal occurs after the consuming ``waitid``.  A zombie
    leader observed with ``waitid(..., WNOWAIT)`` prevents numeric ID reuse
    while `/proc` is checked and any descendants are stopped.
    """
    pgid = process.pid
    if isinstance(pgid, bool) or not isinstance(pgid, int) or pgid <= 0:
        raise AttemptWorkspaceError("Git process-group identity is invalid")
    try:
        if os.getpgid(pgid) != pgid:
            raise AttemptWorkspaceError("Git process did not own its process group")
    except ProcessLookupError as exc:
        raise AttemptWorkspaceError(
            "Git process-group identity vanished before cleanup"
        ) from exc
    except PermissionError as exc:
        raise AttemptWorkspaceError("Git process-group identity cannot be inspected") from exc

    residual = False
    timed_out = False
    stopping = force
    frozen = False
    cleanup_deadline = deadline
    if stopping:
        cleanup_deadline = time.monotonic() + _GROUP_CLEANUP_SECONDS
        _signal_pinned_process_group(pgid, signal.SIGKILL)

    while True:
        leader_exited = _leader_exit_is_waitable(pgid)
        now = time.monotonic()
        if leader_exited:
            if not stopping and not frozen:
                # Freeze the whole still-pinned group before enumerating it so
                # a last descendant cannot fork across the `/proc` proof.
                _signal_pinned_process_group(pgid, signal.SIGSTOP)
                frozen = True
                time.sleep(0.01)
                continue
            members = _process_group_members(pgid, pgid)
            if not members:
                break
            residual = True
            if not stopping:
                stopping = True
                cleanup_deadline = now + _GROUP_CLEANUP_SECONDS
            _signal_pinned_process_group(pgid, signal.SIGKILL)
        elif not stopping and now >= deadline:
            timed_out = True
            stopping = True
            cleanup_deadline = now + _GROUP_CLEANUP_SECONDS
            _signal_pinned_process_group(pgid, signal.SIGKILL)
        elif stopping and now >= cleanup_deadline:
            raise AttemptWorkspaceError("Git process group could not be emptied")
        time.sleep(0.01)

    # This is the sole reaping operation, deliberately after the final group
    # inventory and all possible signals.  Popen.wait()/poll() are never used.
    return_code = _reap_process_group_leader(process)
    return return_code, residual, timed_out


def _validate_pass_fds(pass_fds: Sequence[int]) -> tuple[int, ...]:
    result = tuple(pass_fds)
    if any(isinstance(fd, bool) or not isinstance(fd, int) or fd < 0 for fd in result):
        raise AttemptWorkspaceError("internal inherited descriptor is invalid")
    return tuple(sorted(set(result)))


def _validate_argv(argv: Sequence[str]) -> Tuple[str, ...]:
    result = tuple(argv)
    if (not result or result[0] != _GIT
            or any(not isinstance(item, str) or not item or "\x00" in item for item in result)):
        raise AttemptWorkspaceError("internal Git command is invalid")
    return result


def _run_quiet(
    argv: Sequence[str], *, environment: Mapping[str, str],
    timeout_seconds: int = _COMMAND_TIMEOUT_SECONDS,
    pass_fds: Sequence[int] = (),
) -> None:
    """Run one fixed Git command without retaining or exposing command output."""
    command = _validate_argv(argv)
    inherited = _validate_pass_fds(pass_fds)
    try:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=dict(environment), close_fds=True,
            start_new_session=True, umask=0o077, pass_fds=inherited,
        )
    except OSError as exc:
        raise AttemptWorkspaceError("Git command could not start") from exc
    cleanup_complete = False
    try:
        return_code, residual, timed_out = _finish_process_group(
            process, force=False, deadline=time.monotonic() + timeout_seconds,
        )
        cleanup_complete = True
        if timed_out:
            raise AttemptWorkspaceError("Git command exceeded its time budget")
        if residual:
            raise AttemptWorkspaceError("Git command left a process-group descendant")
        if return_code != 0:
            raise AttemptWorkspaceError("Git command failed")
    finally:
        if (not cleanup_complete and process.returncode is None
                and not getattr(process, _REAP_STARTED_ATTRIBUTE, False)):
            _finish_process_group(
                process, force=True,
                deadline=time.monotonic() + _GROUP_CLEANUP_SECONDS,
            )


def _run_capture(
    argv: Sequence[str], *, environment: Mapping[str, str], max_bytes: int,
    timeout_seconds: int = _COMMAND_TIMEOUT_SECONDS,
    pass_fds: Sequence[int] = (),
) -> bytes:
    """Capture stdout with a hard byte/time cap; stderr is never retained."""
    command = _validate_argv(argv)
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 1 <= max_bytes <= _MAX_COMMAND_OUTPUT:
        raise AttemptWorkspaceError("invalid Git evidence budget")
    inherited = _validate_pass_fds(pass_fds)
    try:
        process = subprocess.Popen(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=dict(environment), close_fds=True,
            start_new_session=True, umask=0o077, pass_fds=inherited,
        )
    except OSError as exc:
        raise AttemptWorkspaceError("Git evidence command could not start") from exc
    stdout = process.stdout
    selector: selectors.BaseSelector | None = None
    cleanup_complete = False
    try:
        if stdout is None:
            raise AttemptWorkspaceError("Git evidence pipe is unavailable")
        descriptor = stdout.fileno()
        os.set_blocking(descriptor, False)
        selector = selectors.DefaultSelector()
        selector.register(descriptor, selectors.EVENT_READ)
        deadline = time.monotonic() + timeout_seconds
        chunks: list[bytes] = []
        consumed = 0
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AttemptWorkspaceError("Git evidence command exceeded its time budget")
            events = selector.select(remaining)
            if not events:
                raise AttemptWorkspaceError("Git evidence command exceeded its time budget")
            for key, _mask in events:
                block = os.read(key.fd, min(65536, max_bytes - consumed + 1))
                if not block:
                    selector.unregister(key.fd)
                    continue
                consumed += len(block)
                if consumed > max_bytes:
                    raise AttemptWorkspaceError("Git evidence exceeds its byte budget")
                chunks.append(block)
        return_code, residual, timed_out = _finish_process_group(
            process, force=False, deadline=deadline,
        )
        cleanup_complete = True
        if timed_out:
            raise AttemptWorkspaceError("Git evidence command exceeded its time budget")
        if residual:
            raise AttemptWorkspaceError("Git evidence command left a process-group descendant")
        if return_code != 0:
            raise AttemptWorkspaceError("Git evidence command failed")
        return b"".join(chunks)
    finally:
        try:
            if (not cleanup_complete and process.returncode is None
                    and not getattr(process, _REAP_STARTED_ATTRIBUTE, False)):
                _finish_process_group(
                    process, force=True,
                    deadline=time.monotonic() + _GROUP_CLEANUP_SECONDS,
                )
        finally:
            try:
                if selector is not None:
                    selector.close()
            finally:
                if stdout is not None:
                    stdout.close()


def _directory_flags() -> int:
    return (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0))


def _same_inode(first: os.stat_result, second: os.stat_result) -> bool:
    return (first.st_dev, first.st_ino) == (second.st_dev, second.st_ino)


def _open_private_directory(path: Path, label: str) -> tuple[int, os.stat_result]:
    if not path.is_absolute():
        raise AttemptWorkspaceError(f"{label} must be absolute")
    try:
        resolved = path.resolve(strict=True)
        named = os.lstat(path)
        fd = os.open(path, _directory_flags())
    except OSError as exc:
        raise AttemptWorkspaceError(f"{label} is unavailable") from exc
    try:
        opened = os.fstat(fd)
        if (resolved != path or not stat.S_ISDIR(named.st_mode)
                or stat.S_ISLNK(named.st_mode) or not _same_inode(named, opened)
                or opened.st_uid != os.geteuid()
                or stat.S_IMODE(opened.st_mode) != 0o700):
            raise AttemptWorkspaceError(
                f"{label} must be an owned canonical mode-0700 directory"
            )
    except BaseException:
        os.close(fd)
        raise
    return fd, opened


def _recheck_named_directory(
    path: Path, fd: int, expected: os.stat_result, label: str, *, private: bool,
) -> None:
    try:
        named = os.lstat(path)
        opened = os.fstat(fd)
    except OSError as exc:
        raise AttemptWorkspaceError(f"{label} mapping is unavailable") from exc
    if (not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
            or not _same_inode(named, expected) or not _same_inode(opened, expected)
            or opened.st_uid != os.geteuid()
            or (stat.S_IMODE(opened.st_mode) != 0o700 if private
                else bool(opened.st_mode & 0o022))):
        raise AttemptWorkspaceError(f"{label} mapping changed")


def _open_child_directory(
    parent_fd: int, name: str, label: str,
) -> tuple[int, os.stat_result]:
    try:
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        fd = os.open(name, _directory_flags(), dir_fd=parent_fd)
    except OSError as exc:
        raise AttemptWorkspaceError(f"{label} is unavailable") from exc
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
                or not _same_inode(named, opened) or opened.st_uid != os.geteuid()
                or named.st_mode & 0o022):
            raise AttemptWorkspaceError(f"{label} is unsafe")
    except BaseException:
        os.close(fd)
        raise
    return fd, opened


def _recheck_child_directory(
    parent_fd: int, name: str, fd: int, expected: os.stat_result, label: str,
) -> None:
    try:
        named = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
        opened = os.fstat(fd)
    except OSError as exc:
        raise AttemptWorkspaceError(f"{label} mapping is unavailable") from exc
    if (not stat.S_ISDIR(named.st_mode) or stat.S_ISLNK(named.st_mode)
            or not _same_inode(named, expected) or not _same_inode(opened, expected)
            or opened.st_uid != os.geteuid() or opened.st_mode & 0o022
            or stat.S_IMODE(named.st_mode) != stat.S_IMODE(expected.st_mode)
            or stat.S_IMODE(opened.st_mode) != stat.S_IMODE(expected.st_mode)):
        raise AttemptWorkspaceError(f"{label} mapping changed")


def _fd_path(fd: int) -> Path:
    path = Path(f"/proc/self/fd/{fd}")
    try:
        if not _same_inode(os.stat(path), os.fstat(fd)):
            raise AttemptWorkspaceError("pinned directory descriptor mapping changed")
    except OSError as exc:
        raise AttemptWorkspaceError("pinned directory descriptor is unavailable") from exc
    return path


def _trusted_source(
    path_value: object,
) -> tuple[Path, int, os.stat_result, int, os.stat_result]:
    try:
        path = Path(os.fspath(path_value))  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise AttemptWorkspaceError("trusted repository path is invalid") from exc
    if not path.is_absolute():
        raise AttemptWorkspaceError("trusted repository path must be absolute")
    try:
        resolved = path.resolve(strict=True)
        info = os.lstat(path)
    except OSError as exc:
        raise AttemptWorkspaceError("trusted repository is unavailable") from exc
    if (resolved != path or not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
            or info.st_uid != os.geteuid() or info.st_mode & 0o022):
        raise AttemptWorkspaceError(
            "trusted repository must be an owned canonical non-writable directory"
        )
    try:
        source_fd = os.open(path, _directory_flags())
    except OSError as exc:
        raise AttemptWorkspaceError("trusted repository cannot be pinned") from exc
    try:
        opened = os.fstat(source_fd)
        if not _same_inode(info, opened):
            raise AttemptWorkspaceError("trusted repository mapping changed")
        git_fd, git_info = _open_child_directory(
            source_fd, ".git", "trusted Git metadata",
        )
    except BaseException:
        os.close(source_fd)
        raise
    return path, source_fd, opened, git_fd, git_info


def _git_environment(private_home: Path) -> dict[str, str]:
    environment = {
        "GIT_ALLOW_PROTOCOL": "file",
        "GIT_ASKPASS": "/bin/false",
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": "/dev/null",
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_EDITOR": "/bin/false",
        "GIT_EXTERNAL_DIFF": "/bin/false",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_PAGER": "",
        "GIT_PROTOCOL_FROM_USER": "0",
        "GIT_SEQUENCE_EDITOR": "/bin/false",
        "GIT_TERMINAL_PROMPT": "0",
        "HOME": str(private_home),
        "LANG": "C",
        "LC_ALL": "C",
        "PATH": "/usr/bin:/bin",
        "SSH_ASKPASS": "/bin/false",
        "XDG_CONFIG_HOME": str(private_home),
    }
    environment["GIT_CONFIG_COUNT"] = str(len(_PROTECTED_GIT_CONFIG))
    for index, (name, value) in enumerate(_PROTECTED_GIT_CONFIG):
        environment[f"GIT_CONFIG_KEY_{index}"] = name
        environment[f"GIT_CONFIG_VALUE_{index}"] = value
    return environment


def _git_command(
    git_dir: Path, *arguments: str, work_tree: Path | None = None,
) -> tuple[str, ...]:
    command = [_GIT, "-c", "core.hooksPath=/dev/null", f"--git-dir={git_dir}"]
    if work_tree is not None:
        command.append(f"--work-tree={work_tree}")
    command.extend(arguments)
    return tuple(command)


def _config_names(
    git_dir: Path, environment: Mapping[str, str], pass_fds: Sequence[int],
) -> set[str]:
    output = _run_capture(
        _git_command(git_dir, "config", "--local", "--no-includes", "--name-only", "--null", "--list"),
        environment=environment, max_bytes=64 * 1024, pass_fds=pass_fds,
    )
    if output and not output.endswith(b"\0"):
        raise AttemptWorkspaceError("Git config inventory is malformed")
    try:
        names = {item.decode("ascii") for item in output.split(b"\0") if item}
    except UnicodeDecodeError as exc:
        raise AttemptWorkspaceError("Git config name is not ASCII") from exc
    return names


def _config_value(
    git_dir: Path, name: str, environment: Mapping[str, str],
    pass_fds: Sequence[int],
) -> str:
    output = _run_capture(
        _git_command(git_dir, "config", "--local", "--no-includes", "--get", name),
        environment=environment, max_bytes=4096, pass_fds=pass_fds,
    )
    try:
        value = output.decode("utf-8").rstrip("\n")
    except UnicodeDecodeError as exc:
        raise AttemptWorkspaceError("Git config value is not UTF-8") from exc
    if "\n" in value or "\x00" in value:
        raise AttemptWorkspaceError("Git config value is not bounded")
    return value


def _validate_config(
    git_dir: Path, environment: Mapping[str, str], pass_fds: Sequence[int],
    *, source: bool,
) -> None:
    for name in _config_names(git_dir, environment, pass_fds):
        if name in _SAFE_CORE_CONFIG:
            value = _config_value(git_dir, name, environment, pass_fds).casefold()
            if value not in _SAFE_CORE_CONFIG[name]:
                raise AttemptWorkspaceError("Git config contains an unsafe core value")
        elif source and _SAFE_SOURCE_CONFIG.fullmatch(name):
            # Source remote/branch metadata is inert for fixed local clone argv.
            value = _config_value(git_dir, name, environment, pass_fds)
            if not value or len(value.encode("utf-8")) > 4096 or "\x00" in value:
                raise AttemptWorkspaceError("Git config contains an unsafe bounded value")
        else:
            raise AttemptWorkspaceError("Git config contains an unsafe key")


def _read_pinned_config(fd: int, expected_size: int) -> bytes:
    if not 0 <= expected_size <= _MAX_SOURCE_CONFIG_BYTES:
        raise AttemptWorkspaceError("source Git config exceeds its byte bound")
    os.lseek(fd, 0, os.SEEK_SET)
    chunks: list[bytes] = []
    remaining = expected_size
    while remaining:
        block = os.read(fd, min(65536, remaining))
        if not block:
            raise AttemptWorkspaceError("source Git config changed while reading")
        chunks.append(block)
        remaining -= len(block)
    if os.read(fd, 1):
        raise AttemptWorkspaceError("source Git config changed while reading")
    return b"".join(chunks)


def _config_snapshot(info: os.stat_result, content: bytes) -> _PinnedConfigSnapshot:
    return _PinnedConfigSnapshot(
        device=info.st_dev,
        inode=info.st_ino,
        owner=info.st_uid,
        mode=info.st_mode,
        links=info.st_nlink,
        size=info.st_size,
        modified_ns=info.st_mtime_ns,
        changed_ns=info.st_ctime_ns,
        sha256=hashlib.sha256(content).hexdigest(),
    )


def _pin_source_config(git_dir: Path) -> tuple[int, _PinnedConfigSnapshot]:
    path = git_dir / "config"
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        named = os.lstat(path)
        fd = os.open(path, flags)
    except OSError as exc:
        raise AttemptWorkspaceError("source Git config cannot be pinned") from exc
    try:
        opened = os.fstat(fd)
        if (not stat.S_ISREG(named.st_mode) or stat.S_ISLNK(named.st_mode)
                or not _same_inode(named, opened) or opened.st_uid != os.geteuid()
                or opened.st_nlink != 1 or opened.st_mode & 0o022):
            raise AttemptWorkspaceError("source Git config is unsafe")
        content = _read_pinned_config(fd, opened.st_size)
        after = os.fstat(fd)
        named_after = os.lstat(path)
        snapshot = _config_snapshot(opened, content)
        if (_config_snapshot(after, content) != snapshot
                or not _same_inode(after, named_after)
                or named_after.st_mtime_ns != after.st_mtime_ns
                or named_after.st_ctime_ns != after.st_ctime_ns):
            raise AttemptWorkspaceError("source Git config changed while pinning")
        return fd, snapshot
    except BaseException:
        os.close(fd)
        raise


def _recheck_source_config(
    git_dir: Path, fd: int, expected: _PinnedConfigSnapshot,
) -> None:
    path = git_dir / "config"
    try:
        opened = os.fstat(fd)
        named = os.lstat(path)
        content = _read_pinned_config(fd, opened.st_size)
        opened_after = os.fstat(fd)
        named_after = os.lstat(path)
    except OSError as exc:
        raise AttemptWorkspaceError("source Git config mapping cannot be rechecked") from exc
    if (not _same_inode(opened, named) or not _same_inode(opened, opened_after)
            or not _same_inode(opened_after, named_after)
            or _config_snapshot(opened, content) != expected
            or _config_snapshot(opened_after, content) != expected
            or named.st_mtime_ns != expected.modified_ns
            or named.st_ctime_ns != expected.changed_ns
            or named_after.st_mtime_ns != expected.modified_ns
            or named_after.st_ctime_ns != expected.changed_ns):
        raise AttemptWorkspaceError("source Git config snapshot changed")


def _validate_git_metadata(git_dir: Path, *, allow_samples: bool) -> None:
    # Inventory and permission-check every parent before opening a child.  In
    # particular, never call exists()/iterdir() through a symlinked hooks or
    # objects/info directory.
    try:
        # ``git_dir`` may be the controller-owned /proc/self/fd/N view of an
        # already O_NOFOLLOW-pinned directory.  Only that root component is
        # intentionally a procfs symlink; every descendant remains lstat'd.
        root_info = os.stat(git_dir)
        if (not stat.S_ISDIR(root_info.st_mode)
                or root_info.st_uid != os.geteuid() or root_info.st_mode & 0o022):
            raise AttemptWorkspaceError("Git metadata root is writable or unsafe")
        for current, directories, files in os.walk(git_dir, topdown=True, followlinks=False):
            current_path = Path(current)
            current_info = os.stat(current) if current_path == git_dir else os.lstat(current)
            if (not stat.S_ISDIR(current_info.st_mode)
                    or (current_path != git_dir and stat.S_ISLNK(current_info.st_mode))
                    or current_info.st_uid != os.geteuid()
                    or current_info.st_mode & 0o022):
                raise AttemptWorkspaceError("Git metadata directory is writable or unsafe")
            for name in directories + files:
                path = Path(current) / name
                relative = path.relative_to(git_dir).as_posix()
                if relative == "info/attributes":
                    raise AttemptWorkspaceError("Git attribute metadata is forbidden")
                if relative in {
                    "commondir", "config.worktree", "gitdir", "modules", "worktrees",
                }:
                    raise AttemptWorkspaceError("Git metadata indirection is forbidden")
                info = os.lstat(path)
                if (stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid()
                        or info.st_mode & 0o022):
                    raise AttemptWorkspaceError("Git metadata contains an unsafe path")
                if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                    raise AttemptWorkspaceError("Git metadata contains a special file")
                if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
                    raise AttemptWorkspaceError("Git metadata contains a shared link")
    except OSError as exc:
        raise AttemptWorkspaceError("Git metadata cannot be inventoried safely") from exc
    hooks = git_dir / "hooks"
    try:
        hooks_info = os.lstat(hooks)
    except FileNotFoundError:
        hooks_info = None
    except OSError as exc:
        raise AttemptWorkspaceError("Git hook inventory is unavailable") from exc
    if hooks_info is not None:
        if not stat.S_ISDIR(hooks_info.st_mode) or stat.S_ISLNK(hooks_info.st_mode):
            raise AttemptWorkspaceError("Git hook directory is unsafe")
        try:
            for entry in hooks.iterdir():
                if allow_samples and entry.name.endswith(".sample"):
                    continue
                raise AttemptWorkspaceError("Git hook content is forbidden")
        except OSError as exc:
            raise AttemptWorkspaceError("Git hook inventory is unavailable") from exc
    for name in ("alternates", "http-alternates"):
        path = git_dir / "objects" / "info" / name
        try:
            os.lstat(path)
        except FileNotFoundError:
            continue
        except OSError as exc:
            raise AttemptWorkspaceError("Git alternate inventory is unavailable") from exc
        raise AttemptWorkspaceError("Git alternate object stores are forbidden")


def _tree_path(raw: bytes | str) -> str:
    if isinstance(raw, bytes):
        try:
            value = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AttemptWorkspaceError("Git tree path is not UTF-8") from exc
    elif isinstance(raw, str):
        value = raw
    else:
        raise AttemptWorkspaceError("Git tree path has an invalid type")
    path = PurePosixPath(value)
    if (not value or value.startswith("/") or "\\" in value or "\x00" in value
            or len(value.encode("utf-8")) > 512 or len(path.parts) > 32
            or path.as_posix() != value
            or any(part in ("", ".", "..") or part.casefold() == ".git"
                   for part in path.parts)
            or any(ord(character) < 0x20 or ord(character) == 0x7f for character in value)):
        raise AttemptWorkspaceError("Git tree contains an unsafe path")
    if any(part.casefold() == ".gitmodules" for part in path.parts):
        raise AttemptWorkspaceError("Git submodule metadata is forbidden")
    if any(part.casefold() == ".gitattributes" for part in path.parts):
        raise AttemptWorkspaceError("Git attribute control files are forbidden")
    return value


def _tree_entries(
    git_dir: Path, base_sha: str, environment: Mapping[str, str],
    pass_fds: Sequence[int],
) -> tuple[_TreeEntry, ...]:
    output = _run_capture(
        _git_command(git_dir, "ls-tree", "--full-tree", "-r", "-l", "-z", base_sha),
        environment=environment, max_bytes=_MAX_COMMAND_OUTPUT,
        pass_fds=pass_fds,
    )
    entries: list[_TreeEntry] = []
    total = 0
    seen: set[str] = set()
    for record in output.split(b"\0"):
        if not record:
            continue
        try:
            header, raw_path = record.split(b"\t", 1)
            mode_raw, kind, object_raw, size_raw = header.split()
        except ValueError as exc:
            raise AttemptWorkspaceError("Git tree inventory is malformed") from exc
        try:
            mode = mode_raw.decode("ascii")
            object_sha = object_raw.decode("ascii")
            size_text = size_raw.decode("ascii")
        except UnicodeDecodeError as exc:
            raise AttemptWorkspaceError("Git tree inventory is malformed") from exc
        if mode == "160000" or kind == b"commit":
            raise AttemptWorkspaceError("Git submodule links are forbidden")
        if mode == "120000":
            raise AttemptWorkspaceError("Git symlink mode is forbidden")
        if mode not in {"100644", "100755"} or kind != b"blob":
            raise AttemptWorkspaceError("Git tree contains an unsafe file mode")
        if not _HEX40.fullmatch(object_sha) or not size_text.isdigit():
            raise AttemptWorkspaceError("Git tree object metadata is malformed")
        path = _tree_path(raw_path)
        if path in seen:
            raise AttemptWorkspaceError("Git tree contains a duplicate path")
        seen.add(path)
        size = int(size_text)
        total += size
        if len(entries) >= _MAX_FILES or total > _MAX_TREE_BYTES:
            raise AttemptWorkspaceError("Git tree exceeds its inventory budget")
        entries.append(_TreeEntry(path, mode, object_sha, size))
    return tuple(entries)


def _read_regular(path: Path, entry: _TreeEntry) -> tuple[str, os.stat_result]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        before = os.lstat(path)
        fd = os.open(path, flags)
    except OSError as exc:
        raise AttemptWorkspaceError("checked-out file cannot be opened safely") from exc
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(before.st_mode)
                or info.st_uid != os.geteuid()
                or (info.st_dev, info.st_ino) != (before.st_dev, before.st_ino)
                or info.st_nlink != 1 or info.st_size != entry.size
                or info.st_mode & 0o022):
            raise AttemptWorkspaceError("checked-out file metadata is unsafe")
        digest = hashlib.sha256()
        blob = hashlib.sha1(usedforsecurity=False)
        blob.update(f"blob {entry.size}\0".encode("ascii"))
        consumed = 0
        while consumed < entry.size:
            block = os.read(fd, min(65536, entry.size - consumed))
            if not block:
                raise AttemptWorkspaceError("checked-out file changed while reading")
            consumed += len(block)
            digest.update(block)
            blob.update(block)
        if os.read(fd, 1):
            raise AttemptWorkspaceError("checked-out file changed while reading")
        after = os.fstat(fd)
        named_after = os.lstat(path)
        stable = (
            after.st_dev, after.st_ino, after.st_uid, after.st_mode,
            after.st_nlink, after.st_size, after.st_mtime_ns, after.st_ctime_ns,
        ) == (
            info.st_dev, info.st_ino, info.st_uid, info.st_mode,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns,
        )
        if (not stable or not _same_inode(named_after, after)
                or blob.hexdigest() != entry.object_sha):
            raise AttemptWorkspaceError("checked-out Git blob identity changed")
        return digest.hexdigest(), after
    finally:
        os.close(fd)


def _normalize_worktree_modes(work: Path, entries: tuple[_TreeEntry, ...]) -> None:
    """Remove ambient-umask variance while preserving the signed Git mode bit."""
    expected = {entry.path: entry for entry in entries}
    try:
        for current, directories, files in os.walk(work, topdown=True, followlinks=False):
            current_path = Path(current)
            if current_path == work and ".git" in directories:
                directories.remove(".git")
            for directory in directories:
                path = current_path / directory
                info = os.lstat(path)
                if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                        or info.st_uid != os.geteuid()):
                    raise AttemptWorkspaceError("checked-out directory metadata is unsafe")
                os.chmod(path, 0o700, follow_symlinks=False)
            for filename in files:
                path = current_path / filename
                relative = path.relative_to(work).as_posix()
                entry = expected.get(relative)
                info = os.lstat(path)
                if (entry is None or not stat.S_ISREG(info.st_mode)
                        or stat.S_ISLNK(info.st_mode) or info.st_uid != os.geteuid()
                        or info.st_nlink != 1):
                    raise AttemptWorkspaceError("checked-out file metadata is unsafe")
                os.chmod(
                    path, 0o700 if entry.mode == "100755" else 0o600,
                    follow_symlinks=False,
                )
    except OSError as exc:
        raise AttemptWorkspaceError("checkout modes cannot be normalized safely") from exc


def _worktree_inventory(work: Path, entries: tuple[_TreeEntry, ...]) -> tuple[str, int, int]:
    expected = {entry.path: entry for entry in entries}
    actual: set[str] = set()
    records: list[dict[str, object]] = []
    total = 0
    try:
        for current, directories, files in os.walk(work, topdown=True, followlinks=False):
            current_path = Path(current)
            if current_path == work:
                if ".git" not in directories:
                    raise AttemptWorkspaceError("isolated clone lacks a Git directory")
                directories.remove(".git")
            for directory in directories:
                path = current_path / directory
                relative = path.relative_to(work).as_posix()
                _tree_path(relative)
                info = os.lstat(path)
                if (not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)
                        or info.st_uid != os.geteuid() or info.st_mode & 0o022):
                    raise AttemptWorkspaceError("checked-out directory metadata is unsafe")
            for filename in files:
                path = current_path / filename
                relative = path.relative_to(work).as_posix()
                _tree_path(relative)
                entry = expected.get(relative)
                if entry is None:
                    raise AttemptWorkspaceError("checkout contains an unregistered file")
                digest, info = _read_regular(path, entry)
                executable = bool(info.st_mode & 0o111)
                if executable != (entry.mode == "100755"):
                    raise AttemptWorkspaceError("checked-out file mode differs from the Git tree")
                actual.add(relative)
                total += entry.size
                records.append({
                    "content_sha256": digest,
                    "mode": entry.mode,
                    "path": relative,
                    "size": entry.size,
                })
    except OSError as exc:
        raise AttemptWorkspaceError("checkout cannot be inventoried safely") from exc
    if actual != set(expected):
        raise AttemptWorkspaceError("checkout file inventory differs from the Git tree")
    records.sort(key=lambda item: item["path"])
    return hashlib.sha256(_canonical(records)).hexdigest(), len(records), total


def _assert_no_hardlinked_objects(git_dir: Path) -> None:
    objects = git_dir / "objects"
    try:
        for current, directories, files in os.walk(objects, topdown=True, followlinks=False):
            for name in directories:
                info = os.lstat(Path(current) / name)
                if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
                    raise AttemptWorkspaceError("Git object directory is unsafe")
            for name in files:
                path = Path(current) / name
                info = os.lstat(path)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise AttemptWorkspaceError("Git object is shared or unsafe")
    except OSError as exc:
        raise AttemptWorkspaceError("Git objects cannot be inventoried safely") from exc


def _single_ascii_line(output: bytes, label: str, pattern: re.Pattern[str]) -> str:
    try:
        value = output.decode("ascii")
    except UnicodeDecodeError as exc:
        raise AttemptWorkspaceError(f"{label} is malformed") from exc
    if value != value.strip() + "\n" or not pattern.fullmatch(value.strip()):
        raise AttemptWorkspaceError(f"{label} is malformed")
    return value.strip()


def _branch_tip(
    git_dir: Path, branch: str, environment: Mapping[str, str],
    pass_fds: Sequence[int],
) -> str:
    output = _run_capture(
        _git_command(git_dir, "show-ref", "--verify", "--hash", f"refs/heads/{branch}"),
        environment=environment, max_bytes=128, pass_fds=pass_fds,
    )
    return _single_ascii_line(output, "expected branch identity", _HEX40)


def _prove_git_directory_identity(
    git_dir: Path, work_tree: Path, expected: os.stat_result,
    environment: Mapping[str, str], pass_fds: Sequence[int],
) -> None:
    for option in ("--git-dir", "--git-common-dir"):
        output = _run_capture(
            _git_command(git_dir, "rev-parse", option, work_tree=work_tree),
            environment=environment, max_bytes=4096, pass_fds=pass_fds,
        )
        try:
            value = output.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise AttemptWorkspaceError("Git directory identity is malformed") from exc
        if value != value.strip() + "\n" or value.strip() != str(git_dir):
            raise AttemptWorkspaceError("Git common-directory indirection is forbidden")
        try:
            returned = os.stat(value.strip())
        except OSError as exc:
            raise AttemptWorkspaceError("Git directory identity is unavailable") from exc
        if not _same_inode(returned, expected):
            raise AttemptWorkspaceError("Git directory identity changed")


def _read_head(git_fd: int) -> str:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        named = os.stat("HEAD", dir_fd=git_fd, follow_symlinks=False)
        fd = os.open("HEAD", flags, dir_fd=git_fd)
    except OSError as exc:
        raise AttemptWorkspaceError("detached HEAD cannot be verified") from exc
    try:
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or not _same_inode(named, before)
                or before.st_uid != os.geteuid() or before.st_nlink != 1
                or before.st_size > 128 or before.st_mode & 0o022):
            raise AttemptWorkspaceError("detached HEAD metadata is unsafe")
        data = os.read(fd, 129)
        after = os.fstat(fd)
        named_after = os.stat("HEAD", dir_fd=git_fd, follow_symlinks=False)
        if (len(data) > 128 or not _same_inode(before, after)
                or not _same_inode(after, named_after)
                or before.st_mtime_ns != after.st_mtime_ns
                or before.st_ctime_ns != after.st_ctime_ns
                or before.st_size != after.st_size):
            raise AttemptWorkspaceError("detached HEAD changed while reading")
    finally:
        os.close(fd)
    try:
        return data.decode("ascii").strip()
    except UnicodeDecodeError as exc:
        raise AttemptWorkspaceError("detached HEAD cannot be verified") from exc


def _assert_no_path_residue(git_dir: Path, needles: Sequence[bytes]) -> None:
    bounded_needles = tuple(item for item in needles if item)
    consumed = 0
    try:
        for current, directories, files in os.walk(git_dir, topdown=True, followlinks=False):
            current_path = Path(current)
            if current_path == git_dir and "objects" in directories:
                directories.remove("objects")
            for name in files:
                path = current_path / name
                info = os.lstat(path)
                if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                        or info.st_uid != os.geteuid() or info.st_mode & 0o022):
                    raise AttemptWorkspaceError("Git provenance metadata is unsafe")
                consumed += info.st_size
                if consumed > 16 * 1024 * 1024:
                    raise AttemptWorkspaceError("Git provenance scan exceeds its byte budget")
                flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
                         | getattr(os, "O_NOFOLLOW", 0))
                fd = os.open(path, flags)
                try:
                    opened = os.fstat(fd)
                    if (not _same_inode(info, opened) or opened.st_nlink != 1
                            or opened.st_size != info.st_size):
                        raise AttemptWorkspaceError("Git provenance metadata changed")
                    chunks: list[bytes] = []
                    remaining = opened.st_size
                    while remaining:
                        block = os.read(fd, min(65536, remaining))
                        if not block:
                            raise AttemptWorkspaceError("Git provenance metadata changed")
                        chunks.append(block)
                        remaining -= len(block)
                    if os.read(fd, 1):
                        raise AttemptWorkspaceError("Git provenance metadata changed")
                    after = os.fstat(fd)
                    named_after = os.lstat(path)
                    if (not _same_inode(opened, after) or not _same_inode(after, named_after)
                            or opened.st_size != after.st_size
                            or opened.st_mtime_ns != after.st_mtime_ns
                            or opened.st_ctime_ns != after.st_ctime_ns):
                        raise AttemptWorkspaceError("Git provenance metadata changed")
                    data = b"".join(chunks)
                finally:
                    os.close(fd)
                if any(needle in data for needle in bounded_needles):
                    raise AttemptWorkspaceError("Git metadata retained a source-path residue")
    except OSError as exc:
        raise AttemptWorkspaceError("Git provenance metadata cannot be scanned") from exc


def create_attempt_workspace(
    envelope: SignedTaskSpec,
    controller_hmac_key: bytes,
    repository_sources: Mapping[str, str | os.PathLike[str]],
    attempts_root: str | os.PathLike[str],
    *,
    expected_phase_attempt_id: str,
    expected_subject_sha: str,
    clock: Callable[[], int] | None = None,
) -> AttemptWorkspaceReceipt:
    """Create and verify ``<attempts_root>/<signed-attempt>/work``.

    ``repository_sources`` is trusted controller configuration.  Selection is
    by the authenticated repository slug, preventing a caller-selected source
    from being smuggled through the worker specification.

    The source branch is used only to capture the signed subject into a fresh
    clone.  Admission proves that clone's captured branch, detached HEAD, tree,
    and every blob.  Source-ref movement after capture is intentionally
    irrelevant and is not asserted by the returned receipt.  Attempt paths are
    single-use: controller state and any failed work are retained for explicit
    recovery, never destructively cleaned by this seam.
    """
    try:
        verified = verify_task_spec(
            envelope, controller_hmac_key, now=_clock_sample(clock),
            expected_phase_attempt_id=expected_phase_attempt_id,
            expected_subject_sha=expected_subject_sha,
        )
    except TaskSpecError as exc:
        raise AttemptWorkspaceError("task specification authentication failed") from exc
    if not isinstance(repository_sources, Mapping):
        raise AttemptWorkspaceError("trusted repository registry is required")
    try:
        source_value = repository_sources[verified.spec.repository]
    except (KeyError, TypeError) as exc:
        raise AttemptWorkspaceError("task repository is not registered") from exc
    attempts = Path(attempts_root)
    attempts_fd, attempts_info = _open_private_directory(attempts, "attempts root")
    attempt_name = verified.spec.phase_attempt_id
    root = attempts / attempt_name
    root_fd: int | None = None
    root_info: os.stat_result | None = None
    source_fd: int | None = None
    source_git_fd: int | None = None
    source_config_fd: int | None = None
    temporary_fd: int | None = None
    work_fd: int | None = None
    work_git_fd: int | None = None
    work_info: os.stat_result | None = None
    temporary_info: os.stat_result | None = None
    temporary_name: str | None = None
    try:
        try:
            os.mkdir(attempt_name, mode=0o700, dir_fd=attempts_fd)
        except FileExistsError as exc:
            raise AttemptWorkspaceError(
                "phase attempt path is consumed and requires controller recovery"
            ) from exc
        except OSError as exc:
            raise AttemptWorkspaceError("phase attempt cannot be allocated") from exc
        try:
            root_fd, root_info = _open_child_directory(
                attempts_fd, attempt_name, "phase attempt directory",
            )
            if stat.S_IMODE(root_info.st_mode) != 0o700:
                raise AttemptWorkspaceError(
                    "phase attempt directory must remain mode 0700"
                )
            existing_names = os.listdir(root_fd)
        except OSError as exc:
            raise AttemptWorkspaceError("phase attempt cannot be inventoried") from exc
        if existing_names:
            raise AttemptWorkspaceError(
                "attempt path is consumed and requires controller recovery"
            )
        os.fsync(attempts_fd)

        source, source_fd, source_info, source_git_fd, source_git_info = _trusted_source(
            source_value
        )
        if source == root or source in root.parents or root in source.parents:
            raise AttemptWorkspaceError("trusted source and attempt root must be disjoint")

        temporary_name = f".gauntlet-git-{verified.spec.phase_attempt_id}"
        try:
            os.mkdir(temporary_name, mode=0o700, dir_fd=root_fd)
        except FileExistsError as exc:
            raise AttemptWorkspaceError(
                "attempt path is consumed and requires controller recovery"
            ) from exc
        except OSError as exc:
            raise AttemptWorkspaceError("private Git state cannot be allocated") from exc
        temporary_fd, temporary_info = _open_child_directory(
            root_fd, temporary_name, "private Git state",
        )
        os.mkdir("home", mode=0o700, dir_fd=temporary_fd)
        private = _fd_path(temporary_fd)
        home = private / "home"
        source_git = _fd_path(source_git_fd)
        environment = _git_environment(home)
        source_pass_fds = (temporary_fd, source_git_fd)

        _validate_git_metadata(source_git, allow_samples=True)
        source_config_fd, source_config_snapshot = _pin_source_config(source_git)
        _validate_config(source_git, environment, source_pass_fds, source=True)
        _recheck_source_config(source_git, source_config_fd, source_config_snapshot)
        branch_sha = _branch_tip(
            source_git, verified.spec.expected_branch, environment, source_pass_fds,
        )
        if branch_sha != verified.spec.subject_sha:
            raise AttemptWorkspaceError("expected branch does not match the signed subject SHA")
        _run_quiet(
            _git_command(source_git, "cat-file", "-e", f"{verified.spec.base_sha}^{{commit}}"),
            environment=environment, pass_fds=source_pass_fds,
        )
        _run_quiet(
            _git_command(source_git, "cat-file", "-e", f"{verified.spec.subject_sha}^{{commit}}"),
            environment=environment, pass_fds=source_pass_fds,
        )
        _run_quiet(
            _git_command(
                source_git, "merge-base", "--is-ancestor",
                verified.spec.base_sha, verified.spec.subject_sha,
            ),
            environment=environment, pass_fds=source_pass_fds,
        )
        source_entries = _tree_entries(
            source_git, verified.spec.subject_sha, environment, source_pass_fds,
        )

        try:
            os.mkdir("work", mode=0o700, dir_fd=root_fd)
        except FileExistsError as exc:
            raise AttemptWorkspaceError(
                "attempt destination must remain fresh until controller ownership"
            ) from exc
        except OSError as exc:
            raise AttemptWorkspaceError("attempt destination cannot be created") from exc
        try:
            work_info = os.stat("work", dir_fd=root_fd, follow_symlinks=False)
            work_fd, work_info = _open_child_directory(
                root_fd, "work", "attempt destination",
            )
        except OSError as exc:
            raise AttemptWorkspaceError("attempt destination cannot be pinned") from exc
        work = _fd_path(work_fd)
        clone_argv = (
            _GIT, "clone", "--no-local", "--no-hardlinks", "--no-checkout",
            "--no-recurse-submodules", "--single-branch", "--no-tags",
            f"--branch={verified.spec.expected_branch}",
            "--config=core.logAllRefUpdates=false", "--template=", "--",
            str(source_git), str(work),
        )
        _recheck_source_config(source_git, source_config_fd, source_config_snapshot)
        _run_quiet(
            clone_argv, environment=environment,
            pass_fds=(temporary_fd, source_git_fd, work_fd),
        )
        # Command-scope protected configuration prevents attacker-selected
        # helpers from running inside clone/upload-pack.  Any source metadata
        # drift during capture still rejects the attempt before admission.
        _recheck_source_config(source_git, source_config_fd, source_config_snapshot)
        _validate_git_metadata(source_git, allow_samples=True)
        _validate_config(source_git, environment, source_pass_fds, source=True)
        _recheck_child_directory(
            root_fd, "work", work_fd, work_info, "attempt destination",
        )
        work_git_fd, work_git_info = _open_child_directory(
            work_fd, ".git", "isolated Git metadata",
        )
        git_dir = _fd_path(work_git_fd)
        work_pass_fds = (temporary_fd, work_fd, work_git_fd)

        _validate_git_metadata(git_dir, allow_samples=False)
        _prove_git_directory_identity(
            git_dir, work, work_git_info, environment, work_pass_fds,
        )
        if _branch_tip(
            git_dir, verified.spec.expected_branch, environment, work_pass_fds,
        ) != verified.spec.subject_sha:
            raise AttemptWorkspaceError(
                "cloned snapshot branch does not match the signed subject SHA"
            )
        _run_quiet(
            _git_command(git_dir, "remote", "remove", "origin", work_tree=work),
            environment=environment, pass_fds=work_pass_fds,
        )
        _validate_config(git_dir, environment, work_pass_fds, source=False)
        _run_quiet(
            _git_command(git_dir, "cat-file", "-e", f"{verified.spec.base_sha}^{{commit}}"),
            environment=environment, pass_fds=work_pass_fds,
        )
        _run_quiet(
            _git_command(git_dir, "cat-file", "-e", f"{verified.spec.subject_sha}^{{commit}}"),
            environment=environment, pass_fds=work_pass_fds,
        )
        _run_quiet(
            _git_command(
                git_dir, "merge-base", "--is-ancestor",
                verified.spec.base_sha, verified.spec.subject_sha,
            ),
            environment=environment, pass_fds=work_pass_fds,
        )
        if _tree_entries(
            git_dir, verified.spec.subject_sha, environment, work_pass_fds,
        ) != source_entries:
            raise AttemptWorkspaceError("isolated clone object inventory differs from source")
        _run_quiet(
            _git_command(
                git_dir, "checkout", "--detach", "--force", "--no-recurse-submodules",
                verified.spec.subject_sha, work_tree=work,
            ),
            environment=environment, pass_fds=work_pass_fds,
        )
        if _read_head(work_git_fd) != verified.spec.subject_sha:
            raise AttemptWorkspaceError("attempt checkout is not detached at the signed subject")
        _normalize_worktree_modes(work, source_entries)
        tree_sha = _single_ascii_line(
            _run_capture(
                _git_command(
                    git_dir, "rev-parse", "--verify",
                    f"{verified.spec.subject_sha}^{{tree}}", work_tree=work,
                ),
                environment=environment, max_bytes=128, pass_fds=work_pass_fds,
            ),
            "Git tree identity", _HEX40,
        )
        if _run_capture(
            _git_command(git_dir, "remote", work_tree=work),
            environment=environment, max_bytes=4096, pass_fds=work_pass_fds,
        ):
            raise AttemptWorkspaceError("isolated clone retained a remote")
        if _run_capture(
            _git_command(
                git_dir, "status", "--porcelain=v1", "-z", "--untracked-files=all",
                work_tree=work,
            ),
            environment=environment, max_bytes=1024 * 1024,
            pass_fds=work_pass_fds,
        ):
            raise AttemptWorkspaceError("isolated checkout is not clean")
        _validate_git_metadata(git_dir, allow_samples=False)
        _validate_config(git_dir, environment, work_pass_fds, source=False)
        _assert_no_hardlinked_objects(git_dir)
        inventory_sha256, file_count, total_bytes = _worktree_inventory(
            work, source_entries,
        )

        # Final admission revalidates only the immutable clone.  The controller
        # source is irrelevant after the clone's own branch and objects have
        # been proven above.
        _validate_git_metadata(git_dir, allow_samples=False)
        _validate_config(git_dir, environment, work_pass_fds, source=False)
        _prove_git_directory_identity(
            git_dir, work, work_git_info, environment, work_pass_fds,
        )
        _assert_no_path_residue(
            git_dir, (str(source).encode("utf-8"), str(source_git).encode("ascii")),
        )
        if temporary_name is None or temporary_fd is None or temporary_info is None:
            raise AttemptWorkspaceError("private Git state was not pinned")
        if root_info is None:
            raise AttemptWorkspaceError("phase attempt directory was not pinned")
        if _read_head(work_git_fd) != verified.spec.subject_sha:
            raise AttemptWorkspaceError(
                "final admission HEAD is not detached at the signed subject"
            )
        if _run_capture(
            _git_command(
                git_dir, "status", "--porcelain=v1", "-z", "--untracked-files=all",
                work_tree=work,
            ),
            environment=environment, max_bytes=1024 * 1024,
            pass_fds=work_pass_fds,
        ):
            raise AttemptWorkspaceError("final admission checkout is not clean")
        final_inventory = _worktree_inventory(work, source_entries)
        if final_inventory != (inventory_sha256, file_count, total_bytes):
            raise AttemptWorkspaceError(
                "final admission inventory metrics changed"
            )
        try:
            final_verified = verify_task_spec(
                envelope, controller_hmac_key, now=_clock_sample(clock),
                expected_phase_attempt_id=expected_phase_attempt_id,
                expected_subject_sha=expected_subject_sha,
            )
        except TaskSpecError as exc:
            raise AttemptWorkspaceError("task specification changed before admission") from exc
        if final_verified.task_spec_sha256 != verified.task_spec_sha256:
            raise AttemptWorkspaceError("task specification identity changed")

        # The injectable clock above is the final interceptable callback.  Make
        # the canonical namespace chain the actual last admission I/O, from the
        # configured root down to the isolated Git directory.  No worker-visible
        # receipt exists until every held inode is still at its exact name/mode.
        _recheck_named_directory(
            attempts, attempts_fd, attempts_info, "attempts root", private=True,
        )
        _recheck_child_directory(
            attempts_fd, attempt_name, root_fd, root_info, "phase attempt directory",
        )
        if stat.S_IMODE(os.fstat(root_fd).st_mode) != 0o700:
            raise AttemptWorkspaceError("phase attempt directory mode changed")
        _recheck_child_directory(
            root_fd, temporary_name, temporary_fd, temporary_info, "private Git state",
        )
        _recheck_child_directory(
            root_fd, "work", work_fd, work_info, "attempt destination",
        )
        _recheck_child_directory(
            work_fd, ".git", work_git_fd, work_git_info, "isolated Git metadata",
        )

        receipt = AttemptWorkspaceReceipt(
            task_spec_sha256=verified.task_spec_sha256,
            phase_attempt_id=verified.spec.phase_attempt_id,
            repository=verified.spec.repository,
            base_sha=verified.spec.base_sha,
            subject_sha=verified.spec.subject_sha,
            expected_branch=verified.spec.expected_branch,
            git_tree_sha=tree_sha,
            inventory_sha256=inventory_sha256,
            file_count=file_count,
            total_bytes=total_bytes,
        )
        return receipt
    finally:
        if work_git_fd is not None:
            try:
                os.close(work_git_fd)
            except OSError:
                pass
        if work_fd is not None:
            try:
                os.close(work_fd)
            except OSError:
                pass
        for descriptor in (source_config_fd, source_git_fd, source_fd):
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
        if temporary_fd is not None:
            try:
                os.close(temporary_fd)
            except OSError:
                pass
        if root_fd is not None:
            os.close(root_fd)
        os.close(attempts_fd)


# A descriptive alias for controller call sites.
materialize_attempt_workspace = create_attempt_workspace
