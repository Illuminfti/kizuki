"""Fail-closed, probe-only harness adapters."""
import os
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

_PROBES = {"codex": ("--version",), "claude": ("--version",), "cursor": ("--version",), "grok": ("--version",)}
_SECRET_MARKERS = ("token", "secret", "password", "authorization", "bearer", "api_key", "apikey")


def _safe_text(value, limit=300):
    """Keep operational output useful without disclosing a path or credential."""
    value = " ".join((value or "").replace("\x00", "").split())
    if any(marker in value.lower() for marker in _SECRET_MARKERS):
        return "[redacted]"
    return value[:limit]


@dataclass(frozen=True)
class Adapter:
    name: str
    executable: str
    execute_enabled: bool = False
    timeout_seconds: float = 5.0

    def _resolved(self):
        # PATH lookup is prohibited: it permits command shadowing and ambient shell state.
        if not os.path.isabs(self.executable):
            return None
        try:
            path = Path(self.executable).resolve(strict=True)
        except (OSError, RuntimeError):
            return None
        if not path.is_file() or not os.access(path, os.X_OK):
            return None
        return path

    def probe(self):
        """Run a fixed, bounded version command; never pass prompts or environment secrets."""
        path = self._resolved()
        result = {"name": self.name, "configured_absolute": os.path.isabs(self.executable),
                  "installed": bool(path), "found": bool(path), "regular_executable": bool(path),
                  "version_probe_ok": False, "auth_ready": "unknown", "route_ready": False,
                  "execution_enabled": False, "probe_only": True, "ready": False}
        if not path:
            result["error"] = "configured executable is absent, non-regular, non-executable, or not an absolute path"
            return result
        argv = (str(path), *_PROBES.get(self.name, ("--version",)))
        try:
            # Version discovery gets an empty disposable HOME. It is never an
            # authentication or route check and cannot inherit harness config.
            with tempfile.TemporaryDirectory(prefix="kizuki-gauntlet-probe-") as probe_home:
                completed = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                           stderr=subprocess.STDOUT, text=True,
                                           timeout=max(0.1, min(float(self.timeout_seconds), 15.0)),
                                           env={"PATH": "/usr/bin:/bin", "HOME": probe_home, "LANG": "C", "LC_ALL": "C"}, check=False)
        except subprocess.TimeoutExpired:
            result["error"] = "version probe timed out"
            return result
        except OSError:
            result["error"] = "version probe could not start"
            return result
        result["exit_code"] = completed.returncode
        result["version"] = _safe_text(completed.stdout)
        result["version_probe_ok"] = completed.returncode == 0
        # A version command is not authentication or a real route receipt.
        # Keep readiness false until a separately persisted, approved route test exists.
        if not result["version_probe_ok"]:
            result["error"] = "version probe failed"
        return result

    def execute(self, *_):
        raise PermissionError("execution disabled: this Gauntlet build is observer/bootstrap only")


def defaults(config_adapters=None):
    paths = {"codex": "/home/ubuntu/.local/bin/codex", "claude": "/home/ubuntu/.local/bin/claude",
             "cursor": "/home/ubuntu/.local/bin/cursor-agent", "grok": "/home/ubuntu/.grok/bin/grok"}
    configured = config_adapters or {}
    return [Adapter(name, str(configured.get(name, {}).get("path", path)), False,
                    float(configured.get(name, {}).get("timeout_seconds", 5))) for name, path in paths.items()]


def statuses(_adapters=(), receipts=(), now=None):
    """Project persisted operator attestations without touching an executable.

    ``_adapters`` is retained for compatibility with existing callers, but is
    deliberately ignored. A GET observer request must not execute, resolve,
    stat, or hash a configured harness binary.
    """
    now = time.time() if now is None else now
    allowed_auth = {"READY", "FAILED", "UNKNOWN"}
    allowed_route = {"READY", "QUOTA_BLOCKED", "FAILED", "UNKNOWN"}
    by_name = {}
    for receipt in receipts:
        if not isinstance(receipt, dict):
            continue
        name = receipt.get("name")
        if name not in _PROBES or name in by_name:
            continue
        auth_status = receipt.get("auth_status")
        route_status = receipt.get("route_status")
        version = receipt.get("version")
        evidence = receipt.get("evidence_sha256")
        executable = receipt.get("executable_sha256")
        method = receipt.get("method")
        reason_code = receipt.get("reason_code")
        checked_at = receipt.get("checked_at")
        expires_at = receipt.get("expires_at")
        if auth_status not in allowed_auth or route_status not in allowed_route:
            continue
        if not isinstance(version, str) or not isinstance(evidence, str) or len(evidence) != 64:
            continue
        if not isinstance(executable, str) or len(executable) != 64:
            continue
        if method != "operator-attested-isolated-probe-v1" or reason_code not in {"ISOLATED_ROUTE_PROBE", "PROVIDER_QUOTA_BLOCKED", "AUTH_CHECK", "PROBE_FAILED"}:
            continue
        if not isinstance(checked_at, (int, float)) or not isinstance(expires_at, (int, float)):
            continue
        fresh = expires_at > now
        by_name[name] = {
            "name": name,
            "version": version,
            "auth_status": auth_status,
            "route_status": route_status,
            "evidence_sha256": evidence,
            "executable_sha256": executable,
            "method": method,
            "reason_code": reason_code,
            "checked_at": checked_at,
            "expires_at": expires_at,
            "attestation": "operator-attested",
            "fresh": fresh,
            "auth_ready": bool(fresh and auth_status == "READY"),
            "route_ready": bool(fresh and route_status == "READY"),
            "ready": bool(fresh and auth_status == "READY" and route_status == "READY"),
            "execution_enabled": False,
        }
    missing = lambda name: {
        "name": name, "auth_status": "UNKNOWN", "route_status": "UNKNOWN",
        "attestation": "missing", "fresh": False, "auth_ready": False,
        "route_ready": False, "ready": False, "execution_enabled": False,
    }
    return [by_name.get(name, missing(name)) for name in _PROBES]
