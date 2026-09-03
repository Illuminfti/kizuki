"""Fail-closed, probe-only harness adapters."""
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from .safe_io import SafeIOError, sha256_regular_nofollow_with_identity

_PROBES = {"codex": ("--version",), "claude": ("--version",), "cursor": ("--version",), "grok": ("--version",)}
_SECRET_MARKERS = ("token", "secret", "password", "authorization", "bearer", "api_key", "apikey")
IDENTITY_MAX_AGE_SECONDS = 3600


def _bounded_version(argv, timeout, env, limit=4096):
    """Run one fixed version argv with bounded memory and process-group cleanup."""
    proc=subprocess.Popen(argv,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env,start_new_session=True)
    output=bytearray(); truncated=[False]
    def drain():
        try:
            while True:
                chunk=proc.stdout.read(65536)
                if not chunk: return
                remaining=limit-len(output)
                if remaining>0: output.extend(chunk[:remaining])
                if len(chunk)>remaining: truncated[0]=True
        except (OSError,ValueError):
            return
    reader=threading.Thread(target=drain,daemon=True); reader.start(); timed_out=False
    try:
        try: proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out=True
            try: os.killpg(proc.pid,signal.SIGTERM)
            except ProcessLookupError: pass
            try: proc.wait(timeout=.25)
            except subprocess.TimeoutExpired:
                try: os.killpg(proc.pid,signal.SIGKILL)
                except ProcessLookupError: pass
                proc.wait(timeout=1)
    finally:
        # A launcher may exit after leaving descendants holding the output pipe.
        try: os.killpg(proc.pid,signal.SIGKILL)
        except ProcessLookupError: pass
        if proc.poll() is None:
            try: proc.wait(timeout=1)
            except subprocess.TimeoutExpired: pass
        reader.join(timeout=1)
        if reader.is_alive():
            try: proc.stdout.close()
            except (OSError,AttributeError): pass
            reader.join(timeout=1)
        else:
            try: proc.stdout.close()
            except (OSError,AttributeError): pass
    return proc.returncode,bytes(output),timed_out,truncated[0]


def _safe_text(value, limit=300):
    """Keep operational output useful without disclosing a path or credential."""
    value = " ".join((value or "").replace("\x00", "").split())
    if any(marker in value.lower() for marker in _SECRET_MARKERS):
        return "[redacted]"
    value = re.sub(r"file:///\S+|(?<![A-Za-z0-9._-])/(?:[^\s]+)", "[path]", value)
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
                code,output,timed_out,truncated = _bounded_version(
                    argv,max(0.1,min(float(self.timeout_seconds),15.0)),
                    {"PATH":"/usr/bin:/bin","HOME":probe_home,"LANG":"C","LC_ALL":"C"},
                )
        except subprocess.TimeoutExpired:
            result["error"] = "version probe timed out"
            return result
        except OSError:
            result["error"] = "version probe could not start"
            return result
        if timed_out:
            result["error"] = "version probe timed out"
            return result
        result["exit_code"] = code
        result["version"] = _safe_text(output.decode("utf-8","replace"))
        result["version_output_truncated"] = truncated
        result["version_probe_ok"] = code == 0
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


def validate_identities(adapters, receipts):
    """Hash configured executables once, outside observer request handling."""
    checked_at=time.time(); configured={adapter.name:adapter for adapter in adapters}; result={}
    for receipt in receipts:
        name=receipt.get("name"); adapter=configured.get(name); current=False; executable=None; fingerprint=None
        if adapter is not None:
            executable=adapter._resolved()
            if executable is not None:
                try:
                    digest, fingerprint = sha256_regular_nofollow_with_identity(executable,1024**3)
                    current=digest==receipt.get("executable_sha256")
                except SafeIOError: current=False
        item={"current":current,"checked_at":checked_at}
        if executable is not None and fingerprint is not None:
            item["cache_token"]=(os.fspath(executable),fingerprint)
        result[name]=item
    return result


def statuses(_adapters=(), receipts=(), now=None, identities=None):
    """Project persisted operator attestations without touching an executable.

    ``_adapters`` is retained for compatibility with existing callers, but is
    deliberately ignored. A GET observer request must not execute, resolve,
    stat, or hash a configured harness binary.
    """
    now = time.time() if now is None else now
    allowed_auth = {"READY", "FAILED", "UNKNOWN"}
    allowed_route = {"READY", "QUOTA_BLOCKED", "FAILED", "UNKNOWN"}
    by_name = {}; identities=identities or {}
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
        valid_pairs={
            "ISOLATED_ROUTE_PROBE": {("READY","READY")},
            "PROVIDER_QUOTA_BLOCKED": {("READY","QUOTA_BLOCKED")},
            "AUTH_CHECK": {("READY","UNKNOWN"),("FAILED","UNKNOWN"),("UNKNOWN","UNKNOWN")},
            "PROBE_FAILED": {("READY","FAILED"),("FAILED","FAILED"),("UNKNOWN","FAILED")},
        }
        if not isinstance(version, str) or not isinstance(evidence, str) or len(evidence) != 64:
            continue
        if not isinstance(executable, str) or len(executable) != 64:
            continue
        if method != "operator-attested-isolated-probe-v1" or reason_code not in {"ISOLATED_ROUTE_PROBE", "PROVIDER_QUOTA_BLOCKED", "AUTH_CHECK", "PROBE_FAILED"}:
            continue
        if (auth_status,route_status) not in valid_pairs[reason_code]:
            continue
        if not isinstance(checked_at, (int, float)) or not isinstance(expires_at, (int, float)):
            continue
        identity=identities.get(name,{})
        identity_checked_at=identity.get("checked_at")
        identity_fresh=isinstance(identity_checked_at,(int,float)) and not isinstance(identity_checked_at,bool) and 0<=now-identity_checked_at<=IDENTITY_MAX_AGE_SECONDS
        identity_current=identity.get("current") is True and identity_fresh
        fresh = expires_at > now
        effective=fresh and identity_current
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
            "identity_current": identity_current,
            "identity_checked_at": identity_checked_at if identity_fresh else None,
            "auth_ready": bool(effective and auth_status == "READY"),
            "route_ready": bool(effective and route_status == "READY"),
            "ready": bool(effective and auth_status == "READY" and route_status == "READY"),
            "execution_enabled": False,
        }
    missing = lambda name: {
        "name": name, "auth_status": "UNKNOWN", "route_status": "UNKNOWN",
        "attestation": "missing", "fresh": False, "auth_ready": False,
        "identity_current": False, "route_ready": False, "ready": False, "execution_enabled": False,
    }
    return [by_name.get(name, missing(name)) for name in _PROBES]
