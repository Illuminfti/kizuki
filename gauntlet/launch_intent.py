"""Authenticated receipt for one durably admitted launch operation.

The protocol/store layer must sign this receipt in the same transaction that
revalidates the live lease, CASes the task row, consumes authority, and inserts
the unique launch intent.  Sandbox construction may authenticate and accept
the receipt, but may never mint one from caller-supplied "current" state.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
import hashlib
import hmac
import json
import re


class LaunchIntentError(RuntimeError):
    pass


LAUNCH_INTENT_SCHEMA = "kizuki-gauntlet-launch-intent-v1"
LAUNCH_INTENT_MAC_DOMAIN = b"kizuki-gauntlet-launch-intent-hmac-v1\0"
LAUNCH_OPERATION_DOMAIN = b"kizuki-gauntlet-launch-operation-v1\0"
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,79}\Z")
_HEX40 = re.compile(r"[0-9a-f]{40}\Z")
_HEX64 = re.compile(r"[0-9a-f]{64}\Z")
_ROLES = frozenset({
    "BUILDER", "VERIFIER", "SPEC_REVIEWER", "REGRESSION_REVIEWER",
    "INDEPENDENT_REVIEWER", "INTEGRATOR", "POST_MERGE_VERIFIER",
})
_MAX_INTENT_SECONDS = 600


def _canonical(value: object) -> bytes:
    try:
        return json.dumps(
            value,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=True,
            allow_nan=False,
        ).encode("ascii")
    except (TypeError, ValueError) as exc:
        raise LaunchIntentError("launch intent is not canonicalizable") from exc


def _key(value: bytes) -> bytes:
    if not isinstance(value, bytes) or len(value) < 32:
        raise LaunchIntentError("launch-intent HMAC key must be at least 32 bytes")
    return value


def _identifier(value: str, label: str) -> str:
    if not isinstance(value, str) or not _ID.fullmatch(value):
        raise LaunchIntentError(f"invalid {label}")
    return value


def _positive(value: int, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 2**63 - 1:
        raise LaunchIntentError(f"invalid {label}")
    return value


def _digest(value: str, label: str, pattern: re.Pattern[str] = _HEX64) -> str:
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise LaunchIntentError(f"invalid {label}")
    return value


def _resource(value: str) -> str:
    if (
        not isinstance(value, str)
        or not re.fullmatch(
            r"task:[A-Za-z0-9][A-Za-z0-9._-]{0,79}:[1-9][0-9]*:"
            r"(?:builder|verifier|spec-reviewer|regression-reviewer|"
            r"independent-reviewer|integrator|post-merge-verifier)",
            value,
        )
    ):
        raise LaunchIntentError("invalid lease resource")
    return value


def launch_operation_id(
    *,
    task_spec_sha256: str,
    lease_resource: str,
    lease_run_id: str,
    lease_token: int,
    controller_epoch: int,
) -> str:
    """Derive the store's unique launch key from the entire live lease fence."""
    _digest(task_spec_sha256, "task-spec digest")
    _resource(lease_resource)
    _identifier(lease_run_id, "lease run id")
    _positive(lease_token, "lease token")
    _positive(controller_epoch, "controller epoch")
    payload = _canonical({
        "task_spec_sha256": task_spec_sha256,
        "lease_resource": lease_resource,
        "lease_run_id": lease_run_id,
        "lease_token": lease_token,
        "controller_epoch": controller_epoch,
    })
    return hashlib.sha256(LAUNCH_OPERATION_DOMAIN + payload).hexdigest()


