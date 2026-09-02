"""PID reuse-resistant proof based on a live process's observed argv."""
import hashlib
import os
import shlex
import subprocess
from dataclasses import dataclass


class ProcessProofError(RuntimeError):
    pass


def argv_digest(argv):
    if not isinstance(argv, (tuple, list)) or not argv or any(not isinstance(x, str) or "\x00" in x for x in argv):
        raise ProcessProofError("argv must be a nonempty string sequence")
    return hashlib.sha256("\0".join(argv).encode("utf-8")).hexdigest()


def process_start_ticks(pid):
    if not isinstance(pid, int) or pid <= 0: raise ProcessProofError("invalid pid")
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as stream: text = stream.read(4096)
        return int(text[text.rfind(")") + 2:].split()[19])
    except FileNotFoundError:
        try:
            value = subprocess.check_output(("/bin/ps", "-o", "lstart=", "-p", str(pid)), stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True, timeout=1).strip()
            if not value: raise ValueError("empty lstart")
            return int(hashlib.sha256(value.encode()).hexdigest()[:15], 16)
        except (OSError, subprocess.SubprocessError, ValueError) as exc: raise ProcessProofError("cannot determine process start identity") from exc
    except (OSError, ValueError, IndexError) as exc: raise ProcessProofError("cannot determine process start identity") from exc


def observed_argv(pid, max_bytes=65_536):
    """Read the running process argv; never treat caller input as proof."""
    if not isinstance(pid, int) or pid <= 0 or max_bytes < 1: raise ProcessProofError("invalid process observation")
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as stream: raw = stream.read(max_bytes + 1)
        if len(raw) > max_bytes or not raw or not raw.endswith(b"\0"): raise ValueError("invalid cmdline")
        return tuple(x.decode("utf-8", "surrogateescape") for x in raw[:-1].split(b"\0"))
    except FileNotFoundError:
        try:
            raw = subprocess.check_output(("/bin/ps", "-o", "command=", "-p", str(pid)), stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1)
            if len(raw) > max_bytes or not raw.strip(): raise ValueError("empty command")
            return tuple(shlex.split(raw.decode("utf-8", "strict").strip()))
        except (OSError, UnicodeError, ValueError, subprocess.SubprocessError) as exc: raise ProcessProofError("cannot observe process argv") from exc
    except (OSError, UnicodeError, ValueError) as exc: raise ProcessProofError("cannot observe process argv") from exc


@dataclass(frozen=True)
class ProcessProof:
    pid: int
    start_ticks: int
    argv_sha256: str

    @classmethod
    def capture(cls, pid, expected_argv):
        observed = observed_argv(pid)
        if argv_digest(observed) != argv_digest(expected_argv): raise ProcessProofError("observed process argv does not match expected fixed argv")
        return cls(pid, process_start_ticks(pid), argv_digest(observed))

    def matches(self, expected_argv):
        try:
            observed = observed_argv(self.pid)
            return self.start_ticks == process_start_ticks(self.pid) and self.argv_sha256 == argv_digest(observed) == argv_digest(expected_argv)
        except ProcessProofError: return False

    def require_match(self, expected_argv):
        if not self.matches(expected_argv): raise ProcessProofError("process proof mismatch; PID reuse/adoption refused")
