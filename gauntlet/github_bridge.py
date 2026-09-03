"""Pure, fail-closed contracts for the optional GitHub evidence bridge.

There is deliberately no HTTP, subprocess, filesystem, or credential access in
this module. It validates canonical fixtures and constructs exact one-shot
operations for a future durable, default-dry-run bridge. Nothing here sends a
request or enables execution.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import hmac
import json
import re
from typing import Mapping, Optional, Sequence
from urllib.parse import urlparse


class BridgeError(ValueError):
    """A malformed, stale, ambiguous, unauthenticated, or unsafe operation."""


INTENT = "INTENT"
SENT = "SENT"
CONFIRMED = "CONFIRMED"
UNCERTAIN = "UNCERTAIN"
PREPARED = "PREPARED"

DEFAULT_EVIDENCE_MAX_AGE_SECONDS = 120
DEFAULT_COMMENT_LIST_MAX_AGE_SECONDS = 120
DEFAULT_POLICY_MAX_AGE_SECONDS = 120
MAX_POLICY_LIFETIME_SECONDS = 300

_SHA = re.compile(r"^[0-9a-f]{40}$")
_DIGEST = re.compile(r"^[0-9a-f]{64}$")
_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$")
_OPAQUE = re.compile(r"^[A-Za-z0-9_.:@-]{1,200}$")
_CHECK = re.compile(r"^[A-Za-z0-9_.:/ -]{1,160}$")
_LENSES = frozenset(("spec", "regression", "independent"))
_CONCLUSIONS = frozenset((
    "SUCCESS", "FAILURE", "NEUTRAL", "CANCELLED", "SKIPPED",
    "TIMED_OUT", "ACTION_REQUIRED", "IN_PROGRESS", "QUEUED",
))
_PUBLICATION_KINDS = frozenset(("immutable", "status"))
_PUBLICATION_STATES = frozenset((
    "READY", "RUNNING", "PASS", "FAIL", "BLOCKED", "DONE", "RECONCILING",
    "REMEDIATING", "RECOVERY_REQUIRED",
))
_REASON_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,79}$")


def canonical_json(value) -> str:
    """Return deterministic JSON, rejecting non-JSON and NaN values."""
    try:
        return json.dumps(
            value, sort_keys=True, separators=(",", ":"), ensure_ascii=True,
            allow_nan=False,
        )
    except (TypeError, ValueError) as exc:
        raise BridgeError("value is not canonical JSON") from exc


def _digest(value) -> str:
    return hashlib.sha256(canonical_json(value).encode("ascii")).hexdigest()


def _hmac_digest(value, key: bytes) -> str:
    if not isinstance(key, bytes) or len(key) < 32:
        raise BridgeError("verification key must contain at least 32 bytes")
    return hmac.new(key, canonical_json(value).encode("ascii"), hashlib.sha256).hexdigest()


def evidence_digest(evidence: Mapping) -> str:
    if not isinstance(evidence, Mapping):
        raise BridgeError("evidence must be a mapping")
    material = dict(evidence)
    material.pop("sha256", None)
    return _digest(material)


def _mapping(value, fields, label):
    if not isinstance(value, Mapping) or set(value) != set(fields):
        raise BridgeError(label + " fields are not allowlisted")
    return value


def _sha(value, label="sha"):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        raise BridgeError(label + " must be a lowercase 40-character SHA")
    return value


def _hex_digest(value, label="digest"):
    if not isinstance(value, str) or not _DIGEST.fullmatch(value):
        raise BridgeError(label + " must be a lowercase SHA-256")
    return value


def _opaque(value, label):
    if not isinstance(value, str) or not _OPAQUE.fullmatch(value):
        raise BridgeError(label + " is not a bounded opaque identifier")
    return value


def _repository(value, label="repository"):
    if not isinstance(value, str) or not _REPOSITORY.fullmatch(value):
        raise BridgeError(label + " is invalid")
    return value


def _url(value):
    if not isinstance(value, str) or len(value) > 2048 or any(c.isspace() for c in value):
        raise BridgeError("URL is invalid")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https" or not parsed.netloc or parsed.username
        or parsed.password or parsed.params or parsed.query or parsed.fragment
    ):
        raise BridgeError("URL must be credential-free HTTPS without query or fragment")
    return value


def _integer(value, label, minimum=0):
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise BridgeError(label + " must be an integer")
    return value


def _fresh(observed_at: int, now: int, max_age_seconds: int, label: str) -> None:
    _integer(observed_at, label + " observed_at")
    _integer(now, "now")
    if isinstance(max_age_seconds, bool) or not isinstance(max_age_seconds, int) or not 1 <= max_age_seconds <= 900:
        raise BridgeError(label + " freshness policy is invalid")
    if observed_at > now:
        raise BridgeError(label + " is from the future")
    if now - observed_at > max_age_seconds:
        raise BridgeError(label + " is stale")


def _check(raw):
    _mapping(raw, ("name", "head_sha", "conclusion", "url"), "check")
    name = raw["name"]
    if not isinstance(name, str) or not _CHECK.fullmatch(name):
        raise BridgeError("check name is invalid")
    if raw["conclusion"] not in _CONCLUSIONS:
        raise BridgeError("check conclusion is invalid")
    return {
        "name": name,
        "head_sha": _sha(raw["head_sha"], "check head SHA"),
        "conclusion": raw["conclusion"],
        "url": _url(raw["url"]),
    }


def _review(raw):
    _mapping(raw, ("lens", "principal", "head_sha", "reference"), "review")
    if raw["lens"] not in _LENSES:
        raise BridgeError("review lens is invalid")
    return {
        "lens": raw["lens"],
        "principal": _opaque(raw["principal"], "review principal"),
        "head_sha": _sha(raw["head_sha"], "review head SHA"),
        "reference": _opaque(raw["reference"], "review reference"),
    }


def collect_evidence(raw: Mapping) -> dict:
    """Canonicalize one minimal, already-fetched PR evidence fixture."""
    fields = (
        "repository", "number", "author", "head_sha", "base_ref", "base_sha",
        "state", "merged", "draft", "mergeable", "observed_at", "checks", "reviews",
    )
    _mapping(raw, fields, "PR evidence")
    repository = _repository(raw["repository"])
    number = _integer(raw["number"], "PR number", 1)
    if raw["base_ref"] != "main":
        raise BridgeError("only main may be the PR base")
    if raw["state"] not in ("OPEN", "CLOSED") or not isinstance(raw["merged"], bool):
        raise BridgeError("PR lifecycle state is invalid")
    if not isinstance(raw["draft"], bool) or raw["mergeable"] not in ("MERGEABLE", "CONFLICTING", "UNKNOWN"):
        raise BridgeError("draft or mergeable state is invalid")
    observed_at = _integer(raw["observed_at"], "observed_at")
    if not isinstance(raw["checks"], list) or not isinstance(raw["reviews"], list):
        raise BridgeError("checks and reviews must be lists")
    checks = [_check(item) for item in raw["checks"]]
    reviews = [_review(item) for item in raw["reviews"]]
    if len(checks) > 100 or len(reviews) > 100:
        raise BridgeError("evidence list exceeds bound")
    if len({item["name"] for item in checks}) != len(checks):
        raise BridgeError("duplicate check name")
    if len({item["lens"] for item in reviews}) != len(reviews):
        raise BridgeError("duplicate review lens")
    receipt = {
        "schema": "github-evidence.v2",
        "repository": repository,
        "number": number,
        "author": _opaque(raw["author"], "PR author"),
        "head_sha": _sha(raw["head_sha"], "head SHA"),
        "base_ref": "main",
        "base_sha": _sha(raw["base_sha"], "base SHA"),
        "state": raw["state"],
        "merged": raw["merged"],
        "draft": raw["draft"],
        "mergeable": raw["mergeable"],
        "observed_at": observed_at,
        "checks": sorted(checks, key=lambda item: item["name"]),
        "reviews": sorted(reviews, key=lambda item: item["lens"]),
    }
    receipt["sha256"] = evidence_digest(receipt)
    return receipt


def _validated_receipt(evidence: Mapping) -> dict:
    fields = {
        "schema", "repository", "number", "author", "head_sha", "base_ref",
        "base_sha", "state", "merged", "draft", "mergeable", "observed_at", "checks", "reviews",
        "sha256",
    }
    if not isinstance(evidence, Mapping) or set(evidence) != fields or evidence.get("schema") != "github-evidence.v2":
        raise BridgeError("current canonical GitHub evidence receipt is required")
    raw = {key: evidence[key] for key in evidence if key not in ("schema", "sha256")}
    rebuilt = collect_evidence(raw)
    if rebuilt != dict(evidence):
        raise BridgeError("GitHub evidence receipt is not canonical")
    return rebuilt


def required_check_policy_digest(required_checks: Sequence[str]) -> str:
    checks = tuple(required_checks)
    if not checks or len(set(checks)) != len(checks):
        raise BridgeError("required checks must be nonempty and distinct")
    if any(not isinstance(item, str) or not _CHECK.fullmatch(item) for item in checks):
        raise BridgeError("required check name is invalid")
    return _digest(sorted(checks))


_POLICY_UNSIGNED_FIELDS = (
    "repository", "main_sha", "required_checks_sha256", "direct_writes_blocked",
    "required_checks_enforced", "publisher", "key_id", "reference", "observed_at",
    "expires_at",
)


def branch_policy_attestation(unsigned: Mapping, key: bytes) -> str:
    """MAC an allowlisted branch-policy claim with an out-of-repo pinned key."""
    _mapping(unsigned, _POLICY_UNSIGNED_FIELDS, "unsigned branch-policy proof")
    material = {
        "schema": "branch-policy-proof.v2",
        "repository": _repository(unsigned["repository"], "branch-policy repository"),
        "main_sha": _sha(unsigned["main_sha"], "proof main SHA"),
        "required_checks_sha256": _hex_digest(unsigned["required_checks_sha256"], "required-check policy digest"),
        "direct_writes_blocked": unsigned["direct_writes_blocked"],
        "required_checks_enforced": unsigned["required_checks_enforced"],
        "publisher": _opaque(unsigned["publisher"], "proof publisher"),
        "key_id": _opaque(unsigned["key_id"], "proof key ID"),
        "reference": _opaque(unsigned["reference"], "proof reference"),
        "observed_at": _integer(unsigned["observed_at"], "proof observed_at"),
        "expires_at": _integer(unsigned["expires_at"], "proof expiry"),
    }
    if material["direct_writes_blocked"] is not True or material["required_checks_enforced"] is not True:
        raise BridgeError("branch-policy proof must attest enforced checks and blocked direct writes")
    if material["expires_at"] <= material["observed_at"]:
        raise BridgeError("branch-policy proof expiry precedes observation")
    if material["expires_at"] - material["observed_at"] > MAX_POLICY_LIFETIME_SECONDS:
        raise BridgeError("branch-policy proof lifetime exceeds policy")
    return _hmac_digest(material, key)


def collect_branch_policy_proof(raw: Mapping) -> dict:
    """Canonicalize a signed out-of-band branch-policy attestation."""
    fields = (*_POLICY_UNSIGNED_FIELDS, "attestation_hmac_sha256")
    _mapping(raw, fields, "branch-policy proof")
    unsigned = {name: raw[name] for name in _POLICY_UNSIGNED_FIELDS}
    material = {
        "schema": "branch-policy-proof.v2",
        **unsigned,
        "attestation_hmac_sha256": _hex_digest(raw["attestation_hmac_sha256"], "branch-policy attestation"),
    }
    _repository(material["repository"], "branch-policy repository")
    _sha(material["main_sha"], "proof main SHA")
    _hex_digest(material["required_checks_sha256"], "required-check policy digest")
    if material["direct_writes_blocked"] is not True or material["required_checks_enforced"] is not True:
        raise BridgeError("branch-policy proof must attest enforced checks and blocked direct writes")
    _opaque(material["publisher"], "proof publisher")
    _opaque(material["key_id"], "proof key ID")
    _opaque(material["reference"], "proof reference")
    observed = _integer(material["observed_at"], "proof observed_at")
    expires = _integer(material["expires_at"], "proof expiry")
    if expires <= observed:
        raise BridgeError("branch-policy proof expiry precedes observation")
    if expires - observed > MAX_POLICY_LIFETIME_SECONDS:
        raise BridgeError("branch-policy proof lifetime exceeds policy")
    material["sha256"] = _digest(material)
    return material


def _policy_key(keys: Mapping[str, bytes], key_id: str) -> bytes:
    if not isinstance(keys, Mapping) or set(keys) != {key_id}:
        raise BridgeError("exactly one pinned policy verification key is required")
    key = keys.get(key_id)
    if not isinstance(key, bytes) or len(key) < 32:
        raise BridgeError("pinned policy verification key is invalid")
    return key


def _proof(
    proof: Mapping, repository: str, base_sha: str, required_policy_digest: str,
    now: int, expected_publisher: str, expected_key_id: str,
    expected_reference: str, verification_keys: Mapping[str, bytes],
    max_age_seconds: int = DEFAULT_POLICY_MAX_AGE_SECONDS,
) -> dict:
    fields = {
        "schema", *_POLICY_UNSIGNED_FIELDS, "attestation_hmac_sha256", "sha256",
    }
    if not isinstance(proof, Mapping) or set(proof) != fields or proof.get("schema") != "branch-policy-proof.v2":
        raise BridgeError("current canonical branch-policy proof is required")
    raw = {key: proof[key] for key in proof if key not in ("schema", "sha256")}
    canonical = collect_branch_policy_proof(raw)
    if canonical != dict(proof):
        raise BridgeError("branch-policy proof is not canonical")
    if proof["repository"] != repository or proof["main_sha"] != base_sha:
        raise BridgeError("branch-policy proof is not bound to current main")
    if proof["required_checks_sha256"] != required_policy_digest:
        raise BridgeError("branch-policy proof is not bound to required checks")
    if (
        proof["publisher"] != _opaque(expected_publisher, "expected policy publisher")
        or proof["key_id"] != _opaque(expected_key_id, "expected policy key ID")
        or proof["reference"] != _opaque(expected_reference, "expected policy reference")
    ):
        raise BridgeError("branch-policy proof is not issued by configured authority")
    _fresh(proof["observed_at"], now, max_age_seconds, "branch-policy proof")
    if proof["expires_at"] <= now:
        raise BridgeError("branch-policy proof is stale")
    unsigned = {name: proof[name] for name in _POLICY_UNSIGNED_FIELDS}
    expected = branch_policy_attestation(unsigned, _policy_key(verification_keys, expected_key_id))
    if not hmac.compare_digest(proof["attestation_hmac_sha256"], expected):
        raise BridgeError("branch-policy proof authentication failed")
    return canonical


def gate_admission(
    evidence: Mapping, expected_repository: str, expected_pr_number: int,
    expected_head: str, expected_base: str, required_checks: Sequence[str],
    branch_policy_proof: Mapping, now: int, expected_policy_publisher: str,
    expected_policy_key_id: str, expected_policy_reference: str,
    policy_verification_keys: Mapping[str, bytes], optional_checks: Mapping = {},
    max_evidence_age_seconds: int = DEFAULT_EVIDENCE_MAX_AGE_SECONDS,
    max_policy_age_seconds: int = DEFAULT_POLICY_MAX_AGE_SECONDS,
) -> None:
    """Fail closed unless exact, fresh, authenticated evidence is admissible."""
    expected_repository = _repository(expected_repository, "expected repository")
    expected_pr_number = _integer(expected_pr_number, "expected PR number", 1)
    expected_head = _sha(expected_head, "expected head SHA")
    expected_base = _sha(expected_base, "expected base SHA")
    _integer(now, "now")
    evidence = _validated_receipt(evidence)
    _fresh(evidence["observed_at"], now, max_evidence_age_seconds, "GitHub evidence")
    if evidence["repository"] != expected_repository or evidence["number"] != expected_pr_number:
        raise BridgeError("repository or PR drift")
    if evidence["head_sha"] != expected_head or evidence["base_sha"] != expected_base or evidence["base_ref"] != "main":
        raise BridgeError("head or base drift")
    if evidence["draft"] is not False or evidence["mergeable"] != "MERGEABLE":
        raise BridgeError("PR is draft, conflicting, or mergeability is ambiguous")
    if evidence["state"] != "OPEN" or evidence["merged"] is not False:
        raise BridgeError("PR is not an open unmerged request")
    wanted = tuple(required_checks)
    policy_digest = required_check_policy_digest(wanted)
    _proof(
        branch_policy_proof, expected_repository, expected_base, policy_digest, now,
        expected_policy_publisher, expected_policy_key_id, expected_policy_reference,
        policy_verification_keys, max_policy_age_seconds,
    )
    if not isinstance(optional_checks, Mapping):
        raise BridgeError("optional check policy must map name to conclusion")
    allowed_optional = dict(optional_checks)
    if any(
        not isinstance(name, str) or not _CHECK.fullmatch(name) or conclusion not in _CONCLUSIONS
        for name, conclusion in allowed_optional.items()
    ):
        raise BridgeError("optional check policy is invalid")
    checks = {item["name"]: item for item in evidence["checks"]}
    for name in wanted:
        if name not in checks or checks[name]["head_sha"] != expected_head or checks[name]["conclusion"] != "SUCCESS":
            raise BridgeError("required check is not successful: " + name)
    for name, check in checks.items():
        if check["head_sha"] != expected_head:
            raise BridgeError("check was not evaluated on the exact head")
        if check["conclusion"] != "SUCCESS" and allowed_optional.get(name) != check["conclusion"]:
            raise BridgeError("unapproved optional check conclusion")
    reviews = evidence["reviews"]
    if {item["lens"] for item in reviews} != _LENSES:
        raise BridgeError("all three review lenses are required")
    author = evidence["author"].casefold()
    principals = set()
    for review in reviews:
        principal = review["principal"].casefold()
        if review["head_sha"] != expected_head or principal == author:
            raise BridgeError("review is stale or author-controlled")
        if principal in principals:
            raise BridgeError("review principals are not independent")
        principals.add(principal)


@dataclass(frozen=True)
class MergeAdmissionReceipt:
    """Short-lived authenticated proof that every pre-merge gate passed."""

    repository: str
    pr_number: int
    head_sha: str
    base_sha: str
    github_evidence_sha256: str
    branch_policy_proof_sha256: str
    observed_at: int
    expires_at: int
    issuer_key_id: str
    admission_hmac_sha256: str

    def __post_init__(self):
        _repository(self.repository, "admission repository")
        _integer(self.pr_number, "admission PR number", 1)
        _sha(self.head_sha, "admission head SHA")
        _sha(self.base_sha, "admission base SHA")
        _hex_digest(self.github_evidence_sha256, "GitHub evidence digest")
        _hex_digest(self.branch_policy_proof_sha256, "branch-policy proof digest")
        _integer(self.observed_at, "admission observed_at")
        _integer(self.expires_at, "admission expires_at")
        _opaque(self.issuer_key_id, "admission issuer key ID")
        _hex_digest(self.admission_hmac_sha256, "admission authentication")
        if self.expires_at <= self.observed_at or self.expires_at - self.observed_at > MAX_POLICY_LIFETIME_SECONDS:
            raise BridgeError("merge admission lifetime is invalid")

    def unsigned_mapping(self) -> dict:
        value = asdict(self)
        value.pop("admission_hmac_sha256")
        return value

    def verify(
        self, verification_keys: Mapping[str, bytes], *, now: int,
        repository: str, pr_number: int, head_sha: str, base_sha: str,
    ) -> None:
        key = _policy_key(verification_keys, self.issuer_key_id)
        expected = _hmac_digest(self.unsigned_mapping(), key)
        if not hmac.compare_digest(self.admission_hmac_sha256, expected):
            raise BridgeError("merge admission authentication failed")
        _fresh(self.observed_at, now, DEFAULT_EVIDENCE_MAX_AGE_SECONDS, "merge admission")
        if now >= self.expires_at:
            raise BridgeError("merge admission expired")
        if (
            self.repository != _repository(repository) or self.pr_number != _integer(pr_number, "PR number", 1)
            or self.head_sha != _sha(head_sha, "head SHA") or self.base_sha != _sha(base_sha, "base SHA")
        ):
            raise BridgeError("merge admission destination or SHA drift")

    @property
    def sha256(self) -> str:
        return _digest(asdict(self))


def issue_merge_admission(
    evidence: Mapping, expected_repository: str, expected_pr_number: int,
    expected_head: str, expected_base: str, required_checks: Sequence[str],
    branch_policy_proof: Mapping, now: int, expected_policy_publisher: str,
    expected_policy_key_id: str, expected_policy_reference: str,
    policy_verification_keys: Mapping[str, bytes], *, issuer_key_id: str,
    signing_key: bytes, ttl_seconds: int = 60, optional_checks: Mapping = {},
) -> MergeAdmissionReceipt:
    """Run every admission gate, then authenticate only its minimal outcome."""
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or not 1 <= ttl_seconds <= DEFAULT_EVIDENCE_MAX_AGE_SECONDS:
        raise BridgeError("merge admission TTL is invalid")
    gate_admission(
        evidence, expected_repository, expected_pr_number, expected_head,
        expected_base, required_checks, branch_policy_proof, now,
        expected_policy_publisher, expected_policy_key_id,
        expected_policy_reference, policy_verification_keys, optional_checks,
    )
    canonical = _validated_receipt(evidence)
    proof = dict(branch_policy_proof)
    expires_at = min(
        now + ttl_seconds, proof["expires_at"],
        canonical["observed_at"] + DEFAULT_EVIDENCE_MAX_AGE_SECONDS,
    )
    if expires_at <= now:
        raise BridgeError("merge admission would already be expired")
    provisional = MergeAdmissionReceipt(
        canonical["repository"], canonical["number"], canonical["head_sha"],
        canonical["base_sha"], canonical["sha256"], proof["sha256"],
        canonical["observed_at"], expires_at, _opaque(issuer_key_id, "admission issuer key ID"),
        "0" * 64,
    )
    return replace(
        provisional,
        admission_hmac_sha256=_hmac_digest(provisional.unsigned_mapping(), signing_key),
    )


@dataclass(frozen=True)
class MergeStateReceipt:
    """Short-lived authenticated remote merge or no-merge observation."""

    repository: str
    pr_number: int
    head_sha: str
    base_sha: str
    main_sha: str
    merged: bool
    merge_sha: Optional[str]
    included_head_sha: Optional[str]
    operation_id: str
    observed_at: int
    expires_at: int
    issuer_key_id: str
    state_hmac_sha256: str

    def __post_init__(self):
        _repository(self.repository, "merge-state repository")
        _integer(self.pr_number, "merge-state PR number", 1)
        _sha(self.head_sha, "merge-state head SHA")
        _sha(self.base_sha, "merge-state base SHA")
        _sha(self.main_sha, "merge-state main SHA")
        if not isinstance(self.merged, bool):
            raise BridgeError("merge-state merged flag is invalid")
        if self.merged:
            _sha(self.merge_sha, "merge-state merge SHA")
            _sha(self.included_head_sha, "merge-state included head SHA")
            if self.main_sha != self.merge_sha or self.included_head_sha != self.head_sha:
                raise BridgeError("merged state does not prove exact-head inclusion and resulting main")
        elif self.merge_sha is not None or self.included_head_sha is not None:
            raise BridgeError("unmerged state cannot carry merge result fields")
        _opaque(self.operation_id, "merge-state operation ID")
        _integer(self.observed_at, "merge-state observed_at")
        _integer(self.expires_at, "merge-state expires_at")
        _opaque(self.issuer_key_id, "merge-state issuer key ID")
        _hex_digest(self.state_hmac_sha256, "merge-state authentication")
        if self.expires_at <= self.observed_at or self.expires_at - self.observed_at > DEFAULT_EVIDENCE_MAX_AGE_SECONDS:
            raise BridgeError("merge-state lifetime is invalid")

    def unsigned_mapping(self) -> dict:
        value = asdict(self)
        value.pop("state_hmac_sha256")
        return value

    def verify(
        self, verification_keys: Mapping[str, bytes], *, now: int,
        repository: str, pr_number: int, head_sha: str, base_sha: str,
        operation_id: str,
    ) -> None:
        key = _policy_key(verification_keys, self.issuer_key_id)
        expected = _hmac_digest(self.unsigned_mapping(), key)
        if not hmac.compare_digest(self.state_hmac_sha256, expected):
            raise BridgeError("merge-state authentication failed")
        _fresh(self.observed_at, now, DEFAULT_EVIDENCE_MAX_AGE_SECONDS, "merge-state receipt")
        if now >= self.expires_at:
            raise BridgeError("merge-state receipt expired")
        if (
            self.repository != _repository(repository) or self.pr_number != _integer(pr_number, "PR number", 1)
            or self.head_sha != _sha(head_sha, "head SHA") or self.base_sha != _sha(base_sha, "base SHA")
            or self.operation_id != _opaque(operation_id, "operation ID")
        ):
            raise BridgeError("merge-state receipt destination, SHA, or operation drift")

    @property
    def sha256(self) -> str:
        return _digest(asdict(self))


def issue_merge_state_receipt(
    raw: Mapping, *, now: int, issuer_key_id: str, signing_key: bytes,
    ttl_seconds: int = 60,
) -> MergeStateReceipt:
    """Authenticate one bounded remote observation for protocol consumption."""
    fields = (
        "repository", "pr_number", "head_sha", "base_sha", "main_sha",
        "merged", "merge_sha", "included_head_sha", "operation_id", "observed_at",
    )
    _mapping(raw, fields, "merge-state evidence")
    if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int) or not 1 <= ttl_seconds <= DEFAULT_EVIDENCE_MAX_AGE_SECONDS:
        raise BridgeError("merge-state TTL is invalid")
    _fresh(raw["observed_at"], now, DEFAULT_EVIDENCE_MAX_AGE_SECONDS, "merge-state evidence")
    expires_at = min(
        now + ttl_seconds,
        raw["observed_at"] + DEFAULT_EVIDENCE_MAX_AGE_SECONDS,
    )
    if expires_at <= now:
        raise BridgeError("merge-state receipt would already be expired")
    provisional = MergeStateReceipt(
        raw["repository"], raw["pr_number"], raw["head_sha"], raw["base_sha"],
        raw["main_sha"], raw["merged"], raw["merge_sha"], raw["included_head_sha"],
        raw["operation_id"], raw["observed_at"], expires_at,
        issuer_key_id, "0" * 64,
    )
    return replace(
        provisional,
        state_hmac_sha256=_hmac_digest(provisional.unsigned_mapping(), signing_key),
    )


def _publication_summary(summary: Mapping) -> dict:
    fields = (
        "campaign_id", "task_id", "status", "ledger_tip_sha256",
        "receipt_sha256", "receipt_ids", "reason_code",
    )
    _mapping(summary, fields, "publication summary")
    receipts = summary["receipt_ids"]
    if not isinstance(receipts, (list, tuple)) or not 1 <= len(receipts) <= 32:
        raise BridgeError("publication receipt IDs are invalid")
    normalized = tuple(_opaque(value, "receipt ID") for value in receipts)
    if len({value.casefold() for value in normalized}) != len(normalized):
        raise BridgeError("publication receipt IDs are duplicated")
    if summary["status"] not in _PUBLICATION_STATES:
        raise BridgeError("publication status is invalid")
    reason = summary["reason_code"]
    if reason is not None and (not isinstance(reason, str) or not _REASON_CODE.fullmatch(reason)):
        raise BridgeError("publication reason code is invalid")
    return {
        "campaign_id": _opaque(summary["campaign_id"], "campaign ID"),
        "task_id": _opaque(summary["task_id"], "task ID"),
        "status": summary["status"],
        "ledger_tip_sha256": _hex_digest(summary["ledger_tip_sha256"], "ledger tip"),
        "receipt_sha256": _hex_digest(summary["receipt_sha256"], "receipt digest"),
        "receipt_ids": normalized,
        "reason_code": reason,
    }


def _publication_body(kind: str, summary: Mapping) -> str:
    prefix = ["NOT AUTHORIZATION"] if kind == "status" else []
    reason = summary["reason_code"] if summary["reason_code"] is not None else "NONE"
    lines = prefix + [
        "Kizuki Gauntlet evidence summary",
        "campaign: " + summary["campaign_id"],
        "task: " + summary["task_id"],
        "status: " + summary["status"],
        "reason: " + reason,
        "ledger-tip-sha256: " + summary["ledger_tip_sha256"],
        "receipt-sha256: " + summary["receipt_sha256"],
        "receipt-ids: " + ",".join(summary["receipt_ids"]),
    ]
    return "\n".join(lines)


def _publication_marker(repository: str, issue_number: int, kind: str, summary: Mapping) -> str:
    if kind == "immutable":
        binding = {
            "repository": repository, "issue_number": issue_number, "kind": kind,
            "campaign_id": summary["campaign_id"], "ledger_tip_sha256": summary["ledger_tip_sha256"],
            "receipt_sha256": summary["receipt_sha256"],
        }
    else:
        binding = {
            "repository": repository, "issue_number": issue_number, "kind": kind,
            "campaign_id": summary["campaign_id"],
        }
    return "kizuki-gauntlet-" + _digest(binding)[:40]


def _comment_listing(raw: Mapping, repository: str, issue_number: int, now: int, max_age_seconds: int) -> tuple[dict, ...]:
    _mapping(raw, ("repository", "issue_number", "observed_at", "complete", "comments"), "comment listing")
    if raw["repository"] != repository or raw["issue_number"] != issue_number or raw["complete"] is not True:
        raise BridgeError("comment listing is not complete or destination-bound")
    _fresh(raw["observed_at"], now, max_age_seconds, "comment listing")
    comments = raw["comments"]
    if not isinstance(comments, list) or len(comments) > 10000:
        raise BridgeError("comment listing is invalid")
    result = []
    seen = set()
    for comment in comments:
        _mapping(comment, ("id", "author", "body"), "comment")
        identifier = _integer(comment["id"], "comment ID", 1)
        if identifier in seen:
            raise BridgeError("comment listing contains duplicate IDs")
        seen.add(identifier)
        author = _opaque(comment["author"], "comment author")
        body = comment["body"]
        if not isinstance(body, str) or len(body) > 20000 or "\x00" in body:
            raise BridgeError("comment body is invalid")
        result.append({"id": identifier, "author": author, "body": body})
    return tuple(result)


def prepare_publication(
    state: Optional[Mapping], kind: str, summary: Mapping, publisher: str,
    repository: str, issue_number: int, *, dry_run: bool = True,
    comment_listing: Optional[Mapping] = None, now: Optional[int] = None,
    max_listing_age_seconds: int = DEFAULT_COMMENT_LIST_MAX_AGE_SECONDS,
) -> dict:
    """Prepare a typed, destination-bound operation; never perform mutation."""
    if not isinstance(dry_run, bool):
        raise BridgeError("dry_run must be boolean")
    if kind not in _PUBLICATION_KINDS:
        raise BridgeError("publication kind is invalid")
    repository = _repository(repository)
    issue_number = _integer(issue_number, "issue number", 1)
    publisher = _opaque(publisher, "publisher")
    summary = _publication_summary(summary)
    marker = _publication_marker(repository, issue_number, kind, summary)
    body = "<!-- " + marker + " -->\n" + _publication_body(kind, summary)
    body_digest = _digest(body)
    old = dict(state or {})
    if old:
        _validate_publication_operation(
            old, frozenset((INTENT, SENT, UNCERTAIN, CONFIRMED)),
        )
    comments = None
    if dry_run is False or old.get("state") == CONFIRMED:
        if comment_listing is None or now is None:
            raise BridgeError("fresh complete pagination is required before mutation")
        comments = _comment_listing(comment_listing, repository, issue_number, now, max_listing_age_seconds)
    matches = [] if comments is None else [
        item for item in comments if item["body"].split("\n", 1)[0] == "<!-- " + marker + " -->"
    ]
    if len(matches) > 1:
        raise BridgeError("publication marker is duplicated")
    if old:
        for field, value in (("repository", repository), ("issue_number", issue_number), ("marker", marker), ("publisher", publisher), ("kind", kind)):
            if old.get(field) != value:
                raise BridgeError("publication binding mismatch")
        if old.get("state") == CONFIRMED:
            if len(matches) != 1:
                raise BridgeError("persisted publication is absent")
            match = matches[0]
            if match["id"] != old.get("comment_id") or match["author"].casefold() != publisher.casefold():
                raise BridgeError("persisted publication ID or author changed")
            if _digest(match["body"]) != old.get("body_sha256"):
                raise BridgeError("persisted publication body changed")
            if old.get("body_sha256") == body_digest:
                return {**old, "idempotent": True}
            if kind != "status":
                raise BridgeError("immutable publication marker collision")
            return {
                "kind": kind, "state": INTENT, "repository": repository,
                "issue_number": issue_number, "marker": marker, "body": body,
                "body_sha256": body_digest, "publisher": publisher,
                "summary": summary, "dry_run": dry_run, "idempotent": False,
                "operation": "UPDATE", "comment_id": old["comment_id"],
            }
        if old.get("body_sha256") != body_digest:
            raise BridgeError("publication operation collision")
        if old.get("state") in (SENT, UNCERTAIN):
            raise BridgeError("publication must be reconciled, never reposted")
        if old.get("state") != INTENT:
            raise BridgeError("publication state is invalid")
    elif comments is not None and matches:
        match = matches[0]
        if match["author"].casefold() != publisher.casefold() or _digest(match["body"]) != body_digest:
            raise BridgeError("publication marker is foreign or colliding")
        return {
            "kind": kind, "state": CONFIRMED, "repository": repository,
            "issue_number": issue_number, "marker": marker, "body": body,
            "body_sha256": body_digest, "publisher": publisher,
            "summary": summary, "dry_run": dry_run, "idempotent": True,
            "operation": "CREATE", "comment_id": match["id"],
        }
    return {
        "kind": kind, "state": INTENT, "repository": repository,
        "issue_number": issue_number, "marker": marker, "body": body,
        "body_sha256": body_digest, "publisher": publisher,
        "summary": summary, "dry_run": dry_run, "idempotent": False,
        "operation": "CREATE",
    }


def _validate_publication_operation(operation: Mapping, allowed_states: frozenset[str]) -> dict:
    if not isinstance(operation, Mapping) or operation.get("state") not in allowed_states:
        raise BridgeError("publication operation state is invalid")
    required = {
        "kind", "state", "repository", "issue_number", "marker", "body",
        "body_sha256", "publisher", "summary", "dry_run", "idempotent",
        "operation",
    }
    if operation.get("operation") == "UPDATE" or operation.get("state") == CONFIRMED:
        required.add("comment_id")
    if set(operation) != required:
        raise BridgeError("publication operation fields are not canonical")
    kind = operation["kind"]
    if kind not in _PUBLICATION_KINDS:
        raise BridgeError("publication kind is invalid")
    repository = _repository(operation["repository"])
    issue_number = _integer(operation["issue_number"], "issue number", 1)
    publisher = _opaque(operation["publisher"], "publisher")
    summary_value = _publication_summary(operation["summary"])
    if summary_value != dict(operation["summary"]):
        raise BridgeError("publication summary is not canonical")
    marker = _publication_marker(repository, issue_number, kind, summary_value)
    body = "<!-- " + marker + " -->\n" + _publication_body(kind, summary_value)
    if operation["marker"] != marker or operation["body"] != body or operation["body_sha256"] != _digest(body):
        raise BridgeError("publication marker, body, or digest is not canonical")
    if not isinstance(operation["dry_run"], bool) or not isinstance(operation["idempotent"], bool):
        raise BridgeError("publication flags must be boolean")
    if operation["operation"] not in ("CREATE", "UPDATE"):
        raise BridgeError("publication mutation is invalid")
    if operation["operation"] == "UPDATE" and kind != "status":
        raise BridgeError("only status publications may be updated")
    if "comment_id" in operation:
        _integer(operation["comment_id"], "comment ID", 1)
    return dict(operation)


def mark_publication_sent(operation: Mapping) -> dict:
    operation = _validate_publication_operation(operation, frozenset((INTENT,)))
    if operation["dry_run"] is not False or operation["idempotent"] is not False:
        raise BridgeError("dry-run or malformed publication cannot be sent")
    sent = dict(operation)
    sent["state"] = SENT
    sent["idempotent"] = False
    return sent


def mark_publication_uncertain(operation: Mapping) -> dict:
    operation = _validate_publication_operation(operation, frozenset((SENT,)))
    uncertain = dict(operation)
    uncertain["state"] = UNCERTAIN
    return uncertain


def reconcile_publication(
    operation: Mapping, comment_listing: Mapping, *, now: int,
    max_listing_age_seconds: int = DEFAULT_COMMENT_LIST_MAX_AGE_SECONDS,
) -> dict:
    """Adopt one exact publisher-owned comment from a complete fresh listing."""
    operation = _validate_publication_operation(operation, frozenset((SENT, UNCERTAIN)))
    comments = _comment_listing(
        comment_listing, operation.get("repository"), operation.get("issue_number"),
        now, max_listing_age_seconds,
    )
    marker_line = "<!-- " + operation["marker"] + " -->"
    matches = [item for item in comments if item["body"].split("\n", 1)[0] == marker_line]
    if len(matches) != 1:
        raise BridgeError("publication marker is absent or duplicated")
    comment = matches[0]
    if operation.get("operation") == "UPDATE" and comment["id"] != operation.get("comment_id"):
        raise BridgeError("status update did not target persisted comment ID")
    if comment["author"].casefold() != operation["publisher"].casefold():
        raise BridgeError("publication marker is foreign")
    if _digest(comment["body"]) != operation["body_sha256"]:
        raise BridgeError("publication body does not match persisted digest")
    confirmed = dict(operation)
    confirmed.update({"state": CONFIRMED, "comment_id": comment["id"], "idempotent": False})
    return confirmed


@dataclass(frozen=True)
class MergeGrant:
    repository: str
    pr_number: int
    head_sha: str
    base_sha: str
    strategy: str
    title_sha256: str
    body_sha256: str
    issuer: str
    issuer_key_id: str
    github_evidence_sha256: str
    branch_policy_proof_sha256: str
    authority_reference: str
    delegate: str
    expires_at: int
    epoch: int
    fence_token: int
    operation_id: str
    generation: int
    grant_hmac_sha256: str
    max_requests: int = 1

    def __post_init__(self):
        _repository(self.repository, "grant repository")
        _integer(self.pr_number, "grant PR", 1)
        _sha(self.head_sha, "grant head SHA")
        _sha(self.base_sha, "grant base SHA")
        if self.strategy not in ("MERGE", "SQUASH", "REBASE"):
            raise BridgeError("merge strategy is invalid")
        for value, label in (
            (self.title_sha256, "title digest"),
            (self.body_sha256, "body digest"),
            (self.github_evidence_sha256, "GitHub evidence digest"),
            (self.branch_policy_proof_sha256, "branch-policy proof digest"),
            (self.grant_hmac_sha256, "grant authentication"),
        ):
            _hex_digest(value, label)
        for value, label in (
            (self.issuer, "grant issuer"), (self.issuer_key_id, "grant issuer key ID"),
            (self.authority_reference, "authority reference"), (self.delegate, "delegate"),
            (self.operation_id, "operation ID"),
        ):
            _opaque(value, label)
        _integer(self.expires_at, "grant expiry")
        _integer(self.epoch, "epoch", 1)
        _integer(self.fence_token, "fence token", 1)
        _integer(self.generation, "generation", 1)
        if self.max_requests != 1:
            raise BridgeError("merge grants are one-shot")

    def unsigned_mapping(self) -> dict:
        value = asdict(self)
        value.pop("grant_hmac_sha256")
        return value

    def verify(self, verification_keys: Mapping[str, bytes]) -> None:
        if not isinstance(verification_keys, Mapping) or set(verification_keys) != {self.issuer_key_id}:
            raise BridgeError("exactly one pinned merge-grant key is required")
        expected = _hmac_digest(self.unsigned_mapping(), verification_keys[self.issuer_key_id])
        if not hmac.compare_digest(self.grant_hmac_sha256, expected):
            raise BridgeError("merge grant authentication failed")

    @property
    def sha256(self):
        return _digest(asdict(self))


def mint_merge_grant(*, signing_key: bytes, **fields) -> MergeGrant:
    """Mint a canonical authenticated grant without placing a key in the grant."""
    unsigned_fields = set(MergeGrant.__dataclass_fields__) - {"grant_hmac_sha256"}
    if set(fields) != unsigned_fields:
        raise BridgeError("merge grant fields are not allowlisted")
    provisional = MergeGrant(**fields, grant_hmac_sha256="0" * 64)
    return replace(provisional, grant_hmac_sha256=_hmac_digest(provisional.unsigned_mapping(), signing_key))


class MergeOperation:
    """Pure transition object; every returned state must be durably persisted."""

    def __init__(self, grant: MergeGrant, verification_keys: Mapping[str, bytes], current_epoch: int):
        if not isinstance(grant, MergeGrant):
            raise BridgeError("MergeGrant required")
        grant.verify(verification_keys)
        if grant.epoch != _integer(current_epoch, "current epoch", 1):
            raise BridgeError("merge grant belongs to a stale epoch")
        self.operation_id = grant.operation_id
        self.generation = grant.generation
        self.grant_sha256 = grant.sha256
        self.state = INTENT
        self.request_sha256 = None
        self.response_sha256 = None
        self._repository = grant.repository
        self._pr_number = grant.pr_number
        self._head_sha = grant.head_sha
        self._epoch = grant.epoch

    def _match(self, grant: MergeGrant, now: int, current_epoch: int, verification_keys: Mapping[str, bytes]):
        if not isinstance(grant, MergeGrant):
            raise BridgeError("MergeGrant required")
        grant.verify(verification_keys)
        if grant.operation_id != self.operation_id or grant.generation != self.generation or grant.sha256 != self.grant_sha256:
            raise BridgeError("merge grant does not match operation")
        if _integer(now, "now") >= grant.expires_at:
            raise BridgeError("merge grant expired")
        if grant.epoch != self._epoch or grant.epoch != _integer(current_epoch, "current epoch", 1):
            raise BridgeError("merge grant belongs to a stale epoch")

    def prepare(self, grant: MergeGrant, *, now: int, current_epoch: int, verification_keys: Mapping[str, bytes]):
        self._match(grant, now, current_epoch, verification_keys)
        if self.state != INTENT:
            raise BridgeError("merge operation is not preparable")
        self.state = PREPARED

    def request(
        self, grant: MergeGrant, *, now: int, current_epoch: int,
        grant_verification_keys: Mapping[str, bytes], title: str, body: str,
        evidence: Mapping, fresh_main_sha: str, delegate: str,
        authority_reference: str, issuer: str, fence_token: int, generation: int,
        branch_policy_proof: Mapping, required_checks: Sequence[str],
        expected_policy_publisher: str, expected_policy_key_id: str,
        expected_policy_reference: str, policy_verification_keys: Mapping[str, bytes],
        optional_checks: Mapping = {},
        max_evidence_age_seconds: int = DEFAULT_EVIDENCE_MAX_AGE_SECONDS,
        max_policy_age_seconds: int = DEFAULT_POLICY_MAX_AGE_SECONDS,
    ) -> dict:
        self._match(grant, now, current_epoch, grant_verification_keys)
        if self.state != PREPARED:
            raise BridgeError("merge request may be issued exactly once")
        if not isinstance(title, str) or not title or len(title) > 256 or "\x00" in title:
            raise BridgeError("merge title is invalid")
        if not isinstance(body, str) or not body or len(body) > 4000 or "\x00" in body:
            raise BridgeError("merge body is invalid")
        if _digest(title) != grant.title_sha256 or _digest(body) != grant.body_sha256:
            raise BridgeError("merge title or body does not match grant")
        if (
            delegate != grant.delegate or authority_reference != grant.authority_reference
            or issuer != grant.issuer or fence_token != grant.fence_token
            or generation != grant.generation
        ):
            raise BridgeError("configured merge authority or fence does not match grant")
        evidence = _validated_receipt(evidence)
        if evidence["sha256"] != grant.github_evidence_sha256:
            raise BridgeError("fresh GitHub evidence digest does not match grant")
        if not isinstance(branch_policy_proof, Mapping) or branch_policy_proof.get("sha256") != grant.branch_policy_proof_sha256:
            raise BridgeError("branch-policy proof digest does not match grant")
        fresh_main_sha = _sha(fresh_main_sha, "fresh main SHA")
        if grant.base_sha != fresh_main_sha:
            raise BridgeError("fresh main does not match grant base")
        gate_admission(
            evidence, grant.repository, grant.pr_number, grant.head_sha, fresh_main_sha,
            required_checks, branch_policy_proof, now, expected_policy_publisher,
            expected_policy_key_id, expected_policy_reference, policy_verification_keys,
            optional_checks, max_evidence_age_seconds, max_policy_age_seconds,
        )
        envelope = {
            "repository": grant.repository,
            "pr_number": grant.pr_number,
            "sha": grant.head_sha,
            "base_sha": grant.base_sha,
            "merge_method": grant.strategy,
            "commit_title": title,
            "commit_message": body,
            "operation_id": grant.operation_id,
            "generation": grant.generation,
            "max_requests": 1,
        }
        self.request_sha256 = _digest(envelope)
        self.state = SENT
        return envelope

    def uncertain(self):
        if self.state != SENT:
            raise BridgeError("only a sent operation may become uncertain")
        self.state = UNCERTAIN

    def confirm(
        self, evidence: Mapping, *, now: int, current_epoch: int,
        max_evidence_age_seconds: int = DEFAULT_EVIDENCE_MAX_AGE_SECONDS,
    ):
        if self.state not in (SENT, UNCERTAIN):
            raise BridgeError("only sent or uncertain operation may be confirmed")
        if _integer(current_epoch, "current epoch", 1) != self._epoch:
            raise BridgeError("merge operation belongs to a stale epoch")
        _mapping(
            evidence,
            (
                "repository", "pr_number", "operation_id", "request_sha256",
                "head_sha", "included_head_sha", "observed_at", "merged_at",
                "merge_commit", "main_sha",
            ),
            "merge confirmation",
        )
        if evidence["repository"] != self._repository or evidence["pr_number"] != self._pr_number:
            raise BridgeError("merge confirmation repository or PR drift")
        if evidence["operation_id"] != self.operation_id or evidence["request_sha256"] != self.request_sha256:
            raise BridgeError("merge confirmation is not bound to sent request")
        _fresh(evidence["observed_at"], now, max_evidence_age_seconds, "merge confirmation")
        _integer(evidence["merged_at"], "merged_at", 1)
        if evidence["merged_at"] > evidence["observed_at"]:
            raise BridgeError("merge timestamp is later than its observation")
        for field in ("head_sha", "included_head_sha", "merge_commit", "main_sha"):
            _sha(evidence[field], field)
        if evidence["head_sha"] != self._head_sha or evidence["included_head_sha"] != self._head_sha:
            raise BridgeError("confirmed merge does not include exact expected head")
        if evidence["merge_commit"] != evidence["main_sha"]:
            raise BridgeError("resulting main does not unambiguously equal merge commit")
        self.response_sha256 = _digest(dict(evidence))
        self.state = CONFIRMED