@dataclass(frozen=True)
class LaunchIntent:
    schema: str
    task_spec_sha256: str
    campaign_id: str
    task_id: str
    attempt: int
    role: str
    principal_id: str
    authority_domain: str
    expected_task_version: int
    controller_epoch: int
    lease_resource: str
    lease_run_id: str
    lease_token: int
    lease_expires_at: int
    subject_sha: str
    identity_manifest_sha256: str
    identity_receipt_sha256: str
    authority_binding_id: str
    issued_at: int
    expires_at: int
    launch_operation_id: str
    signature_sha256: str

    def __post_init__(self) -> None:
        if self.schema != LAUNCH_INTENT_SCHEMA:
            raise LaunchIntentError("unknown launch-intent schema")
        for value, label in (
            (self.campaign_id, "campaign id"),
            (self.task_id, "task id"),
            (self.principal_id, "principal id"),
            (self.authority_domain, "authority domain"),
            (self.lease_run_id, "lease run id"),
        ):
            _identifier(value, label)
        for value, label in (
            (self.attempt, "attempt"),
            (self.expected_task_version, "expected task version"),
            (self.controller_epoch, "controller epoch"),
            (self.lease_token, "lease token"),
            (self.lease_expires_at, "lease expiry"),
        ):
            _positive(value, label)
        if self.role not in _ROLES:
            raise LaunchIntentError("unknown role")
        _resource(self.lease_resource)
        _digest(self.task_spec_sha256, "task-spec digest")
        _digest(self.subject_sha, "subject SHA", _HEX40)
        _digest(self.identity_manifest_sha256, "identity-manifest digest")
        _digest(self.identity_receipt_sha256, "identity-receipt digest")
        _digest(self.authority_binding_id, "authority-binding id")
        _digest(self.launch_operation_id, "launch-operation id")
        _digest(self.signature_sha256, "launch-intent signature")
        if (
            isinstance(self.issued_at, bool)
            or isinstance(self.expires_at, bool)
            or not isinstance(self.issued_at, int)
            or not isinstance(self.expires_at, int)
            or self.issued_at < 0
            or not self.issued_at < self.expires_at <= self.issued_at + _MAX_INTENT_SECONDS
        ):
            raise LaunchIntentError("launch intent must be short lived")
        if self.lease_expires_at < self.expires_at:
            raise LaunchIntentError("lease expires before launch intent")
        expected_resource = (
            f"task:{self.task_id}:{self.attempt}:"
            f"{self.role.lower().replace('_', '-')}"
        )
        if self.lease_resource != expected_resource:
            raise LaunchIntentError("lease resource does not match launch phase")
        expected_operation = launch_operation_id(
            task_spec_sha256=self.task_spec_sha256,
            lease_resource=self.lease_resource,
            lease_run_id=self.lease_run_id,
            lease_token=self.lease_token,
            controller_epoch=self.controller_epoch,
        )
        if not hmac.compare_digest(self.launch_operation_id, expected_operation):
            raise LaunchIntentError("launch-operation id is not canonical")


_SIGNED_FIELDS = tuple(
    field.name for field in fields(LaunchIntent) if field.name != "signature_sha256"
)


def _payload(intent: LaunchIntent) -> bytes:
    material = asdict(intent)
    return _canonical({name: material[name] for name in _SIGNED_FIELDS})


def sign_launch_intent(*, signing_key: bytes, **values: object) -> LaunchIntent:
    """Sign the exact output of a successful durable admission transaction."""
    key = _key(signing_key)
    if set(values) != set(_SIGNED_FIELDS):
        raise LaunchIntentError("launch-intent fields are not exactly allowlisted")
    provisional = LaunchIntent(**values, signature_sha256="0" * 64)
    signature = hmac.new(
        key, LAUNCH_INTENT_MAC_DOMAIN + _payload(provisional), hashlib.sha256,
    ).hexdigest()
    return replace(provisional, signature_sha256=signature)


def verify_launch_intent(intent: LaunchIntent, verification_key: bytes, *, now: int) -> LaunchIntent:
    """Authenticate one current durable launch-intent receipt."""
    if not isinstance(intent, LaunchIntent):
        raise LaunchIntentError("LaunchIntent required")
    key = _key(verification_key)
    if isinstance(now, bool) or not isinstance(now, int) or not intent.issued_at <= now < intent.expires_at:
        raise LaunchIntentError("launch intent is not current")
    expected = hmac.new(
        key, LAUNCH_INTENT_MAC_DOMAIN + _payload(intent), hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(intent.signature_sha256, expected):
        raise LaunchIntentError("launch-intent authentication failed")
    return intent
