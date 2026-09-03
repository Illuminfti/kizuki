"""Persistent, execution-disabled Gauntlet control-loop heartbeat.

This module is deliberately a *reader* of controller state.  It does not claim
the controller epoch, launch a worker, invoke an adapter, or contact a network
service.  It verifies configured executable identity by hashing the regular
file named in each adapter receipt.  Its only mutations are the private,
atomically-replaced loop status file and the advisory loop-owner lock.
"""
import fcntl
import json
import os
import signal
import stat
import time
import uuid
from pathlib import Path

from .adapters import statuses, validate_identities
from .core import Guard, GuardError, Limits, Store


DEFAULT_INTERVAL_SECONDS = 30.0
_STATUS_NAME = "loop-status.json"
_LOCK_NAME = ".loop.lock"


class LoopAlreadyRunning(RuntimeError):
    """Another loop process holds the state-directory loop lock."""


class ControlLoop:
    """A fail-closed, fixed-cadence status publisher.

    ``max_iterations`` exists only for deterministic tests and one-shot
    diagnostics.  Production callers use ``run()`` with no limit.
    """

    def __init__(self, state_dir, limits=None, interval_seconds=DEFAULT_INTERVAL_SECONDS,
                 store_factory=Store, clock=time.time, monotonic=time.monotonic,
                 sleeper=time.sleep, session_id=None, adapters=(),
                 identity_validator=validate_identities):
        if not isinstance(interval_seconds, (int, float)) or isinstance(interval_seconds, bool) or not 1 <= interval_seconds <= 3600:
            raise ValueError("loop interval must be 1..3600 seconds")
        self.root = Path(state_dir)
        self.limits = limits or Limits()
        self.interval_seconds = float(interval_seconds)
        self.store_factory = store_factory
        self.clock = clock
        self.monotonic = monotonic
        self.sleeper = sleeper
        self.adapters = tuple(adapters)
        self.identity_validator = identity_validator
        self.session_id = session_id or str(uuid.uuid4())
        self.started_at = self.clock()
        self._lock_fd = None
        self._stop_requested = False
        self._iteration = 0

    def request_stop(self, *_):
        """Signal-safe intent marker; the run loop performs the only write."""
        self._stop_requested = True

    def _open_lock(self):
        if self.root.is_symlink():
            raise GuardError("state directory may not be a symlink")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = os.lstat(self.root)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise GuardError("state directory must be an owned real directory")
        os.chmod(self.root, 0o700)
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        root_fd = os.open(str(self.root), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        try:
            fd = os.open(_LOCK_NAME, flags, 0o600, dir_fd=root_fd)
        except OSError as exc:
            raise GuardError("cannot safely open loop lock") from exc
        finally:
            os.close(root_fd)
        try:
            item = os.fstat(fd)
            if not stat.S_ISREG(item.st_mode) or item.st_uid != os.geteuid():
                raise GuardError("loop lock must be an owned regular file")
            os.fchmod(fd, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise LoopAlreadyRunning("control loop already running") from exc
            self._lock_fd = fd
        except Exception:
            os.close(fd)
            raise

    def _close_lock(self):
        if self._lock_fd is not None:
            try:
                fcntl.flock(self._lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(self._lock_fd)
                self._lock_fd = None

    def _atomic_status(self, payload):
        """Write only a private regular JSON status file via same-dir rename."""
        data = (json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        root_fd = os.open(str(self.root), os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0))
        tmp_name = ".loop-status-%s.tmp" % uuid.uuid4().hex
        try:
            try:
                existing = os.stat(_STATUS_NAME, dir_fd=root_fd, follow_symlinks=False)
                if not stat.S_ISREG(existing.st_mode) or existing.st_uid != os.geteuid():
                    raise GuardError("loop status must be an owned regular file")
            except FileNotFoundError:
                pass
            fd = os.open(tmp_name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0), 0o600, dir_fd=root_fd)
            try:
                offset = 0
                while offset < len(data):
                    offset += os.write(fd, data[offset:])
                os.fchmod(fd, 0o600)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.replace(tmp_name, _STATUS_NAME, src_dir_fd=root_fd, dst_dir_fd=root_fd)
            os.fsync(root_fd)
        except Exception:
            try:
                os.unlink(tmp_name, dir_fd=root_fd)
            except OSError:
                pass
            raise
        finally:
            os.close(root_fd)

    @staticmethod
    def _summary(snapshot):
        def counts(rows, key):
            out = {}
            for row in rows:
                value = row.get(key, "UNKNOWN")
                out[value] = out.get(value, 0) + 1
            return out
        return {
            "campaigns": {"count": len(snapshot["campaigns"]), "states": counts(snapshot["campaigns"], "state")},
            "tasks": {"count": len(snapshot["tasks"]), "states": counts(snapshot["tasks"], "state")},
            "incidents": {"count": len(snapshot["incidents"]), "kinds": counts(snapshot["incidents"], "kind")},
        }

    def tick(self):
        """Check controller state and publish one non-authoritative heartbeat."""
        self._iteration += 1
        now = self.clock()
        reasons = []
        summary = {"campaigns": {"count": 0, "states": {}}, "tasks": {"count": 0, "states": {}}, "incidents": {"count": 0, "kinds": {}}}
        adapter_status = statuses(self.adapters, ())
        try:
            with self.store_factory(str(self.root)) as store:
                store.verify_integrity()
                Guard(self.limits).check(store)
                snapshot = store.snapshot()
                summary = self._summary(snapshot)
                # Identity validation hashes the configured regular files; it
                # never invokes a harness or inherits its environment.
                identities = self.identity_validator(self.adapters, snapshot["adapter_receipts"])
                # The validator timestamps its result. Sample the projection
                # clock afterwards so a just-created identity cannot appear
                # to come from the future by a few microseconds.
                now = self.clock()
                adapter_status = statuses(self.adapters, snapshot["adapter_receipts"], now=now, identities=identities)
        except (GuardError, OSError, ValueError, TypeError, KeyError, AttributeError) as exc:
            reasons.append("integrity_or_guard_failed:%s" % type(exc).__name__)
        except Exception as exc:
            # Database drivers and injected stores may expose implementation-
            # specific exception classes.  Publish a fail-closed receipt so a
            # prior RUNNING file cannot survive a failed tick.
            reasons.append("integrity_or_guard_failed:%s" % type(exc).__name__)
        if any(not item["ready"] for item in adapter_status):
            reasons.append("adapter_readiness_incomplete")
        payload = {
            "schema": "kizuki-gauntlet-loop-status-v1",
            "pid": os.getpid(),
            "session_id": self.session_id,
            "started_at": self.started_at,
            "iteration": self._iteration,
            "updated_at": now,
            "state": "RUNNING" if not reasons else "DEGRADED",
            "execution_enabled": False,
            "merge_enabled": False,
            "reasons": reasons,
            "summary": summary,
            "adapters": [{"name": item["name"], "auth_status": item["auth_status"], "route_status": item["route_status"], "ready": item["ready"]} for item in adapter_status],
        }
        self._atomic_status(payload)
        return payload

    def _stopped(self):
        payload = {
            "schema": "kizuki-gauntlet-loop-status-v1", "pid": os.getpid(),
            "session_id": self.session_id, "iteration": self._iteration,
            "started_at": self.started_at,
            "updated_at": self.clock(), "state": "STOPPED",
            "execution_enabled": False, "merge_enabled": False,
            "reasons": ["clean_stop_requested"],
        }
        self._atomic_status(payload)
        return payload

    def run(self, max_iterations=None):
        if max_iterations is not None and (not isinstance(max_iterations, int) or max_iterations < 1):
            raise ValueError("max_iterations must be a positive integer")
        self._open_lock()
        old_handler = None
        install_handler = signal.getsignal(signal.SIGTERM)
        if hasattr(signal, "SIGTERM"):
            try:
                old_handler = install_handler
                signal.signal(signal.SIGTERM, self.request_stop)
            except ValueError:  # Tests can run the loop from a helper thread.
                old_handler = None
        try:
            next_tick = self.monotonic()
            while not self._stop_requested:
                self.tick()
                if max_iterations is not None and self._iteration >= max_iterations:
                    break
                next_tick += self.interval_seconds
                delay = max(0.0, next_tick - self.monotonic())
                if delay:
                    self.sleeper(delay)
            return self._stopped()
        finally:
            if old_handler is not None:
                signal.signal(signal.SIGTERM, old_handler)
            self._close_lock()
