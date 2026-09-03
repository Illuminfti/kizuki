"""Inert, dependency-free implementation of ADR-002's task protocol.

This module deliberately has no process, filesystem, network, or git calls.
It is the policy layer which a later durable Store adapter may replay into its
own projection.  State is changed only after every guard for an operation has
been evaluated against a copy, so callers never observe a half committed phase
result.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
import hashlib
import json
import re
from time import monotonic
from typing import Callable, Optional
from uuid import uuid4
from gauntlet.identity import (AuthorityBinding, IdentityError, IdentityManifest,
    IdentityReceipt, verify_authority_binding)
from gauntlet.github_bridge import MergeAdmissionReceipt, MergeStateReceipt, BridgeError


class ProtocolError(RuntimeError): pass
class ConflictError(ProtocolError): pass
class FencedError(ProtocolError): pass
class AuthorizationError(ProtocolError): pass


ROLES = frozenset({
    "BUILDER", "VERIFIER", "SPEC_REVIEWER", "REGRESSION_REVIEWER",
    "INDEPENDENT_REVIEWER", "INTEGRATOR", "POST_MERGE_VERIFIER",
})
REVIEW_ROLES = ("SPEC_REVIEWER", "REGRESSION_REVIEWER", "INDEPENDENT_REVIEWER")
PHASE_FOR_ROLE = {
    "BUILDER": "SUBMISSION", "VERIFIER": "VERIFICATION",
    "SPEC_REVIEWER": "REVIEW", "REGRESSION_REVIEWER": "REVIEW",
    "INDEPENDENT_REVIEWER": "REVIEW", "INTEGRATOR": "PRE_MERGE",
    "POST_MERGE_VERIFIER": "POST_MERGE_VERIFICATION",
}
GIT_SHA_LEN = 40
EVIDENCE_SHA_LEN = 64
SCHEMA_VERSION = 2


def _git_sha(value: str, field_name: str = "sha") -> str:
    if not isinstance(value, str) or len(value) != GIT_SHA_LEN or any(c not in "0123456789abcdef" for c in value):
        raise ProtocolError(f"invalid {field_name}")
    return value


def _evidence_sha(value: str, field_name: str = "evidence_sha256") -> str:
    if not isinstance(value, str) or len(value) != EVIDENCE_SHA_LEN or any(c not in "0123456789abcdef" for c in value):
        raise ProtocolError(f"invalid {field_name}")
    return value


_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")


@dataclass(frozen=True)
class PhaseResult:
    """Typed, bounded testimony admitted by the trusted scheduler only."""
    verdict: str
    subject_sha: str
    base_sha: str
    result_sha: str
    evidence_sha256: str
    github_evidence_id: Optional[str] = None

    def validate(self) -> None:
        if self.verdict not in {"PASS", "FAIL"}: raise ProtocolError("invalid verdict")
        _git_sha(self.subject_sha, "subject_sha"); _git_sha(self.base_sha, "base_sha")
        _git_sha(self.result_sha, "result_sha"); _evidence_sha(self.evidence_sha256)
        if self.github_evidence_id is not None and (not isinstance(self.github_evidence_id, str) or len(self.github_evidence_id) > 128):
            raise ProtocolError("invalid github evidence id")


@dataclass(frozen=True)
class GitHubEvidence:
    repo: str
    pr_number: int
    head_sha: str
    base_sha: str
    main_sha: str
    merged: bool = False
    merge_sha: Optional[str] = None
    evidence_sha256: str = ""

    def validate(self) -> None:
        if not isinstance(self.repo, str) or not _REPO_RE.fullmatch(self.repo): raise ProtocolError("invalid repo")
        if not isinstance(self.pr_number, int) or self.pr_number < 1: raise ProtocolError("invalid PR number")
        _git_sha(self.head_sha, "head_sha"); _git_sha(self.base_sha, "base_sha"); _git_sha(self.main_sha, "main_sha")
        if self.merge_sha is not None: _git_sha(self.merge_sha, "merge_sha")
        if self.merged and self.merge_sha is None: raise ProtocolError("merged evidence requires merge sha")
        _evidence_sha(self.evidence_sha256)


@dataclass(frozen=True)
class LeaseGrant:
    task_id: str; attempt: int; role: str; principal_id: str; run_id: str
    authority_domain: str; account_binding_sha256: str; identity_receipt_sha256: str; token: int; epoch: int; expires_at: float; resource: str


@dataclass(frozen=True)
class MergeGrant:
    task_id: str; attempt: int; subject_sha: str; base_sha: str; pr_number: int
    operation_id: str; generation: int; fence_token: int; epoch: int


@dataclass
class _Task:
    id: str; base_sha: str; repository: str; pr_number: int; state: str = "DISCOVERED"; attempt: int = 0
    version: int = 1; subject_sha: Optional[str] = None; merge_sha: Optional[str] = None
    active_role: Optional[str] = None; recovery_from: Optional[str] = None
    remediation_parent: Optional[str] = None; remediation_kind: Optional[str] = None


@dataclass
class _MergeClaim:
    task_id: str; attempt: int; subject_sha: str; base_sha: str; pr_number: int
    token: int; epoch: int; operation_id: str; generation: int = 1
    status: str = "HELD"; linked_task_id: Optional[str] = None
    parent_operation_id: Optional[str] = None
    integrator_principal: Optional[str] = None
    integrator_authority_domain: Optional[str] = None


@dataclass
class ProtocolStore:
    """Small pure projection suitable for unit and crash-injection tests.

    ``clock`` is injectable; callers should persist ``events`` through an
    append-only adapter before acknowledging an operation in production.
    """
    epoch: int = 1
    clock: Callable[[], float] = monotonic
    identity_hmac_key: bytes = b""
    bridge_receipt_keys: dict[str, bytes] = field(default_factory=dict)
    identities: dict[str, tuple[IdentityManifest, IdentityReceipt]] = field(default_factory=dict)
    consumed_binding_ids: set[str] = field(default_factory=set)
    tasks: dict[str, _Task] = field(default_factory=dict)
    leases: dict[str, LeaseGrant] = field(default_factory=dict)
    receipts: list[dict] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    merge_claim: Optional[_MergeClaim] = None
    _token: int = 0
    max_lease_ttl: float = 3600

    def __post_init__(self) -> None:
        if not isinstance(self.identity_hmac_key, bytes) or len(self.identity_hmac_key) < 32:
            raise ProtocolError("pinned controller identity HMAC key required")
        if not isinstance(self.bridge_receipt_keys, dict) or len(self.bridge_receipt_keys) != 1:
            raise ProtocolError("exactly one pinned bridge receipt key required")
        if any(not isinstance(key, str) or not isinstance(value, bytes) or len(value) < 32 for key, value in self.bridge_receipt_keys.items()):
            raise ProtocolError("invalid bridge receipt key")

    def admit_task(self, task_id: str, base_sha: str, repository: str, pr_number: int, *, expected_version: Optional[int] = None) -> _Task:
        if task_id in self.tasks: raise ConflictError("task exists")
        _git_sha(base_sha, "base_sha")
        if not _REPO_RE.fullmatch(repository) or not isinstance(pr_number, int) or pr_number < 1: raise ProtocolError("invalid immutable task destination")
        task = _Task(task_id, base_sha, repository, pr_number)
        self.tasks[task_id] = task
        self._transition(task, "READY", "admitted")
        return deepcopy(task)

    def register_identity(self, manifest: IdentityManifest, receipt: IdentityReceipt) -> None:
        if not isinstance(manifest, IdentityManifest) or not isinstance(receipt, IdentityReceipt):
            raise AuthorizationError("manifest and receipt required")
        if manifest.principal_id in self.identities: raise ConflictError("principal identity already registered")
        self.identities[manifest.principal_id] = (manifest, receipt)

    def operation_sha256(self, task_id: str, role: str) -> str:
        task = self._live(task_id)
        attempt = task.attempt + 1 if role == "BUILDER" else task.attempt
        raw = json.dumps({"task_id": task.id, "role": role, "attempt": attempt, "epoch": self.epoch}, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(raw).hexdigest()

    def task(self, task_id: str) -> _Task:
        try: return deepcopy(self.tasks[task_id])
        except KeyError as e: raise ProtocolError("unknown task") from e

    def _live(self, task_id: str) -> _Task:
        try: return self.tasks[task_id]
        except KeyError as e: raise ProtocolError("unknown task") from e

    def _cas(self, task: _Task, expected_version: int) -> None:
        if not isinstance(expected_version, int) or task.version != expected_version: raise ConflictError("stale task version")

    def _next_token(self) -> int:
        self._token += 1; return self._token

    def _transition(self, task: _Task, state: str, reason: str) -> None:
        task.state = state; task.version += 1
        self.events.append({"type": "protocol.state", "task_id": task.id, "state": state, "reason": reason, "version": task.version})

    def _phase_event(self, task: _Task, receipt: dict) -> None:
        """Replay-friendly bounded atomic result/state evidence."""
        self.events.append({"type": "protocol.phase_result", "task_id": task.id,
                            "state": task.state, "version": task.version,
                            "receipt": deepcopy(receipt)})

    def _resource(self, task: _Task, role: str) -> str:
        return f"task:{task.id}:{task.attempt}:{role.lower().replace('_', '-') }"

    def _atomic(self, fn):
        snapshot = (deepcopy(self.tasks), deepcopy(self.leases), deepcopy(self.receipts), deepcopy(self.events), deepcopy(self.merge_claim), self._token, deepcopy(self.consumed_binding_ids))
        try: return fn()
        except Exception:
            self.tasks, self.leases, self.receipts, self.events, self.merge_claim, self._token, self.consumed_binding_ids = snapshot
            raise

    def claim_phase(self, task_id: str, role: str, authority: AuthorityBinding, expected_version: int, ttl: float) -> LeaseGrant:
        """Claim exactly one permitted phase; principal/role reuse fails closed."""
        def op():
            if role not in ROLES or not isinstance(authority, AuthorityBinding): raise AuthorizationError("authenticated authority binding required")
            principal, domain = authority.principal_id, authority.authority_domain
            if not isinstance(ttl, (int, float)) or not 1 <= ttl <= self.max_lease_ttl: raise ProtocolError("ttl outside bounded policy")
            task = self._live(task_id); self._cas(task, expected_version)
            try:
                manifest, receipt = self.identities[principal]
                verify_authority_binding(authority, manifest, receipt, self.clock(), self.identity_hmac_key,
                                          self.operation_sha256(task_id, role), self.consumed_binding_ids)
            except (KeyError, IdentityError) as exc:
                raise AuthorizationError("authority binding is not current, authentic, or task-bound") from exc
            allowed = {
                "BUILDER": {"READY"}, "VERIFIER": {"SUBMITTED"},
                "SPEC_REVIEWER": {"VERIFIED"}, "REGRESSION_REVIEWER": {"VERIFIED"},
                "INDEPENDENT_REVIEWER": {"VERIFIED"}, "INTEGRATOR": {"REVIEWED"},
                "POST_MERGE_VERIFIER": {"MERGED"},
            }
            if task.state not in allowed[role]: raise ProtocolError("phase is not claimable in task state")
            prior = [r for r in self.receipts if r["task_id"] == task.id and r["attempt"] == task.attempt]
            used_roles = {r["role"] for r in prior}
            used_domains = {r["authority_domain"] for r in prior}
            used_accounts = {r.get("account_binding_sha256") for r in prior}
            used_receipts = {r.get("identity_receipt_sha256") for r in prior}
            matching_authority = [r for r in prior if r["authority_domain"] == domain]
            same_verifier_for_post = (role == "POST_MERGE_VERIFIER" and len(matching_authority) == 1
                                      and matching_authority[0]["role"] == "VERIFIER"
                                      and matching_authority[0]["principal_id"] == principal)
            if role in used_roles or (domain in used_domains and not same_verifier_for_post):
                raise AuthorizationError("role/authority domain already used for attempt")
            if ((authority.account_binding_sha256 in used_accounts or authority.receipt_sha256 in used_receipts)
                    and not same_verifier_for_post):
                raise AuthorizationError("account binding or identity receipt already used for attempt")
            if any(l.principal_id == principal for l in self.leases.values()): raise AuthorizationError("principal has an active lease")
            if role == "BUILDER":
                task.attempt += 1; task.subject_sha = None; task.merge_sha = None
                # previous failed-attempt receipts intentionally remain, but do not affect new attempt.
            resource = self._resource(task, role)
            if resource in self.leases: raise ConflictError("phase lease exists")
            grant = LeaseGrant(task.id, task.attempt, role, principal, str(uuid4()), domain, authority.account_binding_sha256, authority.receipt_sha256, self._next_token(), self.epoch, self.clock()+ttl, resource)
            self.leases[resource] = grant; task.active_role = role
            target = "LEASED" if role == "BUILDER" else {"VERIFIER":"VERIFYING", "INTEGRATOR":"INTEGRATING", "POST_MERGE_VERIFIER":"POST_MERGE_VERIFYING"}.get(role, "REVIEWING")
            self._transition(task, target, "phase_claimed")
            return grant
        return self._atomic(op)

    def _lease(self, grant: LeaseGrant, expected_version: int) -> _Task:
        task = self._live(grant.task_id); self._cas(task, expected_version)
        current = self.leases.get(grant.resource)
        if current != grant: raise FencedError("lease is no longer current")
        if grant.epoch != self.epoch or grant.expires_at <= self.clock(): raise FencedError("expired or stale lease")
        if task.attempt != grant.attempt or task.active_role != grant.role: raise FencedError("stale attempt or role")
        return task

    def start_build(self, grant: LeaseGrant, expected_version: int) -> _Task:
        def op():
            if grant.role != "BUILDER": raise AuthorizationError("only builder can start build")
            task = self._lease(grant, expected_version)
            if task.state != "LEASED": raise ProtocolError("build is not leased")
            self._transition(task, "RUNNING", "build_started")
            return deepcopy(task)
        return self._atomic(op)

    def _record(self, task: _Task, grant: LeaseGrant, result: PhaseResult, expected_version: int) -> dict:
        result.validate()
        if result.subject_sha != task.subject_sha and grant.role != "BUILDER": raise FencedError("result subject differs from submitted subject")
        if result.base_sha != task.base_sha: raise FencedError("result base differs from task base")
        if any(r["task_id"] == task.id and r["attempt"] == task.attempt and r["phase"] == PHASE_FOR_ROLE[grant.role] and r["role"] == grant.role for r in self.receipts): raise ConflictError("phase result already recorded")
        phase = PHASE_FOR_ROLE[grant.role]
        expected_sha = result.subject_sha if grant.role == "BUILDER" else task.subject_sha
        if grant.role == "POST_MERGE_VERIFIER": expected_sha = task.merge_sha
        if result.result_sha != expected_sha:
            raise FencedError("phase result sha is not bound to its exact subject")
        receipt = {"id": str(uuid4()), "schema_version": SCHEMA_VERSION,
                   "task_id": task.id, "attempt": task.attempt, "phase": phase, "role": grant.role,
                   "principal_id": grant.principal_id, "authority_domain": grant.authority_domain,
                   "account_binding_sha256": grant.account_binding_sha256,
                   "identity_receipt_sha256": grant.identity_receipt_sha256,
                   "verdict": result.verdict, "subject_sha": result.subject_sha, "base_sha": result.base_sha,
                   "result_sha": result.result_sha, "evidence_sha256": result.evidence_sha256, "epoch": self.epoch,
                   "lease_resource": grant.resource, "run_id": grant.run_id,
                   "expected_version": expected_version, "authoritative_version": task.version,
                   "worker_lease_token": grant.token, "merge_fence_token": self.merge_claim.token if self.merge_claim else None}
        self.receipts.append(receipt)
        del self.leases[grant.resource]; task.active_role = None
        return receipt

    def _system_receipt(self, task: _Task, phase: str, evidence: GitHubEvidence, *, result_sha: str, role: str = "CONTROLLER", principal_id: str = "controller", authority_domain: str = "controller", expected_version: Optional[int] = None, parent_operation_id: Optional[str] = None, extras: Optional[dict] = None) -> dict:
        """Record controller-validated remote evidence, never worker testimony."""
        _git_sha(result_sha, "result_sha")
        if any(r["task_id"] == task.id and r["attempt"] == task.attempt and r["phase"] == phase for r in self.receipts):
            raise ConflictError("system phase receipt already recorded")
        receipt = {
            "id": str(uuid4()), "task_id": task.id, "attempt": task.attempt,
            "schema_version": SCHEMA_VERSION, "phase": phase, "role": role, "principal_id": principal_id, "authority_domain": authority_domain,
            "verdict": "PASS", "subject_sha": evidence.head_sha,
            "base_sha": evidence.base_sha, "result_sha": result_sha,
            "evidence_sha256": evidence.evidence_sha256, "epoch": self.epoch,
            "lease_resource": None, "run_id": None, "expected_version": task.version if expected_version is None else expected_version,
            "authoritative_version": task.version, "worker_lease_token": None,
            "merge_fence_token": self.merge_claim.token if self.merge_claim else None,
            "operation_id": self.merge_claim.operation_id if self.merge_claim else None,
            "parent_operation_id": parent_operation_id,
        }
        if extras: receipt.update(extras)
        self.receipts.append(receipt)
        return receipt

    def _bridge_receipt(self, task: _Task, phase: str, evidence: MergeAdmissionReceipt | MergeStateReceipt, *, result_sha: str, **kwargs) -> dict:
        """Record only the digest of an already authenticated bridge receipt."""
        merged = isinstance(evidence, MergeStateReceipt) and evidence.merged
        legacy = GitHubEvidence(task.repository, task.pr_number, evidence.head_sha, evidence.base_sha,
                                evidence.main_sha if isinstance(evidence, MergeStateReceipt) else task.base_sha,
                                merged, evidence.merge_sha if isinstance(evidence, MergeStateReceipt) else None,
                                evidence.sha256)
        return self._system_receipt(task, phase, legacy, result_sha=result_sha, **kwargs)

    def _required_receipts(self, task: _Task) -> bool:
        records = [r for r in self.receipts if r["task_id"] == task.id and r["attempt"] == task.attempt and r["verdict"] == "PASS"]
        by_key = {(r["phase"], r["role"]): r for r in records}
        required = {("SUBMISSION", "BUILDER"), ("VERIFICATION", "VERIFIER"),
                    ("REVIEW", "SPEC_REVIEWER"), ("REVIEW", "REGRESSION_REVIEWER"),
                    ("REVIEW", "INDEPENDENT_REVIEWER"), ("PRE_MERGE", "INTEGRATOR"),
                    ("MERGE", "INTEGRATOR"), ("POST_MERGE_VERIFICATION", "POST_MERGE_VERIFIER")}
        if not required <= set(by_key) or len(records) != len(by_key): return False
        if any(r["base_sha"] != task.base_sha or r["subject_sha"] != task.subject_sha for r in by_key.values()): return False
        expected_results = {
            ("SUBMISSION", "BUILDER"): task.subject_sha,
            ("VERIFICATION", "VERIFIER"): task.subject_sha,
            ("REVIEW", "SPEC_REVIEWER"): task.subject_sha,
            ("REVIEW", "REGRESSION_REVIEWER"): task.subject_sha,
            ("REVIEW", "INDEPENDENT_REVIEWER"): task.subject_sha,
            ("PRE_MERGE", "INTEGRATOR"): task.base_sha,
            ("MERGE", "INTEGRATOR"): task.merge_sha,
            ("POST_MERGE_VERIFICATION", "POST_MERGE_VERIFIER"): task.merge_sha,
        }
        if any(by_key[key]["result_sha"] != expected for key, expected in expected_results.items()): return False
        authority_keys = [("SUBMISSION", "BUILDER"), ("VERIFICATION", "VERIFIER"),
                          ("REVIEW", "SPEC_REVIEWER"), ("REVIEW", "REGRESSION_REVIEWER"),
                          ("REVIEW", "INDEPENDENT_REVIEWER"), ("PRE_MERGE", "INTEGRATOR")]
        if len({by_key[key]["authority_domain"] for key in authority_keys}) != 6: return False
        if by_key[("PRE_MERGE", "INTEGRATOR")]["principal_id"] != by_key[("MERGE", "INTEGRATOR")]["principal_id"]: return False
        claim = self.merge_claim
        if claim is None or by_key[("PRE_MERGE", "INTEGRATOR")].get("operation_id") != claim.operation_id or by_key[("MERGE", "INTEGRATOR")].get("operation_id") != claim.operation_id: return False
        return True

    def _parent_merge_chain_valid(self, task: _Task) -> bool:
        """A remediation may inherit only a complete, originally merged chain."""
        required = {("SUBMISSION", "BUILDER"), ("VERIFICATION", "VERIFIER"),
                    ("REVIEW", "SPEC_REVIEWER"), ("REVIEW", "REGRESSION_REVIEWER"),
                    ("REVIEW", "INDEPENDENT_REVIEWER"), ("PRE_MERGE", "INTEGRATOR"),
                    ("MERGE", "INTEGRATOR")}
        records = [r for r in self.receipts if r["task_id"] == task.id and r["attempt"] == task.attempt and r["verdict"] == "PASS"]
        by_key = {(r["phase"], r["role"]): r for r in records}
        if not required <= set(by_key) or task.subject_sha is None or task.merge_sha is None:
            return False
        if any(by_key[key]["base_sha"] != task.base_sha or by_key[key]["subject_sha"] != task.subject_sha for key in required):
            return False
        if by_key[("MERGE", "INTEGRATOR")]["result_sha"] != task.merge_sha:
            return False
        authorities = [("SUBMISSION", "BUILDER"), ("VERIFICATION", "VERIFIER"),
                       ("REVIEW", "SPEC_REVIEWER"), ("REVIEW", "REGRESSION_REVIEWER"),
                       ("REVIEW", "INDEPENDENT_REVIEWER"), ("PRE_MERGE", "INTEGRATOR")]
        return len({by_key[key]["authority_domain"] for key in authorities}) == 6

    def commit_phase(self, grant: LeaseGrant, expected_version: int, result: PhaseResult) -> _Task:
        def op():
            task = self._lease(grant, expected_version)
            if result.verdict != "PASS": raise ProtocolError("PASS required; use reject_phase")
            if grant.role == "INTEGRATOR":
                raise ProtocolError("integration completes only through authorize_merge")
            expected_states = {"BUILDER":{"RUNNING"}, "VERIFIER":{"VERIFYING"}, "SPEC_REVIEWER":{"REVIEWING"}, "REGRESSION_REVIEWER":{"REVIEWING"}, "INDEPENDENT_REVIEWER":{"REVIEWING"}, "POST_MERGE_VERIFIER":{"POST_MERGE_VERIFYING"}}
            if task.state not in expected_states[grant.role]: raise ProtocolError("result is not admissible in task state")
            if grant.role == "BUILDER": task.subject_sha = result.subject_sha
            receipt = self._record(task, grant, result, expected_version)
            if grant.role == "BUILDER": next_state = "SUBMITTED"
            elif grant.role == "VERIFIER": next_state = "VERIFIED"
            elif grant.role in REVIEW_ROLES:
                done = {r["role"] for r in self.receipts if r["task_id"] == task.id and r["attempt"] == task.attempt and r["phase"] == "REVIEW"}
                next_state = "REVIEWED" if set(REVIEW_ROLES) <= done else "VERIFIED"
            else: next_state = "POST_MERGE_VERIFIED"
            self._transition(task, next_state, "phase_passed")
            self._phase_event(task, receipt)
            return deepcopy(task)
        return self._atomic(op)

    def reject_phase(self, grant: LeaseGrant, expected_version: int, result: PhaseResult) -> _Task:
        def op():
            task = self._lease(grant, expected_version)
            if result.verdict != "FAIL": raise ProtocolError("FAIL required")
            receipt = self._record(task, grant, result, expected_version)
            target = "POST_MERGE_FAILED" if grant.role == "POST_MERGE_VERIFIER" else "CHANGES_REQUESTED"
            self._transition(task, target, "phase_failed")
            self._phase_event(task, receipt)
            return deepcopy(task)
        return self._atomic(op)

    def authorize_merge(self, grant: LeaseGrant, expected_version: int, evidence: MergeAdmissionReceipt) -> MergeGrant:
        def op():
            if grant.role != "INTEGRATOR": raise AuthorizationError("only integrator may authorize merge")
            task = self._lease(grant, expected_version)
            if task.state != "INTEGRATING" or task.subject_sha is None: raise ProtocolError("task is not integrating")
            try: evidence.verify(self.bridge_receipt_keys, now=int(self.clock()), repository=task.repository, pr_number=task.pr_number, head_sha=task.subject_sha, base_sha=task.base_sha)
            except BridgeError as exc: raise FencedError("verified merge admission is required") from exc
            if self.merge_claim is None:
                claim = _MergeClaim(task.id, task.attempt, task.subject_sha, task.base_sha, task.pr_number, self._next_token(), self.epoch, str(uuid4()), integrator_principal=grant.principal_id, integrator_authority_domain=grant.authority_domain)
                self.merge_claim = claim
            elif self.merge_claim.task_id == task.id and self.merge_claim.linked_task_id == task.id and self.merge_claim.status == "HELD":
                # A repair/revert owns the inherited fence but must still mint a
                # distinct one-shot operation.  The immutable parent id remains
                # linked for terminal remediation proof.
                claim = self.merge_claim
                claim.parent_operation_id = claim.operation_id
                claim.attempt, claim.subject_sha, claim.base_sha = task.attempt, task.subject_sha, task.base_sha
                claim.pr_number, claim.operation_id, claim.generation = task.pr_number, str(uuid4()), 1
                claim.integrator_principal = grant.principal_id
                claim.integrator_authority_domain = grant.authority_domain
            else: raise ConflictError("global merge fence held")
            # One transaction: consume the integrator lease, record PRE_MERGE,
            # then expose a grant only after the state and global fence agree.
            receipt = self._bridge_receipt(task, "PRE_MERGE", evidence, result_sha=task.base_sha,
                                           role="INTEGRATOR", principal_id=grant.principal_id,
                                           authority_domain=grant.authority_domain, expected_version=expected_version)
            del self.leases[grant.resource]; task.active_role = None
            self._transition(task, "MERGE_AUTHORIZED", "merge_authorized")
            self._phase_event(task, receipt)
            return MergeGrant(task.id, task.attempt, task.subject_sha, task.base_sha, task.pr_number, claim.operation_id, claim.generation, claim.token, self.epoch)
        return self._atomic(op)

    def confirm_merge(self, grant: MergeGrant, expected_version: int, evidence: MergeStateReceipt) -> _Task:
        def op():
            claim = self.merge_claim
            if claim is None or (claim.operation_id, claim.generation, claim.token, claim.epoch) != (grant.operation_id, grant.generation, grant.fence_token, grant.epoch): raise FencedError("merge grant is stale")
            task = self._live(grant.task_id); self._cas(task, expected_version)
            try: evidence.verify(self.bridge_receipt_keys, now=int(self.clock()), repository=task.repository, pr_number=claim.pr_number, head_sha=claim.subject_sha, base_sha=claim.base_sha, operation_id=claim.operation_id)
            except BridgeError as exc: raise FencedError("verified exact merge state required") from exc
            if not evidence.merged: raise FencedError("merge not proven")
            if task.state != "MERGE_AUTHORIZED": raise ProtocolError("merge confirmation requires authorization state")
            task.merge_sha = evidence.merge_sha; claim.status = "MERGED"
            receipt = self._bridge_receipt(task, "MERGE", evidence, result_sha=evidence.merge_sha,
                                           role="INTEGRATOR", principal_id=claim.integrator_principal or "",
                                           authority_domain=claim.integrator_authority_domain or "", expected_version=expected_version,
                                           parent_operation_id=claim.parent_operation_id)
            self._transition(task, "MERGED", "merge_confirmed")
            self._phase_event(task, receipt)
            return deepcopy(task)
        return self._atomic(op)

    def finalize_task(self, task_id: str, expected_version: int, evidence: MergeStateReceipt) -> _Task:
        def op():
            task = self._live(task_id); self._cas(task, expected_version)
            if task.state != "POST_MERGE_VERIFIED" or task.remediation_parent is not None: raise ProtocolError("task cannot be ordinarily finalized")
            if self.merge_claim is None or self.merge_claim.task_id != task.id or self.merge_claim.status != "MERGED": raise FencedError("task lacks confirmed global merge claim")
            self._verify_merge_state(task, self.merge_claim, evidence, merged=True)
            if task.merge_sha != evidence.main_sha or not self._required_receipts(task): raise FencedError("main evidence or complete receipt chain missing")
            receipt = self._bridge_receipt(task, "FINAL", evidence, result_sha=evidence.main_sha, expected_version=expected_version)
            self.merge_claim = None; self._transition(task, "DONE", "finalized")
            self._phase_event(task, receipt)
            return deepcopy(task)
        return self._atomic(op)

    def transfer_remediation(self, parent_id: str, child_id: str, kind: str, expected_version: int) -> tuple[_Task, _Task]:
        def op():
            if kind not in {"REPAIR", "REVERT"}: raise ProtocolError("invalid remediation kind")
            parent = self._live(parent_id); child = self._live(child_id); self._cas(parent, expected_version)
            claim = self.merge_claim
            if parent.state != "POST_MERGE_FAILED" or claim is None or claim.task_id != parent_id or claim.status != "MERGED" or not self._parent_merge_chain_valid(parent): raise FencedError("parent cannot transfer merge claim")
            if child.state != "READY" or child.remediation_parent is not None: raise ProtocolError("child is not a fresh remedy task")
            child.remediation_parent = parent_id; child.remediation_kind = kind; parent.recovery_from = child_id
            claim.linked_task_id = child_id; claim.task_id = child_id; claim.status = "HELD"
            self._transition(parent, "REMEDIATING", "merge_claim_transferred")
            return deepcopy(parent), deepcopy(child)
        return self._atomic(op)

    def request_changes(self, task_id: str, expected_version: int) -> _Task:
        """Controller-only retry gate; failed evidence stays immutable."""
        def op():
            task = self._live(task_id); self._cas(task, expected_version)
            if task.state != "CHANGES_REQUESTED" or task.active_role is not None:
                raise ProtocolError("task is not safely retryable")
            self._transition(task, "READY", "controller_retry")
            return deepcopy(task)
        return self._atomic(op)

    retry_task = request_changes

    def recover_task(self, task_id: str, expected_version: int) -> _Task:
        """Fail closed after a scheduler restart by retiring any live lease."""
        def op():
            task = self._live(task_id); self._cas(task, expected_version)
            if task.state in {"DONE", "MERGED", "MERGE_AUTHORIZED", "POST_MERGE_VERIFIED", "POST_MERGE_VERIFYING", "POST_MERGE_FAILED", "REMEDIATING", "MERGE_RECONCILIATION_REQUIRED"}:
                raise ProtocolError("state requires explicit merge/remediation recovery")
            for resource, lease in list(self.leases.items()):
                if lease.task_id == task.id: del self.leases[resource]
            prior = task.state; task.active_role = None; task.recovery_from = prior
            self._transition(task, "SUBMITTED" if prior == "VERIFYING" else "VERIFIED" if prior == "REVIEWING" else "READY", "controller_recovery")
            return deepcopy(task)
        return self._atomic(op)

    def require_merge_reconciliation(self, task_id: str, expected_version: int) -> _Task:
        """Fence a crash around merge; this path never reopens a build attempt."""
        def op():
            task = self._live(task_id); self._cas(task, expected_version)
            claim = self.merge_claim
            if task.state not in {"MERGE_AUTHORIZED", "MERGED", "POST_MERGE_VERIFIED"} or claim is None or claim.task_id != task.id:
                raise ProtocolError("task has no merge operation requiring reconciliation")
            task.active_role = None; task.recovery_from = task.state; claim.status = "RECONCILIATION_REQUIRED"
            self._transition(task, "MERGE_RECONCILIATION_REQUIRED", "merge_manual_reconciliation_required")
            return deepcopy(task)
        return self._atomic(op)

    def _verify_merge_state(self, task: _Task, claim: _MergeClaim, evidence: MergeStateReceipt, *, merged: bool) -> None:
        try: evidence.verify(self.bridge_receipt_keys, now=int(self.clock()), repository=task.repository, pr_number=claim.pr_number, head_sha=claim.subject_sha, base_sha=claim.base_sha, operation_id=claim.operation_id)
        except BridgeError as exc: raise FencedError("verified exact merge-state receipt required") from exc
        if evidence.merged is not merged: raise FencedError("merge-state outcome differs from required reconciliation")

    def reconcile_confirmed_merge(self, task_id: str, expected_version: int, evidence: MergeStateReceipt) -> _Task:
        """Manual reconciliation admits only exact merged evidence and never reissues merge."""
        def op():
            task = self._live(task_id); self._cas(task, expected_version)
            claim = self.merge_claim
            if task.state != "MERGE_RECONCILIATION_REQUIRED" or claim is None or claim.task_id != task.id:
                raise ProtocolError("task is not awaiting merge reconciliation")
            self._verify_merge_state(task, claim, evidence, merged=True)
            task.merge_sha = evidence.merge_sha; claim.status = "MERGED"
            receipt = self._bridge_receipt(task, "MERGE_RECONCILED", evidence, result_sha=evidence.merge_sha,
                                           role="INTEGRATOR", principal_id=claim.integrator_principal or "",
                                           authority_domain=claim.integrator_authority_domain or "", expected_version=expected_version,
                                           parent_operation_id=claim.parent_operation_id)
            self._transition(task, "MERGED", "merge_manually_reconciled")
            self._phase_event(task, receipt)
            return deepcopy(task)
        return self._atomic(op)

    def reconcile_proven_unmerged(self, task_id: str, expected_version: int, evidence: MergeStateReceipt) -> _Task:
        def op():
            task = self._live(task_id); self._cas(task, expected_version); claim = self.merge_claim
            if task.state != "MERGE_RECONCILIATION_REQUIRED" or claim is None or claim.task_id != task.id: raise ProtocolError("task is not awaiting merge reconciliation")
            self._verify_merge_state(task, claim, evidence, merged=False)
            receipt = self._bridge_receipt(task, "MERGE_UNMERGED_RECONCILED", evidence, result_sha=task.base_sha,
                                           role="INTEGRATOR", principal_id=claim.integrator_principal or "", authority_domain=claim.integrator_authority_domain or "", expected_version=expected_version)
            self.merge_claim = None; self._transition(task, "CHANGES_REQUESTED", "merge_proven_unmerged"); self._phase_event(task, receipt)
            return deepcopy(task)
        return self._atomic(op)

    def rollback_failed_remediation_child(self, parent_id: str, child_id: str, expected_version: int, *, child_expected_version: int) -> tuple[_Task, _Task]:
        """Atomically return an unmerged failed remedy to the failed parent chain."""
        def op():
            parent = self._live(parent_id); child = self._live(child_id)
            self._cas(parent, expected_version); self._cas(child, child_expected_version)
            claim = self.merge_claim
            if parent.state != "REMEDIATING" or child.remediation_parent != parent_id or child.state != "CHANGES_REQUESTED":
                raise ProtocolError("remediation child is not safely rollbackable")
            if claim is None or claim.task_id != child_id or claim.linked_task_id != child_id or claim.status != "HELD":
                raise FencedError("remediation merge fence is no longer safely rollbackable")
            if any(r["task_id"] == child_id and r["attempt"] == child.attempt and r["phase"] in {"PRE_MERGE", "MERGE"} for r in self.receipts):
                raise FencedError("merged or authorized remediation cannot be rolled back")
            claim.task_id = parent_id; claim.linked_task_id = None; claim.status = "MERGED"
            self._transition(child, "REMEDIATION_FAILED", "remediation_child_failed")
            parent.recovery_from = child_id
            self._transition(parent, "POST_MERGE_FAILED", "remediation_child_rolled_back")
            return deepcopy(parent), deepcopy(child)
        return self._atomic(op)

    def finalize_remediation(self, parent_id: str, child_id: str, expected_version: int, evidence: MergeStateReceipt, *, child_expected_version: int) -> tuple[_Task, _Task]:
        def op():
            parent = self._live(parent_id); child = self._live(child_id); self._cas(parent, expected_version); self._cas(child, child_expected_version)
            claim = self.merge_claim
            if parent.state != "REMEDIATING" or child.state != "POST_MERGE_VERIFIED" or child.remediation_parent != parent_id: raise ProtocolError("remediation chain incomplete")
            if claim is None or claim.task_id != child_id or claim.linked_task_id != child_id or claim.status != "MERGED": raise FencedError("transferred merge claim not confirmed")
            self._verify_merge_state(child, claim, evidence, merged=True)
            if child.merge_sha != evidence.main_sha or not self._required_receipts(child): raise FencedError("remediation main evidence or receipt chain mismatch")
            receipt = self._bridge_receipt(
                parent, "REMEDIATION" if child.remediation_kind == "REPAIR" else "REVERT",
                evidence, result_sha=evidence.main_sha, expected_version=expected_version, parent_operation_id=claim.parent_operation_id,
                extras={"linked_task_id": child.id, "child_operation_id": claim.operation_id,
                        "failed_original_merge_sha": parent.merge_sha, "remedy_sha": child.merge_sha},
            )
            self._transition(child, "DONE", "remediation_finalized")
            self._transition(parent, "REMEDIATED" if child.remediation_kind == "REPAIR" else "REVERTED", "remediation_finalized")
            self.merge_claim = None
            self._phase_event(parent, receipt)
            return deepcopy(parent), deepcopy(child)
        return self._atomic(op)
